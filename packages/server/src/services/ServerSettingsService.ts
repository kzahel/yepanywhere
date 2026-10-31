/**
 * ServerSettingsService - Manages server-wide settings that persist across restarts
 *
 * Stores settings like:
 * - serviceWorkerEnabled: Whether clients should register the service worker
 */

import { randomUUID } from "node:crypto";
import {
  DEFAULT_INSTRUCTION_RESTORATION,
  parseInstructionRestorationSettings,
  type InstructionRestorationSettings,
} from "@yep-anywhere/shared";
import type { ArtifactViewerConfig } from "@yep-anywhere/shared";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { syncDirectory } from "../utils/syncDirectory.js";
import type {
  AgentContextHints,
  CacheMissBillingSettings,
  ClaudeAdditionalModelSelection,
  ClaudeSteerBackgroundBashSettings,
  ClientDefaults,
  CodexCyberAccessProgram,
  CodexPlanToolMode,
  CodexReasoningSummary,
  GatewayService,
  GatewayServiceExportPaths,
  HostIdentity,
  HostAwakeMode,
  LongContextEffortWarningSettings,
  NewSessionDefaults,
  PromptCacheKeepaliveSettings,
  ProjectQueueReadinessCommand,
  SessionToolbarPresenceClientDefaults,
  SubagentMaxDepth,
  ToolbarControlPresence,
} from "@yep-anywhere/shared";
import {
  DEFAULT_CACHE_MISS_BILLING_SETTINGS,
  defaultLimitedUserInstructions,
  limitedUserInstructionsError,
  upgradeUntouchedLimitedUserInstructions,
  DEFAULT_CLAUDE_STEER_BACKGROUND_BASH,
  DEFAULT_CODEX_REASONING_SUMMARY,
  DEFAULT_HOST_AWAKE_BATTERY_FLOOR_PERCENT,
  DEFAULT_CLEARLOOP_INACTIVITY_SECONDS,
  DEFAULT_PROJECT_QUEUE_QUIET_SECONDS,
  DEFAULT_SUBAGENT_MAX_DEPTH,
  clampClearloopInactivitySeconds,
  clampProjectQueueQuietSeconds,
  isIdleReapHours,
  isSubagentMaxDepth,
  normalizeIdleReapHours,
  normalizeYaClientBaseUrlFromShareViewerUrl,
  isHostAwakeBatteryFloorPercent,
  isHostAwakeMode,
  isCodexReasoningSummary,
  isCodexPlanToolMode,
  isCodexCyberAccessProgram,
  parseClaudeAdditionalModelSelections,
  parseClaudeSteerBackgroundBashSettings,
  parseGatewayServices,
  parseLongContextEffortWarningSettings,
  parseSpeechVoiceBackends,
  DEFAULT_LONG_CONTEXT_EFFORT_WARNING_SETTINGS,
} from "@yep-anywhere/shared";
import { reconcileGatewaySettings } from "./gatewayServiceSettings.js";
import type { FileAccessSettings } from "../middleware/file-access.js";
import { publishDeferredDeliverySettings } from "../supervisor/deferredDeliverySettings.js";
import {
  parseRendezSettings,
  type RendezSettings,
} from "./RendezWatchService.js";

export type { FileAccessSettings };

const CURRENT_VERSION = 2;
export const DEFAULT_SPEECH_AUDIO_RETENTION_MAX_AGE_DAYS = 56;
export const DEFAULT_SPEECH_AUDIO_RETENTION_MAX_BYTES = 400 * 1024 * 1024;
export const DEFAULT_SOURCE_REVIEW_RESPONSE_TURNS = 8;
export const MIN_SOURCE_REVIEW_RESPONSE_TURNS = 1;
export const MAX_SOURCE_REVIEW_RESPONSE_TURNS = 32;
export const MAX_CLAUDE_GATEWAY_START_COMMAND_LENGTH = 10_000;
const DEFAULT_CLIENT_DEFAULTS: ClientDefaults = {};

export interface SpeechAudioRetentionSettings {
  /** Whether YA persists server-routed speech audio and sidecar metadata. */
  enabled: boolean;
  /** Prune retained speech audio older than this many days. */
  maxAgeDays: number;
  /** Prune oldest retained speech audio when the store exceeds this many bytes. */
  maxBytes: number;
}

export const PROJECT_DIRECTORY_STORAGE_VALUES = [
  "app-data",
  "project",
] as const;
export type ProjectDirectoryStorage =
  (typeof PROJECT_DIRECTORY_STORAGE_VALUES)[number];

export const TOOL_RESULT_MEDIA_PRESERVATION_VALUES = [
  "on-demand",
  "preserve",
] as const;
export type ToolResultMediaPreservation =
  (typeof TOOL_RESULT_MEDIA_PRESERVATION_VALUES)[number];

