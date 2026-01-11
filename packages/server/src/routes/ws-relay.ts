import type { HttpBindings } from "@hono/node-server";
import type {
  EncryptedEnvelope,
  RelayEvent,
  RelayRequest,
  RelayResponse,
  RelaySubscribe,
  RelayUnsubscribe,
  RelayUploadChunk,
  RelayUploadComplete,
  RelayUploadEnd,
  RelayUploadError,
  RelayUploadProgress,
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
  BinaryFormat,
  BinaryFrameError,
  decodeJsonFrame,
  // Binary framing utilities
  encodeJsonFrame,
  isBinaryData,
  isEncryptedEnvelope,
  isSrpClientHello,
  isSrpClientProof,
  isSrpSessionResume,
} from "@yep-anywhere/shared";
import type { Context, Hono } from "hono";
import type { WSContext, WSEvents } from "hono/ws";
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
  decrypt,
  deriveSecretboxKey,
  encrypt,
} from "../crypto/index.js";
import type {
  RemoteAccessService,
  RemoteSessionService,
} from "../remote-access/index.js";
import type { Supervisor } from "../supervisor/Supervisor.js";
import type { UploadManager } from "../uploads/manager.js";
import type { EventBus } from "../watcher/index.js";

// biome-ignore lint/suspicious/noExplicitAny: Complex third-party type from @hono/node-ws
type UpgradeWebSocketFn = (createEvents: (c: Context) => WSEvents) => any;

export interface WsRelayDeps {
  upgradeWebSocket: UpgradeWebSocketFn;
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
  /** Remote access service for SRP authentication (optional) */
  remoteAccessService?: RemoteAccessService;
  /** Remote session service for session persistence (optional) */
  remoteSessionService?: RemoteSessionService;
}

/** Connection authentication state */
type ConnectionAuthState =
  | "unauthenticated" // No SRP required (local mode) or waiting for hello
  | "srp_waiting_proof" // Sent challenge, waiting for proof
  | "authenticated"; // SRP complete, session key established

/** Per-connection state for secure connections */
interface ConnectionState {
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
  /** Whether client sent binary frames (respond with binary if true) */
  useBinaryFrames: boolean;
}

/** Tracks an active upload over WebSocket relay */
interface RelayUploadState {
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
 * Create WebSocket relay routes for Phase 2b/2c.
 *
 * This endpoint allows clients to send HTTP-like requests over WebSocket,
 * which are then routed to the existing Hono handlers and responses returned.
 *
 * Supports:
 * - request/response (Phase 2b)
 * - subscriptions for session and activity events (Phase 2c)
 */
/** Progress report interval in bytes (64KB) */
const PROGRESS_INTERVAL = 64 * 1024;

/**
 * Allowed origins for WebSocket connections.
 * Matches:
 * - localhost with any port (http/https)
 * - 127.0.0.1 with any port (http/https)
 * - LAN IPs (192.168.x.x, 10.x.x.x, 172.16-31.x.x)
 * - GitHub Pages (*.github.io)
 */
const ALLOWED_ORIGIN_PATTERNS = [
  /^https?:\/\/localhost(:\d+)?$/,
  /^https?:\/\/127\.0\.0\.1(:\d+)?$/,
  /^https?:\/\/192\.168\.\d{1,3}\.\d{1,3}(:\d+)?$/,
  /^https?:\/\/10\.\d{1,3}\.\d{1,3}\.\d{1,3}(:\d+)?$/,
  /^https?:\/\/172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}(:\d+)?$/,
  /^https:\/\/[\w-]+\.github\.io$/,
];

/**
 * Check if an origin is allowed for WebSocket connections.
 * Allows null/undefined origin (same-origin requests) and matches against allowed patterns.
 */
function isAllowedOrigin(origin: string | undefined): boolean {
  // No origin header means same-origin request (allowed)
  // Browsers send literal "null" string for about:blank, file://, etc.
  if (!origin || origin === "null") return true;
  // Check against allowed patterns
  return ALLOWED_ORIGIN_PATTERNS.some((pattern) => pattern.test(origin));
}

/**
 * Encryption-aware send function type.
 * Created per-connection, captures connection state for automatic encryption.
 */
type SendFn = (msg: YepMessage) => void;

