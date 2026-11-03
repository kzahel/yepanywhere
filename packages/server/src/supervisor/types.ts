import type {
  DurableLocalCommandMessage,
  SessionClearloopBadge,
} from "@yep-anywhere/shared";
import type {
  AppSessionSummary,
  NonHumanUserTurn,
  AgentActivity,
  CodexAsyncUserInputQuestion,
  ContextUsage,
  DurableRecapMessage,
  EffortLevel,
  InputRequest,
  PendingInputType,
  PermissionRules,
  PromptSuggestionMode,
  ProviderRuntimeStatus,
  ProviderChildSessionSummary,
  ProviderName,
  RecapMode,
  SessionSandboxEnforcement,
  SessionQueuedYaCommand,
  ThinkingConfig,
  UrlProjectId,
  SessionLivenessSnapshot,
  ToolResultMedia,
} from "@yep-anywhere/shared";
import type { PermissionMode, SDKMessage } from "../sdk/types.js";

export const DEFAULT_IDLE_PREEMPT_THRESHOLD_MS = 10 * 1000; // 10 seconds - workers idle longer than this can be preempted

// Re-export path utilities for backward compatibility
// See packages/server/src/projects/paths.ts for full documentation on encoding schemes
export { decodeProjectId, encodeProjectId } from "../projects/paths.js";

// Re-export shared types used by server
export type {
  AgentActivity,
  ContextUsage,
  InputRequest,
  PendingInputType,
} from "@yep-anywhere/shared";

// Project discovery
export interface Project {
  id: UrlProjectId; // base64url encoded path
  path: string; // absolute path
  name: string; // directory name
  sessionCount: number;
  sessionCountsByProvider?: Partial<Record<ProviderName, number>>;
  sessionDir: string; // path to session directory (e.g., ~/.claude/projects/hostname/-encoded-path/)
  mergedSessionDirs?: string[]; // additional session dirs from cross-machine duplicates
  hasCodexSessions?: boolean; // whether this project also has Codex sessions
  hasGeminiSessions?: boolean; // whether this project also has Gemini sessions
  activeOwnedCount: number; // sessions owned by this server
  activeExternalCount: number; // sessions controlled by external processes
  lastActivity: string | null; // ISO timestamp of most recent session update
  provider: ProviderName; // which provider's sessions are in this project
  /** Limited user who added it; absent means the superuser did. */
  ownerUsername?: string;
}

// Session ownership - who controls the session
export type SessionOwnership =
  | { owner: "none" } // no active process
  | {
      owner: "self";
      processId: string;
      permissionMode?: PermissionMode;
      /** Mode applied at the latest successful provider policy boundary. */
      appliedPermissionMode?: PermissionMode;
      modeVersion?: number;
      recapAfterSeconds?: number;
    } // we control it
  | { owner: "external" }; // another process owns it

/**
 * Session sandbox policy from Codex turn_context.
 */
export interface SessionSandboxPolicy {
  type: string;
  networkAccess?: boolean;
  excludeTmpdirEnvVar?: boolean;
  excludeSlashTmp?: boolean;
}

