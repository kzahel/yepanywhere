import type {
  EffortLevel,
  ModelInfo,
  ThinkingConfig,
} from "@yep-anywhere/shared";

/** Saved per-model effort defaults, keyed by provider-local model id. */
export type ClaudeModelEffortLevels = Readonly<Record<string, EffortLevel>>;

function supportsLevel(model: ModelInfo, level: EffortLevel): boolean {
  if (model.supportsEffort === false) return false;
  return !model.supportedEffortLevels?.length
    ? true
    : model.supportedEffortLevels.includes(level);
}

/**
 * Report each saved override as the model's default effort, so every client
 * that shows "auto" names the level the launch will actually request. An
 * override the model does not support is ignored.
 */
export function applyClaudeModelEffortDefaults(
  models: readonly ModelInfo[],
  overrides: ClaudeModelEffortLevels | undefined,
): ModelInfo[] {
  if (!overrides || Object.keys(overrides).length === 0) return [...models];
  return models.map((model) => {
    const level = overrides[model.id];
    return level && supportsLevel(model, level)
      ? { ...model, defaultEffortLevel: level }
      : model;
  });
}

/**
 * The effort a Claude launch requests. An explicit effort always wins and
 * disabled thinking requests none; otherwise ("auto") the selected model's
 * catalog default — already carrying any saved override — is passed through.
 * A model without a catalog default keeps Claude Code's own default.
 */
export function resolveClaudeLaunchEffort(options: {
  thinking?: ThinkingConfig;
  effort?: EffortLevel;
  model?: string;
  models: readonly ModelInfo[];
}): EffortLevel | undefined {
  if (options.effort) return options.effort;
  if (options.thinking?.type === "disabled") return undefined;
  const id = options.model ?? "default";
  return options.models.find((model) => model.id === id)?.defaultEffortLevel;
}
