/**
 * Maintenance server - runs on a separate port for out-of-band diagnostics.
 *
 * Uses raw Node.js http module (no frameworks) to be as lightweight as possible
 * and independent from the main server's event loop. This allows diagnostics
 * even when the main server is unresponsive.
 *
 * Security: Rejects browser cross-origin requests (Origin header present) to
 * prevent drive-by attacks from malicious websites. Only allows requests from
 * curl, wget, or same-origin browser requests.
 *
 * Endpoints:
 * - GET  /health         - Simple health check
 * - GET  /status         - Server status (memory, uptime, connections)
 * - GET  /log/level      - Get current log levels
 * - PUT  /log/level      - Set log levels { console?: string, file?: string }
 * - GET  /proxy/debug    - Get PROXY_DEBUG status
 * - PUT  /proxy/debug    - Set PROXY_DEBUG { enabled: boolean }
 * - GET  /inspector       - Get Chrome DevTools inspector status
 * - POST /inspector/open  - Enable Chrome DevTools inspector
 * - POST /inspector/close - Disable Chrome DevTools inspector
 * - POST /reload         - Trigger graceful server restart
 */
import * as fs from "node:fs";
import * as http from "node:http";
import * as inspector from "node:inspector";

import {
  LOG_LEVELS,
  type LogLevel,
  getLogLevels,
  setLogLevels,
} from "../logging/logger.js";
import { handleDebugRequest } from "./debug-routes.js";

/** Current PROXY_DEBUG state (can be toggled at runtime) */
let proxyDebugEnabled =
  process.env.PROXY_DEBUG === "1" || process.env.PROXY_DEBUG === "true";

/** Export for use by proxy module */
export function isProxyDebugEnabled(): boolean {
  return proxyDebugEnabled;
}

/** Connection tracking */
interface ConnectionStats {
  activeHttpConnections: number;
  activeWsConnections: number;
  totalHttpRequests: number;
  totalWsUpgrades: number;
}

const connectionStats: ConnectionStats = {
  activeHttpConnections: 0,
  activeWsConnections: 0,
  totalHttpRequests: 0,
  totalWsUpgrades: 0,
};

/** Update connection stats (called from proxy/server code) */
export function updateConnectionStats(update: Partial<ConnectionStats>): void {
  Object.assign(connectionStats, update);
}

/** Increment a counter */
export function incrementConnectionStat(
  key: keyof ConnectionStats,
  delta = 1,
): void {
  connectionStats[key] += delta;
}

export interface MaintenanceServerOptions {
  /** Port to listen on (default: main port + 1) */
  port: number;
  /** File to write the actual port to after binding (for test harnesses) */
  portFile?: string | null;
  /** Host/interface to bind to (default: localhost) */
  host?: string;
  /** Optional: main server reference for status reporting */
  mainServerPort?: number;
}

/**
 * Start the maintenance server.
 * Returns a function to stop the server.
 */
