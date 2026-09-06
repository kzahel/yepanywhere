import {
  DEFAULT_PATIENT_QUEUE_PATIENCE_SECONDS,
  DEFAULT_PROJECT_QUEUE_CTRL_ENTER_ENABLED,
  DEFAULT_STEER_NOW_ENABLED,
  type BusyComposerDefaultAction,
  clampPatientPatienceSeconds,
  commandMatchesInvocationQuery,
  type CollapsedComposerButtonPreference,
  type EffortLevel,
  findSkillInvocations,
  findUnrecognizedInvocations,
  getCanonicalInvocationToken,
  getInvocationCompletionQuery,
  getInvocationNames,
  type SessionLivenessSnapshot,
  type SlashCommand,
  type ThinkingMode,
  type UserMessageDeliveryIntent,
  type UserMessageSpeechMetadata,
} from "@yep-anywhere/shared";
import {
  type ClipboardEvent,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { ENTER_SENDS_MESSAGE } from "../constants";
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
  countDraftLines,
  getInsertedTextForEdit,
  isFullPaneComposerShortcut,
  replaceTextareaRangeUndoably,
  resizeComposerTextarea,
  scrollCollapsedTextareaToCursor,
} from "../lib/composerTextarea";
import {
  type ComposerTurnRecallEntry,
  filterComposerTurnRecall,
} from "../lib/composerTurnRecall";
import { hasCoarsePointer } from "../lib/deviceDetection";
import { MOBILE_KEYBOARD_OPEN_VIEWPORT_RATIO } from "../lib/mobileKeyboardViewport";
import { focusComposerForSpeechTransition } from "../lib/speechComposerFocus";
import type {
  SpeechTranscriptionContext,
  SpeechTranscriptionResultMetadata,
  SpeechTranscriptionSettlement,
} from "../lib/speechProviders/SpeechProvider";
import {
  clearSpeechInsertionRangeReplacement,
  createSpeechInsertionRange,
  getSpeechSelectionFinalDelayMs,
  getSpeechInterimDisplayTranscript,
  getSpeechTranscriptInsertionParts,
  getSpeechTranscriptReplacementParts,
  getSpeechVisibleDraftText,
  mapSpeechInsertionRangeThroughEdit,
  mapSpeechInsertionRangeThroughReplacement,
  retargetSpeechInsertionRange,
  type SpeechInsertionRange,
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
import {
  applyBangCompletion,
  getBangCompletionQuery,
  longestCommonPrefix,
  resolveComposerBangDraft,
} from "../lib/bangCommands";
import {
  getSlashCommandArgumentCompletionMatches,
  getSlashCommandMenuParts,
  type SlashCommandArgumentCompletionMatch,
} from "../lib/slashCommands";
import {
  createClientSpeechTurnId,
  createSpeechTargetId,
} from "../lib/speechTargets";
import { isVoiceInputShortcut } from "../lib/voiceInputShortcut";
import { serverSupportsProjectQueue } from "../lib/projectQueueVisibility";
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
import { SpeechPrefixActionCue } from "./SpeechPrefixActionCue";
import {
  VoiceInputButton,
  type SpeechCycleSettlement,
  type SpeechPendingKind,
  type VoiceInputButtonRef,
} from "./VoiceInputButton";
import styles from "./MessageInput.module.css";

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
}

export interface FullPaneComposerControls {
  restore: () => void;
}

export type { MessageSubmissionMetadata } from "../types/messageSubmission";

interface PendingSpeechFinal {
  timer: ReturnType<typeof setTimeout>;
  transcript: string;
  metadata?: SpeechTranscriptionResultMetadata;
}

type PendingSpeechDeliveryIntent =
  | {
      kind: "submit";
      actionOverride?: "send" | "steer" | "queue";
      focusAfterSubmit: boolean;
    }
  | { kind: "queue"; focusAfterSubmit: boolean }
  | {
      kind: "project-queue";
      newSession: boolean;
      focusAfterSubmit: boolean;
    }
  | {
      kind: "fork-summary";
      focusAfterSubmit: boolean;
      speechTriggered: boolean;
    }
  | { kind: "fork-without-summary"; focusAfterSubmit: boolean };

interface SubmissionCompositionSnapshot {
  typingStartedAt: string | null;
  lastEditedAt: string | null;
  speechTurnId: string | null;
  speechTranscriptionIds: string[];
}

interface PendingSpeechDelivery {
  intent: PendingSpeechDeliveryIntent;
  visibleTextSnapshot: string;
  draft: string;
  composition: SubmissionCompositionSnapshot;
  speechInsertionRangeRef: { current: SpeechInsertionRange | null };
  activeSpeechTargetIdRef: { current: string | null };
  speechInsertionRangesRef: {
    current: Map<string, SpeechInsertionRange>;
  };
  pendingTextareaSelectionRef: {
    current: PendingTextareaSelectionRestore | null;
  };
  pendingSpeechRetargetRef: {
    current: PendingSpeechRetarget | null;
  };
}

interface PendingDraftInputEdit {
  start: number;
  end: number;
  inputType?: string;
}

function getComposerViewportHeight(): number {
  const visualViewportHeight = window.visualViewport?.height;
  return typeof visualViewportHeight === "number"
    ? Math.min(window.innerHeight, visualViewportHeight)
    : window.innerHeight;
}

