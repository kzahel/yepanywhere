/**
 * Lifecycle integration tests for TextBlock streaming markdown.
 *
 * These tests verify that server-rendered markdown survives the transition
 * from streaming (isStreaming=true) to final (isStreaming=false), including
 * component remounts.
 *
 * The bug we're fixing: When streaming ends and the final message arrives,
 * the component re-renders with isStreaming=false but loses access to the
 * augmented HTML that was accumulated during streaming.
 *
 * Run with: pnpm -F client test -- TextBlock.lifecycle
 */
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MarkdownAugmentProvider,
  useMarkdownAugmentContext,
} from "../../contexts/MarkdownAugmentContext";
import {
  StreamingMarkdownProvider,
  useStreamingMarkdownContext,
} from "../../contexts/StreamingMarkdownContext";
import { TextBlock } from "../blocks/TextBlock";

// Mock AgentContentContext
vi.mock("../../contexts/AgentContentContext", () => ({
  AgentContentContext: {
    Provider: ({ children }: { children: ReactNode }) => children,
  },
}));

/**
 * Recorded SSE event for replay
 */
interface SSEEvent {
  type: "message_start" | "augment" | "pending" | "stream_end" | "final_message";
  delay?: number; // ms to wait before sending
  data?: {
    messageId?: string;
    blockIndex?: number;
    html?: string;
    blockType?: string;
  };
}

/**
 * SSE replay engine - pumps events into the context
 */
interface SSEReplayControls {
  replay: (events: SSEEvent[]) => Promise<void>;
  getCurrentMessageId: () => string | null;
  getStoredAugment: (blockId: string) => string | undefined;
}

/**
 * Component that simulates SessionPage's SSE handling
 */
function SSEReplayEngine({
  children,
  onReady,
  onStreamingChange,
}: {
  children: ReactNode;
  onReady: (controls: SSEReplayControls) => void;
  onStreamingChange?: (streaming: boolean) => void;
}) {
  const streamingContext = useStreamingMarkdownContext();
  const markdownContext = useMarkdownAugmentContext();
  const currentMessageIdRef = useRef<string | null>(null);
  const streamingBlocksRef = useRef<Map<string, string[]>>(new Map());
  const readyRef = useRef(false);

  const controls = useMemo<SSEReplayControls>(() => ({
    replay: async (events: SSEEvent[]) => {
      for (const event of events) {
        if (event.delay) {
          await new Promise((r) => setTimeout(r, event.delay));
        }

        switch (event.type) {
          case "message_start": {
            const messageId = event.data?.messageId ?? `msg-${Date.now()}`;
            currentMessageIdRef.current = messageId;
            streamingContext?.setCurrentMessageId(messageId);
            streamingBlocksRef.current.set(messageId, []);
            onStreamingChange?.(true);
            break;
          }

          case "augment": {
            const messageId = event.data?.messageId ?? currentMessageIdRef.current;
            if (!messageId) {
              console.warn("augment without messageId");
              continue;
            }
            const blockIndex = event.data?.blockIndex ?? 0;
            const html = event.data?.html ?? "";

            // 1. Dispatch to streaming handler (live DOM update)
            streamingContext?.dispatchAugment({
              blockIndex,
              html,
              type: event.data?.blockType ?? "paragraph",
              messageId,
            });

            // 2. Accumulate blocks
            const blocks = streamingBlocksRef.current.get(messageId) ?? [];
            blocks[blockIndex] = html;
            streamingBlocksRef.current.set(messageId, blocks);

            // 3. Persist to context (THIS IS THE KEY)
            const fullHtml = blocks.filter(Boolean).join("\n");
            markdownContext?.setAugment(`${messageId}-0`, { html: fullHtml });
            break;
          }

          case "pending": {
            streamingContext?.dispatchPending({ html: event.data?.html ?? "" });
            break;
          }

          case "stream_end": {
            streamingContext?.dispatchStreamEnd();
            // Don't clear currentMessageIdRef yet - final message needs it
            break;
          }

          case "final_message": {
            // Simulate the final assistant message arriving with isStreaming=false
            onStreamingChange?.(false);
            currentMessageIdRef.current = null;
            break;
          }
        }
      }
    },

    getCurrentMessageId: () => currentMessageIdRef.current,

    getStoredAugment: (blockId: string) => {
      return markdownContext?.getAugment(blockId)?.html;
    },
  }), [streamingContext, markdownContext, onStreamingChange]);

  useEffect(() => {
    if (!readyRef.current) {
      readyRef.current = true;
      onReady(controls);
    }
  }, [controls, onReady]);

  return <>{children}</>;
}

