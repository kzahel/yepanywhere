/**
 * Shared WebSocket relay handler logic.
 *
 * This module contains the core message handling logic used by both:
 * - createWsRelayRoutes (Hono's upgradeWebSocket for direct connections)
 * - createAcceptRelayConnection (raw WebSocket for relay connections)
 *
 * The handlers are parameterized by dependencies and connection state,
 * allowing both entry points to share the same implementation.
 */

import type { HttpBindings } from "@hono/node-server";
import type {
  BinaryFormatValue,
  EncryptedEnvelope,
  RelayRequest,
  RelaySubscribe,
  RelayUnsubscribe,
  RelayUploadChunk,
  RelayUploadEnd,
  RelayUploadStart,
  RemoteClientMessage,
  SrpClientHello,
  SrpClientProof,
  SrpError,
  SrpServerChallenge,
  SrpServerVerify,
  SrpSessionInvalid,
  SrpSessionResume,
  SrpSessionResumed,
  YepMessage,
} from "@yep-anywhere/shared";
import {
  BinaryEnvelopeError,
  BinaryFormat,
  BinaryFrameError,
  MIN_BINARY_ENVELOPE_LENGTH,
  UploadChunkError,
  decodeUploadChunkPayload,
  encodeJsonFrame,
  isBinaryData,
  isClientCapabilities,
  isEncryptedEnvelope,
  isSrpClientHello,
  isSrpClientProof,
  isSrpSessionResume,
} from "@yep-anywhere/shared";
import type { Hono } from "hono";
import {
  type StreamAugmenter,
  createStreamAugmenter,
  extractIdFromAssistant,
  extractMessageIdFromStart,
  extractTextDelta,
  extractTextFromAssistant,
  isStreamingComplete,
  markSubagent,
} from "../augments/index.js";
import {
  SrpServerSession,
  decompressGzip,
  decrypt,
  decryptBinaryEnvelopeRaw,
  deriveSecretboxKey,
  encrypt,
  encryptToBinaryEnvelopeWithCompression,
} from "../crypto/index.js";
import type {
  RemoteAccessService,
  RemoteSessionService,
} from "../remote-access/index.js";
import type { ConnectedBrowsersService } from "../services/index.js";
import type { Supervisor } from "../supervisor/Supervisor.js";
import type { UploadManager } from "../uploads/manager.js";
import type { EventBus } from "../watcher/index.js";

/** Progress report interval in bytes (64KB) */
export const PROGRESS_INTERVAL = 64 * 1024;

/** Connection authentication state */
export type ConnectionAuthState =
  | "unauthenticated" // No SRP required (local mode) or waiting for hello
  | "srp_waiting_proof" // Sent challenge, waiting for proof
  | "authenticated"; // SRP complete, session key established

/** Per-connection state for secure connections */
export interface ConnectionState {
  /** SRP session during handshake */
  srpSession: SrpServerSession | null;
  /** Derived secretbox key (32 bytes) for encryption */
  sessionKey: Uint8Array | null;
  /** Authentication state */
  authState: ConnectionAuthState;
  /** Username if authenticated */
  username: string | null;
  /** Persistent session ID for resumption (set after successful auth) */
  sessionId: string | null;
  /** Whether client sent binary frames (respond with binary if true) - Phase 0 */
  useBinaryFrames: boolean;
  /** Whether client sent binary encrypted frames (respond with binary encrypted if true) - Phase 1 */
  useBinaryEncrypted: boolean;
  /** Client's supported binary formats (Phase 3 capabilities) - defaults to [0x01] */
  supportedFormats: Set<BinaryFormatValue>;
}

/** Tracks an active upload over WebSocket relay */
export interface RelayUploadState {
  /** Client-provided upload ID */
  clientUploadId: string;
  /** Server-generated upload ID from UploadManager */
  serverUploadId: string;
  /** Expected total size */
  expectedSize: number;
  /** Bytes received (for offset validation) */
  bytesReceived: number;
  /** Last progress report sent */
  lastProgressReport: number;
}

/**
 * Adapter interface for WebSocket send/close operations.
 * Both Hono's WSContext and raw ws.WebSocket can be adapted to this interface.
 * Note: Hono's WSContext.send uses Uint8Array<ArrayBuffer> (not ArrayBufferLike)
 */
export interface WSAdapter {
  send(data: string | ArrayBuffer | Uint8Array<ArrayBuffer>): void;
  close(code?: number, reason?: string): void;
}

/**
 * Encryption-aware send function type.
 * Created per-connection, captures connection state for automatic encryption.
 */
export type SendFn = (msg: YepMessage) => void;

/**
 * Dependencies for relay handlers.
 */
export interface RelayHandlerDeps {
  /** The main Hono app to route requests through */
  app: Hono<{ Bindings: HttpBindings }>;
  /** Base URL for internal requests (e.g., "http://localhost:3400") */
  baseUrl: string;
  /** Supervisor for subscribing to session events */
  supervisor: Supervisor;
  /** Event bus for subscribing to activity events */
  eventBus: EventBus;
  /** Upload manager for handling file uploads */
  uploadManager: UploadManager;
  /** Remote access service for SRP authentication (optional for direct, required for relay) */
  remoteAccessService?: RemoteAccessService;
  /** Remote session service for session persistence (optional for direct, required for relay) */
  remoteSessionService?: RemoteSessionService;
  /** Connected browsers service for tracking WS connections (optional) */
  connectedBrowsers?: ConnectedBrowsersService;
}

