import { describe, expect, it } from "vitest";
import { createAugmentGenerator } from "../../src/augments/augment-generator.js";
import { BlockDetector } from "../../src/augments/block-detector.js";
import { renderMarkdownToHtml } from "../../src/augments/markdown-augments.js";

/**
 * These tests verify that the streaming rendering path produces identical
 * output to the reload rendering path. This ensures that:
 * 1. Code blocks have the same syntax highlighting
 * 2. Text formatting is identical
 * 3. Users see consistent content whether streaming or reloading
 */
describe("markdown-augments", () => {
  describe("renderMarkdownToHtml", () => {
    it("renders empty string for empty input", async () => {
      const result = await renderMarkdownToHtml("");
      expect(result).toBe("");
    });

    it("renders empty string for whitespace-only input", async () => {
      const result = await renderMarkdownToHtml("   \n\n  ");
      expect(result).toBe("");
    });

    it("renders a simple paragraph", async () => {
      const markdown = "Hello, world!";
      const result = await renderMarkdownToHtml(markdown);
      expect(result).toContain("Hello, world!");
      expect(result).toContain("<p>");
    });

    it("renders a code block with syntax highlighting", async () => {
      const markdown = "```typescript\nconst x = 1;\n```";
      const result = await renderMarkdownToHtml(markdown);
      // Should contain shiki-highlighted code (CSS variables theme)
      expect(result).toContain("<pre");
      expect(result).toContain("const");
    });

    it("renders multiple blocks", async () => {
      const markdown = `# Heading

Some text here.

\`\`\`javascript
function foo() {}
\`\`\`

More text.`;
      const result = await renderMarkdownToHtml(markdown);
      expect(result).toContain("<h1");
      expect(result).toContain("Some text");
      expect(result).toContain("<pre");
      expect(result).toContain("More text");
    });
  });

  describe("streaming vs reload consistency", () => {
    /**
     * Helper to simulate the streaming path by feeding markdown to
     * BlockDetector and processing with AugmentGenerator.
     */
    async function renderViaStreaming(markdown: string): Promise<string> {
      const generator = await createAugmentGenerator({
        languages: [
          "javascript",
          "typescript",
          "python",
          "bash",
          "json",
          "css",
          "html",
        ],
        theme: "github-dark",
      });

      const detector = new BlockDetector();
      const completedBlocks = detector.feed(markdown);
      const finalBlocks = detector.flush();
      const allBlocks = [...completedBlocks, ...finalBlocks];

      const htmlParts: string[] = [];
      for (let i = 0; i < allBlocks.length; i++) {
        const block = allBlocks[i];
        if (!block) continue;
        const augment = await generator.processBlock(block, i);
        htmlParts.push(augment.html);
      }

      return htmlParts.join("\n");
    }

    it("produces identical output for simple paragraph", async () => {
      const markdown = "Hello, world!";
      const streamingOutput = await renderViaStreaming(markdown);
      const reloadOutput = await renderMarkdownToHtml(markdown);

      expect(streamingOutput).toBe(reloadOutput);
    });

    it("produces identical output for code block", async () => {
      const markdown = "```typescript\nconst x: number = 42;\n```";
      const streamingOutput = await renderViaStreaming(markdown);
      const reloadOutput = await renderMarkdownToHtml(markdown);

      expect(streamingOutput).toBe(reloadOutput);
    });

    it("produces identical output for multiple blocks", async () => {
      const markdown = `# Getting Started

This is some introductory text.

\`\`\`javascript
function greet(name) {
  return \`Hello, \${name}!\`;
}
\`\`\`

That's how you define a function.

## Next Steps

- Learn more
- Practice`;

      const streamingOutput = await renderViaStreaming(markdown);
      const reloadOutput = await renderMarkdownToHtml(markdown);

      expect(streamingOutput).toBe(reloadOutput);
    });

    it("produces identical output for blockquote", async () => {
      const markdown = "> This is a quote\n> spanning multiple lines";
      const streamingOutput = await renderViaStreaming(markdown);
      const reloadOutput = await renderMarkdownToHtml(markdown);

      expect(streamingOutput).toBe(reloadOutput);
    });

    it("produces identical output for bullet list", async () => {
      const markdown = "- First item\n- Second item\n- Third item";
      const streamingOutput = await renderViaStreaming(markdown);
      const reloadOutput = await renderMarkdownToHtml(markdown);

      expect(streamingOutput).toBe(reloadOutput);
    });

    it("produces identical output for numbered list", async () => {
      const markdown = "1. First item\n2. Second item\n3. Third item";
      const streamingOutput = await renderViaStreaming(markdown);
      const reloadOutput = await renderMarkdownToHtml(markdown);

      expect(streamingOutput).toBe(reloadOutput);
    });

    it("produces identical output for horizontal rule", async () => {
      const markdown = "Above\n\n---\n\nBelow";
      const streamingOutput = await renderViaStreaming(markdown);
      const reloadOutput = await renderMarkdownToHtml(markdown);

      expect(streamingOutput).toBe(reloadOutput);
    });

    it("produces identical output for complex real-world content", async () => {
      const markdown = `Let me help you with that bug.

The issue is in your \`useEffect\` hook. Here's the fix:

\`\`\`typescript
useEffect(() => {
  // Only run when dependencies change
  if (loading) return;

  fetchData().then(setData);
}, [loading]);
\`\`\`

This ensures the effect doesn't run on every render.

## Why this works

1. The dependency array \`[loading]\` tells React when to re-run
2. The early return prevents unnecessary fetches
3. The \`setData\` call updates state correctly

> Note: Make sure to handle cleanup if the component unmounts!`;

      const streamingOutput = await renderViaStreaming(markdown);
      const reloadOutput = await renderMarkdownToHtml(markdown);

      expect(streamingOutput).toBe(reloadOutput);
    });
  });
});
