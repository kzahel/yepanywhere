import { describe, expect, it, vi } from "vitest";
import {
  ConversationBinding,
  conversationAvailability,
  readConversation,
} from "../src/experimental/conversation-client.js";
import { CONVERSATION_API_REVISION } from "../src/experimental/conversation-protocol.js";
const supported = {
  capabilityEncoding: 1,
  capabilityBits: [[2, 32]] as const,
  experimentalSimpleClientApiRevision: CONVERSATION_API_REVISION,
};
const query = { sessionId: "s", maxMessages: 20, anchorMessageId: null };
const frame = (subscriptionId: string, sequence = 0) =>
  JSON.stringify({
    apiRevision: CONVERSATION_API_REVISION,
    subscriptionId,
    sequence,
    view: { kind: "error", code: "unavailable", message: "Test source" },
  });
describe("source-bound experimental Conversation client", () => {
  it("distinguishes missing revision metadata from a different preview revision", () => {
    expect(
      conversationAvailability({
        ...supported,
        experimentalSimpleClientApiRevision: undefined,
      }),
    ).toBe("update-required");
    expect(
      conversationAvailability({
        ...supported,
        experimentalSimpleClientApiRevision: "future",
      }),
    ).toBe("revision-mismatch");
  });

  it("makes zero calls for supported stable releases and revision mismatches while a peer succeeds", async () => {
    for (const version of [
      { current: "0.8.0" },
      { current: "0.8.1" },
      { ...supported, experimentalSimpleClientApiRevision: undefined },
      { ...supported, experimentalSimpleClientApiRevision: "future" },
    ]) {
      const request = vi.fn(async () => frame("binding"));
      const result = await readConversation({
        sourceId: "old",
        subscriptionId: "binding",
        query,
        version,
        request,
      });
      expect("unavailable" in result).toBe(true);
      expect(request).not.toHaveBeenCalled();
    }
    const request = vi.fn(async () => frame("binding"));
    expect(
      await readConversation({
        sourceId: "peer",
        subscriptionId: "binding",
        query,
        version: supported,
        request,
      }),
    ).toMatchObject({ sourceId: "peer", snapshot: { sequence: 0 } });
    expect(request).toHaveBeenCalledTimes(1);
  });
  it("rejects stale, duplicate, closed and cross-source frames even when session IDs collide", () => {
    const binding = new ConversationBinding("a", "new", "s");
    expect(binding.accept("b", frame("new"))).toBeNull();
    expect(binding.accept("a", frame("old"))).toBeNull();
    expect(binding.accept("a", frame("new"))).not.toBeNull();
    expect(binding.accept("a", frame("new"))).toBeNull();
    expect(binding.accept("a", frame("new", 2))).not.toBeNull();
    expect(binding.accept("a", frame("new", 1))).toBeNull();
    binding.close();
    expect(binding.accept("a", frame("new", 3))).toBeNull();
  });
});
