// Provider abstraction types for multi-provider support
import type {
  ClaudeSteerBackgroundBashSettings,
  ModelInfo,
  PermissionMode,
  PromptCacheKeepaliveProviderInfo,
  ProviderSubscriptionUsage,
  SlashCommand,
} from "@yep-anywhere/shared";
import type { AgentMessageQueue } from "../messageQueue.js";
import type {
  PrepareSessionSandboxOptions,
  SessionSandboxRuntime,
} from "../../session-sandbox.js";
import type {
  CanUseTool,
  ProviderActivitySnapshot,
  ProviderCommandResult,
  ProviderLivenessProbeResult,
  ProviderRetentionSnapshot,
  SDKMessage,
  UserMessage,
} from "../types.js";

/**
 * Provider names - extensible for future providers.
 *
 * "grok" added (additive only, Phase 1) for Grok Build ACP provider.
 * See topics/grok.md for full isolation contract + ENABLED_PROVIDERS gating.
 * This local copy must stay in sync with @yep-anywhere/shared ProviderName.
 */
export type ProviderName =
  | "claude"
  | "claude-gateway"
  | "claude-ollama"
  | "codex"
  | "codex-oss"
  | "gemini"
  | "gemini-acp"
  | "grok"
  | "opencode"
  | "pi";

/**
 * Internal provider-process placement. This is deliberately separate from the
 * released Claude-only `executor` string and is not a browser contract.
 */
export type SessionExecution =
  | { kind: "local" }
  | { kind: "legacy-ssh"; executor: string }
  | {
      kind: "managed-ssh";
      targetId: string;
      workspaceId: string;
      runnerGeneration: string;
    };

/**
 * Provider-native address of a completed transcript prefix. These identities
 * stay on the server; browser-facing message and session ids remain YA ids.
 */
export type ProviderForkBoundary =
  | {
      kind: "message";
      provider: "claude" | "claude-gateway" | "claude-ollama";
      messageId: string;
    }
  | {
      kind: "turn";
      provider: "codex" | "codex-oss";
      turnId: string;
    }
  | { kind: "entry"; provider: "pi"; entryId: string };

/**
 * Authentication status for a provider.
 */
export interface AuthStatus {
  /** Whether the provider is installed/available */
  installed: boolean;
  /** Whether the provider is authenticated */
  authenticated: boolean;
  /** Whether auth is enabled (e.g., ANTHROPIC_API_KEY is set) */
  enabled: boolean;
  /** When authentication expires (if applicable) */
  expiresAt?: Date;
  /** User info if available */
  user?: { email?: string; name?: string };
  /** Provider-specific command a user can run to authenticate. */
  loginCommand?: string;
}

/**
 * Provider-owned generation that can happen outside the user's requested
 * assistant response. Omitted options always resolve to false at the YA
 * provider boundary.
 */
export interface ProviderSessionOptions {
  /** Allow the provider to generate a title from session content. */
  automaticTitle?: boolean;
  /** Allow the provider to emit unsolicited away/progress recap turns. */
  automaticRecaps?: boolean;
  /** Allow periodic AI summaries of running subagents. */
  agentProgressSummaries?: boolean;
  /** Allow the provider to predict and emit a suggested next prompt. */
  promptSuggestions?: boolean;
}

export const DEFAULT_PROVIDER_SESSION_OPTIONS: Readonly<
  Required<ProviderSessionOptions>
> = {
  automaticTitle: false,
  automaticRecaps: false,
  agentProgressSummaries: false,
  promptSuggestions: false,
};

export const PROVIDER_SESSION_OPTION_KEYS = [
  "automaticTitle",
  "automaticRecaps",
  "agentProgressSummaries",
  "promptSuggestions",
] as const satisfies readonly (keyof ProviderSessionOptions)[];

export type ProviderSessionOptionStatus =
  | "applied"
  | "inactive"
  | "restart-required"
  | "unsupported"
  | "unknown";

export interface ProviderSessionOptionUpdate {
  requested: boolean;
  status: ProviderSessionOptionStatus;
  detail?: string;
}

export type ProviderSessionOptionsUpdateResult = Partial<
  Record<keyof ProviderSessionOptions, ProviderSessionOptionUpdate>
>;