/** Server-wide settings */
export interface ServerSettings {
  computerControl?: import("../machine-control/legacy-retirement.js").LegacyComputerSettings;
  /** Experimental issue discovery; absent means disabled, viewed scope. */
  issueAssociations?: import("@yep-anywhere/shared").IssueSettings;
  artifactViewer?: ArtifactViewerConfig;
  /** Opt-in project file delivery, independently overridable by project path. */
  rendez?: RendezSettings;
  /** Where YA writes new project-scoped state. */
  projectDirectoryStorage: ProjectDirectoryStorage;
  /** Whether new live tool-result images receive durable YA-owned copies. */
  toolResultMediaPreservation: ToolResultMediaPreservation;
  /** Whether clients should register the service worker (for push notifications) */
  serviceWorkerEnabled: boolean;
  /** Whether remote SRP resume sessions survive restarts (default: true). */
  persistRemoteSessionsToDisk: boolean;
  /** Whether the server is requesting browser clients to upload diagnostic logs */
  clientLogCollectionRequested: boolean;
  /** Whether approve/deny decisions are written to logs/approval-decisions.jsonl */
  approvalAuditLogEnabled: boolean;
  /**
   * Whether unsandboxed superuser agent sessions receive an in-memory API
   * token (AGENT_SERVER_TOKEN). Default off
   * (topics/agent-session-access.md § Operator API token).
   */
  agentServerAccessEnabled: boolean;
  /** Explicit discovery and read-only v0 access for eligible local launches. */
  agentApiEnabled: boolean;
  /** Explicit native session command authority for future eligible API launches. */
  agentApiManagementEnabled: boolean;
  /** Whether users may create public read-only share links */
  publicSharesEnabled: boolean;
  /**
   * Whether limited users exist as a second class of principal beside the
   * superuser. Default off (topics/limited-users.md § Delivery v1).
   */
  limitedUsersEnabled?: boolean;
  limitedUserInstructions?: import("@yep-anywhere/shared").LimitedUserInstructions;
  /** Whether experimental live Source Control filesystem monitoring is enabled. */
  liveWorktreeMonitoringEnabled: boolean;
  /** Whether captured source-review submissions and outcomes are enabled. */
  sourceReviewSubmissionsEnabled?: boolean;
  /** Completed assistant turns that may ingest one submission response. */
  sourceReviewResponseTurns?: number;
  /** Whether Agents may sample same-user provider processes on this host. */
  hostProcessObservabilityEnabled: boolean;
  /** Base URL for the hosted YA client; remote login/share routes are appended */
  yaClientBaseUrl?: string;
  /** Optional visual marker identifying this YA host in connected clients. */
  hostIdentity?: HostIdentity;
  /** Process-lifetime operating-system idle-sleep assertion mode. */
  hostAwakeMode: HostAwakeMode;
  /** Battery percentage at or below which YA releases its sleep assertion. */
  hostAwakeBatteryFloorPercent: number;
  /** @deprecated Use yaClientBaseUrl. Kept to migrate older settings files. */
  publicShareViewerBaseUrl?: string;
  /** SSH host aliases for ChromeOS device-bridge targets */
  chromeOsHosts?: string[];
  /** Allowed hostnames for host/origin validation. "*" = allow all, comma-separated = specific hosts. */
  allowedHosts?: string;
  /**
   * Which local path prefixes the HTTP file doors (media + project-files routes)
   * may read. Undefined = secure defaults (projects/uploads/temp on, home off,
   * no custom). Ignored when ALLOWED_FILE_PATHS/ALLOWED_IMAGE_PATHS is set.
   * See docs/tactical/018-file-access-scoping.md.
   */
  fileAccess?: FileAccessSettings;
  /** Free-form instructions appended to the system prompt for all sessions */
  globalInstructions?: string;
  /** Optional client-context hints composed additively with global instructions */
  agentContextHints?: AgentContextHints;
  /** Whether authenticated external session-wake turns are enabled by default. */
  wakeTurnsEnabled?: boolean;
  /**
   * Configured model-serving endpoints. Claude Gateway reads every enabled
   * entry; CodexOSS reads those that opt in. The default entry mirrors the
   * legacy single-gateway keys below.
   */
  gatewayServices?: GatewayService[];
  /** Which entry Claude Gateway treats as its default service. */
  defaultGatewayServiceId?: string;
  /**
   * Whether YA writes the configured services out for the provider CLIs, so
   * the same models are selectable from a plain terminal session. Default off.
   */
  gatewayServiceExportEnabled?: boolean;
  /**
   * Whether YA asks each configured endpoint which thinking efforts it accepts
   * and offers what it answers. Default on: an endpoint that can describe
   * itself should not need its levels typed in by hand. An entry stating its
   * own levels is never asked, and its levels still win.
   */
  gatewayServiceEffortDetection?: boolean;
  /**
   * Where that export writes. Reported by `GET /api/settings` so the client
   * can state exact commands; resolved from the server environment and never
   * accepted from a client.
   */
  gatewayServiceExportPaths?: GatewayServiceExportPaths;
  /** Anthropic-compatible endpoint for the isolated claude-gateway provider */
  claudeGatewayUrl?: string;
  /** Optional shell line that starts a loopback Claude Gateway on demand. */
  claudeGatewayStartCommand?: string;
  /** Whether Claude Gateway launches deny Claude Code's Agent tool. */
  claudeGatewayDisableAgent: boolean;
  /** Whether Claude Gateway launches remove Claude Code's plan-mode tools. */
  claudeGatewayDisablePlanMode: boolean;
  /** YA launch override for supported providers' native subagent nesting. */
  subagentMaxDepth: SubagentMaxDepth;
  /** Ollama server URL for claude-ollama provider (default: http://localhost:11434) */
  ollamaUrl?: string;
  /** Custom system prompt for Ollama provider (overrides the default minimal prompt) */
  ollamaSystemPrompt?: string;
  /** Whether to use the full Claude system prompt for Ollama (for large-context models like Qwen3) */
  ollamaUseFullSystemPrompt?: boolean;
  /** Whether Grok Build may receive the scrubbed ambient XAI_API_KEY. */
  grokBuildUseXaiApiKey?: boolean;
  /** Exact previous/custom Claude model ids opted into provider catalogs. */
  claudeAdditionalModels?: ClaudeAdditionalModelSelection[];
  /**
   * Claude Code launch-time override for the percentage of its own
   * auto-compaction window. Absent leaves Claude's environment unchanged.
   */
  claudeAutoCompactPercentOverride?: number;
  /** Foreground Bash commands Claude may make resumable when a steer arrives. */
  claudeSteerBackgroundBash: ClaudeSteerBackgroundBashSettings;
  /** Whether the device bridge (emulator/device streaming) feature is enabled */
  deviceBridgeEnabled?: boolean;
  /** Defaults applied when opening the new session form */
  newSessionDefaults?: NewSessionDefaults;
  /** Defaults applied by browser clients when their local value is unset. */
  clientDefaults?: ClientDefaults;
  /** Server-routed speech audio retention policy. */
  speechAudioRetention: SpeechAudioRetentionSettings;
  /**
   * Local STT backends enabled from the Speech settings UI. Unioned with
   * `YEP_VOICE_BACKENDS` at startup; the env list is copied into this array
   * when missing and never removes an already-saved backend.
   */
  speechVoiceBackends: string[];
  /** Explicit Whisper device choice; absent preserves WHISPER_DEVICE. */
  speechWhisperGpu?: boolean;
  /** Per-provider prompt-cache keepalive policy and cadence. */
  promptCacheKeepalive?: PromptCacheKeepaliveSettings;
  /**
   * After compaction settles, optionally inject a hidden continuation turn.
   * Default off. Per-provider because some harnesses already continue from
   * their own compact summary.
   */
  instructionRestoration?: InstructionRestorationSettings;
  /**
   * Warn before a mid-session effort change on a long-context session and
   * offer a fork instead. Per-provider; default on for Claude and Codex.
   */
  longContextEffortWarning?: LongContextEffortWarningSettings;
  /** Usage-accounting monitor for suspected prompt-cache billing misses. */
  cacheMissBilling?: CacheMissBillingSettings;
  /** Whether lifecycle webhook delivery is enabled */
  lifecycleWebhooksEnabled?: boolean;
  /** External webhook URL that receives lifecycle events */
  lifecycleWebhookUrl?: string;
  /** Optional bearer token used for lifecycle webhook delivery */
  lifecycleWebhookToken?: string;
  /** When true, include dryRun=true in lifecycle webhook payloads */
  lifecycleWebhookDryRun?: boolean;
  /** Reasoning-summary mode applied when Codex app-server sessions start. */
  codexReasoningSummary: CodexReasoningSummary;
  /** Stored Codex plan-tool override; absent inherits the startup fallback. */
  codexPlanToolMode?: CodexPlanToolMode;
  /**
   * Stored Codex cyber access program requested per turn; absent inherits the
   * startup fallback, which omits the field and keeps Codex's own choice.
   */
  codexCyberAccessProgram?: CodexCyberAccessProgram;
  /**
   * How the server handles Codex CLI updates:
   * - "auto": automatically run `npm install -g <pkg>@latest` when an update
   *   is available and the install was done via npm (best effort, logs only).
   * - "notify": surface a banner in the UI but do nothing automatically.
   * - "off": don't check or surface updates.
   */
  codexUpdatePolicy?: "auto" | "notify" | "off";
  /** Keep eligible local Linux Codex runtimes across YA server reloads. */
  codexReloadSafeSessions: boolean;
  /**
   * Host MCP App views (`topics/mcp-apps.md`): declare the UI extension to
   * MCP servers of newly started Codex sessions and serve their views.
   */
  mcpAppViews: boolean;
  /** Best-effort idle provider reap grace in hours; negative disables it. */
  idleReapHours?: number;
  /**
   * Max seconds between consecutive compose times for queued-while-busy turns
   * to join into one `--------`-joined provider turn at a delivery boundary.
   * 0 = never join (the vanilla default). Unset falls back to env
   * `YEP_DEFERRED_JOIN_WINDOW_S` (topics/compose-time-context-anchors.md).
   */
  deferredJoinWindowSeconds?: number;
  /**
   * Prepend `(Ns ago)` / `(Ms later)` compose-time staleness anchors to
   * delivered queued turns. Unset falls back to env `YEP_COMPOSE_ANCHORS`.
   */
  composeAnchorsEnabled?: boolean;
  /**
   * Absolute `[sent <ISO>]` compose-time markers on provider-bound user
   * turns, before or after the text. Unset falls back to env
   * `YEP_TURN_TIMESTAMPS` (topics/compose-time-context-anchors.md).
   */
  turnTimestamps?: "off" | "before" | "after";
  /**
   * Seconds the whole-project idle predicate must remain clear before Project
   * Queue promotes one item. Range 0-300, default 30.
   */
  projectQueueQuietSeconds?: number;
  /**
   * Seconds without a user send or provider progress that end one
   * `/clearloop` iteration. Range 10-3600, default 60.
   */
  clearloopInactivitySeconds?: number;
  /** Optional server-wide executable gate; null disables it. */
  projectQueueReadinessCheck?: ProjectQueueReadinessCommand | null;
}

