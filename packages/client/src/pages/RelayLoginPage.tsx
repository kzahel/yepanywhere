/**
 * RelayLoginPage - Login form for remote access via relay server.
 *
 * Connects to a relay server first, which pairs the client with a yepanywhere
 * server by username. After pairing, SRP authentication proceeds through the relay.
 */

import { useState } from "react";
import { Link } from "react-router-dom";
import { YepAnywhereLogo } from "../components/YepAnywhereLogo";
import { useRemoteConnection } from "../contexts/RemoteConnectionContext";

/** Default relay URL */
const DEFAULT_RELAY_URL = "wss://relay.yepanywhere.com/ws";

type ConnectionStatus =
  | "idle"
  | "connecting_relay"
  | "waiting_server"
  | "authenticating"
  | "error";

export function RelayLoginPage() {
  const { connectViaRelay, isAutoResuming } = useRemoteConnection();

  // Form state - relay username is also used as SRP identity
  const [relayUsername, setRelayUsername] = useState("");
  const [srpPassword, setSrpPassword] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [customRelayUrl, setCustomRelayUrl] = useState("");
  const [rememberMe, setRememberMe] = useState(true);

  // Connection state
  const [status, setStatus] = useState<ConnectionStatus>("idle");
  const [error, setError] = useState<string | null>(null);

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
    setError(null);

    // Validate inputs
    if (!relayUsername.trim()) {
      setError("Username is required");
      return;
    }

    if (!srpPassword) {
      setError("Password is required");
      return;
    }

    const relayUrl = customRelayUrl.trim() || DEFAULT_RELAY_URL;
    const username = relayUsername.trim().toLowerCase();

    try {
      await connectViaRelay({
        relayUrl,
        relayUsername: username,
        // Use relay username as SRP identity
        srpUsername: username,
        srpPassword,
        rememberMe,
        onStatusChange: setStatus,
      });
      // On success, the RemoteApp will render the main app instead of login
    } catch (err) {
      const message = err instanceof Error ? err.message : "Connection failed";
      setError(formatRelayError(message));
      setStatus("error");
    }
  };

  const isConnecting = status !== "idle" && status !== "error";
  const statusMessage = getStatusMessage(status);

  return (
    <div className="login-page">
      <div className="login-container">
        <Link to="/login" className="login-back-link">
          &larr; Back
        </Link>

        <div className="login-logo">
          <YepAnywhereLogo />
        </div>
        <p className="login-subtitle">Connect via Relay</p>

        <form
          onSubmit={handleSubmit}
          className="login-form"
          data-testid="relay-login-form"
        >
          <div className="login-field">
            <label htmlFor="relayUsername">Username</label>
            <input
              id="relayUsername"
              type="text"
              value={relayUsername}
              onChange={(e) => setRelayUsername(e.target.value)}
              placeholder="e.g., my-server"
              disabled={isConnecting}
              autoComplete="username"
              autoCapitalize="none"
              data-testid="relay-username-input"
            />
            <p className="login-field-hint">
              The username you configured on your server
            </p>
          </div>

          <div className="login-field">
            <label htmlFor="srpPassword">Password</label>
            <input
              id="srpPassword"
              type="password"
              value={srpPassword}
              onChange={(e) => setSrpPassword(e.target.value)}
              placeholder="Enter password"
              disabled={isConnecting}
              autoComplete="current-password"
              data-testid="srp-password-input"
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
          </div>

          <button
            type="button"
            className="login-advanced-toggle"
            onClick={() => setShowAdvanced(!showAdvanced)}
            disabled={isConnecting}
          >
            {showAdvanced ? "Hide" : "Show"} Advanced Options
          </button>

          {showAdvanced && (
            <div className="login-field">
              <label htmlFor="customRelayUrl">Custom Relay URL</label>
              <input
                id="customRelayUrl"
                type="text"
                value={customRelayUrl}
                onChange={(e) => setCustomRelayUrl(e.target.value)}
                placeholder={DEFAULT_RELAY_URL}
                disabled={isConnecting}
                data-testid="custom-relay-url-input"
              />
              <p className="login-field-hint">
                Leave blank to use the default relay
              </p>
            </div>
          )}

          {error && (
            <div className="login-error" data-testid="login-error">
              {error}
            </div>
          )}

          {isConnecting && statusMessage && (
            <div className="login-status" data-testid="connection-status">
              <div className="login-spinner" />
              <span>{statusMessage}</span>
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
          Configure relay settings in your server's Remote Access settings.
        </p>
      </div>
    </div>
  );
}

function getStatusMessage(status: ConnectionStatus): string | null {
  switch (status) {
    case "connecting_relay":
      return "Connecting to relay...";
    case "waiting_server":
      return "Waiting for server...";
    case "authenticating":
      return "Authenticating...";
    default:
      return null;
  }
}

function formatRelayError(message: string): string {
  if (message.includes("server_offline")) {
    return "Server is not connected to the relay. Make sure your server is running and has relay enabled.";
  }
  if (message.includes("unknown_username")) {
    return "No server found with that username. Check the username and try again.";
  }
  if (
    message.includes("Authentication failed") ||
    message.includes("invalid_identity")
  ) {
    return "Invalid username or password. Check your credentials and try again.";
  }
  return message;
}
