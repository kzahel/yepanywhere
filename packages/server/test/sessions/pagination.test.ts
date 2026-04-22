import { describe, expect, it } from "vitest";
import {
  type PaginationInfo,
  sliceAtCompactBoundaries,
  sliceLastMessages,
} from "../../src/sessions/pagination.js";
import type { Message } from "../../src/supervisor/types.js";

/** Helper to create a minimal message */
function msg(type: string, uuid: string, subtype?: string): Message {
  return { type, uuid, ...(subtype && { subtype }) } as Message;
}

/** Helper to create a compact_boundary message */
function compactBoundary(uuid: string): Message {
  return msg("system", uuid, "compact_boundary");
}

describe("sliceLastMessages", () => {
  it("returns all messages when total is within limit", () => {
    const messages = [msg("user", "u1"), msg("assistant", "a1")];

    const result = sliceLastMessages(messages, 20);

    expect(result.messages).toEqual(messages);
    expect(result.pagination).toEqual({
      hasOlderMessages: false,
      totalMessageCount: 2,
      returnedMessageCount: 2,
      truncatedBeforeMessageId: undefined,
      totalCompactions: 0,
    } satisfies PaginationInfo);
  });

  it("returns only the latest N messages", () => {
    const messages = [
      msg("user", "u1"),
      msg("assistant", "a1"),
      compactBoundary("cb1"),
      msg("user", "u2"),
      msg("assistant", "a2"),
    ];

    const result = sliceLastMessages(messages, 3);

    expect(result.messages.map((message) => message.uuid)).toEqual([
      "cb1",
      "u2",
      "a2",
    ]);
    expect(result.pagination).toEqual({
      hasOlderMessages: true,
      totalMessageCount: 5,
      returnedMessageCount: 3,
      truncatedBeforeMessageId: "cb1",
      totalCompactions: 1,
    } satisfies PaginationInfo);
  });

  it("supports beforeMessageId cursor for loading older message chunks", () => {
    const messages = [
      msg("user", "u1"),
      msg("assistant", "a1"),
      compactBoundary("cb1"),
      msg("user", "u2"),
      msg("assistant", "a2"),
      msg("user", "u3"),
    ];

    const first = sliceLastMessages(messages, 2);
    expect(first.messages.map((message) => message.uuid)).toEqual(["a2", "u3"]);
    expect(first.pagination.truncatedBeforeMessageId).toBe("a2");

    const second = sliceLastMessages(
      messages,
      2,
      first.pagination.truncatedBeforeMessageId,
    );
    expect(second.messages.map((message) => message.uuid)).toEqual([
      "cb1",
      "u2",
    ]);
    expect(second.pagination.truncatedBeforeMessageId).toBe("cb1");
    expect(second.pagination.hasOlderMessages).toBe(true);
  });

  it("returns all remaining messages when older chunk is smaller than limit", () => {
    const messages = [
      msg("user", "u1"),
      msg("assistant", "a1"),
      msg("user", "u2"),
      msg("assistant", "a2"),
    ];

    const result = sliceLastMessages(messages, 20, "u2");

    expect(result.messages.map((message) => message.uuid)).toEqual([
      "u1",
      "a1",
    ]);
    expect(result.pagination.hasOlderMessages).toBe(false);
    expect(result.pagination.totalMessageCount).toBe(4);
    expect(result.pagination.returnedMessageCount).toBe(2);
  });

  it("gracefully handles beforeMessageId not found", () => {
    const messages = [
      msg("user", "u1"),
      compactBoundary("cb1"),
      msg("assistant", "a1"),
    ];

    const result = sliceLastMessages(messages, 2, "nonexistent");

    expect(result.messages.map((message) => message.uuid)).toEqual([
      "cb1",
      "a1",
    ]);
    expect(result.pagination.hasOlderMessages).toBe(true);
    expect(result.pagination.truncatedBeforeMessageId).toBe("cb1");
  });
});

