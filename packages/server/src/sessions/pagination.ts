/**
 * Compact-boundary pagination for session messages.
 *
 * Slices a normalized message array at compact_boundary positions to reduce
 * payload size for initial loads. This runs AFTER normalization but BEFORE
 * expensive augmentation (markdown, diffs, syntax highlighting).
 */

import type { Message } from "../supervisor/types.js";

/** Pagination metadata returned alongside sliced messages */
export interface PaginationInfo {
  /** Whether there are older messages not included in this response */
  hasOlderMessages: boolean;
  /** Total message count in the full session */
  totalMessageCount: number;
  /** Number of messages returned in this response */
  returnedMessageCount: number;
  /** UUID of the first returned message (pass as beforeMessageId to load previous chunk) */
  truncatedBeforeMessageId?: string;
  /** Total number of compact_boundary entries in the session */
  totalCompactions: number;
}

/** Result of slicing messages at compact boundaries */
export interface SliceResult {
  messages: Message[];
  pagination: PaginationInfo;
}

function getMessageId(m: Message): string | undefined {
  return m.uuid ?? (typeof m.id === "string" ? m.id : undefined);
}

function isCompactBoundary(m: Message): boolean {
  return m.type === "system" && m.subtype === "compact_boundary";
}

/**
 * Slice messages to return only the tail portion starting from the Nth-from-last
 * compact_boundary. The boundary message itself is included so the client sees
 * the "Context compacted" divider.
 *
 * @param messages - Normalized message array (active branch, in conversation order)
 * @param tailCompactions - Number of compact boundaries to include from the end
 * @param beforeMessageId - Optional cursor: only consider messages before this ID
 *                          (used for loading progressively older chunks)
 */
export function sliceAtCompactBoundaries(
  messages: Message[],
  tailCompactions: number,
  beforeMessageId?: string,
  maxMessages?: number,
): SliceResult {
  const totalMessageCount = messages.length;

  // For "load older" requests: work with messages before the cursor
  let workingMessages = messages;
  if (beforeMessageId) {
    const idx = messages.findIndex((m) => getMessageId(m) === beforeMessageId);
    if (idx > 0) {
      workingMessages = messages.slice(0, idx);
    }
    // If not found or idx === 0, use all messages (graceful fallback)
  }

  // Find all compact_boundary indices in the working set
  const compactIndices: number[] = [];
  for (let i = 0; i < workingMessages.length; i++) {
    const m = workingMessages[i];
    if (m && isCompactBoundary(m)) {
      compactIndices.push(i);
    }
  }

  const totalCompactions = compactIndices.length;

  let slicedMessages: Message[];
  let hasOlderMessages = compactIndices.length > tailCompactions;

  // If fewer or equal compactions than requested, start from the full working set
  if (compactIndices.length <= tailCompactions) {
    slicedMessages = workingMessages;
  } else {
    // Slice starting from the Nth-from-last compact boundary (inclusive)
    const sliceFromIdx =
      compactIndices[compactIndices.length - tailCompactions] ?? 0;
    slicedMessages = workingMessages.slice(sliceFromIdx);
  }

  if (
    maxMessages !== undefined &&
    maxMessages > 0 &&
    slicedMessages.length > maxMessages
  ) {
    slicedMessages = slicedMessages.slice(-maxMessages);
    hasOlderMessages = true;
  }

  const firstId = slicedMessages[0]
    ? getMessageId(slicedMessages[0])
    : undefined;

  if (!hasOlderMessages) {
    return {
      messages: slicedMessages,
      pagination: {
        hasOlderMessages: false,
        totalMessageCount,
        returnedMessageCount: slicedMessages.length,
        truncatedBeforeMessageId: undefined,
        totalCompactions,
      },
    };
  }

  return {
    messages: slicedMessages,
    pagination: {
      hasOlderMessages,
      totalMessageCount,
      returnedMessageCount: slicedMessages.length,
      truncatedBeforeMessageId: firstId,
      totalCompactions,
    },
  };
}
