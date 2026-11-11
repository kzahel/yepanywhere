import { composerOptionDotStateClasses } from "./composerStateClasses";
import dotStyles from "./ComposerOptionDot.module.css";
import optionStyles from "./NewSessionOptionsPanel.module.css";
import { RouterPoolSelector } from "./RouterPoolSelector";
import { RouterClaudeAiConnectorsSelection } from "./RouterClaudeAiConnectorsSelection";
import { MachineControlSessionSelection } from "./MachineControlSessionSelection";
import {
  SERVER_CAPABILITIES,
  serverHasCapability,
  HELPER_SIDE_MODEL_CHEAPEST,
  type PromptSuggestionMode,
  type ProviderName,
  type RecapMode,
  type SessionSandboxLevel,
  type ShowThinking,
} from "@yep-anywhere/shared";
import { type ReactNode, useMemo, useState } from "react";
import styles from "./NewSessionForm.module.css";
import { Banner } from "./ui/Banner";
import { Button, IconButton } from "./ui/Button";
import type { useNewSessionOptions } from "../hooks/useNewSessionOptions";
import { type MessageKey, useI18n } from "../i18n";
import { formatContextWindowLabel } from "../lib/contextWindowLabel";
import { formatBriefAge } from "../lib/sessionAge";
import { UI_KEYS } from "../lib/storageKeys";
import { getEffortLevelLabel } from "../lib/effortLevels";
import { serviceTierLabel } from "../lib/serviceTiers";
import { knownLockedEffort, type LaunchLock } from "../lib/limitedLaunchLock";
import {
  type RouterModelUnavailable,
  startsAdditionalModelGroup,
} from "../lib/modelCatalog";
import {
  PROMPT_SUGGESTION_MODE_ORDER,
  RECAP_MODE_ORDER,
} from "../lib/newSessionOptions";
import { getRecapModeDescription } from "../lib/recapModes";
import { getSessionDefaultControlCopy } from "../lib/sessionDefaultControlCopy";
import type { useVersion } from "../hooks/useVersion";
import type { PermissionMode } from "../types";
import { FilterDropdown, type FilterOption } from "./FilterDropdown";
import { NewSessionFixedLaunch } from "./NewSessionFixedLaunch";
import { NewSessionOptionSection } from "./NewSessionOptionSection";
import { ProviderBadge } from "./ProviderBadge";
import { ModelSubscriptionUsage } from "./ModelSubscriptionUsage";
import { RecapAfterSecondsControl } from "./RecapAfterSecondsControl";

const ROUTER_MODEL_UNAVAILABLE = {
  unresolved: "routerModelUnresolved",
  conflict: "routerModelConflict",
  missing: "routerModelMissing",
} as const satisfies Record<RouterModelUnavailable, MessageKey>;

/**
 * The New Session options: the provider slot (provider, model, effort and the
 * catalog status), the advanced-options toggle with its summary, and the
 * secondary options. Three adjacent elements of the form's grid, returned as
 * a fragment so the layout is unchanged
 * (docs/tactical/180-new-session-options-and-start.md, slice 3).
 */
