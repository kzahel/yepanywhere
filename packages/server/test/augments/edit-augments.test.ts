import { describe, expect, it } from "vitest";
import { computeEditAugment } from "../../src/augments/edit-augments.js";

describe("computeEditAugment", () => {
  describe("structuredPatch computation", () => {
    it("computes patch for simple single-line replacement", async () => {
      const augment = await computeEditAugment("tool-123", {
        file_path: "/test/file.ts",
        old_string: "const x = 1;",
        new_string: "const x = 2;",
      });

      expect(augment.toolUseId).toBe("tool-123");
      expect(augment.type).toBe("edit");
      expect(augment.filePath).toBe("/test/file.ts");
      expect(augment.structuredPatch).toHaveLength(1);

      const hunk = augment.structuredPatch[0];
      expect(hunk.oldStart).toBe(1);
      expect(hunk.newStart).toBe(1);
      // Should have removed line and added line
      expect(hunk.lines).toContainEqual("-const x = 1;");
      expect(hunk.lines).toContainEqual("+const x = 2;");
    });

    it("computes patch for multi-line changes", async () => {
      const augment = await computeEditAugment("tool-456", {
        file_path: "/test/file.ts",
        old_string: "function foo() {\n  return 1;\n}",
        new_string: "function foo() {\n  const x = 2;\n  return x;\n}",
      });

      expect(augment.structuredPatch).toHaveLength(1);
      const hunk = augment.structuredPatch[0];

      // Should contain the changes
      expect(hunk.lines.some((l) => l.startsWith("-"))).toBe(true);
      expect(hunk.lines.some((l) => l.startsWith("+"))).toBe(true);
    });

    it("includes context lines (3 by default)", async () => {
      const oldCode = [
        "line 1",
        "line 2",
        "line 3",
        "line 4",
        "old line 5",
        "line 6",
        "line 7",
        "line 8",
        "line 9",
      ].join("\n");

      const newCode = [
        "line 1",
        "line 2",
        "line 3",
        "line 4",
        "new line 5",
        "line 6",
        "line 7",
        "line 8",
        "line 9",
      ].join("\n");

      const augment = await computeEditAugment("tool-789", {
        file_path: "/test/file.ts",
        old_string: oldCode,
        new_string: newCode,
      });

      expect(augment.structuredPatch).toHaveLength(1);
      const hunk = augment.structuredPatch[0];

      // Context lines should be prefixed with space
      const contextLines = hunk.lines.filter((l) => l.startsWith(" "));
      expect(contextLines.length).toBeGreaterThanOrEqual(3);
    });

    it("handles empty old_string (new content)", async () => {
      const augment = await computeEditAugment("tool-new", {
        file_path: "/test/new-file.ts",
        old_string: "",
        new_string: "const newContent = true;",
      });

      expect(augment.structuredPatch).toHaveLength(1);
      const hunk = augment.structuredPatch[0];

      // All lines should be additions
      const addedLines = hunk.lines.filter((l) => l.startsWith("+"));
      expect(addedLines.length).toBeGreaterThan(0);
      expect(hunk.lines.filter((l) => l.startsWith("-"))).toHaveLength(0);
    });

    it("handles empty new_string (deletion)", async () => {
      const augment = await computeEditAugment("tool-del", {
        file_path: "/test/file.ts",
        old_string: "const deletedContent = true;",
        new_string: "",
      });

      expect(augment.structuredPatch).toHaveLength(1);
      const hunk = augment.structuredPatch[0];

      // All lines should be deletions
      const removedLines = hunk.lines.filter((l) => l.startsWith("-"));
      expect(removedLines.length).toBeGreaterThan(0);
      expect(hunk.lines.filter((l) => l.startsWith("+"))).toHaveLength(0);
    });

    it("handles both old and new being empty", async () => {
      const augment = await computeEditAugment("tool-empty", {
        file_path: "/test/empty.ts",
        old_string: "",
        new_string: "",
      });

      // No changes, so no hunks
      expect(augment.structuredPatch).toHaveLength(0);
    });

    it("handles identical old and new strings", async () => {
      const augment = await computeEditAugment("tool-same", {
        file_path: "/test/same.ts",
        old_string: "const x = 1;",
        new_string: "const x = 1;",
      });

      // No changes, so no hunks
      expect(augment.structuredPatch).toHaveLength(0);
    });
  });

  describe("diff HTML highlighting", () => {
    it("returns highlighted HTML for diff", async () => {
      const augment = await computeEditAugment("tool-hl", {
        file_path: "/test/file.ts",
        old_string: "const x = 1;",
        new_string: "const x = 2;",
      });

      // Should contain pre tag with shiki class
      expect(augment.diffHtml).toContain("<pre");
      expect(augment.diffHtml).toContain("shiki");

      // Should contain the diff hunk header
      expect(augment.diffHtml).toContain("@@");
    });

    it("adds line type classes for CSS styling", async () => {
      const augment = await computeEditAugment("tool-classes", {
        file_path: "/test/file.ts",
        old_string: "const x = 1;",
        new_string: "const x = 2;",
      });

      // Should have line-deleted class for removed lines
      expect(augment.diffHtml).toContain('class="line line-deleted"');
      // Should have line-inserted class for added lines
      expect(augment.diffHtml).toContain('class="line line-inserted"');
      // Should have line-hunk class for @@ header
      expect(augment.diffHtml).toContain('class="line line-hunk"');
    });

    it("adds line-context class for unchanged lines", async () => {
      // Create a diff with context lines
      const oldCode = "line1\nline2\nold\nline4\nline5";
      const newCode = "line1\nline2\nnew\nline4\nline5";

      const augment = await computeEditAugment("tool-context", {
        file_path: "/test/file.ts",
        old_string: oldCode,
        new_string: newCode,
      });

      // Should have context lines (space-prefixed)
      expect(augment.diffHtml).toContain('class="line line-context"');
    });

    it("produces consistent output structure", async () => {
      // This test verifies the structure is stable for both streaming and reload
      const input = {
        file_path: "/test/file.ts",
        old_string: "const a = 1;\nconst b = 2;",
        new_string: "const a = 1;\nconst c = 3;",
      };

      // Compute twice to ensure deterministic output
      const augment1 = await computeEditAugment("tool-1", input);
      const augment2 = await computeEditAugment("tool-2", input);

      // diffHtml should be identical (except for any toolUseId references if present)
      expect(augment1.diffHtml).toBe(augment2.diffHtml);

      // structuredPatch should be identical
      expect(augment1.structuredPatch).toEqual(augment2.structuredPatch);
    });

    it("escapes HTML in diff content", async () => {
      const augment = await computeEditAugment("tool-xss", {
        file_path: "/test/file.html",
        old_string: "<div>old</div>",
        new_string: "<div>new</div>",
      });

      // Should escape the HTML tags in the content
      expect(augment.diffHtml).not.toContain("<div>old</div>");
      expect(augment.diffHtml).not.toContain("<div>new</div>");
    });

    it("handles large diffs", async () => {
      // Generate a large diff
      const oldLines = Array.from({ length: 100 }, (_, i) => `old line ${i}`);
      const newLines = Array.from({ length: 100 }, (_, i) => `new line ${i}`);

      const augment = await computeEditAugment("tool-large", {
        file_path: "/test/large.ts",
        old_string: oldLines.join("\n"),
        new_string: newLines.join("\n"),
      });

      // Should still generate valid output
      expect(augment.diffHtml).toContain("<pre");
      expect(augment.structuredPatch.length).toBeGreaterThan(0);
    });
  });

  describe("edge cases", () => {
    it("handles special characters in file paths", async () => {
      const augment = await computeEditAugment("tool-special", {
        file_path: "/test/path with spaces/file[1].ts",
        old_string: "old",
        new_string: "new",
      });

      expect(augment.filePath).toBe("/test/path with spaces/file[1].ts");
    });

    it("handles unicode content", async () => {
      const augment = await computeEditAugment("tool-unicode", {
        file_path: "/test/unicode.ts",
        old_string: "const emoji = '😀';",
        new_string: "const emoji = '🎉';",
      });

      expect(augment.structuredPatch.length).toBeGreaterThan(0);
      // The diff should contain the emoji characters (possibly escaped in HTML)
      expect(augment.diffHtml).toBeTruthy();
    });

    it("handles Windows-style line endings", async () => {
      const augment = await computeEditAugment("tool-crlf", {
        file_path: "/test/windows.ts",
        old_string: "line1\r\nline2\r\n",
        new_string: "line1\r\nline3\r\n",
      });

      expect(augment.structuredPatch.length).toBeGreaterThan(0);
    });
  });
});
