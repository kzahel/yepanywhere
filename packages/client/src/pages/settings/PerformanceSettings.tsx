import rowsStyles from "./SettingsRows.module.css";
import {
  HOST_AGENT_PROCESS_OBSERVABILITY_CAPABILITY,
  serverHasCapability,
} from "@yep-anywhere/shared";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Banner } from "../../components/ui/Banner";
import { CommittedRangeInput } from "../../components/ui/CommittedRangeInput";
import { TextInput } from "../../components/ui/Field";
import { Switch } from "../../components/ui/Switch";
import { useSessionLoadingProgress } from "../../hooks/useSessionLoadingProgress";
import { useServerSettings } from "../../hooks/useServerSettings";
import {
  getLastSessionTranscriptBytes,
  getSessionTranscriptMemoryStats,
  MAX_REVERSE_SEARCH_PAGES_PER_ATTEMPT,
  MAX_SESSION_INITIAL_HISTORY_COMPACTIONS,
  TRANSCRIPT_CACHE_BUDGET_MB_STOPS,
  TRANSCRIPT_CACHE_TTL_HOUR_STOPS,
  TYPICAL_SESSION_TRANSCRIPT_BYTES,
  useSessionPerformanceSettings,
} from "../../hooks/useSessionPerformanceSettings";
import { useStableToolPreviewRendering } from "../../hooks/useStableToolPreviewRendering";
import { useLiveToolOutputEnabled } from "../../hooks/useLiveToolOutputEnabled";
import { useStreamingEnabled } from "../../hooks/useStreamingEnabled";
import {
  MAX_SEARCH_CONCURRENCY,
  useSearchConcurrency,
} from "../../hooks/useSearchConcurrency";
import { useVersion } from "../../hooks/useVersion";
import { useI18n } from "../../i18n";
import { SettingsItem } from "./SettingsItem";
import { useSettingsPaneTitle } from "./SettingsPaneTitleContext";
import { SettingsSection } from "./SettingsSection";
import { useSettingsUndoBaseline } from "./SettingsUndoContext";

function nearestStopIndex(stops: readonly number[], value: number): number {
  let bestIndex = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  stops.forEach((stop, index) => {
    const distance = Math.abs(stop - value);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = index;
    }
  });
  return bestIndex;
}

function formatMemoryMb(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return mb < 10 ? mb.toFixed(1) : String(Math.round(mb));
}

