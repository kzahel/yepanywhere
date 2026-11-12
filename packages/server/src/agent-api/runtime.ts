import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAdaptorServer } from "@hono/node-server";
import { Hono } from "hono";
import { PRINCIPAL_VARIABLE, type Principal } from "../auth/principal.js";
import {
  API_LAUNCH_VARIABLE,
  API_SIGNAL_VARIABLE,
  type ApiLaunchContext,
  type Operation,
} from "../core-api/contracts.js";
import {
  CoreApi,
  CoreApiError,
  type ApiReadPort,
} from "../core-api/service.js";
import { createV0Routes } from "../routes/v0/index.js";

export type AgentApiController = { serverId: string; read: ApiReadPort };
const MAX_LEASES = 1024;
const LEASE_MS = 24 * 60 * 60 * 1000;
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const independent = new Set<Operation>([
  "describe",
  "help",
  "schema",
  "me",
  "servers",
  "server",
  "access",
  "capabilities",
]);
interface Entry {
  abort: AbortController;
  launchId: string;
  sessionId: () => string | null;
  principal: Principal;
  management?: true;
  peerGrantId?: string;
  expiresAt: number;
}
export interface AgentApiLease {
  launchId: string;
  environment: Record<string, string>;
  /** Only a trusted live provider owner can renew; no HTTP renewal route. */
  renew(): void;
  dispose(): void;
}
export interface AgentApiRuntime {
  readonly serverId: string;
  readonly baseUrl: string;
  readonly socketPath?: string;
  issue(input: {
    principal: Principal;
    sessionId: () => string | null;
    management?: boolean;
    peerAccess?: boolean;
    peerGrantId?: string;
  }): AgentApiLease;
  /** An old detach cannot disconnect a replacement controller. */
  attachController(controller: AgentApiController): () => void;
  revokeAll(): void;
  close(): Promise<void>;
}

