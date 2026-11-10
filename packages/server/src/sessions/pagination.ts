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
  /**
   * Total normalized rows in the reader's available source window. This is the
   * full-session count unless a provider skipped a known-hidden prefix.
   */
  totalMessageCount: number;
  /** Number of messages returned in this response */
  returnedMessageCount: number;
  /** UUID of the first returned message (pass as beforeMessageId to load previous chunk) */
  truncatedBeforeMessageId?: string;
  /** Number of compact boundaries in the reader's available source window. */
  totalCompactions: number;
  /** Total number of user turns in the full session, when turn slicing was used */
  totalUserTurns?: number;
  /** Whether this response came from the aggressive user-turn truncation path */
  truncatedBy?: "compact_boundary" | "user_turn";
}

/** Result of slicing messages at compact boundaries */
export interface SliceResult {
  messages: Message[];
  pagination: PaginationInfo;
}

export interface SliceAfterResult {
  messages: Message[];
  found: boolean;
}

function getMessageId(m: Message): string | undefined {
  return m.uuid ?? (typeof m.id === "string" ? m.id : undefined);
}

/**
 * Return only messages after the requested message id.
 *
 * Some provider readers can apply afterMessageId while reading, but others only
 * expose a full normalized message list. Applying this after normalization keeps
 * incremental refresh responses small when the anchor is present, while leaving
 * already-filtered reader results unchanged when the anchor is absent.
 */
export function sliceAfterMessageId(
  messages: Message[],
  afterMessageId?: string,
): Message[] {
  return sliceAfterMessageIdWithMatch(messages, afterMessageId).messages;
}

export function sliceAfterMessageIdWithMatch(
  messages: Message[],
  afterMessageId?: string,
): SliceAfterResult {
  if (!afterMessageId) {
    return { messages, found: false };
  }

  const index = messages.findIndex((message) => {
    return getMessageId(message) === afterMessageId;
  });
  if (index === -1) {
    return { messages, found: false };
  }

  return {
    messages: [
      ...collectLateDeliveredQueueEntries(messages, index),
      ...messages.slice(index + 1),
    ],
    found: true,
  };
}

/**
 * Claude queue-operation entries become visible only when delivered into the
 * turn but keep their enqueue position, which can precede a mid-turn anchor.
 * A purely positional slice would then never send them to an incrementally
 * fetching client. Include pre-anchor entries whose delivery
 * (`queueDeliveredAt`, stamped in claude-messages.ts) postdates the anchor
 * row; once the client's anchor moves past the delivery moment they stop
 * matching, and re-sends merge idempotently by id client-side.
 */
function collectLateDeliveredQueueEntries(
  messages: Message[],
  anchorIndex: number,
): Message[] {
  const anchor = messages[anchorIndex];
  const anchorTimestamp =
    typeof anchor?.timestamp === "string"
      ? Date.parse(anchor.timestamp)
      : Number.NaN;
  if (!Number.isFinite(anchorTimestamp)) {
    return [];
  }

  const late: Message[] = [];
  for (let i = 0; i < anchorIndex; i += 1) {
    const message = messages[i];
    if (!message) {
      continue;
    }
    // Runtime guard despite the declared type: Message spreads raw JSONL, so
    // a durable line could carry a non-string value under this key.
    const deliveredAt = message.queueDeliveredAt;
    if (typeof deliveredAt !== "string") {
      continue;
    }
    const deliveredAtMs = Date.parse(deliveredAt);
    if (Number.isFinite(deliveredAtMs) && deliveredAtMs > anchorTimestamp) {
      late.push(message);
    }
  }
  return late;
}

function isCompactBoundary(m: Message): boolean {
  return m.type === "system" && m.subtype === "compact_boundary";
}

function getMessageText(m: Message): string | undefined {
  const record = m as Message & {
    content?: unknown;
    message?: { content?: unknown };
  };
  if (typeof record.message?.content === "string") {
    return record.message.content;
  }
  return typeof record.content === "string" ? record.content : undefined;
}

function getMessageContentArray(m: Message): unknown[] | undefined {
  const record = m as Message & {
    content?: unknown;
    message?: { content?: unknown };
  };
  const content = record.message?.content ?? record.content;
  return Array.isArray(content) ? content : undefined;
}