export const CODEX_UPDATE_POLICIES = ["auto", "notify", "off"] as const;
export type CodexUpdatePolicy = (typeof CODEX_UPDATE_POLICIES)[number];

/**
 * Live worktree monitoring defaults on only where its resource profile has
 * been measured. Linux uses the perf-validated bounded native watcher set.
 * macOS stays Off after the FSEvents watcher-exhaustion incident, and Windows
 * stays Off pending platform measurement. Explicit opt-in on either platform
 * runs poll-only with no native allocation. A stored choice always wins.
 */
export function defaultLiveWorktreeMonitoringEnabled(
  platform: NodeJS.Platform = process.platform,
): boolean {
  return platform === "linux";
}

/** Default settings */
export const DEFAULT_SERVER_SETTINGS: ServerSettings = {
  projectDirectoryStorage: "app-data",
  toolResultMediaPreservation: "on-demand",
  serviceWorkerEnabled: true,
  persistRemoteSessionsToDisk: true,
  clientLogCollectionRequested: false,
  approvalAuditLogEnabled: false,
  agentServerAccessEnabled: false,
  agentApiEnabled: false,
  agentApiManagementEnabled: false,
  publicSharesEnabled: false,
  limitedUsersEnabled: false,
  limitedUserInstructions: defaultLimitedUserInstructions(),
  liveWorktreeMonitoringEnabled: defaultLiveWorktreeMonitoringEnabled(),
  sourceReviewSubmissionsEnabled: true,
  sourceReviewResponseTurns: DEFAULT_SOURCE_REVIEW_RESPONSE_TURNS,
  hostProcessObservabilityEnabled: true,
  hostAwakeMode: "off",
  hostAwakeBatteryFloorPercent: DEFAULT_HOST_AWAKE_BATTERY_FLOOR_PERCENT,
  wakeTurnsEnabled: false,
  speechAudioRetention: {
    enabled: true,
    maxAgeDays: DEFAULT_SPEECH_AUDIO_RETENTION_MAX_AGE_DAYS,
    maxBytes: DEFAULT_SPEECH_AUDIO_RETENTION_MAX_BYTES,
  },
  speechVoiceBackends: [],
  lifecycleWebhooksEnabled: false,
  lifecycleWebhookDryRun: true,
  grokBuildUseXaiApiKey: false,
  claudeGatewayDisableAgent: true,
  claudeGatewayDisablePlanMode: true,
  subagentMaxDepth: DEFAULT_SUBAGENT_MAX_DEPTH,
  codexReasoningSummary: DEFAULT_CODEX_REASONING_SUMMARY,
  codexUpdatePolicy: "notify",
  codexReloadSafeSessions: false,
  mcpAppViews: false,
  claudeSteerBackgroundBash: DEFAULT_CLAUDE_STEER_BACKGROUND_BASH,
  clientDefaults: DEFAULT_CLIENT_DEFAULTS,
  cacheMissBilling: DEFAULT_CACHE_MISS_BILLING_SETTINGS,
  projectQueueQuietSeconds: DEFAULT_PROJECT_QUEUE_QUIET_SECONDS,
  clearloopInactivitySeconds: DEFAULT_CLEARLOOP_INACTIVITY_SECONDS,
  instructionRestoration: DEFAULT_INSTRUCTION_RESTORATION,
  longContextEffortWarning: DEFAULT_LONG_CONTEXT_EFFORT_WARNING_SETTINGS,
};

