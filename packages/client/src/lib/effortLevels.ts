import {
  EFFORT_LEVEL_ORDER,
  getModelEffortLevels,
  nativeModelEffort,
  nearestGatewayEffortLevel,
  type EffortLevel,
  type ModelInfo,
  type ProviderInfo,
  type ProviderName,
  type ThinkingMode,
} from "@yep-anywhere/shared";

export interface EffortLevelOption {
  value: EffortLevel;
  label: string;
  description: string;
}

export type EffortLevelMessageKey =
  | "effortLevelLowLabel"
  | "effortLevelMediumLabel"
  | "effortLevelHighLabel"
  | "effortLevelExtraLabel"
  | "effortLevelExtraHighLabel"
  | "effortLevelMaxLabel"
  | "effortLevelLowDescription"
  | "effortLevelMediumDescription"
  | "effortLevelHighDescription"
  | "effortLevelExtraDescription"
  | "effortLevelExtraHighDescription"
  | "effortLevelMaxDescription";

export type EffortLevelTranslate = (key: EffortLevelMessageKey) => string;

export { EFFORT_LEVEL_ORDER };

const GENERIC_EFFORT_LEVELS: EffortLevel[] = ["low", "medium", "high", "max"];

const CODEX_EFFORT_LEVELS: EffortLevel[] = ["low", "medium", "high", "xhigh"];

const EFFORT_LEVEL_SET = new Set<string>(EFFORT_LEVEL_ORDER);

const DEFAULT_EFFORT_LEVEL_MESSAGES: Record<EffortLevelMessageKey, string> = {
  effortLevelLowLabel: "Low",
  effortLevelMediumLabel: "Medium",
  effortLevelHighLabel: "High",
  effortLevelExtraLabel: "Extra",
  effortLevelExtraHighLabel: "Extra High",
  effortLevelMaxLabel: "Max",
  effortLevelLowDescription: "Fastest responses",
  effortLevelMediumDescription: "Moderate reasoning",
  effortLevelHighDescription: "Deep reasoning",
  effortLevelExtraDescription: "For your hardest tasks",
  effortLevelExtraHighDescription: "Extra-high reasoning",
  effortLevelMaxDescription: "Maximum effort",
};

const defaultTranslateEffortLevel: EffortLevelTranslate = (key) =>
  DEFAULT_EFFORT_LEVEL_MESSAGES[key];

export function isEffortLevel(value: unknown): value is EffortLevel {
  return typeof value === "string" && EFFORT_LEVEL_SET.has(value);
}

function getProviderName(
  provider?: ProviderInfo | ProviderName | null,
): ProviderName | undefined {
  if (!provider) return undefined;
  return typeof provider === "string" ? provider : provider.name;
}

function getModelInfo(
  provider?: ProviderInfo | ProviderName | null,
  model?: ModelInfo | string | null,
): ModelInfo | undefined {
  if (!model) return undefined;
  if (typeof model !== "string") return model;
  if (!provider || typeof provider === "string") return undefined;
  return provider.models?.find((candidate) => candidate.id === model);
}

function getModelSupportedEfforts(model?: ModelInfo): EffortLevel[] | null {
  const levels = getModelEffortLevels(model);
  return levels.length > 0 ? levels : null;
}

function getFallbackEffortLevels(providerName?: ProviderName): EffortLevel[] {
  switch (providerName) {
    case "claude":
    case "claude-ollama":
      return EFFORT_LEVEL_ORDER;
    case "claude-gateway":
    case "antigravity":
      return [];
    case "codex":
      return CODEX_EFFORT_LEVELS;
    // pi's own thinking levels are off, minimal, low, medium, high, xhigh and
    // max (verified against installed Pi 0.85.1). Its RPC takes every one YA
    // names, so leaving xhigh out of the generic list made Extra unreachable
    // for a pi session that could use it.
    case "pi":
      return EFFORT_LEVEL_ORDER;
    default:
      return GENERIC_EFFORT_LEVELS;
  }
}

export function getEffortLevelLabel(
  level: EffortLevel,
  provider?: ProviderInfo | ProviderName | null,
  translate: EffortLevelTranslate = defaultTranslateEffortLevel,
): string {
  const providerName = getProviderName(provider);
  switch (level) {
    case "low":
      return translate("effortLevelLowLabel");
    case "medium":
      return translate("effortLevelMediumLabel");
    case "high":
      return translate("effortLevelHighLabel");
    case "xhigh":
      return providerName === "claude" ||
        providerName === "claude-gateway" ||
        providerName === "claude-ollama"
        ? translate("effortLevelExtraLabel")
        : translate("effortLevelExtraHighLabel");
    case "max":
      return translate("effortLevelMaxLabel");
  }
}

