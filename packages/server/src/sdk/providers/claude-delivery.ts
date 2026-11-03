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
