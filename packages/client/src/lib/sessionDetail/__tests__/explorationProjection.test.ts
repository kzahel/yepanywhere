import type { ToolDisplayAction } from "@yep-anywhere/shared";
import { describe, expect, it } from "vitest";
import type { Message } from "../../../types";
import type {
  RenderItem,
  ToolCallItem,
} from "@yep-anywhere/shared/transcript/items";
import { buildAssistantRenderSegments } from "../exploration";
import {
  buildExplorationProjectionSegments,
  projectExplorationParent,
} from "../explorationProjection";
import {
  estimateExplorationGroupHeightPx,
  getExplorationEntryDisplayLabel,
  getExplorationEntrySearchText,
  getExplorationEntrySummaryText,
} from "../explorationPresentation";
import { buildAssistantTimelineRows } from "../timeline";

function sourceMessage(id: string, timestamp: string): Message {
  return {
    type: "assistant",
    uuid: `message-${id}`,
    timestamp,
    message: { role: "assistant", content: "" },
  };
}

function toolCall(options: {
  id: string;
  toolName?: string;
  toolInput?: unknown;
  displayActions?: ToolDisplayAction[];
  status?: ToolCallItem["status"];
  timestamp?: string;
  toolResult?: ToolCallItem["toolResult"];
}): ToolCallItem {
  return {
    type: "tool_call",
    id: options.id,
    toolName: options.toolName ?? "Bash",
    toolInput: options.toolInput ?? { command: "compound exploration" },
    ...(options.displayActions
      ? { displayActions: options.displayActions }
      : {}),
    ...(options.toolResult ? { toolResult: options.toolResult } : {}),
    status: options.status ?? "pending",
    sourceMessages: [
      sourceMessage(
        options.id,
        options.timestamp ?? "2026-07-10T08:00:00.000Z",
      ),
    ],
  };
}

function compactSegments(items: readonly RenderItem[]) {
  return buildExplorationProjectionSegments(items).map((segment) =>
    segment.kind === "item"
      ? { kind: "item", id: segment.item.id }
      : {
          kind: "explored",
          id: segment.projection.id,
          parentIds: segment.projection.parents.map((parent) => parent.item.id),
          entryIds: segment.projection.entries.map((entry) => entry.id),
        },
  );
}

const FIRST_READ: ToolDisplayAction = {
  kind: "read",
  path: "src/session.ts",
  absolutePath: "/workspace/src/session.ts",
  name: "session.ts",
  startLine: 1,
  endLine: 100,
};
const SECOND_READ: ToolDisplayAction = {
  kind: "read",
  path: "src/session.ts",
  absolutePath: "/workspace/src/session.ts",
  name: "session.ts",
  startLine: 101,
  endLine: 200,
};
const THIRD_READ: ToolDisplayAction = {
  kind: "read",
  path: "src/driver.ts",
  absolutePath: "/workspace/src/driver.ts",
  name: "driver.ts",
  startLine: 1,
  endLine: 80,
};
const THREE_READS: ToolDisplayAction[] = [FIRST_READ, SECOND_READ, THIRD_READ];