/**
 * Create an initial connection state.
 */
export function createConnectionState(): ConnectionState {
  return {
    srpSession: null,
    sessionKey: null,
    authState: "unauthenticated",
    username: null,
    sessionId: null,
    useBinaryFrames: false,
    useBinaryEncrypted: false,
    supportedFormats: new Set([BinaryFormat.JSON]),
  };
}

/**
 * Create an encryption-aware send function for a connection.
 * Automatically encrypts messages when the connection is authenticated with a session key.
 * Uses binary frames when the client has sent binary frames (Phase 0/1 binary protocol).
 * Compresses large payloads when client supports format 0x03 (Phase 3).
 */
export function createSendFn(
  ws: WSAdapter,
  connState: ConnectionState,
): SendFn {
  return (msg: YepMessage) => {
    if (connState.authState === "authenticated" && connState.sessionKey) {
      const plaintext = JSON.stringify(msg);

      if (connState.useBinaryEncrypted) {
        // Phase 1/3: Binary encrypted envelope with optional compression
        const supportsCompression = connState.supportedFormats.has(
          BinaryFormat.COMPRESSED_JSON,
        );
        const envelope = encryptToBinaryEnvelopeWithCompression(
          plaintext,
          connState.sessionKey,
          supportsCompression,
        );
        ws.send(envelope);
      } else {
        // Legacy: JSON encrypted envelope
        const { nonce, ciphertext } = encrypt(plaintext, connState.sessionKey);
        const envelope: EncryptedEnvelope = {
          type: "encrypted",
          nonce,
          ciphertext,
        };
        ws.send(JSON.stringify(envelope));
      }
    } else if (connState.useBinaryFrames) {
      // Client sent binary frames, respond with binary
      ws.send(encodeJsonFrame(msg));
    } else {
      // Text frame fallback (backwards compat)
      ws.send(JSON.stringify(msg));
    }
  };
}

/**
 * Send a plaintext SRP message (always unencrypted during handshake).
 */
export function sendSrpMessage(
  ws: WSAdapter,
  msg:
    | SrpServerChallenge
    | SrpServerVerify
    | SrpError
    | SrpSessionResumed
    | SrpSessionInvalid,
): void {
  ws.send(JSON.stringify(msg));
}

/**
 * Handle SRP session resume (reconnect with stored session).
 */
export async function handleSrpResume(
  ws: WSAdapter,
  connState: ConnectionState,
  msg: SrpSessionResume,
  remoteSessionService: RemoteSessionService | undefined,
): Promise<void> {
  if (!remoteSessionService) {
    sendSrpMessage(ws, {
      type: "srp_invalid",
      reason: "unknown",
    });
    return;
  }

  try {
    const session = await remoteSessionService.validateProof(
      msg.sessionId,
      msg.proof,
    );

    if (!session) {
      console.log(
        `[WS Relay] Session resume failed for ${msg.identity}: invalid or expired`,
      );
      sendSrpMessage(ws, {
        type: "srp_invalid",
        reason: "invalid_proof",
      });
      return;
    }

    if (session.username !== msg.identity) {
      console.warn(
        `[WS Relay] Session resume identity mismatch: ${msg.identity} vs ${session.username}`,
      );
      sendSrpMessage(ws, {
        type: "srp_invalid",
        reason: "invalid_proof",
      });
      return;
    }

    connState.sessionKey = Buffer.from(session.sessionKey, "base64");
    connState.authState = "authenticated";
    connState.username = session.username;
    connState.sessionId = session.sessionId;

    sendSrpMessage(ws, {
      type: "srp_resumed",
      sessionId: session.sessionId,
    });

    console.log(
      `[WS Relay] Session resumed for ${msg.identity} (${msg.sessionId})`,
    );
  } catch (err) {
    console.error("[WS Relay] Session resume error:", err);
    sendSrpMessage(ws, {
      type: "srp_invalid",
      reason: "unknown",
    });
  }
}

/**
 * Handle a RelayRequest by routing it through the Hono app.
 */
export async function handleRequest(
  request: RelayRequest,
  send: SendFn,
  app: Hono<{ Bindings: HttpBindings }>,
  baseUrl: string,
): Promise<void> {
  try {
    const url = new URL(request.path, baseUrl);
    const headers = new Headers(request.headers);
    headers.set("X-Yep-Anywhere", "true");
    headers.set("X-Ws-Relay", "true");
    if (request.body !== undefined) {
      headers.set("Content-Type", "application/json");
    }

    const fetchInit: RequestInit = {
      method: request.method,
      headers,
    };

    if (
      request.body !== undefined &&
      request.method !== "GET" &&
      request.method !== "DELETE"
    ) {
      fetchInit.body = JSON.stringify(request.body);
    }

    const fetchRequest = new Request(url.toString(), fetchInit);
    const response = await app.fetch(fetchRequest);

    let body: unknown;
    const contentType = response.headers.get("Content-Type") ?? "";
    if (contentType.includes("application/json")) {
      try {
        body = await response.json();
      } catch {
        body = null;
      }
    } else {
      const text = await response.text();
      body = text || null;
    }

    const responseHeaders: Record<string, string> = {};
    for (const [key, value] of response.headers.entries()) {
      if (
        key.toLowerCase().startsWith("x-") ||
        key.toLowerCase() === "content-type" ||
        key.toLowerCase() === "etag"
      ) {
        responseHeaders[key] = value;
      }
    }

    send({
      type: "response",
      id: request.id,
      status: response.status,
      headers:
        Object.keys(responseHeaders).length > 0 ? responseHeaders : undefined,
      body,
    });
  } catch (err) {
    console.error("[WS Relay] Request error:", err);
    send({
      type: "response",
      id: request.id,
      status: 500,
      body: { error: "Internal server error" },
    });
  }
}

