import type { DesktopControlOrigin } from "../desktop/machine-control.js";
// Core types for Claude SDK abstraction

// Re-export PermissionMode from shared
export type { PermissionMode } from "@yep-anywhere/shared";
import type {
  ClaudeSteerBackgroundBashSettings,
  CodexAsyncUserInputQuestion,
  PermissionMode,
  ProviderWorkItem,
  SlashCommand,
  SessionLivenessProbeStatus,
  ToolDisplayAction,
  ToolResultMedia,
  UploadedFile,
  UserMessageMetadata,
} from "@yep-anywhere/shared";
import type { SessionSandboxRuntime } from "../session-sandbox.js";
import type { ClaudeGoalSnapshot } from "./providers/claude-goal.js";
import type {
  ProviderSessionOptions,
  ProviderSessionOptionsUpdateResult,
} from "./providers/types.js";

export interface ContentBlock {
  type: "text" | "tool_use" | "tool_result" | "image" | "thinking";
  text?: string;
  /** For thinking blocks */
  thinking?: string;
  id?: string;
  name?: string;
  input?: unknown;
  /** YA-derived presentation semantics; recomputed rather than persisted. */
  _displayActions?: ToolDisplayAction[];
  /** For tool_result blocks - references the tool_use id */
  tool_use_id?: string;
  /** For tool_result blocks - the result content */
  content?: string;
  /** For tool_result blocks - true when the tool failed */
  is_error?: boolean;
}

/**
 * SDK Message - loosely typed to preserve all fields from the SDK.
 *
 * We intentionally use a loose type here to:
 * 1. Pass through all SDK fields without stripping
 * 2. Allow frontend to inspect any field for debugging
 * 3. Avoid breaking when SDK adds new fields
 *
 * Known fields are documented but not enforced.
 */
export interface SDKMessage {
  type: string;
  uuid?: string;
  subtype?: string;
  session_id?: string;
  timestamp?: string;
  message?: {
    content: string | ContentBlock[];
    role?: string;
    /** Resolved model name from API response (e.g., "claude-sonnet-4-5-20250929") */
    model?: string;
  };
  // DAG structure
  parentUuid?: string | null;
  parent_tool_use_id?: string;
  // Message origin flags
  isSynthetic?: boolean;
  isReplay?: boolean;
  userType?: string;
  // Tool use related
  tool_use_id?: string;
  tool_name?: string;
  tool_input?: unknown;
  toolUseResult?: unknown;
  toolResultMedia?: ToolResultMedia[];
  // Input requests (tool approval, questions, etc.)
  input_request?: {
    id: string;
    type: "tool-approval" | "question" | "choice";
    prompt: string;
    options?: string[];
    toolName?: string;
    toolInput?: unknown;
  };
  /** Codex agent message delivered while its originating turn kept running. */
  codexAgentMessageDelivery?: "async";
  /** Structured questions attached to an asynchronous Codex agent message. */
  codexAsyncQuestions?: CodexAsyncUserInputQuestion[];
  // Result metadata
  duration_ms?: number;
  duration_api_ms?: number;
  total_cost_usd?: number;
  usage?: unknown;
  modelUsage?: unknown;
  num_turns?: number;
  // Error info
  error?: unknown;
  // Allow any additional fields from SDK
  [key: string]: unknown;
}

export type TimestampedSDKMessage<T extends SDKMessage = SDKMessage> = T & {
  timestamp: string;
};

export interface UserMessage {
  text: string;
  /** YA-internal automatic-turn source; never treated as fresh user intent. */
  automaticSource?: "project-queue" | "wake" | "instruction-restoration";
  /** YA-internal guard so deferred/recovered delivery is not re-accepted. */
  recapResumeHandled?: true;
  images?: string[]; // base64 or file paths
  documents?: string[];
  /** File attachments with paths for agent to access via Read tool */
  attachments?: UploadedFile[];
  mode?: PermissionMode;
  /** UUID to use for this message. If not provided, SDK will generate one. */
  uuid?: string;
  /** Client-generated temp ID for optimistic UI tracking. Echoed back in SSE. */
  tempId?: string;
  /**
   * Temp IDs of every chunk merged into this message (set by concatUserMessages
   * when a queued batch is bundled into one turn). Echoed back so the client can
   * clear all delivered queued chips by identity, not by re-matching turn text.
   */
  tempIds?: string[];
  /** YA-internal submission timing and delivery-intent metadata. */
  metadata?: UserMessageMetadata;
  /**
   * Claude CLI command-queue lane for this message ("now" aborts in-flight
   * sampling; "next" delivers after the current tool batch; "later" waits
   * for end of turn). Forwarded on the SDKUserMessage; other providers
   * ignore it. See topics/steer-queue-provider-differences.md.
   */
  priority?: "now" | "next" | "later";
}

