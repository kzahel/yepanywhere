import type { AgentAuthRouter } from "../services/AgentAuthRouter.js";
import { randomUUID } from "node:crypto";
import {
  DEFAULT_PROMPT_CACHE_KEEPALIVE_INACTIVITY_MINUTES,
  type CacheMissBillingSettings,
  type ClaudeSteerBackgroundBashSettings,
  type DurableSyntheticDoneMessage,
  type PromptSuggestionMode,
  type ProviderName,
  type ProviderRuntimeStatus,
  type RecapMode,
  type SessionLivenessProbeStatus,
  type SessionLivenessSnapshot,
  type SessionSandboxLevel,
  type SyntheticSessionBoundaryCommand,
  type UrlProjectId,
  type WorkstreamId,
  type PostCompactReplaySettings,
  type PostCompactReplayTurn,
  buildPostCompactReplayPrompt,
  formatPostCompactReplayPrompt,
  isPostCompactReplayEnabledForProvider,
  selectPostCompactReplayTurns,
  readGoalDetails,
  truncateSessionTitle,
} from "@yep-anywhere/shared";
import { RETIRED_COMPUTER_CONTROL_ERROR } from "../machine-control/legacy-retirement.js";
import type { ClaudeGoalSnapshot } from "../sdk/providers/claude-goal.js";
import { registerForkedSessionFile } from "../sessions/fork-discovery.js";
import {
  isResumeDropsTurnRefusal,
  type ResumeTruncation,
  resolveResumeTruncation,
} from "./resume-truncation.js";
import type { AgentActivity, PendingInputType } from "@yep-anywhere/shared";
import { DEFAULT_IDLE_TIMEOUT_MS } from "../defaults.js";
import { createLruMap, refreshLruMap } from "../lib/lruCollections.js";
import { getLogger } from "../logging/logger.js";
import type {
  EffectiveSessionLaunchSettingsValue,
  SessionMetadataService,
} from "../metadata/index.js";
import type { ToolResultMediaStore } from "../media/ToolResultMediaStore.js";
import type { NotificationService } from "../notifications/index.js";
import {
  getProjectName,
  type ProjectDisplayNameResolver,
} from "../projects/paths.js";
import {
  getSessionSandboxSettingsError,
  openClaudeSandboxTranscriptDirectory,
  prepareSessionSandbox,
  type PrepareSessionSandboxOptions,
} from "../session-sandbox.js";
import { getProvider } from "../sdk/providers/index.js";
import {
  SessionTokenUsageRecorder,
  type SessionTokenUsageRecord,
} from "../auth/SessionTokenUsageRecorder.js";
import { CacheMissBillingMonitor } from "../services/CacheMissBillingMonitor.js";
import type { DirtyFileEditorService } from "../services/DirtyFileEditorService.js";
import type { SessionQueuePersistenceService } from "../services/SessionQueuePersistenceService.js";
import type {
  AgentProvider,
  ProviderForkBoundary,
  SummaryGenerationRequest,
  SummaryGenerationResult,
} from "../sdk/providers/types.js";
import { resolveInheritedForkModel } from "../sdk/providers/types.js";
import { formatAgentRecapExcerpt } from "../sessions/agent-excerpt.js";
import {
  isAwaySummaryMessage,
  latestRecapMessage,
  messageTimestampMs,
  toDurableRecapMessage,
} from "../sessions/recap-overlays.js";
import {
  sessionActivityEventFromProcess,
  sessionOwnershipFromProcess,
} from "../sessions/session-runtime-overlay.js";
import type {
  GetSessionSummaryOptions,
  RecoveredSessionLaunchSettings,
} from "../sessions/types.js";
import type { ResumeExemptionResult } from "../sessions/resume-exemption.js";
import {
  normalizeSlashCommandName,
  parseSlashCommandSubmission,
} from "../sdk/slashCommandEmulation.js";
import { dispatchProviderCommand } from "./provider-command.js";
import type {
  ClaudeSDK,
  PermissionMode,
  RealClaudeSDKInterface,
  SDKMessage,
  UserMessage,
} from "../sdk/types.js";
import type {
  EventBus,
  ProcessStateEvent,
  ProcessTerminatedEvent,
  ProviderRuntimeStatusChangedEvent,
  SessionAbortedEvent,
  SessionCreatedEvent,
  SessionForkedEvent,
  SessionIdRemappedEvent,
  SessionStatusEvent,
  SessionStopRequestedEvent,
  SessionUpdatedEvent,
  WorkerActivityEvent,
} from "../watcher/EventBus.js";
import {
  NATIVE_RECAP_FALLBACK_GRACE_MS,
  Process,
  type ProcessConstructorOptions,
  type RecapRequestResult,
} from "./Process.js";
import {
  SessionDoneCoordinator,
  type SessionDoneResult,
} from "./SessionDoneCoordinator.js";
import {
  type ModelSettings,
  SessionActivationCoordinator,
  type SessionReactivationOptions,
  canApplyThinkingConfigDynamically,
  thinkingConfigsEqual,
} from "./SessionActivationCoordinator.js";
import { HeartbeatSweepScheduler, earliestDueAt } from "./heartbeatSchedule.js";
import { persistedSandboxFromProcess } from "./sessionSandboxMetadata.js";
import {
  inheritSuccessorLaunchSettings,
  type SuccessorLaunchOverrides,
} from "./sessionLaunchInheritance.js";
import {
  AGENT_SERVER_TOKEN_ENV,
  type AgentServerAccess,
} from "../auth/AgentServerTokens.js";
import {
  type QueuedRequestInfo,
  type QueuedResponse,
  type SessionStartedCallback,
  WorkerQueue,
  isQueueFullError,
} from "./WorkerQueue.js";
import {
  DEFAULT_IDLE_PREEMPT_THRESHOLD_MS,
  type ProcessAbortResult,
  type ProcessInfo,
  type ProcessEvent,
  type SessionOwnership,
  type SessionSummary,
  encodeProjectId,
} from "./types.js";

export {
  SessionConfigurationConflictError,
  type ModelSettings,
  type SessionReactivationOptions,
  type SessionReactivationOverrides,
} from "./SessionActivationCoordinator.js";

/** Maximum number of terminated processes to retain */
const MAX_TERMINATED_PROCESSES = 50;

/** Maximum terminal provider incidents retained until the YA server restarts. */
const MAX_TERMINAL_PROVIDER_STATUSES = 256;

/** How long to retain terminated process info (10 minutes) */
const TERMINATED_RETENTION_MS = 10 * 60 * 1000;

/** How often to check for stale processes (60 seconds) */
const STALE_CHECK_INTERVAL_MS = 60 * 1000;

/** Default in-turn stale threshold for providers with frequent heartbeat/tool events. */
const DEFAULT_STALE_IN_TURN_THRESHOLD_MS = 5 * 60 * 1000;
/** Codex sessions can be silent for long periods during backend retries/reconnects. */
const CODEX_STALE_IN_TURN_THRESHOLD_MS = 60 * 60 * 1000;
/**
 * Fallback cadence for a heartbeat source that cannot prove a later deadline —
 * an opted-in session blocked by queue depth, an unverified liveness status, or
 * a patient entry waiting on a state change. It is the interval the deadline
 * scheduler replaced, so no situation sweeps more often than it used to.
 */
const HEARTBEAT_RECHECK_MS = 30 * 1000;
const LIVENESS_PROBE_CHECK_INTERVAL_MS = 30 * 1000;
const LIVENESS_PROBE_REFRESH_MS = 60 * 1000;
const DEFAULT_HEARTBEAT_TURN_TEXT = "continue";
const DEFAULT_HEARTBEAT_TURNS_AFTER_MINUTES = 5;

const DEFAULT_INTERRUPT_TIMEOUT_MS = 2000;
const FORCED_HEARTBEAT_INTERRUPT_PREAMBLE =
  "interrupted for heartbeat; resume interrupted command after responding:";
const HEARTBEAT_RESET_PROBE_STATUSES: ReadonlySet<SessionLivenessProbeStatus> =
  new Set(["active", "idle", "waiting-input"]);
const ACTIVE_HEARTBEAT_DOUBT_STATUSES = new Set([
  "verified-progressing",
  "recently-active-unverified",
  "long-silent-unverified",
]);
const RESUME_COMPACT_WAIT_MS = 3 * 60 * 1000;

export type ResumeMode = "full" | "compact-first";

export type ResumeCompactionAttempt =
  | { status: "completed"; command: string }
  | { status: "timed-out"; command: string; timeoutMs: number }
  | { status: "failed"; command?: string; reason: string }
  | { status: "unavailable"; reason: string }
  | { status: "skipped"; reason: string };

export class ResumeCompactionError extends Error {
  readonly sessionId: string;
  readonly provider: ProviderName;
  readonly attempt: ResumeCompactionAttempt;
  readonly recovery = "full-resume" as const;

  constructor(params: {
    sessionId: string;
    provider: ProviderName;
    attempt: ResumeCompactionAttempt;
  }) {
    super(describeResumeCompactionAttempt(params.attempt));
    this.name = "ResumeCompactionError";
    this.sessionId = params.sessionId;
    this.provider = params.provider;
    this.attempt = params.attempt;
  }
}

function describeResumeCompactionAttempt(
  attempt: ResumeCompactionAttempt,
): string {
  switch (attempt.status) {
    case "completed":
      return `Compact-first resume completed with /${attempt.command}`;
    case "timed-out":
      return `Compact-first resume timed out after ${attempt.timeoutMs}ms waiting for /${attempt.command}`;
    case "failed":
      return attempt.command
        ? `Compact-first resume failed after /${attempt.command}: ${attempt.reason}`
        : `Compact-first resume failed: ${attempt.reason}`;
    case "unavailable":
      return `Compact-first resume unavailable: ${attempt.reason}`;
    case "skipped":
      return `Compact-first resume skipped: ${attempt.reason}`;
  }
}

function isCompactBoundaryMessage(message: SDKMessage): boolean {
  return message.type === "system" && message.subtype === "compact_boundary";
}

function compactFailureReason(message: SDKMessage): string | null {
  if (
    message.type !== "system" ||
    message.subtype !== "status" ||
    message.compact_result !== "failed"
  ) {
    return null;
  }
  return typeof message.compact_error === "string" && message.compact_error
    ? message.compact_error
    : "provider reported compaction failure";
}

function isCompactSuccessStatus(message: SDKMessage): boolean {
  return (
    message.type === "system" &&
    message.subtype === "status" &&
    message.compact_result === "success"
  );
}

/**
 * Pure gate for the per-model compact-early threshold (task 029): true when a
 * valid percent (1–99) and a known context window put live usage at or over
 * the token threshold (percent% × window). Anything unknown or out of range
 * yields false — the trigger never fires on missing usage. Semantics are
 * "current usage already crosses the threshold", not a prediction of the next
 * turn's size.
 */
export function crossesCompactThreshold(
  percent: number | undefined,
  contextWindow: number | undefined,
  inputTokens: number | undefined,
): boolean {
  if (typeof percent !== "number" || percent <= 0 || percent >= 100) {
    return false;
  }
  if (typeof contextWindow !== "number" || contextWindow <= 0) return false;
  if (typeof inputTokens !== "number" || !Number.isFinite(inputTokens)) {
    return false;
  }
  return inputTokens >= (percent / 100) * contextWindow;
}

export function resolveNativeCompactTokenLimit(
  provider:
    | Pick<AgentProvider, "supportsNativeCompactThreshold">
    | null
    | undefined,
  settings:
    | Pick<
        ModelSettings,
        | "compactAtContextPercent"
        | "compactAtContextWindow"
        | "forceYaOrchestratedCompaction"
      >
    | undefined,
): number | undefined {
  if (
    provider?.supportsNativeCompactThreshold !== true ||
    settings?.forceYaOrchestratedCompaction === true
  ) {
    return undefined;
  }
  const percent = settings?.compactAtContextPercent;
  const contextWindow = settings?.compactAtContextWindow;
  if (
    typeof percent !== "number" ||
    percent <= 0 ||
    percent >= 100 ||
    typeof contextWindow !== "number" ||
    !Number.isFinite(contextWindow) ||
    contextWindow <= 0
  ) {
    return undefined;
  }
  return Math.max(1, Math.round((percent / 100) * contextWindow));
}

function resolveLaunchCompactPercentOverride(
  provider:
    | Pick<AgentProvider, "supportsLaunchCompactPercentOverride">
    | null
    | undefined,
  settings: Pick<ModelSettings, "claudeAutoCompactPercentOverride"> | undefined,
): number | undefined {
  if (provider?.supportsLaunchCompactPercentOverride !== true) {
    return undefined;
  }
  return settings?.claudeAutoCompactPercentOverride;
}

export function shouldYaOrchestrateCompactThreshold(
  provider:
    | Pick<AgentProvider, "supportsNativeCompactThreshold">
    | null
    | undefined,
  forceYaOrchestratedCompaction: boolean | undefined,
): boolean {
  return (
    forceYaOrchestratedCompaction === true ||
    provider?.supportsNativeCompactThreshold !== true
  );
}

function getStaleInTurnThresholdMs(provider: ProviderName): number {
  return provider === "codex" || provider === "codex-oss"
    ? CODEX_STALE_IN_TURN_THRESHOLD_MS
    : DEFAULT_STALE_IN_TURN_THRESHOLD_MS;
}

function parseFiniteIsoMs(value: string | null | undefined): number | null {
  if (!value) {
    return null;
  }
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function getHeartbeatResetAtMs(
  liveness: SessionLivenessSnapshot,
  fallbackMs: number,
): number {
  const candidateTimes = [
    parseFiniteIsoMs(liveness.lastVerifiedIdleAt),
    parseFiniteIsoMs(liveness.lastVerifiedProgressAt),
    parseFiniteIsoMs(liveness.lastProviderMessageAt),
    parseFiniteIsoMs(liveness.lastRawProviderEventAt),
    liveness.lastLivenessProbeStatus &&
    HEARTBEAT_RESET_PROBE_STATUSES.has(liveness.lastLivenessProbeStatus)
      ? parseFiniteIsoMs(liveness.lastLivenessProbeAt)
      : null,
  ].filter((ms): ms is number => ms !== null);

  return candidateTimes.length > 0
    ? Math.max(...candidateTimes, fallbackMs)
    : fallbackMs;
}

function parseCandidateUpdatedAtMs(value: string | Date): number | null {
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/** The configured quiet period, clamped to the supported 1..1440 minutes. */
function clampHeartbeatAfterMinutes(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return DEFAULT_HEARTBEAT_TURNS_AFTER_MINUTES;
  }
  return Math.max(1, Math.min(value, 1440));
}

function normalizeHeartbeatForceAfterMinutes(
  value: number | null | undefined,
): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (!Number.isFinite(value)) {
    return null;
  }
  return Math.max(0, Math.min(value, 1440));
}

type HeartbeatAction =
  | { type: "wait" }
  | { type: "queue" }
  | { type: "interrupt"; forceAfterMinutes: number; forceIdleMs: number };

function getActiveHeartbeatAction(params: {
  isVerifiedIdle: boolean;
  isActiveDoubt: boolean;
  process: Process;
  settings: HeartbeatTurnSettings;
  heartbeatResetAtMs: number;
  idleMs: number;
  now: number;
}): HeartbeatAction {
  const { isVerifiedIdle, process, settings, idleMs } = params;

  if (isVerifiedIdle) {
    return { type: "queue" };
  }

  // isActiveDoubt: in-turn session that may be hung
  const afterMinutes = clampHeartbeatAfterMinutes(settings.afterMinutes);
  const forceAfterMinutes = normalizeHeartbeatForceAfterMinutes(
    settings.forceAfterMinutes,
  );

  if (forceAfterMinutes !== null) {
    const forceThresholdMs = (afterMinutes + forceAfterMinutes) * 60 * 1000;
    if (idleMs >= forceThresholdMs) {
      return {
        type: "interrupt",
        forceAfterMinutes,
        forceIdleMs: idleMs - afterMinutes * 60 * 1000,
      };
    }
  }

  // Only queue a steering message if the session supports steering;
  // for non-steerable sessions we have no useful action until force threshold.
  if (!process.canSteer) {
    return { type: "wait" };
  }
  return { type: "queue" };
}

export class SessionMessageRejectedError extends Error {}

export class RetryableSessionLaunchError extends Error {
  readonly cause: unknown;

  constructor(cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`Provider session startup did not settle: ${detail}`);
    this.name = "RetryableSessionLaunchError";
    this.cause = cause;
  }
}

export interface SessionLaunchOptions {
  /** Canonical YA project id when the provider cwd is a checkout lane. */
  projectId?: UrlProjectId;
  /** YA workstream lane to persist once a queued launch starts. */
  workstreamId?: WorkstreamId;
  /**
   * One-shot callback once an immediate or queued launch has a canonical YA
   * id, from `startSession` and `createSession` alike. The single place a
   * caller records what the launch settled, since a queued launch returns to
   * its caller before it starts.
   */
  onStarted?: SessionStartedCallback;
  /** One-shot callback when a deferred launch cannot start. */
  onFailed?: (reason: string) => void | Promise<void>;
  /** One-shot callback when transient provider startup should be retried. */
  onRetryableFailure?: (reason: string) => void | Promise<void>;
  /** Classify provider startup rejection as retryable for a durable caller. */
  retryProviderStartupFailure?: boolean;
  /** Await provider init and reject a resumed session whose native id changed. */
  requireProviderSessionId?: boolean;
}

/** Error response when queue is full */
export interface QueueFullResponse {
  error: "queue_full";
  maxQueueSize: number;
}

export interface HeartbeatTurnSettings {
  enabled: boolean;
  afterMinutes: number;
  text: string;
  forceAfterMinutes?: number | null;
}

export interface HeartbeatTurnCandidate {
  sessionId: string;
  projectId: UrlProjectId;
  projectPath: string;
  provider: ProviderName;
  model?: string;
  executor?: string;
  updatedAt: string | Date;
  hasPendingToolCall: boolean;
}

export interface PromptCacheKeepaliveSettings {
  enabled: boolean;
  inactivityMinutes: number;
}

/** Optional callback to persist executor when session ID is received */
export type OnSessionExecutorCallback = (
  sessionId: string,
  executor: string | undefined,
) => Promise<void>;

export type OnSuccessfulProviderSessionCallback = (
  sessionId: string,
  provider: ProviderName,
) => Promise<void>;

/** Optional callback to fetch authoritative session summary for reconciliation */
export type OnSessionSummaryCallback = (
  sessionId: string,
  projectId: UrlProjectId,
  options?: GetSessionSummaryOptions,
) => Promise<SessionSummary | null>;

export type RecoverSessionLaunchSettingsCallback = (
  sessionId: string,
  projectId: UrlProjectId,
  provider: ProviderName | undefined,
) => Promise<RecoveredSessionLaunchSettings | null | undefined>;

/** Delays for initial title/messageCount reconciliation after session creation */
const INITIAL_RECONCILE_DELAYS_MS = [1000, 3000] as const;

export interface SupervisorOptions {
  getLimitedUserInstructions?: (
    username: string,
  ) => import("@yep-anywhere/shared").ResolvedLimitedUserInstructions;
  /** Agent provider interface; null disables registry-backed provider discovery. */
  provider?: AgentProvider | null;
  /** Legacy SDK interface for mock SDK */
  sdk?: ClaudeSDK;
  /** Real SDK interface with full features */
  realSdk?: RealClaudeSDKInterface;
  idleTimeoutMs?: number;
  /** Names a process's project; defaults to the path's name. */
  projectDisplayName?: ProjectDisplayNameResolver;
  /** Default permission mode for new sessions */
  defaultPermissionMode?: PermissionMode;
  /** EventBus for emitting session status changes */
  eventBus?: EventBus;
  /** Maximum concurrent workers. 0 = unlimited (default for backward compat) */
  maxWorkers?: number;
  /** Idle threshold in milliseconds for preemption. Workers idle longer than this can be preempted. */
  idlePreemptThresholdMs?: number;
  /** Maximum queue size. 0 = unlimited (default) */
  maxQueueSize?: number;
  /** Callback to persist executor when session ID is received (for remote execution resume) */
  onSessionExecutor?: OnSessionExecutorCallback;
  /** Persist install-wide provider use before a live process is registered. */
  onSuccessfulProviderSession?: OnSuccessfulProviderSessionCallback;
  /** Child environment derived from a canonical session id and executor. */
  getSessionChildEnv?: (
    sessionId: string,
    executor?: string,
  ) => Record<string, string>;
  /**
   * Mint an operator API token for one launch, or nothing while the setting
   * is off. Called only for unsandboxed local launches.
   */
  mintAgentServerAccess?: () => AgentServerAccess | undefined;
  /** Callback invoked when a process observes a model's real context window. */
  onContextWindowObserved?: (
    model: string,
    contextWindow: number,
    provider: ProviderName,
  ) => void;
  /**
   * Called after a process joins or leaves the live inventory. Consumers that
   * track "is anything still using X" — gateway service auto-stop, for one —
   * recompute from the current process list here rather than polling.
   */
  onProcessInventoryChanged?: () => void;
  /** Callback to fetch session summary for initial metadata reconciliation */
  onSessionSummary?: OnSessionSummaryCallback;
  /** Best-effort transcript recovery for sessions without a launch snapshot. */
  recoverSessionLaunchSettings?: RecoverSessionLaunchSettingsCallback;
  /** Callback to read the current heartbeat-turn settings for a session */
  getHeartbeatTurnSettings?: (
    sessionId: string,
  ) => HeartbeatTurnSettings | undefined;
  /** Callback to find heartbeat-enabled sessions with no owned process. */
  getHeartbeatTurnCandidates?: () =>
    | Promise<HeartbeatTurnCandidate[]>
    | HeartbeatTurnCandidate[];
  /**
   * Eligible unowned sessions that the last candidate lookup found nothing due
   * for. The scheduler owes them a later look; without this it would treat a
   * settled transcript as permanently settled.
   */
  getHeartbeatWaitingSessionIds?: () => readonly string[];
  /** Callback to read the current provider-scoped prompt-cache keepalive setting. */
  getPromptCacheKeepaliveSettings?: (
    provider: ProviderName,
  ) => PromptCacheKeepaliveSettings | undefined;
  /** Callback to read the post-compact continuation setting. */
  getPostCompactReplaySettings?: () => PostCompactReplaySettings | undefined;
  getInstructionRestorationSettings?: () =>
    | import("@yep-anywhere/shared").InstructionRestorationSettings
    | undefined;
  readInstructionHistory?: (
    sessionId: string,
    projectId: UrlProjectId,
    provider: ProviderName,
  ) => Promise<SDKMessage[]>;
  /** Callback to read live cache-miss billing monitor settings. */
  getCacheMissBillingSettings?: () => CacheMissBillingSettings | undefined;
  /**
   * Append a settled provider token charge to the per-user usage ledger.
   * Absent on a server built without the ledger, which then records no tokens.
   */
  recordTokenUsage?: (record: SessionTokenUsageRecord) => void;
  /** Current install-wide Claude Bash re-foregrounding policy. */
  getClaudeSteerBackgroundBashSettings?: () =>
    | ClaudeSteerBackgroundBashSettings
    | undefined;
  /** Maximum time to wait for a graceful provider interrupt before hard abort. */
  interruptTimeoutMs?: number;
  /** Optional private router connection for manually pinned native sessions. */
  agentAuthRouter?: AgentAuthRouter;
  /** Metadata service used to hide/archive server-owned helper forks. */
  sessionMetadataService?: SessionMetadataService;
  /** Read-state service updated when a synthetic done boundary commits. */
  notificationService?: NotificationService;
  /** Durable store for long-lived patient queued messages. */
  sessionQueuePersistenceService?: SessionQueuePersistenceService;
  /** Durable store for image-bearing tool results. */
  toolResultMediaStore?: ToolResultMediaStore;
  /** Tracks the last YA session to mutate each still-dirty project file. */
  dirtyFileEditorService?: DirtyFileEditorService;
  /** Root for persistent project-private provider state. */
  sandboxStateRoot?: string;
}

export type { SessionDoneResult };

/** The provider environment that hands a launch its operator API token. */
function agentServerEnvironment(
  access: AgentServerAccess | undefined,
): Record<string, string> | undefined {
  return access ? { [AGENT_SERVER_TOKEN_ENV]: access.token } : undefined;
}

export class ForkSettingsPersistenceError extends Error {
  constructor(
    readonly sessionId: string,
    cause: unknown,
  ) {
    super(
      "A transcript child was created, but its settings could not be saved. The source is unchanged.",
      { cause },
    );
    this.name = "ForkSettingsPersistenceError";
  }
}

