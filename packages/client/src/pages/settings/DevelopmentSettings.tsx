import { useEffect, useState } from "react";
import { useSchemaValidationContext } from "../../contexts/SchemaValidationContext";
import { useDeveloperMode } from "../../hooks/useDeveloperMode";
import { useReloadNotifications } from "../../hooks/useReloadNotifications";
import { useSchemaValidation } from "../../hooks/useSchemaValidation";
import { getWebSocketConnection } from "../../lib/connection";

export function DevelopmentSettings() {
  const {
    isManualReloadMode,
    pendingReloads,
    connected,
    reloadBackend,
    reloadFrontend,
    unsafeToRestart,
    workerActivity,
  } = useReloadNotifications();
  const { settings: validationSettings, setEnabled: setValidationEnabled } =
    useSchemaValidation();
  const {
    holdModeEnabled,
    setHoldModeEnabled,
    websocketTransportEnabled,
    setWebsocketTransportEnabled,
  } = useDeveloperMode();
  const { ignoredTools, clearIgnoredTools } = useSchemaValidationContext();

  const [restarting, setRestarting] = useState(false);
  const [wsTestStatus, setWsTestStatus] = useState<
    "idle" | "testing" | "success" | "error"
  >("idle");
  const [wsTestError, setWsTestError] = useState<string | null>(null);

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

  const handleTestWebSocket = async () => {
    setWsTestStatus("testing");
    setWsTestError(null);
    try {
      const ws = getWebSocketConnection();
      // Try a simple API call through WebSocket
      const result = await ws.fetch<{ current: string }>("/version");
      if (result?.current) {
        setWsTestStatus("success");
        // Auto-enable after successful test
        setWebsocketTransportEnabled(true);
      } else {
        setWsTestStatus("error");
        setWsTestError("Unexpected response format");
      }
    } catch (err) {
      setWsTestStatus("error");
      setWsTestError(err instanceof Error ? err.message : "Connection failed");
    }
  };

  // Only render in manual reload mode (dev mode)
  if (!isManualReloadMode) {
    return null;
  }

  return (
    <section className="settings-section">
      <h2>Development</h2>

      <div className="settings-group">
        <div className="settings-item">
          <div className="settings-item-info">
            <strong>Schema Validation</strong>
            <p>
              Validate tool results against expected schemas. Shows toast
              notifications and logs errors to console.
            </p>
          </div>
          <label className="toggle-switch">
            <input
              type="checkbox"
              checked={validationSettings.enabled}
              onChange={(e) => setValidationEnabled(e.target.checked)}
            />
            <span className="toggle-slider" />
          </label>
        </div>
        {ignoredTools.length > 0 && (
          <div className="settings-item">
            <div className="settings-item-info">
              <strong>Ignored Tools</strong>
              <p>
                Tools with validation errors you chose to ignore. They will not
                show toast notifications.
              </p>
              <div className="ignored-tools-list">
                {ignoredTools.map((tool) => (
                  <span key={tool} className="ignored-tool-badge">
                    {tool}
                  </span>
                ))}
              </div>
            </div>
            <button
              type="button"
              className="settings-button settings-button-secondary"
              onClick={clearIgnoredTools}
            >
              Clear Ignored
            </button>
          </div>
        )}
        <div className="settings-item">
          <div className="settings-item-info">
            <strong>Hold Mode</strong>
            <p>
              Show hold/resume option in the mode selector. Pauses execution at
              the next yield point (experimental).
            </p>
          </div>
          <label className="toggle-switch">
            <input
              type="checkbox"
              checked={holdModeEnabled}
              onChange={(e) => setHoldModeEnabled(e.target.checked)}
            />
            <span className="toggle-slider" />
          </label>
        </div>
        <div className="settings-item">
          <div className="settings-item-info">
            <strong>WebSocket Transport</strong>
            <p>
              Use WebSocket for API requests instead of fetch/SSE. Tests the
              relay protocol without encryption (Phase 2b).
            </p>
            {wsTestStatus === "success" && (
              <p className="form-success">
                Connection successful! WebSocket enabled.
              </p>
            )}
            {wsTestStatus === "error" && (
              <p className="form-error">{wsTestError || "Connection failed"}</p>
            )}
          </div>
          <div className="settings-confirm-buttons">
            <button
              type="button"
              className="settings-button"
              onClick={handleTestWebSocket}
              disabled={wsTestStatus === "testing"}
            >
              {wsTestStatus === "testing" ? "Testing..." : "Test"}
            </button>
            <label className="toggle-switch">
              <input
                type="checkbox"
                checked={websocketTransportEnabled}
                onChange={(e) => setWebsocketTransportEnabled(e.target.checked)}
              />
              <span className="toggle-slider" />
            </label>
          </div>
        </div>
      </div>

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
            {unsafeToRestart && (
              <p className="settings-warning">
                {workerActivity.activeWorkers} active session
                {workerActivity.activeWorkers !== 1 ? "s" : ""} will be
                interrupted
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
    </section>
  );
}