interface Props {
  onSend: (text: string, metadata?: MessageSubmissionMetadata) => void;
  /** Queue a deferred message (sent when agent's turn ends). Only provided when agent is running. */
  onQueue?: (text: string, metadata?: MessageSubmissionMetadata) => void;
  /** Queue through the project-level idle gate. Hidden unless opted in. */
  onProjectQueue?: (text: string, metadata?: MessageSubmissionMetadata) => void;
  /** Queue this draft as the opening turn of a new session in the project. */
  onProjectQueueNewSession?: (
    text: string,
    metadata?: MessageSubmissionMetadata,
  ) => void;
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
  /** Session ID for uploads (required to enable attach button) */
  sessionId?: string;
  /** Completed file attachments */
  attachments?: MessageInputAttachment[];
  /** Callback when user selects files to attach */
  onAttach?: (files: File[]) => void;
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
  /** Current behavior of the primary composer action. */
  primaryActionKind?: "send" | "steer" | "queue";
  /** Available provider and client commands. */
  slashCommands?: SlashCommand[];
  /** Callback for custom client-side commands (e.g., "model"). Return true if handled. */
  onCustomCommand?: (command: string) => boolean;
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
  /** Whether heartbeat turns are currently enabled for this session */
  heartbeatEnabled?: boolean;
  /** Current quiet-period timeout used by patient queue mode. */
  patientQueuePatienceSeconds?: number | null;
  /** Quick-toggle session heartbeat */
  onToggleHeartbeat?: () => void;
  /** Open heartbeat session settings */
  onConfigureHeartbeat?: () => void;
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
    fetchCompletions: (
      token: string,
      kind: "command" | "path",
      line: string,
    ) => Promise<{ completions: string[]; history: string[] }>;
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

/**
 * One row of the bang completion menu. Global command-history matches
 * (`history`) are ranked ahead of PATH/project/path token candidates
 * (`candidate`); selecting a history row replaces the whole `!!` body,
 * a candidate keeps the token-replacement behavior.
 */
type BangMenuItem = { source: "history" | "candidate"; value: string };

/**
 * Opaque identity of a draft's completion query (kind, token, full body),
 * compared — never parsed — to decide whether a dismissed menu stays
 * dismissed for the current draft.
 */
function bangCompletionQueryKey(draft: string): string | null {
  const query = getBangCompletionQuery(draft);
  return query ? `${query.kind} ${query.token}\0${draft.slice(2)}` : null;
}

export function MessageInput({
  onSend,
  onQueue,
  onProjectQueue,
  onProjectQueueNewSession,
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
  sessionId,
  attachments = [],
  onAttach,
  onRemoveAttachment,
  uploadProgress = [],
  supportsPermissionMode = true,
  supportsThinkingToggle = true,
  supportsSteering = false,
  supportsSteerNow = false,
  primaryActionKind,
  slashCommands = [],
  onCustomCommand,
  onBtwShortcut,
  btwActive = false,
  btwHasAsides = false,
  btwToolbarMode,
  thinkingProvider,
  thinkingModel,
  liveThinkingSelection,
  contextRequestedModel,
  heartbeatEnabled = false,
  patientQueuePatienceSeconds,
  onToggleHeartbeat,
  onConfigureHeartbeat,
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
  const fileInputRef = useRef<HTMLInputElement>(null);
  const voiceButtonRef = useRef<VoiceInputButtonRef>(null);
  const typingStartedAtRef = useRef<string | null>(null);
  const lastEditedAtRef = useRef<string | null>(null);
  const speechTurnIdRef = useRef<string | null>(null);
  const speechTranscriptionIdsRef = useRef<string[]>([]);
  const speechInsertionRangeRef = useRef<SpeechInsertionRange | null>(null);
  const activeSpeechTargetIdRef = useRef<string | null>(null);
  const speechInsertionRangesRef = useRef<Map<string, SpeechInsertionRange>>(
    new Map(),
  );
  const pendingSpeechRetargetRef = useRef<PendingSpeechRetarget | null>(null);
  const pendingSpeechFinalRef = useRef<PendingSpeechFinal | null>(null);
  const pendingDraftInputRef = useRef<PendingDraftInputEdit | null>(null);
  const draftTextChangeMetadataRef = useRef<DraftTextChangeMetadata | null>(
    null,
  );
  // True once the user manually edits (non-whitespace) during the active mic
  // transaction; holds an automatic Smart Turn endpoint send. Speech-inserted
  // finals go through setDraft (not onChange) and never set this.
  const composerEditedDuringSpeechRef = useRef(false);
  const pendingTextareaSelectionRef =
    useRef<PendingTextareaSelectionRestore | null>(null);
  const mobilePointerDeliveryPendingRef = useRef(false);
  const keyboardViewportBaselineRef = useRef<number | null>(null);
  // User-controlled collapse state (independent of external collapse from approval panel)
  const [userCollapsed, setUserCollapsed] = useState(false);
  const [fullPane, setFullPane] = useState(false);
  const [interimTranscript, setInterimTranscript] = useState("");
  const interimTranscriptRef = useRef(interimTranscript);
  interimTranscriptRef.current = interimTranscript;
  const [speechPending, setSpeechPending] = useState<SpeechPendingKind | null>(
    null,
  );
  const speechPendingRef = useRef<SpeechPendingKind | null>(null);
  const pendingSpeechDeliveryRef = useRef<PendingSpeechDelivery | null>(null);
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
  const [keyboardWaveformActive, setKeyboardWaveformActive] = useState(false);
  const [, setSpeechPreviewRevision] = useState(0);
  const [dismissedSlashQuery, setDismissedSlashQuery] = useState<string | null>(
    null,
  );
  const [selectedSlashIndex, setSelectedSlashIndex] = useState(0);
  const [composerCursor, setComposerCursor] = useState(text.length);
  const [bangCandidates, setBangCandidates] = useState<string[]>([]);
  const [bangHistoryCandidates, setBangHistoryCandidates] = useState<string[]>(
    [],
  );
  const [selectedBangIndex, setSelectedBangIndex] = useState(0);
  const [dismissedBangQueryKey, setDismissedBangQueryKey] = useState<
    string | null
  >(null);
  const bangHistoryIndexRef = useRef(-1);
  const bangRecalledTextRef = useRef<string | null>(null);
  // Composer recall drawer (always-on Ctrl+↑ prior-user-turn recall). Open
  // while non-null; matches are frozen at open time (any editing keystroke
  // closes it), so the draft stays constant while it is shown.
  const [recallDrawer, setRecallDrawer] = useState<{
    matches: ComposerTurnRecallEntry[];
    index: number;
    originalDraft: string;
  } | null>(null);
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
    (!hasExactSlashCommand || matchingSlashArgumentCompletions.length > 0) &&
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
              candidate.start !== invocationQuery.start ||
              candidate.end !== invocationQuery.end,
          )
          .map((candidate) => candidate.token),
      ),
    );
  }, [invocationQuery, matchingSlashCommands.length, slashCommands, text]);
  const bangQuery =
    bangSupport && !collapsed ? getBangCompletionQuery(text) : null;
  const bangQueryKey = bangQuery ? bangCompletionQueryKey(text) : null;
  const showBangChip = !!bangSupport && !collapsed && text.startsWith("!!");
  const showBangEscapedChip =
    !!bangSupport && !collapsed && text.startsWith(" !!");
  // Global history rows first, then PATH/project/path token candidates; the
  // selection index and arrow navigation span this combined list.
  const bangMenuItems: BangMenuItem[] = [
    ...bangHistoryCandidates.map(
      (value): BangMenuItem => ({ source: "history", value }),
    ),
    ...bangCandidates.map(
      (value): BangMenuItem => ({ source: "candidate", value }),
    ),
  ];
  // A lone token candidate equal to the current token is nothing to complete;
  // suppress that (unless history offers whole-line matches).
  const hasUsefulBangCandidates =
    bangCandidates.length > 0 &&
    !(
      bangCandidates.length === 1 &&
      bangQuery !== null &&
      (bangCandidates[0] === bangQuery.token ||
        bangCandidates[0] === `${bangQuery.token}/`)
    );
  const showBangSuggestions =
    !collapsed &&
    !disabled &&
    bangQuery !== null &&
    bangQuery.token.length > 0 &&
    dismissedBangQueryKey !== bangQueryKey &&
    (bangHistoryCandidates.length > 0 || hasUsefulBangCandidates);
  const canSubmit = forkSummaryMode
    ? !forkSummaryMode.submitting &&
      attachments.length === 0 &&
      uploadProgress.length === 0
    : !!(
        hasComposerDraftContent(text, attachments.length) ||
        speechPending !== null ||
        interimTranscript
      );
  const speechInsertionRange = speechInsertionRangeRef.current;
  const interimDisplayTranscript = getSpeechInterimDisplayTranscript(
    text,
    interimTranscript,
    speechInsertionRange,
  );
  // Only mutable provisional speech uses the textarea mirror. Capture and
  // post-capture status live with the mic so the real draft and caret stay
  // untouched while transcription is pending.
  const interimInsertion = speechInsertionRange
    ? getSpeechTranscriptReplacementParts(
        text,
        interimDisplayTranscript,
        speechInsertionRange.end,
        speechInsertionRange.replaceEnd ?? speechInsertionRange.end,
      )
    : getSpeechTranscriptInsertionParts(
        text,
        interimDisplayTranscript,
        text.length,
      );
  const bangFetchRef = useRef(bangSupport?.fetchCompletions);
  bangFetchRef.current = bangSupport?.fetchCompletions;
  const bangFetchKind = bangQuery?.kind ?? null;
  const bangFetchToken = bangQuery?.token ?? null;
  const bangFetchLine = bangQuery ? text.slice(2) : null;
  useEffect(() => {
    const fetchCompletions = bangFetchRef.current;
    if (
      !fetchCompletions ||
      !bangFetchKind ||
      !bangFetchToken ||
      bangFetchLine === null
    ) {
      setBangCandidates([]);
      setBangHistoryCandidates([]);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      fetchCompletions(bangFetchToken, bangFetchKind, bangFetchLine).then(
        (result) => {
          if (!cancelled) {
            setBangCandidates(result.completions);
            setBangHistoryCandidates(result.history);
            setSelectedBangIndex(0);
          }
        },
        () => {
          if (!cancelled) {
            setBangCandidates([]);
            setBangHistoryCandidates([]);
          }
        },
      );
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [bangFetchKind, bangFetchToken, bangFetchLine]);

  // Any edit that diverges from the last Ctrl+↑ recall resets history cycling.
  useEffect(() => {
    if (bangRecalledTextRef.current !== text) {
      bangHistoryIndexRef.current = -1;
      bangRecalledTextRef.current = null;
    }
  }, [text]);

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
  // Per-turn "now" steering toggle. The server-learned client default sets
  // its initial state (Message Delivery settings); the toggle stays per-turn
  // and a user click overrides the default for this composer.
  const steerNowDefault =
    version?.clientDefaults?.steerNowDefault ?? DEFAULT_STEER_NOW_ENABLED;
  // Patient queue intent is a global preference (Message Delivery settings):
  // when on, a queued message waits for verified-idle before delivery instead
  // of promoting at the next end of turn.
  const patientQueueEnabled =
    version?.clientDefaults?.patientQueueDefault ?? false;
  const projectQueueCtrlEnterEnabled =
    version?.clientDefaults?.projectQueueCtrlEnterEnabled ??
    DEFAULT_PROJECT_QUEUE_CTRL_ENTER_ENABLED;
  const projectQueueSupported = serverSupportsProjectQueue(version);
  const projectQueueShortcutAvailable =
    projectQueueCtrlEnterEnabled &&
    projectQueueSupported &&
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
  const primaryActionLabel = forkSummaryMode
    ? forkSummaryMode.submitLabel
    : effectivePrimaryActionKind === "steer"
      ? t("toolbarSteerTooltip")
      : effectivePrimaryActionKind === "queue"
        ? t("toolbarQueueLabel")
        : t("toolbarSend");
  const mobileKeyboardActionLabel = forkSummaryMode
    ? forkSummaryMode.submitLabel
    : effectivePrimaryActionKind === "steer"
      ? t("toolbarShortcutSteerCurrentTurn")
      : effectivePrimaryActionKind === "queue"
        ? t("toolbarQueueLabel")
        : t("toolbarSend");
  const mobileKeyboardActionDisplayLabel =
    hasActiveDualActions && !forkSummaryMode
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
      return {
        projectId,
        sessionId,
        draftKey,
        clientTurnId: ensureSpeechTurnId(),
        speechTargetId: activeSpeechTargetIdRef.current ?? undefined,
      };
    }, [draftKey, ensureSpeechTurnId, projectId, sessionId]);

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

      const pendingFinal = pendingSpeechFinalRef.current;
      if (pendingFinal) {
        clearTimeout(pendingFinal.timer);
        pendingSpeechFinalRef.current = null;
      }
      if (speechInsertionRangesRef.current.size > 0) {
        const nextRanges = new Map<string, SpeechInsertionRange>();
        for (const [targetId, range] of speechInsertionRangesRef.current) {
          nextRanges.set(
            targetId,
            clearSpeechInsertionRangeReplacement(
              mapSpeechInsertionRangeThroughReplacement(
                range,
                replacementStart,
                replacementEnd,
                replacement.length,
              ),
            ),
          );
        }
        speechInsertionRangesRef.current = nextRanges;
        speechInsertionRangeRef.current =
          activeSpeechTargetIdRef.current !== null
            ? (nextRanges.get(activeSpeechTargetIdRef.current) ?? null)
            : null;
      }
      if (
        activeSpeechTargetIdRef.current !== null &&
        hasNonWhitespaceEdit(previousText, nextText)
      ) {
        composerEditedDuringSpeechRef.current = true;
      }
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
      focus: () => textareaRef.current?.focus(),
      setSelectionRange: (start, end) =>
        textareaRef.current?.setSelectionRange(start, end),
      replaceDraftRangeUndoably,
    }),
    [controls, replaceDraftRangeUndoably],
  );

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
    const pending = pendingTextareaSelectionRef.current;
    const textarea = textareaRef.current;
    if (
      !pending ||
      !textarea ||
      text !== pending.value ||
      textarea.value !== pending.value
    ) {
      return;
    }
    pendingTextareaSelectionRef.current = null;
    pending.restore(textarea);
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

  const deferSpeechDelivery = useCallback(
    (intent: PendingSpeechDeliveryIntent) => {
      if (dispatchingSettledSpeechDeliveryRef.current) return false;
      const voice = voiceButtonRef.current;
      if (pendingSpeechDeliveryRef.current) {
        if (voice?.isListening) voice.stopAndFinalize();
        return true;
      }
      const speechWorkPending =
        voice?.isListening === true ||
        speechPendingRef.current !== null ||
        pendingSpeechFinalRef.current !== null;
      if (!speechWorkPending) {
        pendingSpeechDeliveryRef.current = null;
        pendingSpeechDeliverySettledRef.current = false;
        return false;
      }
      // The delivery press owns the current draft and speech target. Detach
      // both from the live composer so speech can settle without consuming
      // text the user starts typing for the next turn. Keep the exact visible
      // click-time projection immutable while late finals update the detached
      // draft only for failure recovery and composition metadata.
      const draft = controls.getDraft();
      pendingSpeechDeliveryRef.current = {
        intent,
        visibleTextSnapshot: getSpeechVisibleDraftText(
          draft,
          interimTranscriptRef.current,
          speechInsertionRangeRef.current,
        ),
        draft,
        composition: {
          typingStartedAt: typingStartedAtRef.current,
          lastEditedAt: lastEditedAtRef.current,
          speechTurnId: speechTurnIdRef.current,
          speechTranscriptionIds: [...speechTranscriptionIdsRef.current],
        },
        speechInsertionRangeRef: {
          current: speechInsertionRangeRef.current,
        },
        activeSpeechTargetIdRef: {
          current: activeSpeechTargetIdRef.current,
        },
        speechInsertionRangesRef: {
          current: new Map(speechInsertionRangesRef.current),
        },
        pendingTextareaSelectionRef: { current: null },
        pendingSpeechRetargetRef: {
          current: pendingSpeechRetargetRef.current,
        },
      };
      pendingSpeechDeliverySettledRef.current = false;
      speechInsertionRangeRef.current = null;
      activeSpeechTargetIdRef.current = null;
      speechInsertionRangesRef.current = new Map();
      pendingSpeechRetargetRef.current = null;
      controls.clearInput();
      resetCompositionMetadata();
      interimTranscriptRef.current = "";
      setInterimTranscript("");
      if (voice?.isListening) voice.stopAndFinalize();
      return true;
    },
    [controls, resetCompositionMetadata],
  );

  const handleForkSummarySubmit = useCallback(
    (
      messageOverride?: unknown,
      focusAfterSubmit = true,
      speechTriggered = false,
      preserveComposer = false,
    ) => {
      if (
        !forkSummaryMode ||
        disabled ||
        attachments.length > 0 ||
        uploadProgress.length > 0
      ) {
        return false;
      }
      const override =
        typeof messageOverride === "string" ? messageOverride : undefined;
      if (
        override === undefined &&
        deferSpeechDelivery({
          kind: "fork-summary",
          focusAfterSubmit,
          speechTriggered,
        })
      ) {
        return true;
      }

      const instructions = (override ?? controls.getDraft()).trim();
      const deliverySpeechPrefix = resolveDeliverySpeechPrefix({
        configuredPrefix: speechMessagePrefix,
        speechTriggered,
        recentSpeech: isRecentSpeechAttribution(),
      });
      if (!preserveComposer) {
        controls.clearInput();
        resetCompositionMetadata();
        setInterimTranscript("");
      }
      forkSummaryMode.onSubmit(
        instructions
          ? prependSpeechMessagePrefix(instructions, deliverySpeechPrefix)
          : instructions,
      );
      consumeSpeechAttribution();
      if (focusAfterSubmit) {
        textareaRef.current?.focus();
      } else {
        textareaRef.current?.blur();
      }
      return true;
    },
    [
      attachments.length,
      consumeSpeechAttribution,
      controls,
      deferSpeechDelivery,
      disabled,
      forkSummaryMode,
      isRecentSpeechAttribution,
      resetCompositionMetadata,
      speechMessagePrefix,
      uploadProgress.length,
    ],
  );

  const handleForkWithoutSummary = useCallback(
    (
      messageOverride?: unknown,
      focusAfterSubmit = true,
      preserveComposer = false,
    ) => {
      if (
        !forkSummaryMode?.onSubmitWithoutSummary ||
        disabled ||
        attachments.length > 0 ||
        uploadProgress.length > 0
      ) {
        return false;
      }
      const override =
        typeof messageOverride === "string" ? messageOverride : undefined;
      if (
        override === undefined &&
        deferSpeechDelivery({ kind: "fork-without-summary", focusAfterSubmit })
      ) {
        return true;
      }

      const finalText = override ?? controls.getDraft();
      const deliverySpeechPrefix = resolveDeliverySpeechPrefix({
        configuredPrefix: speechMessagePrefix,
        speechTriggered: false,
        recentSpeech: isRecentSpeechAttribution(),
      });
      if (!preserveComposer) {
        controls.clearInput();
        resetCompositionMetadata();
        setInterimTranscript("");
      }
      forkSummaryMode.onSubmitWithoutSummary(
        deliverySpeechPrefix
          ? prependSpeechMessagePrefix(finalText, deliverySpeechPrefix)
          : finalText,
      );
      consumeSpeechAttribution();
      if (focusAfterSubmit) {
        textareaRef.current?.focus();
      } else {
        textareaRef.current?.blur();
      }
      return true;
    },
    [
      attachments.length,
      consumeSpeechAttribution,
      controls,
      deferSpeechDelivery,
      disabled,
      forkSummaryMode,
      isRecentSpeechAttribution,
      resetCompositionMetadata,
      speechMessagePrefix,
      uploadProgress.length,
    ],
  );

  const handleSyntheticDoneSubmission = useCallback(
    (
      finalText: string,
      preserveComposer = false,
      focusAfterSubmit = true,
    ): boolean => {
      if (
        !onDone ||
        disabled ||
        finalText.trim() !== "/done" ||
        attachments.length > 0 ||
        uploadProgress.length > 0
      ) {
        return false;
      }
      if (!preserveComposer) {
        controls.clearInput();
        resetCompositionMetadata();
        setInterimTranscript("");
      }
      onDone();
      if (focusAfterSubmit) {
        textareaRef.current?.focus();
      } else {
        textareaRef.current?.blur();
      }
      return true;
    },
    [
      attachments.length,
      controls,
      disabled,
      onDone,
      resetCompositionMetadata,
      uploadProgress.length,
    ],
  );

  const handleSubmit = useCallback(
    async (
      messageOverride?: unknown,
      actionOverride?: "send" | "steer" | "queue",
      focusAfterSubmit = true,
      speechTriggered = false,
      submissionSnapshot?: SubmissionCompositionSnapshot,
      preserveComposer = false,
    ) => {
      const override =
        typeof messageOverride === "string" ? messageOverride : undefined;
      if (
        override === undefined &&
        deferSpeechDelivery({
          kind: "submit",
          actionOverride,
          focusAfterSubmit,
        })
      ) {
        return;
      }

      let finalText = (override ?? controls.getDraft()).trimEnd();
      const deliverySpeechPrefix = resolveDeliverySpeechPrefix({
        configuredPrefix: speechMessagePrefix,
        speechTriggered,
        recentSpeech: isRecentSpeechAttribution(),
      });

      if (forkSummaryMode) return;

      if (
        handleSyntheticDoneSubmission(
          finalText,
          preserveComposer,
          focusAfterSubmit,
        )
      ) {
        return;
      }

      if (bangSupport) {
        const bangDraft = resolveComposerBangDraft(finalText);
        if (
          bangDraft.kind === "empty" &&
          !hasComposerDraftContent(finalText, attachments.length)
        ) {
          return;
        }
        if (bangDraft.kind === "bang" && !disabled) {
          try {
            await bangSupport.onRun(bangDraft.command);
            if (!preserveComposer) {
              controls.clearInput();
              resetCompositionMetadata();
              setInterimTranscript("");
            }
          } catch {
            // The owner surfaces the run failure; retain the draft for retry.
          }
          if (focusAfterSubmit) {
            textareaRef.current?.focus();
          } else {
            textareaRef.current?.blur();
          }
          return;
        }
        if (bangDraft.kind === "escaped") {
          finalText = bangDraft.text;
        }
      }

      const hasContent = hasComposerDraftContent(finalText, attachments.length);
      if (hasContent && !disabled) {
        const message = prependSpeechMessagePrefix(
          finalText,
          deliverySpeechPrefix,
        );
        const actionKind = actionOverride ?? effectivePrimaryActionKind;
        const deliveryIntent =
          actionKind === "steer"
            ? "steer"
            : actionKind === "queue"
              ? "deferred"
              : "direct";
        const metadata = buildSubmissionMetadata(
          deliveryIntent,
          submissionSnapshot,
        );
        // A settled speech delivery owns its detached draft. The live composer
        // may already contain the next turn and must remain untouched.
        if (!preserveComposer) {
          controls.clearInput();
          resetCompositionMetadata();
          setInterimTranscript("");
        }
        onSend(message, metadata);
        consumeSpeechAttribution();
        if (focusAfterSubmit) {
          // Refocus the textarea so user can continue typing.
          textareaRef.current?.focus();
        } else {
          textareaRef.current?.blur();
        }
      }
    },
    [
      disabled,
      controls,
      onSend,
      attachments.length,
      effectivePrimaryActionKind,
      buildSubmissionMetadata,
      resetCompositionMetadata,
      forkSummaryMode,
      handleSyntheticDoneSubmission,
      bangSupport,
      consumeSpeechAttribution,
      deferSpeechDelivery,
      isRecentSpeechAttribution,
      speechMessagePrefix,
    ],
  );

  const handleQueue = useCallback(
    (
      messageOverride?: unknown,
      submissionSnapshot?: SubmissionCompositionSnapshot,
      preserveComposer = false,
      focusAfterSubmit = true,
    ) => {
      const override =
        typeof messageOverride === "string" ? messageOverride : undefined;
      const queueHandler =
        onQueue ??
        (effectivePrimaryActionKind === "queue" ? onSend : undefined);
      if (
        override === undefined &&
        deferSpeechDelivery({ kind: "queue", focusAfterSubmit })
      ) {
        return;
      }

      const finalText = (override ?? controls.getDraft()).trimEnd();

      if (
        handleSyntheticDoneSubmission(
          finalText,
          preserveComposer,
          focusAfterSubmit,
        )
      ) {
        return;
      }

      const hasContent = hasComposerDraftContent(finalText, attachments.length);
      if (hasContent && !disabled && queueHandler) {
        const metadata = buildSubmissionMetadata(
          patientQueueEnabled ? "patient" : "deferred",
          submissionSnapshot,
        );
        if (!preserveComposer) {
          controls.clearInput();
          resetCompositionMetadata();
          setInterimTranscript("");
        }
        const deliverySpeechPrefix = resolveDeliverySpeechPrefix({
          configuredPrefix: speechMessagePrefix,
          speechTriggered: false,
          recentSpeech: isRecentSpeechAttribution(),
        });
        queueHandler(
          prependSpeechMessagePrefix(finalText, deliverySpeechPrefix),
          metadata,
        );
        consumeSpeechAttribution();
        if (focusAfterSubmit) {
          textareaRef.current?.focus();
        } else {
          textareaRef.current?.blur();
        }
      }
    },
    [
      disabled,
      controls,
      onQueue,
      onSend,
      effectivePrimaryActionKind,
      handleSyntheticDoneSubmission,
      patientQueueEnabled,
      attachments.length,
      buildSubmissionMetadata,
      consumeSpeechAttribution,
      deferSpeechDelivery,
      isRecentSpeechAttribution,
      resetCompositionMetadata,
      speechMessagePrefix,
    ],
  );

  const submitToProjectQueue = useCallback(
    (
      submit:
        | ((text: string, metadata?: MessageSubmissionMetadata) => void)
        | undefined,
      messageOverride?: string,
      submissionSnapshot?: SubmissionCompositionSnapshot,
      preserveComposer = false,
      focusAfterSubmit = true,
    ) => {
      if (!submit) return;
      const finalText = (messageOverride ?? controls.getDraft()).trimEnd();

      if (
        handleSyntheticDoneSubmission(
          finalText,
          preserveComposer,
          focusAfterSubmit,
        )
      ) {
        return;
      }

      const hasContent = hasComposerDraftContent(finalText, attachments.length);
      if (hasContent && !disabled) {
        const metadata = buildSubmissionMetadata(
          "deferred",
          submissionSnapshot,
        );
        const deliverySpeechPrefix = resolveDeliverySpeechPrefix({
          configuredPrefix: speechMessagePrefix,
          speechTriggered: false,
          recentSpeech: isRecentSpeechAttribution(),
        });
        if (!preserveComposer) {
          controls.clearInput();
          resetCompositionMetadata();
          setInterimTranscript("");
        }
        submit(
          prependSpeechMessagePrefix(finalText, deliverySpeechPrefix),
          metadata,
        );
        consumeSpeechAttribution();
        if (focusAfterSubmit) {
          textareaRef.current?.focus();
        } else {
          textareaRef.current?.blur();
        }
      }
    },
    [
      attachments.length,
      buildSubmissionMetadata,
      controls,
      consumeSpeechAttribution,
      disabled,
      handleSyntheticDoneSubmission,
      isRecentSpeechAttribution,
      resetCompositionMetadata,
      speechMessagePrefix,
    ],
  );

  const handleProjectQueue = useCallback(
    (focusAfterSubmit = true) => {
      if (
        deferSpeechDelivery({
          kind: "project-queue",
          newSession: false,
          focusAfterSubmit,
        })
      ) {
        return;
      }
      submitToProjectQueue(
        onProjectQueue,
        undefined,
        undefined,
        false,
        focusAfterSubmit,
      );
    },
    [deferSpeechDelivery, onProjectQueue, submitToProjectQueue],
  );

  const handleProjectQueueNewSession = useCallback(
    (focusAfterSubmit = true) => {
      if (
        deferSpeechDelivery({
          kind: "project-queue",
          newSession: true,
          focusAfterSubmit,
        })
      ) {
        return;
      }
      submitToProjectQueue(
        onProjectQueueNewSession,
        undefined,
        undefined,
        false,
        focusAfterSubmit,
      );
    },
    [deferSpeechDelivery, onProjectQueueNewSession, submitToProjectQueue],
  );

  const restorePendingSpeechDeliveryDraft = useCallback(() => {
    const pending = pendingSpeechDeliveryRef.current;
    if (!pending) return false;
    pendingSpeechDeliveryRef.current = null;
    pendingSpeechDeliverySettledRef.current = false;
    const pendingDraft = pending.draft;
    const liveDraft = controls.getDraft();
    if (pendingDraft) {
      controls.setDraft(
        liveDraft ? `${pendingDraft}\n\n${liveDraft}` : pendingDraft,
      );
    }
    return true;
  }, [controls]);

  const runPendingSpeechDelivery = useCallback(() => {
    if (
      speechPendingRef.current !== null ||
      pendingSpeechFinalRef.current !== null
    ) {
      return;
    }
    if (!pendingSpeechDeliverySettledRef.current) return;
    const pending = pendingSpeechDeliveryRef.current;
    if (!pending) return;
    const typedForkPending =
      pending.intent.kind === "fork-summary" ||
      pending.intent.kind === "fork-without-summary";
    const clearPendingOwner = () => {
      pendingSpeechDeliveryRef.current = null;
      pendingSpeechDeliverySettledRef.current = false;
    };
    if (!typedForkPending) clearPendingOwner();
    dispatchingSettledSpeechDeliveryRef.current = true;
    try {
      if (pending.intent.kind === "queue") {
        handleQueue(
          pending.visibleTextSnapshot,
          pending.composition,
          true,
          pending.intent.focusAfterSubmit,
        );
        return;
      }
      if (pending.intent.kind === "project-queue") {
        submitToProjectQueue(
          pending.intent.newSession ? onProjectQueueNewSession : onProjectQueue,
          pending.visibleTextSnapshot,
          pending.composition,
          true,
          pending.intent.focusAfterSubmit,
        );
        return;
      }
      if (pending.intent.kind === "fork-summary") {
        const accepted = handleForkSummarySubmit(
          pending.visibleTextSnapshot,
          pending.intent.focusAfterSubmit,
          pending.intent.speechTriggered,
          true,
        );
        if (accepted) clearPendingOwner();
        else restorePendingSpeechDeliveryDraft();
        return;
      }
      if (pending.intent.kind === "fork-without-summary") {
        const accepted = handleForkWithoutSummary(
          pending.visibleTextSnapshot,
          pending.intent.focusAfterSubmit,
          true,
        );
        if (accepted) clearPendingOwner();
        else restorePendingSpeechDeliveryDraft();
        return;
      }
      void handleSubmit(
        pending.visibleTextSnapshot,
        pending.intent.actionOverride,
        pending.intent.focusAfterSubmit,
        false,
        pending.composition,
        true,
      );
    } catch (error) {
      if (typedForkPending) restorePendingSpeechDeliveryDraft();
      throw error;
    } finally {
      dispatchingSettledSpeechDeliveryRef.current = false;
    }
  }, [
    handleForkSummarySubmit,
    handleForkWithoutSummary,
    handleQueue,
    handleSubmit,
    onProjectQueue,
    onProjectQueueNewSession,
    restorePendingSpeechDeliveryDraft,
    submitToProjectQueue,
  ]);
  runPendingSpeechDeliveryRef.current = runPendingSpeechDelivery;

  const maybeRunPendingSpeechDelivery = useCallback(() => {
    runPendingSpeechDeliveryRef.current();
  }, []);

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

  const submitPrimaryAction = forkSummaryMode
    ? handleForkSummarySubmit
    : effectivePrimaryActionKind === "queue"
      ? handleQueue
      : handleSubmit;
  const runComposerPointerDelivery = useCallback(
    (deliver: (focusAfterSubmit: boolean) => void) => {
      if (!hasCoarsePointer()) {
        deliver(true);
        return;
      }
      if (mobilePointerDeliveryPendingRef.current) return;

      mobilePointerDeliveryPendingRef.current = true;
      const refocus = keepMobileKeyboardOpenAfterDelivery;
      // A controlled clear does not retire Android's composing region. Blur
      // and replace the editing host so late Gboard events stay attached to
      // the old DOM node instead of becoming the next persisted draft.
      textareaRef.current?.blur();
      setTextareaImeGeneration((generation) => generation + 1);

      const finishBoundary = () => {
        mobilePointerDeliveryPendingRef.current = false;
        if (!refocus) return;
        const textarea = textareaRef.current;
        if (textarea && !textarea.disabled) textarea.focus();
      };
      try {
        deliver(false);
      } finally {
        // React commits discrete-event updates before the next frame, so an
        // opt-in refocus targets only the replacement editing host.
        if (typeof window.requestAnimationFrame === "function") {
          window.requestAnimationFrame(finishBoundary);
        } else {
          window.setTimeout(finishBoundary, 0);
        }
      }
    },
    [keepMobileKeyboardOpenAfterDelivery],
  );
  const handlePrimaryPointerDelivery = useCallback(() => {
    runComposerPointerDelivery((focusAfterSubmit) => {
      if (forkSummaryMode) {
        handleForkSummarySubmit(undefined, focusAfterSubmit);
      } else if (effectivePrimaryActionKind === "queue") {
        handleQueue(undefined, undefined, false, focusAfterSubmit);
      } else {
        void handleSubmit(undefined, undefined, focusAfterSubmit);
      }
    });
  }, [
    effectivePrimaryActionKind,
    forkSummaryMode,
    handleForkSummarySubmit,
    handleQueue,
    handleSubmit,
    runComposerPointerDelivery,
  ]);
  const handleQueuePointerDelivery = useCallback(() => {
    runComposerPointerDelivery((focusAfterSubmit) => {
      handleQueue(undefined, undefined, false, focusAfterSubmit);
    });
  }, [handleQueue, runComposerPointerDelivery]);
  const handleSteerPointerDelivery = useCallback(() => {
    runComposerPointerDelivery((focusAfterSubmit) => {
      void handleSubmit(undefined, "steer", focusAfterSubmit);
    });
  }, [handleSubmit, runComposerPointerDelivery]);
  const handleProjectQueuePointerDelivery = useCallback(() => {
    runComposerPointerDelivery(handleProjectQueue);
  }, [handleProjectQueue, runComposerPointerDelivery]);
  const handleProjectQueueNewSessionPointerDelivery = useCallback(() => {
    runComposerPointerDelivery(handleProjectQueueNewSession);
  }, [handleProjectQueueNewSession, runComposerPointerDelivery]);
  const handleForkWithoutSummaryPointerDelivery = useCallback(() => {
    runComposerPointerDelivery((focusAfterSubmit) => {
      handleForkWithoutSummary(undefined, focusAfterSubmit);
    });
  }, [handleForkWithoutSummary, runComposerPointerDelivery]);
  const visibleDeliveryDraft = getSpeechVisibleDraftText(
    controls.getDraft(),
    interimTranscript,
    speechInsertionRangeRef.current,
  );
  const primaryRunsLocalBang =
    !!bangSupport &&
    resolveComposerBangDraft(visibleDeliveryDraft).kind === "bang";
  const manualDeliverySpeechPrefix =
    speechMessagePrefix &&
    asrAttributionMs > 0 &&
    (speechAttributionActive ||
      ((speechPending !== null || pendingSpeechDeliveryRef.current !== null) &&
        (speechTransactionHasTextRef.current ||
          interimTranscript.trim().length > 0)))
      ? speechMessagePrefix
      : null;
  const primaryDeliverySpeechPrefix = primaryRunsLocalBang
    ? null
    : manualDeliverySpeechPrefix;
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
    !forkSummaryMode &&
    projectQueueSupported &&
    toolbarVisibility.projectQueue &&
    !!onProjectQueue;
  const showMobileProjectQueueNewSessionAction =
    !forkSummaryMode &&
    projectQueueSupported &&
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
    (command: SlashCommand) => {
      const canonicalToken = getCanonicalInvocationToken(command);
      if (
        command.invocation?.kind === "emulated" &&
        onCustomCommand?.(command.name)
      ) {
        return;
      }

      const activeQuery = getInvocationCompletionQuery(text, composerCursor);
      let editStart: number;
      let editEnd: number;
      let nextText: string;
      let nextCursor: number;
      if (activeQuery) {
        const suffix = /\s/.test(text[activeQuery.end] ?? "") ? "" : " ";
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

  // Open the recall drawer over the prior user turns that prefix-match the
  // current draft (empty draft → all). No-op with nothing to show. Shared by
  // Ctrl+↑ and the mobile open button. Returns whether it opened.
  const openRecallDrawer = (): boolean => {
    if (
      hasNonTextComposerContent ||
      !turnRecall ||
      turnRecall.entries.length === 0
    ) {
      return false;
    }
    const matches = filterComposerTurnRecall(turnRecall.entries, text);
    if (matches.length === 0) {
      return false;
    }
    setRecallDrawer({ matches, index: 0, originalDraft: text });
    return true;
  };
  // Cancel the recall drawer, restoring the pre-open draft (Esc / click-away).
  const cancelRecallDrawer = () => {
    if (recallDrawer) {
      setText(recallDrawer.originalDraft);
      setRecallDrawer(null);
    }
  };
  // Accept a recall entry: draft its full text and close the drawer.
  const acceptRecallEntry = (entry: ComposerTurnRecallEntry) => {
    noteComposerEdit(entry.text);
    setText(entry.text);
    setRecallDrawer(null);
    textareaRef.current?.focus();
  };
  // Go to a recalled turn: scroll the transcript to it and close the drawer.
  // Navigation, not recall — the composer text is left untouched and the Esc
  // draft-restore is deliberately skipped (nothing was drafted to restore).
  const goToRecallTurn = (entry: ComposerTurnRecallEntry) => {
    turnRecall?.onGoToTurn?.(entry.id);
    setRecallDrawer(null);
  };

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
        if (forkSummaryMode) {
          handleForkSummarySubmit();
        } else {
          void handleSubmit(undefined, "send");
        }
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
    if (recallDrawer) {
      if (
        (e.key === "ArrowUp" || e.key === "ArrowDown") &&
        !e.metaKey &&
        !e.altKey
      ) {
        e.preventDefault();
        const delta = e.key === "ArrowDown" ? 1 : -1;
        setRecallDrawer((current) =>
          current
            ? {
                ...current,
                index:
                  (current.index + delta + current.matches.length) %
                  current.matches.length,
              }
            : current,
        );
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
        const entry = recallDrawer.matches[recallDrawer.index];
        if (entry) {
          acceptRecallEntry(entry);
        } else {
          setRecallDrawer(null);
        }
        return;
      }
      if (
        e.key === "Escape" &&
        !e.ctrlKey &&
        !e.metaKey &&
        !e.shiftKey &&
        !e.altKey
      ) {
        e.preventDefault();
        cancelRecallDrawer();
        return;
      }
      // Any other key dismisses the drawer and types normally (no
      // preventDefault, falls through to the composer).
      setRecallDrawer(null);
    }

    // Ctrl+↑ opens the recall drawer over prior user turns prefix-matched by
    // the current draft. Only reached when no bang shell-recall claimed it.
    if (
      e.key === "ArrowUp" &&
      e.ctrlKey &&
      !e.metaKey &&
      !e.shiftKey &&
      !e.altKey &&
      !recallDrawer
    ) {
      if (openRecallDrawer()) {
        e.preventDefault();
        return;
      }
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
        e.key === "Tab" ||
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

    // Escape cancels a pending post-capture wait — dropping the uncommitted
    // result while keeping any already-committed text. Active listening still
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
      isRunning &&
      isThinking &&
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
      if (recallLastSubmission()) {
        e.preventDefault();
      }
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
      recallLastSubmission(true);
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
        handleForkWithoutSummary();
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
        handleProjectQueue();
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
          handleSubmit(undefined, "steer");
        } else {
          handleQueue();
        }
        return;
      }

      // On mobile (touch devices), Enter adds newline - must use send button
      // On desktop, Enter sends message, Shift/Ctrl+Enter adds newline
      const isMobile = hasCoarsePointer();

      // If voice recording is active, Enter submits (on any device)
      if (voiceButtonRef.current?.isListening) {
        e.preventDefault();
        submitPrimaryAction();
        return;
      }

      if (isMobile) {
        // Mobile: Enter always adds newline, send button required
        // Allow default behavior (newline)
        return;
      }

      if (ENTER_SENDS_MESSAGE) {
        // Desktop: Enter sends, Ctrl+Enter adds newline
        if (e.ctrlKey || e.shiftKey) {
          // Allow default behavior (newline)
          return;
        }
        e.preventDefault();
        submitPrimaryAction();
      } else {
        // Ctrl+Enter sends, Enter adds newline
        if (e.ctrlKey || e.shiftKey) {
          e.preventDefault();
          submitPrimaryAction();
        }
      }
    }
  };

  const handlePaste = (e: ClipboardEvent) => {
    if (!canAttach || !onAttach) return;

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
      // Prevent default only if we have files to handle
      // This allows text paste to still work normally
      e.preventDefault();
      onAttach(files);
    }
  };

  // Voice input handlers
  const handleListeningStart = useCallback(() => {
    speechTransactionHasTextRef.current = false;
    const textarea = textareaRef.current;
    const currentText = controls.getDraft();
    const selectionStart = Math.max(
      0,
      Math.min(
        textarea?.selectionStart ?? currentText.length,
        currentText.length,
      ),
    );
    const selectionEnd = Math.max(
      selectionStart,
      Math.min(textarea?.selectionEnd ?? selectionStart, currentText.length),
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
  }, [controls]);

  const clearPendingSpeechFinal = useCallback(() => {
    const pending = pendingSpeechFinalRef.current;
    if (pending === null) return;
    clearTimeout(pending.timer);
    pendingSpeechFinalRef.current = null;
  }, []);

  useEffect(() => clearPendingSpeechFinal, [clearPendingSpeechFinal]);

  const handleSpeechSelectionTarget = useCallback(
    (manualInteraction = false, draftAtSelection?: string) => {
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
          draft: draftAtSelection ?? controls.getDraft(),
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
    [clearPendingSpeechFinal, controls],
  );

  const handleTextareaSelectionTarget = useCallback(() => {
    handleSpeechSelectionTarget(true);
    setComposerCursor(textareaRef.current?.selectionStart ?? text.length);
    revealCollapsedTextareaCursor();
  }, [handleSpeechSelectionTarget, revealCollapsedTextareaCursor, text.length]);

  const handleTextareaClickTarget = useCallback(() => {
    window.setTimeout(handleTextareaSelectionTarget, 0);
  }, [handleTextareaSelectionTarget]);

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

  const handleSmartTurnSend = useCallback(
    (text: string) => {
      if (forkSummaryMode) {
        if (!handleForkSummarySubmit(text, !hasCoarsePointer(), true)) {
          return false;
        }
      } else {
        if (!hasComposerDraftContent(text, attachments.length) || disabled)
          return false;
        void handleSubmit(text, undefined, !hasCoarsePointer(), true);
      }
      voiceButtonRef.current?.continueAfterSpeechSend();
      return true;
    },
    [
      attachments.length,
      disabled,
      forkSummaryMode,
      handleForkSummarySubmit,
      handleSubmit,
    ],
  );

  const commitVoiceTranscript = useCallback(
    (transcript: string, metadata?: SpeechTranscriptionResultMetadata) => {
      if (transcript.trim() && metadata?.smartTurnCommand !== "cancel") {
        speechTransactionHasTextRef.current = true;
        noteSpeechAttribution();
      }
      pendingSpeechDeliverySettledRef.current = true;
      const pendingDelivery = pendingSpeechDeliveryRef.current;
      const pendingTargetId = metadata?.speechTargetId;
      const commitsPendingDelivery =
        pendingDelivery !== null &&
        (pendingTargetId
          ? pendingDelivery.speechInsertionRangesRef.current.has(
              pendingTargetId,
            )
          : pendingDelivery.activeSpeechTargetIdRef.current !== null);
      const targetInsertionRangeRef = commitsPendingDelivery
        ? pendingDelivery.speechInsertionRangeRef
        : speechInsertionRangeRef;
      const targetActiveSpeechTargetIdRef = commitsPendingDelivery
        ? pendingDelivery.activeSpeechTargetIdRef
        : activeSpeechTargetIdRef;
      const targetInsertionRangesRef = commitsPendingDelivery
        ? pendingDelivery.speechInsertionRangesRef
        : speechInsertionRangesRef;
      const targetPendingSelectionRef = commitsPendingDelivery
        ? pendingDelivery.pendingTextareaSelectionRef
        : pendingTextareaSelectionRef;
      const targetPendingSpeechRetargetRef = commitsPendingDelivery
        ? pendingDelivery.pendingSpeechRetargetRef
        : pendingSpeechRetargetRef;
      const outcome = commitSpeechTranscript(
        {
          textareaRef: commitsPendingDelivery ? { current: null } : textareaRef,
          getDraft: commitsPendingDelivery
            ? () => pendingDelivery.draft
            : controls.getDraft,
          setDraft: commitsPendingDelivery
            ? (next) => {
                pendingDelivery.draft = next;
              }
            : controls.setDraft,
          setInterimTranscript: (next) => {
            if (commitsPendingDelivery) return;
            interimTranscriptRef.current = next;
            setInterimTranscript(next);
          },
          speechInsertionRangeRef: targetInsertionRangeRef,
          activeSpeechTargetIdRef: targetActiveSpeechTargetIdRef,
          speechInsertionRangesRef: targetInsertionRangesRef,
          pendingTextareaSelectionRef: targetPendingSelectionRef,
          pendingSpeechRetargetRef: targetPendingSpeechRetargetRef,
          onInsertionBoundary: commitsPendingDelivery
            ? () => {}
            : () => voiceButtonRef.current?.beginInsertionBoundary(),
          onSpeechTargetChanged: commitsPendingDelivery
            ? () => {}
            : () => setSpeechPreviewRevision((revision) => revision + 1),
          onEdit: commitsPendingDelivery ? undefined : noteComposerEdit,
          onTranscriptionId: (id) => {
            if (commitsPendingDelivery) {
              pendingDelivery.composition.speechTranscriptionIds = [
                ...pendingDelivery.composition.speechTranscriptionIds,
                id,
              ];
            } else {
              speechTranscriptionIdsRef.current = [
                ...speechTranscriptionIdsRef.current,
                id,
              ];
            }
          },
          onSmartTurnSend: commitsPendingDelivery
            ? undefined
            : handleSmartTurnSend,
          composerEditedDuringSpeech: commitsPendingDelivery
            ? undefined
            : () => composerEditedDuringSpeechRef.current,
        },
        transcript,
        metadata,
      );
      maybeRunPendingSpeechDelivery();
      // An overlapping (non-active) target's batch result has now landed;
      // forget its range. The active target is forgotten on the pending->null
      // transition instead (it may still get more streaming finals).
      const committedTargetId = metadata?.speechTargetId;
      if (
        committedTargetId &&
        committedTargetId !== targetActiveSpeechTargetIdRef.current &&
        targetInsertionRangesRef.current.delete(committedTargetId)
      ) {
        setSpeechPreviewRevision((revision) => revision + 1);
      }
      return outcome;
    },
    [
      controls,
      handleSmartTurnSend,
      maybeRunPendingSpeechDelivery,
      noteComposerEdit,
      noteSpeechAttribution,
    ],
  );
  const handleVoiceTranscript = useCallback(
    (transcript: string, metadata?: SpeechTranscriptionResultMetadata) => {
      const pendingDelivery = pendingSpeechDeliveryRef.current;
      const pendingRange = metadata?.speechTargetId
        ? (pendingDelivery?.speechInsertionRangesRef.current.get(
            metadata.speechTargetId,
          ) ?? null)
        : (pendingDelivery?.speechInsertionRangeRef.current ?? null);
      const speechRange =
        pendingRange ??
        (metadata?.speechTargetId
          ? (speechInsertionRangesRef.current.get(metadata.speechTargetId) ??
            null)
          : speechInsertionRangeRef.current);
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
      controls.getDraft(),
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
  }, [commitVoiceTranscript, controls, flushPendingSpeechFinal]);

  const handleInterimTranscript = useCallback((transcript: string) => {
    interimTranscriptRef.current = transcript;
    setInterimTranscript(transcript);
  }, []);

  const handlePendingSpeechChange = useCallback(
    (kind: SpeechPendingKind | null, settlement?: SpeechCycleSettlement) => {
      if (settlement === "failed") {
        restorePendingSpeechDeliveryDraft();
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
        // The active recording finished (its result has already committed);
        // forget its insertion target so the range map does not accumulate
        // completed targets.
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
      restorePendingSpeechDeliveryDraft,
    ],
  );

  const handleTranscriptionSettled = useCallback(
    (settlement: SpeechTranscriptionSettlement) => {
      const targetId = settlement.speechTargetId;
      if (!targetId || settlement.status === "completed") return;

      const pendingTargetFailed =
        pendingSpeechDeliveryRef.current?.speechInsertionRangesRef.current.has(
          targetId,
        ) === true;
      if (pendingTargetFailed) {
        restorePendingSpeechDeliveryDraft();
        setSpeechPending(null);
        speechPendingRef.current = null;
        setInterimTranscript("");
      }
      const removed = speechInsertionRangesRef.current.delete(targetId);
      const activeTargetFailed = targetId === activeSpeechTargetIdRef.current;
      if (activeTargetFailed) {
        clearPendingSpeechFinal();
        speechInsertionRangeRef.current = null;
        activeSpeechTargetIdRef.current = null;
        pendingSpeechRetargetRef.current = null;
        setSpeechPending(null);
        speechPendingRef.current = null;
        setInterimTranscript("");
        pendingSpeechDeliveryRef.current = null;
        pendingSpeechDeliverySettledRef.current = false;
      }
      if (removed) {
        setSpeechPreviewRevision((revision) => revision + 1);
      }
    },
    [clearPendingSpeechFinal, restorePendingSpeechDeliveryDraft],
  );

  // Cancel a pending transcription/finalization. The provider discards the
  // in-flight result (keeping any committed text); here we drop the pending
  // speech target so the composer forgets the reserved insertion point.
  const handleCancelTranscription = useCallback(() => {
    voiceButtonRef.current?.cancelProcessing();
    restorePendingSpeechDeliveryDraft();
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
  }, [clearPendingSpeechFinal, restorePendingSpeechDeliveryDraft]);

  const handleComposerKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (!isVoiceInputShortcut(event)) return;
      event.preventDefault();
      event.stopPropagation();
      const voice = voiceButtonRef.current;
      if (!voice?.isAvailable) return;
      voice.toggle();
    },
    [],
  );

  const toolbarProps: MessageInputToolbarProps = {
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
    heartbeatEnabled,
    onToggleHeartbeat,
    onConfigureHeartbeat,
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
    onQueue: onQueue ? handleQueuePointerDelivery : undefined,
    onProjectQueue:
      onProjectQueue && !forkSummaryMode
        ? handleProjectQueuePointerDelivery
        : undefined,
    onProjectQueueNewSession:
      onProjectQueueNewSession && !forkSummaryMode
        ? handleProjectQueueNewSessionPointerDelivery
        : undefined,
    onSteer: hasActiveDualActions ? handleSteerPointerDelivery : undefined,
    primaryActionKind: effectivePrimaryActionKind,
    sendOverride: forkSummaryMode
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
    primarySpeechMessagePrefix: primaryDeliverySpeechPrefix,
    disabled,
  };
  const showMobileKeyboardCompact = mobileKeyboardOpen && canSubmit;

  return (
    <div
      className={`message-input-wrapper${fullPane ? ` ${styles.fullPane}` : ""}`}
      data-composer-full-pane={fullPane ? "true" : undefined}
      onKeyDownCapture={handleComposerKeyDown}
    >
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
          className="message-input-toggle"
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
            className={userCollapsed ? "chevron-up" : "chevron-down"}
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
        className={`message-input ${collapsed ? "message-input-collapsed" : ""} ${
          collapsed &&
          (showCollapsedLineCount || showCollapsedDesktopMicrophone)
            ? "has-collapsed-side-actions"
            : ""
        }${
          showCollapsedMicrophone
            ? ` ${styles.collapsedWithLeadingMicrophone}`
            : ""
        }${
          showCollapsedMicrophone && !showCollapsedSendAction
            ? ` ${styles.collapsedWithLeadingMicrophoneOnly}`
            : ""
        }`}
        data-composer-shell="true"
        data-collapsed-leading-microphone={showCollapsedMicrophone || undefined}
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
              key={textareaImeGeneration}
              ref={textareaRef}
              data-composer-input
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
                const nextText = e.target.value;
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
                          text,
                          nextText,
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
                  hasNonWhitespaceEdit(text, nextText)
                ) {
                  composerEditedDuringSpeechRef.current = true;
                }
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
                cancelRecallDrawer();
                controls.flushDraft();
                setTextareaFocused(false);
              }}
              onFocus={() => {
                keyboardViewportBaselineRef.current =
                  getComposerViewportHeight();
                setTextareaFocused(true);
                revealCollapsedTextareaCursor();
              }}
              onKeyDown={handleKeyDown}
              onSelect={handleTextareaSelectionTarget}
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

        {(showBangChip || showBangEscapedChip) && (
          <div
            className={`bang-composer-chip${
              showBangEscapedChip ? " bang-composer-chip-escaped" : ""
            }`}
            role="status"
          >
            {showBangEscapedChip
              ? t("bangComposerEscapedChip")
              : t("bangComposerChip")}
          </div>
        )}

        {recognizedSkillTokens.length > 0 && (
          <div className="skill-invocation-status" role="status">
            <span>{t("skillInvocationRecognized")}</span>
            <code>{recognizedSkillTokens.join(", ")}</code>
          </div>
        )}

        {unrecognizedSkillTokens.length > 0 && (
          <div
            className="skill-invocation-status skill-invocation-status--warning"
            role="status"
          >
            <span>{t("skillInvocationUnrecognized")}</span>
            <code>{unrecognizedSkillTokens.join(", ")}</code>
            <span>{t("skillInvocationStillSent")}</span>
          </div>
        )}

        {showBangSuggestions && (
          <div
            className="slash-command-menu composer-slash-command-menu bang-completion-menu"
            role="menu"
          >
            {bangMenuItems.map((item, index) => (
              <button
                key={`${item.source}:${item.value}`}
                type="button"
                className={`slash-command-item${
                  item.source === "history" ? " bang-history-item" : ""
                }${index === selectedBangIndex ? " active" : ""}`}
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
            className="slash-command-menu composer-slash-command-menu"
            role="menu"
          >
            {matchingSlashCommands.map((command, index) => {
              const parts = getSlashCommandMenuParts(command);
              return (
                <button
                  key={`${getCanonicalInvocationToken(command)}:${command.invocation?.kind ?? "legacy"}`}
                  type="button"
                  className={`slash-command-item${index === selectedSlashIndex ? " active" : ""}`}
                  onMouseEnter={() => setSelectedSlashIndex(index)}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => handleSlashCommand(command)}
                  role="menuitem"
                  aria-label={parts.label}
                >
                  <span className="slash-command-copy">
                    {/* shortcut + rest is one command word split for
                        highlighting; keep it a single inline run so no flex
                        gap lands inside the word. */}
                    <span>
                      {parts.shortcut && (
                        <strong className="slash-command-shortcut">
                          {parts.shortcut}
                        </strong>
                      )}
                      {parts.rest}
                    </span>
                    {(command.description || command.argumentHint) && (
                      <span className="slash-command-detail">
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
                  className={`slash-command-item${index === selectedSlashIndex ? " active" : ""}`}
                  onMouseEnter={() => setSelectedSlashIndex(index)}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => handleSlashArgumentCompletion(match)}
                  role="menuitem"
                  aria-label={label}
                >
                  <span className="slash-command-copy">
                    <span>{label}</span>
                    {match.completion.description && (
                      <span className="slash-command-detail">
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
          <div
            className="slash-command-menu composer-slash-command-menu composer-recall-menu"
            role="menu"
            aria-label={t("composerRecallMenuLabel")}
          >
            {recallDrawer.matches.map((entry, index) => (
              <div key={`${index}-${entry.id}`} className="composer-recall-row">
                <button
                  type="button"
                  className={`slash-command-item composer-recall-preview${
                    index === recallDrawer.index ? " active" : ""
                  }`}
                  onMouseEnter={() =>
                    setRecallDrawer((current) =>
                      current ? { ...current, index } : current,
                    )
                  }
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => acceptRecallEntry(entry)}
                  role="menuitem"
                >
                  <span>{entry.preview}</span>
                </button>
                {turnRecall?.onGoToTurn && (
                  // Navigation-only secondary control: scroll the transcript to
                  // this turn and close the drawer (no composer/draft change).
                  <button
                    type="button"
                    className="composer-recall-goto"
                    onMouseEnter={() =>
                      setRecallDrawer((current) =>
                        current ? { ...current, index } : current,
                      )
                    }
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => goToRecallTurn(entry)}
                    aria-label={t("composerRecallGoToTurn")}
                    title={t("composerRecallGoToTurn")}
                  >
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      <circle cx="12" cy="12" r="3" />
                      <line x1="12" y1="2" x2="12" y2="5" />
                      <line x1="12" y1="19" x2="12" y2="22" />
                      <line x1="2" y1="12" x2="5" y2="12" />
                      <line x1="19" y1="12" x2="22" y2="12" />
                    </svg>
                  </button>
                )}
              </div>
            ))}
          </div>
        )}

        {collapsed &&
          (showCollapsedLineCount || showCollapsedDesktopMicrophone) && (
            <div className="message-input-collapsed-side-actions">
              {showCollapsedLineCount && (
                <span
                  className="message-input-collapsed-line-count"
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
                  ref={voiceButtonRef}
                  onTranscript={handleVoiceTranscript}
                  onInterimTranscript={handleInterimTranscript}
                  onListeningStart={handleListeningStart}
                  onListeningStop={handleListeningStop}
                  onPendingSpeechChange={handlePendingSpeechChange}
                  onTranscriptionSettled={handleTranscriptionSettled}
                  disabled={disabled}
                  getTranscriptionContext={getTranscriptionContext}
                  className="message-input-collapsed-mic"
                />
              )}
            </div>
          )}

        {collapsed && (
          <div
            className={`message-input-collapsed-actions${
              showCollapsedMicrophone
                ? ` ${styles.collapsedActionsWithMicrophone}`
                : ""
            }`}
          >
            {showCollapsedMicrophone && (
              <VoiceInputButton
                ref={voiceButtonRef}
                onTranscript={handleVoiceTranscript}
                onInterimTranscript={handleInterimTranscript}
                onListeningStart={handleListeningStart}
                onListeningStop={handleListeningStop}
                onPendingSpeechChange={handlePendingSpeechChange}
                onTranscriptionSettled={handleTranscriptionSettled}
                disabled={disabled}
                getTranscriptionContext={getTranscriptionContext}
                className="message-input-collapsed-mic"
              />
            )}
            {showCollapsedSendAction && (
              <button
                type="button"
                onClick={collapsedSubmitAction}
                disabled={disabled || !canSubmit}
                className={`send-button message-input-collapsed-send`}
                aria-label={collapsedActionLabel}
                title={collapsedActionLabel}
              >
                <DeliveryGlyph className="send-icon">
                  {collapsedActionIcon}
                </DeliveryGlyph>
              </button>
            )}
          </div>
        )}

        {!collapsed && correctionActive && (
          <div className="correction-draft">
            <span className="correction-draft-label">
              {t("sessionCorrectionActive")}
            </span>
            <button
              type="button"
              className="correction-draft-cancel"
              onClick={onCancelCorrection}
              aria-label={t("sessionCorrectionCancel")}
              title={t("sessionCorrectionCancel")}
            >
              ×
            </button>
          </div>
        )}

        {!collapsed && forkSummaryMode && (
          <div className="fork-summary-draft">
            <div className="fork-summary-draft-copy">
              <span className="fork-summary-draft-label">
                {forkSummaryMode.title}
              </span>
              <span className="fork-summary-draft-description">
                {forkSummaryMode.description}
              </span>
            </div>
            <button
              type="button"
              className="fork-summary-draft-cancel"
              onClick={forkSummaryMode.onCancel}
              aria-label={t("forkSummaryCancel")}
              title={t("forkSummaryCancel")}
            >
              ×
            </button>
          </div>
        )}

        {/* Attachment chips - show below textarea when not collapsed */}
        {!collapsed &&
          (attachments.length > 0 || uploadProgress.length > 0) && (
            <div className="attachment-list">
              {attachments.map((file) => (
                <AttachmentChip
                  key={file.id}
                  attachmentId={file.id}
                  originalName={file.originalName}
                  path={file.path}
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
              ))}
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
          <div className="prompt-suggestion">
            <button
              type="button"
              className="prompt-suggestion-text"
              onClick={() => {
                const metadata = buildSubmissionMetadata("direct");
                onDismissPromptSuggestion?.();
                onSend(promptSuggestion, metadata);
                textareaRef.current?.focus();
              }}
              title="Send this suggestion"
            >
              {promptSuggestion}
            </button>
            <button
              type="button"
              className="prompt-suggestion-dismiss"
              onClick={onDismissPromptSuggestion}
              aria-label="Dismiss suggestion"
              title="Dismiss"
            >
              ×
            </button>
          </div>
        )}

        {!collapsed && showMobileKeyboardCompact && (
          <div className="message-input-keyboard-compact">
            {mobileKeyboardMoreOpen && (
              <div
                id="message-input-keyboard-more-controls"
                className="message-input-keyboard-more-panel"
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
              className={`message-input-keyboard-actions${forkSummaryMode?.onSubmitWithoutSummary ? " has-alternate" : ""}`}
            >
              <button
                type="button"
                className={`message-input-keyboard-more${mobileKeyboardMoreOpen ? " is-open" : ""}`}
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
                  className={`message-input-keyboard-secondary-slot ${styles.keyboardSpeechSlot}${
                    toolbarVisibility.waveform
                      ? ` ${styles.keyboardSpeechSlotWithWaveform}`
                      : ""
                  }`}
                  data-waveform-reserved={
                    toolbarVisibility.waveform || undefined
                  }
                  data-waveform-active={keyboardWaveformActive || undefined}
                  onPointerDown={(event) => event.preventDefault()}
                >
                  <VoiceInputButton
                    ref={voiceButtonRef}
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
                    className="message-input-keyboard-action message-input-keyboard-secondary"
                  />
                </div>
              )}
              {showMobileProjectQueueAction && (
                <div className="message-input-keyboard-secondary-slot message-input-keyboard-project-queue-slot">
                  <button
                    type="button"
                    className="message-input-keyboard-action message-input-keyboard-secondary project-queue-mode"
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
                </div>
              )}
              {showMobileProjectQueueNewSessionAction && (
                <div className="message-input-keyboard-secondary-slot message-input-keyboard-project-queue-new-session-slot">
                  <button
                    type="button"
                    className="message-input-keyboard-action message-input-keyboard-secondary project-queue-mode project-queue-new-session-button"
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
                    <span
                      className="project-queue-new-session-mark"
                      aria-hidden="true"
                    >
                      +
                    </span>
                    {manualDeliverySpeechPrefix && (
                      <SpeechPrefixActionCue
                        prefix={manualDeliverySpeechPrefix}
                      />
                    )}
                  </button>
                </div>
              )}
              {showMobileSessionAlternateAction && (
                <div className="message-input-keyboard-secondary-slot message-input-keyboard-session-alternate-slot">
                  <button
                    type="button"
                    className={`message-input-keyboard-action message-input-keyboard-secondary ${mobileKeyboardAlternateAction.kind}-mode`}
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
                </div>
              )}
              {forkSummaryMode?.onSubmitWithoutSummary &&
                mobileKeyboardAlternateAction && (
                  <button
                    type="button"
                    className={`message-input-keyboard-action message-input-keyboard-alternate ${mobileKeyboardAlternateAction.kind}-mode`}
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
                  className="message-input-keyboard-action message-input-keyboard-secondary bang-tab-mode"
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
                    className="message-input-keyboard-action message-input-keyboard-secondary composer-recall-open"
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
                className={`message-input-keyboard-action message-input-keyboard-primary ${effectivePrimaryActionKind}-mode${
                  toolbarVisibility.waveform
                    ? ` ${styles.keyboardPrimaryWithWaveform}`
                    : ""
                }`}
                onPointerDown={(event) => event.preventDefault()}
                onClick={handlePrimaryPointerDelivery}
                disabled={disabled}
                aria-label={describePrefixedDelivery(
                  mobileKeyboardActionLabel,
                  primaryDeliverySpeechPrefix,
                )}
                title={describePrefixedTooltip(
                  mobileKeyboardActionLabel,
                  primaryDeliverySpeechPrefix,
                )}
              >
                {mobileKeyboardActionDisplayLabel && (
                  <span className="message-input-keyboard-primary-label">
                    {mobileKeyboardActionDisplayLabel}
                  </span>
                )}
                <DeliveryGlyph className="message-input-keyboard-primary-icon">
                  {mobileKeyboardActionIcon}
                </DeliveryGlyph>
                {primaryDeliverySpeechPrefix && (
                  <SpeechPrefixActionCue prefix={primaryDeliverySpeechPrefix} />
                )}
              </button>
            </div>
          </div>
        )}

        {!collapsed && !showMobileKeyboardCompact && (
          <MessageInputToolbar {...toolbarProps} />
        )}
      </div>
    </div>
  );
}
