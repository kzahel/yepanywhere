import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api } from "../api/client";
import { MessageInput } from "../components/MessageInput";
import { MessageList } from "../components/MessageList";
import { StatusIndicator } from "../components/StatusIndicator";
import { useActivityDrawer } from "../context/ActivityDrawerContext";
import { useSession } from "../hooks/useSession";
import type { Project } from "../types";

export function SessionPage() {
  const { projectId, sessionId } = useParams<{
    projectId: string;
    sessionId: string;
  }>();

  // Guard against missing params - this shouldn't happen with proper routing
  if (!projectId || !sessionId) {
    return <div className="error">Invalid session URL</div>;
  }

  return <SessionPageContent projectId={projectId} sessionId={sessionId} />;
}

function SessionPageContent({
  projectId,
  sessionId,
}: {
  projectId: string;
  sessionId: string;
}) {
  const { session, messages, status, loading, error, connected, setStatus } =
    useSession(projectId, sessionId);
  const [sending, setSending] = useState(false);
  const [project, setProject] = useState<Project | null>(null);
  const { drawerHeight } = useActivityDrawer();

  // Fetch project info for breadcrumb
  useEffect(() => {
    api.getProject(projectId).then((data) => setProject(data.project));
  }, [projectId]);

  const handleSend = async (text: string) => {
    setSending(true);
    try {
      if (status.state === "idle") {
        // Resume the session
        const result = await api.resumeSession(projectId, sessionId, text);
        // Update status to trigger SSE connection
        setStatus({ state: "owned", processId: result.processId });
      } else {
        // Queue to existing process
        await api.queueMessage(sessionId, text);
      }
    } catch (err) {
      console.error("Failed to send:", err);
    } finally {
      setSending(false);
    }
  };

  const handleAbort = async () => {
    if (status.state === "owned" && status.processId) {
      await api.abortProcess(status.processId);
    }
  };

  if (loading) return <div className="loading">Loading session...</div>;
  if (error) return <div className="error">Error: {error.message}</div>;

  return (
    <div className="session-page" style={{ paddingBottom: drawerHeight }}>
      <header className="session-header">
        <div className="session-header-left">
          <nav className="breadcrumb">
            <Link to="/projects">Projects</Link> /{" "}
            <Link to={`/projects/${projectId}`}>
              {project?.name ?? "Project"}
            </Link>{" "}
            / Session
          </nav>
          {session?.title && (
            <span className="session-title">{session.title}</span>
          )}
        </div>
        <StatusIndicator
          status={status}
          connected={connected}
          onAbort={handleAbort}
        />
      </header>

      {status.state === "external" && (
        <div className="external-session-warning">
          External session active - enter messages at your own risk!
        </div>
      )}

      <main className="session-messages">
        <MessageList messages={messages} />
      </main>

      <footer className="session-input">
        <MessageInput
          onSend={handleSend}
          disabled={sending}
          placeholder={
            status.state === "idle"
              ? "Send a message to resume..."
              : status.state === "external"
                ? "External session - send at your own risk..."
                : "Queue a message..."
          }
        />
      </footer>
    </div>
  );
}
