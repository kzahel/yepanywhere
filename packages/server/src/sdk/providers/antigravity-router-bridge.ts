import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import {
  type Stats,
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import http, {
  type ClientRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import https from "node:https";
import type { Socket } from "node:net";
import { join, resolve } from "node:path";

/**
 * Cloud Code RPC paths `agy acp` sends to `--cloud_code_endpoint` and AAR's
 * `/antigravity` gateway accepts. Everything else is refused at the loopback
 * boundary before leaving this process.
 */
export const ALLOWED_ANTIGRAVITY_BRIDGE_PATHS = new Set<string>([
  "/v1internal:loadCodeAssist",
  "/v1internal:fetchAdminControls",
  "/v1internal:fetchAvailableModels",
  "/v1internal:fetchUserInfo",
  "/v1internal:listExperiments",
  "/v1internal:retrieveUserQuotaSummary",
  "/v1internal:streamGenerateContent",
]);

const FORWARDED_REQUEST_HEADERS = [
  "content-type",
  "content-encoding",
  "accept",
  "user-agent",
  "x-goog-api-client",
  "content-length",
] as const;

const DENIED_RESPONSE_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "set-cookie",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

const MARKER_PREFIX = "aar_local_";
const MARKER_PATTERN = /^aar_local_[A-Za-z0-9_-]{32,128}$/;
const UPSTREAM_HEADER_TIMEOUT_MS = 120_000;
const UPSTREAM_STREAM_IDLE_TIMEOUT_MS = 600_000;

export interface AntigravityRouterBridge {
  /** Loopback URL passed to `agy acp --cloud_code_endpoint`. */
  readonly endpoint: string;
  /** Stop accepting requests, abort active upstream calls, and release the port. */
  close(): Promise<void>;
}

function assertPrivatePosix(stats: Stats, label: string): void {
  if (process.platform === "win32") return;
  if (stats.mode & 0o077) {
    throw new Error(`${label} has overly permissive permissions`);
  }
  const uid = process.getuid?.();
  if (uid !== undefined && stats.uid !== uid) {
    throw new Error(`${label} is not owned by the current user`);
  }
}

function parseValidatedMarker(raw: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Antigravity routed profile token file is not valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Antigravity routed profile token file is invalid");
  }
  const record = parsed as Record<string, unknown>;
  const tokenObj =
    record.token &&
    typeof record.token === "object" &&
    !Array.isArray(record.token)
      ? (record.token as Record<string, unknown>)
      : undefined;
  if (
    ("refresh_token" in record && record.refresh_token !== undefined) ||
    (tokenObj &&
      "refresh_token" in tokenObj &&
      tokenObj.refresh_token !== undefined)
  ) {
    throw new Error(
      "Refusing to overwrite a real Google OAuth credential in Antigravity router profile",
    );
  }
  if (
    record.auth_method !== "consumer" ||
    !tokenObj ||
    typeof tokenObj.access_token !== "string" ||
    !MARKER_PATTERN.test(tokenObj.access_token)
  ) {
    throw new Error(
      "Refusing to reuse an unexpected credential in Antigravity router profile",
    );
  }
  return tokenObj.access_token;
}

function validateBridgeSettings(raw: string): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Antigravity router profile settings.json is invalid JSON");
  }
  const config = parsed as {
    auth?: { type?: unknown };
    modelProvider?: unknown;
  };
  if (config?.auth?.type !== "oauth-personal" || config.modelProvider) {
    throw new Error("Choose a dedicated Antigravity router profile");
  }
}

function ensurePrivateDirectory(dir: string, label: string): void {
  if (existsSync(dir)) {
    const stats = lstatSync(dir);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new Error(`${label} must be a regular directory`);
    }
    assertPrivatePosix(stats, label);
    return;
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") {
    chmodSync(dir, 0o700);
  }
  const stats = lstatSync(dir);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error(`${label} must be a regular directory`);
  }
  assertPrivatePosix(stats, label);
}

function writeFileIfAbsentAtomically(
  dir: string,
  targetPath: string,
  content: string,
): boolean {
  const tempPath = join(dir, `.tmp-${randomUUID()}`);
  writeFileSync(tempPath, content, { mode: 0o600, flag: "wx" });
  try {
    linkSync(tempPath, targetPath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      return false;
    }
    throw error;
  } finally {
    try {
      unlinkSync(tempPath);
    } catch {
      /* Already removed. */
    }
  }
}

/**
 * Prepare a private `GEMINI_HOME` profile directory for routed `agy acp`
 * sessions. Writes a placeholder OAuth marker (`aar_local_*`) — never the AAR
 * gateway token — and refuses any directory holding a real Google OAuth token.
 * Concurrent routed sessions safely share the same validated profile marker
 * while each session runs its own loopback bridge with its own AAR token.
 */