export interface SDKSessionOptions {
  cwd: string;
  resume?: string; // session ID to resume
}

// Legacy interface for mock SDK compatibility
export interface ClaudeSDK {
  startSession(options: SDKSessionOptions): AsyncIterableIterator<SDKMessage>;
}

// New interface for real SDK with full features
import type { AgentMessageQueue } from "./messageQueue.js";

export interface ToolApprovalResult {
  behavior: "allow" | "deny";
  updatedInput?: unknown;
  message?: string;
  /**
   * If true, interrupt execution and do not continue.
   * Set to true when user denies without guidance (just clicks "No").
   * Leave false/unset when user provides feedback for Claude to incorporate.
   */
  interrupt?: boolean;
}

export type CanUseTool = (
  toolName: string,
  input: unknown,
  options: {
    signal: AbortSignal;
    /**
     * Provider-frozen mode for the turn that issued this request.
     * Falls back to the Process's current mode when omitted.
     */
    permissionMode?: PermissionMode;
  },
) => Promise<ToolApprovalResult>;

export interface ProviderLivenessProbeResult {
  status: SessionLivenessProbeStatus;
  source: string;
  detail?: string;
  checkedAt?: Date;
}

export interface ProviderActivitySnapshot {
  lastRawProviderEventAt?: Date | null;
  lastRawProviderEventSource?: string | null;
}

export interface ProviderRetentionSnapshot {
  retained: boolean;
  reasons: string[];
  backgroundTaskCount?: number;
  sessionCronCount?: number;
  liveTaskCount?: number;
  lastUpdatedAt?: Date | null;
  /** Recorded independently of `retained`; Codex work never retains. */
  backgroundWork?: ProviderWorkItem[];
  foregroundWaits?: ProviderWorkItem[];
}

export interface StartSessionOptions {
  agentApi?: import("./providers/types.js").StartSessionOptions["agentApi"];
  onAgentApiRead?: import("./providers/types.js").StartSessionOptions["onAgentApiRead"];
  /** Installed MC command advertisement; independent of native access. */
  machineControl?: boolean;
  desktopControlOrigin?: DesktopControlOrigin;
  cwd: string;
  initialMessage?: UserMessage;
  resumeSessionId?: string;
  /** Resume through this transcript UUID only; see the provider option. */
  resumeSessionAt?: string;
  /** With `resumeSessionAt`: the one turn the truncation may drop. */
  resumeDropsTurn?: string;
  /**
   * Optional provider-visible client identity, used by providers that expose
   * launcher identity in session metadata (currently Codex).
   */
  clientName?: string;
  permissionMode?: PermissionMode;
  /** Model to use (e.g., "sonnet", "opus", "haiku"). undefined = use CLI default */
  model?: string;
  /** Thinking configuration (undefined = thinking disabled) */
  thinking?: import("@yep-anywhere/shared").ThinkingConfig;
  /** Effort level for response quality (undefined = SDK default) */
  effort?: import("@yep-anywhere/shared").EffortLevel;
  /**
   * Launch-time percentage override for Claude Code's own auto-compaction
   * window. Omitted leaves its environment/default unchanged.
   */
  launchCompactPercentOverride?: number;
  /** Claude-only policy for making matching foreground Bash calls resumable. */
  claudeSteerBackgroundBash?: ClaudeSteerBackgroundBashSettings;
  onToolApproval?: CanUseTool;
  /** Retired executor hint, retained so launch boundaries can refuse it. */
  executor?: string;
  /** Legacy launch environment overrides, also consumed by local Pi. */
  remoteEnv?: Record<string, string>;
  /** Session-scoped environment resolved for the canonical id and executor. */
  getSessionChildEnv?: (
    sessionId: string,
    executor?: string,
  ) => Record<string, string>;
  /** This launch's operator API token; see the provider StartSessionOptions. */
  agentServerEnvironment?: Record<string, string>;
  /** Global instructions to append to system prompt (from server settings) */
  globalInstructions?: string;
  /** Explicit provider-owned generation controls; omission means all off. */
  sessionOptions?: ProviderSessionOptions;
  /** Called when provider-owned retention evidence changes. */
  onProviderRetentionChange?: () => void;
  /** Prepared YA host sandbox applied to every provider child for this session. */
  sessionSandbox?: SessionSandboxRuntime;
  /**
   * Last YA-observed goal for this session. Providers that keep goal state
   * outside their own protocol (Claude) restore what only YA knows — a paused
   * goal, whose Stop hook YA removed and intends to reinstall.
   */
  restoredGoal?: ClaudeGoalSnapshot | null;
}