const TOOLBAR_PRESENCE_TIERS = new Set(["pin", "last", "mid", "first"]);

/**
 * Fold pre-presence toolbar defaults (a visibility boolean map plus a
 * narrowing-priority map) into the single presence map: explicit `false`
 * visibility becomes `hidden`, explicit `true` becomes the stored tier when
 * one exists (else stays absent, falling to client defaults). Values already
 * in `sessionToolbarPresence` win.
 */
function migrateLegacyToolbarClientDefaults(
  loaded: ClientDefaults | undefined,
): SessionToolbarPresenceClientDefaults {
  const legacy = loaded as
    | undefined
    | (ClientDefaults & {
        sessionToolbarVisibility?: Record<string, unknown>;
        sessionToolbarPriority?: Record<string, unknown>;
      });
  const presence: Record<string, ToolbarControlPresence> = {};
  const priority = legacy?.sessionToolbarPriority;
  if (priority) {
    for (const [key, value] of Object.entries(priority)) {
      if (typeof value === "string" && TOOLBAR_PRESENCE_TIERS.has(value)) {
        presence[key] = value as ToolbarControlPresence;
      }
    }
  }
  const visibility = legacy?.sessionToolbarVisibility;
  if (visibility) {
    for (const [key, value] of Object.entries(visibility)) {
      if (value === false) presence[key] = "hidden";
    }
  }
  return {
    ...presence,
    ...loaded?.sessionToolbarPresence,
  } as SessionToolbarPresenceClientDefaults;
}

