import type { Message } from "../types";

/**
 * Helper to get content from a message, handling both top-level and SDK nested structure.
 * SDK messages have content nested in message.content.
 */
export function getMessageContent(m: Message): unknown {
  return m.content ?? (m.message as { content?: unknown } | undefined)?.content;
}

/**
 * Resolve a parent ID through temp→real mappings.
 * If the parent is a temp ID that was replaced, returns the real ID.
 */
function resolveParentId(
  parentId: string | null | undefined,
  tempIdMappings: Map<string, string>,
): string | null | undefined {
  if (!parentId) return parentId;
  return tempIdMappings.get(parentId) ?? parentId;
}

/**
 * Check if two messages have matching parents, accounting for temp→real ID mappings.
 * A temp message's parent (which might be a temp ID) should match the incoming message's
 * parent (which is a real ID) after resolving through the mappings.
 *
 * If the incoming message doesn't have parentUuid (e.g., SSE messages from SDK),
 * we can't use parent matching and return true to fall back to content-only matching.
 */
function parentsMatch(
  tempMsg: Message,
  incomingMsg: Message,
  tempIdMappings: Map<string, string>,
): boolean {
  const tempParent = resolveParentId(tempMsg.parentUuid, tempIdMappings);
  const incomingParent = incomingMsg.parentUuid;

  // Both null/undefined = match
  if (!tempParent && !incomingParent) return true;

  // If incoming doesn't have parentUuid (e.g., SSE from SDK), fall back to content matching
  // This allows SSE messages without DAG info to still match temp messages
  if (incomingParent === undefined) return true;

  // If temp doesn't have parent but incoming does, no match
  // (incoming is more specific, temp is older/less specific)
  if (!tempParent) return false;

  // Compare resolved IDs
  return tempParent === incomingParent;
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
    // - eventType: SSE envelope type (message, status, etc.)
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
  /** IDs that were replaced (temp or SDK messages matched to JSONL) */
  replacedIds: Set<string>;
  /** New temp→real ID mappings discovered during this merge */
  newMappings: Map<string, string>;
}

/**
 * Merge incoming JSONL messages with existing messages.
 *
 * Handles:
 * - Deduplication of temp messages (temp-*) that match JSONL by content AND parent
 * - Deduplication of SDK messages that match JSONL by content AND parent
 * - Position preservation when replacing messages
 * - Adding new messages at end
 *
 * @param tempIdMappings - Existing temp→real ID mappings for parent resolution
 */
export function mergeJSONLMessages(
  existing: Message[],
  incoming: Message[],
  tempIdMappings: Map<string, string> = new Map(),
): MergeJSONLResult {
  // Create a map of existing messages for efficient lookup
  const messageMap = new Map(existing.map((m) => [m.id, m]));
  // Track which IDs have been replaced
  const replacedIds = new Set<string>();
  // Track ID replacements: old ID -> new ID (for position preservation)
  const idReplacements = new Map<string, string>();
  // New mappings discovered in this merge
  const newMappings = new Map<string, string>();
  // Combined mappings (existing + new) for parent resolution
  const allMappings = new Map(tempIdMappings);

  // Merge each incoming JSONL message
  for (const incomingMsg of incoming) {
    // Check if this is a user message that should replace a temp or SDK message
    // This handles the case where SSE and JSONL have different UUIDs for the same message
    if (incomingMsg.type === "user") {
      const incomingContent = getMessageContent(incomingMsg);
      const duplicateMsg = existing.find(
        (m) =>
          m.id !== incomingMsg.id && // Different ID
          !replacedIds.has(m.id) && // Not already matched by a previous JSONL message
          (m.id.startsWith("temp-") || m._source === "sdk") && // Temp or SDK-sourced
          m.type === "user" &&
          JSON.stringify(getMessageContent(m)) ===
            JSON.stringify(incomingContent) &&
          parentsMatch(m, incomingMsg, allMappings), // Parents must match too
      );
      if (duplicateMsg) {
        // Mark duplicate ID as replaced and track the replacement
        replacedIds.add(duplicateMsg.id);
        idReplacements.set(duplicateMsg.id, incomingMsg.id);
        messageMap.delete(duplicateMsg.id);
        // Record the mapping for future parent resolution
        if (duplicateMsg.id.startsWith("temp-")) {
          newMappings.set(duplicateMsg.id, incomingMsg.id);
          allMappings.set(duplicateMsg.id, incomingMsg.id);
        }
      }
    }

    const existingMsg = messageMap.get(incomingMsg.id);
    messageMap.set(
      incomingMsg.id,
      mergeMessage(existingMsg, incomingMsg, "jsonl"),
    );
  }

  // Build result array, preserving order
  // When a message is replaced, insert the replacement at the same position
  const result: Message[] = [];
  const seen = new Set<string>();

  // First add existing messages (in order), replacing as needed
  for (const msg of existing) {
    if (replacedIds.has(msg.id)) {
      // This message was replaced - insert the replacement here
      const replacementId = idReplacements.get(msg.id);
      if (replacementId && !seen.has(replacementId)) {
        const replacement = messageMap.get(replacementId);
        if (replacement) {
          result.push(replacement);
          seen.add(replacementId);
        }
      }
    } else if (!seen.has(msg.id)) {
      result.push(messageMap.get(msg.id) ?? msg);
      seen.add(msg.id);
    }
  }

  // Then add any truly new messages (not replacements)
  for (const incomingMsg of incoming) {
    if (!seen.has(incomingMsg.id)) {
      result.push(messageMap.get(incomingMsg.id) ?? incomingMsg);
      seen.add(incomingMsg.id);
    }
  }

  return { messages: result, replacedIds, newMappings };
}

