import { type KeyboardEvent, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api } from "../api/client";
import { ContextUsageIndicator } from "../components/ContextUsageIndicator";
import { SessionStatusBadge } from "../components/StatusBadge";
import { ENTER_SENDS_MESSAGE } from "../constants";
import { useDraftPersistence } from "../hooks/useDraftPersistence";
import { useSessions } from "../hooks/useSessions";

function formatRelativeTime(timestamp: string): string {
  const now = Date.now();
  const then = new Date(timestamp).getTime();
  const diffMs = now - then;
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return "just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return new Date(timestamp).toLocaleDateString();
}

export function SessionsPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();
  const { project, sessions, loading, error, processStates } =
    useSessions(projectId);
  const [newMessage, setNewMessage, draftControls] = useDraftPersistence(
    `draft-new-session-${projectId}`,
  );
  const [starting, setStarting] = useState(false);

  // Filter state: "all" shows non-archived, "starred" shows only starred, "archived" shows only archived
  type FilterMode = "all" | "starred" | "archived";
  const [searchQuery, setSearchQuery] = useState("");
  const [filterMode, setFilterMode] = useState<FilterMode>("all");

  // Filter sessions based on search and filter mode
  const filteredSessions = useMemo(() => {
    return sessions.filter((session) => {
      // Filter by mode
      switch (filterMode) {
        case "all":
          // Show non-archived sessions
          if (session.isArchived) return false;
          break;
        case "starred":
          // Show only starred sessions (including archived starred ones)
          if (!session.isStarred) return false;
          break;
        case "archived":
          // Show only archived sessions
          if (!session.isArchived) return false;
          break;
      }

      // Filter by search query
      if (searchQuery.trim()) {
        const query = searchQuery.toLowerCase();
        const title = (
          session.customTitle ??
          session.title ??
          ""
        ).toLowerCase();
        const fullTitle = (session.fullTitle ?? "").toLowerCase();
        if (!title.includes(query) && !fullTitle.includes(query)) {
          return false;
        }
      }

      return true;
    });
  }, [sessions, searchQuery, filterMode]);

  // Count starred and archived sessions for badges
  const starredCount = useMemo(
    () => sessions.filter((s) => s.isStarred).length,
    [sessions],
  );
  const archivedCount = useMemo(
    () => sessions.filter((s) => s.isArchived).length,
    [sessions],
  );

  const handleStartSession = async () => {
    if (!projectId || !newMessage.trim()) return;

    const message = newMessage.trim();
    setStarting(true);
    draftControls.clearInput(); // Clear input but keep localStorage
    try {
      const { sessionId } = await api.startSession(projectId, message);
      draftControls.clearDraft(); // Success - clear localStorage
      navigate(`/projects/${projectId}/sessions/${sessionId}`);
    } catch (err) {
      console.error("Failed to start session:", err);
      draftControls.restoreFromStorage(); // Restore on failure
      setStarting(false);
    }
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter") {
      if (ENTER_SENDS_MESSAGE) {
        if (e.ctrlKey || e.shiftKey) {
          return;
        }
        e.preventDefault();
        handleStartSession();
      } else {
        if (e.ctrlKey || e.shiftKey) {
          e.preventDefault();
          handleStartSession();
        }
      }
    }
  };

  if (loading) return <div className="loading">Loading sessions...</div>;
  if (error) return <div className="error">Error: {error.message}</div>;

  return (
    <div className="page">
      <nav className="breadcrumb">
        <Link to="/projects">Projects</Link> / {project?.name}
      </nav>

      <div className="page-header">
        <h1>{project?.name}</h1>
        <Link to="/settings" className="settings-link" aria-label="Settings">
          <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        </Link>
      </div>

      <div className="new-session-form">
        <textarea
          value={newMessage}
          onChange={(e) => setNewMessage(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Start a new session..."
          disabled={starting}
          rows={3}
        />
        <button
          type="button"
          onClick={handleStartSession}
          disabled={starting || !newMessage.trim()}
          className="send-button"
          aria-label="Start session"
        >
          <span className="send-icon">{starting ? "..." : "↑"}</span>
        </button>
      </div>

      <h2>Sessions</h2>

      {/* Filter bar */}
      <div className="filter-bar">
        <input
          type="text"
          className="filter-search"
          placeholder="Search sessions..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
        />
        <div className="filter-chips">
          <button
            type="button"
            className={`filter-chip ${filterMode === "all" ? "active" : ""}`}
            onClick={() => setFilterMode("all")}
          >
            All
          </button>
          <button
            type="button"
            className={`filter-chip ${filterMode === "starred" ? "active" : ""}`}
            onClick={() => setFilterMode("starred")}
          >
            Starred{starredCount > 0 && ` (${starredCount})`}
          </button>
          <button
            type="button"
            className={`filter-chip ${filterMode === "archived" ? "active" : ""}`}
            onClick={() => setFilterMode("archived")}
          >
            Archived{archivedCount > 0 && ` (${archivedCount})`}
          </button>
        </div>
      </div>

      {sessions.length === 0 ? (
        <p>No sessions yet</p>
      ) : filteredSessions.length === 0 ? (
        <p className="no-results">No sessions match your filters</p>
      ) : (
        <ul className="session-list">
          {filteredSessions.map((session) => (
            <li
              key={session.id}
              className={session.isArchived ? "archived" : ""}
            >
              <Link to={`/projects/${projectId}/sessions/${session.id}`}>
                <strong title={session.fullTitle || undefined}>
                  {session.isStarred && (
                    <span className="star-indicator" aria-label="Starred">
                      <svg
                        width="12"
                        height="12"
                        viewBox="0 0 24 24"
                        fill="currentColor"
                        stroke="currentColor"
                        strokeWidth="2"
                        aria-hidden="true"
                      >
                        <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
                      </svg>
                    </span>
                  )}
                  {session.customTitle ?? session.title ?? "Untitled"}
                  {session.isArchived && (
                    <span className="archived-badge">Archived</span>
                  )}
                </strong>
                <span className="meta">
                  {formatRelativeTime(session.updatedAt)}
                  <ContextUsageIndicator
                    usage={session.contextUsage}
                    size={14}
                  />
                  <SessionStatusBadge
                    status={session.status}
                    pendingInputType={session.pendingInputType}
                    hasUnread={session.hasUnread}
                    processState={
                      processStates[session.id] ?? session.processState
                    }
                  />
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