export function resolveProviderSessionOptions(
  options?: ProviderSessionOptions,
): Required<ProviderSessionOptions> {
  return {
    automaticTitle:
      options?.automaticTitle ??
      DEFAULT_PROVIDER_SESSION_OPTIONS.automaticTitle,
    automaticRecaps:
      options?.automaticRecaps ??
      DEFAULT_PROVIDER_SESSION_OPTIONS.automaticRecaps,
    agentProgressSummaries:
      options?.agentProgressSummaries ??
      DEFAULT_PROVIDER_SESSION_OPTIONS.agentProgressSummaries,
    promptSuggestions:
      options?.promptSuggestions ??
      DEFAULT_PROVIDER_SESSION_OPTIONS.promptSuggestions,
  };
}

export function unknownProviderSessionOptionsResult(
  options: ProviderSessionOptions,
  detail: string,
): ProviderSessionOptionsUpdateResult {
  const result: ProviderSessionOptionsUpdateResult = {};
  for (const key of PROVIDER_SESSION_OPTION_KEYS) {
    const requested = options[key];
    if (requested === undefined) continue;
    result[key] = { requested, status: "unknown", detail };
  }
  return result;
}

export function inactiveProviderSessionOptionsResult(
  options: ProviderSessionOptions,
  detail: string,
): ProviderSessionOptionsUpdateResult {
  const result: ProviderSessionOptionsUpdateResult = {};
  for (const key of PROVIDER_SESSION_OPTION_KEYS) {
    const requested = options[key];
    if (requested === undefined) continue;
    result[key] = {
      requested,
      status: requested ? "unsupported" : "inactive",
      detail,
    };
  }
  return result;
}

/**
 * Options for starting a new agent session.
 */
export interface StartSessionOptions {
  /** Working directory for the session */
  cwd: string;
  /** Initial message to send (optional - session can wait for message) */
  initialMessage?: UserMessage;
  /** Session ID to resume (optional) */
  resumeSessionId?: string;
  /**
   * Resume only up to and including the message with this transcript UUID.
   * Used with `resumeSessionId` to drop an unsafe transcript tail (e.g. a
   * trailing SDK API-error message). Providers without prefix-resume support
   * ignore it.
   */
  resumeSessionAt?: string;
  /**
   * Optional provider-visible client identity, used by providers that expose
   * launcher identity in session metadata (currently Codex).
   */
  clientName?: string;
  /** Permission mode for tool approvals */
  permissionMode?: PermissionMode;
  /** Model to use (e.g., "sonnet", "opus", "haiku") */
  model?: string;
  /** Provider-visible service tier. undefined means provider/default behavior. */
  serviceTier?: string;
  /** Thinking configuration (undefined = thinking disabled) */
  thinking?: import("@yep-anywhere/shared").ThinkingConfig;
  /** Effort level for response quality (undefined = SDK default) */
  effort?: import("@yep-anywhere/shared").EffortLevel;
  /**
   * Explicit automatic-compaction threshold in total active-context tokens.
   * Omitted means the provider's own default; only providers advertising
   * supportsNativeCompactThreshold consume this.
   */
  compactAtContextTokenLimit?: number;
  /**
   * Launch-time percentage override for the provider's own auto-compaction
   * window. Omitted means the provider's environment/default is unchanged.
   */
  launchCompactPercentOverride?: number;
  /** Claude-only policy for making matching foreground Bash calls resumable. */
  claudeSteerBackgroundBash?: ClaudeSteerBackgroundBashSettings;
  /** Tool approval callback */
  onToolApproval?: CanUseTool;
  /** SSH host for remote execution (undefined = local) */
  executor?: string;
  /** Environment variables to set on remote (for testing: CLAUDE_SESSIONS_DIR) */
  remoteEnv?: Record<string, string>;
  /** Session-scoped environment resolved for the canonical id and executor. */
  getSessionChildEnv?: (
    sessionId: string,
    executor?: string,
  ) => Record<string, string>;
  /** Global instructions to append to system prompt (from server settings) */
  globalInstructions?: string;
  /** Explicit provider-owned generation controls; omission means all off. */
  sessionOptions?: ProviderSessionOptions;
  /** Called after a provider applies this mode at a policy boundary. */
  onPermissionModeApplied?: (mode: PermissionMode) => void;
  /**
   * Whether live provider deltas currently have an active consumer.
   * Providers that can skip expensive transient delta work should treat
   * undefined as true for compatibility.
   */
  shouldEmitLiveDeltas?: () => boolean;
  /** Called when provider-owned retention evidence changes. */
  onProviderRetentionChange?: () => void;
  /** Prepared YA host sandbox applied to every provider child for this session. */
  sessionSandbox?: SessionSandboxRuntime;
  /** Cloneable sandbox request used when a provider worker owns preparation. */
  sessionSandboxOptions?: PrepareSessionSandboxOptions;
}

