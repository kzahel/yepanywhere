import { describe, expect, it } from "vitest";
import {
  type RawSessionMessage,
  buildDag,
  findOrphanedToolUses,
} from "../../src/sessions/dag.js";

describe("buildDag", () => {
  it("builds linear chain correctly", () => {
    const messages: RawSessionMessage[] = [
      { type: "user", uuid: "a", parentUuid: null },
      { type: "assistant", uuid: "b", parentUuid: "a" },
      { type: "user", uuid: "c", parentUuid: "b" },
    ];

    const result = buildDag(messages);

    expect(result.activeBranch.map((n) => n.uuid)).toEqual(["a", "b", "c"]);
    expect(result.tip?.uuid).toBe("c");
    expect(result.activeBranchUuids.size).toBe(3);
  });

  it("filters dead branches, keeping latest tip", () => {
    // Structure:
    // a -> b -> c (dead branch, earlier lineIndex for tip)
    //   \-> d -> e (active branch, tip at lineIndex 4)
    const messages: RawSessionMessage[] = [
      { type: "user", uuid: "a", parentUuid: null },
      { type: "assistant", uuid: "b", parentUuid: "a" },
      { type: "user", uuid: "c", parentUuid: "b" }, // dead branch tip at index 2
      { type: "assistant", uuid: "d", parentUuid: "a" }, // branch from a
      { type: "user", uuid: "e", parentUuid: "d" }, // active tip at index 4
    ];

    const result = buildDag(messages);

    expect(result.activeBranch.map((n) => n.uuid)).toEqual(["a", "d", "e"]);
    expect(result.tip?.uuid).toBe("e");
    expect(result.activeBranchUuids.has("b")).toBe(false);
    expect(result.activeBranchUuids.has("c")).toBe(false);
  });

  it("handles messages without uuid (internal types)", () => {
    const messages: RawSessionMessage[] = [
      { type: "queue-operation" }, // no uuid - skipped
      { type: "user", uuid: "a", parentUuid: null },
      { type: "file-history-snapshot" }, // no uuid - skipped
      { type: "assistant", uuid: "b", parentUuid: "a" },
    ];

    const result = buildDag(messages);

    expect(result.activeBranch.map((n) => n.uuid)).toEqual(["a", "b"]);
  });

  it("selects latest tip when multiple tips exist", () => {
    // Two independent chains (two roots)
    const messages: RawSessionMessage[] = [
      { type: "user", uuid: "a", parentUuid: null }, // chain 1 root
      { type: "assistant", uuid: "b", parentUuid: "a" }, // chain 1 tip at index 1
      { type: "user", uuid: "x", parentUuid: null }, // chain 2 root
      { type: "assistant", uuid: "y", parentUuid: "x" }, // chain 2 tip at index 3
    ];

    const result = buildDag(messages);

    // Should select chain 2 (tip y at index 3 > tip b at index 1)
    expect(result.tip?.uuid).toBe("y");
    expect(result.activeBranch.map((n) => n.uuid)).toEqual(["x", "y"]);
  });

  it("handles empty input", () => {
    const result = buildDag([]);

    expect(result.activeBranch).toEqual([]);
    expect(result.tip).toBeNull();
    expect(result.activeBranchUuids.size).toBe(0);
  });

  it("handles single message", () => {
    const messages: RawSessionMessage[] = [
      { type: "user", uuid: "a", parentUuid: null },
    ];

    const result = buildDag(messages);

    expect(result.activeBranch.map((n) => n.uuid)).toEqual(["a"]);
    expect(result.tip?.uuid).toBe("a");
  });

  it("handles broken parentUuid chain gracefully", () => {
    // Message b references non-existent parent
    const messages: RawSessionMessage[] = [
      { type: "user", uuid: "a", parentUuid: null },
      { type: "assistant", uuid: "b", parentUuid: "nonexistent" },
      { type: "user", uuid: "c", parentUuid: "a" }, // continues from a
    ];

    const result = buildDag(messages);

    // b is orphaned (references nonexistent parent), so its chain stops
    // c at index 2 is later than b at index 1, so c's chain is selected
    expect(result.tip?.uuid).toBe("c");
    expect(result.activeBranch.map((n) => n.uuid)).toEqual(["a", "c"]);
  });

  it("preserves lineIndex in nodes", () => {
    const messages: RawSessionMessage[] = [
      { type: "queue-operation" }, // index 0, skipped
      { type: "user", uuid: "a", parentUuid: null }, // index 1
      { type: "file-history-snapshot" }, // index 2, skipped
      { type: "assistant", uuid: "b", parentUuid: "a" }, // index 3
    ];

    const result = buildDag(messages);

    expect(result.activeBranch[0]?.lineIndex).toBe(1);
    expect(result.activeBranch[1]?.lineIndex).toBe(3);
  });
});

