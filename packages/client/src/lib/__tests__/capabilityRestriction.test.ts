import type { CapabilityRestrictionSummary } from "@yep-anywhere/shared/transcript/capabilityRestriction";
import type { Message } from "@yep-anywhere/shared/transcript/message";
import { describe, expect, it } from "vitest";
import { sessionCapabilityRestriction } from "../capabilityRestriction";

const FABLE = "claude-fable-5";
const OPUS = "claude-opus-4-8";

const answer = (model: string): Message => ({
  type: "assistant",
  message: { role: "assistant", content: "ok", model },
});
/** A live SDK row: snake_case, where the durable transcript uses camelCase. */
const liveFallback = (uuid: string): Message =>
  ({
    type: "system",
    subtype: "model_refusal_fallback",
    uuid,
    original_model: FABLE,
    fallback_model: OPUS,
    api_refusal_category: "cyber",
  }) as Message;

const earlier = (activeModel?: string): CapabilityRestrictionSummary => ({
  events: [
    { messageId: "old", fromModel: FABLE, toModel: OPUS, scope: "session" },
  ],
  ...(activeModel ? { activeModel } : {}),
  omitted: false,
});

describe("session capability restriction", () => {
  it("shows a fallback that streamed in after the server's summary", () => {
    const restriction = sessionCapabilityRestriction(undefined, [
      answer(FABLE),
      liveFallback("live"),
    ]);
    expect(restriction?.activeModel).toBe(OPUS);
    expect(restriction?.events).toEqual([
      {
        messageId: "live",
        fromModel: FABLE,
        toModel: OPUS,
        category: "cyber",
        scope: "session",
      },
    ]);
  });

  it("keeps a restriction recorded before the loaded rows", () => {
    const restriction = sessionCapabilityRestriction(earlier(OPUS), [
      answer(OPUS),
    ]);
    expect(restriction?.activeModel).toBe(OPUS);
  });

  it("ends a summarized restriction when a loaded row answers otherwise", () => {
    const restriction = sessionCapabilityRestriction(earlier(OPUS), [
      answer(OPUS),
      answer(FABLE),
    ]);
    expect(restriction?.activeModel).toBeUndefined();
    expect(restriction?.events).toHaveLength(1);
  });

  it("does not revive an ended restriction from rows that precede it", () => {
    // The loaded rows include the pre-fallback answer and the fallback row
    // the summary already counts.
    const restriction = sessionCapabilityRestriction(earlier(), [
      answer(FABLE),
      { ...liveFallback("old") },
      answer(OPUS),
      answer(FABLE),
    ]);
    expect(restriction?.activeModel).toBeUndefined();
    expect(restriction?.events).toHaveLength(1);
  });
});
