/**
 * Tests for TextBlock final render behavior.
 *
 * These tests verify that markdown content rendered during streaming
 * persists correctly when the streaming placeholder is replaced by
 * the final message component.
 *
 * Run with: pnpm test --filter=@yep-anywhere/client -- TextBlock.finalRender
 */
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MarkdownAugmentProvider,
  useMarkdownAugmentContext,
} from "../../contexts/MarkdownAugmentContext";
import { StreamingMarkdownProvider } from "../../contexts/StreamingMarkdownContext";
import { TextBlock } from "../blocks/TextBlock";

// Mock AgentContentContext to avoid projectId requirement
vi.mock("../../contexts/AgentContentContext", () => ({
  AgentContentContext: {
    Provider: ({ children }: { children: React.ReactNode }) => children,
  },
}));

describe("TextBlock final render", () => {
  beforeEach(() => {
    // Enable debug logging for tests
    window.__STREAMING_DEBUG__ = true;
  });

  afterEach(() => {
    window.__STREAMING_DEBUG__ = false;
    cleanup();
  });

  /**
   * Helper component to access context and dispatch events
   */
  function TestHarness({
    children,
    onContextReady,
  }: {
    children: React.ReactNode;
    onContextReady?: (
      ctx: ReturnType<typeof useMarkdownAugmentContext>,
    ) => void;
  }) {
    const ctx = useMarkdownAugmentContext();
    if (onContextReady && ctx) {
      // Use setTimeout to avoid calling during render
      setTimeout(() => onContextReady(ctx), 0);
    }
    return <>{children}</>;
  }

  describe("Scenario: Streaming to final message transition", () => {
    it("preserves markdown when component remounts after streaming", async () => {
      const messageId = "msg-123";
      const blockId = `${messageId}-0`;
      const markdownHtml = "<p>Hello <strong>world</strong></p>";
      const plainText = "Hello world";

      // Capture context reference
      let markdownContext: ReturnType<typeof useMarkdownAugmentContext> | null =
        null;

      // Render with all providers
      const { rerender, container } = render(
        <MarkdownAugmentProvider>
          <StreamingMarkdownProvider>
            <TestHarness
              onContextReady={(ctx) => {
                markdownContext = ctx;
              }}
            >
              <TextBlock id={blockId} text={plainText} isStreaming={true} />
            </TestHarness>
          </StreamingMarkdownProvider>
        </MarkdownAugmentProvider>,
      );

      // Wait for context to be available
      await vi.waitFor(() => expect(markdownContext).not.toBeNull());

      // Simulate what happens during streaming:
      // 1. Server sends augment with messageId
      // 2. Client stores it in MarkdownAugmentContext (current workaround)
      act(() => {
        markdownContext?.setAugment(blockId, { html: markdownHtml });
      });

      // Now simulate the final message arriving by re-rendering with isStreaming=false
      // This simulates the component transition from streaming placeholder to final message
      rerender(
        <MarkdownAugmentProvider>
          <StreamingMarkdownProvider>
            <TestHarness>
              <TextBlock id={blockId} text={plainText} isStreaming={false} />
            </TestHarness>
          </StreamingMarkdownProvider>
        </MarkdownAugmentProvider>,
      );

      // The final render should use the pre-rendered markdown from context
      // NOT the plain text fallback
      const textBlock = container.querySelector(".text-block");
      expect(textBlock).not.toBeNull();

      // Should have the streaming-blocks div with server-rendered HTML
      const streamingBlocks = textBlock?.querySelector(".streaming-blocks");
      expect(streamingBlocks).not.toBeNull();
      expect(streamingBlocks?.innerHTML).toBe(markdownHtml);

      // Should NOT have the plain text fallback <p> tag
      const fallbackP = textBlock?.querySelector(":scope > p");
      expect(fallbackP).toBeNull();
    });

    it("falls back to plain text when no augment is available", () => {
      const messageId = "msg-456";
      const blockId = `${messageId}-0`;
      const plainText = "Plain text content";

      const { container } = render(
        <MarkdownAugmentProvider>
          <StreamingMarkdownProvider>
            <TextBlock id={blockId} text={plainText} isStreaming={false} />
          </StreamingMarkdownProvider>
        </MarkdownAugmentProvider>,
      );

      // Should fall back to plain text when no augment is available
      const textBlock = container.querySelector(".text-block");
      expect(textBlock).not.toBeNull();

      // Should have the plain text fallback <p> tag
      const fallbackP = textBlock?.querySelector(":scope > p");
      expect(fallbackP).not.toBeNull();
      expect(fallbackP?.textContent).toBe(plainText);
    });

    it("preserves multiple blocks when final message arrives", async () => {
      const messageId = "msg-789";
      const plainText = "# Title\n\nParagraph content";
      const blocks = [
        { blockId: `${messageId}-0`, html: "<h1>Title</h1>" },
        { blockId: `${messageId}-1`, html: "<p>Paragraph content</p>" },
      ];

      let markdownContext: ReturnType<typeof useMarkdownAugmentContext> | null =
        null;

      const { rerender, container } = render(
        <MarkdownAugmentProvider>
          <StreamingMarkdownProvider>
            <TestHarness
              onContextReady={(ctx) => {
                markdownContext = ctx;
              }}
            >
              <TextBlock
                id={`${messageId}-0`}
                text={plainText}
                isStreaming={true}
              />
            </TestHarness>
          </StreamingMarkdownProvider>
        </MarkdownAugmentProvider>,
      );

      await vi.waitFor(() => expect(markdownContext).not.toBeNull());

      // Simulate streaming augments for multiple blocks
      act(() => {
        for (const block of blocks) {
          markdownContext?.setAugment(block.blockId, { html: block.html });
        }
      });

      // Re-render with first block ID (the actual TextBlock gets one block at a time)
      rerender(
        <MarkdownAugmentProvider>
          <StreamingMarkdownProvider>
            <TestHarness>
              <TextBlock
                id={`${messageId}-0`}
                text={plainText}
                isStreaming={false}
              />
            </TestHarness>
          </StreamingMarkdownProvider>
        </MarkdownAugmentProvider>,
      );

      // First block should render with augmented HTML
      const streamingBlocks = container.querySelector(".streaming-blocks");
      expect(streamingBlocks?.innerHTML).toBe("<h1>Title</h1>");
    });
  });

  describe("Scenario: Context provides augments on reload", () => {
    it("renders historical message with pre-loaded augment", async () => {
      const messageId = "historical-msg";
      const blockId = `${messageId}-0`;
      const markdownHtml = '<pre class="shiki"><code>const x = 1;</code></pre>';
      const plainText = "const x = 1;";

      // Capture context reference to pre-load augments
      let markdownContext: ReturnType<typeof useMarkdownAugmentContext> | null =
        null;

      const { rerender, container } = render(
        <MarkdownAugmentProvider>
          <StreamingMarkdownProvider>
            <TestHarness
              onContextReady={(ctx) => {
                markdownContext = ctx;
              }}
            >
              <TextBlock id={blockId} text={plainText} isStreaming={false} />
            </TestHarness>
          </StreamingMarkdownProvider>
        </MarkdownAugmentProvider>,
      );

      // Wait for context and pre-load augment (simulates REST response loading)
      await vi.waitFor(() => expect(markdownContext).not.toBeNull());

      act(() => {
        markdownContext?.setAugment(blockId, { html: markdownHtml });
      });

      // Re-render to pick up the augment
      rerender(
        <MarkdownAugmentProvider>
          <StreamingMarkdownProvider>
            <TestHarness>
              <TextBlock id={blockId} text={plainText} isStreaming={false} />
            </TestHarness>
          </StreamingMarkdownProvider>
        </MarkdownAugmentProvider>,
      );

      // Should render the pre-loaded augment
      const streamingBlocks = container.querySelector(".streaming-blocks");
      expect(streamingBlocks).not.toBeNull();
      expect(streamingBlocks?.innerHTML).toBe(markdownHtml);
    });
  });
});
