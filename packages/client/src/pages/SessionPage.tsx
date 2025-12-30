import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api } from "../api/client";
import { MessageInput } from "../components/MessageInput";
import { MessageList } from "../components/MessageList";
import { StatusIndicator } from "../components/StatusIndicator";
import { ToastContainer } from "../components/Toast";
import { ToolApprovalPanel } from "../components/ToolApprovalPanel";
import { useSession } from "../hooks/useSession";
import { useToast } from "../hooks/useToast";
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
  const {
    session,
    messages,
    status,
    processState,
    pendingInputRequest,
    permissionMode,
    isModePending,
    loading,
    error,
    connected,
    setStatus,
    setProcessState,
    setPermissionMode,
    addUserMessage,
    removeOptimisticMessage,
  } = useSession(projectId, sessionId);
  const [sending, setSending] = useState(false);
  const [project, setProject] = useState<Project | null>(null);
  const [scrollTrigger, setScrollTrigger] = useState(0);
  const [restoredText, setRestoredText] = useState<string | null>(null);
  const { toasts, showToast, dismissToast } = useToast();

  // Fetch project info for breadcrumb
  useEffect(() => {
    api.getProject(projectId).then((data) => setProject(data.project));
  }, [projectId]);

  const handleSend = async (text: string) => {
    setSending(true);
    setRestoredText(null); // Clear any previously restored text
    addUserMessage(text); // Optimistic display with temp ID
    setProcessState("running"); // Optimistic: show processing indicator immediately
    setScrollTrigger((prev) => prev + 1); // Force scroll to bottom
    try {
      if (status.state === "idle") {
        // Resume the session with current permission mode
        const result = await api.resumeSession(
          projectId,
          sessionId,
          text,
          permissionMode,
        );
        // Update status to trigger SSE connection
        setStatus({ state: "owned", processId: result.processId });
      } else {
        // Queue to existing process with current permission mode
        await api.queueMessage(sessionId, text, permissionMode);
      }
    } catch (err) {
      console.error("Failed to send:", err);
      // Always restore the message and clean up on error
      removeOptimisticMessage(text);
      setRestoredText(text);
      setProcessState("idle");

      // Check if process is dead (404)
      const is404 =
        err instanceof Error &&
        (err.message.includes("404") ||
          err.message.includes("No active process"));
      if (is404) {
        setStatus({ state: "idle" });
        showToast(
          "Session process ended. Your message has been restored.",
          "error",
        );
      } else {
        const errorMsg = err instanceof Error ? err.message : "Unknown error";
        showToast(`Failed to send message: ${errorMsg}`, "error");
      }
    } finally {
      setSending(false);
    }
  };

  const handleAbort = async () => {
    if (status.state === "owned" && status.processId) {
      await api.abortProcess(status.processId);
    }
  };

  const handleApprove = useCallback(async () => {
    if (pendingInputRequest) {
      await api.respondToInput(sessionId, pendingInputRequest.id, "approve");
    }
  }, [sessionId, pendingInputRequest]);

  const handleDeny = useCallback(async () => {
    if (pendingInputRequest) {
      await api.respondToInput(sessionId, pendingInputRequest.id, "deny");
    }
  }, [sessionId, pendingInputRequest]);

  if (loading) return <div className="loading">Loading session...</div>;
  if (error) return <div className="error">Error: {error.message}</div>;

  return (
    <div className="session-page">
      <ToastContainer toasts={toasts} onDismiss={dismissToast} />
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
          processState={processState}
        />
      </header>

      {status.state === "external" && (
        <div className="external-session-warning">
          External session active - enter messages at your own risk!
        </div>
      )}

      <main className="session-messages">
        <MessageList
          messages={messages}
          isProcessing={status.state === "owned" && processState === "running"}
          scrollTrigger={scrollTrigger}
        />
      </main>

      <footer className="session-input">
        {pendingInputRequest ? (
          <ToolApprovalPanel
            request={pendingInputRequest}
            onApprove={handleApprove}
            onDeny={handleDeny}
          />
        ) : (
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
            mode={permissionMode}
            onModeChange={setPermissionMode}
            isModePending={isModePending}
            isRunning={status.state === "owned"}
            isThinking={processState === "running"}
            onStop={handleAbort}
            restoredText={restoredText}
          />
        )}
      </footer>
    </div>
  );
}