export interface StartSessionResult {
  revokeAgentApiAccess?: () => void | Promise<void>;
  revokePeerAgentApiAccess?: (grantId?: string) => void | Promise<void>;
  publishAgentSelfSelection?: (
    selection: import("../agent-tools/protocol.js").AgentSelfSelection,
  ) => void | Promise<void>;
  publishAgentSessionViews?: (
    views: readonly import("@yep-anywhere/shared").SessionClientView[],
  ) => void | Promise<void>;
  iterator: AsyncIterableIterator<SDKMessage>;
  queue: AgentMessageQueue;
  /**
   * Dispatch a provider-native slash command out-of-band. Returns
   * `{ handled: false }` when the command should reach the provider as
   * ordinary turn text instead.
   */
  runProviderCommand?: (
    command: string,
    argument?: string,
  ) => Promise<ProviderCommandResult>;
  abort: () => void | Promise<void>;
  /** Release only this server's client while a reload-safe provider survives. */
  detachForServerReload?: () => void | Promise<void>;
  /** Check if the underlying CLI process is still alive (undefined = not available) */
  isProcessAlive?: () => boolean;
  /** OS PID of the spawned agent child process (undefined if not available) */
  pid?: number | (() => number | undefined);
  /** Actively query provider/session status when passive progress evidence is stale. */
  probeLiveness?: () => Promise<ProviderLivenessProbeResult>;
  /** Passive raw provider/app-server event cadence, when available. */
  getProviderActivity?: () => ProviderActivitySnapshot;
  /** Provider-owned work that should retain an otherwise idle process. */
  getProviderRetention?: () => ProviderRetentionSnapshot;
  /** No-viewer period retained by a reload-safe runtime owner. */
  getRuntimeUnviewedSince?: () => Date | undefined;
  /**
   * Persist a viewer transition with a reload-safe runtime owner. Completion
   * acknowledges that exact state; failures reject for caller-owned retry.
   */
  setRuntimeViewerPresence?: (hasViewers: boolean) => void | Promise<void>;
  /**
   * Change max thinking tokens without restarting the session.
   * Pass null to disable thinking mode.
   * Only supported by Claude SDK 0.2.7+.
   */
  setMaxThinkingTokens?: (tokens: number | null) => Promise<void>;
  /**
   * Change the effort used by subsequent Claude responses without restarting.
   * undefined clears the session-scoped override.
   */
  setEffort?: (
    effort?: import("@yep-anywhere/shared").EffortLevel,
  ) => Promise<void>;
  /** This provider can publish effort changes into the active turn. */
  effortUpdatesActiveTurn?: boolean;
  /**
   * Change the provider service tier (for example Codex "priority") used by
   * subsequent turns without restarting. undefined selects the standard tier.
   */
  setServiceTier?: (serviceTier?: string) => Promise<void>;
  /** Request provider-owned generation changes for this live session. */
  setSessionOptions?: (
    options: ProviderSessionOptions,
  ) => Promise<ProviderSessionOptionsUpdateResult>;
  /**
   * Interrupt the current turn gracefully without killing the process.
   * Only supported by Claude SDK 0.2.7+.
   */
  interrupt?: () => Promise<undefined | boolean>;
  /**
   * Get the list of available models from the SDK.
   * Only supported by Claude SDK 0.2.7+.
   */
  supportedModels?: () => Promise<
    Array<{ id: string; name: string; description?: string }>
  >;
  /**
   * Get the list of available slash commands from the SDK.
   * Only supported by Claude SDK 0.2.7+.
   */
  supportedCommands?: () => Promise<SlashCommand[]>;
  /** What fills the live context window, by category (`/context` data). */
  getContextBreakdown?: () => Promise<
    import("@yep-anywhere/shared").ContextBreakdown
  >;
  /**
   * Change the model mid-session without restarting.
   * Only supported by Claude SDK 0.2.7+.
   */
  setModel?: (model?: string) => Promise<void>;
  /**
   * Publish the provider's canonical session id into any child-process
   * environment bridge the provider installed before startup.
   */
  publishAgentctlSessionId?: (
    sessionId: string,
    browserDebugEnvironment?: Record<string, string>,
  ) => void | Promise<void>;
}

export interface ProviderCommandOutput {
  /** Collapsed local-command row label. */
  summary: string;
  /** Expandable preformatted result sections. */
  details?: string[];
}

export interface ProviderCommandResult {
  /**
   * True when the provider owns this command and attempted to dispatch it
   * (whether or not it succeeded). False means "not a native command here" and
   * the caller should fall back to normal message delivery.
   */
  handled: boolean;
  /** Set when `handled` is true but the native dispatch failed. */
  error?: string;
  /** Optional YA-local result to publish without creating a provider turn. */
  output?: ProviderCommandOutput;
}

export interface RealClaudeSDKInterface {
  startSession(options: StartSessionOptions): Promise<StartSessionResult>;
}
