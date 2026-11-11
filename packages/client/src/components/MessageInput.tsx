import { MessageInputKeyboardSlot } from "./MessageInputKeyboardSlot";
import {
  ForkSummaryDraftNotice,
  ComposerPromptSuggestion,
} from "./ComposerDraftNotices";
import { composerActionsStateClasses } from "./composerStateClasses";
import actionStyles from "./ComposerActions.module.css";
import voiceStyles from "./VoiceInputButton.module.css";
import slashStyles from "./SlashCommandButton.module.css";
import { DraftSyncNotice } from "./DraftSyncNotice";
import { AudioMemoPanel } from "./AudioMemoPanel";
import { ComposerRecallMenu } from "./ComposerRecallMenu";
import { ComposerRecents } from "./ComposerRecents";
import { useComposerHistoryScope } from "../hooks/useComposerHistoryScope";
import { NewSessionQueueMark } from "./NewSessionQueueMark";
import { useComposerVoiceRef } from "../hooks/useComposerVoiceRef";
import { escapeInterruptDisabledSetting } from "../hooks/useEscapeInterruptDisabled";
import {
  type ChosenNewSessionQueueTarget,
  type NewSessionQueueTarget,
  NewSessionQueueOptions,
} from "./NewSessionQueueOptions";
import {
  DEFAULT_PATIENT_QUEUE_PATIENCE_SECONDS,
  DEFAULT_PROJECT_QUEUE_CTRL_ENTER_ENABLED,
  DEFAULT_STEER_NOW_ENABLED,
  type BusyComposerDefaultAction,
  clampPatientPatienceSeconds,
  commandMatchesInvocationQuery,
  type CollapsedComposerButtonPreference,
  type EffortLevel,
  type FileViewLineTarget,
  findSkillInvocations,
  findUnrecognizedInvocations,
  getCanonicalInvocationToken,
  getInvocationCompletionQuery,
  getInvocationNames,
  normalizePatientCompactPercent,
  PATIENT_TOPIC_SHIFT_CAPABILITY,
  serverHasCapability,
  type SessionLivenessSnapshot,
  type SlashCommand,
  type ThinkingMode,
  type UserMessageDeliveryIntent,
  type UserMessageSpeechMetadata,
} from "@yep-anywhere/shared";
import {
  Fragment,
  type ClipboardEvent,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  type DraftControls,
  useDraftPersistence,
} from "../hooks/useDraftPersistence";
import { useKeepMobileKeyboardOpenAfterDelivery } from "../hooks/useKeepMobileKeyboardOpenAfterDelivery";
import { useSessionToolbarPresence } from "../hooks/useSessionToolbarPresence";
import { useSpeechCaptureSettings } from "../hooks/useSpeechCaptureSettings";
import { useRecentSpeechAttribution } from "../hooks/useRecentSpeechAttribution";
import { useVersion } from "../hooks/useVersion";
import { useI18n } from "../i18n";
import type { ClientSummarySourceKey } from "../lib/clientSummaryStore";
import type { BtwToolbarMode } from "../lib/btwAsideRouting";
import { formatFileSize } from "../lib/formatFileSize";
import type { TranscriptPositionStore } from "../lib/transcriptPositionStore";
import {
  getDraftTextChangeMetadata,
  type DraftTextChangeMetadata,
  type DraftTextEdit,
} from "../lib/commentAnchors";
import {
  clearTextareaContentsUndoably,
  getComposerViewportHeight,
  countDraftLines,
  getInsertedTextForEdit,
  isFullPaneComposerShortcut,
  replaceTextareaRangeUndoably,
  resizeComposerTextarea,
  scrollCollapsedTextareaToCursor,
} from "../lib/composerTextarea";
import type { ComposerTurnRecallEntry } from "../lib/composerTurnRecall";
import {
  getClipboardFiles,
  handleSpeechEscapeKey,
  isComposerEnterSend,
} from "../lib/composerKeys";
import { hasCoarsePointer } from "../lib/deviceDetection";
import { MOBILE_KEYBOARD_OPEN_VIEWPORT_RATIO } from "../lib/mobileKeyboardViewport";
import type { SpeechTranscriptionContext } from "../lib/speechProviders/SpeechProvider";
import {
  getSpeechInterimPreview,
  getSpeechVisibleDraftText,
  textBeforeSpeechCursor,
} from "../lib/speechRecognition";
import {
  applyBangCompletion,
  longestCommonPrefix,
  resolveComposerBangDraft,
} from "../lib/bangCommands";
import {
  type BangCompletionSource,
  type BangMenuItem,
  bangCompletionQueryKey,
  useComposerBangCompletion,
} from "../hooks/useComposerBangCompletion";
import { useComposerRecallDrawer } from "../hooks/useComposerRecallDrawer";
import { useComposerSpeechHandlers } from "../hooks/useComposerSpeechHandlers";
import {
  type SubmissionCompositionSnapshot,
  useComposerDelivery,
} from "../hooks/useComposerDelivery";
import { useComposerSpeechState } from "../hooks/useComposerSpeechState";
import {
  getSlashCommandArgumentCompletionMatches,
  getSlashCommandMenuParts,
  type SlashCommandArgumentCompletionMatch,
} from "../lib/slashCommands";
import { createClientSpeechTurnId } from "../lib/speechTargets";
import { handleVoiceInputShortcutKeyDown } from "../lib/voiceInputShortcut";

import { hasComposerDraftContent } from "../lib/sessionComposerSubmission";
import type {
  ContextUsage,
  PermissionMode,
  ProviderRuntimeStatus,
} from "../types";
import type { MessageSubmissionMetadata } from "../types/messageSubmission";
import { AttachmentChip } from "./AttachmentChip";
import chipStyles from "./AttachmentChip.module.css";
import { DeliveryGlyph } from "./DeliveryGlyph";
import { FullPaneComposerToggle } from "./FullPaneComposerToggle";
import {
  MessageInputToolbar,
  type MessageInputToolbarProps,
} from "./MessageInputToolbar";
import { SpeechDraftField } from "./SpeechDraftField";
import { SpeechPrefixActionCue } from "./SpeechPrefixActionCue";
import { VoiceInputButton, type VoiceInputButtonRef } from "./VoiceInputButton";
import styles from "./MessageInput.module.css";
import { useFileViewCompletion } from "../hooks/useFileViewCompletion";
import { useProjectFileCompletion } from "../hooks/useProjectFileCompletion";
import type { RenderItem } from "@yep-anywhere/shared/transcript/items";
import { FileViewCompletionSheet } from "./FileViewCompletionSheet";
import { RendezAttachment } from "./RendezAttachment";
import { ProjectFileCompletionMenu } from "./ProjectFileCompletionMenu";
import { QuestionAsideHint } from "./QuestionAsideCard";

/** Progress info for an in-flight upload */
export interface UploadProgress {
  fileId: string;
  fileName: string;
  bytesUploaded: number;
  totalBytes: number;
  percent: number;
}

export interface MessageInputAttachment {
  id: string;
  originalName: string;
  path?: string;
  mimeType: string;
  size: number;
  width?: number;
  height?: number;
  previewUrl?: string;
  rendezAutoSendAt?: number | null;
  rendezPath?: string;
}

export interface FullPaneComposerControls {
  restore: () => void;
}

export type { MessageSubmissionMetadata } from "../types/messageSubmission";

interface PendingDraftInputEdit {
  start: number;
  end: number;
  inputType?: string;
}

interface Props {
  onVoiceControl?: (control: VoiceInputButtonRef | null) => void;
  onSend: (text: string, metadata?: MessageSubmissionMetadata) => void;
  questionAside?: {
    canAsk: boolean;
    onAsk: (rawText: string) => boolean;
    onSave?: () => void;
    onDismiss?: () => void;
  };
  /** Queue a deferred message (sent when agent's turn ends). Only provided when agent is running. */
  onQueue?: (text: string, metadata?: MessageSubmissionMetadata) => void;
  /** Queue through the project-level idle gate. Hidden unless opted in. */
  onProjectQueue?: (text: string, metadata?: MessageSubmissionMetadata) => void;
  /**
   * Queue this draft as the opening turn of a new session: in this project
   * with this session's settings, or at a target chosen from its options.
   */
  onProjectQueueNewSession?: (
    text: string,
    metadata?: MessageSubmissionMetadata,
    target?: ChosenNewSessionQueueTarget,
  ) => void;
  /**
   * What the new-session options start from. Present enables choosing another
   * project, provider or model by right-click or long-press.
   */
  projectQueueNewSessionTarget?: NewSessionQueueTarget;
  disabled?: boolean;
  placeholder?: string;
  mode?: PermissionMode;
  onModeChange?: (mode: PermissionMode) => void;
  /** Permission mode changes are visibly staged for the next user turn. */
  modeChangesApplyNextTurn?: boolean;
  /** Selected permission mode is waiting for a provider turn boundary. */
  modeChangePending?: boolean;
  isRunning?: boolean;
  isThinking?: boolean;
  onStop?: () => void;
  onDone?: () => void;
  doneTitle?: string;
  draftKey: string; // localStorage key for draft persistence
  draftIndex?: {
    sourceKey: ClientSummarySourceKey;
    sessionId: string;
  };
  /** Collapse to single-line but keep visible and focusable (for when approval panel is showing) */
  collapsed?: boolean;
  /** Expose full-pane controls to a parent that coordinates adjacent UI. */
  onFullPaneControlsReady?: (controls: FullPaneComposerControls | null) => void;
  /** Callback to receive draft controls for success/failure handling */
  onDraftControlsReady?: (controls: DraftControls) => void;
  /** Notify parent of draft edits for UI linked to the composer text. */
  onDraftTextChange?: (text: string, metadata: DraftTextChangeMetadata) => void;
  /** Context usage for displaying usage indicator */
  contextUsage?: ContextUsage;
  /** Last session activity timestamp for stale composer liveness display. */
  lastActivityAt?: string | null;
  /** Timestamp for the hovered/scrolled transcript position, shown near activity age. */
  positionTimestampMs?: number | null;
  /** Latest-wins transcript position source for the status line. */
  positionTimestampStore?: TranscriptPositionStore;
  /** Server-derived provider/session liveness evidence. */
  sessionLiveness?: SessionLivenessSnapshot | null;
  /** Provider-owned retry/failure status for the active turn. */
  providerRuntimeStatus?: ProviderRuntimeStatus;
  /** Project ID for uploads (required to enable attach button) */
  projectId?: string;
  completionRenderItems?: RenderItem[];
  speechVocabulary?: { terms(): string[]; heard(text: string): void };
  /** Session ID for uploads (required to enable attach button) */
  sessionId?: string;
  /** Completed file attachments */
  attachments?: MessageInputAttachment[];
  /** Callback when user selects files to attach */
  onAttach?: (files: File[]) => void;
  /** Resolves only once the audio memo is retained by the attachment pipeline. */
  onAttachAudioMemo?: (file: File) => Promise<void>;
  /** Callback when user removes an attachment */
  onRemoveAttachment?: (id: string) => void;
  /** Progress info for in-flight uploads */
  uploadProgress?: UploadProgress[];
  /** Whether the provider supports permission modes (default: true) */
  supportsPermissionMode?: boolean;
  /** Whether the provider supports thinking toggle (default: true) */
  supportsThinkingToggle?: boolean;
  /** Whether the provider supports active turn steering (default: false) */
  supportsSteering?: boolean;
  /** Whether provider steering supports soft-immediate in-flight generation abort. */
  supportsSteerNow?: boolean;
  /** Initial per-turn "now" toggle state; a click overrides it here. */
  steerNowDefault?: boolean;
  /** Current behavior of the primary composer action. */
  primaryActionKind?: "send" | "steer" | "queue";
  /** Available provider and client commands. */
  slashCommands?: SlashCommand[];
  /** Callback for custom client-side commands (e.g., "model"). Return true if handled. */
  onCustomCommand?: (command: string) => boolean;
  /**
   * Offer `/v` file-view completion. Set only where the owner handles a
   * submitted `/v` (topics/view-command.md); `open` shows a result without
   * submitting the draft (Ctrl+Enter).
   */
  fileViewCommand?: {
    open: (path: string, line?: FileViewLineTarget) => void;
  };
  /** Start a /btw aside. When text is present, the caller may send it immediately. */
  onBtwShortcut?: (text: string) => boolean;
  /** Whether this composer is currently routing sends to a focused /btw aside. */
  btwActive?: boolean;
  /** Whether this session has an active /btw aside available to focus. */
  btwHasAsides?: boolean;
  /** Explicit /btw toolbar display state when focus and footer routing differ. */
  btwToolbarMode?: BtwToolbarMode;
  /** Provider/model context used by the thinking effort chooser. */
  thinkingProvider?: string;
  thinkingModel?: string;
  /** Live process thinking selection for owned active sessions. */
  liveThinkingSelection?: {
    mode: ThinkingMode;
    level: EffortLevel;
    onSetMode: (mode: ThinkingMode) => void;
    onSetEffort: (level: EffortLevel) => void;
  };
  /** YA model id for the context quick-edit's per-model threshold keying. */
  contextRequestedModel?: string;
  /** Current quiet-period timeout used by patient queue mode. */
  patientQueuePatienceSeconds?: number | null;
  /** Whether the current draft will be sent as a correction to the latest user turn */
  correctionActive?: boolean;
  /** Cancel correction mode and clear the restored draft */
  onCancelCorrection?: () => void;
  /** Restore the last sent/queued text when the composer is blank */
  onRecallLastSubmission?: () => boolean;
  /** Cancel the newest cancellable queued message. */
  onCancelLatestDeferred?: () => boolean;
  /** Predicted next user prompt from the SDK; shown as a ghost/chip below the composer. */
  promptSuggestion?: string;
  /** Dismiss the current prompt suggestion without acting on it. */
  onDismissPromptSuggestion?: () => void;
  /** Temporary mode for entering fork-after-summary instructions. */
  forkSummaryMode?: {
    title: string;
    description: string;
    placeholder: string;
    submitLabel: string;
    tooltip: string;
    icon: string;
    noSummarySubmitLabel?: string;
    noSummaryTooltip?: string;
    noSummaryIcon?: string;
    submitting?: boolean;
    onCancel: () => void;
    onSubmit: (instructions: string) => void;
    onSubmitWithoutSummary?: (text: string) => void;
  };
  /** Composer shortcut for fork-after-summary using current draft as instructions. */
  onForkSummaryShortcut?: (instructions: string) => boolean | undefined;
  /**
   * `!!` bang-command support: routes bang drafts to a local run instead of
   * the provider, serves tab completions, and exposes Ctrl+↑ history.
   * Absent on composers without a wired bang path.
   */
  bangSupport?: {
    onRun: (command: string) => Promise<void>;
    fetchCompletions: BangCompletionSource["fetchCompletions"];
    history: readonly string[];
  };
  /**
   * Prior user turns for the always-on Ctrl+↑ composer recall drawer,
   * newest-first. `onGoToTurn`, when provided, powers the per-row go-to
   * control that scrolls the transcript to that turn by its render id
   * (navigation only — no composer/draft change). See
   * topics/composer-recall-drawer.md.
   */
  turnRecall?: {
    entries: ComposerTurnRecallEntry[];
    onGoToTurn?: (id: string) => void;
  };
}

