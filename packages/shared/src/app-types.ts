import type { SessionCreationStatus } from "./session-creation.js";
/**
 * App-specific types that extend SDK types with runtime/computed fields.
 *
 * These types are used by the client and server to work with messages
 * that may have additional metadata added during processing.
 *
 * Key principle: SDK types (UserEntry, AssistantEntry) represent what's in JSONL files.
 * App types extend these with runtime fields that are computed or added during processing.
 */

import type { McpAppToolCall } from "./mcp-apps.js";
import type { SessionClearloopBadge } from "./session-rewind.js";
import type {
  AssistantEntry,
  SessionEntry,
  SummaryEntry,
  SystemEntry,
  UserEntry,
} from "./claude-sdk-schema/types.js";
import type { CodexAsyncUserInputQuestion } from "./codex-schema/session.js";
import { isUrlProjectId, type UrlProjectId } from "./projectId.js";
import type {
  EffortLevel,
  PermissionMode,
  PromptSuggestionMode,
  ProviderName,
  RecapMode,
  SlashCommand,
  ThinkingConfig,
} from "./types.js";
import type { ToolDisplayAction } from "./tool-display-actions.js";
import type { ProjectPathLinkTarget } from "./project-path-links.js";
import type { UploadedFile } from "./upload.js";
import type {
  NonHumanUserTurn,
  UserMessageMetadata,
} from "./user-message-metadata.js";

// =============================================================================
// App Message Extensions
// =============================================================================

/**
 * Content block type for app messages.
 * Loosely typed to preserve all fields from JSONL without stripping.
 */
export interface AppContentBlock {
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
  /** YA-derived presentation semantics; recomputed rather than persisted. */
  _displayActions?: ToolDisplayAction[];
  /** The MCP App view this tool call's tool declared. */
  _mcpApp?: McpAppToolCall;
  /** Server-confirmed file links for visible command or result text. */
  _projectPathLinks?: ProjectPathLinkTarget[];
  // tool_result block
  tool_use_id?: string;
  content?: string | AppContentBlock[];
  is_error?: boolean;
  // Allow any additional fields
  [key: string]: unknown;
}

/**
 * Runtime fields added to messages by our application.
 * These are computed or added during processing, not stored in JSONL.
 *
 * Includes convenience fields added by SessionReader.convertMessage():
 * - id: copied from uuid (or fallback to index-based)
 * - content: copied to top level from message.content
 * - role: added based on message type
 */
export type CodexUserTurnMessageProvenance =
  | "paired"
  | "event-only"
  | "legacy-response";

export interface AppMessageExtensions {
  /**
   * Message identifier - copied from uuid by SessionReader.
   * Fallback: "msg-{index}" when uuid is not available.
   */
  id?: string;

  /**
   * Message content copied to top level for convenience.
   * Original is in message.content for user/assistant entries.
   */
  content?: string | AppContentBlock[];

  /**
   * Role derived from message type (user/assistant).
   * Added by SessionReader for convenience.
   */
  role?: "user" | "assistant" | "system";

  /** Server-confirmed file links for visible user-turn text. */
  _projectPathLinks?: ProjectPathLinkTarget[];

  /**
   * IDs of tool_use blocks that don't have a matching tool_result in the message history.
   * Computed by SessionReader via DAG analysis.
   *
   * NOTE: This is a misnomer. These aren't necessarily "orphaned" (abandoned) - they may be
   * actively pending (awaiting approval or currently executing). The client should check
   * process state to determine if tools are truly orphaned vs just pending.
   *
   * TODO: Consider renaming to `toolUsesWithoutResults` for clarity.
   */
  orphanedToolUseIds?: string[];

  /**
   * Source of this message data.
   * - "sdk": Message came from real-time SDK streaming
   * - "jsonl": Message was read from disk (authoritative)
   */
  _source?: "sdk" | "jsonl";

  /**
   * Codex durable user-turn provenance. Present when the server classified a
   * normalized user message from rollout lifecycle evidence or its legacy
   * compatibility path. Clients must prefer this over setup-text heuristics.
   */
  codexUserTurnProvenance?: CodexUserTurnMessageProvenance;

  /** Codex agent message delivered while its originating turn kept running. */
  codexAgentMessageDelivery?: "async";

  /** Structured questions attached to an asynchronous Codex agent message. */
  codexAsyncQuestions?: CodexAsyncUserInputQuestion[];

  /**
   * True if this message is still being streamed (incomplete).
   * Only set during active streaming; cleared when message is complete.
   */
  _isStreaming?: boolean;

  /**
   * True if this message is from a Task subagent.
   * Used for UI grouping and lazy-loading of subagent content.
   */
  isSubagent?: boolean;

  /**
   * 1-based ordinal of this real user turn over the full session sequence,
   * counting turns a same-session rewind later grouped. Stamped by server
   * normalization; the turn menu's `[N]` and `/clear N` share it. See
   * topics/session-rewind.md.
   */
  turnIndex?: number;

  /**
   * Set on rows a same-session rewind dropped. The value is the rewind
   * record id; the UI renders these rows as one collapsed group headed by a
   * `rewound_group` system row carrying the same id. See
   * topics/session-rewind.md.
   */
  rewoundGroupId?: string;

  /**
   * For a rewound group nested inside an earlier one (its cut lies inside
   * that group's span): the enclosing group's record id, on the header and
   * every member row. Collapsing the enclosing group hides the whole span.
   */
  rewoundParentGroupId?: string;

  /**
   * Allow any additional fields from JSONL.
   * This makes the type compatible with pass-through of unknown fields.
   */
  [key: string]: unknown;
}

// =============================================================================
// App Message Types
// =============================================================================

/**
 * User message with app extensions.
 */
