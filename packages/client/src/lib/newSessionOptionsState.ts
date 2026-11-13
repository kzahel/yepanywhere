import {
  DEFAULT_PROVIDER,
  DEFAULT_RECAP_AFTER_SECONDS,
  HELPER_SIDE_MODEL_CHEAPEST,
  type EffortLevel,
  type ModelInfo,
  type NewSessionDefaults,
  type PromptSuggestionMode,
  type ProviderInfo,
  type ProviderName,
  type RecapMode,
  type SessionSandboxLevel,
  type ThinkingMode,
  type ThinkingOption,
  normalizeRecapAfterSeconds,
} from "@yep-anywhere/shared";
import {
  type RouterSelection,
  preferredRouterSelection,
} from "../components/RouterPoolSelector";
import {
  getDefaultLaunchableProvider,
  getLaunchableProviders,
} from "../hooks/useProviders";
import type { PermissionMode } from "../types";
import {
  type LaunchLock,
  knownLockedEffort,
  knownLockedProvider,
} from "./limitedLaunchLock";
import {
  type ProviderDefaultSeed,
  getPreferredProviderModelId,
  getProviderSessionDefaults,
  unprobedProviderRow,
  withProviderSessionDefaults,
} from "./newSessionDefaults";
import {
  getDefaultHelperSideModel,
  getPreferredPromptSuggestionMode,
  getPreferredRecapMode,
  parseThinkingOption,
} from "./newSessionOptions";
import { providerSupportsLocalSessionSandbox } from "./providerCapabilities";

/**
 * The New Session form's option choices, under the names the form reads
 * them by. One reducer owns them because most changes move several at once
 * (docs/tactical/180-new-session-options-and-start.md, T1-T9).
 */
export interface NewSessionOptionsState {
  mode: PermissionMode;
  selectedProvider: ProviderName | null;
  routerPreference: RouterSelection | null;
  routerSelectionCustomized: boolean;
  /** Null follows the saved New Session default until changed in this form. */
  routerConnectorsChoice: boolean | null;
  selectedModel: string | null;
  selectedServiceTier: string | null;
  selectedThinkingMode: ThinkingMode;
  selectedEffortLevel: EffortLevel;
  selectedRecapMode: RecapMode;
  sandboxLevel: SessionSandboxLevel;
  /** Null follows the server's Machine Control default until changed here. */
  machineControlChoice: boolean | null;
  sandboxNetworkFirewall: boolean;
  recapAfterSeconds: number;
  selectedPromptSuggestionMode: PromptSuggestionMode;
  helperSideModel: string;
}

export const INITIAL_NEW_SESSION_OPTIONS: NewSessionOptionsState = {
  mode: "default",
  selectedProvider: null,
  routerPreference: null,
  routerSelectionCustomized: false,
  routerConnectorsChoice: null,
  selectedModel: null,
  selectedServiceTier: null,
  selectedThinkingMode: "off",
  selectedEffortLevel: "high",
  selectedRecapMode: "off",
  sandboxLevel: "none",
  machineControlChoice: null,
  sandboxNetworkFirewall: true,
  recapAfterSeconds: DEFAULT_RECAP_AFTER_SECONDS,
  selectedPromptSuggestionMode: "off",
  helperSideModel: HELPER_SIDE_MODEL_CHEAPEST,
};

export type NewSessionOptionsPatch = Partial<NewSessionOptionsState>;

/** Choices that change one field and nothing else. */
type SingleFieldChoice =
  | "mode"
  | "selectedModel"
  | "selectedServiceTier"
  | "selectedRecapMode"
  | "recapAfterSeconds"
  | "helperSideModel"
  | "selectedPromptSuggestionMode"
  | "sandboxNetworkFirewall"
  | "routerConnectorsChoice"
  | "machineControlChoice";

