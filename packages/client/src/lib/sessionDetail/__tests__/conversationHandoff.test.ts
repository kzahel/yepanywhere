import { describe, expect, it } from "vitest";
import type { Message } from "../../../types";
import type {
  RenderItem,
  ToolCallItem,
} from "@yep-anywhere/shared/transcript/items";
import {
  buildConversationHandoffPrefill,
  buildConversationHandoffPreamble,
} from "../conversationHandoff";
import { conversationViewSurfaceReason } from "../conversationView";

function source(id: string, timestampMs: number): Message {
  return {
    id,
    timestamp: new Date(timestampMs).toISOString(),
  } as Message;
}

function tool(
  id: string,
  timestampMs: number,
  overrides: Partial<ToolCallItem> = {},
): ToolCallItem {
  return {
    type: "tool_call",
    id,
    toolName: "Read",
    toolInput: {},
    status: "complete",
    sourceMessages: [source(`${id}-source`, timestampMs)],
    ...overrides,
  };
}

const uploadBlock = `Please inspect this screenshot.

User uploaded files:
- [image.png](</home/graehl/.yep-anywhere/projects/abc/attachments/sess/uuid_image.png>) (4 kb, image/png, 177x69)`;

function transcript(): RenderItem[] {
  return [
    {
      type: "user_prompt",
      id: "user-1",
      content: "Older request",
      sourceMessages: [source("user-1-source", 100)],
    },
    {
      type: "text",
      id: "older-answer",
      text: "Older **markdown** answer.",
      augmentHtml: "<p>Older <strong>markdown</strong> answer.</p>",
      sourceMessages: [source("older-answer-source", 200)],
    },
    {
      type: "user_prompt",
      id: "user-2",
      content: uploadBlock,
      sourceMessages: [source("user-2-source", 500)],
    },
    {
      type: "thinking",
      id: "thinking",
      thinking: "Planning",
      status: "complete",
      sourceMessages: [source("thinking-source", 1_000)],
    },
    tool("routine-tool", 2_000),
    {
      type: "text",
      id: "answer",
      text: "Here is the **result**.",
      augmentHtml: "<p>Here is the <strong>result</strong>.</p>",
      sourceMessages: [source("answer-source", 3_000)],
    },
    tool("image-tool", 4_000, {
      toolResult: {
        content: "",
        isError: false,
        media: [
          {
            state: "rejected",
            reason: "unsupported-media",
            filename: "docs/result.png",
            toolCallId: "image-tool",
          },
        ],
      },
    }),
    tool("failed-edit", 4_500, {
      toolName: "Edit",
      status: "error",
      toolInput: { file_path: "src/app.ts" },
    }),
    tool("failed-read", 5_000, { status: "error" }),
    {
      type: "system",
      id: "compact",
      subtype: "compact_boundary",
      content: "Context compacted",
      sourceMessages: [source("compact-source", 5_200)],
    },
    {
      type: "task_notification",
      id: "failed-task",
      raw: "<task-notification><status>failed</status></task-notification>",
      status: "failed",
      summary: "Background task failed",
      sourceMessages: [source("failed-task-source", 5_500)],
    },
  ];
}

describe("conversationViewSurfaceReason", () => {
  it("marks routine work as activity, failures as error, and prose as importance", () => {
    const items = transcript();
    expect(conversationViewSurfaceReason(items[3]!)).toBe("activity");
    expect(conversationViewSurfaceReason(items[4]!)).toBe("activity");
    expect(conversationViewSurfaceReason(items[5]!)).toBe("importance");
    expect(conversationViewSurfaceReason(items[6]!)).toBe("importance");
    expect(conversationViewSurfaceReason(items[7]!)).toBe("error");
    expect(conversationViewSurfaceReason(items[8]!)).toBe("error");
  });
});

describe("buildConversationHandoffPrefill", () => {
  it("uses original markdown from the in-memory projection without Conversation view enabled", () => {
    const text = buildConversationHandoffPrefill({
      items: transcript(),
      fromUserTurnId: "user-2",
      provider: "grok",
      sessionId: "01a084df-0d9a-7801-9d77-a183cb9dff9a",
      nowMs: 9_000,
    });

    expect(text).toBe(`You are taking over for a stopped session.
Any of the session's edit locks or other authorizations are hereby yours.
"user: " indicating a user turn, activity details elided (see grok session 01a084df-0d9a-7801-9d77-a183cb9dff9a if needed), session-final conversation follows verbatim:

user: Please inspect this screenshot.
image.png

Here is the **result**.

docs/result.png`);
    expect(text).not.toContain("Older request");
    expect(text).not.toContain("<strong>");
    expect(text).not.toContain("User uploaded files");
    expect(text).not.toContain("Context compacted");
    expect(text).not.toContain("activities");
    expect(text).not.toContain("Planning");
    expect(text).not.toContain("Failed");
  });

  it("includes /goal when the source session has one", () => {
    expect(
      buildConversationHandoffPreamble({
        provider: "claude",
        sessionId: "sess-1",
        goal: "  ship the menu\nnow  ",
      }),
    ).toContain(
      "You are taking over for a stopped session with /goal ship the menu now.",
    );
  });

  it("returns null when the selected turn is not in memory", () => {
    expect(
      buildConversationHandoffPrefill({
        items: transcript(),
        fromUserTurnId: "missing",
        provider: "grok",
        sessionId: "sess-1",
      }),
    ).toBeNull();
  });
});
