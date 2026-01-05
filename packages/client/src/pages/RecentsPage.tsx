import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api/client";
import { PageHeader } from "../components/PageHeader";
import { ThinkingIndicator } from "../components/ThinkingIndicator";
import {
  type RecentSessionEntry,
  useRecentSessions,
} from "../hooks/useRecentSessions";
import { useNavigationLayout } from "../layouts";
import type { Project, SessionSummary } from "../types";
import { getSessionDisplayTitle } from "../types";

/**
 * Format relative time from a timestamp to now.
 */
function formatRelativeTime(timestamp: string | number): string {
  const now = Date.now();
  const then =
    typeof timestamp === "number" ? timestamp : new Date(timestamp).getTime();
  const diffMs = now - then;
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return "just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return new Date(then).toLocaleDateString();
}

interface RecentItemData {
  entry: RecentSessionEntry;
  session: SessionSummary | null;
  project: Project | null;
}

/**
 * Recents page showing recently visited sessions.
 * Sessions are tracked in localStorage and displayed with project context.
 */
export function RecentsPage() {
  const { openSidebar, isWideScreen, toggleSidebar, isSidebarCollapsed } =
    useNavigationLayout();
  const { recentSessions, clearRecents } = useRecentSessions();

  // Fetch projects to get session data
  const [projects, setProjects] = useState<Map<string, Project>>(new Map());
  const [sessions, setSessions] = useState<Map<string, SessionSummary>>(
    new Map(),
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  // Get unique project IDs from recent sessions
  const projectIds = useMemo(() => {
    const ids = new Set<string>();
    for (const entry of recentSessions) {
      ids.add(entry.projectId);
    }
    return Array.from(ids);
  }, [recentSessions]);

  // Fetch project data for all projects containing recent sessions
  useEffect(() => {
    if (projectIds.length === 0) {
      setLoading(false);
      return;
    }

    let cancelled = false;

    async function fetchData() {
      setLoading(true);
      setError(null);

      try {
        const results = await Promise.all(
          projectIds.map((id) => api.getProject(id).catch(() => null)),
        );

        if (cancelled) return;

        const projectMap = new Map<string, Project>();
        const sessionMap = new Map<string, SessionSummary>();

        for (const result of results) {
          if (result) {
            projectMap.set(result.project.id, result.project);
            for (const session of result.sessions) {
              sessionMap.set(session.id, session);
            }
          }
        }

        setProjects(projectMap);
        setSessions(sessionMap);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err : new Error("Failed to load"));
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    fetchData();

    return () => {
      cancelled = true;
    };
  }, [projectIds]);

  // Build display data for each recent session
  const recentItems: RecentItemData[] = useMemo(() => {
    return recentSessions.map((entry) => ({
      entry,
      session: sessions.get(entry.sessionId) ?? null,
      project: projects.get(entry.projectId) ?? null,
    }));
  }, [recentSessions, sessions, projects]);

  const isEmpty = recentSessions.length === 0;

  return (
    <div
      className={isWideScreen ? "main-content-wrapper" : "main-content-mobile"}
    >
      <div
        className={
          isWideScreen
            ? "main-content-constrained"
            : "main-content-mobile-inner"
        }
      >
        <PageHeader
          title="Recent Sessions"
          onOpenSidebar={openSidebar}
          onToggleSidebar={toggleSidebar}
          isWideScreen={isWideScreen}
          isSidebarCollapsed={isSidebarCollapsed}
        />

        <main className="page-scroll-container">
          <div className="page-content-inner">
            {/* Toolbar with clear button */}
            {!isEmpty && (
              <div className="inbox-toolbar">
                <button
                  type="button"
                  className="inbox-refresh-button"
                  onClick={clearRecents}
                  title="Clear recent sessions"
                >
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <path d="M3 6h18" />
                    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
                    <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                  </svg>
                  Clear History
                </button>
              </div>
            )}

            {loading && <p className="loading">Loading recent sessions...</p>}

            {error && (
              <p className="error">Error loading sessions: {error.message}</p>
            )}

            {!loading && !error && isEmpty && (
              <div className="inbox-empty">
                <svg
                  width="48"
                  height="48"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <circle cx="12" cy="12" r="10" />
                  <polyline points="12 6 12 12 16 14" />
                </svg>
                <h3>No recent sessions</h3>
                <p>Sessions you visit will appear here.</p>
              </div>
            )}

            {!loading && !error && !isEmpty && (
              <ul className="inbox-list recents-list">
                {recentItems.map((item) => {
                  const title = item.session
                    ? getSessionDisplayTitle(item.session)
                    : "Unknown session";
                  const projectName = item.project?.name ?? "Unknown project";
                  const isActive =
                    item.session?.status.state === "owned" ||
                    item.session?.processState === "running";
                  const hasUnread = item.session?.hasUnread ?? false;

                  return (
                    <li
                      key={item.entry.sessionId}
                      className={hasUnread ? "unread" : undefined}
                    >
                      <Link
                        to={`/projects/${item.entry.projectId}/sessions/${item.entry.sessionId}`}
                      >
                        <div className="inbox-item-main">
                          <span className="inbox-item-title">{title}</span>
                          {isActive && <ThinkingIndicator />}
                        </div>
                        <div className="inbox-item-meta">
                          <span className="inbox-item-project">
                            {projectName}
                          </span>
                          <span className="inbox-item-time">
                            {formatRelativeTime(item.entry.visitedAt)}
                          </span>
                        </div>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}
