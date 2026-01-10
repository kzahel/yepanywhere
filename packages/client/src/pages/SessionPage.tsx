import type { ProviderName, UploadedFile } from "@yep-anywhere/shared";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { api, uploadFile } from "../api/client";
import { ClaudeLoginModal } from "../components/ClaudeLoginModal";
import { MessageInput, type UploadProgress } from "../components/MessageInput";
import { MessageInputToolbar } from "../components/MessageInputToolbar";
import { MessageList } from "../components/MessageList";
import { ProcessInfoModal } from "../components/ProcessInfoModal";
import { ProviderBadge } from "../components/ProviderBadge";
import { QuestionAnswerPanel } from "../components/QuestionAnswerPanel";
import { RecentSessionsDropdown } from "../components/RecentSessionsDropdown";
import { SessionMenu } from "../components/SessionMenu";
import { ToolApprovalPanel } from "../components/ToolApprovalPanel";
import { AgentContentProvider } from "../contexts/AgentContentContext";
import {
  StreamingMarkdownProvider,
  useStreamingMarkdownContext,
} from "../contexts/StreamingMarkdownContext";
import { useToastContext } from "../contexts/ToastContext";
import { useClaudeLogin } from "../hooks/useClaudeLogin";
import { useDeveloperMode } from "../hooks/useDeveloperMode";
import { useDocumentTitle } from "../hooks/useDocumentTitle";
import type { DraftControls } from "../hooks/useDraftPersistence";
import { useEngagementTracking } from "../hooks/useEngagementTracking";
import { getModelSetting, getThinkingSetting } from "../hooks/useModelSettings";
import { useProject } from "../hooks/useProjects";
import { useProviders } from "../hooks/useProviders";
import { recordSessionVisit } from "../hooks/useRecentSessions";
import {
  type StreamingMarkdownCallbacks,
  useSession,
} from "../hooks/useSession";
import { useNavigationLayout } from "../layouts";
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
  // Wrap with StreamingMarkdownProvider for server-rendered markdown streaming
  return (
    <StreamingMarkdownProvider>
      <SessionPageContent
        key={sessionId}
        projectId={projectId}
        sessionId={sessionId}
      />
    </StreamingMarkdownProvider>
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
    useNavigationLayout();
  const { project } = useProject(projectId);
  const navigate = useNavigate();
  const location = useLocation();
  // Get initial status and title from navigation state (passed by NewSessionPage)
  // This allows SSE to connect immediately and show optimistic title without waiting for getSession
  // Also get model/provider so ProviderBadge can render immediately
  const navState = location.state as {
    initialStatus?: { state: "owned"; processId: string };
    initialTitle?: string;
    initialModel?: string;
    initialProvider?: ProviderName;
  } | null;
  const initialStatus = navState?.initialStatus;
  const initialTitle = navState?.initialTitle;
  const initialModel = navState?.initialModel;
  const initialProvider = navState?.initialProvider;

  // Get streaming markdown context for server-rendered markdown streaming
  const streamingMarkdownContext = useStreamingMarkdownContext();

  // Memoize the callbacks object to avoid recreating on every render
  const streamingMarkdownCallbacks = useMemo<
    StreamingMarkdownCallbacks | undefined
  >(() => {
    if (!streamingMarkdownContext) return undefined;
    return {
      onAugment: streamingMarkdownContext.dispatchAugment,
      onPending: streamingMarkdownContext.dispatchPending,
      onStreamEnd: streamingMarkdownContext.dispatchStreamEnd,
      setCurrentMessageId: streamingMarkdownContext.setCurrentMessageId,
      captureHtml: streamingMarkdownContext.captureStreamingHtml,
    };
  }, [streamingMarkdownContext]);

  const {
    session,
    messages,
    agentContent,
    setAgentContent,
    toolUseToAgent,
    markdownAugments,
    status,
    processState,
    pendingInputRequest,
    actualSessionId,
    permissionMode,
    isModePending,
    loading,
    error,
    connected,
    lastSSEActivityAt,
    setStatus,
    setProcessState,
    setPermissionMode,
    setHold,
    isHeld,
    pendingMessages,
    addPendingMessage,
    removePendingMessage,
    slashCommands,
  } = useSession(
    projectId,
    sessionId,
    initialStatus,
    streamingMarkdownCallbacks,
  );

  // Effective provider/model for immediate display before session data loads
  const effectiveProvider = session?.provider ?? initialProvider;
  const effectiveModel = session?.model ?? initialModel;

  const [scrollTrigger, setScrollTrigger] = useState(0);
  const draftControlsRef = useRef<DraftControls | null>(null);
  const handleDraftControlsReady = useCallback((controls: DraftControls) => {
    draftControlsRef.current = controls;
  }, []);
  const { showToast } = useToastContext();

  // Claude CLI login flow (for /login command)
  const claudeLogin = useClaudeLogin();

  // Developer mode settings (hold mode is experimental)
  const { holdModeEnabled } = useDeveloperMode();

  // Combine SDK slash commands with our custom commands
  const allSlashCommands = useMemo(() => {
    // Add our custom "login" command for Claude Max/Pro re-authentication
    return [...slashCommands, "login"];
  }, [slashCommands]);

  // Get provider capabilities based on session's provider
  const { providers } = useProviders();
  const currentProviderInfo = useMemo(() => {
    if (!session?.provider) return null;
    return providers.find((p) => p.name === session.provider) ?? null;
  }, [providers, session?.provider]);
  // Default to true for backwards compatibility
  const supportsPermissionMode =
    currentProviderInfo?.supportsPermissionMode ?? true;
  const supportsThinkingToggle =
    currentProviderInfo?.supportsThinkingToggle ?? true;

  // Inline title editing state
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [isRenaming, setIsRenaming] = useState(false);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const isSavingTitleRef = useRef(false);

  // Recent sessions dropdown state
  const [showRecentSessions, setShowRecentSessions] = useState(false);
  const titleButtonRef = useRef<HTMLButtonElement>(null);

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
  const [localHasUnread, setLocalHasUnread] = useState<boolean | undefined>(
    undefined,
  );

  // Reset local metadata state when sessionId changes
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentionally reset on sessionId change
  useEffect(() => {
    setLocalCustomTitle(undefined);
    setLocalIsArchived(undefined);
    setLocalIsStarred(undefined);
    setLocalHasUnread(undefined);
  }, [sessionId]);

  // Record session visit for recents tracking
  useEffect(() => {
    recordSessionVisit(sessionId, projectId);
  }, [sessionId, projectId]);

  // Navigate to new session ID when temp ID is replaced with real SDK session ID
  // This ensures the URL stays in sync with the actual session
  useEffect(() => {
    if (actualSessionId && actualSessionId !== sessionId) {
      // Use replace to avoid creating a history entry for the temp ID
      navigate(`/projects/${projectId}/sessions/${actualSessionId}`, {
        replace: true,
        state: location.state, // Preserve initial state for seamless transition
      });
    }
  }, [actualSessionId, sessionId, projectId, navigate, location.state]);

  // File attachment state
  const [attachments, setAttachments] = useState<UploadedFile[]>([]);
  const [uploadProgress, setUploadProgress] = useState<UploadProgress[]>([]);

  // Approval panel collapsed state (separate from message input collapse)
  const [approvalCollapsed, setApprovalCollapsed] = useState(false);

  // Process info modal state
  const [showProcessInfoModal, setShowProcessInfoModal] = useState(false);

  // Track user engagement to mark session as "seen"
  // Only enabled when not in external session (we own or it's idle)
  //
  // We use two timestamps:
  // - activityAt: max(file mtime, SSE activity) - triggers the mark-seen action
  // - updatedAt: file mtime only - the timestamp we record
  //
  // This separation prevents a race condition where SSE timestamps (client clock)
  // could be ahead of file mtime (server disk write time), causing sessions to
  // never become unread again after viewing.
  const sessionUpdatedAt = session?.updatedAt ?? null;
  const activityAt = useMemo(() => {
    if (!sessionUpdatedAt && !lastSSEActivityAt) return null;
    if (!sessionUpdatedAt) return lastSSEActivityAt;
    if (!lastSSEActivityAt) return sessionUpdatedAt;
    // Return the more recent timestamp
    return sessionUpdatedAt > lastSSEActivityAt
      ? sessionUpdatedAt
      : lastSSEActivityAt;
  }, [sessionUpdatedAt, lastSSEActivityAt]);

  useEngagementTracking({
    sessionId,
    activityAt,
    updatedAt: sessionUpdatedAt,
    lastSeenAt: session?.lastSeenAt,
    hasUnread: session?.hasUnread,
    enabled: status.state !== "external",
  });

  const handleSend = async (text: string) => {
    // Intercept /login command for Claude CLI re-authentication
    if (text.trim() === "/login") {
      claudeLogin.startLogin();
      return;
    }

    // Add to pending queue and get tempId to pass to server
    const tempId = addPendingMessage(text);
    setProcessState("running"); // Optimistic: show processing indicator immediately
    setScrollTrigger((prev) => prev + 1); // Force scroll to bottom

    // Capture current attachments and clear optimistically
    const currentAttachments = [...attachments];
    setAttachments([]);

    try {
      if (status.state === "idle") {
        // Resume the session with current permission mode and model settings
        // Use session's existing model if available (important for non-Claude providers),
        // otherwise fall back to user's model preference for new Claude sessions
        const model = session?.model ?? getModelSetting();
        const thinking = getThinkingSetting();
        const result = await api.resumeSession(
          projectId,
          sessionId,
          text,
          {
            mode: permissionMode,
            model,
            thinking,
            provider: session?.provider,
          },
          currentAttachments.length > 0 ? currentAttachments : undefined,
          tempId,
        );
        // Update status to trigger SSE connection
        setStatus({ state: "owned", processId: result.processId });
      } else {
        // Queue to existing process with current permission mode and thinking setting
        const thinking = getThinkingSetting();
        const result = await api.queueMessage(
          sessionId,
          text,
          permissionMode,
          currentAttachments.length > 0 ? currentAttachments : undefined,
          tempId,
          thinking,
        );
        // If process was restarted due to thinking mode change, update the status
        if (result.restarted && result.processId) {
          setStatus({ state: "owned", processId: result.processId });
        }
      }
      // Success - clear the draft from localStorage
      draftControlsRef.current?.clearDraft();
    } catch (err) {
      console.error("Failed to send:", err);
      // Remove from pending queue and restore draft on error
      removePendingMessage(tempId);
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
    }
  };

  const handleAbort = async () => {
    if (status.state === "owned" && status.processId) {
      await api.abortProcess(status.processId);
    }
  };

  const handleApprove = useCallback(async () => {
    if (pendingInputRequest) {
      try {
        await api.respondToInput(sessionId, pendingInputRequest.id, "approve");
      } catch (err) {
        const status = (err as { status?: number }).status;
        const msg = status ? `Error ${status}` : "Failed to approve";
        showToast(msg, "error");
      }
    }
  }, [sessionId, pendingInputRequest, showToast]);

  const handleApproveAcceptEdits = useCallback(async () => {
    if (pendingInputRequest) {
      try {
        // Approve and switch to acceptEdits mode
        await api.respondToInput(
          sessionId,
          pendingInputRequest.id,
          "approve_accept_edits",
        );
        // Update local permission mode
        setPermissionMode("acceptEdits");
      } catch (err) {
        const status = (err as { status?: number }).status;
        const msg = status ? `Error ${status}` : "Failed to approve";
        showToast(msg, "error");
      }
    }
  }, [sessionId, pendingInputRequest, setPermissionMode, showToast]);

  const handleDeny = useCallback(async () => {
    if (pendingInputRequest) {
      try {
        await api.respondToInput(sessionId, pendingInputRequest.id, "deny");
      } catch (err) {
        const status = (err as { status?: number }).status;
        const msg = status ? `Error ${status}` : "Failed to deny";
        showToast(msg, "error");
      }
    }
  }, [sessionId, pendingInputRequest, showToast]);

  const handleDenyWithFeedback = useCallback(
    async (feedback: string) => {
      if (pendingInputRequest) {
        try {
          await api.respondToInput(
            sessionId,
            pendingInputRequest.id,
            "deny",
            undefined,
            feedback,
          );
        } catch (err) {
          const status = (err as { status?: number }).status;
          const msg = status ? `Error ${status}` : "Failed to send feedback";
          showToast(msg, "error");
        }
      }
    },
    [sessionId, pendingInputRequest, showToast],
  );

  const handleQuestionSubmit = useCallback(
    async (answers: Record<string, string>) => {
      if (pendingInputRequest) {
        try {
          await api.respondToInput(
            sessionId,
            pendingInputRequest.id,
            "approve",
            answers,
          );
        } catch (err) {
          const status = (err as { status?: number }).status;
          const msg = status ? `Error ${status}` : "Failed to submit answer";
          showToast(msg, "error");
        }
      }
    },
    [sessionId, pendingInputRequest, showToast],
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

  // If process is actively running or waiting for input, don't mark tools as orphaned.
  // "orphanedToolUseIds" from server just means "no result yet" - but if the process is
  // running (e.g., executing a Task subagent) or waiting for approval, they're not orphaned.
  const activeToolApproval =
    processState === "running" || processState === "waiting-input";

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

  // Compute display title - priority:
  // 1. Local custom title (user renamed in this session)
  // 2. Session title from server
  // 3. Initial title from navigation state (optimistic, before server responds)
  // 4. "Untitled" as final fallback
  const sessionTitle = getSessionDisplayTitle(session);
  const displayTitle =
    localCustomTitle ??
    (sessionTitle !== "Untitled" ? sessionTitle : null) ??
    initialTitle ??
    "Untitled";
  const isArchived = localIsArchived ?? session?.isArchived ?? false;
  const isStarred = localIsStarred ?? session?.isStarred ?? false;

  // Update browser tab title
  useDocumentTitle(project?.name, displayTitle);

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
    // Don't cancel if we're in the middle of saving
    if (isSavingTitleRef.current) return;
    setIsEditingTitle(false);
    setRenameValue("");
  };

  // On blur, save if value changed (handles mobile keyboard dismiss on Enter)
  const handleTitleBlur = () => {
    // Don't interfere if we're already saving
    if (isSavingTitleRef.current) return;
    // If value is empty or unchanged, just cancel
    if (!renameValue.trim() || renameValue.trim() === displayTitle) {
      handleCancelEditingTitle();
      return;
    }
    // Otherwise save (handles mobile Enter which blurs before keydown fires)
    handleSaveTitle();
  };

  const handleSaveTitle = async () => {
    if (!renameValue.trim() || isRenaming) return;
    isSavingTitleRef.current = true;
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
      isSavingTitleRef.current = false;
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

  const hasUnread = localHasUnread ?? session?.hasUnread ?? false;

  const handleToggleRead = async () => {
    const newHasUnread = !hasUnread;
    setLocalHasUnread(newHasUnread);
    try {
      if (newHasUnread) {
        await api.markSessionUnread(sessionId);
      } else {
        await api.markSessionSeen(sessionId);
      }
      showToast(
        newHasUnread ? "Marked as unread" : "Marked as read",
        "success",
      );
    } catch (err) {
      console.error("Failed to update read status:", err);
      setLocalHasUnread(undefined); // Revert on error
      showToast("Failed to update read status", "error");
    }
  };

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
              {/* Project breadcrumb */}
              {project?.name && (
                <Link
                  to={`/sessions?project=${projectId}`}
                  className="project-breadcrumb"
                  title={project.name}
                >
                  {project.name.length > 12
                    ? `${project.name.slice(0, 12)}...`
                    : project.name}
                </Link>
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
                {loading ? (
                  <span className="session-title-skeleton" />
                ) : isEditingTitle ? (
                  <input
                    ref={renameInputRef}
                    type="text"
                    className="session-title-input"
                    value={renameValue}
                    onChange={(e) => setRenameValue(e.target.value)}
                    onKeyDown={handleTitleKeyDown}
                    onBlur={handleTitleBlur}
                    disabled={isRenaming}
                  />
                ) : (
                  <>
                    <button
                      ref={titleButtonRef}
                      type="button"
                      className="session-title session-title-dropdown-trigger"
                      onClick={() => setShowRecentSessions(!showRecentSessions)}
                      title={session?.fullTitle ?? displayTitle}
                    >
                      <span className="session-title-text">{displayTitle}</span>
                      <svg
                        className="session-title-chevron"
                        width="12"
                        height="12"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden="true"
                      >
                        <polyline points="6 9 12 15 18 9" />
                      </svg>
                    </button>
                    <RecentSessionsDropdown
                      currentSessionId={sessionId}
                      isOpen={showRecentSessions}
                      onClose={() => setShowRecentSessions(false)}
                      onNavigate={() => setShowRecentSessions(false)}
                      triggerRef={titleButtonRef}
                    />
                  </>
                )}
                {!loading && isArchived && (
                  <span className="archived-badge">Archived</span>
                )}
                {!loading && (
                  <SessionMenu
                    sessionId={sessionId}
                    projectId={projectId}
                    isStarred={isStarred}
                    isArchived={isArchived}
                    hasUnread={hasUnread}
                    provider={session?.provider}
                    onToggleStar={handleToggleStar}
                    onToggleArchive={handleToggleArchive}
                    onToggleRead={handleToggleRead}
                    onRename={handleStartEditingTitle}
                    onClone={(newSessionId) => {
                      navigate(
                        `/projects/${projectId}/sessions/${newSessionId}`,
                      );
                    }}
                    useFixedPositioning
                    useEllipsisIcon
                  />
                )}
              </div>
            </div>
            <div className="session-header-right">
              {!loading && effectiveProvider && (
                <button
                  type="button"
                  className="provider-badge-button"
                  onClick={() => setShowProcessInfoModal(true)}
                  title="View session info"
                >
                  <ProviderBadge
                    provider={effectiveProvider}
                    model={effectiveModel}
                    isThinking={processState === "running"}
                  />
                </button>
              )}
            </div>
          </div>
        </header>

        {/* Process Info Modal */}
        {showProcessInfoModal && session && (
          <ProcessInfoModal
            sessionId={actualSessionId}
            provider={session.provider}
            model={session.model}
            status={status}
            processState={processState}
            contextUsage={session.contextUsage}
            onClose={() => setShowProcessInfoModal(false)}
          />
        )}

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

        <main
          className="session-messages"
          data-project-id={projectId}
          data-session-id={sessionId}
        >
          {loading ? (
            <div className="loading">Loading session...</div>
          ) : (
            <AgentContentProvider
              agentContent={agentContent}
              setAgentContent={setAgentContent}
              toolUseToAgent={toolUseToAgent}
              projectId={projectId}
              sessionId={sessionId}
            >
              <MessageList
                messages={messages}
                isProcessing={
                  status.state === "owned" && processState === "running"
                }
                scrollTrigger={scrollTrigger}
                pendingMessages={pendingMessages}
                markdownAugments={markdownAugments}
                activeToolApproval={activeToolApproval}
              />
            </AgentContentProvider>
          )}
        </main>

        <footer className="session-input">
          <div className="session-input-inner">
            {/* User question panel */}
            {pendingInputRequest &&
              pendingInputRequest.sessionId === actualSessionId &&
              isAskUserQuestion && (
                <QuestionAnswerPanel
                  request={pendingInputRequest}
                  sessionId={actualSessionId}
                  onSubmit={handleQuestionSubmit}
                  onDeny={handleDeny}
                />
              )}

            {/* Tool approval: show panel + always-visible toolbar */}
            {pendingInputRequest &&
              pendingInputRequest.sessionId === actualSessionId &&
              !isAskUserQuestion && (
                <>
                  <ToolApprovalPanel
                    request={pendingInputRequest}
                    sessionId={actualSessionId}
                    onApprove={handleApprove}
                    onDeny={handleDeny}
                    onApproveAcceptEdits={handleApproveAcceptEdits}
                    onDenyWithFeedback={handleDenyWithFeedback}
                    collapsed={approvalCollapsed}
                    onCollapsedChange={setApprovalCollapsed}
                  />
                  <MessageInputToolbar
                    mode={permissionMode}
                    onModeChange={setPermissionMode}
                    isModePending={isModePending}
                    isHeld={holdModeEnabled ? isHeld : undefined}
                    onHoldChange={holdModeEnabled ? setHold : undefined}
                    supportsPermissionMode={supportsPermissionMode}
                    supportsThinkingToggle={supportsThinkingToggle}
                    contextUsage={session?.contextUsage}
                    isRunning={status.state === "owned"}
                    isThinking={processState === "running"}
                    onStop={handleAbort}
                    pendingApproval={
                      approvalCollapsed
                        ? {
                            type: "tool-approval",
                            onExpand: () => setApprovalCollapsed(false),
                          }
                        : undefined
                    }
                  />
                </>
              )}

            {/* No pending approval: show full message input */}
            {!(
              pendingInputRequest &&
              pendingInputRequest.sessionId === actualSessionId &&
              !isAskUserQuestion
            ) && (
              <MessageInput
                onSend={handleSend}
                placeholder={
                  status.state === "external"
                    ? "External session - send at your own risk..."
                    : processState === "idle"
                      ? "Send a message to resume..."
                      : "Queue a message..."
                }
                mode={permissionMode}
                onModeChange={setPermissionMode}
                isModePending={isModePending}
                isHeld={holdModeEnabled ? isHeld : undefined}
                onHoldChange={holdModeEnabled ? setHold : undefined}
                supportsPermissionMode={supportsPermissionMode}
                supportsThinkingToggle={supportsThinkingToggle}
                isRunning={status.state === "owned"}
                isThinking={processState === "running"}
                onStop={handleAbort}
                draftKey={`draft-message-${sessionId}`}
                onDraftControlsReady={handleDraftControlsReady}
                collapsed={
                  !!(
                    pendingInputRequest &&
                    pendingInputRequest.sessionId === actualSessionId
                  )
                }
                contextUsage={session?.contextUsage}
                projectId={projectId}
                sessionId={sessionId}
                attachments={attachments}
                onAttach={handleAttach}
                onRemoveAttachment={handleRemoveAttachment}
                uploadProgress={uploadProgress}
                slashCommands={allSlashCommands}
              />
            )}
          </div>
        </footer>

        {/* Claude Login Modal for /login command */}
        {claudeLogin.isOpen && (
          <ClaudeLoginModal
            authMethod={claudeLogin.authMethod}
            onSelectMethod={claudeLogin.selectMethod}
            url={claudeLogin.url}
            statusMessage={claudeLogin.statusMessage}
            startupError={claudeLogin.error}
            onSuccess={claudeLogin.handleSuccess}
            onCancel={claudeLogin.handleCancel}
          />
        )}
      </div>
    </div>
  );
}