export type NewSessionOptionsAction =
  | { type: "sourceChanged"; sourceKey: string }
  | { type: "seed"; patch: NewSessionOptionsPatch }
  | { type: "lock"; lock: LaunchLock }
  | { type: "switchProvider"; patch: NewSessionOptionsPatch }
  | { type: "fillModel"; patch: NewSessionOptionsPatch }
  | {
      type: "chooseThinking";
      selection: string;
      effortOptions: readonly { value: EffortLevel }[];
    }
  | { type: "toggleSandbox"; enabled: boolean }
  | { type: "chooseRouter"; selection: RouterSelection | null }
  | {
      [K in SingleFieldChoice]: {
        type: "choose";
        field: K;
        value: NewSessionOptionsState[K];
      };
    }[SingleFieldChoice];

/**
 * Applies a patch, returning the same state object when no field changes, so
 * React skips the children and effects. Unlike an equal `useState` write, a
 * `useReducer` dispatch still re-runs the component once to find that out.
 */
function applyPatch(
  state: NewSessionOptionsState,
  patch: NewSessionOptionsPatch | null,
): NewSessionOptionsState {
  if (!patch) return state;
  const keys = Object.keys(patch) as (keyof NewSessionOptionsState)[];
  if (keys.every((key) => Object.is(state[key], patch[key]))) return state;
  return { ...state, ...patch };
}

export function newSessionOptionsReducer(
  state: NewSessionOptionsState,
  action: NewSessionOptionsAction,
): NewSessionOptionsState {
  switch (action.type) {
    case "sourceChanged":
      return applyPatch(state, {
        routerPreference:
          state.routerPreference?.sourceKey === action.sourceKey
            ? state.routerPreference
            : null,
        routerSelectionCustomized: false,
        routerConnectorsChoice: null,
        machineControlChoice: null,
      });
    case "seed":
    case "switchProvider":
    case "fillModel":
      return applyPatch(state, action.patch);
    case "lock":
      return applyPatch(state, lockNewSessionOptions(state, action.lock));
    case "chooseThinking":
      return applyPatch(
        state,
        chooseNewSessionThinking(action.selection, action.effortOptions),
      );
    case "toggleSandbox":
      return applyPatch(state, toggleNewSessionSandbox(state, action.enabled));
    case "chooseRouter":
      return applyPatch(state, {
        routerSelectionCustomized: true,
        routerPreference: action.selection,
      });
    case "choose":
      return applyPatch(state, { [action.field]: action.value });
  }
}

export type LegacyProviderDefaultSeed = (
  providerName: ProviderName,
) => ProviderDefaultSeed;

/**
 * Saved defaults applied against whatever provider rows are known so far
 * (T2). Null when no provider can be chosen yet. The caller applies the
 * launch lock afterwards, so a saved default never outranks it.
 */