describe("exploration projection", () => {
  it("projects one parent with several ordered read entries", () => {
    const parent = toolCall({
      id: "call-three-reads",
      displayActions: THREE_READS,
      toolResult: { content: "combined output", isError: false },
      status: "complete",
    });

    const segments = buildExplorationProjectionSegments([parent]);
    expect(segments).toHaveLength(1);
    const segment = segments[0];
    expect(segment?.kind).toBe("explored");
    if (segment?.kind !== "explored") return;

    expect(segment.projection.id).toBe(
      "explored-call-three-reads-call-three-reads",
    );
    expect(segment.projection.parents).toHaveLength(1);
    expect(segment.projection.parents[0]?.item).toBe(parent);
    expect(segment.projection.entries).toEqual([
      {
        id: "call-three-reads:0",
        parentId: "call-three-reads",
        sourceIndex: 0,
        kind: "read",
        path: "src/session.ts",
        absolutePath: "/workspace/src/session.ts",
        name: "session.ts",
        startLine: 1,
        endLine: 100,
      },
      {
        id: "call-three-reads:1",
        parentId: "call-three-reads",
        sourceIndex: 1,
        kind: "read",
        path: "src/session.ts",
        absolutePath: "/workspace/src/session.ts",
        name: "session.ts",
        startLine: 101,
        endLine: 200,
      },
      {
        id: "call-three-reads:2",
        parentId: "call-three-reads",
        sourceIndex: 2,
        kind: "read",
        path: "src/driver.ts",
        absolutePath: "/workspace/src/driver.ts",
        name: "driver.ts",
        startLine: 1,
        endLine: 80,
      },
    ]);
    expect(
      segment.projection.entries.some((entry) => "toolResult" in entry),
    ).toBe(false);
  });

  it("keeps projection identity stable from pending to completed", () => {
    const pending = toolCall({
      id: "call-stable",
      displayActions: THREE_READS,
    });
    const completed = toolCall({
      id: "call-stable",
      displayActions: THREE_READS,
      status: "complete",
      toolResult: { content: "one combined result", isError: false },
    });

    const pendingParent = projectExplorationParent(pending);
    const completedParent = projectExplorationParent(completed);
    expect(pendingParent?.entries).toEqual(completedParent?.entries);
    expect(compactSegments([pending])).toEqual(compactSegments([completed]));
    expect(pendingParent?.item.status).toBe("pending");
    expect(completedParent?.item.status).toBe("complete");
  });

  it("keeps disclosure ownership stable as adjacent parents extend a group", () => {
    const read = toolCall({
      id: "read-owner",
      toolName: "Read",
      toolInput: { file_path: "README.md" },
    });
    const grep = toolCall({
      id: "grep-adjacent",
      toolName: "Grep",
      toolInput: { pattern: "needle" },
    });
    const list = toolCall({
      id: "list-appended",
      toolName: "list_dir",
      toolInput: { target_directory: "src" },
    });

    const before = buildExplorationProjectionSegments([read, grep])[0];
    const after = buildExplorationProjectionSegments([read, grep, list])[0];
    expect(before?.kind).toBe("explored");
    expect(after?.kind).toBe("explored");
    if (before?.kind !== "explored" || after?.kind !== "explored") return;

    expect(before.projection.id).toBe("explored-read-owner-grep-adjacent");
    expect(after.projection.id).toBe("explored-read-owner-list-appended");
    expect(before.projection.disclosureOwnerId).toBe("read-owner");
    expect(after.projection.disclosureOwnerId).toBe("read-owner");
  });

  it("adapts adjacent canonical parents without changing legacy grouping", () => {
    const read = toolCall({
      id: "read-1",
      toolName: "Read",
      toolInput: { file_path: "README.md", offset: 10, limit: 5 },
    });
    const grep = toolCall({
      id: "grep-1",
      toolName: "Grep",
      toolInput: { pattern: "needle", path: "src" },
    });
    const list = toolCall({
      id: "list-1",
      toolName: "list_dir",
      toolInput: { target_directory: "packages/client" },
    });

    const projected = buildExplorationProjectionSegments([read, grep, list]);
    expect(projected).toHaveLength(1);
    const projection = projected[0];
    expect(projection?.kind).toBe("explored");
    if (projection?.kind !== "explored") return;
    expect(projection.projection.entries).toEqual([
      {
        id: "read-1:0",
        parentId: "read-1",
        sourceIndex: 0,
        kind: "read",
        path: "README.md",
        name: "README.md",
        startLine: 10,
        endLine: 14,
      },
      {
        id: "grep-1:0",
        parentId: "grep-1",
        sourceIndex: 0,
        kind: "search",
        query: "needle",
        path: "src",
      },
      {
        id: "list-1:0",
        parentId: "list-1",
        sourceIndex: 0,
        kind: "list",
        path: "packages/client",
      },
    ]);

    const legacy = buildAssistantRenderSegments([read, grep, list]);
    expect(legacy).toHaveLength(1);
    expect(legacy[0]).toMatchObject({
      kind: "explored",
      id: "explored-read-1-list-1",
      items: [read, grep, list],
    });
    expect(legacy[0]?.kind === "explored" && legacy[0].projection).toEqual(
      projection.projection,
    );

    const timelineRows = buildAssistantTimelineRows({
      items: [read, grep, list],
      latestVisibleTimestampMs: null,
      nowMs: Date.parse("2026-07-10T08:01:00.000Z"),
    });
    expect(
      timelineRows[0]?.kind === "explored" && timelineRows[0].projection,
    ).toEqual(projection.projection);
  });

  it("supports several noncanonical parents with one semantic action each", () => {
    const first = toolCall({
      id: "exec-read",
      displayActions: [FIRST_READ],
    });
    const second = toolCall({
      id: "exec-search",
      displayActions: [{ kind: "search", query: "needle", path: "src" }],
    });

    expect(compactSegments([first, second])).toEqual([
      {
        kind: "explored",
        id: "explored-exec-read-exec-search",
        parentIds: ["exec-read", "exec-search"],
        entryIds: ["exec-read:0", "exec-search:0"],
      },
    ]);
    expect(compactSegments([first])).toEqual([
      { kind: "item", id: "exec-read" },
    ]);
  });

  it("breaks groups at mutations and retains eligible groups on each side", () => {
    const multiRead = toolCall({
      id: "multi-read",
      displayActions: THREE_READS,
    });
    const edit = toolCall({
      id: "edit-1",
      toolName: "Edit",
      toolInput: { file_path: "src/session.ts" },
    });
    const read = toolCall({
      id: "read-1",
      toolName: "Read",
      toolInput: { file_path: "src/session.ts" },
    });
    const grep = toolCall({
      id: "grep-1",
      toolName: "Grep",
      toolInput: { pattern: "needle" },
    });

    expect(compactSegments([multiRead, edit, read, grep])).toEqual([
      {
        kind: "explored",
        id: "explored-multi-read-multi-read",
        parentIds: ["multi-read"],
        entryIds: ["multi-read:0", "multi-read:1", "multi-read:2"],
      },
      { kind: "item", id: "edit-1" },
      {
        kind: "explored",
        id: "explored-read-1-grep-1",
        parentIds: ["read-1", "grep-1"],
        entryIds: ["read-1:0", "grep-1:0"],
      },
    ]);
  });

  it("retains duplicate paths and ranges as distinct source-order entries", () => {
    const duplicateReads = toolCall({
      id: "duplicate-reads",
      displayActions: [FIRST_READ, FIRST_READ, SECOND_READ],
    });
    const parent = projectExplorationParent(duplicateReads);

    expect(parent?.entries.map((entry) => entry.id)).toEqual([
      "duplicate-reads:0",
      "duplicate-reads:1",
      "duplicate-reads:2",
    ]);
    expect(
      parent?.entries.map((entry) => [entry.startLine, entry.endLine]),
    ).toEqual([
      [1, 100],
      [1, 100],
      [101, 200],
    ]);
  });

  it("breaks adjacent canonical parents at the established timestamp gap", () => {
    const read = toolCall({
      id: "read-old",
      toolName: "Read",
      toolInput: { file_path: "old.md" },
      timestamp: "2026-07-10T08:00:00.000Z",
    });
    const grep = toolCall({
      id: "grep-late",
      toolName: "Grep",
      toolInput: { pattern: "needle" },
      timestamp: "2026-07-10T08:05:00.001Z",
    });

    expect(compactSegments([read, grep])).toEqual([
      { kind: "item", id: "read-old" },
      { kind: "item", id: "grep-late" },
    ]);
  });

  it("fails closed when display-action metadata is structurally invalid", () => {
    const invalid = toolCall({
      id: "invalid-bash",
      displayActions: [
        { kind: "read", path: "src/a.ts", name: "" },
      ] as ToolDisplayAction[],
    });

    expect(projectExplorationParent(invalid)).toBeNull();
    expect(compactSegments([invalid])).toEqual([
      { kind: "item", id: "invalid-bash" },
    ]);
  });

  it("derives compact presentation text and bounded intrinsic heights", () => {
    const compound = toolCall({
      id: "compound-presentation",
      displayActions: THREE_READS,
    });
    const parent = projectExplorationParent(compound);
    const second = parent?.entries[1];
    expect(parent).not.toBeNull();
    expect(second).toBeDefined();
    if (!parent || !second) return;

    expect(getExplorationEntryDisplayLabel(parent, second)).toBe("Read");
    expect(getExplorationEntrySummaryText(second)).toBe(
      "src/session.ts lines 101-200",
    );
    expect(getExplorationEntrySearchText(parent, second)).toContain(
      "/workspace/src/session.ts",
    );
    expect(
      estimateExplorationGroupHeightPx({
        detailRowCount: 1,
        entryCount: 3,
        expanded: true,
      }),
    ).toBe(132);
    expect(
      estimateExplorationGroupHeightPx({
        detailRowCount: 1,
        entryCount: 6,
        expanded: true,
      }),
    ).toBe(162);
    expect(
      estimateExplorationGroupHeightPx({
        detailRowCount: 1,
        entryCount: 6,
        expanded: false,
      }),
    ).toBe(26);
  });
});
