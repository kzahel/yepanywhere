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
