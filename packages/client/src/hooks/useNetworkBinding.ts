import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api/client";
import type {
  NetworkBindingState,
  UpdateBindingRequest,
} from "../api/networkBindingClient";
import { activityBus } from "../lib/activityBus";
import { useBackgroundRevalidation } from "./useBackgroundRevalidation";

/**
 * Hook to manage network binding configuration.
 *
 * Returns:
 * - binding: Current binding state (localhost and network sockets)
 * - loading: Whether the initial fetch is in progress
 * - error: Any error that occurred during fetch/update
 * - applying: Whether an update is in progress
 * - updateBinding: Function to update binding configuration
 * - disableNetwork: Function to disable network socket
 * - refetch: Function to manually refresh
 */
export function useNetworkBinding() {
  const [binding, setBinding] = useState<NetworkBindingState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [applying, setApplying] = useState(false);
  const hasFetchedRef = useRef(false);

  const fetch = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.getNetworkBinding();
      setBinding(data);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setLoading(false);
    }
  }, []);

  /**
   * Re-read without a loading state, so an open form is never unmounted
   * mid-edit by its own apply or another client's change.
   */
  const reload = useCallback(async () => {
    try {
      setBinding(await api.getNetworkBinding());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    }
  }, []);

  // Initial fetch - only once (avoid StrictMode double-fetch)
  useEffect(() => {
    if (hasFetchedRef.current) return;
    hasFetchedRef.current = true;
    fetch();
  }, [fetch]);

  // Quietly refresh binding state when the connection re-establishes, but not
  // while an update is being applied (avoid clobbering an in-progress change).
  useBackgroundRevalidation({
    fetcher: () => api.getNetworkBinding(),
    current: binding,
    apply: (next) => {
      setBinding(next);
      setError(null);
    },
    enabled: !applying,
  });

  // Another client changed the listeners; show what the server now reports.
  const applyingRef = useRef(applying);
  applyingRef.current = applying;
  useEffect(
    () =>
      activityBus.on("network-binding-changed", () => {
        if (!applyingRef.current) void reload();
      }),
    [reload],
  );

  const updateBinding = useCallback(
    async (
      request: UpdateBindingRequest,
      confirmed = false,
    ): Promise<{ redirectUrl?: string }> => {
      setApplying(true);
      setError(null);
      try {
        const result = await api.setNetworkBinding(request, confirmed);
        if (!result.success) {
          throw new Error(result.error ?? "Failed to update binding");
        }
        // Refetch to get updated state
        await reload();
        return { redirectUrl: result.redirectUrl };
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        setError(error);
        throw error;
      } finally {
        setApplying(false);
      }
    },
    [reload],
  );

  const disableNetwork = useCallback(
    async (confirmed = false) => {
      setApplying(true);
      setError(null);
      try {
        const result = await api.disableNetworkBinding(confirmed);
        if (!result.success) {
          throw new Error(result.error ?? "Failed to disable network socket");
        }
        // Refetch to get updated state
        await reload();
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        setError(error);
        throw error;
      } finally {
        setApplying(false);
      }
    },
    [reload],
  );

  return {
    binding,
    loading,
    error,
    applying,
    updateBinding,
    disableNetwork,
    refetch: fetch,
  };
}
