/**
 * Codex Provider implementation using codex app-server JSON-RPC.
 *
 * Uses `codex app-server --listen stdio://` for turn execution so we can handle
 * server-initiated permission requests (command/file approval).
 */

import { type ChildProcess, exec, spawn } from "node:child_process";
import { promisify } from "node:util";
import type { ModelInfo } from "@yep-anywhere/shared";
import {
  isCodexCorrelationDebugEnabled,
  logCodexCorrelationDebug,
  summarizeCodexNormalizedMessage,
} from "../../codex/correlationDebugLogger.js";
import {
  type CodexToolCallContext,
  normalizeCodexCommandExecutionOutput,
  normalizeCodexToolInvocation,
} from "../../codex/normalization.js";
import { getLogger } from "../../logging/logger.js";
import { findCodexCliPath, whichCommand } from "../cli-detection.js";
import { logSDKMessage } from "../messageLogger.js";
import { MessageQueue } from "../messageQueue.js";
import type {
  SDKMessage,
  TimestampedSDKMessage,
  UserMessage,
} from "../types.js";
import type { ToolApprovalResult } from "../types.js";
import type {
  AskForApproval as CodexAskForApproval,
  ErrorNotification as CodexErrorNotification,
  ItemCompletedNotification as CodexItemCompletedNotification,
  ItemStartedNotification as CodexItemStartedNotification,
  SandboxMode as CodexSandboxMode,
  ThreadItem as CodexThreadItem,
  CommandExecutionApprovalDecision,
  CommandExecutionRequestApprovalParams,
  FileChangeApprovalDecision,
  FileChangeRequestApprovalParams,
  ThreadResumeParams,
  ThreadResumeResponse,
  ThreadStartParams,
  ThreadStartResponse,
  ThreadTokenUsageUpdatedNotification,
  ToolRequestUserInputParams,
  ToolRequestUserInputResponse,
  TurnCompletedNotification,
  TurnStartParams,
  TurnStartResponse,
} from "./codex-protocol/index.js";
import type {
  AgentProvider,
  AgentSession,
  AuthStatus,
  StartSessionOptions,
} from "./types.js";

const log = getLogger().child({ component: "codex-provider" });
const execAsync = promisify(exec);

function logSdkCorrelationDebug(
  sessionId: string,
  message: SDKMessage,
  metadata: {
    eventKind?: string;
    turnId?: string;
    itemId?: string;
    callId?: string;
    phase?: string;
    sourceEvent?: string;
    status?: string;
  } = {},
): void {
  if (!isCodexCorrelationDebugEnabled()) return;
  logCodexCorrelationDebug({
    sessionId,
    channel: "sdk",
    authority: "transient",
    ...metadata,
    ...summarizeCodexNormalizedMessage(message),
  });
}

function withCodexTimestamp<T extends SDKMessage>(
  message: T,
  timestamp = new Date().toISOString(),
): TimestampedSDKMessage<T> {
  if (
    typeof message.timestamp === "string" &&
    message.timestamp.trim().length > 0
  ) {
    return message as TimestampedSDKMessage<T>;
  }
  return {
    ...message,
    timestamp,
  } as TimestampedSDKMessage<T>;
}

const MODEL_CACHE_TTL_MS = 60 * 60 * 1000;
const MODEL_LIST_TIMEOUT_MS = 8000;
const APP_SERVER_INIT_REQUEST_ID = 1;
const APP_SERVER_MODEL_LIST_REQUEST_ID = 2;
const APP_SERVER_SHUTDOWN_GRACE_MS = 1500;

/**
 * Local debug knobs for Codex app-server policy behavior.
 *
 * Set `approvalPolicy` to `"untrusted"` to force Codex to request approval for
 * command/file actions more aggressively, even when `"on-request"` would not.
 * Leave as `null` for normal behavior.
 */
const CODEX_POLICY_OVERRIDES: {
  approvalPolicy: CodexAskForApproval | null;
  sandbox: CodexSandboxMode | null;
} = {
  approvalPolicy: null,
  sandbox: null,
};

/**
 * When enabled, declare Codex session originator as "Codex Desktop"
 * when initializing app-server sessions.
 */
const DECLARE_CODEX_ORIGINATOR = true;
const DECLARED_CODEX_ORIGINATOR = "Codex Desktop";

const PREFERRED_MODEL_ORDER = [
  "gpt-5.3-codex",
  "gpt-5.2-codex",
  "gpt-5.1-codex-max",
  "gpt-5.2",
  "gpt-5.1-codex-mini",
] as const;

const FALLBACK_CODEX_MODELS: ModelInfo[] = [
  { id: "gpt-5.3-codex", name: "GPT-5.3-Codex" },
  { id: "gpt-5.2-codex", name: "GPT-5.2-Codex" },
  { id: "gpt-5.1-codex-max", name: "GPT-5.1-Codex-Max" },
  { id: "gpt-5.2", name: "GPT-5.2" },
  { id: "gpt-5.1-codex-mini", name: "GPT-5.1-Codex-Mini" },
];

type JsonRpcId = string | number;

interface JsonRpcError {
  message?: string;
  code?: number;
  data?: unknown;
}

interface JsonRpcResponse {
  id?: JsonRpcId;
  result?: unknown;
  error?: JsonRpcError;
}

interface JsonRpcNotification {
  method: string;
  params?: unknown;
}

interface JsonRpcServerRequest extends JsonRpcNotification {
  id: JsonRpcId;
}

interface AppServerModel {
  id: string;
  model?: string;
  displayName?: string;
  description?: string;
  upgrade?: string | null;
}

interface TokenUsageSnapshot {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
}

interface CodexTurnRuntimeState {
  threadId: string;
  activeTurnId: string | null;
}

async function terminateChildProcess(
  child: ChildProcess | null | undefined,
  graceMs = APP_SERVER_SHUTDOWN_GRACE_MS,
): Promise<void> {
  if (!child?.pid || child.killed || child.exitCode !== null) {
    return;
  }

  const exited = new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
  });

  const killTarget =
    process.platform !== "win32" && child.pid > 0 ? -child.pid : child.pid;

  try {
    process.kill(killTarget, "SIGTERM");
  } catch {
    return;
  }

  const timer = setTimeout(() => {
    if (child.exitCode !== null || child.killed) {
      return;
    }
    try {
      process.kill(killTarget, "SIGKILL");
    } catch {
      // Ignore escalation failures during shutdown.
    }
  }, graceMs);

  try {
    await exited;
  } finally {
    clearTimeout(timer);
  }
}

interface NormalizedFileChange {
  path: string;
  kind: "add" | "delete" | "update";
  diff?: string;
}

type NormalizedThreadItem =
  | { id: string; type: "reasoning"; text: string }
  | { id: string; type: "agent_message"; text: string }
  | {
      id: string;
      type: "command_execution";
      command: string;
      aggregated_output: string;
      exit_code?: number;
      status: string;
    }
  | {
      id: string;
      type: "file_change";
      changes: NormalizedFileChange[];
      status: string;
    }
  | {
      id: string;
      type: "mcp_tool_call";
      server: string;
      tool: string;
      arguments: unknown;
      result?: unknown;
      error?: { message: string };
      status: string;
    }
  | { id: string; type: "web_search"; query: string }
  | {
      id: string;
      type: "todo_list";
      items: Array<{ text: string; completed: boolean }>;
    }
  | { id: string; type: "error"; message: string }
  | { id: string; type: "image_view"; path: string };

/**
 * Configuration for Codex provider.
 */
export interface CodexProviderConfig {
  /** Path to codex binary (auto-detected if not specified) */
  codexPath?: string;
  /** API base URL override */
  baseUrl?: string;
  /** API key override (normally read from ~/.codex/auth.json) */
  apiKey?: string;
}

class AsyncQueue<T> {
  private items: T[] = [];
  private waiters: Array<{
    resolve: (value: T) => void;
    reject: (error: Error) => void;
    signal?: AbortSignal;
    onAbort?: () => void;
  }> = [];
  private closedError: Error | null = null;