describe("findOrphanedToolUses", () => {
  it("identifies tool_use without matching tool_result", () => {
    const activeBranch = buildDag([
      {
        type: "assistant",
        uuid: "a",
        parentUuid: null,
        message: {
          content: [{ type: "tool_use", id: "tool-1" }],
        },
      },
      {
        type: "user",
        uuid: "b",
        parentUuid: "a",
        message: {
          content: [{ type: "tool_result", tool_use_id: "tool-1" }],
        },
      },
      {
        type: "assistant",
        uuid: "c",
        parentUuid: "b",
        message: {
          content: [{ type: "tool_use", id: "tool-2" }],
        },
      },
      // No tool_result for tool-2
    ]).activeBranch;

    const orphaned = findOrphanedToolUses(activeBranch);

    expect(orphaned.has("tool-1")).toBe(false);
    expect(orphaned.has("tool-2")).toBe(true);
    expect(orphaned.size).toBe(1);
  });

  it("returns empty set when all tools have results", () => {
    const activeBranch = buildDag([
      {
        type: "assistant",
        uuid: "a",
        parentUuid: null,
        message: {
          content: [
            { type: "tool_use", id: "tool-1" },
            { type: "tool_use", id: "tool-2" },
          ],
        },
      },
      {
        type: "user",
        uuid: "b",
        parentUuid: "a",
        message: {
          content: [
            { type: "tool_result", tool_use_id: "tool-1" },
            { type: "tool_result", tool_use_id: "tool-2" },
          ],
        },
      },
    ]).activeBranch;

    const orphaned = findOrphanedToolUses(activeBranch);

    expect(orphaned.size).toBe(0);
  });

  it("handles messages with string content", () => {
    const activeBranch = buildDag([
      {
        type: "user",
        uuid: "a",
        parentUuid: null,
        message: {
          content: "Hello, this is a string message",
        },
      },
    ]).activeBranch;

    const orphaned = findOrphanedToolUses(activeBranch);

    expect(orphaned.size).toBe(0);
  });

  it("handles messages without content", () => {
    const activeBranch = buildDag([
      {
        type: "user",
        uuid: "a",
        parentUuid: null,
      },
    ]).activeBranch;

    const orphaned = findOrphanedToolUses(activeBranch);

    expect(orphaned.size).toBe(0);
  });

  it("handles multiple orphaned tools", () => {
    const activeBranch = buildDag([
      {
        type: "assistant",
        uuid: "a",
        parentUuid: null,
        message: {
          content: [
            { type: "tool_use", id: "tool-1" },
            { type: "tool_use", id: "tool-2" },
            { type: "tool_use", id: "tool-3" },
          ],
        },
      },
      {
        type: "user",
        uuid: "b",
        parentUuid: "a",
        message: {
          content: [{ type: "tool_result", tool_use_id: "tool-2" }],
        },
      },
    ]).activeBranch;

    const orphaned = findOrphanedToolUses(activeBranch);

    expect(orphaned.has("tool-1")).toBe(true);
    expect(orphaned.has("tool-2")).toBe(false);
    expect(orphaned.has("tool-3")).toBe(true);
    expect(orphaned.size).toBe(2);
  });

  it("handles empty active branch", () => {
    const orphaned = findOrphanedToolUses([]);

    expect(orphaned.size).toBe(0);
  });
});
