import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Message } from "../../types";
import type { RenderItem } from "../../types/renderItems";
import {
  MessageList,
  buildAssistantTurnRenderSegments,
  getDisplayAssistantTurnItems,
  hasPendingOperation,
  getStreamingTurnSummary,
  groupAssistantTurnSegments,
} from "../MessageList";
import { afterEach, describe, expect, it, vi } from "vitest";

function createTextItem(id: string, text: string): RenderItem {
  return {
    type: "text",
    id,
    text,
    sourceMessages: [],
  };
}

function createToolCallItem(
  id: string,
  toolName: string,
  status: "pending" | "complete" | "error" | "aborted" = "complete",
): RenderItem {
  return {
    type: "tool_call",
    id,
    toolName,
    toolInput: {},
    status,
    sourceMessages: [],
  };
}

function createThinkingItem(id: string, thinking: string): RenderItem {
  return {
    type: "thinking",
    id,
    thinking,
    status: "complete",
    sourceMessages: [],
  };
}

describe("groupAssistantTurnSegments", () => {
  it("keeps descriptive text visible and collapses consecutive operations into one segment", () => {
    const segments = groupAssistantTurnSegments([
      createTextItem("text-1", "Planning the next step."),
      createToolCallItem("tool-1", "Read"),
      createToolCallItem("tool-2", "Bash"),
      createToolCallItem("tool-3", "WriteStdin"),
      createTextItem("text-2", "Found the root cause."),
    ]);

    expect(segments).toHaveLength(3);
    expect(segments[0]).toMatchObject({
      kind: "items",
      items: [{ type: "text", id: "text-1" }],
    });
    expect(segments[1]).toMatchObject({
      kind: "operations",
      items: [
        { type: "tool_call", id: "tool-1" },
        { type: "tool_call", id: "tool-2" },
        { type: "tool_call", id: "tool-3" },
      ],
    });
    expect(segments[2]).toMatchObject({
      kind: "items",
      items: [{ type: "text", id: "text-2" }],
    });
  });

  it("collapses a single isolated operation", () => {
    const segments = groupAssistantTurnSegments([
      createTextItem("text-1", "Checking one thing."),
      createToolCallItem("tool-1", "Read"),
      createTextItem("text-2", "Done."),
    ]);

    expect(segments).toHaveLength(3);
    expect(segments[0]).toMatchObject({
      kind: "items",
      items: [{ type: "text", id: "text-1" }],
    });
    expect(segments[1]).toMatchObject({
      kind: "operations",
      items: [{ type: "tool_call", id: "tool-1" }],
    });
    expect(segments[2]).toMatchObject({
      kind: "items",
      items: [{ type: "text", id: "text-2" }],
    });
  });
});

describe("hasPendingOperation", () => {
  it("returns true when any operation is still pending", () => {
    expect(
      hasPendingOperation([
        createToolCallItem("tool-1", "Read", "pending"),
        createToolCallItem("tool-2", "Bash"),
      ]),
    ).toBe(true);
  });

  it("returns false when all operations are finished", () => {
    expect(
      hasPendingOperation([
        createToolCallItem("tool-1", "Read"),
        createToolCallItem("tool-2", "Bash", "aborted"),
      ]),
    ).toBe(false);
  });
});

