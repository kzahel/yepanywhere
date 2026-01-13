/**
 * Secure connection for remote access using SRP authentication and NaCl encryption.
 *
 * This implements the Connection interface but routes all traffic through
 * an encrypted WebSocket channel. Uses:
 * - SRP-6a for zero-knowledge password authentication
 * - NaCl secretbox (XSalsa20-Poly1305) for message encryption
 */
import type {
  ClientCapabilities,
  EncryptedEnvelope,
  RelayEvent,
  RelayRequest,
  RelayResponse,
  RelaySubscribe,
  RelayUnsubscribe,
  RelayUploadComplete,
  RelayUploadEnd,
  RelayUploadError,
  RelayUploadProgress,
  RelayUploadStart,
  RemoteClientMessage,
  SrpClientHello,
  SrpClientProof,
  SrpSessionResume,
  UploadedFile,
  YepMessage,
} from "@yep-anywhere/shared";
import {
  BinaryFormat,
  encodeUploadChunkPayload,
  isBinaryData,
  isCompressionSupported,
  isEncryptedEnvelope,
  isSrpError,
  isSrpServerChallenge,
  isSrpServerVerify,
  isSrpSessionInvalid,
  isSrpSessionResumed,
} from "@yep-anywhere/shared";
import { getRelayDebugEnabled } from "../../hooks/useDeveloperMode";
import { LEGACY_KEYS, getServerScoped } from "../storageKeys";
import {
  decrypt,
  decryptBinaryEnvelopeWithDecompression,
  deriveSecretboxKey,
  encrypt,
  encryptBytesToBinaryEnvelope,
  encryptToBinaryEnvelope,
} from "./nacl-wrapper";
import { SrpClientSession } from "./srp-client";
import {
  type Connection,
  type StreamHandlers,
  type Subscription,
  type UploadOptions,
  WebSocketCloseError,
} from "./types";

/**
 * Generate a unique ID for request correlation.
 */
function generateId(): string {
  return crypto.randomUUID();
}

/** Default chunk size for file uploads (64KB) */
const DEFAULT_CHUNK_SIZE = 64 * 1024;

/** Connection authentication state */
type ConnectionState =
  | "disconnected"
  | "connecting"
  | "srp_resume_sent"
  | "srp_hello_sent"
  | "srp_proof_sent"
  | "authenticated"
  | "failed";

/** Stored session for resumption (persisted to localStorage) */
export interface StoredSession {
  wsUrl: string;
  username: string;
  sessionId: string;
  /** Base64-encoded session key (32 bytes) */
  sessionKey: string;
}

/** Handlers for pending uploads */
interface PendingUpload {
  resolve: (file: UploadedFile) => void;
  reject: (error: Error) => void;
  onProgress?: (bytesUploaded: number) => void;
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

  private ws: WebSocket | null = null;
  private srpSession: SrpClientSession | null = null;
  private sessionKey: Uint8Array | null = null;
  private sessionId: string | null = null;
  private connectionState: ConnectionState = "disconnected";
  private pendingRequests = new Map<
    string,
    {
      resolve: (response: RelayResponse) => void;
      reject: (error: Error) => void;
      timeout: ReturnType<typeof setTimeout>;
      startTime: number;
      method: string;
      path: string;
    }
  >();
  private pendingUploads = new Map<string, PendingUpload>();
  private subscriptions = new Map<string, StreamHandlers>();
  private connectionPromise: Promise<void> | null = null;

  // Credentials for authentication
  private username: string;
  private password: string | null;
  private wsUrl: string;

  // Stored session for resumption (optional)
  private storedSession: StoredSession | null = null;

  // Callback when session is established (for storing session data)
  private onSessionEstablished?: (session: StoredSession) => void;

