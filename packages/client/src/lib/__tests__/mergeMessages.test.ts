import { describe, expect, it } from "vitest";
import type { Message } from "../../types";
import { getMessageId } from "@yep-anywhere/shared/transcript/message";
import {
  findMessageIndexById,
  getMessageContent,
  mergeJSONLMessages,
  mergeMessage,
  mergeStreamMessage,
} from "../mergeMessages";

describe("getMessageId", () => {
  it("returns uuid when present", () => {
    const msg: Message = { id: "legacy-id", uuid: "uuid-123" };
    expect(getMessageId(msg)).toBe("uuid-123");
  });

  it("returns id when uuid is undefined", () => {
    const msg: Message = { id: "legacy-id" };
    expect(getMessageId(msg)).toBe("legacy-id");
  });

  it("prefers uuid over id", () => {
    const msg: Message = { id: "legacy-id", uuid: "uuid-456" };
    expect(getMessageId(msg)).toBe("uuid-456");
  });

  it("handles temp messages (no uuid)", () => {
    const msg: Message = { id: "temp-1234567890" };
    expect(getMessageId(msg)).toBe("temp-1234567890");
  });
});

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

describe("findMessageIndexById", () => {
  it("finds the tail message without requiring callers to scan from the front", () => {
    const messages: Message[] = [
      { id: "msg-1" },
      { id: "msg-2" },
      { id: "msg-3" },
    ];

    expect(findMessageIndexById(messages, "msg-3")).toBe(2);
    expect(findMessageIndexById(messages, "msg-1")).toBe(0);
    expect(findMessageIndexById(messages, "missing")).toBe(-1);
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

    it("preserves SDK-only fields when merging with JSONL", () => {
      const existing: Message[] = [
        {
          id: "msg-1",
          uuid: "msg-1",
          content: "old",
          session_id: "session-123",
          _source: "sdk",
        } as Message,
      ];
      const incoming: Message[] = [
        {
          id: "msg-1",
          uuid: "msg-1",
          content: "new",
        },
      ];

      const result = mergeJSONLMessages(existing, incoming);

      expect(result.messages).toHaveLength(1);
      expect(result.messages[0]?.content).toBe("new");
      expect((result.messages[0] as Record<string, unknown>).session_id).toBe(
        "session-123",
      );
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

    it("does not duplicate messages with same ID", () => {
      const existing: Message[] = [
        { id: "msg-1", content: "first" },
        { id: "msg-2", content: "second" },
      ];
      const incoming: Message[] = [
        { id: "msg-1", content: "first updated" },
        { id: "msg-3", content: "third" },
      ];

      const result = mergeJSONLMessages(existing, incoming);

      expect(result.messages).toHaveLength(3);
      expect(result.messages[0]?.id).toBe("msg-1");
      expect(result.messages[0]?.content).toBe("first updated");
      expect(result.messages[1]?.id).toBe("msg-2");
      expect(result.messages[2]?.id).toBe("msg-3");
    });
  });

  describe("DAG reordering", () => {
    it("orders messages correctly when agent response arrives before user message", () => {
      // Simulate the race condition:
      // Tab 2 receives agent response via SSE before user message arrives via JSONL
      const existing: Message[] = [
        {
          id: "agent-1",
          type: "assistant",
          content: "Hello! How can I help?",
          parentUuid: "user-1", // Parent is user-1, which we haven't seen yet
          _source: "sdk",
        },
      ];
      const incoming: Message[] = [
        {
          id: "user-1",
          type: "user",
          message: { role: "user", content: "Hello" },
          parentUuid: null, // Root message
        },
      ];

      const result = mergeJSONLMessages(existing, incoming);

      // After merge + DAG ordering, user message should come first
      expect(result.messages).toHaveLength(2);
      expect(result.messages[0]?.id).toBe("user-1");
      expect(result.messages[1]?.id).toBe("agent-1");
    });

    it("orders longer conversation correctly when out of order", () => {
      // Multi-turn conversation with completely reversed order
      const existing: Message[] = [
        {
          id: "agent-2",
          type: "assistant",
          content: "Final response",
          parentUuid: "user-2",
          _source: "sdk",
        },
        {
          id: "user-2",
          type: "user",
          message: { role: "user", content: "Thanks" },
          parentUuid: "agent-1",
          _source: "sdk",
        },
        {
          id: "agent-1",
          type: "assistant",
          content: "First response",
          parentUuid: "user-1",
          _source: "sdk",
        },
      ];
      const incoming: Message[] = [
        {
          id: "user-1",
          type: "user",
          message: { role: "user", content: "Hello" },
          parentUuid: null,
        },
      ];

      const result = mergeJSONLMessages(existing, incoming);

      // Should be in conversation order
      expect(result.messages.map((m) => m.id)).toEqual([
        "user-1",
        "agent-1",
        "user-2",
        "agent-2",
      ]);
    });

    it("preserves order when already in correct order", () => {
      const existing: Message[] = [
        {
          id: "user-1",
          type: "user",
          message: { role: "user", content: "Hello" },
          parentUuid: null,
        },
        {
          id: "agent-1",
          type: "assistant",
          content: "Hi!",
          parentUuid: "user-1",
        },
      ];
      const incoming: Message[] = [
        {
          id: "user-2",
          type: "user",
          message: { role: "user", content: "Thanks" },
          parentUuid: "agent-1",
        },
      ];

      const result = mergeJSONLMessages(existing, incoming);

      // Order should be preserved
      expect(result.messages.map((m) => m.id)).toEqual([
        "user-1",
        "agent-1",
        "user-2",
      ]);
    });

    it("keeps a dead branch in file position across queued-send catch-up merges (task 024)", () => {
      // Modeled on a real Claude session where an api_error retry forked
      // the transcript at an `attachment` connector row: the dead branch
      // (assistant rows 185–198) and the live branch (system/api_error row
      // 201 → user 202 → ...) are both children of attachment row 184.
      const user183: Message = {
        uuid: "u183",
        type: "user",
        message: { role: "user", content: "queued pair delivered" },
        parentUuid: "a180",
      };
      const attachment184: Message = {
        uuid: "att184",
        type: "attachment",
        parentUuid: "u183",
      };
      const dead185: Message = {
        uuid: "a185",
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "…" }] },
        parentUuid: "att184",
      };
      const dead198: Message = {
        uuid: "a198",
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Restored and amended…" }],
        },
        parentUuid: "a185",
      };
      const system201: Message = {
        uuid: "sys201",
        type: "system",
        subtype: "api_error",
        parentUuid: "att184",
      };
      const user202: Message = {
        uuid: "u202",
        type: "user",
        message: { role: "user", content: "no, 'subagent-agnostic'…" },
        parentUuid: "sys201",
      };

      // Initial JSONL window already has the dead branch in file order
      let messages = mergeJSONLMessages(
        [],
        [user183, attachment184, dead185, dead198],
      ).messages;

      // Live stream: user echo + assistant rows arrive with real uuids but
      // no parentUuid (the stream does not carry JSONL linkage fields)
      messages = mergeStreamMessage(messages, {
        uuid: "u202",
        type: "user",
        message: { role: "user", content: "no, 'subagent-agnostic'…" },
      }).messages;
      messages = mergeStreamMessage(messages, {
        uuid: "a203",
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "ok" }] },
      }).messages;

      // JSONL catch-up that raced past sys201/u202 (cursor advanced by
      // streaming): only later rows arrive, chaining through the
      // stream-only row a203
      messages = mergeJSONLMessages(messages, [
        {
          uuid: "a204",
          type: "assistant",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "more" }],
          },
          parentUuid: "a203",
        },
      ]).messages;

      expect(messages.map((m) => m.uuid)).toEqual([
        "u183",
        "att184",
        "a185",
        "a198",
        "u202",
        "a203",
        "a204",
      ]);

      // A later catch-up delivers the full contiguous file suffix,
      // including the skipped connector row and JSONL linkage for the
      // streamed rows. The transcript must converge to exact file order:
      // dead branch between the attachment fork and the live branch.
      messages = mergeJSONLMessages(messages, [
        system201,
        user202,
        {
          uuid: "a203",
          type: "assistant",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "ok" }],
          },
          parentUuid: "u202",
        },
        {
          uuid: "a204",
          type: "assistant",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "more" }],
          },
          parentUuid: "a203",
        },
      ]).messages;

      expect(messages.map((m) => m.uuid)).toEqual([
        "u183",
        "att184",
        "a185",
        "a198",
        "sys201",
        "u202",
        "a203",
        "a204",
      ]);
    });

    it("prunes sdk-only Claude sibling messages when authoritative JSONL arrives", () => {
      const existing: Message[] = [
        {
          id: "user-1",
          uuid: "user-1",
          type: "user",
          message: { role: "user", content: "hello" },
          parentUuid: null,
          _source: "sdk",
        },
        {
          id: "thinking-1",
          uuid: "thinking-1",
          type: "assistant",
          message: {
            role: "assistant",
            content: [{ type: "thinking", thinking: "internal" }],
          },
          parentUuid: "user-1",
          _source: "sdk",
        },
        {
          id: "final-1",
          uuid: "final-1",
          type: "assistant",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "done" }],
          },
          parentUuid: "user-1",
          _source: "sdk",
        },
      ];
      const incoming: Message[] = [
        {
          id: "user-1",
          uuid: "user-1",
          type: "user",
          message: { role: "user", content: "hello" },
          parentUuid: null,
        },
        {
          id: "final-1",
          uuid: "final-1",
          type: "assistant",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "done" }],
          },
          parentUuid: "user-1",
        },
      ];

      const result = mergeJSONLMessages(existing, incoming);

      expect(result.messages.map((m) => m.uuid ?? m.id)).toEqual([
        "user-1",
        "final-1",
      ]);
      expect(result.messages[1]?._source).toBe("jsonl");
    });
  });
});