export function MessageInput({
  onVoiceControl,
  onSend,
  questionAside,
  onQueue,
  onProjectQueue,
  onProjectQueueNewSession,
  projectQueueNewSessionTarget,
  disabled,
  placeholder,
  mode = "default",
  onModeChange,
  modeChangesApplyNextTurn,
  modeChangePending,
  isRunning,
  isThinking,
  onStop,
  onDone,
  doneTitle,
  draftKey,
  draftIndex,
  collapsed: externalCollapsed,
  onFullPaneControlsReady,
  onDraftControlsReady,
  onDraftTextChange,
  contextUsage,
  lastActivityAt,
  positionTimestampMs,
  positionTimestampStore,
  sessionLiveness,
  providerRuntimeStatus,
  projectId,
  completionRenderItems,
  speechVocabulary,
  sessionId,
  attachments = [],
  onAttach,
  onAttachAudioMemo,
  onRemoveAttachment,
  uploadProgress = [],
  supportsPermissionMode = true,
  supportsThinkingToggle = true,
  supportsSteering = false,
  supportsSteerNow = false,
  steerNowDefault = DEFAULT_STEER_NOW_ENABLED,
  primaryActionKind,
  slashCommands = [],
  onCustomCommand,
  fileViewCommand,
  onBtwShortcut,
  btwActive = false,
  btwHasAsides = false,
  btwToolbarMode,
  thinkingProvider,
  thinkingModel,
  liveThinkingSelection,
  contextRequestedModel,
  patientQueuePatienceSeconds,
  correctionActive = false,
  onCancelCorrection,
  onRecallLastSubmission,
  onCancelLatestDeferred,
  promptSuggestion,
  onDismissPromptSuggestion,
  forkSummaryMode,
  onForkSummaryShortcut,
  bangSupport,
  turnRecall,
}: Props) {
  const { t } = useI18n();
  const { visibility: toolbarVisibility } = useSessionToolbarPresence();
  const { keepMobileKeyboardOpenAfterDelivery } =
    useKeepMobileKeyboardOpenAfterDelivery();
  const [text, setText, controls] = useDraftPersistence(draftKey, {
    sessionDraft: draftIndex,
  });
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const untouchedRecallRef = useRef<string | null>(null);
  const positionedRecallVersionRef = useRef(0);
  const [recallVersion, setRecallVersion] = useState(0);
  useLayoutEffect(() => {
    if (!correctionActive) untouchedRecallRef.current = null;
    if (positionedRecallVersionRef.current !== recallVersion) {
      positionedRecallVersionRef.current = recallVersion;
      untouchedRecallRef.current = text;
      textareaRef.current?.setSelectionRange(text.length, text.length);
    }
  }, [text, correctionActive, recallVersion]);
  const [isComposing, setIsComposing] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [audioMemoOpen, setAudioMemoOpen] = useState(false);
  const [attachmentPanelOpen, setAttachmentPanelOpen] = useState(false);
  const historyScope = useComposerHistoryScope();
  const voiceButtonRef = useRef<VoiceInputButtonRef>(null);
  const sharedVoiceRef = useComposerVoiceRef(voiceButtonRef, onVoiceControl);
  const typingStartedAtRef = useRef<string | null>(null);
  const lastEditedAtRef = useRef<string | null>(null);
  const {
    speechState,
    interimTranscript,
    setInterimTranscript,
    interimTranscriptRef,
    speechPending,
    speechPendingRef,
    speechTurnIdRef,
    speechInsertionRangeRef,
    activeSpeechTargetIdRef,
    speechInsertionRangesRef,
    pendingSpeechRetargetRef,
    pendingSpeechFinalRef,
    clearPendingSpeechFinal,
    noteSpeechDraftEdit,
    noteSpeechDraftReplacement,
    restorePendingTextareaSelection,
  } = useComposerSpeechState();
  const speechTranscriptionIdsRef = useRef<string[]>([]);
  const pendingDraftInputRef = useRef<PendingDraftInputEdit | null>(null);
  const draftTextChangeMetadataRef = useRef<DraftTextChangeMetadata | null>(
    null,
  );
  const keyboardViewportBaselineRef = useRef<number | null>(null);
  // User-controlled collapse state (independent of external collapse from approval panel)
  const [userCollapsed, setUserCollapsed] = useState(false);
  const [fullPane, setFullPane] = useState(false);
  const [newSessionOptionsMode, setNewSessionOptionsMode] = useState<
    "now" | "patient" | null
  >(null);
  const newSessionOptionsFormRef = useRef<HTMLFormElement>(null);
  const { asrAttributionMs, speechMessagePrefix } = useSpeechCaptureSettings();
  const {
    active: speechAttributionActive,
    noteSpeech: noteSpeechAttribution,
    isRecent: isRecentSpeechAttribution,
    consume: consumeSpeechAttribution,
  } = useRecentSpeechAttribution(asrAttributionMs);
  const [keyboardWaveformActive, setKeyboardWaveformActive] = useState(false);
  const [dismissedSlashQuery, setDismissedSlashQuery] = useState<string | null>(
    null,
  );
  const [selectedSlashIndex, setSelectedSlashIndex] = useState(0);
  const [composerCursor, setComposerCursor] = useState(text.length);
  const [textareaFocused, setTextareaFocused] = useState(false);
  const [textareaImeGeneration, setTextareaImeGeneration] = useState(0);
  const [mobileKeyboardOpen, setMobileKeyboardOpen] = useState(false);
  const [mobileKeyboardMoreOpen, setMobileKeyboardMoreOpen] = useState(false);

  // Panel is collapsed if user collapsed it OR if externally collapsed (approval panel showing)
  const collapsed = userCollapsed || externalCollapsed;
  const hasNonTextComposerContent =
    attachments.length > 0 || uploadProgress.length > 0;
  const composerIsEmpty = !hasComposerDraftContent(
    text,
    attachments.length + uploadProgress.length,
  );
  const questionAsideEligible =
    !!questionAside?.canAsk &&
    !btwActive &&
    !forkSummaryMode &&
    !correctionActive &&
    !hasNonTextComposerContent &&
    !disabled;
  const showQuestionAsideHint =
    questionAsideEligible &&
    text.endsWith("?") &&
    !text.trimStart().startsWith("/") &&
    !text.trimStart().startsWith("!!");
  const canSaveQuestionAside =
    !!questionAside?.onSave &&
    !forkSummaryMode &&
    text.length === 0 &&
    !hasNonTextComposerContent &&
    !isComposing &&
    speechPending === null &&
    !interimTranscript;
  const invocationQuery = getInvocationCompletionQuery(text, composerCursor);
  const matchingSlashArgumentCompletions = useMemo(
    () =>
      getSlashCommandArgumentCompletionMatches(
        text,
        slashCommands,
        composerCursor,
      ),
    [composerCursor, slashCommands, text],
  );
  const argumentCompletionQuery = matchingSlashArgumentCompletions[0];
  const slashQueryKey = invocationQuery
    ? `${invocationQuery.start}:${invocationQuery.end}:${invocationQuery.sigil}:${invocationQuery.query}`
    : argumentCompletionQuery
      ? `${argumentCompletionQuery.start}:${argumentCompletionQuery.end}:argument:${argumentCompletionQuery.query}`
      : null;
  const matchingSlashCommands = useMemo(() => {
    if (!invocationQuery || matchingSlashArgumentCompletions.length > 0)
      return [];
    const matched = slashCommands.filter((command) =>
      commandMatchesInvocationQuery(command, invocationQuery),
    );
    const preferredByName = new Map<string, SlashCommand>();
    for (const command of matched) {
      const normalizedName = command.name.trim().toLowerCase();
      const existing = preferredByName.get(normalizedName);
      if (
        !existing ||
        (invocationQuery.leading &&
          invocationQuery.sigil === "/" &&
          existing.invocation?.kind === "skill" &&
          command.invocation?.kind !== "skill")
      ) {
        preferredByName.set(normalizedName, command);
      }
    }
    return matched.filter(
      (command) =>
        preferredByName.get(command.name.trim().toLowerCase()) === command,
    );
  }, [invocationQuery, slashCommands, matchingSlashArgumentCompletions.length]);
  const hasExactSlashCommand =
    invocationQuery !== null &&
    slashCommands.some((command) =>
      getInvocationNames(command).includes(invocationQuery.query),
    );
  const slashSuggestionCount =
    matchingSlashCommands.length + matchingSlashArgumentCompletions.length;
  const showSlashSuggestions =
    !collapsed &&
    !disabled &&
    (invocationQuery !== null || matchingSlashArgumentCompletions.length > 0) &&
    !hasNonTextComposerContent &&
    (!hasExactSlashCommand ||
      matchingSlashCommands.length > 1 ||
      matchingSlashArgumentCompletions.length > 0) &&
    dismissedSlashQuery !== slashQueryKey &&
    slashSuggestionCount > 0;
  const recognizedSkillTokens = useMemo(
    () =>
      Array.from(
        new Set(
          findSkillInvocations(text, slashCommands)
            .filter(
              (match) => match.command.invocation?.inventoryState === "current",
            )
            .map((match) => match.canonicalToken),
        ),
      ),
    [slashCommands, text],
  );
  const unrecognizedSkillTokens = useMemo(() => {
    if (
      !slashCommands.some(
        (command) =>
          command.invocation?.kind === "skill" &&
          command.invocation.inventoryState === "current",
      )
    ) {
      return [];
    }
    return Array.from(
      new Set(
        findUnrecognizedInvocations(text, slashCommands)
          .filter(
            (candidate) =>
              matchingSlashCommands.length === 0 ||
              invocationQuery === null ||
              candidate.start !== invocationQuery.start,
          )
          .map((candidate) => candidate.token),
      ),
    );
  }, [invocationQuery, matchingSlashCommands.length, slashCommands, text]);
  const {
    bangQuery,
    bangQueryKey,
    showBangChip,
    showBangEscapedChip,
    bangMenuItems,
    showBangSuggestions,
    selectedBangIndex,
    setSelectedBangIndex,
    setDismissedBangQueryKey,
    setBangCandidates,
    setBangHistoryCandidates,
  } = useComposerBangCompletion({ text, collapsed, disabled, bangSupport });
  const bangHistoryIndexRef = useRef(-1);
  const bangRecalledTextRef = useRef<string | null>(null);
  // Any edit that diverges from the last Ctrl+↑ recall resets history cycling.
  useEffect(() => {
    if (bangRecalledTextRef.current !== text) {
      bangHistoryIndexRef.current = -1;
      bangRecalledTextRef.current = null;
    }
  }, [text]);
  const canSubmit = forkSummaryMode
    ? !forkSummaryMode.submitting &&
      attachments.length === 0 &&
      uploadProgress.length === 0
    : canSaveQuestionAside ||
      !!(
        hasComposerDraftContent(text, attachments.length) ||
        speechPending !== null ||
        interimTranscript
      );
  // Only mutable provisional speech uses the textarea mirror. Capture and
  // post-capture status live with the mic so the real draft and caret stay
  // untouched while transcription is pending.
  const { interimDisplayTranscript, interimInsertion } =
    getSpeechInterimPreview(
      text,
      interimTranscript,
      speechInsertionRangeRef.current,
    );
  const slashSelectionResetKey = `${slashQueryKey}\0${slashSuggestionCount}`;

  useEffect(() => {
    void slashSelectionResetKey;
    setSelectedSlashIndex(0);
  }, [slashSelectionResetKey]);

  const basePrimaryActionKind =
    primaryActionKind ??
    (supportsSteering && onQueue ? "steer" : onQueue ? "queue" : "send");
  const hasActiveDualActions =
    supportsSteering && !!onQueue && basePrimaryActionKind === "steer";
  const { version } = useVersion();
  const busyComposerDefaultAction: BusyComposerDefaultAction =
    version?.clientDefaults?.busyComposerDefaultAction ?? "steer";
  const collapsedComposerButton: CollapsedComposerButtonPreference =
    version?.clientDefaults?.collapsedComposerButton ?? "primary";
  const enterActionStorageKey = `${draftKey}:enter-action-kind`;
  const [enterActionOverride, setEnterActionOverride] =
    useState<BusyComposerDefaultAction | null>(() => {
      try {
        const stored = localStorage.getItem(enterActionStorageKey);
        return stored === "queue" || stored === "steer" ? stored : null;
      } catch {
        return null;
      }
    });
  // Patient queue intent is a global preference (Message Delivery settings):
  // when on, a queued message waits for verified-idle before delivery instead
  // of promoting at the next end of turn.
  const patientQueueEnabled =
    version?.clientDefaults?.patientQueueDefault ?? false;
  // Patient items record their entry point and a compact-first threshold
  // only on servers that honor them; 100% (or unset) is Off.
  const topicShiftSupported = serverHasCapability(
    version,
    PATIENT_TOPIC_SHIFT_CAPABILITY,
  );
  const patientQueueCompactPercent = normalizePatientCompactPercent(
    version?.clientDefaults?.patientQueueCompactAtPercent,
  );
  const topicShiftCompactPercent = normalizePatientCompactPercent(
    version?.clientDefaults?.topicShiftCompactAtPercent,
  );
  const projectQueueCtrlEnterEnabled =
    version?.clientDefaults?.projectQueueCtrlEnterEnabled ??
    DEFAULT_PROJECT_QUEUE_CTRL_ENTER_ENABLED;

  const projectQueueShortcutAvailable =
    projectQueueCtrlEnterEnabled &&
    toolbarVisibility.projectQueue &&
    !!onProjectQueue &&
    !forkSummaryMode;
  const [steerNowOverride, setSteerNowOverride] = useState<boolean | null>(
    null,
  );
  const steerNowEnabled = steerNowOverride ?? steerNowDefault;
  const effectivePrimaryActionKind = hasActiveDualActions
    ? (enterActionOverride ?? busyComposerDefaultAction)
    : basePrimaryActionKind;
  const effectivePatientQueuePatienceSeconds =
    clampPatientPatienceSeconds(patientQueuePatienceSeconds) ??
    DEFAULT_PATIENT_QUEUE_PATIENCE_SECONDS;
  const questionActionLabel = canSaveQuestionAside
    ? t("questionAsideSave")
    : showQuestionAsideHint
      ? t("questionAsideTitle")
      : undefined;
  const primaryActionLabel =
    questionActionLabel ??
    (forkSummaryMode
      ? forkSummaryMode.submitLabel
      : effectivePrimaryActionKind === "steer"
        ? t("toolbarSteerTooltip")
        : effectivePrimaryActionKind === "queue"
          ? t("toolbarQueueLabel")
          : t("toolbarSend"));
  const mobileKeyboardActionLabel =
    questionActionLabel ??
    (forkSummaryMode
      ? forkSummaryMode.submitLabel
      : effectivePrimaryActionKind === "steer"
        ? t("toolbarShortcutSteerCurrentTurn")
        : effectivePrimaryActionKind === "queue"
          ? t("toolbarQueueLabel")
          : t("toolbarSend"));
  const mobileKeyboardActionDisplayLabel =
    hasActiveDualActions && !forkSummaryMode && !questionActionLabel
      ? effectivePrimaryActionKind === "queue"
        ? t("toolbarQueueShortLabel")
        : t("toolbarSteerShortLabel")
      : mobileKeyboardActionLabel;
  const mobileKeyboardActionIcon = forkSummaryMode
    ? forkSummaryMode.icon
    : effectivePrimaryActionKind === "steer"
      ? "↗"
      : effectivePrimaryActionKind === "queue"
        ? "→"
        : "↑";

  const canAttach = !!(projectId && sessionId && onAttach);

  useEffect(() => {
    try {
      const stored = localStorage.getItem(enterActionStorageKey);
      setEnterActionOverride(
        stored === "queue" || stored === "steer" ? stored : null,
      );
    } catch {
      setEnterActionOverride(null);
    }
  }, [enterActionStorageKey]);

  const toggleEnterActionKind = useCallback(() => {
    setEnterActionOverride((previous) => {
      const current = previous ?? busyComposerDefaultAction;
      const next = current === "steer" ? "queue" : "steer";
      try {
        localStorage.setItem(enterActionStorageKey, next);
      } catch {
        // Keyboard preference is local-only; in-memory state still works.
      }
      return next;
    });
  }, [busyComposerDefaultAction, enterActionStorageKey]);

  const noteComposerEdit = useCallback((nextText: string) => {
    if (!nextText.trim()) {
      typingStartedAtRef.current = null;
      lastEditedAtRef.current = null;
      return;
    }

    const now = new Date().toISOString();
    if (!typingStartedAtRef.current) {
      typingStartedAtRef.current = now;
    }
    lastEditedAtRef.current = now;
  }, []);

  const resetCompositionMetadata = useCallback(() => {
    typingStartedAtRef.current = null;
    lastEditedAtRef.current = null;
    speechTurnIdRef.current = null;
    speechTranscriptionIdsRef.current = [];
  }, []);

  const ensureSpeechTurnId = useCallback(() => {
    if (!speechTurnIdRef.current) {
      speechTurnIdRef.current = createClientSpeechTurnId();
    }
    return speechTurnIdRef.current;
  }, []);

  const getTranscriptionContext =
    useCallback((): SpeechTranscriptionContext => {
      const draft = controls.getDraft();
      return {
        projectId,
        sessionId,
        draftKey,
        sessionTerms: speechVocabulary?.terms(),
        clientTurnId: ensureSpeechTurnId(),
        speechTargetId: activeSpeechTargetIdRef.current ?? undefined,
        textBeforeCursor: textBeforeSpeechCursor(
          draft,
          speechInsertionRangeRef.current,
          textareaRef.current,
        ),
      };
    }, [
      controls,
      draftKey,
      ensureSpeechTurnId,
      projectId,
      sessionId,
      speechVocabulary,
    ]);

  const buildSubmissionMetadata = useCallback(
    (
      deliveryIntent: UserMessageDeliveryIntent,
      snapshot?: SubmissionCompositionSnapshot,
    ): MessageSubmissionMetadata => {
      const submittedAt = new Date().toISOString();
      const typingStartedAt =
        snapshot?.typingStartedAt ?? typingStartedAtRef.current ?? submittedAt;
      const lastEditedAt =
        snapshot?.lastEditedAt ?? lastEditedAtRef.current ?? typingStartedAt;
      const speechTurnId = snapshot?.speechTurnId ?? speechTurnIdRef.current;
      const speechTranscriptionIds =
        snapshot?.speechTranscriptionIds ?? speechTranscriptionIdsRef.current;
      const speech: UserMessageSpeechMetadata | undefined =
        speechTurnId || speechTranscriptionIds.length > 0
          ? {
              clientTurnId: speechTurnId ?? undefined,
              transcriptionIds:
                speechTranscriptionIds.length > 0
                  ? [...speechTranscriptionIds]
                  : undefined,
            }
          : undefined;
      return {
        deliveryIntent,
        ...(deliveryIntent === "patient"
          ? { patienceSeconds: effectivePatientQueuePatienceSeconds }
          : {}),
        ...(deliveryIntent === "steer" && supportsSteerNow && steerNowEnabled
          ? { steerNow: true }
          : {}),
        composition: {
          typingStartedAt,
          typingEndedAt: submittedAt,
          lastEditedAt,
          submittedAt,
        },
        ...(speech ? { speech } : {}),
      };
    },
    [effectivePatientQueuePatienceSeconds, steerNowEnabled, supportsSteerNow],
  );

  const noteDraftTextChange = useCallback(
    (
      previousText: string,
      nextText: string,
      edit?: Omit<DraftTextEdit, "insertedText"> & { insertedText?: string },
    ) => {
      const insertedText =
        edit?.insertedText ??
        (edit
          ? getInsertedTextForEdit(previousText, nextText, edit.start, edit.end)
          : "");
      draftTextChangeMetadataRef.current = getDraftTextChangeMetadata(
        previousText,
        nextText,
        edit ? { ...edit, insertedText } : undefined,
      );
    },
    [],
  );

  const replaceDraftRangeUndoably = useCallback(
    (start: number, end: number, replacement: string): string | null => {
      const textarea = textareaRef.current;
      if (!textarea) return null;

      const previousText = controls.getDraft();
      const replacementStart = Math.max(
        0,
        Math.min(start, previousText.length),
      );
      const replacementEnd = Math.max(
        replacementStart,
        Math.min(end, previousText.length),
      );
      const nextText = `${previousText.slice(0, replacementStart)}${replacement}${previousText.slice(replacementEnd)}`;
      if (nextText === previousText) return nextText;

      noteDraftTextChange(previousText, nextText, {
        start: replacementStart,
        end: replacementEnd,
        insertedText: replacement,
        inputType: replacement ? "insertText" : "deleteContent",
      });
      replaceTextareaRangeUndoably(
        textarea,
        replacementStart,
        replacementEnd,
        replacement,
      );
      if (textarea.value !== nextText) {
        textarea.value = nextText;
      }

      noteSpeechDraftReplacement(
        previousText,
        nextText,
        replacementStart,
        replacementEnd,
        replacement.length,
      );
      noteComposerEdit(nextText);
      setText(nextText);
      setComposerCursor(nextText.length);
      const nextSlashQuery = getInvocationCompletionQuery(
        nextText,
        nextText.length,
      );
      const nextSlashQueryKey = nextSlashQuery
        ? `${nextSlashQuery.start}:${nextSlashQuery.end}:${nextSlashQuery.sigil}:${nextSlashQuery.query}`
        : null;
      if (nextSlashQueryKey !== dismissedSlashQuery) {
        setDismissedSlashQuery(null);
      }
      return nextText;
    },
    [
      controls,
      dismissedSlashQuery,
      noteComposerEdit,
      noteDraftTextChange,
      setText,
    ],
  );

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files?.length && onAttach) {
      onAttach(Array.from(files));
      e.target.value = ""; // Reset for re-selection
    }
  };

  const draftControls = useMemo<DraftControls>(
    () => ({
      ...controls,
      focus: (options) => textareaRef.current?.focus(options),
      isFocused: () =>
        textareaRef.current !== null &&
        document.activeElement === textareaRef.current,
      setSelectionRange: (start, end) =>
        textareaRef.current?.setSelectionRange(start, end),
      replaceDraftRangeUndoably,
    }),
    [controls, replaceDraftRangeUndoably],
  );

  const fileCompletion = useProjectFileCompletion({
    projectId,
    text,
    textarea: textareaRef,
    setText,
    replace: replaceDraftRangeUndoably,
    items: completionRenderItems,
    disabled: disabled || collapsed || !!interimTranscript,
  });
  const fileViewCompletion = useFileViewCompletion({
    enabled: !!fileViewCommand,
    projectId,
    text,
    textarea: textareaRef,
    replace: replaceDraftRangeUndoably,
    // Called from a key handler, after `deliver` below is initialized.
    submit: (draft) => {
      deliver({ kind: "send" }, { text: draft });
    },
    open: fileViewCommand?.open,
    enterInsertsNewline: fullPane,
    items: completionRenderItems,
    disabled: disabled || collapsed || !!interimTranscript,
  });

  // Provide controls to parent via callback
  useEffect(() => {
    onDraftControlsReady?.(draftControls);
  }, [draftControls, onDraftControlsReady]);

  useEffect(() => {
    const metadata = draftTextChangeMetadataRef.current ?? {
      mayAffectQuoteAnchors: true,
    };
    draftTextChangeMetadataRef.current = null;
    onDraftTextChange?.(text, metadata);
  }, [onDraftTextChange, text]);

  useLayoutEffect(() => {
    restorePendingTextareaSelection(text, textareaRef.current);
  }, [text]);

  const revealCollapsedTextareaCursor = useCallback(() => {
    if (!collapsed) return;
    const textarea = textareaRef.current;
    if (!textarea) return;
    const schedule =
      window.requestAnimationFrame ??
      ((fn: FrameRequestCallback) => window.setTimeout(fn, 0));
    schedule(() => {
      if (textareaRef.current === textarea) {
        scrollCollapsedTextareaToCursor(textarea);
      }
    });
  }, [collapsed]);

  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    void text;

    resizeComposerTextarea(textarea, collapsed, fullPane);

    if (collapsed) {
      revealCollapsedTextareaCursor();
      return;
    }

    const handleViewportResize = () => {
      resizeComposerTextarea(textarea, false, fullPane);
    };
    window.addEventListener("resize", handleViewportResize);
    window.visualViewport?.addEventListener("resize", handleViewportResize);
    return () => {
      window.removeEventListener("resize", handleViewportResize);
      window.visualViewport?.removeEventListener(
        "resize",
        handleViewportResize,
      );
    };
  }, [collapsed, fullPane, revealCollapsedTextareaCursor, text]);

  useEffect(() => {
    if (externalCollapsed) setFullPane(false);
  }, [externalCollapsed]);

  const restoreFullPane = useCallback(() => setFullPane(false), []);

  const fullPaneControls = useMemo<FullPaneComposerControls>(
    () => ({ restore: restoreFullPane }),
    [restoreFullPane],
  );

  useEffect(() => {
    onFullPaneControlsReady?.(fullPaneControls);
    return () => onFullPaneControlsReady?.(null);
  }, [fullPaneControls, onFullPaneControlsReady]);

  const toggleFullPane = useCallback(() => {
    if (externalCollapsed) return;
    setUserCollapsed(false);
    setFullPane((current) => !current);
    textareaRef.current?.focus();
  }, [externalCollapsed]);

  useEffect(() => {
    if (
      !textareaFocused ||
      typeof window.matchMedia !== "function" ||
      !hasCoarsePointer()
    ) {
      keyboardViewportBaselineRef.current = null;
      setMobileKeyboardOpen(false);
      setMobileKeyboardMoreOpen(false);
      return;
    }

    if (keyboardViewportBaselineRef.current === null) {
      keyboardViewportBaselineRef.current = getComposerViewportHeight();
    }

    const updateKeyboardState = () => {
      const viewportHeight = getComposerViewportHeight();
      const previousBaseline = keyboardViewportBaselineRef.current;
      const baseline =
        previousBaseline === null
          ? viewportHeight
          : Math.max(previousBaseline, viewportHeight);
      keyboardViewportBaselineRef.current = baseline;
      const nextKeyboardOpen =
        viewportHeight < baseline * MOBILE_KEYBOARD_OPEN_VIEWPORT_RATIO;
      setMobileKeyboardOpen(nextKeyboardOpen);
      if (!nextKeyboardOpen) {
        setMobileKeyboardMoreOpen(false);
      }
    };

    updateKeyboardState();
    window.addEventListener("resize", updateKeyboardState);
    window.visualViewport?.addEventListener("resize", updateKeyboardState);
    return () => {
      window.removeEventListener("resize", updateKeyboardState);
      window.visualViewport?.removeEventListener("resize", updateKeyboardState);
    };
  }, [textareaFocused]);

  useEffect(() => {
    if (!canSubmit) {
      setMobileKeyboardMoreOpen(false);
    }
  }, [canSubmit]);

  const {
    deliver,
    primaryRoute,
    handleQuestionAsideSubmission,
    restorePendingSpeechDeliveryDraft,
    maybeRunPendingSpeechDelivery,
    handlePrimaryPointerDelivery,
    handleQueuePointerDelivery,
    handleSteerPointerDelivery,
    handleTopicShiftPointerDelivery,
    handleProjectQueuePointerDelivery,
    handleProjectQueueNewSessionPointerDelivery,
    queueNewSessionAtChosenTarget,
    handleForkWithoutSummaryPointerDelivery,
    handleSmartTurnSend,
    pendingSpeechDeliveryRef,
    pendingSpeechDeliverySettledRef,
  } = useComposerDelivery({
    activeSpeechTargetIdRef,
    attachments,
    bangSupport,
    buildSubmissionMetadata,
    canSaveQuestionAside,
    consumeSpeechAttribution,
    controls,
    disabled,
    effectivePrimaryActionKind,
    forkSummaryMode,
    interimTranscriptRef,
    isComposing,
    isRecentSpeechAttribution,
    keepMobileKeyboardOpenAfterDelivery,
    lastEditedAtRef,
    onDone,
    onProjectQueue,
    onProjectQueueNewSession,
    onQueue,
    onSend,
    patientQueueCompactPercent,
    patientQueueEnabled,
    pendingSpeechFinalRef,
    pendingSpeechRetargetRef,
    questionAside,
    questionAsideEligible,
    resetCompositionMetadata,
    setInterimTranscript,
    setNewSessionOptionsMode,
    setTextareaImeGeneration,
    speechInsertionRangeRef,
    speechInsertionRangesRef,
    speechMessagePrefix,
    speechPendingRef,
    speechTranscriptionIdsRef,
    speechTurnIdRef,
    textareaRef,
    topicShiftCompactPercent,
    topicShiftSupported,
    typingStartedAtRef,
    uploadProgress,
    voiceButtonRef,
  });

  const handleBtwClick = useCallback(() => {
    if (disabled || !onBtwShortcut) return;
    const pendingVoice = voiceButtonRef.current?.stopAndFinalize() ?? "";
    const message = getSpeechVisibleDraftText(
      controls.getDraft(),
      pendingVoice,
      speechInsertionRangeRef.current,
    ).trim();
    if (onBtwShortcut(message) && message) {
      controls.clearInput();
      resetCompositionMetadata();
      setInterimTranscript("");
    }
    textareaRef.current?.focus();
  }, [controls, disabled, onBtwShortcut, resetCompositionMetadata]);

  const openNewSessionOptions = useCallback(
    () => setNewSessionOptionsMode("patient"),
    [],
  );
  const openImmediateNewSessionOptions = useCallback(
    () => setNewSessionOptionsMode("now"),
    [],
  );
  const closeNewSessionOptions = useCallback(() => {
    setNewSessionOptionsMode(null);
    textareaRef.current?.focus();
  }, []);
  const visibleDeliveryDraft = getSpeechVisibleDraftText(
    controls.getDraft(),
    interimTranscript,
    speechInsertionRangeRef.current,
  );
  // Every delivery cue follows `deliver`'s prefix rule: `!!` runs locally
  // (and a bare `!!` does nothing) on every route but the forks, and empty
  // text is never prefixed.
  const deliveryBangKind = resolveComposerBangDraft(visibleDeliveryDraft).kind;
  const deliveryHandledAsBang =
    !forkSummaryMode &&
    !!bangSupport &&
    (deliveryBangKind === "bang" || deliveryBangKind === "empty");
  const manualDeliverySpeechPrefix =
    speechMessagePrefix &&
    !deliveryHandledAsBang &&
    (speechPending !== null ||
      pendingSpeechDeliveryRef.current !== null ||
      (speechAttributionActive && visibleDeliveryDraft.trim() !== ""))
      ? speechMessagePrefix
      : null;
  const describePrefixedDelivery = (
    action: string,
    prefix = manualDeliverySpeechPrefix,
  ) =>
    prefix
      ? t("speechPrefixDeliveryLabel", {
          action,
          prefix,
        })
      : action;
  const describePrefixedTooltip = (
    tooltip: string,
    prefix = manualDeliverySpeechPrefix,
  ) =>
    prefix
      ? t("speechPrefixDeliveryTooltip", {
          tooltip,
          prefix,
        })
      : tooltip;
  const forkSummaryAlternateLabel =
    forkSummaryMode?.noSummarySubmitLabel ?? t("forkSummaryNoSummarySubmit");
  const mobileKeyboardAlternateAction = forkSummaryMode?.onSubmitWithoutSummary
    ? {
        kind: "send" as const,
        label: forkSummaryAlternateLabel,
        displayLabel: forkSummaryAlternateLabel,
        icon: forkSummaryMode.noSummaryIcon ?? "↱",
        onClick: handleForkWithoutSummaryPointerDelivery,
      }
    : hasActiveDualActions
      ? effectivePrimaryActionKind === "queue"
        ? {
            kind: "steer" as const,
            label: t("toolbarShortcutSteerCurrentTurn"),
            displayLabel: t("toolbarSteerShortLabel"),
            icon: "↗",
            onClick: handleSteerPointerDelivery,
          }
        : {
            kind: "queue" as const,
            label: t("toolbarQueueLabel"),
            displayLabel: t("toolbarQueueShortLabel"),
            icon: "→",
            onClick: handleQueuePointerDelivery,
          }
      : null;
  // Render session actions only when they are useful, so a neighboring visible
  // action can absorb their space while the session is inactive.
  const showMobileProjectQueueAction =
    !forkSummaryMode && toolbarVisibility.projectQueue && !!onProjectQueue;
  const showMobileProjectQueueNewSessionAction =
    !forkSummaryMode &&
    toolbarVisibility.projectQueueNewSessionShortcut &&
    !!onProjectQueueNewSession;
  const showMobileSessionAlternateAction =
    !forkSummaryMode && supportsSteering && !!mobileKeyboardAlternateAction;
  const collapsedActionKind =
    collapsedComposerButton === "alternate" && hasActiveDualActions
      ? effectivePrimaryActionKind === "queue"
        ? "steer"
        : "queue"
      : effectivePrimaryActionKind;
  const collapsedSubmitAction =
    forkSummaryMode || collapsedActionKind === effectivePrimaryActionKind
      ? handlePrimaryPointerDelivery
      : collapsedActionKind === "queue"
        ? handleQueuePointerDelivery
        : collapsedActionKind === "steer"
          ? handleSteerPointerDelivery
          : handlePrimaryPointerDelivery;
  const collapsedActionLabel = forkSummaryMode
    ? primaryActionLabel
    : collapsedActionKind === "steer"
      ? t("toolbarSteerTooltip")
      : collapsedActionKind === "queue"
        ? t("toolbarQueueLabel")
        : t("toolbarSend");
  const collapsedActionIcon = forkSummaryMode
    ? forkSummaryMode.icon
    : collapsedActionKind === "steer"
      ? "↗"
      : collapsedActionKind === "queue"
        ? "→"
        : "↑";
  const collapsedLineCount = countDraftLines(text);
  const showCollapsedLineCount = collapsedLineCount > 1;
  const hasYaServerSpeechBackend = (version?.voiceBackends?.length ?? 0) > 0;
  const showCollapsedMicrophone =
    collapsed && !forkSummaryMode && collapsedComposerButton === "microphone";
  const showCollapsedDesktopMicrophone =
    collapsed &&
    !forkSummaryMode &&
    collapsedComposerButton !== "microphone" &&
    hasYaServerSpeechBackend;
  const showCollapsedSendAction =
    collapsed &&
    (forkSummaryMode ||
      collapsedComposerButton !== "microphone" ||
      !hasYaServerSpeechBackend);

  const recallLastSubmission = useCallback(
    (allowExistingText = false) => {
      if (
        disabled ||
        (!allowExistingText && text.trim()) ||
        attachments.length > 0 ||
        uploadProgress.length > 0
      ) {
        return false;
      }
      const recalled = onRecallLastSubmission?.() ?? false;
      if (recalled) {
        setRecallVersion((version) => version + 1);
        setInterimTranscript("");
        textareaRef.current?.focus();
      }
      return recalled;
    },
    [
      attachments.length,
      disabled,
      onRecallLastSubmission,
      text,
      uploadProgress.length,
    ],
  );

  // Handle slash command selection - run active client commands or insert text.
  const handleSlashCommand = useCallback(
    (command: SlashCommand, completionPrefix?: string) => {
      const canonicalToken =
        completionPrefix ?? getCanonicalInvocationToken(command);
      const activeQuery = getInvocationCompletionQuery(text, composerCursor);
      // A root token typed in front of existing text takes that text as its
      // argument, so selection inserts the command instead of running it
      // bare and discarding the draft.
      const textFollowsToken =
        activeQuery !== null && text.slice(activeQuery.end).trim() !== "";
      if (
        completionPrefix === undefined &&
        command.invocation?.kind === "emulated" &&
        !textFollowsToken &&
        onCustomCommand?.(command.name)
      ) {
        return;
      }

      let editStart: number;
      let editEnd: number;
      let nextText: string;
      let nextCursor: number;
      if (activeQuery) {
        const suffix =
          completionPrefix !== undefined ||
          /\s/.test(text[activeQuery.end] ?? "")
            ? ""
            : " ";
        const replacement = `${canonicalToken}${suffix}`;
        editStart = activeQuery.start;
        editEnd = activeQuery.end;
        nextText =
          text.slice(0, activeQuery.start) +
          replacement +
          text.slice(activeQuery.end);
        nextCursor = activeQuery.start + replacement.length;
      } else {
        const trimmed = text.trimEnd();
        const separator = trimmed ? " " : "";
        const replacement = `${separator}${canonicalToken} `;
        editStart = trimmed.length;
        editEnd = text.length;
        nextText = `${trimmed}${replacement}`;
        nextCursor = nextText.length;
      }
      noteDraftTextChange(text, nextText, {
        start: editStart,
        end: editEnd,
        inputType: "insertText",
      });
      noteComposerEdit(nextText);
      setText(nextText);
      setComposerCursor(nextCursor);
      setDismissedSlashQuery(null);
      requestAnimationFrame(() => {
        textareaRef.current?.focus();
        textareaRef.current?.setSelectionRange(nextCursor, nextCursor);
      });
    },
    [
      composerCursor,
      text,
      setText,
      onCustomCommand,
      noteComposerEdit,
      noteDraftTextChange,
    ],
  );

  const handleSlashArgumentCompletion = useCallback(
    (match: SlashCommandArgumentCompletionMatch) => {
      const separator =
        match.start > 0 && !/\s/.test(text[match.start - 1] ?? "") ? " " : "";
      const replacement = `${separator}${match.completion.value.trim()} `;
      const nextText =
        text.slice(0, match.start) + replacement + text.slice(match.end);
      const nextCursor = match.start + replacement.length;
      noteDraftTextChange(text, nextText, {
        start: match.start,
        end: match.end,
        inputType: "insertText",
      });
      noteComposerEdit(nextText);
      setText(nextText);
      setComposerCursor(nextCursor);
      setDismissedSlashQuery(null);
      requestAnimationFrame(() => {
        textareaRef.current?.focus();
        textareaRef.current?.setSelectionRange(nextCursor, nextCursor);
      });
    },
    [noteComposerEdit, noteDraftTextChange, setText, text],
  );

  // Apply a highlighted/clicked bang menu row. A history row replaces the
  // whole `!!` body (and dismisses the menu, since the body is now a complete
  // prior command); a token candidate keeps the token-replacement behavior.
  const applyBangMenuItem = (item: BangMenuItem) => {
    if (!bangQuery) {
      return;
    }
    if (item.source === "history") {
      const nextText = `!!${item.value}`;
      noteComposerEdit(nextText);
      setText(nextText);
      setDismissedBangQueryKey(bangCompletionQueryKey(nextText));
      return;
    }
    const nextText = applyBangCompletion(text, bangQuery, item.value);
    noteComposerEdit(nextText);
    setText(nextText);
  };

  // Shared Tab-complete action for bang drafts: accept the highlighted row if
  // the menu is open; else fetch immediately. Whole-line history matches never
  // participate in the token longest-common-prefix logic — when the fetch
  // returns any, open the menu (history first) instead of auto-applying;
  // otherwise apply a single token match or extend to the longest common
  // prefix (menu opens on ambiguity). Reused by the Tab key and the
  // mobile-keyboard button, since touch keyboards have no Tab key.
  const performBangTabComplete = (): boolean => {
    if (!bangQuery || !bangSupport) {
      return false;
    }
    if (showBangSuggestions) {
      const item = bangMenuItems[selectedBangIndex];
      if (item) {
        applyBangMenuItem(item);
      }
      return true;
    }
    bangSupport
      .fetchCompletions(bangQuery.token, bangQuery.kind, text.slice(2))
      .then((result) => {
        if (controls.getDraft() !== text) {
          return;
        }
        if (result.history.length > 0) {
          setBangCandidates(result.completions);
          setBangHistoryCandidates(result.history);
          setSelectedBangIndex(0);
          setDismissedBangQueryKey(null);
          return;
        }
        const completions = result.completions;
        const single = completions.length === 1 ? completions[0] : undefined;
        if (single) {
          const nextText = applyBangCompletion(text, bangQuery, single);
          noteComposerEdit(nextText);
          setText(nextText);
          return;
        }
        const prefix = longestCommonPrefix(completions);
        if (prefix.length > bangQuery.token.length) {
          const nextText = text.slice(0, bangQuery.replaceStart) + prefix;
          noteComposerEdit(nextText);
          setText(nextText);
        }
        setBangCandidates(completions);
        setBangHistoryCandidates([]);
        setSelectedBangIndex(0);
        setDismissedBangQueryKey(null);
      })
      .catch(() => {});
    return true;
  };

  const {
    recallDrawer,
    openRecallDrawer,
    cancelRecallDrawer,
    acceptRecallEntry,
    goToRecallTurn,
    highlightRecallEntry,
    handleRecallDrawerKeyDown,
  } = useComposerRecallDrawer({
    text,
    setText,
    noteComposerEdit,
    textareaRef,
    hasNonTextComposerContent,
    turnRecall,
  });

  const clearComposer = () => {
    if (disabled) return;
    voiceButtonRef.current?.stopAndFinalize();
    if (textareaRef.current) {
      clearTextareaContentsUndoably(textareaRef.current);
    }
    setInterimTranscript("");
    noteDraftTextChange(text, "", {
      start: 0,
      end: text.length,
      insertedText: "",
      inputType: "deleteContent",
    });
    setText("");
    resetCompositionMetadata();
    controls.flushDraft();
    for (const attachment of attachments) {
      onRemoveAttachment?.(attachment.id);
    }
    onCancelCorrection?.();
    textareaRef.current?.focus();
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    // A held dismissal key must never fall through to stopping agent work.
    if (e.key === "Escape" && e.repeat) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (
      e.key !== "ArrowDown" &&
      e.key !== "ArrowUp" &&
      e.key !== "Control" &&
      e.key !== "Shift" &&
      e.key !== "Alt" &&
      e.key !== "Meta"
    ) {
      untouchedRecallRef.current = null;
    }
    if (e.key === "Enter" && e.repeat && questionAside?.onSave) {
      e.preventDefault();
      return;
    }
    if (fileCompletion.onKeyDown(e)) return;
    if (fileViewCompletion.onKeyDown(e)) return;
    if (
      e.key === "Enter" &&
      !e.nativeEvent.isComposing &&
      !e.ctrlKey &&
      !e.metaKey &&
      !e.shiftKey &&
      !e.altKey &&
      canSaveQuestionAside
    ) {
      e.preventDefault();
      handleQuestionAsideSubmission(controls.getDraft());
      return;
    }
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
        deliver(
          forkSummaryMode
            ? { kind: "fork-summary" }
            : { kind: "send", action: "send" },
        );
      }
      return;
    }

    // Ctrl+↑/↓: shell-style recall of prior bang commands.
    if (
      e.key === "ArrowUp" &&
      e.ctrlKey &&
      !e.metaKey &&
      !e.shiftKey &&
      !e.altKey &&
      bangSupport &&
      bangSupport.history.length > 0 &&
      (composerIsEmpty || text.startsWith("!!"))
    ) {
      e.preventDefault();
      const nextIndex = Math.min(
        bangHistoryIndexRef.current + 1,
        bangSupport.history.length - 1,
      );
      bangHistoryIndexRef.current = nextIndex;
      const nextText = `!!${bangSupport.history[nextIndex]}`;
      bangRecalledTextRef.current = nextText;
      noteComposerEdit(nextText);
      setText(nextText);
      return;
    }
    if (
      e.key === "ArrowDown" &&
      e.ctrlKey &&
      !e.metaKey &&
      !e.shiftKey &&
      !e.altKey &&
      bangSupport &&
      bangHistoryIndexRef.current >= 0 &&
      text.startsWith("!!")
    ) {
      e.preventDefault();
      const nextIndex = bangHistoryIndexRef.current - 1;
      bangHistoryIndexRef.current = nextIndex;
      const nextText =
        nextIndex < 0 ? "" : `!!${bangSupport.history[nextIndex]}`;
      bangRecalledTextRef.current = nextText;
      noteComposerEdit(nextText);
      setText(nextText);
      return;
    }

    // Composer recall drawer. Runs after the bang Ctrl+↑ history block above,
    // so bang shell-recall still wins for empty / "!!" drafts when bang
    // support is enabled; otherwise Ctrl+↑ opens this drawer.
    // See topics/composer-recall-drawer.md.
    if (handleRecallDrawerKeyDown(e)) {
      return;
    }

    // Tab always completes inside a bang draft, shell-style.
    if (e.key === "Tab" && !e.shiftKey && performBangTabComplete()) {
      e.preventDefault();
      return;
    }

    if (showBangSuggestions && bangQuery) {
      if (e.key === "Escape") {
        e.preventDefault();
        setDismissedBangQueryKey(bangQueryKey);
        return;
      }
      if ((e.key === "ArrowDown" || e.key === "ArrowUp") && !e.ctrlKey) {
        e.preventDefault();
        setSelectedBangIndex((current) => {
          const delta = e.key === "ArrowDown" ? 1 : -1;
          return (
            (current + delta + bangMenuItems.length) % bangMenuItems.length
          );
        });
        return;
      }
      if (
        e.key === "Enter" &&
        !e.ctrlKey &&
        !e.metaKey &&
        !e.shiftKey &&
        !e.altKey
      ) {
        e.preventDefault();
        const item = bangMenuItems[selectedBangIndex];
        if (item) {
          applyBangMenuItem(item);
        }
        return;
      }
    }

    if (showSlashSuggestions) {
      if (
        e.key === " " &&
        e.shiftKey &&
        !e.ctrlKey &&
        !e.metaKey &&
        !e.altKey &&
        matchingSlashCommands[0]
      ) {
        e.preventDefault();
        handleSlashCommand(matchingSlashCommands[0]);
        return;
      }
      if (
        e.key === "Tab" &&
        !e.shiftKey &&
        !e.ctrlKey &&
        !e.metaKey &&
        !e.altKey &&
        matchingSlashCommands.length > 1 &&
        matchingSlashCommands.some(
          (command) => command.invocation?.kind === "skill",
        )
      ) {
        e.preventDefault();
        const prefix = longestCommonPrefix(
          matchingSlashCommands.map(getCanonicalInvocationToken),
        );
        if (
          prefix &&
          invocationQuery &&
          prefix.length > invocationQuery.query.length + 1
        ) {
          handleSlashCommand(matchingSlashCommands[0]!, prefix);
        }
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setDismissedSlashQuery(slashQueryKey);
        return;
      }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedSlashIndex((current) => {
          const delta = e.key === "ArrowDown" ? 1 : -1;
          return (
            (current + delta + slashSuggestionCount) % slashSuggestionCount
          );
        });
        return;
      }
      if (
        (e.key === "Tab" &&
          !e.shiftKey &&
          !e.ctrlKey &&
          !e.metaKey &&
          !e.altKey) ||
        (e.key === "Enter" &&
          !hasExactSlashCommand &&
          !e.ctrlKey &&
          !e.metaKey &&
          !e.shiftKey &&
          !e.altKey)
      ) {
        e.preventDefault();
        const command = matchingSlashCommands[selectedSlashIndex];
        if (command) {
          handleSlashCommand(command);
        } else {
          const completion =
            matchingSlashArgumentCompletions[
              selectedSlashIndex - matchingSlashCommands.length
            ];
          if (completion) handleSlashArgumentCompletion(completion);
        }
        return;
      }
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

    if (
      e.key === "Escape" &&
      !e.ctrlKey &&
      !e.metaKey &&
      !e.shiftKey &&
      !e.altKey &&
      correctionActive &&
      onCancelCorrection
    ) {
      e.preventDefault();
      e.stopPropagation();
      onCancelCorrection();
      return;
    }

    if (
      e.key === "Escape" &&
      !e.ctrlKey &&
      !e.metaKey &&
      !e.shiftKey &&
      !e.altKey &&
      questionAside?.onDismiss
    ) {
      e.preventDefault();
      e.stopPropagation();
      questionAside.onDismiss();
      return;
    }

    if (
      e.key === "Escape" &&
      !e.ctrlKey &&
      !e.metaKey &&
      !e.shiftKey &&
      !e.altKey &&
      isRunning &&
      isThinking &&
      !escapeInterruptDisabledSetting.read() &&
      onStop
    ) {
      e.preventDefault();
      e.stopPropagation();
      onStop();
      return;
    }

    if (
      e.key === "ArrowUp" &&
      !e.ctrlKey &&
      !e.metaKey &&
      !e.shiftKey &&
      !e.altKey
    ) {
      if (!e.repeat && !e.nativeEvent.isComposing && recallLastSubmission()) {
        e.preventDefault();
      }
      return;
    }

    // Down undoes untouched recall; selection/navigation retain normal editing.
    if (
      e.key === "ArrowDown" &&
      !e.ctrlKey &&
      !e.metaKey &&
      !e.shiftKey &&
      !e.altKey &&
      correctionActive &&
      onCancelCorrection &&
      !e.nativeEvent.isComposing &&
      (!text.trim() ||
        (untouchedRecallRef.current === text &&
          textareaRef.current?.selectionStart === text.length &&
          textareaRef.current?.selectionEnd === text.length)) &&
      attachments.length === 0
    ) {
      e.preventDefault();
      onCancelCorrection();
      return;
    }

    if (
      e.key.toLowerCase() === "p" &&
      e.ctrlKey &&
      !e.metaKey &&
      !e.shiftKey &&
      !e.altKey
    ) {
      e.preventDefault();
      if (!e.repeat && !e.nativeEvent.isComposing) recallLastSubmission(true);
      return;
    }

    if (
      e.key.toLowerCase() === "k" &&
      e.ctrlKey &&
      !e.metaKey &&
      !e.shiftKey &&
      !e.altKey
    ) {
      if (onCancelLatestDeferred?.()) {
        e.preventDefault();
        return;
      }
    }

    if (
      e.key.toLowerCase() === "b" &&
      e.ctrlKey &&
      !e.metaKey &&
      !e.shiftKey &&
      !e.altKey
    ) {
      e.preventDefault();
      handleBtwClick();
      return;
    }

    if (
      e.key === "Enter" &&
      e.ctrlKey &&
      e.altKey &&
      !e.metaKey &&
      !e.shiftKey &&
      onForkSummaryShortcut
    ) {
      e.preventDefault();
      const pendingVoice = voiceButtonRef.current?.stopAndFinalize() ?? "";
      let finalText = controls.getDraft().trimEnd();
      if (pendingVoice) {
        finalText = finalText ? `${finalText} ${pendingVoice}` : pendingVoice;
      }
      const accepted = onForkSummaryShortcut(finalText.trim());
      if (accepted !== false && finalText.trim()) {
        controls.clearInput();
        resetCompositionMetadata();
        setInterimTranscript("");
      }
      return;
    }

    if (e.key.toLowerCase() === "g" && e.ctrlKey && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      clearComposer();
      return;
    }

    // Tab when composer is empty accepts the prompt suggestion into the draft
    if (
      e.key === "Tab" &&
      !e.ctrlKey &&
      !e.metaKey &&
      !e.shiftKey &&
      !e.altKey &&
      promptSuggestion &&
      composerIsEmpty
    ) {
      e.preventDefault();
      noteDraftTextChange(text, promptSuggestion, {
        start: 0,
        end: text.length,
        insertedText: promptSuggestion,
        inputType: "insertText",
      });
      noteComposerEdit(promptSuggestion);
      setText(promptSuggestion);
      onDismissPromptSuggestion?.();
      return;
    }

    if (e.key === "Enter") {
      // Skip Enter during IME composition (e.g. Chinese/Japanese/Korean input)
      if (e.nativeEvent.isComposing) return;

      if (
        forkSummaryMode?.onSubmitWithoutSummary &&
        e.ctrlKey &&
        !e.metaKey &&
        !e.shiftKey &&
        !e.altKey
      ) {
        e.preventDefault();
        deliver({ kind: "fork-without-summary" });
        return;
      }

      if (
        projectQueueShortcutAvailable &&
        e.ctrlKey &&
        !e.metaKey &&
        !e.shiftKey &&
        !e.altKey
      ) {
        e.preventDefault();
        deliver({ kind: "project-queue", newSession: false });
        return;
      }

      // Ctrl+Enter is the alternate regular send action while busy. Patient
      // mode is controlled by the stopwatch toggle, not by this shortcut.
      if (
        (onQueue || effectivePrimaryActionKind === "queue") &&
        e.ctrlKey &&
        !e.shiftKey
      ) {
        e.preventDefault();
        if (hasActiveDualActions && effectivePrimaryActionKind === "queue") {
          deliver({ kind: "send", action: "steer" });
        } else {
          deliver({ kind: "queue" });
        }
        return;
      }

      // If voice recording is active, Enter submits (on any device)
      if (voiceButtonRef.current?.isListening) {
        e.preventDefault();
        deliver(primaryRoute);
        return;
      }

      if (isComposerEnterSend(e)) {
        e.preventDefault();
        deliver(primaryRoute);
      }
    }
  };

  const handlePaste = (e: ClipboardEvent) => {
    if (!canAttach || !onAttach) return;

    const files = getClipboardFiles(e);
    if (files.length > 0) {
      // Prevent default only if we have files to handle
      // This allows text paste to still work normally
      e.preventDefault();
      onAttach(files);
    }
  };

  // Voice input handlers
  const getDetachedSpeechTransaction = useCallback(
    () => pendingSpeechDeliveryRef.current,
    [pendingSpeechDeliveryRef],
  );
  const recordSpeechTranscriptionId = useCallback((id: string) => {
    speechTranscriptionIdsRef.current = [
      ...speechTranscriptionIdsRef.current,
      id,
    ];
  }, []);
  const noteHeardSpeech = useCallback(
    (transcript: string) => {
      speechVocabulary?.heard(transcript);
    },
    [speechVocabulary],
  );
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
    draftControls: controls,
    textareaRef,
    voiceButtonRef,
    pendingSpeechDeliveryRef,
    pendingSpeechDeliverySettledRef,
    noteSpeechAttribution,
    maybeRunPendingSpeechDelivery,
    abandonPendingDelivery: restorePendingSpeechDeliveryDraft,
    onSmartTurnSend: handleSmartTurnSend,
    getDetachedSpeechTransaction,
    onTranscriptionId: recordSpeechTranscriptionId,
    onEdit: noteComposerEdit,
    onHeard: noteHeardSpeech,
  });

  useEffect(() => clearPendingSpeechFinal, []);

  const handleTextareaSelectionTarget = useCallback(() => {
    handleSpeechSelectionTarget(true);
    setComposerCursor(textareaRef.current?.selectionStart ?? text.length);
    revealCollapsedTextareaCursor();
  }, [handleSpeechSelectionTarget, revealCollapsedTextareaCursor, text.length]);

  const handleTextareaClickTarget = useCallback(() => {
    window.setTimeout(handleTextareaSelectionTarget, 0);
  }, [handleTextareaSelectionTarget]);

  const handleComposerKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (newSessionOptionsMode && !event.nativeEvent.isComposing) {
        if (
          event.key === "Escape" &&
          !(
            event.target instanceof Element &&
            event.target.closest(
              '[role="combobox"][aria-expanded="true"], [role="listbox"]',
            )
          )
        ) {
          event.preventDefault();
          event.stopPropagation();
          closeNewSessionOptions();
          return;
        }
        if (
          event.key === "Enter" &&
          event.target === textareaRef.current &&
          !event.shiftKey &&
          !event.ctrlKey &&
          !event.metaKey &&
          !event.altKey &&
          !hasCoarsePointer()
        ) {
          event.preventDefault();
          event.stopPropagation();
          newSessionOptionsFormRef.current?.requestSubmit();
          return;
        }
      }
      handleVoiceInputShortcutKeyDown(event, () => {
        const voice = voiceButtonRef.current;
        if (voice?.isAvailable) voice.toggle();
      });
    },
    [newSessionOptionsMode, closeNewSessionOptions],
  );

  useEffect(() => {
    if (!onAttachAudioMemo || disabled || speechPending || audioMemoOpen)
      return;
    const startMemo = (event: globalThis.KeyboardEvent) => {
      if (
        !event.ctrlKey ||
        !event.shiftKey ||
        event.code !== "Space" ||
        event.repeat
      )
        return;
      // Ordinary typing must not force layout for an unrelated shortcut.
      if (!textareaRef.current?.getClientRects().length) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      setAudioMemoOpen(true);
    };
    document.addEventListener("keydown", startMemo, true);
    return () => document.removeEventListener("keydown", startMemo, true);
  }, [onAttachAudioMemo, disabled, speechPending, audioMemoOpen]);

  const toolbarProps: MessageInputToolbarProps = {
    onAttachmentPanel:
      canAttach && !disabled ? () => setAttachmentPanelOpen(true) : undefined,
    onRecordAudioMemo:
      onAttachAudioMemo && !disabled && !speechPending
        ? () => setAudioMemoOpen(true)
        : undefined,
    sessionId,
    mode,
    onModeChange,
    modeChangesApplyNextTurn,
    modeChangePending,
    supportsPermissionMode,
    supportsThinkingToggle,
    canAttach,
    attachmentCount: attachments.length,
    onAttachClick: () => fileInputRef.current?.click(),
    voiceButtonRef,
    onVoiceTranscript: handleVoiceTranscript,
    onInterimTranscript: handleInterimTranscript,
    onListeningStart: handleListeningStart,
    onListeningStop: handleListeningStop,
    onPendingSpeechChange: handlePendingSpeechChange,
    onTranscriptionSettled: handleTranscriptionSettled,
    voiceDisabled: disabled,
    getTranscriptionContext,
    slashCommands,
    onSelectSlashCommand: handleSlashCommand,
    onBtwClick: onBtwShortcut ? handleBtwClick : undefined,
    btwActive,
    btwHasAsides,
    btwToolbarMode,
    thinkingProvider,
    thinkingModel,
    liveThinkingSelection,
    contextRequestedModel,
    contextUsage,
    lastActivityAt,
    positionTimestampMs,
    positionTimestampStore,
    sessionLiveness,
    providerRuntimeStatus,
    showSteerNowMode: supportsSteerNow && hasActiveDualActions,
    steerNowEnabled,
    onToggleSteerNow: () => setSteerNowOverride(!steerNowEnabled),
    enterActionKind:
      effectivePrimaryActionKind === "steer" ||
      effectivePrimaryActionKind === "queue"
        ? effectivePrimaryActionKind
        : undefined,
    canSwapEnterAction: hasActiveDualActions,
    onSwapEnterAction: toggleEnterActionKind,
    isRunning,
    isThinking,
    onStop,
    onDone,
    doneTitle,
    onSend: handlePrimaryPointerDelivery,
    onSendOptions:
      onProjectQueueNewSession &&
      projectQueueNewSessionTarget &&
      !forkSummaryMode
        ? openImmediateNewSessionOptions
        : undefined,
    hidePrimaryDeliveryActions: newSessionOptionsMode !== null,
    onQueue:
      onQueue && !forkSummaryMode ? handleQueuePointerDelivery : undefined,
    onTopicShift:
      onQueue &&
      topicShiftSupported &&
      !forkSummaryMode &&
      !newSessionOptionsMode
        ? handleTopicShiftPointerDelivery
        : undefined,
    onProjectQueue:
      onProjectQueue && !forkSummaryMode && !newSessionOptionsMode
        ? handleProjectQueuePointerDelivery
        : undefined,
    onProjectQueueNewSession:
      onProjectQueueNewSession && !forkSummaryMode && !newSessionOptionsMode
        ? handleProjectQueueNewSessionPointerDelivery
        : undefined,
    onProjectQueueNewSessionOptions:
      onProjectQueueNewSession &&
      projectQueueNewSessionTarget &&
      !forkSummaryMode
        ? openNewSessionOptions
        : undefined,
    onSteer:
      hasActiveDualActions && !forkSummaryMode
        ? handleSteerPointerDelivery
        : undefined,
    primaryActionKind: effectivePrimaryActionKind,
    sendOverride: questionActionLabel
      ? { label: questionActionLabel, tooltip: questionActionLabel, icon: "↑" }
      : forkSummaryMode
        ? {
            label: forkSummaryMode.submitLabel,
            tooltip: forkSummaryMode.tooltip,
            icon: forkSummaryMode.icon,
          }
        : undefined,
    sendAlternate: forkSummaryMode?.onSubmitWithoutSummary
      ? {
          label:
            forkSummaryMode.noSummarySubmitLabel ??
            t("forkSummaryNoSummarySubmit"),
          tooltip:
            forkSummaryMode.noSummaryTooltip ??
            t("forkSummaryNoSummaryTooltip"),
          icon: forkSummaryMode.noSummaryIcon ?? "↱",
          onClick: handleForkWithoutSummaryPointerDelivery,
        }
      : undefined,
    canForkAfterSummary: !!onForkSummaryShortcut,
    canSend: canSubmit,
    speechMessagePrefix: manualDeliverySpeechPrefix,
    primarySpeechMessagePrefix: manualDeliverySpeechPrefix,
    disabled,
  };
  const showMobileKeyboardCompact = mobileKeyboardOpen && canSubmit;

  const latestRendezAttachmentId = [...attachments]
    .reverse()
    .find((attachment) => attachment.rendezAutoSendAt !== undefined)?.id;
  const composer = (
    <div
      className={`${styles.messageInputWrapper}${fullPane ? ` ${styles.fullPane}` : ""}`}
      data-message-input-wrapper
      data-composer-full-pane={fullPane ? "true" : undefined}
      onKeyDownCapture={handleComposerKeyDown}
    >
      <DraftSyncNotice draftKey={draftKey} sessionId={sessionId} />
      {attachmentPanelOpen && onAttach && (
        <ComposerRecents
          scope={historyScope}
          onFiles={onAttach}
          uploadsOpen
          onUploadsClose={() => setAttachmentPanelOpen(false)}
          onBrowse={() => fileInputRef.current?.click()}
          onMemo={
            onAttachAudioMemo && !speechPending
              ? () => setAudioMemoOpen(true)
              : undefined
          }
          disabled={disabled}
        />
      )}
      {!composerIsEmpty && (
        <button
          type="button"
          className={styles.clearComposer}
          onPointerDown={(event) => event.preventDefault()}
          onClick={clearComposer}
          disabled={disabled}
          aria-label={t("toolbarShortcutClearComposer")}
          title={t("toolbarShortcutClearComposer")}
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.75"
            aria-hidden="true"
          >
            <path d="m6 6 12 12M18 6 6 18" />
          </svg>
        </button>
      )}
      {/* Floating toggle button - only show when user can control collapse (not externally collapsed) */}
      {!externalCollapsed && (
        <button
          type="button"
          className={styles.messageInputToggle}
          onClick={() => setUserCollapsed(!userCollapsed)}
          aria-label={
            userCollapsed ? t("messageInputExpand") : t("messageInputCollapse")
          }
          aria-expanded={!userCollapsed}
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={userCollapsed ? styles.chevronUp : ""}
            aria-hidden="true"
          >
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </button>
      )}
      {!externalCollapsed && (
        <FullPaneComposerToggle
          expanded={fullPane}
          onToggle={toggleFullPane}
          className={styles.fullPaneToggle}
        />
      )}
      <div
        className={`${styles.messageInput} ${collapsed ? styles.messageInputCollapsed : ""} ${
          collapsed &&
          (showCollapsedLineCount || showCollapsedDesktopMicrophone)
            ? styles.hasCollapsedSideActions
            : ""
        }${showCollapsedMicrophone ? ` ${styles.collapsedWithLeadingMicrophone}` : ""}${showCollapsedMicrophone && !showCollapsedSendAction ? ` ${styles.collapsedWithLeadingMicrophoneOnly}` : ""}`}
        data-message-input
        data-message-input-collapsed={collapsed || undefined}
        data-composer-shell="true"
        data-collapsed-leading-microphone={showCollapsedMicrophone || undefined}
      >
        <SpeechDraftField
          interimDisplayTranscript={interimDisplayTranscript}
          interimInsertion={interimInsertion}
          interimTranscript={interimTranscript}
        >
          <textarea
            data-draft-key={draftKey}
            key={textareaImeGeneration}
            ref={textareaRef}
            data-composer-input
            onCompositionStart={() => setIsComposing(true)}
            onCompositionEnd={() => setIsComposing(false)}
            value={text}
            onBeforeInput={(event) => {
              const nativeEvent = event.nativeEvent as InputEvent;
              pendingDraftInputRef.current = {
                start: event.currentTarget.selectionStart,
                end: event.currentTarget.selectionEnd,
                inputType: nativeEvent.inputType,
              };
            }}
            onChange={(e) => {
              untouchedRecallRef.current = null;
              const nextText = fileCompletion.normalizeInput(e.target.value);
              const pendingInput = pendingDraftInputRef.current;
              pendingDraftInputRef.current = null;
              noteDraftTextChange(
                text,
                nextText,
                pendingInput
                  ? {
                      ...pendingInput,
                      insertedText: getInsertedTextForEdit(
                        text,
                        nextText,
                        pendingInput.start,
                        pendingInput.end,
                      ),
                    }
                  : undefined,
              );
              noteSpeechDraftEdit(text, nextText);
              handleSpeechSelectionTarget(true, nextText);
              noteComposerEdit(nextText);
              setText(nextText);
              const nextCursor = e.target.selectionStart;
              setComposerCursor(nextCursor);
              const nextSlashQuery = getInvocationCompletionQuery(
                nextText,
                nextCursor,
              );
              const nextSlashQueryKey = nextSlashQuery
                ? `${nextSlashQuery.start}:${nextSlashQuery.end}:${nextSlashQuery.sigil}:${nextSlashQuery.query}`
                : null;
              if (nextSlashQueryKey !== dismissedSlashQuery) {
                setDismissedSlashQuery(null);
              }
            }}
            onBlur={() => {
              fileCompletion.onBlur();
              fileViewCompletion.onBlur();
              cancelRecallDrawer();
              controls.flushDraft();
              setTextareaFocused(false);
            }}
            onFocus={() => {
              fileCompletion.onFocus();
              fileViewCompletion.onFocus();
              keyboardViewportBaselineRef.current = getComposerViewportHeight();
              setTextareaFocused(true);
              revealCollapsedTextareaCursor();
            }}
            onKeyDown={handleKeyDown}
            onSelect={() => {
              const textarea = textareaRef.current;
              if (
                textarea &&
                (textarea.selectionStart !== textarea.value.length ||
                  textarea.selectionEnd !== textarea.value.length)
              ) {
                untouchedRecallRef.current = null;
              }
              handleTextareaSelectionTarget();
              fileCompletion.onSelect();
            }}
            onPointerUp={handleTextareaSelectionTarget}
            onClick={handleTextareaClickTarget}
            onKeyUp={handleTextareaSelectionTarget}
            onCut={clearSpeechSelectionTarget}
            onCopy={clearSpeechSelectionTarget}
            onPaste={(event) => {
              clearSpeechSelectionTarget();
              handlePaste(event);
            }}
            enterKeyHint="enter"
            placeholder={
              externalCollapsed
                ? t("messageInputContinueAbove")
                : forkSummaryMode
                  ? forkSummaryMode.placeholder
                  : placeholder
            }
            disabled={disabled}
            rows={collapsed ? 1 : 3}
          />
        </SpeechDraftField>

        <ProjectFileCompletionMenu
          completion={fileCompletion}
          spans={fileCompletion.spans}
        />
        <FileViewCompletionSheet
          completion={fileViewCompletion}
          onGoToTurn={turnRecall?.onGoToTurn}
        />
        {(showBangChip || showBangEscapedChip) && (
          <div
            className={`${styles.bangComposerChip}${showBangEscapedChip ? ` ${styles.bangComposerChipEscaped}` : ""}`}
            role="status"
          >
            {showBangEscapedChip
              ? t("bangComposerEscapedChip")
              : t("bangComposerChip")}
          </div>
        )}

        {recognizedSkillTokens.length > 0 && (
          <div className={styles.skillInvocationStatus} role="status">
            <span>{t("skillInvocationRecognized")}</span>
            <code>{recognizedSkillTokens.join(", ")}</code>
          </div>
        )}

        {unrecognizedSkillTokens.length > 0 && (
          <div
            className={`${styles.skillInvocationStatus} ${styles.skillInvocationStatusWarning}`}
            role="status"
          >
            <span>{t("skillInvocationUnrecognized")}</span>
            <code>{unrecognizedSkillTokens.join(", ")}</code>
            <span>{t("skillInvocationStillSent")}</span>
          </div>
        )}

        {showBangSuggestions && (
          <div
            className={`${slashStyles.slashCommandMenu} ${slashStyles.composerSlashCommandMenu} `}
            data-bang-completion-menu=""
            role="menu"
          >
            {bangMenuItems.map((item, index) => (
              <button
                key={`${item.source}:${item.value}`}
                type="button"
                className={`${slashStyles.slashCommandItem}${index === selectedBangIndex ? ` ${slashStyles.active}` : ""}`}
                data-slash-command-item
                data-bang-history-item={item.source === "history" || undefined}
                onMouseEnter={() => setSelectedBangIndex(index)}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  applyBangMenuItem(item);
                  textareaRef.current?.focus();
                }}
                role="menuitem"
              >
                <span>{item.value}</span>
              </button>
            ))}
          </div>
        )}

        {showSlashSuggestions && (
          <div
            className={`${slashStyles.slashCommandMenu} ${slashStyles.composerSlashCommandMenu}`}
            role="menu"
          >
            {matchingSlashCommands.map((command, index) => {
              const parts = getSlashCommandMenuParts(command);
              return (
                <button
                  key={`${getCanonicalInvocationToken(command)}:${command.invocation?.kind ?? "legacy"}`}
                  type="button"
                  className={`${slashStyles.slashCommandItem}${index === selectedSlashIndex ? ` ${slashStyles.active}` : ""}`}
                  data-slash-command-item
                  onMouseEnter={() => setSelectedSlashIndex(index)}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => handleSlashCommand(command)}
                  role="menuitem"
                  aria-label={parts.label}
                >
                  <span className={slashStyles.slashCommandCopy}>
                    {/* shortcut + rest is one command word split for
                        highlighting; keep it a single inline run so no flex
                        gap lands inside the word. */}
                    <span>
                      {parts.shortcut && (
                        <strong
                          className={slashStyles.slashCommandShortcut}
                          data-slash-command-shortcut
                        >
                          {parts.shortcut}
                        </strong>
                      )}
                      {parts.rest}
                    </span>
                    {(command.description || command.argumentHint) && (
                      <span className={slashStyles.slashCommandDetail}>
                        {[command.description, command.argumentHint]
                          .filter(Boolean)
                          .join(" · ")}
                      </span>
                    )}
                  </span>
                </button>
              );
            })}
            {matchingSlashArgumentCompletions.map((match, offset) => {
              const index = matchingSlashCommands.length + offset;
              const value = match.completion.value.trim();
              const label = `${getCanonicalInvocationToken(match.command)} ${value}`;
              return (
                <button
                  key={`${getCanonicalInvocationToken(match.command)}:${value}`}
                  type="button"
                  className={`${slashStyles.slashCommandItem}${index === selectedSlashIndex ? ` ${slashStyles.active}` : ""}`}
                  data-slash-command-item
                  onMouseEnter={() => setSelectedSlashIndex(index)}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => handleSlashArgumentCompletion(match)}
                  role="menuitem"
                  aria-label={label}
                >
                  <span className={slashStyles.slashCommandCopy}>
                    <span>{label}</span>
                    {match.completion.description && (
                      <span className={slashStyles.slashCommandDetail}>
                        {match.completion.description}
                      </span>
                    )}
                  </span>
                </button>
              );
            })}
          </div>
        )}

        {recallDrawer && (
          <ComposerRecallMenu
            matches={recallDrawer.matches}
            activeIndex={recallDrawer.index}
            showGoTo={!!turnRecall?.onGoToTurn}
            onHighlight={highlightRecallEntry}
            onAccept={acceptRecallEntry}
            onGoTo={goToRecallTurn}
          />
        )}

        {collapsed &&
          (showCollapsedLineCount || showCollapsedDesktopMicrophone) && (
            <div className={styles.messageInputCollapsedSideActions}>
              {showCollapsedLineCount && (
                <span
                  className={styles.messageInputCollapsedLineCount}
                  title={t("messageInputCollapsedLineCount", {
                    count: String(collapsedLineCount),
                  })}
                >
                  {t("messageInputCollapsedLineCount", {
                    count: String(collapsedLineCount),
                  })}
                </span>
              )}
              {showCollapsedDesktopMicrophone && (
                <VoiceInputButton
                  ref={sharedVoiceRef}
                  onTranscript={handleVoiceTranscript}
                  onInterimTranscript={handleInterimTranscript}
                  onListeningStart={handleListeningStart}
                  onListeningStop={handleListeningStop}
                  onPendingSpeechChange={handlePendingSpeechChange}
                  onTranscriptionSettled={handleTranscriptionSettled}
                  disabled={disabled}
                  getTranscriptionContext={getTranscriptionContext}
                  className={voiceStyles.messageInputCollapsedMic}
                />
              )}
            </div>
          )}

        {collapsed && (
          <div
            className={`${styles.messageInputCollapsedActions}${showCollapsedMicrophone ? ` ${styles.collapsedActionsWithMicrophone}` : ""}`}
          >
            {showCollapsedMicrophone && (
              <VoiceInputButton
                ref={sharedVoiceRef}
                onTranscript={handleVoiceTranscript}
                onInterimTranscript={handleInterimTranscript}
                onListeningStart={handleListeningStart}
                onListeningStop={handleListeningStop}
                onPendingSpeechChange={handlePendingSpeechChange}
                onTranscriptionSettled={handleTranscriptionSettled}
                disabled={disabled}
                getTranscriptionContext={getTranscriptionContext}
                className={voiceStyles.messageInputCollapsedMic}
              />
            )}
            {showCollapsedSendAction && (
              <button
                type="button"
                onClick={collapsedSubmitAction}
                disabled={disabled || !canSubmit}
                className={`${actionStyles.sendButton} ${styles.messageInputCollapsedSend}`}
                data-send-button
                aria-label={collapsedActionLabel}
                title={collapsedActionLabel}
              >
                <DeliveryGlyph className={actionStyles.sendIcon}>
                  {collapsedActionIcon}
                </DeliveryGlyph>
              </button>
            )}
          </div>
        )}

        {correctionActive && (
          <div className={styles.correctionDraft}>
            <span>{t("sessionCorrectionActive")}</span>
            <button
              type="button"
              className={styles.correctionCancel}
              onClick={onCancelCorrection}
              aria-label={t("sessionCorrectionCancel")}
              title={t("sessionCorrectionCancel")}
            >
              {t("sessionCorrectionBack")}
            </button>
          </div>
        )}

        {!collapsed && forkSummaryMode && (
          <ForkSummaryDraftNotice mode={forkSummaryMode} />
        )}

        {/* Attachment chips - show below textarea when not collapsed */}
        {!collapsed &&
          (attachments.length > 0 || uploadProgress.length > 0) && (
            <div className={styles.attachmentList} data-attachment-list>
              {attachments.map((file) => {
                const chip = (
                  <AttachmentChip
                    key={file.id}
                    attachmentId={file.id}
                    originalName={file.originalName}
                    path={file.path ?? file.rendezPath}
                    mimeType={file.mimeType}
                    sizeLabel={formatFileSize(file.size)}
                    imageWidth={file.width}
                    imageHeight={file.height}
                    previewUrl={file.previewUrl}
                    projectId={projectId}
                    onRemove={
                      onRemoveAttachment
                        ? () => onRemoveAttachment(file.id)
                        : undefined
                    }
                  />
                );
                return file.id === latestRendezAttachmentId ? (
                  <RendezAttachment
                    key={file.id}
                    sendAt={file.rendezAutoSendAt ?? null}
                    hasText={text.length > 0}
                  >
                    {chip}
                  </RendezAttachment>
                ) : (
                  <Fragment key={file.id}>{chip}</Fragment>
                );
              })}
              {uploadProgress.map((progress) => (
                <div
                  key={progress.fileId}
                  className={`${chipStyles.chip} ${chipStyles.uploading}`}
                >
                  <span className={chipStyles.name}>{progress.fileName}</span>
                  <span className={chipStyles.progress}>
                    {progress.percent}%
                  </span>
                </div>
              ))}
            </div>
          )}

        {/* Hidden file input */}
        <input
          ref={fileInputRef}
          type="file"
          multiple
          style={{ display: "none" }}
          onChange={handleFileSelect}
        />

        {!collapsed && composerIsEmpty && promptSuggestion && (
          <ComposerPromptSuggestion
            suggestion={promptSuggestion}
            onDismiss={onDismissPromptSuggestion}
            onAccept={() => {
              const metadata = buildSubmissionMetadata("direct");
              onDismissPromptSuggestion?.();
              onSend(promptSuggestion, metadata);
              textareaRef.current?.focus();
            }}
          />
        )}

        {!collapsed && showMobileKeyboardCompact && !newSessionOptionsMode && (
          <div
            className={styles.messageInputKeyboardCompact}
            data-message-input-keyboard-compact
          >
            {mobileKeyboardMoreOpen && (
              <div
                id="message-input-keyboard-more-controls"
                className={styles.messageInputKeyboardMorePanel}
                data-message-input-keyboard-more-panel
                role="toolbar"
                aria-label={t("toolbarOverflowMenu")}
                onPointerDown={(event) => event.preventDefault()}
              >
                <MessageInputToolbar
                  {...toolbarProps}
                  onProjectQueue={undefined}
                  onProjectQueueNewSession={undefined}
                  hidePrimaryDeliveryActions
                  hideVoiceInput
                />
              </div>
            )}
            <div
              data-message-input-keyboard-actions
              className={`${actionStyles.messageInputKeyboardActions}${forkSummaryMode?.onSubmitWithoutSummary ? ` ${actionStyles.hasAlternate}` : ""}`}
            >
              <button
                type="button"
                className={`${styles.messageInputKeyboardMore}${mobileKeyboardMoreOpen ? ` ${styles["is-open"]}` : ""}`}
                data-message-input-keyboard-more
                onPointerDown={(event) => event.preventDefault()}
                onClick={() => setMobileKeyboardMoreOpen((open) => !open)}
                aria-label={t("toolbarOverflowMenu")}
                aria-expanded={mobileKeyboardMoreOpen}
                aria-controls="message-input-keyboard-more-controls"
                title={t("toolbarOverflowMenu")}
              >
                <span aria-hidden="true">...</span>
              </button>
              {toolbarVisibility.microphone && (
                <div
                  className={`${actionStyles.messageInputKeyboardSecondarySlot} ${styles.keyboardSpeechSlot}${toolbarVisibility.waveform ? ` ${styles.keyboardSpeechSlotWithWaveform}` : ""}`}
                  data-message-input-keyboard-secondary-slot
                  data-waveform-reserved={
                    toolbarVisibility.waveform || undefined
                  }
                  data-waveform-active={keyboardWaveformActive || undefined}
                  onPointerDown={(event) => event.preventDefault()}
                >
                  <VoiceInputButton
                    ref={sharedVoiceRef}
                    onTranscript={handleVoiceTranscript}
                    onInterimTranscript={handleInterimTranscript}
                    onListeningStart={handleListeningStart}
                    onListeningStop={handleListeningStop}
                    onPendingSpeechChange={handlePendingSpeechChange}
                    onTranscriptionSettled={handleTranscriptionSettled}
                    disabled={disabled}
                    getTranscriptionContext={getTranscriptionContext}
                    showWaveform={toolbarVisibility.waveform}
                    inlineWaveform={toolbarVisibility.waveform}
                    onWaveformActiveChange={
                      toolbarVisibility.waveform
                        ? setKeyboardWaveformActive
                        : undefined
                    }
                    className={`${actionStyles.messageInputKeyboardAction} ${actionStyles.messageInputKeyboardSecondary}`}
                  />
                </div>
              )}
              {showMobileProjectQueueAction && (
                <MessageInputKeyboardSlot kind="projectQueue">
                  <button
                    type="button"
                    className={`${actionStyles.messageInputKeyboardAction} ${actionStyles.messageInputKeyboardSecondary} ${actionStyles.projectQueueMode}`}
                    data-message-input-keyboard-action
                    data-message-input-keyboard-secondary
                    data-project-queue-mode
                    onPointerDown={(event) => event.preventDefault()}
                    onClick={handleProjectQueuePointerDelivery}
                    disabled={disabled}
                    aria-label={describePrefixedDelivery(
                      t("toolbarProjectQueueLabel"),
                    )}
                    title={describePrefixedTooltip(
                      projectQueueShortcutAvailable
                        ? t("toolbarProjectQueueTooltipWithShortcut")
                        : t("toolbarProjectQueueTooltip"),
                    )}
                  >
                    <DeliveryGlyph>⇥</DeliveryGlyph>
                    {manualDeliverySpeechPrefix && (
                      <SpeechPrefixActionCue
                        prefix={manualDeliverySpeechPrefix}
                      />
                    )}
                  </button>
                </MessageInputKeyboardSlot>
              )}
              {showMobileProjectQueueNewSessionAction && (
                <MessageInputKeyboardSlot kind="newSession">
                  <button
                    type="button"
                    className={`${actionStyles.messageInputKeyboardAction} ${actionStyles.messageInputKeyboardSecondary} ${actionStyles.projectQueueMode} ${actionStyles.projectQueueNewSessionButton}`}
                    data-project-queue-new-session-button
                    data-message-input-keyboard-action
                    data-message-input-keyboard-secondary
                    data-project-queue-mode
                    onPointerDown={(event) => event.preventDefault()}
                    onClick={handleProjectQueueNewSessionPointerDelivery}
                    disabled={disabled}
                    aria-label={describePrefixedDelivery(
                      t("toolbarProjectQueueNewSessionLabel"),
                    )}
                    title={describePrefixedTooltip(
                      t("toolbarProjectQueueNewSessionTooltip"),
                    )}
                  >
                    <DeliveryGlyph>⇥</DeliveryGlyph>
                    <NewSessionQueueMark />
                    {manualDeliverySpeechPrefix && (
                      <SpeechPrefixActionCue
                        prefix={manualDeliverySpeechPrefix}
                      />
                    )}
                  </button>
                </MessageInputKeyboardSlot>
              )}
              {showMobileSessionAlternateAction && (
                <MessageInputKeyboardSlot kind="sessionAlternate">
                  <button
                    type="button"
                    data-delivery-kind={mobileKeyboardAlternateAction.kind}
                    className={`${actionStyles.messageInputKeyboardAction} ${actionStyles.messageInputKeyboardSecondary} ${composerActionsStateClasses[`${mobileKeyboardAlternateAction.kind}-mode`] ?? ""}`}
                    data-message-input-keyboard-action
                    data-message-input-keyboard-secondary
                    onPointerDown={(event) => event.preventDefault()}
                    onClick={mobileKeyboardAlternateAction.onClick}
                    disabled={disabled}
                    aria-label={describePrefixedDelivery(
                      mobileKeyboardAlternateAction.label,
                    )}
                    title={describePrefixedTooltip(
                      mobileKeyboardAlternateAction.label,
                    )}
                  >
                    <DeliveryGlyph>
                      {mobileKeyboardAlternateAction.icon}
                    </DeliveryGlyph>
                    {manualDeliverySpeechPrefix && (
                      <SpeechPrefixActionCue
                        prefix={manualDeliverySpeechPrefix}
                      />
                    )}
                  </button>
                </MessageInputKeyboardSlot>
              )}
              {forkSummaryMode?.onSubmitWithoutSummary &&
                mobileKeyboardAlternateAction && (
                  <button
                    type="button"
                    data-delivery-kind={mobileKeyboardAlternateAction.kind}
                    className={`${actionStyles.messageInputKeyboardAction} ${composerActionsStateClasses[`${mobileKeyboardAlternateAction.kind}-mode`] ?? ""}`}
                    data-message-input-keyboard-action
                    onPointerDown={(event) => event.preventDefault()}
                    onClick={mobileKeyboardAlternateAction.onClick}
                    disabled={disabled}
                    aria-label={describePrefixedDelivery(
                      mobileKeyboardAlternateAction.label,
                    )}
                    title={describePrefixedTooltip(
                      mobileKeyboardAlternateAction.label,
                    )}
                  >
                    <span>{mobileKeyboardAlternateAction.displayLabel}</span>
                    <DeliveryGlyph>
                      {mobileKeyboardAlternateAction.icon}
                    </DeliveryGlyph>
                    {manualDeliverySpeechPrefix && (
                      <SpeechPrefixActionCue
                        prefix={manualDeliverySpeechPrefix}
                      />
                    )}
                  </button>
                )}
              {bangQuery !== null && (
                <button
                  type="button"
                  className={`${actionStyles.messageInputKeyboardAction} ${actionStyles.messageInputKeyboardSecondary} ${actionStyles.bangTabMode}`}
                  data-message-input-keyboard-action
                  data-message-input-keyboard-secondary
                  onPointerDown={(event) => event.preventDefault()}
                  onClick={() => performBangTabComplete()}
                  disabled={disabled}
                  aria-label={t("bangTabCompleteLabel")}
                  title={t("bangTabCompleteLabel")}
                >
                  <span>Tab</span>
                  <DeliveryGlyph>⇥</DeliveryGlyph>
                </button>
              )}
              {toolbarVisibility.composerRecall &&
                turnRecall &&
                turnRecall.entries.length > 0 &&
                !hasNonTextComposerContent &&
                !recallDrawer &&
                bangQuery === null && (
                  // Touch-keyboard opener for the recall drawer, where there is
                  // no Ctrl+↑. Opens over the same prefix-matched turns (empty
                  // draft → all). Hidden by default via the composerRecall
                  // toolbar control; Ctrl+↑ is unaffected by the setting.
                  // See topics/composer-recall-drawer.md.
                  <button
                    type="button"
                    className={`${actionStyles.messageInputKeyboardAction} ${actionStyles.messageInputKeyboardSecondary} `}
                    data-composer-recall-open=""
                    data-message-input-keyboard-action
                    data-message-input-keyboard-secondary
                    onPointerDown={(event) => event.preventDefault()}
                    onClick={() => openRecallDrawer()}
                    disabled={disabled}
                    aria-label={t("composerRecallOpenButton")}
                    title={t("composerRecallOpenButton")}
                  >
                    <svg
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
                      <path d="M3 3v5h5" />
                      <path d="M3.05 13A9 9 0 1 0 6 5.3L3 8" />
                      <path d="M12 7v5l3 3" />
                    </svg>
                  </button>
                )}
              <button
                type="button"
                data-delivery-kind={effectivePrimaryActionKind}
                className={`${actionStyles.messageInputKeyboardAction} ${actionStyles.messageInputKeyboardPrimary} ${composerActionsStateClasses[`${effectivePrimaryActionKind}-mode`] ?? ""}${toolbarVisibility.waveform ? ` ${styles.keyboardPrimaryWithWaveform}` : ""}`}
                data-message-input-keyboard-action
                data-message-input-keyboard-primary
                onPointerDown={(event) => event.preventDefault()}
                onClick={handlePrimaryPointerDelivery}
                onContextMenu={
                  toolbarProps.onSendOptions
                    ? (event) => {
                        event.preventDefault();
                        toolbarProps.onSendOptions?.();
                      }
                    : undefined
                }
                disabled={disabled}
                aria-label={describePrefixedDelivery(
                  mobileKeyboardActionLabel,
                  manualDeliverySpeechPrefix,
                )}
                title={describePrefixedTooltip(
                  mobileKeyboardActionLabel,
                  manualDeliverySpeechPrefix,
                )}
              >
                {mobileKeyboardActionDisplayLabel && (
                  <span
                    className={actionStyles.messageInputKeyboardPrimaryLabel}
                    data-message-input-keyboard-primary-label
                  >
                    {mobileKeyboardActionDisplayLabel}
                  </span>
                )}
                <DeliveryGlyph
                  className={actionStyles.messageInputKeyboardPrimaryIcon}
                >
                  {mobileKeyboardActionIcon}
                </DeliveryGlyph>
                {manualDeliverySpeechPrefix && (
                  <SpeechPrefixActionCue prefix={manualDeliverySpeechPrefix} />
                )}
              </button>
            </div>
          </div>
        )}

        {!collapsed && !showMobileKeyboardCompact && (
          <MessageInputToolbar {...toolbarProps} />
        )}
        {!collapsed &&
          newSessionOptionsMode &&
          projectQueueNewSessionTarget && (
            <NewSessionQueueOptions
              initial={projectQueueNewSessionTarget}
              primaryDelivery={newSessionOptionsMode}
              formRef={newSessionOptionsFormRef}
              disabled={!canSubmit || disabled}
              onSubmit={queueNewSessionAtChosenTarget}
              onClose={closeNewSessionOptions}
            />
          )}
      </div>
    </div>
  );
  if (audioMemoOpen && onAttachAudioMemo) {
    return (
      <AudioMemoPanel
        projectId={projectId}
        sessionId={sessionId}
        onCancel={() => setAudioMemoOpen(false)}
        onCommit={async (file, transcript) => {
          const draft = controls.getDraft();
          const metadata = buildSubmissionMetadata(
            effectivePrimaryActionKind === "steer"
              ? "steer"
              : effectivePrimaryActionKind === "queue"
                ? "deferred"
                : "direct",
          );
          await onAttachAudioMemo(file);
          const suffix = transcript.trim()
            ? `🎤 ${t("audioMemoTranscriptSuffix")}\n${transcript.trim()}`
            : "";
          const message =
            [draft.trimEnd(), suffix].filter(Boolean).join("\n\n") ||
            `🎤 ${t("audioMemoTitle")}`;
          controls.setDraft(message);
          controls.clearInput();
          resetCompositionMetadata();
          onSend(message, metadata);
          setAudioMemoOpen(false);
        }}
      />
    );
  }
  return (
    <>
      {showQuestionAsideHint && (
        <QuestionAsideHint mobile={hasCoarsePointer()} />
      )}
      {composer}
    </>
  );
}