// Session metadata (light, for lists)
export interface SessionSummary {
  creation?: AppSessionSummary["creation"];
  id: string;
  projectId: UrlProjectId;
  /** Human-readable project basename for display; projectId remains canonical. */
  projectName?: string;
  title: string | null; // first 120 chars of first user message (truncated with ...)
  fullTitle: string | null; // complete first user message (for hover tooltip)
  createdAt: string; // ISO timestamp
  updatedAt: string;
  messageCount: number;
  ownership: SessionOwnership;
  // Notification fields (added by enrichSessionsWithNotifications)
  /** Type of pending input if session needs user action */
  pendingInputType?: PendingInputType;
  /** When the session was last viewed (if tracked) */
  lastSeenAt?: string;
  /** Whether session has new content since last viewed */
  hasUnread?: boolean;
  // Metadata fields (added from SessionMetadataService)
  /** Custom title that overrides auto-generated title */
  customTitle?: string;
  /** Whether the session is archived (hidden from default list) */
  isArchived?: boolean;
  /** Whether the session is starred/favorited */
  isStarred?: boolean;
  /** Interactive Mother session for a YA-owned `/btw` aside. */
  parentSessionId?: string;
  /** Explicit meaning of parentSessionId; absent on legacy records. */
  parentSessionKind?: "btw-aside";
  /** Source session whose provider transcript was cloned or forked. */
  forkedFromSessionId?: string;
  /** Client-declared creation source for a YA-owned session. */
  creationProvenance?: import("@yep-anywhere/shared").SessionCreationProvenance;
  /** Initial prompt text accepted by YA for new-session recovery/copy. */
  initialPrompt?: string;
  /** Context usage from the last assistant message */
  contextUsage?: ContextUsage;
  /** AI provider used for this session */
  provider: ProviderName;
  /** Model used for this session (extracted from JSONL, e.g. "claude-opus-4-5-20251101") */
  model?: string;
  /** Current activity and executor, supplied with owned-session creation events. */
  activity?: AgentActivity;
  executor?: string;
  /**
   * Excerpt of the most recent visible regular agent turn or provider recap,
   * capped to the last few lines. Shown in the row hover card so a glance
   * answers "where did this land?". A "⚙ <tool>" label when the latest turns
   * are tool-only. Hidden thinking does not populate this field. Undefined when
   * the provider's reader does not populate it yet, or there is no agent text. See
   * topics/session-hovercard-recent-activity.md.
   */
  lastAgentText?: string;
  /**
   * When someone last wrote into this session, which agent work never
   * advances. The sidebar orders by the reader's own turns, so that ordering
   * has to come from here rather than from what one browser remembers about
   * its own visits. Undefined when the provider's reader does not report it.
   */
  lastHumanTurnAt?: string;
  asyncQuestions?: AppSessionSummary["asyncQuestions"];
  /** Launcher identifier from session metadata (e.g. "Codex Desktop", "yep-anywhere") */
  originator?: string;
  /** CLI version from session metadata (e.g. "0.101.0") */
  cliVersion?: string;
  /** Session source from session metadata (e.g. "vscode", "exec") */
  source?: string;
  /** Approval policy from turn_context (e.g. "never", "on-request") */
  approvalPolicy?: string;
  /** Sandbox policy from turn_context */
  sandboxPolicy?: SessionSandboxPolicy;
  /** Provider-launched child work nested under this parent. Absent on older servers. */
  providerChildren?: ProviderChildSessionSummary[];
}

/**
 * Content block in messages - loosely typed to preserve all fields.
 * This is the server's internal representation for JSONL parsing.
 */
export interface ContentBlock {
  type: string;
  // text block
  text?: string;
  // thinking block
  thinking?: string;
  signature?: string;
  // tool_use block
  id?: string;
  name?: string;
  input?: unknown;
  // tool_result block
  tool_use_id?: string;
  content?: string;
  is_error?: boolean;
  // Allow any additional fields
  [key: string]: unknown;
}

/**
 * Message representation - loosely typed to preserve all JSONL fields.
 *
 * We pass through all fields from JSONL without stripping.
 * This preserves debugging info, DAG structure, and metadata.
 *
 * Note: Use `uuid` for message identification. The `message.content` nested
 * field contains the actual content. Use `type` for discrimination (user/assistant).
 */
export interface Message {
  type: string;
  uuid?: string;
  timestamp?: string;
  // DAG structure
  parentUuid?: string | null;
  // Nested message structure from SDK
  message?: {
    content?: string | ContentBlock[];
    role?: string;
    [key: string]: unknown;
  };
  // Tool use related
  toolUse?: {
    id: string;
    name: string;
    input: unknown;
  };
  toolUseResult?: unknown;
  toolResultMedia?: ToolResultMedia[];
  // Computed fields (added by SessionReader)
  orphanedToolUseIds?: string[];
  /**
   * YA-computed, Claude queue-operation rows only: when the queued message
   * was delivered into the turn (the remove op's timestamp). The row keeps
   * its enqueue-position lineIndex, so incremental afterMessageId slicing
   * uses this to include rows that postdate a mid-turn anchor
   * (sessions/pagination.ts).
   */
  queueDeliveredAt?: string;
  /** Codex agent message delivered while its originating turn kept running. */
  codexAgentMessageDelivery?: "async";
  /** Structured questions attached to an asynchronous Codex agent message. */
  codexAsyncQuestions?: CodexAsyncUserInputQuestion[];
  // Allow any additional fields from JSONL
  [key: string]: unknown;
}

