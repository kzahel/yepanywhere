import type { ConversationSubscriptions } from "../experimental/conversation-subscriptions.js";
import type { HttpBindings } from "@hono/node-server";
import type { Context, Hono } from "hono";
import type { WSEvents } from "hono/ws";
import type { WebSocket as RawWebSocket } from "ws";
import type { DeviceBridgeService } from "../device/DeviceBridgeService.js";
import { isAllowedOrigin } from "../middleware/allowed-hosts.js";
import type { ProjectGlossarySubscriptionManager } from "../projects/projectGlossarySubscriptionManager.js";
import type { ProjectWorktreeSubscriptionManager } from "../projects/projectWorktreeSubscriptionManager.js";
import type {
  RemoteAccessService,
  RemoteSessionService,
} from "../remote-access/index.js";
import type {
  BrowserProfileService,
  ConnectedBrowsersService,
} from "../services/index.js";
import type { ServerSettingsService } from "../services/ServerSettingsService.js";
import type { SecurityClientService } from "../services/SecurityClientService.js";
import type { SessionQueuePersistenceService } from "../services/SessionQueuePersistenceService.js";
import type { SpeechBackendRegistry } from "../services/voice/registry.js";
import type { Supervisor } from "../supervisor/Supervisor.js";
import type { AttachmentStagingService } from "../uploads/AttachmentStagingService.js";
import type { UploadManager } from "../uploads/manager.js";
import type { EventBus, FocusedSessionWatchManager } from "../watcher/index.js";
import {
  deriveWsConnectionPolicy,
  isPolicyTrustedWithoutSrp,
} from "./ws-auth-policy.js";
import {
  type ConnectionState,
  type RelayHandlerDeps,
  type RelayUploadState,
  type WSAdapter,
  cleanupConnectionState,
  cleanupDeviceSessions,
  cleanupSubscriptions,
  cleanupUploads,
  createConnectionState,
  createSendFn,
  handleMessage,
} from "./ws-relay-handlers.js";

// biome-ignore lint/suspicious/noExplicitAny: Complex third-party type from @hono/node-ws
type UpgradeWebSocketFn = (createEvents: (c: Context) => WSEvents) => any;

export interface WsRelayDeps {
  conversationSubscriptions?: ConversationSubscriptions;
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
  /** Attachment staging service for draft-staged uploads */
  attachmentStagingService?: AttachmentStagingService;
  /** Remote access service for SRP authentication (optional) */
  remoteAccessService?: RemoteAccessService;
  /** Remote session service for session persistence (optional) */
  remoteSessionService?: RemoteSessionService;
  /** Registered-client continuity and security audit service. */
  securityClientService?: SecurityClientService;
  /** Durable patient queue state included in session snapshots. */
  sessionQueuePersistenceService?: SessionQueuePersistenceService;
  /** Connected browsers service for tracking WS connections (optional) */
  connectedBrowsers?: ConnectedBrowsersService;
  /** Browser profile service for tracking connection origins (optional) */
  browserProfileService?: BrowserProfileService;
  /** Focused session watch manager for per-session targeted file watching (optional) */
  focusedSessionWatchManager?: FocusedSessionWatchManager;
  /** Project glossary path subscriptions and reference-counted watchers. */
  projectGlossarySubscriptionManager?: ProjectGlossarySubscriptionManager;
  /** Project worktree snapshots and reference-counted watchers. */
  projectWorktreeSubscriptionManager?: ProjectWorktreeSubscriptionManager;
  /** Emulator bridge service for Android emulator streaming (optional) */
  deviceBridgeService?: DeviceBridgeService;
  /** Speech backend registry for relayed streaming STT (optional) */
  speechBackendRegistry?: SpeechBackendRegistry;
  /** Server data dir for relayed speech audio retention (optional) */
  dataDir?: string;
  /** Server settings service for relayed speech retention settings (optional) */
  serverSettingsService?: ServerSettingsService;
  /** Authenticated exact probes for bare absolute-path viewer links. */
  resolveAbsoluteFilePaths?: (
    paths: readonly string[],
  ) => Promise<ReadonlySet<string>>;
}

/**
 * Dependencies for accepting relay connections (Phase 4).
 * Subset of WsRelayDeps without upgradeWebSocket since the connection is already established.
 */