export class Supervisor {
  private readonly instructionOptions: Pick<
    SupervisorOptions,
    "getInstructionRestorationSettings" | "readInstructionHistory"
  >;
  private readonly instructionSessions = new Map<
    Process,
    import("../sdk/providers/types.js").AgentSession
  >();
  private processes: Map<string, Process> = new Map();
  private sessionToProcess: Map<string, string> = new Map(); // sessionId -> processId
  private terminalProviderStatuses = createLruMap<
    string,
    Extract<Exclude<ProviderRuntimeStatus, null>, { kind: "terminal" }>
  >();
  private readonly activationCoordinator: SessionActivationCoordinator;
  private readonly sessionDone: SessionDoneCoordinator;
  private observedProcessIds: Set<string> = new Set();
  private everOwnedSessions: Set<string> = new Set(); // Sessions we've ever owned (for orphan detection)
  private terminatedProcesses: ProcessInfo[] = []; // Recently terminated processes
  private provider: AgentProvider | null;
  private readonly providerDiscoveryEnabled: boolean;
  private sdk: ClaudeSDK | null;
  private realSdk: RealClaudeSDKInterface | null;
  private idleTimeoutMs: number;
  private readonly projectDisplayName: ProjectDisplayNameResolver;
  private defaultPermissionMode: PermissionMode;
  private eventBus?: EventBus;
  private maxWorkers: number;
  private idlePreemptThresholdMs: number;
  private workerQueue: WorkerQueue;
  private onProcessInventoryChanged?: () => void;
  private onSessionExecutor?: OnSessionExecutorCallback;
  private onSuccessfulProviderSession?: OnSuccessfulProviderSessionCallback;
  private getSessionChildEnv?: SupervisorOptions["getSessionChildEnv"];
  private mintAgentServerAccess?: SupervisorOptions["mintAgentServerAccess"];
  /** Each live process's operator API token, revoked when it unregisters. */
  private readonly agentServerAccessByProcess = new Map<
    string,
    AgentServerAccess
  >();
  private onContextWindowObserved?: (
    model: string,
    contextWindow: number,
    provider: ProviderName,
  ) => void;
  private issueSessionRemapObserver?: (oldId: string, newId: string) => void;
  observeSessionIdRemaps(
    observer: (oldId: string, newId: string) => void,
  ): () => void {
    this.issueSessionRemapObserver = observer;
    return () => {
      if (this.issueSessionRemapObserver === observer)
        this.issueSessionRemapObserver = undefined;
    };
  }
  private onSessionSummary?: OnSessionSummaryCallback;
  private recoverSessionLaunchSettings?: RecoverSessionLaunchSettingsCallback;
  private backgroundTasksStopped = false;
  private backgroundStop: Promise<void> | undefined;
  private heartbeatInterruptTasks = new Set<Promise<void>>();
  private staleCheckTimer: ReturnType<typeof setInterval>;
  private getHeartbeatTurnSettings?: (
    sessionId: string,
  ) => HeartbeatTurnSettings | undefined;
  private getHeartbeatTurnCandidates?: () =>
    | Promise<HeartbeatTurnCandidate[]>
    | HeartbeatTurnCandidate[];
  private getHeartbeatWaitingSessionIds?: () => readonly string[];
  private getPromptCacheKeepaliveSettings?: (
    provider: ProviderName,
  ) => PromptCacheKeepaliveSettings | undefined;
  private getPostCompactReplaySettings?: () =>
    | PostCompactReplaySettings
    | undefined;
  private getClaudeSteerBackgroundBashSettings?: () =>
    | ClaudeSteerBackgroundBashSettings
    | undefined;
  private cacheMissBillingMonitor: CacheMissBillingMonitor;
  private tokenUsageRecorder: SessionTokenUsageRecorder;
  private heartbeatScheduler: HeartbeatSweepScheduler;
  /**
   * Instant the unowned-candidate half of the sweep is next due, or null once
   * only an event can create candidate work. A process deadline firing must not
   * drag the (storage-touching) candidate lookup along with it.
   */
  private heartbeatCandidateDueAtMs: number | null = 0;
  private livenessProbeTimer: ReturnType<typeof setInterval>;
  /**
   * One-shot patient-queue re-checks keyed by process id. Bounded: armed only
   * while a process holds patient deferred entries; cleared on unregister.
   */
  private patientCheckTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /**
   * Last assistant-output version considered for YA-owned threshold compaction,
   * keyed by process id. One bounded check per completed assistant turn avoids
   * retriggering on the idle boundary produced by compaction itself.
   */
  private compactThresholdCheckedAssistantVersion = new Map<string, number>();
  /**
   * Assistant-output version observed when a compaction last settled, keyed by
   * process id. Compaction rewrites the context, but the durable usage summary
   * still reports the pre-compaction token count until the next real turn is
   * recorded, so the true size is unknown until then.
   */
  private compactionSettledAtAssistantVersion = new Map<string, number>();
  /**
   * Processes with a threshold compaction already started. Each attempt holds a
   * message subscription until the provider answers or the wait expires, so a
   * second attempt must never start while the first is outstanding.
   */
  private thresholdCompactionInFlight = new Set<string>();
  /**
   * Compact-boundary snapshots waiting for idle so a configured continuation
   * turn can be injected without interrupting in-flight compact work.
   */
  private pendingPostCompactReplay = new Map<
    string,
    {
      turns: PostCompactReplayTurn[];
      inputIntentVersion: number;
    }
  >();
  private interruptTimeoutMs: number;
  private agentAuthRouter?: AgentAuthRouter;
  private sessionMetadataService?: SessionMetadataService;
  private notificationService?: NotificationService;
  private sessionQueuePersistenceService?: SessionQueuePersistenceService;
  private toolResultMediaStore?: ToolResultMediaStore;
  private dirtyFileEditorService?: DirtyFileEditorService;
  private sandboxStateRoot?: string;
  private getLimitedUserInstructions?: SupervisorOptions["getLimitedUserInstructions"];
  // In-flight forked recaps, keyed by process id. The AbortController cancels
  // the generator-fork helper turn when the parent becomes active again, so a
  // returning user's new turn is never shadowed by a stale recap. See
  // topics/recaps.md.
  private forkedRecapInFlight = new Map<string, AbortController>();
  private pendingForkedRecapRequests = new Map<string, number | null>();
  private recapPausedSessionIds = new Set<string>();

  constructor(options: SupervisorOptions) {
    this.instructionOptions = options;
    this.providerDiscoveryEnabled = options.provider !== null;
    this.provider = options.provider ?? null;
    this.sdk = options.sdk ?? null;
    this.realSdk = options.realSdk ?? null;
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.projectDisplayName = options.projectDisplayName ?? getProjectName;
    this.defaultPermissionMode = options.defaultPermissionMode ?? "default";
    this.eventBus = options.eventBus;
    this.maxWorkers = options.maxWorkers ?? 0; // 0 = unlimited
    this.idlePreemptThresholdMs =
      options.idlePreemptThresholdMs ?? DEFAULT_IDLE_PREEMPT_THRESHOLD_MS;
    this.workerQueue = new WorkerQueue({
      eventBus: options.eventBus,
      maxQueueSize: options.maxQueueSize,
    });
    this.onProcessInventoryChanged = options.onProcessInventoryChanged;
    this.onSessionExecutor = options.onSessionExecutor;
    this.onSuccessfulProviderSession = options.onSuccessfulProviderSession;
    this.getSessionChildEnv = options.getSessionChildEnv;
    this.mintAgentServerAccess = options.mintAgentServerAccess;
    this.onContextWindowObserved = options.onContextWindowObserved;
    this.onSessionSummary = options.onSessionSummary;
    this.recoverSessionLaunchSettings = options.recoverSessionLaunchSettings;
    this.getHeartbeatTurnSettings = options.getHeartbeatTurnSettings;
    this.getHeartbeatTurnCandidates = options.getHeartbeatTurnCandidates;
    this.getHeartbeatWaitingSessionIds = options.getHeartbeatWaitingSessionIds;
    this.getPromptCacheKeepaliveSettings =
      options.getPromptCacheKeepaliveSettings;
    this.getPostCompactReplaySettings = options.getPostCompactReplaySettings;
    this.getClaudeSteerBackgroundBashSettings =
      options.getClaudeSteerBackgroundBashSettings;
    this.cacheMissBillingMonitor = new CacheMissBillingMonitor({
      eventBus: options.eventBus,
      sessionMetadataService: options.sessionMetadataService,
      getSettings: options.getCacheMissBillingSettings,
    });
    this.tokenUsageRecorder = new SessionTokenUsageRecorder({
      record: options.recordTokenUsage ?? (() => {}),
      resolveUsername: (sessionId) =>
        options.sessionMetadataService?.getMetadata(sessionId)?.createdByUser,
    });
    this.interruptTimeoutMs =
      options.interruptTimeoutMs ?? DEFAULT_INTERRUPT_TIMEOUT_MS;
    this.sessionMetadataService = options.sessionMetadataService;
    this.agentAuthRouter = options.agentAuthRouter;
    this.notificationService = options.notificationService;
    this.sessionQueuePersistenceService =
      options.sessionQueuePersistenceService;
    this.toolResultMediaStore = options.toolResultMediaStore;
    this.dirtyFileEditorService = options.dirtyFileEditorService;
    this.sandboxStateRoot = options.sandboxStateRoot;
    this.getLimitedUserInstructions = options.getLimitedUserInstructions;
    this.activationCoordinator = new SessionActivationCoordinator({
      defaultPermissionMode: this.defaultPermissionMode,
      sessionMetadataService: this.sessionMetadataService,
      recoverSessionLaunchSettings: this.recoverSessionLaunchSettings,
      getProcess: (processId) => this.getProcess(processId),
      getProcessForSession: (sessionId) => this.getProcessForSession(sessionId),
      unregisterProcess: (process) => this.unregisterProcess(process),
      assertProviderOwnershipSettled: (process, action) =>
        this.assertProviderOwnershipSettled(process, action),
      assertSessionSandboxSettings: (settings) =>
        this.assertSessionSandboxSettings(settings),
      restartProcess: (process, projectPath, mode, settings) =>
        this.restartProcessWithConfiguration(
          process,
          projectPath,
          mode,
          settings,
        ),
      onSuccessfulProviderSession: this.onSuccessfulProviderSession,
    });
    if (!this.provider && !this.sdk && !this.realSdk) {
      throw new Error("Either provider, sdk, or realSdk must be provided");
    }
    this.staleCheckTimer = setInterval(
      () => this.terminateStaleProcesses(),
      STALE_CHECK_INTERVAL_MS,
    );
    this.staleCheckTimer.unref(); // Don't keep process alive for cleanup
    this.heartbeatScheduler = new HeartbeatSweepScheduler({
      sweep: (now) => this.runHeartbeatSweep(now),
      errorRetryMs: HEARTBEAT_RECHECK_MS,
    });
    this.heartbeatScheduler.requestSweepWithin(HEARTBEAT_RECHECK_MS);
    this.sessionDone = new SessionDoneCoordinator({
      sessionMetadataService: this.sessionMetadataService,
      notificationService: this.notificationService,
      getProcessForSession: (sessionId) => this.getProcessForSession(sessionId),
      cancelInFlightForkedRecap: (process) =>
        this.cancelInFlightForkedRecap(process),
      requestHeartbeatSweep: () =>
        this.heartbeatScheduler.requestSweepWithin(HEARTBEAT_RECHECK_MS),
    });
    this.livenessProbeTimer = setInterval(
      () => this.probeLongSilentProcesses(),
      LIVENESS_PROBE_CHECK_INTERVAL_MS,
    );
    this.livenessProbeTimer.unref();
  }

  /** Release this supervisor's timers without terminating provider owners. */
  stopBackgroundTasks(): Promise<void> {
    if (this.backgroundStop) return this.backgroundStop;
    this.backgroundTasksStopped = true;
    clearInterval(this.staleCheckTimer);
    clearInterval(this.livenessProbeTimer);
    for (const timer of this.patientCheckTimers.values()) clearTimeout(timer);
    this.patientCheckTimers.clear();
    this.backgroundStop = (async () => {
      await this.heartbeatScheduler.stopAndDrain();
      await Promise.allSettled(this.heartbeatInterruptTasks);
    })();
    return this.backgroundStop;
  }

  /** Sandbox request for a new or resumed provider process. */
  private newSessionSandboxOptions(
    provider: ProviderName,
    projectPath: string,
    modelSettings: ModelSettings | undefined,
    resumeSessionId: string | undefined,
  ): PrepareSessionSandboxOptions {
    const username =
      (resumeSessionId
        ? this.sessionMetadataService?.getMetadata(resumeSessionId)
            ?.createdByUser
        : undefined) ?? modelSettings?.instructionUsername;
    return {
      instructions: username
        ? this.getLimitedUserInstructions?.(username)
        : undefined,
      level: modelSettings?.sandboxLevel,
      networkFirewall: modelSettings?.sandboxNetworkFirewall,
      provider,
      projectPath,
      executor: modelSettings?.executor,
      stateKey: modelSettings?.sandboxStateKey,
      resumeSessionId,
      stateRoot: this.sandboxStateRoot,
    };
  }

  /**
   * An existing session's launch with its settled sandbox applied. A
   * persisted project-write sandbox binds every later process for the
   * session (topics/session-sandboxing.md § Session Lifetime), so wake,
   * heartbeat, deferred-message and restart relaunches keep it whether or
   * not their caller restated it. A request to weaken it is refused; only a
   * new session may choose a weaker boundary.
   */
  private withSettledSandbox(
    sessionId: string,
    projectPath: string,
    modelSettings: ModelSettings | undefined,
  ): { projectPath: string; modelSettings: ModelSettings | undefined } {
    const settled = this.sessionMetadataService?.getMetadata(sessionId);
    if (settled?.sandboxLevel !== "project-write") {
      return { projectPath, modelSettings };
    }
    const settledFirewall = settled.sandboxNetworkFirewall !== false;
    if (
      modelSettings?.sandboxLevel === "none" ||
      (settledFirewall && modelSettings?.sandboxNetworkFirewall === false)
    ) {
      throw new Error(
        `Session ${sessionId} keeps its settled sandbox; start a new session for a weaker one.`,
      );
    }
    return {
      projectPath: settled.sandboxProjectPath ?? projectPath,
      modelSettings: {
        ...modelSettings,
        sandboxLevel: "project-write",
        sandboxNetworkFirewall:
          settledFirewall || modelSettings?.sandboxNetworkFirewall === true,
        sandboxStateKey:
          settled.sandboxStateKey ?? modelSettings?.sandboxStateKey,
      },
    };
  }

  private resolveProvider(modelSettings?: ModelSettings): AgentProvider | null {
    const providerName = modelSettings?.providerName
      ? modelSettings.providerName
      : modelSettings?.executor
        ? "claude"
        : undefined;

    if (!providerName) {
      return this.provider;
    }
    if (this.provider?.name === providerName) {
      return this.provider;
    }
    return this.providerDiscoveryEnabled ? getProvider(providerName) : null;
  }

  private async assertAuthoritativeNewSessionModel(
    provider: AgentProvider,
    modelSettings?: ModelSettings,
  ): Promise<void> {
    if (provider.name !== "claude-gateway") return;

    const requestedModel = modelSettings?.model;
    if (!requestedModel || requestedModel === "default") {
      throw new Error(
        "Claude Gateway requires a model from its current catalog",
      );
    }
    const models = await provider.getAvailableModels();
    if (!models.some((model) => model.id === requestedModel)) {
      throw new Error(
        `Claude Gateway no longer advertises model ${JSON.stringify(requestedModel)}`,
      );
    }
  }

  private resolvePromptSuggestionMode(
    requestedMode: PromptSuggestionMode | undefined,
    provider: Pick<AgentProvider, "supportsNativePromptSuggestions">,
  ): PromptSuggestionMode {
    if (requestedMode === "off") {
      return "off";
    }
    if (provider.supportsNativePromptSuggestions === true) {
      return "native";
    }
    return "off";
  }

  registerPromptCacheKeepaliveViewer(process: Process): () => void {
    if (!process.supportsPromptCacheKeepalive()) {
      return () => {};
    }

    return process.registerPromptCacheKeepaliveLease({
      getInactivityMs: () => {
        const setting = this.getPromptCacheKeepaliveSettings?.(
          process.provider,
        );
        if (!setting?.enabled) {
          return null;
        }
        const inactivityMinutes =
          Number.isFinite(setting.inactivityMinutes) &&
          setting.inactivityMinutes > 0
            ? setting.inactivityMinutes
            : DEFAULT_PROMPT_CACHE_KEEPALIVE_INACTIVITY_MINUTES;
        return inactivityMinutes * 60_000;
      },
    });
  }

  async startSession(
    projectPath: string,
    message: UserMessage,
    permissionMode?: PermissionMode,
    modelSettings?: ModelSettings,
    launchOptions?: SessionLaunchOptions,
  ): Promise<Process | QueuedResponse | QueueFullResponse> {
    this.assertSessionSandboxSettings(modelSettings);
    const projectId = launchOptions?.projectId ?? encodeProjectId(projectPath);
    const provider = this.resolveProvider(modelSettings);

    // Check if at capacity
    if (this.isAtCapacity()) {
      // Try to preempt an idle worker
      const preemptable = this.findPreemptableWorker();
      if (preemptable) {
        await this.preemptWorker(preemptable);
        // Fall through to start session normally
      } else {
        // A direct Gateway caller cannot observe a deferred validation failure.
        // Fail as busy rather than accept and later discard its prompt. Durable
        // dispatchers provide onFailed and keep their own retryable item.
        if (provider?.name === "claude-gateway" && !launchOptions?.onFailed) {
          return { error: "queue_full", maxQueueSize: this.maxWorkers };
        }
        // Queue the request
        const result = this.workerQueue.enqueue({
          type: "new-session",
          projectPath,
          projectId,
          workstreamId: launchOptions?.workstreamId,
          message,
          permissionMode,
          modelSettings,
          onStarted: launchOptions?.onStarted,
          onFailed: launchOptions?.onFailed,
          onRetryableFailure: launchOptions?.onRetryableFailure,
          retryProviderStartupFailure:
            launchOptions?.retryProviderStartupFailure,
          requireProviderSessionId: launchOptions?.requireProviderSessionId,
        });
        if (isQueueFullError(result)) {
          return result;
        }
        return {
          queued: true,
          queueId: result.queueId,
          position: result.position,
        };
      }
    }

    // Use provider if available (preferred)
    let process: Process;
    if (provider) {
      process = await this.startProviderSession(
        projectPath,
        projectId,
        message,
        undefined,
        permissionMode,
        modelSettings,
        provider,
        launchOptions?.retryProviderStartupFailure,
        launchOptions?.requireProviderSessionId,
      );
    } else if (this.realSdk) {
      // Use real SDK if available
      process = await this.startRealSession(
        projectPath,
        projectId,
        message,
        undefined,
        permissionMode,
        modelSettings,
      );
    } else {
      // Fall back to legacy mock SDK
      process = await this.startLegacySession(
        projectPath,
        projectId,
        message,
        undefined,
        permissionMode,
        modelSettings,
      );
    }
    await this.notifyImmediateStart(launchOptions, process, projectId);
    return process;
  }

  /** Run an immediate launch's `onStarted`, as the worker queue does. */
  private async notifyImmediateStart(
    launchOptions: SessionLaunchOptions | undefined,
    process: Process,
    projectId: UrlProjectId,
  ): Promise<void> {
    try {
      await launchOptions?.onStarted?.(process.sessionId, process);
    } catch (error) {
      getLogger().warn(
        {
          event: "session_started_callback_failed",
          sessionId: process.sessionId,
          projectId,
          error: error instanceof Error ? error.message : String(error),
        },
        "Session started but its one-shot association callback failed",
      );
    }
  }

  /**
   * Create a session without sending an initial message.
   * Used for two-phase flow: create session first, upload files, then send message.
   * The agent will wait for a message to be pushed to the queue.
   */
  async createSession(
    projectPath: string,
    permissionMode?: PermissionMode,
    modelSettings?: ModelSettings,
    launchOptions?: SessionLaunchOptions,
  ): Promise<Process | QueuedResponse | QueueFullResponse> {
    this.assertSessionSandboxSettings(modelSettings);
    const projectId = launchOptions?.projectId ?? encodeProjectId(projectPath);
    const provider = this.resolveProvider(modelSettings);

    // Check if at capacity
    if (this.isAtCapacity()) {
      // Try to preempt an idle worker
      const preemptable = this.findPreemptableWorker();
      if (preemptable) {
        await this.preemptWorker(preemptable);
        // Fall through to create session normally
      } else {
        if (provider?.name === "claude-gateway" && !launchOptions?.onFailed) {
          return { error: "queue_full", maxQueueSize: this.maxWorkers };
        }
        // Queue the request - use empty message placeholder
        const result = this.workerQueue.enqueue({
          type: "new-session",
          projectPath,
          projectId,
          workstreamId: launchOptions?.workstreamId,
          message: { text: "" }, // Placeholder, will be replaced when first message sent
          permissionMode,
          modelSettings,
          onStarted: launchOptions?.onStarted,
          onFailed: launchOptions?.onFailed,
          onRetryableFailure: launchOptions?.onRetryableFailure,
          retryProviderStartupFailure:
            launchOptions?.retryProviderStartupFailure,
          requireProviderSessionId: launchOptions?.requireProviderSessionId,
        });
        if (isQueueFullError(result)) {
          return result;
        }
        return {
          queued: true,
          queueId: result.queueId,
          position: result.position,
        };
      }
    }

    let process: Process;
    // Use provider if available (preferred)
    if (provider) {
      process = await this.createProviderSession(
        projectPath,
        projectId,
        permissionMode,
        modelSettings,
        provider,
        undefined,
        launchOptions?.retryProviderStartupFailure,
        launchOptions?.requireProviderSessionId,
      );
    } else if (this.realSdk) {
      // Use real SDK if available
      process = await this.createRealSession(
        projectPath,
        projectId,
        permissionMode,
        modelSettings,
      );
    } else {
      // Fall back to legacy mock SDK - not supported for create-only
      throw new Error(
        "createSession requires provider or real SDK - legacy mock SDK not supported",
      );
    }
    await this.notifyImmediateStart(launchOptions, process, projectId);
    return process;
  }

  /**
   * Reactivate an existing session: spawn a live harness process bound to the
   * session id WITHOUT delivering a user turn. The process resumes the session
   * and idles on the queue (the same state it occupies after a completed turn),
   * so the client can read live process state (model options, config) before
   * any message is sent. Idempotent: returns the existing live process if the
   * session is already owned.
   *
   * Provider-agnostic: rides the existing message-less resume path
   * (`createProviderSession`/`createRealSession` with `resumeSessionId`), so
   * Claude and Codex reactivate with no synthetic turn.
   */
  async reactivateSession(
    requestedProjectPath: string,
    resumeSessionId: string,
    permissionMode?: PermissionMode,
    requestedModelSettings?: ModelSettings,
    options?: SessionReactivationOptions,
  ): Promise<Process> {
    const { projectPath, modelSettings } = this.withSettledSandbox(
      resumeSessionId,
      requestedProjectPath,
      requestedModelSettings,
    );
    this.assertSessionSandboxSettings(modelSettings);
    const overrides = options?.requestedOverrides;
    const overrideSettings = overrides?.modelSettings;
    const requestedOverrides = overrides
      ? {
          ...overrides,
          ...(overrideSettings
            ? {
                modelSettings: this.withSettledSandbox(
                  resumeSessionId,
                  projectPath,
                  overrideSettings,
                ).modelSettings,
              }
            : {}),
        }
      : {
          ...(permissionMode !== undefined ? { permissionMode } : {}),
          ...(modelSettings ? { modelSettings } : {}),
        };

    const projectId = encodeProjectId(projectPath);
    return this.activationCoordinator.reactivate({
      projectPath,
      projectId,
      sessionId: resumeSessionId,
      permissionMode,
      modelSettings,
      requestedOverrides,
      prepareColdActivation: async () => {
        if (!this.isAtCapacity()) return;
        const preemptable =
          options?.preempt === false ? undefined : this.findPreemptableWorker();
        if (preemptable) {
          await this.preemptWorker(preemptable);
          return;
        }
        // A background away-recap passes preempt:false: it should never evict
        // a live worker just to revive a different session for a recap.
        throw new Error(
          "Cannot reactivate: server is at worker capacity and no idle process can be preempted",
        );
      },
      launchCold: async (resolved) => {
        const provider = this.resolveProvider(resolved.modelSettings);
        if (provider) {
          return this.createProviderSession(
            projectPath,
            projectId,
            resolved.permissionMode,
            resolved.modelSettings,
            provider,
            resumeSessionId,
          );
        }
        if (this.realSdk) {
          return this.createRealSession(
            projectPath,
            projectId,
            resolved.permissionMode,
            resolved.modelSettings,
            resumeSessionId,
          );
        }
        throw new Error(
          "reactivateSession requires provider or real SDK - legacy mock SDK not supported",
        );
      },
    });
  }

  private assertProviderOwnershipSettled(
    process: Process,
    action: string,
  ): void {
    if (!process.hasUnverifiedProviderOwnership) return;
    throw new Error(
      `Cannot ${action} session ${process.sessionId}: prior provider teardown is in progress or unverified`,
    );
  }

  /**
   * Create a session using the real SDK without an initial message.
   * The session is created and waits for a message to be queued.
   */
  private async createRealSession(
    projectPath: string,
    projectId: UrlProjectId,
    permissionMode?: PermissionMode,
    modelSettings?: ModelSettings,
    resumeSessionId?: string,
  ): Promise<Process> {
    if (
      modelSettings?.routerAccountId ||
      modelSettings?.routerPoolId ||
      this.sessionMetadataService?.getMetadata(resumeSessionId ?? "")
        ?.routerBinding
    ) {
      throw new Error("Router sessions require a native provider adapter");
    }

    if (!this.realSdk) {
      throw new Error("realSdk is not available");
    }

    const processHolder: { process: Process | null } = { process: null };
    const effectiveMode = permissionMode ?? this.defaultPermissionMode;
    const promptSuggestionMode = this.resolvePromptSuggestionMode(
      modelSettings?.promptSuggestionMode,
      { supportsNativePromptSuggestions: true },
    );
    const tempSessionId = resumeSessionId ?? randomUUID();
    const sessionSandbox = await prepareSessionSandbox(
      this.newSessionSandboxOptions(
        "claude",
        projectPath,
        modelSettings,
        resumeSessionId,
      ),
    );
    const agentServerAccess = this.agentServerAccessForLaunch(
      Boolean(sessionSandbox) ||
        modelSettings?.sandboxLevel === "project-write",
      modelSettings?.executor,
    );
    const truncation = this.resolveLaunchTruncation(
      resumeSessionId,
      "claude",
      modelSettings,
    );
    // Start session WITHOUT an initial message - agent will wait
    const result = await this.realSdk.startSession({
      machineControl: modelSettings?.machineControl,
      desktopControlOrigin: modelSettings?.desktopControlOrigin,
      cwd: projectPath,
      // No initialMessage - queue will block until one is pushed
      resumeSessionId,
      resumeSessionAt: truncation.resumeSessionAt,
      resumeDropsTurn: truncation.resumeDropsTurn,
      permissionMode: effectiveMode,
      model: modelSettings?.model,
      thinking: modelSettings?.thinking,
      effort: modelSettings?.effort,
      launchCompactPercentOverride:
        modelSettings?.claudeAutoCompactPercentOverride,
      claudeSteerBackgroundBash: this.getClaudeSteerBackgroundBashSettings?.(),
      restoredGoal: this.readRestoredGoal(resumeSessionId),
      clientName: modelSettings?.clientName,
      globalInstructions: modelSettings?.globalInstructions,
      getSessionChildEnv: this.getSessionChildEnv
        ? (sessionId) =>
            this.getSessionChildEnv?.(sessionId, modelSettings?.executor) ?? {}
        : undefined,
      agentServerEnvironment: agentServerEnvironment(agentServerAccess),
      sessionSandbox,
      onProviderRetentionChange: () =>
        this.handleProviderRetentionChanged(processHolder),
      onToolApproval: async (toolName, input, opts) => {
        if (!processHolder.process) {
          return { behavior: "deny", message: "Process not ready" };
        }
        return processHolder.process.handleToolApproval(toolName, input, opts);
      },
    });

    const {
      iterator,
      queue,
      abort,
      detachForServerReload,
      isProcessAlive,
      probeLiveness,
      getProviderActivity,
      getProviderRetention,
      setMaxThinkingTokens,
      setEffort,
      interrupt,
      supportedModels,
      supportedCommands,
      setModel,
      runProviderCommand,
      publishAgentctlSessionId,
    } = result;

    const options: ProcessConstructorOptions = {
      projectPath,
      projectId,
      sessionId: tempSessionId,
      initialState: "idle",
      idleTimeoutMs: this.idleTimeoutMs,
      projectDisplayName: this.projectDisplayName,
      queue,
      sessionQueuePersistenceService: this.sessionQueuePersistenceService,
      toolResultMediaStore: this.toolResultMediaStore,
      abortFn: abort,
      detachForServerReloadFn: detachForServerReload,
      isProcessAlive,
      shouldRetainIdleProcess: (sessionId) =>
        this.shouldRetainIdleProcess(sessionId),
      initialProviderRuntimeStatus: resumeSessionId
        ? this.terminalProviderStatuses.get(resumeSessionId)
        : null,
      probeLivenessFn: probeLiveness,
      getProviderActivityFn: getProviderActivity,
      getProviderRetentionFn: getProviderRetention,
      getRuntimeUnviewedSinceFn: result.getRuntimeUnviewedSince,
      setRuntimeViewerPresenceFn: result.setRuntimeViewerPresence,
      pid: () => {
        const p = result.pid;
        return typeof p === "function" ? p() : p;
      },
      setMaxThinkingTokensFn: setMaxThinkingTokens,
      publishAgentSelfSelectionFn: result.publishAgentSelfSelection,
      setEffortFn: setEffort,
      effortUpdatesActiveTurn: result.effortUpdatesActiveTurn,
      interruptFn: interrupt,
      supportedModelsFn: supportedModels,
      getContextBreakdownFn: result.getContextBreakdown,
      supportedCommandsFn: supportedCommands,
      onCommandsObserved: (sessionId, commands) =>
        this.sessionMetadataService?.observeCommandInventory(
          sessionId,
          commands,
        ) ?? Promise.resolve(),
      setModelFn: setModel,
      runProviderCommandFn: runProviderCommand,
      providerInitializesOnFirstMessage: true,
      publishAgentctlSessionIdFn: publishAgentctlSessionId,
      permissionMode: effectiveMode,
      provider: "claude", // Real SDK is always Claude
      model: modelSettings?.model,
      requestedModel: modelSettings?.requestedModel,
      compactAtContextPercent: modelSettings?.compactAtContextPercent,
      compactAtContextWindow: modelSettings?.compactAtContextWindow,
      forceYaOrchestratedCompaction:
        modelSettings?.forceYaOrchestratedCompaction,
      launchCompactPercentOverride:
        modelSettings?.claudeAutoCompactPercentOverride,
      serviceTier: modelSettings?.serviceTier,
      thinking: modelSettings?.thinking,
      effort: modelSettings?.effort,
      executor: modelSettings?.executor,
      permissions: modelSettings?.permissions,
      recapMode: modelSettings?.recapMode,
      recapAfterSeconds: modelSettings?.recapAfterSeconds,
      promptSuggestionMode,
      helperSideModel: modelSettings?.helperSideModel,
      sandboxEnforcement: sessionSandbox?.enforcement,
      sandboxStateKey: sessionSandbox?.stateKey,
      sandboxProjectPath: sessionSandbox?.projectPath,
    };

    const process = new Process(iterator, options);
    processHolder.process = process;
    this.holdAgentServerAccess(process, agentServerAccess);
    this.observeProcessEvents(process);
    await this.consumePendingRewind(process, resumeSessionId, truncation);

    // Wait for the real session ID from the SDK
    if (!resumeSessionId) {
      await process.waitForSessionId();
    }
    if (sessionSandbox) {
      await this.persistProcessSandboxOrAbort(process);
    }

    await this.activationCoordinator.persistSuccessfulSessionBoundaryOrAbort(
      process,
    );
    // Recreated processes for an existing session should not emit session-created again.
    this.registerProcess(process, !resumeSessionId);

    return process;
  }

