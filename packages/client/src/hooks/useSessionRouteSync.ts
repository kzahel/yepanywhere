import { useEffect } from "react";
import type { NavigateFunction } from "react-router-dom";
import { nativeSessionViewerUrl } from "../lib/sessionViewerUrl";
import { recordSessionVisit } from "./useRecentSessions";
import type { useSession } from "./useSession";

/**
 * Keeps one session page's address in step with the session: records the
 * visit for recents, and replaces the URL when a temporary id gets its real
 * id, when the session has a native-id viewer URL, and when the API followed
 * a redirect to the session's canonical project. Each replace keeps the
 * history state. Moved verbatim from `SessionPage.tsx`
 * (docs/tactical/181-session-page-feature-hooks.md slice 6).
 */
export function useSessionRouteSync({
  sessionId,
  projectId,
  actualSessionId,
  session,
  location,
  navigate,
  basePath,
  isDomLingerParked,
}: {
  sessionId: string;
  projectId: string;
  actualSessionId: string;
  session: ReturnType<typeof useSession>["session"];
  location: {
    pathname: string;
    search: string;
    hash?: string;
    state: unknown;
  };
  navigate: NavigateFunction;
  basePath: string;
  isDomLingerParked: boolean;
}) {
  // Record session visit for recents tracking. Opening a session is not a
  // sidebar interaction: only composer submissions move a row, so reading a
  // session leaves its chronology alone.
  useEffect(() => {
    if (isDomLingerParked) return;
    recordSessionVisit(sessionId, projectId);
  }, [sessionId, projectId, isDomLingerParked]);

  // Navigate to new session ID when temp ID is replaced with real SDK session ID
  // This ensures the URL stays in sync with the actual session
  useEffect(() => {
    if (isDomLingerParked) {
      return;
    }
    if (actualSessionId && actualSessionId !== sessionId) {
      // Use replace to avoid creating a history entry for the temp ID
      navigate(
        `${basePath}/projects/${projectId}/sessions/${actualSessionId}`,
        {
          replace: true,
          state: location.state, // Preserve initial state for seamless transition
        },
      );
    }
  }, [
    actualSessionId,
    sessionId,
    projectId,
    navigate,
    location.state,
    basePath,
    isDomLingerParked,
  ]);

  useEffect(() => {
    if (isDomLingerParked || !session?.nativeSessionId) return;
    const target = nativeSessionViewerUrl(
      location.pathname,
      location.search,
      location.hash ?? "",
      actualSessionId,
      session.nativeSessionId,
      session.nativeSessionFamily,
    );
    if (target) navigate(target, { replace: true, state: location.state });
  }, [
    actualSessionId,
    session?.nativeSessionId,
    session?.nativeSessionFamily,
    isDomLingerParked,
    navigate,
    location.pathname,
    location.search,
    location.hash,
    location.state,
  ]);

  // Navigate to the session reader canonical project when the API followed
  // a provider-native redirect from a stale project-scoped link.
  useEffect(() => {
    if (isDomLingerParked) {
      return;
    }
    const canonicalProjectId = session?.projectId;
    if (!canonicalProjectId || canonicalProjectId === projectId) {
      return;
    }

    navigate(
      `${basePath}/projects/${canonicalProjectId}/sessions/${actualSessionId}${location.search}`,
      {
        replace: true,
        state: location.state,
      },
    );
  }, [
    actualSessionId,
    basePath,
    location.search,
    location.state,
    navigate,
    projectId,
    isDomLingerParked,
    session?.projectId,
  ]);
}