/**
 * Handle a session subscription.
 * Subscribes to process events, computes augments, and forwards them as RelayEvent messages.
 */
export function handleSessionSubscribe(
  subscriptions: Map<string, () => void>,
  msg: RelaySubscribe,
  send: SendFn,
  supervisor: Supervisor,
): void {
  const { subscriptionId, sessionId } = msg;

  if (!sessionId) {
    send({
      type: "response",
      id: subscriptionId,
      status: 400,
      body: { error: "sessionId required for session channel" },
    });
    return;
  }

  const process = supervisor.getProcessForSession(sessionId);
  if (!process) {
    send({
      type: "response",
      id: subscriptionId,
      status: 404,
      body: { error: "No active process for session" },
    });
    return;
  }

  let eventId = 0;
  let currentStreamingMessageId: string | null = null;

  const sendEvent = (eventType: string, data: unknown) => {
    send({
      type: "event",
      subscriptionId,
      eventType,
      eventId: String(eventId++),
      data,
    });
  };

  let augmenter: StreamAugmenter | null = null;
  let augmenterPromise: Promise<StreamAugmenter> | null = null;

  const getAugmenter = async (): Promise<StreamAugmenter> => {
    if (augmenter) return augmenter;
    if (!augmenterPromise) {
      augmenterPromise = createStreamAugmenter({
        onMarkdownAugment: (data) => {
          sendEvent("markdown-augment", data);
        },
        onPending: (data) => {
          sendEvent("pending", data);
        },
        onError: (err, context) => {
          console.warn(`[WS Relay] ${context}:`, err);
        },
      });
    }
    augmenter = await augmenterPromise;
    return augmenter;
  };

  const currentState = process.state;
  send({
    type: "event",
    subscriptionId,
    eventType: "connected",
    eventId: String(eventId++),
    data: {
      processId: process.id,
      sessionId: process.sessionId,
      state: currentState.type,
      permissionMode: process.permissionMode,
      modeVersion: process.modeVersion,
      provider: process.provider,
      model: process.model,
      ...(currentState.type === "waiting-input"
        ? { request: currentState.request }
        : {}),
    },
  });

  for (const message of process.getMessageHistory()) {
    send({
      type: "event",
      subscriptionId,
      eventType: "message",
      eventId: String(eventId++),
      data: markSubagent(message),
    });
  }

  const streamingContent = process.getStreamingContent();
  if (streamingContent) {
    getAugmenter()
      .then(async (aug) => {
        await aug.processCatchUp(
          streamingContent.text,
          streamingContent.messageId,
        );
      })
      .catch((err) => {
        console.warn("[WS Relay] Failed to send catch-up pending HTML:", err);
      });
  }

  const heartbeatInterval = setInterval(() => {
    try {
      sendEvent("heartbeat", { timestamp: new Date().toISOString() });
    } catch {
      clearInterval(heartbeatInterval);
    }
  }, 30000);

  const unsubscribe = process.subscribe(async (event) => {
    try {
      switch (event.type) {
        case "message": {
          const message = event.message as Record<string, unknown>;
          const aug = await getAugmenter();
          await aug.processMessage(message);
          sendEvent("message", markSubagent(message));

          const startMessageId =
            extractMessageIdFromStart(message) ??
            extractIdFromAssistant(message);
          if (startMessageId) {
            currentStreamingMessageId = startMessageId;
          }

          const textDelta =
            extractTextDelta(message) ?? extractTextFromAssistant(message);
          if (textDelta && currentStreamingMessageId) {
            process.accumulateStreamingText(
              currentStreamingMessageId,
              textDelta,
            );
          }

          if (isStreamingComplete(message)) {
            currentStreamingMessageId = null;
            process.clearStreamingText();
          }
          break;
        }

        case "state-change":
          sendEvent("status", {
            state: event.state.type,
            ...(event.state.type === "waiting-input"
              ? { request: event.state.request }
              : {}),
          });
          break;

        case "mode-change":
          sendEvent("mode-change", {
            permissionMode: event.mode,
            modeVersion: event.version,
          });
          break;

        case "error":
          sendEvent("error", { message: event.error.message });
          break;

        case "claude-login":
          sendEvent("claude-login", event.event);
          break;

        case "session-id-changed":
          sendEvent("session-id-changed", {
            oldSessionId: event.oldSessionId,
            newSessionId: event.newSessionId,
          });
          break;

        case "complete":
          if (augmenter) {
            await augmenter.flush();
          }
          sendEvent("complete", { timestamp: new Date().toISOString() });
          break;

        default:
          return;
      }
    } catch (err) {
      console.error("[WS Relay] Error sending session event:", err);
    }
  });

  subscriptions.set(subscriptionId, () => {
    clearInterval(heartbeatInterval);
    unsubscribe();
    if (currentStreamingMessageId) {
      process.clearStreamingText();
      currentStreamingMessageId = null;
    }
  });

  console.log(
    `[WS Relay] Subscribed to session ${sessionId} (${subscriptionId})`,
  );
}

