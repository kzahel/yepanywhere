import { useCallback, useEffect, useState } from "react";
import { type ServerSettings, api } from "../api/client";

interface UseServerSettingsResult {
  settings: ServerSettings | null;
  isLoading: boolean;
  error: string | null;
  updateSetting: <K extends keyof ServerSettings>(
    key: K,
    value: ServerSettings[K],
  ) => Promise<void>;
  refetch: () => Promise<void>;
}

/**
 * Hook for managing server-wide settings.
 * Fetches settings on mount and provides update functionality.
 */
export function useServerSettings(): UseServerSettingsResult {
  const [settings, setSettings] = useState<ServerSettings | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchSettings = useCallback(async () => {
    try {
      setIsLoading(true);
      setError(null);
      const response = await api.getServerSettings();
      setSettings(response.settings);
    } catch (err) {
      console.error("[useServerSettings] Failed to fetch settings:", err);
      setError(err instanceof Error ? err.message : "Failed to load settings");
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchSettings();
  }, [fetchSettings]);

  const updateSetting = useCallback(
    async <K extends keyof ServerSettings>(
      key: K,
      value: ServerSettings[K],
    ): Promise<void> => {
      try {
        setError(null);
        const response = await api.updateServerSettings({ [key]: value });
        setSettings(response.settings);
      } catch (err) {
        console.error("[useServerSettings] Failed to update setting:", err);
        setError(
          err instanceof Error ? err.message : "Failed to update setting",
        );
        throw err;
      }
    },
    [],
  );

  return {
    settings,
    isLoading,
    error,
    updateSetting,
    refetch: fetchSettings,
  };
}
