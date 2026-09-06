import type { UrlProjectId } from "./projectId.js";

/**
 * Provider name - which AI agent provider to use.
 * - "claude": Claude via Anthropic SDK
 * - "claude-gateway": Claude SDK routed through a configured LLM gateway
 * - "claude-ollama": Legacy Claude SDK transport for Ollama
 * - "codex": OpenAI Codex via SDK (cloud models)
 * - "codex-oss": Codex via CLI with --oss (local models via Ollama)
 * - "gemini": Google Gemini via CLI
 * - "gemini-acp": Gemini via CLI with --experimental-acp (preferred)
 * - "grok": Grok Build via ACP (`grok agent stdio`) - Phase 1 isolated prototype
 * - "opencode": OpenCode via HTTP server (multi-provider agent)
 * - "pi": pi via `pi --mode rpc` (provider-agnostic agent; see topics/pi-provider.md)
 *
 * "grok" added (additive only) for Phase 1 Grok Build provider per topics/grok.md.
 * Gated behind ENABLED_PROVIDERS=grok; no impact on other providers or core paths.
 * "pi" added (additive, Plan A live RPC) per topics/pi-provider.md.
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
 * All provider names in display order.
 * Used for filter dropdowns, iteration, etc.
 * Keep in sync with ProviderName type above.
 *
 * "grok" added (additive) - see ProviderName comment for isolation/ENABLED_PROVIDERS notes.
 */
export const ALL_PROVIDERS: readonly ProviderName[] = [
  "claude",
  "claude-gateway",
  "claude-ollama",
  "codex",
  "codex-oss",
  "gemini",
  "gemini-acp",
  "grok",
  "opencode",
  "pi",
] as const;

export type ClaudeProviderName = "claude" | "claude-gateway" | "claude-ollama";

export function isClaudeProviderName(
  provider: string | undefined,
): provider is ClaudeProviderName {
  return (
    provider === "claude" ||
    provider === "claude-gateway" ||
    provider === "claude-ollama"
  );
}

/**
 * The default provider when none is specified.
 * Used for backward compatibility with existing sessions that don't have provider set.
 */
export const DEFAULT_PROVIDER: ProviderName = "claude";

export const CODEX_REASONING_SUMMARIES = [
  "auto",
  "concise",
  "detailed",
  "none",
] as const;
export type CodexReasoningSummary = (typeof CODEX_REASONING_SUMMARIES)[number];
export const DEFAULT_CODEX_REASONING_SUMMARY: CodexReasoningSummary = "auto";

export function isCodexReasoningSummary(
  value: unknown,
): value is CodexReasoningSummary {
  return CODEX_REASONING_SUMMARIES.some((summary) => summary === value);
}

/**
 * Model information for a provider.
 */
export interface ModelInfo {
  /** Model identifier (e.g., "sonnet", "qwen2.5-coder:0.5b") */
  id: string;
  /** Human-readable name */
  name: string;
  /** Description of the model's capabilities (optional) */
  description?: string;
  /** Model size in bytes (for local models) */
  size?: number;
  /** Context window size in tokens (for local models) */
  contextWindow?: number;
  /** Parameter count string, e.g. "30.5B" (for local models) */
  parameterSize?: string;
  /** Base model this preset was derived from, e.g. "qwen3-coder:30b" */
  parentModel?: string;
  /** Quantization level, e.g. "Q4_K_M" */
  quantizationLevel?: string;
  /** Provider-reported default marker, when available. */
  isDefault?: boolean;
  /** Provider-reported default reasoning effort, when available. */
  defaultReasoningEffort?: string;
  /** Provider-reported supported reasoning efforts, when available. */
  supportedReasoningEfforts?: Array<{
    reasoningEffort: string;
    description?: string;
  }>;
  /** Whether this model supports named effort levels, when available. */
  supportsEffort?: boolean;
  /** Provider-reported supported effort levels, when available. */
  supportedEffortLevels?: EffortLevel[];
  /** Provider-reported default effort level, when available. */
  defaultEffortLevel?: EffortLevel;
  /** Whether this model supports adaptive thinking, when available. */
  supportsAdaptiveThinking?: boolean;
  /** Whether this model supports provider fast mode, when available. */
  supportsFastMode?: boolean;
  /** Whether this model supports provider auto mode, when available. */
  supportsAutoMode?: boolean;
  /** Provider-reported input modalities, e.g. text/image. */
  inputModalities?: string[];
  /** Provider-reported personality support. */
  supportsPersonality?: boolean;
  /** Provider-reported opt-in service tiers, e.g. faster paid processing. */
  serviceTiers?: ModelServiceTier[];
  /** Non-primary provider catalog group, omitted for the curated/default list. */
  catalogGroup?: "additional";
}

