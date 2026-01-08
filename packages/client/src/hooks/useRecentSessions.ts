import type { EnrichedRecentEntry } from "@yep-anywhere/shared";
import { useCallback, useEffect, useState } from "react";
import { api } from "../api/client";

export type { EnrichedRecentEntry };

/** @deprecated Use EnrichedRecentEntry instead */
export interface RecentSessionEntry {
  sessionId: string;
  projectId: string;
  visitedAt: string;
}

/**
 * Record a session visit (fire-and-forget).
 * Can be called from outside React components.
 */
export function recordSessionVisit(sessionId: string, projectId: string): void {
  api.recordVisit(sessionId, projectId).catch((err) => {
    console.error("Failed to record session visit:", err);
  });
}

/**
 * Hook to access recent sessions list from the server.
 * Fetches on mount and provides methods to record visits and clear.
 * Returns enriched entries with session title and project name.
 */
export function useRecentSessions(): {
  recentSessions: EnrichedRecentEntry[];
  isLoading: boolean;
  error: Error | null;
  recordVisit: (sessionId: string, projectId: string) => void;
  clearRecents: () => void;
  refetch: () => void;
} {
  const [recentSessions, setRecentSessions] = useState<EnrichedRecentEntry[]>(
    [],
  );
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const fetchRecents = useCallback(async () => {
    try {
      const response = await api.getRecents();
      setRecentSessions(response.recents);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err : new Error("Failed to fetch"));
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchRecents();
  }, [fetchRecents]);

  const recordVisit = useCallback(
    (sessionId: string, projectId: string) => {
      // Optimistic update: move existing entry to front (preserving enrichment)
      setRecentSessions((prev) => {
        const existing = prev.find((e) => e.sessionId === sessionId);
        const filtered = prev.filter((e) => e.sessionId !== sessionId);
        if (existing) {
          // Move existing entry to front with updated timestamp
          return [
            { ...existing, visitedAt: new Date().toISOString() },
            ...filtered,
          ];
        }
        // New entry - will be enriched on next refetch
        return prev;
      });

      // Fire and forget to server
      api.recordVisit(sessionId, projectId).catch((err) => {
        console.error("Failed to record session visit:", err);
        // Refetch to sync with server state
        fetchRecents();
      });
    },
    [fetchRecents],
  );

  const clearRecents = useCallback(() => {
    // Optimistic update
    setRecentSessions([]);

    api.clearRecents().catch((err) => {
      console.error("Failed to clear recents:", err);
      // Refetch to sync with server state
      fetchRecents();
    });
  }, [fetchRecents]);

  return {
    recentSessions,
    isLoading,
    error,
    recordVisit,
    clearRecents,
    refetch: fetchRecents,
  };
}
