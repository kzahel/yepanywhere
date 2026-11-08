/**
 * Hook for managing remote access settings.
 *
 * Remote access allows connecting to the yepanywhere server from outside
 * the local network via a relay server. Uses SRP for zero-knowledge
 * password authentication and NaCl for end-to-end encryption.
 */
import { useCallback, useEffect, useState } from "react";
import { fetchJSON } from "../api/client";
import {
  type ConnectionImpactScope,
  isConnectionImpactDeclined,
  withImpactConfirmation,
} from "../api/connectionImpact";
import { useConnectionImpactConfirmation } from "./useConnectionImpactConfirmation";

export interface RelayConfig {
  /** Relay server URL (e.g., wss://relay.yepanywhere.com/ws) */
  url: string;
  /** Username for relay registration */
  username: string;
}

export type RelayStatus =
  | "disconnected"
  | "connecting"
  | "registering"
  | "waiting"
  | "rejected";

export interface RelayStatusInfo {
  status: RelayStatus;
  error: string | null;
  reconnectAttempts: number;
}

export interface RemoteAccessConfig {
  /** Whether remote access is enabled */
  enabled: boolean;
  /** Username (if enabled) */
  username?: string;
  /** When credentials were created (if enabled) */
  createdAt?: string;
}

export interface RemoteSession {
  sessionId: string;
  username: string;
  createdAt: string;
  lastUsed: string;
  /** Browser profile ID that created this session */
  browserProfileId?: string;
  /** User agent string of device that created this session */
  userAgent?: string;
  /** Origin URL where this session was created from */
  origin?: string;
  /** When the session was last actively connected */
  lastConnectedAt?: string;
}

interface UseRemoteAccessResult {
  /** Current remote access configuration */
  config: RemoteAccessConfig | null;
  /** Current relay configuration */
  relayConfig: RelayConfig | null;
  /** Current relay connection status */
  relayStatus: RelayStatusInfo | null;
  /** Active remote sessions */
  sessions: RemoteSession[];
  /** Whether the config is loading */
  loading: boolean;
  /** Error message if any */
  error: string | null;
  /*
   * Changes that can end this client's own Remote Access connection ask
   * before applying (topics/connection-safe-settings.md). A declined prompt
   * rejects with ConnectionImpactDeclinedError and changes nothing; pass one
   * scope to the calls of a single save so it asks once.
   */
  /** Configure remote access with password (relay must be configured first) */
  configure: (password: string, scope?: ConnectionImpactScope) => Promise<void>;
  /** Enable remote access (must be configured first) */
  enable: () => Promise<void>;
  /** Disable remote access */
  disable: () => Promise<void>;
  /** Clear credentials without disabling */
  clearCredentials: () => Promise<void>;
  /** Update relay configuration */
  updateRelayConfig: (
    config: RelayConfig,
    scope?: ConnectionImpactScope,
  ) => Promise<void>;
  /** Clear relay configuration */
  clearRelayConfig: () => Promise<void>;
  /** Revoke a specific session */
  revokeSession: (sessionId: string) => Promise<void>;
  /** Revoke all sessions */
  revokeAllSessions: () => Promise<void>;
  /** Refresh the configuration */
  refresh: () => Promise<void>;
}

export function useRemoteAccess(): UseRemoteAccessResult {
  const [config, setConfig] = useState<RemoteAccessConfig | null>(null);
  const [relayConfig, setRelayConfig] = useState<RelayConfig | null>(null);
  const [relayStatus, setRelayStatus] = useState<RelayStatusInfo | null>(null);
  const [sessions, setSessions] = useState<RemoteSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const confirmImpact = useConnectionImpactConfirmation();

  const refresh = useCallback(async () => {
    try {
      const [configResponse, relayResponse, statusResponse, sessionsResponse] =
        await Promise.all([
          fetchJSON<RemoteAccessConfig>("/remote-access/config"),
          fetchJSON<{ relay: RelayConfig | null }>("/remote-access/relay"),
          fetchJSON<RelayStatusInfo>("/remote-access/relay/status"),
          fetchJSON<{ sessions: RemoteSession[] }>("/remote-access/sessions"),
        ]);
      setConfig(configResponse);
      setRelayConfig(relayResponse.relay);
      setRelayStatus(statusResponse);
      setSessions(sessionsResponse.sessions);
      setError(null);
    } catch (err) {
      console.error("[useRemoteAccess] Failed to fetch config:", err);
      setError(err instanceof Error ? err.message : "Failed to fetch config");
    }
  }, []);

  useEffect(() => {
    setLoading(true);
    refresh().finally(() => setLoading(false));
  }, [refresh]);

  /** Send a change that may disconnect this client, then refresh. */
  const change = useCallback(
    async (
      path: string,
      init: RequestInit,
      failure: string,
      options: { mayDisconnect: boolean; scope?: ConnectionImpactScope },
    ) => {
      try {
        await confirmImpact(
          (confirmed) =>
            fetchJSON(withImpactConfirmation(path, confirmed), init),
          options,
        );
        await refresh();
      } catch (err) {
        if (isConnectionImpactDeclined(err)) throw err;
        const message = err instanceof Error ? err.message : failure;
        setError(message);
        throw new Error(message);
      }
    },
    [confirmImpact, refresh],
  );

  const configure = useCallback(
    (password: string, scope?: ConnectionImpactScope) =>
      change(
        "/remote-access/configure",
        { method: "POST", body: JSON.stringify({ password }) },
        "Failed to configure remote access",
        { mayDisconnect: true, scope },
      ),
    [change],
  );

  const enable = useCallback(
    () =>
      change(
        "/remote-access/enable",
        { method: "POST" },
        "Failed to enable remote access",
        { mayDisconnect: false },
      ),
    [change],
  );

  const disable = useCallback(
    () =>
      change(
        "/remote-access/disable",
        { method: "POST" },
        "Failed to disable remote access",
        { mayDisconnect: true },
      ),
    [change],
  );

  const clearCredentials = useCallback(
    () =>
      change(
        "/remote-access/clear",
        { method: "POST" },
        "Failed to clear remote access credentials",
        { mayDisconnect: true },
      ),
    [change],
  );

  const updateRelayConfig = useCallback(
    (newConfig: RelayConfig, scope?: ConnectionImpactScope) =>
      change(
        "/remote-access/relay",
        { method: "PUT", body: JSON.stringify(newConfig) },
        "Failed to update relay configuration",
        { mayDisconnect: true, scope },
      ),
    [change],
  );

  const clearRelayConfig = useCallback(
    () =>
      change(
        "/remote-access/relay",
        { method: "DELETE" },
        "Failed to clear relay configuration",
        { mayDisconnect: true },
      ),
    [change],
  );

  const revokeSession = useCallback(
    (sessionId: string) =>
      change(
        `/remote-access/sessions/${encodeURIComponent(sessionId)}`,
        { method: "DELETE" },
        "Failed to revoke session",
        // Usually another device's login; the server asks when it is ours.
        { mayDisconnect: false },
      ),
    [change],
  );

  const revokeAllSessions = useCallback(
    () =>
      change(
        "/remote-access/sessions",
        { method: "DELETE" },
        "Failed to revoke all sessions",
        { mayDisconnect: true },
      ),
    [change],
  );

  return {
    config,
    relayConfig,
    relayStatus,
    sessions,
    loading,
    error,
    configure,
    enable,
    disable,
    clearCredentials,
    updateRelayConfig,
    clearRelayConfig,
    revokeSession,
    revokeAllSessions,
    refresh,
  };
}