/** One bounded local adapter owned by the provider runtime, not a daemon. */
export async function createAgentApiRuntime(options: {
  serverId: string;
  transport?: "unix" | "loopback";
  now?: () => number;
}): Promise<AgentApiRuntime> {
  const now = options.now ?? Date.now;
  const transport =
    options.transport ?? (process.platform === "win32" ? "loopback" : "unix");
  if (transport === "unix" && process.platform === "win32")
    throw new Error("Unix agent API transport is unavailable on Windows");
  if (!options.serverId)
    throw new Error("Agent API requires a public server identity");
  // Lifecycle removal and MAX_LEASES bound idle/expired records without timers.
  const entries = new Map<string, Entry>();
  let controller:
    | { api: AgentApiController; abort: AbortController }
    | undefined;
  let catalogReads = 0;
  let closing = false;
  const unavailable = async (): Promise<never> => {
    throw new CoreApiError(
      "controller_unavailable",
      "Catalog controller is temporarily unavailable",
      503,
    );
  };
  const own = new CoreApi(options.serverId, {
    projects: unavailable,
    sessions: unavailable,
    providers: unavailable,
    managementEnabled: () => true,
  });
  const reader: { read: ApiReadPort } = {
    read: async (operation, caller, input = {}) => {
      if (input.serverId === "self")
        input = { ...input, serverId: options.serverId };
      const peerLease = Boolean(
        input.launch?.peerAccess && input.launch.peerGrantId,
      );
      if (
        !peerLease &&
        input.serverId !== undefined &&
        input.serverId !== options.serverId
      )
        throw new CoreApiError(
          "server_not_found",
          "Server is not configured here",
          404,
        );
      const peerDiscovery =
        peerLease &&
        ["servers", "server", "access", "capabilities"].includes(operation);
      if (
        independent.has(operation) &&
        !peerDiscovery &&
        (!input.serverId || input.serverId === options.serverId)
      )
        return own.read(operation, caller, input);
      const current = controller;
      if (!current) return unavailable();
      // Leave connection headroom for own context even if a catalog stalls.
      if (catalogReads >= 16) return unavailable();
      const signal = AbortSignal.any([
        current.abort.signal,
        ...(input.signal ? [input.signal] : []),
      ]);
      let rejectCancelled!: (error: Error) => void;
      const cancelled = new Promise<never>((_, reject) => {
        rejectCancelled = reject;
      });
      const onAbort = () =>
        rejectCancelled(
          new CoreApiError(
            "controller_unavailable",
            "Catalog read was cancelled or its controller detached",
            503,
          ),
        );
      signal.addEventListener("abort", onAbort, { once: true });
      catalogReads++;
      try {
        if (signal.aborted) onAbort();
        const result = await Promise.race([
          current.api.read(operation, caller, { ...input, signal }),
          cancelled,
        ]);
        if (current !== controller || signal.aborted) return unavailable();
        return result;
      } catch (error) {
        if (current !== controller || signal.aborted) return unavailable();
        throw error;
      } finally {
        catalogReads--;
        signal.removeEventListener("abort", onAbort);
      }
    },
  };
  const app = new Hono<{
    Variables: {
      yaPrincipal: Principal;
      yaApiLaunch: ApiLaunchContext;
      yaApiSignal: AbortSignal;
    };
  }>();
  app.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    // Browsers are not clients of this dedicated endpoint; do not allow CORS.
    if (c.req.header("Origin"))
      return c.json(
        {
          error: {
            code: "forbidden",
            message: "Agent endpoint does not accept browser origins",
          },
        },
        403,
      );
    const authorization = c.req.header("Authorization") ?? "";
    const token = /^Bearer ([A-Za-z0-9_-]{1,256})$/.exec(authorization)?.[1];
    const entry = token ? entries.get(hash(token)) : undefined;
    if (closing || !entry || now() >= entry.expiresAt)
      return c.json(
        {
          error: {
            code: "unauthorized",
            message: "Launch credential is missing, expired or revoked",
          },
        },
        401,
      );
    const hostname = new URL(c.req.url).hostname;
    if (hostname !== "127.0.0.1")
      return c.json(
        {
          error: { code: "forbidden", message: "Invalid agent endpoint host" },
        },
        403,
      );
    c.set(
      API_SIGNAL_VARIABLE,
      AbortSignal.any([c.req.raw.signal, entry.abort.signal]),
    );
    c.set(PRINCIPAL_VARIABLE, entry.principal);
    c.set(API_LAUNCH_VARIABLE, {
      id: entry.sessionId(),
      launchId: entry.launchId,
      ...(entry.management ? { management: true as const } : {}),
      ...(entry.peerGrantId
        ? { peerAccess: true as const, peerGrantId: entry.peerGrantId }
        : {}),
    });
    await next();
  });
  app.route("/v0", createV0Routes(reader));
  app.all("*", (c) =>
    c.json(
      { error: { code: "not_found", message: "Unknown agent API resource" } },
      404,
    ),
  );
  const server = createAdaptorServer({ fetch: app.fetch }) as Server;
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  server.maxHeadersCount = 16;
  server.maxConnections = 32;
  server.keepAliveTimeout = 1000;
  let directory: string | undefined;
  let socketPath: string | undefined;
  try {
    if (transport === "unix") {
      directory = await mkdtemp(join(tmpdir(), "ya-api-"));
      await chmod(directory, 0o700);
      socketPath = join(directory, "api.sock");
      // Keep within the smallest supported Unix pathname budget, including NUL.
      if (Buffer.byteLength(socketPath) > 100)
        throw new Error("Agent API socket path is too long");
    }
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      const ready = () => {
        server.off("error", reject);
        resolve();
      };
      if (socketPath) server.listen(socketPath, ready);
      else server.listen(0, "127.0.0.1", ready);
    });
    if (socketPath) await chmod(socketPath, 0o600);
    server.unref();
  } catch (error) {
    server.closeAllConnections();
    if (server.listening)
      await new Promise<void>((resolve) => server.close(() => resolve()));
    if (directory) await rm(directory, { recursive: true, force: true });
    throw error;
  }
  const address = server.address();
  const baseUrl = socketPath
    ? "http://127.0.0.1"
    : `http://127.0.0.1:${typeof address === "object" && address ? address.port : ""}`;
  let closePromise: Promise<void> | undefined;
  return {
    serverId: options.serverId,
    baseUrl,
    socketPath,
    issue(input) {
      if (closing) throw new Error("Agent API runtime is closed");
      if (input.principal.kind !== "superuser")
        throw new Error("Restricted agent API launch is not qualified");
      if (entries.size >= MAX_LEASES)
        throw new Error("Agent API lease capacity exceeded");
      const token = randomBytes(32).toString("base64url");
      const key = hash(token);
      const entry: Entry = {
        abort: new AbortController(),
        launchId: randomUUID(),
        sessionId: input.sessionId,
        principal: input.principal,
        ...(input.management ? { management: true as const } : {}),
        ...(input.peerAccess && input.management && input.peerGrantId
          ? { peerGrantId: input.peerGrantId }
          : {}),
        expiresAt: now() + LEASE_MS,
      };
      entries.set(key, entry);
      return {
        launchId: entry.launchId,
        environment: {
          AGENT_YA_V0_URL: baseUrl,
          AGENT_YA_V0_AUTHORIZATION: `Bearer ${token}`,
          ...(socketPath ? { AGENT_YA_V0_SOCKET: socketPath } : {}),
        },
        renew() {
          if (entries.get(key) === entry) entry.expiresAt = now() + LEASE_MS;
        },
        dispose() {
          entry.abort.abort();
          entries.delete(key);
        },
      };
    },
    attachController(next) {
      if (closing || next.serverId !== options.serverId)
        throw new Error("Agent API controller identity mismatch");
      const previous = controller;
      const attachment = { api: next, abort: new AbortController() };
      controller = attachment;
      previous?.abort.abort();
      return () => {
        if (controller === attachment) {
          controller = undefined;
          attachment.abort.abort();
        }
      };
    },
    revokeAll() {
      for (const entry of entries.values()) entry.abort.abort();
      entries.clear();
    },
    close() {
      closePromise ??= (async () => {
        closing = true;
        for (const entry of entries.values()) entry.abort.abort();
        entries.clear();
        controller?.abort.abort();
        controller = undefined;
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        if (directory) await rm(directory, { recursive: true, force: true });
      })();
      return closePromise;
    },
  };
}