/**
 * Handle an activity subscription.
 * Subscribes to event bus and forwards events as RelayEvent messages.
 */
export function handleActivitySubscribe(
  subscriptions: Map<string, () => void>,
  msg: RelaySubscribe,
  send: SendFn,
  eventBus: EventBus,
  connectedBrowsers?: ConnectedBrowsersService,
): void {
  const { subscriptionId, deviceId } = msg;

  // Track connection if we have the service and a deviceId
  let connectionId: number | undefined;
  if (connectedBrowsers && deviceId) {
    connectionId = connectedBrowsers.connect(deviceId, "ws");
  }

  let eventId = 0;

  send({
    type: "event",
    subscriptionId,
    eventType: "connected",
    eventId: String(eventId++),
    data: { timestamp: new Date().toISOString() },
  });

  const heartbeatInterval = setInterval(() => {
    try {
      send({
        type: "event",
        subscriptionId,
        eventType: "heartbeat",
        eventId: String(eventId++),
        data: { timestamp: new Date().toISOString() },
      });
    } catch {
      clearInterval(heartbeatInterval);
    }
  }, 30000);

  const unsubscribe = eventBus.subscribe((event) => {
    try {
      send({
        type: "event",
        subscriptionId,
        eventType: event.type,
        eventId: String(eventId++),
        data: event,
      });
    } catch (err) {
      console.error("[WS Relay] Error sending activity event:", err);
    }
  });

  subscriptions.set(subscriptionId, () => {
    clearInterval(heartbeatInterval);
    unsubscribe();
    // Disconnect from connectedBrowsers when unsubscribing
    if (connectionId !== undefined && connectedBrowsers) {
      connectedBrowsers.disconnect(connectionId);
    }
  });

  console.log(`[WS Relay] Subscribed to activity (${subscriptionId})`);
}

/**
 * Handle a subscribe message.
 */
export function handleSubscribe(
  subscriptions: Map<string, () => void>,
  msg: RelaySubscribe,
  send: SendFn,
  supervisor: Supervisor,
  eventBus: EventBus,
  connectedBrowsers?: ConnectedBrowsersService,
): void {
  const { subscriptionId, channel } = msg;

  if (subscriptions.has(subscriptionId)) {
    send({
      type: "response",
      id: subscriptionId,
      status: 400,
      body: { error: "Subscription ID already in use" },
    });
    return;
  }

  switch (channel) {
    case "session":
      handleSessionSubscribe(subscriptions, msg, send, supervisor);
      break;

    case "activity":
      handleActivitySubscribe(
        subscriptions,
        msg,
        send,
        eventBus,
        connectedBrowsers,
      );
      break;

    default:
      send({
        type: "response",
        id: subscriptionId,
        status: 400,
        body: { error: `Unknown channel: ${channel}` },
      });
  }
}

/**
 * Handle an unsubscribe message.
 */
export function handleUnsubscribe(
  subscriptions: Map<string, () => void>,
  msg: RelayUnsubscribe,
): void {
  const { subscriptionId } = msg;
  const cleanup = subscriptions.get(subscriptionId);
  if (cleanup) {
    cleanup();
    subscriptions.delete(subscriptionId);
    console.log(`[WS Relay] Unsubscribed (${subscriptionId})`);
  }
}

/**
 * Handle upload_start message.
 */
export async function handleUploadStart(
  uploads: Map<string, RelayUploadState>,
  msg: RelayUploadStart,
  send: SendFn,
  uploadManager: UploadManager,
): Promise<void> {
  const { uploadId, projectId, sessionId, filename, size, mimeType } = msg;

  if (uploads.has(uploadId)) {
    send({
      type: "upload_error",
      uploadId,
      error: "Upload ID already in use",
    });
    return;
  }

  try {
    const { uploadId: serverUploadId } = await uploadManager.startUpload(
      projectId,
      sessionId,
      filename,
      size,
      mimeType,
    );

    uploads.set(uploadId, {
      clientUploadId: uploadId,
      serverUploadId,
      expectedSize: size,
      bytesReceived: 0,
      lastProgressReport: 0,
    });

    send({ type: "upload_progress", uploadId, bytesReceived: 0 });

    console.log(
      `[WS Relay] Upload started: ${uploadId} (${filename}, ${size} bytes)`,
    );
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to start upload";
    send({ type: "upload_error", uploadId, error: message });
  }
}

/**
 * Handle upload_chunk message.
 */