export function startMaintenanceServer(options: MaintenanceServerOptions): {
  stop: () => void;
  server: http.Server;
} {
  const { port, portFile, host = "localhost", mainServerPort } = options;
  const startTime = Date.now();

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", `http://localhost:${port}`);
    const path = url.pathname;
    const method = req.method || "GET";

    // Security: Reject cross-origin browser requests to prevent drive-by attacks.
    // Browsers send Origin header for cross-origin requests (including from malicious sites).
    // We allow:
    // - Requests without Origin (curl, wget, etc.)
    // - Requests from same origin (localhost:PORT)
    // - Requests with Sec-Fetch-Site: same-origin or none
    const origin = req.headers.origin;
    const secFetchSite = req.headers["sec-fetch-site"];

    if (origin) {
      // Check if it's a same-origin request
      const isSameOrigin =
        origin === `http://localhost:${port}` ||
        origin === `http://127.0.0.1:${port}`;

      // Check Sec-Fetch-Site header (modern browsers)
      const isAllowedSecFetch =
        secFetchSite === "same-origin" || secFetchSite === "none";

      if (!isSameOrigin && !isAllowedSecFetch) {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: "Forbidden",
            message:
              "Cross-origin requests not allowed. Use curl or access directly.",
            hint: `curl http://localhost:${port}${path}`,
          }),
        );
        return;
      }
    }

    // No CORS headers - we don't want to enable cross-origin access

    if (method === "OPTIONS") {
      // Reject CORS preflight - we don't support cross-origin
      res.writeHead(403);
      res.end();
      return;
    }

    // Route handling
    try {
      // Try debug routes first (async)
      if (path.startsWith("/debug")) {
        const handled = await handleDebugRequest(req, res, url);
        if (handled) return;
      }

      if (path === "/health" && method === "GET") {
        handleHealth(res);
      } else if (path === "/status" && method === "GET") {
        handleStatus(res, startTime, mainServerPort);
      } else if (path === "/log/level" && method === "GET") {
        handleGetLogLevel(res);
      } else if (path === "/log/level" && method === "PUT") {
        await handleSetLogLevel(req, res);
      } else if (path === "/proxy/debug" && method === "GET") {
        handleGetProxyDebug(res);
      } else if (path === "/proxy/debug" && method === "PUT") {
        await handleSetProxyDebug(req, res);
      } else if (path === "/inspector" && method === "GET") {
        handleGetInspector(res);
      } else if (path === "/inspector/open" && method === "POST") {
        await handleOpenInspector(req, res);
      } else if (path === "/inspector/close" && method === "POST") {
        handleCloseInspector(res);
      } else if (path === "/reload" && method === "POST") {
        handleReload(res);
      } else {
        sendJson(res, 404, {
          error: "Not found",
          availableEndpoints: [
            "GET  /health",
            "GET  /status",
            "GET  /log/level",
            "PUT  /log/level",
            "GET  /proxy/debug",
            "PUT  /proxy/debug",
            "GET  /inspector",
            "POST /inspector/open",
            "POST /inspector/close",
            "POST /reload",
          ],
        });
      }
    } catch (err) {
      sendJson(res, 500, {
        error: "Internal error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  server.listen(port, host, () => {
    // Get actual port (important when binding to port 0)
    const addr = server.address();
    const actualPort = typeof addr === "object" && addr ? addr.port : port;

    // Write port to file if requested (for test harnesses)
    if (portFile) {
      fs.writeFileSync(portFile, String(actualPort));
    }

    console.log(`[Maintenance] Server running at http://${host}:${actualPort}`);
  });

  // Handle errors gracefully
  server.on("error", (err) => {
    console.error("[Maintenance] Server error:", err.message);
  });

  return {
    server,
    stop: () => {
      server.close();
    },
  };
}

/** Send JSON response */
function sendJson(
  res: http.ServerResponse,
  status: number,
  data: unknown,
): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data, null, 2));
}

