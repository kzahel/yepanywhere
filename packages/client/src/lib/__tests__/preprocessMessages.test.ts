import { describe, expect, it } from "vitest";
import type { Message } from "../../types";
import { preprocessMessages } from "../preprocessMessages";

describe("preprocessMessages", () => {
  it("pairs tool_use with tool_result", () => {
    const messages: Message[] = [
      {
        id: "msg-1",
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tool-1",
            name: "Read",
            input: { file_path: "test.ts" },
          },
        ],
        timestamp: "2024-01-01T00:00:00Z",
      },
      {
        id: "msg-2",
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tool-1",
            content: "file contents",
          },
        ],
        timestamp: "2024-01-01T00:00:01Z",
      },
    ];

    const items = preprocessMessages(messages);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      type: "tool_call",
      id: "tool-1",
      toolName: "Read",
      status: "complete",
      toolResult: { content: "file contents", isError: false },
    });
  });

  it("marks tool_use as pending when result not yet received", () => {
    const messages: Message[] = [
      {
        id: "msg-1",
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tool-1",
            name: "Bash",
            input: { command: "npm test" },
          },
        ],
        timestamp: "2024-01-01T00:00:00Z",
      },
    ];

    const items = preprocessMessages(messages);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      type: "tool_call",
      status: "pending",
      toolResult: undefined,
    });
  });

  it("handles multiple tool calls in sequence", () => {
    const messages: Message[] = [
      {
        id: "msg-1",
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tool-1",
            name: "Read",
            input: { file_path: "a.ts" },
          },
          {
            type: "tool_use",
            id: "tool-2",
            name: "Read",
            input: { file_path: "b.ts" },
          },
        ],
        timestamp: "2024-01-01T00:00:00Z",
      },
      {
        id: "msg-2",
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "tool-1", content: "contents a" },
          { type: "tool_result", tool_use_id: "tool-2", content: "contents b" },
        ],
        timestamp: "2024-01-01T00:00:01Z",
      },
    ];

    const items = preprocessMessages(messages);

    expect(items).toHaveLength(2);
    const item0 = items[0];
    const item1 = items[1];
    expect(item0?.type).toBe("tool_call");
    expect(item1?.type).toBe("tool_call");
    if (item0?.type === "tool_call" && item1?.type === "tool_call") {
      expect(item0.status).toBe("complete");
      expect(item1.status).toBe("complete");
    }
  });

  it("preserves thinking blocks", () => {
    const messages: Message[] = [
      {
        id: "msg-1",
        role: "assistant",
        content: [
          { type: "thinking", thinking: "Let me analyze this..." },
          { type: "text", text: "Here is my response." },
        ],
        timestamp: "2024-01-01T00:00:00Z",
      },
    ];

    const items = preprocessMessages(messages);

    expect(items).toHaveLength(2);
    expect(items[0]?.type).toBe("thinking");
    expect(items[1]?.type).toBe("text");
  });

  it("handles user prompts with string content", () => {
    const messages: Message[] = [
      {
        id: "msg-1",
        role: "user",
        content: "Hello, please help me",
        timestamp: "2024-01-01T00:00:00Z",
      },
    ];

    const items = preprocessMessages(messages);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      type: "user_prompt",
      id: "msg-1",
      content: "Hello, please help me",
    });
  });

  it("marks tool result as error when is_error is true", () => {
    const messages: Message[] = [
      {
        id: "msg-1",
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tool-1",
            name: "Bash",
            input: { command: "invalid" },
          },
        ],
        timestamp: "2024-01-01T00:00:00Z",
      },
      {
        id: "msg-2",
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tool-1",
            content: "Command failed",
            is_error: true,
          },
        ],
        timestamp: "2024-01-01T00:00:01Z",
      },
    ];

    const items = preprocessMessages(messages);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      type: "tool_call",
      status: "error",
      toolResult: { content: "Command failed", isError: true },
    });
  });

  it("skips empty text blocks", () => {
    const messages: Message[] = [
      {
        id: "msg-1",
        role: "assistant",
        content: [
          { type: "text", text: "" },
          { type: "text", text: "   " },
          { type: "text", text: "Actual content" },
        ],
        timestamp: "2024-01-01T00:00:00Z",
      },
    ];

    const items = preprocessMessages(messages);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      type: "text",
      text: "Actual content",
    });
  });

  it("attaches structured tool result data", () => {
    const messages: Message[] = [
      {
        id: "msg-1",
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tool-1",
            name: "Read",
            input: { file_path: "test.ts" },
          },
        ],
        timestamp: "2024-01-01T00:00:00Z",
      },
      {
        id: "msg-2",
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tool-1",
            content: "file contents",
          },
        ],
        timestamp: "2024-01-01T00:00:01Z",
        toolUseResult: { lineCount: 42, filePath: "/test.ts" },
      },
    ];

    const items = preprocessMessages(messages);

    expect(items).toHaveLength(1);
    const item = items[0];
    if (item?.type === "tool_call") {
      expect(item.toolResult?.structured).toEqual({
        lineCount: 42,
        filePath: "/test.ts",
      });
    }
  });

  describe("orphaned tool handling", () => {
    it("marks orphaned tool_use as aborted", () => {
      const messages: Message[] = [
        {
          id: "msg-1",
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "tool-1",
              name: "Bash",
              input: { command: "npm test" },
            },
          ],
          timestamp: "2024-01-01T00:00:00Z",
          orphanedToolUseIds: ["tool-1"],
        },
      ];

      const items = preprocessMessages(messages);

      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({
        type: "tool_call",
        id: "tool-1",
        status: "aborted",
        toolResult: undefined,
      });
    });

    it("handles mix of orphaned and completed tools", () => {
      const messages: Message[] = [
        {
          id: "msg-1",
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "tool-1",
              name: "Read",
              input: { file_path: "a.ts" },
            },
            {
              type: "tool_use",
              id: "tool-2",
              name: "Bash",
              input: { command: "npm test" },
            },
          ],
          timestamp: "2024-01-01T00:00:00Z",
          orphanedToolUseIds: ["tool-2"], // only tool-2 is orphaned
        },
        {
          id: "msg-2",
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-1",
              content: "file contents",
            },
          ],
          timestamp: "2024-01-01T00:00:01Z",
        },
      ];

      const items = preprocessMessages(messages);

      expect(items).toHaveLength(2);
      const tool1 = items.find(
        (i) => i.type === "tool_call" && i.id === "tool-1",
      );
      const tool2 = items.find(
        (i) => i.type === "tool_call" && i.id === "tool-2",
      );

      expect(tool1?.type === "tool_call" && tool1.status).toBe("complete");
      expect(tool2?.type === "tool_call" && tool2.status).toBe("aborted");
    });

    it("non-orphaned pending tools remain pending", () => {
      const messages: Message[] = [
        {
          id: "msg-1",
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "tool-1",
              name: "Bash",
              input: { command: "npm test" },
            },
          ],
          timestamp: "2024-01-01T00:00:00Z",
          // No orphanedToolUseIds - tool is still pending (live conversation)
        },
      ];

      const items = preprocessMessages(messages);

      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({
        type: "tool_call",
        id: "tool-1",
        status: "pending",
      });
    });
  });
});
