import { getMessageIds } from "@yep-anywhere/shared/transcript/message";
import type { UserMessage } from "../types.js";

/** The Claude adapter owns SDK priorities; shared scheduling owns intent. */
export function prepareClaudeInput(message: UserMessage): UserMessage {
  switch (message.metadata?.deliveryIntent) {
    case "steer":
      return {
        ...message,
        priority: message.metadata.steerNow ? "now" : "next",
      };
    case "deferred":
    case "patient":
      return { ...message, priority: "later" };
    default:
      return message;
  }
}

/** Native grouped input evidence; absent on older or independently delivered rows. */
export function claudeInputMessageIds(message: {
  type?: unknown;
  uuid?: unknown;
  mergedSendUuids?: unknown;
}): string[] | undefined {
  if (
    message.type !== "user" ||
    typeof message.uuid !== "string" ||
    message.uuid.length === 0 ||
    message.uuid.length > 128 ||
    !Array.isArray(message.mergedSendUuids)
  )
    return undefined;
  const ids = getMessageIds({
    type: "user",
    uuid: message.uuid,
    inputMessageIds: message.mergedSendUuids,
  });
  return ids.length > 1 ? ids : undefined;
}
