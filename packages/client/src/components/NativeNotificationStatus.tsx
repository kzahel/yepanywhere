import { useEffect, useState } from "react";
import { type MessageKey, useI18n } from "../i18n";
import {
  NATIVE_NOTIFICATION_MANAGE_FEATURE,
  type NativeNotificationStatus as NativeStatus,
  nativeHost,
} from "../lib/nativeHost";
import { SettingsItem } from "../pages/settings/SettingsItem";
import { Button } from "./ui/Button";

function statusKey(status: NativeStatus | null | undefined): MessageKey {
  if (status === undefined) return "notificationsAppChecking";
  if (status === null) return "notificationsAppServers";
  if (status.firebase === "unavailable") return "notificationsAppUnavailable";
  if (status.notificationsEnabled) return "notificationsAppAllowed";
  if (status.permission === "not_requested") return "notificationsAppServers";
  return "notificationsAppBlocked";
}

/**
 * The Android and iOS apps receive push natively, per server, from their own
 * Servers screen. Their WebView has no Web Push, so this replaces the browser
 * toggle with the app's status and a way to reach those controls.
 */
export function NativeNotificationStatus() {
  const { t } = useI18n();
  // undefined while loading; null when this app version reports no status.
  const [status, setStatus] = useState<NativeStatus | null | undefined>();
  const [canManage, setCanManage] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      void nativeHost.describe().then((descriptor) => {
        if (!cancelled) {
          setCanManage(
            descriptor?.features.includes(NATIVE_NOTIFICATION_MANAGE_FEATURE) ??
              false,
          );
        }
      });
      nativeHost.notifications
        .status()
        .then((next) => {
          if (!cancelled) setStatus(next);
        })
        .catch(() => {
          if (!cancelled) setStatus(null);
        });
    };
    refresh();
    // Notification settings change outside the page, e.g. in system Settings.
    const onVisible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  const manage = () => {
    setError(null);
    nativeHost.notifications.manage().catch(() => {
      setError(t("notificationsAppManageFailed"));
    });
  };

  return (
    <SettingsItem
      label={t("notificationsAppTitle")}
      description={error ?? t(statusKey(status))}
    >
      {canManage && (
        <Button onClick={manage}>{t("notificationsAppManage")}</Button>
      )}
    </SettingsItem>
  );
}