export interface ModelServiceTier {
  /** Provider-visible service tier id to send for this model. */
  id: string;
  /** Human-readable tier name. */
  name: string;
  /** Provider-reported description, often including speed/cost trade-off. */
  description?: string;
}

/**
 * Provider-level image sizing guidance for client-side rescaling before upload.
 * These are model-input recommendations, not archival display sizes; keep an
 * original/full-resolution path if the session should preserve readable history.
 */
export interface ProviderImageSizing {
  /** Default long-edge target to use for ordinary attachments. */
  defaultLongEdgePx: number;
  /** Upper bound that still tends to be useful before provider-side downscale. */
  maxUsefulLongEdgePx: number;
  /** Optional note about model-family caveats or detail behavior. */
  note?: string;
}

export const RECAP_MODES = ["off", "side-session", "fork", "native"] as const;
export type RecapMode = (typeof RECAP_MODES)[number];
export const DEFAULT_RECAP_AFTER_SECONDS = 5 * 60;
export const MIN_RECAP_AFTER_SECONDS = 1;
export const MAX_RECAP_AFTER_SECONDS = 24 * 60 * 60;

export function clampRecapAfterSeconds(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_RECAP_AFTER_SECONDS;
  return Math.min(
    MAX_RECAP_AFTER_SECONDS,
    Math.max(MIN_RECAP_AFTER_SECONDS, Math.round(value)),
  );
}

export function normalizeRecapAfterSeconds(
  value: number | null | undefined,
): number {
  return typeof value === "number"
    ? clampRecapAfterSeconds(value)
    : DEFAULT_RECAP_AFTER_SECONDS;
}

export const PROMPT_SUGGESTION_MODES = ["off", "native"] as const;
export type PromptSuggestionMode = (typeof PROMPT_SUGGESTION_MODES)[number];

export const PROMPT_CACHE_KEEPALIVE_MODES = ["auto", "off"] as const;
export type PromptCacheKeepaliveMode =
  (typeof PROMPT_CACHE_KEEPALIVE_MODES)[number];
export const DEFAULT_PROMPT_CACHE_KEEPALIVE_INACTIVITY_MINUTES = 40;

export const DEFAULT_CACHE_MISS_BILLING_FRESH_WINDOW_MINUTES = 60;
export const DEFAULT_CACHE_MISS_BILLING_PROVIDER_FRESH_WINDOW_MINUTES: Partial<
  Record<ProviderName, number>
> = {
  claude: 60,
  codex: 10,
};
/**
 * Wasted tokens below this are treated as measurement noise, not a miss. A
 * continuing turn is *expected* to pay for the content appended since the
 * cached prefix, so this threshold applies to the excess over that
 * expectation — never to the expectation itself.
 */
export const DEFAULT_CACHE_MISS_BILLING_MINIMUM_WASTED_TOKENS = 10_000;
/**
 * Optional upper bound on human-turn idle gaps YA judges. Zero keeps every
 * observation inside the provider freshness window eligible.
 */
export const DEFAULT_CACHE_MISS_BILLING_IGNORE_AFTER_MINUTES = 0;
/** Lower no-alert window retained as the stable legacy wire contract. */
export const DEFAULT_CACHE_MISS_BILLING_RECENT_ACTIVITY_MINUTES = 10;

export interface CacheMissBillingSettings {
  /** Enable usage-accounting detection and durable server-side evidence logs. */
  enabled?: boolean;
  /** Show an in-app popup when a flagged recompute is recorded. */
  showToasts?: boolean;
  /** Fallback freshness window when a provider has no explicit override. */
  freshWindowMinutes?: number;
  /** Provider-specific windows where YA expects a warm provider cache. */
  providerFreshWindowMinutes?: Partial<Record<ProviderName, number>>;
  /** Wasted-token floor, measured as excess over the expected new content. */
  minimumWastedTokens?: number;
  /**
   * Record but do not flag misses inside this many idle minutes.
   */
  recentActivityMinutes?: number;
  /** Ignore observations after this many idle minutes. Zero disables it. */
  ignoreAfterMinutes?: number;
}

export type CacheMissBillingReason =
  | "fork-prefix-cache-miss"
  | "warm-session-cache-miss"
  | "warm-session-cache-expiry"
  | "fork-prefix-cache-hit"
  | "warm-session-cache-hit";

