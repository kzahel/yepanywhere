import { describe, expect, it } from "vitest";
import type { RenderItem } from "../../types/renderItems";
import { collectTurnDiffEntries } from "../TurnDiffSummary";

describe("collectTurnDiffEntries", () => {
  it("collects completed edit diffs with line counts", () => {
    const items: RenderItem[] = [
      {
        type: "tool_call",
        id: "edit-1",
        toolName: "Edit",
        toolInput: {
          file_path: "src/app.ts",
          _diffHtml: "<pre>diff</pre>",
        },
        toolResult: {
          content: "",
          isError: false,
          structured: {
            filePath: "src/app.ts",
            structuredPatch: [
              {
                oldStart: 1,
                oldLines: 1,
                newStart: 1,
                newLines: 2,
                lines: ["-const a = 1;", "+const a = 2;", "+const b = 3;"],
              },
            ],
          },
        },
        status: "complete",
        sourceMessages: [],
      },
    ];

    expect(collectTurnDiffEntries(items)).toEqual([
      expect.objectContaining({
        id: "edit-1",
        filePath: "src/app.ts",
        additions: 2,
        deletions: 1,
        diffHtml: "<pre>diff</pre>",
      }),
    ]);
  });

  it("ignores non-edit and incomplete tool calls", () => {
    const items: RenderItem[] = [
      {
        type: "tool_call",
        id: "read-1",
        toolName: "Read",
        toolInput: {},
        status: "complete",
        sourceMessages: [],
      },
      {
        type: "tool_call",
        id: "edit-2",
        toolName: "Edit",
        toolInput: { file_path: "src/pending.ts" },
        status: "pending",
        sourceMessages: [],
      },
    ];

    expect(collectTurnDiffEntries(items)).toEqual([]);
  });

  it("falls back to raw patch metadata for file path extraction", () => {
    const items: RenderItem[] = [
      {
        type: "tool_call",
        id: "edit-3",
        toolName: "Edit",
        toolInput: {
          _rawPatch: "*** Update File: src/raw.ts\n@@\n-old\n+new\n",
          _structuredPatch: [
            {
              oldStart: 1,
              oldLines: 1,
              newStart: 1,
              newLines: 1,
              lines: ["-old", "+new"],
            },
          ],
        },
        toolResult: {
          content: "",
          isError: false,
          structured: {},
        },
        status: "complete",
        sourceMessages: [],
      },
    ];

    expect(collectTurnDiffEntries(items)).toEqual([
      expect.objectContaining({
        filePath: "src/raw.ts",
        additions: 1,
        deletions: 1,
      }),
    ]);
  });

  it("recovers via edit originalFile when canRebuildFinalDiff is false", () => {
    // First edit has no originalFile so canRebuildFinalDiff stays false.
    // Second edit provides originalFile — should still produce a correct patch.
    const items: RenderItem[] = [
      {
        type: "tool_call",
        id: "edit-1",
        toolName: "Edit",
        toolInput: { file_path: "src/app.ts" },
        toolResult: {
          content: "",
          isError: false,
          structured: {
            filePath: "src/app.ts",
            structuredPatch: [
              {
                oldStart: 1,
                oldLines: 1,
                newStart: 1,
                newLines: 1,
                lines: ["-const a = 1;", "+const a = 2;"],
              },
            ],
          },
        },
        status: "complete",
        sourceMessages: [],
      },
      {
        type: "tool_call",
        id: "edit-2",
        toolName: "Edit",
        toolInput: { file_path: "src/app.ts" },
        toolResult: {
          content: "",
          isError: false,
          structured: {
            filePath: "src/app.ts",
            oldString: "const a = 2;",
            newString: "const b = 3;",
            originalFile: "const a = 2;\nconst c = 4;",
            replaceAll: false,
            structuredPatch: [],
          },
        },
        status: "complete",
        sourceMessages: [],
      },
    ];

    const result = collectTurnDiffEntries(items);
    expect(result).toHaveLength(1);
    // The second edit should not be silently dropped
    expect(result[0]).toMatchObject({
      filePath: "src/app.ts",
      additions: 1,
      deletions: 1,
    });
    const allLines = result[0]!.structuredPatch.flatMap((h) => h.lines);
    expect(allLines).toContain("+const b = 3;");
  });

  it("merges multiple edits for the same file into one entry", () => {
    const items: RenderItem[] = [
      {
        type: "tool_call",
        id: "edit-1",
        toolName: "Edit",
        toolInput: {
          file_path: "src/app.ts",
          old_string: "const a = 1;",
          new_string: "const a = 2;",
        },
        toolResult: {
          content: "",
          isError: false,
          structured: {
            filePath: "src/app.ts",
            oldString: "const a = 1;",
            newString: "const a = 2;",
            originalFile: "const a = 1;\nconst c = 4;",
            replaceAll: false,
            structuredPatch: [],
          },
        },
        status: "complete",
        sourceMessages: [],
      },
      {
        type: "tool_call",
        id: "edit-2",
        toolName: "Edit",
        toolInput: {
          file_path: "src/app.ts",
          old_string: "const a = 2;",
          new_string: "const b = 3;",
        },
        toolResult: {
          content: "",
          isError: false,
          structured: {
            filePath: "src/app.ts",
            oldString: "const a = 2;",
            newString: "const b = 3;",
            originalFile: "const a = 2;\nconst c = 4;",
            replaceAll: false,
            structuredPatch: [],
          },
        },
        status: "complete",
        sourceMessages: [],
      },
    ];

    expect(collectTurnDiffEntries(items)).toEqual([
      expect.objectContaining({
        filePath: "src/app.ts",
        additions: 1,
        deletions: 1,
        diffHtml: undefined,
        structuredPatch: [
          expect.objectContaining({
            lines: ["-const a = 1;", "+const b = 3;", " const c = 4;"],
          }),
        ],
      }),
    ]);
  });
});
