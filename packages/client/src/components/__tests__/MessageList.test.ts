import { describe, expect, it } from "vitest";
import type { RenderItem } from "../../types/renderItems";
import {
  buildAssistantTurnRenderSegments,
  groupAssistantTurnSegments,
} from "../MessageList";

function createTextItem(id: string, text: string): RenderItem {
  return {
    type: "text",
    id,
    text,
    sourceMessages: [],
  };
}

function createToolCallItem(id: string, toolName: string): RenderItem {
  return {
    type: "tool_call",
    id,
    toolName,
    toolInput: {},
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
    );

    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatchObject({
      kind: "folded_reasoning",
      summary: "Worked for 1m 12s",
      collapsedItems: [{ id: "text-1" }, { id: "tool-1" }],
      visibleItems: [{ id: "text-2" }],
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
