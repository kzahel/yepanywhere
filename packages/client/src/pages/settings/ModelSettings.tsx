import { composerOptionDotStateClasses } from "../../components/composerStateClasses";
import recapStyles from "../../components/RecapAfterSecondsControl.module.css";
import thinkingStyles from "../../components/ThinkingControls.module.css";
import dotStyles from "../../components/ComposerOptionDot.module.css";
import optionStyles from "../../components/NewSessionOptionsPanel.module.css";
import rowLayoutStyles from "./SettingsRows.module.css";
import rowsStyles from "./SettingsRows.module.css";
import {
  DEFAULT_RECAP_AFTER_SECONDS,
  DEFAULT_PROMPT_CACHE_KEEPALIVE_INACTIVITY_MINUTES,
  HELPER_SIDE_MODEL_CHEAPEST,
  HELPER_SIDE_MODEL_SAME_AS_MAIN,
  PROMPT_CACHE_KEEPALIVE_MODES,
  PROMPT_SUGGESTION_MODES,
  type EffortLevel,
  type NewSessionDefaults,
  resolveModel,
  type ModelInfo,
  type PermissionMode,
  type PromptCacheKeepaliveMode,
  type PromptCacheKeepaliveSettings,
  type PromptSuggestionMode,
  type ProviderInfo,
  type ProviderName,
  type ProviderSessionDefaults,
  type RecapMode,
  type ThinkingMode,
  normalizeRecapAfterSeconds,
} from "@yep-anywhere/shared";
import {
  MODEL_OPTIONS,
  getModelSetting,
  useModelSettings,
} from "../../hooks/useModelSettings";
import {
  getEffortLevelOptions,
  getThinkingModeOptions,
  resolveSupportedEffortLevel,
  resolveSupportedThinkingMode,
} from "../../lib/effortLevels";
import {
  getProviderSessionDefaults,
  withProviderSessionDefaults,
} from "../../lib/newSessionDefaults";
import { formatContextWindowLabel } from "../../lib/contextWindowLabel";
import { providerSupportsLocalSessionSandbox } from "../../lib/providerCapabilities";
import { serverHasAvailableSessionSandbox } from "../../lib/sessionSandboxAvailability";
import { getSessionDefaultControlCopy } from "../../lib/sessionDefaultControlCopy";
import { getRecapModeDescription } from "../../lib/recapModes";
import { getPermissionModeOptions } from "../../lib/permissionModes";
import {
  getAvailableProviders,
  getDefaultProvider,
  useProviders,
} from "../../hooks/useProviders";
import { useCallback, useMemo } from "react";
import { useForkSummaryAutoOpen } from "../../hooks/useForkSummaryAutoOpen";
import { useProviderSubscriptionUsage } from "../../hooks/useProviderSubscriptionUsage";
import { useServerSettings } from "../../hooks/useServerSettings";
import { useVersion } from "../../hooks/useVersion";
import { useI18n } from "../../i18n";
import styles from "./ModelSettings.module.css";
import {
  ClaudeAutoCompactPercentOverrideControl,
  YaCompactContextEarlyControl,
} from "./compactSettingsControls";
import { SettingsItem } from "./SettingsItem";
import { useSettingsPaneTitle } from "./SettingsPaneTitleContext";
import { SettingsSection } from "./SettingsSection";
import { useSettingsUndoBaseline } from "./SettingsUndoContext";
import { useToastContext } from "../../contexts/ToastContext";
import {
  FilterDropdown,
  type FilterOption,
} from "../../components/FilterDropdown";
import { ProviderBadge } from "../../components/ProviderBadge";
import { ModelSubscriptionUsage } from "../../components/ModelSubscriptionUsage";
import { RecapAfterSecondsControl } from "../../components/RecapAfterSecondsControl";
import { TextInput } from "../../components/ui/Field";
import { SegmentedControl } from "../../components/ui/SegmentedControl";
import { Switch } from "../../components/ui/Switch";
import {
  ShowThinkingControls,
  ThinkingControlsPanel,
} from "../../components/ThinkingControls";

const RECAP_MODE_ORDER: RecapMode[] = ["off", "side-session", "fork"];
const PROMPT_SUGGESTION_MODE_ORDER: PromptSuggestionMode[] = [
  ...PROMPT_SUGGESTION_MODES,
];
const PROMPT_CACHE_KEEPALIVE_MODE_ORDER: PromptCacheKeepaliveMode[] = [
  ...PROMPT_CACHE_KEEPALIVE_MODES,
];

function getPreferredProvider(
  providers: ProviderInfo[],
  preferredProvider?: ProviderName,
): ProviderInfo | null {
  const availableProviders = getAvailableProviders(providers);
  if (preferredProvider) {
    const matching = availableProviders.find(
      (p) => p.name === preferredProvider,
    );
    if (matching) return matching;
  }
  return getDefaultProvider(providers);
}

function getPreferredModel(
  models: ModelInfo[],
  preferredModel?: string,
): string | null {
  if (preferredModel) {
    const matchingModel = models.find((m) => m.id === preferredModel);
    if (matchingModel) return matchingModel.id;
  }
  return (
    models.find((m) => m.isDefault)?.id ??
    models.find((m) => m.id === "default")?.id ??
    models[0]?.id ??
    null
  );
}

