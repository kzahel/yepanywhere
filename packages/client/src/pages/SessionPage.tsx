import { FileDropZone } from "../components/FileDropZone";
import { SessionPageModals } from "../components/SessionPageModals";
import { useActingPrincipal } from "../hooks/useActingPrincipal";
import {
  getSessionCreation,
  pendingSessionCreation,
  settleSessionCreation,
} from "../lib/sessionCreation";
import { isSessionCreationPending } from "@yep-anywhere/shared";
import { SessionCreationNotice } from "../components/SessionCreationNotice";
import {
  sessionViewerResourceHref,
  viewerYaSessionId,
} from "../lib/sessionViewerUrl";
import { RoutedSessionContext } from "../contexts/RoutedSessionContext";
import {
  DRAFT_STORAGE_EVENT,
  collectSyncedSubmissionAttachments,
} from "../lib/draftSyncStorage";
import {
  SessionIssuesLink,
  SessionIssuesProvider,
} from "../components/SessionIssuesLink";
import { useSessionBangCommands } from "../hooks/useSessionBangCommands";
import { useProjectReclassifyMenu } from "../hooks/useProjectReclassifyMenu";
import { useSessionAttachmentUploads } from "../hooks/useSessionAttachmentUploads";
import { useSessionForkActions } from "../hooks/useSessionForkActions";
import { useSessionQueuedMessageActions } from "../hooks/useSessionQueuedMessageActions";
import { useSessionHeaderActions } from "../hooks/useSessionHeaderActions";
import { useSessionRouteSync } from "../hooks/useSessionRouteSync";
import { useSessionTitleEditing } from "../hooks/useSessionTitleEditing";
import { useSessionTranscriptJumps } from "../hooks/useSessionTranscriptJumps";
import type {
  EffortLevel,
  PromptSuggestionMode,
  ProjectQueueItemSummary,
  SlashCommand,
  ThinkingMode,
  ThinkingOption,
  TranscriptDisplayObject,
  UploadedFile,
  UserQuestionAnswers,
} from "@yep-anywhere/shared";
import {
  SESSION_CONVERSATION_CONTEXT_CAPABILITY,
  PUBLIC_SHARE_MANAGEMENT_CAPABILITY,
  SIDEBAR_SESSION_RESUME_CAPABILITY,
  SYNTHETIC_ARCHIVE_COMMAND_CAPABILITY,
  SYNTHETIC_DONE_COMMAND_CAPABILITY,
  SYNTHETIC_TERMINATE_COMMAND_CAPABILITY,
  type FileViewLineTarget,
  type FileViewSearchResult,
  getCanonicalInvocationToken,
  isClaudeProviderName,
  parseFileViewArgument,
  readInventoryGoalDetails,
  serverHasCapability,
  thinkingOptionToConfig,
  SERVER_CAPABILITIES,
  isTurnEffort,
  isRewindSlashCommand,
  REWIND_SLASH_COMMANDS,
} from "@yep-anywhere/shared";
import {
  type ComponentProps,
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { api } from "../api/client";
import { getUiCreationProvenance } from "../lib/sessionCreationProvenance";
import { createSessionApi } from "../api/sessionClient";
import {
  SessionViewerProvider,
  SessionViewerTranscriptGate,
} from "../components/SessionManagedViewer";
import sessionHeaderStyles from "../components/SessionHeader.module.css";
import { ProjectAppIcon } from "../components/ProjectAppIcon";
import { LastSessionFile } from "../components/LastSessionFile";
import styles from "./SessionPage.module.css";
import { GoalFlag } from "../components/GoalNotice";
import { ClearloopRemainingBadge } from "../components/ClearloopRemainingBadge";

import { BtwAsidePane } from "../components/BtwAsidePane";
import {
  SessionRightPane,
  SessionAppAction,
} from "../components/SessionRightPane";
import { useSessionRightPane } from "../hooks/useSessionRightPane";
import { useSessionViewPublication } from "../hooks/useSessionViewPublication";
import { useSessionThinkingSelection } from "../hooks/useSessionThinkingSelection";
import { ProjectAppViewer } from "../components/ProjectAppViewer";
import type { VoiceInputButtonRef } from "../components/VoiceInputButton";
import { useCanUseBearerGrants } from "../hooks/useActingPrincipal";
import { useComposerHistoryScope } from "../hooks/useComposerHistoryScope";
import { BtwAsideStickyCards } from "../components/BtwAsideStickyCards";
import { ClientLogRecordingBadge } from "../components/ClientLogRecordingBadge";
import { ExternalSessionWarning } from "../components/ExternalSessionWarning";
import { useStartNewSessionWithPrefillAction } from "../components/FileResourceActions";
import { HostIdentityMarker } from "../components/HostIdentityMarker";
import { PendingToolWarning } from "../components/PendingToolWarning";
import { ProviderChildSessionControl } from "../components/ProviderChildSessionControl";
import { useQuestionAside } from "../hooks/useQuestionAside";
import { useQuestionAsideSetting } from "../hooks/useQuestionAsideSetting";
import { QuestionAsideCard } from "../components/QuestionAsideCard";
import type {
  FullPaneComposerControls,
  UploadProgress,
} from "../components/MessageInput";
import { MessageInputToolbar } from "../components/MessageInputToolbar";
import type {
  ChosenNewSessionQueueTarget,
  NewSessionQueueTarget,
} from "../components/NewSessionQueueOptions";
import { ProviderBadge } from "../components/ProviderBadge";
import { QuestionAnswerPanel } from "../components/QuestionAnswerPanel";
import { RecentSessionsDropdown } from "../components/RecentSessionsDropdown";
import { routerBindingChip } from "../components/RouterPoolSelector";
import { SessionMenu } from "../components/SessionMenu";
import {
  SessionPublicShareControls,
  SessionShareMenuLabel,
} from "../components/SessionPublicShareControls";
import { SessionRenameEditor } from "../components/SessionRenameEditor";
import { useSessionHeaderLayout } from "../hooks/useSessionHeaderLayout";
import { useProjectCodeNamePreferences } from "../hooks/useProjectCodeNamePreferences";
import { ToolApprovalPanel } from "../components/ToolApprovalPanel";
import { AgentContentProvider } from "../contexts/AgentContentContext";
import { GlossaryProjectProvider } from "../contexts/GlossaryContext";
import { RenderModeProvider } from "../contexts/RenderModeContext";
import { SessionLivenessProvider } from "../contexts/SessionLivenessContext";
import { ProjectPathLinkSettingsProvider } from "../contexts/ProjectPathLinkSettingsContext";
import { SessionMetadataProvider } from "../contexts/SessionMetadataContext";
import { useCurrentSourceRuntime } from "../contexts/SourceRuntimeContext";
import {
  StreamingMarkdownProvider,
  useStreamingMarkdownContext,
} from "../contexts/StreamingMarkdownContext";
import { useToastContext } from "../contexts/ToastContext";
import { useActivityBusState } from "../hooks/useActivityBusState";
import { useAttachmentUploadQuality } from "../hooks/useAttachmentUploadQuality";
import { useDeveloperMode } from "../hooks/useDeveloperMode";
import { useDocumentTitle } from "../hooks/useDocumentTitle";
import { useComposerBeacon } from "../hooks/useComposerBeacon";
import { useTranscriptComposerFocus } from "../hooks/useTranscriptComposerFocus";
import type { DraftControls } from "../hooks/useDraftPersistence";
import { applyEarlyComposerTyping } from "../lib/earlyComposerTyping";
import type { EarlyTypingHandoff } from "../lib/earlyTypingHandoff";
import { AsyncQuestionsProvider } from "../contexts/AsyncQuestionsContext";
import { ComposerInsertContext } from "../contexts/ComposerInsertContext";
import { useEngagementTracking } from "../hooks/useEngagementTracking";
import { useBtwAsides } from "../hooks/useBtwAsides";
import { useGeneratedTitleEnabled } from "../hooks/useGeneratedTitleEnabled";
import { useGeneratedTitleLength } from "../hooks/useGeneratedTitleLength";
import {
  getModelSetting,
  getThinkingSetting,
  getShowThinkingSetting,
} from "../hooks/useModelSettings";
import { useProjectQueues } from "../hooks/useProjectQueues";
import { useProject, useProjects } from "../hooks/useProjects";
import { useProviders } from "../hooks/useProviders";
import { usePublicShareStatus } from "../hooks/usePublicShareStatus";
import { useRemoteBasePath } from "../hooks/useRemoteBasePath";
import { useServerSettings } from "../hooks/useServerSettings";
import {
  forkSessionAtEffort,
  useLongContextEffortGuard,
} from "../hooks/useLongContextEffortGuard";
import { useSessionLoadingProgress } from "../hooks/useSessionLoadingProgress";
import type { SessionLoadProgress } from "../hooks/useSessionMessages";
import { useSessionPerformanceSettings } from "../hooks/useSessionPerformanceSettings";
import { useSessionToolbarPresence } from "../hooks/useSessionToolbarPresence";
import { useLongPress } from "../hooks/useLongPress";
import { useProjectAppUpdates } from "../hooks/useProjectAppUpdates";
import { useVersion } from "../hooks/useVersion";
import { useSessionSpeechVocabulary } from "../hooks/useSessionSpeechVocabulary";
import type {
  CommentAnchor,
  DraftTextChangeMetadata,
} from "../lib/commentAnchors";
import { recentProjectFileMentions } from "../lib/recentProjectPathLinks";
import { buildProjectFileViewUrl } from "../components/FileDiffViewLinks";
import {
  getProjectViewerFilePath,
  presentProjectFileViewer,
} from "../components/FilePathLink";
import {
  isInterruptedDraftAttachmentValidation,
  validateDraftAttachmentRefs,
} from "../lib/draftAttachmentStaging";
import { draftTextIsAccountedFor } from "../lib/draftSendReconcile";
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
import {
  useActiveProjectSessionIds,
  useClientSummarySourceKey,
  useProviderRuntimeStatusForSession,
  useSessionCollectionRecord,
} from "../lib/clientSummaryStore";
import { activityBus } from "../lib/activityBus";
import type {
  LastComposerSubmission,
  SentComposerSubmission,
} from "../lib/composerRecall";
import {
  createComposerDraftSignal,
  createComposerEditAvailabilityStore,
} from "../lib/composerDraftSignal";
import { createTranscriptPositionStore } from "../lib/transcriptPositionStore";
import { logSessionUiTrace } from "../lib/diagnostics/uiTrace";
import { isEffortLevel } from "../lib/effortLevels";
import {
  executeSemanticUiComposerAction,
  isSemanticUiActionHarnessEnabled,
  registerSemanticUiComposerExecutors,
} from "../lib/semanticUiActions";
import {
  thinkingOptionFromProcess,
  thinkingOptionFromSelection,
} from "../lib/liveThinkingConfig";
import { getPersistentEditApprovalResponse } from "../lib/permissionModes";
import { embeddedFrameHoldsFocus } from "../lib/programmaticFocus";
import {
  sessionResumeOverrides,
  stoppedSessionPermissionMode,
} from "../lib/sessionResumeSettings";
import { getSessionConnectionBarStatus } from "../lib/sessionConnectionBar";
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
  insertComposerTransferText,
  materializeComposerAttachmentsForSubmission,
} from "../lib/sessionComposerSubmission";
import { createSessionComposerSend } from "../lib/sessionComposerSend";
import {
  resolveSessionProviderCapabilities,
  resolveSteerNowDefault,
} from "../lib/providerCapabilities";
import { shouldShowProjectQueueAffordance } from "../lib/projectQueueVisibility";
import { createSessionDraftStorageKey } from "../lib/sessionDraftStorage";
import { getSessionActivityUiState } from "../lib/sessionActivityUi";
import { parseSessionNavigationState } from "../lib/sessionNavigationState";
import { getPublicShareInitialPrompt } from "../lib/sessionPublicSharePrompt";
import { getUnifiedSessionForkAvailability } from "../lib/sessionForkAvailability";
import { SessionRewindProvider } from "../contexts/SessionRewindContext";
import { supportsSessionRewind } from "../lib/sessionRewind";
import { useSessionRewindControls } from "../hooks/useSessionRewindControls";
import { isBtwAsideSession } from "../lib/btwAsideSessions";
import { resolveSessionPageTitle } from "../lib/sessionTitleHelpers";
import { resolveFileViewSubmission } from "../lib/fileViewCommand";
import {
  CLIENT_SLASH_COMMANDS,
  createClientSlashCommand,
  FILE_VIEW_COMMAND_NAMES,
  normalizeSlashCommandForMatch,
  resolveComposerDoneTarget,
  resolveComposerSessionOperation,
} from "../lib/slashCommands";
import { generateUUID } from "../lib/uuid";
import {
  loadMessageInputModule,
  loadMessageListModule,
} from "../lib/sessionRouteModules";

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

