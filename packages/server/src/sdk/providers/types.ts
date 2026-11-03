import type { DesktopControlOrigin } from "../../desktop/machine-control.js";
import {
  nativeSessionFamily,
  parseNativeSessionId,
} from "@yep-anywhere/shared";
// Provider abstraction types for multi-provider support
import type {
  ClaudeSteerBackgroundBashSettings,
  ContextBreakdown,
  ConversationContextTurn,
  EffectiveSessionLaunchSettings,
  ModelCatalogStatus,
  ModelInfo,
  NativeSessionId,
  NativeSessionRef,
  YaSessionId,
  UrlProjectId,
  PermissionMode,
  PromptCacheKeepaliveProviderInfo,
  ProviderSubscriptionUsage,
  SlashCommand,
} from "@yep-anywhere/shared";
import type { AgentMessageQueue } from "../messageQueue.js";
import type { ClaudeGoalSnapshot } from "./claude-goal.js";
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
  | "antigravity"
  | "grok"
  | "opencode"
  | "pi";

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

/** Operation-scoped native source facts; application lineage keeps its YA id. */
export interface ProviderSessionSource {
  native: NativeSessionRef;
  /** Physical source when present; some native stores have no per-session file. */
  filePath?: string;
  projectId: UrlProjectId;
}

/** Copy/helper operations require an actual readable physical source. */
export interface ProviderForkSource extends ProviderSessionSource {
  filePath: string;
}

export interface ProviderForkOptions {
  nativeSessionId: NativeSessionId;
  nativeSource?: ProviderForkSource;
  cwd: string;
  upToMessageId?: string;
  boundary?: ProviderForkBoundary;
  title?: string;
  sessionSandbox?: SessionSandboxRuntime;
  launchSettings?: Omit<
    EffectiveSessionLaunchSettings,
    "schemaVersion" | "revision"
  >;
}

export interface ProviderForkResult {
  /** Native child allocation; Supervisor binds it to the admitted public identity. */
  nativeSessionId: NativeSessionId;
  filePath?: string;
  native?: NativeSessionRef;
  transcriptProjectId?: UrlProjectId;
}

export function assertProviderForkSource(
  options: {
    nativeSessionId: NativeSessionId;
    nativeSource?: ProviderSessionSource;
  },
  provider: ProviderName,
): void {
  parseNativeSessionId(options.nativeSessionId);
  const source = options.nativeSource;
  if (
    source &&
    (source.native.id !== options.nativeSessionId ||
      source.native.family !== nativeSessionFamily(provider))
  ) {
    throw new Error("Native fork source does not match the provider address");
  }
}

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

