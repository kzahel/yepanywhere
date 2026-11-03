import { useActingPrincipal } from "../hooks/useActingPrincipal";
import { createLegacySession } from "../lib/legacySessionCreation";
import {
  acceptSessionCreation,
  getSessionCreation,
  pendingSessionCreation,
  settleSessionCreation,
} from "../lib/sessionCreation";
import { isSessionCreationPending } from "@yep-anywhere/shared";
import { SessionCreationNotice } from "../components/SessionCreationNotice";
import { RoutedSessionContext } from "../contexts/RoutedSessionContext";
import {
  DRAFT_STORAGE_EVENT,
  collectSyncedSubmissionAttachments,
} from "../lib/draftSyncStorage";
import {
  SessionIssuesLink,
  SessionIssuesProvider,
} from "../components/SessionIssuesLink";
import { useNonHumanUserTurnNavigation } from "../hooks/useNonHumanUserTurnNavigation";
import { useSessionMessageNavigation } from "../hooks/useSessionMessageNavigation";
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
  classifyQueuedYaCommand,
  type FileViewLineTarget,
  type FileViewSearchResult,
  getCanonicalInvocationToken,
  isClaudeProviderName,
  parseFileViewArgument,
  readInventoryGoalDetails,
  serverHasCapability,
  startsWithSlashCommand,
  thinkingOptionToConfig,
  SERVER_CAPABILITIES,
  isTurnEffort,
  isRewindSlashCommand,
  REWIND_SLASH_COMMANDS,
} from "@yep-anywhere/shared";
import {
  type ComponentProps,
  lazy,
  type MouseEvent as ReactMouseEvent,
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
import {
  isHandoffRequiredRefusal,
  isStaleSessionRedirect,
} from "../api/refusal";
import { getUiCreationProvenance } from "../lib/sessionCreationProvenance";
import { createSessionApi } from "../api/sessionClient";
import type { BangCommandHandlers } from "../components/BangCommandDisplayObject";
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
import {
  applyBangCommandReceipt,
  buildBangEchoText,
  collectBangHistory,
} from "../lib/bangCommands";
import { getBangCommandAnchor } from "../lib/transcriptDisplayObjects";

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
import { rememberComposerUpload } from "../lib/composerHistory";
import { BtwAsideStickyCards } from "../components/BtwAsideStickyCards";
import { ClientLogRecordingBadge } from "../components/ClientLogRecordingBadge";
import { ExternalSessionWarning } from "../components/ExternalSessionWarning";
import { useStartNewSessionWithPrefillAction } from "../components/FileResourceActions";
import { HostIdentityMarker } from "../components/HostIdentityMarker";
import { getForkSummaryAutoOpen } from "../hooks/useForkSummaryAutoOpen";
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
import { ModelSwitchModal } from "../components/ModelSwitchModal";
import { ProcessInfoBody } from "../components/ProcessInfoModal";
import { ProjectSessionDefaultsModal } from "../components/ProjectSessionDefaultsModal";
import { ProviderBadge } from "../components/ProviderBadge";
import { QuestionAnswerPanel } from "../components/QuestionAnswerPanel";
import { RecentSessionsDropdown } from "../components/RecentSessionsDropdown";
import { RestartSessionModal } from "../components/RestartSessionModal";
import { routerBindingChip } from "../components/RouterPoolSelector";
import { SessionMenu } from "../components/SessionMenu";
import {
  SessionPublicShareControls,
  SessionShareMenuLabel,
} from "../components/SessionPublicShareControls";
import { SessionRenameEditor } from "../components/SessionRenameEditor";
import { useSessionHeaderLayout } from "../hooks/useSessionHeaderLayout";
import { useProjectCodeNamePreferences } from "../hooks/useProjectCodeNamePreferences";
import { SessionRecapModal } from "../components/SessionRecapModal";
import { ToolApprovalPanel } from "../components/ToolApprovalPanel";
import type { ModalAnchorRect } from "../components/ui/Modal";
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
import {
  getAttachmentUploadProfile,
  useAttachmentUploadQuality,
} from "../hooks/useAttachmentUploadQuality";
import { useDeveloperMode } from "../hooks/useDeveloperMode";
import { useDocumentTitle } from "../hooks/useDocumentTitle";
import { useComposerBeacon } from "../hooks/useComposerBeacon";
import { useTranscriptComposerFocus } from "../hooks/useTranscriptComposerFocus";
import type { DraftControls } from "../hooks/useDraftPersistence";
import { applyEarlyComposerTyping } from "../lib/earlyComposerTyping";
import {
  type EarlyTypingHandoff,
  startEarlyTypingHandoff,
} from "../lib/earlyTypingHandoff";
import { AsyncQuestionsProvider } from "../contexts/AsyncQuestionsContext";
import { ComposerInsertContext } from "../contexts/ComposerInsertContext";
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
import { recordSessionInteraction } from "../lib/sessionInteractionOrder";
import { useRemoteBasePath } from "../hooks/useRemoteBasePath";
import { useServerSettings } from "../hooks/useServerSettings";
import {
  forkSessionAtEffort,
  useLongContextEffortGuard,
} from "../hooks/useLongContextEffortGuard";
import { LongContextEffortWarningModal } from "../components/LongContextEffortWarningModal";
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
  deleteDraftAttachmentRef,
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
import { requiresAttachmentOnlyServerUpdate } from "../lib/attachmentSubmission";
import { storeUploadedAttachmentPreview } from "../lib/attachmentPreviewCache";
import {
  useActiveProjectSessionIds,
  useClientSummarySourceKey,
  useProviderRuntimeStatusForSession,
  useSessionCollectionRecord,
} from "../lib/clientSummaryStore";
import { activityBus } from "../lib/activityBus";
import {
  sessionReadShortcut,
  setSessionUnread,
} from "../lib/sessionReadActions";
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
  thinkingOptionFromProcess,
  thinkingOptionFromSelection,
} from "../lib/liveThinkingConfig";
import { getPersistentEditApprovalResponse } from "../lib/permissionModes";
import { embeddedFrameHoldsFocus } from "../lib/programmaticFocus";
import {
  sessionResumeOverrides,
  stoppedSessionPermissionMode,
} from "../lib/sessionResumeSettings";
import { buildConversationHandoffPrefill } from "../lib/sessionDetail/conversationHandoff";
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
  ComposerAttachmentUploadError,
  createComposerDraftAttachmentState,
  hasComposerDraftContent,
  insertComposerTransferText,
  materializeComposerAttachmentsForSubmission,
  splitComposerAttachmentsForSubmission,
  stageComposerAttachmentsForNewSession,
  type PreparedComposerSubmission,
  uploadComposerAttachmentFile,
} from "../lib/sessionComposerSubmission";
import { isLegacyCodexSetupText } from "@yep-anywhere/shared/transcript/codexLegacySetup";
import { resolveSessionProviderCapabilities } from "../lib/providerCapabilities";
import { shouldShowProjectQueueAffordance } from "../lib/projectQueueVisibility";
import { createSessionDraftStorageKey } from "../lib/sessionDraftStorage";
import {
  type ComposerTurnRecallCache,
  createComposerTurnRecallCache,
  mergeCommandRecallEntries,
} from "../lib/composerTurnRecall";
import { useSessionCommandRecall } from "../lib/sessionCommandRecall";
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
import { SessionRewindProvider } from "../contexts/SessionRewindContext";
import { supportsSessionRewind } from "../lib/sessionRewind";
import { useSessionRewindControls } from "../hooks/useSessionRewindControls";
import { isBtwAsideSession } from "../lib/btwAsideSessions";
import {
  composeGeneratedRetitle,
  createSessionRetitleSubmittedTurnText,
  type GeneratedRetitleInsertion,
  resolveSessionPageTitle,
} from "../lib/sessionTitleHelpers";
import { resolveFileViewSubmission } from "../lib/fileViewCommand";
import {
  CLIENT_SLASH_COMMANDS,
  createClientSlashCommand,
  FILE_VIEW_COMMAND_NAMES,
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
  return isClaudeProviderName(provider) && isHandoffRequiredRefusal(error);
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
    href: window.location.href,
    historyKey: window.history.state?.key,
    activation: progressiveRenderPauseSignal?.activationVersion,
  });
  const ownsCreationView = (token: ReturnType<typeof captureCreationView>) =>
    creationOwner.current.active &&
    creationOwner.current.key === token.key &&
    !progressiveRenderPauseSignal?.current &&
    progressiveRenderPauseSignal?.activationVersion === token.activation &&
    window.location.href === token.href &&
    window.history.state?.key === token.historyKey;

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
          creationProvenance: getUiCreationProvenance(versionInfo),
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
      versionInfo,
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
          creationProvenance: getUiCreationProvenance(versionInfo),
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
      versionInfo,
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
        creationProvenance: getUiCreationProvenance(versionInfo),
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
    versionInfo,
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
  const handoffFromUserMessage = useCallback(
    (messageId: string, options: { newTab: boolean }) => {
      if (!effectiveProvider || !actualSessionId) return;
      const prefill = buildConversationHandoffPrefill({
        items: activityRenderItems,
        fromUserTurnId: messageId,
        provider: effectiveProvider,
        sessionId: actualSessionId,
        goal: currentGoal,
        projectPath: project?.path,
      });
      if (!prefill) return;
      startNewSessionWithPrefill(projectId, prefill, {
        caret: "start",
        executor: session?.executor,
        model: effectiveModelConfig?.model ?? effectiveModel,
        newTab: options.newTab,
        permissionMode,
        provider: effectiveProvider,
        thinking: getImplicitComposerThinking(),
      });
    },
    [
      activityRenderItems,
      actualSessionId,
      currentGoal,
      effectiveModel,
      effectiveModelConfig?.model,
      effectiveProvider,
      getImplicitComposerThinking,
      permissionMode,
      project?.path,
      projectId,
      session?.executor,
      startNewSessionWithPrefill,
    ],
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

  // Inline title editing state
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [renamePresentation, setRenamePresentation] = useState<
    "inline" | "dialog"
  >("dialog");
  const [titleEditMode, setTitleEditMode] = useState<TitleEditMode>("manual");
  const [renameValue, setRenameValue] = useState("");
  const [isRenaming, setIsRenaming] = useState(false);
  const [generatedRetitle, setGeneratedRetitle] =
    useState<GeneratedRetitleState | null>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const titleInputWantsFocusRef = useRef(false);
  const attachTitleInput = useCallback((input: HTMLInputElement | null) => {
    renameInputRef.current = input;
    if (!input || !titleInputWantsFocusRef.current) return;
    titleInputWantsFocusRef.current = false;
    input.focus();
    input.select();
  }, []);
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
  const [localPromptSuggestionMode, setLocalPromptSuggestionMode] = useState<
    PromptSuggestionMode | undefined
  >(undefined);
  const sessionCollectionRecord = useSessionCollectionRecord(sessionId);

  useEffect(() => {
    generatedRetitleRef.current = generatedRetitle;
  }, [generatedRetitle]);

  // Reset local metadata state when sessionId changes
  useEffect(() => {
    void sessionId;
    setLocalCustomTitle(undefined);
    setLocalIsArchived(undefined);
    setLocalIsStarred(undefined);
    setLocalPromptSuggestionMode(undefined);
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

  // Record session visit for recents tracking. Opening a session is not a
  // sidebar interaction: only composer submissions move a row, so reading a
  // session leaves its chronology alone.
  useEffect(() => {
    if (isDomLingerParked) return;
    recordSessionVisit(sessionId, projectId);
  }, [sessionId, projectId, isDomLingerParked]);

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
    queueIntent = false,
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

    const slashTurn = resolveComposerSlashTurn(text, {
      rewindSupported: supportsRewind,
    });
    if (slashTurn.kind === "custom") {
      if (
        queueIntent &&
        slashTurn.command === "compact" &&
        supportsManualCompact
      ) {
        if (
          !serverHasCapability(
            versionInfo,
            SERVER_CAPABILITIES.queuedSessionCompaction,
          )
        ) {
          draftControlsRef.current?.setDraft(text);
          showToast(t("queuedCompactRequiresUpdate"), "error");
          return null;
        }
        if (attachmentsRef.current.length || pendingUploadsRef.current.size) {
          draftControlsRef.current?.setDraft(text);
          showToast(t("queuedCompactSeparateAttachments"), "error");
          return null;
        }
        return { outgoingText: text, queuedCompact: true };
      }
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
      if (slashTurn.command === "view" && supportsFileViewCommand) {
        endCorrectionForLocalCommand();
        void handleFileViewCommand(slashTurn.argument);
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

    if (slashTurn.turnEffort && !supportsTurnEffort) {
      draftControlsRef.current?.setDraft(text);
      showToast(t("turnEffortUnavailable"), "error");
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
      turnEffort: slashTurn.turnEffort,
    };
  };

  // Approval panel collapsed state (separate from message input collapse)
  const [approvalCollapsed, setApprovalCollapsed] = useState(false);
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

  const handleSend = async (
    text: string,
    metadata?: MessageSubmissionMetadata,
    options: {
      preserveComposer?: boolean;
      preserveScroll?: boolean;
      localControl?: boolean;
    } = {},
  ): Promise<boolean> => {
    const prepared: PreparedComposerSubmission | null =
      options.localControl || options.preserveComposer
        ? { outgoingText: text }
        : prepareComposerSubmission(text);
    if (!prepared) {
      return false;
    }
    if (
      prepared.turnEffort &&
      (processState === "in-turn" || processState === "waiting-input")
    ) {
      return handleQueue(text, metadata);
    }
    if (prepared.turnEffort)
      metadata = {
        composition: {},
        deliveryIntent: "direct",
        ...metadata,
        turnEffort: prepared.turnEffort,
      };
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

    recordSessionInteraction(
      sourceRuntime.sourceKey,
      actualSessionId,
      actionAtMs,
    );

    // Add to pending queue and get tempId to pass to server
    const { tempId } = addPendingMessage(
      outgoingText,
      undefined,
      clientTimestampIso,
    );
    const completeBeaconSubmission = !preserveComposer
      ? beginBeaconSubmission({
          tempId,
          content: outgoingText,
          timestamp: clientTimestampIso,
        })
      : undefined;
    if (!localControl) {
      setProcessState("in-turn"); // Optimistic: show processing indicator immediately
      if (!options.preserveScroll) setScrollTrigger((prev) => prev + 1);
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

    const confirmSubmission = () => {
      completeBeaconSubmission?.("delivered");
      if (!preserveComposer) {
        rememberSentSubmission(text, tempId);
        draftControlsRef.current?.confirmInputClear();
        revokeAttachmentPreviewUrls(currentAttachments);
        setCorrectionDraft(null);
        clearQuoteAnchors();
      }
      return true;
    };

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
        // Saved settings stay server-owned; only deliberate edits override them.
        // Use effectiveProvider to ensure correct provider even if session data hasn't loaded
        // effectiveProvider = session?.provider ?? initialProvider (from navigation state)
        const result = await api.resumeSession(
          projectId,
          sessionId,
          outgoingText,
          {
            ...getResumeSettings(prepared.thinking),
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
      return confirmSubmission();
    } catch (err) {
      // An aborted HTTP response does not undo delivery already observed on
      // the session stream or in durable history. Never restore or retry it.
      if (
        isMessageDelivered({
          tempId,
          content: outgoingText,
          timestamp: clientTimestampIso,
        })
      ) {
        return confirmSubmission();
      }
      console.error("Failed to send:", err);
      let finalError: unknown = err;
      if (err instanceof ComposerAttachmentUploadError)
        currentAttachments = err.attachments;
      logSessionUiTrace("composer-send-error", {
        sessionId,
        tempId,
        message: err instanceof Error ? err.message : String(err),
      });

      // The session went cold under the limited-user freshness cutoff: the
      // server refused the turn and says it belongs in a new session seeded
      // with a handoff of this one (topics/limited-users.md § Freshness).
      if (isStaleSessionRedirect(err)) {
        try {
          const started = await api.staleHandoffSession(
            projectId,
            sessionId,
            outgoingText,
            {
              mode: permissionMode,
              tempId,
              clientTimestamp,
              messageMetadata: metadata,
            },
            uploadedAttachments.length > 0 ? uploadedAttachments : undefined,
          );
          removePendingMessage(tempId);
          if (!localControl) setProcessState("idle");
          confirmSubmission();
          if (!started.sessionId) {
            // Accepted but waiting for a free worker; it appears in the
            // session list when it starts.
            showToast(t("sessionStaleHandoffQueued"), "success");
            return true;
          }
          showToast(t("sessionStaleHandoffStarted"), "success");
          navigate(
            `${basePath}/projects/${started.projectId}/sessions/${started.sessionId}`,
            {
              state: createSessionNavigationState({
                initialStatus: {
                  owner: "self",
                  processId: started.processId,
                  permissionMode: started.permissionMode,
                  appliedPermissionMode: started.appliedPermissionMode,
                  modeVersion: started.modeVersion,
                  recapAfterSeconds: started.recapAfterSeconds,
                },
                initialTitle: started.title,
                initialModel: started.model,
                initialProvider: started.provider ?? effectiveProvider,
              }),
            },
          );
          return true;
        } catch (redirectErr) {
          // Reported by the toast below, like any other send failure.
          finalError = redirectErr;
        }
      }

      // Check if process is dead (404) - auto-retry with resumeSession
      const is404 =
        err instanceof Error &&
        (err.message.includes("404") ||
          err.message.includes("No active process"));
      if (is404) {
        try {
          const retryRequestSentAtMs = Date.now();
          const result = await api.resumeSession(
            projectId,
            sessionId,
            outgoingText,
            {
              ...getResumeSettings(prepared.thinking),
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
          return confirmSubmission();
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
      completeBeaconSubmission?.("error");
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
        // A routed session cannot hand off yet, so offer no handoff modal.
        if (!routedSession) setShowHandoffModal(true);
        showToast(
          routedSession
            ? t("routedSessionHandoffRequired")
            : errorMsg.includes("API error: 409")
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
      const placementAfterMessageId = getBangCommandAnchor(messagesRef.current);
      try {
        const result = await api.runBangCommand(
          projectId,
          sessionId,
          command,
          placementAfterMessageId,
        );
        updateTranscriptDisplayObjectsForSession(sessionId, (current) =>
          applyBangCommandReceipt(current, result.displayObject),
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

  const initialDisplayObjectsRef = useRef<{
    sessionId: string;
    ids: Set<string>;
  } | null>(null);
  if (
    session?.id === sessionId &&
    initialDisplayObjectsRef.current?.sessionId !== sessionId
  ) {
    initialDisplayObjectsRef.current = {
      sessionId,
      ids: new Set(
        session.transcriptDisplayObjects?.map((object) => object.id),
      ),
    };
  }
  const bangCommandHandlers = useMemo<BangCommandHandlers>(
    () => ({
      shouldExpandOutput: (objectId) =>
        !initialDisplayObjectsRef.current?.ids.has(objectId),
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
  // Accepted YA commands never become turns; they are recalled ahead of them.
  const { entries: commandRecallEntries, record: recordCommandRecall } =
    useSessionCommandRecall(actualSessionId);
  const composerTurnRecallEntries = useMemo(
    () =>
      mergeCommandRecallEntries(
        commandRecallEntries,
        composerTurnRecallCache.derive(messages),
      ),
    [commandRecallEntries, composerTurnRecallCache, messages],
  );
  // Go-to-turn: the recall drawer row asks to scroll the transcript to a prior
  // user turn by its render id. Mirror the isearch jump path (which reaches
  // MessageList.scrollToRenderId) by handing MessageList a bumped request; it
  // resolves the id via findRenderRow. Token makes repeat jumps to the same id
  // distinct so the effect re-fires. See topics/composer-recall-drawer.md.
  const [scrollToTurnRequest, setScrollToTurnRequest] = useState<{
    id: string;
    token: number;
    onResolved?: (found: boolean) => void;
  } | null>(null);
  const handleGoToRecallTurn = useCallback(
    (id: string, onResolved?: (found: boolean) => void) => {
      if (!id) {
        return;
      }
      setScrollToTurnRequest((previous) => ({
        id,
        token: (previous?.token ?? 0) + 1,
        onResolved,
      }));
    },
    [],
  );
  useSessionMessageNavigation({
    sessionId,
    target: new URLSearchParams(location.search).get("searchMatch"),
    enabled: true,
    messages,
    loading: loading || isDomLingerParked,
    loadingOlder,
    hasOlder: pagination?.hasOlderMessages ?? false,
    olderCursor: pagination?.truncatedBeforeMessageId,
    loadOlder: loadOlderMessages,
    jump: handleGoToRecallTurn,
    onError: () => showToast(t("sessionSearchTurnUnavailable"), "error"),
  });
  useNonHumanUserTurnNavigation({
    sessionId,
    messages,
    loading: loading || isDomLingerParked,
    loadingOlder,
    hasOlder: pagination?.hasOlderMessages ?? false,
    olderCursor: pagination?.truncatedBeforeMessageId,
    loadOlder: loadOlderMessages,
    jump: handleGoToRecallTurn,
    onError: (kind) =>
      showToast(
        t(
          kind === "unavailable"
            ? "nonHumanUserTurnUnavailable"
            : "nonHumanUserTurnAcknowledgeFailed",
        ),
        "error",
      ),
  });
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
  // A navigation that asks for the composer means the user may type at once,
  // but the composer only appears when the session has loaded. Start holding
  // keys here — before and regardless of loading — so they land in the draft
  // in the order they were struck rather than in the transcript's shortcuts.
  useEffect(() => {
    if (!navComposerPrefill && !navFocusComposer) return;
    const navigationKey = location.key ?? "keyless";
    if (earlyComposerTypingKeyRef.current === navigationKey) return;
    earlyComposerTypingKeyRef.current = navigationKey;
    earlyComposerTypingRef.current?.cancel();
    earlyComposerTypingRef.current = startEarlyTypingHandoff();
  }, [location.key, navComposerPrefill, navFocusComposer]);
  useEffect(
    () => () => {
      earlyComposerTypingRef.current?.cancel();
      earlyComposerTypingRef.current = null;
    },
    [],
  );
  useEffect(() => {
    const navigationKey = location.key ?? "keyless";
    if (navActionsConsumedKeyRef.current === navigationKey || loading) {
      return;
    }
    if (!navComposerPrefill && !navFocusComposer && !navScrollToRenderId) {
      return;
    }
    navActionsConsumedKeyRef.current = navigationKey;

    if (navComposerPrefill || navFocusComposer) {
      pendingEarlyComposerPrefillRef.current = navComposerPrefill ?? null;
      flushEarlyComposerTyping();
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
    flushEarlyComposerTyping,
  ]);

  const handleQueue = async (
    text: string,
    metadata?: MessageSubmissionMetadata,
  ): Promise<boolean> => {
    const prepared = prepareComposerSubmission(text, true);
    if (!prepared) {
      return false;
    }
    if (prepared.turnEffort)
      metadata = {
        composition: {},
        ...metadata,
        deliveryIntent: "deferred",
        turnEffort: prepared.turnEffort,
        steerNow: undefined,
      };
    const { outgoingText, slashCommand } = prepared;
    if (
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

    recordSessionInteraction(
      sourceRuntime.sourceKey,
      actualSessionId,
      actionAtMs,
    );

    // The queue path is not optimistic: no "Sending..." pending chip. The
    // composer disables for the round-trip and the queued chip renders from the
    // server's deferred-queue state (SSE event + this POST response). We still
    // mint a tempId so the server can echo this message back by identity.
    const tempId = `temp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const completeBeaconSubmission = beginBeaconSubmission({
      tempId,
      content: outgoingText,
      timestamp: new Date(clientTimestamp).toISOString(),
    });
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
      completeBeaconSubmission(
        result.deferred === false || result.promoted ? "delivered" : "queued",
      );
      return true;
    } catch (err) {
      console.error("Failed to queue deferred message:", err);
      let finalError: unknown = err;
      if (err instanceof ComposerAttachmentUploadError)
        currentAttachments = err.attachments;
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
      if (isProcessUnavailable && !prepared.queuedCompact) {
        try {
          const result = await api.resumeSession(
            projectId,
            sessionId,
            outgoingText,
            {
              ...getResumeSettings(prepared.thinking),
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
          completeBeaconSubmission("delivered");
          return true;
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
      completeBeaconSubmission("error");
      const errorMsg =
        finalError instanceof Error ? finalError.message : String(finalError);
      if (
        requiresHandoffAfterClaudeResumeError(finalError, effectiveProvider)
      ) {
        // A routed session cannot hand off yet, so offer no handoff modal.
        if (!routedSession) setShowHandoffModal(true);
        showToast(
          routedSession
            ? t("routedSessionHandoffRequired")
            : errorMsg.includes("API error: 409")
              ? CLAUDE_HANDOFF_REQUIRED_MESSAGE
              : errorMsg,
          "error",
        );
      } else {
        showToast(t("sessionQueueFailed", { message: errorMsg }), "error");
      }
      return false;
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

  const queueComposerForProject = async (
    text: string,
    targetType: "existing-session" | "new-session",
    metadata?: MessageSubmissionMetadata,
    newSessionTarget?: ChosenNewSessionQueueTarget,
  ) => {
    // Project Queue is a delayed lane, so a YA-emulated command must be
    // carried to the scheduler rather than run now the way the composer's
    // direct paths run it (topics/project-queue.md § Queued YA commands).
    const classified = classifyQueuedYaCommand(text, {
      rewindSupported: supportsRewind,
      fileViewSupported: supportsFileViewCommand,
    });
    const refuseCommand = (message: string) => {
      draftControlsRef.current?.setDraft(text);
      showToast(message, "error");
    };
    if (classified.kind === "composer-only") {
      refuseCommand(
        t("projectQueueComposerOnlyCommand", { command: classified.name }),
      );
      return;
    }
    if (classified.kind === "unsupported") {
      refuseCommand(
        t("projectQueueUnsupportedCommand", { command: classified.name }),
      );
      return;
    }
    if (classified.kind === "invalid") {
      refuseCommand(
        classified.problem === "clear-zero"
          ? t("projectQueueClearZero")
          : t("projectQueueCommandSyntax", {
              command: classified.command.name,
            }),
      );
      return;
    }
    const yaCommand =
      classified.kind === "queueable" ? classified.command : undefined;
    if (yaCommand) {
      if (targetType === "new-session") {
        refuseCommand(
          t("projectQueueCommandNeedsSession", { command: yaCommand.name }),
        );
        return;
      }
      if (
        attachmentsRef.current.length > 0 ||
        pendingUploadsRef.current.size > 0
      ) {
        refuseCommand(
          t("projectQueueCommandNoAttachments", { command: yaCommand.name }),
        );
        return;
      }
    }
    const prepared: PreparedComposerSubmission | null =
      classified.kind === "queueable"
        ? { outgoingText: classified.commandText }
        : prepareComposerSubmission(text);
    if (!prepared) {
      return;
    }
    if (prepared.turnEffort)
      metadata = {
        composition: {},
        deliveryIntent: "deferred",
        ...metadata,
        turnEffort: prepared.turnEffort,
        steerNow: undefined,
      };
    const { outgoingText, slashCommand } = prepared;
    const thinking = prepared.thinking ?? getImplicitComposerThinking();
    const showThinking = getShowThinkingSetting();
    const actionAtMs = Date.now();
    const clientTimestamp = getServerClockTimestamp(actionAtMs);

    // A new session chosen from the options may go to another project or
    // provider. This session's settings still apply where they can: its
    // executor and implicit effort only to the same provider, since another
    // provider's catalog may not accept them.
    const queueProjectId =
      targetType === "new-session"
        ? (newSessionTarget?.projectId ?? projectId)
        : projectId;
    const newSessionProvider = newSessionTarget?.provider ?? effectiveProvider;
    const keepsProvider = newSessionProvider === effectiveProvider;
    const newSessionModel =
      newSessionTarget?.model ??
      (keepsProvider ? (session?.model ?? getModelSetting()) : undefined);

    const canonicalCreation =
      targetType === "new-session" &&
      newSessionTarget?.delivery === "now" &&
      serverHasCapability(
        versionInfo,
        SERVER_CAPABILITIES.sessionCreationAdmission.name,
      );
    if (canonicalCreation && !creationPrincipalResolved) {
      draftControlsRef.current?.restoreFromStorage();
      return;
    }
    const creationView = captureCreationView();
    let acceptedInput = canonicalCreation
      ? draftControlsRef.current?.captureSubmission?.()
      : undefined;
    const originalAttachments = [...attachmentsRef.current];
    let currentAttachments = [...originalAttachments];
    let submittedFileIds = originalAttachments.map((file) => file.id);
    let submittedAttachmentState = JSON.stringify(
      draftControlsRef.current?.getAttachmentState()?.refs ?? [],
    );
    let uploadedAttachments: UploadedFile[] = [];
    let stagedAttachments: ProjectQueueStagedAttachments | undefined;

    try {
      currentAttachments = await collectComposerAttachmentsForSubmission({
        detach: !canonicalCreation,
      });
      if (canonicalCreation && !ownsCreationView(creationView)) return;
      if (targetType === "new-session") {
        const selected = currentAttachments;
        currentAttachments = await stageComposerAttachmentsForNewSession({
          attachments: currentAttachments,
          sourceTransport,
          sourceProjectId: projectId,
        });
        if (canonicalCreation) {
          if (!ownsCreationView(creationView)) return;
          const replacements = new Map(
            selected.map((file, index) => [
              file.id,
              currentAttachments[index]!,
            ]),
          );
          setComposerAttachments((current) =>
            current.map((file) => replacements.get(file.id) ?? file),
          );
          submittedFileIds = currentAttachments.map((file) => file.id);
          submittedAttachmentState = JSON.stringify(
            draftControlsRef.current?.getAttachmentState()?.refs ?? [],
          );
          if (
            !pendingUploadsRef.current.size &&
            draftControlsRef.current?.getDraft() === acceptedInput?.text &&
            attachmentsRef.current.map((file) => file.id).join("\0") ===
              submittedFileIds.join("\0")
          )
            acceptedInput = draftControlsRef.current?.captureSubmission?.();
        }
      }
      if (
        targetType === "new-session" &&
        newSessionTarget?.delivery === "now"
      ) {
        const options = {
          mode: permissionMode,
          model: newSessionModel,
          thinking: keepsProvider ? thinking : prepared.thinking,
          showThinking,
          provider: newSessionProvider,
          executor: keepsProvider ? session?.executor : undefined,
        };
        const messageMetadata = {
          ...metadata,
          deliveryIntent: "direct" as const,
        };
        if (canonicalCreation && !ownsCreationView(creationView)) return;
        const started = canonicalCreation
          ? await acceptSessionCreation(
              sourceTransport,
              creationKey,
              queueProjectId,
              outgoingText,
              options,
              clientTimestamp,
              { ...messageMetadata, deliveryIntent: "direct" },
              acceptedInput?.draftText ?? text,
              currentAttachments.length
                ? currentAttachments.map((file) => {
                    if (!isComposerStagedAttachment(file))
                      throw new Error(
                        "New session files must be staged before admission",
                      );
                    return toPersistedStagedAttachmentRef(file);
                  })
                : undefined,
              submittedAttachmentState,
              submittedFileIds,
            )
          : await createLegacySession({
              version: versionInfo,
              api,
              projectId: queueProjectId,
              message: outgoingText,
              options,
              clientTimestamp,
              metadata: { ...messageMetadata, deliveryIntent: "direct" },
              materialize: currentAttachments.length
                ? (projectId, sessionId) =>
                    materializeComposerAttachmentsForSubmission({
                      attachments: currentAttachments,
                      sourceTransport,
                      projectId,
                      sessionId,
                    })
                : undefined,
            });
        if (canonicalCreation) {
          if (!ownsCreationView(creationView)) return;
          const unchangedAttachments =
            !pendingUploadsRef.current.size &&
            attachmentsRef.current.map((file) => file.id).join("\0") ===
              submittedFileIds.join("\0");
          const cleared =
            unchangedAttachments && (acceptedInput?.confirm() ?? false);
          if ("requestId" in started) {
            if (cleared) {
              settleSessionCreation(creationKey, started.requestId);
              setComposerAttachments([], { persistDraft: false });
            }
            if (!cleared) {
              setCreationRecovery({
                key: creationKey,
                requestId: started.requestId,
                accepted: true,
              });
              return;
            }
          }
        } else draftControlsRef.current?.confirmInputClear();
        revokeAttachmentPreviewUrls(currentAttachments);
        setCorrectionDraft(null);
        clearQuoteAnchors();
        navigate(
          `${basePath}/projects/${started.projectId}/sessions/${started.sessionId}`,
          {
            state: createSessionNavigationState({
              initialStatus:
                "processId" in started
                  ? {
                      owner: "self",
                      processId: started.processId,
                      permissionMode: started.permissionMode,
                      appliedPermissionMode: started.appliedPermissionMode,
                      modeVersion: started.modeVersion,
                    }
                  : undefined,
              initialTitle: outgoingText,
              initialModel: newSessionModel,
              initialProvider: newSessionProvider,
            }),
          },
        );
        return;
      }
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
        projectId: queueProjectId,
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
      const response = await api.createProjectQueueItem(queueProjectId, {
        target:
          targetType === "new-session"
            ? {
                type: "new-session",
                mode: permissionMode,
                model: newSessionModel,
                thinking: keepsProvider ? thinking : prepared.thinking,
                showThinking,
                provider: newSessionProvider,
                executor: keepsProvider ? session?.executor : undefined,
                title: outgoingText,
              }
            : {
                type: "existing-session",
                sessionId,
                ...getResumeSettings(prepared.thinking),
                showThinking,
                provider: effectiveProvider,
                executor: session?.executor,
              },
        message: {
          text: outgoingText,
          mode:
            targetType === "new-session"
              ? permissionMode
              : getResumeSettings(prepared.thinking).mode,
          ...(yaCommand ? { yaCommand } : {}),
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
        projectId: queueProjectId,
        targetType,
        uploadWaitMs: requestSentAtMs - actionAtMs,
      });
      draftControlsRef.current?.confirmInputClear();
      revokeAttachmentPreviewUrls(currentAttachments);
      setCorrectionDraft(null);
      clearQuoteAnchors();
      showToast(
        targetType === "new-session" && queueProjectId !== projectId
          ? t("projectQueueNewSessionQueuedInProjectToast", {
              project: newSessionTarget?.projectName ?? queueProjectId,
            })
          : t(
              targetType === "new-session"
                ? "projectQueueNewSessionQueuedToast"
                : "projectQueueSessionQueuedToast",
            ),
        "success",
      );
    } catch (err) {
      console.error("Failed to queue Project Queue message:", err);
      if (err instanceof ComposerAttachmentUploadError)
        currentAttachments = err.attachments;
      logSessionUiTrace("composer-project-queue-error", {
        sessionId,
        projectId,
        targetType,
        message: err instanceof Error ? err.message : String(err),
      });
      if (canonicalCreation) {
        if (!ownsCreationView(creationView)) return;
        const pending = pendingSessionCreation(creationKey);
        if (pending)
          setCreationRecovery({
            key: creationKey,
            requestId: pending.requestId,
          });
        if (!draftControlsRef.current?.getDraft())
          draftControlsRef.current?.restoreFromStorage();
      } else {
        draftControlsRef.current?.restoreFromStorage();
        setComposerAttachments(currentAttachments, { persistDraft: false });
      }
      const errorMsg = err instanceof Error ? err.message : String(err);
      showToast(
        newSessionTarget?.delivery === "now"
          ? `${t("newSessionStartError")}: ${errorMsg}`
          : t("projectQueueSubmitFailed", { message: errorMsg }),
        "error",
      );
    }
  };

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
      // Restoring follows an awaited cancel, so the user may be in the app.
      requestAnimationFrame(() => {
        if (!embeddedFrameHoldsFocus()) controls.focus?.();
      });
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
        restoreQueuedMessageToComposer(
          message.metadata?.turnEffort
            ? `/${message.metadata.turnEffort} ${message.content}`
            : message.content,
          message.attachments,
        );
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

  const handleDeliverDeferredWithoutCompaction = useCallback(
    async (tempId: string) => {
      try {
        const result = await api.deliverDeferredWithoutCompaction(
          sessionId,
          tempId,
        );
        setDeferredMessages(result.deferredMessages ?? []);
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        showToast(
          t("sessionQueuedSendWithoutCompactingFailed", { message: errorMsg }),
          "error",
        );
      }
    },
    [sessionId, setDeferredMessages, showToast, t],
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

  // Handle file attachment uploads
  // Each file uploads independently (parallel) and its promise is tracked
  // so handleSend can wait for in-flight uploads before sending
  const uploadAttachedFiles = useCallback(
    (files: File[]) => {
      const uploads: Promise<ComposerAttachment | null>[] = [];
      const draftBatchId = ensureDraftAttachmentBatchId();
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
          imageProfile: getAttachmentUploadProfile(
            attachmentQuality,
            currentProviderInfo,
            effectiveModelConfig?.model ?? effectiveModel,
          ),
          stagedBatchId: draftBatchId ? draftBatchId : null,
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
              if (historyScope)
                void rememberComposerUpload(historyScope, file, {
                  projectId,
                  projectName: project?.name,
                  sessionId,
                  sessionTitle: session?.title ?? undefined,
                }).catch((cause) =>
                  showToast(
                    t("composerHistorySaveError", { error: String(cause) }),
                    "error",
                  ),
                );
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
        uploads.push(uploadPromise);
      }
      return Promise.all(uploads);
    },
    [
      attachmentQuality,
      currentProviderInfo,
      effectiveModelConfig?.model,
      effectiveModel,
      sourceTransport,
      ensureDraftAttachmentBatchId,
      projectId,
      sessionId,
      setComposerAttachments,
      showToast,
      historyScope,
      project?.name,
      session?.title,
      t,
    ],
  );

  const handleAttach = useCallback(
    async (files: File[]) => {
      await uploadAttachedFiles(files);
    },
    [uploadAttachedFiles],
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

  const setRetitleState = (state: GeneratedRetitleState | null) => {
    generatedRetitleRef.current = state;
    setGeneratedRetitle(state);
  };

  const invalidateGeneratedRetitle = () => {
    retitleRequestIdRef.current += 1;
    setRetitleState(null);
  };

  // Asking to edit the title means the user is about to type, so focus lands
  // in the commit that creates the input (attachTitleInput) instead of a
  // timer hop later, during which keys reach the page's own shortcuts. When
  // the input is already mounted this focuses it directly.
  const focusAndSelectTitleInput = () => {
    const input = renameInputRef.current;
    if (!input) {
      titleInputWantsFocusRef.current = true;
      return;
    }
    input.focus();
    input.select();
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
    // Decide once: a keyboard resize or rotation must not remount the editor.
    setRenamePresentation(
      !condensedHeader &&
        (titleRowRef.current?.getBoundingClientRect().width ?? 0) >= 420
        ? "inline"
        : "dialog",
    );
    setIsEditingTitle(true);
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
    if (!supportsTitleGeneration) {
      setRetitleState({
        requestId,
        status: "error",
        submittedTurnText,
        error: routedSession
          ? t("routedSessionTitleUnavailable")
          : t("sessionRetitleUnsupported"),
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
    if (supportsTitleGeneration) {
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
    if (isDomLingerParked) handleCancelEditingTitleRef.current();
  }, [isDomLingerParked]);

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

  const hasUnread =
    sessionCollectionRecord?.hasUnread ?? session?.hasUnread ?? false;

  const handleSetUnread = useCallback(
    async (newHasUnread: boolean) => {
      try {
        await setSessionUnread(sessionId, newHasUnread);
        showToast(
          newHasUnread ? t("sessionMarkedUnread") : t("sessionMarkedRead"),
          "success",
        );
      } catch (err) {
        console.error("Failed to update read status:", err);
        showToast(t("sessionReadFailed"), "error");
      }
    },
    [sessionId, showToast, t],
  );
  const handleToggleRead = () => handleSetUnread(!hasUnread);

  useEffect(() => {
    if (isDomLingerParked || loading) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const unread = sessionReadShortcut(event);
      if (unread === null) return;
      const target = event.target as Element;
      if (
        target !== document.body &&
        target
          .closest("[data-session-read-scope]")
          ?.getAttribute("data-session-read-scope") !== sessionId
      )
        return;
      event.preventDefault();
      void handleSetUnread(unread);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isDomLingerParked, loading, sessionId, handleSetUnread]);

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
      <div className={styles.sessionColumn}>
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

        {showProjectSettingsModal && supportsProjectSettings && (
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

        {longContextEffortWarning && (
          <LongContextEffortWarningModal
            contextTokens={longContextEffortWarning.contextTokens}
            currentEffortLabel={longContextEffortWarning.currentEffortLabel}
            nextEffortLabel={longContextEffortWarning.nextEffortLabel}
            canFork={longContextEffortWarning.canFork}
            busy={longContextEffortWarning.busy}
            onChoose={(choice) => void chooseLongContextEffortWarning(choice)}
          />
        )}

        {/* Model Switch Modal */}
        {showModelSwitchModal && (
          <ModelSwitchModal
            routed={routedSession}
            processId={status.owner === "self" ? status.processId : undefined}
            sessionId={actualSessionId}
            currentModel={session?.model}
            sessionProvider={effectiveProvider}
            onModelChanged={handleModelChanged}
            guardEffortChange={guardEffortChange}
            initialTab={modelPanelInitialTab}
            infoPane={
              session ? (
                <ProcessInfoBody
                  sessionId={actualSessionId}
                  sessionTitle={titleTooltip}
                  provider={session.provider}
                  model={session.model}
                  savedServiceTier={savedLaunchSettings?.serviceTier}
                  serviceTiers={providerServiceTiers}
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
                  routerBinding={session.routerBinding}
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

        {showHandoffModal && effectiveProvider && !routedSession && (
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
              onRefresh={refreshTranscriptTail}
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
                    !mainComposerForAside
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
                      ? t("sessionCreationBlocked")
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
      </div>
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
      <RoutedSessionContext value={Boolean(session?.routerBinding)}>
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