export function seedNewSessionOptions({
  providerRows,
  savedDefaults,
  preferredProvider,
  preferredModel,
  preferredThinking,
  preferredPermissionMode,
  supportsSessionSandboxing,
  sourceKey,
  legacySeed,
}: {
  providerRows: ProviderInfo[];
  savedDefaults: NewSessionDefaults | null | undefined;
  preferredProvider?: ProviderName;
  preferredModel?: string;
  preferredThinking?: ThinkingOption;
  preferredPermissionMode?: PermissionMode;
  supportsSessionSandboxing: boolean;
  sourceKey: string;
  legacySeed: LegacyProviderDefaultSeed;
}): NewSessionOptionsPatch | null {
  const catalogKnown = providerRows.length > 0;
  const launchableProviderNames = new Set(
    getLaunchableProviders(providerRows).map((p) => p.name),
  );
  const isSelectable = (name: ProviderName) =>
    !catalogKnown || launchableProviderNames.has(name);
  // An explicit caller preference (e.g. "clear" from an existing session)
  // outranks saved new-session defaults.
  const requestedProviderName =
    preferredProvider && isSelectable(preferredProvider)
      ? preferredProvider
      : null;
  const savedProviderName =
    requestedProviderName ??
    (savedDefaults?.provider && isSelectable(savedDefaults.provider)
      ? savedDefaults.provider
      : null);
  const initialProvider =
    providerRows.find((p) => p.name === savedProviderName) ??
    getDefaultLaunchableProvider(providerRows) ??
    (catalogKnown
      ? null
      : unprobedProviderRow(savedProviderName ?? DEFAULT_PROVIDER));

  if (!initialProvider) return null;

  const initialModels = initialProvider.models ?? [];
  const requestedModelId =
    requestedProviderName &&
    initialProvider.name === requestedProviderName &&
    preferredModel &&
    ((initialProvider.name !== "claude-gateway" &&
      initialModels.length === 0) ||
      initialModels.some((model) => model.id === preferredModel))
      ? preferredModel
      : null;
  const preferredPromptSuggestionMode =
    getPreferredPromptSuggestionMode(savedDefaults);
  const initialProviderDefaults = getProviderSessionDefaults(
    savedDefaults,
    initialProvider.name,
    legacySeed(initialProvider.name),
  );
  const preferredThinkingSelection = preferredThinking
    ? parseThinkingOption(preferredThinking)
    : null;
  const savedSandboxLevel =
    supportsSessionSandboxing && savedDefaults?.sandboxLevel === "project-write"
      ? "project-write"
      : "none";
  const savedRecapMode = getPreferredRecapMode(initialProvider, savedDefaults);
  return {
    selectedProvider: initialProvider.name,
    selectedServiceTier: initialProviderDefaults.serviceTier ?? null,
    routerPreference: preferredRouterSelection(
      initialProviderDefaults,
      sourceKey,
    ),
    routerSelectionCustomized: false,
    selectedModel:
      requestedModelId ??
      getPreferredProviderModelId(
        initialProvider.name,
        initialModels,
        initialProviderDefaults.model,
      ),
    selectedThinkingMode:
      preferredThinkingSelection?.mode ??
      initialProviderDefaults.thinkingMode ??
      "off",
    selectedEffortLevel:
      preferredThinkingSelection?.effort ??
      initialProviderDefaults.effortLevel ??
      "high",
    selectedRecapMode:
      providerSupportsLocalSessionSandbox(initialProvider.name) &&
      savedSandboxLevel === "project-write" &&
      savedRecapMode === "side-session"
        ? "off"
        : savedRecapMode,
    sandboxLevel: savedSandboxLevel,
    sandboxNetworkFirewall:
      savedSandboxLevel === "project-write" &&
      savedDefaults?.sandboxNetworkFirewall !== false,
    recapAfterSeconds: normalizeRecapAfterSeconds(
      savedDefaults?.recapAfterSeconds,
    ),
    selectedPromptSuggestionMode: preferredPromptSuggestionMode,
    helperSideModel: getDefaultHelperSideModel(
      initialModels,
      initialProviderDefaults,
    ),
    mode: preferredPermissionMode ?? savedDefaults?.permissionMode ?? "default",
  };
}

/**
 * A limited principal's lock (T3). It settles provider, model, effort and
 * sandbox; a side-session recap cannot run beside the forced sandbox. Not a
 * customization: a lock the server imposed is not a preference to save.
 */
export function lockNewSessionOptions(
  state: NewSessionOptionsState,
  lock: LaunchLock,
): NewSessionOptionsPatch | null {
  if (!lock.limited) return null;
  const lockedProvider = knownLockedProvider(lock);
  const lockedEffort = lock.effort ? knownLockedEffort(lock) : undefined;
  return {
    ...(lockedProvider ? { selectedProvider: lockedProvider } : {}),
    ...(lock.model ? { selectedModel: lock.model } : {}),
    ...(lockedEffort ? { selectedEffortLevel: lockedEffort } : {}),
    ...(lock.effort ? { selectedThinkingMode: "on" as const } : {}),
    sandboxLevel: "project-write",
    // Without the firewall a sandboxed agent can reach YA and escape.
    sandboxNetworkFirewall: true,
    selectedRecapMode:
      state.selectedRecapMode === "side-session"
        ? "off"
        : state.selectedRecapMode,
  };
}

/**
 * Switching provider restores that provider's own saved model, tier, router,
 * thinking, effort and helper model (T4). It reads the current settings, not
 * the restored display defaults.
 */
