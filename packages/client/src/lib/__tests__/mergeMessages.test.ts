import { describe, expect, it } from "vitest";
import type { Message } from "../../types";
import {
  getMessageContent,
  mergeJSONLMessages,
  mergeMessage,
  mergeSSEMessage,
} from "../mergeMessages";

describe("getMessageContent", () => {
  it("returns top-level content when present", () => {
    const msg: Message = { id: "1", content: "hello" };
    expect(getMessageContent(msg)).toBe("hello");
  });

  it("returns nested message.content when top-level is undefined", () => {
    const msg: Message = {
      id: "1",
      type: "user",
      message: { role: "user", content: "hello" },
    };
    expect(getMessageContent(msg)).toBe("hello");
  });

  it("prefers top-level content over nested", () => {
    const msg: Message = {
      id: "1",
      content: "top-level",
      message: { role: "user", content: "nested" },
    };
    expect(getMessageContent(msg)).toBe("top-level");
  });

  it("returns undefined when no content exists", () => {
    const msg: Message = { id: "1" };
    expect(getMessageContent(msg)).toBeUndefined();
  });
});

describe("mergeMessage", () => {
  it("returns incoming with source tag when no existing", () => {
    const incoming: Message = { id: "1", content: "hello" };
    const result = mergeMessage(undefined, incoming, "sdk");
    expect(result).toEqual({ id: "1", content: "hello", _source: "sdk" });
  });

  it("JSONL overwrites SDK fields", () => {
    const existing: Message = {
      id: "1",
      content: "sdk content",
      _source: "sdk",
    };
    const incoming: Message = { id: "1", content: "jsonl content" };
    const result = mergeMessage(existing, incoming, "jsonl");
    expect(result.content).toBe("jsonl content");
    expect(result._source).toBe("jsonl");
  });

  it("SDK does not overwrite JSONL", () => {
    const existing: Message = {
      id: "1",
      content: "jsonl content",
      _source: "jsonl",
    };
    const incoming: Message = { id: "1", content: "sdk content" };
    const result = mergeMessage(existing, incoming, "sdk");
    expect(result.content).toBe("jsonl content");
    expect(result._source).toBe("jsonl");
  });

  it("SDK overwrites existing SDK", () => {
    const existing: Message = {
      id: "1",
      content: "old sdk",
      _source: "sdk",
    };
    const incoming: Message = { id: "1", content: "new sdk" };
    const result = mergeMessage(existing, incoming, "sdk");
    expect(result.content).toBe("new sdk");
    expect(result._source).toBe("sdk");
  });
});

