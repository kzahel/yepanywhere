import { describe, expect, it } from "vitest";
import type { SDKMessage } from "../../src/sdk/types.js";
import { shouldEmitMessage } from "../../src/supervisor/Process.js";

/**
 * Tests for shouldEmitMessage to prevent regression of the tool_result bug.
 *
 * Background: Tool results are user-type messages containing tool_result content.
 * A previous bug filtered out user messages to avoid duplicates, which broke
 * tool result rendering (tool calls stayed "pending" until page refresh).
 *
 * The client handles deduplication by UUID, so we must emit ALL messages.
 */
describe("shouldEmitMessage", () => {
  it("should emit user messages (they contain tool_result content)", () => {
    const userMessage: SDKMessage = {
      type: "user",
      uuid: "test-uuid",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tool-123",
            content: "Command executed successfully",
          },
        ],
      },
    };
    expect(shouldEmitMessage(userMessage)).toBe(true);
  });

  it("should emit assistant messages", () => {
    const assistantMessage: SDKMessage = {
      type: "assistant",
      uuid: "test-uuid",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Hello" }],
      },
    };
    expect(shouldEmitMessage(assistantMessage)).toBe(true);
  });

  it("should emit system messages", () => {
    const systemMessage: SDKMessage = {
      type: "system",
      subtype: "init",
      session_id: "sess-123",
    };
    expect(shouldEmitMessage(systemMessage)).toBe(true);
  });

  it("should emit stream_event messages", () => {
    const streamEvent: SDKMessage = {
      type: "stream_event",
      event: { type: "content_block_delta" },
    };
    expect(shouldEmitMessage(streamEvent)).toBe(true);
  });

  it("should emit result messages", () => {
    const resultMessage: SDKMessage = {
      type: "result",
    };
    expect(shouldEmitMessage(resultMessage)).toBe(true);
  });

  // This test documents the critical invariant
  it("CRITICAL: must return true for ALL message types to avoid tool_result bug", () => {
    // If someone adds filtering logic, this test should fail
    const messageTypes: SDKMessage[] = [
      { type: "user", uuid: "1", message: { role: "user", content: "test" } },
      {
        type: "assistant",
        uuid: "2",
        message: { role: "assistant", content: [] },
      },
      { type: "system", subtype: "init" },
      { type: "stream_event", event: {} },
      { type: "result" },
    ];

    for (const msg of messageTypes) {
      expect(
        shouldEmitMessage(msg),
        `shouldEmitMessage must return true for type="${msg.type}" - filtering breaks tool_result rendering!`,
      ).toBe(true);
    }
  });
});
