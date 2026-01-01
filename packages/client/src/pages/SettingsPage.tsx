import { useEffect, useState } from "react";
import { PageHeader } from "../components/PageHeader";
import { PushNotificationToggle } from "../components/PushNotificationToggle";
import {
  FONT_SIZES,
  type FontSize,
  getFontSizeLabel,
  useFontSize,
} from "../hooks/useFontSize";
import { useMediaQuery } from "../hooks/useMediaQuery";
import {
  MODEL_OPTIONS,
  THINKING_LEVEL_OPTIONS,
  useModelSettings,
} from "../hooks/useModelSettings";
import { useReloadNotifications } from "../hooks/useReloadNotifications";
import { useStreamingEnabled } from "../hooks/useStreamingEnabled";

export function SettingsPage() {
  const {
    isManualReloadMode,
    pendingReloads,
    connected,
    reloadBackend,
    reloadFrontend,
    unsafeToRestart,
    workerActivity,
  } = useReloadNotifications();
  const { fontSize, setFontSize } = useFontSize();
  const { streamingEnabled, setStreamingEnabled } = useStreamingEnabled();
  const {
    model,
    setModel,
    thinkingLevel,
    setThinkingLevel,
    thinkingEnabled,
    setThinkingEnabled,
  } = useModelSettings();
  const [restarting, setRestarting] = useState(false);

  // Desktop layout hook
  const isWideScreen = useMediaQuery("(min-width: 1100px)");

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

  const handleReloadFrontend = () => {
    reloadFrontend();
  };

  return (
    <div className="session-page">
      {/* Main content wrapper for desktop centering */}
      <div className={isWideScreen ? "main-content-wrapper" : undefined}>
        <div className={isWideScreen ? "main-content-constrained" : undefined}>
          <PageHeader title="Settings" />

          <main className="sessions-page-content">
            <section className="settings-section">
              <h2>Appearance</h2>
              <div className="settings-group">
                <div className="settings-item">
                  <div className="settings-item-info">
                    <strong>Font Size</strong>
                    <p>Adjust the text size throughout the application.</p>
                  </div>
                  <div className="font-size-selector">
                    {FONT_SIZES.map((size) => (
                      <button
                        key={size}
                        type="button"
                        className={`font-size-option ${fontSize === size ? "active" : ""}`}
                        onClick={() => setFontSize(size)}
                      >
                        {getFontSizeLabel(size)}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="settings-item">
                  <div className="settings-item-info">
                    <strong>Response Streaming</strong>
                    <p>
                      Show responses as they are generated, token by token.
                      Disable for better performance on slower devices.
                    </p>
                  </div>
                  <label className="toggle-switch">
                    <input
                      type="checkbox"
                      checked={streamingEnabled}
                      onChange={(e) => setStreamingEnabled(e.target.checked)}
                    />
                    <span className="toggle-slider" />
                  </label>
                </div>
              </div>
            </section>

            <section className="settings-section">
              <h2>Model</h2>
              <div className="settings-group">
                <div className="settings-item">
                  <div className="settings-item-info">
                    <strong>Model</strong>
                    <p>Select which Claude model to use for new sessions.</p>
                  </div>
                  <div className="font-size-selector">
                    {MODEL_OPTIONS.map((opt) => (
                      <button
                        key={opt.value}
                        type="button"
                        className={`font-size-option ${model === opt.value ? "active" : ""}`}
                        onClick={() => setModel(opt.value)}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="settings-item">
                  <div className="settings-item-info">
                    <strong>Extended Thinking</strong>
                    <p>
                      Allow the model to "think" before responding. Toggle on to
                      enable deeper reasoning.
                    </p>
                  </div>
                  <label className="toggle-switch">
                    <input
                      type="checkbox"
                      checked={thinkingEnabled}
                      onChange={(e) => setThinkingEnabled(e.target.checked)}
                    />
                    <span className="toggle-slider" />
                  </label>
                </div>
                <div className="settings-item">
                  <div className="settings-item-info">
                    <strong>Thinking Level</strong>
                    <p>
                      Token budget for thinking. Higher levels enable deeper
                      reasoning but use more tokens.
                    </p>
                  </div>
                  <div className="font-size-selector">
                    {THINKING_LEVEL_OPTIONS.map((opt) => (
                      <button
                        key={opt.value}
                        type="button"
                        className={`font-size-option ${thinkingLevel === opt.value ? "active" : ""}`}
                        onClick={() => setThinkingLevel(opt.value)}
                        title={opt.description}
                      >
                        {opt.label} ({opt.description})
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </section>

            <section className="settings-section">
              <h2>Notifications</h2>
              <div className="settings-group">
                <PushNotificationToggle />
              </div>
            </section>

            <section className="settings-section">
              <h2>Development</h2>

              {isManualReloadMode ? (
                <div className="settings-group">
                  <div className="settings-item">
                    <div className="settings-item-info">
                      <strong>Restart Server</strong>
                      <p>
                        Restart the backend server to pick up code changes.
                        {pendingReloads.backend && (
                          <span className="settings-pending">
                            {" "}
                            (changes pending)
                          </span>
                        )}
                      </p>
                      {unsafeToRestart && (
                        <p className="settings-warning">
                          {workerActivity.activeWorkers} active session
                          {workerActivity.activeWorkers !== 1 ? "s" : ""} will
                          be interrupted
                        </p>
                      )}
                    </div>
                    <button
                      type="button"
                      className={`settings-button ${unsafeToRestart ? "settings-button-danger" : ""}`}
                      onClick={handleRestartServer}
                      disabled={restarting}
                    >
                      {restarting
                        ? "Restarting..."
                        : unsafeToRestart
                          ? "Restart Anyway"
                          : "Restart Server"}
                    </button>
                  </div>

                  <div className="settings-item">
                    <div className="settings-item-info">
                      <strong>Reload Frontend</strong>
                      <p>
                        Refresh the browser to pick up frontend changes.
                        {pendingReloads.frontend && (
                          <span className="settings-pending">
                            {" "}
                            (changes pending)
                          </span>
                        )}
                      </p>
                    </div>
                    <button
                      type="button"
                      className="settings-button"
                      onClick={handleReloadFrontend}
                    >
                      Reload Frontend
                    </button>
                  </div>
                </div>
              ) : (
                <p className="settings-info">
                  Manual reload mode is not enabled. The server automatically
                  restarts when code changes.
                </p>
              )}
            </section>
          </main>
        </div>
      </div>
    </div>
  );
}