function getTextContent(m: Message): string | undefined {
  const text = getMessageText(m);
  if (text !== undefined) {
    return text;
  }
  const content = getMessageContentArray(m);
  if (!content) {
    return undefined;
  }
  const textBlocks = content
    .map((block) =>
      block &&
      typeof block === "object" &&
      (block as { type?: unknown }).type === "text" &&
      typeof (block as { text?: unknown }).text === "string"
        ? (block as { text: string }).text
        : "",
    )
    .filter(Boolean);
  return textBlocks.length > 0 ? textBlocks.join("\n") : undefined;
}

function hasOnlyToolResultContent(m: Message): boolean {
  const content = getMessageContentArray(m);
  return (
    Array.isArray(content) &&
    content.length > 0 &&
    content.every(
      (block) =>
        block &&
        typeof block === "object" &&
        (block as { type?: unknown }).type === "tool_result",
    )
  );
}

function isSlashCommandSkillBody(m: Message): boolean {
  if ((m as { isMeta?: unknown }).isMeta !== true) {
    return false;
  }
  return (
    getTextContent(m)
      ?.trimStart()
      .startsWith("Base directory for this skill:") === true
  );
}

function isLocalCommandTranscriptText(text: string): boolean {
  const trimmed = text.trim();
  const commandNameMatch = /<command-name>[\s\S]*<\/command-name>/.test(
    trimmed,
  );
  const commandRemainder = trimmed
    .replace(/<command-name>[\s\S]*?<\/command-name>/g, "")
    .replace(/<command-message>[\s\S]*?<\/command-message>/g, "")
    .replace(/<command-args>[\s\S]*?<\/command-args>/g, "")
    .trim();
  return (
    /^<local-command-caveat>[\s\S]*<\/local-command-caveat>$/.test(trimmed) ||
    /^<local-command-stdout>[\s\S]*<\/local-command-stdout>$/.test(trimmed) ||
    (commandNameMatch && commandRemainder === "")
  );
}

function isSyntheticUserTurn(m: Message): boolean {
  if ((m as { isSynthetic?: unknown }).isSynthetic === true) {
    return true;
  }

  if ((m as { isCompactSummary?: unknown }).isCompactSummary === true) {
    return true;
  }

  if (hasOnlyToolResultContent(m)) {
    return true;
  }

  if (isSlashCommandSkillBody(m)) {
    return true;
  }

  const text = getMessageText(m);
  return typeof text === "string" && isLocalCommandTranscriptText(text);
}

export function isUserTurn(m: Message): boolean {
  const record = m as Message & {
    role?: unknown;
    message?: { role?: unknown };
  };
  const role =
    typeof record.role === "string"
      ? record.role
      : typeof record.message?.role === "string"
        ? record.message.role
        : undefined;
  return (
    (m.type === "user" || role === "user") &&
    !isSyntheticUserTurn(m) &&
    // A turn a same-session rewind dropped is history, not a window unit:
    // the tail window is measured in live turns (topics/session-rewind.md).
    typeof (m as { rewoundGroupId?: unknown }).rewoundGroupId !== "string"
  );
}

function rewoundGroupIdOf(m: Message | undefined): string | undefined {
  const groupId = m?.rewoundGroupId;
  return typeof groupId === "string" ? groupId : undefined;
}

/**
 * Where a window starting at `startIdx` must start instead so it never opens
 * inside a rewound group. A group's rows follow its header, and a nested
 * group's header shows only while every enclosing group is expanded, so the
 * start backs up to the header of the outermost group enclosing that row
 * (topics/session-rewind.md).
 */
