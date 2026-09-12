import type { ConversationQuery } from "@yep-anywhere/shared/experimental/simple-client.generated";
/**
 * Secure connection for remote access using SRP authentication and NaCl encryption.
 *
 * This implements the Connection interface but routes all traffic through
 * an encrypted WebSocket channel. Uses:
 * - SRP-6a for zero-knowledge password authentication
 * - NaCl secretbox (XSalsa20-Poly1305) for message encryption
 *
 * Protocol logic (request correlation, subscriptions, uploads) is delegated
 * to RelayProtocol. This class owns transport (encrypt/decrypt) and SRP auth.
 */
import type {
  ClientCapabilities,
  DeviceServerMessage,
  GitWorktreeCoverage,
  OriginMetadata,
  RemoteClientMessage,
  RelayChannel,
  RelaySpeechEvent,
  SrpClientHello,
  SrpClientProof,
  SrpSessionResume,
  SrpSessionResumeInit,
  StagedAttachmentRef,
  UploadedFile,
  YepMessage,
} from "@yep-anywhere/shared";
import {
  BinaryFormat,
  DEFAULT_RELAY_CHANNEL,
  SPEECH_RELAY_CHANNEL,
  TransportChunkError,
  TransportChunkReassembler,
  encodeUploadChunkPayload,
  isBinaryData,
  isCompressionSupported,
  isSequencedEncryptedPayload,
  isSrpError,
  isSrpServerChallenge,
  isSrpServerVerify,
  isSrpSessionInvalid,
  isSrpSessionResumeChallenge,
  isSrpSessionResumed,
} from "@yep-anywhere/shared";
import { getRelayDebugEnabled } from "../../hooks/useDeveloperMode";
import { getClientVersion } from "../clientVersion";
import { getOrCreateBrowserProfileId } from "../storageKeys";
import type { ConnectionManager } from "./ConnectionManager";
import {
  openRelayClientSocket,
  type OpenRelayClientSocketOptions,
} from "./RelayClientSocket";
import { RelayProtocol } from "./RelayProtocol";
import type { SecureConnectionSocket } from "./SecureConnectionSocket";
import {
  decrypt,
  decryptBinaryEnvelopeWithDecompression,
  deriveSecretboxKey,
  deriveTransportKey,
  encrypt,
  encryptBytesToBinaryEnvelope,
  encryptToBinaryEnvelope,
  generateNonce,
} from "./nacl-wrapper";
import { SrpClientSession } from "./srp-client";
import {
  type Connection,
  type ConnectionSpeechSocket,
  RelayReconnectRequiredError,
  type SessionSubscriptionOptions,
  type StreamHandlers,
  type Subscription,
  type UploadOptions,
  WebSocketCloseError,
} from "./types";

/** Connection authentication state */
type ConnectionState =
  | "disconnected"
  | "connecting"
  | "srp_resume_init_sent"
  | "srp_resume_proof_sent"
  | "srp_hello_sent"
  | "srp_proof_sent"
  | "authenticated"
  | "failed";

/** Timeout waiting for resume challenge/proof responses before rejecting resume. */
const RESUME_PHASE_TIMEOUT_MS = 5000;
const RESUME_INCOMPATIBLE_ERROR =
  "resume_incompatible: session resume unsupported by server";
const GRACE_FULL_SRP_PROTOCOL_VERSION = 2;
const CURRENT_RESUME_PROTOCOL_VERSION = 3;
const UPLOAD_BUFFER_HIGH_WATER_BYTES = 512 * 1024;
const UPLOAD_BUFFER_LOW_WATER_BYTES = 256 * 1024;
const UPLOAD_BUFFER_POLL_MS = 16;
// WebSocket readyState constants are spec-defined. Using local constants keeps
// node-environment unit tests independent of host WebSocket globals.
const WEBSOCKET_OPEN_STATE = 1;
const WEBSOCKET_CLOSED_STATE = 3;

/** Stored session for resumption (persisted to localStorage) */
export interface StoredSession {
  wsUrl: string;
  username: string;
  sessionId: string;
  /** Base64-encoded session key (32 bytes) */
  sessionKey: string;
  /**
   * Highest authenticated resume protocol version observed for this session.
   * Future resumes must prove at least this version.
   */
  resumeProtocolVersion?: number;
}

export type RelaySocketFactory = (
  options: OpenRelayClientSocketOptions,
) => Promise<SecureConnectionSocket>;

export interface RelayConnectionConfig {
  relayUrl: string;
  relayUsername: string;
  channel?: RelayChannel;
  openSocket?: RelaySocketFactory;
}

export interface SecureConnectionCallbacks {
  /** Session established (for storing session data). */
  onSessionEstablished?: (session: StoredSession) => void;
  /** Connection lost (for UI state updates). */
  onDisconnect?: (error: Error) => void;
  /** SRP authentication or resumption succeeded. */
  onAuthenticated?: () => void;
}