export type CacheMissBillingOutcome =
  | "unexpected-recompute"
  | "expected-cache-expiry"
  | "expected-cache-hit";

export interface ExpectedInputCostState {
  /**
   * `expected-free` is a fork's first turn, where the whole prefix should
   * already be cached. `expected-new-content` is an ordinary continuing turn,
   * which is expected to pay for the tokens appended since that prefix.
   */
  state: "expected-free" | "expected-new-content";
  /**
   * Tokens YA expects to be billed above the cache-read rate on this turn: the
   * content appended since the cached prefix, measured as the growth in total
   * prompt size. Undefined when YA has no previous turn to measure against
   * (session boot), which is why boot turns are never flagged.
   */
  expectedUncachedPrefixTokens?: number;
  source: "fork" | "warm-session";
  /** Why YA believes the cacheable prefix matches a recent provider prefix. */
  prefixBasis: "provider-fork-byte-identical" | "same-session-prefix";
  /** True when the provider cache should still be inside its freshness window. */
  freshEnough: boolean;
  providerFreshWindowMinutes: number;
}

export interface CacheMissBillingUsage {
  /**
   * Provider-reported input tokens as the provider counts them. Claude
   * excludes cached reads and cache writes from this; Codex includes cached
   * reads in it. Use `uncachedInputTokens` for cross-provider comparison.
   */
  inputTokens: number;
  /** Provider-reported cached-read input tokens, when visible. */
  cacheReadTokens?: number;
  /** Provider-reported cache-creation/write input tokens, when visible. */
  cacheCreationTokens?: number;
  /** Provider-reported output tokens, when visible. */
  outputTokens?: number;
  /** Whole prompt size for the turn, cached and uncached parts together. */
  totalContextTokens: number;
  /** Prompt tokens billed above the cache-read rate, normalized per provider. */
  uncachedInputTokens: number;
}

export interface CacheMissBillingRecord {
  id: string;
  timestamp: string;
  provider: ProviderName;
  /** Provider-reported model when known; absent on records from older servers. */
  model?: string;
  sessionId: string;
  projectId: UrlProjectId;
  sessionPath: string;
  /** Interactive Mother session when the observed fork is a `/btw` aside. */
  parentSessionId?: string;
  /** Source session for an ordinary Clone/Fork/helper lineage. */
  forkedFromSessionId?: string;
  reason: CacheMissBillingReason;
  outcome: CacheMissBillingOutcome;
  /** Whether this measured miss is worth an operator's attention. */
  exception: boolean;
  messageId?: string;
  messageIndex?: number;
  observedUsage: CacheMissBillingUsage;
  expectedInputCost: ExpectedInputCostState;
  /**
   * Tokens re-read at full price that a warm cache should have served —
   * observed uncached input minus the expected new content, floored at zero.
   * This is the quantity the inactivity histogram sums per bucket.
   */
  wastedInputTokens: number;
  freshWindowMinutes: number;
  /**
   * Gap from the previous cache-warm assistant observation to the moment this
   * human turn was yielded to the provider, which is the histogram's x axis.
   * Additional provider requests inside that same human turn use zero.
   */
  elapsedSinceExpectedCacheMs?: number;
  expectedCacheSource: "fork" | "warm-session";
  /**
   * This record is the first provider request for a complete human-turn
   * hit/miss sample. Later same-turn provider requests and older records do not
   * support the human-turn probability denominator.
   */
  completeProbabilitySample?: true;
}

export const DEFAULT_CACHE_MISS_BILLING_SETTINGS: Required<CacheMissBillingSettings> =
  {
    enabled: false,
    showToasts: true,
    freshWindowMinutes: DEFAULT_CACHE_MISS_BILLING_FRESH_WINDOW_MINUTES,
    providerFreshWindowMinutes:
      DEFAULT_CACHE_MISS_BILLING_PROVIDER_FRESH_WINDOW_MINUTES,
    minimumWastedTokens: DEFAULT_CACHE_MISS_BILLING_MINIMUM_WASTED_TOKENS,
    recentActivityMinutes: DEFAULT_CACHE_MISS_BILLING_RECENT_ACTIVITY_MINUTES,
    ignoreAfterMinutes: DEFAULT_CACHE_MISS_BILLING_IGNORE_AFTER_MINUTES,
  };

export interface PromptCacheKeepaliveProviderInfo {
  /** Whether this provider can refresh/cache-touch without polluting session context. */
  supportsNoContextPollutionNudge: boolean;
  /** Default mode for capable providers when no server setting is saved. */
  defaultMode: PromptCacheKeepaliveMode;
  /** Default idle cadence in minutes when no server setting overrides it. */
  defaultInactivityMinutes: number;
}

