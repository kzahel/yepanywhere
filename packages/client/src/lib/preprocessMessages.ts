import type { ContentBlock, Message } from "../types";
import type {
  RenderItem,
  ToolCallItem,
  ToolResultData,
} from "../types/renderItems";

/**
 * Preprocess messages into render items, pairing tool_use with tool_result.
 *
 * This is a pure function - given the same messages, returns the same items.
 * Safe to call on every render (use useMemo).
 */
export function preprocessMessages(messages: Message[]): RenderItem[] {
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
    processMessage(msg, items, pendingToolCalls, orphanedToolIds);
  }

  return items;
}

function processMessage(
  msg: Message,
  items: RenderItem[],
  pendingToolCalls: Map<string, number>,
  orphanedToolIds: Set<string>,
): void {
  // Get content from nested message object (SDK structure) or top-level
  const content =
    msg.content ??
    (msg.message as { content?: string | ContentBlock[] } | undefined)?.content;

  // Get role from nested message or top-level
  const role =
    msg.role ??
    (msg.message as { role?: "user" | "assistant" } | undefined)?.role;

  // String content = user prompt (only if role is user or type is user)
  if (typeof content === "string") {
    if (role === "user" || msg.type === "user") {
      items.push({
        type: "user_prompt",
        id: msg.id,
        content,
        sourceMessages: [msg],
      });
      return;
    }
    // Assistant message with string content - convert to text block
    if (content.trim()) {
      items.push({
        type: "text",
        id: msg.id,
        text: content,
        sourceMessages: [msg],
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
    role === "user" && content.every((b) => b.type === "tool_result");

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
  if (role === "user") {
    items.push({
      type: "user_prompt",
      id: msg.id,
      content,
      sourceMessages: [msg],
    });
    return;
  }

  // Assistant message - process each block
  for (let i = 0; i < content.length; i++) {
    const block = content[i];
    if (!block) continue;

    const blockId = `${msg.id}-${i}`;

    if (block.type === "text") {
      if (block.text?.trim()) {
        items.push({
          type: "text",
          id: blockId,
          text: block.text,
          sourceMessages: [msg],
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
  const resultData: ToolResultData = {
    content: block.content || "",
    isError: block.is_error || false,
    structured: resultMessage.toolUseResult,
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
  };

  items[index] = updatedItem;
  pendingToolCalls.delete(toolUseId);
}
