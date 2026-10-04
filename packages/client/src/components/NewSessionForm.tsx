import { useRouterDiscovery } from "../hooks/useRouterDiscovery";
import {
  RouterPoolSelector,
  routedModels,
  routerPoolMembers,
} from "./RouterPoolSelector";
import { resolveRouterModel } from "@yep-anywhere/shared";
import type { RouterSelection } from "./RouterPoolSelector";
import { DraftSyncNotice } from "./DraftSyncNotice";
import { DRAFT_STORAGE_EVENT } from "../lib/draftSyncStorage";
import { MachineControlSessionSelection } from "./MachineControlSessionSelection";
import { useComposerVoiceRef } from "../hooks/useComposerVoiceRef";
import type { ProjectAppTarget } from "../api/projectApp";
import { TemplateProjectForm } from "./TemplateProjectForm";
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
  DEFAULT_PROVIDER,
  SERVER_CAPABILITIES,
  serverHasCapability,
  isTurnEffort,
  DEFAULT_RECAP_AFTER_SECONDS,
  DEFAULT_PROJECT_QUEUE_CTRL_ENTER_ENABLED,
  HELPER_SIDE_MODEL_CHEAPEST,
  HELPER_SIDE_MODEL_SAME_AS_MAIN,
  type EffortLevel,
  type ModelInfo,
  type PromptSuggestionMode,
  type ProviderInfo,
  type ProviderName,
  type RecapMode,
  type SessionSandboxLevel,
  type ThinkingMode,
  type ThinkingOption,
  type Workstream,
  type WorkstreamId,
  normalizeRecapAfterSeconds,
  resolveModel,
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
import { ENTER_SENDS_MESSAGE } from "../constants";
import styles from "./NewSessionForm.module.css";
import { useCurrentSourceRuntime } from "../contexts/SourceRuntimeContext";
import { useToastContext } from "../contexts/ToastContext";
import { useBrowserXaiSttApiKey } from "../hooks/useBrowserXaiSttApiKey";
import { useDraftPersistence } from "../hooks/useDraftPersistence";
import { useProjectFileCompletion } from "../hooks/useProjectFileCompletion";
import { ProjectFileCompletionMenu } from "./ProjectFileCompletionMenu";
import { createNewSessionDraftKey } from "../hooks/useDrafts";
import {
  getModelSetting,
  getShowThinkingSetting,
  useModelSettings,
} from "../hooks/useModelSettings";
import { useProjectQueues } from "../hooks/useProjectQueues";
import {
  getDefaultLaunchableProvider,
  getLaunchableProviders,
  useProviderRow,
  useProviders,
} from "../hooks/useProviders";
import {
  getAttachmentUploadLongEdgePx,
  useAttachmentUploadQuality,
} from "../hooks/useAttachmentUploadQuality";
import { useRemoteBasePath } from "../hooks/useRemoteBasePath";
import { useRemoteExecutors } from "../hooks/useRemoteExecutors";
import { useSpeechSourceRuntime } from "../hooks/useSpeechSourceRuntime";
import { useServerSettings } from "../hooks/useServerSettings";
import { useSessionToolbarPresence } from "../hooks/useSessionToolbarPresence";
import { useI18n } from "../i18n";
import { formatFileSize } from "../lib/formatFileSize";
import { getUiCreationProvenance } from "../lib/sessionCreationProvenance";
import { parseComposerSlashCommand } from "../lib/slashCommands";
import { takePrebootComposer } from "../lib/prebootComposer";
import { UI_KEYS } from "../lib/storageKeys";
import {
  getEffortLevelLabel,
  getEffortLevelOptions,
  getThinkingModeOptions,
  resolveSupportedEffortLevel,
  resolveSupportedThinkingMode,
} from "../lib/effortLevels";
import {
  knownLockedEffort,
  knownLockedProvider,
  launchLockFor,
  launchLockOverrides,
  type LaunchLock,
} from "../lib/limitedLaunchLock";
import {
  getPreferredProviderModelId,
  getProviderSessionDefaults,
  hasRequiredProviderModel,
  withProviderSessionDefaults,
} from "../lib/newSessionDefaults";
import {
  startsAdditionalModelGroup,
  withProviderVisibleModelSelection,
} from "../lib/modelCatalog";
import {
  providerSupportsLocalSessionSandbox,
  providerSupportsRemoteExecutors,
} from "../lib/providerCapabilities";
import {
  describeUnavailableSessionSandbox,
  serverHasAvailableSessionSandbox,
} from "../lib/sessionSandboxAvailability";
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
  PROMPT_SUGGESTION_MODE_ORDER,
  RECAP_MODE_ORDER,
  getDefaultHelperSideModel,
  getPreferredPromptSuggestionMode,
  getPreferredRecapMode,
  parseThinkingOption,
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
  settlePathEntry,
} from "../lib/newProjectPath";
import { getRecapModeDescription } from "../lib/recapModes";
import { getSessionDefaultControlCopy } from "../lib/sessionDefaultControlCopy";
import { prepareImageUpload } from "../lib/imageAttachmentResize";
import { storeUploadedAttachmentPreview } from "../lib/attachmentPreviewCache";
import type { DraftAttachmentState } from "../lib/draftEnvelope";
import {
  deleteDraftAttachmentRef,
  materializeDraftAttachmentsForSession,
  validateDraftAttachmentRefs,
} from "../lib/draftAttachmentStaging";
import {
  hasAttachmentNavigationRisk,
  useAttachmentNavigationGuard,
} from "../lib/attachmentNavigationGuard";
import { requiresAttachmentOnlyServerUpdate } from "../lib/attachmentSubmission";
import {
  serverSupportsProjectQueue,
  shouldShowProjectQueueAffordance,
} from "../lib/projectQueueVisibility";
import {
  useActiveProjectSessionIds,
  useClientSummarySourceKey,
} from "../lib/clientSummaryStore";
import { hasCoarsePointer } from "../lib/deviceDetection";
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
  measureServerLatencyMs,
  recordServerClockSample,
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
  SpeechTranscriptionResultMetadata,
} from "../lib/speechProviders/SpeechProvider";
import { focusComposerForSpeechTransition } from "../lib/speechComposerFocus";
import {
  clearSpeechInsertionRangeReplacement,
  createSpeechInsertionRange,
  getSpeechSelectionFinalDelayMs,
  getSpeechInterimDisplayTranscript,
  getSpeechTranscriptInsertionParts,
  getSpeechTranscriptReplacementParts,
  getSpeechVisibleDraftText,
  mapSpeechInsertionRangeThroughEdit,
  retargetSpeechInsertionRange,
  type SpeechInsertionRange,
  textBeforeSpeechCursor,
} from "../lib/speechRecognition";
import {
  commitSpeechTranscript,
  hasNonWhitespaceEdit,
  type PendingSpeechRetarget,
  type PendingTextareaSelectionRestore,
} from "../lib/speechDraftTransaction";
import {
  prependSpeechMessagePrefix,
  resolveDeliverySpeechPrefix,
} from "../lib/speechMessagePrefix";
import { handleVoiceInputShortcutKeyDown } from "../lib/voiceInputShortcut";
import { generateUUID } from "../lib/uuid";
import { useVersion } from "../hooks/useVersion";
import { useSpeechCaptureSettings } from "../hooks/useSpeechCaptureSettings";
import { useRecentSpeechAttribution } from "../hooks/useRecentSpeechAttribution";
import { useProviderSubscriptionUsage } from "../hooks/useProviderSubscriptionUsage";
import { useActingPrincipal } from "../hooks/useActingPrincipal";
import { shortenPath } from "../lib/text";
import { getPermissionModeOptions } from "../lib/permissionModes";
import type { PermissionMode, Project } from "../types";
import { AttachmentChip } from "./AttachmentChip";
import { DeliveryGlyph } from "./DeliveryGlyph";
import { FilterDropdown, type FilterOption } from "./FilterDropdown";
import { FullPaneComposerToggle } from "./FullPaneComposerToggle";
import { NewSessionFixedLaunch } from "./NewSessionFixedLaunch";
import { NewSessionProjectQueue } from "./NewSessionProjectQueue";
import { SpeechPrefixActionCue } from "./SpeechPrefixActionCue";
import { ProviderBadge } from "./ProviderBadge";
import { ModelSubscriptionUsage } from "./ModelSubscriptionUsage";
import { RecapAfterSecondsControl } from "./RecapAfterSecondsControl";
import { SpeechControlMenu } from "./SpeechControlMenu";
import {
  VoiceInputButton,
  type SpeechCycleSettlement,
  type SpeechPendingKind,
  type VoiceInputButtonRef,
} from "./VoiceInputButton";

interface WorkstreamsLoadState {
  status: "idle" | "loading" | "ready" | "error";
  projectId: string | null;
  workstreams: Workstream[];
}

interface PendingSpeechFinal {
  timer: ReturnType<typeof setTimeout>;
  transcript: string;
  metadata?: SpeechTranscriptionResultMetadata;
}

type PendingNewSessionSpeechDeliveryIntent = "start" | "project-queue";

interface PendingNewSessionSpeechDelivery {
  kind: PendingNewSessionSpeechDeliveryIntent;
  visibleTextSnapshot: string;
}

function createClientSpeechTurnId(): string {
  return generateUUID();
}

function createSpeechTargetId(): string {
  return `speech-target-${generateUUID()}`;
}

/**
 * Stand-in row for seeding the form before any provider has been probed.
 *
 * It carries no status or capability claims: it exists so the saved provider
 * and its provider-local model defaults can resolve, and it is replaced by the
 * probed row the moment one arrives. It is never rendered as a provider card.
 */
function unprobedProviderRow(name: ProviderName): ProviderInfo {
  return {
    name,
    displayName: name,
    installed: false,
    authenticated: false,
    enabled: false,
  };
}

