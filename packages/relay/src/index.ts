import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import { Hono } from "hono";
import { cors } from "hono/cors";
import pino from "pino";
import { loadConfig } from "./config.js";
import { ConnectionManager } from "./connections.js";
import { createDb } from "./db.js";
import { UsernameRegistry } from "./registry.js";
import { createWsHandler } from "./ws-handler.js";

const config = loadConfig();

// Initialize logger
const logger = pino({
  level: config.logLevel,
  transport: {
    target: "pino-pretty",
    options: {
      colorize: true,
    },
  },
});

logger.info(
  { dataDir: config.dataDir, port: config.port },
  "Starting relay server",
);

// Initialize database and registry
const db = createDb(config.dataDir);
const registry = new UsernameRegistry(db);

// Run reclamation on startup
const reclaimed = registry.reclaimInactive(config.reclaimDays);
if (reclaimed > 0) {
  logger.info({ count: reclaimed }, "Reclaimed inactive usernames");
}

// Create connection manager
const connectionManager = new ConnectionManager(registry);

// Create Hono app
const app = new Hono();

// Add CORS for browser clients
app.use(
  "*",
  cors({
    origin: "*",
    allowMethods: ["GET", "POST", "OPTIONS"],
    allowHeaders: ["Content-Type"],
  }),
);

// Health check endpoint
app.get("/health", (c) => {
  return c.json({
    status: "ok",
    uptime: process.uptime(),
    waiting: connectionManager.getWaitingCount(),
    pairs: connectionManager.getPairCount(),
  });
});

// Status endpoint with more details
app.get("/status", (c) => {
  return c.json({
    status: "ok",
    uptime: process.uptime(),
    waiting: connectionManager.getWaitingCount(),
    pairs: connectionManager.getPairCount(),
    waitingUsernames: connectionManager.getWaitingUsernames(),
    registeredUsernames: registry.list().map((r) => r.username),
    memory: process.memoryUsage(),
  });
});

// Create WebSocket handler
const wsHandler = createWsHandler(connectionManager, config, logger);

// Create WebSocket support
const { upgradeWebSocket, wss } = createNodeWebSocket({ app });

// WebSocket endpoint
app.get(
  "/ws",
  upgradeWebSocket(() => ({
    onOpen(event, ws) {
      wsHandler.onOpen(ws);
    },
    onMessage(event, ws) {
      wsHandler.onMessage(ws, event.data);
    },
    onClose(event, ws) {
      wsHandler.onClose(ws);
    },
    onError(event, ws) {
      wsHandler.onError(ws, event);
    },
  })),
);

/** WebSocketServer from @hono/node-ws */
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

/** Server type that supports the 'upgrade' event */
interface UpgradeableServer {
  on(
    event: "upgrade",
    listener: (req: IncomingMessage, socket: Duplex, head: Buffer) => void,
  ): this;
}

/**
 * Attach WebSocket upgrade handler to the HTTP server.
 * This is required for @hono/node-ws to work properly.
 */
function attachWsUpgradeHandler(
  server: UpgradeableServer,
  honoApp: HonoAppLike,
  websocketServer: WebSocketServerLike,
): void {
  logger.info("Attaching WebSocket upgrade handler");
  server.on("upgrade", (req, socket, head) => {
    const urlPath = req.url || "/";
    logger.debug({ urlPath, headers: req.headers }, "Received upgrade request");

    // Only handle /ws path
    if (!urlPath.startsWith("/ws")) {
      socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      return;
    }

    // Build URL and headers for Hono routing
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

    // Track symbols before routing to detect if handler matched
    const symbolsBefore = Object.getOwnPropertySymbols(env);

    // Route through Hono
    Promise.resolve(honoApp.request(url, { headers }, env))
      .then(() => {
        const symbolsAfter = Object.getOwnPropertySymbols(env);
        const hasNewSymbols = symbolsAfter.length > symbolsBefore.length;

        if (!hasNewSymbols) {
          socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
          return;
        }

        // Handle the WebSocket upgrade
        logger.debug({ urlPath }, "Handling WebSocket upgrade");
        websocketServer.handleUpgrade(req, socket, head, (ws) => {
          logger.info({ urlPath }, "WebSocket upgrade complete");
          websocketServer.emit("connection", ws, req);
        });
      })
      .catch(() => {
        socket.end(
          "HTTP/1.1 500 Internal Server Error\r\nConnection: close\r\n\r\n",
        );
      });
  });
}

// Start server
const server = serve(
  {
    fetch: app.fetch,
    port: config.port,
  },
  (info) => {
    logger.info(
      { port: info.port },
      `Relay server listening on http://localhost:${info.port}`,
    );
    logger.info(`WebSocket endpoint: ws://localhost:${info.port}/ws`);

    // Attach WebSocket upgrade handler - required for @hono/node-ws
    attachWsUpgradeHandler(server, app, wss);
  },
);

// Graceful shutdown
function shutdown() {
  logger.info("Shutting down relay server...");
  db.close();
  server.close(() => {
    logger.info("Relay server stopped");
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
