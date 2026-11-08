import { mutateResumeCredentials } from "../lib/rejectedResumeStorage";
/**
 * DirectLoginPage - Direct connection form for remote access via SecureConnection.
 *
 * Collects server URL, username, and password for SRP authentication.
 * On successful auth, the app switches to the main view.
 */

import { useState } from "react";
import { Link } from "react-router-dom";
import { YepAnywhereLogo } from "../components/YepAnywhereLogo";
import { Button } from "../components/ui/Button";
import { useRemoteConnection } from "../contexts/RemoteConnectionContext";
import { useSignInRequiredNotice } from "../hooks/useSignInRequiredNotice";
import { useI18n } from "../i18n";
import { createDirectHost, loadSavedHosts, saveHost } from "../lib/hostStorage";

export function DirectLoginPage() {
  const { t } = useI18n();
  const {
    connect,
    isConnecting,
    isAutoResuming,
    error,
    storedUrl,
    storedUsername,
    hasStoredSession,
    resumeSession,
    setCurrentHostId,
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
  const signInNotice = useSignInRequiredNotice();
  const [localError, setLocalError] = useState<string | null>(signInNotice);

  // If auto-resume is in progress, show a loading screen
  if (isAutoResuming) {
    return (
      <div className="login-page">
        <div className="login-container">
          <div className="login-logo">
            <YepAnywhereLogo />
          </div>
          <p className="login-subtitle">{t("reconnecting")}</p>
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
      setLocalError(t("directLoginErrorServerUrlRequired"));
      return;
    }

    if (!username.trim()) {
      setLocalError(t("directLoginErrorUsernameRequired"));
      return;
    }

    if (!password) {
      setLocalError(t("directLoginErrorPasswordRequired"));
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

    let rememberedHostId: string | null = null;
    if (rememberMe) {
      const existing = loadSavedHosts().hosts.find(
        (h) =>
          h.mode === "direct" &&
          h.wsUrl === wsUrl &&
          h.srpUsername === username.trim(),
      );
      const host =
        existing ??
        createDirectHost({
          wsUrl,
          srpUsername: username.trim(),
        });
      if (!existing) {
        await mutateResumeCredentials(() => saveHost(host));
      }
      rememberedHostId = host.id;
      setCurrentHostId(host.id);
    } else {
      setCurrentHostId(null);
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
      setCurrentHostId(rememberedHostId);
      // On success, the RemoteApp will render the main app instead of login
    } catch {
      setCurrentHostId(null);
      // Error is already set in context
    }
  };

  const displayError = localError ?? error;

  return (
    <div className="login-page">
      <div className="login-container">
        <Link to="/login" className="login-back-link">
          &larr; {t("actionBack")}
        </Link>

        <div className="login-logo">
          <YepAnywhereLogo />
        </div>
        <p className="login-subtitle">{t("directLoginTitle")}</p>

        <form
          onSubmit={handleSubmit}
          className="login-form"
          data-testid="login-form"
        >
          <div className="login-field">
            <label htmlFor="serverUrl">{t("directLoginServerUrl")}</label>
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
            <p className="login-field-hint">{t("directLoginServerUrlHint")}</p>
          </div>

          <div className="login-field">
            <label htmlFor="username">{t("directLoginUsername")}</label>
            <input
              id="username"
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder={t("directLoginUsernamePlaceholder")}
              disabled={isConnecting}
              autoComplete="username"
              data-testid="username-input"
            />
          </div>

          <div className="login-field">
            <label htmlFor="password">{t("directLoginPassword")}</label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={t("directLoginPasswordPlaceholder")}
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
              <span>{t("directLoginRememberMe")}</span>
            </label>
            <p className="login-field-hint">
              {hasStoredSession
                ? t("directLoginResumeHint")
                : t("directLoginStayLoggedIn")}
            </p>
          </div>

          {displayError && (
            <div className="login-error" data-testid="login-error">
              {displayError}
            </div>
          )}

          <Button
            type="submit"
            variant="primary"
            disabled={isConnecting}
            data-testid="login-button"
          >
            {isConnecting
              ? t("directLoginConnecting")
              : t("directLoginConnect")}
          </Button>
        </form>

        <p className="login-hint">{t("directLoginHint")}</p>
      </div>
    </div>
  );
}