  push(item: T): void {
    if (this.closedError) return;
    const waiter = this.waiters.shift();
    if (waiter) {
      if (waiter.signal && waiter.onAbort) {
        waiter.signal.removeEventListener("abort", waiter.onAbort);
      }
      waiter.resolve(item);
      return;
    }
    this.items.push(item);
  }

  close(error?: Error): void {
    if (this.closedError) return;
    this.closedError = error ?? new Error("Queue closed");
    for (const waiter of this.waiters) {
      if (waiter.signal && waiter.onAbort) {
        waiter.signal.removeEventListener("abort", waiter.onAbort);
      }
      waiter.reject(this.closedError);
    }
    this.waiters = [];
    this.items = [];
  }

  async shift(signal?: AbortSignal): Promise<T> {
    if (this.items.length > 0) {
      const item = this.items.shift();
      if (item === undefined) {
        throw new Error("Queue underflow");
      }
      return item;
    }

    if (this.closedError) {
      throw this.closedError;
    }

    return await new Promise<T>((resolve, reject) => {
      const waiter: {
        resolve: (value: T) => void;
        reject: (error: Error) => void;
        signal?: AbortSignal;
        onAbort?: () => void;
      } = { resolve, reject, signal };

      if (signal) {
        const onAbort = () => {
          this.waiters = this.waiters.filter((w) => w !== waiter);
          reject(new Error("Operation aborted"));
        };
        waiter.onAbort = onAbort;
        signal.addEventListener("abort", onAbort, { once: true });
      }

      this.waiters.push(waiter);
    });
  }
}

type AppServerRequestHandler = (
  request: JsonRpcServerRequest,
) => Promise<unknown>;

class CodexAppServerClient {
  private process: ChildProcess | null = null;
  private stdoutBuffer = "";

  /** OS PID of the spawned app-server child process */
  get pid(): number | undefined {
    return this.process?.pid;
  }

  isAlive(): boolean {
    const child = this.process;
    return Boolean(child?.pid && child.exitCode === null && !child.killed);
  }
  private nextRequestId = 1;
  private readonly pendingRequests = new Map<
    JsonRpcId,
    {
      resolve: (result: unknown) => void;
      reject: (error: Error) => void;
    }
  >();
  private readonly notifications = new AsyncQueue<JsonRpcNotification>();
  private onServerRequest: AppServerRequestHandler | null = null;
  private closed = false;

  constructor(
    private readonly command: string,
    private readonly cwd: string,
    private readonly env: NodeJS.ProcessEnv,
  ) {}

  setServerRequestHandler(handler: AppServerRequestHandler): void {
    this.onServerRequest = handler;
  }

  async connect(): Promise<void> {
    if (this.process) {
      throw new Error("Codex app-server already connected");
    }

    const child = spawn(this.command, ["app-server", "--listen", "stdio://"], {
      cwd: this.cwd,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
      env: this.env,
      shell: process.platform === "win32",
    });

    this.process = child;

    child.stdout?.on("data", (chunk: Buffer) => {
      this.stdoutBuffer += chunk.toString("utf-8");
      const lines = this.stdoutBuffer.split("\n");
      this.stdoutBuffer = lines.pop() ?? "";
      for (const raw of lines) {
        const line = raw.trim();
        if (!line) continue;
        this.handleJsonRpcLine(line);
      }
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      const stderr = chunk.toString("utf-8").trim();
      if (stderr) {
        log.debug({ stderr }, "codex app-server stderr");
      }
    });

    child.on("error", (error) => {
      this.handleProcessClose(error);
    });

    child.on("exit", (code, signal) => {
      this.handleProcessClose(
        new Error(
          `Codex app-server exited (code=${code ?? "null"}, signal=${signal ?? "null"})`,
        ),
      );
    });

    await new Promise<void>((resolve, reject) => {
      const onSpawn = () => {
        child.off("error", onError);
        resolve();
      };
      const onError = (error: Error) => {
        child.off("spawn", onSpawn);
        reject(error);
      };
      child.once("spawn", onSpawn);
      child.once("error", onError);
    });
  }

  private handleJsonRpcLine(line: string): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch {
      log.debug({ line }, "Ignoring non-JSON app-server line");
      return;
    }

    const method =
      typeof message.method === "string" ? (message.method as string) : null;
    const hasId =
      typeof message.id === "string" || typeof message.id === "number";

    // Server request/notification
    if (method) {
      if (hasId) {
        const request: JsonRpcServerRequest = {
          id: message.id as JsonRpcId,
          method,
          params: message.params,
        };
        this.handleServerRequest(request);
        return;
      }

      this.notifications.push({ method, params: message.params });
      return;
    }

    // Response to our request
    if (hasId) {
      const id = message.id as JsonRpcId;
      const pending = this.pendingRequests.get(id);
      if (!pending) {
        return;
      }
      this.pendingRequests.delete(id);

      if (message.error && typeof message.error === "object") {
        const error = message.error as JsonRpcError;
        pending.reject(new Error(error.message ?? "JSON-RPC request failed"));
        return;
      }

      pending.resolve(message.result);
    }
  }

  private handleServerRequest(request: JsonRpcServerRequest): void {
    const respond = (payload: Record<string, unknown>) => {
      this.sendRaw({
        jsonrpc: "2.0",
        id: request.id,
        ...payload,
      });
    };

    if (!this.onServerRequest) {
      respond({
        error: {
          code: -32601,
          message: `Unhandled server request: ${request.method}`,
        },
      });
      return;
    }

    void this.onServerRequest(request)
      .then((result) => {
        respond({ result: result ?? {} });
      })
      .catch((error) => {
        respond({
          error: {
            code: -32000,
            message:
              error instanceof Error ? error.message : "Server request failed",
          },
        });
      });
  }

  async request<T>(method: string, params?: unknown): Promise<T> {
    if (this.closed) {
      throw new Error("Codex app-server client is closed");
    }

    const id = this.nextRequestId++;

    const resultPromise = new Promise<T>((resolve, reject) => {
      this.pendingRequests.set(id, {
        resolve: (result) => resolve(result as T),
        reject,
      });
    });

    this.sendRaw({
      jsonrpc: "2.0",
      id,
      method,
      params,
    });

    return await resultPromise;
  }

  notify(method: string, params?: unknown): void {
    this.sendRaw({
      jsonrpc: "2.0",
      method,
      ...(params === undefined ? {} : { params }),
    });
  }

  async nextNotification(signal?: AbortSignal): Promise<JsonRpcNotification> {
    return await this.notifications.shift(signal);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;

    const closeError = new Error("Codex app-server client closed");
    for (const pending of this.pendingRequests.values()) {
      pending.reject(closeError);
    }
    this.pendingRequests.clear();
    this.notifications.close(closeError);

    const child = this.process;
    this.process = null;
    void terminateChildProcess(child);
  }

  private handleProcessClose(error: Error): void {
    if (this.closed) return;
    this.closed = true;

    for (const pending of this.pendingRequests.values()) {
      pending.reject(error);
    }
    this.pendingRequests.clear();

    // Emit a terminal error notification so consumers can surface it.
    this.notifications.push({
      method: "error",
      params: {
        error: { message: error.message },
        willRetry: false,
      },
    });
    this.notifications.close(error);
    this.process = null;
  }

  private sendRaw(payload: Record<string, unknown>): void {
    if (!this.process?.stdin || this.closed) {
      return;
    }

    try {
      this.process.stdin.write(`${JSON.stringify(payload)}\n`);
    } catch (error) {
      this.handleProcessClose(
        error instanceof Error
          ? error
          : new Error("Failed to write to codex app-server stdin"),
      );
    }
  }
}

/**
 * Codex Provider implementation using app-server JSON-RPC.
 */
export class CodexProvider implements AgentProvider {
  readonly name = "codex" as const;
  readonly displayName = "Codex";
  readonly supportsPermissionMode = true;
  readonly supportsThinkingToggle = true;
  readonly supportsSlashCommands = false;

  private readonly config: CodexProviderConfig;
  private modelCache: { models: ModelInfo[]; expiresAt: number } | null = null;

  constructor(config: CodexProviderConfig = {}) {
    this.config = config;
  }

