import type { TranscriptDisplayObject } from "@yep-anywhere/shared";
import { describe, expect, it } from "vitest";
import type { Message } from "../../types";
import type { RenderItem } from "@yep-anywhere/shared/transcript/items";
import { insertTranscriptDisplayObjects } from "../transcriptDisplayObjects";

function displayObject(
  id: string,
  placementAfterMessageId: string,
): TranscriptDisplayObject {
  return {
    id,
    kind: "fork-summary",
    createdAt: "2026-06-23T00:00:00.000Z",
    placementAfterMessageId,
    sourceMessageId: "user-1",
    retainedThroughMessageId: "assistant-1",
    status: "generating",
  };
}

describe("insertTranscriptDisplayObjects", () => {
  it("places objects after the last render item sourced from the anchor", () => {
    const anchor: Message = { id: "assistant-1", type: "assistant" };
    const items: RenderItem[] = [
      {
        type: "thinking",
        id: "thinking-1",
        thinking: "working",
        status: "complete",
        sourceMessages: [anchor],
      },
      {
        type: "text",
        id: "text-1",
        text: "done",
        sourceMessages: [anchor],
      },
      {
        type: "user_prompt",
        id: "user-2",
        content: "later",
        sourceMessages: [{ id: "user-2", type: "user" }],
      },
    ];

    const result = insertTranscriptDisplayObjects(items, [
      displayObject("display-1", "assistant-1"),
    ]);

    expect(result.map((item) => item.id)).toEqual([
      "thinking-1",
      "text-1",
      "display-1",
      "user-2",
    ]);
  });

  it("omits objects until their placement anchor is loaded", () => {
    const items: RenderItem[] = [
      {
        type: "user_prompt",
        id: "user-2",
        content: "later",
        sourceMessages: [{ id: "user-2", type: "user" }],
      },
    ];

    expect(
      insertTranscriptDisplayObjects(items, [
        displayObject("display-1", "assistant-1"),
      ]),
    ).toBe(items);
  });
});