  /**
   * Create a new secure connection with password authentication.
   *
   * @param wsUrl - WebSocket URL to connect to
   * @param username - Username for SRP authentication
   * @param password - Password for SRP authentication
   * @param onSessionEstablished - Optional callback when session is established (for storing)
   */
  constructor(
    wsUrl: string,
    username: string,
    password: string,
    onSessionEstablished?: (session: StoredSession) => void,
  ) {
    this.wsUrl = wsUrl;
    this.username = username;
    this.password = password;
    this.onSessionEstablished = onSessionEstablished;
  }

  /**
   * Create a secure connection from a stored session.
   * Will attempt to resume the session, falling back to full SRP if the session is invalid.
   *
   * @param storedSession - Previously stored session data
   * @param password - Password (required for fallback to full SRP)
   * @param onSessionEstablished - Optional callback when a new session is established
   */
  static fromStoredSession(
    storedSession: StoredSession,
    password: string,
    onSessionEstablished?: (session: StoredSession) => void,
  ): SecureConnection {
    const conn = new SecureConnection(
      storedSession.wsUrl,
      storedSession.username,
      password,
      onSessionEstablished,
    );
    conn.storedSession = storedSession;
    return conn;
  }

  /**
   * Create a secure connection for resume-only mode (no password fallback).
   * Will attempt to resume the session and fail if the session is invalid.
   * Use this for automatic reconnection on page load.
   *
   * @param storedSession - Previously stored session data
   * @param onSessionEstablished - Optional callback when session is refreshed
   */
  static forResumeOnly(
    storedSession: StoredSession,
    onSessionEstablished?: (session: StoredSession) => void,
  ): SecureConnection {
    // Create connection with empty password (will fail if fallback is attempted)
    const conn = new SecureConnection(
      storedSession.wsUrl,
      storedSession.username,
      "", // No password - resume only
      onSessionEstablished,
    );
    conn.storedSession = storedSession;
    conn.password = null; // Mark as resume-only
    return conn;
  }