  /**
   * A paused goal exists only in YA: its Stop hook was removed from the
   * provider, so a resumed session would otherwise forget the objective it is
   * meant to reinstall. An active goal is not restored here — Claude reinstalls
   * that hook itself on resume and the transcript reports it.
   */
  private readRestoredGoal(
    resumeSessionId: string | undefined,
  ): ClaudeGoalSnapshot | null {
    if (!resumeSessionId) return null;
    const goal = readGoalDetails(
      this.sessionMetadataService?.getGoalCommand(resumeSessionId),
    );
    if (goal?.goalStatus !== "paused" || !goal.goalObjective) return null;
    return { objective: goal.goalObjective, status: "paused" };
  }

  private async settleProviderStart<T>(
    start: Promise<T>,
    required: boolean,
  ): Promise<T> {
    try {
      return await start;
    } catch (error) {
      if (required) {
        throw new RetryableSessionLaunchError(error);
      }
      throw error;
    }
  }

  private async settleProviderSessionId(
    process: Process,
    required: boolean,
    expectedSessionId?: string,
  ): Promise<void> {
    if (!required) {
      await process.waitForSessionId();
      return;
    }

    try {
      const providerSessionId = await process.waitForProviderSessionId();
      if (
        expectedSessionId !== undefined &&
        providerSessionId !== expectedSessionId
      ) {
        throw new Error(
          `Provider attached session ${providerSessionId} instead of ${expectedSessionId}`,
        );
      }
    } catch (error) {
      try {
        await process.abort();
      } catch (abortError) {
        getLogger().warn(
          {
            event: "provider_startup_abort_failed",
            processId: process.id,
            sessionId: process.sessionId,
            projectId: process.projectId,
            error:
              abortError instanceof Error
                ? abortError.message
                : String(abortError),
          },
          "Provider startup failed and its temporary process could not be cleanly aborted",
        );
      }
      throw new RetryableSessionLaunchError(error);
    }
  }

  private async queueProcessMessage(
    process: Process,
    message: UserMessage,
    options?: { allowSteer?: boolean },
  ): Promise<ReturnType<Process["queueMessage"]>> {
    // Record delivery intent before slash-command discovery or any other
    // awaited preparation. Speculative idle work must yield as soon as input
    // arrives, even while the process still reports `idle`.
    process.noteInputIntent();
    await process.primeSupportedCommandsForMessage(message);
    const command = parseSlashCommandSubmission(message.text);
    if (command) {
      const result = await dispatchProviderCommand(
        process,
        command,
        message.tempId,
        this.sessionMetadataService,
      );
      if (result.handled)
        return result.error
          ? { success: false, error: result.error }
          : { success: true };
    }
    return process.queueMessage(message, {
      allowSteer: options?.allowSteer,
    });
  }

  private async queueInitialProcessMessage(
    process: Process,
    message: UserMessage,
  ): Promise<void> {
    try {
      const result = await this.queueProcessMessage(process, message, {
        allowSteer: false,
      });
      if (!result.success) {
        throw new SessionMessageRejectedError(
          result.error ?? "Failed to queue initial message",
        );
      }
    } catch (error) {
      // This worker is not registered yet; no supervisor cleanup owns it.
      await process.abort();
      throw error;
    }
  }

  private watchResumeCompaction(
    process: Process,
    command: string,
    timeoutMs = RESUME_COMPACT_WAIT_MS,
  ): {
    promise: Promise<ResumeCompactionAttempt>;
    cancel: () => void;
  } {
    let finished = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let unsubscribe: (() => void) | undefined;

    const finish = (attempt: ResumeCompactionAttempt) => {
      if (finished) {
        return;
      }
      finished = true;
      if (timeout) {
        clearTimeout(timeout);
      }
      unsubscribe?.();
      resolve(attempt);
    };

    let resolve!: (attempt: ResumeCompactionAttempt) => void;
    const promise = new Promise<ResumeCompactionAttempt>((innerResolve) => {
      resolve = innerResolve;
    });

    timeout = setTimeout(
      () => finish({ status: "timed-out", command, timeoutMs }),
      timeoutMs,
    );
    timeout.unref?.();

    unsubscribe = process.subscribe((event: ProcessEvent) => {
      if (event.type === "message") {
        const failedReason = compactFailureReason(event.message);
        if (failedReason) {
          finish({ status: "failed", command, reason: failedReason });
          return;
        }
        if (
          isCompactBoundaryMessage(event.message) ||
          isCompactSuccessStatus(event.message)
        ) {
          finish({ status: "completed", command });
        }
        return;
      }
      if (event.type === "error") {
        finish({
          status: "failed",
          command,
          reason: event.error.message,
        });
        return;
      }
      if (event.type === "terminated") {
        finish({
          status: "failed",
          command,
          reason: event.reason,
        });
      }
    });

    return {
      promise,
      cancel: () =>
        finish({
          status: "failed",
          command,
          reason: "compact command was not queued",
        }),
    };
  }

  private async findResumeCompactCommand(
    process: Process,
  ): Promise<
    | { ok: true; command: string }
    | { ok: false; attempt: ResumeCompactionAttempt }
  > {
    if (!process.supportsDynamicCommands) {
      return {
        ok: false,
        attempt: {
          status: "unavailable",
          reason: "provider process does not advertise slash commands",
        },
      };
    }

    let commands: Awaited<ReturnType<Process["supportedCommands"]>>;
    try {
      commands = await process.supportedCommands();
    } catch (error) {
      return {
        ok: false,
        attempt: {
          status: "failed",
          reason: error instanceof Error ? error.message : String(error),
        },
      };
    }

    const command = commands
      ?.map((candidate) => normalizeSlashCommandName(candidate.name))
      .find((name) => name === "compact" || name === "compress");

    if (!command) {
      return {
        ok: false,
        attempt: {
          status: "unavailable",
          reason: "no compact/compress slash command advertised",
        },
      };
    }

    return { ok: true, command };
  }

  private async tryResumeCompaction(
    process: Process,
    options?: {
      allowNonIdleStart?: boolean;
      expectedInputIntentVersion?: number;
    },
  ): Promise<ResumeCompactionAttempt> {
    if (
      options?.expectedInputIntentVersion !== undefined &&
      process.inputIntentVersion !== options.expectedInputIntentVersion
    ) {
      return {
        status: "skipped",
        reason: "new input arrived before compaction started",
      };
    }
    if (!options?.allowNonIdleStart && process.state.type !== "idle") {
      return {
        status: "skipped",
        reason: `process was ${process.state.type}`,
      };
    }

    const command = await this.findResumeCompactCommand(process);
    if (!command.ok) {
      return command.attempt;
    }
    if (
      options?.expectedInputIntentVersion !== undefined &&
      process.inputIntentVersion !== options.expectedInputIntentVersion
    ) {
      return {
        status: "skipped",
        reason: "new input arrived before compaction started",
      };
    }
    if (!options?.allowNonIdleStart && process.state.type !== "idle") {
      return {
        status: "skipped",
        reason: `process became ${process.state.type}`,
      };
    }

    const watcher = this.watchResumeCompaction(process, command.command);
    const providerResult = await process.runProviderCommand(command.command);
    if (providerResult.handled) {
      if (providerResult.error) {
        watcher.cancel();
        return {
          status: "failed",
          command: command.command,
          reason: providerResult.error,
        };
      }
      return watcher.promise;
    }

    const queued = process.queueMessage(
      // Hidden: native compaction shows no `/compact` user turn, so neither
      // should YA-initiated compaction (resume-time or threshold-triggered).
      { text: `/${command.command}`, metadata: { hidden: true } },
      { allowSteer: false },
    );
    if (!queued.success) {
      watcher.cancel();
      return {
        status: "failed",
        command: command.command,
        reason: queued.error ?? "compact command was not accepted",
      };
    }

    return watcher.promise;
  }

  /**
   * Threshold-triggered speculative compaction (task 029). At the first idle
   * boundary after assistant output, check live usage and start the provider's
   * compact command immediately when the configured YA-owned threshold has
   * been crossed. This deliberately spends occasional unnecessary provider
   * compute so a later user request never has to initiate and await compaction.
   *
   * One assistant-output version is considered once, and nothing is
   * reconsidered until a real turn follows the last settled compaction. The
   * compact operation's own idle boundary therefore cannot recursively trigger
   * another compact, even though the durable usage summary keeps reporting the
   * pre-compaction token count until that next turn is recorded.
   */
  private async maybeCompactAfterIdle(process: Process): Promise<void> {
    if (this.isAutomationPausedUntilUserTurn(process.sessionId)) return;
    const percent = process.compactAtContextPercent;
    if (typeof percent !== "number" || percent <= 0 || percent >= 100) return;
    if (process.state.type !== "idle") return;
    if (process.isRetainingProviderWork()) return;
    if (this.thresholdCompactionInFlight.has(process.id)) return;
    const provider = this.resolveProvider({ providerName: process.provider });
    if (
      !shouldYaOrchestrateCompactThreshold(
        provider,
        process.forceYaOrchestratedCompaction,
      )
    ) {
      return;
    }
    const assistantActivityVersion = process.assistantActivityVersion;
    const inputIntentVersion = process.inputIntentVersion;
    if (
      assistantActivityVersion <= 0 ||
      this.compactThresholdCheckedAssistantVersion.get(process.id) ===
        assistantActivityVersion
    ) {
      return;
    }
    // Context size after a compaction is unknown until the session produces a
    // turn under the rewritten context. Reading the pre-compaction total back
    // and acting on it is what turned one threshold compaction into thousands.
    const compactedAtVersion = this.compactionSettledAtAssistantVersion.get(
      process.id,
    );
    if (
      compactedAtVersion !== undefined &&
      assistantActivityVersion <= compactedAtVersion
    ) {
      return;
    }
    this.compactThresholdCheckedAssistantVersion.set(
      process.id,
      assistantActivityVersion,
    );

    // Prefer the route-resolved window; process.contextWindow can be undefined.
    const contextWindow =
      process.compactAtContextWindow ?? process.contextWindow;
    if (!contextWindow || contextWindow <= 0) return;

    let inputTokens: number | undefined;
    try {
      const summary = await this.onSessionSummary?.(
        process.sessionId,
        process.projectId,
        { contextUsageMode: "manual-compaction" },
      );
      inputTokens = summary?.contextUsage?.inputTokens;
    } catch {
      // Usage unavailable → never block the turn.
      return;
    }
    // A user turn that arrived while the summary was loading wins immediately;
    // do not interrupt it or make it wait for speculative work.
    if (
      process.state.type !== "idle" ||
      process.assistantActivityVersion !== assistantActivityVersion ||
      process.inputIntentVersion !== inputIntentVersion
    ) {
      return;
    }
    if (!crossesCompactThreshold(percent, contextWindow, inputTokens)) return;

    this.thresholdCompactionInFlight.add(process.id);
    try {
      const attempt = await this.tryResumeCompaction(process, {
        expectedInputIntentVersion: inputIntentVersion,
      });
      if (attempt.status !== "completed") {
        getLogger().info(
          {
            event: "threshold_compaction_skipped",
            sessionId: process.sessionId,
            processId: process.id,
            status: attempt.status,
            percent,
            inputTokens,
            thresholdTokens: Math.round((percent / 100) * contextWindow),
          },
          "Idle threshold compaction did not complete",
        );
      }
    } catch (error) {
      getLogger().warn(
        {
          event: "threshold_compaction_failed",
          sessionId: process.sessionId,
          processId: process.id,
          error: error instanceof Error ? error.message : String(error),
        },
        "Idle threshold compaction errored",
      );
    } finally {
      this.thresholdCompactionInFlight.delete(process.id);
    }
  }

  private notePostCompactReplay(process: Process): void {
    const settings = this.getPostCompactReplaySettings?.();
    if (!isPostCompactReplayEnabledForProvider(settings, process.provider)) {
      this.pendingPostCompactReplay.delete(process.id);
      return;
    }
    const replayTurnCount = settings?.replayTurnCount ?? 0;
    this.pendingPostCompactReplay.set(process.id, {
      turns: selectPostCompactReplayTurns(
        process.getRecentProseTurns(),
        replayTurnCount,
      ),
      inputIntentVersion: process.inputIntentVersion,
    });
  }

  private async maybePostCompactReplay(process: Process): Promise<void> {
    const pending = this.pendingPostCompactReplay.get(process.id);
    if (!pending) return;
    if (this.isAutomationPausedUntilUserTurn(process.sessionId)) {
      this.pendingPostCompactReplay.delete(process.id);
      return;
    }
    const settings = this.getPostCompactReplaySettings?.();
    if (!isPostCompactReplayEnabledForProvider(settings, process.provider)) {
      this.pendingPostCompactReplay.delete(process.id);
      return;
    }
    if (process.state.type !== "idle") return;
    if (process.isRetainingProviderWork()) return;
    if (process.isTerminated) {
      this.pendingPostCompactReplay.delete(process.id);
      return;
    }
    if (
      process.queueDepth > 0 ||
      process.hasPatientDeferredMessages() ||
      process.hasVolatileDeferredMessages()
    ) {
      this.pendingPostCompactReplay.delete(process.id);
      return;
    }
    if (process.inputIntentVersion !== pending.inputIntentVersion) {
      this.pendingPostCompactReplay.delete(process.id);
      return;
    }

    this.pendingPostCompactReplay.delete(process.id);
    const prompt = buildPostCompactReplayPrompt({
      provider: process.provider,
      sessionId: process.sessionId,
      turns: pending.turns,
    });
    const queued = await this.queueProcessMessage(
      process,
      {
        text: formatPostCompactReplayPrompt(prompt),
        automaticSource: "post-compact-replay",
        metadata: { hidden: true },
      },
      { allowSteer: false },
    );
    if (!queued.success) {
      getLogger().info(
        {
          event: "post_compact_replay_skipped",
          sessionId: process.sessionId,
          processId: process.id,
          provider: process.provider,
          error: queued.error,
        },
        "Post-compact continuation was not accepted",
      );
    }
  }

  private async queueAfterResumeCompaction(params: {
    process: Process;
    sessionId: string;
    message: UserMessage;
    allowNonIdleStart?: boolean;
  }): Promise<void> {
    const attempt = await this.tryResumeCompaction(params.process, {
      allowNonIdleStart: params.allowNonIdleStart,
    });
    if (attempt.status !== "completed") {
      throw new ResumeCompactionError({
        sessionId: params.sessionId,
        provider: params.process.provider,
        attempt,
      });
    }

    const queued = await this.queueProcessMessage(
      params.process,
      params.message,
      {
        allowSteer: false,
      },
    );
    if (!queued.success) {
      throw new Error(queued.error ?? "Failed to queue message after compact");
    }
  }

  private async startCompactFirstProviderResume(
    projectPath: string,
    projectId: UrlProjectId,
    message: UserMessage,
    resumeSessionId: string,
    permissionMode: PermissionMode | undefined,
    modelSettings: ModelSettings | undefined,
    provider: AgentProvider,
  ): Promise<Process> {
    const process = await this.createProviderSession(
      projectPath,
      projectId,
      permissionMode,
      modelSettings,
      provider,
      resumeSessionId,
    );

    try {
      await this.queueAfterResumeCompaction({
        process,
        sessionId: resumeSessionId,
        message,
        allowNonIdleStart: true,
      });
      return process;
    } catch (error) {
      await process.abort();
      this.unregisterProcess(process);
      throw error;
    }
  }

  private async startCompactFirstRealResume(
    projectPath: string,
    projectId: UrlProjectId,
    message: UserMessage,
    resumeSessionId: string,
    permissionMode: PermissionMode | undefined,
    modelSettings: ModelSettings | undefined,
  ): Promise<Process> {
    const process = await this.createRealSession(
      projectPath,
      projectId,
      permissionMode,
      modelSettings,
      resumeSessionId,
    );

    try {
      await this.queueAfterResumeCompaction({
        process,
        sessionId: resumeSessionId,
        message,
        allowNonIdleStart: true,
      });
      return process;
    } catch (error) {
      await process.abort();
      this.unregisterProcess(process);
      throw error;
    }
  }

  /**
   * Start a session using the real SDK with full features.
   */
  private async startRealSession(
    projectPath: string,
    projectId: UrlProjectId,
    message: UserMessage,
    resumeSessionId?: string,
    permissionMode?: PermissionMode,
    modelSettings?: ModelSettings,
  ): Promise<Process> {
    if (
      modelSettings?.routerAccountId ||
      modelSettings?.routerPoolId ||
      this.sessionMetadataService?.getMetadata(resumeSessionId ?? "")
        ?.routerBinding
    ) {
      throw new Error("Router sessions require a native provider adapter");
    }

    const tempSessionId = resumeSessionId ?? randomUUID();

    // realSdk is guaranteed to exist here (checked in startSession)
    if (!this.realSdk) {
      throw new Error("realSdk is not available");
    }

    // We need to reference process in the callback before it's assigned
    // Using a holder object allows us to set the reference later
    const processHolder: { process: Process | null } = { process: null };

    // Use provided mode or fall back to default
    const effectiveMode = permissionMode ?? this.defaultPermissionMode;
    const promptSuggestionMode = this.resolvePromptSuggestionMode(
      modelSettings?.promptSuggestionMode,
      { supportsNativePromptSuggestions: true },
    );
    const sessionSandbox = await prepareSessionSandbox(
      this.newSessionSandboxOptions(
        "claude",
        projectPath,
        modelSettings,
        resumeSessionId,
      ),
    );
    const agentServerAccess = this.agentServerAccessForLaunch(
      Boolean(sessionSandbox) ||
        modelSettings?.sandboxLevel === "project-write",
      modelSettings?.executor,
    );
    const truncation = this.resolveLaunchTruncation(
      resumeSessionId,
      "claude",
      modelSettings,
    );
    const result = await this.realSdk.startSession({
      machineControl: modelSettings?.machineControl,
      desktopControlOrigin: modelSettings?.desktopControlOrigin,
      cwd: projectPath,
      resumeSessionId,
      resumeSessionAt: truncation.resumeSessionAt,
      resumeDropsTurn: truncation.resumeDropsTurn,
      permissionMode: effectiveMode,
      model: modelSettings?.model,
      thinking: modelSettings?.thinking,
      effort: modelSettings?.effort,
      launchCompactPercentOverride:
        modelSettings?.claudeAutoCompactPercentOverride,
      claudeSteerBackgroundBash: this.getClaudeSteerBackgroundBashSettings?.(),
      restoredGoal: this.readRestoredGoal(resumeSessionId),
      clientName: modelSettings?.clientName,
      executor: modelSettings?.executor,
      remoteEnv: modelSettings?.remoteEnv,
      globalInstructions: modelSettings?.globalInstructions,
      getSessionChildEnv: this.getSessionChildEnv
        ? (sessionId) =>
            this.getSessionChildEnv?.(sessionId, modelSettings?.executor) ?? {}
        : undefined,
      agentServerEnvironment: agentServerEnvironment(agentServerAccess),
      sessionSandbox,
      onProviderRetentionChange: () =>
        this.handleProviderRetentionChanged(processHolder),
      onToolApproval: async (toolName, input, opts) => {
        // Delegate to the process's handleToolApproval
        if (!processHolder.process) {
          return { behavior: "deny", message: "Process not ready" };
        }
        return processHolder.process.handleToolApproval(toolName, input, opts);
      },
    });

    const {
      iterator,
      queue,
      abort,
      detachForServerReload,
      isProcessAlive,
      probeLiveness,
      getProviderActivity,
      getProviderRetention,
      setMaxThinkingTokens,
      setEffort,
      interrupt,
      supportedModels,
      supportedCommands,
      setModel,
      runProviderCommand,
      publishAgentctlSessionId,
    } = result;

    const options: ProcessConstructorOptions = {
      projectPath,
      projectId,
      sessionId: tempSessionId,
      idleTimeoutMs: this.idleTimeoutMs,
      projectDisplayName: this.projectDisplayName,
      queue,
      sessionQueuePersistenceService: this.sessionQueuePersistenceService,
      toolResultMediaStore: this.toolResultMediaStore,
      abortFn: abort,
      detachForServerReloadFn: detachForServerReload,
      isProcessAlive,
      shouldRetainIdleProcess: (sessionId) =>
        this.shouldRetainIdleProcess(sessionId),
      initialProviderRuntimeStatus: resumeSessionId
        ? this.terminalProviderStatuses.get(resumeSessionId)
        : null,
      probeLivenessFn: probeLiveness,
      getProviderActivityFn: getProviderActivity,
      getProviderRetentionFn: getProviderRetention,
      getRuntimeUnviewedSinceFn: result.getRuntimeUnviewedSince,
      setRuntimeViewerPresenceFn: result.setRuntimeViewerPresence,
      pid: () => {
        const p = result.pid;
        return typeof p === "function" ? p() : p;
      },
      setMaxThinkingTokensFn: setMaxThinkingTokens,
      publishAgentSelfSelectionFn: result.publishAgentSelfSelection,
      setEffortFn: setEffort,
      effortUpdatesActiveTurn: result.effortUpdatesActiveTurn,
      interruptFn: interrupt,
      supportedModelsFn: supportedModels,
      getContextBreakdownFn: result.getContextBreakdown,
      supportedCommandsFn: supportedCommands,
      onCommandsObserved: (sessionId, commands) =>
        this.sessionMetadataService?.observeCommandInventory(
          sessionId,
          commands,
        ) ?? Promise.resolve(),
      setModelFn: setModel,
      runProviderCommandFn: runProviderCommand,
      providerInitializesOnFirstMessage: true,
      publishAgentctlSessionIdFn: publishAgentctlSessionId,
      permissionMode: effectiveMode,
      provider: "claude", // Real SDK is always Claude
      model: modelSettings?.model,
      requestedModel: modelSettings?.requestedModel,
      compactAtContextPercent: modelSettings?.compactAtContextPercent,
      compactAtContextWindow: modelSettings?.compactAtContextWindow,
      forceYaOrchestratedCompaction:
        modelSettings?.forceYaOrchestratedCompaction,
      launchCompactPercentOverride:
        modelSettings?.claudeAutoCompactPercentOverride,
      serviceTier: modelSettings?.serviceTier,
      thinking: modelSettings?.thinking,
      effort: modelSettings?.effort,
      executor: modelSettings?.executor,
      permissions: modelSettings?.permissions,
      recapMode: modelSettings?.recapMode,
      recapAfterSeconds: modelSettings?.recapAfterSeconds,
      promptSuggestionMode,
      helperSideModel: modelSettings?.helperSideModel,
      sandboxEnforcement: sessionSandbox?.enforcement,
      sandboxStateKey: sessionSandbox?.stateKey,
      sandboxProjectPath: sessionSandbox?.projectPath,
    };

    const process = new Process(iterator, options);
    processHolder.process = process;
    this.holdAgentServerAccess(process, agentServerAccess);
    this.observeProcessEvents(process);
    await this.consumePendingRewind(process, resumeSessionId, truncation);

    // Wait for the real session ID from the SDK before registering
    // This ensures the client gets the correct ID to use for persistence
    if (!resumeSessionId) {
      await process.waitForSessionId();
    }
    if (sessionSandbox) {
      await this.persistProcessSandboxOrAbort(process);
    }

    const queued = await this.queueProcessMessage(process, message, {
      allowSteer: false,
    });
    if (!queued.success) {
      await process.abort();
      throw new Error(queued.error ?? "Failed to queue initial message");
    }

    await this.activationCoordinator.persistSuccessfulSessionBoundaryOrAbort(
      process,
    );
    this.registerProcess(process, !resumeSessionId);

    return process;
  }

