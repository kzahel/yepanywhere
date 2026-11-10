import rowsStyles from "../pages/settings/SettingsRows.module.css";
import { useNotifyInApp } from "../hooks/useNotifyInApp";
import {
  PUSH_PERMISSION_REQUEST_TIMED_OUT,
  usePushNotifications,
} from "../hooks/usePushNotifications";
import { useI18n } from "../i18n";
import { Banner } from "./ui/Banner";
import { Switch } from "./ui/Switch";
import { SettingsItem } from "../pages/settings/SettingsItem";

/**
 * Toggle component for this browser's Web Push subscription and local
 * focused-window presentation preference.
 */
export function PushNotificationToggle() {
  const { t } = useI18n();
  const {
    isSupported,
    isSubscribed,
    isLoading,
    error,
    permission,
    subscribe,
    unsubscribe,
  } = usePushNotifications();
  const { notifyInApp, setNotifyInApp } = useNotifyInApp();
  const displayedError =
    error === PUSH_PERMISSION_REQUEST_TIMED_OUT
      ? t("pushTogglePermissionRequestTimedOut")
      : error;

  const handleToggle = async () => {
    if (isSubscribed) {
      await unsubscribe();
    } else {
      await subscribe();
    }
  };

  // Not supported - show message with reason and help link
  if (!isSupported) {
    // Check if this is specifically the dev mode SW disabled case
    const isDevModeDisabled = error?.includes(
      "Service worker disabled in dev mode",
    );

    return (
      <SettingsItem
        label={t("pushToggleTitle")}
        description={error || t("pushToggleUnsupported")}
        info={
          <>
            <strong>{t("pushToggleTitle")}</strong>
            <p>{error || t("pushToggleUnsupported")}</p>
            {isDevModeDisabled && (
              <div
                className={rowsStyles.infoBox}
                style={{ marginTop: "0.5rem" }}
              >
                <p>{t("pushToggleThisDeviceOnly")}</p>
                <p>{t("pushToggleDevModeHint")}</p>
              </div>
            )}
            <p style={{ marginTop: "0.5rem" }}>
              <a
                href="https://github.com/kzahel/yepanywhere/blob/main/docs/push-notifications.md"
                target="_blank"
                rel="noopener noreferrer"
              >
                {t("pushToggleTroubleshooting")}
              </a>
            </p>
          </>
        }
      />
    );
  }

  // Permission denied - show how to fix
  if (permission === "denied") {
    return (
      <SettingsItem
        label={t("pushToggleTitle")}
        description={t("pushToggleBlocked")}
        info={
          <>
            <strong>{t("pushToggleTitle")}</strong>
            <Banner tone="warning" role="none" compact>
              {t("pushToggleBlocked")}
            </Banner>
          </>
        }
      />
    );
  }

  return (
    <>
      <SettingsItem
        label={t("pushToggleTitle")}
        description={t("pushToggleDescription")}
        doc="site/src/content/docs/notifications-and-voice.md#browser-push-notifications"
        info={
          <>
            <strong>{t("pushToggleTitle")}</strong>
            <p>{t("pushToggleDescription")}</p>
            {displayedError && (
              <Banner tone="error" compact>
                {displayedError}
              </Banner>
            )}
          </>
        }
      >
        <Switch
          aria-label={t("pushToggleTitle")}
          checked={isSubscribed}
          onCheckedChange={handleToggle}
          disabled={isLoading}
        />
      </SettingsItem>

      {isSubscribed && (
        <SettingsItem
          label={t("pushToggleNotifyInAppTitle")}
          description={t("pushToggleNotifyInAppDescription")}
        >
          <Switch
            aria-label={t("pushToggleNotifyInAppTitle")}
            checked={notifyInApp}
            onCheckedChange={setNotifyInApp}
          />
        </SettingsItem>
      )}
    </>
  );
}
