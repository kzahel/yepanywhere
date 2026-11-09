/**
 * Compact-threshold controls shared by Session Defaults and Providers → Claude
 * so both knobs appear next to each other (same storage, two access points).
 */
import { useCallback, useEffect, useState } from "react";
import type { ServerSettings } from "../../api/client";
import { CommittedRangeInput } from "../../components/ui/CommittedRangeInput";
import { CommittedRangeNumberInput } from "../../components/ui/CommittedRangeNumberInput";
import { TextInput } from "../../components/ui/Field";
import { useToastContext } from "../../contexts/ToastContext";
import { useI18n } from "../../i18n";
import { SettingsItem } from "./SettingsItem";

type UpdateServerSetting = <K extends keyof ServerSettings>(
  key: K,
  value: ServerSettings[K],
) => Promise<void>;

export function ClaudeAutoCompactPercentOverrideControl({
  id,
  value,
  updateSetting,
  description,
  keywords,
  searchable = true,
}: {
  id: string;
  value: number | undefined;
  updateSetting: UpdateServerSetting;
  /** Override description (e.g. mirror placement note). */
  description?: string;
  keywords?: string[];
  /** False for convenience clones so only the primary row hits search. */
  searchable?: boolean;
}) {
  const { t } = useI18n();
  const { showToast } = useToastContext();

  const save = useCallback(
    async (percent: number) => {
      try {
        await updateSetting(
          "claudeAutoCompactPercentOverride",
          percent === 0 ? undefined : percent,
        );
        showToast(t("providersClaudeAutoCompactSaved"), "success");
      } catch (error) {
        showToast(
          error instanceof Error
            ? error.message
            : t("providersClaudeAutoCompactSaveError"),
          "error",
        );
      }
    },
    [showToast, t, updateSetting],
  );

  return (
    <SettingsItem
      id={id}
      searchable={searchable}
      label={t("providersClaudeAutoCompactTitle")}
      description={description ?? t("providersClaudeAutoCompactDescription")}
      doc={{
        path: "topics/resume-compaction.md#claude-global-automatic-threshold-override",
        label: "Claude auto-compaction override",
      }}
      keywords={[
        "compact",
        "context",
        "threshold",
        "percentage",
        "claude auto",
        "autocompact",
        "providers",
        "session defaults",
        ...(keywords ?? []),
      ]}
      valueText={
        value === undefined ? t("providersClaudeAutoCompactOff") : `${value}%`
      }
      className="settings-item--wide-control"
    >
      <CommittedRangeNumberInput
        id={`${id}-input`}
        min={0}
        max={100}
        step={1}
        value={value ?? 0}
        unit="%"
        ariaLabel={t("providersClaudeAutoCompactTitle")}
        onCommit={(percent) => void save(percent)}
      />
    </SettingsItem>
  );
}

export function YaCompactContextEarlyControl({
  id,
  modelId,
  contextWindow,
  storedPercent,
  map,
  updateSetting,
  disabled,
  description,
  className,
  keywords,
  searchable = true,
}: {
  id: string;
  modelId: string;
  contextWindow: number | null | undefined;
  storedPercent: number;
  map: Record<string, number> | undefined;
  updateSetting: UpdateServerSetting;
  disabled?: boolean;
  description?: string;
  className?: string;
  keywords?: string[];
  /** False for convenience clones so only the primary row hits search. */
  searchable?: boolean;
}) {
  const { t } = useI18n();
  const [draft, setDraft] = useState(storedPercent);
  useEffect(() => {
    setDraft(storedPercent);
  }, [storedPercent]);

  const tokenPreview =
    contextWindow && draft > 0
      ? `${Math.round((contextWindow * draft) / 100 / 1024)}K`
      : null;

  const commit = useCallback(
    (pct: number) => {
      if (!modelId || modelId === "default") return;
      const nextMap: Record<string, number> = { ...map };
      if (pct > 0 && pct < 100) {
        nextMap[modelId] = Math.round(pct);
      } else {
        delete nextMap[modelId];
      }
      void updateSetting("clientDefaults", {
        compactAtContextPercent: nextMap,
      }).catch(() => {
        // surfaced via the hook's error state
      });
    },
    [map, modelId, updateSetting],
  );

  const valueHint =
    draft > 0
      ? t("modelSettingsCompactThresholdOnHint", {
          percent: String(draft),
          tokens: tokenPreview ?? "—",
        })
      : t("modelSettingsCompactThresholdOffHint");

  return (
    <SettingsItem
      id={id}
      searchable={searchable}
      label={t("modelSettingsCompactThresholdTitle")}
      description={description ?? t("modelSettingsCompactThresholdDescription")}
      doc={{
        path: "topics/resume-compaction.md#live-threshold-trigger-task-029",
        label: "early compaction",
      }}
      keywords={[
        "compact",
        "early compact",
        "context early",
        "autocompact",
        "compaction threshold",
        "/compact",
        "session defaults",
        "providers",
        ...(keywords ?? []),
      ]}
      valueText={valueHint}
      className={className ?? "settings-item--wide-control"}
    >
      <div>
        <span className="output-appearance-slider-row">
          <CommittedRangeInput
            min={0}
            max={99}
            step={1}
            value={draft}
            disabled={disabled}
            aria-label={t("modelSettingsCompactThresholdTitle")}
            onDraftChange={setDraft}
            onCommit={commit}
          />
          <TextInput
            type="number"
            unit="%"
            min={0}
            max={99}
            step={1}
            value={draft}
            disabled={disabled}
            aria-label={t("modelSettingsCompactThresholdTitle")}
            onChange={(e) => setDraft(Number(e.target.value))}
            onBlur={() => commit(draft)}
          />
        </span>
        <span className="settings-hint">{valueHint}</span>
      </div>
    </SettingsItem>
  );
}
