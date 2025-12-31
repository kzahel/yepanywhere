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
import type { IncomingMessage, ServerResponse } from "node:http";
import * as net from "node:net";
import type { Duplex } from "node:stream";

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
    const proxyReq = http.request(
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
        clientRes.writeHead(proxyRes.statusCode || 200, proxyRes.headers);
        proxyRes.pipe(clientRes);
      },
    );

    proxyReq.on("error", (err) => {
      console.error("[Proxy HTTP] Error:", err.message);
      if (!clientRes.headersSent) {
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
    console.log("[Proxy WS] Connecting to Vite:", req.url);
    console.log("[Proxy WS] Client socket writable:", clientSocket.writable);
    console.log("[Proxy WS] Client socket readable:", clientSocket.readable);

    // Check for immediate close/error on client socket
    clientSocket.on("error", (err) => {
      console.error("[Proxy WS] Client socket error (early):", err.message);
    });

    // Connect to Vite
    const serverSocket = net.connect(vitePort, viteHost, () => {
      console.log("[Proxy WS] Connected to Vite, sending upgrade request");

      // Build the upgrade request with modified headers
      const headers = { ...req.headers };
      // Change Origin to match Vite's expected origin
      headers.origin = target;
      headers.host = `${viteHost}:${vitePort}`;

      // Send the upgrade request
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

      console.log("[Proxy WS] Sending upgrade request to Vite");
      serverSocket.write(upgradeReq);
      if (head.length > 0) {
        serverSocket.write(head);
      }

      // Log the first response from Vite for debugging
      let firstData = true;
      serverSocket.on("data", (chunk) => {
        if (firstData) {
          firstData = false;
          const preview = chunk.toString(
            "utf8",
            0,
            Math.min(200, chunk.length),
          );
          console.log("[Proxy WS] First data from Vite:", preview);
        }
      });

      // Pipe data bidirectionally
      serverSocket.pipe(clientSocket);
      clientSocket.pipe(serverSocket);

      console.log("[Proxy WS] WebSocket proxy established");
    });

    serverSocket.on("error", (err) => {
      console.error("[Proxy WS] Server socket error:", err.message);
      clientSocket.end();
    });

    clientSocket.on("error", (err) => {
      console.error("[Proxy WS] Client socket error:", err.message);
      serverSocket.end();
    });

    serverSocket.on("close", () => {
      console.log("[Proxy WS] Server socket closed");
      clientSocket.end();
    });

    clientSocket.on("close", () => {
      console.log("[Proxy WS] Client socket closed");
      serverSocket.end();
    });
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
interface UpgradeableServer {
  on(
    event: "upgrade",
    listener: (
      req: IncomingMessage,
      socket: import("node:stream").Duplex,
      head: Buffer,
    ) => void,
  ): this;
}

/** WebSocketServer from the 'ws' package */
interface WebSocketServerLike {
  handleUpgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    callback: (ws: unknown) => void,
  ): void;
  emit(event: string, ...args: unknown[]): boolean;
}

/** Hono app type for routing */
interface HonoAppLike {
  request(
    url: URL,
    init: { headers: Headers },
    env: Record<string | symbol, unknown>,
  ): Response | Promise<Response>;
}

/** Options for the unified upgrade handler */
export interface UnifiedUpgradeOptions {
  /** The frontend proxy for Vite (optional, for dev mode) */
  frontendProxy?: FrontendProxy;
  /** Function to check if a path is an API path */
  isApiPath: (path: string) => boolean;
  /** The Hono app for routing API WebSocket requests */
  app: HonoAppLike;
  /** The WebSocketServer from @hono/node-ws */
  wss: WebSocketServerLike;
}

/**
 * Create a unified WebSocket upgrade handler.
 *
 * This replaces both `attachFrontendProxyUpgrade` and `injectWebSocket` to avoid
 * conflicts where both handlers try to process the same upgrade request.
 *
 * For non-API paths (like Vite HMR): proxies to Vite
 * For API paths: routes through Hono and handles with @hono/node-ws
 *
 * @param server - The HTTP server instance
 * @param options - Configuration options
 */
export function attachUnifiedUpgradeHandler(
  server: UpgradeableServer,
  options: UnifiedUpgradeOptions,
) {
  const { frontendProxy, isApiPath, app, wss } = options;

  server.on("upgrade", async (req, socket, head) => {
    const urlPath = req.url || "/";
    console.log("[Upgrade] Received upgrade request for:", urlPath);

    // For non-API paths: proxy to Vite (if frontend proxy is enabled)
    if (!isApiPath(urlPath)) {
      if (frontendProxy) {
        console.log("[Upgrade] Forwarding to Vite:", urlPath);
        frontendProxy.ws(req, socket, head);
      } else {
        console.log("[Upgrade] No frontend proxy, closing:", urlPath);
        socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      }
      return;
    }

    // For API paths: route through Hono (replicate @hono/node-ws logic)
    console.log("[Upgrade] Routing API WebSocket:", urlPath);

    const url = new URL(urlPath, "http://localhost");
    const headers = new Headers();
    for (const key in req.headers) {
      const value = req.headers[key];
      if (value !== undefined) {
        const headerValue = Array.isArray(value) ? value[0] : value;
        if (headerValue !== undefined) {
          headers.append(key, headerValue);
        }
      }
    }

    const env: Record<string | symbol, unknown> = {
      incoming: req,
      outgoing: undefined,
    };

    // Track symbol properties before routing
    const symbolsBefore = Object.getOwnPropertySymbols(env);

    // Route through Hono - this will call upgradeWebSocket if matched
    await app.request(url, { headers }, env);

    // Check if a WebSocket handler matched by checking if @hono/node-ws
    // added its connection symbol to env. Since their symbol is private,
    // we check if any new symbols were added.
    const symbolsAfter = Object.getOwnPropertySymbols(env);
    const hasNewSymbols = symbolsAfter.length > symbolsBefore.length;

    if (!hasNewSymbols) {
      console.log("[Upgrade] No WebSocket handler matched:", urlPath);
      socket.end(
        "HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
      );
      return;
    }

    // Handle the upgrade with the ws library
    console.log("[Upgrade] Handling WebSocket upgrade for:", urlPath);
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
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
    console.log("[Proxy Upgrade] Received upgrade request for:", url);

    if (isApiPath(url)) {
      console.log("[Proxy Upgrade] Letting API WebSocket through:", url);
      return;
    }

    console.log("[Proxy Upgrade] Forwarding to Vite:", url);
    frontendProxy.ws(req, socket, head);
  });
}
