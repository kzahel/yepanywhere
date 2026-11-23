import type { AntigravityHistoryGap } from "../sdk/providers/antigravity-owners.js";
import type { Message } from "../supervisor/types.js";

const TEXT: Record<AntigravityHistoryGap, string> = {
  missing:
    "Earlier history cannot be shown: this conversation's Antigravity log does not hold it, and YA reads history only from that log. Resuming continues the conversation with the context agy kept.",
  unknown:
    "Earlier history cannot be shown: YA cannot read Antigravity's log for this conversation. Resuming continues the conversation with the context agy kept.",
};

/**
 * The row that stands where history YA cannot show would be (plan 195 step
 * 8): an informational system message, in the vocabulary every client
 * already renders, so the transcript says so rather than only
 * `transcriptComplete: false`. Its ID names no log step.
 */
export function antigravityHistoryNotice(
  conversationId: string,
  gap: AntigravityHistoryGap,
  reason?: string,
): Message {
  return {
    type: "system",
    subtype: "informational",
    uuid: `${conversationId}:history-unavailable`,
    session_id: conversationId,
    content: TEXT[gap],
    ...(reason ? { details: [`Why: ${reason}.`] } : {}),
  };
}
