import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api/client";
import type { CodexUpdateStatus } from "../api/codexUpdateStatus";

interface UseCodexUpdateStatusResult {
  status: CodexUpdateStatus | null;
  isChecking: boolean;
  isInstalling: boolean;
  error: string | null;
  installOutput: string | null;
  refresh: (force?: boolean) => Promise<void>;
  install: () => Promise<boolean>;
}

interface UseCodexUpdateStatusOptions {
  enabled?: boolean;
}

export function useCodexUpdateStatus(
  options: UseCodexUpdateStatusOptions = {},
): UseCodexUpdateStatusResult {
  const enabled = options.enabled ?? true;
  const [status, setStatus] = useState<CodexUpdateStatus | null>(null);
  const [isChecking, setIsChecking] = useState(false);
  const [isInstalling, setIsInstalling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [installOutput, setInstallOutput] = useState<string | null>(null);
  const mounted = useRef(true);
  const enabledRef = useRef(enabled);

  useEffect(() => {
    enabledRef.current = enabled;
  }, [enabled]);

  const refresh = useCallback(async (force?: boolean) => {
    if (!enabledRef.current) {
      return;
    }
    try {
      setIsChecking(true);
      setError(null);
      const response = await api.getCodexUpdateStatus(force);
      if (mounted.current && enabledRef.current) setStatus(response.status);
    } catch (err) {
      if (mounted.current && enabledRef.current) {
        setError(err instanceof Error ? err.message : "Failed to check");
      }
    } finally {
      if (mounted.current) setIsChecking(false);
    }
  }, []);

  const install = useCallback(async (): Promise<boolean> => {
    try {
      setIsInstalling(true);
      setError(null);
      setInstallOutput(null);
      const result = await api.installCodexUpdate();
      if (mounted.current) {
        setStatus(result.status);
        setInstallOutput(result.output || null);
        if (!result.success) {
          setError(result.error ?? "Install failed");
        }
      }
      return result.success;
    } catch (err) {
      if (mounted.current) {
        setError(err instanceof Error ? err.message : "Install request failed");
      }
      return false;
    } finally {
      if (mounted.current) setIsInstalling(false);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    if (!enabled) {
      setIsChecking(false);
      return () => {
        mounted.current = false;
      };
    }

    refresh();
    const onFocus = () => {
      refresh();
    };
    window.addEventListener("focus", onFocus);
    return () => {
      mounted.current = false;
      window.removeEventListener("focus", onFocus);
    };
  }, [enabled, refresh]);

  return {
    status,
    isChecking,
    isInstalling,
    error,
    installOutput,
    refresh,
    install,
  };
}