export type AppUserMessage = UserEntry & AppMessageExtensions;

/**
 * Assistant message with app extensions.
 */
export type AppAssistantMessage = AssistantEntry & AppMessageExtensions;

/**
 * System message with app extensions.
 */
export type AppSystemMessage = SystemEntry & AppMessageExtensions;

/**
 * Summary message with app extensions.
 */
export type AppSummaryMessage = SummaryEntry & AppMessageExtensions;

/**
 * Any JSONL entry type with app extensions.
 * This is the main message type used throughout the app.
 */
export type AppMessage = (SessionEntry | SummaryEntry) & AppMessageExtensions;

/**
 * Conversation messages only (user/assistant/system).
 * Excludes file_history_snapshot and queue_operation entries.
 */
export type AppConversationMessage =
  | AppUserMessage
  | AppAssistantMessage
  | AppSystemMessage
  | AppSummaryMessage;

// =============================================================================
// Session Types
// =============================================================================

/** Type of pending input request for notification badges */
export type PendingInputType = "tool-approval" | "user-question";

/** Agent activity - what the agent is doing */
export type AgentActivity = "in-turn" | "idle" | "waiting-input" | "terminated";

export type ProviderRuntimeRetryReason =
  | "rate_limit"
  | "overloaded"
  | "server_error"
  | "network"
  | "unknown";

export type ProviderRuntimeStatus =
  | {
      kind: "retrying";
      provider: ProviderName;
      reason: ProviderRuntimeRetryReason;
      httpStatus?: number;
      startedAt: string;
      lastSeenAt: string;
      retryAt?: string;
      retryDelayMs?: number;
      attempt?: number;
      maxRetries?: number | "unbounded";
      eventCount: number;
      source: string;
      message?: string;
      details?: string;
      turnId?: string;
      requestId?: string;
    }
  | {
      kind: "terminal";
      provider: ProviderName;
      reason: ProviderRuntimeRetryReason;
      message: string;
      occurredAt: string;
      source: string;
      turnId?: string;
      requestId?: string;
      scope?: "turn" | "provider_process";
      details?: string;
    }
  | null;

/** Context usage information extracted from the last assistant message */
export interface ContextUsage {
  /** Input tokens used for context-window meter (provider-specific semantics) */
  inputTokens: number;
  /** Percentage of context window used (based on model's context limit) */
  percentage: number;
  /** Context window size used to compute percentage */
  contextWindow?: number;
  /** Output tokens generated in the last response (optional - may not be available) */
  outputTokens?: number;
  /** Cache read tokens (tokens served from cache) */
  cacheReadTokens?: number;
  /** Cache creation tokens (new tokens added to cache) */
  cacheCreationTokens?: number;
}

/**
 * Stable YA key for a context-breakdown row; "other" covers provider rows YA
 * does not recognize, which render under their provider name.
 */
export type ContextBreakdownCategoryKey =
  | "systemPrompt"
  | "systemTools"
  | "mcpTools"
  | "agents"
  | "memoryFiles"
  | "skills"
  | "messages"
  | "free"
  | "buffer"
  | "other";

/** One named contributor inside a breakdown row (a file, skill, tool…). */
export interface ContextBreakdownItem {
  label: string;
  /** Source or type annotation, e.g. "User" for a memory file. */
  detail?: string;
  tokens: number;
}

/**
 * Provider-estimated split of the conversation row. The parts are separate
 * estimates and need not sum to the row's total.
 */
export interface ContextBreakdownMessageParts {
  toolCallTokens: number;
  toolResultTokens: number;
  assistantTextTokens: number;
  userTextTokens: number;
}

export interface ContextBreakdownCategory {
  key: ContextBreakdownCategoryKey;
  /** Provider's own row name. */
  name: string;
  tokens: number;
  /**
   * `used` occupies the window, `free` is what remains, `buffer` is a
   * compaction reserve, and `deferred` rows are out-of-window tool schemas.
   */
  kind: "used" | "free" | "buffer" | "deferred";
  items?: ContextBreakdownItem[];
  messageParts?: ContextBreakdownMessageParts;
}

/**
 * What currently fills a live session's context window, by category — the
 * data behind Claude Code's `/context`. Served by
 * `GET /api/sessions/:sessionId/context-breakdown`.
 */
export interface ContextBreakdown {
  model: string;
  totalTokens: number;
  maxTokens: number;
  /** Token count at which the provider compacts automatically, when enabled. */
  autoCompactAtTokens?: number;
  categories: ContextBreakdownCategory[];
}

// =============================================================================
// Model Context Window Mapping
// =============================================================================

/** Default context window size (200K tokens) */
export const DEFAULT_CONTEXT_WINDOW = 200_000;
/** Default context window size for Codex cloud sessions when metadata is missing */
export const CODEX_DEFAULT_CONTEXT_WINDOW = 258_000;
/** GPT-5.6 Sol, Terra, and Luna context window in Codex 0.144.6+. */
export const CODEX_GPT56_CONTEXT_WINDOW = 272_000;
/** GPT-6 Astra (Codex 0.153.3+), Sol, and Luna (0.156.1+) context window. */
export const CODEX_GPT6_CONTEXT_WINDOW = 272_000;
export const CLAUDE_EXTENDED_CONTEXT_WINDOW = 1_000_000;

/**
 * Known context window sizes for different models.
 *
 * Claude models:
 * - Claude 5.x Fable / Opus / Sonnet / Haiku canonical ids: 1M
 * - Opus / Sonnet / Haiku standard aliases: 200K
 * - Explicit "[1m]" Claude variants: 1M
 * - Sonnet 3.5: 200K
 *
 * Gemini models:
 * - Gemini 2.0/1.5: 1M
 *
 * GPT models:
 * - GPT-4: 128K (varies by variant)
 * - GPT-4o: 128K
 * - GPT-5.6 Sol/Terra/Luna: 272K
 * - GPT-6 Astra/Sol/Luna: 272K
 * - Earlier GPT-5 / Codex 5.x: ~258K
 */
