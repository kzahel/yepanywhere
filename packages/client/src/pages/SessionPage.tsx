import type { UploadedFile } from "@claude-anywhere/shared";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { api, uploadFile } from "../api/client";
import { MessageInput, type UploadProgress } from "../components/MessageInput";
import { MessageList } from "../components/MessageList";
import { QuestionAnswerPanel } from "../components/QuestionAnswerPanel";
import { StatusIndicator } from "../components/StatusIndicator";
import { ToastContainer } from "../components/Toast";
import { ToolApprovalPanel } from "../components/ToolApprovalPanel";
import type { DraftControls } from "../hooks/useDraftPersistence";
import { useEngagementTracking } from "../hooks/useEngagementTracking";
import { getModelSetting, getThinkingSetting } from "../hooks/useModelSettings";
import { useSession } from "../hooks/useSession";
import { useToast } from "../hooks/useToast";
import { useProjectLayout } from "../layouts";
import { preprocessMessages } from "../lib/preprocessMessages";
import { getSessionDisplayTitle } from "../types";

export function SessionPage() {
  const { projectId, sessionId } = useParams<{
    projectId: string;
    sessionId: string;
  }>();

  // Guard against missing params - this shouldn't happen with proper routing
  if (!projectId || !sessionId) {
    return <div className="error">Invalid session URL</div>;
  }

  // Key ensures component remounts on session change, resetting all state
  return (
    <SessionPageContent
      key={sessionId}
      projectId={projectId}
      sessionId={sessionId}
    />
  );
}

