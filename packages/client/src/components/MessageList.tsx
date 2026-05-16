import type { MarkdownAugment } from "@yep-anywhere/shared";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type ActiveToolApproval,
  preprocessMessages,
} from "../lib/preprocessMessages";
import type { Message } from "../types";
import type { RenderItem } from "../types/renderItems";
import { ProcessingIndicator } from "./ProcessingIndicator";
import { RenderItemComponent } from "./RenderItemComponent";
import { TurnDiffSummary } from "./TurnDiffSummary";

interface AssistantTurnGroup {
  isUserPrompt: false;
  items: RenderItem[];
}

interface UserPromptGroup {
  isUserPrompt: true;
  items: RenderItem[];
}

type TurnGroup = AssistantTurnGroup | UserPromptGroup;

interface OperationSegment {
  kind: "operations";
  id: string;
  items: RenderItem[];
}

interface ItemSegment {
  kind: "items";
  items: RenderItem[];
}

type AssistantTurnSegment = OperationSegment | ItemSegment;

interface FoldedReasoningSegment {
  kind: "folded_reasoning";
  id: string;
  summary: string;
  collapsedItems: RenderItem[];
  visibleItems: RenderItem[];
}

type AssistantTurnRenderSegment = AssistantTurnSegment | FoldedReasoningSegment;

/**
 * Groups consecutive assistant items (text, thinking, tool_call) into turns.
 * User prompts break the grouping and are returned as separate groups.
 */
function groupItemsIntoTurns(items: RenderItem[]): TurnGroup[] {
  const groups: TurnGroup[] = [];
  let currentAssistantGroup: RenderItem[] = [];

  for (const item of items) {
    if (item.type === "user_prompt" || item.type === "session_setup") {
      // Flush any pending assistant items
      if (currentAssistantGroup.length > 0) {
        groups.push({ isUserPrompt: false, items: currentAssistantGroup });
        currentAssistantGroup = [];
      }
      // User prompt is its own group
      groups.push({ isUserPrompt: true, items: [item] });
    } else {
      // Accumulate assistant items
      currentAssistantGroup.push(item);
    }
  }

  // Flush remaining assistant items
  if (currentAssistantGroup.length > 0) {
    groups.push({ isUserPrompt: false, items: currentAssistantGroup });
  }

  return groups;
}

function isIntermediateOperationItem(item: RenderItem): boolean {
  return item.type === "tool_call";
}

export function groupAssistantTurnSegments(
  items: RenderItem[],
): AssistantTurnSegment[] {
  const segments: AssistantTurnSegment[] = [];
  let currentItems: RenderItem[] = [];
  let operationRun: RenderItem[] = [];

  const flushCurrentItems = () => {
    if (currentItems.length > 0) {
      segments.push({ kind: "items", items: currentItems });
      currentItems = [];
    }
  };

  const flushOperationRun = () => {
    if (operationRun.length === 0) {
      return;
    }

    const first = operationRun[0];
    const last = operationRun[operationRun.length - 1];
    if (first && last) {
      flushCurrentItems();
      segments.push({
        kind: "operations",
        id: `ops-${first.id}-${last.id}`,
        items: operationRun,
      });
    }

    operationRun = [];
  };

  for (const item of items) {
    if (isIntermediateOperationItem(item)) {
      operationRun.push(item);
      continue;
    }

    flushOperationRun();
    currentItems.push(item);
  }

  flushOperationRun();
  flushCurrentItems();

  return segments;
}

function getOperationSegmentSummary(items: RenderItem[]): string {
  const toolCalls = items.filter((item) => item.type === "tool_call");
  const total = toolCalls.length;
  const pending = toolCalls.filter((item) => item.status === "pending").length;
  const errors = toolCalls.filter((item) => item.status === "error").length;
  const aborted = toolCalls.filter((item) => item.status === "aborted").length;

  const toolNames = Array.from(
    new Set(toolCalls.map((item) => item.toolName).filter(Boolean)),
  );
  const label =
    toolNames.length > 0
      ? toolNames.slice(0, 3).join(" · ")
      : "Intermediate operations";

  const suffix: string[] = [];
  if (pending > 0) suffix.push(`${pending} running`);
  if (errors > 0) suffix.push(`${errors} failed`);
  if (aborted > 0) suffix.push(`${aborted} interrupted`);

  return suffix.length > 0
    ? `${total} operations · ${label} · ${suffix.join(" · ")}`
    : `${total} operations · ${label}`;
}

