import { describeAntigravityCandidate } from "./antigravity-launch.js";
import { getCliInstallationService } from "../cli-installation-context.js";
import { spawn, type ChildProcess } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { stripYaControlPlaneCredentials } from "./env-filter.js";
import {
  AntigravityVersionError,
  antigravityCliVersionRefusal,
  antigravityVersionRefusal,
  readAgyVersion,
} from "./antigravity-version.js";
import {
  AntigravityPermissionRequests,
  type JsonRpcId,
  type PermissionParams,
} from "./antigravity-permission-requests.js";

export interface AntigravityConfigOption {
  id: string;
  name?: string;
  category?: string;
  type?: string;
  currentValue?: string;
  options?: Array<{
    value: string;
    name?: string;
    description?: string;
  }>;
}

export interface AntigravityUpdate {
  sessionUpdate: string;
  content?: { type?: string; text?: string } | unknown[];
  toolCallId?: string;
  title?: string;
  name?: string;
  kind?: string;
  status?: string;
  rawInput?: unknown;
  rawOutput?: unknown;
  locations?: Array<{ path: string }>;
  availableCommands?: Array<{
    name: string;
    description: string;
    input?: { hint?: string };
  }>;
  configOptions?: AntigravityConfigOption[];
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
  configOptions?: AntigravityConfigOption[];
}

/**
 * Physical conversation store that a concrete launched runtime command will
 * actually open, derived strictly from its actual launch arguments. `agy acp`
 * ignores `GEMINI_HOME` unless `--gemini-dir` is explicitly passed in `args`.
 */
export function antigravityRuntimeStoreDir(
  command: Pick<AntigravityRuntimeCommand, "args">,
): string {
  const flagIndex = command.args.indexOf("--gemini-dir");
  const explicitGeminiDir =
    flagIndex >= 0 ? command.args[flagIndex + 1] : undefined;
  return resolve(
    explicitGeminiDir || join(homedir(), ".gemini"),
    "antigravity-cli",
    "conversations",
  );
}

/**
 * Pin the concrete ACP launch arguments and environment to a verified physical
 * `conversations/` directory so a mutable symlink on `GEMINI_HOME` or `~/.gemini`
 * cannot redirect ACP to a different store between validation and `spawn()`.
 */
export function pinAntigravityLaunchToScope(
  command: Pick<AntigravityRuntimeCommand, "args">,
  physicalScope: string,
  launchEnvironment?: Record<string, string>,
): { args: string[]; env?: Record<string, string> } | null {
  const canPin =
    basename(physicalScope) === "conversations" &&
    basename(dirname(physicalScope)) === "antigravity-cli";
  if (!canPin) {
    // Reject rather than falling back to unpinned arguments when a symlink
    // below the profile directory resolves outside `<profile>/<store>/conversations`.
    return null;
  }
  const physicalGeminiDir = dirname(dirname(physicalScope));
  const args = [...command.args];
  const flagIndex = args.indexOf("--gemini-dir");
  if (flagIndex >= 0 && flagIndex + 1 < args.length) {
    args[flagIndex + 1] = physicalGeminiDir;
    return {
      args,
      env: { ...launchEnvironment, GEMINI_HOME: physicalGeminiDir },
    };
  }
  if (physicalGeminiDir !== resolve(homedir(), ".gemini")) {
    args.push("--gemini-dir", physicalGeminiDir);
    return {
      args,
      env: { ...launchEnvironment, GEMINI_HOME: physicalGeminiDir },
    };
  }
  return { args, env: launchEnvironment };
}

/** The active runtime's native conversation store, derived from the exact
 * command and environment used to launch ACP. Without an installed runtime
 * this names the `agy` CLI store for the effective profile. */
export function antigravitySessionsDir(): string {
  const command = resolveAntigravityRuntime();
  if (command) return antigravityRuntimeStoreDir(command);
  const geminiDir =
    process.env.CLOUD_CODE_URL && process.env.GEMINI_HOME
      ? process.env.GEMINI_HOME
      : join(homedir(), ".gemini");
  return resolve(geminiDir, "antigravity-cli", "conversations");
}