  /**
   * Create a session using the provider interface without an initial message.
   * The session is created and waits for a message to be queued.
   */
  private async createProviderSession(
    projectPath: string,
    projectId: UrlProjectId,
    permissionMode?: PermissionMode,
    modelSettings?: ModelSettings,
    provider?: AgentProvider,
    resumeSessionId?: string,
    retryProviderStartupFailure = false,
    requireProviderSessionId = false,
  ): Promise<Process> {
    const activeProvider = provider ?? this.provider;
    if (!activeProvider) {
      throw new Error("provider is not available");
    }
    if (!resumeSessionId) {
      await this.assertAuthoritativeNewSessionModel(
        activeProvider,
        modelSettings,
      );
    }

    const processHolder: { process: Process | null } = { process: null };
    const effectiveMode = permissionMode ?? this.defaultPermissionMode;
    const promptSuggestionMode = this.resolvePromptSuggestionMode(
      modelSettings?.promptSuggestionMode,
      activeProvider,
    );
    const compactAtContextTokenLimit = resolveNativeCompactTokenLimit(
      activeProvider,
      modelSettings,
    );
    const launchCompactPercentOverride = resolveLaunchCompactPercentOverride(
      activeProvider,
      modelSettings,
    );
    const tempSessionId = resumeSessionId ?? randomUUID();
    const sessionSandboxOptions = this.newSessionSandboxOptions(
      activeProvider.name,
      projectPath,
      modelSettings,
      resumeSessionId,
    );
    const sessionSandbox = await prepareSessionSandbox(sessionSandboxOptions);

    // Start session WITHOUT an initial message - agent will wait

    const agentServerAccess = this.agentServerAccessForLaunch(
      Boolean(sessionSandbox) ||
        modelSettings?.sandboxLevel === "project-write",
      modelSettings?.executor,
    );
    const truncation = this.resolveLaunchTruncation(
      resumeSessionId,
      activeProvider.name,
      modelSettings,
    );
    const routed =
      modelSettings?.routerAccountId ||
      modelSettings?.routerPoolId ||
      this.sessionMetadataService?.getMetadata(tempSessionId)?.routerBinding;
    if (
      routed &&
      (modelSettings?.executor ||
        sessionSandboxOptions?.level === "project-write")
    ) {
      throw new Error(
        "Router sessions require a local unsandboxed owner launch",
      );
    }
    if (
      modelSettings?.routerAccountId !== undefined &&
      (typeof modelSettings.routerAccountId !== "string" ||
        !/^[A-Za-z0-9_-]{1,128}$/.test(modelSettings.routerAccountId))
    )
      throw new Error("Invalid router account");
    if (
      modelSettings?.routerPoolId !== undefined &&
      (typeof modelSettings.routerPoolId !== "string" ||
        !/^[a-f0-9-]{36}$/.test(modelSettings.routerPoolId))
    )
      throw new Error("Invalid router pool");
    if (
      modelSettings?.routerPolicy !== undefined &&
      (!modelSettings.routerPoolId ||
        !["manual", "round-robin", "most-remaining"].includes(
          modelSettings.routerPolicy,
        ))
    )
      throw new Error("Invalid router policy");
    if (routed && !this.agentAuthRouter)
      throw new Error("Router integration unavailable");
    const routerLaunch = await this.agentAuthRouter?.launch(
      tempSessionId,
      activeProvider.name,
      modelSettings?.model,
      modelSettings?.routerAccountId,
      modelSettings?.routerPoolId,
      modelSettings?.routerPolicy,
      modelSettings,
    );
    try {
      const start = activeProvider.startSession({
        routerLaunch,
        machineControl: modelSettings?.machineControl,
        desktopControlOrigin: modelSettings?.desktopControlOrigin,
        cwd: projectPath,
        // No initialMessage - queue will block until one is pushed
        ...(await this.instructionLaunchOptions(
          activeProvider.name,
          resumeSessionId,
          projectId,
          Boolean(sessionSandbox) || Boolean(modelSettings?.executor),
        )),
        resumeSessionId,
        resumeSessionAt: truncation.resumeSessionAt,
        resumeDropsTurn: truncation.resumeDropsTurn,
        permissionMode: effectiveMode,
        model: modelSettings?.model,
        serviceTier: modelSettings?.serviceTier,
        thinking: modelSettings?.thinking,
        effort: modelSettings?.effort,
        ...(compactAtContextTokenLimit === undefined
          ? {}
          : { compactAtContextTokenLimit }),
        ...(launchCompactPercentOverride === undefined
          ? {}
          : { launchCompactPercentOverride }),
        claudeSteerBackgroundBash:
          this.getClaudeSteerBackgroundBashSettings?.(),
        restoredGoal: this.readRestoredGoal(resumeSessionId),
        clientName: modelSettings?.clientName,
        executor: modelSettings?.executor,
        remoteEnv: modelSettings?.remoteEnv,
        globalInstructions: modelSettings?.globalInstructions,
        getSessionChildEnv: this.getSessionChildEnv
          ? (sessionId) =>
              this.getSessionChildEnv?.(sessionId, modelSettings?.executor) ??
              {}
          : undefined,
        agentServerEnvironment: agentServerEnvironment(agentServerAccess),
        sessionSandbox,
        sessionSandboxOptions,
        shouldEmitLiveDeltas: () =>
          processHolder.process?.hasLiveDeltaSubscribers() ?? false,
        onPermissionModeApplied: (mode) =>
          processHolder.process?.setAppliedPermissionMode(mode),
        onProviderRetentionChange: () =>
          this.handleProviderRetentionChanged(processHolder),
        onToolApproval: async (toolName, input, opts) => {
          if (!processHolder.process) {
            return { behavior: "deny", message: "Process not ready" };
          }
          return processHolder.process.handleToolApproval(
            toolName,
            input,
            opts,
          );
        },
      });
      const result = await this.settleProviderStart(
        start,
        retryProviderStartupFailure || requireProviderSessionId,
      );

      const {
        iterator,
        queue,
        abort,
        detachForServerReload,
        activateCallbacks,
        isProcessAlive,
        probeLiveness,
        getProviderActivity,
        getProviderRetention,
        setMaxThinkingTokens,
        setEffort,
        interrupt,
        steer,
        steerUsesMessageQueue,
        supportedModels,
        supportedCommands,
        setModel,
        runProviderCommand,
        publishAgentctlSessionId,
      } = result;

      const options: ProcessConstructorOptions = {
        projectPath,
        projectId,
        sessionId: tempSessionId,
        initialState: "idle",
        idleTimeoutMs: this.idleTimeoutMs,
        projectDisplayName: this.projectDisplayName,
        queue,
        sessionQueuePersistenceService: this.sessionQueuePersistenceService,
        toolResultMediaStore: this.toolResultMediaStore,
        abortFn: abort,
        detachForServerReloadFn: detachForServerReload,
        isProcessAlive,
        shouldRetainIdleProcess: (sessionId) =>
          this.shouldRetainIdleProcess(sessionId),
        initialProviderRuntimeStatus: resumeSessionId
          ? this.terminalProviderStatuses.get(resumeSessionId)
          : null,
        probeLivenessFn: probeLiveness,
        getProviderActivityFn: getProviderActivity,
        getProviderRetentionFn: getProviderRetention,
        getRuntimeUnviewedSinceFn: result.getRuntimeUnviewedSince,
        setRuntimeViewerPresenceFn: result.setRuntimeViewerPresence,
        refreshPromptCacheFn: result.refreshPromptCache,
        isAutomationPaused: () =>
          this.isAutomationPausedUntilUserTurn(
            resumeSessionId ?? tempSessionId,
          ),
        pid: () => {
          const p = result.pid;
          return typeof p === "function" ? p() : p;
        },
        setMaxThinkingTokensFn: setMaxThinkingTokens,
        publishAgentSelfSelectionFn: result.publishAgentSelfSelection,
        setEffortFn: setEffort,
        effortUpdatesActiveTurn: result.effortUpdatesActiveTurn,
        interruptFn: interrupt,
        steerFn: steer,
        steerUsesMessageQueue,
        supportedModelsFn: supportedModels,
        getContextBreakdownFn: result.getContextBreakdown,
        supportedCommandsFn: supportedCommands,
        onCommandsObserved: (sessionId, commands) =>
          this.sessionMetadataService?.observeCommandInventory(
            sessionId,
            commands,
          ) ?? Promise.resolve(),
        setModelFn: setModel,
        runProviderCommandFn: runProviderCommand,
        providerInitializesOnFirstMessage:
          activeProvider.initializesOnFirstMessage === true,
        appendConversationContextFn: result.appendConversationContext,
        initializedSessionId: result.initializedSessionId,
        publishAgentctlSessionIdFn: publishAgentctlSessionId,
        permissionMode: effectiveMode,
        provider: activeProvider.name,
        model: modelSettings?.model,
        requestedModel: modelSettings?.requestedModel,
        gatewayServiceId: result.gatewayServiceId,
        compactAtContextPercent: modelSettings?.compactAtContextPercent,
        compactAtContextWindow: modelSettings?.compactAtContextWindow,
        forceYaOrchestratedCompaction:
          modelSettings?.forceYaOrchestratedCompaction,
        compactAtContextTokenLimit,
        launchCompactPercentOverride,
        serviceTier: modelSettings?.serviceTier,
        thinking: modelSettings?.thinking,
        effort: modelSettings?.effort,
        executor: modelSettings?.executor,
        execution: result.execution,
        permissions: modelSettings?.permissions,
        recapMode: modelSettings?.recapMode,
        recapAfterSeconds: modelSettings?.recapAfterSeconds,
        promptSuggestionMode,
        helperSideModel: modelSettings?.helperSideModel,
        sandboxEnforcement: sessionSandbox?.enforcement,
        sandboxStateKey: sessionSandbox?.stateKey,
        sandboxProjectPath: sessionSandbox?.projectPath,
      };

      const process = new Process(iterator, options);
      processHolder.process = process;
      this.holdAgentServerAccess(process, agentServerAccess);
      this.instructionSessions.set(process, result);
      this.observeProcessEvents(process);
      activateCallbacks?.();
      await this.consumePendingRewind(process, resumeSessionId, truncation);

      // Wait for the real session ID from the provider
      if (!resumeSessionId) {
        await this.settleProviderSessionId(process, requireProviderSessionId);
      }
      if (sessionSandbox) {
        await this.persistProcessSandboxOrAbort(process);
      }

      if (routerLaunch && tempSessionId !== process.sessionId) {
        try {
          await this.sessionMetadataService!.remapSessionId(
            tempSessionId,
            process.sessionId,
          );
        } catch (error) {
          await process.abort();
          throw error;
        }
      }

      await this.activationCoordinator.persistSuccessfulSessionBoundaryOrAbort(
        process,
      );
      // Recreated processes for an existing session should not emit session-created again.
      this.registerProcess(process, !resumeSessionId);

      return process;
    } catch (error) {
      if (routerLaunch && !resumeSessionId) {
        // The connector retains pending cancellation durably if AAR is offline.
        await this.agentAuthRouter?.cancel(tempSessionId).catch(() => {});
      }
      throw error;
    }
  }

  /**
   * Start a session using the provider interface with full features.
   */
  private async startProviderSession(
    projectPath: string,
    projectId: UrlProjectId,
    message: UserMessage,
    resumeSessionId?: string,
    permissionMode?: PermissionMode,
    modelSettings?: ModelSettings,
    provider?: AgentProvider,
    retryProviderStartupFailure = false,
    requireProviderSessionId = false,
  ): Promise<Process> {
    const activeProvider = provider ?? this.provider;
    if (!activeProvider) {
      throw new Error("provider is not available");
    }
    if (
      message.metadata?.turnEffort &&
      !["codex", "claude", "claude-gateway", "claude-ollama"].includes(
        activeProvider.name,
      )
    ) {
      throw new Error(
        "This provider does not support one-turn effort modifiers",
      );
    }
    if (!resumeSessionId) {
      await this.assertAuthoritativeNewSessionModel(
        activeProvider,
        modelSettings,
      );
    }

    // We need to reference process in the callback before it's assigned
    const processHolder: { process: Process | null } = { process: null };

    // Use provided mode or fall back to default
    const effectiveMode = permissionMode ?? this.defaultPermissionMode;
    const promptSuggestionMode = this.resolvePromptSuggestionMode(
      modelSettings?.promptSuggestionMode,
      activeProvider,
    );
    const compactAtContextTokenLimit = resolveNativeCompactTokenLimit(
      activeProvider,
      modelSettings,
    );
    const launchCompactPercentOverride = resolveLaunchCompactPercentOverride(
      activeProvider,
      modelSettings,
    );
    const tempSessionId = resumeSessionId ?? randomUUID();
    const sessionSandboxOptions = this.newSessionSandboxOptions(
      activeProvider.name,
      projectPath,
      modelSettings,
      resumeSessionId,
    );
    const sessionSandbox = await prepareSessionSandbox(sessionSandboxOptions);

    const agentServerAccess = this.agentServerAccessForLaunch(
      Boolean(sessionSandbox) ||
        modelSettings?.sandboxLevel === "project-write",
      modelSettings?.executor,
    );
    const truncation = this.resolveLaunchTruncation(
      resumeSessionId,
      activeProvider.name,
      modelSettings,
    );
    const routed =
      modelSettings?.routerAccountId ||
      modelSettings?.routerPoolId ||
      this.sessionMetadataService?.getMetadata(tempSessionId)?.routerBinding;
    if (
      routed &&
      (modelSettings?.executor ||
        sessionSandboxOptions?.level === "project-write")
    ) {
      throw new Error(
        "Router sessions require a local unsandboxed owner launch",
      );
    }
    if (
      modelSettings?.routerAccountId !== undefined &&
      (typeof modelSettings.routerAccountId !== "string" ||
        !/^[A-Za-z0-9_-]{1,128}$/.test(modelSettings.routerAccountId))
    )
      throw new Error("Invalid router account");
    if (
      modelSettings?.routerPoolId !== undefined &&
      (typeof modelSettings.routerPoolId !== "string" ||
        !/^[a-f0-9-]{36}$/.test(modelSettings.routerPoolId))
    )
      throw new Error("Invalid router pool");
    if (
      modelSettings?.routerPolicy !== undefined &&
      (!modelSettings.routerPoolId ||
        !["manual", "round-robin", "most-remaining"].includes(
          modelSettings.routerPolicy,
        ))
    )
      throw new Error("Invalid router policy");
    if (routed && !this.agentAuthRouter)
      throw new Error("Router integration unavailable");
    const routerLaunch = await this.agentAuthRouter?.launch(
      tempSessionId,
      activeProvider.name,
      modelSettings?.model,
      modelSettings?.routerAccountId,
      modelSettings?.routerPoolId,
      modelSettings?.routerPolicy,
      modelSettings,
    );
    try {
      const start = activeProvider.startSession({
        routerLaunch,
        machineControl: modelSettings?.machineControl,
        desktopControlOrigin: modelSettings?.desktopControlOrigin,
        cwd: projectPath,
        resumeSessionId,
        ...(await this.instructionLaunchOptions(
          activeProvider.name,
          resumeSessionId,
          projectId,
          Boolean(sessionSandbox) || Boolean(modelSettings?.executor),
        )),
        resumeSessionAt: truncation.resumeSessionAt,
        resumeDropsTurn: truncation.resumeDropsTurn,
        permissionMode: effectiveMode,
        model: modelSettings?.model,
        serviceTier: modelSettings?.serviceTier,
        thinking: modelSettings?.thinking,
        effort: modelSettings?.effort,
        ...(compactAtContextTokenLimit === undefined
          ? {}
          : { compactAtContextTokenLimit }),
        ...(launchCompactPercentOverride === undefined
          ? {}
          : { launchCompactPercentOverride }),
        claudeSteerBackgroundBash:
          this.getClaudeSteerBackgroundBashSettings?.(),
        restoredGoal: this.readRestoredGoal(resumeSessionId),
        executor: modelSettings?.executor,
        remoteEnv: modelSettings?.remoteEnv,
        globalInstructions: modelSettings?.globalInstructions,
        getSessionChildEnv: this.getSessionChildEnv
          ? (sessionId) =>
              this.getSessionChildEnv?.(sessionId, modelSettings?.executor) ??
              {}
          : undefined,
        agentServerEnvironment: agentServerEnvironment(agentServerAccess),
        sessionSandbox,
        sessionSandboxOptions,
        shouldEmitLiveDeltas: () =>
          processHolder.process?.hasLiveDeltaSubscribers() ?? false,
        onPermissionModeApplied: (mode) =>
          processHolder.process?.setAppliedPermissionMode(mode),
        onProviderRetentionChange: () =>
          this.handleProviderRetentionChanged(processHolder),
        onToolApproval: async (toolName, input, opts) => {
          if (!processHolder.process) {
            return { behavior: "deny", message: "Process not ready" };
          }
          return processHolder.process.handleToolApproval(
            toolName,
            input,
            opts,
          );
        },
      });
      const result = await this.settleProviderStart(
        start,
        retryProviderStartupFailure || requireProviderSessionId,
      );

      const {
        iterator,
        queue,
        abort,
        detachForServerReload,
        activateCallbacks,
        isProcessAlive,
        probeLiveness,
        getProviderActivity,
        getProviderRetention,
        setMaxThinkingTokens,
        setEffort,
        interrupt,
        steer,
        steerUsesMessageQueue,
        supportedModels,
        supportedCommands,
        setModel,
        runProviderCommand,
        publishAgentctlSessionId,
      } = result;

      const options: ProcessConstructorOptions = {
        projectPath,
        projectId,
        sessionId: tempSessionId,
        idleTimeoutMs: this.idleTimeoutMs,
        projectDisplayName: this.projectDisplayName,
        initialState: result.initialTurnState ?? "idle",
        queue,
        sessionQueuePersistenceService: this.sessionQueuePersistenceService,
        toolResultMediaStore: this.toolResultMediaStore,
        abortFn: abort,
        detachForServerReloadFn: detachForServerReload,
        isProcessAlive,
        shouldRetainIdleProcess: (sessionId) =>
          this.shouldRetainIdleProcess(sessionId),
        initialProviderRuntimeStatus: resumeSessionId
          ? this.terminalProviderStatuses.get(resumeSessionId)
          : null,
        probeLivenessFn: probeLiveness,
        getProviderActivityFn: getProviderActivity,
        getProviderRetentionFn: getProviderRetention,
        getRuntimeUnviewedSinceFn: result.getRuntimeUnviewedSince,
        setRuntimeViewerPresenceFn: result.setRuntimeViewerPresence,
        refreshPromptCacheFn: result.refreshPromptCache,
        isAutomationPaused: () =>
          this.isAutomationPausedUntilUserTurn(
            resumeSessionId ?? tempSessionId,
          ),
        pid: () => {
          const p = result.pid;
          return typeof p === "function" ? p() : p;
        },
        setMaxThinkingTokensFn: setMaxThinkingTokens,
        publishAgentSelfSelectionFn: result.publishAgentSelfSelection,
        setEffortFn: setEffort,
        effortUpdatesActiveTurn: result.effortUpdatesActiveTurn,
        interruptFn: interrupt,
        steerFn: steer,
        steerUsesMessageQueue,
        supportedModelsFn: supportedModels,
        getContextBreakdownFn: result.getContextBreakdown,
        supportedCommandsFn: supportedCommands,
        onCommandsObserved: (sessionId, commands) =>
          this.sessionMetadataService?.observeCommandInventory(
            sessionId,
            commands,
          ) ?? Promise.resolve(),
        setModelFn: setModel,
        runProviderCommandFn: runProviderCommand,
        providerInitializesOnFirstMessage:
          activeProvider.initializesOnFirstMessage === true,
        appendConversationContextFn: result.appendConversationContext,
        initializedSessionId: result.initializedSessionId,
        publishAgentctlSessionIdFn: publishAgentctlSessionId,
        permissionMode: effectiveMode,
        provider: activeProvider.name,
        model: modelSettings?.model,
        requestedModel: modelSettings?.requestedModel,
        gatewayServiceId: result.gatewayServiceId,
        compactAtContextPercent: modelSettings?.compactAtContextPercent,
        compactAtContextWindow: modelSettings?.compactAtContextWindow,
        forceYaOrchestratedCompaction:
          modelSettings?.forceYaOrchestratedCompaction,
        compactAtContextTokenLimit,
        launchCompactPercentOverride,
        serviceTier: modelSettings?.serviceTier,
        thinking: modelSettings?.thinking,
        effort: modelSettings?.effort,
        executor: modelSettings?.executor,
        execution: result.execution,
        permissions: modelSettings?.permissions,
        recapMode: modelSettings?.recapMode,
        recapAfterSeconds: modelSettings?.recapAfterSeconds,
        promptSuggestionMode,
        helperSideModel: modelSettings?.helperSideModel,
        sandboxEnforcement: sessionSandbox?.enforcement,
        sandboxStateKey: sessionSandbox?.stateKey,
        sandboxProjectPath: sessionSandbox?.projectPath,
      };

      const process = new Process(iterator, options);
      processHolder.process = process;
      this.holdAgentServerAccess(process, agentServerAccess);
      this.instructionSessions.set(process, result);
      this.observeProcessEvents(process);
      activateCallbacks?.();
      await this.consumePendingRewind(process, resumeSessionId, truncation);

      const queueBeforeProviderSettlement =
        !resumeSessionId && requireProviderSessionId;
      if (queueBeforeProviderSettlement) {
        await this.queueInitialProcessMessage(process, message);
      }

      // Wait for the real session ID from the provider before registering.
      // Message-driven providers only emit their init event after input arrives.
      if (!resumeSessionId) {
        await this.settleProviderSessionId(process, requireProviderSessionId);
      }
      if (sessionSandbox) {
        await this.persistProcessSandboxOrAbort(process);
      }

      if (!queueBeforeProviderSettlement) {
        await this.queueInitialProcessMessage(process, message);
      }

      if (routerLaunch && tempSessionId !== process.sessionId) {
        try {
          await this.sessionMetadataService!.remapSessionId(
            tempSessionId,
            process.sessionId,
          );
        } catch (error) {
          await process.abort();
          throw error;
        }
      }

      await this.activationCoordinator.persistSuccessfulSessionBoundaryOrAbort(
        process,
      );
      this.registerProcess(process, !resumeSessionId);

      return process;
    } catch (error) {
      if (routerLaunch && !resumeSessionId) {
        // The connector retains pending cancellation durably if AAR is offline.
        await this.agentAuthRouter?.cancel(tempSessionId).catch(() => {});
      }
      throw error;
    }
  }

  /**
   * Start a session using the legacy mock SDK.
   */
  private async startLegacySession(
    projectPath: string,
    projectId: UrlProjectId,
    message: UserMessage,
    resumeSessionId?: string,
    permissionMode?: PermissionMode,
    modelSettings?: ModelSettings,
  ): Promise<Process> {
    if (
      modelSettings?.routerAccountId ||
      modelSettings?.routerPoolId ||
      this.sessionMetadataService?.getMetadata(resumeSessionId ?? "")
        ?.routerBinding
    ) {
      throw new Error("Router sessions require a native provider adapter");
    }

    if (modelSettings?.sandboxLevel === "project-write") {
      throw new Error(
        "Project-write session sandboxing requires a local Claude or Codex provider runtime.",
      );
    }
    // sdk is guaranteed to exist here (checked in startSession)
    if (!this.sdk) {
      throw new Error("sdk is not available");
    }
    const iterator = this.sdk.startSession({
      cwd: projectPath,
      resume: resumeSessionId,
    });

    const sessionId = resumeSessionId ?? randomUUID();

    // Use provided mode or fall back to default
    const effectiveMode = permissionMode ?? this.defaultPermissionMode;

    const options: ProcessConstructorOptions = {
      projectPath,
      projectId,
      sessionId,
      idleTimeoutMs: this.idleTimeoutMs,
      projectDisplayName: this.projectDisplayName,
      permissionMode: effectiveMode,
      provider: "claude", // Legacy mock SDK simulates Claude
      model: modelSettings?.model,
      requestedModel: modelSettings?.requestedModel,
      compactAtContextPercent: modelSettings?.compactAtContextPercent,
      compactAtContextWindow: modelSettings?.compactAtContextWindow,
      forceYaOrchestratedCompaction:
        modelSettings?.forceYaOrchestratedCompaction,
      toolResultMediaStore: this.toolResultMediaStore,
    };

    const process = new Process(iterator, options);
    this.observeProcessEvents(process);

    // Queue the initial message
    process.queueMessage(message);

    await this.activationCoordinator.persistSuccessfulSessionBoundaryOrAbort(
      process,
    );
    this.registerProcess(process, !resumeSessionId);

    return process;
  }

