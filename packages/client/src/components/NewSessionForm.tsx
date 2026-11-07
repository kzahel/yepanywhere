import { FileDropZone } from "./FileDropZone";
import {
  createLegacySession,
  supportsSessionCreation,
} from "../lib/legacySessionCreation";
import {
  acceptSessionCreation,
  getSessionCreation,
  settleSessionCreation,
  pendingSessionCreation,
} from "../lib/sessionCreation";
import { DraftSyncNotice } from "./DraftSyncNotice";
import { DRAFT_STORAGE_EVENT, draftStorage } from "../lib/draftSyncStorage";
import { useRendezCompose } from "../hooks/useRendezCompose";
import { useComposerSpeechHandlers } from "../hooks/useComposerSpeechHandlers";
import { useComposerSpeechState } from "../hooks/useComposerSpeechState";
import { useComposerVoiceRef } from "../hooks/useComposerVoiceRef";
import type { ProjectAppTarget } from "../api/projectApp";
import {
  ProjectStartPalette,
  TemplateProjectForm,
  templateChoiceKey,
} from "./TemplateProjectForm";
import type { TemplateCreationRequest } from "../api/projectTemplatesClient";
import { ComposerRecents } from "./ComposerRecents";
import { AudioMemoPanel } from "./AudioMemoPanel";
import { PromptHistoryRail } from "./PromptHistoryRail";
import {
  rememberComposerPrompt,
  rememberComposerUpload,
} from "../lib/composerHistory";
import templateStyles from "./TemplateProjectForm.module.css";
import { useProjectTemplateChoices } from "../hooks/useProjectTemplateChoices";
import {
  fromUrlProjectId,
  isUrlProjectId,
  SERVER_CAPABILITIES,
  serverHasCapability,
  DEFAULT_PROJECT_QUEUE_CTRL_ENTER_ENABLED,
  type ProviderName,
  type ThinkingOption,
} from "@yep-anywhere/shared";
import {
  type ChangeEvent,
  type ClipboardEvent,
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useNavigate } from "react-router-dom";
import { type SessionOptions, type UploadedFile, api } from "../api/client";
import styles from "./NewSessionForm.module.css";
import { useCurrentSourceRuntime } from "../contexts/SourceRuntimeContext";
import { useToastContext } from "../contexts/ToastContext";
import { useBrowserXaiSttApiKey } from "../hooks/useBrowserXaiSttApiKey";
import { useDraftPersistence } from "../hooks/useDraftPersistence";
import { useBackgroundSessionCreation } from "../hooks/useBackgroundSessionCreation";
import { useProjectFileCompletion } from "../hooks/useProjectFileCompletion";
import { ProjectFileCompletionMenu } from "./ProjectFileCompletionMenu";
import { createNewSessionDraftKey } from "../hooks/useDrafts";
import {
  getShowThinkingSetting,
  useModelSettings,
} from "../hooks/useModelSettings";
import { useProjectQueues } from "../hooks/useProjectQueues";
import { useNewSessionOptions } from "../hooks/useNewSessionOptions";
import {
  buildNewSessionStartOptions,
  buildProjectQueueNewSessionTarget,
  newSessionStartErrorMessage,
  planNewSessionProjectQueue,
  planNewSessionStart,
  projectQueueRefusalBeforeDefer,
} from "../lib/newSessionStartDecisions";
import { NewSessionOptionsPanel } from "./NewSessionOptionsPanel";
import {
  getAttachmentUploadProfile,
  useAttachmentUploadQuality,
} from "../hooks/useAttachmentUploadQuality";
import { useRemoteBasePath } from "../hooks/useRemoteBasePath";
import { useSpeechSourceRuntime } from "../hooks/useSpeechSourceRuntime";
import { useSessionToolbarPresence } from "../hooks/useSessionToolbarPresence";
import { useI18n } from "../i18n";
import { formatFileSize } from "../lib/formatFileSize";
import { getUiCreationProvenance } from "../lib/sessionCreationProvenance";
import { takePrebootComposer } from "../lib/prebootComposer";
import { UI_KEYS } from "../lib/storageKeys";
import { launchLockFor, type LaunchLock } from "../lib/limitedLaunchLock";
import {
  type PendingFile,
  type PendingLocalFile,
  type PendingStagedFile,
  type PendingUploadingFile,
  getPendingFileImageDimensions,
  getPendingFileMimeType,
  getPendingFileName,
  getPendingFileSize,
  isPendingLocalFile,
  isPendingStagedFile,
  revokePendingFilePreviewUrls,
  toPersistedStagedAttachmentRef,
} from "../lib/newSessionAttachments";
import {
  resolvePromptSuggestionMode,
  resolveRecapMode,
  toThinkingOption,
} from "../lib/newSessionOptions";
import {
  PROJECT_SUGGESTION_COUNT,
  QUICK_PROJECT_COUNT,
  findProjectByInput,
  normalizeProjectInput,
  sortProjectsForChooser,
} from "../lib/newSessionProjects";
import {
  isAnchoredPath,
  newProjectBaseFor,
  projectNameForEntry,
  settlePathEntry,
} from "../lib/newProjectPath";
import { prepareComposerAttachmentUpload } from "../lib/composerAttachmentUpload";
import { storeUploadedAttachmentPreview } from "../lib/attachmentPreviewCache";
import type { DraftAttachmentState } from "../lib/draftEnvelope";
import {
  deleteDraftAttachmentRef,
  isInterruptedDraftAttachmentValidation,
  materializeDraftAttachmentsForSession,
  validateDraftAttachmentRefs,
} from "../lib/draftAttachmentStaging";
import {
  hasAttachmentNavigationRisk,
  useAttachmentNavigationGuard,
} from "../lib/attachmentNavigationGuard";
import { shouldShowProjectQueueAffordance } from "../lib/projectQueueVisibility";
import {
  useActiveProjectSessionIds,
  useClientSummarySourceKey,
} from "../lib/clientSummaryStore";
import {
  getClipboardFiles,
  handleSpeechEscapeKey,
  isComposerEnterSend,
} from "../lib/composerKeys";
import { hasComposerDraftContent } from "../lib/sessionComposerSubmission";
import { logSessionUiTrace } from "../lib/diagnostics/uiTrace";
import {
  isFullPaneComposerShortcut,
  resizeComposerTextarea,
} from "../lib/composerTextarea";
import {
  consumeNewSessionPrefill,
  consumeNewSessionPrefillToken,
} from "../lib/newSessionPrefill";
import { makeAttachmentFileNamesUnique } from "../lib/attachmentFileNames";
import {
  getEstimatedServerOffsetMs,
  getServerClockTimestamp,
} from "../lib/serverClock";
import { createSessionNavigationState } from "../lib/sessionNavigationState";
import {
  canSpeechMethodStream,
  getSpeechMethodCapabilities,
  getSpeechMethods,
  isBrowserNativeSpeechAvailable,
  isSpeechMethodId,
  resolveSpeechMethod,
  type SpeechMethodId,
} from "../lib/speechProviders/methods";
import type {
  SpeechSmartTurnSettings,
  SpeechTranscriptionContext,
} from "../lib/speechProviders/SpeechProvider";
import {
  getSpeechInterimPreview,
  getSpeechVisibleDraftText,
  textBeforeSpeechCursor,
} from "../lib/speechRecognition";
import { resolveDeliverySpeechPrefix } from "../lib/speechMessagePrefix";
import { handleVoiceInputShortcutKeyDown } from "../lib/voiceInputShortcut";
import { createClientSpeechTurnId } from "../lib/speechTargets";
import { generateUUID } from "../lib/uuid";
import { useVersion } from "../hooks/useVersion";
import { useSpeechCaptureSettings } from "../hooks/useSpeechCaptureSettings";
import { useRecentSpeechAttribution } from "../hooks/useRecentSpeechAttribution";
import { useActingPrincipal } from "../hooks/useActingPrincipal";
import { isAbsoluteLikePath, shortenPath } from "../lib/text";
import type { PermissionMode, Project } from "../types";
import { AttachmentChip } from "./AttachmentChip";
import { DeliveryGlyph } from "./DeliveryGlyph";
import type { FilterOption } from "./FilterDropdown";
import { FullPaneComposerToggle } from "./FullPaneComposerToggle";
import { NewSessionProjectQueue } from "./NewSessionProjectQueue";
import { SpeechDraftField } from "./SpeechDraftField";
import { SpeechPrefixActionCue } from "./SpeechPrefixActionCue";
import { SpeechControlMenu } from "./SpeechControlMenu";
import { VoiceInputButton, type VoiceInputButtonRef } from "./VoiceInputButton";

type PendingNewSessionSpeechDeliveryIntent =
  | "start"
  | "background"
  | "project-queue";

interface PendingNewSessionSpeechDelivery {
  kind: PendingNewSessionSpeechDeliveryIntent;
  visibleTextSnapshot: string;
}

export interface NewSessionFormProps {
  /** Keep this project selected while retaining all launch options. */
  fixedProject?: boolean;
  projectApp?: ProjectAppTarget;
  onVoiceControl?: (control: VoiceInputButtonRef | null) => void;
  projectId?: string;
  selectedProject?: Project | null;
  projects?: Project[];
  recentProjectIds?: string[];
  projectsLoading?: boolean;
  /** Display snapshots may be shown, but cannot authorize Start or Queue. */
  unconfirmedProjectIds?: readonly string[];
  onProjectChange?: (projectId: string | null) => void;
  /** Whether to focus the textarea on mount (default: true) */
  autoFocus?: boolean;
  /** Number of rows for the textarea (default: 6) */
  rows?: number;
  /** Placeholder text for the textarea */
  placeholder?: string;
  /** Compact mode: no header, no mode selector (default: false) */
  compact?: boolean;
  /** Seed the provider selection (e.g. "clear" from an existing session). */
  preferredProvider?: ProviderName;
  /** Seed the model selection; applied when preferredProvider matches. */
  preferredModel?: string;
  /** Seed thinking and effort from an existing session. */
  preferredThinking?: ThinkingOption;
  /** Seed approval behavior from an existing session. */
  preferredPermissionMode?: PermissionMode;
  /** One PWA image-share batch claimed by the owning route. */
  incomingShareFiles?: readonly File[];
  /**
   * The route's `prefillToken`. The form reads the token from the address
   * itself; a change here makes an already-mounted form read it again.
   */
  prefillToken?: string | null;
  /**
   * Reuse the New Session composer and launch controls for a specialized
   * session start such as handoff.
   */
  launch?: {
    draftKey: string;
    initialMessage: string;
    fixedProject?: boolean;
    allowAttachments?: boolean;
    allowProjectQueue?: boolean;
    /**
     * How the seeded message is offered. `editable` is an ordinary draft.
     * `muted` shows it dimmed, compact, and read-only: the launch composes
     * its own first turn — a fork copies the real transcript — so the draft
     * is context for the choice rather than something being sent.
     */
    composer?: "editable" | "muted";
    /** Start-control wording, for a launch whose verb is not "start session". */
    startLabel?: string;
    startingLabel?: string;
    /**
     * Withhold the provider and model pickers. A fork continues an existing
     * provider transcript, so changing either would not be a fork; offering
     * the choice would only invite a request the server refuses.
     */
    fixedProviderModel?: boolean;
    submit: (request: {
      message: string;
      options: SessionOptions;
      clientTimestamp: number;
    }) => Promise<void>;
  };
}

/** The New project palette choice that starts from a plain folder. */
const EMPTY_FOLDER_CHOICE = "empty-folder";

