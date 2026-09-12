import type {
  MarkdownAugment,
  ProjectQueueItemStatus,
  SessionQueuedMessageSummary,
  TranscriptDisplayObject,
  UploadedFile,
} from "@yep-anywhere/shared";
import {
  createElement,
  Fragment,
  memo,
  startTransition,
  useCallback,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { createPortal } from "react-dom";
import { useAsyncQuestions } from "../contexts/AsyncQuestionsContext";
import { getShowThinkingSetting } from "../hooks/useModelSettings";
import {
  QueuedEffortBadge,
  type QueuedEffortContext,
} from "./QueuedEffortBadge";
import {
  getConversationViewPreference,
  getConversationViewTurnLimit,
  subscribeConversationViewPreference,
  subscribeConversationViewTurnLimit,
} from "../hooks/useConversationView";
import { useWiderConversationActivityPreviews } from "../hooks/useWiderConversationActivityPreviews";
import { useMessageListIsearch } from "../hooks/useMessageListIsearch";
import { useMessageListSelectionQuote } from "../hooks/useMessageListSelectionQuote";
import { useRelativeNow } from "../hooks/useRelativeNow";
import { useRecentProjectPathLinks } from "../hooks/useRecentProjectPathLinks";
import { useTranscriptRenderWindow } from "../hooks/useTranscriptRenderWindow";
import { useI18n } from "../i18n";
import {
  createRememberedDisclosureStateRegistry,
  RememberedDisclosureStateProvider,
} from "../contexts/RememberedDisclosureStateContext";
import { QuoteReplyProvider } from "../contexts/QuoteReplyContext";
import type {
  ComposerDraftSignal,
  ComposerEditAvailabilityStore,
} from "../lib/composerDraftSignal";
import {
  isBrowserDebugPerformanceRecording,
  recordBrowserDebugPerformanceMetric,
} from "../lib/browserDebugPerformance";
import { markReloadPerfPhase } from "../lib/diagnostics/reloadPerfProbe";
import { selectionIntersectsElement } from "../lib/domSelection";
import { getMessageId } from "@yep-anywhere/shared/transcript/message";
import { formatFileSize } from "../lib/formatFileSize";
import type { GetSessionResult } from "../lib/sourceRuntime";
import {
  createTranscriptPositionStore,
  type TranscriptPositionStore,
} from "../lib/transcriptPositionStore";
import {
  formatCompactRelativeAge,
  getEarliestMessageTimestampMs,
  getLatestMessageTimestampMs,
  MESSAGE_STALE_THRESHOLD_MS,
} from "../lib/messageAge";
import type { ActiveToolApproval } from "@yep-anywhere/shared/transcript/types";
import type { SessionIsearchScope } from "../lib/sessionIsearchGuide";
import {
  decideSessionScrollRestore,
  DEFAULT_SESSION_SCROLL_BEHAVIOR_MODE,
  type SessionScrollBehaviorMode,
} from "../lib/sessionScrollBehavior";
import {
  deriveVisibleSessionScrollCursor,
  getLatestSeenTurnRenderKey,
} from "../lib/sessionScrollCursor";
import type { SessionRouteScrollSnapshot } from "../lib/sessionRouteSnapshots";
import {
  isSessionViewerOpen,
  useSessionViewerResumeRevision,
} from "../lib/sessionViewerController";
import {
  findFallbackRenderAnchorRow,
  findRenderRow,
  getFirstVisibleRenderAnchor,
  restoreScrollToAnchorRow,
} from "../lib/scrollAnchors";
import {
  buildComposerTailDisplayRows,
  buildSessionDetailRenderItems,
  buildTimelineEntryDisplayRows,
  buildVisibleTimelineEntries,
  countThinkingItems,
  getDisplayRenderItems,
  getLastTimestampedRenderItem,
  getLatestVisibleTimestampMs,
  getLatestThinkingItemId,
  getNextProgressiveEntryCount,
  getProgressiveTimelineVisibility,
  getTailEntryCountForRenderItemTarget,
  getThinkingItemIds,
  getThinkingTextLengths,
  groupEndsVisibleTurn,
  groupRenderItemsIntoTurns,
  hasVisibleThinkingTextDelta,
  projectConversationView,
  reconcileAutoExpandedThinkingItemIds,
  selectLatestCorrectablePrompt,
  stabilizeRenderTurnGroups,
  stabilizeTimelineEntryDisplayRows,
  windowConversationViewItems,
  type TimelineEntryDisplayRow,
  type ComposerTailLanePosition,
  type RenderTurnGroup,
} from "../lib/sessionDetail/renderSelectors";
import type { CommentAnchor } from "../lib/commentAnchors";
import { stabilizeRenderItems } from "../lib/stableRenderItems";
import { UI_KEYS } from "../lib/storageKeys";
import type { Message } from "../types";
import type {
  ConversationThinkingPreviewSlot,
  RenderItem,
} from "@yep-anywhere/shared/transcript/items";
import { AttachmentChip } from "./AttachmentChip";
import { useSessionViewerSessionId } from "./SessionManagedViewer";
import {
  BtwAsideTranscript,
  type BtwAsideTranscriptTurn,
} from "./BtwAsidePane";
import { ExploredToolGroup } from "./blocks/ExploredToolGroup";
import { MessageAge } from "./MessageAge";
import { ProcessingIndicator } from "./ProcessingIndicator";
import type { BangCommandHandlers } from "./BangCommandDisplayObject";
import { RenderItemComponent } from "./RenderItemComponent";
import { useWorkflowTags } from "../hooks/useWorkflowTags";
import { useWorkflowSchemaFiles } from "../hooks/useWorkflowSchemaFiles";
import { AssistantTurnImageGallery } from "./TurnImageGallery";
import {
  UserTurnNavigator,
  type UserTurnNavAnchor,
  type UserTurnNavMotionCue,
} from "./UserTurnNavigator";
import { CopyTextButton } from "./ui/CopyTextButton";
import { LinkifiedText } from "./ui/LinkifiedText";
import styles from "./MessageList.module.css";

const EMPTY_TRANSCRIPT_DISPLAY_OBJECTS: readonly TranscriptDisplayObject[] = [];
const PROGRESSIVE_INITIAL_RENDER_ITEM_TARGET = 120;
const PROGRESSIVE_RENDER_ITEM_BATCH_TARGET = 90;
const PROGRESSIVE_RETAINED_RENDER_ITEM_BATCH_TARGET = 12;
const PROGRESSIVE_RENDER_BATCH_DELAY_MS = 32;
const PROGRESSIVE_RETAINED_RESUME_DELAY_MS = 1_500;
const PROGRESSIVE_RENDER_REVEAL_DELAY_MS = 180;
const OLDER_PAGE_PREPEND_BATCH_TARGET = 8;
const EMPTY_THINKING_PREVIEW_SLOTS = new Set<ConversationThinkingPreviewSlot>();
const TRANSCRIPT_RENDER_MARKER_STYLE = {
  display: "block",
  height: 0,
  overflow: "hidden",
  pointerEvents: "none",
} as const;

interface KeyedTimelineRow {
  key: string;
  kind: string;
}

interface ChunkedTimelinePrependState<TRow> {
  rows: readonly TRow[];
  start: number;
}

function getTimelineRowRenderWeight(row: KeyedTimelineRow): number {
  if (row.kind !== "assistant" || !("rows" in row)) {
    return row.kind === "empty" ? 0 : 1;
  }
  const assistantRows = row.rows;
  return Array.isArray(assistantRows) ? Math.max(1, assistantRows.length) : 1;
}

function getTimelineRowTargetIds(
  row: TimelineEntryDisplayRow<RenderTurnGroup, BtwAsideTimelineItem>,
): string[] {
  if (row.kind === "btw") {
    return [`btw-${row.aside.id}`];
  }
  if (row.kind === "empty") {
    return [];
  }
  if (row.kind === "standalone" || row.kind === "user") {
    return [row.item.id];
  }
  const ids = new Set(row.group.items.map((item) => item.id));
  for (const assistantRow of row.rows) {
    if (assistantRow.kind === "explored") {
      ids.add(assistantRow.id);
    } else {
      ids.add(assistantRow.item.id);
    }
  }
  return [...ids];
}

function getPreviousTimelineBatchStart<TRow extends KeyedTimelineRow>(
  rows: readonly TRow[],
  end: number,
): number {
  let start = Math.min(rows.length, Math.max(0, end));
  let weight = 0;
  while (start > 0 && weight < OLDER_PAGE_PREPEND_BATCH_TARGET) {
    start -= 1;
    const row = rows[start];
    if (row) {
      weight += getTimelineRowRenderWeight(row);
    }
  }
  return start;
}

function getPrependedTimelineRowCount<TRow extends KeyedTimelineRow>(
  previous: readonly TRow[],
  next: readonly TRow[],
): number {
  const added = next.length - previous.length;
  if (added <= 0) {
    return 0;
  }
  for (let index = 0; index < previous.length; index += 1) {
    if (previous[index]?.key !== next[index + added]?.key) {
      return 0;
    }
  }
  return added;
}

function useChunkedTimelinePrepend<TRow extends KeyedTimelineRow>(
  rows: readonly TRow[],
  prependPending: boolean,
): { active: boolean; revision: number; rows: readonly TRow[] } {
  const stateRef = useRef<ChunkedTimelinePrependState<TRow>>({
    rows,
    start: 0,
  });
  const [revision, setRevision] = useState(0);
  let current = stateRef.current;

  if (current.rows !== rows) {
    const firstVisibleKey = current.rows[current.start]?.key;
    const preservedStart =
      current.start > 0 && firstVisibleKey
        ? rows.findIndex((row) => row.key === firstVisibleKey)
        : -1;
    const prepended = prependPending
      ? getPrependedTimelineRowCount(current.rows, rows)
      : 0;
    if (preservedStart >= 0) {
      current.rows = rows;
      current.start = preservedStart;
    } else {
      current = {
        rows,
        start:
          prepended > 0 ? getPreviousTimelineBatchStart(rows, prepended) : 0,
      };
      stateRef.current = current;
    }
  }

  useLayoutEffect(() => {
    if (current.start <= 0) {
      return;
    }
    const scheduledState = current;
    const frame = requestAnimationFrame(() => {
      if (stateRef.current !== scheduledState) {
        return;
      }
      const start = getPreviousTimelineBatchStart(
        scheduledState.rows,
        scheduledState.start,
      );
      if (start === scheduledState.start) {
        return;
      }
      stateRef.current = {
        ...scheduledState,
        start,
      };
      setRevision((previous) => previous + 1);
    });
    return () => cancelAnimationFrame(frame);
  }, [current]);

  return {
    active: current.start > 0,
    revision,
    rows: current.rows.slice(current.start),
  };
}

function reuseEqualSet<T>(previous: ReadonlySet<T>, next: ReadonlySet<T>) {
  if (previous.size !== next.size) return next;
  for (const value of next) {
    if (!previous.has(value)) return next;
  }
  return previous;
}

function isCtrlKeyShortcut(
  event: KeyboardEvent,
  key: string,
  code: string,
  options: { allowAlt?: boolean } = {},
): boolean {
  if (
    !event.ctrlKey ||
    event.metaKey ||
    event.shiftKey ||
    (!options.allowAlt && event.altKey) ||
    event.getModifierState("AltGraph")
  ) {
    return false;
  }
  return event.key.toLocaleLowerCase() === key || event.code === code;
}

function getSessionIsearchShortcutScope(
  event: KeyboardEvent,
): SessionIsearchScope | null {
  if (
    isCtrlKeyShortcut(event, "s", "KeyS", { allowAlt: true }) &&
    event.altKey
  ) {
    return "full";
  }
  if (isCtrlKeyShortcut(event, "s", "KeyS")) {
    return "all";
  }
  if (isCtrlKeyShortcut(event, "r", "KeyR", { allowAlt: true })) {
    return "user";
  }
  return null;
}

function getVisibleTurnEndTimestampMs(
  scrollContainer: HTMLElement,
  groups: readonly RenderTurnGroup[],
  rowsById: ReadonlyMap<string, HTMLElement>,
): number | null {
  const containerRect = scrollContainer.getBoundingClientRect();
  let timestampMs: number | null = null;

  for (let index = 0; index < groups.length; index += 1) {
    const group = groups[index];
    if (!group || !groupEndsVisibleTurn(group, groups[index + 1])) {
      continue;
    }
    const item = getLastTimestampedRenderItem(group.items);
    if (!item) {
      continue;
    }
    const row = rowsById.get(item.id);
    if (!row) {
      continue;
    }
    const rowRect = row.getBoundingClientRect();
    if (
      rowRect.bottom >= containerRect.top &&
      rowRect.bottom <= containerRect.bottom
    ) {
      timestampMs = getLatestMessageTimestampMs(item.sourceMessages);
    }
  }

  return timestampMs;
}

function getMiddleVisibleTimestampMs(
  scrollContainer: HTMLElement,
  items: readonly RenderItem[],
  rows: readonly HTMLElement[],
): number | null {
  const containerRect = scrollContainer.getBoundingClientRect();
  const middleY = containerRect.top + containerRect.height / 2;
  const timestampsById = new Map<string, number>();

  for (const item of items) {
    const timestampMs = getLatestMessageTimestampMs(item.sourceMessages);
    if (timestampMs !== null) {
      timestampsById.set(item.id, timestampMs);
    }
  }

  let best: { distance: number; timestampMs: number } | null = null;
  for (const row of rows) {
    const id = row.dataset.renderId;
    if (!id) {
      continue;
    }
    const timestampMs = timestampsById.get(id);
    if (timestampMs === undefined) {
      continue;
    }
    const rowRect = row.getBoundingClientRect();
    const visible =
      rowRect.bottom >= containerRect.top &&
      rowRect.top <= containerRect.bottom;
    if (!visible) {
      continue;
    }
    const distance =
      rowRect.top <= middleY && rowRect.bottom >= middleY
        ? 0
        : Math.min(
            Math.abs(rowRect.top - middleY),
            Math.abs(rowRect.bottom - middleY),
          );
    if (!best || distance <= best.distance) {
      best = { distance, timestampMs };
    }
  }

  return best?.timestampMs ?? null;
}

function getTranscriptPositionTimestampMs(
  messageList: HTMLDivElement,
  scrollContainer: HTMLElement,
  groups: readonly RenderTurnGroup[],
  items: readonly RenderItem[],
): number | null {
  const rows = Array.from(
    messageList.querySelectorAll<HTMLElement>("[data-render-id]"),
  );
  const rowsById = new Map<string, HTMLElement>();
  for (const row of rows) {
    const id = row.dataset.renderId;
    if (id && !rowsById.has(id)) {
      rowsById.set(id, row);
    }
  }
  return (
    getVisibleTurnEndTimestampMs(scrollContainer, groups, rowsById) ??
    getMiddleVisibleTimestampMs(scrollContainer, items, rows)
  );
}

const NAV_MOTION_CUE_CLEAR_MS = 760;
const MIN_BOTTOM_FOLLOW_THRESHOLD_PX = 120;
const MAX_BOTTOM_FOLLOW_THRESHOLD_PX = 520;
const BOTTOM_FOLLOW_VIEWPORT_FRACTION = 0.45;
const FOLLOW_CATCH_UP_DELAYS_MS = [50, 120, 240, 480, 960, 1600, 2400];
const SEND_CATCH_UP_DELAYS_MS = [80, 240, 640];
const TOUCH_SCROLL_CANCEL_THRESHOLD_PX = 6;
const USER_TURN_NAV_SCROLL_OFFSET_PX = 12;
const USER_TURN_NAV_VISIBILITY_TOLERANCE_PX = 1;
const EMPTY_RENDER_ID_SET: ReadonlySet<string> = new Set();
const INTERACTIVE_SCROLL_TARGET_SELECTOR =
  "button, input, textarea, select, a[href], [contenteditable='true']";
const EDITABLE_KEYBOARD_TARGET_SELECTOR =
  "input, textarea, select, [contenteditable='true']";

function highResolutionNowMs(): number {
  return typeof performance !== "undefined" &&
    typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}

function isNearScrollBottom(container: HTMLElement): boolean {
  const followThreshold = Math.min(
    MAX_BOTTOM_FOLLOW_THRESHOLD_PX,
    Math.max(
      MIN_BOTTOM_FOLLOW_THRESHOLD_PX,
      container.clientHeight * BOTTOM_FOLLOW_VIEWPORT_FRACTION,
    ),
  );
  return (
    container.scrollHeight - container.scrollTop - container.clientHeight <
    followThreshold
  );
}

// Tolerance for "the last line is in view" — sub-pixel / zoom / high-DPI
// rounding only, not a behavioural band.
const FOLLOW_BOTTOM_TOLERANCE_PX = 4;
// Scroll snapshots are warm-restore hints, not live state: capture involves a
// full anchor walk (rect reads), so per-tick publishes coalesce to a trailing
// capture; leave/settle paths still publish immediately.
const SCROLL_SNAPSHOT_PUBLISH_DEBOUNCE_MS = 200;

// "At bottom" for follow purposes = the last rendered line is in view (its
// bottom edge at or above the viewport bottom), not that scrollTop reached the
// literal pixel-bottom. So trailing padding below the processing indicator
// needn't be scrolled past ("as soon as the fun-text line shows, we're
// following"), and the indicator being absent is handled for free —
// lastElementChild is then the last message row. The generous isNearScrollBottom
// stays only for *continuing* an already-on follow through fast-streaming gaps;
// re-acquiring follow is governed here.
//
// Deliberately position-only, with no scroll-direction inference. Momentum
// scrolling fires scroll events after the finger has lifted, and iOS rubber-band
// bounce briefly overshoots the bottom then springs back — both corrupt any
// velocity/direction reading. "Is the bottom line visible right now" stays
// consistent through momentum and bounce (during a bottom bounce the last line
// is *more* in view, which correctly reads as at-bottom), so it needs no
// direction tracking and no settle timer. Exit-follow uses the directional
// wheel/touch/key handlers plus displacement above the latest follow write, so a
// missed input precursor cannot let animated layout work trap the reader.
function isAtScrollBottom(
  viewport: HTMLElement,
  content: HTMLElement,
): boolean {
  const lastLine = content.lastElementChild;
  if (!lastLine) {
    return (
      viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <=
      FOLLOW_BOTTOM_TOLERANCE_PX
    );
  }
  return (
    lastLine.getBoundingClientRect().bottom <=
    viewport.getBoundingClientRect().bottom + FOLLOW_BOTTOM_TOLERANCE_PX
  );
}

function eventTargetIsInside(
  target: EventTarget | null,
  container: HTMLElement,
): boolean {
  return target instanceof Node && container.contains(target);
}

function isInteractiveScrollTarget(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    target.closest(INTERACTIVE_SCROLL_TARGET_SELECTOR) !== null
  );
}

function isEditableKeyboardTarget(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    target.closest(EDITABLE_KEYBOARD_TARGET_SELECTOR) !== null
  );
}

function getAdjacentHiddenUserTurnTarget(
  anchors: readonly UserTurnNavAnchor[],
  messageList: HTMLDivElement,
  scrollContainer: HTMLElement,
  direction: "previous" | "next",
  getRenderIdTop?: (id: string) => number | null,
): string | null {
  const viewport = scrollContainer.getBoundingClientRect();
  const viewportTop = scrollContainer.scrollTop;
  const viewportBottom = viewportTop + scrollContainer.clientHeight;
  const alignmentTop = viewportTop + USER_TURN_NAV_SCROLL_OFFSET_PX;
  let candidate: { id: string; top: number } | null = null;

  for (const anchor of anchors) {
    const targetId = anchor.targetId ?? anchor.id;
    const row = findRenderRow(messageList, targetId);
    const rect = row?.getBoundingClientRect();
    const top = rect
      ? scrollContainer.scrollTop + rect.top - viewport.top
      : getRenderIdTop?.(targetId);
    if (top === null || top === undefined) continue;
    const bottom = rect ? top + rect.height : top + 1;
    const fullyVisible =
      top >= viewportTop - USER_TURN_NAV_VISIBILITY_TOLERANCE_PX &&
      bottom <= viewportBottom + USER_TURN_NAV_VISIBILITY_TOLERANCE_PX;
    if (fullyVisible) continue;

    if (
      direction === "previous" &&
      top < alignmentTop - USER_TURN_NAV_VISIBILITY_TOLERANCE_PX &&
      (!candidate || top > candidate.top)
    ) {
      candidate = { id: targetId, top };
    }
    if (
      direction === "next" &&
      top > alignmentTop + USER_TURN_NAV_VISIBILITY_TOLERANCE_PX &&
      (!candidate || top < candidate.top)
    ) {
      candidate = { id: targetId, top };
    }
  }

  return candidate?.id ?? null;
}

function getUserTurnNavigationDirection(
  event: KeyboardEvent,
): "previous" | "next" | null {
  const plainTurnKey =
    !event.metaKey &&
    !event.ctrlKey &&
    !event.altKey &&
    !event.shiftKey &&
    !isEditableKeyboardTarget(event.target);
  if (plainTurnKey && (event.key === "Home" || event.code === "Home")) {
    return "previous";
  }
  if (plainTurnKey && (event.key === "End" || event.code === "End")) {
    return "next";
  }
  if (
    event.altKey &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.shiftKey &&
    !event.getModifierState("AltGraph")
  ) {
    if (event.key === "ArrowUp" || event.code === "ArrowUp") {
      return "previous";
    }
    if (event.key === "ArrowDown" || event.code === "ArrowDown") {
      return "next";
    }
  }
  return null;
}

function loadSessionThinkingVisible(): boolean {
  try {
    return (
      globalThis.localStorage?.getItem(UI_KEYS.sessionThinkingVisible) !==
      "false"
    );
  } catch {
    return true;
  }
}

