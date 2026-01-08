import { useCallback, useEffect, useRef, useState } from "react";
import {
  type GlobalSessionItem,
  type GlobalSessionStats,
  type ProjectOption,
  api,
} from "../api/client";
import {
  type ProcessStateEvent,
  type SessionCreatedEvent,
  type SessionMetadataChangedEvent,
  type SessionSeenEvent,
  type SessionStatusEvent,
  type SessionUpdatedEvent,
  useFileActivity,
} from "./useFileActivity";

const REFETCH_DEBOUNCE_MS = 500;

export interface UseGlobalSessionsOptions {
  projectId?: string | null;
  searchQuery?: string;
  limit?: number;
  includeArchived?: boolean;
  starred?: boolean;
}

/** Default stats when no data loaded */
const DEFAULT_STATS: GlobalSessionStats = {
  totalCount: 0,
  unreadCount: 0,
  starredCount: 0,
  archivedCount: 0,
  providerCounts: {},
};

export function useGlobalSessions(options: UseGlobalSessionsOptions = {}) {
  const { projectId, searchQuery, limit, includeArchived, starred } = options;
  const [sessions, setSessions] = useState<GlobalSessionItem[]>([]);
  const [stats, setStats] = useState<GlobalSessionStats>(DEFAULT_STATS);
  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const refetchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hasInitialLoadRef = useRef(false);
  const sessionsRef = useRef<GlobalSessionItem[]>([]);
  sessionsRef.current = sessions;
  const projectsRef = useRef<ProjectOption[]>([]);
  projectsRef.current = projects;

  // Track the options used for the last fetch (for loadMore pagination)
  const lastFetchOptionsRef = useRef<{
    projectId?: string | null;
    searchQuery?: string;
    limit?: number;
    includeArchived?: boolean;
    starred?: boolean;
  }>({});

  const fetch = useCallback(async () => {
    // Reset initial load flag when options change
    const optionsChanged =
      lastFetchOptionsRef.current.projectId !== projectId ||
      lastFetchOptionsRef.current.searchQuery !== searchQuery ||
      lastFetchOptionsRef.current.includeArchived !== includeArchived ||
      lastFetchOptionsRef.current.starred !== starred;

    if (optionsChanged) {
      hasInitialLoadRef.current = false;
    }

    lastFetchOptionsRef.current = {
      projectId,
      searchQuery,
      limit,
      includeArchived,
      starred,
    };

    // Only show loading state on initial load
    if (sessionsRef.current.length === 0 || optionsChanged) {
      setLoading(true);
    }
    setError(null);

    try {
      const data = await api.getGlobalSessions({
        project: projectId ?? undefined,
        q: searchQuery || undefined,
        limit,
        includeArchived,
        starred,
      });

      if (!hasInitialLoadRef.current || optionsChanged) {
        setSessions(data.sessions);
        hasInitialLoadRef.current = true;
      } else {
        // On refetch, preserve order and update in-place
        setSessions((prev) => {
          const newDataMap = new Map(data.sessions.map((s) => [s.id, s]));

          // Update existing sessions in their current order
          const updated = prev.map((existing) => {
            const newData = newDataMap.get(existing.id);
            return newData ?? existing;
          });

          // Filter out sessions that no longer exist
          const filtered = updated.filter((s) => newDataMap.has(s.id));

          // Add any new sessions at the top
          const existingIds = new Set(prev.map((s) => s.id));
          const newSessions = data.sessions.filter(
            (s) => !existingIds.has(s.id),
          );

          return [...newSessions, ...filtered];
        });
      }

      setHasMore(data.hasMore);
      setStats(data.stats);
      setProjects(data.projects);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setLoading(false);
    }
  }, [projectId, searchQuery, limit, includeArchived, starred]);

  // Load more sessions (pagination)
  const loadMore = useCallback(async () => {
    if (!hasMore || sessions.length === 0) return;

    const lastSession = sessions[sessions.length - 1];
    if (!lastSession) return;

    try {
      const data = await api.getGlobalSessions({
        project: projectId ?? undefined,
        q: searchQuery || undefined,
        limit,
        after: lastSession.updatedAt,
        includeArchived,
        starred,
      });

      setSessions((prev) => {
        // Deduplicate when appending
        const existingIds = new Set(prev.map((s) => s.id));
        const newSessions = data.sessions.filter((s) => !existingIds.has(s.id));
        return [...prev, ...newSessions];
      });

      setHasMore(data.hasMore);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    }
  }, [
    hasMore,
    sessions,
    projectId,
    searchQuery,
    limit,
    includeArchived,
    starred,
  ]);

  // Debounced refetch
  const debouncedRefetch = useCallback(() => {
    if (refetchTimerRef.current) {
      clearTimeout(refetchTimerRef.current);
    }
    refetchTimerRef.current = setTimeout(() => {
      fetch();
    }, REFETCH_DEBOUNCE_MS);
  }, [fetch]);

  // Handle session status changes
  const handleSessionStatusChange = useCallback((event: SessionStatusEvent) => {
    setSessions((prev) =>
      prev.map((session) =>
        session.id === event.sessionId
          ? { ...session, status: event.status }
          : session,
      ),
    );

    // Clear process state when session goes idle
    if (event.status.state === "idle") {
      setSessions((prev) =>
        prev.map((session) =>
          session.id === event.sessionId
            ? {
                ...session,
                pendingInputType: undefined,
                processState: undefined,
              }
            : session,
        ),
      );
    }
  }, []);

  // Handle process state changes
  const handleProcessStateChange = useCallback((event: ProcessStateEvent) => {
    setSessions((prev) =>
      prev.map((session) =>
        session.id === event.sessionId
          ? { ...session, processState: event.processState }
          : session,
      ),
    );

    // When state changes to "running", clear pendingInputType
    if (event.processState === "running") {
      setSessions((prev) =>
        prev.map((session) =>
          session.id === event.sessionId
            ? { ...session, pendingInputType: undefined }
            : session,
        ),
      );
    }
  }, []);

  // Handle new session created
  const handleSessionCreated = useCallback(
    (event: SessionCreatedEvent) => {
      // If we have a project filter, only add sessions from that project
      if (projectId && event.session.projectId !== projectId) return;

      // If we have a starred filter, only add starred sessions
      if (starred && !event.session.isStarred) return;

      // If we have a search query, refetch to let server filter
      if (searchQuery) {
        debouncedRefetch();
        return;
      }

      setSessions((prev) => {
        // Check for duplicates
        if (prev.some((s) => s.id === event.session.id)) {
          return prev;
        }

        // Look up project name from loaded projects list
        const project = projectsRef.current.find(
          (p) => p.id === event.session.projectId,
        );
        const projectName = project?.name ?? event.session.projectId;

        // Convert SessionSummary to GlobalSessionItem
        const globalSession: GlobalSessionItem = {
          id: event.session.id,
          title: event.session.title,
          createdAt: event.session.createdAt,
          updatedAt: event.session.updatedAt,
          messageCount: event.session.messageCount,
          provider: event.session.provider,
          projectId: event.session.projectId,
          projectName,
          status: event.session.status,
          pendingInputType: event.session.pendingInputType,
          processState: event.session.processState,
          hasUnread: event.session.hasUnread,
          customTitle: event.session.customTitle,
          isArchived: event.session.isArchived,
          isStarred: event.session.isStarred,
        };

        return [globalSession, ...prev];
      });
    },
    [projectId, searchQuery, starred, debouncedRefetch],
  );

  // Handle session metadata changes
  const handleSessionMetadataChange = useCallback(
    (event: SessionMetadataChangedEvent) => {
      setSessions((prev) =>
        prev.map((session) => {
          if (session.id !== event.sessionId) return session;

          return {
            ...session,
            ...(event.title !== undefined && { customTitle: event.title }),
            ...(event.archived !== undefined && { isArchived: event.archived }),
            ...(event.starred !== undefined && { isStarred: event.starred }),
          };
        }),
      );
    },
    [],
  );

  // Handle session seen events
  const handleSessionSeen = useCallback((event: SessionSeenEvent) => {
    setSessions((prev) =>
      prev.map((session) => {
        if (session.id !== event.sessionId) return session;

        return {
          ...session,
          hasUnread: false,
        };
      }),
    );
  }, []);

  // Handle session content updates (auto-generated title, messageCount)
  const handleSessionUpdated = useCallback((event: SessionUpdatedEvent) => {
    setSessions((prev) =>
      prev.map((session) => {
        if (session.id !== event.sessionId) return session;

        return {
          ...session,
          ...(event.title !== undefined && { title: event.title }),
          ...(event.messageCount !== undefined && {
            messageCount: event.messageCount,
          }),
          ...(event.updatedAt !== undefined && { updatedAt: event.updatedAt }),
        };
      }),
    );
  }, []);

  // Subscribe to SSE events
  useFileActivity({
    onSessionStatusChange: handleSessionStatusChange,
    onSessionCreated: handleSessionCreated,
    onProcessStateChange: handleProcessStateChange,
    onSessionMetadataChange: handleSessionMetadataChange,
    onSessionSeen: handleSessionSeen,
    onSessionUpdated: handleSessionUpdated,
    onReconnect: fetch,
  });

  // Initial fetch and refetch when options change
  useEffect(() => {
    fetch();
  }, [fetch]);

  // Cleanup debounce timer
  useEffect(() => {
    return () => {
      if (refetchTimerRef.current) {
        clearTimeout(refetchTimerRef.current);
      }
    };
  }, []);

  return {
    sessions,
    stats,
    projects,
    loading,
    error,
    hasMore,
    loadMore,
    refetch: fetch,
  };
}