/** The `agy` store keeps each conversation's workspace and lineage here. */
export function antigravitySummariesPath(sessionsDir: string): string {
  return join(dirname(sessionsDir), "conversation_summaries.db");
}

/** How YA starts the `agy` CLI's ACP server (`agy acp`), which shares the
 * CLI's login and `antigravity-cli` store. */
export interface AntigravityRuntimeCommand {
  command: string;
  args: string[];
}

/** Synchronous so the store path can be derived wherever it is needed. */
export function resolveAntigravityRuntime(): AntigravityRuntimeCommand | null {
  // The preview's process-group teardown is qualified only on POSIX hosts.
  if (process.platform === "win32") return null;
  const explicit =
    process.env.ANTIGRAVITY_ACP_PATH ??
    getCliInstallationService()?.selectedPath("antigravity");
  const candidates = explicit
    ? [explicit]
    : (process.env.PATH ?? "")
        .split(delimiter)
        .filter(Boolean)
        .map((directory) => join(directory, "agy"));
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      const descriptor = describeAntigravityCandidate(candidate);
      if (descriptor.error) continue;
      return descriptor.launch;
    } catch {
      /* Continue PATH discovery; an explicit path never falls back. */
    }
  }
  return null;
}

export async function findAntigravityRuntime(): Promise<AntigravityRuntimeCommand | null> {
  return resolveAntigravityRuntime();
}

/** A JSON-RPC error response: the runtime is an ACP peer. */
class AcpErrorResponse extends Error {}

/** A request ID as JSON-RPC allows it. `agy` sends strings; YA sends numbers. */
const isJsonRpcId = (id: unknown): id is JsonRpcId =>
  typeof id === "string" ||
  (typeof id === "number" && Number.isFinite(id)) ||
  id === null;

/** The fields YA needs to put a permission request to its user. */
function isPermissionRequest(params: unknown): params is PermissionParams {
  if (!params || typeof params !== "object") return false;
  const { sessionId, toolCall, options } = params as Record<string, unknown>;
  return (
    typeof sessionId === "string" &&
    !!toolCall &&
    typeof toolCall === "object" &&
    typeof (toolCall as { toolCallId?: unknown }).toolCallId === "string" &&
    Array.isArray(options) &&
    options.every(
      (option) =>
        !!option &&
        typeof option.optionId === "string" &&
        typeof option.kind === "string",
    )
  );
}

/** Native ACP transport. No authenticate/logout calls or credential inspection.
 * The retained shared ACP SDK predates this agent's usage_update notifications.
 * Keep this bounded transport local instead of changing frozen Gemini/Grok.
 */
export class AntigravityRuntime {
  canAppendSystemPrompt = false;
  private child?: ChildProcess;
  private sequence = 0;
  // At most 32 concurrent requests; each leaves on reply, timeout or child exit.
  private pending = new Map<
    number,
    {
      method: string;
      resolve(value: unknown): void;
      reject(error: Error): void;
    }
  >();
  private exited: Promise<void> = Promise.resolve();
  private stopped = false;
  // Aborted only by the owner's close(), never by an internal failure.
  private readonly cancelled = new AbortController();
  private versionProbe?: Promise<unknown>;
  // Requests from the runtime awaiting YA's answer; closed with the connection.
  private readonly permissions = new AntigravityPermissionRequests(
    (id, reply) => {
      if (this.alive && !this.stopped)
        this.send({ jsonrpc: "2.0", id, ...reply });
    },
    () => this.onPermission,
  );
  onUpdate?: (
    update: AntigravityUpdate,
    sessionId: string,
    isReplay?: boolean,
  ) => void;
  /** `signal` aborts when the request ends before YA answers it. */
  onPermission?: (
    params: Record<string, unknown>,
    signal: AbortSignal,
  ) => Promise<unknown>;

