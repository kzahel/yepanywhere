import { randomUUID } from "node:crypto";
import type { DurableLocalCommandMessage } from "@yep-anywhere/shared";

/** A YA-local receipt to show in a session's transcript. */
export interface LocalNotice {
  content: string;
  details?: string[];
  detailsOpen?: boolean;
  tempId?: string;
  /** Slash-command line YA sent the provider to produce this receipt. */
  providerCommandText?: string;
}

/** Build the transcript row for a notice, placed after the given message. */
export function buildLocalNoticeMessage(
  notice: LocalNotice,
  sessionId: string,
  placementAfterMessageId: unknown,
): DurableLocalCommandMessage {
  const id = randomUUID();
  return {
    type: "system",
    subtype: "local_command",
    content: notice.content,
    ...(notice.details ? { details: notice.details } : {}),
    ...(notice.detailsOpen ? { detailsOpen: true } : {}),
    session_id: sessionId,
    uuid: id,
    id,
    timestamp: new Date().toISOString(),
    ...(notice.tempId !== undefined ? { tempId: notice.tempId } : {}),
    ...(notice.providerCommandText
      ? { providerCommandText: notice.providerCommandText }
      : {}),
    ...(typeof placementAfterMessageId === "string"
      ? { placementAfterMessageId }
      : {}),
    isMeta: false,
    isSynthetic: true,
  };
}
