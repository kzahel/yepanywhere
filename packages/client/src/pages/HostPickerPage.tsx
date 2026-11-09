/**
 * HostPickerPage - Saved hosts list and login mode selection.
 *
 * Shows:
 * - List of saved hosts with status indicators and quick connect
 * - "Add Host" section with relay/login/direct options
 */

import {
  categorizeResumeError,
  requiresResumeLogin,
} from "../lib/connection/remoteErrors";
import { getResumeError } from "../lib/connection/resumeErrors";
import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Banner } from "../components/ui/Banner";
import { ButtonBase, IconButton } from "../components/ui/Button";
import { Spinner } from "../components/ui/Spinner";
import { YepAnywhereLogo } from "../components/YepAnywhereLogo";
import { useRemoteConnection } from "../contexts/RemoteConnectionContext";
import { signInRequiredState } from "../hooks/useSignInRequiredNotice";
import { useI18n } from "../i18n";
import { loadSavedHosts, removeHost, type SavedHost } from "../lib/hostStorage";
import { relayEndpoints } from "../lib/connection/relayEndpoints";

type HostStatus = "online" | "offline" | "checking" | "unknown";

interface HostStatusMap {
  [hostId: string]: HostStatus;
}

function relayLoginPath(host: SavedHost): string {
  const params = new URLSearchParams();
  if (host.relayUsername) {
    params.set("u", host.relayUsername);
  }
  if (host.relayUrl) {
    params.set("r", host.relayUrl);
  }
  const query = params.toString();
  return `/login/relay${query ? `?${query}` : ""}`;
}