export interface PromptCacheKeepaliveProviderSetting {
  mode?: PromptCacheKeepaliveMode;
  inactivityMinutes?: number;
}

export interface PromptCacheKeepaliveSettings {
  providers?: Partial<
    Record<ProviderName, PromptCacheKeepaliveProviderSetting>
  >;
}

export const HELPER_SIDE_MODEL_SAME_AS_MAIN = "same-as-main" as const;
export const HELPER_SIDE_MODEL_CHEAPEST = "cheapest" as const;
export const HELPER_SIDE_MODEL_TARGET_PREFIX = "helper-target:" as const;

export interface HelperTargetConfig {
  /** Stable local id used in helperSideModel values. */
  id: string;
  /** User-facing label shown in helper model selectors. */
  name: string;
  /** API family for this helper target. */
  kind: "openai-compatible";
  /** Base URL for the OpenAI-compatible API, e.g. http://localhost:8001/v1. */
  baseUrl: string;
  /** Optional served model id; blank means use the endpoint default if supported. */
  model?: string;
}

/**
 * Slash command (skill) available in a session.
 */
export interface GrokSlashCommandDetails {
  /** Whether Grok reported this as a built-in command or a skill-backed command. */
  source: "builtin" | "skill";
  /** Grok skill scope, when reported. */
  scope?: string;
  /** Grok skill definition path, when reported. */
  path?: string;
}

export interface SlashCommandProviderDetails {
  grok?: GrokSlashCommandDetails;
  codex?: {
    goalObjective?: string | null;
    /** Provider-observed status; omission keeps older inventories read-only. */
    goalStatus?: string | null;
  };
  [provider: string]: unknown;
}

export interface SlashCommandEmulation {
  /** Provider-visible command template YA sends for this advertised command. */
  providerText: string;
}

export type SlashCommandInvocationKind = "native" | "skill" | "emulated";
export type SlashCommandInvocationPrefix = "/" | "$";
export type SlashCommandInventoryState = "current" | "stale";

export interface SlashCommandInvocation {
  /** What the inventory entry invokes, when the provider can say precisely. */
  kind: SlashCommandInvocationKind;
  /** Provider-canonical sigil used for insertion and provider ingress. */
  prefix: SlashCommandInvocationPrefix;
  /** Provider-reported alternative names, without a sigil. */
  aliases?: string[];
  /** Freshness of the provider inventory that established a skill entry. */
  inventoryState?: SlashCommandInventoryState;
}

export interface SlashCommandArgumentCompletion {
  /** Provider-authored argument text inserted after the command token. */
  value: string;
  /** Optional provider-authored explanation shown beside the completion. */
  description?: string;
}

export interface SlashCommand {
  /** Command name without leading slash (e.g., "commit", "review-pr") */
  name: string;
  /** Description of what the command does */
  description: string;
  /** Hint for command arguments (e.g., "<file>") */
  argumentHint?: string;
  /** Non-exhaustive provider-owned completions for the first argument. */
  argumentCompletions?: SlashCommandArgumentCompletion[];
  /** YA-owned fallback behavior for a command the provider does not expose. */
  emulation?: SlashCommandEmulation;
  /** Optional provider-specific provenance or capability detail. */
  providerDetails?: SlashCommandProviderDetails;
  /** Optional invocation semantics; absent on legacy command inventories. */
  invocation?: SlashCommandInvocation;
}

/**
 * Provider info for UI display.
 */
