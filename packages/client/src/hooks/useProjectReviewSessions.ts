import { useEffect, useState } from "react";
import type { GlobalSessionItem } from "../api/client";
import { useCurrentSourceRuntime } from "../contexts/SourceRuntimeContext";
import { resolveCollectionRequestMode } from "../lib/collectionRequestMode";
import { loadProjectSessions } from "../lib/reviewSessions";

export interface ProjectReviewSessions {
  /** Most-recently-active first; null until the first list arrives. */
  sessions: GlobalSessionItem[] | null;
  /** The complete list failed; retained rows, if any, remain shown. */
  error: string | null;
}

/**
 * The project sessions a source-review comment can be sent to. The complete
 * walk can take seconds on a busy host, which left "New review session" as
 * the only destination meanwhile; when the server keeps a retained catalog,
 * its rows answer first so the most recent session is offered immediately,
 * and the complete rows replace them (adding titles and models) on arrival.
 */
export function useProjectReviewSessions(
  projectId: string,
): ProjectReviewSessions {
  const { sourceKey } = useCurrentSourceRuntime();
  const [state, setState] = useState<ProjectReviewSessions>({
    sessions: null,
    error: null,
  });

  useEffect(() => {
    let cancelled = false;
    let completeArrived = false;
    setState({ sessions: null, error: null });

    loadProjectSessions(projectId)
      .then((sessions) => {
        completeArrived = true;
        if (!cancelled) setState({ sessions, error: null });
      })
      .catch((cause) => {
        if (cancelled) return;
        setState((current) => ({
          sessions: current.sessions,
          error: cause instanceof Error ? cause.message : String(cause),
        }));
      });

    resolveCollectionRequestMode(sourceKey, {
      currentSourceKey: () => sourceKey,
    })
      .then((mode) =>
        mode === "retained" ? loadProjectSessions(projectId, mode) : null,
      )
      .then((sessions) => {
        if (cancelled || completeArrived || !sessions) return;
        setState((current) =>
          current.sessions === null ? { ...current, sessions } : current,
        );
      })
      .catch(() => {
        // The retained read only speeds up the first offer; the complete
        // walk stays authoritative and reports its own failure.
      });

    return () => {
      cancelled = true;
    };
  }, [projectId, sourceKey]);

  return state;
}