function getPreferredProviderModel(
  providerName: ProviderName,
  models: ModelInfo[],
  defaults?: NewSessionDefaults | null,
): string | null {
  const legacyClaudeFallbackModel =
    providerName === "claude" ? resolveModel(getModelSetting()) : undefined;
  const providerDefaults = getProviderSessionDefaults(defaults, providerName, {
    model: legacyClaudeFallbackModel,
  });

  return getPreferredModel(models, providerDefaults.model);
}

function getPreferredRecapMode(
  _provider:
    | {
        supportsRecaps?: boolean;
        supportsNativeRecaps?: boolean;
      }
    | null
    | undefined,
  defaults?: { recapMode?: RecapMode } | null,
): RecapMode {
  if (defaults?.recapMode && RECAP_MODE_ORDER.includes(defaults.recapMode)) {
    return defaults.recapMode;
  }
  return "off";
}

function getPreferredPromptSuggestionMode(
  defaults?: { promptSuggestionMode?: PromptSuggestionMode } | null,
): PromptSuggestionMode {
  if (
    defaults?.promptSuggestionMode &&
    PROMPT_SUGGESTION_MODE_ORDER.includes(defaults.promptSuggestionMode)
  ) {
    return defaults.promptSuggestionMode;
  }
  return "off";
}

function getDefaultHelperSideModel(
  models: ModelInfo[],
  defaults?: { helperSideModel?: string } | null,
): string {
  const defaultModel = defaults?.helperSideModel;
  if (
    defaultModel &&
    (defaultModel === HELPER_SIDE_MODEL_CHEAPEST ||
      defaultModel === HELPER_SIDE_MODEL_SAME_AS_MAIN ||
      models.some((model) => model.id === defaultModel))
  ) {
    return defaultModel;
  }
  return HELPER_SIDE_MODEL_CHEAPEST;
}

function getProviderPromptCacheKeepaliveSetting(
  provider: ProviderInfo | null | undefined,
  settings: PromptCacheKeepaliveSettings | null | undefined,
): {
  mode: PromptCacheKeepaliveMode;
  inactivityMinutes: number;
} {
  const capability = provider?.promptCacheKeepalive;
  const saved =
    provider && settings?.providers
      ? settings.providers[provider.name]
      : undefined;
  return {
    mode: saved?.mode ?? capability?.defaultMode ?? "off",
    inactivityMinutes:
      saved?.inactivityMinutes ??
      capability?.defaultInactivityMinutes ??
      DEFAULT_PROMPT_CACHE_KEEPALIVE_INACTIVITY_MINUTES,
  };
}

function normalizeKeepaliveMinutes(value: number): number | null {
  if (!Number.isFinite(value)) {
    return null;
  }
  return Math.min(1440, Math.max(1, Math.round(value)));
}

