import type { MarkdownAugment } from "@yep-anywhere/shared";
import type { ContentBlock, Message } from "../types";
import type {
  RenderItem,
  SystemItem,
  ToolCallItem,
  ToolResultData,
} from "../types/renderItems";
import { getMessageId } from "./mergeMessages";

/**
 * Augments to embed into RenderItems during preprocessing.
 * These are pre-computed on the server for completed messages.
 */
export interface PreprocessAugments {
  /** Pre-rendered markdown HTML keyed by message ID */
  markdown?: Record<string, MarkdownAugment>;
}

/**
 * Preprocess messages into render items, pairing tool_use with tool_result.
 *
 * This is a pure function - given the same messages, returns the same items.
 * Safe to call on every render (use useMemo).
 */
export function preprocessMessages(
  messages: Message[],
  augments?: PreprocessAugments,
): RenderItem[] {
  const items: RenderItem[] = [];
  const pendingToolCalls = new Map<string, number>(); // tool_use_id → index in items

  // Collect all orphaned tool IDs from messages (set by server DAG filtering)
  const orphanedToolIds = new Set<string>();
  for (const msg of messages) {
    if (msg.orphanedToolUseIds) {
      for (const id of msg.orphanedToolUseIds) {
        orphanedToolIds.add(id);
      }
    }
  }

  for (const msg of messages) {
    processMessage(msg, items, pendingToolCalls, orphanedToolIds, augments);
  }

  return items;
}