export interface AcceptRelayConnectionDeps {
  conversationSubscriptions?: ConversationSubscriptions;
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
  /** Attachment staging service for draft-staged uploads */
  attachmentStagingService?: AttachmentStagingService;
  /** Remote access service for SRP authentication */
  remoteAccessService: RemoteAccessService;
  /** Remote session service for session persistence */
  remoteSessionService: RemoteSessionService;
  /** Registered-client continuity and security audit service. */
  securityClientService?: SecurityClientService;
  /** Durable patient queue state included in session snapshots. */
  sessionQueuePersistenceService?: SessionQueuePersistenceService;
  /** Connected browsers service for tracking WS connections (optional) */
  connectedBrowsers?: ConnectedBrowsersService;
  /** Browser profile service for tracking connection origins (optional) */
  browserProfileService?: BrowserProfileService;
  /** Focused session watch manager for per-session targeted file watching (optional) */
  focusedSessionWatchManager?: FocusedSessionWatchManager;
  /** Project glossary path subscriptions and reference-counted watchers. */
  projectGlossarySubscriptionManager?: ProjectGlossarySubscriptionManager;
  /** Project worktree snapshots and reference-counted watchers. */
  projectWorktreeSubscriptionManager?: ProjectWorktreeSubscriptionManager;
  /** Emulator bridge service for Android emulator streaming (optional) */
  deviceBridgeService?: DeviceBridgeService;
  /** Speech backend registry for relayed streaming STT (optional) */
  speechBackendRegistry?: SpeechBackendRegistry;
  /** Server data dir for relayed speech audio retention (optional) */
  dataDir?: string;
  /** Server settings service for relayed speech retention settings (optional) */
  serverSettingsService?: ServerSettingsService;
  /** Authenticated exact probes for bare absolute-path viewer links. */
  resolveAbsoluteFilePaths?: (
    paths: readonly string[],
  ) => Promise<ReadonlySet<string>>;
}

/**
 * Create a WSAdapter from a raw ws.WebSocket.
 */
function createWSAdapter(
  ws: RawWebSocket,
  connState: ConnectionState,
): WSAdapter {
  return {
    send(data: string | ArrayBuffer | Uint8Array<ArrayBuffer>): void {
      try {
        if (ws.readyState === ws.OPEN) {
          ws.send(data);
        }
      } catch {
        // Socket closed between readyState check and send
      }
    },
    close(code?: number, reason?: string): void {
      cleanupConnectionState(connState);
      try {
        ws.close(code, reason);
      } catch {
        // Already closed
      }
    },
  };
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return (
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized === "[::1]"
  );
}

function isLoopbackPeerAddress(address: string): boolean {
  const normalized = address.toLowerCase();
  return (
    normalized === "::1" ||
    normalized === "::ffff:127.0.0.1" ||
    /^127(?:\.\d{1,3}){3}$/.test(normalized)
  );
}

export function isLoopbackWsRequest(
  peerAddress: string | null,
  hostname: string | null,
): boolean {
  return (
    peerAddress !== null &&
    hostname !== null &&
    isLoopbackPeerAddress(peerAddress) &&
    isLoopbackHostname(hostname)
  );
}

function getRequestHostname(c: Context): string | null {
  const hostHeader = c.req.header("host");
  if (hostHeader) {
    if (hostHeader.startsWith("[")) {
      const closeBracket = hostHeader.indexOf("]");
      if (closeBracket === -1) return null;
      return hostHeader.slice(1, closeBracket);
    }
    return hostHeader.replace(/:\d+$/, "");
  }

  try {
    return new URL(c.req.url).hostname;
  } catch {
    return null;
  }
}