const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  // Claude models - 1M context
  fable: CLAUDE_EXTENDED_CONTEXT_WINDOW,
  // Claude models - 200K context
  opus: 200_000,
  sonnet: 200_000,
  haiku: 200_000,
  // Gemini models - 1M context
  gemini: 1_000_000,
  // GPT-5 / Codex models - ~258K context
  "gpt-5": CODEX_DEFAULT_CONTEXT_WINDOW,
  codex: CODEX_DEFAULT_CONTEXT_WINDOW,
  // GPT-4 models - 128K context
  "gpt-4": 128_000,
  "gpt-4o": 128_000,
  "gpt-4-turbo": 128_000,
};

/**
 * Get the context window size for a given model.
 *
 * Parses model IDs like:
 * - "claude-opus-4-5-20251101" → opus → 200K
 * - "claude-opus-4-8[1m]" → opus → 1M
 * - "claude-opus-5" → opus → 1M
 * - "claude-opus-5-5" → opus → 1M
 * - "claude-fable-5" → fable → 1M
 * - "claude-sonnet-5" → sonnet → 1M
 * - "claude-haiku-5-5" → haiku → 1M
 * - "claude-haiku-4-5-20251001" → haiku → 200K
 * - "claude-sonnet-4-20250514" → sonnet → 200K
 * - "sonnet[1m]" → sonnet → 1M
 * - "claude-3-5-sonnet-20241022" → sonnet → 200K
 * - "gemini-2.0-flash-exp" → gemini → 1M
 * - "gpt-4o-2024-08-06" → gpt-4o → 128K
 *
 * @param model - Model ID string (e.g., "claude-opus-4-5-20251101")
 * @param provider - Provider name for fallback defaults when model is missing
 * @returns Context window size in tokens
 */
export function getModelContextWindow(
  model: string | undefined,
  provider?: ProviderName,
): number {
  if (!model) {
    return provider === "codex"
      ? CODEX_DEFAULT_CONTEXT_WINDOW
      : DEFAULT_CONTEXT_WINDOW;
  }

  const lowerModel = model.toLowerCase();

  if (lowerModel.includes("[1m]")) {
    return CLAUDE_EXTENDED_CONTEXT_WINDOW;
  }

  if (/(?:^|[./])claude-(?:opus|sonnet|haiku)-5(?:-\d+)?$/.test(lowerModel)) {
    return CLAUDE_EXTENDED_CONTEXT_WINDOW;
  }

  if (lowerModel.includes("gpt-5.6")) {
    return CODEX_GPT56_CONTEXT_WINDOW;
  }

  if (lowerModel.includes("gpt-6-")) {
    return CODEX_GPT6_CONTEXT_WINDOW;
  }

  // Handle model IDs that may include provider namespace or other prefixes.
  if (lowerModel.includes("gpt-5") || lowerModel.includes("codex")) {
    return CODEX_DEFAULT_CONTEXT_WINDOW;
  }

  // Check for exact prefix matches first (for GPT models)
  for (const [prefix, size] of Object.entries(MODEL_CONTEXT_WINDOWS)) {
    if (lowerModel.startsWith(prefix)) {
      return size;
    }
  }

  // Parse Claude model IDs: claude-{family}-{version} or claude-{version}-{family}
  // Examples: claude-opus-4-5-*, claude-sonnet-4-*, claude-3-5-sonnet-*
  const claudeMatch = lowerModel.match(/claude-(?:(\w+)-\d|(\d+-\d+-)?(\w+))/);
  if (claudeMatch) {
    const family = claudeMatch[1] || claudeMatch[3];
    if (family && MODEL_CONTEXT_WINDOWS[family]) {
      return MODEL_CONTEXT_WINDOWS[family];
    }
  }

  // Check for Gemini models
  if (lowerModel.includes("gemini")) {
    return MODEL_CONTEXT_WINDOWS.gemini ?? DEFAULT_CONTEXT_WINDOW;
  }

  // Provider-level fallback when we don't recognize the model string.
  if (provider === "codex") {
    return CODEX_DEFAULT_CONTEXT_WINDOW;
  }

  return DEFAULT_CONTEXT_WINDOW;
}

/**
 * Session ownership - who controls the session.
 */
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
      /** Recap strategy of the live process; lets the client suppress the
       * away-recap POST when recaps are off for the session. */
      recapMode?: RecapMode;
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

/**
 * Recent session entry with enriched data from the server.
 * Session data is looked up server-side to avoid N+1 client requests.
 */
export interface EnrichedRecentEntry {
  sessionId: string;
  projectId: string;
  visitedAt: string;
  // Enriched fields from session/project data
  title: string | null;
  projectName: string;
  provider: ProviderName;
}

export interface ForkSummaryTranscriptDisplayObject {
  id: string;
  kind: "fork-summary";
  createdAt: string;
  /** Message after which the display object is placed in the source transcript. */
  placementAfterMessageId: string;
  /** User request selected for Fork after. */
  sourceMessageId: string;
  /** Completed-turn boundary retained by the target fork. */
  retainedThroughMessageId: string;
  status: "generating" | "ready" | "error";
  autoOpenWhenReady?: boolean;
  targetSessionId?: string;
  title?: string;
  openedAt?: string;
  clickedAt?: string;
  error?: string;
}

