import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api/client";
import { useFileActivity } from "./useFileActivity";

// Debounce interval for refetch on SSE events
const REFETCH_DEBOUNCE_MS = 500;

/**
 * Hook that monitors the global count of active agents (running processes).
 * Similar to useNeedsAttentionBadge but tracks active/running sessions.
 */
export function useGlobalActiveAgents() {
  const [count, setCount] = useState(0);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Fetch just the active count
  const fetchCount = useCallback(async () => {
    try {
      const data = await api.getInbox();
      setCount(data.active.length);
    } catch {
      // Silently ignore errors - indicator is non-critical
    }
  }, []);

  // Debounced refetch for SSE events
  const debouncedRefetch = useCallback(() => {
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
    }
    debounceTimerRef.current = setTimeout(fetchCount, REFETCH_DEBOUNCE_MS);
  }, [fetchCount]);

  // Subscribe to SSE events for real-time updates
  // onProcessStateChange fires when sessions enter/exit "running" state
  useFileActivity({
    onProcessStateChange: debouncedRefetch,
    onReconnect: fetchCount, // Refetch immediately on reconnect
  });

  // Initial fetch
  useEffect(() => {
    fetchCount();
  }, [fetchCount]);

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
