import {
  getIsearchPreviousKeys,
  getIsearchAlternateRows,
} from "./composerSearchShortcuts";
import {
  describeSessionLiveness,
  formatLivenessAge,
  describeLivenessSummary,
  getBtwTitle,
  isBtwPressed,
  LAST_ACTIVITY_TEXT_PREFIX_THRESHOLD_MS,
  type LivenessDisplay,
} from "./composerToolbarStatus";
export type { LivenessTone, LivenessDisplay } from "./composerToolbarStatus";
import { messageInputToolbarStateClasses } from "./composerStateClasses";
import voiceStyles from "./VoiceInputButton.module.css";
import attachStyles from "./AttachmentButton.module.css";
import actionStyles from "./ComposerActions.module.css";
import { AttachmentButton } from "./AttachmentButton";
import { useSourceContextMenu } from "./SourceContextMenu";
import { useEscapeInterruptDisabled } from "../hooks/useEscapeInterruptDisabled";
import type {
  ModelInfo,
  ProviderRuntimeStatus,
  ProviderName,
  SessionLivenessSnapshot,
  SlashCommand,
} from "@yep-anywhere/shared";
import {
  DEFAULT_PROJECT_QUEUE_CTRL_ENTER_ENABLED,
  REMOTE_BROWSER_DIAGNOSTICS_CAPABILITY,
  VOICE_INPUT_CAPABILITY,
  hasServerCapabilityAdvertisement,
  serverHasCapability,
} from "@yep-anywhere/shared";
import type { CSSProperties, MouseEvent, RefObject } from "react";
import { useAsyncQuestions } from "../contexts/AsyncQuestionsContext";
import { AsyncQuestionsButton } from "./AsyncQuestionsButton";
import {
  type Dispatch,
  type SetStateAction,
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { createPortal } from "react-dom";
import { useOptionalRenderModeContext } from "../contexts/RenderModeContext";
import { useOptionalToastContext } from "../contexts/ToastContext";
import { ConversationViewIcon } from "./ConversationViewIcon";
import { DeliveryGlyph } from "./DeliveryGlyph";
import {
  type EffortLevel,
  type ThinkingMode,
  useModelSettings,
} from "../hooks/useModelSettings";
import { useBrowserXaiSttApiKey } from "../hooks/useBrowserXaiSttApiKey";
import { useBrowserDebugLease } from "../hooks/useBrowserDebugLease";
import { useConversationView } from "../hooks/useConversationView";
import { useSpeechSourceRuntime } from "../hooks/useSpeechSourceRuntime";
import {
  getComposerToolbarOverflowLayoutSignature,
  type MessageInputToolbarLayoutRefs,
  useMeasuredComposerOverflow,
} from "../hooks/useMessageInputToolbarLayout";
import {
  beginTooltipSuppression,
  getTextTooltipAttributes,
  useTooltipMode,
} from "../hooks/useTooltipAppearance";
import { useProviders } from "../hooks/useProviders";
import { useRelativeNow } from "../hooks/useRelativeNow";
import {
  DEFAULT_SESSION_TOOLBAR_PRIORITY,
  type SessionToolbarPriority,
  type SessionToolbarVisibility,
  type SessionToolbarVisibilityKey,
  type ToolbarNarrowingPriority,
  useSessionToolbarPresence,
} from "../hooks/useSessionToolbarPresence";
import { useVersion } from "../hooks/useVersion";
import {
  DEFAULT_WAVEFORM_BUTTON_BACKGROUND_OPACITY_PERCENT,
  useWaveformButtonBackgroundOpacity,
} from "../hooks/useWaveformButtonBackgroundOpacity";
import { useI18n } from "../i18n";
import type { BtwToolbarMode } from "../lib/btwAsideRouting";
import { writeClipboardTextLater } from "../lib/clipboard";
import { BROWSER_DEBUG_LEASE_TTL_MS } from "../lib/browserDebugLease";
import {
  sessionViewerShowsBottomController,
  sessionViewerUsesRightPane,
} from "../lib/sessionViewerPlacement";
import {
  type SessionViewerControllerState,
  useSessionViewerController,
} from "../lib/sessionViewerController";
import {
  getEffortLevelOptions,
  getThinkingModeOptions,
  resolveSupportedEffortLevel,
  resolveSupportedThinkingMode,
} from "../lib/effortLevels";
import {
  formatAbsoluteTimestamp,
  formatCompactRelativeAge,
  isStaleTimestamp,
  parseTimestampMs,
} from "../lib/messageAge";
import { normalizeProviderKey } from "../lib/modelIndicatorText";
import {
  describeProviderRuntimeStatus,
  type ProviderRuntimeDisplay,
} from "../lib/providerRuntimeStatus";
import { getPermissionModeOptions } from "../lib/permissionModes";

import {
  requestSessionIsearchOpen,
  SESSION_ISEARCH_GUIDE_EVENT,
  type SessionIsearchGuideState,
  type SessionIsearchScope,
} from "../lib/sessionIsearchGuide";
import toolbarModuleStyles from "./MessageInputToolbar.module.css";
import { NewSessionQueueMark } from "./NewSessionQueueMark";
import {
  DEFAULT_SPEECH_METHOD,
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
  SpeechTranscriptionSettlement,
} from "../lib/speechProviders/SpeechProvider";
import type { SpeechCommitOutcome } from "../lib/speechDraftTransaction";
import type { TranscriptPositionStore } from "../lib/transcriptPositionStore";
import type { ContextUsage, PermissionMode } from "../types";
import { ContextThresholdQuickEdit } from "./ContextThresholdQuickEdit";
import { SpeechPrefixActionCue } from "./SpeechPrefixActionCue";
import type { FilterOption } from "./FilterDropdown";
import { MessageAge } from "./MessageAge";
import { MicrophoneIcon } from "./MicrophoneIcon";
import { ModeSelector } from "./ModeSelector";
import { SlashCommandButton } from "./SlashCommandButton";
import { SpeechControlMenu } from "./SpeechControlMenu";
import { SpeechWaveform } from "./SpeechWaveform";
import {
  ThinkingToolbarControl,
  type ToolbarThinkingControl,
} from "./ThinkingToolbarControl";
import { RenderModeGlyph } from "./ui/RenderModeGlyph";
import { SessionPathLinkOptions } from "./SessionPathLinkOptions";
import { SessionViewerToolbarController } from "./SessionViewerToolbarController";
import {
  VoiceInputButton,
  type SpeechCycleSettlement,
  type SpeechPendingKind,
  type VoiceInputButtonRef,
} from "./VoiceInputButton";

type ToolbarTranslate = ReturnType<typeof useI18n>["t"];

const BrowserDebugToolbarButton = lazy(() =>
  import("./BrowserDebugToolbarButton").then((module) => ({
    default: module.BrowserDebugToolbarButton,
  })),
);

const subscribeToNoPositionStore = () => () => {};
const getNoPositionSnapshot = () => null;

// Maps a control's narrowing priority to its overflow-tier CSS class. `first`
// collapses first (early), `mid` next, `last` collapses last; `pin` yields no
// tier class (and its menu copy stays hidden) so the control never collapses.
function priorityToTierClass(priority: ToolbarNarrowingPriority): string {
  switch (priority) {
    case "first":
      return "composer-bottom-overflow-early";
    case "mid":
      return "composer-bottom-overflow-medium";
    case "last":
      return "composer-bottom-overflow-late";
    default:
      return "";
  }
}

export interface MessageInputToolbarProps {
  onAttachmentPanel?: () => void;
  onRecordAudioMemo?: () => void;
  /** Canonical YA session id represented by this composer. */
  sessionId?: string;
  // Mode selector
  mode?: PermissionMode;
  onModeChange?: (mode: PermissionMode) => void;
  modeChangesApplyNextTurn?: boolean;
  modeChangePending?: boolean;

  // Provider capability flags (default to true for backwards compatibility)
  supportsPermissionMode?: boolean;
  supportsThinkingToggle?: boolean;

  // Attachments
  canAttach?: boolean;
  attachmentCount?: number;
  onAttachClick?: () => void;

  // Voice input
  voiceButtonRef?: RefObject<VoiceInputButtonRef | null>;
  onVoiceTranscript?: (
    transcript: string,
    metadata?: SpeechTranscriptionResultMetadata,
  ) => SpeechCommitOutcome | undefined;
  onInterimTranscript?: (transcript: string) => void;
  onListeningStart?: () => void;
  onListeningStop?: () => boolean | undefined;
  onPendingSpeechChange?: (
    kind: SpeechPendingKind | null,
    settlement?: SpeechCycleSettlement,
  ) => void;
  onTranscriptionSettled?: (settlement: SpeechTranscriptionSettlement) => void;
  voiceDisabled?: boolean;
  getTranscriptionContext?: () => SpeechTranscriptionContext | undefined;

  // Slash commands
  slashCommands?: SlashCommand[];
  onSelectSlashCommand?: (command: SlashCommand) => void;
  onBtwClick?: () => void;
  btwActive?: boolean;
  btwHasAsides?: boolean;
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
  /**
   * YA model id (launch alias) used to key the context quick-edit's per-model
   * compaction threshold. Distinct from `thinkingModel` (the reported model);
   * falls back to it when absent. See topics/provider-abstraction.md.
   */
  contextRequestedModel?: string;

  // Context usage
  contextUsage?: ContextUsage;
  /** Last session activity timestamp for stale composer liveness display. */
  lastActivityAt?: string | null;
  /** Hovered or scrolled transcript position timestamp for the status line. */
  positionTimestampMs?: number | null;
  /** Latest-wins transcript position source for the status line. */
  positionTimestampStore?: TranscriptPositionStore;
  /** Server-derived provider/session liveness evidence. */
  sessionLiveness?: SessionLivenessSnapshot | null;
  /** Provider-owned retry/failure status for the active turn. */
  providerRuntimeStatus?: ProviderRuntimeStatus;
  /** Whether the provider exposes a soft-immediate steer lane. */
  showSteerNowMode?: boolean;
  /** Whether steering uses the soft-immediate lane for future sends. */
  steerNowEnabled?: boolean;
  /** Toggle soft-immediate steering for future steer sends. */
  onToggleSteerNow?: () => void;
  /** The action currently bound to Enter in dual-action steering sessions. */
  enterActionKind?: "steer" | "queue";
  /** Whether Enter and Ctrl+Enter may be swapped. */
  canSwapEnterAction?: boolean;
  /** Swap Enter and Ctrl+Enter in dual-action steering sessions. */
  onSwapEnterAction?: () => void;

  // Actions
  isRunning?: boolean;
  isThinking?: boolean;
  onStop?: () => void;
  onDone?: () => void;
  doneTitle?: string;
  onSend?: () => void;
  /** Queue a deferred message. Only provided when agent is running. */
  onQueue?: () => void;
  /** Queue through the project-level idle gate. Hidden unless opted in. */
  onProjectQueue?: () => void;
  /** Queue the draft as a new session after the project becomes idle. */
  onProjectQueueNewSession?: () => void;
  /** Right-click/long-press on the new-session action: choose its target. */
  onProjectQueueNewSessionOptions?: () => void;
  /** Queue the draft as this session's next topic once the agent is done. */
  onTopicShift?: () => void;
  onSendOptions?: () => void;
  /** Steer the current turn. Used as the alternate action when Enter queues. */
  onSteer?: () => void;
  primaryActionKind?: "send" | "steer" | "queue";
  sendOverride?: {
    label: string;
    tooltip: string;
    icon: string;
  };
  sendAlternate?: {
    label: string;
    tooltip: string;
    icon: string;
    onClick: () => void;
  };
  canForkAfterSummary?: boolean;
  canSend?: boolean;
  /** Exact prefix this delivery will prepend, or null for an unchanged payload. */
  speechMessagePrefix?: string | null;
  /** Primary-action override for local-only composer commands. */
  primarySpeechMessagePrefix?: string | null;
  disabled?: boolean;
  /** Keep toolbar utilities/settings but omit the ordinary primary/alternate actions. */
  hidePrimaryDeliveryActions?: boolean;
  /** Keep the live mic outside this toolbar instance. */
  hideVoiceInput?: boolean;

  // Pending approval indicator
  pendingApproval?: {
    type: "tool-approval" | "user-question";
    onExpand: () => void;
  };
}

const COMPACT_STATUS_QUERY = "(max-width: 600px)";

// Widening headroom required before measured-compact status mode releases;
// see updateCompactStatusMode for why exiting needs more than merely fitting.
const COMPACT_STATUS_EXIT_SLACK_PX = 72;

function getCompactStatusMatchMedia() {
  if (
    typeof window === "undefined" ||
    typeof window.matchMedia !== "function"
  ) {
    return null;
  }
  return window.matchMedia(COMPACT_STATUS_QUERY);
}

type ToolbarRenderModeState = "rendered" | "source" | "mixed";

interface ToolbarModeControl {
  mode: PermissionMode;
  onModeChange: (mode: PermissionMode) => void;
  modes?: readonly PermissionMode[];
  changesApplyNextTurn?: boolean;
  modeChangePending?: boolean;
}

interface ToolbarAttachmentControl {
  onAttachmentPanel?: () => void;
  onRecordAudioMemo?: () => void;
  canAttach?: boolean;
  attachmentCount: number;
  onAttachClick?: () => void;
}

interface ToolbarSlashControl {
  commands: SlashCommand[];
  onSelectCommand: (command: SlashCommand) => void;
  disabled?: boolean;
}

interface ToolbarRenderModeControl {
  state: ToolbarRenderModeState;
  title: string;
  onToggle: () => void;
}

interface ToolbarConversationViewControl {
  enabled: boolean;
  title: string;
  onToggle: () => void;
}

type ToolbarVoiceButtonControl =
  | {
      kind: "live";
      ref?: RefObject<VoiceInputButtonRef | null>;
      onTranscript: (
        transcript: string,
        metadata?: SpeechTranscriptionResultMetadata,
      ) => SpeechCommitOutcome | undefined;
      onInterimTranscript: (transcript: string) => void;
      onListeningStart?: () => void;
      onListeningStop?: () => boolean | undefined;
      onPendingSpeechChange?: (
        kind: SpeechPendingKind | null,
        settlement?: SpeechCycleSettlement,
      ) => void;
      onTranscriptionSettled?: (
        settlement: SpeechTranscriptionSettlement,
      ) => void;
      showWaveform?: boolean;
      disabled?: boolean;
      speechMethod: SpeechMethodId | null;
      getTranscriptionContext?: () => SpeechTranscriptionContext | undefined;
      smartTurn?: SpeechSmartTurnSettings;
    }
  | {
      kind: "preview";
      disabled?: boolean;
    };

interface ToolbarSpeechControl {
  showMethodSelector: boolean;
  methodOptions: FilterOption<SpeechMethodId>[];
  selectedMethod: SpeechMethodId | null;
  onMethodChange: (selected: string[]) => void;
  smartTurnSettings?: SpeechSmartTurnSettings;
  onSmartTurnSettingsChange?: (settings: SpeechSmartTurnSettings) => void;
  smartTurnDisabled?: boolean;
  voiceButton?: ToolbarVoiceButtonControl;
}

interface ToolbarStatusControl {
  showToolbarStatus: boolean;
  showLivenessChip: boolean;
  livenessDisplay: LivenessDisplay | null;
  livenessSummary: string | null;
  providerRuntimeDisplay?: ProviderRuntimeDisplay | null;
  nowMs: number;
  showLastActivityChip: boolean;
  showLastActivityPrefix: boolean;
  lastActivityMs: number | null;
  lastActivityIsPast: boolean;
  positionTimestampMs: number | null;
  showPositionTimestamp: boolean;
  /** Position age present regardless of the sessionStatus toggle (compact float). */
  hasPositionAge: boolean;
  /** Last-activity freshness present regardless of the sessionStatus toggle. */
  hasLastActivityAge: boolean;
}

interface ToolbarBrowserDebugControl {
  active: boolean;
  connected: boolean;
  enabling?: boolean;
  remainingFraction: number;
  performanceLabel?: string | null;
  title: string;
  onToggle: () => void;
  onReactivate: () => void;
  onReload: () => void;
}

interface ToolbarShortcutsControl {
  open: boolean;
  isearchScope: SessionIsearchScope | null;
  setOpen: Dispatch<SetStateAction<boolean>>;
  settingsOpen: boolean;
  setSettingsOpen: Dispatch<SetStateAction<boolean>>;
  hasDualActions: boolean;
  enterActionKind: "send" | "steer" | "queue";
  canSwapEnterAction: boolean;
  onSwapEnterAction?: () => void;
  queueShortcutLabel: string;
  canForkAfterSummary?: boolean;
}

interface ToolbarBtwControl {
  onClick: () => void;
  pressed: boolean;
  mode: BtwToolbarMode;
  title: string;
}

interface ToolbarQueueControl {
  onQueue?: () => void;
  onSteer?: () => void;
  hasDualActions: boolean;
  queueTooltip: string;
}

interface ToolbarSendControl {
  onSend?: () => void;
  onSendOptions?: () => void;
  onSteer?: () => void;
  canSend?: boolean;
  primaryActionKind: "send" | "steer" | "queue";
  primaryActionLabel: string;
  tooltip: string;
  icon: string;
  speechMessagePrefix?: string | null;
  primarySpeechMessagePrefix?: string | null;
  showSteerNowMode?: boolean;
  steerNowEnabled?: boolean;
  onToggleSteerNow?: () => void;
  queue?: ToolbarQueueControl;
  alternate?: {
    label: string;
    tooltip: string;
    icon: string;
    onClick: () => void;
  };
}

interface ToolbarProjectQueueControl {
  onProjectQueue?: () => void;
  onProjectQueueNewSession?: () => void;
  onProjectQueueNewSessionOptions?: () => void;
  canSend?: boolean;
  tooltip?: string;
  newSessionTooltip?: string;
}

interface ToolbarTopicShiftControl {
  onTopicShift: () => void;
  canSend?: boolean;
}

interface ToolbarStopControl {
  onStop: () => void;
}

interface ToolbarDoneControl {
  onDone: () => void;
  title: string;
}

interface ToolbarActionsControl {
  disabled?: boolean;
  voiceDisabled?: boolean;
  contextUsage?: ContextUsage;
  /** Session model id, for the long-press compact-threshold quick-edit. */
  contextModel?: string;
  /** Provider account whose subscription windows apply to the context model. */
  contextProvider?: ProviderName;
  /** Model context window, for the quick-edit token preview. */
  contextWindow?: number;
  /** Session whose live context breakdown the usage popover may show. */
  contextSessionId?: string;
  btw?: ToolbarBtwControl | null;
  stop?: ToolbarStopControl | null;
  projectQueue?: ToolbarProjectQueueControl | null;
  topicShift?: ToolbarTopicShiftControl | null;
  send?: ToolbarSendControl | null;
}

export interface MessageInputToolbarViewProps {
  t: ToolbarTranslate;
  refs?: MessageInputToolbarLayoutRefs;
  visibility: SessionToolbarVisibility;
  onHideControl?: (key: SessionToolbarVisibilityKey) => void;
  /** Per-control narrowing priority; defaults to the built-in tiers when absent. */
  priority?: SessionToolbarPriority;
  isCompactStatusMode?: boolean;
  modeControl?: ToolbarModeControl | null;
  attachmentControl: ToolbarAttachmentControl;
  slashControl?: ToolbarSlashControl | null;
  thinkingControl?: ToolbarThinkingControl | null;
  renderModeControl?: ToolbarRenderModeControl | null;
  conversationViewControl?: ToolbarConversationViewControl | null;
  browserDebugControl?: ToolbarBrowserDebugControl | null;
  doneControl?: ToolbarDoneControl | null;
  speechControl?: ToolbarSpeechControl | null;
  speechWaveformActive?: boolean;
  speechWaveformPreview?: boolean;
  waveformButtonBackgroundOpacityPercent?: number;
  fileViewerController?: SessionViewerControllerState | null;
  statusControl?: ToolbarStatusControl | null;
  pendingApproval?: MessageInputToolbarProps["pendingApproval"];
  shortcutsControl: ToolbarShortcutsControl;
  actionsControl: ToolbarActionsControl;
  hidePrimaryDeliveryActions?: boolean;
}

function ToolbarDoneIcon() {
  return (
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
      <circle cx="12" cy="12" r="9" />
      <path d="m8 12 2.5 2.5L16 9" />
    </svg>
  );
}

function BrowserDebugBugIcon() {
  return (
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
      <path d="m8 2 1.9 1.9" />
      <path d="M14.1 3.9 16 2" />
      <path d="M9 7.1V6a3 3 0 0 1 6 0v1.1" />
      <rect width="12" height="13" x="6" y="7" rx="5" />
      <path d="M3 13h3M18 13h3M4 7.5l2.4 1.2M17.6 8.7 20 7.5M4 18.5l2.4-1.2M17.6 17.3l2.4 1.2M12 12v8" />
    </svg>
  );
}

function BrowserDebugLeaseIcon({
  active,
  remainingFraction,
  performanceLabel,
}: {
  active: boolean;
  remainingFraction: number;
  performanceLabel?: string | null;
}) {
  if (!active) return <BrowserDebugBugIcon />;
  return (
    <>
      <span
        className={toolbarModuleStyles.browserDebugCountdown}
        style={
          {
            "--browser-debug-remaining": remainingFraction,
          } as CSSProperties
        }
        aria-hidden="true"
      >
        <span className={toolbarModuleStyles.browserDebugWarning}>!</span>
      </span>
      {performanceLabel ? (
        <span
          className={toolbarModuleStyles.browserDebugPerformance}
          aria-hidden="true"
        >
          {performanceLabel}
        </span>
      ) : null}
    </>
  );
}

function LazyBrowserDebugToolbarButton({
  t,
  control,
  className,
  menuItem = false,
  dataAttributes,
}: {
  t: ToolbarTranslate;
  control: ToolbarBrowserDebugControl;
  className: string;
  menuItem?: boolean;
  dataAttributes?: ToolbarControlMarker;
}) {
  const icon = (
    <BrowserDebugLeaseIcon
      active={control.active}
      remainingFraction={control.remainingFraction}
      performanceLabel={control.performanceLabel}
    />
  );
  const ariaProps = menuItem
    ? ({ role: "menuitemcheckbox", "aria-checked": control.active } as const)
    : ({ "aria-pressed": control.active } as const);
  const fallback = (
    <button
      type="button"
      className={className}
      {...dataAttributes}
      onClick={control.onToggle}
      title={control.title}
      aria-label={control.title}
      {...ariaProps}
      disabled={control.enabling}
    >
      {icon}
    </button>
  );

  return (
    <Suspense fallback={fallback}>
      <BrowserDebugToolbarButton
        t={t}
        active={control.active}
        connected={control.connected}
        disabled={control.enabling}
        className={className}
        title={control.title}
        menuItem={menuItem}
        onToggle={control.onToggle}
        onReactivate={control.onReactivate}
        onReload={control.onReload}
        dataAttributes={dataAttributes}
      >
        {icon}
      </BrowserDebugToolbarButton>
    </Suspense>
  );
}

const TOOLBAR_HIDE_TOUCH_CONTEXT_WINDOW_MS = 1_500;
const TOOLBAR_HIDE_VIEWPORT_MARGIN_PX = 8;
const TOOLBAR_HIDE_TARGET_GAP_PX = 6;

interface ToolbarHidePopoverState {
  key: SessionToolbarVisibilityKey;
  target: HTMLElement;
  tooltip: string;
  touch: boolean;
}

interface ToolbarControlMarker {
  "data-session-toolbar-control"?: SessionToolbarVisibilityKey;
  "data-session-toolbar-special-context"?: "true";
}

function getToolbarControlTooltip(
  eventTarget: Element,
  controlTarget: HTMLElement,
): string {
  let candidate: Element | null = eventTarget;
  while (candidate && controlTarget.contains(candidate)) {
    const tooltip = candidate.getAttribute("data-tooltip")?.trim();
    if (tooltip) return tooltip;
    const title = candidate.getAttribute("title")?.trim();
    if (title) return title;
    if (candidate === controlTarget) break;
    candidate = candidate.parentElement;
  }

  for (const descendant of controlTarget.querySelectorAll(
    "[data-tooltip], [title]",
  )) {
    const tooltip = descendant.getAttribute("data-tooltip")?.trim();
    if (tooltip) return tooltip;
    const title = descendant.getAttribute("title")?.trim();
    if (title) return title;
  }

  return (
    controlTarget.getAttribute("aria-label")?.trim() ||
    controlTarget
      .querySelector<HTMLElement>("[aria-label]")
      ?.getAttribute("aria-label")
      ?.trim() ||
    controlTarget.textContent?.trim() ||
    ""
  );
}

function ToolbarHidePopover({
  state,
  t,
  onClose,
  onHide,
}: {
  state: ToolbarHidePopoverState;
  t: ToolbarTranslate;
  onClose: () => void;
  onHide: (key: SessionToolbarVisibilityKey) => void;
}) {
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const hideButtonRef = useRef<HTMLButtonElement | null>(null);
  const [position, setPosition] = useState<{
    left: number;
    top: number;
  } | null>(null);

  useEffect(() => beginTooltipSuppression(), []);

  useLayoutEffect(() => {
    const popover = popoverRef.current;
    if (!popover || !state.target.isConnected) {
      onClose();
      return;
    }
    const targetRect = state.target.getBoundingClientRect();
    const popoverRect = popover.getBoundingClientRect();
    const maxLeft = Math.max(
      TOOLBAR_HIDE_VIEWPORT_MARGIN_PX,
      window.innerWidth - TOOLBAR_HIDE_VIEWPORT_MARGIN_PX - popoverRect.width,
    );
    const centeredLeft =
      targetRect.left + targetRect.width / 2 - popoverRect.width / 2;
    const aboveTop =
      targetRect.top - TOOLBAR_HIDE_TARGET_GAP_PX - popoverRect.height;
    const belowTop = targetRect.bottom + TOOLBAR_HIDE_TARGET_GAP_PX;
    setPosition({
      left: Math.min(
        maxLeft,
        Math.max(TOOLBAR_HIDE_VIEWPORT_MARGIN_PX, centeredLeft),
      ),
      top:
        aboveTop >= TOOLBAR_HIDE_VIEWPORT_MARGIN_PX
          ? aboveTop
          : Math.min(
              belowTop,
              window.innerHeight -
                TOOLBAR_HIDE_VIEWPORT_MARGIN_PX -
                popoverRect.height,
            ),
    });
    if (!state.touch) {
      hideButtonRef.current?.focus({ preventScroll: true });
    }
  }, [onClose, state]);

  useEffect(() => {
    const handlePointerDown = (event: globalThis.PointerEvent) => {
      if (
        event.target instanceof Node &&
        popoverRef.current?.contains(event.target)
      ) {
        return;
      }
      onClose();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onClose();
      state.target.focus({ preventScroll: true });
    };
    const handleScroll = (event: Event) => {
      // Transcript reflow can scroll a sibling while these options are edited.
      // Only scrolling an ancestor can move this menu's toolbar anchor.
      if (
        event.target === document ||
        event.target === window ||
        (event.target instanceof Element && event.target.contains(state.target))
      ) {
        onClose();
      }
    };
    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("keydown", handleKeyDown, true);
    window.addEventListener("resize", onClose);
    window.addEventListener("scroll", handleScroll, true);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("keydown", handleKeyDown, true);
      window.removeEventListener("resize", onClose);
      window.removeEventListener("scroll", handleScroll, true);
    };
  }, [onClose, state.target]);

  return createPortal(
    <div
      ref={popoverRef}
      className={`${toolbarModuleStyles.hidePopover}${state.key === "renderMode" ? ` ${toolbarModuleStyles.renderOptionsPopover}` : ""}`}
      role="dialog"
      aria-label={t("toolbarHideControlMenuAria")}
      style={
        position
          ? { left: position.left, top: position.top }
          : { visibility: "hidden" }
      }
    >
      <span className={toolbarModuleStyles.hidePopoverTooltip}>
        {state.tooltip}
      </span>
      {state.key === "renderMode" && <SessionPathLinkOptions />}
      <button
        ref={hideButtonRef}
        type="button"
        className={toolbarModuleStyles.hidePopoverAction}
        onClick={() => {
          onClose();
          onHide(state.key);
        }}
      >
        {t("appearanceToolbarHide")}
      </button>
    </div>,
    document.body,
  );
}

