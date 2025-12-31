import type { UploadedFile } from "@claude-anywhere/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, uploadFile } from "../api/client";
import { MessageInput, type UploadProgress } from "../components/MessageInput";
import { MessageList } from "../components/MessageList";
import { QuestionAnswerPanel } from "../components/QuestionAnswerPanel";
import { StatusIndicator } from "../components/StatusIndicator";
import { ToastContainer } from "../components/Toast";
import { ToolApprovalPanel } from "../components/ToolApprovalPanel";
import { Modal } from "../components/ui/Modal";
import type { DraftControls } from "../hooks/useDraftPersistence";
import { useEngagementTracking } from "../hooks/useEngagementTracking";
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
  const draftControlsRef = useRef<DraftControls | null>(null);
  const handleDraftControlsReady = useCallback((controls: DraftControls) => {
    draftControlsRef.current = controls;
  }, []);
  const { toasts, showToast, dismissToast } = useToast();

  // Rename modal state
  const [showRenameModal, setShowRenameModal] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [isRenaming, setIsRenaming] = useState(false);
  const renameInputRef = useRef<HTMLInputElement>(null);

  // Local metadata state (for optimistic updates)
  const [localCustomTitle, setLocalCustomTitle] = useState<string | undefined>(
    undefined,
  );
  const [localIsArchived, setLocalIsArchived] = useState<boolean | undefined>(
    undefined,
  );
  const [localIsStarred, setLocalIsStarred] = useState<boolean | undefined>(
    undefined,
  );

  // File attachment state
  const [attachments, setAttachments] = useState<UploadedFile[]>([]);
  const [uploadProgress, setUploadProgress] = useState<UploadProgress[]>([]);

  // Track user engagement to mark session as "seen"
  // Only enabled when not in external session (we own or it's idle)
  useEngagementTracking({
    sessionId,
    updatedAt: session?.updatedAt ?? null,
    lastSeenAt: session?.lastSeenAt,
    enabled: status.state !== "external",
  });

  // Fetch project info for breadcrumb
  useEffect(() => {
    api.getProject(projectId).then((data) => setProject(data.project));
  }, [projectId]);

  const handleSend = async (text: string) => {
    setSending(true);
    addUserMessage(text); // Optimistic display with temp ID
    setProcessState("running"); // Optimistic: show processing indicator immediately
    setScrollTrigger((prev) => prev + 1); // Force scroll to bottom

    // Capture current attachments and clear optimistically
    const currentAttachments = [...attachments];
    setAttachments([]);

    try {
      if (status.state === "idle") {
        // Resume the session with current permission mode
        const result = await api.resumeSession(
          projectId,
          sessionId,
          text,
          permissionMode,
          currentAttachments.length > 0 ? currentAttachments : undefined,
        );
        // Update status to trigger SSE connection
        setStatus({ state: "owned", processId: result.processId });
      } else {
        // Queue to existing process with current permission mode
        await api.queueMessage(
          sessionId,
          text,
          permissionMode,
          currentAttachments.length > 0 ? currentAttachments : undefined,
        );
      }
      // Success - clear the draft from localStorage
      draftControlsRef.current?.clearDraft();
    } catch (err) {
      console.error("Failed to send:", err);
      // Restore the message from localStorage and clean up
      removeOptimisticMessage(text);
      draftControlsRef.current?.restoreFromStorage();
      setAttachments(currentAttachments); // Restore attachments on error
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

  const handleApproveAcceptEdits = useCallback(async () => {
    if (pendingInputRequest) {
      // Approve and switch to acceptEdits mode
      await api.respondToInput(
        sessionId,
        pendingInputRequest.id,
        "approve_accept_edits",
      );
      // Update local permission mode
      setPermissionMode("acceptEdits");
    }
  }, [sessionId, pendingInputRequest, setPermissionMode]);

  const handleDeny = useCallback(async () => {
    if (pendingInputRequest) {
      await api.respondToInput(sessionId, pendingInputRequest.id, "deny");
    }
  }, [sessionId, pendingInputRequest]);

  const handleDenyWithFeedback = useCallback(
    async (feedback: string) => {
      if (pendingInputRequest) {
        await api.respondToInput(
          sessionId,
          pendingInputRequest.id,
          "deny",
          undefined,
          feedback,
        );
      }
    },
    [sessionId, pendingInputRequest],
  );

  const handleQuestionSubmit = useCallback(
    async (answers: Record<string, string>) => {
      if (pendingInputRequest) {
        await api.respondToInput(
          sessionId,
          pendingInputRequest.id,
          "approve",
          answers,
        );
      }
    },
    [sessionId, pendingInputRequest],
  );

  // Handle file attachment uploads
  const handleAttach = useCallback(
    async (files: File[]) => {
      for (const file of files) {
        const tempId = crypto.randomUUID();

        // Add to progress tracking
        setUploadProgress((prev) => [
          ...prev,
          {
            fileId: tempId,
            fileName: file.name,
            bytesUploaded: 0,
            totalBytes: file.size,
            percent: 0,
          },
        ]);

        try {
          const uploaded = await uploadFile(projectId, sessionId, file, {
            onProgress: (bytesUploaded) => {
              setUploadProgress((prev) =>
                prev.map((p) =>
                  p.fileId === tempId
                    ? {
                        ...p,
                        bytesUploaded,
                        percent: Math.round((bytesUploaded / file.size) * 100),
                      }
                    : p,
                ),
              );
            },
          });

          // Add completed file to attachments
          setAttachments((prev) => [...prev, uploaded]);
        } catch (err) {
          console.error("Upload failed:", err);
          const errorMsg = err instanceof Error ? err.message : "Upload failed";
          showToast(`Failed to upload ${file.name}: ${errorMsg}`, "error");
        } finally {
          // Remove from progress tracking
          setUploadProgress((prev) => prev.filter((p) => p.fileId !== tempId));
        }
      }
    },
    [projectId, sessionId, showToast],
  );

  const handleRemoveAttachment = useCallback((id: string) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id));
  }, []);

  // Check if pending request is an AskUserQuestion
  const isAskUserQuestion = pendingInputRequest?.toolName === "AskUserQuestion";

  // Compute display title (prioritize local > server customTitle > auto title)
  const displayTitle =
    localCustomTitle ?? session?.customTitle ?? session?.title;
  const isArchived = localIsArchived ?? session?.isArchived ?? false;
  const isStarred = localIsStarred ?? session?.isStarred ?? false;

  const handleOpenRename = () => {
    setRenameValue(displayTitle ?? "");
    setShowRenameModal(true);
    // Focus the input after modal opens
    setTimeout(() => renameInputRef.current?.focus(), 0);
  };

  const handleRename = async () => {
    if (!renameValue.trim()) return;
    setIsRenaming(true);
    try {
      await api.updateSessionMetadata(sessionId, { title: renameValue.trim() });
      setLocalCustomTitle(renameValue.trim());
      setShowRenameModal(false);
      showToast("Session renamed", "success");
    } catch (err) {
      console.error("Failed to rename session:", err);
      showToast("Failed to rename session", "error");
    } finally {
      setIsRenaming(false);
    }
  };

  const handleToggleArchive = async () => {
    const newArchived = !isArchived;
    try {
      await api.updateSessionMetadata(sessionId, { archived: newArchived });
      setLocalIsArchived(newArchived);
      showToast(
        newArchived ? "Session archived" : "Session unarchived",
        "success",
      );
    } catch (err) {
      console.error("Failed to update archive status:", err);
      showToast("Failed to update archive status", "error");
    }
  };

  const handleToggleStar = async () => {
    const newStarred = !isStarred;
    try {
      await api.updateSessionMetadata(sessionId, { starred: newStarred });
      setLocalIsStarred(newStarred);
      showToast(
        newStarred ? "Session starred" : "Session unstarred",
        "success",
      );
    } catch (err) {
      console.error("Failed to update star status:", err);
      showToast("Failed to update star status", "error");
    }
  };

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
          <div className="session-title-row">
            {displayTitle && (
              <span
                className="session-title"
                title={session?.fullTitle ?? undefined}
              >
                {displayTitle}
              </span>
            )}
            <button
              type="button"
              className={`session-action-btn star-btn ${isStarred ? "active" : ""}`}
              onClick={handleToggleStar}
              title={isStarred ? "Unstar session" : "Star session"}
              aria-label={isStarred ? "Unstar session" : "Star session"}
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill={isStarred ? "currentColor" : "none"}
                stroke="currentColor"
                strokeWidth="2"
                aria-hidden="true"
              >
                <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
              </svg>
            </button>
            <button
              type="button"
              className="session-action-btn"
              onClick={handleOpenRename}
              title="Rename session"
              aria-label="Rename session"
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                aria-hidden="true"
              >
                <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
              </svg>
            </button>
            <button
              type="button"
              className={`session-action-btn ${isArchived ? "active" : ""}`}
              onClick={handleToggleArchive}
              title={isArchived ? "Unarchive session" : "Archive session"}
              aria-label={isArchived ? "Unarchive session" : "Archive session"}
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                aria-hidden="true"
              >
                <polyline points="21 8 21 21 3 21 3 8" />
                <rect x="1" y="3" width="22" height="5" />
                <line x1="10" y1="12" x2="14" y2="12" />
              </svg>
            </button>
            {isArchived && <span className="archived-badge">Archived</span>}
          </div>
        </div>
        <StatusIndicator
          status={status}
          connected={connected}
          processState={processState}
        />
      </header>

      {showRenameModal && (
        <Modal title="Rename Session" onClose={() => setShowRenameModal(false)}>
          <div className="rename-modal-content">
            <input
              ref={renameInputRef}
              type="text"
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              placeholder="Enter session title..."
              className="rename-input"
              onKeyDown={(e) => {
                if (e.key === "Enter" && !isRenaming) {
                  handleRename();
                }
              }}
            />
            <div className="rename-modal-actions">
              <button
                type="button"
                onClick={() => setShowRenameModal(false)}
                className="btn-secondary"
                disabled={isRenaming}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleRename}
                className="btn-primary"
                disabled={isRenaming || !renameValue.trim()}
              >
                {isRenaming ? "Saving..." : "Save"}
              </button>
            </div>
          </div>
        </Modal>
      )}

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
        {pendingInputRequest && isAskUserQuestion && (
          <QuestionAnswerPanel
            request={pendingInputRequest}
            onSubmit={handleQuestionSubmit}
            onDeny={handleDeny}
          />
        )}
        {pendingInputRequest && !isAskUserQuestion && (
          <ToolApprovalPanel
            request={pendingInputRequest}
            onApprove={handleApprove}
            onDeny={handleDeny}
            onApproveAcceptEdits={handleApproveAcceptEdits}
            onDenyWithFeedback={handleDenyWithFeedback}
          />
        )}
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
          draftKey={`draft-message-${sessionId}`}
          onDraftControlsReady={handleDraftControlsReady}
          collapsed={!!pendingInputRequest}
          contextUsage={session?.contextUsage}
          projectId={projectId}
          sessionId={sessionId}
          attachments={attachments}
          onAttach={handleAttach}
          onRemoveAttachment={handleRemoveAttachment}
          uploadProgress={uploadProgress}
        />
      </footer>
    </div>
  );
}