function isTextItem(item: RenderItem): item is RenderItem & { type: "text" } {
  return item.type === "text";
}

function getTurnDurationMs(items: RenderItem[]): number | null {
  const timestamps = items
    .flatMap((item) => item.sourceMessages)
    .map((msg) =>
      typeof msg.timestamp === "string"
        ? Date.parse(msg.timestamp)
        : Number.NaN,
    )
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => a - b);

  if (timestamps.length < 2) {
    return null;
  }

  const first = timestamps[0];
  const last = timestamps[timestamps.length - 1];
  if (first === undefined || last === undefined) {
    return null;
  }

  return last > first ? last - first : null;
}

function formatDurationLabel(durationMs: number | null): string {
  if (!durationMs || durationMs < 1000) {
    return "Worked for a moment";
  }

  const totalSeconds = Math.round(durationMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  if (minutes <= 0) {
    return `Worked for ${seconds}s`;
  }

  if (seconds === 0) {
    return `Worked for ${minutes}m`;
  }

  return `Worked for ${minutes}m ${seconds}s`;
}

export function buildAssistantTurnRenderSegments(
  items: RenderItem[],
  isTurnStreaming: boolean,
): AssistantTurnRenderSegment[] {
  if (isTurnStreaming) {
    return groupAssistantTurnSegments(items);
  }

  const lastItem = items[items.length - 1];
  if (!lastItem || !isTextItem(lastItem) || items.length < 2) {
    return groupAssistantTurnSegments(items);
  }

  const collapsedItems = items.slice(0, -1);
  if (collapsedItems.length === 0) {
    return groupAssistantTurnSegments(items);
  }

  const durationMs = getTurnDurationMs(items);
  return [
    {
      kind: "folded_reasoning",
      id: `reasoning-${items[0]?.id ?? "turn"}-${lastItem.id}`,
      summary: formatDurationLabel(durationMs),
      collapsedItems,
      visibleItems: [lastItem],
    },
  ];
}

/** Pending message waiting for server confirmation */
interface PendingMessage {
  tempId: string;
  content: string;
  timestamp: string;
  status?: string;
}

/** Deferred message queued server-side */
interface DeferredMessage {
  tempId?: string;
  content: string;
  timestamp: string;
}

interface Props {
  messages: Message[];
  provider?: string;
  isStreaming?: boolean;
  isProcessing?: boolean;
  /** True when context is being compressed */
  isCompacting?: boolean;
  /** Increment this to force scroll to bottom (e.g., when user sends a message) */
  scrollTrigger?: number;
  /** Messages waiting for server confirmation (shown as "Sending...") */
  pendingMessages?: PendingMessage[];
  /** Deferred messages queued server-side (shown as "Queued") */
  deferredMessages?: DeferredMessage[];
  /** Callback to cancel a deferred message */
  onCancelDeferred?: (tempId: string) => void;
  /** Pre-rendered markdown HTML from server (keyed by message ID) */
  markdownAugments?: Record<string, MarkdownAugment>;
  /** Active tool approval - prevents matching orphaned tool from showing as interrupted */
  activeToolApproval?: ActiveToolApproval;
  /** Whether there are older messages not yet loaded */
  hasOlderMessages?: boolean;
  /** Whether older messages are currently being loaded */
  loadingOlder?: boolean;
  /** Callback to load the next chunk of older messages */
  onLoadOlderMessages?: () => void;
}

interface SegmentRenderContext {
  isStreaming: boolean;
  provider?: string;
  thinkingExpanded: boolean;
  toggleThinkingExpanded: () => void;
}

export const MessageList = memo(function MessageList({
  messages,
  provider,
  isStreaming = false,
  isProcessing = false,
  isCompacting = false,
  scrollTrigger = 0,
  pendingMessages = [],
  deferredMessages = [],
  onCancelDeferred,
  markdownAugments,
  activeToolApproval,
  hasOlderMessages = false,
  loadingOlder = false,
  onLoadOlderMessages,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const shouldAutoScrollRef = useRef(true);
  const isInitialLoadRef = useRef(true);
  const isProgrammaticScrollRef = useRef(false);
  const lastHeightRef = useRef(0);
  const followUpScrollRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [thinkingExpanded, setThinkingExpanded] = useState(false);
  const [expandedOperationSegments, setExpandedOperationSegments] = useState<
    Record<string, boolean>
  >({});
  const [expandedReasoningSegments, setExpandedReasoningSegments] = useState<
    Record<string, boolean>
  >({});

  // Scroll to bottom, marking it as programmatic so scroll handler ignores it
  const scrollToBottom = useCallback((container: HTMLElement) => {
    isProgrammaticScrollRef.current = true;
    container.scrollTop = container.scrollHeight - container.clientHeight;
    lastHeightRef.current = container.scrollHeight;

    // Clear programmatic flag after scroll events have fired
    requestAnimationFrame(() => {
      isProgrammaticScrollRef.current = false;
    });

    // Schedule a follow-up scroll to catch any async rendering (markdown, syntax highlighting)
    if (followUpScrollRef.current !== null) {
      clearTimeout(followUpScrollRef.current);
    }
    followUpScrollRef.current = setTimeout(() => {
      followUpScrollRef.current = null;
      if (shouldAutoScrollRef.current) {
        isProgrammaticScrollRef.current = true;
        container.scrollTop = container.scrollHeight - container.clientHeight;
        lastHeightRef.current = container.scrollHeight;
        requestAnimationFrame(() => {
          isProgrammaticScrollRef.current = false;
        });
      }
    }, 50);
  }, []);

  // Preprocess messages into render items and group into turns
  const renderItems = useMemo(
    () =>
      preprocessMessages(messages, {
        markdown: markdownAugments,
        activeToolApproval,
      }),
    [messages, markdownAugments, activeToolApproval],
  );
  const turnGroups = useMemo(
    () => groupItemsIntoTurns(renderItems),
    [renderItems],
  );
  const lastAssistantGroupIndex = useMemo(() => {
    for (let i = turnGroups.length - 1; i >= 0; i -= 1) {
      if (!turnGroups[i]?.isUserPrompt) {
        return i;
      }
    }
    return -1;
  }, [turnGroups]);

  const toggleThinkingExpanded = useCallback(() => {
    setThinkingExpanded((prev) => !prev);
  }, []);

  const toggleOperationSegment = useCallback((segmentId: string) => {
    setExpandedOperationSegments((prev) => ({
      ...prev,
      [segmentId]: !prev[segmentId],
    }));
  }, []);

  const toggleReasoningSegment = useCallback((segmentId: string) => {
    setExpandedReasoningSegments((prev) => ({
      ...prev,
      [segmentId]: !prev[segmentId],
    }));
  }, []);

  const renderItemsSegment = useCallback(
    (items: RenderItem[], context: SegmentRenderContext) =>
      items.map((item) => (
        <RenderItemComponent
          key={item.id}
          item={item}
          isStreaming={context.isStreaming}
          thinkingExpanded={context.thinkingExpanded}
          toggleThinkingExpanded={context.toggleThinkingExpanded}
          sessionProvider={context.provider}
        />
      )),
    [],
  );

  const renderOperationSegment = useCallback(
    (
      segment: OperationSegment,
      context: SegmentRenderContext,
      expanded: boolean,
      onToggle: (segmentId: string) => void,
    ) => {
      const summary = getOperationSegmentSummary(segment.items);

      return (
        <div
          key={segment.id}
          className={`operation-segment ${expanded ? "expanded" : "collapsed"}`}
        >
          <button
            type="button"
            className="operation-segment-toggle timeline-item"
            onClick={() => onToggle(segment.id)}
            aria-expanded={expanded}
          >
            <span className="operation-segment-label">{summary}</span>
            <span className="operation-segment-chevron" aria-hidden="true">
              {expanded ? "▾" : "▸"}
            </span>
          </button>
          {expanded && (
            <div className="operation-segment-content">
              {renderItemsSegment(segment.items, context)}
            </div>
          )}
        </div>
      );
    },
    [renderItemsSegment],
  );

  // Load older messages with scroll position preservation
  const handleLoadOlder = useCallback(() => {
    if (!onLoadOlderMessages) return;
    const container = containerRef.current?.parentElement;
    if (!container) {
      onLoadOlderMessages();
      return;
    }
    // Capture scroll state before prepending older messages
    const scrollHeightBefore = container.scrollHeight;
    const scrollTopBefore = container.scrollTop;
    onLoadOlderMessages();
    // Restore scroll position after React re-renders with prepended messages
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const scrollHeightAfter = container.scrollHeight;
        const heightDelta = scrollHeightAfter - scrollHeightBefore;
        isProgrammaticScrollRef.current = true;
        container.scrollTop = scrollTopBefore + heightDelta;
        lastHeightRef.current = container.scrollHeight;
        requestAnimationFrame(() => {
          isProgrammaticScrollRef.current = false;
        });
      });
    });
  }, [onLoadOlderMessages]);

  // Track scroll position to determine if user is near bottom.
  // Ignore programmatic scrolls - only user-initiated scrolls should affect auto-scroll state.
  const handleScroll = useCallback(() => {
    if (isProgrammaticScrollRef.current) return;

    const container = containerRef.current?.parentElement;
    if (!container) return;

    const threshold = 100; // pixels from bottom
    const distanceFromBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight;
    shouldAutoScrollRef.current = distanceFromBottom < threshold;
  }, []);

  // Attach scroll listener to parent container
  useEffect(() => {
    const container = containerRef.current?.parentElement;
    if (!container) return;

    container.addEventListener("scroll", handleScroll);

    return () => {
      container.removeEventListener("scroll", handleScroll);
    };
  }, [handleScroll]);

  // Use ResizeObserver to detect content height changes (handles async markdown rendering)
  useEffect(() => {
    const container = containerRef.current?.parentElement;
    if (!container) return;

    const scrollContainer = container;
    lastHeightRef.current = scrollContainer.scrollHeight;

    const resizeObserver = new ResizeObserver(() => {
      const newHeight = scrollContainer.scrollHeight;
      const heightIncreased = newHeight > lastHeightRef.current;

      // Auto-scroll when content height increases and auto-scroll is enabled
      if (heightIncreased && shouldAutoScrollRef.current) {
        scrollToBottom(scrollContainer);
      } else {
        // Update height tracking even when not scrolling
        lastHeightRef.current = newHeight;
      }
    });

    // Observe the inner container (message-list) since that's what changes size
    if (containerRef.current) {
      resizeObserver.observe(containerRef.current);
    }

    return () => {
      resizeObserver.disconnect();
      // Clean up any pending scroll on unmount
      if (followUpScrollRef.current !== null) {
        clearTimeout(followUpScrollRef.current);
      }
    };
  }, [scrollToBottom]);

  // Force scroll to bottom when scrollTrigger changes (user sent a message)
  useEffect(() => {
    if (scrollTrigger > 0) {
      shouldAutoScrollRef.current = true;
      const container = containerRef.current?.parentElement;
      if (container) {
        scrollToBottom(container);
      }
    }
  }, [scrollTrigger, scrollToBottom]);

  // Initial scroll to bottom on first render
  useEffect(() => {
    if (isInitialLoadRef.current && renderItems.length > 0) {
      const container = containerRef.current?.parentElement;
      if (container) {
        scrollToBottom(container);
      }
      isInitialLoadRef.current = false;
    }
  }, [renderItems.length, scrollToBottom]);

  return (
    <div className="message-list" ref={containerRef}>
      {hasOlderMessages && (
        <div className="load-older-messages">
          <button
            type="button"
            className="load-older-button"
            onClick={handleLoadOlder}
            disabled={loadingOlder}
          >
            {loadingOlder ? (
              <>
                <span className="spinning">&#x21BB;</span> Loading...
              </>
            ) : (
              "Load older messages"
            )}
          </button>
        </div>
      )}
      {turnGroups.map((group, groupIndex) => {
        if (group.isUserPrompt) {
          // User prompts render directly without timeline wrapper
          const item = group.items[0];
          if (!item) return null;
          return (
            <RenderItemComponent
              key={item.id}
              item={item}
              isStreaming={isStreaming}
              thinkingExpanded={thinkingExpanded}
              toggleThinkingExpanded={toggleThinkingExpanded}
              sessionProvider={provider}
            />
          );
        }
        // Assistant items wrapped in timeline container - key based on first item
        const firstItem = group.items[0];
        if (!firstItem) return null;
        const isCurrentStreamingTurn =
          isStreaming && groupIndex === lastAssistantGroupIndex;
        const segments = buildAssistantTurnRenderSegments(
          group.items,
          isCurrentStreamingTurn,
        );
        return (
          <div key={`turn-${firstItem.id}`} className="assistant-turn">
            {segments.map((segment) => {
              const renderContext: SegmentRenderContext = {
                isStreaming,
                provider,
                thinkingExpanded,
                toggleThinkingExpanded,
              };

              if (segment.kind === "folded_reasoning") {
                const expanded = expandedReasoningSegments[segment.id] ?? false;

                return (
                  <div
                    key={segment.id}
                    className={`reasoning-segment ${expanded ? "expanded" : "collapsed"}`}
                  >
                    <button
                      type="button"
                      className="reasoning-segment-toggle timeline-item"
                      onClick={() => toggleReasoningSegment(segment.id)}
                      aria-expanded={expanded}
                    >
                      <span className="reasoning-segment-label">
                        {segment.summary}
                      </span>
                      <span
                        className="reasoning-segment-chevron"
                        aria-hidden="true"
                      >
                        {expanded ? "▾" : "▸"}
                      </span>
                    </button>
                    {expanded && (
                      <div className="reasoning-segment-content">
                        {groupAssistantTurnSegments(segment.collapsedItems).map(
                          (collapsedSegment) => {
                            if (collapsedSegment.kind === "items") {
                              return renderItemsSegment(
                                collapsedSegment.items,
                                renderContext,
                              );
                            }

                            const operationExpanded =
                              expandedOperationSegments[collapsedSegment.id] ??
                              false;
                            return renderOperationSegment(
                              collapsedSegment,
                              renderContext,
                              operationExpanded,
                              toggleOperationSegment,
                            );
                          },
                        )}
                      </div>
                    )}
                    {renderItemsSegment(segment.visibleItems, renderContext)}
                  </div>
                );
              }

              if (segment.kind === "items") {
                return renderItemsSegment(segment.items, renderContext);
              }

              const expanded = expandedOperationSegments[segment.id] ?? false;
              return renderOperationSegment(
                segment,
                renderContext,
                expanded,
                toggleOperationSegment,
              );
            })}
            {(!isStreaming || groupIndex !== lastAssistantGroupIndex) && (
              <TurnDiffSummary items={group.items} />
            )}
          </div>
        );
      })}
      {/* Pending messages - shown as "Uploading..." or "Sending..." until server confirms */}
      {pendingMessages.map((pending) => (
        <div key={pending.tempId} className="pending-message">
          <div className="message-user-prompt pending-message-bubble">
            {pending.content}
          </div>
          <div className="pending-message-status">
            {pending.status || "Sending..."}
          </div>
        </div>
      ))}
      {/* Deferred messages - queued server-side, waiting for agent turn to end */}
      {deferredMessages.map((deferred, index) => (
        <div
          key={deferred.tempId ?? `deferred-${index}`}
          className="deferred-message"
        >
          <div className="message-user-prompt deferred-message-bubble">
            {deferred.content}
          </div>
          <div className="deferred-message-footer">
            <span className="deferred-message-status">
              {index === 0 ? "Queued (next)" : `Queued (#${index + 1})`}
            </span>
            {deferred.tempId && onCancelDeferred && (
              <button
                type="button"
                className="deferred-message-cancel"
                onClick={() => onCancelDeferred(deferred.tempId as string)}
                aria-label="Cancel queued message"
              >
                ×
              </button>
            )}
          </div>
        </div>
      ))}
      {/* Compacting indicator - shown when context is being compressed */}
      {isCompacting && (
        <div className="system-message system-message-compacting">
          <span className="system-message-icon spinning">⟳</span>
          <span className="system-message-text">Compacting context...</span>
        </div>
      )}
      <ProcessingIndicator isProcessing={isProcessing} />
    </div>
  );
});