function getFallbackDescription(
  level: EffortLevel,
  provider?: ProviderInfo | ProviderName | null,
  translate: EffortLevelTranslate = defaultTranslateEffortLevel,
): string {
  const providerName = getProviderName(provider);
  switch (level) {
    case "low":
      return translate("effortLevelLowDescription");
    case "medium":
      return translate("effortLevelMediumDescription");
    case "high":
      return translate("effortLevelHighDescription");
    case "xhigh":
      return providerName === "claude" ||
        providerName === "claude-gateway" ||
        providerName === "claude-ollama"
        ? translate("effortLevelExtraDescription")
        : translate("effortLevelExtraHighDescription");
    case "max":
      return translate("effortLevelMaxDescription");
  }
}

function getModelDescription(
  model: ModelInfo | undefined,
  level: EffortLevel,
): string | undefined {
  return model?.supportedReasoningEfforts?.find(
    (effort) => effort.reasoningEffort === nativeModelEffort(level, model),
  )?.description;
}

export function getEffortLevelOptions(params: {
  provider?: ProviderInfo | ProviderName | null;
  model?: ModelInfo | string | null;
  translate?: EffortLevelTranslate;
}): EffortLevelOption[] {
  const model = getModelInfo(params.provider, params.model);
  const levels =
    getModelSupportedEfforts(model) ??
    getFallbackEffortLevels(getProviderName(params.provider));

  return levels.map((level) => ({
    value: level,
    label: getEffortLevelLabel(level, params.provider, params.translate),
    description:
      getModelDescription(model, level) ??
      getFallbackDescription(level, params.provider, params.translate),
  }));
}

export const EFFORT_LEVEL_OPTIONS = getEffortLevelOptions({});

export function getFallbackEffortLevel(
  options: EffortLevelOption[],
): EffortLevel {
  return options.at(-1)?.value ?? "high";
}

/**
 * The offered level to use for one this provider or model does not offer.
 *
 * Snaps *down*, the same rule the gateway services follow: a session carrying
 * an effort from elsewhere must not silently buy more thinking than was asked
 * for. Choosing the highest offered level instead made every unoffered choice
 * land on Max — a picker showing Low/Medium/High/Max could not be moved off Max
 * while a stored Extra was in play, because each attempt resolved straight back
 * to it.
 */
export function resolveSupportedEffortLevel(
  effort: EffortLevel,
  options: EffortLevelOption[],
): EffortLevel {
  if (options.length === 0) return getFallbackEffortLevel(options);
  return (
    nearestGatewayEffortLevel(
      { levels: options.map((option) => option.value) },
      effort,
    ) ?? getFallbackEffortLevel(options)
  );
}

export function getThinkingModeOptions(params: {
  provider?: ProviderInfo | ProviderName | null;
  model?: ModelInfo | string | null;
  effortOptions?: readonly EffortLevelOption[];
}): ThinkingMode[] {
  const model = getModelInfo(params.provider, params.model);
  if (
    getProviderName(params.provider) === "claude-gateway" &&
    model === undefined
  ) {
    return ["off"];
  }
  if (model?.supportsAdaptiveThinking === false) {
    return ["off"];
  }
  if (getProviderName(params.provider) === "antigravity") {
    const hasSupportedEfforts =
      model?.supportsEffort === true &&
      (params.effortOptions?.length ?? getModelEffortLevels(model).length) > 0;
    return hasSupportedEfforts ? ["auto", "on"] : ["off"];
  }

  const modes: ThinkingMode[] = ["off", "auto"];
  const supportsEffort = model?.supportsEffort !== false;
  if (supportsEffort && (params.effortOptions?.length ?? 1) > 0) {
    modes.push("on");
  }
  return modes;
}

export function resolveSupportedThinkingMode(
  mode: ThinkingMode,
  options: readonly ThinkingMode[],
): ThinkingMode {
  if (options.includes(mode)) return mode;
  return options.includes("auto") ? "auto" : "off";
}

export function getNextToggledThinkingMode(
  current: ThinkingMode,
  lastNonOffMode: ThinkingMode,
  options: readonly ThinkingMode[],
): ThinkingMode {
  if (!options.includes("off")) {
    return current === "on" ? "auto" : options.includes("on") ? "on" : "auto";
  }
  const nextEnabledMode = options.includes(lastNonOffMode)
    ? lastNonOffMode
    : (options.find((option) => option !== "off") ?? "auto");
  return current === "off" ? nextEnabledMode : "off";
}

export function normalizeEffortLevelForProvider(
  effort: string | undefined,
  provider?: ProviderInfo | ProviderName | null,
): EffortLevel {
  if (effort === "ultra" && getProviderName(provider) === "codex") return "max";
  return isEffortLevel(effort) ? effort : "high";
}
