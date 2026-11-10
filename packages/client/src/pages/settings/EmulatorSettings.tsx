import rowsStyles from "./SettingsRows.module.css";
import { useCallback, useMemo, useState } from "react";
import {
  EMULATOR_FPS_OPTIONS,
  EMULATOR_WIDTH_OPTIONS,
  type EmulatorQuality,
  getQualityLabel,
  useEmulatorSettings,
} from "../../hooks/useEmulatorSettings";
import { Banner } from "../../components/ui/Banner";
import { Button } from "../../components/ui/Button";
import { TextInput } from "../../components/ui/Field";
import { SegmentedControl } from "../../components/ui/SegmentedControl";
import { Switch } from "../../components/ui/Switch";
import { useEmulators } from "../../hooks/useEmulators";
import { useServerSettings } from "../../hooks/useServerSettings";
import { useI18n } from "../../i18n";
import { SettingsItem } from "./SettingsItem";
import { useSettingsPaneTitle } from "./SettingsPaneTitleContext";
import { HideInSettingsSearch } from "./SettingsSearchContext";
import { SettingsSection } from "./SettingsSection";
import { useSettingsUndoBaseline } from "./SettingsUndoContext";

const QUALITY_OPTIONS: EmulatorQuality[] = ["high", "medium", "low"];

function canStartDevice(type: string, state: string, actions?: string[]) {
  if (actions?.length) return actions.includes("start");
  return type === "emulator" && state === "stopped";
}

function canStopDevice(type: string, state: string, actions?: string[]) {
  if (actions?.length) return actions.includes("stop");
  return type === "emulator" && state !== "stopped";
}

/**
 * Settings section for the device bridge.
 * Shows discovered devices, stream settings, and ChromeOS host aliases.
 */
