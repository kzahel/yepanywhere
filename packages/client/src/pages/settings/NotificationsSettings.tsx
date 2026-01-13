import { PushNotificationToggle } from "../../components/PushNotificationToggle";
import { useNotificationSettings } from "../../hooks/useNotificationSettings";
import { usePushNotifications } from "../../hooks/usePushNotifications";
import { useSubscribedDevices } from "../../hooks/useSubscribedDevices";

/**
 * Format a device name with its domain for display.
 */
function formatDeviceName(
  deviceName: string | undefined,
  endpointDomain: string,
): string {
  const name = deviceName || "Unknown device";
  // Extract push service type from domain
  if (endpointDomain.includes("google")) {
    return `${name} (Android/Chrome)`;
  }
  if (
    endpointDomain.includes("apple") ||
    endpointDomain.includes("push.apple")
  ) {
    return `${name} (iOS/Safari)`;
  }
  if (
    endpointDomain.includes("mozilla") ||
    endpointDomain.includes("push.services.mozilla")
  ) {
    return `${name} (Firefox)`;
  }
  return name;
}

/**
 * Format a date string to a relative or absolute format.
 */
function formatDate(dateString: string): string {
  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays === 0) {
    return "today";
  }
  if (diffDays === 1) {
    return "yesterday";
  }
  if (diffDays < 7) {
    return `${diffDays} days ago`;
  }
  return date.toLocaleDateString();
}

export function NotificationsSettings() {
  const { browserProfileId } = usePushNotifications();
  const {
    devices,
    isLoading: devicesLoading,
    removeDevice,
  } = useSubscribedDevices();
  const {
    settings,
    isLoading: settingsLoading,
    updateSetting,
  } = useNotificationSettings();

  const hasSubscriptions = devices.length > 0;

  return (
    <>
      {/* Server-side settings - what types of notifications are sent */}
      <section className="settings-section">
        <h2>Server Notification Types</h2>
        <p className="settings-section-description">
          Control what types of events trigger push notifications to all
          devices.
        </p>
        <div className="settings-group">
          <div className="settings-item">
            <div className="settings-item-info">
              <strong>Tool Approvals</strong>
              <p>
                Notify when Claude needs permission to run a tool (file edits,
                commands, etc.)
              </p>
            </div>
            <label className="toggle-switch">
              <input
                type="checkbox"
                checked={settings?.toolApproval ?? true}
                onChange={(e) =>
                  updateSetting("toolApproval", e.target.checked)
                }
                disabled={settingsLoading || !hasSubscriptions}
              />
              <span className="toggle-slider" />
            </label>
          </div>

          <div className="settings-item">
            <div className="settings-item-info">
              <strong>User Questions</strong>
              <p>Notify when Claude asks a question and needs your response.</p>
            </div>
            <label className="toggle-switch">
              <input
                type="checkbox"
                checked={settings?.userQuestion ?? true}
                onChange={(e) =>
                  updateSetting("userQuestion", e.target.checked)
                }
                disabled={settingsLoading || !hasSubscriptions}
              />
              <span className="toggle-slider" />
            </label>
          </div>

          <div className="settings-item">
            <div className="settings-item-info">
              <strong>Session Halted</strong>
              <p>
                Notify when a session completes, errors out, or becomes idle.
              </p>
            </div>
            <label className="toggle-switch">
              <input
                type="checkbox"
                checked={settings?.sessionHalted ?? true}
                onChange={(e) =>
                  updateSetting("sessionHalted", e.target.checked)
                }
                disabled={settingsLoading || !hasSubscriptions}
              />
              <span className="toggle-slider" />
            </label>
          </div>

          {!hasSubscriptions && !devicesLoading && (
            <p className="settings-hint">
              No devices subscribed. Enable push notifications below to use
              these settings.
            </p>
          )}
        </div>
      </section>

      {/* This device - local push subscription */}
      <section className="settings-section">
        <h2>This Device</h2>
        <p className="settings-section-description">
          Enable push notifications on this device to receive alerts when
          sessions need attention.
        </p>
        <div className="settings-group">
          <PushNotificationToggle />
        </div>
      </section>

      {/* Subscribed devices list */}
      <section className="settings-section">
        <h2>Subscribed Devices</h2>
        <p className="settings-section-description">
          All devices receiving push notifications from this server.
        </p>
        <div className="settings-group">
          {devicesLoading ? (
            <p className="settings-hint">Loading devices...</p>
          ) : devices.length === 0 ? (
            <p className="settings-hint">
              No devices subscribed. Enable push notifications above.
            </p>
          ) : (
            <div className="device-list">
              {devices.map((device) => {
                const isCurrentDevice =
                  device.browserProfileId === browserProfileId;
                return (
                  <div
                    key={device.browserProfileId}
                    className="device-list-item"
                  >
                    <div className="device-list-info">
                      <strong>
                        {formatDeviceName(
                          device.deviceName,
                          device.endpointDomain,
                        )}
                        {isCurrentDevice && (
                          <span className="device-current-badge">
                            This device
                          </span>
                        )}
                      </strong>
                      <p>Subscribed {formatDate(device.createdAt)}</p>
                    </div>
                    <button
                      type="button"
                      className="settings-button settings-button-danger-subtle"
                      onClick={() => removeDevice(device.browserProfileId)}
                      title={
                        isCurrentDevice
                          ? "Unsubscribe this device"
                          : "Remove this device"
                      }
                    >
                      Remove
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </section>
    </>
  );
}
