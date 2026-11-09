import { Link } from "react-router-dom";
import {
  buildYaClientPublicShareBaseUrl,
  DEFAULT_HOST_AWAKE_BATTERY_FLOOR_PERCENT,
  DEFAULT_YA_CLIENT_BASE_URL,
  PUBLIC_SHARE_MANAGEMENT_CAPABILITY,
  SERVER_CAPABILITIES,
  type HostAwakeStatus,
  type HostIdentity,
  MAX_HOST_IDENTITY_ICON_CODE_UNITS,
  isHostAwakeBatteryFloorPercent,
  normalizeHostIdentityIcon,
  serverHasCapability,
} from "@yep-anywhere/shared";
import { useEffect, useId, useState } from "react";
import type { PublicShareStatusResponse } from "../../api/client";
import { PublicShareManagerModal } from "../../components/PublicShareManagerModal";
import { RemoteAccessSetup } from "../../components/RemoteAccessSetup";
import { Banner } from "../../components/ui/Banner";
import { Button } from "../../components/ui/Button";
import { TextInput } from "../../components/ui/Field";
import { SegmentedControl } from "../../components/ui/SegmentedControl";
import { Switch } from "../../components/ui/Switch";
import { useOptionalRemoteConnection } from "../../contexts/RemoteConnectionContext";
import { usePublicShareStatus } from "../../hooks/usePublicShareStatus";
import { useHostAwakeStatus } from "../../hooks/useHostAwakeStatus";
import { useServerSettings } from "../../hooks/useServerSettings";
import { useVersion } from "../../hooks/useVersion";
import { useI18n } from "../../i18n";
import { buildFrontendReloadUrl } from "../../lib/frontendReload";
import { getHostById } from "../../lib/hostStorage";
import { markSwitchHostReload } from "../../lib/switchHostReload";
import styles from "./RemoteAccessSettings.module.css";
import { SettingsItem } from "./SettingsItem";
import { useSettingsPaneTitle } from "./SettingsPaneTitleContext";
import { HideInSettingsSearch } from "./SettingsSearchContext";
import { SettingsSection } from "./SettingsSection";
import { AppsSettingsLink } from "./AppsSettings";

const DEFAULT_PUBLIC_SHARE_VIEWER_BASE_URL = buildYaClientPublicShareBaseUrl(
  DEFAULT_YA_CLIENT_BASE_URL,
);

const HOST_IDENTITY_PRESETS = [
  "💻",
  "🖥️",
  "🗄️",
  "🏠",
  "☁️",
  "❤️",
  "⭐",
  "🔵",
] as const;

interface HostIdentitySettingsProps {
  currentIcon: string;
  disabled: boolean;
  onChange: (identity: HostIdentity | undefined) => Promise<void>;
}

