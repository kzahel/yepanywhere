import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api } from "../api/client";
import { MessageInput } from "../components/MessageInput";
import { MessageList } from "../components/MessageList";
import { StatusIndicator } from "../components/StatusIndicator";
import { useSession } from "../hooks/useSession";

export function ChatPage() {
  const { projectId, sessionId } = useParams<{
    projectId: string;
    sessionId: string;
  }>();

  // Guard against missing params - this shouldn't happen with proper routing
  if (!projectId || !sessionId) {
    return <div className="error">Invalid session URL</div>;
  }

  return <ChatPageContent projectId={projectId} sessionId={sessionId} />;
}

function ChatPageContent({
  projectId,
  sessionId,
}: {
  projectId: string;
  sessionId: string;
}) {
  const { messages, status, loading, error, connected } = useSession(
    projectId,
    sessionId,
  );
  const [sending, setSending] = useState(false);

  const handleSend = async (text: string) => {
    setSending(true);
    try {
      if (status.state === "idle") {
        // Resume the session
        await api.resumeSession(projectId, sessionId, text);
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
    <div className="chat-page">
      <header className="chat-header">
        <nav className="breadcrumb">
          <Link to="/projects">Projects</Link> /{" "}
          <Link to={`/projects/${projectId}`}>Project</Link> / Session
        </nav>
        <StatusIndicator
          status={status}
          connected={connected}
          onAbort={handleAbort}
        />
      </header>

      <main className="chat-messages">
        <MessageList messages={messages} />
      </main>

      <footer className="chat-input">
        <MessageInput
          onSend={handleSend}
          disabled={sending}
          placeholder={
            status.state === "idle"
              ? "Send a message to resume..."
              : "Queue a message..."
          }
        />
      </footer>
    </div>
  );
}
