import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Message } from "../types";
import {
  ContentBlockRenderer,
  type RenderContext,
  type ContentBlock as RendererContentBlock,
} from "./renderers";

interface Props {
  messages: Message[];
  isStreaming?: boolean;
}

/**
 * Build a lookup map for tool_use blocks by ID to correlate with tool_results
 */
function buildToolUseLookup(messages: Message[]) {
  const lookup = new Map<string, { name: string; input: unknown }>();
  for (const msg of messages) {
    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === "tool_use" && block.id && block.name) {
          lookup.set(block.id, { name: block.name, input: block.input });
        }
      }
    }
  }
  return lookup;
}

// Memoize individual message to prevent re-renders
const MessageItem = memo(function MessageItem({
  msg,
  context,
}: {
  msg: Message;
  context: RenderContext;
}) {
  const content = msg.content;

  // User prompts are user messages without tool_result blocks (actual typed input)
  // Tool results and assistant messages are "responses"
  const hasToolResults =
    Array.isArray(content) &&
    content.some((block) => block.type === "tool_result");
  const isUserPrompt = msg.role === "user" && !hasToolResults;
  const messageClass = isUserPrompt
    ? "message-user-prompt"
    : "message-response";

  return (
    <div className={`message ${messageClass}`}>
      <div className="message-content">
        {typeof content === "string" ? (
          <div className="text-block">{content}</div>
        ) : Array.isArray(content) ? (
          content.map((block, i) => (
            <ContentBlockRenderer
              key={`${msg.id}-block-${i}`}
              block={block as unknown as RendererContentBlock}
              context={{
                ...context,
                toolUseResult: msg.toolUseResult,
              }}
            />
          ))
        ) : (
          <pre className="fallback-content">
            <code>{JSON.stringify(content, null, 2)}</code>
          </pre>
        )}
      </div>
    </div>
  );
});

export const MessageList = memo(function MessageList({
  messages,
  isStreaming = false,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const shouldAutoScrollRef = useRef(true);
  const [thinkingExpanded, setThinkingExpanded] = useState(false);

  // Build tool_use lookup for correlating tool_results
  const toolUseLookup = useMemo(() => buildToolUseLookup(messages), [messages]);

  const toggleThinkingExpanded = useCallback(() => {
    setThinkingExpanded((prev) => !prev);
  }, []);

  const context: RenderContext = useMemo(
    () => ({
      isStreaming,
      theme: "dark",
      getToolUse: (id: string) => toolUseLookup.get(id),
      thinkingExpanded,
      toggleThinkingExpanded,
    }),
    [isStreaming, toolUseLookup, thinkingExpanded, toggleThinkingExpanded],
  );

  // Track scroll position to determine if user is near bottom
  const handleScroll = useCallback(() => {
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
    return () => container.removeEventListener("scroll", handleScroll);
  }, [handleScroll]);

  // Only auto-scroll if user is near the bottom
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll on message changes is intentional
  useEffect(() => {
    if (shouldAutoScrollRef.current) {
      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages]);

  return (
    <div className="message-list" ref={containerRef}>
      {messages.map((msg) => (
        <MessageItem key={msg.id} msg={msg} context={context} />
      ))}
      <div ref={bottomRef} />
    </div>
  );
});