function HostIdentitySettings({
  currentIcon,
  disabled,
  onChange,
}: HostIdentitySettingsProps) {
  const { t } = useI18n();
  const [draft, setDraft] = useState(currentIcon);
  const [saving, setSaving] = useState(false);
  const normalizedDraft = normalizeHostIdentityIcon(draft);
  const draftInvalid = draft.trim().length > 0 && normalizedDraft === null;
  const invalidId = useId();

  useEffect(() => setDraft(currentIcon), [currentIcon]);

  const save = async (identity: HostIdentity | undefined) => {
    setSaving(true);
    try {
      await onChange(identity);
    } catch {
      // useServerSettings owns the visible mutation error.
      setDraft(currentIcon);
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingsItem
      label={t("hostIdentityTitle")}
      description={t("hostIdentityDescription")}
      className="settings-item--wide-control host-identity-settings"
    >
      <div className="host-identity-controls">
        <SegmentedControl
          activation="manual"
          variant="cards"
          aria-label={t("hostIdentityPresetsAria")}
          options={HOST_IDENTITY_PRESETS.map((icon) => ({
            value: icon,
            label: <span className={styles.presetEmoji}>{icon}</span>,
            ariaLabel: t("hostIdentityUsePreset", { icon }),
          }))}
          value={currentIcon}
          onChange={(icon) => {
            setDraft(icon);
            void save({ icon });
          }}
          disabled={disabled || saving}
        />
        <form
          className="host-identity-custom"
          onSubmit={(event) => {
            event.preventDefault();
            if (normalizedDraft && normalizedDraft !== currentIcon) {
              void save({ icon: normalizedDraft });
            }
          }}
        >
          <TextInput
            className="host-identity-input"
            value={draft}
            invalid={draftInvalid}
            aria-describedby={draftInvalid ? invalidId : undefined}
            maxLength={MAX_HOST_IDENTITY_ICON_CODE_UNITS}
            aria-label={t("hostIdentityCustomLabel")}
            placeholder={t("hostIdentityCustomPlaceholder")}
            disabled={disabled || saving}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={(event) => {
              const nextTarget = event.relatedTarget;
              if (
                nextTarget instanceof HTMLElement &&
                nextTarget.dataset.hostIdentityClear !== undefined
              ) {
                return;
              }
              if (normalizedDraft && normalizedDraft !== currentIcon) {
                void save({ icon: normalizedDraft });
              }
            }}
          />
          {currentIcon && (
            <Button
              data-host-identity-clear
              disabled={disabled || saving}
              onClick={() => {
                setDraft("");
                void save(undefined);
              }}
            >
              {t("hostIdentityClear")}
            </Button>
          )}
        </form>
        {draftInvalid && (
          <Banner id={invalidId} tone="error" role="none" compact>
            {t("hostIdentityInvalid")}
          </Banner>
        )}
      </div>
    </SettingsItem>
  );
}

interface HostAwakeSettingsProps {
  status: HostAwakeStatus | null;
  statusError: Error | null;
  statusLoading: boolean;
  settingsLoading: boolean;
  mode: "off" | "idle" | "idle-and-closed-lid-on-external-power";
  batteryFloorPercent: number;
  onUpdate: (updates: {
    hostAwakeMode?: "off" | "idle";
    hostAwakeBatteryFloorPercent?: number;
  }) => Promise<unknown>;
  onRefresh: () => Promise<void>;
}

function HostAwakeSettings({
  status,
  statusError,
  statusLoading,
  settingsLoading,
  mode,
  batteryFloorPercent,
  onUpdate,
  onRefresh,
}: HostAwakeSettingsProps) {
  const { t } = useI18n();
  const [floorDraft, setFloorDraft] = useState(String(batteryFloorPercent));
  const [saving, setSaving] = useState(false);
  const floorInvalidId = useId();
  const enabled = mode !== "off";
  const unavailable =
    status?.state === "unsupported" ||
    status?.support.idleSleepPrevention === false;
  const parsedFloor = Number(floorDraft);
  const validFloor = isHostAwakeBatteryFloorPercent(parsedFloor);

  useEffect(() => {
    setFloorDraft(String(batteryFloorPercent));
  }, [batteryFloorPercent]);

  const update = async (updates: Parameters<typeof onUpdate>[0]) => {
    setSaving(true);
    try {
      await onUpdate(updates);
      await onRefresh();
    } catch {
      setFloorDraft(String(batteryFloorPercent));
    } finally {
      setSaving(false);
    }
  };

  const statusText = (() => {
    if (statusError) return t("hostAwakeStatusFetchError");
    if (!status) return t("hostAwakeStatusLoading");
    switch (status.state) {
      case "active":
        return t("hostAwakeStatusActive");
      case "paused-low-battery":
        return t("hostAwakeStatusPaused", {
          percent: status.batteryFloorPercent,
        });
      case "unsupported":
        return status.reason
          ? t("hostAwakeStatusUnavailableReason", { reason: status.reason })
          : t("hostAwakeStatusUnavailable");
      case "error":
        return t("hostAwakeStatusError", {
          reason: status.reason ?? t("hostAwakeStatusUnknownError"),
        });
      default:
        return t("hostAwakeStatusDisabled");
    }
  })();

  return (
    <div className="settings-group">
      <SettingsItem
        label={t("hostAwakeTitle")}
        description={t("hostAwakeDescription")}
        info={
          <>
            <strong>{t("hostAwakeTitle")}</strong>
            <p>{t("hostAwakeDescription")}</p>
            {status?.state === "error" || unavailable ? (
              <Banner tone="warning" role="none" compact>
                {statusText}
              </Banner>
            ) : (
              <p className="settings-hint">{statusText}</p>
            )}
            {status?.batteryPercent !== undefined && (
              <p className="settings-hint">
                {t("hostAwakeBatteryObserved", {
                  percent: status.batteryPercent,
                  time: status.powerObservedAt
                    ? new Date(status.powerObservedAt).toLocaleString()
                    : t("hostAwakeBatteryObservedUnknownTime"),
                })}
              </p>
            )}
            {!enabled && (
              <Button
                disabled={statusLoading || saving}
                onClick={() => void onRefresh()}
              >
                {t("hostAwakeRefresh")}
              </Button>
            )}
          </>
        }
      >
        <Switch
          checked={enabled}
          disabled={
            settingsLoading ||
            statusLoading ||
            saving ||
            !status ||
            (unavailable && !enabled)
          }
          onCheckedChange={(checked) =>
            void update({
              hostAwakeMode: checked ? "idle" : "off",
            })
          }
          aria-label={t("hostAwakeTitle")}
        />
      </SettingsItem>

      {enabled &&
        status?.hasInternalBattery === true &&
        status.support.batteryFloor && (
          <SettingsItem
            label={t("hostAwakeBatteryFloorTitle")}
            description={t("hostAwakeBatteryFloorDescription")}
            className="settings-item--wide-control"
          >
            <form
              className="host-awake-floor-controls"
              onSubmit={(event) => {
                event.preventDefault();
                if (validFloor) {
                  void update({ hostAwakeBatteryFloorPercent: parsedFloor });
                }
              }}
            >
              <TextInput
                type="number"
                unit="%"
                invalid={!validFloor}
                aria-describedby={validFloor ? undefined : floorInvalidId}
                min={1}
                max={100}
                step={1}
                value={floorDraft}
                aria-label={t("hostAwakeBatteryFloorInput")}
                disabled={saving}
                onChange={(event) => setFloorDraft(event.target.value)}
              />
              <Button
                variant="primary"
                type="submit"
                disabled={
                  saving || !validFloor || parsedFloor === batteryFloorPercent
                }
              >
                {t("hostAwakeBatteryFloorSave")}
              </Button>
            </form>
            {!validFloor && (
              <Banner id={floorInvalidId} tone="error" role="none" compact>
                {t("hostAwakeBatteryFloorInvalid")}
              </Banner>
            )}
          </SettingsItem>
        )}
    </div>
  );
}

export function RemoteAccessSettings() {
  const { t } = useI18n();
  useSettingsPaneTitle(t("settingsRemoteTitle"));
  const remoteConnection = useOptionalRemoteConnection();
  const { version } = useVersion();

  const publicShareManagementSupported = serverHasCapability(
    version,
    PUBLIC_SHARE_MANAGEMENT_CAPABILITY,
  );
  const [showPublicShareManagement, setShowPublicShareManagement] =
    useState(false);
  useEffect(() => {
    if (!publicShareManagementSupported) {
      setShowPublicShareManagement(false);
    }
  }, [publicShareManagementSupported]);
  const {
    status: hostAwakeStatus,
    isLoading: hostAwakeStatusLoading,
    error: hostAwakeStatusError,
    refetch: refetchHostAwakeStatus,
  } = useHostAwakeStatus(true);
  const { settings, isLoading, error, updateSetting, updateSettings } =
    useServerSettings();
  const publicSharesEnabled = settings?.publicSharesEnabled ?? false;
  const { status: publicShareStatus } = usePublicShareStatus({
    poll: publicSharesEnabled,
  });

  const handleSwitchHost = () => {
    if (remoteConnection?.switchHost) {
      remoteConnection.switchHost();
      return;
    }
    remoteConnection?.disconnect();
    markSwitchHostReload();
    window.location.replace(
      buildFrontendReloadUrl(window.location.href, String(Date.now())),
    );
  };

  const defaultYaClientBaseUrl =
    publicShareStatus?.defaultYaClientBaseUrl ?? DEFAULT_YA_CLIENT_BASE_URL;
  const effectiveYaClientBaseUrl =
    settings?.yaClientBaseUrl ??
    publicShareStatus?.yaClientBaseUrl ??
    defaultYaClientBaseUrl;
  const defaultViewerBaseUrl =
    publicShareStatus?.defaultViewerBaseUrl ??
    DEFAULT_PUBLIC_SHARE_VIEWER_BASE_URL;
  const effectiveViewerBaseUrl =
    publicShareStatus?.viewerBaseUrl ?? defaultViewerBaseUrl;

  const getShareReadinessMessage = (
    status: PublicShareStatusResponse | null,
  ): { warning: boolean; text: string } | null => {
    if (!status) return null;
    if (!status.configured) {
      return {
        warning: true,
        text: t("advancedPublicShareRelayMissing"),
      };
    }
    if (!status.remoteAccessEnabled) {
      return {
        warning: true,
        text: t("advancedPublicShareRemoteAccessDisabled"),
      };
    }
    if (status.relayStatus !== "waiting") {
      return {
        warning: true,
        text: t("advancedPublicShareRelayTemporarilyUnavailable", {
          status: status.relayStatus ?? "unknown",
        }),
      };
    }
    return {
      warning: false,
      text: t("advancedPublicShareReady"),
    };
  };

  const shareReadinessMessage = getShareReadinessMessage(publicShareStatus);
  const updatePublicSharesEnabled = async (enabled: boolean) => {
    if (
      !enabled &&
      publicShareManagementSupported &&
      !window.confirm(
        typeof publicShareStatus?.totalValidLinks === "number"
          ? t("advancedPublicShareDisableConfirm", {
              count: publicShareStatus.totalValidLinks,
            })
          : t("advancedPublicShareDisableConfirmUnknown"),
      )
    ) {
      return;
    }
    await updateSetting("publicSharesEnabled", enabled);
    if (!enabled) setShowPublicShareManagement(false);
  };
  const hostIdentityItem = (
    <HostIdentitySettings
      currentIcon={settings?.hostIdentity?.icon ?? ""}
      disabled={isLoading}
      onChange={(identity) => updateSetting("hostIdentity", identity)}
    />
  );
  const hostAwakeConfig = (
    <HostAwakeSettings
      status={hostAwakeStatus}
      statusError={hostAwakeStatusError}
      statusLoading={hostAwakeStatusLoading}
      settingsLoading={isLoading}
      mode={settings?.hostAwakeMode ?? "off"}
      batteryFloorPercent={
        settings?.hostAwakeBatteryFloorPercent ??
        DEFAULT_HOST_AWAKE_BATTERY_FLOOR_PERCENT
      }
      onUpdate={updateSettings}
      onRefresh={async () => {
        await refetchHostAwakeStatus(true);
      }}
    />
  );

  // Public read-only share only works once Remote Access (relay) is configured,
  // so its controls live at the top of this tab.
  const publicShareConfig = (
    <div className="settings-group">
      <SettingsItem
        label={t("advancedPublicShareTitle")}
        description={t("advancedPublicShareDescription")}
        doc="site/src/content/docs/security-and-privacy.md#public-session-shares"
        info={
          <>
            <strong>{t("advancedPublicShareTitle")}</strong>
            <p>{t("advancedPublicShareDescription")}</p>
            <p>{t("advancedPublicSharePrivacyWarning")}</p>
            <p>{t("advancedPublicShareExistingManagement")}</p>
            {shareReadinessMessage?.warning ? (
              <Banner tone="warning" role="none" compact>
                {shareReadinessMessage.text}
              </Banner>
            ) : shareReadinessMessage ? (
              <p className="settings-hint">{shareReadinessMessage.text}</p>
            ) : null}
            {publicShareStatus?.relayUrl && (
              <p className="settings-hint" style={{ wordBreak: "break-all" }}>
                {t("advancedPublicShareRelayEffective", {
                  username: publicShareStatus.relayUsername ?? "",
                  url: publicShareStatus.relayUrl,
                })}
              </p>
            )}
          </>
        }
      >
        <Switch
          checked={publicSharesEnabled}
          disabled={isLoading}
          onCheckedChange={(checked) => void updatePublicSharesEnabled(checked)}
          aria-label={t("advancedPublicShareTitle")}
        />
      </SettingsItem>

      {/* Limited users live in Settings → Users, beside the list they govern. */}

      {publicShareManagementSupported && (
        <SettingsItem
          id="manage-public-shares"
          label={t("advancedPublicShareManageTitle")}
          description={t("advancedPublicShareManageDescription")}
          keywords={[
            "public share",
            "broadcast",
            "link",
            "manage",
            "revoke",
            "viewer",
          ]}
        >
          <Button onClick={() => setShowPublicShareManagement(true)}>
            {t("advancedPublicShareManageButton")}
          </Button>
        </SettingsItem>
      )}

      {showPublicShareManagement && publicShareManagementSupported && (
        <PublicShareManagerModal
          creationReady={false}
          onClose={() => setShowPublicShareManagement(false)}
        />
      )}
    </div>
  );

  const yaClientInfo = (
    <HideInSettingsSearch>
      <div className="form-hint">
        <p>
          <strong>{t("advancedYaClientTitle")}</strong>.{" "}
          {t("advancedYaClientDescription")}
        </p>
        <p style={{ wordBreak: "break-all" }}>
          {t("advancedYaClientEffective", {
            url: effectiveYaClientBaseUrl,
          })}
        </p>
        <p style={{ wordBreak: "break-all" }}>
          {t("advancedPublicShareViewerEffective", {
            url: effectiveViewerBaseUrl,
          })}
        </p>
        {publicShareStatus?.yaClientBaseUrlError && (
          <Banner tone="error" compact>
            {publicShareStatus.yaClientBaseUrlError}
          </Banner>
        )}
      </div>
    </HideInSettingsSearch>
  );

  const persistSessionsToggle = (
    <>
      <div className="settings-group">
        <SettingsItem
          label={t("developmentPersistRemoteTitle")}
          doc="topics/mobile-server-pairing.md#current-srp-resume-facts"
          description={`${t("developmentPersistRemoteDescriptionPrefix")} remote-sessions.json ${t("developmentPersistRemoteDescriptionSuffix")}`}
          info={
            <>
              <strong>{t("developmentPersistRemoteTitle")}</strong>
              <p>
                {t("developmentPersistRemoteDescriptionPrefix")}{" "}
                <code>remote-sessions.json</code>{" "}
                {t("developmentPersistRemoteDescriptionSuffix")}
              </p>
            </>
          }
        >
          <Switch
            checked={settings?.persistRemoteSessionsToDisk ?? true}
            disabled={isLoading}
            onCheckedChange={(checked) =>
              void updateSetting("persistRemoteSessionsToDisk", checked)
            }
            aria-label={t("developmentPersistRemoteTitle")}
          />
        </SettingsItem>
      </div>

      <HideInSettingsSearch>
        {error && <Banner tone="error">{error}</Banner>}
      </HideInSettingsSearch>
    </>
  );

  // This Remote Access link's own host, relay and logout: connection info and
  // a session action, not server settings. Everything below it renders the
  // same for direct and Remote Access clients (topics/connection-safe-settings.md).
  const currentHost = remoteConnection?.currentHostId
    ? getHostById(remoteConnection.currentHostId)
    : null;
  const remoteSessionGroup = remoteConnection && (
    <div className="settings-group">
      <SettingsItem
        id="remote-access-session-host"
        label={t("remoteAccessCurrentHostTitle")}
        description={
          currentHost?.displayName ||
          remoteConnection.storedUsername ||
          t("remoteAccessDefaultHost")
        }
      >
        <div className="settings-item-actions">
          <Button onClick={handleSwitchHost}>{t("sidebarSwitchHost")}</Button>
        </div>
      </SettingsItem>
      {currentHost?.relayUrl && (
        <SettingsItem
          id="remote-access-session-relay"
          label={t("remoteAccessRelayUrlTitle")}
          description={currentHost.relayUrl}
        />
      )}
      <SettingsItem
        id="remote-access-session-logout"
        label={t("remoteAccessLogoutTitle")}
        description={t("remoteAccessLogoutDescription")}
      >
        <Button variant="danger" onClick={() => remoteConnection.disconnect()}>
          {t("remoteAccessLogout")}
        </Button>
      </SettingsItem>
    </div>
  );

  return (
    <SettingsSection
      description={
        remoteConnection ? t("remoteAccessConnectedDescription") : undefined
      }
    >
      <AppsSettingsLink />
      {remoteSessionGroup}
      {hostIdentityItem && (
        <div className="settings-group">{hostIdentityItem}</div>
      )}
      {hostAwakeConfig}
      {publicShareConfig}
      <HideInSettingsSearch>
        <RemoteAccessSetup
          title={t("remoteAccessConnectedTitle")}
          description={t("remoteAccessSetupDescription")}
          yaClientInfo={yaClientInfo}
        />
      </HideInSettingsSearch>
      {serverHasCapability(version, SERVER_CAPABILITIES.peerConnections) && (
        <SettingsItem
          label={t("connectionsPairedServers")}
          description={t("connectionsPasswordChangesHint")}
        >
          <Link className="settings-link" to="/settings/server-connections">
            {t("settingsServerConnectionsTitle")}
          </Link>
        </SettingsItem>
      )}
      {persistSessionsToggle}
    </SettingsSection>
  );
}
