import { describe, expect, it } from "vitest";
import type { Message } from "../../types";
import type { RenderItem } from "@yep-anywhere/shared/transcript/items";
import { compileTranscriptProjection } from "@yep-anywhere/shared/transcript/compiler";
import { getCachedWebTranscriptProjection } from "../webTranscriptProjection";

function sourceIds(item: RenderItem): string[] {
  return item.sourceMessages.map(
    (message) => message.id ?? message.uuid ?? "missing-id",
  );
}

function characterize(item: RenderItem): Record<string, unknown> {
  const base = {
    type: item.type,
    id: item.id,
    sourceIds: sourceIds(item),
  };
  switch (item.type) {
    case "text":
      return {
        ...base,
        text: item.text,
        isStreaming: item.isStreaming,
        augmentHtml: item.augmentHtml,
      };
    case "thinking":
      return {
        ...base,
        thinking: item.thinking,
        status: item.status,
      };
    case "tool_call":
      return {
        ...base,
        toolName: item.toolName,
        toolInput: item.toolInput,
        toolResult: item.toolResult,
        status: item.status,
      };
    case "user_prompt":
      return { ...base, content: item.content };
    case "session_setup":
      return { ...base, title: item.title, prompts: item.prompts };
    case "system":
      return {
        ...base,
        subtype: item.subtype,
        content: item.content,
        details: item.details,
      };
    case "task_notification":
      return {
        ...base,
        taskId: item.taskId,
        toolUseId: item.toolUseId,
        status: item.status,
        summary: item.summary,
      };
    case "transcript_display_object":
      return { ...base, object: item.object };
    case "conversation_activity":
      return {
        ...base,
        activityCount: item.activityCount,
        active: item.active,
        expanded: item.expanded,
        startedAtMs: item.startedAtMs,
        endedAtMs: item.endedAtMs,
      };
  }
}

