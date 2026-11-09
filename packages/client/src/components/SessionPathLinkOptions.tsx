import { useProjectPathLinkSettings } from "../contexts/ProjectPathLinkSettingsContext";
import { useI18n } from "../i18n";
import { useGlobalProjectPathLinkSettings } from "../lib/projectPathLinkPreferences";
import styles from "./SessionPathLinkOptions.module.css";
import { Select } from "./ui/Field";

const OPTIONS = [
  ["projectPaths", "appearanceProjectPathLinksTitle"],
  ["recentBasenames", "appearanceRecentProjectPathLinksTitle"],
  ["mentionedDirectories", "appearanceMentionedDirectoriesTitle"],
] as const;

export function SessionPathLinkOptions() {
  const { t } = useI18n();
  const { session, projectPaths } = useProjectPathLinkSettings();
  const defaults = useGlobalProjectPathLinkSettings();
  if (!session) return null;
  return (
    <fieldset className={styles.options}>
      <legend>{t("sessionPathLinkOptionsTitle")}</legend>
      {OPTIONS.map(([key, label]) => (
        <label className={styles.row} key={key}>
          <span>{t(label)}</span>
          <Select
            className={styles.select}
            aria-label={t(label)}
            disabled={key !== "projectPaths" && !projectPaths}
            value={
              session.overrides[key] === undefined
                ? "default"
                : String(session.overrides[key])
            }
            onChange={(event) =>
              session.setOverride(
                key,
                event.target.value === "default"
                  ? undefined
                  : event.target.value === "true",
              )
            }
          >
            <option value="default">
              {t(
                defaults[key]
                  ? "sessionPathLinkDefaultOn"
                  : "sessionPathLinkDefaultOff",
              )}
            </option>
            <option value="true">{t("sessionPathLinkOn")}</option>
            <option value="false">{t("sessionPathLinkOff")}</option>
          </Select>
        </label>
      ))}
    </fieldset>
  );
}