describe("buildAssistantTurnRenderSegments", () => {
  it("folds completed reasoning work and keeps the final text visible", () => {
    const segments = buildAssistantTurnRenderSegments(
      [
        {
          ...createTextItem("text-1", "Planning the next step."),
          sourceMessages: [{ timestamp: "2026-05-17T10:00:00.000Z" }],
        },
        {
          ...createToolCallItem("tool-1", "Read"),
          sourceMessages: [{ timestamp: "2026-05-17T10:00:10.000Z" }],
        },
        {
          ...createTextItem("text-2", "Done."),
          sourceMessages: [{ timestamp: "2026-05-17T10:01:12.000Z" }],
        },
      ],
      false,
      [
        {
          ...createTextItem("text-1", "Planning the next step."),
          sourceMessages: [{ timestamp: "2026-05-17T10:00:00.000Z" }],
        },
        {
          ...createToolCallItem("tool-1", "Read"),
          sourceMessages: [{ timestamp: "2026-05-17T10:00:10.000Z" }],
        },
        {
          ...createTextItem("text-2", "Done."),
          sourceMessages: [{ timestamp: "2026-05-17T10:01:12.000Z" }],
        },
      ],
      "2026-05-17T10:00:00.000Z",
    );

    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatchObject({
      kind: "folded_reasoning",
      summary: "Worked for 1m 12s",
      collapsedItems: [{ id: "text-1" }, { id: "tool-1" }],
      visibleItems: [{ id: "text-2" }],
    });
  });

  it("uses the final visible summary text timestamp as the completed end time", () => {
    const segments = buildAssistantTurnRenderSegments(
      [
        {
          ...createTextItem("text-1", "Thinking..."),
          sourceMessages: [{ timestamp: "2026-05-17T10:00:00.000Z" }],
        },
        {
          ...createToolCallItem("tool-1", "Read"),
          sourceMessages: [{ timestamp: "2026-05-17T10:00:10.000Z" }],
        },
        {
          ...createTextItem("text-2", "Final answer."),
          sourceMessages: [{ timestamp: "2026-05-17T10:00:18.000Z" }],
        },
      ],
      false,
      [
        {
          ...createTextItem("text-1", "Thinking..."),
          sourceMessages: [{ timestamp: "2026-05-17T10:00:00.000Z" }],
        },
        {
          ...createToolCallItem("tool-1", "Read"),
          sourceMessages: [{ timestamp: "2026-05-17T10:00:10.000Z" }],
        },
        {
          ...createTextItem("text-2", "Final answer."),
          sourceMessages: [{ timestamp: "2026-05-17T10:00:18.000Z" }],
        },
      ],
      "2026-05-17T10:00:00.000Z",
    );

    expect(segments[0]).toMatchObject({
      kind: "folded_reasoning",
      summary: "Worked for 18s",
    });
  });

  it("includes hidden thinking items in worked-for timing", () => {
    const visibleItems = getDisplayAssistantTurnItems([
      {
        ...createThinkingItem("thinking-1", "Hidden thinking"),
        sourceMessages: [{ timestamp: "2026-05-17T10:00:00.000Z" }],
      },
      {
        ...createToolCallItem("tool-1", "Read"),
        sourceMessages: [{ timestamp: "2026-05-17T10:00:20.000Z" }],
      },
      {
        ...createTextItem("text-1", "Final answer."),
        sourceMessages: [{ timestamp: "2026-05-17T10:00:30.000Z" }],
      },
    ]);

    const segments = buildAssistantTurnRenderSegments(
      visibleItems,
      false,
      [
        {
          ...createThinkingItem("thinking-1", "Hidden thinking"),
          sourceMessages: [{ timestamp: "2026-05-17T10:00:00.000Z" }],
        },
        {
          ...createToolCallItem("tool-1", "Read"),
          sourceMessages: [{ timestamp: "2026-05-17T10:00:20.000Z" }],
        },
        {
          ...createTextItem("text-1", "Final answer."),
          sourceMessages: [{ timestamp: "2026-05-17T10:00:30.000Z" }],
        },
      ],
      "2026-05-17T10:00:00.000Z",
    );

    expect(segments[0]).toMatchObject({
      kind: "folded_reasoning",
      summary: "Worked for 30s",
    });
  });

  it("prefers explicit turnStartedAt when provided", () => {
    const visibleItems = getDisplayAssistantTurnItems([
      {
        ...createThinkingItem("thinking-1", "Hidden thinking"),
        sourceMessages: [{ timestamp: "2026-05-17T10:00:05.000Z" }],
      },
      {
        ...createToolCallItem("tool-1", "Read"),
        sourceMessages: [{ timestamp: "2026-05-17T10:00:20.000Z" }],
      },
      {
        ...createTextItem("text-1", "Final answer."),
        sourceMessages: [{ timestamp: "2026-05-17T10:00:30.000Z" }],
      },
    ]);

    const segments = buildAssistantTurnRenderSegments(
      visibleItems,
      false,
      [
        {
          ...createThinkingItem("thinking-1", "Hidden thinking"),
          sourceMessages: [{ timestamp: "2026-05-17T10:00:05.000Z" }],
        },
        {
          ...createToolCallItem("tool-1", "Read"),
          sourceMessages: [{ timestamp: "2026-05-17T10:00:20.000Z" }],
        },
        {
          ...createTextItem("text-1", "Final answer."),
          sourceMessages: [{ timestamp: "2026-05-17T10:00:30.000Z" }],
        },
      ],
      "2026-05-17T10:00:00.000Z",
    );

    expect(segments[0]).toMatchObject({
      kind: "folded_reasoning",
      summary: "Worked for 30s",
    });
  });

  it("uses the user prompt timestamp as the completed turn start when provided", () => {
    const segments = buildAssistantTurnRenderSegments(
      [
        {
          ...createToolCallItem("tool-1", "Read"),
          sourceMessages: [{ timestamp: "2026-05-17T10:00:05.000Z" }],
        },
        {
          ...createTextItem("text-1", "Final answer."),
          sourceMessages: [{ timestamp: "2026-05-17T10:00:30.000Z" }],
        },
      ],
      false,
      [
        {
          ...createToolCallItem("tool-1", "Read"),
          sourceMessages: [{ timestamp: "2026-05-17T10:00:05.000Z" }],
        },
        {
          ...createTextItem("text-1", "Final answer."),
          sourceMessages: [{ timestamp: "2026-05-17T10:00:30.000Z" }],
        },
      ],
      "2026-05-17T10:00:00.000Z",
    );

    expect(segments[0]).toMatchObject({
      kind: "folded_reasoning",
      summary: "Worked for 30s",
    });
  });

  it("falls back to turn item timestamps when turnStartedAt is missing", () => {
    const segments = buildAssistantTurnRenderSegments(
      [
        {
          ...createToolCallItem("tool-1", "Read"),
          sourceMessages: [{ timestamp: "2026-05-17T10:00:00.100Z" }],
        },
        {
          ...createTextItem("text-1", "Final answer."),
          sourceMessages: [{ timestamp: "2026-05-17T10:00:00.650Z" }],
        },
      ],
      false,
      [
        {
          ...createToolCallItem("tool-1", "Read"),
          sourceMessages: [{ timestamp: "2026-05-17T10:00:00.100Z" }],
        },
        {
          ...createTextItem("text-1", "Final answer."),
          sourceMessages: [{ timestamp: "2026-05-17T10:00:00.650Z" }],
        },
      ],
      null,
    );

    expect(segments[0]).toMatchObject({
      kind: "folded_reasoning",
      summary: "Worked for 1s",
    });
  });

  it("does not fold while the turn is still streaming", () => {
    const segments = buildAssistantTurnRenderSegments(
      [
        createTextItem("text-1", "Planning the next step."),
        createToolCallItem("tool-1", "Read"),
        createTextItem("text-2", "Still working..."),
      ],
      true,
    );

    expect(segments).toHaveLength(3);
    expect(segments[0]).toMatchObject({ kind: "items" });
    expect(segments[1]).toMatchObject({ kind: "operations" });
    expect(segments[2]).toMatchObject({ kind: "items" });
  });
});

