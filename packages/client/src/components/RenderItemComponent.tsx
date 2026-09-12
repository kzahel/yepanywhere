import {
  type CSSProperties,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useTextTooltipAttributes } from "../hooks/useTooltipAppearance";
import { useI18n } from "../i18n";
import { AsyncQuestionMessage } from "./AsyncQuestions";
import {
  MESSAGE_STALE_THRESHOLD_MS,
  getEarliestMessageTimestampMs,
  getLatestMessageTimestampMs,
} from "../lib/messageAge";
import {
  getCancellableUnconfirmedSteerTempId,
  getUserPromptDeliveryState,
} from "../lib/deliveryState";
import { useQuoteableTextSource } from "../hooks/useQuoteableTextSource";
import type { CommentAnchor } from "../lib/commentAnchors";
import type { ContentBlock } from "../types";
import type {
  ConversationRecentActivity,
  ConversationThinkingPreview as ConversationThinkingPreviewData,
  ConversationThinkingPreviewSlot,
  RenderItem,
} from "@yep-anywhere/shared/transcript/items";
import { formatCommandDuration } from "@yep-anywhere/shared/transcript/shellToolOutput";
import { useStickToBottom } from "../lib/stickToBottom";
import {
  type ActivityHeightReserve,
  activityHeightReserveReleaseDelayMs,
  updateActivityHeightReserve,
} from "../lib/sessionDetail/activityHeightReserve";
import {
  THINKING_PREVIEW_DEFAULT_WIDTH_PX,
  type ThinkingPreviewWidthState,
  updateThinkingPreviewWidth,
} from "../lib/sessionDetail/thinkingPreviewWidth";
import {
  CONVERSATION_THINKING_AUTO_HIDE_ROLLUP_MS,
  conversationThinkingAutoHideDelayMs,
} from "../lib/sessionDetail/thinkingPreviewAutoHide";
import {
  CONVERSATION_CONTEXT_RESERVE_LINES,
  CONVERSATION_PROSE_LINE_HEIGHT_RATIO,
  conversationRowHeightCeilingPx,
  stackedThinkingBudgetPx,
} from "../lib/sessionDetail/thinkingPreviewBudget";
import { ThinkingText } from "./ThinkingText";
import { MessageAge } from "./MessageAge";
import {
  BangCommandDisplayObject,
  type BangCommandHandlers,
} from "./BangCommandDisplayObject";
import { ForkSummaryDisplayObject } from "./ForkSummaryDisplayObject";
import { GoalNotice } from "./GoalNotice";
import { SessionSetupBlock } from "./blocks/SessionSetupBlock";
import { TaskNotificationBlock } from "./blocks/TaskNotificationBlock";
import { TextBlock } from "./blocks/TextBlock";
import { ThinkingBlock } from "./blocks/ThinkingBlock";
import { ToolCallRow } from "./blocks/ToolCallRow";
import { UserPromptBlock } from "./blocks/UserPromptBlock";
import { LinkifiedText } from "./ui/LinkifiedText";
import styles from "./RenderItemComponent.module.css";
import { WorkflowContext } from "./WorkflowOutput";
import { WorkflowAssistantOutput } from "./WorkflowAssistantOutput";

interface Props {
  item: RenderItem;
  isStreaming: boolean;
  thinkingExpanded: boolean;
  toggleThinkingExpanded: () => void;
  sessionProvider?: string;
  onCorrectUserPrompt?: () => void;
  onCancelUnconfirmedUserPrompt?: (tempId: string) => void;
  onTrimBeforeUserPrompt?: () => void;
  onForkBeforeUserPrompt?: () => void;
  onForkAfterUserPrompt?: () => void;
  onForkAfterSummaryUserPrompt?: () => void;
  forkAfterUserPromptDisabled?: boolean;
  forkUnavailableMessage?: string;
  onQuoteTextBlock?: (anchor: CommentAnchor) => void;
  alwaysShowQuoteCircle?: boolean;
  paragraphQuoteCirclesEnabled?: boolean;
  staleNowMs?: number;
  thinkingDurationMs?: number;
  getForkSummaryTargetHref?: (targetSessionId: string) => string;
  onCancelForkSummary?: (objectId: string) => void;
  onToggleForkSummaryAutoOpen?: (objectId: string, value: boolean) => void;
  onFollowForkSummary?: (objectId: string) => void;
  bangCommandHandlers?: BangCommandHandlers;
  onToggleConversationActivity?: (itemId: string) => void;
  widerConversationActivityPreviews?: boolean;
  collapsedConversationThinkingPreviewSlots?: ReadonlySet<ConversationThinkingPreviewSlot>;
  onToggleConversationThinkingPreview?: (
    slot: ConversationThinkingPreviewSlot,
  ) => void;
  onDismissConversationThinkingPreview?: (
    slot: ConversationThinkingPreviewSlot,
  ) => void;
}

function getMessageIdLike(message: Record<string, unknown>): string {
  if (typeof message.uuid === "string" && message.uuid.length > 0) {
    return message.uuid;
  }
  if (typeof message.id === "string" && message.id.length > 0) {
    return message.id;
  }
  return "<missing>";
}

function summarizeSourceMessages(messages: RenderItem["sourceMessages"]) {
  const bySource: Record<string, number> = {
    sdk: 0,
    jsonl: 0,
    unknown: 0,
  };
  const byType: Record<string, number> = {};
  const ids: string[] = [];
  let streamEventCount = 0;
  let streamingPlaceholderCount = 0;

  for (const message of messages) {
    const source =
      message._source === "sdk" || message._source === "jsonl"
        ? message._source
        : "unknown";
    bySource[source] = (bySource[source] ?? 0) + 1;

    const type = typeof message.type === "string" ? message.type : "unknown";
    byType[type] = (byType[type] ?? 0) + 1;
    if (type === "stream_event") {
      streamEventCount++;
    }
    if (message._isStreaming) {
      streamingPlaceholderCount++;
    }

    ids.push(getMessageIdLike(message as Record<string, unknown>));
  }

  return {
    total: messages.length,
    bySource,
    byType,
    streamEventCount,
    streamingPlaceholderCount,
    ids,
  };
}