// Full session with messages
export interface Session extends SessionSummary {
  messages: Message[];
}

// Process state machine
export type ProcessState =
  | { type: "in-turn" }
  | { type: "idle"; since: Date }
  | { type: "waiting-input"; request: InputRequest }
  | { type: "terminated"; reason: string; error?: Error };

// Process info (for API responses)
export interface ProcessInfo {
  steering?: import("@yep-anywhere/shared").ProviderSteeringState;
  id: string;
  sessionId: string;
  projectId: UrlProjectId;
  projectPath: string;
  projectName: string; // path.basename(projectPath)
  sessionTitle: string | null; // from session data
  /** Iterations a running `/clearloop` still has to do; absent when none runs. */
  clearloop?: SessionClearloopBadge;
  state: AgentActivity;
  startedAt: string;
  queueDepth: number;
  idleSince?: string; // ISO timestamp when entered idle
  terminationReason?: string; // why it terminated
  terminatedAt?: string; // when it terminated (ISO timestamp)
  provider: ProviderName; // which provider is running this process
  /** Thinking configuration (undefined = thinking disabled) */
  thinking?: ThinkingConfig;
  /** Selected effort for the next response (undefined = provider default) */
  effort?: EffortLevel;
  /** Provider-visible service tier. undefined means provider/default behavior. */
  serviceTier?: string;
  /** Reported model for this session (e.g., "claude-opus-4-5-20251101"), for display */
  model?: string;
  /**
   * YA model id for keying per-model settings: the requested launch alias when
   * YA owns the session (survives restart via persisted metadata), else the
   * reported model mapped back through the provider's yaModelIdForReported.
   * See topics/provider-abstraction.md § Per-model settings keying.
   */
  requestedModel?: string;
  /**
   * Configured model endpoint the provider bound this session to when it
   * launched. Auto-stop counts the session against it (gatewayServiceUsage).
   */
  gatewayServiceId?: string;
  /** Context window usage from the last assistant message */
  contextUsage?: ContextUsage;
  /** SSH host for remote execution (undefined = local) */
  executor?: string;
  /** OS PID of the spawned agent child process */
  pid?: number;
  /** Provider/session progress evidence, separate from transport liveness. */
  liveness?: SessionLivenessSnapshot;
  /** Current provider retry/failure status for the live turn, when available. */
  providerRuntimeStatus?: ProviderRuntimeStatus;
  /** Current recap behavior for this live process. */
  recapMode?: RecapMode;
  /** Browser-away duration before YA asks this process for a recap. */
  recapAfterSeconds?: number;
  /** Current prompt-suggestion behavior for this live process. */
  promptSuggestionMode?: PromptSuggestionMode;
  /** Provider-native child work attached to this canonical YA session. */
  providerChildren?: ProviderChildSessionSummary[];
  /** Session-level helper side model for simulated helper features. */
  helperSideModel?: string;
  /** YA-owned host filesystem confinement evidence for this process. */
  sandboxEnforcement?: SessionSandboxEnforcement;
}

export interface ProcessAbortResult {
  processId: string;
  sessionId: string;
  /** PID captured before provider shutdown clears its child handle. */
  pid?: number;
  verifiedStopped: true;
  verification: "pid" | "provider" | "iterator";
}