function getPeerAddress(c: Context<{ Bindings: HttpBindings }>): string | null {
  return c.env.incoming.socket.remoteAddress ?? null;
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
    attachmentStagingService,
    remoteAccessService,
    remoteSessionService,
    securityClientService,
    sessionQueuePersistenceService,
    connectedBrowsers,
    browserProfileService,
    focusedSessionWatchManager,
    projectGlossarySubscriptionManager,
    projectWorktreeSubscriptionManager,
    deviceBridgeService,
    speechBackendRegistry,
    dataDir,
    serverSettingsService,
    resolveAbsoluteFilePaths,
    conversationSubscriptions,
  } = deps;

  // Build handler dependencies
  const handlerDeps: RelayHandlerDeps = {
    app,
    baseUrl,
    supervisor,
    eventBus,
    uploadManager,
    attachmentStagingService,
    remoteAccessService,
    remoteSessionService,
    securityClientService,
    sessionQueuePersistenceService,
    connectedBrowsers,
    browserProfileService,
    focusedSessionWatchManager,
    projectGlossarySubscriptionManager,
    projectWorktreeSubscriptionManager,
    deviceBridgeService,
    speechBackendRegistry,
    dataDir,
    serverSettingsService,
    resolveAbsoluteFilePaths,
    conversationSubscriptions,
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
    // Track active emulator streaming sessions for this connection
    const deviceSessions = new Set<string>();
    const speechSessionRef: Parameters<
      typeof handleMessage
    >[7]["speechSessionRef"] = { current: null };
    // Message queue to serialize async message handling
    let messageQueue: Promise<void> = Promise.resolve();
    // Connection state for SRP authentication
    const connState: ConnectionState = createConnectionState({
      transport: "direct",
      peerAddress: getPeerAddress(c),
    });
    // Ping interval for dead connection detection (set in onOpen, cleared in onClose)
    let pingInterval: ReturnType<typeof setInterval> | null = null;
    // Encryption-aware send function (created on open, captures connState)
    let send: ReturnType<typeof createSendFn>;
    // WSAdapter wrapper
    let wsAdapter: WSAdapter;

    return {
      onOpen(_evt, ws) {
        console.log("[WS Relay] Client connected");
        // Create WSAdapter wrapper for Hono's WSContext
        wsAdapter = {
          send(data: string | ArrayBuffer | Uint8Array<ArrayBuffer>): void {
            try {
              ws.send(data);
            } catch {
              // Socket closed or closing — handled by onClose
            }
          },
          close(code?: number, reason?: string): void {
            cleanupConnectionState(connState);
            try {
              ws.close(code, reason);
            } catch {
              // Already closed
            }
          },
        };
        // Create the send function that captures this connection's state
        send = createSendFn(wsAdapter, connState);
        const hasSessionCookieAuth = c.get("authenticatedViaSession") === true;
        const requestHostname = getRequestHostname(c);
        const peerAddress = getPeerAddress(c);
        const connectionPolicy = deriveWsConnectionPolicy({
          remoteAccessEnabled: remoteAccessService?.isEnabled() ?? false,
          hasSessionCookieAuth,
          isRelayConnection: false,
          // Loopback trust requires the actual TCP peer to be loopback. The
          // Host header only corroborates local intent; it is never sufficient
          // by itself for bypassing SRP.
          isLoopbackConnection: isLoopbackWsRequest(
            peerAddress,
            requestHostname,
          ),
        });
        connState.connectionPolicy = connectionPolicy;
        // Auto-authenticate for:
        // 1) local mode (remote access disabled), or
        // 2) local cookie-authenticated upgrade requests.
        // Avoid treating AUTH_DISABLED/middleware bypass as WS authentication.
        if (isPolicyTrustedWithoutSrp(connectionPolicy)) {
          connState.authState = "authenticated";
        }

        // Start WebSocket ping every 30s for dead connection detection
        const rawWs = ws.raw as RawWebSocket | undefined;
        if (rawWs?.ping) {
          pingInterval = setInterval(() => {
            try {
              if (rawWs.readyState === rawWs.OPEN) rawWs.ping();
            } catch {
              if (pingInterval) clearInterval(pingInterval);
            }
          }, 30_000);
        }
      },

      onMessage(evt, _ws) {
        // Queue messages for sequential processing
        messageQueue = messageQueue.then(() =>
          handleMessage(
            wsAdapter,
            subscriptions,
            uploads,
            connState,
            send,
            evt.data,
            handlerDeps,
            { speechSessionRef },
            deviceSessions,
          ).catch((err) => {
            console.error("[WS Relay] Unexpected error:", err);
          }),
        );
      },

      onClose(_evt, _ws) {
        if (pingInterval) clearInterval(pingInterval);
        securityClientService?.disconnect(connState.connectionId);
        cleanupConnectionState(connState);

        // Clean up all uploads
        cleanupUploads(uploads, uploadManager, attachmentStagingService).catch(
          (err) => {
            console.error("[WS Relay] Error cleaning up uploads:", err);
          },
        );

        // Clean up emulator streaming sessions
        cleanupDeviceSessions(deviceSessions, deviceBridgeService);
        speechSessionRef.current?.close();
        speechSessionRef.current = null;

        // Clean up all subscriptions
        cleanupSubscriptions(subscriptions);
        console.log("[WS Relay] Client disconnected");
      },

      onError(evt, _ws) {
        console.error("[WS Relay] WebSocket error:", evt);
        wsAdapter?.close(1011, "WebSocket error");
      },
    };
  });
}

/**
 * Create an accept relay connection handler (Phase 4).
 *
 * This returns a function that accepts already-connected WebSocket connections
 * from the RelayClientService. Unlike createWsRelayRoutes which uses Hono's
 * upgradeWebSocket, this works with raw ws.WebSocket instances since the
 * WebSocket upgrade already happened at the relay server.
 *
 * The handler:
 * - Wires up message/close/error events
 * - Processes the first message (usually SRP init from phone)
 * - Uses the same SRP authentication and message handling as direct connections
 *
 * @param deps - Dependencies (same as WsRelayDeps but without upgradeWebSocket)
 * @returns A function that accepts (ws, firstMessage, isBinary) and handles the connection
 */