export function PerformanceSettings() {
  const { t } = useI18n();
  useSettingsPaneTitle(t("performanceSectionTitle"));
  const { streamingEnabled, setStreamingEnabled } = useStreamingEnabled();
  const { liveToolOutputEnabled, setLiveToolOutputEnabled } =
    useLiveToolOutputEnabled();
  const { searchConcurrency, setSearchConcurrency } = useSearchConcurrency();
  const { sessionLoadingProgressEnabled, setSessionLoadingProgressEnabled } =
    useSessionLoadingProgress();
  const {
    sessionDomLingerEnabled,
    sessionActiveWindowTrimEnabled,
    sessionInitialHistoryCompactions,
    reverseSearchMaxPagesPerAttempt,
    sessionTranscriptCacheBudgetMb,
    sessionTranscriptCacheTtlHours,
    setSessionDomLingerEnabled,
    setSessionActiveWindowTrimEnabled,
    setSessionInitialHistoryCompactions,
    setReverseSearchMaxPagesPerAttempt,
    setSessionTranscriptCacheBudgetMb,
    setSessionTranscriptCacheTtlHours,
  } = useSessionPerformanceSettings();
  const { stableToolPreviewRendering, setStableToolPreviewRendering } =
    useStableToolPreviewRendering();
  const { version } = useVersion();
  const {
    settings: serverSettings,
    isLoading: serverSettingsLoading,
    error: serverSettingsError,
    updateSetting: updateServerSetting,
  } = useServerSettings();
  const hostProcessObservabilitySupported = serverHasCapability(
    version,
    HOST_AGENT_PROCESS_OBSERVABILITY_CAPABILITY,
  );
  const hostProcessObservabilityEnabled =
    serverSettings?.hostProcessObservabilityEnabled ?? true;
  const [savingHostProcessObservability, setSavingHostProcessObservability] =
    useState(false);

  const [historyDraftIndex, setHistoryDraftIndex] = useState<number | null>(
    null,
  );
  const [budgetDraftIndex, setBudgetDraftIndex] = useState<number | null>(null);
  const [ttlDraftIndex, setTtlDraftIndex] = useState<number | null>(null);
  const [reverseSearchPageLimitDraft, setReverseSearchPageLimitDraft] =
    useState(String(reverseSearchMaxPagesPerAttempt));

  useEffect(() => {
    setReverseSearchPageLimitDraft(String(reverseSearchMaxPagesPerAttempt));
  }, [reverseSearchMaxPagesPerAttempt]);

  const historyIndex =
    historyDraftIndex ??
    (sessionInitialHistoryCompactions === null
      ? MAX_SESSION_INITIAL_HISTORY_COMPACTIONS
      : sessionInitialHistoryCompactions - 1);
  const historyCompactions =
    historyIndex === MAX_SESSION_INITIAL_HISTORY_COMPACTIONS
      ? null
      : historyIndex + 1;
  const budgetIndex =
    budgetDraftIndex ??
    nearestStopIndex(
      TRANSCRIPT_CACHE_BUDGET_MB_STOPS,
      sessionTranscriptCacheBudgetMb,
    );
  const ttlIndex =
    ttlDraftIndex ??
    nearestStopIndex(
      TRANSCRIPT_CACHE_TTL_HOUR_STOPS,
      sessionTranscriptCacheTtlHours,
    );
  const budgetMb = TRANSCRIPT_CACHE_BUDGET_MB_STOPS[budgetIndex] ?? 0;
  const ttlHours = TRANSCRIPT_CACHE_TTL_HOUR_STOPS[ttlIndex] ?? 1;

  const historyLabel =
    historyCompactions === null
      ? t("performanceInitialHistoryUnlimitedValue")
      : t(
          historyCompactions === 1
            ? "performanceInitialHistoryCompactionValue"
            : "performanceInitialHistoryCompactionsValue",
          { count: historyCompactions },
        );
  const budgetLabel =
    budgetMb === 0
      ? t("commonOff")
      : t("performanceTranscriptCacheMbValue", { count: budgetMb });
  const ttlLabel =
    ttlHours < 24
      ? t("performanceTranscriptCacheTtlHoursValue", { count: ttlHours })
      : t("performanceTranscriptCacheTtlDaysValue", {
          count: Math.round(ttlHours / 24),
        });

  const budgetEquivalent = useMemo(() => {
    if (budgetMb === 0) {
      return null;
    }
    const lastBytes = getLastSessionTranscriptBytes();
    const perSession = lastBytes ?? TYPICAL_SESSION_TRANSCRIPT_BYTES;
    const count = Math.max(
      1,
      Math.floor((budgetMb * 1024 * 1024) / perSession),
    );
    const size = (perSession / (1024 * 1024)).toFixed(1);
    return t(
      lastBytes !== null
        ? "performanceTranscriptCacheEquivalentLast"
        : "performanceTranscriptCacheEquivalentTypical",
      { count, size },
    );
  }, [budgetMb, t]);
  const transcriptMemoryStats = getSessionTranscriptMemoryStats();
  const cacheMemoryUsage =
    transcriptMemoryStats.totalBytes > 0
      ? t("performanceTranscriptCacheCurrentUsage", {
          warmSize: formatMemoryMb(transcriptMemoryStats.warmCacheBytes),
          liveSize: formatMemoryMb(transcriptMemoryStats.liveRetainedBytes),
        })
      : null;

  const commitHistory = useCallback(
    (index: number) => {
      setHistoryDraftIndex(null);
      setSessionInitialHistoryCompactions(
        index === MAX_SESSION_INITIAL_HISTORY_COMPACTIONS ? null : index + 1,
      );
    },
    [setSessionInitialHistoryCompactions],
  );
  const commitBudget = useCallback(
    (index: number) => {
      setBudgetDraftIndex(null);
      const stop = TRANSCRIPT_CACHE_BUDGET_MB_STOPS[index];
      if (stop !== undefined) {
        setSessionTranscriptCacheBudgetMb(stop);
      }
    },
    [setSessionTranscriptCacheBudgetMb],
  );
  const commitTtl = useCallback(
    (index: number) => {
      setTtlDraftIndex(null);
      const stop = TRANSCRIPT_CACHE_TTL_HOUR_STOPS[index];
      if (stop !== undefined) {
        setSessionTranscriptCacheTtlHours(stop);
      }
    },
    [setSessionTranscriptCacheTtlHours],
  );
  const commitReverseSearchPageLimit = useCallback(() => {
    const parsed = Number(reverseSearchPageLimitDraft);
    if (!Number.isFinite(parsed)) {
      setReverseSearchPageLimitDraft(String(reverseSearchMaxPagesPerAttempt));
      return;
    }
    const normalized = Math.min(
      MAX_REVERSE_SEARCH_PAGES_PER_ATTEMPT,
      Math.max(1, Math.round(parsed)),
    );
    setReverseSearchPageLimitDraft(String(normalized));
    setReverseSearchMaxPagesPerAttempt(normalized);
  }, [
    reverseSearchMaxPagesPerAttempt,
    reverseSearchPageLimitDraft,
    setReverseSearchMaxPagesPerAttempt,
  ]);
  const setHostProcessObservability = useCallback(
    async (enabled: boolean) => {
      setSavingHostProcessObservability(true);
      try {
        await updateServerSetting("hostProcessObservabilityEnabled", enabled);
      } catch {
        // useServerSettings retains the actionable error for this pane.
      } finally {
        setSavingHostProcessObservability(false);
      }
    },
    [updateServerSetting],
  );

  const undoState = useMemo(
    () => ({
      streamingEnabled,
      liveToolOutputEnabled,
      searchConcurrency,
      sessionLoadingProgressEnabled,
      sessionDomLingerEnabled,
      sessionActiveWindowTrimEnabled,
      sessionInitialHistoryCompactions,
      reverseSearchMaxPagesPerAttempt,
      sessionTranscriptCacheBudgetMb,
      sessionTranscriptCacheTtlHours,
      stableToolPreviewRendering,
      hostProcessObservabilityEnabled,
    }),
    [
      streamingEnabled,
      liveToolOutputEnabled,
      searchConcurrency,
      sessionLoadingProgressEnabled,
      sessionDomLingerEnabled,
      sessionActiveWindowTrimEnabled,
      sessionInitialHistoryCompactions,
      reverseSearchMaxPagesPerAttempt,
      sessionTranscriptCacheBudgetMb,
      sessionTranscriptCacheTtlHours,
      stableToolPreviewRendering,
      hostProcessObservabilityEnabled,
    ],
  );
  const restoreUndoState = useCallback(
    (snapshot: typeof undoState) => {
      setStreamingEnabled(snapshot.streamingEnabled);
      setLiveToolOutputEnabled(snapshot.liveToolOutputEnabled);
      setSearchConcurrency(snapshot.searchConcurrency);
      setSessionLoadingProgressEnabled(snapshot.sessionLoadingProgressEnabled);
      setSessionDomLingerEnabled(snapshot.sessionDomLingerEnabled);
      setSessionActiveWindowTrimEnabled(
        snapshot.sessionActiveWindowTrimEnabled,
      );
      setSessionInitialHistoryCompactions(
        snapshot.sessionInitialHistoryCompactions,
      );
      setReverseSearchMaxPagesPerAttempt(
        snapshot.reverseSearchMaxPagesPerAttempt,
      );
      setSessionTranscriptCacheBudgetMb(
        snapshot.sessionTranscriptCacheBudgetMb,
      );
      setSessionTranscriptCacheTtlHours(
        snapshot.sessionTranscriptCacheTtlHours,
      );
      setStableToolPreviewRendering(snapshot.stableToolPreviewRendering);
      if (
        hostProcessObservabilitySupported &&
        snapshot.hostProcessObservabilityEnabled !==
          hostProcessObservabilityEnabled
      ) {
        void setHostProcessObservability(
          snapshot.hostProcessObservabilityEnabled,
        );
      }
    },
    [
      setStreamingEnabled,
      setLiveToolOutputEnabled,
      setSearchConcurrency,
      setSessionLoadingProgressEnabled,
      setSessionDomLingerEnabled,
      setSessionActiveWindowTrimEnabled,
      setSessionInitialHistoryCompactions,
      setReverseSearchMaxPagesPerAttempt,
      setSessionTranscriptCacheBudgetMb,
      setSessionTranscriptCacheTtlHours,
      setStableToolPreviewRendering,
      hostProcessObservabilityEnabled,
      hostProcessObservabilitySupported,
      setHostProcessObservability,
    ],
  );
  useSettingsUndoBaseline(undoState, restoreUndoState);

  return (
    <SettingsSection description={t("performanceSectionDescription")}>
      <div className={rowsStyles.group} data-settings-group>
        <SettingsItem
          label={t("performanceSearchConcurrencyTitle")}
          description={t("performanceSearchConcurrencyDescription")}
          valueText={t("performanceSearchConcurrencyValue", {
            count: searchConcurrency,
          })}
          className={rowsStyles.itemWideControl}
        >
          <div className={rowsStyles.itemActions}>
            <CommittedRangeInput
              min={1}
              max={MAX_SEARCH_CONCURRENCY}
              step={1}
              value={searchConcurrency}
              onCommit={setSearchConcurrency}
              aria-label={t("performanceSearchConcurrencyTitle")}
            />
            <span className={rowsStyles.inputUnit}>{searchConcurrency}</span>
          </div>
        </SettingsItem>
        <SettingsItem
          label={t("appearanceStreamingTitle")}
          description={t("appearanceStreamingDescription")}
        >
          <Switch
            checked={streamingEnabled}
            onCheckedChange={(checked) => setStreamingEnabled(checked)}
            aria-label={t("appearanceStreamingTitle")}
          />
        </SettingsItem>
        <SettingsItem
          label={t("appearanceLiveToolOutputTitle")}
          description={t("appearanceLiveToolOutputDescription")}
        >
          <Switch
            checked={liveToolOutputEnabled}
            onCheckedChange={(checked) => setLiveToolOutputEnabled(checked)}
            aria-label={t("appearanceLiveToolOutputTitle")}
          />
        </SettingsItem>
        <SettingsItem
          label={t("appearanceSessionLoadingProgressTitle")}
          description={t("appearanceSessionLoadingProgressDescription")}
        >
          <Switch
            checked={sessionLoadingProgressEnabled}
            onCheckedChange={(checked) =>
              setSessionLoadingProgressEnabled(checked)
            }
            aria-label={t("appearanceSessionLoadingProgressTitle")}
          />
        </SettingsItem>
        <SettingsItem
          label={t("performanceKeepRecentSessionMountedTitle")}
          description={t("performanceKeepRecentSessionMountedDescription")}
        >
          <Switch
            checked={sessionDomLingerEnabled}
            onCheckedChange={(checked) => setSessionDomLingerEnabled(checked)}
            aria-label={t("performanceKeepRecentSessionMountedTitle")}
          />
        </SettingsItem>
        <SettingsItem
          label={t("performanceActiveWindowTrimTitle")}
          description={t("performanceActiveWindowTrimDescription")}
        >
          <Switch
            checked={sessionActiveWindowTrimEnabled}
            onCheckedChange={(checked) =>
              setSessionActiveWindowTrimEnabled(checked)
            }
            aria-label={t("performanceActiveWindowTrimTitle")}
          />
        </SettingsItem>
        <SettingsItem
          label={t("performanceInitialHistoryTitle")}
          description={t("performanceInitialHistoryDescription")}
          doc={{
            path: "topics/session-compact-tail-pagination.md#compact-scope-and-turn-selectors",
            label: "initial history scope",
          }}
          valueText={historyLabel}
          className={rowsStyles.itemWideControl}
        >
          <div className={rowsStyles.itemActions}>
            <CommittedRangeInput
              min={0}
              max={MAX_SESSION_INITIAL_HISTORY_COMPACTIONS}
              step={1}
              value={historyIndex}
              onDraftChange={setHistoryDraftIndex}
              onCommit={commitHistory}
              aria-label={t("performanceInitialHistoryTitle")}
            />
            <span className={rowsStyles.inputUnit}>{historyLabel}</span>
          </div>
        </SettingsItem>
        <SettingsItem
          label={t("performanceReverseSearchPageLimitTitle")}
          description={t("performanceReverseSearchPageLimitDescription")}
          descriptionLayout="full-width-on-narrow"
          valueText={t("performanceReverseSearchPageLimitValue", {
            count: reverseSearchMaxPagesPerAttempt,
          })}
        >
          <TextInput
            type="number"
            unit={t("performanceReverseSearchPageLimitUnit")}
            min={1}
            max={MAX_REVERSE_SEARCH_PAGES_PER_ATTEMPT}
            step={1}
            value={reverseSearchPageLimitDraft}
            onChange={(event) =>
              setReverseSearchPageLimitDraft(event.target.value)
            }
            onBlur={commitReverseSearchPageLimit}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                commitReverseSearchPageLimit();
                event.currentTarget.blur();
              }
            }}
            aria-label={t("performanceReverseSearchPageLimitTitle")}
          />
        </SettingsItem>
        <SettingsItem
          label={t("performanceTranscriptCacheTitle")}
          description={t("performanceTranscriptCacheDescription")}
          valueText={budgetLabel}
          className={rowsStyles.itemWideControl}
          info={
            <>
              <strong>{t("performanceTranscriptCacheTitle")}</strong>
              <p>{t("performanceTranscriptCacheDescription")}</p>
              {budgetEquivalent ? <p>{budgetEquivalent}</p> : null}
              {cacheMemoryUsage ? <p>{cacheMemoryUsage}</p> : null}
            </>
          }
        >
          <div className={rowsStyles.itemActions}>
            <CommittedRangeInput
              min={0}
              max={TRANSCRIPT_CACHE_BUDGET_MB_STOPS.length - 1}
              step={1}
              value={budgetIndex}
              onDraftChange={setBudgetDraftIndex}
              onCommit={commitBudget}
              aria-label={t("performanceTranscriptCacheTitle")}
            />
            <span className={rowsStyles.inputUnit}>{budgetLabel}</span>
          </div>
        </SettingsItem>
        <SettingsItem
          label={t("performanceTranscriptCacheTtlTitle")}
          description={t("performanceTranscriptCacheTtlDescription")}
          valueText={ttlLabel}
          className={rowsStyles.itemWideControl}
        >
          <div className={rowsStyles.itemActions}>
            <CommittedRangeInput
              min={0}
              max={TRANSCRIPT_CACHE_TTL_HOUR_STOPS.length - 1}
              step={1}
              value={ttlIndex}
              onDraftChange={setTtlDraftIndex}
              onCommit={commitTtl}
              disabled={budgetMb === 0}
              aria-label={t("performanceTranscriptCacheTtlTitle")}
            />
            <span className={rowsStyles.inputUnit}>{ttlLabel}</span>
          </div>
        </SettingsItem>
        <SettingsItem
          label={t("appearanceStableToolPreviewTitle")}
          description={t("appearanceStableToolPreviewDescription")}
        >
          <Switch
            checked={stableToolPreviewRendering}
            onCheckedChange={(checked) =>
              setStableToolPreviewRendering(checked)
            }
            aria-label={t("appearanceStableToolPreviewTitle")}
          />
        </SettingsItem>
        {hostProcessObservabilitySupported && (
          <SettingsItem
            label={t("performanceHostProcessObservabilityTitle")}
            description={t("performanceHostProcessObservabilityDescription")}
            keywords={["Agents", "CPU", "memory", "external processes"]}
            after={
              serverSettingsError ? (
                <Banner tone="error">{serverSettingsError}</Banner>
              ) : null
            }
          >
            <Switch
              checked={hostProcessObservabilityEnabled}
              disabled={serverSettingsLoading || savingHostProcessObservability}
              onCheckedChange={(checked) =>
                void setHostProcessObservability(checked)
              }
              aria-label={t("performanceHostProcessObservabilityTitle")}
            />
          </SettingsItem>
        )}
      </div>
    </SettingsSection>
  );
}