// Process events for subscribers
export type ProcessEvent =
  | { type: "non-human-user-turn"; turn: NonHumanUserTurn }
  | { type: "message"; message: SDKMessage }
  | { type: "user-turn-accepted"; startedAtMs: number }
  | {
      type: "provider-turn-started";
      startedAtMs: number;
      turnKind: "human" | "automatic";
    }
  | { type: "state-change"; state: ProcessState }
  | { type: "liveness-update" }
  | {
      type: "provider-runtime-status-change";
      status: ProviderRuntimeStatus;
    }
  | { type: "mode-change"; mode: PermissionMode; version: number }
  | { type: "mode-applied"; mode: PermissionMode }
  | {
      type: "configuration-applied";
      setting: "model" | "thinking" | "effort" | "serviceTier";
    }
  /** The served model changed, e.g. a reply named the model behind an alias. */
  | { type: "model-resolved"; model: string }
  | {
      type: "context-window-observed";
      model: string;
      contextWindow: number;
      provider: ProviderName;
    }
  | {
      type: "configuration-error";
      setting: "effort";
      requestedValue?: EffortLevel;
      error: Error;
    }
  | { type: "error"; error: Error }
  | { type: "idle-reap" }
  | { type: "complete" }
  | {
      type: "terminated";
      reason: string;
      error?: Error;
      /** Attributed notice for an unrequested provider death; Supervisor persists it. */
      failureNotice?: DurableLocalCommandMessage;
    }
  | {
      type: "deferred-queue";
      reason?: "queued" | "cancelled" | "promoted";
      tempId?: string;
      yaCommand?: SessionQueuedYaCommand;
      /**
       * Only a server-owned entry outside this process's queues changed (the
       * `/clearloop` job re-checking); no queue this process holds moved.
       */
      republished?: boolean;
    }
  | {
      type: "recap-result";
      result: {
        supported: boolean;
        emitted: boolean;
        reason?: string;
        text?: string;
        syntheticMessage?: DurableRecapMessage;
      };
    };

// Process options
export interface ProcessOptions {
  projectPath: string;
  projectId: UrlProjectId;
  sessionId: string;
  /**
   * Lifecycle state before the provider emits anything. Message-less create
   * and reactivate flows start idle; turn-bearing flows keep the default.
   */
  initialState?: "in-turn" | "idle";
  idleTimeoutMs?: number; // default 24 hours; negative disables idle reaping
  permissionMode?: PermissionMode;
  provider: ProviderName; // which provider is running this process
  /** Thinking configuration (undefined = thinking disabled) */
  thinking?: ThinkingConfig;
  /** Effort level for response quality (undefined = SDK default) */
  effort?: EffortLevel;
  /** Provider-visible service tier. undefined means provider/default behavior. */
  serviceTier?: string;
  /** Model used for this session (e.g., "claude-opus-4-5-20251101") */
  model?: string;
  /** Exact YA model token selected at launch, including "default". */
  requestedModel?: string;
  /** Configured model endpoint the provider bound this session to at launch. */
  gatewayServiceId?: string;
  /** Configured per-model compaction threshold percentage, if any. */
  compactAtContextPercent?: number;
  /** Effective full context window used to derive the threshold. */
  compactAtContextWindow?: number;
  /** Whether YA, rather than a native provider threshold, owns the trigger. */
  forceYaOrchestratedCompaction?: boolean;
  /** Provider-native automatic-compaction limit applied at launch. */
  compactAtContextTokenLimit?: number;
  /** Provider auto-compaction-window percentage applied at launch. */
  launchCompactPercentOverride?: number;
  /** SSH host for remote execution (undefined = local) */
  executor?: string;
  /** How this process should answer away-recap requests. */
  recapMode?: RecapMode;
  /** Browser-away duration before YA asks this process for a recap. */
  recapAfterSeconds?: number;
  /** How this process should request native prompt suggestions. */
  promptSuggestionMode?: PromptSuggestionMode;
  /** Session-level helper side model for simulated helper features. */
  helperSideModel?: string;
  /** Permission rules for tool filtering (deny/allow patterns) */
  permissions?: PermissionRules;
  /** OS PID of the spawned agent child process, or getter for deferred resolution */
  pid?: number | (() => number | undefined);
  /** YA-owned host filesystem confinement evidence for this process. */
  sandboxEnforcement?: SessionSandboxEnforcement;
  /** Opaque private provider-state key persisted with session metadata. */
  sandboxStateKey?: string;
  /** Canonical project path used by the sandbox mount and transcript layout. */
  sandboxProjectPath?: string;
}
