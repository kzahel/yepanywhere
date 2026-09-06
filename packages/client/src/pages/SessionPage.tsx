import type {
  BangCommandTranscriptDisplayObject,
  EffortLevel,
  PermissionMode,
  PromptSuggestionMode,
  ProviderName,
  ProjectQueueItemSummary,
  ProjectQueueStagedAttachments,
  SlashCommand,
  ThinkingMode,
  TranscriptDisplayObject,
  UploadedFile,
  UserQuestionAnswers,
} from "@yep-anywhere/shared";
import {
  CODEX_STREAM_DURABLE_ID_ALIGNMENT_CAPABILITY,
  PROJECT_SESSION_DEFAULTS_CAPABILITY,
  PROJECT_CODE_NAMES_CAPABILITY,
  PUBLIC_SHARE_MANAGEMENT_CAPABILITY,
  SIDEBAR_SESSION_RESUME_CAPABILITY,
  SYNTHETIC_ARCHIVE_COMMAND_CAPABILITY,
  SYNTHETIC_DONE_COMMAND_CAPABILITY,
  SYNTHETIC_TERMINATE_COMMAND_CAPABILITY,
  getCanonicalInvocationToken,
  isClaudeProviderName,
  serverHasCapability,
  startsWithSlashCommand,
  thinkingOptionToConfig,
} from "@yep-anywhere/shared";
import {
  type ComponentProps,
  lazy,
  type MouseEvent as ReactMouseEvent,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { api } from "../api/client";
import type { BangCommandHandlers } from "../components/BangCommandDisplayObject";
import {
  SessionViewerProvider,
  SessionViewerTranscriptGate,
} from "../components/SessionManagedViewer";
import styles from "./SessionPage.module.css";
import { GoalFlag } from "../components/GoalNotice";
import { buildBangEchoText, collectBangHistory } from "../lib/bangCommands";
import { serverSupportsBangCommands } from "../lib/bangCommandAvailability";
import { BtwAsidePane } from "../components/BtwAsidePane";
import { BtwAsideStickyCards } from "../components/BtwAsideStickyCards";
import { ClientLogRecordingBadge } from "../components/ClientLogRecordingBadge";
import { ExternalSessionWarning } from "../components/ExternalSessionWarning";
import { useStartNewSessionWithPrefillAction } from "../components/FileResourceActions";
import { HostIdentityMarker } from "../components/HostIdentityMarker";
import { getForkSummaryAutoOpen } from "../hooks/useForkSummaryAutoOpen";
import { PendingToolWarning } from "../components/PendingToolWarning";
import { ProviderChildSessionControl } from "../components/ProviderChildSessionControl";
import type {
  FullPaneComposerControls,
  UploadProgress,
} from "../components/MessageInput";
import { MessageInputToolbar } from "../components/MessageInputToolbar";
import { ModelSwitchModal } from "../components/ModelSwitchModal";
import { ProcessInfoBody } from "../components/ProcessInfoModal";
import { ProjectSessionDefaultsModal } from "../components/ProjectSessionDefaultsModal";
import { ProviderBadge } from "../components/ProviderBadge";
import { QuestionAnswerPanel } from "../components/QuestionAnswerPanel";
import { RecentSessionsDropdown } from "../components/RecentSessionsDropdown";
import { RestartSessionModal } from "../components/RestartSessionModal";
import { SessionHeartbeatModal } from "../components/SessionHeartbeatModal";
import { SessionMenu } from "../components/SessionMenu";
import { SessionPublicShareControls } from "../components/SessionPublicShareControls";
import { SessionRecapModal } from "../components/SessionRecapModal";
import { ThinkingIndicator } from "../components/ThinkingIndicator";
import { ToolApprovalPanel } from "../components/ToolApprovalPanel";
import type { ModalAnchorRect } from "../components/ui/Modal";
import { AgentContentProvider } from "../contexts/AgentContentContext";
import { GlossaryProjectProvider } from "../contexts/GlossaryContext";
import { RenderModeProvider } from "../contexts/RenderModeContext";
import { SessionMetadataProvider } from "../contexts/SessionMetadataContext";
import { useCurrentSourceRuntime } from "../contexts/SourceRuntimeContext";
import {
  StreamingMarkdownProvider,
  useStreamingMarkdownContext,
} from "../contexts/StreamingMarkdownContext";
import { useToastContext } from "../contexts/ToastContext";
import { useActivityBusState } from "../hooks/useActivityBusState";
import {
  getAttachmentUploadLongEdgePx,
  useAttachmentUploadQuality,
} from "../hooks/useAttachmentUploadQuality";
import { useDeveloperMode } from "../hooks/useDeveloperMode";
import { useDocumentTitle } from "../hooks/useDocumentTitle";
import type { DraftControls } from "../hooks/useDraftPersistence";
import { useEngagementTracking } from "../hooks/useEngagementTracking";
import { useBtwAsides } from "../hooks/useBtwAsides";
import { useGeneratedTitleEnabled } from "../hooks/useGeneratedTitleEnabled";
import { useGeneratedTitleLength } from "../hooks/useGeneratedTitleLength";
import { useIncomingShareFiles } from "../hooks/useIncomingShareFiles";
import {
  getModelSetting,
  getThinkingSetting,
  getShowThinkingSetting,
} from "../hooks/useModelSettings";
import { useProjectQueues } from "../hooks/useProjectQueues";
import { useProject, useProjects } from "../hooks/useProjects";
import { useProviders } from "../hooks/useProviders";
import { usePublicShareStatus } from "../hooks/usePublicShareStatus";
import { recordSessionVisit } from "../hooks/useRecentSessions";
import { useRemoteBasePath } from "../hooks/useRemoteBasePath";
import { useServerSettings } from "../hooks/useServerSettings";
import { useSessionLoadingProgress } from "../hooks/useSessionLoadingProgress";
import type { SessionLoadProgress } from "../hooks/useSessionMessages";
import { useSessionPerformanceSettings } from "../hooks/useSessionPerformanceSettings";
import { useSessionToolbarPresence } from "../hooks/useSessionToolbarPresence";
import { useVersion } from "../hooks/useVersion";
import type { DraftTextChangeMetadata } from "../lib/commentAnchors";
import {
  deleteDraftAttachmentRef,
  validateDraftAttachmentRefs,
} from "../lib/draftAttachmentStaging";
import {
  hasAttachmentNavigationRisk,
  useAttachmentNavigationGuard,
} from "../lib/attachmentNavigationGuard";
import {
  type StreamingMarkdownCallbacks,
  useSession,
} from "../hooks/useSession";
import { useI18n } from "../i18n";
import { MainContent, useNavigationLayout } from "../layouts";
import { toBrowserAppHref } from "../lib/appHref";
import { requiresAttachmentOnlyServerUpdate } from "../lib/attachmentSubmission";
import { storeUploadedAttachmentPreview } from "../lib/attachmentPreviewCache";
import {
  useActiveProjectSessionIds,
  useClientSummarySourceKey,
  useProviderRuntimeStatusForSession,
} from "../lib/clientSummaryStore";
import { activityBus } from "../lib/activityBus";
import {
  getRecallSubmissionAfterQueuedCancel,
  type LastComposerSubmission,
  type SentComposerSubmission,
} from "../lib/composerRecall";
import {
  createComposerDraftSignal,
  createComposerEditAvailabilityStore,
} from "../lib/composerDraftSignal";
import { createTranscriptPositionStore } from "../lib/transcriptPositionStore";
import { buildCorrectionText } from "../lib/correctionText";
import { logSessionUiTrace } from "../lib/diagnostics/uiTrace";
import { isEffortLevel } from "../lib/effortLevels";
import {
  executeSemanticUiComposerAction,
  isSemanticUiActionHarnessEnabled,
  registerSemanticUiComposerExecutors,
} from "../lib/semanticUiActions";
import {
  liveThinkingSelectionFromProcess,
  thinkingOptionFromProcess,
  thinkingOptionFromSelection,
} from "../lib/liveThinkingConfig";
import { getPersistentEditApprovalResponse } from "../lib/permissionModes";
import { getCachedWebTranscriptProjection } from "../lib/webTranscriptProjection";
import { createPendingElsewhereDismissKey } from "../lib/sessionUiStorageKeys";
import { parseCodexConfigAck } from "../lib/sessionCodexConfigAck";
import {
  liveModelConfigForProcess,
  resolveSessionModelConfig,
  type LiveSessionModelConfigSnapshot,
} from "../lib/sessionModelConfig";
import { parseThinkingConfig } from "../lib/sourceControlNavigationState";
import type { MessageSubmissionMetadata } from "../types/messageSubmission";
import {
  type ComposerAttachment,
  isComposerStagedAttachment,
  revokeAttachmentPreviewUrls,
  toPersistedStagedAttachmentRef,
} from "../lib/sessionComposerAttachments";
import {
  appendComposerTransferDraft,
  appendSlashCommandDraft,
  collectComposerAttachmentsForSubmission as collectComposerAttachmentsForSubmissionHelper,
  createComposerDraftAttachmentState,
  getComposerTransferReplacement,
  hasComposerDraftContent,
  materializeComposerAttachmentsForSubmission,
  splitComposerAttachmentsForSubmission,
  type PreparedComposerSubmission,
  uploadComposerAttachmentFile,
} from "../lib/sessionComposerSubmission";
import { isLegacyCodexSetupText } from "../lib/codexLegacySetup";
import { resolveSessionProviderCapabilities } from "../lib/providerCapabilities";
import {
  serverSupportsProjectQueue,
  shouldShowProjectQueueAffordance,
} from "../lib/projectQueueVisibility";
import { createSessionDraftStorageKey } from "../lib/sessionDraftStorage";
import {
  type ComposerTurnRecallCache,
  createComposerTurnRecallCache,
} from "../lib/composerTurnRecall";
import { turnContentText } from "../lib/sessionMessageText";
import {
  getEstimatedServerOffsetMs,
  getServerClockTimestamp,
  measureServerLatencyMs,
  recordServerClockSample,
} from "../lib/serverClock";
import { getSessionActivityUiState } from "../lib/sessionActivityUi";
import {
  createSessionNavigationState,
  parseSessionNavigationState,
} from "../lib/sessionNavigationState";
import { getPublicShareInitialPrompt } from "../lib/sessionPublicSharePrompt";
import { getUnifiedSessionForkAvailability } from "../lib/sessionForkAvailability";
import { isBtwAsideSession } from "../lib/btwAsideSessions";
import {
  composeGeneratedRetitle,
  createSessionRetitleSubmittedTurnText,
  type GeneratedRetitleInsertion,
  resolveSessionPageTitle,
} from "../lib/sessionTitleHelpers";
import {
  CLIENT_SLASH_COMMANDS,
  createClientSlashCommand,
  normalizeSlashCommandForMatch,
  resolveComposerDoneTarget,
  resolveComposerSessionOperation,
  resolveComposerSlashTurn,
} from "../lib/slashCommands";
import { generateUUID } from "../lib/uuid";
import {
  loadMessageInputModule,
  loadMessageListModule,
} from "../lib/sessionRouteModules";
import type { Message, Project } from "../types";

const LazyMessageList = lazy(() =>
  loadMessageListModule().then(({ MessageList }) => ({
    default: MessageList,
  })),
);
const LazyMessageInput = lazy(() =>
  loadMessageInputModule().then(({ MessageInput }) => ({
    default: MessageInput,
  })),
);

function SessionRouteModuleFallback({
  label,
}: {
  label: "loading" | "sessionLoading";
}) {
  const { t } = useI18n();
  return (
    <div className="loading" role="status">
      {t(label)}
    </div>
  );
}

function MessageList(props: ComponentProps<typeof LazyMessageList>) {
  return (
    <SessionViewerTranscriptGate>
      <Suspense
        fallback={<SessionRouteModuleFallback label="sessionLoading" />}
      >
        <LazyMessageList {...props} />
      </Suspense>
    </SessionViewerTranscriptGate>
  );
}

function MessageInput(props: ComponentProps<typeof LazyMessageInput>) {
  return (
    <Suspense fallback={<SessionRouteModuleFallback label="loading" />}>
      <LazyMessageInput {...props} />
    </Suspense>
  );
}

const CLAUDE_HANDOFF_REQUIRED_MESSAGE =
  "Claude session cannot be safely resumed because the Claude SDK recorded an API-error response as the latest assistant message. Start a handoff session instead.";
const EMPTY_PROJECT_QUEUE_PROJECT_IDS: readonly string[] = [];
const EMPTY_PROJECT_QUEUE_ITEMS: readonly ProjectQueueItemSummary[] = [];

function messageKey(message: Message | undefined): string | undefined {
  return message?.uuid ?? message?.id;
}

function isMissingDeferredQueueEntryError(error: unknown): boolean {
  if ((error as { status?: number } | null)?.status === 404) {
    return true;
  }
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("No active process") ||
    message.includes("Deferred message not found")
  );
}

function requiresHandoffAfterClaudeResumeError(
  error: unknown,
  provider: ProviderName | undefined,
): boolean {
  if ((error as { status?: number } | null)?.status !== 409) {
    return false;
  }
  if (!isClaudeProviderName(provider)) {
    return false;
  }
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("Start a handoff session") ||
    message.includes("API error: 409")
  );
}

function parsePositiveIntegerParam(value: string | null): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

type TitleEditMode = "manual" | "retitle";

interface GeneratedRetitleState {
  requestId: number;
  status: "generating" | "ready" | "error";
  submittedTurnText: string;
  title?: string;
  error?: string;
  deferredInsertion?: GeneratedRetitleInsertion;
}

export interface SessionPageRouteLocation {
  pathname: string;
  search: string;
  state: unknown;
  /** Router history entry id; distinguishes repeat navigations to one path. */
  key?: string;
}

export interface SessionPageProps {
  projectId?: string;
  sessionId?: string;
  routeLocation?: SessionPageRouteLocation;
  isDomLingerParked?: boolean;
  progressiveRenderPauseSignal?: {
    readonly current: boolean;
    supportsCompaction?: boolean;
  };
}

export function SessionPage({
  projectId: projectIdProp,
  sessionId: sessionIdProp,
  routeLocation,
  isDomLingerParked = false,
  progressiveRenderPauseSignal,
}: SessionPageProps = {}) {
  const params = useParams<{
    projectId: string;
    sessionId: string;
  }>();
  const projectId = projectIdProp ?? params.projectId;
  const sessionId = sessionIdProp ?? params.sessionId;

  // Guard against missing params - this shouldn't happen with proper routing
  if (!projectId || !sessionId) {
    return <SessionPageInvalidRoute />;
  }

  // Key ensures component remounts on session change, resetting all state
  // Wrap with StreamingMarkdownProvider for server-rendered markdown streaming
  return (
    <GlossaryProjectProvider projectId={projectId} enabled={!isDomLingerParked}>
      <StreamingMarkdownProvider>
        <RenderModeProvider key={sessionId}>
          <SessionPageContent
            key={sessionId}
            projectId={projectId}
            sessionId={sessionId}
            routeLocation={routeLocation}
            isDomLingerParked={isDomLingerParked}
            progressiveRenderPauseSignal={progressiveRenderPauseSignal}
          />
        </RenderModeProvider>
      </StreamingMarkdownProvider>
    </GlossaryProjectProvider>
  );
}

function SessionPageInvalidRoute() {
  const { t } = useI18n();
  return <div className="error">{t("sessionInvalidUrl")}</div>;
}

function getSessionLoadingProgressText(
  progress: SessionLoadProgress,
  t: ReturnType<typeof useI18n>["t"],
): string | null {
  switch (progress.stage) {
    case "fetching":
      return null;
    case "rendering":
      return t("sessionLoadingRenderingTranscript", {
        count: progress.messageCount ?? 0,
      });
    case "idle":
    case "complete":
    case "error":
      return null;
  }
}

const SESSION_LOADING_PROGRESS_DETAILS_DELAY_MS = 1500;

