import { type KeyboardEvent, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api } from "../api/client";
import { SessionStatusBadge } from "../components/StatusBadge";
import { ENTER_SENDS_MESSAGE } from "../constants";
import { useDraftPersistence } from "../hooks/useDraftPersistence";
import { useSessions } from "../hooks/useSessions";

export function SessionsPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();
  const { project, sessions, loading, error } = useSessions(projectId);
  const [newMessage, setNewMessage, draftControls] = useDraftPersistence(
    `draft-new-session-${projectId}`,
  );
  const [starting, setStarting] = useState(false);

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

      <h1>{project?.name}</h1>

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
      {sessions.length === 0 ? (
        <p>No sessions yet</p>
      ) : (
        <ul className="session-list">
          {sessions.map((session) => (
            <li key={session.id}>
              <Link to={`/projects/${projectId}/sessions/${session.id}`}>
                <strong title={session.fullTitle || undefined}>
                  {session.title || "Untitled"}
                </strong>
                <span className="meta">
                  {session.messageCount} messages
                  <SessionStatusBadge
                    status={session.status}
                    pendingInputType={session.pendingInputType}
                    hasUnread={session.hasUnread}
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
