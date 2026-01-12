import { createServer } from "node:http";
import { getRequestListener } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { WebSocketServer } from "ws";
import { loadConfig } from "./config.js";
import { ConnectionManager } from "./connections.js";
import { createDb } from "./db.js";
import { createLogger } from "./logger.js";
import { UsernameRegistry } from "./registry.js";
import { createWsHandler } from "./ws-handler.js";

const config = loadConfig();

// Initialize logger with file logging enabled by default
const logger = createLogger(config.logging);

logger.info(
  {
    dataDir: config.dataDir,
    port: config.port,
    logFile: config.logging.logToFile
      ? `${config.logging.logDir}/${config.logging.logFile}`
      : "disabled",
  },
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

// Create Hono app for HTTP endpoints
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

// Create HTTP server with Hono
const requestListener = getRequestListener(app.fetch);
const server = createServer(requestListener);

// Create WebSocket server attached to the HTTP server, but with noServer
// so we can manually handle upgrades for /ws path only
const wss = new WebSocketServer({ noServer: true });

// Handle WebSocket connections
wss.on("connection", (ws) => {
  wsHandler.onOpen(ws);

  ws.on("message", (data, isBinary) => {
    wsHandler.onMessage(ws, data, isBinary);
  });

  ws.on("close", (code, reason) => {
    wsHandler.onClose(ws, code, reason);
  });

  ws.on("error", (error) => {
    wsHandler.onError(ws, error);
  });

  ws.on("pong", () => {
    wsHandler.onPong(ws);
  });
});

// Handle HTTP upgrade requests for WebSocket
server.on("upgrade", (request, socket, head) => {
  const urlPath = request.url || "/";
  logger.debug(
    { urlPath, headers: request.headers },
    "Received upgrade request",
  );

  // Only handle /ws path
  if (!urlPath.startsWith("/ws")) {
    socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }

  // Upgrade to WebSocket
  wss.handleUpgrade(request, socket, head, (ws) => {
    logger.info({ urlPath }, "WebSocket upgrade complete");
    wss.emit("connection", ws, request);
  });
});

// Start the server
server.listen(config.port, () => {
  // Get the actual port (important when binding to port 0)
  const address = server.address();
  const actualPort =
    typeof address === "object" && address ? address.port : config.port;
  logger.info(
    { port: actualPort },
    `Relay server listening on http://localhost:${actualPort}`,
  );
  logger.info(`WebSocket endpoint: ws://localhost:${actualPort}/ws`);
});

// Graceful shutdown
function shutdown() {
  logger.info("Shutting down relay server...");

  // Close all WebSocket connections first
  for (const client of wss.clients) {
    try {
      client.close(1001, "Server shutting down");
    } catch {
      // Ignore errors
    }
  }

  db.close();

  // Give connections a moment to close gracefully, then force exit
  const forceExitTimeout = setTimeout(() => {
    logger.warn("Force exiting after timeout");
    process.exit(0);
  }, 2000);

  server.close(() => {
    clearTimeout(forceExitTimeout);
    logger.info("Relay server stopped");
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