export async function handleUploadChunk(
  uploads: Map<string, RelayUploadState>,
  msg: RelayUploadChunk,
  send: SendFn,
  uploadManager: UploadManager,
): Promise<void> {
  const { uploadId, offset, data } = msg;

  const state = uploads.get(uploadId);
  if (!state) {
    send({ type: "upload_error", uploadId, error: "Upload not found" });
    return;
  }

  if (offset !== state.bytesReceived) {
    send({
      type: "upload_error",
      uploadId,
      error: `Invalid offset: expected ${state.bytesReceived}, got ${offset}`,
    });
    return;
  }

  try {
    const chunk = Buffer.from(data, "base64");
    const bytesReceived = await uploadManager.writeChunk(
      state.serverUploadId,
      chunk,
    );

    state.bytesReceived = bytesReceived;

    if (
      bytesReceived - state.lastProgressReport >= PROGRESS_INTERVAL ||
      bytesReceived === state.expectedSize
    ) {
      send({ type: "upload_progress", uploadId, bytesReceived });
      state.lastProgressReport = bytesReceived;
    }
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to write chunk";
    send({ type: "upload_error", uploadId, error: message });
    uploads.delete(uploadId);
    try {
      await uploadManager.cancelUpload(state.serverUploadId);
    } catch {
      // Ignore cleanup errors
    }
  }
}

/**
 * Handle binary upload chunk (format 0x02).
 * Payload format: [16 bytes UUID][8 bytes offset big-endian][chunk data]
 */
export async function handleBinaryUploadChunk(
  uploads: Map<string, RelayUploadState>,
  payload: Uint8Array,
  send: SendFn,
  uploadManager: UploadManager,
): Promise<void> {
  let uploadId: string;
  let offset: number;
  let data: Uint8Array;
  try {
    ({ uploadId, offset, data } = decodeUploadChunkPayload(payload));
  } catch (e) {
    const message =
      e instanceof UploadChunkError
        ? `Invalid upload chunk: ${e.message}`
        : "Invalid binary upload chunk format";
    console.warn(`[WS Relay] ${message}`, e);
    send({
      type: "response",
      id: "binary-upload-error",
      status: 400,
      body: { error: message },
    });
    return;
  }

  const state = uploads.get(uploadId);
  if (!state) {
    send({ type: "upload_error", uploadId, error: "Upload not found" });
    return;
  }

  if (offset !== state.bytesReceived) {
    send({
      type: "upload_error",
      uploadId,
      error: `Invalid offset: expected ${state.bytesReceived}, got ${offset}`,
    });
    return;
  }

  try {
    const bytesReceived = await uploadManager.writeChunk(
      state.serverUploadId,
      Buffer.from(data),
    );

    state.bytesReceived = bytesReceived;

    if (
      bytesReceived - state.lastProgressReport >= PROGRESS_INTERVAL ||
      bytesReceived === state.expectedSize
    ) {
      send({ type: "upload_progress", uploadId, bytesReceived });
      state.lastProgressReport = bytesReceived;
    }
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to write chunk";
    send({ type: "upload_error", uploadId, error: message });
    uploads.delete(uploadId);
    try {
      await uploadManager.cancelUpload(state.serverUploadId);
    } catch {
      // Ignore cleanup errors
    }
  }
}

/**
 * Handle upload_end message.
 */
export async function handleUploadEnd(
  uploads: Map<string, RelayUploadState>,
  msg: RelayUploadEnd,
  send: SendFn,
  uploadManager: UploadManager,
): Promise<void> {
  const { uploadId } = msg;

  const state = uploads.get(uploadId);
  if (!state) {
    send({ type: "upload_error", uploadId, error: "Upload not found" });
    return;
  }

  try {
    const file = await uploadManager.completeUpload(state.serverUploadId);
    uploads.delete(uploadId);
    send({ type: "upload_complete", uploadId, file });
    console.log(`[WS Relay] Upload complete: ${uploadId} (${file.size} bytes)`);
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to complete upload";
    send({ type: "upload_error", uploadId, error: message });
    uploads.delete(uploadId);
    try {
      await uploadManager.cancelUpload(state.serverUploadId);
    } catch {
      // Ignore cleanup errors
    }
  }
}

/**
 * Clean up all active uploads for a connection.
 */
export async function cleanupUploads(
  uploads: Map<string, RelayUploadState>,
  uploadManager: UploadManager,
): Promise<void> {
  for (const [clientId, state] of uploads) {
    try {
      await uploadManager.cancelUpload(state.serverUploadId);
      console.log(`[WS Relay] Cancelled upload on disconnect: ${clientId}`);
    } catch (err) {
      console.error(`[WS Relay] Error cancelling upload ${clientId}:`, err);
    }
  }
  uploads.clear();
}

/**
 * Handle SRP hello message (start of authentication).
 */
