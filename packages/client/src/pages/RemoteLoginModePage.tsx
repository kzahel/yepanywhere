/**
 * RemoteLoginModePage - Mode selection for remote client login.
 *
 * Landing page that lets users choose between:
 * - Relay connection (for NAT traversal via public relay server)
 * - Direct connection (for LAN, Tailscale, or direct WS URL)
 */

import { useNavigate } from "react-router-dom";
import { YepAnywhereLogo } from "../components/YepAnywhereLogo";
import { useRemoteConnection } from "../contexts/RemoteConnectionContext";

export function RemoteLoginModePage() {
  const navigate = useNavigate();
  const { isAutoResuming } = useRemoteConnection();

  // If auto-resume is in progress, show a loading screen
  if (isAutoResuming) {
    return (
      <div className="login-page">
        <div className="login-container">
          <div className="login-logo">
            <YepAnywhereLogo />
          </div>
          <p className="login-subtitle">Reconnecting...</p>
          <div className="login-loading" data-testid="auto-resume-loading">
            <div className="login-spinner" />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="login-page">
      <div className="login-container">
        <div className="login-logo">
          <YepAnywhereLogo />
        </div>
        <p className="login-subtitle">How would you like to connect?</p>

        <div className="login-mode-options">
          <button
            type="button"
            className="login-mode-option"
            onClick={() => navigate("/relay")}
            data-testid="relay-mode-button"
          >
            <span className="login-mode-option-title">Connect via Relay</span>
            <span className="login-mode-option-desc">
              Use a relay server to connect from anywhere. No port forwarding
              needed.
            </span>
          </button>

          <button
            type="button"
            className="login-mode-option login-mode-option-secondary"
            onClick={() => navigate("/direct")}
            data-testid="direct-mode-button"
          >
            <span className="login-mode-option-title">Direct Connection</span>
            <span className="login-mode-option-desc">
              Connect directly via WebSocket URL. For LAN or Tailscale.
            </span>
          </button>
        </div>

        <p className="login-hint">
          Most users should choose "Connect via Relay" for the easiest setup.
        </p>
      </div>
    </div>
  );
}
