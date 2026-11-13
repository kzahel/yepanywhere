import rowsStyles from "./SettingsRows.module.css";
import { useCallback, useMemo, useState } from "react";
import { Banner } from "../../components/ui/Banner";
import { Button, buttonClassName } from "../../components/ui/Button";
import { Switch } from "../../components/ui/Switch";
import { useCurrentSourceRuntime } from "../../contexts/SourceRuntimeContext";
import { useMachineControlStatus } from "../../hooks/useMachineControlStatus";
import { useI18n } from "../../i18n";
import { SettingsItem } from "./SettingsItem";
import { useSettingsPaneTitle } from "./SettingsPaneTitleContext";
import { SettingsSection } from "./SettingsSection";
import { useSettingsUndoBaseline } from "./SettingsUndoContext";

const DOWNLOAD_URL = "https://machinecontrol.dev/downloads/";

/**
 * Default-off advertisement of the installed Machine Control app to agents on
 * this server. The switch grants nothing: Machine Control approves access.
 */
export function MachineControlSettings() {
  const { t } = useI18n();
  useSettingsPaneTitle(t("machineControlSectionTitle"));
  const { transport } = useCurrentSourceRuntime();
  const { status, reload } = useMachineControlStatus(true);
  // The last value a write in this pane confirmed; readiness lags behind it.
  const [written, setWritten] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const enabled = written ?? status.enabled;

  const save = useCallback(
    async (next: boolean) => {
      setSaving(true);
      setError(null);
      try {
        const reply = await transport.fetch<{ enabled: boolean }>(
          "/machine-control",
          { method: "PUT", body: JSON.stringify({ enabled: next }) },
        );
        setWritten(reply.enabled === true);
      } catch (err) {
        setError(
          err instanceof Error ? err.message : t("machineControlSaveFailed"),
        );
      } finally {
        setSaving(false);
      }
    },
    [transport, t],
  );

  const undoState = useMemo(
    () => (status.known ? { enabled } : null),
    [status.known, enabled],
  );
  const restoreUndoState = useCallback(
    (snapshot: { enabled: boolean }) => save(snapshot.enabled),
    [save],
  );
  useSettingsUndoBaseline(undoState, restoreUndoState);

  const appDescription = !status.known
    ? t("machineControlAppChecking")
    : status.available
      ? t("machineControlAppInstalled", { version: status.version ?? "" })
      : status.found
        ? t("machineControlAppUnverified")
        : t("machineControlAppMissing");

  return (
    <SettingsSection>
      <p>{t("machineControlSectionDescription")}</p>
      {error ? <Banner tone="error">{error}</Banner> : null}
      <div className={rowsStyles.group} data-settings-group>
        <SettingsItem
          label={t("machineControlEnableTitle")}
          description={t("machineControlEnableDescription")}
          doc="topics/optional-computer-control.md#server-default"
          keywords={["desktop", "browser", "computer use", "computer control"]}
        >
          <Switch
            checked={enabled}
            onCheckedChange={(checked) => {
              void save(checked);
            }}
            disabled={!status.known || saving}
            aria-label={t("machineControlEnableTitle")}
          />
        </SettingsItem>
        <SettingsItem
          label={t("machineControlAppTitle")}
          description={appDescription}
          after={
            // Below the row: two buttons beside the text leave it no width
            // on a phone.
            status.known && !status.available ? (
              <div className={rowsStyles.itemActions}>
                <a
                  href={DOWNLOAD_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={buttonClassName()}
                >
                  {t("machineControlDownload")}
                </a>
                <Button onClick={reload}>
                  {t("machineControlCheckAgain")}
                </Button>
              </div>
            ) : null
          }
        />
      </div>
    </SettingsSection>
  );
}
