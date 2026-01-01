import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { preprocessMessages } from "../lib/preprocessMessages";
import type { Message } from "../types";
import type { RenderItem } from "../types/renderItems";
import { ProcessingIndicator } from "./ProcessingIndicator";
import { RenderItemComponent } from "./RenderItemComponent";

/**
 * Groups consecutive assistant items (text, thinking, tool_call) into turns.
 * User prompts break the grouping and are returned as separate groups.
 */
function groupItemsIntoTurns(
  items: RenderItem[],
): Array<{ isUserPrompt: boolean; items: RenderItem[] }> {
  const groups: Array<{ isUserPrompt: boolean; items: RenderItem[] }> = [];
  let currentAssistantGroup: RenderItem[] = [];

  for (const item of items) {
    if (item.type === "user_prompt") {
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

interface Props {
  messages: Message[];
  isStreaming?: boolean;
  isProcessing?: boolean;
  /** Increment this to force scroll to bottom (e.g., when user sends a message) */
  scrollTrigger?: number;
}

export const MessageList = memo(function MessageList({
  messages,
  isStreaming = false,
  isProcessing = false,
  scrollTrigger = 0,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const shouldAutoScrollRef = useRef(true);
  const isInitialLoadRef = useRef(true);
  const isUserDraggingRef = useRef(false);
  const lastHeightRef = useRef(0);
  const [thinkingExpanded, setThinkingExpanded] = useState(false);

  // Preprocess messages into render items and group into turns
  const renderItems = useMemo(() => preprocessMessages(messages), [messages]);
  const turnGroups = useMemo(
    () => groupItemsIntoTurns(renderItems),
    [renderItems],
  );

  const toggleThinkingExpanded = useCallback(() => {
    setThinkingExpanded((prev) => !prev);
  }, []);

  // Track scroll position to determine if user is near bottom
  const handleScroll = useCallback(() => {
    const container = containerRef.current?.parentElement;
    if (!container) return;

    const threshold = 100; // pixels from bottom
    const distanceFromBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight;
    shouldAutoScrollRef.current = distanceFromBottom < threshold;
  }, []);

  // Track when user is actively dragging (mouse/touch held down)
  const handlePointerDown = useCallback(() => {
    isUserDraggingRef.current = true;
  }, []);

  const handlePointerUp = useCallback(() => {
    isUserDraggingRef.current = false;
    // Re-check scroll position and immediately scroll to bottom if user ended near bottom
    // This ensures auto-scroll resumes after user intentionally scrolls down
    const container = containerRef.current?.parentElement;
    if (container) {
      const threshold = 100;
      const distanceFromBottom =
        container.scrollHeight - container.scrollTop - container.clientHeight;
      if (distanceFromBottom < threshold) {
        shouldAutoScrollRef.current = true;
        container.scrollTop = container.scrollHeight - container.clientHeight;
      }
    }
  }, []);

  // Attach scroll and pointer listeners to parent container
  useEffect(() => {
    const container = containerRef.current?.parentElement;
    if (!container) return;

    container.addEventListener("scroll", handleScroll);
    container.addEventListener("pointerdown", handlePointerDown);
    // Use window for pointerup to catch releases outside the container
    window.addEventListener("pointerup", handlePointerUp);

    return () => {
      container.removeEventListener("scroll", handleScroll);
      container.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("pointerup", handlePointerUp);
    };
  }, [handleScroll, handlePointerDown, handlePointerUp]);

  // Use ResizeObserver to detect content height changes (handles async markdown rendering)
  useEffect(() => {
    const container = containerRef.current?.parentElement;
    if (!container) return;

    const scrollContainer = container;
    lastHeightRef.current = scrollContainer.scrollHeight;

    const resizeObserver = new ResizeObserver(() => {
      const newHeight = scrollContainer.scrollHeight;
      const heightIncreased = newHeight > lastHeightRef.current;
      lastHeightRef.current = newHeight;

      // Auto-scroll when content height increases (if near bottom and not dragging)
      if (
        heightIncreased &&
        shouldAutoScrollRef.current &&
        !isUserDraggingRef.current
      ) {
        // Use scrollTop for immediate, reliable scrolling (avoids smooth scroll race conditions)
        scrollContainer.scrollTop =
          scrollContainer.scrollHeight - scrollContainer.clientHeight;
      }
    });

    // Observe the inner container (message-list) since that's what changes size
    if (containerRef.current) {
      resizeObserver.observe(containerRef.current);
    }

    return () => {
      resizeObserver.disconnect();
    };
  }, []);

  // Force scroll to bottom when scrollTrigger changes (user sent a message)
  useEffect(() => {
    if (scrollTrigger > 0) {
      shouldAutoScrollRef.current = true;
      const container = containerRef.current?.parentElement;
      if (container) {
        container.scrollTop = container.scrollHeight - container.clientHeight;
      }
    }
  }, [scrollTrigger]);

  // Initial scroll to bottom on first render
  useEffect(() => {
    if (isInitialLoadRef.current && renderItems.length > 0) {
      const container = containerRef.current?.parentElement;
      if (container) {
        container.scrollTop = container.scrollHeight - container.clientHeight;
      }
      isInitialLoadRef.current = false;
    }
  }, [renderItems.length]);

  return (
    <div className="message-list" ref={containerRef}>
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
            />
          );
        }
        // Assistant items wrapped in timeline container - key based on first item
        const firstItem = group.items[0];
        if (!firstItem) return null;
        return (
          <div key={`turn-${firstItem.id}`} className="assistant-turn">
            {group.items.map((item) => (
              <RenderItemComponent
                key={item.id}
                item={item}
                isStreaming={isStreaming}
                thinkingExpanded={thinkingExpanded}
                toggleThinkingExpanded={toggleThinkingExpanded}
              />
            ))}
          </div>
        );
      })}
      <ProcessingIndicator isProcessing={isProcessing} />
    </div>
  );
});