describe("getDisplayAssistantTurnItems", () => {
  it("hides all thinking items from assistant turns", () => {
    const items = getDisplayAssistantTurnItems([
      createThinkingItem("thinking-1", "Reasoning [internal]"),
      createThinkingItem("thinking-2", "Visible thinking"),
      createToolCallItem("tool-1", "Read"),
      createTextItem("text-1", "Current answer"),
    ]);

    expect(items).toMatchObject([
      { type: "tool_call", id: "tool-1" },
      { type: "text", id: "text-1" },
    ]);
  });
});

describe("getStreamingTurnSummary", () => {
  it("shows a working label based on the current time", () => {
    const summary = getStreamingTurnSummary(
      Date.parse("2026-05-17T10:00:12.000Z"),
      "2026-05-17T10:00:00.000Z",
    );

    expect(summary).toBe("Working for 12s");
  });

  it("rounds sub-second active turns to the nearest second", () => {
    const summary = getStreamingTurnSummary(
      Date.parse("2026-05-17T10:00:00.450Z"),
      "2026-05-17T10:00:00.000Z",
    );

    expect(summary).toBe("Working for 0s");
  });
});

describe("streaming fallback duration", () => {
  it("starts fallback timing from the latest user prompt when older assistant turns exist", () => {
    const summary = getStreamingTurnSummary(
      Date.parse("2026-05-17T10:00:12.000Z"),
      "2026-05-17T10:00:00.000Z",
    );

    expect(summary).toBe("Working for 12s");
  });
});

describe("streaming fallback layout", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders the initial working summary inside an assistant-turn placeholder", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-17T10:01:00.000Z"));
    vi.stubGlobal("localStorage", {
      getItem: vi.fn().mockReturnValue("false"),
      setItem: vi.fn(),
    });

    const messages: Message[] = [
      {
        uuid: "user-1",
        type: "user",
        timestamp: "2026-05-17T10:01:00.000Z",
        content: "Next prompt",
      },
    ];

    const html = renderToStaticMarkup(
      createElement(MessageList, {
        messages,
        isProcessing: true,
        turnStartedAt: "2026-05-17T10:01:00.000Z",
      }),
    );

    expect(html).toContain("Working for 0s");
    expect(html).toContain("assistant-turn assistant-turn-placeholder");
    vi.useRealTimers();
  });
});