function uint8ToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toUint8ArrayView(
  data: ArrayBuffer | Uint8Array | ArrayBufferView,
): Uint8Array {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

/**
 * Secure connection to yepanywhere server using SRP + NaCl encryption.
 *
 * All traffic is authenticated and encrypted. The connection is established
 * in three phases:
 * 1. WebSocket connection
 * 2. SRP authentication handshake
 * 3. Encrypted message exchange
 */
export class SecureConnection implements Connection {
  readonly mode = "secure" as const;

  private ws: SecureConnectionSocket | null = null;
  private srpSession: SrpClientSession | null = null;
  private sessionKey: Uint8Array | null = null;
  private sessionId: string | null = null;
  private connectionState: ConnectionState = "disconnected";
  private connectionPromise: Promise<void> | null = null;
  private forceReconnectPromise: Promise<void> | null = null;
  private protocol: RelayProtocol;
  private nextOutboundSeq = 0;
  private lastInboundSeq: number | null = null;
  private readonly inboundChunks = new TransportChunkReassembler();
  private pendingResumeClientNonce: string | null = null;
  private pendingResumeServerNonce: string | null = null;
  private minimumResumeProtocolVersion: number | null = null;
  private connectionManager: ConnectionManager | null = null;
  private externalOnPong: ((id: string) => void) | undefined;

  // Credentials for authentication
  private username: string;
  private password: string | null;
  private wsUrl: string;

  // Flag indicating this connection was established via relay
  private isRelayConnection = false;

  // Relay connection details for auto-reconnect (only set for relay connections)
  private relayUrl: string | null = null;
  private relayUsername: string | null = null;
  private relayChannel: RelayChannel = DEFAULT_RELAY_CHANNEL;
  private relaySocketFactory: RelaySocketFactory | null = null;

  // Stored session for resumption (optional)
  private storedSession: StoredSession | null = null;

  // Callback when session is established (for storing session data)
  private onSessionEstablished?: (session: StoredSession) => void;

  // Callback when connection is lost (for UI state updates)
  private onDisconnect?: (error: Error) => void;

  // Callback when SRP authentication or resumption succeeds
  private onAuthenticated?: () => void;

  /**
   * Create a new secure connection with password authentication.
   */
  constructor(
    wsUrl: string,
    username: string,
    password: string,
    callbacks: SecureConnectionCallbacks = {},
  ) {
    this.wsUrl = wsUrl;
    this.username = username;
    this.password = password;
    this.onSessionEstablished = callbacks.onSessionEstablished;
    this.onDisconnect = callbacks.onDisconnect;
    this.onAuthenticated = callbacks.onAuthenticated;

    this.protocol = new RelayProtocol(
      {
        sendMessage: (msg) => this.send(msg),
        sendUploadChunk: async (id, offset, chunk) => {
          const payload = encodeUploadChunkPayload(id, offset, chunk);
          if (!this.ws || this.ws.readyState !== WEBSOCKET_OPEN_STATE) {
            throw new Error("WebSocket not connected");
          }
          if (!this.sessionKey) {
            throw new Error("Not authenticated");
          }
          const envelope = encryptBytesToBinaryEnvelope(
            payload,
            BinaryFormat.BINARY_UPLOAD,
            this.sessionKey,
          );
          this.ws.send(envelope);
          await this.waitForUploadBackpressure();
        },
        ensureConnected: () => this.ensureConnected(),
        isConnected: () =>
          this.connectionState === "authenticated" &&
          this.ws?.readyState === WEBSOCKET_OPEN_STATE,
      },
      {
        debugEnabled: () => getRelayDebugEnabled(),
        logPrefix: "[SecureConnection]",
      },
    );
  }

  setConnectionManager(manager: ConnectionManager | null): void {
    this.connectionManager = manager;
    this.updateProtocolPongHandler();
    this.protocol.setOnInboundEvent(
      manager
        ? (event) => {
            if (event.eventType === "heartbeat") {
              manager.recordHeartbeat();
            } else {
              manager.recordEvent();
            }
          }
        : undefined,
    );
    this.protocol.setBeginCriticalOperation(
      manager ? (label) => manager.beginCriticalOperation(label) : undefined,
    );
  }

  /**
   * Create a secure connection from a stored session.
   * Will attempt to resume the session, falling back to full SRP if the session is invalid.
   */
  static fromStoredSession(
    storedSession: StoredSession,
    password: string,
    callbacks: SecureConnectionCallbacks = {},
  ): SecureConnection {
    const conn = new SecureConnection(
      storedSession.wsUrl,
      storedSession.username,
      password,
      callbacks,
    );
    conn.storedSession = storedSession;
    conn.minimumResumeProtocolVersion =
      storedSession.resumeProtocolVersion ?? null;
    return conn;
  }

  /**
   * Create a secure connection for resume-only mode (no password fallback).
   * Will attempt to resume the session and fail if the session is invalid.
   * Use this for automatic reconnection on page load.
   */
  static forResumeOnly(
    storedSession: StoredSession,
    callbacks: SecureConnectionCallbacks = {},
  ): SecureConnection {
    const conn = new SecureConnection(
      storedSession.wsUrl,
      storedSession.username,
      "", // No password - resume only
      callbacks,
    );
    conn.storedSession = storedSession;
    conn.password = null; // Mark as resume-only
    conn.minimumResumeProtocolVersion =
      storedSession.resumeProtocolVersion ?? null;
    return conn;
  }

  /**
   * Create a secure connection for resume-only mode using an existing WebSocket.
   * Used for relay connections where we need to reconnect through the relay first,
   * then resume the SRP session on the paired socket.
   */
  static async forResumeOnlyWithSocket(
    ws: SecureConnectionSocket,
    storedSession: StoredSession,
    callbacks: SecureConnectionCallbacks = {},
    relayConfig?: RelayConnectionConfig,
  ): Promise<SecureConnection> {
    const conn = new SecureConnection(
      "", // No URL needed - socket already connected
      storedSession.username,
      "", // No password - resume only
      callbacks,
    );
    conn.ws = ws;
    conn.storedSession = storedSession;
    conn.password = null; // Mark as resume-only
    conn.minimumResumeProtocolVersion =
      storedSession.resumeProtocolVersion ?? null;
    conn.isRelayConnection = true;
    if (relayConfig) {
      conn.relayUrl = relayConfig.relayUrl;
      conn.relayUsername = relayConfig.relayUsername;
      conn.relayChannel = relayConfig.channel ?? DEFAULT_RELAY_CHANNEL;
      conn.relaySocketFactory = relayConfig.openSocket ?? null;
    }

    // Resume the session on the existing socket
    await conn.resumeOnExistingSocket();
    return conn;
  }

  /**
   * Perform session resume on an already-connected WebSocket.
   * Used by forResumeOnlyWithSocket for relay connections.
   */
  private resumeOnExistingSocket(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WEBSOCKET_OPEN_STATE) {
        reject(new Error("WebSocket is not open"));
        return;
      }

      if (!this.storedSession) {
        reject(new Error("No stored session for resume"));
        return;
      }

      if (!this.storedSessionSupportsCurrentResume()) {
        this.connectionState = "failed";
        reject(new Error(RESUME_INCOMPATIBLE_ERROR));
        this.ws.close();
        return;
      }

      console.log("[SecureConnection] Resuming session on existing socket");
      this.connectionState = "connecting";

      let authResolveHandler: () => void = () => {};
      let authRejectHandler: (err: Error) => void = () => {};

      const authPromise = new Promise<void>((res, rej) => {
        authResolveHandler = res;
        authRejectHandler = rej;
      });

      const ws = this.ws;

      ws.onerror = (event) => {
        console.error("[SecureConnection] Error:", event);
      };

      ws.onclose = (event) => {
        this.handleSocketClose(event, authRejectHandler);
      };

      ws.onmessage = (event) => {
        armResumeTimeout();
        this.handleSrpResumeResponse(
          event.data,
          authResolveHandler,
          authRejectHandler,
        );
      };

      let resumeTimeout: ReturnType<typeof setTimeout> | null = null;
      const armResumeTimeout = () => {
        if (resumeTimeout) {
          clearTimeout(resumeTimeout);
        }
        resumeTimeout = setTimeout(() => {
          if (
            this.connectionState !== "srp_resume_init_sent" &&
            this.connectionState !== "srp_resume_proof_sent"
          ) {
            return;
          }
          this.connectionState = "failed";
          authRejectHandler(new Error(RESUME_INCOMPATIBLE_ERROR));
          ws.close();
        }, RESUME_PHASE_TIMEOUT_MS);
      };

      // Start resume handshake by requesting a nonce challenge.
      const resumeInit: SrpSessionResumeInit = {
        type: "srp_resume_init",
        identity: this.username,
        sessionId: this.storedSession.sessionId,
        clientNonce: this.startResumeAttempt(),
      };
      ws.send(JSON.stringify(resumeInit));
      this.connectionState = "srp_resume_init_sent";
      console.log("[SecureConnection] SRP resume init sent");
      armResumeTimeout();

      authPromise
        .then(() => {
          if (resumeTimeout) clearTimeout(resumeTimeout);
          resolve();
        })
        .catch((err) => {
          if (resumeTimeout) clearTimeout(resumeTimeout);
          reject(err);
        });
    });
  }

  /**
   * Generate a resume proof bound to the server-issued challenge.
   */
  private generateResumeProof(
    base64SessionKey: string,
    challenge: string,
    sessionId: string,
  ): string {
    const sessionKeyBytes = Uint8Array.from(atob(base64SessionKey), (c) =>
      c.charCodeAt(0),
    );
    const timestamp = Date.now();
    const proofData = JSON.stringify({ timestamp, challenge, sessionId });
    const { nonce, ciphertext } = encrypt(proofData, sessionKeyBytes);
    return JSON.stringify({ nonce, ciphertext });
  }

  private startResumeAttempt(): string {
    this.pendingResumeClientNonce = uint8ToBase64(generateNonce());
    this.pendingResumeServerNonce = null;
    return this.pendingResumeClientNonce;
  }

  private storedSessionSupportsCurrentResume(): boolean {
    const resumeProtocolVersion = this.storedSession?.resumeProtocolVersion;
    return (
      resumeProtocolVersion === undefined ||
      resumeProtocolVersion >= GRACE_FULL_SRP_PROTOCOL_VERSION
    );
  }

  private decryptProofEnvelope(proof: string, key: Uint8Array): string | null {
    try {
      const proofEnvelope = JSON.parse(proof) as {
        nonce?: unknown;
        ciphertext?: unknown;
      };
      if (
        typeof proofEnvelope.nonce !== "string" ||
        typeof proofEnvelope.ciphertext !== "string"
      ) {
        return null;
      }
      return decrypt(proofEnvelope.nonce, proofEnvelope.ciphertext, key);
    } catch {
      return null;
    }
  }

  private acceptAuthenticatedResumeProtocolVersion(
    resumeProtocolVersion: number,
    minimumProtocolVersion = CURRENT_RESUME_PROTOCOL_VERSION,
  ): boolean {
    if (
      !Number.isSafeInteger(resumeProtocolVersion) ||
      resumeProtocolVersion < minimumProtocolVersion
    ) {
      return false;
    }
    const pinnedResumeProtocolVersion = Math.max(
      this.minimumResumeProtocolVersion ?? 0,
      this.storedSession?.resumeProtocolVersion ?? 0,
    );
    if (
      pinnedResumeProtocolVersion > 0 &&
      resumeProtocolVersion < pinnedResumeProtocolVersion
    ) {
      return false;
    }
    this.minimumResumeProtocolVersion = Math.max(
      pinnedResumeProtocolVersion,
      resumeProtocolVersion,
    );
    return true;
  }

  private verifyResumeServerProof(params: {
    serverProof: string | undefined;
    baseSessionKey: Uint8Array;
    sessionId: string;
    transportNonce: string | undefined;
  }): number | null {
    if (
      !params.serverProof ||
      !params.transportNonce ||
      !this.pendingResumeClientNonce ||
      !this.pendingResumeServerNonce ||
      params.transportNonce !== this.pendingResumeServerNonce
    ) {
      return null;
    }

    try {
      const decrypted = this.decryptProofEnvelope(
        params.serverProof,
        params.baseSessionKey,
      );
      if (!decrypted) {
        return null;
      }

      const proofData = JSON.parse(decrypted) as {
        type?: unknown;
        sessionId?: unknown;
        serverNonce?: unknown;
        clientNonce?: unknown;
        resumeProtocolVersion?: unknown;
      };
      if (
        proofData.type === "srp_resume_server_proof" &&
        proofData.sessionId === params.sessionId &&
        proofData.serverNonce === this.pendingResumeServerNonce &&
        proofData.clientNonce === this.pendingResumeClientNonce
      ) {
        return typeof proofData.resumeProtocolVersion === "number"
          ? proofData.resumeProtocolVersion
          : null;
      }
      return null;
    } catch {
      return null;
    }
  }

  private readSrpVerifyServerInfoProof(params: {
    serverInfoProof: string | undefined;
    baseSessionKey: Uint8Array;
    sessionId: string | undefined;
    transportNonce: string | undefined;
  }): number | null {
    if (!params.serverInfoProof) {
      return null;
    }
    if (!params.sessionId || !params.transportNonce) {
      return null;
    }

    try {
      const decrypted = this.decryptProofEnvelope(
        params.serverInfoProof,
        params.baseSessionKey,
      );
      if (!decrypted) {
        return null;
      }
      const proofData = JSON.parse(decrypted) as {
        type?: unknown;
        sessionId?: unknown;
        transportNonce?: unknown;
        resumeProtocolVersion?: unknown;
      };
      if (
        proofData.type !== "srp_verify_server_info" ||
        proofData.sessionId !== params.sessionId ||
        proofData.transportNonce !== params.transportNonce ||
        typeof proofData.resumeProtocolVersion !== "number"
      ) {
        return null;
      }
      return proofData.resumeProtocolVersion;
    } catch {
      return null;
    }
  }

  private acceptGraceProtocolVersion(resumeProtocolVersion: number): boolean {
    return this.acceptAuthenticatedResumeProtocolVersion(
      resumeProtocolVersion,
      GRACE_FULL_SRP_PROTOCOL_VERSION,
    );
  }

  /**
   * Start the full SRP handshake (when session resume fails or no stored session).
   */
  private async startFullSrpHandshake(
    _authRejectHandler: (err: Error) => void,
  ): Promise<void> {
    if (!this.password) {
      throw new Error("Password required for SRP authentication");
    }

    this.pendingResumeClientNonce = null;
    this.pendingResumeServerNonce = null;
    console.log("[SecureConnection] Starting full SRP handshake");
    this.srpSession = new SrpClientSession();
    await this.srpSession.generateHello(this.username, this.password);

    const browserProfileId = getOrCreateBrowserProfileId();
    const originMetadata: OriginMetadata = {
      origin: window.location.origin,
      scheme: window.location.protocol.replace(":", ""),
      hostname: window.location.hostname,
      port: window.location.port
        ? Number.parseInt(window.location.port, 10)
        : null,
      userAgent: navigator.userAgent,
    };

    const hello: SrpClientHello = {
      type: "srp_hello",
      identity: this.username,
      browserProfileId,
      originMetadata,
    };
    this.ws?.send(JSON.stringify(hello));
    this.connectionState = "srp_hello_sent";
    console.log("[SecureConnection] SRP hello sent");
  }

  /**
   * Handle session resume response.
   */
  private async handleSrpResumeResponse(
    data: string,
    resolve: () => void,
    reject: (err: Error) => void,
  ): Promise<void> {
    try {
      const msg = JSON.parse(data);

      if (isSrpSessionResumeChallenge(msg)) {
        if (!this.storedSession) {
          reject(new Error("No stored session for resumption"));
          return;
        }
        if (msg.sessionId !== this.storedSession.sessionId) {
          reject(new Error("Resume challenge session mismatch"));
          this.ws?.close();
          return;
        }
        this.pendingResumeServerNonce = msg.nonce;

        const proof = this.generateResumeProof(
          this.storedSession.sessionKey,
          msg.nonce,
          this.storedSession.sessionId,
        );
        const resume: SrpSessionResume = {
          type: "srp_resume",
          identity: this.username,
          sessionId: this.storedSession.sessionId,
          proof,
        };
        this.ws?.send(JSON.stringify(resume));
        this.connectionState = "srp_resume_proof_sent";
        console.log("[SecureConnection] SRP resume proof sent");
        return;
      }

      if (isSrpSessionResumed(msg)) {
        console.log("[SecureConnection] Session resumed successfully");
        if (!this.storedSession) {
          reject(new Error("No stored session for resumption"));
          return;
        }
        if (msg.sessionId !== this.storedSession.sessionId) {
          reject(new Error("Resume response session mismatch"));
          this.ws?.close();
          return;
        }
        const baseSessionKey = Uint8Array.from(
          atob(this.storedSession.sessionKey),
          (c) => c.charCodeAt(0),
        );
        if (
          !msg.transportNonce ||
          msg.transportNonce !== this.pendingResumeServerNonce
        ) {
          console.error("[SecureConnection] Resume server proof failed");
          this.connectionState = "failed";
          reject(new Error("Resume server verification failed"));
          this.ws?.close();
          return;
        }
        const transportNonce = msg.transportNonce;
        let authenticatedResumeProtocolVersion =
          GRACE_FULL_SRP_PROTOCOL_VERSION;
        if (msg.serverProof) {
          const proofProtocolVersion = this.verifyResumeServerProof({
            serverProof: msg.serverProof,
            baseSessionKey,
            sessionId: this.storedSession.sessionId,
            transportNonce,
          });
          if (
            proofProtocolVersion === null ||
            !this.acceptAuthenticatedResumeProtocolVersion(proofProtocolVersion)
          ) {
            console.error("[SecureConnection] Resume server proof failed");
            this.connectionState = "failed";
            reject(new Error("Resume server verification failed"));
            this.ws?.close();
            return;
          }
          authenticatedResumeProtocolVersion = proofProtocolVersion;
        } else if (
          !this.acceptGraceProtocolVersion(GRACE_FULL_SRP_PROTOCOL_VERSION)
        ) {
          console.error(
            "[SecureConnection] Resume would downgrade authenticated protocol",
          );
          this.connectionState = "failed";
          reject(new Error("Resume server verification failed"));
          this.ws?.close();
          return;
        }
        this.sessionKey = deriveTransportKey(baseSessionKey, transportNonce);
        this.sessionId = msg.sessionId;
        this.connectionState = "authenticated";
        this.pendingResumeClientNonce = null;
        this.pendingResumeServerNonce = null;
        this.storedSession = {
          ...this.storedSession,
          resumeProtocolVersion: authenticatedResumeProtocolVersion,
        };
        this.resetSequenceState();

        if (this.ws) {
          this.ws.onmessage = (event) => this.handleMessage(event.data);
        }

        this.onSessionEstablished?.(this.storedSession);
        this.sendCapabilities();
        this.connectionManager?.markConnected();
        this.onAuthenticated?.();
        resolve();
        return;
      }

      if (isSrpSessionInvalid(msg)) {
        if (!this.password) {
          console.log(
            `[SecureConnection] Session resume failed: ${msg.reason} (no password for fallback)`,
          );
          this.connectionState = "failed";
          reject(new Error(`Session invalid: ${msg.reason}`));
          this.ws?.close();
          return;
        }

        console.log(
          `[SecureConnection] Session resume failed: ${msg.reason}, falling back to SRP`,
        );
        this.storedSession = null;
        await this.startFullSrpHandshake(reject);
        return;
      }

      if (isSrpError(msg)) {
        console.error(
          "[SecureConnection] SRP error during resume:",
          msg.message,
        );
        this.connectionState = "failed";
        reject(new Error(`Authentication failed: ${msg.message}`));
        this.ws?.close();
        return;
      }

      console.warn("[SecureConnection] Unexpected message during resume:", msg);
      this.connectionState = "failed";
      reject(
        new Error(
          `Unexpected message during resume: ${msg?.type ?? "unknown"}`,
        ),
      );
      this.ws?.close();
    } catch (err) {
      console.error("[SecureConnection] Resume response error:", err);
      this.connectionState = "failed";
      reject(err instanceof Error ? err : new Error(String(err)));
      this.ws?.close();
    }
  }

  /**
   * Ensure connection is authenticated, reconnecting if necessary.
   */
  private async ensureConnected(): Promise<void> {
    if (
      this.ws?.readyState === WEBSOCKET_OPEN_STATE &&
      this.connectionState === "authenticated"
    ) {
      return;
    }

    if (this.connectionPromise) {
      return this.connectionPromise;
    }

    this.connectionPromise = this.connectAndAuthenticate();
    try {
      await this.connectionPromise;
    } finally {
      this.connectionPromise = null;
    }
  }

  /**
   * Handle WebSocket close events. Extracted to avoid duplication across
   * connectAndAuthenticate, resumeOnExistingSocket, and authenticateOnExistingSocket.
   */
  private handleSocketClose(
    event: CloseEvent,
    authRejectHandler?: (err: Error) => void,
  ): void {
    console.log("[SecureConnection] Closed:", event.code, event.reason);
    const wasAuthenticated = this.connectionState === "authenticated";
    this.ws = null;
    this.sessionKey = null;
    this.srpSession = null;
    this.pendingResumeClientNonce = null;
    this.pendingResumeServerNonce = null;
    this.resetSequenceState();

    const closeError = new WebSocketCloseError(event.code, event.reason);

    if (!wasAuthenticated) {
      this.connectionState = "failed";
      authRejectHandler?.(closeError);
    } else {
      this.connectionState = "disconnected";
      this.connectionManager?.handleClose(closeError);
      this.onDisconnect?.(closeError);
    }

    this.protocol.rejectAllPending(closeError);
    this.protocol.notifySubscriptionsClosed(closeError);
  }

  /**
   * Connect to the WebSocket server and perform SRP authentication.
   */
  private connectAndAuthenticate(): Promise<void> {
    return new Promise((resolve, reject) => {
      // Relay connections need to go through the relay again
      if (this.isRelayConnection) {
        if (this.relayUrl && this.relayUsername && this.storedSession) {
          console.log(
            "[SecureConnection] Relay connection dropped, attempting auto-reconnect",
          );
          this.reconnectThroughRelay()
            .then(resolve)
            .catch((err) => {
              console.error(
                "[SecureConnection] Relay auto-reconnect failed:",
                err,
              );
              reject(
                new RelayReconnectRequiredError(
                  err instanceof Error ? err : new Error(String(err)),
                ),
              );
            });
          return;
        }
        console.log(
          "[SecureConnection] Cannot reconnect relay connection (missing config or session)",
        );
        reject(
          new RelayReconnectRequiredError(
            new Error("Missing relay config or stored session"),
          ),
        );
        return;
      }

      console.log("[SecureConnection] Connecting to", this.wsUrl);
      this.connectionState = "connecting";

      const ws = new WebSocket(this.wsUrl);
      ws.binaryType = "arraybuffer";

      let authResolveHandler: () => void = () => {};
      let authRejectHandler: (err: Error) => void = () => {};

      const authPromise = new Promise<void>((res, rej) => {
        authResolveHandler = res;
        authRejectHandler = rej;
      });
      let resumeTimeout: ReturnType<typeof setTimeout> | null = null;

      const clearResumeTimeout = () => {
        if (resumeTimeout) {
          clearTimeout(resumeTimeout);
          resumeTimeout = null;
        }
      };

      const armResumeTimeout = () => {
        clearResumeTimeout();
        resumeTimeout = setTimeout(() => {
          if (
            this.connectionState !== "srp_resume_init_sent" &&
            this.connectionState !== "srp_resume_proof_sent"
          ) {
            return;
          }

          if (this.password) {
            console.log(
              "[SecureConnection] Session resume timed out, falling back to full SRP",
            );
            this.storedSession = null;
            this.startFullSrpHandshake(authRejectHandler).catch((err) => {
              this.connectionState = "failed";
              authRejectHandler(
                err instanceof Error ? err : new Error(String(err)),
              );
              ws.close();
            });
            return;
          }

          this.connectionState = "failed";
          authRejectHandler(new Error(RESUME_INCOMPATIBLE_ERROR));
          ws.close();
        }, RESUME_PHASE_TIMEOUT_MS);
      };

      ws.onopen = async () => {
        console.log("[SecureConnection] WebSocket connected");
        this.ws = ws;

        try {
          if (this.storedSession) {
            if (this.storedSessionSupportsCurrentResume()) {
              console.log("[SecureConnection] Attempting session resumption");
              const resumeInit: SrpSessionResumeInit = {
                type: "srp_resume_init",
                identity: this.username,
                sessionId: this.storedSession.sessionId,
                clientNonce: this.startResumeAttempt(),
              };
              ws.send(JSON.stringify(resumeInit));
              this.connectionState = "srp_resume_init_sent";
              console.log("[SecureConnection] SRP resume init sent");
              armResumeTimeout();
              return;
            }

            if (!this.password) {
              this.connectionState = "failed";
              authRejectHandler(new Error(RESUME_INCOMPATIBLE_ERROR));
              ws.close();
              return;
            }

            console.log(
              "[SecureConnection] Stored session uses an old resume protocol; starting full SRP",
            );
            this.storedSession = null;
          }

          await this.startFullSrpHandshake(authRejectHandler);
        } catch (err) {
          console.error("[SecureConnection] Connection error:", err);
          this.connectionState = "failed";
          authRejectHandler(
            err instanceof Error ? err : new Error(String(err)),
          );
          ws.close();
        }
      };

      ws.onerror = (event) => {
        console.error("[SecureConnection] Error:", event);
      };

      ws.onclose = (event) => {
        this.handleSocketClose(event, authRejectHandler);
      };

      ws.onmessage = async (event) => {
        if (
          this.connectionState === "srp_resume_init_sent" ||
          this.connectionState === "srp_resume_proof_sent"
        ) {
          armResumeTimeout();
          await this.handleSrpResumeResponse(
            event.data,
            authResolveHandler,
            authRejectHandler,
          );
        } else if (this.connectionState === "srp_hello_sent") {
          await this.handleSrpChallenge(
            event.data,
            authResolveHandler,
            authRejectHandler,
          );
        } else if (this.connectionState === "srp_proof_sent") {
          await this.handleSrpVerify(
            event.data,
            authResolveHandler,
            authRejectHandler,
          );
        } else if (this.connectionState === "authenticated") {
          this.handleMessage(event.data);
        }
      };

      const timeout = setTimeout(() => {
        if (this.connectionState !== "authenticated") {
          ws.close();
          this.connectionState = "failed";
          reject(new Error("Connection timeout"));
        }
      }, 30000);

      authPromise
        .then(() => {
          clearResumeTimeout();
          clearTimeout(timeout);
          resolve();
        })
        .catch((err) => {
          clearResumeTimeout();
          clearTimeout(timeout);
          reject(err);
        });
    });
  }

  /**
   * Reconnect through relay server and resume SRP session.
   */
  private static async connectRelaySocket(
    relayUrl: string,
    relayUsername: string,
    channel: RelayChannel = DEFAULT_RELAY_CHANNEL,
    openSocket: RelaySocketFactory = openRelayClientSocket,
  ): Promise<SecureConnectionSocket> {
    const ws = await openSocket({
      relayUrl,
      relayUsername,
      channel,
      onOpen: () => {
        console.log(
          `[SecureConnection] Relay connected, sending client_connect (${channel})`,
        );
      },
    });
    console.log("[SecureConnection] Relay paired with server");
    return ws;
  }

  private async reconnectThroughRelay(): Promise<void> {
    if (!this.relayUrl || !this.relayUsername || !this.storedSession) {
      throw new Error("Missing relay config or stored session for reconnect");
    }

    console.log("[SecureConnection] Connecting to relay:", this.relayUrl);
    this.connectionState = "connecting";

    const ws = await SecureConnection.connectRelaySocket(
      this.relayUrl,
      this.relayUsername,
      this.relayChannel,
      this.relaySocketFactory ?? openRelayClientSocket,
    );

    console.log("[SecureConnection] Resuming SRP session on new relay socket");
    ws.onmessage = null;
    ws.onclose = null;
    ws.onerror = null;
    this.ws = ws;
    await this.resumeOnExistingSocket();
  }

  /**
   * Handle SRP challenge message from server.
   */
  private async handleSrpChallenge(
    data: string,
    _resolve: () => void,
    reject: (err: Error) => void,
  ): Promise<void> {
    try {
      const msg = JSON.parse(data);

      if (isSrpError(msg)) {
        console.error("[SecureConnection] SRP error:", msg.message);
        this.connectionState = "failed";
        reject(new Error(`Authentication failed: ${msg.message}`));
        this.ws?.close();
        return;
      }

      if (!isSrpServerChallenge(msg)) {
        console.warn(
          "[SecureConnection] Unexpected message during SRP challenge:",
          msg,
        );
        this.connectionState = "failed";
        reject(
          new Error(
            `Unexpected message during SRP challenge: ${msg?.type ?? "unknown"}`,
          ),
        );
        this.ws?.close();
        return;
      }

      if (!this.srpSession) {
        reject(new Error("No SRP session"));
        return;
      }

      console.log("[SecureConnection] Received SRP challenge");

      const { A, M1 } = await this.srpSession.processChallenge(msg.salt, msg.B);

      const proof: SrpClientProof = {
        type: "srp_proof",
        A,
        M1,
      };
      this.ws?.send(JSON.stringify(proof));
      this.connectionState = "srp_proof_sent";
      console.log("[SecureConnection] SRP proof sent");
    } catch (err) {
      console.error("[SecureConnection] SRP challenge error:", err);
      this.connectionState = "failed";
      reject(err instanceof Error ? err : new Error(String(err)));
      this.ws?.close();
    }
  }

  /**
   * Handle SRP verify message from server.
   */
  private async handleSrpVerify(
    data: string,
    resolve: () => void,
    reject: (err: Error) => void,
  ): Promise<void> {
    try {
      const msg = JSON.parse(data);

      if (isSrpError(msg)) {
        console.error("[SecureConnection] SRP error:", msg.message);
        this.connectionState = "failed";
        reject(new Error(`Authentication failed: ${msg.message}`));
        this.ws?.close();
        return;
      }

      if (!isSrpServerVerify(msg)) {
        console.warn(
          "[SecureConnection] Unexpected message during SRP verify:",
          msg,
        );
        this.connectionState = "failed";
        reject(
          new Error(
            `Unexpected message during SRP verify: ${msg?.type ?? "unknown"}`,
          ),
        );
        this.ws?.close();
        return;
      }

      if (!this.srpSession) {
        reject(new Error("No SRP session"));
        return;
      }

      console.log("[SecureConnection] Received SRP verify");

      const valid = await this.srpSession.verifyServer(msg.M2);
      if (!valid) {
        console.error("[SecureConnection] Server verification failed");
        this.connectionState = "failed";
        reject(new Error("Server verification failed"));
        this.ws?.close();
        return;
      }

      const rawKey = this.srpSession.getSessionKey();
      if (!rawKey) {
        reject(new Error("No session key"));
        return;
      }
      const baseSessionKey = deriveSecretboxKey(rawKey);
      if (!msg.sessionId || !msg.transportNonce) {
        console.error(
          "[SecureConnection] SRP verify missing required protocol metadata",
        );
        this.connectionState = "failed";
        reject(new Error("Server protocol verification failed"));
        this.ws?.close();
        return;
      }
      let authenticatedResumeProtocolVersion = GRACE_FULL_SRP_PROTOCOL_VERSION;
      if (msg.serverInfoProof) {
        const proofProtocolVersion = this.readSrpVerifyServerInfoProof({
          serverInfoProof: msg.serverInfoProof,
          baseSessionKey,
          sessionId: msg.sessionId,
          transportNonce: msg.transportNonce,
        });
        if (
          typeof proofProtocolVersion !== "number" ||
          !this.acceptAuthenticatedResumeProtocolVersion(proofProtocolVersion)
        ) {
          console.error("[SecureConnection] SRP server info proof failed");
          this.connectionState = "failed";
          reject(new Error("Server protocol verification failed"));
          this.ws?.close();
          return;
        }
        authenticatedResumeProtocolVersion = proofProtocolVersion;
      } else if (
        !this.acceptGraceProtocolVersion(GRACE_FULL_SRP_PROTOCOL_VERSION)
      ) {
        console.error(
          "[SecureConnection] SRP verify would downgrade authenticated protocol",
        );
        this.connectionState = "failed";
        reject(new Error("Server protocol verification failed"));
        this.ws?.close();
        return;
      }
      this.sessionKey = deriveTransportKey(baseSessionKey, msg.transportNonce);
      this.sessionId = msg.sessionId;
      this.connectionState = "authenticated";
      this.resetSequenceState();

      const sessionKeyBase64 = btoa(
        Array.from(baseSessionKey)
          .map((b) => String.fromCharCode(b))
          .join(""),
      );
      this.storedSession = {
        wsUrl: this.wsUrl,
        username: this.username,
        sessionId: this.sessionId,
        sessionKey: sessionKeyBase64,
        resumeProtocolVersion: authenticatedResumeProtocolVersion,
      };
      this.onSessionEstablished?.(this.storedSession);

      this.sendCapabilities();
      this.connectionManager?.markConnected();
      this.onAuthenticated?.();

      console.log("[SecureConnection] Authentication complete");
      resolve();
    } catch (err) {
      console.error("[SecureConnection] SRP verify error:", err);
      this.connectionState = "failed";
      reject(err instanceof Error ? err : new Error(String(err)));
      this.ws?.close();
    }
  }

  /**
   * Handle incoming WebSocket messages (after authentication).
   */
  private async handleMessage(data: unknown): Promise<void> {
    if (!this.sessionKey) {
      console.warn("[SecureConnection] No session key for decryption");
      return;
    }

    let decrypted: string | null = null;

    if (isBinaryData(data)) {
      try {
        const completeMessage = this.inboundChunks.acceptFrame(data);
        if (!completeMessage) return;
        decrypted = await decryptBinaryEnvelopeWithDecompression(
          completeMessage,
          this.sessionKey,
        );
        if (!decrypted) {
          console.warn("[SecureConnection] Failed to decrypt binary envelope");
          return;
        }
      } catch (err) {
        console.warn("[SecureConnection] Binary envelope error:", err);
        if (err instanceof TransportChunkError) {
          this.ws?.close(4005, "Invalid transport chunk sequence");
        }
        return;
      }
    } else if (typeof data === "string") {
      console.warn(
        "[SecureConnection] Received text message after auth; binary encrypted envelope required",
      );
      this.ws?.close(4005, "Binary encrypted message required");
      return;
    } else {
      console.warn("[SecureConnection] Ignoring unknown message type");
      return;
    }

    let msg: YepMessage;
    try {
      const payload = JSON.parse(decrypted);
      if (isSequencedEncryptedPayload(payload)) {
        if (
          this.lastInboundSeq !== null &&
          payload.seq <= this.lastInboundSeq
        ) {
          console.warn(
            `[SecureConnection] Replay/old sequence rejected: seq=${payload.seq}, last=${this.lastInboundSeq}`,
          );
          this.ws?.close(4004, "Replay detected");
          return;
        }
        this.lastInboundSeq = payload.seq;
        msg = payload.msg as YepMessage;
      } else {
        console.warn("[SecureConnection] Missing/invalid encrypted sequence");
        this.ws?.close(4004, "Invalid sequence");
        return;
      }
    } catch {
      console.warn(
        "[SecureConnection] Failed to parse decrypted message:",
        decrypted,
      );
      return;
    }

    this.protocol.routeMessage(msg);
  }

  /**
   * Send an encrypted message over the WebSocket.
   */
  private send(msg: RemoteClientMessage): void {
    if (!this.ws || this.ws.readyState !== WEBSOCKET_OPEN_STATE) {
      throw new Error("WebSocket not connected");
    }
    if (!this.sessionKey) {
      throw new Error("Not authenticated");
    }

    const plaintext = JSON.stringify({ seq: this.nextOutboundSeq, msg });
    this.nextOutboundSeq += 1;
    const envelope = encryptToBinaryEnvelope(plaintext, this.sessionKey);
    this.ws.send(envelope);
  }

  async openSpeechSocket(): Promise<ConnectionSpeechSocket> {
    if (!this.relayUrl || !this.relayUsername || !this.storedSession) {
      throw new Error("Speech relay requires an active relayed session");
    }

    const ws = await SecureConnection.connectRelaySocket(
      this.relayUrl,
      this.relayUsername,
      SPEECH_RELAY_CHANNEL,
    );

    let socket: SecureConnectionSpeechSocket | null = null;
    const connection = await SecureConnection.forResumeOnlyWithSocket(
      ws,
      this.storedSession,
      { onDisconnect: (error) => socket?.handleDisconnect(error) },
      {
        relayUrl: this.relayUrl,
        relayUsername: this.relayUsername,
        channel: SPEECH_RELAY_CHANNEL,
      },
    );
    socket = new SecureConnectionSpeechSocket(connection);
    return socket;
  }

  sendSpeechControlMessage(message: unknown): void {
    this.send({ type: "speech_control", message });
  }

  sendSpeechAudioFrame(data: ArrayBuffer | Uint8Array | ArrayBufferView): void {
    if (!this.ws || this.ws.readyState !== WEBSOCKET_OPEN_STATE) {
      throw new Error("WebSocket not connected");
    }
    if (!this.sessionKey) {
      throw new Error("Not authenticated");
    }

    const envelope = encryptBytesToBinaryEnvelope(
      toUint8ArrayView(data),
      BinaryFormat.SPEECH_AUDIO,
      this.sessionKey,
    );
    this.ws.send(envelope);
  }

  onSpeechEvent(
    handler: (message: RelaySpeechEvent["message"]) => void,
  ): () => void {
    return this.protocol.onSpeechEvent(handler);
  }

  getSpeechSocketReadyState(): number {
    return this.ws?.readyState ?? WEBSOCKET_CLOSED_STATE;
  }

  getSpeechSocketBufferedAmount(): number {
    return this.ws?.bufferedAmount ?? 0;
  }

  private resetSequenceState(): void {
    this.nextOutboundSeq = 0;
    this.lastInboundSeq = null;
    this.inboundChunks.reset();
  }

  /**
   * Send client capabilities to the server.
   * Called immediately after SRP authentication completes.
   */
  private sendCapabilities(): void {
    const formats: number[] = [
      BinaryFormat.JSON,
      BinaryFormat.BINARY_UPLOAD,
      BinaryFormat.SPEECH_AUDIO,
      BinaryFormat.TRANSPORT_CHUNK,
    ];

    if (isCompressionSupported()) {
      formats.push(BinaryFormat.COMPRESSED_JSON);
    }

    const msg: ClientCapabilities = {
      type: "client_capabilities",
      version: getClientVersion(),
      capabilityBits: [],
      formats: formats as ClientCapabilities["formats"],
    };

    console.log(
      `[SecureConnection] Sending capabilities: formats=${formats.map((f) => `0x${f.toString(16).padStart(2, "0")}`).join(", ")}`,
    );

    try {
      this.send(msg);
    } catch (err) {
      console.warn("[SecureConnection] Failed to send capabilities:", err);
    }
  }

  async fetch<T>(path: string, init?: RequestInit): Promise<T> {
    return this.protocol.fetch<T>(path, init);
  }

  async fetchBlob(path: string): Promise<Blob> {
    return this.protocol.fetchBlob(path);
  }

  async fetchResponse(path: string, init?: RequestInit): Promise<Response> {
    return this.protocol.fetchResponse(path, init);
  }

  subscribeConversation(
    subscriptionId: string,
    query: ConversationQuery,
    handlers: StreamHandlers,
  ): Subscription {
    return this.protocol.subscribeConversation(subscriptionId, query, handlers);
  }

  subscribeSession(
    sessionId: string,
    handlers: StreamHandlers,
    lastEventId?: string,
    options?: SessionSubscriptionOptions,
  ): Subscription {
    return this.protocol.subscribeSession(
      sessionId,
      handlers,
      lastEventId,
      options,
    );
  }

  subscribeActivity(handlers: StreamHandlers): Subscription {
    return this.protocol.subscribeActivity(handlers);
  }

  subscribeGlossary(projectId: string, handlers: StreamHandlers): Subscription {
    return this.protocol.subscribeGlossary(projectId, handlers);
  }

  subscribeWorktree(
    projectId: string,
    coverage: GitWorktreeCoverage,
    handlers: StreamHandlers,
  ): Subscription {
    return this.protocol.subscribeWorktree(projectId, coverage, handlers);
  }

  subscribeSessionWatch(
    sessionId: string,
    handlers: StreamHandlers,
    options?: {
      projectId?: string;
      provider?: string;
    },
  ): Subscription {
    return this.protocol.subscribeSessionWatch(sessionId, handlers, options);
  }

  async upload(
    projectId: string,
    sessionId: string,
    file: File,
    options?: UploadOptions,
  ): Promise<UploadedFile> {
    return this.protocol.upload(projectId, sessionId, file, options);
  }

  async uploadStagedAttachment(
    file: File,
    options?: UploadOptions & { batchId?: string },
  ): Promise<StagedAttachmentRef> {
    return this.protocol.uploadStagedAttachment(file, options);
  }

  /**
   * Send a keepalive ping to verify the connection is alive.
   */
  sendPing(id: string): void {
    this.protocol.sendPing(id);
  }

  /**
   * Register a callback for pong responses.
   */
  setOnPong(cb: (id: string) => void): void {
    this.externalOnPong = cb;
    this.updateProtocolPongHandler();
  }

  private updateProtocolPongHandler(): void {
    const manager = this.connectionManager;
    const externalOnPong = this.externalOnPong;
    this.protocol.setOnPong(
      manager || externalOnPong
        ? (id) => {
            manager?.receivePong(id);
            externalOnPong?.(id);
          }
        : undefined,
    );
  }

  sendMessage(msg: RemoteClientMessage): void {
    this.send(msg);
  }

  onDeviceMessage(handler: (msg: DeviceServerMessage) => void): () => void {
    return this.protocol.onDeviceMessage(handler);
  }

  private async waitForUploadBackpressure(): Promise<void> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WEBSOCKET_OPEN_STATE) return;
    if (ws.bufferedAmount <= UPLOAD_BUFFER_HIGH_WATER_BYTES) return;

    while (
      ws.readyState === WEBSOCKET_OPEN_STATE &&
      ws.bufferedAmount > UPLOAD_BUFFER_LOW_WATER_BYTES
    ) {
      await wait(UPLOAD_BUFFER_POLL_MS);
    }

    if (ws.readyState !== WEBSOCKET_OPEN_STATE) {
      throw new Error("WebSocket not connected");
    }
  }

  /**
   * Close the secure connection.
   */
  close(): void {
    this.protocol.close();

    this.sessionKey = null;
    this.srpSession = null;
    this.connectionState = "disconnected";
    this.resetSequenceState();

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  /**
   * Force reconnection of the underlying WebSocket.
   * ConnectionManager handles re-subscription; this just tears down and rebuilds the transport.
   */
  async forceReconnect(): Promise<void> {
    if (this.forceReconnectPromise) {
      return this.forceReconnectPromise;
    }

    const promise = this.performForceReconnect();
    this.forceReconnectPromise = promise;
    try {
      await promise;
    } finally {
      if (this.forceReconnectPromise === promise) {
        this.forceReconnectPromise = null;
      }
    }
  }

  private async performForceReconnect(): Promise<void> {
    console.log(
      `[SecureConnection] Force reconnecting... wsState=${this.ws?.readyState}, connState=${this.connectionState}, isRelay=${this.isRelayConnection}`,
    );

    const activeConnectionAttempt = this.connectionPromise;
    if (activeConnectionAttempt) {
      // A lazy fetch/subscribe recovery is already rebuilding the same secure
      // transport. Let it finish so forceReconnect does not orphan its promise.
      try {
        await activeConnectionAttempt;
        return;
      } catch {
        // The active recovery failed; fall through to a forced reconnect.
      }
    }

    if (this.ws) {
      this.ws.onclose = null;
      this.ws.onerror = null;
      this.ws.onmessage = null;
      this.ws.close();
      this.ws = null;
    }
    this.resetSequenceState();

    const reconnectError = new Error("Connection reconnecting");
    this.protocol.rejectAllPending(reconnectError);
    // Force all stream handlers (activity/session) to transition closed so
    // higher-level consumers can re-subscribe after authentication resumes.
    this.protocol.notifySubscriptionsClosed(reconnectError);

    // Reset connection state but keep session info for resumption
    this.connectionState = "disconnected";
    this.connectionPromise = null;

    await this.ensureConnected();
    console.log(
      `[SecureConnection] Force reconnect complete, connState=${this.connectionState}`,
    );
  }

  /**
   * Check if the connection is authenticated.
   */
  isAuthenticated(): boolean {
    return this.connectionState === "authenticated" && this.sessionKey !== null;
  }

  /**
   * Connect using an existing WebSocket that's already connected through a relay.
   * Skips WebSocket creation and goes straight to SRP authentication.
   */
  static async connectWithExistingSocket(
    ws: SecureConnectionSocket,
    username: string,
    password: string,
    callbacks: SecureConnectionCallbacks = {},
    relayConfig?: RelayConnectionConfig,
  ): Promise<SecureConnection> {
    const conn = new SecureConnection(
      "", // No URL needed - socket already connected
      username,
      password,
      callbacks,
    );
    conn.ws = ws;
    conn.isRelayConnection = true;
    if (relayConfig) {
      conn.relayUrl = relayConfig.relayUrl;
      conn.relayUsername = relayConfig.relayUsername;
      conn.relayChannel = relayConfig.channel ?? DEFAULT_RELAY_CHANNEL;
      conn.relaySocketFactory = relayConfig.openSocket ?? null;
    }
    ws.binaryType = "arraybuffer";

    await conn.authenticateOnExistingSocket();
    return conn;
  }

  /**
   * Perform SRP authentication on an already-connected WebSocket.
   */
  private authenticateOnExistingSocket(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WEBSOCKET_OPEN_STATE) {
        reject(new Error("WebSocket is not open"));
        return;
      }

      console.log("[SecureConnection] Authenticating on existing socket");
      this.connectionState = "connecting";

      let authResolveHandler: () => void = () => {};
      let authRejectHandler: (err: Error) => void = () => {};

      const authPromise = new Promise<void>((res, rej) => {
        authResolveHandler = res;
        authRejectHandler = rej;
      });

      const ws = this.ws;

      ws.onerror = (event) => {
        console.error("[SecureConnection] Error:", event);
      };

      ws.onclose = (event) => {
        this.handleSocketClose(event, authRejectHandler);
      };

      ws.onmessage = async (event) => {
        if (this.connectionState === "srp_hello_sent") {
          await this.handleSrpChallenge(
            event.data,
            authResolveHandler,
            authRejectHandler,
          );
        } else if (this.connectionState === "srp_proof_sent") {
          await this.handleSrpVerify(
            event.data,
            authResolveHandler,
            authRejectHandler,
          );
        } else if (this.connectionState === "authenticated") {
          this.handleMessage(event.data);
        }
      };

      // Start SRP handshake (no session resume for relay connections)
      this.startFullSrpHandshake(authRejectHandler).catch((err) => {
        console.error("[SecureConnection] SRP handshake error:", err);
        this.connectionState = "failed";
        authRejectHandler(err instanceof Error ? err : new Error(String(err)));
        ws.close();
      });

      const timeout = setTimeout(() => {
        if (this.connectionState !== "authenticated") {
          ws.close();
          this.connectionState = "failed";
          reject(new Error("Authentication timeout"));
        }
      }, 30000);

      authPromise
        .then(() => {
          clearTimeout(timeout);
          resolve();
        })
        .catch((err) => {
          clearTimeout(timeout);
          reject(err);
        });
    });
  }
}

class SecureConnectionSpeechSocket implements ConnectionSpeechSocket {
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event?: unknown) => void) | null = null;
  onclose: (() => void) | null = null;

  private readonly unsubscribeSpeech: () => void;
  private closed = false;

  constructor(private readonly connection: SecureConnection) {
    this.unsubscribeSpeech = connection.onSpeechEvent((message) => {
      this.onmessage?.({ data: JSON.stringify(message) });
    });
  }

  get readyState(): number {
    return this.connection.getSpeechSocketReadyState();
  }

  get bufferedAmount(): number {
    return this.connection.getSpeechSocketBufferedAmount();
  }

  send(data: string | ArrayBuffer | Uint8Array | ArrayBufferView): void {
    if (this.closed) {
      throw new Error("Speech socket is closed");
    }
    try {
      if (typeof data === "string") {
        this.connection.sendSpeechControlMessage(JSON.parse(data));
        return;
      }
      this.connection.sendSpeechAudioFrame(data);
    } catch (err) {
      this.onerror?.(err);
      throw err;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.unsubscribeSpeech();
    this.connection.close();
    this.onclose?.();
  }

  handleDisconnect(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.unsubscribeSpeech();
    this.onerror?.(error);
    this.onclose?.();
  }
}