export interface BangCommandTranscriptDisplayObject {
  id: string;
  kind: "bang-command";
  createdAt: string;
  /** Message after which the object is placed; "" places before the first item. */
  placementAfterMessageId: string;
  /** Shell command line as typed after the !! prefix. */
  command: string;
  /** Absolute project directory the command ran in. */
  cwd: string;
  status: "running" | "done" | "error" | "killed";
  exitCode?: number;
  durationMs?: number;
  /** Bounded tail of captured output; full output is fetched on demand. */
  stdoutPreview?: string;
  stderrPreview?: string;
  stdoutBytes?: number;
  stderrBytes?: number;
  /** True when the stored full output was capped, not merely the preview. */
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
  /** Spawn/timeout/kill reason when status is error or killed. */
  error?: string;
}

export type TranscriptDisplayObject =
  | ForkSummaryTranscriptDisplayObject
  | BangCommandTranscriptDisplayObject;

export interface DurableLocalCommandMessage extends AppMessageExtensions {
  type: "system";
  subtype: "local_command";
  content: string;
  details?: string[];
  /**
   * The details explain why the notice exists (an error), so the transcript
   * shows them without a click. Absent means collapsed.
   */
  detailsOpen?: boolean;
  timestamp: string;
  uuid: string;
  id: string;
  session_id: string;
  isSynthetic: true;
  placementAfterMessageId?: string;
}

export interface DurableRecapMessage extends AppMessageExtensions {
  type: "system";
  subtype: "away_summary";
  content: string;
  timestamp: string;
  uuid: string;
  session_id?: string;
  isMeta?: boolean;
  isSynthetic?: boolean;
  yaRecapSource: "provider-native" | "ya-synthetic";
}

export type SyntheticSessionBoundaryCommand =
  | "/done"
  | "/archive"
  | "/terminate";

/** YA-only user row that records an explicit local session-boundary action. */
export interface DurableSyntheticDoneMessage extends AppMessageExtensions {
  type: "user";
  content: SyntheticSessionBoundaryCommand;
  message: {
    role: "user";
    content: SyntheticSessionBoundaryCommand;
  };
  timestamp: string;
  uuid: string;
  id: string;
  isSynthetic: true;
  yaSyntheticSource: "done";
}

/**
 * What first created a YA-owned session: a YA UI, or (`api`) an HTTP
 * request that identified no UI, such as an agent or script.
 */
export interface SessionCreationProvenance {
  surface: "web" | "desktop" | "api";
  /** Browser page origin, which may be a hosted UI rather than the server. */
  clientOrigin?: string;
  /** Version of the frontend bundle that submitted the create request. */
  clientVersion?: string;
  /** Desktop application's source commit, when its runtime reports one. */
  clientCommit?: string;
}

/** Session summary for list views, without full message content. */
export interface AppSessionSummary {
  /** null clears a known receipt; omission preserves unknown older-server state. */
  nonHumanUserTurn?: NonHumanUserTurn | null;
  /** Bounded recent question previews; absence means this projection is unknown. */
  asyncQuestions?: {
    questions: {
      messageId: string;
      index: number;
      title: string;
      age: number;
    }[];
    omitted: boolean;
  };
  id: string;
  projectId: UrlProjectId;
  /** Human-readable project basename for display; projectId remains canonical. */
  projectName?: string;
  title: string | null;
  fullTitle: string | null;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  ownership: SessionOwnership;
  // Provider field - which AI provider is running this session
  provider: ProviderName;
  // Model used for this session (resolved, not "default")
  model?: string;
  // Notification fields
  pendingInputType?: PendingInputType;
  activity?: AgentActivity;
  lastSeenAt?: string;
  hasUnread?: boolean;
  // Metadata fields
  customTitle?: string;
  isArchived?: boolean;
  isStarred?: boolean;
  /** Interactive Mother session for a YA-owned `/btw` aside. */
  parentSessionId?: string;
  /** Explicit meaning of parentSessionId; absent on legacy records. */
  parentSessionKind?: "btw-aside";
  /** Source session whose provider transcript was cloned or forked. */
  forkedFromSessionId?: string;
  /** Client-declared creation provenance; absent for older or external sessions. */
  creationProvenance?: SessionCreationProvenance;
  /** Durable YA startup evidence; absent on legacy/external sessions. */
  creation?: SessionCreationStatus;
  /** Public, immutable account pin. Never contains transport credentials. */
  routerBinding?: {
    poolId?: string;
    /** Labels captured from AAR; identity stays the ids. Absent on older pins. */
    poolName?: string;
    accountDisplayName?: string;
    policy?: string;
    /** The router's display name for `policy`, captured at launch. */
    policyLabel?: string;
    reason?: string;
    observedAt?: string;
    id: string;
    routerId: string;
    accountId: string;
    provider: "claude" | "codex";
  };
  /** Iterations a running `/clearloop` still has to do; absent when none runs. */
  clearloop?: SessionClearloopBadge;
  /**
   * Ids of the same-session rewinds the transcript projection applied, in
   * order. A cached transcript whose ids differ predates a rewind and must be
   * reloaded rather than caught up incrementally. See topics/session-rewind.md.
   */
  rewindRecordIds?: string[];
  /** Saved viewer-only objects placed in the transcript, never provider context. */
  transcriptDisplayObjects?: TranscriptDisplayObject[];
  /** Initial prompt text accepted by YA for new-session recovery/copy. */
  initialPrompt?: string;
  /** Capped excerpt of the most recent visible agent turn or provider recap. */
  lastAgentText?: string;
  /**
   * When someone last wrote into this session, which agent work never
   * advances. Sidebar chronology is stated in the reader's own turns, so it
   * needs a time every client agrees on rather than one each browser keeps for
   * itself. A message another session delivered counts as written.
   */
  lastHumanTurnAt?: string;
  contextUsage?: ContextUsage;
  /** SSH host alias for remote execution (undefined = local) */
  executor?: string;
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
  /** YA's effective project/working directory for this session. */
  workingProjectId?: UrlProjectId;
  /** Provider transcript project when it differs from the effective project. */
  transcriptProjectId?: UrlProjectId;
  /** Provider-launched child work nested under this parent. Absent on older servers. */
  providerChildren?: ProviderChildSessionSummary[];
}