  /**
   * Check if the Codex CLI is installed.
   */
  async isInstalled(): Promise<boolean> {
    return this.isCodexCliInstalled();
  }

  /**
   * Check if Codex CLI is installed by looking in PATH and common locations.
   */
  private async isCodexCliInstalled(): Promise<boolean> {
    if (this.config.codexPath) {
      return true;
    }
    return (await findCodexCliPath()) !== null;
  }

  /**
   * Resolve the codex command: explicit config, PATH, or common install locations.
   */
  private async resolveCodexCommand(): Promise<string> {
    if (this.config.codexPath) return this.config.codexPath;
    return (await findCodexCliPath()) ?? "codex";
  }

  private getCodexClientName(): string {
    return DECLARE_CODEX_ORIGINATOR
      ? DECLARED_CODEX_ORIGINATOR
      : "yep-anywhere";
  }

  /**
   * Build environment overrides for Codex subprocesses.
   */
  private getCodexEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (this.config.baseUrl) {
      env.OPENAI_BASE_URL = this.config.baseUrl;
    }
    if (this.config.apiKey) {
      env.OPENAI_API_KEY = this.config.apiKey;
    }
    return env;
  }

  /**
   * Check if Codex is authenticated.
   */
  async isAuthenticated(): Promise<boolean> {
    const authStatus = await this.getAuthStatus();
    return authStatus.authenticated;
  }

  /**
   * Get detailed authentication status.
   * If Codex CLI is installed, assume it's authenticated.
   */
  async getAuthStatus(): Promise<AuthStatus> {
    const installed = await this.isCodexCliInstalled();
    return {
      installed,
      authenticated: installed,
      enabled: installed,
    };
  }

  /**
   * Get available models for Codex cloud.
   * Queries Codex app-server's model/list endpoint with a static fallback.
   */
  async getAvailableModels(): Promise<ModelInfo[]> {
    const now = Date.now();
    if (this.modelCache && this.modelCache.expiresAt > now) {
      return this.modelCache.models;
    }

    let models: ModelInfo[] = [];
    if (await this.isCodexCliInstalled()) {
      models = await this.getModelsFromAppServer();
    }

    if (models.length === 0) {
      models = FALLBACK_CODEX_MODELS;
    }

    this.modelCache = {
      models,
      expiresAt: now + MODEL_CACHE_TTL_MS,
    };

    return models;
  }

  private async getModelsFromAppServer(): Promise<ModelInfo[]> {
    try {
      const appServerModels = await this.requestAppServerModelList();
      return this.normalizeModelList(appServerModels);
    } catch (error) {
      log.debug(
        { error },
        "Failed to query Codex app-server model list, using fallback models",
      );
      return [];
    }
  }

  private async requestAppServerModelList(): Promise<AppServerModel[]> {
    const codexCommand = await this.resolveCodexCommand();
    return new Promise((resolve, reject) => {
      const child = spawn(
        codexCommand,
        ["app-server", "--listen", "stdio://"],
        {
          detached: process.platform !== "win32",
          stdio: ["pipe", "pipe", "pipe"],
          env: this.getCodexEnv(),
          shell: process.platform === "win32",
        },
      );

      let settled = false;
      let stdoutBuffer = "";
      const stderrChunks: string[] = [];

      const finish = (handler: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutHandle);
        void terminateChildProcess(child);
        handler();
      };

      const parseAndHandleLine = (line: string) => {
        let message: JsonRpcResponse;
        try {
          message = JSON.parse(line) as JsonRpcResponse;
        } catch {
          return;
        }

        if (message.id === APP_SERVER_INIT_REQUEST_ID) {
          if (message.error) {
            const errorMessage =
              message.error.message ?? "Codex app-server initialize failed";
            finish(() => reject(new Error(errorMessage)));
            return;
          }

          child.stdin.write(
            `${JSON.stringify({ jsonrpc: "2.0", method: "initialized" })}\n`,
          );
          child.stdin.write(
            `${JSON.stringify({
              jsonrpc: "2.0",
              id: APP_SERVER_MODEL_LIST_REQUEST_ID,
              method: "model/list",
              params: { limit: 100 },
            })}\n`,
          );
          return;
        }

        if (message.id !== APP_SERVER_MODEL_LIST_REQUEST_ID) {
          return;
        }

        if (message.error) {
          const errorMessage =
            message.error.message ?? "Codex app-server model/list failed";
          finish(() => reject(new Error(errorMessage)));
          return;
        }

        const result = message.result as { data?: unknown[] } | undefined;
        const data = Array.isArray(result?.data) ? result.data : [];
        const models: AppServerModel[] = [];

        for (const item of data) {
          if (!item || typeof item !== "object") continue;
          const model = item as AppServerModel;
          if (typeof model.id !== "string") continue;
          models.push(model);
        }

        finish(() => resolve(models));
      };

      const timeoutHandle = setTimeout(() => {
        const stderr = stderrChunks.join("").trim();
        finish(() =>
          reject(
            new Error(
              stderr
                ? `Timed out querying Codex app-server model list: ${stderr}`
                : "Timed out querying Codex app-server model list",
            ),
          ),
        );
      }, MODEL_LIST_TIMEOUT_MS);

      child.stdout.on("data", (chunk: Buffer) => {
        stdoutBuffer += chunk.toString("utf-8");
        const lines = stdoutBuffer.split("\n");
        stdoutBuffer = lines.pop() ?? "";
        for (const raw of lines) {
          const line = raw.trim();
          if (!line) continue;
          parseAndHandleLine(line);
        }
      });

      child.stderr.on("data", (chunk: Buffer) => {
        stderrChunks.push(chunk.toString("utf-8"));
      });

      child.on("error", (error) => {
        finish(() => reject(error));
      });

      child.on("exit", (code, signal) => {
        if (settled) return;
        const stderr = stderrChunks.join("").trim();
        const details = stderr ? ` stderr: ${stderr}` : "";
        finish(() =>
          reject(
            new Error(
              `Codex app-server exited before model/list response (code=${code ?? "null"}, signal=${signal ?? "null"}).${details}`,
            ),
          ),
        );
      });

      child.stdin.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: APP_SERVER_INIT_REQUEST_ID,
          method: "initialize",
          params: {
            clientInfo: {
              name: this.getCodexClientName(),
              version: "dev",
            },
            capabilities: null,
          },
        })}\n`,
      );
    });
  }

  private normalizeModelList(models: AppServerModel[]): ModelInfo[] {
    const orderLookup = new Map<string, number>(
      PREFERRED_MODEL_ORDER.map((id, idx) => [id, idx]),
    );
    const deduped = new Map<string, ModelInfo>();

    for (const model of models) {
      const modelId = (model.model || model.id || "").trim();
      if (!modelId) continue;

      deduped.set(modelId, {
        id: modelId,
        name: this.formatModelName(model.displayName || modelId),
        description: model.description,
      });

      const upgradeId = model.upgrade?.trim();
      if (upgradeId && !deduped.has(upgradeId)) {
        deduped.set(upgradeId, {
          id: upgradeId,
          name: this.formatModelName(upgradeId),
        });
      }
    }

    return [...deduped.values()]
      .map((model, index) => ({
        model,
        index,
        rank: orderLookup.get(model.id) ?? PREFERRED_MODEL_ORDER.length + index,
      }))
      .sort((a, b) => a.rank - b.rank)
      .map((entry) => entry.model);
  }

  private formatModelName(value: string): string {
    return value
      .trim()
      .split("-")
      .map((part) => {
        const lower = part.toLowerCase();
        if (lower === "gpt") return "GPT";
        if (lower === "codex") return "Codex";
        if (lower === "mini") return "Mini";
        if (lower === "max") return "Max";
        if (lower.length === 0) return "";
        return lower.charAt(0).toUpperCase() + lower.slice(1);
      })
      .join("-");
  }

  private mapEffortToReasoningEffort(
    effort?: import("@yep-anywhere/shared").EffortLevel,
    thinking?: import("@yep-anywhere/shared").ThinkingConfig,
  ): "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | undefined {
    if (thinking?.type === "disabled") {
      return "low";
    }
    if (!effort) {
      return undefined;
    }
    switch (effort) {
      case "low":
        return "low";
      case "medium":
        return "medium";
      case "high":
        return "high";
      case "max":
        return "xhigh";
    }
  }

  private mapPermissionModeToThreadPolicy(
    permissionMode?: StartSessionOptions["permissionMode"],
  ): {
    approvalPolicy: CodexAskForApproval;
    sandbox: CodexSandboxMode;
  } {
    const applyOverrides = (policy: {
      approvalPolicy: CodexAskForApproval;
      sandbox: CodexSandboxMode;
    }) => ({
      approvalPolicy:
        CODEX_POLICY_OVERRIDES.approvalPolicy ?? policy.approvalPolicy,
      sandbox: CODEX_POLICY_OVERRIDES.sandbox ?? policy.sandbox,
    });

    if (permissionMode === "bypassPermissions") {
      return applyOverrides({
        approvalPolicy: "never",
        sandbox: "danger-full-access",
      });
    }

    if (permissionMode === "plan") {
      return applyOverrides({
        approvalPolicy: "untrusted",
        sandbox: "read-only",
      });
    }

    if (permissionMode === "acceptEdits") {
      return applyOverrides({
        approvalPolicy: "untrusted",
        sandbox: "workspace-write",
      });
    }

    return applyOverrides({
      // Codex's "on-request" + workspace-write combination can skip mutating
      // approvals for local workspace edits. Start "default" sessions in
      // read-only mode so writes must explicitly request approval, matching the
      // cross-provider "ask before edits" behavior.
      approvalPolicy: "untrusted",
      sandbox: "read-only",
    });
  }

  /**
   * Start a new Codex session.
   */
  async startSession(options: StartSessionOptions): Promise<AgentSession> {
    const queue = new MessageQueue();
    const abortController = new AbortController();
    const runtimeState: CodexTurnRuntimeState = {
      threadId: options.resumeSessionId ?? "",
      activeTurnId: null,
    };

    // Push initial message if provided
    if (options.initialMessage) {
      queue.push(options.initialMessage);
    }

    let activeClient: CodexAppServerClient | null = null;
    const iterator = this.runSession(
      options,
      queue,
      abortController.signal,
      runtimeState,
      (client) => {
        activeClient = client;
      },
    );

    return {
      iterator,
      queue,
      abort: () => {
        abortController.abort();
        activeClient?.close();
      },
      isProcessAlive: () => activeClient?.isAlive() ?? false,
      get pid() {
        return activeClient?.pid;
      },
      steer: async (message) => {
        if (!activeClient) return false;
        if (!runtimeState.threadId || !runtimeState.activeTurnId) return false;

        const userPrompt = this.extractTextFromMessage(message);
        if (!userPrompt) return true;

        try {
          await activeClient.request<{ turnId: string }>("turn/steer", {
            threadId: runtimeState.threadId,
            input: [{ type: "text", text: userPrompt, text_elements: [] }],
            expectedTurnId: runtimeState.activeTurnId,
          });
          return true;
        } catch (error) {
          log.warn(
            {
              threadId: runtimeState.threadId,
              turnId: runtimeState.activeTurnId,
              error: error instanceof Error ? error.message : String(error),
            },
            "Codex turn/steer failed; caller should queue message instead",
          );
          return false;
        }
      },
    };
  }

  /**
   * Main session loop using codex app-server.
   */
  private async *runSession(
    options: StartSessionOptions,
    queue: MessageQueue,
    signal: AbortSignal,
    runtimeState: CodexTurnRuntimeState,
    setActiveClient: (client: CodexAppServerClient) => void,
  ): AsyncIterableIterator<SDKMessage> {
    const codexCommand = await this.resolveCodexCommand();
    const appServer = new CodexAppServerClient(
      codexCommand,
      options.cwd,
      this.getCodexEnv(),
    );
    setActiveClient(appServer);

    let sessionId = options.resumeSessionId ?? "";
    const usageByTurnId = new Map<string, TokenUsageSnapshot>();
    const logMessage = (message: SDKMessage): SDKMessage => {
      const messageSessionId =
        typeof (message as { session_id?: unknown }).session_id === "string"
          ? ((message as { session_id: string }).session_id ?? "unknown")
          : sessionId || "unknown";
      logSDKMessage(messageSessionId, message, { provider: "codex" });
      return message;
    };

    appServer.setServerRequestHandler(async (request) => {
      return await this.handleServerRequestApproval(request, options, signal);
    });

    try {
      await appServer.connect();

      await appServer.request<{ userAgent: string }>("initialize", {
        clientInfo: {
          name: this.getCodexClientName(),
          version: "dev",
        },
        capabilities: null,
      });
      appServer.notify("initialized");

      const policy = this.mapPermissionModeToThreadPolicy(
        options.permissionMode,
      );

      const threadResumeParams: ThreadResumeParams = {
        threadId: options.resumeSessionId ?? sessionId,
        model: options.model ?? null,
        cwd: options.cwd,
        approvalPolicy: policy.approvalPolicy,
        sandbox: policy.sandbox,
      };
      const threadStartParams: ThreadStartParams = {
        model: options.model ?? null,
        cwd: options.cwd,
        approvalPolicy: policy.approvalPolicy,
        sandbox: policy.sandbox,
        experimentalRawEvents: false,
      };
      const threadResult: ThreadResumeResponse | ThreadStartResponse =
        options.resumeSessionId
          ? await appServer.request<ThreadResumeResponse>(
              "thread/resume",
              threadResumeParams,
            )
          : await appServer.request<ThreadStartResponse>(
              "thread/start",
              threadStartParams,
            );

      sessionId = threadResult.thread.id;
      runtimeState.threadId = sessionId;
      log.info(
        {
          sessionId,
          permissionMode: options.permissionMode ?? "default",
          approvalPolicy: policy.approvalPolicy,
          sandbox: policy.sandbox,
          policyOverrides: {
            approvalPolicy: CODEX_POLICY_OVERRIDES.approvalPolicy,
            sandbox: CODEX_POLICY_OVERRIDES.sandbox,
          },
          model: options.model ?? null,
        },
        "Started Codex app-server session thread",
      );

      // Emit init immediately with the real session ID.
      yield logMessage(
        withCodexTimestamp({
          type: "system",
          subtype: "init",
          session_id: sessionId,
          cwd: options.cwd,
        } as SDKMessage),
      );

      const messageGen = queue.generator();
      let isFirstMessage = !options.resumeSessionId;

      for await (const message of messageGen) {
        if (signal.aborted) {
          break;
        }

        let userPrompt = this.extractTextFromMessage(message);
        if (!userPrompt) {
          continue;
        }

        // Prepend global instructions to the first message of new sessions
        if (isFirstMessage && options.globalInstructions) {
          userPrompt = `[Global context]\n${options.globalInstructions}\n\n---\n\n${userPrompt}`;
          isFirstMessage = false;
        } else {
          isFirstMessage = false;
        }

        // Emit user message with UUID from queue to enable deduplication.
        const userMessage = withCodexTimestamp({
          type: "user",
          uuid: message.uuid,
          session_id: sessionId,
          message: {
            role: "user",
            content: userPrompt,
          },
        } as SDKMessage);
        logSdkCorrelationDebug(sessionId, userMessage, {
          eventKind: "user_message",
          phase: "submitted",
          sourceEvent: "queued_input",
        });
        yield logMessage(userMessage);

        const turnStartParams: TurnStartParams = {
          threadId: sessionId,
          input: [{ type: "text", text: userPrompt, text_elements: [] }],
          approvalPolicy: policy.approvalPolicy,
          effort: this.mapEffortToReasoningEffort(
            options.effort,
            options.thinking,
          ),
        };
        const turnResult = await appServer.request<TurnStartResponse>(
          "turn/start",
          turnStartParams,
        );

        const activeTurnId = turnResult.turn.id;
        runtimeState.activeTurnId = activeTurnId;
        log.info(
          {
            sessionId,
            turnId: activeTurnId,
            turnStatus: turnResult.turn.status,
          },
          "Started Codex app-server turn",
        );
        let turnComplete = turnResult.turn.status !== "inProgress";
        let emittedTurnError = false;

        while (!turnComplete && !signal.aborted) {
          const notification = await appServer.nextNotification(signal);

          if (notification.method === "thread/tokenUsage/updated") {
            const usage = this.extractTurnUsage(notification.params);
            if (usage) {
              usageByTurnId.set(usage.turnId, usage.snapshot);
            }
          }

          const messages = this.convertNotificationToSDKMessages(
            notification,
            sessionId,
            usageByTurnId,
          );
          for (const msg of messages) {
            yield logMessage(msg);
          }

          if (this.isTurnTerminalNotification(notification, activeTurnId)) {
            if (notification.method === "error") {
              emittedTurnError = true;
            }
            turnComplete = true;
          }
        }
        runtimeState.activeTurnId = null;

        // If turn failed without an emitted error notification, surface start response error.
        if (
          !emittedTurnError &&
          turnResult.turn.status === "failed" &&
          turnResult.turn.error?.message
        ) {
          yield logMessage({
            type: "error",
            session_id: sessionId,
            error: turnResult.turn.error.message,
          } as SDKMessage);
        }

        yield logMessage({
          type: "result",
          session_id: sessionId,
        } as SDKMessage);
      }
    } catch (error) {
      log.error({ error }, "Error in codex app-server session");
      if (!signal.aborted) {
        yield logMessage({
          type: "error",
          session_id: sessionId,
          error: error instanceof Error ? error.message : String(error),
        } as SDKMessage);
      }
    } finally {
      runtimeState.activeTurnId = null;
      appServer.close();
    }

    yield logMessage({
      type: "result",
      session_id: sessionId,
    } as SDKMessage);
  }

  private isTurnTerminalNotification(
    notification: JsonRpcNotification,
    turnId: string,
  ): boolean {
    if (notification.method === "turn/completed") {
      const params = this.asTurnCompletedNotification(notification.params);
      return params?.turn.id === turnId;
    }

    if (notification.method === "error") {
      const params = this.asErrorNotification(notification.params);
      return params?.turnId === turnId && !params.willRetry;
    }

    return false;
  }

  private extractTurnUsage(params: unknown): {
    turnId: string;
    snapshot: TokenUsageSnapshot;
  } | null {
    const notification = this.asThreadTokenUsageUpdatedNotification(params);
    if (!notification) return null;

    return {
      turnId: notification.turnId,
      snapshot: {
        inputTokens: notification.tokenUsage.last.inputTokens,
        outputTokens: notification.tokenUsage.last.outputTokens,
        cachedInputTokens: notification.tokenUsage.last.cachedInputTokens,
      },
    };
  }

  private async handleServerRequestApproval(
    request: JsonRpcServerRequest,
    options: StartSessionOptions,
    signal: AbortSignal,
  ): Promise<unknown> {
    log.info(
      {
        method: request.method,
        requestId: request.id,
        permissionMode: options.permissionMode ?? "default",
      },
      "Codex app-server sent server request",
    );

    const params =
      request.params && typeof request.params === "object"
        ? (request.params as Record<string, unknown>)
        : {};

    switch (request.method) {
      case "item/commandExecution/requestApproval": {
        const commandParams = this.asCommandExecutionRequestApprovalParams(
          request.params,
        );
        if (!commandParams) {
          log.warn(
            {
              method: request.method,
              requestId: request.id,
            },
            "Codex command approval params invalid; declining",
          );
          return { decision: "decline" as CommandExecutionApprovalDecision };
        }
        log.info(
          {
            method: request.method,
            requestId: request.id,
            threadId: commandParams.threadId,
            turnId: commandParams.turnId,
            itemId: commandParams.itemId,
            command: commandParams.command,
            cwd: commandParams.cwd,
          },
          "Handling Codex command approval request",
        );
        const toolInput = {
          command: commandParams.command,
          cwd: commandParams.cwd,
          reason: commandParams.reason,
          commandActions: commandParams.commandActions ?? [],
          proposedExecpolicyAmendment:
            commandParams.proposedExecpolicyAmendment ?? null,
          threadId: commandParams.threadId,
          turnId: commandParams.turnId,
          itemId: commandParams.itemId,
        };
        const decision: CommandExecutionApprovalDecision =
          await this.resolveApprovalDecision(
            options,
            "Bash",
            toolInput,
            signal,
            "accept",
            "decline",
          );
        log.info(
          {
            method: request.method,
            requestId: request.id,
            threadId: commandParams.threadId,
            turnId: commandParams.turnId,
            itemId: commandParams.itemId,
            decision,
          },
          "Resolved Codex command approval request",
        );
        return { decision };
      }

      case "item/fileChange/requestApproval": {
        const fileParams = this.asFileChangeRequestApprovalParams(
          request.params,
        );
        if (!fileParams) {
          log.warn(
            {
              method: request.method,
              requestId: request.id,
            },
            "Codex file-change approval params invalid; declining",
          );
          return { decision: "decline" as FileChangeApprovalDecision };
        }
        const grantRoot = fileParams.grantRoot ?? null;
        log.info(
          {
            method: request.method,
            requestId: request.id,
            threadId: fileParams.threadId,
            turnId: fileParams.turnId,
            itemId: fileParams.itemId,
            grantRoot,
          },
          "Handling Codex file-change approval request",
        );
        const toolInput = {
          file_path: grantRoot ?? undefined,
          reason: fileParams.reason ?? null,
          grantRoot,
          threadId: fileParams.threadId,
          turnId: fileParams.turnId,
          itemId: fileParams.itemId,
        };
        const decision: FileChangeApprovalDecision =
          await this.resolveApprovalDecision(
            options,
            "Edit",
            toolInput,
            signal,
            "accept",
            "decline",
          );
        log.info(
          {
            method: request.method,
            requestId: request.id,
            threadId: fileParams.threadId,
            turnId: fileParams.turnId,
            itemId: fileParams.itemId,
            decision,
          },
          "Resolved Codex file-change approval request",
        );
        return { decision };
      }

      // Backward-compatible protocol variants.
      case "execCommandApproval": {
        const commandParts = Array.isArray(params.command)
          ? params.command.filter(
              (part): part is string => typeof part === "string",
            )
          : [];
        const toolInput = {
          command: commandParts.join(" "),
          cwd: this.getOptionalString(params.cwd),
          reason: this.getOptionalString(params.reason),
          parsedCmd: Array.isArray(params.parsedCmd) ? params.parsedCmd : [],
          callId: this.getOptionalString(params.callId),
        };
        const decision = await this.resolveApprovalDecision(
          options,
          "Bash",
          toolInput,
          signal,
          "approved",
          "denied",
        );
        log.info(
          {
            method: request.method,
            requestId: request.id,
            decision,
            command: toolInput.command,
            cwd: toolInput.cwd,
          },
          "Resolved legacy Codex command approval request",
        );
        return { decision };
      }

      case "applyPatchApproval": {
        const fileChanges =
          params.fileChanges && typeof params.fileChanges === "object"
            ? (params.fileChanges as Record<string, unknown>)
            : {};
        const paths = Object.keys(fileChanges);
        const toolInput = {
          changes: paths.map((path) => ({ path, kind: "update" })),
          reason: this.getOptionalString(params.reason),
          grantRoot: this.getOptionalString(params.grantRoot),
          callId: this.getOptionalString(params.callId),
        };
        const decision = await this.resolveApprovalDecision(
          options,
          "Edit",
          toolInput,
          signal,
          "approved",
          "denied",
        );
        log.info(
          {
            method: request.method,
            requestId: request.id,
            decision,
            changedPathCount: paths.length,
            grantRoot: toolInput.grantRoot,
          },
          "Resolved legacy Codex apply-patch approval request",
        );
        return { decision };
      }

      case "item/tool/requestUserInput": {
        const requestInput = this.asToolRequestUserInputParams(request.params);
        const questions = requestInput?.questions ?? [];

        // MVP: return empty answers so request can complete without blocking.
        const answers: ToolRequestUserInputResponse["answers"] = {};
        for (const question of questions) {
          answers[question.id] = { answers: [] };
        }
        log.warn(
          {
            method: request.method,
            requestId: request.id,
            questionCount: questions.length,
            threadId: requestInput?.threadId ?? null,
            turnId: requestInput?.turnId ?? null,
            itemId: requestInput?.itemId ?? null,
          },
          "Codex requested tool user input; returning empty answers in MVP",
        );
        const response: ToolRequestUserInputResponse = { answers };
        return response;
      }

      default: {
        log.warn(
          { method: request.method, requestId: request.id },
          "Unhandled codex server request",
        );
        return {};
      }
    }
  }

  private async resolveApprovalDecision<TDecision extends string>(
    options: StartSessionOptions,
    toolName: string,
    toolInput: unknown,
    signal: AbortSignal,
    allowDecision: TDecision,
    denyDecision: TDecision,
  ): Promise<TDecision> {
    if (!options.onToolApproval) {
      log.warn(
        { toolName },
        "No onToolApproval handler available; denying Codex approval request",
      );
      return denyDecision;
    }

    let result: ToolApprovalResult;
    try {
      result = await options.onToolApproval(toolName, toolInput, { signal });
    } catch (error) {
      log.warn(
        { toolName, error },
        "onToolApproval threw; denying Codex approval request",
      );
      return denyDecision;
    }

    log.info(
      { toolName, behavior: result.behavior },
      "Resolved tool approval callback result",
    );

    return result.behavior === "allow" ? allowDecision : denyDecision;
  }

  private convertNotificationToSDKMessages(
    notification: JsonRpcNotification,
    sessionId: string,
    usageByTurnId: Map<string, TokenUsageSnapshot>,
  ): SDKMessage[] {
    switch (notification.method) {
      case "turn/completed": {
        const params = this.asTurnCompletedNotification(notification.params);
        const turnId = params?.turn.id ?? null;
        const usage = turnId ? usageByTurnId.get(turnId) : undefined;
        const message = withCodexTimestamp({
          type: "system",
          subtype: "turn_complete",
          session_id: sessionId,
          usage: usage
            ? {
                input_tokens: usage.inputTokens,
                output_tokens: usage.outputTokens,
                cached_input_tokens: usage.cachedInputTokens,
              }
            : undefined,
        } as SDKMessage);
        logSdkCorrelationDebug(sessionId, message, {
          eventKind: "turn_complete",
          ...(turnId ? { turnId } : {}),
          phase: "completed",
          sourceEvent: notification.method,
        });
        return [message];
      }

      case "error": {
        const params = this.asErrorNotification(notification.params);
        const errorMessage = params?.error.message;
        const message =
          (typeof errorMessage === "string" && errorMessage) ||
          (typeof (notification.params as { message?: unknown })?.message ===
          "string"
            ? (notification.params as { message: string }).message
            : "Codex turn failed");

        const errorEvent = {
          type: "error",
          session_id: sessionId,
          error: message,
        } as SDKMessage;
        logSdkCorrelationDebug(sessionId, errorEvent, {
          eventKind: "error",
          phase: "emitted",
          sourceEvent: notification.method,
        });
        return [errorEvent];
      }

      case "item/started":
      case "item/completed": {
        const params =
          notification.method === "item/started"
            ? this.asItemStartedNotification(notification.params)
            : this.asItemCompletedNotification(notification.params);
        if (!params) return [];

        const normalized = this.normalizeThreadItem(params.item);
        if (!normalized) {
          return [];
        }

        const turnId = params.turnId;

        return this.convertItemToSDKMessages(
          normalized,
          sessionId,
          turnId,
          notification.method,
        );
      }

      case "account/rateLimits/updated": {
        // account/rateLimits/updated is telemetry, not a terminal turn error.
        // Real usage-limit/quota failures arrive via the `error` notification.
        return [];
      }

      default:
        return [];
    }
  }

  private normalizeThreadItem(
    item: CodexThreadItem | Record<string, unknown>,
  ): NormalizedThreadItem | null {
    const itemRecord = item as Record<string, unknown>;
    const id = this.getOptionalString(itemRecord.id);
    const type = this.getOptionalString(itemRecord.type);
    if (!id || !type) {
      return null;
    }

    const normalizedType = type.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`);

    switch (normalizedType) {
      case "reasoning": {
        const text = this.getReasoningText(itemRecord);
        if (!text) return null;
        return { id, type: "reasoning", text };
      }

      case "agent_message":
      case "plan": {
        const text = this.getOptionalString(itemRecord.text) ?? "";
        return { id, type: "agent_message", text };
      }

      case "command_execution": {
        return {
          id,
          type: "command_execution",
          command: this.getOptionalString(itemRecord.command) ?? "",
          aggregated_output:
            this.getOptionalString(itemRecord.aggregated_output) ??
            this.getOptionalString(itemRecord.aggregatedOutput) ??
            "",
          exit_code:
            this.getOptionalNumber(itemRecord.exit_code) ??
            this.getOptionalNumber(itemRecord.exitCode) ??
            undefined,
          status: this.normalizeStatus(itemRecord.status),
        };
      }

      case "file_change": {
        const changesRaw = Array.isArray(itemRecord.changes)
          ? itemRecord.changes
          : [];
        const changes: NormalizedFileChange[] = [];
        for (const change of changesRaw) {
          if (!change || typeof change !== "object") continue;
          const record = change as Record<string, unknown>;
          const path = this.getOptionalString(record.path);
          if (!path) continue;

          let kind: "add" | "delete" | "update" = "update";
          const rawKind = record.kind;
          if (typeof rawKind === "string") {
            if (
              rawKind === "add" ||
              rawKind === "delete" ||
              rawKind === "update"
            ) {
              kind = rawKind;
            }
          } else if (rawKind && typeof rawKind === "object") {
            const rawType = this.getOptionalString(
              (rawKind as Record<string, unknown>).type,
            );
            if (
              rawType === "add" ||
              rawType === "delete" ||
              rawType === "update"
            ) {
              kind = rawType;
            }
          }

          const diff = this.getOptionalString(record.diff) ?? undefined;
          changes.push({
            path,
            kind,
            ...(diff ? { diff } : {}),
          });
        }

        return {
          id,
          type: "file_change",
          changes,
          status: this.normalizeStatus(itemRecord.status),
        };
      }

      case "mcp_tool_call": {
        const errorObj =
          itemRecord.error && typeof itemRecord.error === "object"
            ? (itemRecord.error as Record<string, unknown>)
            : null;

        return {
          id,
          type: "mcp_tool_call",
          server: this.getOptionalString(itemRecord.server) ?? "unknown",
          tool: this.getOptionalString(itemRecord.tool) ?? "unknown",
          arguments: itemRecord.arguments,
          result: itemRecord.result,
          error:
            this.getOptionalString(errorObj?.message) !== null
              ? { message: this.getOptionalString(errorObj?.message) ?? "" }
              : undefined,
          status: this.normalizeStatus(itemRecord.status),
        };
      }

      case "web_search": {
        return {
          id,
          type: "web_search",
          query: this.getOptionalString(itemRecord.query) ?? "",
        };
      }

      case "todo_list": {
        const items = Array.isArray(itemRecord.items)
          ? itemRecord.items
              .map((entry: unknown) => {
                if (!entry || typeof entry !== "object") return null;
                const record = entry as Record<string, unknown>;
                const text = this.getOptionalString(record.text);
                if (!text) return null;
                return {
                  text,
                  completed: record.completed === true,
                };
              })
              .filter(
                (
                  entry: unknown,
                ): entry is { text: string; completed: boolean } =>
                  entry !== null,
              )
          : [];
        return {
          id,
          type: "todo_list",
          items,
        };
      }

      case "image_view": {
        const imagePath = this.getOptionalString(itemRecord.path) ?? "";
        if (!imagePath) return null;
        return { id, type: "image_view", path: imagePath };
      }

      case "error": {
        const message =
          this.getOptionalString(itemRecord.message) ?? "Codex error";
        return {
          id,
          type: "error",
          message,
        };
      }

      default:
        return null;
    }
  }

  private getReasoningText(item: Record<string, unknown>): string {
    const text = this.getOptionalString(item.text);
    if (text) return text;

    const content = Array.isArray(item.content)
      ? item.content.filter((part): part is string => typeof part === "string")
      : [];
    if (content.length > 0) {
      return content.join("\n");
    }

    const summary = Array.isArray(item.summary)
      ? item.summary.filter((part): part is string => typeof part === "string")
      : [];
    if (summary.length > 0) {
      return summary.join("\n");
    }

    return "";
  }

  private normalizeStatus(status: unknown): string {
    if (typeof status !== "string") return "unknown";
    return status.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`);
  }

  private asTurnCompletedNotification(
    params: unknown,
  ): TurnCompletedNotification | null {
    if (!params || typeof params !== "object") return null;
    const record = params as Record<string, unknown>;
    if (
      typeof record.threadId !== "string" ||
      !record.turn ||
      typeof record.turn !== "object" ||
      typeof (record.turn as { id?: unknown }).id !== "string"
    ) {
      return null;
    }
    return params as TurnCompletedNotification;
  }

  private asErrorNotification(params: unknown): CodexErrorNotification | null {
    if (!params || typeof params !== "object") return null;
    const record = params as Record<string, unknown>;
    if (
      typeof record.threadId !== "string" ||
      typeof record.turnId !== "string" ||
      typeof record.willRetry !== "boolean" ||
      !record.error ||
      typeof record.error !== "object" ||
      typeof (record.error as { message?: unknown }).message !== "string"
    ) {
      return null;
    }
    return params as CodexErrorNotification;
  }

  private asThreadTokenUsageUpdatedNotification(
    params: unknown,
  ): ThreadTokenUsageUpdatedNotification | null {
    if (!params || typeof params !== "object") return null;
    const record = params as Record<string, unknown>;
    const tokenUsage =
      record.tokenUsage && typeof record.tokenUsage === "object"
        ? (record.tokenUsage as Record<string, unknown>)
        : null;
    const last =
      tokenUsage?.last && typeof tokenUsage.last === "object"
        ? (tokenUsage.last as Record<string, unknown>)
        : null;
    if (
      typeof record.threadId !== "string" ||
      typeof record.turnId !== "string" ||
      !last ||
      typeof last.inputTokens !== "number" ||
      typeof last.outputTokens !== "number" ||
      typeof last.cachedInputTokens !== "number"
    ) {
      return null;
    }
    return params as ThreadTokenUsageUpdatedNotification;
  }

  private asCommandExecutionRequestApprovalParams(
    params: unknown,
  ): CommandExecutionRequestApprovalParams | null {
    if (!params || typeof params !== "object") return null;
    const record = params as Record<string, unknown>;
    if (
      typeof record.threadId !== "string" ||
      typeof record.turnId !== "string" ||
      typeof record.itemId !== "string"
    ) {
      return null;
    }
    return params as CommandExecutionRequestApprovalParams;
  }

  private asFileChangeRequestApprovalParams(
    params: unknown,
  ): FileChangeRequestApprovalParams | null {
    if (!params || typeof params !== "object") return null;
    const record = params as Record<string, unknown>;
    if (
      typeof record.threadId !== "string" ||
      typeof record.turnId !== "string" ||
      typeof record.itemId !== "string"
    ) {
      return null;
    }
    return params as FileChangeRequestApprovalParams;
  }

  private asToolRequestUserInputParams(
    params: unknown,
  ): ToolRequestUserInputParams | null {
    if (!params || typeof params !== "object") return null;
    const record = params as Record<string, unknown>;
    if (
      typeof record.threadId !== "string" ||
      typeof record.turnId !== "string" ||
      typeof record.itemId !== "string" ||
      !Array.isArray(record.questions)
    ) {
      return null;
    }
    return params as ToolRequestUserInputParams;
  }

  private asItemStartedNotification(
    params: unknown,
  ): CodexItemStartedNotification | null {
    if (!params || typeof params !== "object") return null;
    const record = params as Record<string, unknown>;
    if (
      typeof record.threadId !== "string" ||
      typeof record.turnId !== "string" ||
      !record.item ||
      typeof record.item !== "object"
    ) {
      return null;
    }
    return params as CodexItemStartedNotification;
  }

  private asItemCompletedNotification(
    params: unknown,
  ): CodexItemCompletedNotification | null {
    if (!params || typeof params !== "object") return null;
    const record = params as Record<string, unknown>;
    if (
      typeof record.threadId !== "string" ||
      typeof record.turnId !== "string" ||
      !record.item ||
      typeof record.item !== "object"
    ) {
      return null;
    }
    return params as CodexItemCompletedNotification;
  }

  /**
   * Convert a normalized thread item to SDKMessage(s).
   */
  private convertItemToSDKMessages(
    item: NormalizedThreadItem,
    sessionId: string,
    turnId: string,
    sourceEvent: "item/started" | "item/completed",
  ): SDKMessage[] {
    const isComplete = sourceEvent === "item/completed";
    const observedAt = new Date().toISOString();
    // Create unique UUID by combining item.id with turn ID.
    const uuid = `${item.id}-${turnId}`;

    switch (item.type) {
      case "reasoning": {
        const message = withCodexTimestamp(
          {
            type: "assistant",
            session_id: sessionId,
            uuid,
            message: {
              role: "assistant",
              content: [
                {
                  type: "thinking",
                  thinking: item.text,
                },
              ],
            },
          } as SDKMessage,
          observedAt,
        );
        logSdkCorrelationDebug(sessionId, message, {
          eventKind: "reasoning",
          turnId,
          itemId: item.id,
          phase: isComplete ? "completed" : "started",
          sourceEvent,
        });
        return [message];
      }

      case "agent_message": {
        const message = withCodexTimestamp(
          {
            type: "assistant",
            session_id: sessionId,
            uuid,
            message: {
              role: "assistant",
              content: item.text,
            },
          } as SDKMessage,
          observedAt,
        );
        logSdkCorrelationDebug(sessionId, message, {
          eventKind: "agent_message",
          turnId,
          itemId: item.id,
          phase: isComplete ? "completed" : "started",
          sourceEvent,
        });
        return [message];
      }

      case "command_execution": {
        const messages: SDKMessage[] = [];
        const normalizedInvocation = normalizeCodexToolInvocation("Bash", {
          command: item.command,
        });
        const toolContext: CodexToolCallContext = {
          toolName: normalizedInvocation.toolName,
          input: normalizedInvocation.input,
          readShellInfo: normalizedInvocation.readShellInfo,
          writeShellInfo: normalizedInvocation.writeShellInfo,
        };

        // Emit tool_use for the command
        const toolUseMessage = withCodexTimestamp(
          {
            type: "assistant",
            session_id: sessionId,
            uuid,
            message: {
              role: "assistant",
              content: [
                {
                  type: "tool_use",
                  id: item.id,
                  name: normalizedInvocation.toolName,
                  input: normalizedInvocation.input,
                },
              ],
            },
          } as SDKMessage,
          observedAt,
        );
        logSdkCorrelationDebug(sessionId, toolUseMessage, {
          eventKind: "command_execution",
          turnId,
          itemId: item.id,
          callId: item.id,
          phase: isComplete ? "completed" : "started",
          sourceEvent,
          status: item.status,
        });
        messages.push(toolUseMessage);

        // If completed, emit tool_result
        if (isComplete && item.status !== "in_progress") {
          const normalizedResult = normalizeCodexCommandExecutionOutput(
            {
              aggregatedOutput: item.aggregated_output,
              exitCode: item.exit_code,
              status: item.status,
            },
            toolContext,
          );
          const toolResultBlock: {
            type: "tool_result";
            tool_use_id: string;
            content: string;
            is_error?: boolean;
          } = {
            type: "tool_result",
            tool_use_id: item.id,
            content: normalizedResult.content,
          };
          if (normalizedResult.isError) {
            toolResultBlock.is_error = true;
          }

          const toolResultMessage = withCodexTimestamp(
            {
              type: "user",
              session_id: sessionId,
              uuid: `${uuid}-result`,
              message: {
                role: "user",
                content: [toolResultBlock],
              },
              ...(normalizedResult.structured !== undefined
                ? { toolUseResult: normalizedResult.structured }
                : {}),
            } as SDKMessage,
            observedAt,
          );
          logSdkCorrelationDebug(sessionId, toolResultMessage, {
            eventKind: "tool_result",
            turnId,
            itemId: item.id,
            callId: item.id,
            phase: "completed",
            sourceEvent,
            status: item.status,
          });
          messages.push(toolResultMessage);
        }

        return messages;
      }

      case "file_change": {
        const changesSummary = item.changes
          .map((c) => `${c.kind}: ${c.path}`)
          .join("\n");
        const editInput: Record<string, unknown> = {
          changes: item.changes,
        };
        const singlePath = item.changes[0]?.path;
        if (singlePath && item.changes.length === 1) {
          editInput.file_path = singlePath;
        }

        const toolUseMessage = withCodexTimestamp(
          {
            type: "assistant",
            session_id: sessionId,
            uuid,
            message: {
              role: "assistant",
              content: [
                {
                  type: "tool_use",
                  id: item.id,
                  name: "Edit",
                  input: editInput,
                },
              ],
            },
          } as SDKMessage,
          observedAt,
        );
        logSdkCorrelationDebug(sessionId, toolUseMessage, {
          eventKind: "file_change",
          turnId,
          itemId: item.id,
          callId: item.id,
          phase: isComplete ? "completed" : "started",
          sourceEvent,
          status: item.status,
        });

        const messages = [toolUseMessage];

        if (isComplete) {
          const toolResultMessage = withCodexTimestamp(
            {
              type: "user",
              session_id: sessionId,
              uuid: `${uuid}-result`,
              message: {
                role: "user",
                content: [
                  {
                    type: "tool_result",
                    tool_use_id: item.id,
                    content:
                      item.status === "completed"
                        ? `File changes applied:\n${changesSummary}`
                        : item.status === "declined"
                          ? `File changes declined:\n${changesSummary}`
                          : `File changes failed:\n${changesSummary}`,
                  },
                ],
              },
            } as SDKMessage,
            observedAt,
          );
          logSdkCorrelationDebug(sessionId, toolResultMessage, {
            eventKind: "tool_result",
            turnId,
            itemId: item.id,
            callId: item.id,
            phase: "completed",
            sourceEvent,
            status: item.status,
          });
          messages.push(toolResultMessage);
        }

        return messages;
      }

      case "mcp_tool_call": {
        const messages: SDKMessage[] = [];

        const toolUseMessage = withCodexTimestamp(
          {
            type: "assistant",
            session_id: sessionId,
            uuid,
            message: {
              role: "assistant",
              content: [
                {
                  type: "tool_use",
                  id: item.id,
                  name: `${item.server}:${item.tool}`,
                  input: item.arguments,
                },
              ],
            },
          } as SDKMessage,
          observedAt,
        );
        logSdkCorrelationDebug(sessionId, toolUseMessage, {
          eventKind: "mcp_tool_call",
          turnId,
          itemId: item.id,
          callId: item.id,
          phase: isComplete ? "completed" : "started",
          sourceEvent,
          status: item.status,
        });
        messages.push(toolUseMessage);

        if (isComplete && item.status !== "in_progress") {
          const toolResultMessage = withCodexTimestamp(
            {
              type: "user",
              session_id: sessionId,
              uuid: `${uuid}-result`,
              message: {
                role: "user",
                content: [
                  {
                    type: "tool_result",
                    tool_use_id: item.id,
                    content:
                      item.status === "completed"
                        ? JSON.stringify(item.result)
                        : item.error?.message || "MCP tool call failed",
                  },
                ],
              },
            } as SDKMessage,
            observedAt,
          );
          logSdkCorrelationDebug(sessionId, toolResultMessage, {
            eventKind: "tool_result",
            turnId,
            itemId: item.id,
            callId: item.id,
            phase: "completed",
            sourceEvent,
            status: item.status,
          });
          messages.push(toolResultMessage);
        }

        return messages;
      }

      case "web_search": {
        const message = withCodexTimestamp(
          {
            type: "assistant",
            session_id: sessionId,
            uuid,
            message: {
              role: "assistant",
              content: [
                {
                  type: "tool_use",
                  id: item.id,
                  name: "WebSearch",
                  input: { query: item.query },
                },
              ],
            },
          } as SDKMessage,
          observedAt,
        );
        logSdkCorrelationDebug(sessionId, message, {
          eventKind: "web_search",
          turnId,
          itemId: item.id,
          callId: item.id,
          phase: isComplete ? "completed" : "started",
          sourceEvent,
        });
        return [message];
      }

      case "todo_list": {
        const message = withCodexTimestamp(
          {
            type: "system",
            subtype: "todo_list",
            session_id: sessionId,
            uuid,
            items: item.items,
          } as SDKMessage,
          observedAt,
        );
        logSdkCorrelationDebug(sessionId, message, {
          eventKind: "todo_list",
          turnId,
          itemId: item.id,
          phase: isComplete ? "completed" : "started",
          sourceEvent,
        });
        return [message];
      }

      case "image_view": {
        // Represent as a ViewImage tool_use + tool_result pair
        const toolUseMessage = withCodexTimestamp(
          {
            type: "assistant",
            session_id: sessionId,
            uuid,
            message: {
              role: "assistant",
              content: [
                {
                  type: "tool_use",
                  id: item.id,
                  name: "ViewImage",
                  input: { path: item.path },
                },
              ],
            },
          } as SDKMessage,
          observedAt,
        );
        logSdkCorrelationDebug(sessionId, toolUseMessage, {
          eventKind: "image_view",
          turnId,
          itemId: item.id,
          phase: isComplete ? "completed" : "started",
          sourceEvent,
        });
        const messages: SDKMessage[] = [toolUseMessage];

        if (isComplete) {
          const toolResultMessage = withCodexTimestamp(
            {
              type: "user",
              session_id: sessionId,
              uuid: `${uuid}-result`,
              message: {
                role: "user",
                content: [
                  {
                    type: "tool_result",
                    tool_use_id: item.id,
                    content: `Viewed image: ${item.path}`,
                  },
                ],
              },
            } as SDKMessage,
            observedAt,
          );
          logSdkCorrelationDebug(sessionId, toolResultMessage, {
            eventKind: "tool_result",
            turnId,
            itemId: item.id,
            callId: item.id,
            phase: "completed",
            sourceEvent,
          });
          messages.push(toolResultMessage);
        }

        return messages;
      }

      case "error": {
        const message = withCodexTimestamp(
          {
            type: "error",
            session_id: sessionId,
            uuid,
            error: item.message,
          } as SDKMessage,
          observedAt,
        );
        logSdkCorrelationDebug(sessionId, message, {
          eventKind: "error",
          turnId,
          itemId: item.id,
          phase: isComplete ? "completed" : "started",
          sourceEvent,
        });
        return [message];
      }

      default:
        return [];
    }
  }

  /**
   * Extract text content from a user message.
   */
  private extractTextFromMessage(message: unknown): string {
    if (!message || typeof message !== "object") {
      return "";
    }

    // Handle UserMessage format
    const userMsg = message as UserMessage;
    if (typeof userMsg.text === "string") {
      return userMsg.text;
    }

    // Handle SDK message format
    const sdkMsg = message as {
      message?: { content?: string | unknown[] };
    };
    const content = sdkMsg.message?.content;

    if (typeof content === "string") {
      return content;
    }

    if (Array.isArray(content)) {
      return content
        .map((block: unknown) => {
          if (typeof block === "string") return block;
          if (
            typeof block === "object" &&
            block !== null &&
            "type" in block &&
            (block as { type: string }).type === "text" &&
            "text" in block
          ) {
            return (block as { text: string }).text;
          }
          return "";
        })
        .filter(Boolean)
        .join("\n");
    }

    return "";
  }

  private getOptionalString(value: unknown): string | null {
    return typeof value === "string" ? value : null;
  }

  private getOptionalNumber(value: unknown): number | null {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  }
}

/**
 * Default Codex provider instance.
 */
export const codexProvider = new CodexProvider();