describe("transcript projection characterization", () => {
  it("keeps pure compilation separate from the cached web adapter", () => {
    const messages: Message[] = [
      {
        id: "facade-user",
        role: "user",
        content: "Compile the fixture",
      },
      {
        id: "facade-assistant",
        role: "assistant",
        content: "The fixture is compiled.",
      },
    ];

    const firstCompiled = compileTranscriptProjection(messages);
    const secondCompiled = compileTranscriptProjection(messages);
    const firstCached = getCachedWebTranscriptProjection(messages);

    expect(firstCompiled).toEqual(firstCached);
    expect(secondCompiled).toEqual(firstCached);
    expect(firstCompiled).not.toBe(secondCompiled);
    expect(getCachedWebTranscriptProjection(messages)).toBe(firstCached);
  });

  it("pins setup, prose, thinking, tool pairing, compact, and error output", () => {
    const messages: Message[] = [
      {
        id: "setup-1",
        role: "user",
        content:
          "# AGENTS.md instructions for /repo\n\n<INSTRUCTIONS>\nfixture\n</INSTRUCTIONS>",
        timestamp: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "setup-2",
        role: "user",
        content:
          "<environment_context>\n  <cwd>/repo</cwd>\n</environment_context>",
        timestamp: "2026-01-01T00:00:00.500Z",
      },
      {
        id: "user-1",
        role: "user",
        content: "Inspect the fixture",
        timestamp: "2026-01-01T00:00:01.000Z",
      },
      {
        id: "assistant-1",
        role: "assistant",
        content: [
          { type: "thinking", thinking: "I should read the file." },
          { type: "text", text: "I’ll inspect it." },
          {
            type: "tool_use",
            id: "read-1",
            name: "Read",
            input: { file_path: "fixture.ts" },
          },
        ],
        timestamp: "2026-01-01T00:00:02.000Z",
      },
      {
        id: "result-1",
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "read-1",
            content: "export const fixture = true;",
          },
        ],
        toolUseResult: { filePath: "fixture.ts", lineCount: 1 },
        timestamp: "2026-01-01T00:00:03.000Z",
      },
      {
        id: "compact-1",
        type: "system",
        subtype: "compact_boundary",
        content: "Context compacted",
        timestamp: "2026-01-01T00:00:04.000Z",
      },
      {
        id: "error-1",
        type: "error",
        error: "Provider unavailable",
        codexWillRetry: true,
        timestamp: "2026-01-01T00:00:05.000Z",
      },
    ];

    expect(
      getCachedWebTranscriptProjection(messages, {
        markdown: {
          "assistant-1": { html: "<p>I’ll inspect it.</p>" },
        },
      }).map(characterize),
    ).toEqual([
      {
        type: "session_setup",
        id: "session-setup-setup-1",
        sourceIds: ["setup-1", "setup-2"],
        title: "Session setup",
        prompts: [
          "# AGENTS.md instructions for /repo\n\n<INSTRUCTIONS>\nfixture\n</INSTRUCTIONS>",
          "<environment_context>\n  <cwd>/repo</cwd>\n</environment_context>",
        ],
      },
      {
        type: "user_prompt",
        id: "user-1",
        sourceIds: ["user-1"],
        content: "Inspect the fixture",
      },
      {
        type: "thinking",
        id: "assistant-1-0",
        sourceIds: ["assistant-1"],
        thinking: "I should read the file.",
        status: "complete",
      },
      {
        type: "text",
        id: "assistant-1-1",
        sourceIds: ["assistant-1"],
        text: "I’ll inspect it.",
        isStreaming: undefined,
        augmentHtml: "<p>I’ll inspect it.</p>",
      },
      {
        type: "tool_call",
        id: "read-1",
        sourceIds: ["assistant-1", "result-1"],
        toolName: "Read",
        toolInput: { file_path: "fixture.ts" },
        toolResult: {
          content: "export const fixture = true;",
          isError: false,
          structured: { filePath: "fixture.ts", lineCount: 1 },
        },
        status: "complete",
      },
      {
        type: "system",
        id: "compact-1",
        sourceIds: ["compact-1"],
        subtype: "compact_boundary",
        content: "Context compacted",
        details: undefined,
      },
      {
        type: "system",
        id: "error-1",
        sourceIds: ["error-1"],
        subtype: "warning",
        content: "Provider unavailable",
        details: undefined,
      },
    ]);
  });

  it("pins detached shell poll folding and source ownership", () => {
    const messages: Message[] = [
      {
        id: "poll-use",
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "poll-1",
            name: "WriteStdin",
            input: {
              session_id: 21394,
              chars: "",
              linked_command: "watch fixture",
            },
          },
        ],
        timestamp: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "poll-result",
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "poll-1",
            content:
              "Script running with cell ID 92\nWall time 10.0 seconds\nOutput:\n",
          },
        ],
        timestamp: "2026-01-01T00:00:01.000Z",
      },
      {
        id: "wait-use",
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "wait-92",
            name: "WriteStdin",
            input: { cell_id: "92" },
          },
        ],
        timestamp: "2026-01-01T00:00:02.000Z",
      },
      {
        id: "wait-result",
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "wait-92",
            content:
              "Script completed\nWall time 27.0 seconds\nOutput:\nfixture ready\n",
          },
        ],
        timestamp: "2026-01-01T00:00:03.000Z",
      },
    ];

    expect(
      getCachedWebTranscriptProjection(messages).map(characterize),
    ).toEqual([
      {
        type: "tool_call",
        id: "poll-1",
        sourceIds: ["poll-use", "poll-result"],
        toolName: "WriteStdin",
        toolInput: {
          session_id: 21394,
          chars: "",
          linked_command: "watch fixture",
        },
        toolResult: {
          content:
            "Script completed\nWall time 27.0 seconds\nOutput:\nfixture ready\n",
          isError: false,
          structured: undefined,
        },
        status: "complete",
      },
    ]);
  });
});
