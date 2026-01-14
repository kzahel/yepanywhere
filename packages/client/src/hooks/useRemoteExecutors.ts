import { useCallback, useEffect, useRef, useState } from "react";
import { type RemoteExecutorTestResult, api } from "../api/client";

/**
 * Hook to fetch and manage remote executors configuration.
 *
 * Returns:
 * - executors: Array of SSH host aliases
 * - loading: Whether the initial fetch is in progress
 * - error: Any error that occurred during fetch
 * - refetch: Function to manually refresh the list
 * - addExecutor: Add a new executor and optionally test it first
 * - removeExecutor: Remove an executor from the list
 * - testExecutor: Test SSH connection to an executor
 */
export function useRemoteExecutors() {
  const [executors, setExecutors] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const hasFetchedRef = useRef(false);

  const fetchExecutors = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.getRemoteExecutors();
      setExecutors(data.executors);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setLoading(false);
    }
  }, []);

  // Initial fetch - only once (avoid StrictMode double-fetch)
  useEffect(() => {
    if (hasFetchedRef.current) return;
    hasFetchedRef.current = true;
    fetchExecutors();
  }, [fetchExecutors]);

  const addExecutor = useCallback(
    async (host: string): Promise<void> => {
      if (!host.trim()) return;
      const trimmedHost = host.trim();

      // Optimistic update
      const prevExecutors = executors;
      if (!executors.includes(trimmedHost)) {
        setExecutors([...executors, trimmedHost]);
      }

      try {
        const result = await api.updateRemoteExecutors([
          ...prevExecutors.filter((e) => e !== trimmedHost),
          trimmedHost,
        ]);
        setExecutors(result.executors);
      } catch (err) {
        // Revert on error
        setExecutors(prevExecutors);
        throw err;
      }
    },
    [executors],
  );

  const removeExecutor = useCallback(
    async (host: string): Promise<void> => {
      // Optimistic update
      const prevExecutors = executors;
      setExecutors(executors.filter((e) => e !== host));

      try {
        const result = await api.updateRemoteExecutors(
          prevExecutors.filter((e) => e !== host),
        );
        setExecutors(result.executors);
      } catch (err) {
        // Revert on error
        setExecutors(prevExecutors);
        throw err;
      }
    },
    [executors],
  );

  const testExecutor = useCallback(
    async (host: string): Promise<RemoteExecutorTestResult> => {
      return api.testRemoteExecutor(host);
    },
    [],
  );

  return {
    executors,
    loading,
    error,
    refetch: fetchExecutors,
    addExecutor,
    removeExecutor,
    testExecutor,
  };
}