function mergeLoadedClientDefaults(
  loaded: ClientDefaults | undefined,
): ClientDefaults | undefined {
  const merged: ClientDefaults = {
    ...DEFAULT_CLIENT_DEFAULTS,
    ...loaded,
  };
  delete (merged as Record<string, unknown>).sessionToolbarVisibility;
  delete (merged as Record<string, unknown>).sessionToolbarPriority;
  const speech = {
    ...DEFAULT_CLIENT_DEFAULTS.speech,
    ...loaded?.speech,
  };
  const sessionToolbarPresence = migrateLegacyToolbarClientDefaults(loaded);

  if (Object.keys(speech).length > 0) {
    merged.speech = speech;
  } else {
    delete merged.speech;
  }
  if (Object.keys(sessionToolbarPresence).length > 0) {
    merged.sessionToolbarPresence = sessionToolbarPresence;
  } else {
    delete merged.sessionToolbarPresence;
  }

  // Per-model compaction thresholds: keep only valid in-range percents (1–99);
  // anything else (including >= 100 = "off") is dropped per model, and an empty
  // map is removed so "off everywhere" stays canonically absent.
  const compactByModel = merged.compactAtContextPercent;
  if (compactByModel && typeof compactByModel === "object") {
    const cleaned: Record<string, number> = {};
    for (const [modelId, pct] of Object.entries(compactByModel)) {
      if (
        typeof pct === "number" &&
        Number.isFinite(pct) &&
        pct > 0 &&
        pct < 100
      ) {
        cleaned[modelId] = Math.round(pct);
      }
    }
    if (Object.keys(cleaned).length > 0) {
      merged.compactAtContextPercent = cleaned;
    } else {
      delete merged.compactAtContextPercent;
    }
  } else {
    delete merged.compactAtContextPercent;
  }
  if (typeof merged.forceYaOrchestratedCompaction !== "boolean") {
    delete merged.forceYaOrchestratedCompaction;
  }

  return Object.keys(merged).length > 0 ? merged : undefined;
}