  async resumeSession(
    sessionId: string,
    requestedProjectPath: string,
    message: UserMessage,
    permissionMode?: PermissionMode,
    requestedModelSettings?: ModelSettings,
    launchOptions?: SessionLaunchOptions,
  ): Promise<Process | QueuedResponse | QueueFullResponse> {
    const { projectPath, modelSettings } = this.withSettledSandbox(
      sessionId,
      requestedProjectPath,
      requestedModelSettings,
    );
    this.assertSessionSandboxSettings(modelSettings);
    await this.activationCoordinator.waitForActivation(sessionId);

    // Check if already have a process for this session
    const existingProcessId = this.sessionToProcess.get(sessionId);
    if (existingProcessId) {
      const existingProcess = this.processes.get(existingProcessId);
      if (existingProcess) {
        this.assertProviderOwnershipSettled(existingProcess, "resume");
        // Check if process is terminated - if so, start a fresh one
        if (existingProcess.isTerminated) {
          this.unregisterProcess(existingProcess);
        } else {
          this.assertProcessSandboxMatches(existingProcess, modelSettings);
          let restartExistingProcess = false;
          // Check if thinking/effort settings changed
          const thinkingWasRequested = modelSettings?.thinking !== undefined;
          const effortWasRequested =
            thinkingWasRequested || modelSettings?.effort !== undefined;
          const thinkingChanged =
            thinkingWasRequested &&
            !thinkingConfigsEqual(
              existingProcess.thinking,
              modelSettings?.thinking,
            );
          const effortChanged =
            effortWasRequested &&
            existingProcess.effort !== modelSettings?.effort;

          if (
            thinkingChanged ||
            effortChanged ||
            (modelSettings?.model &&
              modelSettings.model !== existingProcess.model)
          ) {
            await this.agentAuthRouter?.validateSessionSettings(
              sessionId,
              modelSettings?.model ?? existingProcess.model,
              {
                thinking: modelSettings?.thinking ?? existingProcess.thinking,
                effort: effortWasRequested
                  ? modelSettings?.effort
                  : existingProcess.effort,
              },
            );
          }
          if (thinkingChanged || effortChanged) {
            if (
              thinkingChanged &&
              !effortChanged &&
              canApplyThinkingConfigDynamically(
                existingProcess.thinking,
                modelSettings?.thinking,
              ) &&
              existingProcess.supportsThinkingModeChange
            ) {
              // Toggle adaptive/disabled dynamically via deprecated API
              const tokens =
                modelSettings?.thinking?.type === "disabled" ? 0 : 1;
              const changed = await existingProcess.setMaxThinkingTokens(
                tokens === 0 ? undefined : tokens,
              );
              if (changed) {
                existingProcess.updateThinkingConfig(
                  modelSettings?.thinking,
                  modelSettings?.effort,
                );
              } else {
                const log = getLogger();
                log.warn(
                  {
                    event: "thinking_mode_change_failed",
                    sessionId,
                    processId: existingProcess.id,
                  },
                  "Failed to change thinking mode dynamically",
                );
              }
            } else {
              // Effort changed or no dynamic support: restart process
              const log = getLogger();
              log.info(
                {
                  event: "thinking_mode_changed_restart",
                  sessionId,
                  processId: existingProcess.id,
                  oldThinking: existingProcess.thinking?.type,
                  oldThinkingDisplay:
                    existingProcess.thinking?.type === "adaptive" ||
                    existingProcess.thinking?.type === "enabled"
                      ? existingProcess.thinking.display
                      : undefined,
                  oldEffort: existingProcess.effort,
                  newThinking: modelSettings?.thinking?.type,
                  newThinkingDisplay:
                    modelSettings?.thinking?.type === "adaptive" ||
                    modelSettings?.thinking?.type === "enabled"
                      ? modelSettings.thinking.display
                      : undefined,
                  newEffort: modelSettings?.effort,
                },
                "Thinking/effort changed, restarting process",
              );
              await existingProcess.abort();
              this.unregisterProcess(existingProcess);
              restartExistingProcess = true;
              // Fall through to start a new session with the updated settings
            }
          }
          // Update permission mode if specified
          if (!restartExistingProcess && permissionMode) {
            existingProcess.setPermissionMode(permissionMode);
          }
          // Queue message to existing process (if we didn't fall through to restart)
          if (!restartExistingProcess && !existingProcess.isTerminated) {
            if (modelSettings?.resumeMode === "compact-first") {
              await this.queueAfterResumeCompaction({
                process: existingProcess,
                sessionId,
                message,
              });
              if (launchOptions?.requireProviderSessionId) {
                await this.settleProviderSessionId(existingProcess, true);
              }
              return existingProcess;
            }

            const result = await this.queueProcessMessage(
              existingProcess,
              message,
            );
            if (result.success) {
              if (launchOptions?.requireProviderSessionId) {
                await this.settleProviderSessionId(existingProcess, true);
              }
              return existingProcess;
            }
            // A rejected command is not evidence that the worker died.
            if (!existingProcess.isTerminated) {
              throw new SessionMessageRejectedError(
                result.error ?? "Failed to queue message",
              );
            }
            // Failed to queue to a terminated process; clean up and start fresh.
            // Idle teardown may have started during an awaited configuration step.
            this.assertProviderOwnershipSettled(existingProcess, "resume");
            this.unregisterProcess(existingProcess);
          }
        }
      }
    }

    // Check if there's already a queued request for this session
    const existingQueued = this.workerQueue.findBySessionId(sessionId);
    if (existingQueued) {
      // Already queued - return current position
      const position = this.workerQueue.getPosition(existingQueued.id);
      return {
        queued: true,
        queueId: existingQueued.id,
        position: position ?? 1,
      };
    }

    const projectId = encodeProjectId(projectPath);

    if (this.isAtCapacity() && !this.findPreemptableWorker()) {
      const result = this.workerQueue.enqueue({
        type: "resume-session",
        projectPath,
        projectId,
        sessionId,
        message,
        permissionMode,
        modelSettings,
      });
      if (isQueueFullError(result)) {
        return result;
      }
      return {
        queued: true,
        queueId: result.queueId,
        position: result.position,
      };
    }

    if (await this.activationCoordinator.waitForActivation(sessionId)) {
      return this.resumeSession(
        sessionId,
        projectPath,
        message,
        permissionMode,
        modelSettings,
        launchOptions,
      );
    }

    return this.activationCoordinator.startActivation(sessionId, async () => {
      if (this.isAtCapacity()) {
        const preemptable = this.findPreemptableWorker();
        if (preemptable) {
          await this.preemptWorker(preemptable);
        } else {
          throw new Error(
            "Cannot resume: server is at worker capacity and no idle process can be preempted",
          );
        }
      }

      const resolved =
        await this.activationCoordinator.resolveColdLaunchSettings(
          projectId,
          sessionId,
          permissionMode,
          modelSettings,
        );
      const provider = this.resolveProvider(resolved.modelSettings);
      const resumeMode = resolved.modelSettings.resumeMode ?? "full";

      let process: Process;

      // Use provider if available (preferred)
      if (provider) {
        if (resumeMode === "compact-first") {
          process = await this.startCompactFirstProviderResume(
            projectPath,
            projectId,
            message,
            sessionId,
            resolved.permissionMode,
            resolved.modelSettings,
            provider,
          );
        } else {
          process = await this.startProviderSession(
            projectPath,
            projectId,
            message,
            sessionId,
            resolved.permissionMode,
            resolved.modelSettings,
            provider,
          );
        }
      } else if (this.realSdk) {
        // Use real SDK if available
        if (resumeMode === "compact-first") {
          process = await this.startCompactFirstRealResume(
            projectPath,
            projectId,
            message,
            sessionId,
            resolved.permissionMode,
            resolved.modelSettings,
          );
        } else {
          process = await this.startRealSession(
            projectPath,
            projectId,
            message,
            sessionId,
            resolved.permissionMode,
            resolved.modelSettings,
          );
        }
      } else {
        // Fall back to legacy mock SDK
        if (resumeMode === "compact-first") {
          throw new ResumeCompactionError({
            sessionId,
            provider: "claude",
            attempt: {
              status: "unavailable",
              reason: "legacy mock SDK does not support compact-first resume",
            },
          });
        }

        process = await this.startLegacySession(
          projectPath,
          projectId,
          message,
          sessionId,
          resolved.permissionMode,
          resolved.modelSettings,
        );
      }

      if (launchOptions?.requireProviderSessionId) {
        await this.settleProviderSessionId(process, true, sessionId);
      }
      return process;
    });
  }

  /** Whether the resolved provider has a real transcript-fork primitive. */
  supportsForkSession(providerName?: ProviderName): boolean {
    const provider = this.resolveProvider(
      providerName ? { providerName } : undefined,
    );
    return typeof provider?.forkSession === "function";
  }

  /**
   * Fork a session's transcript into a new resumable session, optionally
   * sliced at a message UUID. Throws when the provider has no fork
   * primitive — fork must not be emulated (see
   * topics/session-context-actions.md).
   */
  async forkSession(options: {
    sessionId: string;
    projectPath: string;
    providerName?: ProviderName;
    upToMessageId?: string;
    boundary?: ProviderForkBoundary;
    title?: string;
    /** Explicit helper/successor choices; all other fields inherit. */
    launchOverrides?: SuccessorLaunchOverrides;
    /** Frozen source settings for a multi-stage fork job. */
    launchSettings?: EffectiveSessionLaunchSettingsValue;
    sandboxLevel?: SessionSandboxLevel;
    sandboxNetworkFirewall?: boolean;
    sandboxStateKey?: string;
  }): Promise<{
    sessionId: string;
    sandboxStateKey?: string;
    sessionSandbox?: Awaited<ReturnType<typeof prepareSessionSandbox>>;
    launchSettings: EffectiveSessionLaunchSettingsValue;
  }> {
    const provider = this.resolveProvider(
      options.providerName ? { providerName: options.providerName } : undefined,
    );
    if (!provider) {
      throw new Error("provider is not available");
    }
    if (
      this.sessionMetadataService?.getMetadata(options.sessionId)?.routerBinding
    )
      throw new Error(
        "Fork and clone of routed sessions are not supported yet",
      );
    if (typeof provider.forkSession !== "function") {
      throw new Error(`${provider.name} does not support transcript fork`);
    }
    let launchSettings =
      options.launchSettings ??
      (await this.resolveForkLaunchSettings(
        options.sessionId,
        options.projectPath,
        provider.name,
        options.launchOverrides,
      ));
    if (options.launchSettings && options.launchOverrides) {
      const launch = inheritSuccessorLaunchSettings(
        options.launchSettings,
        { sameProvider: true },
        options.launchOverrides,
      );
      launchSettings = {
        permissionMode: launch.permissionMode ?? this.defaultPermissionMode,
        requestedModel: launch.requestedModel ?? null,
        serviceTier: launch.serviceTier ?? null,
        thinking: launch.thinking ?? null,
        effort: launch.effort ?? null,
      };
    }
    const sessionSandbox = await prepareSessionSandbox({
      instructions: this.newSessionSandboxOptions(
        provider.name,
        options.projectPath,
        undefined,
        options.sessionId,
      ).instructions,
      level: options.sandboxLevel,
      networkFirewall: options.sandboxNetworkFirewall,
      provider: provider.name,
      projectPath: options.projectPath,
      stateKey: options.sandboxStateKey,
      stateRoot: this.sandboxStateRoot,
    });
    // A full copy of a session whose rewind has not yet been applied would
    // carry the dropped tail as its own tip and resume the dropped branch.
    // The SDK fork slices by file position and remaps uuids, so the rewind
    // records cannot travel with it; slicing at the cut yields exactly the
    // kept prefix instead (topics/session-rewind.md).
    const pendingCut =
      !options.upToMessageId && !options.boundary
        ? this.sessionMetadataService?.getPendingRewind?.(options.sessionId)
            ?.cutMessageId
        : undefined;
    const fork = await provider.forkSession({
      sessionId: options.sessionId,
      cwd: options.projectPath,
      upToMessageId: options.upToMessageId ?? pendingCut,
      boundary: options.boundary,
      title: options.title,
      sessionSandbox,
      launchSettings,
    });
    registerForkedSessionFile(provider.name, fork.sessionId, fork.filePath);
    // The new transcript is written by us. Announce it so file-activity
    // watchers do not read our own write as another program owning the
    // session (the amber external-writer warning).
    this.emitSessionForked(fork.sessionId, options.sessionId, {
      projectPath: options.projectPath,
    });
    await this.recordForkLaunchSettings(fork.sessionId, launchSettings);
    return {
      sessionId: fork.sessionId,
      sandboxStateKey: sessionSandbox?.stateKey,
      sessionSandbox,
      launchSettings,
    };
  }

  async resolveForkLaunchSettings(
    sessionId: string,
    projectPath: string,
    providerName: ProviderName,
    overrides: SuccessorLaunchOverrides = {},
  ): Promise<EffectiveSessionLaunchSettingsValue> {
    const projectId =
      this.sessionMetadataService?.getMetadata(sessionId)?.workingProjectId ??
      encodeProjectId(projectPath);
    const source = await this.activationCoordinator.snapshotLaunchSettings(
      projectId,
      sessionId,
      providerName,
    );
    let model = resolveInheritedForkModel(source.requestedModel ?? undefined);
    if (!model) {
      const summary = await this.onSessionSummary?.(sessionId, projectId);
      model = resolveInheritedForkModel(
        source.requestedModel ?? undefined,
        summary?.model,
      );
    }
    const launch = inheritSuccessorLaunchSettings(
      source,
      { sameProvider: true },
      {
        ...overrides,
        requestedModel: overrides.requestedModel ?? model,
      },
    );
    return {
      permissionMode: launch.permissionMode ?? this.defaultPermissionMode,
      requestedModel: launch.requestedModel ?? null,
      serviceTier: launch.serviceTier ?? null,
      thinking: launch.thinking ?? null,
      effort: launch.effort ?? null,
    };
  }

  async recordForkLaunchSettings(
    sessionId: string,
    settings: EffectiveSessionLaunchSettingsValue,
  ): Promise<void> {
    try {
      await this.sessionMetadataService?.recordEffectiveLaunchSettings(
        sessionId,
        settings,
      );
    } catch (error) {
      getLogger().error(
        {
          event: "session_fork_settings_save_failed",
          sessionId,
          error: error instanceof Error ? error.message : String(error),
        },
        "A transcript child was created, but its settings could not be saved",
      );
      throw new ForkSettingsPersistenceError(sessionId, error);
    }
  }

  /**
   * Open the private Claude transcript directory a sandboxed session with
   * this state key and project uses, for a host-side transcript copy.
   */
  openClaudeSandboxTranscriptDirectory(options: {
    stateKey: string;
    projectPath: string;
  }): ReturnType<typeof openClaudeSandboxTranscriptDirectory> {
    return openClaudeSandboxTranscriptDirectory({
      ...options,
      stateRoot: this.sandboxStateRoot,
    });
  }

  async generateSummary(
    providerName: ProviderName | undefined,
    request: SummaryGenerationRequest,
  ): Promise<SummaryGenerationResult> {
    const provider = this.resolveProvider(
      providerName ? { providerName } : undefined,
    );
    if (!provider) {
      throw new Error("provider is not available");
    }
    if (typeof provider.generateSummary !== "function") {
      throw new Error(`${provider.name} does not support summary generation`);
    }
    return provider.generateSummary(request);
  }

  private async archiveHelperFork(
    childSessionId: string,
    sourceSessionId: string,
    title: string,
    providerName: ProviderName,
    process: Process,
  ): Promise<void> {
    if (!this.sessionMetadataService) {
      return;
    }
    await this.sessionMetadataService.updateMetadata(childSessionId, {
      title,
      archived: true,
      forkedFromSessionId: sourceSessionId,
    });
    this.eventBus?.emit({
      type: "session-metadata-changed",
      sessionId: childSessionId,
      title,
      archived: true,
      forkedFromSessionId: sourceSessionId,
      projectId: process.projectId,
      timestamp: new Date().toISOString(),
    });
    await this.sessionMetadataService.setProvider(childSessionId, providerName);
    await this.sessionMetadataService.setExecutor(
      childSessionId,
      process.executor,
    );
    await this.sessionMetadataService.setRequestedModel(
      childSessionId,
      process.requestedModel,
    );
    if (
      process.sandboxEnforcement?.effective === "project-write" &&
      process.sandboxStateKey
    ) {
      await this.sessionMetadataService.setSessionSandbox(childSessionId, {
        ...persistedSandboxFromProcess(process, providerName),
        level: "project-write",
      });
    }
  }

  private publishRecapListUpdate(
    process: Process,
    text: string,
    timestamp = new Date().toISOString(),
  ): void {
    if (!this.eventBus) {
      return;
    }
    const lastAgentText = formatAgentRecapExcerpt(text);
    if (!lastAgentText) {
      return;
    }
    const event: SessionUpdatedEvent = {
      type: "session-updated",
      sessionId: process.sessionId,
      projectId: process.projectId,
      updatedAt: timestamp,
      lastAgentText,
      timestamp: new Date().toISOString(),
    };
    this.eventBus.emit(event);
  }

  private async persistRecapOverlay(
    process: Process,
    message: NonNullable<RecapRequestResult["syntheticMessage"]>,
  ): Promise<void> {
    if (!this.sessionMetadataService) {
      return;
    }
    try {
      await this.sessionMetadataService.addRecapMessage(
        process.sessionId,
        message,
      );
    } catch (error) {
      getLogger().warn(
        {
          event: "session_recap_overlay_persist_failed",
          sessionId: process.sessionId,
          processId: process.id,
          projectId: process.projectId,
          error: error instanceof Error ? error.message : String(error),
        },
        `Failed to persist recap overlay: ${process.sessionId}`,
      );
    }
  }

  private async handleRecapResult(
    process: Process,
    result: RecapRequestResult,
  ): Promise<void> {
    if (result.syntheticMessage) {
      await this.persistRecapOverlay(process, result.syntheticMessage);
    }
    if (result.emitted && result.text) {
      this.publishRecapListUpdate(
        process,
        result.text,
        result.syntheticMessage?.timestamp,
      );
    }
  }

  /**
   * Raise a recap's "summarize since" floor to the latest already-emitted
   * recap for the session. A recap covers the transcript through (about) its
   * own timestamp, so a second return event with no assistant output after
   * the last recap has nothing new to say — regenerating the same summary
   * from the same context is wasted work and stacks duplicate recap rows.
   */
  private recapFloorMs(
    sessionId: string,
    sinceMs: number | null,
  ): number | null {
    const recaps = this.sessionMetadataService?.getRecapMessages(sessionId);
    const latest = recaps ? latestRecapMessage(recaps) : undefined;
    const lastRecapMs = latest ? messageTimestampMs(latest) : null;
    if (lastRecapMs === null) {
      return sinceMs;
    }
    return sinceMs === null ? lastRecapMs : Math.max(sinceMs, lastRecapMs);
  }

  private async requestForkedRecap(
    process: Process,
    provider: AgentProvider,
    sinceMs: number | null,
    options?: { revived?: boolean },
  ): Promise<RecapRequestResult> {
    if (!provider.supportsRecaps || !provider.generateSummary) {
      return {
        supported: false,
        emitted: false,
        reason: "provider does not support recaps",
      };
    }
    sinceMs = this.recapFloorMs(process.sessionId, sinceMs);
    if (
      this.sessionMetadataService?.getMetadata(process.sessionId)?.routerBinding
    )
      return {
        supported: false,
        emitted: false,
        reason: "Separate helpers are unavailable for routed sessions",
      };
    if (typeof provider.forkSession !== "function") {
      return process.requestTailedRecapFallback(provider, { sinceMs });
    }
    if (this.forkedRecapInFlight.has(process.id)) {
      return {
        supported: true,
        emitted: false,
        reason: "recap already in flight",
      };
    }
    if (process.state.type === "in-turn") {
      this.pendingForkedRecapRequests.set(process.id, sinceMs);
      return {
        supported: true,
        emitted: false,
        reason: "recap deferred until turn completes",
      };
    }

    // A process freshly revived for this recap has an empty in-memory recap
    // buffer (it never streamed) and will not emit a native away_summary on its
    // own, so the native wait and the recent-text emptiness gate below would
    // both wrongly suppress. Skip them: the fork reads the transcript from disk,
    // and its own empty-text fallback handles a genuinely empty transcript.
    if (options?.revived !== true) {
      const nativeRecap = await process.waitForNativeRecapSince(
        sinceMs,
        provider.supportsNativeRecaps ? NATIVE_RECAP_FALLBACK_GRACE_MS : 0,
      );
      if (nativeRecap) {
        return {
          supported: true,
          emitted: true,
          reason: "native recap emitted",
          text: nativeRecap.text,
        };
      }

      const recent = process.getRecentAssistantText(sinceMs);
      if (recent.length === 0) {
        return {
          supported: true,
          emitted: false,
          reason: "no recent assistant activity to summarize",
        };
      }
    }

    const abortController = new AbortController();
    this.forkedRecapInFlight.set(process.id, abortController);
    let generatorSessionId: string | undefined;
    try {
      const generator = await this.forkSession({
        sessionId: process.sessionId,
        projectPath: process.sandboxProjectPath ?? process.projectPath,
        providerName: process.provider,
        title: "Recap generator",
        sandboxLevel: process.sandboxEnforcement?.effective,
        sandboxStateKey: process.sandboxStateKey,
      });
      generatorSessionId = generator.sessionId;
      await this.archiveHelperFork(
        generator.sessionId,
        process.sessionId,
        "Recap generator",
        process.provider,
        process,
      );
      const text = (
        await provider.generateSummary({
          purpose: "recap",
          strategy: "fork",
          generatorSessionId: generator.sessionId,
          cwd: process.projectPath,
          model:
            generator.launchSettings.requestedModel ??
            resolveInheritedForkModel(
              process.requestedModel,
              process.resolvedModel,
              process.model,
            ),
          signal: abortController.signal,
          sessionSandbox: generator.sessionSandbox,
        })
      ).text.trim();
      if (!text) {
        return process.requestTailedRecapFallback(provider, { sinceMs });
      }
      const lateNativeRecap = process.getNativeRecapSince(sinceMs);
      if (lateNativeRecap) {
        return {
          supported: true,
          emitted: true,
          reason: "native recap emitted",
          text: lateNativeRecap.text,
        };
      }
      const syntheticMessage = process.emitSyntheticSystemMessage(
        "away_summary",
        text,
      );
      return { supported: true, emitted: true, text, syntheticMessage };
    } catch (error) {
      // Cancellation on parent activity is expected, not a failure.
      if (abortController.signal.aborted) {
        const nativeRecap = process.getNativeRecapSince(sinceMs);
        if (nativeRecap) {
          return {
            supported: true,
            emitted: true,
            reason: "native recap emitted",
            text: nativeRecap.text,
          };
        }
        return {
          supported: true,
          emitted: false,
          reason: "recap cancelled by new activity",
        };
      }
      const reason = error instanceof Error ? error.message : String(error);
      getLogger().warn(
        {
          event: "session_forked_recap_failed",
          sessionId: process.sessionId,
          processId: process.id,
          projectId: process.projectId,
          providerName: process.provider,
          generatorSessionId,
          error: reason,
        },
        `Forked recap generation failed: ${reason}`,
      );
      return process.requestTailedRecapFallback(provider, { sinceMs });
    } finally {
      this.forkedRecapInFlight.delete(process.id);
    }
  }

  /**
   * Parent became active again: abort any in-flight forked recap (cancelling
   * the generator-fork helper turn) and drop a not-yet-started deferred
   * request, so a returning user's new turn is never shadowed by a stale
   * recap. See topics/fork-recap.md.
   */
  private cancelInFlightForkedRecap(process: Process): void {
    const abortController = this.forkedRecapInFlight.get(process.id);
    if (abortController && !abortController.signal.aborted) {
      abortController.abort();
    }
    this.pendingForkedRecapRequests.delete(process.id);
  }

  private flushPendingForkedRecapRequest(process: Process): void {
    if (
      this.isAutomationPausedUntilUserTurn(process.sessionId) ||
      process.recapMode !== "fork" ||
      process.state.type !== "idle" ||
      this.forkedRecapInFlight.has(process.id) ||
      !this.pendingForkedRecapRequests.has(process.id)
    ) {
      return;
    }
    const sinceMs = this.pendingForkedRecapRequests.get(process.id) ?? null;
    this.pendingForkedRecapRequests.delete(process.id);
    const provider = this.resolveProvider({ providerName: process.provider });
    if (!provider) {
      return;
    }
    void this.requestForkedRecap(process, provider, sinceMs).then((result) =>
      this.handleRecapResult(process, result),
    );
  }

  isRecapPausedUntilUserTurn(sessionId: string): boolean {
    return (
      this.recapPausedSessionIds.has(sessionId) ||
      this.sessionMetadataService?.getMetadata(sessionId)
        ?.recapPausedUntilUserTurn === true
    );
  }

  isAutomationPausedUntilUserTurn(sessionId: string): boolean {
    return this.sessionDone.isAutomationPausedUntilUserTurn(sessionId);
  }

  async requestSessionDone(
    sessionId: string,
    command: SyntheticSessionBoundaryCommand = "/done",
  ): Promise<SessionDoneResult> {
    return this.sessionDone.requestSessionDone(sessionId, command);
  }

  async requestSessionBoundaryAndAbort(
    sessionId: string,
    command: SyntheticSessionBoundaryCommand = "/done",
  ): Promise<
    SessionDoneResult & {
      termination: ProcessAbortResult | null;
      resumeExemption?: ResumeExemptionResult;
    }
  > {
    let boundary: SessionDoneResult;
    try {
      boundary = await this.sessionDone.requestSessionBoundaryForStop(
        sessionId,
        command,
      );
    } catch (error) {
      // Once the pending boundary is durable, stop still owns process cleanup
      // even if transcript promotion or read-state persistence failed.
      const hasDurableBoundary =
        this.sessionMetadataService?.getMetadata(sessionId)
          ?.pendingSyntheticDone !== undefined;
      if (hasDurableBoundary) {
        try {
          await this.stopBoundaryProcess(sessionId, command);
        } catch (shutdownError) {
          throw new AggregateError(
            [error, shutdownError],
            `Failed to finalize and stop ${command} for session ${sessionId}`,
          );
        }
      }
      throw error;
    }
    const { termination, resumeExemption } = await this.stopBoundaryProcess(
      sessionId,
      command,
    );
    return {
      message: boundary.message,
      paused: true,
      queued: false,
      termination,
      ...(resumeExemption ? { resumeExemption } : {}),
    };
  }

