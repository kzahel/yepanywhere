import deviceListStyles from "./DeviceList.module.css";
import rowsStyles from "./SettingsRows.module.css";
import devicesStyles from "./DevicesSettings.module.css";
import { Badge } from "../../components/ui/Badge";
import { Banner } from "../../components/ui/Banner";
import { Button } from "../../components/ui/Button";
import { useBrowserProfiles } from "../../hooks/useBrowserProfiles";
import { useConnectedDevices } from "../../hooks/useConnectedDevices";
import { usePushNotifications } from "../../hooks/usePushNotifications";
import { useI18n } from "../../i18n";
import { useSettingsPaneTitle } from "./SettingsPaneTitleContext";
import { HideInSettingsSearch } from "./SettingsSearchContext";
import { SettingsSection } from "./SettingsSection";
import { parseUserAgent } from "../../lib/deviceDetection";

/**
 * Format a date for display with relative time.
 */
function formatDate(
  isoDate: string,
  t: (key: never, vars?: Record<string, string | number>) => string,
): string {
  const date = new Date(isoDate);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMinutes = Math.floor(diffMs / (1000 * 60));
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffMinutes < 1) {
    return t("devicesJustNow" as never);
  }
  if (diffMinutes < 60) {
    return t("devicesMinutesAgo" as never, {
      count: diffMinutes,
      suffix: diffMinutes === 1 ? "" : "s",
    });
  }
  if (diffHours < 24) {
    return t("devicesHoursAgo" as never, {
      count: diffHours,
      suffix: diffHours === 1 ? "" : "s",
    });
  }
  if (diffDays === 1) {
    return t("devicesYesterday" as never);
  }
  if (diffDays < 7) {
    return `${diffDays} days ago`;
  }
  return date.toLocaleDateString();
}

/**
 * Format an origin URL for display.
 * Shows a simplified version with just scheme://hostname:port
 */
function formatOrigin(origin: string): string {
  return origin;
}

/**
 * Devices settings page.
 * Shows all browser profiles with their connection origin history.
 */
export function DevicesSettings() {
  const { t } = useI18n();
  useSettingsPaneTitle(t("devicesProfilesTitle"));
  const { profiles, isLoading, error, deleteProfile } = useBrowserProfiles();
  const { browserProfileId: currentBrowserProfileId } = usePushNotifications();
  const { connections } = useConnectedDevices();

  return (
    <SettingsSection description={t("devicesProfilesDescription")}>
      <HideInSettingsSearch>
        {error && <Banner tone="error">{error}</Banner>}

        <div className={rowsStyles.group} data-settings-group>
          {isLoading ? (
            <p className={rowsStyles.hint}>{t("devicesLoadingProfiles")}</p>
          ) : profiles.length === 0 ? (
            <p className={rowsStyles.hint}>{t("devicesEmpty")}</p>
          ) : (
            <div className={deviceListStyles.list}>
              {profiles.map((profile) => {
                const isCurrentDevice =
                  profile.browserProfileId === currentBrowserProfileId;
                const isConnected = connections.has(profile.browserProfileId);
                const displayName =
                  profile.deviceName ||
                  `${profile.browserProfileId.slice(0, 8)}...`;

                return (
                  <div
                    key={profile.browserProfileId}
                    className={`${deviceListStyles.listItem} device-profile-item`}
                  >
                    <div className={deviceListStyles.listInfo}>
                      <strong>
                        <span
                          className={`${deviceListStyles.status} ${isConnected ? deviceListStyles.statusOnline : deviceListStyles.statusOffline}`}
                          title={
                            isConnected
                              ? t("devicesConnected")
                              : t("devicesDisconnected")
                          }
                        />
                        {displayName}
                        {isCurrentDevice && (
                          <Badge tone="accent">{t("devicesThisDevice")}</Badge>
                        )}
                      </strong>

                      {/* Origin list */}
                      <div className={devicesStyles.origins}>
                        {profile.origins.map((origin) => {
                          const { browser, os } = parseUserAgent(
                            origin.userAgent,
                          );
                          return (
                            <div
                              key={origin.origin}
                              className={devicesStyles.origin}
                            >
                              <code className={devicesStyles.originUrl}>
                                {formatOrigin(origin.origin)}
                              </code>
                              <span className={devicesStyles.originDetails}>
                                {browser} · {os}
                              </span>
                              <span className={devicesStyles.originTime}>
                                {t("devicesLastSeen", {
                                  date: formatDate(origin.lastSeen, t),
                                })}
                              </span>
                            </div>
                          );
                        })}
                      </div>

                      <p className={devicesStyles.profileMeta}>
                        {t("devicesFirstSeen", {
                          date: formatDate(profile.createdAt, t),
                        })}
                      </p>
                    </div>

                    <Button
                      variant="danger-outline"
                      onClick={() => deleteProfile(profile.browserProfileId)}
                      title={t("devicesForgetThisDevice")}
                    >
                      {t("devicesForget")}
                    </Button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </HideInSettingsSearch>
    </SettingsSection>
  );
}