/**
 * Result of starting an agent session.
 * This is the common interface all providers must return.
 */
export interface AgentSession {
  /** Async iterator yielding SDK messages */
  iterator: AsyncIterableIterator<SDKMessage>;
  /** Message queue for sending messages to the agent */
  queue: AgentMessageQueue;
  /** Internal placement identity retained by the owning Process. */
  execution?: SessionExecution;
  /** Abort function to cancel the session */
  abort: () => void | Promise<void>;
  /** Release only the replaceable server's proxy, retaining the provider owner. */
  detachForServerReload?: () => void | Promise<void>;
  /** Enable callbacks after the owning Process has installed its handlers. */
  activateCallbacks?: () => void;
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
   * Refresh provider prompt-cache warmth without adding a visible or
   * future-context-visible message to this session.
   */
  refreshPromptCache?: (options: {
    sessionId: string;
  }) => Promise<PromptCacheRefreshResult>;
  /** Session ID if available immediately (some providers provide later via messages) */
  sessionId?: string;
  /**
   * Publish the provider's canonical session id into any child-process
   * environment bridge the provider installed before startup.
   */
  publishAgentctlSessionId?: (
    sessionId: string,
    browserDebugEnvironment?: Record<string, string>,
  ) => void | Promise<void>;
  /**
   * Steer an active turn with additional user input.
   * Returns true when steered immediately, false when caller should enqueue instead.
   */
  steer?: (message: UserMessage) => Promise<boolean>;
  /**
   * Change max thinking tokens without restarting the session.
   * Pass null to disable thinking mode.
   * Only supported by Claude SDK 0.2.7+.
   */
  setMaxThinkingTokens?: (tokens: number | null) => Promise<void>;
  /**
   * Change the effort used by subsequent provider responses without restarting.
   * undefined clears the session-scoped override.
   */
  setEffort?: (
    effort?: import("@yep-anywhere/shared").EffortLevel,
  ) => Promise<void>;
  /** This provider can publish effort changes into the active turn. */
  effortUpdatesActiveTurn?: boolean;
  /**
   * Request provider-owned generation changes for this live session. Results
   * are explicit because some controls are launch-only or provider-unknown.
   */
  setSessionOptions?: (
    options: ProviderSessionOptions,
  ) => Promise<ProviderSessionOptionsUpdateResult>;
  /**
   * Interrupt the current turn gracefully without killing the process.
   * The query will stop processing the current turn and return control.
   * Only supported by Claude SDK 0.2.7+.
   */
  interrupt?: () => Promise<undefined | boolean>;
  /**
   * Get the list of available models from the SDK.
   * Only supported by Claude SDK 0.2.7+.
   */
  supportedModels?: () => Promise<ModelInfo[]>;
  /**
   * Get the list of available slash commands (skills) from the SDK.
   * Only supported by Claude SDK 0.2.7+.
   */
  supportedCommands?: () => Promise<SlashCommand[]>;
  /**
   * Change the model mid-session without restarting.
   * Only supported by Claude SDK 0.2.7+.
   */
  setModel?: (model?: string) => Promise<void>;
  /**
   * Run a provider-native slash command out-of-band — dispatched through the
   * provider's own protocol rather than delivered as a user turn. The result
   * may start native work or carry YA-local output; `{ handled: false }` means
   * the command is not native here and should fall back to normal turn delivery
   * (as Claude's `/compact` does).
   */
  runProviderCommand?: (
    command: string,
    argument?: string,
  ) => Promise<ProviderCommandResult>;
}

/**
 * Agent provider interface.
 * All providers (Claude, Codex, Gemini, local) implement this interface.
 */
