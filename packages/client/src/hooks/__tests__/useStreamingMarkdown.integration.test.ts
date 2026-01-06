/**
 * Integration tests for useStreamingMarkdown hook.
 *
 * These tests verify the full DOM manipulation flow with verbose logging
 * to help debug streaming markdown rendering issues.
 *
 * Run with: pnpm test --filter=@yep-anywhere/client -- useStreamingMarkdown.integration
 */
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useStreamingMarkdown } from "../useStreamingMarkdown";

// Enable debug logging for tests
declare global {
  interface Window {
    __STREAMING_DEBUG__?: boolean;
  }
}

describe("useStreamingMarkdown integration", () => {
  let container: HTMLDivElement;
  let pending: HTMLSpanElement;

  beforeEach(() => {
    // Enable debug logging
    window.__STREAMING_DEBUG__ = true;

    // Create real DOM elements
    container = document.createElement("div");
    container.id = "streaming-container";
    pending = document.createElement("span");
    pending.id = "streaming-pending";
    pending.className = "streaming-pending";

    document.body.appendChild(container);
    document.body.appendChild(pending);

    console.log("\n========================================");
    console.log("TEST SETUP: Created DOM elements");
    console.log("  Container:", container.id);
    console.log("  Pending:", pending.id);
    console.log("========================================\n");
  });

  afterEach(() => {
    document.body.removeChild(container);
    document.body.removeChild(pending);
    window.__STREAMING_DEBUG__ = false;

    console.log("\n========================================");
    console.log("TEST CLEANUP: Removed DOM elements");
    console.log("========================================\n");
  });

  // Helper to attach refs to DOM elements
  function attachRefs(result: ReturnType<typeof useStreamingMarkdown>) {
    (result.containerRef as React.MutableRefObject<HTMLDivElement>).current =
      container;
    (result.pendingRef as React.MutableRefObject<HTMLSpanElement>).current =
      pending;
    console.log("  -> Refs attached to DOM elements");
  }

  // Helper to log DOM state
  function logDOMState(label: string) {
    console.log(`\n--- ${label} ---`);
    console.log("Container children:", container.children.length);
    for (let i = 0; i < container.children.length; i++) {
      const child = container.children[i] as HTMLElement;
      console.log(
        `  [${i}] blockIndex=${child.dataset.blockIndex}, innerHTML=${child.innerHTML.substring(0, 50)}...`,
      );
    }
    console.log("Pending innerHTML:", pending.innerHTML || "(empty)");
    console.log("---\n");
  }

  // Helper to delay for simulating realistic timing
  function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  describe("Scenario 1: Simple paragraph streaming", () => {
    it("streams chunks, shows pending, then renders augmented HTML", async () => {
      console.log("\n=== SCENARIO 1: Simple paragraph streaming ===\n");

      const { result } = renderHook(() => useStreamingMarkdown());
      attachRefs(result.current);

      // Initial state
      logDOMState("Initial state");
      expect(result.current.isStreaming).toBe(false);
      expect(container.children.length).toBe(0);

      // Step 1: First chunk arrives - show as pending
      console.log("Step 1: First chunk 'Hello ' arrives");
      act(() => {
        result.current.onPending({ html: "Hello " });
      });
      logDOMState("After first pending");
      expect(pending.innerHTML).toBe("Hello ");
      expect(result.current.isStreaming).toBe(true);

      // Step 2: More chunks accumulate in pending
      console.log("Step 2: More chunks 'Hello world' arrive");
      act(() => {
        result.current.onPending({ html: "Hello world" });
      });
      logDOMState("After second pending");
      expect(pending.innerHTML).toBe("Hello world");

      // Step 3: Augment arrives - paragraph is complete
      console.log("Step 3: Augment arrives with rendered HTML");
      act(() => {
        result.current.onAugment({
          blockIndex: 0,
          html: "<p>Hello world</p>",
          type: "paragraph",
        });
      });
      logDOMState("After augment");
      expect(container.children.length).toBe(1);
      expect(container.children[0]?.innerHTML).toBe("<p>Hello world</p>");

      // Step 4: Pending is cleared as block is now complete
      console.log("Step 4: Clear pending (new text or stream end)");
      act(() => {
        result.current.onPending({ html: "" });
      });
      logDOMState("After clearing pending");
      expect(pending.innerHTML).toBe("");

      // Step 5: Stream ends
      console.log("Step 5: Stream ends");
      act(() => {
        result.current.onStreamEnd();
      });
      logDOMState("After stream end");
      expect(result.current.isStreaming).toBe(false);

      console.log("=== SCENARIO 1 COMPLETE ===\n");
    });
  });

  describe("Scenario 2: Multiple blocks (heading + paragraph)", () => {
    it("renders multiple blocks in correct order", () => {
      console.log("\n=== SCENARIO 2: Multiple blocks ===\n");

      const { result } = renderHook(() => useStreamingMarkdown());
      attachRefs(result.current);

      logDOMState("Initial state");

      // Heading arrives first
      console.log("Step 1: Heading augment arrives");
      act(() => {
        result.current.onAugment({
          blockIndex: 0,
          html: "<h1>Welcome</h1>",
          type: "heading",
        });
      });
      logDOMState("After heading");

      // Pending text for paragraph
      console.log("Step 2: Pending text for paragraph");
      act(() => {
        result.current.onPending({ html: "This is a paragraph..." });
      });
      logDOMState("After pending paragraph");

      // Paragraph augment arrives
      console.log("Step 3: Paragraph augment arrives");
      act(() => {
        result.current.onAugment({
          blockIndex: 1,
          html: "<p>This is a paragraph with some content.</p>",
          type: "paragraph",
        });
        result.current.onPending({ html: "" });
      });
      logDOMState("After paragraph augment");

      expect(container.children.length).toBe(2);
      expect(container.children[0]?.innerHTML).toBe("<h1>Welcome</h1>");
      expect(container.children[1]?.innerHTML).toBe(
        "<p>This is a paragraph with some content.</p>",
      );

      // Verify order by blockIndex attributes
      expect((container.children[0] as HTMLElement).dataset.blockIndex).toBe(
        "0",
      );
      expect((container.children[1] as HTMLElement).dataset.blockIndex).toBe(
        "1",
      );

      console.log("=== SCENARIO 2 COMPLETE ===\n");
    });
  });

  describe("Scenario 3: Code block with syntax highlighting", () => {
    it("renders code block with shiki-style HTML", () => {
      console.log("\n=== SCENARIO 3: Code block with highlighting ===\n");

      const { result } = renderHook(() => useStreamingMarkdown());
      attachRefs(result.current);

      logDOMState("Initial state");

      // Pending shows raw code being typed
      console.log("Step 1: Pending shows code being typed");
      act(() => {
        result.current.onPending({
          html: '<pre><code class="language-javascript">function hello() {\n  console.lo',
        });
      });
      logDOMState("After pending code");

      // More code typed
      console.log("Step 2: More code typed");
      act(() => {
        result.current.onPending({
          html: '<pre><code class="language-javascript">function hello() {\n  console.log("Hello");\n}',
        });
      });
      logDOMState("After more pending code");

      // Code block augment with full syntax highlighting
      console.log("Step 3: Augment arrives with syntax-highlighted HTML");
      const highlightedHtml = `<pre class="shiki" style="background-color: #1e1e1e"><code>
<span class="line"><span style="color: #569CD6">function</span><span style="color: #DCDCAA"> hello</span><span style="color: #D4D4D4">() {</span></span>
<span class="line"><span style="color: #D4D4D4">  </span><span style="color: #9CDCFE">console</span><span style="color: #D4D4D4">.</span><span style="color: #DCDCAA">log</span><span style="color: #D4D4D4">(</span><span style="color: #CE9178">"Hello"</span><span style="color: #D4D4D4">);</span></span>
<span class="line"><span style="color: #D4D4D4">}</span></span>
</code></pre>`;

      act(() => {
        result.current.onAugment({
          blockIndex: 0,
          html: highlightedHtml,
          type: "code",
        });
        result.current.onPending({ html: "" });
      });
      logDOMState("After code augment");

      expect(container.children.length).toBe(1);
      expect(container.children[0]?.innerHTML).toContain('class="shiki"');
      expect(container.children[0]?.innerHTML).toContain("style=");

      console.log("=== SCENARIO 3 COMPLETE ===\n");
    });
  });

  describe("Scenario 4: Rapid small chunks", () => {
    it("handles rapid chunk updates efficiently", async () => {
      console.log("\n=== SCENARIO 4: Rapid small chunks ===\n");

      const { result } = renderHook(() => useStreamingMarkdown());
      attachRefs(result.current);

      const fullText = "The quick brown fox jumps over the lazy dog.";
      const chunks: string[] = [];

      // Build up chunks character by character
      for (let i = 1; i <= fullText.length; i++) {
        chunks.push(fullText.substring(0, i));
      }

      console.log(`Streaming ${chunks.length} character chunks...`);

      // Simulate rapid chunk delivery
      for (const chunk of chunks) {
        act(() => {
          result.current.onPending({ html: chunk });
        });
      }

      logDOMState("After all pending chunks");
      expect(pending.innerHTML).toBe(fullText);

      // Final augment
      console.log("Final augment arrives");
      act(() => {
        result.current.onAugment({
          blockIndex: 0,
          html: `<p>${fullText}</p>`,
          type: "paragraph",
        });
        result.current.onPending({ html: "" });
        result.current.onStreamEnd();
      });
      logDOMState("After final augment");

      expect(container.children.length).toBe(1);
      expect(container.children[0]?.innerHTML).toBe(`<p>${fullText}</p>`);
      expect(result.current.isStreaming).toBe(false);

      console.log("=== SCENARIO 4 COMPLETE ===\n");
    });
  });

  describe("Scenario 5: Complex mixed content", () => {
    it("handles heading, paragraph, code, and list", () => {
      console.log("\n=== SCENARIO 5: Complex mixed content ===\n");

      const { result } = renderHook(() => useStreamingMarkdown());
      attachRefs(result.current);

      const blocks = [
        {
          index: 0,
          html: "<h2>Installation</h2>",
          type: "heading",
        },
        {
          index: 1,
          html: "<p>Run the following command:</p>",
          type: "paragraph",
        },
        {
          index: 2,
          html: '<pre><code class="language-bash">npm install my-package</code></pre>',
          type: "code",
        },
        {
          index: 3,
          html: "<h2>Features</h2>",
          type: "heading",
        },
        {
          index: 4,
          html: "<ul><li>Fast</li><li>Reliable</li><li>Easy to use</li></ul>",
          type: "list",
        },
      ];

      // Simulate streaming each block with pending updates
      for (const block of blocks) {
        console.log(`Block ${block.index}: ${block.type}`);

        // Show pending preview
        act(() => {
          result.current.onPending({
            html: `${block.html.replace(/<[^>]+>/g, "").substring(0, 20)}...`,
          });
        });

        // Send augment
        act(() => {
          result.current.onAugment({
            blockIndex: block.index,
            html: block.html,
            type: block.type,
          });
        });
      }

      // Clear pending and end stream
      act(() => {
        result.current.onPending({ html: "" });
        result.current.onStreamEnd();
      });

      logDOMState("Final state");

      expect(container.children.length).toBe(5);

      // Verify all blocks are in correct order
      for (let i = 0; i < blocks.length; i++) {
        const child = container.children[i] as HTMLElement;
        const block = blocks[i];
        expect(child.dataset.blockIndex).toBe(String(block?.index));
        expect(child.innerHTML).toBe(block?.html);
      }

      console.log("=== SCENARIO 5 COMPLETE ===\n");
    });
  });

  describe("Scenario 6: Out-of-order augment delivery", () => {
    it("maintains correct order when blocks arrive out of sequence", () => {
      console.log("\n=== SCENARIO 6: Out-of-order delivery ===\n");

      const { result } = renderHook(() => useStreamingMarkdown());
      attachRefs(result.current);

      // Simulate network delays causing out-of-order delivery
      console.log("Blocks arriving out of order: 2, 0, 3, 1");

      act(() => {
        result.current.onAugment({
          blockIndex: 2,
          html: "<p>Third paragraph</p>",
          type: "paragraph",
        });
      });
      logDOMState("After block 2");

      act(() => {
        result.current.onAugment({
          blockIndex: 0,
          html: "<h1>Title</h1>",
          type: "heading",
        });
      });
      logDOMState("After block 0");

      act(() => {
        result.current.onAugment({
          blockIndex: 3,
          html: "<p>Fourth paragraph</p>",
          type: "paragraph",
        });
      });
      logDOMState("After block 3");

      act(() => {
        result.current.onAugment({
          blockIndex: 1,
          html: "<p>Second paragraph</p>",
          type: "paragraph",
        });
      });
      logDOMState("After block 1 (final)");

      // Verify correct order
      expect(container.children.length).toBe(4);
      expect((container.children[0] as HTMLElement).dataset.blockIndex).toBe(
        "0",
      );
      expect((container.children[1] as HTMLElement).dataset.blockIndex).toBe(
        "1",
      );
      expect((container.children[2] as HTMLElement).dataset.blockIndex).toBe(
        "2",
      );
      expect((container.children[3] as HTMLElement).dataset.blockIndex).toBe(
        "3",
      );

      console.log("=== SCENARIO 6 COMPLETE ===\n");
    });
  });

  describe("Scenario 7: Block updates (same index, new content)", () => {
    it("updates existing block when augment with same index arrives", () => {
      console.log("\n=== SCENARIO 7: Block updates ===\n");

      const { result } = renderHook(() => useStreamingMarkdown());
      attachRefs(result.current);

      // Initial block
      console.log("Initial block");
      act(() => {
        result.current.onAugment({
          blockIndex: 0,
          html: "<p>Initial content</p>",
          type: "paragraph",
        });
      });
      logDOMState("After initial");

      // Update same block (e.g., code block being refined)
      console.log("Update same block");
      act(() => {
        result.current.onAugment({
          blockIndex: 0,
          html: "<p>Updated content with more text</p>",
          type: "paragraph",
        });
      });
      logDOMState("After update");

      expect(container.children.length).toBe(1);
      expect(container.children[0]?.innerHTML).toBe(
        "<p>Updated content with more text</p>",
      );

      console.log("=== SCENARIO 7 COMPLETE ===\n");
    });
  });

  describe("Scenario 8: Reset during streaming", () => {
    it("clears all state when reset is called mid-stream", () => {
      console.log("\n=== SCENARIO 8: Reset during streaming ===\n");

      const { result } = renderHook(() => useStreamingMarkdown());
      attachRefs(result.current);

      // Build up some state
      console.log("Building up state...");
      act(() => {
        result.current.onAugment({
          blockIndex: 0,
          html: "<p>Block 1</p>",
          type: "paragraph",
        });
        result.current.onAugment({
          blockIndex: 1,
          html: "<p>Block 2</p>",
          type: "paragraph",
        });
        result.current.onPending({ html: "More content coming..." });
      });
      logDOMState("Before reset");

      expect(container.children.length).toBe(2);
      expect(pending.innerHTML).toBe("More content coming...");
      expect(result.current.isStreaming).toBe(true);

      // Reset
      console.log("Calling reset...");
      act(() => {
        result.current.reset();
      });
      logDOMState("After reset");

      expect(container.children.length).toBe(0);
      expect(container.innerHTML).toBe("");
      expect(pending.innerHTML).toBe("");
      expect(result.current.isStreaming).toBe(false);

      // Can start new stream
      console.log("Starting new stream...");
      act(() => {
        result.current.onAugment({
          blockIndex: 0,
          html: "<p>Fresh start</p>",
          type: "paragraph",
        });
      });
      logDOMState("After fresh start");

      expect(container.children.length).toBe(1);
      expect(container.children[0]?.innerHTML).toBe("<p>Fresh start</p>");

      console.log("=== SCENARIO 8 COMPLETE ===\n");
    });
  });
});