export async function handleSrpHello(
  ws: WSAdapter,
  connState: ConnectionState,
  msg: SrpClientHello,
  remoteAccessService: RemoteAccessService | undefined,
): Promise<void> {
  if (!remoteAccessService) {
    sendSrpMessage(ws, {
      type: "srp_error",
      code: "server_error",
      message: "Remote access not configured",
    });
    return;
  }

  const credentials = remoteAccessService.getCredentials();
  if (!credentials) {
    sendSrpMessage(ws, {
      type: "srp_error",
      code: "invalid_identity",
      message: "Remote access not configured",
    });
    return;
  }

  const configuredUsername = remoteAccessService.getUsername();
  if (msg.identity !== configuredUsername) {
    sendSrpMessage(ws, {
      type: "srp_error",
      code: "invalid_identity",
      message: "Unknown identity",
    });
    return;
  }

  try {
    connState.srpSession = new SrpServerSession();
    connState.username = msg.identity;

    const { B } = await connState.srpSession.generateChallenge(
      msg.identity,
      credentials.salt,
      credentials.verifier,
    );

    const challenge: SrpServerChallenge = {
      type: "srp_challenge",
      salt: credentials.salt,
      B,
    };
    sendSrpMessage(ws, challenge);
    connState.authState = "srp_waiting_proof";

    console.log(`[WS Relay] SRP challenge sent for ${msg.identity}`);
  } catch (err) {
    console.error("[WS Relay] SRP hello error:", err);
    sendSrpMessage(ws, {
      type: "srp_error",
      code: "server_error",
      message: "Authentication failed",
    });
  }
}

/**
 * Handle SRP proof message (client proves knowledge of password).
 */
export async function handleSrpProof(
  ws: WSAdapter,
  connState: ConnectionState,
  msg: SrpClientProof,
  clientA: string,
  remoteSessionService: RemoteSessionService | undefined,
): Promise<void> {
  if (!connState.srpSession || connState.authState !== "srp_waiting_proof") {
    sendSrpMessage(ws, {
      type: "srp_error",
      code: "server_error",
      message: "Unexpected proof message",
    });
    return;
  }

  try {
    const result = await connState.srpSession.verifyProof(clientA, msg.M1);

    if (!result) {
      console.warn(
        `[WS Relay] SRP authentication failed for ${connState.username}`,
      );
      sendSrpMessage(ws, {
        type: "srp_error",
        code: "invalid_proof",
        message: "Authentication failed",
      });
      connState.authState = "unauthenticated";
      connState.srpSession = null;
      return;
    }

    const rawKey = connState.srpSession.getSessionKey();
    if (!rawKey) {
      throw new Error("No session key after successful proof");
    }
    connState.sessionKey = deriveSecretboxKey(rawKey);
    connState.authState = "authenticated";

    let sessionId: string | undefined;
    console.log("[WS Relay] Session creation check:", {
      hasRemoteSessionService: !!remoteSessionService,
      hasUsername: !!connState.username,
      username: connState.username,
    });
    if (remoteSessionService && connState.username) {
      sessionId = await remoteSessionService.createSession(
        connState.username,
        connState.sessionKey,
      );
      connState.sessionId = sessionId;
      console.log("[WS Relay] Session created:", sessionId);
    }

    const verify: SrpServerVerify = {
      type: "srp_verify",
      M2: result.M2,
      sessionId,
    };
    sendSrpMessage(ws, verify);

    console.log(
      `[WS Relay] SRP authentication successful for ${connState.username}${sessionId ? ` (session: ${sessionId})` : ""}`,
    );
  } catch (err) {
    console.error("[WS Relay] SRP proof error:", err);
    sendSrpMessage(ws, {
      type: "srp_error",
      code: "server_error",
      message: "Authentication failed",
    });
    connState.authState = "unauthenticated";
    connState.srpSession = null;
  }
}

/**
 * Check if binary data looks like a binary encrypted envelope.
 * Binary envelope: [1 byte: version 0x01][24 bytes: nonce][ciphertext]
 * vs Phase 0 binary: [1 byte: format 0x01-0x03][payload]
 *
 * We can distinguish them because:
 * - Binary envelope starts with version 0x01 and is at least MIN_BINARY_ENVELOPE_LENGTH bytes
 * - Binary envelope is only valid when authenticated (has session key)
 * - Phase 0 format bytes 0x02-0x03 are clearly not version 0x01
 */
export function isBinaryEncryptedEnvelope(
  bytes: Uint8Array,
  connState: ConnectionState,
): boolean {
  // Must be authenticated with a session key to receive encrypted data
  if (connState.authState !== "authenticated" || !connState.sessionKey) {
    return false;
  }
  // Must be at least minimum envelope length
  if (bytes.length < MIN_BINARY_ENVELOPE_LENGTH) {
    return false;
  }
  // First byte must be version 0x01
  if (bytes[0] !== 0x01) {
    return false;
  }
  // For Phase 0 binary frames, a format byte 0x01 followed by valid JSON
  // typically starts with '{' (0x7B) or '[' (0x5B) at position 1.
  // For binary envelope, position 1-24 is the nonce (random bytes).
  // We use a heuristic: if bytes[1] is a printable ASCII char that starts JSON,
  // it's likely Phase 0 format. Otherwise, treat as binary envelope.
  const secondByte = bytes[1];
  if (secondByte === 0x7b || secondByte === 0x5b) {
    // '{' or '[' - likely Phase 0 JSON frame
    return false;
  }
  return true;
}

/**
 * Options for handleMessage that differ between direct and relay connections.
 */
export interface HandleMessageOptions {
  /** Whether remote access is enabled (for auth requirements) */
  requireAuth: boolean;
  /**
   * Whether the message was received as a binary frame.
   * If provided, this takes precedence over isBinaryData() check.
   * Required for raw ws connections where all data arrives as Buffers.
   */
  isBinary?: boolean;
}