function buildDebugSnapshot(
  item: RenderItem,
  props: {
    isStreaming: boolean;
    thinkingExpanded: boolean;
    sessionProvider?: string;
  },
) {
  const sourceSummary = summarizeSourceMessages(item.sourceMessages);

  return {
    render: {
      id: item.id,
      type: item.type,
      isSubagent: item.isSubagent ?? false,
    },
    uiContext: {
      sessionProvider: props.sessionProvider ?? "unknown",
      sessionIsStreaming: props.isStreaming,
      thinkingExpanded: props.thinkingExpanded,
    },
    itemContext:
      item.type === "tool_call"
        ? {
            toolName: item.toolName,
            status: item.status,
            hasToolResult: Boolean(item.toolResult),
            hasStructuredResult: item.toolResult?.structured !== undefined,
            toolUseId: item.id,
          }
        : item.type === "text"
          ? {
              isStreamingTextBlock: item.isStreaming ?? false,
              hasAugmentHtml: Boolean(item.augmentHtml),
            }
          : item.type === "thinking"
            ? {
                status: item.status,
                thinkingLength: item.thinking.length,
              }
            : item.type === "system"
              ? {
                  subtype: item.subtype,
                  status: item.status ?? null,
                }
              : item.type === "session_setup"
                ? {
                    promptCount: item.prompts.length,
                  }
                : null,
    sourceSummary,
    sourceMessages: item.sourceMessages,
    renderItem: item,
  };
}