/** The provider CLI invocation that signs it in on this host. */
export interface ProviderLoginLaunch {
  executable: string;
  env: NodeJS.ProcessEnv;
  /** Arguments for a sign-in run without a terminal, its link relayed by YA. */
  relayedArgs: readonly string[];
  /** Arguments for a sign-in run in a visible terminal on the host. */
  terminalArgs: readonly string[];
  /** Whether the relayed sign-in reads an authorization code from stdin. */
  acceptsCode: boolean;
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
  /** Trusted native RPC acknowledgement; never inferred from a user echo. */
  onNativeInputConsumed?(nativeSessionId: string, inputId: string): void;
  /** Current controller only; functions never cross the private worker channel. */
  creationRuntime?: {
    identity: import("./creation-runtime-identity.js").CreationRuntimeIdentity;
    authorize(): Promise<void>;
    observe(
      evidence: import("./creation-runtime-identity.js").CreationRuntimeEvidence,
    ): void;
  };
  /** Trusted YA identity for child authority/AgentSelf; never a native handle. */
  publicSessionId?: YaSessionId;
  /** Private runtime transport only; never retained or returned to browsers. */
  routerLaunch?: import("../../services/AgentAuthRouter.js").RouterLaunch;
  instructionRestoration?: import("@yep-anywhere/shared").InstructionRestorationSettings;
  instructionReadHistory?: SDKMessage[];
  /** Hosted launches stream history over the worker socket before live observation. */
  deferInstructionHistory?: boolean;
  /** @deprecated Retired selection; accepted only for an explicit refusal. */
  computerControl?: boolean;
  /** Operator opt-in, preserved across provider-host process boundaries. */
  agentSelf?: boolean;
  /** Trusted local launch grant; never accepted from session-create JSON. */
  agentApi?: {
    serverId: string;
    management?: boolean;
    peerAccess?: boolean;
    peerGrantId?: string;
  };
  /** Controller-owned catalog dispatcher, removed at the worker boundary. */
  onAgentApiRead?: import("../../core-api/service.js").ApiReadPort;
  /** Spawn-only connection credential. Never publish into a Bash bridge file. */
  agentApiEnvironment?: Record<string, string>;
  /** Public bootstrap fragment, independently refreshed on Codex resume. */
  agentApiInstructions?: string;
  /** Explicit installed MC advertisement; no resident grant or supervisor. */
  machineControl?: boolean;
  /** Private credential proof; never accepted from JSON or restored settings. */
  desktopControlOrigin?: DesktopControlOrigin;
  /** Trusted owner-supplied child environment; never a client request field. */
  agentEnvironment?: Record<string, string>;
  /**
   * This launch's operator API token (`AGENT_SERVER_TOKEN`), set only for an
   * unsandboxed local launch. It enters the provider process environment and
   * nothing else: never the Bash bridge file, a remote executor, or a log.
   */
  agentServerEnvironment?: Record<string, string>;
  /** Working directory for the session */
  cwd: string;
  /** Initial message to send (optional - session can wait for message) */
  initialMessage?: UserMessage;
  /** Provider-native session ID to resume (optional). */
  resumeSessionId?: string;
  /** Trusted operation-scoped transcript source; never accepted from HTTP JSON. */
  nativeResumeSource?: ProviderSessionSource;
  /** Controller-owned recheck of an existing binding before hosted effects. */
  assertResumeAdmission?: () => void;
  /** Private host admission: claim an incumbent, never start/replace a worker. */
  retainedRuntimeOnly?: boolean;
  /**
   * YA's id for a new session. Providers that accept a caller-chosen id use
   * it as the native id, so the session never changes id once its provider
   * reports one; others ignore it. Never set together with `resumeSessionId`.
   */
  newSessionId?: string;
  /**
   * Resume only up to and including the message with this transcript UUID.
   * Used with `resumeSessionId` to drop an unsafe transcript tail (e.g. a
   * trailing SDK API-error message). Providers without prefix-resume support
   * ignore it.
   */
  resumeSessionAt?: string;
  /**
   * With `resumeSessionAt`: prompt UUID of the one turn the truncation is
   * meant to drop; the Claude CLI refuses when the discarded range holds
   * anything else. Providers without the guard ignore it.
   */
  resumeDropsTurn?: string;
  /**
   * Optional provider-visible client identity, used by providers that expose
   * launcher identity in session metadata (currently Codex).
   */
  clientName?: string;
  /** Permission mode for tool approvals */
  permissionMode?: PermissionMode;
  /**
   * Last YA-observed goal for a resumed session. Providers that keep goal
   * state outside their own protocol (Claude) restore what only YA knows: a
   * paused goal, whose Stop hook YA removed and intends to reinstall.
   */
  restoredGoal?: ClaudeGoalSnapshot | null;
  /** Model to use (e.g., "sonnet", "opus", "haiku") */
  model?: string;
  /**
   * Concrete id `model` resolved to at launch (see
   * `AgentProvider.resolveLaunchModel`). Only reported to the agent as
   * `AGENT_LAUNCH_MODEL`; `model` still selects what the provider runs.
   */
  launchModel?: string;
  /**
   * Configured model endpoint this launch is bound to, resolved once by the
   * server process from the catalog it holds (see
   * `AgentProvider.resolveLaunchGatewayRoute`); `null` binds it to the
   * provider's local path. A provider that honors this uses it for the whole
   * session rather than re-resolving `model` against a catalog of its own,
   * which a provider-host worker never reads and a later read can re-key.
   * Absent means the provider resolves the route itself at launch.
   */
  gatewayRoute?: import("@yep-anywhere/shared").ModelCatalogRoute | null;
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
  /** Retired executor hint, retained so launch boundaries can refuse it. */
  executor?: string;
  /** Legacy launch environment overrides, also consumed by local Pi. */
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
  revokeAgentApiAccess?: () => void | Promise<void>;
  revokePeerAgentApiAccess?: (grantId?: string) => void | Promise<void>;
  setAgentApiControllerAttached?: (attached: boolean) => void;
  hydrateInstructionReadHistory?: (
    messages: SDKMessage[],
    complete: boolean,
  ) => Promise<void>;
  configureInstructionRestoration?: (
    control: import("./instruction-restoration.js").InstructionRestorationControl,
  ) => Promise<void>;
  forceReadInstructions?: (
    paths: readonly string[],
  ) => Promise<"native-history" | "user-turn">;
  /** Active turn retained by an existing provider owner during controller reload. */
  initialTurnState?: "idle" | "in-turn";
  /** Publish selected/pending settings to the optional owning-session projection. */
  publishAgentSelfSelection?: (
    selection: import("../../agent-tools/protocol.js").AgentSelfSelection,
  ) => void | Promise<void>;
  /** Replace the per-client views served to the agent by `ya-agent view`. */
  publishAgentSessionViews?: (
    views: readonly import("@yep-anywhere/shared").SessionClientView[],
  ) => void | Promise<void>;
  /** Async iterator yielding SDK messages */
  iterator: AsyncIterableIterator<SDKMessage>;
  /** Message queue for sending messages to the agent */
  queue: AgentMessageQueue;
  /** Configured model endpoint this session is bound to for its lifetime. */
  gatewayServiceId?: string;
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
   * Canonical id the provider already reported through its init message to
   * an earlier owner. Set only for a reattached reload-safe runtime, whose
   * iterator will never replay that init.
   */
  initializedSessionId?: string;
  initialSteering?: import("@yep-anywhere/shared").ProviderSteeringState;
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
  /** Successful steers still await consumption through this session's queue. */
  steerUsesMessageQueue?: boolean;
  /** Append role-preserving history without a new turn; false means unavailable. */
  appendConversationContext?: (
    turns: ConversationContextTurn[],
  ) => Promise<boolean>;
  /**
   * Serve an MCP App view through the provider's own MCP connections: read
   * its resource, call its server's tools, or hold its model context.
   * Present only while MCP App hosting is enabled for this session.
   */
  mcpAppRequest?: (
    request: import("@yep-anywhere/shared").McpAppProviderRequest,
  ) => Promise<unknown>;
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
   * Change the provider service tier (for example Codex "priority") used by
   * subsequent turns without restarting. undefined selects the standard tier.
   */
  setServiceTier?: (serviceTier?: string) => Promise<void>;
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
  /** What fills the live context window, by category (`/context` data). */
  getContextBreakdown?: () => Promise<ContextBreakdown>;
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
  /** Registry-selected owner; independent/raw adapters default to local. */
  readonly runtimeOwner?: "local" | "host";
  /** Provider identifier */
  readonly name: ProviderName;
  /** Human-readable display name */
  readonly displayName: string;
  /** Whether this provider supports permission modes (default: true) */
  /** Accepts and verifies a trusted scoped native continuation source. */
  readonly supportsNativeResumeSource?: boolean;
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
  readonly steering?: import("@yep-anywhere/shared").ProviderSteeringCapabilities;
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
   * Whether the provider starts its session only once the first message is
   * delivered, so its init event — and with it the canonical session id —
   * cannot arrive while YA holds input back. Optional; absent means the
   * provider reports init on its own after startup.
   */
  readonly initializesOnFirstMessage?: boolean;
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
   * Resolve the CLI invocation that signs this provider in, or null when no
   * runnable CLI is installed. Absent for providers YA cannot sign in.
   */
  getLoginLaunch?(): Promise<ProviderLoginLaunch | null>;