/**
 * Handle incoming WebSocket messages.
 * Supports both text frames (JSON) and binary frames (format byte + payload or encrypted envelope).
 */
export async function handleMessage(
  ws: WSAdapter,
  subscriptions: Map<string, () => void>,
  uploads: Map<string, RelayUploadState>,
  connState: ConnectionState,
  send: SendFn,
  data: unknown,
  deps: RelayHandlerDeps,
  options: HandleMessageOptions,
): Promise<void> {
  const {
    app,
    baseUrl,
    supervisor,
    eventBus,
    uploadManager,
    remoteAccessService,
    remoteSessionService,
  } = deps;

  let parsed: unknown;

  // Debug: log incoming data type and preview
  // Check Buffer BEFORE Uint8Array since Buffer extends Uint8Array
  const dataType =
    data === null
      ? "null"
      : data === undefined
        ? "undefined"
        : typeof data === "string"
          ? `string(${data.length})`
          : Buffer.isBuffer(data)
            ? `Buffer(${data.length})`
            : data instanceof ArrayBuffer
              ? `ArrayBuffer(${data.byteLength})`
              : data instanceof Uint8Array
                ? `Uint8Array(${data.length})`
                : `unknown(${typeof data})`;
  const preview =
    typeof data === "string"
      ? data.slice(0, 100)
      : data instanceof Uint8Array || Buffer.isBuffer(data)
        ? `[${Array.from(data.slice(0, 20))
            .map((b) => b.toString(16).padStart(2, "0"))
            .join(" ")}...]`
        : String(data).slice(0, 100);
  console.log(
    `[WS Relay] handleMessage: type=${dataType}, isBinary=${options.isBinary}, preview=${preview}`,
  );

  // Determine if this is a binary frame.
  // If options.isBinary is provided (raw ws connections), use it directly.
  // Otherwise, fall back to checking if data is binary (Hono connections where
  // text frames arrive as strings and binary frames as ArrayBuffer).
  const isFrameBinary = options.isBinary ?? isBinaryData(data);

  if (isFrameBinary) {
    // For binary frames, data is ArrayBuffer (browser) or Buffer/Uint8Array (Node.js)
    // When options.isBinary is provided, data is guaranteed to be Buffer from raw ws
    let bytes: Uint8Array;
    if (data instanceof ArrayBuffer) {
      bytes = new Uint8Array(data);
    } else if (data instanceof Uint8Array || Buffer.isBuffer(data)) {
      bytes = data;
    } else {
      console.warn("[WS Relay] Binary frame has unexpected data type");
      return;
    }

    if (bytes.length === 0) {
      console.warn("[WS Relay] Empty binary frame");
      return;
    }

    if (isBinaryEncryptedEnvelope(bytes, connState) && connState.sessionKey) {
      try {
        const result = decryptBinaryEnvelopeRaw(bytes, connState.sessionKey);
        if (!result) {
          console.warn("[WS Relay] Failed to decrypt binary envelope");
          return;
        }

        const { format, payload } = result;
        connState.useBinaryEncrypted = true;

        if (format === BinaryFormat.BINARY_UPLOAD) {
          await handleBinaryUploadChunk(uploads, payload, send, uploadManager);
          return;
        }

        if (
          format !== BinaryFormat.JSON &&
          format !== BinaryFormat.COMPRESSED_JSON
        ) {
          const formatByte = format as number;
          console.warn(
            `[WS Relay] Unsupported encrypted format: 0x${formatByte.toString(16).padStart(2, "0")}`,
          );
          send({
            type: "response",
            id: "binary-format-error",
            status: 400,
            body: {
              error: `Unsupported binary format: 0x${formatByte.toString(16).padStart(2, "0")}`,
            },
          });
          return;
        }

        try {
          let jsonStr: string;
          if (format === BinaryFormat.COMPRESSED_JSON) {
            jsonStr = decompressGzip(payload);
          } else {
            jsonStr = new TextDecoder().decode(payload);
          }
          const msg = JSON.parse(jsonStr) as RemoteClientMessage;

          if (isClientCapabilities(msg)) {
            connState.supportedFormats = new Set(msg.formats);
            console.log(
              `[WS Relay] Client capabilities: formats=${[...connState.supportedFormats].map((f) => `0x${f.toString(16).padStart(2, "0")}`).join(", ")}`,
            );
            return;
          }

          await routeMessage(msg, subscriptions, uploads, send, deps);
          return;
        } catch {
          console.warn("[WS Relay] Failed to parse decrypted binary envelope");
          return;
        }
      } catch (err) {
        if (err instanceof BinaryEnvelopeError) {
          console.warn(
            `[WS Relay] Binary envelope error (${err.code}):`,
            err.message,
          );
          if (err.code === "UNKNOWN_VERSION") {
            ws.close(4002, err.message);
          }
        } else {
          console.warn("[WS Relay] Failed to process binary envelope:", err);
        }
        return;
      }
    }

    // Phase 0: Binary frame with format byte + payload
    try {
      const format = bytes[0] as number;
      if (
        format !== BinaryFormat.JSON &&
        format !== BinaryFormat.BINARY_UPLOAD &&
        format !== BinaryFormat.COMPRESSED_JSON
      ) {
        throw new BinaryFrameError(
          `Unknown format byte: 0x${format.toString(16).padStart(2, "0")}`,
          "UNKNOWN_FORMAT",
        );
      }
      const payload = bytes.slice(1);
      connState.useBinaryFrames = true;

      if (format === BinaryFormat.BINARY_UPLOAD) {
        await handleBinaryUploadChunk(uploads, payload, send, uploadManager);
        return;
      }

      if (format !== BinaryFormat.JSON) {
        console.warn(
          `[WS Relay] Unsupported binary format: 0x${format.toString(16).padStart(2, "0")}`,
        );
        send({
          type: "response",
          id: "binary-format-error",
          status: 400,
          body: {
            error: `Unsupported binary format: 0x${format.toString(16).padStart(2, "0")}`,
          },
        });
        return;
      }

      const decoder = new TextDecoder("utf-8", { fatal: true });
      const json = decoder.decode(payload);
      parsed = JSON.parse(json);
    } catch (err) {
      if (err instanceof BinaryFrameError) {
        console.warn(
          `[WS Relay] Binary frame error (${err.code}):`,
          err.message,
        );
        if (err.code === "UNKNOWN_FORMAT") {
          ws.close(4002, err.message);
        }
      } else {
        console.warn("[WS Relay] Failed to decode binary frame:", err);
      }
      return;
    }
  } else {
    // Text frame - could be string (Hono) or Buffer (raw ws with isBinary=false)
    let textData: string;
    if (typeof data === "string") {
      textData = data;
    } else if (data instanceof Uint8Array || Buffer.isBuffer(data)) {
      // Raw ws delivers text frames as Buffers, convert to string
      textData = Buffer.from(data).toString("utf-8");
    } else {
      console.warn("[WS Relay] Ignoring unknown message type");
      return;
    }
    try {
      parsed = JSON.parse(textData);
    } catch {
      console.warn("[WS Relay] Failed to parse message:", textData);
      return;
    }
  }

  // Handle SRP messages first (always plaintext)
  if (isSrpSessionResume(parsed)) {
    await handleSrpResume(ws, connState, parsed, remoteSessionService);
    return;
  }

  if (isSrpClientHello(parsed)) {
    await handleSrpHello(ws, connState, parsed, remoteAccessService);
    return;
  }

  if (isSrpClientProof(parsed)) {
    await handleSrpProof(ws, connState, parsed, parsed.A, remoteSessionService);
    return;
  }

  // Handle encrypted messages (JSON envelope format - legacy)
  let msg: RemoteClientMessage;
  if (isEncryptedEnvelope(parsed)) {
    if (connState.authState !== "authenticated" || !connState.sessionKey) {
      console.warn(
        "[WS Relay] Received encrypted message but not authenticated",
      );
      return;
    }
    const decrypted = decrypt(
      parsed.nonce,
      parsed.ciphertext,
      connState.sessionKey,
    );
    if (!decrypted) {
      console.warn("[WS Relay] Failed to decrypt message");
      return;
    }
    try {
      msg = JSON.parse(decrypted) as RemoteClientMessage;
    } catch {
      console.warn("[WS Relay] Failed to parse decrypted message");
      return;
    }
  } else {
    // Plaintext message - check auth requirements
    if (options.requireAuth && connState.authState !== "authenticated") {
      console.warn("[WS Relay] Received plaintext message but auth required");
      ws.close(4001, "Authentication required");
      return;
    }
    msg = parsed as RemoteClientMessage;
  }

  await routeMessage(msg, subscriptions, uploads, send, deps);
}

