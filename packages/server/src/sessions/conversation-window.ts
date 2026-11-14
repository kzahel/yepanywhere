import {
  getMessageId,
  type Message,
} from "@yep-anywhere/shared/transcript/message";
import { isUserPromptMessage } from "@yep-anywhere/shared/transcript/messageProjection";
import { sliceAtCompactBoundaries } from "./pagination.js";
import type { Message as ServerMessage } from "../supervisor/types.js";

export interface ConversationWindowRequest {
  tailCompactions: number;
  maxBytes: number;
  maxRecords: number;
  signal: AbortSignal;
}

/** Select only after native branch/lineage normalization. Indexing is optional. */
export function selectConversationWindow(
  messages: Message[],
  request: ConversationWindowRequest,
) {
  request.signal.throwIfAborted();
  const scoped = sliceAtCompactBoundaries(
    messages as ServerMessage[],
    request.tailCompactions,
  );
  const selected: Message[] = [];
  let bytes = 2;
  let first = scoped.messages.length;
  let limited = false;
  const limitedBy = new Set<"bytes" | "records">();
  for (let index = scoped.messages.length - 1; index >= 0; index--) {
    request.signal.throwIfAborted();
    const message = scoped.messages[index]! as Message;
    const size = Buffer.byteLength(JSON.stringify(message));
    if (
      selected.length >= request.maxRecords ||
      (selected.length > 0 && bytes + size + 1 > request.maxBytes)
    ) {
      limited = true;
      limitedBy.add(
        selected.length >= request.maxRecords ? "records" : "bytes",
      );
      break;
    }
    // Preserve an explicit visible omission instead of losing an oversized tail.
    const fits = size + 3 <= request.maxBytes;
    const selectedMessage: Message = fits
      ? message
      : {
          type: isUserPromptMessage(message) ? "user" : "assistant",
          uuid: getMessageId(message),
          timestamp: message.timestamp,
          isSubagent: message.isSubagent,
          content: [{ type: "conversation-acquisition-omission" }],
        };
    selected.push(selectedMessage);
    bytes +=
      (fits ? size : Buffer.byteLength(JSON.stringify(selectedMessage))) + 1;
    first = index;
    limited ||= !fits;
    if (!fits) limitedBy.add("bytes");
  }
  selected.reverse();
  const absoluteStart = messages.length - scoped.messages.length + first;
  let leadingUserMessageId: string | null = null;
  for (let index = absoluteStart - 1; index >= 0; index--) {
    const message = messages[index]!;
    if (!message.isSubagent && isUserPromptMessage(message)) {
      leadingUserMessageId = getMessageId(message) || null;
      break;
    }
  }
  return {
    messages: selected,
    sourceCoverage: {
      complete: !limited,
      earlierOutsideScope: scoped.pagination.hasOlderMessages
        ? ("yes" as const)
        : ("no" as const),
      earlierInScope: first > 0,
      leadingUserMessageId,
      limitedBy: [...limitedBy],
    },
  };
}