export interface ProviderInfo {
  name: ProviderName;
  displayName: string;
  installed: boolean;
  /**
   * Coarse desktop-only hint that provider-owned app/config data was found.
   * It does not assert authentication or that the provider can be launched.
   */
  applicationDetected?: boolean;
  authenticated: boolean;
  enabled: boolean;
  expiresAt?: string;
  user?: { email?: string; name?: string };
  /** Available models for this provider */
  models?: ModelInfo[];
  /** Server-maintained opt-in choices that do not enter models by default. */
  additionalModelOptions?: ModelInfo[];
  /** Long-edge image sizing guidance for client-side attachment rescaling. */
  imageSizing?: ProviderImageSizing;
  /** Whether this provider supports permission modes (default: true for backward compat) */
  supportsPermissionMode?: boolean;
  /** Whether this provider supports extended thinking toggle (default: true for backward compat) */
  supportsThinkingToggle?: boolean;
  /** Whether this provider supports slash commands (default: false) */
  supportsSlashCommands?: boolean;
  /** Whether this provider supports active turn steering (default: false) */
  supportsSteering?: boolean;
  /**
   * Whether steering can additionally interrupt in-flight generation
   * (Claude `priority: "now"`). Default: false.
   */
  supportsSteerNow?: boolean;
  /** Whether this provider can generate YA-triggered recap messages. */
  supportsRecaps?: boolean;
  /** Whether this provider emits recaps natively without a YA side query. */
  supportsNativeRecaps?: boolean;
  /** Whether this provider emits prompt suggestions in its ordinary protocol. */
  supportsNativePromptSuggestions?: boolean;
  /**
   * Whether this provider accepts an explicit automatic-compaction threshold.
   * Absence means YA must orchestrate a configured threshold itself.
   */
  supportsNativeCompactThreshold?: boolean;
  /**
   * Whether this provider accepts a launch-time percentage override for its
   * own automatic-compaction window. This is distinct from a percentage of
   * the model's full context window and cannot be changed in-place.
   */
  supportsLaunchCompactPercentOverride?: boolean;
  /** Prompt-cache keepalive capability exposed for provider-economics UI. */
  promptCacheKeepalive?: PromptCacheKeepaliveProviderInfo;
  /**
   * Whether this provider has a real transcript-fork primitive (new
   * resumable session from a prefix of an existing one). Default: false;
   * never emulated when absent.
   */
  supportsForkSession?: boolean;
  /** Provider-specific command a user can run to authenticate this provider. */
  loginCommand?: string;
}

/**
 * Permission mode for tool approvals.
 * - "default": Auto-approve read-only tools (Read, Glob, Grep, etc.), ask for mutating tools
 * - "acceptEdits": Auto-approve file editing tools (Edit, Write, NotebookEdit), ask for others
 * - "plan": Auto-approve read-only tools, ask for others (planning/analysis mode)
 * - "auto": Use provider classifier to approve or deny permission prompts
 * - "bypassPermissions": Auto-approve all tools (full autonomous mode)
 */
export type PermissionMode =
  | "default"
  | "bypassPermissions"
  | "acceptEdits"
  | "plan"
  | "auto";

/**
 * All permission modes in canonical order.
 * Used for validation, dropdowns, and iteration.
 * Keep in sync with PermissionMode above.
 */
export const ALL_PERMISSION_MODES: readonly PermissionMode[] = [
  "default",
  "acceptEdits",
  "plan",
  "bypassPermissions",
  "auto",
] as const;

/**
 * YA-owned host filesystem confinement selected before provider launch.
 * "none" preserves provider/default behavior; "project-write" makes the
 * selected project the only persistent writable project-facing root.
 */
export type SessionSandboxLevel = "none" | "project-write";

export const SESSION_SANDBOX_LEVELS: readonly SessionSandboxLevel[] = [
  "none",
  "project-write",
] as const;

export interface SessionSandboxEnforcement {
  requested: SessionSandboxLevel;
  effective: SessionSandboxLevel;
  state: "enforced" | "unsupported" | "setup-failed";
  hostBackend?: string;
  /** Whether this launch also enforces public-only IPv4 egress. */
  networkFirewall?: boolean;
  providerPolicy?: string;
}

export type SessionSandboxAvailabilityState =
  | "available"
  | "auth-required"
  | "unsupported-platform"
  | "missing-bubblewrap"
  | "untrusted-bubblewrap"
  | "unsupported-version"
  | "probe-failed";

/**
 * Server-host preflight for offering YA session sandboxing. This is advisory
 * UI availability only; every enabled launch repeats the authoritative probe.
 */
export interface SessionSandboxAvailability {
  state: SessionSandboxAvailabilityState;
  platform: string;
  backend?: "bubblewrap";
  version?: string;
}

/**
 * Saved defaults for the new session form.
 */
export interface ProviderSessionDefaults {
  model?: string;
  /** Provider-visible service tier. undefined means provider/default behavior. */
  serviceTier?: string;
  /** Provider-work thinking mode for new sessions on this provider. */
  thinkingMode?: ThinkingMode;
  /** Provider-local effort level for new sessions on this provider. */
  effortLevel?: EffortLevel;
  /** Provider-local helper model for tailed recaps. */
  helperSideModel?: string;
}

