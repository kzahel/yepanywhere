import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api/client";
import { subscribeProjectsChanged } from "../lib/projectEvents";
import type { Project } from "../types";
import { type SessionStatusEvent, useFileActivity } from "./useFileActivity";

interface SharedProjectsState {
  projects: Project[];
  error: Error | null;
}

let sharedProjectsState: SharedProjectsState = {
  projects: [],
  error: null,
};

let sharedProjectsInflight: Promise<SharedProjectsState> | null = null;

async function fetchSharedProjects(): Promise<SharedProjectsState> {
  if (sharedProjectsInflight) {
    return sharedProjectsInflight;
  }

  sharedProjectsInflight = (async () => {
    try {
      const data = await api.getProjects();
      sharedProjectsState = {
        projects: data.projects,
        error: null,
      };
    } catch (err) {
      sharedProjectsState = {
        projects: sharedProjectsState.projects,
        error: err instanceof Error ? err : new Error(String(err)),
      };
    } finally {
      sharedProjectsInflight = null;
    }

    return sharedProjectsState;
  })();

  return sharedProjectsInflight;
}

/**
 * Fetch a single project by ID.
 */
export function useProject(projectId: string | undefined) {
  const [project, setProject] = useState<Project | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const loadedProjectIdRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (!projectId) {
      setProject(null);
      setLoading(false);
      return;
    }

    // Reset when switching projects
    if (loadedProjectIdRef.current !== projectId) {
      setLoading(true);
      setError(null);
      loadedProjectIdRef.current = projectId;
    }

    let cancelled = false;

    api
      .getProject(projectId)
      .then((data) => {
        if (!cancelled) {
          setProject(data.project);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err : new Error(String(err)));
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [projectId]);

  return useMemo(
    () => ({ project, loading, error }),
    [project, loading, error],
  );
}

const REFETCH_DEBOUNCE_MS = 500;

export function useProjects(enabled = true) {
  const [projects, setProjects] = useState<Project[]>(
    sharedProjectsState.projects,
  );
  const [loading, setLoading] = useState(
    enabled && sharedProjectsState.projects.length === 0,
  );
  const [error, setError] = useState<Error | null>(sharedProjectsState.error);
  const refetchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hasFetchedRef = useRef(false);
  const hasResolvedInitialFetchRef = useRef(
    sharedProjectsState.projects.length > 0,
  );

  const fetch = useCallback(async () => {
    if (!enabled) {
      setProjects(sharedProjectsState.projects);
      setError(sharedProjectsState.error);
      setLoading(false);
      return;
    }

    // Preserve existing UI during background refetches triggered by activity
    // events so pages don't bounce back to their initial loading state.
    setLoading(!hasResolvedInitialFetchRef.current);
    setError(null);
    const nextState = await fetchSharedProjects();
    setProjects(nextState.projects);
    setError(nextState.error);
    hasResolvedInitialFetchRef.current = true;
    setLoading(false);
  }, [enabled]);

  // Initial fetch - only once (avoid StrictMode double-fetch)
  useEffect(() => {
    if (!enabled) return;
    if (hasFetchedRef.current) return;
    hasFetchedRef.current = true;
    fetch();
  }, [enabled, fetch]);

  // Debounced refetch for status change events
  const debouncedRefetch = useCallback(() => {
    if (refetchTimerRef.current) {
      clearTimeout(refetchTimerRef.current);
    }
    refetchTimerRef.current = setTimeout(() => {
      fetch();
    }, REFETCH_DEBOUNCE_MS);
  }, [fetch]);

  // Handle session status changes - refetch to update active counts
  const handleSessionStatusChange = useCallback(
    (_event: SessionStatusEvent) => {
      debouncedRefetch();
    },
    [debouncedRefetch],
  );

  // Subscribe to session status changes
  useFileActivity(
    enabled
      ? {
          onSessionStatusChange: handleSessionStatusChange,
        }
      : {},
  );

  useEffect(() => {
    if (!enabled) return;
    return subscribeProjectsChanged(() => {
      void fetch();
    });
  }, [enabled, fetch]);

  // Cleanup debounce timer
  useEffect(() => {
    return () => {
      if (refetchTimerRef.current) {
        clearTimeout(refetchTimerRef.current);
      }
    };
  }, []);

  return { projects, loading, error, refetch: fetch };
}