export function MessageInputToolbarView({
  t,
  refs,
  visibility,
  onHideControl,
  priority,
  isCompactStatusMode = false,
  modeControl,
  attachmentControl,
  slashControl,
  thinkingControl,
  renderModeControl,
  conversationViewControl,
  browserDebugControl,
  doneControl,
  speechControl,
  speechWaveformActive = false,
  speechWaveformPreview = false,
  waveformButtonBackgroundOpacityPercent = DEFAULT_WAVEFORM_BUTTON_BACKGROUND_OPACITY_PERCENT,
  fileViewerController = null,
  statusControl,
  pendingApproval,
  shortcutsControl,
  actionsControl,
  hidePrimaryDeliveryActions = false,
}: MessageInputToolbarViewProps) {
  const { escapeInterruptDisabled, setEscapeInterruptDisabled } =
    useEscapeInterruptDisabled();
  const stopMenu = useSourceContextMenu(t, {
    menu: t("toolbarStopOptions"),
  });
  const asyncQuestions = useAsyncQuestions();
  const hasAsyncQuestions =
    (asyncQuestions?.questions.length ?? 0) > 0 &&
    asyncQuestions?.reminderTurns !== 0;
  const tooltipMode = useTooltipMode();
  const [hidePopover, setHidePopover] =
    useState<ToolbarHidePopoverState | null>(null);
  const lastTouchAtRef = useRef(0);
  const closeHidePopover = useCallback(() => setHidePopover(null), []);
  const toolbarControlMarker = (
    key: SessionToolbarVisibilityKey,
    hasSpecialContextAction = false,
  ): ToolbarControlMarker => ({
    "data-session-toolbar-control": key,
    "data-session-toolbar-special-context": hasSpecialContextAction
      ? "true"
      : undefined,
  });
  const normalizedWaveformButtonBackgroundOpacity = Math.min(
    100,
    Math.max(0, waveformButtonBackgroundOpacityPercent),
  );
  const waveformBackdropActive = speechWaveformActive;
  const waveformBackdropStyle = waveformBackdropActive
    ? ({
        "--waveform-control-surface-opacity": `${normalizedWaveformButtonBackgroundOpacity}%`,
      } as CSSProperties)
    : undefined;
  const controlPriority = priority ?? DEFAULT_SESSION_TOOLBAR_PRIORITY;
  const effectivePriority = (
    key: SessionToolbarVisibilityKey,
  ): ToolbarNarrowingPriority => {
    const configured = controlPriority[key];
    if (fileViewerController && configured === "pin" && key !== "microphone") {
      return "last";
    }
    return configured;
  };
  // Priority classes label measurement candidates. Individual hidden membership
  // keeps each control's inline and menu presentations mutually exclusive.
  const inlineTierClass = (
    key: SessionToolbarVisibilityKey,
    ...extra: (string | undefined)[]
  ): string =>
    [
      ...extra,
      toolbarModuleStyles.composerBottomOverflowInline,
      priorityToTierClass(effectivePriority(key)),
      hiddenControls.has(key) ? toolbarModuleStyles.overflowHidden : "",
    ]
      .filter(Boolean)
      .join(" ");
  const menuTierClass = (
    key: SessionToolbarVisibilityKey,
    ...extra: (string | undefined)[]
  ): string => {
    const tierClass = priorityToTierClass(effectivePriority(key));
    return [
      ...extra,
      tierClass || "composer-bottom-overflow-pinned",
      hiddenControls.has(key)
        ? toolbarModuleStyles.overflowVisible
        : toolbarModuleStyles.overflowHidden,
    ]
      .filter(Boolean)
      .join(" ");
  };
  const isPriorityCollapsible = (key: SessionToolbarVisibilityKey): boolean =>
    effectivePriority(key) !== "pin";
  const shortcutsPopoverOpen = shortcutsControl.open;
  const shortcutSettings =
    shortcutsControl.canSwapEnterAction && shortcutsControl.onSwapEnterAction
      ? { onSwapEnterAction: shortcutsControl.onSwapEnterAction }
      : null;
  // The status ages float whenever the inline expanded row is unavailable:
  // compact viewport, mobile layout, or the sessionStatus toggle off.
  const statusFloats = isCompactStatusMode || !visibility.sessionStatus;
  // The float carries only the two ages. The liveness chip is inline-only:
  // floated it degrades to a bare "now"/"5m" pill with none of the liveness
  // framing the inline row gives it.
  const showLivenessChip =
    !statusFloats && (statusControl?.showLivenessChip ?? false);
  const livenessDisplay = statusControl?.livenessDisplay ?? null;
  const providerRuntimeDisplay = statusControl?.providerRuntimeDisplay ?? null;
  const showPositionChip =
    (statusControl?.showPositionTimestamp ?? false) ||
    (statusFloats && (statusControl?.hasPositionAge ?? false));
  const showLastActivityChip =
    (statusControl?.showLastActivityChip ?? false) ||
    (statusFloats && (statusControl?.hasLastActivityAge ?? false));
  const showProviderRuntimeChip = !!providerRuntimeDisplay;
  const showToolbarStatus =
    showProviderRuntimeChip ||
    showLivenessChip ||
    showPositionChip ||
    showLastActivityChip;
  // The floating presentation needs `[data-status-floats]` so the ages anchor over
  // the composer; wide+enabled keeps the inline row's positioning context.
  const applyStatusFloats =
    isCompactStatusMode || (statusFloats && showToolbarStatus);
  const showSendButton = !!(
    !hidePrimaryDeliveryActions && actionsControl.send?.onSend
  );
  const showStopButton = !!actionsControl.stop;
  const showCurrentSessionProjectQueueButton = !!(
    visibility.projectQueue &&
    actionsControl.projectQueue?.onProjectQueue &&
    actionsControl.send
  );
  const showNewSessionProjectQueueButton = !!(
    visibility.projectQueueNewSessionShortcut &&
    actionsControl.projectQueue?.onProjectQueueNewSession &&
    actionsControl.send
  );
  const showProjectQueueButton =
    showCurrentSessionProjectQueueButton || showNewSessionProjectQueueButton;
  const showTopicShiftButton = !!(
    visibility.topicShift &&
    actionsControl.topicShift &&
    actionsControl.send
  );
  const selectedSpeechMethod = speechControl?.selectedMethod ?? null;
  const queueControl = actionsControl.send?.queue;
  const canToggleSteerNow = !!(
    visibility.steerNow &&
    actionsControl.send?.showSteerNowMode &&
    actionsControl.send.onToggleSteerNow
  );
  const showActionsControl =
    showProjectQueueButton ||
    showTopicShiftButton ||
    showSendButton ||
    canToggleSteerNow;
  const renderStatusAges = (
    className: string | undefined,
    ref?: RefObject<HTMLDivElement | null>,
  ) => {
    if (!showToolbarStatus || !statusControl) {
      return null;
    }

    return (
      <div
        ref={ref}
        className={className}
        data-composer-status-ages
        {...toolbarControlMarker("sessionStatus")}
      >
        {showLivenessChip && livenessDisplay && (
          <div
            className={`${toolbarModuleStyles.composerStatusChip} ${toolbarModuleStyles.composerLivenessStatus} ${messageInputToolbarStateClasses[`is-${livenessDisplay.tone}`] ?? ""}`}
            data-composer-liveness-status
            role="status"
            aria-label={t("toolbarLivenessAria", {
              summary: statusControl.livenessSummary ?? "",
            })}
            title={livenessDisplay.title}
          >
            {livenessDisplay.timestampMs !== null ? (
              <time
                className={toolbarModuleStyles.composerLivenessTime}
                dateTime={new Date(livenessDisplay.timestampMs).toISOString()}
                title={`${formatAbsoluteTimestamp(livenessDisplay.timestampMs)}\n${livenessDisplay.title}`}
              >
                {formatLivenessAge(
                  t,
                  livenessDisplay.timestampMs,
                  statusControl.nowMs,
                )}
              </time>
            ) : (
              <span className={toolbarModuleStyles.composerLivenessTime}>
                {livenessDisplay.prefix}
              </span>
            )}
          </div>
        )}
        {showProviderRuntimeChip && providerRuntimeDisplay && (
          <div
            className={`${toolbarModuleStyles.composerStatusChip} ${toolbarModuleStyles.composerProviderRuntimeStatus} ${messageInputToolbarStateClasses[`is-${providerRuntimeDisplay.tone}`] ?? ""}`}
            data-composer-provider-runtime-status
            role="status"
            aria-label={t("toolbarProviderRuntimeAria", {
              summary: providerRuntimeDisplay.summary,
            })}
            title={providerRuntimeDisplay.title}
          >
            {providerRuntimeDisplay.retryAtMs !== null ? (
              <time
                className="composer-provider-runtime-time"
                dateTime={new Date(
                  providerRuntimeDisplay.retryAtMs,
                ).toISOString()}
              >
                {providerRuntimeDisplay.summary}
              </time>
            ) : (
              <span className="composer-provider-runtime-time">
                {providerRuntimeDisplay.summary}
              </span>
            )}
          </div>
        )}
        {showPositionChip && (
          <div
            className={`${toolbarModuleStyles.composerStatusChip} composer-position-age ${toolbarModuleStyles.composerActivityAgeCompact}`}
            role="status"
            aria-label={t("toolbarPositionAgeAria")}
          >
            <MessageAge
              timestampMs={statusControl.positionTimestampMs}
              nowMs={statusControl.nowMs}
              className={toolbarModuleStyles.composerPositionAgeTime}
              formatLabel={(label) => {
                const localizedLabel =
                  label === "now"
                    ? t("toolbarRelativeAgeNow")
                    : t("toolbarRelativeAgePast", { age: label });
                return t("toolbarPositionAge", { age: localizedLabel });
              }}
            />
          </div>
        )}
        {showLastActivityChip && (
          <div
            className={`${toolbarModuleStyles.composerStatusChip} composer-activity-age${statusControl.showLastActivityPrefix ? "" : ` ${toolbarModuleStyles.composerActivityAgeCompact}`}`}
            role="status"
            aria-label={t("toolbarLastActivityAria")}
          >
            <MessageAge
              timestampMs={statusControl.lastActivityMs}
              nowMs={statusControl.nowMs}
              className={toolbarModuleStyles.composerActivityAgeTime}
              formatLabel={(label) => {
                const localizedLabel =
                  label === "now" ? t("toolbarRelativeAgeNow") : label;
                if (statusControl.showLastActivityPrefix) {
                  return t("toolbarLastActivityAge", {
                    age: localizedLabel,
                  });
                }
                return statusControl.lastActivityIsPast
                  ? t("toolbarRelativeAgePast", { age: localizedLabel })
                  : localizedLabel;
              }}
            />
          </div>
        )}
      </div>
    );
  };
  const renderContextUsage = (className: string) => {
    if (!visibility.contextUsage || !actionsControl.contextUsage) {
      return null;
    }
    return (
      <span
        className={className}
        data-context-toolbar-control
        {...toolbarControlMarker("contextUsage", true)}
      >
        <ContextThresholdQuickEdit
          usage={actionsControl.contextUsage}
          model={actionsControl.contextModel}
          provider={actionsControl.contextProvider}
          contextWindow={actionsControl.contextWindow}
          sessionId={actionsControl.contextSessionId}
          size={16}
        />
      </span>
    );
  };
  const renderBtwButton = (className: string, menu = false) => {
    if (!visibility.btw || !actionsControl.btw) {
      return null;
    }
    return (
      <button
        type="button"
        className={className}
        {...toolbarControlMarker("btw")}
        onClick={actionsControl.btw.onClick}
        disabled={actionsControl.disabled || actionsControl.voiceDisabled}
        aria-label={actionsControl.btw.title}
        aria-pressed={actionsControl.btw.pressed}
        title={actionsControl.btw.title}
        role={menu ? "menuitem" : undefined}
      >
        /btw
      </button>
    );
  };
  const renderTranscriptSearchButton = (className: string, menu = false) => {
    if (!visibility.transcriptSearch) {
      return null;
    }
    return (
      <button
        type="button"
        className={className}
        {...toolbarControlMarker("transcriptSearch")}
        onClick={() => {
          setBottomOverflowOpen(false);
          requestSessionIsearchOpen();
        }}
        aria-label={t("toolbarTranscriptSearch")}
        aria-pressed={menu ? undefined : shortcutsControl.isearchScope !== null}
        title={t("toolbarTranscriptSearch")}
        role={menu ? "menuitem" : undefined}
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          aria-hidden="true"
        >
          <circle cx="11" cy="11" r="7" />
          <path d="M20 20l-4-4" />
        </svg>
      </button>
    );
  };
  const renderSteerNowToggle = (className: string) => {
    if (!canToggleSteerNow || !actionsControl.send) {
      return null;
    }
    return (
      <label
        className={className}
        title={t("toolbarSteerNowTooltip")}
        data-steer-now-toggle
        {...toolbarControlMarker("steerNow")}
      >
        <input
          type="checkbox"
          checked={!!actionsControl.send.steerNowEnabled}
          onChange={actionsControl.send.onToggleSteerNow}
          disabled={actionsControl.disabled}
          aria-label={t("toolbarSteerNowLabel")}
        />
        <span>{t("toolbarSteerNowShortLabel")}</span>
      </label>
    );
  };
  const renderTopicShiftButton = (menu = false) => {
    const topicShift = actionsControl.topicShift;
    if (
      !showTopicShiftButton ||
      !topicShift ||
      (menu && !isPriorityCollapsible("topicShift"))
    ) {
      return null;
    }
    return (
      <button
        type="button"
        {...toolbarControlMarker("topicShift")}
        onClick={topicShift.onTopicShift}
        disabled={actionsControl.disabled || topicShift.canSend === false}
        className={(menu ? menuTierClass : inlineTierClass)(
          "topicShift",
          actionStyles.sendButton,
          actionStyles.patientQueueAction,
        )}
        aria-label={t("toolbarTopicShiftLabel")}
        title={t("toolbarTopicShiftTooltip")}
        role={menu ? "menuitem" : undefined}
      >
        <DeliveryGlyph className={actionStyles.sendIcon}>↷</DeliveryGlyph>
      </button>
    );
  };
  const renderProjectQueueButtons = (menu = false) => {
    if (
      !showProjectQueueButton ||
      !actionsControl.projectQueue ||
      !actionsControl.send
    ) {
      return null;
    }
    const projectQueue = actionsControl.projectQueue;
    const disabled = actionsControl.disabled || !projectQueue.canSend;
    const openNewSessionOptions = projectQueue.onProjectQueueNewSessionOptions;
    const speechPrefix = actionsControl.send.speechMessagePrefix;
    const deliveryLabel = (label: string) =>
      speechPrefix
        ? t("speechPrefixDeliveryLabel", {
            action: label,
            prefix: speechPrefix,
          })
        : label;
    const deliveryTooltip = (tooltip: string | undefined) =>
      speechPrefix && tooltip
        ? t("speechPrefixDeliveryTooltip", {
            tooltip,
            prefix: speechPrefix,
          })
        : tooltip;
    const classNameFor = (
      key: "projectQueue" | "projectQueueNewSessionShortcut",
      ...extra: (string | undefined)[]
    ) =>
      (menu ? menuTierClass : inlineTierClass)(
        key,
        actionStyles.sendButton,
        actionStyles.projectQueueButton,
        ...extra,
      );
    return (
      <>
        {showCurrentSessionProjectQueueButton &&
          (!menu || isPriorityCollapsible("projectQueue")) && (
            <button
              type="button"
              {...toolbarControlMarker("projectQueue")}
              onClick={projectQueue.onProjectQueue}
              disabled={disabled}
              className={classNameFor("projectQueue")}
              data-project-queue-button
              aria-label={deliveryLabel(t("toolbarProjectQueueLabel"))}
              title={deliveryTooltip(projectQueue.tooltip)}
              role={menu ? "menuitem" : undefined}
            >
              <DeliveryGlyph className={actionStyles.sendIcon}>⇥</DeliveryGlyph>
              {speechPrefix && <SpeechPrefixActionCue prefix={speechPrefix} />}
            </button>
          )}
        {showNewSessionProjectQueueButton &&
          (!menu ||
            isPriorityCollapsible("projectQueueNewSessionShortcut")) && (
            <button
              type="button"
              {...toolbarControlMarker(
                "projectQueueNewSessionShortcut",
                !!openNewSessionOptions,
              )}
              onClick={() => {
                if (suppressNewSessionQueueClickRef.current) {
                  suppressNewSessionQueueClickRef.current = false;
                  return;
                }
                projectQueue.onProjectQueueNewSession?.();
              }}
              onContextMenu={
                openNewSessionOptions
                  ? (event) => {
                      event.preventDefault();
                      clearNewSessionOptionsLongPress();
                      openNewSessionOptions();
                    }
                  : undefined
              }
              onTouchStart={
                openNewSessionOptions
                  ? () => startNewSessionOptionsLongPress(openNewSessionOptions)
                  : undefined
              }
              onTouchEnd={clearNewSessionOptionsLongPress}
              onTouchCancel={clearNewSessionOptionsLongPress}
              onTouchMove={clearNewSessionOptionsLongPress}
              aria-haspopup={openNewSessionOptions ? "dialog" : undefined}
              disabled={disabled}
              className={classNameFor(
                "projectQueueNewSessionShortcut",
                actionStyles.projectQueueNewSessionButton,
              )}
              data-project-queue-new-session-button
              aria-label={deliveryLabel(
                t("toolbarProjectQueueNewSessionLabel"),
              )}
              title={deliveryTooltip(projectQueue.newSessionTooltip)}
              role={menu ? "menuitem" : undefined}
            >
              <DeliveryGlyph className={actionStyles.sendIcon}>⇥</DeliveryGlyph>
              <NewSessionQueueMark />
              {speechPrefix && <SpeechPrefixActionCue prefix={speechPrefix} />}
            </button>
          )}
      </>
    );
  };
  const hasBottomOverflowControls = !!(
    hasAsyncQuestions ||
    (visibility.modeSelector &&
      modeControl &&
      isPriorityCollapsible("modeSelector")) ||
    (visibility.attachments && isPriorityCollapsible("attachments")) ||
    (visibility.slashMenu &&
      slashControl &&
      isPriorityCollapsible("slashMenu")) ||
    (visibility.thinkingToggle &&
      thinkingControl &&
      isPriorityCollapsible("thinkingToggle")) ||
    (visibility.renderMode &&
      renderModeControl &&
      isPriorityCollapsible("renderMode")) ||
    (visibility.conversationView &&
      conversationViewControl &&
      isPriorityCollapsible("conversationView")) ||
    (visibility.browserDebug &&
      browserDebugControl &&
      isPriorityCollapsible("browserDebug")) ||
    (visibility.syntheticDone &&
      doneControl &&
      isPriorityCollapsible("syntheticDone")) ||
    (visibility.sessionStatus &&
      showToolbarStatus &&
      statusControl &&
      isPriorityCollapsible("sessionStatus")) ||
    (visibility.shortcutsHelp && isPriorityCollapsible("shortcutsHelp")) ||
    (visibility.transcriptSearch &&
      isPriorityCollapsible("transcriptSearch")) ||
    (visibility.contextUsage &&
      actionsControl.contextUsage &&
      isPriorityCollapsible("contextUsage")) ||
    (visibility.btw && actionsControl.btw && isPriorityCollapsible("btw")) ||
    (canToggleSteerNow && isPriorityCollapsible("steerNow")) ||
    (showTopicShiftButton && isPriorityCollapsible("topicShift")) ||
    (showCurrentSessionProjectQueueButton &&
      actionsControl.send &&
      isPriorityCollapsible("projectQueue")) ||
    (showNewSessionProjectQueueButton &&
      actionsControl.send &&
      isPriorityCollapsible("projectQueueNewSessionShortcut"))
  );
  const bottomOverflowLayoutKey = `${getComposerToolbarOverflowLayoutSignature({
    modeSelector:
      visibility.modeSelector && modeControl
        ? effectivePriority("modeSelector")
        : "off",
    attachments: visibility.attachments
      ? effectivePriority("attachments")
      : "off",
    slashMenu:
      visibility.slashMenu && slashControl
        ? effectivePriority("slashMenu")
        : "off",
    thinkingToggle:
      visibility.thinkingToggle && thinkingControl
        ? effectivePriority("thinkingToggle")
        : "off",
    renderMode:
      visibility.renderMode && renderModeControl
        ? effectivePriority("renderMode")
        : "off",
    conversationView:
      visibility.conversationView && conversationViewControl
        ? effectivePriority("conversationView")
        : "off",
    browserDebug:
      visibility.browserDebug && browserDebugControl
        ? effectivePriority("browserDebug")
        : "off",
    syntheticDone:
      visibility.syntheticDone && doneControl
        ? effectivePriority("syntheticDone")
        : "off",
    sessionStatus:
      visibility.sessionStatus && showToolbarStatus && statusControl
        ? effectivePriority("sessionStatus")
        : "off",
    shortcutsHelp: visibility.shortcutsHelp
      ? effectivePriority("shortcutsHelp")
      : "off",
    transcriptSearch: visibility.transcriptSearch
      ? effectivePriority("transcriptSearch")
      : "off",
    contextUsage:
      visibility.contextUsage && actionsControl.contextUsage
        ? effectivePriority("contextUsage")
        : "off",
    btw:
      visibility.btw && actionsControl.btw ? effectivePriority("btw") : "off",
    steerNow: canToggleSteerNow ? effectivePriority("steerNow") : "off",
    topicShift: showTopicShiftButton ? effectivePriority("topicShift") : "off",
    projectQueue:
      showCurrentSessionProjectQueueButton && actionsControl.send
        ? effectivePriority("projectQueue")
        : "off",
    projectQueueNewSessionShortcut:
      showNewSessionProjectQueueButton && actionsControl.send
        ? effectivePriority("projectQueueNewSessionShortcut")
        : "off",
    microphone:
      visibility.microphone &&
      selectedSpeechMethod &&
      speechControl?.voiceButton
        ? speechControl.voiceButton.kind
        : "off",
    waveform: speechWaveformActive,
    send: showSendButton ? actionsControl.send?.primaryActionKind : "off",
    queue:
      !hidePrimaryDeliveryActions && queueControl?.hasDualActions
        ? [
            actionsControl.send?.primaryActionKind,
            !!queueControl.onQueue,
            !!queueControl.onSteer,
          ].join(":")
        : "off",
    alternate: !hidePrimaryDeliveryActions && !!actionsControl.send?.alternate,
    stop: showStopButton,
    pending: pendingApproval?.type ?? "off",
  })}|fileViewer:${fileViewerController ? "on" : "off"}|questions:${hasAsyncQuestions}`;
  const [bottomOverflowOpen, setBottomOverflowOpen] = useState(false);
  const questionMenuWasOpen = useRef(false);
  useEffect(() => {
    if (questionMenuWasOpen.current && !asyncQuestions?.menuOpen)
      setBottomOverflowOpen(false);
    questionMenuWasOpen.current = asyncQuestions?.menuOpen === true;
  }, [asyncQuestions?.menuOpen]);
  const {
    tier: bottomOverflowTier,
    hiddenControls,
    setToolbarRef,
  } = useMeasuredComposerOverflow({
    layoutKey: bottomOverflowLayoutKey,
    hasControls: hasBottomOverflowControls,
    refs,
  });
  const showBottomOverflow =
    hasBottomOverflowControls &&
    (bottomOverflowTier !== "none" || hasAsyncQuestions);
  const shortcutsLongPressTimerRef = useRef<ReturnType<
    typeof setTimeout
  > | null>(null);
  const newSessionOptionsLongPressTimerRef = useRef<ReturnType<
    typeof setTimeout
  > | null>(null);
  // A long-press that opened the options must not also queue on release.
  const suppressNewSessionQueueClickRef = useRef(false);
  const clearNewSessionOptionsLongPress = () => {
    if (newSessionOptionsLongPressTimerRef.current) {
      clearTimeout(newSessionOptionsLongPressTimerRef.current);
      newSessionOptionsLongPressTimerRef.current = null;
    }
  };
  const startNewSessionOptionsLongPress = (open: () => void) => {
    clearNewSessionOptionsLongPress();
    suppressNewSessionQueueClickRef.current = false;
    newSessionOptionsLongPressTimerRef.current = setTimeout(() => {
      newSessionOptionsLongPressTimerRef.current = null;
      suppressNewSessionQueueClickRef.current = true;
      open();
    }, 520);
  };

  const openShortcutSettings = () => {
    shortcutsControl.setOpen(true);
    shortcutsControl.setSettingsOpen(true);
  };
  const clearShortcutsLongPress = () => {
    if (shortcutsLongPressTimerRef.current) {
      clearTimeout(shortcutsLongPressTimerRef.current);
      shortcutsLongPressTimerRef.current = null;
    }
  };
  const startShortcutsLongPress = () => {
    clearShortcutsLongPress();
    shortcutsLongPressTimerRef.current = setTimeout(() => {
      shortcutsLongPressTimerRef.current = null;
      openShortcutSettings();
    }, 520);
  };
  const coveringViewerOpen =
    fileViewerController &&
    !sessionViewerUsesRightPane(fileViewerController) &&
    !fileViewerController.minimized;
  const handleToolbarClickCapture = (event: MouseEvent<HTMLDivElement>) => {
    if (!coveringViewerOpen) return;
    if (!(event.target instanceof Element)) return;
    const action = event.target.closest(
      "button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), [role='button']:not([aria-disabled='true'])",
    );
    if (!action || !event.currentTarget.contains(action)) return;
    fileViewerController.minimize();
  };
  const handleToolbarTouchStartCapture = () => {
    lastTouchAtRef.current = Date.now();
  };
  const handleToolbarContextMenuCapture = (
    event: MouseEvent<HTMLDivElement>,
  ) => {
    if (!onHideControl || !(event.target instanceof Element)) return;
    if (event.target.closest('[data-attachment-menu="true"]')) return;
    const controlTarget = event.target.closest<HTMLElement>(
      "[data-session-toolbar-control]",
    );
    if (!controlTarget || !event.currentTarget.contains(controlTarget)) return;
    const nestedPopup = event.target.closest<HTMLElement>(
      '[role="dialog"], [role="menu"]',
    );
    if (nestedPopup && controlTarget.contains(nestedPopup)) return;

    const touch =
      Date.now() - lastTouchAtRef.current <=
      TOOLBAR_HIDE_TOUCH_CONTEXT_WINDOW_MS;
    const hasSpecialContextAction =
      controlTarget.dataset.sessionToolbarSpecialContext === "true";
    if (!touch && hasSpecialContextAction) return;

    if (!hasSpecialContextAction) {
      event.preventDefault();
      event.stopPropagation();
    }
    const key = controlTarget.dataset
      .sessionToolbarControl as SessionToolbarVisibilityKey;
    const target =
      event.target.closest<HTMLElement>(
        "button, input, label, [role='button']",
      ) ?? controlTarget;
    setHidePopover({
      key,
      target,
      tooltip: getToolbarControlTooltip(event.target, controlTarget),
      touch,
    });
  };

  return (
    <div
      ref={setToolbarRef}
      className={`${toolbarModuleStyles.messageInputToolbar}${applyStatusFloats ? ` ${toolbarModuleStyles.statusFloats}` : ""} overflow-tier-${bottomOverflowTier}${fileViewerController ? ` ${toolbarModuleStyles.fileViewerControllerActive}` : ""}${coveringViewerOpen ? ` ${toolbarModuleStyles.fileViewerOpen}` : ""}${waveformBackdropActive ? ` ${toolbarModuleStyles.waveformBackdropActive}` : ""}`}
      data-message-input-toolbar
      data-status-floats={applyStatusFloats || undefined}
      data-waveform-button-background-opacity={
        waveformBackdropActive
          ? normalizedWaveformButtonBackgroundOpacity
          : undefined
      }
      style={waveformBackdropStyle}
      onClickCapture={handleToolbarClickCapture}
      onContextMenuCapture={handleToolbarContextMenuCapture}
      onTouchStartCapture={handleToolbarTouchStartCapture}
    >
      <div
        className={`${toolbarModuleStyles.waveformRegion}${speechWaveformPreview ? ` ${toolbarModuleStyles.waveformPreviewRegion}` : ""}`}
      >
        <div
          ref={refs?.left}
          className={toolbarModuleStyles.messageInputLeft}
          data-message-input-left
        >
          {visibility.modeSelector && modeControl && (
            <span
              className={inlineTierClass("modeSelector")}
              {...toolbarControlMarker("modeSelector")}
            >
              <ModeSelector
                mode={modeControl.mode}
                onModeChange={modeControl.onModeChange}
                modes={modeControl.modes}
                changesApplyNextTurn={modeControl.changesApplyNextTurn}
                modeChangePending={modeControl.modeChangePending}
              />
            </span>
          )}
          {visibility.attachments && (
            <AttachmentButton
              className={inlineTierClass(
                "attachments",
                attachStyles.attachButton,
              )}
              onFiles={attachmentControl.onAttachClick}
              onMemo={attachmentControl.onRecordAudioMemo}
              onPanel={attachmentControl.onAttachmentPanel}
              onHide={
                onHideControl ? () => onHideControl("attachments") : undefined
              }
              disabled={!attachmentControl.canAttach}
              count={attachmentControl.attachmentCount}
            />
          )}
          {visibility.slashMenu && slashControl && (
            <span
              className={inlineTierClass("slashMenu")}
              {...toolbarControlMarker("slashMenu")}
            >
              <SlashCommandButton
                commands={slashControl.commands}
                onSelectCommand={slashControl.onSelectCommand}
                disabled={slashControl.disabled}
              />
            </span>
          )}
          {visibility.thinkingToggle && thinkingControl && (
            <span
              className={inlineTierClass("thinkingToggle")}
              {...toolbarControlMarker("thinkingToggle", true)}
            >
              <ThinkingToolbarControl control={thinkingControl} t={t} />
            </span>
          )}
          {visibility.renderMode && renderModeControl && (
            <button
              type="button"
              {...toolbarControlMarker("renderMode")}
              className={inlineTierClass(
                "renderMode",
                toolbarModuleStyles.renderModeToolbarButton,
                renderModeControl.state === "rendered"
                  ? toolbarModuleStyles["is-rendered"]
                  : renderModeControl.state === "mixed"
                    ? toolbarModuleStyles["is-mixed"]
                    : "",
              )}
              onClick={renderModeControl.onToggle}
              title={renderModeControl.title}
              aria-label={renderModeControl.title}
              aria-pressed={
                renderModeControl.state === "mixed"
                  ? "mixed"
                  : renderModeControl.state === "rendered"
              }
            >
              <RenderModeGlyph />
            </button>
          )}
          {visibility.conversationView && conversationViewControl && (
            <button
              type="button"
              {...toolbarControlMarker("conversationView")}
              data-conversation-view-toolbar-button
              className={inlineTierClass(
                "conversationView",
                toolbarModuleStyles.conversationViewToolbarButton,
                conversationViewControl.enabled
                  ? toolbarModuleStyles.active
                  : "",
              )}
              onClick={conversationViewControl.onToggle}
              title={conversationViewControl.title}
              aria-label={conversationViewControl.title}
              aria-pressed={conversationViewControl.enabled}
            >
              <ConversationViewIcon />
            </button>
          )}
          {visibility.browserDebug && browserDebugControl && (
            <LazyBrowserDebugToolbarButton
              t={t}
              control={browserDebugControl}
              dataAttributes={toolbarControlMarker("browserDebug", true)}
              className={[
                inlineTierClass("browserDebug"),
                toolbarModuleStyles.browserDebugButton,
                browserDebugControl.active
                  ? toolbarModuleStyles.browserDebugButtonActive
                  : "",
              ]
                .filter(Boolean)
                .join(" ")}
            />
          )}

          {visibility.syntheticDone && doneControl && (
            <button
              type="button"
              {...toolbarControlMarker("syntheticDone")}
              className={`${inlineTierClass("syntheticDone")} ${toolbarModuleStyles.doneButton}`}
              onClick={doneControl.onDone}
              title={doneControl.title}
              aria-label={doneControl.title}
              data-testid="synthetic-done-toolbar-button"
            >
              <ToolbarDoneIcon />
            </button>
          )}
          {visibility.microphone &&
            speechControl?.voiceButton?.kind === "preview" && (
              <SpeechControlMenu
                rootDataAttributes={toolbarControlMarker("microphone", true)}
                showMethodSelector={speechControl.showMethodSelector}
                methodOptions={speechControl.methodOptions}
                selectedMethod={selectedSpeechMethod}
                onMethodChange={speechControl.onMethodChange}
                smartTurnSettings={speechControl.smartTurnSettings}
                onSmartTurnSettingsChange={
                  speechControl.onSmartTurnSettingsChange
                }
                smartTurnDisabled={speechControl.smartTurnDisabled}
                trigger={
                  <button
                    type="button"
                    className={voiceStyles.voiceInputButton}
                    data-voice-input-button
                    disabled={speechControl.voiceButton.disabled}
                    title={t("voiceInputStart" as never)}
                    aria-label={t("voiceInputStartLabel" as never)}
                  >
                    <MicrophoneIcon />
                  </button>
                }
              />
            )}
          {visibility.microphone &&
            speechControl?.voiceButton?.kind === "live" &&
            speechControl.voiceButton.ref && (
              <SpeechControlMenu
                rootDataAttributes={toolbarControlMarker("microphone", true)}
                showMethodSelector={speechControl.showMethodSelector}
                methodOptions={speechControl.methodOptions}
                selectedMethod={selectedSpeechMethod}
                onMethodChange={speechControl.onMethodChange}
                smartTurnSettings={speechControl.smartTurnSettings}
                onSmartTurnSettingsChange={
                  speechControl.onSmartTurnSettingsChange
                }
                smartTurnDisabled={speechControl.smartTurnDisabled}
                onBeforeOpen={() => {
                  if (speechControl.voiceButton?.kind !== "live") return;
                  speechControl.voiceButton.onListeningStop?.();
                  speechControl.voiceButton.ref?.current?.stopAndFinalize();
                  speechControl.voiceButton.onInterimTranscript("");
                }}
                onBeforeCaptureChange={() => {
                  if (speechControl.voiceButton?.kind !== "live") return;
                  speechControl.voiceButton.onListeningStop?.();
                  speechControl.voiceButton.ref?.current?.stopAndFinalize();
                  speechControl.voiceButton.onInterimTranscript("");
                }}
                onPointerNearTrigger={() =>
                  speechControl.voiceButton?.kind === "live"
                    ? speechControl.voiceButton.ref?.current?.prewarm?.()
                    : undefined
                }
                trigger={
                  <VoiceInputButton
                    ref={speechControl.voiceButton.ref}
                    onTranscript={speechControl.voiceButton.onTranscript}
                    onInterimTranscript={
                      speechControl.voiceButton.onInterimTranscript
                    }
                    onListeningStart={
                      speechControl.voiceButton.onListeningStart
                    }
                    onListeningStop={speechControl.voiceButton.onListeningStop}
                    onPendingSpeechChange={
                      speechControl.voiceButton.onPendingSpeechChange
                    }
                    onTranscriptionSettled={
                      speechControl.voiceButton.onTranscriptionSettled
                    }
                    disabled={speechControl.voiceButton.disabled}
                    speechMethod={speechControl.voiceButton.speechMethod}
                    getTranscriptionContext={
                      speechControl.voiceButton.getTranscriptionContext
                    }
                    smartTurn={speechControl.voiceButton.smartTurn}
                    showWaveform={speechControl.voiceButton.showWaveform}
                  />
                }
              />
            )}
        </div>
        {fileViewerController && (
          <SessionViewerToolbarController
            controller={fileViewerController}
            t={t}
            waveformButtonBackgroundOpacityPercent={
              waveformBackdropActive
                ? normalizedWaveformButtonBackgroundOpacity
                : undefined
            }
          />
        )}
        {speechWaveformActive && (
          <SpeechWaveform preview={speechWaveformPreview} />
        )}
      </div>
      {renderStatusAges(
        visibility.sessionStatus
          ? inlineTierClass(
              "sessionStatus",
              toolbarModuleStyles.composerStatusAges,
            )
          : toolbarModuleStyles.composerStatusAges,
        refs?.status,
      )}
      {showBottomOverflow && (
        <div
          className={`${toolbarModuleStyles.overflow} ${toolbarModuleStyles.composerBottomOverflow} ${bottomOverflowOpen ? "is-open" : ""}`}
          data-composer-bottom-overflow
        >
          <button
            type="button"
            className={toolbarModuleStyles.composerBottomOverflowButton}
            aria-label={t("toolbarOverflowMenu")}
            aria-expanded={bottomOverflowOpen}
            onClick={() => setBottomOverflowOpen((open) => !open)}
          >
            ...
          </button>
          {bottomOverflowOpen && (
            <div
              className={toolbarModuleStyles.composerBottomOverflowMenu}
              data-composer-bottom-overflow-menu
              role="menu"
            >
              <div
                className={`${toolbarModuleStyles.composerBottomOverflowMenuGroup} ${toolbarModuleStyles.composerBottomOverflowMenuLeft}`}
                data-composer-bottom-overflow-menu-group
              >
                {visibility.modeSelector &&
                  modeControl &&
                  isPriorityCollapsible("modeSelector") && (
                    <span
                      className={menuTierClass("modeSelector")}
                      {...toolbarControlMarker("modeSelector")}
                    >
                      <ModeSelector
                        mode={modeControl.mode}
                        onModeChange={modeControl.onModeChange}
                        modes={modeControl.modes}
                        changesApplyNextTurn={modeControl.changesApplyNextTurn}
                        modeChangePending={modeControl.modeChangePending}
                      />
                    </span>
                  )}
                {visibility.attachments &&
                  isPriorityCollapsible("attachments") && (
                    <AttachmentButton
                      className={menuTierClass(
                        "attachments",
                        attachStyles.attachButton,
                      )}
                      onFiles={attachmentControl.onAttachClick}
                      onMemo={attachmentControl.onRecordAudioMemo}
                      onPanel={attachmentControl.onAttachmentPanel}
                      onHide={
                        onHideControl
                          ? () => onHideControl("attachments")
                          : undefined
                      }
                      disabled={!attachmentControl.canAttach}
                      count={attachmentControl.attachmentCount}
                    />
                  )}
                {visibility.sessionStatus &&
                  isPriorityCollapsible("sessionStatus") &&
                  renderStatusAges(
                    menuTierClass(
                      "sessionStatus",
                      toolbarModuleStyles.composerStatusAges,
                      "composer-status-ages--menu",
                    ),
                  )}
              </div>
              <div
                className={`${toolbarModuleStyles.composerBottomOverflowMenuGroup} ${toolbarModuleStyles.composerBottomOverflowMenuRight}`}
                data-composer-bottom-overflow-menu-group
              >
                {visibility.slashMenu &&
                  slashControl &&
                  isPriorityCollapsible("slashMenu") && (
                    <span
                      className={menuTierClass("slashMenu")}
                      {...toolbarControlMarker("slashMenu")}
                    >
                      <SlashCommandButton
                        commands={slashControl.commands}
                        onSelectCommand={slashControl.onSelectCommand}
                        disabled={slashControl.disabled}
                      />
                    </span>
                  )}
                {visibility.thinkingToggle &&
                  thinkingControl &&
                  isPriorityCollapsible("thinkingToggle") && (
                    <span
                      className={menuTierClass("thinkingToggle")}
                      {...toolbarControlMarker("thinkingToggle", true)}
                    >
                      <ThinkingToolbarControl control={thinkingControl} t={t} />
                    </span>
                  )}
                {visibility.renderMode &&
                  renderModeControl &&
                  isPriorityCollapsible("renderMode") && (
                    <button
                      type="button"
                      {...toolbarControlMarker("renderMode")}
                      className={menuTierClass(
                        "renderMode",
                        toolbarModuleStyles.renderModeToolbarButton,
                        renderModeControl.state === "rendered"
                          ? toolbarModuleStyles["is-rendered"]
                          : renderModeControl.state === "mixed"
                            ? toolbarModuleStyles["is-mixed"]
                            : "",
                      )}
                      onClick={renderModeControl.onToggle}
                      title={renderModeControl.title}
                      aria-label={renderModeControl.title}
                      role="menuitemcheckbox"
                      aria-checked={
                        renderModeControl.state === "mixed"
                          ? "mixed"
                          : renderModeControl.state === "rendered"
                      }
                    >
                      <RenderModeGlyph />
                    </button>
                  )}
                {visibility.conversationView &&
                  conversationViewControl &&
                  isPriorityCollapsible("conversationView") && (
                    <button
                      type="button"
                      {...toolbarControlMarker("conversationView")}
                      data-conversation-view-toolbar-button
                      className={menuTierClass(
                        "conversationView",
                        toolbarModuleStyles.conversationViewToolbarButton,
                        conversationViewControl.enabled
                          ? toolbarModuleStyles.active
                          : "",
                      )}
                      onClick={conversationViewControl.onToggle}
                      title={conversationViewControl.title}
                      aria-label={conversationViewControl.title}
                      role="menuitemcheckbox"
                      aria-checked={conversationViewControl.enabled}
                    >
                      <ConversationViewIcon />
                    </button>
                  )}
                {visibility.browserDebug &&
                  browserDebugControl &&
                  isPriorityCollapsible("browserDebug") && (
                    <LazyBrowserDebugToolbarButton
                      t={t}
                      control={browserDebugControl}
                      menuItem
                      dataAttributes={toolbarControlMarker(
                        "browserDebug",
                        true,
                      )}
                      className={[
                        menuTierClass("browserDebug"),
                        toolbarModuleStyles.browserDebugButton,
                        browserDebugControl.active
                          ? toolbarModuleStyles.browserDebugButtonActive
                          : "",
                      ]
                        .filter(Boolean)
                        .join(" ")}
                    />
                  )}

                {visibility.syntheticDone &&
                  doneControl &&
                  isPriorityCollapsible("syntheticDone") && (
                    <button
                      type="button"
                      {...toolbarControlMarker("syntheticDone")}
                      className={`${menuTierClass("syntheticDone")} ${toolbarModuleStyles.doneButton}`}
                      onClick={doneControl.onDone}
                      title={doneControl.title}
                      aria-label={doneControl.title}
                      role="menuitem"
                      data-testid="synthetic-done-overflow-button"
                    >
                      <ToolbarDoneIcon />
                    </button>
                  )}
                {isPriorityCollapsible("transcriptSearch") &&
                  renderTranscriptSearchButton(
                    `${menuTierClass("transcriptSearch")} ${toolbarModuleStyles.transcriptSearchButton}`,
                    true,
                  )}
                {visibility.shortcutsHelp &&
                  isPriorityCollapsible("shortcutsHelp") && (
                    <button
                      type="button"
                      {...toolbarControlMarker("shortcutsHelp", true)}
                      className={menuTierClass(
                        "shortcutsHelp",
                        toolbarModuleStyles.sessionShortcutsHelpButton,
                      )}
                      aria-label={t("toolbarKeyboardShortcutsAria")}
                      aria-expanded={shortcutsPopoverOpen}
                      onClick={() => shortcutsControl.setOpen((open) => !open)}
                      onContextMenu={(event) => {
                        event.preventDefault();
                        openShortcutSettings();
                      }}
                      onTouchStart={startShortcutsLongPress}
                      onTouchEnd={clearShortcutsLongPress}
                      onTouchCancel={clearShortcutsLongPress}
                      onTouchMove={clearShortcutsLongPress}
                      role="menuitem"
                    >
                      ?
                    </button>
                  )}
                {isPriorityCollapsible("contextUsage") &&
                  renderContextUsage(
                    menuTierClass(
                      "contextUsage",
                      toolbarModuleStyles.contextToolbarControl,
                    ),
                  )}
                {isPriorityCollapsible("btw") &&
                  renderBtwButton(
                    menuTierClass(
                      "btw",
                      toolbarModuleStyles.btwToolbarButton,
                      actionsControl.btw?.pressed
                        ? toolbarModuleStyles.active
                        : "",
                      actionsControl.btw?.mode === "focus-existing"
                        ? toolbarModuleStyles.hasAsides
                        : "",
                    ),
                    true,
                  )}
                {isPriorityCollapsible("steerNow") &&
                  renderSteerNowToggle(
                    menuTierClass("steerNow", actionStyles.steerNowToggle),
                  )}
                {renderTopicShiftButton(true)}
                {renderProjectQueueButtons(true)}
              </div>
              <AsyncQuestionsButton overflow />
            </div>
          )}
        </div>
      )}
      <div
        ref={refs?.actions}
        className={toolbarModuleStyles.messageInputActions}
        data-message-input-actions
      >
        <AsyncQuestionsButton compact={bottomOverflowTier} />
        {pendingApproval && (
          <button
            type="button"
            className={`${toolbarModuleStyles.pendingApprovalIndicator} ${pendingApproval.type}`}
            onClick={pendingApproval.onExpand}
            title={
              pendingApproval.type === "tool-approval"
                ? t("toolbarPendingApprovalExpand")
                : t("toolbarPendingQuestionExpand")
            }
          >
            <span className={toolbarModuleStyles.pendingApprovalDot} />
            <span className={toolbarModuleStyles.pendingApprovalText}>
              {pendingApproval.type === "tool-approval"
                ? t("toolbarApproval")
                : t("toolbarQuestion")}
            </span>
          </button>
        )}
        {renderTranscriptSearchButton(
          `${inlineTierClass("transcriptSearch")} ${toolbarModuleStyles.transcriptSearchButton}`,
        )}
        {visibility.shortcutsHelp && (
          // biome-ignore lint/a11y/noStaticElementInteractions: pointer leave only hides the adjacent shortcuts popover
          <div
            className={inlineTierClass(
              "shortcutsHelp",
              toolbarModuleStyles.sessionShortcutsHelp,
            )}
            onMouseLeave={() => {
              shortcutsControl.setOpen(false);
              shortcutsControl.setSettingsOpen(false);
            }}
          >
            <button
              type="button"
              className={toolbarModuleStyles.sessionShortcutsHelpButton}
              {...toolbarControlMarker("shortcutsHelp", true)}
              aria-label={t("toolbarKeyboardShortcutsAria")}
              aria-expanded={shortcutsPopoverOpen}
              onClick={() => shortcutsControl.setOpen((open) => !open)}
              onContextMenu={(event) => {
                event.preventDefault();
                openShortcutSettings();
              }}
              onFocus={() => shortcutsControl.setOpen(true)}
              onBlur={(event) => {
                if (
                  !event.currentTarget.parentElement?.contains(
                    event.relatedTarget as Node | null,
                  )
                ) {
                  shortcutsControl.setOpen(false);
                }
              }}
              onMouseEnter={() => shortcutsControl.setOpen(true)}
              onTouchStart={startShortcutsLongPress}
              onTouchEnd={clearShortcutsLongPress}
              onTouchCancel={clearShortcutsLongPress}
              onTouchMove={clearShortcutsLongPress}
            >
              ?
            </button>
            {shortcutsPopoverOpen && (
              <div
                className={`${toolbarModuleStyles.sessionShortcutsPopover} ${shortcutsControl.isearchScope !== null ? toolbarModuleStyles["is-isearch-guide"] : ""}`}
                role="dialog"
                aria-label={t("toolbarKeyboardShortcutsAria")}
              >
                {shortcutsControl.isearchScope !== null ? (
                  <>
                    <div
                      className={toolbarModuleStyles.sessionShortcutsRow}
                      data-session-shortcuts-row
                    >
                      <span
                        className={toolbarModuleStyles.sessionShortcutsKeys}
                      >
                        {getIsearchPreviousKeys(
                          shortcutsControl.isearchScope,
                        ).map((key) => (
                          <kbd key={key}>{key}</kbd>
                        ))}
                        {shortcutsControl.isearchScope === "user" && (
                          <>
                            <span>{t("commonOr")}</span>
                            <kbd>Ctrl</kbd>
                            <kbd>Alt</kbd>
                            <kbd>R</kbd>
                          </>
                        )}
                      </span>
                      <span>{t("toolbarShortcutPreviousMatch")}</span>
                    </div>
                    <div
                      className={toolbarModuleStyles.sessionShortcutsRow}
                      data-session-shortcuts-row
                    >
                      <span
                        className={toolbarModuleStyles.sessionShortcutsKeys}
                      >
                        <kbd>Enter</kbd>
                      </span>
                      <span>{t("toolbarShortcutJump")}</span>
                    </div>
                    <div
                      className={toolbarModuleStyles.sessionShortcutsRow}
                      data-session-shortcuts-row
                    >
                      <span
                        className={toolbarModuleStyles.sessionShortcutsKeys}
                      >
                        <kbd>↑</kbd>
                        <kbd>↓</kbd>
                      </span>
                      <span>{t("toolbarShortcutPreviousNextMatch")}</span>
                    </div>
                    <div
                      className={toolbarModuleStyles.sessionShortcutsRow}
                      data-session-shortcuts-row
                    >
                      <span
                        className={toolbarModuleStyles.sessionShortcutsKeys}
                      >
                        {t("toolbarShortcutClick")}
                      </span>
                      <span>{t("toolbarShortcutPreviewRailJumps")}</span>
                    </div>
                    <div
                      className={toolbarModuleStyles.sessionShortcutsRow}
                      data-session-shortcuts-row
                    >
                      <span
                        className={toolbarModuleStyles.sessionShortcutsKeys}
                      >
                        <kbd>Esc</kbd>
                      </span>
                      <span>{t("toolbarShortcutCancelRestoreFocus")}</span>
                    </div>
                    <div
                      className={toolbarModuleStyles.sessionShortcutsRow}
                      data-session-shortcuts-row
                    >
                      <span
                        className={toolbarModuleStyles.sessionShortcutsKeys}
                      >
                        <kbd>Ctrl</kbd>
                        <kbd>End</kbd>
                      </span>
                      <span>{t("toolbarShortcutScrollToCurrent")}</span>
                    </div>
                    {getIsearchAlternateRows(
                      shortcutsControl.isearchScope,
                      t,
                    ).map((row) => (
                      <div
                        key={row.label}
                        className={toolbarModuleStyles.sessionShortcutsRow}
                        data-session-shortcuts-row
                      >
                        <span
                          className={toolbarModuleStyles.sessionShortcutsKeys}
                        >
                          {row.keys.map((key) => (
                            <kbd key={key}>{key}</kbd>
                          ))}
                          {row.scope === "user" && (
                            <>
                              <span>{t("commonOr")}</span>
                              <kbd>Ctrl</kbd>
                              <kbd>Alt</kbd>
                              <kbd>R</kbd>
                            </>
                          )}
                        </span>
                        <span>{row.label}</span>
                      </div>
                    ))}
                  </>
                ) : (
                  <>
                    <div
                      className={toolbarModuleStyles.sessionShortcutsRow}
                      data-session-shortcuts-row
                    >
                      <span
                        className={toolbarModuleStyles.sessionShortcutsKeys}
                      >
                        <kbd>Ctrl</kbd>
                        <kbd>R</kbd>
                        <span>{t("commonOr")}</span>
                        <kbd>Ctrl</kbd>
                        <kbd>Alt</kbd>
                        <kbd>R</kbd>
                      </span>
                      <span>{t("toolbarShortcutUserTurnReverseSearch")}</span>
                    </div>
                    <div
                      className={toolbarModuleStyles.sessionShortcutsRow}
                      data-session-shortcuts-row
                    >
                      <span
                        className={toolbarModuleStyles.sessionShortcutsKeys}
                      >
                        <kbd>Ctrl</kbd>
                        <kbd>S</kbd>
                      </span>
                      <span>{t("toolbarShortcutAllTurnReverseSearch")}</span>
                    </div>
                    <div
                      className={toolbarModuleStyles.sessionShortcutsRow}
                      data-session-shortcuts-row
                    >
                      <span
                        className={toolbarModuleStyles.sessionShortcutsKeys}
                      >
                        <kbd>Ctrl</kbd>
                        <kbd>Alt</kbd>
                        <kbd>S</kbd>
                      </span>
                      <span>
                        {t("toolbarShortcutFullSessionReverseSearch")}
                      </span>
                    </div>
                    <div
                      className={toolbarModuleStyles.sessionShortcutsRow}
                      data-session-shortcuts-row
                    >
                      <span
                        className={toolbarModuleStyles.sessionShortcutsKeys}
                      >
                        <kbd>Ctrl</kbd>
                        <kbd>Alt</kbd>
                        <kbd>K</kbd>
                      </span>
                      <span>{t("toolbarShortcutLinkReverseSearch")}</span>
                    </div>
                    <div
                      className={toolbarModuleStyles.sessionShortcutsRow}
                      data-session-shortcuts-row
                    >
                      <span
                        className={toolbarModuleStyles.sessionShortcutsKeys}
                      >
                        <kbd>Enter</kbd>
                      </span>
                      <span>
                        {shortcutsControl.hasDualActions
                          ? t("toolbarShortcutSteerCurrentTurn")
                          : t("toolbarShortcutSend")}
                      </span>
                    </div>
                    <div
                      className={toolbarModuleStyles.sessionShortcutsRow}
                      data-session-shortcuts-row
                    >
                      <span
                        className={toolbarModuleStyles.sessionShortcutsKeys}
                      >
                        <kbd>Shift</kbd>
                        <kbd>Enter</kbd>
                      </span>
                      <span>{t("toolbarShortcutNewLine")}</span>
                    </div>
                    <div
                      className={toolbarModuleStyles.sessionShortcutsRow}
                      data-session-shortcuts-row
                    >
                      <span
                        className={toolbarModuleStyles.sessionShortcutsKeys}
                      >
                        <kbd>Ctrl</kbd>
                        <kbd>Enter</kbd>
                      </span>
                      <span>{shortcutsControl.queueShortcutLabel}</span>
                    </div>
                    {shortcutsControl.canForkAfterSummary && (
                      <div
                        className={toolbarModuleStyles.sessionShortcutsRow}
                        data-session-shortcuts-row
                      >
                        <span
                          className={toolbarModuleStyles.sessionShortcutsKeys}
                        >
                          <kbd>Ctrl</kbd>
                          <kbd>Alt</kbd>
                          <kbd>Enter</kbd>
                        </span>
                        <span>{t("toolbarShortcutForkAfterSummary")}</span>
                      </div>
                    )}
                    {shortcutSettings && (
                      <div
                        className={`${toolbarModuleStyles.sessionShortcutsRow} ${toolbarModuleStyles.sessionShortcutsRowMuted}`}
                        data-session-shortcuts-row
                      >
                        <span
                          className={toolbarModuleStyles.sessionShortcutsKeys}
                        >
                          {t("toolbarShortcutRightClickLongPress")}
                        </span>
                        <span>{t("toolbarShortcutChangeKeys")}</span>
                      </div>
                    )}
                    {shortcutsControl.settingsOpen && shortcutSettings && (
                      <div
                        className={toolbarModuleStyles.sessionShortcutsSettings}
                      >
                        <div
                          className={toolbarModuleStyles.sessionShortcutsRow}
                          data-session-shortcuts-row
                        >
                          <span
                            className={toolbarModuleStyles.sessionShortcutsKeys}
                          >
                            <kbd>Enter</kbd>
                          </span>
                          <span>
                            {shortcutsControl.enterActionKind === "queue"
                              ? t("toolbarShortcutQueueCurrentTurn")
                              : t("toolbarShortcutSteerCurrentTurn")}
                          </span>
                        </div>
                        <button
                          type="button"
                          className={toolbarModuleStyles.sessionShortcutsAction}
                          onClick={shortcutSettings.onSwapEnterAction}
                        >
                          {t("toolbarShortcutSwapEnterCtrlEnter")}
                        </button>
                      </div>
                    )}
                    <div
                      className={toolbarModuleStyles.sessionShortcutsRow}
                      data-session-shortcuts-row
                    >
                      <span
                        className={toolbarModuleStyles.sessionShortcutsKeys}
                      >
                        <kbd>Ctrl</kbd>
                        <kbd>B</kbd>
                      </span>
                      <span>{t("toolbarShortcutStartBtwAside")}</span>
                    </div>
                    <div
                      className={toolbarModuleStyles.sessionShortcutsRow}
                      data-session-shortcuts-row
                    >
                      <span
                        className={toolbarModuleStyles.sessionShortcutsKeys}
                      >
                        <kbd>Esc</kbd>
                      </span>
                      <span>
                        {t(
                          escapeInterruptDisabled
                            ? "toolbarShortcutCancelOverlay"
                            : "toolbarShortcutStopAgentCancelOverlay",
                        )}
                      </span>
                    </div>
                    <div
                      className={toolbarModuleStyles.sessionShortcutsRow}
                      data-session-shortcuts-row
                    >
                      <span
                        className={toolbarModuleStyles.sessionShortcutsKeys}
                      >
                        <kbd>Ctrl</kbd>
                        <kbd>P</kbd>
                      </span>
                      <span>{t("toolbarShortcutRecallLastSentText")}</span>
                    </div>
                    <div
                      className={toolbarModuleStyles.sessionShortcutsRow}
                      data-session-shortcuts-row
                    >
                      <span
                        className={toolbarModuleStyles.sessionShortcutsKeys}
                      >
                        <kbd>Ctrl</kbd>
                        <kbd>K</kbd>
                      </span>
                      <span>
                        {t("toolbarShortcutCancelLatestQueuedMessage")}
                      </span>
                    </div>
                    <div
                      className={toolbarModuleStyles.sessionShortcutsRow}
                      data-session-shortcuts-row
                    >
                      <span
                        className={toolbarModuleStyles.sessionShortcutsKeys}
                      >
                        <kbd>Ctrl</kbd>
                        <kbd>O</kbd>
                      </span>
                      <span>
                        {t("toolbarShortcutToggleThinkingTranscript")}
                      </span>
                    </div>
                    <div
                      className={toolbarModuleStyles.sessionShortcutsRow}
                      data-session-shortcuts-row
                    >
                      <span
                        className={toolbarModuleStyles.sessionShortcutsKeys}
                      >
                        <kbd>Ctrl</kbd>
                        <kbd>End</kbd>
                      </span>
                      <span>{t("toolbarShortcutScrollToCurrent")}</span>
                    </div>
                    <div
                      className={toolbarModuleStyles.sessionShortcutsRow}
                      data-session-shortcuts-row
                    >
                      <span
                        className={toolbarModuleStyles.sessionShortcutsKeys}
                      >
                        <kbd>Ctrl</kbd>
                        <kbd>G</kbd>
                      </span>
                      <span>{t("toolbarShortcutClearComposer")}</span>
                    </div>
                    <div
                      className={toolbarModuleStyles.sessionShortcutsRow}
                      data-session-shortcuts-row
                    >
                      <span
                        className={toolbarModuleStyles.sessionShortcutsKeys}
                      >
                        <kbd>Ctrl</kbd>
                        <kbd>U</kbd>
                      </span>
                      <span>{t("toolbarShortcutFullPaneComposer")}</span>
                    </div>
                    <div
                      className={toolbarModuleStyles.sessionShortcutsRow}
                      data-session-shortcuts-row
                    >
                      <span
                        className={toolbarModuleStyles.sessionShortcutsKeys}
                      >
                        <kbd>Ctrl</kbd>
                        <kbd>Shift</kbd>
                        <kbd>M</kbd>
                      </span>
                      <span>{t("toolbarShortcutRenderedSourceMode")}</span>
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
        )}
        {renderContextUsage(
          inlineTierClass(
            "contextUsage",
            toolbarModuleStyles.contextToolbarControl,
          ),
        )}
        {renderBtwButton(
          inlineTierClass(
            "btw",
            toolbarModuleStyles.btwToolbarButton,
            actionsControl.btw?.pressed ? toolbarModuleStyles.active : "",
            actionsControl.btw?.mode === "focus-existing"
              ? toolbarModuleStyles.hasAsides
              : "",
          ),
        )}
        {showStopButton && actionsControl.stop && (
          <button
            type="button"
            {...stopMenu.targetProps(
              [
                {
                  label: t(
                    escapeInterruptDisabled
                      ? "toolbarEnableEscInterrupt"
                      : "toolbarDisableEscInterrupt",
                  ),
                  onSelect: () =>
                    setEscapeInterruptDisabled(!escapeInterruptDisabled),
                },
              ],
              actionsControl.stop.onStop,
            )}
            className={actionStyles.stopButton}
            aria-label={t("toolbarStop")}
            aria-haspopup="menu"
            title={`${t("toolbarStop")}${escapeInterruptDisabled ? "" : " (Esc)"} — ${t("toolbarStopOptionsHint")}`}
          >
            <span className={actionStyles.stopIcon} />
          </button>
        )}
        {showActionsControl && actionsControl.send ? (
          <>
            {renderSteerNowToggle(
              inlineTierClass("steerNow", actionStyles.steerNowToggle),
            )}
            {!hidePrimaryDeliveryActions &&
              queueControl?.hasDualActions &&
              actionsControl.send.primaryActionKind !== "queue" &&
              queueControl.onQueue && (
                <button
                  type="button"
                  onClick={queueControl.onQueue}
                  disabled={
                    actionsControl.disabled || !actionsControl.send.canSend
                  }
                  className={`${actionStyles.sendButton} ${actionStyles.queueButton}`}
                  data-send-button
                  aria-label={
                    actionsControl.send.speechMessagePrefix
                      ? t("speechPrefixDeliveryLabel", {
                          action: t("toolbarQueueLabel"),
                          prefix: actionsControl.send.speechMessagePrefix,
                        })
                      : t("toolbarQueueLabel")
                  }
                  title={
                    actionsControl.send.speechMessagePrefix
                      ? t("speechPrefixDeliveryTooltip", {
                          tooltip: queueControl.queueTooltip,
                          prefix: actionsControl.send.speechMessagePrefix,
                        })
                      : queueControl.queueTooltip
                  }
                >
                  <DeliveryGlyph
                    className={`${actionStyles.sendIcon} queue-icon`}
                  >
                    →
                  </DeliveryGlyph>
                  {actionsControl.send.speechMessagePrefix && (
                    <SpeechPrefixActionCue
                      prefix={actionsControl.send.speechMessagePrefix}
                    />
                  )}
                </button>
              )}
            {!hidePrimaryDeliveryActions &&
              queueControl?.hasDualActions &&
              actionsControl.send.primaryActionKind === "queue" &&
              queueControl.onSteer && (
                <button
                  type="button"
                  onClick={queueControl.onSteer}
                  disabled={
                    actionsControl.disabled || !actionsControl.send.canSend
                  }
                  className={`${actionStyles.sendButton} steer-button`}
                  data-send-button
                  aria-label={
                    actionsControl.send.speechMessagePrefix
                      ? t("speechPrefixDeliveryLabel", {
                          action: t("toolbarSteerTooltip"),
                          prefix: actionsControl.send.speechMessagePrefix,
                        })
                      : t("toolbarSteerTooltip")
                  }
                  title={
                    actionsControl.send.speechMessagePrefix
                      ? t("speechPrefixDeliveryTooltip", {
                          tooltip: t("toolbarSteerTooltip"),
                          prefix: actionsControl.send.speechMessagePrefix,
                        })
                      : t("toolbarSteerTooltip")
                  }
                >
                  <DeliveryGlyph className={actionStyles.sendIcon}>
                    ↗
                  </DeliveryGlyph>
                  {actionsControl.send.speechMessagePrefix && (
                    <SpeechPrefixActionCue
                      prefix={actionsControl.send.speechMessagePrefix}
                    />
                  )}
                </button>
              )}
            {!hidePrimaryDeliveryActions && actionsControl.send.alternate && (
              <button
                type="button"
                onClick={actionsControl.send.alternate.onClick}
                disabled={
                  actionsControl.disabled || !actionsControl.send.canSend
                }
                className={`${actionStyles.sendButton} fork-summary-no-summary-button`}
                data-send-button
                aria-label={
                  actionsControl.send.speechMessagePrefix
                    ? t("speechPrefixDeliveryLabel", {
                        action: actionsControl.send.alternate.label,
                        prefix: actionsControl.send.speechMessagePrefix,
                      })
                    : actionsControl.send.alternate.label
                }
                title={
                  actionsControl.send.speechMessagePrefix
                    ? t("speechPrefixDeliveryTooltip", {
                        tooltip: actionsControl.send.alternate.tooltip,
                        prefix: actionsControl.send.speechMessagePrefix,
                      })
                    : actionsControl.send.alternate.tooltip
                }
              >
                <DeliveryGlyph className={actionStyles.sendIcon}>
                  {actionsControl.send.alternate.icon}
                </DeliveryGlyph>
                {actionsControl.send.speechMessagePrefix && (
                  <SpeechPrefixActionCue
                    prefix={actionsControl.send.speechMessagePrefix}
                  />
                )}
              </button>
            )}
            {renderTopicShiftButton()}
            {renderProjectQueueButtons()}
            {showSendButton && (
              <button
                type="button"
                onClick={actionsControl.send?.onSend}
                onContextMenu={
                  actionsControl.send.onSendOptions
                    ? (event) => {
                        event.preventDefault();
                        actionsControl.send?.onSendOptions?.();
                      }
                    : undefined
                }
                disabled={
                  actionsControl.disabled || !actionsControl.send.canSend
                }
                className={`${actionStyles.sendButton} send-button-with-help ${actionsControl.send.primaryActionKind === "queue" ? actionStyles.queueMode : ""}`}
                data-send-button
                data-queue-mode={
                  actionsControl.send.primaryActionKind === "queue" || undefined
                }
                aria-label={
                  actionsControl.send.primarySpeechMessagePrefix
                    ? t("speechPrefixDeliveryLabel", {
                        action: actionsControl.send.primaryActionLabel,
                        prefix: actionsControl.send.primarySpeechMessagePrefix,
                      })
                    : actionsControl.send.primaryActionLabel
                }
                {...getTextTooltipAttributes(
                  actionsControl.send.primarySpeechMessagePrefix
                    ? t("speechPrefixDeliveryTooltip", {
                        tooltip: actionsControl.send.tooltip,
                        prefix: actionsControl.send.primarySpeechMessagePrefix,
                      })
                    : actionsControl.send.tooltip,
                  tooltipMode,
                )}
              >
                <DeliveryGlyph className={actionStyles.sendIcon}>
                  {actionsControl.send.icon}
                </DeliveryGlyph>
                {actionsControl.send.primarySpeechMessagePrefix && (
                  <SpeechPrefixActionCue
                    prefix={actionsControl.send.primarySpeechMessagePrefix}
                  />
                )}
              </button>
            )}
          </>
        ) : null}
      </div>
      {stopMenu.menu}
      {hidePopover && onHideControl && (
        <ToolbarHidePopover
          state={hidePopover}
          t={t}
          onClose={closeHidePopover}
          onHide={onHideControl}
        />
      )}
    </div>
  );
}

export function MessageInputToolbar({
  onAttachmentPanel,
  onRecordAudioMemo,
  sessionId,
  mode = "default",
  onModeChange,
  modeChangesApplyNextTurn,
  modeChangePending,
  supportsPermissionMode = true,
  supportsThinkingToggle = true,
  canAttach,
  attachmentCount = 0,
  onAttachClick,
  voiceButtonRef,
  onVoiceTranscript,
  onInterimTranscript,
  onListeningStart,
  onListeningStop,
  onPendingSpeechChange,
  onTranscriptionSettled,
  voiceDisabled,
  getTranscriptionContext,
  slashCommands = [],
  onSelectSlashCommand,
  onBtwClick,
  btwActive = false,
  btwHasAsides = false,
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
  showSteerNowMode = false,
  steerNowEnabled = false,
  onToggleSteerNow,
  enterActionKind,
  canSwapEnterAction = false,
  onSwapEnterAction,
  isRunning,
  isThinking,
  onStop,
  onDone,
  doneTitle,
  onSend,
  onQueue,
  onProjectQueue,
  onProjectQueueNewSession,
  onProjectQueueNewSessionOptions,
  onTopicShift,
  onSendOptions,
  onSteer,
  primaryActionKind,
  sendOverride,
  sendAlternate,
  canForkAfterSummary,
  canSend,
  speechMessagePrefix,
  primarySpeechMessagePrefix,
  disabled,
  hidePrimaryDeliveryActions = false,
  hideVoiceInput = false,
  pendingApproval,
}: MessageInputToolbarProps) {
  const { t } = useI18n();
  const showToast = useOptionalToastContext()?.showToast;
  const sessionViewerController = useSessionViewerController();
  const fileViewerController =
    sessionViewerController?.sessionId === (sessionId ?? "") &&
    sessionViewerShowsBottomController(sessionViewerController)
      ? sessionViewerController
      : null;
  const {
    thinkingMode,
    thinkingLevel,
    setThinkingMode,
    setEffortLevel,
    showThinking = "default",
    setShowThinking,
    voiceInputEnabled = true,
    speechMethod = "browser-native",
    hasStoredSpeechMethod = false,
    setSpeechMethod,
    speechSmartTurnSettings,
    setSpeechSmartTurnSettings,
  } = useModelSettings();
  const { version: versionInfo } = useVersion();
  const browserDebugLease = useBrowserDebugLease();
  const { relayTransport, relayedServerSpeechAvailable } =
    useSpeechSourceRuntime();

  const supportsBrowserDebug = serverHasCapability(
    versionInfo,
    REMOTE_BROWSER_DIAGNOSTICS_CAPABILITY,
  );
  const { providers } = useProviders();
  const {
    visibility: toolbarVisibility,
    priority: toolbarPriority,
    setControlPresence,
  } = useSessionToolbarPresence();
  const hideToolbarControl = useCallback(
    (key: SessionToolbarVisibilityKey) => setControlPresence(key, "hidden"),
    [setControlPresence],
  );
  const { waveformButtonBackgroundOpacityPercent } =
    useWaveformButtonBackgroundOpacity();
  const { conversationViewEnabled, setConversationViewEnabled } =
    useConversationView();
  const renderMode = useOptionalRenderModeContext();
  const nowMs = useRelativeNow();
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [shortcutSettingsOpen, setShortcutSettingsOpen] = useState(false);
  const [isearchScope, setIsearchScope] = useState<SessionIsearchScope | null>(
    null,
  );
  const [speechCaptureActive, setSpeechCaptureActive] = useState(false);
  const lastNonOffThinkingModeRef =
    useRef<Exclude<ThinkingMode, "off">>("auto");
  const toolbarRef = useRef<HTMLDivElement | null>(null);
  const toolbarLeftRef = useRef<HTMLDivElement | null>(null);
  const toolbarStatusRef = useRef<HTMLDivElement | null>(null);
  const toolbarActionsRef = useRef<HTMLDivElement | null>(null);
  const selectedThinkingMode = liveThinkingSelection?.mode ?? thinkingMode;
  const selectedThinkingLevel = liveThinkingSelection?.level ?? thinkingLevel;
  const setSelectedThinkingMode =
    liveThinkingSelection?.onSetMode ?? setThinkingMode;
  const setSelectedEffortLevel =
    liveThinkingSelection?.onSetEffort ?? setEffortLevel;
  const [isCompactStatusMode, setIsCompactStatusMode] = useState(() =>
    typeof window === "undefined"
      ? false
      : (getCompactStatusMatchMedia()?.matches ?? false),
  );
  const normalizedThinkingProvider = useMemo(
    () => normalizeProviderKey(thinkingProvider),
    [thinkingProvider],
  );
  const thinkingProviderInfo = useMemo(
    () =>
      providers.find(
        (provider) => provider.name === normalizedThinkingProvider,
      ) ?? null,
    [normalizedThinkingProvider, providers],
  );
  const thinkingModelInfo = useMemo<ModelInfo | null>(
    () =>
      thinkingProviderInfo?.models?.find(
        (model) => model.id === thinkingModel,
      ) ?? null,
    [thinkingModel, thinkingProviderInfo],
  );
  const thinkingEffortOptions = useMemo(
    () =>
      getEffortLevelOptions({
        provider:
          thinkingProviderInfo ?? (normalizedThinkingProvider as ProviderName),
        model: thinkingModelInfo ?? thinkingModel,
        translate: t,
      }),
    [
      thinkingModel,
      thinkingModelInfo,
      thinkingProviderInfo,
      normalizedThinkingProvider,
      t,
    ],
  );
  const effectiveThinkingLevel = useMemo(
    () =>
      resolveSupportedEffortLevel(selectedThinkingLevel, thinkingEffortOptions),
    [selectedThinkingLevel, thinkingEffortOptions],
  );
  const thinkingModeOptions = useMemo(
    () =>
      getThinkingModeOptions({
        provider:
          thinkingProviderInfo ?? (normalizedThinkingProvider as ProviderName),
        model: thinkingModelInfo ?? thinkingModel,
        effortOptions: thinkingEffortOptions,
      }),
    [
      thinkingEffortOptions,
      thinkingModel,
      thinkingModelInfo,
      thinkingProviderInfo,
      normalizedThinkingProvider,
    ],
  );
  const effectiveThinkingMode = useMemo(
    () =>
      resolveSupportedThinkingMode(selectedThinkingMode, thinkingModeOptions),
    [selectedThinkingMode, thinkingModeOptions],
  );
  const permissionModeOptions = useMemo(
    () =>
      getPermissionModeOptions({
        model: thinkingModelInfo,
        currentMode: mode,
      }),
    [mode, thinkingModelInfo],
  );
  const hasThinkingModeOptions = thinkingModeOptions.some(
    (option) => option !== "off",
  );
  const lastActivityMs = parseTimestampMs(lastActivityAt);
  const showLastActivityAge = isStaleTimestamp(lastActivityMs, nowMs);
  const lastActivityAgeMs =
    lastActivityMs === null ? null : nowMs - lastActivityMs;
  // Keep the long "Last activity 35m" prefix exclusive to the inline row.
  const statusFloats = isCompactStatusMode || !toolbarVisibility.sessionStatus;
  const showLastActivityPrefix =
    showLastActivityAge &&
    !statusFloats &&
    lastActivityAgeMs !== null &&
    lastActivityAgeMs >= LAST_ACTIVITY_TEXT_PREFIX_THRESHOLD_MS;
  const lastActivityIsPast =
    showLastActivityAge &&
    !showLastActivityPrefix &&
    lastActivityMs !== null &&
    formatCompactRelativeAge(lastActivityMs, nowMs) !== "now";
  const storedPositionTimestampMs = useSyncExternalStore(
    positionTimestampStore?.subscribe ?? subscribeToNoPositionStore,
    positionTimestampStore?.getSnapshot ?? getNoPositionSnapshot,
    positionTimestampStore?.getSnapshot ?? getNoPositionSnapshot,
  );
  const effectivePositionTimestampMs = positionTimestampStore
    ? storedPositionTimestampMs
    : positionTimestampMs;
  const positionAgeLabel =
    effectivePositionTimestampMs === null ||
    effectivePositionTimestampMs === undefined
      ? null
      : formatCompactRelativeAge(effectivePositionTimestampMs, nowMs);
  const lastActivityAgeLabel =
    lastActivityMs === null
      ? null
      : formatCompactRelativeAge(lastActivityMs, nowMs);
  // Age *content* independent of the sessionStatus toggle. The compact
  // "float over the composer" presentation reuses these so width-constrained
  // clients (mobile defaults sessionStatus off) still get the ages; the
  // sessionStatus toggle gates only the inline row + liveness chip.
  // "at N ago" stays follow-mode-safe: positionTimestampMs is null at the
  // scroll bottom (MessageList), so hasPositionAge is false in follow mode.
  // A current position ("now") always counts as duplicating the session
  // freshness, even when the freshness label is missing or suppressed as
  // current, so it never earns a chip.
  const hasPositionAge =
    effectivePositionTimestampMs !== null &&
    effectivePositionTimestampMs !== undefined &&
    positionAgeLabel !== null &&
    positionAgeLabel !== "now" &&
    positionAgeLabel !== lastActivityAgeLabel;
  const showPositionTimestamp =
    toolbarVisibility.sessionStatus && hasPositionAge;
  const livenessDisplay = sessionLiveness
    ? describeSessionLiveness(sessionLiveness, t)
    : null;
  const providerRuntimeDisplay = describeProviderRuntimeStatus(
    providerRuntimeStatus ?? null,
    t,
  );
  const showLivenessChip =
    toolbarVisibility.sessionStatus &&
    !providerRuntimeDisplay &&
    !!livenessDisplay &&
    !(
      showLastActivityAge &&
      (isCompactStatusMode ||
        livenessDisplay.tone === "ok" ||
        livenessDisplay.tone === "muted")
    );
  const livenessSummary = livenessDisplay
    ? describeLivenessSummary(t, livenessDisplay, nowMs)
    : null;
  const renderModeTitle =
    renderMode?.state === "rendered"
      ? t("toolbarRenderModeRendered")
      : renderMode?.state === "source"
        ? t("toolbarRenderModeSource")
        : t("toolbarRenderModeMixed");
  const conversationViewTitle = conversationViewEnabled
    ? t("toolbarConversationViewDisable")
    : t("toolbarConversationViewEnable");
  const browserDebugActive = browserDebugLease.phase === "active";
  const effectiveToolbarVisibility = useMemo(
    () =>
      browserDebugActive && !toolbarVisibility.browserDebug
        ? { ...toolbarVisibility, browserDebug: true }
        : toolbarVisibility,
    [browserDebugActive, toolbarVisibility],
  );
  const browserDebugRemainingFraction = browserDebugLease.expiresAtMs
    ? Math.max(
        0,
        Math.min(
          1,
          (browserDebugLease.expiresAtMs - Date.now()) /
            BROWSER_DEBUG_LEASE_TTL_MS,
        ),
      )
    : 0;
  const browserDebugPerformanceLabel =
    browserDebugActive && browserDebugLease.performanceSummary
      ? t("toolbarBrowserDebugPerformanceCompact", {
          delay: Math.round(
            browserDebugLease.performanceSummary.recentMaxDelayMs,
          ),
          tasks: browserDebugLease.performanceSummary.recentLongTaskCount,
        })
      : null;
  const browserDebugTitle = browserDebugActive
    ? [
        t("toolbarBrowserDebugDisable", {
          expiry: new Date(
            browserDebugLease.expiresAtMs ?? Date.now(),
          ).toLocaleTimeString(),
        }),
        browserDebugLease.performanceSummary
          ? t("toolbarBrowserDebugPerformanceTitle", {
              seconds: Math.max(
                1,
                Math.round(
                  browserDebugLease.performanceSummary.recentWindowMs / 1_000,
                ),
              ),
              delay: Math.round(
                browserDebugLease.performanceSummary.recentMaxDelayMs,
              ),
              tasks: browserDebugLease.performanceSummary.recentLongTaskCount,
              frameGaps:
                browserDebugLease.performanceSummary.recentFrameGapCount,
              keystrokes:
                browserDebugLease.performanceSummary
                  .recentDelayedKeystrokeCount,
            })
          : null,
      ]
        .filter(Boolean)
        .join("\n")
    : t("toolbarBrowserDebugEnable");
  const toggleBrowserDebug = useCallback(() => {
    if (browserDebugActive) {
      void browserDebugLease.disable();
      return;
    }
    if (!sessionId) return;
    const prompt = browserDebugLease.enable(sessionId);
    const copy = writeClipboardTextLater(prompt);
    void Promise.all([prompt, copy])
      .then(([, copied]) => {
        showToast?.(
          copied
            ? t("browserDebugCopiedBanner")
            : t("browserDebugClipboardFailed"),
          "error",
        );
      })
      .catch((error) => {
        showToast?.(
          t("browserDebugEnableFailed", {
            error: error instanceof Error ? error.message : String(error),
          }),
          "error",
        );
      });
  }, [browserDebugActive, browserDebugLease, sessionId, showToast, t]);
  const reactivateBrowserDebug = useCallback(() => {
    void browserDebugLease.reactivate().catch((error) => {
      showToast?.(
        t("browserDebugReactivateFailed", {
          error: error instanceof Error ? error.message : String(error),
        }),
        "error",
      );
    });
  }, [browserDebugLease, showToast, t]);
  const reloadWithBrowserDebug = useCallback(() => {
    if (!browserDebugActive) return;
    try {
      const reloadUrl = browserDebugLease.prepareFrontendReload(
        window.location.href,
        String(Date.now()),
      );
      window.location.replace(reloadUrl);
    } catch (error) {
      showToast?.(
        t("browserDebugReloadFailed", {
          error: error instanceof Error ? error.message : String(error),
        }),
        "error",
      );
    }
  }, [browserDebugActive, browserDebugLease, showToast, t]);
  const hasPotentialDualActions = !!(onSend && onQueue && onSteer);
  const effectivePrimaryActionKind =
    primaryActionKind ?? (hasPotentialDualActions ? "steer" : "send");
  const hasDualActions =
    hasPotentialDualActions &&
    (effectivePrimaryActionKind === "steer" ||
      effectivePrimaryActionKind === "queue");
  const queueActionTooltip = t("toolbarQueueTooltip");
  const projectQueueCtrlEnterEnabled =
    versionInfo?.clientDefaults?.projectQueueCtrlEnterEnabled ??
    DEFAULT_PROJECT_QUEUE_CTRL_ENTER_ENABLED;
  const showProjectQueueShortcut = Boolean(
    toolbarVisibility.projectQueue &&
      onProjectQueue &&
      projectQueueCtrlEnterEnabled,
  );
  const sendTooltip = sendOverride
    ? sendOverride.tooltip
    : effectivePrimaryActionKind === "steer"
      ? t("toolbarSteerTooltip")
      : effectivePrimaryActionKind === "queue"
        ? queueActionTooltip
        : t("toolbarSendTooltip");
  const queueTooltip = queueActionTooltip;
  const canSwapDisplayedEnterAction =
    canSwapEnterAction && !showProjectQueueShortcut;
  const queueShortcutLabel = showProjectQueueShortcut
    ? t("toolbarShortcutProjectQueue")
    : canSwapDisplayedEnterAction && effectivePrimaryActionKind === "queue"
      ? t("toolbarShortcutSteerCurrentTurn")
      : t("toolbarShortcutQueueCurrentTurn");
  const effectiveBtwToolbarMode =
    btwToolbarMode ??
    (btwActive ? "focused-footer" : btwHasAsides ? "focus-existing" : "start");
  const btwTitle = getBtwTitle(effectiveBtwToolbarMode, t);
  const btwPressed = isBtwPressed(effectiveBtwToolbarMode);
  const primaryActionIcon = sendOverride
    ? sendOverride.icon
    : effectivePrimaryActionKind === "steer"
      ? "↗"
      : effectivePrimaryActionKind === "queue"
        ? "→"
        : "↑";
  const primaryActionLabel = sendOverride
    ? sendOverride.label
    : effectivePrimaryActionKind === "steer"
      ? t("toolbarSteerTooltip")
      : effectivePrimaryActionKind === "queue"
        ? hasDualActions
          ? t("toolbarQueuePrimaryActionLabel")
          : t("toolbarQueueLabel")
        : t("toolbarSend");
  const showStopButton = !!(isRunning && onStop && isThinking && !canSend);
  const showSendButton = !!(onSend && (!showStopButton || canSend));
  const serverVoiceEnabled =
    !hasServerCapabilityAdvertisement(versionInfo) ||
    serverHasCapability(versionInfo, VOICE_INPUT_CAPABILITY);
  const { hasBrowserXaiSttApiKey } = useBrowserXaiSttApiKey();
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
        setSpeechMethod?.(next);
      }
    },
    [setSpeechMethod],
  );
  const showSpeechMethodSelector =
    toolbarVisibility.microphone &&
    voiceInputEnabled &&
    serverVoiceEnabled &&
    speechMethodOptions.length > 1;
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
  const hasLastActivityAge = showLastActivityAge;
  const showLastActivityChip =
    toolbarVisibility.sessionStatus && hasLastActivityAge;
  const showToolbarStatus =
    showLivenessChip || showLastActivityChip || showPositionTimestamp;
  const compactStatusLayoutKey = [
    livenessDisplay?.prefix ?? "",
    livenessDisplay?.timestampMs ?? "",
    livenessDisplay?.tone ?? "",
    nowMs,
    showLastActivityAge,
    showLastActivityChip,
    showLivenessChip,
    showToolbarStatus,
    showPositionTimestamp,
    showStopButton,
    showSendButton,
  ].join("\0");

  useEffect(() => {
    if (effectiveThinkingMode !== "off") {
      lastNonOffThinkingModeRef.current = effectiveThinkingMode;
    }
  }, [effectiveThinkingMode]);

  const toggleThinkingEnabled = useCallback(() => {
    const nextEnabledMode = thinkingModeOptions.includes(
      lastNonOffThinkingModeRef.current,
    )
      ? lastNonOffThinkingModeRef.current
      : (thinkingModeOptions.find((option) => option !== "off") ?? "auto");
    setSelectedThinkingMode(
      effectiveThinkingMode === "off" ? nextEnabledMode : "off",
    );
  }, [effectiveThinkingMode, setSelectedThinkingMode, thinkingModeOptions]);
  const setSelectedThinkingEffortMode = useCallback(
    (level: EffortLevel) => {
      if (liveThinkingSelection) {
        liveThinkingSelection.onSetEffort(level);
        return;
      }
      setSelectedEffortLevel(level);
      setSelectedThinkingMode("on");
    },
    [liveThinkingSelection, setSelectedEffortLevel, setSelectedThinkingMode],
  );

  useLayoutEffect(() => {
    void compactStatusLayoutKey;
    const compactStatusQuery = getCompactStatusMatchMedia();
    const toolbar = toolbarRef.current;
    const left = toolbarLeftRef.current;
    const actions = toolbarActionsRef.current;

    if (!toolbar || !left || !actions || typeof window === "undefined") {
      setIsCompactStatusMode(compactStatusQuery?.matches ?? false);
      return;
    }

    let raf = 0;

    const pxOrZero = (value: string) => {
      const parsed = Number.parseFloat(value);
      return Number.isFinite(parsed) ? parsed : 0;
    };

    // Content demand of a toolbar section, immune to flex stretching. A
    // stretched section reports its grown size through scrollWidth:
    // [data-message-input-left] is flex: 1, so once the status floats (leaving the
    // row) the left section absorbs the freed room, and measuring rendered
    // sizes feeds that growth back into requiredWidth — compact mode then
    // stays latched at any window width. Children that are themselves
    // stretchy fillers (flex-grow, e.g. the speech waveform) count as their
    // flex basis.
    const sectionDemand = (section: HTMLElement) => {
      const styles = getComputedStyle(section);
      const gap = pxOrZero(styles.columnGap || styles.gap);
      let width = 0;
      let inFlow = 0;
      for (const child of Array.from(section.children)) {
        if (!(child instanceof HTMLElement)) {
          continue;
        }
        const childStyles = getComputedStyle(child);
        if (
          childStyles.display === "none" ||
          childStyles.position === "absolute"
        ) {
          continue;
        }
        inFlow += 1;
        width +=
          pxOrZero(childStyles.flexGrow) > 0
            ? pxOrZero(childStyles.flexBasis)
            : child.getBoundingClientRect().width;
      }
      return width + gap * Math.max(0, inFlow - 1);
    };

    const updateCompactStatusMode = () => {
      const status = toolbarStatusRef.current;
      const viewportCompact = compactStatusQuery?.matches ?? false;

      if (!status) {
        setIsCompactStatusMode(viewportCompact);
        return;
      }

      const toolbarStyles = getComputedStyle(toolbar);
      const gap = pxOrZero(toolbarStyles.columnGap || toolbarStyles.gap);
      const requiredWidth =
        sectionDemand(left) +
        sectionDemand(status) +
        sectionDemand(actions) +
        gap * 2;

      setIsCompactStatusMode((current) => {
        if (viewportCompact || requiredWidth > toolbar.clientWidth + 1) {
          return true;
        }
        if (!current) {
          return false;
        }
        // Exiting compact needs slack beyond merely fitting: the float omits
        // the liveness chip and restyles the ages, so demand measured while
        // floating understates the inline row it would return to. Without
        // the slack the mode can oscillate at the boundary.
        return requiredWidth + COMPACT_STATUS_EXIT_SLACK_PX >
          toolbar.clientWidth
          ? current
          : false;
      });
    };

    const scheduleCompactStatusUpdate = () => {
      window.cancelAnimationFrame(raf);
      raf = window.requestAnimationFrame(updateCompactStatusMode);
    };

    const resizeObserver =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(scheduleCompactStatusUpdate);
    resizeObserver?.observe(toolbar);
    resizeObserver?.observe(left);
    resizeObserver?.observe(actions);
    if (toolbarStatusRef.current) {
      resizeObserver?.observe(toolbarStatusRef.current);
    }

    window.addEventListener("resize", scheduleCompactStatusUpdate);
    compactStatusQuery?.addEventListener("change", scheduleCompactStatusUpdate);
    scheduleCompactStatusUpdate();

    return () => {
      window.cancelAnimationFrame(raf);
      resizeObserver?.disconnect();
      window.removeEventListener("resize", scheduleCompactStatusUpdate);
      compactStatusQuery?.removeEventListener(
        "change",
        scheduleCompactStatusUpdate,
      );
    };
  }, [compactStatusLayoutKey]);

  useEffect(() => {
    const handleIsearchGuide = (event: Event) => {
      const detail = (event as CustomEvent<SessionIsearchGuideState>).detail;
      if (detail?.active) {
        setIsearchScope(detail.scope);
        return;
      }
      setIsearchScope(null);
      setShortcutsOpen(false);
    };

    window.addEventListener(SESSION_ISEARCH_GUIDE_EVENT, handleIsearchGuide);
    return () =>
      window.removeEventListener(
        SESSION_ISEARCH_GUIDE_EVENT,
        handleIsearchGuide,
      );
  }, []);
  const handleToolbarPendingSpeechChange = useCallback(
    (kind: SpeechPendingKind | null, settlement?: SpeechCycleSettlement) => {
      setSpeechCaptureActive(kind === "listening");
      onPendingSpeechChange?.(kind, settlement);
    },
    [onPendingSpeechChange],
  );

  return (
    <MessageInputToolbarView
      t={t}
      refs={{
        toolbar: toolbarRef,
        left: toolbarLeftRef,
        status: toolbarStatusRef,
        actions: toolbarActionsRef,
      }}
      visibility={effectiveToolbarVisibility}
      onHideControl={hideToolbarControl}
      priority={toolbarPriority}
      isCompactStatusMode={isCompactStatusMode}
      fileViewerController={fileViewerController}
      modeControl={
        onModeChange && supportsPermissionMode
          ? {
              mode,
              onModeChange,
              modes: permissionModeOptions,
              changesApplyNextTurn: modeChangesApplyNextTurn,
              modeChangePending,
            }
          : null
      }
      attachmentControl={{
        onAttachmentPanel,
        onRecordAudioMemo,
        canAttach,
        attachmentCount,
        onAttachClick,
      }}
      slashControl={
        onSelectSlashCommand
          ? {
              commands: slashCommands,
              onSelectCommand: onSelectSlashCommand,
              disabled: voiceDisabled,
            }
          : null
      }
      thinkingControl={
        supportsThinkingToggle && hasThinkingModeOptions
          ? {
              mode: effectiveThinkingMode,
              modeOptions: thinkingModeOptions,
              level: effectiveThinkingLevel,
              effortOptions: thinkingEffortOptions,
              onSetMode: setSelectedThinkingMode,
              onSetEffort: setSelectedEffortLevel,
              onSetEffortMode: setSelectedThinkingEffortMode,
              onToggleEnabled: toggleThinkingEnabled,
              showThinking,
              onSetShowThinking: setShowThinking ?? (() => {}),
              provider: normalizedThinkingProvider,
            }
          : null
      }
      renderModeControl={
        renderMode
          ? {
              state: renderMode.state,
              title: renderModeTitle,
              onToggle: renderMode.toggleGlobalMode,
            }
          : null
      }
      conversationViewControl={{
        enabled: conversationViewEnabled,
        title: conversationViewTitle,
        onToggle: () => setConversationViewEnabled(!conversationViewEnabled),
      }}
      browserDebugControl={
        supportsBrowserDebug && sessionId
          ? {
              active: browserDebugActive,
              connected: browserDebugLease.connected,
              enabling: browserDebugLease.phase === "enabling",
              remainingFraction: browserDebugRemainingFraction,
              performanceLabel: browserDebugPerformanceLabel,
              title: browserDebugTitle,
              onToggle: toggleBrowserDebug,
              onReactivate: reactivateBrowserDebug,
              onReload: reloadWithBrowserDebug,
            }
          : null
      }
      doneControl={
        onDone
          ? {
              onDone,
              title: doneTitle ?? t("syntheticDoneToolbarTitle"),
            }
          : null
      }
      speechControl={{
        showMethodSelector: showSpeechMethodSelector,
        methodOptions: speechMethodOptions,
        selectedMethod: selectedSpeechMethod,
        onMethodChange: handleSpeechMethodSelect,
        smartTurnSettings: activeSpeechSmartTurnSettings,
        onSmartTurnSettingsChange: supportsSelectedSpeechSmartTurn
          ? setSpeechSmartTurnSettings
          : undefined,
        smartTurnDisabled: voiceDisabled,
        voiceButton:
          !hideVoiceInput &&
          toolbarVisibility.microphone &&
          voiceButtonRef &&
          onVoiceTranscript &&
          onInterimTranscript
            ? {
                kind: "live",
                ref: voiceButtonRef,
                onTranscript: onVoiceTranscript,
                onInterimTranscript,
                onListeningStart,
                onListeningStop,
                onPendingSpeechChange: handleToolbarPendingSpeechChange,
                onTranscriptionSettled,
                showWaveform: toolbarVisibility.waveform,
                disabled: voiceDisabled,
                speechMethod: selectedSpeechMethod,
                getTranscriptionContext,
                smartTurn: activeSpeechSmartTurnSettings,
              }
            : undefined,
      }}
      speechWaveformActive={
        toolbarVisibility.waveform &&
        speechCaptureActive &&
        selectedSpeechMethod !== DEFAULT_SPEECH_METHOD
      }
      waveformButtonBackgroundOpacityPercent={
        waveformButtonBackgroundOpacityPercent
      }
      statusControl={{
        showToolbarStatus,
        showLivenessChip,
        livenessDisplay,
        livenessSummary,
        providerRuntimeDisplay,
        nowMs,
        showLastActivityChip,
        showLastActivityPrefix,
        lastActivityMs,
        lastActivityIsPast,
        positionTimestampMs: effectivePositionTimestampMs ?? null,
        showPositionTimestamp,
        hasPositionAge,
        hasLastActivityAge,
      }}
      pendingApproval={pendingApproval}
      shortcutsControl={{
        open: shortcutsOpen,
        isearchScope,
        setOpen: setShortcutsOpen,
        settingsOpen: shortcutSettingsOpen,
        setSettingsOpen: setShortcutSettingsOpen,
        hasDualActions,
        enterActionKind: enterActionKind ?? effectivePrimaryActionKind,
        canSwapEnterAction: canSwapDisplayedEnterAction,
        onSwapEnterAction,
        queueShortcutLabel,
        canForkAfterSummary,
      }}
      actionsControl={{
        disabled,
        voiceDisabled,
        contextUsage,
        contextModel: contextRequestedModel ?? thinkingModel,
        contextProvider: thinkingProviderInfo?.name,
        contextWindow: thinkingModelInfo?.contextWindow,
        contextSessionId: sessionId,
        btw: onBtwClick
          ? {
              onClick: onBtwClick,
              pressed: btwPressed,
              mode: effectiveBtwToolbarMode,
              title: btwTitle,
            }
          : null,
        stop: showStopButton
          ? {
              onStop: onStop!,
            }
          : null,
        send: showSendButton
          ? {
              onSend,
              onSendOptions,
              onSteer,
              canSend,
              primaryActionKind: effectivePrimaryActionKind,
              primaryActionLabel,
              tooltip: sendTooltip,
              icon: primaryActionIcon,
              speechMessagePrefix,
              primarySpeechMessagePrefix:
                primarySpeechMessagePrefix === undefined
                  ? speechMessagePrefix
                  : primarySpeechMessagePrefix,
              showSteerNowMode,
              steerNowEnabled,
              onToggleSteerNow,
              queue: {
                onQueue,
                onSteer,
                hasDualActions,
                queueTooltip,
              },
              alternate: sendAlternate,
            }
          : null,
        topicShift: onTopicShift ? { onTopicShift, canSend } : null,
        projectQueue:
          onProjectQueue || onProjectQueueNewSession
            ? {
                onProjectQueue,
                onProjectQueueNewSession,
                onProjectQueueNewSessionOptions,
                canSend,
                tooltip: onProjectQueue
                  ? showProjectQueueShortcut
                    ? t("toolbarProjectQueueTooltipWithShortcut")
                    : t("toolbarProjectQueueTooltip")
                  : undefined,
                newSessionTooltip: onProjectQueueNewSession
                  ? onProjectQueueNewSessionOptions
                    ? t("toolbarProjectQueueNewSessionOptionsTooltip")
                    : t("toolbarProjectQueueNewSessionTooltip")
                  : undefined,
              }
            : null,
      }}
      hidePrimaryDeliveryActions={hidePrimaryDeliveryActions}
    />
  );
}