  /**
   * Create a secure connection for resume-only mode using an existing WebSocket.
   * Used for relay connections where we need to reconnect through the relay first,
   * then resume the SRP session on the paired socket.
   *
   * @param ws - Pre-connected WebSocket (already paired through relay)
   * @param storedSession - Previously stored session data
   * @param onSessionEstablished - Optional callback when session is refreshed
   * @returns Promise that resolves to SecureConnection after session resume completes
   */
  static async forResumeOnlyWithSocket(
    ws: WebSocket,
    storedSession: StoredSession,
    onSessionEstablished?: (session: StoredSession) => void,
  ): Promise<SecureConnection> {
    const conn = new SecureConnection(
      "relay://", // Marker URL for relay connections
      storedSession.username,
      "", // No password - resume only
      onSessionEstablished,
    );
    conn.ws = ws;
    conn.storedSession = storedSession;
    conn.password = null; // Mark as resume-only

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
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error("WebSocket is not open"));
        return;
      }

      if (!this.storedSession) {
        reject(new Error("No stored session for resume"));
        return;
      }

      console.log("[SecureConnection] Resuming session on existing socket");
      this.connectionState = "connecting";

      // Create auth handlers
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
        console.log("[SecureConnection] Closed:", event.code, event.reason);
        this.ws = null;
        this.sessionKey = null;
        this.srpSession = null;

        const closeError = new WebSocketCloseError(event.code, event.reason);
        if (this.connectionState !== "authenticated") {
          authRejectHandler(closeError);
        }
      };

      ws.onmessage = (event) => {
        this.handleSrpResumeResponse(event.data, authResolveHandler, reject);
      };

      // Send resume message
      const proof = this.generateResumeProof(this.storedSession.sessionKey);
      const resume: SrpSessionResume = {
        type: "srp_resume",
        identity: this.username,
        sessionId: this.storedSession.sessionId,
        proof,
      };
      ws.send(JSON.stringify(resume));
      this.connectionState = "srp_resume_sent";
      console.log("[SecureConnection] SRP resume sent");

      // Wait for auth to complete
      authPromise.then(resolve).catch(reject);
    });
  }

  /**
   * Generate a resume proof by encrypting the current timestamp with the session key.
   */
  private generateResumeProof(base64SessionKey: string): string {
    const sessionKeyBytes = Uint8Array.from(atob(base64SessionKey), (c) =>
      c.charCodeAt(0),
    );
    const timestamp = Date.now();
    const proofData = JSON.stringify({ timestamp });
    const { nonce, ciphertext } = encrypt(proofData, sessionKeyBytes);
    return JSON.stringify({ nonce, ciphertext });
  }

  /**
   * Start the full SRP handshake (when session resume fails or no stored session).
   */
  private async startFullSrpHandshake(
    authRejectHandler: (err: Error) => void,
  ): Promise<void> {
    if (!this.password) {
      throw new Error("Password required for SRP authentication");
    }

    console.log("[SecureConnection] Starting full SRP handshake");
    this.srpSession = new SrpClientSession();
    await this.srpSession.generateHello(this.username, this.password);

    // Send hello
    const hello: SrpClientHello = {
      type: "srp_hello",
      identity: this.username,
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

      if (isSrpSessionResumed(msg)) {
        // Session resumed successfully - restore session key from stored session
        console.log("[SecureConnection] Session resumed successfully");
        if (!this.storedSession) {
          reject(new Error("No stored session for resumption"));
          return;
        }
        this.sessionKey = Uint8Array.from(
          atob(this.storedSession.sessionKey),
          (c) => c.charCodeAt(0),
        );
        this.sessionId = msg.sessionId;
        this.connectionState = "authenticated";

        // Switch to encrypted message handler now that we're authenticated
        if (this.ws) {
          this.ws.onmessage = (event) => this.handleMessage(event.data);
        }

        // Send client capabilities (Phase 3) - first encrypted message after auth
        this.sendCapabilities();

        resolve();
        return;
      }

      if (isSrpSessionInvalid(msg)) {
        // If no password available (resume-only mode), fail
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
        // Clear stored session and fall back to full SRP
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
    // If already authenticated, return immediately
    if (
      this.ws?.readyState === WebSocket.OPEN &&
      this.connectionState === "authenticated"
    ) {
      return;
    }

    // If connection is in progress, wait for it
    if (this.connectionPromise) {
      return this.connectionPromise;
    }

    // Start new connection
    this.connectionPromise = this.connectAndAuthenticate();
    try {
      await this.connectionPromise;
    } finally {
      this.connectionPromise = null;
    }
  }

  /**
   * Connect to the WebSocket server and perform SRP authentication.
   */
  private connectAndAuthenticate(): Promise<void> {
    return new Promise((resolve, reject) => {
      console.log("[SecureConnection] Connecting to", this.wsUrl);
      this.connectionState = "connecting";

      const ws = new WebSocket(this.wsUrl);
      // Set binaryType to receive ArrayBuffer instead of Blob for binary frames
      ws.binaryType = "arraybuffer";

      // Create auth handlers that will be set by the Promise executor
      // These are guaranteed to be set before any callbacks fire
      let authResolveHandler: () => void = () => {};
      let authRejectHandler: (err: Error) => void = () => {};

      const authPromise = new Promise<void>((res, rej) => {
        authResolveHandler = res;
        authRejectHandler = rej;
      });

      ws.onopen = async () => {
        console.log("[SecureConnection] WebSocket connected");
        this.ws = ws;

        try {
          // Try session resumption first if we have a stored session
          if (this.storedSession) {
            console.log("[SecureConnection] Attempting session resumption");
            const proof = this.generateResumeProof(
              this.storedSession.sessionKey,
            );
            const resume: SrpSessionResume = {
              type: "srp_resume",
              identity: this.username,
              sessionId: this.storedSession.sessionId,
              proof,
            };
            ws.send(JSON.stringify(resume));
            this.connectionState = "srp_resume_sent";
            console.log("[SecureConnection] SRP resume sent");
            return;
          }

          // No stored session, do full SRP handshake
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
        console.log("[SecureConnection] Closed:", event.code, event.reason);
        this.ws = null;
        this.sessionKey = null;
        this.srpSession = null;

        // Create error with close code and reason
        const closeError = new WebSocketCloseError(event.code, event.reason);

        if (this.connectionState !== "authenticated") {
          this.connectionState = "failed";
          authRejectHandler(closeError);
        }

        // Reject any pending requests
        for (const [id, pending] of this.pendingRequests) {
          clearTimeout(pending.timeout);
          pending.reject(closeError);
          this.pendingRequests.delete(id);
        }

        // Reject any pending uploads
        for (const [id, pending] of this.pendingUploads) {
          pending.reject(closeError);
          this.pendingUploads.delete(id);
        }

        // Notify all subscriptions of closure
        for (const handlers of this.subscriptions.values()) {
          handlers.onError?.(closeError);
          handlers.onClose?.();
        }
        this.subscriptions.clear();
      };

      ws.onmessage = async (event) => {
        // During SRP handshake, handle SRP messages
        if (this.connectionState === "srp_resume_sent") {
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

      // Handle initial connection failure
      const timeout = setTimeout(() => {
        if (this.connectionState !== "authenticated") {
          ws.close();
          this.connectionState = "failed";
          reject(new Error("Connection timeout"));
        }
      }, 30000);

      // Wait for auth to complete
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

  /**
   * Handle SRP challenge message from server.
   */
  private async handleSrpChallenge(
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

      if (!isSrpServerChallenge(msg)) {
        console.warn("[SecureConnection] Unexpected message during SRP:", msg);
        return;
      }

      if (!this.srpSession) {
        reject(new Error("No SRP session"));
        return;
      }

      console.log("[SecureConnection] Received SRP challenge");

      // Process challenge and generate proof
      const { A, M1 } = await this.srpSession.processChallenge(msg.salt, msg.B);

      // Send proof with A
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
        console.warn("[SecureConnection] Unexpected message during SRP:", msg);
        return;
      }

      if (!this.srpSession) {
        reject(new Error("No SRP session"));
        return;
      }

      console.log("[SecureConnection] Received SRP verify");

      // Verify server and derive session key
      const valid = await this.srpSession.verifyServer(msg.M2);
      if (!valid) {
        console.error("[SecureConnection] Server verification failed");
        this.connectionState = "failed";
        reject(new Error("Server verification failed"));
        this.ws?.close();
        return;
      }

      // Derive secretbox key from SRP session key
      const rawKey = this.srpSession.getSessionKey();
      if (!rawKey) {
        reject(new Error("No session key"));
        return;
      }
      this.sessionKey = deriveSecretboxKey(rawKey);
      this.sessionId = msg.sessionId ?? null;
      this.connectionState = "authenticated";

      // Notify caller of new session for storage
      if (this.onSessionEstablished && this.sessionKey && this.sessionId) {
        const sessionKeyBase64 = btoa(
          Array.from(this.sessionKey)
            .map((b) => String.fromCharCode(b))
            .join(""),
        );
        this.onSessionEstablished({
          wsUrl: this.wsUrl,
          username: this.username,
          sessionId: this.sessionId,
          sessionKey: sessionKeyBase64,
        });
      }

      // Send client capabilities (Phase 3) - first encrypted message after auth
      this.sendCapabilities();

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
   * Supports both binary envelope (Phase 1/3) and JSON envelope (legacy) formats.
   * Phase 3 adds support for compressed JSON (format 0x03).
   */
  private async handleMessage(data: unknown): Promise<void> {
    // Decrypt the message
    if (!this.sessionKey) {
      console.warn("[SecureConnection] No session key for decryption");
      return;
    }

    let decrypted: string | null = null;

    // Handle binary data (Phase 1/3 binary envelope)
    if (isBinaryData(data)) {
      try {
        // Use async decryption with decompression support (Phase 3)
        decrypted = await decryptBinaryEnvelopeWithDecompression(
          data,
          this.sessionKey,
        );
        if (!decrypted) {
          console.warn("[SecureConnection] Failed to decrypt binary envelope");
          return;
        }
      } catch (err) {
        console.warn("[SecureConnection] Binary envelope error:", err);
        return;
      }
    } else if (typeof data === "string") {
      // Handle text data (JSON envelope - legacy format)
      let parsed: unknown;
      try {
        parsed = JSON.parse(data);
      } catch {
        console.warn("[SecureConnection] Failed to parse message:", data);
        return;
      }

      // All messages after auth should be encrypted
      if (!isEncryptedEnvelope(parsed)) {
        console.warn(
          "[SecureConnection] Received unencrypted message after auth",
        );
        return;
      }

      // Decrypt the legacy JSON envelope
      decrypted = decrypt(parsed.nonce, parsed.ciphertext, this.sessionKey);
      if (!decrypted) {
        console.warn("[SecureConnection] Failed to decrypt JSON envelope");
        return;
      }
    } else {
      console.warn("[SecureConnection] Ignoring unknown message type");
      return;
    }

    let msg: YepMessage;
    try {
      msg = JSON.parse(decrypted) as YepMessage;
    } catch {
      console.warn(
        "[SecureConnection] Failed to parse decrypted message:",
        decrypted,
      );
      return;
    }

    switch (msg.type) {
      case "response":
        this.handleResponse(msg);
        break;

      case "event":
        this.handleEvent(msg);
        break;

      case "upload_progress":
        this.handleUploadProgress(msg);
        break;

      case "upload_complete":
        this.handleUploadComplete(msg);
        break;

      case "upload_error":
        this.handleUploadError(msg);
        break;

      default:
        console.warn(
          "[SecureConnection] Unknown message type:",
          (msg as { type?: string }).type,
        );
    }
  }

  /**
   * Handle an event message by routing to subscription handlers.
   */
  private handleEvent(event: RelayEvent): void {
    const handlers = this.subscriptions.get(event.subscriptionId);
    if (!handlers) {
      console.warn(
        "[SecureConnection] Received event for unknown subscription:",
        event.subscriptionId,
      );
      return;
    }

    // Route special events
    if (event.eventType === "connected") {
      handlers.onOpen?.();
    }

    // Forward all events (including connected) to the handler
    handlers.onEvent(event.eventType, event.eventId, event.data);
  }

  /**
   * Handle a response message.
   */
  private handleResponse(response: RelayResponse): void {
    const pending = this.pendingRequests.get(response.id);
    if (!pending) {
      console.warn(
        "[SecureConnection] Received response for unknown request:",
        response.id,
      );
      return;
    }

    clearTimeout(pending.timeout);
    this.pendingRequests.delete(response.id);

    // Log response if relay debug is enabled
    if (getRelayDebugEnabled()) {
      const duration = Date.now() - pending.startTime;
      const statusIcon = response.status >= 400 ? "\u2717" : "\u2190";
      console.log(
        `[Relay] ${statusIcon} ${pending.method} ${pending.path} ${response.status} (${duration}ms)`,
      );
    }

    pending.resolve(response);
  }

  /**
   * Handle upload progress message.
   */
  private handleUploadProgress(msg: RelayUploadProgress): void {
    const pending = this.pendingUploads.get(msg.uploadId);
    if (pending?.onProgress) {
      pending.onProgress(msg.bytesReceived);
    }
  }

  /**
   * Handle upload complete message.
   */
  private handleUploadComplete(msg: RelayUploadComplete): void {
    const pending = this.pendingUploads.get(msg.uploadId);
    if (pending) {
      this.pendingUploads.delete(msg.uploadId);
      pending.resolve(msg.file);
    }
  }

  /**
   * Handle upload error message.
   */
  private handleUploadError(msg: RelayUploadError): void {
    const pending = this.pendingUploads.get(msg.uploadId);
    if (pending) {
      this.pendingUploads.delete(msg.uploadId);
      pending.reject(new Error(msg.error));
    }
  }

  /**
   * Send an encrypted message over the WebSocket.
   * Uses binary envelope format (Phase 1) for improved efficiency.
   */
  private send(msg: RemoteClientMessage): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("WebSocket not connected");
    }
    if (!this.sessionKey) {
      throw new Error("Not authenticated");
    }

    const plaintext = JSON.stringify(msg);
    // Use binary envelope format: [version][nonce][ciphertext]
    // where ciphertext decrypts to [format byte][payload]
    const envelope = encryptToBinaryEnvelope(plaintext, this.sessionKey);
    this.ws.send(envelope);
  }

  /**
   * Send client capabilities to the server (Phase 3).
   * Called immediately after SRP authentication completes.
   * Tells server which binary formats this client supports.
   */
  private sendCapabilities(): void {
    // Build list of supported formats
    const formats: number[] = [BinaryFormat.JSON, BinaryFormat.BINARY_UPLOAD];

    // Add compressed JSON if browser supports CompressionStream
    if (isCompressionSupported()) {
      formats.push(BinaryFormat.COMPRESSED_JSON);
    }

    const msg: ClientCapabilities = {
      type: "client_capabilities",
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

  /**
   * Make a JSON API request over encrypted WebSocket.
   */
  async fetch<T>(path: string, init?: RequestInit): Promise<T> {
    await this.ensureConnected();

    const id = generateId();
    const method = (init?.method ?? "GET") as RelayRequest["method"];

    // Parse body if present
    let body: unknown;
    if (init?.body) {
      if (typeof init.body === "string") {
        try {
          body = JSON.parse(init.body);
        } catch {
          body = init.body;
        }
      } else {
        body = init.body;
      }
    }

    // Build headers
    const headers: Record<string, string> = {};
    if (init?.headers) {
      if (init.headers instanceof Headers) {
        init.headers.forEach((value, key) => {
          headers[key] = value;
        });
      } else if (Array.isArray(init.headers)) {
        for (const [key, value] of init.headers) {
          headers[key] = value;
        }
      } else {
        Object.assign(headers, init.headers);
      }
    }

    // Add default headers
    headers["Content-Type"] = "application/json";
    headers["X-Yep-Anywhere"] = "true";

    const request: RelayRequest = {
      type: "request",
      id,
      method,
      path: path.startsWith("/api") ? path : `/api${path}`,
      headers,
      body,
    };

    const startTime = Date.now();

    // Log outgoing request if relay debug is enabled
    if (getRelayDebugEnabled()) {
      console.log(`[Relay] \u2192 ${method} ${request.path}`);
    }

    return new Promise<T>((resolve, reject) => {
      // Set up timeout
      const timeout = setTimeout(() => {
        // Log timeout if relay debug is enabled
        if (getRelayDebugEnabled()) {
          const duration = Date.now() - startTime;
          console.log(
            `[Relay] \u2717 ${method} ${request.path} TIMEOUT (${duration}ms)`,
          );
        }
        this.pendingRequests.delete(id);
        reject(new Error("Request timeout"));
      }, 30000);

      // Store pending request
      this.pendingRequests.set(id, {
        resolve: (response: RelayResponse) => {
          if (response.status >= 400) {
            const error = new Error(
              `API error: ${response.status}`,
            ) as Error & { status: number; setupRequired?: boolean };
            error.status = response.status;
            if (response.headers?.["X-Setup-Required"] === "true") {
              error.setupRequired = true;
            }
            reject(error);
          } else {
            resolve(response.body as T);
          }
        },
        reject,
        timeout,
        startTime,
        method,
        path: request.path,
      });

      // Send encrypted request
      try {
        this.send(request);
      } catch (err) {
        clearTimeout(timeout);
        this.pendingRequests.delete(id);
        reject(err);
      }
    });
  }

  /**
   * Subscribe to session events.
   */
  subscribeSession(
    sessionId: string,
    handlers: StreamHandlers,
    lastEventId?: string,
  ): Subscription {
    const subscriptionId = generateId();

    // Store handlers for routing events
    this.subscriptions.set(subscriptionId, handlers);

    // Send subscribe message (async, but we return synchronously)
    this.ensureConnected()
      .then(() => {
        const msg: RelaySubscribe = {
          type: "subscribe",
          subscriptionId,
          channel: "session",
          sessionId,
          lastEventId,
        };
        this.send(msg);
      })
      .catch((err) => {
        handlers.onError?.(err);
        this.subscriptions.delete(subscriptionId);
      });

    return {
      close: () => {
        this.subscriptions.delete(subscriptionId);
        // Send unsubscribe message if connected
        if (
          this.ws?.readyState === WebSocket.OPEN &&
          this.connectionState === "authenticated"
        ) {
          const msg: RelayUnsubscribe = {
            type: "unsubscribe",
            subscriptionId,
          };
          try {
            this.send(msg);
          } catch {
            // Ignore send errors on close
          }
        }
        handlers.onClose?.();
      },
    };
  }

  /**
   * Subscribe to activity events.
   */
  subscribeActivity(handlers: StreamHandlers): Subscription {
    const subscriptionId = generateId();
    const browserProfileId =
      getServerScoped("browserProfileId", LEGACY_KEYS.browserProfileId) ??
      undefined;

    // Store handlers for routing events
    this.subscriptions.set(subscriptionId, handlers);

    // Send subscribe message (async, but we return synchronously)
    this.ensureConnected()
      .then(() => {
        const msg: RelaySubscribe = {
          type: "subscribe",
          subscriptionId,
          channel: "activity",
          browserProfileId,
        };
        this.send(msg);
      })
      .catch((err) => {
        handlers.onError?.(err);
        this.subscriptions.delete(subscriptionId);
      });

    return {
      close: () => {
        this.subscriptions.delete(subscriptionId);
        // Send unsubscribe message if connected
        if (
          this.ws?.readyState === WebSocket.OPEN &&
          this.connectionState === "authenticated"
        ) {
          const msg: RelayUnsubscribe = {
            type: "unsubscribe",
            subscriptionId,
          };
          try {
            this.send(msg);
          } catch {
            // Ignore send errors on close
          }
        }
        handlers.onClose?.();
      },
    };
  }

  /**
   * Upload a file to a session via encrypted WebSocket relay protocol.
   */
  async upload(
    projectId: string,
    sessionId: string,
    file: File,
    options?: UploadOptions,
  ): Promise<UploadedFile> {
    await this.ensureConnected();

    const uploadId = generateId();
    const chunkSize = options?.chunkSize ?? DEFAULT_CHUNK_SIZE;

    // Create promise that will resolve when upload completes
    const uploadPromise = new Promise<UploadedFile>((resolve, reject) => {
      this.pendingUploads.set(uploadId, {
        resolve,
        reject,
        onProgress: options?.onProgress,
      });

      // Handle abort signal
      if (options?.signal) {
        options.signal.addEventListener("abort", () => {
          this.pendingUploads.delete(uploadId);
          reject(new Error("Upload aborted"));
        });
      }
    });

    try {
      // Send upload_start
      const startMsg: RelayUploadStart = {
        type: "upload_start",
        uploadId,
        projectId,
        sessionId,
        filename: file.name,
        size: file.size,
        mimeType: file.type || "application/octet-stream",
      };
      this.send(startMsg);

      // Read and send chunks
      let offset = 0;
      const reader = file.stream().getReader();

      while (true) {
        // Check if aborted
        if (options?.signal?.aborted) {
          reader.cancel();
          throw new Error("Upload aborted");
        }

        const { done, value } = await reader.read();
        if (done) break;

        // Process the chunk (may be larger than chunkSize, so we split it)
        let chunkOffset = 0;
        while (chunkOffset < value.length) {
          const chunkEnd = Math.min(chunkOffset + chunkSize, value.length);
          const chunk = value.slice(chunkOffset, chunkEnd);

          // Send binary chunk (format 0x02) encrypted
          // Payload format: [16 bytes UUID][8 bytes offset][chunk data]
          const payload = encodeUploadChunkPayload(uploadId, offset, chunk);
          if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
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

          offset += chunk.length;
          chunkOffset = chunkEnd;
        }
      }

      // Send upload_end
      const endMsg: RelayUploadEnd = {
        type: "upload_end",
        uploadId,
      };
      this.send(endMsg);

      // Wait for completion
      return await uploadPromise;
    } catch (err) {
      // Clean up pending upload on error
      this.pendingUploads.delete(uploadId);
      throw err;
    }
  }

  /**
   * Close the secure connection.
   */
  close(): void {
    // Notify and clear subscriptions
    for (const handlers of this.subscriptions.values()) {
      handlers.onClose?.();
    }
    this.subscriptions.clear();

    // Clear pending requests
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("Connection closed"));
    }
    this.pendingRequests.clear();

    // Clear pending uploads
    for (const pending of this.pendingUploads.values()) {
      pending.reject(new Error("Connection closed"));
    }
    this.pendingUploads.clear();

    // Clear session key
    this.sessionKey = null;
    this.srpSession = null;
    this.connectionState = "disconnected";

    // Close WebSocket
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
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
   *
   * @param ws - Pre-connected WebSocket (already open)
   * @param username - Username for SRP authentication
   * @param password - Password for SRP authentication
   * @param onSessionEstablished - Optional callback when session is established
   * @returns SecureConnection instance after successful authentication
   */
  static async connectWithExistingSocket(
    ws: WebSocket,
    username: string,
    password: string,
    onSessionEstablished?: (session: StoredSession) => void,
  ): Promise<SecureConnection> {
    const conn = new SecureConnection(
      "relay://",
      username,
      password,
      onSessionEstablished,
    );
    conn.ws = ws;
    ws.binaryType = "arraybuffer";

    await conn.authenticateOnExistingSocket();
    return conn;
  }

  /**
   * Perform SRP authentication on an already-connected WebSocket.
   * Used by connectWithExistingSocket for relay connections.
   */
  private authenticateOnExistingSocket(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error("WebSocket is not open"));
        return;
      }

      console.log("[SecureConnection] Authenticating on existing socket");
      this.connectionState = "connecting";

      // Create auth handlers
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
        console.log("[SecureConnection] Closed:", event.code, event.reason);
        this.ws = null;
        this.sessionKey = null;
        this.srpSession = null;

        const closeError = new WebSocketCloseError(event.code, event.reason);

        if (this.connectionState !== "authenticated") {
          this.connectionState = "failed";
          authRejectHandler(closeError);
        }

        // Reject pending requests
        for (const [id, pending] of this.pendingRequests) {
          clearTimeout(pending.timeout);
          pending.reject(closeError);
          this.pendingRequests.delete(id);
        }

        // Reject pending uploads
        for (const [id, pending] of this.pendingUploads) {
          pending.reject(closeError);
          this.pendingUploads.delete(id);
        }

        // Notify subscriptions
        for (const handlers of this.subscriptions.values()) {
          handlers.onError?.(closeError);
          handlers.onClose?.();
        }
        this.subscriptions.clear();
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

      // Set up timeout
      const timeout = setTimeout(() => {
        if (this.connectionState !== "authenticated") {
          ws.close();
          this.connectionState = "failed";
          reject(new Error("Authentication timeout"));
        }
      }, 30000);

      // Wait for auth to complete
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