function processMessage(
  msg: Message,
  items: RenderItem[],
  pendingToolCalls: Map<string, number>,
  orphanedToolIds: Set<string>,
  augments?: PreprocessAugments,
): void {
  const msgId = getMessageId(msg);

  // Handle system entries (compact_boundary, etc.)
  if (msg.type === "system") {
    const subtype = (msg as { subtype?: string }).subtype ?? "unknown";
    // Only render compact_boundary as a visible system message
    if (subtype === "compact_boundary") {
      const systemItem: SystemItem = {
        type: "system",
        id: msgId,
        subtype,
        content:
          typeof msg.content === "string" ? msg.content : "Context compacted",
        sourceMessages: [msg],
      };
      items.push(systemItem);
    }
    // Skip other system entries (init, etc.) - they're internal
    return;
  }

  // Debug logging for streaming transition issues
  if (
    typeof window !== "undefined" &&
    window.__STREAMING_DEBUG__ &&
    msg.type === "assistant"
  ) {
    console.log("[preprocessMessages] Processing assistant message:", {
      msgId,
      uuid: msg.uuid,
      id: msg.id,
      _isStreaming: msg._isStreaming,
    });
  }

  // Get content from nested message object (SDK structure) first, fall back to top-level
  // Phase 4c: prefer message.content over top-level content
  const content =
    (msg.message as { content?: string | ContentBlock[] } | undefined)
      ?.content ?? msg.content;

  // Use type for discrimination (SDK field), fall back to role for legacy data
  // Phase 4c: prefer type over role, but maintain backward compatibility
  const role =
    (msg.message as { role?: "user" | "assistant" } | undefined)?.role ??
    msg.role;
  const isUserMessage = msg.type === "user" || role === "user";

  // String content = user prompt (only if type is user)
  if (typeof content === "string") {
    if (isUserMessage) {
      items.push({
        type: "user_prompt",
        id: msgId,
        content,
        sourceMessages: [msg],
        isSubagent: msg.isSubagent,
      });
      return;
    }
    // Assistant message with string content - convert to text block
    if (content.trim()) {
      const messageHtml = (msg as { _html?: string })._html;
      items.push({
        type: "text",
        id: msgId,
        text: content,
        sourceMessages: [msg],
        isSubagent: msg.isSubagent,
        augmentHtml: messageHtml ?? augments?.markdown?.[msgId]?.html,
      });
    }
    return;
  }

  // Not an array - shouldn't happen but handle gracefully
  if (!Array.isArray(content)) {
    return;
  }

  // Check if this is a user message with only tool_result blocks
  const isToolResultMessage =
    isUserMessage && content.every((b) => b.type === "tool_result");

  if (isToolResultMessage) {
    // Attach results to pending tool calls
    for (const block of content) {
      if (block.type === "tool_result" && block.tool_use_id) {
        attachToolResult(block, msg, items, pendingToolCalls);
      }
    }
    return;
  }

  // Check if this is a real user prompt (not tool results)
  if (isUserMessage) {
    items.push({
      type: "user_prompt",
      id: msgId,
      content,
      sourceMessages: [msg],
      isSubagent: msg.isSubagent,
    });
    return;
  }

  // Assistant message - process each block
  // First pass: find the last text block index (for streaming cursor placement)
  let lastTextBlockIndex = -1;
  if (msg._isStreaming) {
    for (let i = content.length - 1; i >= 0; i--) {
      const block = content[i];
      if (block?.type === "text" && block.text?.trim()) {
        lastTextBlockIndex = i;
        break;
      }
    }
  }

  for (let i = 0; i < content.length; i++) {
    const block = content[i];
    if (!block) continue;

    const blockId = `${msgId}-${i}`;

    if (block.type === "text") {
      if (block.text?.trim()) {
        // Get _html from server-injected augment, fall back to markdownAugments (for SSE path)
        const blockHtml = (block as { _html?: string })._html;
        items.push({
          type: "text",
          id: blockId,
          text: block.text,
          sourceMessages: [msg],
          isSubagent: msg.isSubagent,
          // Only show streaming cursor on the last text block
          isStreaming: msg._isStreaming && i === lastTextBlockIndex,
          // Prefer inline _html from server, fall back to markdownAugments (SSE path)
          augmentHtml: blockHtml ?? augments?.markdown?.[msgId]?.html,
        });
      }
    } else if (block.type === "thinking") {
      if (block.thinking?.trim()) {
        items.push({
          type: "thinking",
          id: blockId,
          thinking: block.thinking,
          signature: undefined,
          status: "complete",
          sourceMessages: [msg],
          isSubagent: msg.isSubagent,
        });
      }
    } else if (block.type === "tool_use") {
      if (block.id && block.name) {
        // Check if this tool call is orphaned (process killed before result)
        const isOrphaned = orphanedToolIds.has(block.id);
        const toolCall: ToolCallItem = {
          type: "tool_call",
          id: block.id,
          toolName: block.name,
          toolInput: block.input,
          toolResult: undefined,
          status: isOrphaned ? "aborted" : "pending",
          sourceMessages: [msg],
          isSubagent: msg.isSubagent,
        };
        pendingToolCalls.set(block.id, items.length);
        items.push(toolCall);
      }
    }
  }
}

function attachToolResult(
  block: ContentBlock,
  resultMessage: Message,
  items: RenderItem[],
  pendingToolCalls: Map<string, number>,
): void {
  const toolUseId = block.tool_use_id;
  if (!toolUseId) return;

  const index = pendingToolCalls.get(toolUseId);
  if (index === undefined) {
    // Orphan result - shouldn't happen normally
    console.warn(`Tool result for unknown tool_use: ${toolUseId}`);
    return;
  }

  const item = items[index];
  if (!item || item.type !== "tool_call") return;

  // Attach result to existing tool call
  // Handle both camelCase (toolUseResult) and snake_case (tool_use_result) from SDK
  const structured =
    resultMessage.toolUseResult ??
    (resultMessage as Record<string, unknown>).tool_use_result;
  const resultData: ToolResultData = {
    content: block.content || "",
    isError: block.is_error || false,
    structured,
  };

  // Create a new ToolCallItem to ensure React sees the change
  const updatedItem: ToolCallItem = {
    type: "tool_call",
    id: item.id,
    toolName: item.toolName,
    toolInput: item.toolInput,
    toolResult: resultData,
    status: block.is_error ? "error" : "complete",
    sourceMessages: [...item.sourceMessages, resultMessage],
    isSubagent: item.isSubagent,
  };

  items[index] = updatedItem;
  pendingToolCalls.delete(toolUseId);
}
