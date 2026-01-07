import { act, renderHook } from "@testing-library/react";
import {
  type Mock,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  type UseStreamingContentOptions,
  useStreamingContent,
} from "../useStreamingContent";

// Mock getStreamingEnabled to control streaming behavior in tests
vi.mock("../useStreamingEnabled", () => ({
  getStreamingEnabled: vi.fn(() => true),
}));

import { getStreamingEnabled } from "../useStreamingEnabled";

describe("useStreamingContent", () => {
  let onUpdateMessage: Mock;
  let onToolUseMapping: Mock;
  let onAgentContextUsage: Mock;
  let streamingMarkdownCallbacks: {
    setCurrentMessageId: Mock;
    onStreamEnd: Mock;
  };

  const defaultOptions = (): UseStreamingContentOptions => ({
    onUpdateMessage,
    onToolUseMapping,
    onAgentContextUsage,
    streamingMarkdownCallbacks,
  });

  beforeEach(() => {
    vi.useFakeTimers();
    onUpdateMessage = vi.fn();
    onToolUseMapping = vi.fn();
    onAgentContextUsage = vi.fn();
    streamingMarkdownCallbacks = {
      setCurrentMessageId: vi.fn(),
      onStreamEnd: vi.fn(),
    };
    (getStreamingEnabled as Mock).mockReturnValue(true);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  describe("handleStreamEvent", () => {
    it("returns false for non-stream_event messages", () => {
      const { result } = renderHook(() =>
        useStreamingContent(defaultOptions()),
      );

      const handled = result.current.handleStreamEvent({
        type: "message",
        content: "hello",
      });

      expect(handled).toBe(false);
    });

    it("returns false when streaming is disabled", () => {
      (getStreamingEnabled as Mock).mockReturnValue(false);

      const { result } = renderHook(() =>
        useStreamingContent(defaultOptions()),
      );

      const handled = result.current.handleStreamEvent({
        type: "stream_event",
        event: { type: "message_start" },
      });

      expect(handled).toBe(false);
    });

    it("returns true for stream_event with no event data", () => {
      const { result } = renderHook(() =>
        useStreamingContent(defaultOptions()),
      );

      const handled = result.current.handleStreamEvent({
        type: "stream_event",
      });

      expect(handled).toBe(true);
    });

    it("handles message_start and sets current message ID", () => {
      const { result } = renderHook(() =>
        useStreamingContent(defaultOptions()),
      );

      act(() => {
        result.current.handleStreamEvent({
          type: "stream_event",
          event: {
            type: "message_start",
            message: { id: "msg-123" },
          },
        });
      });

      expect(
        streamingMarkdownCallbacks.setCurrentMessageId,
      ).toHaveBeenCalledWith("msg-123");
    });

    it("handles content_block_start and creates streaming message", () => {
      const { result } = renderHook(() =>
        useStreamingContent(defaultOptions()),
      );

      // First send message_start to set the ID
      act(() => {
        result.current.handleStreamEvent({
          type: "stream_event",
          event: {
            type: "message_start",
            message: { id: "msg-123" },
          },
        });
      });

      // Then send content_block_start
      act(() => {
        result.current.handleStreamEvent({
          type: "stream_event",
          event: {
            type: "content_block_start",
            index: 0,
            content_block: { type: "text", text: "" },
          },
        });
      });

      expect(onUpdateMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "msg-123",
          type: "assistant",
          _isStreaming: true,
          message: expect.objectContaining({
            content: expect.arrayContaining([
              expect.objectContaining({ type: "text" }),
            ]),
          }),
        }),
        undefined, // no agentId for main stream
      );
    });

    it("accumulates text deltas and throttles updates", () => {
      const { result } = renderHook(() =>
        useStreamingContent(defaultOptions()),
      );

      // Set up streaming
      act(() => {
        result.current.handleStreamEvent({
          type: "stream_event",
          event: {
            type: "message_start",
            message: { id: "msg-123" },
          },
        });
        result.current.handleStreamEvent({
          type: "stream_event",
          event: {
            type: "content_block_start",
            index: 0,
            content_block: { type: "text", text: "" },
          },
        });
      });

      // Clear previous calls
      onUpdateMessage.mockClear();

      // Send multiple deltas rapidly
      act(() => {
        result.current.handleStreamEvent({
          type: "stream_event",
          event: {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "Hello" },
          },
        });
        result.current.handleStreamEvent({
          type: "stream_event",
          event: {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: " world" },
          },
        });
      });

      // Before throttle fires, no update
      expect(onUpdateMessage).not.toHaveBeenCalled();

      // Advance past throttle interval (50ms)
      act(() => {
        vi.advanceTimersByTime(50);
      });

      // Now update should have fired with accumulated text
      expect(onUpdateMessage).toHaveBeenCalledTimes(1);
      expect(onUpdateMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.objectContaining({
            content: expect.arrayContaining([
              expect.objectContaining({ text: "Hello world" }),
            ]),
          }),
        }),
        undefined,
      );
    });

    it("handles thinking deltas", () => {
      const { result } = renderHook(() =>
        useStreamingContent(defaultOptions()),
      );

      act(() => {
        result.current.handleStreamEvent({
          type: "stream_event",
          event: {
            type: "message_start",
            message: { id: "msg-123" },
          },
        });
        result.current.handleStreamEvent({
          type: "stream_event",
          event: {
            type: "content_block_start",
            index: 0,
            content_block: { type: "thinking", thinking: "" },
          },
        });
      });

      onUpdateMessage.mockClear();

      act(() => {
        result.current.handleStreamEvent({
          type: "stream_event",
          event: {
            type: "content_block_delta",
            index: 0,
            delta: { type: "thinking_delta", thinking: "Let me think..." },
          },
        });
      });

      act(() => {
        vi.advanceTimersByTime(50);
      });

      expect(onUpdateMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.objectContaining({
            content: expect.arrayContaining([
              expect.objectContaining({ thinking: "Let me think..." }),
            ]),
          }),
        }),
        undefined,
      );
    });

    it("handles message_stop and calls onStreamEnd", () => {
      const { result } = renderHook(() =>
        useStreamingContent(defaultOptions()),
      );

      act(() => {
        result.current.handleStreamEvent({
          type: "stream_event",
          event: {
            type: "message_start",
            message: { id: "msg-123" },
          },
        });
        result.current.handleStreamEvent({
          type: "stream_event",
          event: {
            type: "message_stop",
          },
        });
      });

      expect(streamingMarkdownCallbacks.onStreamEnd).toHaveBeenCalled();
    });

    it("routes subagent streams with agentId", () => {
      const { result } = renderHook(() =>
        useStreamingContent(defaultOptions()),
      );

      act(() => {
        result.current.handleStreamEvent({
          type: "stream_event",
          isSubagent: true,
          parentToolUseId: "tool-456",
          event: {
            type: "message_start",
            message: { id: "msg-123" },
          },
        });
        result.current.handleStreamEvent({
          type: "stream_event",
          isSubagent: true,
          parentToolUseId: "tool-456",
          event: {
            type: "content_block_start",
            index: 0,
            content_block: { type: "text", text: "" },
          },
        });
      });

      expect(onToolUseMapping).toHaveBeenCalledWith("tool-456", "tool-456");
      expect(onUpdateMessage).toHaveBeenCalledWith(
        expect.objectContaining({ _isStreaming: true }),
        "tool-456", // agentId is passed
      );
    });

    it("extracts context usage for subagent streams", () => {
      const { result } = renderHook(() =>
        useStreamingContent(defaultOptions()),
      );

      act(() => {
        result.current.handleStreamEvent({
          type: "stream_event",
          isSubagent: true,
          parentToolUseId: "tool-456",
          event: {
            type: "message_start",
            message: {
              id: "msg-123",
              usage: { input_tokens: 50000 },
            },
          },
        });
      });

      expect(onAgentContextUsage).toHaveBeenCalledWith("tool-456", {
        inputTokens: 50000,
        percentage: 25, // 50000 / 200000 * 100
      });
    });
  });

  describe("clearStreaming", () => {
    it("clears streaming state and agent ID", () => {
      const { result } = renderHook(() =>
        useStreamingContent(defaultOptions()),
      );

      // Set up streaming with agent
      act(() => {
        result.current.handleStreamEvent({
          type: "stream_event",
          isSubagent: true,
          parentToolUseId: "tool-456",
          event: {
            type: "message_start",
            message: { id: "msg-123" },
          },
        });
      });

      expect(result.current.getCurrentAgentId()).toBe("tool-456");

      act(() => {
        result.current.clearStreaming();
      });

      expect(result.current.getCurrentAgentId()).toBeNull();
    });
  });

  describe("cleanup", () => {
    it("clears pending throttle timers", () => {
      const { result } = renderHook(() =>
        useStreamingContent(defaultOptions()),
      );

      // Set up streaming and send delta to start throttle timer
      act(() => {
        result.current.handleStreamEvent({
          type: "stream_event",
          event: {
            type: "message_start",
            message: { id: "msg-123" },
          },
        });
        result.current.handleStreamEvent({
          type: "stream_event",
          event: {
            type: "content_block_start",
            index: 0,
            content_block: { type: "text", text: "" },
          },
        });
        result.current.handleStreamEvent({
          type: "stream_event",
          event: {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "Hello" },
          },
        });
      });

      onUpdateMessage.mockClear();

      // Call cleanup
      act(() => {
        result.current.cleanup();
      });

      // Advance timers - should not trigger update since timer was cleared
      act(() => {
        vi.advanceTimersByTime(100);
      });

      expect(onUpdateMessage).not.toHaveBeenCalled();
    });
  });

  describe("getCurrentAgentId", () => {
    it("returns null when no streaming", () => {
      const { result } = renderHook(() =>
        useStreamingContent(defaultOptions()),
      );

      expect(result.current.getCurrentAgentId()).toBeNull();
    });

    it("returns agentId during subagent streaming", () => {
      const { result } = renderHook(() =>
        useStreamingContent(defaultOptions()),
      );

      act(() => {
        result.current.handleStreamEvent({
          type: "stream_event",
          isSubagent: true,
          parentToolUseId: "tool-789",
          event: {
            type: "message_start",
            message: { id: "msg-123" },
          },
        });
      });

      expect(result.current.getCurrentAgentId()).toBe("tool-789");
    });
  });
});