function systemDetailToText(detail: string | ContentBlock[]): string {
  if (typeof detail === "string") {
    return detail;
  }

  return detail
    .map((block) => {
      if (block.type === "text" && typeof block.text === "string") {
        return block.text;
      }
      if (block.type === "tool_result" && typeof block.content === "string") {
        return block.content;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

const COMPACT_EMPTY_DETAIL =
  "No provider summary was retained for this compaction.";

function CollapsibleSystemMessage({
  item,
  icon,
  label,
}: {
  item: Extract<RenderItem, { type: "system" }>;
  icon: string;
  label?: string;
}) {
  const details = (item.details ?? [])
    .map(systemDetailToText)
    .map((text) => text.trim())
    .filter(Boolean);
  const isCompactBoundary = item.subtype === "compact_boundary";
  const isToolOutput = item.subtype === "tool_output";
  const variantClass = isCompactBoundary
    ? "system-message-compact-boundary"
    : "system-message-local-command";
  const summaryClass = isCompactBoundary
    ? "system-message-summary system-message-compact-summary"
    : "system-message-summary system-message-local-command-summary";

  // All compact boundaries stay outline-expandable so users can inspect what
  // was kept/summarized; local-command rows still collapse to a flat chip when
  // they have no detail body.
  if (!isCompactBoundary && details.length === 0) {
    return (
      <div className={`system-message ${variantClass}`}>
        <span className="system-message-icon">{icon}</span>
        <span className="system-message-text">
          <LinkifiedText text={label ?? item.content} />
        </span>
      </div>
    );
  }

  const resolvedDetails = details.length > 0 ? details : [COMPACT_EMPTY_DETAIL];

  return (
    <details
      className={`system-message ${variantClass} ${variantClass}--details system-message--details${
        isCompactBoundary ? ` ${styles.compactBoundaryOutline}` : ""
      }`}
    >
      <summary className={summaryClass}>
        <span className="collapsible__icon" aria-hidden="true">
          ▸
        </span>
        <span className="system-message-icon">{icon}</span>
        <span className="system-message-text">
          <LinkifiedText text={label ?? item.content} />
        </span>
      </summary>
      <div
        className={`system-message-details${
          isToolOutput ? ` ${styles.toolOutputDetails}` : ""
        }`}
      >
        {resolvedDetails.map((detail, index) => (
          <pre
            className="system-message-detail"
            key={`${item.id}-system-detail-${index}`}
          >
            {detail}
          </pre>
        ))}
      </div>
    </details>
  );
}

interface ActivityHeightReserveController {
  reserve: ActivityHeightReserve | null;
  timer: number | null;
}

const LATEST_THINKING_PREVIEW_SELECTOR =
  '.conversation-thinking-preview[data-preview-slot="latest"]';
const PREVIOUS_THINKING_PREVIEW_SELECTOR =
  '.conversation-thinking-preview[data-preview-slot="previous"]';
const THINKING_PREVIEW_CONTENT_SELECTOR =
  ".conversation-thinking-preview-content";
const STACKED_THINKING_BUDGET_VAR = "--conversation-previous-thinking-budget";
/**
 * Measured state of the previous thinking card, read by the stylesheet:
 * `stacked` when it wrapped below the current card, so its height adds to the
 * row; `dropped` when even a short thought no longer fits the budget. Absent
 * while the two cards share a flex line and the ordinary cap suffices.
 */
const PREVIOUS_THINKING_STATE_ATTR = "previousThinking";
/** Rounding slack when deciding whether two cards share a flex line. */
const SHARED_FLEX_LINE_TOLERANCE_PX = 1;

/**
 * The scrolling ancestor the row has to fit inside — `.session-messages` in an
 * ordinary session, the read-only shell's own scroller in a public share.
 * Resolved from computed overflow rather than a class name so both surfaces
 * work without naming either.
 */
function findTranscriptViewport(row: HTMLElement): HTMLElement | null {
  for (let node = row.parentElement; node; node = node.parentElement) {
    const { overflowY } = window.getComputedStyle(node);
    if (overflowY === "auto" || overflowY === "scroll") return node;
  }
  return null;
}

/**
 * Two lines of the preceding paragraph, in the prose metrics actually in force,
 * plus whatever separates that paragraph from the row.
 *
 * A thinking card's own prose is styled from the same `--output-prose-*`
 * variables as the conversation text above the row, so its rendered line height
 * *is* the measurement. With no rendered prose in the row — every card
 * collapsed — fall back to the row's font size times the prose line-height
 * ratio, which still moves with the reader's font and UI size settings rather
 * than freezing a pixel guess. The separating gap is counted because two lines
 * of *space* above the row would otherwise be spent on the paragraph's own
 * trailing margin, leaving one line of text on screen instead of two. See
 * topics/responsive-layout-gaps.md.
 */
function conversationContextReservePx(
  row: HTMLElement,
  rowRect: DOMRect,
): number {
  const prose = row.querySelector<HTMLElement>(
    `${THINKING_PREVIEW_CONTENT_SELECTOR} .thinking-text`,
  );
  const measuredLinePx = prose
    ? Number.parseFloat(window.getComputedStyle(prose).lineHeight)
    : Number.NaN;
  const linePx =
    Number.isFinite(measuredLinePx) && measuredLinePx > 0
      ? measuredLinePx
      : CONVERSATION_PROSE_LINE_HEIGHT_RATIO *
        (Number.parseFloat(window.getComputedStyle(row).fontSize) || 0);
  const precedingBottomPx =
    row.previousElementSibling?.getBoundingClientRect().bottom;
  const gapPx =
    precedingBottomPx === undefined
      ? 0
      : Math.max(0, rowRect.top - precedingBottomPx);
  return CONVERSATION_CONTEXT_RESERVE_LINES * linePx + gapPx;
}

/**
 * Scroll content below the row: later transcript rows plus the transcript's own
 * bottom padding and fade. At the live edge that sits between the row and the
 * bottom of the viewport, so the row cannot spend it. Measured as a distance
 * from the row's bottom to the end of the scrollable content, which is
 * independent of both the current scroll position and the row's own height.
 */
function trailingScrollContentPx(
  rowRect: DOMRect,
  viewport: HTMLElement | null,
): number {
  if (!viewport) return 0;
  const rowBottomInContentPx =
    viewport.scrollTop + rowRect.bottom - viewport.getBoundingClientRect().top;
  return Math.max(0, viewport.scrollHeight - rowBottomInContentPx);
}

function clearStackedThinkingBudget(row: HTMLElement): void {
  delete row.dataset[PREVIOUS_THINKING_STATE_ATTR];
  row.style.removeProperty(STACKED_THINKING_BUDGET_VAR);
}

/**
 * Bound a previous thinking card that wrapped below the current one, and drop
 * it when even a short thought no longer fits.
 *
 * Beside the current card the previous one costs nothing: it caps to the
 * current card's height, which already owns the row. Below it, its height adds
 * to the row, so the pair can outgrow the transcript viewport — and since the
 * current card comes first, that is the one that leaves the top of the screen
 * under follow.
 *
 * Every input is read off the row's first line and the current card, never off
 * the previous card's own height, and a dropped card keeps its box in the flex
 * layout at zero height. Both matter for the same reason: removing the item
 * would change the wrap the budget was measured from, and the drop decision
 * would flap. See topics/responsive-layout-gaps.md on conditional visibility.
 *
 * @returns the tallest the row may be, for the height reserve to respect.
 */
function syncStackedThinkingBudget(
  row: HTMLElement,
  viewport: HTMLElement | null,
): number | null {
  const viewportHeightPx = viewport?.clientHeight || window.innerHeight;
  if (!(viewportHeightPx > 0)) {
    clearStackedThinkingBudget(row);
    return null;
  }
  const rowRect = row.getBoundingClientRect();
  const contextReservePx = conversationContextReservePx(row, rowRect);
  const trailingContentPx = trailingScrollContentPx(rowRect, viewport);
  const rowCeilingPx = conversationRowHeightCeilingPx(
    viewportHeightPx,
    trailingContentPx + contextReservePx,
  );

  const latestCard = row.querySelector<HTMLElement>(
    LATEST_THINKING_PREVIEW_SELECTOR,
  );
  const previousCard = row.querySelector<HTMLElement>(
    PREVIOUS_THINKING_PREVIEW_SELECTOR,
  );
  if (!latestCard || !previousCard) {
    clearStackedThinkingBudget(row);
    return rowCeilingPx;
  }

  const latestRect = latestCard.getBoundingClientRect();
  const previousRect = previousCard.getBoundingClientRect();
  if (previousRect.top - latestRect.top <= SHARED_FLEX_LINE_TOLERANCE_PX) {
    // Side by side: the previous card fits inside the height the current card
    // already claims, so its ordinary current-height cap is the whole contract.
    clearStackedThinkingBudget(row);
    return rowCeilingPx;
  }

  const latestContent = latestCard.querySelector<HTMLElement>(
    THINKING_PREVIEW_CONTENT_SELECTOR,
  );
  const budgetPx = stackedThinkingBudgetPx({
    viewportHeightPx,
    trailingContentPx,
    contextReservePx,
    previousTopPx: previousRect.top - rowRect.top,
    previousChromePx:
      latestRect.height -
      (latestContent?.getBoundingClientRect().height ?? 0) +
      (Number.parseFloat(window.getComputedStyle(latestCard).marginBottom) ||
        0),
  });
  if (budgetPx === null) {
    row.dataset[PREVIOUS_THINKING_STATE_ATTR] = "dropped";
    row.style.removeProperty(STACKED_THINKING_BUDGET_VAR);
  } else {
    row.dataset[PREVIOUS_THINKING_STATE_ATTR] = "stacked";
    row.style.setProperty(
      STACKED_THINKING_BUDGET_VAR,
      `${Math.round(budgetPx)}px`,
    );
  }
  return rowCeilingPx;
}

/**
 * Apply the row's held height and re-arm the release.
 *
 * The natural height is measured from the children's bottoms rather than the
 * row's own box: the reserve is applied as the row's `min-height`, so measuring
 * the row would feed the reserve back into itself and it could never fall.
 *
 * `ceilingPx` bounds what may be held. The reserve exists to keep the reader's
 * place, so holding more than the viewport can show would defeat it.
 */
function syncActivityHeightReserve(
  row: HTMLElement,
  controller: ActivityHeightReserveController,
  ceilingPx: number | null = null,
): void {
  const rowTop = row.getBoundingClientRect().top;
  let naturalHeightPx = 0;
  for (const child of Array.from(row.children)) {
    naturalHeightPx = Math.max(
      naturalHeightPx,
      child.getBoundingClientRect().bottom - rowTop,
    );
  }
  const nowMs = Date.now();
  const reserve = updateActivityHeightReserve(
    controller.reserve,
    naturalHeightPx,
    nowMs,
  );
  controller.reserve = reserve;
  row.style.setProperty(
    "--conversation-activity-reserved-height",
    `${ceilingPx === null ? reserve.heightPx : Math.min(reserve.heightPx, ceilingPx)}px`,
  );
  if (controller.timer !== null) {
    window.clearTimeout(controller.timer);
    controller.timer = null;
  }
  const delayMs = activityHeightReserveReleaseDelayMs(reserve, nowMs);
  if (delayMs === null) return;
  // Content changes re-measure on their own; this wake-up is only for the case
  // where nothing else happens before the hold expires.
  controller.timer = window.setTimeout(() => {
    controller.timer = null;
    syncActivityHeightReserve(row, controller);
  }, delayMs);
}

function formatConversationActivityDuration(seconds: number): string {
  if (seconds >= 10 && seconds < 60) {
    return `${Math.round(seconds)}s`;
  }
  return formatCommandDuration(seconds);
}

function ConversationActivitySummary({
  item,
  onToggle,
  collapsedThinkingPreviewSlots,
  onToggleThinkingPreview,
  onDismissThinkingPreview,
  widerActivityPreviews,
}: {
  item: Extract<RenderItem, { type: "conversation_activity" }>;
  onToggle?: (itemId: string) => void;
  collapsedThinkingPreviewSlots: ReadonlySet<ConversationThinkingPreviewSlot>;
  onToggleThinkingPreview?: (slot: ConversationThinkingPreviewSlot) => void;
  onDismissThinkingPreview?: (slot: ConversationThinkingPreviewSlot) => void;
  widerActivityPreviews: boolean;
}) {
  const { t } = useI18n();
  const rowRef = useRef<HTMLDivElement>(null);
  const activityListRef = useRef<HTMLUListElement>(null);
  const ignoreAdjustedTouchClickRef = useRef(false);
  const adjustedTouchClickResetTimerRef = useRef<number | null>(null);
  const [autoHidePhase, setAutoHidePhase] = useState<
    "visible" | "fading" | "hidden"
  >(() =>
    conversationThinkingAutoHideDelayMs({
      active: item.active,
      hasFollowingConversationText: Boolean(item.hasFollowingConversationText),
      endedAtMs: item.endedAtMs,
      nowMs: Date.now(),
    }) === 0
      ? "hidden"
      : "visible",
  );
  const previousThinkingPreviewCountRef = useRef(
    item.thinkingPreviews?.length ?? 0,
  );
  const [thinkingShownSinceMs, setThinkingShownSinceMs] = useState<
    number | null
  >(null);
  const clearAdjustedTouchClick = useCallback(() => {
    ignoreAdjustedTouchClickRef.current = false;
    if (adjustedTouchClickResetTimerRef.current !== null) {
      window.clearTimeout(adjustedTouchClickResetTimerRef.current);
      adjustedTouchClickResetTimerRef.current = null;
    }
  }, []);
  useEffect(() => clearAdjustedTouchClick, [clearAdjustedTouchClick]);
  const handleSummaryPointerDown = (
    event: React.PointerEvent<HTMLButtonElement>,
  ) => {
    clearAdjustedTouchClick();
    if (event.pointerType !== "touch") return;
    const rect = event.currentTarget.getBoundingClientRect();
    ignoreAdjustedTouchClickRef.current =
      event.clientX < rect.left ||
      event.clientX >= rect.right ||
      event.clientY < rect.top ||
      event.clientY >= rect.bottom;
  };
  const handleSummaryPointerUp = () => {
    if (!ignoreAdjustedTouchClickRef.current) return;
    // Chrome dispatches the adjusted click synchronously after pointerup. Drop
    // the guard on the next task so a cancelled/non-clicking gesture cannot
    // suppress a later keyboard activation.
    adjustedTouchClickResetTimerRef.current = window.setTimeout(
      clearAdjustedTouchClick,
      0,
    );
  };
  const handleSummaryClick = () => {
    if (ignoreAdjustedTouchClickRef.current) {
      clearAdjustedTouchClick();
      return;
    }
    onToggle?.(item.id);
  };
  // The recent-activity list is newest-first and clips its oldest (bottom) rows
  // when they exceed the thinking height. Mark it so the stylesheet can fade
  // that bottom edge — but only while it actually overflows, so a short list
  // that fully fits is not faded as if more rows were hidden below it.
  const syncActivityClip = useCallback(() => {
    const list = activityListRef.current;
    if (!list) return;
    list.classList.toggle(
      "is-clipped",
      list.scrollHeight - list.clientHeight > 1,
    );
  }, []);
  // Publish the current/latest thinking preview's rendered content height as a
  // CSS var on the row. Its siblings — the recent-activity list and the
  // superseded "previous" preview — cap themselves to it, so neither claims
  // more vertical space than the current thinking block requests. Capping the
  // previous preview to the current height also lets the current block own the
  // row height, so the previous preview vanishing at turn end causes no shrink
  // (and thus no autofollow flicker). See topics/responsive-layout-gaps.md.
  const previewLayoutKey = item.thinkingPreviews
    ?.map(
      (preview) =>
        `${preview.slot}:${
          collapsedThinkingPreviewSlots.has(preview.slot) ? "c" : "o"
        }`,
    )
    .join("|");
  // biome-ignore lint/correctness/useExhaustiveDependencies: previewLayoutKey re-attaches the observer when the measured preview element mounts/unmounts
  useLayoutEffect(() => {
    const row = rowRef.current;
    if (!row) return;
    const latestCard = row.querySelector<HTMLElement>(
      LATEST_THINKING_PREVIEW_SELECTOR,
    );
    if (!latestCard) {
      // No current/latest preview: nothing to cap to (the previous preview
      // cannot exist and the activity list is gated off), so leave the CSS
      // fallback in place.
      row.style.removeProperty("--conversation-thinking-height");
      return;
    }
    const content = latestCard.querySelector<HTMLElement>(
      THINKING_PREVIEW_CONTENT_SELECTOR,
    );
    if (!content) {
      // The current/latest card is collapsed to its header. Publish 0 so the
      // previous preview and activity list clip to that header-only height too,
      // rather than falling back to the full viewport cap and rendering taller
      // than the current card — height(previous) ≤ height(current) always.
      row.style.setProperty("--conversation-thinking-height", "0px");
      return;
    }
    const publishHeight = () => {
      row.style.setProperty(
        "--conversation-thinking-height",
        `${content.offsetHeight}px`,
      );
      // The cap change alters the list's clientHeight; re-evaluate its bottom
      // fade in the same layout pass.
      syncActivityClip();
    };
    publishHeight();
    const observer = new ResizeObserver(publishHeight);
    observer.observe(content);
    return () => observer.disconnect();
  }, [previewLayoutKey, syncActivityClip]);
  // Hold the row's vertical space across shrinks. A long streaming thinking
  // block grows this row, and when a shorter block replaces it the row would
  // hand that height straight back — in follow mode that drags everything the
  // reader was reading down the viewport. Instead the row keeps its high-water
  // height and releases it only after a hold spent continuously wanting less,
  // so a turn alternating thinking and activity never spends the wait out.
  const reserveRef = useRef<ActivityHeightReserveController>({
    reserve: null,
    timer: null,
  });
  const transcriptViewportRef = useRef<HTMLElement | null>(null);
  const syncHeightReserve = useCallback(() => {
    const row = rowRef.current;
    if (!row) return;
    // Bound a wrapped previous card first: the reserve has to measure the row
    // after that cap lands, and it must not hold a height the viewport lost.
    const ceilingPx = syncStackedThinkingBudget(
      row,
      transcriptViewportRef.current,
    );
    syncActivityHeightReserve(row, reserveRef.current, ceilingPx);
  }, []);
  const hasThinkingPreviews = (item.thinkingPreviews?.length ?? 0) > 0;
  // biome-ignore lint/correctness/useExhaustiveDependencies: previewLayoutKey re-attaches the observers when the measured children mount/unmount
  useLayoutEffect(() => {
    const row = rowRef.current;
    if (!row) return;
    // Only a row carrying previews can outgrow the viewport, so only that row
    // watches the scroller — every other activity row would be a spare observer
    // on a shared element.
    const viewport = hasThinkingPreviews ? findTranscriptViewport(row) : null;
    transcriptViewportRef.current = viewport;
    syncHeightReserve();
    // Watch the children, not just the row: while the reserve holds, the row's
    // own box stays put and only a child's resize reveals the shrink.
    const observer = new ResizeObserver(syncHeightReserve);
    observer.observe(row);
    for (const child of Array.from(row.children)) observer.observe(child);
    // A shrinking viewport (rotation, a growing composer) tightens the budget
    // without any content changing.
    if (viewport) observer.observe(viewport);
    const controller = reserveRef.current;
    return () => {
      observer.disconnect();
      transcriptViewportRef.current = null;
      if (controller.timer !== null) {
        window.clearTimeout(controller.timer);
        controller.timer = null;
      }
    };
  }, [hasThinkingPreviews, previewLayoutKey, syncHeightReserve]);
  // The hold is for space the reader still needs; two gestures say otherwise
  // and release it at once. Collapsing a card with its chevron asks for a
  // shorter row and keeps that card collapsed as later blocks stream into the
  // slot, so the space really is freed. Dismissing one card of two does not:
  // thinking stays visible and the space is about to be used again. Dismissing
  // the last card hides thinking entirely, which does.
  const previewCount = item.thinkingPreviews?.length ?? 0;
  const collapsedSlotsKey = (item.thinkingPreviews ?? [])
    .filter((preview) => collapsedThinkingPreviewSlots.has(preview.slot))
    .map((preview) => preview.slot)
    .join("|");
  const previousCollapsedSlotsRef = useRef(collapsedSlotsKey);
  const previousPreviewCountRef = useRef(previewCount);
  useLayoutEffect(() => {
    const wasCollapsed = new Set(
      previousCollapsedSlotsRef.current.split("|").filter(Boolean),
    );
    const readerCollapsedACard = collapsedSlotsKey
      .split("|")
      .filter(Boolean)
      .some((slot) => !wasCollapsed.has(slot));
    const thinkingJustHidden =
      previewCount === 0 && previousPreviewCountRef.current > 0;
    previousCollapsedSlotsRef.current = collapsedSlotsKey;
    previousPreviewCountRef.current = previewCount;
    if (readerCollapsedACard || thinkingJustHidden) {
      reserveRef.current.reserve = null;
      syncHeightReserve();
    }
  }, [collapsedSlotsKey, previewCount, syncHeightReserve]);
  // Re-evaluate the bottom fade when the rendered activity rows change (new
  // rows can start overflowing the cap without the thinking height moving).
  // biome-ignore lint/correctness/useExhaustiveDependencies: recentActivities identity is the render-changed trigger
  useLayoutEffect(() => {
    syncActivityClip();
  }, [syncActivityClip, item.recentActivities]);
  useEffect(() => {
    const count = item.thinkingPreviews?.length ?? 0;
    const previousCount = previousThinkingPreviewCountRef.current;
    previousThinkingPreviewCountRef.current = count;
    if (count === 0) {
      setThinkingShownSinceMs(null);
      return;
    }
    if (previousCount === 0) {
      // A card that arrives after this row mounted — a live turn's first
      // thought, or thinking switched back on — starts its own glance window
      // so it cannot appear and vanish in the same breath.
      setThinkingShownSinceMs(Date.now());
      setAutoHidePhase("visible");
    }
  }, [item.thinkingPreviews?.length]);
  useEffect(() => {
    const delay = conversationThinkingAutoHideDelayMs({
      active: item.active,
      hasFollowingConversationText: Boolean(item.hasFollowingConversationText),
      endedAtMs: item.endedAtMs,
      shownSinceMs: thinkingShownSinceMs,
      nowMs: Date.now(),
    });
    if (delay === null) {
      setAutoHidePhase("visible");
      return;
    }
    if (delay === 0) {
      setAutoHidePhase((phase) => (phase === "visible" ? "hidden" : phase));
      return;
    }
    setAutoHidePhase("visible");
    const start = window.setTimeout(() => {
      setAutoHidePhase("fading");
    }, delay);
    return () => window.clearTimeout(start);
  }, [
    item.active,
    item.endedAtMs,
    item.hasFollowingConversationText,
    thinkingShownSinceMs,
  ]);
  useEffect(() => {
    if (autoHidePhase !== "fading") return;
    const finish = window.setTimeout(() => {
      setAutoHidePhase("hidden");
    }, CONVERSATION_THINKING_AUTO_HIDE_ROLLUP_MS);
    return () => window.clearTimeout(finish);
  }, [autoHidePhase]);
  useLayoutEffect(() => {
    const row = rowRef.current;
    if (autoHidePhase === "fading" && row) {
      const summary = row.querySelector<HTMLElement>(
        ".conversation-activity-summary",
      );
      const fromHeight = row.offsetHeight;
      let toHeight = fromHeight;
      if (summary) {
        const summaryStyle = window.getComputedStyle(summary);
        toHeight = Math.ceil(
          (Number.parseFloat(summaryStyle.marginTop) || 0) +
            summary.offsetHeight +
            (Number.parseFloat(summaryStyle.marginBottom) || 0),
        );
      }
      row.style.height = `${fromHeight}px`;
      reserveRef.current.reserve = null;
      row.style.removeProperty("--conversation-activity-reserved-height");
      const frame = window.requestAnimationFrame(() => {
        row.style.height = `${Math.min(fromHeight, toHeight)}px`;
      });
      return () => window.cancelAnimationFrame(frame);
    }
    // The rollup pins a height to animate from. Leaving it behind would hold
    // the row at the compact height, so drop it whichever way the rollup ends
    // — including a new turn interrupting it.
    if (row) {
      row.style.removeProperty("height");
    }
    if (autoHidePhase === "visible") return;
    reserveRef.current.reserve = null;
    syncHeightReserve();
  }, [autoHidePhase, syncHeightReserve]);
  const elapsedSeconds =
    item.startedAtMs !== null &&
    item.endedAtMs !== null &&
    item.endedAtMs >= item.startedAtMs
      ? (item.endedAtMs - item.startedAtMs) / 1000
      : null;
  const duration =
    elapsedSeconds === null
      ? ""
      : formatConversationActivityDuration(elapsedSeconds);
  const activity = t(
    item.activityCount === 1
      ? "conversationActivitySingular"
      : "conversationActivityPlural",
  );
  const label = duration
    ? t(
        item.active
          ? "conversationActivityActive"
          : "conversationActivityComplete",
        {
          duration,
          count: item.activityCount,
          activity,
        },
      )
    : t(
        item.active
          ? "conversationActivityActiveWithoutTime"
          : "conversationActivityCompleteWithoutTime",
        {
          count: item.activityCount,
          activity,
        },
      );
  const title = t(
    item.expanded
      ? "conversationActivityCollapseTitle"
      : "conversationActivityExpandTitle",
  );
  const tooltipActivityDetails = item.tooltipActivities
    ?.map((activity) => activity.detail)
    .join("\n");
  const tooltipAttributes = useTextTooltipAttributes(
    title,
    tooltipActivityDetails
      ? {
          headline: label,
          detail: `${tooltipActivityDetails}${
            item.activityCount > (item.tooltipActivities?.length ?? 0)
              ? "\n…"
              : ""
          }`,
        }
      : undefined,
  );
  const showThinkingPreviews = autoHidePhase !== "hidden";
  const autoHidingThinking = autoHidePhase === "fading";
  const hasExpandedThinkingPreview =
    showThinkingPreviews &&
    item.thinkingPreviews?.some(
      (preview) => !collapsedThinkingPreviewSlots.has(preview.slot),
    );

  return (
    <div
      className={`conversation-activity-row ${styles.activityHeightReserve}${
        widerActivityPreviews ? " is-wide-activity-previews" : ""
      }${autoHidingThinking ? ` ${styles.thinkingRollingUp}` : ""}`}
      ref={rowRef}
      style={
        autoHidingThinking
          ? ({
              "--conversation-thinking-rollup-ms": `${CONVERSATION_THINKING_AUTO_HIDE_ROLLUP_MS}ms`,
            } as CSSProperties)
          : undefined
      }
    >
      <div className="conversation-activity-column">
        <button
          type="button"
          className={`conversation-activity-summary${
            item.active ? " is-active" : ""
          }${item.expanded ? " is-expanded" : ""}`}
          onClick={handleSummaryClick}
          onPointerCancel={clearAdjustedTouchClick}
          onPointerDown={handleSummaryPointerDown}
          onPointerUp={handleSummaryPointerUp}
          aria-expanded={item.expanded}
          {...tooltipAttributes}
        >
          <span
            className={`${styles.activityChevron}${
              item.expanded ? ` ${styles.activityChevronExpanded}` : ""
            }`}
            aria-hidden="true"
          >
            {item.expanded ? "▾" : "▸"}
          </span>
          {item.active ? (
            <span className={styles.activityPulse} aria-hidden="true" />
          ) : null}
          <span className={styles.activityLabel}>{label}</span>
        </button>
        {hasExpandedThinkingPreview && item.recentActivities ? (
          <ul
            ref={activityListRef}
            className={`conversation-recent-activities${
              autoHidingThinking ? ` ${styles.thinkingAutoHiding}` : ""
            }`}
            aria-label={t("conversationRecentActivities")}
          >
            {item.recentActivities.map((activity, index) => (
              <ConversationRecentActivityName
                activity={activity}
                key={`${activity.label}-${index}`}
              />
            ))}
          </ul>
        ) : null}
      </div>
      {showThinkingPreviews
        ? item.thinkingPreviews?.map((preview) => (
            <ConversationThinkingPreview
              autoHiding={autoHidingThinking}
              collapsed={collapsedThinkingPreviewSlots.has(preview.slot)}
              key={preview.slot}
              turnEndedAtMs={item.endedAtMs}
              onDismiss={onDismissThinkingPreview}
              onToggle={onToggleThinkingPreview}
              preview={preview}
            />
          ))
        : null}
    </div>
  );
}

function ConversationRecentActivityName({
  activity,
}: {
  activity: ConversationRecentActivity;
}) {
  const tooltipAttributes = useTextTooltipAttributes(activity.detail);
  return (
    <li {...tooltipAttributes}>
      <span className="conversation-recent-activity-name">
        {activity.label}
      </span>
      {activity.preview ? (
        <span className="conversation-recent-activity-preview">
          {activity.preview}
        </span>
      ) : null}
    </li>
  );
}

function estimateThinkingPreviewWidth(text: string): number {
  let longestLineLength = 0;
  for (const line of text.replace(/\r\n?/g, "\n").split("\n")) {
    longestLineLength = Math.max(longestLineLength, line.length);
  }
  return longestLineLength * 8;
}

/**
 * How far back in the turn a thinking block sits, measured to the turn's end
 * (the live clock while the turn runs). This is placement, not duration: the
 * summary beside it already says how long the whole turn took, so an age here
 * says where in that span the thought happened.
 *
 * A streaming block is happening now, so it gets no age. Sub-second ages are
 * omitted too — "0.4s ago" on a thought that just landed is noise, and the
 * pulsing dot already carries recency at that scale.
 */
function formatThinkingPreviewAge(
  preview: ConversationThinkingPreviewData,
  turnEndedAtMs: number | null,
): string {
  if (preview.status === "streaming") return "";
  if (preview.endedAtMs === null || turnEndedAtMs === null) return "";
  const seconds = (turnEndedAtMs - preview.endedAtMs) / 1000;
  if (!Number.isFinite(seconds) || seconds < 1) return "";
  return formatConversationActivityDuration(seconds);
}

function ConversationThinkingPreview({
  preview,
  collapsed,
  autoHiding,
  onToggle,
  onDismiss,
  turnEndedAtMs,
}: {
  preview: ConversationThinkingPreviewData;
  collapsed: boolean;
  autoHiding: boolean;
  onToggle?: (slot: ConversationThinkingPreviewSlot) => void;
  onDismiss?: (slot: ConversationThinkingPreviewSlot) => void;
  /** The turn's end, or the live clock while it runs. */
  turnEndedAtMs: number | null;
}) {
  const { t } = useI18n();
  const contentRef = useRef<HTMLDivElement>(null);
  const [widthState, setWidthState] =
    useState<ThinkingPreviewWidthState | null>(null);
  const label = t(
    preview.kind === "current"
      ? "conversationThinkingPreviewCurrent"
      : preview.kind === "latest"
        ? "conversationThinkingPreviewLatest"
        : "conversationThinkingPreviewPrevious",
  );
  const toggleLabel = t(
    !collapsed
      ? "conversationThinkingPreviewCollapse"
      : "conversationThinkingPreviewExpand",
  );
  const dismissLabel = t("conversationThinkingPreviewDismiss", { label });
  const age = formatThinkingPreviewAge(preview, turnEndedAtMs);
  const targetWidthPx =
    widthState?.id === preview.id
      ? widthState.targetWidthPx
      : THINKING_PREVIEW_DEFAULT_WIDTH_PX;

  useLayoutEffect(() => {
    if (collapsed) return;
    const thinkingText =
      contentRef.current?.querySelector<HTMLElement>(".thinking-text");
    if (!thinkingText) return;

    const previousDisplay = thinkingText.style.display;
    const previousWidth = thinkingText.style.width;
    const previousMaxWidth = thinkingText.style.maxWidth;
    thinkingText.style.display = thinkingText.classList.contains(
      "thinking-outline",
    )
      ? "inline-grid"
      : "inline-block";
    thinkingText.style.width = "max-content";
    thinkingText.style.maxWidth = "none";
    const measuredWidth = thinkingText.getBoundingClientRect().width;
    thinkingText.style.display = previousDisplay;
    thinkingText.style.width = previousWidth;
    thinkingText.style.maxWidth = previousMaxWidth;

    const requiredWidth =
      measuredWidth > 0
        ? measuredWidth
        : estimateThinkingPreviewWidth(preview.thinking);
    setWidthState((previous) =>
      updateThinkingPreviewWidth(previous, preview.id, requiredWidth),
    );
  }, [collapsed, preview.id, preview.thinking]);

  // Follow the streaming tail so newly appended thinking stays visible, unless
  // the user has scrolled up to read. Static/previous thinking never follows.
  const { onScroll: onContentScroll } = useStickToBottom(
    contentRef,
    preview.thinking,
    {
      enabled: preview.status === "streaming",
      identity: preview.id,
    },
  );

  return (
    <div
      className={`conversation-thinking-preview${
        preview.status === "streaming" ? " is-streaming" : ""
      }${collapsed ? " is-collapsed" : ""}${
        autoHiding ? ` ${styles.thinkingAutoHiding}` : ""
      }`}
      data-preview-slot={preview.slot}
      style={
        {
          "--conversation-thinking-preview-target-width": `${targetWidthPx}px`,
        } as CSSProperties
      }
    >
      <div className="conversation-thinking-preview-header">
        <button
          type="button"
          className="conversation-thinking-preview-toggle"
          aria-expanded={!collapsed}
          aria-label={toggleLabel}
          title={toggleLabel}
          onClick={() => onToggle?.(preview.slot)}
        >
          <span className="conversation-thinking-preview-dot" aria-hidden />
          <span className={styles.thinkingPreviewLabel}>{label}</span>
          {age ? (
            <span
              className={styles.thinkingPreviewAge}
              title={t("conversationThinkingPreviewAgeTitle", {
                duration: age,
              })}
            >
              {t("conversationThinkingPreviewAge", { duration: age })}
            </span>
          ) : null}
          <span className="conversation-thinking-preview-chevron" aria-hidden>
            {collapsed ? "▸" : "▾"}
          </span>
        </button>
        <button
          type="button"
          className="conversation-thinking-preview-dismiss"
          aria-label={dismissLabel}
          title={dismissLabel}
          onClick={() => onDismiss?.(preview.slot)}
        >
          ×
        </button>
      </div>
      {!collapsed ? (
        <div
          ref={contentRef}
          className="conversation-thinking-preview-content"
          onScroll={onContentScroll}
        >
          <ThinkingText
            text={preview.thinking}
            isStreaming={preview.status === "streaming"}
          />
        </div>
      ) : null}
    </div>
  );
}

export const RenderItemComponent = memo(function RenderItemComponent({
  item,
  isStreaming,
  thinkingExpanded,
  toggleThinkingExpanded,
  sessionProvider,
  onCorrectUserPrompt,
  onCancelUnconfirmedUserPrompt,
  onTrimBeforeUserPrompt,
  onForkBeforeUserPrompt,
  onForkAfterUserPrompt,
  onForkAfterSummaryUserPrompt,
  forkAfterUserPromptDisabled,
  forkUnavailableMessage,
  onQuoteTextBlock,
  alwaysShowQuoteCircle,
  paragraphQuoteCirclesEnabled,
  staleNowMs,
  thinkingDurationMs,
  getForkSummaryTargetHref,
  onCancelForkSummary,
  onToggleForkSummaryAutoOpen,
  onFollowForkSummary,
  bangCommandHandlers,
  onToggleConversationActivity,
  widerConversationActivityPreviews = false,
  collapsedConversationThinkingPreviewSlots = new Set<ConversationThinkingPreviewSlot>(),
  onToggleConversationThinkingPreview,
  onDismissConversationThinkingPreview,
}: Props) {
  const { t } = useI18n();
  const staticAgeNowMsRef = useRef(Date.now());
  const timestampMs = getLatestMessageTimestampMs(item.sourceMessages);
  const hasTimestamp =
    item.type !== "conversation_activity" && timestampMs !== null;
  const isLatestVisibleTimestamp = hasTimestamp && staleNowMs !== undefined;
  const ageNowMs = isLatestVisibleTimestamp
    ? (staleNowMs ?? Date.now())
    : staticAgeNowMsRef.current;
  const showAgeByDefault =
    isLatestVisibleTimestamp &&
    ageNowMs !== null &&
    ageNowMs - timestampMs >= MESSAGE_STALE_THRESHOLD_MS;
  const recapQuoteRef = useQuoteableTextSource<HTMLSpanElement>(
    item.type === "system" && item.subtype === "away_summary"
      ? item.content
      : "",
  );

  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      // Don't interfere with text selection (important for mobile long-press)
      const selection = window.getSelection();
      if (selection && selection.toString().length > 0) {
        return;
      }

      // Shift+click to debug (not Cmd/Ctrl+click, which opens links in new tabs)
      if (e.shiftKey && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        e.stopPropagation();
        console.log(
          "[DEBUG] Render snapshot",
          buildDebugSnapshot(item, {
            isStreaming,
            thinkingExpanded,
            sessionProvider,
          }),
        );
      }
    },
    [item, isStreaming, thinkingExpanded, sessionProvider],
  );

  const renderContent = () => {
    switch (item.type) {
      case "text":
        return (
          <AsyncQuestionMessage
            renderId={item.id}
            fallback={
              <TextBlock
                text={item.text}
                isStreaming={item.isStreaming}
                abortedMidStream={item.abortedMidStream}
                augmentHtml={item.augmentHtml}
                projectPathLinks={item.projectPathLinks}
                renderItemId={item.id}
                onQuoteBlock={onQuoteTextBlock}
                alwaysShowQuoteCircle={alwaysShowQuoteCircle}
                paragraphQuoteCirclesEnabled={paragraphQuoteCirclesEnabled}
              />
            }
          />
        );

      case "thinking":
        return (
          <ThinkingBlock
            thinking={item.thinking}
            status={item.status}
            isExpanded={thinkingExpanded}
            onToggle={toggleThinkingExpanded}
            durationMs={thinkingDurationMs}
          />
        );

      case "tool_call":
        return (
          <ToolCallRow
            id={item.id}
            toolName={item.toolName}
            toolInput={item.toolInput}
            toolResult={item.toolResult}
            workflow={item.workflow}
            status={item.status}
            sessionProvider={sessionProvider}
            startTimestampMs={getEarliestMessageTimestampMs(
              item.sourceMessages,
            )}
            resultTimestampMs={
              item.sourceMessages.length > 1 ? timestampMs : null
            }
          />
        );

      case "user_prompt": {
        const deliveryState = getUserPromptDeliveryState(item.sourceMessages);
        const cancellableTempId = getCancellableUnconfirmedSteerTempId(
          item.sourceMessages,
        );
        return (
          <UserPromptBlock
            content={item.content}
            projectPathLinks={item.projectPathLinks}
            onCorrect={onCorrectUserPrompt}
            onCancelUnconfirmed={
              cancellableTempId && onCancelUnconfirmedUserPrompt
                ? () => onCancelUnconfirmedUserPrompt(cancellableTempId)
                : undefined
            }
            onTrimBefore={onTrimBeforeUserPrompt}
            onForkBefore={onForkBeforeUserPrompt}
            onForkAfter={onForkAfterUserPrompt}
            onForkAfterSummary={onForkAfterSummaryUserPrompt}
            forkAfterDisabled={forkAfterUserPromptDisabled}
            forkUnavailableMessage={forkUnavailableMessage}
            deliveryState={deliveryState}
          />
        );
      }

      case "session_setup":
        return <SessionSetupBlock title={item.title} prompts={item.prompts} />;

      case "transcript_display_object": {
        const displayObject = item.object;
        if (displayObject.kind === "bang-command") {
          return (
            <BangCommandDisplayObject
              object={displayObject}
              handlers={bangCommandHandlers}
            />
          );
        }
        return (
          <ForkSummaryDisplayObject
            object={displayObject}
            targetHref={
              displayObject.targetSessionId
                ? getForkSummaryTargetHref?.(displayObject.targetSessionId)
                : undefined
            }
            onCancel={() => onCancelForkSummary?.(displayObject.id)}
            onToggleAutoOpen={(value) =>
              onToggleForkSummaryAutoOpen?.(displayObject.id, value)
            }
            onFollow={() => onFollowForkSummary?.(displayObject.id)}
          />
        );
      }

      case "task_notification":
        return <TaskNotificationBlock item={item} />;

      case "conversation_activity":
        return (
          <ConversationActivitySummary
            item={item}
            onToggle={onToggleConversationActivity}
            collapsedThinkingPreviewSlots={
              collapsedConversationThinkingPreviewSlots
            }
            onToggleThinkingPreview={onToggleConversationThinkingPreview}
            onDismissThinkingPreview={onDismissConversationThinkingPreview}
            widerActivityPreviews={widerConversationActivityPreviews}
          />
        );

      case "system": {
        if (item.subtype === "local_command" && item.content === "/goal") {
          const [objective = "", ...status] = (item.details ?? []).map(
            systemDetailToText,
          );
          return (
            <GoalNotice objective={objective} status={status.join("\n")} />
          );
        }
        if (item.subtype === "away_summary") {
          return (
            <div className="system-message-recap">
              <span className="system-message-recap-mark">※</span>
              <span ref={recapQuoteRef} className="system-message-recap-body">
                <LinkifiedText text={item.content} />
              </span>
            </div>
          );
        }

        // Different styling for compacting vs completed compaction
        const isCompacting =
          item.subtype === "status" && item.status === "compacting";
        const isError = item.subtype === "error";
        const isWarning = item.subtype === "warning";
        const isConfigAck = item.subtype === "config_ack";
        const isLocalCommand = item.subtype === "local_command";
        const isToolOutput = item.subtype === "tool_output";
        const isSubagentActivity = item.subtype === "subagent_activity";
        const isNoModelTurn = item.subtype === "no_model_turn";
        const isHistorySearchGap = item.subtype === "history_search_gap";
        const isHighlightedConfigAck =
          isConfigAck && item.configChanged !== false;
        const icon =
          isError || isWarning
            ? "!"
            : isConfigAck
              ? "✓"
              : isLocalCommand
                ? "/"
                : isToolOutput
                  ? "<"
                  : isSubagentActivity
                    ? "↳"
                    : isNoModelTurn
                      ? "∅"
                      : isHistorySearchGap
                        ? "⋯"
                        : "⟳";
        if (
          item.subtype === "compact_boundary" ||
          isLocalCommand ||
          isToolOutput
        ) {
          return (
            <CollapsibleSystemMessage
              item={item}
              icon={icon}
              label={
                isToolOutput
                  ? item.content
                    ? t("toolOutputFrom", { tool: item.content })
                    : t("toolOutput")
                  : undefined
              }
            />
          );
        }
        return (
          <div
            className={`system-message ${isCompacting ? "system-message-compacting" : ""} ${isError ? "system-message-error" : ""} ${isWarning ? "system-message-warning" : ""} ${isHighlightedConfigAck ? "system-message-config-ack" : ""} ${isLocalCommand ? "system-message-local-command" : ""}`}
          >
            <span
              className={`system-message-icon ${isCompacting ? "spinning" : ""}`}
            >
              {icon}
            </span>
            <span className="system-message-text">
              <LinkifiedText text={item.content} />
            </span>
          </div>
        );
      }

      default:
        return null;
    }
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: debug shift-click uses row-level event metadata
    // biome-ignore lint/a11y/useKeyWithClickEvents: debug feature, shift+click only
    <div
      className={[
        "message-render-row",
        hasTimestamp ? "has-message-age" : "",
        showAgeByDefault ? "is-message-age-visible" : "",
        item.isSubagent ? "subagent-item" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      data-render-type={item.type}
      data-render-id={item.id}
      onClick={handleClick}
    >
      <div className="message-render-content">
        {item.type === "tool_call" && item.workflow ? (
          <WorkflowContext workflow={item.workflow} />
        ) : null}
        {item.type === "text" && item.workflow?.markers.length ? (
          <WorkflowAssistantOutput
            text={item.text}
            workflow={item.workflow}
            isStreaming={item.isStreaming}
            original={renderContent()}
            renderText={(text, html) => (
              <TextBlock
                text={text}
                augmentHtml={html}
                projectPathLinks={item.projectPathLinks}
                renderItemId={item.id}
                onQuoteBlock={onQuoteTextBlock}
                alwaysShowQuoteCircle={alwaysShowQuoteCircle}
                paragraphQuoteCirclesEnabled={paragraphQuoteCirclesEnabled}
              />
            )}
          />
        ) : (
          renderContent()
        )}
      </div>
      <MessageAge timestampMs={timestampMs} nowMs={ageNowMs ?? Date.now()} />
    </div>
  );
});
