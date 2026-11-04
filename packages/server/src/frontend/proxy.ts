/**
 * Frontend proxy for development mode.
 *
 * In development, we proxy all non-API requests to the Vite dev server.
 * This allows:
 * - Single port access (backend serves everything)
 * - HMR to work through the proxy
 * - WebSocket connections for both HMR and file uploads
 */
import * as http from "node:http";
import type { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import * as net from "node:net";
import type { Duplex } from "node:stream";

import { isProxyDebugEnabled } from "../maintenance/index.js";
import {
  isArtifactHost,
  isArtifactOrigin,
  isVhostHost,
} from "../middleware/allowed-hosts.js";

/** Counter for tracking connections */
let connectionCounter = 0;

/**
 * Debug logger that only logs when PROXY_DEBUG is enabled.
 * Can be toggled at runtime via the maintenance server.
 */
function debugLog(
  context: string,
  message: string,
  data?: Record<string, unknown>,
) {
  if (!isProxyDebugEnabled()) return;
  const timestamp = new Date().toISOString();
  const dataStr = data ? ` ${JSON.stringify(data)}` : "";
  console.log(`[Proxy:${context}] ${timestamp} ${message}${dataStr}`);
}

export interface FrontendProxyOptions {
  /** Vite dev server port (default: 5555) */
  vitePort?: number;
  /** Vite dev server host (default: localhost) */
  viteHost?: string;
}

export interface FrontendProxy {
  /** Target URL for the Vite dev server */
  target: string;
  /** Target host */
  targetHost: string;
  /** Target port */
  targetPort: number;
  /** Proxy an HTTP request to Vite */
  web: (req: IncomingMessage, res: ServerResponse) => void;
  /** Proxy a WebSocket upgrade to Vite */
  ws: (req: IncomingMessage, socket: Duplex, head: Buffer) => void;
}

/**
 * Create a proxy server for the Vite dev server.
 * Uses raw sockets for WebSocket proxying - simpler and more reliable than http-proxy.
 */
export function createFrontendProxy(
  options: FrontendProxyOptions = {},
): FrontendProxy {
  const { vitePort = 5555, viteHost = "localhost" } = options;
  const target = `http://${viteHost}:${vitePort}`;

  /**
   * Proxy HTTP requests to Vite
   */
  const web = (clientReq: IncomingMessage, clientRes: ServerResponse) => {
    const connId = ++connectionCounter;
    debugLog("HTTP", `[${connId}] Starting request`, {
      method: clientReq.method,
      url: clientReq.url,
    });

    let clientAborted = false;
    let proxyReq: http.ClientRequest | null = null;

    // Handle client disconnect/abort BEFORE creating proxy request
    clientReq.on("error", (err) => {
      debugLog("HTTP", `[${connId}] Client request error`, {
        error: err.message,
      });
      clientAborted = true;
      if (proxyReq) {
        proxyReq.destroy();
      }
    });

    clientReq.on("aborted", () => {
      debugLog("HTTP", `[${connId}] Client aborted`);
      clientAborted = true;
      if (proxyReq) {
        proxyReq.destroy();
      }
    });

    // Don't start proxy if client already gone
    if (clientAborted) {
      debugLog("HTTP", `[${connId}] Client already aborted, skipping`);
      return;
    }

    proxyReq = http.request(
      {
        hostname: viteHost,
        port: vitePort,
        path: clientReq.url,
        method: clientReq.method,
        headers: {
          ...clientReq.headers,
          host: `${viteHost}:${vitePort}`,
        },
      },
      (proxyRes) => {
        debugLog("HTTP", `[${connId}] Got response`, {
          status: proxyRes.statusCode,
        });
        if (clientAborted) {
          debugLog(
            "HTTP",
            `[${connId}] Client gone, destroying proxy response`,
          );
          proxyRes.destroy();
          return;
        }
        clientRes.writeHead(proxyRes.statusCode || 200, proxyRes.headers);
        proxyRes.pipe(clientRes);
        proxyRes.on("end", () => {
          debugLog("HTTP", `[${connId}] Response complete`);
        });
      },
    );

    proxyReq.on("error", (err) => {
      debugLog("HTTP", `[${connId}] Proxy request error`, {
        error: err.message,
      });
      if (!clientRes.headersSent && !clientAborted) {
        clientRes.writeHead(502, { "Content-Type": "text/plain" });
        clientRes.end(`Vite dev server not available at ${target}`);
      }
    });

    clientReq.pipe(proxyReq);
  };

  /**
   * Proxy WebSocket connections to Vite using raw TCP sockets.
   * This is simpler and more reliable than http-proxy for WebSocket.
   */
  const ws = (req: IncomingMessage, clientSocket: Duplex, head: Buffer) => {
    const connId = ++connectionCounter;
    debugLog("WS", `[${connId}] Starting WebSocket proxy`, { url: req.url });

    let clientClosed = false;
    let serverClosed = false;
    let serverSocket: net.Socket | null = null;

    // Helper to clean up both sockets
    const cleanup = (reason: string) => {
      debugLog("WS", `[${connId}] Cleanup: ${reason}`, {
        clientClosed,
        serverClosed,
      });
      if (!clientClosed) {
        clientClosed = true;
        clientSocket.end();
      }
      if (serverSocket && !serverClosed) {
        serverClosed = true;
        serverSocket.end();
      }
    };

    // Register client error handler FIRST (before any async operations)
    clientSocket.on("error", (err) => {
      debugLog("WS", `[${connId}] Client socket error`, { error: err.message });
      clientClosed = true;
      cleanup("client error");
    });

    clientSocket.on("close", () => {
      debugLog("WS", `[${connId}] Client socket closed`);
      clientClosed = true;
      cleanup("client close");
    });

    // Check if client is already gone before connecting
    if (clientClosed) {
      debugLog("WS", `[${connId}] Client already closed, aborting`);
      return;
    }

    // Create socket but DON'T connect yet - register handlers first
    serverSocket = new net.Socket();

    // Register ALL server socket handlers BEFORE connecting
    serverSocket.on("error", (err) => {
      debugLog("WS", `[${connId}] Server socket error`, { error: err.message });
      serverClosed = true;
      cleanup("server error");
    });

    serverSocket.on("close", () => {
      debugLog("WS", `[${connId}] Server socket closed`);
      serverClosed = true;
      cleanup("server close");
    });

    serverSocket.on("connect", () => {
      debugLog("WS", `[${connId}] Connected to Vite`);

      // Check if client disconnected while we were connecting
      if (clientClosed) {
        debugLog("WS", `[${connId}] Client gone during connect, aborting`);
        serverSocket?.end();
        return;
      }

      // Build the upgrade request with modified headers
      const headers = { ...req.headers };
      headers.origin = target;
      headers.host = `${viteHost}:${vitePort}`;

      let upgradeReq = `${req.method} ${req.url} HTTP/1.1\r\n`;
      for (const [key, value] of Object.entries(headers)) {
        if (value !== undefined) {
          const values = Array.isArray(value) ? value : [value];
          for (const v of values) {
            upgradeReq += `${key}: ${v}\r\n`;
          }
        }
      }
      upgradeReq += "\r\n";

      serverSocket?.write(upgradeReq);
      if (head.length > 0) {
        serverSocket?.write(head);
      }

      // Pipe data bidirectionally
      // Note: pipe() handles backpressure automatically
      serverSocket?.pipe(clientSocket);
      clientSocket.pipe(serverSocket as net.Socket);

      debugLog("WS", `[${connId}] Bidirectional pipe established`);
    });

    // NOW connect (all handlers are registered)
    serverSocket.connect(vitePort, viteHost);
  };

  return {
    target,
    targetHost: viteHost,
    targetPort: vitePort,
    web,
    ws,
  };
}

/** Server type that supports the 'upgrade' event for WebSocket handling */
interface UpgradeableServer
  extends Pick<EventEmitter, "listeners" | "removeListener"> {
  on(
    event: "upgrade",
    listener: (
      req: IncomingMessage,
      socket: import("node:stream").Duplex,
      head: Buffer,
    ) => void,
  ): this;
}

/** Options for the unified upgrade handler */
export interface UnifiedUpgradeOptions {
  peerUpgrade?: (
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ) => boolean;
  appUpgrade?: (request: IncomingMessage, socket: Duplex, head: Buffer) => void;
  /** The frontend proxy for Vite (optional, for dev mode) */
  frontendProxy?: FrontendProxy;
  /** Function to check if a path is an API path */
  isApiPath: (path: string) => boolean;
}

/** Timeout for API WebSocket upgrade routing (ms) */
const UPGRADE_TIMEOUT_MS = 10000;

/**
 * Create a unified WebSocket upgrade handler.
 *
 * Call immediately after creating the server with Hono's websocket option.
 * Wrap its sole upgrade listener so exactly one owner handles each socket.
 *
 * For non-API paths (like Vite HMR): proxies to Vite
 * For API paths: delegates the complete handshake to Hono's Node adapter.
 *
 * @param server - The HTTP server instance
 * @param options - Configuration options
 */
export function attachUnifiedUpgradeHandler(
  server: UpgradeableServer,
  options: UnifiedUpgradeOptions,
) {
  const { frontendProxy, isApiPath } = options;
  const listeners = server.listeners("upgrade");
  if (listeners.length !== 1) {
    throw new Error("Expected exactly one Hono WebSocket upgrade listener");
  }
  const honoUpgrade = listeners[0] as (
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ) => Promise<void>;
  server.removeListener("upgrade", honoUpgrade);

  server.on("upgrade", (req, socket, head) => {
    const appHost =
      isArtifactHost(req.headers.host) || isVhostHost(req.headers.host);
    if (appHost && options.appUpgrade) {
      options.appUpgrade(req, socket, head);
      return;
    }
    if (appHost || isArtifactOrigin(req.headers.origin)) {
      socket.end(
        "HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
      );
      return;
    }
    if (options.peerUpgrade?.(req, socket, head)) return;
    const connId = ++connectionCounter;
    const urlPath = req.url || "/";
    debugLog("Upgrade", `[${connId}] Upgrade request`, { path: urlPath });

    // Track socket state
    let socketClosed = false;
    let handled = false;

    // Helper to safely close socket with HTTP response
    const closeSocket = (response: string, reason: string) => {
      if (socketClosed || handled) return;
      debugLog("Upgrade", `[${connId}] Closing socket: ${reason}`);
      socketClosed = true;
      socket.end(response);
    };

    // Register error handler BEFORE any async operations
    socket.on("error", (err) => {
      debugLog("Upgrade", `[${connId}] Socket error`, { error: err.message });
      socketClosed = true;
    });

    socket.on("close", () => {
      debugLog("Upgrade", `[${connId}] Socket closed`);
      socketClosed = true;
    });

    // For non-API paths: proxy to Vite (if frontend proxy is enabled)
    if (!isApiPath(urlPath)) {
      if (frontendProxy) {
        debugLog("Upgrade", `[${connId}] Proxying to Vite`);
        handled = true;
        frontendProxy.ws(req, socket, head);
      } else {
        closeSocket(
          "HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n",
          "no frontend proxy",
        );
      }
      return;
    }

    // Hono owns request construction, authentication, response headers and the
    // handshake. No private adapter state is inspected here.
    debugLog("Upgrade", `[${connId}] Routing API WebSocket through Hono`);
    const timeoutId = setTimeout(() => {
      // Destroy rather than half-close: an eventual route result must never
      // upgrade this timed-out socket. Hono reclaims its waiter on close.
      debugLog("Upgrade", `[${connId}] Timeout waiting for route handler`);
      socket.destroy();
    }, UPGRADE_TIMEOUT_MS);
    socket.once("close", () => clearTimeout(timeoutId));
    honoUpgrade
      .call(server, req, socket, head)
      .catch((err) => {
        debugLog("Upgrade", `[${connId}] Route error`, { error: String(err) });
        closeSocket(
          "HTTP/1.1 500 Internal Server Error\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
          "route error",
        );
      })
      .finally(() => clearTimeout(timeoutId));
  });
}

/**
 * @deprecated Use attachUnifiedUpgradeHandler instead
 */
export function attachFrontendProxyUpgrade(
  server: UpgradeableServer,
  frontendProxy: FrontendProxy,
  isApiPath: (path: string) => boolean,
) {
  server.on("upgrade", (req, socket, head) => {
    const url = req.url || "/";

    if (isApiPath(url)) {
      return;
    }

    frontendProxy.ws(req, socket, head);
  });
}