  private async stopBoundaryProcess(
    sessionId: string,
    command: SyntheticSessionBoundaryCommand,
  ): Promise<{
    termination: ProcessAbortResult | null;
    resumeExemption?: ResumeExemptionResult;
  }> {
    let resumeExemption: ResumeExemptionResult | undefined;
    if (command === "/terminate") {
      try {
        resumeExemption = await this.disableSessionAutoResume(sessionId);
      } catch (error) {
        resumeExemption = {
          heartbeatDisabled: false,
          autoResumeDisabled: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }
    const termination = await this.abortSessionWithVerification(sessionId);
    return {
      termination,
      ...(resumeExemption ? { resumeExemption } : {}),
    };
  }

  async disableSessionAutoResume(
    sessionId: string,
  ): Promise<ResumeExemptionResult> {
    const metadata = this.sessionMetadataService;
    if (!metadata) {
      throw new Error("Session metadata service is unavailable");
    }
    const heartbeatWasEnabled =
      metadata.getMetadata(sessionId)?.heartbeatTurnsEnabled === true;
    await metadata.updateMetadata(sessionId, {
      heartbeatTurnsEnabled: false,
      autoResumeDisabled: true,
    });
    return {
      heartbeatDisabled: heartbeatWasEnabled,
      autoResumeDisabled: true,
    };
  }

  private async finalizePendingDone(
    process: Process,
  ): Promise<DurableSyntheticDoneMessage | null> {
    return this.sessionDone.finalizePendingDone(process);
  }

  async pauseSessionAutomation(sessionId: string): Promise<void> {
    await this.sessionDone.pauseSessionAutomation(sessionId);
    await this.refreshInstructionRestoration(
      this.getProcessForSession(sessionId),
    );
  }

  private resumeAutomationAfterUserTurn(process: Process): void {
    this.sessionDone.resumeAfterUserTurn(process);
    void this.refreshInstructionRestoration(process);
  }

  async pauseRecapsUntilUserTurn(processId: string): Promise<boolean> {
    const process = this.processes.get(processId);
    if (!process) {
      return false;
    }

    process.pauseRecapsUntilUserTurn();
    this.cancelInFlightForkedRecap(process);
    this.recapPausedSessionIds.add(process.sessionId);
    try {
      await this.sessionMetadataService?.updateMetadata(process.sessionId, {
        recapPausedUntilUserTurn: true,
      });
    } catch (error) {
      getLogger().warn(
        {
          event: "session_recap_pause_persistence_failed",
          sessionId: process.sessionId,
          processId: process.id,
          projectId: process.projectId,
          error: error instanceof Error ? error.message : String(error),
        },
        "Failed to persist recap pause",
      );
    }
    return true;
  }

  private resumeRecapsAfterUserTurn(process: Process): void {
    if (!this.isRecapPausedUntilUserTurn(process.sessionId)) {
      return;
    }

    this.recapPausedSessionIds.delete(process.sessionId);
    void this.sessionMetadataService
      ?.updateMetadata(process.sessionId, {
        recapPausedUntilUserTurn: false,
      })
      .catch((error) => {
        getLogger().warn(
          {
            event: "session_recap_resume_persistence_failed",
            sessionId: process.sessionId,
            processId: process.id,
            projectId: process.projectId,
            error: error instanceof Error ? error.message : String(error),
          },
          "Failed to persist recap resume",
        );
      });
  }

  getProcess(processId: string): Process | undefined {
    return this.processes.get(processId);
  }

  private async restartProcessWithConfiguration(
    process: Process,
    projectPath: string,
    permissionMode: PermissionMode,
    settings: ModelSettings,
  ): Promise<Process | null> {
    const effectiveProvider = this.resolveProvider(settings);
    if (!effectiveProvider) return null;
    this.assertSessionSandboxSettings(settings);

    await process.abort();
    this.unregisterProcess(process);
    return this.createProviderSession(
      projectPath,
      process.projectId,
      permissionMode,
      settings,
      effectiveProvider,
      process.sessionId,
    );
  }

  reconfigureProcess(
    processId: string,
    updates: ModelSettings,
  ): Promise<Process | null> {
    return this.activationCoordinator.reconfigureProcess(processId, updates);
  }

  configureProcessRecaps(
    processId: string,
    config: {
      recapMode?: RecapMode;
      recapAfterSeconds?: number;
      helperSideModel?: string;
    },
  ): Process | null {
    const process = this.getProcess(processId);
    if (
      !process ||
      process.isTerminated ||
      process.hasUnverifiedProviderOwnership
    ) {
      return null;
    }
    const sandboxError = getSessionSandboxSettingsError(
      process.sandboxEnforcement?.effective,
      config.recapMode,
    );
    if (sandboxError) {
      throw new Error(sandboxError);
    }
    process.setRecapConfig(config);
    this.emitOwnershipChange(
      process.sessionId,
      process.projectId,
      sessionOwnershipFromProcess(process),
    );
    return process;
  }

  getProcessForSession(sessionId: string): Process | undefined {
    const processId = this.sessionToProcess.get(sessionId);
    if (!processId) return undefined;
    return this.processes.get(processId);
  }

  /**
   * Durable session state for projections a live subscription must build from
   * the same sources the request routes use — a queued boundary outlives the
   * Process that requested it.
   */
  getSessionMetadataService(): SessionMetadataService | undefined {
    return this.sessionMetadataService;
  }

  getProviderRuntimeStatusForSession(sessionId: string): ProviderRuntimeStatus {
    return (
      this.getProcessForSession(sessionId)?.getProviderRuntimeStatus() ??
      this.terminalProviderStatuses.get(sessionId) ??
      null
    );
  }

  private retainTerminalProviderStatus(
    sessionId: string,
    status: Extract<Exclude<ProviderRuntimeStatus, null>, { kind: "terminal" }>,
  ): void {
    refreshLruMap(this.terminalProviderStatuses, sessionId, status);
    while (
      this.terminalProviderStatuses.size > MAX_TERMINAL_PROVIDER_STATUSES
    ) {
      const oldestSessionId = this.terminalProviderStatuses.keys().next().value;
      if (typeof oldestSessionId !== "string") break;
      this.terminalProviderStatuses.delete(oldestSessionId);
    }
  }

  private clearTerminalProviderStatus(
    sessionId: string,
    projectId: UrlProjectId,
  ): void {
    if (!this.terminalProviderStatuses.delete(sessionId)) {
      return;
    }
    this.emitProviderRuntimeStatusChange(sessionId, projectId, null);
  }

  /**
   * Queue a message to an existing session, applying live configuration when
   * the provider supports it and otherwise restarting with the new settings.
   *
   * @returns The process (possibly new), or an error object
   */
  async queueMessageToSession(
    sessionId: string,
    projectPath: string,
    message: UserMessage,
    permissionMode?: PermissionMode,
    modelSettings?: ModelSettings,
  ): Promise<
    | { success: true; process: Process; restarted: boolean }
    | { success: false; error: string }
  > {
    const process = this.getProcessForSession(sessionId);
    if (!process) {
      return { success: false, error: "No active process for session" };
    }

    if (process.isTerminated) {
      return { success: false, error: "Process terminated" };
    }

    // Record delivery intent at the ingress boundary, before the dynamic
    // thinking/effort/service-tier updates below can await. An idle-threshold
    // compaction check that is mid-flight must observe that a turn has arrived
    // and yield, even while the process still reports `idle` during those
    // awaits.
    process.noteInputIntent();

    const isActiveSteeringMessage =
      message.metadata?.deliveryIntent === "steer" &&
      process.state.type === "in-turn";
    const hasExplicitThinkingSettings =
      modelSettings?.thinking !== undefined ||
      modelSettings?.effort !== undefined;
    const requestedThinking = isActiveSteeringMessage
      ? process.thinking
      : hasExplicitThinkingSettings
        ? modelSettings?.thinking
        : process.thinking;
    const requestedEffort = isActiveSteeringMessage
      ? process.effort
      : hasExplicitThinkingSettings
        ? modelSettings?.effort
        : process.effort;
    const requestedServiceTier = isActiveSteeringMessage
      ? process.serviceTier
      : (modelSettings?.serviceTier ?? process.serviceTier);
    const hasExplicitCompactSettings =
      modelSettings !== undefined &&
      (Object.hasOwn(modelSettings, "compactAtContextPercent") ||
        Object.hasOwn(modelSettings, "compactAtContextWindow") ||
        Object.hasOwn(modelSettings, "forceYaOrchestratedCompaction"));
    const requestedCompactSettings = isActiveSteeringMessage
      ? {
          compactAtContextPercent: process.compactAtContextPercent,
          compactAtContextWindow: process.compactAtContextWindow,
          forceYaOrchestratedCompaction: process.forceYaOrchestratedCompaction,
        }
      : hasExplicitCompactSettings
        ? {
            compactAtContextPercent: modelSettings?.compactAtContextPercent,
            compactAtContextWindow: modelSettings?.compactAtContextWindow,
            forceYaOrchestratedCompaction:
              modelSettings?.forceYaOrchestratedCompaction,
          }
        : {
            compactAtContextPercent: process.compactAtContextPercent,
            compactAtContextWindow: process.compactAtContextWindow,
            forceYaOrchestratedCompaction:
              process.forceYaOrchestratedCompaction,
          };
    const effectiveProvider = this.resolveProvider({
      providerName: process.provider,
    });
    const requestedCompactTokenLimit = isActiveSteeringMessage
      ? process.compactAtContextTokenLimit
      : resolveNativeCompactTokenLimit(
          effectiveProvider,
          requestedCompactSettings,
        );
    const compactThresholdChanged =
      hasExplicitCompactSettings &&
      !isActiveSteeringMessage &&
      process.compactAtContextTokenLimit !== requestedCompactTokenLimit;
    const hasExplicitLaunchCompactPercentOverride =
      modelSettings !== undefined &&
      Object.hasOwn(modelSettings, "claudeAutoCompactPercentOverride");
    const requestedLaunchCompactPercentOverride = isActiveSteeringMessage
      ? process.launchCompactPercentOverride
      : hasExplicitLaunchCompactPercentOverride
        ? resolveLaunchCompactPercentOverride(effectiveProvider, modelSettings)
        : process.launchCompactPercentOverride;
    const launchCompactPercentOverrideChanged =
      hasExplicitLaunchCompactPercentOverride &&
      !isActiveSteeringMessage &&
      process.launchCompactPercentOverride !==
        requestedLaunchCompactPercentOverride;

    // Check if service tier/thinking/effort/launch compaction settings changed.
    // Service tier is cost-affecting, so changes require an explicit restart
    // rather than being inferred from a normal prompt.
    const serviceTierChanged = process.serviceTier !== requestedServiceTier;
    const thinkingChanged = !thinkingConfigsEqual(
      process.thinking,
      requestedThinking,
    );
    const effortChanged = process.effort !== requestedEffort;

    if (
      serviceTierChanged ||
      thinkingChanged ||
      effortChanged ||
      compactThresholdChanged ||
      launchCompactPercentOverrideChanged
    ) {
      if (
        !serviceTierChanged &&
        !compactThresholdChanged &&
        !launchCompactPercentOverrideChanged &&
        thinkingChanged &&
        !effortChanged &&
        canApplyThinkingConfigDynamically(
          process.thinking,
          requestedThinking,
        ) &&
        process.supportsThinkingModeChange
      ) {
        // Toggle thinking dynamically via deprecated API (works for auto↔off)
        const tokens = requestedThinking?.type === "disabled" ? 0 : 1;
        const changed = await process.setMaxThinkingTokens(
          tokens === 0 ? undefined : tokens,
        );
        if (changed) {
          process.updateThinkingConfig(requestedThinking, requestedEffort);
        } else {
          const log = getLogger();
          log.warn(
            {
              event: "thinking_mode_change_failed_queue",
              sessionId,
              processId: process.id,
            },
            "Failed to change thinking mode dynamically on queue",
          );
        }
      } else if (
        !serviceTierChanged &&
        !compactThresholdChanged &&
        !launchCompactPercentOverrideChanged &&
        !thinkingChanged &&
        effortChanged &&
        process.supportsEffortChange
      ) {
        const changed = await process.setEffort(requestedEffort);
        if (!changed) {
          throw new Error("Provider did not apply the effort change");
        }
      } else {
        // Launch-scoped configuration changed or no dynamic support: restart.
        const log = getLogger();
        log.info(
          {
            event: "launch_scoped_settings_changed_queue_restart",
            sessionId,
            processId: process.id,
            oldThinking: process.thinking?.type,
            oldEffort: process.effort,
            oldServiceTier: process.serviceTier,
            newThinking: requestedThinking?.type,
            newEffort: requestedEffort,
            newServiceTier: requestedServiceTier,
            oldCompactAtContextTokenLimit: process.compactAtContextTokenLimit,
            newCompactAtContextTokenLimit: requestedCompactTokenLimit,
            oldLaunchCompactPercentOverride:
              process.launchCompactPercentOverride,
            newLaunchCompactPercentOverride:
              requestedLaunchCompactPercentOverride,
          },
          "Launch-scoped session settings changed on queue, restarting process",
        );

        await process.abort();
        this.unregisterProcess(process);

        const restartModelSettings: ModelSettings = {
          ...modelSettings,
          ...requestedCompactSettings,
          claudeAutoCompactPercentOverride:
            requestedLaunchCompactPercentOverride,
          serviceTier: requestedServiceTier,
          recapMode: modelSettings?.recapMode ?? process.recapMode,
          recapAfterSeconds:
            modelSettings?.recapAfterSeconds ?? process.recapAfterSeconds,
          promptSuggestionMode:
            modelSettings?.promptSuggestionMode ?? process.promptSuggestionMode,
          helperSideModel:
            modelSettings?.helperSideModel ?? process.helperSideModel,
        };

        const result = await this.resumeSession(
          sessionId,
          projectPath,
          message,
          permissionMode,
          restartModelSettings,
        );

        if ("id" in result) {
          return { success: true, process: result, restarted: true };
        }
        return { success: false, error: "Request was queued or failed" };
      }
    }

    // Queue to existing process (dynamic thinking change already applied if needed)
    if (permissionMode) {
      process.setPermissionMode(permissionMode);
    }
    process.updateCompactThresholdSettings({
      percent: requestedCompactSettings.compactAtContextPercent,
      contextWindow: requestedCompactSettings.compactAtContextWindow,
      forceYaOrchestratedCompaction:
        requestedCompactSettings.forceYaOrchestratedCompaction,
    });

    const result = await this.queueProcessMessage(process, message);
    if (result.success) {
      return { success: true, process, restarted: false };
    }

    return { success: false, error: result.error ?? "Failed to queue message" };
  }

  async prepareForServerReload(process: Process): Promise<void> {
    await this.activationCoordinator.prepareForServerReload(process);
  }

  getAllProcesses(): Process[] {
    return Array.from(this.processes.values());
  }

  getIdleTimeoutMs(): number {
    return this.idleTimeoutMs;
  }

  updateIdleTimeoutMs(idleTimeoutMs: number): void {
    if (!Number.isFinite(idleTimeoutMs)) {
      throw new Error("Idle reap timeout must be finite");
    }
    this.idleTimeoutMs = idleTimeoutMs;
    for (const process of this.processes.values()) {
      process.updateIdleTimeoutMs(idleTimeoutMs);
    }
  }

  /**
   * One heartbeat generation. Every source reports the earliest instant it
   * could next need attention; the scheduler arms one timer for the earliest
   * of them. Returns null only when nothing on this server can become due
   * without an event, in which case no timer is armed at all.
   */
  private async runHeartbeatSweep(now: number): Promise<number | null> {
    if (this.backgroundTasksStopped) return null;
    const log = getLogger();
    let dueAtMs: number | null = null;

    for (const process of this.processes.values()) {
      if (this.backgroundTasksStopped) return null;
      if (this.isAutomationPausedUntilUserTurn(process.sessionId)) {
        continue;
      }
      const patient = this.queuePatientDeferredMessagesForProcess(
        process,
        now,
        log,
      );
      dueAtMs = earliestDueAt(dueAtMs, patient.dueAtMs);
      if (patient.promoted) {
        continue;
      }
      dueAtMs = earliestDueAt(
        dueAtMs,
        await this.queueHeartbeatTurnForProcess(process, now, log),
      );
    }

    // The candidate half reaches storage, so it keeps its own deadline rather
    // than riding along with whichever process deadline fired.
    const candidateDueAtMs = this.getCandidateSweepDueAtMs();
    if (candidateDueAtMs !== null && now >= candidateDueAtMs) {
      this.heartbeatCandidateDueAtMs = await this.sweepHeartbeatCandidates(
        now,
        log,
      );
    }
    return earliestDueAt(dueAtMs, this.getCandidateSweepDueAtMs());
  }

  /** Null when no candidate source is configured, or none can become due. */
  private getCandidateSweepDueAtMs(): number | null {
    if (!this.getHeartbeatTurnCandidates) return null;
    return this.heartbeatCandidateDueAtMs;
  }

  private async sweepHeartbeatCandidates(
    now: number,
    log: ReturnType<typeof getLogger>,
  ): Promise<number | null> {
    let dueAtMs: number | null = null;
    const candidates = (await this.getHeartbeatTurnCandidates?.()) ?? [];
    for (const candidate of candidates) {
      if (this.backgroundTasksStopped) return null;
      dueAtMs = earliestDueAt(
        dueAtMs,
        await this.queueHeartbeatTurnForCandidate(candidate, now, log),
      );
    }
    // A candidate whose transcript has settled can still gain a pending tool
    // call from an external process. It could not be actioned before one idle
    // threshold from now, so that is exactly how long the next look can wait.
    for (const sessionId of this.getHeartbeatWaitingSessionIds?.() ?? []) {
      dueAtMs = earliestDueAt(
        dueAtMs,
        now + this.getHeartbeatIdleThresholdMs(sessionId),
      );
    }
    return dueAtMs;
  }

  private getHeartbeatIdleThresholdMs(sessionId: string): number {
    return (
      clampHeartbeatAfterMinutes(
        this.getHeartbeatTurnSettings?.(sessionId)?.afterMinutes,
      ) *
      60 *
      1000
    );
  }

  /**
   * Re-plan heartbeat deadlines after an event that could pull one earlier —
   * a state change, a process appearing or leaving, an opt-in edit. The
   * request never asks for a sweep sooner than the fallback recheck, so event
   * churn cannot make heartbeats cost more than the fixed tick they replaced.
   */
  private requestHeartbeatSweep(): void {
    if (this.backgroundTasksStopped) return;
    if (this.heartbeatScheduler.isArmedWithin(HEARTBEAT_RECHECK_MS)) return;
    if (!this.hasHeartbeatWork()) return;
    this.heartbeatScheduler.requestSweepWithin(HEARTBEAT_RECHECK_MS);
  }

  /**
   * Heartbeat settings changed outside the supervisor. A fresh opt-in can make
   * an already-quiet session due, and the candidate half must look again even
   * if it had settled.
   */
  notifyHeartbeatScheduleChanged(): void {
    if (this.backgroundTasksStopped) return;
    this.heartbeatCandidateDueAtMs = 0;
    this.heartbeatScheduler.requestSweepWithin(HEARTBEAT_RECHECK_MS);
  }

  private hasHeartbeatWork(): boolean {
    if (this.getCandidateSweepDueAtMs() !== null) return true;
    for (const process of this.processes.values()) {
      if (process.hasPatientDeferredMessages()) return true;
      if (this.getHeartbeatTurnSettings?.(process.sessionId)?.enabled) {
        return true;
      }
    }
    return false;
  }

  getHeartbeatScheduleMetrics(): ReturnType<
    HeartbeatSweepScheduler["getMetrics"]
  > {
    return this.heartbeatScheduler.getMetrics();
  }

  private shouldRetainIdleProcess(sessionId: string): boolean {
    if (this.isAutomationPausedUntilUserTurn(sessionId)) {
      return false;
    }
    const process = this.getProcessForSession(sessionId);
    return (
      process?.hasPatientDeferredMessages() === true ||
      this.getHeartbeatTurnSettings?.(sessionId)?.enabled === true
    );
  }

  private queuePatientDeferredMessagesForProcess(
    process: Process,
    now: number,
    log: ReturnType<typeof getLogger>,
  ): { promoted: boolean; dueAtMs: number | null } {
    if (this.isAutomationPausedUntilUserTurn(process.sessionId)) {
      return { promoted: false, dueAtMs: null };
    }
    if (!process.hasPatientDeferredMessages()) {
      return { promoted: false, dueAtMs: null };
    }
    // Patient entries exist but the process is not in a shape that can accept
    // them. Only a state change resolves that, so keep the fallback cadence
    // rather than inventing a deadline for it.
    const blocked = { promoted: false, dueAtMs: now + HEARTBEAT_RECHECK_MS };
    if (
      process.isTerminated ||
      process.state.type !== "idle" ||
      process.queueDepth > 0 ||
      process.isProcessAlive === false
    ) {
      return blocked;
    }

    const liveness = process.getLivenessSnapshot(new Date(now));
    if (liveness.derivedStatus !== "verified-idle") {
      return blocked;
    }

    const fallbackMs = process.state.since.getTime();
    const quietSinceMs = getHeartbeatResetAtMs(liveness, fallbackMs);
    if (!Number.isFinite(quietSinceMs)) {
      return blocked;
    }

    // Each patient entry carries its own patience window (seconds of
    // verified quiet); promote the elapsed ones and schedule a precise
    // re-check for the shortest remaining wait.
    const { promoted, nextPatienceMsRemaining } =
      process.promoteEligiblePatientDeferredMessages({ quietSinceMs, now });

    if (nextPatienceMsRemaining !== null) {
      this.schedulePatientDeferredCheck(process, nextPatienceMsRemaining);
    }

    if (!promoted) {
      // The remaining entries own a precise one-shot re-check of their own.
      return {
        promoted: false,
        dueAtMs: nextPatienceMsRemaining === null ? blocked.dueAtMs : null,
      };
    }

    log.info(
      {
        event: "patient_deferred_messages_promoted",
        sessionId: process.sessionId,
        processId: process.id,
        projectId: process.projectId,
        quietMs: Math.max(0, now - quietSinceMs),
        quietSince: new Date(quietSinceMs).toISOString(),
        livenessStatus: liveness.derivedStatus,
      },
      `Promoted patient deferred messages for session: ${process.sessionId}`,
    );
    // Promotion put the process back in turn; its own state change and any
    // remaining patient entry's one-shot check drive what comes next.
    return { promoted: true, dueAtMs: null };
  }

  /**
   * Arm (or re-arm) the one-shot patient-queue re-check for a process. The
   * check itself re-derives eligibility and re-arms only while patient
   * entries remain, so the timer cannot become a standing poll.
   */
  private schedulePatientDeferredCheck(
    process: Process,
    delayMs: number,
  ): void {
    if (this.backgroundTasksStopped) return;
    const existing = this.patientCheckTimers.get(process.id);
    if (existing) {
      clearTimeout(existing);
    }
    const delay = Math.max(250, Math.min(delayMs, 60 * 60 * 1000));
    const timer = setTimeout(() => {
      this.patientCheckTimers.delete(process.id);
      if (!this.processes.has(process.id)) {
        return;
      }
      this.queuePatientDeferredMessagesForProcess(
        process,
        Date.now(),
        getLogger(),
      );
    }, delay);
    timer.unref();
    this.patientCheckTimers.set(process.id, timer);
  }

  /**
   * Returns the earliest instant this process could need a heartbeat, or null
   * when only an event can create work for it (heartbeat off, or terminated).
   */
  private async queueHeartbeatTurnForProcess(
    process: Process,
    now: number,
    log: ReturnType<typeof getLogger>,
  ): Promise<number | null> {
    if (this.isAutomationPausedUntilUserTurn(process.sessionId)) {
      return null;
    }
    const settings = this.getHeartbeatTurnSettings?.(process.sessionId);
    if (!settings?.enabled) {
      return null;
    }
    if (process.isTerminated) {
      return null;
    }
    // Opted in but blocked by state a deadline cannot predict: queued work
    // draining, a dead process, or liveness YA has not verified. These resolve
    // on events, so hold the fallback cadence.
    const blockedAtMs = now + HEARTBEAT_RECHECK_MS;
    if (process.queueDepth > 0 || process.isProcessAlive === false) {
      return blockedAtMs;
    }

    const liveness = process.getLivenessSnapshot(new Date(now));
    const isVerifiedIdle =
      process.state.type === "idle" &&
      liveness.derivedStatus === "verified-idle";
    const isActiveDoubt =
      process.state.type === "in-turn" &&
      ACTIVE_HEARTBEAT_DOUBT_STATUSES.has(liveness.derivedStatus);
    if (!isVerifiedIdle && !isActiveDoubt) {
      return blockedAtMs;
    }

    const afterMinutes = clampHeartbeatAfterMinutes(settings.afterMinutes);
    const idleThresholdMs = afterMinutes * 60 * 1000;
    const text = settings.text.trim() || DEFAULT_HEARTBEAT_TURN_TEXT;

    const fallbackMs =
      process.state.type === "idle"
        ? process.state.since.getTime()
        : (parseFiniteIsoMs(liveness.lastStateChangeAt) ?? now);
    const heartbeatResetAtMs = getHeartbeatResetAtMs(liveness, fallbackMs);
    if (!Number.isFinite(heartbeatResetAtMs)) {
      return blockedAtMs;
    }
    const idleMs = Math.max(0, now - heartbeatResetAtMs);
    if (idleMs < idleThresholdMs) {
      // The exact deadline. Every input that could move it — a provider
      // message, a probe, a state change — only pushes it later, and the
      // sweep at this instant re-derives it from the anchor it finds then.
      return heartbeatResetAtMs + idleThresholdMs;
    }
    const heartbeatResetAt = new Date(heartbeatResetAtMs).toISOString();
    const action = getActiveHeartbeatAction({
      isVerifiedIdle,
      isActiveDoubt,
      process,
      settings,
      heartbeatResetAtMs,
      idleMs,
      now,
    });
    if (action.type === "wait") {
      // A non-steerable session in doubt waits for its force threshold, and
      // for nothing at all when no force timeout is configured.
      const forceAfterMinutes = normalizeHeartbeatForceAfterMinutes(
        settings.forceAfterMinutes,
      );
      return forceAfterMinutes === null
        ? null
        : heartbeatResetAtMs + (afterMinutes + forceAfterMinutes) * 60 * 1000;
    }

    if (action.type === "interrupt") {
      const interrupt = this.interruptHeartbeatTurnForProcess(process, {
        now,
        log,
        text,
        idleMs,
        heartbeatResetAt,
        afterMinutes,
        forceAfterMinutes: action.forceAfterMinutes,
        forceIdleMs: action.forceIdleMs,
        livenessStatus: liveness.derivedStatus,
      });
      this.heartbeatInterruptTasks.add(interrupt);
      void interrupt.then(
        () => this.heartbeatInterruptTasks.delete(interrupt),
        (error) => {
          this.heartbeatInterruptTasks.delete(interrupt);
          log.error(
            {
              event: "heartbeat_interrupt_failed",
              sessionId: process.sessionId,
              error,
            },
            "Heartbeat interrupt failed",
          );
        },
      );
      return blockedAtMs;
    }

    const result = await this.queueProcessMessage(process, {
      text,
      automaticSource: "heartbeat",
    });
    if (result.success) {
      log.info(
        {
          event: "heartbeat_turn_queued",
          sessionId: process.sessionId,
          processId: process.id,
          projectId: process.projectId,
          idleMs,
          heartbeatResetAt,
          afterMinutes,
          text,
          heartbeatReason: isVerifiedIdle ? "verified-idle" : "active-doubt",
          livenessStatus: liveness.derivedStatus,
        },
        `Queued heartbeat turn for session: ${process.sessionId}`,
      );
    } else {
      log.warn(
        {
          event: "heartbeat_turn_failed",
          sessionId: process.sessionId,
          processId: process.id,
          projectId: process.projectId,
          idleMs,
          heartbeatResetAt,
          afterMinutes,
          error: result.error,
          heartbeatReason: isVerifiedIdle ? "verified-idle" : "active-doubt",
          livenessStatus: liveness.derivedStatus,
        },
        `Failed to queue heartbeat turn for session: ${process.sessionId}`,
      );
    }
    return blockedAtMs;
  }

  private async interruptHeartbeatTurnForProcess(
    process: Process,
    details: {
      now: number;
      log: ReturnType<typeof getLogger>;
      text: string;
      idleMs: number;
      heartbeatResetAt: string;
      afterMinutes: number;
      forceAfterMinutes: number;
      forceIdleMs: number;
      livenessStatus: SessionLivenessSnapshot["derivedStatus"];
    },
  ): Promise<void> {
    const { log } = details;
    if (this.isAutomationPausedUntilUserTurn(process.sessionId)) {
      return;
    }
    const { interrupted, timedOut } = await this.interruptProcessWithTimeout(
      process,
      {
        extraMessages: [{ text: details.text }],
        preamble: FORCED_HEARTBEAT_INTERRUPT_PREAMBLE,
      },
    );

    if (this.backgroundTasksStopped) return;

    if (interrupted) {
      log.warn(
        {
          event: "heartbeat_turn_interrupted",
          sessionId: process.sessionId,
          processId: process.id,
          projectId: process.projectId,
          idleMs: details.idleMs,
          heartbeatResetAt: details.heartbeatResetAt,
          afterMinutes: details.afterMinutes,
          forceAfterMinutes: details.forceAfterMinutes,
          forceIdleMs: details.forceIdleMs,
          text: details.text,
          heartbeatReason: "force-after-active-doubt",
          livenessStatus: details.livenessStatus,
        },
        `Interrupted active turn for heartbeat: ${process.sessionId}`,
      );
      return;
    }

    if (timedOut) {
      log.warn(
        {
          event: "heartbeat_interrupt_timeout",
          sessionId: process.sessionId,
          processId: process.id,
          projectId: process.projectId,
          timeoutMs: this.interruptTimeoutMs,
          forceAfterMinutes: details.forceAfterMinutes,
          forceIdleMs: details.forceIdleMs,
          livenessStatus: details.livenessStatus,
        },
        `Heartbeat interrupt timed out: ${process.sessionId}`,
      );
    }

    if (this.isAutomationPausedUntilUserTurn(process.sessionId)) {
      return;
    }
    const result = await this.queueProcessMessage(process, {
      text: `${FORCED_HEARTBEAT_INTERRUPT_PREAMBLE}\n\n${details.text}`,
      automaticSource: "heartbeat",
    });
    log.warn(
      {
        event: result.success
          ? "heartbeat_interrupt_fallback_queued"
          : "heartbeat_interrupt_fallback_failed",
        sessionId: process.sessionId,
        processId: process.id,
        projectId: process.projectId,
        idleMs: details.idleMs,
        heartbeatResetAt: details.heartbeatResetAt,
        afterMinutes: details.afterMinutes,
        forceAfterMinutes: details.forceAfterMinutes,
        forceIdleMs: details.forceIdleMs,
        error: result.error,
        heartbeatReason: "force-after-active-doubt",
        livenessStatus: details.livenessStatus,
      },
      result.success
        ? `Queued heartbeat after failed interrupt: ${process.sessionId}`
        : `Failed heartbeat interrupt fallback: ${process.sessionId}`,
    );
  }

  /**
   * Returns the earliest instant this unowned candidate could be resumed, or
   * null when nothing but an event (ownership, opt-in, provider support) can
   * make it due.
   */
  private async queueHeartbeatTurnForCandidate(
    candidate: HeartbeatTurnCandidate,
    now: number,
    log: ReturnType<typeof getLogger>,
  ): Promise<number | null> {
    if (this.getProcessForSession(candidate.sessionId)) {
      return null;
    }
    if (!candidate.hasPendingToolCall) {
      return null;
    }
    const provider = this.resolveProvider({ providerName: candidate.provider });
    if (!provider?.supportsSteering) {
      return null;
    }
    const settings = this.getHeartbeatTurnSettings?.(candidate.sessionId);
    if (!settings?.enabled) {
      return null;
    }

    const heartbeatResetAtMs = parseCandidateUpdatedAtMs(candidate.updatedAt);
    if (heartbeatResetAtMs === null) {
      return null;
    }
    const afterMinutes = clampHeartbeatAfterMinutes(settings.afterMinutes);
    const idleThresholdMs = afterMinutes * 60 * 1000;
    const idleMs = Math.max(0, now - heartbeatResetAtMs);
    if (idleMs < idleThresholdMs) {
      return heartbeatResetAtMs + idleThresholdMs;
    }

    const text = settings.text.trim() || DEFAULT_HEARTBEAT_TURN_TEXT;
    const heartbeatResetAt = new Date(heartbeatResetAtMs).toISOString();
    const result = await this.resumeSession(
      candidate.sessionId,
      candidate.projectPath,
      { text, automaticSource: "heartbeat" },
      undefined,
      {
        providerName: candidate.provider,
        model: candidate.model,
        executor: candidate.executor,
      },
    );

    if ("error" in result) {
      log.warn(
        {
          event: "heartbeat_turn_failed",
          sessionId: candidate.sessionId,
          projectId: candidate.projectId,
          idleMs,
          heartbeatResetAt,
          afterMinutes,
          error: result.error,
          heartbeatReason: "unowned-pending-tool",
          livenessStatus: "pending-tool-unowned",
        },
        `Failed to resume heartbeat turn for session: ${candidate.sessionId}`,
      );
      // A failed resume leaves the candidate exactly as due as it was, so
      // retry on the fallback cadence rather than immediately.
      return now + HEARTBEAT_RECHECK_MS;
    }

    log.info(
      {
        event: "heartbeat_turn_queued",
        sessionId: candidate.sessionId,
        projectId: candidate.projectId,
        idleMs,
        heartbeatResetAt,
        afterMinutes,
        text,
        heartbeatReason: "unowned-pending-tool",
        livenessStatus: "pending-tool-unowned",
        queued: "queued" in result ? result.queued : false,
        processId: "id" in result ? result.id : undefined,
      },
      `Resumed heartbeat turn for session: ${candidate.sessionId}`,
    );
    // The session is owned now; the process half of the sweep takes it from
    // here, announced by the ownership change that just fired.
    return null;
  }

  private probeLongSilentProcesses(): void {
    const now = new Date();
    const log = getLogger();

    for (const process of this.processes.values()) {
      if (process.state.type !== "in-turn") {
        continue;
      }
      if (process.isTerminated || !process.canProbeLiveness) {
        continue;
      }

      const liveness = process.getLivenessSnapshot(now);
      if (
        liveness.derivedStatus !== "long-silent-unverified" &&
        liveness.derivedStatus !== "verified-waiting-provider"
      ) {
        continue;
      }

      const lastProbeAt = liveness.lastLivenessProbeAt
        ? Date.parse(liveness.lastLivenessProbeAt)
        : null;
      if (
        lastProbeAt !== null &&
        Number.isFinite(lastProbeAt) &&
        now.getTime() - lastProbeAt < LIVENESS_PROBE_REFRESH_MS
      ) {
        continue;
      }

      void process
        .probeLiveness()
        .then((probe) => {
          if (this.backgroundTasksStopped || !probe) {
            return;
          }
          const event =
            process.state.type === "in-turn" && probe.status !== "active"
              ? "liveness_probe_attention"
              : "liveness_probe_completed";
          log.info(
            {
              event,
              sessionId: process.sessionId,
              processId: process.id,
              projectId: process.projectId,
              provider: process.provider,
              status: probe.status,
              source: probe.source,
              detail: probe.detail,
              checkedAt: probe.checkedAt.toISOString(),
            },
            "Completed active session liveness probe",
          );
        })
        .catch((error) => {
          log.warn(
            {
              event: "liveness_probe_failed",
              sessionId: process.sessionId,
              processId: process.id,
              projectId: process.projectId,
              provider: process.provider,
              error: error instanceof Error ? error.message : String(error),
            },
            "Active session liveness probe failed",
          );
        });
    }
  }

  getProcessInfoList(): ProcessInfo[] {
    return this.getAllProcesses().map((p) => p.getInfo());
  }

  /**
   * Check if a session was ever owned by this server instance.
   * Used to determine if orphaned tool detection should be trusted.
   * For sessions we never owned (external), we can't know if tools were interrupted.
   */
  wasEverOwned(sessionId: string): boolean {
    return this.everOwnedSessions.has(sessionId);
  }

  async abortProcess(processId: string): Promise<boolean> {
    return (await this.abortProcessWithVerification(processId)) !== null;
  }

  async abortProcessWithVerification(
    processId: string,
  ): Promise<ProcessAbortResult | null> {
    const process = this.processes.get(processId);
    if (!process) return null;

    const log = getLogger();
    log.info(
      {
        event: "session_abort_requested",
        sessionId: process.sessionId,
        processId: process.id,
        projectId: process.projectId,
        currentState: process.state.type,
      },
      `Session abort requested: ${process.sessionId}`,
    );

    // Emit session-aborted event BEFORE aborting, so ExternalSessionTracker
    // can set up the grace period before any file changes arrive
    this.emitSessionAborted(process.sessionId, process.projectId);

    const result = await process.abort();
    await this.activationCoordinator.settleStoppingProcessLaunchSettings(
      process,
    );
    this.unregisterProcess(process);
    log.info(
      {
        event: "session_abort_verified",
        sessionId: result.sessionId,
        processId: result.processId,
        pid: result.pid,
        verification: result.verification,
      },
      result.pid === undefined
        ? `Session abort verified: ${result.sessionId}`
        : `Session abort verified: ${result.sessionId} (PID ${result.pid})`,
    );
    return result;
  }

  /**
   * The resume truncation every launcher passes to its provider: the
   * session's pending rewind, else the caller's own cut. Paired with
   * `consumePendingRewind` once the process exists.
   */
  private resolveLaunchTruncation(
    resumeSessionId: string | undefined,
    providerName: ProviderName,
    modelSettings: ModelSettings | undefined,
  ): ResumeTruncation {
    return resolveResumeTruncation({
      resumeSessionId,
      providerName,
      pendingRewind: resumeSessionId
        ? this.sessionMetadataService?.getPendingRewind?.(resumeSessionId)
        : undefined,
      requested: modelSettings,
    });
  }

  /**
   * A launch that passed a pending rewind's truncation has applied it: the
   * record stops being pending and the process remembers which record, so a
   * later drop-guard refusal from the provider can delete exactly that one.
   */
  private async consumePendingRewind(
    process: Process,
    resumeSessionId: string | undefined,
    truncation: { rewindRecordId?: string },
  ): Promise<void> {
    if (!resumeSessionId || !truncation.rewindRecordId) return;
    process.appliedRewindRecordId = truncation.rewindRecordId;
    await this.sessionMetadataService?.clearPendingRewind?.(resumeSessionId);
  }

  /**
   * The provider refused the guarded truncation. The refusal is deterministic
   * (topics/session-rewind.md), so the record is deleted rather than retried:
   * the rows it grouped are live again, every viewer reloads, and the next
   * send resumes the full chain.
   */
  private async discardRefusedRewind(process: Process): Promise<void> {
    const recordId = process.appliedRewindRecordId;
    if (!recordId) return;
    process.appliedRewindRecordId = undefined;
    getLogger().warn(
      {
        event: "session_rewind_refused",
        sessionId: process.sessionId,
        processId: process.id,
        projectId: process.projectId,
        rewindRecordId: recordId,
      },
      "Provider refused the same-session rewind; record deleted",
    );
    await this.sessionMetadataService?.removeRewindRecord?.(
      process.sessionId,
      recordId,
    );
    this.eventBus?.emit({
      type: "session-metadata-changed",
      sessionId: process.sessionId,
      projectId: process.projectId,
      rewindRecordRemoved: recordId,
      timestamp: new Date().toISOString(),
    });
  }

  async abortSessionWithVerification(
    sessionId: string,
  ): Promise<ProcessAbortResult | null> {
    const process = this.getProcessForSession(sessionId);
    return process ? this.abortProcessWithVerification(process.id) : null;
  }

  /**
   * Interrupt the current turn of a running process gracefully.
   * Unlike abort, this stops the current turn but keeps the process alive.
   *
   * @returns Object with success status and whether interrupt is supported
   */
  async interruptProcess(
    processId: string,
  ): Promise<{ success: boolean; supported: boolean; hardAborted?: boolean }> {
    const process = this.processes.get(processId);
    if (!process) return { success: false, supported: false };

    if (process.supportsInterrupt) {
      this.emitSessionStopRequested(process.sessionId, process.projectId);
    }

    await this.pauseRecapsUntilUserTurn(processId);

    // Check if the process supports interrupt
    if (!process.supportsInterrupt) {
      return { success: false, supported: false };
    }

    const log = getLogger();
    log.info(
      {
        event: "session_interrupt_requested",
        sessionId: process.sessionId,
        processId: process.id,
        projectId: process.projectId,
        currentState: process.state.type,
      },
      `Session interrupt requested: ${process.sessionId}`,
    );

    const { interrupted, timedOut } =
      await this.interruptProcessWithTimeout(process);
    if (interrupted) {
      return { success: true, supported: true };
    }

    if (timedOut) {
      log.warn(
        {
          event: "session_interrupt_timeout",
          sessionId: process.sessionId,
          processId: process.id,
          projectId: process.projectId,
          currentState: process.state.type,
          timeoutMs: this.interruptTimeoutMs,
        },
        `Session interrupt timed out; hard-aborting process: ${process.sessionId}`,
      );
    }

    log.warn(
      {
        event: "session_interrupt_incomplete",
        sessionId: process.sessionId,
        processId: process.id,
        projectId: process.projectId,
        currentState: process.state.type,
      },
      `Session interrupt incomplete; hard-aborting process: ${process.sessionId}`,
    );

    const deferredMessages = await process.drainPendingUserMessages("promoted");
    this.emitSessionAborted(process.sessionId, process.projectId);
    await process.terminateAndWait("interrupt fallback abort");
    await this.activationCoordinator.settleStoppingProcessLaunchSettings(
      process,
    );
    this.unregisterProcess(process);
    this.recoverDeferredMessagesAfterHardAbort(process, deferredMessages);
    return { success: false, supported: true, hardAborted: true };
  }

  async requestRecap(
    processId: string,
    options?: { sinceMs?: number | null; revived?: boolean },
  ): Promise<{
    supported: boolean;
    emitted: boolean;
    reason?: string;
    text?: string;
  }> {
    const process = this.processes.get(processId);
    if (!process) {
      return {
        supported: false,
        emitted: false,
        reason: "process not found",
      };
    }
    if (
      this.sessionMetadataService?.getMetadata(process.sessionId)?.routerBinding
    )
      return {
        supported: false,
        emitted: false,
        reason: "Separate recap helpers are unavailable for routed sessions",
      };
    if (this.isRecapPausedUntilUserTurn(process.sessionId)) {
      return {
        supported: true,
        emitted: false,
        reason: "recaps paused until next user turn",
      };
    }
    if (this.isAutomationPausedUntilUserTurn(process.sessionId)) {
      return {
        supported: true,
        emitted: false,
        reason: "automation paused until next user turn",
      };
    }
    const sandboxError = getSessionSandboxSettingsError(
      process.sandboxEnforcement?.effective,
      process.recapMode,
    );
    if (sandboxError) {
      return {
        supported: false,
        emitted: false,
        reason: sandboxError,
      };
    }

    const provider = this.resolveProvider({ providerName: process.provider });
    if (!provider) {
      return {
        supported: false,
        emitted: false,
        reason: "provider not found",
      };
    }

    const result =
      process.recapMode === "fork"
        ? await this.requestForkedRecap(
            process,
            provider,
            options?.sinceMs ?? null,
            { revived: options?.revived === true },
          )
        : await process.requestRecap(provider, {
            ...options,
            sinceMs: this.recapFloorMs(
              process.sessionId,
              options?.sinceMs ?? null,
            ),
          });
    await this.handleRecapResult(process, result);
    const { syntheticMessage: _syntheticMessage, ...publicResult } = result;
    return publicResult;
  }

  private async interruptProcessWithTimeout(
    process: Process,
    options?: { extraMessages?: UserMessage[]; preamble?: string },
  ): Promise<{ interrupted: boolean; timedOut: boolean }> {
    const log = getLogger();
    const interruptPromise = process
      .interrupt(options)
      .then((interrupted) => ({ interrupted, timedOut: false }))
      .catch((error) => {
        log.warn(
          {
            event: "session_interrupt_failed",
            sessionId: process.sessionId,
            processId: process.id,
            projectId: process.projectId,
            error: error instanceof Error ? error.message : String(error),
          },
          `Session interrupt failed: ${process.sessionId}`,
        );
        return { interrupted: false, timedOut: false };
      });

    if (
      !Number.isFinite(this.interruptTimeoutMs) ||
      this.interruptTimeoutMs <= 0
    ) {
      return interruptPromise;
    }

    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<{
      interrupted: boolean;
      timedOut: boolean;
    }>((resolve) => {
      timeout = setTimeout(() => {
        resolve({ interrupted: false, timedOut: true });
      }, this.interruptTimeoutMs);
      timeout.unref?.();
    });

    try {
      return await Promise.race([interruptPromise, timeoutPromise]);
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }
  }

  private recoverDeferredMessagesAfterHardAbort(
    sourceProcess: Process,
    deferredMessages: UserMessage[],
  ): void {
    if (deferredMessages.length === 0) {
      return;
    }

    void this.resumeDeferredMessagesAfterHardAbort(
      sourceProcess,
      deferredMessages,
    ).catch((error) => {
      const log = getLogger();
      log.warn(
        {
          event: "deferred_recovery_failed",
          sessionId: sourceProcess.sessionId,
          processId: sourceProcess.id,
          projectId: sourceProcess.projectId,
          error: error instanceof Error ? error.message : String(error),
        },
        "Failed to recover deferred messages after hard abort",
      );
    });
  }

  private async resumeDeferredMessagesAfterHardAbort(
    sourceProcess: Process,
    deferredMessages: UserMessage[],
  ): Promise<void> {
    const [firstMessage, ...remainingMessages] = deferredMessages;
    if (!firstMessage) {
      return;
    }

    const providerName =
      sourceProcess.provider === "claude" && this.realSdk && !this.provider
        ? undefined
        : sourceProcess.provider;

    const result = await this.resumeSession(
      sourceProcess.sessionId,
      sourceProcess.projectPath,
      firstMessage,
      firstMessage.mode ?? sourceProcess.permissionMode,
      {
        model: sourceProcess.resolvedModel ?? sourceProcess.model,
        thinking: sourceProcess.thinking,
        effort: sourceProcess.effort,
        providerName,
        executor: sourceProcess.executor,
        permissions: sourceProcess.permissions,
        recapAfterSeconds: sourceProcess.recapAfterSeconds,
      },
    );

    const log = getLogger();
    if (!("id" in result)) {
      log.warn(
        {
          event: "deferred_recovery_not_started",
          sessionId: sourceProcess.sessionId,
          processId: sourceProcess.id,
          projectId: sourceProcess.projectId,
          recoveredCount: deferredMessages.length,
        },
        "Deferred recovery was queued or rejected after hard abort",
      );
      return;
    }

    for (const message of remainingMessages) {
      if (message.mode) {
        result.setPermissionMode(message.mode);
      }
      await result.primeSupportedCommandsForMessage(message);
      const queued = result.deferMessage(message, { promoteIfReady: false });
      if (!queued.success) {
        log.warn(
          {
            event: "deferred_recovery_enqueue_failed",
            sessionId: sourceProcess.sessionId,
            processId: result.id,
            projectId: sourceProcess.projectId,
            tempId: message.tempId,
            error: queued.error,
          },
          "Failed to recover deferred message on replacement process",
        );
      }
    }
  }

  private emitSessionForked(
    sessionId: string,
    sourceSessionId: string,
    location: { projectPath: string },
  ): void {
    if (!this.eventBus) return;

    const event: SessionForkedEvent = {
      type: "session-forked",
      sessionId,
      sourceSessionId,
      projectId: encodeProjectId(location.projectPath),
      timestamp: new Date().toISOString(),
    };
    this.eventBus.emit(event);
  }

  private emitSessionAborted(
    sessionId: string,
    projectId: UrlProjectId,
    reason?: "idle-reap",
  ): void {
    if (!this.eventBus) return;

    const event: SessionAbortedEvent = {
      type: "session-aborted",
      sessionId,
      projectId,
      ...(reason ? { reason } : {}),
      timestamp: new Date().toISOString(),
    };
    this.eventBus.emit(event);
  }

  /**
   * Announce an intentional stop of the current turn before the interrupt is
   * attempted, so a listener sees it ahead of the idle report the stop causes.
   */
  private emitSessionStopRequested(
    sessionId: string,
    projectId: UrlProjectId,
  ): void {
    if (!this.eventBus) return;

    const event: SessionStopRequestedEvent = {
      type: "session-stop-requested",
      sessionId,
      projectId,
      timestamp: new Date().toISOString(),
    };
    this.eventBus.emit(event);
  }

  private async instructionLaunchOptions(
    provider: ProviderName,
    sessionId: string | undefined,
    projectId: UrlProjectId,
    isolated: boolean,
  ): Promise<
    Pick<
      import("../sdk/providers/types.js").StartSessionOptions,
      "instructionRestoration" | "instructionReadHistory"
    >
  > {
    const settings =
      this.instructionOptions.getInstructionRestorationSettings?.();
    if (!settings?.providers[provider] || isolated) return {};
    return {
      instructionRestoration: settings,
      instructionReadHistory: sessionId
        ? await this.instructionOptions.readInstructionHistory?.(
            sessionId,
            projectId,
            provider,
          )
        : undefined,
    };
  }

  async refreshInstructionRestoration(only?: Process): Promise<void> {
    const settings =
      this.instructionOptions.getInstructionRestorationSettings?.();
    for (const [process, session] of this.instructionSessions) {
      if (only && only !== process) continue;
      const enabled =
        settings?.providers[process.provider] &&
        !process.executor &&
        !process.sandboxEnforcement;
      try {
        await session.configureInstructionRestoration?.({
          settings: enabled ? settings : null,
          paused:
            process.state.type === "waiting-input" ||
            this.isAutomationPausedUntilUserTurn(process.sessionId) ||
            this.isRecapPausedUntilUserTurn(process.sessionId),
        });
      } catch (error) {
        getLogger().warn(
          { err: error, sessionId: process.sessionId },
          "Instruction restoration configuration failed",
        );
      }
    }
  }

  private observeProcessEvents(process: Process): void {
    if (this.observedProcessIds.has(process.id)) {
      return;
    }
    this.observedProcessIds.add(process.id);
    process.subscribe((event) => {
      if (
        event.type === "state-change" ||
        event.type === "user-turn-accepted"
      ) {
        void this.refreshInstructionRestoration(process);
      }
      if (event.type === "non-human-user-turn") {
        void this.sessionMetadataService
          ?.recordNonHumanUserTurn(process.sessionId, event.turn)
          .then(() => {
            this.eventBus?.emit({
              type: "session-metadata-changed",
              sessionId: process.sessionId,
              projectId: process.projectId,
              nonHumanUserTurn:
                this.sessionMetadataService?.getPendingNonHumanUserTurn(
                  process.sessionId,
                ) ?? null,
              timestamp: new Date().toISOString(),
            });
          })
          .catch((error) => {
            getLogger().error(
              { err: error, sessionId: process.sessionId },
              "Failed to persist non-human user turn",
            );
          });
      } else if (event.type === "provider-turn-started") {
        // A provider that never emits a `result` frame would otherwise let one
        // turn's charge run into the next; the new turn's start closes it.
        this.tokenUsageRecorder.flush(process);
        this.cacheMissBillingMonitor.observeProviderTurnStarted(
          process,
          event.turnKind,
          event.startedAtMs,
        );
      } else if (event.type === "user-turn-accepted") {
        // Server receipt is the fallback boundary for an older reload-safe
        // worker. A worker that reports provider yield replaces it with the
        // later authoritative boundary before usage arrives.
        this.cacheMissBillingMonitor.observeUserTurnStarted(
          process,
          event.startedAtMs,
        );
        this.resumeRecapsAfterUserTurn(process);
        this.resumeAutomationAfterUserTurn(process);
      } else if (
        event.type === "mode-change" ||
        event.type === "configuration-applied"
      ) {
        this.activationCoordinator.scheduleLaunchSettingsPersistence(
          process,
          event.type === "mode-change" ? "permissionMode" : event.setting,
        );
      } else if (event.type === "model-resolved") {
        // Clients opened on the launch alias learn the served model now,
        // rather than only on their next reload.
        this.eventBus?.emit({
          type: "session-updated",
          sessionId: process.sessionId,
          projectId: process.projectId,
          model: event.model,
          timestamp: new Date().toISOString(),
        });
      } else if (event.type === "idle-reap") {
        this.emitSessionAborted(
          process.sessionId,
          process.projectId,
          "idle-reap",
        );
      } else if (event.type === "complete") {
        this.dirtyFileEditorService?.forgetProcess(process.id);
        void this.activationCoordinator.settleStoppingProcessLaunchSettings(
          process,
        );
        this.unregisterProcess(process);
      } else if (event.type === "message") {
        this.dirtyFileEditorService?.observeMessage(process, event.message);
        if (
          isCompactBoundaryMessage(event.message) ||
          isCompactSuccessStatus(event.message)
        ) {
          this.compactionSettledAtAssistantVersion.set(
            process.id,
            process.assistantActivityVersion,
          );
          this.notePostCompactReplay(process);
          if (process.state.type === "idle") {
            void this.maybePostCompactReplay(process);
          }
        }
        if (event.message.type === "user") {
          this.clearTerminalProviderStatus(
            process.sessionId,
            process.projectId,
          );
        }
        if (process.appliedRewindRecordId) {
          if (isResumeDropsTurnRefusal(event.message)) {
            void this.discardRefusedRewind(process);
          } else if (event.message.type === "result") {
            // The truncating resume was accepted; the record is history now.
            process.appliedRewindRecordId = undefined;
          }
        }
        this.cacheMissBillingMonitor.observeMessage(process, event.message);
        this.tokenUsageRecorder.observeMessage(process, event.message);
        if (event.message.type === "result") {
          this.tokenUsageRecorder.flush(process);
        }
        if (
          isAwaySummaryMessage(event.message) &&
          event.message.isSynthetic !== true
        ) {
          const durable = toDurableRecapMessage(
            event.message,
            "provider-native",
          );
          if (durable) {
            void this.persistRecapOverlay(process, durable);
            this.publishRecapListUpdate(
              process,
              durable.content,
              durable.timestamp,
            );
            this.cancelInFlightForkedRecap(process);
          }
        }
      } else if (event.type === "recap-result") {
        void this.handleRecapResult(process, event.result);
      } else if (event.type === "context-window-observed") {
        this.onContextWindowObserved?.(
          event.model,
          event.contextWindow,
          event.provider,
        );
      } else if (event.type === "session-id-changed") {
        // Update session→process mapping when temp ID is replaced by real ID from SDK
        // This is critical for ExternalSessionTracker to correctly identify owned sessions
        const log = getLogger();
        log.info(
          {
            event: "session_id_mapping_updated",
            oldSessionId: event.oldSessionId,
            newSessionId: event.newSessionId,
            processId: process.id,
            projectId: process.projectId,
            executor: process.executor,
          },
          `Session ID mapping updated: ${event.oldSessionId} → ${event.newSessionId}`,
        );

        // Keep both temp and real session ID mappings to support lookups by either ID
        // Clients might still be using the temp ID when the real ID arrives
        // The old temp ID mapping is retained (no delete)
        const oldIdWasPublished =
          this.sessionToProcess.get(event.oldSessionId) === process.id;
        if (this.recapPausedSessionIds.delete(event.oldSessionId)) {
          this.recapPausedSessionIds.add(event.newSessionId);
        }
        this.sessionToProcess.set(event.newSessionId, process.id);
        try {
          this.issueSessionRemapObserver?.(
            event.oldSessionId,
            event.newSessionId,
          );
        } catch (error) {
          log.warn({ error }, "Issue evidence session remap failed");
        }

        this.everOwnedSessions.add(event.newSessionId);
        void this.sessionMetadataService
          ?.remapSessionId(event.oldSessionId, event.newSessionId)
          .catch((error) => {
            log.warn(
              {
                event: "session_metadata_remap_failed",
                oldSessionId: event.oldSessionId,
                newSessionId: event.newSessionId,
                error: error instanceof Error ? error.message : String(error),
              },
              "Failed to remap provisional session metadata",
            );
          });
        if (this.eventBus && oldIdWasPublished) {
          const remapped: SessionIdRemappedEvent = {
            type: "session-id-remapped",
            oldSessionId: event.oldSessionId,
            newSessionId: event.newSessionId,
            projectId: process.projectId,
            processId: process.id,
            provider: process.provider,
            timestamp: new Date().toISOString(),
          };
          this.eventBus.emit(remapped);
        }
        const retainedStatus = this.terminalProviderStatuses.get(
          event.oldSessionId,
        );
        if (retainedStatus) {
          this.terminalProviderStatuses.delete(event.oldSessionId);
          this.retainTerminalProviderStatus(event.newSessionId, retainedStatus);
        }

        // Persist executor for remote execution resume support
        // This saves which SSH host was used so resume can reconnect to the same remote
        if (this.onSessionExecutor && process.executor) {
          this.onSessionExecutor(event.newSessionId, process.executor).catch(
            (error) => {
              log.warn(
                {
                  event: "executor_save_failed",
                  sessionId: event.newSessionId,
                  executor: process.executor,
                  error: error instanceof Error ? error.message : String(error),
                },
                `Failed to save executor for session: ${event.newSessionId}`,
              );
            },
          );
        }

        // Emit ownership change for new session ID so clients can update
        this.emitOwnershipChange(
          event.newSessionId,
          process.projectId,
          sessionOwnershipFromProcess(process),
        );

        // Retry early metadata reconciliation with authoritative session ID.
        this.scheduleInitialSessionReconciliation(
          event.newSessionId,
          process.projectId,
        );
      } else if (event.type === "state-change") {
        // Emit agent activity change for all states that clients need to track
        // This includes in-turn/waiting-input (active) and idle (inactive)
        if (
          event.state.type === "in-turn" ||
          event.state.type === "waiting-input" ||
          event.state.type === "idle"
        ) {
          this.emitProcessActivity(process);
        }
        // Emit worker activity on any state change (affects hasActiveWork)
        this.emitWorkerActivity();
        // A fresh idle boundary starts the patient-queue quiet clock; arm a
        // prompt re-check so seconds-scale patience does not wait for the
        // 30s heartbeat tick.
        if (
          event.state.type === "idle" &&
          process.hasPatientDeferredMessages()
        ) {
          this.schedulePatientDeferredCheck(process, 250);
        }
        if (event.state.type === "idle") {
          if (!process.isRetainingProviderWork()) {
            void this.finalizePendingDone(process);
          }
          this.flushPendingForkedRecapRequest(process);
          void this.maybeCompactAfterIdle(process);
          void this.maybePostCompactReplay(process);
        }
        // Parent started a new turn: cancel any in-flight/deferred forked recap
        // so a returning user's live turn is not shadowed by a stale recap.
        if (event.state.type === "in-turn") {
          this.cancelInFlightForkedRecap(process);
        }
      } else if (event.type === "deferred-queue" && !event.republished) {
        // A republished entry moved no queue, so it is not worker activity:
        // Project Queue restarts its quiet window on every such event, and a
        // held patient /clearloop republishes on each of its re-checks.
        if (
          event.reason === "queued" &&
          process.state.type === "idle" &&
          process.hasPatientDeferredMessages()
        ) {
          this.schedulePatientDeferredCheck(process, 250);
        }
        this.emitWorkerActivity();
      } else if (event.type === "terminated") {
        this.dirtyFileEditorService?.forgetProcess(process.id);
        if (event.failureNotice) {
          void this.sessionMetadataService
            ?.addLocalCommandMessage(process.sessionId, event.failureNotice)
            .catch((error: unknown) => {
              getLogger().warn(
                {
                  event: "provider_failure_notice_persist_failed",
                  sessionId: process.sessionId,
                  errorMessage:
                    error instanceof Error ? error.message : String(error),
                },
                `Failed to persist provider failure notice: ${process.sessionId}`,
              );
            });
        }
        this.emitProcessTerminated(
          process.sessionId,
          process.projectId,
          process.id,
          process.provider,
          event.reason,
        );
      } else if (event.type === "provider-runtime-status-change") {
        if (event.status?.kind === "terminal") {
          this.retainTerminalProviderStatus(process.sessionId, event.status);
        }
        this.emitProviderRuntimeStatusChange(
          process.sessionId,
          process.projectId,
          event.status,
        );
      }
    });
    // After subscribing, so a launch alias resolved here is published too.
    const provider =
      this.provider?.name === process.provider
        ? this.provider
        : getProvider(process.provider);
    if (provider?.resolveLaunchModel) {
      process.useModelResolver((model) => provider.resolveLaunchModel?.(model));
    }
  }

  private registerProcess(process: Process, isNewSession: boolean): void {
    this.observeProcessEvents(process);

    const log = getLogger();
    log.info(
      {
        event: "session_registered",
        sessionId: process.sessionId,
        processId: process.id,
        projectId: process.projectId,
        projectPath: process.projectPath,
        isNewSession,
        permissionMode: process.permissionMode,
      },
      `Session registered: ${process.sessionId} (process: ${process.id})`,
    );

    this.processes.set(process.id, process);
    this.sessionToProcess.set(process.sessionId, process.id);
    this.everOwnedSessions.add(process.sessionId);
    this.sessionDone.recoverPendingDone(process);
    this.onProcessInventoryChanged?.();

    const ownership = sessionOwnershipFromProcess(process);

    // Emit session created event for new sessions
    if (isNewSession) {
      this.emitSessionCreated(process, ownership);
      this.scheduleInitialSessionReconciliation(
        process.sessionId,
        process.projectId,
      );
    }

    // Emit ownership change event
    this.emitOwnershipChange(process.sessionId, process.projectId, ownership);

    // Emit initial agent activity (process starts in in-turn state)
    if (
      process.state.type === "in-turn" ||
      process.state.type === "waiting-input"
    ) {
      this.emitProcessActivity(process);
    }

    // Emit worker activity after registering (new worker added)
    this.emitWorkerActivity();
  }

  private async persistProcessSandboxOrAbort(process: Process): Promise<void> {
    if (process.sandboxEnforcement?.effective !== "project-write") {
      return;
    }
    if (!process.sandboxStateKey || !this.sessionMetadataService) {
      await process.abort();
      throw new Error(
        "Sandboxed sessions require durable session metadata before provider work begins.",
      );
    }
    try {
      await this.sessionMetadataService.setSessionSandbox(process.sessionId, {
        ...persistedSandboxFromProcess(process),
        level: "project-write",
      });
    } catch (error) {
      await process.abort();
      throw new Error(
        `Failed to persist session sandbox metadata: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error },
      );
    }
  }

  private assertSessionSandboxSettings(
    modelSettings: ModelSettings | undefined,
  ): void {
    if (modelSettings?.computerControl)
      throw new Error(RETIRED_COMPUTER_CONTROL_ERROR);
    const error = getSessionSandboxSettingsError(
      modelSettings?.sandboxLevel,
      modelSettings?.recapMode,
    );
    if (error) {
      throw new Error(error);
    }
  }

  private assertProcessSandboxMatches(
    process: Process,
    modelSettings: ModelSettings | undefined,
  ): void {
    const requested = modelSettings?.sandboxLevel ?? "none";
    const effective = process.sandboxEnforcement?.effective ?? "none";
    const stateKeyChanged =
      requested === "project-write" &&
      modelSettings?.sandboxStateKey !== undefined &&
      modelSettings.sandboxStateKey !== process.sandboxStateKey;
    const requestedNetworkFirewall =
      requested === "project-write" &&
      modelSettings?.sandboxNetworkFirewall !== false;
    const effectiveNetworkFirewall =
      effective === "project-write" &&
      process.sandboxEnforcement?.networkFirewall !== false;
    const networkFirewallChanged =
      requestedNetworkFirewall !== effectiveNetworkFirewall;
    if (requested !== effective || stateKeyChanged || networkFirewallChanged) {
      throw new Error(
        "The live process does not match this session's settled sandbox configuration.",
      );
    }
  }

  /**
   * An operator API token for a launch that may hold one: local and outside
   * any YA session sandbox. A limited user's launch is always sandboxed.
   */
  private agentServerAccessForLaunch(
    sandboxed: boolean,
    executor: string | undefined,
  ): AgentServerAccess | undefined {
    if (sandboxed || executor) return undefined;
    return this.mintAgentServerAccess?.();
  }

  /** Tie a launch's token to its process, or revoke it if none started. */
  private holdAgentServerAccess(
    process: Process | null,
    access: AgentServerAccess | undefined,
  ): void {
    if (!access) return;
    if (process) this.agentServerAccessByProcess.set(process.id, access);
    else access.revoke();
  }

  private unregisterProcess(process: Process): void {
    this.instructionSessions.delete(process);
    this.agentServerAccessByProcess.get(process.id)?.revoke();
    this.agentServerAccessByProcess.delete(process.id);
    this.assertProviderOwnershipSettled(process, "unregister");
    this.observedProcessIds.delete(process.id);
    this.compactThresholdCheckedAssistantVersion.delete(process.id);
    this.compactionSettledAtAssistantVersion.delete(process.id);
    this.thresholdCompactionInFlight.delete(process.id);
    this.pendingPostCompactReplay.delete(process.id);
    this.cacheMissBillingMonitor.forgetProcess(process.id);
    this.tokenUsageRecorder.forgetProcess(process);
    this.activationCoordinator.discardProcess(process);
    this.pendingForkedRecapRequests.delete(process.id);
    this.forkedRecapInFlight.get(process.id)?.abort();
    this.forkedRecapInFlight.delete(process.id);
    const patientTimer = this.patientCheckTimers.get(process.id);
    if (patientTimer) {
      clearTimeout(patientTimer);
      this.patientCheckTimers.delete(process.id);
    }
    if (!this.processes.has(process.id)) {
      return;
    }

    const log = getLogger();
    const durationMs = Date.now() - process.startedAt.getTime();
    log.info(
      {
        event: "session_unregistered",
        sessionId: process.sessionId,
        processId: process.id,
        projectId: process.projectId,
        durationMs,
        finalState: process.state.type,
        terminationReason: process.terminationReason,
      },
      `Session unregistered: ${process.sessionId} after ${durationMs}ms (reason: ${process.terminationReason ?? process.state.type})`,
    );

    // Capture process info for terminated list before deleting
    const terminatedInfo = process.getInfo();
    terminatedInfo.state = "terminated"; // Override state since process may have been forcefully aborted
    terminatedInfo.terminatedAt = new Date().toISOString();
    if (process.terminationReason) {
      terminatedInfo.terminationReason = process.terminationReason;
    }
    this.addTerminatedProcess(terminatedInfo);

    this.processes.delete(process.id);
    this.onProcessInventoryChanged?.();

    // Delete all session ID mappings that point to this process
    // This handles both temp and real session IDs
    for (const [sessionId, processId] of this.sessionToProcess.entries()) {
      if (processId === process.id) {
        this.sessionToProcess.delete(sessionId);
      }
    }

    if (this.getHeartbeatTurnSettings?.(process.sessionId)?.enabled) {
      // An opted-in session losing its process is exactly how it joins the
      // unowned-candidate half, which may have settled to "nothing due".
      this.heartbeatCandidateDueAtMs = 0;
    }

    // Emit ownership change event (back to none)
    this.emitOwnershipChange(
      process.sessionId,
      process.projectId,
      sessionOwnershipFromProcess(undefined),
    );

    // Emit agent activity change to notify clients that this session is no longer running
    // This is needed for real-time updates (e.g., AgentsNavItem indicator)
    this.emitAgentActivityChange(process.sessionId, process.projectId, "idle");

    // Emit worker activity after unregistering (worker removed)
    this.emitWorkerActivity();

    // Process queue when a worker becomes available
    void this.processQueue();
  }

  /**
   * Add a terminated process to the tracking list.
   * Prunes old entries and caps at MAX_TERMINATED_PROCESSES.
   */
  private addTerminatedProcess(info: ProcessInfo): void {
    // A YA session has one canonical row. Restarting or reaping another
    // provider process replaces its older stopped-process snapshot.
    this.terminatedProcesses = this.terminatedProcesses.filter(
      (existing) => existing.sessionId !== info.sessionId,
    );
    this.terminatedProcesses.push(info);

    // Cap at max entries
    if (this.terminatedProcesses.length > MAX_TERMINATED_PROCESSES) {
      this.terminatedProcesses = this.terminatedProcesses.slice(
        -MAX_TERMINATED_PROCESSES,
      );
    }
  }

  /**
   * Get recently terminated processes (within retention window).
   * Prunes expired entries before returning.
   */
  getRecentlyTerminatedProcesses(): ProcessInfo[] {
    const now = Date.now();
    const cutoff = now - TERMINATED_RETENTION_MS;

    const activeSessionIds = new Set(
      [...this.processes.values()].map((process) => process.sessionId),
    );
    const seenSessionIds = new Set<string>();
    const canonicalStopped: ProcessInfo[] = [];

    // Walk newest-first so an already-populated history also heals to one
    // stopped row per session. A currently active row always wins.
    for (let index = this.terminatedProcesses.length - 1; index >= 0; index--) {
      const process = this.terminatedProcesses[index];
      if (!process?.terminatedAt) continue;
      if (new Date(process.terminatedAt).getTime() <= cutoff) continue;
      if (activeSessionIds.has(process.sessionId)) continue;
      if (seenSessionIds.has(process.sessionId)) continue;
      seenSessionIds.add(process.sessionId);
      canonicalStopped.push(process);
    }
    this.terminatedProcesses = canonicalStopped.reverse();

    return [...this.terminatedProcesses];
  }

  private emitOwnershipChange(
    sessionId: string,
    projectId: UrlProjectId,
    ownership: SessionOwnership,
  ): void {
    if (!this.eventBus) return;

    const event: SessionStatusEvent = {
      type: "session-status-changed",
      sessionId,
      projectId,
      ownership,
      timestamp: new Date().toISOString(),
    };
    this.eventBus.emit(event);
  }

  private emitSessionCreated(
    process: Process,
    ownership: SessionOwnership,
  ): void {
    if (!this.eventBus) return;

    const now = new Date().toISOString();
    const optimistic = this.buildOptimisticSessionSeed(process);
    const info = process.getInfo();
    const session: SessionSummary = {
      id: process.sessionId,
      projectId: process.projectId,
      projectName: info.projectName,
      title: optimistic.title,
      fullTitle: optimistic.fullTitle,
      createdAt: now,
      updatedAt: now,
      messageCount: optimistic.messageCount,
      ownership,
      provider: process.provider,
      initialPrompt: optimistic.fullTitle ?? undefined,
      model: info.model,
      executor: info.executor,
      activity: info.state,
    };

    const event: SessionCreatedEvent = {
      type: "session-created",
      session,
      timestamp: now,
    };
    this.eventBus.emit(event);
  }

  private buildOptimisticSessionSeed(process: Process): {
    title: string | null;
    fullTitle: string | null;
    messageCount: number;
  } {
    const history = process.getMessageHistory();
    const firstUser = history.find(
      (msg) => msg.type === "user" && typeof msg.message?.content === "string",
    );
    const firstContent = firstUser?.message?.content;
    const fullTitle =
      typeof firstContent === "string" ? firstContent.trim() : "";
    if (!fullTitle) {
      return { title: null, fullTitle: null, messageCount: 0 };
    }

    const title = truncateSessionTitle(fullTitle) || null;

    return { title, fullTitle, messageCount: 1 };
  }

  private scheduleInitialSessionReconciliation(
    sessionId: string,
    projectId: UrlProjectId,
  ): void {
    if (!this.eventBus || !this.onSessionSummary) return;

    for (const delayMs of INITIAL_RECONCILE_DELAYS_MS) {
      const timer = setTimeout(() => {
        void this.emitReconciledSessionUpdate(sessionId, projectId);
      }, delayMs);
      timer.unref();
    }
  }

  private async emitReconciledSessionUpdate(
    sessionId: string,
    projectId: UrlProjectId,
  ): Promise<void> {
    if (!this.eventBus || !this.onSessionSummary) return;

    const summary = await this.onSessionSummary(sessionId, projectId);
    if (!summary) return;

    const event: SessionUpdatedEvent = {
      type: "session-updated",
      sessionId,
      projectId,
      title: summary.title,
      messageCount: summary.messageCount,
      updatedAt: summary.updatedAt,
      contextUsage: summary.contextUsage,
      model: summary.model,
      lastAgentText: summary.lastAgentText,
      asyncQuestions: summary.asyncQuestions,
      timestamp: new Date().toISOString(),
    };
    this.eventBus.emit(event);
  }

  private emitAgentActivityChange(
    sessionId: string,
    projectId: UrlProjectId,
    activity: AgentActivity,
    pendingInputType?: PendingInputType,
  ): void {
    // A session settling into idle, draining its queue, or releasing provider
    // retention can pull its heartbeat deadline earlier than the armed one.
    this.requestHeartbeatSweep();
    if (!this.eventBus) return;

    const event: ProcessStateEvent = {
      type: "process-state-changed",
      sessionId,
      projectId,
      activity,
      pendingInputType,
      timestamp: new Date().toISOString(),
    };
    this.eventBus.emit(event);
  }

  /** Publish a live process's activity exactly as its session rows show it. */
  private emitProcessActivity(process: Process): void {
    const { activity, pendingInputType } =
      sessionActivityEventFromProcess(process);
    this.emitAgentActivityChange(
      process.sessionId,
      process.projectId,
      activity,
      pendingInputType,
    );
  }

  private emitProcessTerminated(
    sessionId: string,
    projectId: UrlProjectId,
    processId: string,
    provider: ProviderName,
    reason: string,
  ): void {
    if (!this.eventBus) return;

    const event: ProcessTerminatedEvent = {
      type: "process-terminated",
      sessionId,
      projectId,
      processId,
      provider,
      reason,
      timestamp: new Date().toISOString(),
    };
    this.eventBus.emit(event);
  }

  private emitProviderRuntimeStatusChange(
    sessionId: string,
    projectId: UrlProjectId,
    providerRuntimeStatus: ProviderRuntimeStatus,
  ): void {
    if (!this.eventBus) return;

    const event: ProviderRuntimeStatusChangedEvent = {
      type: "provider-runtime-status-changed",
      sessionId,
      projectId,
      providerRuntimeStatus,
      timestamp: new Date().toISOString(),
    };
    this.eventBus.emit(event);
  }

  private handleProviderRetentionChanged(processHolder: {
    process: Process | null;
  }): void {
    const process = processHolder.process;
    process?.handleProviderRetentionChanged();
    this.emitWorkerActivity();
    // Background work starting/finishing flips an idle session between active
    // and truly idle without a state-change event. Surface that so inbox/sidebar
    // activity indicators update live rather than only on the next refresh.
    if (process && process.state.type === "idle") {
      this.emitProcessActivity(process);
      if (!process.isRetainingProviderWork()) {
        void this.finalizePendingDone(process);
        void this.maybeCompactAfterIdle(process);
        void this.maybePostCompactReplay(process);
      }
    }
  }

  private processHasActiveWork(process: Process): boolean {
    if (
      process.state.type === "in-turn" ||
      process.state.type === "waiting-input"
    ) {
      return true;
    }
    return (
      process.getLivenessSnapshot().derivedStatus ===
      "verified-waiting-provider"
    );
  }

  private processHasInterruptibleActiveWork(process: Process): boolean {
    return (
      this.processHasActiveWork(process) && !process.canDetachForServerReload()
    );
  }

  /**
   * Emit worker activity event for safe restart indicator.
   * Called when workers are added, removed, or change state.
   */
  private emitWorkerActivity(): void {
    // Processes appearing and leaving move sessions between the owned and
    // unowned halves of the sweep.
    this.requestHeartbeatSweep();
    if (!this.eventBus) return;

    const interruptibleSessionCount = Array.from(
      this.processes.values(),
    ).filter((p) => this.processHasInterruptibleActiveWork(p)).length;
    const queuedSessionMessageCount = this.getQueuedSessionMessageCount();

    const event: WorkerActivityEvent = {
      type: "worker-activity-changed",
      activeWorkers: this.processes.size,
      interruptibleSessionCount,
      queueLength: this.workerQueue.length,
      queuedSessionMessageCount,
      hasActiveWork: interruptibleSessionCount > 0,
      timestamp: new Date().toISOString(),
    };
    this.eventBus.emit(event);
  }

  private getQueuedSessionMessageCount(): number {
    let count = this.workerQueue.length;
    for (const process of this.processes.values()) {
      count += process.queueDepth;
      count += process.getDeferredQueueSummary().length;
    }
    return count;
  }

  async preserveRestartablePatientQueuesForRestart(): Promise<number> {
    if (!this.sessionQueuePersistenceService || this.workerQueue.length > 0) {
      return 0;
    }

    const processes = Array.from(this.processes.values()).filter(
      (process) => !process.isTerminated,
    );
    if (processes.some((process) => this.processHasActiveWork(process))) {
      return 0;
    }
    if (
      processes.some(
        (process) =>
          process.queueDepth > 0 || process.hasVolatileDeferredMessages(),
      )
    ) {
      return 0;
    }

    let preservedCount = 0;
    for (const process of processes) {
      preservedCount +=
        await process.preservePatientDeferredMessagesForRestart();
    }
    if (preservedCount > 0) {
      this.emitWorkerActivity();
    }
    return preservedCount;
  }

  // ============ Staleness Detection ============

  /**
   * Terminate processes stuck in "in-turn" with no SDK messages for too long.
   * This catches phantom processes where the underlying Claude process died
   * without the SDK iterator returning done or throwing.
   *
   * When process liveness checking is available (via spawn wrapper), use it to
   * distinguish "process died silently" from "process is busy with a long tool
   * call". Silence alone is not a termination signal; a turn may legitimately
   * run for hours.
   */
  private terminateStaleProcesses(): void {
    const now = Date.now();

    for (const process of this.processes.values()) {
      if (process.state.type !== "in-turn") continue;

      const staleThresholdMs = getStaleInTurnThresholdMs(process.provider);
      const silentMs = now - process.lastMessageTime.getTime();
      if (silentMs < staleThresholdMs) continue;

      // If we can check process liveness, only terminate actually-dead processes.
      // A long-running tool call (e.g., CI wait) will be silent but the process
      // is still alive — don't kill it.
      const alive = process.isProcessAlive;
      if (alive === true) {
        // Process is alive but silent — likely executing a long tool call. Skip.
        continue;
      }

      const log = getLogger();

      if (alive === undefined) {
        log.warn(
          {
            event: "stale_process_liveness_unknown",
            sessionId: process.sessionId,
            processId: process.id,
            projectId: process.projectId,
            provider: process.provider,
            silentMs,
            staleThresholdMs,
            startedAt: process.startedAt.toISOString(),
            lastMessageTime: process.lastMessageTime.toISOString(),
            livenessAvailable: false,
          },
          `Leaving long-silent process running without liveness check: ${process.sessionId} (no messages for ${Math.round(silentMs / 1000)}s)`,
        );
        continue;
      }

      // alive === false — process is confirmed dead
      log.warn(
        {
          event: "stale_process_dead",
          sessionId: process.sessionId,
          processId: process.id,
          projectId: process.projectId,
          provider: process.provider,
          silentMs,
          staleThresholdMs,
          startedAt: process.startedAt.toISOString(),
          lastMessageTime: process.lastMessageTime.toISOString(),
        },
        `Terminating dead process: ${process.sessionId} (exited, silent for ${Math.round(silentMs / 1000)}s)`,
      );

      process.terminate(
        `stale: no SDK messages for ${Math.round(silentMs / 1000)}s`,
      );
    }
  }

  // ============ Worker Pool Methods ============

  /**
   * Check if we're at worker capacity.
   */
  private isAtCapacity(): boolean {
    if (this.maxWorkers <= 0) return false; // 0 = unlimited
    return this.processes.size >= this.maxWorkers;
  }

  /**
   * Find a preemptable worker (idle longer than threshold).
   * Returns the worker that has been idle longest.
   * Does not preempt workers waiting for input.
   */
  private findPreemptableWorker(): Process | undefined {
    let oldest: Process | undefined;
    let oldestIdleTime = 0;
    const now = Date.now();

    for (const process of this.processes.values()) {
      // Only preempt idle processes, not waiting-input
      if (process.state.type !== "idle") continue;

      const idleMs = now - process.state.since.getTime();
      if (idleMs >= this.idlePreemptThresholdMs && idleMs > oldestIdleTime) {
        oldest = process;
        oldestIdleTime = idleMs;
      }
    }

    return oldest;
  }

  /**
   * Preempt an idle worker to make room for a new request.
   */
  private async preemptWorker(process: Process): Promise<void> {
    await process.abort();
    this.unregisterProcess(process);
  }

  /**
   * Process the queue - called when a worker becomes available.
   */
  private async processQueue(): Promise<void> {
    while (!this.workerQueue.isEmpty && !this.isAtCapacity()) {
      const request = this.workerQueue.dequeue();
      if (!request) break;

      try {
        let process: Process;

        if (request.type === "new-session") {
          const result = await this.startSessionInternal(
            request.projectPath,
            request.projectId,
            request.message,
            undefined,
            request.permissionMode,
            request.modelSettings,
            request.retryProviderStartupFailure,
            request.requireProviderSessionId,
          );
          process = result;
        } else {
          const result = await this.startSessionInternal(
            request.projectPath,
            request.projectId,
            request.message,
            request.sessionId,
            request.permissionMode,
            request.modelSettings,
            false,
            false,
          );
          process = result;
        }

        if (request.workstreamId) {
          await this.sessionMetadataService?.setWorkstream(
            process.sessionId,
            request.workstreamId,
          );
        }

        // Emit queue removed event
        this.eventBus?.emit({
          type: "queue-request-removed",
          queueId: request.id,
          sessionId: request.sessionId,
          reason: "started",
          timestamp: new Date().toISOString(),
        });

        request.resolve({ status: "started", processId: process.id });
        try {
          await request.onStarted?.(process.sessionId, process);
        } catch (error) {
          getLogger().warn(
            {
              event: "queued_session_started_callback_failed",
              sessionId: process.sessionId,
              processId: process.id,
              projectId: request.projectId,
              queueId: request.id,
              error: error instanceof Error ? error.message : String(error),
            },
            "Queued session started but its association callback failed",
          );
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        this.eventBus?.emit({
          type: "queue-request-removed",
          queueId: request.id,
          sessionId: request.sessionId,
          reason: "cancelled",
          timestamp: new Date().toISOString(),
        });
        request.resolve({ status: "cancelled", reason });
        try {
          const failureCallback =
            error instanceof RetryableSessionLaunchError
              ? request.onRetryableFailure
              : request.onFailed;
          await failureCallback?.(reason);
        } catch (callbackError) {
          getLogger().warn(
            {
              event: "queued_session_failed_callback_failed",
              projectId: request.projectId,
              queueId: request.id,
              error:
                callbackError instanceof Error
                  ? callbackError.message
                  : String(callbackError),
            },
            "Queued session failed and its failure callback also failed",
          );
        }
      }
    }
  }

  /**
   * Internal session start that always starts immediately.
   * Used by queue processing.
   */
  private async startSessionInternal(
    projectPath: string,
    projectId: UrlProjectId,
    message: UserMessage,
    resumeSessionId?: string,
    permissionMode?: PermissionMode,
    modelSettings?: ModelSettings,
    retryProviderStartupFailure = false,
    requireProviderSessionId = false,
  ): Promise<Process> {
    const resolved = resumeSessionId
      ? await this.activationCoordinator.resolveColdLaunchSettings(
          projectId,
          resumeSessionId,
          permissionMode,
          modelSettings,
        )
      : { permissionMode, modelSettings };
    const provider = this.resolveProvider(resolved.modelSettings);

    // Use provider if available (preferred)
    if (provider) {
      return this.startProviderSession(
        projectPath,
        projectId,
        message,
        resumeSessionId,
        resolved.permissionMode,
        resolved.modelSettings,
        provider,
        retryProviderStartupFailure,
        requireProviderSessionId,
      );
    }

    // Use real SDK if available
    if (this.realSdk) {
      return this.startRealSession(
        projectPath,
        projectId,
        message,
        resumeSessionId,
        resolved.permissionMode,
        resolved.modelSettings,
      );
    }

    // Fall back to legacy mock SDK
    return this.startLegacySession(
      projectPath,
      projectId,
      message,
      resumeSessionId,
      resolved.permissionMode,
      resolved.modelSettings,
    );
  }

  // ============ Public Queue Methods ============

  /**
   * Cancel a queued request.
   * @returns true if cancelled, false if not found
   */
  cancelQueuedRequest(queueId: string): boolean {
    return this.workerQueue.cancel(queueId);
  }

  /**
   * Get info about all queued requests.
   */
  getQueueInfo(): QueuedRequestInfo[] {
    return this.workerQueue.getQueueInfo();
  }

  /**
   * Get position for a specific queue entry.
   */
  getQueuePosition(queueId: string): number | undefined {
    return this.workerQueue.getPosition(queueId);
  }

  /**
   * Get current worker count and capacity info.
   */
  getWorkerPoolStatus(): {
    activeWorkers: number;
    maxWorkers: number;
    queueLength: number;
  } {
    return {
      activeWorkers: this.processes.size,
      maxWorkers: this.maxWorkers,
      queueLength: this.workerQueue.length,
    };
  }

  /**
   * Get worker activity status for safe restart indicator.
   * Returns whether any workers are actively processing or waiting for input.
   */
  getWorkerActivity(): {
    activeWorkers: number;
    interruptibleSessionCount: number;
    queueLength: number;
    queuedSessionMessageCount: number;
    hasActiveWork: boolean;
  } {
    const interruptibleSessionCount = Array.from(
      this.processes.values(),
    ).filter((p) => this.processHasInterruptibleActiveWork(p)).length;
    return {
      activeWorkers: this.processes.size,
      interruptibleSessionCount,
      queueLength: this.workerQueue.length,
      queuedSessionMessageCount: this.getQueuedSessionMessageCount(),
      hasActiveWork: interruptibleSessionCount > 0,
    };
  }
}
