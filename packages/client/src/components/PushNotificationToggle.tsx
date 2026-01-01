import { usePushNotifications } from "../hooks/usePushNotifications";

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

  const handleToggle = async () => {
    if (isSubscribed) {
      await unsubscribe();
    } else {
      await subscribe();
    }
  };

  // Not supported - show message
  if (!isSupported) {
    return (
      <div className="settings-item">
        <div className="settings-item-info">
          <strong>Push Notifications</strong>
          <p className="settings-muted">
            Push notifications are not supported in this browser.
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
        <div className="settings-item">
          <div className="settings-item-info">
            <strong>Test Notification</strong>
            <p>Send a test notification to verify push is working.</p>
          </div>
          <button
            type="button"
            className="settings-button"
            onClick={sendTest}
            disabled={isLoading}
          >
            {isLoading ? "Sending..." : "Send Test"}
          </button>
        </div>
      )}
    </>
  );
}