export interface NewSessionDefaults {
  provider?: ProviderName;
  /** @deprecated Use providers[provider].model. Preserved for migration. */
  model?: string;
  /** @deprecated Use providers[provider].serviceTier. Preserved for migration. */
  serviceTier?: string;
  permissionMode?: PermissionMode;
  /** Default-off YA host filesystem confinement for newly created sessions. */
  sandboxLevel?: SessionSandboxLevel;
  /** Public-only egress boundary for project-write sessions; absent means on. */
  sandboxNetworkFirewall?: boolean;
  recapMode?: RecapMode;
  /**
   * Browser-away duration before YA asks the live process for a recap.
   */
  recapAfterSeconds?: number;
  promptSuggestionMode?: PromptSuggestionMode;
  /** Provider/model economics defaults keyed by provider. */
  providers?: Partial<Record<ProviderName, ProviderSessionDefaults>>;
}

export interface SpeechSmartTurnClientDefault {
  enabled: boolean;
  threshold: number;
  timeoutMs: number;
  /** Post-endpoint command grace window; optional for pre-grace servers. */
  graceMs?: number;
}

export interface GrokSpeechAudioClientDefault {
  uplinkMode: "pcm16" | "browser-compressed";
}

export interface SpeechClientDefaults {
  voiceInputEnabled?: boolean;
  speechMethod?: string;
  speechSmartTurnSettings?: SpeechSmartTurnClientDefault;
  grokSpeechAudioSettings?: GrokSpeechAudioClientDefault;
}

/**
 * How eagerly a session-toolbar control collapses into the `...` overflow menu
 * as the composer narrows ("narrowing priority"). `first` collapses first,
 * `mid` next, `last` collapses last; `pin` never collapses. Ordered
 * highest-survival first.
 */
export type ToolbarNarrowingPriority = "pin" | "last" | "mid" | "first";

/**
 * A session-toolbar control's single presence setting: `off` disables the
 * control, `hidden` keeps an enabled control off the toolbar, and any
 * narrowing-priority tier shows it with that collapse behavior. Controls
 * without a disabled behavior should not offer `off` in their settings UI.
 */
export type ToolbarControlPresence =
  | "off"
  | "hidden"
  | ToolbarNarrowingPriority;

/** Per-control presence defaults for controls with no local override. */
export interface SessionToolbarPresenceClientDefaults {
  modeSelector?: ToolbarControlPresence;
  steerNow?: ToolbarControlPresence;
  attachments?: ToolbarControlPresence;
  slashMenu?: ToolbarControlPresence;
  thinkingToggle?: ToolbarControlPresence;
  renderMode?: ToolbarControlPresence;
  microphone?: ToolbarControlPresence;
  waveform?: ToolbarControlPresence;
  shortcutsHelp?: ToolbarControlPresence;
  contextUsage?: ToolbarControlPresence;
  btw?: ToolbarControlPresence;
  nudge?: ToolbarControlPresence;
  sessionStatus?: ToolbarControlPresence;
  projectQueue?: ToolbarControlPresence;
  projectQueueNewSessionShortcut?: ToolbarControlPresence;
  syntheticDone?: ToolbarControlPresence;
  composerRecall?: ToolbarControlPresence;
}

export type BusyComposerDefaultAction = "steer" | "queue";

export type CollapsedComposerButtonPreference =
  | "primary"
  | "alternate"
  | "microphone";

export const DEFAULT_PROJECT_QUEUE_CTRL_ENTER_ENABLED = true;
export const DEFAULT_STEER_NOW_ENABLED = true;

export interface ClientDefaults {
  /** Defaults used by browser clients when local storage has no explicit value. */
  speech?: SpeechClientDefaults;
  /**
   * Enables local `!!` shell commands and their history UI. Off when absent:
   * this YA-specific behavior must be explicitly opted into.
   */
  bangCommandsEnabled?: boolean;
  /**
   * Default primary action for busy sessions that can both steer the active turn
   * and queue a later message. Existing session-local overrides still win.
   */
  busyComposerDefaultAction?: BusyComposerDefaultAction;
  /**
   * Trailing action shown by collapsed composers on tight layouts. Desktop may
   * show additional side affordances when there is room.
   */
  collapsedComposerButton?: CollapsedComposerButtonPreference;
  /**
   * Initial state of the per-turn "now" steering toggle for providers with a
   * "now" lane (currently Claude). The toggle itself stays per-turn. When
   * absent, clients use DEFAULT_STEER_NOW_ENABLED.
   */
  steerNowDefault?: boolean;
  /**
   * Default for the "wait until the agent is fully done before delivering
   * queued messages" preference (patient queue intent). Global; set in the
   * Message Delivery settings pane. Off = deliver at the next end of turn
   * (`deferred`).
   */
  patientQueueDefault?: boolean;
  /**
   * When true, Ctrl+Enter uses Project Queue whenever the Project Queue
   * affordance is available. Off leaves Ctrl+Enter bound to the regular
   * per-session alternate action.
   */
  projectQueueCtrlEnterEnabled?: boolean;
  /** Session toolbar presence defaults for controls with no local override. */
  sessionToolbarPresence?: SessionToolbarPresenceClientDefaults;
  /**
   * Preemptive compaction thresholds, keyed by model id, each a percent (1–99)
   * of that model's full context window. Native-capable providers receive the
   * derived token threshold; otherwise YA starts the provider's compact command
   * when an assistant turn reaches idle above the threshold. A model absent
   * from the map is off: YA sends no threshold and leaves provider defaults
   * unchanged.
   */
  compactAtContextPercent?: Record<string, number>;
  /**
   * Force YA to watch and trigger configured compaction thresholds even when a
   * provider can accept the threshold natively. Global and off when absent.
   */
  forceYaOrchestratedCompaction?: boolean;
}

