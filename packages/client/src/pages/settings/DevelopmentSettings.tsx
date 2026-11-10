import rowsStyles from "./SettingsRows.module.css";
import developmentStyles from "./DevelopmentSettings.module.css";
import aboutStyles from "./AboutSettings.module.css";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useSchemaValidationContext } from "../../contexts/SchemaValidationContext";
import { useOptionalRemoteConnection } from "../../contexts/RemoteConnectionContext";
import { Badge } from "../../components/ui/Badge";
import { Banner } from "../../components/ui/Banner";
import { Button, buttonClassName } from "../../components/ui/Button";
import { Select } from "../../components/ui/Field";
import { Switch } from "../../components/ui/Switch";
import { useDeveloperMode } from "../../hooks/useDeveloperMode";
import { useReloadNotifications } from "../../hooks/useReloadNotifications";
import { useSchemaValidation } from "../../hooks/useSchemaValidation";
import { useServerSettings } from "../../hooks/useServerSettings";
import { useSessionPerformanceSettings } from "../../hooks/useSessionPerformanceSettings";
import { useI18n } from "../../i18n";
import { relayEndpoints } from "../../lib/connection/relayEndpoints";
import { getHostById, getHostByRelayUsername } from "../../lib/hostStorage";
import {
  SESSION_SCROLL_BEHAVIOR_MODES,
  type SessionScrollBehaviorMode,
} from "../../lib/sessionScrollBehavior";
import { SettingsItem } from "./SettingsItem";
import { useSettingsPaneTitle } from "./SettingsPaneTitleContext";
import { SettingsSection } from "./SettingsSection";
import { useSettingsUndoBaseline } from "./SettingsUndoContext";

type SessionScrollMemoryModeDescriptionKey =
  | "developmentSessionScrollMemoryModeLiveTailDescription"
  | "developmentSessionScrollMemoryModeRememberPlaceDescription"
  | "developmentSessionScrollMemoryModeNoMemoryDescription";

type SessionScrollMemoryModeLabelKey =
  | "developmentSessionScrollMemoryModeLiveTail"
  | "developmentSessionScrollMemoryModeRememberPlace"
  | "developmentSessionScrollMemoryModeNoMemory";

const sessionScrollMemoryModeDescriptionKeys: Record<
  SessionScrollBehaviorMode,
  SessionScrollMemoryModeDescriptionKey
> = {
  "live-tail": "developmentSessionScrollMemoryModeLiveTailDescription",
  "remember-place":
    "developmentSessionScrollMemoryModeRememberPlaceDescription",
  "no-memory": "developmentSessionScrollMemoryModeNoMemoryDescription",
};

const sessionScrollMemoryModeLabelKeys: Record<
  SessionScrollBehaviorMode,
  SessionScrollMemoryModeLabelKey
> = {
  "live-tail": "developmentSessionScrollMemoryModeLiveTail",
  "remember-place": "developmentSessionScrollMemoryModeRememberPlace",
  "no-memory": "developmentSessionScrollMemoryModeNoMemory",
};