function normalizeLoadedSettings(settings: ServerSettings): ServerSettings {
  const normalized = { ...DEFAULT_SERVER_SETTINGS, ...settings };
  if (settings.rendez !== undefined) {
    normalized.rendez = parseRendezSettings(settings.rendez);
  }
  normalized.projectDirectoryStorage =
    settings.projectDirectoryStorage === "project"
      ? "project"
      : DEFAULT_SERVER_SETTINGS.projectDirectoryStorage;
  normalized.toolResultMediaPreservation =
    settings.toolResultMediaPreservation === "preserve"
      ? "preserve"
      : DEFAULT_SERVER_SETTINGS.toolResultMediaPreservation;
  // An invalid saved policy is left for the launch-time check to refuse.
  if (
    settings.limitedUserInstructions &&
    !limitedUserInstructionsError(settings.limitedUserInstructions)
  ) {
    normalized.limitedUserInstructions =
      upgradeUntouchedLimitedUserInstructions(settings.limitedUserInstructions);
  }
  normalized.hostProcessObservabilityEnabled =
    typeof settings.hostProcessObservabilityEnabled === "boolean"
      ? settings.hostProcessObservabilityEnabled
      : DEFAULT_SERVER_SETTINGS.hostProcessObservabilityEnabled;
  normalized.codexReasoningSummary = isCodexReasoningSummary(
    settings.codexReasoningSummary,
  )
    ? settings.codexReasoningSummary
    : DEFAULT_CODEX_REASONING_SUMMARY;
  normalized.codexPlanToolMode = isCodexPlanToolMode(settings.codexPlanToolMode)
    ? settings.codexPlanToolMode
    : undefined;
  normalized.codexCyberAccessProgram = isCodexCyberAccessProgram(
    settings.codexCyberAccessProgram,
  )
    ? settings.codexCyberAccessProgram
    : undefined;
  normalized.codexReloadSafeSessions =
    typeof settings.codexReloadSafeSessions === "boolean"
      ? settings.codexReloadSafeSessions
      : DEFAULT_SERVER_SETTINGS.codexReloadSafeSessions;
  normalized.mcpAppViews =
    typeof settings.mcpAppViews === "boolean"
      ? settings.mcpAppViews
      : DEFAULT_SERVER_SETTINGS.mcpAppViews;
  normalized.idleReapHours = isIdleReapHours(settings.idleReapHours)
    ? normalizeIdleReapHours(settings.idleReapHours)
    : undefined;
  normalized.hostAwakeMode = isHostAwakeMode(settings.hostAwakeMode)
    ? settings.hostAwakeMode
    : DEFAULT_SERVER_SETTINGS.hostAwakeMode;
  normalized.hostAwakeBatteryFloorPercent = isHostAwakeBatteryFloorPercent(
    settings.hostAwakeBatteryFloorPercent,
  )
    ? settings.hostAwakeBatteryFloorPercent
    : DEFAULT_SERVER_SETTINGS.hostAwakeBatteryFloorPercent;
  normalized.clientDefaults = mergeLoadedClientDefaults(
    settings.clientDefaults,
  );
  normalized.speechVoiceBackends =
    parseSpeechVoiceBackends(settings.speechVoiceBackends) ??
    DEFAULT_SERVER_SETTINGS.speechVoiceBackends;
  normalized.speechWhisperGpu =
    typeof settings.speechWhisperGpu === "boolean"
      ? settings.speechWhisperGpu
      : undefined;
  normalized.claudeAdditionalModels =
    parseClaudeAdditionalModelSelections(settings.claudeAdditionalModels) ??
    undefined;
  normalized.claudeAutoCompactPercentOverride =
    typeof settings.claudeAutoCompactPercentOverride === "number" &&
    Number.isInteger(settings.claudeAutoCompactPercentOverride) &&
    settings.claudeAutoCompactPercentOverride >= 1 &&
    settings.claudeAutoCompactPercentOverride <= 100
      ? settings.claudeAutoCompactPercentOverride
      : undefined;
  normalized.claudeSteerBackgroundBash =
    settings.claudeSteerBackgroundBash === undefined
      ? DEFAULT_CLAUDE_STEER_BACKGROUND_BASH
      : (parseClaudeSteerBackgroundBashSettings(
          settings.claudeSteerBackgroundBash,
        ) ?? { allowRegex: "", denyRegex: "" });
  const gatewayStartCommand = settings.claudeGatewayStartCommand;
  normalized.claudeGatewayStartCommand =
    typeof gatewayStartCommand === "string" &&
    gatewayStartCommand.length <= MAX_CLAUDE_GATEWAY_START_COMMAND_LENGTH &&
    !gatewayStartCommand.includes("\0") &&
    gatewayStartCommand.trim()
      ? gatewayStartCommand.trim()
      : undefined;
  // The services list and the legacy single-gateway keys are two views of the
  // same configuration; keep them in agreement on every load.
  const reconciledGateways = reconcileGatewaySettings(
    parseGatewayServices(settings.gatewayServices) ?? [],
    typeof settings.defaultGatewayServiceId === "string"
      ? settings.defaultGatewayServiceId
      : undefined,
    {
      ...(settings.claudeGatewayUrl
        ? { claudeGatewayUrl: settings.claudeGatewayUrl }
        : {}),
      ...(normalized.claudeGatewayStartCommand
        ? { claudeGatewayStartCommand: normalized.claudeGatewayStartCommand }
        : {}),
    },
  );
  normalized.gatewayServices = reconciledGateways.services;
  normalized.defaultGatewayServiceId = reconciledGateways.defaultServiceId;
  normalized.claudeGatewayUrl = reconciledGateways.claudeGatewayUrl;
  normalized.claudeGatewayStartCommand =
    reconciledGateways.claudeGatewayStartCommand;
  normalized.claudeGatewayDisableAgent =
    typeof settings.claudeGatewayDisableAgent === "boolean"
      ? settings.claudeGatewayDisableAgent
      : DEFAULT_SERVER_SETTINGS.claudeGatewayDisableAgent;
  normalized.claudeGatewayDisablePlanMode =
    typeof settings.claudeGatewayDisablePlanMode === "boolean"
      ? settings.claudeGatewayDisablePlanMode
      : DEFAULT_SERVER_SETTINGS.claudeGatewayDisablePlanMode;
  normalized.subagentMaxDepth = isSubagentMaxDepth(settings.subagentMaxDepth)
    ? settings.subagentMaxDepth
    : DEFAULT_SUBAGENT_MAX_DEPTH;
  if (!normalized.yaClientBaseUrl && normalized.publicShareViewerBaseUrl) {
    try {
      normalized.yaClientBaseUrl = normalizeYaClientBaseUrlFromShareViewerUrl(
        normalized.publicShareViewerBaseUrl,
      );
      delete normalized.publicShareViewerBaseUrl;
    } catch {
      // Leave invalid legacy values for the status endpoint to report clearly.
    }
  }
  normalized.cacheMissBilling = {
    ...DEFAULT_CACHE_MISS_BILLING_SETTINGS,
    ...settings.cacheMissBilling,
    providerFreshWindowMinutes: {
      ...DEFAULT_CACHE_MISS_BILLING_SETTINGS.providerFreshWindowMinutes,
      ...settings.cacheMissBilling?.providerFreshWindowMinutes,
    },
  };
  normalized.projectQueueQuietSeconds =
    clampProjectQueueQuietSeconds(settings.projectQueueQuietSeconds) ??
    DEFAULT_PROJECT_QUEUE_QUIET_SECONDS;
  normalized.clearloopInactivitySeconds =
    clampClearloopInactivitySeconds(settings.clearloopInactivitySeconds) ??
    DEFAULT_CLEARLOOP_INACTIVITY_SECONDS;
  normalized.sourceReviewSubmissionsEnabled =
    typeof settings.sourceReviewSubmissionsEnabled === "boolean"
      ? settings.sourceReviewSubmissionsEnabled
      : DEFAULT_SERVER_SETTINGS.sourceReviewSubmissionsEnabled;
  normalized.liveWorktreeMonitoringEnabled =
    typeof settings.liveWorktreeMonitoringEnabled === "boolean"
      ? settings.liveWorktreeMonitoringEnabled
      : DEFAULT_SERVER_SETTINGS.liveWorktreeMonitoringEnabled;
  normalized.sourceReviewResponseTurns =
    typeof settings.sourceReviewResponseTurns === "number" &&
    Number.isInteger(settings.sourceReviewResponseTurns) &&
    settings.sourceReviewResponseTurns >= MIN_SOURCE_REVIEW_RESPONSE_TURNS &&
    settings.sourceReviewResponseTurns <= MAX_SOURCE_REVIEW_RESPONSE_TURNS
      ? settings.sourceReviewResponseTurns
      : DEFAULT_SOURCE_REVIEW_RESPONSE_TURNS;
  normalized.wakeTurnsEnabled =
    typeof settings.wakeTurnsEnabled === "boolean"
      ? settings.wakeTurnsEnabled
      : DEFAULT_SERVER_SETTINGS.wakeTurnsEnabled;
  delete (normalized as unknown as Record<string, unknown>)
    .heartbeatTurnsAfterMinutes;
  delete (normalized as unknown as Record<string, unknown>).heartbeatTurnText;
  delete (normalized as unknown as Record<string, unknown>).helperTargets;
  // Retired policy: omit saved enablement from responses and future writes.
  delete (normalized as unknown as Record<string, unknown>).postCompactReplay;
  normalized.instructionRestoration =
    parseInstructionRestorationSettings(settings.instructionRestoration) ??
    DEFAULT_INSTRUCTION_RESTORATION;
  normalized.longContextEffortWarning =
    parseLongContextEffortWarningSettings(settings.longContextEffortWarning) ??
    DEFAULT_LONG_CONTEXT_EFFORT_WARNING_SETTINGS;
  return normalized;
}

