import { orderByParentChain } from "@yep-anywhere/shared";
import type { Message } from "../types";

import { getMessageId } from "@yep-anywhere/shared/transcript/message";

export function findMessageIndexById(
  messages: readonly Message[],
  messageId: string,
): number {
  const lastIndex = messages.length - 1;
  const lastMessage = messages[lastIndex];
  if (lastMessage && getMessageId(lastMessage) === messageId) {
    return lastIndex;
  }

  for (let index = lastIndex - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message && getMessageId(message) === messageId) {
      return index;
    }
  }

  return -1;
}

/**
 * Helper to get content from a message, handling both top-level and SDK nested structure.
 * SDK messages have content nested in message.content.
 */
export function getMessageContent(m: Message): unknown {
  return m.content ?? (m.message as { content?: unknown } | undefined)?.content;
}

function getMessageRole(m: Message): string | undefined {
  const nestedRole = (m.message as { role?: unknown } | undefined)?.role;
  if (
    nestedRole === "user" ||
    nestedRole === "assistant" ||
    nestedRole === "system"
  ) {
    return nestedRole;
  }
  if (m.role === "user" || m.role === "assistant" || m.role === "system") {
    return m.role;
  }
  return undefined;
}

function getConversationSiblingKey(m: Message): string | null {
  if (m.parentUuid == null) {
    return null;
  }

  const type = m.type;
  if (type !== "user" && type !== "assistant") {
    return null;
  }

  return `${m.parentUuid}:${type}:${getMessageRole(m) ?? ""}`;
}

function hasAuthoritativeSibling(
  existing: Message[],
  incoming: Message,
): boolean {
  const incomingKey = getConversationSiblingKey(incoming);
  if (!incomingKey) {
    return false;
  }

  const incomingId = getMessageId(incoming);
  return existing.some((message) => {
    if ((message._source ?? "sdk") !== "jsonl") {
      return false;
    }
    if (getMessageId(message) === incomingId) {
      return false;
    }
    return getConversationSiblingKey(message) === incomingKey;
  });
}

function pruneSupersededSdkSiblings(
  messages: Message[],
  authoritativeMessages: Message[],
): Message[] {
  const authoritativeSiblingKeys = new Set<string>();

  for (const message of authoritativeMessages) {
    const key = getConversationSiblingKey(message);
    if (key) {
      authoritativeSiblingKeys.add(key);
    }
  }

  if (authoritativeSiblingKeys.size === 0) {
    return messages;
  }

  const filtered = messages.filter((message) => {
    if ((message._source ?? "sdk") === "jsonl") {
      return true;
    }

    const key = getConversationSiblingKey(message);
    if (!key) {
      return true;
    }

    return !authoritativeSiblingKeys.has(key);
  });

  return filtered.length === messages.length ? messages : filtered;
}

/**
 * Merge messages from different sources.
 * JSONL (from disk) is authoritative; SDK (streaming) provides real-time updates.
 *
 * Strategy:
 * - If message only exists from one source, use it
 * - If both exist, use JSONL as base but preserve any SDK-only fields
 * - Warn if SDK has fields that JSONL doesn't (validates our assumption)
 */
export function mergeMessage(
  existing: Message | undefined,
  incoming: Message,
  incomingSource: "sdk" | "jsonl",
): Message {
  if (!existing) {
    return { ...incoming, _source: incomingSource };
  }

  const existingSource = existing._source ?? "sdk";

  // If incoming is JSONL, it's authoritative - use it as base
  if (incomingSource === "jsonl") {
    // SDK messages have extra streaming metadata not persisted to JSONL:
    // - session_id: routing/tracking for the streaming session
    // - parent_tool_use_id: tracks which tool spawned a sub-agent message
    // - eventType: stream envelope type (message, status, etc.)
    // This is expected - JSONL stores conversation content, SDK includes transient fields.
    // The merge preserves SDK-only fields while using JSONL as authoritative base.
    return {
      ...existing,
      ...incoming,
      _source: "jsonl",
    };
  }

  // If incoming is SDK and existing is JSONL, keep JSONL (it's authoritative)
  if (existingSource === "jsonl") {
    return existing;
  }

  // Both are SDK - use the newer one (incoming)
  return { ...incoming, _source: "sdk" };
}

