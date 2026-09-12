import { describe, expect, it } from "vitest";
import type { Message } from "../../types";
import type { RenderItem } from "@yep-anywhere/shared/transcript/items";
import {
  buildTimelineEntryDisplayRows,
  buildVisibleTimelineEntries,
  groupRenderItemsIntoTurns,
  stabilizeRenderTurnGroups,
  stabilizeTimelineEntryDisplayRows,
} from "../sessionDetail/renderSelectors";
import { stabilizeRenderItems } from "../stableRenderItems";

describe("stabilizeRenderItems", () => {
  it("reuses unchanged render item objects when preprocessing rebuilds arrays", () => {
    const firstMessage: Message = {
      id: "msg-1",
      type: "assistant",
      message: { role: "assistant", content: "first" },
    };
    const secondMessage: Message = {
      id: "msg-2",
      type: "assistant",
      message: { role: "assistant", content: "second" },
    };

    const previousFirst: RenderItem = {
      type: "text",
      id: "msg-1",
      text: "first",
      sourceMessages: [firstMessage],
    };
    const previousSecond: RenderItem = {
      type: "text",
      id: "msg-2",
      text: "second",
      sourceMessages: [secondMessage],
    };
    const rebuiltFirst: RenderItem = {
      type: "text",
      id: "msg-1",
      text: "first",
      sourceMessages: [firstMessage],
    };
    const updatedSecond: RenderItem = {
      type: "text",
      id: "msg-2",
      text: "second update",
      sourceMessages: [{ ...secondMessage }],
    };

    const stable = stabilizeRenderItems(
      [previousFirst, previousSecond],
      [rebuiltFirst, updatedSecond],
    );

    expect(stable[0]).toBe(previousFirst);
    expect(stable[1]).toBe(updatedSecond);
  });

  it("reuses tool projections rebuilt from unchanged source messages", () => {
    const toolUse: Message = {
      id: "tool-use",
      type: "assistant",
      message: { role: "assistant", content: "" },
    };
    const toolResult: Message = {
      id: "tool-result",
      type: "user",
      message: { role: "user", content: "" },
    };
    const previous: RenderItem = {
      type: "tool_call",
      id: "read-1",
      toolName: "Read",
      toolInput: { file_path: "README.md" },
      displayActions: [{ kind: "read", path: "README.md", name: "README.md" }],
      toolResult: { content: "contents", isError: false },
      status: "complete",
      sourceMessages: [toolUse, toolResult],
    };
    const rebuilt: RenderItem = {
      ...previous,
      toolInput: { file_path: "README.md" },
      displayActions: [{ kind: "read", path: "README.md", name: "README.md" }],
      toolResult: { content: "contents", isError: false },
      sourceMessages: [toolUse, toolResult],
    };
    const changed: RenderItem = { ...rebuilt, status: "error" };

    expect(stabilizeRenderItems([previous], [rebuilt])[0]).toBe(previous);
    expect(stabilizeRenderItems([previous], [changed])[0]).toBe(changed);
  });

  it("reuses an unchanged transcript display object", () => {
    const object = {
      id: "display-1",
      kind: "fork-summary" as const,
      createdAt: "2026-06-23T00:00:00.000Z",
      placementAfterMessageId: "assistant-1",
      sourceMessageId: "user-1",
      retainedThroughMessageId: "assistant-1",
      status: "generating" as const,
    };
    const previous: RenderItem = {
      type: "transcript_display_object",
      id: object.id,
      object,
      sourceMessages: [],
    };
    const next: RenderItem = { ...previous };

    expect(stabilizeRenderItems([previous], [next])[0]).toBe(previous);
  });

  it("keeps historical turn and display-row identity across a tail update", () => {
    const userOne: RenderItem = {
      type: "user_prompt",
      id: "user-1",
      content: "first",
      sourceMessages: [],
    };
    const assistantOne: RenderItem = {
      type: "text",
      id: "assistant-1",
      text: "settled",
      sourceMessages: [],
    };
    const userTwo: RenderItem = {
      type: "user_prompt",
      id: "user-2",
      content: "second",
      sourceMessages: [],
    };
    const previousTail: RenderItem = {
      type: "text",
      id: "assistant-2",
      text: "streaming",
      isStreaming: true,
      sourceMessages: [],
    };
    const nextTail: RenderItem = {
      ...previousTail,
      text: "streaming update",
    };
    const previousGroups = groupRenderItemsIntoTurns([
      userOne,
      assistantOne,
      userTwo,
      previousTail,
    ]);
    const nextGroups = stabilizeRenderTurnGroups(
      previousGroups,
      groupRenderItemsIntoTurns([userOne, assistantOne, userTwo, nextTail]),
    );

    expect(nextGroups.slice(0, 3)).toEqual(previousGroups.slice(0, 3));
    expect(nextGroups[0]).toBe(previousGroups[0]);
    expect(nextGroups[1]).toBe(previousGroups[1]);
    expect(nextGroups[2]).toBe(previousGroups[2]);
    expect(nextGroups[3]).not.toBe(previousGroups[3]);

    const previousRows = buildTimelineEntryDisplayRows({
      entries: buildVisibleTimelineEntries({ turnGroups: previousGroups }),
      latestCorrectablePromptId: "user-2",
      latestVisibleTimestampMs: null,
      nowMs: 1,
    });
    const nextRows = stabilizeTimelineEntryDisplayRows(
      previousRows,
      buildTimelineEntryDisplayRows({
        entries: buildVisibleTimelineEntries({ turnGroups: nextGroups }),
        latestCorrectablePromptId: "user-2",
        latestVisibleTimestampMs: null,
        nowMs: 1,
      }),
    );

    expect(nextRows[0]).toBe(previousRows[0]);
    expect(nextRows[1]).toBe(previousRows[1]);
    expect(nextRows[2]).toBe(previousRows[2]);
    expect(nextRows[3]).not.toBe(previousRows[3]);
  });

  it("refreshes a stable row when its latest-message age role changes", () => {
    const timestamp = "2026-08-23T08:00:00.000Z";
    const source: Message = {
      type: "user",
      uuid: "user-age",
      timestamp,
      message: { role: "user", content: "aged" },
    };
    const item: RenderItem = {
      type: "user_prompt",
      id: "user-age",
      content: "aged",
      sourceMessages: [source],
    };
    const groups = groupRenderItemsIntoTurns([item]);
    const entries = buildVisibleTimelineEntries({ turnGroups: groups });
    const previousRows = buildTimelineEntryDisplayRows({
      entries,
      latestVisibleTimestampMs: Date.parse(timestamp),
      nowMs: Date.parse(timestamp) + 60_000,
    });
    const nextRows = stabilizeTimelineEntryDisplayRows(
      previousRows,
      buildTimelineEntryDisplayRows({
        entries,
        latestVisibleTimestampMs: Date.parse(timestamp) + 1,
        nowMs: Date.parse(timestamp) + 60_000,
      }),
    );

    expect(previousRows[0]?.kind).toBe("user");
    expect(nextRows[0]).not.toBe(previousRows[0]);
  });
});