/** Stored state with version for migrations */
interface SettingsState {
  version: number;
  settings: ServerSettings;
}

export interface ServerSettingsServiceOptions {
  dataDir: string;
  logger?: Pick<Console, "error">;
}

export type ServerSettingsChangeListener = (
  settings: Readonly<ServerSettings>,
  previousSettings: Readonly<ServerSettings>,
) => void;

/** The file was replaced, but its directory durability could not be confirmed. */
export class CommittedSettingsSaveError extends Error {
  constructor(
    readonly settings: ServerSettings,
    cause: unknown,
  ) {
    super("Settings were saved, but crash durability could not be confirmed", {
      cause,
    });
  }
}

export class ServerSettingsService {
  private state: SettingsState;
  private dataDir: string;
  private filePath: string;
  private initialized = false;
  private updateTail: Promise<void> = Promise.resolve();
  private readonly changeListeners = new Set<ServerSettingsChangeListener>();
  private readonly logger: Pick<Console, "error">;

  constructor(options: ServerSettingsServiceOptions) {
    this.dataDir = options.dataDir;
    this.filePath = path.join(this.dataDir, "server-settings.json");
    this.logger = options.logger ?? console;
    this.state = {
      version: CURRENT_VERSION,
      settings: DEFAULT_SERVER_SETTINGS,
    };
  }