/**
 * Full session with messages.
 */
export interface AppSession extends AppSessionSummary {
  messages: AppMessage[];
}

/** Last successfully applied model settings retained for later session turns. */
export interface SessionEffectiveModelSettings {
  /** Exact YA model token, including "default"; null means provider default. */
  requestedModel: string | null;
  /** Effective thinking configuration; null means disabled/default behavior. */
  thinking: ThinkingConfig | null;
  /** Effective effort selection; null means provider/default behavior. */
  effort: EffortLevel | null;
}

/** Complete, last-applied settings that survive provider process replacement. */
export interface EffectiveSessionLaunchSettings
  extends SessionEffectiveModelSettings {
  schemaVersion: 1;
  /** Monotonic session-local revision. */
  revision: number;
  permissionMode: PermissionMode;
  /** Null intentionally selects the provider default. */
  serviceTier: string | null;
}

export interface SessionMetadataPayload
  extends Omit<AppSessionSummary, "ownership"> {
  /** Durable model settings used when no live process snapshot is available. */
  effectiveModelSettings?: SessionEffectiveModelSettings;
  /** Optional on older servers and sessions without a durable launch snapshot. */
  effectiveLaunchSettings?: EffectiveSessionLaunchSettings;
  /** Per-session wake-turn override; absent inherits the server default. */
  wakeTurnsEnabled?: boolean;
  /** Per-session prompt-suggestion preference (off | native) */
  promptSuggestionMode?: PromptSuggestionMode;
  /** Browser-away duration before YA asks the live process for a recap. */
  recapAfterSeconds?: number;
  /** YA's effective project/working directory for this session. */
  workingProjectId?: UrlProjectId;
  /** Provider transcript project when it differs from the effective project. */
  transcriptProjectId?: UrlProjectId;
}

export type SessionQueuedYaCommand = "done" | "clearloop";

/** Progress of a running `/clearloop`, carried on its queued-entry chip. */
export interface SessionQueuedClearloopProgress {
  completed: number;
  total: number;
  state: "running" | "completed" | "cancelled" | "interrupted";
  /**
   * ISO time the session was last active, published once the server has
   * observed inactivity; the next rewind is due `windowSeconds` after it.
   * Absent while the provider is still working.
   */
  quietSince?: string;
  windowSeconds?: number;
  /** The loop also waits for the project idle predicate at each boundary. */
  patient?: boolean;
  /**
   * Raw project blocker strings from the last patient check, in the same form
   * Project Queue publishes. Empty or absent means nothing held the loop.
   */
  projectBlockers?: string[];
}

export type SessionQueuedMessageKind = "deferred" | "patient" | "ya-command";

export type SessionQueuedMessageStatus = "queued" | "paused-after-restart";

/**
 * `compacting`: YA started compaction and holds the item until it completes.
 * `failed`: compaction did not complete; the item stays queued until the user
 * sends it without compacting, steers it, or cancels it.
 */
export interface SessionQueuedCompactionGate {
  state: "compacting" | "failed";
  reason?: string;
}

/**
 * Server-owned queued-message summary for the session UI.
 *
 * Live entries use `tempId` for the existing in-process cancel route. Recovered
 * restart-paused entries additionally use durable `id` for delete/resume APIs.
 */
export interface SessionQueuedMessageSummary {
  id?: string;
  tempId?: string;
  content: string;
  timestamp: string;
  attachments?: UploadedFile[];
  attachmentCount?: number;
  metadata?: UserMessageMetadata;
  kind?: SessionQueuedMessageKind;
  /** YA-local command projected through queue UI without provider delivery. */
  yaCommand?: SessionQueuedYaCommand;
  /** Present on the `clearloop` YA-command entry. */
  clearloop?: SessionQueuedClearloopProgress;
  status?: SessionQueuedMessageStatus;
  /**
   * Compact-first progress of a patient item that reached delivery above its
   * threshold. Absent while it waits or after compaction cleared it.
   */
  compactionGate?: SessionQueuedCompactionGate;
  sessionId?: string;
  projectId?: UrlProjectId;
  queuedAt?: string;
  createdAt?: string;
  updatedAt?: string;
}

/**
 * Lightweight session metadata response used for title/status refreshes.
 */
export interface SessionMetadataResponse {
  session: SessionMetadataPayload;
  ownership: SessionOwnership;
  processState: AgentActivity | null;
  providerRuntimeStatus?: ProviderRuntimeStatus;
  pendingInputRequest?: InputRequest | null;
  slashCommands?: SlashCommand[] | null;
  deferredMessages?: SessionQueuedMessageSummary[];
}

// =============================================================================
// Agent Session Types (for Task subagents)
// =============================================================================

/** Status of an agent session, inferred from its messages */
export type AgentStatus = "pending" | "running" | "completed" | "failed";

/**
 * Agent session content returned by getAgentSession API.
 * Used for lazy-loading completed Task subagent content.
 */
export interface AgentSession {
  messages: AppMessage[];
  status: AgentStatus;
  agentType?: string;
  description?: string;
  spawnDepth?: number;
}

/**
 * Provider-launched child work attached to a canonical YA parent session.
 * `id` is provider-native and must not be used as a YA session URL ID.
 */
