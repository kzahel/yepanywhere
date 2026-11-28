import { describe, expect, it } from "vitest";
import { markSubagent } from "../../src/augments/message-utils.js";

describe("markSubagent", () => {
  describe("legacy SDK (parent_tool_use_id)", () => {
    it("marks messages with parent_tool_use_id as subagent", () => {
      const msg = {
        type: "stream_event",
        parent_tool_use_id: "tool-abc",
        event: { type: "message_start" },
      };
      const result = markSubagent(msg);
      expect(result.isSubagent).toBe(true);
      expect(result.parentToolUseId).toBe("tool-abc");
    });

    it("preserves all original fields", () => {
      const msg = {
        type: "assistant",
        uuid: "msg-1",
        parent_tool_use_id: "tool-abc",
        message: { content: "hello" },
      };
      const result = markSubagent(msg);
      expect(result.type).toBe("assistant");
      expect(result.uuid).toBe("msg-1");
      expect(result.message).toEqual({ content: "hello" });
    });
  });

  describe("SDK 0.2.76+ (agentId + isSidechain)", () => {
    it("marks messages with agentId + isSidechain as subagent", () => {
      const msg = {
        type: "stream_event",
        agentId: "a1dd713c82c78b9ed",
        isSidechain: true,
        event: { type: "message_start" },
      };
      const result = markSubagent(msg);
      expect(result.isSubagent).toBe(true);
      // New SDK does NOT set parentToolUseId
      expect(result.parentToolUseId).toBeUndefined();
    });

    it("does not mark when isSidechain is false", () => {
      const msg = {
        type: "stream_event",
        agentId: "a1dd713c82c78b9ed",
        isSidechain: false,
      };
      const result = markSubagent(msg);
      expect(result.isSubagent).toBeUndefined();
    });

    it("does not mark when agentId is null", () => {
      const msg = {
        type: "stream_event",
        agentId: null,
        isSidechain: true,
      };
      const result = markSubagent(msg);
      expect(result.isSubagent).toBeUndefined();
    });

    it("does not mark when agentId is missing", () => {
      const msg = {
        type: "stream_event",
        isSidechain: true,
      };
      const result = markSubagent(msg);
      expect(result.isSubagent).toBeUndefined();
    });
  });

  describe("non-subagent messages", () => {
    it("returns message unchanged when no subagent fields", () => {
      const msg = {
        type: "assistant",
        uuid: "msg-1",
        agentId: undefined,
        message: { content: "hello" },
      };
      const result = markSubagent(msg);
      expect(result.isSubagent).toBeUndefined();
      expect(result.parentToolUseId).toBeUndefined();
      expect(result).toEqual(msg);
    });

    it("returns message unchanged for main session stream events", () => {
      const msg = {
        type: "stream_event",
        agentId: undefined,
        event: { type: "content_block_delta" },
      };
      const result = markSubagent(msg);
      expect(result.isSubagent).toBeUndefined();
    });
  });

  describe("precedence", () => {
    it("prefers parent_tool_use_id over agentId when both present", () => {
      const msg = {
        type: "stream_event",
        parent_tool_use_id: "tool-legacy",
        agentId: "agent-new",
        isSidechain: true,
      };
      const result = markSubagent(msg);
      expect(result.isSubagent).toBe(true);
      expect(result.parentToolUseId).toBe("tool-legacy");
    });
  });
});