export function DevelopmentSettings() {
  const { t } = useI18n();
  const remoteConnection = useOptionalRemoteConnection();
  const currentRelayHost = remoteConnection?.connection
    ? remoteConnection.currentRelayUsername
      ? getHostByRelayUsername(remoteConnection.currentRelayUsername)
      : remoteConnection.currentHostId
        ? getHostById(remoteConnection.currentHostId)
        : undefined
    : undefined;
  const currentRelayUrl =
    currentRelayHost?.mode === "relay" ? currentRelayHost.relayUrl : undefined;
  const relayMonitorUrl = currentRelayUrl
    ? relayEndpoints(currentRelayUrl)?.statsUrl
    : undefined;
  useSettingsPaneTitle(t("developmentSectionTitle"));
  const {
    isManualReloadMode,
    pendingReloads,
    connected,
    reloadBackend,
    unsafeToRestart,
    interruptibleSessionCount,
    queuedSessionMessageCount,
  } = useReloadNotifications();
  const { settings: validationSettings, setEnabled: setValidationEnabled } =
    useSchemaValidation();
  const {
    relayDebugEnabled,
    setRelayDebugEnabled,
    retainRejectedSrpSessions,
    setRetainRejectedSrpSessions,
    remoteLogCollectionEnabled,
    setRemoteLogCollectionEnabled,
  } = useDeveloperMode();
  const { sessionScrollBehaviorMode, setSessionScrollBehaviorMode } =
    useSessionPerformanceSettings();
  const { ignoredTools, clearIgnoredTools } = useSchemaValidationContext();
  const { settings: serverSettings, updateSetting: updateServerSetting } =
    useServerSettings();

  const undoState = useMemo(
    () =>
      serverSettings
        ? {
            validationEnabled: validationSettings.enabled,
            relayDebugEnabled,
            retainRejectedSrpSessions,
            remoteLogCollectionEnabled,
            sessionScrollBehaviorMode,
            serviceWorkerEnabled: serverSettings.serviceWorkerEnabled ?? true,
          }
        : null,
    [
      validationSettings.enabled,
      relayDebugEnabled,
      retainRejectedSrpSessions,
      remoteLogCollectionEnabled,
      serverSettings,
      sessionScrollBehaviorMode,
    ],
  );
  const restoreUndoState = useCallback(
    (snapshot: NonNullable<typeof undoState>) => {
      setValidationEnabled(snapshot.validationEnabled);
      setRelayDebugEnabled(snapshot.relayDebugEnabled);
      setRetainRejectedSrpSessions(snapshot.retainRejectedSrpSessions);
      setRemoteLogCollectionEnabled(snapshot.remoteLogCollectionEnabled);
      setSessionScrollBehaviorMode(snapshot.sessionScrollBehaviorMode);
      void updateServerSetting(
        "serviceWorkerEnabled",
        snapshot.serviceWorkerEnabled,
      );
    },
    [
      setValidationEnabled,
      setRelayDebugEnabled,
      setRetainRejectedSrpSessions,
      setRemoteLogCollectionEnabled,
      setSessionScrollBehaviorMode,
      updateServerSetting,
    ],
  );
  useSettingsUndoBaseline(undoState, restoreUndoState);

  const [restarting, setRestarting] = useState(false);
  // When SSE reconnects after restart, re-enable the button
  useEffect(() => {
    if (restarting && connected) {
      setRestarting(false);
    }
  }, [restarting, connected]);

  const handleRestartServer = async () => {
    setRestarting(true);
    await reloadBackend();
  };

  const restartWarning =
    interruptibleSessionCount > 0 && queuedSessionMessageCount > 0
      ? t("developmentInterruptedWarningActiveAndQueued", {
          activeCount: interruptibleSessionCount,
          activeSuffix: interruptibleSessionCount !== 1 ? "s" : "",
          queuedCount: queuedSessionMessageCount,
          queuedSuffix: queuedSessionMessageCount !== 1 ? "s" : "",
        })
      : queuedSessionMessageCount > 0
        ? t("developmentInterruptedWarningQueued", {
            count: queuedSessionMessageCount,
            suffix: queuedSessionMessageCount !== 1 ? "s" : "",
          })
        : t("developmentInterruptedWarning", {
            count: interruptibleSessionCount,
            suffix: interruptibleSessionCount !== 1 ? "s " : " ",
          });

  return (
    <SettingsSection>
      <div className={rowsStyles.group} data-settings-group>
        <SettingsItem
          label={t("developmentSchemaTitle")}
          description={t("developmentSchemaDescription")}
        >
          <Switch
            aria-label={t("developmentSchemaTitle")}
            checked={validationSettings.enabled}
            onCheckedChange={(checked) => setValidationEnabled(checked)}
          />
        </SettingsItem>
        {ignoredTools.length > 0 && (
          <SettingsItem
            label={t("developmentIgnoredToolsTitle")}
            description={t("developmentIgnoredToolsDescription")}
            info={
              <>
                <strong>{t("developmentIgnoredToolsTitle")}</strong>
                <p>{t("developmentIgnoredToolsDescription")}</p>
                <div className={developmentStyles.ignoredToolsList}>
                  {ignoredTools.map((tool) => (
                    <Badge key={tool} mono>
                      {tool}
                    </Badge>
                  ))}
                </div>
              </>
            }
          >
            <Button onClick={clearIgnoredTools}>
              {t("developmentClearIgnored")}
            </Button>
          </SettingsItem>
        )}
        {relayMonitorUrl && (
          <SettingsItem
            label={t("developmentRelayMonitorTitle")}
            description={t("developmentRelayMonitorDescription")}
          >
            <a
              className={buttonClassName()}
              href={relayMonitorUrl}
              target="_blank"
              rel="noreferrer"
            >
              {t("developmentRelayMonitorOpen")}
            </a>
          </SettingsItem>
        )}
        <SettingsItem
          label={t("developmentRelayDebugTitle")}
          description={t("developmentRelayDebugDescription")}
        >
          <Switch
            aria-label={t("developmentRelayDebugTitle")}
            checked={relayDebugEnabled}
            onCheckedChange={(checked) => setRelayDebugEnabled(checked)}
          />
        </SettingsItem>
        <SettingsItem
          label={t("developmentDiagnosticsTitle")}
          description={t("developmentDiagnosticsDescription")}
          doc={{
            path: "docs/development/debugging.md#client-console-logs",
            label: "client console logs",
          }}
        >
          <Switch
            aria-label={t("developmentDiagnosticsTitle")}
            checked={remoteLogCollectionEnabled}
            onCheckedChange={(checked) =>
              setRemoteLogCollectionEnabled(checked)
            }
          />
        </SettingsItem>
        <SettingsItem
          label={t("developmentRetainRejectedSrpTitle")}
          description={t("developmentRetainRejectedSrpDescription")}
          doc={{
            path: "docs/development/debugging.md#rejected-srp-resume-credentials",
            label: "rejected SRP debugging",
          }}
        >
          <Switch
            aria-label={t("developmentRetainRejectedSrpTitle")}
            checked={retainRejectedSrpSessions}
            onCheckedChange={(checked) => setRetainRejectedSrpSessions(checked)}
          />
        </SettingsItem>
        <SettingsItem
          label={t("developmentServiceWorkerTitle")}
          description={t("developmentServiceWorkerDescription")}
        >
          <Switch
            aria-label={t("developmentServiceWorkerTitle")}
            checked={serverSettings?.serviceWorkerEnabled ?? true}
            onCheckedChange={(checked) =>
              updateServerSetting("serviceWorkerEnabled", checked)
            }
          />
        </SettingsItem>
      </div>

      <div className={rowsStyles.group} data-settings-group>
        <SettingsItem
          label={t("developmentSessionScrollMemoryTitle")}
          description={t("developmentSessionScrollMemoryDescription")}
          keywords={[
            t("developmentSessionScrollMemoryControlTitle"),
            t("developmentSessionScrollMemoryKeywords"),
            ...SESSION_SCROLL_BEHAVIOR_MODES.flatMap((mode) => [
              t(sessionScrollMemoryModeLabelKeys[mode]),
              t(sessionScrollMemoryModeDescriptionKeys[mode]),
            ]),
          ]}
          valueText={t(
            sessionScrollMemoryModeLabelKeys[sessionScrollBehaviorMode],
          )}
          className={rowsStyles.itemWideControl}
          info={
            <>
              <strong>{t("developmentSessionScrollMemoryTitle")}</strong>
              <p>{t("developmentSessionScrollMemoryDescription")}</p>
              <ul className={developmentStyles.optionDescriptionList}>
                {SESSION_SCROLL_BEHAVIOR_MODES.map((mode) => (
                  <li key={mode}>
                    <strong>{t(sessionScrollMemoryModeLabelKeys[mode])}</strong>
                    <span>
                      {t(sessionScrollMemoryModeDescriptionKeys[mode])}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          }
        >
          <div className={rowsStyles.itemActions}>
            <Select
              value={sessionScrollBehaviorMode}
              onChange={(event) =>
                setSessionScrollBehaviorMode(
                  event.target.value as SessionScrollBehaviorMode,
                )
              }
              aria-label={t("developmentSessionScrollMemoryControlTitle")}
            >
              {SESSION_SCROLL_BEHAVIOR_MODES.map((mode) => (
                <option key={mode} value={mode}>
                  {t(sessionScrollMemoryModeLabelKeys[mode])}
                </option>
              ))}
            </Select>
          </div>
        </SettingsItem>
      </div>

      {isManualReloadMode && (
        <div className={rowsStyles.group} data-settings-group>
          <SettingsItem
            label={t("developmentRestartTitle")}
            description={t("developmentRestartDescription")}
            doc={{
              path: "site/src/content/docs/updating.md#keep-work-running-during-server-reloads",
              label: "reload-safe hosts",
            }}
            info={
              <>
                <strong>{t("developmentRestartTitle")}</strong>
                <p>
                  {t("developmentRestartDescription")}
                  {pendingReloads.backend && (
                    <span className={aboutStyles.pending}>
                      {" "}
                      {t("developmentChangesPending")}
                    </span>
                  )}
                </p>
                {unsafeToRestart && (
                  <Banner tone="warning" role="none" compact>
                    {restartWarning}
                  </Banner>
                )}
              </>
            }
          >
            <Button
              variant={unsafeToRestart ? "danger" : "secondary"}
              onClick={handleRestartServer}
              disabled={restarting}
            >
              {restarting
                ? t("developmentRestarting")
                : unsafeToRestart
                  ? t("developmentRestartAnyway")
                  : t("developmentRestart")}
            </Button>
          </SettingsItem>
        </div>
      )}
    </SettingsSection>
  );
}