export interface NewSessionFormProps {
  projectApp?: ProjectAppTarget;
  onVoiceControl?: (control: VoiceInputButtonRef | null) => void;
  projectId?: string;
  selectedProject?: Project | null;
  projects?: Project[];
  recentProjectIds?: string[];
  projectsLoading?: boolean;
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
  /** Seed the execution host from an existing session. */
  preferredExecutor?: string;
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

interface NewSessionOptionSectionProps {
  caption?: string;
  children: ReactNode;
  className: string;
  showCaption: boolean;
  title: string;
}

function NewSessionOptionSection({
  caption,
  children,
  className,
  showCaption,
  title,
}: NewSessionOptionSectionProps) {
  return (
    <div className={className} title={showCaption ? undefined : caption}>
      <h3>{title}</h3>
      {children}
      {showCaption && caption && (
        <p className={styles.optionCaption}>{caption}</p>
      )}
    </div>
  );
}

export function NewSessionForm({
  projectApp,
  onVoiceControl,
  projectId,
  selectedProject,
  projects = [],
  recentProjectIds = [],
  projectsLoading = false,
  onProjectChange,
  autoFocus = true,
  rows = 6,
  placeholder,
  compact = false,
  preferredProvider,
  preferredModel,
  preferredThinking,
  preferredPermissionMode,
  preferredExecutor,
  incomingShareFiles,
  launch,
}: NewSessionFormProps) {
  const { t } = useI18n();
  const sessionDefaultCopy = getSessionDefaultControlCopy(t);
  const [creatingTemplateProject, setCreatingTemplateProject] = useState(false);
  const {
    choices: templateChoices,
    error: templateError,
    emptyMessageKey,
  } = useProjectTemplateChoices(creatingTemplateProject);
  const [templateProjectBusy, setTemplateProjectBusy] = useState(false);
  const handleTemplateBusyChange = useCallback((busy: boolean) => {
    setTemplateProjectBusy(busy);
    if (busy) setCreatingTemplateProject(true);
  }, []);
  const navigate = useNavigate();
  const basePath = useRemoteBasePath();
  const { relayTransport, relayedServerSpeechAvailable } =
    useSpeechSourceRuntime();
  const clientSummarySourceKey = useClientSummarySourceKey();
  const sourceRuntime = useCurrentSourceRuntime();
  const sourceSummary = sourceRuntime.summary;
  const sourceTransport = sourceRuntime.transport;
  const newSessionDraftKey = useMemo(
    () => launch?.draftKey ?? createNewSessionDraftKey(clientSummarySourceKey),
    [clientSummarySourceKey, launch?.draftKey],
  );
  const [message, setMessage, draftControls] =
    useDraftPersistence(newSessionDraftKey);
  const [mode, setMode] = useState<PermissionMode>("default");
  const [selectedProvider, setSelectedProvider] = useState<ProviderName | null>(
    null,
  );
  const [routerSelection, setRouterSelection] =
    useState<RouterSelection | null>(null);
  useEffect(() => {
    setRouterSelection((selection) =>
      selection?.sourceKey === clientSummarySourceKey ? selection : null,
    );
  }, [clientSummarySourceKey]);
  const [selectedModel, setSelectedModel] = useState<string | null>(null);
  const [selectedThinkingMode, setSelectedThinkingMode] =
    useState<ThinkingMode>("off");
  const [selectedEffortLevel, setSelectedEffortLevel] =
    useState<EffortLevel>("high");
  const [selectedRecapMode, setSelectedRecapMode] = useState<RecapMode>("off");
  const [sandboxLevel, setSandboxLevel] = useState<SessionSandboxLevel>("none");
  const [machineControlSelected, setMachineControlSelected] = useState(false);
  const selectMachineControl = useCallback((selected: boolean) => {
    setMachineControlSelected(selected);
  }, []);
  const [sandboxNetworkFirewall, setSandboxNetworkFirewall] = useState(true);
  const [recapAfterSeconds, setRecapAfterSeconds] = useState(
    DEFAULT_RECAP_AFTER_SECONDS,
  );
  const [selectedPromptSuggestionMode, setSelectedPromptSuggestionMode] =
    useState<PromptSuggestionMode>("off");
  const [helperSideModel, setHelperSideModel] = useState<string>(
    HELPER_SIDE_MODEL_CHEAPEST,
  );
  // null = local, string = remote host
  const [selectedExecutor, setSelectedExecutor] = useState<string | null>(null);
  const [pendingFiles, setPendingFilesState] = useState<PendingFile[]>([]);
  const pendingFilesRef = useRef<PendingFile[]>([]);
  const draftAttachmentBatchIdRef = useRef<string | null>(null);
  const draftAttachmentHydrationRef = useRef(0);
  const pendingStagedUploadsRef = useRef<
    Map<string, Promise<PendingStagedFile | null>>
  >(new Map());
  const removedPendingUploadIdsRef = useRef<Set<string>>(new Set());
  const [isStarting, setIsStarting] = useState(false);
  const [fullPane, setFullPane] = useState(false);
  const [fullPaneWide, setFullPaneWide] = useState(false);
  const [showOptionCaptions, setShowOptionCaptions] = useState(false);
  const [showAdvancedOptions, setShowAdvancedOptions] = useState(
    () =>
      localStorage.getItem(UI_KEYS.newSessionAdvancedOptionsExpanded) ===
      "true",
  );
  const [fullPaneBaseWidth, setFullPaneBaseWidth] = useState<number | null>(
    null,
  );
  const [uploadProgress, setUploadProgress] = useState<
    Record<string, { uploaded: number; total: number }>
  >({});
  const [attachmentQuality] = useAttachmentUploadQuality();
  const { visibility: toolbarVisibility } = useSessionToolbarPresence();
  const [interimTranscript, setInterimTranscript] = useState("");
  const interimTranscriptRef = useRef(interimTranscript);
  interimTranscriptRef.current = interimTranscript;
  const [speechPending, setSpeechPending] = useState<SpeechPendingKind | null>(
    null,
  );
  const speechPendingRef = useRef<SpeechPendingKind | null>(null);
  const pendingSpeechDeliveryRef =
    useRef<PendingNewSessionSpeechDelivery | null>(null);
  const pendingSpeechDeliverySettledRef = useRef(false);
  const speechTransactionHasTextRef = useRef(false);
  const dispatchingSettledSpeechDeliveryRef = useRef(false);
  const runPendingSpeechDeliveryRef = useRef<() => void>(() => {});
  const { asrAttributionMs, speechMessagePrefix } = useSpeechCaptureSettings();
  const {
    active: speechAttributionActive,
    noteSpeech: noteSpeechAttribution,
    isRecent: isRecentSpeechAttribution,
    consume: consumeSpeechAttribution,
  } = useRecentSpeechAttribution(asrAttributionMs);
  const [, setSpeechPreviewRevision] = useState(0);
  const [isProjectChooserExpanded, setIsProjectChooserExpanded] =
    useState(false);
  const [selectedWorkstreamId, setSelectedWorkstreamId] =
    useState<WorkstreamId | null>(null);
  const [workstreamsState, setWorkstreamsState] =
    useState<WorkstreamsLoadState>({
      status: "idle",
      projectId: null,
      workstreams: [],
    });
  const [projectInput, setProjectInput] = useState(
    () => selectedProject?.path ?? "",
  );
  const fileInputRef = useRef<HTMLInputElement>(null);
  const projectChooserRef = useRef<HTMLDivElement>(null);
  const projectInputRef = useRef<HTMLInputElement>(null);
  const mainStackRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const voiceButtonRef = useRef<VoiceInputButtonRef>(null);
  const sharedVoiceRef = useComposerVoiceRef(voiceButtonRef, onVoiceControl);
  const speechTurnIdRef = useRef<string | null>(null);
  const speechInsertionRangeRef = useRef<SpeechInsertionRange | null>(null);
  const activeSpeechTargetIdRef = useRef<string | null>(null);
  const speechInsertionRangesRef = useRef<Map<string, SpeechInsertionRange>>(
    new Map(),
  );
  const pendingSpeechRetargetRef = useRef<PendingSpeechRetarget | null>(null);
  const pendingSpeechFinalRef = useRef<PendingSpeechFinal | null>(null);
  // True once the user manually edits (non-whitespace) during the active mic
  // transaction; holds an automatic Smart Turn endpoint send. Speech-inserted
  // finals go through setDraft (not onChange) and never set this.
  const composerEditedDuringSpeechRef = useRef(false);
  const pendingTextareaSelectionRef =
    useRef<PendingTextareaSelectionRestore | null>(null);
  const hasSeededDefaultsRef = useRef(false);
  const hasInitializedDefaultsRef = useRef(false);
  const hasUserCustomizedDefaultsRef = useRef(false);
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
  const supportsSessionSandboxing =
    serverHasAvailableSessionSandbox(versionInfo);
  const supportsRemoteExecutors =
    providerSupportsRemoteExecutors(selectedProvider);
  const effectiveExecutor = supportsRemoteExecutors ? selectedExecutor : null;
  const canConfigureSessionSandbox =
    supportsSessionSandboxing &&
    effectiveExecutor === null &&
    providerSupportsLocalSessionSandbox(selectedProvider);
  // Where the toggle would sit, say what keeps a supported host from offering
  // it; a limited user cannot change the host, and its fixed launch says so.
  const sessionSandboxUnavailableReason =
    !supportsSessionSandboxing &&
    !launchLock.limited &&
    effectiveExecutor === null &&
    providerSupportsLocalSessionSandbox(selectedProvider)
      ? describeUnavailableSessionSandbox(versionInfo, t)
      : null;
  const effectiveSandboxLevel: SessionSandboxLevel = launchLock.limited
    ? "project-write"
    : canConfigureSessionSandbox
      ? sandboxLevel
      : "none";
  // The firewall is part of the sandbox a limited user cannot clear; the server
  // refuses a limited launch that turns it off.
  const effectiveSandboxNetworkFirewall =
    effectiveSandboxLevel === "project-write" &&
    (launchLock.limited || sandboxNetworkFirewall);
  // Open local access does not block the sandbox; it earns a standing warning.
  const sandboxLocalAuthOpen =
    effectiveSandboxLevel === "project-write" &&
    versionInfo?.sessionSandboxing?.localAuthEnforced === false;
  const supportsProjectQueue = serverSupportsProjectQueue(versionInfo);
  const projectQueueCtrlEnterEnabled =
    versionInfo?.clientDefaults?.projectQueueCtrlEnterEnabled ??
    DEFAULT_PROJECT_QUEUE_CTRL_ENTER_ENABLED;
  const { hasBrowserXaiSttApiKey } = useBrowserXaiSttApiKey();

  // Toast for error messages
  const { showToast } = useToastContext();
  const allowAttachments = launch?.allowAttachments ?? true;
  const allowProjectQueue = launch?.allowProjectQueue ?? true;
  const fixedProject = launch?.fixedProject ?? false;
  const composerMuted = launch?.composer === "muted";
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
    if (!supportsProjectQueue) {
      return;
    }

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
      if (syncEnabled) {
        showToast(t("sessionDraftAttachmentsUnavailable"), "info");
        return;
      }
      console.warn(
        "[NewSessionForm] Failed to validate draft attachments:",
        err,
      );
      draftControls.setAttachmentState(null);
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
      showToast(t("sessionDraftAttachmentsUnavailable"), "info");
    }
  }, [
    sourceTransport,
    draftControls,
    setPendingFiles,
    showToast,
    supportsProjectQueue,
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

      const batchId = supportsProjectQueue
        ? ensureDraftAttachmentBatchId()
        : null;

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
          const preparedImage = file.type.startsWith("image/")
            ? await prepareImageUpload(
                file,
                getAttachmentUploadLongEdgePx(attachmentQuality),
              )
            : { file };
          const uploadFile = preparedImage.file;
          const stagedRef = await sourceTransport.uploadStagedAttachment(
            uploadFile,
            {
              batchId,
              onProgress: (bytesUploaded) => {
                setUploadProgress((prev) => ({
                  ...prev,
                  [tempId]: {
                    uploaded: bytesUploaded,
                    total: uploadFile.size,
                  },
                }));
              },
              ...(preparedImage.width !== undefined &&
              preparedImage.height !== undefined
                ? {
                    imageDimensions: {
                      width: preparedImage.width,
                      height: preparedImage.height,
                    },
                  }
                : {}),
            },
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
      historyScope,
      sourceTransport,
      projectId,
      selectedProject?.name,
      projectInput,
      ensureDraftAttachmentBatchId,
      setPendingFiles,
      showToast,
      supportsProjectQueue,
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

  // Fetch available providers
  const {
    providers,
    loading: providersLoading,
    stale: providersStale,
  } = useProviders();
  const { usage: subscriptionUsage } = useProviderSubscriptionUsage(
    routerSelection ? null : selectedProvider,
    { bootstrapTier: "supplementary" },
  );
  const {
    settings,
    isLoading: settingsLoading,
    updateSetting: updateServerSetting,
  } = useServerSettings();
  const newSessionDefaultsRef = useRef(settings?.newSessionDefaults);
  useEffect(() => {
    newSessionDefaultsRef.current = settings?.newSessionDefaults;
  }, [settings?.newSessionDefaults]);

  // Fetch remote executors
  const { executors: remoteExecutors, loading: executorsLoading } =
    useRemoteExecutors();
  const resolvedPlaceholder = placeholder ?? t("newSessionPlaceholder");
  const modeLabels: Record<PermissionMode, string> = {
    default: t("modeDefaultLabel"),
    acceptEdits: t("modeAcceptEditsLabel"),
    plan: t("modePlanLabel"),
    bypassPermissions: t("modeBypassPermissionsLabel"),
    auto: t("modeAutoLabel"),
  };
  const modeDescriptions: Record<PermissionMode, string> = {
    default: t("modeDefaultDescription"),
    acceptEdits: t("modeAcceptEditsDescription"),
    plan: t("modePlanDescription"),
    bypassPermissions: t("modeBypassPermissionsDescription"),
    auto: t("modeAutoDescription"),
  };
  const recapModeLabels: Record<RecapMode, string> = {
    off: t("recapModeOff"),
    native: t("recapModeNative"),
    "side-session": t("recapModeSideSession"),
    fork: t("recapModeFork"),
  };
  const promptSuggestionModeLabels: Record<PromptSuggestionMode, string> = {
    off: t("promptSuggestionModeOff"),
    native: t("promptSuggestionModeNative"),
  };
  const providerDescriptions: Record<ProviderName, string> = {
    claude: t("newSessionProviderDescriptionClaude"),
    "claude-gateway": t("newSessionProviderDescriptionClaudeGateway"),
    "claude-ollama": t("newSessionProviderDescriptionClaudeOllama"),
    codex: t("newSessionProviderDescriptionCodex"),
    "codex-oss": t("newSessionProviderDescriptionCodexOss"),
    gemini: t("newSessionProviderDescriptionGemini"),
    "gemini-acp": t("newSessionProviderDescriptionGeminiAcp"),
    grok: t("newSessionProviderDescriptionGrok"),
    opencode: t("newSessionProviderDescriptionOpenCode"),
    pi: t("newSessionProviderDescriptionPi"),
  };
  const promptSuggestionModeDescriptions: Record<PromptSuggestionMode, string> =
    {
      off: t("promptSuggestionModeOffDescription"),
      native: t("promptSuggestionModeNativeDescription"),
    };
  const recapAfterSecondsInlineLabels: Record<RecapMode, string> = {
    off: t("recapAfterSecondsLabel"),
    native: t("recapAfterSecondsInlineNative"),
    "side-session": t("recapAfterSecondsInlineSideSession"),
    fork: t("recapAfterSecondsInlineFork"),
  };

  // Get models and capabilities for the currently selected provider. Its named
  // row wins once available because it is independent of the aggregate's
  // slowest member and can carry stronger freshness than a retained snapshot.
  const selectedProviderQuery = useProviderRow(selectedProvider, {
    forceRefreshOnMount: selectedProvider === "claude-gateway",
  });
  const aggregateProviderInfo = providers.find(
    (p) => p.name === selectedProvider,
  );
  const selectedProviderInfo =
    selectedProviderQuery.row ?? aggregateProviderInfo;
  const routerEnabled =
    serverHasCapability(
      versionInfo,
      SERVER_CAPABILITIES.agentAuthRouter.name,
    ) &&
    !launchLock.limited &&
    !effectiveExecutor &&
    effectiveSandboxLevel === "none" &&
    (selectedProvider === "claude" || selectedProvider === "codex");
  const routerDiscovery = useRouterDiscovery(selectedProvider, routerEnabled);
  const accountModels = useMemo(
    () =>
      routedModels(
        routerDiscovery.data,
        selectedProvider,
        routerSelection?.poolId,
      ),
    [routerDiscovery.data, selectedProvider, routerSelection?.poolId],
  );
  const availableModels: ModelInfo[] = useMemo(() => {
    const direct = selectedProviderInfo?.models ?? [];
    const merged = new Map(direct.map((m) => [m.id, m]));
    for (const m of accountModels) {
      const representedByAlias = direct.some(
        (d) =>
          d.id !== m.id && resolveRouterModel(d.id, accountModels) === m.id,
      );
      if (representedByAlias && selectedModel !== m.id) continue;
      if (!merged.has(m.id) || routerSelection) merged.set(m.id, m);
    }
    if (routerSelection)
      for (const m of direct) {
        const routed = accountModels.find(
          (a) => a.id === resolveRouterModel(m.id, accountModels),
        );
        if (routed) merged.set(m.id, { ...routed, id: m.id, name: m.name });
      }
    return [...merged.values()];
  }, [
    selectedProviderInfo?.models,
    accountModels,
    routerSelection,
    selectedModel,
  ]);
  const visibleModels = useMemo(
    () =>
      withProviderVisibleModelSelection(
        selectedProvider,
        availableModels,
        selectedModel,
        t("modelSelectionUnavailable"),
      ),
    [availableModels, selectedModel, selectedProvider, t],
  );
  const selectedProviderCatalogCurrent =
    selectedProvider !== "claude-gateway" ||
    (selectedProviderQuery.fresh &&
      !selectedProviderQuery.refreshing &&
      selectedProviderQuery.error === null);
  const routerThinking: ThinkingOption =
    selectedThinkingMode === "off"
      ? "off"
      : selectedThinkingMode === "auto"
        ? "auto"
        : `on:${selectedEffortLevel}`;
  const compatibleMembers = routerSelection?.poolId
    ? routerPoolMembers(
        routerDiscovery.data,
        routerSelection.poolId,
        selectedProvider,
        selectedModel,
        routerThinking,
      )
    : [];
  const selectedRouterPool = routerDiscovery.data?.pools.find(
    (p) => p.id === routerSelection?.poolId,
  );
  const routerAccountId =
    selectedRouterPool?.policy === "manual"
      ? compatibleMembers.length === 1
        ? compatibleMembers[0]?.id
        : routerSelection?.accountId
      : undefined;
  const routedModel = resolveRouterModel(selectedModel, accountModels);
  const hasSelectedProviderModel = routerSelection
    ? !!(
        routerEnabled &&
        routedModel &&
        !routerDiscovery.error &&
        compatibleMembers.length &&
        (selectedRouterPool?.policy !== "manual" ||
          compatibleMembers.some((a) => a.id === routerAccountId))
      )
    : selectedProviderCatalogCurrent &&
      hasRequiredProviderModel(
        selectedProvider,
        selectedProviderInfo?.models ?? [],
        selectedModel,
      );
  const helperSelectableModels = useMemo(
    () => [...visibleModels],
    [visibleModels],
  );
  const helperSideModelOptions: FilterOption<string>[] = useMemo(
    () => [
      {
        value: HELPER_SIDE_MODEL_CHEAPEST,
        label: t("helperSideModelCheapest"),
      },
      {
        value: HELPER_SIDE_MODEL_SAME_AS_MAIN,
        label: t("helperSideModelSameAsMain"),
        description: selectedModel ?? undefined,
      },
      ...helperSelectableModels.map((model) => ({
        value: model.id,
        label: model.name,
        description: model.description,
      })),
    ],
    [helperSelectableModels, selectedModel, t],
  );
  // Default to true for backwards compatibility with providers that don't set these flags
  const supportsPermissionMode =
    selectedProviderInfo?.supportsPermissionMode ?? true;
  const supportsThinkingToggle =
    selectedProviderInfo?.supportsThinkingToggle ?? true;
  const selectedModelInfo = visibleModels.find(
    (model) => model.id === selectedModel,
  );
  const effortOptions = useMemo(
    () =>
      getEffortLevelOptions({
        provider: selectedProviderInfo,
        model: selectedModelInfo,
        translate: t,
      }),
    [selectedModelInfo, selectedProviderInfo, t],
  );
  const effectiveEffortLevel = routerSelection
    ? selectedEffortLevel
    : resolveSupportedEffortLevel(selectedEffortLevel, effortOptions);
  const thinkingModeOptions = useMemo(
    () =>
      getThinkingModeOptions({
        provider: selectedProviderInfo,
        model: selectedModelInfo,
        effortOptions,
      }),
    [effortOptions, selectedModelInfo, selectedProviderInfo],
  );
  const effectiveThinkingMode = routerSelection
    ? selectedThinkingMode
    : resolveSupportedThinkingMode(selectedThinkingMode, thinkingModeOptions);
  // A locked effort also settles the thinking mode it implies, so the panel
  // that would let either be changed is withheld rather than shown inert.
  const showThinkingControls =
    supportsThinkingToggle &&
    !launchLock.effort &&
    thinkingModeOptions.some((option) => option !== "off");
  const permissionModeOptions = useMemo(
    () => getPermissionModeOptions({ model: selectedModelInfo }),
    [selectedModelInfo],
  );
  const effectivePermissionMode = permissionModeOptions.includes(mode)
    ? mode
    : "default";
  const supportsInstalledMachineControl = serverHasCapability(
    versionInfo,
    SERVER_CAPABILITIES.installedMachineControl.name,
  );
  const machineControlEligible =
    supportsInstalledMachineControl &&
    !effectiveExecutor &&
    effectiveSandboxLevel === "none" &&
    !launch &&
    effectivePermissionMode !== "plan" &&
    (selectedProvider === "codex"
      ? effectivePermissionMode === "bypassPermissions"
      : ["claude", "claude-gateway", "claude-ollama"].includes(
          selectedProvider ?? "",
        ));
  const getLegacyProviderDefaultSeed = useCallback(
    (providerName: ProviderName) => ({
      model:
        providerName === "claude" ? resolveModel(getModelSetting()) : undefined,
      thinkingMode: legacyThinkingMode,
      effortLevel: legacyEffortLevel,
    }),
    [legacyEffortLevel, legacyThinkingMode],
  );
  const availableRecapModes = RECAP_MODE_ORDER;
  const availablePromptSuggestionModes = PROMPT_SUGGESTION_MODE_ORDER;
  const showHelperSideModel = selectedRecapMode === "side-session";
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
    selectedProject?.path ?? "",
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
  const customProjectTarget = useMemo(
    () =>
      hasCustomProjectPath
        ? settlePathEntry(activeProjectSearchQuery, newProjectBase, projects)
        : null,
    [activeProjectSearchQuery, hasCustomProjectPath, newProjectBase, projects],
  );
  const customProjectIsNewFolder =
    hasCustomProjectPath && !isAnchoredPath(activeProjectSearchQuery);
  const currentProjectSelection = exactProjectMatch ?? selectedProject ?? null;
  const projectQueueTargetProjectId =
    !hasCustomProjectPath && normalizedProjectInput && currentProjectSelection
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
  const showProjectQueueAction =
    supportsProjectQueue &&
    shouldShowProjectQueueAffordance({
      projectId: projectQueueTargetProjectId,
      activeProjectSessionIds,
      projectQueueBlockingCount,
      projectQueueItemCount,
    });
  // A named project whose record has not arrived yet is neither detached nor
  // ready to start. The composer does not wait for it: typing starts at once,
  // and starting waits for the project.
  const projectPending =
    Boolean(projectId) &&
    !hasCustomProjectPath &&
    currentProjectSelection === null;
  const isDetachedProject =
    !hasCustomProjectPath &&
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
  const projectSummaryTitle =
    currentProjectSelection?.name ??
    (projectPending ? t("newSessionLoading") : t("newSessionProjectDetached"));
  const projectSummaryMeta = hasCustomProjectPath
    ? normalizedProjectInput
    : (currentProjectSelection?.path ??
      (projectPending ? "" : t("newSessionProjectDetachedHint")));
  const displayedProjectSummaryMeta =
    hasCustomProjectPath || currentProjectSelection
      ? shortenPath(projectSummaryMeta)
      : projectSummaryMeta;
  const workstreamSelectionProjectId =
    !hasCustomProjectPath && normalizedProjectInput && currentProjectSelection
      ? currentProjectSelection.id
      : null;
  const workstreamSelectionEnabled = settings?.workstreamsEnabled === true;

  useEffect(() => {
    setSelectedWorkstreamId(null);
    if (!workstreamSelectionEnabled || !workstreamSelectionProjectId) {
      setWorkstreamsState({
        status: "idle",
        projectId: null,
        workstreams: [],
      });
      return;
    }

    let cancelled = false;
    setWorkstreamsState({
      status: "loading",
      projectId: workstreamSelectionProjectId,
      workstreams: [],
    });

    api
      .getProjectWorkstreams(workstreamSelectionProjectId)
      .then((response) => {
        if (cancelled) return;
        setWorkstreamsState({
          status: "ready",
          projectId: workstreamSelectionProjectId,
          workstreams: response.workstreams,
        });
      })
      .catch(() => {
        if (cancelled) return;
        setWorkstreamsState({
          status: "error",
          projectId: workstreamSelectionProjectId,
          workstreams: [],
        });
      });

    return () => {
      cancelled = true;
    };
  }, [workstreamSelectionEnabled, workstreamSelectionProjectId]);

  const workstreamOptions =
    workstreamsState.status === "ready" &&
    workstreamsState.projectId === workstreamSelectionProjectId
      ? workstreamsState.workstreams.filter(
          (workstream) =>
            workstream.kind === "main" || workstream.status === "active",
        )
      : [];
  const showWorkstreamChooser =
    workstreamSelectionEnabled &&
    workstreamSelectionProjectId !== null &&
    workstreamOptions.length > 1;
  const selectedWorkstream =
    workstreamOptions.find(
      (workstream) => workstream.id === selectedWorkstreamId,
    ) ??
    workstreamOptions.find((workstream) => workstream.kind === "main") ??
    null;
  const selectedCheckoutWorkstreamId =
    selectedWorkstream?.kind === "checkout" ? selectedWorkstream.id : undefined;

  const handleWorkstreamSelect = useCallback(
    (event: ChangeEvent<HTMLSelectElement>) => {
      const nextValue = event.currentTarget.value;
      setSelectedWorkstreamId(nextValue ? (nextValue as WorkstreamId) : null);
    },
    [],
  );

  const handleProjectOptionSelect = useCallback(
    (project: Project) => {
      setProjectInput(project.path);
      lastSyncedProjectIdRef.current = project.id;
      onProjectChange?.(project.id);
      setIsProjectChooserExpanded(false);
    },
    [onProjectChange],
  );

  const handleDetachedProject = useCallback(() => {
    setProjectInput("");
    lastSyncedProjectIdRef.current = null;
    onProjectChange?.(null);
    setIsProjectChooserExpanded(false);
  }, [onProjectChange]);

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

    if (hasCustomProjectPath) {
      rows.push(
        <button
          key="custom"
          type="button"
          className="new-session-project-option new-session-project-option-custom"
          onClick={() => setIsProjectChooserExpanded(false)}
        >
          <span className="new-session-project-option-name">
            {customProjectIsNewFolder
              ? t("newSessionProjectNewFolder")
              : t("newSessionProjectUseTypedPath")}
          </span>
          <span className="new-session-project-option-path">
            {customProjectTarget?.path ?? activeProjectSearchQuery}
          </span>
        </button>,
      );
    }

    if (projectsLoading) {
      rows.push(
        <div key="loading" className="new-session-project-empty">
          {t("newSessionLoading")}
        </div>,
      );
      return rows;
    }

    if (projectSuggestions.length === 0) {
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
    customProjectIsNewFolder,
    customProjectTarget,
    isDetachedProject,
    isProjectChooserExpanded,
    activeProjectSearchQuery,
    projectSuggestions,
    projectsLoading,
    t,
  ]);

  // A locked field is not a default anything may override, so every path that
  // seeds provider, model, effort, or sandbox ends here. It deliberately does
  // not mark the form customized: a lock the server imposed is not a
  // preference worth saving as this client's default.
  const applyLaunchLock = useCallback(() => {
    if (!launchLock.limited) return;
    const lockedProvider = knownLockedProvider(launchLock);
    if (lockedProvider) setSelectedProvider(lockedProvider);
    if (launchLock.model) setSelectedModel(launchLock.model);
    if (launchLock.effort) {
      const lockedEffort = knownLockedEffort(launchLock);
      if (lockedEffort) setSelectedEffortLevel(lockedEffort);
      setSelectedThinkingMode("on");
    }
    setSandboxLevel("project-write");
    // Sandboxing implies the firewall here for the same reason the toggle
    // turns it on: without it a sandboxed agent can reach YA and escape.
    // The checkbox below stays theirs to clear afterwards.
    setSandboxNetworkFirewall(true);
    // A side-session recap cannot run beside a sandboxed session, the same
    // reason the sandbox toggle clears it when a superuser turns it on.
    setSelectedRecapMode((current) =>
      current === "side-session" ? "off" : current,
    );
  }, [launchLock]);

  // Apply saved defaults against whatever provider rows are known so far.
  // `providerRows` may be empty (nothing probed yet) or a previous visit's
  // snapshot; the standing choice is settings state, so an unknown catalog
  // seeds the saved provider rather than blanking the form.
  const applyInitialDefaults = useCallback(
    (providerRows: ProviderInfo[]) => {
      const catalogKnown = providerRows.length > 0;
      const launchableProviderNames = new Set(
        getLaunchableProviders(providerRows).map((p) => p.name),
      );
      const isSelectable = (name: ProviderName) =>
        !catalogKnown || launchableProviderNames.has(name);
      const savedDefaults = settings?.newSessionDefaults;
      // An explicit caller preference (e.g. "clear" from an existing session)
      // outranks saved new-session defaults.
      const requestedProviderName =
        preferredProvider && isSelectable(preferredProvider)
          ? preferredProvider
          : null;
      const savedProviderName =
        requestedProviderName ??
        (savedDefaults?.provider && isSelectable(savedDefaults.provider)
          ? savedDefaults.provider
          : null);
      const initialProvider =
        providerRows.find((p) => p.name === savedProviderName) ??
        getDefaultLaunchableProvider(providerRows) ??
        (catalogKnown
          ? null
          : unprobedProviderRow(savedProviderName ?? DEFAULT_PROVIDER));

      if (!initialProvider) return;

      const initialModels = initialProvider.models ?? [];
      const requestedModelId =
        requestedProviderName &&
        initialProvider.name === requestedProviderName &&
        preferredModel &&
        ((initialProvider.name !== "claude-gateway" &&
          initialModels.length === 0) ||
          initialModels.some((model) => model.id === preferredModel))
          ? preferredModel
          : null;
      const preferredPromptSuggestionMode =
        getPreferredPromptSuggestionMode(savedDefaults);
      const initialProviderDefaults = getProviderSessionDefaults(
        savedDefaults,
        initialProvider.name,
        getLegacyProviderDefaultSeed(initialProvider.name),
      );
      setSelectedProvider(initialProvider.name);
      setSelectedModel(
        requestedModelId ??
          getPreferredProviderModelId(
            initialProvider.name,
            initialModels,
            initialProviderDefaults.model,
          ),
      );
      const preferredThinkingSelection = preferredThinking
        ? parseThinkingOption(preferredThinking)
        : null;
      setSelectedThinkingMode(
        preferredThinkingSelection?.mode ??
          initialProviderDefaults.thinkingMode ??
          "off",
      );
      setSelectedEffortLevel(
        preferredThinkingSelection?.effort ??
          initialProviderDefaults.effortLevel ??
          "high",
      );
      const savedSandboxLevel =
        supportsSessionSandboxing &&
        savedDefaults?.sandboxLevel === "project-write"
          ? "project-write"
          : "none";
      const savedRecapMode = getPreferredRecapMode(
        initialProvider,
        savedDefaults,
      );
      setSelectedRecapMode(
        providerSupportsLocalSessionSandbox(initialProvider.name) &&
          savedSandboxLevel === "project-write" &&
          savedRecapMode === "side-session"
          ? "off"
          : savedRecapMode,
      );
      setSandboxLevel(savedSandboxLevel);
      setSandboxNetworkFirewall(
        savedSandboxLevel === "project-write" &&
          savedDefaults?.sandboxNetworkFirewall !== false,
      );
      setRecapAfterSeconds(
        normalizeRecapAfterSeconds(savedDefaults?.recapAfterSeconds),
      );
      setSelectedPromptSuggestionMode(preferredPromptSuggestionMode);
      setHelperSideModel(
        getDefaultHelperSideModel(initialModels, initialProviderDefaults),
      );
      setMode(
        preferredPermissionMode ?? savedDefaults?.permissionMode ?? "default",
      );
      setSelectedExecutor(preferredExecutor ?? null);
      // Last, so a saved default never outranks the acting principal's lock.
      applyLaunchLock();
    },
    [
      applyLaunchLock,
      settings,
      supportsSessionSandboxing,
      getLegacyProviderDefaultSeed,
      preferredProvider,
      preferredModel,
      preferredThinking,
      preferredPermissionMode,
      preferredExecutor,
    ],
  );

  // Seed provider/model/mode from saved defaults as soon as settings resolve.
  // Waiting for the provider catalog here would hand an unselected provider's
  // discovery cost to the saved one; see topics/session-defaults.md.
  useEffect(() => {
    if (hasSeededDefaultsRef.current || settingsLoading) return;
    hasSeededDefaultsRef.current = true;
    if (hasUserCustomizedDefaultsRef.current) return;
    applyInitialDefaults(providers);
  }, [applyInitialDefaults, providers, settingsLoading]);

  // Reconcile that seed once the probed catalog and version capabilities land.
  useEffect(() => {
    if (
      hasInitializedDefaultsRef.current ||
      providersLoading ||
      settingsLoading ||
      versionLoading
    ) {
      return;
    }

    hasInitializedDefaultsRef.current = true;
    if (hasUserCustomizedDefaultsRef.current) {
      return;
    }

    if (providers.length === 0) return;
    applyInitialDefaults(providers);
  }, [
    applyInitialDefaults,
    providers,
    providersLoading,
    settingsLoading,
    versionLoading,
  ]);

  // Re-assert the lock for a principal that arrived after the first seed. The
  // seeding paths call applyLaunchLock themselves, so this covers only the
  // ordering where the acting-principal request settles last.
  useEffect(() => {
    applyLaunchLock();
  }, [applyLaunchLock]);

  // A layout effect, so the field is filled before any key can start the
  // session: an empty field would start it detached.
  useLayoutEffect(() => {
    const nextProjectId = projectId ?? null;
    if (lastSyncedProjectIdRef.current === nextProjectId) {
      return;
    }
    // The form mounts before the named project's record arrives; fill the
    // project field from that record once it does.
    if (nextProjectId && !selectedProject) {
      return;
    }

    lastSyncedProjectIdRef.current = nextProjectId;
    setProjectInput((prev) => prev || (selectedProject?.path ?? ""));
  }, [projectId, selectedProject]);

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

  // When provider changes, reset model based on user settings
  const handleProviderSelect = (providerName: ProviderName) => {
    hasUserCustomizedDefaultsRef.current = true;
    setSelectedProvider(providerName);
    setRouterSelection(null);
    const provider = providers.find((p) => p.name === providerName);
    const providerModels = provider?.models ?? [];
    const providerDefaults = getProviderSessionDefaults(
      settings?.newSessionDefaults,
      providerName,
      getLegacyProviderDefaultSeed(providerName),
    );
    if (provider?.models && provider.models.length > 0) {
      setSelectedModel(
        getPreferredProviderModelId(
          providerName,
          providerModels,
          providerDefaults.model,
        ),
      );
    } else {
      setSelectedModel(null);
    }
    const preferredThinkingSelection = preferredThinking
      ? parseThinkingOption(preferredThinking)
      : null;
    setSelectedThinkingMode(
      preferredThinkingSelection?.mode ??
        providerDefaults.thinkingMode ??
        "off",
    );
    setSelectedEffortLevel(
      preferredThinkingSelection?.effort ??
        providerDefaults.effortLevel ??
        "high",
    );
    setHelperSideModel(
      getDefaultHelperSideModel(providerModels, providerDefaults),
    );
  };

  useEffect(() => {
    if (selectedProvider !== "claude-gateway") return;
    if (
      selectedModel &&
      availableModels.some((model) => model.id === selectedModel)
    ) {
      return;
    }
    const providerDefaults = getProviderSessionDefaults(
      settings?.newSessionDefaults,
      selectedProvider,
      getLegacyProviderDefaultSeed(selectedProvider),
    );
    const nextModel = getPreferredProviderModelId(
      selectedProvider,
      availableModels,
      providerDefaults.model,
    );
    if (selectedModel !== nextModel) {
      setSelectedModel(nextModel);
      setHelperSideModel(
        getDefaultHelperSideModel(availableModels, providerDefaults),
      );
    }
  }, [
    availableModels,
    getLegacyProviderDefaultSeed,
    selectedModel,
    selectedProvider,
    settings?.newSessionDefaults,
  ]);

  // A provider chosen before its catalog answered has no model yet. Fill the
  // provider-local saved default once its models arrive, leaving any existing
  // pick alone.
  useEffect(() => {
    if (!selectedProvider || selectedModel) return;
    if (availableModels.length === 0) return;
    const providerDefaults = getProviderSessionDefaults(
      settings?.newSessionDefaults,
      selectedProvider,
      getLegacyProviderDefaultSeed(selectedProvider),
    );
    const nextModel = getPreferredProviderModelId(
      selectedProvider,
      availableModels,
      providerDefaults.model,
    );
    if (!nextModel) return;
    setSelectedModel(nextModel);
    setHelperSideModel(
      getDefaultHelperSideModel(availableModels, providerDefaults),
    );
  }, [
    availableModels,
    getLegacyProviderDefaultSeed,
    selectedModel,
    selectedProvider,
    settings?.newSessionDefaults,
  ]);

  // Build model options for FilterDropdown
  const modelOptions = useMemo((): FilterOption<string>[] => {
    return visibleModels.map((model, index) => {
      const label = model.size
        ? `${model.name} (${(model.size / (1024 * 1024 * 1024)).toFixed(1)} GB)`
        : model.name;

      let description = model.description;
      if (!description) {
        const parts: string[] = [];
        if (model.parameterSize) parts.push(model.parameterSize);
        if (model.contextWindow) {
          parts.push(`${Math.round(model.contextWindow / 1024)}K ctx`);
        }
        if (model.parentModel) parts.push(model.parentModel);
        if (model.quantizationLevel) parts.push(model.quantizationLevel);
        if (parts.length > 0) description = parts.join(" · ");
      }

      return {
        value: model.id,
        label,
        description,
        groupLabelBefore: startsAdditionalModelGroup(visibleModels, index)
          ? t("previousModelsGroup")
          : undefined,
        // Reuse the session-header/tooltip badge so the model's route (e.g.
        // pi's "copilot") is visible in the picker, in the same provider →
        // route → model order the badge already establishes.
        icon: selectedProvider ? (
          <ProviderBadge provider={selectedProvider} model={model.id} />
        ) : undefined,
        meta: (
          <ModelSubscriptionUsage
            usage={subscriptionUsage}
            modelId={model.id}
          />
        ),
      };
    });
  }, [selectedProvider, subscriptionUsage, t, visibleModels]);

  // Handle model selection from FilterDropdown
  const handleModelSelect = useCallback((selected: string[]) => {
    hasUserCustomizedDefaultsRef.current = true;
    setSelectedModel(selected[0] ?? null);
  }, []);

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
  // text was typed without seeing a restored draft, so it follows the draft
  // as its own paragraph.
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
      if (preboot?.text) {
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
    [setMessage],
  );

  useLayoutEffect(() => {
    const pending = pendingTextareaSelectionRef.current;
    const textarea = textareaRef.current;
    if (
      !pending ||
      !textarea ||
      message !== pending.value ||
      textarea.value !== pending.value
    ) {
      return;
    }
    pendingTextareaSelectionRef.current = null;
    pending.restore(textarea);
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

  // Check for opt-in new-session prefill on mount.
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
  }, [clientSummarySourceKey, setMessage]);

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

  const handleModeSelect = (selectedMode: PermissionMode) => {
    hasUserCustomizedDefaultsRef.current = true;
    setMode(selectedMode);
  };

  // Auto-persist new-session defaults: any user change to provider / model /
  // permission / recap / suggestions / helper becomes the default immediately
  // (no explicit "save as default" step). Skips the initial load — only fires
  // once the user has actually customized something — and stays silent to
  // avoid a toast on every click.
  useEffect(() => {
    if (!hasUserCustomizedDefaultsRef.current || !selectedProvider) return;
    const {
      helperSideModel: _legacyHelperSideModel,
      sandboxLevel: _savedSandboxLevel,
      sandboxNetworkFirewall: _savedSandboxNetworkFirewall,
      ...baseDefaults
    } = (newSessionDefaultsRef.current ?? {}) as NonNullable<
      typeof newSessionDefaultsRef.current
    > & { helperSideModel?: string };
    void Promise.resolve(
      updateServerSetting("newSessionDefaults", {
        ...withProviderSessionDefaults(
          {
            ...baseDefaults,
            provider: selectedProvider ?? undefined,
            // Permission mode is an all-provider preference. Keep an
            // unsupported saved value such as Auto intact while the visible /
            // launch-time mode falls back to Ask for the selected model.
            permissionMode: mode,
            recapMode: selectedRecapMode,
            recapAfterSeconds,
            promptSuggestionMode: selectedPromptSuggestionMode,
            ...(supportsSessionSandboxing
              ? {
                  sandboxLevel,
                  ...(sandboxLevel === "project-write"
                    ? { sandboxNetworkFirewall }
                    : {}),
                }
              : {}),
          },
          selectedProvider,
          {
            model: selectedModel ?? undefined,
            thinkingMode: selectedThinkingMode,
            effortLevel: selectedEffortLevel,
            helperSideModel,
          },
          getLegacyProviderDefaultSeed(selectedProvider),
        ),
      }),
    ).catch((err) => {
      console.error("Failed to save new session defaults:", err);
    });
  }, [
    getLegacyProviderDefaultSeed,
    helperSideModel,
    mode,
    recapAfterSeconds,
    sandboxLevel,
    sandboxNetworkFirewall,
    selectedModel,
    selectedEffortLevel,
    selectedProvider,
    selectedPromptSuggestionMode,
    selectedRecapMode,
    selectedThinkingMode,
    supportsSessionSandboxing,
    updateServerSetting,
  ]);

  const resolveProjectIdForSubmission = useCallback(
    async (trimmedProjectInput: string): Promise<string | null> => {
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
      onProjectChange,
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
          const preparedImage = pendingFile.file.type.startsWith("image/")
            ? await prepareImageUpload(
                pendingFile.file,
                getAttachmentUploadLongEdgePx(attachmentQuality),
              )
            : { file: pendingFile.file };
          const uploadFile = preparedImage.file;
          const uploadedFile = await sourceTransport.upload(
            activeProjectId,
            sessionId,
            uploadFile,
            {
              onProgress: (bytesUploaded) => {
                setUploadProgress((prev) => ({
                  ...prev,
                  [pendingFile.id]: {
                    uploaded: bytesUploaded,
                    total: uploadFile.size,
                  },
                }));
              },
              ...(preparedImage.width !== undefined &&
              preparedImage.height !== undefined
                ? {
                    imageDimensions: {
                      width: preparedImage.width,
                      height: preparedImage.height,
                    },
                  }
                : {}),
            },
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
    [attachmentQuality, sourceTransport, showToast, t],
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
    ) => {
      const override =
        typeof messageOverride === "string" ? messageOverride : undefined;
      if (override === undefined && deferSpeechDelivery("start")) {
        return;
      }

      if (
        routerSelection &&
        (routerSelection.sourceKey !== clientSummarySourceKey ||
          !serverHasCapability(
            versionInfo,
            SERVER_CAPABILITIES.agentAuthRouter.name,
          ) ||
          launchLock.limited ||
          effectiveExecutor ||
          effectiveSandboxLevel !== "none" ||
          launch)
      ) {
        showToast(t("routerLaunchUnsupported"), "error");
        return;
      }
      const finalMessage = (override ?? draftControls.getDraft()).trimEnd();

      const submissionFiles = pendingFilesRef.current;
      const hasContent = finalMessage.trim() || submissionFiles.length > 0;
      // A muted composer composes its own first turn, so an empty message is
      // not a reason to refuse the start.
      if (
        (!hasContent && !composerMuted) ||
        creatingTemplateProject ||
        templateProjectBusy ||
        isStarting ||
        !hasSelectedProviderModel ||
        projectPending
      ) {
        if (propagateFailure) throw new Error(t("composerMemoCannotStart"));
        return;
      }

      const deliverySpeechPrefix = resolveDeliverySpeechPrefix({
        configuredPrefix: speechMessagePrefix,
        speechTriggered,
        recentSpeech: isRecentSpeechAttribution(),
      });
      let trimmedMessage =
        deliverySpeechPrefix && hasContent
          ? prependSpeechMessagePrefix(finalMessage, deliverySpeechPrefix)
          : finalMessage.trim();
      const command = parseComposerSlashCommand(trimmedMessage);
      const turnEffort =
        command && isTurnEffort(command.kind) ? command.kind : undefined;
      if (
        turnEffort &&
        (!serverHasCapability(
          versionInfo,
          SERVER_CAPABILITIES.turnEffortModifiers.name,
        ) ||
          launch ||
          !["codex", "claude", "claude-gateway", "claude-ollama"].includes(
            selectedProvider ?? "",
          ))
      ) {
        showToast(t("turnEffortUnavailable"), "error");
        return;
      }
      if (turnEffort && command) {
        if (!command.argument.trim()) {
          showToast(t("turnEffortNeedsMessage"), "error");
          return;
        }
        trimmedMessage = command.argument;
      }
      const messageMetadata = turnEffort
        ? { deliveryIntent: "direct" as const, turnEffort }
        : undefined;
      if (
        requiresAttachmentOnlyServerUpdate({
          version: versionInfo,
          text: finalMessage,
          attachmentCount: pendingFiles.length,
        })
      ) {
        showToast(t("attachmentOnlyRequiresServerUpdate"), "error");
        return;
      }
      const trimmedProjectInput = normalizeProjectInput(projectInput);
      const actionAtMs = Date.now();
      const clientTimestamp = getServerClockTimestamp(actionAtMs);

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

        let sessionId: string;
        let processId: string;
        const sessionMode = effectivePermissionMode;
        let initialPermissionMode: PermissionMode = sessionMode;
        let initialAppliedPermissionMode: PermissionMode | undefined;
        let initialModeVersion = 0;
        const uploadedFiles: UploadedFile[] = [];

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
        const sessionOptions = {
          creationProvenance,
          ...(supportsInstalledMachineControl
            ? {
                machineControl:
                  machineControlSelected && machineControlEligible,
              }
            : {}),

          mode: sessionMode,
          model: routerSelection ? routedModel : selectedModel || undefined,
          ...(routerSelection &&
          serverHasCapability(
            versionInfo,
            SERVER_CAPABILITIES.agentAuthRouter.name,
          )
            ? {
                routerAccountId,
                ...(routerSelection.poolId
                  ? {
                      routerPoolId: routerSelection.poolId,
                    }
                  : {}),
              }
            : {}),
          thinking: routerSelection ? routerThinking : thinking,
          showThinking,
          provider: selectedProvider ?? undefined,
          executor: effectiveExecutor ?? undefined,
          ...(supportsSessionSandboxing
            ? {
                sandboxLevel: effectiveSandboxLevel,
                ...(effectiveSandboxLevel === "project-write"
                  ? {
                      sandboxNetworkFirewall: effectiveSandboxNetworkFirewall,
                    }
                  : {}),
              }
            : {}),
          recapMode: effectiveRecapMode,
          recapAfterSeconds,
          promptSuggestionMode: effectivePromptSuggestionMode,
          helperSideModel,
          workstreamId: selectedCheckoutWorkstreamId,
          // Last word, so a submit that raced the acting-principal request
          // still launches inside the lock instead of being refused.
          ...launchLockOverrides(launchLock),
        };
        logSessionUiTrace("new-session-submit", {
          projectId: resolvedProjectId ?? null,
          detached: !resolvedProjectId,
          mode: sessionMode,
          model: selectedModel ?? null,
          thinking,
          provider: selectedProvider ?? null,
          executor: effectiveExecutor,
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

        if (submissionFiles.length > 0) {
          // Two-phase flow: create session first, then upload to real session folder
          // Step 1: Create the session without sending a message
          const createRequestSentAtMs = Date.now();
          const createResult = resolvedProjectId
            ? await api.createSession(resolvedProjectId, sessionOptions)
            : await api.createDetachedSession(sessionOptions);
          const createResponseReceivedAtMs = Date.now();
          const createTiming = recordServerClockSample({
            clientRequestStartMs: createRequestSentAtMs,
            clientResponseEndMs: createResponseReceivedAtMs,
            serverTimestamp: createResult.serverTimestamp,
          });
          const activeProjectId = createResult.projectId;
          sessionId = createResult.sessionId;
          processId = createResult.processId;
          initialPermissionMode = createResult.permissionMode;
          initialAppliedPermissionMode = createResult.appliedPermissionMode;
          initialModeVersion = createResult.modeVersion;
          resolvedProjectId = activeProjectId;
          logSessionUiTrace("new-session-created", {
            sessionId,
            processId,
            projectId: resolvedProjectId,
            thinking,
            mode: sessionMode,
            serverTimestamp: createResult.serverTimestamp,
            requestRttMs: createTiming?.roundTripMs ?? null,
            estimatedServerOffsetMs: createTiming?.serverOffsetMs ?? null,
          });

          // Step 2: Materialize staged draft refs, or use the legacy final
          // session upload fallback for files selected before capability support
          // was known.
          uploadedFiles.push(
            ...(await resolvePendingAttachmentsForSession(
              activeProjectId,
              sessionId,
            )),
          );

          // Step 3: Send the first message with attachments
          const queueRequestSentAtMs = Date.now();
          const queueResult = await api.queueMessage(
            sessionId,
            trimmedMessage,
            sessionMode,
            uploadedFiles.length > 0 ? uploadedFiles : undefined,
            undefined, // tempId
            thinking, // Pass the captured thinking setting to avoid process restart
            undefined, // deferred
            clientTimestamp,
            messageMetadata,
            undefined, // serviceTier
            showThinking,
          );
          const queueResponseReceivedAtMs = Date.now();
          const queueTiming = recordServerClockSample({
            clientRequestStartMs: queueRequestSentAtMs,
            clientResponseEndMs: queueResponseReceivedAtMs,
            serverTimestamp: queueResult.serverTimestamp,
          });
          logSessionUiTrace("new-session-queued", {
            sessionId,
            processId,
            projectId: resolvedProjectId,
            clientTimestamp,
            serverTimestamp: queueResult.serverTimestamp,
            uploadWaitMs: queueRequestSentAtMs - actionAtMs,
            requestRttMs: queueTiming?.roundTripMs ?? null,
            estimatedServerOffsetMs: queueTiming?.serverOffsetMs ?? null,
            clientToServerLatencyMs: measureServerLatencyMs(
              clientTimestamp,
              queueResult.serverTimestamp,
            ),
          });
        } else {
          // No files - use single-step flow for efficiency
          const startRequestSentAtMs = Date.now();
          const result = resolvedProjectId
            ? await api.startSession(
                resolvedProjectId,
                trimmedMessage,
                sessionOptions,
                undefined,
                clientTimestamp,
                messageMetadata,
              )
            : await api.startDetachedSession(
                trimmedMessage,
                sessionOptions,
                undefined,
                clientTimestamp,
                messageMetadata,
              );
          const startResponseReceivedAtMs = Date.now();
          const startTiming = recordServerClockSample({
            clientRequestStartMs: startRequestSentAtMs,
            clientResponseEndMs: startResponseReceivedAtMs,
            serverTimestamp: result.serverTimestamp,
          });
          sessionId = result.sessionId;
          processId = result.processId;
          initialPermissionMode = result.permissionMode;
          initialAppliedPermissionMode = result.appliedPermissionMode;
          initialModeVersion = result.modeVersion;
          resolvedProjectId = result.projectId;
          logSessionUiTrace("new-session-started", {
            sessionId,
            processId,
            projectId: resolvedProjectId,
            thinking,
            mode: sessionMode,
            provider: selectedProvider ?? null,
            model: selectedModel ?? null,
            clientTimestamp,
            serverTimestamp: result.serverTimestamp,
            requestRttMs: startTiming?.roundTripMs ?? null,
            estimatedServerOffsetMs: startTiming?.serverOffsetMs ?? null,
            clientToServerLatencyMs: measureServerLatencyMs(
              clientTimestamp,
              result.serverTimestamp,
            ),
          });
        }

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
        draftControls.restoreFromStorage();
        setIsStarting(false);

        // Show user-visible error message
        let errorMessage = t("newSessionStartError");
        if (err instanceof Error) {
          const providerDisplayName =
            selectedProviderInfo?.displayName ?? selectedProvider ?? "Provider";
          const lowerMessage = err.message.toLowerCase();
          const status = (err as Error & { status?: number }).status;

          // Check for specific error types
          if (err.message.includes("Queue is full")) {
            errorMessage = t("newSessionServerBusy");
          } else if (
            lowerMessage.includes("invalid authentication credentials") ||
            lowerMessage.includes("authentication_error") ||
            lowerMessage.includes("please run /login") ||
            (status === 401 &&
              (selectedProvider === "claude" ||
                selectedProvider === "gemini" ||
                selectedProvider === "codex"))
          ) {
            errorMessage = t("newSessionProviderAuthError", {
              provider: providerDisplayName,
            });
          } else if (err.message.includes("503")) {
            errorMessage = t("newSessionServerCapacity");
          } else if (err.message.includes("404")) {
            errorMessage = t("newSessionProjectNotFound");
          } else if (
            err.message.includes("fetch") ||
            err.message.includes("network")
          ) {
            errorMessage = t("newSessionNetworkError");
          } else {
            errorMessage = err.message;
          }
        }
        showToast(errorMessage, "error");
        if (propagateFailure) throw err;
      }
    },
    [
      basePath,
      draftControls,
      routerSelection,
      routedModel,
      routerAccountId,
      routerThinking,
      clientSummarySourceKey,
      supportsInstalledMachineControl,
      machineControlSelected,
      machineControlEligible,
      creatingTemplateProject,
      templateProjectBusy,
      historyScope,
      effectiveEffortLevel,
      effectiveExecutor,
      effectivePermissionMode,
      effectiveThinkingMode,
      helperSideModel,
      hasSelectedProviderModel,
      canCreateDetached,
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
      recapAfterSeconds,
      effectiveSandboxLevel,
      effectiveSandboxNetworkFirewall,
      resolvePendingAttachmentsForSession,
      resolveProjectIdForSubmission,
      selectedCheckoutWorkstreamId,
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
    if (routerSelection) {
      showToast(t("routerQueueUnsupported"), "error");
      return;
    }
    if (machineControlSelected && machineControlEligible) return;
    if (creatingTemplateProject || templateProjectBusy) return;
    const override =
      typeof messageOverride === "string" ? messageOverride : undefined;
    if (override === undefined && deferSpeechDelivery("project-queue")) {
      return;
    }

    const finalMessage = (override ?? draftControls.getDraft()).trimEnd();
    const rawTrimmedMessage = finalMessage.trim();
    const deliverySpeechPrefix = resolveDeliverySpeechPrefix({
      configuredPrefix: speechMessagePrefix,
      speechTriggered: false,
      recentSpeech: isRecentSpeechAttribution(),
    });
    const trimmedMessage = rawTrimmedMessage
      ? prependSpeechMessagePrefix(rawTrimmedMessage, deliverySpeechPrefix)
      : rawTrimmedMessage;
    const trimmedProjectInput = normalizeProjectInput(projectInput);
    const stagedRefs = pendingFiles
      .filter(isPendingStagedFile)
      .map(toPersistedStagedAttachmentRef);
    const canQueueAttachments = stagedRefs.length === pendingFiles.length;
    if (
      !trimmedMessage ||
      !canQueueAttachments ||
      isStarting ||
      !hasSelectedProviderModel
    ) {
      return;
    }

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
    setIsStarting(true);

    try {
      const resolvedProjectId =
        await resolveProjectIdForSubmission(trimmedProjectInput);
      if (!resolvedProjectId) {
        throw new Error(t("projectQueueNewSessionNeedsProject"));
      }

      const sessionMode = effectivePermissionMode;
      const thinking = toThinkingOption(
        effectiveThinkingMode,
        effectiveEffortLevel,
      );
      const showThinking = getShowThinkingSetting();

      const response = await api.createProjectQueueItem(resolvedProjectId, {
        target: {
          type: "new-session",
          mode: sessionMode,
          model: selectedModel ?? undefined,
          thinking,
          showThinking,
          provider: selectedProvider ?? undefined,
          executor: effectiveExecutor ?? undefined,
          ...(supportsSessionSandboxing
            ? {
                sandboxLevel: effectiveSandboxLevel,
                ...(effectiveSandboxLevel === "project-write"
                  ? {
                      sandboxNetworkFirewall: effectiveSandboxNetworkFirewall,
                    }
                  : {}),
              }
            : {}),
          ...launchLockOverrides(launchLock),
          title: trimmedMessage,
        },
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
      sourceSummary.reportProjectQueueCollectionSnapshot(response.queue);

      logSessionUiTrace("new-session-project-queued", {
        projectId: resolvedProjectId,
        mode: sessionMode,
        model: selectedModel ?? null,
        thinking,
        provider: selectedProvider ?? null,
        executor: effectiveExecutor,
        sandboxLevel: supportsSessionSandboxing ? effectiveSandboxLevel : null,
        sandboxNetworkFirewall: supportsSessionSandboxing
          ? effectiveSandboxNetworkFirewall
          : null,
        textLength: trimmedMessage.length,
        attachmentCount: stagedRefs.length,
        uploadWaitMs: Date.now() - actionAtMs,
      });
      setPendingFiles([], {
        persistDraft: false,
        revokeRemovedPreviewUrls: true,
      });
      draftControls.clearDraft();
      setIsStarting(false);
      showToast(t("projectQueueNewSessionQueuedToast"), "success");
    } catch (err) {
      console.error("Failed to queue project session:", err);
      draftControls.restoreFromStorage();
      setIsStarting(false);
      const errorMsg = err instanceof Error ? err.message : String(err);
      showToast(t("projectQueueSubmitFailed", { message: errorMsg }), "error");
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
      void handleStartSession(pending.visibleTextSnapshot);
    } finally {
      dispatchingSettledSpeechDeliveryRef.current = false;
    }
  };

  const maybeRunPendingSpeechDelivery = useCallback(() => {
    runPendingSpeechDeliveryRef.current();
  }, []);

  const handleKeyDown = (e: KeyboardEvent) => {
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

    // Escape cancels a pending post-capture wait. Active listening still
    // finalizes on Escape below.
    if (
      e.key === "Escape" &&
      !e.ctrlKey &&
      !e.metaKey &&
      !e.shiftKey &&
      !e.altKey &&
      (speechPending === "transcribing" || speechPending === "finalizing")
    ) {
      e.preventDefault();
      e.stopPropagation();
      handleCancelTranscription();
      return;
    }

    if (
      e.key === "Escape" &&
      !e.ctrlKey &&
      !e.metaKey &&
      !e.shiftKey &&
      !e.altKey &&
      voiceButtonRef.current?.isListening
    ) {
      e.preventDefault();
      e.stopPropagation();
      voiceButtonRef.current.toggle();
      return;
    }

    if (e.key === "Enter") {
      // Skip Enter during IME composition (e.g. Chinese/Japanese/Korean input)
      if (e.nativeEvent.isComposing) return;

      // If voice recording is active, Enter submits (on any device)
      if (voiceButtonRef.current?.isListening) {
        e.preventDefault();
        handleStartSession();
        return;
      }

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

      // On mobile (touch devices), Enter adds newline - must use send button.
      // On desktop, Enter sends message, Shift/Ctrl+Enter adds newline.
      const isMobile = hasCoarsePointer();

      if (isMobile) {
        // Mobile: Enter always adds newline, send button required
        return;
      }

      if (ENTER_SENDS_MESSAGE) {
        if (e.ctrlKey || e.shiftKey) return;
        e.preventDefault();
        handleStartSession();
      } else {
        if (e.ctrlKey || e.shiftKey) {
          e.preventDefault();
          handleStartSession();
        }
      }
    }
  };

  const handlePaste = (e: ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;

    const files: File[] = [];
    for (const item of items) {
      if (item.kind === "file") {
        const file = item.getAsFile();
        if (file) {
          files.push(file);
        }
      }
    }

    if (files.length > 0) {
      e.preventDefault();
      addPendingFiles(files);
    }
  };

  // Voice input handlers
  const handleListeningStart = useCallback(() => {
    speechTransactionHasTextRef.current = false;
    const textarea = textareaRef.current;
    const current = draftControls.getDraft();
    const selectionStart = Math.max(
      0,
      Math.min(textarea?.selectionStart ?? current.length, current.length),
    );
    const selectionEnd = Math.max(
      selectionStart,
      Math.min(textarea?.selectionEnd ?? selectionStart, current.length),
    );
    const targetId = createSpeechTargetId();
    const range = createSpeechInsertionRange(selectionStart, selectionEnd);
    activeSpeechTargetIdRef.current = targetId;
    speechInsertionRangeRef.current = range;
    speechInsertionRangesRef.current.set(targetId, range);
    pendingTextareaSelectionRef.current = null;
    pendingSpeechRetargetRef.current = null;
    composerEditedDuringSpeechRef.current = false;
    if (textarea) {
      focusComposerForSpeechTransition(textarea);
      textarea.setSelectionRange(selectionStart, selectionEnd);
    }
    interimTranscriptRef.current = "";
    setInterimTranscript("");
  }, [draftControls]);

  const clearPendingSpeechFinal = useCallback(() => {
    const pending = pendingSpeechFinalRef.current;
    if (pending === null) return;
    clearTimeout(pending.timer);
    pendingSpeechFinalRef.current = null;
  }, []);

  useEffect(() => clearPendingSpeechFinal, [clearPendingSpeechFinal]);

  const handleSpeechSelectionTarget = useCallback(
    (event?: unknown, draftAtSelection?: string) => {
      const manualInteraction = event !== undefined;
      const textarea = textareaRef.current;
      const range = speechInsertionRangeRef.current;
      if (!textarea || !range) return;
      const selectionStart = textarea.selectionStart;
      const selectionEnd = textarea.selectionEnd;
      const getNextRange = (
        currentRange: SpeechInsertionRange,
      ): SpeechInsertionRange => {
        if (selectionStart === selectionEnd) {
          return speechPendingRef.current === "listening"
            ? retargetSpeechInsertionRange(
                currentRange,
                selectionStart,
                selectionEnd,
              )
            : clearSpeechInsertionRangeReplacement(currentRange);
        }
        if (
          currentRange.replaceSelectedAtMs === undefined &&
          currentRange.end === selectionStart &&
          currentRange.replaceEnd === selectionEnd
        ) {
          return currentRange;
        }
        return retargetSpeechInsertionRange(
          currentRange,
          selectionStart,
          selectionEnd,
        );
      };

      if (selectionStart === selectionEnd) clearPendingSpeechFinal();
      const hasVisibleInterim = interimTranscriptRef.current.trim().length > 0;
      if (
        manualInteraction &&
        (hasVisibleInterim || pendingSpeechRetargetRef.current !== null)
      ) {
        pendingSpeechRetargetRef.current = {
          draft: draftAtSelection ?? draftControls.getDraft(),
          start: selectionStart,
          end: selectionEnd,
        };
        return;
      }

      const nextRange = getNextRange(range);
      if (speechPendingRef.current === "listening" && nextRange !== range) {
        voiceButtonRef.current?.beginInsertionBoundary();
      }
      speechInsertionRangeRef.current = nextRange;
      if (activeSpeechTargetIdRef.current) {
        speechInsertionRangesRef.current.set(
          activeSpeechTargetIdRef.current,
          nextRange,
        );
      }
      setSpeechPreviewRevision((revision) => revision + 1);
    },
    [clearPendingSpeechFinal, draftControls],
  );

  const clearSpeechSelectionTarget = useCallback(() => {
    clearPendingSpeechFinal();
    if (!speechInsertionRangeRef.current) return;
    const nextRange = clearSpeechInsertionRangeReplacement(
      speechInsertionRangeRef.current,
    );
    speechInsertionRangeRef.current = nextRange;
    if (activeSpeechTargetIdRef.current) {
      speechInsertionRangesRef.current.set(
        activeSpeechTargetIdRef.current,
        nextRange,
      );
    }
    setSpeechPreviewRevision((revision) => revision + 1);
  }, [clearPendingSpeechFinal]);

  const handleSpeechSelectionClick = useCallback(() => {
    window.setTimeout(() => handleSpeechSelectionTarget(true), 0);
  }, [handleSpeechSelectionTarget]);

  const commitVoiceTranscript = useCallback(
    (transcript: string, metadata?: SpeechTranscriptionResultMetadata) => {
      if (transcript.trim() && metadata?.smartTurnCommand !== "cancel") {
        speechTransactionHasTextRef.current = true;
        noteSpeechAttribution();
      }
      pendingSpeechDeliverySettledRef.current = true;
      const outcome = commitSpeechTranscript(
        {
          textareaRef,
          getDraft: draftControls.getDraft,
          setDraft: draftControls.setDraft,
          setInterimTranscript: (next) => {
            interimTranscriptRef.current = next;
            setInterimTranscript(next);
          },
          speechInsertionRangeRef,
          activeSpeechTargetIdRef,
          speechInsertionRangesRef,
          pendingTextareaSelectionRef,
          pendingSpeechRetargetRef,
          onInsertionBoundary: () =>
            voiceButtonRef.current?.beginInsertionBoundary(),
          onSpeechTargetChanged: () =>
            setSpeechPreviewRevision((revision) => revision + 1),
          onSmartTurnSend: (text) => {
            voiceButtonRef.current?.continueAfterSpeechSend();
            void handleStartSession(text, true);
          },
          composerEditedDuringSpeech: () =>
            composerEditedDuringSpeechRef.current,
        },
        transcript,
        metadata,
      );
      maybeRunPendingSpeechDelivery();
      // A completed overlapping (non-active) target's result has landed;
      // forget its range (active target is forgotten on pending->null).
      const committedTargetId = metadata?.speechTargetId;
      if (
        committedTargetId &&
        committedTargetId !== activeSpeechTargetIdRef.current &&
        speechInsertionRangesRef.current.delete(committedTargetId)
      ) {
        setSpeechPreviewRevision((revision) => revision + 1);
      }
      return outcome;
    },
    [
      draftControls,
      handleStartSession,
      maybeRunPendingSpeechDelivery,
      noteSpeechAttribution,
    ],
  );
  const handleVoiceTranscript = useCallback(
    (transcript: string, metadata?: SpeechTranscriptionResultMetadata) => {
      const speechRange = metadata?.speechTargetId
        ? (speechInsertionRangesRef.current.get(metadata.speechTargetId) ??
          null)
        : speechInsertionRangeRef.current;
      const delayMs = metadata?.smartTurnCommand
        ? 0
        : pendingSpeechRetargetRef.current
          ? 0
          : getSpeechSelectionFinalDelayMs(speechRange);
      if (delayMs > 0) {
        clearPendingSpeechFinal();
        const timer = setTimeout(() => {
          const pending = pendingSpeechFinalRef.current;
          if (!pending || pending.timer !== timer) return;
          pendingSpeechFinalRef.current = null;
          commitVoiceTranscript(pending.transcript, pending.metadata);
        }, delayMs);
        pendingSpeechFinalRef.current = { timer, transcript, metadata };
        return;
      }

      clearPendingSpeechFinal();
      return commitVoiceTranscript(transcript, metadata);
    },
    [clearPendingSpeechFinal, commitVoiceTranscript],
  );

  const flushPendingSpeechFinal = useCallback(() => {
    const pending = pendingSpeechFinalRef.current;
    if (pending === null) return;
    clearTimeout(pending.timer);
    pendingSpeechFinalRef.current = null;
    commitVoiceTranscript(pending.transcript, pending.metadata);
  }, [commitVoiceTranscript]);

  const handleListeningStop = useCallback(() => {
    const visibleInterim = getSpeechInterimDisplayTranscript(
      draftControls.getDraft(),
      interimTranscriptRef.current,
      speechInsertionRangeRef.current,
    );
    flushPendingSpeechFinal();
    if (visibleInterim) commitVoiceTranscript(visibleInterim);
    pendingSpeechRetargetRef.current = null;
    interimTranscriptRef.current = "";
    setInterimTranscript("");
    focusComposerForSpeechTransition(textareaRef.current);
    return Boolean(visibleInterim);
  }, [commitVoiceTranscript, draftControls, flushPendingSpeechFinal]);

  const handleInterimTranscript = useCallback((transcript: string) => {
    interimTranscriptRef.current = transcript;
    setInterimTranscript(transcript);
  }, []);

  const handlePendingSpeechChange = useCallback(
    (kind: SpeechPendingKind | null, settlement?: SpeechCycleSettlement) => {
      if (settlement === "failed") {
        pendingSpeechDeliveryRef.current = null;
        pendingSpeechDeliverySettledRef.current = false;
      } else if (settlement === "completed") {
        if (
          pendingSpeechDeliveryRef.current &&
          speechTransactionHasTextRef.current
        ) {
          noteSpeechAttribution();
        }
        pendingSpeechDeliverySettledRef.current = true;
      }
      speechPendingRef.current = kind;
      if (kind === "listening") handleSpeechSelectionTarget();
      if (kind === null) {
        // Active recording finished: forget its target so completed targets do
        // not accumulate (see MessageInput).
        const targetId = activeSpeechTargetIdRef.current;
        if (targetId) {
          speechInsertionRangesRef.current.delete(targetId);
        }
        speechInsertionRangeRef.current = null;
        activeSpeechTargetIdRef.current = null;
        pendingSpeechRetargetRef.current = null;
      }
      setSpeechPending(kind);
      if (kind === null) maybeRunPendingSpeechDelivery();
    },
    [
      handleSpeechSelectionTarget,
      maybeRunPendingSpeechDelivery,
      noteSpeechAttribution,
    ],
  );

  // Cancel a pending transcription/finalization. The provider discards the
  // in-flight result (keeping committed text); here we drop the pending speech
  // target.
  const handleCancelTranscription = useCallback(() => {
    voiceButtonRef.current?.cancelProcessing();
    pendingSpeechDeliveryRef.current = null;
    pendingSpeechDeliverySettledRef.current = false;
    clearPendingSpeechFinal();
    const targetId = activeSpeechTargetIdRef.current;
    if (targetId) {
      speechInsertionRangesRef.current.delete(targetId);
    }
    speechInsertionRangeRef.current = null;
    activeSpeechTargetIdRef.current = null;
    pendingSpeechRetargetRef.current = null;
    setSpeechPending(null);
    speechPendingRef.current = null;
    setInterimTranscript("");
  }, [clearPendingSpeechFinal]);

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
      hasSelectedProviderModel &&
      !projectPending &&
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
      !(machineControlSelected && machineControlEligible) &&
      showProjectQueueAction &&
      (message.trim() || speechPending !== null || interimTranscript) &&
      pendingFilesReadyForProjectQueue &&
      hasProjectQueueTargetProject &&
      hasSelectedProviderModel,
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
  const speechInsertionRange = speechInsertionRangeRef.current;
  const interimDisplayTranscript = getSpeechInterimDisplayTranscript(
    message,
    interimTranscript,
    speechInsertionRange,
  );
  // Only mutable provisional speech uses the textarea mirror. Capture and
  // post-capture status live with the mic so the real draft and caret stay
  // untouched while transcription is pending.
  const interimInsertion = speechInsertionRange
    ? getSpeechTranscriptReplacementParts(
        message,
        interimDisplayTranscript,
        speechInsertionRange.end,
        speechInsertionRange.replaceEnd ?? speechInsertionRange.end,
      )
    : getSpeechTranscriptInsertionParts(
        message,
        interimDisplayTranscript,
        message.length,
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
        <div
          className={`speech-draft-field ${
            interimDisplayTranscript ? "has-interim" : ""
          }`}
        >
          <div className="speech-draft-inline">
            {interimDisplayTranscript && (
              <div className="speech-draft-mirror" aria-hidden="true">
                <span>{interimInsertion.before}</span>
                {interimInsertion.separatorBefore}
                <span className="speech-interim-inline">
                  {interimInsertion.transcript}
                </span>
                <span className="speech-interim-caret" />
                {interimInsertion.separatorAfter}
                <span>{interimInsertion.after}</span>
              </div>
            )}
            <textarea
              data-draft-key={newSessionDraftKey}
              ref={attachComposerTextarea}
              data-composer-input
              value={message}
              onChange={(e) => {
                const nextMessage = fileCompletion.normalizeInput(
                  e.target.value,
                );
                clearPendingSpeechFinal();
                if (speechInsertionRangesRef.current.size > 0) {
                  const nextRanges = new Map<string, SpeechInsertionRange>();
                  for (const [
                    targetId,
                    range,
                  ] of speechInsertionRangesRef.current) {
                    nextRanges.set(
                      targetId,
                      clearSpeechInsertionRangeReplacement(
                        mapSpeechInsertionRangeThroughEdit(
                          message,
                          nextMessage,
                          range,
                        ),
                      ),
                    );
                  }
                  speechInsertionRangesRef.current = nextRanges;
                  speechInsertionRangeRef.current =
                    activeSpeechTargetIdRef.current !== null
                      ? (nextRanges.get(activeSpeechTargetIdRef.current) ??
                        null)
                      : null;
                }
                if (
                  activeSpeechTargetIdRef.current !== null &&
                  hasNonWhitespaceEdit(message, nextMessage)
                ) {
                  composerEditedDuringSpeechRef.current = true;
                }
                handleSpeechSelectionTarget(true, nextMessage);
                setMessage(nextMessage);
              }}
              onKeyDown={handleKeyDown}
              onFocus={fileCompletion.onFocus}
              onBlur={fileCompletion.onBlur}
              onSelect={() => {
                handleSpeechSelectionTarget();
                fileCompletion.onSelect();
              }}
              onPointerUp={handleSpeechSelectionTarget}
              onClick={handleSpeechSelectionClick}
              onKeyUp={handleSpeechSelectionTarget}
              onCut={clearSpeechSelectionTarget}
              onCopy={clearSpeechSelectionTarget}
              onPaste={(event) => {
                clearSpeechSelectionTarget();
                if (allowAttachments) {
                  handlePaste(event);
                }
              }}
              placeholder={resolvedPlaceholder}
              disabled={isStarting}
              // Read-only rather than disabled: the draft stays selectable and
              // scrollable so it can still be read, just not sent.
              readOnly={composerMuted}
              rows={composerMuted ? Math.min(rows, 3) : rows}
              className="new-session-form-textarea"
            />
          </div>
          {interimTranscript && (
            <div
              className="speech-interim-status"
              role="status"
              aria-live="polite"
              aria-label="Tentative speech transcript"
            >
              {interimTranscript}
            </div>
          )}
        </div>
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
          <div className="new-session-form-toolbar-actions">
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
                launch?.startLabel ?? t("newSessionStartAction"),
              )}
              title={describePrefixedTooltip(
                launch?.startLabel ?? t("newSessionStartAction"),
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
            value={projectInput}
            onChange={(e) => {
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

      {templateChoices?.enabled && !launch && (
        <div className={templateStyles.expansion}>
          <button
            type="button"
            aria-expanded={creatingTemplateProject}
            className={templateStyles.secondary}
            disabled={templateProjectBusy}
            onClick={() => setCreatingTemplateProject((value) => !value)}
          >
            {t("templateNewProject")}
          </button>
        </div>
      )}
      {isProjectChooserExpanded &&
        projectPanelRows &&
        !creatingTemplateProject && (
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
  );
  const workstreamChooser =
    showWorkstreamChooser && selectedWorkstream ? (
      <label className="new-session-workstream-field">
        <span className="new-session-workstream-label">
          {t("newSessionWorkstreamLabel")}
        </span>
        <select
          className="new-session-workstream-select"
          value={selectedCheckoutWorkstreamId ?? ""}
          onChange={handleWorkstreamSelect}
          disabled={isStarting}
          aria-label={t("newSessionWorkstreamLabel")}
        >
          {workstreamOptions.map((workstream) => (
            <option
              key={workstream.id}
              value={workstream.kind === "main" ? "" : workstream.id}
            >
              {workstream.kind === "main"
                ? t("newSessionWorkstreamMain")
                : workstream.label}
            </option>
          ))}
        </select>
        <span
          className="new-session-workstream-path"
          title={selectedWorkstream.path}
        >
          {shortenPath(selectedWorkstream.path)}
        </span>
      </label>
    ) : null;

  const providerSection =
    providers.length > 1 ? (
      <NewSessionOptionSection
        className={`new-session-provider-section ${styles.compactProviderSection}`}
        title={sessionDefaultCopy.provider.title}
        caption={sessionDefaultCopy.provider.description}
        showCaption={showOptionCaptions}
      >
        <div aria-busy={providersStale}>
          <FilterDropdown<ProviderName>
            label={sessionDefaultCopy.provider.title}
            options={providers.map((provider) => ({
              value: provider.name,
              label: provider.displayName,
              icon: (
                <span
                  className={`provider-option-dot provider-${provider.name}`}
                />
              ),
              description: [
                providerDescriptions[provider.name],
                !provider.installed
                  ? t("newSessionProviderStatusNotInstalled")
                  : !provider.authenticated && !provider.enabled
                    ? t("newSessionProviderStatusAuthenticationNeeded")
                    : null,
              ]
                .filter(Boolean)
                .join(" · "),
              disabled: !provider.installed,
            }))}
            selected={selectedProvider ? [selectedProvider] : []}
            onChange={([provider]) => {
              if (provider && !isStarting) handleProviderSelect(provider);
            }}
            multiSelect={false}
            fullWidth
            triggerContent={
              selectedProvider ? (
                <span className={styles.selectedChoice}>
                  <span
                    className={`provider-option-dot provider-${selectedProvider}`}
                    aria-hidden="true"
                  />
                  <span className={styles.selectedChoiceText}>
                    <span>
                      {selectedProviderInfo?.displayName ?? selectedProvider}
                    </span>
                    {selectedProviderInfo &&
                      !routerSelection &&
                      !selectedProviderInfo.authenticated &&
                      !selectedProviderInfo.enabled && (
                        <span className={styles.choiceStatus}>
                          {t("newSessionProviderStatusAuthenticationNeeded")}
                        </span>
                      )}
                  </span>
                </span>
              ) : undefined
            }
          />
        </div>
      </NewSessionOptionSection>
    ) : null;
  const modelField =
    selectedProvider && modelOptions.length > 0 ? (
      <NewSessionOptionSection
        className="new-session-model-field"
        title={sessionDefaultCopy.model.title}
        caption={sessionDefaultCopy.model.description}
        showCaption={showOptionCaptions}
      >
        <FilterDropdown
          panelVariant="model"
          label={sessionDefaultCopy.model.title}
          options={modelOptions}
          selected={selectedModel ? [selectedModel] : []}
          onChange={handleModelSelect}
          multiSelect={false}
          placeholder={t("newSessionModelPlaceholder")}
          fullWidth
          triggerClassName={styles.leftAlignedTrigger}
          triggerContent={
            selectedProvider && selectedModel ? (
              <span className={styles.selectedChoice}>
                <ProviderBadge
                  provider={selectedProvider}
                  model={selectedModel}
                />
                <span className={styles.selectedChoiceText}>
                  {modelOptions.find((option) => option.value === selectedModel)
                    ?.label ?? selectedModel}
                </span>
              </span>
            ) : undefined
          }
        />
      </NewSessionOptionSection>
    ) : null;
  const gatewayCatalogStatus =
    selectedProvider === "claude-gateway" &&
    (!selectedProviderQuery.fresh || availableModels.length === 0) ? (
      <div className="new-session-model-field">
        <h3>{sessionDefaultCopy.model.title}</h3>
        <div
          className="new-session-provider-catalog-status"
          role="status"
          aria-live="polite"
        >
          <span>
            {selectedProviderQuery.refreshing
              ? t("newSessionGatewayCatalogLoading")
              : t("newSessionGatewayCatalogUnavailable")}
          </span>
          <button
            type="button"
            className="new-session-provider-catalog-retry"
            disabled={selectedProviderQuery.refreshing}
            onClick={() => void selectedProviderQuery.refresh()}
          >
            {t("newSessionGatewayCatalogRetry")}
          </button>
        </div>
      </div>
    ) : null;
  const modelSection =
    modelField || gatewayCatalogStatus ? (
      <div className="new-session-model-section">
        {modelField}
        {gatewayCatalogStatus}
      </div>
    ) : null;
  const showThinkingSection = (
    <NewSessionOptionSection
      className="new-session-helper-section new-session-show-thinking-section"
      title={sessionDefaultCopy.showThinking.title}
      caption={sessionDefaultCopy.showThinking.description}
      showCaption={showOptionCaptions}
    >
      <FilterDropdown<"default" | "on" | "off">
        label={sessionDefaultCopy.showThinking.title}
        options={[
          { value: "default", label: t("showThinkingDefault") },
          { value: "on", label: t("showThinkingOn") },
          { value: "off", label: t("showThinkingOff") },
        ]}
        selected={[showThinking]}
        onChange={([value]) => setShowThinking(value ?? "default")}
        multiSelect={false}
        fullWidth
        triggerClassName={styles.leftAlignedTrigger}
      />
    </NewSessionOptionSection>
  );
  const effortSection = showThinkingControls ? (
    <NewSessionOptionSection
      className={`new-session-helper-section ${styles.effortSection}`}
      title={t("newSessionThinkingEffortTitle")}
      caption={sessionDefaultCopy.thinking.description}
      showCaption={showOptionCaptions}
    >
      <FilterDropdown<string>
        label={t("newSessionThinkingEffortTitle")}
        options={[
          ...thinkingModeOptions
            .filter((option) => option !== "on")
            .map((option) => ({
              value: option,
              label: t(
                option === "off"
                  ? "modelSettingsThinkingOffLabel"
                  : "modelSettingsThinkingAutoLabel",
              ),
              icon: <span className={`mode-option-dot thinking-${option}`} />,
            })),
          ...(thinkingModeOptions.includes("on")
            ? effortOptions.map((option) => ({
                value: `on:${option.value}`,
                label: option.label,
                icon: (
                  <span
                    className={`model-switch-indicator-dot tone-${option.value}`}
                  />
                ),
                description: showOptionCaptions
                  ? option.description
                  : undefined,
              }))
            : []),
        ]}
        selected={[
          effectiveThinkingMode === "on"
            ? `on:${effectiveEffortLevel}`
            : effectiveThinkingMode,
        ]}
        onChange={([selection]) => {
          if (!selection || isStarting) return;
          hasUserCustomizedDefaultsRef.current = true;
          if (selection === "off" || selection === "auto") {
            setSelectedThinkingMode(selection);
            return;
          }
          const nextEffort = effortOptions.find(
            (option) => selection === `on:${option.value}`,
          );
          if (!nextEffort) return;
          setSelectedEffortLevel(nextEffort.value);
          setSelectedThinkingMode("on");
        }}
        multiSelect={false}
        fullWidth
        triggerContent={
          <span className={styles.selectedChoice}>
            <span
              className={
                effectiveThinkingMode === "on"
                  ? `model-switch-indicator-dot tone-${effectiveEffortLevel}`
                  : `mode-option-dot thinking-${effectiveThinkingMode}`
              }
              aria-hidden="true"
            />
            <span className={styles.selectedChoiceText}>
              {effectiveThinkingMode === "on"
                ? (effortOptions.find(
                    (option) => option.value === effectiveEffortLevel,
                  )?.label ?? effectiveEffortLevel)
                : t(
                    effectiveThinkingMode === "off"
                      ? "modelSettingsThinkingOffLabel"
                      : "modelSettingsThinkingAutoLabel",
                  )}
            </span>
          </span>
        }
      />
    </NewSessionOptionSection>
  ) : null;
  const recapSection = selectedProvider ? (
    <NewSessionOptionSection
      className="new-session-helper-section"
      title={sessionDefaultCopy.recap.title}
      caption={getRecapModeDescription(selectedRecapMode, t, recapAfterSeconds)}
      showCaption={showOptionCaptions}
    >
      <FilterDropdown<RecapMode>
        label={sessionDefaultCopy.recap.title}
        options={availableRecapModes.map((modeValue) => ({
          value: modeValue,
          label: recapModeLabels[modeValue],
          icon: <span className={`mode-option-dot recap-${modeValue}`} />,
          description: showOptionCaptions
            ? getRecapModeDescription(modeValue, t, recapAfterSeconds)
            : undefined,
          disabled:
            isStarting ||
            (effectiveSandboxLevel === "project-write" &&
              modeValue === "side-session"),
        }))}
        selected={[selectedRecapMode]}
        onChange={([value]) => {
          if (isStarting) return;
          hasUserCustomizedDefaultsRef.current = true;
          setSelectedRecapMode(value ?? "off");
        }}
        multiSelect={false}
        fullWidth
        triggerContent={
          <span className={styles.selectedChoice}>
            <span
              className={`mode-option-dot recap-${selectedRecapMode}`}
              aria-hidden="true"
            />
            <span className={styles.selectedChoiceText}>
              {recapModeLabels[selectedRecapMode]}
            </span>
          </span>
        }
      />
      {selectedRecapMode !== "off" && (
        <RecapAfterSecondsControl
          value={recapAfterSeconds}
          disabled={isStarting}
          className={
            showOptionCaptions ? styles.captionedRecapDuration : undefined
          }
          label={
            showOptionCaptions
              ? recapAfterSecondsInlineLabels[selectedRecapMode]
              : undefined
          }
          mode={selectedRecapMode}
          onCommit={(seconds) => {
            hasUserCustomizedDefaultsRef.current = true;
            setRecapAfterSeconds(seconds);
          }}
        />
      )}
    </NewSessionOptionSection>
  ) : null;
  const helperSideModelSection = showHelperSideModel ? (
    <NewSessionOptionSection
      className="new-session-helper-section new-session-helper-model-section"
      title={sessionDefaultCopy.helperModel.title}
      caption={sessionDefaultCopy.helperModel.description}
      showCaption={showOptionCaptions}
    >
      <FilterDropdown
        label={sessionDefaultCopy.helperModel.title}
        options={helperSideModelOptions}
        selected={[helperSideModel]}
        onChange={(selected) => {
          hasUserCustomizedDefaultsRef.current = true;
          setHelperSideModel(selected[0] ?? HELPER_SIDE_MODEL_CHEAPEST);
        }}
        multiSelect={false}
        placeholder={t("helperSideModelCheapest")}
        fullWidth
        triggerClassName={styles.leftAlignedTrigger}
      />
    </NewSessionOptionSection>
  ) : null;
  const promptSuggestionSection = selectedProvider ? (
    <NewSessionOptionSection
      className="new-session-helper-section"
      title={sessionDefaultCopy.suggestions.title}
      caption={promptSuggestionModeDescriptions[selectedPromptSuggestionMode]}
      showCaption={showOptionCaptions}
    >
      <FilterDropdown<PromptSuggestionMode>
        label={sessionDefaultCopy.suggestions.title}
        options={availablePromptSuggestionModes.map((modeValue) => ({
          value: modeValue,
          label: promptSuggestionModeLabels[modeValue],
          icon: <span className={`mode-option-dot suggestion-${modeValue}`} />,
          description: showOptionCaptions
            ? promptSuggestionModeDescriptions[modeValue]
            : undefined,
          disabled: isStarting,
        }))}
        selected={[selectedPromptSuggestionMode]}
        onChange={([value]) => {
          if (isStarting) return;
          hasUserCustomizedDefaultsRef.current = true;
          setSelectedPromptSuggestionMode(value ?? "off");
        }}
        multiSelect={false}
        fullWidth
        triggerContent={
          <span className={styles.selectedChoice}>
            <span
              className={`mode-option-dot suggestion-${selectedPromptSuggestionMode}`}
              aria-hidden="true"
            />
            <span className={styles.selectedChoiceText}>
              {promptSuggestionModeLabels[selectedPromptSuggestionMode]}
            </span>
          </span>
        }
      />
    </NewSessionOptionSection>
  ) : null;
  const permissionSection = supportsPermissionMode ? (
    <NewSessionOptionSection
      className="new-session-mode-section"
      title={sessionDefaultCopy.permission.title}
      showCaption={showOptionCaptions}
    >
      <FilterDropdown<PermissionMode>
        label={sessionDefaultCopy.permission.title}
        options={permissionModeOptions.map((permissionMode) => ({
          value: permissionMode,
          label: modeLabels[permissionMode],
          icon: <span className={`mode-option-dot mode-${permissionMode}`} />,
          description: modeDescriptions[permissionMode],
          disabled: isStarting,
        }))}
        selected={[effectivePermissionMode]}
        onChange={([value]) => {
          if (value && !isStarting) handleModeSelect(value);
        }}
        multiSelect={false}
        fullWidth
        triggerContent={
          <span className={styles.selectedChoice}>
            <span
              className={`mode-option-dot mode-${effectivePermissionMode}`}
              aria-hidden="true"
            />
            <span className={styles.selectedChoiceText}>
              {modeLabels[effectivePermissionMode]}
            </span>
          </span>
        }
      />
    </NewSessionOptionSection>
  ) : null;
  const sandboxSection = canConfigureSessionSandbox ? (
    <>
      {!launchLock.limited && (
        <NewSessionOptionSection
          className="new-session-helper-section new-session-sandbox-section"
          title={sessionDefaultCopy.sandbox.title}
          caption={sessionDefaultCopy.sandbox.description}
          showCaption={showOptionCaptions}
        >
          <FilterDropdown<SessionSandboxLevel>
            label={sessionDefaultCopy.sandbox.title}
            options={[
              { value: "none", label: t("recapModeOff"), disabled: isStarting },
              {
                value: "project-write",
                label: t("newSessionSandboxLabel"),
                description: showOptionCaptions
                  ? sessionDefaultCopy.sandbox.description
                  : undefined,
                disabled: isStarting,
              },
            ]}
            selected={[sandboxLevel]}
            onChange={([value]) => {
              if (isStarting) return;
              const enabled = value === "project-write";
              hasUserCustomizedDefaultsRef.current = true;
              setSandboxLevel(enabled ? "project-write" : "none");
              if (enabled) {
                setSandboxNetworkFirewall(true);
              }
              if (enabled && selectedRecapMode === "side-session") {
                setSelectedRecapMode("off");
              }
            }}
            multiSelect={false}
            fullWidth
            triggerClassName={styles.leftAlignedTrigger}
          />
          {sandboxLocalAuthOpen && (
            <p
              className={styles.optionWarning}
              data-new-session-sandbox-local-auth-warning="true"
            >
              {t("newSessionSandboxLocalAuthWarning")}
            </p>
          )}
        </NewSessionOptionSection>
      )}
      {effectiveSandboxLevel === "project-write" && !launchLock.limited && (
        <NewSessionOptionSection
          className="new-session-helper-section new-session-sandbox-firewall-section"
          title={sessionDefaultCopy.sandboxFirewall.title}
          caption={sessionDefaultCopy.sandboxFirewall.description}
          showCaption={showOptionCaptions}
        >
          <FilterDropdown<"on" | "off">
            label={sessionDefaultCopy.sandboxFirewall.title}
            options={[
              { value: "on", label: t("showThinkingOn"), disabled: isStarting },
              {
                value: "off",
                label: t("showThinkingOff"),
                description: showOptionCaptions
                  ? sessionDefaultCopy.sandboxFirewall.description
                  : undefined,
                disabled: isStarting,
              },
            ]}
            selected={[sandboxNetworkFirewall ? "on" : "off"]}
            onChange={([value]) => {
              if (isStarting) return;
              hasUserCustomizedDefaultsRef.current = true;
              setSandboxNetworkFirewall(value === "on");
            }}
            multiSelect={false}
            fullWidth
            triggerClassName={styles.leftAlignedTrigger}
          />
        </NewSessionOptionSection>
      )}
    </>
  ) : sessionSandboxUnavailableReason ? (
    <NewSessionOptionSection
      className="new-session-helper-section new-session-sandbox-section"
      title={sessionDefaultCopy.sandbox.title}
      showCaption={showOptionCaptions}
    >
      <p
        className={styles.optionCaption}
        data-new-session-sandbox-unavailable="true"
      >
        {sessionSandboxUnavailableReason}
      </p>
    </NewSessionOptionSection>
  ) : null;
  // What this account settles, stated where the withheld pickers would sit.
  // An effort this client cannot name is stated as stored.
  const lockedEffortLevel = knownLockedEffort(launchLock);
  const fixedLaunchSection = launchLock.limited ? (
    <NewSessionFixedLaunch
      lock={launchLock}
      modelLabel={
        launchLock.model
          ? (visibleModels.find((model) => model.id === launchLock.model)
              ?.name ?? null)
          : null
      }
      effortLabel={
        lockedEffortLevel
          ? getEffortLevelLabel(lockedEffortLevel, selectedProviderInfo, t)
          : null
      }
      sandboxAvailable={supportsSessionSandboxing}
    />
  ) : null;
  // Withholding every picker in this slot would otherwise leave its grid area
  // empty rather than giving the width back, so the layout drops the area.
  const providerSlotFilled = Boolean(
    fixedLaunchSection ||
      (showProviderPicker && providerSection) ||
      (showModelPicker && modelSection) ||
      effortSection,
  );
  const activeAdvancedOptions = [
    effectivePermissionMode !== "default"
      ? `${sessionDefaultCopy.permission.title}: ${modeLabels[effectivePermissionMode]}`
      : null,
    showThinking !== "default"
      ? `${sessionDefaultCopy.showThinking.title}: ${showThinking === "on" ? t("showThinkingOn") : t("showThinkingOff")}`
      : null,
    selectedRecapMode !== "off"
      ? `${sessionDefaultCopy.recap.title}: ${recapModeLabels[selectedRecapMode]}`
      : null,
    selectedPromptSuggestionMode !== "off"
      ? `${sessionDefaultCopy.suggestions.title}: ${promptSuggestionModeLabels[selectedPromptSuggestionMode]}`
      : null,
    effectiveSandboxLevel === "project-write"
      ? sessionDefaultCopy.sandbox.title
      : null,
    machineControlSelected && machineControlEligible
      ? t("newSessionMachineControlTitle")
      : null,
    effectiveExecutor
      ? `${t("newSessionRunOnTitle")}: ${effectiveExecutor}`
      : null,
  ].filter((label): label is string => label !== null);

  // Compact mode: just the input area, no header or mode selector
  if (compact) {
    return (
      <div
        className="new-session-form new-session-form-compact"
        onKeyDownCapture={handleComposerKeyDown}
      >
        {inputArea}
      </div>
    );
  }

  // Full mode: form with header, input area, and mode selector
  return (
    <div
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
            {!launch && supportsProjectQueue && projectQueueTargetProjectId && (
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
            {workstreamChooser}
          </aside>
        )}
        {templateChoices?.enabled && !launch && !fixedProject && (
          <div
            className={styles.templateProjectSlot}
            hidden={!creatingTemplateProject}
          >
            <TemplateProjectForm
              key={clientSummarySourceKey}
              templates={templateChoices.templates}
              emptyMessage={templateError ?? t(emptyMessageKey)}
              projects={projects}
              pathBase={newProjectBase}
              initialName={
                projects.some((project) => project.path === projectInput)
                  ? ""
                  : projectInput
              }
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
                    : effectiveExecutor
                      ? t("templateLocalOnly")
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
        {providerSlotFilled && (
          <div className="new-session-provider-slot">
            {fixedLaunchSection}
            {showProviderPicker && providerSection}
            {showModelPicker && modelSection}
            {effortSection}
          </div>
        )}
        <div className={styles.advancedSection}>
          <button
            type="button"
            className={styles.advancedToggle}
            aria-expanded={showAdvancedOptions}
            aria-controls="new-session-advanced-options"
            onClick={() => {
              const expanded = !showAdvancedOptions;
              setShowAdvancedOptions(expanded);
              localStorage.setItem(
                UI_KEYS.newSessionAdvancedOptionsExpanded,
                String(expanded),
              );
            }}
          >
            <span>
              {t(
                showAdvancedOptions
                  ? "newSessionHideAdvancedOptions"
                  : "newSessionShowAdvancedOptions",
              )}
            </span>
            <span aria-hidden="true">{showAdvancedOptions ? "▴" : "▾"}</span>
          </button>
          {!showAdvancedOptions && activeAdvancedOptions.length > 0 && (
            <span className={styles.advancedSummary}>
              {activeAdvancedOptions.join(" · ")}
            </span>
          )}
          <button
            type="button"
            className={styles.captionToggle}
            aria-label={
              showOptionCaptions
                ? t("newSessionHideOptionCaptions")
                : t("newSessionShowOptionCaptions")
            }
            aria-pressed={showOptionCaptions}
            title={
              showOptionCaptions
                ? t("newSessionHideOptionCaptions")
                : t("newSessionShowOptionCaptions")
            }
            onClick={() => setShowOptionCaptions((shown) => !shown)}
          >
            <span aria-hidden="true">?</span>
          </button>
        </div>
        <div
          id="new-session-advanced-options"
          className={`${styles.secondaryOptions}${
            isProjectChooserExpanded ? ` ${styles.secondaryOptionsHidden}` : ""
          }`}
          data-new-session-secondary-options="true"
          hidden={!showAdvancedOptions}
        >
          {serverHasCapability(
            versionInfo,
            SERVER_CAPABILITIES.agentAuthRouter.name,
          ) &&
            !launchLock.limited &&
            !effectiveExecutor &&
            effectiveSandboxLevel === "none" &&
            (selectedProvider === "claude" || selectedProvider === "codex") && (
              <RouterPoolSelector
                provider={selectedProvider}
                model={selectedModel}
                thinking={routerThinking}
                data={routerDiscovery.data}
                busy={routerDiscovery.busy}
                error={routerDiscovery.error}
                retry={() => void routerDiscovery.reload()}
                sourceKey={clientSummarySourceKey}
                value={
                  routerSelection?.sourceKey === clientSummarySourceKey
                    ? routerSelection
                    : null
                }
                onChange={setRouterSelection}
                disabled={isStarting}
              />
            )}
          {permissionSection}
          {showThinkingSection}
          {recapSection}
          {helperSideModelSection}
          {promptSuggestionSection}
          {sandboxSection}
          <MachineControlSessionSelection
            eligible={machineControlEligible}
            selected={machineControlSelected}
            onChange={selectMachineControl}
            disabled={isStarting}
            showCaption={showOptionCaptions}
          />
          {/* Executor Selection - only show for providers whose adapter uses it. */}
          {supportsRemoteExecutors &&
            !executorsLoading &&
            remoteExecutors.length > 0 && (
              <NewSessionOptionSection
                className="new-session-helper-section"
                title={t("newSessionRunOnTitle")}
                showCaption={showOptionCaptions}
              >
                <FilterDropdown<string>
                  label={t("newSessionRunOnTitle")}
                  options={[
                    {
                      value: "local",
                      label: t("newSessionRunOnLocal"),
                      icon: (
                        <span className="executor-option-dot executor-local" />
                      ),
                      description: t("newSessionRunOnLocalDesc"),
                      disabled: isStarting,
                    },
                    ...remoteExecutors.map((host) => ({
                      value: `remote:${host}`,
                      label: host,
                      icon: (
                        <span className="executor-option-dot executor-remote" />
                      ),
                      description: t("newSessionRunOnRemoteDesc"),
                      disabled: isStarting,
                    })),
                  ]}
                  selected={[
                    selectedExecutor ? `remote:${selectedExecutor}` : "local",
                  ]}
                  onChange={([value]) => {
                    if (isStarting) return;
                    setSelectedExecutor(
                      value?.startsWith("remote:") ? value.slice(7) : null,
                    );
                  }}
                  multiSelect={false}
                  fullWidth
                  triggerContent={
                    <span className={styles.selectedChoice}>
                      <span
                        className={`executor-option-dot executor-${selectedExecutor ? "remote" : "local"}`}
                        aria-hidden="true"
                      />
                      <span className={styles.selectedChoiceText}>
                        {selectedExecutor ?? t("newSessionRunOnLocal")}
                      </span>
                    </span>
                  }
                />
              </NewSessionOptionSection>
            )}
        </div>
      </div>
    </div>
  );
}