export function prepareAntigravityBridgeProfile(home: string): {
  profileDir: string;
  marker: string;
} {
  const profileDir = resolve(home);
  const cliDir = join(profileDir, "antigravity-cli");
  ensurePrivateDirectory(profileDir, "Antigravity router profile directory");
  ensurePrivateDirectory(cliDir, "Antigravity router CLI profile directory");

  const settingsPath = join(cliDir, "settings.json");
  const tokenPath = join(cliDir, "antigravity-oauth-token");
  if (existsSync(settingsPath) && !existsSync(tokenPath)) {
    throw new Error(
      "Refusing to adopt an existing Antigravity profile without a router marker",
    );
  }

  let marker: string | undefined;
  if (!existsSync(tokenPath)) {
    const generated = `${MARKER_PREFIX}${randomBytes(32).toString("base64url")}`;
    const payload = `${JSON.stringify({
      auth_method: "consumer",
      token: {
        access_token: generated,
        token_type: "Bearer",
        expiry: "9999-12-31T23:59:59Z",
      },
    })}\n`;
    if (writeFileIfAbsentAtomically(cliDir, tokenPath, payload)) {
      marker = generated;
    }
  }
  if (!marker) {
    const tokenStats = lstatSync(tokenPath);
    if (tokenStats.isSymbolicLink() || !tokenStats.isFile()) {
      throw new Error("Antigravity router profile token file is invalid");
    }
    assertPrivatePosix(tokenStats, "Antigravity router profile token file");
    marker = parseValidatedMarker(readFileSync(tokenPath, "utf8"));
  }

  if (existsSync(settingsPath)) {
    const stats = lstatSync(settingsPath);
    if (stats.isSymbolicLink() || !stats.isFile()) {
      throw new Error("Antigravity router profile settings.json is invalid");
    }
    assertPrivatePosix(stats, "Antigravity router profile settings.json");
    validateBridgeSettings(readFileSync(settingsPath, "utf8"));
  } else {
    writeFileIfAbsentAtomically(
      cliDir,
      settingsPath,
      `${JSON.stringify({ auth: { type: "oauth-personal" } }, null, 2)}\n`,
    );
  }

  return { profileDir, marker };
}

function validateUpstreamBaseUrl(raw: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("Invalid AAR Antigravity base URL");
  }
  const isLoopback =
    parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]";
  const validProtocol =
    parsed.protocol === "https:" || (parsed.protocol === "http:" && isLoopback);
  if (
    !validProtocol ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error("Unsupported AAR Antigravity base URL");
  }
  return parsed;
}