export interface MergeSSEResult {
  messages: Message[];
  /** Whether a temp message was replaced */
  replacedTemp: boolean;
  /** The temp ID that was replaced, if any */
  replacedTempId: string | null;
  /** Index where the message was inserted/updated */
  index: number;
}

/**
 * Find the most recent temp user message that matches the incoming message.
 * When parentUuid is missing (SSE from SDK), we only match the LAST temp user message
 * to avoid incorrectly matching replayed messages to newer temps.
 */
function findMatchingTempMessage(
  existing: Message[],
  incoming: Message,
  tempIdMappings: Map<string, string>,
): number {
  const incomingContent = JSON.stringify(getMessageContent(incoming));

  // Find all temp user messages with matching content
  const tempCandidates: { index: number; msg: Message }[] = [];
  for (let i = 0; i < existing.length; i++) {
    const m = existing[i];
    if (
      m?.id.startsWith("temp-") &&
      m.type === "user" &&
      JSON.stringify(getMessageContent(m)) === incomingContent
    ) {
      tempCandidates.push({ index: i, msg: m });
    }
  }

  if (tempCandidates.length === 0) return -1;

  // If incoming has parentUuid, use parent matching to find the right one
  if (incoming.parentUuid !== undefined) {
    for (const { index, msg } of tempCandidates) {
      if (parentsMatch(msg, incoming, tempIdMappings)) {
        return index;
      }
    }
    return -1;
  }

  // No parentUuid: only match if there's exactly ONE temp with this content
  // This prevents replayed SSE messages from matching the wrong temp
  if (tempCandidates.length === 1) {
    return tempCandidates[0]?.index ?? -1;
  }

  // Multiple temps with same content and no parent info - can't safely match
  // Let JSONL (which has parentUuid) handle the dedup
  return -1;
}

/**
 * Merge an incoming SSE message with existing messages.
 *
 * Handles:
 * - Merging with existing message if same ID
 * - Replacing temp messages for user messages by content AND parent match
 * - Adding new messages at end
 *
 * @param tempIdMappings - Existing temp→real ID mappings for parent resolution
 */
export function mergeSSEMessage(
  existing: Message[],
  incoming: Message,
  tempIdMappings: Map<string, string> = new Map(),
): MergeSSEResult {
  // Check for existing message with same ID
  const existingIdx = existing.findIndex((m) => m.id === incoming.id);

  if (existingIdx >= 0) {
    // Merge with existing message
    const existingMsg = existing[existingIdx];
    const merged = mergeMessage(existingMsg, incoming, "sdk");

    // Only update if actually different
    if (existingMsg === merged) {
      return {
        messages: existing,
        replacedTemp: false,
        replacedTempId: null,
        index: existingIdx,
      };
    }

    const updated = [...existing];
    updated[existingIdx] = merged;
    return {
      messages: updated,
      replacedTemp: false,
      replacedTempId: null,
      index: existingIdx,
    };
  }

  // For user messages, check if we have a temp message to replace
  if (incoming.type === "user") {
    const tempIdx = findMatchingTempMessage(existing, incoming, tempIdMappings);
    if (tempIdx >= 0) {
      // Replace temp message with authoritative one (real UUID + all fields)
      const updated = [...existing];
      const existingTemp = updated[tempIdx];
      if (existingTemp) {
        updated[tempIdx] = {
          ...existingTemp,
          ...incoming,
          _source: "sdk",
        };
        return {
          messages: updated,
          replacedTemp: true,
          replacedTempId: existingTemp.id,
          index: tempIdx,
        };
      }
    }
  }

  // Add new message
  return {
    messages: [...existing, { ...incoming, _source: "sdk" }],
    replacedTemp: false,
    replacedTempId: null,
    index: existing.length,
  };
}