/**
 * Create an encryption-aware send function for a connection.
 * Automatically encrypts messages when the connection is authenticated with a session key.
 * Uses binary frames when the client has sent binary frames (Phase 0 binary protocol).
 */
const createSendFn = (ws: WSContext, connState: ConnectionState): SendFn => {
  return (msg: YepMessage) => {
    if (connState.authState === "authenticated" && connState.sessionKey) {
      const plaintext = JSON.stringify(msg);
      const { nonce, ciphertext } = encrypt(plaintext, connState.sessionKey);
      const envelope: EncryptedEnvelope = {
        type: "encrypted",
        nonce,
        ciphertext,
      };
      ws.send(JSON.stringify(envelope));
    } else if (connState.useBinaryFrames) {
      // Client sent binary frames, respond with binary
      ws.send(encodeJsonFrame(msg));
    } else {
      // Text frame fallback (backwards compat)
      ws.send(JSON.stringify(msg));
    }
  };
};

export function createWsRelayRoutes(
  deps: WsRelayDeps,
): ReturnType<typeof deps.upgradeWebSocket> {
  const {
    upgradeWebSocket,
    app,
    baseUrl,
    supervisor,
    eventBus,
    uploadManager,
    remoteAccessService,
    remoteSessionService,
  } = deps;

  /**
   * Send a plaintext SRP message (always unencrypted during handshake).
   */
  const sendSrpMessage = (
    ws: WSContext,
    msg:
      | SrpServerChallenge
      | SrpServerVerify
      | SrpError
      | SrpSessionResumed
      | SrpSessionInvalid,
  ) => {
    ws.send(JSON.stringify(msg));
  };

  /**
   * Handle SRP session resume (reconnect with stored session).
   */
  const handleSrpResume = async (
    ws: WSContext,
    connState: ConnectionState,
    msg: SrpSessionResume,
  ): Promise<void> => {
    if (!remoteSessionService) {
      sendSrpMessage(ws, {
        type: "srp_invalid",
        reason: "unknown",
      });
      return;
    }

    try {
      // Validate the proof and get the session
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

      // Verify the identity matches
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

      // Restore session state
      connState.sessionKey = Buffer.from(session.sessionKey, "base64");
      connState.authState = "authenticated";
      connState.username = session.username;
      connState.sessionId = session.sessionId;

      // Send success response
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
  };

  /**
   * Handle a RelayRequest by routing it through the Hono app.
   */
  const handleRequest = async (
    request: RelayRequest,
    send: SendFn,
  ): Promise<void> => {
    try {
      // Build the full URL
      const url = new URL(request.path, baseUrl);

      // Build headers
      const headers = new Headers(request.headers);
      // Add the custom header required by security middleware
      headers.set("X-Yep-Anywhere", "true");
      // Mark as coming from WebSocket relay for debugging
      headers.set("X-Ws-Relay", "true");
      if (request.body !== undefined) {
        headers.set("Content-Type", "application/json");
      }

      // Build the fetch request
      const fetchInit: RequestInit = {
        method: request.method,
        headers,
      };

      // Add body for methods that support it
      if (
        request.body !== undefined &&
        request.method !== "GET" &&
        request.method !== "DELETE"
      ) {
        fetchInit.body = JSON.stringify(request.body);
      }

      // Create a Request object
      const fetchRequest = new Request(url.toString(), fetchInit);

      // Route through Hono app's fetch handler
      const response = await app.fetch(fetchRequest);

      // Parse response body
      let body: unknown;
      const contentType = response.headers.get("Content-Type") ?? "";
      if (contentType.includes("application/json")) {
        try {
          body = await response.json();
        } catch {
          body = null;
        }
      } else {
        // For non-JSON responses, include the text
        const text = await response.text();
        body = text || null;
      }

      // Extract response headers we care about
      const responseHeaders: Record<string, string> = {};
      for (const [key, value] of response.headers.entries()) {
        // Only include relevant headers
        if (
          key.toLowerCase().startsWith("x-") ||
          key.toLowerCase() === "content-type" ||
          key.toLowerCase() === "etag"
        ) {
          responseHeaders[key] = value;
        }
      }

      // Send response
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
  };

  /**
   * Handle a session subscription.
   * Subscribes to process events, computes augments, and forwards them as RelayEvent messages.
   */
  const handleSessionSubscribe = (
    subscriptions: Map<string, () => void>,
    msg: RelaySubscribe,
    send: SendFn,
  ): void => {
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

    // Track current streaming message ID for text accumulation (for catch-up)
    let currentStreamingMessageId: string | null = null;

    // Helper to send a relay event
    const sendEvent = (eventType: string, data: unknown) => {
      send({
        type: "event",
        subscriptionId,
        eventType,
        eventId: String(eventId++),
        data,
      });
    };

    // Create stream augmenter lazily with WebSocket-specific emitters
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

    // Send initial connected event with current state
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

    // Replay buffered messages
    for (const message of process.getMessageHistory()) {
      send({
        type: "event",
        subscriptionId,
        eventType: "message",
        eventId: String(eventId++),
        data: markSubagent(message),
      });
    }

    // Catch-up: send accumulated streaming text as pending HTML for late-joining clients
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

    // Set up heartbeat
    const heartbeatInterval = setInterval(() => {
      try {
        sendEvent("heartbeat", { timestamp: new Date().toISOString() });
      } catch {
        clearInterval(heartbeatInterval);
      }
    }, 30000);

    // Subscribe to process events
    const unsubscribe = process.subscribe(async (event) => {
      try {
        switch (event.type) {
          case "message": {
            const message = event.message as Record<string, unknown>;

            // Process all augments (Edit, Write, Read, ExitPlanMode, streaming markdown)
            // This mutates the message and emits markdown-augment/pending events
            const aug = await getAugmenter();
            await aug.processMessage(message);

            sendEvent("message", markSubagent(message));

            // Track message ID for text accumulation (for catch-up)
            // This ensures late-joining clients get streaming content
            const startMessageId =
              extractMessageIdFromStart(message) ??
              extractIdFromAssistant(message);
            if (startMessageId) {
              currentStreamingMessageId = startMessageId;
            }

            // Accumulate text for late-joining clients
            const textDelta =
              extractTextDelta(message) ?? extractTextFromAssistant(message);
            if (textDelta && currentStreamingMessageId) {
              process.accumulateStreamingText(
                currentStreamingMessageId,
                textDelta,
              );
            }

            // Clear accumulated text when streaming ends
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
            // Flush any remaining augments before completing
            if (augmenter) {
              await augmenter.flush();
            }
            sendEvent("complete", { timestamp: new Date().toISOString() });
            break;

          default:
            return; // Unknown event type, skip
        }
      } catch (err) {
        console.error("[WS Relay] Error sending session event:", err);
      }
    });

    // Store cleanup function
    subscriptions.set(subscriptionId, () => {
      clearInterval(heartbeatInterval);
      unsubscribe();
      // Clear streaming text accumulator to prevent stale catch-up data
      // This is important when client disconnects mid-stream
      if (currentStreamingMessageId) {
        process.clearStreamingText();
        currentStreamingMessageId = null;
      }
    });

    console.log(
      `[WS Relay] Subscribed to session ${sessionId} (${subscriptionId})`,
    );
  };

  /**
   * Handle an activity subscription.
   * Subscribes to event bus and forwards events as RelayEvent messages.
   */
  const handleActivitySubscribe = (
    subscriptions: Map<string, () => void>,
    msg: RelaySubscribe,
    send: SendFn,
  ): void => {
    const { subscriptionId } = msg;

    let eventId = 0;

    // Send initial connected event
    send({
      type: "event",
      subscriptionId,
      eventType: "connected",
      eventId: String(eventId++),
      data: { timestamp: new Date().toISOString() },
    });

    // Set up heartbeat
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

    // Subscribe to event bus
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

    // Store cleanup function
    subscriptions.set(subscriptionId, () => {
      clearInterval(heartbeatInterval);
      unsubscribe();
    });

    console.log(`[WS Relay] Subscribed to activity (${subscriptionId})`);
  };

  /**
   * Handle a subscribe message.
   */
  const handleSubscribe = (
    subscriptions: Map<string, () => void>,
    msg: RelaySubscribe,
    send: SendFn,
  ): void => {
    const { subscriptionId, channel } = msg;

    // Check if already subscribed with this ID
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
        handleSessionSubscribe(subscriptions, msg, send);
        break;

      case "activity":
        handleActivitySubscribe(subscriptions, msg, send);
        break;

      default:
        send({
          type: "response",
          id: subscriptionId,
          status: 400,
          body: { error: `Unknown channel: ${channel}` },
        });
    }
  };

  /**
   * Handle an unsubscribe message.
   */
  const handleUnsubscribe = (
    subscriptions: Map<string, () => void>,
    msg: RelayUnsubscribe,
  ): void => {
    const { subscriptionId } = msg;
    const cleanup = subscriptions.get(subscriptionId);
    if (cleanup) {
      cleanup();
      subscriptions.delete(subscriptionId);
      console.log(`[WS Relay] Unsubscribed (${subscriptionId})`);
    }
  };

  /**
   * Handle upload_start message.
   */
  const handleUploadStart = async (
    uploads: Map<string, RelayUploadState>,
    msg: RelayUploadStart,
    send: SendFn,
  ): Promise<void> => {
    const { uploadId, projectId, sessionId, filename, size, mimeType } = msg;

    // Check for duplicate upload ID
    if (uploads.has(uploadId)) {
      send({
        type: "upload_error",
        uploadId,
        error: "Upload ID already in use",
      });
      return;
    }

    try {
      // Start upload via UploadManager
      const { uploadId: serverUploadId } = await uploadManager.startUpload(
        projectId,
        sessionId,
        filename,
        size,
        mimeType,
      );

      // Track the upload state
      uploads.set(uploadId, {
        clientUploadId: uploadId,
        serverUploadId,
        expectedSize: size,
        bytesReceived: 0,
        lastProgressReport: 0,
      });

      // Send initial progress (0 bytes)
      send({ type: "upload_progress", uploadId, bytesReceived: 0 });

      console.log(
        `[WS Relay] Upload started: ${uploadId} (${filename}, ${size} bytes)`,
      );
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to start upload";
      send({ type: "upload_error", uploadId, error: message });
    }
  };

  /**
   * Handle upload_chunk message.
   */
  const handleUploadChunk = async (
    uploads: Map<string, RelayUploadState>,
    msg: RelayUploadChunk,
    send: SendFn,
  ): Promise<void> => {
    const { uploadId, offset, data } = msg;

    const state = uploads.get(uploadId);
    if (!state) {
      send({ type: "upload_error", uploadId, error: "Upload not found" });
      return;
    }

    // Validate offset matches expected position
    if (offset !== state.bytesReceived) {
      send({
        type: "upload_error",
        uploadId,
        error: `Invalid offset: expected ${state.bytesReceived}, got ${offset}`,
      });
      return;
    }

    try {
      // Decode base64 chunk
      const chunk = Buffer.from(data, "base64");

      // Write chunk to UploadManager
      const bytesReceived = await uploadManager.writeChunk(
        state.serverUploadId,
        chunk,
      );

      state.bytesReceived = bytesReceived;

      // Send progress update periodically (every 64KB)
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
      // Clean up failed upload
      uploads.delete(uploadId);
      try {
        await uploadManager.cancelUpload(state.serverUploadId);
      } catch {
        // Ignore cleanup errors
      }
    }
  };

  /**
   * Handle upload_end message.
   */
  const handleUploadEnd = async (
    uploads: Map<string, RelayUploadState>,
    msg: RelayUploadEnd,
    send: SendFn,
  ): Promise<void> => {
    const { uploadId } = msg;

    const state = uploads.get(uploadId);
    if (!state) {
      send({ type: "upload_error", uploadId, error: "Upload not found" });
      return;
    }

    try {
      // Complete the upload
      const file = await uploadManager.completeUpload(state.serverUploadId);

      // Remove from tracking
      uploads.delete(uploadId);

      // Send completion message
      send({ type: "upload_complete", uploadId, file });

      console.log(
        `[WS Relay] Upload complete: ${uploadId} (${file.size} bytes)`,
      );
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to complete upload";
      send({ type: "upload_error", uploadId, error: message });
      // Clean up failed upload
      uploads.delete(uploadId);
      try {
        await uploadManager.cancelUpload(state.serverUploadId);
      } catch {
        // Ignore cleanup errors
      }
    }
  };

  /**
   * Clean up all active uploads for a connection.
   */
  const cleanupUploads = async (
    uploads: Map<string, RelayUploadState>,
  ): Promise<void> => {
    for (const [clientId, state] of uploads) {
      try {
        await uploadManager.cancelUpload(state.serverUploadId);
        console.log(`[WS Relay] Cancelled upload on disconnect: ${clientId}`);
      } catch (err) {
        console.error(`[WS Relay] Error cancelling upload ${clientId}:`, err);
      }
    }
    uploads.clear();
  };

  /**
   * Handle SRP hello message (start of authentication).
   */
  const handleSrpHello = async (
    ws: WSContext,
    connState: ConnectionState,
    msg: SrpClientHello,
  ): Promise<void> => {
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
      // Create SRP session and generate challenge
      connState.srpSession = new SrpServerSession();
      connState.username = msg.identity;

      // Generate server's B value (client A comes later with the proof)
      const { B } = await connState.srpSession.generateChallenge(
        msg.identity,
        credentials.salt,
        credentials.verifier,
      );

      // Send challenge
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
  };

  /**
   * Handle SRP proof message (client proves knowledge of password).
   */
  const handleSrpProof = async (
    ws: WSContext,
    connState: ConnectionState,
    msg: SrpClientProof,
    clientA: string,
  ): Promise<void> => {
    if (!connState.srpSession || connState.authState !== "srp_waiting_proof") {
      sendSrpMessage(ws, {
        type: "srp_error",
        code: "server_error",
        message: "Unexpected proof message",
      });
      return;
    }

    try {
      // Verify client proof with client's A value
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

      // Get session key and derive secretbox key
      const rawKey = connState.srpSession.getSessionKey();
      if (!rawKey) {
        throw new Error("No session key after successful proof");
      }
      connState.sessionKey = deriveSecretboxKey(rawKey);
      connState.authState = "authenticated";

      // Create persistent session if session service is available
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

      // Send verification (with sessionId for session resumption)
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
  };

  /**
   * Handle incoming WebSocket messages.
   * Supports both text frames (JSON) and binary frames (format byte + payload).
   */
  const handleMessage = async (
    ws: WSContext,
    subscriptions: Map<string, () => void>,
    uploads: Map<string, RelayUploadState>,
    connState: ConnectionState,
    send: SendFn,
    data: unknown,
  ): Promise<void> => {
    // Parse message - handle both binary and text frames
    let parsed: unknown;

    if (isBinaryData(data)) {
      // Binary frame - decode format byte + payload
      try {
        const { format, payload } = (() => {
          // Convert Buffer to Uint8Array for consistent handling
          const bytes =
            data instanceof ArrayBuffer ? new Uint8Array(data) : data;
          if (bytes.length === 0) {
            throw new BinaryFrameError("Empty binary frame", "UNKNOWN_FORMAT");
          }
          const format = bytes[0] as number;
          // Validate format byte - only 0x01-0x03 are valid
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
          return { format, payload: bytes.slice(1) };
        })();

        // Mark client as using binary frames
        connState.useBinaryFrames = true;

        // Currently only support format 0x01 (JSON)
        if (format !== BinaryFormat.JSON) {
          console.warn(
            `[WS Relay] Unsupported binary format: 0x${format.toString(16).padStart(2, "0")} (only 0x01 supported in Phase 0)`,
          );
          // Send error response via the current send method
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

        // Decode UTF-8 JSON payload
        const decoder = new TextDecoder("utf-8", { fatal: true });
        const json = decoder.decode(payload);
        parsed = JSON.parse(json);
      } catch (err) {
        if (err instanceof BinaryFrameError) {
          console.warn(
            `[WS Relay] Binary frame error (${err.code}):`,
            err.message,
          );
          // For unknown format, close with appropriate error code
          if (err.code === "UNKNOWN_FORMAT") {
            ws.close(4002, err.message);
          }
        } else {
          console.warn("[WS Relay] Failed to decode binary frame:", err);
        }
        return;
      }
    } else if (typeof data === "string") {
      // Text frame - parse as JSON
      try {
        parsed = JSON.parse(data);
      } catch {
        console.warn("[WS Relay] Failed to parse message:", data);
        return;
      }
    } else {
      console.warn("[WS Relay] Ignoring unknown message type");
      return;
    }

    // Handle SRP messages first (always plaintext)
    // Session resume takes priority - try to resume before starting full SRP
    if (isSrpSessionResume(parsed)) {
      await handleSrpResume(ws, connState, parsed);
      return;
    }

    if (isSrpClientHello(parsed)) {
      // SRP hello - start authentication
      await handleSrpHello(ws, connState, parsed);
      return;
    }

    // Handle SRP proof (contains A and M1)
    if (isSrpClientProof(parsed)) {
      await handleSrpProof(ws, connState, parsed, parsed.A);
      return;
    }

    // Handle encrypted messages
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
      // Plaintext message (allowed in unauthenticated mode when remote access is disabled)
      if (
        remoteAccessService?.isEnabled() &&
        connState.authState !== "authenticated"
      ) {
        console.warn("[WS Relay] Received plaintext message but auth required");
        ws.close(4001, "Authentication required");
        return;
      }
      msg = parsed as RemoteClientMessage;
    }

    // Route by message type
    switch (msg.type) {
      case "request":
        await handleRequest(msg, send);
        break;

      case "subscribe":
        handleSubscribe(subscriptions, msg, send);
        break;

      case "unsubscribe":
        handleUnsubscribe(subscriptions, msg);
        break;

      case "upload_start":
        await handleUploadStart(uploads, msg, send);
        break;

      case "upload_chunk":
        await handleUploadChunk(uploads, msg, send);
        break;

      case "upload_end":
        await handleUploadEnd(uploads, msg, send);
        break;

      default:
        console.warn(
          "[WS Relay] Unknown message type:",
          (msg as { type?: string }).type,
        );
    }
  };

  // Return the WebSocket handler with origin validation
  return upgradeWebSocket((c) => {
    // Check origin before upgrading
    const origin = c.req.header("origin");
    if (!isAllowedOrigin(origin)) {
      console.warn(`[WS Relay] Rejected connection from origin: ${origin}`);
      // Return empty handlers - connection will be closed immediately
      return {
        onOpen(_evt, ws) {
          ws.close(4003, "Forbidden: Invalid origin");
        },
      };
    }

    // Track active subscriptions for this connection
    const subscriptions = new Map<string, () => void>();
    // Track active uploads for this connection
    const uploads = new Map<string, RelayUploadState>();
    // Message queue to serialize async message handling
    let messageQueue: Promise<void> = Promise.resolve();
    // Connection state for SRP authentication
    const connState: ConnectionState = {
      srpSession: null,
      sessionKey: null,
      authState: "unauthenticated",
      username: null,
      sessionId: null,
      useBinaryFrames: false,
    };
    // Encryption-aware send function (created on open, captures connState)
    let send: SendFn;

    return {
      onOpen(_evt, ws) {
        console.log("[WS Relay] Client connected");
        // Create the send function that captures this connection's state
        send = createSendFn(ws, connState);
        // If remote access is not enabled, allow unauthenticated connections
        if (!remoteAccessService?.isEnabled()) {
          // In local mode, connections are implicitly authenticated
          connState.authState = "authenticated";
        }
      },

      onMessage(evt, ws) {
        // Queue messages for sequential processing
        messageQueue = messageQueue.then(() =>
          handleMessage(
            ws,
            subscriptions,
            uploads,
            connState,
            send,
            evt.data,
          ).catch((err) => {
            console.error("[WS Relay] Unexpected error:", err);
          }),
        );
      },

      onClose(_evt, _ws) {
        // Clean up all uploads
        cleanupUploads(uploads).catch((err) => {
          console.error("[WS Relay] Error cleaning up uploads:", err);
        });

        // Clean up all subscriptions
        for (const [id, cleanup] of subscriptions) {
          try {
            cleanup();
          } catch (err) {
            console.error(
              `[WS Relay] Error cleaning up subscription ${id}:`,
              err,
            );
          }
        }
        subscriptions.clear();
        console.log("[WS Relay] Client disconnected");
      },

      onError(evt, _ws) {
        console.error("[WS Relay] WebSocket error:", evt);
      },
    };
  });
}