export function HostPickerPage() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const { isAutoResuming, connectViaRelay, connect, setCurrentHostId } =
    useRemoteConnection();
  const [hosts, setHosts] = useState<SavedHost[]>([]);
  const [hostStatuses, setHostStatuses] = useState<HostStatusMap>({});
  const [connectingHostId, setConnectingHostId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Load hosts on mount
  useEffect(() => {
    const data = loadSavedHosts();
    setHosts(data.hosts);
  }, []);

  // Check if a relay host's server is online via the relay's HTTP API
  const checkRelayHostStatus = useCallback(
    async (host: SavedHost): Promise<HostStatus> => {
      if (!host.relayUrl || !host.relayUsername) return "unknown";

      try {
        const endpoints = relayEndpoints(host.relayUrl);
        if (!endpoints) return "offline";
        const res = await fetch(
          new URL(
            `online/${encodeURIComponent(host.relayUsername)}`,
            endpoints.httpBaseUrl,
          ),
          { signal: AbortSignal.timeout(5000) },
        );
        if (!res.ok) return "offline";
        const data = await res.json();
        return data.online ? "online" : "offline";
      } catch {
        return "offline";
      }
    },
    [],
  );

  // Check status for relay hosts
  useEffect(() => {
    const relayHosts = hosts.filter((h) => h.mode === "relay");
    if (relayHosts.length === 0) return;

    // Mark all as checking
    setHostStatuses((prev) => {
      const next = { ...prev };
      for (const host of relayHosts) {
        if (!next[host.id]) {
          next[host.id] = "checking";
        }
      }
      return next;
    });

    // Check each relay host status
    for (const host of relayHosts) {
      checkRelayHostStatus(host).then((status) => {
        setHostStatuses((prev) => ({ ...prev, [host.id]: status }));
      });
    }
  }, [checkRelayHostStatus, hosts]);

  // Connect to a saved host
  const handleConnectHost = useCallback(
    async (host: SavedHost) => {
      setConnectingHostId(host.id);
      setError(null);

      try {
        if (host.mode === "relay") {
          if (!host.relayUrl || !host.relayUsername) {
            throw new Error(t("hostPickerMissingRelayConfiguration"));
          }

          // If host has a session, try to use it for auto-resume
          // Otherwise, navigate to relay login pre-filled
          if (host.session) {
            // Set current host ID before connecting so ConnectionGate knows where to redirect
            setCurrentHostId(host.id);
            await connectViaRelay({
              relayUrl: host.relayUrl,
              relayUsername: host.relayUsername,
              srpUsername: host.srpUsername,
              srpPassword: "", // Ignored when session is provided
              rememberMe: true,
              onStatusChange: () => {},
              session: host.session,
            });
            // ConnectionGate redirects to the host's canonical relay projects route.
          } else {
            // No session - go to relay login pre-filled
            navigate(relayLoginPath(host));
          }
        } else {
          // Direct mode
          if (!host.wsUrl) {
            throw new Error(t("hostPickerMissingWebSocketUrl"));
          }

          if (host.session) {
            await connect(host.wsUrl, host.srpUsername, "", true);
            // Success - navigate to projects (direct mode doesn't use username URLs)
            navigate("/projects");
          } else {
            // No session - go to direct login pre-filled
            navigate("/login/direct");
          }
        }
      } catch (err) {
        const message =
          err instanceof Error
            ? err.message
            : t("hostPickerErrorConnectionFailed");
        const reason = categorizeResumeError(err);
        if (requiresResumeLogin(reason)) {
          // A received refusal requires fresh login under the existing policy.
          // The transport owns retirement of the exact attempted session.
          navigate(
            host.mode === "relay" ? relayLoginPath(host) : "/login/direct",
            { state: signInRequiredState(reason) },
          );
          return;
        }
        // Transport/proof failures keep the session and leave retry to the user.
        setError(getResumeError(err)?.message ?? message);
      } finally {
        setConnectingHostId(null);
      }
    },
    [connectViaRelay, connect, navigate, setCurrentHostId, t],
  );

  // Delete a host
  const handleDeleteHost = useCallback(
    async (hostId: string, e: React.MouseEvent) => {
      e.stopPropagation();
      if (confirm(t("hostPickerRemoveConfirm"))) {
        await removeHost(hostId);
        setHosts((prev) => prev.filter((h) => h.id !== hostId));
      }
    },
    [t],
  );

  // Format last connected time
  const formatLastConnected = (isoString?: string): string => {
    if (!isoString) return "";
    try {
      const date = new Date(isoString);
      const now = new Date();
      const diffMs = now.getTime() - date.getTime();
      const diffMins = Math.floor(diffMs / 60000);
      const diffHours = Math.floor(diffMs / 3600000);
      const diffDays = Math.floor(diffMs / 86400000);

      if (diffMins < 1) return t("hostPickerLastConnectedJustNow");
      if (diffMins < 60)
        return t("hostPickerLastConnectedMinutes", { count: diffMins });
      if (diffHours < 24)
        return t("hostPickerLastConnectedHours", { count: diffHours });
      if (diffDays < 7)
        return t("hostPickerLastConnectedDays", { count: diffDays });
      return date.toLocaleDateString();
    } catch {
      return "";
    }
  };

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
            <Spinner size="large" />
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

        {hosts.length > 0 && (
          <>
            <p className="login-subtitle">{t("hostPickerSavedHosts")}</p>

            <div className="host-picker-list" data-testid="saved-hosts-list">
              {hosts.map((host) => {
                const status = hostStatuses[host.id] ?? "unknown";
                const isConnecting = connectingHostId === host.id;

                return (
                  <ButtonBase
                    key={host.id}
                    className="host-picker-item"
                    onClick={() => handleConnectHost(host)}
                    disabled={isConnecting}
                    data-testid={`host-item-${host.id}`}
                  >
                    <div className="host-picker-item-main">
                      <span
                        className={`host-picker-status host-picker-status-${status}`}
                        title={t(
                          `hostPickerStatus${status.charAt(0).toUpperCase()}${status.slice(1)}` as never,
                        )}
                      />
                      <span className="host-picker-name">
                        {host.displayName}
                      </span>
                      <span className="host-picker-mode">{host.mode}</span>
                    </div>
                    <div className="host-picker-item-meta">
                      {host.lastConnected && (
                        <span className="host-picker-last-connected">
                          {formatLastConnected(host.lastConnected)}
                        </span>
                      )}
                      <IconButton
                        size="small"
                        className="host-picker-delete"
                        onClick={(e) => handleDeleteHost(host.id, e)}
                        label={t("hostPickerRemoveHost")}
                        data-testid={`delete-host-${host.id}`}
                      >
                        &times;
                      </IconButton>
                    </div>
                    {isConnecting && (
                      <div className="host-picker-connecting">
                        <Spinner />
                      </div>
                    )}
                  </ButtonBase>
                );
              })}
            </div>

            {error && (
              <Banner tone="error" data-testid="host-picker-error">
                {error}
              </Banner>
            )}

            <p className="login-subtitle host-picker-add-title">
              {t("hostPickerAddNewHost")}
            </p>
          </>
        )}

        {hosts.length === 0 && (
          <p className="login-subtitle">{t("hostPickerHowToConnect")}</p>
        )}

        <div className="login-mode-options">
          <ButtonBase
            className="login-mode-option"
            onClick={() => navigate("/login/relay")}
            data-testid="relay-mode-button"
          >
            <span className="login-mode-option-title">
              {t("hostPickerRelayTitle")}
            </span>
            <span className="login-mode-option-desc">
              {t("hostPickerRelayDescription")}
            </span>
          </ButtonBase>

          <ButtonBase
            className="login-mode-option login-mode-option-secondary"
            onClick={() => navigate("/login/direct")}
            data-testid="direct-mode-button"
          >
            <span className="login-mode-option-title">
              {t("hostPickerDirectTitle")}
            </span>
            <span className="login-mode-option-desc">
              {t("hostPickerDirectDescription")}
            </span>
          </ButtonBase>
        </div>

        <p className="login-hint">
          {hosts.length > 0
            ? t("hostPickerSavedHint")
            : t("hostPickerEmptyHint")}
        </p>
      </div>
    </div>
  );
}
