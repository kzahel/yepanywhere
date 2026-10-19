import {
  ALL_PERMISSION_MODES,
  ALL_PROVIDERS,
  type AgentContextHints,
  type BusyComposerDefaultAction,
  type CacheMissBillingSettings,
  type ClientDefaults,
  type CollapsedComposerButtonPreference,
  type EffortLevel,
  type GrokSpeechAudioClientDefault,
  HELPER_SIDE_MODEL_CHEAPEST,
  HELPER_SIDE_MODEL_SAME_AS_MAIN,
  type HelperTargetConfig,
  type HostIdentity,
  type ModelInfo,
  type NewSessionDefaults,
  type PermissionMode,
  DEFAULT_CACHE_MISS_BILLING_SETTINGS,
  PROMPT_CACHE_KEEPALIVE_MODES,
  PROMPT_SUGGESTION_MODES,
  type PromptCacheKeepaliveMode,
  type PromptCacheKeepaliveSettings,
  type PromptSuggestionMode,
  type ProviderName,
  type ProviderSessionDefaults,
  RECAP_MODES,
  type RecapMode,
  clampRecapAfterSeconds,
  type SessionToolbarPresenceClientDefaults,
  type SpeechSmartTurnClientDefault,
  type ThinkingMode,
  type ToolbarControlPresence,
  normalizeHostIdentityIcon,
} from "@yep-anywhere/shared";
import {
  type FileAccessSettings,
  normalizeFileAccess,
} from "../middleware/file-access.js";
import type { SpeechAudioRetentionSettings } from "../services/ServerSettingsService.js";
import {
  DEFAULT_SERVER_SETTINGS,
  DEFAULT_SPEECH_AUDIO_RETENTION_MAX_AGE_DAYS,
  DEFAULT_SPEECH_AUDIO_RETENTION_MAX_BYTES,
  MAX_CLAUDE_GATEWAY_START_COMMAND_LENGTH,
} from "../services/ServerSettingsService.js";
import {
  isValidSshHostAlias,
  normalizeSshHostAlias,
} from "../utils/sshHostAlias.js";

const HELPER_TARGET_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const MAX_HELPER_TARGETS = 20;
const HELPER_TARGET_MODEL_DISCOVERY_TIMEOUT_MS = 5000;
const SESSION_TOOLBAR_PRESENCE_CLIENT_DEFAULT_KEYS = [
  "modeSelector",
  "steerNow",
  "attachments",
  "slashMenu",
  "thinkingToggle",
  "renderMode",
  "microphone",
  "waveform",
  "shortcutsHelp",
  "contextUsage",
  "btw",
  "nudge",
  "sessionStatus",
  "projectQueue",
  "projectQueueNewSessionShortcut",
  "syntheticDone",
  "topicShift",
  "composerRecall",
] as const satisfies readonly (keyof SessionToolbarPresenceClientDefaults)[];
const TOOLBAR_CONTROL_PRESENCES = [
  "off",
  "hidden",
  "pin",
  "last",
  "mid",
  "first",
] as const satisfies readonly ToolbarControlPresence[];
const CLIENT_DEFAULT_KEYS = [
  "speech",
  "bangCommandsEnabled",
  "busyComposerDefaultAction",
  "collapsedComposerButton",
  "sessionToolbarPresence",
  "steerNowDefault",
  "patientQueueDefault",
  "patientQueueCompactAtPercent",
  "topicShiftCompactAtPercent",
  "projectQueueCtrlEnterEnabled",
  "compactAtContextPercent",
  "forceYaOrchestratedCompaction",
] as const;
const BUSY_COMPOSER_DEFAULT_ACTIONS = [
  "steer",
  "queue",
] as const satisfies readonly BusyComposerDefaultAction[];
const COLLAPSED_COMPOSER_BUTTON_PREFERENCES = [
  "primary",
  "alternate",
  "microphone",
] as const satisfies readonly CollapsedComposerButtonPreference[];
const SPEECH_CLIENT_DEFAULT_KEYS = [
  "voiceInputEnabled",
  "speechMethod",
  "speechSmartTurnSettings",
  "grokSpeechAudioSettings",
] as const;
const THINKING_MODES = [
  "off",
  "auto",
  "on",
] as const satisfies readonly ThinkingMode[];
const EFFORT_LEVELS = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const satisfies readonly EffortLevel[];
const MAX_SPEECH_SMART_TURN_TIMEOUT_MS = 10000;
const MAX_SPEECH_SMART_TURN_GRACE_MS = 1500;

export function parseHostAliasList(rawHosts: unknown[]): {
  hosts: string[];
  invalidHost?: string;
} {
  const hosts: string[] = [];

  for (const rawHost of rawHosts) {
    if (typeof rawHost !== "string") continue;

    const host = normalizeSshHostAlias(rawHost);
    if (!host) continue;
    if (!isValidSshHostAlias(host)) {
      return { hosts: [], invalidHost: host };
    }

    hosts.push(host);
  }

  return { hosts };
}

export function normalizeOpenAiCompatibleBaseUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
    ? trimmed
    : `http://${trimmed}`;

  try {
    const url = new URL(withScheme);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.pathname === "" || url.pathname === "/") {
      url.pathname = "/v1";
    }

    const normalized = url.toString();
    return normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
  } catch {
    return null;
  }
}

export function normalizeClaudeGatewayUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 2000) return null;

  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.username || url.password || url.search || url.hash) return null;

    const normalized = url.toString();
    return normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
  } catch {
    return null;
  }
}

export function parseClaudeGatewayStartCommand(
  raw: unknown,
): string | undefined | null {
  if (raw === undefined || raw === null || raw === "") return undefined;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  if (
    trimmed.length > MAX_CLAUDE_GATEWAY_START_COMMAND_LENGTH ||
    trimmed.includes("\0")
  ) {
    return null;
  }
  return trimmed;
}

export function parseClaudeAutoCompactPercentOverride(
  raw: unknown,
): number | undefined | null {
  if (raw === undefined || raw === null || raw === "" || raw === 0) {
    return undefined;
  }
  if (
    typeof raw !== "number" ||
    !Number.isInteger(raw) ||
    raw < 1 ||
    raw > 100
  ) {
    return null;
  }
  return raw;
}

/**
 * Returns:
 * - `null` when the payload is invalid
 * - `undefined` when the setting should be cleared
 * - an array when valid helper targets should be saved
 */
export function parseHelperTargets(
  raw: unknown,
): HelperTargetConfig[] | undefined | null {
  if (raw === undefined) return null;
  if (raw === null || raw === "") return undefined;
  if (!Array.isArray(raw) || raw.length > MAX_HELPER_TARGETS) return null;

  const seenIds = new Set<string>();
  const parsed: HelperTargetConfig[] = [];

  for (const entry of raw) {
    if (!entry || typeof entry !== "object") return null;
    const input = entry as Record<string, unknown>;
    const id = typeof input.id === "string" ? input.id.trim() : "";
    const name = typeof input.name === "string" ? input.name.trim() : "";
    const baseUrl = normalizeOpenAiCompatibleBaseUrl(input.baseUrl);
    const model = typeof input.model === "string" ? input.model.trim() : "";

    if (
      !HELPER_TARGET_ID_PATTERN.test(id) ||
      seenIds.has(id) ||
      !name ||
      name.length > 80 ||
      input.kind !== "openai-compatible" ||
      !baseUrl ||
      model.length > 200
    ) {
      return null;
    }

    seenIds.add(id);
    parsed.push({
      id,
      name,
      kind: "openai-compatible",
      baseUrl,
      ...(model ? { model } : {}),
    });
  }

  return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseOptionalString(
  value: unknown,
  maxLength: number,
): string | undefined | null {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") return null;
  return value.length > 0 ? value.slice(0, maxLength) : undefined;
}

const MAX_MODEL_EFFORT_LEVELS = 100;

/** Model id → effort map; an empty map clears the setting. */
function parseModelEffortLevels(
  raw: unknown,
): Record<string, EffortLevel> | undefined | null {
  if (raw === undefined || raw === null || raw === "") return undefined;
  if (!isRecord(raw) || Array.isArray(raw)) return null;
  const entries = Object.entries(raw);
  if (entries.length > MAX_MODEL_EFFORT_LEVELS) return null;
  const parsed: Record<string, EffortLevel> = {};
  for (const [modelId, level] of entries) {
    if (modelId.length === 0 || modelId.length > 200) return null;
    if (!EFFORT_LEVELS.includes(level as EffortLevel)) return null;
    parsed[modelId] = level as EffortLevel;
  }
  return entries.length > 0 ? parsed : undefined;
}

function parseProviderSessionDefaults(
  raw: unknown,
): ProviderSessionDefaults | undefined | null {
  if (raw === undefined || raw === null || raw === "") return undefined;
  if (!isRecord(raw)) return null;

  const parsed: ProviderSessionDefaults = {};
  if ("model" in raw) {
    const model = parseOptionalString(raw.model, 200);
    if (model === null) return null;
    if (model) parsed.model = model;
  }
  if ("serviceTier" in raw) {
    const serviceTier = parseOptionalString(raw.serviceTier, 64);
    if (serviceTier === null) return null;
    if (serviceTier) parsed.serviceTier = serviceTier;
  }
  for (const key of [
    "routerPoolId",
    "routerAccountId",
    "routerPolicy",
  ] as const) {
    const value = parseOptionalString(
      raw[key],
      key === "routerPolicy" ? 64 : 200,
    );
    if (value === null) return null;
    if (value) parsed[key] = value;
  }
  if (!parsed.routerPoolId) {
    delete parsed.routerAccountId;
    delete parsed.routerPolicy;
  }
  if ("thinkingMode" in raw) {
    if (
      raw.thinkingMode !== undefined &&
      raw.thinkingMode !== null &&
      raw.thinkingMode !== "" &&
      !THINKING_MODES.includes(raw.thinkingMode as ThinkingMode)
    ) {
      return null;
    }
    if (typeof raw.thinkingMode === "string" && raw.thinkingMode.length > 0) {
      parsed.thinkingMode = raw.thinkingMode as ThinkingMode;
    }
  }
  if ("effortLevel" in raw) {
    if (
      raw.effortLevel !== undefined &&
      raw.effortLevel !== null &&
      raw.effortLevel !== "" &&
      !EFFORT_LEVELS.includes(raw.effortLevel as EffortLevel)
    ) {
      return null;
    }
    if (typeof raw.effortLevel === "string" && raw.effortLevel.length > 0) {
      parsed.effortLevel = raw.effortLevel as EffortLevel;
    }
  }
  if ("modelEffortLevels" in raw) {
    const modelEffortLevels = parseModelEffortLevels(raw.modelEffortLevels);
    if (modelEffortLevels === null) return null;
    if (modelEffortLevels) parsed.modelEffortLevels = modelEffortLevels;
  }
  if ("helperSideModel" in raw) {
    const helperSideModel = parseOptionalString(raw.helperSideModel, 200);
    if (helperSideModel === null) return null;
    if (helperSideModel) {
      parsed.helperSideModel =
        helperSideModel === HELPER_SIDE_MODEL_SAME_AS_MAIN
          ? HELPER_SIDE_MODEL_SAME_AS_MAIN
          : helperSideModel === HELPER_SIDE_MODEL_CHEAPEST
            ? HELPER_SIDE_MODEL_CHEAPEST
            : helperSideModel;
    }
  }

  return Object.keys(parsed).length > 0 ? parsed : undefined;
}

const MAX_FILE_ACCESS_CUSTOM_ENTRIES = 100;
const MAX_FILE_ACCESS_CUSTOM_LENGTH = 1024;

/**
 * Returns:
 * - `null` when the payload is invalid
 * - `undefined` when the setting should be cleared (reset to secure defaults)
 * - a normalized object when valid
 */
export function parseFileAccess(
  raw: unknown,
): FileAccessSettings | undefined | null {
  if (raw === undefined) return null;
  if (raw === null || raw === "") return undefined;
  if (!isRecord(raw)) return null;

  const allowedKeys = new Set([
    "projects",
    "uploads",
    "temp",
    "home",
    "custom",
  ]);
  for (const key of Object.keys(raw)) {
    if (!allowedKeys.has(key)) return null;
  }
  for (const key of ["projects", "uploads", "temp", "home"] as const) {
    if (key in raw && typeof raw[key] !== "boolean") return null;
  }
  if ("custom" in raw) {
    if (
      !Array.isArray(raw.custom) ||
      raw.custom.length > MAX_FILE_ACCESS_CUSTOM_ENTRIES
    ) {
      return null;
    }
    for (const entry of raw.custom) {
      if (
        typeof entry !== "string" ||
        entry.length > MAX_FILE_ACCESS_CUSTOM_LENGTH
      ) {
        return null;
      }
    }
  }

  return normalizeFileAccess({
    projects: raw.projects as boolean | undefined,
    uploads: raw.uploads as boolean | undefined,
    temp: raw.temp as boolean | undefined,
    home: raw.home as boolean | undefined,
    custom: (raw.custom as string[] | undefined) ?? [],
  });
}

function parseOpenAiModelsResponse(raw: unknown): ModelInfo[] | null {
  if (!isRecord(raw) || !Array.isArray(raw.data)) return null;

  const models: ModelInfo[] = [];
  for (const entry of raw.data) {
    if (!isRecord(entry) || typeof entry.id !== "string" || !entry.id.trim()) {
      continue;
    }
    const metadata = isRecord(entry.metadata) ? entry.metadata : undefined;
    const rawContextWindow =
      typeof entry.max_model_len === "number"
        ? entry.max_model_len
        : typeof entry.maxModelLen === "number"
          ? entry.maxModelLen
          : typeof metadata?.max_model_len === "number"
            ? metadata.max_model_len
            : undefined;
    const contextWindow =
      rawContextWindow !== undefined && Number.isFinite(rawContextWindow)
        ? rawContextWindow
        : undefined;

    models.push({
      id: entry.id,
      name: entry.id,
      ...(contextWindow ? { contextWindow } : {}),
    });
  }

  return models;
}

export function parseAgentContextHints(
  raw: unknown,
  current: AgentContextHints | undefined,
): AgentContextHints | null {
  if (raw === undefined || raw === null) return {};
  if (!isRecord(raw)) return null;

  const parsed: AgentContextHints = { ...current };
  if ("latexMathRendering" in raw) {
    if (typeof raw.latexMathRendering !== "boolean") return null;
    parsed.latexMathRendering = raw.latexMathRendering;
  }

  return parsed;
}

export function parseHostIdentity(
  raw: unknown,
): HostIdentity | undefined | null {
  if (raw === null || raw === "") return undefined;
  if (!isRecord(raw)) return null;
  for (const key of Object.keys(raw)) {
    if (key !== "icon") return null;
  }
  if (raw.icon === undefined || raw.icon === null || raw.icon === "") {
    return undefined;
  }
  const icon = normalizeHostIdentityIcon(raw.icon);
  return icon ? { icon } : null;
}

export async function discoverOpenAiCompatibleModels(
  baseUrl: string,
): Promise<ModelInfo[] | null> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    HELPER_TARGET_MODEL_DISCOVERY_TIMEOUT_MS,
  );

  try {
    const response = await fetch(`${baseUrl}/models`, {
      signal: controller.signal,
    });
    if (!response.ok) return null;
    return parseOpenAiModelsResponse(await response.json());
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Returns:
 * - `null` when the payload is invalid
 * - `undefined` when the setting should be cleared
 * - an object when valid defaults should be saved
 */
export function parseNewSessionDefaults(
  raw: unknown,
): NewSessionDefaults | undefined | null {
  if (raw === undefined) return null;
  if (raw === null || raw === "") return undefined;
  if (typeof raw !== "object") return null;

  const input = raw as Record<string, unknown>;
  const parsed: NewSessionDefaults = {};

  if ("provider" in input) {
    if (
      input.provider !== undefined &&
      input.provider !== null &&
      input.provider !== "" &&
      !ALL_PROVIDERS.includes(input.provider as ProviderName)
    ) {
      return null;
    }
    if (typeof input.provider === "string" && input.provider.length > 0) {
      parsed.provider = input.provider as ProviderName;
    }
  }

  if ("model" in input) {
    const model = parseOptionalString(input.model, 200);
    if (model === null) return null;
    if (model) parsed.model = model;
  }

  if ("serviceTier" in input) {
    const serviceTier = parseOptionalString(input.serviceTier, 64);
    if (serviceTier === null) return null;
    if (serviceTier) parsed.serviceTier = serviceTier;
  }

  if ("permissionMode" in input) {
    if (
      input.permissionMode !== undefined &&
      input.permissionMode !== null &&
      input.permissionMode !== "" &&
      !ALL_PERMISSION_MODES.includes(input.permissionMode as PermissionMode)
    ) {
      return null;
    }
    if (
      typeof input.permissionMode === "string" &&
      input.permissionMode.length > 0
    ) {
      parsed.permissionMode = input.permissionMode as PermissionMode;
    }
  }

  if ("sandboxLevel" in input) {
    if (
      input.sandboxLevel !== undefined &&
      input.sandboxLevel !== null &&
      input.sandboxLevel !== "" &&
      input.sandboxLevel !== "none" &&
      input.sandboxLevel !== "project-write"
    ) {
      return null;
    }
    if (
      input.sandboxLevel === "none" ||
      input.sandboxLevel === "project-write"
    ) {
      parsed.sandboxLevel = input.sandboxLevel;
    }
  }

  if ("sandboxNetworkFirewall" in input) {
    if (
      input.sandboxNetworkFirewall !== undefined &&
      input.sandboxNetworkFirewall !== null &&
      typeof input.sandboxNetworkFirewall !== "boolean"
    ) {
      return null;
    }
    if (
      input.sandboxNetworkFirewall === true &&
      parsed.sandboxLevel !== "project-write"
    ) {
      return null;
    }
    if (
      parsed.sandboxLevel === "project-write" &&
      typeof input.sandboxNetworkFirewall === "boolean"
    ) {
      parsed.sandboxNetworkFirewall = input.sandboxNetworkFirewall;
    }
  }

  if ("recapMode" in input) {
    if (
      input.recapMode !== undefined &&
      input.recapMode !== null &&
      input.recapMode !== "" &&
      !RECAP_MODES.includes(input.recapMode as RecapMode)
    ) {
      return null;
    }
    if (typeof input.recapMode === "string" && input.recapMode.length > 0) {
      parsed.recapMode = input.recapMode as RecapMode;
    }
  }

  if ("recapAfterSeconds" in input) {
    if (
      input.recapAfterSeconds !== undefined &&
      input.recapAfterSeconds !== null &&
      input.recapAfterSeconds !== "" &&
      (typeof input.recapAfterSeconds !== "number" ||
        !Number.isFinite(input.recapAfterSeconds))
    ) {
      return null;
    }
    if (
      typeof input.recapAfterSeconds === "number" &&
      Number.isFinite(input.recapAfterSeconds)
    ) {
      parsed.recapAfterSeconds = clampRecapAfterSeconds(
        input.recapAfterSeconds,
      );
    }
  }

  if ("promptSuggestionMode" in input) {
    if (
      input.promptSuggestionMode !== undefined &&
      input.promptSuggestionMode !== null &&
      input.promptSuggestionMode !== "" &&
      !PROMPT_SUGGESTION_MODES.includes(
        input.promptSuggestionMode as PromptSuggestionMode,
      )
    ) {
      return null;
    }
    if (
      typeof input.promptSuggestionMode === "string" &&
      input.promptSuggestionMode.length > 0
    ) {
      parsed.promptSuggestionMode =
        input.promptSuggestionMode as PromptSuggestionMode;
    }
  }

  if ("providers" in input) {
    if (
      input.providers !== undefined &&
      input.providers !== null &&
      input.providers !== "" &&
      !isRecord(input.providers)
    ) {
      return null;
    }
    if (isRecord(input.providers)) {
      const providers: NonNullable<NewSessionDefaults["providers"]> = {};
      for (const [providerName, rawDefaults] of Object.entries(
        input.providers,
      )) {
        if (!ALL_PROVIDERS.includes(providerName as ProviderName)) {
          return null;
        }
        const parsedProviderDefaults =
          parseProviderSessionDefaults(rawDefaults);
        if (parsedProviderDefaults === null) return null;
        if (parsedProviderDefaults) {
          providers[providerName as ProviderName] = parsedProviderDefaults;
        }
      }
      if (Object.keys(providers).length > 0) {
        parsed.providers = providers;
      }
    }
  }

  return Object.keys(parsed).length > 0 ? parsed : undefined;
}

function parseSpeechSmartTurnClientDefault(
  raw: unknown,
): SpeechSmartTurnClientDefault | null {
  if (!isRecord(raw)) return null;
  if (
    typeof raw.enabled !== "boolean" ||
    typeof raw.threshold !== "number" ||
    typeof raw.timeoutMs !== "number" ||
    !Number.isFinite(raw.threshold) ||
    !Number.isFinite(raw.timeoutMs) ||
    raw.threshold < 0 ||
    raw.threshold > 1 ||
    raw.timeoutMs < 0 ||
    raw.timeoutMs > MAX_SPEECH_SMART_TURN_TIMEOUT_MS
  ) {
    return null;
  }
  const parsed: SpeechSmartTurnClientDefault = {
    enabled: raw.enabled,
    threshold: raw.threshold,
    timeoutMs: Math.round(raw.timeoutMs),
  };
  // Optional so pre-grace clients' payloads still parse; absent means the
  // client-side default (0).
  if (raw.graceMs !== undefined) {
    if (
      typeof raw.graceMs !== "number" ||
      !Number.isFinite(raw.graceMs) ||
      raw.graceMs < 0 ||
      raw.graceMs > MAX_SPEECH_SMART_TURN_GRACE_MS
    ) {
      return null;
    }
    parsed.graceMs = Math.round(raw.graceMs);
  }
  return parsed;
}

function parseGrokSpeechAudioClientDefault(
  raw: unknown,
): GrokSpeechAudioClientDefault | null {
  if (!isRecord(raw)) return null;
  if (raw.uplinkMode !== "pcm16" && raw.uplinkMode !== "browser-compressed") {
    return null;
  }
  return { uplinkMode: raw.uplinkMode };
}

function parseSessionToolbarPresenceClientDefaults(
  raw: unknown,
): SessionToolbarPresenceClientDefaults | undefined | null {
  if (raw === undefined || raw === null || raw === "") return undefined;
  if (!isRecord(raw)) return null;

  const allowedKeys = new Set<string>(
    SESSION_TOOLBAR_PRESENCE_CLIENT_DEFAULT_KEYS,
  );
  for (const key of Object.keys(raw)) {
    if (!allowedKeys.has(key)) return null;
  }
  const allowedPresences = new Set<string>(TOOLBAR_CONTROL_PRESENCES);

  const parsed: SessionToolbarPresenceClientDefaults = {};
  for (const key of SESSION_TOOLBAR_PRESENCE_CLIENT_DEFAULT_KEYS) {
    if (!(key in raw)) continue;
    const value = raw[key];
    if (typeof value !== "string" || !allowedPresences.has(value)) return null;
    parsed[key] = value as ToolbarControlPresence;
  }
  return Object.keys(parsed).length > 0 ? parsed : null;
}

// Per-model compaction thresholds: each value is "compact at X% of that
// model's context window". Reject non-numbers (the slider only ever sends
// numbers), but treat out-of-range like the load path does — keep 1–99 and
// drop anything else (including >= 100 = "off"). An empty result clears the
// setting. The returned map is authoritative: the client always sends the
// full map, so mergeClientDefaults replaces rather than per-model merges,
// which is what makes turning a model "off" (dropping its key) take effect.
function parseCompactAtContextPercent(
  raw: unknown,
): Record<string, number> | undefined | null {
  if (raw === undefined || raw === null || raw === "") return undefined;
  if (!isRecord(raw)) return null;
  const cleaned: Record<string, number> = {};
  for (const [modelId, value] of Object.entries(raw)) {
    if (typeof value !== "number" || !Number.isFinite(value)) return null;
    const pct = Math.round(value);
    if (pct > 0 && pct < 100) cleaned[modelId] = pct;
  }
  return Object.keys(cleaned).length > 0 ? cleaned : undefined;
}

export function parseClientDefaults(
  raw: unknown,
): ClientDefaults | undefined | null {
  if (raw === undefined) return null;
  if (raw === null || raw === "") return undefined;
  if (!isRecord(raw)) return null;

  const allowedKeys = new Set<string>(CLIENT_DEFAULT_KEYS);
  for (const key of Object.keys(raw)) {
    if (!allowedKeys.has(key)) return null;
  }
  if (Object.keys(raw).length === 0) return null;

  const parsed: ClientDefaults = {};
  if ("bangCommandsEnabled" in raw) {
    if (
      raw.bangCommandsEnabled === undefined ||
      raw.bangCommandsEnabled === null
    ) {
      parsed.bangCommandsEnabled = undefined;
    } else if (typeof raw.bangCommandsEnabled !== "boolean") {
      return null;
    } else {
      parsed.bangCommandsEnabled = raw.bangCommandsEnabled;
    }
  }
  if ("speech" in raw) {
    if (raw.speech === undefined || raw.speech === null || raw.speech === "") {
      parsed.speech = undefined;
    } else if (!isRecord(raw.speech)) {
      return null;
    } else {
      const allowedSpeechKeys = new Set<string>(SPEECH_CLIENT_DEFAULT_KEYS);
      for (const key of Object.keys(raw.speech)) {
        if (!allowedSpeechKeys.has(key)) return null;
      }

      const speech: NonNullable<ClientDefaults["speech"]> = {};
      if ("voiceInputEnabled" in raw.speech) {
        if (typeof raw.speech.voiceInputEnabled !== "boolean") return null;
        speech.voiceInputEnabled = raw.speech.voiceInputEnabled;
      }
      if ("speechMethod" in raw.speech) {
        if (
          typeof raw.speech.speechMethod !== "string" ||
          raw.speech.speechMethod.trim().length === 0
        ) {
          return null;
        }
        speech.speechMethod = raw.speech.speechMethod.trim().slice(0, 120);
      }
      if ("speechSmartTurnSettings" in raw.speech) {
        const parsedSmartTurn = parseSpeechSmartTurnClientDefault(
          raw.speech.speechSmartTurnSettings,
        );
        if (!parsedSmartTurn) return null;
        speech.speechSmartTurnSettings = parsedSmartTurn;
      }
      if ("grokSpeechAudioSettings" in raw.speech) {
        const parsedGrokAudio = parseGrokSpeechAudioClientDefault(
          raw.speech.grokSpeechAudioSettings,
        );
        if (!parsedGrokAudio) return null;
        speech.grokSpeechAudioSettings = parsedGrokAudio;
      }
      if (Object.keys(speech).length === 0) return null;
      parsed.speech = speech;
    }
  }
  if ("busyComposerDefaultAction" in raw) {
    if (
      raw.busyComposerDefaultAction === undefined ||
      raw.busyComposerDefaultAction === null
    ) {
      parsed.busyComposerDefaultAction = undefined;
    } else if (
      !BUSY_COMPOSER_DEFAULT_ACTIONS.includes(
        raw.busyComposerDefaultAction as BusyComposerDefaultAction,
      )
    ) {
      return null;
    } else {
      parsed.busyComposerDefaultAction =
        raw.busyComposerDefaultAction as BusyComposerDefaultAction;
    }
  }
  if ("collapsedComposerButton" in raw) {
    if (
      raw.collapsedComposerButton === undefined ||
      raw.collapsedComposerButton === null
    ) {
      parsed.collapsedComposerButton = undefined;
    } else if (
      !COLLAPSED_COMPOSER_BUTTON_PREFERENCES.includes(
        raw.collapsedComposerButton as CollapsedComposerButtonPreference,
      )
    ) {
      return null;
    } else {
      parsed.collapsedComposerButton =
        raw.collapsedComposerButton as CollapsedComposerButtonPreference;
    }
  }
  if ("steerNowDefault" in raw) {
    if (raw.steerNowDefault === undefined || raw.steerNowDefault === null) {
      parsed.steerNowDefault = undefined;
    } else if (typeof raw.steerNowDefault !== "boolean") {
      return null;
    } else {
      parsed.steerNowDefault = raw.steerNowDefault;
    }
  }
  if ("patientQueueDefault" in raw) {
    if (
      raw.patientQueueDefault === undefined ||
      raw.patientQueueDefault === null
    ) {
      parsed.patientQueueDefault = undefined;
    } else if (typeof raw.patientQueueDefault !== "boolean") {
      return null;
    } else {
      parsed.patientQueueDefault = raw.patientQueueDefault;
    }
  }
  for (const key of [
    "patientQueueCompactAtPercent",
    "topicShiftCompactAtPercent",
  ] as const) {
    if (!(key in raw)) continue;
    const value = raw[key];
    if (value === undefined || value === null) {
      parsed[key] = undefined;
    } else if (
      typeof value !== "number" ||
      !Number.isInteger(value) ||
      value < 1 ||
      value > 100
    ) {
      return null;
    } else {
      parsed[key] = value;
    }
  }
  if ("projectQueueCtrlEnterEnabled" in raw) {
    if (
      raw.projectQueueCtrlEnterEnabled === undefined ||
      raw.projectQueueCtrlEnterEnabled === null
    ) {
      parsed.projectQueueCtrlEnterEnabled = undefined;
    } else if (typeof raw.projectQueueCtrlEnterEnabled !== "boolean") {
      return null;
    } else {
      parsed.projectQueueCtrlEnterEnabled = raw.projectQueueCtrlEnterEnabled;
    }
  }
  if ("sessionToolbarPresence" in raw) {
    const parsedPresence = parseSessionToolbarPresenceClientDefaults(
      raw.sessionToolbarPresence,
    );
    if (parsedPresence === null) return null;
    parsed.sessionToolbarPresence = parsedPresence;
  }
  if ("compactAtContextPercent" in raw) {
    const parsedCompact = parseCompactAtContextPercent(
      raw.compactAtContextPercent,
    );
    if (parsedCompact === null) return null;
    parsed.compactAtContextPercent = parsedCompact;
  }
  if ("forceYaOrchestratedCompaction" in raw) {
    if (
      raw.forceYaOrchestratedCompaction === undefined ||
      raw.forceYaOrchestratedCompaction === null
    ) {
      parsed.forceYaOrchestratedCompaction = undefined;
    } else if (typeof raw.forceYaOrchestratedCompaction !== "boolean") {
      return null;
    } else {
      parsed.forceYaOrchestratedCompaction = raw.forceYaOrchestratedCompaction;
    }
  }

  return Object.keys(parsed).length > 0 ? parsed : undefined;
}

export function mergeClientDefaults(
  current: ClientDefaults | undefined,
  update: ClientDefaults | undefined,
): ClientDefaults | undefined {
  if (!update) return undefined;
  const merged: ClientDefaults = { ...current };
  if ("bangCommandsEnabled" in update) {
    if (update.bangCommandsEnabled === undefined) {
      delete merged.bangCommandsEnabled;
    } else {
      merged.bangCommandsEnabled = update.bangCommandsEnabled;
    }
  }
  if ("speech" in update) {
    if (update.speech === undefined) {
      delete merged.speech;
    } else {
      merged.speech = {
        ...current?.speech,
        ...update.speech,
      };
    }
  }
  if ("busyComposerDefaultAction" in update) {
    if (update.busyComposerDefaultAction === undefined) {
      delete merged.busyComposerDefaultAction;
    } else {
      merged.busyComposerDefaultAction = update.busyComposerDefaultAction;
    }
  }
  if ("collapsedComposerButton" in update) {
    if (update.collapsedComposerButton === undefined) {
      delete merged.collapsedComposerButton;
    } else {
      merged.collapsedComposerButton = update.collapsedComposerButton;
    }
  }
  if ("steerNowDefault" in update) {
    if (update.steerNowDefault === undefined) {
      delete merged.steerNowDefault;
    } else {
      merged.steerNowDefault = update.steerNowDefault;
    }
  }
  if ("patientQueueDefault" in update) {
    if (update.patientQueueDefault === undefined) {
      delete merged.patientQueueDefault;
    } else {
      merged.patientQueueDefault = update.patientQueueDefault;
    }
  }
  for (const key of [
    "patientQueueCompactAtPercent",
    "topicShiftCompactAtPercent",
  ] as const) {
    if (!(key in update)) continue;
    const value = update[key];
    if (value === undefined) {
      delete merged[key];
    } else {
      merged[key] = value;
    }
  }
  if ("projectQueueCtrlEnterEnabled" in update) {
    if (update.projectQueueCtrlEnterEnabled === undefined) {
      delete merged.projectQueueCtrlEnterEnabled;
    } else {
      merged.projectQueueCtrlEnterEnabled = update.projectQueueCtrlEnterEnabled;
    }
  }
  if ("sessionToolbarPresence" in update) {
    if (update.sessionToolbarPresence === undefined) {
      delete merged.sessionToolbarPresence;
    } else {
      merged.sessionToolbarPresence = {
        ...current?.sessionToolbarPresence,
        ...update.sessionToolbarPresence,
      };
    }
  }
  if ("compactAtContextPercent" in update) {
    // Replace the whole map (not a per-model merge): the client always sends
    // the complete map, so a model dropped from it means "off" for that model.
    if (update.compactAtContextPercent === undefined) {
      delete merged.compactAtContextPercent;
    } else {
      merged.compactAtContextPercent = update.compactAtContextPercent;
    }
  }
  if ("forceYaOrchestratedCompaction" in update) {
    if (update.forceYaOrchestratedCompaction === undefined) {
      delete merged.forceYaOrchestratedCompaction;
    } else {
      merged.forceYaOrchestratedCompaction =
        update.forceYaOrchestratedCompaction;
    }
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}

export function parseSpeechAudioRetention(
  raw: unknown,
): SpeechAudioRetentionSettings | null {
  if (raw === undefined || raw === null) {
    return DEFAULT_SERVER_SETTINGS.speechAudioRetention;
  }
  if (!isRecord(raw)) return null;

  const enabled =
    typeof raw.enabled === "boolean"
      ? raw.enabled
      : DEFAULT_SERVER_SETTINGS.speechAudioRetention.enabled;
  const maxAgeDays =
    raw.maxAgeDays === undefined || raw.maxAgeDays === null
      ? DEFAULT_SPEECH_AUDIO_RETENTION_MAX_AGE_DAYS
      : raw.maxAgeDays;
  const maxBytes =
    raw.maxBytes === undefined || raw.maxBytes === null
      ? DEFAULT_SPEECH_AUDIO_RETENTION_MAX_BYTES
      : raw.maxBytes;

  if (
    typeof maxAgeDays !== "number" ||
    !Number.isInteger(maxAgeDays) ||
    maxAgeDays < 1 ||
    maxAgeDays > 3650
  ) {
    return null;
  }
  if (
    typeof maxBytes !== "number" ||
    !Number.isInteger(maxBytes) ||
    maxBytes < 1024 * 1024 ||
    maxBytes > 100 * 1024 * 1024 * 1024
  ) {
    return null;
  }

  return { enabled, maxAgeDays, maxBytes };
}

export function parsePromptCacheKeepalive(
  raw: unknown,
): PromptCacheKeepaliveSettings | undefined | null {
  if (raw === undefined) return null;
  if (raw === null || raw === "") return undefined;
  if (!isRecord(raw)) return null;

  const rawProviders = raw.providers;
  if (rawProviders === undefined || rawProviders === null) return {};
  if (!isRecord(rawProviders)) return null;

  const providers: PromptCacheKeepaliveSettings["providers"] = {};
  for (const [providerName, rawProviderSetting] of Object.entries(
    rawProviders,
  )) {
    if (!ALL_PROVIDERS.includes(providerName as ProviderName)) return null;
    if (rawProviderSetting === undefined || rawProviderSetting === null) {
      continue;
    }
    if (!isRecord(rawProviderSetting)) return null;

    const setting: {
      mode?: PromptCacheKeepaliveMode;
      inactivityMinutes?: number;
    } = {};
    if ("mode" in rawProviderSetting) {
      if (
        typeof rawProviderSetting.mode !== "string" ||
        !PROMPT_CACHE_KEEPALIVE_MODES.includes(
          rawProviderSetting.mode as PromptCacheKeepaliveMode,
        )
      ) {
        return null;
      }
      setting.mode = rawProviderSetting.mode as PromptCacheKeepaliveMode;
    }
    if ("inactivityMinutes" in rawProviderSetting) {
      const value = rawProviderSetting.inactivityMinutes;
      if (
        typeof value !== "number" ||
        !Number.isInteger(value) ||
        value < 1 ||
        value > 1440
      ) {
        return null;
      }
      setting.inactivityMinutes = value;
    }
    if (Object.keys(setting).length > 0) {
      providers[providerName as ProviderName] = setting;
    }
  }

  return { providers };
}

export function parseCacheMissBilling(
  raw: unknown,
): CacheMissBillingSettings | undefined | null {
  if (raw === undefined) return null;
  if (raw === null || raw === "") return DEFAULT_CACHE_MISS_BILLING_SETTINGS;
  if (!isRecord(raw)) return null;

  const parsed: CacheMissBillingSettings = {};
  if ("enabled" in raw) {
    if (raw.enabled === undefined || raw.enabled === null) {
      parsed.enabled = DEFAULT_CACHE_MISS_BILLING_SETTINGS.enabled;
    } else if (typeof raw.enabled !== "boolean") {
      return null;
    } else {
      parsed.enabled = raw.enabled;
    }
  }
  if ("showToasts" in raw) {
    if (raw.showToasts === undefined || raw.showToasts === null) {
      parsed.showToasts = DEFAULT_CACHE_MISS_BILLING_SETTINGS.showToasts;
    } else if (typeof raw.showToasts !== "boolean") {
      return null;
    } else {
      parsed.showToasts = raw.showToasts;
    }
  }
  if ("freshWindowMinutes" in raw) {
    if (
      raw.freshWindowMinutes === undefined ||
      raw.freshWindowMinutes === null
    ) {
      parsed.freshWindowMinutes =
        DEFAULT_CACHE_MISS_BILLING_SETTINGS.freshWindowMinutes;
    } else if (
      typeof raw.freshWindowMinutes !== "number" ||
      !Number.isInteger(raw.freshWindowMinutes) ||
      raw.freshWindowMinutes < 1 ||
      raw.freshWindowMinutes > 1440
    ) {
      return null;
    } else {
      parsed.freshWindowMinutes = raw.freshWindowMinutes;
    }
  }
  if ("providerFreshWindowMinutes" in raw) {
    if (
      raw.providerFreshWindowMinutes === undefined ||
      raw.providerFreshWindowMinutes === null
    ) {
      parsed.providerFreshWindowMinutes =
        DEFAULT_CACHE_MISS_BILLING_SETTINGS.providerFreshWindowMinutes;
    } else if (!isRecord(raw.providerFreshWindowMinutes)) {
      return null;
    } else {
      const providerFreshWindowMinutes: Partial<Record<ProviderName, number>> =
        {};
      for (const [providerName, value] of Object.entries(
        raw.providerFreshWindowMinutes,
      )) {
        if (!ALL_PROVIDERS.includes(providerName as ProviderName)) {
          return null;
        }
        if (
          typeof value !== "number" ||
          !Number.isInteger(value) ||
          value < 1 ||
          value > 1440
        ) {
          return null;
        }
        providerFreshWindowMinutes[providerName as ProviderName] = value;
      }
      parsed.providerFreshWindowMinutes = providerFreshWindowMinutes;
    }
  }
  if ("minimumWastedTokens" in raw) {
    if (
      raw.minimumWastedTokens === undefined ||
      raw.minimumWastedTokens === null
    ) {
      parsed.minimumWastedTokens =
        DEFAULT_CACHE_MISS_BILLING_SETTINGS.minimumWastedTokens;
    } else if (
      typeof raw.minimumWastedTokens !== "number" ||
      !Number.isInteger(raw.minimumWastedTokens) ||
      raw.minimumWastedTokens < 1 ||
      raw.minimumWastedTokens > 5_000_000
    ) {
      return null;
    } else {
      parsed.minimumWastedTokens = raw.minimumWastedTokens;
    }
  }
  if ("recentActivityMinutes" in raw) {
    if (
      raw.recentActivityMinutes === undefined ||
      raw.recentActivityMinutes === null
    ) {
      parsed.recentActivityMinutes =
        DEFAULT_CACHE_MISS_BILLING_SETTINGS.recentActivityMinutes;
    } else if (
      typeof raw.recentActivityMinutes !== "number" ||
      !Number.isInteger(raw.recentActivityMinutes) ||
      raw.recentActivityMinutes < 0 ||
      raw.recentActivityMinutes > 1440
    ) {
      return null;
    } else {
      parsed.recentActivityMinutes = raw.recentActivityMinutes;
    }
  }
  if ("ignoreAfterMinutes" in raw) {
    if (
      raw.ignoreAfterMinutes === undefined ||
      raw.ignoreAfterMinutes === null
    ) {
      parsed.ignoreAfterMinutes =
        DEFAULT_CACHE_MISS_BILLING_SETTINGS.ignoreAfterMinutes;
    } else if (
      typeof raw.ignoreAfterMinutes !== "number" ||
      !Number.isInteger(raw.ignoreAfterMinutes) ||
      raw.ignoreAfterMinutes < 0 ||
      raw.ignoreAfterMinutes > 1440
    ) {
      return null;
    } else {
      parsed.ignoreAfterMinutes = raw.ignoreAfterMinutes;
    }
  }

  const result = {
    ...DEFAULT_CACHE_MISS_BILLING_SETTINGS,
    ...parsed,
    providerFreshWindowMinutes: {
      ...DEFAULT_CACHE_MISS_BILLING_SETTINGS.providerFreshWindowMinutes,
      ...parsed.providerFreshWindowMinutes,
    },
  };
  return result;
}