function saveSessionThinkingVisible(visible: boolean) {
  try {
    globalThis.localStorage?.setItem(
      UI_KEYS.sessionThinkingVisible,
      visible ? "true" : "false",
    );
  } catch {
    // localStorage is only a display preference; in-memory state still applies.
  }
}

// Auto-expand policy for thinking blocks. Off (default): every newly-arriving
// block stays expanded ("all-new"). On: only the most-recent block is
// auto-open; it auto-collapses once a newer block appears ("latest-only").
// Manual per-block toggles win over either policy. See
// topics/thinking-expand-latest-only.md.
function loadSessionThinkingLatestOnly(): boolean {
  try {
    return (
      globalThis.localStorage?.getItem(UI_KEYS.sessionThinkingLatestOnly) ===
      "true"
    );
  } catch {
    return false;
  }
}

function saveSessionThinkingLatestOnly(latestOnly: boolean) {
  try {
    globalThis.localStorage?.setItem(
      UI_KEYS.sessionThinkingLatestOnly,
      latestOnly ? "true" : "false",
    );
  } catch {
    // localStorage is only a display preference; in-memory state still applies.
  }
}

function providerExpandsHistoricalThinking(provider: string | undefined) {
  return provider === "pi";
}

/** Pending message waiting for server confirmation */
interface PendingMessage {
  tempId: string;
  content: string;
  timestamp: string;
  clientOrder?: number;
  status?: string;
  attachments?: UploadedFile[];
}

/** Deferred message queued server-side */
type DeferredMessage = SessionQueuedMessageSummary;

interface InlineProjectQueueMessage {
  id: string;
  content: string;
  timestamp: string;
  status: ProjectQueueItemStatus;
  projectPosition: number;
  attachmentCount?: number;
  attachments?: UploadedFile[];
  lastError?: string;
  isMutating?: boolean;
  canEdit?: boolean;
}

function formatQueuedAge(timestampMs: number, nowMs: number): string {
  const label = formatCompactRelativeAge(timestampMs, nowMs);
  return label === "now" ? "now" : `${label} ago`;
}

function getDeferredMessageStatus({
  isPatient,
  lanePosition,
  timestampMs,
  nowMs,
}: {
  isPatient: boolean;
  lanePosition: ComposerTailLanePosition | undefined;
  timestampMs: number | null;
  nowMs: number;
}): string {
  if (isPatient) {
    const age =
      timestampMs !== null ? formatQueuedAge(timestampMs, nowMs) : null;
    const position =
      lanePosition?.patientIndex === undefined
        ? ""
        : lanePosition.patientIndex === 0
          ? "waiting"
          : `#${lanePosition.patientIndex + 1}`;
    const detail = [position, age].filter(Boolean).join(", ");
    return detail ? `Patient (${detail})` : "Patient queued";
  }

  const regularIndex = lanePosition?.regularIndex ?? 0;
  return regularIndex === 0
    ? "Queued (next regular)"
    : `Queued regular (#${regularIndex + 1})`;
}

interface BtwAsideTimelineItem {
  id: string;
  request: string;
  followUps: string[];
  status: "draft" | "starting" | "running" | "complete" | "failed" | "stopped";
  createdAt: string;
  updatedAt: string;
  historyAt?: string;
  preview?: string;
  error?: string;
  responses: string[];
  turns?: BtwAsideTranscriptTurn[];
  expanded?: boolean;
  isFocused?: boolean;
  canStop?: boolean;
}

interface Props {
  messages: Message[];
  transcriptDisplayObjects?: readonly TranscriptDisplayObject[];
  provider?: string;
  isStreaming?: boolean;
  isProcessing?: boolean;
  /** True when context is being compressed */
  isCompacting?: boolean;
  /** Increment this to force scroll to bottom (e.g., when user sends a message) */
  scrollTrigger?: number;
  /**
   * Request to scroll the transcript to a render row by id (e.g. the composer
   * recall drawer's go-to-turn control). `token` distinguishes repeat requests
   * for the same id. Resolved via `scrollToRenderId` / `findRenderRow`.
   */
  scrollToTurnRequest?: { id: string; token: number } | null;
  /** Messages waiting for server confirmation (shown as "Sending...") */
  pendingMessages?: PendingMessage[];
  /** Deferred messages queued server-side (shown as "Queued") */
  deferredMessages?: DeferredMessage[];
  queuedEffortContext?: QueuedEffortContext;
  /** Project Queue items targeting this session (shown below local queue). */
  projectQueueMessages?: InlineProjectQueueMessage[];
  /** Whether global Project Queue dispatch is paused. */
  projectQueueDispatchPaused?: boolean;
  /** Whether global Project Queue pause state is changing. */
  projectQueueDispatchMutating?: boolean;
  /** YA-owned /btw cards that have entered the scrollback timeline. */
  btwAsides?: BtwAsideTimelineItem[];
  /** Focus this /btw aside for follow-up turns. */
  onFocusBtwAside?: (asideId: string) => void;
  /** Exit focused /btw follow-up mode. */
  onDoneBtwAside?: () => void;
  /** Interrupt/abort a running /btw aside. */
  onStopBtwAside?: (asideId: string) => void;
  /** Toggle the inline /btw transcript preview. */
  onToggleBtwAsideExpanded?: (asideId: string) => void;
  /** Insert a /btw transcript turn into the Mother composer. */
  onTransferBtwAsideTurn?: (text: string) => void;
  /** Append quoted assistant output to the composer. */
  onQuoteSelection?: (quotedText: string) => string | null;
  /** Open a same-project new-session composer seeded from selected output. */
  onStartNewSessionFromSelection?: (prefill: string) => void;
  /** Stable draft-change stream for quote tint reconciliation. */
  composerDraftSignal?: ComposerDraftSignal;
  /** Leaf-subscribed availability for moving queued text into the composer. */
  composerEditAvailabilityStore?: ComposerEditAvailabilityStore;
  /** Clear all comment anchors after the quoted turn is sent. */
  quoteClearSignal?: number;
  /** Callback to cancel a deferred message */
  onCancelDeferred?: (tempId: string) => void;
  /** Move a live deferred message back into an empty composer. */
  onEditDeferred?: (tempId: string) => void;
  /** Callback to cancel an optimistic steering send before the provider acts. */
  onCancelUnconfirmedUserMessage?: (tempId: string) => void;
  /** Steer a patient queued message, and earlier patient entries, into the session now */
  onSteerDeferred?: (tempId: string) => void;
  /** Callback to resume a restart-paused recovered queue entry */
  onResumeRecoveredDeferred?: (queueId: string) => void;
  /** Steer a restart-paused recovered entry, and earlier patient entries, into the session now */
  onSteerRecoveredDeferred?: (queueId: string) => void;
  /** Callback to delete a restart-paused recovered queue entry */
  onDeleteRecoveredDeferred?: (queueId: string) => void;
  /** Callback to cancel a Project Queue item */
  onCancelProjectQueueMessage?: (itemId: string) => void;
  /** Move a Project Queue item back into an empty composer. */
  onEditProjectQueueMessage?: (itemId: string) => void;
  /** Force a Project Queue item into the active session now. */
  onSteerProjectQueueMessage?: (itemId: string) => void;
  /** Resume global Project Queue dispatch from an inline item. */
  onResumeProjectQueueDispatch?: () => void;
  /** Callback to correct the latest actually-sent user message */
  onCorrectLatestUserMessage?: (messageId: string, content: string) => void;
  /** Callback to aggressively reload the client transcript from a user turn */
  onTrimBeforeUserMessage?: (messageId: string) => void;
  /** Fork the session from just before the given user message (real prefix fork only). */
  onForkBeforeUserMessage?: (messageId: string) => void;
  /** Fork after the completed turn for this user message, optionally with a summary. */
  onForkAfterUserMessage?: (messageId: string) => void;
  /** Enter the explicit fork-after-with-summary workflow for this user turn. */
  onForkAfterSummaryUserMessage?: (messageId: string) => void;
  /** The latest response is active, so after-turn boundaries are disabled. */
  forkAfterUserMessageDisabled?: boolean;
  /** Why otherwise-supported Fork actions need a server update. */
  forkUnavailableMessage?: string;
  /** Copy the given user turn's text (turn-notch context menu). */
  onCopyUserMessage?: (messageId: string) => void;
  /** Open a new session from this turn's in-memory conversation source. */
  onHandoffFromUserMessage?: (
    messageId: string,
    options: { newTab: boolean },
  ) => void;
  /** Pre-rendered markdown HTML from server (keyed by message ID) */
  markdownAugments?: Record<string, MarkdownAugment>;
  /** Active tool approval - prevents matching orphaned tool from showing as interrupted */
  activeToolApproval?: ActiveToolApproval;
  /** Whether there are older messages not yet loaded */
  hasOlderMessages?: boolean;
  /** Cursor identifying the next older transcript page */
  olderMessagesCursor?: string | null;
  /** Ephemeral signal incremented after an accepted active-window prefix trim. */
  activeWindowTrimRevision?: number;
  /** Whether older messages are currently being loaded */
  loadingOlder?: boolean;
  /** Whether older loading paused at its safety boundary before a user turn */
  olderLoadContinuationRequired?: boolean;
  /** Callback to load through older chunks to a user-turn boundary */
  onLoadOlderMessages?: () => void | Promise<void>;
  /** Read one bounded older page without retaining it in the active store. */
  onReadOlderSearchPage?: (
    beforeMessageId: string,
  ) => Promise<GetSessionResult>;
  /** Whether the client transcript is intentionally loaded from a recent tail */
  clientTailActive?: boolean;
  /** Render the recent transcript tail first, then hydrate older rows in batches. */
  progressiveRenderEnabled?: boolean;
  /** Show detailed progressive render text and progress bar while hydrating. */
  progressiveRenderStatusVisible?: boolean;
  /** Stable identity for one progressive initial-render cycle. */
  progressiveRenderKey?: string;
  /** Synchronous pause signal for retained-session layer swaps. */
  progressiveRenderPauseSignal?: {
    readonly current: boolean;
    supportsCompaction?: boolean;
  };
  /** Stable identity for ephemeral Conversation View history expansion. */
  conversationViewStateKey?: string;
  /** Force the shared Conversation View projection for an independent shell. */
  conversationViewEnabledOverride?: boolean;
  /** Whether a scrolled-away viewport offers the shared Follow affordance. */
  showFollowButton?: boolean;
  /** Optional floating container for the shared Follow affordance. */
  followButtonPortalTarget?: HTMLElement | null;
  /** Restore transient session chrome when Follow explicitly rejoins the tail. */
  onFollowCurrent?: () => void;
  initialScrollSnapshot?: SessionRouteScrollSnapshot | null;
  onScrollSnapshotChange?: (snapshot: SessionRouteScrollSnapshot) => void;
  /** Immediate live-tail intent; unlike route snapshots, this is not debounced. */
  onFollowingBottomChange?: (followingBottom: boolean) => void;
  scrollBehaviorMode?: SessionScrollBehaviorMode;
  inert?: boolean;
  transcriptPositionStore?: TranscriptPositionStore;
  onTranscriptPositionTimestampChange?: (timestampMs: number | null) => void;
  getForkSummaryTargetHref?: (targetSessionId: string) => string;
  onCancelForkSummary?: (objectId: string) => void;
  onToggleForkSummaryAutoOpen?: (objectId: string, value: boolean) => void;
  onFollowForkSummary?: (objectId: string) => void;
  bangCommandHandlers?: BangCommandHandlers;
}

function XIcon({ size = 14 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
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
  );
}

function PencilIcon({ size = 14 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </svg>
  );
}

function PlayIcon({ size = 14 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m8 5 11 7-11 7V5Z" />
    </svg>
  );
}

function BtwAsideTimelineCard({
  aside,
  onFocus,
  onDone,
  onStop,
  onToggleExpanded,
  onTransferTurn,
}: {
  aside: BtwAsideTimelineItem;
  onFocus?: (asideId: string) => void;
  onDone?: () => void;
  onStop?: (asideId: string) => void;
  onToggleExpanded?: (asideId: string) => void;
  onTransferTurn?: (text: string) => void;
}) {
  const { t } = useI18n();
  const canExpand = Boolean(
    aside.request ||
      aside.followUps.length > 0 ||
      aside.responses.length > 0 ||
      (aside.turns?.length ?? 0) > 0,
  );

  return (
    <div
      className={`btw-aside-card btw-aside-card-history is-${aside.status} ${
        aside.isFocused ? "is-focused" : ""
      }`}
      data-render-id={`btw-${aside.id}`}
    >
      <button
        type="button"
        className="btw-aside-main"
        onClick={() => onFocus?.(aside.id)}
      >
        <span className="btw-aside-meta">/btw {aside.status}</span>
        <span className="btw-aside-request">
          {aside.request || "New aside"}
        </span>
        {aside.followUps.length > 0 && (
          <span className="btw-aside-followups">
            +{aside.followUps.length} follow-up
            {aside.followUps.length === 1 ? "" : "s"}
          </span>
        )}
        {aside.preview && (
          <span className="btw-aside-preview">{aside.preview}</span>
        )}
        {aside.error && <span className="btw-aside-error">{aside.error}</span>}
      </button>
      {aside.expanded && canExpand && (
        <BtwAsideTranscript
          aside={aside}
          autoScrollLatest
          onTransferToComposer={onTransferTurn}
        />
      )}
      <div className="btw-aside-actions">
        {canExpand && (
          <button
            type="button"
            className="btw-aside-action"
            onClick={() => onToggleExpanded?.(aside.id)}
          >
            {aside.expanded ? "Less" : "Show"}
          </button>
        )}
        {aside.isFocused ? (
          <button
            type="button"
            className="btw-aside-action"
            onClick={onDone}
            title={t("btwAsideReturnComposerTitle")}
          >
            Done
          </button>
        ) : (
          <button
            type="button"
            className="btw-aside-action"
            onClick={() => onFocus?.(aside.id)}
          >
            Focus
          </button>
        )}
        {aside.canStop && (
          <button
            type="button"
            className="btw-aside-action btw-aside-action-stop"
            onClick={() => onStop?.(aside.id)}
            title={
              aside.isFocused
                ? "Stop this /btw aside and return to the main session"
                : "Stop this /btw aside"
            }
          >
            Stop
          </button>
        )}
      </div>
    </div>
  );
}

interface QueuedMessageActionsProps {
  variant: "session" | "project";
  text: string;
  composerEditAvailabilityStore?: ComposerEditAvailabilityStore;
  itemCanEdit?: boolean;
  disabled?: boolean;
  onResume?: () => void;
  onEdit?: () => void;
  onSteer?: () => void;
  steerLabel?: string;
  onCancel?: () => void;
}

const subscribeComposerEditAvailable = () => () => {};
const getComposerEditAvailable = () => true;

function QueuedMessageActions({
  variant,
  text,
  composerEditAvailabilityStore,
  itemCanEdit = true,
  disabled = false,
  onResume,
  onEdit,
  onSteer,
  steerLabel,
  onCancel,
}: QueuedMessageActionsProps) {
  const { t } = useI18n();
  const composerCanEdit = useSyncExternalStore(
    composerEditAvailabilityStore?.subscribe ?? subscribeComposerEditAvailable,
    composerEditAvailabilityStore?.getSnapshot ?? getComposerEditAvailable,
    getComposerEditAvailable,
  );
  const canEdit = itemCanEdit && composerCanEdit;
  const isProject = variant === "project";
  const editLabel = isProject
    ? t("projectQueueInlineEdit")
    : t("sessionQueuedEdit");
  const cancelLabel = isProject
    ? t("projectQueueInlineCancel")
    : t("sessionQueuedCancel");

  return (
    <div className="deferred-message-actions" data-queue-actions={variant}>
      <CopyTextButton
        text={text}
        label={isProject ? t("projectQueueInlineCopy") : t("sessionQueuedCopy")}
        className="deferred-message-action deferred-message-action-copy"
        showTextLabel
        onClick={(event) => event.stopPropagation()}
      />
      {onResume ? (
        <button
          type="button"
          className="deferred-message-action deferred-message-action-resume"
          disabled={disabled}
          onClick={onResume}
          aria-label={t("projectQueueResume")}
        >
          <PlayIcon />
          <span>{t("projectQueueResume")}</span>
        </button>
      ) : null}
      {canEdit && onEdit ? (
        <button
          type="button"
          className="deferred-message-action deferred-message-action-edit"
          disabled={disabled}
          onClick={onEdit}
          aria-label={editLabel}
          title={editLabel}
        >
          <PencilIcon />
          <span>{t("projectQueueEdit")}</span>
        </button>
      ) : null}
      {onSteer ? (
        <button
          type="button"
          className="deferred-message-action deferred-message-action-steer"
          disabled={disabled}
          onClick={onSteer}
          aria-label={steerLabel ?? t("sessionSteerQueuedMessageNow")}
          title={steerLabel ?? t("sessionSteerQueuedMessageNow")}
        >
          <PlayIcon />
          <span>{t("sessionSteerNow")}</span>
        </button>
      ) : null}
      {onCancel ? (
        <button
          type="button"
          className={`deferred-message-action deferred-message-action-cancel ${
            isProject ? "project-queue-inline-message-cancel" : ""
          }`}
          disabled={disabled}
          onClick={onCancel}
          aria-label={cancelLabel}
          title={cancelLabel}
        >
          <XIcon />
          <span>{t("projectQueueCancel")}</span>
        </button>
      ) : null}
    </div>
  );
}

type UserTimelineDisplayRow = Extract<
  TimelineEntryDisplayRow,
  { kind: "user" }
>;
type AssistantTimelineDisplayRow = Extract<
  TimelineEntryDisplayRow,
  { kind: "assistant" }
>;

interface UserTimelineEntryProps {
  row: UserTimelineDisplayRow;
  isStreaming: boolean;
  sessionProvider?: string;
  latestCorrectablePromptId?: string;
  latestCorrectablePromptContent?: string;
  onCorrectLatestUserMessage?: (messageId: string, content: string) => void;
  onCancelUnconfirmedUserMessage?: (tempId: string) => void;
  onTrimBeforeUserMessage?: (messageId: string) => void;
  onForkBeforeUserMessage?: (messageId: string) => void;
  onForkAfterUserMessage?: (messageId: string) => void;
  onForkAfterSummaryUserMessage?: (messageId: string) => void;
  canForkBeforePrompt: (messageId: string) => boolean;
  forkAfterUserMessageDisabled: boolean;
  forkUnavailableMessage?: string;
  noopToggleThinkingExpanded: () => void;
  promptActionsDisabled: boolean;
}

const UserTimelineEntry = memo(function UserTimelineEntry({
  row,
  isStreaming,
  sessionProvider,
  latestCorrectablePromptId,
  latestCorrectablePromptContent,
  onCorrectLatestUserMessage,
  onCancelUnconfirmedUserMessage,
  onTrimBeforeUserMessage,
  onForkBeforeUserMessage,
  onForkAfterUserMessage,
  onForkAfterSummaryUserMessage,
  canForkBeforePrompt,
  forkAfterUserMessageDisabled,
  forkUnavailableMessage,
  noopToggleThinkingExpanded,
  promptActionsDisabled,
}: UserTimelineEntryProps) {
  const { item } = row;
  return (
    <RenderItemComponent
      item={item}
      isStreaming={isStreaming}
      thinkingExpanded={false}
      toggleThinkingExpanded={noopToggleThinkingExpanded}
      sessionProvider={sessionProvider}
      onCorrectUserPrompt={
        row.isLatestCorrectable &&
        latestCorrectablePromptId &&
        latestCorrectablePromptContent !== undefined
          ? () =>
              onCorrectLatestUserMessage?.(
                latestCorrectablePromptId,
                latestCorrectablePromptContent,
              )
          : undefined
      }
      onCancelUnconfirmedUserPrompt={onCancelUnconfirmedUserMessage}
      onTrimBeforeUserPrompt={
        onTrimBeforeUserMessage &&
        row.allowsPromptActions &&
        !promptActionsDisabled
          ? () => onTrimBeforeUserMessage(item.id)
          : undefined
      }
      onForkBeforeUserPrompt={
        onForkBeforeUserMessage &&
        row.allowsPromptActions &&
        !promptActionsDisabled &&
        canForkBeforePrompt(item.id)
          ? () => onForkBeforeUserMessage(item.id)
          : undefined
      }
      onForkAfterUserPrompt={
        onForkAfterUserMessage &&
        row.allowsPromptActions &&
        !promptActionsDisabled
          ? () => onForkAfterUserMessage(item.id)
          : undefined
      }
      onForkAfterSummaryUserPrompt={
        onForkAfterSummaryUserMessage &&
        row.allowsPromptActions &&
        !promptActionsDisabled
          ? () => onForkAfterSummaryUserMessage(item.id)
          : undefined
      }
      forkAfterUserPromptDisabled={forkAfterUserMessageDisabled}
      forkUnavailableMessage={
        row.allowsPromptActions && !promptActionsDisabled
          ? forkUnavailableMessage
          : undefined
      }
      staleNowMs={row.staleNowMs}
    />
  );
});

interface AssistantTimelineEntryProps {
  row: AssistantTimelineDisplayRow;
  isStreaming: boolean;
  sessionProvider?: string;
  getThinkingItemExpanded: (item: RenderItem) => boolean;
  toggleThinkingItemExpanded: (item: RenderItem) => void;
  noopToggleThinkingExpanded: () => void;
  onTrimBeforeUserMessage?: (messageId: string) => void;
  onForkBeforeUserMessage?: (messageId: string) => void;
  onForkAfterUserMessage?: (messageId: string) => void;
  onForkAfterSummaryUserMessage?: (messageId: string) => void;
  canForkBeforePrompt: (messageId: string) => boolean;
  forkAfterUserMessageDisabled: boolean;
  forkUnavailableMessage?: string;
  handleQuoteTextBlock: (anchor: CommentAnchor) => void;
  alwaysShowQuoteCircles: boolean;
  paragraphQuoteCirclesEnabled: boolean;
  onToggleConversationActivity: (itemId: string) => void;
  widerConversationActivityPreviews: boolean;
  collapsedConversationThinkingPreviewSlots: ReadonlySet<ConversationThinkingPreviewSlot>;
  onToggleConversationThinkingPreview: (
    slot: ConversationThinkingPreviewSlot,
  ) => void;
  onDismissConversationThinkingPreview: (
    slot: ConversationThinkingPreviewSlot,
  ) => void;
  promptActionDisabledIds: ReadonlySet<string>;
}