describe("sliceAtCompactBoundaries", () => {
  it("returns all messages when no compactions exist", () => {
    const messages = [
      msg("user", "u1"),
      msg("assistant", "a1"),
      msg("user", "u2"),
      msg("assistant", "a2"),
    ];

    const result = sliceAtCompactBoundaries(messages, 2);

    expect(result.messages).toEqual(messages);
    expect(result.pagination).toEqual({
      hasOlderMessages: false,
      totalMessageCount: 4,
      returnedMessageCount: 4,
      truncatedBeforeMessageId: undefined,
      totalCompactions: 0,
    } satisfies PaginationInfo);
  });

  it("returns all messages when fewer compactions than requested", () => {
    const messages = [
      msg("user", "u1"),
      compactBoundary("cb1"),
      msg("assistant", "a1"),
    ];

    const result = sliceAtCompactBoundaries(messages, 2);

    expect(result.messages).toEqual(messages);
    expect(result.pagination.hasOlderMessages).toBe(false);
    expect(result.pagination.totalCompactions).toBe(1);
    expect(result.pagination.returnedMessageCount).toBe(3);
  });

  it("returns all messages when compactions equal requested count", () => {
    const messages = [
      compactBoundary("cb1"),
      msg("user", "u1"),
      compactBoundary("cb2"),
      msg("assistant", "a1"),
    ];

    const result = sliceAtCompactBoundaries(messages, 2);

    expect(result.messages).toEqual(messages);
    expect(result.pagination.hasOlderMessages).toBe(false);
    expect(result.pagination.totalCompactions).toBe(2);
  });

  it("truncates to last N compactions", () => {
    const messages = [
      msg("user", "u1"), // 0 - truncated
      compactBoundary("cb1"), // 1 - truncated
      msg("assistant", "a1"), // 2 - truncated
      msg("user", "u2"), // 3 - truncated
      compactBoundary("cb2"), // 4 - truncated
      msg("assistant", "a2"), // 5 - truncated
      compactBoundary("cb3"), // 6 - truncated
      msg("user", "u3"), // 7 - truncated
      compactBoundary("cb4"), // 8 - included (boundary starts here)
      msg("assistant", "a3"), // 9 - included
      compactBoundary("cb5"), // 10 - included
      msg("user", "u4"), // 11 - included
      msg("assistant", "a4"), // 12 - included
    ];

    const result = sliceAtCompactBoundaries(messages, 2);

    expect(result.messages.length).toBe(5);
    expect(result.messages[0]).toEqual(compactBoundary("cb4"));
    expect(result.messages[4]).toEqual(msg("assistant", "a4"));
    expect(result.pagination).toEqual({
      hasOlderMessages: true,
      totalMessageCount: 13,
      returnedMessageCount: 5,
      truncatedBeforeMessageId: "cb4",
      totalCompactions: 5,
    } satisfies PaginationInfo);
  });

  it("handles tailCompactions=1", () => {
    const messages = [
      msg("user", "u1"),
      compactBoundary("cb1"),
      msg("assistant", "a1"),
      compactBoundary("cb2"),
      msg("user", "u2"),
    ];

    const result = sliceAtCompactBoundaries(messages, 1);

    expect(result.messages.length).toBe(2);
    expect(result.messages[0]).toEqual(compactBoundary("cb2"));
    expect(result.messages[1]).toEqual(msg("user", "u2"));
    expect(result.pagination.hasOlderMessages).toBe(true);
    expect(result.pagination.truncatedBeforeMessageId).toBe("cb2");
  });

  it("supports beforeMessageId cursor for loading older chunks", () => {
    const messages = [
      msg("user", "u1"), // 0
      compactBoundary("cb1"), // 1
      msg("assistant", "a1"), // 2
      compactBoundary("cb2"), // 3
      msg("user", "u2"), // 4
      compactBoundary("cb3"), // 5 - beforeMessageId points here
      msg("assistant", "a2"), // 6
    ];

    // Load the chunk before cb3 with tailCompactions=1
    const result = sliceAtCompactBoundaries(messages, 1, "cb3");

    // Working set is messages[0..4], last boundary is cb2
    expect(result.messages.length).toBe(2);
    expect(result.messages[0]).toEqual(compactBoundary("cb2"));
    expect(result.messages[1]).toEqual(msg("user", "u2"));
    expect(result.pagination.hasOlderMessages).toBe(true);
    expect(result.pagination.truncatedBeforeMessageId).toBe("cb2");
  });

  it("returns all remaining when cursor chunk has no compactions", () => {
    const messages = [
      msg("user", "u1"),
      msg("assistant", "a1"),
      compactBoundary("cb1"),
      msg("user", "u2"),
    ];

    // Load chunk before cb1
    const result = sliceAtCompactBoundaries(messages, 2, "cb1");

    // Working set is [u1, a1], no compactions -> return all
    expect(result.messages.length).toBe(2);
    expect(result.messages[0]).toEqual(msg("user", "u1"));
    expect(result.pagination.hasOlderMessages).toBe(false);
  });

  it("handles single message session", () => {
    const messages = [msg("user", "u1")];
    const result = sliceAtCompactBoundaries(messages, 2);

    expect(result.messages).toEqual(messages);
    expect(result.pagination.hasOlderMessages).toBe(false);
    expect(result.pagination.totalMessageCount).toBe(1);
  });

  it("handles empty message array", () => {
    const result = sliceAtCompactBoundaries([], 2);

    expect(result.messages).toEqual([]);
    expect(result.pagination.hasOlderMessages).toBe(false);
    expect(result.pagination.totalMessageCount).toBe(0);
  });

  it("works with Codex-style linear sessions (no DAG)", () => {
    // Codex sessions have the same compact_boundary subtype after normalization
    const messages = [
      msg("user", "u1"),
      msg("assistant", "a1"),
      {
        type: "system",
        uuid: "cb1",
        subtype: "compact_boundary",
        content: "Context compacted",
      } as Message,
      msg("user", "u2"),
      msg("assistant", "a2"),
      {
        type: "system",
        uuid: "cb2",
        subtype: "compact_boundary",
        content: "Context compacted",
      } as Message,
      msg("user", "u3"),
      msg("assistant", "a3"),
      {
        type: "system",
        uuid: "cb3",
        subtype: "compact_boundary",
        content: "Context compacted",
      } as Message,
      msg("user", "u4"),
    ];

    const result = sliceAtCompactBoundaries(messages, 2);

    // cb2, u3, a3, cb3, u4 = 5 messages from 2nd-to-last boundary onward
    expect(result.messages.length).toBe(5);
    expect(result.messages[0]?.uuid).toBe("cb2");
    expect(result.messages[4]?.uuid).toBe("u4");
    expect(result.pagination.hasOlderMessages).toBe(true);
    expect(result.pagination.totalCompactions).toBe(3);
  });

  it("gracefully handles beforeMessageId not found", () => {
    const messages = [
      msg("user", "u1"),
      compactBoundary("cb1"),
      msg("assistant", "a1"),
    ];

    // Non-existent ID -> falls back to all messages
    const result = sliceAtCompactBoundaries(messages, 2, "nonexistent");

    expect(result.messages).toEqual(messages);
    expect(result.pagination.hasOlderMessages).toBe(false);
  });

  it("progressive loading: loads all messages across multiple fetches", () => {
    const messages = [
      msg("user", "u0"), // pre-compaction content
      compactBoundary("cb1"),
      msg("assistant", "a1"),
      compactBoundary("cb2"),
      msg("user", "u2"),
      compactBoundary("cb3"),
      msg("assistant", "a3"),
      compactBoundary("cb4"),
      msg("user", "u4"),
      msg("assistant", "a4"),
    ];

    // First load: tail 2 compactions
    // cb3, a3, cb4, u4, a4 = 5 messages from cb3 onward
    const first = sliceAtCompactBoundaries(messages, 2);
    expect(first.pagination.hasOlderMessages).toBe(true);
    expect(first.messages[0]?.uuid).toBe("cb3");
    expect(first.messages.length).toBe(5);

    // Second load: 2 compactions before cb3
    // Working set: u0, cb1, a1, cb2, u2 (5 messages, 2 compactions = all returned)
    const second = sliceAtCompactBoundaries(
      messages,
      2,
      first.pagination.truncatedBeforeMessageId,
    );
    expect(second.pagination.hasOlderMessages).toBe(false);
    expect(second.messages[0]?.uuid).toBe("u0");
    expect(second.messages.length).toBe(5);

    // Together they cover all messages
    const allLoaded = [...second.messages, ...first.messages];
    expect(allLoaded.length).toBe(messages.length);
  });

  it("ignores system messages with other subtypes", () => {
    const messages = [
      msg("user", "u1"),
      msg("system", "s1", "init"),
      msg("system", "s2", "status"),
      compactBoundary("cb1"),
      msg("assistant", "a1"),
      compactBoundary("cb2"),
      msg("user", "u2"),
    ];

    const result = sliceAtCompactBoundaries(messages, 1);

    // Only cb2 counted as last compaction
    expect(result.messages.length).toBe(2);
    expect(result.messages[0]?.uuid).toBe("cb2");
    expect(result.pagination.totalCompactions).toBe(2);
    expect(result.pagination.hasOlderMessages).toBe(true);
  });
});
