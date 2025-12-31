import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  FONT_SIZES,
  type FontSize,
  getFontSizeLabel,
  useFontSize,
} from "../hooks/useFontSize";
import { useReloadNotifications } from "../hooks/useReloadNotifications";

export function SettingsPage() {
  const {
    isManualReloadMode,
    pendingReloads,
    connected,
    reloadBackend,
    reloadFrontend,
  } = useReloadNotifications();
  const { fontSize, setFontSize } = useFontSize();
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

  const handleReloadFrontend = () => {
    reloadFrontend();
  };

  return (
    <div className="page">
      <nav className="breadcrumb">
        <Link to="/projects">Projects</Link> / Settings
      </nav>

      <h1>Settings</h1>

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
                    <span className="settings-pending"> (changes pending)</span>
                  )}
                </p>
              </div>
              <button
                type="button"
                className="settings-button"
                onClick={handleRestartServer}
                disabled={restarting}
              >
                {restarting ? "Restarting..." : "Restart Server"}
              </button>
            </div>

            <div className="settings-item">
              <div className="settings-item-info">
                <strong>Reload Frontend</strong>
                <p>
                  Refresh the browser to pick up frontend changes.
                  {pendingReloads.frontend && (
                    <span className="settings-pending"> (changes pending)</span>
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
            Manual reload mode is not enabled. The server automatically restarts
            when code changes.
          </p>
        )}
      </section>
    </div>
  );
}