/** Read JSON body from request */
async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      try {
        const body = Buffer.concat(chunks).toString();
        resolve(body ? JSON.parse(body) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

/** GET /health */
function handleHealth(res: http.ServerResponse): void {
  sendJson(res, 200, {
    status: "ok",
    timestamp: new Date().toISOString(),
  });
}

/** GET /status */
function handleStatus(
  res: http.ServerResponse,
  startTime: number,
  mainServerPort?: number,
): void {
  const memUsage = process.memoryUsage();

  sendJson(res, 200, {
    uptime: {
      seconds: Math.floor((Date.now() - startTime) / 1000),
      human: formatUptime(Date.now() - startTime),
    },
    memory: {
      rss: formatBytes(memUsage.rss),
      heapUsed: formatBytes(memUsage.heapUsed),
      heapTotal: formatBytes(memUsage.heapTotal),
      external: formatBytes(memUsage.external),
      raw: memUsage,
    },
    connections: connectionStats,
    mainServerPort,
    nodeVersion: process.version,
    platform: process.platform,
    pid: process.pid,
    timestamp: new Date().toISOString(),
  });
}

/** GET /log/level */
function handleGetLogLevel(res: http.ServerResponse): void {
  const levels = getLogLevels();
  sendJson(res, 200, {
    console: levels.console,
    file: levels.file,
    availableLevels: LOG_LEVELS,
  });
}

/** PUT /log/level */
async function handleSetLogLevel(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  try {
    const body = (await readJsonBody(req)) as {
      console?: string;
      file?: string;
    };

    const consoleLevel = body.console;
    const fileLevel = body.file;

    // Validate
    if (consoleLevel && !LOG_LEVELS.includes(consoleLevel as LogLevel)) {
      sendJson(res, 400, {
        error: "Invalid console log level",
        provided: consoleLevel,
        availableLevels: LOG_LEVELS,
      });
      return;
    }
    if (fileLevel && !LOG_LEVELS.includes(fileLevel as LogLevel)) {
      sendJson(res, 400, {
        error: "Invalid file log level",
        provided: fileLevel,
        availableLevels: LOG_LEVELS,
      });
      return;
    }

    if (!consoleLevel && !fileLevel) {
      sendJson(res, 400, {
        error: "No log level provided",
        hint: 'Provide { "console": "level" } and/or { "file": "level" }',
        availableLevels: LOG_LEVELS,
      });
      return;
    }

    const previousLevels = getLogLevels();
    setLogLevels({
      console: consoleLevel as LogLevel | undefined,
      file: fileLevel as LogLevel | undefined,
    });
    const newLevels = getLogLevels();

    console.log(
      `[Maintenance] Log levels changed: console=${newLevels.console}, file=${newLevels.file}`,
    );

    sendJson(res, 200, {
      console: newLevels.console,
      file: newLevels.file,
      previous: previousLevels,
      message: "Log levels updated",
    });
  } catch (err) {
    sendJson(res, 400, {
      error: "Invalid JSON body",
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

/** GET /proxy/debug */
function handleGetProxyDebug(res: http.ServerResponse): void {
  sendJson(res, 200, {
    enabled: proxyDebugEnabled,
    hint: 'PUT { "enabled": true } to enable proxy debug logging',
  });
}

/** PUT /proxy/debug */
async function handleSetProxyDebug(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  try {
    const body = (await readJsonBody(req)) as { enabled?: boolean };

    if (typeof body.enabled !== "boolean") {
      sendJson(res, 400, {
        error: "Invalid body",
        hint: 'Provide { "enabled": true } or { "enabled": false }',
      });
      return;
    }

    const previous = proxyDebugEnabled;
    proxyDebugEnabled = body.enabled;

    console.log(
      `[Maintenance] PROXY_DEBUG changed: ${previous} -> ${proxyDebugEnabled}`,
    );

    sendJson(res, 200, {
      enabled: proxyDebugEnabled,
      previous,
      message: `Proxy debug logging ${proxyDebugEnabled ? "enabled" : "disabled"}`,
    });
  } catch (err) {
    sendJson(res, 400, {
      error: "Invalid JSON body",
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

/** POST /reload */
function handleReload(res: http.ServerResponse): void {
  console.log("[Maintenance] Reload requested, exiting...");

  sendJson(res, 200, {
    message: "Server restarting...",
    timestamp: new Date().toISOString(),
  });

  // Exit after response is sent
  setTimeout(() => {
    process.exit(0);
  }, 100);
}

/** Format bytes to human readable */
function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  let value = bytes;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toFixed(1)} ${units[i]}`;
}

/** Format uptime to human readable */
function formatUptime(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) {
    return `${days}d ${hours % 24}h ${minutes % 60}m`;
  }
  if (hours > 0) {
    return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  }
  return `${seconds}s`;
}

/** GET /inspector - Get inspector status */
function handleGetInspector(res: http.ServerResponse): void {
  const url = inspector.url();
  sendJson(res, 200, {
    enabled: url !== undefined,
    url: url || null,
    hint: url
      ? `Open chrome://inspect in Chrome and click "inspect" on the remote target, or open ${url} directly`
      : 'POST to /inspector/open to enable (optionally with { "port": 9229 })',
  });
}

/** POST /inspector/open - Enable Chrome DevTools inspector */
async function handleOpenInspector(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  try {
    // Check if already open
    const existingUrl = inspector.url();
    if (existingUrl) {
      sendJson(res, 200, {
        message: "Inspector already open",
        url: existingUrl,
        hint: `Open chrome://inspect in Chrome, or open ${existingUrl} directly`,
      });
      return;
    }

    const body = (await readJsonBody(req)) as { port?: number; host?: string };
    const port = body.port || 9229;
    const host = body.host || "127.0.0.1";

    // Open the inspector
    inspector.open(port, host, false);

    // Wait a moment for it to start
    await new Promise((resolve) => setTimeout(resolve, 100));

    const url = inspector.url();

    console.log(`[Maintenance] Inspector opened at ${url}`);

    sendJson(res, 200, {
      message: "Inspector opened",
      url,
      port,
      host,
      hint: `Open chrome://inspect in Chrome and click "inspect", or open ${url} directly`,
      warning:
        "Inspector exposes full process access. Only enable on trusted networks.",
    });
  } catch (err) {
    sendJson(res, 500, {
      error: "Failed to open inspector",
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

/** POST /inspector/close - Disable Chrome DevTools inspector */
function handleCloseInspector(res: http.ServerResponse): void {
  const url = inspector.url();
  if (!url) {
    sendJson(res, 200, {
      message: "Inspector was not open",
    });
    return;
  }

  inspector.close();

  console.log("[Maintenance] Inspector closed");

  sendJson(res, 200, {
    message: "Inspector closed",
    previousUrl: url,
  });
}
