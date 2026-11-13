import { useI18n } from "../../i18n";
import { useVersion } from "../../hooks/useVersion";
import { ArtifactSettings } from "./ArtifactSettings";
import { McpAppViewsSettings } from "./McpAppViewsSettings";
import { useSettingsPaneTitle } from "./SettingsPaneTitleContext";
import { SettingsSection } from "./SettingsSection";

export function AppsSettings() {
  const { t } = useI18n();
  const { version } = useVersion();
  useSettingsPaneTitle(t("settingsAppsTitle"));
  return (
    <SettingsSection description={t("settingsAppsDescription")}>
      {version?.artifactViewer ? (
        <ArtifactSettings />
      ) : (
        <p>{t("settingsAppsUnavailable")}</p>
      )}
      <McpAppViewsSettings />
    </SettingsSection>
  );
}
