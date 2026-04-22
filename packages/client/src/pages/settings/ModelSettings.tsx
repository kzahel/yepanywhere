import { useEffect, useState } from "react";
import {
  EFFORT_LEVEL_OPTIONS,
  MODEL_OPTIONS,
  useModelSettings,
} from "../../hooks/useModelSettings";
import { useServerSettings } from "../../hooks/useServerSettings";
import { useI18n } from "../../i18n";

const PAGINATION_MODE_OPTIONS = [
  { value: "compactions", labelKey: "modelSettingsHistoryModeCompactions" },
  { value: "messages", labelKey: "modelSettingsHistoryModeMessages" },
] as const;

export function ModelSettings() {
  const { t } = useI18n();
  const { model, setModel, effortLevel, setEffortLevel } = useModelSettings();
  const { settings: serverSettings, updateSetting: updateServerSetting } =
    useServerSettings();
  const [sessionHistoryPageSizeInput, setSessionHistoryPageSizeInput] =
    useState("2");

  useEffect(() => {
    if (serverSettings?.sessionHistoryPageSize !== undefined) {
      setSessionHistoryPageSizeInput(
        String(serverSettings.sessionHistoryPageSize),
      );
    }
  }, [serverSettings?.sessionHistoryPageSize]);

  return (
    <section className="settings-section">
      <h2>{t("modelSettingsTitle")}</h2>
      <div className="settings-group">
        <div className="settings-item">
          <div className="settings-item-info">
            <strong>{t("modelSettingsModelTitle")}</strong>
            <p>{t("modelSettingsModelDescription")}</p>
          </div>
          <div className="font-size-selector">
            {MODEL_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                className={`font-size-option ${model === opt.value ? "active" : ""}`}
                onClick={() => setModel(opt.value)}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>
        <div className="settings-item">
          <div className="settings-item-info">
            <strong>{t("modelSettingsEffortTitle")}</strong>
            <p>{t("modelSettingsEffortDescription")}</p>
          </div>
          <div className="font-size-selector">
            {EFFORT_LEVEL_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                className={`font-size-option ${effortLevel === opt.value ? "active" : ""}`}
                onClick={() => setEffortLevel(opt.value)}
                title={opt.description}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>
        <div className="settings-item">
          <div className="settings-item-info">
            <strong>{t("modelSettingsHistoryModeTitle")}</strong>
            <p>{t("modelSettingsHistoryModeDescription")}</p>
          </div>
          <select
            className="settings-select"
            value={
              serverSettings?.sessionHistoryPaginationMode ?? "compactions"
            }
            onChange={(e) =>
              updateServerSetting(
                "sessionHistoryPaginationMode",
                e.target.value as "compactions" | "messages",
              )
            }
          >
            {PAGINATION_MODE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {t(option.labelKey as never)}
              </option>
            ))}
          </select>
        </div>
        <div className="settings-item">
          <div className="settings-item-info">
            <strong>{t("modelSettingsHistoryPageSizeTitle")}</strong>
            <p>{t("modelSettingsHistoryPageSizeDescription")}</p>
          </div>
          <input
            className="settings-input-small"
            type="number"
            min={1}
            max={500}
            step={1}
            value={sessionHistoryPageSizeInput}
            onChange={(e) => setSessionHistoryPageSizeInput(e.target.value)}
            onBlur={() => {
              const parsed = Number.parseInt(sessionHistoryPageSizeInput, 10);
              const nextValue = Number.isNaN(parsed)
                ? (serverSettings?.sessionHistoryPageSize ?? 2)
                : Math.min(Math.max(parsed, 1), 500);
              setSessionHistoryPageSizeInput(String(nextValue));
              void updateServerSetting("sessionHistoryPageSize", nextValue);
            }}
          />
        </div>
      </div>
    </section>
  );
}