export interface ProviderChildSessionSummary {
  id: string;
  parentSessionId: string;
  /** Provider-supplied task description or child name. */
  title?: string;
  /** Provider role/type, such as general-purpose, Explore, or reviewer. */
  agentType?: string;
  /** Parent transcript tool call that launched this child, when available. */
  toolUseId?: string;
  /** Provider-reported nesting depth, when available. */
  spawnDepth?: number;
  updatedAt: string;
}

// =============================================================================
// Input Request Types
// =============================================================================

/**
 * Input request for tool approval or user questions.
 */
export type UserQuestionAnswer = string | string[];
export type UserQuestionAnswers = Record<string, UserQuestionAnswer>;

export interface InputRequest {
  id: string;
  sessionId: string;
  type: "tool-approval" | "question" | "choice";
  prompt: string;
  options?: string[];
  toolName?: string;
  toolInput?: unknown;
  timestamp: string;
}

// =============================================================================
// Type Guards
// =============================================================================

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isOptionalString(
  record: Record<string, unknown>,
  key: string,
): boolean {
  return record[key] === undefined || typeof record[key] === "string";
}

function isOptionalBoolean(
  record: Record<string, unknown>,
  key: string,
): boolean {
  return record[key] === undefined || typeof record[key] === "boolean";
}

function isAppContent(value: unknown): boolean {
  return (
    typeof value === "string" ||
    (Array.isArray(value) &&
      value.every(
        (entry) => typeof entry === "string" || isAppContentBlock(entry),
      ))
  );
}

function isAppContentBlock(value: unknown): value is AppContentBlock {
  if (!isUnknownRecord(value) || typeof value.type !== "string") return false;
  switch (value.type) {
    case "text":
    case "input_text":
    case "output_text":
      return typeof value.text === "string";
    case "thinking":
      return typeof value.thinking === "string";
    case "tool_use":
      return (
        typeof value.id === "string" &&
        typeof value.name === "string" &&
        Object.hasOwn(value, "input")
      );
    case "tool_result":
      return (
        typeof value.tool_use_id === "string" &&
        isAppContent(value.content) &&
        isOptionalBoolean(value, "is_error")
      );
    case "image": {
      if (!isUnknownRecord(value.source)) return false;
      return (
        value.source.type === "base64" &&
        typeof value.source.data === "string" &&
        (value.source.media_type === "image/png" ||
          value.source.media_type === "image/jpeg" ||
          value.source.media_type === "image/gif" ||
          value.source.media_type === "image/webp")
      );
    }
    case "document": {
      if (!isUnknownRecord(value.source)) return false;
      return (
        typeof value.source.data === "string" &&
        ((value.source.type === "text" &&
          value.source.media_type === "text/plain") ||
          (value.source.type === "base64" &&
            value.source.media_type === "application/pdf"))
      );
    }
    case "input_image":
      return (
        isOptionalString(value, "image_url") &&
        isOptionalString(value, "file_path") &&
        isOptionalString(value, "mime_type")
      );
    case "tool_reference":
      return typeof value.tool_name === "string";
    case "fallback":
      return (
        isUnknownRecord(value.from) &&
        typeof value.from.model === "string" &&
        isUnknownRecord(value.to) &&
        typeof value.to.model === "string"
      );
    default:
      return true;
  }
}

function hasStringFields(
  value: Record<string, unknown>,
  ...fields: string[]
): boolean {
  return fields.every((field) => typeof value[field] === "string");
}

function isAppSystemEntry(value: Record<string, unknown>): boolean {
  if (value.subtype === undefined) {
    return (
      typeof value.content === "string" &&
      typeof value.toolUseID === "string" &&
      value.level === "info"
    );
  }
  if (typeof value.subtype !== "string" || value.subtype.length === 0) {
    return false;
  }

  switch (value.subtype) {
    case "compact_boundary":
    case "microcompact_boundary":
    case "informational":
    case "model_refusal_fallback":
    case "bridge_status":
    case "away_summary":
    case "scheduled_task_fire":
    case "local_command":
    case "turn_aborted":
    case "content_filter_block":
    case "subagent_activity":
    case "config_ack":
      return typeof value.content === "string";
    case "init":
      return typeof value.session_id === "string";
    case "status":
      return value.status === null || value.status === "compacting";
    case "session_state_changed":
      return (
        typeof value.session_id === "string" &&
        (value.state === "idle" ||
          value.state === "running" ||
          value.state === "requires_action")
      );
    case "api_error":
      return typeof value.level === "string";
    case "stop_hook_summary":
      return (
        typeof value.hookCount === "number" &&
        Array.isArray(value.hookInfos) &&
        Array.isArray(value.hookErrors) &&
        typeof value.preventedContinuation === "boolean" &&
        typeof value.stopReason === "string" &&
        typeof value.hasOutput === "boolean"
      );
    case "turn_duration":
      return (
        typeof value.durationMs === "number" &&
        Number.isFinite(value.durationMs) &&
        typeof value.messageCount === "number" &&
        Number.isFinite(value.messageCount)
      );
    case "input_request":
      return isUnknownRecord(value.input_request);
    case "todo_list":
      return Array.isArray(value.items);
    case "turn_complete":
      return (
        typeof value.session_id === "string" &&
        (value.usage === undefined || isUnknownRecord(value.usage))
      );
    case "token_usage":
      return (
        typeof value.session_id === "string" && isUnknownRecord(value.usage)
      );
    case "codex_tool_orphans":
      return Array.isArray(value.orphanedToolUseIds);
    case "commands_changed":
      return (
        typeof value.session_id === "string" &&
        (Array.isArray(value.slash_commands) ||
          Array.isArray(value.slash_command_inventory))
      );
    default:
      return false;
  }
}

