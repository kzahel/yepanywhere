import type { HttpBindings } from "@hono/node-server";
import type { Context, Hono } from "hono";
import type { WSEvents } from "hono/ws";
import type { WebSocket as RawWebSocket } from "ws";
import type {
  RemoteAccessService,
  RemoteSessionService,
} from "../remote-access/index.js";
import type { ConnectedBrowsersService } from "../services/index.js";
import type { Supervisor } from "../supervisor/Supervisor.js";
import type { UploadManager } from "../uploads/manager.js";
import type { EventBus } from "../watcher/index.js";
import {
  type ConnectionState,
  type RelayHandlerDeps,
  type RelayUploadState,
  type WSAdapter,
  cleanupSubscriptions,
  cleanupUploads,
  createConnectionState,
  createSendFn,
  handleMessage,
} from "./ws-relay-handlers.js";

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
  /** Connected browsers service for tracking WS connections (optional) */
  connectedBrowsers?: ConnectedBrowsersService;
}

/**
 * Dependencies for accepting relay connections (Phase 4).
 * Subset of WsRelayDeps without upgradeWebSocket since the connection is already established.
 */
export interface AcceptRelayConnectionDeps {
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
  /** Remote access service for SRP authentication */
  remoteAccessService: RemoteAccessService;
  /** Remote session service for session persistence */
  remoteSessionService: RemoteSessionService;
  /** Connected browsers service for tracking WS connections (optional) */
  connectedBrowsers?: ConnectedBrowsersService;
}

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
 * Create a WSAdapter from a raw ws.WebSocket.
 */
function createWSAdapter(ws: RawWebSocket): WSAdapter {
  return {
    send(data: string | ArrayBuffer | Uint8Array<ArrayBuffer>): void {
      if (ws.readyState === ws.OPEN) {
        ws.send(data);
      }
    },
    close(code?: number, reason?: string): void {
      ws.close(code, reason);
    },
  };
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
    remoteAccessService,
    remoteSessionService,
    connectedBrowsers,
  } = deps;

  // Build handler dependencies
  const handlerDeps: RelayHandlerDeps = {
    app,
    baseUrl,
    supervisor,
    eventBus,
    uploadManager,
    remoteAccessService,
    remoteSessionService,
    connectedBrowsers,
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
    const connState: ConnectionState = createConnectionState();
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
            ws.send(data);
          },
          close(code?: number, reason?: string): void {
            ws.close(code, reason);
          },
        };
        // Create the send function that captures this connection's state
        send = createSendFn(wsAdapter, connState);
        // If remote access is not enabled, allow unauthenticated connections
        if (!remoteAccessService?.isEnabled()) {
          // In local mode, connections are implicitly authenticated
          connState.authState = "authenticated";
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
            { requireAuth: remoteAccessService?.isEnabled() ?? false },
          ).catch((err) => {
            console.error("[WS Relay] Unexpected error:", err);
          }),
        );
      },

      onClose(_evt, _ws) {
        // Clean up all uploads
        cleanupUploads(uploads, uploadManager).catch((err) => {
          console.error("[WS Relay] Error cleaning up uploads:", err);
        });

        // Clean up all subscriptions
        cleanupSubscriptions(subscriptions);
        console.log("[WS Relay] Client disconnected");
      },

      onError(evt, _ws) {
        console.error("[WS Relay] WebSocket error:", evt);
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
    remoteAccessService,
    remoteSessionService,
    connectedBrowsers,
  } = deps;

  // Build handler dependencies
  const handlerDeps: RelayHandlerDeps = {
    app,
    baseUrl,
    supervisor,
    eventBus,
    uploadManager,
    remoteAccessService,
    remoteSessionService,
    connectedBrowsers,
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
    // Message queue to serialize async message handling
    let messageQueue: Promise<void> = Promise.resolve();

    // Connection state - requires authentication for relay connections
    const connState: ConnectionState = createConnectionState();

    // Create WSAdapter for raw WebSocket
    const wsAdapter = createWSAdapter(rawWs);
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
          { requireAuth: true, isBinary }, // Relay connections always require auth
        ).catch((err) => {
          console.error("[WS Relay] Unexpected error:", err);
        }),
      );
    });

    // Wire up close handling
    rawWs.on("close", () => {
      cleanupUploads(uploads, uploadManager).catch((err) => {
        console.error("[WS Relay] Error cleaning up uploads:", err);
      });

      cleanupSubscriptions(subscriptions);
      console.log("[WS Relay] Relay connection closed");
    });

    // Wire up error handling
    rawWs.on("error", (err: Error) => {
      console.error("[WS Relay] WebSocket error:", err);
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
        { requireAuth: true, isBinary: firstMessageIsBinary },
      ).catch((err) => {
        console.error("[WS Relay] Error processing first message:", err);
      }),
    );
  };
}