  /**
   * Start a new agent session.
   * Returns the session iterator, message queue, and abort function.
   */
  startSession(options: StartSessionOptions): Promise<AgentSession>;

  /** Native allocation accepts YA's chosen spelling; otherwise it returns N. */
  readonly acceptsChosenSessionId?: boolean;
  /** Adapter forwards native image blocks rather than extracting text only. */
  readonly supportsInlineImages?: boolean;

  /** Actual new-session store, resolved before native allocation (no effects). */
  getNewSessionNamespace?(
    cwd: string,
    sandbox?: Pick<SessionSandboxRuntime, "transcriptDir">,
  ): Promise<Pick<NativeSessionRef, "family" | "storageScope">>;

  /**
   * Get available models for this provider. Implementations may cache;
   * `forceRefresh` discards that cache and reads the provider again.
   */
  getAvailableModels(options?: {
    forceRefresh?: boolean;
  }): Promise<ModelInfo[]>;

  /**
   * Provenance of the list the latest `getAvailableModels` call returned.
   * Absence means the provider does not report one.
   */
  getModelCatalogStatus?(): ModelCatalogStatus | undefined;

  /**
   * Read account/subscription quota windows without creating a provider turn.
   * Absence means the provider has no supported read path; null means the
   * current account/auth mode has no subscription usage to report.
   */
  getSubscriptionUsage?(
    models: readonly ModelInfo[],
  ): Promise<ProviderSubscriptionUsage | null>;

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
   * Concrete provider model id a launch selection (e.g. "opus") currently
   * resolves to, e.g. "claude-opus-5-5", from the already-fetched catalog; never
   * probes. `undefined` when the selection is absent or the catalog does not
   * report a resolution. Published to the agent as `AGENT_LAUNCH_MODEL`.
   */
  resolveLaunchModel?(model: string | undefined): string | undefined;

