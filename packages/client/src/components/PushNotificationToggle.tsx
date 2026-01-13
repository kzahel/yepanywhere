import { useState } from "react";
import { useNotifyInApp } from "../hooks/useNotifyInApp";
import { usePushNotifications } from "../hooks/usePushNotifications";

export type TestNotificationUrgency = "normal" | "persistent" | "silent";

/**
 * Toggle component for push notification settings.
 * Shows subscription status, toggle switch, and test button.
 */
export function PushNotificationToggle() {
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
    const isDevModeDisabled = error?.includes(
      "Service worker disabled in dev mode",
    );

    return (
      <div className="settings-item">
        <div className="settings-item-info">
          <strong>Push Notifications</strong>
          <p>
            {error || "Push notifications are not supported in this browser."}
          </p>
          {isDevModeDisabled && (
            <div className="settings-info-box" style={{ marginTop: "0.5rem" }}>
              <p>
                This only affects <strong>this device</strong>. Other subscribed
                devices will still receive notifications from the server.
              </p>
              <p>
                To enable push on this device in dev mode, restart with{" "}
                <code>VITE_ENABLE_SW=true</code>.
              </p>
            </div>
          )}
          <p style={{ marginTop: "0.5rem" }}>
            <a
              href="https://github.com/kzahel/yepanywhere/blob/main/docs/push-notifications.md"
              target="_blank"
              rel="noopener noreferrer"
            >
              Troubleshooting guide
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
          <strong>Push Notifications</strong>
          <p className="settings-warning">
            Notifications are blocked. Enable them in your browser settings to
            receive push notifications.
          </p>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="settings-item">
        <div className="settings-item-info">
          <strong>Push Notifications</strong>
          <p>
            Receive notifications when a session needs your attention, even when
            the app is in the background.
          </p>
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
              <strong>Notify When In App</strong>
              <p>
                Show notifications even when the app is open, as long as you're
                not viewing that session.
              </p>
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
              <strong>Test Notification</strong>
              <p>Send a test notification to verify push is working.</p>
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
                <option value="normal">Normal (auto-dismiss)</option>
                <option value="persistent">Persistent (stays visible)</option>
                <option value="silent">Silent (no sound)</option>
              </select>
              <button
                type="button"
                className="settings-button"
                onClick={() => sendTest(testUrgency)}
                disabled={isLoading}
              >
                {isLoading ? "Sending..." : "Send Test"}
              </button>
            </div>
          </div>
        </>
      )}
    </>
  );
}
