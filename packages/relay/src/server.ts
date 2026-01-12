/**
 * Relay server factory for both production and testing use.
 *
 * Exports a createRelayServer function that returns a fully configured
 * server instance that can be started on any port.
 */

import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { type ServerType, serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import type Database from "better-sqlite3";
import { Hono } from "hono";
import { cors } from "hono/cors";
import pino, { type Logger } from "pino";
import type { RelayConfig } from "./config.js";
import { ConnectionManager } from "./connections.js";
import { createDb, createTestDb } from "./db.js";
import { UsernameRegistry } from "./registry.js";
import { createWsHandler } from "./ws-handler.js";

export interface RelayServerOptions {
  /** Port to listen on (default: 3500) */
  port?: number;
  /** Data directory for SQLite database (default: in-memory for testing) */
  dataDir?: string;
  /** Use in-memory database for testing */
  inMemoryDb?: boolean;
  /** Log level (default: info) */
  logLevel?: string;
  /** Ping interval for waiting connections in ms (default: 60000) */
  pingIntervalMs?: number;
  /** Pong timeout in ms (default: 30000) */
  pongTimeoutMs?: number;
  /** Days of inactivity before username can be reclaimed (default: 90) */
  reclaimDays?: number;
  /** Disable pretty printing (for tests) */
  disablePrettyPrint?: boolean;
}

export interface RelayServer {
  /** The underlying HTTP server */
  server: ServerType;
  /** The port the server is listening on */
  port: number;
  /** The Hono app instance */
  app: Hono;
  /** The connection manager */
  connectionManager: ConnectionManager;
  /** The username registry */
  registry: UsernameRegistry;
  /** The database instance */
  db: Database.Database;
  /** The logger instance */
  logger: Logger;
  /** Close the server and clean up resources */
  close(): Promise<void>;
}

/**
 * Creates a relay server instance.
 *
 * @param options - Server configuration options
 * @returns A promise that resolves to a RelayServer instance
 */
export async function createRelayServer(
  options: RelayServerOptions = {},
): Promise<RelayServer> {
  const config: RelayConfig = {
    port: options.port ?? 0, // 0 = random available port
    dataDir: options.dataDir ?? "",
    logLevel: options.logLevel ?? "warn",
    pingIntervalMs: options.pingIntervalMs ?? 60_000,
    pongTimeoutMs: options.pongTimeoutMs ?? 30_000,
    reclaimDays: options.reclaimDays ?? 90,
  };

  // Initialize logger
  const logger = pino({
    level: config.logLevel,
    ...(options.disablePrettyPrint
      ? {}
      : {
          transport: {
            target: "pino-pretty",
            options: {
              colorize: true,
            },
          },
        }),
  });

  // Initialize database
  const db = options.inMemoryDb ? createTestDb() : createDb(config.dataDir);

  // Initialize registry
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

  // Start server and wait for it to be ready
  return new Promise((resolve) => {
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

        // Attach WebSocket upgrade handler
        // @hono/node-ws requires manual handling of WebSocket upgrades
        attachWsUpgradeHandler(server, app, wss);

        resolve({
          server,
          port: info.port,
          app,
          connectionManager,
          registry,
          db,
          logger,
          async close() {
            db.close();
            server.close();
          },
        });
      },
    );
  });
}

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
  app: HonoAppLike,
  wss: WebSocketServerLike,
): void {
  server.on("upgrade", (req, socket, head) => {
    const urlPath = req.url || "/";

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
    Promise.resolve(app.request(url, { headers }, env))
      .then(() => {
        const symbolsAfter = Object.getOwnPropertySymbols(env);
        const hasNewSymbols = symbolsAfter.length > symbolsBefore.length;

        if (!hasNewSymbols) {
          socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
          return;
        }

        // Handle the WebSocket upgrade
        wss.handleUpgrade(req, socket, head, (ws) => {
          wss.emit("connection", ws, req);
        });
      })
      .catch(() => {
        socket.end(
          "HTTP/1.1 500 Internal Server Error\r\nConnection: close\r\n\r\n",
        );
      });
  });
}
