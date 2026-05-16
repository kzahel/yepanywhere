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

/**
 * Groups consecutive assistant items (text, thinking, tool_call) into turns.
 * User prompts break the grouping and are returned as separate groups.
 */
function groupItemsIntoTurns(
  items: RenderItem[],
): TurnGroup[] {
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

  const toggleThinkingExpanded = useCallback(() => {
    setThinkingExpanded((prev) => !prev);
  }, []);

  const toggleOperationSegment = useCallback((segmentId: string) => {
    setExpandedOperationSegments((prev) => ({
      ...prev,
      [segmentId]: !prev[segmentId],
    }));
  }, []);

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
      {turnGroups.map((group) => {
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
        const segments = groupAssistantTurnSegments(group.items);
        return (
          <div key={`turn-${firstItem.id}`} className="assistant-turn">
            {segments.map((segment) => {
              if (segment.kind === "items") {
                return segment.items.map((item) => (
                  <RenderItemComponent
                    key={item.id}
                    item={item}
                    isStreaming={isStreaming}
                    thinkingExpanded={thinkingExpanded}
                    toggleThinkingExpanded={toggleThinkingExpanded}
                    sessionProvider={provider}
                  />
                ));
              }

              const expanded = expandedOperationSegments[segment.id] ?? false;
              const summary = getOperationSegmentSummary(segment.items);

              return (
                <div
                  key={segment.id}
                  className={`operation-segment ${expanded ? "expanded" : "collapsed"}`}
                >
                  <button
                    type="button"
                    className="operation-segment-toggle timeline-item"
                    onClick={() => toggleOperationSegment(segment.id)}
                    aria-expanded={expanded}
                  >
                    <span className="operation-segment-label">{summary}</span>
                    <span className="operation-segment-chevron" aria-hidden="true">
                      {expanded ? "▾" : "▸"}
                    </span>
                  </button>
                  {expanded && (
                    <div className="operation-segment-content">
                      {segment.items.map((item) => (
                        <RenderItemComponent
                          key={item.id}
                          item={item}
                          isStreaming={isStreaming}
                          thinkingExpanded={thinkingExpanded}
                          toggleThinkingExpanded={toggleThinkingExpanded}
                          sessionProvider={provider}
                        />
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
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
