import type { ConversationSubscriptions } from "../experimental/conversation-subscriptions.js";
import type { HttpBindings } from "@hono/node-server";
import type { Context, Hono } from "hono";
import type { WSEvents } from "hono/ws";
import type { WebSocket as RawWebSocket } from "ws";
import { DIRECT_LOGIN_VARIABLE } from "../auth/principal.js";
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
import {
  listenerPathFromIncoming,
  recordWsConnectionPath,
} from "../network/connection-path.js";

// biome-ignore lint/suspicious/noExplicitAny: Complex third-party type from @hono/node-server
type UpgradeWebSocketFn = (createEvents: (c: Context) => WSEvents) => any;

export interface WsRelayDeps {
  /** Limited-user SRP verifiers and subscription authorization. */
  limitedUsers?: RelayHandlerDeps["limitedUsers"];
  authorizeSubscription?: RelayHandlerDeps["authorizeSubscription"];
  activityEventForIdentity?: RelayHandlerDeps["activityEventForIdentity"];
  conversationSubscriptions?: ConversationSubscriptions;
  upgradeWebSocket: UpgradeWebSocketFn;
  app: Hono<{ Bindings: HttpBindings }>;
  /** Base URL for internal requests (e.g., "http://localhost:3400") */
  baseUrl: string;
  supervisor: Supervisor;
  eventBus: EventBus;
  uploadManager: UploadManager;
  attachmentStagingService?: AttachmentStagingService;
  /** Remote access service for SRP authentication (optional) */
  remoteAccessService?: RemoteAccessService;
  /** Remote session service for session persistence (optional) */
  remoteSessionService?: RemoteSessionService;
  /** Registered-client continuity and security audit service. */
  securityClientService?: SecurityClientService;
  /** Durable patient queue state included in session snapshots. */
  sessionQueuePersistenceService?: SessionQueuePersistenceService;
  connectedBrowsers?: ConnectedBrowsersService;
  browserProfileService?: BrowserProfileService;
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

/** The relay server has already upgraded these connections. */
export interface AcceptRelayConnectionDeps {
  /** Limited-user SRP verifiers and subscription authorization. */
  limitedUsers?: RelayHandlerDeps["limitedUsers"];
  authorizeSubscription?: RelayHandlerDeps["authorizeSubscription"];
  activityEventForIdentity?: RelayHandlerDeps["activityEventForIdentity"];
  conversationSubscriptions?: ConversationSubscriptions;
  app: Hono<{ Bindings: HttpBindings }>;
  /** Base URL for internal requests (e.g., "http://localhost:3400") */
  baseUrl: string;
  supervisor: Supervisor;
  eventBus: EventBus;
  uploadManager: UploadManager;
  attachmentStagingService?: AttachmentStagingService;
  /** Remote access service for SRP authentication */
  remoteAccessService: RemoteAccessService;
  /** Remote session service for session persistence */
  remoteSessionService: RemoteSessionService;
  /** Registered-client continuity and security audit service. */
  securityClientService?: SecurityClientService;
  /** Durable patient queue state included in session snapshots. */
  sessionQueuePersistenceService?: SessionQueuePersistenceService;
  connectedBrowsers?: ConnectedBrowsersService;
  browserProfileService?: BrowserProfileService;
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

function createWSAdapter(
  ws: RawWebSocket,
  connState: ConnectionState,
): WSAdapter {
  return {
    isOpen: () => ws.readyState === ws.OPEN,
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
 * Route HTTP-like WebSocket requests through the existing Hono handlers,
 * alongside session and activity subscriptions.
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
    limitedUsers,
    authorizeSubscription,
    activityEventForIdentity,
  } = deps;

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
    limitedUsers,
    authorizeSubscription,
    activityEventForIdentity,
  };

  return upgradeWebSocket((c) => {
    const origin = c.req.header("origin");
    if (!isAllowedOrigin(origin, c.req.header("host"))) {
      console.warn(`[WS Relay] Rejected connection from origin: ${origin}`);
      return {
        onOpen(_evt, ws) {
          ws.close(4003, "Forbidden: Invalid origin");
        },
      };
    }

    // Socket-owned subscriptions, uploads and device sessions are released on close.
    const subscriptions = new Map<string, () => void>();
    const uploads = new Map<string, RelayUploadState>();
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
    recordWsConnectionPath(
      connState,
      listenerPathFromIncoming(c.env, c.req.header("host")),
    );
    // Ping interval for dead connection detection (set in onOpen, cleared in onClose)
    let pingInterval: ReturnType<typeof setInterval> | null = null;
    // Encryption-aware send function (created on open, captures connState)
    let send: ReturnType<typeof createSendFn>;
    let wsAdapter: WSAdapter;

    return {
      onOpen(_evt, ws) {
        console.log("[WS Relay] Client connected");
        wsAdapter = {
          isOpen: () => ws.readyState === 1,
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
          // The upgrade's cookie login is this socket's login for its whole
          // lifetime; a cookie header on a tunneled request cannot change it.
          const directLoginUsername = c.get(DIRECT_LOGIN_VARIABLE);
          connState.directLoginUsername =
            typeof directLoginUsername === "string"
              ? directLoginUsername
              : null;
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

        cleanupUploads(uploads, uploadManager, attachmentStagingService).catch(
          (err) => {
            console.error("[WS Relay] Error cleaning up uploads:", err);
          },
        );

        cleanupDeviceSessions(deviceSessions, deviceBridgeService);
        speechSessionRef.current?.close();
        speechSessionRef.current = null;

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
 * Accept already-upgraded sockets from RelayClientService. The first message
 * has already been received; process it through the same SRP/message handler
 * as subsequent traffic.
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
    limitedUsers,
    authorizeSubscription,
    activityEventForIdentity,
  } = deps;

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
    limitedUsers,
    authorizeSubscription,
    activityEventForIdentity,
  };

  return (
    rawWs: RawWebSocket,
    firstMessage: Buffer,
    firstMessageIsBinary: boolean,
  ): void => {
    console.log("[WS Relay] Accepting relay connection");

    // Socket-owned subscriptions, uploads and device sessions are released on close.
    const subscriptions = new Map<string, () => void>();
    const uploads = new Map<string, RelayUploadState>();
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

    const wsAdapter = createWSAdapter(rawWs, connState);
    const send = createSendFn(wsAdapter, connState);

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

    rawWs.on("close", () => {
      clearInterval(pingInterval);
      securityClientService?.disconnect(connState.connectionId);
      cleanupConnectionState(connState);

      cleanupUploads(uploads, uploadManager, attachmentStagingService).catch(
        (err) => {
          console.error("[WS Relay] Error cleaning up uploads:", err);
        },
      );

      cleanupDeviceSessions(deviceSessions, deviceBridgeService);
      speechSessionRef.current?.close();
      speechSessionRef.current = null;

      cleanupSubscriptions(subscriptions);
      console.log("[WS Relay] Relay connection closed");
    });

    rawWs.on("error", (err: Error) => {
      console.error("[WS Relay] WebSocket error:", err);
      wsAdapter.close(1011, "WebSocket error");
    });

    // Process the first message (SRP init from phone client)
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