export function createAcceptRelayConnection(
  deps: AcceptRelayConnectionDeps,
): (ws: RawWebSocket, firstMessage: Buffer, isBinary: boolean) => void {
  const {
    app,
    baseUrl,
    supervisor,
    eventBus,
    uploadManager,
    attachmentStagingService,
    remoteAccessService,
    remoteSessionService,
    securityClientService,
    sessionQueuePersistenceService,
    connectedBrowsers,
    browserProfileService,
    focusedSessionWatchManager,
    projectGlossarySubscriptionManager,
    projectWorktreeSubscriptionManager,
    deviceBridgeService,
    speechBackendRegistry,
    dataDir,
    serverSettingsService,
    resolveAbsoluteFilePaths,
    conversationSubscriptions,
  } = deps;

  // Build handler dependencies
  const handlerDeps: RelayHandlerDeps = {
    app,
    baseUrl,
    supervisor,
    eventBus,
    uploadManager,
    attachmentStagingService,
    remoteAccessService,
    remoteSessionService,
    securityClientService,
    sessionQueuePersistenceService,
    connectedBrowsers,
    browserProfileService,
    focusedSessionWatchManager,
    projectGlossarySubscriptionManager,
    projectWorktreeSubscriptionManager,
    deviceBridgeService,
    speechBackendRegistry,
    dataDir,
    serverSettingsService,
    resolveAbsoluteFilePaths,
    conversationSubscriptions,
  };

  // Return the accept relay connection handler
  return (
    rawWs: RawWebSocket,
    firstMessage: Buffer,
    firstMessageIsBinary: boolean,
  ): void => {
    console.log("[WS Relay] Accepting relay connection");

    // Track active subscriptions for this connection
    const subscriptions = new Map<string, () => void>();
    // Track active uploads for this connection
    const uploads = new Map<string, RelayUploadState>();
    // Track active emulator streaming sessions for this connection
    const deviceSessions = new Set<string>();
    const speechSessionRef: Parameters<
      typeof handleMessage
    >[7]["speechSessionRef"] = { current: null };
    // Message queue to serialize async message handling
    let messageQueue: Promise<void> = Promise.resolve();

    // Connection state - requires authentication for relay connections
    const connState: ConnectionState = createConnectionState({
      transport: "relay",
    });
    connState.connectionPolicy = "srp_required";

    // Create WSAdapter for raw WebSocket
    const wsAdapter = createWSAdapter(rawWs, connState);
    const send = createSendFn(wsAdapter, connState);

    // Wire up message handling
    // Note: ws library provides (data, isBinary) - isBinary tells us the frame type
    rawWs.on("message", (data: Buffer, isBinary: boolean) => {
      messageQueue = messageQueue.then(() =>
        handleMessage(
          wsAdapter,
          subscriptions,
          uploads,
          connState,
          send,
          data,
          handlerDeps,
          { isBinary, speechSessionRef },
          deviceSessions,
        ).catch((err) => {
          console.error("[WS Relay] Unexpected error:", err);
        }),
      );
    });

    // Start WebSocket ping every 30s for dead connection detection
    const pingInterval = setInterval(() => {
      try {
        if (rawWs.readyState === rawWs.OPEN) rawWs.ping();
      } catch {
        clearInterval(pingInterval);
      }
    }, 30_000);

    // Wire up close handling
    rawWs.on("close", () => {
      clearInterval(pingInterval);
      securityClientService?.disconnect(connState.connectionId);
      cleanupConnectionState(connState);

      cleanupUploads(uploads, uploadManager, attachmentStagingService).catch(
        (err) => {
          console.error("[WS Relay] Error cleaning up uploads:", err);
        },
      );

      // Clean up emulator streaming sessions
      cleanupDeviceSessions(deviceSessions, deviceBridgeService);
      speechSessionRef.current?.close();
      speechSessionRef.current = null;

      cleanupSubscriptions(subscriptions);
      console.log("[WS Relay] Relay connection closed");
    });

    // Wire up error handling
    rawWs.on("error", (err: Error) => {
      console.error("[WS Relay] WebSocket error:", err);
      wsAdapter.close(1011, "WebSocket error");
    });

    // Process the first message (SRP init from phone client)
    // Pass isBinary to correctly identify frame type
    messageQueue = messageQueue.then(() =>
      handleMessage(
        wsAdapter,
        subscriptions,
        uploads,
        connState,
        send,
        firstMessage,
        handlerDeps,
        { isBinary: firstMessageIsBinary, speechSessionRef },
        deviceSessions,
      ).catch((err) => {
        console.error("[WS Relay] Error processing first message:", err);
      }),
    );
  };
}