export interface AgentProvider {
  /** Provider identifier */
  readonly name: ProviderName;
  /** Human-readable display name */
  readonly displayName: string;
  /** Whether this provider supports permission modes (default: true) */
  readonly supportsPermissionMode: boolean;
  /** Whether this provider supports extended thinking toggle (default: true) */
  readonly supportsThinkingToggle: boolean;
  /** Whether this provider supports slash commands (default: false) */
  readonly supportsSlashCommands: boolean;
  /** Whether this provider supports active turn steering (default: false) */
  readonly supportsSteering: boolean;
  /**
   * Whether active-turn steering can interrupt in-flight generation without
   * ending the turn. Optional; absent means false.
   */
  readonly supportsSteerNow?: boolean;
  /**
   * Whether this provider can synthesize an on-return recap of recent
   * activity. See topics/recaps.md. Optional; absent means false.
   */
  readonly supportsRecaps?: boolean;
  /**
   * Whether this provider emits recaps natively without YA spawning a side
   * query. Native support still must be user-disableable because it consumes
   * provider tokens/compute.
   */
  readonly supportsNativeRecaps?: boolean;
  /**
   * Whether this provider emits prompt suggestions natively in the ordinary
   * session protocol. YA-simulated suggestions are a separate side-session
   * feature and must not be implied by this flag.
   */
  readonly supportsNativePromptSuggestions?: boolean;
  /**
   * Whether this provider accepts a token threshold for automatic compaction.
   * Optional; absent means YA must orchestrate configured thresholds itself.
   */
  readonly supportsNativeCompactThreshold?: boolean;
  /**
   * Whether this provider accepts a launch-time percentage override for its
   * own automatic-compaction window.
   */
  readonly supportsLaunchCompactPercentOverride?: boolean;
  /**
   * Prompt-cache keepalive capability. Absence means YA must not show or
   * schedule keepalive for this provider.
   */
  readonly promptCacheKeepalive?: PromptCacheKeepaliveProviderInfo;

  /**
   * Check if this provider is installed and available.
   * For SDK-based providers, this is always true.
   * For CLI-based providers, this checks if the binary exists.
   */
  isInstalled(): Promise<boolean>;

  /**
   * Check if this provider is authenticated.
   * Returns true if the provider can be used immediately.
   */
  isAuthenticated(): Promise<boolean>;

  /**
   * Get detailed authentication status.
   */
  getAuthStatus(): Promise<AuthStatus>;

  /**
   * Start a new agent session.
   * Returns the session iterator, message queue, and abort function.
   */
  startSession(options: StartSessionOptions): Promise<AgentSession>;

  /**
   * Get available models for this provider.
   * For local providers (Codex with Ollama), this queries the local model list.
   * For cloud providers (Claude, Gemini), this returns a static list.
   */
  getAvailableModels(): Promise<ModelInfo[]>;

  /**
   * Read account/subscription quota windows without creating a provider turn.
   * Absence means the provider has no supported read path; null means the
   * current account/auth mode has no subscription usage to report.
   */
  getSubscriptionUsage?(
    models: readonly ModelInfo[],
  ): Promise<ProviderSubscriptionUsage | null>;

  /**
   * Read provider-owned user-facing session titles without parsing session
   * transcripts. Absence means titles remain YA-local for this provider.
   */
  listNativeSessionTitles?(): Promise<{
    titles: ReadonlyMap<string, string>;
    complete: boolean;
  }>;

  /** Persist a non-empty user-facing title through the provider's API. */
  setNativeSessionTitle?(sessionId: string, title: string): Promise<void>;

  /** Observe title notifications emitted by this provider process. */
  onNativeSessionTitleChanged?(
    listener: (sessionId: string, title: string) => void,
  ): () => void;

  /** Release provider resources owned only by native-title synchronization. */
  closeNativeSessionTitles?(): Promise<void>;

  /**
   * Server-maintained choices users may opt into separately from the primary
   * provider catalog. Absence means the provider has no such settings surface.
   */
  getAdditionalModelOptions?(): ModelInfo[];

  /**
   * Synchronous key for settings-dependent model projection. Provider-route
   * caches are reused only while this key remains unchanged.
   */
  getModelCatalogCacheKey?(): string;

  /**
   * Map a provider-reported model id (e.g. "claude-opus-4-8") back to a YA model
   * id / launch alias (e.g. "opus"), or `undefined` when no mapping is known.
   * This is the imperfect inverse of how YA aliases resolve at launch — properly
   * one-to-(zero or more), so the table returns a single canonical alias. Used
   * only to recover a keying id for sessions YA didn't start (the requested YA id
   * is unavailable); owned sessions key by their stored requested id instead.
   * See topics/provider-abstraction.md § Per-model settings keying.
   */
  yaModelIdForReported?(reported: string | undefined): string | undefined;

