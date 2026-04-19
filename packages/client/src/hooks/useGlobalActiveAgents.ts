import { useCallback, useEffect, useRef, useState } from "react";
import { fetchJSON } from "../api/client";
import { useFileActivity } from "./useFileActivity";

// Debounce interval for refetch on SSE events
const REFETCH_DEBOUNCE_MS = 500;

interface ProcessesResponse {
  processes: Array<{ state: string }>;
}

/**
 * Hook that monitors the global count of active agents (running processes).
 * Similar to useNeedsAttentionBadge but tracks active/running sessions.
 */
export function useGlobalActiveAgents(enabled = true) {
  const [count, setCount] = useState(0);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Fetch just the active count
  const fetchCount = useCallback(async () => {
    if (!enabled) {
      setCount(0);
      return;
    }
    try {
      const data = await fetchJSON<ProcessesResponse>("/processes");
      setCount(
        data.processes.filter(
          (process) =>
            process.state === "in-turn" || process.state === "waiting-input",
        ).length,
      );
    } catch {
      // Silently ignore errors - indicator is non-critical
    }
  }, [enabled]);

  // Debounced refetch for SSE events
  const debouncedRefetch = useCallback(() => {
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
    }
    debounceTimerRef.current = setTimeout(fetchCount, REFETCH_DEBOUNCE_MS);
  }, [fetchCount]);

  // Subscribe to SSE events for real-time updates
  // onProcessStateChange fires when sessions enter/exit "running" state
  useFileActivity(
    enabled
      ? {
          onProcessStateChange: debouncedRefetch,
          onReconnect: fetchCount, // Refetch immediately on reconnect
        }
      : {},
  );

  // Initial fetch
  useEffect(() => {
    if (!enabled) {
      setCount(0);
      return;
    }
    fetchCount();
  }, [enabled, fetchCount]);

  // Cleanup debounce timer
  useEffect(() => {
    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
    };
  }, []);

  return count;
}