/**
 * Model option for Claude sessions.
 * - "default": Use the CLI's default model
 * - "best": Use Claude Code's best available model alias
 * - "fable": Claude Fable alias
 * - "sonnet": Claude Sonnet
 * - "sonnet[1m]": Claude Sonnet with 1M context when available
 * - "opus": Claude Opus alias
 * - "opus[1m]": Claude Opus with 1M context when available
 * - "haiku": Claude Haiku
 * - "opusplan": Plan with Opus, execute with Sonnet
 */
export type ModelOption =
  | "default"
  | "best"
  | "fable"
  | "sonnet"
  | "sonnet[1m]"
  | "opus"
  | "opus[1m]"
  | "haiku"
  | "opusplan";

/**
 * The logical default selection token.
 */
export const DEFAULT_MODEL: ModelOption = "default";

/**
 * Resolve a saved model option to the explicit value sent to Claude Code.
 * Returning undefined means "use Claude Code's saved default for new sessions".
 */
export function resolveModel(
  model: ModelOption | undefined,
): string | undefined {
  return model === "default" || !model ? undefined : model;
}

/**
 * Effort level for provider response quality/reasoning depth.
 */
export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max";

/**
 * Thinking mode for the 3-way toggle.
 * - "off": Thinking disabled
 * - "auto": Model decides when to think (adaptive)
 * - "on": Always think (forced)
 */
export type ThinkingMode = "off" | "auto" | "on";

/**
 * Thinking + effort option sent from client to server.
 * Wire format (backward compatible):
 * - "off": Thinking disabled
 * - "auto": Adaptive thinking, no effort override
 * - "on:low" | "on:medium" | "on:high" | "on:xhigh" | "on:max": Forced-on thinking at effort level
 * - EffortLevel (plain): Adaptive thinking with effort (backward compat with old clients)
 */
export type ThinkingOption = "off" | "auto" | `on:${EffortLevel}` | EffortLevel;

/**
 * Whether the model is asked to return summarized thinking text.
 * - "summarized": emit a human-readable reasoning summary (Opus 4.7/4.8).
 * - "omitted": explicitly request redacted thinking with no summary text.
 */
export type ThinkingDisplay = "summarized" | "omitted";

/**
 * User-facing "Show thinking" display preference. Provider-agnostic: drives
 * the client render gate (default show/hide of thought blocks) for every
 * provider. Servers may still receive this for wire compatibility, but
 * provider summary requests are independent and default-on when thinking is
 * enabled.
 * - "default": YA/provider default render behavior.
 * - "on": show thoughts.
 * - "off": hide thoughts.
 */
export type ShowThinking = "default" | "on" | "off";

/**
 * Thinking configuration for the SDK.
 */
export type ThinkingConfig =
  | { type: "adaptive"; display?: ThinkingDisplay }
  | { type: "enabled"; budgetTokens?: number; display?: ThinkingDisplay }
  | { type: "disabled" };

/**
 * Convert thinking option to SDK thinking config + effort level.
 * On Opus 4.6+, "enabled" type is for older models and crashes the CLI.
 * Instead, "on" mode uses adaptive + explicit effort level.
 *
 * YA always requests summarized thinking text when thinking is enabled; the
 * client display toggle decides whether produced thinking rows are shown.
 * `showThinking` is retained for backwards-compatible callers but no longer
 * controls the provider request.
 */