  /**
   * Generate a YA-owned summary through one of the supported helper
   * strategies. Recaps use a cheap side-session strategy over recent
   * assistant text; fork-backed helpers use a throwaway real fork so the
   * source transcript is not polluted and provider message structure/cache
   * warmth are preserved. See topics/recaps.md, topics/fork-from-turn.md,
   * and topics/session-retitle.md.
   */
  generateSummary?: (
    request: SummaryGenerationRequest,
  ) => Promise<SummaryGenerationResult>;

  /**
   * Fork a session's transcript into a new resumable session, optionally
   * sliced at a message (real prefix fork — the new session inherits the
   * source conversation up to that point, byte-identical, so prompt-cache
   * warmth carries over). Only providers with a true fork primitive
   * implement this; absence means the capability does not exist and must
   * not be emulated. See topics/session-context-actions.md.
   */
  forkSession?: (options: {
    /** Source provider session id. */
    sessionId: string;
    /** Project working directory the session belongs to. */
    cwd: string;
    /** Slice transcript up to this message UUID (inclusive); omit for full copy. */
    upToMessageId?: string;
    /** Typed provider boundary used by server-resolved fork intents. */
    boundary?: ProviderForkBoundary;
    /** Title for the forked session. */
    title?: string;
    /** Project-private provider state and process confinement inherited by the fork. */
    sessionSandbox?: SessionSandboxRuntime;
  }) => Promise<{ sessionId: string }>;
}

/**
 * Resolve the model a fork must inherit from its source session.
 *
 * An explicit requested model remains the launch contract. The provider's
 * reported model pins sessions launched through `default`, whose meaning can
 * otherwise drift between the source and the fork's first resumed turn.
 */
export function resolveInheritedForkModel(
  requestedModel: string | undefined,
  ...reportedModels: Array<string | undefined>
): string | undefined {
  if (requestedModel && requestedModel !== "default") {
    return requestedModel;
  }
  for (const reportedModel of reportedModels) {
    if (reportedModel && reportedModel !== "default") {
      return reportedModel;
    }
  }
  return undefined;
}

export type SummaryGenerationRequest =
  | {
      purpose: "recap";
      strategy: "side-session";
      recentAssistantText: string[];
      model?: string;
    }
  | {
      purpose: "recap";
      strategy: "fork";
      /** Archived helper fork whose full current context should be recapped. */
      generatorSessionId: string;
      /** Project working directory the session belongs to. */
      cwd: string;
      /** Exact source model inherited by the fork; helper effort is independent. */
      model: string | undefined;
      /** Cancels the helper query when the request is abandoned. */
      signal?: AbortSignal;
      /** Shared project-private provider state inherited from the source. */
      sessionSandbox?: SessionSandboxRuntime;
    }
  | {
      purpose: "fork-after-summary";
      strategy: "fork";
      /** Archived helper fork whose whole context should be summarized. */
      generatorSessionId: string;
      /** Project working directory the session belongs to. */
      cwd: string;
      /** Exact source model inherited by the fork; helper effort is independent. */
      model: string | undefined;
      /** Completed-turn boundary retained by the target fork. */
      afterTurnMessageId: string;
      /** Human-readable excerpt of the retained boundary, when available. */
      afterTurnContext?: string;
      /** User-authored summary instructions from the composer. */
      instructions?: string;
      /** Cancels the helper query when the server-owned job is cancelled. */
      signal?: AbortSignal;
      /** Shared project-private provider state inherited from the source. */
      sessionSandbox?: SessionSandboxRuntime;
    }
  | {
      purpose: "session-retitle";
      strategy: "fork";
      /** Archived helper fork whose whole context should be titled. */
      generatorSessionId: string;
      /** Project working directory the session belongs to. */
      cwd: string;
      /** Exact source model inherited by the fork; helper effort is independent. */
      model: string | undefined;
      /** Current displayed title, if any, to avoid repeating a bad title. */
      currentTitle?: string;
      /** Target maximum title length in characters. */
      lengthTarget?: number;
      /** Cancels the helper query when the request is abandoned. */
      signal?: AbortSignal;
      /** Shared project-private provider state inherited from the source. */
      sessionSandbox?: SessionSandboxRuntime;
    };

export interface SummaryGenerationResult {
  text: string;
}

export interface PromptCacheRefreshResult {
  /** Provider-specific cache-touch path that ran. */
  mode: "no-context-pollution-nudge";
  /** Whether the cache-touch request completed successfully. */
  refreshed: boolean;
  /** Human/debug description; do not include prompt or transcript content. */
  detail?: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
  };
}
