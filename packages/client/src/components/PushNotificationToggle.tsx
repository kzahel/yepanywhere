import { useState } from "react";
import {
  PUSH_ERROR_DEV_MODE_DISABLED,
  PUSH_ERROR_INSECURE_CONTEXT,
} from "../hooks/pushSupport";
import { useNotifyInApp } from "../hooks/useNotifyInApp";
import { usePushNotifications } from "../hooks/usePushNotifications";
import { useI18n } from "../i18n";

export type TestNotificationUrgency = "normal" | "persistent" | "silent";

/**
 * Toggle component for push notification settings.
 * Shows subscription status, toggle switch, and test button.
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
    sendTest,
  } = usePushNotifications();
  const { notifyInApp, setNotifyInApp } = useNotifyInApp();
  const [testUrgency, setTestUrgency] =
    useState<TestNotificationUrgency>("normal");

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
    const isDevModeDisabled = error === PUSH_ERROR_DEV_MODE_DISABLED;
    const isInsecureContext = error === PUSH_ERROR_INSECURE_CONTEXT;

    return (
      <div className="settings-item">
        <div className="settings-item-info">
          <strong>{t("pushToggleTitle")}</strong>
          <p>{error || t("pushToggleUnsupported")}</p>
          {isInsecureContext && (
            <div className="settings-info-box" style={{ marginTop: "0.5rem" }}>
              <p>{t("pushToggleSecureContextHint")}</p>
              <p>{t("pushToggleSecureContextAction")}</p>
            </div>
          )}
          {isDevModeDisabled && (
            <div className="settings-info-box" style={{ marginTop: "0.5rem" }}>
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
        </div>
      </div>
    );
  }

  // Permission denied - show how to fix
  if (permission === "denied") {
    return (
      <div className="settings-item">
        <div className="settings-item-info">
          <strong>{t("pushToggleTitle")}</strong>
          <p className="settings-warning">{t("pushToggleBlocked")}</p>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="settings-item">
        <div className="settings-item-info">
          <strong>{t("pushToggleTitle")}</strong>
          <p>{t("pushToggleDescription")}</p>
          {error && <p className="settings-error">{error}</p>}
        </div>
        <label className="toggle-switch">
          <input
            type="checkbox"
            checked={isSubscribed}
            onChange={handleToggle}
            disabled={isLoading}
          />
          <span className="toggle-slider" />
        </label>
      </div>

      {isSubscribed && (
        <>
          <div className="settings-item">
            <div className="settings-item-info">
              <strong>{t("pushToggleNotifyInAppTitle")}</strong>
              <p>{t("pushToggleNotifyInAppDescription")}</p>
            </div>
            <label className="toggle-switch">
              <input
                type="checkbox"
                checked={notifyInApp}
                onChange={(e) => setNotifyInApp(e.target.checked)}
              />
              <span className="toggle-slider" />
            </label>
          </div>
          <div className="settings-item">
            <div className="settings-item-info">
              <strong>{t("pushToggleTestTitle")}</strong>
              <p>{t("pushToggleTestDescription")}</p>
            </div>
            <div className="settings-item-actions">
              <select
                className="settings-select"
                value={testUrgency}
                onChange={(e) =>
                  setTestUrgency(e.target.value as TestNotificationUrgency)
                }
                disabled={isLoading}
              >
                <option value="normal">{t("pushToggleUrgencyNormal")}</option>
                <option value="persistent">
                  {t("pushToggleUrgencyPersistent")}
                </option>
                <option value="silent">{t("pushToggleUrgencySilent")}</option>
              </select>
              <button
                type="button"
                className="settings-button"
                onClick={() => sendTest(testUrgency)}
                disabled={isLoading}
              >
                {isLoading ? t("pushToggleSending") : t("pushToggleSendTest")}
              </button>
            </div>
          </div>
        </>
      )}
    </>
  );
}
