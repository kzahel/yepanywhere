/**
 * Codex Provider implementation using codex app-server JSON-RPC.
 *
 * Uses `codex app-server --listen stdio://` for turn execution so we can handle
 * server-initiated permission requests (command/file approval).
 */

import { type ChildProcess, execFile, spawn } from "node:child_process";
import { homedir } from "node:os";
import {
  CODEX_TOOL_CORRELATION_FIELD,
  type CodexAsyncUserInputQuestion,
  type CodexPlanToolMode,
  DEFAULT_CODEX_REASONING_SUMMARY,
  DEFAULT_SUBAGENT_MAX_DEPTH,
  canonicalInvocationName,
  canonicalizeSkillInvocations,
  createCodexToolCorrelation,
  type CodexReasoningSummary,
  type EffortLevel,
  hasInvocationCandidate,
  type ModelInfo,
  normalizeCodexAsyncUserInputQuestions,
  type PermissionMode,
  type ProviderSubscriptionUsage,
  type SlashCommand,
  type SubagentMaxDepth,
} from "@yep-anywhere/shared";
import {
  isCodexCorrelationDebugEnabled,
  logCodexCorrelationDebug,
  summarizeCodexNormalizedMessage,
} from "../../codex/correlationDebugLogger.js";
import {
  canonicalizeCodexToolName,
  isCodexBackgroundProcessOutput,
  isCodexInterruptedToolOutput,
  type CodexToolCallContext,
  normalizeCodexCommandExecutionOutput,
  normalizeCodexCustomToolInvocation,
  normalizeCodexToolInvocation,
  normalizeCodexToolOutputWithContext,
  parseCodexToolArguments,
} from "../../codex/normalization.js";
import { formatCodexSubagentActivity } from "../../codex/subagentActivity.js";
import { getLogger } from "../../logging/logger.js";
import { attachToolResultMediaCandidates } from "../../media/inlineImageData.js";
import { quoteShellWord } from "../../utils/posixShell.js";
import {
  CODEX_INSTALLATION_FAMILY,
  type ProviderInstallationCoordinator,
  providerInstallationCoordinator,
} from "../../services/ProviderInstallationCoordinator.js";
import {
  findCodexCliPath,
  getCodexCliVersion,
  isCodexCliAuthenticated,
} from "../cli-detection.js";
import { logSDKMessage } from "../messageLogger.js";
import { MessageQueue } from "../messageQueue.js";
import { stripYaControlPlaneCredentials } from "./env-filter.js";
import type {
  ProviderActivitySnapshot,
  ProviderCommandResult,
  ProviderLivenessProbeResult,
  SDKMessage,
  TimestampedSDKMessage,
  UserMessage,
} from "../types.js";
import type { ToolApprovalResult } from "../types.js";
import type {
  AskForApproval as CodexAskForApproval,
  PermissionsRequestApprovalParams,
  PermissionsRequestApprovalResponse,
  RawResponseItemCompletedNotification,
  SandboxMode as CodexSandboxMode,
  SkillMetadata,
  SkillsListParams,
  SkillsListResponse,
  ThreadForkParams,
  ThreadForkResponse,
  ThreadGoalClearParams,
  ThreadGoalClearResponse,
  ThreadGoalGetParams,
  ThreadGoalGetResponse,
  ThreadGoalSetParams,
  ThreadGoalSetResponse,
  ThreadReadParams,
  ThreadReadResponse,
  ThreadItem as CodexThreadItem,
  ThreadCompactStartParams,
  ThreadCompactStartResponse,
  ThreadRollbackParams,
  ThreadRollbackResponse,
  CommandExecutionApprovalDecision,
  CommandExecutionRequestApprovalParams,
  FileChangeApprovalDecision,
  FileChangeRequestApprovalParams,
  ThreadResumeParams,
  ThreadResumeResponse,
  ThreadStartParams,
  ThreadStartResponse,
  ToolRequestUserInputParams,
  ToolRequestUserInputResponse,
  TurnInterruptParams,
  TurnInterruptResponse,
  TurnSettingsUpdateParams,
  TurnSettingsUpdateResponse,
  TurnStartParams,
  TurnStartResponse,
  TurnSteerParams,
  TurnSteerResponse,
  UserInput,
} from "./codex-protocol/index.js";
import type { SandboxPolicy as CodexSandboxPolicy } from "./codex-protocol/generated/v2/SandboxPolicy.js";
import {
  createAgentctlSessionEnvBridge,
  type AgentctlSessionEnvBridge,
} from "./agentctl-session-env.js";
import {
  formatCodexStatusCommand,
  formatCodexUsageCommand,
  isCodexChatGptAccount,
  parseCodexUsageView,
} from "./codex-account-commands.js";
import {
  type AppServerModel,
  getFallbackCodexModelsForCliVersion,
  normalizeCodexModelList,
  normalizeSemver,
} from "./codex-model-catalog.js";
import { normalizeCodexSubscriptionUsage } from "./provider-subscription-usage.js";
import {
  asCodexAgentMessageDeltaNotification,
  asCodexCommandExecutionOutputDeltaNotification,
  asCodexErrorNotification,
  asCodexFileChangeOutputDeltaNotification,
  asCodexItemCompletedNotification,
  asCodexItemStartedNotification,
  asCodexPlanDeltaNotification,
  asCodexRawResponseItemCompletedNotification,
  asCodexReasoningSummaryTextDeltaNotification,
  asCodexThreadTokenUsageUpdatedNotification,
  asCodexTurnCompletedNotification,
  asCodexTurnPlanUpdatedNotification,
  isCodexLiveDeltaNotificationMethod,
  isCodexLiveDeltaSuppressionEnabled,
  readCodexTurnErrorDetail,
} from "./codex-notification-guards.js";
import {
  captureCodexSummaryTextFromNotification,
  captureCodexSummaryTextFromTurnItems,
  cleanCodexRecapText,
  cleanCodexSummaryText,
  CODEX_RECAP_TIMEOUT_MS,
  CODEX_SUMMARY_TIMEOUT_MS,
  createCodexForkSummaryPrompt,
  createCodexForkSummaryThreadResumeParams,
  createCodexRecapPrompt,
  joinCodexSummaryText,
  resolveCodexRecapHelperModel,
} from "./codex-summary-helpers.js";
import { CODEX_BUILTIN_COMMANDS } from "./staticSlashCommands.js";
import type {
  AgentProvider,
  AgentSession,
  AuthStatus,
  ProviderForkBoundary,
  StartSessionOptions,
  SummaryGenerationRequest,
  SummaryGenerationResult,
} from "./types.js";
import { inactiveProviderSessionOptionsResult } from "./types.js";
import type { SessionSandboxRuntime } from "../../session-sandbox.js";

const log = {
  debug(bindings: Record<string, unknown>, message: string): void {
    getLogger().debug({ component: "codex-provider", ...bindings }, message);
  },
  info(bindings: Record<string, unknown>, message: string): void {
    getLogger().info({ component: "codex-provider", ...bindings }, message);
  },
  warn(bindings: Record<string, unknown>, message: string): void {
    getLogger().warn({ component: "codex-provider", ...bindings }, message);
  },
  error(bindings: Record<string, unknown>, message: string): void {
    getLogger().error({ component: "codex-provider", ...bindings }, message);
  },
};
const CODEX_DESKTOP_BROWSER_SKILL_NAME = "browser:control-in-app-browser";

function formatCodexGoalStatus(
  status: ThreadGoalSetResponse["goal"]["status"],
): string {
  switch (status) {
    case "usageLimited":
      return "Goal usage limited";
    case "budgetLimited":
      return "Goal budget limited";
    default:
      return `Goal ${status}`;
  }
}

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

function stringifyTraceValue(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

const MODEL_CACHE_TTL_MS = 60 * 60 * 1000;
const MODEL_LIST_TIMEOUT_MS = 8000;
const ACCOUNT_RATE_LIMITS_TIMEOUT_MS = 8000;
const APP_SERVER_INIT_REQUEST_ID = 1;
const APP_SERVER_MODEL_LIST_REQUEST_ID = 2;
const APP_SERVER_SHUTDOWN_GRACE_MS = 1500;
const APP_SERVER_FORCE_KILL_WAIT_MS = 1000;
const APP_SERVER_EXIT_POLL_MS = 25;
const CODEX_FAILURE_TRACE_LIMIT = 12;
const CODEX_FAILURE_PREVIEW_CHARS = 240;
const CODEX_SERVER_OVERLOAD_RETRY_LIMIT = 16;
const CODEX_SERVER_OVERLOAD_RETRY_SCALE_MS = 5000;
const CODEX_THINKING_OFF_MIN_REASONING_EFFORT_PREFIXES = [
  "gpt-5.3-codex-spark",
] as const;

type CodexOverloadRetryWait = (
  delayMs: number,
  signal: AbortSignal,
) => Promise<boolean>;

function getCodexOverloadRetryDelayMs(attempt: number): number {
  return (attempt + 1) ** 2 * CODEX_SERVER_OVERLOAD_RETRY_SCALE_MS;
}

async function waitForCodexOverloadRetry(
  delayMs: number,
  signal: AbortSignal,
): Promise<boolean> {
  if (signal.aborted) return false;

  return await new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (elapsed: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
      resolve(elapsed);
    };
    const onAbort = (): void => finish(false);
    const timeout = setTimeout(() => finish(true), delayMs);
    timeout.unref?.();
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function withCodexTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(
      () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
    timeout.unref?.();
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

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

interface CodexThreadPolicy {
  approvalPolicy: CodexAskForApproval;
  sandbox: CodexSandboxMode;
}

type CodexThreadResumeParamsForRequest = ThreadResumeParams;
type CodexThreadForkParamsForRequest = ThreadForkParams;
type CodexThreadTurn = ThreadReadResponse["thread"]["turns"][number];

interface CodexForkAnchor {
  turnIndex: number;
  itemIndex: number | null;
}

/**
 * When enabled, declare Codex session originator as "Codex Desktop" when
 * initializing app-server sessions. Disabled by default so we report
 * "yep-anywhere" as the originator, making Yep Anywhere usage visible in the
 * Codex/ChatGPT token-usage UI.
 */
const DECLARE_CODEX_ORIGINATOR = false;
const DECLARED_CODEX_ORIGINATOR = "Codex Desktop";

function quotePowerShellDoubleQuoted(value: string): string {
  return `"${value
    .replace(/`/g, "``")
    .replace(/\$/g, "`$")
    .replace(/"/g, '`"')}"`;
}

export function formatCodexLoginCommand(
  executablePath: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const trimmedPath = executablePath.trim();
  if (!trimmedPath || trimmedPath === "codex") return "codex login";
  const executable =
    platform === "win32"
      ? quotePowerShellDoubleQuoted(trimmedPath)
      : quoteShellWord(trimmedPath);
  return `${platform === "win32" ? "& " : ""}${executable} login`;
}
const YEP_ANYWHERE_ORIGINATOR = "yep-anywhere";

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

interface CodexNotificationReceipt {
  sequence: number;
  receivedAtMs: number;
  queuedAhead: number;
  source: "provider" | "synthetic";
}

interface JsonRpcServerRequest extends JsonRpcNotification {
  id: JsonRpcId;
}

interface TokenUsageSnapshot {
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  contextWindow?: number;
}

interface CodexTurnRuntimeState {
  threadId: string;
  goalObjective?: string | null;
  goalStatus?: ThreadGoalSetResponse["goal"]["status"] | null;
  resolvedModel: string;
  turnModelOverride: string | null;
  latestTokenUsage?: TokenUsageSnapshot;
  activeTurnId: string | null;
  pendingTurnStart: Promise<string | null> | null;
  activePermissionMode: PermissionMode;
  turnEffortOverride: EffortLevel | null | undefined;
  workspaceWriteSandboxPolicy: CodexSandboxPolicy | null;
  activeToolCallIds: Set<string>;
  backgroundToolCallIds: Set<string>;
}

function getCodexNotificationTurnId(
  notification: JsonRpcNotification,
  threadId: string,
): string | null {
  if (!notification.params || typeof notification.params !== "object") {
    return null;
  }
  const params = notification.params as Record<string, unknown>;
  if (params.threadId !== threadId) return null;

  if (
    notification.method === "turn/started" ||
    notification.method === "turn/completed"
  ) {
    const turn =
      params.turn && typeof params.turn === "object"
        ? (params.turn as Record<string, unknown>)
        : null;
    return typeof turn?.id === "string" ? turn.id : null;
  }

  // Any same-thread app-server notification carrying a top-level turnId was
  // produced for that live turn. Keeping this structural avoids silently
  // missing a newly added item/delta notification method.
  return typeof params.turnId === "string" ? params.turnId : null;
}

function getCodexNotificationTurnStartedAt(
  notification: JsonRpcNotification,
): number | null {
  if (
    (notification.method !== "turn/started" &&
      notification.method !== "turn/completed") ||
    !notification.params ||
    typeof notification.params !== "object"
  ) {
    return null;
  }
  const turn = (notification.params as Record<string, unknown>).turn;
  if (!turn || typeof turn !== "object") return null;
  const startedAt = (turn as Record<string, unknown>).startedAt;
  return typeof startedAt === "number" && Number.isFinite(startedAt)
    ? startedAt
    : null;
}

function getCodexActiveTurnMismatchId(error: unknown): string | null {
  const message = error instanceof Error ? error.message : String(error);
  const quotedPrefix = "expected active turn id `";
  const quotedSeparator = "` but found `";
  if (message.startsWith(quotedPrefix)) {
    const found = message.slice(quotedPrefix.length).split(quotedSeparator)[1];
    if (found?.endsWith("`")) return found.slice(0, -1) || null;
  }

  const plainPrefix = "expected active turn id ";
  const plainSeparator = " but found ";
  if (message.startsWith(plainPrefix)) {
    return message.slice(plainPrefix.length).split(plainSeparator)[1] || null;
  }
  return null;
}

interface CodexSessionSkillInventory {
  skills: SkillMetadata[];
  stale: boolean;
}

function isProcessTargetRunning(target: number): boolean {
  try {
    process.kill(target, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") {
      return false;
    }
    if ((error as NodeJS.ErrnoException).code === "EPERM") {
      return true;
    }
    throw error;
  }
}

async function waitForProcessTargetExit(
  target: number,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (isProcessTargetRunning(target)) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      return false;
    }
    await new Promise<void>((resolve) =>
      setTimeout(resolve, Math.min(APP_SERVER_EXIT_POLL_MS, remainingMs)),
    );
  }
  return true;
}

async function terminateChildProcess(
  child: ChildProcess | null | undefined,
  graceMs = APP_SERVER_SHUTDOWN_GRACE_MS,
): Promise<void> {
  if (!child?.pid) {
    return;
  }
  const pid = child.pid;
  const killTarget = process.platform === "win32" ? pid : -pid;
  if (!isProcessTargetRunning(killTarget)) {
    return;
  }

  if (process.platform === "win32") {
    const taskkill = new Promise<void>((resolve) => {
      execFile("taskkill", ["/pid", String(pid), "/T", "/F"], () => resolve());
    });
    await Promise.race([
      taskkill,
      new Promise<void>((resolve) => setTimeout(resolve, graceMs)),
    ]);
    if (!(await waitForProcessTargetExit(pid, APP_SERVER_FORCE_KILL_WAIT_MS))) {
      throw new Error(`Failed to terminate Codex app-server PID ${pid}`);
    }
    return;
  }

  try {
    process.kill(killTarget, "SIGTERM");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") {
      return;
    }
    throw error;
  }

  if (await waitForProcessTargetExit(killTarget, graceMs)) {
    return;
  }

  try {
    process.kill(killTarget, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") {
      return;
    }
    throw error;
  }

  if (
    !(await waitForProcessTargetExit(killTarget, APP_SERVER_FORCE_KILL_WAIT_MS))
  ) {
    throw new Error(`Failed to terminate Codex app-server PID ${pid}`);
  }
}

interface NormalizedFileChange {
  path: string;
  kind: "add" | "delete" | "update";
  diff?: string;
}

interface CodexLiveEventState {
  streamingTextByItemKey: Map<string, string>;
  streamingReasoningSummaryByItemKey: Map<string, string[]>;
  streamingToolOutputByItemKey: Map<string, string>;
  toolCallContexts: Map<string, CodexToolCallContext>;
  resultBackedToolItemsByTurnId: Map<string, Set<string>>;
  planUpdateCountByTurnId: Map<string, number>;
}

interface CodexFailureTraceEvent {
  at: string;
  sourceEvent: string;
  turnId?: string;
  itemId?: string;
  itemType?: string;
  status?: string;
  phase?: string;
  toolName?: string;
  command?: string;
  deltaChars?: number;
  outputChars?: number;
  errorMessage?: string;
  codexErrorInfo?: unknown;
  additionalDetails?: string | null;
  openaiRequestId?: string;
}

interface CodexFailureTrace {
  sessionId?: string;
  activeTurnId?: string | null;
  lastUserMessage?: {
    uuid?: string;
    chars: number;
  };
  lastNotification?: CodexFailureTraceEvent;
  lastEmittedMessage?: CodexFailureTraceEvent;
  recentNotifications: CodexFailureTraceEvent[];
}

type NormalizedThreadItem =
  | { id: string; type: "reasoning"; text: string }
  | {
      id: string;
      type: "agent_message";
      text: string;
      delivery?: "async";
      questions?: CodexAsyncUserInputQuestion[];
    }
  | {
      id: string;
      type: "command_execution";
      command: string;
      aggregated_output: string;
      exit_code?: number;
      durationMs?: number;
      status: string;
      cwd?: string;
      commandActions?: unknown[];
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
      mcpAppResourceUri?: string;
      result?: unknown;
      error?: { message: string };
      status: string;
    }
  | {
      id: string;
      type: "dynamic_tool_call";
      namespace?: string | null;
      tool: string;
      arguments: unknown;
      status: string;
      content_items?: unknown[] | null;
      success?: boolean | null;
    }
  | {
      id: string;
      type: "function_call_output";
      name: string;
      namespace?: string | null;
      output: unknown;
    }
  | { id: string; type: "web_search"; query: string }
  | {
      id: string;
      type: "todo_list";
      items: Array<{ text: string; completed: boolean }>;
    }
  | {
      id: string;
      type: "subagent_activity";
      kind: string;
      agentThreadId: string;
      agentPath: string;
      text: string;
    }
  | { id: string; type: "context_compaction" }
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
  /** Shared installation owner (injectable for deterministic tests). */
  installationCoordinator?: ProviderInstallationCoordinator;
  /** Overload retry timer (injectable for deterministic tests). */
  overloadRetryWait?: CodexOverloadRetryWait;
  /** Target-local Codex state root for an isolated managed session. */
  codexHome?: string;
  /** In-memory ChatGPT subscription projection owned by a host application. */
  externalChatgptAuth?: CodexExternalChatgptAuth;
}

export interface CodexExternalChatgptAuthProjection {
  accessToken: string;
  chatgptAccountId: string;
  chatgptPlanType: string | null;
}

export interface CodexExternalChatgptAuth {
  initialProjection: CodexExternalChatgptAuthProjection;
  refresh: (request: {
    reason: string;
    previousAccountId: string;
  }) => Promise<CodexExternalChatgptAuthProjection>;
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

  get size(): number {
    return this.items.length;
  }

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
  private closePromise: Promise<void> | null = null;
  private notificationReceiptSequence = 0;
  private readonly notificationReceipts = new WeakMap<
    JsonRpcNotification,
    CodexNotificationReceipt
  >();

  /** OS PID of the spawned app-server child process */
  get pid(): number | undefined {
    return this.process?.pid;
  }