export interface MergeJSONLResult {
  messages: Message[];
}

/**
 * Merge incoming JSONL messages with existing messages.
 *
 * Handles:
 * - Deduplication by message ID (uuid)
 * - Position preservation
 * - Adding new messages at end
 *
 * Note: Temp message deduplication is no longer needed since pending messages
 * are tracked separately via tempId echoed from stream.
 */
export function mergeJSONLMessages(
  existing: Message[],
  incoming: Message[],
  options?: { skipDagOrdering?: boolean },
): MergeJSONLResult {
  // Create a map of existing messages for efficient lookup
  // Use getMessageId for canonical identifier (uuid preferred over id)
  const messageMap = new Map(existing.map((m) => [getMessageId(m), m]));

  // Merge each incoming JSONL message
  for (const incomingMsg of incoming) {
    const incomingId = getMessageId(incomingMsg);
    const existingMsg = messageMap.get(incomingId);
    messageMap.set(incomingId, mergeMessage(existingMsg, incomingMsg, "jsonl"));
  }

  // Build result array, preserving order
  const result: Message[] = [];
  const seen = new Set<string>();

  // First add existing messages (in order)
  for (const msg of existing) {
    const msgId = getMessageId(msg);
    if (!seen.has(msgId)) {
      result.push(messageMap.get(msgId) ?? msg);
      seen.add(msgId);
    }
  }

  // Then add any truly new messages
  for (const incomingMsg of incoming) {
    const incomingId = getMessageId(incomingMsg);
    if (!seen.has(incomingId)) {
      result.push(messageMap.get(incomingId) ?? incomingMsg);
      seen.add(incomingId);
    }
  }

  const reconciled = pruneSupersededSdkSiblings(result, incoming);

  // Reorder messages by parentUuid chain to fix race conditions
  // where stream messages arrived before their parent (e.g., agent response before user message)
  if (options?.skipDagOrdering) {
    return { messages: reconciled };
  }
  return { messages: orderByParentChain(reconciled) };
}

export interface MergeStreamResult {
  messages: Message[];
  /** Index where the message was inserted/updated */
  index: number;
}

/**
 * Merge an incoming stream message with existing messages.
 *
 * Handles:
 * - Merging with existing message if same ID
 * - Adding new messages at end
 *
 * Note: Temp message replacement is no longer needed since pending messages
 * are tracked separately via tempId echoed from stream.
 */
export function mergeStreamMessage(
  existing: Message[],
  incoming: Message,
): MergeStreamResult {
  if (
    incoming.isReplay === true &&
    hasAuthoritativeSibling(existing, incoming)
  ) {
    return {
      messages: existing,
      index: -1,
    };
  }

  const incomingId = getMessageId(incoming);
  // Check for existing message with same ID
  const existingIdx = findMessageIndexById(existing, incomingId);

  if (existingIdx >= 0) {
    // Merge with existing message
    const existingMsg = existing[existingIdx];
    const merged = mergeMessage(existingMsg, incoming, "sdk");

    // Only update if actually different
    if (
      existingMsg === merged ||
      JSON.stringify(existingMsg) === JSON.stringify(merged)
    ) {
      return {
        messages: existing,
        index: existingIdx,
      };
    }

    const updated = [...existing];
    updated[existingIdx] = merged;
    return {
      messages: updated,
      index: existingIdx,
    };
  }

  // Add new message
  return {
    messages: [...existing, { ...incoming, _source: "sdk" }],
    index: existing.length,
  };
}