const AssistantTimelineEntry = memo(function AssistantTimelineEntry({
  row,
  isStreaming,
  sessionProvider,
  getThinkingItemExpanded,
  toggleThinkingItemExpanded,
  noopToggleThinkingExpanded,
  onTrimBeforeUserMessage,
  onForkBeforeUserMessage,
  onForkAfterUserMessage,
  onForkAfterSummaryUserMessage,
  canForkBeforePrompt,
  forkAfterUserMessageDisabled,
  forkUnavailableMessage,
  handleQuoteTextBlock,
  alwaysShowQuoteCircles,
  paragraphQuoteCirclesEnabled,
  onToggleConversationActivity,
  widerConversationActivityPreviews,
  collapsedConversationThinkingPreviewSlots,
  onToggleConversationThinkingPreview,
  onDismissConversationThinkingPreview,
  promptActionDisabledIds,
}: AssistantTimelineEntryProps) {
  return (
    <AssistantTurnImageGallery items={row.group.items}>
      {row.rows.map((assistantRow) => {
        if (assistantRow.kind === "explored") {
          return (
            <ExploredToolGroup
              key={assistantRow.id}
              id={assistantRow.id}
              projection={assistantRow.projection}
              sessionProvider={sessionProvider}
              staleNowMs={assistantRow.staleNowMs}
            />
          );
        }

        const { item } = assistantRow;
        return (
          <RenderItemComponent
            key={item.id}
            item={item}
            isStreaming={isStreaming}
            thinkingExpanded={getThinkingItemExpanded(item)}
            toggleThinkingExpanded={
              assistantRow.allowsThinkingToggle
                ? () => toggleThinkingItemExpanded(item)
                : noopToggleThinkingExpanded
            }
            sessionProvider={sessionProvider}
            onTrimBeforeUserPrompt={
              onTrimBeforeUserMessage &&
              assistantRow.allowsPromptActions &&
              !promptActionDisabledIds.has(item.id)
                ? () => onTrimBeforeUserMessage(item.id)
                : undefined
            }
            onForkBeforeUserPrompt={
              onForkBeforeUserMessage &&
              assistantRow.allowsPromptActions &&
              !promptActionDisabledIds.has(item.id) &&
              canForkBeforePrompt(item.id)
                ? () => onForkBeforeUserMessage(item.id)
                : undefined
            }
            onForkAfterUserPrompt={
              onForkAfterUserMessage &&
              assistantRow.allowsPromptActions &&
              !promptActionDisabledIds.has(item.id)
                ? () => onForkAfterUserMessage(item.id)
                : undefined
            }
            onForkAfterSummaryUserPrompt={
              onForkAfterSummaryUserMessage &&
              assistantRow.allowsPromptActions &&
              !promptActionDisabledIds.has(item.id)
                ? () => onForkAfterSummaryUserMessage(item.id)
                : undefined
            }
            forkAfterUserPromptDisabled={forkAfterUserMessageDisabled}
            forkUnavailableMessage={
              assistantRow.allowsPromptActions &&
              !promptActionDisabledIds.has(item.id)
                ? forkUnavailableMessage
                : undefined
            }
            onQuoteTextBlock={
              assistantRow.allowsTextQuote ? handleQuoteTextBlock : undefined
            }
            alwaysShowQuoteCircle={alwaysShowQuoteCircles}
            paragraphQuoteCirclesEnabled={paragraphQuoteCirclesEnabled}
            staleNowMs={assistantRow.staleNowMs}
            thinkingDurationMs={assistantRow.thinkingDurationMs}
            onToggleConversationActivity={onToggleConversationActivity}
            widerConversationActivityPreviews={
              widerConversationActivityPreviews
            }
            collapsedConversationThinkingPreviewSlots={
              collapsedConversationThinkingPreviewSlots
            }
            onToggleConversationThinkingPreview={
              onToggleConversationThinkingPreview
            }
            onDismissConversationThinkingPreview={
              onDismissConversationThinkingPreview
            }
          />
        );
      })}
    </AssistantTurnImageGallery>
  );
});