describe("mergeJSONLMessages", () => {
  describe("temp message deduplication", () => {
    it("replaces temp message with matching JSONL message", () => {
      const existing: Message[] = [
        {
          id: "temp-123",
          type: "user",
          message: { role: "user", content: "hello" },
        },
      ];
      const incoming: Message[] = [
        {
          id: "real-uuid",
          type: "user",
          message: { role: "user", content: "hello" },
        },
      ];

      const result = mergeJSONLMessages(existing, incoming);

      expect(result.messages).toHaveLength(1);
      expect(result.messages[0]?.id).toBe("real-uuid");
      expect(result.replacedIds.has("temp-123")).toBe(true);
    });

    it("preserves position when replacing temp message", () => {
      const existing: Message[] = [
        {
          id: "temp-123",
          type: "user",
          message: { role: "user", content: "hello" },
        },
        {
          id: "assistant-1",
          role: "assistant",
          content: [{ type: "text", text: "response" }],
        },
      ];
      const incoming: Message[] = [
        {
          id: "real-uuid",
          type: "user",
          message: { role: "user", content: "hello" },
        },
      ];

      const result = mergeJSONLMessages(existing, incoming);

      expect(result.messages).toHaveLength(2);
      expect(result.messages[0]?.id).toBe("real-uuid"); // User message stays first
      expect(result.messages[1]?.id).toBe("assistant-1"); // Assistant stays second
    });

    it("does not match non-user messages", () => {
      const existing: Message[] = [
        {
          id: "temp-123",
          type: "assistant",
          content: [{ type: "text", text: "hello" }],
        },
      ];
      const incoming: Message[] = [
        {
          id: "real-uuid",
          type: "assistant",
          content: [{ type: "text", text: "hello" }],
        },
      ];

      const result = mergeJSONLMessages(existing, incoming);

      // Both should exist since assistant messages aren't deduplicated by content
      expect(result.messages).toHaveLength(2);
    });
  });

  describe("SDK message deduplication", () => {
    it("replaces SDK-sourced message with matching JSONL message", () => {
      const existing: Message[] = [
        {
          id: "sdk-uuid-1",
          type: "user",
          message: { role: "user", content: "hello" },
          _source: "sdk",
        },
      ];
      const incoming: Message[] = [
        {
          id: "jsonl-uuid",
          type: "user",
          message: { role: "user", content: "hello" },
        },
      ];

      const result = mergeJSONLMessages(existing, incoming);

      expect(result.messages).toHaveLength(1);
      expect(result.messages[0]?.id).toBe("jsonl-uuid");
      expect(result.replacedIds.has("sdk-uuid-1")).toBe(true);
    });
  });

  describe("collision prevention", () => {
    it("does not match same message twice for different JSONL messages", () => {
      const existing: Message[] = [
        {
          id: "temp-1",
          type: "user",
          message: { role: "user", content: "hello" },
        },
        {
          id: "temp-2",
          type: "user",
          message: { role: "user", content: "hello" },
        },
      ];
      const incoming: Message[] = [
        {
          id: "real-1",
          type: "user",
          message: { role: "user", content: "hello" },
        },
        {
          id: "real-2",
          type: "user",
          message: { role: "user", content: "hello" },
        },
      ];

      const result = mergeJSONLMessages(existing, incoming);

      // Each JSONL message should match a different temp message
      expect(result.messages).toHaveLength(2);
      expect(result.replacedIds.size).toBe(2);
      const ids = result.messages.map((m) => m.id);
      expect(ids).toContain("real-1");
      expect(ids).toContain("real-2");
    });
  });

  describe("merging by ID", () => {
    it("merges existing message by ID", () => {
      const existing: Message[] = [
        {
          id: "msg-1",
          content: "old",
          _source: "sdk",
        },
      ];
      const incoming: Message[] = [
        {
          id: "msg-1",
          content: "new",
          extra: "field",
        } as Message,
      ];

      const result = mergeJSONLMessages(existing, incoming);

      expect(result.messages).toHaveLength(1);
      expect(result.messages[0]?.content).toBe("new");
      expect(result.messages[0]?._source).toBe("jsonl");
    });
  });

  describe("adding new messages", () => {
    it("appends new messages at end", () => {
      const existing: Message[] = [{ id: "msg-1", content: "first" }];
      const incoming: Message[] = [{ id: "msg-2", content: "second" }];

      const result = mergeJSONLMessages(existing, incoming);

      expect(result.messages).toHaveLength(2);
      expect(result.messages[0]?.id).toBe("msg-1");
      expect(result.messages[1]?.id).toBe("msg-2");
    });
  });
});

