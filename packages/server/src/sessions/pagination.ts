/**
 * Pagination helpers for session messages.
 *
 * Slicing runs AFTER normalization but BEFORE expensive augmentation
 * (markdown, diffs, syntax highlighting).
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

/** Result of slicing messages */
export interface SliceResult {
  messages: Message[];
  pagination: PaginationInfo;
}

function getMessageId(message: Message): string | undefined {
  return (
    message.uuid ?? (typeof message.id === "string" ? message.id : undefined)
  );
}

function isCompactBoundary(message: Message): boolean {
  return message.type === "system" && message.subtype === "compact_boundary";
}

function buildWorkingSet(
  messages: Message[],
  beforeMessageId?: string,
): { totalMessageCount: number; workingMessages: Message[] } {
  const totalMessageCount = messages.length;

  let workingMessages = messages;
  if (beforeMessageId) {
    const idx = messages.findIndex(
      (message) => getMessageId(message) === beforeMessageId,
    );
    if (idx > 0) {
      workingMessages = messages.slice(0, idx);
    }
  }

  return { totalMessageCount, workingMessages };
}

/**
 * Slice messages to return only the last N messages.
 */
export function sliceLastMessages(
  messages: Message[],
  tailMessages: number,
  beforeMessageId?: string,
): SliceResult {
  const { totalMessageCount, workingMessages } = buildWorkingSet(
    messages,
    beforeMessageId,
  );

  const totalCompactions = workingMessages.filter(isCompactBoundary).length;

  if (workingMessages.length <= tailMessages) {
    return {
      messages: workingMessages,
      pagination: {
        hasOlderMessages: false,
        totalMessageCount,
        returnedMessageCount: workingMessages.length,
        truncatedBeforeMessageId: undefined,
        totalCompactions,
      },
    };
  }

  const sliceFromIdx = Math.max(workingMessages.length - tailMessages, 0);
  const slicedMessages = workingMessages.slice(sliceFromIdx);
  const firstId = slicedMessages[0]
    ? getMessageId(slicedMessages[0])
    : undefined;

  return {
    messages: slicedMessages,
    pagination: {
      hasOlderMessages: true,
      totalMessageCount,
      returnedMessageCount: slicedMessages.length,
      truncatedBeforeMessageId: firstId,
      totalCompactions,
    },
  };
}

/**
 * Slice messages starting at the Nth-from-last compact boundary.
 */
export function sliceAtCompactBoundaries(
  messages: Message[],
  tailCompactions: number,
  beforeMessageId?: string,
): SliceResult {
  const { totalMessageCount, workingMessages } = buildWorkingSet(
    messages,
    beforeMessageId,
  );

  const compactIndices: number[] = [];
  for (let i = 0; i < workingMessages.length; i++) {
    const message = workingMessages[i];
    if (message && isCompactBoundary(message)) {
      compactIndices.push(i);
    }
  }

  const totalCompactions = compactIndices.length;

  if (compactIndices.length <= tailCompactions) {
    return {
      messages: workingMessages,
      pagination: {
        hasOlderMessages: false,
        totalMessageCount,
        returnedMessageCount: workingMessages.length,
        truncatedBeforeMessageId: undefined,
        totalCompactions,
      },
    };
  }

  const sliceFromIdx =
    compactIndices[compactIndices.length - tailCompactions] ?? 0;
  const slicedMessages = workingMessages.slice(sliceFromIdx);
  const firstId = slicedMessages[0]
    ? getMessageId(slicedMessages[0])
    : undefined;

  return {
    messages: slicedMessages,
    pagination: {
      hasOlderMessages: true,
      totalMessageCount,
      returnedMessageCount: slicedMessages.length,
      truncatedBeforeMessageId: firstId,
      totalCompactions,
    },
  };
}