function SessionPageContent({
  projectId,
  sessionId,
  routeLocation,
  isDomLingerParked,
  progressiveRenderPauseSignal,
}: {
  projectId: string;
  sessionId: string;
  routeLocation?: SessionPageRouteLocation;
  isDomLingerParked: boolean;
  progressiveRenderPauseSignal?: { readonly current: boolean };
}) {
  const { t } = useI18n();
  const { showToast } = useToastContext();
  const { openSidebar, isWideScreen, toggleSidebar, isSidebarCollapsed } =
    useNavigationLayout();
  const basePath = useRemoteBasePath();
  const startNewSessionWithPrefill = useStartNewSessionWithPrefillAction();
  const { project } = useProject(projectId);
  const { projects } = useProjects();
  const activeProjectSessionIds = useActiveProjectSessionIds(projectId);
  const clientSummarySourceKey = useClientSummarySourceKey();
  const sourceRuntime = useCurrentSourceRuntime();
  const sourceApi = sourceRuntime.api;
  const sourceSummary = sourceRuntime.summary;
  const sourceTransport = sourceRuntime.transport;
  const sessionDraftReference = useMemo(
    () => ({
      sourceKey: clientSummarySourceKey,
      sessionId,
    }),
    [clientSummarySourceKey, sessionId],
  );
  const sessionDraftKey = useMemo(
    () => createSessionDraftStorageKey(sessionDraftReference),
    [sessionDraftReference],
  );
  const { version: versionInfo } = useVersion();
  const { presence: toolbarPresence } = useSessionToolbarPresence();
  const syntheticDoneEnabled = toolbarPresence.syntheticDone !== "off";
  const supportsSyntheticDone = serverHasCapability(
    versionInfo,
    SYNTHETIC_DONE_COMMAND_CAPABILITY,
  );
  const supportsSyntheticArchive = serverHasCapability(
    versionInfo,
    SYNTHETIC_ARCHIVE_COMMAND_CAPABILITY,
  );
  const supportsSyntheticTerminate = serverHasCapability(
    versionInfo,
    SYNTHETIC_TERMINATE_COMMAND_CAPABILITY,
  );
  const supportsProjectQueue = serverSupportsProjectQueue(versionInfo);
  const supportsProjectSessionDefaults = serverHasCapability(
    versionInfo,
    PROJECT_SESSION_DEFAULTS_CAPABILITY,
  );
  const supportsProjectCodeNames = serverHasCapability(
    versionInfo,
    PROJECT_CODE_NAMES_CAPABILITY,
  );
  const supportsCodexStreamDurableIdAlignment = serverHasCapability(
    versionInfo,
    CODEX_STREAM_DURABLE_ID_ALIGNMENT_CAPABILITY,
  );
  const projectQueueProjectIds = useMemo(
    () =>
      supportsProjectQueue ? [projectId] : EMPTY_PROJECT_QUEUE_PROJECT_IDS,
    [projectId, supportsProjectQueue],
  );
  const projectQueues = useProjectQueues(projectQueueProjectIds);
  const navigate = useNavigate();
  const currentLocation = useLocation();
  const location = routeLocation ?? currentLocation;
  // Get initial status and title from navigation state (passed by NewSessionPage)
  // This allows SSE to connect immediately and show optimistic title without waiting for getSession
  // Also get model/provider so ProviderBadge can render immediately
  const navState = parseSessionNavigationState(location.state);
  const initialStatus = navState?.initialStatus;
  const initialTitle = navState?.initialTitle;
  const initialModel = navState?.initialModel;
  const initialProvider = navState?.initialProvider;
  const clientTailParams = useMemo(() => {
    const params = new URLSearchParams(location.search);
    return {
      tailTurns: parsePositiveIntegerParam(params.get("tailTurns")),
      tailFrom: params.get("tailFrom")?.trim() || undefined,
    };
  }, [location.search]);
  const clientTailActive =
    clientTailParams.tailTurns !== undefined ||
    clientTailParams.tailFrom !== undefined;
  const { sessionLoadingProgressEnabled } = useSessionLoadingProgress();
  const { sessionScrollBehaviorMode } = useSessionPerformanceSettings();
  const [
    sessionLoadingProgressDetailsVisible,
    setSessionLoadingProgressDetailsVisible,
  ] = useState(false);
  useEffect(() => {
    void clientTailParams;
    void projectId;
    void sessionId;
    setSessionLoadingProgressDetailsVisible(false);
    if (!sessionLoadingProgressEnabled) {
      return;
    }

    const timer = window.setTimeout(() => {
      setSessionLoadingProgressDetailsVisible(true);
    }, SESSION_LOADING_PROGRESS_DETAILS_DELAY_MS);

    return () => window.clearTimeout(timer);
  }, [clientTailParams, projectId, sessionId, sessionLoadingProgressEnabled]);
  const sessionOptions = useMemo(
    () => ({
      ...clientTailParams,
      detailedLoadingProgress: sessionLoadingProgressEnabled,
      codexStreamDurableIdAlignment: supportsCodexStreamDurableIdAlignment,
      backgroundEffectsPaused: isDomLingerParked,
      onConfigurationError: (failure: { setting: "effort" }) => {
        if (failure.setting === "effort") {
          showToast(t("effortChangeApplyFailed"), "error");
        }
      },
    }),
    [
      clientTailParams,
      isDomLingerParked,
      sessionLoadingProgressEnabled,
      showToast,
      supportsCodexStreamDurableIdAlignment,
      t,
    ],
  );

  const updateClientTailParams = useCallback(
    (update: { tailTurns?: number; tailFrom?: string }) => {
      const params = new URLSearchParams(location.search);
      params.delete("tailTurns");
      params.delete("tailFrom");
      if (update.tailTurns !== undefined) {
        params.set("tailTurns", String(update.tailTurns));
      }
      if (update.tailFrom) {
        params.set("tailFrom", update.tailFrom);
      }
      const search = params.toString();
      navigate(
        {
          pathname: location.pathname,
          search: search ? `?${search}` : "",
        },
        { replace: false },
      );
    },
    [location.pathname, location.search, navigate],
  );

  const trimClientFromUserMessage = useCallback(
    (messageId: string) => {
      updateClientTailParams({ tailFrom: messageId });
    },
    [updateClientTailParams],
  );

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
    updateSession,
    messages,
    agentContent,
    mergeLoadedAgentContent,
    toolUseToAgent,
    markdownAugments,
    status,
    processState,
    sessionLiveness,
    isCompacting,
    setIsCompacting,
    pendingInputRequest,
    actualSessionId,
    permissionMode,
    loading,
    sessionLoadProgress,
    error,
    sessionUpdatesConnected,
    lastStreamActivityAt,
    setStatus,
    setProcessState,
    setPendingInputRequest,
    setPermissionMode,
    pendingMessages,
    addPendingMessage,
    removePendingMessage,
    updatePendingMessage,
    deferredMessages,
    setDeferredMessages,
    removeUnconfirmedSelfSend,
    slashCommands,
    setSessionModel,
    pagination,
    activeWindowTrimRevision,
    loadingOlder,
    olderLoadContinuationRequired,
    loadOlderMessages,
    readOlderSearchPage,
    initialScrollSnapshot,
    updateRouteScrollSnapshot,
    updateActiveWindowFollowingBottom,
    reconnectStream,
    fetchNewMessages,
    promptSuggestion,
    dismissPromptSuggestion,
  } = useSession(
    projectId,
    sessionId,
    initialStatus,
    streamingMarkdownCallbacks,
    sessionOptions,
  );
  const providerRuntimeStatus =
    useProviderRuntimeStatusForSession(actualSessionId);
  const goalDetails = slashCommands.find((command) => command.name === "goal")
    ?.providerDetails?.codex;
  const currentGoal = goalDetails?.goalObjective;
  const sessionLoadingProgressText =
    sessionLoadingProgressEnabled && sessionLoadingProgressDetailsVisible
      ? getSessionLoadingProgressText(sessionLoadProgress, t)
      : null;

  // Developer mode settings
  const { showConnectionBars } = useDeveloperMode();
  const { generatedTitleLength } = useGeneratedTitleLength();
  const { generatedTitleEnabled } = useGeneratedTitleEnabled();
  const { settings: serverSettings } = useServerSettings();
  // Composer `!!` routing is always-on where the server supports it
  // (vanilla-defaults.md § Known Exceptions); no setting gates execution.
  const bangCommandsSupported = serverSupportsBangCommands(versionInfo);
  const publicSharesEnabled = serverSettings?.publicSharesEnabled ?? false;
  const { status: publicShareGlobalStatus } = usePublicShareStatus({
    poll: publicSharesEnabled,
  });
  const projectQueueBlockingCount = project?.projectQueueBlockingCount ?? null;
  const currentSessionBlocksProjectQueue =
    status.owner === "external" ||
    processState === "in-turn" ||
    processState === "waiting-input" ||
    pendingInputRequest !== null ||
    (sessionLiveness !== null &&
      sessionLiveness.derivedStatus !== "verified-idle") ||
    deferredMessages.length > 0;
  const projectQueueItemsForProject = supportsProjectQueue
    ? (projectQueues.queuesByProject[projectId] ?? EMPTY_PROJECT_QUEUE_ITEMS)
    : EMPTY_PROJECT_QUEUE_ITEMS;
  const projectQueueItemCount = projectQueueItemsForProject.length;
  const inlineProjectQueueMessages = useMemo(
    () =>
      projectQueueItemsForProject.flatMap((item, index) => {
        if (
          item.target.type !== "existing-session" ||
          item.target.sessionId !== sessionId
        ) {
          return [];
        }
        return [
          {
            id: item.id,
            content:
              item.message.text ||
              item.messagePreview ||
              t("projectQueueAttachmentOnly"),
            timestamp: item.createdAt,
            status: item.status,
            projectPosition: index + 1,
            attachmentCount: item.attachmentCount,
            attachments: item.message.attachments,
            lastError: item.lastError,
            isMutating: projectQueues.mutatingItemId === item.id,
            canEdit: !item.message.stagedAttachments,
          },
        ];
      }),
    [projectQueueItemsForProject, projectQueues.mutatingItemId, sessionId, t],
  );
  const showProjectQueueAction =
    supportsProjectQueue &&
    shouldShowProjectQueueAffordance({
      projectId,
      currentSessionId: sessionId,
      currentSessionBlocksProjectQueue,
      currentSessionHasSessionQueueBacklog: deferredMessages.length > 0,
      activeProjectSessionIds,
      projectQueueBlockingCount,
      projectQueueItemCount,
    });

  // Session connection bar state for active session update streams
  const { connectionState } = useActivityBusState();
  const hasSessionUpdateStream =
    status.owner === "self" || status.owner === "external";

  // Always compute the real connection state. We only hide the bar behind
  // developer mode for connected/idle states; a disconnected state is
  // always shown so users can see when the live pipe is broken (e.g. dropped
  // SSH tunnel, relay issue, etc.).
  const rawSessionConnectionStatus = !hasSessionUpdateStream
    ? "idle"
    : sessionUpdatesConnected
      ? "connected"
      : connectionState === "reconnecting"
        ? "connecting"
        : "disconnected";

  const sessionConnectionStatus =
    showConnectionBars || rawSessionConnectionStatus === "disconnected"
      ? rawSessionConnectionStatus
      : "idle";

  // Effective provider/model for immediate display before session data loads
  const effectiveProvider = session?.provider ?? initialProvider;
  const effectiveModel = session?.model ?? initialModel;
  const startNewSessionFromSelection = useCallback(
    (prefill: string) => {
      startNewSessionWithPrefill(projectId, prefill, {
        provider: effectiveProvider,
        model: effectiveModel,
      });
    },
    [effectiveModel, effectiveProvider, projectId, startNewSessionWithPrefill],
  );
  const codexPermissionModeChangePending =
    effectiveProvider === "codex" &&
    status.owner === "self" &&
    status.appliedPermissionMode !== undefined &&
    permissionMode !== status.appliedPermissionMode;
  const currentOwnedProcessId =
    status.owner === "self" ? status.processId : undefined;
  const [liveModelConfigSnapshot, setLiveModelConfigSnapshot] =
    useState<LiveSessionModelConfigSnapshot | null>(null);
  const liveModelConfig = liveModelConfigForProcess(
    liveModelConfigSnapshot,
    currentOwnedProcessId,
  );
  const latestCodexConfigAck = useMemo(() => {
    if (effectiveProvider !== "codex" && effectiveProvider !== "codex-oss") {
      return null;
    }

    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const acknowledged = parseCodexConfigAck(
        messages[index] as { [key: string]: unknown } | undefined,
      );
      if (acknowledged) {
        return acknowledged;
      }
    }

    return null;
  }, [effectiveProvider, messages]);
  const effectiveModelConfig = useMemo(
    () =>
      resolveSessionModelConfig(
        liveModelConfig,
        session?.effectiveModelSettings,
        latestCodexConfigAck,
      ),
    [latestCodexConfigAck, liveModelConfig, session?.effectiveModelSettings],
  );

  const [scrollTrigger, setScrollTrigger] = useState(0);
  const composerFullPaneControlsRef = useRef<FullPaneComposerControls | null>(
    null,
  );
  const handleFollowCurrent = useCallback(() => {
    composerFullPaneControlsRef.current?.restore();
  }, []);
  const handleFullPaneControlsReady = useCallback(
    (controls: FullPaneComposerControls | null) => {
      composerFullPaneControlsRef.current = controls;
    },
    [],
  );
  const draftControlsRef = useRef<DraftControls | null>(null);
  const [quoteClearSignal, setQuoteClearSignal] = useState(0);
  const pendingMotherComposerTransferRef = useRef<string | null>(null);
  const lastComposerSubmissionRef = useRef<LastComposerSubmission | null>(null);
  const lastSentComposerSubmissionRef = useRef<SentComposerSubmission | null>(
    null,
  );
  const {
    asideComposerRef,
    asideDraft,
    btwSidePaneCollapsed,
    btwToolbarMode,
    childSessionParentHref,
    composerStickyBtwAsides,
    focusedBtwAside,
    focusedBtwAsideId,
    handleBtwShortcut,
    handleDoneBtwAside,
    handleStopBtwAside,
    handleStopBtwAsideFromTranscript,
    hideBtwAside,
    historyBtwAsides,
    mainComposerForAside,
    resetBtwAsides,
    runBtwAsideTurn,
    setAsideDraft,
    setBtwSidePaneCollapsed,
    setFocusedBtwAsideId,
    showBtwSidePane,
    startBtwAside,
    stickyBtwAsides,
    supportsBtwAsides,
    toggleBtwAsideExpanded,
    wantBtwSplitLayout,
  } = useBtwAsides({
    basePath,
    projectId,
    sessionId,
    actualSessionId,
    locationSearch: location.search,
    sourceApi,
    effectiveProvider,
    isWideScreen,
    permissionMode,
    liveModel: effectiveModelConfig?.model,
    sessionModel: session?.model,
    sessionExecutor: session?.executor,
    parentSessionId: isBtwAsideSession({
      parentSessionId: session?.parentSessionId,
      parentSessionKind: session?.parentSessionKind,
      title: session?.customTitle ?? session?.title,
      fullTitle: session?.fullTitle,
    })
      ? session?.parentSessionId
      : undefined,
    showToast,
    onNavigateToParentAside: navigate,
  });
  const [correctionDraft, setCorrectionDraft] = useState<{
    messageId: string;
    originalText: string;
  } | null>(null);
  const [forkSummaryDraft, setForkSummaryDraft] = useState<{
    sourceMessageId: string;
  } | null>(null);
  const forkSummaryStartPendingRef = useRef<Set<string>>(new Set());
  const initiatedForkSummaryAutoOpenRef = useRef<Map<string, boolean>>(
    new Map(),
  );
  const attemptedForkSummaryAutoOpenRef = useRef<Set<string>>(new Set());
  // File attachment state
  const [attachments, setAttachmentsState] = useState<ComposerAttachment[]>([]);
  const attachmentsRef = useRef<ComposerAttachment[]>([]);
  const draftAttachmentBatchIdRef = useRef<string | null>(null);
  const draftAttachmentHydrationRef = useRef(0);
  const [uploadProgress, setUploadProgress] = useState<UploadProgress[]>([]);
  const composerDraftSignal = useMemo(() => {
    void sessionId;
    return createComposerDraftSignal();
  }, [sessionId]);
  const composerEditAvailabilityStore = useMemo(() => {
    void sessionId;
    return createComposerEditAvailabilityStore();
  }, [sessionId]);
  const transcriptPositionStore = useMemo(() => {
    void actualSessionId;
    return createTranscriptPositionStore();
  }, [actualSessionId]);
  useEffect(
    () => () => transcriptPositionStore.dispose(),
    [transcriptPositionStore],
  );
  const [attachmentQuality] = useAttachmentUploadQuality();
  useEffect(() => {
    composerEditAvailabilityStore.setExternalBlockers(
      attachments.length > 0,
      uploadProgress.length > 0,
    );
  }, [
    attachments.length,
    composerEditAvailabilityStore,
    uploadProgress.length,
  ]);
  // Track in-flight upload promises so handleSend can wait for them
  const pendingUploadsRef = useRef<
    Map<string, Promise<ComposerAttachment | null>>
  >(new Map());
  const updateTranscriptDisplayObjectsForSession = useCallback(
    (
      targetSessionId: string,
      updater: (
        objects: TranscriptDisplayObject[],
      ) => TranscriptDisplayObject[],
    ) => {
      updateSession((current) => {
        if (!current || current.id !== targetSessionId) {
          return current;
        }
        return {
          ...current,
          transcriptDisplayObjects: updater(
            current.transcriptDisplayObjects ?? [],
          ),
        };
      });
    },
    [updateSession],
  );

  const rememberSentSubmission = useCallback((text: string, id: string) => {
    const trimmed = text.trim();
    if (!trimmed) {
      return;
    }
    const submission: SentComposerSubmission = {
      kind: "sent",
      text: trimmed,
      id,
    };
    lastSentComposerSubmissionRef.current = submission;
    lastComposerSubmissionRef.current = submission;
  }, []);

  const stagedAttachmentUploadsEnabled = supportsProjectQueue;
  const stagedComposerAttachmentRefs = attachments
    .filter(isComposerStagedAttachment)
    .map(toPersistedStagedAttachmentRef);
  const attachmentNavigationGuardActive = hasAttachmentNavigationRisk({
    pendingUploadCount: uploadProgress.length,
    transientAttachmentCount: stagedAttachmentUploadsEnabled
      ? 0
      : attachments.filter(
          (attachment) => !isComposerStagedAttachment(attachment),
        ).length,
    stagedRefs: stagedComposerAttachmentRefs,
    draftState: draftControlsRef.current?.getAttachmentState() ?? null,
  });
  useAttachmentNavigationGuard(attachmentNavigationGuardActive);

  const writeDraftAttachmentState = useCallback(
    (nextAttachments: readonly ComposerAttachment[]) => {
      const draftState = createComposerDraftAttachmentState(nextAttachments);
      if (!draftState) {
        draftAttachmentBatchIdRef.current = null;
        draftControlsRef.current?.setAttachmentState(null);
        return;
      }

      draftAttachmentBatchIdRef.current = draftState.batchId;
      draftControlsRef.current?.setAttachmentState(draftState);
    },
    [],
  );

  const setComposerAttachments = useCallback(
    (
      updater:
        | ComposerAttachment[]
        | ((previous: readonly ComposerAttachment[]) => ComposerAttachment[]),
      options?: {
        persistDraft?: boolean;
        revokeRemovedPreviewUrls?: boolean;
      },
    ) => {
      const previous = attachmentsRef.current;
      const next = typeof updater === "function" ? updater(previous) : updater;

      if (options?.revokeRemovedPreviewUrls) {
        const nextIds = new Set(next.map((attachment) => attachment.id));
        revokeAttachmentPreviewUrls(
          previous.filter((attachment) => !nextIds.has(attachment.id)),
        );
      }

      attachmentsRef.current = next;
      setAttachmentsState(next);
      if (options?.persistDraft !== false) {
        writeDraftAttachmentState(next);
      }
    },
    [writeDraftAttachmentState],
  );

  useEffect(() => {
    return () => {
      revokeAttachmentPreviewUrls(attachmentsRef.current);
    };
  }, []);

  const ensureDraftAttachmentBatchId = useCallback(() => {
    const existing =
      draftControlsRef.current?.getAttachmentState()?.batchId ??
      draftAttachmentBatchIdRef.current;
    if (existing) {
      draftAttachmentBatchIdRef.current = existing;
      return existing;
    }
    const batchId = generateUUID();
    draftAttachmentBatchIdRef.current = batchId;
    return batchId;
  }, []);

  const materializeComposerAttachments = useCallback(
    async (
      composerAttachments: readonly ComposerAttachment[],
    ): Promise<UploadedFile[]> => {
      return materializeComposerAttachmentsForSubmission({
        attachments: composerAttachments,
        sourceTransport,
        projectId,
        sessionId,
      });
    },
    [sourceTransport, projectId, sessionId],
  );

  const supportsManualCompact =
    status.owner === "self" &&
    slashCommands.some(
      (command) => normalizeSlashCommandForMatch(command.name) === "compact",
    );
  const manualCompactBlocked =
    effectiveProvider === "codex" &&
    (processState === "in-turn" || processState === "waiting-input");

  // Inject custom client-side commands alongside SDK-discovered ones.
  // Keep /model last so it stays nearest the slash button in the upward menu.
  const allSlashCommands = useMemo(() => {
    if (status.owner === "external") {
      return [];
    }

    const orderedCommands: SlashCommand[] =
      status.owner === "self"
        ? CLIENT_SLASH_COMMANDS.filter(
            (command) =>
              command !== "model" &&
              (command !== "btw" || supportsBtwAsides) &&
              (command !== "done" ||
                mainComposerForAside ||
                syntheticDoneEnabled) &&
              (command !== "terminate" ||
                (syntheticDoneEnabled && supportsSyntheticTerminate)),
          ).map(createClientSlashCommand)
        : [];
    if (supportsManualCompact) {
      const compact = slashCommands.find(
        (command) => normalizeSlashCommandForMatch(command.name) === "compact",
      );
      if (compact) {
        orderedCommands.push(
          manualCompactBlocked
            ? { ...compact, description: t("sessionCompactTurnActive") }
            : compact,
        );
      }
    }

    for (const command of slashCommands) {
      const normalized = normalizeSlashCommandForMatch(command.name);
      const providerModelSkill =
        normalized === "model" && command.invocation?.kind === "skill";
      if (
        (normalized !== "model" || providerModelSkill) &&
        !orderedCommands.some(
          (candidate) =>
            normalizeSlashCommandForMatch(candidate.name) === normalized &&
            candidate.invocation?.kind === command.invocation?.kind,
        )
      ) {
        orderedCommands.push(command);
      }
    }

    if (status.owner === "self") {
      orderedCommands.push(createClientSlashCommand("model"));
    }

    return orderedCommands;
  }, [
    mainComposerForAside,
    manualCompactBlocked,
    slashCommands,
    status.owner,
    supportsBtwAsides,
    supportsManualCompact,
    supportsSyntheticTerminate,
    syntheticDoneEnabled,
    t,
  ]);

  // Get provider capabilities based on session's provider
  const { providers } = useProviders();
  const providerCapabilities = useMemo(
    () =>
      resolveSessionProviderCapabilities({
        providers,
        providerName: effectiveProvider,
      }),
    [effectiveProvider, providers],
  );
  const currentProviderInfo = providerCapabilities.providerInfo;
  // Default to true for backwards compatibility (except slash commands)
  const supportsPermissionMode =
    currentProviderInfo?.supportsPermissionMode ?? true;
  const supportsThinkingToggle =
    currentProviderInfo?.supportsThinkingToggle ?? true;
  const { generallySupportsSteering, supportsSteerNow } = providerCapabilities;
  const liveThinkingSelection = useMemo(() => {
    if (status.owner !== "self" || !effectiveModelConfig) {
      return null;
    }
    return liveThinkingSelectionFromProcess(
      effectiveModelConfig.thinking,
      effectiveModelConfig.effort,
      currentProviderInfo,
    );
  }, [currentProviderInfo, effectiveModelConfig, status.owner]);
  const getImplicitComposerThinking = useCallback(() => {
    const hasRetainedSessionModelConfig =
      status.owner === "self" ||
      liveModelConfig !== null ||
      session?.effectiveModelSettings !== undefined;
    if (hasRetainedSessionModelConfig) {
      if (!effectiveModelConfig) {
        return undefined;
      }
      return thinkingOptionFromProcess(
        effectiveModelConfig.thinking,
        effectiveModelConfig.effort,
        currentProviderInfo,
      );
    }
    return getThinkingSetting();
  }, [
    currentProviderInfo,
    effectiveModelConfig,
    liveModelConfig,
    session?.effectiveModelSettings,
    status.owner,
  ]);

  // Unified Clone/Fork requires both the provider primitive and the server's
  // real-user-turn intent resolver. Older servers get no unsupported request.
  const forkAvailability = getUnifiedSessionForkAvailability(
    versionInfo,
    currentProviderInfo?.supportsForkSession,
    effectiveProvider,
  );
  const supportsForkFromTurn = forkAvailability.available;
  const forkUnavailableMessage =
    !forkAvailability.available &&
    forkAvailability.reason === "server-missing-codex-lineage"
      ? t("codexForkServerUpdateRequired")
      : undefined;
  const forkAfterDisabled =
    status.owner === "external" ||
    processState === "in-turn" ||
    processState === "waiting-input";
  const submitForkAfterSummary = useCallback(
    async (sourceMessageId: string, instructions: string) => {
      const requestSessionId = actualSessionId;
      if (
        forkSummaryStartPendingRef.current.has(requestSessionId) ||
        session?.transcriptDisplayObjects?.some(
          (object) => object.status === "generating",
        )
      ) {
        return;
      }
      forkSummaryStartPendingRef.current.add(requestSessionId);
      const autoOpenDefault = getForkSummaryAutoOpen();
      draftControlsRef.current?.clearDraft();
      setForkSummaryDraft(null);
      showToast(t("forkSummaryStarted"), "info");
      try {
        const result = await api.forkSessionWithSummary(
          projectId,
          requestSessionId,
          {
            sourceMessageId,
            instructions,
            mode: permissionMode,
            autoOpenWhenReady: autoOpenDefault,
          },
        );
        initiatedForkSummaryAutoOpenRef.current.set(
          result.displayObject.id,
          autoOpenDefault,
        );
        updateTranscriptDisplayObjectsForSession(requestSessionId, (objects) =>
          objects.some((object) => object.id === result.displayObject.id)
            ? [...objects]
            : [...objects, result.displayObject],
        );
      } catch (err) {
        showToast(
          err instanceof Error ? err.message : t("forkSummaryFailed"),
          "error",
        );
      } finally {
        forkSummaryStartPendingRef.current.delete(requestSessionId);
      }
    },
    [
      actualSessionId,
      permissionMode,
      projectId,
      session?.transcriptDisplayObjects,
      showToast,
      t,
      updateTranscriptDisplayObjectsForSession,
    ],
  );
  const submitForkAfterWithoutSummary = useCallback(
    async (sourceMessageId: string, nextTurnText: string) => {
      if (attachments.length > 0 || uploadProgress.length > 0) {
        showToast(t("forkSummaryAttachmentsUnsupported"), "error");
        return;
      }
      if (forkAfterDisabled) {
        showToast(t("forkAfterTurnPending"), "error");
        return;
      }

      draftControlsRef.current?.clearDraft();
      setForkSummaryDraft(null);
      try {
        const result = await api.forkSession(projectId, actualSessionId, {
          forkKind: "after-user-turn",
          sourceMessageId,
        });
        if (nextTurnText.trim()) {
          await api.queueMessage(
            result.sessionId,
            nextTurnText,
            permissionMode,
          );
        }
        showToast(t("forkFromTurnStarted"), "success");
        navigate(
          `${basePath}/projects/${projectId}/sessions/${result.sessionId}`,
        );
      } catch (error) {
        showToast(
          error instanceof Error ? error.message : t("sessionRestartFailed"),
          "error",
        );
      }
    },
    [
      actualSessionId,
      attachments.length,
      basePath,
      navigate,
      permissionMode,
      projectId,
      forkAfterDisabled,
      showToast,
      t,
      uploadProgress.length,
    ],
  );
  const createDirectTurnFork = useCallback(
    async (
      sourceMessageId: string,
      forkKind: "before-user-turn" | "after-user-turn",
    ) => {
      if (forkKind === "after-user-turn" && forkAfterDisabled) {
        showToast(t("forkAfterTurnPending"), "error");
        return;
      }
      try {
        const result = await api.forkSession(projectId, actualSessionId, {
          forkKind,
          sourceMessageId,
        });
        showToast(t("forkFromTurnStarted"), "success");
        navigate(
          `${basePath}/projects/${projectId}/sessions/${result.sessionId}`,
        );
      } catch (error) {
        showToast(
          error instanceof Error ? error.message : t("sessionRestartFailed"),
          "error",
        );
      }
    },
    [
      actualSessionId,
      basePath,
      forkAfterDisabled,
      navigate,
      projectId,
      showToast,
      t,
    ],
  );
  const cloneSession = useCallback(async () => {
    if (forkAfterDisabled) {
      showToast(t("sessionMenuCloneDisabled"), "error");
      return;
    }
    try {
      const result = await api.forkSession(projectId, actualSessionId, {
        forkKind: "clone-latest-complete",
      });
      showToast(t("sessionCloneCreated"), "success");
      navigate(
        `${basePath}/projects/${projectId}/sessions/${result.sessionId}`,
      );
    } catch (error) {
      showToast(
        error instanceof Error ? error.message : t("sessionCloneFailed"),
        "error",
      );
    }
  }, [
    actualSessionId,
    basePath,
    forkAfterDisabled,
    navigate,
    projectId,
    showToast,
    t,
  ]);
  const cancelForkSummaryJob = useCallback(
    async (objectId: string) => {
      const requestSessionId = actualSessionId;
      try {
        const result = await api.cancelForkSessionWithSummary(
          projectId,
          requestSessionId,
          objectId,
        );
        initiatedForkSummaryAutoOpenRef.current.delete(objectId);
        updateTranscriptDisplayObjectsForSession(
          requestSessionId,
          () => result.transcriptDisplayObjects,
        );
      } catch (error) {
        showToast(
          error instanceof Error ? error.message : t("forkSummaryFailed"),
          "error",
        );
      }
    },
    [
      actualSessionId,
      projectId,
      showToast,
      t,
      updateTranscriptDisplayObjectsForSession,
    ],
  );
  const setForkSummaryAutoOpen = useCallback(
    async (objectId: string, next: boolean) => {
      const requestSessionId = actualSessionId;
      initiatedForkSummaryAutoOpenRef.current.set(objectId, next);
      updateTranscriptDisplayObjectsForSession(requestSessionId, (objects) =>
        objects.map((object) =>
          object.id === objectId
            ? { ...object, autoOpenWhenReady: next || undefined }
            : object,
        ),
      );
      try {
        const result = await api.updateForkSummaryDisplayObject(
          projectId,
          requestSessionId,
          objectId,
          { autoOpenWhenReady: next },
        );
        updateTranscriptDisplayObjectsForSession(
          requestSessionId,
          () => result.transcriptDisplayObjects,
        );
      } catch (error) {
        showToast(
          error instanceof Error ? error.message : t("forkSummaryFailed"),
          "error",
        );
      }
    },
    [
      actualSessionId,
      projectId,
      showToast,
      t,
      updateTranscriptDisplayObjectsForSession,
    ],
  );
  const followForkSummary = useCallback(
    (objectId: string) => {
      const requestSessionId = actualSessionId;
      void api
        .updateForkSummaryDisplayObject(projectId, requestSessionId, objectId, {
          action: "clicked",
        })
        .then((result) => {
          updateTranscriptDisplayObjectsForSession(
            requestSessionId,
            () => result.transcriptDisplayObjects,
          );
        })
        .catch(() => {});
    },
    [actualSessionId, projectId, updateTranscriptDisplayObjectsForSession],
  );
  const getForkSummaryTargetHref = useCallback(
    (targetSessionId: string) =>
      `${window.location.origin}${basePath}/projects/${projectId}/sessions/${targetSessionId}`,
    [basePath, projectId],
  );
  // Stable identities for props passed into the memoized MessageList. Inline
  // arrows here re-render the whole (un-virtualized) transcript on every
  // per-second SessionPage tick; see topics/transcript-virtualization.md.
  const handleCancelForkSummary = useCallback(
    (objectId: string) => {
      void cancelForkSummaryJob(objectId);
    },
    [cancelForkSummaryJob],
  );
  const handleToggleForkSummaryAutoOpen = useCallback(
    (objectId: string, value: boolean) => {
      void setForkSummaryAutoOpen(objectId, value);
    },
    [setForkSummaryAutoOpen],
  );
  useEffect(() => {
    for (const object of session?.transcriptDisplayObjects ?? []) {
      if (
        object.status !== "ready" ||
        !object.targetSessionId ||
        object.openedAt ||
        attemptedForkSummaryAutoOpenRef.current.has(object.id) ||
        initiatedForkSummaryAutoOpenRef.current.get(object.id) !== true ||
        object.autoOpenWhenReady !== true
      ) {
        continue;
      }
      attemptedForkSummaryAutoOpenRef.current.add(object.id);
      try {
        const opened = window.open(
          getForkSummaryTargetHref(object.targetSessionId),
          "_blank",
        );
        if (!opened) {
          continue;
        }
        opened.opener = null;
        void api
          .updateForkSummaryDisplayObject(
            projectId,
            actualSessionId,
            object.id,
            { action: "opened" },
          )
          .then((result) => {
            updateTranscriptDisplayObjectsForSession(
              actualSessionId,
              () => result.transcriptDisplayObjects,
            );
          })
          .catch(() => {});
      } catch {
        // Popup blocking leaves the durable follow link available.
      }
    }
  }, [
    actualSessionId,
    getForkSummaryTargetHref,
    projectId,
    session?.transcriptDisplayObjects,
    updateTranscriptDisplayObjectsForSession,
  ]);
  const beginForkAfterSummary = useCallback(
    (messageId: string) => {
      if (attachments.length > 0 || uploadProgress.length > 0) {
        showToast(t("forkSummaryAttachmentsUnsupported"), "error");
        return false;
      }
      if (forkAfterDisabled) {
        showToast(t("forkAfterTurnPending"), "error");
        return false;
      }
      setForkSummaryDraft({
        sourceMessageId: messageId,
      });
      draftControlsRef.current?.focus?.();
      return true;
    },
    [
      attachments.length,
      forkAfterDisabled,
      showToast,
      t,
      uploadProgress.length,
    ],
  );
  const beginForkAfterInitialTurn = useCallback(
    (instructions: string) => {
      if (attachments.length > 0 || uploadProgress.length > 0) {
        showToast(t("forkSummaryAttachmentsUnsupported"), "error");
        return false;
      }
      const firstUser = messages.find((message) => {
        if (message.type !== "user") return false;
        const text = turnContentText(message.message?.content);
        return !isLegacyCodexSetupText(text, [message]);
      });
      const firstUserId = messageKey(firstUser);
      if (!firstUserId) {
        showToast(t("forkAfterTurnNoAnchor"), "error");
        return false;
      }
      if (forkAfterDisabled) {
        showToast(t("forkAfterTurnPending"), "error");
        return false;
      }
      if (instructions.trim()) {
        void submitForkAfterSummary(firstUserId, instructions.trim());
        return true;
      }
      setForkSummaryDraft({
        sourceMessageId: firstUserId,
      });
      draftControlsRef.current?.focus?.();
      return true;
    },
    [
      attachments.length,
      forkAfterDisabled,
      messages,
      showToast,
      submitForkAfterSummary,
      t,
      uploadProgress.length,
    ],
  );
  const forkBeforeUserMessage = useCallback(
    (messageId: string) => createDirectTurnFork(messageId, "before-user-turn"),
    [createDirectTurnFork],
  );
  const forkAfterUserMessage = useCallback(
    (messageId: string) => createDirectTurnFork(messageId, "after-user-turn"),
    [createDirectTurnFork],
  );
  const copyUserMessage = useCallback(
    (messageId: string) => {
      const msg = messages.find((m) => (m.uuid ?? m.id) === messageId);
      const text = turnContentText(msg?.message?.content).trim();
      if (!text) return;
      void navigator.clipboard?.writeText(text).catch((err) => {
        console.error("Failed to copy turn:", err);
      });
    },
    [messages],
  );
  const activityRenderItems = useMemo(
    () => getCachedWebTranscriptProjection(messages),
    [messages],
  );
  const sessionActivityUi = useMemo(
    () =>
      getSessionActivityUiState({
        owner: status.owner,
        processState,
        items: activityRenderItems,
        messages,
        sessionLiveness,
        hasSessionUpdateStream,
        sessionUpdatesConnected,
      }),
    [
      activityRenderItems,
      hasSessionUpdateStream,
      messages,
      processState,
      sessionLiveness,
      sessionUpdatesConnected,
      status.owner,
    ],
  );
  const canStopOwnedProcess = sessionActivityUi.canStopOwnedProcess;
  const shouldDeferMessages = sessionActivityUi.shouldDeferMessages;
  const primaryComposerAction =
    shouldDeferMessages && generallySupportsSteering
      ? "steer"
      : shouldDeferMessages
        ? "queue"
        : "send";

  useEffect(() => {
    let cancelled = false;

    if (!currentOwnedProcessId) {
      setLiveModelConfigSnapshot(null);
      return;
    }

    api
      .getProcessInfo(actualSessionId)
      .then((res) => {
        if (cancelled) return;
        const process = res.process;
        if (process?.id === currentOwnedProcessId) {
          setLiveModelConfigSnapshot({
            processId: currentOwnedProcessId,
            config: {
              model: process.model,
              requestedModel: process.requestedModel,
              thinking: process.thinking,
              effort: process.effort,
              promptSuggestionMode: process.promptSuggestionMode,
            },
          });
        } else {
          setLiveModelConfigSnapshot((current) =>
            current?.processId === currentOwnedProcessId ? null : current,
          );
        }
        if (process?.recapAfterSeconds !== undefined) {
          setStatus((prev) =>
            prev.owner === "self" && prev.processId === process.id
              ? { ...prev, recapAfterSeconds: process.recapAfterSeconds }
              : prev,
          );
        }
      })
      .catch(() => {
        if (cancelled) return;
        setLiveModelConfigSnapshot((current) =>
          current?.processId === currentOwnedProcessId ? null : current,
        );
      });

    return () => {
      cancelled = true;
    };
  }, [actualSessionId, currentOwnedProcessId, setStatus]);

  useEffect(() => {
    if (!actualSessionId) return;
    setLiveModelConfigSnapshot(null);
  }, [actualSessionId]);

  const publicShareInitialPrompt = useMemo(
    () => getPublicShareInitialPrompt(messages),
    [messages],
  );

  // Inline title editing state
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [titleEditMode, setTitleEditMode] = useState<TitleEditMode>("manual");
  const [renameValue, setRenameValue] = useState("");
  const [isRenaming, setIsRenaming] = useState(false);
  const [generatedRetitle, setGeneratedRetitle] =
    useState<GeneratedRetitleState | null>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const titleEditControlsRef = useRef<HTMLDivElement>(null);
  const isSavingTitleRef = useRef(false);
  const retitleRequestIdRef = useRef(0);
  const generatedRetitleRef = useRef<GeneratedRetitleState | null>(null);

  // Recent sessions dropdown state
  const [showRecentSessions, setShowRecentSessions] = useState(false);
  const titleRowRef = useRef<HTMLDivElement>(null);
  const [showProjectReclassifyMenu, setShowProjectReclassifyMenu] =
    useState(false);
  const [isReclassifyingProject, setIsReclassifyingProject] = useState(false);
  const projectBreadcrumbRef = useRef<HTMLAnchorElement>(null);
  const projectReclassifyMenuRef = useRef<HTMLDivElement>(null);

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
  const [localHeartbeatTurnsEnabled, setLocalHeartbeatTurnsEnabled] = useState<
    boolean | undefined
  >(undefined);
  const [localHeartbeatTurnsAfterMinutes, setLocalHeartbeatTurnsAfterMinutes] =
    useState<number | undefined>(undefined);
  const [localHeartbeatTurnText, setLocalHeartbeatTurnText] = useState<
    string | undefined
  >(undefined);
  const [localHeartbeatForceAfterMinutes, setLocalHeartbeatForceAfterMinutes] =
    useState<number | undefined>(undefined);
  const [localPromptSuggestionMode, setLocalPromptSuggestionMode] = useState<
    PromptSuggestionMode | undefined
  >(undefined);
  const [localHasUnread, setLocalHasUnread] = useState<boolean | undefined>(
    undefined,
  );

  useEffect(() => {
    generatedRetitleRef.current = generatedRetitle;
  }, [generatedRetitle]);

  // Reset local metadata state when sessionId changes
  useEffect(() => {
    void sessionId;
    setLocalCustomTitle(undefined);
    setLocalIsArchived(undefined);
    setLocalIsStarred(undefined);
    setLocalHeartbeatTurnsEnabled(undefined);
    setLocalHeartbeatTurnsAfterMinutes(undefined);
    setLocalHeartbeatTurnText(undefined);
    setLocalHeartbeatForceAfterMinutes(undefined);
    setLocalPromptSuggestionMode(undefined);
    setLocalHasUnread(undefined);
  }, [sessionId]);

  const projectReclassifyOptions = useMemo(
    () =>
      projects
        .filter((candidate) => candidate.id !== projectId)
        .sort((a, b) => a.name.localeCompare(b.name)),
    [projectId, projects],
  );

  useEffect(() => {
    if (isDomLingerParked || !showProjectReclassifyMenu) return;

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (
        projectBreadcrumbRef.current?.contains(target) ||
        projectReclassifyMenuRef.current?.contains(target)
      ) {
        return;
      }
      setShowProjectReclassifyMenu(false);
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setShowProjectReclassifyMenu(false);
      }
    };

    document.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [isDomLingerParked, showProjectReclassifyMenu]);

  const handleProjectBreadcrumbContextMenu = useCallback(
    (event: ReactMouseEvent<HTMLAnchorElement>) => {
      event.preventDefault();
      event.stopPropagation();
      if (projectReclassifyOptions.length === 0) {
        return;
      }
      setShowRecentSessions(false);
      setShowProjectReclassifyMenu(true);
    },
    [projectReclassifyOptions.length],
  );

  const handleReclassifySessionProject = useCallback(
    async (targetProject: Project) => {
      if (targetProject.id === projectId || isReclassifyingProject) {
        return;
      }

      setIsReclassifyingProject(true);
      try {
        const result = await api.reclassifySessionProject(
          projectId,
          actualSessionId,
          targetProject.id,
        );
        activityBus.emitLocal("session-metadata-changed", {
          type: "session-metadata-changed",
          sessionId: actualSessionId,
          projectId: result.projectId,
          transcriptProjectId: result.transcriptProjectId,
          timestamp: new Date().toISOString(),
        });
        setShowProjectReclassifyMenu(false);
        showToast(
          t("sessionReclassifiedProject", { project: targetProject.name }),
          "success",
        );
        navigate(
          `${basePath}/projects/${result.projectId}/sessions/${actualSessionId}${location.search}`,
          {
            replace: true,
            state: location.state,
          },
        );
      } catch (err) {
        console.error("Failed to move session to project:", err);
        showToast(t("sessionReclassifyProjectFailed"), "error");
      } finally {
        setIsReclassifyingProject(false);
      }
    },
    [
      actualSessionId,
      basePath,
      isReclassifyingProject,
      location.search,
      location.state,
      navigate,
      projectId,
      showToast,
      t,
    ],
  );

  // Record session visit for recents tracking
  useEffect(() => {
    recordSessionVisit(sessionId, projectId);
  }, [sessionId, projectId]);

  // Navigate to new session ID when temp ID is replaced with real SDK session ID
  // This ensures the URL stays in sync with the actual session
  useEffect(() => {
    if (isDomLingerParked) {
      return;
    }
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
    isDomLingerParked,
  ]);

  // Navigate to the session reader canonical project when the API followed
  // a provider-native redirect from a stale project-scoped link.
  useEffect(() => {
    if (isDomLingerParked) {
      return;
    }
    const canonicalProjectId = session?.projectId;
    if (!canonicalProjectId || canonicalProjectId === projectId) {
      return;
    }

    navigate(
      `${basePath}/projects/${canonicalProjectId}/sessions/${actualSessionId}${location.search}`,
      {
        replace: true,
        state: location.state,
      },
    );
  }, [
    actualSessionId,
    basePath,
    location.search,
    location.state,
    navigate,
    projectId,
    isDomLingerParked,
    session?.projectId,
  ]);

  useEffect(() => {
    void sessionId;
    setCorrectionDraft(null);
    setComposerAttachments([], {
      persistDraft: false,
      revokeRemovedPreviewUrls: true,
    });
    resetBtwAsides();
    lastComposerSubmissionRef.current = null;
    lastSentComposerSubmissionRef.current = null;
    draftAttachmentBatchIdRef.current = null;
    draftAttachmentHydrationRef.current += 1;
  }, [resetBtwAsides, sessionId, setComposerAttachments]);

  const handleCancelCorrection = useCallback(() => {
    setCorrectionDraft(null);
    draftControlsRef.current?.clearDraft();
    setComposerAttachments([], { revokeRemovedPreviewUrls: true });
  }, [setComposerAttachments]);

  const handleCorrectLatestUserMessage = useCallback(
    (messageId: string, content: string) => {
      const draftControls = draftControlsRef.current;
      if (!draftControls) {
        showToast(
          t("sessionCorrectionEditFailed", {
            message: "Composer is not available",
          }),
          "error",
        );
        return;
      }

      draftControls.setDraft(content);
      setComposerAttachments([], { revokeRemovedPreviewUrls: true });
      setCorrectionDraft({ messageId, originalText: content });
    },
    [setComposerAttachments, showToast, t],
  );

  const getOutgoingMessageText = useCallback(
    (text: string): string | null => {
      if (!correctionDraft) {
        return text;
      }

      const correctionText = buildCorrectionText(
        correctionDraft.originalText,
        text,
      );
      if (!correctionText) {
        draftControlsRef.current?.setDraft(text);
        showToast(t("sessionCorrectionNoChanges"), "info");
        return null;
      }
      return correctionText;
    },
    [correctionDraft, showToast, t],
  );

  const prepareComposerSubmission = (
    text: string,
  ): PreparedComposerSubmission | null => {
    // Recalling a turn and editing its slash command means "issue this command
    // again", not "correct my last sentence". Correction framing prepends a
    // line, which pushes `/goal ...` off offset 0 so the provider sends the
    // command through as prose, and a stripping command like `/fast ...` would
    // diff its bare argument against the unstripped original. So the whole
    // submission below behaves as a fresh invocation, including re-issuing an
    // unedited command the way shell history does. The decision reads the raw
    // composer text because `resolveComposerSlashTurn` has already consumed the
    // leading token by the time the outgoing text is built.
    const issuesSlashCommand =
      !!correctionDraft && startsWithSlashCommand(text);
    const outgoingTextFor = (candidate: string): string | null =>
      issuesSlashCommand ? candidate : getOutgoingMessageText(candidate);
    // Commands YA runs itself never reach the send path that ends correction
    // mode, so clear it here or the banner would outlive the command and wrap
    // the next ordinary message.
    const endCorrectionForLocalCommand = () => {
      if (issuesSlashCommand) {
        setCorrectionDraft(null);
      }
    };

    const slashTurn = resolveComposerSlashTurn(text);
    if (slashTurn.kind === "custom") {
      const sessionOperation = resolveComposerSessionOperation({
        text,
        routesToFocusedAside: false,
        syntheticDoneEnabled,
        syntheticDoneSupported: supportsSyntheticDone,
        syntheticArchiveSupported: supportsSyntheticArchive,
        syntheticTerminateSupported: supportsSyntheticTerminate,
        hasAttachments:
          attachmentsRef.current.length > 0 ||
          pendingUploadsRef.current.size > 0,
      });
      if (sessionOperation.kind === "blocked") {
        draftControlsRef.current?.setDraft(text);
        showToast(sessionOperation.message, "error");
        return null;
      }
      if (sessionOperation.kind === "session-boundary") {
        endCorrectionForLocalCommand();
        void handleSyntheticSessionBoundary(sessionOperation.command);
        return null;
      }
      if (sessionOperation.kind === "title") {
        endCorrectionForLocalCommand();
        void handleLocalTitleCommand(sessionOperation.title);
        return null;
      }
      if (slashTurn.command === "btw" && !supportsBtwAsides) {
        draftControlsRef.current?.setDraft(text);
        showToast(
          "/btw asides are available only for providers with a wired fork path.",
          "error",
        );
        return null;
      }
      if (handleCustomCommand(slashTurn.command, slashTurn.argument)) {
        endCorrectionForLocalCommand();
        return null;
      }
      const outgoingText = outgoingTextFor(text);
      return outgoingText ? { outgoingText } : null;
    }

    if (slashTurn.kind === "error") {
      draftControlsRef.current?.setDraft(text);
      showToast(slashTurn.message, "error");
      return null;
    }

    const outgoingText = outgoingTextFor(slashTurn.text);
    if (
      outgoingText === null ||
      !hasComposerDraftContent(outgoingText, attachmentsRef.current.length)
    ) {
      return null;
    }

    return {
      outgoingText,
      thinking: slashTurn.thinking,
      slashCommand: slashTurn.command,
    };
  };

  // Approval panel collapsed state (separate from message input collapse)
  const [approvalCollapsed, setApprovalCollapsed] = useState(false);

  const [showHeartbeatModal, setShowHeartbeatModal] = useState(false);
  const [showProjectSettingsModal, setShowProjectSettingsModal] =
    useState(false);
  const [showRecapModal, setShowRecapModal] = useState(false);
  const [showShareModal, setShowShareModal] = useState(false);
  const [shareModalView, setShareModalView] = useState<"manage" | "session">(
    "session",
  );
  const [shareModalAnchor, setShareModalAnchor] =
    useState<ModalAnchorRect | null>(null);
  const canCreatePublicShares = publicShareGlobalStatus?.canCreate ?? false;
  const publicShareManagementAvailable = serverHasCapability(
    versionInfo,
    PUBLIC_SHARE_MANAGEMENT_CAPABILITY,
  );
  const publicShareActionAvailable =
    publicShareManagementAvailable || canCreatePublicShares;
  const [pendingElsewhereDismissedToolId, setPendingElsewhereDismissedToolId] =
    useState<string | null>(null);

  // Model switch modal state
  const [showModelSwitchModal, setShowModelSwitchModal] = useState(false);
  const [modelPanelInitialTab, setModelPanelInitialTab] = useState<
    "model" | "info"
  >("model");
  const [showHandoffModal, setShowHandoffModal] = useState(false);

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
    enabled: status.owner !== "external" && !isDomLingerParked,
  });

  const collectComposerAttachmentsForSubmission = useCallback(
    async (options?: { pendingMessageId?: string }) => {
      return collectComposerAttachmentsForSubmissionHelper({
        currentAttachments: attachmentsRef.current,
        pendingUploads: [...pendingUploadsRef.current.values()],
        setComposerAttachments,
        pendingMessageId: options?.pendingMessageId,
        updatePendingMessage,
        uploadingStatus: t("sessionUploading"),
      });
    },
    [setComposerAttachments, t, updatePendingMessage],
  );

  const handleSyntheticSessionBoundary = useCallback(
    async (command: "done" | "archive" | "terminate") => {
      try {
        const result =
          command === "terminate"
            ? await api.terminateSession(actualSessionId)
            : command === "archive"
              ? await api.archiveSession(actualSessionId)
              : await api.markSessionDone(actualSessionId);
        // The composer cleared the command optimistically but kept the
        // localStorage recovery copy. Without this the text is restored on
        // remount and the session keeps a "Draft" badge for a command it
        // already consumed.
        draftControlsRef.current?.confirmInputClear();
        if (command !== "done") {
          setLocalIsArchived(true);
          activityBus.emitLocal("session-metadata-changed", {
            type: "session-metadata-changed",
            sessionId: actualSessionId,
            archived: true,
            timestamp: new Date().toISOString(),
          });
        }
        if (result.deferredMessages) {
          setDeferredMessages(result.deferredMessages);
        }
        if (result.queued !== true) {
          await fetchNewMessages();
        }
        setScrollTrigger((previous) => previous + 1);
      } catch {
        draftControlsRef.current?.restoreFromStorage();
        showToast(
          t(
            command === "terminate"
              ? "syntheticTerminateFailed"
              : command === "archive"
                ? "syntheticArchiveFailed"
                : "syntheticDoneFailed",
          ),
          "error",
        );
      }
    },
    [actualSessionId, fetchNewMessages, setDeferredMessages, showToast, t],
  );

  const closeFocusedBtwAside = useCallback(
    (argument = "") => {
      if (!focusedBtwAside) {
        return false;
      }
      hideBtwAside(focusedBtwAside.id);
      if (argument.trim()) {
        // Report-back drafting (/done <text>, /done summary, /done file ...)
        // is described in topics/provider-agnostic-btw-asides.md but is not
        // wired yet; close-only for now.
        showToast(
          "Aside closed. (Report-back drafting not yet implemented.)",
          "info",
        );
      }
      return true;
    },
    [focusedBtwAside, hideBtwAside, showToast],
  );

  const handleDoneAction = useCallback(() => {
    const target = resolveComposerDoneTarget({
      text: "/done",
      routesToFocusedAside: mainComposerForAside,
      syntheticDoneEnabled,
      hasAttachments: false,
    });
    if (target === "focused-aside") {
      if (closeFocusedBtwAside()) {
        draftControlsRef.current?.confirmInputClear();
      }
      return;
    }
    if (target === "synthetic-session") {
      void handleSyntheticSessionBoundary("done");
    }
  }, [
    closeFocusedBtwAside,
    handleSyntheticSessionBoundary,
    mainComposerForAside,
    syntheticDoneEnabled,
  ]);

  const handleSend = async (
    text: string,
    metadata?: MessageSubmissionMetadata,
    options: { preserveComposer?: boolean; localControl?: boolean } = {},
  ): Promise<boolean> => {
    const prepared: PreparedComposerSubmission | null = options.localControl
      ? { outgoingText: text }
      : prepareComposerSubmission(text);
    if (!prepared) {
      return false;
    }
    const preserveComposer = options.preserveComposer === true;
    const { outgoingText, slashCommand } = prepared;
    const localControl =
      options.localControl ||
      (goalDetails?.goalStatus !== undefined &&
        /^\/goal(?:\s|$)/i.test(outgoingText));
    if (
      !preserveComposer &&
      requiresAttachmentOnlyServerUpdate({
        version: versionInfo,
        text: outgoingText,
        attachmentCount: attachmentsRef.current.length,
      })
    ) {
      showToast(t("attachmentOnlyRequiresServerUpdate"), "error");
      return false;
    }
    const thinking = prepared.thinking ?? getImplicitComposerThinking();
    // Display preference for thinking rows; sent for compatibility while the
    // server requests provider summaries independently.
    const showThinking = getShowThinkingSetting();
    const actionAtMs = Date.now();
    const clientTimestamp = getServerClockTimestamp(actionAtMs);
    const clientTimestampIso = new Date(clientTimestamp).toISOString();

    // Add to pending queue and get tempId to pass to server
    const { tempId } = addPendingMessage(
      outgoingText,
      undefined,
      clientTimestampIso,
    );
    if (!localControl) {
      setProcessState("in-turn"); // Optimistic: show processing indicator immediately
      setScrollTrigger((prev) => prev + 1); // Force scroll to bottom
    }
    logSessionUiTrace("composer-send-start", {
      sessionId,
      projectId,
      tempId,
      owner: status.owner,
      processId: status.owner === "self" ? status.processId : null,
      permissionMode,
      thinking,
      slashCommand: slashCommand ?? null,
      textLength: outgoingText.length,
      attachmentCount: preserveComposer ? 0 : attachments.length,
      hasCorrectionDraft: preserveComposer ? false : !!correctionDraft,
      clientTimestamp,
      serverOffsetMs: getEstimatedServerOffsetMs(),
    });

    let currentAttachments = preserveComposer
      ? []
      : [...attachmentsRef.current];
    let uploadedAttachments: UploadedFile[] = [];

    try {
      if (!preserveComposer) {
        currentAttachments = await collectComposerAttachmentsForSubmission({
          pendingMessageId: tempId,
        });
        uploadedAttachments =
          await materializeComposerAttachments(currentAttachments);
      }
      if (uploadedAttachments.length > 0) {
        updatePendingMessage(tempId, { attachments: uploadedAttachments });
      }

      const requestSentAtMs = Date.now();
      if (status.owner === "none") {
        // Resume the session with current permission mode and model settings
        // Use session's existing model if available (important for non-Claude providers),
        // otherwise fall back to user's model preference for new Claude sessions
        const model = session?.model ?? getModelSetting();
        // Use effectiveProvider to ensure correct provider even if session data hasn't loaded
        // effectiveProvider = session?.provider ?? initialProvider (from navigation state)
        const result = await api.resumeSession(
          projectId,
          sessionId,
          outgoingText,
          {
            mode: permissionMode,
            model,
            thinking,
            showThinking,
            provider: effectiveProvider,
            executor: session?.executor,
          },
          uploadedAttachments.length > 0 ? uploadedAttachments : undefined,
          tempId,
          clientTimestamp,
          metadata,
        );
        const responseReceivedAtMs = Date.now();
        const timing = recordServerClockSample({
          clientRequestStartMs: requestSentAtMs,
          clientResponseEndMs: responseReceivedAtMs,
          serverTimestamp: result.serverTimestamp,
        });
        // Update status to trigger SSE connection
        logSessionUiTrace("composer-send-resume-success", {
          sessionId,
          tempId,
          processId: result.processId,
          clientTimestamp,
          serverTimestamp: result.serverTimestamp,
          uploadWaitMs: requestSentAtMs - actionAtMs,
          requestRttMs: timing?.roundTripMs ?? null,
          estimatedServerOffsetMs: timing?.serverOffsetMs ?? null,
          clientToServerLatencyMs: measureServerLatencyMs(
            clientTimestamp,
            result.serverTimestamp,
          ),
        });
        setStatus({
          owner: "self",
          processId: result.processId,
          permissionMode: result.permissionMode,
          appliedPermissionMode: result.appliedPermissionMode,
          modeVersion: result.modeVersion,
          recapAfterSeconds: result.recapAfterSeconds,
        });
      } else {
        // Queue to existing process with current permission mode and thinking setting
        const result = await api.queueMessage(
          sessionId,
          outgoingText,
          permissionMode,
          uploadedAttachments.length > 0 ? uploadedAttachments : undefined,
          tempId,
          thinking,
          undefined, // deferred
          clientTimestamp,
          metadata,
          undefined, // serviceTier
          showThinking,
        );
        const responseReceivedAtMs = Date.now();
        const timing = recordServerClockSample({
          clientRequestStartMs: requestSentAtMs,
          clientResponseEndMs: responseReceivedAtMs,
          serverTimestamp: result.serverTimestamp,
        });
        logSessionUiTrace("composer-send-queue-success", {
          sessionId,
          tempId,
          restarted: !!result.restarted,
          processId: result.processId ?? null,
          clientTimestamp,
          serverTimestamp: result.serverTimestamp,
          uploadWaitMs: requestSentAtMs - actionAtMs,
          requestRttMs: timing?.roundTripMs ?? null,
          estimatedServerOffsetMs: timing?.serverOffsetMs ?? null,
          clientToServerLatencyMs: measureServerLatencyMs(
            clientTimestamp,
            result.serverTimestamp,
          ),
        });
        if (result.compactQueued) {
          setIsCompacting(true);
        }
        // If process was restarted due to thinking mode change, reconnect stream
        const restartedProcessId = result.restarted ? result.processId : null;
        if (restartedProcessId) {
          setStatus((prev) =>
            prev.owner === "self"
              ? { ...prev, processId: restartedProcessId }
              : { owner: "self", processId: restartedProcessId },
          );
          reconnectStream();
        }
      }
      // Success - clear the draft from localStorage
      if (!preserveComposer) {
        rememberSentSubmission(text, tempId);
        draftControlsRef.current?.confirmInputClear();
        revokeAttachmentPreviewUrls(currentAttachments);
        setCorrectionDraft(null);
        clearQuoteAnchors();
      }
      return true;
    } catch (err) {
      console.error("Failed to send:", err);
      let finalError: unknown = err;
      logSessionUiTrace("composer-send-error", {
        sessionId,
        tempId,
        message: err instanceof Error ? err.message : String(err),
      });

      // Check if process is dead (404) - auto-retry with resumeSession
      const is404 =
        err instanceof Error &&
        (err.message.includes("404") ||
          err.message.includes("No active process"));
      if (is404) {
        try {
          const model = session?.model ?? getModelSetting();
          const retryRequestSentAtMs = Date.now();
          const result = await api.resumeSession(
            projectId,
            sessionId,
            outgoingText,
            {
              mode: permissionMode,
              model,
              thinking,
              provider: effectiveProvider,
              executor: session?.executor,
            },
            uploadedAttachments.length > 0 ? uploadedAttachments : undefined,
            tempId,
            clientTimestamp,
            metadata,
          );
          const retryResponseReceivedAtMs = Date.now();
          const retryTiming = recordServerClockSample({
            clientRequestStartMs: retryRequestSentAtMs,
            clientResponseEndMs: retryResponseReceivedAtMs,
            serverTimestamp: result.serverTimestamp,
          });
          logSessionUiTrace("composer-send-retry-resume-success", {
            sessionId,
            tempId,
            processId: result.processId,
            clientTimestamp,
            serverTimestamp: result.serverTimestamp,
            uploadWaitMs: retryRequestSentAtMs - actionAtMs,
            requestRttMs: retryTiming?.roundTripMs ?? null,
            estimatedServerOffsetMs: retryTiming?.serverOffsetMs ?? null,
            clientToServerLatencyMs: measureServerLatencyMs(
              clientTimestamp,
              result.serverTimestamp,
            ),
          });
          setStatus({
            owner: "self",
            processId: result.processId,
            permissionMode: result.permissionMode,
            appliedPermissionMode: result.appliedPermissionMode,
            modeVersion: result.modeVersion,
            recapAfterSeconds: result.recapAfterSeconds,
          });
          if (!preserveComposer) {
            rememberSentSubmission(text, tempId);
            draftControlsRef.current?.confirmInputClear();
            revokeAttachmentPreviewUrls(currentAttachments);
            setCorrectionDraft(null);
            clearQuoteAnchors();
          }
          return true;
        } catch (retryErr) {
          console.error("Failed to resume session:", retryErr);
          finalError = retryErr;
          logSessionUiTrace("composer-send-retry-resume-error", {
            sessionId,
            tempId,
            message:
              retryErr instanceof Error ? retryErr.message : String(retryErr),
          });
          // Fall through to error handling below
        }
      }

      // Remove from pending queue and restore draft on error
      removePendingMessage(tempId);
      if (!preserveComposer) {
        draftControlsRef.current?.restoreFromStorage();
        setComposerAttachments(currentAttachments, { persistDraft: false });
      }
      if (!localControl) setProcessState("idle");
      const errorMsg =
        finalError instanceof Error ? finalError.message : String(finalError);
      if (
        requiresHandoffAfterClaudeResumeError(finalError, effectiveProvider)
      ) {
        setShowHandoffModal(true);
        showToast(
          errorMsg.includes("API error: 409")
            ? CLAUDE_HANDOFF_REQUIRED_MESSAGE
            : errorMsg,
          "error",
        );
      } else {
        showToast(t("sessionSendFailed", { message: errorMsg }), "error");
      }
      return false;
    }
  };
  const handleSendRef = useRef(handleSend);
  handleSendRef.current = handleSend;
  const handleSessionViewerCommentSend = useCallback(
    (text: string) =>
      handleSendRef.current(text, undefined, { preserveComposer: true }),
    [],
  );

  // !! bang commands: local shell runs in the project dir, never provider
  // ingress; persisted as transcript display objects (topics/bang-commands.md).
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const runBangCommand = useCallback(
    async (command: string) => {
      const currentMessages = messagesRef.current;
      const lastMessage = currentMessages[currentMessages.length - 1];
      const placementAfterMessageId = lastMessage
        ? ((lastMessage.uuid ?? lastMessage.id) as string | undefined) || ""
        : "";
      try {
        const result = await api.runBangCommand(
          projectId,
          sessionId,
          command,
          placementAfterMessageId,
        );
        updateTranscriptDisplayObjectsForSession(
          sessionId,
          () => result.transcriptDisplayObjects,
        );
        setScrollTrigger((prev) => prev + 1);
      } catch (error) {
        showToast(t("bangRunFailed"), "error");
        throw error;
      }
    },
    [
      projectId,
      sessionId,
      updateTranscriptDisplayObjectsForSession,
      showToast,
      t,
    ],
  );

  const echoBangCommand = useCallback(
    async (object: BangCommandTranscriptDisplayObject) => {
      try {
        const output = await api.fetchBangCommandOutput(
          projectId,
          sessionId,
          object.id,
        );
        await handleSendRef.current(buildBangEchoText(object, output));
      } catch {
        showToast(t("bangEchoFailed"), "error");
      }
    },
    [projectId, sessionId, showToast, t],
  );

  const bangCommandHandlers = useMemo<BangCommandHandlers>(
    () => ({
      onKill: (objectId) => {
        void api
          .killBangCommand(projectId, sessionId, objectId)
          .catch(() => {});
      },
      onDelete: (objectId) => {
        void api
          .deleteBangCommand(projectId, sessionId, objectId)
          .then((result) => {
            updateTranscriptDisplayObjectsForSession(
              sessionId,
              () => result.transcriptDisplayObjects,
            );
          })
          .catch(() => {});
      },
      onRerun: (command) => {
        void runBangCommand(command).catch(() => {});
      },
      onRecall: (command) => {
        draftControlsRef.current?.setDraft(`!!${command}`);
      },
      onEcho: (object) => {
        void echoBangCommand(object);
      },
      fetchOutput: (objectId) =>
        api.fetchBangCommandOutput(projectId, sessionId, objectId),
    }),
    [
      projectId,
      sessionId,
      runBangCommand,
      echoBangCommand,
      updateTranscriptDisplayObjectsForSession,
    ],
  );

  const bangHistory = useMemo(
    () => collectBangHistory(session?.transcriptDisplayObjects),
    [session?.transcriptDisplayObjects],
  );

  const composerBangSupport = useMemo(
    () => ({
      onRun: (command: string) => runBangCommand(command),
      fetchCompletions: (
        token: string,
        kind: "command" | "path",
        line: string,
      ) => api.fetchBangCompletions(projectId, token, kind, line),
      history: bangHistory,
    }),
    [projectId, runBangCommand, bangHistory],
  );

  // Incremental across renders: streaming ticks that only churn the assistant
  // tail cost a pointer-compare walk and return the same entries array.
  const composerTurnRecallCacheRef = useRef<ComposerTurnRecallCache | null>(
    null,
  );
  if (composerTurnRecallCacheRef.current === null) {
    composerTurnRecallCacheRef.current = createComposerTurnRecallCache();
  }
  const composerTurnRecallCache = composerTurnRecallCacheRef.current;
  const composerTurnRecallEntries = useMemo(
    () => composerTurnRecallCache.derive(messages),
    [composerTurnRecallCache, messages],
  );
  // Go-to-turn: the recall drawer row asks to scroll the transcript to a prior
  // user turn by its render id. Mirror the isearch jump path (which reaches
  // MessageList.scrollToRenderId) by handing MessageList a bumped request; it
  // resolves the id via findRenderRow. Token makes repeat jumps to the same id
  // distinct so the effect re-fires. See topics/composer-recall-drawer.md.
  const [scrollToTurnRequest, setScrollToTurnRequest] = useState<{
    id: string;
    token: number;
  } | null>(null);
  const handleGoToRecallTurn = useCallback((id: string) => {
    if (!id) {
      return;
    }
    setScrollToTurnRequest((previous) => ({
      id,
      token: (previous?.token ?? 0) + 1,
    }));
  }, []);
  const composerTurnRecall = useMemo(
    () => ({
      entries: composerTurnRecallEntries,
      onGoToTurn: handleGoToRecallTurn,
    }),
    [composerTurnRecallEntries, handleGoToRecallTurn],
  );

  // Bang-history per-entry actions arrive as navigation state (edit →
  // composerPrefill, new → focusComposer, jump → scrollToRenderId; see
  // topics/bang-commands.md § Top-level history view). Read off navState like
  // initialStatus/initialTitle, but these drive side effects: consumption is
  // keyed on location.key — one navigation consumes once, while a fresh
  // navigation to a still-mounted page (route retention) consumes again — and
  // we clear the consumed fields from history state so Back/refresh does not
  // replay them. Gated on !loading so the jump target row and the footer
  // composer are mounted before we act (draftControlsRef is populated during
  // commit, before this passive effect).
  const navComposerPrefill = navState?.composerPrefill;
  const navFocusComposer = navState?.focusComposer;
  const navScrollToRenderId = navState?.scrollToRenderId;
  const navActionsConsumedKeyRef = useRef<string | null>(null);
  useEffect(() => {
    const navigationKey = location.key ?? "keyless";
    if (navActionsConsumedKeyRef.current === navigationKey || loading) {
      return;
    }
    if (!navComposerPrefill && !navFocusComposer && !navScrollToRenderId) {
      return;
    }
    navActionsConsumedKeyRef.current = navigationKey;

    if (navComposerPrefill) {
      draftControlsRef.current?.setDraft(navComposerPrefill);
      draftControlsRef.current?.focus?.();
    } else if (navFocusComposer) {
      draftControlsRef.current?.focus?.();
    }

    if (navScrollToRenderId) {
      setScrollToTurnRequest((previous) => ({
        id: navScrollToRenderId,
        token: (previous?.token ?? 0) + 1,
      }));
    }

    // Drop the consumed action fields; preserve the seed fields (status/title/
    // model/provider) so an optimistic first render is unaffected.
    navigate(`${location.pathname}${location.search}`, {
      replace: true,
      state: createSessionNavigationState({
        ...(initialStatus ? { initialStatus } : {}),
        ...(initialTitle ? { initialTitle } : {}),
        ...(initialModel ? { initialModel } : {}),
        ...(initialProvider ? { initialProvider } : {}),
      }),
    });
  }, [
    loading,
    navComposerPrefill,
    navFocusComposer,
    navScrollToRenderId,
    navigate,
    location.key,
    location.pathname,
    location.search,
    initialStatus,
    initialTitle,
    initialModel,
    initialProvider,
  ]);

  const handleQueue = async (
    text: string,
    metadata?: MessageSubmissionMetadata,
  ) => {
    const prepared = prepareComposerSubmission(text);
    if (!prepared) {
      return;
    }
    const { outgoingText, slashCommand } = prepared;
    if (
      requiresAttachmentOnlyServerUpdate({
        version: versionInfo,
        text: outgoingText,
        attachmentCount: attachmentsRef.current.length,
      })
    ) {
      showToast(t("attachmentOnlyRequiresServerUpdate"), "error");
      return;
    }
    const thinking = prepared.thinking ?? getImplicitComposerThinking();
    // Display preference for thinking rows; sent for compatibility while the
    // server requests provider summaries independently.
    const showThinking = getShowThinkingSetting();
    const actionAtMs = Date.now();
    const clientTimestamp = getServerClockTimestamp(actionAtMs);

    // The queue path is not optimistic: no "Sending..." pending chip. The
    // composer disables for the round-trip and the queued chip renders from the
    // server's deferred-queue state (SSE event + this POST response). We still
    // mint a tempId so the server can echo this message back by identity.
    const tempId = `temp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    setScrollTrigger((prev) => prev + 1);
    logSessionUiTrace("composer-deferred-start", {
      sessionId,
      tempId,
      owner: status.owner,
      processId: status.owner === "self" ? status.processId : null,
      permissionMode,
      thinking,
      slashCommand: slashCommand ?? null,
      textLength: outgoingText.length,
      attachmentCount: attachments.length,
      clientTimestamp,
      serverOffsetMs: getEstimatedServerOffsetMs(),
    });

    let currentAttachments = [...attachmentsRef.current];
    let uploadedAttachments: UploadedFile[] = [];

    try {
      currentAttachments = await collectComposerAttachmentsForSubmission();
      uploadedAttachments =
        await materializeComposerAttachments(currentAttachments);
      const requestSentAtMs = Date.now();
      const result = await api.queueMessage(
        sessionId,
        outgoingText,
        permissionMode,
        uploadedAttachments.length > 0 ? uploadedAttachments : undefined,
        tempId,
        thinking,
        true, // deferred
        clientTimestamp,
        metadata,
        undefined, // serviceTier
        showThinking,
      );
      const responseReceivedAtMs = Date.now();
      const timing = recordServerClockSample({
        clientRequestStartMs: requestSentAtMs,
        clientResponseEndMs: responseReceivedAtMs,
        serverTimestamp: result.serverTimestamp,
      });
      logSessionUiTrace("composer-deferred-result", {
        sessionId,
        tempId,
        deferred: result.deferred ?? null,
        promoted: result.promoted ?? null,
        position: result.position ?? null,
        deferredCount: result.deferredMessages?.length ?? null,
        clientTimestamp,
        serverTimestamp: result.serverTimestamp,
        uploadWaitMs: requestSentAtMs - actionAtMs,
        requestRttMs: timing?.roundTripMs ?? null,
        estimatedServerOffsetMs: timing?.serverOffsetMs ?? null,
        clientToServerLatencyMs: measureServerLatencyMs(
          clientTimestamp,
          result.serverTimestamp,
        ),
      });
      // Mirror the server's authoritative queue from the response. The
      // deferred-queue SSE event reports the same thing; whichever lands last
      // wins, and both are server truth, so there is nothing to reconcile.
      setDeferredMessages(result.deferredMessages ?? []);
      if (result.deferred === false || result.promoted) {
        // Promoted straight into the active turn — treat it like a sent message
        // for composer recall.
        rememberSentSubmission(text, tempId);
      } else if (text.trim()) {
        lastComposerSubmissionRef.current = {
          kind: "queued",
          text: text.trim(),
          tempId,
        };
      }
      draftControlsRef.current?.confirmInputClear();
      revokeAttachmentPreviewUrls(currentAttachments);
      setCorrectionDraft(null);
      clearQuoteAnchors();
    } catch (err) {
      console.error("Failed to queue deferred message:", err);
      let finalError: unknown = err;
      logSessionUiTrace("composer-deferred-error", {
        sessionId,
        tempId,
        message: err instanceof Error ? err.message : String(err),
      });

      const isProcessUnavailable =
        err instanceof Error &&
        ((err as Error & { status?: number }).status === 404 ||
          (err as Error & { status?: number }).status === 410 ||
          err.message.includes("No active process") ||
          err.message.includes("Process terminated"));
      if (isProcessUnavailable) {
        try {
          const model = session?.model ?? getModelSetting();
          const result = await api.resumeSession(
            projectId,
            sessionId,
            outgoingText,
            {
              mode: permissionMode,
              model,
              thinking,
              provider: effectiveProvider,
              executor: session?.executor,
            },
            uploadedAttachments.length > 0 ? uploadedAttachments : undefined,
            tempId,
            clientTimestamp,
            metadata,
          );
          logSessionUiTrace("composer-deferred-retry-resume-success", {
            sessionId,
            tempId,
            processId: result.processId,
          });
          setStatus({
            owner: "self",
            processId: result.processId,
            permissionMode: result.permissionMode,
            appliedPermissionMode: result.appliedPermissionMode,
            modeVersion: result.modeVersion,
            recapAfterSeconds: result.recapAfterSeconds,
          });
          rememberSentSubmission(text, tempId);
          draftControlsRef.current?.confirmInputClear();
          revokeAttachmentPreviewUrls(currentAttachments);
          setCorrectionDraft(null);
          clearQuoteAnchors();
          return;
        } catch (retryErr) {
          console.error("Failed to resume session:", retryErr);
          finalError = retryErr;
          logSessionUiTrace("composer-deferred-retry-resume-error", {
            sessionId,
            tempId,
            message:
              retryErr instanceof Error ? retryErr.message : String(retryErr),
          });
        }
      }

      draftControlsRef.current?.restoreFromStorage();
      setComposerAttachments(currentAttachments, { persistDraft: false });
      const errorMsg =
        finalError instanceof Error ? finalError.message : String(finalError);
      if (
        requiresHandoffAfterClaudeResumeError(finalError, effectiveProvider)
      ) {
        setShowHandoffModal(true);
        showToast(
          errorMsg.includes("API error: 409")
            ? CLAUDE_HANDOFF_REQUIRED_MESSAGE
            : errorMsg,
          "error",
        );
      } else {
        showToast(t("sessionQueueFailed", { message: errorMsg }), "error");
      }
    }
  };

  const handleQueueRef = useRef(handleQueue);
  handleQueueRef.current = handleQueue;
  const executeComposerSend = useCallback(
    (text: string, metadata?: MessageSubmissionMetadata) =>
      handleSendRef.current(text, metadata),
    [],
  );
  const executeComposerDefer = useCallback(
    (text: string, metadata?: MessageSubmissionMetadata) =>
      handleQueueRef.current(text, metadata),
    [],
  );
  useEffect(() => {
    if (!isSemanticUiActionHarnessEnabled()) return undefined;
    return registerSemanticUiComposerExecutors(
      clientSummarySourceKey,
      sessionId,
      {
        send: executeComposerSend,
        defer: executeComposerDefer,
      },
    );
  }, [
    clientSummarySourceKey,
    executeComposerDefer,
    executeComposerSend,
    sessionId,
  ]);
  const handleSemanticComposerSend = useCallback(
    (text: string, metadata?: MessageSubmissionMetadata) =>
      executeSemanticUiComposerAction(
        clientSummarySourceKey,
        sessionId,
        "send",
        text,
        metadata,
        executeComposerSend,
      ),
    [clientSummarySourceKey, executeComposerSend, sessionId],
  );
  const handleSemanticComposerDefer = useCallback(
    (text: string, metadata?: MessageSubmissionMetadata) =>
      executeSemanticUiComposerAction(
        clientSummarySourceKey,
        sessionId,
        "defer",
        text,
        metadata,
        executeComposerDefer,
      ),
    [clientSummarySourceKey, executeComposerDefer, sessionId],
  );

  const queueComposerForProject = async (
    text: string,
    targetType: "existing-session" | "new-session",
    metadata?: MessageSubmissionMetadata,
  ) => {
    const prepared = prepareComposerSubmission(text);
    if (!prepared) {
      return;
    }
    const { outgoingText, slashCommand } = prepared;
    const thinking = prepared.thinking ?? getImplicitComposerThinking();
    const showThinking = getShowThinkingSetting();
    const actionAtMs = Date.now();
    const clientTimestamp = getServerClockTimestamp(actionAtMs);

    let currentAttachments = [...attachmentsRef.current];
    let uploadedAttachments: UploadedFile[] = [];
    let stagedAttachments: ProjectQueueStagedAttachments | undefined;

    try {
      currentAttachments = await collectComposerAttachmentsForSubmission();
      if (targetType === "new-session") {
        const splitAttachments =
          splitComposerAttachmentsForSubmission(currentAttachments);
        uploadedAttachments = splitAttachments.uploadedFiles;
        stagedAttachments = splitAttachments.draftState ?? undefined;
      } else {
        uploadedAttachments =
          await materializeComposerAttachments(currentAttachments);
      }
      logSessionUiTrace("composer-project-queue-start", {
        sessionId,
        projectId,
        targetType,
        permissionMode,
        thinking,
        slashCommand: slashCommand ?? null,
        textLength: outgoingText.length,
        attachmentCount: currentAttachments.length,
        clientTimestamp,
        serverOffsetMs: getEstimatedServerOffsetMs(),
      });
      const requestSentAtMs = Date.now();
      const response = await api.createProjectQueueItem(projectId, {
        target:
          targetType === "new-session"
            ? {
                type: "new-session",
                mode: permissionMode,
                model: session?.model ?? getModelSetting(),
                thinking,
                showThinking,
                provider: effectiveProvider,
                executor: session?.executor,
                title: outgoingText,
              }
            : {
                type: "existing-session",
                sessionId,
                mode: permissionMode,
                model: session?.model ?? getModelSetting(),
                thinking,
                showThinking,
                provider: effectiveProvider,
                executor: session?.executor,
              },
        message: {
          text: outgoingText,
          mode: permissionMode,
          ...(uploadedAttachments.length > 0
            ? { attachments: uploadedAttachments }
            : {}),
          ...(stagedAttachments ? { stagedAttachments } : {}),
          metadata: {
            ...metadata,
            deliveryIntent: "deferred",
            clientTimestamp,
          },
        },
        createdFrom: {
          sessionId,
          client: "toolbar",
        },
      });
      sourceSummary.reportProjectQueueCollectionSnapshot(response.queue);
      logSessionUiTrace("composer-project-queue-result", {
        sessionId,
        projectId,
        targetType,
        uploadWaitMs: requestSentAtMs - actionAtMs,
      });
      draftControlsRef.current?.confirmInputClear();
      revokeAttachmentPreviewUrls(currentAttachments);
      setCorrectionDraft(null);
      clearQuoteAnchors();
      showToast(
        t(
          targetType === "new-session"
            ? "projectQueueNewSessionQueuedToast"
            : "projectQueueSessionQueuedToast",
        ),
        "success",
      );
    } catch (err) {
      console.error("Failed to queue Project Queue message:", err);
      logSessionUiTrace("composer-project-queue-error", {
        sessionId,
        projectId,
        targetType,
        message: err instanceof Error ? err.message : String(err),
      });
      draftControlsRef.current?.restoreFromStorage();
      setComposerAttachments(currentAttachments, { persistDraft: false });
      const errorMsg = err instanceof Error ? err.message : String(err);
      showToast(t("projectQueueSubmitFailed", { message: errorMsg }), "error");
    }
  };

  const handleProjectQueue = (
    text: string,
    metadata?: MessageSubmissionMetadata,
  ) => queueComposerForProject(text, "existing-session", metadata);

  const handleProjectQueueNewSession = (
    text: string,
    metadata?: MessageSubmissionMetadata,
  ) => queueComposerForProject(text, "new-session", metadata);

  const handleResumeProjectQueueDispatch = useCallback(async () => {
    try {
      await projectQueues.resumeDispatch();
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      showToast(t("projectQueueResumeFailed", { message: errorMsg }), "error");
    }
  }, [projectQueues.resumeDispatch, showToast, t]);

  const handleCancelProjectQueueItem = useCallback(
    async (itemId: string) => {
      try {
        await projectQueues.deleteItem(projectId, itemId);
      } catch (err) {
        console.error("Failed to cancel Project Queue item:", err);
        const errorMsg = err instanceof Error ? err.message : String(err);
        showToast(
          t("projectQueueInlineCancelFailed", { message: errorMsg }),
          "error",
        );
      }
    },
    [projectId, projectQueues.deleteItem, showToast, t],
  );

  const restoreQueuedMessageToComposer = useCallback(
    (
      content: string,
      queuedAttachments: readonly ComposerAttachment[] = [],
      mode?: PermissionMode,
    ) => {
      const controls = draftControlsRef.current;
      if (!controls) {
        return;
      }
      const currentDraft = controls.getDraft();
      controls.setDraft(
        currentDraft.trim()
          ? appendComposerTransferDraft(currentDraft, content)
          : content,
      );
      if (queuedAttachments.length > 0) {
        setComposerAttachments((current) => [...current, ...queuedAttachments]);
      }
      if (mode) {
        setPermissionMode(mode);
      }
      setCorrectionDraft(null);
      requestAnimationFrame(() => controls.focus?.());
    },
    [setComposerAttachments, setPermissionMode],
  );

  const handleEditProjectQueueItem = useCallback(
    async (itemId: string) => {
      const controls = draftControlsRef.current;
      const item = projectQueueItemsForProject.find(
        (candidate) => candidate.id === itemId,
      );
      if (
        !controls ||
        controls.getDraft().trim() ||
        attachmentsRef.current.length > 0 ||
        pendingUploadsRef.current.size > 0 ||
        !item ||
        item.message.stagedAttachments
      ) {
        return;
      }

      try {
        await projectQueues.deleteItem(projectId, itemId);
        restoreQueuedMessageToComposer(
          item.message.text,
          item.message.attachments,
          item.message.mode ?? item.target.mode,
        );
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        showToast(
          t("projectQueueInlineEditFailed", { message: errorMsg }),
          "error",
        );
      }
    },
    [
      projectId,
      projectQueueItemsForProject,
      projectQueues.deleteItem,
      restoreQueuedMessageToComposer,
      showToast,
      t,
    ],
  );

  const handleSteerProjectQueueItem = useCallback(
    async (itemId: string) => {
      try {
        const result = await projectQueues.promoteNow(projectId, itemId, {
          force: true,
          deliveryIntent: "steer",
        });
        if (!result.promoted) {
          throw new Error(result.error ?? result.reason);
        }
        showToast(t("projectQueueInlineSteered"), "success");
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        showToast(
          t("projectQueueInlineSteerFailed", { message: errorMsg }),
          "error",
        );
      }
    },
    [projectId, projectQueues.promoteNow, showToast, t],
  );

  const handleCancelDeferred = useCallback(
    async (tempId: string) => {
      // No optimistic removal: the chip disappears when the server's next
      // deferred-queue state (which omits this tempId) is mirrored.
      const previousLastSubmission = lastComposerSubmissionRef.current;
      lastComposerSubmissionRef.current = getRecallSubmissionAfterQueuedCancel(
        lastComposerSubmissionRef.current,
        lastSentComposerSubmissionRef.current,
        deferredMessages,
        tempId,
      );
      try {
        await api.cancelDeferredMessage(sessionId, tempId);
      } catch (err) {
        if (isMissingDeferredQueueEntryError(err)) {
          return;
        }
        lastComposerSubmissionRef.current = previousLastSubmission;
        console.error("Failed to cancel deferred message:", err);
        const errorMsg = err instanceof Error ? err.message : String(err);
        showToast(
          t("sessionDeferredCancelFailed", { message: errorMsg }),
          "error",
        );
      }
    },
    [deferredMessages, sessionId, showToast, t],
  );

  const handleEditDeferred = useCallback(
    async (tempId: string) => {
      const controls = draftControlsRef.current;
      const message = deferredMessages.find(
        (candidate) => candidate.tempId === tempId,
      );
      if (
        !controls ||
        controls.getDraft().trim() ||
        attachmentsRef.current.length > 0 ||
        pendingUploadsRef.current.size > 0 ||
        !message
      ) {
        return;
      }

      try {
        await api.cancelDeferredMessage(sessionId, tempId);
        lastComposerSubmissionRef.current =
          getRecallSubmissionAfterQueuedCancel(
            lastComposerSubmissionRef.current,
            lastSentComposerSubmissionRef.current,
            deferredMessages,
            tempId,
          );
        restoreQueuedMessageToComposer(message.content, message.attachments);
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        showToast(
          t("sessionDeferredEditFailed", { message: errorMsg }),
          "error",
        );
      }
    },
    [deferredMessages, restoreQueuedMessageToComposer, sessionId, showToast, t],
  );

  const handleCancelUnconfirmedUserMessage = useCallback(
    async (tempId: string) => {
      try {
        await api.cancelUnconfirmedSteerMessage(sessionId, tempId);
        removeUnconfirmedSelfSend(tempId);
        if (
          lastComposerSubmissionRef.current?.kind === "sent" &&
          lastComposerSubmissionRef.current.id === tempId
        ) {
          lastComposerSubmissionRef.current = null;
        }
        if (lastSentComposerSubmissionRef.current?.id === tempId) {
          lastSentComposerSubmissionRef.current = null;
        }
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        showToast(
          t("sessionUnconfirmedSteerCancelFailed", { message: errorMsg }),
          "error",
        );
      }
    },
    [removeUnconfirmedSelfSend, sessionId, showToast, t],
  );

  const handleSteerDeferred = useCallback(
    async (tempId: string) => {
      // No optimistic removal: the chips clear when the server's next
      // deferred-queue state (without the steered entries) is mirrored.
      try {
        await api.steerDeferredMessagesThrough(sessionId, tempId);
      } catch (err) {
        console.error("Failed to steer deferred message:", err);
        const errorMsg = err instanceof Error ? err.message : String(err);
        showToast(
          t("sessionDeferredSteerFailed", { message: errorMsg }),
          "error",
        );
      }
    },
    [sessionId, showToast, t],
  );

  const handleDeleteRecoveredDeferred = useCallback(
    async (queueId: string) => {
      try {
        const result = await api.deleteRecoveredQueuedMessage(
          sessionId,
          queueId,
        );
        setDeferredMessages(result.deferredMessages ?? []);
      } catch (err) {
        console.error("Failed to delete recovered queued message:", err);
        const errorMsg = err instanceof Error ? err.message : String(err);
        showToast(
          t("sessionRecoveredQueuedDeleteFailed", { message: errorMsg }),
          "error",
        );
      }
    },
    [sessionId, setDeferredMessages, showToast, t],
  );

  const handleResumeRecoveredDeferred = useCallback(
    async (queueId: string) => {
      try {
        const result = await api.resumeRecoveredQueuedMessage(
          sessionId,
          queueId,
        );
        setStatus({
          owner: "self",
          processId: result.processId,
          permissionMode: result.permissionMode,
          appliedPermissionMode: result.appliedPermissionMode,
          modeVersion: result.modeVersion,
          recapAfterSeconds: result.recapAfterSeconds,
        });
        setProcessState(result.processState ?? "idle");
        setDeferredMessages(result.deferredMessages ?? []);
      } catch (err) {
        console.error("Failed to resume recovered queued message:", err);
        const errorMsg = err instanceof Error ? err.message : String(err);
        showToast(
          t("sessionRecoveredQueuedResumeFailed", { message: errorMsg }),
          "error",
        );
      }
    },
    [sessionId, setDeferredMessages, setProcessState, setStatus, showToast, t],
  );

  const handleSteerRecoveredDeferred = useCallback(
    async (queueId: string) => {
      try {
        const result = await api.steerRecoveredQueuedMessage(
          sessionId,
          queueId,
        );
        setStatus({
          owner: "self",
          processId: result.processId,
          permissionMode: result.permissionMode,
          appliedPermissionMode: result.appliedPermissionMode,
          modeVersion: result.modeVersion,
          recapAfterSeconds: result.recapAfterSeconds,
        });
        setProcessState(result.processState ?? "idle");
        setDeferredMessages(result.deferredMessages ?? []);
      } catch (err) {
        console.error("Failed to steer recovered queued message:", err);
        const errorMsg = err instanceof Error ? err.message : String(err);
        showToast(
          t("sessionDeferredSteerFailed", { message: errorMsg }),
          "error",
        );
      }
    },
    [sessionId, setDeferredMessages, setProcessState, setStatus, showToast, t],
  );

  const handleCancelLatestDeferred = useCallback(() => {
    const latest = [...deferredMessages]
      .reverse()
      .find(
        (message) =>
          message.tempId && message.status !== "paused-after-restart",
      );
    if (!latest?.tempId) {
      return false;
    }
    void handleCancelDeferred(latest.tempId);
    return true;
  }, [deferredMessages, handleCancelDeferred]);

  const handleRecallLastSubmission = useCallback((): boolean => {
    const lastSubmission = lastComposerSubmissionRef.current;
    if (!lastSubmission?.text.trim()) {
      return false;
    }

    const draftControls = draftControlsRef.current;
    if (!draftControls) {
      return false;
    }

    // Recalling a still-queued message cancels it server-side and restores its
    // text to the composer — the "edit" affordance is intentionally just
    // cancel + re-queue (see topics/queued-messages.md).
    if (
      lastSubmission.kind === "queued" &&
      deferredMessages.some(
        (message) => message.tempId === lastSubmission.tempId,
      )
    ) {
      void handleCancelDeferred(lastSubmission.tempId);
      draftControls.setDraft(lastSubmission.text);
      setComposerAttachments([], { revokeRemovedPreviewUrls: true });
      return true;
    }

    draftControls.setDraft(lastSubmission.text);
    setComposerAttachments([], { revokeRemovedPreviewUrls: true });
    setCorrectionDraft({
      messageId:
        lastSubmission.kind === "sent"
          ? lastSubmission.id
          : lastSubmission.tempId,
      originalText: lastSubmission.text,
    });
    return true;
  }, [deferredMessages, handleCancelDeferred, setComposerAttachments]);

  const handleModelChanged = useCallback(
    (next: {
      processId: string;
      model?: string;
      thinking?: { type: string };
      effort?: string;
    }) => {
      if (next.model) {
        setSessionModel(next.model);
        showToast(t("sessionSwitchedModel", { model: next.model }), "success");
      }
      if (next.thinking !== undefined || next.effort !== undefined) {
        setLiveModelConfigSnapshot((current) => {
          const previous =
            current?.processId === next.processId ? current.config : undefined;
          return {
            processId: next.processId,
            config: {
              model: next.model ?? previous?.model,
              requestedModel: next.model ?? previous?.requestedModel,
              thinking: next.thinking,
              effort: next.effort,
              promptSuggestionMode: previous?.promptSuggestionMode,
            },
          };
        });
      } else if (next.model) {
        setLiveModelConfigSnapshot((current) => ({
          processId: next.processId,
          config: {
            ...(current?.processId === next.processId ? current.config : {}),
            model: next.model,
            requestedModel: next.model,
          },
        }));
      }
      if (status.owner === "self") {
        if (currentOwnedProcessId !== next.processId) {
          setStatus((prev) =>
            prev.owner === "self"
              ? { ...prev, processId: next.processId }
              : { owner: "self", processId: next.processId },
          );
          reconnectStream();
        }
      }
    },
    [
      reconnectStream,
      setSessionModel,
      showToast,
      currentOwnedProcessId,
      status.owner,
      t,
      setStatus,
    ],
  );

  const handleLiveThinkingChange = useCallback(
    async (mode: ThinkingMode, effortLevel: EffortLevel) => {
      if (status.owner !== "self" || !currentOwnedProcessId) {
        return;
      }
      try {
        const result = await api.setProcessConfig(currentOwnedProcessId, {
          thinking: thinkingOptionFromSelection(mode, effortLevel),
          showThinking: getShowThinkingSetting(),
        });
        setLiveModelConfigSnapshot((current) => {
          const previous =
            current?.processId === result.processId
              ? current.config
              : undefined;
          return {
            processId: result.processId,
            config: {
              model: result.model ?? previous?.model,
              requestedModel: result.model ?? previous?.requestedModel,
              thinking: result.thinking,
              effort: result.effort,
              promptSuggestionMode: previous?.promptSuggestionMode,
            },
          };
        });
        if (result.processId !== currentOwnedProcessId) {
          setStatus((prev) =>
            prev.owner === "self"
              ? { ...prev, processId: result.processId }
              : { owner: "self", processId: result.processId },
          );
          reconnectStream();
        }
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        console.error("Failed to change thinking:", err);
        showToast(
          t("sessionThinkingChangeFailed", { message: errorMsg }),
          "error",
        );
      }
    },
    [
      currentOwnedProcessId,
      reconnectStream,
      showToast,
      status.owner,
      t,
      setStatus,
    ],
  );

  const handleSetLiveThinkingMode = useCallback(
    (mode: ThinkingMode) => {
      void handleLiveThinkingChange(
        mode,
        liveThinkingSelection?.effortLevel ?? "high",
      );
    },
    [handleLiveThinkingChange, liveThinkingSelection],
  );

  const handleSetLiveThinkingEffort = useCallback(
    (effortLevel: EffortLevel) => {
      void handleLiveThinkingChange("on", effortLevel);
    },
    [handleLiveThinkingChange],
  );

  const handleCompactSession = useCallback(
    async (argument = "") => {
      if (status.owner !== "self" || !supportsManualCompact) return;
      if (manualCompactBlocked) {
        showToast(t("sessionCompactTurnActive"), "info");
        return;
      }
      // Trailing focus instructions ("/compact preserve X") ride along
      // verbatim; Claude honors them natively. Providers without an instruction
      // surface (e.g. Codex) ignore the argument server-side.
      const trimmed = argument.trim();
      const message = trimmed ? `/compact ${trimmed}` : "/compact";
      try {
        await api.queueMessage(actualSessionId, message, permissionMode);
        showToast(t("sessionCompactRequested"), "success");
      } catch (err) {
        console.error("Failed to request compaction:", err);
        const errorMsg = err instanceof Error ? err.message : String(err);
        showToast(t("sessionCompactFailed", { message: errorMsg }), "error");
      }
    },
    [
      actualSessionId,
      manualCompactBlocked,
      permissionMode,
      showToast,
      status.owner,
      supportsManualCompact,
      t,
    ],
  );

  const handleFocusedBtwSend = useCallback(
    (text: string, source: "main" | "pane" = "main") => {
      if (!focusedBtwAside) {
        void handleSendRef.current(text);
        return;
      }
      const sessionOperation = resolveComposerSessionOperation({
        text,
        routesToFocusedAside: true,
        syntheticDoneEnabled,
        syntheticDoneSupported: supportsSyntheticDone,
        syntheticArchiveSupported: supportsSyntheticArchive,
        syntheticTerminateSupported: supportsSyntheticTerminate,
        hasAttachments: false,
      });
      if (
        sessionOperation.kind === "focused-aside" &&
        closeFocusedBtwAside(sessionOperation.argument)
      ) {
        return;
      }
      if (sessionOperation.kind === "blocked") {
        if (source === "pane") {
          setAsideDraft(text);
        } else {
          draftControlsRef.current?.setDraft(text);
        }
        showToast(sessionOperation.message, "error");
        return;
      }
      void runBtwAsideTurn(
        focusedBtwAside,
        text,
        focusedBtwAside.status === "draft" && !focusedBtwAside.sessionId,
      );
    },
    [
      closeFocusedBtwAside,
      focusedBtwAside,
      runBtwAsideTurn,
      setAsideDraft,
      showToast,
      supportsSyntheticArchive,
      supportsSyntheticDone,
      supportsSyntheticTerminate,
      syntheticDoneEnabled,
    ],
  );

  const applyMotherComposerTransfer = useCallback(
    (controls: DraftControls, text: string) => {
      const nextDraft = appendComposerTransferDraft(controls.getDraft(), text);
      controls.setDraft(nextDraft);
      showToast("Inserted /btw turn into Mother composer.", "info");
    },
    [showToast],
  );

  const handleComposerDraftTextChange = useCallback(
    (draft: string, metadata: DraftTextChangeMetadata) => {
      composerDraftSignal.publishDraftChange(draft, metadata);
      composerEditAvailabilityStore.setDraftText(draft);
    },
    [composerDraftSignal, composerEditAvailabilityStore],
  );

  const insertQuotedSelection = useCallback(
    (quotedText: string): string | null => {
      const controls = draftControlsRef.current;
      if (!controls) {
        showToast(t("sessionQuoteComposerUnavailable"), "error");
        return null;
      }
      const insertedText = quotedText.trimEnd();
      const currentDraft = controls.getDraft();
      const transfer = getComposerTransferReplacement(
        currentDraft,
        insertedText,
      );
      const replacement = quotedText.endsWith("\n")
        ? `${transfer.replacement}\n`
        : transfer.replacement;
      const nextDraft = `${currentDraft.slice(0, transfer.start)}${replacement}${currentDraft.slice(transfer.end)}`;
      const undoableDraft = controls.replaceDraftRangeUndoably?.(
        transfer.start,
        transfer.end,
        replacement,
      );
      const finalDraft = undoableDraft ?? nextDraft;
      if (undoableDraft === null || !controls.replaceDraftRangeUndoably) {
        controls.setDraft(nextDraft);
      }
      requestAnimationFrame(() => {
        controls.focus?.();
        controls.setSelectionRange?.(finalDraft.length, finalDraft.length);
      });
      return finalDraft;
    },
    [showToast, t],
  );

  const clearQuoteAnchors = useCallback(() => {
    setQuoteClearSignal((current) => current + 1);
  }, []);

  const flushPendingMotherComposerTransfer = useCallback(
    (controls = draftControlsRef.current) => {
      if (mainComposerForAside || !controls) {
        return;
      }
      const pendingText = pendingMotherComposerTransferRef.current;
      if (!pendingText) {
        return;
      }
      pendingMotherComposerTransferRef.current = null;
      applyMotherComposerTransfer(controls, pendingText);
    },
    [applyMotherComposerTransfer, mainComposerForAside],
  );

  const hydrateDraftAttachments = useCallback(
    async (controls = draftControlsRef.current) => {
      if (
        mainComposerForAside ||
        !controls ||
        !stagedAttachmentUploadsEnabled
      ) {
        return;
      }

      const state = controls.getAttachmentState();
      if (!state) {
        setComposerAttachments([], {
          persistDraft: false,
          revokeRemovedPreviewUrls: true,
        });
        return;
      }

      const hydrationId = draftAttachmentHydrationRef.current + 1;
      draftAttachmentHydrationRef.current = hydrationId;

      try {
        const refs = await validateDraftAttachmentRefs(sourceTransport, state);
        if (draftAttachmentHydrationRef.current !== hydrationId) {
          return;
        }
        const nextState = createComposerDraftAttachmentState(refs);
        draftAttachmentBatchIdRef.current = nextState?.batchId ?? null;
        controls.setAttachmentState(nextState);
        setComposerAttachments(refs, {
          persistDraft: false,
          revokeRemovedPreviewUrls: true,
        });
      } catch (err) {
        if (draftAttachmentHydrationRef.current !== hydrationId) {
          return;
        }
        console.warn(
          "[SessionPage] Failed to validate draft attachments:",
          err,
        );
        controls.setAttachmentState(null);
        setComposerAttachments([], {
          persistDraft: false,
          revokeRemovedPreviewUrls: true,
        });
        showToast(t("sessionDraftAttachmentsUnavailable"), "info");
      }
    },
    [
      sourceTransport,
      mainComposerForAside,
      setComposerAttachments,
      showToast,
      stagedAttachmentUploadsEnabled,
      t,
    ],
  );

  const handleDraftControlsReady = useCallback(
    (controls: DraftControls) => {
      draftControlsRef.current = controls;
      flushPendingMotherComposerTransfer(controls);
      void hydrateDraftAttachments(controls);
    },
    [flushPendingMotherComposerTransfer, hydrateDraftAttachments],
  );

  useEffect(() => {
    flushPendingMotherComposerTransfer();
  }, [flushPendingMotherComposerTransfer]);

  useEffect(() => {
    void sessionDraftKey;
    void hydrateDraftAttachments();
  }, [hydrateDraftAttachments, sessionDraftKey]);

  const transferBtwTurnToMotherComposer = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) {
        return;
      }

      if (mainComposerForAside) {
        pendingMotherComposerTransferRef.current = trimmed;
        setFocusedBtwAsideId(null);
        return;
      }

      const controls = draftControlsRef.current;
      if (!controls) {
        pendingMotherComposerTransferRef.current = trimmed;
        return;
      }
      applyMotherComposerTransfer(controls, trimmed);
    },
    [applyMotherComposerTransfer, mainComposerForAside, setFocusedBtwAsideId],
  );

  const handleCustomCommand = useCallback(
    (command: string, argument = "") => {
      if (command === "model") {
        setShowModelSwitchModal(true);
        return true;
      }
      if (command === "compact" && supportsManualCompact) {
        void handleCompactSession(argument);
        return true;
      }
      if (command === "btw") {
        return startBtwAside(argument);
      }
      if (command === "done") {
        if (!closeFocusedBtwAside(argument)) {
          showToast(
            "/done closes a focused /btw aside; no aside is focused.",
            "error",
          );
        }
        return true;
      }
      return false;
    },
    [
      closeFocusedBtwAside,
      handleCompactSession,
      showToast,
      startBtwAside,
      supportsManualCompact,
    ],
  );

  const handleToolbarSlashCommand = useCallback(
    (command: SlashCommand) => {
      const bare = normalizeSlashCommandForMatch(command.name);
      if (
        command.invocation?.kind === "emulated" &&
        handleCustomCommand(bare)
      ) {
        return;
      }
      const controls = draftControlsRef.current;
      if (!controls) {
        return;
      }
      controls.setDraft(
        appendSlashCommandDraft(
          controls.getDraft(),
          getCanonicalInvocationToken(command),
        ),
      );
    },
    [handleCustomCommand],
  );

  const liveBadgeModel = effectiveModelConfig?.model ?? effectiveModel;

  const handleAbort = async () => {
    if (status.owner === "self" && status.processId) {
      // Try interrupt first (graceful stop), fall back to abort if not supported
      try {
        logSessionUiTrace("stop-request", {
          sessionId,
          processId: status.processId,
          processState,
        });
        const result = await api.interruptProcess(status.processId);
        logSessionUiTrace("stop-interrupt-result", {
          sessionId,
          processId: status.processId,
          interrupted: result.interrupted,
          aborted: result.aborted,
          supported: result.supported,
        });
        if (result.interrupted || result.aborted) {
          if (result.aborted) {
            setStatus({ owner: "none" });
            setProcessState("idle");
          }
          return;
        }
        // Interrupt not supported or failed, fall back to abort
      } catch {
        logSessionUiTrace("stop-interrupt-error", {
          sessionId,
          processId: status.processId,
        });
        // Interrupt endpoint failed (404 = old server, or other error)
      }
      // Fall back to abort (kills the process)
      await api.abortProcess(status.processId);
      logSessionUiTrace("stop-abort-fallback", {
        sessionId,
        processId: status.processId,
      });
    }
  };

  const syncPendingInputFromServer = useCallback(async () => {
    try {
      const result = await api.getPendingInputRequest(sessionId);
      setPendingInputRequest(result.request ?? null);
    } catch {
      // Best-effort stale approval cleanup; the stream will also reconcile.
    }
  }, [sessionId, setPendingInputRequest]);

  const handleInputResponseError = useCallback(
    async (err: unknown, fallbackMessage: string) => {
      const status = (err as { status?: number }).status;
      const msg = status ? `Error ${status}` : fallbackMessage;
      showToast(msg, "error");
      if (status === 400) {
        await syncPendingInputFromServer();
      }
    },
    [showToast, syncPendingInputFromServer],
  );

  const handleApprove = useCallback(async () => {
    if (pendingInputRequest) {
      try {
        const result = await api.respondToInput(
          sessionId,
          pendingInputRequest.id,
          "approve",
        );
        setPendingInputRequest(result.pendingInputRequest ?? null);
      } catch (err) {
        await handleInputResponseError(err, t("sessionApproveFailed"));
      }
    }
  }, [
    sessionId,
    pendingInputRequest,
    setPendingInputRequest,
    handleInputResponseError,
    t,
  ]);

  const handleApproveAcceptEdits = useCallback(async () => {
    if (pendingInputRequest) {
      try {
        const response = getPersistentEditApprovalResponse(permissionMode);
        const result = await api.respondToInput(
          sessionId,
          pendingInputRequest.id,
          response,
        );
        setPendingInputRequest(result.pendingInputRequest ?? null);
        if (response === "approve_accept_edits") {
          setPermissionMode("acceptEdits");
        }
      } catch (err) {
        await handleInputResponseError(err, t("sessionApproveFailed"));
      }
    }
  }, [
    sessionId,
    pendingInputRequest,
    permissionMode,
    setPendingInputRequest,
    setPermissionMode,
    handleInputResponseError,
    t,
  ]);

  const handleDeny = useCallback(async () => {
    if (pendingInputRequest) {
      try {
        const result = await api.respondToInput(
          sessionId,
          pendingInputRequest.id,
          "deny",
        );
        setPendingInputRequest(result.pendingInputRequest ?? null);
      } catch (err) {
        await handleInputResponseError(err, t("sessionDenyFailed"));
      }
    }
  }, [
    sessionId,
    pendingInputRequest,
    setPendingInputRequest,
    handleInputResponseError,
    t,
  ]);

  const handleDenyWithFeedback = useCallback(
    async (feedback: string) => {
      if (pendingInputRequest) {
        try {
          const result = await api.respondToInput(
            sessionId,
            pendingInputRequest.id,
            "deny",
            undefined,
            feedback,
          );
          setPendingInputRequest(result.pendingInputRequest ?? null);
        } catch (err) {
          await handleInputResponseError(err, t("sessionFeedbackFailed"));
        }
      }
    },
    [
      sessionId,
      pendingInputRequest,
      setPendingInputRequest,
      handleInputResponseError,
      t,
    ],
  );

  const handleQuestionSubmit = useCallback(
    async (answers: UserQuestionAnswers) => {
      if (pendingInputRequest) {
        try {
          const result = await api.respondToInput(
            sessionId,
            pendingInputRequest.id,
            "approve",
            answers,
          );
          setPendingInputRequest(result.pendingInputRequest ?? null);
        } catch (err) {
          await handleInputResponseError(err, t("sessionAnswerFailed"));
        }
      }
    },
    [
      sessionId,
      pendingInputRequest,
      setPendingInputRequest,
      handleInputResponseError,
      t,
    ],
  );

  // Handle file attachment uploads
  // Each file uploads independently (parallel) and its promise is tracked
  // so handleSend can wait for in-flight uploads before sending
  const handleAttach = useCallback(
    (files: File[]) => {
      const draftBatchId = stagedAttachmentUploadsEnabled
        ? ensureDraftAttachmentBatchId()
        : null;
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
        const uploadPromise = uploadComposerAttachmentFile({
          file,
          sourceTransport,
          projectId,
          sessionId,
          maxLongEdgePx: getAttachmentUploadLongEdgePx(attachmentQuality),
          stagedBatchId:
            stagedAttachmentUploadsEnabled && draftBatchId
              ? draftBatchId
              : null,
          onProgress: (bytesUploaded, uploadFile) => {
            setUploadProgress((prev) =>
              prev.map((p) =>
                p.fileId === tempId
                  ? {
                      ...p,
                      bytesUploaded,
                      percent: Math.round(
                        (bytesUploaded / uploadFile.size) * 100,
                      ),
                    }
                  : p,
              ),
            );
          },
        })
          .then(
            (uploaded) => {
              if (uploaded.mimeType.startsWith("image/")) {
                const cachedFile = isComposerStagedAttachment(uploaded)
                  ? {
                      id: uploaded.id,
                      originalName: uploaded.originalName,
                      name: uploaded.name,
                      path: uploaded.id,
                      size: uploaded.size,
                      mimeType: uploaded.mimeType,
                      ...(uploaded.width !== undefined
                        ? { width: uploaded.width }
                        : {}),
                      ...(uploaded.height !== undefined
                        ? { height: uploaded.height }
                        : {}),
                    }
                  : uploaded;
                void storeUploadedAttachmentPreview(cachedFile, file).catch(
                  (err) => {
                    console.warn(
                      "[SessionPage] Failed to cache attachment preview:",
                      err,
                    );
                  },
                );
              }
              setComposerAttachments((prev) => [...prev, uploaded]);
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
              return null as ComposerAttachment | null;
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
    [
      attachmentQuality,
      sourceTransport,
      ensureDraftAttachmentBatchId,
      projectId,
      sessionId,
      setComposerAttachments,
      showToast,
      stagedAttachmentUploadsEnabled,
      t,
    ],
  );

  useIncomingShareFiles(handleAttach, {
    enabled: !isDomLingerParked,
    onError: () => showToast(t("incomingShareAttachmentUnavailable"), "error"),
  });

  const handleRemoveAttachment = useCallback(
    (id: string) => {
      const removed = attachmentsRef.current.find(
        (attachment) => attachment.id === id,
      );
      setComposerAttachments(
        (prev) => prev.filter((attachment) => attachment.id !== id),
        { revokeRemovedPreviewUrls: true },
      );

      if (removed && isComposerStagedAttachment(removed)) {
        deleteDraftAttachmentRef(
          sourceTransport,
          removed.batchId,
          removed.id,
        ).catch((err) => {
          console.warn(
            "[SessionPage] Failed to delete staged attachment:",
            err,
          );
        });
      }
    },
    [sourceTransport, setComposerAttachments],
  );

  // Check if pending request is an AskUserQuestion
  const isAskUserQuestion = pendingInputRequest?.toolName === "AskUserQuestion";

  // Suppress current-turn orphan markers while owned process state says the
  // turn is active. Completed assistant text only settles stale fallback
  // evidence, such as old pending tool rows after the process goes idle.
  const activeToolApproval = sessionActivityUi.shouldSuppressCurrentTurnOrphans;

  // Detect if session has pending tool calls without results
  // This can happen when the session is unowned but was active in another process (VS Code, CLI)
  // that is waiting for user input (tool approval, question answer)
  const pendingToolCall = sessionActivityUi.pendingToolCallInLatestTurn;
  const hasPendingToolCalls =
    status.owner === "none" && pendingToolCall != null;
  // Dismissal is keyed to the specific pending tool_use, so a *different* call
  // going pending later re-arms the banner instead of staying muted all session.
  const pendingElsewhereDismissed =
    pendingToolCall != null &&
    pendingElsewhereDismissedToolId === pendingToolCall.id;
  const pendingElsewhereDismissKey = useMemo(
    () =>
      createPendingElsewhereDismissKey(clientSummarySourceKey, actualSessionId),
    [actualSessionId, clientSummarySourceKey],
  );

  const { displayTitle, titleTooltip } = resolveSessionPageTitle({
    initialTitle,
    localCustomTitle,
    session,
    untitledTitle: t("sessionUntitled"),
  });
  const isArchived = localIsArchived ?? session?.isArchived ?? false;
  const isStarred = localIsStarred ?? session?.isStarred ?? false;
  const heartbeatTurnsEnabled =
    localHeartbeatTurnsEnabled ?? session?.heartbeatTurnsEnabled ?? false;
  const heartbeatTurnsAfterMinutes =
    localHeartbeatTurnsAfterMinutes ?? session?.heartbeatTurnsAfterMinutes;
  const heartbeatTurnText =
    localHeartbeatTurnText ?? session?.heartbeatTurnText;
  const heartbeatForceAfterMinutes =
    localHeartbeatForceAfterMinutes ?? session?.heartbeatForceAfterMinutes;
  // Effective per-session suggestion mode: optimistic local toggle wins, then
  // the live process config, then the persisted session metadata, else off.
  const promptSuggestionMode =
    localPromptSuggestionMode ??
    effectiveModelConfig?.promptSuggestionMode ??
    session?.promptSuggestionMode ??
    "off";

  useEffect(() => {
    if (typeof window === "undefined") return;
    setPendingElsewhereDismissedToolId(
      window.localStorage.getItem(pendingElsewhereDismissKey),
    );
  }, [pendingElsewhereDismissKey]);

  const handleDismissPendingElsewhereWarning = useCallback(() => {
    if (!pendingToolCall) return;
    const dismissedId = pendingToolCall.id;
    setPendingElsewhereDismissedToolId(dismissedId);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(pendingElsewhereDismissKey, dismissedId);
    }
  }, [pendingElsewhereDismissKey, pendingToolCall]);

  const handleRestorePendingElsewhereWarning = useCallback(() => {
    setPendingElsewhereDismissedToolId(null);
    if (typeof window !== "undefined") {
      window.localStorage.removeItem(pendingElsewhereDismissKey);
    }
  }, [pendingElsewhereDismissKey]);

  // Update browser tab title
  useDocumentTitle(
    project?.name,
    supportsProjectCodeNames ? project?.codeName : undefined,
    displayTitle,
    !isDomLingerParked,
  );

  const setRetitleState = (state: GeneratedRetitleState | null) => {
    generatedRetitleRef.current = state;
    setGeneratedRetitle(state);
  };

  const invalidateGeneratedRetitle = () => {
    retitleRequestIdRef.current += 1;
    setRetitleState(null);
  };

  const focusAndSelectTitleInput = () => {
    setTimeout(() => {
      renameInputRef.current?.focus();
      renameInputRef.current?.select();
    }, 0);
  };

  const captureGeneratedRetitleInsertion = (): GeneratedRetitleInsertion => {
    const input = renameInputRef.current;
    const value = input?.value ?? renameValue;
    const start = input?.selectionStart ?? value.length;
    const end = input?.selectionEnd ?? start;
    return {
      prefix: value.slice(0, start),
      suffix: value.slice(end),
    };
  };

  const saveTitleValue = async (nextTitle: string): Promise<boolean> => {
    const trimmed = nextTitle.trim();
    if (!trimmed || isRenaming) return false;
    if (trimmed === displayTitle) {
      handleCancelEditingTitle();
      return true;
    }

    invalidateGeneratedRetitle();
    isSavingTitleRef.current = true;
    setIsRenaming(true);
    try {
      await api.updateSessionMetadata(sessionId, { title: trimmed });
      setLocalCustomTitle(trimmed);
      activityBus.emitLocal("session-metadata-changed", {
        type: "session-metadata-changed",
        sessionId,
        title: trimmed,
        timestamp: new Date().toISOString(),
      });
      setIsEditingTitle(false);
      setTitleEditMode("manual");
      setRenameValue("");
      showToast(t("sessionRenamed"), "success");
      return true;
    } catch (err) {
      console.error("Failed to rename session:", err);
      showToast(t("sessionRenameFailed"), "error");
      return false;
    } finally {
      setIsRenaming(false);
      isSavingTitleRef.current = false;
    }
  };

  const handleStartEditingTitle = () => {
    setShowRecentSessions(false);
    invalidateGeneratedRetitle();
    setTitleEditMode("manual");
    setRenameValue(displayTitle);
    setIsEditingTitle(true);
    focusAndSelectTitleInput();
  };

  const handleStartRetitleTitle = (options?: { applyWhenReady?: boolean }) => {
    setShowRecentSessions(false);
    setTitleEditMode("retitle");
    setRenameValue(displayTitle);
    setIsEditingTitle(true);
    if (!options?.applyWhenReady) {
      focusAndSelectTitleInput();
    }

    const requestId = retitleRequestIdRef.current + 1;
    retitleRequestIdRef.current = requestId;
    const submittedTurnText = createSessionRetitleSubmittedTurnText(
      displayTitle,
      generatedTitleLength,
    );
    if (!supportsForkFromTurn) {
      setRetitleState({
        requestId,
        status: "error",
        submittedTurnText,
        error: t("sessionRetitleUnsupported"),
      });
      return;
    }

    setRetitleState({
      requestId,
      status: "generating",
      submittedTurnText,
      ...(options?.applyWhenReady
        ? { deferredInsertion: { prefix: "", suffix: "" } }
        : {}),
    });
    void (async () => {
      try {
        const result = await api.proposeSessionRetitle(projectId, sessionId, {
          currentTitle: displayTitle,
          lengthTarget: generatedTitleLength,
        });
        if (retitleRequestIdRef.current !== requestId) return;
        const current = generatedRetitleRef.current;
        if (!current || current.requestId !== requestId) return;
        if (current.deferredInsertion) {
          await saveTitleValue(
            composeGeneratedRetitle(result.title, current.deferredInsertion),
          );
          return;
        }
        setRetitleState({
          requestId,
          status: "ready",
          submittedTurnText,
          title: result.title,
        });
      } catch (err) {
        if (retitleRequestIdRef.current !== requestId) return;
        const message = err instanceof Error ? err.message : String(err);
        setRetitleState({
          requestId,
          status: "error",
          submittedTurnText,
          error: message || t("sessionRetitleFailed"),
        });
      }
    })();
  };

  const handleGenerateAndApplyTitle = () => {
    handleStartRetitleTitle({ applyWhenReady: true });
  };

  const handleLocalTitleCommand = async (title: string | null) => {
    if (title !== null) {
      const saved = await saveTitleValue(title);
      if (saved) {
        draftControlsRef.current?.confirmInputClear();
      } else {
        draftControlsRef.current?.restoreFromStorage();
      }
      return;
    }

    handleGenerateAndApplyTitle();
    if (supportsForkFromTurn) {
      draftControlsRef.current?.confirmInputClear();
    } else {
      draftControlsRef.current?.restoreFromStorage();
    }
  };

  const handleCancelEditingTitle = () => {
    // Don't cancel if we're in the middle of saving
    if (isSavingTitleRef.current) return;
    invalidateGeneratedRetitle();
    setIsEditingTitle(false);
    setTitleEditMode("manual");
    setRenameValue("");
  };
  const handleCancelEditingTitleRef = useRef(handleCancelEditingTitle);
  handleCancelEditingTitleRef.current = handleCancelEditingTitle;

  // On blur, save if value changed (handles mobile keyboard dismiss on Enter)
  const handleTitleBlur = (e: React.FocusEvent<HTMLInputElement>) => {
    const nextTarget = e.relatedTarget;
    if (
      nextTarget instanceof Node &&
      titleEditControlsRef.current?.contains(nextTarget)
    ) {
      return;
    }
    // Don't interfere if we're already saving
    if (isSavingTitleRef.current) return;
    if (titleEditMode === "retitle") {
      handleCancelEditingTitle();
      return;
    }
    // If value is empty or unchanged, just cancel
    if (!renameValue.trim() || renameValue.trim() === displayTitle) {
      handleCancelEditingTitle();
      return;
    }
    // Otherwise save (handles mobile Enter which blurs before keydown fires)
    handleSaveTitle();
  };

  const handleSaveTitle = () => {
    void saveTitleValue(renameValue);
  };

  const handleAcceptGeneratedRetitle = () => {
    if (titleEditMode !== "retitle") {
      handleSaveTitle();
      return;
    }
    const current = generatedRetitleRef.current;
    if (!current || current.status === "error") return;
    const insertion = captureGeneratedRetitleInsertion();
    if (current.status === "ready" && current.title) {
      void saveTitleValue(composeGeneratedRetitle(current.title, insertion));
      return;
    }
    if (current.status === "generating") {
      const next = { ...current, deferredInsertion: insertion };
      setRetitleState(next);
    }
  };

  const handleTitleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      if (titleEditMode === "retitle" && !e.ctrlKey) {
        handleAcceptGeneratedRetitle();
      } else {
        handleSaveTitle();
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      handleCancelEditingTitle();
    }
  };

  useEffect(() => {
    if (isDomLingerParked || !isEditingTitle) return;
    const handleWindowKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      handleCancelEditingTitleRef.current();
    };
    window.addEventListener("keydown", handleWindowKeyDown);
    return () => window.removeEventListener("keydown", handleWindowKeyDown);
  }, [isDomLingerParked, isEditingTitle]);

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

  const handleTogglePromptSuggestions = async () => {
    const next: PromptSuggestionMode =
      promptSuggestionMode === "native" ? "off" : "native";
    const previous = localPromptSuggestionMode;
    setLocalPromptSuggestionMode(next);
    try {
      await api.updateSessionMetadata(sessionId, {
        promptSuggestionMode: next,
      });
      showToast(
        next === "native"
          ? t("sessionPromptSuggestionsEnabled")
          : t("sessionPromptSuggestionsDisabled"),
        "success",
      );
    } catch (err) {
      console.error("Failed to update prompt suggestion mode:", err);
      setLocalPromptSuggestionMode(previous);
      showToast(t("sessionPromptSuggestionsFailed"), "error");
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
        await api.abortProcess(status.processId, { blockResume: true });
        showToast(t("sessionTerminated"), "success");
      } catch (err) {
        console.error("Failed to terminate session:", err);
        const errorMsg = err instanceof Error ? err.message : String(err);
        showToast(t("sessionTerminateFailed", { message: errorMsg }), "error");
      }
    }
  };

  const handleRestartProvider = async () => {
    if (status.owner !== "self" || !status.processId) return;
    draftControlsRef.current?.flushDraft();
    try {
      await api.abortProcess(status.processId);
      setStatus({ owner: "none" });
      await api.reactivateSession(projectId, actualSessionId);
      window.location.reload();
    } catch (error) {
      showToast(
        t("sessionRestartProviderFailed", {
          message: error instanceof Error ? error.message : String(error),
        }),
        "error",
      );
    }
  };

  const handleShare = useCallback(() => {
    if (showShareModal) {
      setShowShareModal(false);
      setShareModalAnchor(null);
      return;
    }
    setShareModalAnchor(null);
    setShareModalView(publicShareManagementAvailable ? "manage" : "session");
    setShowShareModal(true);
  }, [publicShareManagementAvailable, showShareModal]);

  const handleShareIndicatorClick = useCallback(
    (event: ReactMouseEvent<HTMLButtonElement>) => {
      if (showShareModal) {
        setShowShareModal(false);
        setShareModalAnchor(null);
        return;
      }
      const rect = event.currentTarget.getBoundingClientRect();
      setShareModalAnchor({
        bottom: rect.bottom,
        height: rect.height,
        left: rect.left,
        right: rect.right,
        top: rect.top,
        width: rect.width,
      });
      setShareModalView(publicShareManagementAvailable ? "manage" : "session");
      setShowShareModal(true);
    },
    [publicShareManagementAvailable, showShareModal],
  );

  const handleShareIndicatorContextMenu = useCallback(
    (event: ReactMouseEvent<HTMLButtonElement>) => {
      if (!publicShareManagementAvailable) return;
      event.preventDefault();
      handleShareIndicatorClick(event);
    },
    [handleShareIndicatorClick, publicShareManagementAvailable],
  );

  const handleToggleHeartbeat = useCallback(async () => {
    const previousEnabled = heartbeatTurnsEnabled;
    const nextEnabled = !previousEnabled;
    setLocalHeartbeatTurnsEnabled(nextEnabled);
    try {
      await api.updateSessionMetadata(actualSessionId, {
        heartbeatTurnsEnabled: nextEnabled,
      });
    } catch (err) {
      console.error("Failed to update heartbeat status:", err);
      setLocalHeartbeatTurnsEnabled(previousEnabled);
      const errorMsg =
        err instanceof Error ? err.message : t("sessionHeartbeatSaveFailed");
      showToast(errorMsg, "error");
    }
  }, [actualSessionId, heartbeatTurnsEnabled, showToast, t]);

  if (error) {
    const errorStatus =
      typeof (error as { status?: unknown }).status === "number"
        ? (error as { status?: number }).status
        : undefined;
    const isNotFound =
      error.message?.includes("Session not found") ||
      error.message?.includes("not found") ||
      errorStatus === 404;

    if (isNotFound && actualSessionId) {
      return (
        <div className="error" style={{ maxWidth: 520, margin: "40px auto" }}>
          <h2 style={{ marginTop: 0 }}>{t("sessionNotFoundTitle")}</h2>
          <p style={{ color: "#666" }}>{t("sessionNotFoundDescription")}</p>
          <div
            style={{
              display: "flex",
              gap: 12,
              marginTop: 16,
              flexWrap: "wrap",
            }}
          >
            <button
              type="button"
              onClick={async () => {
                try {
                  await api.updateSessionMetadata(actualSessionId, {
                    archived: true,
                  });
                  showToast("Archived and hidden from lists.", "success");
                  navigate(`${basePath}/sessions?project=${projectId}`, {
                    replace: true,
                  });
                } catch (err) {
                  const message =
                    err instanceof Error ? err.message : String(err);
                  showToast(`Failed to archive: ${message}`, "error");
                }
              }}
              style={{ padding: "8px 14px", cursor: "pointer" }}
            >
              {t("sessionNotFoundArchive")}
            </button>
            <button
              type="button"
              onClick={() => window.history.back()}
              style={{ padding: "8px 14px", cursor: "pointer" }}
            >
              {t("sessionNotFoundGoBack")}
            </button>
          </div>
          <p style={{ fontSize: "12px", color: "#888", marginTop: 20 }}>
            {t("sessionNotFoundSessionId")} <code>{actualSessionId}</code>
          </p>
        </div>
      );
    }

    return (
      <div className="error">
        {t("sessionErrorPrefix")} {error.message}
      </div>
    );
  }

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

  const liveSourceReviewThinking = parseThinkingConfig(
    effectiveModelConfig?.thinking,
  );
  const sourceReviewModelSettings = liveSourceReviewThinking
    ? {
        thinking: liveSourceReviewThinking,
        effort: isEffortLevel(effectiveModelConfig?.effort)
          ? effectiveModelConfig.effort
          : undefined,
      }
    : thinkingOptionToConfig(getThinkingSetting());

  return (
    <MainContent isWideScreen={isWideScreen}>
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
            <HostIdentityMarker />
            {/* Project breadcrumb */}
            {project?.name && (
              <div className="project-breadcrumb-wrapper">
                <Link
                  ref={projectBreadcrumbRef}
                  to={`${basePath}/sessions?project=${projectId}`}
                  className="project-breadcrumb"
                  title={project.name}
                  aria-label={project.name}
                  onContextMenu={handleProjectBreadcrumbContextMenu}
                >
                  {project.name.length > 12
                    ? `${project.name.slice(0, 12)}...`
                    : project.name}
                </Link>
                {showProjectReclassifyMenu && (
                  <div
                    ref={projectReclassifyMenuRef}
                    className="project-reclassify-menu"
                    role="menu"
                    aria-label={t("sessionReclassifyProjectMenu")}
                  >
                    <div className="project-reclassify-title">
                      {t("sessionReclassifyProjectMenu")}
                    </div>
                    <div className="project-reclassify-list">
                      {projectReclassifyOptions.map((candidate) => (
                        <button
                          key={candidate.id}
                          type="button"
                          className="project-reclassify-option"
                          role="menuitem"
                          disabled={isReclassifyingProject}
                          onClick={() =>
                            void handleReclassifySessionProject(candidate)
                          }
                          title={candidate.path}
                        >
                          <span className="project-reclassify-name">
                            {candidate.name}
                          </span>
                          <span className="project-reclassify-path">
                            {candidate.path}
                          </span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
            <div ref={titleRowRef} className="session-title-row">
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
                <div ref={titleEditControlsRef} className="session-title-edit">
                  <div
                    className="session-title-edit-row"
                    title={
                      generatedRetitle?.deferredInsertion
                        ? generatedRetitle.submittedTurnText
                        : undefined
                    }
                  >
                    <input
                      ref={renameInputRef}
                      type="text"
                      className="session-title-input"
                      value={
                        generatedRetitle?.deferredInsertion ? "" : renameValue
                      }
                      placeholder={
                        generatedRetitle?.deferredInsertion
                          ? t("sessionRetitleDeferred")
                          : undefined
                      }
                      onChange={(e) => setRenameValue(e.target.value)}
                      onKeyDown={handleTitleKeyDown}
                      onBlur={handleTitleBlur}
                      disabled={
                        isRenaming || !!generatedRetitle?.deferredInsertion
                      }
                      title={
                        generatedRetitle?.deferredInsertion
                          ? generatedRetitle.submittedTurnText
                          : undefined
                      }
                    />
                    {titleEditMode === "retitle" && (
                      <button
                        type="button"
                        className={`session-title-edit-button session-title-retitle-accept${
                          generatedRetitle?.deferredInsertion ? " is-armed" : ""
                        }`}
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={handleAcceptGeneratedRetitle}
                        disabled={
                          isRenaming ||
                          !generatedRetitle ||
                          !!generatedRetitle.deferredInsertion ||
                          generatedRetitle.status === "error"
                        }
                        title={
                          generatedRetitle?.status === "generating"
                            ? t("sessionRetitleUseGeneratedWhenReady")
                            : t("sessionRetitleUseGenerated")
                        }
                        aria-label={
                          generatedRetitle?.status === "generating"
                            ? t("sessionRetitleUseGeneratedWhenReady")
                            : t("sessionRetitleUseGenerated")
                        }
                      >
                        <svg
                          width="15"
                          height="15"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          aria-hidden="true"
                        >
                          <path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8v.5z" />
                          <path d="m11 8 4 4-4 4" />
                          <path d="M8 12h7" />
                        </svg>
                      </button>
                    )}
                    <button
                      type="button"
                      className="session-title-edit-button"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={handleSaveTitle}
                      disabled={
                        isRenaming || !!generatedRetitle?.deferredInsertion
                      }
                      title={
                        titleEditMode === "retitle"
                          ? t("sessionRetitleSaveAsTyped")
                          : t("sessionTitleSave")
                      }
                      aria-label={
                        titleEditMode === "retitle"
                          ? t("sessionRetitleSaveAsTyped")
                          : t("sessionTitleSave")
                      }
                    >
                      <svg
                        width="15"
                        height="15"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden="true"
                      >
                        <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
                        <path d="M17 21v-8H7v8" />
                        <path d="M7 3v5h8" />
                      </svg>
                    </button>
                    <button
                      type="button"
                      className="session-title-edit-button"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={handleCancelEditingTitle}
                      disabled={isRenaming}
                      title={t("sessionRetitleCancel")}
                      aria-label={t("sessionRetitleCancel")}
                    >
                      <svg
                        width="15"
                        height="15"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden="true"
                      >
                        <path d="M18 6 6 18" />
                        <path d="m6 6 12 12" />
                      </svg>
                    </button>
                  </div>
                  {titleEditMode === "retitle" &&
                    generatedRetitle &&
                    !generatedRetitle.deferredInsertion && (
                      <div
                        className={`session-title-retitle-status is-${generatedRetitle.status}`}
                        title={
                          generatedRetitle.status === "generating"
                            ? generatedRetitle.submittedTurnText
                            : undefined
                        }
                      >
                        {generatedRetitle.status === "generating"
                          ? t("sessionRetitleGenerating")
                          : generatedRetitle.status === "ready" &&
                              generatedRetitle.title
                            ? `${t("sessionRetitleProposalLabel")} ${generatedRetitle.title}`
                            : (generatedRetitle.error ??
                              t("sessionRetitleFailed"))}
                      </div>
                    )}
                </div>
              ) : (
                <>
                  <button
                    type="button"
                    className="session-title session-title-recent-trigger"
                    onClick={() => setShowRecentSessions(!showRecentSessions)}
                    title={titleTooltip}
                    aria-haspopup="menu"
                    aria-expanded={showRecentSessions}
                  >
                    <span className="session-title-text">{displayTitle}</span>
                  </button>
                  {currentGoal && (
                    <GoalFlag
                      objective={currentGoal}
                      status={goalDetails?.goalStatus}
                      onToggle={
                        goalDetails?.goalStatus
                          ? (action) =>
                              handleSend(`/goal ${action}`, undefined, {
                                preserveComposer: true,
                                localControl: true,
                              })
                          : undefined
                      }
                      onEdit={() => {
                        const controls = draftControlsRef.current;
                        if (!controls || controls.getDraft().trim()) return;
                        controls.setDraft(`/goal ${currentGoal}`);
                        controls.focus?.();
                      }}
                    />
                  )}
                  <button
                    type="button"
                    className={`session-title-chevron-trigger${
                      showRecentSessions ? " is-open" : ""
                    }`}
                    onClick={() => setShowRecentSessions(!showRecentSessions)}
                    title={
                      showRecentSessions
                        ? t("sessionCloseRecentSessions")
                        : t("sessionRecentSessions")
                    }
                    aria-label={
                      showRecentSessions
                        ? t("sessionCloseRecentSessions")
                        : t("sessionRecentSessions")
                    }
                    aria-expanded={showRecentSessions}
                  >
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
                  {supportsForkFromTurn && generatedTitleEnabled && (
                    <button
                      type="button"
                      className="session-title-generate-trigger"
                      onClick={handleGenerateAndApplyTitle}
                      title={t("sessionGenerateNewTitle")}
                      aria-label={t("sessionGenerateNewTitle")}
                    >
                      <svg
                        className="session-title-generate-icon"
                        width="15"
                        height="15"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.75"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden="true"
                      >
                        <path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8v.5z" />
                        <path d="m11 8 4 4-4 4" />
                        <path d="M8 12h7" />
                      </svg>
                    </button>
                  )}
                  <RecentSessionsDropdown
                    currentSessionId={sessionId}
                    isOpen={showRecentSessions}
                    onClose={() => setShowRecentSessions(false)}
                    onNavigate={() => setShowRecentSessions(false)}
                    triggerRef={titleRowRef}
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
                  onGenerateTitle={
                    supportsForkFromTurn
                      ? handleGenerateAndApplyTitle
                      : undefined
                  }
                  onClone={supportsForkFromTurn ? cloneSession : undefined}
                  cloneUnavailableMessage={forkUnavailableMessage}
                  cloneDisabled={forkAfterDisabled}
                  onConfigureProjectSettings={
                    supportsProjectSessionDefaults
                      ? () => setShowProjectSettingsModal(true)
                      : undefined
                  }
                  onConfigureHeartbeat={() => setShowHeartbeatModal(true)}
                  onConfigureRecaps={
                    status.owner === "self"
                      ? () => setShowRecapModal(true)
                      : undefined
                  }
                  promptSuggestionMode={promptSuggestionMode}
                  onTogglePromptSuggestions={
                    currentProviderInfo?.supportsNativePromptSuggestions
                      ? handleTogglePromptSuggestions
                      : undefined
                  }
                  warningRestoreAvailable={
                    hasPendingToolCalls && pendingElsewhereDismissed
                  }
                  onRestoreWarnings={handleRestorePendingElsewhereWarning}
                  onHandoff={
                    effectiveProvider
                      ? () => setShowHandoffModal(true)
                      : undefined
                  }
                  onClear={() => {
                    const params = new URLSearchParams({ projectId });
                    if (effectiveProvider) {
                      params.set("provider", effectiveProvider);
                    }
                    if (liveBadgeModel) {
                      params.set("model", liveBadgeModel);
                    }
                    navigate(`${basePath}/new-session?${params.toString()}`);
                  }}
                  onCompact={
                    supportsManualCompact ? handleCompactSession : undefined
                  }
                  compactDisabled={manualCompactBlocked}
                  onTerminate={handleTerminate}
                  onRestartProvider={
                    serverHasCapability(
                      versionInfo,
                      SIDEBAR_SESSION_RESUME_CAPABILITY,
                    )
                      ? handleRestartProvider
                      : undefined
                  }
                  onReload={() => window.location.reload()}
                  onShare={publicShareActionAvailable ? handleShare : undefined}
                  useFixedPositioning
                  useEllipsisIcon
                  onOpenChange={(open) => {
                    if (open) setShowRecentSessions(false);
                  }}
                />
              )}
            </div>
          </div>
          <div className="session-header-right">
            <ProviderChildSessionControl
              projectId={projectId}
              sessionId={actualSessionId}
              basePath={basePath}
              childrenFromSession={session?.providerChildren}
              processState={processState}
            />
            <ClientLogRecordingBadge inline />
            <SessionPublicShareControls
              enabled={publicSharesEnabled}
              projectId={projectId}
              sessionId={actualSessionId}
              storageState={publicShareGlobalStatus?.storageState}
              canCreateShares={canCreatePublicShares}
              managementAvailable={publicShareManagementAvailable}
              modalOpen={showShareModal}
              modalAnchorRect={shareModalAnchor}
              modalInitialView={shareModalView}
              initialPrompt={publicShareInitialPrompt}
              title={displayTitle}
              onIndicatorClick={handleShareIndicatorClick}
              onIndicatorContextMenu={
                publicShareManagementAvailable
                  ? handleShareIndicatorContextMenu
                  : undefined
              }
              onCloseModal={() => {
                setShowShareModal(false);
                setShareModalAnchor(null);
              }}
              t={t}
            />
            {canStopOwnedProcess && (
              <ThinkingIndicator
                variant="icon"
                className="session-header-thinking"
                label={
                  providerRuntimeStatus
                    ? t("toolbarProviderRuntimeAria", {
                        summary:
                          providerRuntimeStatus.kind === "terminal"
                            ? providerRuntimeStatus.scope === "provider_process"
                              ? t("processInfoRuntimeProcessTerminal")
                              : t("processInfoRuntimeTerminal")
                            : t("processInfoRuntimeRetrying"),
                      })
                    : undefined
                }
              />
            )}
            {!loading && effectiveProvider && (
              <button
                type="button"
                className="provider-badge-button"
                onClick={() => {
                  setModelPanelInitialTab("model");
                  setShowModelSwitchModal(true);
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setModelPanelInitialTab("info");
                  setShowModelSwitchModal(true);
                }}
                title={
                  status.owner === "self" && status.processId
                    ? t("sessionConfigureModel")
                    : t("sessionViewInfo")
                }
              >
                <ProviderBadge
                  provider={effectiveProvider}
                  model={liveBadgeModel}
                  thinking={effectiveModelConfig?.thinking}
                  effort={effectiveModelConfig?.effort}
                  isThinking={canStopOwnedProcess}
                />
              </button>
            )}
          </div>
        </div>
      </header>

      {showHeartbeatModal && (
        <SessionHeartbeatModal
          sessionId={actualSessionId}
          enabled={heartbeatTurnsEnabled}
          heartbeatTurnsAfterMinutes={heartbeatTurnsAfterMinutes}
          heartbeatTurnText={heartbeatTurnText}
          heartbeatForceAfterMinutes={heartbeatForceAfterMinutes}
          onClose={() => setShowHeartbeatModal(false)}
          onSaved={(next) => {
            setLocalHeartbeatTurnsEnabled(next.enabled);
            setLocalHeartbeatTurnsAfterMinutes(next.heartbeatTurnsAfterMinutes);
            setLocalHeartbeatTurnText(next.heartbeatTurnText);
            setLocalHeartbeatForceAfterMinutes(next.heartbeatForceAfterMinutes);
            showToast(t("sessionHeartbeatSaved"), "success");
          }}
        />
      )}

      {showProjectSettingsModal && supportsProjectSessionDefaults && (
        <ProjectSessionDefaultsModal
          projectId={projectId}
          projectName={project?.name}
          onClose={() => setShowProjectSettingsModal(false)}
        />
      )}

      {showRecapModal && status.owner === "self" && (
        <SessionRecapModal
          sessionId={actualSessionId}
          processId={status.processId}
          provider={effectiveProvider}
          currentModel={liveBadgeModel}
          onClose={() => setShowRecapModal(false)}
          onSaved={(settings) => {
            setStatus((prev) =>
              prev.owner === "self" && prev.processId === status.processId
                ? {
                    ...prev,
                    recapAfterSeconds: settings.recapAfterSeconds,
                  }
                : prev,
            );
            showToast(t("sessionRecapSaved"), "success");
          }}
        />
      )}

      {/* Model Switch Modal */}
      {showModelSwitchModal && (
        <ModelSwitchModal
          processId={status.owner === "self" ? status.processId : undefined}
          sessionId={actualSessionId}
          currentModel={session?.model}
          sessionProvider={effectiveProvider}
          onModelChanged={handleModelChanged}
          initialTab={modelPanelInitialTab}
          infoPane={
            session ? (
              <ProcessInfoBody
                sessionId={actualSessionId}
                provider={session.provider}
                model={session.model}
                status={status}
                processState={processState}
                sessionLiveness={sessionLiveness}
                providerRuntimeStatus={providerRuntimeStatus}
                contextUsage={session.contextUsage}
                originator={session.originator}
                cliVersion={session.cliVersion}
                sessionSource={session.source}
                approvalPolicy={session.approvalPolicy}
                sandboxPolicy={session.sandboxPolicy}
                createdAt={session.createdAt}
                sessionStreamConnected={sessionUpdatesConnected}
                lastSessionEventAt={lastStreamActivityAt}
              />
            ) : null
          }
          onActivate={async () => {
            const result = await api.reactivateSession(
              projectId,
              actualSessionId,
            );
            setStatus({
              owner: "self",
              processId: result.processId,
              permissionMode: result.permissionMode,
              appliedPermissionMode: result.appliedPermissionMode,
              modeVersion: result.modeVersion,
              recapAfterSeconds: result.recapAfterSeconds,
            });
          }}
          onClose={() => setShowModelSwitchModal(false)}
        />
      )}

      {showHandoffModal && effectiveProvider && (
        <RestartSessionModal
          projectId={projectId}
          sessionId={actualSessionId}
          provider={effectiveProvider}
          providerDisplayName={currentProviderInfo?.displayName}
          providers={providers}
          models={currentProviderInfo?.models}
          currentModel={liveBadgeModel}
          mode={permissionMode}
          thinking={getThinkingSetting()}
          executor={session?.executor}
          project={projects.find((candidate) => candidate.id === projectId)}
          providerRuntimeStatus={providerRuntimeStatus}
          onRestarted={(result, options) => {
            setShowHandoffModal(false);
            showToast(t("sessionHandoffStarted"), "success");
            const handoffUrl = `${basePath}/projects/${projectId}/sessions/${result.sessionId}`;
            const handoffHref = toBrowserAppHref(handoffUrl);
            if (options?.targetWindow && !options.targetWindow.closed) {
              options.targetWindow.location.href = handoffHref;
              return;
            }
            if (options?.openInNewWindow) {
              window.open(handoffHref, "_blank", "noopener");
              return;
            }
            navigate(handoffUrl, {
              state: createSessionNavigationState({
                initialStatus: {
                  owner: "self",
                  processId: result.processId,
                  permissionMode: result.permissionMode,
                  appliedPermissionMode: result.appliedPermissionMode,
                  modeVersion: result.modeVersion,
                  recapAfterSeconds: result.recapAfterSeconds,
                },
                initialTitle: result.title,
                initialModel: result.model ?? liveBadgeModel,
                initialProvider: result.provider ?? effectiveProvider,
              }),
            });
          }}
          onClose={() => setShowHandoffModal(false)}
        />
      )}

      <ExternalSessionWarning active={status.owner === "external"} />

      {hasPendingToolCalls && pendingToolCall && !pendingElsewhereDismissed && (
        <PendingToolWarning
          toolName={pendingToolCall.toolName}
          toolInput={pendingToolCall.toolInput}
          pendingSinceMs={
            sessionUpdatedAt ? Date.parse(sessionUpdatedAt) : null
          }
          onDismiss={handleDismissPendingElsewhereWarning}
        />
      )}

      <div
        className={`${styles.sessionSplit} session-split${
          wantBtwSplitLayout ? " session-split-with-aside" : ""
        }${
          wantBtwSplitLayout && btwSidePaneCollapsed
            ? " session-split-aside-collapsed"
            : ""
        }`}
      >
        <main className={`${styles.messages} session-messages`} tabIndex={-1}>
          {loading ? (
            <div className="loading">
              <div>{t("sessionLoading")}</div>
              {sessionLoadingProgressText && (
                <div className="loading-detail">
                  {sessionLoadingProgressText}
                </div>
              )}
            </div>
          ) : (
            <SessionMetadataProvider
              projectId={projectId}
              projectPath={project?.path ?? null}
              sessionId={sessionId}
              sessionTitle={displayTitle}
              provider={effectiveProvider}
              model={effectiveModelConfig?.requestedModel ?? liveBadgeModel}
              thinking={sourceReviewModelSettings.thinking}
              effort={sourceReviewModelSettings.effort}
            >
              <AgentContentProvider
                agentContent={agentContent}
                mergeLoadedAgentContent={mergeLoadedAgentContent}
                toolUseToAgent={toolUseToAgent}
                projectId={projectId}
                sessionId={sessionId}
              >
                <SessionViewerProvider
                  sessionId={actualSessionId}
                  inactive={isDomLingerParked}
                  onSendComment={handleSessionViewerCommentSend}
                >
                  <MessageList
                    messages={messages}
                    transcriptDisplayObjects={session?.transcriptDisplayObjects}
                    provider={effectiveProvider}
                    isProcessing={sessionActivityUi.showProcessingIndicator}
                    isCompacting={isCompacting}
                    scrollTrigger={scrollTrigger}
                    scrollToTurnRequest={scrollToTurnRequest}
                    pendingMessages={pendingMessages}
                    deferredMessages={deferredMessages}
                    projectQueueMessages={inlineProjectQueueMessages}
                    projectQueueDispatchPaused={
                      projectQueues.dispatchState.status === "paused"
                    }
                    projectQueueDispatchMutating={
                      projectQueues.mutatingDispatchState
                    }
                    btwAsides={historyBtwAsides}
                    onFocusBtwAside={setFocusedBtwAsideId}
                    onDoneBtwAside={handleDoneBtwAside}
                    onStopBtwAside={handleStopBtwAsideFromTranscript}
                    onToggleBtwAsideExpanded={toggleBtwAsideExpanded}
                    onTransferBtwAsideTurn={transferBtwTurnToMotherComposer}
                    onQuoteSelection={insertQuotedSelection}
                    onStartNewSessionFromSelection={
                      startNewSessionFromSelection
                    }
                    composerDraftSignal={composerDraftSignal}
                    composerEditAvailabilityStore={
                      composerEditAvailabilityStore
                    }
                    quoteClearSignal={quoteClearSignal}
                    onCancelDeferred={handleCancelDeferred}
                    onEditDeferred={handleEditDeferred}
                    onCancelUnconfirmedUserMessage={
                      handleCancelUnconfirmedUserMessage
                    }
                    onSteerDeferred={handleSteerDeferred}
                    onResumeRecoveredDeferred={handleResumeRecoveredDeferred}
                    onSteerRecoveredDeferred={handleSteerRecoveredDeferred}
                    onDeleteRecoveredDeferred={handleDeleteRecoveredDeferred}
                    onCancelProjectQueueMessage={handleCancelProjectQueueItem}
                    onEditProjectQueueMessage={handleEditProjectQueueItem}
                    onSteerProjectQueueMessage={handleSteerProjectQueueItem}
                    onResumeProjectQueueDispatch={
                      handleResumeProjectQueueDispatch
                    }
                    onCorrectLatestUserMessage={handleCorrectLatestUserMessage}
                    onTrimBeforeUserMessage={trimClientFromUserMessage}
                    onForkBeforeUserMessage={
                      supportsForkFromTurn ? forkBeforeUserMessage : undefined
                    }
                    onForkAfterUserMessage={
                      supportsForkFromTurn ? forkAfterUserMessage : undefined
                    }
                    onForkAfterSummaryUserMessage={
                      supportsForkFromTurn ? beginForkAfterSummary : undefined
                    }
                    forkAfterUserMessageDisabled={forkAfterDisabled}
                    forkUnavailableMessage={forkUnavailableMessage}
                    onCopyUserMessage={copyUserMessage}
                    markdownAugments={markdownAugments}
                    activeToolApproval={activeToolApproval}
                    hasOlderMessages={pagination?.hasOlderMessages}
                    olderMessagesCursor={
                      pagination?.truncatedBeforeMessageId ?? null
                    }
                    activeWindowTrimRevision={activeWindowTrimRevision}
                    loadingOlder={loadingOlder}
                    olderLoadContinuationRequired={
                      olderLoadContinuationRequired
                    }
                    onLoadOlderMessages={loadOlderMessages}
                    onReadOlderSearchPage={readOlderSearchPage}
                    clientTailActive={clientTailActive}
                    progressiveRenderEnabled={sessionLoadingProgressEnabled}
                    progressiveRenderStatusVisible={
                      sessionLoadingProgressDetailsVisible
                    }
                    progressiveRenderKey={`${clientSummarySourceKey}:${projectId}:${sessionId}:${location.search}`}
                    progressiveRenderPauseSignal={progressiveRenderPauseSignal}
                    conversationViewStateKey={`${clientSummarySourceKey}:${projectId}:${sessionId}:${location.search}`}
                    initialScrollSnapshot={initialScrollSnapshot}
                    onScrollSnapshotChange={updateRouteScrollSnapshot}
                    onFollowingBottomChange={updateActiveWindowFollowingBottom}
                    onFollowCurrent={handleFollowCurrent}
                    scrollBehaviorMode={sessionScrollBehaviorMode}
                    getForkSummaryTargetHref={getForkSummaryTargetHref}
                    onCancelForkSummary={handleCancelForkSummary}
                    onToggleForkSummaryAutoOpen={
                      handleToggleForkSummaryAutoOpen
                    }
                    onFollowForkSummary={followForkSummary}
                    bangCommandHandlers={bangCommandHandlers}
                    transcriptPositionStore={transcriptPositionStore}
                    inert={isDomLingerParked}
                  />
                </SessionViewerProvider>
              </AgentContentProvider>
            </SessionMetadataProvider>
          )}
        </main>
        <div className={styles.viewerLayer} data-session-viewer-layer />
        {showBtwSidePane && focusedBtwAside && (
          <BtwAsidePane
            aside={focusedBtwAside}
            draft={asideDraft}
            composerRef={asideComposerRef}
            onDraftChange={setAsideDraft}
            onSendFollowup={(text) => handleFocusedBtwSend(text, "pane")}
            onHide={() => setBtwSidePaneCollapsed(true)}
            onDone={(argument) => handleCustomCommand("done", argument)}
            onStop={() => void handleStopBtwAside(focusedBtwAside.id)}
            onTransferToComposer={transferBtwTurnToMotherComposer}
          />
        )}
        {wantBtwSplitLayout && btwSidePaneCollapsed && (
          <button
            type="button"
            className="session-btw-pane-handle"
            onClick={() => setBtwSidePaneCollapsed(false)}
            title="Maximize /btw aside pane"
            aria-label="Maximize /btw aside pane"
          >
            /btw
          </button>
        )}

        <footer className={`${styles.input} session-input`}>
          <div
            className={`session-connection-bar session-connection-${sessionConnectionStatus}`}
          />
          <div data-selection-actions-mobile-slot />
          <div className="session-input-inner">
            <BtwAsideStickyCards
              asides={composerStickyBtwAsides}
              focusedAsideId={focusedBtwAsideId}
              onFocusAside={setFocusedBtwAsideId}
              onToggleAsideExpanded={toggleBtwAsideExpanded}
              onDoneAside={hideBtwAside}
              onHideAside={hideBtwAside}
              onStopAside={(asideId) => void handleStopBtwAside(asideId)}
              onTransferToComposer={transferBtwTurnToMotherComposer}
            />

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
                    projectPath={project?.path ?? null}
                  />
                  <MessageInputToolbar
                    sessionId={actualSessionId}
                    mode={permissionMode}
                    onModeChange={setPermissionMode}
                    modeChangesApplyNextTurn={
                      effectiveProvider === "codex" && shouldDeferMessages
                    }
                    modeChangePending={codexPermissionModeChangePending}
                    supportsPermissionMode={supportsPermissionMode}
                    supportsThinkingToggle={supportsThinkingToggle}
                    slashCommands={allSlashCommands}
                    onSelectSlashCommand={handleToolbarSlashCommand}
                    thinkingProvider={effectiveProvider}
                    thinkingModel={liveBadgeModel}
                    liveThinkingSelection={
                      liveThinkingSelection
                        ? {
                            mode: liveThinkingSelection.mode,
                            level: liveThinkingSelection.effortLevel,
                            onSetMode: handleSetLiveThinkingMode,
                            onSetEffort: handleSetLiveThinkingEffort,
                          }
                        : undefined
                    }
                    contextRequestedModel={effectiveModelConfig?.requestedModel}
                    heartbeatEnabled={heartbeatTurnsEnabled}
                    onToggleHeartbeat={handleToggleHeartbeat}
                    onConfigureHeartbeat={() => setShowHeartbeatModal(true)}
                    contextUsage={session?.contextUsage}
                    lastActivityAt={activityAt}
                    positionTimestampStore={transcriptPositionStore}
                    sessionLiveness={sessionLiveness}
                    providerRuntimeStatus={providerRuntimeStatus}
                    isRunning={status.owner === "self"}
                    isThinking={canStopOwnedProcess}
                    onStop={handleAbort}
                    onDone={
                      syntheticDoneEnabled || mainComposerForAside
                        ? handleDoneAction
                        : undefined
                    }
                    doneTitle={
                      mainComposerForAside ? t("btwAsideDoneTitle") : undefined
                    }
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
                onSend={
                  mainComposerForAside
                    ? (text) => handleFocusedBtwSend(text, "main")
                    : primaryComposerAction === "steer"
                      ? handleSemanticComposerSend
                      : shouldDeferMessages
                        ? handleSemanticComposerDefer
                        : handleSemanticComposerSend
                }
                onQueue={
                  !mainComposerForAside && shouldDeferMessages
                    ? handleSemanticComposerDefer
                    : undefined
                }
                onProjectQueue={
                  !mainComposerForAside && showProjectQueueAction
                    ? handleProjectQueue
                    : undefined
                }
                onProjectQueueNewSession={
                  !mainComposerForAside && supportsProjectQueue
                    ? handleProjectQueueNewSession
                    : undefined
                }
                primaryActionKind={
                  mainComposerForAside ? "send" : primaryComposerAction
                }
                placeholder={
                  mainComposerForAside
                    ? "/btw follow-up"
                    : status.owner === "external"
                      ? t("sessionPlaceholderExternal")
                      : processState === "idle"
                        ? shouldDeferMessages
                          ? t("sessionPlaceholderQueue")
                          : t("sessionPlaceholderResume")
                        : t("sessionPlaceholderQueue")
                }
                mode={permissionMode}
                onModeChange={setPermissionMode}
                modeChangesApplyNextTurn={
                  effectiveProvider === "codex" && shouldDeferMessages
                }
                modeChangePending={codexPermissionModeChangePending}
                supportsPermissionMode={supportsPermissionMode}
                supportsThinkingToggle={supportsThinkingToggle}
                supportsSteering={generallySupportsSteering}
                supportsSteerNow={supportsSteerNow}
                isRunning={status.owner === "self"}
                isThinking={canStopOwnedProcess}
                onStop={handleAbort}
                onDone={
                  syntheticDoneEnabled || mainComposerForAside
                    ? handleDoneAction
                    : undefined
                }
                doneTitle={
                  mainComposerForAside ? t("btwAsideDoneTitle") : undefined
                }
                draftKey={
                  mainComposerForAside && focusedBtwAside
                    ? `draft-btw-${focusedBtwAside.sessionId ?? focusedBtwAside.id}`
                    : sessionDraftKey
                }
                draftIndex={
                  mainComposerForAside && focusedBtwAside
                    ? undefined
                    : sessionDraftReference
                }
                onDraftControlsReady={handleDraftControlsReady}
                onDraftTextChange={handleComposerDraftTextChange}
                bangSupport={
                  mainComposerForAside || !bangCommandsSupported
                    ? undefined
                    : composerBangSupport
                }
                turnRecall={composerTurnRecall}
                correctionActive={
                  !mainComposerForAside && correctionDraft !== null
                }
                onCancelCorrection={
                  mainComposerForAside ? undefined : handleCancelCorrection
                }
                onRecallLastSubmission={handleRecallLastSubmission}
                onCancelLatestDeferred={handleCancelLatestDeferred}
                collapsed={
                  !!(
                    pendingInputRequest &&
                    pendingInputRequest.sessionId === actualSessionId
                  )
                }
                onFullPaneControlsReady={handleFullPaneControlsReady}
                contextUsage={session?.contextUsage}
                lastActivityAt={activityAt}
                positionTimestampStore={transcriptPositionStore}
                sessionLiveness={sessionLiveness}
                providerRuntimeStatus={providerRuntimeStatus}
                projectId={projectId}
                sessionId={sessionId}
                attachments={mainComposerForAside ? [] : attachments}
                onAttach={mainComposerForAside ? undefined : handleAttach}
                onRemoveAttachment={
                  mainComposerForAside ? undefined : handleRemoveAttachment
                }
                uploadProgress={mainComposerForAside ? [] : uploadProgress}
                slashCommands={allSlashCommands}
                onCustomCommand={handleCustomCommand}
                onBtwShortcut={
                  childSessionParentHref || supportsBtwAsides
                    ? handleBtwShortcut
                    : undefined
                }
                btwActive={!!mainComposerForAside || !!childSessionParentHref}
                btwHasAsides={
                  stickyBtwAsides.length > 0 || !!childSessionParentHref
                }
                btwToolbarMode={btwToolbarMode}
                thinkingProvider={effectiveProvider}
                thinkingModel={liveBadgeModel}
                liveThinkingSelection={
                  liveThinkingSelection
                    ? {
                        mode: liveThinkingSelection.mode,
                        level: liveThinkingSelection.effortLevel,
                        onSetMode: handleSetLiveThinkingMode,
                        onSetEffort: handleSetLiveThinkingEffort,
                      }
                    : undefined
                }
                contextRequestedModel={effectiveModelConfig?.requestedModel}
                heartbeatEnabled={heartbeatTurnsEnabled}
                onToggleHeartbeat={handleToggleHeartbeat}
                onConfigureHeartbeat={() => setShowHeartbeatModal(true)}
                promptSuggestion={
                  mainComposerForAside
                    ? undefined
                    : (promptSuggestion ?? undefined)
                }
                onDismissPromptSuggestion={
                  mainComposerForAside ? undefined : dismissPromptSuggestion
                }
                forkSummaryMode={
                  !mainComposerForAside && forkSummaryDraft
                    ? {
                        title: t("forkSummaryComposerTitle"),
                        description: t("forkSummaryComposerDescription"),
                        placeholder: t("forkSummaryComposerPlaceholder"),
                        submitLabel: t("forkSummarySubmit"),
                        tooltip: t("forkSummaryTooltip"),
                        icon: "⑂",
                        noSummarySubmitLabel: t("forkSummaryNoSummarySubmit"),
                        noSummaryTooltip: t("forkSummaryNoSummaryTooltip"),
                        noSummaryIcon: "↱",
                        // The composer fork mode is dismissed the moment we
                        // submit (generation backgrounds into the indicator),
                        // so it never sits in a submitting state.
                        submitting: false,
                        onCancel: () => setForkSummaryDraft(null),
                        onSubmit: (instructions) => {
                          void submitForkAfterSummary(
                            forkSummaryDraft.sourceMessageId,
                            instructions,
                          );
                        },
                        onSubmitWithoutSummary: (nextTurnText) => {
                          void submitForkAfterWithoutSummary(
                            forkSummaryDraft.sourceMessageId,
                            nextTurnText,
                          );
                        },
                      }
                    : undefined
                }
                onForkSummaryShortcut={
                  !mainComposerForAside && supportsForkFromTurn
                    ? beginForkAfterInitialTurn
                    : undefined
                }
              />
            )}
          </div>
        </footer>
      </div>
    </MainContent>
  );
}
