import { claudeInputMessageIds } from "../sdk/providers/claude-delivery.js";
import {
  getMessageContent,
  isConversationEntry,
  type ClaudeSessionEntry,
} from "@yep-anywhere/shared";
import type { ContentBlock, Message } from "../supervisor/types.js";

function normalizeClaudeQueueOperationContent(content: unknown): string {
  if (content === undefined) {
    return "";
  }

  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .map((item) => {
      if (typeof item === "string") {
        return item;
      }

      if (!item || typeof item !== "object") {
        return "";
      }

      const type = (item as { type?: unknown }).type;
      if (type === "text") {
        const text = (item as { text?: unknown }).text;
        return typeof text === "string" ? text : "";
      }
      if (type === "image") return "[Image]";
      if (type === "document") return "[Document]";
      if (type === "tool_result") return "[Tool Result]";

      return "";
    })
    .join("\n");
}

export function convertClaudeMessage(
  raw: ClaudeSessionEntry,
  _index: number,
  orphanedToolUses: Set<string>,
): Message {
  if (raw.type === "queue-operation" && raw.operation === "enqueue") {
    const content = normalizeClaudeQueueOperationContent(raw.content).trim();
    const rawAny = raw as Record<string, unknown>;

    return {
      ...rawAny,
      id: `queue-operation-${_index}-${raw.timestamp}`,
      type: "user",
      role: "user",
      content,
      message: {
        role: "user",
        content,
      },
      deferred: true,
      deferredSource: "queue-operation",
    };
  }

  // Normalize content blocks - pass through all fields
  let content: string | ContentBlock[] | undefined;
  const rawContent = getMessageContent(raw);
  if (typeof rawContent === "string") {
    content = rawContent;
  } else if (Array.isArray(rawContent)) {
    // Pass through all fields from each content block
    // Filter out string items (which can appear in user message content)
    content = rawContent
      .filter((block) => typeof block !== "string")
      .map((block) => ({ ...(block as object) })) as ContentBlock[];
  }

  // Build message by spreading all raw fields, then override with normalized values
  // Use type assertion since we're converting to a looser Message type
  const rawAny = raw as Record<string, unknown>;
  const message: Message = {
    ...rawAny,
    inputMessageIds: claudeInputMessageIds(raw),
    // Include normalized content if message had content
    ...(isConversationEntry(raw) && {
      message: {
        ...(raw.message as Record<string, unknown>),
        ...(content !== undefined && { content }),
      },
    }),
    // Ensure type is set
    type: raw.type,
  };

  // Identify orphaned tool_use IDs in this message's content
  if (Array.isArray(content)) {
    const orphanedIds = content
      .filter(
        (b): b is ContentBlock & { id: string } =>
          b.type === "tool_use" &&
          typeof b.id === "string" &&
          orphanedToolUses.has(b.id),
      )
      .map((b) => b.id);

    if (orphanedIds.length > 0) {
      message.orphanedToolUseIds = orphanedIds;
    }
  }

  return message;
}
