/**
 * How a request reached this server, so a settings change can tell whether it
 * would cut off its own caller (topics/connection-safe-settings.md).
 */
import type { Context } from "hono";

export type RequestConnectionPath =
  /** Through the relay; independent of this server's listening sockets. */
  | { kind: "relay" }
  /** Through one of this server's listening sockets. */
  | {
      kind: "listener";
      localAddress: string;
      localPort: number;
      /** Host header the client used, when it sent one. */
      host: string | null;
    }
  /** Server-originated or otherwise not attributable to a connection. */
  | { kind: "unknown" };

/**
 * Private request environment for requests tunneled over an application
 * WebSocket, which carry no socket of their own: the path recorded when that
 * WebSocket connected.
 */
export const REQUEST_CONNECTION_PATH = Symbol("request-connection-path");

const UNKNOWN: RequestConnectionPath = { kind: "unknown" };

interface IncomingSocketEnv {
  incoming?: {
    socket?: { localAddress?: string; localPort?: number };
    headers?: { host?: string };
  };
}

/** The listener path of a request that arrived on an HTTP socket. */
export function listenerPathFromIncoming(
  env: unknown,
  host: string | null | undefined,
): RequestConnectionPath {
  const socket = (env as IncomingSocketEnv | undefined)?.incoming?.socket;
  if (!socket?.localAddress || typeof socket.localPort !== "number")
    return UNKNOWN;
  return {
    kind: "listener",
    localAddress: socket.localAddress,
    localPort: socket.localPort,
    host: host ?? null,
  };
}

export function getRequestConnectionPath(c: Context): RequestConnectionPath {
  const env = c.env as
    | { [REQUEST_CONNECTION_PATH]?: RequestConnectionPath }
    | undefined;
  const tunneled = env?.[REQUEST_CONNECTION_PATH];
  if (tunneled) return tunneled;
  return listenerPathFromIncoming(c.env, c.req.header("host"));
}

const wsConnectionPaths = new WeakMap<object, RequestConnectionPath>();

/** Record how an application WebSocket connected, keyed by its state. */
export function recordWsConnectionPath(
  connection: object,
  path: RequestConnectionPath,
): void {
  wsConnectionPaths.set(connection, path);
}

export function wsConnectionPath(connection: {
  transport: "direct" | "relay";
}): RequestConnectionPath {
  if (connection.transport === "relay") return { kind: "relay" };
  return wsConnectionPaths.get(connection) ?? UNKNOWN;
}