export function NewSessionOptionsPanel({
  options,
  providerSlotFilled,
  showProviderPicker,
  showModelPicker,
  launchLock,
  isStarting,
  isProjectChooserExpanded,
  showThinking,
  setShowThinking,
  clientSummarySourceKey,
  versionInfo,
}: {
  options: ReturnType<typeof useNewSessionOptions>;
  providerSlotFilled: boolean;
  showProviderPicker: boolean;
  showModelPicker: boolean;
  launchLock: LaunchLock;
  isStarting: boolean;
  isProjectChooserExpanded: boolean;
  showThinking: ShowThinking;
  setShowThinking: (value: ShowThinking) => void;
  clientSummarySourceKey: string;
  versionInfo: ReturnType<typeof useVersion>["version"];
}) {
  const { t } = useI18n();
  const {
    availableModels,
    canConfigureSessionSandbox,
    claudeAiConnectorsSupport,
    customizeOptions,
    displayDefaultsPending,
    effectiveEffortLevel,
    effectivePermissionMode,
    effectiveSandboxLevel,
    effectiveServiceTier,
    effectiveThinkingMode,
    effortOptions,
    handleModeSelect,
    handleModelSelect,
    handleProviderSelect,
    helperSideModel,
    helperSideModelOptions,
    machineControlEligible,
    machineControlSelected,
    permissionModeOptions,
    providerChoices,
    providersLoading,
    providersStale,
    recapAfterSeconds,
    refetchProviders,
    refreshRouterCatalog,
    routerCatalogAt,
    routerCatalogRefresh,
    routerClaudeAiConnectors,
    routerDiscovery,
    routerModelList,
    routerSelection,
    routerThinking,
    sandboxLevel,
    sandboxLocalAuthOpen,
    sandboxNetworkFirewall,
    selectMachineControl,
    selectedModel,
    selectedPromptSuggestionMode,
    selectedProvider,
    selectedProviderInfo,
    selectedProviderQuery,
    selectedRecapMode,
    serviceTierOptions,
    sessionSandboxUnavailableReason,
    showThinkingControls,
    subscriptionUsage,
    supportsPermissionMode,
    supportsSessionSandboxing,
    thinkingModeOptions,
    visibleModels,
  } = options;
  const sessionDefaultCopy = getSessionDefaultControlCopy(t);
  const [showOptionCaptions, setShowOptionCaptions] = useState(false);
  const [showAdvancedOptions, setShowAdvancedOptions] = useState(
    () =>
      localStorage.getItem(UI_KEYS.newSessionAdvancedOptionsExpanded) ===
      "true",
  );
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
  const providerDescriptions: Record<ProviderName, string> = {
    claude: t("newSessionProviderDescriptionClaude"),
    "claude-gateway": t("newSessionProviderDescriptionClaudeGateway"),
    "claude-ollama": t("newSessionProviderDescriptionClaudeOllama"),
    codex: t("newSessionProviderDescriptionCodex"),
    "codex-oss": t("newSessionProviderDescriptionCodexOss"),
    gemini: t("newSessionProviderDescriptionGemini"),
    "gemini-acp": t("newSessionProviderDescriptionGeminiAcp"),
    antigravity: t("newSessionProviderDescriptionAntigravity"),
    grok: t("newSessionProviderDescriptionGrok"),
    opencode: t("newSessionProviderDescriptionOpenCode"),
    pi: t("newSessionProviderDescriptionPi"),
  };
  const promptSuggestionModeDescriptions: Record<PromptSuggestionMode, string> =
    {
      off: t("promptSuggestionModeOffDescription"),
      native: t("promptSuggestionModeNativeDescription"),
    };
  const recapAfterSecondsInlineLabels: Record<RecapMode, string> = {
    off: t("recapAfterSecondsLabel"),
    native: t("recapAfterSecondsInlineNative"),
    "side-session": t("recapAfterSecondsInlineSideSession"),
    fork: t("recapAfterSecondsInlineFork"),
  };

  const availableRecapModes = RECAP_MODE_ORDER;
  const availablePromptSuggestionModes = PROMPT_SUGGESTION_MODE_ORDER;
  const showHelperSideModel = selectedRecapMode === "side-session";
  // Build model options for FilterDropdown
  const modelOptions = useMemo((): FilterOption<string>[] => {
    return visibleModels.map((model, index) => {
      const label = model.size
        ? `${model.name} (${(model.size / (1024 * 1024 * 1024)).toFixed(1)} GB)`
        : model.name;

      const unavailable = routerModelList.unavailable.get(model.id);
      let description = unavailable
        ? t(ROUTER_MODEL_UNAVAILABLE[unavailable])
        : model.description;
      if (!description) {
        const parts: string[] = [];
        if (model.parameterSize) parts.push(model.parameterSize);
        if (model.contextWindow) {
          parts.push(formatContextWindowLabel(model.contextWindow));
        }
        if (model.parentModel) parts.push(model.parentModel);
        if (model.quantizationLevel) parts.push(model.quantizationLevel);
        if (parts.length > 0) description = parts.join(" · ");
      }

      return {
        value: model.id,
        label,
        description,
        disabled: !!unavailable,
        groupLabelBefore: startsAdditionalModelGroup(visibleModels, index)
          ? t("previousModelsGroup")
          : undefined,
        // Reuse the session-header/tooltip badge so the model's route (e.g.
        // pi's "copilot") is visible in the picker, in the same provider →
        // route → model order the badge already establishes.
        icon: selectedProvider ? (
          <ProviderBadge provider={selectedProvider} model={model.id} />
        ) : undefined,
        meta: (
          <ModelSubscriptionUsage
            usage={subscriptionUsage}
            modelId={model.id}
          />
        ),
      };
    });
  }, [
    routerModelList.unavailable,
    selectedProvider,
    subscriptionUsage,
    t,
    visibleModels,
  ]);

  const optionPlaceholder = (
    className: string | undefined,
    title: string,
    caption: string | undefined,
    triggerClassName?: string,
    triggerContent?: ReactNode,
  ) => (
    <NewSessionOptionSection
      className={className}
      title={title}
      caption={caption}
      showCaption={showOptionCaptions}
      placeholder
    >
      <FilterDropdown
        label={title}
        options={[]}
        selected={[]}
        onChange={() => {}}
        fullWidth
        triggerClassName={triggerClassName}
        triggerContent={triggerContent}
      />
    </NewSessionOptionSection>
  );
  const providerSection =
    providerChoices.length > 1 ? (
      <NewSessionOptionSection
        className={`${optionStyles.newSessionProviderSection} ${styles.compactProviderSection}`}
        title={sessionDefaultCopy.provider.title}
        caption={sessionDefaultCopy.provider.description}
        showCaption={showOptionCaptions}
      >
        <div
          aria-busy={
            providersLoading || providersStale || displayDefaultsPending
          }
        >
          <FilterDropdown<ProviderName>
            label={sessionDefaultCopy.provider.title}
            triggerClassName={styles.providerTrigger}
            options={providerChoices.map((provider) => ({
              value: provider.name,
              label: provider.displayName,
              icon: (
                <span
                  className={`${dotStyles["provider-option-dot"]} ${composerOptionDotStateClasses[`provider-${provider.name}`] ?? ""}`}
                />
              ),
              description: [
                providerDescriptions[provider.name],
                provider.installed === false
                  ? t("newSessionProviderStatusNotInstalled")
                  : provider.authenticated === false &&
                      provider.enabled === false
                    ? t("newSessionProviderStatusAuthenticationNeeded")
                    : null,
              ]
                .filter(Boolean)
                .join(" · "),
              disabled: provider.installed === false,
            }))}
            selected={selectedProvider ? [selectedProvider] : []}
            onChange={([provider]) => {
              if (provider && !isStarting) handleProviderSelect(provider);
            }}
            multiSelect={false}
            fullWidth
            triggerContent={
              selectedProvider ? (
                <span className={styles.selectedChoice}>
                  <span
                    className={`${dotStyles["provider-option-dot"]} ${composerOptionDotStateClasses[`provider-${selectedProvider}`] ?? ""}`}
                    aria-hidden="true"
                  />
                  <span className={styles.selectedChoiceText}>
                    <span>
                      {providerChoices.find(
                        (provider) => provider.name === selectedProvider,
                      )?.displayName ?? selectedProvider}
                    </span>
                    {selectedProviderInfo &&
                      !routerSelection &&
                      !selectedProviderInfo.authenticated &&
                      !selectedProviderInfo.enabled && (
                        <span className={styles.choiceStatus}>
                          {t("newSessionProviderStatusAuthenticationNeeded")}
                        </span>
                      )}
                  </span>
                </span>
              ) : undefined
            }
          />
        </div>
      </NewSessionOptionSection>
    ) : (
      optionPlaceholder(
        `${optionStyles.newSessionProviderSection} ${styles.compactProviderSection}`,
        sessionDefaultCopy.provider.title,
        sessionDefaultCopy.provider.description,
        styles.providerTrigger,
      )
    );
  const modelField =
    selectedProvider && modelOptions.length > 0 ? (
      <NewSessionOptionSection
        className={optionStyles.newSessionModelField}
        title={sessionDefaultCopy.model.title}
        caption={sessionDefaultCopy.model.description}
        showCaption={showOptionCaptions}
      >
        <FilterDropdown
          panelVariant="model"
          label={sessionDefaultCopy.model.title}
          options={modelOptions}
          selected={selectedModel ? [selectedModel] : []}
          onChange={handleModelSelect}
          multiSelect={false}
          placeholder={t("newSessionModelPlaceholder")}
          fullWidth
          triggerClassName={styles.leftAlignedTrigger}
          triggerContent={
            selectedProvider && selectedModel ? (
              <span className={styles.selectedChoice}>
                <ProviderBadge
                  provider={selectedProvider}
                  model={selectedModel}
                />
                <span className={styles.selectedChoiceText}>
                  {modelOptions.find((option) => option.value === selectedModel)
                    ?.label ?? selectedModel}
                </span>
              </span>
            ) : undefined
          }
        />
      </NewSessionOptionSection>
    ) : (
      optionPlaceholder(
        optionStyles.newSessionModelField,
        sessionDefaultCopy.model.title,
        sessionDefaultCopy.model.description,
        undefined,
        <span className={styles.selectedChoice}>
          <ProviderBadge provider={selectedProvider ?? "claude"} />
          <span>{sessionDefaultCopy.model.title}</span>
        </span>,
      )
    );
  const gatewayCatalogUnavailable =
    selectedProvider === "claude-gateway" &&
    (!selectedProviderQuery.fresh || availableModels.length === 0);
  const modelCatalog = selectedProviderInfo?.modelCatalog;
  const modelCatalogAge = formatBriefAge(modelCatalog?.fetchedAt);
  const routerCatalogAge = formatBriefAge(routerCatalogAt);
  // Pool launches read their rows from the router, not this provider list.
  const routerCatalogNotice =
    !routerSelection || modelOptions.length === 0
      ? null
      : routerCatalogRefresh === "refreshing"
        ? {
            warning: false,
            message: t("newSessionModelCatalogRefreshing"),
            action: t("newSessionModelCatalogRefresh"),
          }
        : routerCatalogAge
          ? {
              warning: routerCatalogRefresh === "failed",
              message:
                routerCatalogRefresh === "failed"
                  ? t("newSessionModelCatalogRefreshFailed", {
                      age: routerCatalogAge,
                    })
                  : t("newSessionModelCatalogUpdated", {
                      age: routerCatalogAge,
                    }),
              action: t("newSessionModelCatalogRefresh"),
            }
          : null;
  const modelCatalogNotice = gatewayCatalogUnavailable
    ? {
        warning: true,
        message: selectedProviderQuery.refreshing
          ? t("newSessionGatewayCatalogLoading")
          : t("newSessionGatewayCatalogUnavailable"),
        action: t("newSessionGatewayCatalogRetry"),
      }
    : routerSelection ||
        !modelCatalog ||
        modelCatalog.source === "static" ||
        modelOptions.length === 0
      ? null
      : selectedProviderQuery.refreshing
        ? {
            warning: false,
            message: t("newSessionModelCatalogRefreshing"),
            action: t("newSessionModelCatalogRefresh"),
          }
        : modelCatalog.source === "fallback"
          ? {
              warning: true,
              message: t("newSessionModelCatalogFallback"),
              action: t("newSessionModelCatalogRefresh"),
            }
          : {
              warning: modelCatalog.error !== undefined,
              message: modelCatalog.error
                ? t("newSessionModelCatalogRefreshFailed", {
                    age: modelCatalogAge ?? "?",
                  })
                : t("newSessionModelCatalogUpdated", {
                    age: modelCatalogAge ?? "0m",
                  }),
              action: t("newSessionModelCatalogRefresh"),
            };
  const catalogNotice = routerCatalogNotice ?? modelCatalogNotice;
  const modelCatalogStatus = (
    <div
      className={
        catalogNotice?.warning
          ? styles.catalogStatus
          : styles.catalogStatusMuted
      }
      role="status"
      aria-live="polite"
      title={routerCatalogNotice ? undefined : modelCatalog?.error}
    >
      <span
        className={styles.catalogMessage}
        data-sizing-text={t("newSessionGatewayCatalogUnavailable")}
        title={routerSelection ? undefined : modelCatalog?.error}
      >
        <span>{catalogNotice?.message}</span>
      </span>
      <Button
        variant="ghost"
        size="small"
        className={styles.catalogAction}
        disabled={
          routerSelection
            ? routerCatalogRefresh === "refreshing"
            : selectedProvider
              ? selectedProviderQuery.refreshing
              : providersLoading
        }
        onClick={() =>
          void (routerSelection
            ? refreshRouterCatalog()
            : selectedProvider
              ? selectedProviderQuery.refresh()
              : refetchProviders())
        }
      >
        {catalogNotice?.action ?? t("newSessionModelCatalogRefresh")}
      </Button>
    </div>
  );
  const modelSection = (
    <div
      className={optionStyles.newSessionModelSection}
      data-new-session-model-section
    >
      {modelField}
    </div>
  );
  const showThinkingSection = (
    <NewSessionOptionSection
      className={`${optionStyles.newSessionHelperSection} new-session-show-thinking-section`}
      title={sessionDefaultCopy.showThinking.title}
      caption={sessionDefaultCopy.showThinking.description}
      showCaption={showOptionCaptions}
    >
      <FilterDropdown<"default" | "on" | "off">
        label={sessionDefaultCopy.showThinking.title}
        options={[
          { value: "default", label: t("showThinkingDefault") },
          { value: "on", label: t("showThinkingOn") },
          { value: "off", label: t("showThinkingOff") },
        ]}
        selected={[showThinking]}
        onChange={([value]) => setShowThinking(value ?? "default")}
        multiSelect={false}
        fullWidth
        triggerClassName={styles.leftAlignedTrigger}
      />
    </NewSessionOptionSection>
  );
  const serviceTierSection =
    serviceTierOptions.length > 0 ? (
      <NewSessionOptionSection
        className={optionStyles.newSessionHelperSection}
        title={t("newSessionServiceTierTitle")}
        caption={t("newSessionServiceTierDescription")}
        showCaption={showOptionCaptions}
      >
        <FilterDropdown<string>
          label={t("newSessionServiceTierTitle")}
          options={[
            {
              value: "",
              label: t("serviceTierStandardLabel"),
              description: t("serviceTierStandardDescription"),
            },
            ...serviceTierOptions.map((tier) => ({
              value: tier.id,
              label: tier.name,
              description: tier.description,
            })),
          ]}
          selected={[effectiveServiceTier ?? ""]}
          onChange={([value]) => {
            customizeOptions({
              type: "choose",
              field: "selectedServiceTier",
              value: value || null,
            });
          }}
          multiSelect={false}
          fullWidth
          triggerClassName={styles.leftAlignedTrigger}
        />
      </NewSessionOptionSection>
    ) : null;
  const effortSection = showThinkingControls ? (
    <NewSessionOptionSection
      className={`${optionStyles.newSessionHelperSection} ${styles.effortSection}`}
      title={t("newSessionThinkingEffortTitle")}
      caption={sessionDefaultCopy.thinking.description}
      showCaption={showOptionCaptions}
    >
      <FilterDropdown<string>
        label={t("newSessionThinkingEffortTitle")}
        options={[
          ...thinkingModeOptions
            .filter((option) => option !== "on")
            .map((option) => ({
              value: option,
              label: t(
                option === "off"
                  ? "modelSettingsThinkingOffLabel"
                  : "modelSettingsThinkingAutoLabel",
              ),
              icon: (
                <span
                  className={`${dotStyles["mode-option-dot"]} ${composerOptionDotStateClasses[`thinking-${option}`] ?? ""}`}
                  data-mode-option-dot
                />
              ),
            })),
          ...(thinkingModeOptions.includes("on")
            ? effortOptions.map((option) => ({
                value: `on:${option.value}`,
                label: option.label,
                icon: (
                  <span
                    className={`${dotStyles.modelSwitchIndicatorDot} ${composerOptionDotStateClasses[`tone-${option.value}`] ?? ""}`}
                  />
                ),
                description: showOptionCaptions
                  ? option.description
                  : undefined,
              }))
            : []),
        ]}
        selected={[
          effectiveThinkingMode === "on"
            ? `on:${effectiveEffortLevel}`
            : effectiveThinkingMode,
        ]}
        onChange={([selection]) => {
          if (!selection || isStarting) return;
          customizeOptions({
            type: "chooseThinking",
            selection,
            effortOptions,
          });
        }}
        multiSelect={false}
        fullWidth
        triggerContent={
          <span className={styles.selectedChoice}>
            <span
              className={
                effectiveThinkingMode === "on"
                  ? `${dotStyles.modelSwitchIndicatorDot} ${composerOptionDotStateClasses[`tone-${effectiveEffortLevel}`] ?? ""}`
                  : `${dotStyles["mode-option-dot"]} ${composerOptionDotStateClasses[`thinking-${effectiveThinkingMode}`] ?? ""}`
              }
              data-model-switch-indicator-dot={
                effectiveThinkingMode === "on" || undefined
              }
              data-mode-option-dot={
                !(effectiveThinkingMode === "on") || undefined
              }
              aria-hidden="true"
            />
            <span className={styles.selectedChoiceText}>
              {effectiveThinkingMode === "on"
                ? (effortOptions.find(
                    (option) => option.value === effectiveEffortLevel,
                  )?.label ?? effectiveEffortLevel)
                : t(
                    effectiveThinkingMode === "off"
                      ? "modelSettingsThinkingOffLabel"
                      : "modelSettingsThinkingAutoLabel",
                  )}
            </span>
          </span>
        }
      />
    </NewSessionOptionSection>
  ) : null;
  const effortSlot =
    effortSection ??
    (!launchLock.effort
      ? optionPlaceholder(
          `${optionStyles.newSessionHelperSection} ${styles.effortSection}`,
          t("newSessionThinkingEffortTitle"),
          sessionDefaultCopy.thinking.description,
        )
      : null);
  const recapSection = selectedProvider ? (
    <NewSessionOptionSection
      className={optionStyles.newSessionHelperSection}
      title={sessionDefaultCopy.recap.title}
      caption={getRecapModeDescription(selectedRecapMode, t, recapAfterSeconds)}
      showCaption={showOptionCaptions}
    >
      <FilterDropdown<RecapMode>
        label={sessionDefaultCopy.recap.title}
        options={availableRecapModes.map((modeValue) => ({
          value: modeValue,
          label: recapModeLabels[modeValue],
          icon: (
            <span
              className={`${dotStyles["mode-option-dot"]} ${composerOptionDotStateClasses[`recap-${modeValue}`] ?? ""}`}
              data-mode-option-dot
            />
          ),
          description: showOptionCaptions
            ? getRecapModeDescription(modeValue, t, recapAfterSeconds)
            : undefined,
          disabled:
            isStarting ||
            (effectiveSandboxLevel === "project-write" &&
              modeValue === "side-session"),
        }))}
        selected={[selectedRecapMode]}
        onChange={([value]) => {
          if (isStarting) return;
          customizeOptions({
            type: "choose",
            field: "selectedRecapMode",
            value: value ?? "off",
          });
        }}
        multiSelect={false}
        fullWidth
        triggerContent={
          <span className={styles.selectedChoice}>
            <span
              className={`${dotStyles["mode-option-dot"]} ${composerOptionDotStateClasses[`recap-${selectedRecapMode}`] ?? ""}`}
              data-mode-option-dot
              aria-hidden="true"
            />
            <span className={styles.selectedChoiceText}>
              {recapModeLabels[selectedRecapMode]}
            </span>
          </span>
        }
      />
      {selectedRecapMode !== "off" && (
        <RecapAfterSecondsControl
          value={recapAfterSeconds}
          disabled={isStarting}
          className={
            showOptionCaptions ? styles.captionedRecapDuration : undefined
          }
          label={
            showOptionCaptions
              ? recapAfterSecondsInlineLabels[selectedRecapMode]
              : undefined
          }
          mode={selectedRecapMode}
          onCommit={(seconds) => {
            customizeOptions({
              type: "choose",
              field: "recapAfterSeconds",
              value: seconds,
            });
          }}
        />
      )}
    </NewSessionOptionSection>
  ) : null;
  const helperSideModelSection = showHelperSideModel ? (
    <NewSessionOptionSection
      className={`${optionStyles.newSessionHelperSection} new-session-helper-model-section`}
      title={sessionDefaultCopy.helperModel.title}
      caption={sessionDefaultCopy.helperModel.description}
      showCaption={showOptionCaptions}
    >
      <FilterDropdown
        label={sessionDefaultCopy.helperModel.title}
        options={helperSideModelOptions}
        selected={[helperSideModel]}
        onChange={(selected) => {
          customizeOptions({
            type: "choose",
            field: "helperSideModel",
            value: selected[0] ?? HELPER_SIDE_MODEL_CHEAPEST,
          });
        }}
        multiSelect={false}
        placeholder={t("helperSideModelCheapest")}
        fullWidth
        triggerClassName={styles.leftAlignedTrigger}
      />
    </NewSessionOptionSection>
  ) : null;
  const promptSuggestionSection = selectedProvider ? (
    <NewSessionOptionSection
      className={optionStyles.newSessionHelperSection}
      title={sessionDefaultCopy.suggestions.title}
      caption={promptSuggestionModeDescriptions[selectedPromptSuggestionMode]}
      showCaption={showOptionCaptions}
    >
      <FilterDropdown<PromptSuggestionMode>
        label={sessionDefaultCopy.suggestions.title}
        options={availablePromptSuggestionModes.map((modeValue) => ({
          value: modeValue,
          label: promptSuggestionModeLabels[modeValue],
          icon: (
            <span
              className={`${dotStyles["mode-option-dot"]} ${composerOptionDotStateClasses[`suggestion-${modeValue}`] ?? ""}`}
              data-mode-option-dot
            />
          ),
          description: showOptionCaptions
            ? promptSuggestionModeDescriptions[modeValue]
            : undefined,
          disabled: isStarting,
        }))}
        selected={[selectedPromptSuggestionMode]}
        onChange={([value]) => {
          if (isStarting) return;
          customizeOptions({
            type: "choose",
            field: "selectedPromptSuggestionMode",
            value: value ?? "off",
          });
        }}
        multiSelect={false}
        fullWidth
        triggerContent={
          <span className={styles.selectedChoice}>
            <span
              className={`${dotStyles["mode-option-dot"]} ${composerOptionDotStateClasses[`suggestion-${selectedPromptSuggestionMode}`] ?? ""}`}
              data-mode-option-dot
              aria-hidden="true"
            />
            <span className={styles.selectedChoiceText}>
              {promptSuggestionModeLabels[selectedPromptSuggestionMode]}
            </span>
          </span>
        }
      />
    </NewSessionOptionSection>
  ) : null;
  const permissionSection = supportsPermissionMode ? (
    <NewSessionOptionSection
      className={optionStyles.newSessionModeSection}
      title={sessionDefaultCopy.permission.title}
      showCaption={showOptionCaptions}
    >
      <FilterDropdown<PermissionMode>
        label={sessionDefaultCopy.permission.title}
        options={permissionModeOptions.map((permissionMode) => ({
          value: permissionMode,
          label: modeLabels[permissionMode],
          icon: (
            <span
              className={`${dotStyles["mode-option-dot"]} ${composerOptionDotStateClasses[`mode-${permissionMode}`] ?? ""}`}
              data-mode-option-dot
            />
          ),
          description: modeDescriptions[permissionMode],
          disabled: isStarting,
        }))}
        selected={[effectivePermissionMode]}
        onChange={([value]) => {
          if (value && !isStarting) handleModeSelect(value);
        }}
        multiSelect={false}
        fullWidth
        triggerContent={
          <span className={styles.selectedChoice}>
            <span
              className={`${dotStyles["mode-option-dot"]} ${composerOptionDotStateClasses[`mode-${effectivePermissionMode}`] ?? ""}`}
              data-mode-option-dot
              aria-hidden="true"
            />
            <span className={styles.selectedChoiceText}>
              {modeLabels[effectivePermissionMode]}
            </span>
          </span>
        }
      />
    </NewSessionOptionSection>
  ) : null;
  const sandboxSection = canConfigureSessionSandbox ? (
    <>
      {!launchLock.limited && (
        <NewSessionOptionSection
          className={`${optionStyles.newSessionHelperSection} ${optionStyles.newSessionSandboxSection}`}
          title={sessionDefaultCopy.sandbox.title}
          caption={sessionDefaultCopy.sandbox.description}
          showCaption={showOptionCaptions}
        >
          <FilterDropdown<SessionSandboxLevel>
            label={sessionDefaultCopy.sandbox.title}
            options={[
              { value: "none", label: t("recapModeOff"), disabled: isStarting },
              {
                value: "project-write",
                label: t("newSessionSandboxLabel"),
                description: showOptionCaptions
                  ? sessionDefaultCopy.sandbox.description
                  : undefined,
                disabled: isStarting,
              },
            ]}
            selected={[sandboxLevel]}
            onChange={([value]) => {
              if (isStarting) return;
              const enabled = value === "project-write";
              customizeOptions({ type: "toggleSandbox", enabled });
            }}
            multiSelect={false}
            fullWidth
            triggerClassName={styles.leftAlignedTrigger}
          />
          {sandboxLocalAuthOpen && (
            <Banner
              tone="warning"
              compact
              className={styles.optionWarning}
              data-new-session-sandbox-local-auth-warning="true"
            >
              {t("newSessionSandboxLocalAuthWarning")}
            </Banner>
          )}
        </NewSessionOptionSection>
      )}
      {effectiveSandboxLevel === "project-write" && !launchLock.limited && (
        <NewSessionOptionSection
          className={`${optionStyles.newSessionHelperSection} new-session-sandbox-firewall-section`}
          title={sessionDefaultCopy.sandboxFirewall.title}
          caption={sessionDefaultCopy.sandboxFirewall.description}
          showCaption={showOptionCaptions}
        >
          <FilterDropdown<"on" | "off">
            label={sessionDefaultCopy.sandboxFirewall.title}
            options={[
              { value: "on", label: t("showThinkingOn"), disabled: isStarting },
              {
                value: "off",
                label: t("showThinkingOff"),
                description: showOptionCaptions
                  ? sessionDefaultCopy.sandboxFirewall.description
                  : undefined,
                disabled: isStarting,
              },
            ]}
            selected={[sandboxNetworkFirewall ? "on" : "off"]}
            onChange={([value]) => {
              if (isStarting) return;
              customizeOptions({
                type: "choose",
                field: "sandboxNetworkFirewall",
                value: value === "on",
              });
            }}
            multiSelect={false}
            fullWidth
            triggerClassName={styles.leftAlignedTrigger}
          />
        </NewSessionOptionSection>
      )}
    </>
  ) : sessionSandboxUnavailableReason ? (
    <NewSessionOptionSection
      className={`${optionStyles.newSessionHelperSection} ${optionStyles.newSessionSandboxSection}`}
      title={sessionDefaultCopy.sandbox.title}
      showCaption={showOptionCaptions}
    >
      <p
        className={styles.optionCaption}
        data-new-session-sandbox-unavailable="true"
      >
        {sessionSandboxUnavailableReason}
      </p>
    </NewSessionOptionSection>
  ) : null;
  // What this account settles, stated where the withheld pickers would sit.
  // An effort this client cannot name is stated as stored.
  const lockedEffortLevel = knownLockedEffort(launchLock);
  const fixedLaunchSection = launchLock.limited ? (
    <NewSessionFixedLaunch
      lock={launchLock}
      modelLabel={
        launchLock.model
          ? (visibleModels.find((model) => model.id === launchLock.model)
              ?.name ?? null)
          : null
      }
      effortLabel={
        lockedEffortLevel
          ? getEffortLevelLabel(lockedEffortLevel, selectedProviderInfo, t)
          : null
      }
      sandboxAvailable={supportsSessionSandboxing}
    />
  ) : null;
  const activeAdvancedOptions = [
    effectivePermissionMode !== "default"
      ? `${sessionDefaultCopy.permission.title}: ${modeLabels[effectivePermissionMode]}`
      : null,
    effectiveServiceTier
      ? `${t("newSessionServiceTierTitle")}: ${serviceTierLabel(effectiveServiceTier, serviceTierOptions, t)}`
      : null,
    showThinking !== "default"
      ? `${sessionDefaultCopy.showThinking.title}: ${showThinking === "on" ? t("showThinkingOn") : t("showThinkingOff")}`
      : null,
    selectedRecapMode !== "off"
      ? `${sessionDefaultCopy.recap.title}: ${recapModeLabels[selectedRecapMode]}`
      : null,
    selectedPromptSuggestionMode !== "off"
      ? `${sessionDefaultCopy.suggestions.title}: ${promptSuggestionModeLabels[selectedPromptSuggestionMode]}`
      : null,
    effectiveSandboxLevel === "project-write"
      ? sessionDefaultCopy.sandbox.title
      : null,
    machineControlSelected && machineControlEligible
      ? t("newSessionMachineControlTitle")
      : null,
    routerClaudeAiConnectors ? t("newSessionClaudeAiConnectorsTitle") : null,
  ].filter((label): label is string => label !== null);

  return (
    <>
      {providerSlotFilled && (
        <div
          className={optionStyles.newSessionProviderSlot}
          data-new-session-provider-slot
        >
          {fixedLaunchSection}
          {showProviderPicker && providerSection}
          {showModelPicker && modelSection}
          {effortSlot}
          {showModelPicker && modelCatalogStatus}
        </div>
      )}
      <div className={styles.advancedSection}>
        <Button
          aria-expanded={showAdvancedOptions}
          aria-controls="new-session-advanced-options"
          onClick={() => {
            const expanded = !showAdvancedOptions;
            setShowAdvancedOptions(expanded);
            localStorage.setItem(
              UI_KEYS.newSessionAdvancedOptionsExpanded,
              String(expanded),
            );
          }}
        >
          <span>
            {t(
              showAdvancedOptions
                ? "newSessionHideAdvancedOptions"
                : "newSessionShowAdvancedOptions",
            )}
          </span>
          <span aria-hidden="true">{showAdvancedOptions ? "▴" : "▾"}</span>
        </Button>
        {!showAdvancedOptions && activeAdvancedOptions.length > 0 && (
          <span className={styles.advancedSummary}>
            {activeAdvancedOptions.join(" · ")}
          </span>
        )}
        <IconButton
          size="small"
          label={
            showOptionCaptions
              ? t("newSessionHideOptionCaptions")
              : t("newSessionShowOptionCaptions")
          }
          className={styles.captionToggle}
          aria-pressed={showOptionCaptions}
          onClick={() => setShowOptionCaptions((shown) => !shown)}
        >
          <span aria-hidden="true">?</span>
        </IconButton>
      </div>
      <div
        id="new-session-advanced-options"
        className={`${styles.secondaryOptions}${isProjectChooserExpanded ? ` ${styles.secondaryOptionsHidden}` : ""}`}
        data-new-session-secondary-options="true"
        hidden={!showAdvancedOptions}
      >
        {serverHasCapability(
          versionInfo,
          SERVER_CAPABILITIES.agentAuthRouter.name,
        ) &&
          !launchLock.limited &&
          effectiveSandboxLevel === "none" &&
          (selectedProvider === "claude" || selectedProvider === "codex") && (
            <RouterPoolSelector
              provider={selectedProvider}
              model={selectedModel}
              thinking={routerThinking}
              serviceTier={effectiveServiceTier}
              data={routerDiscovery.data}
              busy={routerDiscovery.busy}
              error={routerDiscovery.error}
              retry={() => void routerDiscovery.reload()}
              sourceKey={clientSummarySourceKey}
              value={
                routerSelection?.sourceKey === clientSummarySourceKey
                  ? routerSelection
                  : null
              }
              onChange={(selection) => {
                customizeOptions({ type: "chooseRouter", selection });
              }}
              disabled={isStarting}
              showCaption={showOptionCaptions}
            />
          )}
        {!launchLock.limited && effectiveSandboxLevel === "none" && (
          <RouterClaudeAiConnectorsSelection
            support={claudeAiConnectorsSupport}
            selected={routerClaudeAiConnectors}
            onChange={(value) => {
              customizeOptions({
                type: "choose",
                field: "routerConnectorsChoice",
                value,
              });
            }}
            disabled={isStarting}
            showCaption={showOptionCaptions}
          />
        )}
        {permissionSection}
        {serviceTierSection}
        {showThinkingSection}
        {recapSection}
        {helperSideModelSection}
        {promptSuggestionSection}
        {sandboxSection}
        <MachineControlSessionSelection
          eligible={machineControlEligible}
          selected={machineControlSelected}
          onChange={selectMachineControl}
          disabled={isStarting}
          showCaption={showOptionCaptions}
        />
      </div>
    </>
  );
}
