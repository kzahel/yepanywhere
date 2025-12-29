import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api } from "../api/client";
import { useSessions } from "../hooks/useSessions";

export function SessionsPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();
  const { project, sessions, loading, error } = useSessions(projectId);
  const [newMessage, setNewMessage] = useState("");
  const [starting, setStarting] = useState(false);

  const handleStartSession = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!projectId || !newMessage.trim()) return;

    setStarting(true);
    try {
      const { sessionId } = await api.startSession(projectId, newMessage);
      navigate(`/projects/${projectId}/sessions/${sessionId}`);
    } catch (err) {
      console.error("Failed to start session:", err);
      setStarting(false);
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

      <form onSubmit={handleStartSession} className="new-session-form">
        <input
          type="text"
          value={newMessage}
          onChange={(e) => setNewMessage(e.target.value)}
          placeholder="Start a new session..."
          disabled={starting}
        />
        <button type="submit" disabled={starting || !newMessage.trim()}>
          {starting ? "Starting..." : "Start"}
        </button>
      </form>

      <h2>Sessions</h2>
      {sessions.length === 0 ? (
        <p>No sessions yet</p>
      ) : (
        <ul className="session-list">
          {sessions.map((session) => (
            <li key={session.id}>
              <Link to={`/projects/${projectId}/sessions/${session.id}`}>
                <strong>{session.title || "Untitled"}</strong>
                <span className="meta">
                  {session.messageCount} messages · {session.status.state}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