function windowStartOutsideRewoundGroups(
  messages: Message[],
  startIdx: number,
): number {
  let start = startIdx;
  let groupId = rewoundGroupIdOf(messages[startIdx]);
  const seen = new Set<string>();
  while (groupId !== undefined && !seen.has(groupId)) {
    seen.add(groupId);
    const firstIdx = messages.findIndex((m) => rewoundGroupIdOf(m) === groupId);
    if (firstIdx < 0) break;
    start = Math.min(start, firstIdx);
    const parent = messages[firstIdx]?.rewoundParentGroupId;
    groupId = typeof parent === "string" ? parent : undefined;
  }
  return start;
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
): SliceResult {
  const totalMessageCount = messages.length;

  // For "load older" requests: work with messages before the cursor
  let workingMessages = messages;
  if (beforeMessageId) {
    const idx = messages.findIndex((m) => getMessageId(m) === beforeMessageId);
    // A stale or missing older-page cursor must not fall back to the current
    // tail/full history: the client prepends this response, so overlap can
    // duplicate large chunks in memory. Missing and first-message cursors both
    // mean "there is no known older page to return."
    workingMessages = idx > 0 ? messages.slice(0, idx) : [];
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

  // If fewer compactions exist than requested, return everything. Once the
  // requested number of boundaries exists, the oldest pre-boundary window is
  // outside the requested compact tail.
  if (compactIndices.length < tailCompactions) {
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

  // Slice starting from the Nth-from-last compact boundary (inclusive)
  const sliceFromIdx = windowStartOutsideRewoundGroups(
    workingMessages,
    compactIndices[compactIndices.length - tailCompactions] ?? 0,
  );
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
 * Slice messages to a recent user-turn window, or to a caller-chosen user turn.
 *
 * This is intentionally more aggressive than compact-boundary pagination: it is
 * an opt-in browser memory workaround for very long transcripts where the user
 * wants the client to avoid receiving older history at all.
 */
export function sliceAtUserTurnBoundary(
  messages: Message[],
  tailTurns: number,
  fromMessageId?: string,
): SliceResult {
  const totalMessageCount = messages.length;
  const userTurnIndices: number[] = [];
  let totalCompactions = 0;

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (!message) continue;
    if (isUserTurn(message)) {
      userTurnIndices.push(index);
    }
    if (isCompactBoundary(message)) {
      totalCompactions += 1;
    }
  }

  const totalUserTurns = userTurnIndices.length;
  let sliceFromIdx = 0;

  if (fromMessageId) {
    sliceFromIdx = messages.findIndex((m) => getMessageId(m) === fromMessageId);
    if (sliceFromIdx < 0) {
      return {
        messages: [],
        pagination: {
          hasOlderMessages: false,
          totalMessageCount,
          returnedMessageCount: 0,
          truncatedBeforeMessageId: undefined,
          totalCompactions,
          totalUserTurns,
          truncatedBy: "user_turn",
        },
      };
    }
  } else if (totalUserTurns > tailTurns) {
    sliceFromIdx = userTurnIndices[totalUserTurns - tailTurns] ?? 0;
  }
  sliceFromIdx = windowStartOutsideRewoundGroups(messages, sliceFromIdx);

  const slicedMessages = messages.slice(sliceFromIdx);
  const firstId = slicedMessages[0]
    ? getMessageId(slicedMessages[0])
    : undefined;

  return {
    messages: slicedMessages,
    pagination: {
      hasOlderMessages: sliceFromIdx > 0,
      totalMessageCount,
      returnedMessageCount: slicedMessages.length,
      truncatedBeforeMessageId: sliceFromIdx > 0 ? firstId : undefined,
      totalCompactions,
      totalUserTurns,
      truncatedBy: "user_turn",
    },
  };
}

/**
 * Apply a user-turn selector without allowing it to broaden the authorized
 * compact-tail scope. Both selectors produce suffixes of the same transcript,
 * so the smaller suffix is their intersection.
 */
export function sliceAtCompactAndUserTurnBoundaries(
  messages: Message[],
  tailCompactions: number,
  tailTurns: number,
  fromMessageId?: string,
): SliceResult {
  const compactSlice = sliceAtCompactBoundaries(messages, tailCompactions);
  const turnSlice = sliceAtUserTurnBoundary(messages, tailTurns, fromMessageId);
  const turnSelectorMissing =
    fromMessageId !== undefined && turnSlice.messages.length === 0;
  // A fromMessageId absent from this list is older than the window, or
  // unknown. Compact scope still wins: the selector must not return an empty
  // page that looks like the start of history. Provider compact-window reads
  // omit the prefix, so an older-but-valid id looks missing here.
  const turnWins =
    !turnSelectorMissing &&
    turnSlice.messages.length < compactSlice.messages.length;
  const selected = turnWins ? turnSlice : compactSlice;
  const hasOlderMessages = selected.pagination.hasOlderMessages;
  const firstId = selected.messages[0]
    ? getMessageId(selected.messages[0])
    : undefined;

  return {
    messages: selected.messages,
    pagination: {
      hasOlderMessages,
      totalMessageCount: messages.length,
      returnedMessageCount: selected.messages.length,
      truncatedBeforeMessageId:
        hasOlderMessages && firstId ? firstId : undefined,
      totalCompactions: compactSlice.pagination.totalCompactions,
      totalUserTurns: turnSlice.pagination.totalUserTurns,
      ...(hasOlderMessages
        ? {
            truncatedBy: turnWins
              ? ("user_turn" as const)
              : ("compact_boundary" as const),
          }
        : {}),
    },
  };
}