describe("mergeSSEMessage", () => {
  describe("same ID merge", () => {
    it("merges with existing message by ID", () => {
      const existing: Message[] = [
        { id: "msg-1", content: "old", _source: "sdk" },
      ];
      const incoming: Message = { id: "msg-1", content: "new" };

      const result = mergeSSEMessage(existing, incoming);

      expect(result.messages).toHaveLength(1);
      expect(result.messages[0]?.content).toBe("new");
      expect(result.replacedTemp).toBe(false);
      expect(result.index).toBe(0);
    });

    it("returns same array if no change", () => {
      const existing: Message[] = [
        { id: "msg-1", content: "same", _source: "jsonl" },
      ];
      const incoming: Message = { id: "msg-1", content: "different" };

      const result = mergeSSEMessage(existing, incoming);

      // JSONL is authoritative, so SDK doesn't overwrite
      expect(result.messages).toBe(existing);
    });
  });

  describe("temp message replacement", () => {
    it("replaces temp message for user messages", () => {
      const existing: Message[] = [
        {
          id: "temp-123",
          type: "user",
          message: { role: "user", content: "hello" },
        },
      ];
      const incoming: Message = {
        id: "real-uuid",
        type: "user",
        message: { role: "user", content: "hello" },
      };

      const result = mergeSSEMessage(existing, incoming);

      expect(result.messages).toHaveLength(1);
      expect(result.messages[0]?.id).toBe("real-uuid");
      expect(result.replacedTemp).toBe(true);
      expect(result.index).toBe(0);
    });

    it("preserves existing fields when replacing temp", () => {
      const existing: Message[] = [
        {
          id: "temp-123",
          type: "user",
          message: { role: "user", content: "hello" },
          timestamp: "2024-01-01T00:00:00Z",
        },
      ];
      const incoming: Message = {
        id: "real-uuid",
        type: "user",
        message: { role: "user", content: "hello" },
        // No timestamp in incoming
      };

      const result = mergeSSEMessage(existing, incoming);

      expect(result.messages[0]?.timestamp).toBe("2024-01-01T00:00:00Z");
      expect(result.messages[0]?.id).toBe("real-uuid");
    });
  });

  describe("adding new messages", () => {
    it("adds new message at end", () => {
      const existing: Message[] = [{ id: "msg-1", content: "first" }];
      const incoming: Message = { id: "msg-2", content: "second" };

      const result = mergeSSEMessage(existing, incoming);

      expect(result.messages).toHaveLength(2);
      expect(result.messages[1]?.id).toBe("msg-2");
      expect(result.messages[1]?._source).toBe("sdk");
      expect(result.replacedTemp).toBe(false);
      expect(result.index).toBe(1);
    });
  });
});

