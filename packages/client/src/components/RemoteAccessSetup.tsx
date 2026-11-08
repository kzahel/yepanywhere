/**
 * RemoteAccessSetup - Single-screen component for configuring remote access.
 *
 * Reusable in both Settings and Onboarding flows.
 */

import {
  DEFAULT_RELAY_URL,
  DEFAULT_YA_CLIENT_BASE_URL,
  buildYaClientRelayLoginUrl,
  normalizeRelayUrl,
  normalizeYaClientBaseUrl,
} from "@yep-anywhere/shared";
import { type ReactNode, useEffect, useState } from "react";
import { useServerSettings } from "../hooks/useServerSettings";
import { type RelayStatus, useRemoteAccess } from "../hooks/useRemoteAccess";
import { isConnectionImpactDeclined } from "../api/connectionImpact";
import { useI18n } from "../i18n";
import { parseUserAgent } from "../lib/deviceDetection";
import { QRCode } from "./QRCode";
import { Button } from "./ui/Button";

export interface RemoteAccessSetupProps {
  /** Custom title (default: "Remote Access") */
  title?: string;
  /** Custom description */
  description?: string;
  /** Callback when setup completes successfully */
  onSetupComplete?: () => void;
  /** Derived YA URL status rendered beside the setting that controls it. */
  yaClientInfo?: ReactNode;
}

/**
 * Format a date for display with relative time.
 */
function formatRelativeDate(isoDate: string): string {
  return new Date(isoDate).toLocaleDateString();
}

function formatRelativeDateWithT(
  isoDate: string,
  t: (key: never, vars?: Record<string, string | number>) => string,
): string {
  const date = new Date(isoDate);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMinutes = Math.floor(diffMs / (1000 * 60));
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffMinutes < 1) {
    return t("remoteSetupJustNow" as never);
  }
  if (diffMinutes < 60) {
    return t("remoteSetupMinutesAgo" as never, {
      count: diffMinutes,
      suffix: diffMinutes === 1 ? "" : "s",
    });
  }
  if (diffHours < 24) {
    return t("remoteSetupHoursAgo" as never, {
      count: diffHours,
      suffix: diffHours === 1 ? "" : "s",
    });
  }
  if (diffDays === 1) {
    return t("remoteSetupYesterday" as never);
  }
  if (diffDays < 7) {
    return t("hostPickerLastConnectedDays" as never, { count: diffDays });
  }
  return formatRelativeDate(isoDate);
}

/**
 * Get human-readable status text and color class.
 */
function getStatusDisplay(
  status: RelayStatus | null,
  enabled: boolean,
  hasCredentials: boolean,
  t: (key: never) => string,
): { text: string; className: string } {
  if (!enabled) {
    return {
      text: t("remoteSetupStatusDisabled" as never),
      className: "status-disabled",
    };
  }
  if (!hasCredentials) {
    return {
      text: t("remoteSetupStatusNotConfigured" as never),
      className: "status-warning",
    };
  }
  switch (status) {
    case "waiting":
      return {
        text: t("remoteSetupStatusConnected" as never),
        className: "status-success",
      };
    case "connecting":
      return {
        text: t("remoteSetupStatusConnecting" as never),
        className: "status-pending",
      };
    case "registering":
      return {
        text: t("remoteSetupStatusRegistering" as never),
        className: "status-pending",
      };
    case "rejected":
      return {
        text: t("remoteSetupStatusUsernameTaken" as never),
        className: "status-error",
      };
    default:
      return {
        text: t("remoteSetupStatusDisconnected" as never),
        className: "status-warning",
      };
  }
}

type RelayOption = "default" | "custom";
type YaClientOption = "default" | "custom";

function normalizeRelayUrlForComparison(raw: string): string {
  try {
    return normalizeRelayUrl(raw);
  } catch {
    return raw.trim();
  }
}

function normalizeYaClientUrlForComparison(raw: string): string {
  try {
    return normalizeYaClientBaseUrl(raw);
  } catch {
    return raw.trim();
  }
}

