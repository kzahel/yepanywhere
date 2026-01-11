/**
 * RemoteLoginPage - Login form for remote access via SecureConnection.
 *
 * Collects server URL, username, and password for SRP authentication.
 * On successful auth, the app switches to the main view.
 */

import { useState } from "react";
import { YepAnywhereLogo } from "../components/YepAnywhereLogo";
import { useRemoteConnection } from "../contexts/RemoteConnectionContext";

export function RemoteLoginPage() {
  const {
    connect,
    isConnecting,
    isAutoResuming,
    error,
    storedUrl,
    storedUsername,
    hasStoredSession,
    resumeSession,
  } = useRemoteConnection();

  // Form state - pre-fill from stored credentials
  // All hooks must be before any conditional returns
  const [serverUrl, setServerUrl] = useState(
    storedUrl ?? "ws://localhost:3400/api/ws",
  );
  const [username, setUsername] = useState(storedUsername ?? "");
  const [password, setPassword] = useState("");
  // Always default to "remember me" - logout feature can be added later
  const [rememberMe, setRememberMe] = useState(true);
  const [localError, setLocalError] = useState<string | null>(null);

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

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLocalError(null);

    // Validate inputs
    if (!serverUrl.trim()) {
      setLocalError("Server URL is required");
      return;
    }

    if (!username.trim()) {
      setLocalError("Username is required");
      return;
    }

    if (!password) {
      setLocalError("Password is required");
      return;
    }

    // Normalize URL - ensure it's a WebSocket URL
    let wsUrl = serverUrl.trim();
    if (wsUrl.startsWith("http://")) {
      wsUrl = wsUrl.replace("http://", "ws://");
    } else if (wsUrl.startsWith("https://")) {
      wsUrl = wsUrl.replace("https://", "wss://");
    } else if (!wsUrl.startsWith("ws://") && !wsUrl.startsWith("wss://")) {
      wsUrl = `ws://${wsUrl}`;
    }

    // Ensure /api/ws path
    if (!wsUrl.endsWith("/api/ws")) {
      wsUrl = `${wsUrl.replace(/\/$/, "")}/api/ws`;
    }

    try {
      // If we have a stored session and credentials match, try to resume
      if (
        hasStoredSession &&
        rememberMe &&
        wsUrl === storedUrl &&
        username.trim() === storedUsername
      ) {
        await resumeSession(password);
      } else {
        await connect(wsUrl, username.trim(), password, rememberMe);
      }
      // On success, the RemoteApp will render the main app instead of login
    } catch {
      // Error is already set in context
    }
  };

  const displayError = localError ?? error;

  return (
    <div className="login-page">
      <div className="login-container">
        <div className="login-logo">
          <YepAnywhereLogo />
        </div>
        <p className="login-subtitle">Connect to your Yep Anywhere server</p>

        <form
          onSubmit={handleSubmit}
          className="login-form"
          data-testid="login-form"
        >
          <div className="login-field">
            <label htmlFor="serverUrl">Server URL</label>
            <input
              id="serverUrl"
              type="text"
              value={serverUrl}
              onChange={(e) => setServerUrl(e.target.value)}
              placeholder="ws://localhost:3400/api/ws"
              disabled={isConnecting}
              autoComplete="url"
              data-testid="ws-url-input"
            />
            <p className="login-field-hint">
              Your server's address (e.g., ws://192.168.1.50:3400/api/ws)
            </p>
          </div>

          <div className="login-field">
            <label htmlFor="username">Username</label>
            <input
              id="username"
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="Enter username"
              disabled={isConnecting}
              autoComplete="username"
              data-testid="username-input"
            />
          </div>

          <div className="login-field">
            <label htmlFor="password">Password</label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Enter password"
              disabled={isConnecting}
              autoComplete="current-password"
              data-testid="password-input"
            />
          </div>

          <div className="login-field login-field-checkbox">
            <label className="login-checkbox-label">
              <input
                type="checkbox"
                checked={rememberMe}
                onChange={(e) => setRememberMe(e.target.checked)}
                disabled={isConnecting}
                data-testid="remember-me-checkbox"
              />
              <span>Remember me</span>
            </label>
            <p className="login-field-hint">
              {hasStoredSession
                ? "Session will resume automatically"
                : "Stay logged in on this device"}
            </p>
          </div>

          {displayError && (
            <div className="login-error" data-testid="login-error">
              {displayError}
            </div>
          )}

          <button
            type="submit"
            className="login-button"
            disabled={isConnecting}
            data-testid="login-button"
          >
            {isConnecting ? "Connecting..." : "Connect"}
          </button>
        </form>

        <p className="login-hint">
          Remote access must be enabled in your server's Settings. The username
          and password are set there.
        </p>
      </div>
    </div>
  );
}