/**
 * Route a parsed message to the appropriate handler.
 */
async function routeMessage(
  msg: RemoteClientMessage,
  subscriptions: Map<string, () => void>,
  uploads: Map<string, RelayUploadState>,
  send: SendFn,
  deps: RelayHandlerDeps,
): Promise<void> {
  const {
    app,
    baseUrl,
    supervisor,
    eventBus,
    uploadManager,
    connectedBrowsers,
  } = deps;

  switch (msg.type) {
    case "request":
      await handleRequest(msg, send, app, baseUrl);
      break;

    case "subscribe":
      handleSubscribe(
        subscriptions,
        msg,
        send,
        supervisor,
        eventBus,
        connectedBrowsers,
      );
      break;

    case "unsubscribe":
      handleUnsubscribe(subscriptions, msg);
      break;

    case "upload_start":
      await handleUploadStart(uploads, msg, send, uploadManager);
      break;

    case "upload_chunk":
      await handleUploadChunk(uploads, msg, send, uploadManager);
      break;

    case "upload_end":
      await handleUploadEnd(uploads, msg, send, uploadManager);
      break;

    default:
      console.warn(
        "[WS Relay] Unknown message type:",
        (msg as { type?: string }).type,
      );
  }
}

/**
 * Clean up subscriptions on connection close.
 */
export function cleanupSubscriptions(
  subscriptions: Map<string, () => void>,
): void {
  for (const [id, cleanup] of subscriptions) {
    try {
      cleanup();
    } catch (err) {
      console.error(`[WS Relay] Error cleaning up subscription ${id}:`, err);
    }
  }
  subscriptions.clear();
}