  /** When a frame last crossed the pipe either way (`Date.now()`). */
  lastActivityMs = 0;
  /**
   * Mid-exchange: a request awaits its answer, or the runtime is shutting
   * down. What `agy` writes meanwhile is this owner's own work.
   */
  get busy(): boolean {
    return this.stopped || this.pending.size > 0;
  }

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
    launchEnvironment?: Record<string, string>,
  ): Promise<void> {
    if (this.child || this.stopped)
      throw new Error("Antigravity runtime is closed");
    this.child = spawn(command, args, {
      cwd,
      env: {
        ...stripYaControlPlaneCredentials(process.env),
        ...launchEnvironment,
      },
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
        void this.shutdown();
        return;
      }
      let end = buffer.indexOf("\n");
      while (end >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        end = buffer.indexOf("\n");
        if (!line.trim()) continue;
        let message: Record<string, unknown>;
        try {
          message = JSON.parse(line) as Record<string, unknown>;
          if (!message || typeof message !== "object" || Array.isArray(message))
            throw new Error("Expected a JSON-RPC object");
        } catch {
          this.fail(new Error("Invalid Antigravity protocol response"));
          void this.shutdown();
          return;
        }
        try {
          this.receive(message);
        } catch (error) {
          this.fail(error instanceof Error ? error : new Error(String(error)));
          void this.shutdown();
          return;
        }
      }
    });
    // Untrusted: a null, omitted or malformed result reports no version.
    let initialized:
      | {
          agentInfo?: { version?: unknown } | null;
          agentCapabilities?: {
            _meta?: { antigravity?: { systemPrompt?: { append?: unknown } } };
          } | null;
        }
      | null
      | undefined;
    try {
      initialized = await this.call("initialize", {
        protocolVersion: 1,
        clientInfo: { name: "yepanywhere", version: "1.0.0" },
        // Google owns tool execution, file access, and its existing configuration.
        clientCapabilities: {},
      });
    } catch (error) {
      // `agy` before 1.5 has no `acp` subcommand, so it exits, stalls or
      // prints no protocol before `initialize`; its `--version` still names
      // it. A peer that answered, even with an error, keeps that error.
      if (this.cancelled.signal.aborted || error instanceof AcpErrorResponse)
        throw error;
      const probe = readAgyVersion(command, this.cancelled.signal);
      this.versionProbe = probe;
      const version = await probe;
      const refusal =
        version === undefined
          ? undefined
          : antigravityCliVersionRefusal(version);
      throw refusal ? new AntigravityVersionError(refusal) : error;
    }
    const refusal = antigravityVersionRefusal(initialized?.agentInfo?.version);
    if (refusal) throw new AntigravityVersionError(refusal);
    this.canAppendSystemPrompt =
      initialized?.agentCapabilities?._meta?.antigravity?.systemPrompt
        ?.append === true;
  }

  private send(value: unknown): void {
    if (!this.alive || this.stopped)
      throw new Error("Antigravity runtime is unavailable");
    this.lastActivityMs = Date.now();
    this.child!.stdin!.write(`${JSON.stringify(value)}\n`);
  }

  private receive(message: Record<string, unknown>): void {
    this.lastActivityMs = Date.now();
    if (message.jsonrpc !== "2.0") {
      if (typeof message.method === "string" && isJsonRpcId(message.id))
        this.reject(message.id, -32600, "Invalid Request");
      return;
    }
    if (!("method" in message)) {
      // A response: only to a request YA issued, which carries a numeric ID.
      const id = message.id;
      if (typeof id !== "number" || !Number.isSafeInteger(id)) return;
      const pending = this.pending.get(id);
      if (!pending) return;
      // Exactly one of a result or a valid error answers a call. Neither
      // answers only `initialize`, whose missing version is then refused.
      const hasResult = "result" in message;
      const error = message.error as
        | { code?: unknown; message?: unknown; data?: { message?: unknown } }
        | undefined;
      const validError =
        !!error &&
        typeof error === "object" &&
        Number.isInteger(error.code) &&
        typeof error.message === "string";
      const hasError = "error" in message;
      if (hasResult && hasError) return;
      if (hasError && !validError) return;
      if (!hasResult && !hasError && pending.method !== "initialize") return;
      this.settle(id);
      if (validError) {
        const data = error!.data?.message;
        pending.reject(
          new AcpErrorResponse(
            (typeof data === "string" && data) ||
              (error!.message as string) ||
              "Antigravity request failed",
          ),
        );
      } else pending.resolve(message.result);
      return;
    }
    const isRequest = "id" in message;
    if (
      typeof message.method !== "string" ||
      (isRequest && !isJsonRpcId(message.id))
    ) {
      if (isRequest && isJsonRpcId(message.id))
        this.reject(message.id, -32600, "Invalid Request");
      return;
    }
    const params = message.params as Record<string, unknown> | undefined;
    if (!isRequest) {
      if (
        message.method === "session/update" &&
        params?.update &&
        typeof params.sessionId === "string"
      ) {
        const update = params.update as AntigravityUpdate;
        if (
          (update.sessionUpdate === "tool_call" ||
            update.sessionUpdate === "tool_call_update") &&
          typeof update.toolCallId === "string"
        )
          this.permissions.observeToolCall(
            params.sessionId,
            update.toolCallId,
            update.status,
          );
        const meta = params._meta as { isReplay?: unknown } | undefined;
        this.onUpdate?.(
          params.update as AntigravityUpdate,
          params.sessionId,
          meta?.isReplay === true,
        );
      }
      return;
    }
    const id = message.id as JsonRpcId;
    if (message.method !== "session/request_permission")
      this.reject(id, -32601, "Unsupported client method");
    else if (!isPermissionRequest(params))
      this.reject(id, -32602, "Invalid permission request");
    else this.permissions.receive(id, params);
  }

  private reject(id: JsonRpcId, code: number, message: string): void {
    if (this.alive && !this.stopped)
      this.send({ jsonrpc: "2.0", id, error: { code, message } });
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
          method,
          resolve: (value) => resolve(value as T),
          reject,
        });
        if (method === "session/prompt") this.permissions.promptSent();
        if (timeoutMs > 0)
          timer = setTimeout(() => {
            this.settle(id);
            reject(new Error(`Antigravity ${method} timed out`));
            void this.shutdown();
          }, timeoutMs);
        try {
          this.send({ jsonrpc: "2.0", id, method, params });
        } catch (error) {
          this.settle(id);
          reject(error);
        }
      });
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Retires an outbound call synchronously, so a prompt stops counting as
   * outstanding before the next frame in the same write is handled.
   */
  private settle(id: number): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    if (pending.method === "session/prompt") this.permissions.promptAnswered();
  }

  /**
   * `endingTurn` runs just before a turn's or command's result goes to YA:
   * it withdraws the requests raised during it, which an idle session
   * would hide. `turnEnded` runs once YA is idle and puts held requests to
   * the user.
   */
  endingTurn(): void {
    this.permissions.endingTurn();
  }
  turnEnded(): void {
    this.permissions.turnEnded();
  }

  /**
   * Cancels the session's prompt turn, then answers every pending
   * permission request on this connection as cancelled (see
   * AntigravityPermissionRequests).
   */
  cancel(sessionId: string): void {
    this.send({
      jsonrpc: "2.0",
      method: "session/cancel",
      params: { sessionId },
    });
    this.permissions.stop();
  }

  /** The connection is ending: outbound calls fail and inbound intake closes. */
  private fail(error: Error): void {
    this.permissions.close();
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
  }

  /** Stop the runtime, including a version probe in progress, and wait for both. */
  async close(): Promise<void> {
    this.cancelled.abort();
    await this.shutdown();
    await this.versionProbe;
  }

  private async shutdown(): Promise<void> {
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