/**
 * Test harness that provides full context stack and SSE replay
 */
function TestHarness({
  onReady,
  children,
}: {
  onReady: (controls: SSEReplayControls & { setStreaming: (v: boolean) => void }) => void;
  children?: (props: { isStreaming: boolean; blockId: string }) => ReactNode;
}) {
  const [isStreaming, setIsStreaming] = useState(true);
  const messageId = "msg-lifecycle-test";
  const blockId = `${messageId}-0`;
  const plainText = "Hello world\n\n```js\nconst x = 1;\n```\n\nGoodbye";
  const readyRef = useRef(false);

  const handleReady = useCallback(
    (replayControls: SSEReplayControls) => {
      if (!readyRef.current) {
        readyRef.current = true;
        onReady({
          ...replayControls,
          setStreaming: setIsStreaming,
        });
      }
    },
    [onReady],
  );

  return (
    <MarkdownAugmentProvider>
      <StreamingMarkdownProvider>
        <SSEReplayEngine
          onReady={handleReady}
          onStreamingChange={setIsStreaming}
        >
          {children ? (
            children({ isStreaming, blockId })
          ) : (
            <TextBlock
              id={blockId}
              text={plainText}
              isStreaming={isStreaming}
            />
          )}
        </SSEReplayEngine>
      </StreamingMarkdownProvider>
    </MarkdownAugmentProvider>
  );
}

// Known-good SSE event sequences from production
const SIMPLE_PARAGRAPH_SEQUENCE: SSEEvent[] = [
  { type: "message_start", data: { messageId: "msg-lifecycle-test" } },
  { type: "pending", data: { html: "Hello " } },
  { type: "pending", data: { html: "Hello world" } },
  {
    type: "augment",
    data: {
      messageId: "msg-lifecycle-test",
      blockIndex: 0,
      html: "<p>Hello world</p>",
      blockType: "paragraph",
    },
  },
  { type: "pending", data: { html: "" } },
  { type: "stream_end" },
  { type: "final_message" },
];

const MULTI_BLOCK_SEQUENCE: SSEEvent[] = [
  { type: "message_start", data: { messageId: "msg-lifecycle-test" } },
  // First paragraph
  { type: "pending", data: { html: "Introduction..." } },
  {
    type: "augment",
    data: {
      messageId: "msg-lifecycle-test",
      blockIndex: 0,
      html: "<p>Introduction to the topic.</p>",
      blockType: "paragraph",
    },
  },
  // Code block
  { type: "pending", data: { html: "```javascript\nfunction " } },
  {
    type: "augment",
    data: {
      messageId: "msg-lifecycle-test",
      blockIndex: 1,
      html: '<pre class="shiki" style="background:#1e1e1e"><code><span style="color:#569CD6">function</span> hello() {}</code></pre>',
      blockType: "code",
    },
  },
  // Second paragraph
  { type: "pending", data: { html: "And that's how" } },
  {
    type: "augment",
    data: {
      messageId: "msg-lifecycle-test",
      blockIndex: 2,
      html: "<p>And that's how it works.</p>",
      blockType: "paragraph",
    },
  },
  { type: "pending", data: { html: "" } },
  { type: "stream_end" },
  { type: "final_message" },
];

