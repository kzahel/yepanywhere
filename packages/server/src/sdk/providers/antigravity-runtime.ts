import { spawn, type ChildProcess } from "node:child_process";
import { accessSync, constants, existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { stripYaControlPlaneCredentials } from "./env-filter.js";
import type { SDKMessage } from "../types.js";

export interface AntigravityUpdate {
  sessionUpdate: string;
  content?: { type?: string; text?: string } | unknown[];
  toolCallId?: string;
  title?: string;
  kind?: string;
  status?: string;
  rawInput?: unknown;
  rawOutput?: unknown;
  locations?: Array<{ path: string }>;
}

export interface AntigravitySessionSetup {
  sessionId?: string;
  models?: {
    currentModelId: string;
    availableModels: Array<{ modelId: string; name: string }>;
  };
  modes?: {
    currentModeId: string;
    availableModes: Array<{ id: string; name?: string }>;
  };
}

/** The active runtime's native conversation store. Without an installed
 * runtime this names the `agy` CLI store, the current distribution. */
export function antigravitySessionsDir(): string {
  const layout = resolveAntigravityRuntime()?.layout ?? "cli";
  return resolve(
    process.env.GEMINI_HOME || join(homedir(), ".gemini"),
    layout === "cli" ? "antigravity-cli" : "antigravity-acp",
    "conversations",
  );
}

/** The `agy` CLI store keeps per-conversation workspaces here, not in `.meta`. */
export function antigravitySummariesPath(sessionsDir: string): string {
  return join(dirname(sessionsDir), "conversation_summaries.db");
}

// One entry per live preview owner; removed when its iterator closes. The preview
// stays in-process so readers never replay a database held by another owner.
interface NativeSessionOwner {
  history?: Map<string, SDKMessage>;
  bytes: number;
  /** A bounded history read, which a live session may wait out. */
  historyRead: boolean;
  released: Promise<void>;
}
const ownedNativeSessions = new Map<string, NativeSessionOwner>();
export function antigravityLiveHistory(
  scope: string,
  id: string,
): SDKMessage[] | undefined {
  const history = ownedNativeSessions.get(`${scope}\0${id}`)?.history;
  return history ? structuredClone([...history.values()]) : undefined;
}
export function antigravitySessionOwned(scope: string, id: string): boolean {
  return ownedNativeSessions.has(`${scope}\0${id}`);
}
/**
 * Own a native session for a live run, first waiting out any history read:
 * opening a cold session reads it while the user may already be sending.
 * Another live owner still refuses.
 */
export async function ownAntigravitySessionAfterReads(
  scope: string,
  id: string,
  signal: AbortSignal,
) {
  for (;;) {
    const current = ownedNativeSessions.get(`${scope}\0${id}`);
    if (!current?.historyRead) return ownAntigravitySession(scope, id);
    await new Promise<void>((resolve, reject) => {
      const abort = () =>
        reject(new Error("Antigravity session start aborted"));
      if (signal.aborted) return abort();
      signal.addEventListener("abort", abort, { once: true });
      void current.released.then(() => {
        signal.removeEventListener("abort", abort);
        resolve();
      });
    });
  }
}
export function ownAntigravitySession(
  scope: string,
  id: string,
  options: { historyRead?: boolean } = {},
) {
  const key = `${scope}\0${id}`;
  if (ownedNativeSessions.has(key))
    throw new Error("Antigravity session already has a local owner");
  let release!: () => void;
  const owner: NativeSessionOwner = {
    bytes: 0,
    historyRead: options.historyRead === true,
    released: new Promise<void>((resolve) => {
      release = resolve;
    }),
  };
  ownedNativeSessions.set(key, owner);
  return {
    release: () => {
      if (ownedNativeSessions.get(key) !== owner) return;
      ownedNativeSessions.delete(key);
      release();
    },
    record(message: SDKMessage) {
      if (!message.uuid)
        throw new Error("Antigravity projection requires a message ID");
      owner.history ??= new Map();
      const previous = owner.history.get(message.uuid);
      const bytes =
        owner.bytes +
        Buffer.byteLength(JSON.stringify(message), "utf8") -
        (previous ? Buffer.byteLength(JSON.stringify(previous), "utf8") : 0);
      if (
        bytes > 8 * 1024 * 1024 ||
        (!previous && owner.history.size >= 10_000)
      )
        throw new Error(
          "Antigravity live history exceeds the experimental history limit",
        );
      owner.bytes = bytes;
      owner.history.set(message.uuid, structuredClone(message));
    },
  };
}

/** How YA starts Antigravity's ACP server, and which native store it writes.
 * `cli`: the `agy` CLI's built-in `agy acp` (1.5+), sharing the CLI's login and
 * `antigravity-cli` store. `acp`: the standalone ACP distribution (1.4.x). */
export interface AntigravityRuntimeCommand {
  command: string;
  args: string[];
  layout: "cli" | "acp";
}

function layoutFor(path: string): AntigravityRuntimeCommand["layout"] {
  return basename(path) === "agy" ? "cli" : "acp";
}

// Positive resolutions only, so installing a runtime later is still noticed.
let resolved: { key: string; runtime: AntigravityRuntimeCommand } | undefined;

/** Synchronous so the store path can be derived wherever it is needed. */
export function resolveAntigravityRuntime(): AntigravityRuntimeCommand | null {
  // The preview's process-group teardown is qualified only on POSIX hosts.
  if (process.platform === "win32") return null;
  const explicit = process.env.ANTIGRAVITY_ACP_PATH;
  const key = `${explicit ?? ""}\0${process.env.PATH ?? ""}`;
  if (resolved?.key === key && existsSync(resolved.runtime.command))
    return resolved.runtime;
  const names = ["agy", "agy_acp_server.par", "antigravity-acp"];
  const directories = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  // Name order wins over PATH order: the CLI's built-in server is preferred.
  const candidates = explicit
    ? [explicit]
    : names.flatMap((name) =>
        directories.map((directory) => join(directory, name)),
      );
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      // Resolve launcher symlinks so Google's companion harness stays beside it.
      const command = realpathSync(candidate);
      const layout = layoutFor(candidate);
      const runtime = {
        command,
        args: layout === "cli" ? ["acp"] : [],
        layout,
      };
      resolved = { key, runtime };
      return runtime;
    } catch {
      /* Continue PATH discovery; an explicit path never falls back. */
    }
  }
  return null;
}