export function switchNewSessionProvider({
  providerName,
  providers,
  savedDefaults,
  preferredThinking,
  sourceKey,
  legacySeed,
}: {
  providerName: ProviderName;
  providers: ProviderInfo[];
  savedDefaults: NewSessionDefaults | null | undefined;
  preferredThinking?: ThinkingOption;
  sourceKey: string;
  legacySeed: LegacyProviderDefaultSeed;
}): NewSessionOptionsPatch {
  const provider = providers.find((p) => p.name === providerName);
  const providerModels = provider?.models ?? [];
  const providerDefaults = getProviderSessionDefaults(
    savedDefaults,
    providerName,
    legacySeed(providerName),
  );
  const preferredThinkingSelection = preferredThinking
    ? parseThinkingOption(preferredThinking)
    : null;
  return {
    selectedProvider: providerName,
    selectedServiceTier: providerDefaults.serviceTier ?? null,
    routerPreference: preferredRouterSelection(providerDefaults, sourceKey),
    routerSelectionCustomized: false,
    selectedModel:
      provider?.models && provider.models.length > 0
        ? getPreferredProviderModelId(
            providerName,
            providerModels,
            providerDefaults.model,
          )
        : null,
    selectedThinkingMode:
      preferredThinkingSelection?.mode ??
      providerDefaults.thinkingMode ??
      "off",
    selectedEffortLevel:
      preferredThinkingSelection?.effort ??
      providerDefaults.effortLevel ??
      "high",
    helperSideModel: getDefaultHelperSideModel(
      providerModels,
      providerDefaults,
    ),
  };
}

interface ModelFillInput {
  selectedProvider: ProviderName | null;
  selectedModel: string | null;
  availableModels: ModelInfo[];
  savedDefaults: NewSessionDefaults | null | undefined;
  legacySeed: LegacyProviderDefaultSeed;
}

function preferredModelFill(
  selectedProvider: ProviderName,
  { availableModels, savedDefaults, legacySeed }: ModelFillInput,
) {
  const providerDefaults = getProviderSessionDefaults(
    savedDefaults,
    selectedProvider,
    legacySeed(selectedProvider),
  );
  return {
    nextModel: getPreferredProviderModelId(
      selectedProvider,
      availableModels,
      providerDefaults.model,
    ),
    helperSideModel: getDefaultHelperSideModel(
      availableModels,
      providerDefaults,
    ),
  };
}

/**
 * Claude Gateway keeps only a model its current catalog advertises (T5):
 * otherwise the saved advertised model, or the catalog's first row.
 */
export function fillGatewayModel(
  input: ModelFillInput,
): NewSessionOptionsPatch | null {
  const { selectedProvider, selectedModel, availableModels } = input;
  if (selectedProvider !== "claude-gateway") return null;
  if (
    selectedModel &&
    availableModels.some((model) => model.id === selectedModel)
  ) {
    return null;
  }
  const { nextModel, helperSideModel } = preferredModelFill(
    selectedProvider,
    input,
  );
  if (selectedModel === nextModel) return null;
  return { selectedModel: nextModel, helperSideModel };
}

/**
 * A provider chosen before its catalog answered has no model yet; once its
 * models arrive, fill the provider's saved default (T6). An existing pick
 * stays.
 */
export function fillCatalogModel(
  input: ModelFillInput,
): NewSessionOptionsPatch | null {
  const { selectedProvider, selectedModel, availableModels } = input;
  if (!selectedProvider || selectedModel) return null;
  if (availableModels.length === 0) return null;
  const { nextModel, helperSideModel } = preferredModelFill(
    selectedProvider,
    input,
  );
  if (!nextModel) return null;
  return { selectedModel: nextModel, helperSideModel };
}

/**
 * The thinking picker offers Off, Auto and one "on:<effort>" row per effort
 * (T7). A selection matching no effort changes nothing.
 */
