import { SERVER_CAPABILITIES, serverHasCapability } from "@yep-anywhere/shared";
import { Checkbox } from "../../components/ui/Checkbox";
import { useServerSettings } from "../../hooks/useServerSettings";
import { useVersion } from "../../hooks/useVersion";
import { useI18n } from "../../i18n";
import { SettingsSection } from "./SettingsSection";

/** Default-off MCP App hosting (topics/mcp-apps.md); absent on older servers. */
export function McpAppViewsSettings() {
  const { t } = useI18n();
  const { version } = useVersion();
  const { settings, updateSetting } = useServerSettings();
  if (
    !settings ||
    !serverHasCapability(version, SERVER_CAPABILITIES.mcpAppViews.name)
  )
    return null;
  return (
    <SettingsSection
      title={t("mcpAppViewsSettingTitle")}
      description={t("mcpAppViewsSettingDescription")}
      doc="topics/mcp-apps.md#enablement"
      keywords={["MCP", "MCP Apps", "Codex"]}
    >
      <Checkbox
        label={t("mcpAppViewsSettingTitle")}
        checked={settings.mcpAppViews === true}
        onCheckedChange={(checked) => updateSetting("mcpAppViews", checked)}
      />
    </SettingsSection>
  );
}