export async function findAntigravityRuntime(): Promise<AntigravityRuntimeCommand | null> {
  return resolveAntigravityRuntime();
}

/** Native ACP transport. No authenticate/logout calls or credential inspection.
 * The retained shared ACP SDK predates this agent's usage_update notifications.
 * Keep this bounded transport local instead of changing frozen Gemini/Grok.
 */
export class AntigravityRuntime {
  private child?: ChildProcess;
  private sequence = 0;
  // At most 32 concurrent requests; each leaves on reply, timeout or child exit.
  private pending = new Map<
    number,
    {
      resolve(value: unknown): void;
      reject(error: Error): void;
    }
  >();
  private exited: Promise<void> = Promise.resolve();
  private stopped = false;
  onUpdate?: (update: AntigravityUpdate, sessionId: string) => void;
  onPermission?: (params: Record<string, unknown>) => Promise<unknown>;

  get pid(): number | undefined {
    return this.child?.pid;
  }
  get closed(): Promise<void> {
    return this.exited;
  }
  get alive(): boolean {
    return (
      !!this.child?.pid &&
      this.child.exitCode === null &&
      this.child.signalCode === null
    );
  }

  async connect(
    command: string,
    cwd: string,
    args: string[] = [],
  ): Promise<void> {
    if (this.child || this.stopped)
      throw new Error("Antigravity runtime is closed");
    this.child = spawn(command, args, {
      cwd,
      env: stripYaControlPlaneCredentials({ ...process.env }),
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    const child = this.child;
    this.exited = new Promise<void>((done) => {
      child.once("close", () => {
        this.fail(new Error("Antigravity runtime closed"));
        done();
      });
    });
    child.once("error", (error) => this.fail(error));
    child.stdin?.on("error", (error) => this.fail(error));
    // Drain native diagnostics without logging OAuth URLs or credential details.
    child.stderr?.resume();
    let buffer = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer, "utf8") > 16 * 1024 * 1024) {
        this.fail(new Error("Antigravity protocol frame exceeds 16 MiB"));
        void this.close();
        return;
      }
      let end = buffer.indexOf("\n");
      while (end >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        end = buffer.indexOf("\n");
        if (!line.trim()) continue;
        try {
          this.receive(JSON.parse(line) as Record<string, unknown>);
        } catch {
          this.fail(new Error("Invalid Antigravity protocol response"));
          void this.close();
        }
      }
    });
    await this.call("initialize", {
      protocolVersion: 1,
      clientInfo: { name: "yepanywhere", version: "1.0.0" },
      // Google owns tool execution, file access, and its existing configuration.
      clientCapabilities: {},
    });
  }

  private send(value: unknown): void {
    if (!this.alive || this.stopped)
      throw new Error("Antigravity runtime is unavailable");
    this.child!.stdin!.write(`${JSON.stringify(value)}\n`);
  }

  private receive(message: Record<string, unknown>): void {
    if (typeof message.id === "number" && !message.method) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) {
        const error = message.error as {
          message?: string;
          data?: { message?: string };
        };
        pending.reject(
          new Error(
            error.data?.message ||
              error.message ||
              "Antigravity request failed",
          ),
        );
      } else pending.resolve(message.result);
      return;
    }
    const params = message.params as Record<string, unknown> | undefined;
    if (
      message.method === "session/update" &&
      params?.update &&
      typeof params.sessionId === "string"
    ) {
      this.onUpdate?.(params.update as AntigravityUpdate, params.sessionId);
    } else if (
      message.method === "session/request_permission" &&
      typeof message.id === "number"
    ) {
      const id = message.id;
      void (
        this.onPermission?.(params ?? {}) ??
        Promise.resolve({ outcome: { outcome: "cancelled" } })
      )
        .catch(() => ({ outcome: { outcome: "cancelled" } }))
        .then((result) => {
          if (this.alive && !this.stopped)
            this.send({ jsonrpc: "2.0", id, result });
        });
    } else if (message.method && message.id !== undefined) {
      this.send({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32601, message: "Unsupported client method" },
      });
    }
  }

  async call<T = unknown>(
    method: string,
    params: unknown,
    timeoutMs = 30_000,
  ): Promise<T> {
    if (this.pending.size >= 32)
      throw new Error("Too many Antigravity requests");
    const id = ++this.sequence;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await new Promise<T>((resolve, reject) => {
        this.pending.set(id, {
          resolve: (value) => resolve(value as T),
          reject,
        });
        if (timeoutMs > 0)
          timer = setTimeout(() => {
            this.pending.delete(id);
            reject(new Error(`Antigravity ${method} timed out`));
            void this.close();
          }, timeoutMs);
        try {
          this.send({ jsonrpc: "2.0", id, method, params });
        } catch (error) {
          this.pending.delete(id);
          reject(error);
        }
      });
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  cancel(sessionId: string): void {
    this.send({
      jsonrpc: "2.0",
      method: "session/cancel",
      params: { sessionId },
    });
  }

  private fail(error: Error): void {
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
  }

  async close(): Promise<void> {
    if (this.stopped) return this.exited;
    this.stopped = true;
    this.fail(new Error("Antigravity runtime closed"));
    const pid = this.child?.pid;
    const kill = (signal: NodeJS.Signals) => {
      if (!pid) return;
      try {
        if (process.platform === "win32") this.child?.kill(signal);
        else process.kill(-pid, signal);
      } catch {
        /* Already exited. */
      }
    };
    kill("SIGTERM");
    const escalation = setTimeout(() => kill("SIGKILL"), 2_000);
    try {
      await this.exited;
    } finally {
      clearTimeout(escalation);
      this.onUpdate = undefined;
      this.onPermission = undefined;
    }
  }
}
