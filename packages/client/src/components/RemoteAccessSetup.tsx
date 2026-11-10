import listStyles from "./SessionListLayout.module.css";
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
import styles from "./RemoteAccessSetup.module.css";
import { Badge, type BadgeTone } from "./ui/Badge";
import { Banner } from "./ui/Banner";
import { Button } from "./ui/Button";
import { Field, Select, TextInput } from "./ui/Field";
import { Switch } from "./ui/Switch";

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
): { text: string; tone: BadgeTone; pending?: boolean } {
  if (!enabled) {
    return {
      text: t("remoteSetupStatusDisabled" as never),
      tone: "neutral",
    };
  }
  if (!hasCredentials) {
    return {
      text: t("remoteSetupStatusNotConfigured" as never),
      tone: "warning",
    };
  }
  switch (status) {
    case "waiting":
      return {
        text: t("remoteSetupStatusConnected" as never),
        tone: "accent",
      };
    case "connecting":
      return {
        text: t("remoteSetupStatusConnecting" as never),
        tone: "neutral",
        pending: true,
      };
    case "registering":
      return {
        text: t("remoteSetupStatusRegistering" as never),
        tone: "neutral",
        pending: true,
      };
    case "rejected":
      return {
        text: t("remoteSetupStatusUsernameTaken" as never),
        tone: "danger",
      };
    default:
      return {
        text: t("remoteSetupStatusDisconnected" as never),
        tone: "warning",
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
      <div className={styles.setup}>
        <div className={styles.header}>
          <div>
            <h3>{title}</h3>
            <p>{description}</p>
          </div>
        </div>
        <div className={styles.loading}>{t("remoteSetupLoading" as never)}</div>
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
    <div className={styles.setup}>
      <div className={styles.header}>
        <div>
          <h3>{title}</h3>
          <p>{description}</p>
        </div>
        <Switch
          aria-label={title}
          checked={isEnabled}
          onCheckedChange={(checked) => handleToggle(checked)}
          disabled={isSaving || (!isEnabled && !canToggleOn)}
        />
      </div>

      <form onSubmit={handleSave} className={styles.form}>
        <Field id="remote-username" label={t("remoteSetupUsername" as never)}>
          <TextInput
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
        </Field>

        <Field
          id="remote-password"
          label={
            hasCredentials
              ? t("remoteSetupNewPassword" as never)
              : t("remoteSetupPassword" as never)
          }
        >
          <TextInput
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={hasCredentials ? "••••••••" : ""}
            minLength={8}
            autoComplete="new-password"
            disabled={isSaving}
          />
        </Field>

        {password && (
          <Field
            id="remote-confirm"
            label={t("remoteSetupConfirmPassword" as never)}
          >
            <TextInput
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              minLength={8}
              autoComplete="new-password"
              disabled={isSaving}
            />
          </Field>
        )}

        <Field id="relay-select" label={t("remoteSetupRelayServer" as never)}>
          <Select
            value={relayOption}
            onChange={(e) => setRelayOption(e.target.value as RelayOption)}
            disabled={isSaving}
          >
            <option value="default">
              {t("remoteSetupRelayDefault" as never)}
            </option>
            <option value="custom">
              {t("remoteSetupRelayCustom" as never)}
            </option>
          </Select>
        </Field>

        {relayOption === "custom" && (
          <Field
            id="custom-relay-url"
            label={t("remoteSetupCustomRelayUrl" as never)}
          >
            <TextInput
              type="text"
              value={customRelayUrl}
              onChange={(e) => setCustomRelayUrl(e.target.value)}
              placeholder={t("remoteSetupCustomRelayPlaceholder" as never)}
              disabled={isSaving}
            />
          </Field>
        )}

        <Field id="ya-client-select" label={t("remoteSetupYaClient" as never)}>
          <Select
            value={yaClientOption}
            onChange={(e) =>
              setYaClientOption(e.target.value as YaClientOption)
            }
            disabled={isSaving}
          >
            <option value="default">
              {t("remoteSetupYaClientDefault" as never)}
            </option>
            <option value="custom">
              {t("remoteSetupYaClientCustom" as never)}
            </option>
          </Select>
        </Field>

        {yaClientOption === "custom" && (
          <Field
            id="custom-ya-client-url"
            label={t("remoteSetupCustomYaClientUrl" as never)}
          >
            <TextInput
              type="text"
              value={customYaClientUrl}
              onChange={(e) => setCustomYaClientUrl(e.target.value)}
              placeholder={t("remoteSetupCustomYaClientPlaceholder" as never)}
              disabled={isSaving}
            />
          </Field>
        )}

        {yaClientInfo}

        <div className={styles.status}>
          <span className={styles.statusLabel}>
            {t("remoteSetupStatus" as never)}
          </span>
          <Badge
            tone={status.tone}
            icon={
              <span className={status.pending ? styles.pending : undefined}>
                ●
              </span>
            }
          >
            {status.text}
          </Badge>
        </div>

        {relayStatus?.error && (
          <Banner tone="error" role="none" compact>
            {relayStatus.error}
          </Banner>
        )}

        {(error || hookError) && (
          <Banner tone="error">{error || hookError}</Banner>
        )}

        {isEnabled && username && (
          <div className={styles.connect}>
            <span className={styles.connectLabel}>
              {t("remoteSetupConnectFrom" as never)}
            </span>
            <div className={styles.connectUrlRow}>
              <code className={styles.connectUrl}>{connectUrl}</code>
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
          <div className={styles.qr}>
            <Button onClick={() => setShowQRCode(!showQRCode)}>
              {showQRCode
                ? t("remoteSetupHideQr" as never)
                : t("remoteSetupShowQr" as never)}
            </Button>
            {showQRCode && qrCodeUrl && (
              <div className={styles.qrCodeContainer}>
                <QRCode value={qrCodeUrl} size={200} />
                <p className={styles.qrCodeHint}>
                  {t("remoteSetupQrHint" as never)}
                </p>
              </div>
            )}
          </div>
        )}

        <div className={styles.sessions}>
          <div className={styles.sessionsHeader}>
            <span className={styles.sessionsTitle}>
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
            <p className={styles.sessionsEmpty}>
              {t("remoteSetupNoSessions" as never)}
            </p>
          ) : (
            <ul className={listStyles.list}>
              {sessions.map((session) => {
                const { browser, os } = session.userAgent
                  ? parseUserAgent(session.userAgent)
                  : {
                      browser: t("remoteSetupUnknownBrowser" as never),
                      os: t("remoteSetupUnknownOs" as never),
                    };
                const hasDeviceInfo = session.userAgent || session.origin;

                return (
                  <li key={session.sessionId} className={styles.sessionItem}>
                    <div className={styles.sessionInfo}>
                      {hasDeviceInfo ? (
                        <>
                          <span className={styles.sessionDevice}>
                            {browser} · {os}
                          </span>
                          {session.origin && (
                            <code className={styles.sessionOrigin}>
                              {session.origin}
                            </code>
                          )}
                          <span className={styles.sessionDates}>
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
          <div className={styles.actions}>
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
