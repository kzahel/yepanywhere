import {
  CapabilityRestrictionFold,
  type CapabilityRestrictionSummary,
  readModelRefusalFallback,
} from "@yep-anywhere/shared/transcript/capabilityRestriction";
import {
  getMessageId,
  type Message,
} from "@yep-anywhere/shared/transcript/message";

/**
 * A session's restricted capability state: the server's summary continued
 * through the loaded transcript rows, so a refusal fallback shows as it
 * streams in rather than at the next summary read.
 */
export function sessionCapabilityRestriction(
  summary: CapabilityRestrictionSummary | undefined,
  messages: readonly Message[],
): CapabilityRestrictionSummary | undefined {
  const fold = new CapabilityRestrictionFold(summary);
  for (const message of messages) {
    if (message.isSubagent) continue;
    if (message.type === "assistant") {
      const model = message.message?.model;
      if (typeof model === "string" && model && model !== "<synthetic>")
        fold.answeredBy(model);
      continue;
    }
    if (message.type !== "system") continue;
    const fallback = readModelRefusalFallback(
      message as Record<string, unknown>,
    );
    const messageId = getMessageId(message);
    if (!fallback || !messageId) continue;
    fold.fallback({
      messageId,
      ...(message.timestamp ? { at: message.timestamp } : {}),
      ...fallback,
    });
  }
  return fold.summary();
}
