import { Link } from "react-router-dom";
import { PageHeader } from "../components/PageHeader";
import { ProviderBadge } from "../components/ProviderBadge";
import { useRecentSessions } from "../hooks/useRecentSessions";
import { useNavigationLayout } from "../layouts";

/**
 * Recents page showing recently visited sessions.
 * Sessions are tracked on the server and returned pre-enriched with titles.
 */
export function RecentsPage() {
  const { openSidebar, isWideScreen, toggleSidebar, isSidebarCollapsed } =
    useNavigationLayout();
  const { recentSessions, isLoading, error, clearRecents } =
    useRecentSessions();

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

            {isLoading && <p className="loading">Loading recent sessions...</p>}

            {error && (
              <p className="error">Error loading sessions: {error.message}</p>
            )}

            {!isLoading && !error && isEmpty && (
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

            {!isLoading && !error && !isEmpty && (
              <ul className="sessions-list recents-list">
                {recentSessions.map((entry) => (
                  <li
                    key={entry.sessionId}
                    className="session-list-item session-list-item--card"
                  >
                    <Link
                      to={`/projects/${entry.projectId}/sessions/${entry.sessionId}`}
                      className="session-list-item__link"
                    >
                      <div className="session-list-item__content">
                        <span className="session-list-item__title">
                          {entry.title ?? "Untitled session"}
                        </span>
                        <span className="session-list-item__project">
                          {entry.projectName}
                        </span>
                      </div>
                      <ProviderBadge provider={entry.provider} compact />
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}