  /**
   * Which configured model endpoint a launch of this model uses, from the
   * catalog the server already holds, reading it once when the model is not
   * yet known; `null` for a launch that reaches no configured endpoint. The
   * hosted-provider proxy resolves this before handing the launch to a worker
   * and passes it as `StartSessionOptions.gatewayRoute`.
   */
  resolveLaunchGatewayRoute?(
    model: string | undefined,
  ): Promise<import("@yep-anywhere/shared").ModelCatalogRoute | null>;

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
  forkSession?: (options: ProviderForkOptions) => Promise<ProviderForkResult>;
}

/**
 * The operator API token environment this launch may carry: none for a remote
 * executor or a YA session sandbox. A provider-runtime worker receives the
 * sandbox only as `sessionSandboxOptions`, so both forms are checked.
 */
export function agentServerEnvironmentFor(
  options: StartSessionOptions,
): Record<string, string> | undefined {
  if (
    options.executor ||
    options.sessionSandbox ||
    options.sessionSandboxOptions?.level === "project-write"
  ) {
    return undefined;
  }
  return options.agentServerEnvironment;
}

/** Spawn only: keep this header out of bridge files and inherited YA launches. */
export function agentApiEnvironmentFor(
  options: StartSessionOptions,
): Record<string, string> | undefined {
  if (
    options.executor ||
    options.sessionSandbox ||
    options.sessionSandboxOptions?.level === "project-write"
  )
    return undefined;
  return options.agentApiEnvironment;
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

/** Provider requests carry native ids; the supervisor accepts public ingress. */
export type SummaryGenerationRequest<
  SessionId extends string = NativeSessionId,
> =
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
      generatorSessionId: SessionId;
      /** Exact source selected before provider effects; never a public-id path. */
      nativeSource?: ProviderForkSource;
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
      generatorSessionId: SessionId;
      /** Exact source selected before provider effects; never a public-id path. */
      nativeSource?: ProviderForkSource;
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
      generatorSessionId: SessionId;
      /** Exact source selected before provider effects; never a public-id path. */
      nativeSource?: ProviderForkSource;
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