  isAlive(): boolean {
    const child = this.process;
    if (!child?.pid) return false;
    const target = process.platform === "win32" ? child.pid : -child.pid;
    return isProcessTargetRunning(target);
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
  private lastRawProviderEventAt: Date | null = null;
  private lastRawProviderEventSource: string | null = null;

  constructor(
    private readonly command: string,
    private readonly cwd: string,
    private readonly env: NodeJS.ProcessEnv,
    private readonly shouldSuppressNotification?: (
      notification: JsonRpcNotification,
    ) => boolean,
    private readonly sessionSandbox?: SessionSandboxRuntime,
  ) {}

  get isClosed(): boolean {
    return this.closed;
  }

  get lastNotificationReceiptSequence(): number {
    return this.notificationReceiptSequence;
  }

  getNotificationReceipt(
    notification: JsonRpcNotification,
  ): CodexNotificationReceipt | null {
    return this.notificationReceipts.get(notification) ?? null;
  }

  setServerRequestHandler(handler: AppServerRequestHandler): void {
    this.onServerRequest = handler;
  }

  getProviderActivity(): ProviderActivitySnapshot {
    return {
      lastRawProviderEventAt: this.lastRawProviderEventAt,
      lastRawProviderEventSource: this.lastRawProviderEventSource,
    };
  }

  async connect(): Promise<void> {
    if (this.process) {
      throw new Error("Codex app-server already connected");
    }

    const commandArgs = ["app-server", "--listen", "stdio://"];
    const sandboxed = this.sessionSandbox?.wrapSpawn(
      this.command,
      commandArgs,
      this.env,
    );
    const child = (() => {
      try {
        return spawn(
          sandboxed?.command ?? this.command,
          sandboxed?.args ?? commandArgs,
          {
            cwd: sandboxed?.cwd ?? this.cwd,
            detached: process.platform !== "win32",
            stdio: sandboxed?.stdio ?? ["pipe", "pipe", "pipe"],
            env: sandboxed?.env ?? this.env,
            shell: sandboxed ? false : process.platform === "win32",
          },
        );
      } finally {
        sandboxed?.release();
      }
    })();

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
        this.recordRawProviderEvent(`codex:request:${method}`);
        const request: JsonRpcServerRequest = {
          id: message.id as JsonRpcId,
          method,
          params: message.params,
        };
        this.handleServerRequest(request);
        return;
      }

      const notification = { method, params: message.params };
      if (this.shouldSuppressNotification?.(notification)) {
        return;
      }

      this.recordRawProviderEvent(`codex:notification:${method}`);
      this.enqueueNotification(notification, "provider");
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
        const rpcError = new Error(error.message ?? "JSON-RPC request failed");
        Object.assign(rpcError, {
          jsonRpcCode: error.code,
          jsonRpcData: error.data,
          jsonRpcRequestId: id,
        });
        pending.reject(rpcError);
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

  private recordRawProviderEvent(source: string): void {
    this.lastRawProviderEventAt = new Date();
    this.lastRawProviderEventSource = source;
  }

  injectNotification(notification: JsonRpcNotification): void {
    this.enqueueNotification(notification, "synthetic");
  }

  async nextNotification(signal?: AbortSignal): Promise<JsonRpcNotification> {
    return await this.notifications.shift(signal);
  }

  private enqueueNotification(
    notification: JsonRpcNotification,
    source: CodexNotificationReceipt["source"],
  ): void {
    const receipt = {
      sequence: ++this.notificationReceiptSequence,
      receivedAtMs: Date.now(),
      queuedAhead: this.notifications.size,
      source,
    } satisfies CodexNotificationReceipt;
    this.notificationReceipts.set(notification, receipt);
    this.notifications.push(notification);
  }

  async close(): Promise<void> {
    if (this.closePromise) {
      return await this.closePromise;
    }
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
    this.closePromise = terminateChildProcess(child);
    await this.closePromise;
  }

  private handleProcessClose(error: Error): void {
    if (this.closed) return;
    this.closed = true;

    for (const pending of this.pendingRequests.values()) {
      pending.reject(error);
    }
    this.pendingRequests.clear();

    // Emit a terminal error notification so consumers can surface it.
    this.enqueueNotification(
      {
        method: "error",
        params: {
          error: { message: error.message },
          willRetry: false,
          codexProcessExit: true,
        },
      },
      "synthetic",
    );
    this.notifications.close(error);
    this.process = null;
  }

  private sendRaw(payload: Record<string, unknown>): void {
    if (this.closed) {
      return;
    }

    try {
      if (!this.process?.stdin) return;
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
  readonly supportsSlashCommands = true;
  readonly supportsSteering = true;
  readonly supportsRecaps = true;
  readonly supportsNativePromptSuggestions = false;
  readonly supportsNativeCompactThreshold = true;

  private readonly config: CodexProviderConfig;
  private readonly installationCoordinator: ProviderInstallationCoordinator;
  private modelCache: {
    models: ModelInfo[];
    expiresAt: number;
    installationSourceVersion: string;
  } | null = null;
  private getConfiguredReasoningSummary: () => CodexReasoningSummary = () =>
    DEFAULT_CODEX_REASONING_SUMMARY;
  private getConfiguredPlanToolMode: () => CodexPlanToolMode = () =>
    "provider-default";
  private getConfiguredSubagentMaxDepth: () => SubagentMaxDepth = () =>
    DEFAULT_SUBAGENT_MAX_DEPTH;

  constructor(config: CodexProviderConfig = {}) {
    if (config.externalChatgptAuth && (config.apiKey || config.baseUrl)) {
      throw new Error(
        "Managed Codex external authentication cannot use API key or endpoint overrides",
      );
    }
    this.config = config;
    this.installationCoordinator =
      config.installationCoordinator ?? providerInstallationCoordinator;
  }

  setCodexPath(codexPath: string | undefined): void {
    this.config.codexPath = codexPath;
    this.modelCache = null;
  }

  setReasoningSummaryGetter(getter: () => CodexReasoningSummary): void {
    this.getConfiguredReasoningSummary = getter;
  }

  setPlanToolModeGetter(getter: () => CodexPlanToolMode): void {
    this.getConfiguredPlanToolMode = getter;
  }

  setSubagentMaxDepthGetter(getter: () => SubagentMaxDepth): void {
    this.getConfiguredSubagentMaxDepth = getter;
  }

  getModelCatalogCacheKey(): string {
    return this.installationCoordinator.getSourceVersion(
      CODEX_INSTALLATION_FAMILY,
    );
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
    return (
      (await findCodexCliPath(
        this.config.codexPath,
        this.installationCoordinator,
      )) !== null
    );
  }

  /**
   * Resolve the codex command: explicit config, PATH, or common install locations.
   */
  private async resolveCodexCommand(): Promise<string> {
    if (this.config.codexPath) return this.config.codexPath;
    return (
      (await findCodexCliPath(undefined, this.installationCoordinator)) ??
      "codex"
    );
  }

  private getCodexClientName(overrideClientName?: string): string {
    const normalizedClientName =
      typeof overrideClientName === "string" ? overrideClientName.trim() : "";
    if (normalizedClientName.length > 0) {
      return normalizedClientName;
    }
    return DECLARE_CODEX_ORIGINATOR
      ? DECLARED_CODEX_ORIGINATOR
      : YEP_ANYWHERE_ORIGINATOR;
  }

  /**
   * Build environment overrides for Codex subprocesses.
   */
  private getCodexEnv(): NodeJS.ProcessEnv {
    const env = stripYaControlPlaneCredentials(process.env);
    delete env.YEP_SESSION_WAKE_TOKEN;
    delete env.YEP_SESSION_WAKE_URL;
    if (this.config.baseUrl) {
      env.OPENAI_BASE_URL = this.config.baseUrl;
    }
    if (this.config.apiKey) {
      env.OPENAI_API_KEY = this.config.apiKey;
    }
    if (this.config.externalChatgptAuth) {
      delete env.OPENAI_API_KEY;
      delete env.CODEX_API_KEY;
      delete env.CODEX_ACCESS_TOKEN;
      delete env.OPENAI_BASE_URL;
    }
    if (this.config.codexHome) {
      env.CODEX_HOME = this.config.codexHome;
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

  /** Get detailed launchability and authentication status. */
  async getAuthStatus(): Promise<AuthStatus> {
    const codexPath = await findCodexCliPath(
      this.config.codexPath,
      this.installationCoordinator,
    );
    const installed = codexPath !== null;
    const codexEnv = this.getCodexEnv();
    const hasEnvironmentAuth = Boolean(
      this.config.externalChatgptAuth ||
        ["OPENAI_API_KEY", "CODEX_API_KEY", "CODEX_ACCESS_TOKEN"].some((name) =>
          codexEnv[name]?.trim(),
        ),
    );
    const authenticated = Boolean(
      codexPath &&
        (hasEnvironmentAuth ||
          (await isCodexCliAuthenticated(
            codexPath,
            codexEnv,
            this.installationCoordinator,
          ))),
    );
    return {
      installed,
      authenticated,
      enabled: authenticated,
      ...(codexPath && !authenticated
        ? { loginCommand: formatCodexLoginCommand(codexPath) }
        : {}),
    };
  }

  /**
   * Get available models for Codex cloud.
   * Queries Codex app-server's model/list endpoint with a static fallback.
   */
  async getAvailableModels(): Promise<ModelInfo[]> {
    return this.installationCoordinator.withReadLease(
      CODEX_INSTALLATION_FAMILY,
      () => this.getAvailableModelsWithLease(),
    );
  }

  private async getAvailableModelsWithLease(): Promise<ModelInfo[]> {
    const now = Date.now();
    const installationSourceVersion = this.getModelCatalogCacheKey();
    if (
      this.modelCache &&
      this.modelCache.expiresAt > now &&
      this.modelCache.installationSourceVersion === installationSourceVersion
    ) {
      return this.modelCache.models;
    }

    let models: ModelInfo[] = [];
    if (await this.isCodexCliInstalled()) {
      models = await this.getModelsFromAppServer();
    }

    if (models.length === 0) {
      models = await this.getFallbackCodexModels();
    }

    this.modelCache = {
      models,
      expiresAt: now + MODEL_CACHE_TTL_MS,
      installationSourceVersion,
    };

    return models;
  }

  async getSubscriptionUsage(
    models: readonly ModelInfo[],
  ): Promise<ProviderSubscriptionUsage | null> {
    return this.installationCoordinator.withReadLease(
      CODEX_INSTALLATION_FAMILY,
      () => this.getSubscriptionUsageWithLease(models),
    );
  }

  private async getSubscriptionUsageWithLease(
    models: readonly ModelInfo[],
  ): Promise<ProviderSubscriptionUsage | null> {
    if (!(await this.isCodexCliInstalled())) return null;
    try {
      const rawUsage = await this.requestAppServerRateLimits();
      return normalizeCodexSubscriptionUsage(rawUsage, models);
    } catch (error) {
      log.debug({ error }, "Codex account rate limits are unavailable");
      return null;
    }
  }

  private async getModelsFromAppServer(): Promise<ModelInfo[]> {
    try {
      const appServerModels = await this.requestAppServerModelList();
      return normalizeCodexModelList(appServerModels);
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
        void terminateChildProcess(child).catch((error) => {
          log.warn(
            { error, pid: child.pid },
            "Failed to terminate Codex model-list app-server",
          );
        });
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

  private async requestAppServerRateLimits(): Promise<unknown> {
    const appServer = new CodexAppServerClient(
      await this.resolveCodexCommand(),
      homedir(),
      this.getCodexEnv(),
    );
    try {
      return await withCodexTimeout(
        (async () => {
          await appServer.connect();
          await appServer.request<{ userAgent: string }>(
            "initialize",
            this.createInitializeParams(false),
          );
          appServer.notify("initialized");
          return await appServer.request<unknown>("account/rateLimits/read");
        })(),
        ACCOUNT_RATE_LIMITS_TIMEOUT_MS,
        "Codex account rate-limit probe",
      );
    } finally {
      await appServer.close().catch((error) => {
        log.debug({ error }, "Failed to close Codex rate-limit app-server");
      });
    }
  }

  private async getFallbackCodexModels(): Promise<ModelInfo[]> {
    const version = await this.getInstalledCodexCliVersion();
    return getFallbackCodexModelsForCliVersion(version);
  }

  private async getInstalledCodexCliVersion(): Promise<string | null> {
    try {
      const codexCommand = await this.resolveCodexCommand();
      const version = await getCodexCliVersion(
        codexCommand,
        this.installationCoordinator,
      );
      return normalizeSemver(version);
    } catch {
      return null;
    }
  }

  private mapEffortToReasoningEffort(
    effort?: import("@yep-anywhere/shared").EffortLevel,
    thinking?: import("@yep-anywhere/shared").ThinkingConfig,
    model?: StartSessionOptions["model"],
  ): "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | undefined {
    if (thinking?.type === "disabled") {
      const normalizedModel = model?.trim().toLowerCase();
      const hasSparkModelPrefix =
        CODEX_THINKING_OFF_MIN_REASONING_EFFORT_PREFIXES.some((prefix) =>
          normalizedModel?.startsWith(prefix),
        );
      if (hasSparkModelPrefix) {
        return "low";
      }
      return "none";
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
      case "xhigh":
      case "max":
        return "xhigh";
    }
  }

  private mapPermissionModeToThreadPolicy(
    permissionMode?: StartSessionOptions["permissionMode"],
  ): CodexThreadPolicy {
    const applyOverrides = (policy: CodexThreadPolicy): CodexThreadPolicy => ({
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
        approvalPolicy: "on-request",
        sandbox: "read-only",
      });
    }

    return applyOverrides({
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
    });
  }

  private normalizePermissionMode(
    permissionMode?: StartSessionOptions["permissionMode"],
  ): PermissionMode {
    return permissionMode && permissionMode !== "auto"
      ? permissionMode
      : "default";
  }

  private mapThreadSandboxToTurnSandbox(
    sandbox: CodexSandboxMode,
    workspaceWriteSandboxPolicy: CodexSandboxPolicy | null = null,
  ): CodexSandboxPolicy {
    switch (sandbox) {
      case "danger-full-access":
        return { type: "dangerFullAccess" };
      case "read-only":
        return { type: "readOnly", networkAccess: false };
      case "workspace-write":
        if (workspaceWriteSandboxPolicy?.type === "workspaceWrite") {
          return workspaceWriteSandboxPolicy;
        }
        return {
          type: "workspaceWrite",
          writableRoots: [],
          networkAccess: false,
          excludeTmpdirEnvVar: false,
          excludeSlashTmp: false,
        };
    }
  }

  /**
   * Start a new Codex session.
   */
  async startSession(options: StartSessionOptions): Promise<AgentSession> {
    const installationLease =
      await this.installationCoordinator.acquireRuntimeLease(
        CODEX_INSTALLATION_FAMILY,
      );
    const queue = new MessageQueue();
    const abortController = new AbortController();
    const runtimeState: CodexTurnRuntimeState = {
      threadId: options.resumeSessionId ?? "",
      resolvedModel: options.model ?? "default",
      turnModelOverride: options.model ?? null,
      activeTurnId: null,
      pendingTurnStart: null,
      activePermissionMode: this.normalizePermissionMode(
        options.permissionMode,
      ),
      turnEffortOverride: options.effort,
      workspaceWriteSandboxPolicy: null,
      activeToolCallIds: new Set(),
      backgroundToolCallIds: new Set(),
    };

    // Push initial message if provided
    if (options.initialMessage) {
      queue.push(options.initialMessage);
    }

    let activeClient: CodexAppServerClient | null = null;
    let goalCommandTail: Promise<void> = Promise.resolve();
    let resolveInitialActiveClient:
      | ((client: CodexAppServerClient | null) => void)
      | null = null;
    const initialActiveClient = new Promise<CodexAppServerClient | null>(
      (resolve) => {
        resolveInitialActiveClient = resolve;
      },
    );
    const settleInitialActiveClient = (
      client: CodexAppServerClient | null,
    ): void => {
      resolveInitialActiveClient?.(client);
      resolveInitialActiveClient = null;
    };
    let agentctlSessionEnvBridge: AgentctlSessionEnvBridge | null = null;
    const skillInventory: CodexSessionSkillInventory = {
      skills: [],
      stale: true,
    };
    const sessionIterator = this.runSession(
      options,
      queue,
      abortController.signal,
      runtimeState,
      (client) => {
        activeClient = client;
        settleInitialActiveClient(client);
      },
      (bridge) => {
        agentctlSessionEnvBridge = bridge;
      },
      skillInventory,
    );
    const iterator = (async function* () {
      try {
        yield* sessionIterator;
      } finally {
        settleInitialActiveClient(null);
        await installationLease.release();
      }
    })();

    const updateActiveTurnSettings = async (
      settings: Pick<TurnSettingsUpdateParams, "model" | "effort">,
    ): Promise<void> => {
      const client = activeClient;
      let turnId = runtimeState.activeTurnId;
      if (!turnId && runtimeState.pendingTurnStart) {
        turnId = await runtimeState.pendingTurnStart;
      }
      const threadId = runtimeState.threadId;
      if (!client || !threadId || !turnId) return;

      const response = await client.request<TurnSettingsUpdateResponse>(
        "turn/settings/update",
        {
          threadId,
          turnId,
          ...settings,
        } satisfies TurnSettingsUpdateParams,
      );
      if (response.status === "targetUnavailable") {
        log.debug(
          { threadId, turnId, settings },
          "Codex active turn ended before its settings update; retaining the selection for the next turn",
        );
      }
    };

    return {
      iterator,
      queue,
      abort: async () => {
        settleInitialActiveClient(null);
        if (
          activeClient &&
          runtimeState.threadId &&
          runtimeState.activeTurnId
        ) {
          await withCodexTimeout(
            activeClient.request<TurnInterruptResponse>("turn/interrupt", {
              threadId: runtimeState.threadId,
              turnId: runtimeState.activeTurnId,
            } satisfies TurnInterruptParams),
            750,
            "Codex turn interrupt during shutdown",
          ).catch((error) => {
            log.debug(
              { error, sessionId: runtimeState.threadId },
              "Codex turn interrupt did not complete before shutdown",
            );
          });
        }
        abortController.abort();
        await activeClient?.close();
        await installationLease.release();
      },
      isProcessAlive: () => activeClient?.isAlive() ?? false,
      getProviderActivity: () =>
        activeClient?.getProviderActivity() ?? {
          lastRawProviderEventAt: null,
          lastRawProviderEventSource: null,
        },
      get pid() {
        return activeClient?.pid;
      },
      probeLiveness: async () =>
        this.probeCodexLiveness(activeClient, runtimeState),
      publishAgentctlSessionId: (sessionId, browserDebugEnvironment) => {
        agentctlSessionEnvBridge?.publishSessionId(
          sessionId,
          browserDebugEnvironment,
        );
      },
      setEffort: async (effort) => {
        if (effort !== undefined) {
          try {
            await updateActiveTurnSettings({
              effort: this.mapEffortToReasoningEffort(
                effort,
                options.thinking,
                runtimeState.turnModelOverride ?? runtimeState.resolvedModel,
              ),
            });
          } catch (error) {
            if (
              !(error instanceof Error) ||
              !("jsonRpcCode" in error) ||
              error.jsonRpcCode !== -32600
            ) {
              throw error;
            }
            // Live-turn restrictions do not reject the next turn's selection.
            log.info(
              {
                threadId: runtimeState.threadId,
                effort,
                reason: error.message,
              },
              "Codex refused live effort update; retaining selection for the next turn",
            );
          }
        }
        runtimeState.turnEffortOverride = effort ?? null;
      },
      effortUpdatesActiveTurn: true,
      setModel: async (model) => {
        if (model !== undefined) {
          await updateActiveTurnSettings({ model });
        }
        runtimeState.turnModelOverride = model ?? null;
      },
      setSessionOptions: async (requested) =>
        inactiveProviderSessionOptionsResult(
          requested,
          "Codex app-server exposes explicit thread names but no automatic title, recap, progress-summary, or prompt-suggestion generator",
        ),
      supportedCommands: async () => {
        if (activeClient) {
          await this.refreshCodexSkills(
            activeClient,
            options.cwd,
            skillInventory,
            skillInventory.stale,
          );
          if (runtimeState.threadId) {
            try {
              const { goal } =
                await activeClient.request<ThreadGoalGetResponse>(
                  "thread/goal/get",
                  {
                    threadId: runtimeState.threadId,
                  } satisfies ThreadGoalGetParams,
                );
              runtimeState.goalObjective = goal?.objective ?? null;
              runtimeState.goalStatus = goal?.status ?? null;
            } catch (error) {
              log.debug({ error }, "Codex goal completion is unavailable");
            }
          }
        }
        return this.createCodexSlashCommands(
          skillInventory.skills,
          skillInventory.stale ? "stale" : "current",
          runtimeState.goalObjective,
          runtimeState.goalStatus,
        );
      },
      steer: async (message) => {
        if (!activeClient) return false;
        if (!runtimeState.threadId || !runtimeState.activeTurnId) return false;

        let userPrompt = this.extractTextFromMessage(message);
        if (!userPrompt) return true;

        try {
          if (hasInvocationCandidate(userPrompt)) {
            await this.refreshCodexSkills(
              activeClient,
              options.cwd,
              skillInventory,
              true,
            );
          }
          const prepared = this.createCodexUserInputs(
            userPrompt,
            skillInventory.skills,
            skillInventory.stale ? "stale" : "current",
          );
          userPrompt = prepared.text;
          let expectedTurnId = runtimeState.activeTurnId;
          let retriedAfterMismatch = false;
          let steerResult: TurnSteerResponse;
          while (true) {
            try {
              steerResult = await activeClient.request<TurnSteerResponse>(
                "turn/steer",
                {
                  threadId: runtimeState.threadId,
                  clientUserMessageId: message.uuid ?? null,
                  input: prepared.input,
                  expectedTurnId,
                } satisfies TurnSteerParams,
              );
              break;
            } catch (error) {
              const actualTurnId = getCodexActiveTurnMismatchId(error);
              if (actualTurnId && actualTurnId !== expectedTurnId) {
                runtimeState.activeTurnId = actualTurnId;
                if (!retriedAfterMismatch) {
                  log.warn(
                    {
                      threadId: runtimeState.threadId,
                      expectedTurnId,
                      actualTurnId,
                    },
                    "Resynchronized Codex turn id after steer mismatch",
                  );
                  expectedTurnId = actualTurnId;
                  retriedAfterMismatch = true;
                  continue;
                }
              }
              throw error;
            }
          }
          if (steerResult.turnId) {
            runtimeState.activeTurnId = steerResult.turnId;
          }
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
      interrupt: async () => {
        if (!activeClient) return false;
        if (!runtimeState.threadId || !runtimeState.activeTurnId) return false;
        let turnId = runtimeState.activeTurnId;
        let retriedAfterMismatch = false;
        while (true) {
          try {
            await activeClient.request<TurnInterruptResponse>(
              "turn/interrupt",
              {
                threadId: runtimeState.threadId,
                turnId,
              } satisfies TurnInterruptParams,
            );
            break;
          } catch (error) {
            const actualTurnId = getCodexActiveTurnMismatchId(error);
            if (actualTurnId && actualTurnId !== turnId) {
              runtimeState.activeTurnId = actualTurnId;
              if (!retriedAfterMismatch) {
                log.warn(
                  {
                    threadId: runtimeState.threadId,
                    expectedTurnId: turnId,
                    actualTurnId,
                  },
                  "Resynchronized Codex turn id after interrupt mismatch",
                );
                turnId = actualTurnId;
                retriedAfterMismatch = true;
                continue;
              }
            }
            throw error;
          }
        }
        return true;
      },
      runProviderCommand: async (
        command,
        argument,
      ): Promise<ProviderCommandResult> => {
        const name = command.trim().replace(/^\/+/, "").toLowerCase();
        if (name === "goal") {
          const operation = goalCommandTail.then(
            async (): Promise<ProviderCommandResult> => {
              const client = activeClient ?? (await initialActiveClient);
              const threadId = runtimeState.threadId;
              if (!client || !threadId) {
                return {
                  handled: true,
                  error: "Codex session is not ready for goal commands yet",
                };
              }

              const goalArgument = argument?.trim() ?? "";
              const goalControl = goalArgument.toLowerCase();
              try {
                if (!goalArgument) {
                  const response = await client.request<ThreadGoalGetResponse>(
                    "thread/goal/get",
                    { threadId } satisfies ThreadGoalGetParams,
                  );
                  return {
                    handled: true,
                    output: response.goal
                      ? {
                          summary: "/goal",
                          details: [
                            response.goal.objective,
                            formatCodexGoalStatus(response.goal.status),
                            `${response.goal.tokensUsed.toLocaleString()} tokens used`,
                          ],
                        }
                      : { summary: "/goal", details: ["No goal set"] },
                  };
                }

                if (goalControl === "clear") {
                  const response =
                    await client.request<ThreadGoalClearResponse>(
                      "thread/goal/clear",
                      { threadId } satisfies ThreadGoalClearParams,
                    );
                  return {
                    handled: true,
                    output: {
                      summary: "/goal",
                      details: [
                        response.cleared ? "Goal cleared" : "No goal to clear",
                      ],
                    },
                  };
                }

                if (goalControl === "pause" || goalControl === "resume") {
                  const requestedStatus =
                    goalControl === "pause" ? "paused" : "active";
                  const response = await client.request<ThreadGoalSetResponse>(
                    "thread/goal/set",
                    {
                      threadId,
                      status: requestedStatus,
                    } satisfies ThreadGoalSetParams,
                  );
                  return {
                    handled: true,
                    output: {
                      summary: "/goal",
                      details: [
                        response.goal.objective,
                        response.goal.status === requestedStatus
                          ? goalControl === "pause"
                            ? "Goal paused"
                            : "Goal resumed"
                          : formatCodexGoalStatus(response.goal.status),
                      ],
                    },
                  };
                }

                if (goalControl === "edit") {
                  return {
                    handled: true,
                    error:
                      "Interactive /goal edit is unavailable in YA. Set the revised objective with /goal <objective>.",
                  };
                }

                const current = await client.request<ThreadGoalGetResponse>(
                  "thread/goal/get",
                  { threadId } satisfies ThreadGoalGetParams,
                );
                if (current.goal?.objective === goalArgument) {
                  return {
                    handled: true,
                    output: {
                      summary: "/goal",
                      details: [
                        current.goal.objective,
                        formatCodexGoalStatus(current.goal.status),
                      ],
                    },
                  };
                }
                if (current.goal) {
                  await client.request<ThreadGoalClearResponse>(
                    "thread/goal/clear",
                    { threadId } satisfies ThreadGoalClearParams,
                  );
                }
                const response = await client.request<ThreadGoalSetResponse>(
                  "thread/goal/set",
                  {
                    threadId,
                    objective: goalArgument,
                    status: "active",
                  } satisfies ThreadGoalSetParams,
                );
                return {
                  handled: true,
                  output: {
                    summary: "/goal",
                    details: [response.goal.objective, "Goal set"],
                  },
                };
              } catch (error) {
                const message =
                  error instanceof Error ? error.message : String(error);
                log.warn(
                  { threadId, argument: goalArgument, error: message },
                  "Codex goal command failed",
                );
                return { handled: true, error: message };
              }
            },
          );
          // Serialize clear-and-set transactions; callers still receive failures.
          goalCommandTail = operation.then(
            () => {},
            () => {},
          );
          return operation;
        }

        if (name === "status" || name === "usage") {
          const client = activeClient ?? (await initialActiveClient);
          if (!client) {
            return {
              handled: true,
              output: {
                summary: `/${name}`,
                details: ["Codex session is not ready yet"],
              },
            };
          }

          if (name === "status") {
            const [accountResult, rateLimitsResult] = await Promise.allSettled([
              withCodexTimeout(
                client.request<unknown>("account/read", {
                  refreshToken: false,
                }),
                ACCOUNT_RATE_LIMITS_TIMEOUT_MS,
                "Codex account status",
              ),
              withCodexTimeout(
                client.request<unknown>("account/rateLimits/read"),
                ACCOUNT_RATE_LIMITS_TIMEOUT_MS,
                "Codex account rate limits",
              ),
            ]);
            return {
              handled: true,
              output: formatCodexStatusCommand({
                model: runtimeState.resolvedModel,
                cwd: options.cwd,
                permissionMode: runtimeState.activePermissionMode,
                threadId: runtimeState.threadId,
                tokenUsage: runtimeState.latestTokenUsage,
                accountResponse:
                  accountResult.status === "fulfilled"
                    ? accountResult.value
                    : undefined,
                rateLimitsResponse:
                  rateLimitsResult.status === "fulfilled"
                    ? rateLimitsResult.value
                    : undefined,
              }),
            };
          }

          const view = parseCodexUsageView(argument);
          if (!view) {
            return {
              handled: true,
              output: {
                summary: "Usage: /usage [daily|weekly|cumulative]",
              },
            };
          }
          try {
            const account = await withCodexTimeout(
              client.request<unknown>("account/read", {
                refreshToken: false,
              }),
              ACCOUNT_RATE_LIMITS_TIMEOUT_MS,
              "Codex account status",
            );
            if (!isCodexChatGptAccount(account)) {
              return {
                handled: true,
                output: {
                  summary: "Sign in with ChatGPT to use /usage.",
                },
              };
            }
            const usage = await withCodexTimeout(
              client.request<unknown>("account/usage/read"),
              ACCOUNT_RATE_LIMITS_TIMEOUT_MS,
              "Codex account token usage",
            );
            return {
              handled: true,
              output: formatCodexUsageCommand(usage, view),
            };
          } catch (error) {
            log.debug(
              { error, threadId: runtimeState.threadId },
              "Codex account token usage is unavailable",
            );
            return {
              handled: true,
              output: { summary: "Token activity unavailable" },
            };
          }
        }

        if (name !== "compact") {
          return { handled: false };
        }
        // Codex compaction takes no instructions, so any trailing argument is
        // intentionally dropped here — there is no app-server surface for it.
        if (!activeClient || !runtimeState.threadId) {
          return {
            handled: true,
            error: "Codex session is not ready for compaction yet",
          };
        }
        // A compact runs as its own (non-steerable) turn; refuse mid-turn so we
        // do not collide with active work or send `/compact` as plain text.
        if (runtimeState.activeTurnId) {
          return {
            handled: true,
            error: "Cannot compact while a turn is in progress",
          };
        }
        try {
          await activeClient.request<ThreadCompactStartResponse>(
            "thread/compact/start",
            {
              threadId: runtimeState.threadId,
            } satisfies ThreadCompactStartParams,
          );
          return {
            handled: true,
            output: { summary: "Compaction requested" },
          };
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          log.warn(
            { threadId: runtimeState.threadId, error: message },
            "Codex thread/compact/start failed",
          );
          return { handled: true, error: message };
        }
      },
    };
  }

  async forkSession(options: {
    sessionId: string;
    cwd: string;
    upToMessageId?: string;
    boundary?: ProviderForkBoundary;
    title?: string;
    sessionSandbox?: SessionSandboxRuntime;
  }): Promise<{ sessionId: string }> {
    return this.installationCoordinator.withReadLease(
      CODEX_INSTALLATION_FAMILY,
      () => this.forkSessionWithLease(options),
    );
  }

  private async forkSessionWithLease(options: {
    sessionId: string;
    cwd: string;
    upToMessageId?: string;
    boundary?: ProviderForkBoundary;
    title?: string;
    sessionSandbox?: SessionSandboxRuntime;
  }): Promise<{ sessionId: string }> {
    if (options.boundary && options.boundary.kind !== "turn") {
      throw new Error("Codex fork requires a turn boundary");
    }
    const codexCommand = await this.resolveCodexCommand();
    const appServer = new CodexAppServerClient(
      codexCommand,
      options.cwd,
      this.getCodexEnv(),
      undefined,
      options.sessionSandbox,
    );
    appServer.setServerRequestHandler((request) =>
      this.handleForkServerRequest(request),
    );

    try {
      await appServer.connect();
      const experimentalApiEnabled = await this.initializeAppServer(appServer);
      appServer.notify("initialized");

      const rollbackCount = options.boundary
        ? 0
        : options.upToMessageId
          ? await this.resolveCodexForkRollbackCount(
              appServer,
              options.sessionId,
              options.upToMessageId,
            )
          : 0;
      const policy = this.mapPermissionModeToThreadPolicy(undefined);
      const fork = await appServer.request<ThreadForkResponse>(
        "thread/fork",
        this.createThreadForkParams(options, policy, experimentalApiEnabled),
      );
      const forkSessionId = fork.thread?.id;
      if (!forkSessionId) {
        throw new Error("Codex thread/fork did not return a thread id");
      }

      if (rollbackCount > 0) {
        await appServer.request<ThreadRollbackResponse>("thread/rollback", {
          threadId: forkSessionId,
          numTurns: rollbackCount,
        } satisfies ThreadRollbackParams);
      }

      log.info(
        {
          sourceSessionId: options.sessionId,
          forkSessionId,
          boundaryTurnId:
            options.boundary?.kind === "turn" ? options.boundary.turnId : null,
          upToMessageId: options.upToMessageId ?? null,
          rollbackCount,
        },
        "Forked Codex app-server thread",
      );
      return { sessionId: forkSessionId };
    } finally {
      await appServer.close();
    }
  }

  private async probeCodexLiveness(
    activeClient: CodexAppServerClient | null,
    runtimeState: CodexTurnRuntimeState,
  ): Promise<ProviderLivenessProbeResult> {
    const checkedAt = new Date();
    const source = "codex:thread/read";

    if (!activeClient?.isAlive()) {
      return {
        status: "unavailable",
        source,
        checkedAt,
        detail: "Codex app-server is not alive",
      };
    }
    if (!runtimeState.threadId) {
      return {
        status: "unavailable",
        source,
        checkedAt,
        detail: "No Codex thread id is available",
      };
    }

    try {
      const response = await activeClient.request<ThreadReadResponse>(
        "thread/read",
        {
          threadId: runtimeState.threadId,
          includeTurns: false,
        } satisfies ThreadReadParams,
      );
      const status =
        response.thread?.status && typeof response.thread.status === "object"
          ? (response.thread.status as {
              type?: string;
              activeFlags?: unknown;
            })
          : null;
      const statusType = status?.type;
      const activeFlags = Array.isArray(status?.activeFlags)
        ? status.activeFlags.filter(
            (flag): flag is string => typeof flag === "string",
          )
        : [];
      const mappedStatus = this.mapCodexThreadStatusToLiveness(
        statusType,
        activeFlags,
      );

      if (mappedStatus === "idle" && runtimeState.activeTurnId) {
        activeClient.injectNotification({
          method: "turn/completed",
          params: {
            threadId: runtimeState.threadId,
            turn: {
              id: runtimeState.activeTurnId,
              items: [],
              status: "completed",
              error: null,
              startedAt: null,
              completedAt: null,
              durationMs: null,
            },
          },
        });
      }

      return {
        status: mappedStatus,
        source,
        checkedAt,
        detail: this.formatCodexThreadStatusProbeDetail(
          statusType,
          activeFlags,
        ),
      };
    } catch (error) {
      return {
        status: "error",
        source,
        checkedAt,
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private mapCodexThreadStatusToLiveness(
    statusType: string | undefined,
    activeFlags: string[],
  ): ProviderLivenessProbeResult["status"] {
    switch (statusType) {
      case "active":
        return activeFlags.includes("waitingOnApproval") ||
          activeFlags.includes("waitingOnUserInput")
          ? "waiting-input"
          : "active";
      case "idle":
        return "idle";
      case "notLoaded":
        return "not-loaded";
      case "systemError":
        return "system-error";
      default:
        return "error";
    }
  }

  private formatCodexThreadStatusProbeDetail(
    statusType: string | undefined,
    activeFlags: string[],
  ): string {
    if (!statusType) {
      return "thread.status:missing";
    }
    return activeFlags.length > 0
      ? `thread.status:${statusType} flags:${activeFlags.join(",")}`
      : `thread.status:${statusType}`;
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
    setAgentctlSessionEnvBridge: (
      bridge: AgentctlSessionEnvBridge | null,
    ) => void,
    skillInventory: CodexSessionSkillInventory,
  ): AsyncIterableIterator<SDKMessage> {
    const codexCommand = await this.resolveCodexCommand();
    const agentctlSessionEnvBridge = createAgentctlSessionEnvBridge(
      options.resumeSessionId,
      options.getSessionChildEnv,
    );
    setAgentctlSessionEnvBridge(agentctlSessionEnvBridge);
    const codexEnv = agentctlSessionEnvBridge.extendEnv(this.getCodexEnv());
    if (options.resumeSessionId) {
      // The bridge only reaches bash tool shells that source BASH_ENV, which
      // codex's sandbox may strip. For resume the id is known at spawn, so set
      // it directly in the app-server env too; every shell codex launches
      // inherits it regardless of BASH_ENV. New sessions (id unknown until
      // thread/start) stay on the bridge alone.
      codexEnv.AGENTCTL_SESSION_ID = options.resumeSessionId;
      Object.assign(
        codexEnv,
        options.getSessionChildEnv?.(options.resumeSessionId),
      );
    }
    const appServer = new CodexAppServerClient(
      codexCommand,
      options.cwd,
      codexEnv,
      (notification) =>
        this.shouldSuppressLiveDeltaNotification(notification, options),
      options.sessionSandbox,
    );
    setActiveClient(appServer);

    let sessionId = options.resumeSessionId ?? "";
    const usageByTurnId = new Map<string, TokenUsageSnapshot>();
    const failureTrace: CodexFailureTrace = {
      sessionId: sessionId || undefined,
      activeTurnId: null,
      recentNotifications: [],
    };
    const logRawNotification = (notification: JsonRpcNotification): void => {
      this.logRawCodexNotification(sessionId || "unknown", notification);
    };

    appServer.setServerRequestHandler(async (request) => {
      if (request.method === "account/chatgptAuthTokens/refresh") {
        return await this.refreshExternalChatgptAuth(request);
      }
      return await this.handleServerRequestApproval(
        request,
        options,
        signal,
        runtimeState.activePermissionMode,
      );
    });

    try {
      await appServer.connect();

      const experimentalApiEnabled = await this.initializeAppServer(
        appServer,
        options.clientName,
        Boolean(this.config.externalChatgptAuth),
      );
      appServer.notify("initialized");
      await this.loginWithExternalChatgptAuth(appServer);
      await this.refreshCodexSkills(
        appServer,
        options.cwd,
        skillInventory,
        false,
      );

      const initialPermissionMode = this.normalizePermissionMode(
        options.permissionMode,
      );
      const policy = this.mapPermissionModeToThreadPolicy(
        initialPermissionMode,
      );

      const threadResumeParams = this.createThreadResumeParams(
        options,
        sessionId,
        policy,
        experimentalApiEnabled,
      );
      const threadStartParams = this.createThreadStartParams(options, policy);
      const threadResult = await this.startOrResumeThread(
        appServer,
        options,
        threadStartParams,
        threadResumeParams,
      );
      options.onPermissionModeApplied?.(initialPermissionMode);

      sessionId = threadResult.thread.id;
      agentctlSessionEnvBridge.publishSessionId(sessionId);
      runtimeState.threadId = sessionId;
      runtimeState.resolvedModel = threadResult.model;
      if (threadResult.sandbox?.type === "workspaceWrite") {
        runtimeState.workspaceWriteSandboxPolicy = threadResult.sandbox;
      }
      failureTrace.sessionId = sessionId;
      log.info(
        {
          sessionId,
          permissionMode: initialPermissionMode,
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
      yield withCodexTimestamp({
        type: "system",
        subtype: "init",
        session_id: sessionId,
        cwd: options.cwd,
        slash_command_inventory: this.createCodexSlashCommands(
          skillInventory.skills,
          skillInventory.stale ? "stale" : "current",
        ),
      } as SDKMessage);

      const requestedReasoningEffort = this.mapEffortToReasoningEffort(
        options.effort,
        options.thinking,
      );
      const sessionConfigAck = this.createSessionConfigAckMessage(
        sessionId,
        threadResult.model,
        options.model,
        threadResult.reasoningEffort,
        requestedReasoningEffort,
      );
      if (sessionConfigAck) {
        yield withCodexTimestamp(sessionConfigAck);
      }

      const liveEventState = this.createLiveEventState();
      const observeCommands = async (
        notification: JsonRpcNotification,
      ): Promise<SDKMessage | null> => {
        if (notification.method === "skills/changed") {
          skillInventory.stale = true;
          await this.refreshCodexSkills(
            appServer,
            options.cwd,
            skillInventory,
            true,
          );
          return withCodexTimestamp({
            type: "system",
            subtype: "commands_changed",
            session_id: sessionId,
            slash_command_inventory: this.createCodexSlashCommands(
              skillInventory.skills,
              skillInventory.stale ? "stale" : "current",
              runtimeState.goalObjective,
              runtimeState.goalStatus,
            ),
          } as SDKMessage);
        }
        const params = notification.params as
          | {
              threadId?: string;
              goal?: ThreadGoalSetResponse["goal"];
            }
          | undefined;
        if (
          params?.threadId !== sessionId ||
          (notification.method !== "thread/goal/updated" &&
            notification.method !== "thread/goal/cleared")
        )
          return null;
        const objective =
          notification.method === "thread/goal/cleared"
            ? null
            : params.goal?.objective;
        if (objective !== null && typeof objective !== "string") return null;
        const goalStatus =
          notification.method === "thread/goal/cleared"
            ? null
            : params.goal?.status;
        if (
          objective === runtimeState.goalObjective &&
          goalStatus === runtimeState.goalStatus
        )
          return null;
        runtimeState.goalObjective = objective;
        runtimeState.goalStatus = goalStatus;
        return withCodexTimestamp({
          type: "system",
          subtype: "commands_changed",
          session_id: sessionId,
          slash_command_inventory: this.createCodexSlashCommands(
            skillInventory.skills,
            skillInventory.stale ? "stale" : "current",
            objective,
            goalStatus,
          ),
        } as SDKMessage);
      };
      let pendingNotification: Promise<JsonRpcNotification> | null = null;
      const peekNotification = () => {
        if (!pendingNotification) {
          pendingNotification = appServer.nextNotification(signal);
          // A turn-start RPC can fail before the prefetched notification is read.
          void pendingNotification.catch(() => {});
        }
        return pendingNotification;
      };
      const readNotification = async () => {
        const notification = await peekNotification();
        pendingNotification = null;
        return notification;
      };
      const consumeTurn = async function* (
        provider: CodexProvider,
        turn: CodexThreadTurn,
        notificationBarrierSequence: number,
      ): AsyncGenerator<
        SDKMessage,
        { overloadError: SDKMessage | null },
        void
      > {
        const activeTurnId = turn.id;
        runtimeState.activeTurnId = activeTurnId;
        runtimeState.activeToolCallIds.clear();
        runtimeState.backgroundToolCallIds.clear();
        failureTrace.activeTurnId = activeTurnId;
        let turnComplete = turn.status !== "inProgress";
        if (!turnComplete) {
          yield {
            type: "system",
            subtype: "session_state_changed",
            state: "running",
            session_id: sessionId,
          };
        }
        let emittedTurnError = false;
        let overloadError: SDKMessage | null = null;
        let suppressedPreTurnNotifications: {
          count: number;
          firstSequence: number;
          lastSequence: number;
          firstTurnId: string;
          lastTurnId: string;
          firstMethod: string;
          lastMethod: string;
          firstStartedAt: number | null;
          lastStartedAt: number | null;
          maxQueueAgeMs: number;
          maxQueuedAhead: number;
        } | null = null;

        const logSuppressedPreTurnNotifications = (reason: string): void => {
          if (!suppressedPreTurnNotifications) return;
          log.warn(
            {
              sessionId,
              expectedTurnId: runtimeState.activeTurnId ?? activeTurnId,
              expectedTurnStartedAt: turn.startedAt,
              notificationBarrierSequence,
              ...suppressedPreTurnNotifications,
              reason,
            },
            "Suppressed stale Codex notifications queued before turn start",
          );
          suppressedPreTurnNotifications = null;
        };

        while (!turnComplete && !signal.aborted) {
          const notification = await readNotification();
          if (
            provider.shouldSuppressLiveDeltaNotification(notification, options)
          ) {
            continue;
          }
          const notificationReceipt =
            appServer.getNotificationReceipt(notification);
          const currentActiveTurnId: string =
            runtimeState.activeTurnId ?? activeTurnId;
          const observedTurnId = getCodexNotificationTurnId(
            notification,
            runtimeState.threadId,
          );
          const queuedBeforeTurnStart =
            notificationReceipt !== null &&
            notificationReceipt.sequence <= notificationBarrierSequence;
          if (
            observedTurnId &&
            observedTurnId !== currentActiveTurnId &&
            queuedBeforeTurnStart
          ) {
            const queueAgeMs = Math.max(
              0,
              Date.now() - notificationReceipt.receivedAtMs,
            );
            const startedAt = getCodexNotificationTurnStartedAt(notification);
            if (suppressedPreTurnNotifications) {
              suppressedPreTurnNotifications.count += 1;
              suppressedPreTurnNotifications.lastSequence =
                notificationReceipt.sequence;
              suppressedPreTurnNotifications.lastTurnId = observedTurnId;
              suppressedPreTurnNotifications.lastMethod = notification.method;
              suppressedPreTurnNotifications.lastStartedAt = startedAt;
              suppressedPreTurnNotifications.maxQueueAgeMs = Math.max(
                suppressedPreTurnNotifications.maxQueueAgeMs,
                queueAgeMs,
              );
              suppressedPreTurnNotifications.maxQueuedAhead = Math.max(
                suppressedPreTurnNotifications.maxQueuedAhead,
                notificationReceipt.queuedAhead,
              );
            } else {
              suppressedPreTurnNotifications = {
                count: 1,
                firstSequence: notificationReceipt.sequence,
                lastSequence: notificationReceipt.sequence,
                firstTurnId: observedTurnId,
                lastTurnId: observedTurnId,
                firstMethod: notification.method,
                lastMethod: notification.method,
                firstStartedAt: startedAt,
                lastStartedAt: startedAt,
                maxQueueAgeMs: queueAgeMs,
                maxQueuedAhead: notificationReceipt.queuedAhead,
              };
            }
            continue;
          }
          if (observedTurnId) {
            logSuppressedPreTurnNotifications(
              "turn-scoped notification reached",
            );
          }

          logRawNotification(notification);
          const goalCommands = await observeCommands(notification);
          if (goalCommands) yield goalCommands;
          if (notification.method === "skills/changed") {
            continue;
          }
          failureTrace.activeTurnId = currentActiveTurnId;

          if (notification.method === "thread/tokenUsage/updated") {
            const usage = provider.extractTurnUsage(notification.params);
            if (usage) {
              usageByTurnId.set(usage.turnId, usage.snapshot);
              runtimeState.latestTokenUsage = usage.total;
            }
          }
          provider.updateBackgroundProcessTracking(notification, runtimeState);
          provider.recordCodexFailureTraceEvent(
            failureTrace,
            provider.describeNotificationForFailureTrace(notification),
          );

          if (observedTurnId && observedTurnId !== runtimeState.activeTurnId) {
            log.warn(
              {
                sessionId,
                expectedTurnId: runtimeState.activeTurnId,
                actualTurnId: observedTurnId,
                notificationMethod: notification.method,
                notificationBarrierSequence,
                notificationReceiptSequence:
                  notificationReceipt?.sequence ?? null,
                notificationQueueAgeMs: notificationReceipt
                  ? Math.max(0, Date.now() - notificationReceipt.receivedAtMs)
                  : null,
                notificationQueuedAhead:
                  notificationReceipt?.queuedAhead ?? null,
                notificationSource: notificationReceipt?.source ?? null,
                notificationTurnStartedAt:
                  getCodexNotificationTurnStartedAt(notification),
              },
              "Resynchronized Codex turn id from provider notification",
            );
            runtimeState.activeTurnId = observedTurnId;
          }
          const effectiveActiveTurnId =
            runtimeState.activeTurnId ?? currentActiveTurnId;

          const messages = provider.convertNotificationToSDKMessages(
            notification,
            sessionId,
            usageByTurnId,
            liveEventState,
          );
          const isServerOverload = provider.isCodexServerOverloadedNotification(
            notification,
            effectiveActiveTurnId,
          );
          const suppressFailedOverloadCompletion =
            overloadError !== null &&
            notification.method === "turn/completed" &&
            provider.isTurnTerminalNotification(
              notification,
              effectiveActiveTurnId,
            );
          for (const rawMsg of messages) {
            const msg =
              rawMsg.type === "error"
                ? ({
                    ...rawMsg,
                    codexFailureTrace:
                      provider.snapshotCodexFailureTrace(failureTrace),
                    codexFailureSummary:
                      provider.formatCodexFailureTrace(failureTrace),
                  } as SDKMessage)
                : rawMsg;
            if (isServerOverload && msg.type === "error") {
              overloadError = msg;
              continue;
            }
            if (suppressFailedOverloadCompletion) {
              continue;
            }
            failureTrace.lastEmittedMessage =
              provider.describeSDKMessageForFailureTrace(msg);
            yield msg;
          }

          if (isServerOverload) {
            continue;
          }
          if (
            provider.isTurnTerminalNotification(
              notification,
              effectiveActiveTurnId,
            )
          ) {
            if (notification.method === "error") emittedTurnError = true;
            turnComplete = true;
          }
        }
        logSuppressedPreTurnNotifications("turn consumption ended");
        runtimeState.activeTurnId = null;
        failureTrace.activeTurnId = null;

        if (signal.aborted) {
          return { overloadError: null };
        }

        if (
          !emittedTurnError &&
          turn.status === "failed" &&
          turn.error?.message
        ) {
          const fallbackError = {
            type: "error",
            uuid: `codex-error-${turn.id}`,
            session_id: sessionId,
            error: turn.error.message,
            codexErrorInfo: turn.error.codexErrorInfo ?? null,
            codexAdditionalDetails: readCodexTurnErrorDetail(turn.error),
            codexWillRetry: false,
            codexTurnId: turn.id,
            codexFailureTrace: provider.snapshotCodexFailureTrace(failureTrace),
            codexFailureSummary: provider.formatCodexFailureTrace(failureTrace),
            codexRequestId: provider.extractOpenAIRequestId(
              turn.error,
              turn.error.additionalDetails,
              turn.error.message,
            ),
          } as SDKMessage;
          if (turn.error.codexErrorInfo === "serverOverloaded") {
            return { overloadError: fallbackError };
          }
          yield fallbackError;
        }

        if (overloadError) {
          return { overloadError };
        }

        yield {
          type: "result",
          session_id: sessionId,
        } as SDKMessage;
        return { overloadError: null };
      };

      const messageGen = queue[Symbol.asyncIterator]();
      const stopMessageWait = () => {
        void messageGen.return?.();
      };
      signal.addEventListener("abort", stopMessageWait, { once: true });
      let isFirstMessage = !options.resumeSessionId;

      try {
        while (!signal.aborted) {
          let releaseQueueListener = () => {};
          const inputReady = new Promise<"input">((resolve) => {
            releaseQueueListener = queue.subscribeDepth((depth) => {
              if (depth > 0) resolve("input");
            });
          });
          let next: "input" | JsonRpcNotification;
          try {
            next = await Promise.race([peekNotification(), inputReady]);
          } finally {
            releaseQueueListener();
          }
          if (next !== "input") {
            pendingNotification = null;
            logRawNotification(next);
            const goalCommands = await observeCommands(next);
            if (goalCommands) yield goalCommands;
            if (next.method === "turn/started") {
              const params = asCodexTurnCompletedNotification(next.params);
              if (params?.threadId === sessionId) {
                const { overloadError } = yield* consumeTurn(
                  this,
                  params.turn,
                  0,
                );
                if (overloadError) {
                  yield overloadError;
                  yield { type: "result", session_id: sessionId } as SDKMessage;
                }
              }
            } else if (appServer.isClosed) {
              throw new Error("Codex app-server closed while awaiting work");
            }
            continue;
          }
          const queued = await messageGen.next();
          if (queued.done) break;
          const message = queued.value;
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

          if (hasInvocationCandidate(userPrompt)) {
            await this.refreshCodexSkills(
              appServer,
              options.cwd,
              skillInventory,
              true,
            );
          }
          const preparedInput = this.createCodexUserInputs(
            userPrompt,
            skillInventory.skills,
            skillInventory.stale ? "stale" : "current",
          );
          userPrompt = preparedInput.text;

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
          failureTrace.lastUserMessage = {
            uuid: message.uuid,
            chars: userPrompt.length,
          };
          yield userMessage;

          const turnPermissionMode = this.normalizePermissionMode(
            this.getPermissionModeFromMessage(message) ??
              options.permissionMode,
          );
          const turnPolicy =
            this.mapPermissionModeToThreadPolicy(turnPermissionMode);
          runtimeState.activePermissionMode = turnPermissionMode;
          const turnStartParams = this.createTurnStartParams(
            sessionId,
            preparedInput.input,
            options,
            turnPolicy,
            runtimeState.workspaceWriteSandboxPolicy,
            runtimeState.turnModelOverride,
            runtimeState.turnEffortOverride,
            message.uuid,
          );
          let notificationBarrierSequence =
            appServer.lastNotificationReceiptSequence;
          let settlePendingTurnStart: (turnId: string | null) => void =
            () => {};
          const pendingTurnStart = new Promise<string | null>((resolve) => {
            settlePendingTurnStart = resolve;
          });
          runtimeState.pendingTurnStart = pendingTurnStart;
          let turnResult: TurnStartResponse;
          try {
            turnResult = await appServer.request<TurnStartResponse>(
              "turn/start",
              turnStartParams,
            );
            runtimeState.activeTurnId = turnResult.turn.id;
            settlePendingTurnStart(turnResult.turn.id);
          } catch (error) {
            settlePendingTurnStart(null);
            throw error;
          } finally {
            if (runtimeState.pendingTurnStart === pendingTurnStart) {
              runtimeState.pendingTurnStart = null;
            }
          }
          options.onPermissionModeApplied?.(turnPermissionMode);

          log.info(
            {
              sessionId,
              turnId: turnResult.turn.id,
              turnStatus: turnResult.turn.status,
              permissionMode: turnPermissionMode,
              approvalPolicy: turnPolicy.approvalPolicy,
              sandboxPolicy: turnStartParams.sandboxPolicy,
            },
            "Started Codex app-server turn",
          );
          let overloadRetryAttempt = 0;
          while (!signal.aborted) {
            const { overloadError } = yield* consumeTurn(
              this,
              turnResult.turn,
              notificationBarrierSequence,
            );
            if (!overloadError) break;

            overloadRetryAttempt += 1;
            if (overloadRetryAttempt > CODEX_SERVER_OVERLOAD_RETRY_LIMIT) {
              yield {
                ...overloadError,
                codexWillRetry: false,
                codexOverloadRetryExhausted: true,
                codexRetryAttempt: CODEX_SERVER_OVERLOAD_RETRY_LIMIT,
                codexRetryMaxRetries: CODEX_SERVER_OVERLOAD_RETRY_LIMIT,
              } as SDKMessage;
              yield {
                type: "result",
                session_id: sessionId,
              } as SDKMessage;
              break;
            }

            const retryDelayMs =
              getCodexOverloadRetryDelayMs(overloadRetryAttempt);
            yield {
              ...overloadError,
              codexWillRetry: true,
              codexOverloadRetry: true,
              codexRetryDelayMs: retryDelayMs,
              codexRetryAttempt: overloadRetryAttempt,
              codexRetryMaxRetries: CODEX_SERVER_OVERLOAD_RETRY_LIMIT,
            } as SDKMessage;

            log.info(
              {
                sessionId,
                turnId: overloadError.codexTurnId,
                model: turnStartParams.model ?? runtimeState.resolvedModel,
                retryAttempt: overloadRetryAttempt,
                retryDelayMs,
              },
              "Codex model is overloaded; waiting to retry the turn",
            );
            const retryReady = await (
              this.config.overloadRetryWait ?? waitForCodexOverloadRetry
            )(retryDelayMs, signal);
            if (!retryReady || signal.aborted) break;

            const retryTurnStartParams = this.createTurnStartParams(
              sessionId,
              [],
              options,
              turnPolicy,
              runtimeState.workspaceWriteSandboxPolicy,
              runtimeState.turnModelOverride,
              runtimeState.turnEffortOverride,
            );
            notificationBarrierSequence =
              appServer.lastNotificationReceiptSequence;
            turnResult = await appServer.request<TurnStartResponse>(
              "turn/start",
              retryTurnStartParams,
            );
            log.info(
              {
                sessionId,
                turnId: turnResult.turn.id,
                turnStatus: turnResult.turn.status,
                model: retryTurnStartParams.model ?? runtimeState.resolvedModel,
                retryAttempt: overloadRetryAttempt,
                approvalPolicy: turnPolicy.approvalPolicy,
                sandboxPolicy: retryTurnStartParams.sandboxPolicy,
              },
              "Retried Codex overloaded turn without resending user input",
            );
          }
        }
      } finally {
        signal.removeEventListener("abort", stopMessageWait);
        await messageGen.return?.();
      }
    } catch (error) {
      const codexFailureTrace = this.snapshotCodexFailureTrace(failureTrace);
      if (!signal.aborted) {
        log.error(
          { error, codexFailureTrace },
          "Error in codex app-server session",
        );
        const isProcessFailure = appServer.isClosed;
        yield {
          type: "error",
          ...(isProcessFailure
            ? {
                uuid: `codex-error-${sessionId || "unknown"}-process-exit`,
                codexWillRetry: false,
                codexErrorScope: "app_server_process",
              }
            : {}),
          session_id: sessionId,
          error: error instanceof Error ? error.message : String(error),
          codexFailureTrace,
          codexFailureSummary: this.formatCodexFailureTrace(codexFailureTrace),
        } as SDKMessage;
      }
    } finally {
      runtimeState.activeTurnId = null;
      try {
        await appServer.close();
      } finally {
        agentctlSessionEnvBridge.cleanup();
        setAgentctlSessionEnvBridge(null);
      }
    }

    yield {
      type: "result",
      session_id: sessionId,
    } as SDKMessage;
  }

  private logRawCodexNotification(
    sessionId: string,
    notification: JsonRpcNotification,
  ): void {
    logSDKMessage(
      sessionId || "unknown",
      {
        _rawSource: "codex_app_server_notification",
        ...notification,
      },
      { provider: "codex" },
    );
  }

  private shouldSuppressLiveDeltaNotification(
    notification: JsonRpcNotification,
    options: StartSessionOptions,
  ): boolean {
    if (!isCodexLiveDeltaNotificationMethod(notification.method)) {
      return false;
    }
    if (isCodexLiveDeltaSuppressionEnabled()) {
      return true;
    }
    return options.shouldEmitLiveDeltas?.() === false;
  }

  private isTurnTerminalNotification(
    notification: JsonRpcNotification,
    turnId: string,
  ): boolean {
    if (notification.method === "turn/completed") {
      const params = asCodexTurnCompletedNotification(notification.params);
      return params?.turn.id === turnId;
    }

    if (notification.method === "error") {
      const params = asCodexErrorNotification(notification.params);
      if (params) {
        return params.turnId === turnId && !params.willRetry;
      }
      const rawParams =
        notification.params && typeof notification.params === "object"
          ? (notification.params as Record<string, unknown>)
          : null;
      return (
        rawParams?.codexProcessExit === true && rawParams.willRetry === false
      );
    }

    return false;
  }

  private isCodexServerOverloadedNotification(
    notification: JsonRpcNotification,
    turnId: string,
  ): boolean {
    if (notification.method !== "error") return false;
    const params = asCodexErrorNotification(notification.params);
    return (
      params?.turnId === turnId &&
      params.willRetry === false &&
      params.error.codexErrorInfo === "serverOverloaded"
    );
  }

  private updateBackgroundProcessTracking(
    notification: JsonRpcNotification,
    runtimeState: CodexTurnRuntimeState,
  ): void {
    if (notification.method === "rawResponseItem/completed") {
      const params = asCodexRawResponseItemCompletedNotification(
        notification.params,
      );
      const item =
        params?.item && typeof params.item === "object"
          ? (params.item as Record<string, unknown>)
          : null;
      const itemType = this.getOptionalString(item?.type);
      if (itemType === "function_call" || itemType === "custom_tool_call") {
        const callId = this.getOptionalString(item?.call_id);
        if (callId) {
          runtimeState.activeToolCallIds.add(callId);
        }
        return;
      }
      if (
        itemType === "function_call_output" ||
        itemType === "custom_tool_call_output"
      ) {
        const callId = this.getOptionalString(item?.call_id);
        if (!callId) return;
        if (isCodexBackgroundProcessOutput(item?.output)) {
          runtimeState.backgroundToolCallIds.add(callId);
        } else {
          runtimeState.activeToolCallIds.delete(callId);
          runtimeState.backgroundToolCallIds.delete(callId);
        }
      }
      return;
    }

    if (notification.method === "item/completed") {
      const params = asCodexItemCompletedNotification(notification.params);
      if (!params) return;
      const normalized = this.normalizeThreadItem(params.item);
      if (normalized?.type === "command_execution") {
        runtimeState.activeToolCallIds.delete(normalized.id);
        runtimeState.backgroundToolCallIds.delete(normalized.id);
      }
      return;
    }

    if (notification.method === "item/started") {
      const params = asCodexItemStartedNotification(notification.params);
      if (!params) return;
      const normalized = this.normalizeThreadItem(params.item);
      if (normalized && this.isResultBackedThreadItem(normalized)) {
        runtimeState.activeToolCallIds.add(normalized.id);
      }
    }
  }

  private createInitializeParams(
    experimentalApiEnabled: boolean,
    clientName?: string,
  ): {
    clientInfo: { name: string; title: null; version: string };
    capabilities: { experimentalApi: boolean } | null;
  } {
    return {
      clientInfo: {
        name: this.getCodexClientName(clientName),
        title: null,
        version: "dev",
      },
      capabilities: experimentalApiEnabled ? { experimentalApi: true } : null,
    };
  }

  private async initializeAppServer(
    appServer: CodexAppServerClient,
    clientName?: string,
    requireExperimentalApi = false,
  ): Promise<boolean> {
    try {
      await appServer.request<{ userAgent: string }>(
        "initialize",
        this.createInitializeParams(true, clientName),
      );
      return true;
    } catch (error) {
      if (requireExperimentalApi) {
        throw new Error(
          "Target Codex external-token protocol is incompatible",
          { cause: error },
        );
      }
      log.info(
        {
          event: "codex_experimental_api_unavailable",
          error: error instanceof Error ? error.message : String(error),
        },
        "Codex initialize with experimentalApi failed; retrying without capabilities",
      );
      await appServer.request<{ userAgent: string }>(
        "initialize",
        this.createInitializeParams(false, clientName),
      );
      return false;
    }
  }

  private async loginWithExternalChatgptAuth(
    appServer: CodexAppServerClient,
  ): Promise<void> {
    const externalAuth = this.config.externalChatgptAuth;
    if (!externalAuth) return;
    const projection = externalAuth.initialProjection;
    this.assertExternalChatgptAuthProjection(projection);
    try {
      await appServer.request("account/login/start", {
        type: "chatgptAuthTokens",
        accessToken: projection.accessToken,
        chatgptAccountId: projection.chatgptAccountId,
        chatgptPlanType: projection.chatgptPlanType,
      });
    } catch (error) {
      throw new Error("Managed Codex external-token login failed", {
        cause: error,
      });
    }
  }

  private async refreshExternalChatgptAuth(
    request: JsonRpcServerRequest,
  ): Promise<CodexExternalChatgptAuthProjection> {
    const externalAuth = this.config.externalChatgptAuth;
    if (!externalAuth) {
      throw new Error("Managed Codex external authentication is unavailable");
    }
    const params =
      request.params && typeof request.params === "object"
        ? (request.params as Record<string, unknown>)
        : {};
    const previousAccountId =
      typeof params.previousAccountId === "string"
        ? params.previousAccountId
        : "";
    const expectedAccountId = externalAuth.initialProjection.chatgptAccountId;
    if (!previousAccountId || previousAccountId !== expectedAccountId) {
      throw new Error("Managed Codex refresh account mismatch");
    }
    const projection = await externalAuth.refresh({
      reason:
        typeof params.reason === "string" ? params.reason : "unauthorized",
      previousAccountId,
    });
    this.assertExternalChatgptAuthProjection(projection);
    if (projection.chatgptAccountId !== expectedAccountId) {
      throw new Error("Managed Codex refresh changed account");
    }
    return projection;
  }

  private assertExternalChatgptAuthProjection(
    projection: CodexExternalChatgptAuthProjection,
  ): void {
    if (
      !projection ||
      typeof projection.accessToken !== "string" ||
      projection.accessToken.length === 0 ||
      typeof projection.chatgptAccountId !== "string" ||
      projection.chatgptAccountId.length === 0 ||
      !(
        projection.chatgptPlanType === null ||
        typeof projection.chatgptPlanType === "string"
      )
    ) {
      throw new Error("Managed Codex auth projection is invalid");
    }
  }

  private async startOrResumeThread(
    appServer: CodexAppServerClient,
    options: StartSessionOptions,
    threadStartParams: ThreadStartParams,
    threadResumeParams: CodexThreadResumeParamsForRequest,
  ): Promise<ThreadStartResponse | ThreadResumeResponse> {
    return options.resumeSessionId
      ? await appServer.request<ThreadResumeResponse>(
          "thread/resume",
          threadResumeParams,
        )
      : await appServer.request<ThreadStartResponse>(
          "thread/start",
          threadStartParams,
        );
  }

  private createThreadStartParams(
    options: StartSessionOptions,
    policy: CodexThreadPolicy,
  ): ThreadStartParams {
    return {
      model: options.model ?? null,
      ...(options.serviceTier ? { serviceTier: options.serviceTier } : {}),
      cwd: options.cwd,
      ...this.buildThreadPermissionParams(policy),
      config: this.buildThreadConfigOverrides(options),
      experimentalRawEvents: false,
    };
  }

  private createThreadResumeParams(
    options: StartSessionOptions,
    sessionId: string,
    policy: CodexThreadPolicy,
    experimentalApiEnabled = false,
    includeTurns = false,
  ): CodexThreadResumeParamsForRequest {
    const params: CodexThreadResumeParamsForRequest = {
      threadId: options.resumeSessionId ?? sessionId,
      model: options.model ?? null,
      ...(options.serviceTier ? { serviceTier: options.serviceTier } : {}),
      cwd: options.cwd,
      ...this.buildThreadPermissionParams(policy),
      config: this.buildThreadConfigOverrides(options),
    };
    if (experimentalApiEnabled && !includeTurns) {
      params.excludeTurns = true;
    }
    return params;
  }

  private createThreadForkParams(
    options: {
      sessionId: string;
      cwd: string;
      boundary?: ProviderForkBoundary;
    },
    policy: CodexThreadPolicy,
    experimentalApiEnabled = false,
  ): CodexThreadForkParamsForRequest {
    const params: CodexThreadForkParamsForRequest = {
      threadId: options.sessionId,
      ...(options.boundary?.kind === "turn"
        ? { lastTurnId: options.boundary.turnId }
        : {}),
      cwd: options.cwd,
      ...this.buildThreadPermissionParams(policy),
      config: this.buildThreadConfigOverrides({}),
    };
    if (experimentalApiEnabled) {
      params.excludeTurns = true;
    }
    return params;
  }

  private async resolveCodexForkRollbackCount(
    appServer: CodexAppServerClient,
    sessionId: string,
    upToMessageId: string,
  ): Promise<number> {
    const response = await appServer.request<ThreadReadResponse>(
      "thread/read",
      {
        threadId: sessionId,
        includeTurns: true,
      } satisfies ThreadReadParams,
    );
    const turns = response.thread.turns ?? [];
    return this.computeCodexForkRollbackCount(turns, upToMessageId);
  }

  private computeCodexForkRollbackCount(
    turns: CodexThreadTurn[],
    upToMessageId: string,
  ): number {
    const anchor = this.findCodexForkAnchor(turns, upToMessageId);
    if (!anchor) {
      throw new Error(
        `Codex fork anchor ${upToMessageId} was not found in source thread`,
      );
    }

    if (anchor.itemIndex !== null) {
      const turn = turns[anchor.turnIndex];
      if (!turn) {
        throw new Error(
          `Codex fork anchor ${upToMessageId} resolved to a missing turn`,
        );
      }
      if (anchor.itemIndex < turn.items.length - 1) {
        throw new Error(
          `Codex fork anchor ${upToMessageId} is inside a turn; Codex can only fork at completed turn boundaries`,
        );
      }
    }

    return turns.length - anchor.turnIndex - 1;
  }

  private findCodexForkAnchor(
    turns: CodexThreadTurn[],
    upToMessageId: string,
  ): CodexForkAnchor | null {
    for (const [turnIndex, turn] of turns.entries()) {
      if (
        turn.id === upToMessageId ||
        `codex-turn-interrupted-${turn.id}` === upToMessageId
      ) {
        return { turnIndex, itemIndex: null };
      }

      for (const [itemIndex, item] of turn.items.entries()) {
        if (this.codexItemMatchesForkAnchor(item, turn.id, upToMessageId)) {
          return { turnIndex, itemIndex };
        }
      }

      if (`codex-compaction-${turn.id}` === upToMessageId) {
        return { turnIndex, itemIndex: turn.items.length - 1 };
      }
    }
    return null;
  }

  private codexItemMatchesForkAnchor(
    item: CodexThreadItem,
    turnId: string,
    upToMessageId: string,
  ): boolean {
    const candidates = new Set<string>();
    candidates.add(item.id);
    candidates.add(`${item.id}-${turnId}`);
    candidates.add(`${item.id}-result`);

    const itemRecord = item as Record<string, unknown>;
    const clientId = this.getOptionalString(itemRecord.clientId);
    if (clientId) {
      candidates.add(clientId);
      candidates.add(`${clientId}-${turnId}`);
    }

    return candidates.has(upToMessageId);
  }

  private buildThreadPermissionParams(
    policy: CodexThreadPolicy,
  ): Pick<ThreadStartParams, "approvalPolicy" | "sandbox"> {
    return {
      approvalPolicy: policy.approvalPolicy,
      sandbox: policy.sandbox,
    };
  }

  private buildThreadConfigOverrides(
    options: Pick<
      StartSessionOptions,
      "compactAtContextTokenLimit" | "effort" | "thinking" | "model"
    >,
  ): NonNullable<ThreadStartParams["config"]> {
    // The OpenAI browser plugin controls a desktop-owned browser backend that
    // YA's Codex app-server host does not provide. Suppress the unavailable
    // skill at thread scope so Codex follows YA's Playwright fallback instead
    // of advertising a browser that fails during backend discovery.
    const config: NonNullable<ThreadStartParams["config"]> = {
      model_reasoning_summary: this.getConfiguredReasoningSummary(),
      skills: {
        config: [
          {
            name: CODEX_DESKTOP_BROWSER_SKILL_NAME,
            enabled: false,
          },
        ],
      },
    };
    const planToolMode = this.getConfiguredPlanToolMode();
    if (planToolMode !== "provider-default") {
      config.tools = {
        update_plan: {
          enabled: planToolMode === "enabled",
        },
      };
    }
    const subagentMaxDepth = this.getConfiguredSubagentMaxDepth();
    if (subagentMaxDepth !== null) {
      config.agents = { max_depth: subagentMaxDepth };
    }
    const reasoningEffort = this.mapEffortToReasoningEffort(
      options.effort,
      options.thinking,
      options.model,
    );
    if (reasoningEffort) {
      config.model_reasoning_effort = reasoningEffort;
    }
    if (
      options.compactAtContextTokenLimit !== undefined &&
      Number.isFinite(options.compactAtContextTokenLimit) &&
      options.compactAtContextTokenLimit > 0
    ) {
      config.model_auto_compact_token_limit = Math.round(
        options.compactAtContextTokenLimit,
      );
      // The YA setting is explicitly a percentage of the full active context.
      // Pin the scope so a user's Codex config cannot reinterpret it as growth
      // after the carried compaction prefix.
      config.model_auto_compact_token_limit_scope = "total";
    }
    return config;
  }

  private createCodexSlashCommands(
    skills: readonly SkillMetadata[],
    inventoryState: "current" | "stale" = "current",
    goalObjective?: string | null,
    goalStatus?: ThreadGoalSetResponse["goal"]["status"] | null,
  ): SlashCommand[] {
    const commands: SlashCommand[] = CODEX_BUILTIN_COMMANDS.map((command) =>
      command.name === "goal" && goalObjective !== undefined
        ? {
            ...command,
            providerDetails: { codex: { goalObjective, goalStatus } },
            argumentCompletions: [
              ...(goalObjective
                ? [{ value: goalObjective, description: "Current goal" }]
                : []),
              ...(command.argumentCompletions ?? []),
            ],
          }
        : command,
    );
    // Dedup on the exact spelling: Codex recognizes case-distinct skill names
    // as distinct, so `Foo` and `foo` must both surface rather than collapse.
    const seenSkills = new Set<string>();
    for (const skill of skills) {
      const name = skill.name.trim();
      if (
        !skill.enabled ||
        name === CODEX_DESKTOP_BROWSER_SKILL_NAME ||
        !name ||
        seenSkills.has(name)
      ) {
        continue;
      }
      seenSkills.add(name);
      commands.push({
        name,
        description:
          skill.interface?.shortDescription ??
          skill.shortDescription ??
          skill.description,
        invocation: { kind: "skill", prefix: "$", inventoryState },
      });
    }
    return commands;
  }

  private async refreshCodexSkills(
    appServer: CodexAppServerClient,
    cwd: string,
    inventory: CodexSessionSkillInventory,
    forceReload: boolean,
  ): Promise<void> {
    try {
      const result = await appServer.request<SkillsListResponse>(
        "skills/list",
        {
          cwds: [cwd],
          forceReload,
        } satisfies SkillsListParams,
      );
      inventory.skills = result.data.flatMap((entry) => entry.skills);
      inventory.stale = false;
    } catch (error) {
      inventory.stale = true;
      log.debug(
        {
          error: error instanceof Error ? error.message : String(error),
          cwd,
        },
        "Codex skill inventory is unavailable",
      );
    }
  }

  private createCodexUserInputs(
    text: string,
    skills: readonly SkillMetadata[],
    inventoryState: "current" | "stale",
  ): { text: string; input: UserInput[] } {
    const canonical = canonicalizeSkillInvocations(
      text,
      this.createCodexSlashCommands(skills, inventoryState),
    );
    // Keyed by `canonicalInvocationName`, which preserves case unlike its
    // `normalize` sibling, so case-distinct skills keep their own paths.
    const skillByName = new Map<string, SkillMetadata>();
    for (const skill of skills) {
      if (!skill.enabled || skill.name === CODEX_DESKTOP_BROWSER_SKILL_NAME) {
        continue;
      }
      const name = canonicalInvocationName(skill.name);
      if (name && !skillByName.has(name)) {
        skillByName.set(name, skill);
      }
    }
    const structuredSkills: UserInput[] = [];
    const seenPaths = new Set<string>();
    for (const match of canonical.matches) {
      const skill = skillByName.get(
        canonicalInvocationName(match.command.name),
      );
      if (!skill || seenPaths.has(skill.path)) continue;
      seenPaths.add(skill.path);
      structuredSkills.push({
        type: "skill",
        name: skill.name,
        path: skill.path,
      });
    }
    return {
      text: canonical.text,
      input: [
        { type: "text", text: canonical.text, text_elements: [] },
        ...structuredSkills,
      ],
    };
  }

  private createTurnStartParams(
    threadId: string,
    input: UserInput[],
    options: StartSessionOptions,
    turnPolicy: CodexThreadPolicy | null = null,
    workspaceWriteSandboxPolicy: CodexSandboxPolicy | null = null,
    modelOverride: string | null = options.model ?? null,
    effortOverride: EffortLevel | null | undefined = options.effort,
    clientUserMessageId?: string,
  ): TurnStartParams {
    return {
      threadId,
      ...(clientUserMessageId ? { clientUserMessageId } : {}),
      model: modelOverride,
      ...(options.serviceTier ? { serviceTier: options.serviceTier } : {}),
      input,
      effort:
        effortOverride === null
          ? null
          : this.mapEffortToReasoningEffort(
              effortOverride,
              options.thinking,
              modelOverride ?? undefined,
            ),
      ...this.buildTurnPermissionParams(
        turnPolicy,
        workspaceWriteSandboxPolicy,
      ),
    };
  }

  private buildTurnPermissionParams(
    policy: CodexThreadPolicy | null,
    workspaceWriteSandboxPolicy: CodexSandboxPolicy | null = null,
  ): Partial<Pick<TurnStartParams, "approvalPolicy" | "sandboxPolicy">> {
    if (!policy) return {};
    return {
      approvalPolicy: policy.approvalPolicy,
      sandboxPolicy: this.mapThreadSandboxToTurnSandbox(
        policy.sandbox,
        workspaceWriteSandboxPolicy,
      ),
    };
  }

  /**
   * Synthesize a short on-return recap through a separate ephemeral Codex
   * thread. This is intentionally separate from prompt suggestions: Codex does
   * not natively emit prompt_suggestion messages, but it can still run the YA
   * simulated recap helper without mutating the parent session transcript.
   */
  async generateSummary(
    request: SummaryGenerationRequest,
  ): Promise<SummaryGenerationResult> {
    return this.installationCoordinator.withReadLease(
      CODEX_INSTALLATION_FAMILY,
      async () => {
        switch (request.strategy) {
          case "side-session": {
            const text = await this.generateSideSessionRecap(
              request.recentAssistantText,
              request.model,
            );
            return { text };
          }
          case "fork":
            return await this.generateForkBackedSummary(request);
        }
      },
    );
  }

  private async generateSideSessionRecap(
    recentAssistantText: string[],
    requestedModel?: string,
  ): Promise<string> {
    const userPrompt = createCodexRecapPrompt(recentAssistantText);
    const model = await resolveCodexRecapHelperModel(requestedModel, () =>
      this.getAvailableModels(),
    );
    const codexCommand = await this.resolveCodexCommand();
    const abortController = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      abortController.abort();
    }, CODEX_RECAP_TIMEOUT_MS);
    timeout.unref?.();

    const appServer = new CodexAppServerClient(
      codexCommand,
      homedir(),
      this.getCodexEnv(),
    );
    appServer.setServerRequestHandler(async (request) =>
      this.handleRecapServerRequest(request),
    );

    try {
      await appServer.connect();
      await this.initializeAppServer(appServer);
      appServer.notify("initialized");

      const threadResult = await appServer.request<ThreadStartResponse>(
        "thread/start",
        {
          model,
          cwd: homedir(),
          approvalPolicy: "untrusted",
          sandbox: "read-only",
          ephemeral: true,
          experimentalRawEvents: false,
          developerInstructions:
            "You are a recap helper. Reply with the recap text only, no preamble. Do not call tools.",
        } satisfies ThreadStartParams,
      );

      const turnResult = await appServer.request<TurnStartResponse>(
        "turn/start",
        {
          threadId: threadResult.thread.id,
          model,
          input: [{ type: "text", text: userPrompt, text_elements: [] }],
          effort: "low",
          summary: "auto",
        } satisfies TurnStartParams,
      );

      const textByItemId = new Map<string, string>();
      const normalizeThreadItem = this.normalizeThreadItem.bind(this);
      captureCodexSummaryTextFromTurnItems(
        turnResult.turn.items,
        textByItemId,
        normalizeThreadItem,
      );

      if (turnResult.turn.status === "failed") {
        throw new Error(
          turnResult.turn.error?.message ?? "Codex recap generation failed",
        );
      }

      let turnComplete = turnResult.turn.status !== "inProgress";
      while (!turnComplete && !abortController.signal.aborted) {
        const notification = await appServer.nextNotification(
          abortController.signal,
        );
        captureCodexSummaryTextFromNotification(
          notification,
          textByItemId,
          normalizeThreadItem,
        );

        if (notification.method !== "turn/completed") {
          continue;
        }
        const completed = asCodexTurnCompletedNotification(notification.params);
        if (completed?.turn.status === "failed") {
          throw new Error(
            completed.turn.error?.message ?? "Codex recap generation failed",
          );
        }
        turnComplete = true;
      }
      if (abortController.signal.aborted) {
        throw new Error("Timed out generating Codex recap");
      }

      const cleaned = cleanCodexRecapText(joinCodexSummaryText(textByItemId));
      if (!cleaned) {
        throw new Error("Recap generation returned empty text");
      }
      return cleaned;
    } catch (error) {
      if (timedOut) {
        throw new Error("Timed out generating Codex recap");
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      abortController.abort();
      await appServer.close();
    }
  }

  private async generateForkBackedSummary(
    request: Extract<SummaryGenerationRequest, { strategy: "fork" }>,
  ): Promise<SummaryGenerationResult> {
    const userPrompt = createCodexForkSummaryPrompt(request);
    const codexCommand = await this.resolveCodexCommand();
    const appServer = new CodexAppServerClient(
      codexCommand,
      request.cwd,
      this.getCodexEnv(),
      undefined,
      request.sessionSandbox,
    );
    const abortController = new AbortController();
    let timedOut = false;
    const abortFromRequest = () => {
      abortController.abort();
      void appServer.close();
    };
    if (request.signal?.aborted) {
      abortController.abort();
    } else {
      request.signal?.addEventListener("abort", abortFromRequest, {
        once: true,
      });
    }
    const timeout = setTimeout(() => {
      timedOut = true;
      abortController.abort();
      void appServer.close();
    }, CODEX_SUMMARY_TIMEOUT_MS);
    timeout.unref?.();

    appServer.setServerRequestHandler((serverRequest) =>
      this.handleNonTurnServerRequest(serverRequest, "summary helper"),
    );

    try {
      if (abortController.signal.aborted) {
        throw new DOMException("Summary generation cancelled", "AbortError");
      }
      await appServer.connect();
      const experimentalApiEnabled = await this.initializeAppServer(appServer);
      appServer.notify("initialized");

      const threadResult = await appServer.request<ThreadResumeResponse>(
        "thread/resume",
        createCodexForkSummaryThreadResumeParams(
          request,
          experimentalApiEnabled,
        ),
      );
      const threadId = threadResult.thread.id || request.generatorSessionId;
      const turnResult = await appServer.request<TurnStartResponse>(
        "turn/start",
        {
          threadId,
          input: [{ type: "text", text: userPrompt, text_elements: [] }],
          effort: "low",
          summary: "auto",
          approvalPolicy: "untrusted",
        } satisfies TurnStartParams,
      );

      const textByItemId = new Map<string, string>();
      const normalizeThreadItem = this.normalizeThreadItem.bind(this);
      captureCodexSummaryTextFromTurnItems(
        turnResult.turn.items,
        textByItemId,
        normalizeThreadItem,
      );

      if (turnResult.turn.status === "failed") {
        throw new Error(
          turnResult.turn.error?.message ?? "Codex summary generation failed",
        );
      }

      const turnId = turnResult.turn.id;
      let turnComplete = turnResult.turn.status !== "inProgress";
      while (!turnComplete && !abortController.signal.aborted) {
        const notification = await appServer.nextNotification(
          abortController.signal,
        );
        captureCodexSummaryTextFromNotification(
          notification,
          textByItemId,
          normalizeThreadItem,
        );

        if (notification.method === "turn/completed") {
          const completed = asCodexTurnCompletedNotification(
            notification.params,
          );
          if (completed?.turn.id !== turnId) {
            continue;
          }
          captureCodexSummaryTextFromTurnItems(
            completed.turn.items,
            textByItemId,
            normalizeThreadItem,
          );
          if (completed.turn.status === "failed") {
            throw new Error(
              completed.turn.error?.message ??
                "Codex summary generation failed",
            );
          }
          turnComplete = true;
          continue;
        }

        if (notification.method === "error") {
          const error = asCodexErrorNotification(notification.params);
          if (error?.turnId === turnId && !error.willRetry) {
            throw new Error(
              error.error.message ?? "Codex summary generation failed",
            );
          }
        }
      }
      if (abortController.signal.aborted) {
        if (request.signal?.aborted) {
          throw new DOMException("Summary generation cancelled", "AbortError");
        }
        throw new Error("Timed out generating Codex summary");
      }

      const cleaned = cleanCodexSummaryText(joinCodexSummaryText(textByItemId));
      if (!cleaned) {
        throw new Error("Summary generation returned empty text");
      }
      return { text: cleaned };
    } catch (error) {
      if (request.signal?.aborted) {
        throw new DOMException("Summary generation cancelled", "AbortError");
      }
      if (timedOut) {
        throw new Error("Timed out generating Codex summary");
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      request.signal?.removeEventListener("abort", abortFromRequest);
      abortController.abort();
      await appServer.close();
    }
  }

  private handleRecapServerRequest(
    request: JsonRpcServerRequest,
  ): Promise<unknown> {
    return this.handleNonTurnServerRequest(request, "recap helper");
  }

  private handleForkServerRequest(
    request: JsonRpcServerRequest,
  ): Promise<unknown> {
    return this.handleNonTurnServerRequest(request, "fork");
  }

  private handleNonTurnServerRequest(
    request: JsonRpcServerRequest,
    purpose: string,
  ): Promise<unknown> {
    log.warn(
      { method: request.method, requestId: request.id, purpose },
      "Declining Codex non-turn server request",
    );

    switch (request.method) {
      case "item/commandExecution/requestApproval":
      case "item/fileChange/requestApproval":
        return Promise.resolve({ decision: "decline" });
      case "item/permissions/requestApproval":
        return Promise.resolve(this.createDeclinedPermissionResponse());
      case "item/tool/requestUserInput": {
        const requestInput = this.asToolRequestUserInputParams(request.params);
        const answers: ToolRequestUserInputResponse["answers"] = {};
        for (const question of requestInput?.questions ?? []) {
          answers[question.id] = { answers: [] };
        }
        return Promise.resolve({
          answers,
        } satisfies ToolRequestUserInputResponse);
      }
      default:
        return Promise.resolve({});
    }
  }

  private createSessionConfigAckMessage(
    sessionId: string,
    model?: string | null,
    requestedModel?: string | null,
    reasoningEffort?: string | null,
    requestedReasoningEffort?:
      | "none"
      | "minimal"
      | "low"
      | "medium"
      | "high"
      | "xhigh"
      | undefined,
  ): SDKMessage | null {
    const parts: string[] = [];
    const normalizedModel = typeof model === "string" ? model.trim() : "";
    const normalizedRequestedModel =
      typeof requestedModel === "string" ? requestedModel.trim() : "";
    if (normalizedModel) {
      parts.push(normalizedModel);
    }
    const effortLabel =
      this.describeAcknowledgedSessionReasoningEffort(reasoningEffort);
    const configMismatch =
      (normalizedRequestedModel.length > 0 &&
        normalizedRequestedModel !== normalizedModel) ||
      (requestedReasoningEffort !== undefined &&
        requestedReasoningEffort !== reasoningEffort);
    if (effortLabel) {
      parts.push(effortLabel);
    }
    if (parts.length === 0) {
      return null;
    }
    return {
      type: "system",
      subtype: "config_ack",
      session_id: sessionId,
      content: `Codex acknowledged config: ${parts.join(" · ")}`,
      isSynthetic: true,
      configScope: "session",
      configMismatch,
      ...(normalizedModel ? { configModel: normalizedModel } : {}),
      ...(effortLabel ? { configThinking: effortLabel } : {}),
    } as SDKMessage;
  }

  private describeAcknowledgedSessionReasoningEffort(
    effort: string | null | undefined,
  ): string | null {
    return effort ? `effort ${effort}` : null;
  }

  private createLiveEventState(): CodexLiveEventState {
    return {
      streamingTextByItemKey: new Map(),
      streamingReasoningSummaryByItemKey: new Map(),
      streamingToolOutputByItemKey: new Map(),
      toolCallContexts: new Map(),
      resultBackedToolItemsByTurnId: new Map(),
      planUpdateCountByTurnId: new Map(),
    };
  }

  private recordCodexFailureTraceEvent(
    trace: CodexFailureTrace,
    event: CodexFailureTraceEvent,
  ): void {
    trace.lastNotification = event;
    trace.recentNotifications.push(event);
    if (trace.recentNotifications.length > CODEX_FAILURE_TRACE_LIMIT) {
      trace.recentNotifications.splice(
        0,
        trace.recentNotifications.length - CODEX_FAILURE_TRACE_LIMIT,
      );
    }
  }

  private snapshotCodexFailureTrace(
    trace: CodexFailureTrace,
  ): CodexFailureTrace {
    return {
      sessionId: trace.sessionId,
      activeTurnId: trace.activeTurnId,
      lastUserMessage: trace.lastUserMessage
        ? { ...trace.lastUserMessage }
        : undefined,
      lastNotification: trace.lastNotification
        ? { ...trace.lastNotification }
        : undefined,
      lastEmittedMessage: trace.lastEmittedMessage
        ? { ...trace.lastEmittedMessage }
        : undefined,
      recentNotifications: trace.recentNotifications.map((event) => ({
        ...event,
      })),
    };
  }

  private formatCodexFailureTrace(trace: CodexFailureTrace): string {
    const lastNotification = trace.lastNotification
      ? this.formatCodexTraceEvent(trace.lastNotification)
      : "none";
    const lastEmitted = trace.lastEmittedMessage
      ? this.formatCodexTraceEvent(trace.lastEmittedMessage)
      : "none";
    return `last notification: ${lastNotification}; last emitted SDK message: ${lastEmitted}`;
  }

  private formatCodexTraceEvent(event: CodexFailureTraceEvent): string {
    const details = [
      event.sourceEvent,
      event.itemType,
      event.toolName,
      event.status,
      event.phase,
      event.command ? `command=${event.command}` : undefined,
      event.errorMessage ? `error=${event.errorMessage}` : undefined,
      event.openaiRequestId ? `requestId=${event.openaiRequestId}` : undefined,
    ].filter(Boolean);
    return details.join(" ");
  }

  private describeNotificationForFailureTrace(
    notification: JsonRpcNotification,
  ): CodexFailureTraceEvent {
    const base = (event: Omit<CodexFailureTraceEvent, "at">) => ({
      at: new Date().toISOString(),
      ...event,
    });

    switch (notification.method) {
      case "item/started":
      case "item/completed": {
        const params =
          notification.method === "item/started"
            ? asCodexItemStartedNotification(notification.params)
            : asCodexItemCompletedNotification(notification.params);
        const item =
          params?.item && typeof params.item === "object"
            ? (params.item as Record<string, unknown>)
            : null;
        return base({
          sourceEvent: notification.method,
          turnId: params?.turnId,
          itemId:
            this.getOptionalString(item?.id) ??
            this.getOptionalString((item as { call_id?: unknown })?.call_id) ??
            undefined,
          itemType: this.normalizeCodexItemType(
            this.getOptionalString(item?.type),
          ),
          status: this.normalizeStatus(item?.status),
          phase:
            notification.method === "item/completed" ? "completed" : "started",
          toolName: this.getTraceToolName(item) ?? undefined,
          command: this.previewTraceString(
            this.getOptionalString(item?.command) ??
              this.getOptionalString(item?.aggregated_output) ??
              this.getOptionalString(item?.aggregatedOutput),
          ),
        });
      }

      case "item/agentMessage/delta":
      case "item/plan/delta":
      case "item/reasoning/summaryTextDelta":
      case "item/commandExecution/outputDelta":
      case "item/fileChange/outputDelta": {
        const params =
          notification.params && typeof notification.params === "object"
            ? (notification.params as Record<string, unknown>)
            : null;
        const delta = this.getOptionalString(params?.delta);
        return base({
          sourceEvent: notification.method,
          turnId: this.getOptionalString(params?.turnId) ?? undefined,
          itemId: this.getOptionalString(params?.itemId) ?? undefined,
          itemType: this.inferTraceItemTypeFromDeltaEvent(notification.method),
          phase: "delta",
          deltaChars: delta?.length,
          outputChars: delta?.length,
        });
      }

      case "rawResponseItem/completed": {
        const params = asCodexRawResponseItemCompletedNotification(
          notification.params,
        );
        const item =
          params?.item && typeof params.item === "object"
            ? (params.item as Record<string, unknown>)
            : null;
        return base({
          sourceEvent: notification.method,
          turnId: params?.turnId,
          itemId:
            this.getOptionalString(item?.id) ??
            this.getOptionalString(item?.call_id) ??
            undefined,
          itemType: this.normalizeCodexItemType(
            this.getOptionalString(item?.type),
          ),
          phase: "completed",
          toolName: this.getTraceToolName(item) ?? undefined,
        });
      }

      case "thread/tokenUsage/updated": {
        const params =
          notification.params && typeof notification.params === "object"
            ? (notification.params as Record<string, unknown>)
            : null;
        return base({
          sourceEvent: notification.method,
          turnId: this.getOptionalString(params?.turnId) ?? undefined,
          phase: "usage",
        });
      }

      case "turn/completed": {
        const params = asCodexTurnCompletedNotification(notification.params);
        return base({
          sourceEvent: notification.method,
          turnId: params?.turn.id,
          status: params?.turn.status,
          phase: "completed",
          errorMessage: params?.turn.error?.message,
          codexErrorInfo: params?.turn.error?.codexErrorInfo ?? undefined,
          additionalDetails:
            readCodexTurnErrorDetail(params?.turn.error) ?? undefined,
          openaiRequestId: this.extractOpenAIRequestId(
            params?.turn.error,
            params?.turn.error?.additionalDetails,
            params?.turn.error?.message,
          ),
        });
      }

      case "error": {
        const params = asCodexErrorNotification(notification.params);
        const fallbackError = this.extractErrorRecord(notification.params);
        const rawParams =
          notification.params && typeof notification.params === "object"
            ? (notification.params as Record<string, unknown>)
            : null;
        const willRetry =
          params?.willRetry ??
          (typeof rawParams?.willRetry === "boolean"
            ? rawParams.willRetry
            : false);
        const errorMessage =
          params?.error.message ??
          this.getOptionalString(fallbackError?.message) ??
          "Codex turn failed";
        return base({
          sourceEvent: notification.method,
          turnId: params?.turnId,
          phase: willRetry ? "retrying" : "terminal",
          errorMessage,
          codexErrorInfo:
            params?.error.codexErrorInfo ??
            fallbackError?.codexErrorInfo ??
            undefined,
          additionalDetails:
            readCodexTurnErrorDetail(params?.error) ??
            this.getOptionalString(fallbackError?.additionalDetails) ??
            undefined,
          openaiRequestId: this.extractOpenAIRequestId(
            notification.params,
            fallbackError,
            errorMessage,
          ),
        });
      }

      default:
        return base({ sourceEvent: notification.method });
    }
  }

  private describeSDKMessageForFailureTrace(
    message: SDKMessage,
  ): CodexFailureTraceEvent {
    const event: CodexFailureTraceEvent = {
      at: new Date().toISOString(),
      sourceEvent: `sdk:${message.type}`,
      phase: typeof message.subtype === "string" ? message.subtype : undefined,
    };

    if (message.error !== undefined) {
      event.errorMessage = this.previewTraceString(
        typeof message.error === "string"
          ? message.error
          : stringifyTraceValue(message.error),
      );
      event.openaiRequestId = this.extractOpenAIRequestId(message.error);
    }

    const content = message.message?.content;
    if (typeof content === "string") {
      event.outputChars = content.length;
      return event;
    }
    if (!Array.isArray(content)) {
      return event;
    }

    const interestingBlock = content.find(
      (block) =>
        block.type === "tool_use" ||
        block.type === "tool_result" ||
        block.type === "thinking",
    );
    if (!interestingBlock) {
      return event;
    }

    event.itemType = interestingBlock.type;
    if (interestingBlock.type === "tool_use") {
      event.itemId = interestingBlock.id;
      event.toolName = interestingBlock.name;
      event.command = this.previewTraceString(
        this.getTraceCommandFromInput(interestingBlock.input),
      );
    } else if (interestingBlock.type === "tool_result") {
      event.itemId = interestingBlock.tool_use_id;
      event.outputChars = interestingBlock.content?.length;
    } else if (interestingBlock.type === "thinking") {
      event.outputChars = interestingBlock.thinking?.length;
    }

    return event;
  }

  private inferTraceItemTypeFromDeltaEvent(method: string): string | undefined {
    if (method.includes("commandExecution")) return "command_execution";
    if (method.includes("fileChange")) return "file_change";
    if (method.includes("reasoning")) return "reasoning";
    if (method.includes("plan")) return "plan";
    if (method.includes("agentMessage")) return "agent_message";
    return undefined;
  }

  private normalizeCodexItemType(type: string | null): string | undefined {
    return type?.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`);
  }

  private getTraceToolName(
    item: Record<string, unknown> | null,
  ): string | null {
    if (!item) return null;
    const type = this.normalizeCodexItemType(this.getOptionalString(item.type));
    if (type === "command_execution") return "Bash";
    if (type === "file_change") return "Edit";
    if (type === "web_search") return "WebSearch";
    if (type === "mcp_tool_call") {
      const server = this.getOptionalString(item.server);
      const tool = this.getOptionalString(item.tool);
      return server && tool ? `${server}:${tool}` : (tool ?? null);
    }
    if (type === "dynamic_tool_call") {
      const namespace = this.getOptionalString(item.namespace);
      const tool = this.getOptionalString(item.tool);
      return namespace && tool ? `${namespace}:${tool}` : (tool ?? null);
    }
    return this.getOptionalString(item.name);
  }

  private getTraceCommandFromInput(input: unknown): string | null {
    if (!input || typeof input !== "object") return null;
    const record = input as Record<string, unknown>;
    return (
      this.getOptionalString(record.command) ??
      this.getOptionalString(record.cmd) ??
      null
    );
  }

  private extractErrorRecord(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== "object") return null;
    const record = value as Record<string, unknown>;
    if (record.error && typeof record.error === "object") {
      return record.error as Record<string, unknown>;
    }
    return record;
  }

  private extractOpenAIRequestId(...values: unknown[]): string | undefined {
    for (const value of values) {
      const direct = this.findRequestIdInValue(value, 0);
      if (direct) return direct;
      const text =
        typeof value === "string" ? value : stringifyTraceValue(value);
      const match =
        /request\s*id[:\s]+([0-9a-f]{8}-[0-9a-f-]{20,})/i.exec(text) ??
        /request[_-]?id["'\s:=]+([0-9a-f]{8}-[0-9a-f-]{20,})/i.exec(text);
      if (match?.[1]) {
        return match[1];
      }
    }
    return undefined;
  }

  private findRequestIdInValue(value: unknown, depth: number): string | null {
    if (!value || typeof value !== "object" || depth > 3) return null;
    const record = value as Record<string, unknown>;
    for (const [key, entry] of Object.entries(record)) {
      if (
        /^(request[_-]?id|x-request-id)$/i.test(key) &&
        typeof entry === "string" &&
        entry.trim()
      ) {
        return entry.trim();
      }
      const nested = this.findRequestIdInValue(entry, depth + 1);
      if (nested) return nested;
    }
    return null;
  }

  private previewTraceString(
    value: string | null | undefined,
  ): string | undefined {
    if (!value) return undefined;
    const trimmed = value.replace(/\s+/g, " ").trim();
    if (trimmed.length <= CODEX_FAILURE_PREVIEW_CHARS) {
      return trimmed;
    }
    return `${trimmed.slice(0, CODEX_FAILURE_PREVIEW_CHARS)}...`;
  }

  private extractTurnUsage(params: unknown): {
    turnId: string;
    snapshot: TokenUsageSnapshot;
    total: TokenUsageSnapshot;
  } | null {
    const notification = asCodexThreadTokenUsageUpdatedNotification(params);
    if (!notification) return null;

    return {
      turnId: notification.turnId,
      snapshot: {
        totalTokens: notification.tokenUsage.last.totalTokens,
        inputTokens: notification.tokenUsage.last.inputTokens,
        outputTokens: notification.tokenUsage.last.outputTokens,
        cachedInputTokens: notification.tokenUsage.last.cachedInputTokens,
        contextWindow:
          typeof notification.tokenUsage.modelContextWindow === "number"
            ? notification.tokenUsage.modelContextWindow
            : undefined,
      },
      total: {
        totalTokens: notification.tokenUsage.total.totalTokens,
        inputTokens: notification.tokenUsage.total.inputTokens,
        outputTokens: notification.tokenUsage.total.outputTokens,
        cachedInputTokens: notification.tokenUsage.total.cachedInputTokens,
        contextWindow:
          typeof notification.tokenUsage.modelContextWindow === "number"
            ? notification.tokenUsage.modelContextWindow
            : undefined,
      },
    };
  }

  private async handleServerRequestApproval(
    request: JsonRpcServerRequest,
    options: StartSessionOptions,
    signal: AbortSignal,
    permissionMode = this.normalizePermissionMode(options.permissionMode),
  ): Promise<unknown> {
    log.info(
      {
        method: request.method,
        requestId: request.id,
        permissionMode,
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
            permissionMode,
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
            permissionMode,
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
          permissionMode,
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
          permissionMode,
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

      case "item/permissions/requestApproval": {
        const permissionParams = this.asPermissionsRequestApprovalParams(
          request.params,
        );
        if (!permissionParams) {
          log.warn(
            {
              method: request.method,
              requestId: request.id,
            },
            "Codex permission approval params invalid; declining",
          );
          return this.createDeclinedPermissionResponse();
        }

        return await this.resolvePermissionRequestApproval(
          options,
          permissionParams,
          signal,
          permissionMode,
        );
      }

      case "item/tool/requestUserInput": {
        const requestInput = this.asToolRequestUserInputParams(request.params);
        if (!requestInput) {
          log.warn(
            {
              method: request.method,
              requestId: request.id,
            },
            "Codex tool user-input params invalid; returning no answers",
          );
          return { answers: {} } satisfies ToolRequestUserInputResponse;
        }

        const toolInput = {
          questions: requestInput.questions.map((question) => ({
            id: question.id,
            header: question.header,
            question: question.question,
            options: question.options ?? [],
            multiSelect: false,
            isOther: question.isOther,
            isSecret: question.isSecret,
          })),
          isBlocking: requestInput.isBlocking,
          autoResolutionMs: requestInput.autoResolutionMs,
          threadId: requestInput.threadId,
          turnId: requestInput.turnId,
          itemId: requestInput.itemId,
        };
        const result = await this.resolveToolApprovalResult(
          options,
          "AskUserQuestion",
          toolInput,
          signal,
          permissionMode,
        );
        const updatedInput =
          result.behavior === "allow" &&
          result.updatedInput &&
          typeof result.updatedInput === "object"
            ? (result.updatedInput as {
                answers?: Record<string, string | string[]>;
              })
            : null;
        const submittedAnswers = updatedInput?.answers ?? {};
        const answers: ToolRequestUserInputResponse["answers"] = {};
        for (const question of requestInput.questions) {
          const submitted =
            submittedAnswers[question.id] ??
            submittedAnswers[question.question];
          answers[question.id] = {
            answers: Array.isArray(submitted)
              ? submitted.filter(
                  (answer): answer is string => typeof answer === "string",
                )
              : typeof submitted === "string"
                ? [submitted]
                : [],
          };
        }
        log.info(
          {
            method: request.method,
            requestId: request.id,
            questionCount: requestInput.questions.length,
            threadId: requestInput.threadId,
            turnId: requestInput.turnId,
            itemId: requestInput.itemId,
            behavior: result.behavior,
          },
          "Resolved Codex tool user-input request",
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
    permissionMode: PermissionMode,
  ): Promise<TDecision> {
    const result = await this.resolveToolApprovalResult(
      options,
      toolName,
      toolInput,
      signal,
      permissionMode,
    );
    return result.behavior === "allow" ? allowDecision : denyDecision;
  }

  private async resolveToolApprovalResult(
    options: StartSessionOptions,
    toolName: string,
    toolInput: unknown,
    signal: AbortSignal,
    permissionMode: PermissionMode,
  ): Promise<ToolApprovalResult> {
    if (!options.onToolApproval) {
      log.warn(
        { toolName },
        "No onToolApproval handler available; denying Codex approval request",
      );
      return { behavior: "deny" };
    }

    let result: ToolApprovalResult;
    try {
      result = await options.onToolApproval(toolName, toolInput, {
        signal,
        permissionMode,
      });
    } catch (error) {
      log.warn(
        { toolName, error },
        "onToolApproval threw; denying Codex approval request",
      );
      return { behavior: "deny" };
    }

    log.info(
      { toolName, behavior: result.behavior },
      "Resolved tool approval callback result",
    );

    return result;
  }

  private async resolvePermissionRequestApproval(
    options: StartSessionOptions,
    params: PermissionsRequestApprovalParams,
    signal: AbortSignal,
    permissionMode: PermissionMode,
  ): Promise<PermissionsRequestApprovalResponse> {
    if (permissionMode === "bypassPermissions") {
      return this.createGrantedPermissionResponse(params, "turn");
    }

    const toolInput = {
      cwd: params.cwd,
      reason: params.reason,
      permissions: params.permissions,
      threadId: params.threadId,
      turnId: params.turnId,
      itemId: params.itemId,
    };
    const decision = await this.resolveApprovalDecision(
      options,
      "Permissions",
      toolInput,
      signal,
      "accept",
      "decline",
      permissionMode,
    );
    return decision === "accept"
      ? this.createGrantedPermissionResponse(params, "turn")
      : this.createDeclinedPermissionResponse();
  }

  private createGrantedPermissionResponse(
    params: PermissionsRequestApprovalParams,
    scope: PermissionsRequestApprovalResponse["scope"],
  ): PermissionsRequestApprovalResponse {
    const permissions: PermissionsRequestApprovalResponse["permissions"] = {};
    if (params.permissions.network) {
      permissions.network = params.permissions.network;
    }
    if (params.permissions.fileSystem) {
      permissions.fileSystem = params.permissions.fileSystem;
    }
    return { permissions, scope };
  }

  private createDeclinedPermissionResponse(): PermissionsRequestApprovalResponse {
    return { permissions: {}, scope: "turn" };
  }

  private convertNotificationToSDKMessages(
    notification: JsonRpcNotification,
    sessionId: string,
    usageByTurnId: Map<string, TokenUsageSnapshot>,
    liveEventState: CodexLiveEventState,
  ): SDKMessage[] {
    switch (notification.method) {
      case "thread/tokenUsage/updated": {
        const usage = this.extractTurnUsage(notification.params);
        if (!usage) {
          return [];
        }

        const message = withCodexTimestamp({
          type: "system",
          subtype: "token_usage",
          session_id: sessionId,
          turnId: usage.turnId,
          isSynthetic: true,
          usage: {
            input_tokens: usage.snapshot.inputTokens,
            output_tokens: usage.snapshot.outputTokens,
            cached_input_tokens: usage.snapshot.cachedInputTokens,
          },
          ...(usage.snapshot.contextWindow && usage.snapshot.contextWindow > 0
            ? { model_context_window: usage.snapshot.contextWindow }
            : {}),
        } as SDKMessage);
        logSdkCorrelationDebug(sessionId, message, {
          eventKind: "token_usage",
          turnId: usage.turnId,
          phase: "usage_updated",
          sourceEvent: notification.method,
        });
        return [message];
      }

      case "turn/plan/updated": {
        const params = asCodexTurnPlanUpdatedNotification(notification.params);
        if (!params) return [];

        const sequence =
          (liveEventState.planUpdateCountByTurnId.get(params.turnId) ?? 0) + 1;
        liveEventState.planUpdateCountByTurnId.set(params.turnId, sequence);
        const callId = `codex-plan-${params.turnId}-${sequence}`;
        const observedAt = new Date().toISOString();
        const input = {
          ...(params.explanation ? { explanation: params.explanation } : {}),
          plan: params.plan.map(({ status, step }) => ({
            step,
            status: status === "inProgress" ? "in_progress" : status,
          })),
        };
        const toolUse = withCodexTimestamp(
          {
            type: "assistant",
            session_id: sessionId,
            uuid: this.buildItemToolUuid(callId),
            [CODEX_TOOL_CORRELATION_FIELD]: createCodexToolCorrelation(
              "plan_update",
              params.turnId,
              callId,
              observedAt,
            ),
            message: {
              role: "assistant",
              content: [
                {
                  type: "tool_use",
                  id: callId,
                  name: "UpdatePlan",
                  input,
                },
              ],
            },
          } as SDKMessage,
          observedAt,
        );
        const toolResult = withCodexTimestamp(
          {
            type: "user",
            session_id: sessionId,
            uuid: this.buildItemResultUuid(callId),
            [CODEX_TOOL_CORRELATION_FIELD]: createCodexToolCorrelation(
              "plan_update",
              params.turnId,
              callId,
              observedAt,
            ),
            message: {
              role: "user",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: callId,
                  content: "Plan updated",
                },
              ],
            },
            toolUseResult: { message: "Plan updated" },
          } as SDKMessage,
          observedAt,
        );
        logSdkCorrelationDebug(sessionId, toolUse, {
          eventKind: "plan_update",
          turnId: params.turnId,
          itemId: callId,
          callId,
          phase: "completed",
          sourceEvent: notification.method,
        });
        logSdkCorrelationDebug(sessionId, toolResult, {
          eventKind: "tool_result",
          turnId: params.turnId,
          itemId: callId,
          callId,
          phase: "completed",
          sourceEvent: notification.method,
        });
        return [toolUse, toolResult];
      }

      case "turn/completed": {
        const params = asCodexTurnCompletedNotification(notification.params);
        const turnId = params?.turn.id ?? null;
        const turnStatus = params?.turn.status;
        const usage = turnId ? usageByTurnId.get(turnId) : undefined;
        const usagePayload = usage
          ? {
              input_tokens: usage.inputTokens,
              output_tokens: usage.outputTokens,
              cached_input_tokens: usage.cachedInputTokens,
            }
          : undefined;
        const messages: SDKMessage[] = [];
        if (turnId) {
          liveEventState.planUpdateCountByTurnId.delete(turnId);
        }
        const orphanedToolUseIds = turnId
          ? this.consumeLiveResultBackedToolItems(liveEventState, turnId)
          : [];
        if (turnId && orphanedToolUseIds.length > 0) {
          const orphanMarker = withCodexTimestamp({
            type: "system",
            subtype: "codex_tool_orphans",
            session_id: sessionId,
            uuid: `codex-tool-orphans-${turnId}`,
            isSynthetic: true,
            orphanedToolUseIds,
          } as SDKMessage);
          logSdkCorrelationDebug(sessionId, orphanMarker, {
            eventKind: "tool_orphans",
            turnId,
            phase: "completed",
            sourceEvent: notification.method,
          });
          messages.push(orphanMarker);
        }

        if (params?.turn.status === "interrupted") {
          const completedAt =
            typeof params.turn.completedAt === "number" &&
            Number.isFinite(params.turn.completedAt)
              ? new Date(params.turn.completedAt * 1000).toISOString()
              : undefined;
          const message = withCodexTimestamp(
            {
              type: "system",
              subtype: "turn_aborted",
              session_id: sessionId,
              uuid: `codex-turn-interrupted-${params.turn.id}`,
              content: "Conversation interrupted",
              reason: "interrupted",
              isSynthetic: true,
              sourceEvent: notification.method,
              codexThreadId: params.threadId,
              codexTurnId: turnId,
              codexTurnStatus: params.turn.status,
              usage: usagePayload,
            } as SDKMessage,
            completedAt,
          );
          logSdkCorrelationDebug(sessionId, message, {
            eventKind: "turn_interrupted",
            ...(turnId ? { turnId } : {}),
            status: turnStatus,
            phase: "completed",
            sourceEvent: notification.method,
          });
          messages.push(message);
          return messages;
        }

        const message = withCodexTimestamp({
          type: "system",
          subtype: "turn_complete",
          session_id: sessionId,
          usage: usagePayload,
        } as SDKMessage);
        logSdkCorrelationDebug(sessionId, message, {
          eventKind: "turn_complete",
          ...(turnId ? { turnId } : {}),
          phase: "completed",
          sourceEvent: notification.method,
        });
        messages.push(message);
        return messages;
      }

      case "error": {
        const params = asCodexErrorNotification(notification.params);
        const rawParams =
          notification.params && typeof notification.params === "object"
            ? (notification.params as Record<string, unknown>)
            : null;
        const fallbackError = this.extractErrorRecord(notification.params);
        const errorMessage =
          params?.error.message ??
          this.getOptionalString(fallbackError?.message);
        const willRetry =
          params?.willRetry ??
          (typeof rawParams?.willRetry === "boolean"
            ? rawParams.willRetry
            : false);
        const isProcessExit = rawParams?.codexProcessExit === true;
        const message =
          (typeof errorMessage === "string" && errorMessage) ||
          (typeof rawParams?.message === "string"
            ? rawParams.message
            : "Codex turn failed");

        const errorEvent = {
          type: "error",
          uuid: params?.turnId
            ? `codex-error-${params.turnId}`
            : `codex-error-${sessionId}-${Date.now()}`,
          session_id: sessionId,
          error: message,
          codexErrorInfo:
            params?.error.codexErrorInfo ??
            fallbackError?.codexErrorInfo ??
            null,
          codexAdditionalDetails:
            readCodexTurnErrorDetail(params?.error) ??
            this.getOptionalString(fallbackError?.additionalDetails) ??
            null,
          codexWillRetry: willRetry,
          codexErrorScope: isProcessExit ? "app_server_process" : "turn",
          codexThreadId: params?.threadId,
          codexTurnId: params?.turnId,
          codexRequestId: this.extractOpenAIRequestId(
            notification.params,
            params?.error,
            message,
          ),
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
            ? asCodexItemStartedNotification(notification.params)
            : asCodexItemCompletedNotification(notification.params);
        if (!params) return [];

        const normalized = this.normalizeThreadItem(params.item);
        if (!normalized) {
          return [];
        }

        const turnId = params.turnId;
        if (
          notification.method === "item/started" &&
          this.isResultBackedThreadItem(normalized)
        ) {
          this.recordLiveResultBackedToolItem(
            liveEventState,
            turnId,
            normalized.id,
          );
        }
        const messages = this.convertItemToSDKMessages(
          normalized,
          sessionId,
          turnId,
          notification.method,
        );
        if (notification.method === "item/completed") {
          this.clearLiveResultBackedToolItem(
            liveEventState,
            turnId,
            normalized.id,
          );
          this.clearLiveEventStateForItem(
            liveEventState,
            turnId,
            normalized.id,
          );
        }
        return messages;
      }

      case "item/agentMessage/delta": {
        const params = asCodexAgentMessageDeltaNotification(
          notification.params,
        );
        if (!params?.delta) return [];
        return [
          this.buildStreamingAssistantMessage(
            sessionId,
            params.turnId,
            params.itemId,
            params.delta,
            "agent_message_delta",
            liveEventState,
          ),
        ];
      }

      case "item/plan/delta": {
        const params = asCodexPlanDeltaNotification(notification.params);
        if (!params?.delta) return [];
        return [
          this.buildStreamingAssistantMessage(
            sessionId,
            params.turnId,
            params.itemId,
            params.delta,
            "plan_delta",
            liveEventState,
          ),
        ];
      }

      case "item/reasoning/summaryTextDelta": {
        const params = asCodexReasoningSummaryTextDeltaNotification(
          notification.params,
        );
        if (!params?.delta) return [];
        return [
          this.buildStreamingReasoningSummaryMessage(
            sessionId,
            params.turnId,
            params.itemId,
            params.summaryIndex,
            params.delta,
            liveEventState,
          ),
        ];
      }

      case "item/commandExecution/outputDelta": {
        const params = asCodexCommandExecutionOutputDeltaNotification(
          notification.params,
        );
        if (!params?.delta) return [];
        return [
          this.buildStreamingToolResultMessage(
            sessionId,
            params.turnId,
            params.itemId,
            params.delta,
            "command_output_delta",
            liveEventState,
          ),
        ];
      }

      case "item/fileChange/outputDelta": {
        const params = asCodexFileChangeOutputDeltaNotification(
          notification.params,
        );
        if (!params?.delta) return [];
        return [
          this.buildStreamingToolResultMessage(
            sessionId,
            params.turnId,
            params.itemId,
            params.delta,
            "file_change_output_delta",
            liveEventState,
          ),
        ];
      }

      case "rawResponseItem/completed": {
        const params = asCodexRawResponseItemCompletedNotification(
          notification.params,
        );
        if (!params) return [];
        return this.convertRawResponseItemToSDKMessages(
          params,
          sessionId,
          liveEventState,
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
        const delivery = itemRecord.delivery === "async" ? "async" : undefined;
        const questions = delivery
          ? normalizeCodexAsyncUserInputQuestions(itemRecord.questions)
          : undefined;
        return {
          id,
          type: "agent_message",
          text,
          ...(delivery ? { delivery } : {}),
          ...(questions ? { questions } : {}),
        };
      }

      case "function_call_output": {
        const name = this.getOptionalString(itemRecord.name);
        if (!name) return null;
        return {
          id,
          type: "function_call_output",
          name,
          namespace: this.getOptionalString(itemRecord.namespace),
          output: itemRecord.output,
        };
      }

      case "command_execution": {
        const commandActions =
          (Array.isArray(itemRecord.commandActions)
            ? itemRecord.commandActions
            : Array.isArray(itemRecord.command_actions)
              ? itemRecord.command_actions
              : undefined) ?? undefined;
        const cwd = this.getOptionalString(itemRecord.cwd);
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
          durationMs:
            this.getOptionalNumber(itemRecord.duration_ms) ??
            this.getOptionalNumber(itemRecord.durationMs) ??
            undefined,
          status: this.normalizeStatus(itemRecord.status),
          ...(cwd ? { cwd } : {}),
          ...(commandActions ? { commandActions } : {}),
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
          mcpAppResourceUri:
            this.getOptionalString(itemRecord.mcpAppResourceUri) ?? undefined,
          result: itemRecord.result,
          error:
            this.getOptionalString(errorObj?.message) !== null
              ? { message: this.getOptionalString(errorObj?.message) ?? "" }
              : undefined,
          status: this.normalizeStatus(itemRecord.status),
        };
      }

      case "dynamic_tool_call": {
        return {
          id,
          type: "dynamic_tool_call",
          namespace: this.getOptionalString(itemRecord.namespace),
          tool: this.getOptionalString(itemRecord.tool) ?? "unknown",
          arguments: itemRecord.arguments,
          status: this.normalizeStatus(itemRecord.status),
          content_items: Array.isArray(itemRecord.contentItems)
            ? itemRecord.contentItems
            : null,
          success:
            typeof itemRecord.success === "boolean" ? itemRecord.success : null,
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

      case "sub_agent_activity": {
        const kind = this.getOptionalString(itemRecord.kind) ?? "updated";
        const agentPath = this.getOptionalString(itemRecord.agentPath) ?? "";
        return {
          id,
          type: "subagent_activity",
          kind,
          agentThreadId: this.getOptionalString(itemRecord.agentThreadId) ?? "",
          agentPath,
          text: formatCodexSubagentActivity(kind, agentPath),
        };
      }

      case "context_compaction":
        return { id, type: "context_compaction" };

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

    const summary = Array.isArray(item.summary)
      ? item.summary.filter((part): part is string => typeof part === "string")
      : [];
    if (summary.length > 0) {
      return summary.join("\n");
    }

    const content = Array.isArray(item.content)
      ? item.content.filter((part): part is string => typeof part === "string")
      : [];
    if (content.length > 0) {
      return content.join("\n");
    }

    return "";
  }

  private normalizeStatus(status: unknown): string {
    if (typeof status !== "string") return "unknown";
    return status.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`);
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

  private asPermissionsRequestApprovalParams(
    params: unknown,
  ): PermissionsRequestApprovalParams | null {
    if (!params || typeof params !== "object") return null;
    const record = params as Record<string, unknown>;
    if (
      typeof record.threadId !== "string" ||
      typeof record.turnId !== "string" ||
      typeof record.itemId !== "string" ||
      typeof record.cwd !== "string" ||
      !record.permissions ||
      typeof record.permissions !== "object"
    ) {
      return null;
    }
    return params as PermissionsRequestApprovalParams;
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
      !Array.isArray(record.questions) ||
      (record.isBlocking !== undefined &&
        typeof record.isBlocking !== "boolean")
    ) {
      return null;
    }
    return {
      ...(params as ToolRequestUserInputParams),
      // Codex 0.147 made this field required. Older app-server releases omit
      // it and defined those requests as blocking.
      isBlocking:
        typeof record.isBlocking === "boolean" ? record.isBlocking : true,
    };
  }

  private buildItemEventKey(turnId: string, itemId: string): string {
    return `${turnId}:${itemId}`;
  }

  private buildItemMessageUuid(itemId: string): string {
    return itemId;
  }

  // Native tool thread items carry Codex's globally-unique call_id as item.id,
  // so this uuid aligns directly with the durable response item. A code-mode
  // commandExecution instead carries an inner exec-* id while rollout stores
  // the outer call_* id; the client reconciles that scoped exception via
  // _codexToolCorrelation. See topics/stream-durable-id-dedup.md.
  private buildItemToolUuid(callId: string): string {
    return callId;
  }

  private buildItemResultUuid(callId: string): string {
    return `${callId}-result`;
  }

  private isResultBackedThreadItem(item: NormalizedThreadItem): boolean {
    return (
      item.type === "command_execution" ||
      item.type === "file_change" ||
      item.type === "mcp_tool_call" ||
      item.type === "dynamic_tool_call" ||
      item.type === "image_view"
    );
  }

  // Thread items whose rendered uuid keys on call_id (item.id) so the streamed
  // message matches its durable backfill row. web_search emits a tool_use but is
  // not result-backed, so it is not covered by isResultBackedThreadItem.
  private isToolBackedThreadItem(item: NormalizedThreadItem): boolean {
    return this.isResultBackedThreadItem(item) || item.type === "web_search";
  }

  private recordLiveResultBackedToolItem(
    liveEventState: CodexLiveEventState,
    turnId: string,
    itemId: string,
  ): void {
    const items =
      liveEventState.resultBackedToolItemsByTurnId.get(turnId) ?? new Set();
    items.add(itemId);
    liveEventState.resultBackedToolItemsByTurnId.set(turnId, items);
  }

  private clearLiveResultBackedToolItem(
    liveEventState: CodexLiveEventState,
    turnId: string,
    itemId: string,
  ): void {
    const items = liveEventState.resultBackedToolItemsByTurnId.get(turnId);
    if (!items) return;
    items.delete(itemId);
    if (items.size === 0) {
      liveEventState.resultBackedToolItemsByTurnId.delete(turnId);
    }
  }

  private consumeLiveResultBackedToolItems(
    liveEventState: CodexLiveEventState,
    turnId: string,
  ): string[] {
    const items = liveEventState.resultBackedToolItemsByTurnId.get(turnId);
    if (!items) return [];
    liveEventState.resultBackedToolItemsByTurnId.delete(turnId);
    return [...items];
  }

  private buildStreamingAssistantMessage(
    sessionId: string,
    turnId: string,
    itemId: string,
    delta: string,
    sourceEvent: string,
    liveEventState: CodexLiveEventState,
  ): SDKMessage {
    const key = this.buildItemEventKey(turnId, itemId);
    const text = `${liveEventState.streamingTextByItemKey.get(key) ?? ""}${delta}`;
    liveEventState.streamingTextByItemKey.set(key, text);

    const message = withCodexTimestamp({
      type: "assistant",
      session_id: sessionId,
      uuid: this.buildItemMessageUuid(itemId),
      _isStreaming: true,
      message: {
        role: "assistant",
        content: text,
      },
    } as SDKMessage);
    logSdkCorrelationDebug(sessionId, message, {
      eventKind: sourceEvent,
      turnId,
      itemId,
      phase: "delta",
      sourceEvent,
    });
    return message;
  }

  private buildStreamingReasoningSummaryMessage(
    sessionId: string,
    turnId: string,
    itemId: string,
    summaryIndex: number,
    delta: string,
    liveEventState: CodexLiveEventState,
  ): SDKMessage {
    const key = this.buildItemEventKey(turnId, itemId);
    const parts =
      liveEventState.streamingReasoningSummaryByItemKey.get(key) ?? [];
    parts[summaryIndex] = `${parts[summaryIndex] ?? ""}${delta}`;
    liveEventState.streamingReasoningSummaryByItemKey.set(key, parts);

    const thinking = parts.filter(Boolean).join("\n");
    const message = withCodexTimestamp({
      type: "assistant",
      session_id: sessionId,
      uuid: this.buildItemMessageUuid(itemId),
      _isStreaming: true,
      message: {
        role: "assistant",
        content: [{ type: "thinking", thinking }],
      },
    } as SDKMessage);
    logSdkCorrelationDebug(sessionId, message, {
      eventKind: "reasoning_summary_delta",
      turnId,
      itemId,
      phase: "delta",
      sourceEvent: "item/reasoning/summaryTextDelta",
    });
    return message;
  }

  private buildStreamingToolResultMessage(
    sessionId: string,
    turnId: string,
    itemId: string,
    delta: string,
    sourceEvent: string,
    liveEventState: CodexLiveEventState,
  ): SDKMessage {
    const key = this.buildItemEventKey(turnId, itemId);
    const content = `${liveEventState.streamingToolOutputByItemKey.get(key) ?? ""}${delta}`;
    liveEventState.streamingToolOutputByItemKey.set(key, content);

    const message = withCodexTimestamp({
      type: "user",
      session_id: sessionId,
      uuid: this.buildItemResultUuid(itemId),
      _isStreaming: true,
      ...(sourceEvent === "command_output_delta"
        ? {
            [CODEX_TOOL_CORRELATION_FIELD]: createCodexToolCorrelation(
              "command_execution",
              turnId,
              itemId,
            ),
          }
        : {}),
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: itemId,
            content,
          },
        ],
      },
    } as SDKMessage);
    logSdkCorrelationDebug(sessionId, message, {
      eventKind: "tool_result",
      turnId,
      itemId,
      callId: itemId,
      phase: "delta",
      sourceEvent,
    });
    return message;
  }

  private clearLiveEventStateForItem(
    liveEventState: CodexLiveEventState,
    turnId: string,
    itemId: string,
  ): void {
    const key = this.buildItemEventKey(turnId, itemId);
    liveEventState.streamingTextByItemKey.delete(key);
    liveEventState.streamingReasoningSummaryByItemKey.delete(key);
    liveEventState.streamingToolOutputByItemKey.delete(key);
  }

  private convertRawResponseItemToSDKMessages(
    params: RawResponseItemCompletedNotification,
    sessionId: string,
    liveEventState: CodexLiveEventState,
  ): SDKMessage[] {
    const item = params.item as Record<string, unknown>;
    const itemType = this.getOptionalString(item.type);
    if (!itemType) return [];

    const observedAt = new Date().toISOString();

    switch (itemType) {
      case "function_call": {
        const callId = this.getOptionalString(item.call_id);
        const rawToolName = this.getOptionalString(item.name);
        const argumentsText = this.getOptionalString(item.arguments);
        if (!callId || !rawToolName) return [];

        const normalizedInvocation = normalizeCodexToolInvocation(
          canonicalizeCodexToolName(rawToolName),
          parseCodexToolArguments(argumentsText ?? undefined),
        );
        liveEventState.toolCallContexts.set(callId, {
          toolName: normalizedInvocation.toolName,
          input: normalizedInvocation.input,
          readShellInfo: normalizedInvocation.readShellInfo,
          writeShellInfo: normalizedInvocation.writeShellInfo,
        });
        this.recordLiveResultBackedToolItem(
          liveEventState,
          params.turnId,
          callId,
        );

        const message = withCodexTimestamp(
          {
            type: "assistant",
            session_id: sessionId,
            uuid: this.buildItemToolUuid(callId),
            message: {
              role: "assistant",
              content: [
                {
                  type: "tool_use",
                  id: callId,
                  name: normalizedInvocation.toolName,
                  input: normalizedInvocation.input,
                  ...(normalizedInvocation.displayActions
                    ? { _displayActions: normalizedInvocation.displayActions }
                    : {}),
                },
              ],
            },
          } as SDKMessage,
          observedAt,
        );
        logSdkCorrelationDebug(sessionId, message, {
          eventKind: "function_call",
          turnId: params.turnId,
          itemId: callId,
          callId,
          phase: "completed",
          sourceEvent: "rawResponseItem/completed",
        });
        return [message];
      }

      case "function_call_output": {
        const callId = this.getOptionalString(item.call_id);
        if (!callId) return [];
        const normalized = normalizeCodexToolOutputWithContext(
          item.output,
          liveEventState.toolCallContexts.get(callId),
        );
        if (
          !isCodexBackgroundProcessOutput(item.output) &&
          !isCodexInterruptedToolOutput(item.output)
        ) {
          liveEventState.toolCallContexts.delete(callId);
          this.clearLiveResultBackedToolItem(
            liveEventState,
            params.turnId,
            callId,
          );
        }

        const toolResult: {
          type: "tool_result";
          tool_use_id: string;
          content: string;
          is_error?: boolean;
        } = {
          type: "tool_result",
          tool_use_id: callId,
          content: normalized.content,
        };
        if (normalized.isError) {
          toolResult.is_error = true;
        }

        const message = withCodexTimestamp(
          {
            type: "user",
            session_id: sessionId,
            uuid: this.buildItemResultUuid(callId),
            message: {
              role: "user",
              content: [toolResult],
            },
            ...(normalized.structured !== undefined
              ? { toolUseResult: normalized.structured }
              : {}),
          } as SDKMessage,
          observedAt,
        );
        attachToolResultMediaCandidates(message, normalized.mediaCandidates);
        logSdkCorrelationDebug(sessionId, message, {
          eventKind: "tool_result",
          turnId: params.turnId,
          itemId: callId,
          callId,
          phase: "completed",
          sourceEvent: "rawResponseItem/completed",
        });
        return [message];
      }

      case "custom_tool_call": {
        const callId = this.getOptionalString(item.call_id);
        const rawToolName = this.getOptionalString(item.name);
        const input = this.getOptionalString(item.input);
        if (!callId || !rawToolName) return [];

        const normalizedInvocation = normalizeCodexCustomToolInvocation(
          rawToolName,
          input ?? "",
        );
        liveEventState.toolCallContexts.set(callId, {
          toolName: normalizedInvocation.toolName,
          input: normalizedInvocation.input,
          readShellInfo: normalizedInvocation.readShellInfo,
          writeShellInfo: normalizedInvocation.writeShellInfo,
        });
        this.recordLiveResultBackedToolItem(
          liveEventState,
          params.turnId,
          callId,
        );

        const message = withCodexTimestamp(
          {
            type: "assistant",
            session_id: sessionId,
            uuid: this.buildItemToolUuid(callId),
            [CODEX_TOOL_CORRELATION_FIELD]: createCodexToolCorrelation(
              "custom_tool_call",
              params.turnId,
              callId,
            ),
            message: {
              role: "assistant",
              content: [
                {
                  type: "tool_use",
                  id: callId,
                  name: normalizedInvocation.toolName,
                  input: normalizedInvocation.input,
                  ...(normalizedInvocation.displayActions
                    ? { _displayActions: normalizedInvocation.displayActions }
                    : {}),
                },
              ],
            },
          } as SDKMessage,
          observedAt,
        );
        logSdkCorrelationDebug(sessionId, message, {
          eventKind: "custom_tool_call",
          turnId: params.turnId,
          itemId: callId,
          callId,
          phase: "completed",
          sourceEvent: "rawResponseItem/completed",
        });
        return [message];
      }

      case "custom_tool_call_output": {
        const callId = this.getOptionalString(item.call_id);
        if (!callId) return [];
        const normalized = normalizeCodexToolOutputWithContext(
          item.output,
          liveEventState.toolCallContexts.get(callId),
        );
        if (
          !isCodexBackgroundProcessOutput(item.output) &&
          !isCodexInterruptedToolOutput(item.output)
        ) {
          liveEventState.toolCallContexts.delete(callId);
          this.clearLiveResultBackedToolItem(
            liveEventState,
            params.turnId,
            callId,
          );
        }

        const toolResult: {
          type: "tool_result";
          tool_use_id: string;
          content: string;
          is_error?: boolean;
        } = {
          type: "tool_result",
          tool_use_id: callId,
          content: normalized.content,
        };
        if (normalized.isError) {
          toolResult.is_error = true;
        }

        const message = withCodexTimestamp(
          {
            type: "user",
            session_id: sessionId,
            uuid: this.buildItemResultUuid(callId),
            [CODEX_TOOL_CORRELATION_FIELD]: createCodexToolCorrelation(
              "custom_tool_call",
              params.turnId,
              callId,
            ),
            message: {
              role: "user",
              content: [toolResult],
            },
            ...(normalized.structured !== undefined
              ? { toolUseResult: normalized.structured }
              : {}),
          } as SDKMessage,
          observedAt,
        );
        attachToolResultMediaCandidates(message, normalized.mediaCandidates);
        logSdkCorrelationDebug(sessionId, message, {
          eventKind: "tool_result",
          turnId: params.turnId,
          itemId: callId,
          callId,
          phase: "completed",
          sourceEvent: "rawResponseItem/completed",
        });
        return [message];
      }

      case "compaction": {
        const message = withCodexTimestamp(
          {
            type: "system",
            subtype: "compact_boundary",
            session_id: sessionId,
            uuid: `codex-compaction-${params.turnId}`,
            content: "Context compacted",
          } as SDKMessage,
          observedAt,
        );
        logSdkCorrelationDebug(sessionId, message, {
          eventKind: "context_compaction",
          turnId: params.turnId,
          itemId: `codex-compaction-${params.turnId}`,
          phase: "completed",
          sourceEvent: "rawResponseItem/completed",
        });
        return [message];
      }

      default:
        return [];
    }
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
    // Native tool items key the uuid on call_id (item.id). Nested code-mode
    // commands and image views temporarily key on their inner item id and
    // carry correlation metadata for adoption of the outer durable call_* id.
    // Message/reasoning item ids are the provider ids persisted in rollout.
    const uuid = this.isToolBackedThreadItem(item)
      ? this.buildItemToolUuid(item.id)
      : item.type === "agent_message" ||
          item.type === "reasoning" ||
          item.type === "function_call_output"
        ? item.id
        : `${item.id}-${turnId}`;

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
            ...(item.delivery
              ? { codexAgentMessageDelivery: item.delivery }
              : {}),
            ...(item.questions ? { codexAsyncQuestions: item.questions } : {}),
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

      case "function_call_output": {
        if (!isComplete) return [];
        const normalized = normalizeCodexToolOutputWithContext(item.output);
        const message = withCodexTimestamp(
          {
            type: "system",
            subtype: "tool_output",
            session_id: sessionId,
            uuid,
            content: normalized.content,
            codexToolName: item.name,
            ...(item.namespace ? { codexToolNamespace: item.namespace } : {}),
            ...(normalized.structured !== undefined
              ? { toolUseResult: normalized.structured }
              : {}),
          } as SDKMessage,
          observedAt,
        );
        attachToolResultMediaCandidates(message, normalized.mediaCandidates);
        logSdkCorrelationDebug(sessionId, message, {
          eventKind: "tool_result",
          turnId,
          itemId: item.id,
          phase: "completed",
          sourceEvent,
        });
        return [message];
      }

      case "command_execution": {
        const messages: SDKMessage[] = [];
        const correlationStartedAt =
          item.durationMs !== undefined
            ? new Date(
                Date.parse(observedAt) - Math.max(0, item.durationMs),
              ).toISOString()
            : observedAt;
        const normalizedInvocation = normalizeCodexToolInvocation("Bash", {
          command: item.command,
          ...(item.cwd ? { cwd: item.cwd } : {}),
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
            [CODEX_TOOL_CORRELATION_FIELD]: createCodexToolCorrelation(
              "command_execution",
              turnId,
              item.id,
              correlationStartedAt,
            ),
            message: {
              role: "assistant",
              content: [
                {
                  type: "tool_use",
                  id: item.id,
                  name: normalizedInvocation.toolName,
                  input: normalizedInvocation.input,
                  ...(normalizedInvocation.displayActions
                    ? { _displayActions: normalizedInvocation.displayActions }
                    : {}),
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
              [CODEX_TOOL_CORRELATION_FIELD]: createCodexToolCorrelation(
                "command_execution",
                turnId,
                item.id,
                correlationStartedAt,
              ),
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
                    ...(item.status !== "completed" ? { is_error: true } : {}),
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
        const input = item.mcpAppResourceUri
          ? {
              arguments: item.arguments,
              mcpAppResourceUri: item.mcpAppResourceUri,
            }
          : item.arguments;

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
                  input,
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

      case "dynamic_tool_call": {
        const messages: SDKMessage[] = [];
        const toolName = item.namespace
          ? `${item.namespace}:${item.tool}`
          : canonicalizeCodexToolName(item.tool);

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
                  name: toolName,
                  input: item.arguments,
                },
              ],
            },
          } as SDKMessage,
          observedAt,
        );
        logSdkCorrelationDebug(sessionId, toolUseMessage, {
          eventKind: "dynamic_tool_call",
          turnId,
          itemId: item.id,
          callId: item.id,
          phase: isComplete ? "completed" : "started",
          sourceEvent,
          status: item.status,
        });
        messages.push(toolUseMessage);

        if (isComplete && item.status !== "in_progress") {
          const isError = item.success === false || item.status === "failed";
          const toolResultBlock: {
            type: "tool_result";
            tool_use_id: string;
            content: string;
            is_error?: boolean;
          } = {
            type: "tool_result",
            tool_use_id: item.id,
            content: this.formatDynamicToolContent(item.content_items),
          };
          if (isError) {
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

      case "subagent_activity": {
        const message = withCodexTimestamp(
          {
            type: "system",
            subtype: "subagent_activity",
            session_id: sessionId,
            uuid,
            content: item.text,
            codexSubagentKind: item.kind,
            codexSubagentThreadId: item.agentThreadId,
            codexSubagentPath: item.agentPath,
          } as SDKMessage,
          observedAt,
        );
        logSdkCorrelationDebug(sessionId, message, {
          eventKind: "subagent_activity",
          turnId,
          itemId: item.id,
          phase: isComplete ? "completed" : "started",
          sourceEvent,
        });
        return [message];
      }

      case "context_compaction": {
        const message = withCodexTimestamp(
          {
            type: "system",
            subtype: isComplete ? "compact_boundary" : "status",
            session_id: sessionId,
            uuid,
            ...(isComplete
              ? { content: "Context compacted" }
              : { status: "compacting", content: "Compacting context..." }),
          } as SDKMessage,
          observedAt,
        );
        logSdkCorrelationDebug(sessionId, message, {
          eventKind: "context_compaction",
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
            [CODEX_TOOL_CORRELATION_FIELD]: createCodexToolCorrelation(
              "image_view",
              turnId,
              item.id,
            ),
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
              [CODEX_TOOL_CORRELATION_FIELD]: createCodexToolCorrelation(
                "image_view",
                turnId,
                item.id,
              ),
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
          attachToolResultMediaCandidates(toolResultMessage, [
            { originalPath: item.path },
          ]);
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

  private formatDynamicToolContent(contentItems: unknown[] | null | undefined) {
    if (!Array.isArray(contentItems) || contentItems.length === 0) {
      return "(no output)";
    }

    const parts = contentItems
      .map((item) => {
        if (!item || typeof item !== "object") return "";
        const record = item as Record<string, unknown>;
        const type = this.getOptionalString(record.type);
        if (type === "inputText") {
          return this.getOptionalString(record.text) ?? "";
        }
        if (type === "inputImage") {
          const imageUrl = this.getOptionalString(record.imageUrl);
          return imageUrl ? `[image: ${imageUrl}]` : "[image]";
        }
        return "";
      })
      .filter(Boolean);

    return parts.length > 0 ? parts.join("\n") : JSON.stringify(contentItems);
  }

  private getPermissionModeFromMessage(
    message: unknown,
  ): StartSessionOptions["permissionMode"] | undefined {
    if (!message || typeof message !== "object") return undefined;
    const mode = (message as { mode?: unknown }).mode;
    switch (mode) {
      case "default":
      case "acceptEdits":
      case "plan":
      case "bypassPermissions":
      case "auto":
        return mode;
      default:
        return undefined;
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
