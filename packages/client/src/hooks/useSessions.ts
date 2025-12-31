import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api/client";
import type { Project, SessionSummary } from "../types";
import {
  type FileChangeEvent,
  type ProcessStateEvent,
  type ProcessStateType,
  type SessionCreatedEvent,
  type SessionStatusEvent,
  useFileActivity,
} from "./useFileActivity";

const REFETCH_DEBOUNCE_MS = 500;

export function useSessions(projectId: string | undefined) {
  const [project, setProject] = useState<Project | null>(null);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const refetchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Track process state (running/waiting-input) per session for activity indicators
  const [processStates, setProcessStates] = useState<
    Record<string, ProcessStateType>
  >({});

  const fetch = useCallback(async () => {
    if (!projectId) return;
    // Only show loading state on initial load, not on refetches
    setSessions((prev) => {
      if (prev.length === 0) setLoading(true);
      return prev;
    });
    setError(null);
    try {
      const data = await api.getProject(projectId);
      setProject(data.project);
      setSessions(data.sessions);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  // Debounced refetch for file change events
  const debouncedRefetch = useCallback(() => {
    if (refetchTimerRef.current) {
      clearTimeout(refetchTimerRef.current);
    }
    refetchTimerRef.current = setTimeout(() => {
      fetch();
    }, REFETCH_DEBOUNCE_MS);
  }, [fetch]);

  // Handle file change events
  const handleFileChange = useCallback(
    (event: FileChangeEvent) => {
      // Only care about session files
      if (event.fileType !== "session" && event.fileType !== "agent-session") {
        return;
      }

      // Extract session ID from the file path (e.g., "projects/xxx/session-id.jsonl" -> "session-id")
      const match = event.relativePath.match(/([^/\\]+)\.jsonl$/);
      const sessionId = match?.[1];
      if (!sessionId) return;

      // Check if this session is in our current list
      // This handles both internally managed sessions (by sessionId) and ensures
      // we refetch when any session in this project changes
      setSessions((prev) => {
        const sessionExists = prev.some((s) => s.id === sessionId);
        if (sessionExists) {
          // Trigger refetch for updates to existing sessions
          debouncedRefetch();
        }
        return prev;
      });
    },
    [debouncedRefetch],
  );

  // Handle session status changes (real-time updates without refetch)
  const handleSessionStatusChange = useCallback(
    (event: SessionStatusEvent) => {
      if (event.projectId !== projectId) return;

      setSessions((prev) =>
        prev.map((session) =>
          session.id === event.sessionId
            ? { ...session, status: event.status }
            : session,
        ),
      );

      // Clear process state when session goes idle (no longer has a process)
      if (event.status.state === "idle") {
        setProcessStates((prev) => {
          const { [event.sessionId]: _, ...rest } = prev;
          return rest;
        });
      }
    },
    [projectId],
  );

  // Handle process state changes (running/waiting-input)
  const handleProcessStateChange = useCallback(
    (event: ProcessStateEvent) => {
      if (event.projectId !== projectId) return;

      setProcessStates((prev) => ({
        ...prev,
        [event.sessionId]: event.processState,
      }));
    },
    [projectId],
  );

  // Handle new session created (instant add without refetch)
  const handleSessionCreated = useCallback(
    (event: SessionCreatedEvent) => {
      // Only care about sessions in our project
      if (event.session.projectId !== projectId) return;

      setSessions((prev) => {
        // Check for duplicates (session might already exist from race condition)
        if (prev.some((s) => s.id === event.session.id)) {
          return prev;
        }

        // Add new session at the beginning (most recent first)
        return [event.session, ...prev];
      });
    },
    [projectId],
  );

  // Subscribe to file activity, status changes, session creation, and process state
  useFileActivity({
    onFileChange: handleFileChange,
    onSessionStatusChange: handleSessionStatusChange,
    onSessionCreated: handleSessionCreated,
    onProcessStateChange: handleProcessStateChange,
  });

  // Initial fetch
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

  return { project, sessions, loading, error, refetch: fetch, processStates };
}