export function RemoteAccessSetup({
  title = "Remote Access",
  description = "Access your server from anywhere.",
  onSetupComplete,
  yaClientInfo,
}: RemoteAccessSetupProps) {
  const { t } = useI18n();
  const {
    config,
    relayConfig,
    relayStatus,
    sessions,
    loading,
    error: hookError,
    configure,
    enable,
    disable,
    updateRelayConfig,
    revokeSession,
    revokeAllSessions,
    refresh,
  } = useRemoteAccess();
  const {
    settings: serverSettings,
    isLoading: serverSettingsLoading,
    updateSetting,
  } = useServerSettings();

  // Form state
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [relayOption, setRelayOption] = useState<RelayOption>("default");
  const [customRelayUrl, setCustomRelayUrl] = useState("");
  const [yaClientOption, setYaClientOption] =
    useState<YaClientOption>("default");
  const [customYaClientUrl, setCustomYaClientUrl] = useState("");

  // UI state
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [hasChanges, setHasChanges] = useState(false);
  // Password for QR code generation (kept in memory after successful save)
  const [savedPassword, setSavedPassword] = useState<string | null>(null);
  const [showQRCode, setShowQRCode] = useState(false);

  // Initialize form from existing config
  useEffect(() => {
    if (relayConfig) {
      setUsername(relayConfig.username);
      if (relayConfig.url === DEFAULT_RELAY_URL) {
        setRelayOption("default");
        setCustomRelayUrl("");
      } else {
        setRelayOption("custom");
        setCustomRelayUrl(relayConfig.url);
      }
    }
  }, [relayConfig]);

  useEffect(() => {
    if (!serverSettings) return;
    const savedYaClientBaseUrl = serverSettings.yaClientBaseUrl ?? "";
    if (savedYaClientBaseUrl) {
      setYaClientOption("custom");
      setCustomYaClientUrl(savedYaClientBaseUrl);
    } else {
      setYaClientOption("default");
      setCustomYaClientUrl("");
    }
  }, [serverSettings]);

  // Track changes
  useEffect(() => {
    const usernameChanged = username !== (relayConfig?.username ?? "");
    const passwordChanged = password.length > 0;

    const currentRelayUrl = normalizeRelayUrlForComparison(
      relayOption === "default" ? DEFAULT_RELAY_URL : customRelayUrl,
    );
    const savedRelayUrl = relayConfig?.url ?? DEFAULT_RELAY_URL;
    const relayUrlChanged = currentRelayUrl !== savedRelayUrl;
    const currentYaClientBaseUrl = normalizeYaClientUrlForComparison(
      yaClientOption === "default"
        ? DEFAULT_YA_CLIENT_BASE_URL
        : customYaClientUrl,
    );
    const savedYaClientBaseUrl =
      serverSettings?.yaClientBaseUrl ?? DEFAULT_YA_CLIENT_BASE_URL;
    const yaClientBaseUrlChanged =
      currentYaClientBaseUrl !== savedYaClientBaseUrl;

    setHasChanges(
      usernameChanged ||
        passwordChanged ||
        relayUrlChanged ||
        yaClientBaseUrlChanged,
    );
  }, [
    username,
    password,
    relayOption,
    customRelayUrl,
    relayConfig,
    yaClientOption,
    customYaClientUrl,
    serverSettings?.yaClientBaseUrl,
  ]);

  // Poll for status updates when connecting
  useEffect(() => {
    if (
      relayStatus?.status === "connecting" ||
      relayStatus?.status === "registering"
    ) {
      const interval = setInterval(refresh, 2000);
      return () => clearInterval(interval);
    }
  }, [relayStatus?.status, refresh]);

  const isEnabled = config?.enabled ?? false;
  const hasCredentials = !!config?.username;

  // Get the relay URL based on current selection
  const getRelayUrlInput = () =>
    relayOption === "default" ? DEFAULT_RELAY_URL : customRelayUrl;

  const getDisplayRelayUrl = () =>
    normalizeRelayUrlForComparison(getRelayUrlInput());

  const getYaClientUrlInput = () =>
    yaClientOption === "default"
      ? DEFAULT_YA_CLIENT_BASE_URL
      : customYaClientUrl;

  const getUsableYaClientBaseUrl = () => {
    try {
      return normalizeYaClientBaseUrl(getYaClientUrlInput());
    } catch {
      return DEFAULT_YA_CLIENT_BASE_URL;
    }
  };

  // Save changes (relay config + password)
  const saveChanges = async () => {
    setError(null);

    // Validation
    if (!username.trim()) {
      setError(t("remoteSetupErrorUsernameRequired" as never));
      return false;
    }
    if (username.length < 3) {
      setError(t("remoteSetupErrorUsernameShort" as never));
      return false;
    }
    if (!hasCredentials && !password) {
      setError(t("remoteSetupErrorPasswordRequired" as never));
      return false;
    }
    if (password && password.length < 8) {
      setError(t("remoteSetupErrorPasswordShort" as never));
      return false;
    }
    if (password && password !== confirmPassword) {
      setError(t("remoteSetupErrorPasswordMismatch" as never));
      return false;
    }
    if (relayOption === "custom" && !customRelayUrl.trim()) {
      setError(t("remoteSetupErrorCustomRelayRequired" as never));
      return false;
    }
    if (yaClientOption === "custom" && !customYaClientUrl.trim()) {
      setError(t("remoteSetupErrorCustomYaRequired" as never));
      return false;
    }

    // One save may send several disconnecting requests; ask once.
    const impactScope = { confirmed: false };
    try {
      // Update relay config if changed
      let relayUrl: string;
      try {
        relayUrl = normalizeRelayUrl(getRelayUrlInput());
      } catch (err) {
        setError(
          err instanceof Error
            ? err.message
            : t("remoteSetupErrorSaveFailed" as never),
        );
        return false;
      }
      // Validate before writing anything.
      let yaClientBaseUrl: string;
      try {
        yaClientBaseUrl = normalizeYaClientBaseUrl(getYaClientUrlInput());
      } catch (err) {
        setError(
          err instanceof Error
            ? err.message
            : t("remoteSetupErrorSaveFailed" as never),
        );
        return false;
      }
      const relayChanged =
        username !== relayConfig?.username || relayUrl !== relayConfig?.url;
      if (relayChanged) {
        await updateRelayConfig({ url: relayUrl, username }, impactScope);
      }

      // Configure with password if provided
      if (password) {
        await configure(password, impactScope);
        // Keep password in memory for QR code generation
        setSavedPassword(password);
      }

      // Not refusable, so it follows the changes that may ask first.
      const savedYaClientBaseUrl =
        serverSettings?.yaClientBaseUrl ?? DEFAULT_YA_CLIENT_BASE_URL;
      if (yaClientBaseUrl !== savedYaClientBaseUrl) {
        await updateSetting(
          "yaClientBaseUrl",
          yaClientOption === "default" ? null : yaClientBaseUrl,
        );
      }

      // Clear password fields after save
      setPassword("");
      setConfirmPassword("");
      setHasChanges(false);
      return true;
    } catch (err) {
      if (isConnectionImpactDeclined(err)) return false;
      setError(
        err instanceof Error
          ? err.message
          : t("remoteSetupErrorSaveFailed" as never),
      );
      return false;
    }
  };

  const handleToggle = async (checked: boolean) => {
    setError(null);
    setIsSaving(true);

    try {
      if (checked) {
        // Turning on
        if (hasChanges) {
          // Has pending edits - save them first, then enable
          const saved = await saveChanges();
          if (!saved) {
            setIsSaving(false);
            return;
          }
          // configure() already enables, so we're done
          onSetupComplete?.();
        } else if (hasCredentials) {
          // No changes, just re-enable
          await enable();
          onSetupComplete?.();
        }
        // If no credentials and no changes, toggle does nothing
        // (they need to fill in the form first)
      } else {
        // Turning off
        await disable();
      }
    } catch (err) {
      if (isConnectionImpactDeclined(err)) return;
      setError(
        err instanceof Error
          ? err.message
          : t("remoteSetupErrorUpdateFailed" as never),
      );
    } finally {
      setIsSaving(false);
    }
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSaving(true);
    const saved = await saveChanges();
    if (saved) {
      onSetupComplete?.();
    }
    setIsSaving(false);
  };

  const handleCopyUrl = async (url: string) => {
    await navigator.clipboard.writeText(url);
    setCopied(true);
    setTimeout(() => setCopied(false), 3000);
  };

  if (loading || serverSettingsLoading) {
    return (
      <div className="remote-access-setup">
        <div className="remote-access-header">
          <div>
            <h3>{title}</h3>
            <p>{description}</p>
          </div>
        </div>
        <div className="remote-access-loading">
          {t("remoteSetupLoading" as never)}
        </div>
      </div>
    );
  }

  const status = getStatusDisplay(
    relayStatus?.status ?? null,
    isEnabled,
    hasCredentials,
    t,
  );

  // Build connect URL with query params (for manual entry - no password)
  const connectUrl = (() => {
    const connectBaseUrl = buildYaClientRelayLoginUrl(
      getUsableYaClientBaseUrl(),
    );
    const params = new URLSearchParams();
    if (username) {
      params.set("u", username);
    }
    const relayUrl = getDisplayRelayUrl();
    if (relayUrl !== DEFAULT_RELAY_URL) {
      params.set("r", relayUrl);
    }
    const queryString = params.toString();
    return queryString ? `${connectBaseUrl}?${queryString}` : connectBaseUrl;
  })();

  // Build QR code URL with credentials in hash (for auto-login)
  const qrCodeUrl = (() => {
    if (!savedPassword || !username) return null;
    const hashParams = new URLSearchParams();
    hashParams.set("u", username);
    hashParams.set("p", savedPassword);
    const relayUrl = getDisplayRelayUrl();
    if (relayUrl !== DEFAULT_RELAY_URL) {
      hashParams.set("r", relayUrl);
    }
    return `${buildYaClientRelayLoginUrl(getUsableYaClientBaseUrl())}#${hashParams.toString()}`;
  })();

  // Can show QR code when connected and we have the password in memory
  const canShowQRCode =
    isEnabled && relayStatus?.status === "waiting" && qrCodeUrl !== null;

  // Can toggle on if: has credentials OR has filled in required fields
  const canToggleOn = hasCredentials || (username && password);

  return (
    <div className="remote-access-setup">
      <div className="remote-access-header">
        <div>
          <h3>{title}</h3>
          <p>{description}</p>
        </div>
        <label className="toggle-switch">
          <input
            type="checkbox"
            checked={isEnabled}
            onChange={(e) => handleToggle(e.target.checked)}
            disabled={isSaving || (!isEnabled && !canToggleOn)}
          />
          <span className="toggle-slider" />
        </label>
      </div>

      <form onSubmit={handleSave} className="remote-access-form">
        <div className="form-field">
          <label htmlFor="remote-username">
            {t("remoteSetupUsername" as never)}
          </label>
          <input
            id="remote-username"
            type="text"
            value={username}
            onChange={(e) => setUsername(e.target.value.toLowerCase())}
            placeholder={t("remoteSetupUsernamePlaceholder" as never)}
            minLength={3}
            maxLength={32}
            pattern="[a-z0-9][a-z0-9-]*[a-z0-9]|[a-z0-9]{1,2}"
            title={t("remoteSetupUsernameHint" as never)}
            autoComplete="username"
            disabled={isSaving}
          />
        </div>

        <div className="form-field">
          <label htmlFor="remote-password">
            {hasCredentials
              ? t("remoteSetupNewPassword" as never)
              : t("remoteSetupPassword" as never)}
          </label>
          <input
            id="remote-password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={hasCredentials ? "••••••••" : ""}
            minLength={8}
            autoComplete="new-password"
            disabled={isSaving}
          />
        </div>

        {password && (
          <div className="form-field">
            <label htmlFor="remote-confirm">
              {t("remoteSetupConfirmPassword" as never)}
            </label>
            <input
              id="remote-confirm"
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              minLength={8}
              autoComplete="new-password"
              disabled={isSaving}
            />
          </div>
        )}

        <div className="form-field">
          <label htmlFor="relay-select">
            {t("remoteSetupRelayServer" as never)}
          </label>
          <select
            id="relay-select"
            value={relayOption}
            onChange={(e) => setRelayOption(e.target.value as RelayOption)}
            disabled={isSaving}
            className="form-select"
          >
            <option value="default">
              {t("remoteSetupRelayDefault" as never)}
            </option>
            <option value="custom">
              {t("remoteSetupRelayCustom" as never)}
            </option>
          </select>
        </div>

        {relayOption === "custom" && (
          <div className="form-field">
            <label htmlFor="custom-relay-url">
              {t("remoteSetupCustomRelayUrl" as never)}
            </label>
            <input
              id="custom-relay-url"
              type="text"
              value={customRelayUrl}
              onChange={(e) => setCustomRelayUrl(e.target.value)}
              placeholder={t("remoteSetupCustomRelayPlaceholder" as never)}
              disabled={isSaving}
            />
          </div>
        )}

        <div className="form-field">
          <label htmlFor="ya-client-select">
            {t("remoteSetupYaClient" as never)}
          </label>
          <select
            id="ya-client-select"
            value={yaClientOption}
            onChange={(e) =>
              setYaClientOption(e.target.value as YaClientOption)
            }
            disabled={isSaving}
            className="form-select"
          >
            <option value="default">
              {t("remoteSetupYaClientDefault" as never)}
            </option>
            <option value="custom">
              {t("remoteSetupYaClientCustom" as never)}
            </option>
          </select>
        </div>

        {yaClientOption === "custom" && (
          <div className="form-field">
            <label htmlFor="custom-ya-client-url">
              {t("remoteSetupCustomYaClientUrl" as never)}
            </label>
            <input
              id="custom-ya-client-url"
              type="text"
              value={customYaClientUrl}
              onChange={(e) => setCustomYaClientUrl(e.target.value)}
              placeholder={t("remoteSetupCustomYaClientPlaceholder" as never)}
              disabled={isSaving}
            />
          </div>
        )}

        {yaClientInfo}

        <div className="remote-access-status">
          <span className="status-label">
            {t("remoteSetupStatus" as never)}
          </span>
          <span className={`status-indicator ${status.className}`}>
            {status.text}
          </span>
          {relayStatus?.error && (
            <span className="status-error-detail">{relayStatus.error}</span>
          )}
        </div>

        {(error || hookError) && (
          <p className="form-error">{error || hookError}</p>
        )}

        {isEnabled && username && (
          <div className="remote-access-connect">
            <span className="connect-label">
              {t("remoteSetupConnectFrom" as never)}
            </span>
            <div className="connect-url-row">
              <code className="connect-url">{connectUrl}</code>
              <Button
                size="small"
                onClick={() => handleCopyUrl(connectUrl)}
                title={t("remoteSetupCopyUrl" as never)}
              >
                {copied
                  ? t("remoteSetupCopied" as never)
                  : t("remoteSetupCopy" as never)}
              </Button>
            </div>
          </div>
        )}

        {canShowQRCode && (
          <div className="remote-access-qr">
            <Button onClick={() => setShowQRCode(!showQRCode)}>
              {showQRCode
                ? t("remoteSetupHideQr" as never)
                : t("remoteSetupShowQr" as never)}
            </Button>
            {showQRCode && qrCodeUrl && (
              <div className="qr-code-container">
                <QRCode value={qrCodeUrl} size={200} />
                <p className="qr-code-hint">
                  {t("remoteSetupQrHint" as never)}
                </p>
              </div>
            )}
          </div>
        )}

        <div className="remote-access-sessions">
          <div className="sessions-header">
            <span className="sessions-title">
              {t("remoteSetupSessions" as never, { count: sessions.length })}
            </span>
            {sessions.length > 0 && (
              <Button
                variant="danger-outline"
                size="small"
                onClick={() => void revokeAllSessions().catch(() => {})}
                disabled={isSaving}
                title={t("remoteSetupRevokeEffect" as never)}
              >
                {t("remoteSetupRevokeAll" as never)}
              </Button>
            )}
          </div>
          <p className="settings-hint">
            {t("remoteSetupSessionsDescription" as never)}
          </p>
          {sessions.length === 0 ? (
            <p className="sessions-empty">
              {t("remoteSetupNoSessions" as never)}
            </p>
          ) : (
            <ul className="sessions-list">
              {sessions.map((session) => {
                const { browser, os } = session.userAgent
                  ? parseUserAgent(session.userAgent)
                  : {
                      browser: t("remoteSetupUnknownBrowser" as never),
                      os: t("remoteSetupUnknownOs" as never),
                    };
                const hasDeviceInfo = session.userAgent || session.origin;

                return (
                  <li key={session.sessionId} className="session-item">
                    <div className="session-info">
                      {hasDeviceInfo ? (
                        <>
                          <span className="session-device">
                            {browser} · {os}
                          </span>
                          {session.origin && (
                            <code className="session-origin">
                              {session.origin}
                            </code>
                          )}
                          <span className="session-dates">
                            {t("remoteSetupCreated" as never, {
                              date: formatRelativeDateWithT(
                                session.createdAt,
                                t,
                              ),
                            })}{" "}
                            ·{" "}
                            {t("remoteSetupLastUsed" as never, {
                              date: formatRelativeDateWithT(
                                session.lastUsed,
                                t,
                              ),
                            })}
                          </span>
                        </>
                      ) : (
                        <>
                          <span className="session-created">
                            {t("remoteSetupCreatedLabel" as never)}{" "}
                            {new Date(session.createdAt).toLocaleDateString()}
                          </span>
                          <span className="session-last-used">
                            {t("remoteSetupLastUsedLabel" as never)}{" "}
                            {new Date(session.lastUsed).toLocaleDateString()}
                          </span>
                        </>
                      )}
                    </div>
                    <Button
                      variant="danger-outline"
                      size="small"
                      onClick={() =>
                        void revokeSession(session.sessionId).catch(() => {})
                      }
                      disabled={isSaving}
                      title={t("remoteSetupRevokeEffect" as never)}
                    >
                      {t("remoteSetupRevoke" as never)}
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {hasChanges && (
          <div className="remote-access-actions">
            <Button variant="primary" type="submit" disabled={isSaving}>
              {isSaving
                ? t("remoteSetupSaving" as never)
                : t("remoteSetupUpdate" as never)}
            </Button>
          </div>
        )}
      </form>
    </div>
  );
}