describe("mergeStreamMessage", () => {
  describe("same ID merge", () => {
    it("merges with existing message by ID", () => {
      const existing: Message[] = [
        { id: "msg-1", content: "old", _source: "sdk" },
      ];
      const incoming: Message = { id: "msg-1", content: "new" };

      const result = mergeStreamMessage(existing, incoming);

      expect(result.messages).toHaveLength(1);
      expect(result.messages[0]?.content).toBe("new");
      expect(result.index).toBe(0);
    });

    it("returns same array if no change", () => {
      const existing: Message[] = [
        { id: "msg-1", content: "same", _source: "jsonl" },
      ];
      const incoming: Message = { id: "msg-1", content: "different" };

      const result = mergeStreamMessage(existing, incoming);

      // JSONL is authoritative, so SDK doesn't overwrite
      expect(result.messages).toBe(existing);
    });

    it("retains the transcript identity for an equal SDK replacement", () => {
      const existingMessage: Message = {
        id: "msg-1",
        type: "assistant",
        message: { role: "assistant", content: "same" },
        _source: "sdk",
      };
      const existing = [existingMessage];

      const result = mergeStreamMessage(existing, {
        id: "msg-1",
        type: "assistant",
        message: { role: "assistant", content: "same" },
      });

      expect(result.messages).toBe(existing);
      expect(result.messages[0]).toBe(existingMessage);
    });
  });

  describe("adding new messages", () => {
    it("adds new message at end", () => {
      const existing: Message[] = [{ id: "msg-1", content: "first" }];
      const incoming: Message = { id: "msg-2", content: "second" };

      const result = mergeStreamMessage(existing, incoming);

      expect(result.messages).toHaveLength(2);
      expect(result.messages[1]?.id).toBe("msg-2");
      expect(result.messages[1]?._source).toBe("sdk");
      expect(result.index).toBe(1);
    });

    it("preserves all existing messages when adding new", () => {
      const existing: Message[] = [
        { id: "msg-1", content: "first" },
        { id: "msg-2", content: "second" },
      ];
      const incoming: Message = { id: "msg-3", content: "third" };

      const result = mergeStreamMessage(existing, incoming);

      expect(result.messages).toHaveLength(3);
      expect(result.messages[0]?.id).toBe("msg-1");
      expect(result.messages[1]?.id).toBe("msg-2");
      expect(result.messages[2]?.id).toBe("msg-3");
    });

    it("keeps an identified error when a following result has no id", () => {
      const existing: Message[] = [
        {
          uuid: "codex-error-turn-1",
          type: "error",
          error: "Selected model is at capacity.",
          _source: "sdk",
        },
      ];

      const result = mergeStreamMessage(existing, {
        type: "result",
      });

      expect(result.messages).toHaveLength(2);
      expect(result.messages[0]?.uuid).toBe("codex-error-turn-1");
      expect(result.messages[0]?.type).toBe("error");
      expect(result.messages[1]?.type).toBe("result");
    });

    it("suppresses replay-only Claude siblings when authoritative JSONL already exists", () => {
      const existing: Message[] = [
        {
          id: "user-1",
          uuid: "user-1",
          type: "user",
          message: { role: "user", content: "hello" },
          parentUuid: null,
          _source: "jsonl",
        },
        {
          id: "final-1",
          uuid: "final-1",
          type: "assistant",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "done" }],
          },
          parentUuid: "user-1",
          _source: "jsonl",
        },
      ];
      const incoming: Message = {
        id: "thinking-1",
        uuid: "thinking-1",
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "thinking", thinking: "internal" }],
        },
        parentUuid: "user-1",
        isReplay: true,
      };

      const result = mergeStreamMessage(existing, incoming);

      expect(result.messages).toBe(existing);
      expect(result.index).toBe(-1);
    });
  });

  describe("uuid preference", () => {
    it("matches by uuid when both id and uuid present", () => {
      const existing: Message[] = [
        { id: "old-id", uuid: "uuid-123", content: "old", _source: "sdk" },
      ];
      const incoming: Message = {
        id: "new-id",
        uuid: "uuid-123",
        content: "new",
      };

      const result = mergeStreamMessage(existing, incoming);

      // Should merge because uuid matches
      expect(result.messages).toHaveLength(1);
      expect(result.messages[0]?.content).toBe("new");
    });
  });
});