export function EmulatorSettings() {
  const { t } = useI18n();
  useSettingsPaneTitle(t("emulatorSectionTitle"));
  const { emulators, loading, error, startEmulator, stopEmulator, refresh } =
    useEmulators();
  const {
    maxFps,
    setMaxFps,
    maxWidth,
    setMaxWidth,
    quality,
    setQuality,
    adaptiveFps,
    setAdaptiveFps,
  } = useEmulatorSettings();
  const {
    settings,
    isLoading: settingsLoading,
    error: settingsError,
    updateSetting,
  } = useServerSettings();
  const [hostInput, setHostInput] = useState("");
  const [chromeOsHostError, setChromeOsHostError] = useState<string | null>(
    null,
  );

  const chromeOsHosts = settings?.chromeOsHosts ?? [];

  // Header undo: stream settings (client-scoped) + server-side device bridge
  // toggle and ChromeOS host list. Device start/stop are actions, not state.
  const undoState = useMemo(
    () =>
      settings
        ? {
            maxFps,
            maxWidth,
            quality,
            adaptiveFps,
            deviceBridgeEnabled: settings.deviceBridgeEnabled ?? false,
            chromeOsHosts: settings.chromeOsHosts ?? [],
          }
        : null,
    [settings, maxFps, maxWidth, quality, adaptiveFps],
  );
  const restoreUndoState = useCallback(
    (snapshot: NonNullable<typeof undoState>) => {
      setMaxFps(snapshot.maxFps);
      setMaxWidth(snapshot.maxWidth);
      setQuality(snapshot.quality);
      setAdaptiveFps(snapshot.adaptiveFps);
      void updateSetting("deviceBridgeEnabled", snapshot.deviceBridgeEnabled);
      void updateSetting("chromeOsHosts", snapshot.chromeOsHosts);
      setChromeOsHostError(null);
    },
    [setMaxFps, setMaxWidth, setQuality, setAdaptiveFps, updateSetting],
  );
  useSettingsUndoBaseline(undoState, restoreUndoState);

  const addHost = async () => {
    const value = hostInput.trim();
    if (!value) {
      setChromeOsHostError(t("emulatorHostAliasRequired"));
      return;
    }
    if (/\s/.test(value)) {
      setChromeOsHostError(t("emulatorHostAliasNoSpaces"));
      return;
    }

    const deduped = Array.from(new Set([...chromeOsHosts, value]));
    try {
      await updateSetting("chromeOsHosts", deduped);
      setHostInput("");
      setChromeOsHostError(null);
      await refresh();
    } catch (err) {
      setChromeOsHostError(
        err instanceof Error ? err.message : t("emulatorHostAliasSaveFailed"),
      );
    }
  };

  const removeHost = async (host: string) => {
    const next = chromeOsHosts.filter(
      (item) => item.toLowerCase() !== host.toLowerCase(),
    );
    try {
      await updateSetting("chromeOsHosts", next);
      setChromeOsHostError(null);
      await refresh();
    } catch (err) {
      setChromeOsHostError(
        err instanceof Error ? err.message : t("emulatorHostAliasRemoveFailed"),
      );
    }
  };

  const deviceBridgeEnabled = settings?.deviceBridgeEnabled ?? false;

  return (
    <SettingsSection>
      <p className="settings-description">{t("emulatorSectionDescription")}</p>

      <div className={rowsStyles.group} data-settings-group>
        <SettingsItem
          label={t("emulatorEnableTitle")}
          description={t("emulatorEnableDescription")}
          doc="site/src/content/docs/files-and-source-control.md#remote-device-control"
        >
          <Switch
            checked={deviceBridgeEnabled}
            onCheckedChange={(checked) => {
              void updateSetting("deviceBridgeEnabled", checked);
            }}
            disabled={settingsLoading}
            aria-label={t("emulatorEnableTitle")}
          />
        </SettingsItem>
      </div>

      {!deviceBridgeEnabled ? null : (
        <>
          <div className={rowsStyles.group} data-settings-group>
            <h3>{t("emulatorStreamQualityTitle")}</h3>
            <p className="settings-description">
              {t("emulatorStreamQualityDescription")}
            </p>

            <SettingsItem
              label={t("emulatorFrameRateTitle")}
              description={t("emulatorFrameRateDescription")}
            >
              <SegmentedControl
                aria-label={t("emulatorFrameRateTitle")}
                options={EMULATOR_FPS_OPTIONS.map((fps) => ({
                  value: fps,
                  label: `${fps} fps`,
                }))}
                value={maxFps}
                onChange={setMaxFps}
              />
            </SettingsItem>

            <SettingsItem
              label={t("emulatorResolutionTitle")}
              description={t("emulatorResolutionDescription")}
            >
              <SegmentedControl
                aria-label={t("emulatorResolutionTitle")}
                options={EMULATOR_WIDTH_OPTIONS.map((w) => ({
                  value: w,
                  label: `${w}p`,
                }))}
                value={maxWidth}
                onChange={setMaxWidth}
              />
            </SettingsItem>

            <SettingsItem
              label={t("emulatorQualityTitle")}
              description={t("emulatorQualityDescription")}
              valueText={getQualityLabel(quality)}
            >
              <SegmentedControl
                aria-label={t("emulatorQualityTitle")}
                options={QUALITY_OPTIONS.map((q) => ({
                  value: q,
                  label: getQualityLabel(q),
                }))}
                value={quality}
                onChange={setQuality}
              />
            </SettingsItem>

            <SettingsItem
              label={t("emulatorAdaptiveFpsTitle")}
              description={t("emulatorAdaptiveFpsDescription")}
            >
              <Switch
                checked={adaptiveFps}
                onCheckedChange={setAdaptiveFps}
                aria-label={t("emulatorAdaptiveFpsTitle")}
              />
            </SettingsItem>
          </div>

          <div className={rowsStyles.group} data-settings-group>
            <h3>{t("emulatorChromeOsHostsTitle")}</h3>
            <p className="settings-description">
              {t("emulatorChromeOsHostsDescription")}
              <code> chromeroot</code>
              {t("emulatorChromeOsHostsDescriptionSuffix")}
            </p>

            <SettingsItem
              label={t("emulatorAddHostAliasTitle")}
              description={t("emulatorAddHostAliasDescription")}
            >
              <form
                className={rowsStyles.itemActions}
                onSubmit={(event) => {
                  event.preventDefault();
                  void addHost();
                }}
              >
                <TextInput
                  name="chromeosHost"
                  placeholder={t("emulatorHostAliasPlaceholder")}
                  autoComplete="off"
                  value={hostInput}
                  onChange={(event) => setHostInput(event.target.value)}
                />
                <Button
                  variant="primary"
                  type="submit"
                  disabled={settingsLoading}
                >
                  {t("projectsAddConfirm")}
                </Button>
              </form>
            </SettingsItem>

            <HideInSettingsSearch>
              {chromeOsHostError && (
                <Banner tone="error">{chromeOsHostError}</Banner>
              )}
              {settingsError && <Banner tone="error">{settingsError}</Banner>}

              {chromeOsHosts.length === 0 ? (
                <p className="settings-muted">{t("emulatorNoChromeOsHosts")}</p>
              ) : (
                chromeOsHosts.map((host) => (
                  <div key={host} className={rowsStyles.item}>
                    <div className={rowsStyles.itemInfo} data-settings-info>
                      <span className="settings-item-label">{host}</span>
                      <span className="settings-item-description">
                        Device ID: chromeos:{host}
                      </span>
                    </div>
                    <div className="settings-item-action">
                      <Button
                        variant="danger-outline"
                        onClick={() => {
                          void removeHost(host);
                        }}
                        disabled={settingsLoading}
                      >
                        {t("emulatorRemove")}
                      </Button>
                    </div>
                  </div>
                ))
              )}
            </HideInSettingsSearch>
          </div>

          <HideInSettingsSearch>
            <div className={rowsStyles.group} data-settings-group>
              <h3>{t("emulatorDiscoveredDevicesTitle")}</h3>

              {loading && (
                <p className="settings-muted">{t("projectsLoading")}</p>
              )}
              {error && <Banner tone="error">{error}</Banner>}

              {!loading && emulators.length === 0 && (
                <p className="settings-muted">{t("emulatorNoDevicesFound")}</p>
              )}

              {emulators.map((device) => (
                <div key={device.id} className={rowsStyles.item}>
                  <div className={rowsStyles.itemInfo} data-settings-info>
                    <span className="settings-item-label">
                      {device.label || device.avd || device.id}
                    </span>
                    <span className="settings-item-description">
                      {device.type} - {device.id} - {device.state}
                    </span>
                  </div>
                  <div className="settings-item-action">
                    {canStopDevice(
                      device.type,
                      device.state,
                      device.actions,
                    ) ? (
                      <Button onClick={() => stopEmulator(device.id)}>
                        {t("emulatorStop")}
                      </Button>
                    ) : canStartDevice(
                        device.type,
                        device.state,
                        device.actions,
                      ) ? (
                      <Button onClick={() => startEmulator(device.id)}>
                        {t("emulatorStart")}
                      </Button>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          </HideInSettingsSearch>
        </>
      )}
    </SettingsSection>
  );
}
