/**
 * Hook for managing remote access settings.
 *
 * Remote access allows connecting to the yepanywhere server from outside
 * the local network via a relay server. Uses SRP for zero-knowledge
 * password authentication and NaCl for end-to-end encryption.
 */
import { useCallback, useEffect, useState } from "react";
import { fetchJSON } from "../api/client";

export interface RemoteAccessConfig {
  /** Whether remote access is enabled */
  enabled: boolean;
  /** Username (if enabled) */
  username?: string;
  /** When credentials were created (if enabled) */
  createdAt?: string;
}

interface UseRemoteAccessResult {
  /** Current remote access configuration */
  config: RemoteAccessConfig | null;
  /** Whether the config is loading */
  loading: boolean;
  /** Error message if any */
  error: string | null;
  /** Enable remote access with username and password */
  enable: (username: string, password: string) => Promise<void>;
  /** Disable remote access */
  disable: () => Promise<void>;
  /** Clear credentials without disabling */
  clearCredentials: () => Promise<void>;
  /** Refresh the configuration */
  refresh: () => Promise<void>;
}

export function useRemoteAccess(): UseRemoteAccessResult {
  const [config, setConfig] = useState<RemoteAccessConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const response = await fetchJSON<RemoteAccessConfig>(
        "/remote-access/config",
      );
      setConfig(response);
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

  const enable = useCallback(
    async (username: string, password: string) => {
      try {
        await fetchJSON("/remote-access/configure", {
          method: "POST",
          body: JSON.stringify({ username, password }),
        });
        await refresh();
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Failed to enable remote access";
        setError(message);
        throw new Error(message);
      }
    },
    [refresh],
  );

  const disable = useCallback(async () => {
    try {
      await fetchJSON("/remote-access/disable", {
        method: "POST",
      });
      await refresh();
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to disable remote access";
      setError(message);
      throw new Error(message);
    }
  }, [refresh]);

  const clearCredentials = useCallback(async () => {
    try {
      await fetchJSON("/remote-access/clear", {
        method: "POST",
      });
      await refresh();
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : "Failed to clear remote access credentials";
      setError(message);
      throw new Error(message);
    }
  }, [refresh]);

  return {
    config,
    loading,
    error,
    enable,
    disable,
    clearCredentials,
    refresh,
  };
}