describe("parent-aware matching", () => {
  describe("mergeJSONLMessages with parents", () => {
    it("matches temp message when parents match", () => {
      const existing: Message[] = [
        { id: "msg-1", type: "assistant", content: "first response" },
        {
          id: "temp-1",
          type: "user",
          message: { role: "user", content: "hello" },
          parentUuid: "msg-1",
        },
      ];
      const incoming: Message[] = [
        {
          id: "real-1",
          type: "user",
          message: { role: "user", content: "hello" },
          parentUuid: "msg-1",
        },
      ];

      const result = mergeJSONLMessages(existing, incoming);

      expect(result.messages).toHaveLength(2);
      expect(result.messages[1]?.id).toBe("real-1");
      expect(result.newMappings.get("temp-1")).toBe("real-1");
    });

    it("does not match temp message when parents differ", () => {
      const existing: Message[] = [
        { id: "msg-1", type: "assistant", content: "first response" },
        { id: "msg-2", type: "assistant", content: "second response" },
        {
          id: "temp-1",
          type: "user",
          message: { role: "user", content: "hello" },
          parentUuid: "msg-1", // Parent is msg-1
        },
      ];
      const incoming: Message[] = [
        {
          id: "real-1",
          type: "user",
          message: { role: "user", content: "hello" },
          parentUuid: "msg-2", // Parent is msg-2 (different!)
        },
      ];

      const result = mergeJSONLMessages(existing, incoming);

      // Both should exist - no match due to different parents
      expect(result.messages).toHaveLength(4);
      expect(result.messages.map((m) => m.id)).toContain("temp-1");
      expect(result.messages.map((m) => m.id)).toContain("real-1");
    });

    it("resolves temp parent IDs when matching", () => {
      // Scenario: user sends "hello" then "hello" again quickly
      // First temp is replaced, second temp's parent (the first temp) should resolve
      const tempIdMappings = new Map([["temp-1", "real-1"]]);

      const existing: Message[] = [
        {
          id: "real-1", // Already replaced from temp-1
          type: "user",
          message: { role: "user", content: "hello" },
          parentUuid: null,
          _source: "jsonl",
        },
        {
          id: "temp-2",
          type: "user",
          message: { role: "user", content: "hello" },
          parentUuid: "temp-1", // Points to temp-1, which maps to real-1
        },
      ];
      const incoming: Message[] = [
        {
          id: "real-2",
          type: "user",
          message: { role: "user", content: "hello" },
          parentUuid: "real-1", // Parent is real-1
        },
      ];

      const result = mergeJSONLMessages(existing, incoming, tempIdMappings);

      // temp-2 should match real-2 because temp-1 resolves to real-1
      expect(result.messages).toHaveLength(2);
      expect(result.messages[1]?.id).toBe("real-2");
      expect(result.newMappings.get("temp-2")).toBe("real-2");
    });

    it("chains multiple identical messages correctly", () => {
      // User sends "retry" 3 times quickly
      const existing: Message[] = [
        { id: "assistant-1", type: "assistant", content: "I failed" },
        {
          id: "temp-1",
          type: "user",
          message: { role: "user", content: "retry" },
          parentUuid: "assistant-1",
        },
        {
          id: "temp-2",
          type: "user",
          message: { role: "user", content: "retry" },
          parentUuid: "temp-1",
        },
        {
          id: "temp-3",
          type: "user",
          message: { role: "user", content: "retry" },
          parentUuid: "temp-2",
        },
      ];
      const incoming: Message[] = [
        {
          id: "real-1",
          type: "user",
          message: { role: "user", content: "retry" },
          parentUuid: "assistant-1",
        },
        {
          id: "real-2",
          type: "user",
          message: { role: "user", content: "retry" },
          parentUuid: "real-1",
        },
        {
          id: "real-3",
          type: "user",
          message: { role: "user", content: "retry" },
          parentUuid: "real-2",
        },
      ];

      const result = mergeJSONLMessages(existing, incoming);

      // All temps should be replaced
      expect(result.messages).toHaveLength(4);
      expect(result.messages.map((m) => m.id)).toEqual([
        "assistant-1",
        "real-1",
        "real-2",
        "real-3",
      ]);
      expect(result.newMappings.size).toBe(3);
    });
  });

  describe("mergeSSEMessage with parents", () => {
    it("matches temp message when parents match", () => {
      const existing: Message[] = [
        { id: "msg-1", type: "assistant", content: "response" },
        {
          id: "temp-1",
          type: "user",
          message: { role: "user", content: "hello" },
          parentUuid: "msg-1",
        },
      ];
      const incoming: Message = {
        id: "real-1",
        type: "user",
        message: { role: "user", content: "hello" },
        parentUuid: "msg-1",
      };

      const result = mergeSSEMessage(existing, incoming);

      expect(result.messages).toHaveLength(2);
      expect(result.messages[1]?.id).toBe("real-1");
      expect(result.replacedTemp).toBe(true);
      expect(result.replacedTempId).toBe("temp-1");
    });

    it("does not match temp message when parents differ", () => {
      const existing: Message[] = [
        { id: "msg-1", type: "assistant", content: "response 1" },
        { id: "msg-2", type: "assistant", content: "response 2" },
        {
          id: "temp-1",
          type: "user",
          message: { role: "user", content: "hello" },
          parentUuid: "msg-1",
        },
      ];
      const incoming: Message = {
        id: "real-1",
        type: "user",
        message: { role: "user", content: "hello" },
        parentUuid: "msg-2", // Different parent
      };

      const result = mergeSSEMessage(existing, incoming);

      // temp-1 should NOT be replaced, incoming should be added
      expect(result.messages).toHaveLength(4);
      expect(result.replacedTemp).toBe(false);
      expect(result.replacedTempId).toBeNull();
    });

    it("resolves temp parent IDs using mappings", () => {
      const tempIdMappings = new Map([["temp-1", "real-1"]]);

      const existing: Message[] = [
        {
          id: "real-1",
          type: "user",
          message: { role: "user", content: "first" },
          _source: "sdk",
        },
        {
          id: "temp-2",
          type: "user",
          message: { role: "user", content: "second" },
          parentUuid: "temp-1", // Will resolve to real-1
        },
      ];
      const incoming: Message = {
        id: "real-2",
        type: "user",
        message: { role: "user", content: "second" },
        parentUuid: "real-1",
      };

      const result = mergeSSEMessage(existing, incoming, tempIdMappings);

      expect(result.messages).toHaveLength(2);
      expect(result.messages[1]?.id).toBe("real-2");
      expect(result.replacedTemp).toBe(true);
      expect(result.replacedTempId).toBe("temp-2");
    });

    it("matches temp even when SSE message has no parentUuid (single temp)", () => {
      // SSE messages from SDK often don't include parentUuid
      // Should match when there's exactly ONE temp with the same content
      const existing: Message[] = [
        { id: "msg-1", type: "assistant", content: "response" },
        {
          id: "temp-1",
          type: "user",
          message: { role: "user", content: "hello" },
          parentUuid: "msg-1", // Temp has parent set
        },
      ];
      const incoming: Message = {
        id: "real-1",
        type: "user",
        message: { role: "user", content: "hello" },
        // No parentUuid - SSE from SDK doesn't include it
      };

      const result = mergeSSEMessage(existing, incoming);

      // Should match based on content when there's only one candidate
      expect(result.messages).toHaveLength(2);
      expect(result.messages[1]?.id).toBe("real-1");
      expect(result.replacedTemp).toBe(true);
      expect(result.replacedTempId).toBe("temp-1");
    });

    it("does NOT match when multiple temps have same content and SSE has no parentUuid", () => {
      // This prevents replayed SSE messages from incorrectly matching newer temps
      // Scenario: user sends "test 123" twice, SSE for first one replays
      const existing: Message[] = [
        { id: "msg-1", type: "assistant", content: "response 1" },
        {
          id: "temp-1",
          type: "user",
          message: { role: "user", content: "test 123" },
          parentUuid: "msg-1",
        },
        { id: "msg-2", type: "assistant", content: "response 2" },
        {
          id: "temp-2",
          type: "user",
          message: { role: "user", content: "test 123" }, // Same content!
          parentUuid: "msg-2",
        },
      ];
      const incoming: Message = {
        id: "real-1",
        type: "user",
        message: { role: "user", content: "test 123" },
        // No parentUuid - can't tell which temp it matches
      };

      const result = mergeSSEMessage(existing, incoming);

      // Should NOT replace any temp - ambiguous which one to match
      // Let JSONL (which has parentUuid) handle the dedup later
      expect(result.messages).toHaveLength(5); // Original 4 + new message
      expect(result.replacedTemp).toBe(false);
      expect(result.replacedTempId).toBeNull();
      // Both temps should still exist
      expect(result.messages.some((m) => m.id === "temp-1")).toBe(true);
      expect(result.messages.some((m) => m.id === "temp-2")).toBe(true);
    });

    it("matches correct temp when SSE has parentUuid even with multiple same-content temps", () => {
      // When parentUuid IS provided, we can correctly identify which temp to replace
      const existing: Message[] = [
        { id: "msg-1", type: "assistant", content: "response 1" },
        {
          id: "temp-1",
          type: "user",
          message: { role: "user", content: "test 123" },
          parentUuid: "msg-1",
        },
        { id: "msg-2", type: "assistant", content: "response 2" },
        {
          id: "temp-2",
          type: "user",
          message: { role: "user", content: "test 123" }, // Same content
          parentUuid: "msg-2",
        },
      ];
      const incoming: Message = {
        id: "real-1",
        type: "user",
        message: { role: "user", content: "test 123" },
        parentUuid: "msg-1", // Explicitly targets first temp's parent
      };

      const result = mergeSSEMessage(existing, incoming);

      // Should replace temp-1 specifically
      expect(result.messages).toHaveLength(4);
      expect(result.replacedTemp).toBe(true);
      expect(result.replacedTempId).toBe("temp-1");
      expect(result.messages[1]?.id).toBe("real-1");
      // temp-2 should still exist
      expect(result.messages.some((m) => m.id === "temp-2")).toBe(true);
    });
  });
});
