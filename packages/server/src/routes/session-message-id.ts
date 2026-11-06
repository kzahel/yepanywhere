import type { Message } from "../supervisor/types.js";

/** The id a transcript row is addressed by: its uuid, else its provider id. */
export function messageId(message: Message | undefined): string | undefined {
  if (!message) {
    return undefined;
  }
  return (
    (typeof message.uuid === "string" && message.uuid) ||
    (typeof message.id === "string" && message.id) ||
    undefined
  );
}
