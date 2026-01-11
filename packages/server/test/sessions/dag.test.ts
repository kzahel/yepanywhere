import { describe, expect, it } from "vitest";
import {
  type RawSessionMessage,
  buildDag,
  collectAllToolResultIds,
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
    const messages: RawSessionMessage[] = [
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
    ];
    const { activeBranch } = buildDag(messages);
    const allToolResultIds = collectAllToolResultIds(messages);

    const orphaned = findOrphanedToolUses(activeBranch, allToolResultIds);

    expect(orphaned.has("tool-1")).toBe(false);
    expect(orphaned.has("tool-2")).toBe(true);
    expect(orphaned.size).toBe(1);
  });

  it("returns empty set when all tools have results", () => {
    const messages: RawSessionMessage[] = [
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
    ];
    const { activeBranch } = buildDag(messages);
    const allToolResultIds = collectAllToolResultIds(messages);

    const orphaned = findOrphanedToolUses(activeBranch, allToolResultIds);

    expect(orphaned.size).toBe(0);
  });

  it("handles messages with string content", () => {
    const messages: RawSessionMessage[] = [
      {
        type: "user",
        uuid: "a",
        parentUuid: null,
        message: {
          content: "Hello, this is a string message",
        },
      },
    ];
    const { activeBranch } = buildDag(messages);
    const allToolResultIds = collectAllToolResultIds(messages);

    const orphaned = findOrphanedToolUses(activeBranch, allToolResultIds);

    expect(orphaned.size).toBe(0);
  });

  it("handles messages without content", () => {
    const messages: RawSessionMessage[] = [
      {
        type: "user",
        uuid: "a",
        parentUuid: null,
      },
    ];
    const { activeBranch } = buildDag(messages);
    const allToolResultIds = collectAllToolResultIds(messages);

    const orphaned = findOrphanedToolUses(activeBranch, allToolResultIds);

    expect(orphaned.size).toBe(0);
  });

  it("handles multiple orphaned tools", () => {
    const messages: RawSessionMessage[] = [
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
    ];
    const { activeBranch } = buildDag(messages);
    const allToolResultIds = collectAllToolResultIds(messages);

    const orphaned = findOrphanedToolUses(activeBranch, allToolResultIds);

    expect(orphaned.has("tool-1")).toBe(true);
    expect(orphaned.has("tool-2")).toBe(false);
    expect(orphaned.has("tool-3")).toBe(true);
    expect(orphaned.size).toBe(2);
  });

  it("handles empty active branch", () => {
    const orphaned = findOrphanedToolUses([], new Set());

    expect(orphaned.size).toBe(0);
  });
});