const EMPTY_PROJECT_QUEUE_ITEMS: readonly ProjectQueueItemSummary[] = [];

function parsePositiveIntegerParam(value: string | null): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

export interface SessionPageRouteLocation {
  pathname: string;
  search: string;
  hash?: string;
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
    readonly activationVersion?: number;
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
  const viewerLocation = useLocation();
  const sessionId =
    sessionIdProp ??
    (params.sessionId
      ? viewerYaSessionId(params.sessionId, viewerLocation.search)
      : undefined);

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
          <ProjectPathLinkSettingsProvider>
            <SessionPageContent
              key={sessionId}
              projectId={projectId}
              sessionId={sessionId}
              routeLocation={routeLocation}
              isDomLingerParked={isDomLingerParked}
              progressiveRenderPauseSignal={progressiveRenderPauseSignal}
            />
          </ProjectPathLinkSettingsProvider>
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
  progressiveRenderPauseSignal?: {
    readonly current: boolean;
    readonly activationVersion?: number;
  };
}) {
  const { t } = useI18n();
  const { showToast } = useToastContext();
  const { openSidebar, isWideScreen, setRightPaneExpanded } =
    useNavigationLayout();
  const basePath = useRemoteBasePath();
  const startNewSessionWithPrefill = useStartNewSessionWithPrefillAction();
  const { project } = useProject(projectId);
  const { projects } = useProjects();
  const { headerRef, layout: headerLayout } = useSessionHeaderLayout();
  const { projectCodeNamesEnabled } = useProjectCodeNamePreferences();
  const hideHeaderSecondary = headerLayout !== "full";
  const condensedHeader = headerLayout === "narrow";
  const activeProjectSessionIds = useActiveProjectSessionIds(projectId);
  const clientSummarySourceKey = useClientSummarySourceKey();
  const historyScope = useComposerHistoryScope();
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
  const { principal: creationPrincipal, resolved: creationPrincipalResolved } =
    useActingPrincipal();
  const creationKey = `ya-session-creation:${clientSummarySourceKey}:${creationPrincipal.username}:${sessionDraftKey}`;
  const creationOwner = useRef({ active: true, key: creationKey });
  creationOwner.current.key = creationKey;
  const captureCreationView = () => ({
    key: creationKey,
    href: sessionViewerResourceHref(window.location.href),
    // A native-label replace changes React Router's key, but keeps this entry.
    historyIndex: window.history.state?.idx,
    activation: progressiveRenderPauseSignal?.activationVersion,
  });
  const ownsCreationView = (token: ReturnType<typeof captureCreationView>) =>
    creationOwner.current.active &&
    creationOwner.current.key === token.key &&
    !progressiveRenderPauseSignal?.current &&
    progressiveRenderPauseSignal?.activationVersion === token.activation &&
    sessionViewerResourceHref(window.location.href) === token.href &&
    window.history.state?.idx === token.historyIndex;

  useEffect(() => {
    creationOwner.current.active = true;
    return () => {
      creationOwner.current.active = false;
    };
  }, []);
  const [creationRecovery, setCreationRecovery] = useState<{
    key: string;
    requestId: string;
    accepted?: boolean;
  } | null>(null);
  useEffect(() => {
    const pending = pendingSessionCreation(creationKey);
    setCreationRecovery(
      pending
        ? {
            key: creationKey,
            requestId: pending.requestId,
            accepted: Boolean(pending.receipt),
          }
        : null,
    );
  }, [creationKey]);

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

  const supportsProjectSettings =
    serverHasCapability(versionInfo, SERVER_CAPABILITIES.projectService) ||
    serverHasCapability(versionInfo, SERVER_CAPABILITIES.projectAccessSharing);

  const projectQueueProjectIds = useMemo(() => [projectId], [projectId]);
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
  const [projectAppTarget] = useState(navState.projectApp);
  const [projectAppOpen, setProjectAppOpen] = useState(!!navState.projectApp);
  // Full view hides the session and sidebar behind the app until Back.
  const [projectAppFull, setProjectAppFull] = useState(false);
  // Which side last opened it, for the agent's view report.
  const [projectAppOpenedBy, setProjectAppOpenedBy] = useState<
    "session" | "user"
  >("user");
  const projectAppPress = useLongPress(() => {
    setProjectAppOpenedBy("user");
    setProjectAppOpen(true);
    setProjectAppFull(true);
  });
  const [projectAppVoice, setProjectAppVoice] =
    useState<VoiceInputButtonRef | null>(null);
  const projectServiceSupported = serverHasCapability(
    versionInfo,
    SERVER_CAPABILITIES.projectService.name,
  );
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
    refreshTranscriptTail,
    refreshSessionMetadata,
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
    permissionMode: browserPermissionMode,
    permissionModeOverride,
    loading,
    sessionLoadProgress,
    error,
    sessionUpdatesConnected,
    sessionUpdatesResubscribing,
    lastStreamActivityAt,
    setStatus,
    setProcessState,
    setPendingInputRequest,
    setPermissionMode,
    pendingMessages,
    addPendingMessage,
    removePendingMessage,
    isMessageDelivered,
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
  const savedLaunchSettings = session?.effectiveLaunchSettings;
  const permissionMode =
    status.owner === "self"
      ? browserPermissionMode
      : stoppedSessionPermissionMode(
          browserPermissionMode,
          permissionModeOverride,
          savedLaunchSettings?.permissionMode,
        );
  const providerRuntimeStatus =
    useProviderRuntimeStatusForSession(actualSessionId);
  // Arriving from the project's App entry names a target; otherwise a project
  // that declares a root app still offers it, closed until asked for, and
  // opens it when a turn ends with the app newly declared or rebuilt. An open
  // app stays mounted across readings until the user closes it.
  const projectDeclaresApp = useProjectAppUpdates(
    projectId,
    projectServiceSupported,
    processState === "in-turn" || processState === "waiting-input",
    projectAppOpen,
    () => {
      setProjectAppOpenedBy("session");
      setProjectAppOpen(true);
    },
  );
  const projectAppEnabled =
    projectServiceSupported && (!!projectAppTarget || projectDeclaresApp);
  const [rightPaneTarget, setRightPaneTarget] = useState<HTMLDivElement | null>(
    null,
  );
  const [viewerLayerTarget, setViewerLayerTarget] =
    useState<HTMLDivElement | null>(null);
  // A limited user is refused operator app links, so those apps are not
  // offered to them; artifacts and their own sandboxed session apps still
  // are (topics/limited-users.md § Authorization).
  const canUseBearerGrants = useCanUseBearerGrants();
  const rightPane = useSessionRightPane(
    `${basePath}/${projectId}/${sessionId}`,
    messages,
    versionInfo?.artifactViewer,
    !isDomLingerParked && !loading,
    sessionId,
    {
      projectId,
      fetchAppLinks: canUseBearerGrants,
      onStopError: (message) =>
        showToast(t("sessionRightPaneStopFailed", { message }), "error"),
    },
  );
  useSessionViewPublication(
    sessionId,
    !isDomLingerParked && !loading,
    projectAppEnabled && projectAppOpen
      ? {
          target: projectAppTarget,
          full: projectAppFull,
          openedBy: projectAppOpenedBy,
        }
      : null,
  );
  useEffect(() => {
    if (rightPane.paneViewer?.id) setProjectAppOpen(false);
  }, [rightPane.paneViewer?.id]);
  useLayoutEffect(() => {
    if (isDomLingerParked) return;
    setRightPaneExpanded?.(
      rightPane.expanded || (projectAppEnabled && projectAppOpen),
    );
    return () => setRightPaneExpanded?.(false);
  }, [
    rightPane.expanded,
    projectAppEnabled,
    projectAppOpen,
    isDomLingerParked,
    setRightPaneExpanded,
  ]);
  const goalDetails = readInventoryGoalDetails(slashCommands);
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

  const speechVocabulary = useSessionSpeechVocabulary(
    `${projectId}/${actualSessionId}`,
    messages,
    serverHasCapability(
      versionInfo,
      SERVER_CAPABILITIES.speechVocabularySessionTerms.name,
    ),
  );
  const publicSharesEnabled =
    (serverSettings?.publicSharesEnabled ?? false) && canUseBearerGrants;
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
  const projectQueueItemsForProject =
    projectQueues.queuesByProject[projectId] ?? EMPTY_PROJECT_QUEUE_ITEMS;
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
  const showProjectQueueAction = shouldShowProjectQueueAffordance({
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
  const sessionConnectionStatus = getSessionConnectionBarStatus({
    hasSessionUpdateStream,
    sessionUpdatesConnected,
    sessionUpdatesResubscribing,
    showConnectionBars,
    transportReconnecting: connectionState === "reconnecting",
  });

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
        savedLaunchSettings ?? session?.effectiveModelSettings,
        latestCodexConfigAck,
      ),
    [
      latestCodexConfigAck,
      liveModelConfig,
      savedLaunchSettings,
      session?.effectiveModelSettings,
    ],
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
  const earlyComposerTypingRef = useRef<EarlyTypingHandoff | null>(null);
  const earlyComposerTypingKeyRef = useRef<string | null>(null);
  // undefined: nothing waiting. null: focus only. string: prefill to apply.
  const pendingEarlyComposerPrefillRef = useRef<string | null | undefined>(
    undefined,
  );
  const flushEarlyComposerTyping = useCallback(
    (controls = draftControlsRef.current) => {
      if (!controls || pendingEarlyComposerPrefillRef.current === undefined) {
        return;
      }
      const prefill = pendingEarlyComposerPrefillRef.current;
      pendingEarlyComposerPrefillRef.current = undefined;
      const handoff = earlyComposerTypingRef.current;
      earlyComposerTypingRef.current = null;
      applyEarlyComposerTyping({ controls, handoff, prefill });
    },
    [],
  );
  const [quoteClearSignal, setQuoteClearSignal] = useState(0);
  const pendingMotherComposerTransferRef = useRef<string | null>(null);
  const lastComposerSubmissionRef = useRef<LastComposerSubmission | null>(null);
  const lastSentComposerSubmissionRef = useRef<SentComposerSubmission | null>(
    null,
  );
  // Copies of a router-pinned session inherit its account; successors that
  // start a fresh session (handoff, title helper) or call the provider
  // directly (fork with summary) cannot yet.
  const routedSession = Boolean(session?.routerBinding);
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
    isWideScreen:
      isWideScreen &&
      !rightPane.expanded &&
      !(projectAppEnabled && projectAppOpen),
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
  const beginBeaconSubmission = useComposerBeacon({
    sessionKey: `${sourceRuntime.sourceKey}:${actualSessionId}`,
    active: !isDomLingerParked && !mainComposerForAside,
    controlsRef: draftControlsRef,
    messages,
    isMessageDelivered,
  });
  const transcriptComposerFocus = useTranscriptComposerFocus(
    !isDomLingerParked &&
      !mainComposerForAside &&
      !(projectAppEnabled && projectAppOpen),
    draftControlsRef,
  );
  const [correctionDraft, setCorrectionDraft] = useState<{
    messageId: string;
    originalText: string;
    recalled?: boolean;
  } | null>(null);
  const preCorrectionDraftRef = useRef<{
    text: string;
    attachments: ComposerAttachment[];
  } | null>(null);
  const { questionAsidesEnabled } = useQuestionAsideSetting();
  const questionSourceApi = useMemo(
    () =>
      createSessionApi((path, options) =>
        sourceRuntime.transport.fetch(path, options),
      ),
    [sourceRuntime],
  );
  const questionAside = useQuestionAside({
    projectId,
    sessionId: actualSessionId,
    sourceKey: sourceRuntime.sourceKey,
    sourceApi: questionSourceApi,
    provider: effectiveProvider,
    model: effectiveModelConfig?.model ?? session?.model,
    executor: session?.executor,
    nativeContextRoute: serverHasCapability(
      versionInfo,
      SESSION_CONVERSATION_CONTEXT_CAPABILITY,
    ),
    showToast,
    onSaved: () => {
      void fetchNewMessages();
    },
    sendToMain: (text) =>
      handleSendRef.current(text, undefined, { preserveComposer: true }),
    onContinueAsBtw: (childId) => {
      const params = new URLSearchParams(location.search);
      params.set("btw", childId);
      navigate({ search: params.toString() });
    },
  });
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

  const stagedComposerAttachmentRefs = attachments
    .filter(isComposerStagedAttachment)
    .map(toPersistedStagedAttachmentRef);
  const attachmentNavigationGuardActive = hasAttachmentNavigationRisk({
    pendingUploadCount: uploadProgress.length,
    transientAttachmentCount: 0,
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
      revokeAttachmentPreviewUrls(
        preCorrectionDraftRef.current?.attachments ?? [],
      );
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
  const supportsTurnEffort =
    serverHasCapability(
      versionInfo,
      SERVER_CAPABILITIES.turnEffortModifiers.name,
    ) &&
    (effectiveProvider === "codex" || isClaudeProviderName(effectiveProvider));
  // Same-session rewind commands work on an idle or stopped session as well
  // as a live one, so they are offered whenever the server and provider
  // support rewind (topics/session-rewind.md), not only for a live process.
  const supportsRewind = supportsSessionRewind(versionInfo, effectiveProvider);
  // `/v` opens a file without a turn, so it needs no live process; a
  // provider command or skill named `v` or `view` keeps its name
  // (topics/view-command.md).
  const supportsFileViewCommand =
    status.owner !== "external" &&
    serverHasCapability(
      versionInfo,
      SERVER_CAPABILITIES.projectFileViewCommand.name,
    ) &&
    !slashCommands.some((command) =>
      FILE_VIEW_COMMAND_NAMES.includes(
        normalizeSlashCommandForMatch(command.name),
      ),
    );
  const allSlashCommands = useMemo(() => {
    if (status.owner === "external") {
      return [];
    }

    const orderedCommands: SlashCommand[] =
      status.owner === "self"
        ? CLIENT_SLASH_COMMANDS.filter(
            (command) =>
              command !== "model" &&
              !isRewindSlashCommand(command) &&
              (!isTurnEffort(command) || supportsTurnEffort) &&
              (command !== "btw" || supportsBtwAsides) &&
              (command !== "done" ||
                mainComposerForAside ||
                syntheticDoneEnabled) &&
              (command !== "terminate" ||
                (syntheticDoneEnabled && supportsSyntheticTerminate)),
          ).map(createClientSlashCommand)
        : [];
    if (supportsRewind) {
      for (const command of REWIND_SLASH_COMMANDS) {
        orderedCommands.push(createClientSlashCommand(command));
      }
    }
    if (supportsFileViewCommand) {
      orderedCommands.push(createClientSlashCommand("view"));
    }
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
      // YA's same-session /clear deliberately shadows the provider's native
      // /clear on rewind-capable providers (topics/session-rewind.md).
      if (supportsRewind && normalized === "clear") continue;
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
    supportsFileViewCommand,
    supportsManualCompact,
    supportsRewind,
    supportsSyntheticTerminate,
    supportsTurnEffort,
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
  const providerServiceTiers = useMemo(
    () =>
      currentProviderInfo?.models?.flatMap((model) => model.serviceTiers ?? []),
    [currentProviderInfo],
  );
  // Default to true for backwards compatibility (except slash commands)
  const supportsPermissionMode =
    currentProviderInfo?.supportsPermissionMode ?? true;
  const supportsThinkingToggle =
    currentProviderInfo?.supportsThinkingToggle ?? true;
  const { generallySupportsSteering, supportsSteerNow } = providerCapabilities;
  const steerNowDefault = resolveSteerNowDefault(
    versionInfo?.clientDefaults,
    effectiveProvider,
  );
  const {
    selection: liveThinkingSelection,
    thinkingOverride,
    setStoppedSelection,
  } = useSessionThinkingSelection(
    `${sourceRuntime.sourceKey}/${sessionId}`,
    status.owner === "self",
    status.owner === "self" ||
      savedLaunchSettings ||
      session?.effectiveModelSettings
      ? effectiveModelConfig
      : null,
    currentProviderInfo,
  );
  const getImplicitComposerThinking = useCallback(() => {
    if (thinkingOverride !== undefined) return thinkingOverride;
    const hasRetainedSessionModelConfig =
      status.owner === "self" ||
      liveModelConfig !== null ||
      savedLaunchSettings !== undefined ||
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
    savedLaunchSettings,
    session?.effectiveModelSettings,
    status.owner,
    thinkingOverride,
  ]);
  const getResumeSettings = useCallback(
    (explicitThinking?: ThinkingOption) =>
      sessionResumeOverrides(
        savedLaunchSettings !== undefined,
        {
          mode: permissionMode,
          model: session?.model ?? getModelSetting(),
          thinking: getImplicitComposerThinking(),
        },
        {
          mode: permissionModeOverride,
          thinking: explicitThinking ?? thinkingOverride,
        },
      ),
    [
      savedLaunchSettings,
      permissionMode,
      session?.model,
      getImplicitComposerThinking,
      permissionModeOverride,
      thinkingOverride,
    ],
  );

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
  // Title generation runs a helper session, which cannot keep a router pin.
  const supportsTitleGeneration = supportsForkFromTurn && !routedSession;
  const forkAfterDisabled =
    status.owner === "external" ||
    processState === "in-turn" ||
    processState === "waiting-input";
  const forkAtEffort = useCallback(
    async (thinking: ThinkingOption) => {
      try {
        const result = await forkSessionAtEffort(
          projectId,
          actualSessionId,
          thinking,
          getUiCreationProvenance(versionInfo),
        );
        showToast(t("forkFromTurnStarted"), "success");
        navigate(
          `${basePath}/projects/${projectId}/sessions/${result.sessionId}`,
        );
      } catch (error) {
        showToast(
          t("longContextEffortWarningForkFailed", {
            message: error instanceof Error ? error.message : String(error),
          }),
          "error",
        );
      }
    },
    [actualSessionId, basePath, navigate, projectId, showToast, t, versionInfo],
  );
  const {
    guardEffortChange,
    warning: longContextEffortWarning,
    choose: chooseLongContextEffortWarning,
  } = useLongContextEffortGuard({
    provider: effectiveProvider,
    providerInfo: currentProviderInfo,
    // The resolved id, not a selection alias, decides the cache-safe exemption.
    model: effectiveModelConfig?.model ?? effectiveModelConfig?.requestedModel,
    contextTokens: session?.contextUsage?.inputTokens,
    settings: serverSettings?.longContextEffortWarning,
    canFork: supportsForkFromTurn && !forkAfterDisabled,
    forkWithThinking: forkAtEffort,
    translateEffort: t,
    noEffortLabel: t("longContextEffortWarningNoEffort"),
  });
  const activityRenderItems = useMemo(
    () => getCachedWebTranscriptProjection(messages),
    [messages],
  );
  const {
    forkSummaryDraft,
    setForkSummaryDraft,
    submitForkAfterSummary,
    submitForkAfterWithoutSummary,
    createDirectTurnFork,
    cloneSession,
    followForkSummary,
    getForkSummaryTargetHref,
    handleCancelForkSummary,
    handleToggleForkSummaryAutoOpen,
    beginForkAfterSummary,
    beginForkAfterInitialTurn,
    forkBeforeUserMessage,
    forkAfterUserMessage,
    copyUserMessage,
    handoffFromUserMessage,
  } = useSessionForkActions({
    projectId,
    actualSessionId,
    session,
    messages,
    activityRenderItems,
    permissionMode,
    versionInfo,
    basePath,
    navigate,
    draftControlsRef,
    attachments,
    uploadProgress,
    forkAfterDisabled,
    updateTranscriptDisplayObjectsForSession,
    effectiveProvider,
    effectiveModel,
    effectiveModelConfig,
    currentGoal,
    project,
    getImplicitComposerThinking,
    startNewSessionWithPrefill,
  });
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
  const canStopOwnedProcess =
    sessionActivityUi.canStopOwnedProcess ||
    (status.owner === "self" &&
      deferredMessages.some(
        (entry) => entry.operation === "compact" && entry.cancellable === false,
      ));
  const hasQueuedCompaction = deferredMessages.some(
    (entry) => entry.operation === "compact",
  );
  const shouldDeferMessages =
    sessionActivityUi.shouldDeferMessages ||
    hasQueuedCompaction ||
    (isCompacting &&
      serverHasCapability(
        versionInfo,
        SERVER_CAPABILITIES.queuedSessionCompaction,
      ));
  const primaryComposerAction =
    shouldDeferMessages &&
    generallySupportsSteering &&
    !hasQueuedCompaction &&
    !isCompacting
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

  // Recent sessions dropdown state
  const [showRecentSessions, setShowRecentSessions] = useState(false);
  const titleRowRef = useRef<HTMLDivElement>(null);

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
  const [localPromptSuggestionMode, setLocalPromptSuggestionMode] = useState<
    PromptSuggestionMode | undefined
  >(undefined);
  const sessionCollectionRecord = useSessionCollectionRecord(sessionId);

  // Reset local metadata state when sessionId changes
  useEffect(() => {
    void sessionId;
    setLocalCustomTitle(undefined);
    setLocalIsArchived(undefined);
    setLocalIsStarred(undefined);
    setLocalPromptSuggestionMode(undefined);
  }, [sessionId]);

  const {
    showProjectReclassifyMenu,
    isReclassifyingProject,
    projectBreadcrumbRef,
    projectReclassifyMenuRef,
    projectReclassifyOptions,
    handleProjectBreadcrumbContextMenu,
    handleReclassifySessionProject,
  } = useProjectReclassifyMenu({
    projectId,
    actualSessionId,
    projects,
    basePath,
    location,
    navigate,
    isDomLingerParked,
    setShowRecentSessions,
  });

  useSessionRouteSync({
    sessionId,
    projectId,
    actualSessionId,
    session,
    location,
    navigate,
    basePath,
    isDomLingerParked,
  });

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
    const previous = preCorrectionDraftRef.current;
    preCorrectionDraftRef.current = null;
    setCorrectionDraft(null);
    draftControlsRef.current?.setDraft(previous?.text ?? "");
    setComposerAttachments(previous?.attachments ?? [], {
      revokeRemovedPreviewUrls: true,
    });
  }, [setComposerAttachments]);

  useEffect(() => {
    if (!correctionDraft && preCorrectionDraftRef.current) {
      revokeAttachmentPreviewUrls(preCorrectionDraftRef.current.attachments);
      preCorrectionDraftRef.current = null;
    }
  }, [correctionDraft]);

  useEffect(() => {
    if (
      isDomLingerParked &&
      correctionDraft?.recalled &&
      draftControlsRef.current?.getDraft() === correctionDraft.originalText &&
      attachmentsRef.current.length === 0
    ) {
      handleCancelCorrection();
    }
  }, [isDomLingerParked, correctionDraft, handleCancelCorrection]);

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

      preCorrectionDraftRef.current ??= {
        text: draftControls.getDraft(),
        attachments: [...attachmentsRef.current],
      };
      draftControls.setDraft(content);
      setComposerAttachments([]);
      setCorrectionDraft({ messageId, originalText: content });
    },
    [setComposerAttachments, showToast, t],
  );

  // Approval panel collapsed state (separate from message input collapse)
  const [approvalCollapsed, setApprovalCollapsed] = useState(false);
  const [showProjectSettingsModal, setShowProjectSettingsModal] =
    useState(false);
  const [showRecapModal, setShowRecapModal] = useState(false);
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
  const openSessionInfo = useCallback(() => {
    setShowRecentSessions(false);
    setModelPanelInitialTab("info");
    setShowModelSwitchModal(true);
  }, []);
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
    async (options?: { pendingMessageId?: string; detach?: boolean }) => {
      const collectRendez =
        !mainComposerForAside &&
        (attachmentsRef.current.some(
          (attachment) =>
            isComposerStagedAttachment(attachment) &&
            attachment.rendezPath !== undefined,
        ) ||
          (serverSettings?.rendez?.projects[project?.path ?? ""] ??
            serverSettings?.rendez?.enabled ??
            false));
      return collectComposerAttachmentsForSubmissionHelper({
        currentAttachments: attachmentsRef.current,
        detach: options?.detach,
        pendingUploads: [...pendingUploadsRef.current.values()],
        setComposerAttachments,
        pendingMessageId: options?.pendingMessageId,
        updatePendingMessage,
        uploadingStatus: t("sessionUploading"),
        uploadFailureMessage: t("composerAttachmentUploadFailed"),
        collectSyncedAttachments: collectRendez
          ? () => collectSyncedSubmissionAttachments(sessionDraftKey)
          : undefined,
      });
    },
    [
      mainComposerForAside,
      serverSettings?.rendez,
      project?.path,
      sessionDraftKey,
      setComposerAttachments,
      t,
      updatePendingMessage,
    ],
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

  const closeFocusedBtwAside = useCallback(() => {
    if (!focusedBtwAside) {
      return false;
    }
    hideBtwAside(focusedBtwAside.id);
    return true;
  }, [focusedBtwAside, hideBtwAside]);

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

  const { handleSend, handleQueue, queueComposerForProject } =
    createSessionComposerSend({
      projectId,
      sessionId,
      t,
      showToast,
      basePath,
      sourceRuntime,
      sourceSummary,
      sourceTransport,
      versionInfo,
      creationPrincipalResolved,
      creationKey,
      captureCreationView,
      ownsCreationView,
      setCreationRecovery,
      syntheticDoneEnabled,
      supportsSyntheticDone,
      supportsSyntheticArchive,
      supportsSyntheticTerminate,
      navigate,
      session,
      status,
      processState,
      setIsCompacting,
      actualSessionId,
      setStatus,
      setProcessState,
      addPendingMessage,
      removePendingMessage,
      isMessageDelivered,
      updatePendingMessage,
      setDeferredMessages,
      reconnectStream,
      permissionMode,
      goalDetails,
      effectiveProvider,
      setScrollTrigger,
      draftControlsRef,
      lastComposerSubmissionRef,
      routedSession,
      supportsBtwAsides,
      beginBeaconSubmission,
      correctionDraft,
      setCorrectionDraft,
      attachments,
      attachmentsRef,
      pendingUploadsRef,
      rememberSentSubmission,
      setComposerAttachments,
      materializeComposerAttachments,
      supportsManualCompact,
      supportsTurnEffort,
      supportsRewind,
      supportsFileViewCommand,
      getImplicitComposerThinking,
      getResumeSettings,
      setShowHandoffModal,
      collectComposerAttachmentsForSubmission,
      handleSyntheticSessionBoundary,
      // Declared below; each wrapper calls this render's callback when a
      // send runs, as the functions did when they lived here.
      clearQuoteAnchors: () => clearQuoteAnchors(),
      handleCustomCommand: (command, argument) =>
        handleCustomCommand(command, argument),
      handleFileViewCommand: (argument) => handleFileViewCommand(argument),
      handleLocalTitleCommand: (title) => handleLocalTitleCommand(title),
    });
  const handleSendRef = useRef(handleSend);
  handleSendRef.current = handleSend;
  const handleSessionViewerCommentSend = useCallback(
    (text: string) =>
      handleSendRef.current(text, undefined, { preserveComposer: true }),
    [],
  );

  const { bangCommandHandlers, composerBangSupport } = useSessionBangCommands({
    projectId,
    sessionId,
    session,
    messages,
    updateTranscriptDisplayObjectsForSession,
    setScrollTrigger,
    handleSendRef,
    draftControlsRef,
  });

  const { composerTurnRecall, recordCommandRecall, scrollToTurnRequest } =
    useSessionTranscriptJumps({
      sessionId,
      actualSessionId,
      messages,
      location,
      navigate,
      loading,
      loadingOlder,
      isDomLingerParked,
      pagination,
      loadOlderMessages,
      navState,
      initialStatus,
      initialTitle,
      initialModel,
      initialProvider,
      earlyComposerTypingRef,
      earlyComposerTypingKeyRef,
      pendingEarlyComposerPrefillRef,
      flushEarlyComposerTyping,
    });

  const handleQueueRef = useRef(handleQueue);
  handleQueueRef.current = handleQueue;
  const executeComposerSend = useCallback(
    (text: string, metadata?: MessageSubmissionMetadata) =>
      handleSendRef.current(text, metadata),
    [],
  );
  const executeComposerDefer = useCallback(
    async (text: string, metadata?: MessageSubmissionMetadata) => {
      await handleQueueRef.current(text, metadata);
    },
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

  const handleProjectQueue = (
    text: string,
    metadata?: MessageSubmissionMetadata,
  ) => queueComposerForProject(text, "existing-session", metadata);

  const handleProjectQueueNewSession = (
    text: string,
    metadata?: MessageSubmissionMetadata,
    target?: ChosenNewSessionQueueTarget,
  ) => queueComposerForProject(text, "new-session", metadata, target);

  const projectQueueNewSessionTarget: NewSessionQueueTarget = {
    projectId,
    provider: effectiveProvider,
    model: session?.model ?? getModelSetting(),
  };

  const {
    handleResumeProjectQueueDispatch,
    handleCancelProjectQueueItem,
    handleEditProjectQueueItem,
    handleSteerProjectQueueItem,
    handleCancelDeferred,
    handleEditDeferred,
    handleCancelUnconfirmedUserMessage,
    handleSteerDeferred,
    handleDeliverDeferredWithoutCompaction,
    handleDeleteRecoveredDeferred,
    handleResumeRecoveredDeferred,
    handleSteerRecoveredDeferred,
    handleCancelLatestDeferred,
  } = useSessionQueuedMessageActions({
    projectId,
    sessionId,
    projectQueues,
    projectQueueItemsForProject,
    deferredMessages,
    setDeferredMessages,
    setStatus,
    setProcessState,
    setPermissionMode,
    removeUnconfirmedSelfSend,
    draftControlsRef,
    attachmentsRef,
    pendingUploadsRef,
    lastComposerSubmissionRef,
    lastSentComposerSubmissionRef,
    setComposerAttachments,
    setCorrectionDraft,
  });

  const handleRecallLastSubmission = useCallback((): boolean => {
    const lastSubmission = lastComposerSubmissionRef.current;
    if (!lastSubmission?.text.trim()) {
      return false;
    }

    const draftControls = draftControlsRef.current;
    if (!draftControls) {
      return false;
    }

    // A still-queued message is left alone. Submitting leaves focus in the
    // empty composer, so ↑ meant to scroll would otherwise unqueue it; the
    // chip's Edit and cancel controls are the explicit ways to change it
    // (topics/queued-messages.md).
    if (
      lastSubmission.kind === "queued" &&
      deferredMessages.some(
        (message) => message.tempId === lastSubmission.tempId,
      )
    ) {
      return false;
    }

    preCorrectionDraftRef.current ??= {
      text: draftControls.getDraft(),
      attachments: [...attachmentsRef.current],
    };
    draftControls.setDraft(lastSubmission.text);
    setComposerAttachments([], { revokeRemovedPreviewUrls: true });
    setCorrectionDraft({
      messageId:
        lastSubmission.kind === "sent"
          ? lastSubmission.id
          : lastSubmission.tempId,
      originalText: lastSubmission.text,
      recalled: true,
    });
    return true;
  }, [deferredMessages, setComposerAttachments]);

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
      const nextThinking = thinkingOptionFromSelection(mode, effortLevel);
      const verdict = await guardEffortChange(
        nextThinking,
        liveThinkingSelection
          ? thinkingOptionFromSelection(
              liveThinkingSelection.mode,
              liveThinkingSelection.effortLevel,
            )
          : undefined,
      );
      if (verdict === "skip") return;
      if (status.owner !== "self" || !currentOwnedProcessId) {
        setStoppedSelection({ mode, effortLevel });
        return;
      }
      try {
        const result = await api.setProcessConfig(currentOwnedProcessId, {
          thinking: nextThinking,
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
      guardEffortChange,
      liveThinkingSelection,
      setStoppedSelection,
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
      if (sessionOperation.kind === "focused-aside" && closeFocusedBtwAside()) {
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
      const finalDraft = insertComposerTransferText(
        controls,
        quotedText.trimEnd(),
        quotedText.endsWith("\n") ? "\n" : "",
      );
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
      if (mainComposerForAside || !controls) {
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

      const syncEnabled = serverHasCapability(
        versionInfo,
        SERVER_CAPABILITIES.draftSync.name,
      );
      if (syncEnabled)
        setComposerAttachments(state.refs, {
          persistDraft: false,
          revokeRemovedPreviewUrls: true,
        });
      const hydrationId = draftAttachmentHydrationRef.current + 1;
      draftAttachmentHydrationRef.current = hydrationId;

      try {
        const refs = await validateDraftAttachmentRefs(sourceTransport, state);
        if (
          draftAttachmentHydrationRef.current !== hydrationId ||
          JSON.stringify(controls.getAttachmentState()?.refs) !==
            JSON.stringify(state.refs)
        ) {
          return;
        }
        if (syncEnabled && refs.length !== state.refs.length) {
          showToast(t("sessionDraftAttachmentsUnavailable"), "info");
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
        if (
          draftAttachmentHydrationRef.current !== hydrationId ||
          JSON.stringify(controls.getAttachmentState()?.refs) !==
            JSON.stringify(state.refs)
        ) {
          return;
        }
        // An interrupted validation says nothing about whether the file exists.
        // Keep its chip too; sending still requires server materialization.
        setComposerAttachments(state.refs, {
          persistDraft: false,
          revokeRemovedPreviewUrls: true,
        });
        if (!isInterruptedDraftAttachmentValidation(err))
          showToast(t("sessionDraftAttachmentsValidationFailed"), "info");
      }
    },
    [
      sourceTransport,
      mainComposerForAside,
      setComposerAttachments,
      showToast,
      versionInfo,
      t,
    ],
  );

  // A submit clears the composer optimistically and keeps the text as a
  // recovery copy, so a sibling tab or a reload can still see a send that
  // never landed. Once this session proves the same text is durable — a real
  // user turn, or a message the server holds queued — that copy is noise, and
  // its tab may be gone before its own confirm ever runs.
  const reconcilePendingSendDraftRef = useRef<() => void>(() => {});
  const reconcilePendingSendDraft = useCallback(() => {
    draftControlsRef.current?.discardPendingSendDraft(({ text, sentAtMs }) =>
      draftTextIsAccountedFor({
        draftText: text,
        sentAtMs,
        messages,
        deferredMessages,
      }),
    );
  }, [deferredMessages, messages]);
  reconcilePendingSendDraftRef.current = reconcilePendingSendDraft;

  useEffect(() => {
    reconcilePendingSendDraft();
  }, [reconcilePendingSendDraft]);

  const handleDraftControlsReady = useCallback(
    (controls: DraftControls) => {
      draftControlsRef.current = controls;
      flushEarlyComposerTyping(controls);
      flushPendingMotherComposerTransfer(controls);
      void hydrateDraftAttachments(controls);
      // History may already have loaded before the composer mounted.
      reconcilePendingSendDraftRef.current();
    },
    [
      flushEarlyComposerTyping,
      flushPendingMotherComposerTransfer,
      hydrateDraftAttachments,
    ],
  );

  useEffect(() => {
    flushPendingMotherComposerTransfer();
  }, [flushPendingMotherComposerTransfer]);

  useEffect(() => {
    void sessionDraftKey;
    void hydrateDraftAttachments();
  }, [hydrateDraftAttachments, sessionDraftKey]);
  useEffect(() => {
    const changed = (event: Event) => {
      if (
        (event as CustomEvent<{ key: string }>).detail.key === sessionDraftKey
      ) {
        const current =
          draftControlsRef.current?.getAttachmentState()?.refs ?? [];
        const shown = attachmentsRef.current
          .filter(isComposerStagedAttachment)
          .map(toPersistedStagedAttachmentRef);
        if (JSON.stringify(current) === JSON.stringify(shown)) return;
        void hydrateDraftAttachments();
      }
    };
    window.addEventListener(DRAFT_STORAGE_EVENT, changed);
    return () => window.removeEventListener(DRAFT_STORAGE_EVENT, changed);
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

  const {
    contextValue: sessionRewindContextValue,
    handleRewindCommand,
    clearloopControls,
    cancelClearloop: handleCancelClearloop,
  } = useSessionRewindControls({
    projectId,
    sessionId: actualSessionId,
    messages,
    supportsRewind,
    provider: effectiveProvider,
    model: session?.model,
    refreshTranscriptTail,
    draftControlsRef,
    recordCommandRecall,
    createDirectTurnFork,
  });

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
        if (closeFocusedBtwAside()) {
          return true;
        }
        // Menu and toolbar selection reach here without the composer's
        // submit routing, so apply the same decision it would.
        const sessionOperation = resolveComposerSessionOperation({
          text: argument ? `/done ${argument}` : "/done",
          routesToFocusedAside: false,
          syntheticDoneEnabled,
          syntheticDoneSupported: supportsSyntheticDone,
          syntheticArchiveSupported: supportsSyntheticArchive,
          syntheticTerminateSupported: supportsSyntheticTerminate,
          hasAttachments:
            attachmentsRef.current.length > 0 ||
            pendingUploadsRef.current.size > 0,
        });
        if (sessionOperation.kind === "session-boundary") {
          void handleSyntheticSessionBoundary(sessionOperation.command);
          return true;
        }
        return false;
      }
      if (
        command === "clear" ||
        command === "fork" ||
        command === "clearloop"
      ) {
        return handleRewindCommand(command, argument);
      }
      return false;
    },
    [
      closeFocusedBtwAside,
      handleCompactSession,
      handleRewindCommand,
      handleSyntheticSessionBoundary,
      startBtwAside,
      supportsManualCompact,
      supportsSyntheticArchive,
      supportsSyntheticDone,
      supportsSyntheticTerminate,
      syntheticDoneEnabled,
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

  const { uploadAttachedFiles, handleAttach, handleRemoveAttachment } =
    useSessionAttachmentUploads({
      projectId,
      sessionId,
      session,
      project,
      sourceTransport,
      attachmentQuality,
      currentProviderInfo,
      effectiveModel,
      effectiveModelConfig,
      historyScope,
      isDomLingerParked,
      ensureDraftAttachmentBatchId,
      setUploadProgress,
      setComposerAttachments,
      attachmentsRef,
      pendingUploadsRef,
    });
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
    project?.codeName,
    displayTitle,
    !isDomLingerParked,
  );

  const {
    isEditingTitle,
    renamePresentation,
    titleEditMode,
    renameValue,
    setRenameValue,
    isRenaming,
    generatedRetitle,
    attachTitleInput,
    titleEditControlsRef,
    saveTitleValue,
    handleStartEditingTitle,
    handleGenerateAndApplyTitle,
    handleLocalTitleCommand,
    handleCancelEditingTitle,
    handleTitleBlur,
    handleSaveTitle,
    handleAcceptGeneratedRetitle,
    handleTitleKeyDown,
  } = useSessionTitleEditing({
    projectId,
    sessionId,
    displayTitle,
    condensedHeader,
    titleRowRef,
    setShowRecentSessions,
    supportsTitleGeneration,
    routedSession,
    generatedTitleLength,
    draftControlsRef,
    setLocalCustomTitle,
    isDomLingerParked,
  });
  const quoteTextBlockRef = useRef<((anchor: CommentAnchor) => void) | null>(
    null,
  );
  const quoteFromTranscript = useCallback((anchor: CommentAnchor) => {
    quoteTextBlockRef.current?.(anchor);
  }, []);
  const fileViewCommandCountRef = useRef(0);

  /** Open one `/v` result the way a file link in this session opens. */
  const openFileViewEntry = (
    path: string,
    line: FileViewLineTarget | undefined,
  ): string => {
    const filePath = getProjectViewerFilePath(projectId, path);
    presentProjectFileViewer({
      id: `file-view-command-${++fileViewCommandCountRef.current}`,
      sessionId: actualSessionId,
      projectId,
      filePath,
      lineNumber: line?.lineNumber,
      lineEnd: line?.lineEnd,
      quoteReply: quoteFromTranscript,
      openInNewTabUrl: toBrowserAppHref(
        buildProjectFileViewUrl({
          basePath,
          filePath,
          lineNumber: line?.lineNumber,
          lineEnd: line?.lineEnd,
          projectId,
          viewMode: "full",
        }),
      ),
    });
    return filePath;
  };
  const openFileViewEntryRef = useRef(openFileViewEntry);
  openFileViewEntryRef.current = openFileViewEntry;
  // Stable across renders, so the composer is not re-rendered for it.
  const fileViewCommandOptions = useMemo(
    () => ({
      open: (path: string, line?: FileViewLineTarget) => {
        openFileViewEntryRef.current(path, line);
      },
    }),
    [],
  );

  /**
   * `/v parts…`: open the best-ranked matching file the way a file link in
   * this session opens (topics/view-command.md). The composer already emptied
   * on submit; a failure restores the typed command.
   */
  const handleFileViewCommand = async (argument: string) => {
    const controls = draftControlsRef.current;
    const fail = (message: string) => {
      controls?.restoreFromStorage();
      showToast(message, "error");
    };
    const { parts, line } = parseFileViewArgument(argument);
    if (!parts.length) {
      fail(t("fileViewNeedsPath", { command: "v" }));
      return;
    }
    const query = parts.join(" ");
    let result: FileViewSearchResult;
    try {
      result = await resolveFileViewSubmission(
        (path, init) => sourceTransport.fetch<FileViewSearchResult>(path, init),
        projectId,
        parts,
        recentProjectFileMentions(activityRenderItems),
      );
    } catch (error) {
      fail(
        t("fileViewSearchFailed", {
          query,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      return;
    }
    const entry = result.entries[0];
    if (!entry) {
      fail(t("fileViewNoMatch", { query }));
      return;
    }
    controls?.confirmInputClear();
    const filePath = openFileViewEntry(entry.path, line);
    // A named path is unambiguous; a search that picked among several says so.
    if (entry.tier !== "path" && result.entries.length > 1) {
      showToast(
        t("fileViewOpenedOfMany", {
          path: filePath,
          count: `${result.entries.length}${result.truncated ? "+" : ""}`,
        }),
        "info",
      );
    }
  };

  const {
    showShareModal,
    setShowShareModal,
    shareModalView,
    shareModalAnchor,
    setShareModalAnchor,
    handleToggleArchive,
    handleToggleStar,
    handleTogglePromptSuggestions,
    hasUnread,
    handleToggleRead,
    handleTerminate,
    handleRestartProvider,
    handleShare,
    handleShareIndicatorClick,
    handleShareIndicatorContextMenu,
  } = useSessionHeaderActions({
    sessionId,
    projectId,
    actualSessionId,
    session,
    sessionCollectionRecord,
    status,
    setStatus,
    isArchived,
    isStarred,
    promptSuggestionMode,
    localPromptSuggestionMode,
    setLocalIsArchived,
    setLocalIsStarred,
    setLocalPromptSuggestionMode,
    isDomLingerParked,
    loading,
    draftControlsRef,
    publicShareManagementAvailable,
  });

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

    // A failed read must not remove navigation, the transcript or the draft.
    // Render the failure inside the transcript below, including cold entry.
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

  const content = (
    <MainContent
      isWideScreen={isWideScreen}
      innerClassName={`${styles.workspace} ${rightPane.expanded || (projectAppEnabled && projectAppOpen) ? styles.rightPane : ""}`}
    >
      <FileDropZone
        className={styles.sessionColumn}
        enabled={
          !!projectId &&
          !!sessionId &&
          !isDomLingerParked &&
          !mainComposerForAside &&
          !isSessionCreationPending(session?.creation)
        }
        onFiles={handleAttach}
        ownerKey={creationKey}
      >
        <header
          ref={headerRef}
          data-session-read-scope={sessionId}
          className={`session-header ${sessionHeaderStyles.header}`}
          data-header-layout={headerLayout}
          data-inline-rename={
            isEditingTitle &&
            titleEditMode === "manual" &&
            renamePresentation === "inline"
              ? "true"
              : undefined
          }
        >
          <div
            className={`session-header-inner ${sessionHeaderStyles.row}${isWideScreen ? ` ${sessionHeaderStyles.noLeadingControl}` : ""}`}
          >
            <div className={`session-header-left ${sessionHeaderStyles.left}`}>
              {/* Sidebar opener for the overlay sidebar only. On desktop the
                sidebar owns its own toggle, expanded or collapsed. */}
              {!isWideScreen && (
                <button
                  type="button"
                  className="sidebar-toggle"
                  onClick={openSidebar}
                  title={t("sessionOpenSidebar")}
                  aria-label={t("sessionOpenSidebar")}
                >
                  <SidebarIcon />
                </button>
              )}
              <HostIdentityMarker />
              <SessionAppAction
                pane={{
                  ...rightPane,
                  select: (url) => {
                    setProjectAppOpen(false);
                    return rightPane.select(url);
                  },
                }}
              />
              {projectAppEnabled && (
                <button
                  type="button"
                  className={sessionHeaderStyles.projectAppButton}
                  aria-pressed={projectAppOpen}
                  aria-label={t("projectAppLabel")}
                  title={t("projectAppFullViewHint")}
                  {...projectAppPress.handlers}
                  onClick={projectAppPress.click(() => {
                    setProjectAppFull(false);
                    setProjectAppOpenedBy("user");
                    setProjectAppOpen((value) => !value);
                  })}
                >
                  <ProjectAppIcon />
                </button>
              )}
              {/* Project breadcrumb */}
              {project?.name && (
                <div
                  className={`project-breadcrumb-wrapper ${sessionHeaderStyles.project}`}
                >
                  <Link
                    ref={projectBreadcrumbRef}
                    to={`${basePath}/sessions?project=${projectId}`}
                    className="project-breadcrumb"
                    title={
                      project.caption
                        ? `${project.name}\n${project.caption.text}`
                        : project.name
                    }
                    aria-label={project.name}
                    onContextMenu={handleProjectBreadcrumbContextMenu}
                  >
                    {projectCodeNamesEnabled && project.codeName
                      ? project.codeName
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
              <div
                ref={titleRowRef}
                className={`session-title-row ${sessionHeaderStyles.titleRow}`}
              >
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
                ) : isEditingTitle &&
                  !isDomLingerParked &&
                  titleEditMode === "manual" ? (
                  <SessionRenameEditor
                    initialTitle={displayTitle}
                    presentation={renamePresentation}
                    onSave={saveTitleValue}
                    onCancel={handleCancelEditingTitle}
                  />
                ) : isEditingTitle ? (
                  <div
                    ref={titleEditControlsRef}
                    className="session-title-edit"
                  >
                    <div
                      className="session-title-edit-row"
                      title={
                        generatedRetitle?.deferredInsertion
                          ? generatedRetitle.submittedTurnText
                          : undefined
                      }
                    >
                      <input
                        ref={attachTitleInput}
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
                            generatedRetitle?.deferredInsertion
                              ? " is-armed"
                              : ""
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
                      className={`session-title session-title-recent-trigger ${sessionHeaderStyles.titleWithBadge}`}
                      onClick={() => setShowRecentSessions(!showRecentSessions)}
                      title={titleTooltip}
                      aria-haspopup="menu"
                      aria-expanded={showRecentSessions}
                    >
                      <span className="session-title-text">{displayTitle}</span>
                      {session?.clearloop !== undefined && (
                        <ClearloopRemainingBadge
                          badge={session.clearloop}
                          controls={clearloopControls}
                        />
                      )}
                    </button>
                    {session?.routerBinding &&
                      serverHasCapability(
                        versionInfo,
                        SERVER_CAPABILITIES.agentAuthRouter.name,
                      ) &&
                      (() => {
                        const chip = routerBindingChip(
                          t,
                          session.routerBinding,
                        );
                        return (
                          <button
                            type="button"
                            className={sessionHeaderStyles.routerAccount}
                            title={chip.tooltip}
                            aria-label={chip.tooltip}
                            onClick={() => {
                              setModelPanelInitialTab("info");
                              setShowModelSwitchModal(true);
                            }}
                          >
                            {chip.label}
                          </button>
                        );
                      })()}
                    {currentGoal && (
                      <GoalFlag
                        objective={currentGoal}
                        status={goalDetails?.goalStatus}
                        key={actualSessionId}
                        onCommand={(argument) =>
                          handleSend(`/goal ${argument}`, undefined, {
                            preserveComposer: true,
                            localControl: true,
                          })
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
                    {supportsTitleGeneration && generatedTitleEnabled && (
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
                      currentSessionTitle={titleTooltip}
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
              </div>
            </div>
            <div
              className={`session-header-right ${sessionHeaderStyles.actions}`}
            >
              <ProviderChildSessionControl
                projectId={projectId}
                sessionId={actualSessionId}
                basePath={basePath}
                childrenFromSession={session?.providerChildren}
                processState={processState}
              />
              <ClientLogRecordingBadge inline />
              <SessionPublicShareControls
                indicatorVisible={!hideHeaderSecondary}
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
              {!hideHeaderSecondary && !loading && actualSessionId && (
                <SessionIssuesLink
                  sessionId={actualSessionId}
                  projectId={projectId}
                  messageCount={messages.length}
                />
              )}
              {!loading && effectiveProvider && (
                <button
                  type="button"
                  className={`provider-badge-button ${sessionHeaderStyles.modelButton}`}
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
                    condensed={condensedHeader}
                    provider={effectiveProvider}
                    model={liveBadgeModel}
                    thinking={effectiveModelConfig?.thinking}
                    effort={effectiveModelConfig?.effort}
                    isThinking={canStopOwnedProcess}
                  />
                </button>
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
                  onShowInfo={openSessionInfo}
                  onGenerateTitle={
                    supportsTitleGeneration
                      ? handleGenerateAndApplyTitle
                      : undefined
                  }
                  onClone={supportsForkFromTurn ? cloneSession : undefined}
                  cloneUnavailableMessage={forkUnavailableMessage}
                  cloneDisabled={forkAfterDisabled}
                  onConfigureProjectSettings={
                    supportsProjectSettings
                      ? () => setShowProjectSettingsModal(true)
                      : undefined
                  }
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
                    effectiveProvider && !routedSession
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
                  triggerClassName={sessionHeaderStyles.menuTrigger}
                  shareLabel={
                    hideHeaderSecondary ? (
                      <SessionShareMenuLabel
                        enabled={publicSharesEnabled}
                        projectId={projectId}
                        sessionId={actualSessionId}
                        storageState={publicShareGlobalStatus?.storageState}
                        t={t}
                      />
                    ) : undefined
                  }
                  additionalItems={
                    hideHeaderSecondary
                      ? (close) => (
                          <SessionIssuesLink
                            sessionId={actualSessionId}
                            projectId={projectId}
                            messageCount={messages.length}
                            presentation="menu"
                            onSelect={close}
                          />
                        )
                      : undefined
                  }
                  useFixedPositioning
                  useEllipsisIcon
                  onOpenChange={(open) => {
                    if (open) setShowRecentSessions(false);
                  }}
                />
              )}
            </div>
          </div>
        </header>

        <SessionPageModals
          actualSessionId={actualSessionId}
          basePath={basePath}
          chooseLongContextEffortWarning={chooseLongContextEffortWarning}
          creationPrincipal={creationPrincipal}
          creationPrincipalResolved={creationPrincipalResolved}
          currentProviderInfo={currentProviderInfo}
          effectiveProvider={effectiveProvider}
          guardEffortChange={guardEffortChange}
          handleModelChanged={handleModelChanged}
          isDomLingerParked={isDomLingerParked}
          lastStreamActivityAt={lastStreamActivityAt}
          liveBadgeModel={liveBadgeModel}
          longContextEffortWarning={longContextEffortWarning}
          modelPanelInitialTab={modelPanelInitialTab}
          navigate={navigate}
          permissionMode={permissionMode}
          processState={processState}
          project={project}
          projectId={projectId}
          projects={projects}
          providerRuntimeStatus={providerRuntimeStatus}
          providers={providers}
          providerServiceTiers={providerServiceTiers}
          routedSession={routedSession}
          savedLaunchSettings={savedLaunchSettings}
          session={session}
          sessionLiveness={sessionLiveness}
          sessionUpdatesConnected={sessionUpdatesConnected}
          setShowHandoffModal={setShowHandoffModal}
          setShowModelSwitchModal={setShowModelSwitchModal}
          setShowProjectSettingsModal={setShowProjectSettingsModal}
          setShowRecapModal={setShowRecapModal}
          setStatus={setStatus}
          showHandoffModal={showHandoffModal}
          showModelSwitchModal={showModelSwitchModal}
          showProjectSettingsModal={showProjectSettingsModal}
          showRecapModal={showRecapModal}
          status={status}
          supportsProjectSettings={supportsProjectSettings}
          titleTooltip={titleTooltip}
          versionInfo={versionInfo}
        />

        <ExternalSessionWarning active={status.owner === "external"} />

        {hasPendingToolCalls &&
          pendingToolCall &&
          !pendingElsewhereDismissed && (
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
          <main
            className={`${styles.messages} session-messages`}
            tabIndex={-1}
            data-session-read-scope={sessionId}
            {...transcriptComposerFocus}
          >
            <SessionCreationNotice
              creation={session?.creation}
              prompt={session?.initialPrompt}
              onRefresh={refreshSessionMetadata}
              paused={isDomLingerParked}
              transportStatus={sourceTransport.status}
            />
            {error && (
              <div role="status">
                {t("sessionErrorPrefix")} {error.message}
              </div>
            )}
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
                  <SessionRewindProvider value={sessionRewindContextValue}>
                    <SessionViewerProvider
                      sessionId={actualSessionId}
                      inactive={isDomLingerParked}
                      onSendComment={handleSessionViewerCommentSend}
                      onOpenApp={
                        rightPane.enabled
                          ? (url) => {
                              setProjectAppOpen(false);
                              return rightPane.select(url);
                            }
                          : undefined
                      }
                      onAnnounceApp={rightPane.announce}
                      appConfig={rightPane.config}
                      rightPaneTarget={rightPaneTarget}
                      rightPaneWide={isWideScreen}
                    >
                      <LastSessionFile
                        sessionId={actualSessionId}
                        target={viewerLayerTarget}
                        inactive={isDomLingerParked}
                        quoteReply={quoteFromTranscript}
                      />
                      <SessionLivenessProvider value={sessionLiveness}>
                        <MessageList
                          messages={messages}
                          transcriptDisplayObjects={
                            session?.transcriptDisplayObjects
                          }
                          provider={effectiveProvider}
                          isProcessing={
                            sessionActivityUi.showProcessingIndicator
                          }
                          isCompacting={isCompacting}
                          scrollTrigger={scrollTrigger}
                          scrollToTurnRequest={scrollToTurnRequest}
                          pendingMessages={pendingMessages}
                          deferredMessages={deferredMessages}
                          queuedEffortContext={(() => {
                            const model = currentProviderInfo?.models?.find(
                              (candidate) =>
                                candidate.id ===
                                (effectiveModelConfig?.requestedModel ??
                                  liveBadgeModel),
                            );
                            const normal = getImplicitComposerThinking();
                            return model && normal
                              ? { model, normal, provider: effectiveProvider }
                              : undefined;
                          })()}
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
                          onTransferBtwAsideTurn={
                            transferBtwTurnToMotherComposer
                          }
                          onQuoteSelection={insertQuotedSelection}
                          quoteTextBlockRef={quoteTextBlockRef}
                          onStartNewSessionFromSelection={
                            startNewSessionFromSelection
                          }
                          composerDraftSignal={composerDraftSignal}
                          composerEditAvailabilityStore={
                            composerEditAvailabilityStore
                          }
                          quoteClearSignal={quoteClearSignal}
                          onCancelDeferred={handleCancelDeferred}
                          onCancelClearloop={handleCancelClearloop}
                          onEditDeferred={handleEditDeferred}
                          onCancelUnconfirmedUserMessage={
                            handleCancelUnconfirmedUserMessage
                          }
                          onSteerDeferred={handleSteerDeferred}
                          onDeliverDeferredWithoutCompaction={
                            handleDeliverDeferredWithoutCompaction
                          }
                          onResumeRecoveredDeferred={
                            handleResumeRecoveredDeferred
                          }
                          onSteerRecoveredDeferred={
                            handleSteerRecoveredDeferred
                          }
                          onDeleteRecoveredDeferred={
                            handleDeleteRecoveredDeferred
                          }
                          onCancelProjectQueueMessage={
                            handleCancelProjectQueueItem
                          }
                          onEditProjectQueueMessage={handleEditProjectQueueItem}
                          onSteerProjectQueueMessage={
                            handleSteerProjectQueueItem
                          }
                          onResumeProjectQueueDispatch={
                            handleResumeProjectQueueDispatch
                          }
                          onCorrectLatestUserMessage={
                            handleCorrectLatestUserMessage
                          }
                          onTrimBeforeUserMessage={trimClientFromUserMessage}
                          onForkBeforeUserMessage={
                            supportsForkFromTurn
                              ? forkBeforeUserMessage
                              : undefined
                          }
                          onForkAfterUserMessage={
                            supportsForkFromTurn
                              ? forkAfterUserMessage
                              : undefined
                          }
                          onForkAfterSummaryUserMessage={
                            supportsForkFromTurn && !routedSession
                              ? beginForkAfterSummary
                              : undefined
                          }
                          forkAfterUserMessageDisabled={forkAfterDisabled}
                          forkUnavailableMessage={forkUnavailableMessage}
                          onCopyUserMessage={copyUserMessage}
                          onHandoffFromUserMessage={
                            routedSession ? undefined : handoffFromUserMessage
                          }
                          markdownAugments={markdownAugments}
                          activeToolApproval={activeToolApproval}
                          hasOlderMessages={pagination?.hasOlderMessages}
                          totalMessageCount={pagination?.totalMessageCount}
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
                          progressiveRenderEnabled={
                            sessionLoadingProgressEnabled
                          }
                          progressiveRenderStatusVisible={
                            sessionLoadingProgressDetailsVisible
                          }
                          progressiveRenderKey={`${clientSummarySourceKey}:${projectId}:${sessionId}:${location.search}`}
                          progressiveRenderPauseSignal={
                            progressiveRenderPauseSignal
                          }
                          conversationViewStateKey={`${clientSummarySourceKey}:${projectId}:${sessionId}:${location.search}`}
                          initialScrollSnapshot={initialScrollSnapshot}
                          onScrollSnapshotChange={updateRouteScrollSnapshot}
                          onFollowingBottomChange={
                            updateActiveWindowFollowingBottom
                          }
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
                      </SessionLivenessProvider>
                    </SessionViewerProvider>
                  </SessionRewindProvider>
                </AgentContentProvider>
              </SessionMetadataProvider>
            )}
          </main>
          <div
            className={styles.viewerLayer}
            data-session-viewer-layer
            data-session-read-exclude
            ref={setViewerLayerTarget}
          />
          {showBtwSidePane && focusedBtwAside && (
            <BtwAsidePane
              aside={focusedBtwAside}
              draft={asideDraft}
              composerRef={asideComposerRef}
              onDraftChange={setAsideDraft}
              onSendFollowup={(text) => handleFocusedBtwSend(text, "pane")}
              onHide={() => setBtwSidePaneCollapsed(true)}
              onDone={() => handleCustomCommand("done", "")}
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
            {creationRecovery?.key === creationKey && (
              <div role="status" className={styles.creationRecovery}>
                <span>
                  {t(
                    creationRecovery.accepted
                      ? "sessionCreationSavedWhileAway"
                      : "sessionCreationUnconfirmedRequest",
                  )}
                </span>
                <button
                  type="button"
                  onClick={async () => {
                    const view = captureCreationView();
                    const pending = pendingSessionCreation(creationKey);
                    if (!pending) return;
                    const controls = draftControlsRef.current;
                    const filesMatch =
                      !pendingUploadsRef.current.size &&
                      attachmentsRef.current
                        .map((file) => file.id)
                        .join("\0") === (pending.draftFileIds ?? []).join("\0");
                    const draftMatches =
                      filesMatch &&
                      controls?.getDraft() === pending.draftText &&
                      JSON.stringify(
                        controls?.getAttachmentState()?.refs ?? [],
                      ) === (pending.draftAttachments ?? "[]");
                    const captured = draftMatches
                      ? controls?.captureSubmission?.()
                      : undefined;
                    try {
                      const receipt = await getSessionCreation(
                        sourceTransport,
                        creationRecovery.requestId,
                      );
                      if (!ownsCreationView(view)) return;
                      const stillMatches =
                        !pendingUploadsRef.current.size &&
                        attachmentsRef.current
                          .map((file) => file.id)
                          .join("\0") ===
                          (pending.draftFileIds ?? []).join("\0") &&
                        controls?.getDraft() === pending.draftText &&
                        JSON.stringify(
                          controls?.getAttachmentState()?.refs ?? [],
                        ) === (pending.draftAttachments ?? "[]");
                      const cleared =
                        stillMatches && (captured?.confirm() ?? false);
                      if (cleared)
                        setComposerAttachments([], {
                          persistDraft: false,
                          revokeRemovedPreviewUrls: true,
                        });
                      if (cleared || !stillMatches) {
                        settleSessionCreation(creationKey, receipt.requestId);
                        setCreationRecovery(null);
                      }
                      navigate(
                        `${basePath}/projects/${receipt.projectId}/sessions/${receipt.sessionId}`,
                      );
                    } catch (error) {
                      showToast(
                        error instanceof Error ? error.message : String(error),
                        "error",
                      );
                    }
                  }}
                >
                  {t("sessionCreationOpenSaved")}
                </button>
              </div>
            )}
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
                      contextRequestedModel={
                        effectiveModelConfig?.requestedModel
                      }
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
                        mainComposerForAside
                          ? t("btwAsideDoneTitle")
                          : undefined
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

              {questionAside.aside && (
                <QuestionAsideCard
                  {...questionAside.aside}
                  onSave={() => {
                    void questionAside.save();
                  }}
                  onDiscard={questionAside.discard}
                  onSteer={() => {
                    void questionAside.steer();
                  }}
                  onContinueAsBtw={() => {
                    void questionAside.continueAsBtw();
                  }}
                />
              )}

              {/* No pending approval: show full message input */}
              {!(
                pendingInputRequest &&
                pendingInputRequest.sessionId === actualSessionId &&
                !isAskUserQuestion
              ) && (
                <MessageInput
                  onVoiceControl={setProjectAppVoice}
                  questionAside={
                    !mainComposerForAside && !forkSummaryDraft
                      ? {
                          canAsk:
                            questionAsidesEnabled &&
                            supportsBtwAsides &&
                            !questionAside.aside &&
                            (processState === "in-turn" ||
                              processState === "waiting-input"),
                          onAsk: (rawText) =>
                            (processState === "in-turn" ||
                              processState === "waiting-input") &&
                            questionAside.ask(rawText),
                          onSave:
                            questionAside.aside?.status === "complete"
                              ? () => {
                                  void questionAside.save();
                                }
                              : undefined,
                          onDismiss: questionAside.aside
                            ? questionAside.discard
                            : undefined,
                        }
                      : undefined
                  }
                  completionRenderItems={activityRenderItems}
                  speechVocabulary={speechVocabulary}
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
                    !mainComposerForAside && effectiveProvider
                      ? handleProjectQueueNewSession
                      : undefined
                  }
                  projectQueueNewSessionTarget={projectQueueNewSessionTarget}
                  primaryActionKind={
                    mainComposerForAside ? "send" : primaryComposerAction
                  }
                  disabled={isSessionCreationPending(session?.creation)}
                  placeholder={
                    isSessionCreationPending(session?.creation)
                      ? t(
                          session?.creation?.state === "failed" ||
                            session?.creation?.state === "uncertain"
                            ? "sessionCreationBlocked"
                            : session?.creation?.state === "queued"
                              ? "sessionCreationQueueProgress"
                              : "sessionCreationProgress",
                        )
                      : mainComposerForAside
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
                  steerNowDefault={steerNowDefault}
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
                    mainComposerForAside ? undefined : composerBangSupport
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
                  onAttachAudioMemo={
                    mainComposerForAside
                      ? undefined
                      : async (file) => {
                          const uploaded = await uploadAttachedFiles([file]);
                          if (!uploaded[0])
                            throw new Error(t("audioMemoUploadFailed"));
                        }
                  }
                  onRemoveAttachment={
                    mainComposerForAside ? undefined : handleRemoveAttachment
                  }
                  uploadProgress={mainComposerForAside ? [] : uploadProgress}
                  slashCommands={allSlashCommands}
                  onCustomCommand={handleCustomCommand}
                  fileViewCommand={
                    supportsFileViewCommand ? fileViewCommandOptions : undefined
                  }
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
      </FileDropZone>
      <SessionRightPane
        voice={projectAppVoice}
        pane={rightPane}
        wide={isWideScreen}
        fileContentRef={setRightPaneTarget}
        projectAppOpen={projectAppEnabled && projectAppOpen}
        fullView={projectAppEnabled && projectAppOpen && projectAppFull}
        onHideProjectApp={() =>
          projectAppFull ? setProjectAppFull(false) : setProjectAppOpen(false)
        }
        projectApp={
          projectAppEnabled && projectId ? (
            <ProjectAppViewer
              projectId={projectId}
              initialTarget={projectAppTarget}
              voice={projectAppVoice}
              // The session's own App button already offers its artifact.
              offerLatestArtifact={rightPane.apps.length === 0}
              projectName={project?.name}
              onComment={(text) => {
                setProjectAppFull(false);
                insertQuotedSelection(text);
              }}
              // From full view, Back returns to the session with the app
              // still beside it; from the pane, it closes the app.
              onBack={() =>
                projectAppFull
                  ? setProjectAppFull(false)
                  : setProjectAppOpen(false)
              }
              onFullView={
                projectAppFull ? undefined : () => setProjectAppFull(true)
              }
              // No new-session action: this session is already beside the app.
            />
          ) : undefined
        }
      />
    </MainContent>
  );
  return (
    <AsyncQuestionsProvider
      key={`${clientSummarySourceKey}:${sessionId}`}
      storageKey={`yep-async-questions:${clientSummarySourceKey}:${sessionId}`}
      target={
        navState.asyncQuestion
          ? { ...navState.asyncQuestion, token: location.key ?? "keyless" }
          : undefined
      }
      draftSignal={composerDraftSignal}
      send={(text) =>
        handleSendRef.current(
          text,
          {
            composition: {},
            deliveryIntent:
              processState === "in-turn" || processState === "waiting-input"
                ? "steer"
                : "direct",
          },
          { preserveComposer: true, preserveScroll: true },
        )
      }
      quote={insertQuotedSelection}
      focusComposer={() => {
        // Runs after an answer's send settles, so the user may be in the app.
        if (!embeddedFrameHoldsFocus())
          draftControlsRef.current?.focus?.({ preventScroll: true });
      }}
    >
      <RoutedSessionContext value={session?.routerBinding ?? null}>
        <ComposerInsertContext value={insertQuotedSelection}>
          <SessionIssuesProvider
            key={`${clientSummarySourceKey}:${projectId}:${sessionId}`}
            projectId={projectId}
            sessionId={sessionId}
            messageCount={messages.length}
          >
            {content}
          </SessionIssuesProvider>
        </ComposerInsertContext>
      </RoutedSessionContext>
    </AsyncQuestionsProvider>
  );
}
