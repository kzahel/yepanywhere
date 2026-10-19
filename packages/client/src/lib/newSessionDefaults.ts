import type {
  EffortLevel,
  ModelInfo,
  NewSessionDefaults,
  ProviderName,
  ProviderSessionDefaults,
  ThinkingMode,
} from "@yep-anywhere/shared";

export function getPreferredModelId(
  models: ModelInfo[],
  preferredModelId?: string | null,
): string | null {
  if (preferredModelId) {
    const matchingPreferredModel = models.find(
      (m) => m.id === preferredModelId,
    );
    if (matchingPreferredModel) return matchingPreferredModel.id;
    return preferredModelId;
  }

  return models.find((model) => model.isDefault)?.id ?? models[0]?.id ?? null;
}

export function providerRequiresAdvertisedModel(
  providerName: ProviderName | null | undefined,
): boolean {
  return providerName === "claude-gateway";
}

export function getPreferredProviderModelId(
  providerName: ProviderName,
  models: ModelInfo[],
  preferredModelId?: string | null,
): string | null {
  if (providerRequiresAdvertisedModel(providerName)) {
    return (
      models.find((model) => model.id === preferredModelId)?.id ??
      models.find((model) => model.isDefault)?.id ??
      models[0]?.id ??
      null
    );
  }

  return getPreferredModelId(models, preferredModelId);
}

export function hasRequiredProviderModel(
  providerName: ProviderName | null | undefined,
  models: readonly ModelInfo[],
  selectedModelId: string | null | undefined,
): boolean {
  if (!providerRequiresAdvertisedModel(providerName)) return true;
  return (
    selectedModelId !== null &&
    selectedModelId !== undefined &&
    models.some((model) => model.id === selectedModelId)
  );
}

export interface ProviderDefaultSeed {
  model?: string | null;
  serviceTier?: string | null;
  thinkingMode?: ThinkingMode | null;
  effortLevel?: EffortLevel | null;
}

function nonEmpty(value: string | null | undefined): string | undefined {
  return value && value.length > 0 ? value : undefined;
}

function compactProviderDefaults(
  defaults: ProviderSessionDefaults,
): ProviderSessionDefaults {
  const compacted: ProviderSessionDefaults = {};
  const model = nonEmpty(defaults.model);
  const serviceTier = nonEmpty(defaults.serviceTier);
  const helperSideModel = nonEmpty(defaults.helperSideModel);
  if (model) compacted.model = model;
  if (serviceTier) compacted.serviceTier = serviceTier;
  const routerPoolId = nonEmpty(defaults.routerPoolId);
  if (routerPoolId) {
    compacted.routerPoolId = routerPoolId;
    const routerAccountId = nonEmpty(defaults.routerAccountId);
    const routerPolicy = nonEmpty(defaults.routerPolicy);
    if (routerAccountId) compacted.routerAccountId = routerAccountId;
    if (routerPolicy) compacted.routerPolicy = routerPolicy;
  }
  if (defaults.thinkingMode) compacted.thinkingMode = defaults.thinkingMode;
  if (defaults.effortLevel) compacted.effortLevel = defaults.effortLevel;
  if (
    defaults.modelEffortLevels &&
    Object.keys(defaults.modelEffortLevels).length > 0
  )
    compacted.modelEffortLevels = defaults.modelEffortLevels;
  if (helperSideModel) compacted.helperSideModel = helperSideModel;
  return compacted;
}

export function getProviderSessionDefaults(
  defaults: NewSessionDefaults | null | undefined,
  providerName: ProviderName,
  seed: ProviderDefaultSeed = {},
): ProviderSessionDefaults {
  const scoped = defaults?.providers?.[providerName] ?? {};
  const legacyMatchesProvider = defaults?.provider === providerName;

  return compactProviderDefaults({
    model:
      scoped.model ??
      (legacyMatchesProvider ? defaults?.model : undefined) ??
      nonEmpty(seed.model),
    serviceTier:
      scoped.serviceTier ??
      (legacyMatchesProvider ? defaults?.serviceTier : undefined) ??
      nonEmpty(seed.serviceTier),
    routerPoolId: scoped.routerPoolId,
    routerAccountId: scoped.routerAccountId,
    routerPolicy: scoped.routerPolicy,
    thinkingMode: scoped.thinkingMode ?? seed.thinkingMode ?? undefined,
    effortLevel: scoped.effortLevel ?? seed.effortLevel ?? undefined,
    modelEffortLevels: scoped.modelEffortLevels,
    helperSideModel: scoped.helperSideModel ?? undefined,
  });
}

export function withProviderSessionDefaults(
  defaults: NewSessionDefaults | null | undefined,
  providerName: ProviderName,
  updates: ProviderSessionDefaults,
  seed: ProviderDefaultSeed = {},
): NewSessionDefaults {
  const { helperSideModel: _legacyHelperSideModel, ...baseDefaults } =
    (defaults ?? {}) as NewSessionDefaults & { helperSideModel?: string };
  const providerDefaults = compactProviderDefaults({
    ...getProviderSessionDefaults(defaults, providerName, seed),
    ...updates,
  });

  return {
    ...baseDefaults,
    providers: {
      ...defaults?.providers,
      [providerName]: providerDefaults,
    },
  };
}
