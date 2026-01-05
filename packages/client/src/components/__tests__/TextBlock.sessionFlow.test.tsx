/**
 * Session-level tests for TextBlock streaming behavior.
 *
 * These tests verify the full SSE → context → component flow,
 * specifically testing that content survives component remounts
 * during streaming (the bug we're fixing).
 *
 * Run with: pnpm -F client test -- TextBlock.sessionFlow
 */
import { act, cleanup, render, screen } from "@testing-library/react";
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

// Mock AgentContentContext to avoid projectId requirement
vi.mock("../../contexts/AgentContentContext", () => ({
  AgentContentContext: {
    Provider: ({ children }: { children: ReactNode }) => children,
  },
}));

/**
 * Simulates what SessionPage does with SSE events.
 * This is the "glue" between SSE and contexts that we're testing.
 */
interface SessionSimulatorProps {
  children: ReactNode;
  onReady?: (controls: SessionControls) => void;
}

interface SessionControls {
  /** Simulate message_start SSE event */
  startMessage: (messageId: string) => void;
  /** Simulate augment SSE event (what server sends for each markdown block) */
  sendAugment: (augment: {
    blockIndex: number;
    html: string;
    type: string;
    messageId?: string;
  }) => void;
  /** Simulate pending SSE event */
  sendPending: (html: string) => void;
  /** Simulate stream end */
  endStream: () => void;
  /** Get accumulated HTML for a content block (what TextBlock looks up) */
  getAugmentHtml: (blockId: string) => string | undefined;
}

/**
 * This component mimics what SessionPage.tsx does:
 * - Receives SSE events
 * - Dispatches to StreamingMarkdownContext for live rendering
 * - Accumulates augments for storage in MarkdownAugmentContext
 *
 * The key behavior we're testing: augments should be stored in
 * MarkdownAugmentContext with the correct key format so TextBlock
 * can find them after remount.
 */
function SessionSimulator({ children, onReady }: SessionSimulatorProps) {
  const streamingContext = useStreamingMarkdownContext();
  const markdownContext = useMarkdownAugmentContext();

  // Track current streaming message ID (like SessionPage does)
  const currentMessageIdRef = useRef<string | null>(null);

  // Buffer for accumulating augments during streaming
  // Key: messageId, Value: array of block HTML strings indexed by blockIndex
  const streamingBlocksRef = useRef<Map<string, string[]>>(new Map());

  const controls = useMemo<SessionControls>(() => {
    return {
      startMessage: (messageId: string) => {
        currentMessageIdRef.current = messageId;
        streamingContext?.setCurrentMessageId(messageId);
        // Initialize blocks array for this message
        streamingBlocksRef.current.set(messageId, []);
      },

      sendAugment: (augment) => {
        const messageId = augment.messageId ?? currentMessageIdRef.current;
        if (!messageId) {
          console.warn("sendAugment called without messageId");
          return;
        }

        // 1. Dispatch to streaming handler (live DOM rendering)
        streamingContext?.dispatchAugment(augment);

        // 2. Accumulate in our buffer
        const blocks = streamingBlocksRef.current.get(messageId) ?? [];
        blocks[augment.blockIndex] = augment.html;
        streamingBlocksRef.current.set(messageId, blocks);

        // 3. Store concatenated HTML in context for remount recovery
        // KEY FIX: Store at messageId-0 (content block index), not messageId-blockIndex
        // This matches how historical augments are keyed
        const fullHtml = blocks.filter(Boolean).join("\n");
        markdownContext?.setAugment(`${messageId}-0`, { html: fullHtml });
      },

      sendPending: (html: string) => {
        streamingContext?.dispatchPending({ html });
      },

      endStream: () => {
        streamingContext?.dispatchStreamEnd();
        currentMessageIdRef.current = null;
      },

      getAugmentHtml: (blockId: string) => {
        return markdownContext?.getAugment(blockId)?.html;
      },
    };
  }, [streamingContext, markdownContext]);

  // Expose controls to test
  useEffect(() => {
    onReady?.(controls);
  }, [controls, onReady]);

  return <>{children}</>;
}

/**
 * Component that can be forced to remount by changing a key prop.
 * Wraps TextBlock to simulate parent re-renders causing unmount/mount.
 * Also allows changing isStreaming to simulate stream end.
 */
function RemountableTextBlock({
  id,
  text,
  isStreaming,
  remountKey,
}: {
  id: string;
  text: string;
  isStreaming: boolean;
  remountKey: number;
}) {
  // The key change forces React to unmount and remount TextBlock
  return (
    <div data-testid="text-block-wrapper" key={remountKey}>
      <TextBlock id={id} text={text} isStreaming={isStreaming} />
    </div>
  );
}

/**
 * Test component with controllable streaming state
 */
