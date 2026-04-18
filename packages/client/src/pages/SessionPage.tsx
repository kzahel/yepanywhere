import type { ProviderName, UploadedFile } from "@yep-anywhere/shared";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { api } from "../api/client";
import { MessageInput, type UploadProgress } from "../components/MessageInput";
import { MessageInputToolbar } from "../components/MessageInputToolbar";
import { MessageList } from "../components/MessageList";
import { ModelSwitchModal } from "../components/ModelSwitchModal";
import { ProcessInfoModal } from "../components/ProcessInfoModal";
import { ProviderBadge } from "../components/ProviderBadge";
import { QuestionAnswerPanel } from "../components/QuestionAnswerPanel";
import { RecentSessionsDropdown } from "../components/RecentSessionsDropdown";
import { SessionMenu } from "../components/SessionMenu";
import { ToolApprovalPanel } from "../components/ToolApprovalPanel";
import { AgentContentProvider } from "../contexts/AgentContentContext";
import { SessionMetadataProvider } from "../contexts/SessionMetadataContext";
import {
  StreamingMarkdownProvider,
  useStreamingMarkdownContext,
} from "../contexts/StreamingMarkdownContext";
import { useToastContext } from "../contexts/ToastContext";
import { useActivityBusState } from "../hooks/useActivityBusState";
import { useConnection } from "../hooks/useConnection";
import { useDeveloperMode } from "../hooks/useDeveloperMode";
import { useDocumentTitle } from "../hooks/useDocumentTitle";
import type { DraftControls } from "../hooks/useDraftPersistence";
import { useEngagementTracking } from "../hooks/useEngagementTracking";
import { getModelSetting, getThinkingSetting } from "../hooks/useModelSettings";
import { useProject } from "../hooks/useProjects";
import { recordSessionVisit } from "../hooks/useRecentSessions";
import { useRemoteBasePath } from "../hooks/useRemoteBasePath";
import {
  type StreamingMarkdownCallbacks,
  useSession,
} from "../hooks/useSession";
import { useI18n } from "../i18n";
import { useNavigationLayout } from "../layouts";
import { preprocessMessages } from "../lib/preprocessMessages";
import { getProvider } from "../providers/registry";
import { generateUUID } from "../lib/uuid";
import { getSessionDisplayTitle } from "../utils";

