import type { EffortLevel, ModelInfo } from "@yep-anywhere/shared";
import { getEffortLevelOptions, isEffortLevel } from "../../lib/effortLevels";
import { useI18n } from "../../i18n";
import styles from "./ModelEffortDefaultsControl.module.css";
import { SettingsItem } from "./SettingsItem";

/**
 * Per-model effort used when Claude thinking is Auto. "Model default" removes
 * the model's entry so the catalog default (or Claude Code's) applies.
 */
export function ModelEffortDefaultsControl({
  models,
  levels,
  disabled,
  onChange,
}: {
  models: readonly ModelInfo[];
  levels: Readonly<Record<string, EffortLevel>> | undefined;
  disabled?: boolean;
  onChange: (next: Record<string, EffortLevel>) => void;
}) {
  const { t } = useI18n();
  const effortModels = models.filter(
    (model) =>
      model.supportsEffort !== false &&
      (model.supportedEffortLevels?.length ?? 0) > 0,
  );
  if (effortModels.length === 0) return null;
  const configured = Object.keys(levels ?? {}).length;

  const setLevel = (modelId: string, value: string) => {
    const next = { ...levels };
    if (isEffortLevel(value)) next[modelId] = value;
    else delete next[modelId];
    onChange(next);
  };

  return (
    <SettingsItem
      id="session-default-model-effort"
      label={t("modelEffortDefaultsTitle")}
      description={t("modelEffortDefaultsDescription")}
      keywords={["effort", "per model", "auto thinking"]}
      valueText={
        configured === 0
          ? t("modelEffortDefaultsNone")
          : t("modelEffortDefaultsCount", { count: String(configured) })
      }
      className="settings-item--session-default-block settings-item--wide-control"
    >
      <div className={styles.rows}>
        {effortModels.map((model) => {
          const options = getEffortLevelOptions({
            provider: "claude",
            model,
            translate: t,
          });
          return (
            <label key={model.id} className={styles.row}>
              <span className={styles.name}>{model.name}</span>
              <select
                className="settings-select"
                value={levels?.[model.id] ?? ""}
                disabled={disabled}
                onChange={(event) => setLevel(model.id, event.target.value)}
                aria-label={t("modelEffortDefaultsModelLabel", {
                  model: model.name,
                })}
              >
                <option value="">{t("modelEffortDefaultsInherit")}</option>
                {options.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
          );
        })}
      </div>
    </SettingsItem>
  );
}
