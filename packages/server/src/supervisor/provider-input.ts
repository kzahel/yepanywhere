import { randomUUID } from "node:crypto";
import type { PermissionMode } from "@yep-anywhere/shared";
import type { UserMessage } from "../sdk/types.js";

/**
 * An input as it enters the provider's queue: with its UUID (the one both
 * the stream's user row and the provider's message use), and with the
 * standing permission mode when the input names none, so a mode chosen
 * since launch reaches providers that apply one per turn
 * (topics/permission-mode.md, "Provider Adapter Invariants").
 */
export function providerInput(
  message: UserMessage,
  standingMode: PermissionMode,
): UserMessage & { uuid: string } {
  return {
    ...message,
    uuid: message.uuid ?? randomUUID(),
    mode: message.mode ?? standingMode,
  };
}
