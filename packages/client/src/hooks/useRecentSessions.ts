import type { EnrichedRecentEntry } from "@yep-anywhere/shared";
import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import { api } from "../api/client";
import { createRecentsApi } from "../api/recentsClient";
import { useCurrentSourceRuntime } from "../contexts/SourceRuntimeContext";
import { useOptionalRemoteConnection } from "../contexts/RemoteConnectionContext";
import { isRemoteClient } from "../lib/connection";
import {
  ensureClientQuery,
  invalidateClientQuery,
} from "../lib/clientQueryController";
import { isCatalogRefreshingEvent } from "../lib/clientQueryRevalidation";
import { LOCAL_CLIENT_SUMMARY_SOURCE_KEY } from "../lib/clientSummaryStore";
import { getSourceRuntimeRegistry } from "../lib/sourceRuntime";
import { catalogLoadState } from "../lib/clientSummaryCollections";
import { useRetainedClientQuery } from "./useRetainedClientQuery";
import {
  RECENTS_QUERY_KEY,
  EMPTY_RECENTS_SNAPSHOT,
  createRecentsQuery,
  readRecentsSnapshot,
  publishRecentsSnapshot,
  subscribeRecents,
  retainRecentsSource,
  hasRecentsConsumers,
} from "../lib/recentsQuery";

export { resetRecentSessionsForTests } from "../lib/recentsQuery";

export type { EnrichedRecentEntry };

/** @deprecated Use EnrichedRecentEntry instead */
export interface RecentSessionEntry {
  sessionId: string;
  projectId: string;
  visitedAt: string;
}

interface UseRecentSessionsOptions {
  limit?: number;
}

const REVALIDATE_EVENTS = [
  "refresh",
  "reconnect",
  "session-catalog-updated",
  "recents-changed",
  "session-id-remapped",
  "projects-changed",
] as const;

export function primeLocalRecentSessions() {
  const runtime = getSourceRuntimeRegistry().getOrCreateSourceRuntime(
    LOCAL_CLIENT_SUMMARY_SOURCE_KEY,
  );
  return ensureClientQuery(
    createRecentsQuery(
      runtime.sourceKey,
      createRecentsApi(runtime.transport.fetch.bind(runtime.transport)),
    ),
  );
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
export function useRecentSessions(options: UseRecentSessionsOptions = {}): {
  recentSessions: EnrichedRecentEntry[];
  recentProjectIds: string[];
  isLoadingVisits: boolean;
  isLoading: boolean;
  error: Error | null;
  recordVisit: (sessionId: string, projectId: string) => void;
  clearRecents: () => void;
  refetch: () => void;
} {
  const { limit = 50 } = options;
  const runtime = useCurrentSourceRuntime();
  const { sourceKey } = runtime;
  useEffect(() => retainRecentsSource(sourceKey), [sourceKey]);
  const recentsApi = useMemo(
    () => createRecentsApi(runtime.transport.fetch.bind(runtime.transport)),
    [runtime],
  );
  const remoteConnection = useOptionalRemoteConnection();
  const ready = !isRemoteClient() || Boolean(remoteConnection?.connection);
  const snapshot = useSyncExternalStore(
    subscribeRecents,
    () => readRecentsSnapshot(sourceKey),
    () => EMPTY_RECENTS_SNAPSHOT,
  );
  const { loading, error, refetch } = useRetainedClientQuery({
    ...createRecentsQuery(sourceKey, recentsApi),
    bootstrapTier: "route",
    ready,
    hasData: snapshot.loaded,
    revalidateOn: REVALIDATE_EVENTS,
    // Recents shows `refreshing`, so it refetches when a refresh ends.
    shouldRevalidateEvent: (event) => !isCatalogRefreshingEvent(event),
  });
  const fetchRecents = useCallback(() => {
    if (hasRecentsConsumers(sourceKey)) void refetch({ force: true });
  }, [refetch, sourceKey]);

  const recordVisit = useCallback(
    (sessionId: string, projectId: string) => {
      // Optimistic update: move existing entry to front (preserving enrichment)
      const prev = readRecentsSnapshot(sourceKey);
      const existing = prev.recents.find((e) => e.sessionId === sessionId);
      const recents = existing
        ? [
            { ...existing, visitedAt: new Date().toISOString() },
            ...prev.recents.filter((e) => e.sessionId !== sessionId),
          ]
        : prev.recents;
      invalidateClientQuery(sourceKey, RECENTS_QUERY_KEY);
      publishRecentsSnapshot(sourceKey, {
        ...prev,
        recents,
        visits: [
          { sessionId, projectId, visitedAt: new Date().toISOString() },
          ...prev.visits.filter((entry) => entry.sessionId !== sessionId),
        ].slice(0, 100),
      });

      // Fire and forget to server
      recentsApi
        .recordVisit(sessionId, projectId)
        .then(fetchRecents)
        .catch((err) => {
          console.error("Failed to record session visit:", err);
          // Refetch to sync with server state
          fetchRecents();
        });
    },
    [fetchRecents, recentsApi, sourceKey],
  );

  const clearRecents = useCallback(() => {
    // Optimistic update
    invalidateClientQuery(sourceKey, RECENTS_QUERY_KEY);
    publishRecentsSnapshot(sourceKey, {
      recents: [],
      visits: [],
      loaded: true,
    });

    recentsApi
      .clearRecents()
      .then(fetchRecents)
      .catch((err) => {
        console.error("Failed to clear recents:", err);
        // Refetch to sync with server state
        fetchRecents();
      });
  }, [fetchRecents, recentsApi, sourceKey]);

  const catalogState = catalogLoadState(
    snapshot.catalog,
    snapshot.recents.length,
  );
  const recentProjectIds = useMemo(
    () => [
      ...new Set(
        snapshot.visits.slice(0, limit).map((entry) => entry.projectId),
      ),
    ],
    [snapshot.visits, limit],
  );

  return {
    recentSessions: snapshot.recents.slice(0, limit),
    recentProjectIds,
    isLoadingVisits: loading || !ready,
    isLoading:
      loading ||
      !ready ||
      (snapshot.recents.length === 0 &&
        snapshot.visits.length > 0 &&
        Boolean(snapshot.catalog?.refreshing)),
    error: error ?? catalogState.refreshError,
    recordVisit,
    clearRecents,
    refetch: fetchRecents,
  };
}
