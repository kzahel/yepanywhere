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
  YepMessage,
} from "@yep-anywhere/shared";
import {
  isEncryptedEnvelope,
  isSrpClientHello,
  isSrpClientProof,
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
import type { RemoteAccessService } from "../remote-access/index.js";
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
  } = deps;

  /**
   * Send a plaintext message (used by all internal handlers).
   * Encryption is handled at the handler boundary.
   */
  const sendMessage = (ws: WSContext, msg: YepMessage) => {
    ws.send(JSON.stringify(msg));
  };

  /**
   * Send a message with optional encryption based on connection state.
   * Used at the handler boundary.
   */
  const sendEncrypted = (
    ws: WSContext,
    msg: YepMessage,
    connState: ConnectionState,
  ) => {
    if (connState.authState === "authenticated" && connState.sessionKey) {
      const plaintext = JSON.stringify(msg);
      const { nonce, ciphertext } = encrypt(plaintext, connState.sessionKey);
      const envelope: EncryptedEnvelope = {
        type: "encrypted",
        nonce,
        ciphertext,
      };
      ws.send(JSON.stringify(envelope));
    } else {
      ws.send(JSON.stringify(msg));
    }
  };

  /**
   * Send a plaintext SRP message (always unencrypted during handshake).
   */
  const sendSrpMessage = (
    ws: WSContext,
    msg: SrpServerChallenge | SrpServerVerify | SrpError,
  ) => {
    ws.send(JSON.stringify(msg));
  };

  const sendError = (
    ws: WSContext,
    requestId: string,
    status: number,
    message: string,
  ) => {
    const response: RelayResponse = {
      type: "response",
      id: requestId,
      status,
      body: { error: message },
    };
    sendMessage(ws, response);
  };

  const sendUploadProgress = (
    ws: WSContext,
    uploadId: string,
    bytesReceived: number,
  ) => {
    const msg: RelayUploadProgress = {
      type: "upload_progress",
      uploadId,
      bytesReceived,
    };
    sendMessage(ws, msg);
  };

  const sendUploadComplete = (
    ws: WSContext,
    uploadId: string,
    file: RelayUploadComplete["file"],
  ) => {
    const msg: RelayUploadComplete = {
      type: "upload_complete",
      uploadId,
      file,
    };
    sendMessage(ws, msg);
  };

  const sendUploadError = (ws: WSContext, uploadId: string, error: string) => {
    const msg: RelayUploadError = {
      type: "upload_error",
      uploadId,
      error,
    };
    sendMessage(ws, msg);
  };

  /**
   * Handle a RelayRequest by routing it through the Hono app.
   */
  const handleRequest = async (
    ws: WSContext,
    request: RelayRequest,
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
      const relayResponse: RelayResponse = {
        type: "response",
        id: request.id,
        status: response.status,
        headers:
          Object.keys(responseHeaders).length > 0 ? responseHeaders : undefined,
        body,
      };
      sendMessage(ws, relayResponse);
    } catch (err) {
      console.error("[WS Relay] Request error:", err);
      sendError(ws, request.id, 500, "Internal server error");
    }
  };

  /**
   * Handle a session subscription.
   * Subscribes to process events, computes augments, and forwards them as RelayEvent messages.
   */
  const handleSessionSubscribe = (
    ws: WSContext,
    subscriptions: Map<string, () => void>,
    msg: RelaySubscribe,
  ): void => {
    const { subscriptionId, sessionId } = msg;

    if (!sessionId) {
      sendError(
        ws,
        subscriptionId,
        400,
        "sessionId required for session channel",
      );
      return;
    }

    const process = supervisor.getProcessForSession(sessionId);
    if (!process) {
      sendError(ws, subscriptionId, 404, "No active process for session");
      return;
    }

    let eventId = 0;

    // Track current streaming message ID for text accumulation (for catch-up)
    let currentStreamingMessageId: string | null = null;

    // Helper to send a relay event
    const sendEvent = (eventType: string, data: unknown) => {
      const relayEvent: RelayEvent = {
        type: "event",
        subscriptionId,
        eventType,
        eventId: String(eventId++),
        data,
      };
      sendMessage(ws, relayEvent);
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
    const connectedEvent: RelayEvent = {
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
    };
    sendMessage(ws, connectedEvent);

    // Replay buffered messages
    for (const message of process.getMessageHistory()) {
      const messageEvent: RelayEvent = {
        type: "event",
        subscriptionId,
        eventType: "message",
        eventId: String(eventId++),
        data: markSubagent(message),
      };
      sendMessage(ws, messageEvent);
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
    ws: WSContext,
    subscriptions: Map<string, () => void>,
    msg: RelaySubscribe,
  ): void => {
    const { subscriptionId } = msg;

    let eventId = 0;

    // Send initial connected event
    const connectedEvent: RelayEvent = {
      type: "event",
      subscriptionId,
      eventType: "connected",
      eventId: String(eventId++),
      data: { timestamp: new Date().toISOString() },
    };
    sendMessage(ws, connectedEvent);

    // Set up heartbeat
    const heartbeatInterval = setInterval(() => {
      try {
        const heartbeatEvent: RelayEvent = {
          type: "event",
          subscriptionId,
          eventType: "heartbeat",
          eventId: String(eventId++),
          data: { timestamp: new Date().toISOString() },
        };
        sendMessage(ws, heartbeatEvent);
      } catch {
        clearInterval(heartbeatInterval);
      }
    }, 30000);

    // Subscribe to event bus
    const unsubscribe = eventBus.subscribe((event) => {
      try {
        const relayEvent: RelayEvent = {
          type: "event",
          subscriptionId,
          eventType: event.type,
          eventId: String(eventId++),
          data: event,
        };
        sendMessage(ws, relayEvent);
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
    ws: WSContext,
    subscriptions: Map<string, () => void>,
    msg: RelaySubscribe,
  ): void => {
    const { subscriptionId, channel } = msg;

    // Check if already subscribed with this ID
    if (subscriptions.has(subscriptionId)) {
      sendError(ws, subscriptionId, 400, "Subscription ID already in use");
      return;
    }

    switch (channel) {
      case "session":
        handleSessionSubscribe(ws, subscriptions, msg);
        break;

      case "activity":
        handleActivitySubscribe(ws, subscriptions, msg);
        break;

      default:
        sendError(ws, subscriptionId, 400, `Unknown channel: ${channel}`);
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
    ws: WSContext,
    uploads: Map<string, RelayUploadState>,
    msg: RelayUploadStart,
  ): Promise<void> => {
    const { uploadId, projectId, sessionId, filename, size, mimeType } = msg;

    // Check for duplicate upload ID
    if (uploads.has(uploadId)) {
      sendUploadError(ws, uploadId, "Upload ID already in use");
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
      sendUploadProgress(ws, uploadId, 0);

      console.log(
        `[WS Relay] Upload started: ${uploadId} (${filename}, ${size} bytes)`,
      );
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to start upload";
      sendUploadError(ws, uploadId, message);
    }
  };

  /**
   * Handle upload_chunk message.
   */
  const handleUploadChunk = async (
    ws: WSContext,
    uploads: Map<string, RelayUploadState>,
    msg: RelayUploadChunk,
  ): Promise<void> => {
    const { uploadId, offset, data } = msg;

    const state = uploads.get(uploadId);
    if (!state) {
      sendUploadError(ws, uploadId, "Upload not found");
      return;
    }

    // Validate offset matches expected position
    if (offset !== state.bytesReceived) {
      sendUploadError(
        ws,
        uploadId,
        `Invalid offset: expected ${state.bytesReceived}, got ${offset}`,
      );
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
        sendUploadProgress(ws, uploadId, bytesReceived);
        state.lastProgressReport = bytesReceived;
      }
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to write chunk";
      sendUploadError(ws, uploadId, message);
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
    ws: WSContext,
    uploads: Map<string, RelayUploadState>,
    msg: RelayUploadEnd,
  ): Promise<void> => {
    const { uploadId } = msg;

    const state = uploads.get(uploadId);
    if (!state) {
      sendUploadError(ws, uploadId, "Upload not found");
      return;
    }

    try {
      // Complete the upload
      const file = await uploadManager.completeUpload(state.serverUploadId);

      // Remove from tracking
      uploads.delete(uploadId);

      // Send completion message
      sendUploadComplete(ws, uploadId, file);

      console.log(
        `[WS Relay] Upload complete: ${uploadId} (${file.size} bytes)`,
      );
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to complete upload";
      sendUploadError(ws, uploadId, message);
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

      // Send verification
      const verify: SrpServerVerify = {
        type: "srp_verify",
        M2: result.M2,
      };
      sendSrpMessage(ws, verify);

      console.log(
        `[WS Relay] SRP authentication successful for ${connState.username}`,
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
   */
  const handleMessage = async (
    ws: WSContext,
    subscriptions: Map<string, () => void>,
    uploads: Map<string, RelayUploadState>,
    connState: ConnectionState,
    data: unknown,
  ): Promise<void> => {
    // Parse message
    let parsed: unknown;
    try {
      if (typeof data !== "string") {
        console.warn("[WS Relay] Ignoring non-string message");
        return;
      }
      parsed = JSON.parse(data);
    } catch {
      console.warn("[WS Relay] Failed to parse message:", data);
      return;
    }

    // Handle SRP messages first (always plaintext)
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
        return;
      }
      msg = parsed as RemoteClientMessage;
    }

    // Route by message type
    switch (msg.type) {
      case "request":
        await handleRequest(ws, msg);
        break;

      case "subscribe":
        handleSubscribe(ws, subscriptions, msg);
        break;

      case "unsubscribe":
        handleUnsubscribe(subscriptions, msg);
        break;

      case "upload_start":
        await handleUploadStart(ws, uploads, msg);
        break;

      case "upload_chunk":
        await handleUploadChunk(ws, uploads, msg);
        break;

      case "upload_end":
        await handleUploadEnd(ws, uploads, msg);
        break;

      default:
        console.warn(
          "[WS Relay] Unknown message type:",
          (msg as { type?: string }).type,
        );
    }
  };

  // Return the WebSocket handler
  return upgradeWebSocket((_c) => {
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
    };

    return {
      onOpen(_evt, ws) {
        console.log("[WS Relay] Client connected");
        // If remote access is not enabled, allow unauthenticated connections
        if (!remoteAccessService?.isEnabled()) {
          // In local mode, connections are implicitly authenticated
          connState.authState = "authenticated";
        }
      },

      onMessage(evt, ws) {
        // Queue messages for sequential processing
        messageQueue = messageQueue.then(() =>
          handleMessage(ws, subscriptions, uploads, connState, evt.data).catch(
            (err) => {
              console.error("[WS Relay] Unexpected error:", err);
            },
          ),
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
