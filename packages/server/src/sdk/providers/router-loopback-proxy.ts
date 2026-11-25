import { timingSafeEqual } from "node:crypto";
import http, {
  type ClientRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import https from "node:https";
import type { Socket } from "node:net";

/**
 * Request headers the local program does not get to set on the router's
 * route: every header AAR reads a credential from, the connection's own, and
 * the ones a hosted router's reverse proxy is trusted to set. The rest pass
 * through, and the router keeps its own per-provider list of what reaches the
 * provider.
 */
const DENIED_REQUEST_HEADERS = new Set([
  "authorization",
  "x-api-key",
  "connection",
  "cookie",
  "expect",
  "forwarded",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "x-real-ip",
]);
const deniedRequestHeader = (name: string) =>
  DENIED_REQUEST_HEADERS.has(name) ||
  name.startsWith("x-forwarded-") ||
  name.startsWith("x-aar-");

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

/** Header names a `Connection` header marks as belonging to one hop. */
function connectionScoped(value: string | string[] | undefined): Set<string> {
  const names = new Set<string>();
  for (const part of [value ?? []].flat().join(",").split(","))
    if (part.trim()) names.add(part.trim().toLowerCase());
  return names;
}

/**
 * Methods whose requests Node sends without body framing. A body forwarded
 * on one would reach the router as the start of a second request, past the
 * checks made here. Their bodies are never forwarded: the header check below
 * only names the refusal, since Node can frame a body by a header it left
 * out of `req.headers`.
 */
const BODYLESS_METHODS = new Set(["GET", "HEAD", "DELETE", "OPTIONS", "TRACE"]);

const UPSTREAM_HEADER_TIMEOUT_MS = 120_000;
const UPSTREAM_STREAM_IDLE_TIMEOUT_MS = 600_000;
/** One native program's connection pool, with room to spare. */
const MAX_CONNECTIONS = 64;
const REQUEST_HEADERS_TIMEOUT_MS = 15_000;
/** Node enforces the timeout above only this often. */
const HEADERS_CHECK_INTERVAL_MS = 5_000;

export interface RouterLoopbackProxy {
  /** Loopback origin the native program is pointed at. */
  readonly endpoint: string;
  /** Stop accepting requests, abort active upstream calls, and release the port. */
  close(): Promise<void>;
}

function validateUpstreamBaseUrl(raw: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("Invalid AAR inference base URL");
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
    throw new Error("Unsupported AAR inference base URL");
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

/**
 * The request target as a path below the binding's route, or null. Dot
 * segments are resolved here and encoded ones refused, so the forwarded
 * request cannot leave that route.
 */
function routeTarget(rawUrl: string | undefined): string | null {
  if (!rawUrl?.startsWith("/") || rawUrl.startsWith("//")) return null;
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
  return `${parsed.pathname}${parsed.search}`;
}

/**
 * Start a loopback proxy for one routed session whose native program cannot
 * be handed the binding token.
 *
 * The program is given `localToken`, which is accepted only here. The proxy
 * requires its own `Host` and that token on every request, replaces the token
 * with the session's binding token, held only in memory, and forwards the
 * request to the binding's route. It names no provider endpoint: the router
 * decides which paths and methods that route serves. It relays plain HTTP
 * exchanges only, with no CONNECT, no upgrade, and no body on a method that
 * defines none.
 *
 * The proxy accepts whatever stand-in its caller chose. A program that can
 * read that value can spend this binding through this port while it is open.
 * Callers that share one stand-in across sessions open every such port to it.
 */
export async function startRouterLoopbackProxy(options: {
  /** The binding's route: the checked inference origin plus its base path. */
  baseUrl: string;
  /** The binding token. Never given to the native program. */
  token: string;
  /** The stand-in credential the native program presents. */
  localToken: string;
  upstreamHeaderTimeoutMs?: number;
  upstreamStreamIdleTimeoutMs?: number;
}): Promise<RouterLoopbackProxy> {
  if (!options.token || !options.localToken) {
    throw new Error("Router loopback proxy requires a token and a local token");
  }
  if (options.token === options.localToken) {
    throw new Error(
      "Router loopback proxy refuses the binding token as its local token",
    );
  }
  const upstreamBase = validateUpstreamBaseUrl(options.baseUrl);
  const basePath = upstreamBase.pathname.replace(/\/+$/, "");
  // A binding's route is a path on the origin. With none, a request target
  // could name another authority, which would then be sent the token.
  if (!basePath) {
    throw new Error("Router loopback proxy requires a route below the origin");
  }
  const headerTimeoutMs =
    options.upstreamHeaderTimeoutMs ?? UPSTREAM_HEADER_TIMEOUT_MS;
  const idleTimeoutMs =
    options.upstreamStreamIdleTimeoutMs ?? UPSTREAM_STREAM_IDLE_TIMEOUT_MS;
  const expectedAuth = `Bearer ${options.localToken}`;
  const sockets = new Set<Socket>();
  const activeUpstream = new Set<ClientRequest>();
  let expectedHost = "";
  let closed = false;

  const handleRequest = (req: IncomingMessage, res: ServerResponse): void => {
    if (closed) {
      writeJsonError(res, 503, "Proxy closed");
      return;
    }
    // A page in a browser reaches loopback under its own Host.
    if (req.headers.host !== expectedHost) {
      writeJsonError(res, 403, "Forbidden host");
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
    const target = routeTarget(req.url);
    if (!target) {
      writeJsonError(res, 400, "Invalid request target");
      return;
    }

    const method = req.method ?? "";
    const bodyless = BODYLESS_METHODS.has(method);
    if (
      bodyless &&
      (req.headers["transfer-encoding"] !== undefined ||
        Number(req.headers["content-length"] ?? 0) !== 0)
    ) {
      writeJsonError(res, 400, "Request body not accepted for this method");
      return;
    }

    const hopHeaders = connectionScoped(req.headers.connection);
    const forwardHeaders: Record<string, string | string[]> = {};
    for (const [name, value] of Object.entries(req.headers)) {
      if (
        value === undefined ||
        deniedRequestHeader(name) ||
        hopHeaders.has(name)
      )
        continue;
      forwardHeaders[name] = value;
    }
    forwardHeaders.authorization = `Bearer ${options.token}`;

    const upstreamUrl = new URL(`${basePath}${target}`, upstreamBase.origin);
    if (
      upstreamUrl.origin !== upstreamBase.origin ||
      !upstreamUrl.pathname.startsWith(`${basePath}/`)
    ) {
      writeJsonError(res, 400, "Invalid request target");
      return;
    }
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
        method,
        headers: forwardHeaders,
      },
      (response) => {
        upstreamRes = response;
        if (headerTimer) {
          clearTimeout(headerTimer);
          headerTimer = undefined;
        }
        resetIdleTimer();

        const responseHop = connectionScoped(response.headers.connection);
        const responseHeaders: Record<string, string | string[]> = {};
        for (const [key, value] of Object.entries(response.headers)) {
          if (value === undefined) continue;
          const lower = key.toLowerCase();
          if (DENIED_RESPONSE_HEADERS.has(lower) || responseHop.has(lower))
            continue;
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

    if (bodyless) {
      upstreamReq.end();
      req.resume();
    } else req.pipe(upstreamReq);
  };

  const server: Server = http.createServer(
    { connectionsCheckingInterval: HEADERS_CHECK_INTERVAL_MS },
    handleRequest,
  );
  // The route serves plain HTTP exchanges; nothing here relays a tunnel.
  server.on("upgrade", (_req, socket) => socket.destroy());
  server.on("connect", (_req, socket) => socket.destroy());
  // Unauthenticated connections are bounded in number and in time to speak.
  server.maxConnections = MAX_CONNECTIONS;
  server.headersTimeout = REQUEST_HEADERS_TIMEOUT_MS;
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
    throw new Error("Router loopback proxy did not bind a TCP port");
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