export const MessageList = memo(function MessageList({
  messages,
  transcriptDisplayObjects = EMPTY_TRANSCRIPT_DISPLAY_OBJECTS,
  provider,
  isStreaming = false,
  isProcessing = false,
  isCompacting = false,
  scrollTrigger = 0,
  scrollToTurnRequest = null,
  pendingMessages = [],
  deferredMessages = [],
  queuedEffortContext,
  projectQueueMessages = [],
  projectQueueDispatchPaused = false,
  projectQueueDispatchMutating = false,
  btwAsides = [],
  onFocusBtwAside,
  onDoneBtwAside,
  onStopBtwAside,
  onToggleBtwAsideExpanded,
  onTransferBtwAsideTurn,
  onQuoteSelection,
  onStartNewSessionFromSelection,
  composerDraftSignal,
  composerEditAvailabilityStore,
  quoteClearSignal = 0,
  onCancelDeferred,
  onEditDeferred,
  onCancelUnconfirmedUserMessage,
  onSteerDeferred,
  onResumeRecoveredDeferred,
  onSteerRecoveredDeferred,
  onDeleteRecoveredDeferred,
  onCancelProjectQueueMessage,
  onEditProjectQueueMessage,
  onSteerProjectQueueMessage,
  onResumeProjectQueueDispatch,
  onCorrectLatestUserMessage,
  onTrimBeforeUserMessage,
  onForkBeforeUserMessage,
  onForkAfterUserMessage,
  onForkAfterSummaryUserMessage,
  forkAfterUserMessageDisabled = false,
  forkUnavailableMessage,
  onCopyUserMessage,
  onHandoffFromUserMessage,
  markdownAugments,
  activeToolApproval,
  hasOlderMessages = false,
  olderMessagesCursor = null,
  activeWindowTrimRevision = 0,
  loadingOlder = false,
  olderLoadContinuationRequired = false,
  onLoadOlderMessages,
  onReadOlderSearchPage,
  clientTailActive = false,
  progressiveRenderEnabled = false,
  progressiveRenderStatusVisible = true,
  progressiveRenderKey,
  progressiveRenderPauseSignal,
  conversationViewStateKey,
  conversationViewEnabledOverride,
  showFollowButton = true,
  followButtonPortalTarget,
  onFollowCurrent,
  initialScrollSnapshot = null,
  onScrollSnapshotChange,
  onFollowingBottomChange,
  scrollBehaviorMode = DEFAULT_SESSION_SCROLL_BEHAVIOR_MODE,
  inert = false,
  transcriptPositionStore,
  onTranscriptPositionTimestampChange,
  getForkSummaryTargetHref,
  onCancelForkSummary,
  onToggleForkSummaryAutoOpen,
  onFollowForkSummary,
  bangCommandHandlers,
}: Props) {
  const sessionViewerSessionId = useSessionViewerSessionId();
  useSessionViewerResumeRevision();
  const { recentProjectPathLinksEnabled } = useRecentProjectPathLinks();
  const { workflowTagsEnabled } = useWorkflowTags();
  const { files: workflowSchemaFiles, resolve: resolveWorkflowSchemaFiles } =
    useWorkflowSchemaFiles(workflowTagsEnabled && !inert);
  const transcriptRenderStartedAtMs = isBrowserDebugPerformanceRecording()
    ? highResolutionNowMs()
    : null;
  const firstMessageId = messages[0] ? getMessageId(messages[0]) : null;
  const [conversationViewEnabled, setConversationViewEnabled] = useState(
    getConversationViewPreference,
  );
  const effectiveConversationViewEnabled =
    conversationViewEnabledOverride ?? conversationViewEnabled;
  const historySearchStateKey = JSON.stringify([
    conversationViewStateKey,
    effectiveConversationViewEnabled,
  ]);
  const [storedHistorySearchWindow, setHistorySearchWindow] = useState<{
    cursor: string;
    messages: Message[];
    stateKey: string;
    transcriptDisplayObjects: readonly TranscriptDisplayObject[];
  } | null>(null);
  const historySearchWindow =
    storedHistorySearchWindow?.stateKey === historySearchStateKey
      ? storedHistorySearchWindow
      : null;
  const clearHistorySearchWindow = useCallback(() => {
    setHistorySearchWindow(null);
  }, []);
  const hydrateHistorySearchPage = useCallback(
    (cursor: string, page: GetSessionResult) => {
      const pageMessageIds = new Set(
        page.messages.flatMap((message) =>
          [message.uuid, message.id].filter(
            (id): id is string => typeof id === "string" && id.length > 0,
          ),
        ),
      );
      const pageDisplayObjects =
        page.session.transcriptDisplayObjects?.filter((object) =>
          object.placementAfterMessageId === ""
            ? page.pagination?.hasOlderMessages === false
            : pageMessageIds.has(object.placementAfterMessageId),
        ) ?? [];
      setHistorySearchWindow({
        cursor,
        messages: page.messages,
        stateKey: historySearchStateKey,
        transcriptDisplayObjects: pageDisplayObjects,
      });
    },
    [historySearchStateKey],
  );
  useLayoutEffect(() => {
    if (
      inert ||
      (storedHistorySearchWindow &&
        storedHistorySearchWindow.stateKey !== historySearchStateKey)
    ) {
      clearHistorySearchWindow();
    }
  }, [
    clearHistorySearchWindow,
    historySearchStateKey,
    inert,
    storedHistorySearchWindow,
  ]);
  const transcriptSnapshot = useMemo(
    () => ({
      activeWindowTrimRevision,
      firstMessageId,
      messages,
      olderMessagesCursor,
    }),
    [activeWindowTrimRevision, firstMessageId, messages, olderMessagesCursor],
  );
  const deferredTranscriptSnapshot = useDeferredValue(transcriptSnapshot);
  const renderedTranscriptMessages =
    deferredTranscriptSnapshot.activeWindowTrimRevision ===
      activeWindowTrimRevision &&
    deferredTranscriptSnapshot.firstMessageId === firstMessageId &&
    deferredTranscriptSnapshot.olderMessagesCursor === olderMessagesCursor
      ? deferredTranscriptSnapshot.messages
      : messages;
  const containerRef = useRef<HTMLDivElement>(null);
  const loadOlderBoundaryRef = useRef<HTMLDivElement>(null);
  const automaticOlderLoadAttemptRef = useRef<string | null>(null);
  const automaticOlderLoadRequiresExitRef = useRef(false);
  const loadOlderOnDemandRef = useRef<() => void>(() => {});
  const searchActiveRef = useRef(false);
  const historySearchWindowRef = useRef(historySearchWindow);
  historySearchWindowRef.current = historySearchWindow;
  const keyboardOlderLoadFrameRef = useRef<number | null>(null);
  const pendingOlderPageScrollRef = useRef<{
    wasAtBottom: boolean;
    scrollTop: number;
    scrollHeight: number;
    anchor: ReturnType<typeof getFirstVisibleRenderAnchor>;
  } | null>(null);
  const shouldAutoScrollRef = useRef(true);
  const previousInertRef = useRef(inert);
  const isInitialLoadRef = useRef(true);
  const pendingInitialScrollRestoreRef =
    useRef<SessionRouteScrollSnapshot | null>(null);
  const isProgrammaticScrollRef = useRef(false);
  const lastHeightRef = useRef(0);
  const lastFollowScrollTopRef = useRef(0);
  const touchStartYRef = useRef<number | null>(null);
  const followUpScrollRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const forcedCurrentScrollTimersRef = useRef<ReturnType<typeof setTimeout>[]>(
    [],
  );
  const programmaticScrollReleaseRef = useRef<ReturnType<
    typeof setTimeout
  > | null>(null);
  const progressiveActiveRenderKeyRef = useRef<string | null>(null);
  const progressiveCompletedRenderKeyRef = useRef<string | null>(null);
  const previousRenderItemsRef = useRef<RenderItem[]>([]);
  const previousThinkingTextLengthsRef = useRef<Map<string, number> | null>(
    null,
  );
  const observedThinkingItemIdsRef = useRef<ReadonlySet<string> | null>(null);
  const autoExpandedHistoricalThinkingProviderRef = useRef<string | null>(null);
  const thinkingDeltaFollowAllowedRef = useRef(false);
  const wasTurnActiveRef = useRef(false);
  const turnActiveRef = useRef(isProcessing || isStreaming);
  turnActiveRef.current = isProcessing || isStreaming;
  const navMotionCueTokenRef = useRef(0);
  const navMotionCueClearTimerRef = useRef<ReturnType<
    typeof setTimeout
  > | null>(null);
  const previousProgressiveRevealActiveRef = useRef(false);
  const settleSearchJumpFrameRef = useRef<number | null>(null);
  const revealRenderTargetFrameRef = useRef<number | null>(null);
  const scrollSnapshotWritesSuppressedRef = useRef(false);
  const previousScrollSnapshotWritesSuppressedRef = useRef(false);
  const previousActiveWindowTrimRevisionRef = useRef(activeWindowTrimRevision);
  const onFollowingBottomChangeRef = useRef(onFollowingBottomChange);
  onFollowingBottomChangeRef.current = onFollowingBottomChange;
  const [thinkingItemsVisible, setThinkingItemsVisible] = useState(() => {
    // "Show thinking" preference seeds the render gate's default; "default"
    // falls back to the live eye-toggle value. The eye icon still overrides
    // within a view.
    const showThinking = getShowThinkingSetting();
    if (showThinking === "on") return true;
    if (showThinking === "off") return false;
    return loadSessionThinkingVisible();
  });
  const [olderPageLoadCompletionRevision, setOlderPageLoadCompletionRevision] =
    useState(0);
  const previousConversationViewEnabledRef = useRef(
    effectiveConversationViewEnabled,
  );
  const [conversationViewTurnLimit, setConversationViewTurnLimit] = useState(
    getConversationViewTurnLimit,
  );
  const [conversationWindowExpansion, setConversationWindowExpansion] =
    useState({
      stateKey: conversationViewStateKey,
      bounded: false,
      additionalTurns: 0,
    });
  const [expandedConversationActivityIds, setExpandedConversationActivityIds] =
    useState<ReadonlySet<string>>(() => new Set());
  const [
    conversationThinkingPreviewState,
    setConversationThinkingPreviewState,
  ] = useState<{
    stateKey: string | undefined;
    collapsedSlots: ReadonlySet<ConversationThinkingPreviewSlot>;
    dismissedSlots: ReadonlySet<ConversationThinkingPreviewSlot>;
  }>(() => ({
    stateKey: conversationViewStateKey,
    collapsedSlots: new Set(),
    dismissedSlots: new Set(),
  }));
  const [thinkingExpansionOverrides, setThinkingExpansionOverrides] = useState<
    Record<string, boolean>
  >({});
  const [thinkingLatestOnly, setThinkingLatestOnly] = useState(
    loadSessionThinkingLatestOnly,
  );
  const [autoExpandedThinkingItemIds, setAutoExpandedThinkingItemIds] =
    useState<ReadonlySet<string>>(() => new Set());
  const [navMotionCue, setNavMotionCue] = useState<UserTurnNavMotionCue | null>(
    null,
  );
  const internalTranscriptPositionStore = useMemo(
    createTranscriptPositionStore,
    [],
  );
  const effectiveTranscriptPositionStore =
    transcriptPositionStore ?? internalTranscriptPositionStore;
  const hoveredMarkerTimestampMsRef = useRef<number | null>(null);
  const hoveredRowTimestampMsRef = useRef<number | null>(null);
  const scrollPositionTimestampMsRef = useRef<number | null>(null);
  const publishTranscriptPosition = useCallback(() => {
    effectiveTranscriptPositionStore.publish(
      hoveredMarkerTimestampMsRef.current ??
        hoveredRowTimestampMsRef.current ??
        scrollPositionTimestampMsRef.current,
    );
  }, [effectiveTranscriptPositionStore]);
  const [isScrolledToBottom, setIsScrolledToBottom] = useState(true);
  useEffect(
    () => () => {
      if (
        effectiveTranscriptPositionStore === internalTranscriptPositionStore
      ) {
        internalTranscriptPositionStore.dispose();
      } else {
        effectiveTranscriptPositionStore.publish(null);
      }
    },
    [effectiveTranscriptPositionStore, internalTranscriptPositionStore],
  );
  useEffect(() => {
    if (!onTranscriptPositionTimestampChange) return;
    onTranscriptPositionTimestampChange(
      effectiveTranscriptPositionStore.getSnapshot(),
    );
    const unsubscribe = effectiveTranscriptPositionStore.subscribe(() => {
      onTranscriptPositionTimestampChange(
        effectiveTranscriptPositionStore.getSnapshot(),
      );
    });
    return () => {
      unsubscribe();
      onTranscriptPositionTimestampChange(null);
    };
  }, [effectiveTranscriptPositionStore, onTranscriptPositionTimestampChange]);
  const [newOutputBelowVisible, setNewOutputBelowVisible] = useState(false);
  const rememberedDisclosureStateRegistry = useMemo(() => {
    // The registry belongs to one mounted session view, even though its
    // contents need no session key once that lifetime has been established.
    void conversationViewStateKey;
    return createRememberedDisclosureStateRegistry();
  }, [conversationViewStateKey]);
  const previousDisclosureOwnerCountRef = useRef<number | null>(null);
  const previousDisclosureTrimRevisionRef = useRef(activeWindowTrimRevision);
  const { t } = useI18n();
  const { widerConversationActivityPreviews } =
    useWiderConversationActivityPreviews();
  const nowMs = useRelativeNow();
  const conversationViewActivated =
    !previousConversationViewEnabledRef.current &&
    effectiveConversationViewEnabled;
  const conversationWindowIsBounded =
    conversationWindowExpansion.stateKey === conversationViewStateKey
      ? conversationWindowExpansion.bounded || conversationViewActivated
      : conversationViewActivated;
  const additionalConversationTurns =
    conversationWindowExpansion.stateKey === conversationViewStateKey
      ? conversationWindowExpansion.additionalTurns
      : 0;
  const collapsedConversationThinkingPreviewSlots =
    conversationThinkingPreviewState.stateKey === conversationViewStateKey
      ? conversationThinkingPreviewState.collapsedSlots
      : EMPTY_THINKING_PREVIEW_SLOTS;
  const dismissedConversationThinkingPreviewSlots =
    conversationThinkingPreviewState.stateKey === conversationViewStateKey
      ? conversationThinkingPreviewState.dismissedSlots
      : EMPTY_THINKING_PREVIEW_SLOTS;
  const reportFollowingBottom = useCallback((followingBottom: boolean) => {
    onFollowingBottomChangeRef.current?.(followingBottom);
  }, []);

  useLayoutEffect(() => {
    const previousEnabled = previousConversationViewEnabledRef.current;
    previousConversationViewEnabledRef.current =
      effectiveConversationViewEnabled;
    if (
      conversationWindowExpansion.stateKey === conversationViewStateKey &&
      previousEnabled === effectiveConversationViewEnabled
    ) {
      return;
    }
    setConversationWindowExpansion({
      stateKey: conversationViewStateKey,
      bounded: !previousEnabled && effectiveConversationViewEnabled,
      additionalTurns: 0,
    });
  }, [
    conversationViewStateKey,
    conversationWindowExpansion.stateKey,
    effectiveConversationViewEnabled,
  ]);

  // Scroll to bottom, marking it as programmatic so scroll handler ignores it
  const scrollToBottom = useCallback(
    (container: HTMLElement, behavior: ScrollBehavior = "auto") => {
      isProgrammaticScrollRef.current = true;
      if (programmaticScrollReleaseRef.current !== null) {
        clearTimeout(programmaticScrollReleaseRef.current);
        programmaticScrollReleaseRef.current = null;
      }
      const top = Math.max(0, container.scrollHeight - container.clientHeight);
      if (behavior === "auto") {
        container.scrollTop = top;
      } else {
        container.scrollTo({ top, behavior });
      }
      lastHeightRef.current = container.scrollHeight;
      lastFollowScrollTopRef.current = top;
      setIsScrolledToBottom(true);
      reportFollowingBottom(true);
      scrollPositionTimestampMsRef.current = null;
      publishTranscriptPosition();
      setNewOutputBelowVisible(false);

      // Clear programmatic flag after scroll events have fired
      const releaseProgrammaticScroll = () => {
        isProgrammaticScrollRef.current = false;
        programmaticScrollReleaseRef.current = null;
        if (isNearScrollBottom(container)) {
          shouldAutoScrollRef.current = true;
          setIsScrolledToBottom(true);
        }
      };
      if (behavior === "smooth") {
        programmaticScrollReleaseRef.current = setTimeout(
          releaseProgrammaticScroll,
          520,
        );
      } else {
        requestAnimationFrame(releaseProgrammaticScroll);
      }

      // Schedule a follow-up scroll to catch any async rendering (markdown, syntax highlighting)
      if (followUpScrollRef.current !== null) {
        clearTimeout(followUpScrollRef.current);
      }
      followUpScrollRef.current = setTimeout(() => {
        followUpScrollRef.current = null;
        if (shouldAutoScrollRef.current) {
          isProgrammaticScrollRef.current = true;
          const followUpTop = Math.max(
            0,
            container.scrollHeight - container.clientHeight,
          );
          if (behavior === "auto") {
            container.scrollTop = followUpTop;
          } else {
            container.scrollTo({ top: followUpTop, behavior });
          }
          lastHeightRef.current = container.scrollHeight;
          setIsScrolledToBottom(true);
          if (programmaticScrollReleaseRef.current === null) {
            requestAnimationFrame(() => {
              isProgrammaticScrollRef.current = false;
            });
          }
        }
      }, 50);
    },
    [publishTranscriptPosition, reportFollowingBottom],
  );

  const clearForcedCurrentScrollTimers = useCallback(() => {
    for (const timer of forcedCurrentScrollTimersRef.current) {
      clearTimeout(timer);
    }
    forcedCurrentScrollTimersRef.current = [];
  }, []);

  const clearFollowUpScrollTimer = useCallback(() => {
    if (followUpScrollRef.current !== null) {
      clearTimeout(followUpScrollRef.current);
      followUpScrollRef.current = null;
    }
  }, []);

  const stopFollowingForUserScroll = useCallback(
    (container: HTMLElement | null | undefined) => {
      pendingInitialScrollRestoreRef.current = null;
      shouldAutoScrollRef.current = false;
      thinkingDeltaFollowAllowedRef.current = false;
      isProgrammaticScrollRef.current = false;
      if (programmaticScrollReleaseRef.current !== null) {
        clearTimeout(programmaticScrollReleaseRef.current);
        programmaticScrollReleaseRef.current = null;
      }
      clearFollowUpScrollTimer();
      clearForcedCurrentScrollTimers();
      if (container) {
        lastHeightRef.current = container.scrollHeight;
      }
      setIsScrolledToBottom(false);
      reportFollowingBottom(false);
    },
    [
      clearFollowUpScrollTimer,
      clearForcedCurrentScrollTimers,
      reportFollowingBottom,
    ],
  );

  const forceScrollToCurrent = useCallback(
    (
      delays: readonly number[] = FOLLOW_CATCH_UP_DELAYS_MS,
      options: { allowThinkingDeltas?: boolean } = {},
    ) => {
      pendingInitialScrollRestoreRef.current = null;
      shouldAutoScrollRef.current = true;
      if (options.allowThinkingDeltas) {
        thinkingDeltaFollowAllowedRef.current = true;
      }
      const container = containerRef.current?.parentElement;
      if (container) {
        scrollToBottom(container);
      }

      clearForcedCurrentScrollTimers();
      forcedCurrentScrollTimersRef.current = delays.map((delay) =>
        setTimeout(() => {
          if (!shouldAutoScrollRef.current) {
            return;
          }
          const currentContainer = containerRef.current?.parentElement;
          if (currentContainer) {
            scrollToBottom(currentContainer);
          }
        }, delay),
      );
    },
    [clearForcedCurrentScrollTimers, scrollToBottom],
  );

  // On a turn ending, re-assert follow before the browser reacts to the
  // finalization height change. A completing turn collapses its bounded
  // thinking preview and recent-activity rows out of the flow (a shrink), and
  // the browser's clamp-fired scroll event would otherwise run the scroll
  // handler, read the shrink as a user scroll-away, and drop follow. Reading
  // shouldAutoScroll in a layout effect captures the pre-finalization intent
  // (scroll events dispatch after layout effects run), so a reader on the live
  // tail rides down to the new bottom instead of being stranded above it.
  useLayoutEffect(() => {
    const turnActive = isProcessing || isStreaming;
    const wasActive = wasTurnActiveRef.current;
    wasTurnActiveRef.current = turnActive;
    if (wasActive && !turnActive && shouldAutoScrollRef.current) {
      forceScrollToCurrent();
    }
  }, [isProcessing, isStreaming, forceScrollToCurrent]);

  // Preprocess messages into render items and group into turns
  const renderItems = useMemo(() => {
    const startedAt = highResolutionNowMs();
    markReloadPerfPhase("message_list_preprocess_start", {
      messages:
        renderedTranscriptMessages.length +
        (historySearchWindow?.messages.length ?? 0),
      markdownAugments: Object.keys(markdownAugments ?? {}).length,
      hasActiveToolApproval: !!activeToolApproval,
    });
    const loadedRenderItems = buildSessionDetailRenderItems({
      messages: renderedTranscriptMessages,
      provider,
      markdownAugments,
      activeToolApproval,
      transcriptDisplayObjects,
      previousRenderItems: previousRenderItemsRef.current,
      recentProjectPathLinksEnabled,
      workflowTagsEnabled,
      workflowSchemaFiles,
    });
    let nextRenderItems = loadedRenderItems;
    if (historySearchWindow) {
      const loadedMessageIds = new Set(
        renderedTranscriptMessages.map((message) => getMessageId(message)),
      );
      const historyMessages = historySearchWindow.messages.filter(
        (message) => !loadedMessageIds.has(getMessageId(message)),
      );
      const historicalRenderItems = buildSessionDetailRenderItems({
        messages: historyMessages,
        provider,
        transcriptDisplayObjects: historySearchWindow.transcriptDisplayObjects,
        previousRenderItems: previousRenderItemsRef.current,
        recentProjectPathLinksEnabled,
        workflowTagsEnabled,
        workflowSchemaFiles,
      });
      if (historicalRenderItems.length > 0) {
        const gapItems: RenderItem[] =
          historySearchWindow.cursor === olderMessagesCursor
            ? []
            : [
                {
                  type: "system" as const,
                  id: `history-search-gap:${historySearchWindow.cursor}`,
                  subtype: "history_search_gap",
                  content: t("sessionSearchHistoryGap"),
                  sourceMessages: [],
                },
              ];
        nextRenderItems = [
          ...historicalRenderItems,
          ...gapItems,
          ...loadedRenderItems,
        ];
      }
    }
    const durationMs = highResolutionNowMs() - startedAt;
    markReloadPerfPhase("message_list_preprocess_end", {
      messages: renderedTranscriptMessages.length,
      renderItems: nextRenderItems.length,
      durationMs,
    });
    if (isBrowserDebugPerformanceRecording()) {
      recordBrowserDebugPerformanceMetric("message-list.preprocess", {
        durationMs,
        count: 1,
      });
    }
    return nextRenderItems;
  }, [
    renderedTranscriptMessages,
    historySearchWindow,
    olderMessagesCursor,
    provider,
    markdownAugments,
    activeToolApproval,
    transcriptDisplayObjects,
    recentProjectPathLinksEnabled,
    workflowTagsEnabled,
    workflowSchemaFiles,
    t,
  ]);
  useEffect(() => {
    resolveWorkflowSchemaFiles(renderItems);
  }, [renderItems, resolveWorkflowSchemaFiles]);
  useEffect(() => {
    previousRenderItemsRef.current = renderItems;
  }, [renderItems]);
  const historySearchSourceMessageIds = useMemo(() => {
    if (!historySearchWindow) return EMPTY_RENDER_ID_SET;
    const loadedMessageIds = new Set(
      renderedTranscriptMessages.map((message) => getMessageId(message)),
    );
    const ids = new Set<string>();
    for (const message of historySearchWindow.messages) {
      const id = getMessageId(message);
      if (id && !loadedMessageIds.has(id)) ids.add(id);
    }
    return ids;
  }, [historySearchWindow, renderedTranscriptMessages]);
  const historySearchRenderIds = useMemo(() => {
    if (historySearchSourceMessageIds.size === 0) return EMPTY_RENDER_ID_SET;
    return new Set(
      renderItems.flatMap((item) =>
        item.sourceMessages.some((message) =>
          historySearchSourceMessageIds.has(getMessageId(message)),
        )
          ? [item.id]
          : [],
      ),
    );
  }, [historySearchSourceMessageIds, renderItems]);
  useEffect(() => {
    const previousOwnerCount = previousDisclosureOwnerCountRef.current;
    const trimRevisionChanged =
      previousDisclosureTrimRevisionRef.current !== activeWindowTrimRevision;
    previousDisclosureOwnerCountRef.current = renderItems.length;
    previousDisclosureTrimRevisionRef.current = activeWindowTrimRevision;

    if (
      rememberedDisclosureStateRegistry.size === 0 ||
      (!trimRevisionChanged &&
        previousOwnerCount !== null &&
        renderItems.length >= previousOwnerCount)
    ) {
      return;
    }

    rememberedDisclosureStateRegistry.pruneOwners(
      new Set(renderItems.map((item) => item.id)),
    );
  }, [
    activeWindowTrimRevision,
    rememberedDisclosureStateRegistry,
    renderItems,
  ]);
  const thinkingItemCount = useMemo(
    () => countThinkingItems(renderItems),
    [renderItems],
  );
  const hasThinkingItems = thinkingItemCount > 0;
  const isThinkingItemAutoExpanded = useCallback(
    (itemId: string) => autoExpandedThinkingItemIds.has(itemId),
    [autoExpandedThinkingItemIds],
  );
  // Most-recent thinking item; only meaningful in latest-only mode, where its
  // auto-openness is recomputed each render rather than stored, so the prior
  // block collapses with no mutation as soon as a newer one arrives.
  const lastThinkingItemId = useMemo(
    () => getLatestThinkingItemId(renderItems),
    [renderItems],
  );
  // Single source of truth for "is this thinking block expanded": an explicit
  // user toggle (tri-state: open / collapsed / absent) always wins; otherwise
  // the active auto policy decides. A manual expand is a permanent pin — the
  // override is never cleared — so it never auto-hides. See
  // topics/thinking-expand-latest-only.md.
  const resolveThinkingItemExpanded = useCallback(
    (itemId: string) => {
      const override = thinkingExpansionOverrides[itemId];
      if (override !== undefined) return override;
      return thinkingLatestOnly
        ? itemId === lastThinkingItemId
        : isThinkingItemAutoExpanded(itemId);
    },
    [
      isThinkingItemAutoExpanded,
      lastThinkingItemId,
      thinkingExpansionOverrides,
      thinkingLatestOnly,
    ],
  );
  const fullDisplayRenderItems = useMemo(
    () => getDisplayRenderItems(renderItems, { thinkingItemsVisible }),
    [renderItems, thinkingItemsVisible],
  );
  const conversationWindow = useMemo(
    () =>
      effectiveConversationViewEnabled &&
      conversationWindowIsBounded &&
      !historySearchWindow
        ? windowConversationViewItems(
            fullDisplayRenderItems,
            conversationViewTurnLimit + additionalConversationTurns,
          )
        : {
            hiddenTurnCount: 0,
            items: fullDisplayRenderItems,
            visibleTurnCount: 0,
          },
    [
      additionalConversationTurns,
      conversationViewTurnLimit,
      effectiveConversationViewEnabled,
      conversationWindowIsBounded,
      fullDisplayRenderItems,
      historySearchWindow,
    ],
  );
  const previousConversationRenderItemsRef = useRef<readonly RenderItem[]>([]);
  const displayRenderItems = useMemo(() => {
    if (!effectiveConversationViewEnabled) return fullDisplayRenderItems;
    const startedAt = highResolutionNowMs();
    const projected = projectConversationView(conversationWindow.items, {
      active: isProcessing || isStreaming,
      dismissedThinkingPreviewSlots: dismissedConversationThinkingPreviewSlots,
      expandedActivityIds: expandedConversationActivityIds,
      nowMs,
    });
    if (isBrowserDebugPerformanceRecording()) {
      recordBrowserDebugPerformanceMetric(
        "message-list.conversation-projection",
        {
          durationMs: highResolutionNowMs() - startedAt,
          category: isProcessing || isStreaming ? "active" : "idle",
        },
      );
    }
    return stabilizeRenderItems(
      previousConversationRenderItemsRef.current,
      projected,
    );
  }, [
    conversationWindow.items,
    dismissedConversationThinkingPreviewSlots,
    effectiveConversationViewEnabled,
    expandedConversationActivityIds,
    fullDisplayRenderItems,
    isProcessing,
    isStreaming,
    nowMs,
  ]);
  useEffect(() => {
    previousConversationRenderItemsRef.current =
      effectiveConversationViewEnabled ? displayRenderItems : [];
  }, [displayRenderItems, effectiveConversationViewEnabled]);
  const previousVisibleThinkingPreviewSlotsRef = useRef<
    ReadonlySet<ConversationThinkingPreviewSlot>
  >(EMPTY_THINKING_PREVIEW_SLOTS);
  const visibleConversationThinkingPreviewSlots = useMemo(() => {
    const slots = new Set<ConversationThinkingPreviewSlot>();
    for (const item of displayRenderItems) {
      if (item.type !== "conversation_activity") continue;
      for (const preview of item.thinkingPreviews ?? []) {
        slots.add(preview.slot);
      }
    }
    return reuseEqualSet(previousVisibleThinkingPreviewSlotsRef.current, slots);
  }, [displayRenderItems]);
  useEffect(() => {
    previousVisibleThinkingPreviewSlotsRef.current =
      visibleConversationThinkingPreviewSlots;
  }, [visibleConversationThinkingPreviewSlots]);
  useLayoutEffect(() => {
    const previousThinkingTextLengths = previousThinkingTextLengthsRef.current;
    const nextThinkingTextLengths = getThinkingTextLengths(renderItems);
    const visibleThinkingDelta = hasVisibleThinkingTextDelta({
      isThinkingItemExpanded: resolveThinkingItemExpanded,
      nextTextLengths: nextThinkingTextLengths,
      previousTextLengths: previousThinkingTextLengths,
      thinkingItemsVisible,
    });

    previousThinkingTextLengthsRef.current = nextThinkingTextLengths;

    if (visibleThinkingDelta && !thinkingDeltaFollowAllowedRef.current) {
      stopFollowingForUserScroll(containerRef.current?.parentElement);
    }
  }, [
    renderItems,
    resolveThinkingItemExpanded,
    stopFollowingForUserScroll,
    thinkingItemsVisible,
  ]);
  useLayoutEffect(() => {
    const previouslyObservedThinkingIds = observedThinkingItemIdsRef.current;
    const existingThinkingIds = getThinkingItemIds(renderItems);
    observedThinkingItemIdsRef.current = existingThinkingIds;
    const seedHistoricalThinking =
      existingThinkingIds.size > 0 &&
      providerExpandsHistoricalThinking(provider) &&
      autoExpandedHistoricalThinkingProviderRef.current !== provider;
    if (seedHistoricalThinking) {
      autoExpandedHistoricalThinkingProviderRef.current = provider ?? null;
    }

    setAutoExpandedThinkingItemIds((previous) => {
      return reconcileAutoExpandedThinkingItemIds({
        currentThinkingIds: existingThinkingIds,
        previouslyObservedThinkingIds,
        previousExpandedIds: previous,
        seedHistoricalThinking,
      });
    });
  }, [provider, renderItems]);
  const previousTurnGroupsRef = useRef<readonly RenderTurnGroup[]>([]);
  const turnGroups = useMemo(() => {
    const startedAt = highResolutionNowMs();
    const grouped = stabilizeRenderTurnGroups(
      previousTurnGroupsRef.current,
      groupRenderItemsIntoTurns(displayRenderItems),
    );
    const durationMs = highResolutionNowMs() - startedAt;
    markReloadPerfPhase("message_list_group_end", {
      renderItems: displayRenderItems.length,
      turnGroups: grouped.length,
      durationMs,
    });
    if (isBrowserDebugPerformanceRecording()) {
      recordBrowserDebugPerformanceMetric("message-list.group", {
        durationMs,
      });
    }
    return grouped;
  }, [displayRenderItems]);
  useEffect(() => {
    previousTurnGroupsRef.current = turnGroups;
  }, [turnGroups]);
  useLayoutEffect(() => {
    markReloadPerfPhase("message_list_commit_effect", {
      messages: renderedTranscriptMessages.length,
      renderItems: displayRenderItems.length,
      turnGroups: turnGroups.length,
    });
    if (isBrowserDebugPerformanceRecording()) {
      recordBrowserDebugPerformanceMetric("message-list.commit", {
        durationMs:
          transcriptRenderStartedAtMs === null
            ? 0
            : highResolutionNowMs() - transcriptRenderStartedAtMs,
        category: effectiveConversationViewEnabled
          ? "conversation-view"
          : "full-transcript",
      });
    }
  });
  const {
    active: searchActive,
    scope: searchScope,
    visibleTurnGroups,
    cancelSearchTargetPreparation,
    getNavigatorAnchors,
    searchState: userTurnNavSearchState,
    searchPanel,
    closeSearch,
    getSelectedSearchAnchorId,
    getSelectedSearchTargetId,
    handleSearchArrowKey,
    moveSearchSelection,
    openSearch,
    prepareSearchTarget,
    selectSearchMatch,
    stopSearchArrowRepeat,
  } = useMessageListIsearch({
    containerRef,
    conversationViewEnabled: effectiveConversationViewEnabled,
    displayRenderItems,
    hasOlderMessages,
    historySearchCursor: olderMessagesCursor,
    historySearchContextKey: historySearchStateKey,
    hydratedHistoryCursor: historySearchWindow?.cursor ?? null,
    inert,
    onHydrateHistorySearchPage: hydrateHistorySearchPage,
    onReadOlderSearchPage,
    provider,
    recentProjectPathLinksEnabled,
    thinkingItemsVisible,
    turnGroups,
  });
  searchActiveRef.current = searchActive;
  // Latest render data for settled scroll reads. Scrolling only schedules one
  // trailing measurement; it never scans the transcript DOM on the hot path.
  const displayRenderItemsRef = useRef(displayRenderItems);
  displayRenderItemsRef.current = displayRenderItems;
  const asyncQuestions = useAsyncQuestions();
  const observeAsyncQuestions = asyncQuestions?.observe;
  useLayoutEffect(() => {
    if (!inert) observeAsyncQuestions?.(displayRenderItems);
  }, [displayRenderItems, inert, observeAsyncQuestions]);
  const turnGroupsRef = useRef(turnGroups);
  turnGroupsRef.current = turnGroups;
  const restoreRetainedScrollPosition = useCallback(
    (snapshot: SessionRouteScrollSnapshot) => {
      const content = containerRef.current;
      const container = content?.parentElement;
      if (!content || !container) return false;

      let restored = false;
      const anchor = snapshot.anchor;
      if (anchor) {
        const row = findRenderRow(content, anchor.id);
        const fallbackRow = row
          ? null
          : findFallbackRenderAnchorRow(
              content,
              anchor,
              displayRenderItemsRef.current,
            );
        const targetRow = row ?? fallbackRow;
        if (targetRow) {
          restoreScrollToAnchorRow(container, targetRow, anchor.topOffset);
          restored = true;
        }
      }
      if (!restored) {
        const maxScrollTop = Math.max(
          0,
          container.scrollHeight - container.clientHeight,
        );
        container.scrollTop = Math.min(snapshot.scrollTop, maxScrollTop);
      }
      lastHeightRef.current = container.scrollHeight;
      return true;
    },
    [],
  );
  const latestSeenTurnRenderKey = useMemo(
    () => getLatestSeenTurnRenderKey(turnGroups),
    [turnGroups],
  );
  const updateScrollPositionTimestamp = useCallback(() => {
    const content = containerRef.current;
    const container = content?.parentElement;
    if (!content || !container) return;
    if (isAtScrollBottom(container, content)) {
      scrollPositionTimestampMsRef.current = null;
      publishTranscriptPosition();
      return;
    }
    const startedAtMs = isBrowserDebugPerformanceRecording()
      ? highResolutionNowMs()
      : null;
    const timestampMs = getTranscriptPositionTimestampMs(
      content,
      container,
      turnGroupsRef.current,
      displayRenderItemsRef.current,
    );
    if (startedAtMs !== null) {
      recordBrowserDebugPerformanceMetric("message-list.scroll-position", {
        durationMs: highResolutionNowMs() - startedAtMs,
        category: "settled",
      });
    }
    scrollPositionTimestampMsRef.current = timestampMs;
    publishTranscriptPosition();
  }, [publishTranscriptPosition]);

  const captureScrollSnapshot = useCallback(
    (container: HTMLElement, content: HTMLDivElement) => {
      const atBottom = isAtScrollBottom(container, content);
      const fallbackAnchor =
        getFirstVisibleRenderAnchor(
          content,
          container,
          displayRenderItemsRef.current,
        ) ?? undefined;
      const rowsById = new Map<string, HTMLElement>();
      for (const row of content.querySelectorAll<HTMLElement>(
        "[data-render-id]",
      )) {
        const id = row.dataset.renderId;
        if (id && !rowsById.has(id)) {
          rowsById.set(id, row);
        }
      }
      const cursor = deriveVisibleSessionScrollCursor({
        scrollContainer: container,
        groups: turnGroupsRef.current,
        rowsById,
        allItems: displayRenderItemsRef.current,
        turnActive: turnActiveRef.current,
      });
      const anchor = cursor.anchor ?? fallbackAnchor;
      return {
        atBottom,
        scrollTop: container.scrollTop,
        scrollHeight: container.scrollHeight,
        clientHeight: container.clientHeight,
        ...(anchor ? { anchor } : {}),
        ...(cursor.completedTurn
          ? { completedTurn: cursor.completedTurn }
          : {}),
        ...(cursor.seenTurn ? { seenTurn: cursor.seenTurn } : {}),
        following: shouldAutoScrollRef.current,
        updatedAtMs: Date.now(),
      };
    },
    [],
  );

  useEffect(() => {
    if (isScrolledToBottom) {
      scrollPositionTimestampMsRef.current = null;
      publishTranscriptPosition();
    }
  }, [isScrolledToBottom, publishTranscriptPosition]);

  // Row-start times for the transcript hover override: hovering a row (or a
  // turn-rail marker, which wins) retargets the composer "at N ago" from the
  // scroll position to that specific turn's start time — a tool row's start
  // is its command start. Mouse over the composer or dead space resolves no
  // row, restoring the scroll-position status quo.
  const rowStartTimestampsById = useMemo(() => {
    const byId = new Map<string, number>();
    for (const item of displayRenderItems) {
      const timestampMs = getEarliestMessageTimestampMs(item.sourceMessages);
      if (timestampMs !== null) {
        byId.set(item.id, timestampMs);
      }
    }
    return byId;
  }, [displayRenderItems]);

  const handleTranscriptPointerOver = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.pointerType && event.pointerType !== "mouse") {
        return;
      }
      // Projected child rows (explored-group entries, asides) carry render
      // ids absent from the items map; walk out to the owning item row.
      let row =
        (event.target as Element | null)?.closest?.("[data-render-id]") ?? null;
      let timestampMs: number | null = null;
      while (row) {
        const id = (row as HTMLElement).dataset.renderId;
        const mapped = id ? rowStartTimestampsById.get(id) : undefined;
        if (mapped !== undefined) {
          timestampMs = mapped;
          break;
        }
        row = row.parentElement?.closest?.("[data-render-id]") ?? null;
      }
      hoveredRowTimestampMsRef.current = timestampMs;
      publishTranscriptPosition();
    },
    [publishTranscriptPosition, rowStartTimestampsById],
  );

  const handleTranscriptPointerLeave = useCallback(() => {
    hoveredRowTimestampMsRef.current = null;
    publishTranscriptPosition();
  }, [publishTranscriptPosition]);
  const handlePreviewTimestampChange = useCallback(
    (timestampMs: number | null) => {
      hoveredMarkerTimestampMsRef.current = timestampMs;
      publishTranscriptPosition();
    },
    [publishTranscriptPosition],
  );
  const {
    anchoredRenderIds,
    alwaysShowQuoteCircles,
    paragraphQuoteCirclesEnabled,
    handleQuoteTextBlock,
    mobileSelectionActions,
    floatingSelectionActions,
    selectionContextMenu,
  } = useMessageListSelectionQuote({
    containerRef,
    inert,
    onQuoteSelection,
    onStartNewSessionFromSelection,
    composerDraftSignal,
    quoteClearSignal,
    isInteractiveTarget: isInteractiveScrollTarget,
  });
  const latestVisibleTimestampMs = useMemo(
    () =>
      getLatestVisibleTimestampMs({
        asides: btwAsides,
        deferredMessages,
        displayRenderItems,
        pendingMessages,
        projectQueueMessages,
      }),
    [
      displayRenderItems,
      pendingMessages,
      deferredMessages,
      projectQueueMessages,
      btwAsides,
    ],
  );
  const composerTailRows = useMemo(
    () =>
      buildComposerTailDisplayRows({
        deferredMessages,
        latestVisibleTimestampMs,
        nowMs,
        pendingMessages,
        projectQueueMessages,
        staleThresholdMs: MESSAGE_STALE_THRESHOLD_MS,
      }),
    [
      pendingMessages,
      deferredMessages,
      projectQueueMessages,
      latestVisibleTimestampMs,
      nowMs,
    ],
  );
  const latestCorrectablePrompt = useMemo(() => {
    if (!onCorrectLatestUserMessage) return null;
    return selectLatestCorrectablePrompt(renderItems);
  }, [renderItems, onCorrectLatestUserMessage]);
  const visibleTimelineEntries = useMemo(() => {
    return buildVisibleTimelineEntries({
      asides: btwAsides,
      turnGroups: visibleTurnGroups,
    });
  }, [btwAsides, visibleTurnGroups]);
  const progressiveRenderAllowed =
    progressiveRenderEnabled &&
    !searchActive &&
    visibleTimelineEntries.length > 0;
  const progressiveRenderCycleKey = progressiveRenderKey ?? "default";
  const progressiveInitialEntryCount = useMemo(
    () =>
      progressiveRenderAllowed
        ? getTailEntryCountForRenderItemTarget(
            visibleTimelineEntries,
            PROGRESSIVE_INITIAL_RENDER_ITEM_TARGET,
          )
        : visibleTimelineEntries.length,
    [progressiveRenderAllowed, visibleTimelineEntries],
  );
  const [progressiveEntryCount, setProgressiveEntryCount] = useState<
    number | null
  >(null);
  const [progressiveRenderStateKey, setProgressiveRenderStateKey] = useState<
    string | null
  >(null);
  const [progressiveRenderRevealed, setProgressiveRenderRevealed] =
    useState(false);
  const [retainedProgressiveWindowKey, setRetainedProgressiveWindowKey] =
    useState<string | null>(null);
  const retainedProgressiveHydrationStartedKeyRef = useRef<string | null>(null);
  const progressiveRenderPaused =
    inert ||
    progressiveRenderPauseSignal?.current === true ||
    isSessionViewerOpen(sessionViewerSessionId);
  const progressiveRenderCompactionActive =
    progressiveRenderPaused &&
    progressiveRenderPauseSignal?.supportsCompaction === true;
  const retainedProgressiveWindowActive =
    retainedProgressiveWindowKey === progressiveRenderCycleKey;
  useLayoutEffect(() => {
    if (progressiveRenderPauseSignal) {
      progressiveRenderPauseSignal.supportsCompaction =
        progressiveRenderEnabled && isScrolledToBottom;
    }
    return () => {
      if (progressiveRenderPauseSignal) {
        progressiveRenderPauseSignal.supportsCompaction = false;
      }
    };
  }, [
    isScrolledToBottom,
    progressiveRenderEnabled,
    progressiveRenderPauseSignal,
  ]);
  useLayoutEffect(() => {
    if (!progressiveRenderAllowed || !progressiveRenderCompactionActive) {
      return;
    }
    if (retainedProgressiveWindowKey !== progressiveRenderCycleKey) {
      setRetainedProgressiveWindowKey(progressiveRenderCycleKey);
    }
    retainedProgressiveHydrationStartedKeyRef.current = null;
    if (progressiveRenderStateKey !== progressiveRenderCycleKey) {
      setProgressiveRenderStateKey(progressiveRenderCycleKey);
    }
    if (progressiveEntryCount !== progressiveInitialEntryCount) {
      setProgressiveEntryCount(progressiveInitialEntryCount);
    }
  }, [
    progressiveEntryCount,
    progressiveInitialEntryCount,
    progressiveRenderAllowed,
    progressiveRenderCompactionActive,
    progressiveRenderCycleKey,
    progressiveRenderStateKey,
    retainedProgressiveWindowKey,
  ]);
  const progressiveEntryCountForCycle =
    progressiveRenderStateKey === progressiveRenderCycleKey
      ? progressiveRenderCompactionActive
        ? progressiveInitialEntryCount
        : progressiveEntryCount
      : null;
  const progressiveRenderRevealedForCycle =
    progressiveRenderStateKey === progressiveRenderCycleKey
      ? progressiveRenderRevealed
      : false;
  const progressiveRenderAlreadyCompleted =
    progressiveRenderAllowed &&
    progressiveCompletedRenderKeyRef.current === progressiveRenderCycleKey;
  const progressiveRevealActive =
    progressiveRenderAllowed &&
    !progressiveRenderAlreadyCompleted &&
    !progressiveRenderRevealedForCycle;
  const progressiveHydrationActive =
    progressiveRevealActive || retainedProgressiveWindowActive;
  const progressiveWindowActive =
    progressiveHydrationActive || progressiveRenderCompactionActive;
  const {
    effectiveEntryCount: effectiveProgressiveEntryCount,
    entries: progressiveTimelineEntries,
    percent: progressiveRenderPercent,
  } = useMemo(() => {
    return getProgressiveTimelineVisibility({
      entries: visibleTimelineEntries,
      entryCount: progressiveEntryCountForCycle,
      initialEntryCount: progressiveInitialEntryCount,
      revealActive: progressiveWindowActive,
    });
  }, [
    progressiveEntryCountForCycle,
    progressiveInitialEntryCount,
    progressiveWindowActive,
    visibleTimelineEntries,
  ]);
  const previousTimelineEntryRowsRef = useRef<
    readonly TimelineEntryDisplayRow<RenderTurnGroup, BtwAsideTimelineItem>[]
  >([]);
  const timelineEntryRows = useMemo(() => {
    const nextRows = buildTimelineEntryDisplayRows({
      entries: progressiveTimelineEntries,
      latestCorrectablePromptId: latestCorrectablePrompt?.id ?? null,
      latestVisibleTimestampMs,
      nowMs,
    });
    return stabilizeTimelineEntryDisplayRows(
      previousTimelineEntryRowsRef.current,
      nextRows,
    );
  }, [
    progressiveTimelineEntries,
    latestCorrectablePrompt?.id,
    latestVisibleTimestampMs,
    nowMs,
  ]);
  useEffect(() => {
    previousTimelineEntryRowsRef.current = timelineEntryRows;
  }, [timelineEntryRows]);
  const chunkedTimelinePrepend = useChunkedTimelinePrepend(
    timelineEntryRows,
    pendingOlderPageScrollRef.current !== null,
  );
  const initialScrollRestoreDecision = decideSessionScrollRestore({
    mode: scrollBehaviorMode,
    snapshot: initialScrollSnapshot,
    topTolerancePx: FOLLOW_BOTTOM_TOLERANCE_PX,
  });
  const renderWindowPinnedId =
    pendingOlderPageScrollRef.current?.anchor?.id ??
    pendingInitialScrollRestoreRef.current?.anchor?.id ??
    (isInitialLoadRef.current &&
    initialScrollRestoreDecision === "restore-position"
      ? (initialScrollSnapshot?.anchor?.id ?? null)
      : null);
  const transcriptRenderWindow = useTranscriptRenderWindow({
    containerRef,
    followTail: isScrolledToBottom || shouldAutoScrollRef.current,
    getRowTargetIds: getTimelineRowTargetIds,
    getRowWeight: getTimelineRowRenderWeight,
    pinnedRenderId: renderWindowPinnedId,
    retainedRenderIds: useMemo(
      () => [
        ...anchoredRenderIds,
        ...(asyncQuestions?.retainedRenderIds ?? []),
      ],
      [anchoredRenderIds, asyncQuestions?.retainedRenderIds],
    ),
    rows: chunkedTimelinePrepend.rows,
  });
  const firstPromptActionId = useMemo(() => {
    for (const row of timelineEntryRows) {
      if (row.kind === "user" && row.allowsPromptActions) {
        return row.item.id;
      }
      if (row.kind !== "assistant") continue;
      const prompt = row.rows.find(
        (candidate) =>
          candidate.kind === "item" && candidate.allowsPromptActions,
      );
      if (prompt?.kind === "item") return prompt.item.id;
    }
    return null;
  }, [timelineEntryRows]);
  const canForkBeforePrompt = useCallback(
    (messageId: string) =>
      !historySearchRenderIds.has(messageId) &&
      (messageId !== firstPromptActionId ||
        hasOlderMessages ||
        clientTailActive ||
        conversationWindow.hiddenTurnCount > 0),
    [
      clientTailActive,
      conversationWindow.hiddenTurnCount,
      firstPromptActionId,
      hasOlderMessages,
      historySearchRenderIds,
    ],
  );
  const canTrimHistoryAnchor = useCallback(
    (messageId: string) => !historySearchRenderIds.has(messageId),
    [historySearchRenderIds],
  );
  useEffect(() => {
    if (!progressiveRenderAllowed) {
      // Isearch temporarily shows its filtered rows. Do not reset the
      // progressive cycle here: closing search used to restart from the tail,
      // unmounting the selected match before Enter could jump to it.
      if (searchActive) {
        return;
      }
      progressiveActiveRenderKeyRef.current = null;
      setRetainedProgressiveWindowKey(null);
      setProgressiveRenderStateKey(null);
      setProgressiveEntryCount(null);
      setProgressiveRenderRevealed(true);
      return;
    }

    if (
      !retainedProgressiveWindowActive &&
      progressiveCompletedRenderKeyRef.current === progressiveRenderCycleKey
    ) {
      progressiveActiveRenderKeyRef.current = null;
      setProgressiveRenderStateKey(progressiveRenderCycleKey);
      setProgressiveEntryCount(visibleTimelineEntries.length);
      setProgressiveRenderRevealed(true);
      return;
    }

    if (progressiveActiveRenderKeyRef.current === progressiveRenderCycleKey) {
      return;
    }

    progressiveActiveRenderKeyRef.current = progressiveRenderCycleKey;
    setProgressiveRenderStateKey(progressiveRenderCycleKey);
    setProgressiveEntryCount(progressiveInitialEntryCount);
    setProgressiveRenderRevealed(false);
  }, [
    progressiveInitialEntryCount,
    progressiveRenderAllowed,
    progressiveRenderCycleKey,
    retainedProgressiveWindowActive,
    searchActive,
    visibleTimelineEntries.length,
  ]);
  useEffect(() => {
    if (
      progressiveRenderPaused ||
      !progressiveHydrationActive ||
      effectiveProgressiveEntryCount >= visibleTimelineEntries.length
    ) {
      return;
    }

    const resumeDelayMs =
      retainedProgressiveWindowActive &&
      retainedProgressiveHydrationStartedKeyRef.current !==
        progressiveRenderCycleKey
        ? PROGRESSIVE_RETAINED_RESUME_DELAY_MS
        : PROGRESSIVE_RENDER_BATCH_DELAY_MS;
    const timer = setTimeout(() => {
      if (
        progressiveRenderPauseSignal?.current ||
        isSessionViewerOpen(sessionViewerSessionId)
      ) {
        return;
      }
      if (retainedProgressiveWindowActive) {
        retainedProgressiveHydrationStartedKeyRef.current =
          progressiveRenderCycleKey;
      }
      startTransition(() => {
        setProgressiveEntryCount((current) => {
          if (
            progressiveRenderPauseSignal?.current ||
            isSessionViewerOpen(sessionViewerSessionId)
          ) {
            return current;
          }
          return getNextProgressiveEntryCount(
            visibleTimelineEntries,
            current ?? progressiveInitialEntryCount,
            retainedProgressiveWindowActive
              ? PROGRESSIVE_RETAINED_RENDER_ITEM_BATCH_TARGET
              : PROGRESSIVE_RENDER_ITEM_BATCH_TARGET,
          );
        });
      });
    }, resumeDelayMs);

    return () => clearTimeout(timer);
  }, [
    effectiveProgressiveEntryCount,
    progressiveInitialEntryCount,
    progressiveHydrationActive,
    progressiveRenderPaused,
    progressiveRenderPauseSignal,
    progressiveRenderCycleKey,
    retainedProgressiveWindowActive,
    sessionViewerSessionId,
    visibleTimelineEntries,
  ]);
  useEffect(() => {
    if (
      progressiveRenderPaused ||
      !progressiveHydrationActive ||
      effectiveProgressiveEntryCount < visibleTimelineEntries.length
    ) {
      return;
    }

    const timer = setTimeout(() => {
      if (
        progressiveRenderPauseSignal?.current ||
        isSessionViewerOpen(sessionViewerSessionId)
      ) {
        return;
      }
      if (retainedProgressiveWindowActive) {
        setRetainedProgressiveWindowKey(null);
      } else {
        progressiveCompletedRenderKeyRef.current = progressiveRenderCycleKey;
        progressiveActiveRenderKeyRef.current = null;
      }
      setProgressiveRenderStateKey(progressiveRenderCycleKey);
      setProgressiveEntryCount(visibleTimelineEntries.length);
      setProgressiveRenderRevealed(true);
    }, PROGRESSIVE_RENDER_REVEAL_DELAY_MS);

    return () => clearTimeout(timer);
  }, [
    effectiveProgressiveEntryCount,
    progressiveHydrationActive,
    progressiveRenderCycleKey,
    progressiveRenderPaused,
    progressiveRenderPauseSignal,
    retainedProgressiveWindowActive,
    sessionViewerSessionId,
    visibleTimelineEntries.length,
  ]);
  useLayoutEffect(() => {
    const wasProgressiveRevealActive =
      previousProgressiveRevealActiveRef.current;
    previousProgressiveRevealActiveRef.current = progressiveHydrationActive;

    if (
      !wasProgressiveRevealActive ||
      progressiveHydrationActive ||
      !shouldAutoScrollRef.current
    ) {
      return;
    }

    const container = containerRef.current?.parentElement;
    if (container) {
      scrollToBottom(container);
    }
  }, [progressiveHydrationActive, scrollToBottom]);

  const scrollSnapshotWritesSuppressed = progressiveHydrationActive;
  scrollSnapshotWritesSuppressedRef.current = scrollSnapshotWritesSuppressed;
  const publishScrollSnapshot = useCallback(() => {
    if (scrollSnapshotWritesSuppressedRef.current || !onScrollSnapshotChange) {
      return;
    }
    const content = containerRef.current;
    const container = content?.parentElement;
    if (!content || !container) return;
    onScrollSnapshotChange(captureScrollSnapshot(container, content));
  }, [captureScrollSnapshot, onScrollSnapshotChange]);

  useEffect(() => {
    if (
      inert ||
      !latestSeenTurnRenderKey ||
      !shouldAutoScrollRef.current ||
      scrollSnapshotWritesSuppressedRef.current
    ) {
      return;
    }
    const frame = requestAnimationFrame(publishScrollSnapshot);
    return () => cancelAnimationFrame(frame);
  }, [inert, latestSeenTurnRenderKey, publishScrollSnapshot]);

  const scrollSnapshotPublishTimerRef = useRef<ReturnType<
    typeof setTimeout
  > | null>(null);
  const clearScrollSnapshotPublishTimer = useCallback(() => {
    if (scrollSnapshotPublishTimerRef.current !== null) {
      clearTimeout(scrollSnapshotPublishTimerRef.current);
      scrollSnapshotPublishTimerRef.current = null;
    }
  }, []);
  const publishSettledScrollState = useCallback(() => {
    updateScrollPositionTimestamp();
    publishScrollSnapshot();
  }, [publishScrollSnapshot, updateScrollPositionTimestamp]);
  const scheduleSettledScrollState = useCallback(() => {
    clearScrollSnapshotPublishTimer();
    scrollSnapshotPublishTimerRef.current = setTimeout(() => {
      scrollSnapshotPublishTimerRef.current = null;
      publishSettledScrollState();
    }, SCROLL_SNAPSHOT_PUBLISH_DEBOUNCE_MS);
  }, [clearScrollSnapshotPublishTimer, publishSettledScrollState]);

  // Leave-time capture: flush the pending trailing capture and publish once
  // on unmount or on becoming inert — not on listener re-attachment.
  useEffect(() => {
    if (inert) {
      return;
    }
    return () => {
      clearScrollSnapshotPublishTimer();
      publishScrollSnapshot();
    };
  }, [inert, clearScrollSnapshotPublishTimer, publishScrollSnapshot]);

  useEffect(() => {
    const wasSuppressed = previousScrollSnapshotWritesSuppressedRef.current;
    previousScrollSnapshotWritesSuppressedRef.current =
      scrollSnapshotWritesSuppressed;
    if (inert || scrollSnapshotWritesSuppressed || !wasSuppressed) {
      return;
    }
    publishScrollSnapshot();
  }, [inert, publishScrollSnapshot, scrollSnapshotWritesSuppressed]);

  useLayoutEffect(() => {
    const previousRevision = previousActiveWindowTrimRevisionRef.current;
    previousActiveWindowTrimRevisionRef.current = activeWindowTrimRevision;
    if (activeWindowTrimRevision <= previousRevision) {
      return;
    }

    const container = containerRef.current?.parentElement;
    if (container && shouldAutoScrollRef.current) {
      scrollToBottom(container);
    }
    // Replace any route-memory anchor that referenced a removed prefix row,
    // including when a user-scroll race correctly prevents a forced jump.
    publishScrollSnapshot();
  }, [activeWindowTrimRevision, publishScrollSnapshot, scrollToBottom]);

  const getThinkingItemExpanded = useCallback(
    (item: RenderItem) =>
      item.type === "thinking" && resolveThinkingItemExpanded(item.id),
    [resolveThinkingItemExpanded],
  );

  const toggleThinkingItemExpanded = useCallback(
    (item: RenderItem) => {
      if (item.type !== "thinking") {
        return;
      }
      // Absolute write against the currently-resolved state, never cleared:
      // toggling open from the auto state pins it open permanently.
      const next = !resolveThinkingItemExpanded(item.id);
      setThinkingExpansionOverrides((previous) => ({
        ...previous,
        [item.id]: next,
      }));
    },
    [resolveThinkingItemExpanded],
  );

  const noopToggleThinkingExpanded = useCallback(() => {}, []);

  const pendingHeightChangeRestoreRef = useRef<(() => void) | null>(null);
  useLayoutEffect(() => {
    const restore = pendingHeightChangeRestoreRef.current;
    pendingHeightChangeRestoreRef.current = null;
    restore?.();
  });

  const preserveScrollAfterTranscriptHeightChange = useCallback(
    (
      mutate: () => void,
      preferredAnchorId?: string,
      forcePreferredAnchor = false,
    ) => {
      const messageList = containerRef.current;
      const scrollContainer = messageList?.parentElement;
      if (!messageList || !scrollContainer) {
        mutate();
        return;
      }

      const wasAtBottom =
        !forcePreferredAnchor && isNearScrollBottom(scrollContainer);
      const scrollTopBefore = scrollContainer.scrollTop;
      const scrollHeightBefore = scrollContainer.scrollHeight;
      const preferredAnchorRow =
        !wasAtBottom && preferredAnchorId
          ? findRenderRow(messageList, preferredAnchorId)
          : null;
      const anchorBefore = wasAtBottom
        ? null
        : preferredAnchorRow && preferredAnchorId
          ? {
              id: preferredAnchorId,
              topOffset:
                preferredAnchorRow.getBoundingClientRect().top -
                scrollContainer.getBoundingClientRect().top,
            }
          : getFirstVisibleRenderAnchor(messageList, scrollContainer);

      const restore = () => {
        const nextMessageList = containerRef.current;
        const nextScrollContainer =
          nextMessageList?.parentElement ?? scrollContainer;
        isProgrammaticScrollRef.current = true;

        if (wasAtBottom) {
          scrollToBottom(nextScrollContainer);
          return;
        }

        let restoredFromAnchor = false;
        if (anchorBefore && nextMessageList) {
          const row = findRenderRow(nextMessageList, anchorBefore.id);
          if (row) {
            const containerRect = nextScrollContainer.getBoundingClientRect();
            const rowRect = row.getBoundingClientRect();
            nextScrollContainer.scrollTop = Math.max(
              0,
              nextScrollContainer.scrollTop +
                rowRect.top -
                containerRect.top -
                anchorBefore.topOffset,
            );
            restoredFromAnchor = true;
          }
        }

        if (!restoredFromAnchor) {
          const heightDelta =
            nextScrollContainer.scrollHeight - scrollHeightBefore;
          nextScrollContainer.scrollTop = Math.max(
            0,
            scrollTopBefore + heightDelta,
          );
        }
        lastHeightRef.current = nextScrollContainer.scrollHeight;
        requestAnimationFrame(() => {
          isProgrammaticScrollRef.current = false;
        });
      };
      if (forcePreferredAnchor) {
        // Explicit disclosure keeps the clicked row fixed before paint.
        pendingHeightChangeRestoreRef.current = restore;
      } else {
        // Mode/window changes also rebuild the retained transcript window;
        // let that projection settle before restoring its visible anchor.
        requestAnimationFrame(() => requestAnimationFrame(restore));
      }
      mutate();
    },
    [scrollToBottom],
  );

  useEffect(
    () =>
      subscribeConversationViewPreference(() => {
        preserveScrollAfterTranscriptHeightChange(() => {
          setConversationViewEnabled(getConversationViewPreference());
        });
      }),
    [preserveScrollAfterTranscriptHeightChange],
  );

  useEffect(
    () =>
      subscribeConversationViewTurnLimit(() => {
        preserveScrollAfterTranscriptHeightChange(() => {
          setConversationViewTurnLimit(getConversationViewTurnLimit());
          setConversationWindowExpansion((previous) => ({
            stateKey: conversationViewStateKey,
            bounded:
              previous.stateKey === conversationViewStateKey
                ? previous.bounded
                : false,
            additionalTurns: 0,
          }));
        });
      }),
    [conversationViewStateKey, preserveScrollAfterTranscriptHeightChange],
  );

  const toggleConversationActivity = useCallback(
    (itemId: string) => {
      stopFollowingForUserScroll(containerRef.current?.parentElement);
      preserveScrollAfterTranscriptHeightChange(
        () => {
          setExpandedConversationActivityIds((previous) => {
            const next = new Set(previous);
            if (next.has(itemId)) {
              next.delete(itemId);
            } else {
              next.add(itemId);
            }
            return next;
          });
        },
        itemId,
        true,
      );
    },
    [preserveScrollAfterTranscriptHeightChange, stopFollowingForUserScroll],
  );

  const toggleThinkingItemsVisible = useCallback(() => {
    preserveScrollAfterTranscriptHeightChange(() => {
      const next = !thinkingItemsVisible;
      if (next) {
        setConversationThinkingPreviewState({
          stateKey: conversationViewStateKey,
          collapsedSlots: new Set(),
          dismissedSlots: new Set(),
        });
      }
      setThinkingItemsVisible(next);
      saveSessionThinkingVisible(next);
    });
  }, [
    conversationViewStateKey,
    preserveScrollAfterTranscriptHeightChange,
    thinkingItemsVisible,
  ]);

  const toggleConversationThinkingPreview = useCallback(
    (slot: ConversationThinkingPreviewSlot) => {
      preserveScrollAfterTranscriptHeightChange(() => {
        setConversationThinkingPreviewState((previous) => {
          const collapsedSlots = new Set(
            previous.stateKey === conversationViewStateKey
              ? previous.collapsedSlots
              : [],
          );
          if (collapsedSlots.has(slot)) {
            collapsedSlots.delete(slot);
          } else {
            collapsedSlots.add(slot);
          }
          return {
            stateKey: conversationViewStateKey,
            collapsedSlots,
            dismissedSlots:
              previous.stateKey === conversationViewStateKey
                ? previous.dismissedSlots
                : new Set(),
          };
        });
      });
    },
    [conversationViewStateKey, preserveScrollAfterTranscriptHeightChange],
  );

  const dismissConversationThinkingPreview = useCallback(
    (slot: ConversationThinkingPreviewSlot) => {
      preserveScrollAfterTranscriptHeightChange(() => {
        setConversationThinkingPreviewState((previous) => {
          const dismissedSlots = new Set(
            previous.stateKey === conversationViewStateKey
              ? previous.dismissedSlots
              : [],
          );
          dismissedSlots.add(slot);
          return {
            stateKey: conversationViewStateKey,
            collapsedSlots:
              previous.stateKey === conversationViewStateKey
                ? previous.collapsedSlots
                : new Set(),
            dismissedSlots,
          };
        });
        const hasRemainingPreview = Array.from(
          visibleConversationThinkingPreviewSlots,
        ).some((visibleSlot) => visibleSlot !== slot);
        if (!hasRemainingPreview) {
          setThinkingItemsVisible(false);
          saveSessionThinkingVisible(false);
        }
      });
    },
    [
      conversationViewStateKey,
      preserveScrollAfterTranscriptHeightChange,
      visibleConversationThinkingPreviewSlots,
    ],
  );

  // The explicit "show me everything" gesture: auto-expand every thinking
  // block currently in the transcript (historical blocks included, unlike the
  // all-new policy's since-mount seeding). Earlier manual collapses yield to
  // it; manual-open pins are unaffected. See
  // topics/thinking-expand-latest-only.md.
  const expandAllThinkingItems = useCallback(() => {
    setAutoExpandedThinkingItemIds(getThinkingItemIds(renderItems));
    setThinkingExpansionOverrides((previous) => {
      if (!Object.values(previous).includes(false)) return previous;
      return Object.fromEntries(
        Object.entries(previous).filter(([, open]) => open),
      );
    });
  }, [renderItems]);

  // Right-click / long-press on the thought-transcript toggle. From hidden or
  // latest-only it reveals thinking and expands the full history; from the
  // everything-expanded state it drops back to latest-only.
  const toggleThinkingLatestOnly = useCallback(() => {
    preserveScrollAfterTranscriptHeightChange(() => {
      if (!thinkingItemsVisible || thinkingLatestOnly) {
        if (!thinkingItemsVisible) {
          setThinkingItemsVisible(true);
          saveSessionThinkingVisible(true);
          setConversationThinkingPreviewState({
            stateKey: conversationViewStateKey,
            collapsedSlots: new Set(),
            dismissedSlots: new Set(),
          });
        }
        if (thinkingLatestOnly) {
          setThinkingLatestOnly(false);
          saveSessionThinkingLatestOnly(false);
        }
        expandAllThinkingItems();
        return;
      }
      setThinkingLatestOnly(true);
      saveSessionThinkingLatestOnly(true);
    });
  }, [
    expandAllThinkingItems,
    conversationViewStateKey,
    preserveScrollAfterTranscriptHeightChange,
    thinkingItemsVisible,
    thinkingLatestOnly,
  ]);

  const showNavMotionCue = useCallback((direction: "up" | "down") => {
    if (navMotionCueClearTimerRef.current !== null) {
      clearTimeout(navMotionCueClearTimerRef.current);
    }
    navMotionCueTokenRef.current += 1;
    setNavMotionCue({
      direction,
      token: navMotionCueTokenRef.current,
    });
    navMotionCueClearTimerRef.current = setTimeout(() => {
      setNavMotionCue(null);
      navMotionCueClearTimerRef.current = null;
    }, NAV_MOTION_CUE_CLEAR_MS);
  }, []);

  const scrollToRenderId = useCallback(
    (
      id: string,
      behavior: ScrollBehavior,
      align: "start" | "center" = "start",
      showMotionCue = false,
      questionId?: string,
    ) => {
      const messageList = containerRef.current;
      const scrollContainer = messageList?.parentElement;
      if (!scrollContainer) return;
      pendingInitialScrollRestoreRef.current = null;
      shouldAutoScrollRef.current = false;
      setIsScrolledToBottom(false);
      const scrollMountedRow = (withMotionCue: boolean): boolean => {
        const currentList = containerRef.current;
        const currentContainer = currentList?.parentElement;
        const row = questionId
          ? currentList?.querySelector<HTMLElement>(
              `[data-async-question-reply="${CSS.escape(questionId)}"]`,
            )
          : findRenderRow(currentList, id);
        if (!currentContainer || !row?.isConnected) return false;
        const scrollRect = currentContainer.getBoundingClientRect();
        const rowRect = row.getBoundingClientRect();
        if (rowRect.width === 0 && rowRect.height === 0) return false;
        const offset =
          align === "center"
            ? Math.max(0, (currentContainer.clientHeight - rowRect.height) / 2)
            : 12;
        const nextTop = Math.max(
          0,
          currentContainer.scrollTop + rowRect.top - scrollRect.top - offset,
        );
        if (Math.abs(nextTop - currentContainer.scrollTop) < 1) {
          if (questionId)
            row
              .querySelector<HTMLTextAreaElement>("textarea")
              ?.focus({ preventScroll: true });
          return true;
        }
        if (withMotionCue) {
          showNavMotionCue(
            nextTop < currentContainer.scrollTop ? "up" : "down",
          );
        }
        if (typeof currentContainer.scrollTo === "function") {
          currentContainer.scrollTo({ top: nextTop, behavior });
        } else {
          currentContainer.scrollTop = nextTop;
        }
        if (questionId)
          row
            .querySelector<HTMLTextAreaElement>("textarea")
            ?.focus({ preventScroll: true });
        return true;
      };

      if (scrollMountedRow(showMotionCue)) return;
      const estimatedTop = transcriptRenderWindow.getRenderIdTop(id);
      if (estimatedTop === null || !transcriptRenderWindow.revealRenderId(id)) {
        return;
      }
      const estimatedOffset =
        align === "center" ? scrollContainer.clientHeight / 2 : 12;
      const nextTop = Math.max(0, estimatedTop - estimatedOffset);
      if (showMotionCue) {
        showNavMotionCue(nextTop < scrollContainer.scrollTop ? "up" : "down");
      }
      if (typeof scrollContainer.scrollTo === "function") {
        scrollContainer.scrollTo({ top: nextTop, behavior });
      } else {
        scrollContainer.scrollTop = nextTop;
      }
      if (revealRenderTargetFrameRef.current !== null) {
        cancelAnimationFrame(revealRenderTargetFrameRef.current);
      }
      let attemptsRemaining = 2;
      const settleRevealedRow = () => {
        revealRenderTargetFrameRef.current = requestAnimationFrame(() => {
          revealRenderTargetFrameRef.current = null;
          if (!scrollMountedRow(false) && attemptsRemaining > 0) {
            attemptsRemaining -= 1;
            settleRevealedRow();
          }
        });
      };
      settleRevealedRow();
    },
    [
      showNavMotionCue,
      transcriptRenderWindow.getRenderIdTop,
      transcriptRenderWindow.revealRenderId,
    ],
  );

  const questionNavigation = asyncQuestions?.navigation;
  const questionJumpFrameRef = useRef<number | null>(null);
  const questionNavigationTarget = asyncQuestions?.navigationTarget;
  useLayoutEffect(() => {
    if (!questionNavigation || inert) return;
    const navigation = {
      capture: () => {
        const content = containerRef.current;
        const container = content?.parentElement;
        return content && container
          ? captureScrollSnapshot(container, content)
          : null;
      },
      jump: (id: string, questionId: string) => {
        stopFollowingForUserScroll(containerRef.current?.parentElement);
        if (questionJumpFrameRef.current !== null)
          cancelAnimationFrame(questionJumpFrameRef.current);
        questionJumpFrameRef.current = requestAnimationFrame(() => {
          questionJumpFrameRef.current = null;
          scrollToRenderId(id, "auto", "center", true, questionId);
        });
      },
      restore: (snapshot: SessionRouteScrollSnapshot) => {
        if (questionJumpFrameRef.current !== null)
          cancelAnimationFrame(questionJumpFrameRef.current);
        questionJumpFrameRef.current = null;
        if (snapshot.following) {
          forceScrollToCurrent(undefined, { allowThinkingDeltas: true });
          return;
        }
        stopFollowingForUserScroll(containerRef.current?.parentElement);
        pendingInitialScrollRestoreRef.current = snapshot;
        if (snapshot.anchor)
          transcriptRenderWindow.revealRenderId(snapshot.anchor.id);
        restoreRetainedScrollPosition(snapshot);
      },
    };
    questionNavigation.current = navigation;
    return () => {
      if (questionNavigation.current === navigation)
        questionNavigation.current = null;
    };
  }, [
    questionNavigation,
    inert,
    captureScrollSnapshot,
    stopFollowingForUserScroll,
    scrollToRenderId,
    forceScrollToCurrent,
    restoreRetainedScrollPosition,
    transcriptRenderWindow.revealRenderId,
  ]);

  useLayoutEffect(() => {
    // Initial hydration hides transcript rows. Wait for their reveal before
    // consuming navigation, so scrolling and textarea focus can take effect.
    if (!inert && !progressiveRevealActive && questionNavigationTarget) {
      questionNavigation?.current?.jump(
        questionNavigationTarget.renderId,
        questionNavigationTarget.questionId,
      );
    }
  }, [
    inert,
    progressiveRevealActive,
    questionNavigation,
    questionNavigationTarget,
  ]);

  useEffect(
    () => () => {
      if (questionJumpFrameRef.current !== null)
        cancelAnimationFrame(questionJumpFrameRef.current);
      if (revealRenderTargetFrameRef.current !== null) {
        cancelAnimationFrame(revealRenderTargetFrameRef.current);
        revealRenderTargetFrameRef.current = null;
      }
    },
    [],
  );

  const beginTurnNavigation = useCallback(() => {
    shouldAutoScrollRef.current = false;
    setIsScrolledToBottom(false);
    reportFollowingBottom(false);
    scheduleSettledScrollState();
  }, [reportFollowingBottom, scheduleSettledScrollState]);

  const jumpToSearchTarget = useCallback(
    (targetId: string, settle = true) => {
      beginTurnNavigation();
      scrollToRenderId(targetId, "auto", "center", true);
      if (!settle) {
        return;
      }
      if (settleSearchJumpFrameRef.current !== null) {
        cancelAnimationFrame(settleSearchJumpFrameRef.current);
      }
      settleSearchJumpFrameRef.current = requestAnimationFrame(() => {
        settleSearchJumpFrameRef.current = requestAnimationFrame(() => {
          settleSearchJumpFrameRef.current = null;
          // Recap/activity/synthetic rows often reflow after the first
          // geometry read. Re-center once on settled heights so the rail
          // preview and the landed viewport agree.
          scrollToRenderId(targetId, "auto", "center", false);
        });
      });
    },
    [beginTurnNavigation, scrollToRenderId],
  );
  useEffect(
    () => () => {
      if (settleSearchJumpFrameRef.current !== null) {
        cancelAnimationFrame(settleSearchJumpFrameRef.current);
        settleSearchJumpFrameRef.current = null;
      }
    },
    [],
  );

  const completeProgressiveReveal = useCallback(() => {
    progressiveCompletedRenderKeyRef.current = progressiveRenderCycleKey;
    progressiveActiveRenderKeyRef.current = null;
    setRetainedProgressiveWindowKey(null);
  }, [progressiveRenderCycleKey]);

  const commitSearchJump = useCallback(
    (targetId: string) => {
      completeProgressiveReveal();
      jumpToSearchTarget(targetId, false);
      preserveScrollAfterTranscriptHeightChange(
        () => {
          closeSearch(false);
          requestAnimationFrame(() => {
            scrollToRenderId(targetId, "auto", "center", false);
          });
        },
        targetId,
        true,
      );
    },
    [
      closeSearch,
      completeProgressiveReveal,
      jumpToSearchTarget,
      preserveScrollAfterTranscriptHeightChange,
      scrollToRenderId,
    ],
  );

  const startSearch = useCallback(
    (scope: SessionIsearchScope) => {
      beginTurnNavigation();
      openSearch(scope);
    },
    [beginTurnNavigation, openSearch],
  );

  const handleSearchMatchSelect = useCallback(
    (id: string, targetId: string) => {
      selectSearchMatch(id, targetId);
      const preparedTarget = prepareSearchTarget(id);
      if (preparedTarget instanceof Promise) {
        void preparedTarget.then((hydratedTargetId) => {
          if (!hydratedTargetId) return;
          requestAnimationFrame(() => jumpToSearchTarget(hydratedTargetId));
        });
      } else if (preparedTarget) {
        jumpToSearchTarget(preparedTarget);
      }
    },
    [jumpToSearchTarget, prepareSearchTarget, selectSearchMatch],
  );

  const scrollToCurrent = useCallback(() => {
    setNewOutputBelowVisible(false);
    cancelSearchTargetPreparation();
    clearHistorySearchWindow();
    forceScrollToCurrent(FOLLOW_CATCH_UP_DELAYS_MS, {
      allowThinkingDeltas: true,
    });
  }, [
    cancelSearchTargetPreparation,
    clearHistorySearchWindow,
    forceScrollToCurrent,
  ]);

  const navigateToAdjacentHiddenUserTurn = useCallback(
    (direction: "previous" | "next", requestOlderWhenMissing = true) => {
      const messageList = containerRef.current;
      const scrollContainer = messageList?.parentElement;
      if (!messageList || !scrollContainer) return;
      const targetId = getAdjacentHiddenUserTurnTarget(
        getNavigatorAnchors(),
        messageList,
        scrollContainer,
        direction,
        transcriptRenderWindow.getRenderIdTop,
      );
      if (!targetId) {
        if (direction === "previous" && requestOlderWhenMissing) {
          loadOlderOnDemandRef.current();
        }
        return;
      }
      reportFollowingBottom(false);
      scrollToRenderId(targetId, "auto", "start", true);
      scheduleSettledScrollState();
    },
    [
      getNavigatorAnchors,
      reportFollowingBottom,
      scheduleSettledScrollState,
      scrollToRenderId,
      transcriptRenderWindow.getRenderIdTop,
    ],
  );

  useEffect(() => {
    if (inert) {
      stopSearchArrowRepeat();
      return;
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) {
        return;
      }
      if (
        event.ctrlKey &&
        !event.metaKey &&
        !event.altKey &&
        !event.shiftKey &&
        (event.key === "End" ||
          event.code === "End" ||
          event.key === "." ||
          event.code === "Period")
      ) {
        event.preventDefault();
        event.stopPropagation();
        scrollToCurrent();
        return;
      }
      const turnNavigationDirection = searchActive
        ? null
        : getUserTurnNavigationDirection(event);
      if (turnNavigationDirection) {
        event.preventDefault();
        event.stopPropagation();
        navigateToAdjacentHiddenUserTurn(
          turnNavigationDirection,
          !event.repeat,
        );
        return;
      }
      if (isCtrlKeyShortcut(event, "o", "KeyO")) {
        event.preventDefault();
        event.stopPropagation();
        toggleThinkingItemsVisible();
        return;
      }
      const requestedScope = getSessionIsearchShortcutScope(event);
      if (requestedScope) {
        event.preventDefault();
        event.stopPropagation();
        if (searchActive && searchScope === requestedScope) {
          moveSearchSelection("previous");
        } else {
          startSearch(requestedScope);
        }
        return;
      }
      if (!searchActive) {
        return;
      }
      if (event.key === "ArrowUp" || event.key === "ArrowDown") {
        event.preventDefault();
        event.stopPropagation();
        const direction = event.key === "ArrowUp" ? "previous" : "next";
        handleSearchArrowKey(direction, event.repeat);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        stopSearchArrowRepeat();
        closeSearch(true);
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        event.stopPropagation();
        const selectedAnchorId = getSelectedSearchAnchorId();
        const selectedTargetId = getSelectedSearchTargetId();
        stopSearchArrowRepeat();
        if (selectedAnchorId && selectedTargetId) {
          // Same jump as clicking the highlighted match; then close while
          // pinning that row so unhiding non-matches cannot move it.
          const preparedTarget = prepareSearchTarget(selectedAnchorId);
          if (preparedTarget instanceof Promise) {
            void preparedTarget.then((hydratedTargetId) => {
              if (!hydratedTargetId) return;
              requestAnimationFrame(() => commitSearchJump(hydratedTargetId));
            });
          } else if (preparedTarget) {
            commitSearchJump(preparedTarget);
          }
        } else {
          closeSearch(false);
        }
      }
    };
    const handleKeyUp = (event: KeyboardEvent) => {
      if (event.key === "ArrowUp" || event.key === "ArrowDown") {
        stopSearchArrowRepeat();
      }
    };

    window.addEventListener("keydown", handleKeyDown, true);
    window.addEventListener("keyup", handleKeyUp, true);
    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
      window.removeEventListener("keyup", handleKeyUp, true);
    };
  }, [
    closeSearch,
    commitSearchJump,
    getSelectedSearchAnchorId,
    getSelectedSearchTargetId,
    handleSearchArrowKey,
    moveSearchSelection,
    navigateToAdjacentHiddenUserTurn,
    prepareSearchTarget,
    scrollToCurrent,
    searchActive,
    searchScope,
    startSearch,
    stopSearchArrowRepeat,
    toggleThinkingItemsVisible,
    inert,
  ]);

  // Load older messages with scroll position preservation
  const handleLoadOlder = useCallback(() => {
    if (searchActiveRef.current || historySearchWindowRef.current) {
      return;
    }
    const revealsLoadedTurns =
      effectiveConversationViewEnabled &&
      conversationWindow.hiddenTurnCount > 0;
    const fetchesOlderMessages =
      !!onLoadOlderMessages &&
      hasOlderMessages &&
      !loadingOlder &&
      (!revealsLoadedTurns ||
        conversationWindow.hiddenTurnCount < conversationViewTurnLimit);
    if (!revealsLoadedTurns && !fetchesOlderMessages) {
      return;
    }

    if (fetchesOlderMessages) {
      const messageList = containerRef.current;
      const scrollContainer = messageList?.parentElement;
      pendingOlderPageScrollRef.current =
        messageList && scrollContainer
          ? {
              wasAtBottom: isNearScrollBottom(scrollContainer),
              scrollTop: scrollContainer.scrollTop,
              scrollHeight: scrollContainer.scrollHeight,
              anchor: getFirstVisibleRenderAnchor(messageList, scrollContainer),
            }
          : null;
    }

    preserveScrollAfterTranscriptHeightChange(() => {
      if (revealsLoadedTurns) {
        setConversationWindowExpansion((previous) => ({
          stateKey: conversationViewStateKey,
          bounded: true,
          additionalTurns:
            (previous.stateKey === conversationViewStateKey
              ? previous.additionalTurns
              : 0) + conversationViewTurnLimit,
        }));
      }
      if (fetchesOlderMessages) {
        try {
          const completion = onLoadOlderMessages();
          if (completion) {
            const finishOlderPageLoad = () => {
              setOlderPageLoadCompletionRevision((previous) => previous + 1);
            };
            void completion.then(finishOlderPageLoad, finishOlderPageLoad);
          } else {
            pendingOlderPageScrollRef.current = null;
          }
        } catch (error) {
          pendingOlderPageScrollRef.current = null;
          throw error;
        }
      }
    });
  }, [
    conversationViewTurnLimit,
    conversationViewStateKey,
    conversationWindow.hiddenTurnCount,
    effectiveConversationViewEnabled,
    hasOlderMessages,
    loadingOlder,
    onLoadOlderMessages,
    preserveScrollAfterTranscriptHeightChange,
  ]);
  loadOlderOnDemandRef.current = () => {
    if (!pendingOlderPageScrollRef.current) {
      handleLoadOlder();
    }
  };

  const restorePendingOlderPageScroll = useCallback(
    (pending: NonNullable<typeof pendingOlderPageScrollRef.current>): void => {
      const messageList = containerRef.current;
      const scrollContainer = messageList?.parentElement;
      if (!messageList || !scrollContainer) return;
      isProgrammaticScrollRef.current = true;

      if (pending.wasAtBottom) {
        scrollToBottom(scrollContainer);
      } else {
        const anchorRow = pending.anchor
          ? findRenderRow(messageList, pending.anchor.id)
          : null;
        if (anchorRow && pending.anchor) {
          restoreScrollToAnchorRow(
            scrollContainer,
            anchorRow,
            pending.anchor.topOffset,
          );
        } else {
          scrollContainer.scrollTop = Math.max(
            0,
            pending.scrollTop +
              scrollContainer.scrollHeight -
              pending.scrollHeight,
          );
        }
      }
      lastHeightRef.current = scrollContainer.scrollHeight;
      requestAnimationFrame(() => {
        isProgrammaticScrollRef.current = false;
      });
    },
    [scrollToBottom],
  );

  useLayoutEffect(() => {
    void chunkedTimelinePrepend.revision;
    const pending = pendingOlderPageScrollRef.current;
    if (!pending || !chunkedTimelinePrepend.active) return;
    restorePendingOlderPageScroll(pending);
  }, [
    chunkedTimelinePrepend.active,
    chunkedTimelinePrepend.revision,
    restorePendingOlderPageScroll,
  ]);

  useLayoutEffect(() => {
    if (
      olderPageLoadCompletionRevision === 0 ||
      chunkedTimelinePrepend.active
    ) {
      return;
    }
    const pending = pendingOlderPageScrollRef.current;
    pendingOlderPageScrollRef.current = null;
    if (!pending) return;
    restorePendingOlderPageScroll(pending);
  }, [
    chunkedTimelinePrepend.active,
    olderPageLoadCompletionRevision,
    restorePendingOlderPageScroll,
  ]);

  const automaticOlderLoadKey = useMemo(() => {
    const keys: string[] = [];
    if (
      effectiveConversationViewEnabled &&
      conversationWindow.hiddenTurnCount > 0
    ) {
      keys.push(
        `conversation:${conversationViewStateKey ?? "default"}:${conversationWindow.hiddenTurnCount}`,
      );
    }
    if (hasOlderMessages) {
      keys.push(`page:${olderMessagesCursor ?? "unkeyed"}`);
    }
    return keys.length > 0 ? keys.join("|") : null;
  }, [
    conversationViewStateKey,
    conversationWindow.hiddenTurnCount,
    effectiveConversationViewEnabled,
    hasOlderMessages,
    olderMessagesCursor,
  ]);

  useEffect(() => {
    if (
      inert ||
      loadingOlder ||
      searchActive ||
      historySearchWindow ||
      !automaticOlderLoadKey
    ) {
      return;
    }
    const boundary = loadOlderBoundaryRef.current;
    const scrollContainer = containerRef.current?.parentElement;
    const Observer = window.IntersectionObserver;
    if (!boundary || !scrollContainer || !Observer) return;

    const observer = new Observer(
      (entries) => {
        const entry = entries.find(
          (candidate) => candidate.target === boundary,
        );
        if (!entry) return;
        if (pendingOlderPageScrollRef.current) return;
        if (!entry.isIntersecting) {
          automaticOlderLoadRequiresExitRef.current = false;
          if (automaticOlderLoadAttemptRef.current === automaticOlderLoadKey) {
            automaticOlderLoadAttemptRef.current = null;
          }
          return;
        }
        if (automaticOlderLoadRequiresExitRef.current) return;
        if (automaticOlderLoadAttemptRef.current === automaticOlderLoadKey) {
          return;
        }
        automaticOlderLoadAttemptRef.current = automaticOlderLoadKey;
        automaticOlderLoadRequiresExitRef.current = true;
        handleLoadOlder();
      },
      { root: scrollContainer },
    );
    observer.observe(boundary);
    return () => observer.disconnect();
  }, [
    automaticOlderLoadKey,
    handleLoadOlder,
    historySearchWindow,
    inert,
    loadingOlder,
    searchActive,
  ]);

  // Track scroll position to determine if user is near bottom.
  // Ignore programmatic scrolls - only user-initiated scrolls should affect auto-scroll state.
  const handleScroll = useCallback(() => {
    if (isProgrammaticScrollRef.current) return;

    pendingInitialScrollRestoreRef.current = null;

    const content = containerRef.current;
    const container = content?.parentElement;
    if (!content || !container) return;

    const atBottom = isAtScrollBottom(container, content);
    if (shouldAutoScrollRef.current) {
      // Layout can grow between a bottom write and its scroll event. Unchanged
      // scrollTop is stale follow geometry and should re-pin; movement upward
      // from the last follow write is reader intent even when an input precursor
      // was unavailable or lost amid animated layout work.
      const movedUpFromFollowWrite =
        !atBottom &&
        container.scrollTop <
          lastFollowScrollTopRef.current - FOLLOW_BOTTOM_TOLERANCE_PX;
      if (movedUpFromFollowWrite) {
        stopFollowingForUserScroll(container);
      } else if (!atBottom) {
        scrollToBottom(container);
      } else {
        lastFollowScrollTopRef.current = container.scrollTop;
        thinkingDeltaFollowAllowedRef.current = true;
        setNewOutputBelowVisible(false);
        setIsScrolledToBottom(true);
        reportFollowingBottom(true);
      }
      scheduleSettledScrollState();
      return;
    }

    shouldAutoScrollRef.current = atBottom;
    thinkingDeltaFollowAllowedRef.current = atBottom;
    if (atBottom) {
      lastFollowScrollTopRef.current = container.scrollTop;
      setNewOutputBelowVisible(false);
    } else {
      clearForcedCurrentScrollTimers();
    }
    setIsScrolledToBottom(atBottom);
    reportFollowingBottom(atBottom);
    scheduleSettledScrollState();
  }, [
    clearForcedCurrentScrollTimers,
    reportFollowingBottom,
    scheduleSettledScrollState,
    scrollToBottom,
    stopFollowingForUserScroll,
  ]);

  // Attach scroll listener to parent container
  useEffect(() => {
    if (inert) {
      return;
    }
    const container = containerRef.current?.parentElement;
    if (!container) return;

    container.addEventListener("scroll", handleScroll);

    return () => {
      container.removeEventListener("scroll", handleScroll);
    };
  }, [handleScroll, inert]);

  // Cancel follow before browser scroll events when the user clearly tries to
  // move away from the live tail. Programmatic scroll bursts can otherwise keep
  // the scroll handler muted long enough to rubber-band the viewport back down.
  useEffect(() => {
    if (inert) {
      return;
    }
    const content = containerRef.current;
    const container = content?.parentElement;
    if (!content || !container) return;

    const handleWheel = (event: WheelEvent) => {
      if (event.deltaY < 0 && !isInteractiveScrollTarget(event.target)) {
        stopFollowingForUserScroll(container);
      }
    };

    const handleTouchStart = (event: TouchEvent) => {
      touchStartYRef.current = event.touches[0]?.clientY ?? null;
    };

    const handleTouchMove = (event: TouchEvent) => {
      const startY = touchStartYRef.current;
      const currentY = event.touches[0]?.clientY;
      if (
        startY !== null &&
        currentY !== undefined &&
        currentY - startY > TOUCH_SCROLL_CANCEL_THRESHOLD_PX &&
        !isInteractiveScrollTarget(event.target)
      ) {
        stopFollowingForUserScroll(container);
      }
    };

    const handleTouchEnd = () => {
      touchStartYRef.current = null;
    };

    const handlePointerDown = (event: PointerEvent) => {
      if (event.button !== 0 || isInteractiveScrollTarget(event.target)) {
        return;
      }
      const scrollbarWidth = container.offsetWidth - container.clientWidth;
      if (scrollbarWidth <= 0) {
        return;
      }
      const rect = container.getBoundingClientRect();
      if (event.clientX >= rect.right - scrollbarWidth) {
        stopFollowingForUserScroll(container);
        // Native scrollbar focus differs across browser/platform pairs. Make
        // the explicit transcript gesture own subsequent native page keys
        // instead of leaving them attached to the composer or document body.
        container.focus({ preventScroll: true });
      }
    };

    const handleSelectionChange = () => {
      if (shouldAutoScrollRef.current && selectionIntersectsElement(content)) {
        stopFollowingForUserScroll(container);
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        isInteractiveScrollTarget(event.target)
      ) {
        return;
      }
      const target = event.target;
      const scrollTargetActive =
        target === document.body ||
        target === document ||
        eventTargetIsInside(target, container);
      if (!scrollTargetActive) {
        return;
      }
      if (
        event.key === "ArrowUp" ||
        event.key === "PageUp" ||
        event.key === "Home" ||
        (event.key === " " && event.shiftKey)
      ) {
        stopFollowingForUserScroll(container);
      }
      if (
        !event.repeat &&
        (event.key === "PageUp" || event.code === "PageUp") &&
        keyboardOlderLoadFrameRef.current === null
      ) {
        keyboardOlderLoadFrameRef.current = requestAnimationFrame(() => {
          keyboardOlderLoadFrameRef.current = null;
          if (container.scrollTop <= 1) {
            loadOlderOnDemandRef.current();
          }
        });
      }
    };

    container.addEventListener("wheel", handleWheel, { passive: true });
    container.addEventListener("touchstart", handleTouchStart, {
      passive: true,
    });
    container.addEventListener("touchmove", handleTouchMove, {
      passive: true,
    });
    container.addEventListener("touchend", handleTouchEnd, { passive: true });
    container.addEventListener("touchcancel", handleTouchEnd, {
      passive: true,
    });
    container.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("selectionchange", handleSelectionChange);
    document.addEventListener("keydown", handleKeyDown, true);

    return () => {
      container.removeEventListener("wheel", handleWheel);
      container.removeEventListener("touchstart", handleTouchStart);
      container.removeEventListener("touchmove", handleTouchMove);
      container.removeEventListener("touchend", handleTouchEnd);
      container.removeEventListener("touchcancel", handleTouchEnd);
      container.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("selectionchange", handleSelectionChange);
      document.removeEventListener("keydown", handleKeyDown, true);
      if (keyboardOlderLoadFrameRef.current !== null) {
        cancelAnimationFrame(keyboardOlderLoadFrameRef.current);
        keyboardOlderLoadFrameRef.current = null;
      }
    };
  }, [inert, stopFollowingForUserScroll]);

  // Follow both content changes and space reserved by composer-adjacent panels.
  useEffect(() => {
    const container = containerRef.current?.parentElement;
    if (!container) return;

    const scrollContainer = container;
    lastHeightRef.current = scrollContainer.scrollHeight;
    let lastViewportHeight = scrollContainer.clientHeight;

    const resizeObserver = new ResizeObserver(() => {
      const newHeight = scrollContainer.scrollHeight;
      const heightChanged = newHeight !== lastHeightRef.current;
      const viewportHeight = scrollContainer.clientHeight;
      const viewportChanged = viewportHeight !== lastViewportHeight;
      lastViewportHeight = viewportHeight;
      const sizeChanged = heightChanged || viewportChanged;

      const pendingInitialRestore = pendingInitialScrollRestoreRef.current;
      if (sizeChanged && pendingInitialRestore) {
        isProgrammaticScrollRef.current = true;
        restoreRetainedScrollPosition(pendingInitialRestore);
        requestAnimationFrame(() => {
          isProgrammaticScrollRef.current = false;
        });
        return;
      }

      // Continue an already-active follow through any height change. Growth is
      // the streaming case; a *shrink* is turn completion collapsing the
      // bounded thinking preview and recent-activity rows out of the flow,
      // which used to strand a following reader slightly above the new bottom.
      if (sizeChanged && shouldAutoScrollRef.current) {
        scrollToBottom(scrollContainer);
      } else {
        // A size change must never *start* following — only continue it (the
        // branch above requires shouldAutoScroll already set). Re-arming here
        // from proximity is what trapped the reading area near the bottom.
        lastHeightRef.current = newHeight;
      }
    });

    resizeObserver.observe(scrollContainer);
    // Content can grow without changing the scroll viewport's dimensions.
    if (containerRef.current) {
      resizeObserver.observe(containerRef.current);
    }

    return () => {
      resizeObserver.disconnect();
      // Clean up any pending scroll on unmount
      clearFollowUpScrollTimer();
      if (programmaticScrollReleaseRef.current !== null) {
        clearTimeout(programmaticScrollReleaseRef.current);
      }
      clearForcedCurrentScrollTimers();
      if (navMotionCueClearTimerRef.current !== null) {
        clearTimeout(navMotionCueClearTimerRef.current);
      }
    };
  }, [
    clearFollowUpScrollTimer,
    clearForcedCurrentScrollTimers,
    restoreRetainedScrollPosition,
    scrollToBottom,
  ]);

  // Preserve relative scroll position when the viewport is resized.
  useEffect(() => {
    let pendingFrame = 0;
    let anchorFromBottom = 0;
    let preserveAutoScroll = true;

    const handleResize = () => {
      const container = containerRef.current?.parentElement;
      if (!container || isProgrammaticScrollRef.current) return;

      preserveAutoScroll = shouldAutoScrollRef.current;
      anchorFromBottom = preserveAutoScroll
        ? 0
        : Math.max(
            0,
            container.scrollHeight -
              container.scrollTop -
              container.clientHeight,
          );

      if (pendingFrame !== 0) {
        cancelAnimationFrame(pendingFrame);
      }

      pendingFrame = requestAnimationFrame(() => {
        const resizeContainer = containerRef.current?.parentElement;
        if (!resizeContainer) return;

        if (preserveAutoScroll) {
          scrollToBottom(resizeContainer);
          return;
        }

        const targetScrollTop = Math.max(
          0,
          resizeContainer.scrollHeight -
            resizeContainer.clientHeight -
            anchorFromBottom,
        );

        isProgrammaticScrollRef.current = true;
        resizeContainer.scrollTop = targetScrollTop;
        lastHeightRef.current = resizeContainer.scrollHeight;
        shouldAutoScrollRef.current = false;
        setIsScrolledToBottom(false);
        reportFollowingBottom(false);

        requestAnimationFrame(() => {
          isProgrammaticScrollRef.current = false;
        });
      });
    };

    window.addEventListener("resize", handleResize);
    return () => {
      window.removeEventListener("resize", handleResize);
      if (pendingFrame !== 0) {
        cancelAnimationFrame(pendingFrame);
      }
    };
  }, [reportFollowingBottom, scrollToBottom]);

  // Pin before paint so inserting an optimistic user row cannot expose the
  // prior bottom for one frame before the send catch-up begins.
  useLayoutEffect(() => {
    if (scrollTrigger > 0) {
      forceScrollToCurrent(SEND_CATCH_UP_DELAYS_MS, {
        allowThinkingDeltas: true,
      });
    }
  }, [forceScrollToCurrent, scrollTrigger]);

  // Scroll to a specific turn on request (composer recall drawer go-to-turn),
  // mirroring the isearch Enter jump (rAF → scrollToRenderId). The token guard
  // makes each distinct request scroll exactly once; the initial null request
  // and re-renders that don't bump the token are ignored.
  const lastScrollToTurnTokenRef = useRef<number | null>(null);
  useEffect(() => {
    const request = scrollToTurnRequest;
    if (!request?.id) {
      return;
    }
    if (lastScrollToTurnTokenRef.current === request.token) {
      return;
    }
    lastScrollToTurnTokenRef.current = request.token;
    const frame = requestAnimationFrame(() =>
      scrollToRenderId(request.id, "auto", "center", true),
    );
    return () => cancelAnimationFrame(frame);
  }, [scrollToTurnRequest, scrollToRenderId]);

  useLayoutEffect(() => {
    const wasInert = previousInertRef.current;
    previousInertRef.current = inert;
    if (wasInert && !inert && shouldAutoScrollRef.current) {
      forceScrollToCurrent(SEND_CATCH_UP_DELAYS_MS);
    }
  }, [forceScrollToCurrent, inert]);

  // Restore same-tab route scroll before the default first-load follow behavior
  // moves the viewport to the tail.
  const mountedTimelineRowCount = timelineEntryRows.length;
  const shouldWaitForInitialAnchorRestore =
    initialScrollRestoreDecision === "restore-position" &&
    initialScrollSnapshot?.anchor !== undefined &&
    progressiveRevealActive;
  useEffect(() => {
    if (
      !isInitialLoadRef.current ||
      !initialScrollSnapshot ||
      mountedTimelineRowCount === 0
    ) {
      return;
    }
    if (initialScrollRestoreDecision === "skip") {
      return;
    }
    const content = containerRef.current;
    const container = content?.parentElement;
    if (!content || !container) return;

    isProgrammaticScrollRef.current = true;
    if (initialScrollRestoreDecision === "follow-bottom") {
      pendingInitialScrollRestoreRef.current = null;
      scrollToBottom(container);
      shouldAutoScrollRef.current = true;
      setIsScrolledToBottom(true);
      setNewOutputBelowVisible(false);
    } else {
      const anchor = initialScrollSnapshot.anchor;
      if (
        anchor &&
        progressiveRevealActive &&
        !findRenderRow(content, anchor.id)
      ) {
        isProgrammaticScrollRef.current = false;
        return;
      }
      pendingInitialScrollRestoreRef.current = initialScrollSnapshot;
      restoreRetainedScrollPosition(initialScrollSnapshot);
      shouldAutoScrollRef.current = false;
      setIsScrolledToBottom(false);
      reportFollowingBottom(false);
      setNewOutputBelowVisible(
        initialScrollSnapshot.atBottom &&
          container.scrollHeight >
            initialScrollSnapshot.scrollHeight + FOLLOW_BOTTOM_TOLERANCE_PX &&
          !isAtScrollBottom(container, content),
      );
    }
    lastHeightRef.current = container.scrollHeight;
    isInitialLoadRef.current = false;
    requestAnimationFrame(() => {
      isProgrammaticScrollRef.current = false;
      updateScrollPositionTimestamp();
      publishScrollSnapshot();
    });
  }, [
    initialScrollSnapshot,
    initialScrollRestoreDecision,
    mountedTimelineRowCount,
    publishScrollSnapshot,
    progressiveRevealActive,
    restoreRetainedScrollPosition,
    scrollToBottom,
    updateScrollPositionTimestamp,
    reportFollowingBottom,
  ]);

  // Initial scroll to bottom on first render
  useEffect(() => {
    if (isInitialLoadRef.current && displayRenderItems.length > 0) {
      if (shouldWaitForInitialAnchorRestore) {
        return;
      }
      const container = containerRef.current?.parentElement;
      if (container) {
        scrollToBottom(container);
      }
      isInitialLoadRef.current = false;
    }
  }, [
    displayRenderItems.length,
    scrollToBottom,
    shouldWaitForInitialAnchorRestore,
  ]);

  const handleFollowClick = useCallback(() => {
    pendingInitialScrollRestoreRef.current = null;
    scrollToCurrent();
    publishScrollSnapshot();
    onFollowCurrent?.();
  }, [onFollowCurrent, publishScrollSnapshot, scrollToCurrent]);

  const followButtonTarget =
    !isScrolledToBottom && typeof document !== "undefined"
      ? followButtonPortalTarget === undefined
        ? document.querySelector<HTMLElement>(".session-input-inner")
        : followButtonPortalTarget
      : null;
  const followButtonLabel = newOutputBelowVisible
    ? t("sessionNewOutputBelow")
    : t("sessionFollow");
  const followButtonTitle = newOutputBelowVisible
    ? t("sessionNewOutputBelowTitle")
    : t("sessionFollowLatestOutput");
  const followButton =
    showFollowButton && !isScrolledToBottom ? (
      <button
        type="button"
        className={`message-follow-toggle${
          newOutputBelowVisible ? " is-new-output" : ""
        }`}
        onClick={handleFollowClick}
        aria-label={followButtonTitle}
        title={followButtonTitle}
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
          <path d="M12 5v14" />
          <path d="m19 12-7 7-7-7" />
        </svg>
        <span>{followButtonLabel}</span>
      </button>
    ) : null;
  return createElement(
    RememberedDisclosureStateProvider,
    { registry: rememberedDisclosureStateRegistry },
    <QuoteReplyProvider onQuoteTextBlock={handleQuoteTextBlock}>
      <UserTurnNavigator
        getAnchors={getNavigatorAnchors}
        messageListRef={containerRef}
        motionCue={navMotionCue}
        onNavigateStart={beginTurnNavigation}
        onSearchMatchSelect={handleSearchMatchSelect}
        onTrimAnchor={onTrimBeforeUserMessage}
        canTrimAnchor={canTrimHistoryAnchor}
        onForkBeforeAnchor={onForkBeforeUserMessage}
        onForkAfterAnchor={onForkAfterUserMessage}
        canForkAfterAnchor={canTrimHistoryAnchor}
        canForkBeforeAnchor={canForkBeforePrompt}
        forkAfterDisabled={forkAfterUserMessageDisabled}
        onCopyAnchor={onCopyUserMessage}
        canCopyAnchor={canTrimHistoryAnchor}
        onHandoffFromAnchor={onHandoffFromUserMessage}
        onPreviewTimestampChange={handlePreviewTimestampChange}
        getRenderIdTop={transcriptRenderWindow.getRenderIdTop}
        revealRenderId={transcriptRenderWindow.revealRenderId}
        searchState={userTurnNavSearchState}
      />
      {searchPanel}
      {followButtonTarget && followButton
        ? createPortal(followButton, followButtonTarget)
        : followButton}
      {mobileSelectionActions}
      {selectionContextMenu}
      <div
        className={[
          "message-list",
          progressiveRevealActive ? "message-list-progressive-hydrating" : "",
        ]
          .filter(Boolean)
          .join(" ")}
        ref={containerRef}
        aria-busy={progressiveRevealActive ? true : undefined}
        data-transcript-render-weight={transcriptRenderWindow.totalWeight}
        onPointerOver={handleTranscriptPointerOver}
        onPointerLeave={handleTranscriptPointerLeave}
      >
        {floatingSelectionActions}
        {progressiveRevealActive && (
          <div className="session-render-progress loading" role="status">
            <div>{t("sessionLoading")}</div>
            {progressiveRenderStatusVisible && (
              <>
                <div className="loading-detail session-render-progress-label">
                  {t("sessionProgressiveRenderingStatus", {
                    percent: progressiveRenderPercent,
                  })}
                </div>
                <div
                  className="session-render-progress-bar"
                  role="progressbar"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={progressiveRenderPercent}
                  aria-label={t("sessionProgressiveRenderingAriaLabel")}
                >
                  <div
                    className="session-render-progress-fill"
                    style={{ width: `${progressiveRenderPercent}%` }}
                  />
                </div>
              </>
            )}
          </div>
        )}
        {!searchActive &&
          !historySearchWindow &&
          (hasOlderMessages ||
            clientTailActive ||
            conversationWindow.hiddenTurnCount > 0) && (
            <div className="load-older-messages" ref={loadOlderBoundaryRef}>
              {effectiveConversationViewEnabled &&
              conversationWindow.hiddenTurnCount > 0 ? (
                <span className="load-older-status">
                  {t("sessionConversationLatestTurns", {
                    count: conversationWindow.visibleTurnCount,
                  })}
                </span>
              ) : clientTailActive ? (
                <span className="load-older-status">
                  {t("sessionRecentTranscriptLoaded")}
                </span>
              ) : null}
              {olderLoadContinuationRequired && !loadingOlder ? (
                <span className="load-older-status" role="status">
                  {t("sessionOlderLoadContinuationRequired")}
                </span>
              ) : null}
              {(hasOlderMessages || conversationWindow.hiddenTurnCount > 0) && (
                <button
                  type="button"
                  className="load-older-button"
                  onClick={handleLoadOlder}
                  disabled={
                    loadingOlder && conversationWindow.hiddenTurnCount === 0
                  }
                >
                  {loadingOlder && conversationWindow.hiddenTurnCount === 0 ? (
                    <>
                      <span className="spinning">&#x21BB;</span>{" "}
                      {t("sessionLoadingOlderMessages")}
                    </>
                  ) : conversationWindow.hiddenTurnCount > 0 ? (
                    t("sessionConversationLoadEarlierTurns", {
                      count: Math.min(
                        conversationViewTurnLimit,
                        conversationWindow.hiddenTurnCount,
                      ),
                    })
                  ) : (
                    t("sessionLoadOlderMessages")
                  )}
                </button>
              )}
            </div>
          )}
        {transcriptRenderWindow.active && (
          <span
            ref={transcriptRenderWindow.registerListStart}
            aria-hidden="true"
            data-transcript-render-boundary="start"
            style={TRANSCRIPT_RENDER_MARKER_STYLE}
          />
        )}
        {transcriptRenderWindow.beforeHeightPx > 0 && (
          <div
            aria-hidden="true"
            data-transcript-render-spacer="before"
            style={{ height: transcriptRenderWindow.beforeHeightPx }}
          />
        )}
        {transcriptRenderWindow.rows.map((timelineRow) => {
          const renderedRow = (() => {
            if (timelineRow.kind === "btw") {
              return (
                <BtwAsideTimelineCard
                  key={timelineRow.key}
                  aside={timelineRow.aside}
                  onFocus={onFocusBtwAside}
                  onDone={onDoneBtwAside}
                  onStop={onStopBtwAside}
                  onToggleExpanded={onToggleBtwAsideExpanded}
                  onTransferTurn={onTransferBtwAsideTurn}
                />
              );
            }

            if (timelineRow.kind === "empty") {
              return null;
            }

            if (timelineRow.kind === "standalone") {
              const { item } = timelineRow;
              return (
                <RenderItemComponent
                  key={timelineRow.key}
                  item={item}
                  isStreaming={isStreaming}
                  thinkingExpanded={false}
                  toggleThinkingExpanded={noopToggleThinkingExpanded}
                  sessionProvider={provider}
                  getForkSummaryTargetHref={getForkSummaryTargetHref}
                  onCancelForkSummary={onCancelForkSummary}
                  onToggleForkSummaryAutoOpen={onToggleForkSummaryAutoOpen}
                  onFollowForkSummary={onFollowForkSummary}
                  bangCommandHandlers={bangCommandHandlers}
                />
              );
            }

            if (timelineRow.kind === "user") {
              return (
                <UserTimelineEntry
                  key={timelineRow.key}
                  row={timelineRow}
                  isStreaming={isStreaming}
                  sessionProvider={provider}
                  latestCorrectablePromptId={latestCorrectablePrompt?.id}
                  latestCorrectablePromptContent={
                    latestCorrectablePrompt?.content
                  }
                  onCorrectLatestUserMessage={onCorrectLatestUserMessage}
                  onCancelUnconfirmedUserMessage={
                    onCancelUnconfirmedUserMessage
                  }
                  onTrimBeforeUserMessage={onTrimBeforeUserMessage}
                  onForkBeforeUserMessage={onForkBeforeUserMessage}
                  onForkAfterUserMessage={onForkAfterUserMessage}
                  onForkAfterSummaryUserMessage={onForkAfterSummaryUserMessage}
                  canForkBeforePrompt={canForkBeforePrompt}
                  forkAfterUserMessageDisabled={forkAfterUserMessageDisabled}
                  forkUnavailableMessage={forkUnavailableMessage}
                  noopToggleThinkingExpanded={noopToggleThinkingExpanded}
                  promptActionsDisabled={historySearchRenderIds.has(
                    timelineRow.item.id,
                  )}
                />
              );
            }

            return (
              <AssistantTimelineEntry
                key={timelineRow.key}
                row={timelineRow}
                isStreaming={isStreaming}
                sessionProvider={provider}
                getThinkingItemExpanded={getThinkingItemExpanded}
                toggleThinkingItemExpanded={toggleThinkingItemExpanded}
                noopToggleThinkingExpanded={noopToggleThinkingExpanded}
                onTrimBeforeUserMessage={onTrimBeforeUserMessage}
                onForkBeforeUserMessage={onForkBeforeUserMessage}
                onForkAfterUserMessage={onForkAfterUserMessage}
                onForkAfterSummaryUserMessage={onForkAfterSummaryUserMessage}
                canForkBeforePrompt={canForkBeforePrompt}
                forkAfterUserMessageDisabled={forkAfterUserMessageDisabled}
                forkUnavailableMessage={forkUnavailableMessage}
                handleQuoteTextBlock={handleQuoteTextBlock}
                alwaysShowQuoteCircles={alwaysShowQuoteCircles}
                paragraphQuoteCirclesEnabled={paragraphQuoteCirclesEnabled}
                onToggleConversationActivity={toggleConversationActivity}
                widerConversationActivityPreviews={
                  widerConversationActivityPreviews
                }
                collapsedConversationThinkingPreviewSlots={
                  collapsedConversationThinkingPreviewSlots
                }
                onToggleConversationThinkingPreview={
                  toggleConversationThinkingPreview
                }
                onDismissConversationThinkingPreview={
                  dismissConversationThinkingPreview
                }
                promptActionDisabledIds={historySearchRenderIds}
              />
            );
          })();
          if (!transcriptRenderWindow.active) {
            return renderedRow;
          }
          const spacerBefore = transcriptRenderWindow.getRowSpacerBefore(
            timelineRow.key,
          );
          return (
            <Fragment key={timelineRow.key}>
              {spacerBefore > 0 && (
                <div
                  aria-hidden="true"
                  data-transcript-render-spacer="between"
                  style={{ height: spacerBefore }}
                />
              )}
              <span
                ref={(element) =>
                  transcriptRenderWindow.registerRowStart(
                    timelineRow.key,
                    element,
                  )
                }
                aria-hidden="true"
                data-transcript-render-boundary="row-start"
                style={TRANSCRIPT_RENDER_MARKER_STYLE}
              />
              {renderedRow}
              <span
                ref={(element) =>
                  transcriptRenderWindow.registerRowEnd(
                    timelineRow.key,
                    element,
                  )
                }
                aria-hidden="true"
                data-transcript-render-boundary="row-end"
                style={TRANSCRIPT_RENDER_MARKER_STYLE}
              />
            </Fragment>
          );
        })}
        {transcriptRenderWindow.afterHeightPx > 0 && (
          <div
            aria-hidden="true"
            data-transcript-render-spacer="after"
            style={{ height: transcriptRenderWindow.afterHeightPx }}
          />
        )}
        {composerTailRows.map((tailRow) => {
          const { hasMessageAge, showAgeByDefault, timestampMs } = tailRow;

          if (tailRow.kind === "pending") {
            const pending = tailRow.message;
            return (
              <div
                key={tailRow.key}
                className={`pending-message message-render-row ${
                  hasMessageAge ? "has-message-age" : ""
                } ${showAgeByDefault ? "is-message-age-visible" : ""}`}
              >
                <div className="message-render-content">
                  <div className="message-user-prompt pending-message-bubble">
                    <LinkifiedText text={pending.content} />
                  </div>
                  {pending.attachments?.length ? (
                    <div className="attachment-list pending-message-attachments">
                      {pending.attachments.map((file) => (
                        <AttachmentChip
                          key={file.id}
                          attachmentId={file.id}
                          originalName={file.originalName}
                          path={file.path}
                          mimeType={file.mimeType}
                          sizeLabel={formatFileSize(file.size)}
                          imageWidth={file.width}
                          imageHeight={file.height}
                        />
                      ))}
                    </div>
                  ) : null}
                  <div className="pending-message-footer">
                    <div className="pending-message-status">
                      {pending.status || "Sending..."}
                    </div>
                    <div className="deferred-message-actions">
                      <CopyTextButton
                        text={pending.content}
                        label="Copy message text"
                        className="deferred-message-action deferred-message-action-copy"
                        showTextLabel
                        onClick={(event) => event.stopPropagation()}
                      />
                    </div>
                  </div>
                </div>
                <MessageAge timestampMs={timestampMs} nowMs={nowMs} />
              </div>
            );
          }

          if (tailRow.kind === "project-queue") {
            const projectQueue = tailRow.message;
            const projectQueueStatus =
              tailRow.projectQueueStatusKind === "dispatching"
                ? t("projectQueueInlineStatusDispatching", {
                    position: projectQueue.projectPosition,
                  })
                : tailRow.projectQueueStatusKind === "failed"
                  ? t("projectQueueInlineStatusFailed", {
                      position: projectQueue.projectPosition,
                    })
                  : t("projectQueueInlineStatusQueued", {
                      position: projectQueue.projectPosition,
                    });
            return (
              <div
                key={tailRow.key}
                className={`deferred-message project-queue-inline-message message-render-row ${
                  hasMessageAge ? "has-message-age" : ""
                } ${showAgeByDefault ? "is-message-age-visible" : ""}`}
              >
                <div className="message-render-content">
                  <div
                    className={`message-user-prompt ${styles.queuedBubble} ${styles.projectQueueBubble}`}
                  >
                    <LinkifiedText text={projectQueue.content} />
                  </div>
                  {projectQueue.attachments?.length ? (
                    <div className="attachment-list deferred-message-attachments-list">
                      {projectQueue.attachments.map((file) => (
                        <AttachmentChip
                          key={file.id}
                          attachmentId={file.id}
                          originalName={file.originalName}
                          path={file.path}
                          mimeType={file.mimeType}
                          sizeLabel={formatFileSize(file.size)}
                          imageWidth={file.width}
                          imageHeight={file.height}
                        />
                      ))}
                    </div>
                  ) : null}
                  <div className="deferred-message-footer">
                    <span className="deferred-message-status project-queue-inline-message-status">
                      {projectQueueStatus}
                    </span>
                    {tailRow.showAttachmentCountBadge ? (
                      <span
                        className="deferred-message-attachments"
                        title={`${projectQueue.attachmentCount} attachment${
                          projectQueue.attachmentCount === 1 ? "" : "s"
                        } queued`}
                        role="img"
                        aria-label={`${projectQueue.attachmentCount} attachment${
                          projectQueue.attachmentCount === 1 ? "" : "s"
                        } queued`}
                      >
                        <svg
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
                          <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
                        </svg>
                        <span>{projectQueue.attachmentCount}</span>
                      </span>
                    ) : null}
                    {projectQueue.lastError && (
                      <span className="project-queue-inline-message-error">
                        {projectQueue.lastError}
                      </span>
                    )}
                    <QueuedMessageActions
                      variant="project"
                      text={projectQueue.content}
                      composerEditAvailabilityStore={
                        composerEditAvailabilityStore
                      }
                      itemCanEdit={projectQueue.canEdit !== false}
                      disabled={
                        projectQueue.isMutating || projectQueueDispatchMutating
                      }
                      onResume={
                        projectQueueDispatchPaused
                          ? onResumeProjectQueueDispatch
                          : undefined
                      }
                      onEdit={
                        tailRow.allowsCancel && onEditProjectQueueMessage
                          ? () => onEditProjectQueueMessage(projectQueue.id)
                          : undefined
                      }
                      onSteer={
                        tailRow.projectQueueStatusKind === "queued" &&
                        onSteerProjectQueueMessage
                          ? () => onSteerProjectQueueMessage(projectQueue.id)
                          : undefined
                      }
                      steerLabel={t("projectQueueInlineSteer")}
                      onCancel={
                        tailRow.allowsCancel && onCancelProjectQueueMessage
                          ? () => onCancelProjectQueueMessage(projectQueue.id)
                          : undefined
                      }
                    />
                  </div>
                </div>
                <MessageAge timestampMs={timestampMs} nowMs={nowMs} />
              </div>
            );
          }

          const deferred = tailRow.message;
          const recoveredQueueId = tailRow.recoveredQueueId;
          const deferredStatus = tailRow.isRecovered
            ? t("sessionRecoveredQueuedPaused")
            : tailRow.isYaCommand
              ? t("sessionQueuedYaCommandAfterTurn")
              : getDeferredMessageStatus({
                  isPatient: tailRow.isPatient,
                  lanePosition: tailRow.lanePosition,
                  timestampMs,
                  nowMs,
                });
          const earlierPatientCount = tailRow.lanePosition?.patientIndex ?? 0;
          const steerQueuedLabel =
            earlierPatientCount > 0
              ? t("sessionSteerQueuedMessageThrough", {
                  count: String(earlierPatientCount),
                  suffix: earlierPatientCount === 1 ? "" : "s",
                })
              : t("sessionSteerQueuedMessageNow");
          return (
            <div
              key={tailRow.key}
              className={`deferred-message message-render-row ${
                hasMessageAge ? "has-message-age" : ""
              } ${showAgeByDefault ? "is-message-age-visible" : ""}`}
            >
              <div className="message-render-content">
                <div className={`message-user-prompt ${styles.queuedBubble}`}>
                  <LinkifiedText text={deferred.content} />
                </div>
                {deferred.attachments?.length ? (
                  <div className="attachment-list deferred-message-attachments-list">
                    {deferred.attachments.map((file) => (
                      <AttachmentChip
                        key={file.id}
                        attachmentId={file.id}
                        originalName={file.originalName}
                        path={file.path}
                        mimeType={file.mimeType}
                        sizeLabel={formatFileSize(file.size)}
                        imageWidth={file.width}
                        imageHeight={file.height}
                      />
                    ))}
                  </div>
                ) : null}
                <div className="deferred-message-footer">
                  <span
                    className="deferred-message-status"
                    title={
                      tailRow.isRecovered
                        ? t("sessionRecoveredQueuedPausedTitle")
                        : tailRow.isPatient
                          ? "Patient queue waits for verified quiet. Regular queued messages may pass it."
                          : undefined
                    }
                  >
                    {deferredStatus}
                  </span>
                  <QueuedEffortBadge
                    modifier={deferred.metadata?.turnEffort}
                    context={queuedEffortContext}
                  />
                  {tailRow.showAttachmentCountBadge ? (
                    <span
                      className="deferred-message-attachments"
                      title={`${deferred.attachmentCount} attachment${
                        deferred.attachmentCount === 1 ? "" : "s"
                      } queued`}
                      role="img"
                      aria-label={`${deferred.attachmentCount} attachment${
                        deferred.attachmentCount === 1 ? "" : "s"
                      } queued`}
                    >
                      <svg
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
                        <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
                      </svg>
                      <span>{deferred.attachmentCount}</span>
                    </span>
                  ) : null}
                  {tailRow.isRecovered ? (
                    <div className="deferred-message-actions">
                      <CopyTextButton
                        text={deferred.content}
                        label={t("sessionQueuedCopy")}
                        className="deferred-message-action deferred-message-action-copy"
                        showTextLabel
                        onClick={(event) => event.stopPropagation()}
                      />
                      {recoveredQueueId &&
                      onSteerRecoveredDeferred &&
                      !deferred.metadata?.turnEffort ? (
                        <button
                          type="button"
                          className="deferred-message-action deferred-message-action-steer"
                          onClick={() =>
                            onSteerRecoveredDeferred(recoveredQueueId)
                          }
                          aria-label={steerQueuedLabel}
                          title={steerQueuedLabel}
                        >
                          <PlayIcon />
                          <span>{t("sessionSteerNow")}</span>
                        </button>
                      ) : null}
                      {tailRow.allowsRecoveredResume &&
                      recoveredQueueId &&
                      onResumeRecoveredDeferred ? (
                        <button
                          type="button"
                          className="deferred-message-action deferred-message-action-resume"
                          onClick={() =>
                            onResumeRecoveredDeferred(recoveredQueueId)
                          }
                          aria-label={t("sessionRecoveredQueuedResume")}
                          title={t("sessionRecoveredQueuedResume")}
                        >
                          <PlayIcon />
                          <span>{t("sessionRecoveredQueuedResumeShort")}</span>
                        </button>
                      ) : null}
                      {tailRow.allowsRecoveredDelete &&
                      recoveredQueueId &&
                      onDeleteRecoveredDeferred ? (
                        <button
                          type="button"
                          className="deferred-message-action deferred-message-action-cancel"
                          onClick={() =>
                            onDeleteRecoveredDeferred(recoveredQueueId)
                          }
                          aria-label={t("sessionRecoveredQueuedDelete")}
                          title={t("sessionRecoveredQueuedDelete")}
                        >
                          <XIcon />
                          <span>{t("sessionRecoveredQueuedDeleteShort")}</span>
                        </button>
                      ) : null}
                    </div>
                  ) : (
                    <QueuedMessageActions
                      variant="session"
                      text={deferred.content}
                      composerEditAvailabilityStore={
                        composerEditAvailabilityStore
                      }
                      onEdit={
                        !tailRow.isYaCommand &&
                        deferred.tempId &&
                        onEditDeferred
                          ? () => onEditDeferred(deferred.tempId as string)
                          : undefined
                      }
                      onSteer={
                        tailRow.isPatient &&
                        deferred.tempId &&
                        onSteerDeferred &&
                        !deferred.metadata?.turnEffort
                          ? () => onSteerDeferred(deferred.tempId as string)
                          : undefined
                      }
                      steerLabel={steerQueuedLabel}
                      onCancel={
                        tailRow.allowsDeferredCancel && onCancelDeferred
                          ? () => onCancelDeferred(deferred.tempId as string)
                          : undefined
                      }
                    />
                  )}
                </div>
              </div>
              <MessageAge timestampMs={timestampMs} nowMs={nowMs} />
            </div>
          );
        })}
        {/* Compacting indicator - shown when context is being compressed */}
        {isCompacting && (
          <div className="system-message system-message-compacting">
            <span className="system-message-icon spinning">⟳</span>
            <span className="system-message-text">Compacting context...</span>
          </div>
        )}
        <ProcessingIndicator
          isProcessing={isProcessing}
          thinkingItemsVisible={thinkingItemsVisible}
          hasThinkingItems={hasThinkingItems}
          onToggleThinkingItemsVisible={toggleThinkingItemsVisible}
          thinkingLatestOnly={thinkingLatestOnly}
          onToggleThinkingLatestOnly={toggleThinkingLatestOnly}
        />
      </div>
    </QuoteReplyProvider>,
  );
});
