import {
  type EffortLevel,
  type ModelInfo,
  type ModelServiceTier,
  type ProviderName,
  SERVER_CAPABILITIES,
  serverHasCapability,
  type ThinkingOption,
} from "@yep-anywhere/shared";
import {
  Fragment,
  type ReactNode,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { api } from "../api/client";
import {
  getEffortLevel,
  getShowThinkingSetting,
  getThinkingMode,
  useModelSettings,
} from "../hooks/useModelSettings";
import { useProviderSubscriptionUsage } from "../hooks/useProviderSubscriptionUsage";
import { useVersion } from "../hooks/useVersion";
import { useI18n } from "../i18n";
import {
  getEffortLevelLabel,
  getEffortLevelOptions,
  getThinkingModeOptions,
  resolveSupportedEffortLevel,
  resolveSupportedThinkingMode,
} from "../lib/effortLevels";
import {
  getIndicatorToneFromProcess,
  getIndicatorToneFromSelection,
  getThinkingModeFromProcess,
  normalizeEffortLevel,
} from "../lib/modelConfigIndicator";
import {
  startsAdditionalModelGroup,
  withVisibleModelSelection,
} from "../lib/modelCatalog";
import {
  isStandardServiceTier,
  selectableServiceTiers,
  serviceTierLabel,
} from "../lib/serviceTiers";
import { ProviderBadge } from "./ProviderBadge";
import { ModelSubscriptionUsage } from "./ModelSubscriptionUsage";
import { Badge } from "./ui/Badge";
import { Banner } from "./ui/Banner";
import { Button } from "./ui/Button";
import { Dialog } from "./ui/Dialog";
import { SegmentedControl } from "./ui/SegmentedControl";
import { Spinner } from "./ui/Spinner";
import { TabPanel, Tabs } from "./ui/Tabs";

/** The pane is a tab panel only when the info tab exists. */
function MaybeTabPanel({
  tabsId,
  value,
  children,
}: {
  tabsId?: string;
  value: string;
  children: ReactNode;
}) {
  return tabsId ? (
    <TabPanel
      tabsId={tabsId}
      value={value}
      focusable={value === "info"}
      className="model-switch-pane"
    >
      {children}
    </TabPanel>
  ) : (
    children
  );
}

export type SessionModelPanelTab = "model" | "account" | "info";

interface ModelSwitchModalProps {
  /** Session uses an AAR account pin. */
  routed?: boolean;
  /** Live owned process id; absent when the session isn't an owned live process. */
  processId?: string;
  sessionId: string;
  currentModel?: string;
  /** Session provider, for effort labels/tones when no process is live. */
  sessionProvider?: ProviderName;
  onModelChanged: (next: {
    processId: string;
    model?: string;
    thinking?: { type: string };
    effort?: string;
  }) => void;
  /**
   * Long-context effort-change gate (topics/mid-session-effort-change.md).
   * Called before applying a config whose effort differs from the current
   * one; `skip` means the user cancelled or forked instead, so nothing is
   * applied here.
   */
  guardEffortChange?: (
    nextThinking: ThinkingOption,
    currentThinking: ThinkingOption,
    options: { changesModel: boolean },
  ) => Promise<"apply" | "skip">;
  /** When provided, renders an "Info" tab whose pane is this node. */
  infoPane?: ReactNode;
  accountPane?: ReactNode;
  /** Which tab is focused on open (default "model"). */
  initialTab?: SessionModelPanelTab;
  /**
   * Spawn a live process for a reaped session without sending a turn
   * (message-less reactivate). When provided, the Model tab's "No active
   * process" note becomes an Activate button; on success the parent flips
   * ownership so `processId` arrives and the full options load.
   */
  onActivate?: () => Promise<void>;
  onClose: () => void;
}

type ThinkingMode = "off" | "auto" | "on";
/** Speed picker value for Standard (null tier); never a selectable tier id. */
const STANDARD_SERVICE_TIER = "default";
type DirtySection = "thinking" | "effort" | "model" | null;

function toThinkingOption(
  mode: ThinkingMode,
  effort: EffortLevel,
): "off" | "auto" | `on:${EffortLevel}` {
  if (mode === "off") return "off";
  if (mode === "auto") return "auto";
  return `on:${effort}`;
}

function sameSelection(
  modelA: string | undefined,
  modeA: ThinkingMode,
  effortA: EffortLevel,
  modelB: string | undefined,
  modeB: ThinkingMode,
  effortB: EffortLevel,
): boolean {
  if (modelA !== modelB || modeA !== modeB) {
    return false;
  }
  if (modeA !== "on") {
    return true;
  }
  return effortA === effortB;
}

export function ModelSwitchModal({
  routed = false,
  processId,
  sessionId,
  currentModel,
  sessionProvider,
  onModelChanged,
  guardEffortChange,
  infoPane,
  accountPane,
  initialTab,
  onActivate,
  onClose,
}: ModelSwitchModalProps) {
  const { t } = useI18n();
  const { setThinkingMode, setEffortLevel } = useModelSettings();
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [provider, setProvider] = useState<ProviderName | null>(null);
  const { usage: subscriptionUsage } = useProviderSubscriptionUsage(provider);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [switching, setSwitching] = useState(false);
  const [currentThinkingMode, setCurrentThinkingMode] =
    useState<ThinkingMode>("off");
  const [currentEffortLevel, setCurrentEffortLevel] =
    useState<EffortLevel>("high");
  const [currentModelId, setCurrentModelId] = useState<string | undefined>(
    currentModel,
  );
  const [thinkingMode, setThinkingModeState] = useState<ThinkingMode>("off");
  const [effortLevel, setEffortLevelState] = useState<EffortLevel>("high");
  const [selectedModel, setSelectedModel] = useState<string | undefined>(
    currentModel,
  );
  const [lastTouchedSection, setLastTouchedSection] =
    useState<DirtySection>(null);
  const [activeTab, setActiveTab] = useState<SessionModelPanelTab>(
    initialTab ?? "model",
  );
  const tabsId = useId();
  const contentRef = useRef<HTMLDivElement>(null);
  const dismissedRef = useRef(false);
  const [activating, setActivating] = useState(false);
  const [activateError, setActivateError] = useState<string | null>(null);
  /** Live process tier; null is Standard. */
  const [currentServiceTier, setCurrentServiceTier] = useState<string | null>(
    null,
  );
  const [savingServiceTier, setSavingServiceTier] = useState(false);
  const [routedServiceTierSelection, setRoutedServiceTierSelection] =
    useState(false);
  const { version } = useVersion();
  const supportsServiceTierChange = serverHasCapability(
    version,
    SERVER_CAPABILITIES.processServiceTierChange,
  );

  useEffect(() => {
    if (!processId) {
      // No live process: the status row shows what the next send will
      // request. The idle-send path resolves thinking via
      // getThinkingSetting() (getImplicitComposerThinking in SessionPage),
      // which reads the same stored mode/effort the composer's thinking
      // chooser edits while the session is idle.
      const requestedMode = getThinkingMode();
      const requestedEffort = getEffortLevel();
      setProvider(sessionProvider ?? null);
      setCurrentThinkingMode(requestedMode);
      setThinkingModeState(requestedMode);
      setCurrentEffortLevel(requestedEffort);
      setEffortLevelState(requestedEffort);
      setLoading(false);
      return;
    }
    // processId may have just appeared (e.g. after Activate) - show the spinner
    // while models load rather than flashing the empty state.
    setLoading(true);
    let cancelled = false;

    Promise.all([
      api.getProcessModels(processId),
      api.getProcessInfo(sessionId),
    ])
      .then(([modelsRes, processRes]) => {
        if (cancelled) return;

        const process = processRes.process;
        const resolvedModel =
          process?.model ?? currentModel ?? modelsRes.models[0]?.id;
        const processProvider = process?.provider ?? null;
        const resolvedEffort = normalizeEffortLevel(
          process?.effort,
          processProvider,
        );
        const resolvedThinkingMode = getThinkingModeFromProcess(
          process?.thinking,
          process?.effort,
        );

        setRoutedServiceTierSelection(modelsRes.serviceTierSelection === true);
        setModels(
          withVisibleModelSelection(
            modelsRes.models,
            resolvedModel,
            t("modelSelectionUnavailable"),
          ),
        );
        setProvider(processProvider);
        setCurrentModelId(resolvedModel);
        setSelectedModel(resolvedModel);
        setCurrentThinkingMode(resolvedThinkingMode);
        setThinkingModeState(resolvedThinkingMode);
        setCurrentEffortLevel(resolvedEffort);
        setEffortLevelState(resolvedEffort);
        setCurrentServiceTier(
          isStandardServiceTier(process?.serviceTier)
            ? null
            : (process?.serviceTier ?? null),
        );
        setLastTouchedSection(null);
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err.message || t("modelSwitchLoadFailed"));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [currentModel, processId, sessionId, sessionProvider, t]);

  const selectedModelInfo = useMemo(
    () => models.find((model) => model.id === selectedModel) ?? null,
    [models, selectedModel],
  );
  const effortOptions = useMemo(
    () =>
      getEffortLevelOptions({
        provider,
        model: selectedModelInfo,
        translate: t,
      }),
    [provider, selectedModelInfo, t],
  );
  const effectiveEffortLevel = resolveSupportedEffortLevel(
    effortLevel,
    effortOptions,
  );
  const thinkingModeOptions = useMemo(
    () =>
      getThinkingModeOptions({
        provider,
        model: selectedModelInfo,
        effortOptions,
      }),
    [effortOptions, provider, selectedModelInfo],
  );
  const effectiveThinkingMode = resolveSupportedThinkingMode(
    thinkingMode,
    thinkingModeOptions,
  );
  const showEffortOptions = thinkingModeOptions.includes("on");
  // Tiers belong to the running model; a model switch keeps the current tier
  // and Codex drops it for a model that does not offer it.
  const currentModelInfo = useMemo(
    () => models.find((model) => model.id === currentModelId) ?? null,
    [models, currentModelId],
  );
  const serviceTierOptions = useMemo((): ModelServiceTier[] => {
    const offered = selectableServiceTiers(currentModelInfo?.serviceTiers);
    if (
      currentServiceTier &&
      !offered.some((tier) => tier.id === currentServiceTier)
    ) {
      offered.push({
        id: currentServiceTier,
        name: serviceTierLabel(currentServiceTier, undefined, t),
      });
    }
    return offered;
  }, [currentModelInfo, currentServiceTier, t]);
  const showServiceTierOptions =
    !!processId &&
    supportsServiceTierChange &&
    (!routed || routedServiceTierSelection) &&
    serviceTierOptions.length > 0;

  const dirty =
    !loading &&
    !sameSelection(
      currentModelId,
      currentThinkingMode,
      currentEffortLevel,
      selectedModel,
      effectiveThinkingMode,
      effectiveEffortLevel,
    );

  const applyConfig = async (afterApply?: () => void) => {
    if (switching || !selectedModel || !processId) return;
    setSwitching(true);
    setError(null);
    try {
      const thinking = toThinkingOption(
        effectiveThinkingMode,
        effectiveEffortLevel,
      );
      if (guardEffortChange) {
        const verdict = await guardEffortChange(
          thinking,
          toThinkingOption(currentThinkingMode, currentEffortLevel),
          { changesModel: selectedModel !== currentModelId },
        );
        if (verdict === "skip") {
          if (!dismissedRef.current) setSwitching(false);
          return;
        }
      }
      const result = await api.setProcessConfig(processId, {
        model: selectedModel,
        thinking,
        showThinking: getShowThinkingSetting(),
      });
      setThinkingMode(effectiveThinkingMode);
      setEffortLevel(effectiveEffortLevel);
      onModelChanged(result);
      if (!dismissedRef.current) {
        dismissedRef.current = true;
        onClose();
      }
      afterApply?.();
    } catch (err: unknown) {
      if (!dismissedRef.current) {
        setError(
          err instanceof Error ? err.message : t("modelSwitchChangeFailed"),
        );
        setSwitching(false);
      }
    }
  };

  // Speed applies on its own: a live tier change needs no restart, while
  // combining it with a model or effort change would force one.
  const applyServiceTier = async (serviceTier: string | null) => {
    if (!processId || savingServiceTier || serviceTier === currentServiceTier)
      return;
    setSavingServiceTier(true);
    setError(null);
    try {
      const result = await api.setProcessConfig(processId, { serviceTier });
      if (dismissedRef.current) return;
      setCurrentServiceTier(
        isStandardServiceTier(result.serviceTier)
          ? null
          : (result.serviceTier ?? null),
      );
    } catch (err: unknown) {
      if (!dismissedRef.current) {
        setError(
          err instanceof Error
            ? err.message
            : t("modelSwitchSpeedChangeFailed"),
        );
      }
    } finally {
      if (!dismissedRef.current) setSavingServiceTier(false);
    }
  };

  const handleDismiss = () => {
    if (dismissedRef.current) return;
    dismissedRef.current = true;
    onClose();
  };

  const handleTabChange = (tab: SessionModelPanelTab) => {
    setActiveTab(tab);
    contentRef.current?.scrollTo({ top: 0 });
  };

  const handleActivate = async () => {
    if (!onActivate || activating) return;
    setActivating(true);
    setActivateError(null);
    try {
      await onActivate();
      // On success the parent flips ownership; `processId` arrives as a prop,
      // the model-load effect fires, and the full options replace this note.
    } catch (err) {
      setActivateError(
        err instanceof Error ? err.message : t("modelSwitchActivateFailed"),
      );
    } finally {
      setActivating(false);
    }
  };

  const currentIndicatorTone = getIndicatorToneFromProcess(
    { type: currentThinkingMode === "off" ? "disabled" : "adaptive" },
    currentThinkingMode === "on" ? currentEffortLevel : undefined,
    provider,
  );
  const pendingIndicatorTone = getIndicatorToneFromSelection(
    effectiveThinkingMode,
    effectiveEffortLevel,
  );
  const renderThinkingLabel = (mode: ThinkingMode, effort: EffortLevel) => {
    if (mode === "off") return t("newSessionThinkingOff");
    if (mode === "auto") return t("newSessionThinkingAuto");
    return t("newSessionThinkingOn", {
      level: getEffortLevelLabel(effort, provider, t),
    });
  };
  const renderInlineSave = () => (
    <Button
      className="model-switch-inline-save"
      onClick={() => void applyConfig()}
      disabled={switching || !selectedModel}
    >
      {t("modelSwitchSaveAll")}
    </Button>
  );

  const hasTabs = Boolean(infoPane || accountPane);

  return (
    <Dialog
      title={t(
        activeTab === "info"
          ? "processInfoTitle"
          : activeTab === "account"
            ? "sessionAccountTab"
            : "modelSwitchTitle",
      )}
      size="large"
      onClose={handleDismiss}
      contentRef={contentRef}
      footer={
        dirty &&
        (!hasTabs || activeTab === "model") && (
          <>
            <Button onClick={handleDismiss}>{t("modalCancel")}</Button>
            <Button
              variant="primary"
              onClick={() => void applyConfig()}
              busy={switching}
              disabled={!selectedModel}
            >
              {t("modelSwitchSaveAll")}
            </Button>
          </>
        )
      }
    >
      {hasTabs && (
        <Tabs
          id={tabsId}
          className="model-switch-tabs"
          value={activeTab}
          onChange={handleTabChange}
          tabs={[
            { value: "model", label: t("newSessionModelTitle") },
            ...(accountPane
              ? [{ value: "account" as const, label: t("sessionAccountTab") }]
              : []),
            ...(infoPane
              ? [{ value: "info" as const, label: t("processInfoTitle") }]
              : []),
          ]}
        />
      )}
      <MaybeTabPanel tabsId={hasTabs ? tabsId : undefined} value={activeTab}>
        {accountPane && activeTab === "account" && accountPane}
        {infoPane && activeTab === "info" && (
          <div className="model-switch-info-pane">{infoPane}</div>
        )}
        {(!hasTabs || activeTab === "model") && loading && (
          <div className="model-switch-loading">
            <Spinner size="small" /> {t("modelSwitchLoading")}
          </div>
        )}

        {(!hasTabs || activeTab === "model") && !loading && (
          <>
            <div className="model-switch-status">
              <div className="model-switch-status-row">
                <span className="model-switch-status-marker">
                  {processId
                    ? t("modelSwitchCurrent")
                    : t("modelSwitchNextSend")}
                </span>
                <span
                  className={`model-switch-indicator-dot tone-${currentIndicatorTone}`}
                  aria-hidden="true"
                />
                <span className="model-switch-status-main">
                  {currentModelId ??
                    currentModel ??
                    t("processInfoDefaultModel")}
                </span>
                <span className="model-switch-status-detail">
                  {renderThinkingLabel(currentThinkingMode, currentEffortLevel)}
                </span>
              </div>
              {dirty && (
                <div className="model-switch-status-row pending">
                  <span
                    className="model-switch-status-marker"
                    aria-hidden="true"
                  >
                    →
                  </span>
                  <span
                    className={`model-switch-indicator-dot tone-${pendingIndicatorTone}`}
                    aria-hidden="true"
                  />
                  <span className="model-switch-status-main">
                    {selectedModel ??
                      currentModelId ??
                      t("processInfoDefaultModel")}
                  </span>
                  <span className="model-switch-status-detail">
                    {renderThinkingLabel(
                      effectiveThinkingMode,
                      effectiveEffortLevel,
                    )}
                  </span>
                </div>
              )}
            </div>
            {!processId && (
              <div className="model-switch-activate">
                <span className="model-switch-activate-note">
                  {t("processInfoNoActiveProcess")}
                </span>
                {onActivate && (
                  <Button
                    className="model-switch-inline-save"
                    onClick={handleActivate}
                    disabled={activating}
                  >
                    {activating
                      ? t("modelSwitchActivating")
                      : t("modelSwitchActivate")}
                  </Button>
                )}
                {activateError && <Banner tone="error">{activateError}</Banner>}
              </div>
            )}
            {error && <Banner tone="error">{error}</Banner>}

            {processId && (
              <section className="model-switch-section">
                <div className="model-switch-section-header">
                  <strong>{t("modelSwitchThinkingModeTitle")}</strong>
                </div>
                <div className="model-switch-chip-group">
                  <SegmentedControl
                    variant="cards"
                    aria-label={t("modelSwitchThinkingModeTitle")}
                    options={thinkingModeOptions.map((mode) => ({
                      value: mode,
                      icon: (
                        <span
                          className={`model-switch-indicator-dot tone-${
                            mode === "off"
                              ? "off"
                              : mode === "auto"
                                ? "auto"
                                : effectiveEffortLevel
                          }`}
                        />
                      ),
                      label:
                        mode === "off"
                          ? t("modelSettingsThinkingOffLabel")
                          : mode === "auto"
                            ? t("modelSettingsThinkingAutoLabel")
                            : t("modelSettingsThinkingOnLabel"),
                      // The setting the session runs with, beside the pending pick.
                      description:
                        currentThinkingMode === mode
                          ? t("modelSwitchCurrent")
                          : undefined,
                    }))}
                    value={effectiveThinkingMode}
                    onChange={(mode) => {
                      setLastTouchedSection("thinking");
                      setThinkingModeState(mode);
                    }}
                    disabled={switching}
                  />
                  {dirty &&
                    lastTouchedSection === "thinking" &&
                    renderInlineSave()}
                </div>
              </section>
            )}

            {processId && showEffortOptions && (
              <section className="model-switch-section">
                <div className="model-switch-section-header">
                  <strong>{t("modelSettingsEffortTitle")}</strong>
                </div>
                <div className="model-switch-chip-group">
                  <SegmentedControl
                    variant="cards"
                    aria-label={t("modelSettingsEffortTitle")}
                    options={effortOptions.map((option) => ({
                      value: option.value,
                      icon: (
                        <span
                          className={`model-switch-indicator-dot tone-${option.value}`}
                        />
                      ),
                      label: option.label,
                      tooltip: option.description,
                      description:
                        currentThinkingMode === "on" &&
                        currentEffortLevel === option.value
                          ? t("modelSwitchCurrent")
                          : undefined,
                    }))}
                    value={
                      effectiveThinkingMode === "on"
                        ? effectiveEffortLevel
                        : null
                    }
                    onChange={(value) => {
                      setLastTouchedSection("effort");
                      setEffortLevelState(value);
                      setThinkingModeState("on");
                    }}
                    disabled={switching}
                  />
                  {dirty &&
                    lastTouchedSection === "effort" &&
                    renderInlineSave()}
                </div>
              </section>
            )}

            {showServiceTierOptions && (
              <section className="model-switch-section">
                <div className="model-switch-section-header">
                  <strong>{t("modelSwitchSpeedLabel")}</strong>
                </div>
                <SegmentedControl
                  activation="manual"
                  aria-label={t("modelSwitchSpeedLabel")}
                  options={[
                    {
                      value: STANDARD_SERVICE_TIER,
                      label: t("serviceTierStandardLabel"),
                      tooltip: t("serviceTierStandardDescription"),
                    },
                    ...serviceTierOptions.map((tier) => ({
                      value: tier.id,
                      label: tier.name,
                      tooltip: tier.description,
                    })),
                  ]}
                  value={currentServiceTier ?? STANDARD_SERVICE_TIER}
                  onChange={(value) =>
                    void applyServiceTier(
                      value === STANDARD_SERVICE_TIER ? null : value,
                    )
                  }
                  disabled={switching || savingServiceTier}
                />
                <div className="model-switch-section-note">
                  {t("modelSwitchSpeedLiveHint")}
                </div>
              </section>
            )}

            {processId && !error && models.length === 0 && (
              <div className="model-switch-loading">
                {t("modelSwitchEmpty")}
              </div>
            )}

            {models.length > 0 && (
              <section className="model-switch-section">
                <div className="model-switch-section-header">
                  <strong>{t("newSessionModelTitle")}</strong>
                </div>
                <div className="model-switch-list">
                  {models.map((model, index) => {
                    const isCurrent = currentModelId === model.id;
                    const isSelected = selectedModel === model.id;
                    const showInlineSave =
                      dirty && lastTouchedSection === "model" && isSelected;
                    return (
                      <Fragment key={model.id}>
                        {startsAdditionalModelGroup(models, index) && (
                          <div className="model-switch-group-label">
                            {t("previousModelsGroup")}
                          </div>
                        )}
                        <div className="model-switch-item-row">
                          <button
                            type="button"
                            className={`model-switch-item ${isCurrent ? "current" : ""} ${isSelected ? "active" : ""}`}
                            onClick={() => {
                              if (selectedModel !== model.id) {
                                setLastTouchedSection("model");
                              }
                              setSelectedModel(model.id);
                            }}
                            disabled={switching}
                          >
                            <span className="model-switch-item-main">
                              <span className="model-switch-name-row">
                                <span className="model-switch-name">
                                  {model.name}
                                </span>
                                {provider && (
                                  <ProviderBadge
                                    provider={provider}
                                    model={model.id}
                                  />
                                )}
                              </span>
                              {model.description && (
                                <span className="model-switch-description">
                                  {model.description}
                                </span>
                              )}
                            </span>
                            <span className="model-switch-item-meta">
                              <ModelSubscriptionUsage
                                usage={subscriptionUsage}
                                modelId={model.id}
                              />
                              {isCurrent && (
                                <Badge tone="accent" size="small">
                                  {t("modelSwitchCurrent")}
                                </Badge>
                              )}
                              <span
                                className={`model-switch-radio ${isSelected ? "selected" : ""}`}
                                aria-hidden="true"
                              >
                                {isSelected ? "●" : "○"}
                              </span>
                            </span>
                          </button>
                          {showInlineSave && renderInlineSave()}
                        </div>
                      </Fragment>
                    );
                  })}
                </div>
              </section>
            )}
          </>
        )}
      </MaybeTabPanel>
    </Dialog>
  );
}
