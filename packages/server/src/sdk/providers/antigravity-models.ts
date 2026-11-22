import {
  EFFORT_LEVEL_ORDER,
  type EffortLevel,
  type ModelInfo,
  type ThinkingConfig,
} from "@yep-anywhere/shared";
import type {
  AntigravityConfigOption,
  AntigravitySessionSetup,
} from "./antigravity-runtime.js";

export const ANTIGRAVITY_DEFAULT_MODEL: ModelInfo = {
  id: "default",
  name: "Antigravity default",
};

const EFFORT_LEVEL_SET = new Set<string>(EFFORT_LEVEL_ORDER);

export function isAntigravityEffortLevel(value: unknown): value is EffortLevel {
  return typeof value === "string" && EFFORT_LEVEL_SET.has(value);
}

export function findAntigravityConfigOption(
  options: readonly AntigravityConfigOption[] | undefined,
  idOrCategory: string,
): AntigravityConfigOption | undefined {
  return options?.find(
    (option) => option.id === idOrCategory || option.category === idOrCategory,
  );
}

function effortLevelsForBaseModel(
  baseId: string,
  availableModels: ReadonlyArray<{ modelId: string; name: string }> | undefined,
  currentModelId: string | undefined,
  thoughtOption: AntigravityConfigOption | undefined,
): EffortLevel[] {
  const discovered = new Set<EffortLevel>();
  const prefix = `${baseId}-`;
  for (const model of availableModels ?? []) {
    if (!model.modelId.startsWith(prefix)) continue;
    const suffix = model.modelId.slice(prefix.length);
    if (isAntigravityEffortLevel(suffix)) {
      discovered.add(suffix);
    }
  }
  if (baseId === currentModelId) {
    for (const option of thoughtOption?.options ?? []) {
      if (isAntigravityEffortLevel(option.value)) discovered.add(option.value);
    }
  }
  return EFFORT_LEVEL_ORDER.filter((level) => discovered.has(level));
}

function effortFields(
  levels: EffortLevel[],
  defaultLevel?: EffortLevel,
): Partial<ModelInfo> {
  if (levels.length === 0) {
    return {
      supportsEffort: false,
      supportsAdaptiveThinking: false,
    };
  }
  return {
    supportsEffort: true,
    supportedEffortLevels: levels,
    supportedReasoningEfforts: levels.map((reasoningEffort) => ({
      reasoningEffort,
    })),
    ...(defaultLevel
      ? {
          defaultEffortLevel: defaultLevel,
          defaultReasoningEffort: defaultLevel,
        }
      : {}),
  };
}

/**
 * Project Antigravity's ACP `session/new` / `session/load` setup into YA's
 * model catalog: structured `configOptions` for base models and
 * `thought_level`, with each model's levels taken from the paired
 * effort-suffixed entries in `models.availableModels`. Without a model option
 * the catalog is the runtime's own default.
 */
export function buildAntigravityModels(
  setup: AntigravitySessionSetup,
): ModelInfo[] {
  const modelOption = findAntigravityConfigOption(setup.configOptions, "model");
  if (!modelOption?.options?.length)
    return [
      {
        ...ANTIGRAVITY_DEFAULT_MODEL,
        isDefault: true,
        supportsEffort: false,
        supportsAdaptiveThinking: false,
      },
    ];
  const thoughtOption = findAntigravityConfigOption(
    setup.configOptions,
    "thought_level",
  );
  const currentModelId = modelOption.currentValue;
  const currentThought = isAntigravityEffortLevel(thoughtOption?.currentValue)
    ? thoughtOption.currentValue
    : undefined;
  const models = modelOption.options.map((option): ModelInfo => {
    const levels = effortLevelsForBaseModel(
      option.value,
      setup.models?.availableModels,
      currentModelId,
      thoughtOption,
    );
    const defaultLevel =
      option.value === currentModelId ? currentThought : undefined;
    return {
      id: option.value,
      name: option.name || option.value,
      ...(option.description ? { description: option.description } : {}),
      ...effortFields(levels, defaultLevel),
    };
  });
  const currentModel = models.find((model) => model.id === currentModelId);
  const defaultLevels = currentModel?.supportedEffortLevels ?? [];
  return [
    {
      ...ANTIGRAVITY_DEFAULT_MODEL,
      isDefault: true,
      ...effortFields(defaultLevels, currentThought),
    },
    ...models,
  ];
}

/**
 * Split a legacy effort-suffixed Antigravity model ID (e.g. `gemini-3.8-flash-low`)
 * into its catalog base model ID and embedded effort when that base model is
 * present with effort support.
 */
export function splitAntigravityLegacyModel(
  modelId: string | undefined,
  models: readonly ModelInfo[] | null | undefined,
): { modelId: string; embeddedEffort?: EffortLevel } | undefined {
  if (!modelId || !models?.length) return undefined;
  if (models.some((model) => model.id === modelId)) {
    return { modelId };
  }
  for (const model of models) {
    if (model.supportsEffort !== true) continue;
    const prefix = `${model.id}-`;
    if (!modelId.startsWith(prefix)) continue;
    const suffix = modelId.slice(prefix.length);
    if (
      isAntigravityEffortLevel(suffix) &&
      (!model.supportedEffortLevels?.length ||
        model.supportedEffortLevels.includes(suffix))
    ) {
      return { modelId: model.id, embeddedEffort: suffix };
    }
  }
  return { modelId };
}

export function resolveAntigravityModelSelection(
  configOptions: readonly AntigravityConfigOption[] | undefined,
  fallbackModelId: string | undefined,
): string | undefined {
  return (
    findAntigravityConfigOption(configOptions, "model")?.currentValue ??
    fallbackModelId
  );
}

/**
 * Resolve YA thinking/effort controls to a native Antigravity `thought_level`.
 * Antigravity offers no disabled thinking level; explicit `off` snaps to the
 * lowest offered level (mirroring Codex), while `auto` keeps the native default.
 */
export function resolveAntigravityTargetEffort(
  thinking: ThinkingConfig | undefined,
  effort: EffortLevel | undefined,
  offeredLevels: readonly string[],
): string | undefined {
  if (effort !== undefined) return effort;
  if (thinking?.type === "disabled") {
    if (offeredLevels.includes("off")) return "off";
    if (offeredLevels.includes("none")) return "none";
    const lowest = EFFORT_LEVEL_ORDER.find((level) =>
      offeredLevels.includes(level),
    );
    return lowest ?? offeredLevels[0];
  }
  return undefined;
}
