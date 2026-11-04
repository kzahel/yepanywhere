import { describe, expect, it } from "vitest";
import {
  extractRawPatchFromEditInput,
  parseRawEditPatch,
} from "../../src/augments/edit-raw-patch.js";

describe("parseRawEditPatch", () => {
  it("parses a valid Codex apply_patch block into structured hunks", () => {
    const rawPatch = [
      "*** Begin Patch",
      "*** Update File: src/example.ts",
      "@@",
      " const x = 1;",
      "-const y = 1;",
      "+const y = 2;",
      "*** End Patch",
      "",
    ].join("\n");

    const parsed = parseRawEditPatch(rawPatch);

    expect(parsed).not.toBeNull();
    expect(parsed?.filePath).toBe("src/example.ts");
    expect(parsed?.structuredPatch).toHaveLength(1);
    expect(parsed?.structuredPatch[0]?.lines).toEqual([
      " const x = 1;",
      "-const y = 1;",
      "+const y = 2;",
    ]);
  });

  it("parses Codex Add File patches as new-file hunks", () => {
    const rawPatch = [
      "*** Begin Patch",
      "*** Add File: /repo/research/progress-2026-05-18.md",
      "+# Recent MT Adapter Progress",
      "+",
      "+- **win** in `dev`",
      "*** End Patch",
      "",
    ].join("\n");

    const parsed = parseRawEditPatch(rawPatch);

    expect(parsed).not.toBeNull();
    expect(parsed?.filePath).toBe("/repo/research/progress-2026-05-18.md");
    expect(parsed?.structuredPatch).toEqual([
      {
        oldStart: 1,
        oldLines: 0,
        newStart: 1,
        newLines: 3,
        lines: ["+# Recent MT Adapter Progress", "+", "+- **win** in `dev`"],
      },
    ]);
  });

  it("tolerates malformed patch text without throwing", () => {
    const rawPatch = [
      "*** Begin Patch",
      "*** Update File: src/example.ts",
      "this is not a hunk",
      "*** End Patch",
      "",
    ].join("\n");

    expect(() => parseRawEditPatch(rawPatch)).not.toThrow();
    const parsed = parseRawEditPatch(rawPatch);
    expect(parsed).not.toBeNull();
    expect(parsed?.structuredPatch).toEqual([]);
  });

  it("parses unified diff content without apply_patch markers", () => {
    const rawPatch = [
      "diff --git a/src/example.ts b/src/example.ts",
      "--- a/src/example.ts",
      "+++ b/src/example.ts",
      "@@ -1,2 +1,2 @@",
      "-const x = 1;",
      "+const x = 2;",
      " const y = 3;",
      "",
    ].join("\n");

    const parsed = parseRawEditPatch(rawPatch);

    expect(parsed).not.toBeNull();
    expect(parsed?.filePath).toBe("src/example.ts");
    expect(parsed?.structuredPatch).toHaveLength(1);
    expect(parsed?.structuredPatch[0]?.oldStart).toBe(1);
    expect(parsed?.structuredPatch[0]?.newStart).toBe(1);
    expect(parsed?.structuredPatch[0]?.lines).toEqual([
      "-const x = 1;",
      "+const x = 2;",
      " const y = 3;",
    ]);
  });
});

describe("extractRawPatchFromEditInput", () => {
  it("extracts raw patch text from nested object shapes", () => {
    const rawPatch = "*** Begin Patch\n*** End Patch\n";
    const extracted = extractRawPatchFromEditInput({
      input: { patch: rawPatch },
    });
    expect(extracted).toBe(rawPatch);
  });

  it("extracts the canonical raw patch field attached by Codex code mode", () => {
    const rawPatch = "*** Begin Patch\n*** End Patch\n";
    expect(extractRawPatchFromEditInput({ _rawPatch: rawPatch })).toBe(
      rawPatch,
    );
  });

  it("extracts and combines diffs from codex file_change shapes", () => {
    const extracted = extractRawPatchFromEditInput({
      changes: [
        {
          path: "src/a.ts",
          kind: "update",
          diff: "@@ -1 +1 @@\n-a\n+b\n",
        },
        {
          path: "src/b.ts",
          kind: "update",
          diff: "@@ -1 +1 @@\n-c\n+d\n",
        },
      ],
    });

    expect(extracted).toContain("@@ -1 +1 @@");
    expect(extracted).toContain("-a");
    expect(extracted).toContain("+d");
  });

  it("renders Codex added-file content as a new-file hunk", () => {
    const extracted = extractRawPatchFromEditInput({
      file_path: "/repo/new.ts",
      changes: [
        {
          path: "/repo/new.ts",
          kind: "add",
          diff: "  indented();\nplain\n",
        },
      ],
    });

    expect(extracted).toBe("@@ -0,0 +1,2 @@\n+  indented();\n+plain");
    expect(parseRawEditPatch(extracted ?? "")?.structuredPatch).toEqual([
      {
        oldStart: 0,
        oldLines: 0,
        newStart: 1,
        newLines: 2,
        lines: ["+  indented();", "+plain"],
      },
    ]);
  });

  it("extracts Codex patch_apply_end unified diffs", () => {
    expect(
      extractRawPatchFromEditInput({
        changes: [
          {
            path: "src/a.ts",
            type: "update",
            unified_diff: "@@ -1 +1 @@\n-old\n+new\n",
          },
        ],
      }),
    ).toBe("@@ -1 +1 @@\n-old\n+new");
  });
});