export function NewSessionForm({
  fixedProject: fixedProjectProp = false,
  projectApp,
  onVoiceControl,
  projectId,
  selectedProject,
  projects = [],
  recentProjectIds = [],
  projectsLoading = false,
  unconfirmedProjectIds = [],
  onProjectChange,
  autoFocus = true,
  rows = 6,
  placeholder,
  compact = false,
  preferredProvider,
  preferredModel,
  preferredThinking,
  preferredPermissionMode,
  prefillToken: routedPrefillToken,
  incomingShareFiles,
  launch,
}: NewSessionFormProps) {
  const { t } = useI18n();
  // New project starts a folder YA has not seen, from the explicit panel or
  // from an unmatched path typed into the project search
  // (topics/project-names.md § New project).
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const [newProjectEntry, setNewProjectEntry] = useState("");
  const [newProjectChoice, setNewProjectChoice] =
    useState<string>(EMPTY_FOLDER_CHOICE);
  const [newProjectGitInit, setNewProjectGitInit] = useState(
    () => localStorage.getItem(UI_KEYS.newProjectGitInit) !== "false",
  );
  const {
    choices: templateChoices,
    error: templateError,
    emptyMessageKey,
  } = useProjectTemplateChoices(newProjectOpen);
  const [templateProjectBusy, setTemplateProjectBusy] = useState(false);
  const handleTemplateBusyChange = useCallback((busy: boolean) => {
    setTemplateProjectBusy(busy);
    if (busy) setNewProjectOpen(true);
  }, []);
  const handleTemplateRecovered = useCallback(
    (request: TemplateCreationRequest) => {
      setNewProjectOpen(true);
      setNewProjectEntry(request.path);
      setNewProjectChoice(`${request.sourceId}/${request.templateId}`);
    },
    [],
  );
  const navigate = useNavigate();
  const basePath = useRemoteBasePath();
  const { relayTransport, relayedServerSpeechAvailable } =
    useSpeechSourceRuntime();
  const clientSummarySourceKey = useClientSummarySourceKey();
  const creationViewOwner = useRef({
    active: true,
    sourceKey: clientSummarySourceKey,
    accountKey: null as string | null,
  });
  creationViewOwner.current.sourceKey = clientSummarySourceKey;
  useEffect(() => {
    creationViewOwner.current.active = true;
    return () => {
      creationViewOwner.current.active = false;
    };
  }, []);
  const sourceRuntime = useCurrentSourceRuntime();
  const sourceSummary = sourceRuntime.summary;
  const sourceTransport = sourceRuntime.transport;
  const newSessionDraftKey = useMemo(
    () => launch?.draftKey ?? createNewSessionDraftKey(clientSummarySourceKey),
    [clientSummarySourceKey, launch?.draftKey],
  );
  const [message, setMessage, draftControls] =
    useDraftPersistence(newSessionDraftKey);
  const [pendingFiles, setPendingFilesState] = useState<PendingFile[]>([]);
  const pendingFilesRef = useRef<PendingFile[]>([]);
  const draftAttachmentBatchIdRef = useRef<string | null>(null);
  const draftAttachmentHydrationRef = useRef(0);
  const pendingStagedUploadsRef = useRef<
    Map<string, Promise<PendingStagedFile | null>>
  >(new Map());
  const removedPendingUploadIdsRef = useRef<Set<string>>(new Set());
  const [isStarting, setIsStarting] = useState(false);
  const [acceptingText, setAcceptingText] = useState(false);
  const [acceptedCreation, setAcceptedCreation] = useState<
    | (import("@yep-anywhere/shared").SessionCreationReceipt & {
        sourceKey: string;
        accountKey: string | null;
        background: boolean;
      })
    | null
  >(null);
  const [fullPane, setFullPane] = useState(false);
  const [fullPaneWide, setFullPaneWide] = useState(false);
  const [fullPaneBaseWidth, setFullPaneBaseWidth] = useState<number | null>(
    null,
  );
  const [uploadProgress, setUploadProgress] = useState<
    Record<string, { uploaded: number; total: number }>
  >({});
  const [attachmentQuality] = useAttachmentUploadQuality();
  const { visibility: toolbarVisibility } = useSessionToolbarPresence();
  const {
    speechState,
    interimTranscript,
    setInterimTranscript,
    interimTranscriptRef,
    speechPending,
    speechPendingRef,
    speechTransactionHasTextRef,
    speechTurnIdRef,
    speechInsertionRangeRef,
    activeSpeechTargetIdRef,
    pendingSpeechFinalRef,
    pendingTextareaSelectionRef,
    clearPendingSpeechFinal,
    noteSpeechDraftEdit,
    restorePendingTextareaSelection,
  } = useComposerSpeechState();
  const pendingSpeechDeliveryRef =
    useRef<PendingNewSessionSpeechDelivery | null>(null);
  const pendingSpeechDeliverySettledRef = useRef(false);
  const dispatchingSettledSpeechDeliveryRef = useRef(false);
  const runPendingSpeechDeliveryRef = useRef<() => void>(() => {});
  const { asrAttributionMs, speechMessagePrefix } = useSpeechCaptureSettings();
  const {
    active: speechAttributionActive,
    noteSpeech: noteSpeechAttribution,
    isRecent: isRecentSpeechAttribution,
    consume: consumeSpeechAttribution,
  } = useRecentSpeechAttribution(asrAttributionMs);
  const [isProjectChooserExpanded, setIsProjectChooserExpanded] =
    useState(false);
  const requestedProjectPath = useMemo(() => {
    if (!projectId || !isUrlProjectId(projectId)) return "";
    try {
      const path = fromUrlProjectId(projectId);
      return isAbsoluteLikePath(path) ? path : "";
    } catch {
      return "";
    }
  }, [projectId]);
  const [projectInput, setProjectInput] = useState(
    () => selectedProject?.path ?? requestedProjectPath,
  );
  const fileInputRef = useRef<HTMLInputElement>(null);
  const projectChooserRef = useRef<HTMLDivElement>(null);
  const projectInputRef = useRef<HTMLInputElement>(null);
  const mainStackRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const voiceButtonRef = useRef<VoiceInputButtonRef>(null);
  const sharedVoiceRef = useComposerVoiceRef(voiceButtonRef, onVoiceControl);
  const lastSyncedProjectIdRef = useRef<string | null>(null);
  const hasSeededMessageRef = useRef(false);
  const seedBaselineRef = useRef<string | null>(null);
  const autoFocusRef = useRef(autoFocus);
  // Only the page's own form stands in for the pre-boot composer; a launch
  // (fork, handoff) composer is a different field.
  const adoptsPrebootRef = useRef(!launch);

  // Thinking toggle state
  const {
    effortLevel: legacyEffortLevel,
    thinkingMode: legacyThinkingMode,
    showThinking,
    setShowThinking,
    voiceInputEnabled,
    speechMethod,
    hasStoredSpeechMethod,
    setSpeechMethod,
    speechSmartTurnSettings,
    setSpeechSmartTurnSettings,
  } = useModelSettings();

  // Server version for voiceBackends advertisement
  const { version: versionInfo, loading: versionLoading } = useVersion();
  // What this principal's account settles rather than offers. A limited user's
  // locked fields and forced sandbox are enforced at the launch route; the
  // form reads them so it stops presenting a choice that would be refused.
  // See topics/limited-users.md § Delivery v1.
  const { principal, resolved: principalResolved } = useActingPrincipal();
  const { backgroundSessionCreation } = useBackgroundSessionCreation();
  creationViewOwner.current.accountKey = principal.username;
  const pendingCreation = useMemo(
    () =>
      isStarting
        ? null
        : pendingSessionCreation(
            `ya-text-creation:${clientSummarySourceKey}:${principal.username}:${newSessionDraftKey}`,
          ),
    [
      clientSummarySourceKey,
      principal.username,
      newSessionDraftKey,
      isStarting,
    ],
  );
  const historyScope = principalResolved
    ? JSON.stringify([clientSummarySourceKey, principal.username])
    : null;
  const [recentUploadsOpen, setRecentUploadsOpen] = useState(false);
  const [audioMemoOpen, setAudioMemoOpen] = useState(false);
  const memoPendingIdRef = useRef<string | null>(null);
  const attachGesture = useRef({ y: 0, swiped: false });
  const launchLock = useMemo<LaunchLock>(
    () => launchLockFor(principal),
    [principal],
  );
  useRendezCompose(
    sourceTransport,
    selectedProject?.id === projectId ? projectId : undefined,
    principalResolved &&
      !launchLock.limited &&
      !launch &&
      !isStarting &&
      serverHasCapability(versionInfo, SERVER_CAPABILITIES.rendezCompose),
  );
  const newSessionOptions = useNewSessionOptions({
    clientSummarySourceKey,
    launch,
    launchLock,
    preferredProvider,
    preferredModel,
    preferredThinking,
    preferredPermissionMode,
    versionInfo,
    versionLoading,
    legacyEffortLevel,
    legacyThinkingMode,
    t,
  });
  const {
    displayDefaultsPending,
    effectiveEffortLevel,
    effectivePermissionMode,
    effectiveSandboxLevel,
    effectiveSandboxNetworkFirewall,
    effectiveServiceTier,
    effectiveThinkingMode,
    hasDirectProviderModel,
    hasSelectedProviderModel,
    helperSideModel,
    machineControlEligible,
    machineControlSelected,
    recapAfterSeconds,
    refetchSettings,
    routedModel,
    routerAccountId,
    routerClaudeAiConnectors,
    routerPolicy,
    routerSelection,
    routerSelectionCustomized,
    routerThinking,
    selectedEffortLevel,
    selectedModel,
    selectedPromptSuggestionMode,
    selectedProvider,
    selectedProviderInfo,
    selectedRecapMode,
    selectedServiceTier,
    selectedThinkingMode,
    settingsError,
    settingsLoading,
    showThinkingControls,
    supportsInstalledMachineControl,
    supportsSessionSandboxing,
  } = newSessionOptions;

  const projectQueueCtrlEnterEnabled =
    versionInfo?.clientDefaults?.projectQueueCtrlEnterEnabled ??
    DEFAULT_PROJECT_QUEUE_CTRL_ENTER_ENABLED;
  const { hasBrowserXaiSttApiKey } = useBrowserXaiSttApiKey();

  // Toast for error messages
  const { showToast } = useToastContext();
  const allowAttachments = launch?.allowAttachments ?? true;
  const allowProjectQueue = launch?.allowProjectQueue ?? true;
  const fixedProject = launch?.fixedProject ?? fixedProjectProp;
  const composerMuted = launch?.composer === "muted";
  const canCreateInBackground =
    backgroundSessionCreation &&
    !launch &&
    !composerMuted &&
    serverHasCapability(
      versionInfo,
      SERVER_CAPABILITIES.sessionCreationAdmission.name,
    );
  const showProviderAndModel = !(launch?.fixedProviderModel ?? false);
  // A locked field is stated in the fixed-launch caption instead of offered.
  const showProviderPicker = showProviderAndModel && !launchLock.provider;
  const showModelPicker = showProviderAndModel && !launchLock.model;

  // What the composer held on the first render: a restored draft arrives
  // synchronously from storage, so anything beyond this was typed here.
  if (seedBaselineRef.current === null) seedBaselineRef.current = message;

  // A launch may resolve its seed asynchronously — the handoff draft is
  // fetched — so wait for content rather than seeding an empty composer once
  // and never again. A restored draft is the user's own earlier edit of this
  // same launch, so it wins over re-seeding.
  useLayoutEffect(() => {
    if (!launch || hasSeededMessageRef.current) return;
    if (!launch.initialMessage) return;
    hasSeededMessageRef.current = true;
    const baseline = seedBaselineRef.current ?? "";
    if (!message) {
      setMessage(launch.initialMessage);
      return;
    }
    if (baseline) return;
    // The composer is focused and typeable while the seed is still being
    // fetched, so keys can land before it arrives. They belong after the
    // seeded text rather than instead of it — dropping the seed because
    // someone typed one character lost the whole handoff. They were written
    // without seeing the seed, so they start their own paragraph.
    const separator =
      /\s$/.test(launch.initialMessage) || /^\s/.test(message) ? "" : "\n\n";
    const combined = `${launch.initialMessage}${separator}${message}`;
    pendingTextareaSelectionRef.current = {
      value: combined,
      restore: (textarea) => {
        textarea.focus();
        textarea.setSelectionRange(combined.length, combined.length);
      },
    };
    setMessage(combined);
  }, [launch, message, setMessage]);

  const writeDraftAttachmentState = useCallback(
    (nextFiles: readonly PendingFile[]) => {
      const stagedRefs = nextFiles
        .filter(isPendingStagedFile)
        .map(toPersistedStagedAttachmentRef);
      if (stagedRefs.length === 0) {
        if (!nextFiles.some((file) => file.kind === "uploading")) {
          draftAttachmentBatchIdRef.current = null;
        }
        draftControls.setAttachmentState(null);
        return;
      }

      const batchId = stagedRefs[0]?.batchId;
      if (!batchId) {
        draftControls.setAttachmentState(null);
        return;
      }

      draftAttachmentBatchIdRef.current = batchId;
      draftControls.setAttachmentState({
        batchId,
        refs: stagedRefs,
        updatedAt: new Date().toISOString(),
      });
    },
    [draftControls],
  );

  const setPendingFiles = useCallback(
    (
      updater:
        | PendingFile[]
        | ((previous: readonly PendingFile[]) => readonly PendingFile[]),
      options?: {
        persistDraft?: boolean;
        revokeRemovedPreviewUrls?: boolean;
      },
    ) => {
      const previous = pendingFilesRef.current;
      const nextValue =
        typeof updater === "function" ? updater(previous) : updater;
      if (nextValue === previous) {
        return;
      }
      const next = [...nextValue];

      if (options?.revokeRemovedPreviewUrls) {
        const nextIds = new Set(next.map((file) => file.id));
        revokePendingFilePreviewUrls(
          previous.filter((file) => !nextIds.has(file.id)),
        );
      }

      pendingFilesRef.current = next;
      setPendingFilesState(next);
      if (options?.persistDraft !== false) {
        writeDraftAttachmentState(next);
      }
    },
    [writeDraftAttachmentState],
  );

  useEffect(() => {
    return () => {
      revokePendingFilePreviewUrls(pendingFilesRef.current);
    };
  }, []);

  const ensureDraftAttachmentBatchId = useCallback(() => {
    const existing =
      draftControls.getAttachmentState()?.batchId ??
      draftAttachmentBatchIdRef.current;
    if (existing) {
      draftAttachmentBatchIdRef.current = existing;
      return existing;
    }
    const batchId = generateUUID();
    draftAttachmentBatchIdRef.current = batchId;
    return batchId;
  }, [draftControls]);

  const hydrateDraftAttachments = useCallback(async () => {
    const state = draftControls.getAttachmentState();
    if (!state) {
      setPendingFiles(
        (prev) =>
          prev.some(isPendingStagedFile)
            ? prev.filter((file) => !isPendingStagedFile(file))
            : prev,
        {
          persistDraft: false,
          revokeRemovedPreviewUrls: true,
        },
      );
      return;
    }

    const syncEnabled = serverHasCapability(
      versionInfo,
      SERVER_CAPABILITIES.draftSync.name,
    );
    if (
      !syncEnabled &&
      pendingFilesRef.current.some(
        (file) => file.kind === "uploading" || isPendingStagedFile(file),
      )
    )
      return;
    if (syncEnabled)
      setPendingFiles(
        (prev) => [
          ...prev.filter((file) => !isPendingStagedFile(file)),
          ...state.refs.map(
            (ref): PendingStagedFile => ({ ...ref, kind: "staged" }),
          ),
        ],
        { persistDraft: false, revokeRemovedPreviewUrls: true },
      );

    const hydrationId = draftAttachmentHydrationRef.current + 1;
    draftAttachmentHydrationRef.current = hydrationId;

    try {
      const refs = await validateDraftAttachmentRefs(sourceTransport, state);
      if (
        draftAttachmentHydrationRef.current !== hydrationId ||
        JSON.stringify(draftControls.getAttachmentState()?.refs) !==
          JSON.stringify(state.refs)
      ) {
        return;
      }

      if (syncEnabled && refs.length !== state.refs.length) {
        showToast(t("sessionDraftAttachmentsUnavailable"), "info");
        return;
      }
      const nextState: DraftAttachmentState | null =
        refs.length > 0
          ? {
              batchId: refs[0]?.batchId ?? state.batchId,
              refs,
              updatedAt: new Date().toISOString(),
            }
          : null;
      draftAttachmentBatchIdRef.current = nextState?.batchId ?? null;
      draftControls.setAttachmentState(nextState);
      setPendingFiles(
        (prev) => [
          ...prev.filter((file) => !isPendingStagedFile(file)),
          ...refs.map(
            (ref): PendingStagedFile => ({
              ...ref,
              kind: "staged",
            }),
          ),
        ],
        {
          persistDraft: false,
          revokeRemovedPreviewUrls: true,
        },
      );
    } catch (err) {
      if (
        draftAttachmentHydrationRef.current !== hydrationId ||
        JSON.stringify(draftControls.getAttachmentState()?.refs) !==
          JSON.stringify(state.refs)
      ) {
        return;
      }
      // Reconnection is not evidence that the staged file disappeared.
      setPendingFiles(
        (prev) => [
          ...prev.filter((file) => !isPendingStagedFile(file)),
          ...state.refs.map(
            (ref): PendingStagedFile => ({ ...ref, kind: "staged" }),
          ),
        ],
        { persistDraft: false, revokeRemovedPreviewUrls: true },
      );
      if (!isInterruptedDraftAttachmentValidation(err))
        showToast(t("sessionDraftAttachmentsValidationFailed"), "info");
    }
  }, [
    sourceTransport,
    draftControls,
    setPendingFiles,
    showToast,
    versionInfo,
    t,
  ]);

  useEffect(() => {
    void newSessionDraftKey;
    void hydrateDraftAttachments();
  }, [hydrateDraftAttachments, newSessionDraftKey]);
  useEffect(() => {
    const changed = (event: Event) => {
      if (
        (event as CustomEvent<{ key: string }>).detail.key ===
        newSessionDraftKey
      )
        void hydrateDraftAttachments();
    };
    window.addEventListener(DRAFT_STORAGE_EVENT, changed);
    return () => window.removeEventListener(DRAFT_STORAGE_EVENT, changed);
  }, [hydrateDraftAttachments, newSessionDraftKey]);

  const addPendingFiles = useCallback(
    (files: readonly File[]) => {
      if (files.length === 0) {
        return;
      }
      const pendingNames = pendingFilesRef.current.map(getPendingFileName);
      const uniqueFiles = makeAttachmentFileNamesUnique(files, pendingNames);

      const batchId = ensureDraftAttachmentBatchId();

      if (!batchId) {
        const localFiles = uniqueFiles.map(
          (file): PendingLocalFile => ({
            kind: "local",
            id: `pending-${generateUUID()}`,
            file,
            previewUrl: file.type.startsWith("image/")
              ? URL.createObjectURL(file)
              : undefined,
          }),
        );
        setPendingFiles((prev) => [...prev, ...localFiles]);
        return;
      }

      for (const file of uniqueFiles) {
        const tempId = `pending-${generateUUID()}`;
        const previewUrl = file.type.startsWith("image/")
          ? URL.createObjectURL(file)
          : undefined;
        const uploadingFile: PendingUploadingFile = {
          kind: "uploading",
          id: tempId,
          originalName: file.name,
          size: file.size,
          mimeType: file.type || "application/octet-stream",
          ...(previewUrl ? { previewUrl } : {}),
        };
        setPendingFiles((prev) => [...prev, uploadingFile]);

        const uploadPromise = (async () => {
          const { uploadFile, uploadOptions } =
            await prepareComposerAttachmentUpload(
              file,
              getAttachmentUploadProfile(
                attachmentQuality,
                selectedProviderInfo,
                selectedModel,
              ),
              (bytesUploaded, preparedFile) => {
                setUploadProgress((prev) => ({
                  ...prev,
                  [tempId]: {
                    uploaded: bytesUploaded,
                    total: preparedFile.size,
                  },
                }));
              },
            );
          const stagedRef = await sourceTransport.uploadStagedAttachment(
            uploadFile,
            { batchId, ...uploadOptions },
          );
          if (uploadFile.type.startsWith("image/")) {
            void storeUploadedAttachmentPreview(
              {
                id: stagedRef.id,
                originalName: file.name,
                name: stagedRef.name,
                path: stagedRef.id,
                size: stagedRef.size,
                mimeType: stagedRef.mimeType,
                ...(stagedRef.width !== undefined
                  ? { width: stagedRef.width }
                  : {}),
                ...(stagedRef.height !== undefined
                  ? { height: stagedRef.height }
                  : {}),
              },
              uploadFile,
            ).catch(() => {});
          }
          if (historyScope)
            void rememberComposerUpload(historyScope, uploadFile, {
              projectId,
              projectName: selectedProject?.name ?? projectInput,
            }).catch((cause) =>
              showToast(
                t("composerHistorySaveError", { error: String(cause) }),
                "error",
              ),
            );
          return {
            ...stagedRef,
            originalName: file.name,
            kind: "staged",
            ...(previewUrl ? { previewUrl } : {}),
          } satisfies PendingStagedFile;
        })()
          .then(
            (stagedFile) => {
              const wasRemoved =
                removedPendingUploadIdsRef.current.delete(tempId) ||
                !pendingFilesRef.current.some((item) => item.id === tempId);
              if (wasRemoved) {
                if (previewUrl) {
                  URL.revokeObjectURL(previewUrl);
                }
                void deleteDraftAttachmentRef(
                  sourceTransport,
                  stagedFile.batchId,
                  stagedFile.id,
                ).catch((err) => {
                  console.warn(
                    "[NewSessionForm] Failed to delete staged attachment:",
                    err,
                  );
                });
                return null;
              }

              setPendingFiles((prev) =>
                prev.map((item) => (item.id === tempId ? stagedFile : item)),
              );
              return stagedFile;
            },
            (err) => {
              const wasRemoved =
                removedPendingUploadIdsRef.current.delete(tempId) ||
                !pendingFilesRef.current.some((item) => item.id === tempId);
              if (!wasRemoved) {
                console.error("Failed to upload staged file:", err);
                const uploadMessage =
                  err instanceof Error ? err.message : String(err);
                showToast(
                  t("newSessionUploadError", { message: uploadMessage }),
                  "error",
                );
                setPendingFiles(
                  (prev) => prev.filter((item) => item.id !== tempId),
                  { revokeRemovedPreviewUrls: true },
                );
              }
              return null;
            },
          )
          .finally(() => {
            setUploadProgress((prev) => {
              const { [tempId]: _removed, ...rest } = prev;
              return rest;
            });
            pendingStagedUploadsRef.current.delete(tempId);
          });

        pendingStagedUploadsRef.current.set(tempId, uploadPromise);
      }
    },
    [
      attachmentQuality,
      selectedProviderInfo,
      selectedModel,
      historyScope,
      sourceTransport,
      projectId,
      selectedProject?.name,
      projectInput,
      ensureDraftAttachmentBatchId,
      setPendingFiles,
      showToast,
      t,
    ],
  );

  const consumedIncomingShareFilesRef = useRef<readonly File[] | null>(null);
  useEffect(() => {
    if (
      !allowAttachments ||
      !incomingShareFiles?.length ||
      consumedIncomingShareFilesRef.current === incomingShareFiles
    ) {
      return;
    }
    consumedIncomingShareFilesRef.current = incomingShareFiles;
    addPendingFiles(incomingShareFiles);
  }, [addPendingFiles, allowAttachments, incomingShareFiles]);

  const resolvedPlaceholder = placeholder ?? t("newSessionPlaceholder");
  const sortedProjects = useMemo(
    () => sortProjectsForChooser(projects, recentProjectIds),
    [projects, recentProjectIds],
  );
  const quickProjects = useMemo(
    () => sortedProjects.slice(0, QUICK_PROJECT_COUNT),
    [sortedProjects],
  );
  const normalizedProjectInput = normalizeProjectInput(projectInput);
  const normalizedSelectedProjectPath = normalizeProjectInput(
    selectedProject?.path ?? requestedProjectPath,
  );
  const isProjectInputCommittedSelection =
    Boolean(normalizedProjectInput) &&
    Boolean(normalizedSelectedProjectPath) &&
    normalizedProjectInput === normalizedSelectedProjectPath;
  const activeProjectSearchQuery = isProjectInputCommittedSelection
    ? ""
    : normalizedProjectInput;
  const exactProjectMatch = useMemo(
    () => findProjectByInput(projects, activeProjectSearchQuery),
    [activeProjectSearchQuery, projects],
  );
  const projectMatches = useMemo(() => {
    if (!activeProjectSearchQuery) {
      return sortedProjects;
    }

    const query = activeProjectSearchQuery.toLowerCase();
    return sortedProjects.filter((project) => {
      return (
        project.name.toLowerCase().includes(query) ||
        project.path.toLowerCase().includes(query)
      );
    });
  }, [activeProjectSearchQuery, sortedProjects]);
  const projectSuggestions = useMemo(() => {
    const source = activeProjectSearchQuery ? projectMatches : quickProjects;
    return source.slice(0, PROJECT_SUGGESTION_COUNT);
  }, [activeProjectSearchQuery, projectMatches, quickProjects]);
  const projectSuggestionOptions = useMemo(
    () =>
      projectSuggestions.map((project) => (
        <option key={project.id} value={project.path}>
          {project.name}
        </option>
      )),
    [projectSuggestions],
  );
  const hasCustomProjectPath =
    Boolean(activeProjectSearchQuery) && exactProjectMatch === null;
  // A typed name or relative path names a folder under the base, created on
  // start if missing (topics/project-names.md § Paths from names).
  const newProjectBase = newProjectBaseFor(principal);
  // The New project panel replaces the selection with a project to start: it
  // is open from its button, or shown for a typed path that matches nothing,
  // in which case the search box is its path field.
  const newProjectPanelShown =
    !launch && !fixedProject && (newProjectOpen || hasCustomProjectPath);
  const newProjectTypedEntry = newProjectOpen
    ? newProjectEntry
    : activeProjectSearchQuery;
  const newProjectTarget = useMemo(
    () =>
      newProjectPanelShown && newProjectTypedEntry.trim()
        ? settlePathEntry(newProjectTypedEntry, newProjectBase, projects)
        : null,
    [newProjectPanelShown, newProjectTypedEntry, newProjectBase, projects],
  );
  // What the settled path holds decides what Start can do there: a folder
  // with content is added as it is, so it offers no starting point or Git
  // choice. The last answer stands while the next path is checked, so typing
  // does not flash the palette away and back.
  const newProjectProbePath =
    newProjectPanelShown &&
    serverHasCapability(
      versionInfo,
      SERVER_CAPABILITIES.projectFolderState.name,
    )
      ? (newProjectTarget?.path ?? "")
      : "";
  const [newProjectFolder, setNewProjectFolder] = useState<
    "missing" | "empty" | "contents" | "file" | null
  >(null);
  useEffect(() => {
    if (!newProjectProbePath) {
      setNewProjectFolder(null);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      api
        .getProjectFolderState(newProjectProbePath)
        .then((result) => {
          if (!cancelled) setNewProjectFolder(result.state);
        })
        .catch(() => {
          if (!cancelled) setNewProjectFolder(null);
        });
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [newProjectProbePath]);
  const newProjectFolderState = newProjectProbePath ? newProjectFolder : null;
  const newProjectOffersStart =
    newProjectFolderState !== "contents" && newProjectFolderState !== "file";
  const newProjectTemplates = templateChoices?.enabled
    ? templateChoices.templates
    : [];
  const newProjectTemplate =
    newProjectPanelShown && newProjectOffersStart
      ? newProjectTemplates.find(
          (template) => templateChoiceKey(template) === newProjectChoice,
        )
      : undefined;
  // A template project is made by its own Create & prepare action, so the
  // ordinary start waits while one is chosen.
  const creatingTemplateProject = newProjectTemplate !== undefined;
  const newProjectSubmission =
    newProjectPanelShown && !newProjectTemplate && newProjectTarget?.path
      ? newProjectTarget
      : null;
  const startActionKey = !newProjectSubmission
    ? "newSessionStartAction"
    : newProjectFolderState === "contents"
      ? "newSessionAddAndStartAction"
      : "newSessionCreateAndStartAction";
  const projectCreationGitChoice = serverHasCapability(
    versionInfo,
    SERVER_CAPABILITIES.projectCreationGitChoice.name,
  );
  const newProjectInitializesGit =
    !projectCreationGitChoice || newProjectGitInit;
  const currentProjectSelection = exactProjectMatch ?? selectedProject ?? null;
  const projectSnapshotPending =
    currentProjectSelection !== null &&
    unconfirmedProjectIds.includes(currentProjectSelection.id);
  const projectQueueTargetProjectId =
    !projectSnapshotPending &&
    !newProjectPanelShown &&
    normalizedProjectInput &&
    currentProjectSelection
      ? currentProjectSelection.id
      : null;
  const fileCompletion = useProjectFileCompletion({
    projectId: projectQueueTargetProjectId,
    text: message,
    textarea: textareaRef,
    setText: setMessage,
    disabled: isStarting || composerMuted || !!interimTranscript,
  });
  const projectQueueProjectIds = useMemo(
    () => (projectQueueTargetProjectId ? [projectQueueTargetProjectId] : []),
    [projectQueueTargetProjectId],
  );
  const projectQueues = useProjectQueues(projectQueueProjectIds);
  const activeProjectSessionIds = useActiveProjectSessionIds(
    projectQueueTargetProjectId,
  );
  const selectedProjectQueueItems = projectQueueTargetProjectId
    ? (projectQueues.queuesByProject[projectQueueTargetProjectId] ?? [])
    : [];
  const projectQueueItemCount = selectedProjectQueueItems.length;
  const projectQueueBlockingCount =
    currentProjectSelection?.projectQueueBlockingCount ?? null;
  const showProjectQueueAction = shouldShowProjectQueueAffordance({
    projectId: projectQueueTargetProjectId,
    activeProjectSessionIds,
    projectQueueBlockingCount,
    projectQueueItemCount,
  });
  // A named project whose record has not arrived yet is neither detached nor
  // ready to start. The composer does not wait for it: typing starts at once,
  // and starting waits for the project.
  const projectPending =
    !newProjectPanelShown &&
    (projectSnapshotPending ||
      (Boolean(projectId) && currentProjectSelection === null));
  // Until the first capability read settles, the form cannot tell a current
  // server from an older one: it would pick the retired legacy creation route
  // and skip a saved router preference. Starting waits for it like the project.
  const serverCapabilitiesPending = versionInfo === null && versionLoading;
  const isDetachedProject =
    !newProjectPanelShown &&
    currentProjectSelection === null &&
    !projectPending;
  const canCreateDetached =
    principalResolved &&
    (!launchLock.limited ||
      (principal.grants?.allowNoProjectSessions === true &&
        serverHasCapability(
          versionInfo,
          SERVER_CAPABILITIES.limitedUserNoProjectSessions.name,
        )));
  // A project about to be started is what the summary names, not the
  // selection the New project panel or a typed path replaced.
  const projectSummaryTitle = newProjectPanelShown
    ? (newProjectTarget && projectNameForEntry(newProjectTarget)) ||
      t("templateNewProject")
    : currentProjectSelection?.name ||
      (projectPending
        ? t("newSessionLoading")
        : t("newSessionProjectDetached"));
  const projectSummaryMeta = newProjectPanelShown
    ? (newProjectTarget?.path ?? "")
    : (currentProjectSelection?.path ??
      (projectPending ? "" : t("newSessionProjectDetachedHint")));
  const displayedProjectSummaryMeta =
    newProjectPanelShown || currentProjectSelection
      ? shortenPath(projectSummaryMeta)
      : projectSummaryMeta;
  const handleProjectOptionSelect = useCallback(
    (project: Project) => {
      setProjectInput(project.path);
      lastSyncedProjectIdRef.current = project.id;
      onProjectChange?.(project.id);
      setNewProjectOpen(false);
      setIsProjectChooserExpanded(false);
    },
    [onProjectChange],
  );

  const handleDetachedProject = useCallback(() => {
    setProjectInput("");
    lastSyncedProjectIdRef.current = null;
    onProjectChange?.(null);
    setNewProjectOpen(false);
    setIsProjectChooserExpanded(false);
  }, [onProjectChange]);

  const newProjectEntryRef = useRef<HTMLInputElement>(null);
  // The button opens the panel to be typed into; a creation restored after a
  // reload opens it without taking focus from the composer.
  const focusNewProjectEntryRef = useRef(false);
  useEffect(() => {
    if (!newProjectOpen || !focusNewProjectEntryRef.current) return;
    focusNewProjectEntryRef.current = false;
    newProjectEntryRef.current?.focus();
  }, [newProjectOpen]);
  // Opening carries an unmatched typed path into the panel's own field and
  // returns the search box to the selection it was replacing. Closing keeps
  // the entry and choice for reopening.
  const toggleNewProject = useCallback(() => {
    if (newProjectOpen) {
      setNewProjectOpen(false);
      return;
    }
    if (hasCustomProjectPath) {
      setNewProjectEntry(activeProjectSearchQuery);
      setProjectInput(selectedProject?.path ?? "");
    }
    setIsProjectChooserExpanded(false);
    focusNewProjectEntryRef.current = true;
    setNewProjectOpen(true);
  }, [
    activeProjectSearchQuery,
    hasCustomProjectPath,
    newProjectOpen,
    selectedProject?.path,
  ]);

  const projectPanelRows = useMemo(() => {
    if (!isProjectChooserExpanded) return null;

    const rows: ReactNode[] = canCreateDetached
      ? [
          <button
            key="detached"
            type="button"
            className={`new-session-project-option ${isDetachedProject ? "selected" : ""}`}
            onClick={handleDetachedProject}
          >
            <span className="new-session-project-option-name">
              {t("newSessionProjectDetached")}
            </span>
            <span className="new-session-project-option-path">
              {t("newSessionProjectDetachedHint")}
            </span>
          </button>,
        ]
      : [];

    if (projectsLoading) {
      rows.push(
        <div key="loading" className="new-session-project-empty">
          {t("newSessionLoading")}
        </div>,
      );
      return rows;
    }

    // An unmatched typed path is offered as a new project below the list.
    if (projectSuggestions.length === 0) {
      if (!hasCustomProjectPath)
        rows.push(
          <div key="no-matches" className="new-session-project-empty">
            {t("newSessionProjectNoMatches")}
          </div>,
        );
      return rows;
    }

    rows.push(
      ...projectSuggestions.map((project) => (
        <button
          key={project.id}
          type="button"
          className={`new-session-project-option ${currentProjectSelection?.id === project.id && !hasCustomProjectPath ? "selected" : ""}`}
          onClick={() => handleProjectOptionSelect(project)}
          title={project.path}
        >
          <span className="new-session-project-option-name">
            {project.name}
          </span>
          <span className="new-session-project-option-path">
            {shortenPath(project.path)}
          </span>
        </button>
      )),
    );

    return rows;
  }, [
    currentProjectSelection?.id,
    canCreateDetached,
    handleDetachedProject,
    handleProjectOptionSelect,
    hasCustomProjectPath,
    isDetachedProject,
    isProjectChooserExpanded,
    projectSuggestions,
    projectsLoading,
    t,
  ]);

  // A layout effect, so the field is filled before any key can start the
  // session: an empty field would start it detached.
  useLayoutEffect(() => {
    const nextProjectId = projectId ?? null;
    if (lastSyncedProjectIdRef.current === nextProjectId) {
      return;
    }
    // URL identity is display intent; only a server row authorizes launch.
    if (nextProjectId && !selectedProject) {
      setProjectInput((prev) => prev || requestedProjectPath);
      return;
    }

    lastSyncedProjectIdRef.current = nextProjectId;
    setProjectInput((prev) =>
      !prev || prev === requestedProjectPath
        ? (selectedProject?.path ?? "")
        : prev,
    );
  }, [projectId, requestedProjectPath, selectedProject]);

  useEffect(() => {
    if (!isProjectChooserExpanded) return;

    const closeIfOutsideProjectChooser = (target: EventTarget | null) => {
      if (!(target instanceof Node)) return;
      const projectChooser = projectChooserRef.current;
      if (projectChooser && !projectChooser.contains(target)) {
        setIsProjectChooserExpanded(false);
      }
    };

    const handlePointerDown = (event: PointerEvent) => {
      closeIfOutsideProjectChooser(event.target);
    };

    const handleFocusIn = (event: FocusEvent) => {
      closeIfOutsideProjectChooser(event.target);
    };

    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("focusin", handleFocusIn, true);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("focusin", handleFocusIn, true);
    };
  }, [isProjectChooserExpanded]);

  // Build STT backend options for the mic-attached speech menu.
  const speechMethodOptions = useMemo((): FilterOption<SpeechMethodId>[] => {
    const serverBackends = versionInfo?.voiceBackends ?? [];
    return getSpeechMethods(serverBackends, undefined, {
      directXaiAvailable: hasBrowserXaiSttApiKey,
    }).map((method) => ({
      value: method.id,
      label: method.label,
      description: method.description,
      disabled: !method.clientSupported,
    }));
  }, [versionInfo?.voiceBackends, hasBrowserXaiSttApiKey]);
  const selectedSpeechMethod = useMemo(
    () =>
      resolveSpeechMethod(
        speechMethod,
        versionInfo?.voiceBackends,
        hasStoredSpeechMethod,
        {
          directXaiAvailable: hasBrowserXaiSttApiKey,
          browserNativeAvailable: isBrowserNativeSpeechAvailable(),
        },
      ),
    [
      speechMethod,
      versionInfo?.voiceBackends,
      hasStoredSpeechMethod,
      hasBrowserXaiSttApiKey,
    ],
  );

  const handleSpeechMethodSelect = useCallback(
    (selected: string[]) => {
      const next = selected[0];
      if (next && isSpeechMethodId(next)) {
        setSpeechMethod(next);
      }
    },
    [setSpeechMethod],
  );
  const showSpeechMethodSelector =
    voiceInputEnabled && speechMethodOptions.length > 1;
  const selectedSpeechMethodCapabilities =
    selectedSpeechMethod === null
      ? {}
      : getSpeechMethodCapabilities(
          selectedSpeechMethod,
          versionInfo?.voiceBackendCapabilities,
        );
  const selectedSpeechCanStream =
    selectedSpeechMethod !== null &&
    canSpeechMethodStream({
      methodId: selectedSpeechMethod,
      serverCapabilities: versionInfo?.voiceBackendCapabilities,
      relayTransport,
      relayedServerSpeechAvailable,
    });
  const supportsSelectedSpeechSmartTurn =
    selectedSpeechCanStream &&
    selectedSpeechMethodCapabilities.smartTurn === true;
  const activeSpeechSmartTurnSettings: SpeechSmartTurnSettings | undefined =
    supportsSelectedSpeechSmartTurn ? speechSmartTurnSettings : undefined;

  // Focus in the commit that creates the textarea rather than a passive
  // effect after paint: this form is reached by a navigation whose point is
  // that the user can type, so a key struck in that gap must not fall through
  // to the page behind it. The caret goes after any seeded text.
  //
  // A tab opened on this page was already typeable before the app loaded
  // (lib/prebootComposer), so the page's form takes over that text and caret
  // in this same commit: nothing can be struck between the two fields. The
  // saved draft was visible on the local path, so its edited value replaces
  // that draft. Text typed before remote identity was known follows it.
  const attachComposerTextarea = useCallback(
    (textarea: HTMLTextAreaElement | null) => {
      textareaRef.current = textarea;
      if (!textarea) return;
      const preboot = adoptsPrebootRef.current ? takePrebootComposer() : null;
      adoptsPrebootRef.current = false;
      if (!autoFocusRef.current && !preboot) return;
      autoFocusRef.current = false;
      let selectionStart = textarea.value.length;
      let selectionEnd = selectionStart;
      if (preboot?.draftKey) {
        if (
          preboot.edited &&
          preboot.draftKey === draftStorage.physicalKey(newSessionDraftKey)
        ) {
          textarea.value = preboot.text;
          setMessage(preboot.text);
          selectionStart = preboot.selectionStart;
          selectionEnd = preboot.selectionEnd;
        }
      } else if (preboot?.text) {
        const draft = textarea.value;
        const separator =
          !draft || /\s$/.test(draft) || /^\s/.test(preboot.text) ? "" : "\n\n";
        const offset = draft.length + separator.length;
        const combined = `${draft}${separator}${preboot.text}`;
        textarea.value = combined;
        setMessage(combined);
        selectionStart = offset + preboot.selectionStart;
        selectionEnd = offset + preboot.selectionEnd;
      }
      textarea.focus();
      textarea.setSelectionRange(selectionStart, selectionEnd);
    },
    [newSessionDraftKey, setMessage],
  );

  useLayoutEffect(() => {
    restorePendingTextareaSelection(message, textareaRef.current);
  }, [message]);

  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    void message;
    if (!fullPane) {
      resizeComposerTextarea(textarea, true);
      return;
    }

    const resize = () => {
      const { overflowed } = resizeComposerTextarea(textarea, false, true);
      if (overflowed && !fullPaneWide) setFullPaneWide(true);
    };
    resize();
    window.addEventListener("resize", resize);
    window.visualViewport?.addEventListener("resize", resize);
    return () => {
      window.removeEventListener("resize", resize);
      window.visualViewport?.removeEventListener("resize", resize);
    };
  }, [fullPane, fullPaneWide, message]);

  const toggleFullPane = useCallback(() => {
    if (compact || composerMuted) return;
    if (!fullPane) {
      const baseWidth = mainStackRef.current?.getBoundingClientRect().width;
      setFullPaneBaseWidth(baseWidth && baseWidth > 0 ? baseWidth : null);
      setFullPaneWide(false);
    }
    setFullPane((current) => !current);
  }, [compact, composerMuted, fullPane]);

  // Check for opt-in new-session prefill on mount, and again when an in-app
  // navigation brings a new token to an already-mounted form.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the routed token is the trigger; the effect reads window.location.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const token = params.get("prefillToken");
    const record = token
      ? consumeNewSessionPrefillToken(token, clientSummarySourceKey)
      : consumeNewSessionPrefill(clientSummarySourceKey);
    if (!record) return;
    if (token) {
      params.delete("prefillToken");
      const search = params.toString();
      const next = `${window.location.pathname}${search ? `?${search}` : ""}${window.location.hash}`;
      window.history.replaceState(window.history.state, "", next);
    }
    pendingTextareaSelectionRef.current = {
      value: record.text,
      restore: (textarea) => {
        const position = record.caret === "start" ? 0 : record.text.length;
        textarea.focus();
        textarea.setSelectionRange(position, position);
      },
    };
    setMessage(record.text);
  }, [clientSummarySourceKey, setMessage, routedPrefillToken]);

  const handleProjectInputKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter") {
        e.preventDefault();
        if (exactProjectMatch) {
          handleProjectOptionSelect(exactProjectMatch);
        } else if (normalizedProjectInput) {
          setIsProjectChooserExpanded(false);
        }
      } else if (e.key === "Escape") {
        e.preventDefault();
        setIsProjectChooserExpanded(false);
      }
    },
    [exactProjectMatch, handleProjectOptionSelect, normalizedProjectInput],
  );

  const handleFileSelect = (e: ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files?.length) return;

    addPendingFiles(Array.from(files));
    e.target.value = ""; // Reset for re-selection
  };

  const handleRemoveFile = (id: string) => {
    const removed = pendingFilesRef.current.find((file) => file.id === id);
    if (removed?.kind === "uploading") {
      removedPendingUploadIdsRef.current.add(id);
    }
    setPendingFiles((prev) => prev.filter((file) => file.id !== id), {
      revokeRemovedPreviewUrls: true,
    });

    if (removed && isPendingStagedFile(removed)) {
      deleteDraftAttachmentRef(
        sourceTransport,
        removed.batchId,
        removed.id,
      ).catch((err) => {
        console.warn(
          "[NewSessionForm] Failed to delete staged attachment:",
          err,
        );
      });
    }
  };

  const resolveProjectIdForSubmission = useCallback(
    async (
      trimmedProjectInput: string,
      ownsSubmission: () => boolean = () => true,
    ): Promise<string | null> => {
      // New project creates exactly one folder (the server refuses a
      // missing parent), with Git unless declined, and adds an existing
      // folder as it is.
      if (newProjectSubmission) {
        const added = await api.addProject(newProjectSubmission.path, {
          create: true,
          name: newProjectSubmission.name,
          ...(projectCreationGitChoice ? { gitInit: newProjectGitInit } : {}),
        });
        if (!ownsSubmission()) return null;
        const createdId = added.project.id ?? null;
        if (!createdId) return null;
        const path = added.project.path ?? newProjectSubmission.path;
        showToast(
          added.created
            ? t("newSessionProjectFolderCreated", { path })
            : t("newSessionProjectFolderExisting", { path }),
          "info",
        );
        setNewProjectOpen(false);
        setNewProjectEntry("");
        setProjectInput(path);
        lastSyncedProjectIdRef.current = createdId;
        onProjectChange?.(createdId);
        return createdId;
      }
      let resolvedProjectId =
        trimmedProjectInput &&
        currentProjectSelection?.path === trimmedProjectInput
          ? currentProjectSelection.id
          : (findProjectByInput(projects, trimmedProjectInput)?.id ?? null);

      if (trimmedProjectInput && !resolvedProjectId) {
        // A typed name is a folder under the base, made if missing; a typed
        // absolute path must already exist, as it always had to.
        const newFolder = !isAnchoredPath(trimmedProjectInput);
        const target = settlePathEntry(
          trimmedProjectInput,
          newProjectBase,
          projects,
        );
        const addProjectResult = newFolder
          ? await api.addProject(target.path, {
              create: true,
              name: target.name,
            })
          : await api.addProject(target.path);
        if (!ownsSubmission()) return null;
        resolvedProjectId = addProjectResult.project.id ?? null;
        if (!resolvedProjectId) return null;
        if (newFolder) {
          const path = addProjectResult.project.path ?? target.path;
          showToast(
            addProjectResult.created
              ? t("newSessionProjectFolderCreated", { path })
              : t("newSessionProjectFolderExisting", { path }),
            "info",
          );
        }
        lastSyncedProjectIdRef.current = resolvedProjectId;
        onProjectChange?.(resolvedProjectId);
      }

      return resolvedProjectId;
    },
    [
      currentProjectSelection,
      newProjectBase,
      newProjectGitInit,
      newProjectSubmission,
      onProjectChange,
      projectCreationGitChoice,
      projects,
      showToast,
      t,
    ],
  );

  const resolvePendingAttachmentsForSession = useCallback(
    async (activeProjectId: string, sessionId: string) => {
      const pendingUploads = [...pendingStagedUploadsRef.current.values()];
      if (pendingUploads.length > 0) {
        const results = await Promise.all(pendingUploads);
        if (results.some((result) => result === null))
          throw new Error(t("sessionDraftAttachmentsUnavailable"));
      }

      const currentFiles = pendingFilesRef.current;
      const uploadedFiles: UploadedFile[] = [];
      const localFiles = currentFiles.filter(isPendingLocalFile);
      for (const pendingFile of localFiles) {
        try {
          const { uploadFile, uploadOptions } =
            await prepareComposerAttachmentUpload(
              pendingFile.file,
              getAttachmentUploadProfile(
                attachmentQuality,
                selectedProviderInfo,
                selectedModel,
              ),
              (bytesUploaded, preparedFile) => {
                setUploadProgress((prev) => ({
                  ...prev,
                  [pendingFile.id]: {
                    uploaded: bytesUploaded,
                    total: preparedFile.size,
                  },
                }));
              },
            );
          const uploadedFile = await sourceTransport.upload(
            activeProjectId,
            sessionId,
            uploadFile,
            uploadOptions,
          );
          uploadedFiles.push(uploadedFile);
        } catch (uploadErr) {
          console.error("Failed to upload file:", uploadErr);
          const uploadMessage =
            uploadErr instanceof Error ? uploadErr.message : "";
          showToast(
            t("newSessionUploadError", { message: uploadMessage }),
            "error",
          );
          throw uploadErr;
        }
      }

      const stagedRefs = currentFiles
        .filter(isPendingStagedFile)
        .map(toPersistedStagedAttachmentRef);
      if (stagedRefs.length === 0) {
        return uploadedFiles;
      }

      const batchId = stagedRefs[0]?.batchId;
      if (!batchId) {
        throw new Error("Draft attachments are split across staging batches");
      }

      const materializedFiles = await materializeDraftAttachmentsForSession(
        sourceTransport,
        activeProjectId,
        sessionId,
        {
          batchId,
          refs: stagedRefs,
          updatedAt: new Date().toISOString(),
        },
      );
      return [...uploadedFiles, ...materializedFiles];
    },
    [
      attachmentQuality,
      selectedProviderInfo,
      selectedModel,
      sourceTransport,
      showToast,
      t,
    ],
  );

  const deferSpeechDelivery = useCallback(
    (intent: PendingNewSessionSpeechDeliveryIntent) => {
      if (dispatchingSettledSpeechDeliveryRef.current) return false;
      const voice = voiceButtonRef.current;
      const speechWorkPending =
        voice?.isListening === true ||
        speechPendingRef.current !== null ||
        pendingSpeechFinalRef.current !== null;
      if (!speechWorkPending) {
        pendingSpeechDeliveryRef.current = null;
        pendingSpeechDeliverySettledRef.current = false;
        return false;
      }
      pendingSpeechDeliveryRef.current = {
        kind: intent,
        visibleTextSnapshot: getSpeechVisibleDraftText(
          draftControls.getDraft(),
          interimTranscriptRef.current,
          speechInsertionRangeRef.current,
        ),
      };
      pendingSpeechDeliverySettledRef.current = false;
      if (voice?.isListening) voice.stopAndFinalize();
      return true;
    },
    [draftControls],
  );

  const handleStartSession = useCallback(
    async (
      messageOverride?: unknown,
      speechTriggered = false,
      propagateFailure = false,
      background = false,
    ) => {
      const override =
        typeof messageOverride === "string" ? messageOverride : undefined;
      if (background && !canCreateInBackground) return;
      if (
        override === undefined &&
        deferSpeechDelivery(background ? "background" : "start")
      ) {
        return;
      }

      const finalMessage = (override ?? draftControls.getDraft()).trimEnd();

      let submissionFiles = pendingFilesRef.current;
      const submissionUploads = new Map(pendingStagedUploadsRef.current);
      const plan = planNewSessionStart({
        finalMessage,
        submissionFileCount: submissionFiles.length,
        pendingFileCount: pendingFiles.length,
        speechPrefix: resolveDeliverySpeechPrefix({
          configuredPrefix: speechMessagePrefix,
          speechTriggered,
          recentSpeech: isRecentSpeechAttribution(),
        }),
        propagateFailure,
        routedSourceKey: routerSelection ? routerSelection.sourceKey : null,
        sourceKey: clientSummarySourceKey,
        routerCapable: serverHasCapability(
          versionInfo,
          SERVER_CAPABILITIES.agentAuthRouter.name,
        ),
        launchLimited: launchLock.limited,
        effectiveSandboxLevel,
        hasLaunch: Boolean(launch),
        composerMuted,
        creatingTemplateProject,
        templateProjectBusy,
        isStarting,
        displayDefaultsPending,
        hasSelectedProviderModel,
        projectPending,
        serverCapabilitiesPending,
        selectedProvider,
        version: versionInfo,
      });
      if (plan.kind === "refuse") {
        showToast(t(plan.toastKey), "error");
        return;
      }
      if (plan.kind === "silent") {
        if (plan.throwCannotStart) {
          throw new Error(t("composerMemoCannotStart"));
        }
        return;
      }
      const trimmedMessage = plan.text;
      const messageMetadata = plan.metadata;
      const trimmedProjectInput = normalizeProjectInput(projectInput);
      const actionAtMs = Date.now();
      const clientTimestamp = getServerClockTimestamp(actionAtMs);

      const fullAdmission = serverHasCapability(
        versionInfo,
        SERVER_CAPABILITIES.sessionCreationAdmission.name,
      );
      let stagedCreationRefs = submissionFiles
        .filter(isPendingStagedFile)
        .map(toPersistedStagedAttachmentRef);
      const durableText =
        !launch &&
        principalResolved &&
        supportsSessionCreation(versionInfo, {
          provider: selectedProvider,
          limited: launchLock.limited,
          sandbox: effectiveSandboxLevel,
          machineControl: machineControlSelected,
          command: plan.hasCommand,
          fileCount: submissionFiles.length,
          stagedCount: stagedCreationRefs.length,
        }) &&
        (Boolean(trimmedMessage.trim()) || submissionFiles.length > 0);
      let capturedAttachmentState = JSON.stringify(
        draftControls.getAttachmentState(),
      );
      let capturedSubmission = durableText
        ? draftControls.captureSubmission?.()
        : undefined;
      setAcceptingText(durableText);
      setInterimTranscript("");
      consumeSpeechAttribution();
      setIsStarting(true);
      if (historyScope)
        void rememberComposerPrompt(historyScope, finalMessage).catch((cause) =>
          showToast(
            t("composerHistorySaveError", { error: String(cause) }),
            "error",
          ),
        );

      try {
        let resolvedProjectId =
          await resolveProjectIdForSubmission(trimmedProjectInput);
        if (!resolvedProjectId && !canCreateDetached) {
          throw new Error("Choose a project to start a session.");
        }

        const sessionMode = effectivePermissionMode;

        // Get model and thinking settings
        const thinking = toThinkingOption(
          effectiveThinkingMode,
          effectiveEffortLevel,
        );
        const effectiveRecapMode = resolveRecapMode(
          selectedProviderInfo,
          selectedRecapMode,
        );
        const effectivePromptSuggestionMode = resolvePromptSuggestionMode(
          selectedProviderInfo,
          selectedPromptSuggestionMode,
        );
        // Display preference for thinking rows; sent for compatibility while the
        // server requests provider summaries independently.
        const showThinking = getShowThinkingSetting();
        const creationProvenance = getUiCreationProvenance(versionInfo);
        const sessionOptions = buildNewSessionStartOptions({
          creationProvenance,
          supportsInstalledMachineControl,
          machineControlSelected,
          machineControlEligible,
          mode: sessionMode,
          routed: routerSelection,
          routedModel,
          selectedModel,
          routerCapable: serverHasCapability(
            versionInfo,
            SERVER_CAPABILITIES.agentAuthRouter.name,
          ),
          routerAccountId,
          routerPolicy,
          routerClaudeAiConnectors,
          routerThinking,
          thinking,
          showThinking,
          effectiveServiceTier,
          selectedProvider,
          supportsSessionSandboxing,
          effectiveSandboxLevel,
          effectiveSandboxNetworkFirewall,
          recapMode: effectiveRecapMode,
          recapAfterSeconds,
          promptSuggestionMode: effectivePromptSuggestionMode,
          helperSideModel,
          launchLock,
        });
        logSessionUiTrace("new-session-submit", {
          projectId: resolvedProjectId ?? null,
          detached: !resolvedProjectId,
          mode: sessionMode,
          model: selectedModel ?? null,
          thinking,
          provider: selectedProvider ?? null,
          sandboxLevel: supportsSessionSandboxing
            ? effectiveSandboxLevel
            : null,
          sandboxNetworkFirewall: supportsSessionSandboxing
            ? effectiveSandboxNetworkFirewall
            : null,
          recapMode: effectiveRecapMode,
          recapAfterSeconds,
          promptSuggestionMode: effectivePromptSuggestionMode,
          helperSideModel,
          textLength: trimmedMessage.length,
          pendingFileCount: pendingFiles.length,
          clientTimestamp,
          serverOffsetMs: getEstimatedServerOffsetMs(),
        });

        if (launch) {
          if (pendingFiles.length > 0) {
            throw new Error("This session launch does not accept attachments");
          }
          await launch.submit({
            message: trimmedMessage,
            options: sessionOptions,
            clientTimestamp,
          });
          draftControls.clearDraft();
          setIsStarting(false);
          return;
        }

        if (durableText) {
          if (
            fullAdmission &&
            submissionFiles.some((file) => !isPendingStagedFile(file))
          ) {
            const batchId = ensureDraftAttachmentBatchId();
            submissionFiles = await Promise.all(
              submissionFiles.map(async (file): Promise<PendingStagedFile> => {
                if (isPendingStagedFile(file)) return file;
                if (file.kind === "uploading") {
                  const result = await submissionUploads.get(file.id);
                  if (!result)
                    throw new Error(t("sessionDraftAttachmentsUnavailable"));
                  return result;
                }
                // No progress callback on this path, as before.
                const { uploadFile, uploadOptions } =
                  await prepareComposerAttachmentUpload(
                    file.file,
                    getAttachmentUploadProfile(
                      attachmentQuality,
                      selectedProviderInfo,
                      selectedModel,
                    ),
                  );
                const ref = await sourceTransport.uploadStagedAttachment(
                  uploadFile,
                  { batchId, ...uploadOptions },
                );
                const result = {
                  ...ref,
                  kind: "staged" as const,
                  ...(file.previewUrl ? { previewUrl: file.previewUrl } : {}),
                };
                if (
                  !pendingFilesRef.current.some(
                    (current) => current.id === file.id,
                  )
                )
                  throw new Error(t("sessionDraftAttachmentsUnavailable"));
                setPendingFiles((current) =>
                  current.map((item) => (item.id === file.id ? result : item)),
                );
                return result;
              }),
            );
            stagedCreationRefs = submissionFiles
              .filter(isPendingStagedFile)
              .map(toPersistedStagedAttachmentRef);
            if (
              draftControls.getDraft() === capturedSubmission?.text &&
              pendingFilesRef.current.length === submissionFiles.length &&
              pendingFilesRef.current.every(
                (file, index) => file.id === submissionFiles[index]?.id,
              )
            ) {
              capturedSubmission = draftControls.captureSubmission?.();
              capturedAttachmentState = JSON.stringify(
                draftControls.getAttachmentState(),
              );
            }
          }
          if (
            !creationViewOwner.current.active ||
            creationViewOwner.current.sourceKey !== clientSummarySourceKey ||
            creationViewOwner.current.accountKey !== principal.username
          )
            return;
          const receipt = await acceptSessionCreation(
            sourceTransport,
            `ya-text-creation:${clientSummarySourceKey}:${principal.username}:${newSessionDraftKey}`,
            resolvedProjectId ?? undefined,
            trimmedMessage,
            sessionOptions,
            clientTimestamp,
            messageMetadata,
            capturedSubmission?.text,
            stagedCreationRefs.length ? stagedCreationRefs : undefined,
            capturedAttachmentState,
            submissionFiles.map((file) => file.id),
          );
          if (
            !creationViewOwner.current.active ||
            creationViewOwner.current.sourceKey !== clientSummarySourceKey ||
            creationViewOwner.current.accountKey !== principal.username
          )
            return true;
          const unchangedFiles =
            pendingFilesRef.current.length === submissionFiles.length &&
            pendingFilesRef.current.every(
              (file, index) => file.id === submissionFiles[index]?.id,
            );
          const cleared = unchangedFiles
            ? (capturedSubmission?.confirm() ?? false)
            : false;
          if (cleared)
            setPendingFiles([], {
              persistDraft: false,
              revokeRemovedPreviewUrls: true,
            });
          if (
            cleared ||
            !unchangedFiles ||
            (capturedSubmission &&
              (draftControls.getDraft() !== capturedSubmission.text ||
                JSON.stringify(draftControls.getAttachmentState()) !==
                  capturedAttachmentState))
          )
            settleSessionCreation(
              `ya-text-creation:${clientSummarySourceKey}:${principal.username}:${newSessionDraftKey}`,
              receipt.requestId,
            );
          setIsStarting(false);
          setAcceptingText(false);
          if (background || !cleared) {
            setAcceptedCreation({
              ...receipt,
              sourceKey: clientSummarySourceKey,
              accountKey: principal.username,
              background,
            });
            if (background) textareaRef.current?.focus();
            return true;
          }
          navigate(
            `${basePath}/projects/${receipt.projectId}/sessions/${receipt.sessionId}`,
            {
              state: createSessionNavigationState({
                projectApp,
                initialTitle: trimmedMessage,
                initialProvider: selectedProvider ?? undefined,
              }),
            },
          );
          return true;
        }

        const started = await createLegacySession({
          version: versionInfo,
          api,
          projectId: resolvedProjectId ?? undefined,
          message: trimmedMessage,
          options: sessionOptions,
          clientTimestamp,
          metadata: messageMetadata,
          materialize: submissionFiles.length
            ? resolvePendingAttachmentsForSession
            : undefined,
        });
        const {
          sessionId,
          processId,
          permissionMode: initialPermissionMode,
          appliedPermissionMode: initialAppliedPermissionMode,
          modeVersion: initialModeVersion,
        } = started;
        resolvedProjectId = started.projectId;

        if (!resolvedProjectId) {
          throw new Error("Missing project ID for new session");
        }

        // Clean up preview URLs
        setPendingFiles([], {
          persistDraft: false,
          revokeRemovedPreviewUrls: true,
        });

        draftControls.clearDraft();
        // Pass initial status so SessionPage can connect SSE immediately
        // without waiting for getSession to complete
        // Also pass initial message as optimistic title (session name = first message)
        // Pass model/provider so ProviderBadge can render immediately
        navigate(
          `${basePath}/projects/${resolvedProjectId}/sessions/${sessionId}`,
          {
            state: createSessionNavigationState({
              projectApp,
              initialStatus: {
                owner: "self",
                processId,
                permissionMode: initialPermissionMode,
                appliedPermissionMode: initialAppliedPermissionMode,
                modeVersion: initialModeVersion,
                recapAfterSeconds,
              },
              initialTitle: trimmedMessage,
              initialModel: routerSelection
                ? routedModel
                : selectedModel || undefined,
              initialProvider: selectedProvider ?? undefined,
            }),
          },
        );
        return true;
      } catch (err) {
        console.error("Failed to start session:", err);
        if (capturedSubmission) capturedSubmission.cancel();
        else draftControls.restoreFromStorage();
        setIsStarting(false);
        setAcceptingText(false);

        // Show user-visible error message
        const errorMessage = newSessionStartErrorMessage(
          err,
          selectedProvider,
          selectedProviderInfo?.displayName,
          t,
        );
        showToast(errorMessage, "error");
        if (propagateFailure) throw err;
      }
    },
    [
      basePath,
      canCreateInBackground,
      newSessionDraftKey,
      principal.username,
      principalResolved,
      sourceTransport,
      draftControls,
      routerSelection,
      routedModel,
      routerAccountId,
      routerPolicy,
      routerClaudeAiConnectors,
      routerThinking,
      clientSummarySourceKey,
      supportsInstalledMachineControl,
      machineControlSelected,
      machineControlEligible,
      creatingTemplateProject,
      templateProjectBusy,
      historyScope,
      effectiveEffortLevel,
      effectivePermissionMode,
      effectiveServiceTier,
      effectiveThinkingMode,
      helperSideModel,
      hasSelectedProviderModel,
      canCreateDetached,
      displayDefaultsPending,
      isStarting,
      launch,
      launchLock,
      composerMuted,
      consumeSpeechAttribution,
      deferSpeechDelivery,
      isRecentSpeechAttribution,
      navigate,
      pendingFiles,
      projectInput,
      projectApp,
      projectPending,
      serverCapabilitiesPending,
      recapAfterSeconds,
      effectiveSandboxLevel,
      effectiveSandboxNetworkFirewall,
      resolvePendingAttachmentsForSession,
      ensureDraftAttachmentBatchId,
      attachmentQuality,
      resolveProjectIdForSubmission,
      selectedModel,
      selectedPromptSuggestionMode,
      selectedProvider,
      selectedProviderInfo,
      selectedRecapMode,
      setPendingFiles,
      showToast,
      speechMessagePrefix,
      supportsSessionSandboxing,
      t,
      versionInfo,
    ],
  );

  const handleQueueProjectSession = async (messageOverride?: unknown) => {
    const refusal = projectQueueRefusalBeforeDefer({
      routed: Boolean(routerSelection),
      routerSelectionCustomized,
      machineControlSelected,
      machineControlEligible,
      creatingTemplateProject,
      templateProjectBusy,
    });
    if (refusal) {
      if (refusal.kind === "refuse") showToast(t(refusal.toastKey), "error");
      return;
    }
    const override =
      typeof messageOverride === "string" ? messageOverride : undefined;
    if (override === undefined && deferSpeechDelivery("project-queue")) {
      return;
    }

    const finalMessage = (override ?? draftControls.getDraft()).trimEnd();
    const trimmedProjectInput = normalizeProjectInput(projectInput);
    const submissionFiles = pendingFilesRef.current;
    const stagedRefs = submissionFiles
      .filter(isPendingStagedFile)
      .map(toPersistedStagedAttachmentRef);
    const planned = planNewSessionProjectQueue({
      finalMessage,
      speechPrefix: resolveDeliverySpeechPrefix({
        configuredPrefix: speechMessagePrefix,
        speechTriggered: false,
        recentSpeech: isRecentSpeechAttribution(),
      }),
      submissionFileCount: submissionFiles.length,
      stagedFileCount: stagedRefs.length,
      isStarting,
      displayDefaultsPending,
      projectPending,
      hasDirectProviderModel,
    });
    if (!planned) return;
    const trimmedMessage = planned.text;

    // Final speech can differ from the visible snapshot selected by the manual
    // Queue action. That newer draft was not submitted and must stay intact.
    const capturedSubmission =
      draftControls.getDraft().trimEnd() === finalMessage
        ? draftControls.captureSubmission?.()
        : undefined;
    const submittedFileIds = new Set(submissionFiles.map((file) => file.id));
    const stillOwnsForm = () =>
      creationViewOwner.current.active &&
      creationViewOwner.current.sourceKey === clientSummarySourceKey &&
      creationViewOwner.current.accountKey === principal.username;
    consumeSpeechAttribution();

    const actionAtMs = Date.now();
    const clientTimestamp = getServerClockTimestamp(actionAtMs);
    const submittedAt = new Date(clientTimestamp).toISOString();
    const firstStagedRef = stagedRefs[0];
    const stagedAttachments = firstStagedRef
      ? {
          batchId: firstStagedRef.batchId,
          refs: stagedRefs,
          updatedAt: new Date().toISOString(),
        }
      : undefined;

    setInterimTranscript("");
    setAcceptingText(true);
    setIsStarting(true);

    try {
      const resolvedProjectId = await resolveProjectIdForSubmission(
        trimmedProjectInput,
        stillOwnsForm,
      );
      if (!resolvedProjectId) {
        throw new Error(t("projectQueueNewSessionNeedsProject"));
      }

      const sessionMode = effectivePermissionMode;
      // Queue does not support routing. A restored preference is only for
      // immediate creation; resolve this launch against the direct catalog.
      const showThinking = getShowThinkingSetting();
      const { target, thinking } = buildProjectQueueNewSessionTarget({
        providerInfo: selectedProviderInfo,
        selectedProvider,
        selectedModel,
        selectedThinkingMode,
        selectedEffortLevel,
        selectedServiceTier,
        mode: sessionMode,
        showThinking,
        supportsSessionSandboxing,
        effectiveSandboxLevel,
        effectiveSandboxNetworkFirewall,
        launchLock,
        title: trimmedMessage,
        t,
      });

      if (!stillOwnsForm()) return;
      const response = await api.createProjectQueueItem(resolvedProjectId, {
        target,
        message: {
          text: trimmedMessage,
          mode: sessionMode,
          ...(stagedAttachments ? { stagedAttachments } : {}),
          metadata: {
            deliveryIntent: "deferred",
            clientTimestamp,
            composition: {
              submittedAt,
              typingEndedAt: submittedAt,
            },
          },
        },
        createdFrom: {
          client: "new-session",
        },
      });
      if (!stillOwnsForm()) return;
      sourceSummary.reportProjectQueueCollectionSnapshot(response.queue);

      logSessionUiTrace("new-session-project-queued", {
        projectId: resolvedProjectId,
        mode: sessionMode,
        model: selectedModel ?? null,
        thinking,
        provider: selectedProvider ?? null,
        sandboxLevel: supportsSessionSandboxing ? effectiveSandboxLevel : null,
        sandboxNetworkFirewall: supportsSessionSandboxing
          ? effectiveSandboxNetworkFirewall
          : null,
        textLength: trimmedMessage.length,
        attachmentCount: stagedRefs.length,
        uploadWaitMs: Date.now() - actionAtMs,
      });
      if (capturedSubmission?.confirm())
        setPendingFiles(
          (current) => current.filter((file) => !submittedFileIds.has(file.id)),
          { persistDraft: false, revokeRemovedPreviewUrls: true },
        );
      showToast(t("projectQueueNewSessionQueuedToast"), "success");
    } catch (err) {
      if (!stillOwnsForm()) return;
      console.error("Failed to queue project session:", err);
      capturedSubmission?.cancel();
      const errorMsg = err instanceof Error ? err.message : String(err);
      showToast(t("projectQueueSubmitFailed", { message: errorMsg }), "error");
    } finally {
      if (creationViewOwner.current.active) {
        setIsStarting(false);
        setAcceptingText(false);
      }
    }
  };

  runPendingSpeechDeliveryRef.current = () => {
    if (
      speechPendingRef.current !== null ||
      pendingSpeechFinalRef.current !== null
    ) {
      return;
    }
    if (!pendingSpeechDeliverySettledRef.current) return;
    const pending = pendingSpeechDeliveryRef.current;
    if (!pending) return;
    pendingSpeechDeliveryRef.current = null;
    pendingSpeechDeliverySettledRef.current = false;
    dispatchingSettledSpeechDeliveryRef.current = true;
    try {
      if (pending.kind === "project-queue") {
        void handleQueueProjectSession(pending.visibleTextSnapshot);
        return;
      }
      void handleStartSession(
        pending.visibleTextSnapshot,
        false,
        false,
        pending.kind === "background",
      );
    } finally {
      dispatchingSettledSpeechDeliveryRef.current = false;
    }
  };

  const maybeRunPendingSpeechDelivery = useCallback(() => {
    runPendingSpeechDeliveryRef.current();
  }, []);

  const handleKeyDown = (e: KeyboardEvent) => {
    // A held dismissal key must never fall through to cancelling a
    // transcription, as in the session composer.
    if (e.key === "Escape" && e.repeat) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (
      e.key === "Enter" &&
      e.metaKey &&
      !e.ctrlKey &&
      !e.shiftKey &&
      !e.altKey &&
      !e.nativeEvent.isComposing &&
      canCreateInBackground
    ) {
      e.preventDefault();
      void handleStartSession(undefined, false, false, true);
      return;
    }
    if (fileCompletion.onKeyDown(e)) return;
    if (isFullPaneComposerShortcut(e)) {
      e.preventDefault();
      e.stopPropagation();
      toggleFullPane();
      return;
    }

    if (fullPane && e.key === "Enter") {
      if (e.nativeEvent.isComposing) return;
      if (e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        handleStartSession();
      }
      return;
    }

    if (
      handleSpeechEscapeKey(e, {
        speechPending,
        voice: voiceButtonRef.current,
        cancelTranscription: handleCancelTranscription,
      })
    ) {
      return;
    }

    if (e.key === "Enter") {
      // Skip Enter during IME composition (e.g. Chinese/Japanese/Korean input)
      if (e.nativeEvent.isComposing) return;

      // The Ctrl+Enter shortcut runs before "listening, so start", as the
      // session composer orders its Ctrl+Enter actions.
      if (
        projectQueueCtrlEnterEnabled &&
        toolbarVisibility.projectQueue &&
        showProjectQueueAction &&
        canQueueProjectSession &&
        e.ctrlKey &&
        !e.metaKey &&
        !e.shiftKey &&
        !e.altKey
      ) {
        e.preventDefault();
        void handleQueueProjectSession();
        return;
      }

      // If voice recording is active, Enter submits (on any device)
      if (voiceButtonRef.current?.isListening) {
        e.preventDefault();
        handleStartSession();
        return;
      }

      if (isComposerEnterSend(e)) {
        e.preventDefault();
        handleStartSession();
      }
    }
  };

  const handlePaste = (e: ClipboardEvent) => {
    const files = getClipboardFiles(e);
    if (files.length > 0) {
      e.preventDefault();
      addPendingFiles(files);
    }
  };

  // Voice input handlers
  const handleSmartTurnSend = useCallback(
    (text: string) => {
      // A deliberate background/Queue action already owns delivery.
      // Let finalization settle it instead of starting a second,
      // foreground submission from the transcription's spoken command.
      if (
        pendingSpeechDeliveryRef.current?.kind === "background" ||
        pendingSpeechDeliveryRef.current?.kind === "project-queue"
      )
        return false;
      // As in the session composer, a send that cannot start is not
      // accepted, and only an accepted send arms follow-up listening.
      // A muted launch composer starts without a draft of its own.
      if (
        (!hasComposerDraftContent(text, pendingFilesRef.current.length) &&
          !composerMuted) ||
        isStarting
      )
        return false;
      void handleStartSession(text, true);
      voiceButtonRef.current?.continueAfterSpeechSend();
      return true;
    },
    [composerMuted, handleStartSession, isStarting],
  );
  // The draft never leaves the field here (plan 178 D3), so a failed or
  // cancelled cycle only drops the pending delivery.
  const dropPendingSpeechDelivery = useCallback(() => {
    pendingSpeechDeliveryRef.current = null;
    pendingSpeechDeliverySettledRef.current = false;
  }, []);
  const {
    handleListeningStart,
    handleSpeechSelectionTarget,
    clearSpeechSelectionTarget,
    handleVoiceTranscript,
    handleListeningStop,
    handleInterimTranscript,
    handlePendingSpeechChange,
    handleTranscriptionSettled,
    handleCancelTranscription,
  } = useComposerSpeechHandlers({
    speechState,
    draftControls,
    textareaRef,
    voiceButtonRef,
    pendingSpeechDeliveryRef,
    pendingSpeechDeliverySettledRef,
    noteSpeechAttribution,
    maybeRunPendingSpeechDelivery,
    abandonPendingDelivery: dropPendingSpeechDelivery,
    onSmartTurnSend: handleSmartTurnSend,
  });
  // Select, pointer-up and key-up are manual caret moves, as in the session
  // composer (plan 178 D1, D10).
  const handleManualSpeechSelection = useCallback(
    () => handleSpeechSelectionTarget(true),
    [handleSpeechSelectionTarget],
  );

  useEffect(() => clearPendingSpeechFinal, []);

  const handleSpeechSelectionClick = useCallback(() => {
    window.setTimeout(() => handleSpeechSelectionTarget(true), 0);
  }, [handleSpeechSelectionTarget]);

  const handleComposerKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      handleVoiceInputShortcutKeyDown(event, () => {
        const voice = voiceButtonRef.current;
        if (voice?.isAvailable) voice.toggle();
      });
    },
    [],
  );

  const hasContent =
    message.trim() ||
    pendingFiles.length > 0 ||
    speechPending !== null ||
    interimTranscript;
  const canStart = Boolean(
    (hasContent || composerMuted) &&
      !displayDefaultsPending &&
      hasSelectedProviderModel &&
      !projectPending &&
      !serverCapabilitiesPending &&
      (!isDetachedProject || canCreateDetached),
  );
  const hasProjectQueueTargetProject = Boolean(projectQueueTargetProjectId);
  const pendingFilesReadyForProjectQueue =
    pendingFiles.every(isPendingStagedFile);
  const stagedPendingFileRefs = pendingFiles
    .filter(isPendingStagedFile)
    .map(toPersistedStagedAttachmentRef);
  const attachmentNavigationGuardActive = hasAttachmentNavigationRisk({
    pendingUploadCount: pendingFiles.filter((file) => file.kind === "uploading")
      .length,
    transientAttachmentCount: pendingFiles.filter(isPendingLocalFile).length,
    stagedRefs: stagedPendingFileRefs,
    draftState: draftControls.getAttachmentState(),
  });
  useAttachmentNavigationGuard(attachmentNavigationGuardActive);
  const canQueueProjectSession = Boolean(
    allowProjectQueue &&
      !projectPending &&
      !displayDefaultsPending &&
      !(machineControlSelected && machineControlEligible) &&
      showProjectQueueAction &&
      (message.trim() || speechPending !== null || interimTranscript) &&
      pendingFilesReadyForProjectQueue &&
      hasProjectQueueTargetProject &&
      hasDirectProviderModel,
  );
  const projectQueueNewSessionTitle =
    machineControlSelected && machineControlEligible
      ? t("machineControlImmediateLaunchOnly")
      : !pendingFilesReadyForProjectQueue
        ? t("projectQueueNewSessionAttachmentsPreparing")
        : hasProjectQueueTargetProject
          ? projectQueueCtrlEnterEnabled
            ? t("toolbarProjectQueueTooltipWithShortcut")
            : t("toolbarProjectQueueTooltip")
          : t("projectQueueNewSessionNeedsProject");
  const manualDeliverySpeechPrefix =
    speechMessagePrefix &&
    asrAttributionMs > 0 &&
    (speechAttributionActive ||
      ((speechPending !== null || pendingSpeechDeliveryRef.current !== null) &&
        (speechTransactionHasTextRef.current ||
          interimTranscript.trim().length > 0)))
      ? speechMessagePrefix
      : null;
  const describePrefixedDelivery = (action: string) =>
    manualDeliverySpeechPrefix
      ? t("speechPrefixDeliveryLabel", {
          action,
          prefix: manualDeliverySpeechPrefix,
        })
      : action;
  const describePrefixedTooltip = (tooltip: string) =>
    manualDeliverySpeechPrefix
      ? t("speechPrefixDeliveryTooltip", {
          tooltip,
          prefix: manualDeliverySpeechPrefix,
        })
      : tooltip;
  // Only mutable provisional speech uses the textarea mirror. Capture and
  // post-capture status live with the mic so the real draft and caret stay
  // untouched while transcription is pending.
  const { interimDisplayTranscript, interimInsertion } =
    getSpeechInterimPreview(
      message,
      interimTranscript,
      speechInsertionRangeRef.current,
    );

  const getTranscriptionContext =
    useCallback((): SpeechTranscriptionContext => {
      const draft = draftControls.getDraft();
      if (!speechTurnIdRef.current) {
        speechTurnIdRef.current = createClientSpeechTurnId();
      }
      return {
        projectId,
        draftKey: newSessionDraftKey,
        clientTurnId: speechTurnIdRef.current,
        speechTargetId: activeSpeechTargetIdRef.current ?? undefined,
        textBeforeCursor: textBeforeSpeechCursor(
          draft,
          speechInsertionRangeRef.current,
          textareaRef.current,
        ),
      };
    }, [draftControls, projectId, newSessionDraftKey]);
  // Shared input area with toolbar (textarea + attach/voice on left, send on right)
  const inputArea = audioMemoOpen ? (
    <AudioMemoPanel
      projectId={projectId}
      commitLabel={t("composerMemoStart")}
      onCancel={() => {
        setPendingFiles((previous) =>
          previous.filter((item) => item.id !== memoPendingIdRef.current),
        );
        memoPendingIdRef.current = null;
        setAudioMemoOpen(false);
      }}
      onCommit={async (file, transcript) => {
        if (
          !pendingFilesRef.current.some(
            (item) => item.kind === "local" && item.file === file,
          )
        ) {
          const previousMemoId = memoPendingIdRef.current;
          const id = `memo-${generateUUID()}`;
          memoPendingIdRef.current = id;
          setPendingFiles((previous) => [
            ...previous.filter((item) => item.id !== previousMemoId),
            { kind: "local", id, file },
          ]);
        }
        const suffix = transcript.trim()
          ? `🎤 ${t("audioMemoTranscriptSuffix")}\n${transcript.trim()}`
          : "";
        const text =
          [draftControls.getDraft().trimEnd(), suffix]
            .filter(Boolean)
            .join("\n\n") || `🎤 ${t("audioMemoTitle")}`;
        if (!(await handleStartSession(text, false, true)))
          throw new Error(t("composerMemoCannotStart"));
      }}
    />
  ) : (
    <>
      <DraftSyncNotice draftKey={newSessionDraftKey} />
      <ComposerRecents
        newSession
        onMemo={
          allowAttachments && !composerMuted && !speechPending
            ? () => setAudioMemoOpen(true)
            : undefined
        }
        disabled={isStarting}
        scope={historyScope}
        onFiles={addPendingFiles}
        uploadsOpen={recentUploadsOpen}
        onUploadsClose={() => setRecentUploadsOpen(false)}
        onBrowse={() => fileInputRef.current?.click()}
      />
      <PromptHistoryRail
        scope={historyScope}
        textareaRef={textareaRef}
        onChange={setMessage}
      >
        <SpeechDraftField
          interimDisplayTranscript={interimDisplayTranscript}
          interimInsertion={interimInsertion}
          interimTranscript={interimTranscript}
        >
          <textarea
            data-draft-key={newSessionDraftKey}
            ref={attachComposerTextarea}
            data-composer-input
            value={message}
            onChange={(e) => {
              const nextMessage = fileCompletion.normalizeInput(e.target.value);
              noteSpeechDraftEdit(message, nextMessage);
              handleSpeechSelectionTarget(true, nextMessage);
              setMessage(nextMessage);
            }}
            onKeyDown={handleKeyDown}
            onFocus={fileCompletion.onFocus}
            onBlur={fileCompletion.onBlur}
            onSelect={() => {
              handleManualSpeechSelection();
              fileCompletion.onSelect();
            }}
            onPointerUp={handleManualSpeechSelection}
            onClick={handleSpeechSelectionClick}
            onKeyUp={handleManualSpeechSelection}
            onCut={clearSpeechSelectionTarget}
            onCopy={clearSpeechSelectionTarget}
            onPaste={(event) => {
              clearSpeechSelectionTarget();
              if (allowAttachments) {
                handlePaste(event);
              }
            }}
            placeholder={resolvedPlaceholder}
            disabled={isStarting && !acceptingText}
            // Read-only rather than disabled: the draft stays selectable and
            // scrollable so it can still be read, just not sent.
            readOnly={composerMuted}
            rows={composerMuted ? Math.min(rows, 3) : rows}
            className="new-session-form-textarea"
          />
        </SpeechDraftField>
        <ProjectFileCompletionMenu completion={fileCompletion} />
        <div className="new-session-form-toolbar">
          <div className="new-session-form-toolbar-left">
            {allowAttachments && (
              <>
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  style={{ display: "none" }}
                  onChange={handleFileSelect}
                />
                <button
                  type="button"
                  className="toolbar-button"
                  onClick={(event) => {
                    if (attachGesture.current.swiped) {
                      attachGesture.current.swiped = false;
                      return;
                    }
                    if (event.shiftKey && !composerMuted && !speechPending) {
                      setAudioMemoOpen(true);
                      return;
                    }
                    fileInputRef.current?.click();
                  }}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    setRecentUploadsOpen(true);
                  }}
                  onTouchStart={(event) => {
                    attachGesture.current = {
                      y: event.touches[0]?.clientY ?? 0,
                      swiped: false,
                    };
                  }}
                  onTouchEnd={(event) => {
                    if (
                      (event.changedTouches[0]?.clientY ?? 0) -
                        attachGesture.current.y >
                      25
                    ) {
                      attachGesture.current.swiped = true;
                      setRecentUploadsOpen(true);
                    }
                  }}
                  title={t("composerAttachTooltip")}
                  disabled={isStarting}
                  aria-label={t("newSessionAttachFiles")}
                >
                  <svg
                    width="18"
                    height="18"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    aria-hidden="true"
                  >
                    <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
                  </svg>
                </button>
              </>
            )}
            <SpeechControlMenu
              showMethodSelector={showSpeechMethodSelector}
              methodOptions={speechMethodOptions}
              selectedMethod={selectedSpeechMethod}
              onMethodChange={handleSpeechMethodSelect}
              smartTurnSettings={activeSpeechSmartTurnSettings}
              onSmartTurnSettingsChange={
                supportsSelectedSpeechSmartTurn
                  ? setSpeechSmartTurnSettings
                  : undefined
              }
              smartTurnDisabled={isStarting}
              onBeforeOpen={() => {
                if (voiceButtonRef.current?.isListening) {
                  voiceButtonRef.current.toggle();
                }
              }}
              onBeforeCaptureChange={() => {
                if (voiceButtonRef.current?.isListening) {
                  voiceButtonRef.current.toggle();
                }
              }}
              onPointerNearTrigger={() => voiceButtonRef.current?.prewarm?.()}
              trigger={
                <VoiceInputButton
                  ref={sharedVoiceRef}
                  onTranscript={handleVoiceTranscript}
                  onInterimTranscript={handleInterimTranscript}
                  onListeningStart={handleListeningStart}
                  onListeningStop={handleListeningStop}
                  onPendingSpeechChange={handlePendingSpeechChange}
                  onTranscriptionSettled={handleTranscriptionSettled}
                  disabled={isStarting}
                  className="toolbar-button"
                  speechMethod={selectedSpeechMethod}
                  getTranscriptionContext={getTranscriptionContext}
                  smartTurn={activeSpeechSmartTurnSettings}
                />
              }
            />
            {!compact && !composerMuted && (
              <FullPaneComposerToggle
                expanded={fullPane}
                className={`toolbar-button ${styles.fullPaneToggle}`}
                onToggle={() => {
                  toggleFullPane();
                  textareaRef.current?.focus();
                }}
              />
            )}
          </div>
          <div
            className={`new-session-form-toolbar-actions ${styles.toolbarActions}`}
          >
            {canCreateInBackground && toolbarVisibility.shortcutsHelp && (
              <details
                className={styles.shortcutsHelp}
                onBlur={(event) => {
                  if (!event.currentTarget.contains(event.relatedTarget))
                    event.currentTarget.open = false;
                }}
              >
                <summary
                  role="button"
                  className={styles.shortcutsTrigger}
                  aria-label={t("newSessionKeyboardShortcuts")}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") {
                      event.preventDefault();
                      const details = event.currentTarget
                        .parentElement as HTMLDetailsElement;
                      details.open = false;
                    }
                  }}
                >
                  <span className={styles.shortcutsQuestion}>?</span>
                </summary>
                <div className={styles.shortcutsPopover}>
                  <strong>{t("newSessionKeyboardShortcuts")}</strong>
                  <div className={styles.shortcutsRow}>
                    <kbd>⌘ Enter</kbd>
                    <span>
                      {describePrefixedDelivery(
                        t("sessionCreationBackgroundAction"),
                      )}
                    </span>
                  </div>
                  {!compact && (
                    <div className={styles.shortcutsRow}>
                      <kbd>Ctrl U</kbd>
                      <span>
                        {t(
                          fullPane
                            ? "composerFullPaneRestore"
                            : "composerFullPaneExpand",
                        )}
                      </span>
                    </div>
                  )}
                </div>
              </details>
            )}
            {toolbarVisibility.projectQueue && showProjectQueueAction && (
              <button
                type="button"
                onClick={handleQueueProjectSession}
                disabled={
                  isStarting ||
                  creatingTemplateProject ||
                  templateProjectBusy ||
                  !canQueueProjectSession
                }
                className="send-button project-queue-button new-session-project-queue-button"
                aria-label={describePrefixedDelivery(
                  t("toolbarProjectQueueLabel"),
                )}
                title={describePrefixedTooltip(projectQueueNewSessionTitle)}
              >
                <DeliveryGlyph className="send-icon">⇥</DeliveryGlyph>
                {manualDeliverySpeechPrefix && (
                  <SpeechPrefixActionCue prefix={manualDeliverySpeechPrefix} />
                )}
              </button>
            )}
            <button
              type="button"
              onClick={handleStartSession}
              disabled={
                isStarting ||
                creatingTemplateProject ||
                templateProjectBusy ||
                !canStart
              }
              className="send-button new-session-submit-button"
              aria-label={describePrefixedDelivery(
                launch?.startLabel ?? t(startActionKey),
              )}
              title={describePrefixedTooltip(
                launch?.startLabel ?? t(startActionKey),
              )}
            >
              {isStarting ? (
                <span className="send-spinner" />
              ) : (
                <svg
                  className="send-icon new-session-submit-icon"
                  width="20"
                  height="20"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.25"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M12 19V5" />
                  <path d="m5 12 7-7 7 7" />
                </svg>
              )}
              {!isStarting && manualDeliverySpeechPrefix && (
                <SpeechPrefixActionCue prefix={manualDeliverySpeechPrefix} />
              )}
            </button>
          </div>
        </div>
        {pendingFiles.length > 0 && (
          <div className={styles.pendingFilesList}>
            {pendingFiles.map((pf) => {
              const progress = uploadProgress[pf.id];
              const fileName = getPendingFileName(pf);
              const fileSize = getPendingFileSize(pf);
              const imageSize = getPendingFileImageDimensions(pf);
              return (
                <AttachmentChip
                  key={pf.id}
                  attachmentId={pf.id}
                  originalName={fileName}
                  mimeType={getPendingFileMimeType(pf)}
                  sizeLabel={
                    progress
                      ? `${Math.round((progress.uploaded / progress.total) * 100)}%`
                      : formatFileSize(fileSize)
                  }
                  imageWidth={imageSize?.width}
                  imageHeight={imageSize?.height}
                  previewUrl={pf.previewUrl}
                  onRemove={
                    isStarting ? undefined : () => handleRemoveFile(pf.id)
                  }
                />
              );
            })}
          </div>
        )}
      </PromptHistoryRail>
    </>
  );

  const projectChooser = (
    <div
      ref={projectChooserRef}
      className={`new-session-project-chooser ${isProjectChooserExpanded ? "expanded" : ""}`}
    >
      {/* The suggestion list drops below the search, not below New project. */}
      <div className={styles.projectSearchAnchor}>
        <div className="new-session-project-controls">
          <button
            type="button"
            className="new-session-project-summary"
            onClick={() => setIsProjectChooserExpanded((prev) => !prev)}
            aria-expanded={isProjectChooserExpanded}
            aria-controls="new-session-project-panel"
          >
            <span className="new-session-project-summary-body">
              <span className="new-session-project-summary-title">
                {projectSummaryTitle}
              </span>
              <span
                className="new-session-project-summary-path"
                title={projectSummaryMeta}
              >
                {isDetachedProject ? (
                  <>
                    <span className="new-session-project-summary-path-long">
                      {t("newSessionProjectDetachedHint")}
                    </span>
                    <span className="new-session-project-summary-path-short">
                      {t("newSessionProjectDetachedHintShort")}
                    </span>
                  </>
                ) : (
                  displayedProjectSummaryMeta
                )}
              </span>
            </span>
            <svg
              className="new-session-project-summary-chevron"
              width="16"
              height="16"
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

          <label className="new-session-project-inline-field">
            <span className="new-session-project-inline-label">
              {t("newSessionProjectPathLabel")}
            </span>
            <input
              ref={projectInputRef}
              type="text"
              // The open New project panel replaces the selection, so the
              // search starts empty; typing here returns to searching.
              value={newProjectOpen ? "" : projectInput}
              onChange={(e) => {
                setNewProjectOpen(false);
                setProjectInput(e.target.value);
                if (!isProjectChooserExpanded) {
                  setIsProjectChooserExpanded(true);
                }
              }}
              onFocus={() => setIsProjectChooserExpanded(true)}
              onKeyDown={handleProjectInputKeyDown}
              placeholder={t("newSessionProjectPathPlaceholder")}
              disabled={isStarting}
              className="new-session-project-input"
              spellCheck={false}
              list="new-session-project-options"
            />
          </label>
          <datalist id="new-session-project-options">
            {projectSuggestionOptions}
          </datalist>
        </div>

        {projectPending && projectSnapshotPending && (
          <p className="new-session-project-empty" role="status">
            {t("newSessionProjectRefreshing")}
          </p>
        )}

        {!launch && !fixedProject && (
          <div className={templateStyles.expansion}>
            <button
              type="button"
              aria-expanded={newProjectOpen}
              aria-controls="new-session-new-project"
              className={templateStyles.secondary}
              disabled={templateProjectBusy || isStarting}
              onClick={toggleNewProject}
            >
              {t("templateNewProject")}
            </button>
          </div>
        )}
        {/* Shown over an open New project too: choosing a project closes it. */}
        {isProjectChooserExpanded && projectPanelRows && (
          <div
            id="new-session-project-panel"
            className="new-session-project-panel"
          >
            <p className="new-session-project-field-hint">
              {t("newSessionProjectPathHint")}
            </p>

            <div className="new-session-project-suggestions">
              {projectPanelRows}
            </div>
          </div>
        )}
      </div>
    </div>
  );
  // A grid row of its own, below both the composer and the project column, so
  // the palette spreads across the page width instead of stretching the
  // narrow project column (and never sits under the project list).
  const newProjectSection = newProjectPanelShown ? (
    <section
      id="new-session-new-project"
      className={styles.newProject}
      aria-label={t("templateNewProject")}
    >
      {newProjectOpen ? (
        <label className={styles.newProjectField}>
          <span>{t("newProjectEntryLabel")}</span>
          <input
            type="text"
            value={newProjectEntry}
            onChange={(event) => setNewProjectEntry(event.target.value)}
            placeholder={t("newProjectEntryPlaceholder")}
            disabled={isStarting || templateProjectBusy}
            spellCheck={false}
            ref={newProjectEntryRef}
          />
        </label>
      ) : null}
      <p className={styles.newProjectTarget}>
        {newProjectTarget?.path
          ? t(
              newProjectFolderState === "contents"
                ? "newProjectExistingFolder"
                : newProjectFolderState === "empty"
                  ? "newProjectEmptyFolderExists"
                  : newProjectFolderState === "file"
                    ? "newProjectPathIsFile"
                    : newProjectOpen
                      ? "newProjectCreates"
                      : newProjectFolderState === "missing"
                        ? "newProjectNoFolder"
                        : "newProjectFromSearch",
              { path: shortenPath(newProjectTarget.path) },
            )
          : t("newProjectNeedsName")}
      </p>
      {newProjectOffersStart && (
        <>
          <ProjectStartPalette
            name="new-session-project-start"
            legend={t("newProjectStartFrom")}
            disabled={isStarting || templateProjectBusy}
            choices={[
              {
                key: EMPTY_FOLDER_CHOICE,
                title: t("newProjectEmptyFolder"),
                description: t("newProjectEmptyFolderHint"),
              },
              ...newProjectTemplates.map((template) => ({
                key: templateChoiceKey(template),
                title: template.title,
                description: template.description,
                icon: template.icon,
              })),
            ]}
            selected={
              newProjectTemplate
                ? templateChoiceKey(newProjectTemplate)
                : EMPTY_FOLDER_CHOICE
            }
            onSelect={setNewProjectChoice}
          />
          {!newProjectTemplate && (
            <>
              <label className={styles.newProjectGit}>
                <input
                  type="checkbox"
                  checked={newProjectInitializesGit}
                  disabled={!projectCreationGitChoice || isStarting}
                  onChange={(event) => {
                    setNewProjectGitInit(event.target.checked);
                    localStorage.setItem(
                      UI_KEYS.newProjectGitInit,
                      String(event.target.checked),
                    );
                  }}
                />
                {t("newProjectGitInit")}
              </label>
              {newProjectTarget?.path && (
                <p className={styles.newProjectPlan}>
                  {t(
                    newProjectInitializesGit
                      ? "newProjectPlanGit"
                      : "newProjectPlan",
                  )}
                </p>
              )}
            </>
          )}
        </>
      )}
    </section>
  ) : null;
  // Withholding every picker in this slot would otherwise leave its grid area
  // empty rather than giving the width back, so the layout drops the area.
  // The provider and model sections always render (each falls back to a
  // placeholder), and the effort slot renders unless thinking controls are
  // withheld and the effort is locked.
  const providerSlotFilled =
    launchLock.limited ||
    showProviderPicker ||
    showModelPicker ||
    showThinkingControls ||
    !launchLock.effort;
  const creationRecovery = (
    <>
      {acceptedCreation &&
        acceptedCreation.sourceKey === clientSummarySourceKey &&
        acceptedCreation.accountKey === principal.username && (
          <div role="status" className={styles.creationRecovery}>
            <span>
              {t(
                acceptedCreation.background
                  ? "sessionCreationBackgroundSaved"
                  : "sessionCreationNewerDraft",
              )}
            </span>
            <button
              type="button"
              onClick={() =>
                navigate(
                  `${basePath}/projects/${acceptedCreation.projectId}/sessions/${acceptedCreation.sessionId}`,
                )
              }
            >
              {t("sessionCreationOpenSaved")}
            </button>
          </div>
        )}
      {pendingCreation && (
        <div role="status" className={styles.creationRecovery}>
          <span>
            {t(
              pendingCreation.receipt
                ? "sessionCreationSavedWhileAway"
                : "sessionCreationUnconfirmedRequest",
            )}
          </span>
          <button
            type="button"
            onClick={async () => {
              const key = `ya-text-creation:${clientSummarySourceKey}:${principal.username}:${newSessionDraftKey}`;
              const pending = pendingSessionCreation(key);
              if (!pending) return;
              try {
                const receipt = await getSessionCreation(
                  sourceTransport,
                  pending.requestId,
                );
                if (
                  !creationViewOwner.current.active ||
                  creationViewOwner.current.sourceKey !==
                    clientSummarySourceKey ||
                  creationViewOwner.current.accountKey !== principal.username
                )
                  return;
                const cleared =
                  pending.draftText !== undefined &&
                  pendingFilesRef.current.map((file) => file.id).join("\0") ===
                    (pending.draftFileIds ?? []).join("\0") &&
                  draftControls.getDraft() === pending.draftText &&
                  JSON.stringify(draftControls.getAttachmentState()) ===
                    (pending.draftAttachments ?? "null")
                    ? draftControls.captureSubmission?.().confirm()
                    : false;
                if (
                  cleared ||
                  pendingFilesRef.current.map((file) => file.id).join("\0") !==
                    (pending.draftFileIds ?? []).join("\0") ||
                  (pending.draftText !== undefined &&
                    (draftControls.getDraft() !== pending.draftText ||
                      JSON.stringify(draftControls.getAttachmentState()) !==
                        (pending.draftAttachments ?? "null")))
                )
                  settleSessionCreation(key, receipt.requestId);
                navigate(
                  `${basePath}/projects/${receipt.projectId}/sessions/${receipt.sessionId}`,
                );
              } catch {
                showToast(t("sessionCreationStillUnconfirmed"), "error");
              }
            }}
          >
            {t("sessionCreationCheckSaved")}
          </button>
        </div>
      )}
    </>
  );

  const displayDefaultsError =
    displayDefaultsPending && settingsError ? (
      <div role="alert" className={styles.catalogStatus}>
        <span>{t("newSessionDefaultsUnavailable")}</span>
        <button
          type="button"
          className={styles.catalogAction}
          onClick={() => void refetchSettings()}
          disabled={settingsLoading}
        >
          {t("newSessionDefaultsRetry")}
        </button>
      </div>
    ) : null;

  // Compact mode: just the input area, no header or mode selector
  if (compact) {
    return (
      <FileDropZone
        enabled={allowAttachments && !composerMuted && !isStarting}
        onFiles={addPendingFiles}
        ownerKey={`${clientSummarySourceKey}:${principal.username}:${newSessionDraftKey}`}
        newSession
        className="new-session-form new-session-form-compact"
        onKeyDownCapture={handleComposerKeyDown}
      >
        {creationRecovery}
        {displayDefaultsError}
        {inputArea}
      </FileDropZone>
    );
  }

  // Full mode: form with header, input area, and mode selector
  return (
    <FileDropZone
      enabled={allowAttachments && !composerMuted && !isStarting}
      onFiles={addPendingFiles}
      ownerKey={`${clientSummarySourceKey}:${principal.username}:${newSessionDraftKey}`}
      newSession
      className={`new-session-form new-session-container${
        fullPane ? ` ${styles.fullPane}` : ""
      }${fullPaneWide ? ` ${styles.fullPaneWide}` : ""}`}
      data-composer-full-pane={fullPane ? "true" : undefined}
      onKeyDownCapture={handleComposerKeyDown}
      style={
        fullPane && !fullPaneWide && fullPaneBaseWidth
          ? { width: `${fullPaneBaseWidth}px`, maxWidth: "100%" }
          : undefined
      }
    >
      {/* A launch is introduced by its own surface — the handoff dialog has a
          title — so the new-session prompt would only contradict it. */}
      {!launch && (
        <div className="new-session-header">
          <p className="new-session-subtitle">
            {t("newSessionHeaderSubtitle")}
          </p>
        </div>
      )}

      {creationRecovery}
      {displayDefaultsError}

      <div
        className={`new-session-top-layout ${styles.optionLayout}${
          fixedProject ? ` ${styles.optionLayoutWithoutProject}` : ""
        }${providerSlotFilled ? "" : ` ${styles.optionLayoutWithoutProvider}`}`}
      >
        <div ref={mainStackRef} className="new-session-main-stack">
          <div
            className={`new-session-input-area${
              composerMuted ? ` ${styles.mutedComposer}` : ""
            }`}
            data-composer-shell="true"
          >
            {inputArea}
          </div>
        </div>
        {!fixedProject && (
          <aside
            className={`new-session-project-slot ${styles.projectControlsSlot}`}
          >
            {projectChooser}
            {!launch && projectQueueTargetProjectId && (
              <NewSessionProjectQueue
                items={selectedProjectQueueItems}
                loading={projectQueues.loading}
                error={projectQueues.error}
                onOpenItem={(itemId) =>
                  navigate(
                    `${basePath}/projects?queueItem=${encodeURIComponent(itemId)}`,
                  )
                }
              />
            )}
          </aside>
        )}
        {newProjectSection}
        {templateChoices?.enabled && !launch && !fixedProject && (
          <div
            className={styles.templateProjectSlot}
            hidden={!creatingTemplateProject && !templateProjectBusy}
          >
            <TemplateProjectForm
              key={clientSummarySourceKey}
              templates={templateChoices.templates}
              emptyMessage={templateError ?? t(emptyMessageKey)}
              projects={projects}
              pathBase={newProjectBase}
              chosen={
                newProjectTemplate && {
                  template: newProjectTemplate,
                  name: newProjectTarget
                    ? projectNameForEntry(newProjectTarget)
                    : "",
                  path: newProjectTarget?.path ?? "",
                }
              }
              onRecovered={handleTemplateRecovered}
              intent={message}
              onBusyChange={handleTemplateBusyChange}
              stagedAttachments={
                stagedPendingFileRefs[0]
                  ? {
                      batchId: stagedPendingFileRefs[0].batchId,
                      refs: stagedPendingFileRefs,
                    }
                  : undefined
              }
              disabledReason={
                pendingFiles.length > 0 &&
                !serverHasCapability(
                  versionInfo,
                  SERVER_CAPABILITIES.templatePreparationAttachments.name,
                )
                  ? t("templateAttachmentsUnsupported")
                  : !pendingFilesReadyForProjectQueue
                    ? t("projectQueueNewSessionAttachmentsPreparing")
                    : !hasSelectedProviderModel
                      ? t("templateSelectProvider")
                      : undefined
              }
              sessionSettings={{
                mode: effectivePermissionMode,
                provider: selectedProvider ?? undefined,
                model: selectedModel ?? undefined,
                thinking: toThinkingOption(
                  effectiveThinkingMode,
                  effectiveEffortLevel,
                ),
                showThinking: getShowThinkingSetting(),
                sandboxLevel: effectiveSandboxLevel,
                sandboxNetworkFirewall: effectiveSandboxNetworkFirewall,
                recapMode: resolveRecapMode(
                  selectedProviderInfo,
                  selectedRecapMode,
                ),
                recapAfterSeconds,
                promptSuggestionMode: resolvePromptSuggestionMode(
                  selectedProviderInfo,
                  selectedPromptSuggestionMode,
                ),
                helperSideModel,
              }}
              onStarted={(createdProjectId, sessionId) => {
                if (historyScope)
                  void rememberComposerPrompt(historyScope, message).catch(
                    (cause) =>
                      showToast(
                        t("composerHistorySaveError", { error: String(cause) }),
                        "error",
                      ),
                  );
                draftControls.clearDraft();
                navigate(
                  `${basePath}/projects/${createdProjectId}/sessions/${sessionId}`,
                );
              }}
            />
          </div>
        )}
        <NewSessionOptionsPanel
          options={newSessionOptions}
          providerSlotFilled={providerSlotFilled}
          showProviderPicker={showProviderPicker}
          showModelPicker={showModelPicker}
          launchLock={launchLock}
          isStarting={isStarting}
          isProjectChooserExpanded={isProjectChooserExpanded}
          showThinking={showThinking}
          setShowThinking={setShowThinking}
          clientSummarySourceKey={clientSummarySourceKey}
          versionInfo={versionInfo}
        />
      </div>
    </FileDropZone>
  );
}