export function thinkingOptionToConfig(
  option: ThinkingOption,
  _showThinking: ShowThinking = "default",
): {
  thinking: ThinkingConfig;
  effort?: EffortLevel;
} {
  if (option === "off") {
    return { thinking: { type: "disabled" } };
  }
  const adaptiveThinking = (): ThinkingConfig => ({
    type: "adaptive",
    display: "summarized",
  });
  if (option === "auto") {
    return { thinking: adaptiveThinking() };
  }
  // "on:high" etc. = adaptive thinking with explicit effort level
  if (option.startsWith("on:")) {
    const effort = option.slice(3) as EffortLevel;
    return { thinking: adaptiveThinking(), effort };
  }
  // Plain EffortLevel = adaptive + effort (backward compat with old clients)
  return {
    thinking: adaptiveThinking(),
    effort: option as EffortLevel,
  };
}

/**
 * Session ownership - who controls the session.
 * - "none": No active process
 * - "self": Process is running and owned by this server
 * - "external": Session is being controlled by an external program
 */
export type SessionOwnership =
  | { owner: "none" }
  | {
      owner: "self";
      processId: string;
      permissionMode?: PermissionMode;
      /** Mode applied at the latest successful provider policy boundary. */
      appliedPermissionMode?: PermissionMode;
      modeVersion?: number;
      recapAfterSeconds?: number;
    }
  | { owner: "external" };

/**
 * Metadata about a file in a project.
 */
export interface FileMetadata {
  /** File path relative to project root */
  path: string;
  /** File size in bytes */
  size: number;
  /** MIME type (e.g., "text/typescript", "image/png") */
  mimeType: string;
  /** Whether the file is a text file (can be displayed inline) */
  isText: boolean;
}

/**
 * Response from the file content API.
 */
export interface FileContentResponse {
  /** File metadata */
  metadata: FileMetadata;
  /** File content (only for text files under size limit) */
  content?: string;
  /** 1-indexed line number for the first returned content line. Defaults to 1. */
  contentStartLine?: number;
  /** 1-indexed line number for the last returned content line. */
  contentEndLine?: number;
  /** Total line count when known for a partial text response. */
  contentTotalLines?: number;
  /** Whether content is a bounded window rather than the complete file. */
  contentTruncated?: boolean;
  /** URL to fetch raw file content */
  rawUrl: string;
  /**
   * Optional media blobs embedded with this response, keyed by renderer path
   * and/or project-relative path. Markdown viewers use this to hydrate rendered
   * images without opening a separate fetch/relay connection for each image.
   */
  embeddedMedia?: Record<string, { data: string; mimeType: string }>;
  /** Syntax-highlighted HTML (when highlight=true and language is supported) */
  highlightedHtml?: string;
  /** Language used for highlighting */
  highlightedLanguage?: string;
  /** Whether the file was truncated for highlighting */
  highlightedTruncated?: boolean;
  /** Rendered Markdown HTML (for supported Markdown files when highlight=true) */
  renderedMarkdownHtml?: string;
}

/**
 * A hunk from a unified diff patch.
 * Contains line numbers and the actual diff lines with prefixes.
 */
export interface PatchHunk {
  /** Starting line number in the old file */
  oldStart: number;
  /** Number of lines from old file in this hunk */
  oldLines: number;
  /** Starting line number in the new file */
  newStart: number;
  /** Number of lines in new file in this hunk */
  newLines: number;
  /** Diff lines prefixed with ' ' (context), '-' (removed), or '+' (added) */
  lines: string[];
}

/**
 * Server-computed augment for Edit tool_use blocks.
 * Provides pre-computed structuredPatch and highlighted diff HTML
 * so the client can render consistent unified diffs.
 */
export interface EditAugment {
  /** The tool_use ID this augment is for */
  toolUseId: string;
  /** Augment type discriminator */
  type: "edit";
  /** Computed unified diff with context lines */
  structuredPatch: PatchHunk[];
  /** Syntax-highlighted diff HTML (shiki, CSS variables theme) */
  diffHtml: string;
  /** The file path being edited */
  filePath: string;
}

/**
 * Permission rules for session tool filtering.
 * Patterns like "Bash(curl *)" match tool name + glob against tool input.
 * Evaluation order: deny first, then allow, then fall through to permission mode.
 */
export interface PermissionRules {
  // Patterns to auto-approve (e.g., ["Bash(tsx */browser-cli.ts *)"])
  allow?: string[];
  // Patterns to auto-deny (e.g., ["Bash(curl *)", "Bash(*| bash*)"])
  deny?: string[];
}

/**
 * Pre-rendered markdown augment for text blocks.
 * Contains HTML with syntax highlighting from server.
 */
export interface MarkdownAugment {
  /** Pre-rendered HTML with shiki syntax highlighting */
  html: string;
}
