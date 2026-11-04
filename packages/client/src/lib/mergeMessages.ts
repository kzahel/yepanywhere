import { orderByParentChain } from "@yep-anywhere/shared";
import type { Message } from "../types";

import {
  getMessageId,
  getMessageIds,
  messageHasId,
} from "@yep-anywhere/shared/transcript/message";
import { parseTimestampMs } from "./messageAge";

export function findMessageIndexById(
  messages: readonly Message[],
  messageId: string,
): number {
  const lastIndex = messages.length - 1;
  const lastMessage = messages[lastIndex];
  if (lastMessage && messageHasId(lastMessage, messageId)) {
    return lastIndex;
  }

  for (let index = lastIndex - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message && messageHasId(message, messageId)) {
      return index;
    }
  }

  return -1;
}

/** Remove contributing echoes only when a native grouped row names their IDs. */
function reconcileInputMessageIds(messages: Message[]): Message[] {
  const owners = new Map<string, number>();
  for (const [index, message] of messages.entries()) {
    if (!message.inputMessageIds?.length) continue;
    const primary = getMessageId(message);
    for (const id of getMessageIds(message)) {
      if (id !== primary) owners.set(id, index);
    }
  }
  if (owners.size === 0) return messages;
  let result = messages;
  const removed = new Set<number>();
  for (const [index, message] of messages.entries()) {
    if (message.type !== "user") continue;
    const owner = owners.get(getMessageId(message));
    if (owner === undefined || owner === index) continue;
    if (result === messages) result = [...messages];
    const grouped = result[owner]!;
    // Preserve transient self-send evidence until the grouped row is persisted.
    result[owner] = {
      ...grouped,
      ...(grouped.tempId === undefined && message.tempId !== undefined
        ? { tempId: message.tempId }
        : {}),
      ...(grouped.messageMetadata === undefined &&
      message.messageMetadata !== undefined
        ? { messageMetadata: message.messageMetadata }
        : {}),
    };
    removed.add(index);
  }
  return removed.size
    ? result.filter((_, index) => !removed.has(index))
    : messages;
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
      _isStreaming: incoming._isStreaming,
      _source: "jsonl",
    };
  }

  // If incoming is SDK and existing is JSONL, keep JSONL (it's authoritative)
  if (existingSource === "jsonl") {
    return existing;
  }

  // Both are SDK - use the newer one (incoming). Keep the optimistic
  // self-send markers when the provider re-echo omits them: Grok's
  // adapter yields the queued user uuid without tempId, and losing those
  // fields makes reconcileSelfSendUserEchoes treat the row as a second
  // confirmed turn next to Grok's own jsonl id.
  const merged: Message = { ...incoming, _source: "sdk" };
  if (merged.tempId === undefined && existing.tempId !== undefined) {
    merged.tempId = existing.tempId;
  }
  if (
    merged.messageMetadata === undefined &&
    existing.messageMetadata !== undefined
  ) {
    merged.messageMetadata = existing.messageMetadata;
  }
  return merged;
}

export interface MergeJSONLResult {
  messages: Message[];
}

function orderLinearCatchup(
  existing: Message[],
  incoming: Message[],
): Message[] {
  if (incoming.length === 0) return existing;
  const incomingPositions = new Map(
    incoming.map((message, index) => [getMessageId(message), index]),
  );
  let lastSharedPosition = -1;
  let insertionIndex = existing.length;
  const incomingTimestamp = parseTimestampMs(incoming[0]?.timestamp);
  for (let index = 0; index < existing.length; index += 1) {
    const message = existing[index]!;
    lastSharedPosition = Math.max(
      lastSharedPosition,
      incomingPositions.get(getMessageId(message)) ?? -1,
    );
    const timestamp = parseTimestampMs(message.timestamp);
    if (
      insertionIndex === existing.length &&
      incomingTimestamp !== null &&
      timestamp !== null &&
      timestamp > incomingTimestamp
    )
      insertionIndex = index;
  }

  const ordered: Message[] = [];
  let nextIncoming = 0;
  for (let index = 0; index <= existing.length; index += 1) {
    // Without a shared ID, timestamps can place a batch but never merge rows.
    if (lastSharedPosition < 0 && index === insertionIndex) {
      ordered.push(...incoming);
      nextIncoming = incoming.length;
    }
    const message = existing[index];
    if (!message) break;
    const position = incomingPositions.get(getMessageId(message));
    if (position === undefined) {
      ordered.push(message);
      continue;
    }
    const end =
      position === lastSharedPosition ? incoming.length : position + 1;
    while (nextIncoming < end) ordered.push(incoming[nextIncoming++]!);
  }
  return ordered;
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
  options?: { skipDagOrdering?: boolean; preserveIncomingOrder?: boolean },
): MergeJSONLResult {
  // Create a map of existing messages for efficient lookup
  // Use getMessageId for canonical identifier (uuid preferred over id)
  const messageMap = new Map(existing.map((m) => [getMessageId(m), m]));

  // Merge each incoming JSONL message
  for (const incomingMsg of incoming) {
    const incomingId = getMessageId(incomingMsg);
    const existingMsg = messageMap.get(incomingId);
    messageMap.set(
      incomingId,
      mergeMessage(
        existingMsg,
        incomingMsg,
        incomingMsg._isStreaming ? "sdk" : "jsonl",
      ),
    );
  }

  // Build result array, preserving order
  const result: Message[] = [];
  const seen = new Set<string>();

  const ordered = options?.preserveIncomingOrder
    ? orderLinearCatchup(existing, incoming)
    : [...existing, ...incoming];
  for (const msg of ordered) {
    const msgId = getMessageId(msg);
    if (!seen.has(msgId)) {
      result.push(messageMap.get(msgId) ?? msg);
      seen.add(msgId);
    }
  }

  const reconciled = reconcileInputMessageIds(
    pruneSupersededSdkSiblings(result, incoming),
  );

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
function mergeStreamMessageSnapshot(
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
    // A delayed replay of one contributing input cannot replace its grouped row.
    if (
      existingMsg &&
      (getMessageId(existingMsg) !== incomingId ||
        (existingMsg.inputMessageIds?.length &&
          getMessageIds(existingMsg).length > 1 &&
          getMessageIds(incoming).length <= 1))
    ) {
      return { messages: existing, index: existingIdx };
    }
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

export function mergeStreamMessage(
  existing: Message[],
  incoming: Message,
): MergeStreamResult {
  const result = mergeStreamMessageSnapshot(existing, incoming);
  if (incoming.type !== "user" || !incoming.inputMessageIds?.length)
    return result;
  const messages = reconcileInputMessageIds(result.messages);
  return messages === result.messages
    ? result
    : {
        messages,
        index: findMessageIndexById(messages, getMessageId(incoming)),
      };
}