describe("TextBlock lifecycle tests", () => {
  beforeEach(() => {
    window.__STREAMING_DEBUG__ = true;
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    window.__STREAMING_DEBUG__ = false;
    vi.useRealTimers();
    cleanup();
  });

  describe("Bug reproduction: Augment loss on final render", () => {
    it("should preserve augmented HTML when transitioning from streaming to final", async () => {
      let controls!: SSEReplayControls & { setStreaming: (v: boolean) => void };

      render(
        <TestHarness
          onReady={(c) => {
            controls = c;
          }}
        />,
      );

      // Wait for controls
      await vi.waitFor(() => expect(controls).toBeDefined());

      // Play the SSE sequence
      await act(async () => {
        await controls.replay(SIMPLE_PARAGRAPH_SEQUENCE);
      });

      // Verify context has the augment
      const storedHtml = controls.getStoredAugment("msg-lifecycle-test-0");
      expect(storedHtml).toBe("<p>Hello world</p>");

      // Now verify the DOM - this is where the bug manifests
      const textBlock = document.querySelector(".text-block");
      expect(textBlock).not.toBeNull();

      // After final_message, isStreaming=false, so it should render from context
      const streamingBlocks = textBlock?.querySelector(".streaming-blocks");
      expect(streamingBlocks).not.toBeNull();

      // THE CRITICAL ASSERTION: Does it have content?
      const innerHTML = streamingBlocks?.innerHTML ?? "";
      expect(innerHTML).not.toBe("");
      expect(innerHTML).toContain("Hello world");
    });

    it("should preserve syntax-highlighted code blocks on final render", async () => {
      let controls!: SSEReplayControls & { setStreaming: (v: boolean) => void };

      render(
        <TestHarness
          onReady={(c) => {
            controls = c;
          }}
        />,
      );

      await vi.waitFor(() => expect(controls).toBeDefined());

      await act(async () => {
        await controls.replay(MULTI_BLOCK_SEQUENCE);
      });

      // Verify all blocks are in context
      const storedHtml = controls.getStoredAugment("msg-lifecycle-test-0");
      expect(storedHtml).toContain("Introduction");
      expect(storedHtml).toContain('class="shiki"');
      expect(storedHtml).toContain("And that's how");

      // Verify DOM rendering
      const streamingBlocks = document.querySelector(".streaming-blocks");
      expect(streamingBlocks).not.toBeNull();

      const innerHTML = streamingBlocks?.innerHTML ?? "";
      expect(innerHTML).toContain("Introduction");
      expect(innerHTML).toContain("shiki"); // Syntax highlighting preserved
      expect(innerHTML).toContain("And that's how");
    });

    it("should survive component remount during streaming", async () => {
      let controls!: SSEReplayControls & { setStreaming: (v: boolean) => void };
      let remountCounter = 0;

      // Custom render with remount capability
      function RemountableTextBlock({
        id,
        text,
        isStreaming,
      }: {
        id: string;
        text: string;
        isStreaming: boolean;
      }) {
        // Track remounts
        useEffect(() => {
          remountCounter++;
        }, []);

        return (
          <div data-testid={`textblock-${remountCounter}`}>
            <TextBlock id={id} text={text} isStreaming={isStreaming} />
          </div>
        );
      }

      const { rerender } = render(
        <TestHarness
          onReady={(c) => {
            controls = c;
          }}
        >
          {({ isStreaming, blockId }) => (
            <RemountableTextBlock
              id={blockId}
              text="test"
              isStreaming={isStreaming}
            />
          )}
        </TestHarness>,
      );

      await vi.waitFor(() => expect(controls).toBeDefined());

      // Start streaming
      await act(async () => {
        await controls.replay([
          { type: "message_start", data: { messageId: "msg-lifecycle-test" } },
          {
            type: "augment",
            data: {
              messageId: "msg-lifecycle-test",
              blockIndex: 0,
              html: "<p>First block</p>",
              blockType: "paragraph",
            },
          },
        ]);
      });

      const initialRemounts = remountCounter;

      // Force a remount by re-rendering the harness
      rerender(
        <TestHarness
          onReady={(c) => {
            controls = c;
          }}
        >
          {({ isStreaming, blockId }) => (
            <RemountableTextBlock
              id={blockId}
              text="test"
              isStreaming={isStreaming}
            />
          )}
        </TestHarness>,
      );

      // Send more augments after remount
      await act(async () => {
        await controls.replay([
          {
            type: "augment",
            data: {
              messageId: "msg-lifecycle-test",
              blockIndex: 1,
              html: "<p>Second block after remount</p>",
              blockType: "paragraph",
            },
          },
          { type: "stream_end" },
          { type: "final_message" },
        ]);
      });

      // Verify all content is in context
      const storedHtml = controls.getStoredAugment("msg-lifecycle-test-0");
      expect(storedHtml).toContain("First block");
      expect(storedHtml).toContain("Second block after remount");

      // Verify DOM has content
      const streamingBlocks = document.querySelector(".streaming-blocks");
      const innerHTML = streamingBlocks?.innerHTML ?? "";
      expect(innerHTML).toContain("First block");
      expect(innerHTML).toContain("Second block after remount");
    });
  });

  describe("Timing-sensitive scenarios", () => {
    it("handles rapid augment bursts", async () => {
      let controls!: SSEReplayControls & { setStreaming: (v: boolean) => void };

      render(
        <TestHarness
          onReady={(c) => {
            controls = c;
          }}
        />,
      );

      await vi.waitFor(() => expect(controls).toBeDefined());

      // Rapid-fire augments (no delays)
      const rapidEvents: SSEEvent[] = [
        { type: "message_start", data: { messageId: "msg-lifecycle-test" } },
        ...Array.from({ length: 10 }, (_, i) => ({
          type: "augment" as const,
          data: {
            messageId: "msg-lifecycle-test",
            blockIndex: i,
            html: `<p>Block ${i}</p>`,
            blockType: "paragraph",
          },
        })),
        { type: "stream_end" },
        { type: "final_message" },
      ];

      await act(async () => {
        await controls.replay(rapidEvents);
      });

      const storedHtml = controls.getStoredAugment("msg-lifecycle-test-0");
      for (let i = 0; i < 10; i++) {
        expect(storedHtml).toContain(`Block ${i}`);
      }
    });

    it("handles stream_end immediately followed by final_message", async () => {
      let controls!: SSEReplayControls & { setStreaming: (v: boolean) => void };

      render(
        <TestHarness
          onReady={(c) => {
            controls = c;
          }}
        />,
      );

      await vi.waitFor(() => expect(controls).toBeDefined());

      // Zero delay between stream_end and final_message (the tricky timing)
      await act(async () => {
        await controls.replay([
          { type: "message_start", data: { messageId: "msg-lifecycle-test" } },
          {
            type: "augment",
            data: {
              messageId: "msg-lifecycle-test",
              blockIndex: 0,
              html: "<p>Content</p>",
              blockType: "paragraph",
            },
          },
          { type: "stream_end" },
          { type: "final_message" }, // Immediately after stream_end
        ]);
      });

      const storedHtml = controls.getStoredAugment("msg-lifecycle-test-0");
      expect(storedHtml).toBe("<p>Content</p>");

      const streamingBlocks = document.querySelector(".streaming-blocks");
      expect(streamingBlocks?.innerHTML).toContain("Content");
    });
  });

  describe("Bug: Thinking block causes ID mismatch", () => {
    /**
     * This test reproduces the bug where messages with thinking + text content
     * have a key mismatch:
     * - Streaming stores augments at `messageId-0`
     * - But preprocessing creates TextBlock with `id = messageId-1` (due to thinking at index 0)
     * - TextBlock looks up `messageId-1` but augment is stored at `messageId-0`
     */
    it("should find augment when text block is not at content index 0", async () => {
      let controls!: SSEReplayControls & { setStreaming: (v: boolean) => void };

      render(
        <TestHarness
          onReady={(c) => {
            controls = c;
          }}
        />,
      );

      await vi.waitFor(() => expect(controls).toBeDefined());

      await act(async () => {
        await controls.replay([
          { type: "message_start", data: { messageId: "msg-lifecycle-test" } },
          {
            type: "augment",
            data: {
              messageId: "msg-lifecycle-test",
              blockIndex: 0,
              html: "<p>This is the response text.</p>",
              blockType: "paragraph",
            },
          },
          { type: "stream_end" },
          { type: "final_message" },
        ]);
      });

      // Augments are stored at messageId-0 (this works)
      expect(controls.getStoredAugment("msg-lifecycle-test-0")).toBe(
        "<p>This is the response text.</p>",
      );

      // But if the final message has [thinking, text], the text block gets id "msg-lifecycle-test-1"
      // This lookup FAILS because augment is at -0, not -1
      // This is the bug we need to fix!
      const lookupKey1 = controls.getStoredAugment("msg-lifecycle-test-1");

      // Currently this will be undefined because of the bug
      // After the fix, this test assertion should change
      console.log("[BUG TEST] Lookup at -1:", lookupKey1);
      console.log("[BUG TEST] Lookup at -0:", controls.getStoredAugment("msg-lifecycle-test-0"));
    });
  });

  describe("Context persistence verification", () => {
    it("context getAugment returns correct value after setAugment", async () => {
      let controls!: SSEReplayControls & { setStreaming: (v: boolean) => void };

      render(
        <TestHarness
          onReady={(c) => {
            controls = c;
          }}
        />,
      );

      await vi.waitFor(() => expect(controls).toBeDefined());

      await act(async () => {
        await controls.replay([
          { type: "message_start", data: { messageId: "msg-lifecycle-test" } },
          {
            type: "augment",
            data: {
              messageId: "msg-lifecycle-test",
              blockIndex: 0,
              html: "<p>Test</p>",
              blockType: "paragraph",
            },
          },
        ]);
      });

      // Immediately check context
      expect(controls.getStoredAugment("msg-lifecycle-test-0")).toBe("<p>Test</p>");

      // Send another augment
      await act(async () => {
        await controls.replay([
          {
            type: "augment",
            data: {
              messageId: "msg-lifecycle-test",
              blockIndex: 1,
              html: "<p>More</p>",
              blockType: "paragraph",
            },
          },
        ]);
      });

      // Should have concatenated HTML
      const html = controls.getStoredAugment("msg-lifecycle-test-0");
      expect(html).toContain("<p>Test</p>");
      expect(html).toContain("<p>More</p>");
    });
  });
});