  /**
   * Initialize the service by loading state from disk.
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    try {
      await fs.mkdir(this.dataDir, { recursive: true });

      const content = await fs.readFile(this.filePath, "utf-8");
      const parsed = JSON.parse(content) as SettingsState;

      if (parsed.version === CURRENT_VERSION) {
        // Merge with defaults in case new settings were added
        this.state = {
          version: CURRENT_VERSION,
          settings: normalizeLoadedSettings(parsed.settings),
        };
      } else {
        // Future: handle migrations
        this.state = {
          version: CURRENT_VERSION,
          settings: normalizeLoadedSettings(parsed.settings),
        };
        await this.doSave(this.state);
      }
    } catch (error) {
      if (error instanceof CommittedSettingsSaveError) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn(
          "[ServerSettingsService] Failed to load settings, using defaults:",
          error,
        );
      }
      this.state = {
        version: CURRENT_VERSION,
        settings: DEFAULT_SERVER_SETTINGS,
      };
    }

    this.initialized = true;
    this.publishDeferredDelivery();
  }

  /** Push deferred-delivery settings to the supervisor's live bridge. */
  private publishDeferredDelivery(): void {
    publishDeferredDeliverySettings({
      deferredJoinWindowSeconds: this.state.settings.deferredJoinWindowSeconds,
      composeAnchorsEnabled: this.state.settings.composeAnchorsEnabled,
      turnTimestamps: this.state.settings.turnTimestamps,
    });
  }

  /**
   * Get all settings.
   */
  getSettings(): ServerSettings {
    this.ensureInitialized();
    return { ...this.state.settings };
  }

  /**
   * Get a specific setting.
   */
  getSetting<K extends keyof ServerSettings>(key: K): ServerSettings[K] {
    this.ensureInitialized();
    return this.state.settings[key];
  }

  /**
   * Observe live settings changes for process-local resources whose lifetime
   * follows a setting.
   */
  onSettingsChanged(listener: ServerSettingsChangeListener): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  /**
   * Update settings.
   */
  updateSettings(updates: Partial<ServerSettings>): Promise<ServerSettings> {
    this.ensureInitialized();
    const operation = this.updateTail.then(async () => {
      const previousSettings = this.state.settings;
      const merged: ServerSettings = {
        ...previousSettings,
        ...updates,
      };
      // The services list and the legacy single-gateway keys are two views of
      // one configuration, so an edit to either has to settle both before the
      // save — the runtime reads this result, not the reloaded file.
      const reconciledGateways = reconcileGatewaySettings(
        merged.gatewayServices ?? [],
        merged.defaultGatewayServiceId,
        {
          ...(merged.claudeGatewayUrl
            ? { claudeGatewayUrl: merged.claudeGatewayUrl }
            : {}),
          ...(merged.claudeGatewayStartCommand
            ? { claudeGatewayStartCommand: merged.claudeGatewayStartCommand }
            : {}),
        },
        {
          legacyUrlEdited: "claudeGatewayUrl" in updates,
          legacyCommandEdited: "claudeGatewayStartCommand" in updates,
        },
      );
      const nextState: SettingsState = {
        version: CURRENT_VERSION,
        settings: {
          ...merged,
          gatewayServices: reconciledGateways.services,
          defaultGatewayServiceId: reconciledGateways.defaultServiceId,
          claudeGatewayUrl: reconciledGateways.claudeGatewayUrl,
          claudeGatewayStartCommand:
            reconciledGateways.claudeGatewayStartCommand,
        },
      };
      let durabilityError: CommittedSettingsSaveError | undefined;
      try {
        await this.doSave(nextState);
      } catch (error) {
        if (!(error instanceof CommittedSettingsSaveError)) throw error;
        durabilityError = error;
      }
      this.state = nextState;

      const settings = { ...nextState.settings };
      const previous = { ...previousSettings };
      for (const listener of this.changeListeners) {
        listener(settings, previous);
      }
      this.publishDeferredDelivery();
      if (durabilityError) throw durabilityError;
      return settings;
    });
    this.updateTail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  /**
   * Ensure service is initialized.
   */
  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new Error(
        "ServerSettingsService not initialized. Call initialize() first.",
      );
    }
  }

  private async doSave(state: SettingsState): Promise<void> {
    const temporaryPath = `${this.filePath}.${randomUUID()}.tmp`;
    let published = false;
    try {
      const file = await fs.open(temporaryPath, "wx", 0o600);
      try {
        await file.writeFile(`${JSON.stringify(state, null, 2)}\n`, "utf-8");
        await file.sync();
      } finally {
        await file.close();
      }
      await fs.rename(temporaryPath, this.filePath);
      published = true;
      await syncDirectory(this.dataDir);
    } catch (error) {
      this.logger.error(
        "[ServerSettingsService] Failed to save settings:",
        error,
      );
      if (published) {
        throw new CommittedSettingsSaveError({ ...state.settings }, error);
      }
      throw error;
    } finally {
      if (!published) {
        await fs.unlink(temporaryPath).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
        });
      }
    }
  }
}