describe("buildDag with compaction", () => {
  it("follows logicalParentUuid across single compact_boundary", () => {
    // Pre-compaction messages
    const messages: RawSessionMessage[] = [
      { type: "user", uuid: "a", parentUuid: null },
      { type: "assistant", uuid: "b", parentUuid: "a" },
      { type: "user", uuid: "c", parentUuid: "b" },
      // Compact boundary - parentUuid is null but logicalParentUuid points to pre-compaction
      {
        type: "system",
        subtype: "compact_boundary",
        uuid: "compact-1",
        parentUuid: null,
        logicalParentUuid: "c",
      },
      // Post-compaction messages continue from compact boundary
      { type: "user", uuid: "d", parentUuid: "compact-1" },
      { type: "assistant", uuid: "e", parentUuid: "d" },
    ];

    const result = buildDag(messages);

    // Should include all messages: pre-compaction + compact_boundary + post-compaction
    expect(result.activeBranch.map((n) => n.uuid)).toEqual([
      "a",
      "b",
      "c",
      "compact-1",
      "d",
      "e",
    ]);
    expect(result.tip?.uuid).toBe("e");
    expect(result.activeBranchUuids.size).toBe(6);
  });

  it("follows multiple compact_boundary nodes in chain", () => {
    // First conversation segment
    const messages: RawSessionMessage[] = [
      { type: "user", uuid: "a", parentUuid: null },
      { type: "assistant", uuid: "b", parentUuid: "a" },
      // First compaction
      {
        type: "system",
        subtype: "compact_boundary",
        uuid: "compact-1",
        parentUuid: null,
        logicalParentUuid: "b",
      },
      // Second segment
      { type: "user", uuid: "c", parentUuid: "compact-1" },
      { type: "assistant", uuid: "d", parentUuid: "c" },
      // Second compaction
      {
        type: "system",
        subtype: "compact_boundary",
        uuid: "compact-2",
        parentUuid: null,
        logicalParentUuid: "d",
      },
      // Third segment
      { type: "user", uuid: "e", parentUuid: "compact-2" },
      { type: "assistant", uuid: "f", parentUuid: "e" },
    ];

    const result = buildDag(messages);

    // Should include all segments connected through compact boundaries
    expect(result.activeBranch.map((n) => n.uuid)).toEqual([
      "a",
      "b",
      "compact-1",
      "c",
      "d",
      "compact-2",
      "e",
      "f",
    ]);
    expect(result.tip?.uuid).toBe("f");
  });

  it("handles compact_boundary without logicalParentUuid (stops at boundary)", () => {
    const messages: RawSessionMessage[] = [
      { type: "user", uuid: "a", parentUuid: null },
      { type: "assistant", uuid: "b", parentUuid: "a" },
      // Compact boundary without logicalParentUuid (shouldn't happen, but be defensive)
      {
        type: "system",
        subtype: "compact_boundary",
        uuid: "compact-1",
        parentUuid: null,
        // No logicalParentUuid
      },
      { type: "user", uuid: "c", parentUuid: "compact-1" },
    ];

    const result = buildDag(messages);

    // Should stop at compact boundary since no logicalParentUuid
    expect(result.activeBranch.map((n) => n.uuid)).toEqual(["compact-1", "c"]);
    expect(result.tip?.uuid).toBe("c");
  });

  it("handles compact_boundary with broken logicalParentUuid", () => {
    const messages: RawSessionMessage[] = [
      { type: "user", uuid: "a", parentUuid: null },
      // Compact boundary pointing to non-existent message
      {
        type: "system",
        subtype: "compact_boundary",
        uuid: "compact-1",
        parentUuid: null,
        logicalParentUuid: "nonexistent",
      },
      { type: "user", uuid: "b", parentUuid: "compact-1" },
    ];

    const result = buildDag(messages);

    // Should stop at compact boundary since logicalParentUuid doesn't resolve
    expect(result.activeBranch.map((n) => n.uuid)).toEqual(["compact-1", "b"]);
    expect(result.tip?.uuid).toBe("b");
  });

  it("includes compact_boundary in activeBranchUuids", () => {
    const messages: RawSessionMessage[] = [
      { type: "user", uuid: "a", parentUuid: null },
      {
        type: "system",
        subtype: "compact_boundary",
        uuid: "compact-1",
        parentUuid: null,
        logicalParentUuid: "a",
      },
      { type: "user", uuid: "b", parentUuid: "compact-1" },
    ];

    const result = buildDag(messages);

    expect(result.activeBranchUuids.has("compact-1")).toBe(true);
  });

  it("preserves lineIndex across compaction boundary", () => {
    const messages: RawSessionMessage[] = [
      { type: "user", uuid: "a", parentUuid: null }, // index 0
      { type: "assistant", uuid: "b", parentUuid: "a" }, // index 1
      {
        type: "system",
        subtype: "compact_boundary",
        uuid: "compact-1",
        parentUuid: null,
        logicalParentUuid: "b",
      }, // index 2
      { type: "user", uuid: "c", parentUuid: "compact-1" }, // index 3
    ];

    const result = buildDag(messages);

    expect(result.activeBranch[0]?.lineIndex).toBe(0);
    expect(result.activeBranch[1]?.lineIndex).toBe(1);
    expect(result.activeBranch[2]?.lineIndex).toBe(2); // compact_boundary
    expect(result.activeBranch[3]?.lineIndex).toBe(3);
  });
});