function constantTimeEquals(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function writeJsonError(
  res: ServerResponse,
  status: number,
  message: string,
): void {
  if (res.writableEnded) return;
  if (!res.headersSent) {
    res.writeHead(status, {
      "content-type": "application/json",
      "cache-control": "no-store",
    });
  }
  res.end(JSON.stringify({ error: message }));
}

function parseAllowedRpcTarget(rawUrl: string | undefined): string | null {
  if (!rawUrl?.startsWith("/")) return null;
  if (rawUrl.includes("\\") || /%2[ef]/i.test(rawUrl.split("?")[0] ?? "")) {
    return null;
  }
  for (let i = 0; i < rawUrl.length; i++) {
    const code = rawUrl.charCodeAt(i);
    if (code < 32 || code === 127) return null;
  }
  let parsed: URL;
  try {
    parsed = new URL(rawUrl, "http://127.0.0.1");
  } catch {
    return null;
  }
  if (!ALLOWED_ANTIGRAVITY_BRIDGE_PATHS.has(parsed.pathname)) {
    return null;
  }
  return `${parsed.pathname}${parsed.search}`;
}

/**
 * Start a session-scoped loopback HTTP bridge for `agy acp`.
 *
 * `agy acp` authenticates to this loopback server with the profile's
 * placeholder `aar_local_*` marker; the bridge verifies Host + marker +
 * Cloud Code RPC allowlist and forwards to AAR with the session's gateway
 * token held only in memory.
 */
export async function startAntigravityRouterBridge(options: {
  baseUrl: string;
  token: string;
  marker: string;
  upstreamHeaderTimeoutMs?: number;
  upstreamStreamIdleTimeoutMs?: number;
}): Promise<AntigravityRouterBridge> {
  if (!options.token || !options.marker) {
    throw new Error("Antigravity router bridge requires a token and marker");
  }
  const upstreamBase = validateUpstreamBaseUrl(options.baseUrl);
  const basePath = upstreamBase.pathname.replace(/\/+$/, "");
  const headerTimeoutMs =
    options.upstreamHeaderTimeoutMs ?? UPSTREAM_HEADER_TIMEOUT_MS;
  const idleTimeoutMs =
    options.upstreamStreamIdleTimeoutMs ?? UPSTREAM_STREAM_IDLE_TIMEOUT_MS;
  const expectedAuth = `Bearer ${options.marker}`;
  const sockets = new Set<Socket>();
  const activeUpstream = new Set<ClientRequest>();
  let expectedHost = "";
  let closed = false;

  const handleRequest = (req: IncomingMessage, res: ServerResponse): void => {
    if (closed) {
      writeJsonError(res, 503, "Bridge closed");
      return;
    }
    if (req.headers.host !== expectedHost) {
      writeJsonError(res, 403, "Forbidden host");
      return;
    }
    if (req.method !== "POST") {
      writeJsonError(res, 405, "Method not allowed");
      return;
    }
    const authHeader = req.headers.authorization;
    if (
      typeof authHeader !== "string" ||
      !constantTimeEquals(authHeader, expectedAuth)
    ) {
      writeJsonError(res, 401, "Unauthorized");
      return;
    }
    const target = parseAllowedRpcTarget(req.url);
    if (!target) {
      writeJsonError(res, 404, "Endpoint not allowed");
      return;
    }

    const forwardHeaders: Record<string, string> = {
      authorization: `Bearer ${options.token}`,
    };
    for (const name of FORWARDED_REQUEST_HEADERS) {
      const value = req.headers[name];
      if (typeof value === "string") {
        forwardHeaders[name] = value;
      } else if (Array.isArray(value) && value.length > 0) {
        forwardHeaders[name] = value.join(", ");
      }
    }

    const upstreamUrl = new URL(`${basePath}${target}`, upstreamBase.origin);
    const transport = upstreamUrl.protocol === "https:" ? https : http;
    let upstreamRes: IncomingMessage | undefined;
    let headerTimer: ReturnType<typeof setTimeout> | undefined;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;

    const clearTimers = () => {
      if (headerTimer) {
        clearTimeout(headerTimer);
        headerTimer = undefined;
      }
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = undefined;
      }
    };

    const finishUpstream = () => {
      settled = true;
      clearTimers();
      activeUpstream.delete(upstreamReq);
    };

    const resetIdleTimer = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        if (settled) return;
        finishUpstream();
        upstreamReq.destroy(new Error("Upstream stream idle timeout"));
        upstreamRes?.destroy();
        if (!res.headersSent) {
          writeJsonError(res, 504, "Gateway timeout");
        } else if (!res.writableEnded) {
          res.destroy();
        }
      }, idleTimeoutMs);
    };

    const upstreamReq = transport.request(
      upstreamUrl,
      {
        method: "POST",
        headers: forwardHeaders,
      },
      (response) => {
        upstreamRes = response;
        if (headerTimer) {
          clearTimeout(headerTimer);
          headerTimer = undefined;
        }
        resetIdleTimer();

        const responseHeaders: Record<string, string | string[]> = {};
        for (const [key, value] of Object.entries(response.headers)) {
          if (value === undefined) continue;
          const lower = key.toLowerCase();
          if (DENIED_RESPONSE_HEADERS.has(lower)) continue;
          responseHeaders[lower] = value;
        }
        if (!res.headersSent) {
          res.writeHead(response.statusCode ?? 502, responseHeaders);
        }
        response.on("data", () => resetIdleTimer());
        response.on("end", () => finishUpstream());
        response.on("error", () => {
          finishUpstream();
          if (!res.writableEnded) res.destroy();
        });
        response.pipe(res);
      },
    );

    activeUpstream.add(upstreamReq);

    headerTimer = setTimeout(() => {
      if (settled) return;
      finishUpstream();
      upstreamReq.destroy(new Error("Upstream header timeout"));
      writeJsonError(res, 504, "Gateway timeout");
    }, headerTimeoutMs);

    upstreamReq.on("error", () => {
      if (settled) return;
      finishUpstream();
      if (!res.headersSent) {
        writeJsonError(res, 502, "Upstream router unavailable");
      } else if (!res.writableEnded) {
        res.destroy();
      }
    });

    req.on("aborted", () => {
      finishUpstream();
      upstreamReq.destroy();
      upstreamRes?.destroy();
    });
    res.on("close", () => {
      if (!res.writableEnded) {
        finishUpstream();
        upstreamReq.destroy();
        upstreamRes?.destroy();
      }
    });
    req.on("error", () => {
      finishUpstream();
      upstreamReq.destroy();
      upstreamRes?.destroy();
    });

    req.pipe(upstreamReq);
  };

  const server: Server = http.createServer(handleRequest);
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", rejectListen);
      resolveListen();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Antigravity router bridge did not bind a TCP port");
  }
  expectedHost = `127.0.0.1:${address.port}`;
  const endpoint = `http://${expectedHost}`;

  let closePromise: Promise<void> | undefined;
  return {
    endpoint,
    close(): Promise<void> {
      if (closePromise) return closePromise;
      closed = true;
      for (const req of activeUpstream) {
        req.destroy();
      }
      activeUpstream.clear();
      closePromise = new Promise<void>((resolveClose) => {
        server.close(() => resolveClose());
        server.closeAllConnections?.();
        for (const socket of sockets) {
          socket.destroy();
        }
        sockets.clear();
      });
      return closePromise;
    },
  };
}