function isFileHistorySnapshotEntry(value: Record<string, unknown>): boolean {
  if (!isUnknownRecord(value.snapshot)) return false;
  return (
    typeof value.messageId === "string" &&
    typeof value.snapshot.messageId === "string" &&
    isUnknownRecord(value.snapshot.trackedFileBackups) &&
    typeof value.snapshot.timestamp === "string" &&
    typeof value.isSnapshotUpdate === "boolean"
  );
}

function isQueueOperationEntry(value: Record<string, unknown>): boolean {
  if (
    typeof value.sessionId !== "string" ||
    typeof value.timestamp !== "string"
  ) {
    return false;
  }
  if (
    value.operation !== "enqueue" &&
    value.operation !== "dequeue" &&
    value.operation !== "remove" &&
    value.operation !== "popAll"
  ) {
    return false;
  }
  return value.content === undefined || isAppContent(value.content);
}

function isMetadataEntry(value: Record<string, unknown>): boolean {
  switch (value.type) {
    case "custom-title":
      return hasStringFields(value, "sessionId", "customTitle");
    case "ai-title":
      return hasStringFields(value, "sessionId", "aiTitle");
    case "last-prompt":
      return (
        typeof value.sessionId === "string" &&
        (typeof value.lastPrompt === "string" ||
          typeof value.leafUuid === "string")
      );
    case "permission-mode":
      return hasStringFields(value, "sessionId", "permissionMode");
    case "task-summary":
      return hasStringFields(value, "sessionId", "summary", "timestamp");
    case "tag":
      return hasStringFields(value, "sessionId", "tag");
    case "agent-name":
      return hasStringFields(value, "sessionId", "agentName");
    case "agent-color":
      return hasStringFields(value, "sessionId", "agentColor");
    case "agent-setting":
      return hasStringFields(value, "sessionId", "agentSetting");
    case "pr-link":
      return (
        hasStringFields(
          value,
          "sessionId",
          "prUrl",
          "prRepository",
          "timestamp",
        ) && typeof value.prNumber === "number"
      );
    case "mode":
      return (
        typeof value.sessionId === "string" &&
        (value.mode === "coordinator" || value.mode === "normal")
      );
    case "worktree-state":
      return (
        typeof value.sessionId === "string" &&
        (value.worktreeSession === null ||
          isUnknownRecord(value.worktreeSession))
      );
    case "content-replacement":
      return (
        typeof value.sessionId === "string" && Array.isArray(value.replacements)
      );
    case "attribution-snapshot":
      return (
        hasStringFields(value, "messageId", "surface") &&
        isUnknownRecord(value.fileStates)
      );
    case "speculation-accept":
      return (
        typeof value.timestamp === "string" &&
        typeof value.timeSavedMs === "number" &&
        Number.isFinite(value.timeSavedMs)
      );
    case "marble-origami-commit":
      return hasStringFields(
        value,
        "sessionId",
        "collapseId",
        "summaryUuid",
        "summaryContent",
        "summary",
        "firstArchivedUuid",
        "lastArchivedUuid",
      );
    case "marble-origami-snapshot":
      return (
        typeof value.sessionId === "string" &&
        Array.isArray(value.staged) &&
        typeof value.armed === "boolean" &&
        typeof value.lastSpawnTokens === "number"
      );
    case "atis-latch":
      return hasStringFields(value, "sessionId", "atis");
    case "cost-state":
      return (
        typeof value.sessionId === "string" &&
        typeof value.totalCostUSD === "number" &&
        typeof value.totalAPIDuration === "number" &&
        typeof value.totalAPIDurationWithoutRetries === "number" &&
        typeof value.totalToolDuration === "number" &&
        typeof value.totalLinesAdded === "number" &&
        typeof value.totalLinesRemoved === "number" &&
        typeof value.totalDuration === "number" &&
        typeof value.startTime === "number" &&
        isUnknownRecord(value.modelUsage) &&
        typeof value.hasUnknownModelCost === "boolean"
      );
    default:
      return false;
  }
}

export function isAppMessage(value: unknown): value is AppMessage {
  if (!isUnknownRecord(value) || typeof value.type !== "string") return false;

  switch (value.type) {
    case "user":
    case "assistant":
      return (
        (value.content === undefined || isAppContent(value.content)) &&
        isUnknownRecord(value.message) &&
        value.message.role === value.type &&
        isAppContent(value.message.content)
      );
    case "system":
      return isAppSystemEntry(value);
    case "summary":
      return hasStringFields(value, "summary", "leafUuid");
    case "attachment":
      return Object.hasOwn(value, "attachment");
    case "progress":
      return (
        isUnknownRecord(value.data) &&
        hasStringFields(value, "toolUseID", "parentToolUseID")
      );
    case "file-history-snapshot":
      return isFileHistorySnapshotEntry(value);
    case "queue-operation":
      return isQueueOperationEntry(value);
    default:
      return isMetadataEntry(value);
  }
}

function isSessionOwnership(value: unknown): value is SessionOwnership {
  if (!isUnknownRecord(value)) return false;
  if (value.owner === "none" || value.owner === "external") return true;
  return (
    value.owner === "self" &&
    typeof value.processId === "string" &&
    isOptionalString(value, "permissionMode") &&
    isOptionalString(value, "appliedPermissionMode") &&
    (value.modeVersion === undefined ||
      (typeof value.modeVersion === "number" &&
        Number.isSafeInteger(value.modeVersion))) &&
    (value.recapAfterSeconds === undefined ||
      (typeof value.recapAfterSeconds === "number" &&
        Number.isFinite(value.recapAfterSeconds))) &&
    isOptionalString(value, "recapMode")
  );
}