export function chooseNewSessionThinking(
  selection: string,
  effortOptions: readonly { value: EffortLevel }[],
): NewSessionOptionsPatch | null {
  if (selection === "off" || selection === "auto") {
    return { selectedThinkingMode: selection };
  }
  const nextEffort = effortOptions.find(
    (option) => selection === `on:${option.value}`,
  );
  if (!nextEffort) return null;
  return { selectedEffortLevel: nextEffort.value, selectedThinkingMode: "on" };
}

/**
 * Sandboxing turns the firewall on, since without it a sandboxed agent can
 * reach YA, and turns a side-session recap off, which cannot run beside it
 * (T8).
 */
export function toggleNewSessionSandbox(
  state: NewSessionOptionsState,
  enabled: boolean,
): NewSessionOptionsPatch {
  return {
    sandboxLevel: enabled ? "project-write" : "none",
    ...(enabled ? { sandboxNetworkFirewall: true } : {}),
    ...(enabled && state.selectedRecapMode === "side-session"
      ? { selectedRecapMode: "off" as const }
      : {}),
  };
}

/** The choices the automatic save writes; machine control is never saved. */
export type SavedNewSessionChoices = Pick<
  NewSessionOptionsState,
  | "mode"
  | "selectedModel"
  | "selectedServiceTier"
  | "selectedThinkingMode"
  | "selectedEffortLevel"
  | "selectedRecapMode"
  | "recapAfterSeconds"
  | "selectedPromptSuggestionMode"
  | "sandboxLevel"
  | "sandboxNetworkFirewall"
  | "helperSideModel"
>;

/**
 * The automatic save's body. The saved sandbox fields and the legacy
 * top-level helper model and tier are dropped from the base; the sandbox is
 * written back only when the server supports it, so a save on a host without
 * sandboxing erases a saved sandbox default. The raw choices are saved, not
 * the effective ones: an unsupported Auto stays the all-provider preference.
 */
export function newSessionDefaultsToSave({
  saved,
  choices: state,
  provider,
  supportsSessionSandboxing,
  currentRouterPreference,
  preferClaudeAiConnectors,
  legacySeed,
}: {
  saved: NewSessionDefaults | null | undefined;
  choices: SavedNewSessionChoices;
  provider: ProviderName;
  supportsSessionSandboxing: boolean;
  currentRouterPreference: RouterSelection | null;
  preferClaudeAiConnectors: boolean;
  legacySeed: LegacyProviderDefaultSeed;
}): NewSessionDefaults {
  const {
    helperSideModel: _legacyHelperSideModel,
    serviceTier: _legacyServiceTier,
    sandboxLevel: _savedSandboxLevel,
    sandboxNetworkFirewall: _savedSandboxNetworkFirewall,
    ...baseDefaults
  } = (saved ?? {}) as NewSessionDefaults & { helperSideModel?: string };
  return withProviderSessionDefaults(
    {
      ...baseDefaults,
      provider,
      // Permission mode is an all-provider preference. Keep an
      // unsupported saved value such as Auto intact while the visible /
      // launch-time mode falls back to Ask for the selected model.
      permissionMode: state.mode,
      recapMode: state.selectedRecapMode,
      recapAfterSeconds: state.recapAfterSeconds,
      promptSuggestionMode: state.selectedPromptSuggestionMode,
      ...(supportsSessionSandboxing
        ? {
            sandboxLevel: state.sandboxLevel,
            ...(state.sandboxLevel === "project-write"
              ? { sandboxNetworkFirewall: state.sandboxNetworkFirewall }
              : {}),
          }
        : {}),
    },
    provider,
    {
      model: state.selectedModel ?? undefined,
      serviceTier: state.selectedServiceTier ?? undefined,
      routerPoolId: currentRouterPreference?.poolId,
      routerAccountId: currentRouterPreference?.accountId || undefined,
      routerPolicy: currentRouterPreference?.policy,
      routerClaudeAiConnectors:
        provider === "claude" && preferClaudeAiConnectors ? true : undefined,
      thinkingMode: state.selectedThinkingMode,
      effortLevel: state.selectedEffortLevel,
      helperSideModel: state.helperSideModel,
    },
    legacySeed(provider),
  );
}