export function SessionPage() {
  const { projectId, sessionId } = useParams<{
    projectId: string;
    sessionId: string;
  }>();

  // Guard against missing params - this shouldn't happen with proper routing
  if (!projectId || !sessionId) {
    return <SessionPageInvalidRoute />;
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

function SessionPageInvalidRoute() {
  const { t } = useI18n();
  return <div className="error">{t("sessionInvalidUrl")}</div>;
}

function SessionPageContent({
  projectId,
  sessionId,
}: {
  projectId: string;
  sessionId: string;
}) {
  const { t } = useI18n();
  const { openSidebar, isWideScreen, toggleSidebar, isSidebarCollapsed } =
    useNavigationLayout();
  const basePath = useRemoteBasePath();
  const { project } = useProject(projectId);
  const navigate = useNavigate();
  const location = useLocation();
  // Get initial status and title from navigation state (passed by NewSessionPage)
  // This allows SSE to connect immediately and show optimistic title without waiting for getSession
  // Also get model/provider so ProviderBadge can render immediately
  const navState = location.state as {
    initialStatus?: { owner: "self"; processId: string };
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
    isCompacting,
    pendingInputRequest,
    actualSessionId,
    permissionMode,
    loading,
    error,
    connected,
    sessionUpdatesConnected,
    lastStreamActivityAt,
    setStatus,
    setProcessState,
    setPermissionMode,
    setHold,
    isHeld,
    pendingMessages,
    addPendingMessage,
    removePendingMessage,
    updatePendingMessage,
    deferredMessages,
    slashCommands,
    setSessionModel,
    sessionTools,
    mcpServers,
    pagination,
    loadingOlder,
    loadOlderMessages,
    reconnectStream,
  } = useSession(
    projectId,
    sessionId,
    initialStatus,
    streamingMarkdownCallbacks,
  );

  // Developer mode settings
  const { holdModeEnabled, showConnectionBars } = useDeveloperMode();

  // Session connection bar state for active session update streams
  const { connectionState } = useActivityBusState();
  const hasSessionUpdateStream =
    status.owner === "self" || status.owner === "external";
  const sessionConnectionStatus =
    !showConnectionBars || !hasSessionUpdateStream
      ? "idle"
      : sessionUpdatesConnected
        ? "connected"
        : connectionState === "reconnecting"
          ? "connecting"
          : "disconnected";

  // Effective provider/model for immediate display before session data loads
  const effectiveProvider = session?.provider ?? initialProvider;
  const effectiveModel = session?.model ?? initialModel;

  const [scrollTrigger, setScrollTrigger] = useState(0);
  const draftControlsRef = useRef<DraftControls | null>(null);
  const handleDraftControlsReady = useCallback((controls: DraftControls) => {
    draftControlsRef.current = controls;
  }, []);
  const { showToast } = useToastContext();

  // Sharing: check if configured (hidden unless sharing.json exists on server)
  const [sharingConfigured, setSharingConfigured] = useState(false);
  const [sharingStatusChecked, setSharingStatusChecked] = useState(false);
  const ensureSharingStatus = useCallback(() => {
    if (sharingStatusChecked) return;
    setSharingStatusChecked(true);
    void api
      .getSharingStatus()
      .then((res) => setSharingConfigured(res.configured))
      .catch(() => {});
  }, [sharingStatusChecked]);

  // Connection for uploads (uses WebSocket when enabled)
  const connection = useConnection();

  // Inject custom client-side commands alongside SDK-discovered ones
  const allSlashCommands = useMemo(() => {
    if (status.owner === "self") {
      return slashCommands.includes("model")
        ? slashCommands
        : ["model", ...slashCommands];
    }
    return slashCommands;
  }, [slashCommands, status.owner]);

  const currentProvider = useMemo(
    () => getProvider(session?.provider ?? initialProvider),
    [initialProvider, session?.provider],
  );
  const supportsPermissionMode =
    currentProvider.capabilities.supportsPermissionMode;
  const supportsThinkingToggle =
    currentProvider.capabilities.supportsThinkingToggle;
  const supportsSlashCommands =
    currentProvider.capabilities.supportsSlashCommands;

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
      navigate(
        `${basePath}/projects/${projectId}/sessions/${actualSessionId}`,
        {
          replace: true,
          state: location.state, // Preserve initial state for seamless transition
        },
      );
    }
  }, [
    actualSessionId,
    sessionId,
    projectId,
    navigate,
    location.state,
    basePath,
  ]);

  // File attachment state
  const [attachments, setAttachments] = useState<UploadedFile[]>([]);
  const [uploadProgress, setUploadProgress] = useState<UploadProgress[]>([]);
  // Track in-flight upload promises so handleSend can wait for them
  const pendingUploadsRef = useRef<Map<string, Promise<UploadedFile | null>>>(
    new Map(),
  );

  // Approval panel collapsed state (separate from message input collapse)
  const [approvalCollapsed, setApprovalCollapsed] = useState(false);

  // Process info modal state
  const [showProcessInfoModal, setShowProcessInfoModal] = useState(false);

  // Model switch modal state
  const [showModelSwitchModal, setShowModelSwitchModal] = useState(false);

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
    if (!sessionUpdatedAt && !lastStreamActivityAt) return null;
    if (!sessionUpdatedAt) return lastStreamActivityAt;
    if (!lastStreamActivityAt) return sessionUpdatedAt;
    // Return the more recent timestamp
    return sessionUpdatedAt > lastStreamActivityAt
      ? sessionUpdatedAt
      : lastStreamActivityAt;
  }, [sessionUpdatedAt, lastStreamActivityAt]);

  useEngagementTracking({
    sessionId,
    activityAt,
    updatedAt: sessionUpdatedAt,
    lastSeenAt: session?.lastSeenAt,
    hasUnread: session?.hasUnread,
    enabled: status.owner !== "external",
  });

  const handleSend = async (text: string) => {
    // Add to pending queue and get tempId to pass to server
    const tempId = addPendingMessage(text);
    setProcessState("in-turn"); // Optimistic: show processing indicator immediately
    setScrollTrigger((prev) => prev + 1); // Force scroll to bottom

    // Capture already-completed attachments
    const currentAttachments = [...attachments];

    // Wait for any in-flight uploads to complete before sending
    const pendingAtSendTime = [...pendingUploadsRef.current.values()];
    if (pendingAtSendTime.length > 0) {
      updatePendingMessage(tempId, { status: t("sessionUploading") });
      setAttachments([]); // Clear input area immediately
      const results = await Promise.all(pendingAtSendTime);
      for (const result of results) {
        if (result) currentAttachments.push(result);
      }
      // Remove uploaded files that handleAttach added to state during the wait
      // (they're already captured in currentAttachments). Preserve any new uploads
      // started after send was clicked.
      const sentIds = new Set(currentAttachments.map((a) => a.id));
      setAttachments((prev) => prev.filter((a) => !sentIds.has(a.id)));
      updatePendingMessage(tempId, { status: undefined });
    } else {
      setAttachments([]);
    }

    try {
      if (status.owner === "none") {
        // Resume the session with current permission mode and model settings
        // Use session's existing model if available (important for non-Claude providers),
        // otherwise fall back to user's model preference for new Claude sessions
        const model = session?.model ?? getModelSetting();
        const thinking = getThinkingSetting();
        // Use effectiveProvider to ensure correct provider even if session data hasn't loaded
        // effectiveProvider = session?.provider ?? initialProvider (from navigation state)
        const result = await api.resumeSession(
          projectId,
          sessionId,
          text,
          {
            mode: permissionMode,
            model,
            thinking,
            provider: effectiveProvider,
            executor: session?.executor,
          },
          currentAttachments.length > 0 ? currentAttachments : undefined,
          tempId,
        );
        // Update status to trigger SSE connection
        setStatus({ owner: "self", processId: result.processId });
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
        // If process was restarted due to thinking mode change, reconnect stream
        if (result.restarted && result.processId) {
          setStatus({ owner: "self", processId: result.processId });
          reconnectStream();
        }
      }
      // Success - clear the draft from localStorage
      draftControlsRef.current?.clearDraft();
    } catch (err) {
      console.error("Failed to send:", err);

      // Check if process is dead (404) - auto-retry with resumeSession
      const is404 =
        err instanceof Error &&
        (err.message.includes("404") ||
          err.message.includes("No active process"));
      if (is404) {
        try {
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
              provider: effectiveProvider,
              executor: session?.executor,
            },
            currentAttachments.length > 0 ? currentAttachments : undefined,
            tempId,
          );
          setStatus({ owner: "self", processId: result.processId });
          draftControlsRef.current?.clearDraft();
          return;
        } catch (retryErr) {
          console.error("Failed to resume session:", retryErr);
          // Fall through to error handling below
        }
      }

      // Remove from pending queue and restore draft on error
      removePendingMessage(tempId);
      draftControlsRef.current?.restoreFromStorage();
      setAttachments(currentAttachments); // Restore attachments on error
      setProcessState("idle");
      const errorMsg = err instanceof Error ? err.message : String(err);
      showToast(t("sessionSendFailed", { message: errorMsg }), "error");
    }
  };

  const handleQueue = async (text: string) => {
    const tempId = addPendingMessage(text);
    setScrollTrigger((prev) => prev + 1);

    // Capture already-completed attachments
    const currentAttachments = [...attachments];

    // Wait for any in-flight uploads to complete before queuing
    const pendingAtSendTime = [...pendingUploadsRef.current.values()];
    if (pendingAtSendTime.length > 0) {
      updatePendingMessage(tempId, { status: t("sessionUploading") });
      setAttachments([]);
      const results = await Promise.all(pendingAtSendTime);
      for (const result of results) {
        if (result) currentAttachments.push(result);
      }
      const sentIds = new Set(currentAttachments.map((a) => a.id));
      setAttachments((prev) => prev.filter((a) => !sentIds.has(a.id)));
      updatePendingMessage(tempId, { status: undefined });
    } else {
      setAttachments([]);
    }

    try {
      const thinking = getThinkingSetting();
      await api.queueMessage(
        sessionId,
        text,
        permissionMode,
        currentAttachments.length > 0 ? currentAttachments : undefined,
        tempId,
        thinking,
        true, // deferred
      );
      removePendingMessage(tempId);
      draftControlsRef.current?.clearDraft();
    } catch (err) {
      console.error("Failed to queue deferred message:", err);
      removePendingMessage(tempId);
      draftControlsRef.current?.restoreFromStorage();
      setAttachments(currentAttachments);
      const errorMsg = err instanceof Error ? err.message : String(err);
      showToast(t("sessionQueueFailed", { message: errorMsg }), "error");
    }
  };

  const handleModelChanged = useCallback(
    (model: string) => {
      setSessionModel(model);
      showToast(t("sessionSwitchedModel", { model }), "success");
    },
    [setSessionModel, showToast, t],
  );

  const handleCustomCommand = useCallback((command: string) => {
    if (command === "model") {
      setShowModelSwitchModal(true);
      return true;
    }
    return false;
  }, []);

  const handleAbort = async () => {
    if (status.owner === "self" && status.processId) {
      // Try interrupt first (graceful stop), fall back to abort if not supported
      try {
        const result = await api.interruptProcess(status.processId);
        if (result.interrupted) {
          // Successfully interrupted - process is still alive
          return;
        }
        // Interrupt not supported or failed, fall back to abort
      } catch {
        // Interrupt endpoint failed (404 = old server, or other error)
      }
      // Fall back to abort (kills the process)
      await api.abortProcess(status.processId);
    }
  };

  const handleApprove = useCallback(async () => {
    if (pendingInputRequest) {
      try {
        await api.respondToInput(sessionId, pendingInputRequest.id, "approve");
      } catch (err) {
        const status = (err as { status?: number }).status;
        const msg = status ? `Error ${status}` : t("sessionApproveFailed");
        showToast(msg, "error");
      }
    }
  }, [sessionId, pendingInputRequest, showToast, t]);

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
        const msg = status ? `Error ${status}` : t("sessionApproveFailed");
        showToast(msg, "error");
      }
    }
  }, [sessionId, pendingInputRequest, setPermissionMode, showToast, t]);

  const handleDeny = useCallback(async () => {
    if (pendingInputRequest) {
      try {
        await api.respondToInput(sessionId, pendingInputRequest.id, "deny");
      } catch (err) {
        const status = (err as { status?: number }).status;
        const msg = status ? `Error ${status}` : t("sessionDenyFailed");
        showToast(msg, "error");
      }
    }
  }, [sessionId, pendingInputRequest, showToast, t]);

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
          const msg = status ? `Error ${status}` : t("sessionFeedbackFailed");
          showToast(msg, "error");
        }
      }
    },
    [sessionId, pendingInputRequest, showToast, t],
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
          const msg = status ? `Error ${status}` : t("sessionAnswerFailed");
          showToast(msg, "error");
        }
      }
    },
    [sessionId, pendingInputRequest, showToast, t],
  );

  // Handle file attachment uploads
  // Each file uploads independently (parallel) and its promise is tracked
  // so handleSend can wait for in-flight uploads before sending
  const handleAttach = useCallback(
    (files: File[]) => {
      for (const file of files) {
        const tempId = generateUUID();

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

        // Start upload and track promise for handleSend to await
        const uploadPromise = connection
          .upload(projectId, sessionId, file, {
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
          })
          .then(
            (uploaded) => {
              setAttachments((prev) => [...prev, uploaded]);
              return uploaded;
            },
            (err) => {
              console.error("Upload failed:", err);
              const errorMsg =
                err instanceof Error ? err.message : t("sessionShareFailed");
              showToast(
                t("sessionUploadFailed", {
                  file: file.name,
                  message: errorMsg,
                }),
                "error",
              );
              return null as UploadedFile | null;
            },
          )
          .finally(() => {
            setUploadProgress((prev) =>
              prev.filter((p) => p.fileId !== tempId),
            );
            pendingUploadsRef.current.delete(tempId);
          });

        pendingUploadsRef.current.set(tempId, uploadPromise);
      }
    },
    [projectId, sessionId, showToast, connection, t],
  );

  const handleRemoveAttachment = useCallback((id: string) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id));
  }, []);

  // Check if pending request is an AskUserQuestion
  const isAskUserQuestion = pendingInputRequest?.toolName === "AskUserQuestion";

  // If process is actively in-turn or waiting for input, don't mark tools as orphaned.
  // "orphanedToolUseIds" from server just means "no result yet" - but if the process is
  // in-turn (e.g., executing a Task subagent) or waiting for approval, they're not orphaned.
  // Also suppress orphan marking when the session stream is disconnected - we can't trust
  // processState without the stream, so show tools as pending (spinner) rather than
  // incorrectly marking them as interrupted.
  const activeToolApproval =
    processState === "in-turn" ||
    processState === "waiting-input" ||
    (hasSessionUpdateStream && !sessionUpdatesConnected);

  // Detect if session has pending tool calls without results
  // This can happen when the session is unowned but was active in another process (VS Code, CLI)
  // that is waiting for user input (tool approval, question answer)
  const hasPendingToolCalls = useMemo(() => {
    if (status.owner !== "none") return false;
    const items = preprocessMessages(messages);
    return items.some(
      (item) => item.type === "tool_call" && item.status === "pending",
    );
  }, [messages, status.owner]);

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
    t("sessionUntitled");
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
      showToast(t("sessionRenamed"), "success");
    } catch (err) {
      console.error("Failed to rename session:", err);
      showToast(t("sessionRenameFailed"), "error");
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
        newArchived ? t("sessionArchived") : t("sessionUnarchived"),
        "success",
      );
    } catch (err) {
      console.error("Failed to update archive status:", err);
      showToast(t("sessionArchiveFailed"), "error");
    }
  };

  const handleToggleStar = async () => {
    const newStarred = !isStarred;
    try {
      await api.updateSessionMetadata(sessionId, { starred: newStarred });
      setLocalIsStarred(newStarred);
      showToast(
        newStarred ? t("sessionStarred") : t("sessionUnstarred"),
        "success",
      );
    } catch (err) {
      console.error("Failed to update star status:", err);
      showToast(t("sessionStarFailed"), "error");
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
        newHasUnread ? t("sessionMarkedUnread") : t("sessionMarkedRead"),
        "success",
      );
    } catch (err) {
      console.error("Failed to update read status:", err);
      setLocalHasUnread(undefined); // Revert on error
      showToast(t("sessionReadFailed"), "error");
    }
  };

  const handleTerminate = async () => {
    if (status.owner === "self" && status.processId) {
      try {
        await api.abortProcess(status.processId);
        showToast(t("sessionTerminated"), "success");
      } catch (err) {
        console.error("Failed to terminate session:", err);
        const errorMsg = err instanceof Error ? err.message : String(err);
        showToast(t("sessionTerminateFailed", { message: errorMsg }), "error");
      }
    }
  };

  const handleShare = useCallback(async () => {
    try {
      const { snapshotSession } = await import(
        "../lib/sharing/snapshotSession"
      );
      const html = snapshotSession(displayTitle);
      const result = await api.shareSession(html, displayTitle);
      await navigator.clipboard.writeText(result.url);
      showToast(t("sessionLinkCopied"), "success");
    } catch (err) {
      const msg = err instanceof Error ? err.message : t("sessionShareFailed");
      showToast(msg, "error");
    }
  }, [displayTitle, showToast, t]);

  if (error)
    return (
      <div className="error">
        {t("sessionErrorPrefix")} {error.message}
      </div>
    );

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
                  title={
                    isWideScreen
                      ? t("sessionToggleSidebar")
                      : t("sessionOpenSidebar")
                  }
                  aria-label={
                    isWideScreen
                      ? t("sessionToggleSidebar")
                      : t("sessionOpenSidebar")
                  }
                >
                  <SidebarIcon />
                </button>
              )}
              {/* Project breadcrumb */}
              {project?.name && (
                <Link
                  to={`${basePath}/sessions?project=${projectId}`}
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
                    aria-label={t("sessionStarredLabel")}
                  >
                    <title>{t("sessionStarredLabel")}</title>
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
                      basePath={basePath}
                    />
                  </>
                )}
                {!loading && isArchived && (
                  <span className="archived-badge">
                    {t("sessionArchivedBadge")}
                  </span>
                )}
                {!loading && (
                  <SessionMenu
                    sessionId={sessionId}
                    projectId={projectId}
                    isStarred={isStarred}
                    isArchived={isArchived}
                    hasUnread={hasUnread}
                    provider={session?.provider}
                    processId={
                      status.owner === "self" ? status.processId : undefined
                    }
                    onToggleStar={handleToggleStar}
                    onToggleArchive={handleToggleArchive}
                    onToggleRead={handleToggleRead}
                    onRename={handleStartEditingTitle}
                    onClone={(newSessionId) => {
                      navigate(
                        `${basePath}/projects/${projectId}/sessions/${newSessionId}`,
                      );
                    }}
                    onTerminate={handleTerminate}
                    sharingConfigured={sharingConfigured}
                    onShare={handleShare}
                    onOpen={ensureSharingStatus}
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
                  title={t("sessionViewInfo")}
                >
                  <ProviderBadge
                    provider={effectiveProvider}
                    model={effectiveModel}
                    isThinking={processState === "in-turn"}
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
            originator={session.originator}
            cliVersion={session.cliVersion}
            sessionSource={session.source}
            approvalPolicy={session.approvalPolicy}
            sandboxPolicy={session.sandboxPolicy}
            createdAt={session.createdAt}
            sessionStreamConnected={sessionUpdatesConnected}
            lastSessionEventAt={lastStreamActivityAt}
            onClose={() => setShowProcessInfoModal(false)}
          />
        )}

        {/* Model Switch Modal */}
        {showModelSwitchModal &&
          status.owner === "self" &&
          status.processId && (
            <ModelSwitchModal
              processId={status.processId}
              currentModel={session?.model}
              onModelChanged={handleModelChanged}
              onClose={() => setShowModelSwitchModal(false)}
            />
          )}

        {status.owner === "external" && (
          <div className="external-session-warning">
            {t("sessionExternalWarning")}
          </div>
        )}

        {hasPendingToolCalls && (
          <div className="external-session-warning pending-tool-warning">
            {t("sessionPendingElsewhereWarning")}
          </div>
        )}

        <main className="session-messages">
          {loading ? (
            <div className="loading">{t("sessionLoading")}</div>
          ) : (
            <SessionMetadataProvider
              projectId={projectId}
              projectPath={project?.path ?? null}
              sessionId={sessionId}
            >
              <AgentContentProvider
                agentContent={agentContent}
                setAgentContent={setAgentContent}
                toolUseToAgent={toolUseToAgent}
                projectId={projectId}
                sessionId={sessionId}
              >
                <MessageList
                  messages={messages}
                  provider={session?.provider}
                  isProcessing={
                    status.owner === "self" && processState === "in-turn"
                  }
                  isCompacting={isCompacting}
                  scrollTrigger={scrollTrigger}
                  pendingMessages={pendingMessages}
                  deferredMessages={deferredMessages}
                  onCancelDeferred={(tempId) =>
                    api.cancelDeferredMessage(sessionId, tempId)
                  }
                  markdownAugments={markdownAugments}
                  activeToolApproval={activeToolApproval}
                  hasOlderMessages={pagination?.hasOlderMessages}
                  loadingOlder={loadingOlder}
                  onLoadOlderMessages={loadOlderMessages}
                />
              </AgentContentProvider>
            </SessionMetadataProvider>
          )}
        </main>

        <footer className="session-input">
          <div
            className={`session-connection-bar session-connection-${sessionConnectionStatus}`}
          />
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
                    isHeld={holdModeEnabled ? isHeld : undefined}
                    onHoldChange={holdModeEnabled ? setHold : undefined}
                    supportsPermissionMode={supportsPermissionMode}
                    supportsThinkingToggle={supportsThinkingToggle}
                    contextUsage={session?.contextUsage}
                    isRunning={status.owner === "self"}
                    isThinking={processState === "in-turn"}
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
                onQueue={
                  status.owner !== "none" && processState !== "idle"
                    ? handleQueue
                    : undefined
                }
                placeholder={
                  status.owner === "external"
                    ? t("sessionPlaceholderExternal")
                    : processState === "idle"
                      ? t("sessionPlaceholderResume")
                      : t("sessionPlaceholderQueue")
                }
                mode={permissionMode}
                onModeChange={setPermissionMode}
                isHeld={holdModeEnabled ? isHeld : undefined}
                onHoldChange={holdModeEnabled ? setHold : undefined}
                supportsPermissionMode={supportsPermissionMode}
                supportsThinkingToggle={supportsThinkingToggle}
                isRunning={status.owner === "self"}
                isThinking={processState === "in-turn"}
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
                slashCommands={
                  status.owner === "external" ? [] : allSlashCommands
                }
                onCustomCommand={handleCustomCommand}
              />
            )}
          </div>
        </footer>
      </div>
    </div>
  );
}
