import { randomUUID } from "node:crypto";
import type {
  DurableRecapMessage,
  DurableLocalCommandMessage,
  EffortLevel,
  ModelInfo,
  PermissionRules,
  PromptSuggestionMode,
  ProviderName,
  ProviderRuntimeStatus,
  RecapMode,
  SessionLivenessSnapshot,
  SessionQueuedMessageSummary,
  SessionQueuedYaCommand,
  SessionSandboxEnforcement,
  SyntheticSessionBoundaryCommand,
  SessionWakeReason,
  SessionWakeReasonSnapshot,
  SlashCommand,
  ThinkingConfig,
  UserQuestionAnswers,
  UrlProjectId,
} from "@yep-anywhere/shared";
import {
  DEFAULT_RECAP_AFTER_SECONDS,
  DEFAULT_PATIENT_QUEUE_PATIENCE_SECONDS,
  HELPER_SIDE_MODEL_CHEAPEST,
  HELPER_SIDE_MODEL_SAME_AS_MAIN,
  clampPatientPatienceSeconds,
  hasInvocationCandidate,
  isClaudeProviderName,
  normalizeRecapAfterSeconds,
  stripPatientQueuePrefix,
} from "@yep-anywhere/shared";
import { DEFAULT_IDLE_TIMEOUT_MS } from "../defaults.js";
import { getLogger } from "../logging/logger.js";
import type { ToolResultMediaMessageMaterializer } from "../media/ToolResultMediaMessageMaterializer.js";
import type { ToolResultMediaStore } from "../media/ToolResultMediaStore.js";
import { getProjectName } from "../projects/paths.js";
import { concatUserMessages, INTERRUPT_PREAMBLE } from "../sdk/messageQueue.js";
import type { AgentMessageQueue } from "../sdk/messageQueue.js";
import type {
  PersistedSessionQueuedMessage,
  SessionQueuePersistenceService,
} from "../services/SessionQueuePersistenceService.js";
import { composeSeenNeedle, composeTimeAnchors } from "./composeTimeAnchor.js";
import {
  type DeferredDeliverySettings,
  resolveDeferredDeliverySettings,
} from "./deferredDeliverySettings.js";
import {
  ProcessViewerLifecycle,
  type ProcessViewerLifecycleOptions,
} from "./ProcessViewerLifecycle.js";
import type {
  AgentProvider,
  PromptCacheRefreshResult,
  SessionExecution,
} from "../sdk/providers/types.js";
import { expandSlashCommandEmulation } from "../sdk/slashCommandEmulation.js";
import type {
  PermissionMode,
  ProviderActivitySnapshot,
  ProviderCommandResult,
  ProviderLivenessProbeResult,
  ProviderRetentionSnapshot,
  SDKMessage,
  TimestampedSDKMessage,
  ToolApprovalResult,
  UserMessage,
} from "../sdk/types.js";
import {
  getSystemMessageText,
  isAwaySummaryMessage,
  messageTimestampMs,
  toDurableRecapMessage,
} from "../sessions/recap-overlays.js";
import {
  buildSessionLivenessSnapshot,
  type LivenessProbeResult,
  type LivenessProcessState,
} from "./liveness.js";
import type {
  AgentActivity,
  InputRequest,
  ProcessAbortResult,
  ProcessEvent,
  ProcessInfo,
  ProcessOptions,
  ProcessState,
} from "./types.js";

type Listener = (event: ProcessEvent) => void | Promise<void>;
type ClaudeSessionState = "idle" | "running" | "requires_action";

type DeferredQueueEntry = {
  message: UserMessage;
  timestamp: string;
  /**
   * Needle of the assistant output the composer had last seen, captured
   * at enqueue (composition context is a queue-time fact, unlike elapsed
   * staleness which only exists at delivery). Quoted in the delivered
   * `(Ns ago, had seen: "…")` anchor when compose anchors are on.
   */
  lastSeenHead?: string;
  persistedQueueId?: string;
};
export type PendingYaCommand = {
  command: SessionQueuedYaCommand;
  content: SyntheticSessionBoundaryCommand;
  tempId: string;
  timestamp: string;
  userTurnVersion: number;
  completionStarted: boolean;
};
type RecentAssistantRecapEntry = {
  completedAtMs: number;
  text: string;
};
type NativeRecapRecord = {
  receivedAtMs: number;
  text: string;
  message: SDKMessage;
};
type PendingRecapRequest = {
  provider: AgentProvider;
  sinceMs: number | null;
};
type PromptCacheKeepaliveLease = {
  getInactivityMs: () => number | null;
};
export const NATIVE_RECAP_FALLBACK_GRACE_MS = 2_000;

export interface RecapRequestResult {
  supported: boolean;
  emitted: boolean;
  reason?: string;
  /** The recap text, when one was emitted or a native recap won. */
  text?: string;
  /** YA-owned message row to persist as a viewer-only overlay. */
  syntheticMessage?: DurableRecapMessage;
}

const CLAUDE_UNBOUNDED_MAX_RETRIES = 2_147_483_647;
const PROCESS_ABORT_TIMEOUT_MS = 5_000;
const PID_EXIT_POLL_INTERVAL_MS = 25;
const MODEL_SWITCH_RETRY_INTERRUPT_PREAMBLE =
  "The previous provider request was interrupted because the model changed while the provider was retrying. Continue under the newly selected model.";

function isLocalPidRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
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

async function waitForLocalPidExit(
  pid: number,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (isLocalPidRunning(pid)) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      return false;
    }
    await new Promise<void>((resolve) =>
      setTimeout(resolve, Math.min(PID_EXIT_POLL_INTERVAL_MS, remainingMs)),
    );
  }
  return true;
}

async function waitUntilAbortDeadline<T>(
  promise: Promise<T>,
  deadline: number,
  timeoutMessage: string,
): Promise<T> {
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) {
    throw new Error(timeoutMessage);
  }

  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeoutHandle = setTimeout(
          () => reject(new Error(timeoutMessage)),
          remainingMs,
        );
      }),
    ]);
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}

/** Whether the user chose durable patient queue intent for this entry. */
function hasPatientQueueIntent(entry: DeferredQueueEntry): boolean {
  return entry.message.metadata?.deliveryIntent === "patient";
}

/**
 * Whether a queued entry should ride the verified-idle patient delivery path
 * instead of the plain turn-end deferred path. Patient timing only differs
 * from deferred on Claude — the only provider that reports background-work
 * retention (session crons, background/live tasks), which is what lets YA wait
 * for genuine completion. Other providers still preserve patient intent across
 * restart, but promote it at the ordinary turn-end boundary.
 */
function usesPatientDeliveryPath(
  entry: DeferredQueueEntry,
  provider: ProviderName,
): boolean {
  return hasPatientQueueIntent(entry) && isClaudeSdkProvider(provider);
}

/** Quiet milliseconds this patient entry waits for after verified idle. */
function patientPatienceMsForEntry(entry: DeferredQueueEntry): number {
  const patienceSeconds =
    clampPatientPatienceSeconds(entry.message.metadata?.patienceSeconds) ??
    DEFAULT_PATIENT_QUEUE_PATIENCE_SECONDS;
  return patienceSeconds * 1000;
}

const ASK_USER_QUESTION_TOOL_NAME = "AskUserQuestion";
const EDIT_TOOLS = new Set(["Edit", "Write", "NotebookEdit"]);
const READ_ONLY_TOOLS = new Set([
  "Read",
  "Glob",
  "Grep",
  "LSP",
  "WebFetch",
  "WebSearch",
  "Task", // Subagent exploration (legacy)
  "Agent", // Subagent exploration (SDK 0.2.76+)
  "TaskOutput", // Reading subagent results
]);
const PROMPT_CACHE_KEEPALIVE_RECHECK_MS = 30_000;
const PROMPT_CACHE_KEEPALIVE_MIN_DELAY_MS = 1_000;

function isAskUserQuestionTool(toolName: string): boolean {
  return toolName === ASK_USER_QUESTION_TOOL_NAME;
}

function getModeBasedToolApproval(
  mode: PermissionMode,
  toolName: string,
  input: unknown,
  requiresUserResponse: boolean,
): ToolApprovalResult | undefined {
  if (requiresUserResponse) {
    return undefined;
  }

  switch (mode) {
    case "bypassPermissions":
      return { behavior: "allow" };
    case "plan": {
      if (READ_ONLY_TOOLS.has(toolName)) {
        return { behavior: "allow" };
      }
      if (toolName === "Write") {
        const filePath = (input as { file_path?: string })?.file_path ?? "";
        if (filePath.includes(".claude/plans/")) {
          return { behavior: "allow" };
        }
      }
      return undefined;
    }
    case "acceptEdits":
      return EDIT_TOOLS.has(toolName) || READ_ONLY_TOOLS.has(toolName)
        ? { behavior: "allow" }
        : undefined;
    default:
      return READ_ONLY_TOOLS.has(toolName) ? { behavior: "allow" } : undefined;
  }
}

function buildAskUserQuestionPrompt(input: unknown): string {
  const questions =
    input && typeof input === "object"
      ? (input as { questions?: unknown }).questions
      : undefined;
  if (!Array.isArray(questions) || questions.length === 0) {
    return "Answer Claude's question";
  }

  const firstQuestion = questions[0];
  const firstQuestionText =
    firstQuestion && typeof firstQuestion === "object"
      ? (firstQuestion as { question?: unknown }).question
      : undefined;
  if (typeof firstQuestionText !== "string" || !firstQuestionText.trim()) {
    return questions.length === 1
      ? "Answer Claude's question"
      : `Answer Claude's ${questions.length} questions`;
  }

  const trimmed = firstQuestionText.trim();
  return questions.length === 1
    ? trimmed
    : `${trimmed} (+${questions.length - 1} more)`;
}

function parseIsoMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * IMPORTANT: Never filter out messages by type before emitting to SSE!
 *
 * Tool results are user-type messages containing tool_result content blocks.
 * If you filter out user messages, tool calls will appear stuck in "pending"
 * state until the page is refreshed (when JSONL is fetched from disk).
 *
 * The client-side mergeMessages handles deduplication by UUID, so duplicate
 * emissions are safe and expected (queueMessage emits user messages, and
 * the iterator also yields them).
 *
 * @returns true - always emit the message
 */
export function shouldEmitMessage(_message: SDKMessage): boolean {
  // Always emit. DO NOT add filtering here!
  // See docstring above for why this is critical.
  return true;
}

/**
 * Single decision point for whether a queued user message is hidden from the
 * transcript UI. Currently true only for YA-injected control commands — the
 * `/compact` YA queues for compaction, which native auto-compaction shows no
 * user turn for. This is deliberately NOT folded into `shouldEmitMessage`
 * (which must stay an unconditional `return true` for provider-stream
 * messages); it gates only the optimistic user echo at queue time. Routing
 * every hide through this one predicate lets a future "show hidden" UI render
 * these consistently (e.g. hyper-collapsed) instead of each call site
 * suppressing ad hoc. See topics/injected-message-visibility.md.
 */
export function isHiddenInjectedMessage(message: UserMessage): boolean {
  return message.metadata?.hidden === true;
}

function isClaudeSdkProvider(provider: ProviderName): boolean {
  return isClaudeProviderName(provider);
}

function isClaudeSdkApiErrorMessage(
  provider: ProviderName,
  message: SDKMessage,
): boolean {
  return (
    isClaudeSdkProvider(provider) &&
    message.type === "assistant" &&
    message.isApiErrorMessage === true
  );
}

function isClaudeSdkApiRetryMessage(
  provider: ProviderName,
  message: SDKMessage,
): boolean {
  return (
    isClaudeSdkProvider(provider) &&
    message.type === "system" &&
    message.subtype === "api_retry"
  );
}

type ProviderRuntimeStatusValue = Exclude<ProviderRuntimeStatus, null>;
type ProviderRuntimeRetryStatus = Extract<
  ProviderRuntimeStatusValue,
  { kind: "retrying" }
>;
type ProviderRuntimeTerminalStatus = Extract<
  ProviderRuntimeStatusValue,
  { kind: "terminal" }
>;
type ProviderRuntimeReason = ProviderRuntimeStatusValue["reason"];

function readFiniteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function readPositiveInteger(value: unknown): number | undefined {
  const number = readFiniteNumber(value);
  if (number === undefined || number <= 0) {
    return undefined;
  }
  return Math.trunc(number);
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readCodexHttpStatus(codexErrorInfo: unknown): number | undefined {
  if (!codexErrorInfo || typeof codexErrorInfo !== "object") {
    return undefined;
  }
  for (const value of Object.values(
    codexErrorInfo as Record<string, unknown>,
  )) {
    if (value && typeof value === "object") {
      const status = readPositiveInteger(
        (value as Record<string, unknown>).httpStatusCode,
      );
      if (status !== undefined) {
        return status;
      }
    }
  }
  return undefined;
}

function normalizeProviderRuntimeReason(error: unknown): ProviderRuntimeReason {
  switch (error) {
    case "rate_limit":
      return "rate_limit";
    case "overloaded":
      return "overloaded";
    case "server_error":
      return "server_error";
    case "network":
      return "network";
    default:
      return "unknown";
  }
}

function normalizeMaxRetries(
  value: unknown,
): ProviderRuntimeRetryStatus["maxRetries"] | undefined {
  const maxRetries = readPositiveInteger(value);
  if (maxRetries === undefined) {
    return undefined;
  }
  return maxRetries >= CLAUDE_UNBOUNDED_MAX_RETRIES ? "unbounded" : maxRetries;
}

function buildClaudeApiRetryStatus(
  provider: ProviderName,
  previous: ProviderRuntimeStatus,
  message: SDKMessage,
  receivedAt: Date,
): ProviderRuntimeRetryStatus {
  const lastSeenAt = receivedAt.toISOString();
  const httpStatus = readPositiveInteger(message.error_status);
  const attempt = readPositiveInteger(message.attempt);
  const maxRetries = normalizeMaxRetries(message.max_retries);
  const retryDelayMs = readFiniteNumber(message.retry_delay_ms);
  const nonNegativeRetryDelayMs =
    retryDelayMs !== undefined && retryDelayMs >= 0
      ? Math.trunc(retryDelayMs)
      : undefined;
  const retryAt =
    nonNegativeRetryDelayMs !== undefined
      ? new Date(receivedAt.getTime() + nonNegativeRetryDelayMs).toISOString()
      : undefined;

  return {
    kind: "retrying",
    provider,
    reason: normalizeProviderRuntimeReason(message.error),
    ...(httpStatus !== undefined ? { httpStatus } : {}),
    startedAt: previous?.kind === "retrying" ? previous.startedAt : lastSeenAt,
    lastSeenAt,
    ...(retryAt ? { retryAt } : {}),
    ...(nonNegativeRetryDelayMs !== undefined
      ? { retryDelayMs: nonNegativeRetryDelayMs }
      : {}),
    ...(attempt !== undefined ? { attempt } : {}),
    ...(maxRetries !== undefined ? { maxRetries } : {}),
    eventCount: previous?.kind === "retrying" ? previous.eventCount + 1 : 1,
    source: "claude.system.api_retry",
  };
}

function normalizeClaudeTerminalReason(
  message: SDKMessage,
): ProviderRuntimeReason {
  const httpStatus = readPositiveInteger(message.apiErrorStatus);
  if (httpStatus === 402 || httpStatus === 429) return "rate_limit";
  if (httpStatus === 529) return "overloaded";

  const providerReason = normalizeProviderRuntimeReason(message.error);
  if (providerReason !== "unknown") return providerReason;
  return httpStatus !== undefined && httpStatus >= 500
    ? "server_error"
    : "unknown";
}

function buildClaudeApiTerminalStatus(
  provider: ProviderName,
  message: SDKMessage,
  receivedAt: Date,
): ProviderRuntimeTerminalStatus | null {
  if (!isClaudeSdkApiErrorMessage(provider, message)) return null;
  return {
    kind: "terminal",
    provider,
    reason: normalizeClaudeTerminalReason(message),
    message: extractMessageText(message) ?? "Claude API request failed",
    occurredAt: receivedAt.toISOString(),
    source: "claude.assistant.api_error",
  };
}

function readClaudeGatewayCompactionQuotaMessage(
  provider: ProviderName,
  message: SDKMessage,
): string | null {
  if (
    provider !== "claude-gateway" ||
    message.type !== "system" ||
    message.subtype !== "local_command"
  ) {
    return null;
  }
  const content = readNonEmptyString(message.content);
  const prefix =
    "<local-command-stderr>Error during compaction: API Error: 402 ";
  const suffix = "</local-command-stderr>";
  if (!content?.startsWith(prefix) || !content.endsWith(suffix)) return null;

  let payload: unknown;
  try {
    payload = JSON.parse(content.slice(prefix.length, -suffix.length));
  } catch {
    return null;
  }
  const error =
    payload && typeof payload === "object"
      ? (payload as Record<string, unknown>).error
      : null;
  if (!error || typeof error !== "object") return null;
  const fields = error as Record<string, unknown>;
  if (fields.code !== "quota_exceeded") return null;
  return readNonEmptyString(fields.message) ?? "Claude Gateway quota exceeded";
}

function buildClaudeGatewayCompactionQuotaStatus(
  provider: ProviderName,
  message: SDKMessage,
  receivedAt: Date,
): ProviderRuntimeTerminalStatus | null {
  const quotaMessage = readClaudeGatewayCompactionQuotaMessage(
    provider,
    message,
  );
  if (!quotaMessage) return null;
  return {
    kind: "terminal",
    provider,
    reason: "rate_limit",
    message: quotaMessage,
    occurredAt: receivedAt.toISOString(),
    source: "claude.system.local_command.compaction",
  };
}

function normalizeCodexTerminalReason(
  codexErrorInfo: unknown,
): ProviderRuntimeReason {
  switch (codexErrorInfo) {
    case "serverOverloaded":
      return "overloaded";
    case "usageLimitExceeded":
    case "sessionBudgetExceeded":
    case "rateLimitExceeded":
      return "rate_limit";
    case "internalServerError":
      return "server_error";
    default:
      break;
  }

  if (codexErrorInfo && typeof codexErrorInfo === "object") {
    const keys = Object.keys(codexErrorInfo as Record<string, unknown>);
    if (
      keys.some((key) =>
        [
          "httpConnectionFailed",
          "responseStreamConnectionFailed",
          "responseStreamDisconnected",
        ].includes(key),
      )
    ) {
      return "network";
    }
  }

  return "unknown";
}

function buildCodexRetryStatus(
  provider: ProviderName,
  previous: ProviderRuntimeStatus,
  message: SDKMessage,
  receivedAt: Date,
): ProviderRuntimeRetryStatus | null {
  if (
    provider !== "codex" ||
    message.type !== "error" ||
    message.codexWillRetry !== true
  ) {
    return null;
  }

  const lastSeenAt = receivedAt.toISOString();
  const httpStatus = readCodexHttpStatus(message.codexErrorInfo);
  const providerMessage = readNonEmptyString(message.error);
  const details = readNonEmptyString(message.codexAdditionalDetails);
  const turnId = readNonEmptyString(message.codexTurnId);
  const requestId = readNonEmptyString(message.codexRequestId);
  const retryDelayMs = readFiniteNumber(message.codexRetryDelayMs);
  const nonNegativeRetryDelayMs =
    retryDelayMs !== undefined && retryDelayMs >= 0
      ? Math.trunc(retryDelayMs)
      : undefined;
  const retryAt =
    nonNegativeRetryDelayMs !== undefined
      ? new Date(receivedAt.getTime() + nonNegativeRetryDelayMs).toISOString()
      : undefined;
  const attempt = readPositiveInteger(message.codexRetryAttempt);
  const maxRetries = readPositiveInteger(message.codexRetryMaxRetries);

  return {
    kind: "retrying",
    provider,
    reason: normalizeCodexTerminalReason(message.codexErrorInfo),
    ...(httpStatus !== undefined ? { httpStatus } : {}),
    startedAt: previous?.kind === "retrying" ? previous.startedAt : lastSeenAt,
    lastSeenAt,
    ...(retryAt ? { retryAt } : {}),
    ...(nonNegativeRetryDelayMs !== undefined
      ? { retryDelayMs: nonNegativeRetryDelayMs }
      : {}),
    ...(attempt !== undefined ? { attempt } : {}),
    ...(maxRetries !== undefined ? { maxRetries } : {}),
    eventCount: previous?.kind === "retrying" ? previous.eventCount + 1 : 1,
    source: "codex.error",
    ...(providerMessage ? { message: providerMessage } : {}),
    ...(details ? { details } : {}),
    ...(turnId ? { turnId } : {}),
    ...(requestId ? { requestId } : {}),
  };
}

function buildCodexTerminalStatus(
  provider: ProviderName,
  message: SDKMessage,
  receivedAt: Date,
): ProviderRuntimeTerminalStatus | null {
  if (
    provider !== "codex" ||
    message.type !== "error" ||
    message.codexWillRetry !== false
  ) {
    return null;
  }

  const errorMessage = readNonEmptyString(message.error) ?? "Codex turn failed";
  const turnId = readNonEmptyString(message.codexTurnId);
  const requestId = readNonEmptyString(message.codexRequestId);
  const details = readNonEmptyString(message.codexAdditionalDetails);
  const isProcessExit = message.codexErrorScope === "app_server_process";

  return {
    kind: "terminal",
    provider,
    reason: isProcessExit
      ? "server_error"
      : normalizeCodexTerminalReason(message.codexErrorInfo),
    message: errorMessage,
    occurredAt: receivedAt.toISOString(),
    source: isProcessExit ? "codex.app_server_process" : "codex.error",
    ...(turnId ? { turnId } : {}),
    ...(requestId ? { requestId } : {}),
    ...(details ? { details } : {}),
    ...(isProcessExit ? { scope: "provider_process" as const } : {}),
  };
}

function providerRuntimeStatusesEqual(
  a: ProviderRuntimeStatus,
  b: ProviderRuntimeStatus,
): boolean {
  if (a === b) return true;
  return JSON.stringify(a) === JSON.stringify(b);
}

function isProviderRuntimeProgressMessage(message: SDKMessage): boolean {
  return (
    message.type === "assistant" ||
    message.type === "stream_event" ||
    message.type === "result"
  );
}

function getClaudeSessionStateChange(
  message: SDKMessage,
): ClaudeSessionState | null {
  if (
    message.type !== "system" ||
    message.subtype !== "session_state_changed"
  ) {
    return null;
  }
  const state = message.state;
  return state === "idle" || state === "running" || state === "requires_action"
    ? state
    : null;
}

function getSdkMessageSubtype(message: SDKMessage): string | undefined {
  return typeof message.subtype === "string" ? message.subtype : undefined;
}

// Top-level SDK message types that represent real turn content. Each one is part
// of a model/tool turn that is guaranteed to eventually reach a `result`, so
// waking on them can never pin the process `in-turn` forever.
const WAKE_WORK_MESSAGE_TYPES = new Set<string>([
  "assistant",
  "user",
  "stream_event",
]);

// `system` message subtypes that represent live Claude-owned background work
// which can wake the session later. Mirrors the task lifecycle tracked for
// reap-retention in ClaudeProviderRetentionTracker.observeMessage.
const WAKE_WORK_SYSTEM_SUBTYPES = new Set<string>([
  "task_started",
  "task_progress",
  "task_updated",
  "task_notification",
]);

/**
 * Decide whether a post-idle provider message should promote a coarse-idle owned
 * process back to `in-turn` (see promoteIdleForProviderWork and doc
 * tactical/015-claude-background-task-idle-reap.md).
 *
 * This is an allowlist (default-deny) on purpose. The original blacklist ("wake
 * on everything except result / session_state_changed / init") woke the process
 * on any message the SDK introduced that we did not model. That included
 * `prompt_suggestion` — a post-turn, predicted-next-prompt message that is never
 * followed by a `result` — so finished sessions got pinned as "thinking" forever
 * and were never idle-reaped. To add a wake trigger, name it here.
 *
 * Reap-safety is owned separately by ClaudeProviderRetentionTracker; this
 * predicate only governs the cosmetic `in-turn` activity flip. So an unmodeled
 * future message type degrades safely to "no wake" rather than "stuck", and a
 * genuine background task still shows as live via the retention overlay
 * (verified-waiting-provider) regardless of this flip.
 */
function isProviderWorkWakeMessage(message: SDKMessage): boolean {
  // session_state_changed drives the state machine directly; it is not a wake.
  if (getClaudeSessionStateChange(message) !== null) {
    return false;
  }
  if (message.type === "system") {
    const subtype = getSdkMessageSubtype(message);
    return subtype !== undefined && WAKE_WORK_SYSTEM_SUBTYPES.has(subtype);
  }
  return WAKE_WORK_MESSAGE_TYPES.has(message.type);
}

function extractMessageText(message: SDKMessage): string | undefined {
  const content = message.message?.content;
  if (typeof content === "string") {
    return content.trim() || undefined;
  }
  if (!Array.isArray(content)) {
    return undefined;
  }
  const text = content
    .map((block) => (block.type === "text" ? block.text : undefined))
    .filter((part): part is string => !!part)
    .join("\n")
    .trim();
  return text || undefined;
}

function describeClaudeSdkApiError(message: SDKMessage): string {
  const status = message.apiErrorStatus;
  const statusText =
    typeof status === "number" || typeof status === "string"
      ? `status ${status}`
      : "unknown status";
  const detail = extractMessageText(message);
  return detail
    ? `Claude SDK API error (${statusText}): ${detail}`
    : `Claude SDK API error (${statusText})`;
}

/**
 * Pending tool approval request.
 * The SDK's canUseTool callback creates this and waits for respondToInput.
 */
interface PendingToolApproval {
  request: InputRequest;
  resolve: (result: ToolApprovalResult) => void;
}

/**
 * Deferred (queued-while-busy) delivery behavior overrides (tests). Unset
 * fields resolve from server settings then env config — both default off, so
 * vanilla delivery promotes one verbatim deferred turn per delivery boundary
 * (see topics/vanilla-defaults.md and supervisor/deferredDeliverySettings.ts).
 */
export interface DeferredDeliveryOptions {
  /**
   * Max seconds between consecutive compose times for deferred turns to join
   * into one provider turn with `--------` separators. 0 = never join.
   */
  joinWindowSeconds?: number;
  /** Prepend `(Ns ago)` / `(Ms later)` compose-time staleness anchors. */
  composeAnchors?: boolean;
  /** Absolute `[sent <ISO>]` markers on provider-bound user turns. */
  turnTimestamps?: "off" | "before" | "after";
}

export interface ProcessConstructorOptions extends ProcessOptions {
  /** Provider message queue, undefined for mock SDK */
  queue?: AgentMessageQueue;
  /** Abort function from real SDK */
  abortFn?: () => void | Promise<void>;
  /** Release a reload-safe proxy without terminating its provider session. */
  detachForServerReloadFn?: () => void | Promise<void>;
  /** Check if underlying CLI process is still alive (for stale detection) */
  isProcessAlive?: () => boolean;
  /** Return true when an idle process should stay owned for an explicit feature. */
  shouldRetainIdleProcess?: (sessionId: string) => boolean;
  /** Terminal provider incident retained by Supervisor across process reaping. */
  initialProviderRuntimeStatus?: ProviderRuntimeStatus;
  /** Actively query provider/session status when passive evidence is stale. */
  probeLivenessFn?: () => Promise<ProviderLivenessProbeResult>;
  /** Passive raw provider/app-server event cadence, when available. */
  getProviderActivityFn?: () => ProviderActivitySnapshot;
  /** Provider-owned work that should retain an otherwise idle process. */
  getProviderRetentionFn?: () => ProviderRetentionSnapshot;
  /** No-viewer period retained by a reload-safe runtime owner. */
  getRuntimeUnviewedSinceFn?: () => Date | undefined;
  /** Publish first/last viewer transitions to a reload-safe runtime owner. */
  setRuntimeViewerPresenceFn?: (hasViewers: boolean) => void | Promise<void>;
  /** Provider no-context-pollution prompt-cache refresh action. */
  refreshPromptCacheFn?: (options: {
    sessionId: string;
  }) => Promise<PromptCacheRefreshResult>;
  /** Durable YA automation pause owned by session metadata. */
  isAutomationPaused?: () => boolean;
  /** Function to change max thinking tokens at runtime (SDK 0.2.7+) */
  setMaxThinkingTokensFn?: (tokens: number | null) => Promise<void>;
  /** Function to change effort without restarting the provider process. */
  setEffortFn?: (effort?: EffortLevel) => Promise<void>;
  /** Whether effort changes can be published into an active provider turn. */
  effortUpdatesActiveTurn?: boolean;
  /** Function to interrupt current turn gracefully (SDK 0.2.7+) */
  interruptFn?: () => Promise<undefined | boolean>;
  /**
   * Function to steer an active turn with additional user input.
   * Returns false when steering is unavailable and caller should enqueue.
   */
  steerFn?: (message: UserMessage) => Promise<boolean>;
  /** Function to get supported models (SDK 0.2.7+) */
  supportedModelsFn?: () => Promise<ModelInfo[]>;
  /** Function to get supported slash commands (SDK 0.2.7+) */
  supportedCommandsFn?: () => Promise<SlashCommand[]>;
  onCommandsObserved?: (
    sessionId: string,
    commands: SlashCommand[],
  ) => Promise<void>;
  /** Function to change model mid-session (SDK 0.2.7+) */
  setModelFn?: (model?: string) => Promise<void>;
  /**
   * Dispatch a provider-native slash command out-of-band (e.g. Codex
   * `/compact` → `thread/compact/start`). Returns `{ handled: false }` when the
   * command should fall back to normal turn delivery.
   */
  runProviderCommandFn?: (
    command: string,
    argument?: string,
  ) => Promise<ProviderCommandResult>;
  /**
   * Publish the provider's real session id to environment bridges that affect
   * future tool shells spawned by the provider child process.
   */
  publishAgentctlSessionIdFn?: (sessionId: string) => void | Promise<void>;
  /** Deprecated compatibility flag; prefer recapMode. */
  recapsEnabled?: boolean;
  /** How this process should answer away-recap requests. */
  recapMode?: RecapMode;
  /** Browser-away duration before YA asks this process for a recap. */
  recapAfterSeconds?: number;
  /** How this process should request native prompt suggestions. */
  promptSuggestionMode?: PromptSuggestionMode;
  /** Session-level helper side model for simulated helper features. */
  helperSideModel?: string;
  /** Override deferred-delivery toggles (tests); defaults from server config. */
  deferredDelivery?: DeferredDeliveryOptions;
  /** Durable store for long-lived patient queued messages. */
  sessionQueuePersistenceService?: SessionQueuePersistenceService;
  /** Materializes image-bearing tool results before replay or emission. */
  toolResultMediaStore?: ToolResultMediaStore;
}

export class Process {
  readonly id: string;
  private _sessionId: string;
  readonly projectPath: string;
  readonly projectId: UrlProjectId;
  readonly startedAt: Date;
  readonly provider: ProviderName;
  readonly model: string | undefined;
  readonly serviceTier: string | undefined;
  /** SSH host for remote execution (undefined = local) */
  readonly executor: string | undefined;
  /** Internal placement coordinate, kept out of browser-facing ProcessInfo. */
  readonly execution: SessionExecution;
  readonly sandboxEnforcement: SessionSandboxEnforcement | undefined;
  readonly sandboxStateKey: string | undefined;
  readonly sandboxProjectPath: string | undefined;

  private legacyQueue: UserMessage[] = [];
  private messageQueue: AgentMessageQueue | null;
  private unsubscribeMessageQueueYielded: (() => void) | undefined;
  private deferredDeliveryOverrides: DeferredDeliveryOptions | undefined;
  private sessionQueuePersistenceService:
    | SessionQueuePersistenceService
    | undefined;
  private toolResultMediaMaterializer:
    | ToolResultMediaMessageMaterializer
    | undefined;
  private patientQueuePersistenceTail: Promise<void> = Promise.resolve();
  private abortFn: (() => void | Promise<void>) | null;
  private detachForServerReloadFn: (() => void | Promise<void>) | null;
  private _state: ProcessState = { type: "in-turn" };
  private listeners: Set<Listener> = new Set();
  private liveDeltaSubscriberCount = 0;
  private readonly viewerLifecycle: ProcessViewerLifecycle;
  private iteratorDone = false;

  /** Set synchronously when transport/spawn fails to prevent race with queueMessage */
  private transportFailed = false;

  /**
   * Two-bucket message buffer for SSE replay to late-joining clients.
   * Buckets swap every 15 seconds, giving 15-30s of history.
   * This bounds memory while covering the JSONL persistence gap.
   */
  private currentBucket: SDKMessage[] = [];
  private previousBucket: SDKMessage[] = [];
  private bucketSwapTimer: ReturnType<typeof setInterval> | null = null;
  private static readonly BUCKET_SWAP_INTERVAL_MS = 15_000;

  /**
   * User echoes accepted for in-turn steering remain replayable through the
   * provider turn. A steer can wait behind a long-running tool for longer than
   * the ordinary replay buckets, while its durable row does not exist yet.
   */
  private activeSteerEchoes: Map<string, SDKMessage> = new Map();

  /** Accumulated streaming text for catch-up when clients connect mid-stream */
  private _streamingText = "";
  /** Message ID for current streaming response */
  private _streamingMessageId: string | null = null;
  /** Preserve provider/receipt ordering while a local command is saved. */
  private commandOutputPublication: Promise<void> | null = null;

  /**
   * Rolling buffer of recent assistant text turns used as context for
   * server-synthesized recaps. See topics/recaps.md. We capture text here
   * rather than reading the JSONL because the recap path is hot and the
   * buffer is bounded; older entries are dropped as new ones arrive.
   */
  private recentAssistantRecapEntries: RecentAssistantRecapEntry[] = [];
  private static readonly RECENT_TEXT_MAX_ENTRIES = 15;
  private static readonly RECENT_TEXT_MAX_CHARS_PER_ENTRY = 1500;
  /**
   * Guard against overlapping recap requests for the same process; the
   * route handler short-circuits when a generation is already in flight.
   */
  private recapInFlight = false;
  private pendingRecapRequest: PendingRecapRequest | null = null;
  private recapPausedUntilUserTurn = false;
  private lastNativeRecap: NativeRecapRecord | null = null;
  private nativeRecapWaiters = new Set<() => void>();
  private providerRuntimeStatus: ProviderRuntimeStatus = null;
  private _recapMode: RecapMode;
  private _recapAfterSeconds: number;
  private _promptSuggestionMode: PromptSuggestionMode;
  private _helperSideModel: string;

  /** Pending tool approval requests (from canUseTool callback) - supports concurrent approvals */
  private pendingToolApprovals: Map<string, PendingToolApproval> = new Map();
  /** Order of pending approval request IDs for FIFO processing */
  private pendingToolApprovalQueue: string[] = [];

  /** Current permission mode for tool approvals */
  private _permissionMode: PermissionMode = "default";

  /** Codex mode applied at the latest successful thread or turn boundary. */
  private _appliedPermissionMode: PermissionMode | undefined;

  /** Permission rules for tool filtering (deny/allow patterns from API caller) */
  private _permissions: PermissionRules | undefined;

  /** Version counter for permission mode changes (for multi-tab sync) */
  private _modeVersion = 0;

  /** Thinking configuration (undefined = thinking disabled) */
  private _thinking: ThinkingConfig | undefined;
  /** Effort level for response quality */
  private _effort: EffortLevel | undefined;
  /** Latest effort selected while the current provider turn is still active. */
  private pendingEffortUpdate: { effort: EffortLevel | undefined } | null =
    null;
  /** Serializes provider effort controls so slower writes cannot win late. */
  private effortApplyTail: Promise<void> = Promise.resolve();
  /** A failed turn-boundary effort write keeps the process non-idle. */
  private effortBoundaryBlocked = false;
  private effortBoundaryTransition: Promise<void> | null = null;

  /** Function to change max thinking tokens at runtime (SDK 0.2.7+) */
  private setMaxThinkingTokensFn:
    | ((tokens: number | null) => Promise<void>)
    | null;
  /** Function to change effort without restarting the provider process. */
  private setEffortFn: ((effort?: EffortLevel) => Promise<void>) | null;
  private effortUpdatesActiveTurn: boolean;

  /** Function to interrupt current turn gracefully (SDK 0.2.7+) */
  private interruptFn: (() => Promise<undefined | boolean>) | null;
  /** Function to steer an active turn (provider-specific, currently Codex app-server) */
  private steerFn: ((message: UserMessage) => Promise<boolean>) | null;

  /** Function to get supported models (SDK 0.2.7+) */
  private supportedModelsFn: (() => Promise<ModelInfo[]>) | null;

  /** Function to get supported slash commands (SDK 0.2.7+) */
  private supportedCommandsFn: (() => Promise<SlashCommand[]>) | null;
  private supportedCommandsCache: SlashCommand[] | null = null;
  private onCommandsObserved: ProcessConstructorOptions["onCommandsObserved"];
  private supportedCommandsRefreshInFlight: Promise<
    SlashCommand[] | null
  > | null = null;

  /** Function to change model mid-session (SDK 0.2.7+) */
  private setModelFn: ((model?: string) => Promise<void>) | null;
  /** Function to dispatch a provider-native slash command out-of-band. */
  private runProviderCommandFn:
    | ((command: string, argument?: string) => Promise<ProviderCommandResult>)
    | null;
  private publishAgentctlSessionIdFn:
    | ((sessionId: string) => void | Promise<void>)
    | null;

  /** Resolvers waiting for the real session ID */
  private sessionIdResolvers: Array<(id: string) => void> = [];
  private sessionIdResolved = false;
  private readonly providerSessionIdSettlement: Promise<string>;
  private resolveProviderSessionIdSettlement: ((id: string) => void) | null =
    null;
  private rejectProviderSessionIdSettlement: ((error: Error) => void) | null =
    null;

  /** Timestamp of last SDK message received (for staleness detection) */
  private _lastMessageTime: Date;
  /** Timestamp of last real provider/SDK message; null until one arrives. */
  private _lastProviderMessageTime: Date | null;
  /** Timestamp of last Process state transition. */
  private _lastStateChangeTime: Date;

  /** Check if underlying CLI process is still alive (undefined = not available). */
  private _isProcessAlive: (() => boolean) | null;
  /** Provider-specific active liveness probe, when available. */
  private probeLivenessFn: (() => Promise<ProviderLivenessProbeResult>) | null;
  private getProviderActivityFn: (() => ProviderActivitySnapshot) | null;
  private getProviderRetentionFn: (() => ProviderRetentionSnapshot) | null =
    null;
  private refreshPromptCacheFn:
    | ((options: { sessionId: string }) => Promise<PromptCacheRefreshResult>)
    | null = null;
  private isAutomationPausedFn: () => boolean;
  private promptCacheKeepaliveLeases = new Map<
    string,
    PromptCacheKeepaliveLease
  >();
  private promptCacheKeepaliveTimer: ReturnType<typeof setTimeout> | null =
    null;
  private promptCacheKeepaliveInFlight = false;
  private lastPromptCacheKeepaliveAt: Date | null = null;
  private lastWakeReason: SessionWakeReasonSnapshot | null = null;
  private _lastLivenessProbe: LivenessProbeResult | null = null;
  private _livenessProbeInFlight: Promise<LivenessProbeResult | null> | null =
    null;

  /** OS PID of the spawned agent child process (supports deferred resolution) */
  private _pidResolver: number | (() => number | undefined) | undefined;
  private _lastKnownPid: number | undefined;

  /** Resolved model name from the first assistant message (e.g., "claude-sonnet-4-5-20250929") */
  private _resolvedModel: string | null | undefined;
  /**
   * Current requested YA model id (launch alias, e.g. "opus"). Starts at the
   * exact launch request and follows mid-session model switches (which leave the
   * readonly `model` at its original value). Keys per-model settings.
   */
  private _requestedModel: string | null | undefined;
  /** Context window size reported by SDK in result messages' modelUsage */
  private _contextWindow: number | undefined;
  /** Monotonic marker for assistant output observed by this process. */
  private _assistantActivityVersion = 0;
  /** Monotonic marker for delivery intent received before any async priming. */
  private _inputIntentVersion = 0;
  /** Monotonic marker for accepted real user turns. */
  private _userTurnVersion = 0;
  private _compactAtContextPercent: number | undefined;
  private _compactAtContextWindow: number | undefined;
  private _forceYaOrchestratedCompaction: boolean;
  readonly compactAtContextTokenLimit: number | undefined;
  readonly launchCompactPercentOverride: number | undefined;

  /** Deferred message queue — messages queued while agent is in-turn, auto-sent when turn ends */
  private deferredQueue: DeferredQueueEntry[] = [];
  /** YA-local commands awaiting a provider turn boundary, never provider input. */
  private pendingYaCommands: PendingYaCommand[] = [];

  /** Promise that resolves when the process fully terminates (CLI exits) */
  private _exitPromise: Promise<void>;
  private _exitResolve: (() => void) | null = null;
  private abortInFlight: Promise<ProcessAbortResult> | null = null;
  /** Registry release is one event, regardless of which terminal path finishes. */
  private completionEmitted = false;

  constructor(
    private sdkIterator: AsyncIterator<SDKMessage>,
    options: ProcessConstructorOptions,
  ) {
    this.id = randomUUID();
    this._sessionId = options.sessionId;
    this.projectPath = options.projectPath;
    this.projectId = options.projectId;
    this.startedAt = new Date();
    this._state =
      options.initialState === "idle"
        ? { type: "idle", since: this.startedAt }
        : { type: "in-turn" };

    // Real SDK provides these, mock SDK doesn't
    this.messageQueue = options.queue ?? null;
    this.deferredDeliveryOverrides = options.deferredDelivery;
    this.sessionQueuePersistenceService =
      options.sessionQueuePersistenceService;
    this.abortFn = options.abortFn ?? null;
    this.detachForServerReloadFn = options.detachForServerReloadFn ?? null;
    this._permissionMode = options.permissionMode ?? "default";
    this._permissions = options.permissions;
    this.provider = options.provider;
    this.toolResultMediaMaterializer =
      options.toolResultMediaStore?.createMaterializer(
        {
          provider: this.provider,
          projectId: this.projectId,
          projectPath: this.projectPath,
          getSessionId: () => this._sessionId,
        },
        { live: true },
      );
    this.model = options.model;
    this._requestedModel = options.requestedModel ?? options.model;
    this._compactAtContextPercent = options.compactAtContextPercent;
    this._compactAtContextWindow = options.compactAtContextWindow;
    this._forceYaOrchestratedCompaction =
      options.forceYaOrchestratedCompaction === true;
    this.compactAtContextTokenLimit = options.compactAtContextTokenLimit;
    this.launchCompactPercentOverride = options.launchCompactPercentOverride;
    this.serviceTier = options.serviceTier;
    this.executor = options.executor;
    this.execution =
      options.execution ??
      (options.executor
        ? { kind: "legacy-ssh", executor: options.executor }
        : { kind: "local" });
    this.sandboxEnforcement = options.sandboxEnforcement;
    this.sandboxStateKey = options.sandboxStateKey;
    this.sandboxProjectPath = options.sandboxProjectPath;
    this._thinking = options.thinking;
    this._effort = options.effort;
    this.setMaxThinkingTokensFn = options.setMaxThinkingTokensFn ?? null;
    this.setEffortFn = options.setEffortFn ?? null;
    this.effortUpdatesActiveTurn = options.effortUpdatesActiveTurn === true;
    this.interruptFn = options.interruptFn ?? null;
    this.steerFn = options.steerFn ?? null;
    this.supportedModelsFn = options.supportedModelsFn ?? null;
    this.supportedCommandsFn = options.supportedCommandsFn ?? null;
    this.onCommandsObserved = options.onCommandsObserved;
    this._pidResolver = options.pid;
    this.setModelFn = options.setModelFn ?? null;
    this.runProviderCommandFn = options.runProviderCommandFn ?? null;
    this.publishAgentctlSessionIdFn =
      options.publishAgentctlSessionIdFn ?? null;
    this._isProcessAlive = options.isProcessAlive ?? null;
    this.probeLivenessFn = options.probeLivenessFn ?? null;
    this.getProviderActivityFn = options.getProviderActivityFn ?? null;
    this.getProviderRetentionFn = options.getProviderRetentionFn ?? null;
    this.refreshPromptCacheFn = options.refreshPromptCacheFn ?? null;
    this.isAutomationPausedFn = options.isAutomationPaused ?? (() => false);
    this.providerRuntimeStatus = options.initialProviderRuntimeStatus ?? null;
    this._recapMode =
      options.recapMode ?? (options.recapsEnabled ? "side-session" : "off");
    this._recapAfterSeconds = normalizeRecapAfterSeconds(
      options.recapAfterSeconds ?? DEFAULT_RECAP_AFTER_SECONDS,
    );
    this._promptSuggestionMode = options.promptSuggestionMode ?? "off";
    this._helperSideModel =
      options.helperSideModel ?? HELPER_SIDE_MODEL_CHEAPEST;
    this._lastMessageTime = new Date();
    this._lastProviderMessageTime = null;
    this._lastStateChangeTime = this.startedAt;

    // Exit promise resolves when the CLI process fully terminates
    this._exitPromise = new Promise((resolve) => {
      this._exitResolve = resolve;
    });
    this.providerSessionIdSettlement = new Promise((resolve, reject) => {
      this.resolveProviderSessionIdSettlement = resolve;
      this.rejectProviderSessionIdSettlement = reject;
    });
    void this.providerSessionIdSettlement.catch(() => undefined);

    const viewerLifecycleOptions: ProcessViewerLifecycleOptions = {
      processId: this.id,
      projectId: this.projectId,
      getSessionId: () => this._sessionId,
      startedAt: this.startedAt,
      initialState: this._state,
      idleTimeoutMs: options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS,
      shouldRetainIdleProcess: options.shouldRetainIdleProcess,
      hasPromptCacheKeepaliveLease: () =>
        this.hasPromptCacheKeepaliveLease() && !this.isAutomationPausedFn(),
      getProviderRetention: () => this.getProviderRetentionSnapshot(),
      getLivenessSnapshot: () => this.getLivenessSnapshot(),
      getLiveDeltaSubscriberCount: () => this.liveDeltaSubscriberCount,
      getRuntimeUnviewedSince: options.getRuntimeUnviewedSinceFn,
      setRuntimeViewerPresence: options.setRuntimeViewerPresenceFn,
      onIdleReap: () => this.handleIdleReap(),
    };
    this.viewerLifecycle = new ProcessViewerLifecycle(viewerLifecycleOptions);

    // Start bucket swap timer for bounded message history
    this.startBucketSwapTimer();

    this.unsubscribeMessageQueueYielded = this.messageQueue?.subscribeYielded?.(
      (messages) => {
        const turnKind = messages.some(
          (message) =>
            !isHiddenInjectedMessage(message) &&
            message.automaticSource === undefined &&
            message.metadata?.serverReceivedAt !== undefined,
        )
          ? "human"
          : messages.some(
                (message) =>
                  !isHiddenInjectedMessage(message) &&
                  message.automaticSource !== undefined,
              )
            ? "automatic"
            : undefined;
        if (turnKind) {
          this.emit({
            type: "provider-turn-started",
            startedAtMs: Date.now(),
            turnKind,
          });
        }
      },
    );

    // Start processing messages from the SDK
    this.processMessages();
  }

  /**
   * Start the timer that swaps message buckets.
   * This bounds memory by discarding messages older than ~30 seconds.
   */
  private startBucketSwapTimer(): void {
    this.bucketSwapTimer = setInterval(() => {
      this.previousBucket = this.currentBucket;
      this.currentBucket = [];
    }, Process.BUCKET_SWAP_INTERVAL_MS);
  }

  /**
   * Stop the bucket swap timer.
   */
  private stopBucketSwapTimer(): void {
    if (this.bucketSwapTimer) {
      clearInterval(this.bucketSwapTimer);
      this.bucketSwapTimer = null;
    }
  }

  get sessionId(): string {
    return this._sessionId;
  }

  /**
   * The actual model used by the API, extracted from the first assistant message.
   * Falls back to the requested model if no assistant message has been received yet.
   */
  get resolvedModel(): string | undefined {
    if (this._resolvedModel === null) {
      return undefined;
    }
    return this._resolvedModel ?? this.model;
  }

  /**
   * Current requested YA model id (launch alias, following model switches),
   * the key for per-model settings. Distinct from `resolvedModel` (reported).
   */
  get requestedModel(): string | undefined {
    if (this._requestedModel === null) {
      return undefined;
    }
    return this._requestedModel ?? this.model;
  }

  /** Context window size reported by SDK (from result message modelUsage) */
  get contextWindow(): number | undefined {
    return this._contextWindow;
  }

  get assistantActivityVersion(): number {
    return this._assistantActivityVersion;
  }

  get inputIntentVersion(): number {
    return this._inputIntentVersion;
  }

  noteInputIntent(): void {
    this._inputIntentVersion += 1;
  }

  get userTurnVersion(): number {
    return this._userTurnVersion;
  }

  get state(): ProcessState {
    return this._state;
  }

  /** When the last SDK message was received (for staleness detection) */
  get lastMessageTime(): Date {
    return this._lastMessageTime;
  }

  /** Last real provider message, or null before this Process observes one. */
  get lastProviderMessageTime(): Date | null {
    return this._lastProviderMessageTime;
  }

  get lastPromptCacheRefreshTime(): Date | null {
    return this.lastPromptCacheKeepaliveAt;
  }

  /**
   * Check if the underlying CLI process is still alive.
   * Returns true if alive, false if dead, undefined if liveness check is unavailable.
   */
  get isProcessAlive(): boolean | undefined {
    return this._isProcessAlive?.();
  }

  get canProbeLiveness(): boolean {
    return this.probeLivenessFn !== null;
  }

  get canSteer(): boolean {
    return this.steerFn !== null;
  }

  get lastLivenessProbe(): LivenessProbeResult | null {
    return this._lastLivenessProbe;
  }

  get liveness(): SessionLivenessSnapshot {
    return this.getLivenessSnapshot();
  }

  get recapMode(): RecapMode {
    return this._recapMode;
  }

  get recapAfterSeconds(): number {
    return this._recapAfterSeconds;
  }

  get isRecapPausedUntilUserTurn(): boolean {
    return this.recapPausedUntilUserTurn;
  }

  pauseRecapsUntilUserTurn(): void {
    this.recapPausedUntilUserTurn = true;
    this.pendingRecapRequest = null;
  }

  get helperSideModel(): string {
    return this._helperSideModel;
  }

  get promptSuggestionMode(): PromptSuggestionMode {
    return this._promptSuggestionMode;
  }

  setRecapConfig(config: {
    recapMode?: RecapMode;
    recapAfterSeconds?: number;
    helperSideModel?: string;
  }): void {
    if (config.recapMode !== undefined) {
      this._recapMode = config.recapMode;
    }
    if (config.recapAfterSeconds !== undefined) {
      this._recapAfterSeconds = normalizeRecapAfterSeconds(
        config.recapAfterSeconds,
      );
    }
    if (config.helperSideModel !== undefined) {
      this._helperSideModel =
        config.helperSideModel || HELPER_SIDE_MODEL_CHEAPEST;
    }
  }

  /** OS PID of the spawned agent child process */
  get pid(): number | undefined {
    const resolved =
      typeof this._pidResolver === "function"
        ? this._pidResolver()
        : this._pidResolver;
    if (resolved !== undefined) {
      this._lastKnownPid = resolved;
    }
    return resolved ?? this._lastKnownPid;
  }

  get queueDepth(): number {
    if (this.messageQueue) {
      return this.messageQueue.depth;
    }
    return this.legacyQueue.length;
  }

  private get deferredQueueDepth(): number {
    return this.deferredQueue.length + this.pendingYaCommands.length;
  }

  hasPatientDeferredMessages(): boolean {
    return this.deferredQueue.some((entry) =>
      usesPatientDeliveryPath(entry, this.provider),
    );
  }

  hasVolatileDeferredMessages(): boolean {
    return this.deferredQueue.some((entry) => !hasPatientQueueIntent(entry));
  }

  async waitForPatientQueuePersistenceIdle(): Promise<void> {
    await this.patientQueuePersistenceTail;
  }

  getLivenessSnapshot(now = new Date()): SessionLivenessSnapshot {
    const providerActivity = this.getProviderActivityFn?.();
    const providerRetention = this.getProviderRetentionSnapshot();
    return buildSessionLivenessSnapshot({
      provider: this.provider,
      state: this.toLivenessState(),
      startedAt: this.startedAt,
      lastStateChangeAt: this._lastStateChangeTime,
      lastProviderMessageAt: this._lastProviderMessageTime,
      lastRawProviderEventAt: providerActivity?.lastRawProviderEventAt ?? null,
      lastRawProviderEventSource:
        providerActivity?.lastRawProviderEventSource ?? null,
      lastLivenessProbe: this._lastLivenessProbe,
      processAlive: this.isProcessAlive,
      providerRetention,
      lastWakeReason: this.lastWakeReason,
      queueDepth: this.queueDepth,
      deferredQueueDepth: this.deferredQueueDepth,
      now,
    });
  }

  private getProviderRetentionSnapshot(): ProviderRetentionSnapshot {
    return (
      this.getProviderRetentionFn?.() ?? {
        retained: false,
        reasons: [],
      }
    );
  }

  /**
   * True when the process has settled to idle but the provider is still keeping
   * background work alive (background tasks / session crons). Such a session is
   * genuinely active — the liveness snapshot reports it as
   * "verified-waiting-provider" — so inbox/sidebar surfaces should treat it as
   * "in-turn" rather than idle.
   */
  isRetainingProviderWork(): boolean {
    return (
      this._state.type === "idle" &&
      this.getProviderRetentionSnapshot().retained
    );
  }

  handleProviderRetentionChanged(): void {
    this.emit({ type: "liveness-update" });
    this.viewerLifecycle.retentionChanged();
  }

  supportsPromptCacheKeepalive(): boolean {
    return this.refreshPromptCacheFn !== null;
  }

  registerPromptCacheKeepaliveLease(
    lease: PromptCacheKeepaliveLease,
  ): () => void {
    if (!this.refreshPromptCacheFn) {
      return () => {};
    }
    const leaseId = randomUUID();
    this.promptCacheKeepaliveLeases.set(leaseId, lease);
    this.schedulePromptCacheKeepalive();
    return () => {
      this.promptCacheKeepaliveLeases.delete(leaseId);
      if (this.promptCacheKeepaliveLeases.size === 0) {
        this.clearPromptCacheKeepaliveTimer();
        this.viewerLifecycle.retentionChanged();
      } else {
        this.schedulePromptCacheKeepalive();
      }
    };
  }

  private hasPromptCacheKeepaliveLease(): boolean {
    return this.promptCacheKeepaliveLeases.size > 0;
  }

  private resolvePromptCacheKeepaliveInactivityMs(): number | null {
    let resolved: number | null = null;
    for (const lease of this.promptCacheKeepaliveLeases.values()) {
      const value = lease.getInactivityMs();
      if (value === null || !Number.isFinite(value) || value <= 0) {
        continue;
      }
      resolved = resolved === null ? value : Math.min(resolved, value);
    }
    return resolved;
  }

  private schedulePromptCacheKeepalive(): void {
    this.clearPromptCacheKeepaliveTimer();
    if (
      !this.refreshPromptCacheFn ||
      this.promptCacheKeepaliveLeases.size === 0 ||
      this.isAutomationPausedFn() ||
      this._state.type === "terminated"
    ) {
      return;
    }

    const inactivityMs = this.resolvePromptCacheKeepaliveInactivityMs();
    if (inactivityMs === null) {
      return;
    }

    const now = Date.now();
    const dueInMs = this.getPromptCacheKeepaliveDueInMs(now, inactivityMs);
    const timer = setTimeout(
      () => {
        this.promptCacheKeepaliveTimer = null;
        void this.runPromptCacheKeepalive();
      },
      Math.max(PROMPT_CACHE_KEEPALIVE_MIN_DELAY_MS, dueInMs),
    );
    timer.unref?.();
    this.promptCacheKeepaliveTimer = timer;
  }

  private getPromptCacheKeepaliveDueInMs(
    now: number,
    inactivityMs: number,
  ): number {
    if (this._state.type !== "idle" || this.queueDepth > 0) {
      return PROMPT_CACHE_KEEPALIVE_RECHECK_MS;
    }
    if (this.isProcessAlive === false) {
      return PROMPT_CACHE_KEEPALIVE_RECHECK_MS;
    }

    const liveness = this.getLivenessSnapshot(new Date(now));
    if (liveness.derivedStatus !== "verified-idle") {
      return PROMPT_CACHE_KEEPALIVE_RECHECK_MS;
    }

    const candidates = [
      this._state.since.getTime(),
      this.lastPromptCacheKeepaliveAt?.getTime() ?? null,
      parseIsoMs(liveness.lastProviderMessageAt),
      parseIsoMs(liveness.lastRawProviderEventAt),
    ].filter((value): value is number => value !== null);
    const anchorMs =
      candidates.length > 0
        ? Math.max(...candidates)
        : this.startedAt.getTime();
    return Math.max(0, anchorMs + inactivityMs - now);
  }

  private async runPromptCacheKeepalive(): Promise<void> {
    if (this.isAutomationPausedFn()) {
      this.clearPromptCacheKeepaliveTimer();
      return;
    }
    if (this.promptCacheKeepaliveInFlight) {
      this.schedulePromptCacheKeepalive();
      return;
    }
    const inactivityMs = this.resolvePromptCacheKeepaliveInactivityMs();
    if (
      !this.refreshPromptCacheFn ||
      inactivityMs === null ||
      this.promptCacheKeepaliveLeases.size === 0
    ) {
      return;
    }

    const now = Date.now();
    if (this.getPromptCacheKeepaliveDueInMs(now, inactivityMs) > 0) {
      this.schedulePromptCacheKeepalive();
      return;
    }

    const log = getLogger();
    this.promptCacheKeepaliveInFlight = true;
    try {
      const result = await this.refreshPromptCacheFn({
        sessionId: this._sessionId,
      });
      if (result.refreshed) {
        this.lastPromptCacheKeepaliveAt = new Date();
        log.info(
          {
            event: "prompt_cache_keepalive_refreshed",
            sessionId: this._sessionId,
            processId: this.id,
            projectId: this.projectId,
            provider: this.provider,
            mode: result.mode,
            inactivityMinutes: Math.round(inactivityMs / 60_000),
            usage: result.usage,
          },
          `Prompt-cache keepalive refreshed: ${this._sessionId}`,
        );
      } else {
        log.warn(
          {
            event: "prompt_cache_keepalive_noop",
            sessionId: this._sessionId,
            processId: this.id,
            projectId: this.projectId,
            provider: this.provider,
            mode: result.mode,
            detail: result.detail,
          },
          `Prompt-cache keepalive did not refresh: ${this._sessionId}`,
        );
      }
    } catch (error) {
      log.warn(
        {
          event: "prompt_cache_keepalive_failed",
          sessionId: this._sessionId,
          processId: this.id,
          projectId: this.projectId,
          provider: this.provider,
          error: error instanceof Error ? error.message : String(error),
        },
        `Prompt-cache keepalive failed: ${this._sessionId}`,
      );
    } finally {
      this.promptCacheKeepaliveInFlight = false;
      this.schedulePromptCacheKeepalive();
    }
  }

  handleAutomationPauseChanged(): void {
    this.clearPromptCacheKeepaliveTimer();
    this.viewerLifecycle.retentionChanged();
    if (!this.isAutomationPausedFn()) {
      this.schedulePromptCacheKeepalive();
    }
  }

  private recordWakeReason(
    reason: SessionWakeReason,
    message?: SDKMessage,
    at = new Date(),
  ): void {
    this.lastWakeReason = {
      at: at.toISOString(),
      fromState: this._state.type,
      reason,
      ...(message ? { messageType: message.type } : {}),
      ...(message && getSdkMessageSubtype(message)
        ? { messageSubtype: getSdkMessageSubtype(message) }
        : {}),
    };
  }

  private transitionToInTurnForWake(
    reason: SessionWakeReason,
    message?: SDKMessage,
    at?: Date,
  ): void {
    if (this._state.type === "in-turn") {
      return;
    }
    this.recordWakeReason(reason, message, at);
    this.setState({ type: "in-turn" });
  }

  private promoteIdleForProviderWork(
    message: SDKMessage,
    receivedAt: Date,
  ): void {
    if (this._state.type !== "idle" || !isProviderWorkWakeMessage(message)) {
      return;
    }
    this.transitionToInTurnForWake(
      "provider-message-after-idle",
      message,
      receivedAt,
    );
  }

  private observeProviderRuntimeStatus(
    message: SDKMessage,
    receivedAt: Date,
  ): void {
    if (isClaudeSdkApiRetryMessage(this.provider, message)) {
      this.setProviderRuntimeStatus(
        buildClaudeApiRetryStatus(
          this.provider,
          this.providerRuntimeStatus,
          message,
          receivedAt,
        ),
      );
      return;
    }

    const claudeCompactionQuotaStatus = buildClaudeGatewayCompactionQuotaStatus(
      this.provider,
      message,
      receivedAt,
    );
    if (claudeCompactionQuotaStatus) {
      this.setProviderRuntimeStatus(claudeCompactionQuotaStatus);
      return;
    }

    const claudeTerminalStatus = buildClaudeApiTerminalStatus(
      this.provider,
      message,
      receivedAt,
    );
    if (claudeTerminalStatus) {
      this.setProviderRuntimeStatus(claudeTerminalStatus);
      return;
    }

    const codexRetryStatus = buildCodexRetryStatus(
      this.provider,
      this.providerRuntimeStatus,
      message,
      receivedAt,
    );
    if (codexRetryStatus) {
      this.setProviderRuntimeStatus(codexRetryStatus);
      return;
    }

    const terminalStatus = buildCodexTerminalStatus(
      this.provider,
      message,
      receivedAt,
    );
    if (terminalStatus) {
      this.setProviderRuntimeStatus(terminalStatus);
      return;
    }

    if (message.type === "user") {
      this.clearProviderRuntimeStatus();
      return;
    }

    if (
      isProviderRuntimeProgressMessage(message) &&
      this.providerRuntimeStatus?.kind === "retrying"
    ) {
      this.clearProviderRuntimeStatus();
    }
  }

  private setProviderRuntimeStatus(status: ProviderRuntimeStatus): void {
    if (providerRuntimeStatusesEqual(this.providerRuntimeStatus, status)) {
      return;
    }
    this.providerRuntimeStatus = status;
    this.emit({ type: "provider-runtime-status-change", status });
  }

  private clearProviderRuntimeStatus(): void {
    this.setProviderRuntimeStatus(null);
  }

  private clearRetryingProviderRuntimeStatus(): void {
    if (this.providerRuntimeStatus?.kind === "retrying") {
      this.clearProviderRuntimeStatus();
    }
  }

  private toLivenessState(): LivenessProcessState {
    switch (this._state.type) {
      case "waiting-input":
        return { type: "waiting-input" };
      case "terminated":
        return { type: "terminated", reason: this._state.reason };
      default:
        return this._state;
    }
  }

  async probeLiveness(): Promise<LivenessProbeResult | null> {
    if (!this.probeLivenessFn) {
      return null;
    }
    if (this._livenessProbeInFlight) {
      return await this._livenessProbeInFlight;
    }

    this._livenessProbeInFlight = this.runLivenessProbe();
    try {
      return await this._livenessProbeInFlight;
    } finally {
      this._livenessProbeInFlight = null;
    }
  }

  private async runLivenessProbe(): Promise<LivenessProbeResult> {
    const checkedAt = new Date();
    let result: ProviderLivenessProbeResult;
    try {
      if (!this.probeLivenessFn) {
        result = {
          status: "unavailable",
          source: "process",
          detail: "No provider liveness probe is available",
          checkedAt,
        };
      } else {
        result = await this.probeLivenessFn();
      }
    } catch (error) {
      result = {
        status: "error",
        source: `${this.provider}:probe`,
        detail: error instanceof Error ? error.message : String(error),
        checkedAt,
      };
    }

    const record: LivenessProbeResult = {
      checkedAt: result.checkedAt ?? checkedAt,
      status: result.status,
      source: result.source,
      ...(result.detail ? { detail: result.detail } : {}),
    };
    this._lastLivenessProbe = record;
    this.emit({ type: "liveness-update" });
    return record;
  }

  get permissionMode(): PermissionMode {
    return this._permissionMode;
  }

  get appliedPermissionMode(): PermissionMode | undefined {
    return this._appliedPermissionMode;
  }

  get permissions(): PermissionRules | undefined {
    return this._permissions;
  }

  get modeVersion(): number {
    return this._modeVersion;
  }

  /**
   * Thinking configuration for this process.
   * undefined means thinking is disabled.
   */
  get thinking(): ThinkingConfig | undefined {
    return this._thinking;
  }

  /**
   * Selected effort for subsequent responses. While a provider turn is active,
   * this reflects the queued next-turn selection before the provider control
   * request is applied at the turn boundary.
   */
  get effort(): EffortLevel | undefined {
    return this.pendingEffortUpdate
      ? this.pendingEffortUpdate.effort
      : this._effort;
  }

  /** Effort already accepted by the provider, excluding a queued next turn. */
  get appliedEffort(): EffortLevel | undefined {
    return this._effort;
  }

  /**
   * Update thinking config and effort after a dynamic change.
   */
  updateThinkingConfig(thinking?: ThinkingConfig, effort?: EffortLevel): void {
    this._thinking = thinking;
    this._effort = effort;
    this.emit({ type: "configuration-applied", setting: "thinking" });
  }

  /**
   * Whether this process supports dynamic thinking mode changes.
   * Only Claude SDK 0.2.7+ supports this.
   */
  get supportsThinkingModeChange(): boolean {
    return this.setMaxThinkingTokensFn !== null;
  }

  /** Whether this process can change effort without being restarted. */
  get supportsEffortChange(): boolean {
    return this.setEffortFn !== null;
  }

  /**
   * Whether this process supports graceful interrupt.
   * Only Claude SDK 0.2.7+ supports this.
   */
  get supportsInterrupt(): boolean {
    return this.interruptFn !== null;
  }

  /**
   * Interrupt the current turn gracefully without killing the process.
   * The query will stop processing the current turn and return control.
   * Only supported by Claude SDK 0.2.7+.
   *
   * @returns true if the interrupt was triggered, false if not supported
   */
  async interrupt(options?: {
    extraMessages?: UserMessage[];
    preamble?: string;
    beforeQueueDrain?: () => Promise<void>;
  }): Promise<boolean> {
    if (!this.interruptFn) {
      return false;
    }

    const log = getLogger();
    log.info(
      {
        event: "process_interrupt",
        sessionId: this._sessionId,
        processId: this.id,
        projectId: this.projectId,
        currentState: this._state.type,
      },
      `Interrupting process: ${this._sessionId}`,
    );

    const interrupted = await this.interruptFn();

    if (interrupted !== false) {
      await options?.beforeQueueDrain?.();
      this.resolvePendingToolApprovals({
        message: "Operation interrupted",
        interrupt: true,
      });
      if (this._state.type === "waiting-input") {
        this.transitionToInTurnForWake("tool-approval-resolved");
      }
    }

    // After interrupt, drain all queued messages (direct + deferred) and deliver
    // as a single concatenated batch with the interrupt preamble so the agent
    // knows to treat prior work as resumable.
    if (interrupted !== false && this.messageQueue) {
      const directDrained = this.messageQueue.drainAsync
        ? await this.messageQueue.drainAsync()
        : this.messageQueue.drain();
      const deferredEntries = this.deferredQueue;
      const deferredDrained = deferredEntries.map((e) => e.message);
      this.deferredQueue = [];
      this.deletePersistedPatientDeferredEntries(deferredEntries, "promoted");
      this.emitDeferredQueueChange("promoted");

      const all = [
        ...directDrained,
        ...deferredDrained,
        ...(options?.extraMessages ?? []),
      ];
      if (all.length > 0) {
        const combined = this.concatMessages(all, {
          interrupted: true,
          preamble: options?.preamble,
        });
        this.queueMessage(combined, { allowSteer: false });
      }
    }

    return interrupted !== false;
  }

  /**
   * Change thinking mode at runtime via the deprecated setMaxThinkingTokens API.
   * On Opus 4.6+, 0 = disabled, any non-zero = adaptive.
   * Only supported by Claude SDK 0.2.7+.
   *
   * @param tokens - Non-zero to enable adaptive thinking, undefined/0 to disable
   * @returns true if the change was applied, false if not supported
   */
  async setMaxThinkingTokens(tokens: number | undefined): Promise<boolean> {
    if (!this.setMaxThinkingTokensFn) {
      return false;
    }

    const log = getLogger();
    log.info(
      {
        event: "thinking_mode_change",
        sessionId: this._sessionId,
        processId: this.id,
        oldThinking: this._thinking?.type,
        newThinking: tokens ? "adaptive" : "disabled",
      },
      `Changing thinking mode: ${this._thinking?.type ?? "disabled"} → ${tokens ? "adaptive" : "disabled"}`,
    );

    // SDK uses null to disable, we use undefined for consistency with our types
    await this.setMaxThinkingTokensFn(tokens ?? null);
    return true;
  }

  /**
   * Select a new effort without interrupting provider work. Providers with an
   * active-turn settings control apply it immediately; other active or waiting
   * processes hold the latest choice until the provider reports the boundary.
   */
  async setEffort(effort?: EffortLevel): Promise<boolean> {
    if (!this.setEffortFn) {
      return false;
    }

    this.pendingEffortUpdate = { effort };
    const canDeferUntilBoundary =
      (this._state.type === "in-turn" ||
        this._state.type === "waiting-input") &&
      !this.effortBoundaryBlocked;
    if (canDeferUntilBoundary && !this.effortUpdatesActiveTurn) {
      getLogger().info(
        {
          event: "effort_change_queued",
          sessionId: this._sessionId,
          processId: this.id,
          oldEffort: this._effort,
          newEffort: effort,
        },
        `Queued effort change: ${this._effort ?? "default"} → ${effort ?? "default"}`,
      );
      return true;
    }

    if (this.effortBoundaryBlocked) {
      await this.completeEffortBoundaryTransition();
    } else {
      try {
        await this.enqueuePendingEffortApplication();
      } catch (error) {
        if (!canDeferUntilBoundary || this.isTerminated) throw error;
        getLogger().info(
          {
            event: "effort_change_deferred_after_live_failure",
            sessionId: this._sessionId,
            processId: this.id,
            effort,
            err: error,
          },
          "Retained effort selection for the turn boundary after live update failed",
        );
      }
    }
    return true;
  }

  private async applyEffort(effort?: EffortLevel): Promise<void> {
    if (!this.setEffortFn) {
      throw new Error("Provider does not support dynamic effort changes");
    }

    getLogger().info(
      {
        event: "effort_change",
        sessionId: this._sessionId,
        processId: this.id,
        oldEffort: this._effort,
        newEffort: effort,
      },
      `Changing effort: ${this._effort ?? "default"} → ${effort ?? "default"}`,
    );
    await this.setEffortFn(effort);
    this._effort = effort;
    this.emit({ type: "configuration-applied", setting: "effort" });
  }

  private async applyPendingEffort(): Promise<void> {
    while (this.pendingEffortUpdate) {
      const pending = this.pendingEffortUpdate;
      try {
        await this.applyEffort(pending.effort);
      } catch (error) {
        if (this.pendingEffortUpdate !== pending) {
          continue;
        }
        throw new Error("Failed to apply queued effort change", {
          cause: error,
        });
      }
      if (this.pendingEffortUpdate === pending) {
        this.pendingEffortUpdate = null;
      }
    }
  }

  private enqueuePendingEffortApplication(): Promise<void> {
    const application = this.effortApplyTail.then(() =>
      this.applyPendingEffort(),
    );
    this.effortApplyTail = application.catch(() => {});
    return application;
  }

  private completeEffortBoundaryTransition(): Promise<void> {
    if (this.effortBoundaryTransition) {
      return this.effortBoundaryTransition;
    }
    const transition = this.enqueuePendingEffortApplication().then(() => {
      this.effortBoundaryBlocked = false;
      this.finishTransitionToIdle();
    });
    this.effortBoundaryTransition = transition;
    void transition.then(
      () => {
        if (this.effortBoundaryTransition === transition) {
          this.effortBoundaryTransition = null;
        }
      },
      () => {
        if (this.effortBoundaryTransition === transition) {
          this.effortBoundaryTransition = null;
        }
      },
    );
    return transition;
  }

  /**
   * Whether this process supports dynamic model listing.
   * Only Claude SDK 0.2.7+ supports this.
   */
  get supportsDynamicModels(): boolean {
    return this.supportedModelsFn !== null;
  }

  /**
   * Whether this process supports dynamic command listing.
   * Only Claude SDK 0.2.7+ supports this.
   */
  get supportsDynamicCommands(): boolean {
    return this.supportedCommandsFn !== null;
  }

  get compactAtContextPercent(): number | undefined {
    return this._compactAtContextPercent;
  }

  get compactAtContextWindow(): number | undefined {
    return this._compactAtContextWindow;
  }

  get forceYaOrchestratedCompaction(): boolean {
    return this._forceYaOrchestratedCompaction;
  }

  updateCompactThresholdSettings(options: {
    percent?: number;
    contextWindow?: number;
    forceYaOrchestratedCompaction?: boolean;
  }): void {
    this._compactAtContextPercent = options.percent;
    this._compactAtContextWindow = options.contextWindow;
    this._forceYaOrchestratedCompaction =
      options.forceYaOrchestratedCompaction === true;
  }

  /**
   * Dispatch a provider-native slash command out-of-band instead of delivering
   * it as a user turn. A provider may return local output (Codex `/status` and
   * `/usage`) or start native work (Codex `/compact`). Returns `{ handled:
   * false }` when the provider does not own the command — including every
   * provider that does not implement native dispatch (Claude, etc.) — so the
   * caller can fall back to normal message delivery.
   */
  async runProviderCommand(
    command: string,
    argument?: string,
    options?: {
      tempId?: string;
      persistOutput?: (message: DurableLocalCommandMessage) => Promise<void>;
    },
  ): Promise<ProviderCommandResult> {
    if (!this.runProviderCommandFn) {
      return { handled: false };
    }
    const result = await this.runProviderCommandFn(command, argument);
    if (result.handled && result.output) {
      const previousPublication = this.commandOutputPublication;
      let releasePublication!: () => void;
      const publication = new Promise<void>((resolve) => {
        releasePublication = resolve;
      });
      this.commandOutputPublication = publication;
      if (previousPublication) await previousPublication;
      try {
        const placementAfterMessageId =
          this._streamingMessageId ??
          this.getMessageHistory()
            .reverse()
            .find(
              (message) =>
                typeof message.uuid === "string" &&
                !message.isSynthetic &&
                (message.type === "assistant" || message.type === "user"),
            )?.uuid;
        const id = randomUUID();
        const synthetic: DurableLocalCommandMessage = {
          type: "system",
          subtype: "local_command",
          content: result.output.summary,
          ...(result.output.details ? { details: result.output.details } : {}),
          session_id: this._sessionId,
          uuid: id,
          id,
          timestamp: new Date().toISOString(),
          tempId: options?.tempId,
          ...(typeof placementAfterMessageId === "string"
            ? { placementAfterMessageId }
            : {}),
          isMeta: false,
          isSynthetic: true,
        };
        await options?.persistOutput?.(synthetic);
        this.currentBucket.push(synthetic as SDKMessage);
        this.emit({ type: "message", message: synthetic as SDKMessage });
      } finally {
        releasePublication();
        if (this.commandOutputPublication === publication)
          this.commandOutputPublication = null;
      }
    }
    return result;
  }

  get supportsNativeCommands(): boolean {
    return this.runProviderCommandFn !== null;
  }

  /**
   * Whether this process supports model switching mid-session.
   * Only Claude SDK 0.2.7+ supports this.
   */
  get supportsSetModel(): boolean {
    return this.setModelFn !== null;
  }

  /**
   * Get the list of available models from the SDK.
   * Only supported by Claude SDK 0.2.7+.
   *
   * @returns Array of available models, or null if not supported
   */
  async supportedModels(): Promise<ModelInfo[] | null> {
    if (!this.supportedModelsFn) {
      return null;
    }
    return this.supportedModelsFn();
  }

  /**
   * Get the list of available slash commands from the SDK.
   * Only supported by Claude SDK 0.2.7+.
   *
   * @returns Array of available commands, or null if not supported
   */
  async supportedCommands(): Promise<SlashCommand[] | null> {
    if (!this.supportedCommandsFn) {
      return null;
    }
    return this.primeSupportedCommands();
  }

  async primeSupportedCommands(): Promise<SlashCommand[] | null> {
    if (!this.supportedCommandsFn) {
      return null;
    }
    if (this.supportedCommandsRefreshInFlight) {
      return this.supportedCommandsRefreshInFlight;
    }

    const refresh = this.supportedCommandsFn()
      .then(async (commands) => {
        await this.onCommandsObserved?.(this.sessionId, commands);
        this.supportedCommandsCache = commands;
        return commands;
      })
      .finally(() => {
        if (this.supportedCommandsRefreshInFlight === refresh) {
          this.supportedCommandsRefreshInFlight = null;
        }
      });
    this.supportedCommandsRefreshInFlight = refresh;
    return refresh;
  }

  async primeSupportedCommandsForMessage(message: UserMessage): Promise<void> {
    if (!hasInvocationCandidate(message.text)) {
      return;
    }
    await this.primeSupportedCommands();
  }

  /**
   * Change the model mid-session without restarting.
   * Only supported by Claude SDK 0.2.7+.
   *
   * @param model - New model to use, or undefined to use default
   * @param requestedModel - Exact YA selection token retained for restoration
   * @returns true if the change was applied, false if not supported
   */
  async setModel(
    model?: string,
    requestedModel: string | null = model ?? null,
  ): Promise<boolean> {
    const setModel = this.setModelFn;
    if (!setModel) {
      return false;
    }

    const interruptsRetryingTurn =
      this._state.type === "in-turn" &&
      this.providerRuntimeStatus?.kind === "retrying";
    if (interruptsRetryingTurn && !this.interruptFn) {
      return false;
    }

    const log = getLogger();
    log.info(
      {
        event: "model_change",
        sessionId: this._sessionId,
        processId: this.id,
        oldModel: this.model,
        newModel: model,
      },
      `Changing model: ${this.model} → ${model}`,
    );

    if (interruptsRetryingTurn) {
      const interrupted = await this.interrupt({
        preamble: MODEL_SWITCH_RETRY_INTERRUPT_PREAMBLE,
        beforeQueueDrain: () => setModel(model),
      });
      if (
        !interrupted &&
        this._state.type === "in-turn" &&
        this.providerRuntimeStatus?.kind === "retrying"
      ) {
        throw new Error(
          "Provider retry could not be interrupted before changing models",
        );
      }
      this.clearRetryingProviderRuntimeStatus();
    } else {
      await setModel(model);
    }

    // Follow switches, including an explicit return to provider default.
    // The readonly `model` remains the original launch value.
    this._resolvedModel = model ?? null;
    this._requestedModel = requestedModel;
    this.emit({ type: "configuration-applied", setting: "model" });
    return true;
  }

  /**
   * Whether the process has been terminated (either manually or due to error).
   * A terminated process cannot accept new messages.
   */
  get isTerminated(): boolean {
    return this._state.type === "terminated";
  }

  /** A prior provider may still be running, so no replacement may claim this session. */
  get hasUnverifiedProviderOwnership(): boolean {
    return this.viewerLifecycle.hasUnverifiedProviderOwnership;
  }

  /**
   * Get the termination reason if the process was terminated.
   */
  get terminationReason(): string | null {
    if (this._state.type === "terminated") {
      return this._state.reason;
    }
    return null;
  }

  /**
   * Update the standing permission mode for this process.
   * Increments modeVersion, emits for multi-tab sync, and applies the selected
   * approval policy to requests already waiting for user input.
   */
  setPermissionMode(mode: PermissionMode): void {
    this._permissionMode = mode;
    this._modeVersion++;
    this.emit({ type: "mode-change", mode, version: this._modeVersion });
    this.applySelectedModeToPendingApprovals();
  }

  /**
   * Record the permission mode accepted at a provider turn boundary.
   * This intentionally remains separate from the standing selector value.
   */
  setAppliedPermissionMode(mode: PermissionMode): void {
    if (this._appliedPermissionMode === mode) {
      return;
    }
    this._appliedPermissionMode = mode;
    this.emit({ type: "mode-applied", mode });
  }

  private emitCompletion(): void {
    if (this.completionEmitted) return;
    this.completionEmitted = true;
    this.unsubscribeMessageQueueYielded?.();
    this.unsubscribeMessageQueueYielded = undefined;
    this.emit({ type: "complete" });
  }

  /**
   * Mark the process as terminated due to an error or external termination.
   * Emits a terminated event and cleans up resources.
   */
  private markTerminated(reason: string, error?: Error): void {
    if (this._state.type === "terminated") {
      return; // Already terminated
    }

    this.rejectProviderSessionId(
      error ??
        new Error(
          `Process terminated before reporting a provider session id: ${reason}`,
        ),
    );

    const log = getLogger();
    const durationMs = Date.now() - this.startedAt.getTime();
    const pendingApprovalCount = this.pendingToolApprovals.size;

    log.warn(
      {
        event: "process_terminated",
        sessionId: this._sessionId,
        processId: this.id,
        projectId: this.projectId,
        reason,
        errorMessage: error?.message,
        errorStack: error?.stack,
        durationMs,
        pendingApprovalCount,
        previousState: this._state.type,
      },
      `Process terminated: ${this._sessionId} - ${reason}`,
    );

    this.viewerLifecycle.stop();
    this.clearPromptCacheKeepaliveTimer();
    this.stopBucketSwapTimer();
    this.iteratorDone = true;
    this.clearRetryingProviderRuntimeStatus();

    this.resolvePendingToolApprovals({
      message: `Process terminated: ${reason}`,
      interrupt: true,
    });

    this.setState({ type: "terminated", reason, error });
    this.emit({ type: "terminated", reason, error });
    if (this.viewerLifecycle.hasUnverifiedProviderOwnership) return;

    this.emitCompletion();

    // Resolve exit promise so abort() callers can wait for full termination
    if (this._exitResolve) {
      this._exitResolve();
      this._exitResolve = null;
    }
  }

  private retainLifecycleTeardownFailure(reason: string, error: unknown): void {
    if (this.completionEmitted) return;
    const failure = error instanceof Error ? error : new Error(String(error));
    getLogger().error(
      {
        event: "lifecycle_teardown_failed",
        sessionId: this._sessionId,
        processId: this.id,
        projectId: this.projectId,
        reason,
        errorMessage: failure.message,
        errorStack: failure.stack,
      },
      `Provider teardown remains unverified: ${this._sessionId}`,
    );
    this.setState({ type: "terminated", reason, error: failure });
    this.emit({ type: "terminated", reason, error: failure });
  }

  /**
   * Wait for the real session ID from the SDK's init message.
   * Returns immediately if already received, or waits with a timeout.
   */
  waitForSessionId(timeoutMs = 5000): Promise<string> {
    if (this.sessionIdResolved) {
      return Promise.resolve(this._sessionId);
    }

    return new Promise((resolve) => {
      this.sessionIdResolvers.push(resolve);

      // Timeout fallback - resolve with current ID even if not updated
      setTimeout(() => {
        const index = this.sessionIdResolvers.indexOf(resolve);
        if (index >= 0) {
          this.sessionIdResolvers.splice(index, 1);
          resolve(this._sessionId);
        }
      }, timeoutMs);
    });
  }

  /**
   * Wait for provider init to report its canonical session id. The retained
   * settlement prevents a caller from missing an earlier startup failure.
   */
  waitForProviderSessionId(timeoutMs = 60_000): Promise<string> {
    return new Promise((resolve, reject) => {
      let settled = false;

      const finish = (result: { id: string } | { error: Error }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if ("id" in result) {
          resolve(result.id);
        } else {
          reject(result.error);
        }
      };

      const timeout = setTimeout(
        () =>
          finish({
            error: new Error(
              `Timed out waiting ${timeoutMs}ms for provider session id`,
            ),
          }),
        timeoutMs,
      );
      timeout.unref?.();

      void this.providerSessionIdSettlement.then(
        (id) => finish({ id }),
        (error) => finish({ error }),
      );
    });
  }

  private resolveProviderSessionId(id: string): void {
    this.resolveProviderSessionIdSettlement?.(id);
    this.resolveProviderSessionIdSettlement = null;
    this.rejectProviderSessionIdSettlement = null;
  }

  private rejectProviderSessionId(error: Error): void {
    this.rejectProviderSessionIdSettlement?.(error);
    this.resolveProviderSessionIdSettlement = null;
    this.rejectProviderSessionIdSettlement = null;
  }

  getProviderRuntimeStatus(): ProviderRuntimeStatus {
    return this.providerRuntimeStatus;
  }

  getInfo(): ProcessInfo {
    let activity: AgentActivity;
    if (this._state.type === "terminated") {
      activity = "terminated";
    } else if (this._state.type === "waiting-input") {
      activity = "waiting-input";
    } else if (this._state.type === "idle") {
      // Idle but with provider-retained background work counts as active.
      activity = this.isRetainingProviderWork() ? "in-turn" : "idle";
    } else {
      activity = "in-turn";
    }

    const info: ProcessInfo = {
      id: this.id,
      sessionId: this._sessionId,
      projectId: this.projectId,
      projectPath: this.projectPath,
      projectName: getProjectName(this.projectPath),
      sessionTitle: null, // Will be populated by Supervisor with session data
      state: activity,
      startedAt: this.startedAt.toISOString(),
      queueDepth: this.queueDepth,
      provider: this.provider,
      model: this.resolvedModel,
      // The requested YA launch alias (e.g. "opus"), distinct from the reported
      // model above. Keys per-model settings; the route enrichment fills the
      // persisted/helper fallback when this is absent (non-YA-started sessions).
      requestedModel: this.requestedModel,
      serviceTier: this.serviceTier,
      thinking: this._thinking,
      effort: this.effort,
      executor: this.executor,
      pid: this.pid,
      liveness: this.getLivenessSnapshot(),
      providerRuntimeStatus: this.providerRuntimeStatus,
      recapMode: this._recapMode,
      recapAfterSeconds: this._recapAfterSeconds,
      promptSuggestionMode: this._promptSuggestionMode,
      helperSideModel: this._helperSideModel,
      sandboxEnforcement: this.sandboxEnforcement,
    };

    // Add idleSince if idle
    if (this._state.type === "idle") {
      info.idleSince = this._state.since.toISOString();
    }

    return info;
  }

  /**
   * Get recent message history for SSE replay.
   *
   * Ordinary messages remain available for 15-30 seconds. In-turn steer
   * echoes remain available through the provider turn so a reconnect cannot
   * lose an accepted user message before its durable row exists.
   */
  getMessageHistory(): SDKMessage[] {
    const buffered = [...this.previousBucket, ...this.currentBucket];
    if (this.activeSteerEchoes.size === 0) {
      return buffered;
    }

    const bufferedUuids = new Set(
      buffered
        .map((message) => message.uuid)
        .filter((uuid): uuid is string => typeof uuid === "string"),
    );
    const expiredSteerEchoes = [...this.activeSteerEchoes.entries()]
      .filter(([uuid]) => !bufferedUuids.has(uuid))
      .map(([, message]) => message);
    return [...expiredSteerEchoes, ...buffered];
  }

  /**
   * Get accumulated streaming text for catch-up when clients connect mid-stream.
   * Returns the message ID and accumulated text, or null if not streaming.
   */
  getStreamingContent(): { messageId: string; text: string } | null {
    if (!this._streamingMessageId || !this._streamingText) {
      return null;
    }
    return {
      messageId: this._streamingMessageId,
      text: this._streamingText,
    };
  }

  /**
   * Accumulate streaming text from a delta.
   * Called by stream routes when processing stream_event messages.
   */
  accumulateStreamingText(messageId: string, text: string): void {
    if (this._streamingMessageId !== messageId) {
      // New streaming message, reset accumulator
      this._streamingMessageId = messageId;
      this._streamingText = text;
    } else {
      this._streamingText += text;
    }
  }

  /**
   * Clear streaming text accumulator (called when stream ends).
   */
  clearStreamingText(): void {
    this._streamingText = "";
    this._streamingMessageId = null;
  }

  /**
   * Push the text of a completed assistant turn into the recap buffer.
   * Per-entry length is capped so a long single turn does not dominate the
   * buffer; total entries are bounded by RECENT_TEXT_MAX_ENTRIES. See
   * topics/recaps.md.
   */
  private pushRecentAssistantText(text: string, completedAtMs: number): void {
    const trimmed = text.trim();
    if (!trimmed) {
      return;
    }
    const capped =
      trimmed.length > Process.RECENT_TEXT_MAX_CHARS_PER_ENTRY
        ? `${trimmed.slice(0, Process.RECENT_TEXT_MAX_CHARS_PER_ENTRY)} …[truncated]`
        : trimmed;
    this.recentAssistantRecapEntries.push({ completedAtMs, text: capped });
    while (
      this.recentAssistantRecapEntries.length > Process.RECENT_TEXT_MAX_ENTRIES
    ) {
      this.recentAssistantRecapEntries.shift();
    }
  }

  /**
   * Snapshot of recent assistant text used as context for a recap.
   */
  getRecentAssistantText(sinceMs?: number | null): string[] {
    return this.recentAssistantRecapEntries
      .filter(
        (entry) =>
          sinceMs === null ||
          sinceMs === undefined ||
          entry.completedAtMs > sinceMs,
      )
      .map((entry) => entry.text);
  }

  /**
   * Needle of the latest assistant output a watching client had seen:
   * the in-flight streaming text when a turn is underway, else the tail
   * of the last completed assistant turn. Visible text only — providers
   * strip prior-turn thinking from real context, so a thinking quote
   * could anchor nothing (topics/compose-time-context-anchors.md).
   */
  private lastSeenAssistantHead(): string | undefined {
    if (this._streamingText.trim()) {
      return composeSeenNeedle(this._streamingText) ?? undefined;
    }
    const lastCompleted = this.recentAssistantRecapEntries
      .at(-1)
      ?.text.replace(/ …\[truncated\]$/, "");
    if (!lastCompleted) return undefined;
    return composeSeenNeedle(lastCompleted) ?? undefined;
  }

  private recordNativeRecap(message: SDKMessage, receivedAt: Date): void {
    if (!isAwaySummaryMessage(message) || message.isSynthetic === true) {
      return;
    }
    const text = getSystemMessageText(message).trim();
    if (!text) {
      return;
    }
    this.lastNativeRecap = {
      receivedAtMs: messageTimestampMs(message) ?? receivedAt.getTime(),
      text,
      message,
    };
    for (const waiter of this.nativeRecapWaiters) {
      waiter();
    }
  }

  getNativeRecapSince(sinceMs?: number | null): NativeRecapRecord | null {
    if (!this.lastNativeRecap) {
      return null;
    }
    if (
      sinceMs !== null &&
      sinceMs !== undefined &&
      this.lastNativeRecap.receivedAtMs <= sinceMs
    ) {
      return null;
    }
    return this.lastNativeRecap;
  }

  waitForNativeRecapSince(
    sinceMs: number | null,
    timeoutMs: number,
  ): Promise<NativeRecapRecord | null> {
    const existing = this.getNativeRecapSince(sinceMs);
    if (existing || timeoutMs <= 0) {
      return Promise.resolve(existing);
    }

    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      let onNativeRecap: () => void;
      const cleanup = () => {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        this.nativeRecapWaiters.delete(onNativeRecap);
      };
      onNativeRecap = () => {
        const recap = this.getNativeRecapSince(sinceMs);
        if (!recap) {
          return;
        }
        cleanup();
        resolve(recap);
      };

      timer = setTimeout(() => {
        cleanup();
        resolve(null);
      }, timeoutMs);
      timer.unref?.();
      this.nativeRecapWaiters.add(onNativeRecap);
    });
  }

  /**
   * Emit a synthetic system message (no provider involvement) into the
   * session's broadcast stream. Used for YA-side recaps so they reach SSE
   * subscribers via the same path as provider-emitted messages, without
   * touching the underlying JSONL transcript.
   */
  emitSyntheticSystemMessage(
    subtype: "away_summary",
    content: string,
  ): DurableRecapMessage {
    const synthetic = this.withTimestamp({
      type: "system",
      subtype,
      content,
      session_id: this._sessionId,
      uuid: randomUUID(),
      isMeta: false,
      isSynthetic: true,
    } as unknown as SDKMessage);
    this.currentBucket.push(synthetic);
    this.emit({ type: "message", message: synthetic });
    const durable = toDurableRecapMessage(synthetic, "ya-synthetic");
    if (!durable) {
      throw new Error("failed to create durable synthetic recap message");
    }
    return durable;
  }

  /**
   * Run a server-side recap of recent assistant activity and emit the
   * result as a synthetic `away_summary` system message. The provider is
   * looked up by the caller (Supervisor) and passed in to keep Process
   * free of provider-registry imports. See topics/recaps.md.
   *
   * Returns shape:
   *  - `supported: false` — provider does not implement recaps.
   *  - `supported: true, emitted: false` — supported but suppressed
   *    (no recent activity, already in-flight, etc.).
   *  - `supported: true, emitted: true` — recap was generated and emitted.
   */
  async requestRecap(
    provider: AgentProvider,
    options?: { sinceMs?: number | null },
  ): Promise<RecapRequestResult> {
    if (this.recapPausedUntilUserTurn) {
      return {
        supported: true,
        emitted: false,
        reason: "recaps paused until next user turn",
      };
    }
    if (this._recapMode === "off") {
      return {
        supported: true,
        emitted: false,
        reason: "recaps disabled for this session",
      };
    }
    if (this._recapMode === "native") {
      if (!provider.supportsNativeRecaps) {
        return {
          supported: false,
          emitted: false,
          reason: "provider does not support native recaps",
        };
      }
      return {
        supported: true,
        emitted: false,
        reason: "native recaps are provider-owned",
      };
    }
    if (this._recapMode === "fork") {
      return {
        supported: true,
        emitted: false,
        reason: "forked recaps are supervisor-owned",
      };
    }
    if (!provider.supportsRecaps || !provider.generateSummary) {
      return {
        supported: false,
        emitted: false,
        reason: "provider does not support recaps",
      };
    }
    if (this.recapInFlight) {
      return {
        supported: true,
        emitted: false,
        reason: "recap already in flight",
      };
    }
    const sinceMs = options?.sinceMs ?? null;
    if (this._state.type === "in-turn") {
      this.pendingRecapRequest = { provider, sinceMs };
      return {
        supported: true,
        emitted: false,
        reason: "recap deferred until turn completes",
      };
    }

    return this.generateAndEmitRecap(provider, sinceMs);
  }

  async requestTailedRecapFallback(
    provider: AgentProvider,
    options?: { sinceMs?: number | null },
  ): Promise<RecapRequestResult> {
    if (this.recapPausedUntilUserTurn) {
      return {
        supported: true,
        emitted: false,
        reason: "recaps paused until next user turn",
      };
    }
    if (!provider.supportsRecaps || !provider.generateSummary) {
      return {
        supported: false,
        emitted: false,
        reason: "provider does not support recaps",
      };
    }

    if (this.recapInFlight) {
      return {
        supported: true,
        emitted: false,
        reason: "recap already in flight",
      };
    }

    const sinceMs = options?.sinceMs ?? null;
    if (this._state.type === "in-turn") {
      this.pendingRecapRequest = { provider, sinceMs };
      return {
        supported: true,
        emitted: false,
        reason: "recap deferred until turn completes",
      };
    }

    return this.generateAndEmitRecap(provider, sinceMs);
  }

  private async generateAndEmitRecap(
    provider: AgentProvider,
    sinceMs: number | null,
  ): Promise<RecapRequestResult> {
    if (!provider.supportsRecaps || !provider.generateSummary) {
      return {
        supported: false,
        emitted: false,
        reason: "provider does not support recaps",
      };
    }

    const nativeRecap = await this.waitForNativeRecapSince(
      sinceMs,
      provider.supportsNativeRecaps ? NATIVE_RECAP_FALLBACK_GRACE_MS : 0,
    );
    if (this.recapPausedUntilUserTurn) {
      return {
        supported: true,
        emitted: false,
        reason: "recaps paused until next user turn",
      };
    }
    if (nativeRecap) {
      return {
        supported: true,
        emitted: true,
        reason: "native recap emitted",
        text: nativeRecap.text,
      };
    }

    const recent = this.getRecentAssistantText(sinceMs);
    if (recent.length === 0) {
      return {
        supported: true,
        emitted: false,
        reason: "no recent assistant activity to summarize",
      };
    }

    this.recapInFlight = true;
    try {
      const text = (
        await provider.generateSummary({
          purpose: "recap",
          strategy: "side-session",
          recentAssistantText: recent,
          model: this.resolveHelperSideModel(),
        })
      ).text.trim();
      if (this.recapPausedUntilUserTurn) {
        return {
          supported: true,
          emitted: false,
          reason: "recaps paused until next user turn",
        };
      }
      if (!text) {
        return {
          supported: true,
          emitted: false,
          reason: "provider returned empty recap",
        };
      }
      const lateNativeRecap = this.getNativeRecapSince(sinceMs);
      if (lateNativeRecap) {
        return {
          supported: true,
          emitted: true,
          reason: "native recap emitted",
          text: lateNativeRecap.text,
        };
      }
      const syntheticMessage = this.emitSyntheticSystemMessage(
        "away_summary",
        text,
      );
      return { supported: true, emitted: true, text, syntheticMessage };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const log = getLogger();
      log.warn(
        {
          event: "session_recap_failed",
          sessionId: this._sessionId,
          processId: this.id,
          projectId: this.projectId,
          error: reason,
        },
        `Recap generation failed: ${reason}`,
      );
      return { supported: true, emitted: false, reason };
    } finally {
      this.recapInFlight = false;
    }
  }

  private resolveHelperSideModel(): string | undefined {
    if (this._helperSideModel === HELPER_SIDE_MODEL_CHEAPEST) {
      return HELPER_SIDE_MODEL_CHEAPEST;
    }
    if (this._helperSideModel === HELPER_SIDE_MODEL_SAME_AS_MAIN) {
      return this.resolvedModel;
    }
    return this._helperSideModel || undefined;
  }

  /**
   * Ensure every emitted/replayed message has a timestamp.
   * Some providers (notably Codex stream messages) omit this field.
   */
  private withTimestamp<T extends SDKMessage>(
    message: T,
  ): TimestampedSDKMessage<T> {
    if (
      typeof message.timestamp === "string" &&
      message.timestamp.trim().length > 0
    ) {
      return message as TimestampedSDKMessage<T>;
    }
    return {
      ...message,
      timestamp: new Date().toISOString(),
    } as TimestampedSDKMessage<T>;
  }

  /**
   * Add initial user message to history without queuing to SDK.
   * Used for real SDK sessions where the initial message is passed directly
   * to the SDK but needs to be in history for SSE replay to late-joining clients.
   *
   * @param message - The user message, including attachments for replay
   * @param uuid - The UUID to use (should match what was passed to SDK)
   * @param tempId - Optional client temp ID for optimistic UI tracking
   */
  addInitialUserMessage(
    message: UserMessage,
    uuid: string,
    tempId?: string,
  ): void {
    const sdkMessage = this.withTimestamp({
      type: "user",
      uuid,
      tempId,
      messageMetadata: message.metadata,
      message: { role: "user", content: this.buildUserMessageContent(message) },
    } as SDKMessage);

    this.currentBucket.push(sdkMessage);
    this.emit({ type: "message", message: sdkMessage });
  }

  /**
   * Format file size for display.
   */
  private formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes}\u202fb`;
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}\u202fkb`;
    if (bytes < 1024 * 1024 * 1024)
      return `${Math.round((bytes / (1024 * 1024)) * 10) / 10}\u202fmb`;
    return `${Math.round((bytes / (1024 * 1024 * 1024)) * 10) / 10}\u202fgb`;
  }

  private formatUploadedFileReference(file: {
    originalName: string;
    size: number;
    mimeType: string;
    path: string;
    width?: number;
    height?: number;
  }): string {
    const dimensions =
      file.width && file.height ? `, ${file.width}x${file.height}` : "";
    return `- [${file.originalName.replaceAll("[", "\\[").replaceAll("]", "\\]")}](<${file.path}>) (${this.formatSize(file.size)}, ${file.mimeType}${dimensions})`;
  }

  /**
   * Build user message content that matches what MessageQueue sends to the SDK.
   * This ensures SSE/history messages can be deduplicated against JSONL.
   */
  private buildUserMessageContent(message: UserMessage): string {
    let text = message.text;

    // Append attachment paths (same format as MessageQueue.toSDKMessage)
    if (message.attachments?.length) {
      const lines = message.attachments.map((file) =>
        this.formatUploadedFileReference(file),
      );
      text += `\n\nUser uploaded files:\n${lines.join("\n")}`;
    }

    return text;
  }

  /**
   * Concatenate multiple UserMessages into one, joined by `--------` separators.
   * Used by interrupt to deliver all queued messages as a single batch.
   */
  private concatMessages(
    messages: UserMessage[],
    options?: { interrupted?: boolean; preamble?: string },
  ): UserMessage {
    return concatUserMessages(
      messages,
      options?.preamble ??
        (options?.interrupted ? INTERRUPT_PREAMBLE : undefined),
    );
  }

  private expandEmulatedSlashCommand(message: UserMessage): UserMessage {
    return expandSlashCommandEmulation(message, this.supportedCommandsCache);
  }

  /**
   * Prefix a delivered message with a compose-time context anchor (e.g.
   * `(45s ago)`). Applied after slash-command expansion so a queued `/command`
   * is still detected; the anchor rides ahead of the expanded provider text and
   * the matching echo. No-op when `anchor` is absent — including always, by
   * default, since anchors are opt-in (YEP_COMPOSE_ANCHORS=1).
   */
  private applyComposeAnchor(
    message: UserMessage,
    anchor?: string | null,
  ): UserMessage {
    if (!anchor) return message;
    return { ...message, text: `${anchor}\n\n${message.text}` };
  }

  /**
   * Absolute compose-time marker on provider-bound user turns
   * (YEP_TURN_TIMESTAMPS=before|after; default off). Experimental: the
   * model gets a wall-clock anchor in the same ISO-8601 format as the
   * provider session jsonl; the client hides `[sent …]` in presentation.
   * Applied after slash-command expansion (same placement invariant as
   * applyComposeAnchor); "before" placement stays inside the compose
   * anchor so a leading `(Ns ago)` still opens the delivered text.
   */
  private applyTurnTimestamp(message: UserMessage): UserMessage {
    const placement = this.resolveDeferredDelivery().turnTimestamps;
    if (placement === "off") return message;
    const composedAt =
      message.metadata?.serverReceivedAt ?? new Date().toISOString();
    const marker = `[sent ${composedAt}]`;
    return {
      ...message,
      text:
        placement === "before"
          ? `${marker}\n\n${message.text}`
          : `${message.text}\n\n${marker}`,
    };
  }

  private prepareProviderMessage(
    message: UserMessage,
    composeAnchor?: string | null,
  ): UserMessage {
    const prepared = this.withProviderDeliveryPriority(
      this.applyComposeAnchor(
        this.applyTurnTimestamp(this.expandEmulatedSlashCommand(message)),
        composeAnchor,
      ),
    );
    return {
      ...prepared,
      mode: prepared.mode ?? this._permissionMode,
    };
  }

  private withProviderDeliveryPriority(message: UserMessage): UserMessage {
    if (!isClaudeProviderName(this.provider)) {
      return message;
    }

    const deliveryIntent = message.metadata?.deliveryIntent;
    if (deliveryIntent === "steer") {
      return {
        ...message,
        priority: message.metadata?.steerNow ? "now" : "next",
      };
    }
    if (deliveryIntent === "deferred" || deliveryIntent === "patient") {
      return { ...message, priority: "later" };
    }
    return message;
  }

  private inputRejectionError(): string | null {
    if (this.viewerLifecycle.isDetachingForServerReload) {
      return "Process is detaching for server reload";
    }
    if (this.viewerLifecycle.hasUnverifiedProviderOwnership) {
      return "Process provider teardown is in progress or unverified";
    }
    if (this._state.type === "terminated") {
      return `Process terminated: ${this._state.reason}`;
    }
    if (this.transportFailed) {
      return "Process transport failed";
    }
    return null;
  }

  private acceptRecapResumeSignal(message: UserMessage): UserMessage {
    if (message.recapResumeHandled === true) {
      return message;
    }

    if (
      !isHiddenInjectedMessage(message) &&
      message.automaticSource === undefined &&
      message.metadata?.serverReceivedAt !== undefined
    ) {
      const receivedAtMs = Date.parse(message.metadata.serverReceivedAt);
      this._userTurnVersion += 1;
      this.resumeRecapsAfterUserTurn();
      this.emit({
        type: "user-turn-accepted",
        startedAtMs: Number.isFinite(receivedAtMs) ? receivedAtMs : Date.now(),
      });
    }
    return { ...message, recapResumeHandled: true };
  }

  resumeRecapsAfterUserTurn(): void {
    this.recapPausedUntilUserTurn = false;
  }

  /**
   * Queue already-expanded provider text. The emitted user echo and the SDK
   * queue entry must be the same logical turn so live SSE and later transcript
   * catch-up deduplicate cleanly.
   */
  private queuePreparedMessage(
    providerMessage: UserMessage,
    options?: { allowSteer?: boolean },
  ): {
    success: boolean;
    position?: number;
    error?: string;
  } {
    const inputError = this.inputRejectionError();
    if (inputError) {
      return { success: false, error: inputError };
    }

    // Create user message with UUID - this UUID will be used by both SSE and SDK
    const uuid = providerMessage.uuid ?? randomUUID();
    const messageWithUuid: UserMessage = { ...providerMessage, uuid };

    // Build content that matches what the SDK will write to JSONL.
    // This ensures SSE/history messages can be deduplicated against JSONL.
    const content = this.buildUserMessageContent(providerMessage);

    const sdkMessage = this.withTimestamp({
      type: "user",
      uuid,
      tempId: providerMessage.tempId,
      // Carry every bundled chunk id so the client clears all delivered queued
      // chips by identity (a merged turn keeps only first.tempId otherwise).
      ...(providerMessage.tempIds?.length
        ? { tempIds: providerMessage.tempIds }
        : {}),
      messageMetadata: providerMessage.metadata,
      message: { role: "user", content },
    } as SDKMessage);

    // YA-injected control messages (e.g. the `/compact` we queue for
    // compaction) carry no user echo — native auto-compaction shows none.
    const hidden = isHiddenInjectedMessage(providerMessage);

    // Add to history for SSE replay to late-joining clients.
    // The client-side deduplication (mergeSSEMessage, mergeJSONLMessages) handles
    // any duplicates when JSONL is later fetched. This is especially important
    // for the two-phase flow (createSession + queueMessage) where the client
    // may connect before the JSONL is written.
    if (!hidden && shouldEmitMessage(sdkMessage)) {
      // Check for duplicates in both buckets before adding
      // This prevents duplicates if the provider echoes the message back with the same UUID
      const isDuplicate =
        this.currentBucket.some((m) => m.uuid && m.uuid === sdkMessage.uuid) ||
        this.previousBucket.some((m) => m.uuid && m.uuid === sdkMessage.uuid);
      if (!isDuplicate) {
        this.currentBucket.push(sdkMessage);
      }
    }

    // Emit to current SSE subscribers so other clients see it immediately
    // Include the session ID so client can associate it correctly
    // The provider will echo this message back, but if we ensure UUIDs match,
    // the client will merge them.
    if (!hidden && shouldEmitMessage(sdkMessage)) {
      this.emit({
        type: "message",
        message: { ...sdkMessage, session_id: this._sessionId },
      });
    }

    if (this.messageQueue) {
      // If provider supports in-turn steering, prefer that over queue-after-turn behavior.
      if (
        this._state.type === "in-turn" &&
        this.steerFn &&
        options?.allowSteer !== false
      ) {
        if (!hidden && shouldEmitMessage(sdkMessage)) {
          this.activeSteerEchoes.set(uuid, sdkMessage);
        }
        const steerMessage: UserMessage = {
          ...messageWithUuid,
          // Mirror MessageQueue's attachment expansion for steer payloads.
          text: content,
          attachments: undefined,
        };
        void this.steerFn(steerMessage)
          .then((steered) => {
            if (!steered) {
              this.messageQueue?.push(messageWithUuid);
            }
          })
          .catch((error) => {
            const log = getLogger();
            log.warn(
              {
                event: "process_steer_failed",
                sessionId: this._sessionId,
                processId: this.id,
                provider: this.provider,
                error: error instanceof Error ? error.message : String(error),
              },
              "Steer failed; falling back to queued message",
            );
            this.messageQueue?.push(messageWithUuid);
          });
        return { success: true, position: 0 };
      }

      // Transition to running if we were idle
      if (this._state.type === "idle") {
        this.transitionToInTurnForWake("user-message");
      }
      // Pass message with UUID so SDK uses the same UUID we emitted via SSE
      const position = this.messageQueue.push(messageWithUuid);
      return { success: true, position };
    }

    // Legacy behavior for mock SDK
    this.legacyQueue.push(providerMessage);
    if (this._state.type === "idle") {
      this.processNextInQueue();
    }
    return { success: true, position: this.legacyQueue.length };
  }

  /**
   * Queue a message to be sent to the SDK.
   * For real SDK, pushes to MessageQueue.
   * For mock SDK, uses legacy queue behavior.
   *
   * @returns Object with success status and queue position or error
   */
  queueMessage(
    message: UserMessage,
    options?: { allowSteer?: boolean; composeAnchor?: string | null },
  ): {
    success: boolean;
    position?: number;
    error?: string;
  } {
    const acceptedMessage = this.acceptRecapResumeSignal(message);
    return this.queuePreparedMessage(
      this.prepareProviderMessage(acceptedMessage, options?.composeAnchor),
      { allowSteer: options?.allowSteer },
    );
  }

  private enqueuePatientQueuePersistence(
    action: () => Promise<void>,
    context: Record<string, unknown>,
  ): void {
    this.patientQueuePersistenceTail = this.patientQueuePersistenceTail
      .then(action, action)
      .catch((error) => {
        getLogger().warn(
          {
            event: "patient_queue_persistence_failed",
            sessionId: this._sessionId,
            processId: this.id,
            projectId: this.projectId,
            ...context,
            error: error instanceof Error ? error.message : String(error),
          },
          "Failed to persist patient queued-message state",
        );
      });
  }

  private persistPatientDeferredEntry(entry: DeferredQueueEntry): void {
    if (!this.sessionQueuePersistenceService || !hasPatientQueueIntent(entry)) {
      return;
    }

    const item = this.toPersistedPatientDeferredItem(entry, "queued");
    if (!item) return;

    this.enqueuePatientQueuePersistence(
      async () => {
        await this.sessionQueuePersistenceService?.upsertItem(item);
      },
      { action: "upsert", persistedQueueId: item.id },
    );
  }

  private toPersistedPatientDeferredItem(
    entry: DeferredQueueEntry,
    status: PersistedSessionQueuedMessage["status"],
    updatedAt = entry.timestamp,
  ): PersistedSessionQueuedMessage | null {
    if (!this.sessionQueuePersistenceService || !hasPatientQueueIntent(entry)) {
      return null;
    }

    const id = entry.persistedQueueId ?? randomUUID();
    entry.persistedQueueId = id;
    const createdAt =
      entry.message.metadata?.serverReceivedAt ?? entry.timestamp;
    const source = entry.message.tempId
      ? { tempId: entry.message.tempId }
      : undefined;
    const mode = entry.message.mode ?? this._permissionMode;
    return {
      id,
      sessionId: this._sessionId,
      projectId: this.projectId,
      projectPath: this.projectPath,
      provider: this.provider,
      ...(this.executor ? { executor: this.executor } : {}),
      ...(this.requestedModel ? { model: this.requestedModel } : {}),
      ...(this.serviceTier ? { serviceTier: this.serviceTier } : {}),
      ...(mode ? { mode } : {}),
      kind: "patient",
      message: entry.message,
      createdAt,
      updatedAt,
      queuedAt: entry.timestamp,
      status,
      ...(source ? { source } : {}),
    };
  }

  private deletePersistedPatientDeferredEntries(
    entries: DeferredQueueEntry[],
    reason: "cancelled" | "promoted",
  ): void {
    if (!this.sessionQueuePersistenceService) {
      return;
    }
    const ids = entries
      .filter(hasPatientQueueIntent)
      .map((entry) => entry.persistedQueueId)
      .filter((id): id is string => Boolean(id));
    if (ids.length === 0) {
      return;
    }

    this.enqueuePatientQueuePersistence(
      async () => {
        for (const id of ids) {
          await this.sessionQueuePersistenceService?.deleteItem(id);
        }
      },
      { action: "delete", reason, persistedQueueIds: ids },
    );
  }

  async preservePatientDeferredMessagesForRestart(): Promise<number> {
    if (!this.sessionQueuePersistenceService) {
      return 0;
    }

    const entries = this.deferredQueue.filter(hasPatientQueueIntent);
    if (entries.length === 0) {
      return 0;
    }

    for (const entry of entries) {
      if (!entry.persistedQueueId) {
        this.persistPatientDeferredEntry(entry);
      }
    }

    const pausedAt = new Date().toISOString();
    const preserve = this.patientQueuePersistenceTail.then(async () => {
      for (const entry of entries) {
        const item = this.toPersistedPatientDeferredItem(
          entry,
          "paused-after-restart",
          pausedAt,
        );
        if (!item) {
          throw new Error("Failed to serialize patient queue entry");
        }
        await this.sessionQueuePersistenceService?.upsertItem(item);
      }
    });

    this.patientQueuePersistenceTail = preserve.then(
      () => undefined,
      () => undefined,
    );

    try {
      await preserve;
    } catch (error) {
      getLogger().warn(
        {
          event: "patient_queue_preserve_failed",
          sessionId: this._sessionId,
          processId: this.id,
          projectId: this.projectId,
          error: error instanceof Error ? error.message : String(error),
        },
        "Failed to preserve patient queued-message state for restart",
      );
      return 0;
    }

    const preservedEntries = new Set(entries);
    this.deferredQueue = this.deferredQueue.filter(
      (entry) => !preservedEntries.has(entry),
    );
    this.emitDeferredQueueChange();
    await this.patientQueuePersistenceTail;
    return entries.length;
  }

  /**
   * Add a message to the deferred queue.
   * Deferred messages are held server-side and auto-sent when the agent reaches
   * a safe delivery boundary. Idle processes can accept the message
   * immediately; active turns keep the message editable until a later boundary
   * such as a completed tool call or turn completion.
   */
  deferMessage(
    message: UserMessage,
    options?: {
      promoteIfReady?: boolean;
      persistedQueueId?: string;
      timestamp?: string;
    },
  ): {
    success: boolean;
    deferred: boolean;
    promoted?: boolean;
    position?: number;
    error?: string;
  } {
    const inputError = this.inputRejectionError();
    if (inputError) {
      return { success: false, deferred: false, error: inputError };
    }
    const acceptedMessage = this.acceptRecapResumeSignal(message);
    const canPromoteIfReady = !!(
      options?.promoteIfReady &&
      this.messageQueue &&
      // Only Claude waits for the verified-idle patient delivery path;
      // elsewhere durable patient intent uses ordinary deferred timing and
      // promotes immediately like any other deferred turn.
      !usesPatientDeliveryPath(
        { message: acceptedMessage, timestamp: new Date().toISOString() },
        this.provider,
      ) &&
      this._state.type === "idle"
    );
    if (canPromoteIfReady) {
      const result = this.queueMessage(acceptedMessage);
      if (!result.success) {
        return {
          deferred: false,
          success: false,
          error: result.error ?? "Failed to queue message",
        };
      }
      // A recovered entry promoted straight through never enters the
      // deferred queue, so release its durable row here; nothing else will.
      const persistedQueueId = options?.persistedQueueId;
      if (persistedQueueId) {
        this.enqueuePatientQueuePersistence(
          async () => {
            await this.sessionQueuePersistenceService?.deleteItem(
              persistedQueueId,
            );
          },
          {
            action: "delete",
            reason: "promoted",
            persistedQueueIds: [persistedQueueId],
          },
        );
      }
      this.emitDeferredQueueChange("promoted", acceptedMessage.tempId);
      return {
        success: true,
        deferred: false,
        promoted: true,
        position: result.position,
      };
    }

    const lastSeenHead = this.lastSeenAssistantHead();
    const entry: DeferredQueueEntry = {
      message: acceptedMessage,
      timestamp: options?.timestamp ?? new Date().toISOString(),
      ...(lastSeenHead ? { lastSeenHead } : {}),
      ...(options?.persistedQueueId
        ? { persistedQueueId: options.persistedQueueId }
        : {}),
    };
    this.deferredQueue.push(entry);
    this.persistPatientDeferredEntry(entry);
    this.emitDeferredQueueChange("queued", acceptedMessage.tempId);
    return { success: true, deferred: true };
  }

  /**
   * Project a YA-local command through the queued-message UI. The command is
   * deliberately separate from both deferred and patient provider input.
   */
  queueYaCommand(
    command: SessionQueuedYaCommand,
    options?: {
      content?: SyntheticSessionBoundaryCommand;
      tempId?: string;
      timestamp?: string;
      userTurnVersion?: number;
    },
  ): PendingYaCommand {
    const content: SyntheticSessionBoundaryCommand =
      options?.content ?? `/${command}`;
    const existing = this.pendingYaCommands.find(
      (entry) => entry.command === command,
    );
    if (existing) {
      if (existing.content !== content) {
        existing.content = content;
        this.emitDeferredQueueChange(
          "queued",
          existing.tempId,
          existing.command,
        );
      }
      return existing;
    }

    const entry: PendingYaCommand = {
      command,
      content,
      tempId: options?.tempId ?? `ya-${command}-${randomUUID()}`,
      timestamp: options?.timestamp ?? new Date().toISOString(),
      userTurnVersion: options?.userTurnVersion ?? this._userTurnVersion,
      completionStarted: false,
    };
    this.pendingYaCommands.push(entry);
    this.emitDeferredQueueChange("queued", entry.tempId, entry.command);
    return entry;
  }

  hasPendingYaCommand(command?: SessionQueuedYaCommand): boolean {
    return command
      ? this.pendingYaCommands.some((entry) => entry.command === command)
      : this.pendingYaCommands.length > 0;
  }

  getPendingYaCommand(
    command: SessionQueuedYaCommand,
  ): PendingYaCommand | undefined {
    return this.pendingYaCommands.find((entry) => entry.command === command);
  }

  beginPendingYaCommandCompletion(
    command: SessionQueuedYaCommand,
  ): PendingYaCommand | undefined {
    const entry = this.getPendingYaCommand(command);
    if (!entry || entry.completionStarted) {
      return undefined;
    }
    entry.completionStarted = true;
    return entry;
  }

  releasePendingYaCommandCompletion(tempId: string): void {
    const entry = this.pendingYaCommands.find(
      (candidate) => candidate.tempId === tempId,
    );
    if (entry) {
      entry.completionStarted = false;
    }
  }

  completePendingYaCommand(tempId: string): boolean {
    const index = this.pendingYaCommands.findIndex(
      (entry) => entry.tempId === tempId && entry.completionStarted,
    );
    if (index === -1) {
      return false;
    }
    const [entry] = this.pendingYaCommands.splice(index, 1);
    if (!entry) {
      return false;
    }
    this.emitDeferredQueueChange("promoted", tempId, entry.command);
    if (
      this.pendingYaCommands.length === 0 &&
      this._state.type === "idle" &&
      !this.isRetainingProviderWork()
    ) {
      this.continueAfterTurnBoundary();
    }
    return true;
  }

  /**
   * Cancel a deferred message by its tempId.
   */
  cancelDeferredMessage(tempId: string): boolean {
    const index = this.deferredQueue.findIndex(
      (entry) => entry.message.tempId === tempId,
    );
    if (index === -1) return false;
    const [removed] = this.deferredQueue.splice(index, 1);
    if (removed) {
      this.deletePersistedPatientDeferredEntries([removed], "cancelled");
    }
    this.emitDeferredQueueChange("cancelled", tempId);
    return true;
  }

  /**
   * Cancel a self-sent steering message that YA has accepted but the provider
   * has not consumed yet.
   */
  cancelUnconfirmedSteerMessage(tempId: string): boolean {
    const removedFromMessageQueue =
      this.messageQueue?.removeByTempId(tempId).length ?? 0;
    const legacyQueueLength = this.legacyQueue.length;
    this.legacyQueue = this.legacyQueue.filter(
      (message) => !this.userMessageMatchesTempId(message, tempId),
    );
    const removedFromLegacyQueue = legacyQueueLength - this.legacyQueue.length;
    const removedCount = removedFromMessageQueue + removedFromLegacyQueue;

    if (removedCount === 0) {
      return false;
    }

    this.removeBufferedEchoByTempId(tempId);
    return true;
  }

  private userMessageMatchesTempId(
    message: UserMessage,
    tempId: string,
  ): boolean {
    return (
      message.tempId === tempId || message.tempIds?.includes(tempId) === true
    );
  }

  private sdkMessageMatchesTempId(
    message: SDKMessage,
    tempId: string,
  ): boolean {
    const messageTempId = message.tempId;
    if (messageTempId === tempId) {
      return true;
    }
    const tempIds = message.tempIds;
    return Array.isArray(tempIds) && tempIds.includes(tempId);
  }

  private removeBufferedEchoByTempId(tempId: string): void {
    this.currentBucket = this.currentBucket.filter(
      (message) => !this.sdkMessageMatchesTempId(message, tempId),
    );
    this.previousBucket = this.previousBucket.filter(
      (message) => !this.sdkMessageMatchesTempId(message, tempId),
    );
    for (const [uuid, message] of this.activeSteerEchoes) {
      if (this.sdkMessageMatchesTempId(message, tempId)) {
        this.activeSteerEchoes.delete(uuid);
      }
    }
  }

  private releaseActiveSteerEchoes(): void {
    const bufferedUuids = new Set(
      [...this.previousBucket, ...this.currentBucket]
        .map((message) => message.uuid)
        .filter((uuid): uuid is string => typeof uuid === "string"),
    );
    for (const [uuid, message] of this.activeSteerEchoes) {
      if (!bufferedUuids.has(uuid)) {
        this.currentBucket.push(message);
      }
    }
    this.activeSteerEchoes.clear();
  }

  /**
   * Get a summary of the live deferred queue for canonical server projection.
   */
  getDeferredQueueSummary(): SessionQueuedMessageSummary[] {
    const deferred = this.deferredQueue.map((entry) => {
      const attachmentCount =
        (entry.message.attachments?.length ?? 0) +
        (entry.message.images?.length ?? 0) +
        (entry.message.documents?.length ?? 0);

      return {
        ...(entry.persistedQueueId
          ? {
              id: entry.persistedQueueId,
              kind: "patient" as const,
              status: "queued" as const,
            }
          : {}),
        tempId: entry.message.tempId,
        content: entry.message.text,
        timestamp: entry.timestamp,
        ...(entry.message.metadata ? { metadata: entry.message.metadata } : {}),
        ...(entry.message.attachments?.length
          ? { attachments: entry.message.attachments }
          : {}),
        ...(attachmentCount > 0 ? { attachmentCount } : {}),
      };
    });
    const yaCommands = this.pendingYaCommands.map((entry) => ({
      tempId: entry.tempId,
      content: entry.content,
      timestamp: entry.timestamp,
      kind: "ya-command" as const,
      yaCommand: entry.command,
      status: "queued" as const,
    }));
    return [...deferred, ...yaCommands];
  }

  /**
   * Remove all deferred messages so they can be handed to a replacement
   * process after this process is hard-aborted.
   */
  drainDeferredMessages(
    reason: "cancelled" | "promoted" = "promoted",
  ): UserMessage[] {
    if (this.deferredQueue.length === 0) {
      return [];
    }

    const drainedEntries = this.deferredQueue;
    const drained = drainedEntries.map((entry) => entry.message);
    const firstTempId = drained[0]?.tempId;
    this.deferredQueue = [];
    this.deletePersistedPatientDeferredEntries(drainedEntries, reason);
    this.emitDeferredQueueChange(reason, firstTempId);
    return drained;
  }

  /**
   * Remove user messages that YA accepted but the provider has not processed.
   * This includes messages in the direct provider queue as well as editable
   * deferred messages.
   */
  async drainPendingUserMessages(
    reason: "cancelled" | "promoted" = "promoted",
  ): Promise<UserMessage[]> {
    const queuedMessages = this.messageQueue
      ? this.messageQueue.drainAsync
        ? await this.messageQueue.drainAsync()
        : this.messageQueue.drain()
      : [];
    return [...queuedMessages, ...this.drainDeferredMessages(reason)];
  }

  /**
   * Signal that subscribers should publish the canonical deferred queue state.
   */
  private emitDeferredQueueChange(
    reason?: "queued" | "cancelled" | "promoted",
    tempId?: string,
    yaCommand?: SessionQueuedYaCommand,
  ): void {
    this.emit({
      type: "deferred-queue",
      reason,
      tempId,
      yaCommand,
    });
  }

  /**
   * Convert a simple glob pattern (with * wildcards) to a RegExp.
   * Only supports * as wildcard (matches any characters).
   */
  private static globToRegex(glob: string): RegExp {
    const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    const pattern = escaped.replace(/\*/g, ".*");
    return new RegExp(`^${pattern}$`);
  }

  /**
   * Check if a tool invocation matches a permission pattern like "Bash(curl *)".
   * Returns true if the pattern matches the tool name and input.
   */
  private static matchesPermissionPattern(
    pattern: string,
    toolName: string,
    input: unknown,
  ): boolean {
    // Parse "ToolName(glob)" pattern
    const match = pattern.match(/^(\w+)\((.+)\)$/);
    if (!match) return false;
    const patternTool = match[1];
    const glob = match[2];
    if (!patternTool || !glob || patternTool !== toolName) return false;

    // Extract the string to match against from the tool input
    let commandStr = "";
    if (toolName === "Bash") {
      commandStr = (input as { command?: string })?.command ?? "";
    } else {
      // For non-Bash tools, match against JSON-stringified input
      commandStr = typeof input === "string" ? input : JSON.stringify(input);
    }

    return Process.globToRegex(glob).test(commandStr);
  }

  /**
   * Check permission rules (deny/allow patterns) against a tool invocation.
   * Returns a ToolApprovalResult if a rule matches, or undefined to fall through.
   * Evaluation order: deny first, then allow.
   */
  private checkPermissionRules(
    toolName: string,
    input: unknown,
  ): ToolApprovalResult | undefined {
    if (!this._permissions) return undefined;

    // Check deny rules first
    if (this._permissions.deny) {
      for (const pattern of this._permissions.deny) {
        if (Process.matchesPermissionPattern(pattern, toolName, input)) {
          const command =
            toolName === "Bash"
              ? ((input as { command?: string })?.command ?? "")
              : "";
          getLogger().warn(
            `[permissions] Denied ${toolName}: "${command}" matched deny pattern "${pattern}"`,
          );
          return {
            behavior: "deny",
            message: `Blocked by permission rule: ${pattern}`,
          };
        }
      }
    }

    // Check allow rules
    if (this._permissions.allow) {
      for (const pattern of this._permissions.allow) {
        if (Process.matchesPermissionPattern(pattern, toolName, input)) {
          return { behavior: "allow" };
        }
      }
    }

    return undefined;
  }

  /**
   * Handle tool approval request from SDK's canUseTool callback.
   * This is called by the Supervisor when creating the session.
   * Behavior depends on current permission mode:
   * - default: Ask user for approval
   * - acceptEdits: Auto-approve Edit/Write tools, ask for others
   * - plan: Auto-approve read-only tools (Read, Glob, Grep, etc.), prompt for others
   * - bypassPermissions: Auto-approve all tools except AskUserQuestion
   */
  async handleToolApproval(
    toolName: string,
    input: unknown,
    options: {
      signal: AbortSignal;
      permissionMode?: PermissionMode;
    },
  ): Promise<ToolApprovalResult> {
    console.log(
      `[handleToolApproval] toolName=${toolName}, permissionMode=${this._permissionMode}, providerPermissionMode=${options.permissionMode ?? this._permissionMode}`,
    );

    // Check if aborted
    if (options.signal.aborted) {
      return {
        behavior: "deny",
        message: "Operation aborted",
        interrupt: true,
      };
    }

    const isUserQuestion = isAskUserQuestionTool(toolName);

    // Provider-native interviews are user questions, not permission decisions.
    // Always surface them so allow/deny rules cannot silently answer them.
    if (!isUserQuestion) {
      // Check permission rules (deny/allow patterns) before mode-based logic
      const permissionResult = this.checkPermissionRules(toolName, input);
      if (permissionResult) {
        return permissionResult;
      }
    }

    // The provider may keep its sandbox/policy fixed for the active turn, but
    // YA's approval bridge follows the selected standing mode immediately.
    const modeApproval = getModeBasedToolApproval(
      this._permissionMode,
      toolName,
      input,
      isUserQuestion,
    );
    if (modeApproval) {
      return modeApproval;
    }

    // Default behavior: ask user for approval or an interview answer.
    const request: InputRequest = {
      id: randomUUID(),
      sessionId: this._sessionId,
      type: isUserQuestion ? "question" : "tool-approval",
      prompt: isUserQuestion
        ? buildAskUserQuestionPrompt(input)
        : `Allow ${toolName}?`,
      toolName,
      toolInput: input,
      timestamp: new Date().toISOString(),
    };

    // Add to the pending approvals map and queue
    // The first pending approval is shown to the user, others wait in queue
    const isFirstPending = this.pendingToolApprovals.size === 0;

    // Create a promise that will be resolved by respondToInput
    return new Promise<ToolApprovalResult>((resolve) => {
      this.pendingToolApprovals.set(request.id, { request, resolve });
      this.pendingToolApprovalQueue.push(request.id);

      // Handle abort signal
      const onAbort = () => {
        if (this.pendingToolApprovals.has(request.id)) {
          this.pendingToolApprovals.delete(request.id);
          this.pendingToolApprovalQueue = this.pendingToolApprovalQueue.filter(
            (id) => id !== request.id,
          );
          // If this was the current request being shown, emit the next one
          if (isFirstPending) {
            this.emitNextPendingApproval();
          }
          resolve({
            behavior: "deny",
            message: "Operation aborted",
            interrupt: true,
          });
        }
      };

      options.signal.addEventListener("abort", onAbort, { once: true });

      // Only emit state change for the first pending approval
      // Subsequent approvals wait in queue until the first is resolved
      if (isFirstPending) {
        this.setState({ type: "waiting-input", request });
      }
    });
  }

  /**
   * Emit the next pending approval to the client, or transition to running if none left.
   */
  private emitNextPendingApproval(): void {
    const nextId = this.pendingToolApprovalQueue[0];
    if (nextId !== undefined) {
      const next = this.pendingToolApprovals.get(nextId);
      if (next) {
        this.setState({ type: "waiting-input", request: next.request });
        return;
      }
    }
    // No more pending approvals
    this.transitionToInTurnForWake("tool-approval-resolved");
  }

  /** Apply a newly selected standing mode to approvals already awaiting input. */
  private applySelectedModeToPendingApprovals(): void {
    let resolvedAny = false;
    for (const requestId of this.pendingToolApprovalQueue) {
      const pending = this.pendingToolApprovals.get(requestId);
      if (!pending) {
        continue;
      }
      const request = pending.request;
      const result = getModeBasedToolApproval(
        this._permissionMode,
        request.toolName ?? "",
        request.toolInput,
        request.type !== "tool-approval",
      );
      if (!result) {
        continue;
      }
      pending.resolve(result);
      this.pendingToolApprovals.delete(requestId);
      resolvedAny = true;
    }

    if (resolvedAny) {
      this.pendingToolApprovalQueue = this.pendingToolApprovalQueue.filter(
        (requestId) => this.pendingToolApprovals.has(requestId),
      );
      this.emitNextPendingApproval();
      return;
    }

    // Legacy mock harness requests do not install a callback promise. They
    // still obey Bypass, and obey Accept edits when the mock names its tool.
    if (
      this.pendingToolApprovals.size === 0 &&
      this._state.type === "waiting-input" &&
      getModeBasedToolApproval(
        this._permissionMode,
        this._state.request.toolName ?? "",
        this._state.request.toolInput,
        this._state.request.type !== "tool-approval",
      )
    ) {
      this.transitionToInTurnForWake("tool-approval-resolved");
    }
  }

  /**
   * Respond to a pending input request (tool approval).
   * Called from the API when user approves/denies a tool.
   * For AskUserQuestion, answers can be passed to update the tool input.
   * For deny with feedback, the feedback message is passed to the SDK.
   * Works for both real SDK (canUseTool callback) and mock SDK (input_request message).
   */
  respondToInput(
    requestId: string,
    response: "approve" | "deny",
    answers?: UserQuestionAnswers,
    feedback?: string,
  ): boolean {
    const pending = this.pendingToolApprovals.get(requestId);

    // For mock SDK: check if requestId matches the state's request
    if (!pending) {
      if (
        this._state.type === "waiting-input" &&
        this._state.request.id === requestId
      ) {
        // Mock SDK case - just transition back to idle/running
        this.transitionToInTurnForWake("tool-approval-resolved");
        return true;
      }
      return false;
    }

    // Build the result with optional updated input for AskUserQuestion.
    // If deny has feedback, use that as the message.
    const trimmedFeedback = feedback?.trim();
    const denyMessage = trimmedFeedback || "User denied permission";
    // If user just clicked "No" without feedback, set interrupt: true to stop retrying.
    // If user provided feedback, set interrupt: false so Claude can incorporate the guidance.
    const shouldInterrupt = response === "deny" && !trimmedFeedback;
    const result: ToolApprovalResult = {
      behavior: response === "approve" ? "allow" : "deny",
      message: response === "deny" ? denyMessage : undefined,
      interrupt: response === "deny" ? shouldInterrupt : undefined,
    };

    // If answers provided (AskUserQuestion), pass them as updatedInput
    if (answers && response === "approve") {
      const originalInput = pending.request.toolInput as {
        questions?: unknown[];
      };
      result.updatedInput = {
        ...originalInput,
        answers,
      };
    }

    // If EnterPlanMode is approved, switch to plan mode
    if (
      response === "approve" &&
      pending.request.toolName === "EnterPlanMode"
    ) {
      this.setPermissionMode("plan");
    }

    // If ExitPlanMode is approved, switch back to default mode
    if (response === "approve" && pending.request.toolName === "ExitPlanMode") {
      this.setPermissionMode("default");
    }

    // Resolve the promise and remove from tracking
    pending.resolve(result);
    this.pendingToolApprovals.delete(requestId);
    this.pendingToolApprovalQueue = this.pendingToolApprovalQueue.filter(
      (id) => id !== requestId,
    );

    // Codex app-server decline decisions do not currently include a rejection
    // reason in-protocol. Queue the feedback as a follow-up user message.
    if (response === "deny" && trimmedFeedback && this.provider === "codex") {
      const queued = this.queueMessage({
        text: `I denied that request. Instead: ${trimmedFeedback}`,
      });
      if (!queued.success) {
        getLogger().warn(
          {
            sessionId: this._sessionId,
            processId: this.id,
            error: queued.error,
          },
          "Failed to queue Codex deny feedback follow-up message",
        );
      }
    }

    // Emit the next pending approval, or transition to running if none left
    this.emitNextPendingApproval();

    return true;
  }

  /**
   * Get the current pending input request (first in queue), if any.
   * Works for both real SDK (canUseTool callback) and mock SDK (input_request message).
   */
  getPendingInputRequest(): InputRequest | null {
    if (this._state.type === "waiting-input") {
      return this._state.request;
    }
    return null;
  }

  private resolvePendingToolApprovals(options: {
    message: string;
    interrupt: true;
  }): void {
    for (const pending of this.pendingToolApprovals.values()) {
      pending.resolve({
        behavior: "deny",
        message: options.message,
        interrupt: options.interrupt,
      });
    }
    this.pendingToolApprovals.clear();
    this.pendingToolApprovalQueue = [];
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  hasLiveDeltaSubscribers(): boolean {
    return this.liveDeltaSubscriberCount > 0;
  }

  registerLiveDeltaSubscriber(): () => void {
    this.liveDeltaSubscriberCount += 1;
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.liveDeltaSubscriberCount = Math.max(
        0,
        this.liveDeltaSubscriberCount - 1,
      );
    };
  }

  hasViewers(): boolean {
    return this.viewerLifecycle.hasViewers();
  }

  registerViewer(): () => void {
    return this.viewerLifecycle.registerViewer();
  }

  /** True when reload can detach without losing YA-owned queued input. */
  canDetachForServerReload(): boolean {
    return (
      this.detachForServerReloadFn !== null &&
      this.queueDepth === 0 &&
      !this.hasVolatileDeferredMessages()
    );
  }

  /**
   * Terminate the process with a reason (e.g., staleness detection).
   * Unlike abort(), this records the reason for logging/debugging.
   * Also calls abortFn to kill the underlying CLI process, preventing
   * orphaned processes that continue running after Yep stops tracking them.
   */
  terminate(reason: string): void {
    if (!this.viewerLifecycle.hasUnverifiedProviderOwnership) {
      // Kill the underlying CLI process first (if available), so it doesn't
      // continue running as an orphan after we unregister from the Supervisor.
      this.requestProviderAbortWithoutWaiting(reason);
    }
    this.markTerminated(reason);
  }

  /**
   * Mark this process terminated, then wait until its provider runtime is
   * verified gone. Replacement ownership must not begin before this resolves.
   */
  async terminateAndWait(reason: string): Promise<ProcessAbortResult> {
    this.viewerLifecycle.beginTeardownVerification();
    this.markTerminated(reason);
    try {
      return await this.abort();
    } catch (error) {
      this.retainLifecycleTeardownFailure(
        `${reason} provider teardown failed`,
        error,
      );
      throw error;
    }
  }

  private async requestProviderAbort(): Promise<void> {
    await this.abortFn?.();
  }

  private requestProviderAbortWithoutWaiting(reason: string): void {
    void this.requestProviderAbort().catch((error) => {
      getLogger().error(
        {
          event: "provider_abort_failed",
          sessionId: this._sessionId,
          processId: this.id,
          projectId: this.projectId,
          reason,
          errorMessage: error instanceof Error ? error.message : String(error),
        },
        `Provider abort failed: ${this._sessionId}`,
      );
    });
  }

  async abort(): Promise<ProcessAbortResult> {
    const activeAbort = this.abortInFlight;
    if (activeAbort) return activeAbort;

    const attempt = this.abortAndVerify();
    this.abortInFlight = attempt;
    try {
      return await attempt;
    } finally {
      if (this.abortInFlight === attempt) {
        this.abortInFlight = null;
      }
    }
  }

  private async abortAndVerify(): Promise<ProcessAbortResult> {
    this.viewerLifecycle.stop();
    this.clearPromptCacheKeepaliveTimer();
    this.stopBucketSwapTimer();
    this.clearRetryingProviderRuntimeStatus();
    const pid = this.pid;
    const deadline = Date.now() + PROCESS_ABORT_TIMEOUT_MS;
    const providerAbortOutcome = this.requestProviderAbort().then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error }),
    );

    let verification: ProcessAbortResult["verification"] | undefined;
    if (pid !== undefined && this.executor === undefined) {
      const remainingMs = Math.max(0, deadline - Date.now());
      if (!(await waitForLocalPidExit(pid, remainingMs))) {
        throw new Error(`Provider PID ${pid} is still running after abort`);
      }
      // A provider may own descendants in the same process group after its
      // leader exits. When it exposes stronger liveness, let its shutdown
      // promise finish and require that group-level check to agree.
      const providerAliveAfterPidExit = this._isProcessAlive?.();
      if (
        providerAliveAfterPidExit !== undefined &&
        providerAliveAfterPidExit
      ) {
        const abortOutcome = await waitUntilAbortDeadline(
          providerAbortOutcome,
          deadline,
          `Timed out waiting for provider process group ${pid} to stop`,
        );
        if (!abortOutcome.ok) throw abortOutcome.error;
        if (this._isProcessAlive?.() !== false) {
          throw new Error(
            `Provider process group for PID ${pid} is still running after abort`,
          );
        }
      }
      verification = "pid";
    } else {
      const abortOutcome = await waitUntilAbortDeadline(
        providerAbortOutcome,
        deadline,
        "Timed out waiting for provider shutdown",
      );
      if (!abortOutcome.ok) throw abortOutcome.error;
    }

    if (verification === undefined && this._isProcessAlive) {
      if (this.isProcessAlive !== false) {
        throw new Error(
          "Provider still reports its process as running after abort",
        );
      }
      verification = "provider";
    } else if (verification === undefined) {
      await waitUntilAbortDeadline(
        this._exitPromise,
        deadline,
        "Timed out waiting for provider iterator to stop",
      );
      verification = "iterator";
    }

    this.viewerLifecycle.completeTeardownVerification();
    this.emitCompletion();
    this.listeners.clear();

    return {
      processId: this.id,
      sessionId: this._sessionId,
      ...(pid !== undefined ? { pid } : {}),
      verifiedStopped: true,
      verification,
    };
  }

  /**
   * End this server generation's provider client without requiring the
   * provider runtime itself to exit. Used only for reload-safe runtimes whose
   * next owner is the replacement server generation.
   */
  async detachForServerReload(): Promise<void> {
    // Set this before the first await. The shutdown caller checks volatile
    // queue blockers immediately before entering here, so no client turn can
    // slip into YA-owned memory after that decision.
    const viewerPresencePublication =
      this.viewerLifecycle.prepareForServerReload();
    this.clearPromptCacheKeepaliveTimer();
    this.stopBucketSwapTimer();
    this.clearRetryingProviderRuntimeStatus();
    await viewerPresencePublication;
    const deadline = Date.now() + PROCESS_ABORT_TIMEOUT_MS;
    await waitUntilAbortDeadline(
      this.detachForServerReloadFn
        ? Promise.resolve(this.detachForServerReloadFn())
        : this.requestProviderAbort(),
      deadline,
      "Timed out detaching provider client for server reload",
    );
    await waitUntilAbortDeadline(
      this._exitPromise,
      deadline,
      "Timed out waiting for provider iterator to detach",
    );
    if (this._state.type !== "terminated") {
      this.emitCompletion();
    }
    this.listeners.clear();
  }

  private async processMessages(): Promise<void> {
    try {
      while (!this.iteratorDone) {
        const result = await this.sdkIterator.next();
        if (this.iteratorDone) break;

        if (result.done) {
          this.iteratorDone = true;
          if (!this.sessionIdResolved) {
            this.rejectProviderSessionId(
              new Error(
                "Provider session completed before reporting a session id",
              ),
            );
          }
          // Don't transition to idle if we're waiting for input
          if (this._state.type !== "waiting-input") {
            this.transitionToIdle({ applyPendingEffort: false });
          }
          break;
        }

        let message = this.withTimestamp(result.value);
        if (this.toolResultMediaMaterializer) {
          message =
            await this.toolResultMediaMaterializer.materializeMessage(message);
        }
        // A receipt reserves its visible position before awaiting disk. Let it
        // publish before provider output that arrived during that save.
        while (this.commandOutputPublication) {
          await this.commandOutputPublication;
        }
        const receivedAt = new Date();
        this._lastMessageTime = receivedAt;
        this._lastProviderMessageTime = receivedAt;
        this.recordNativeRecap(message, receivedAt);
        this.observeProviderRuntimeStatus(message, receivedAt);
        if (Array.isArray(message.slash_command_inventory)) {
          await this.onCommandsObserved?.(
            this.sessionId,
            message.slash_command_inventory as SlashCommand[],
          );
          this.supportedCommandsCache =
            message.slash_command_inventory as SlashCommand[];
        }

        // Store message in history for replay to late-joining clients.
        // Exclude stream_event messages - they're transient streaming deltas that
        // are redundant once the final assistant message arrives. Replaying them
        // causes flickering as the last message appears to stream in again.
        if (shouldEmitMessage(message) && message.type !== "stream_event") {
          // Check for duplicates before adding to history
          // This handles the case where queueMessage added the optimistic message
          // and now the provider is echoing it back with the same UUID
          const isDuplicate =
            message.type === "user" &&
            message.uuid &&
            (this.currentBucket.some((m) => m.uuid === message.uuid) ||
              this.previousBucket.some((m) => m.uuid === message.uuid));

          if (!isDuplicate) {
            this.currentBucket.push(message);
          }
        }

        // Capture assistant text for the recap buffer (topics/recaps.md).
        // Stream_event partials are skipped — we only want completed assistant
        // turns so the recap input is coherent.
        if (message.type === "assistant") {
          this._assistantActivityVersion += 1;
          const text = extractMessageText(message);
          if (text) {
            this.pushRecentAssistantText(text, receivedAt.getTime());
          }
        }

        // Extract session ID from init message
        if (
          message.type === "system" &&
          message.subtype === "init" &&
          message.session_id
        ) {
          const log = getLogger();
          const oldSessionId = this._sessionId;
          this._sessionId = message.session_id;
          this.sessionIdResolved = true;
          this.resolveProviderSessionId(this._sessionId);

          log.info(
            {
              event: "session_id_received",
              sessionId: this._sessionId,
              previousTempId: oldSessionId,
              processId: this.id,
              projectId: this.projectId,
            },
            `Session ID received from SDK: ${this._sessionId}`,
          );

          this.publishAgentctlSessionId(this._sessionId);

          // Emit session-id-changed event so Supervisor can update its mapping
          // This is critical for ExternalSessionTracker to correctly identify owned sessions
          if (oldSessionId !== this._sessionId) {
            this.emit({
              type: "session-id-changed",
              oldSessionId,
              newSessionId: this._sessionId,
            });
          }

          // Resolve any waiters
          for (const resolve of this.sessionIdResolvers) {
            resolve(this._sessionId);
          }
          this.sessionIdResolvers = [];
        }

        // Capture resolved model from first assistant message
        if (
          !this._resolvedModel &&
          message.type === "assistant" &&
          message.message?.model &&
          message.message.model !== "<synthetic>"
        ) {
          this._resolvedModel = message.message.model;
        }

        this.promoteIdleForProviderWork(message, receivedAt);

        // Emit to SSE subscribers
        // See shouldEmitMessage() for why we never filter messages
        if (shouldEmitMessage(message)) {
          this.emit({ type: "message", message });
        }

        if (isClaudeSdkApiErrorMessage(this.provider, message)) {
          this.requestProviderAbortWithoutWaiting(
            "Claude SDK API error; restart required",
          );
          this.markTerminated(
            "Claude SDK API error; restart required",
            new Error(describeClaudeSdkApiError(message)),
          );
          return;
        }

        // Handle special message types
        const claudeSessionState = getClaudeSessionStateChange(message);
        if (claudeSessionState) {
          const effortUpdate =
            this.handleClaudeSessionStateChanged(claudeSessionState);
          if (effortUpdate) {
            await effortUpdate;
          }
        } else if (
          message.type === "system" &&
          message.subtype === "input_request"
        ) {
          // Legacy mock SDK behavior - handle input_request message
          this.handleInputRequest(message);
        } else if (message.type === "result") {
          // Capture context window from modelUsage in result messages. This is
          // the authoritative observation point (the only place the real,
          // account-resolved window exists); we emit a per-model observation
          // for each entry so it can be durably recorded regardless of whether
          // any client fetches this session's detail, and keep the max across
          // entries as this process's live-override window. The model id is
          // recorded exactly as the SDK reports it in modelUsage (no munging) —
          // observations should reflect what was actually observed.
          if (message.modelUsage) {
            const mu = message.modelUsage as Record<
              string,
              { contextWindow?: number }
            >;
            for (const [model, entry] of Object.entries(mu)) {
              if (entry.contextWindow && entry.contextWindow > 0) {
                this._contextWindow = Math.max(
                  this._contextWindow ?? 0,
                  entry.contextWindow,
                );
                this.emit({
                  type: "context-window-observed",
                  model,
                  contextWindow: entry.contextWindow,
                  provider: this.provider,
                });
              }
            }
          }
          const effortUpdate = this.transitionToIdle();
          if (effortUpdate) {
            await effortUpdate;
          }
        }
        // Note: deferred messages are intentionally NOT promoted at completed
        // tool-result boundaries. A queued (`deferred`) item delivers at the
        // end of the whole turn (transitionToIdle), matching native Codex app
        // queue semantics; injecting into the live turn is the explicit
        // `steer` action only. See
        // topics/message-control-steer-queue-btw-later-interrupt.md.
      }
    } catch (error) {
      const err = error as Error;
      this.rejectProviderSessionId(err);

      if (
        this.viewerLifecycle.hasUnverifiedProviderOwnership &&
        this.isProcessTerminationError(err)
      ) {
        return;
      }

      const log = getLogger();

      log.error(
        {
          event: "process_error",
          sessionId: this._sessionId,
          processId: this.id,
          projectId: this.projectId,
          errorMessage: err.message,
          errorStack: err.stack,
          currentState: this._state.type,
        },
        `Process error: ${this._sessionId} - ${err.message}`,
      );

      this.clearRetryingProviderRuntimeStatus();
      this.emit({ type: "error", error: err });

      // Detect process termination errors - set flag synchronously BEFORE markTerminated
      // to prevent race where queueMessage is called before state changes to terminated
      if (this.isProcessTerminationError(err)) {
        this.transportFailed = true;
        this.markTerminated("underlying process terminated", err);
        return;
      }

      // Don't transition to idle if we're waiting for input
      if (this._state.type !== "waiting-input" && !this.effortBoundaryBlocked) {
        const effortUpdate = this.transitionToIdle();
        if (effortUpdate) {
          await effortUpdate;
        }
      }
    } finally {
      // Resolve exit promise on both normal completion and non-terminating errors
      // so abort() doesn't hang waiting for it. (markTerminated already resolves
      // it for termination errors, and guards against double-resolve.)
      if (this._exitResolve) {
        this._exitResolve();
        this._exitResolve = null;
      }
    }
  }

  /**
   * Check if an error indicates the underlying Claude process was terminated.
   */
  private isProcessTerminationError(error: Error): boolean {
    const message = error.message || "";
    return (
      message.includes("ProcessTransport is not ready") ||
      message.includes("not ready for writing") ||
      message.includes("process exited") ||
      message.includes("SIGTERM") ||
      message.includes("SIGKILL") ||
      // SDK wraps spawn errors as "Failed to spawn Claude Code process: spawn <cmd> ENOENT"
      // where <cmd> varies (e.g., "node", "claude"), so check for ENOENT broadly
      message.includes("ENOENT")
    );
  }

  /**
   * Handle input_request message from mock SDK.
   * Real SDK uses canUseTool callback instead.
   */
  private handleInputRequest(message: SDKMessage): void {
    if (!message.input_request) return;

    const request: InputRequest = {
      id: message.input_request.id,
      sessionId: this._sessionId,
      type: message.input_request.type as InputRequest["type"],
      prompt: message.input_request.prompt,
      options: message.input_request.options,
      toolName: message.input_request.toolName,
      toolInput: message.input_request.toolInput,
      timestamp: new Date().toISOString(),
    };

    if (
      getModeBasedToolApproval(
        this._permissionMode,
        request.toolName ?? "",
        request.toolInput,
        request.type !== "tool-approval",
      )
    ) {
      return;
    }

    this.setState({ type: "waiting-input", request });
  }

  private handleClaudeSessionStateChanged(
    state: ClaudeSessionState,
  ): Promise<void> | void {
    switch (state) {
      case "idle":
        if (this._state.type !== "waiting-input") {
          return this.transitionToIdle();
        }
        break;

      case "running":
        if (
          this._state.type === "waiting-input" &&
          this.pendingToolApprovals.size > 0
        ) {
          this.viewerLifecycle.suspendIdleDeadline();
          return;
        }
        if (this._state.type !== "in-turn") {
          this.transitionToInTurnForWake("session-state-running");
        } else {
          this.viewerLifecycle.suspendIdleDeadline();
        }
        break;

      case "requires_action":
        if (this._state.type === "idle") {
          this.transitionToInTurnForWake("session-state-requires-action");
        } else {
          this.viewerLifecycle.suspendIdleDeadline();
        }
        break;
    }
  }

  private transitionToIdle(options?: {
    applyPendingEffort?: boolean;
  }): Promise<void> | void {
    this.viewerLifecycle.suspendIdleDeadline();
    this.clearRetryingProviderRuntimeStatus();

    // A provider turn boundary ends the special steering-retention window.
    // Move any aged-out echoes back into the ordinary replay window to cover
    // the short gap before the provider's durable transcript becomes visible.
    this.releaseActiveSteerEchoes();

    if (options?.applyPendingEffort !== false && this.pendingEffortUpdate) {
      this.effortBoundaryBlocked = true;
      return this.completeEffortBoundaryTransition().catch((error) => {
        const requestedEffort = this.pendingEffortUpdate?.effort;
        const configurationError = new Error(
          "Failed to apply effort; queued work remains blocked until retry",
          { cause: error },
        );
        getLogger().error(
          {
            event: "effort_change_boundary_failed",
            sessionId: this._sessionId,
            processId: this.id,
            projectId: this.projectId,
            requestedEffort,
            errorMessage:
              error instanceof Error ? error.message : String(error),
          },
          "Failed to apply effort before queued work",
        );
        this.emit({
          type: "configuration-error",
          setting: "effort",
          requestedValue: requestedEffort,
          error: configurationError,
        });
      });
    }

    this.effortBoundaryBlocked = false;
    this.finishTransitionToIdle();
  }

  private finishTransitionToIdle(): void {
    if (this.pendingYaCommands.length > 0) {
      this.setState({ type: "idle", since: new Date() });
      return;
    }

    this.continueAfterTurnBoundary(true);
  }

  private continueAfterTurnBoundary(refreshIdleState = false): void {
    // Promote deferred messages as the same stitched user turn the provider
    // receives, so the live echo and later transcript catch-up agree.
    if (this.promoteEligibleDeferredAfterTurn()) {
      this.setState({ type: "in-turn" });
      return;
    }

    if (refreshIdleState || this._state.type !== "idle") {
      this.setState({ type: "idle", since: new Date() });
    }
    this.flushPendingRecapRequest();
    this.processNextInQueue();
  }

  private flushPendingRecapRequest(): void {
    const pending = this.pendingRecapRequest;
    if (!pending || this.recapInFlight || this._state.type !== "idle") {
      return;
    }
    this.pendingRecapRequest = null;
    void this.generateAndEmitRecap(pending.provider, pending.sinceMs).then(
      (result) => {
        if (result.emitted) {
          this.emit({ type: "recap-result", result });
        }
      },
    );
  }

  /**
   * Deferred-delivery knobs, resolved per call (so live settings changes
   * apply) from constructor overrides, then published server settings, then
   * env config. Both default off: vanilla delivery is one verbatim deferred
   * turn per delivery boundary (topics/vanilla-defaults.md).
   */
  private resolveDeferredDelivery(): DeferredDeliverySettings {
    const overrides = this.deferredDeliveryOverrides;
    if (
      overrides?.joinWindowSeconds !== undefined &&
      overrides?.composeAnchors !== undefined &&
      overrides?.turnTimestamps !== undefined
    ) {
      return {
        joinWindowSeconds: overrides.joinWindowSeconds,
        composeAnchors: overrides.composeAnchors,
        turnTimestamps: overrides.turnTimestamps,
      };
    }
    const resolved = resolveDeferredDeliverySettings();
    return {
      joinWindowSeconds:
        overrides?.joinWindowSeconds ?? resolved.joinWindowSeconds,
      composeAnchors: overrides?.composeAnchors ?? resolved.composeAnchors,
      turnTimestamps: overrides?.turnTimestamps ?? resolved.turnTimestamps,
    };
  }

  /**
   * Leading run of entries whose consecutive compose times are within the
   * join window. With the default window of 0 the group is always a single
   * entry, so queued turns deliver one per boundary. A mode change always
   * starts a new group; otherwise a large window approximates "always join".
   */
  private leadingJoinGroup(
    entries: DeferredQueueEntry[],
    joinWindowSeconds: number,
  ): DeferredQueueEntry[] {
    const group = [entries[0]!];
    const windowMs = joinWindowSeconds * 1000;
    // 0 means never join, even for sends composed in the same millisecond.
    if (windowMs <= 0) return group;
    for (let i = 1; i < entries.length; i++) {
      if (entries[i]!.message.mode !== entries[0]!.message.mode) break;
      const gapMs =
        this.composedAtMsForEntry(entries[i]!) -
        this.composedAtMsForEntry(entries[i - 1]!);
      // NaN gaps (unparseable timestamps) compare false and end the group.
      if (!(gapMs <= windowMs)) break;
      group.push(entries[i]!);
    }
    return group;
  }

  /**
   * Server-clock epoch ms a deferred message was composed/queued. Prefers the
   * route-stamped `serverReceivedAt` and falls back to the queue-entry
   * timestamp — both server clock, so the delta against delivery time (now) has
   * no skew.
   */
  private composedAtMsForEntry(entry: DeferredQueueEntry): number {
    const serverReceivedAt = entry.message.metadata?.serverReceivedAt;
    const fromMetadata = serverReceivedAt ? Date.parse(serverReceivedAt) : NaN;
    if (Number.isFinite(fromMetadata)) return fromMetadata;
    return Date.parse(entry.timestamp);
  }

  /**
   * Compose-time anchor string per deferred entry, computed at delivery (now).
   * Parallel to `entries`; each element is the `(Ns ago)` / `(Ms later)` prefix
   * or null when below threshold — or always null when anchors are off
   * (the default; YEP_COMPOSE_ANCHORS=1 opts in). See
   * topics/compose-time-context-anchors.md.
   */
  private deferredComposeAnchors(
    entries: DeferredQueueEntry[],
  ): (string | null)[] {
    if (!this.resolveDeferredDelivery().composeAnchors) {
      return entries.map(() => null);
    }
    // With absolute [sent …] stamps on every chunk, relative elapsed text
    // is derivable and suppressed; only the had-seen needle survives.
    const elapsedVisible =
      this.resolveDeferredDelivery().turnTimestamps === "off";
    return composeTimeAnchors(
      entries.map((entry) => this.composedAtMsForEntry(entry)),
      Date.now(),
      entries.map((entry) => entry.lastSeenHead ?? null),
      elapsedVisible,
    );
  }

  /**
   * Promote deferred messages that may run after the completed turn.
   * Returns true when at least one message was accepted by the direct queue.
   *
   * One join group is promoted per delivery boundary. With the default join
   * window of 0 that is exactly one verbatim deferred turn — N queued
   * "proceed"-style messages get N work slices. A non-zero window joins
   * consecutively-composed turns into one `--------`-separated provider turn.
   */
  private promoteEligibleDeferredAfterTurn(): boolean {
    if (this.deferredQueue.length === 0 || !this.messageQueue) {
      return false;
    }

    const eligible = this.deferredQueue.filter(
      (entry) => !usesPatientDeliveryPath(entry, this.provider),
    );
    if (eligible.length === 0) {
      return false;
    }

    const { joinWindowSeconds } = this.resolveDeferredDelivery();
    const group = this.leadingJoinGroup(eligible, joinWindowSeconds);
    const anchors = this.deferredComposeAnchors(group);
    const providerMessages = group.map((entry, index) =>
      this.prepareProviderMessage(entry.message, anchors[index]),
    );
    const providerTurn =
      providerMessages.length === 1
        ? providerMessages[0]!
        : this.concatMessages(providerMessages);

    const result = this.queuePreparedMessage(providerTurn, {
      allowSteer: false,
    });
    if (!result.success) {
      this.emitDeferredQueueChange("queued", group[0]?.message.tempId);
      return false;
    }

    const promotedEntries = new Set(group);
    this.deferredQueue = this.deferredQueue.filter(
      (entry) => !promotedEntries.has(entry),
    );
    this.deletePersistedPatientDeferredEntries(group, "promoted");
    this.emitDeferredQueueChange(
      "promoted",
      group.length === 1 ? group[0]!.message.tempId : undefined,
    );
    return true;
  }

  /**
   * Promote patient deferred entries whose own patience window has elapsed
   * since the session became verifiably quiet. Only the leading join group is
   * promoted per call — one verbatim provider turn when the batch window is 0
   * (the common case). Bursting every ripe entry in a single pass would let the
   * provider queue's iterator re-splice them into one `--------`-joined turn,
   * defeating the batch-window setting; instead each promoted turn flips the
   * process back in-turn, and the Supervisor re-arms this check on the next
   * fresh idle boundary so the rest deliver one-per-"fully done" boundary (see
   * observeProcessEvents). Entries still waiting report the shortest remaining
   * wait so the caller can schedule a precise re-check instead of polling.
   */
  promoteEligiblePatientDeferredMessages(options: {
    /** Server-clock ms when the current verified-quiet period began. */
    quietSinceMs: number;
    now?: number;
  }): { promoted: boolean; nextPatienceMsRemaining: number | null } {
    if (
      this.deferredQueue.length === 0 ||
      !this.messageQueue ||
      this._state.type !== "idle"
    ) {
      return { promoted: false, nextPatienceMsRemaining: null };
    }

    const patientEntries = this.deferredQueue.filter((entry) =>
      usesPatientDeliveryPath(entry, this.provider),
    );
    if (patientEntries.length === 0) {
      return { promoted: false, nextPatienceMsRemaining: null };
    }

    const now = options.now ?? Date.now();
    const quietMs = Math.max(0, now - options.quietSinceMs);
    const eligible = patientEntries.filter(
      (entry) => patientPatienceMsForEntry(entry) <= quietMs,
    );
    const nextPatienceMsRemaining = patientEntries.reduce<number | null>(
      (min, entry) => {
        const remaining = patientPatienceMsForEntry(entry) - quietMs;
        if (remaining <= 0) return min;
        return min === null ? remaining : Math.min(min, remaining);
      },
      null,
    );

    if (eligible.length === 0) {
      return { promoted: false, nextPatienceMsRemaining };
    }

    // Promote only the leading join group this pass. Compose-time gaps within
    // the window join into one turn; with the default window of 0 that is a
    // single verbatim provider message. The remaining ripe entries are left in
    // the queue and delivered one-per-boundary: queuePreparedMessage flips the
    // process back in-turn for this turn, and when it finishes the Supervisor
    // re-arms this check on the fresh idle boundary (observeProcessEvents). That
    // is what makes "fully done" + "never batch" pop one message at a time.
    const { joinWindowSeconds } = this.resolveDeferredDelivery();
    const group = this.leadingJoinGroup(eligible, joinWindowSeconds);
    const anchors = this.deferredComposeAnchors(group);
    const providerMessages = group.map((entry, index) =>
      this.prepareProviderMessage(entry.message, anchors[index]),
    );
    const providerTurn =
      providerMessages.length === 1
        ? providerMessages[0]!
        : this.concatMessages(providerMessages);
    const result = this.queuePreparedMessage(providerTurn, {
      allowSteer: false,
    });

    if (!result.success) {
      this.emitDeferredQueueChange("queued", eligible[0]?.message.tempId);
      return { promoted: false, nextPatienceMsRemaining };
    }

    const promotedEntries = new Set<DeferredQueueEntry>(group);
    this.deferredQueue = this.deferredQueue.filter(
      (entry) => !promotedEntries.has(entry),
    );
    this.deletePersistedPatientDeferredEntries(group, "promoted");
    this.emitDeferredQueueChange(
      "promoted",
      group.length === 1 ? group[0]!.message.tempId : undefined,
    );
    return { promoted: true, nextPatienceMsRemaining };
  }

  /**
   * A queued patient message rewritten for immediate steering: the steer
   * delivery intent replaces the patient one (and its now-moot patience),
   * and one recognized patient prefix is stripped because its "when done"
   * wording no longer applies to an immediate send.
   */
  private toSteeredPatientMessage(message: UserMessage): UserMessage {
    const { patienceSeconds: _patience, ...metadata } = message.metadata ?? {};
    return {
      ...message,
      text: stripPatientQueuePrefix(message.text),
      metadata: { ...metadata, deliveryIntent: "steer" },
    };
  }

  /**
   * Steer a queued patient entry — and every patient entry ahead of it, so
   * earlier patient context is never skipped — into the session now instead
   * of waiting for verified quiet. Regular deferred entries keep their queue
   * positions. When the join window (queued-send batching) is enabled the
   * group delivers as one concatenated steering turn; with the default
   * window of 0 each entry is steered separately in queue order.
   */
  steerPatientDeferredMessagesThrough(tempId: string): {
    success: boolean;
    steered?: number;
    error?: string;
  } {
    const targetIndex = this.deferredQueue.findIndex(
      (entry) => entry.message.tempId === tempId,
    );
    if (targetIndex === -1) {
      return { success: false, error: "Deferred message not found" };
    }
    const target = this.deferredQueue[targetIndex]!;
    if (target.message.metadata?.deliveryIntent !== "patient") {
      return { success: false, error: "Not a patient queued message" };
    }

    const group = this.deferredQueue
      .slice(0, targetIndex + 1)
      .filter((entry) => entry.message.metadata?.deliveryIntent === "patient");
    const anchors = this.deferredComposeAnchors(group);
    const steerMessages = group.map((entry, index) =>
      this.prepareProviderMessage(
        this.toSteeredPatientMessage(entry.message),
        anchors[index],
      ),
    );

    const { joinWindowSeconds } = this.resolveDeferredDelivery();
    const turns =
      joinWindowSeconds > 0 && steerMessages.length > 1
        ? [{ providerTurn: this.concatMessages(steerMessages), entries: group }]
        : steerMessages.map((message, index) => ({
            providerTurn: message,
            entries: [group[index]!],
          }));

    let steered = 0;
    let error: string | undefined;
    for (const turn of turns) {
      const result = this.queuePreparedMessage(turn.providerTurn);
      if (!result.success) {
        error = result.error;
        break;
      }
      const sentEntries = new Set(turn.entries);
      this.deferredQueue = this.deferredQueue.filter(
        (entry) => !sentEntries.has(entry),
      );
      this.deletePersistedPatientDeferredEntries(turn.entries, "promoted");
      steered += turn.entries.length;
    }

    if (steered === 0) {
      return { success: false, error: error ?? "Failed to steer message" };
    }
    this.emitDeferredQueueChange(
      "promoted",
      steered === 1 ? group[0]!.message.tempId : undefined,
    );
    return { success: true, steered };
  }

  /**
   * Process next message in legacy queue (for mock SDK).
   */
  private processNextInQueue(): void {
    if (this.legacyQueue.length === 0) return;

    const nextMessage = this.legacyQueue.shift();
    if (nextMessage) {
      // In real implementation with MessageQueue, this happens automatically
      // For mock SDK, we just transition back to running
      this.transitionToInTurnForWake("user-message");
    }
  }

  private publishAgentctlSessionId(sessionId: string): void {
    if (!this.publishAgentctlSessionIdFn) return;

    try {
      const result = this.publishAgentctlSessionIdFn(sessionId);
      if (result && typeof result.then === "function") {
        result.catch((error) => {
          this.logAgentctlSessionIdPublishError(sessionId, error);
        });
      }
    } catch (error) {
      this.logAgentctlSessionIdPublishError(sessionId, error);
    }
  }

  private logAgentctlSessionIdPublishError(
    sessionId: string,
    error: unknown,
  ): void {
    getLogger().warn(
      {
        event: "agentctl_session_id_publish_error",
        sessionId,
        processId: this.id,
        projectId: this.projectId,
        provider: this.provider,
        error: error instanceof Error ? error.message : String(error),
        errorStack: error instanceof Error ? error.stack : undefined,
      },
      "Provider failed to publish AGENTCTL_SESSION_ID",
    );
  }

  updateIdleTimeoutMs(idleTimeoutMs: number): void {
    this.viewerLifecycle.updateIdleTimeoutMs(idleTimeoutMs);
  }

  private handleIdleReap(): void {
    this.iteratorDone = true;
    this.emit({ type: "idle-reap" });
    void this.abort().catch((error) => {
      this.retainLifecycleTeardownFailure(
        "idle reap provider teardown failed",
        error,
      );
    });
  }

  private clearPromptCacheKeepaliveTimer(): void {
    if (this.promptCacheKeepaliveTimer) {
      clearTimeout(this.promptCacheKeepaliveTimer);
      this.promptCacheKeepaliveTimer = null;
    }
  }

  private setState(state: ProcessState): void {
    this._state = state;
    this._lastStateChangeTime = new Date();
    this.viewerLifecycle.observeProcessState(state);
    this.emit({ type: "state-change", state });
    this.schedulePromptCacheKeepalive();
  }

  private emit(event: ProcessEvent): void {
    if (event.type === "state-change") {
      getLogger().debug(
        {
          component: "process",
          sessionId: this._sessionId,
          eventType: "state-change",
          listenerCount: this.listeners.size,
          newState: event.state.type,
        },
        `Emitting state-change to ${this.listeners.size} listeners`,
      );
    }
    for (const listener of this.listeners) {
      try {
        void Promise.resolve(listener(event)).catch((error: unknown) => {
          this.logListenerError(event, error);
        });
      } catch (error) {
        this.logListenerError(event, error);
      }
    }
  }

  private logListenerError(event: ProcessEvent, error: unknown): void {
    getLogger().warn(
      {
        event: "process_listener_error",
        sessionId: this._sessionId,
        processId: this.id,
        projectId: this.projectId,
        provider: this.provider,
        emittedEventType: event.type,
        error: error instanceof Error ? error.message : String(error),
        errorStack: error instanceof Error ? error.stack : undefined,
      },
      "Process listener failed",
    );
  }
}
