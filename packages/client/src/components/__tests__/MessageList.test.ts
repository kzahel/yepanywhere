import { describe, expect, it } from "vitest";
import { groupAssistantTurnSegments } from "../MessageList";
import type { RenderItem } from "../../types/renderItems";

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
