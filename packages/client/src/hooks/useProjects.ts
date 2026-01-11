import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api/client";
import type { Project } from "../types";
import { type SessionStatusEvent, useFileActivity } from "./useFileActivity";

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

export function useProjects() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const refetchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hasFetchedRef = useRef(false);

  const fetch = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.getProjects();
      setProjects(data.projects);
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
    fetch();
  }, [fetch]);

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
  useFileActivity({
    onSessionStatusChange: handleSessionStatusChange,
  });

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