/** Runtime validation for normalized cross-provider session responses. */
export function isAppSession(value: unknown): value is AppSession {
  if (!isUnknownRecord(value)) return false;
  if (
    typeof value.id !== "string" ||
    typeof value.projectId !== "string" ||
    !isUrlProjectId(value.projectId) ||
    (value.title !== null && typeof value.title !== "string") ||
    (value.fullTitle !== null && typeof value.fullTitle !== "string") ||
    typeof value.createdAt !== "string" ||
    typeof value.updatedAt !== "string" ||
    typeof value.messageCount !== "number" ||
    !Number.isSafeInteger(value.messageCount) ||
    value.messageCount < 0 ||
    !isSessionOwnership(value.ownership) ||
    typeof value.provider !== "string" ||
    !Array.isArray(value.messages) ||
    !value.messages.every(isAppMessage)
  ) {
    return false;
  }

  for (const key of [
    "projectName",
    "model",
    "lastSeenAt",
    "customTitle",
    "parentSessionId",
    "parentSessionKind",
    "forkedFromSessionId",
    "initialPrompt",
    "lastAgentText",
    "lastHumanTurnAt",
    "executor",
    "originator",
    "cliVersion",
    "source",
    "approvalPolicy",
  ]) {
    if (!isOptionalString(value, key)) return false;
  }
  for (const key of ["hasUnread", "isArchived", "isStarred"]) {
    if (!isOptionalBoolean(value, key)) return false;
  }
  if (
    (value.pendingInputType !== undefined &&
      value.pendingInputType !== "tool-approval" &&
      value.pendingInputType !== "user-question") ||
    (value.activity !== undefined &&
      value.activity !== "in-turn" &&
      value.activity !== "idle" &&
      value.activity !== "waiting-input" &&
      value.activity !== "terminated") ||
    (value.workingProjectId !== undefined &&
      (typeof value.workingProjectId !== "string" ||
        !isUrlProjectId(value.workingProjectId))) ||
    (value.transcriptProjectId !== undefined &&
      (typeof value.transcriptProjectId !== "string" ||
        !isUrlProjectId(value.transcriptProjectId))) ||
    (value.transcriptDisplayObjects !== undefined &&
      (!Array.isArray(value.transcriptDisplayObjects) ||
        !value.transcriptDisplayObjects.every(
          (entry) =>
            isUnknownRecord(entry) &&
            typeof entry.id === "string" &&
            typeof entry.kind === "string",
        )))
  ) {
    return false;
  }
  if (value.contextUsage !== undefined) {
    if (
      !isUnknownRecord(value.contextUsage) ||
      typeof value.contextUsage.inputTokens !== "number" ||
      !Number.isFinite(value.contextUsage.inputTokens) ||
      typeof value.contextUsage.percentage !== "number" ||
      !Number.isFinite(value.contextUsage.percentage)
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Check if a message is a user entry.
 */
export function isUserMessage(msg: AppMessage): msg is AppUserMessage {
  return msg.type === "user";
}

/**
 * Check if a message is an assistant entry.
 */
export function isAssistantMessage(
  msg: AppMessage,
): msg is AppAssistantMessage {
  return msg.type === "assistant";
}

/**
 * Check if a message is a system entry.
 */
export function isSystemMessage(msg: AppMessage): msg is AppSystemMessage {
  return msg.type === "system";
}

/**
 * Check if a message is a summary entry.
 */
export function isSummaryMessage(msg: AppMessage): msg is AppSummaryMessage {
  return msg.type === "summary";
}

/**
 * Check if a message is a conversation message (user/assistant/system/summary).
 */
export function isConversationMessage(
  msg: AppMessage,
): msg is AppConversationMessage {
  return (
    msg.type === "user" ||
    msg.type === "assistant" ||
    msg.type === "system" ||
    msg.type === "summary"
  );
}

// =============================================================================
// Connected Browser Types
// =============================================================================

/**
 * Information about a connected browser profile.
 */
export interface ConnectionInfo {
  /** Unique identifier for the browser profile */
  browserProfileId: string;
  /** Number of active tabs/connections from this browser profile */
  connectionCount: number;
  /** ISO timestamp of the first connection from this browser profile */
  connectedAt: string;
  /** Optional friendly name for the device (from push subscription) */
  deviceName?: string;
}

/**
 * Response from GET /api/connections endpoint.
 */
export interface ConnectionsResponse {
  connections: ConnectionInfo[];
}

// =============================================================================
// Browser Profile Origin Tracking
// =============================================================================

/**
 * Origin information for a browser profile connection.
 * Tracks where a browser profile has connected from.
 */
export interface BrowserProfileOrigin {
  /** Full origin string (e.g., "https://localhost:3400") */
  origin: string;
  /** URL scheme (e.g., "https", "http") */
  scheme: string;
  /** Hostname without port (e.g., "localhost", "phone.tailnet") */
  hostname: string;
  /** Port number, or null if default port */
  port: number | null;
  /** User agent string for browser identification */
  userAgent: string;
  /** ISO timestamp of first connection from this origin */
  firstSeen: string;
  /** ISO timestamp of most recent connection from this origin */
  lastSeen: string;
}

/**
 * Browser profile information with origin tracking.
 * Persisted server-side to track device connections.
 */
export interface BrowserProfileInfo {
  /** Unique browser profile identifier */
  browserProfileId: string;
  /** All origins this profile has connected from */
  origins: BrowserProfileOrigin[];
  /** ISO timestamp when this profile was first seen */
  createdAt: string;
  /** ISO timestamp of most recent activity */
  lastActiveAt: string;
  /** Optional friendly name (from push subscription) */
  deviceName?: string;
}

/**
 * Response from GET /api/browser-profiles endpoint.
 */
export interface BrowserProfilesResponse {
  profiles: BrowserProfileInfo[];
}