function SessionPageContent({
  projectId,
  sessionId,
}: {
  projectId: string;
  sessionId: string;
}) {
  const { openSidebar, isWideScreen, toggleSidebar, isSidebarCollapsed } =
    useProjectLayout();
  const navigate = useNavigate();
  const location = useLocation();
  // Get initial status from navigation state (passed by NewSessionPage)
  // This allows SSE to connect immediately without waiting for getSession
  const initialStatus = (
    location.state as { initialStatus?: { state: "owned"; processId: string } }
  )?.initialStatus;
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
  } = useSession(projectId, sessionId, initialStatus);
  const [sending, setSending] = useState(false);
  const [scrollTrigger, setScrollTrigger] = useState(0);
  const draftControlsRef = useRef<DraftControls | null>(null);
  const handleDraftControlsReady = useCallback((controls: DraftControls) => {
    draftControlsRef.current = controls;
  }, []);
  const { toasts, showToast, dismissToast } = useToast();

  // Inline title editing state
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [isRenaming, setIsRenaming] = useState(false);
  const renameInputRef = useRef<HTMLInputElement>(null);

  // Session menu dropdown state
  const [showSessionMenu, setShowSessionMenu] = useState(false);
  const sessionMenuRef = useRef<HTMLDivElement>(null);

  // Local metadata state (for optimistic updates)
  // Reset when session changes to avoid showing stale data from previous session
  const [localCustomTitle, setLocalCustomTitle] = useState<string | undefined>(
    undefined,
  );
  const [localIsArchived, setLocalIsArchived] = useState<boolean | undefined>(
    undefined,
  );
  const [localIsStarred, setLocalIsStarred] = useState<boolean | undefined>(
    undefined,
  );

  // Reset local metadata state when sessionId changes
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentionally reset on sessionId change
  useEffect(() => {
    setLocalCustomTitle(undefined);
    setLocalIsArchived(undefined);
    setLocalIsStarred(undefined);
  }, [sessionId]);

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

  // Close session menu when clicking outside
  useEffect(() => {
    if (!showSessionMenu) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (
        sessionMenuRef.current &&
        !sessionMenuRef.current.contains(e.target as Node)
      ) {
        setShowSessionMenu(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [showSessionMenu]);

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
        // Resume the session with current permission mode and model settings
        const model = getModelSetting();
        const thinking = getThinkingSetting();
        const result = await api.resumeSession(
          projectId,
          sessionId,
          text,
          { mode: permissionMode, model, thinking },
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

  // Detect if session has pending tool calls without results
  // This can happen when the session is idle but was active in another process (VS Code, CLI)
  // that is waiting for user input (tool approval, question answer)
  const hasPendingToolCalls = useMemo(() => {
    if (status.state !== "idle") return false;
    const items = preprocessMessages(messages);
    return items.some(
      (item) => item.type === "tool_call" && item.status === "pending",
    );
  }, [messages, status.state]);

  // Compute display title - use local override if set, otherwise use utility
  const displayTitle = localCustomTitle ?? getSessionDisplayTitle(session);
  const isArchived = localIsArchived ?? session?.isArchived ?? false;
  const isStarred = localIsStarred ?? session?.isStarred ?? false;

  const handleStartEditingTitle = () => {
    setRenameValue(displayTitle);
    setIsEditingTitle(true);
    // Focus the input and select all text after it renders
    setTimeout(() => {
      renameInputRef.current?.focus();
      renameInputRef.current?.select();
    }, 0);
  };

  const handleCancelEditingTitle = () => {
    setIsEditingTitle(false);
    setRenameValue("");
  };

  const handleSaveTitle = async () => {
    if (!renameValue.trim() || isRenaming) return;
    setIsRenaming(true);
    try {
      await api.updateSessionMetadata(sessionId, { title: renameValue.trim() });
      setLocalCustomTitle(renameValue.trim());
      setIsEditingTitle(false);
      showToast("Session renamed", "success");
    } catch (err) {
      console.error("Failed to rename session:", err);
      showToast("Failed to rename session", "error");
    } finally {
      setIsRenaming(false);
    }
  };

  const handleTitleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleSaveTitle();
    } else if (e.key === "Escape") {
      e.preventDefault();
      handleCancelEditingTitle();
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

  // Sidebar icon component
  const SidebarIcon = () => (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <line x1="9" y1="3" x2="9" y2="21" />
    </svg>
  );

  return (
    <div
      className={isWideScreen ? "main-content-wrapper" : "main-content-mobile"}
    >
      <ToastContainer toasts={toasts} onDismiss={dismissToast} />
      <div
        className={
          isWideScreen
            ? "main-content-constrained"
            : "main-content-mobile-inner"
        }
      >
        <header className="session-header">
          <div className="session-header-inner">
            <div className="session-header-left">
              {/* Sidebar toggle - on mobile: opens sidebar, on desktop: collapses/expands */}
              {/* Hide on desktop when collapsed (sidebar has its own toggle) */}
              {!(isWideScreen && isSidebarCollapsed) && (
                <button
                  type="button"
                  className="sidebar-toggle"
                  onClick={isWideScreen ? toggleSidebar : openSidebar}
                  title={isWideScreen ? "Toggle sidebar" : "Open sidebar"}
                  aria-label={isWideScreen ? "Toggle sidebar" : "Open sidebar"}
                >
                  <SidebarIcon />
                </button>
              )}
              <div className="session-title-row">
                {isStarred && (
                  <svg
                    className="star-indicator-inline"
                    width="12"
                    height="12"
                    viewBox="0 0 24 24"
                    fill="currentColor"
                    stroke="currentColor"
                    strokeWidth="2"
                    role="img"
                    aria-label="Starred"
                  >
                    <title>Starred</title>
                    <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
                  </svg>
                )}
                {isEditingTitle ? (
                  <input
                    ref={renameInputRef}
                    type="text"
                    className="session-title-input"
                    value={renameValue}
                    onChange={(e) => setRenameValue(e.target.value)}
                    onKeyDown={handleTitleKeyDown}
                    onBlur={handleCancelEditingTitle}
                    disabled={isRenaming}
                  />
                ) : (
                  <button
                    type="button"
                    className="session-title"
                    onClick={handleStartEditingTitle}
                    title={session?.fullTitle ?? "Click to rename"}
                  >
                    {displayTitle}
                  </button>
                )}
                {isArchived && <span className="archived-badge">Archived</span>}
                <div className="session-menu-wrapper" ref={sessionMenuRef}>
                  <button
                    type="button"
                    className="session-menu-trigger"
                    onClick={() => setShowSessionMenu(!showSessionMenu)}
                    title="Session options"
                    aria-label="Session options"
                    aria-expanded={showSessionMenu}
                  >
                    <svg
                      width="16"
                      height="16"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      aria-hidden="true"
                    >
                      <polyline points="6 9 12 15 18 9" />
                    </svg>
                  </button>
                  {showSessionMenu && (
                    <div className="session-menu-dropdown">
                      <button
                        type="button"
                        onClick={() => {
                          handleToggleStar();
                          setShowSessionMenu(false);
                        }}
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
                        {isStarred ? "Unstar" : "Star"}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          handleStartEditingTitle();
                          setShowSessionMenu(false);
                        }}
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
                        Rename
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          handleToggleArchive();
                          setShowSessionMenu(false);
                        }}
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
                        {isArchived ? "Unarchive" : "Archive"}
                      </button>
                    </div>
                  )}
                </div>
              </div>
            </div>
            <StatusIndicator
              status={status}
              connected={connected}
              processState={processState}
            />
          </div>
        </header>

        {status.state === "external" && (
          <div className="external-session-warning">
            External session active - enter messages at your own risk!
          </div>
        )}

        {hasPendingToolCalls && (
          <div className="external-session-warning pending-tool-warning">
            This session may be waiting for input in another process (VS Code,
            CLI). Check there before sending a message.
          </div>
        )}

        <main className="session-messages">
          <MessageList
            messages={messages}
            isProcessing={
              status.state === "owned" && processState === "running"
            }
            scrollTrigger={scrollTrigger}
          />
        </main>

        <footer className="session-input">
          <div className="session-input-inner">
            {pendingInputRequest &&
              pendingInputRequest.sessionId === sessionId &&
              isAskUserQuestion && (
                <QuestionAnswerPanel
                  request={pendingInputRequest}
                  onSubmit={handleQuestionSubmit}
                  onDeny={handleDeny}
                />
              )}
            {pendingInputRequest &&
              pendingInputRequest.sessionId === sessionId &&
              !isAskUserQuestion && (
                <ToolApprovalPanel
                  request={pendingInputRequest}
                  onApprove={handleApprove}
                  onDeny={handleDeny}
                  onApproveAcceptEdits={handleApproveAcceptEdits}
                  onDenyWithFeedback={handleDenyWithFeedback}
                  draftKey={`draft-message-${sessionId}`}
                />
              )}
            {!(pendingInputRequest && !isAskUserQuestion) && (
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
            )}
          </div>
        </footer>
      </div>
    </div>
  );
}
