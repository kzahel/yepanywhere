import { ok } from "node:assert/strict";
import { anchorFromPatch, patchLineCount } from "@yep-anywhere/shared";
import { describe, expect, it } from "vitest";
import {
  type WordDiffSegment,
  __test__,
  computeEditAugment,
  computeStructuredPatchDiffHtml,
} from "../../src/augments/edit-augments.js";

const {
  extractShikiLines,
  addDiffLineClasses,
  convertHunks,
  patchToUnifiedText,
  escapeHtml,
  computeWordDiff,
  injectWordDiffMarkers,
} = __test__;

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
      ok(hunk);
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
      ok(hunk);

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
      ok(hunk);

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
      ok(hunk);

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
      ok(hunk);

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

    it("hides whitespace-only changes when requested", async () => {
      const augment = await computeEditAugment(
        "tool-whitespace-only",
        {
          file_path: "/test/file.ts",
          old_string: "const x = 1;\n\treturn x;\n",
          new_string: "const   x=1;\n  return   x;\n",
        },
        undefined,
        { ignoreWhitespace: true },
      );

      expect(augment.structuredPatch).toHaveLength(0);
    });

    it("keeps semantic changes and original context spacing", async () => {
      const augment = await computeEditAugment(
        "tool-ignore-whitespace",
        {
          file_path: "/test/file.ts",
          old_string: "const x = 1;\nkeep\n",
          new_string: "const   x=1;\nkeep changed\n",
        },
        undefined,
        { ignoreWhitespace: true },
      );

      expect(augment.structuredPatch).toHaveLength(1);
      const hunk = augment.structuredPatch[0];
      ok(hunk);
      expect(hunk.lines).toContain(" const   x=1;");
      expect(hunk.lines).toContain("-keep");
      expect(hunk.lines).toContain("+keep changed");
      expect(hunk.lines).not.toContain("-const x = 1;");
      expect(hunk.lines).not.toContain("+const   x=1;");
    });

    it("preserves line addressing in the whitespace projection", async () => {
      const augment = await computeEditAugment(
        "tool-ignore-whitespace-addresses",
        {
          file_path: "/test/file.ts",
          old_string: "one\n two\nthree\n",
          new_string: "one\n  two\nTHREE\n",
        },
        undefined,
        { ignoreWhitespace: true },
      );

      expect(augment.diffHtml.match(/data-diff-line=/g)?.length).toBe(
        patchLineCount(augment.structuredPatch),
      );
      expect(augment.structuredPatch[0]?.lines).toContain("   two");
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

    it("highlights only the hunk of a large file, keeping absolute coordinates", async () => {
      const lines = Array.from(
        { length: 12_000 },
        (_, index) => `const value${index} = ${index};`,
      );
      const oldCode = lines.join("\n");
      lines[6_000] = "const value6000 = 4242;";
      const newCode = lines.join("\n");

      const started = performance.now();
      const augment = await computeEditAugment("tool-big", {
        file_path: "/test/big.ts",
        old_string: oldCode,
        new_string: newCode,
      });
      const elapsedMs = performance.now() - started;

      // Real file coordinates survive excerpt highlighting.
      expect(augment.structuredPatch[0]?.newStart).toBe(5_998);
      expect(augment.diffHtml).toContain("@@ -5998,7 +5998,7 @@");

      // Both sides of the change render, syntax-highlighted, with their context.
      expect(augment.diffHtml).toContain("4242");
      expect(augment.diffHtml).toContain("6000");
      expect(augment.diffHtml).toContain("value5997");
      expect(augment.diffHtml).toContain('class="line line-deleted"');
      expect(augment.diffHtml).toContain('class="line line-inserted"');

      // Nothing outside the hunk is highlighted or shipped.
      expect(augment.diffHtml).not.toContain("value100");
      expect(augment.diffHtml.length).toBeLessThan(10_000);
      expect(elapsedMs).toBeLessThan(1_000);
    });

    it("highlights around a long line the diff does not touch", async () => {
      const minified = `const bundled = "${"x".repeat(30_000)}";`;
      const filler = Array.from(
        { length: 50 },
        (_, index) => `const spacer${index} = ${index};`,
      ).join("\n");
      const oldCode = `${minified}\n${filler}\nconst value = 1;`;
      const newCode = `${minified}\n${filler}\nconst value = 2;`;

      const started = performance.now();
      const augment = await computeEditAugment("tool-minified", {
        file_path: "/test/minified.ts",
        old_string: oldCode,
        new_string: newCode,
      });
      const elapsedMs = performance.now() - started;

      expect(augment.diffHtml).toContain('class="line line-inserted"');
      expect(augment.diffHtml).not.toContain("xxxxxxxxxx");
      expect(elapsedMs).toBeLessThan(1_000);
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

describe("computeStructuredPatchDiffHtml", () => {
  it("generates highlighted diff HTML from parsed raw patch hunks", async () => {
    const diffHtml = await computeStructuredPatchDiffHtml("/test/file.ts", [
      {
        oldStart: 42,
        oldLines: 2,
        newStart: 42,
        newLines: 2,
        lines: [
          " function greet(name: string) {",
          '-  return "hello";',
          '+  return "hello " + name;',
        ],
      },
    ]);

    expect(diffHtml).toBeTruthy();
    expect(diffHtml).toContain('class="line line-deleted"');
    expect(diffHtml).toContain('class="line line-inserted"');
    expect(diffHtml).toContain("<span style=");
  });

  it("falls back to diff highlighting when file language is unknown", async () => {
    const diffHtml = await computeStructuredPatchDiffHtml("", [
      {
        oldStart: 1,
        oldLines: 1,
        newStart: 1,
        newLines: 1,
        lines: ["-foo", "+bar"],
      },
    ]);

    expect(diffHtml).toBeTruthy();
    expect(diffHtml).toContain("<pre");
    expect(diffHtml).toContain('class="line line-deleted"');
    expect(diffHtml).toContain('class="line line-inserted"');
  });
});

describe("extractShikiLines", () => {
  it("extracts content from single line", () => {
    const html =
      '<pre class="shiki"><code><span class="line">content</span></code></pre>';
    const lines = extractShikiLines(html);
    expect(lines).toEqual(["content"]);
  });

  it("extracts content from multiple lines", () => {
    const html =
      '<pre class="shiki"><code><span class="line">line1</span>\n<span class="line">line2</span>\n<span class="line">line3</span></code></pre>';
    const lines = extractShikiLines(html);
    expect(lines).toEqual(["line1", "line2", "line3"]);
  });

  it("handles lines with nested spans (syntax tokens)", () => {
    const html =
      '<pre class="shiki"><code><span class="line"><span style="color:var(--shiki-token-keyword)">const</span> <span style="color:var(--shiki-token-constant)">x</span> = 1;</span></code></pre>';
    const lines = extractShikiLines(html);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("<span");
    expect(lines[0]).toContain("const");
  });

  it("handles empty lines", () => {
    const html =
      '<pre class="shiki"><code><span class="line">first</span>\n<span class="line"></span>\n<span class="line">third</span></code></pre>';
    const lines = extractShikiLines(html);
    expect(lines).toEqual(["first", "", "third"]);
  });

  it("handles deeply nested spans", () => {
    const html =
      '<pre class="shiki"><code><span class="line"><span class="outer"><span class="inner">deep</span></span></span></code></pre>';
    const lines = extractShikiLines(html);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("deep");
  });

  it("returns empty array for HTML without line spans", () => {
    const html = '<pre class="shiki"><code>no line spans here</code></pre>';
    const lines = extractShikiLines(html);
    expect(lines).toEqual([]);
  });

  it("handles malformed HTML with unclosed spans gracefully", () => {
    const html =
      '<pre class="shiki"><code><span class="line">content<span>unclosed</code></pre>';
    const lines = extractShikiLines(html);
    // Should handle gracefully without crashing
    expect(Array.isArray(lines)).toBe(true);
  });

  it("handles HTML with multiple class attributes on line span", () => {
    // Only matches class="line" exactly per current implementation
    const html =
      '<pre class="shiki"><code><span class="line highlight">highlighted line</span></code></pre>';
    const lines = extractShikiLines(html);
    // The regex looks for 'class="line"' exactly, so this won't match
    expect(lines).toEqual([]);
  });

  it("preserves HTML entities in content", () => {
    const html =
      '<pre class="shiki"><code><span class="line">&lt;div&gt;escaped&lt;/div&gt;</span></code></pre>';
    const lines = extractShikiLines(html);
    expect(lines[0]).toBe("&lt;div&gt;escaped&lt;/div&gt;");
  });
});

describe("addDiffLineClasses", () => {
  it("adds line-deleted class for lines starting with -", () => {
    const html =
      '<pre class="shiki"><code><span class="line">-removed line</span></code></pre>';
    const result = addDiffLineClasses(html);
    expect(result).toContain('class="line line-deleted"');
  });

  it("adds line-inserted class for lines starting with +", () => {
    const html =
      '<pre class="shiki"><code><span class="line">+added line</span></code></pre>';
    const result = addDiffLineClasses(html);
    expect(result).toContain('class="line line-inserted"');
  });

  it("adds line-context class for lines starting with space", () => {
    const html =
      '<pre class="shiki"><code><span class="line"> context line</span></code></pre>';
    const result = addDiffLineClasses(html);
    expect(result).toContain('class="line line-context"');
  });

  it("adds line-hunk class for lines starting with @", () => {
    const html =
      '<pre class="shiki"><code><span class="line">@@ -1,3 +1,4 @@</span></code></pre>';
    const result = addDiffLineClasses(html);
    expect(result).toContain('class="line line-hunk"');
  });

  it("handles HTML entities for detection", () => {
    // Content might have &lt; for < - verify it still detects correctly
    const html =
      '<pre class="shiki"><code><span class="line">+&lt;div&gt;</span></code></pre>';
    const result = addDiffLineClasses(html);
    expect(result).toContain('class="line line-inserted"');
  });

  it("keeps line class for unrecognized prefixes", () => {
    const html =
      '<pre class="shiki"><code><span class="line">regular text</span></code></pre>';
    const result = addDiffLineClasses(html);
    expect(result).toContain('class="line"');
    expect(result).not.toContain("line-deleted");
    expect(result).not.toContain("line-inserted");
    expect(result).not.toContain("line-context");
    expect(result).not.toContain("line-hunk");
  });

  it("handles multiple lines with different types", () => {
    const html =
      '<pre class="shiki"><code><span class="line">@@ -1,2 +1,2 @@</span>\n<span class="line">-old</span>\n<span class="line">+new</span>\n<span class="line"> same</span></code></pre>';
    const result = addDiffLineClasses(html);
    expect(result).toContain('class="line line-hunk"');
    expect(result).toContain('class="line line-deleted"');
    expect(result).toContain('class="line line-inserted"');
    expect(result).toContain('class="line line-context"');
  });

  it("handles lines with nested spans for syntax highlighting", () => {
    const html =
      '<pre class="shiki"><code><span class="line"><span style="color:red">-</span><span style="color:blue">deleted</span></span></code></pre>';
    const result = addDiffLineClasses(html);
    // Should detect the - prefix even with spans
    expect(result).toContain('class="line line-deleted"');
  });

  it("handles empty line content", () => {
    const html =
      '<pre class="shiki"><code><span class="line"></span></code></pre>';
    const result = addDiffLineClasses(html);
    // Empty line should just have "line" class
    expect(result).toContain('class="line"');
  });

  it("emits sequential data-diff-line on real lines, skipping hunk headers", () => {
    const html =
      '<pre class="shiki"><code><span class="line">@@ -1,2 +1,2 @@</span>\n<span class="line">-old</span>\n<span class="line">+new</span>\n<span class="line"> same</span>\n<span class="line">@@ -9,1 +9,1 @@</span>\n<span class="line">-x</span></code></pre>';
    const result = addDiffLineClasses(html);
    // Hunk headers carry no addressing.
    expect(result).not.toMatch(/line-hunk" data-diff-line/);
    // Real diff lines are numbered 0,1,2,3 in document order across hunks.
    expect(result).toContain('class="line line-deleted" data-diff-line="0"');
    expect(result).toContain('class="line line-inserted" data-diff-line="1"');
    expect(result).toContain('class="line line-context" data-diff-line="2"');
    expect(result).toContain('class="line line-deleted" data-diff-line="3"');
  });

  it("does not address unrecognized-prefix lines", () => {
    const html =
      '<pre class="shiki"><code><span class="line">regular text</span></code></pre>';
    const result = addDiffLineClasses(html);
    expect(result).not.toContain("data-diff-line");
  });
});

// The flat `data-diff-line` index the server emits must invert, via the shared
// `anchorFromPatch`, back to a location consistent with the rendered line —
// this is the P1↔P2 contract of source-review-to-session.
describe("data-diff-line addressing agrees with anchorFromPatch", () => {
  function extractAddressing(
    html: string,
  ): Array<{ cls: string; index: number }> {
    const re = /<span class="line (line-[\w-]+)" data-diff-line="(\d+)">/g;
    const out: Array<{ cls: string; index: number }> = [];
    let m: RegExpExecArray | null = re.exec(html);
    while (m !== null) {
      const [, cls, index] = m;
      ok(cls !== undefined && index !== undefined);
      out.push({ cls, index: Number(index) });
      m = re.exec(html);
    }
    return out;
  }

  it("addresses every real diff line with a contiguous 0..N-1 index", async () => {
    const augment = await computeEditAugment("tool-addr", {
      file_path: "/test/file.ts",
      old_string: "a\nb\nOLD\nc\nd",
      new_string: "a\nb\nNEW1\nNEW2\nc\nd",
    });
    const addr = extractAddressing(augment.diffHtml);
    expect(addr.length).toBe(patchLineCount(augment.structuredPatch));
    expect(addr.map((a) => a.index)).toEqual(
      Array.from({ length: addr.length }, (_, i) => i),
    );
  });

  it("each rendered line's side matches the inverted anchor", async () => {
    const augment = await computeEditAugment("tool-addr2", {
      file_path: "/test/file.ts",
      old_string: "keep1\nkeep2\nremoveme\nkeep3",
      new_string: "keep1\nkeep2\naddme\nkeep3\nkeep4",
    });
    const addr = extractAddressing(augment.diffHtml);
    expect(addr.length).toBeGreaterThan(0);
    for (const { cls, index } of addr) {
      const loc = anchorFromPatch(augment.structuredPatch, index);
      expect(loc).not.toBeNull();
      if (!loc) continue;
      if (cls === "line-deleted") {
        expect(loc.side).toBe("old");
        expect(loc.newLine).toBeNull();
        expect(loc.oldLine).not.toBeNull();
      } else if (cls === "line-inserted") {
        expect(loc.side).toBe("new");
        expect(loc.oldLine).toBeNull();
        expect(loc.newLine).not.toBeNull();
      } else if (cls === "line-context") {
        expect(loc.oldLine).not.toBeNull();
        expect(loc.newLine).not.toBeNull();
      }
    }
  });
});

describe("convertHunks", () => {
  it("converts jsdiff hunk format to PatchHunk format", () => {
    const jsdiffHunks = [
      {
        oldStart: 1,
        oldLines: 3,
        newStart: 1,
        newLines: 4,
        lines: [" context", "-old", "+new1", "+new2", " context2"],
      },
    ];

    const result = convertHunks(jsdiffHunks);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      oldStart: 1,
      oldLines: 3,
      newStart: 1,
      newLines: 4,
      lines: [" context", "-old", "+new1", "+new2", " context2"],
    });
  });

  it("filters out 'No newline at end of file' marker", () => {
    const jsdiffHunks = [
      {
        oldStart: 1,
        oldLines: 1,
        newStart: 1,
        newLines: 1,
        lines: ["-old", "+new", "\\ No newline at end of file"],
      },
    ];

    const result = convertHunks(jsdiffHunks);

    const [hunk] = result;
    ok(hunk);
    expect(hunk.lines).toEqual(["-old", "+new"]);
    expect(hunk.lines).not.toContain("\\ No newline at end of file");
  });

  it("handles multiple hunks", () => {
    const jsdiffHunks = [
      {
        oldStart: 1,
        oldLines: 2,
        newStart: 1,
        newLines: 2,
        lines: ["-a", "+b"],
      },
      {
        oldStart: 10,
        oldLines: 1,
        newStart: 10,
        newLines: 1,
        lines: ["-x", "+y"],
      },
    ];

    const result = convertHunks(jsdiffHunks);

    expect(result).toHaveLength(2);
    expect(result.map((hunk) => hunk.oldStart)).toEqual([1, 10]);
  });

  it("handles empty hunks array", () => {
    const result = convertHunks([]);
    expect(result).toEqual([]);
  });

  it("handles hunk with only context lines", () => {
    const jsdiffHunks = [
      {
        oldStart: 5,
        oldLines: 3,
        newStart: 5,
        newLines: 3,
        lines: [" line1", " line2", " line3"],
      },
    ];

    const result = convertHunks(jsdiffHunks);

    expect(result).toMatchObject([{ lines: [" line1", " line2", " line3"] }]);
  });
});

describe("patchToUnifiedText", () => {
  it("generates unified diff text from hunks", () => {
    const hunks = [
      {
        oldStart: 1,
        oldLines: 3,
        newStart: 1,
        newLines: 4,
        lines: [" context", "-old", "+new1", "+new2"],
      },
    ];

    const result = patchToUnifiedText(hunks);

    expect(result).toBe("@@ -1,3 +1,4 @@\n context\n-old\n+new1\n+new2");
  });

  it("handles multiple hunks", () => {
    const hunks = [
      {
        oldStart: 1,
        oldLines: 1,
        newStart: 1,
        newLines: 1,
        lines: ["-a", "+b"],
      },
      {
        oldStart: 10,
        oldLines: 1,
        newStart: 10,
        newLines: 1,
        lines: ["-x", "+y"],
      },
    ];

    const result = patchToUnifiedText(hunks);

    expect(result).toContain("@@ -1,1 +1,1 @@");
    expect(result).toContain("@@ -10,1 +10,1 @@");
    expect(result).toContain("-a");
    expect(result).toContain("+b");
    expect(result).toContain("-x");
    expect(result).toContain("+y");
  });

  it("returns empty string for empty hunks", () => {
    const result = patchToUnifiedText([]);
    expect(result).toBe("");
  });

  it("preserves line content exactly", () => {
    const hunks = [
      {
        oldStart: 1,
        oldLines: 1,
        newStart: 1,
        newLines: 1,
        lines: ["-const x = 1;", "+const x = 2;"],
      },
    ];

    const result = patchToUnifiedText(hunks);

    expect(result).toContain("-const x = 1;");
    expect(result).toContain("+const x = 2;");
  });
});

describe("escapeHtml", () => {
  it("escapes ampersand", () => {
    expect(escapeHtml("a & b")).toBe("a &amp; b");
  });

  it("escapes less than", () => {
    expect(escapeHtml("<div>")).toBe("&lt;div&gt;");
  });

  it("escapes greater than", () => {
    expect(escapeHtml("a > b")).toBe("a &gt; b");
  });

  it("escapes double quotes", () => {
    expect(escapeHtml('say "hello"')).toBe("say &quot;hello&quot;");
  });

  it("escapes single quotes", () => {
    expect(escapeHtml("it's")).toBe("it&#039;s");
  });

  it("escapes all special characters together", () => {
    expect(escapeHtml('<a href="test">it\'s a & b</a>')).toBe(
      "&lt;a href=&quot;test&quot;&gt;it&#039;s a &amp; b&lt;/a&gt;",
    );
  });

  it("returns empty string for empty input", () => {
    expect(escapeHtml("")).toBe("");
  });

  it("leaves regular text unchanged", () => {
    expect(escapeHtml("hello world 123")).toBe("hello world 123");
  });

  it("handles unicode characters", () => {
    expect(escapeHtml("emoji: 😀 & more")).toBe("emoji: 😀 &amp; more");
  });

  it("handles multiple consecutive special characters", () => {
    expect(escapeHtml("<<>>&&")).toBe("&lt;&lt;&gt;&gt;&amp;&amp;");
  });
});

describe("computeWordDiff", () => {
  it("returns single unchanged segment for identical strings", () => {
    const result = computeWordDiff("hello world", "hello world");
    expect(result).toEqual([{ text: "hello world", type: "unchanged" }]);
  });

  it("handles single word change", () => {
    const result = computeWordDiff("const x = 1", "const y = 1");
    expect(result).toEqual([
      { text: "const ", type: "unchanged" },
      { text: "x", type: "removed" },
      { text: "y", type: "added" },
      { text: " = 1", type: "unchanged" },
    ]);
  });

  it("handles word addition", () => {
    const result = computeWordDiff("a b", "a b c");
    // diffWordsWithSpace keeps whitespace separate, so " c" is added (space + word)
    expect(result).toEqual([
      { text: "a b", type: "unchanged" },
      { text: " c", type: "added" },
    ]);
  });

  it("handles word removal", () => {
    const result = computeWordDiff("a b c", "a b");
    expect(result).toEqual([
      { text: "a b", type: "unchanged" },
      { text: " c", type: "removed" },
    ]);
  });

  it("handles multiple changes", () => {
    const result = computeWordDiff("one two three", "one TWO THREE");
    // diffWordsWithSpace treats each word and space separately
    expect(result).toEqual([
      { text: "one ", type: "unchanged" },
      { text: "two", type: "removed" },
      { text: "TWO", type: "added" },
      { text: " ", type: "unchanged" },
      { text: "three", type: "removed" },
      { text: "THREE", type: "added" },
    ]);
  });

  it("handles both strings empty", () => {
    const result = computeWordDiff("", "");
    expect(result).toEqual([]);
  });

  it("handles empty old string", () => {
    const result = computeWordDiff("", "new content");
    expect(result).toEqual([{ text: "new content", type: "added" }]);
  });

  it("handles empty new string", () => {
    const result = computeWordDiff("old content", "");
    expect(result).toEqual([{ text: "old content", type: "removed" }]);
  });

  it("preserves whitespace correctly", () => {
    const result = computeWordDiff("  hello  ", "  world  ");
    // diffWordsWithSpace treats leading/trailing whitespace as separate unchanged segments
    expect(result).toEqual([
      { text: "  ", type: "unchanged" },
      { text: "hello", type: "removed" },
      { text: "world", type: "added" },
      { text: "  ", type: "unchanged" },
    ]);
  });

  it("handles punctuation as separate tokens", () => {
    const result = computeWordDiff("foo.bar", "foo.baz");
    // jsdiff treats punctuation as word boundaries
    expect(result.some((s) => s.text === "bar" && s.type === "removed")).toBe(
      true,
    );
    expect(result.some((s) => s.text === "baz" && s.type === "added")).toBe(
      true,
    );
  });

  it("handles full line replacement", () => {
    const result = computeWordDiff(
      "completely different text",
      "totally new content",
    );
    // Should have removed and added segments
    expect(result.some((s) => s.type === "removed")).toBe(true);
    expect(result.some((s) => s.type === "added")).toBe(true);
    // Concatenated segments should form the original and new strings
    const removedText = result
      .filter((s) => s.type === "removed" || s.type === "unchanged")
      .map((s) => s.text)
      .join("");
    const addedText = result
      .filter((s) => s.type === "added" || s.type === "unchanged")
      .map((s) => s.text)
      .join("");
    expect(removedText).toBe("completely different text");
    expect(addedText).toBe("totally new content");
  });

  it("handles code-like content with operators", () => {
    const result = computeWordDiff("x = 1 + 2", "x = 1 + 3");
    expect(result.some((s) => s.text === "2" && s.type === "removed")).toBe(
      true,
    );
    expect(result.some((s) => s.text === "3" && s.type === "added")).toBe(true);
  });
});

describe("findReplacePairs", () => {
  const { findReplacePairs } = __test__;

  it("simple 1:1 replacement - one - followed by one +", () => {
    const result = findReplacePairs([" ctx", "-old", "+new", " ctx2"]);
    expect(result.pairs).toEqual([
      { oldLineIndex: 0, newLineIndex: 0, oldText: "old", newText: "new" },
    ]);
    expect(result.unpairedRemovals).toEqual([]);
    expect(result.unpairedAdditions).toEqual([]);
  });

  it("multiple 1:1 replacements - two - followed by two +", () => {
    const result = findReplacePairs([
      " ctx",
      "-old1",
      "-old2",
      "+new1",
      "+new2",
      " ctx",
    ]);
    expect(result.pairs).toEqual([
      { oldLineIndex: 0, newLineIndex: 0, oldText: "old1", newText: "new1" },
      { oldLineIndex: 1, newLineIndex: 1, oldText: "old2", newText: "new2" },
    ]);
    expect(result.unpairedRemovals).toEqual([]);
    expect(result.unpairedAdditions).toEqual([]);
  });

  it("more removals than additions - 3 - followed by 1 + (2 unpaired removals)", () => {
    const result = findReplacePairs([
      " ctx",
      "-old1",
      "-old2",
      "-old3",
      "+new1",
      " ctx",
    ]);
    expect(result.pairs).toEqual([
      { oldLineIndex: 0, newLineIndex: 0, oldText: "old1", newText: "new1" },
    ]);
    expect(result.unpairedRemovals).toEqual([
      { index: 1, text: "old2" },
      { index: 2, text: "old3" },
    ]);
    expect(result.unpairedAdditions).toEqual([]);
  });

  it("more additions than removals - 1 - followed by 3 + (2 unpaired additions)", () => {
    const result = findReplacePairs([
      " ctx",
      "-old1",
      "+new1",
      "+new2",
      "+new3",
      " ctx",
    ]);
    expect(result.pairs).toEqual([
      { oldLineIndex: 0, newLineIndex: 0, oldText: "old1", newText: "new1" },
    ]);
    expect(result.unpairedRemovals).toEqual([]);
    expect(result.unpairedAdditions).toEqual([
      { index: 1, text: "new2" },
      { index: 2, text: "new3" },
    ]);
  });

  it("pure addition - only + lines (all unpaired)", () => {
    const result = findReplacePairs([" ctx", "+new1", "+new2", " ctx"]);
    expect(result.pairs).toEqual([]);
    expect(result.unpairedRemovals).toEqual([]);
    expect(result.unpairedAdditions).toEqual([
      { index: 0, text: "new1" },
      { index: 1, text: "new2" },
    ]);
  });

  it("pure deletion - only - lines (all unpaired)", () => {
    const result = findReplacePairs([" ctx", "-old1", "-old2", " ctx"]);
    expect(result.pairs).toEqual([]);
    expect(result.unpairedRemovals).toEqual([
      { index: 0, text: "old1" },
      { index: 1, text: "old2" },
    ]);
    expect(result.unpairedAdditions).toEqual([]);
  });

  it("context breaks replacement - -, space, + should NOT pair", () => {
    const result = findReplacePairs(["-old", " context", "+new"]);
    expect(result.pairs).toEqual([]);
    expect(result.unpairedRemovals).toEqual([{ index: 0, text: "old" }]);
    expect(result.unpairedAdditions).toEqual([{ index: 0, text: "new" }]);
  });

  it("multiple replacement groups - -, +, space, -, + (two separate pairs)", () => {
    const result = findReplacePairs([
      "-old1",
      "+new1",
      " context",
      "-old2",
      "+new2",
    ]);
    expect(result.pairs).toEqual([
      { oldLineIndex: 0, newLineIndex: 0, oldText: "old1", newText: "new1" },
      { oldLineIndex: 0, newLineIndex: 0, oldText: "old2", newText: "new2" },
    ]);
    expect(result.unpairedRemovals).toEqual([]);
    expect(result.unpairedAdditions).toEqual([]);
  });

  it("hunk header - lines starting with @@ are skipped", () => {
    const result = findReplacePairs([
      "@@ -1,2 +1,2 @@",
      "-old",
      "+new",
      "@@ -10,1 +10,1 @@",
      "-old2",
      "+new2",
    ]);
    expect(result.pairs).toEqual([
      { oldLineIndex: 0, newLineIndex: 0, oldText: "old", newText: "new" },
      { oldLineIndex: 0, newLineIndex: 0, oldText: "old2", newText: "new2" },
    ]);
    expect(result.unpairedRemovals).toEqual([]);
    expect(result.unpairedAdditions).toEqual([]);
  });

  it("empty input - returns empty arrays", () => {
    const result = findReplacePairs([]);
    expect(result.pairs).toEqual([]);
    expect(result.unpairedRemovals).toEqual([]);
    expect(result.unpairedAdditions).toEqual([]);
  });

  it("only context lines - returns empty arrays", () => {
    const result = findReplacePairs([" line1", " line2", " line3"]);
    expect(result.pairs).toEqual([]);
    expect(result.unpairedRemovals).toEqual([]);
    expect(result.unpairedAdditions).toEqual([]);
  });
});

describe("computeEditAugment with word-level diffs", () => {
  it("includes word diff markers in diffHtml for simple replacement", async () => {
    const augment = await computeEditAugment("tool-word", {
      file_path: "/test/file.ts",
      old_string: "const x = 1;",
      new_string: "const y = 2;",
    });

    // Should have word-level markers for the changed parts
    expect(augment.diffHtml).toContain('class="diff-word-removed"');
    expect(augment.diffHtml).toContain('class="diff-word-added"');
  });

  it("does not add word diff markers for pure additions", async () => {
    const augment = await computeEditAugment("tool-add", {
      file_path: "/test/file.ts",
      old_string: "",
      new_string: "new line",
    });

    // Pure addition - no word diff (no paired lines)
    expect(augment.diffHtml).not.toContain('class="diff-word-');
  });

  it("does not add word diff markers for pure deletions", async () => {
    const augment = await computeEditAugment("tool-del", {
      file_path: "/test/file.ts",
      old_string: "old line",
      new_string: "",
    });

    // Pure deletion - no word diff (no paired lines)
    expect(augment.diffHtml).not.toContain('class="diff-word-');
  });

  it("handles multi-line replacements with word diffs", async () => {
    const augment = await computeEditAugment("tool-multi", {
      file_path: "/test/file.ts",
      old_string: "const a = 1;\nconst b = 2;",
      new_string: "const a = 10;\nconst c = 2;",
    });

    // Should have word-level markers for the changed parts
    expect(augment.diffHtml).toContain('class="diff-word-removed"');
    expect(augment.diffHtml).toContain('class="diff-word-added"');
  });

  it("does not add word diff markers when lines are identical", async () => {
    const augment = await computeEditAugment("tool-same", {
      file_path: "/test/file.ts",
      old_string: "const x = 1;",
      new_string: "const x = 1;",
    });

    // No changes, no hunks, no word diff markers
    expect(augment.diffHtml).not.toContain('class="diff-word-');
  });

  it("applies word diff markers to syntax-highlighted code", async () => {
    const augment = await computeEditAugment("tool-syntax", {
      file_path: "/test/file.ts",
      old_string: "const foo = 'hello';",
      new_string: "const bar = 'hello';",
    });

    // Should have shiki highlighting and word diff markers
    expect(augment.diffHtml).toContain("shiki");
    expect(augment.diffHtml).toContain('class="diff-word-removed"');
    expect(augment.diffHtml).toContain('class="diff-word-added"');
    // The actual changed tokens should be wrapped
    expect(augment.diffHtml).toContain("foo");
    expect(augment.diffHtml).toContain("bar");
  });

  it("handles context lines without word diff markers", async () => {
    const oldCode = "line1\nchanged old\nline3";
    const newCode = "line1\nchanged new\nline3";

    const augment = await computeEditAugment("tool-context", {
      file_path: "/test/file.ts",
      old_string: oldCode,
      new_string: newCode,
    });

    // Should have context lines without word diff markers
    expect(augment.diffHtml).toContain('class="line line-context"');
    // Word diff should only be in the changed line
    expect(augment.diffHtml).toContain('class="diff-word-removed"');
    expect(augment.diffHtml).toContain('class="diff-word-added"');
  });

  it("handles replacements separated by context lines", async () => {
    const oldCode = "first old\ncontext1\ncontext2\ncontext3\nsecond old";
    const newCode = "first new\ncontext1\ncontext2\ncontext3\nsecond new";

    const augment = await computeEditAugment("tool-separated", {
      file_path: "/test/file.ts",
      old_string: oldCode,
      new_string: newCode,
    });

    // Both replacement pairs should have word diff markers
    const removedMatches = augment.diffHtml.match(/class="diff-word-removed"/g);
    const addedMatches = augment.diffHtml.match(/class="diff-word-added"/g);

    // Should have markers for both changed lines
    expect(removedMatches?.length).toBeGreaterThanOrEqual(2);
    expect(addedMatches?.length).toBeGreaterThanOrEqual(2);
  });
});

describe("injectWordDiffMarkers", () => {
  // Helper to create word diff segments
  const unchanged = (text: string): WordDiffSegment => ({
    text,
    type: "unchanged",
  });
  const removed = (text: string): WordDiffSegment => ({
    text,
    type: "removed",
  });
  const added = (text: string): WordDiffSegment => ({ text, type: "added" });

  describe("plain text (no HTML tags)", () => {
    it("wraps removed word in old mode", () => {
      const html = "const x = 1";
      const wordDiff = [
        unchanged("const "),
        removed("x"),
        added("y"),
        unchanged(" = 1"),
      ];
      const result = injectWordDiffMarkers(html, wordDiff, "old");
      expect(result).toBe('const <span class="diff-word-removed">x</span> = 1');
    });

    it("wraps added word in new mode", () => {
      const html = "const y = 1";
      const wordDiff = [
        unchanged("const "),
        removed("x"),
        added("y"),
        unchanged(" = 1"),
      ];
      const result = injectWordDiffMarkers(html, wordDiff, "new");
      expect(result).toBe('const <span class="diff-word-added">y</span> = 1');
    });

    it("returns unchanged HTML when no changes match mode", () => {
      const html = "const x = 1";
      const wordDiff = [unchanged("const x = 1")];
      const result = injectWordDiffMarkers(html, wordDiff, "old");
      expect(result).toBe("const x = 1");
    });
  });

  describe("single token fully changed", () => {
    it("wraps entire token content when fully removed", () => {
      const html = '<span style="color:red">old</span>';
      const wordDiff = [removed("old"), added("new")];
      const result = injectWordDiffMarkers(html, wordDiff, "old");
      expect(result).toBe(
        '<span style="color:red"><span class="diff-word-removed">old</span></span>',
      );
    });

    it("wraps entire token content when fully added", () => {
      const html = '<span style="color:red">new</span>';
      const wordDiff = [removed("old"), added("new")];
      const result = injectWordDiffMarkers(html, wordDiff, "new");
      expect(result).toBe(
        '<span style="color:red"><span class="diff-word-added">new</span></span>',
      );
    });
  });

  describe("partial token change", () => {
    it("wraps only changed portion within token", () => {
      const html = '<span style="color:blue">hello world</span>';
      const wordDiff = [unchanged("hello "), removed("world"), added("there")];
      const result = injectWordDiffMarkers(html, wordDiff, "old");
      expect(result).toBe(
        '<span style="color:blue">hello <span class="diff-word-removed">world</span></span>',
      );
    });

    it("handles change at start of token", () => {
      const html = '<span style="color:blue">hello world</span>';
      const wordDiff = [removed("hello"), added("hi"), unchanged(" world")];
      const result = injectWordDiffMarkers(html, wordDiff, "old");
      expect(result).toBe(
        '<span style="color:blue"><span class="diff-word-removed">hello</span> world</span>',
      );
    });
  });

  describe("change spans multiple tokens", () => {
    it("wraps each token portion separately", () => {
      const html =
        '<span style="color:red">const</span> <span style="color:blue">x</span>';
      const wordDiff = [removed("const x"), added("let y")];
      const result = injectWordDiffMarkers(html, wordDiff, "old");
      // The entire "const x" should be wrapped, but respecting HTML structure
      expect(result).toContain('class="diff-word-removed"');
      expect(result).toContain("const");
      expect(result).toContain("x");
    });
  });

  describe("multiple changes in one line", () => {
    it("wraps all removed segments", () => {
      const html = "a b c d e";
      const wordDiff = [
        unchanged("a "),
        removed("b"),
        added("B"),
        unchanged(" c "),
        removed("d"),
        added("D"),
        unchanged(" e"),
      ];
      const result = injectWordDiffMarkers(html, wordDiff, "old");
      expect(result).toBe(
        'a <span class="diff-word-removed">b</span> c <span class="diff-word-removed">d</span> e',
      );
    });

    it("wraps all added segments", () => {
      const html = "a B c D e";
      const wordDiff = [
        unchanged("a "),
        removed("b"),
        added("B"),
        unchanged(" c "),
        removed("d"),
        added("D"),
        unchanged(" e"),
      ];
      const result = injectWordDiffMarkers(html, wordDiff, "new");
      expect(result).toBe(
        'a <span class="diff-word-added">B</span> c <span class="diff-word-added">D</span> e',
      );
    });
  });

  describe("no changes", () => {
    it("returns HTML unchanged when word diff is all unchanged", () => {
      const html = '<span style="color:red">hello</span> world';
      const wordDiff = [unchanged("hello world")];
      const result = injectWordDiffMarkers(html, wordDiff, "old");
      expect(result).toBe(html);
    });

    it("returns only text for the given mode when no segments to highlight", () => {
      // The HTML "hello world" represents the NEW line (with the addition)
      // But in old mode, we only want to render "hello " (unchanged portions)
      const html = "hello ";
      const wordDiff = [unchanged("hello "), added("world")]; // Only addition, no removal
      const result = injectWordDiffMarkers(html, wordDiff, "old");
      // In old mode, we render unchanged + removed - since there are no removed segments, just unchanged
      expect(result).toBe("hello ");
    });
  });

  describe("empty segments", () => {
    it("handles empty word diff array", () => {
      // Empty word diff means no text to render - should return empty string
      // The html param is irrelevant when wordDiff is empty
      const html = "";
      const result = injectWordDiffMarkers(html, [], "old");
      expect(result).toBe("");
    });

    it("handles empty strings in segments", () => {
      const html = "hello";
      const wordDiff = [unchanged(""), unchanged("hello"), unchanged("")];
      const result = injectWordDiffMarkers(html, wordDiff, "old");
      expect(result).toBe("hello");
    });

    it("handles empty HTML input", () => {
      const html = "";
      const wordDiff = [unchanged("")];
      const result = injectWordDiffMarkers(html, wordDiff, "old");
      expect(result).toBe("");
    });
  });

  describe("HTML entities", () => {
    it("handles &lt; entity correctly", () => {
      const html = "a &lt; b";
      const wordDiff = [
        unchanged("a "),
        removed("<"),
        added(">"),
        unchanged(" b"),
      ];
      const result = injectWordDiffMarkers(html, wordDiff, "old");
      expect(result).toBe('a <span class="diff-word-removed">&lt;</span> b');
    });

    it("handles &gt; entity correctly", () => {
      const html = "a &gt; b";
      const wordDiff = [
        unchanged("a "),
        removed(">"),
        added("<"),
        unchanged(" b"),
      ];
      const result = injectWordDiffMarkers(html, wordDiff, "old");
      expect(result).toBe('a <span class="diff-word-removed">&gt;</span> b');
    });

    it("handles &amp; entity correctly", () => {
      const html = "a &amp; b";
      const wordDiff = [
        unchanged("a "),
        removed("&"),
        added("|"),
        unchanged(" b"),
      ];
      const result = injectWordDiffMarkers(html, wordDiff, "old");
      expect(result).toBe('a <span class="diff-word-removed">&amp;</span> b');
    });

    it("handles &quot; entity correctly", () => {
      const html = "say &quot;hello&quot;";
      const wordDiff = [
        unchanged('say "'),
        removed("hello"),
        added("world"),
        unchanged('"'),
      ];
      const result = injectWordDiffMarkers(html, wordDiff, "old");
      expect(result).toBe(
        'say &quot;<span class="diff-word-removed">hello</span>&quot;',
      );
    });

    it("handles multiple entities in changed text", () => {
      const html = "&lt;div&gt;";
      const wordDiff = [removed("<div>"), added("<span>")];
      const result = injectWordDiffMarkers(html, wordDiff, "old");
      expect(result).toBe('<span class="diff-word-removed">&lt;div&gt;</span>');
    });

    it("handles hex entity &#x3C; (Shiki-style < encoding)", () => {
      const html = "a &#x3C; b";
      const wordDiff = [
        unchanged("a "),
        removed("<"),
        added(">"),
        unchanged(" b"),
      ];
      const result = injectWordDiffMarkers(html, wordDiff, "old");
      expect(result).toBe('a <span class="diff-word-removed">&#x3C;</span> b');
    });

    it("handles hex entity &#x26; (Shiki-style & encoding)", () => {
      const html = "a &#x26; b";
      const wordDiff = [
        unchanged("a "),
        removed("&"),
        added("|"),
        unchanged(" b"),
      ];
      const result = injectWordDiffMarkers(html, wordDiff, "old");
      expect(result).toBe('a <span class="diff-word-removed">&#x26;</span> b');
    });

    it("handles decimal entity &#60; (decimal < encoding)", () => {
      const html = "a &#60; b";
      const wordDiff = [
        unchanged("a "),
        removed("<"),
        added(">"),
        unchanged(" b"),
      ];
      const result = injectWordDiffMarkers(html, wordDiff, "old");
      expect(result).toBe('a <span class="diff-word-removed">&#60;</span> b');
    });

    it("handles mixed hex and named entities", () => {
      const html = "&#x3C;div&#x3E; &amp; more";
      const wordDiff = [
        removed("<div>"),
        added("<span>"),
        unchanged(" & more"),
      ];
      const result = injectWordDiffMarkers(html, wordDiff, "old");
      expect(result).toBe(
        '<span class="diff-word-removed">&#x3C;div&#x3E;</span> &amp; more',
      );
    });
  });

  describe("nested spans", () => {
    it("handles shiki nested span structure", () => {
      const html =
        '<span style="color:var(--shiki-token-keyword)">const</span> <span style="color:var(--shiki-token-constant)">x</span> = 1';
      const wordDiff = [
        unchanged("const "),
        removed("x"),
        added("y"),
        unchanged(" = 1"),
      ];
      const result = injectWordDiffMarkers(html, wordDiff, "old");
      expect(result).toContain('<span class="diff-word-removed">x</span>');
      expect(result).toContain(
        '<span style="color:var(--shiki-token-keyword)">const</span>',
      );
    });

    it("handles deeply nested spans", () => {
      const html = '<span class="outer"><span class="inner">text</span></span>';
      const wordDiff = [removed("text"), added("new")];
      const result = injectWordDiffMarkers(html, wordDiff, "old");
      expect(result).toBe(
        '<span class="outer"><span class="inner"><span class="diff-word-removed">text</span></span></span>',
      );
    });
  });

  describe("mode old vs new", () => {
    const wordDiff = [
      unchanged("a "),
      removed("old"),
      added("new"),
      unchanged(" b"),
    ];

    it("applies diff-word-removed class in old mode", () => {
      const html = "a old b";
      const result = injectWordDiffMarkers(html, wordDiff, "old");
      expect(result).toContain('class="diff-word-removed"');
      expect(result).not.toContain('class="diff-word-added"');
    });

    it("applies diff-word-added class in new mode", () => {
      const html = "a new b";
      const result = injectWordDiffMarkers(html, wordDiff, "new");
      expect(result).toContain('class="diff-word-added"');
      expect(result).not.toContain('class="diff-word-removed"');
    });
  });

  describe("edge cases", () => {
    it("handles whitespace-only changes", () => {
      const html = "a  b";
      const wordDiff = [
        unchanged("a"),
        removed("  "),
        added(" "),
        unchanged("b"),
      ];
      const result = injectWordDiffMarkers(html, wordDiff, "old");
      expect(result).toBe('a<span class="diff-word-removed">  </span>b');
    });

    it("handles unicode content", () => {
      const html = "hello 😀 world";
      const wordDiff = [
        unchanged("hello "),
        removed("😀"),
        added("🎉"),
        unchanged(" world"),
      ];
      const result = injectWordDiffMarkers(html, wordDiff, "old");
      expect(result).toBe(
        'hello <span class="diff-word-removed">😀</span> world',
      );
    });

    it("handles consecutive removed segments", () => {
      const html = "abc";
      const wordDiff = [removed("a"), removed("b"), removed("c")];
      const result = injectWordDiffMarkers(html, wordDiff, "old");
      expect(result).toBe(
        '<span class="diff-word-removed">a</span><span class="diff-word-removed">b</span><span class="diff-word-removed">c</span>',
      );
    });

    it("handles text before any HTML tags", () => {
      const html = 'prefix <span style="color:red">suffix</span>';
      const wordDiff = [
        removed("prefix"),
        added("PREFIX"),
        unchanged(" suffix"),
      ];
      const result = injectWordDiffMarkers(html, wordDiff, "old");
      expect(result).toBe(
        '<span class="diff-word-removed">prefix</span> <span style="color:red">suffix</span>',
      );
    });
  });
});

describe("whole-file highlighting arrives without blocking the first diff", () => {
  // A change inside a docstring, with the opening `"""` far enough above the
  // hunk that the 3 context lines do not reach it. Tokenizing only the hunk
  // lines therefore starts outside the string and reads the prose word
  // `import` as a keyword.
  const docstringFile = (marker: string) =>
    [
      "def load(path):",
      '    """Read the config.',
      "",
      "    Notes:",
      "        the import keyword here is prose, not code",
      "        more prose",
      "        more prose",
      `        ${marker}`,
      '    """',
      "    return open(path).read()",
    ].join("\n");

  const before = docstringFile("OLD");
  const after = docstringFile("NEW");

  /** Whether `import` was emitted as its own token, i.e. coloured as code. */
  const colouredAsKeyword = (html: string) =>
    /<span[^>]*>import<\/span>/.test(html);

  it("upgrades a docstring hunk to exact colouring on a later read", async () => {
    __test__.clearHighlightCache();

    const first = await computeEditAugment("tool-cold", {
      file_path: "cfg.py",
      old_string: before,
      new_string: after,
    });
    // First look is the excerpt: fast, and wrong about the docstring.
    expect(colouredAsKeyword(first.diffHtml)).toBe(true);

    // The whole-file tokenization it scheduled lands off the request path.
    await new Promise((resolve) => setTimeout(resolve, 200));

    const later = await computeEditAugment("tool-warm", {
      file_path: "cfg.py",
      old_string: before,
      new_string: after,
    });
    expect(colouredAsKeyword(later.diffHtml)).toBe(false);
    expect(later.structuredPatch).toEqual(first.structuredPatch);
  });

  it("keeps diff line identity stable across that upgrade", async () => {
    __test__.clearHighlightCache();

    const first = await computeEditAugment("tool-a", {
      file_path: "cfg.py",
      old_string: before,
      new_string: after,
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    const later = await computeEditAugment("tool-b", {
      file_path: "cfg.py",
      old_string: before,
      new_string: after,
    });

    const lineIds = (html: string) =>
      [...html.matchAll(/data-diff-line="(\d+)"/g)].map((m) => m[1]);
    // Comment anchors key off these, so the upgrade must not renumber them.
    expect(lineIds(later.diffHtml)).toEqual(lineIds(first.diffHtml));
  });
});