export function ModelSettings() {
  const { t } = useI18n();
  const sessionDefaultCopy = getSessionDefaultControlCopy(t);
  useSettingsPaneTitle(t("modelSettingsTitle"));
  const { showToast } = useToastContext();
  const {
    model,
    setModel,
    effortLevel,
    setEffortLevel,
    thinkingMode,
    setThinkingMode,
    showThinking,
    setShowThinking,
  } = useModelSettings();
  const { providers, loading: providersLoading } = useProviders();
  const [forkSummaryAutoOpen, setForkSummaryAutoOpen] =
    useForkSummaryAutoOpen();
  const {
    settings,
    isLoading: settingsLoading,
    updateSetting,
  } = useServerSettings();
  const { version } = useVersion();
  const supportsSessionSandboxing = serverHasAvailableSessionSandbox(version);

  const availableProviders = getAvailableProviders(providers);
  const savedDefaults = settings?.newSessionDefaults;

  // Header undo across both state sources: the client-scoped model prefs
  // (useModelSettings setters) and the server-side new-session defaults.
  const undoState = useMemo(
    () =>
      settings
        ? {
            model,
            effortLevel,
            thinkingMode,
            showThinking,
            newSessionDefaults: settings.newSessionDefaults ?? {},
            promptCacheKeepalive: settings.promptCacheKeepalive ?? {},
          }
        : null,
    [settings, model, effortLevel, thinkingMode, showThinking],
  );
  const restoreUndoState = useCallback(
    (snapshot: NonNullable<typeof undoState>) => {
      setModel(snapshot.model);
      setEffortLevel(snapshot.effortLevel);
      setThinkingMode(snapshot.thinkingMode);
      setShowThinking(snapshot.showThinking);
      void updateSetting("newSessionDefaults", snapshot.newSessionDefaults);
      void updateSetting("promptCacheKeepalive", snapshot.promptCacheKeepalive);
    },
    [setModel, setEffortLevel, setThinkingMode, setShowThinking, updateSetting],
  );
  useSettingsUndoBaseline(undoState, restoreUndoState);
  const selectedProvider =
    getPreferredProvider(providers, savedDefaults?.provider) ?? null;
  const { usage: subscriptionUsage } = useProviderSubscriptionUsage(
    selectedProvider?.name,
  );
  const canConfigureSessionSandbox =
    supportsSessionSandboxing &&
    providerSupportsLocalSessionSandbox(selectedProvider?.name);
  const selectedModels = selectedProvider?.models ?? [];
  const selectedModel =
    selectedProvider === null
      ? null
      : getPreferredProviderModel(
          selectedProvider.name,
          selectedModels,
          savedDefaults,
        );
  const selectedProviderDefaults = selectedProvider
    ? getProviderSessionDefaults(savedDefaults, selectedProvider.name, {
        model:
          selectedProvider.name === "claude"
            ? resolveModel(getModelSetting())
            : undefined,
        thinkingMode,
        effortLevel,
      })
    : ({} satisfies ProviderSessionDefaults);
  const helperSelectableModels = selectedModels;
  const savedRecapMode = getPreferredRecapMode(selectedProvider, savedDefaults);
  const selectedRecapMode =
    canConfigureSessionSandbox &&
    savedDefaults?.sandboxLevel === "project-write" &&
    savedRecapMode === "side-session"
      ? "off"
      : savedRecapMode;
  const selectedRecapAfterSeconds = normalizeRecapAfterSeconds(
    savedDefaults?.recapAfterSeconds ?? DEFAULT_RECAP_AFTER_SECONDS,
  );
  const selectedPromptSuggestionMode =
    getPreferredPromptSuggestionMode(savedDefaults);
  const selectedPromptCacheKeepalive = getProviderPromptCacheKeepaliveSetting(
    selectedProvider,
    settings?.promptCacheKeepalive,
  );
  const selectedHelperSideModel = getDefaultHelperSideModel(
    helperSelectableModels,
    selectedProviderDefaults,
  );
  const selectedModelInfo =
    selectedModels.find((modelInfo) => modelInfo.id === selectedModel) ?? null;
  // Per-model "compact context early" threshold (task 029): a percent of the
  // selected model's context window. 0 = off, stored as the model's key being
  // absent from clientDefaults.compactAtContextPercent. A local draft tracks
  // the slider during a drag; commit-on-release writes the whole map, so
  // dragging a model down to 0 drops its key and turns it off.
  const storedCompactPercent =
    (selectedModel
      ? settings?.clientDefaults?.compactAtContextPercent?.[selectedModel]
      : undefined) ?? 0;
  const forceYaOrchestratedCompaction =
    settings?.clientDefaults?.forceYaOrchestratedCompaction === true;
  const showCompactThreshold =
    (selectedProvider?.name.startsWith("claude") === true ||
      selectedProvider?.supportsNativeCompactThreshold === true) &&
    selectedModelInfo != null &&
    // The live trigger keys by the running process model, which is always a
    // concrete id (e.g. "opus") — never the "default" sentinel. Offering a
    // threshold for "default" would only persist a key that can never fire.
    selectedModel !== "default";
  const claudeProviderForCompact = availableProviders.find(
    (p) => p.name === "claude",
  );
  const showClaudeAutoCompactMirror =
    claudeProviderForCompact?.supportsLaunchCompactPercentOverride === true;
  const effortOptions = getEffortLevelOptions({
    provider: selectedProvider,
    model: selectedModelInfo,
    translate: t,
  });
  const effectiveEffortLevel = resolveSupportedEffortLevel(
    selectedProviderDefaults.effortLevel ?? "high",
    effortOptions,
  );
  const thinkingModeOptions = getThinkingModeOptions({
    provider: selectedProvider,
    model: selectedModelInfo,
    effortOptions,
  });
  const effectiveThinkingMode = resolveSupportedThinkingMode(
    selectedProviderDefaults.thinkingMode ?? "off",
    thinkingModeOptions,
  );
  const permissionModeOptions = getPermissionModeOptions({
    model: selectedModelInfo,
  });
  const effectiveDefaultPermissionMode = permissionModeOptions.includes(
    savedDefaults?.permissionMode ?? "default",
  )
    ? (savedDefaults?.permissionMode ?? "default")
    : "default";
  const modeLabels: Record<PermissionMode, string> = {
    default: t("modeDefaultLabel"),
    acceptEdits: t("modeAcceptEditsLabel"),
    plan: t("modePlanLabel"),
    bypassPermissions: t("modeBypassPermissionsLabel"),
    auto: t("modeAutoLabel"),
  };
  const modeDescriptions: Record<PermissionMode, string> = {
    default: t("modeDefaultDescription"),
    acceptEdits: t("modeAcceptEditsDescription"),
    plan: t("modePlanDescription"),
    bypassPermissions: t("modeBypassPermissionsDescription"),
    auto: t("modeAutoDescription"),
  };
  const recapModeLabels: Record<RecapMode, string> = {
    off: t("recapModeOff"),
    native: t("recapModeNative"),
    "side-session": t("recapModeSideSession"),
    fork: t("recapModeFork"),
  };
  const promptSuggestionModeLabels: Record<PromptSuggestionMode, string> = {
    off: t("promptSuggestionModeOff"),
    native: t("promptSuggestionModeNative"),
  };
  const promptSuggestionModeDescriptions: Record<PromptSuggestionMode, string> =
    {
      off: t("promptSuggestionModeOffDescription"),
      native: t("promptSuggestionModeNativeDescription"),
    };
  const promptCacheKeepaliveModeLabels: Record<
    PromptCacheKeepaliveMode,
    string
  > = {
    auto: t("promptCacheKeepaliveModeAuto"),
    off: t("promptCacheKeepaliveModeOff"),
  };
  const promptCacheKeepaliveModeDescriptions: Record<
    PromptCacheKeepaliveMode,
    string
  > = {
    auto: t("promptCacheKeepaliveModeAutoDescription", {
      minutes: selectedPromptCacheKeepalive.inactivityMinutes,
    }),
    off: t("promptCacheKeepaliveModeOffDescription"),
  };
  const recapAfterSecondsInlineLabels: Record<RecapMode, string> = {
    off: t("recapAfterSecondsLabel"),
    native: t("recapAfterSecondsInlineNative"),
    "side-session": t("recapAfterSecondsInlineSideSession"),
    fork: t("recapAfterSecondsInlineFork"),
  };
  const supportsPermissionMode =
    selectedProvider?.supportsPermissionMode ?? true;
  const supportsThinkingToggle =
    selectedProvider?.supportsThinkingToggle ?? true;
  const showThinkingControls =
    supportsThinkingToggle &&
    thinkingModeOptions.some((option) => option !== "off");
  const availableRecapModes = RECAP_MODE_ORDER;
  const availablePromptSuggestionModes = PROMPT_SUGGESTION_MODE_ORDER;
  const showHelperSideModel = selectedRecapMode === "side-session";
  const showPromptCacheKeepalive =
    selectedProvider?.promptCacheKeepalive?.supportsNoContextPollutionNudge ===
    true;
  const modelOptions: FilterOption<string>[] = selectedModels.map((option) => {
    const label = option.size
      ? `${option.name} (${(option.size / (1024 * 1024 * 1024)).toFixed(1)} GB)`
      : option.name;
    const descriptionParts: string[] = [];
    if (option.parameterSize) descriptionParts.push(option.parameterSize);
    if (option.contextWindow) {
      descriptionParts.push(formatContextWindowLabel(option.contextWindow));
    }
    if (option.parentModel) descriptionParts.push(option.parentModel);
    if (option.quantizationLevel) {
      descriptionParts.push(option.quantizationLevel);
    }
    return {
      value: option.id,
      label,
      description: option.description ?? descriptionParts.join(" · "),
      // Same provider → route → model badge as the session header/tooltip, so
      // the route (e.g. pi's "copilot") is visible alongside the model name.
      icon: selectedProvider ? (
        <ProviderBadge provider={selectedProvider.name} model={option.id} />
      ) : undefined,
      meta: (
        <ModelSubscriptionUsage usage={subscriptionUsage} modelId={option.id} />
      ),
    };
  });
  const helperSideModelOptions: FilterOption<string>[] = [
    {
      value: HELPER_SIDE_MODEL_CHEAPEST,
      label: t("helperSideModelCheapest"),
    },
    {
      value: HELPER_SIDE_MODEL_SAME_AS_MAIN,
      label: t("helperSideModelSameAsMain"),
      description: selectedModel ?? undefined,
    },
    ...helperSelectableModels.map((option) => ({
      value: option.id,
      label: option.name,
      description: option.description,
    })),
  ];

  const updateNewSessionDefaults = async (
    updates: NewSessionDefaults,
  ): Promise<void> => {
    try {
      const nextDefaults: NewSessionDefaults = {
        ...savedDefaults,
        ...updates,
      };
      if (!supportsSessionSandboxing) {
        delete nextDefaults.sandboxLevel;
        delete nextDefaults.sandboxNetworkFirewall;
      }
      await updateSetting("newSessionDefaults", nextDefaults);
      showToast(t("newSessionDefaultsSaved"), "success");
    } catch (err) {
      showToast(
        err instanceof Error ? err.message : t("newSessionDefaultsSaveError"),
        "error",
      );
    }
  };

  const updateProviderSessionDefaults = async (
    updates: ProviderSessionDefaults,
  ): Promise<void> => {
    if (!selectedProvider) return;

    await updateNewSessionDefaults(
      withProviderSessionDefaults(
        { ...savedDefaults, provider: selectedProvider.name },
        selectedProvider.name,
        updates,
        {
          model:
            selectedProvider.name === "claude"
              ? resolveModel(getModelSetting())
              : undefined,
          thinkingMode,
          effortLevel,
        },
      ),
    );
  };

  const updatePromptCacheKeepalive = async (
    updates: Partial<{
      mode: PromptCacheKeepaliveMode;
      inactivityMinutes: number;
    }>,
  ): Promise<void> => {
    if (!selectedProvider) return;

    const current = settings?.promptCacheKeepalive ?? {};
    const providersByName = { ...current.providers };
    providersByName[selectedProvider.name] = {
      ...providersByName[selectedProvider.name],
      ...updates,
    };

    try {
      await updateSetting("promptCacheKeepalive", {
        ...current,
        providers: providersByName,
      });
      showToast(t("promptCacheKeepaliveSaved"), "success");
    } catch (err) {
      showToast(
        err instanceof Error ? err.message : t("promptCacheKeepaliveSaveError"),
        "error",
      );
    }
  };

  const handleProviderChange = async (providerName: ProviderName) => {
    const provider = availableProviders.find((p) => p.name === providerName);
    if (!provider) return;
    const providerModels = provider.models ?? [];
    const nextModel =
      getPreferredProviderModel(provider.name, providerModels, savedDefaults) ??
      undefined;
    await updateNewSessionDefaults(
      withProviderSessionDefaults(
        { ...savedDefaults, provider: provider.name },
        provider.name,
        { model: nextModel },
        {
          model:
            provider.name === "claude"
              ? resolveModel(getModelSetting())
              : undefined,
          thinkingMode,
          effortLevel,
        },
      ),
    );
  };

  const handleDefaultModelChange = async (modelId: string) => {
    if (!selectedProvider) return;

    await updateProviderSessionDefaults({ model: modelId });
  };

  return (
    <SettingsSection
      title={t("modelSettingsSessionDefaultsTitle")}
      keywords={[
        "session defaults",
        "default model",
        "provider",
        "permission mode",
        "thinking",
        "recap",
        "prompt suggestions",
        "compact",
        "early compact",
        "context early",
        "autocompact",
        "prompt cache keepalive",
        "sandbox bubblewrap project writes",
        "helper model",
        "fork summary",
      ]}
    >
      <div className={rowsStyles.group} data-settings-group>
        <div
          className={`${styles.defaultsPanel} ${styles.sessionDefaultsPanel}`}
        >
          <p className={styles.intro}>
            {t("modelSettingsNewSessionDefaultsIntro")}
          </p>

          <SettingsItem
            id="session-default-provider"
            label={
              sessionDefaultCopy.provider.settings?.title ??
              sessionDefaultCopy.provider.title
            }
            description={sessionDefaultCopy.provider.description}
            keywords={[
              ...(sessionDefaultCopy.provider.settings?.keywords ?? []),
              sessionDefaultCopy.provider.title,
              ...availableProviders.map((p) => p.displayName),
            ]}
            valueText={selectedProvider?.displayName}
            className={`${optionStyles.newSessionProviderSection} ${styles.sessionDefaultProviderSection} settings-item--session-default-block ${rowsStyles.itemWideControl}`}
          >
            <SegmentedControl
              activation="manual"
              variant="cards"
              aria-label={
                sessionDefaultCopy.provider.settings?.title ??
                sessionDefaultCopy.provider.title
              }
              options={availableProviders.map((provider) => ({
                value: provider.name,
                label: provider.displayName,
                icon: (
                  <span
                    className={`${dotStyles["provider-option-dot"]} ${composerOptionDotStateClasses[`provider-${provider.name}`] ?? ""}`}
                  />
                ),
              }))}
              value={selectedProvider?.name}
              onChange={(name) => void handleProviderChange(name)}
              disabled={providersLoading || settingsLoading}
            />
          </SettingsItem>

          <SettingsItem
            id="session-default-model"
            label={
              sessionDefaultCopy.model.settings?.title ??
              sessionDefaultCopy.model.title
            }
            description={sessionDefaultCopy.model.description}
            keywords={[
              ...(sessionDefaultCopy.model.settings?.keywords ?? []),
              sessionDefaultCopy.model.title,
            ]}
            valueText={selectedModel ?? undefined}
            className={`${optionStyles.newSessionModelSection} ${styles.sessionDefaultModelSection} settings-item--session-default-block ${rowsStyles.itemWideControl}`}
          >
            <div
              className={optionStyles.newSessionModelField}
              data-new-session-model-field
            >
              {selectedModels.length > 0 ? (
                <FilterDropdown
                  label={t("newSessionModelTitle")}
                  options={modelOptions}
                  selected={selectedModel ? [selectedModel] : []}
                  onChange={(selected) => {
                    const nextModel = selected[0];
                    if (nextModel) void handleDefaultModelChange(nextModel);
                  }}
                  multiSelect={false}
                  placeholder={t("newSessionModelPlaceholder")}
                  fullWidth
                />
              ) : (
                <span className={styles.empty}>{t("modelSwitchEmpty")}</span>
              )}
            </div>
          </SettingsItem>

          {showThinkingControls && (
            <SettingsItem
              id="session-default-thinking"
              label={sessionDefaultCopy.thinking.title}
              description={sessionDefaultCopy.thinking.description}
              keywords={sessionDefaultCopy.thinking.settings?.keywords}
              valueText={`${effectiveThinkingMode} ${effectiveEffortLevel ?? ""}`.trim()}
              className={`${optionStyles.newSessionHelperSection} ${styles.sessionDefaultHelperSection} ${styles.sessionDefaultThinkingSection} settings-item--session-default-block ${rowsStyles.itemWideControl}`}
            >
              <ThinkingControlsPanel
                mode={effectiveThinkingMode}
                modeOptions={thinkingModeOptions}
                onSetMode={(mode: ThinkingMode) =>
                  void updateProviderSessionDefaults({ thinkingMode: mode })
                }
                level={effectiveEffortLevel}
                effortOptions={effortOptions}
                onSetEffort={(level: EffortLevel) =>
                  void updateProviderSessionDefaults({ effortLevel: level })
                }
                onSetEffortMode={(level: EffortLevel) =>
                  void updateProviderSessionDefaults({
                    thinkingMode: "on",
                    effortLevel: level,
                  })
                }
                showThinkingControl={false}
                provider={selectedProvider?.name}
                t={t}
                className={`${thinkingStyles.thinkingControlsPanelInline} ${styles.sessionDefaultThinkingControls}`}
              />
            </SettingsItem>
          )}

          {supportsPermissionMode && (
            <SettingsItem
              id="session-default-permission-mode"
              label={sessionDefaultCopy.permission.title}
              keywords={sessionDefaultCopy.permission.settings?.keywords}
              valueText={modeLabels[effectiveDefaultPermissionMode]}
              className={`${optionStyles.newSessionModeSection} ${styles.sessionDefaultModeSection} settings-item--session-default-block ${rowsStyles.itemWideControl}`}
            >
              <SegmentedControl
                activation="manual"
                variant="cards"
                aria-label={sessionDefaultCopy.permission.title}
                options={permissionModeOptions.map((modeValue) => ({
                  value: modeValue,
                  label: modeLabels[modeValue],
                  description: modeDescriptions[modeValue],
                  icon: (
                    <span
                      className={`${dotStyles["mode-option-dot"]} ${composerOptionDotStateClasses[`mode-${modeValue}`] ?? ""}`}
                      data-mode-option-dot
                    />
                  ),
                }))}
                value={effectiveDefaultPermissionMode}
                onChange={(modeValue) =>
                  void updateNewSessionDefaults({ permissionMode: modeValue })
                }
                disabled={settingsLoading}
              />
            </SettingsItem>
          )}

          {canConfigureSessionSandbox && (
            <SettingsItem
              id="session-default-sandbox"
              as="label"
              label={
                sessionDefaultCopy.sandbox.settings?.title ??
                sessionDefaultCopy.sandbox.title
              }
              description={sessionDefaultCopy.sandbox.description}
              doc="topics/session-sandboxing.md"
              keywords={[
                ...(sessionDefaultCopy.sandbox.settings?.keywords ?? []),
                t("newSessionSandboxLabel"),
              ]}
              valueText={
                savedDefaults?.sandboxLevel === "project-write"
                  ? t("newSessionSandboxLabel")
                  : undefined
              }
              className={`${optionStyles.newSessionHelperSection} ${styles.sessionDefaultHelperSection} ${styles.sessionDefaultSandboxSection} settings-item--session-default-block`}
            >
              <Switch
                checked={savedDefaults?.sandboxLevel === "project-write"}
                disabled={settingsLoading}
                onCheckedChange={(enabled) => {
                  void updateNewSessionDefaults({
                    sandboxLevel: enabled ? "project-write" : "none",
                    sandboxNetworkFirewall: enabled ? true : undefined,
                    ...(enabled && savedRecapMode === "side-session"
                      ? { recapMode: "off" }
                      : {}),
                  });
                }}
                aria-label={
                  sessionDefaultCopy.sandbox.settings?.title ??
                  sessionDefaultCopy.sandbox.title
                }
              />
            </SettingsItem>
          )}

          {canConfigureSessionSandbox && (
            <SettingsItem
              id="session-default-sandbox-network-firewall"
              as="label"
              label={sessionDefaultCopy.sandboxFirewall.title}
              description={sessionDefaultCopy.sandboxFirewall.description}
              keywords={sessionDefaultCopy.sandboxFirewall.settings?.keywords}
              valueText={
                savedDefaults?.sandboxLevel === "project-write" &&
                savedDefaults.sandboxNetworkFirewall !== false
                  ? t("newSessionSandboxNetworkFirewallLabel")
                  : undefined
              }
              className={`${optionStyles.newSessionHelperSection} ${styles.sessionDefaultHelperSection} ${styles.sessionDefaultSandboxSection} settings-item--session-default-block`}
            >
              <Switch
                checked={
                  savedDefaults?.sandboxLevel === "project-write" &&
                  savedDefaults.sandboxNetworkFirewall !== false
                }
                disabled={
                  settingsLoading ||
                  savedDefaults?.sandboxLevel !== "project-write"
                }
                onCheckedChange={(checked) => {
                  void updateNewSessionDefaults({
                    sandboxNetworkFirewall: checked,
                  });
                }}
                aria-label={t("newSessionSandboxNetworkFirewallLabel")}
              />
            </SettingsItem>
          )}

          <div className={styles.captionPair}>
            <SettingsItem
              id="session-default-show-thinking"
              label={sessionDefaultCopy.showThinking.title}
              description={sessionDefaultCopy.showThinking.description}
              keywords={sessionDefaultCopy.showThinking.settings?.keywords}
              valueText={String(showThinking)}
              className={`${optionStyles.newSessionHelperSection} ${styles.sessionDefaultHelperSection} session-default-show-thinking-section settings-item--session-default-block ${rowsStyles.itemWideControl}`}
            >
              <ShowThinkingControls
                value={showThinking}
                onChange={setShowThinking}
                t={t}
                showLabel={false}
              />
            </SettingsItem>

            <SettingsItem
              id="session-default-suggestions"
              label={sessionDefaultCopy.suggestions.title}
              description={
                promptSuggestionModeDescriptions[selectedPromptSuggestionMode]
              }
              keywords={sessionDefaultCopy.suggestions.settings?.keywords}
              valueText={
                promptSuggestionModeLabels[selectedPromptSuggestionMode]
              }
              className={`${optionStyles.newSessionHelperSection} ${styles.sessionDefaultHelperSection} session-default-suggestions-section settings-item--session-default-block ${rowsStyles.itemWideControl}`}
            >
              <SegmentedControl
                activation="manual"
                variant="cards"
                aria-label={sessionDefaultCopy.suggestions.title}
                options={availablePromptSuggestionModes.map((modeValue) => ({
                  value: modeValue,
                  label: promptSuggestionModeLabels[modeValue],
                  tooltip: promptSuggestionModeDescriptions[modeValue],
                  icon: (
                    <span
                      className={`${dotStyles["mode-option-dot"]} ${composerOptionDotStateClasses[`suggestion-${modeValue}`] ?? ""}`}
                      data-mode-option-dot
                    />
                  ),
                }))}
                value={selectedPromptSuggestionMode}
                onChange={(modeValue) =>
                  void updateNewSessionDefaults({
                    promptSuggestionMode: modeValue,
                  })
                }
                disabled={settingsLoading}
              />
            </SettingsItem>
          </div>

          <SettingsItem
            id="session-default-recap"
            label={sessionDefaultCopy.recap.title}
            description={getRecapModeDescription(
              selectedRecapMode,
              t,
              selectedRecapAfterSeconds,
            )}
            doc="topics/recaps.md#configuration-and-native-capability"
            keywords={sessionDefaultCopy.recap.settings?.keywords}
            valueText={recapModeLabels[selectedRecapMode]}
            className={`${optionStyles.newSessionHelperSection} ${styles.sessionDefaultHelperSection} ${styles.sessionDefaultRecapSection} settings-item--session-default-block ${rowsStyles.itemWideControl}`}
            after={
              selectedRecapMode !== "off" ? (
                <RecapAfterSecondsControl
                  value={selectedRecapAfterSeconds}
                  disabled={settingsLoading}
                  label={recapAfterSecondsInlineLabels[selectedRecapMode]}
                  mode={selectedRecapMode}
                  className={`${styles.recapDuration} ${recapStyles["recap-after-seconds-control--inline"]}`}
                  onCommit={(seconds) =>
                    updateNewSessionDefaults({ recapAfterSeconds: seconds })
                  }
                />
              ) : undefined
            }
          >
            <SegmentedControl
              activation="manual"
              variant="cards"
              aria-label={sessionDefaultCopy.recap.title}
              options={availableRecapModes.map((modeValue) => ({
                value: modeValue,
                label: recapModeLabels[modeValue],
                tooltip: getRecapModeDescription(
                  modeValue,
                  t,
                  selectedRecapAfterSeconds,
                ),
                icon: (
                  <span
                    className={`${dotStyles["mode-option-dot"]} ${composerOptionDotStateClasses[`recap-${modeValue}`] ?? ""}`}
                    data-mode-option-dot
                  />
                ),
                disabled:
                  canConfigureSessionSandbox &&
                  savedDefaults?.sandboxLevel === "project-write" &&
                  modeValue === "side-session",
              }))}
              value={selectedRecapMode}
              onChange={(modeValue) =>
                void updateNewSessionDefaults({ recapMode: modeValue })
              }
              disabled={settingsLoading}
            />
          </SettingsItem>

          {showHelperSideModel && (
            <SettingsItem
              id="session-default-helper-model"
              label={sessionDefaultCopy.helperModel.title}
              description={sessionDefaultCopy.helperModel.description}
              doc="topics/side-session-config.md"
              keywords={sessionDefaultCopy.helperModel.settings?.keywords}
              valueText={selectedHelperSideModel}
              className={`${optionStyles.newSessionHelperSection} ${styles.sessionDefaultHelperSection} session-default-helper-model-section settings-item--session-default-block ${rowsStyles.itemWideControl}`}
            >
              <FilterDropdown
                label={sessionDefaultCopy.helperModel.title}
                options={helperSideModelOptions}
                selected={[selectedHelperSideModel]}
                onChange={(selected) => {
                  const helperSideModel =
                    selected[0] ?? HELPER_SIDE_MODEL_CHEAPEST;
                  void updateProviderSessionDefaults({ helperSideModel });
                }}
                multiSelect={false}
                placeholder={t("helperSideModelCheapest")}
                fullWidth
              />
            </SettingsItem>
          )}

          <div className={styles.relatedDivider}>
            <strong>{t("modelSettingsRelatedBehaviorTitle")}</strong>
            <span>{t("modelSettingsRelatedBehaviorDescription")}</span>
          </div>

          <SettingsItem
            id="session-default-fork-summary"
            as="label"
            label={t("modelSettingsForkSummaryAutoOpenTitle")}
            description={t("modelSettingsForkSummaryAutoOpenDescription")}
            keywords={[
              "fork",
              "fork summary",
              "forked session",
              t("modelSettingsForkSummaryAutoOpenLabel"),
            ]}
            valueText={
              forkSummaryAutoOpen
                ? t("modelSettingsForkSummaryAutoOpenLabel")
                : undefined
            }
            className={`${optionStyles.newSessionHelperSection} ${styles.sessionDefaultHelperSection} ${styles.sessionDefaultForkSummarySection} settings-item--session-default-block`}
          >
            <Switch
              checked={forkSummaryAutoOpen}
              onCheckedChange={(checked) => setForkSummaryAutoOpen(checked)}
              aria-label={t("modelSettingsForkSummaryAutoOpenLabel")}
            />
          </SettingsItem>

          {showCompactThreshold && selectedModel && (
            <YaCompactContextEarlyControl
              id="session-default-compact-early"
              modelId={selectedModel}
              contextWindow={selectedModelInfo?.contextWindow}
              storedPercent={storedCompactPercent}
              map={settings?.clientDefaults?.compactAtContextPercent}
              updateSetting={updateSetting}
              disabled={settingsLoading}
              className={`${optionStyles.newSessionHelperSection} ${styles.sessionDefaultHelperSection} ${styles.sessionDefaultCompactSection} settings-item--session-default-block ${rowsStyles.itemWideControl}`}
            />
          )}

          {showClaudeAutoCompactMirror && (
            <ClaudeAutoCompactPercentOverrideControl
              id="session-default-claude-auto-compact"
              value={settings?.claudeAutoCompactPercentOverride}
              updateSetting={updateSetting}
              description={t("providersClaudeAutoCompactMirrorDescription")}
              searchable={false}
            />
          )}

          {showCompactThreshold &&
            selectedProvider?.supportsNativeCompactThreshold === true && (
              <SettingsItem
                id="session-default-force-ya-compaction"
                as="label"
                label={t("modelSettingsForceYaCompactionLabel")}
                description={t("modelSettingsForceYaCompactionDescription")}
                keywords={[
                  "force ya",
                  "orchestrated compaction",
                  "ya compact",
                  "/compact",
                ]}
                valueText={
                  forceYaOrchestratedCompaction
                    ? t("modelSettingsForceYaCompactionLabel")
                    : undefined
                }
                className={`${optionStyles.newSessionHelperSection} ${styles.sessionDefaultHelperSection} session-default-force-ya-section settings-item--session-default-block`}
              >
                <Switch
                  checked={forceYaOrchestratedCompaction}
                  disabled={settingsLoading}
                  onCheckedChange={(checked) => {
                    void updateSetting("clientDefaults", {
                      forceYaOrchestratedCompaction: checked,
                    });
                  }}
                  aria-label={t("modelSettingsForceYaCompactionLabel")}
                />
              </SettingsItem>
            )}

          {showPromptCacheKeepalive && selectedProvider && (
            <SettingsItem
              id="session-default-prompt-cache"
              label={t("promptCacheKeepaliveTitle")}
              description={[
                t("promptCacheKeepaliveDescription", {
                  provider: selectedProvider.displayName,
                }),
                t("promptCacheKeepaliveCadenceHint"),
              ].join(" ")}
              doc="topics/prompt-cache-keepalive.md"
              keywords={[
                "prompt cache",
                "keepalive",
                "cache refresh",
                "inactivity",
              ]}
              valueText={`${selectedPromptCacheKeepalive.mode} ${selectedPromptCacheKeepalive.inactivityMinutes}m`}
              className={`${optionStyles.newSessionHelperSection} ${styles.sessionDefaultHelperSection} ${styles.sessionDefaultCacheKeepaliveSection} settings-item--session-default-block ${rowsStyles.itemWideControl}`}
            >
              <div className={styles.sessionDefaultCacheKeepaliveControls}>
                <SegmentedControl
                  activation="manual"
                  variant="cards"
                  aria-label={t("promptCacheKeepaliveTitle")}
                  options={PROMPT_CACHE_KEEPALIVE_MODE_ORDER.map(
                    (modeValue) => ({
                      value: modeValue,
                      label: promptCacheKeepaliveModeLabels[modeValue],
                      tooltip: promptCacheKeepaliveModeDescriptions[modeValue],
                      icon: (
                        <span
                          className={`${dotStyles["mode-option-dot"]} ${modeValue === "off" ? styles.keepaliveOff : styles.keepaliveAuto}`}
                          data-mode-option-dot
                        />
                      ),
                    }),
                  )}
                  value={selectedPromptCacheKeepalive.mode}
                  onChange={(modeValue) =>
                    void updatePromptCacheKeepalive({ mode: modeValue })
                  }
                  disabled={settingsLoading}
                />
                <label className={styles.promptCacheKeepaliveCadence}>
                  <span>{t("promptCacheKeepaliveCadenceLabel")}</span>
                  <TextInput
                    key={`${selectedProvider.name}-${selectedPromptCacheKeepalive.inactivityMinutes}`}
                    type="number"
                    unit={t("promptCacheKeepaliveCadenceUnit")}
                    min={1}
                    max={1440}
                    step={1}
                    defaultValue={
                      selectedPromptCacheKeepalive.inactivityMinutes
                    }
                    disabled={
                      settingsLoading ||
                      selectedPromptCacheKeepalive.mode === "off"
                    }
                    aria-label={t("promptCacheKeepaliveCadenceAria")}
                    onBlur={(event) => {
                      const minutes = normalizeKeepaliveMinutes(
                        Number(event.currentTarget.value),
                      );
                      if (minutes === null) {
                        event.currentTarget.value = String(
                          selectedPromptCacheKeepalive.inactivityMinutes,
                        );
                        return;
                      }
                      event.currentTarget.value = String(minutes);
                      if (
                        minutes !==
                        selectedPromptCacheKeepalive.inactivityMinutes
                      ) {
                        void updatePromptCacheKeepalive({
                          inactivityMinutes: minutes,
                        });
                      }
                    }}
                  />
                </label>
              </div>
            </SettingsItem>
          )}
        </div>
      </div>

      {selectedProvider?.name === "claude" && (
        <div className={rowsStyles.group} data-settings-group>
          <SettingsItem
            label={t("modelSettingsModelTitle")}
            description={t("modelSettingsModelDescription")}
            className={rowLayoutStyles.modelItem}
          >
            <SegmentedControl
              className={rowLayoutStyles.modelChipGroup}
              aria-label={t("modelSettingsModelTitle")}
              options={MODEL_OPTIONS.map((opt) => ({
                value: opt.value,
                label: opt.label,
              }))}
              value={model}
              onChange={setModel}
            />
          </SettingsItem>
        </div>
      )}
    </SettingsSection>
  );
}