function StreamingTestComponent({
  onControlsReady,
}: {
  onControlsReady: (controls: {
    sessionControls: SessionControls;
    setStreaming: (v: boolean) => void;
    forceRemount: () => void;
  }) => void;
}) {
  const [key, setKey] = useState(0);
  const [isStreaming, setIsStreaming] = useState(true);
  const calledRef = useRef(false);

  const handleControlsReady = useCallback(
    (c: SessionControls) => {
      if (!calledRef.current) {
        calledRef.current = true;
        onControlsReady({
          sessionControls: c,
          setStreaming: (v: boolean) => setIsStreaming(v),
          forceRemount: () => setKey((k) => k + 1),
        });
      }
    },
    [onControlsReady],
  );

  const messageId = "msg-remount-test";
  const blockId = `${messageId}-0`;
  const plainText = "Hello world\n\nSome code\n\nMore text";

  return (
    <MarkdownAugmentProvider>
      <StreamingMarkdownProvider>
        <SessionSimulator onReady={handleControlsReady}>
          <RemountableTextBlock
            id={blockId}
            text={plainText}
            isStreaming={isStreaming}
            remountKey={key}
          />
        </SessionSimulator>
      </StreamingMarkdownProvider>
    </MarkdownAugmentProvider>
  );
}

describe("TextBlock session SSE flow", () => {
  beforeEach(() => {
    window.__STREAMING_DEBUG__ = true;
  });

  afterEach(() => {
    window.__STREAMING_DEBUG__ = false;
    cleanup();
  });

  describe("Scenario: Augments survive component remount during streaming", () => {
    it("preserves all augments when TextBlock remounts mid-stream", async () => {
      const messageId = "msg-remount-test";
      const blockId = `${messageId}-0`; // Content block ID (what TextBlock looks up)

      let testControls: {
        sessionControls: SessionControls;
        setStreaming: (v: boolean) => void;
        forceRemount: () => void;
      } | null = null;

      render(
        <StreamingTestComponent
          onControlsReady={(c) => {
            testControls = c;
          }}
        />,
      );

      // Wait for controls to be ready
      await vi.waitFor(() => expect(testControls).not.toBeNull());
      const { sessionControls: controls, setStreaming, forceRemount } = testControls!;

      // Start streaming
      act(() => {
        controls.startMessage(messageId);
      });

      // Send first two augments
      act(() => {
        controls.sendAugment({
          blockIndex: 0,
          html: "<p>Hello world</p>",
          type: "paragraph",
          messageId,
        });
        controls.sendAugment({
          blockIndex: 1,
          html: '<pre class="shiki"><code>Some code</code></pre>',
          type: "code",
          messageId,
        });
      });

      // Verify augments are stored in context
      expect(controls.getAugmentHtml(blockId)).toContain("<p>Hello world</p>");
      expect(controls.getAugmentHtml(blockId)).toContain("Some code");

      // *** FORCE REMOUNT - This is the bug scenario ***
      act(() => {
        forceRemount();
      });

      // Send more augments AFTER remount
      act(() => {
        controls.sendAugment({
          blockIndex: 2,
          html: "<p>More text</p>",
          type: "paragraph",
          messageId,
        });
      });

      // End stream (both the coordinator and the component's isStreaming prop)
      act(() => {
        controls.endStream();
        setStreaming(false); // Simulate final message arriving with isStreaming=false
      });

      // CRITICAL ASSERTION: All three blocks should be in context
      const finalHtml = controls.getAugmentHtml(blockId);
      expect(finalHtml).toContain("<p>Hello world</p>");
      expect(finalHtml).toContain("Some code");
      expect(finalHtml).toContain("<p>More text</p>");

      // Verify the TextBlock renders the augmented content (not plain text fallback)
      const wrapper = screen.getByTestId("text-block-wrapper");
      const streamingBlocks = wrapper.querySelector(".streaming-blocks");
      expect(streamingBlocks).not.toBeNull();

      // THE REAL TEST: Does the DOM actually have content?
      // After streaming ends (isStreaming=false), TextBlock should read from context
      const actualContent = streamingBlocks?.innerHTML ?? "";
      expect(actualContent).not.toBe(""); // Should have content!
      expect(actualContent).toContain("Hello world");
    });
  });

  describe("Scenario: Key format consistency between streaming and historical", () => {
    it("uses same key format as historical augments (messageId-contentBlockIndex)", async () => {
      const messageId = "msg-key-format-test";
      const contentBlockIndex = 0;
      const blockId = `${messageId}-${contentBlockIndex}`;

      let controls: SessionControls | null = null;

      render(
        <MarkdownAugmentProvider>
          <StreamingMarkdownProvider>
            <SessionSimulator
              onReady={(c) => {
                controls = c;
              }}
            >
              <TextBlock id={blockId} text="test" isStreaming={true} />
            </SessionSimulator>
          </StreamingMarkdownProvider>
        </MarkdownAugmentProvider>,
      );

      await vi.waitFor(() => expect(controls).not.toBeNull());

      // Simulate streaming with multiple markdown blocks
      act(() => {
        controls!.startMessage(messageId);
        // Server sends blockIndex as markdown block index (0, 1, 2...)
        controls!.sendAugment({
          blockIndex: 0,
          html: "<h1>Title</h1>",
          type: "heading",
          messageId,
        });
        controls!.sendAugment({
          blockIndex: 1,
          html: "<p>Paragraph</p>",
          type: "paragraph",
          messageId,
        });
        controls!.sendAugment({
          blockIndex: 2,
          html: "<pre>code</pre>",
          type: "code",
          messageId,
        });
        controls!.endStream();
      });

      // The key should be messageId-0 (content block index), NOT messageId-2 (last markdown block)
      // This is what TextBlock looks up, and what historical augments use
      const augmentHtml = controls!.getAugmentHtml(blockId);
      expect(augmentHtml).toBeDefined();
      expect(augmentHtml).toContain("<h1>Title</h1>");
      expect(augmentHtml).toContain("<p>Paragraph</p>");
      expect(augmentHtml).toContain("<pre>code</pre>");

      // Wrong keys should NOT exist
      expect(controls!.getAugmentHtml(`${messageId}-1`)).toBeUndefined();
      expect(controls!.getAugmentHtml(`${messageId}-2`)).toBeUndefined();
    });
  });

  describe("Scenario: TextBlock reads from context after streaming ends", () => {
    it("renders from MarkdownAugmentContext when not streaming", async () => {
      const messageId = "msg-context-read-test";
      const blockId = `${messageId}-0`;
      const plainText = "Some markdown text";
      const renderedHtml = "<p>Some <strong>markdown</strong> text</p>";

      let controls: SessionControls | null = null;

      const { rerender } = render(
        <MarkdownAugmentProvider>
          <StreamingMarkdownProvider>
            <SessionSimulator
              onReady={(c) => {
                controls = c;
              }}
            >
              <TextBlock id={blockId} text={plainText} isStreaming={true} />
            </SessionSimulator>
          </StreamingMarkdownProvider>
        </MarkdownAugmentProvider>,
      );

      await vi.waitFor(() => expect(controls).not.toBeNull());

      // Stream some content
      act(() => {
        controls!.startMessage(messageId);
        controls!.sendAugment({
          blockIndex: 0,
          html: renderedHtml,
          type: "paragraph",
          messageId,
        });
        controls!.endStream();
      });

      // Re-render with isStreaming=false (simulates final message arriving)
      rerender(
        <MarkdownAugmentProvider>
          <StreamingMarkdownProvider>
            <SessionSimulator>
              <TextBlock id={blockId} text={plainText} isStreaming={false} />
            </SessionSimulator>
          </StreamingMarkdownProvider>
        </MarkdownAugmentProvider>,
      );

      // TextBlock should read from context and render the augmented HTML
      const textBlock = document.querySelector(".text-block");
      const streamingBlocks = textBlock?.querySelector(".streaming-blocks");

      expect(streamingBlocks).not.toBeNull();
      expect(streamingBlocks?.innerHTML).toBe(renderedHtml);

      // Should NOT show plain text fallback
      const fallbackP = textBlock?.querySelector(":scope > p");
      expect(fallbackP).toBeNull();
    });
  });

  describe("Scenario: Pending text handling", () => {
    it("pending text dispatch does not throw when refs not attached", async () => {
      // This test verifies that pending dispatch is graceful when DOM refs aren't attached
      // (e.g., during test environment or component transitions)
      // The actual pending text rendering is tested in useStreamingMarkdown.integration.test.ts
      // which creates real DOM elements and attaches refs

      const messageId = "msg-pending-test";
      const blockId = `${messageId}-0`;

      let controls: SessionControls | null = null;

      render(
        <MarkdownAugmentProvider>
          <StreamingMarkdownProvider>
            <SessionSimulator
              onReady={(c) => {
                controls = c;
              }}
            >
              <TextBlock id={blockId} text="" isStreaming={true} />
            </SessionSimulator>
          </StreamingMarkdownProvider>
        </MarkdownAugmentProvider>,
      );

      await vi.waitFor(() => expect(controls).not.toBeNull());

      act(() => {
        controls!.startMessage(messageId);
      });

      // These should not throw even if refs aren't attached
      expect(() => {
        act(() => {
          controls!.sendPending("Hello ");
          controls!.sendPending("Hello world...");
          controls!.sendPending("");
        });
      }).not.toThrow();

      // Augment should still be stored in context
      act(() => {
        controls!.sendAugment({
          blockIndex: 0,
          html: "<p>Hello world!</p>",
          type: "paragraph",
          messageId,
        });
        controls!.endStream();
      });

      // Context should have the augment
      expect(controls!.getAugmentHtml(blockId)).toBe("<p>Hello world!</p>");
    });
  });
});
