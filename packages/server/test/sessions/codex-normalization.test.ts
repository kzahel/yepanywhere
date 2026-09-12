import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  getCodexToolCorrelation,
  type CodexSessionEntry,
} from "@yep-anywhere/shared";
import { describe, expect, it, vi } from "vitest";
import { compileTranscriptProjection } from "@yep-anywhere/shared/transcript/compiler";
import { normalizeSession } from "../../src/sessions/normalization.js";
import type { LoadedSession } from "../../src/sessions/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function buildLoadedSession(entries: CodexSessionEntry[]): LoadedSession {
  return {
    summary: {
      id: "test-session",
      projectId: "test-project",
      title: "Test Session",
      fullTitle: "Test Session",
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:02Z",
      messageCount: entries.length,
      status: "chat",
      provider: "codex-oss",
      // biome-ignore lint/suspicious/noExplicitAny: mock summary shape
    } as any,
    data: {
      provider: "codex-oss",
      events: [],
      session: {
        entries,
      },
      // biome-ignore lint/suspicious/noExplicitAny: mock session shape
    } as any,
  };
}

function loadCodexFixtureEntries(name: string): CodexSessionEntry[] {
  const fixturePath = join(
    __dirname,
    "..",
    "fixtures",
    "codex",
    `${name}.jsonl`,
  );
  const content = readFileSync(fixturePath, "utf-8");
  return content
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as CodexSessionEntry);
}

describe("Codex Normalization", () => {
  it("normalizes a codex session as a flat list without parentUuid", () => {
    // 1. Assistant message (response_item)
    // 2. User message (response_item)
    // 3. User provenance witness (event_msg, consumed as a duplicate)
    const entries: CodexSessionEntry[] = [
      {
        type: "response_item",
        timestamp: "2024-01-01T00:00:01Z",
        payload: {
          id: "msg-assistant-1",
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Hi there" }],
        },
      },
      {
        type: "response_item",
        timestamp: "2024-01-01T00:00:02Z",
        payload: {
          id: "msg-user-provider-1",
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "How are you?" }],
        },
      },
      // Codex persists the rich response item first, then the user_message
      // event that witnesses its user-authored provenance.
      {
        type: "event_msg",
        timestamp: "2024-01-01T00:00:02Z",
        payload: {
          type: "user_message",
          message: "How are you?",
          client_id: "ya-user-1",
        },
      },
    ];

    const result = normalizeSession(buildLoadedSession(entries));

    // Expecting 2 messages because the first event_msg is deduped
    expect(result.messages).toHaveLength(2);

    // Check that parentUuid is undefined for all messages
    // Check that parentUuid is undefined for all messages
    for (const msg of result.messages) {
      expect(msg.parentUuid).toBeUndefined();
    }

    // Check content
    // Message 0: Assistant "Hi there"
    const msg0 = result.messages[0];
    expect(msg0?.uuid).toBe("msg-assistant-1");
    const content0 = msg0.message?.content;
    expect(Array.isArray(content0) ? content0[0] : content0).toEqual({
      type: "text",
      text: "Hi there",
    });

    // Message 1: User "How are you?"
    const msg1 = result.messages[1];
    expect(msg1?.uuid).toBe("ya-user-1");
    const content1 = msg1.message?.content;
    expect(Array.isArray(content1) ? content1[0] : content1).toEqual({
      type: "text",
      text: "How are you?",
    });
  });

  it("aligns Codex 0.151 completed user items with optimistic ids", () => {
    const entries: CodexSessionEntry[] = [
      {
        type: "response_item",
        timestamp: "2026-08-30T08:46:03.691Z",
        payload: {
          id: "msg-provider-user-1",
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "peer is clear" }],
        },
      },
      {
        type: "event_msg",
        timestamp: "2026-08-30T08:46:03.729Z",
        payload: {
          type: "item_completed",
          thread_id: "thread-1",
          turn_id: "turn-1",
          item: {
            type: "UserMessage",
            id: "item-user-1",
            client_id: "optimistic-user-1",
            content: [
              { type: "text", text: "peer is clear", text_elements: [] },
            ],
          },
        },
      },
    ];

    const result = normalizeSession(buildLoadedSession(entries));

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toMatchObject({
      uuid: "optimistic-user-1",
      type: "user",
      codexUserTurnProvenance: "paired",
    });
  });

  it("preserves identical provider log rows with distinct ids", () => {
    const repeatedPrompt = "wait 10 minutes";
    const repeatedResponse = "Still waiting.";
    const timestamp = "2026-08-24T12:00:00.000Z";
    const entries: CodexSessionEntry[] = [
      {
        type: "response_item",
        timestamp,
        payload: {
          id: "msg-user-provider-1",
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: repeatedPrompt }],
        },
      },
      {
        type: "event_msg",
        timestamp,
        payload: {
          type: "user_message",
          message: repeatedPrompt,
          client_id: "ya-user-1",
        },
      },
      {
        type: "response_item",
        timestamp,
        payload: {
          id: "msg-user-provider-2",
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: repeatedPrompt }],
        },
      },
      {
        type: "event_msg",
        timestamp,
        payload: {
          type: "user_message",
          message: repeatedPrompt,
          client_id: "ya-user-2",
        },
      },
      {
        type: "response_item",
        timestamp,
        payload: {
          id: "msg-assistant-1",
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: repeatedResponse }],
        },
      },
      {
        type: "response_item",
        timestamp,
        payload: {
          id: "msg-assistant-2",
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: repeatedResponse }],
        },
      },
      {
        type: "response_item",
        timestamp,
        payload: {
          id: "rs-1",
          type: "reasoning",
          summary: [{ type: "summary_text", text: "Checking again" }],
        },
      },
    ];

    const result = normalizeSession(buildLoadedSession(entries));

    expect(result.messages.map((message) => message.uuid)).toEqual([
      "ya-user-1",
      "ya-user-2",
      "msg-assistant-1",
      "msg-assistant-2",
      "rs-1",
    ]);
  });

  it("normalizes function_call_output into user tool_result blocks", () => {
    const entries: CodexSessionEntry[] = [
      {
        type: "response_item",
        timestamp: "2024-01-01T00:00:01Z",
        payload: {
          type: "function_call",
          name: "shell_command",
          call_id: "call-1",
          arguments: '{"command":"npm test"}',
          internal_chat_message_metadata_passthrough: { turn_id: "turn-1" },
        },
      },
      {
        type: "response_item",
        timestamp: "2024-01-01T00:00:02Z",
        payload: {
          type: "function_call_output",
          call_id: "call-1",
          output: "Exit code: 0",
          internal_chat_message_metadata_passthrough: { turn_id: "turn-1" },
        },
      },
    ];

    const result = normalizeSession(buildLoadedSession(entries));
    expect(result.messages).toHaveLength(2);

    const toolUseMessage = result.messages[0];
    const toolResultMessage = result.messages[1];
    const toolUseContent = toolUseMessage?.message?.content;
    const toolResultContent = toolResultMessage?.message?.content;

    expect(
      Array.isArray(toolUseContent) ? toolUseContent[0] : toolUseContent,
    ).toMatchObject({
      type: "tool_use",
      id: "call-1",
      name: "Bash",
    });
    expect(toolResultMessage?.type).toBe("user");
    expect(getCodexToolCorrelation(toolUseMessage)).toEqual({
      origin: "function_call",
      turnId: "turn-1",
      itemId: "call-1",
    });
    expect(getCodexToolCorrelation(toolResultMessage)).toEqual({
      origin: "function_call",
      turnId: "turn-1",
      itemId: "call-1",
    });
    expect(
      Array.isArray(toolResultContent)
        ? toolResultContent[0]
        : toolResultContent,
    ).toMatchObject({
      type: "tool_result",
      tool_use_id: "call-1",
      content: "Exit code: 0",
    });
  });

  it("shows standalone function outputs without inventing a tool exchange", () => {
    const entries: CodexSessionEntry[] = [
      {
        type: "response_item",
        timestamp: "2026-08-26T00:00:01Z",
        payload: {
          type: "function_call_output",
          name: "notifications",
          namespace: "slack",
          output: "new message",
        },
      },
      {
        type: "response_item",
        timestamp: "2026-08-26T00:00:02Z",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "visible reply" }],
        },
      },
    ];

    const result = normalizeSession(buildLoadedSession(entries));

    expect(result.messages).toHaveLength(2);
    expect(result.messages[0]).toMatchObject({
      type: "system",
      subtype: "tool_output",
      content: "new message",
      codexToolName: "notifications",
      codexToolNamespace: "slack",
    });
    expect(result.messages[0]?.message).toBeUndefined();
    const content = result.messages[1]?.message?.content;
    expect(Array.isArray(content) ? content[0] : content).toEqual({
      type: "text",
      text: "visible reply",
    });
  });

  it("keeps standalone async agent questions and skips ordinary duplicates", () => {
    const entries: CodexSessionEntry[] = [
      {
        type: "event_msg",
        timestamp: "2026-09-04T00:00:01Z",
        payload: {
          type: "agent_message",
          message: "ordinary duplicate",
        },
      },
      {
        type: "event_msg",
        timestamp: "2026-09-04T00:00:02Z",
        payload: {
          type: "item_completed",
          item: {
            type: "AgentMessage",
            id: "async-message-1",
            content: [{ type: "Text", text: "Choose a mode\n- Safe\n- Fast" }],
            delivery: "async",
            questions: [
              { title: "Choose a mode", options: ["Safe", "Fast"] },
              { title: "Anything else?", options: null },
            ],
          },
        },
      },
    ];

    const result = normalizeSession(buildLoadedSession(entries));

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toMatchObject({
      uuid: "async-message-1",
      type: "assistant",
      codexAgentMessageDelivery: "async",
      codexAsyncQuestions: [
        { title: "Choose a mode", options: ["Safe", "Fast"] },
        { title: "Anything else?", options: null },
      ],
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Choose a mode\n- Safe\n- Fast" }],
      },
    });
  });

  it("recognizes opaque Codex agent_message response items without rendering", () => {
    const entries: CodexSessionEntry[] = [
      {
        type: "response_item",
        timestamp: "2026-06-09T00:00:00Z",
        payload: {
          type: "agent_message",
          author: "agent",
          recipient: "user",
          content: [
            {
              type: "encrypted_content",
              encrypted_content: "opaque",
            },
          ],
        },
      },
      {
        type: "response_item",
        timestamp: "2026-06-09T00:00:01Z",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "visible" }],
        },
      },
    ];

    const result = normalizeSession(buildLoadedSession(entries));

    expect(result.messages).toHaveLength(1);
    const content = result.messages[0]?.message?.content;
    expect(Array.isArray(content) ? content[0] : content).toEqual({
      type: "text",
      text: "visible",
    });
  });

  it("marks unpaired Codex function calls orphaned at a later turn boundary", () => {
    const entries: CodexSessionEntry[] = [
      {
        type: "response_item",
        timestamp: "2024-01-01T00:00:01Z",
        payload: {
          type: "function_call",
          name: "exec_command",
          call_id: "call-orphaned",
          arguments: '{"cmd":"sleep 15"}',
        },
      },
      {
        type: "event_msg",
        timestamp: "2024-01-01T00:00:02Z",
        payload: {
          type: "user_message",
          message: "next turn",
        },
      },
    ];

    const result = normalizeSession(buildLoadedSession(entries));
    expect(result.messages[0]?.orphanedToolUseIds).toEqual(["call-orphaned"]);

    const renderItems = compileTranscriptProjection(result.messages);
    expect(renderItems[0]).toMatchObject({
      type: "tool_call",
      id: "call-orphaned",
      status: "incomplete",
    });
  });

  it("keeps Codex background process handles open until interrupted", () => {
    const entries: CodexSessionEntry[] = [
      {
        type: "response_item",
        timestamp: "2024-01-01T00:00:01Z",
        payload: {
          type: "function_call",
          name: "exec_command",
          call_id: "call-bg",
          arguments: '{"cmd":"sleep 20","tty":true}',
        },
      },
      {
        type: "response_item",
        timestamp: "2024-01-01T00:00:02Z",
        payload: {
          type: "function_call_output",
          call_id: "call-bg",
          output:
            "Chunk ID: abc\nWall time: 1.0 seconds\nProcess running with session ID 123\nOutput:\n",
        },
      },
      {
        type: "event_msg",
        timestamp: "2024-01-01T00:00:03Z",
        payload: {
          type: "turn_aborted",
          reason: "interrupted",
        },
      },
    ];

    const result = normalizeSession(buildLoadedSession(entries));
    expect(result.messages[0]?.orphanedToolUseIds).toEqual(["call-bg"]);

    const renderItems = compileTranscriptProjection(result.messages);
    expect(renderItems[0]).toMatchObject({
      type: "tool_call",
      id: "call-bg",
      status: "incomplete",
    });
  });

  it("closes persisted Codex background processes on exec_command_end", () => {
    const entries: CodexSessionEntry[] = [
      {
        type: "response_item",
        timestamp: "2024-01-01T00:00:01Z",
        payload: {
          type: "function_call",
          name: "exec_command",
          call_id: "call-bg",
          arguments: '{"cmd":"sleep 1","tty":true}',
        },
      },
      {
        type: "response_item",
        timestamp: "2024-01-01T00:00:02Z",
        payload: {
          type: "function_call_output",
          call_id: "call-bg",
          output:
            "Chunk ID: abc\nWall time: 1.0 seconds\nProcess running with session ID 123\nOutput:\n",
        },
      },
      {
        type: "event_msg",
        timestamp: "2024-01-01T00:00:03Z",
        payload: {
          type: "exec_command_end",
          call_id: "call-bg",
          process_id: "123",
          aggregated_output: "done\n",
          exit_code: 0,
          status: "completed",
        },
      } as CodexSessionEntry,
    ];

    const result = normalizeSession(buildLoadedSession(entries));
    expect(result.messages[0]?.orphanedToolUseIds).toBeUndefined();

    const renderItems = compileTranscriptProjection(result.messages);
    expect(renderItems[0]).toMatchObject({
      type: "tool_call",
      id: "call-bg",
      status: "complete",
      toolResult: expect.objectContaining({
        content: "done\n",
        structured: expect.objectContaining({ exitCode: 0 }),
      }),
    });
  });

  it("ignores duplicate Codex command output after exec_command_end", () => {
    const entries: CodexSessionEntry[] = [
      {
        type: "response_item",
        timestamp: "2024-01-01T00:00:01Z",
        payload: {
          type: "function_call",
          name: "exec_command",
          call_id: "call-fast",
          arguments: '{"cmd":"false"}',
        },
      },
      {
        type: "event_msg",
        timestamp: "2024-01-01T00:00:02Z",
        payload: {
          type: "exec_command_end",
          call_id: "call-fast",
          process_id: "123",
          aggregated_output: "",
          exit_code: 1,
          status: "failed",
        },
      } as CodexSessionEntry,
      {
        type: "response_item",
        timestamp: "2024-01-01T00:00:03Z",
        payload: {
          type: "function_call_output",
          call_id: "call-fast",
          output:
            "Chunk ID: abc\nWall time: 0.0 seconds\nProcess exited with code 1\nOutput:\n",
        },
      },
    ];

    const result = normalizeSession(buildLoadedSession(entries));
    expect(result.messages).toHaveLength(2);

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const renderItems = compileTranscriptProjection(result.messages);
      expect(renderItems[0]).toMatchObject({
        type: "tool_call",
        id: "call-fast",
        status: "error",
        toolResult: expect.objectContaining({
          content: "(no output)",
          structured: expect.objectContaining({ exitCode: 1 }),
        }),
      });
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("keeps interrupted Codex commands orphaned until final exec end", () => {
    const entries: CodexSessionEntry[] = [
      {
        type: "response_item",
        timestamp: "2024-01-01T00:00:01Z",
        payload: {
          type: "function_call",
          name: "exec_command",
          call_id: "call-sleep",
          arguments: '{"cmd":"sleep 20"}',
        },
      },
      {
        type: "response_item",
        timestamp: "2024-01-01T00:00:02Z",
        payload: {
          type: "function_call_output",
          call_id: "call-sleep",
          output: "aborted by user after 2.3s",
        },
      },
      {
        type: "response_item",
        timestamp: "2024-01-01T00:00:02.100Z",
        payload: {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_text",
              text: "<turn_aborted>\ninterrupted\n</turn_aborted>",
            },
          ],
        },
      },
      {
        type: "event_msg",
        timestamp: "2024-01-01T00:00:03Z",
        payload: {
          type: "turn_aborted",
          reason: "interrupted",
        },
      },
      {
        type: "event_msg",
        timestamp: "2024-01-01T00:00:20Z",
        payload: {
          type: "exec_command_end",
          call_id: "call-sleep",
          process_id: "123",
          aggregated_output: "",
          exit_code: 0,
          status: "completed",
        },
      } as CodexSessionEntry,
    ];

    const result = normalizeSession(buildLoadedSession(entries));
    expect(
      result.messages.some((message) =>
        JSON.stringify(message.message?.content ?? "").includes(
          "<turn_aborted>",
        ),
      ),
    ).toBe(false);
    expect(result.messages[0]?.orphanedToolUseIds).toEqual(["call-sleep"]);

    const renderItems = compileTranscriptProjection(result.messages);
    expect(renderItems[0]).toMatchObject({
      type: "tool_call",
      id: "call-sleep",
      status: "aborted",
      toolResult: expect.objectContaining({ content: "(no output)" }),
    });
  });

  it("keeps trailing unpaired Codex function calls pending", () => {
    const entries: CodexSessionEntry[] = [
      {
        type: "response_item",
        timestamp: "2024-01-01T00:00:01Z",
        payload: {
          type: "function_call",
          name: "exec_command",
          call_id: "call-pending",
          arguments: '{"cmd":"sleep 15"}',
        },
      },
    ];

    const result = normalizeSession(buildLoadedSession(entries));
    expect(result.messages[0]?.orphanedToolUseIds).toBeUndefined();

    const renderItems = compileTranscriptProjection(result.messages);
    expect(renderItems[0]).toMatchObject({
      type: "tool_call",
      id: "call-pending",
      status: "pending",
    });
  });

  it("normalizes exec_command input.cmd into Bash input.command", () => {
    const entries: CodexSessionEntry[] = [
      {
        type: "response_item",
        timestamp: "2024-01-01T00:00:01Z",
        payload: {
          type: "custom_tool_call",
          call_id: "call-exec",
          name: "exec_command",
          input: { cmd: "pnpm lint" },
        },
      },
      {
        type: "response_item",
        timestamp: "2024-01-01T00:00:02Z",
        payload: {
          type: "custom_tool_call_output",
          call_id: "call-exec",
          output: "Process exited with code 0",
        },
      },
    ];

    const result = normalizeSession(buildLoadedSession(entries));
    expect(result.messages).toHaveLength(2);

    const toolUseContent = result.messages[0]?.message?.content;
    const block = Array.isArray(toolUseContent)
      ? toolUseContent[0]
      : toolUseContent;

    expect(block).toMatchObject({
      type: "tool_use",
      id: "call-exec",
      name: "Bash",
      input: {
        cmd: "pnpm lint",
        command: "pnpm lint",
      },
    });
  });

  it("extracts exec_command envelope output into structured Bash stdout", () => {
    const entries: CodexSessionEntry[] = [
      {
        type: "response_item",
        timestamp: "2024-01-01T00:00:01Z",
        payload: {
          type: "function_call",
          name: "exec_command",
          call_id: "call-exec-ansi",
          arguments: '{"cmd":"printf demo"}',
        },
      },
      {
        type: "response_item",
        timestamp: "2024-01-01T00:00:02Z",
        payload: {
          type: "function_call_output",
          call_id: "call-exec-ansi",
          output:
            "Chunk ID: ff710e\nWall time: 0.0518 seconds\nProcess exited with code 0\nOutput:\nplain\n\u001b[32mgreen bold\u001b[0m\n",
        },
      },
    ];

    const result = normalizeSession(buildLoadedSession(entries));
    const toolResultMessage = result.messages[1];

    expect(toolResultMessage?.toolUseResult).toMatchObject({
      stdout: "plain\n\u001b[32mgreen bold\u001b[0m\n",
      stderr: "",
      interrupted: false,
      isImage: false,
    });
  });

  it("maps ripgrep exec_command calls to Grep and treats no matches as non-error", () => {
    const entries: CodexSessionEntry[] = [
      {
        type: "response_item",
        timestamp: "2024-01-01T00:00:01Z",
        payload: {
          type: "function_call",
          name: "exec_command",
          call_id: "call-rg",
          arguments:
            '{"cmd":"rg -n \\"preventBackgroundThrottling|background.*throttl\\" packages/server/src -S"}',
        },
      },
      {
        type: "response_item",
        timestamp: "2024-01-01T00:00:02Z",
        payload: {
          type: "function_call_output",
          call_id: "call-rg",
          output:
            "Chunk ID: 9e8716\nWall time: 0.8740 seconds\nProcess exited with code 1\nOriginal token count: 0\nOutput:\n\n",
        },
      },
    ];

    const result = normalizeSession(buildLoadedSession(entries));
    expect(result.messages).toHaveLength(2);

    const toolUseContent = result.messages[0]?.message?.content;
    const useBlock = Array.isArray(toolUseContent)
      ? toolUseContent[0]
      : toolUseContent;
    expect(useBlock).toMatchObject({
      type: "tool_use",
      id: "call-rg",
      name: "Grep",
      input: {
        pattern: "preventBackgroundThrottling|background.*throttl",
        path: "packages/server/src",
      },
    });

    const toolResultContent = result.messages[1]?.message?.content;
    const resultBlock = Array.isArray(toolResultContent)
      ? toolResultContent[0]
      : toolResultContent;
    expect(resultBlock).toMatchObject({
      type: "tool_result",
      tool_use_id: "call-rg",
    });
    expect((resultBlock as { is_error?: boolean }).is_error).toBeUndefined();
    expect(result.messages[1]?.toolUseResult).toMatchObject({
      mode: "files_with_matches",
      numFiles: 0,
      filenames: [],
    });
  });

  it("normalizes ripgrep content matches into structured match rows", () => {
    const entries: CodexSessionEntry[] = [
      {
        type: "response_item",
        timestamp: "2024-01-01T00:00:01Z",
        payload: {
          type: "function_call",
          name: "exec_command",
          call_id: "call-rg-matches",
          arguments: '{"cmd":"rg -n \\"needle\\" src"}',
        },
      },
      {
        type: "response_item",
        timestamp: "2024-01-01T00:00:02Z",
        payload: {
          type: "function_call_output",
          call_id: "call-rg-matches",
          output:
            "Chunk ID: match\nWall time: 0.01 seconds\nProcess exited with code 0\nOutput:\nsrc/a.ts:12:const needle = true;\nsrc/b.ts:7:needle again\n",
        },
      },
    ];

    const result = normalizeSession(buildLoadedSession(entries));

    expect(result.messages[1]?.toolUseResult).toMatchObject({
      mode: "content",
      numFiles: 2,
      filenames: ["src/a.ts", "src/b.ts"],
      matches: [
        {
          filePath: "src/a.ts",
          lineNumber: 12,
          text: "const needle = true;",
          ranges: [{ start: 6, end: 12 }],
        },
        {
          filePath: "src/b.ts",
          lineNumber: 7,
          text: "needle again",
          ranges: [{ start: 0, end: 6 }],
        },
      ],
    });
  });

  it("maps sed range commands to Read with line metadata", () => {
    const entries: CodexSessionEntry[] = [
      {
        type: "response_item",
        timestamp: "2024-01-01T00:00:01Z",
        payload: {
          type: "function_call",
          name: "shell_command",
          call_id: "call-sed",
          arguments:
            '{"command":"sed -n \\"120,122p\\" packages/server/src/auth/routes.ts"}',
        },
      },
      {
        type: "response_item",
        timestamp: "2024-01-01T00:00:02Z",
        payload: {
          type: "function_call_output",
          call_id: "call-sed",
          output:
            "Chunk ID: 111111\nWall time: 0.4000 seconds\nProcess exited with code 0\nOriginal token count: 123\nOutput:\n\nline120\nline121\nline122\n",
        },
      },
    ];

    const result = normalizeSession(buildLoadedSession(entries));
    expect(result.messages).toHaveLength(2);

    const toolUseContent = result.messages[0]?.message?.content;
    const useBlock = Array.isArray(toolUseContent)
      ? toolUseContent[0]
      : toolUseContent;
    expect(useBlock).toMatchObject({
      type: "tool_use",
      id: "call-sed",
      name: "Read",
      input: {
        file_path: "packages/server/src/auth/routes.ts",
        offset: 120,
        limit: 3,
      },
    });

    expect(result.messages[1]?.toolUseResult).toMatchObject({
      type: "text",
      file: {
        filePath: "packages/server/src/auth/routes.ts",
        numLines: 3,
        startLine: 120,
        totalLines: 122,
      },
    });
  });

  it("maps shell-launcher wrapped sed commands to Read", () => {
    const entries: CodexSessionEntry[] = [
      {
        type: "response_item",
        timestamp: "2024-01-01T00:00:01Z",
        payload: {
          type: "function_call",
          name: "shell_command",
          call_id: "call-wrapped-sed",
          arguments: JSON.stringify({
            command:
              "/bin/bash -lc \"sed -n '120,122p' packages/server/src/auth/routes.ts\"",
          }),
        },
      },
      {
        type: "response_item",
        timestamp: "2024-01-01T00:00:02Z",
        payload: {
          type: "function_call_output",
          call_id: "call-wrapped-sed",
          output:
            "Chunk ID: wrapped111\nWall time: 0.4000 seconds\nProcess exited with code 0\nOriginal token count: 123\nOutput:\n\nline120\nline121\nline122\n",
        },
      },
    ];

    const result = normalizeSession(buildLoadedSession(entries));
    expect(result.messages).toHaveLength(2);

    const toolUseContent = result.messages[0]?.message?.content;
    const useBlock = Array.isArray(toolUseContent)
      ? toolUseContent[0]
      : toolUseContent;
    expect(useBlock).toMatchObject({
      type: "tool_use",
      id: "call-wrapped-sed",
      name: "Read",
      input: {
        file_path: "packages/server/src/auth/routes.ts",
        offset: 120,
        limit: 3,
      },
    });
  });

  it("maps nl -ba | sed range commands to Read and strips line numbers", () => {
    const entries: CodexSessionEntry[] = [
      {
        type: "response_item",
        timestamp: "2024-01-01T00:00:01Z",
        payload: {
          type: "function_call",
          name: "shell_command",
          call_id: "call-nl-sed",
          arguments:
            '{"command":"nl -ba packages/server/src/auth/routes.ts | sed -n \\"200,202p\\""}',
        },
      },
      {
        type: "response_item",
        timestamp: "2024-01-01T00:00:02Z",
        payload: {
          type: "function_call_output",
          call_id: "call-nl-sed",
          output:
            "Chunk ID: 222222\nWall time: 0.4100 seconds\nProcess exited with code 0\nOriginal token count: 210\nOutput:\n\n  200\tconst a = 1;\n  201\tconst b = 2;\n  202\treturn a + b;\n",
        },
      },
    ];

    const result = normalizeSession(buildLoadedSession(entries));
    expect(result.messages).toHaveLength(2);

    const toolUseContent = result.messages[0]?.message?.content;
    const useBlock = Array.isArray(toolUseContent)
      ? toolUseContent[0]
      : toolUseContent;
    expect(useBlock).toMatchObject({
      type: "tool_use",
      id: "call-nl-sed",
      name: "Read",
      input: {
        file_path: "packages/server/src/auth/routes.ts",
        offset: 200,
        limit: 3,
      },
    });

    expect(result.messages[1]?.toolUseResult).toMatchObject({
      type: "text",
      file: {
        filePath: "packages/server/src/auth/routes.ts",
        content: "const a = 1;\nconst b = 2;\nreturn a + b;\n",
        numLines: 3,
        startLine: 200,
        totalLines: 202,
      },
    });
  });

  it("maps simple cat commands to Read for richer file rendering", () => {
    const entries: CodexSessionEntry[] = [
      {
        type: "response_item",
        timestamp: "2024-01-01T00:00:01Z",
        payload: {
          type: "function_call",
          name: "shell_command",
          call_id: "call-cat",
          arguments: '{"command":"cat packages/server/package.json"}',
        },
      },
      {
        type: "response_item",
        timestamp: "2024-01-01T00:00:02Z",
        payload: {
          type: "function_call_output",
          call_id: "call-cat",
          output:
            'Chunk ID: 333333\nWall time: 0.5000 seconds\nProcess exited with code 0\nOriginal token count: 300\nOutput:\n\n{"name":"@yep-anywhere/server","private":true}\n',
        },
      },
    ];

    const result = normalizeSession(buildLoadedSession(entries));
    expect(result.messages).toHaveLength(2);

    const toolUseContent = result.messages[0]?.message?.content;
    const useBlock = Array.isArray(toolUseContent)
      ? toolUseContent[0]
      : toolUseContent;
    expect(useBlock).toMatchObject({
      type: "tool_use",
      id: "call-cat",
      name: "Read",
      input: {
        file_path: "packages/server/package.json",
      },
    });

    expect(result.messages[1]?.toolUseResult).toMatchObject({
      type: "text",
      file: {
        filePath: "packages/server/package.json",
        startLine: 1,
      },
    });
  });

  it("maps heredoc cat writes to Write with structured file result", () => {
    const content =
      'import { publish } from "./sw-v2";\n\nexport default publish;\n';
    const entries: CodexSessionEntry[] = [
      {
        type: "response_item",
        timestamp: "2024-01-01T00:00:01Z",
        payload: {
          type: "function_call",
          name: "exec_command",
          call_id: "call-write",
          arguments: JSON.stringify({
            cmd: `cat > website/sw-v2-adapter.ts <<'EOF'\n${content}EOF`,
          }),
        },
      },
      {
        type: "response_item",
        timestamp: "2024-01-01T00:00:02Z",
        payload: {
          type: "function_call_output",
          call_id: "call-write",
          output:
            "Chunk ID: write123\nWall time: 0.0400 seconds\nProcess exited with code 0\nOutput:\n\n",
        },
      },
    ];

    const result = normalizeSession(buildLoadedSession(entries));
    expect(result.messages).toHaveLength(2);

    const toolUseContent = result.messages[0]?.message?.content;
    const useBlock = Array.isArray(toolUseContent)
      ? toolUseContent[0]
      : toolUseContent;
    expect(useBlock).toMatchObject({
      type: "tool_use",
      id: "call-write",
      name: "Write",
      input: {
        file_path: "website/sw-v2-adapter.ts",
        content,
      },
    });

    const toolResultContent = result.messages[1]?.message?.content;
    const resultBlock = Array.isArray(toolResultContent)
      ? toolResultContent[0]
      : toolResultContent;
    expect(resultBlock).toMatchObject({
      type: "tool_result",
      tool_use_id: "call-write",
    });
    expect((resultBlock as { is_error?: boolean }).is_error).toBeUndefined();
    expect(result.messages[1]?.toolUseResult).toMatchObject({
      type: "text",
      file: {
        filePath: "website/sw-v2-adapter.ts",
        content,
        numLines: 3,
        startLine: 1,
        totalLines: 3,
      },
    });
  });

  it('does not mark shell output as error when exit code is 0 and output text contains "failed"', () => {
    const entries: CodexSessionEntry[] = [
      {
        type: "response_item",
        timestamp: "2024-01-01T00:00:01Z",
        payload: {
          type: "function_call",
          name: "shell_command",
          call_id: "call-ok",
          arguments: '{"command":"sed -n \\"1,240p\\" file.ts"}',
        },
      },
      {
        type: "response_item",
        timestamp: "2024-01-01T00:00:02Z",
        payload: {
          type: "function_call_output",
          call_id: "call-ok",
          output:
            'Exit code: 0\nWall time: 1.2 seconds\nOutput:\nconst statuses = ["pending", "running", "completed", "failed"];\n',
        },
      },
    ];

    const result = normalizeSession(buildLoadedSession(entries));
    const toolResultContent = result.messages[1]?.message?.content;
    const block = Array.isArray(toolResultContent)
      ? toolResultContent[0]
      : toolResultContent;

    expect(block).toMatchObject({
      type: "tool_result",
      tool_use_id: "call-ok",
    });
    expect((block as { is_error?: boolean }).is_error).toBeUndefined();
  });

  it("marks shell output as error when exit code is non-zero even without error keywords", () => {
    const entries: CodexSessionEntry[] = [
      {
        type: "response_item",
        timestamp: "2024-01-01T00:00:01Z",
        payload: {
          type: "function_call",
          name: "shell_command",
          call_id: "call-fail",
          arguments: '{"command":"some-command"}',
        },
      },
      {
        type: "response_item",
        timestamp: "2024-01-01T00:00:02Z",
        payload: {
          type: "function_call_output",
          call_id: "call-fail",
          output: "Exit code: 2\nWall time: 0.3 seconds\nOutput:\n",
        },
      },
    ];

    const result = normalizeSession(buildLoadedSession(entries));
    const toolResultContent = result.messages[1]?.message?.content;
    const block = Array.isArray(toolResultContent)
      ? toolResultContent[0]
      : toolResultContent;

    expect(block).toMatchObject({
      type: "tool_result",
      tool_use_id: "call-fail",
      is_error: true,
    });
  });

  it("marks exec output as error when text contains non-zero process exit code", () => {
    const entries: CodexSessionEntry[] = [
      {
        type: "response_item",
        timestamp: "2024-01-01T00:00:01Z",
        payload: {
          type: "function_call",
          name: "exec_command",
          call_id: "call-exec-fail",
          arguments: '{"cmd":"pnpm -r exec tsc --noEmit"}',
        },
      },
      {
        type: "response_item",
        timestamp: "2024-01-01T00:00:02Z",
        payload: {
          type: "function_call_output",
          call_id: "call-exec-fail",
          output:
            "Error: Exit code 2\nWall time: 0.8 seconds\nOutput:\n\nNo explicit error marker text.\n",
        },
      },
    ];

    const result = normalizeSession(buildLoadedSession(entries));

    const toolUseContent = result.messages[0]?.message?.content;
    const useBlock = Array.isArray(toolUseContent)
      ? toolUseContent[0]
      : toolUseContent;
    expect(useBlock).toMatchObject({
      type: "tool_use",
      id: "call-exec-fail",
      name: "Bash",
      input: {
        cmd: "pnpm -r exec tsc --noEmit",
        command: "pnpm -r exec tsc --noEmit",
      },
    });

    const toolResultContent = result.messages[1]?.message?.content;
    const resultBlock = Array.isArray(toolResultContent)
      ? toolResultContent[0]
      : toolResultContent;
    expect(resultBlock).toMatchObject({
      type: "tool_result",
      tool_use_id: "call-exec-fail",
      is_error: true,
    });
    expect(result.messages[1]?.toolUseResult).toMatchObject({
      stdout: "No explicit error marker text.\n",
      stderr: "",
      exitCode: 2,
      durationSeconds: 0.8,
    });
  });

  it("normalizes custom_tool_call and maps apply_patch to Edit", () => {
    const entries: CodexSessionEntry[] = [
      {
        type: "response_item",
        timestamp: "2024-01-01T00:00:01Z",
        payload: {
          type: "custom_tool_call",
          call_id: "call-2",
          name: "apply_patch",
          input: { patch: "*** Begin Patch" },
        },
      },
      {
        type: "response_item",
        timestamp: "2024-01-01T00:00:02Z",
        payload: {
          type: "custom_tool_call_output",
          call_id: "call-2",
          output: '{"ok":true}',
        },
      },
    ];

    const result = normalizeSession(buildLoadedSession(entries));
    expect(result.messages).toHaveLength(2);

    const toolUseMessage = result.messages[0];
    const toolResultMessage = result.messages[1];
    const toolUseContent = toolUseMessage?.message?.content;

    expect(
      Array.isArray(toolUseContent) ? toolUseContent[0] : toolUseContent,
    ).toMatchObject({
      type: "tool_use",
      id: "call-2",
      name: "Edit",
    });
    expect(toolResultMessage?.toolUseResult).toMatchObject({ ok: true });
  });

  it("normalizes code-mode exec with JS-literal (unquoted-key) arguments to Bash", () => {
    const entries: CodexSessionEntry[] = [
      {
        type: "response_item",
        timestamp: "2024-01-01T00:00:01Z",
        payload: {
          type: "custom_tool_call",
          call_id: "call-js-literal",
          name: "exec",
          input:
            'const r = await tools.exec_command({cmd:"pwd && ls",workdir:"/repo",yield_time_ms:10000,max_output_tokens:30000}); text(r.output);',
        },
      },
      {
        type: "response_item",
        timestamp: "2024-01-01T00:00:02Z",
        payload: {
          type: "custom_tool_call_output",
          call_id: "call-js-literal",
          output: [
            {
              type: "input_text",
              text: "Script completed\nWall time 0.1 seconds\nOutput:\n",
            },
            { type: "input_text", text: "/repo\nREADME.md\n" },
          ],
        },
      },
    ];

    const result = normalizeSession(buildLoadedSession(entries));
    expect(result.messages).toHaveLength(2);

    const toolUseContent = result.messages[0]?.message?.content;
    const toolUseBlock = Array.isArray(toolUseContent)
      ? toolUseContent[0]
      : toolUseContent;
    expect(toolUseBlock).toMatchObject({
      type: "tool_use",
      id: "call-js-literal",
      name: "Bash",
      input: { command: "pwd && ls", workdir: "/repo" },
    });

    expect(result.messages[1]?.toolUseResult).toMatchObject({
      stdout: "/repo\nREADME.md\n",
      stderr: "",
      // Runtime recovered from the shell envelope (§ Command execution
      // metadata in topics/provider-output-contract.md).
      durationSeconds: 0.1,
    });
  });

  it("normalizes wait calls to WriteStdin and unwraps unified-exec chunk output", () => {
    const chunk = {
      chunk_id: "5cc06a",
      wall_time_seconds: 22.4,
      exit_code: 0,
      original_token_count: 5047,
      output: "started job serial=1 pid=1981745\nlog: /repo/run.log\n",
    };
    const entries: CodexSessionEntry[] = [
      {
        type: "response_item",
        timestamp: "2024-01-01T00:00:01Z",
        payload: {
          type: "function_call",
          call_id: "call-wait",
          name: "wait",
          arguments:
            '{"cell_id":"39","yield_time_ms":10000,"max_tokens":12000}',
        },
      },
      {
        type: "response_item",
        timestamp: "2024-01-01T00:00:02Z",
        payload: {
          type: "function_call_output",
          call_id: "call-wait",
          output: [
            {
              type: "input_text",
              text: "Script completed\nWall time 8.2 seconds\nOutput:\n",
            },
            { type: "input_text", text: JSON.stringify(chunk) },
          ],
        },
      },
    ];

    const result = normalizeSession(buildLoadedSession(entries));
    expect(result.messages).toHaveLength(2);

    const toolUseContent = result.messages[0]?.message?.content;
    const toolUseBlock = Array.isArray(toolUseContent)
      ? toolUseContent[0]
      : toolUseContent;
    expect(toolUseBlock).toMatchObject({
      type: "tool_use",
      id: "call-wait",
      name: "WriteStdin",
      input: { cell_id: "39" },
    });

    const resultContent = result.messages[1]?.message?.content;
    const resultBlock = Array.isArray(resultContent)
      ? resultContent[0]
      : resultContent;
    expect(resultBlock).toMatchObject({
      type: "tool_result",
      tool_use_id: "call-wait",
      content: chunk.output,
    });
    expect(result.messages[1]?.toolUseResult).toMatchObject({
      chunk_id: "5cc06a",
      exit_code: 0,
      // Normalized command metadata and stdout alias ride alongside the
      // raw chunk fields (§ Command execution metadata).
      stdout: chunk.output,
      exitCode: 0,
      durationSeconds: 22.4,
    });
  });

  it("marks a failed unified-exec chunk as an error", () => {
    const entries: CodexSessionEntry[] = [
      {
        type: "response_item",
        timestamp: "2024-01-01T00:00:01Z",
        payload: {
          type: "function_call",
          call_id: "call-wait-fail",
          name: "wait",
          arguments: '{"cell_id":"7"}',
        },
      },
      {
        type: "response_item",
        timestamp: "2024-01-01T00:00:02Z",
        payload: {
          type: "function_call_output",
          call_id: "call-wait-fail",
          output: [
            {
              type: "input_text",
              text: "Script completed\nWall time 1.0 seconds\nOutput:\n",
            },
            {
              type: "input_text",
              text: '{"chunk_id":"aa","exit_code":2,"output":"boom\\n"}',
            },
          ],
        },
      },
    ];

    const result = normalizeSession(buildLoadedSession(entries));
    const resultContent = result.messages[1]?.message?.content;
    const resultBlock = Array.isArray(resultContent)
      ? resultContent[0]
      : resultContent;
    expect(resultBlock).toMatchObject({
      type: "tool_result",
      tool_use_id: "call-wait-fail",
      content: "boom\n",
      is_error: true,
    });
  });

  it("normalizes new tooling fixture (update_plan + write_stdin) with readable output text", () => {
    const entries = loadCodexFixtureEntries("new-tooling-format");

    const result = normalizeSession(buildLoadedSession(entries));
    expect(result.messages).toHaveLength(4);

    const updatePlanUse = result.messages[0]?.message?.content;
    const updatePlanUseBlock = Array.isArray(updatePlanUse)
      ? updatePlanUse[0]
      : updatePlanUse;
    expect(updatePlanUseBlock).toMatchObject({
      type: "tool_use",
      id: "plan-1",
      name: "UpdatePlan",
    });

    const updatePlanResult = result.messages[1]?.message?.content;
    const updatePlanResultBlock = Array.isArray(updatePlanResult)
      ? updatePlanResult[0]
      : updatePlanResult;
    expect(updatePlanResultBlock).toMatchObject({
      type: "tool_result",
      tool_use_id: "plan-1",
      content: "Plan updated",
    });

    const stdinUse = result.messages[2]?.message?.content;
    const stdinUseBlock = Array.isArray(stdinUse) ? stdinUse[0] : stdinUse;
    expect(stdinUseBlock).toMatchObject({
      type: "tool_use",
      id: "stdin-1",
      name: "WriteStdin",
    });

    const stdinResult = result.messages[3]?.message?.content;
    const stdinResultBlock = Array.isArray(stdinResult)
      ? stdinResult[0]
      : stdinResult;
    expect(stdinResultBlock).toMatchObject({
      type: "tool_result",
      tool_use_id: "stdin-1",
      content:
        "Chunk ID: ff710e\nWall time: 0.0518 seconds\nProcess exited with code 0\nOriginal token count: 184\nOutput:\n\nready\n",
    });
    expect(
      (stdinResultBlock as { is_error?: boolean }).is_error,
    ).toBeUndefined();
  });

  it("links write_stdin rows back to the exact exec_command from persisted Codex fixture", () => {
    const entries = loadCodexFixtureEntries("write-stdin-linked-command");

    const normalized = normalizeSession(buildLoadedSession(entries));
    const renderItems = compileTranscriptProjection(normalized.messages);

    const writeStdinItem = renderItems.find(
      (item) =>
        item.type === "tool_call" &&
        item.id === "call_soO8V845UAwDhcG4REHKJ0XF",
    );

    expect(writeStdinItem?.type).toBe("tool_call");
    if (writeStdinItem?.type !== "tool_call") {
      throw new Error("Expected write_stdin render item");
    }

    expect(writeStdinItem.toolInput).toMatchObject({
      session_id: 37863,
      linked_file_path: "packages/client/src/hooks/useGlobalSessions.ts",
      linked_tool_name: "Read",
    });
    expect(writeStdinItem.toolResult?.content).toContain(
      'import { useCallback, useEffect, useRef, useState } from "react";',
    );
  });

  it("preserves Codex input_image blocks without dumping data URLs into text", () => {
    const entries: CodexSessionEntry[] = [
      {
        type: "response_item",
        timestamp: "2024-01-01T00:00:01Z",
        payload: {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_text",
              text: "Please review this.\n<image>\nThanks.",
            },
            {
              type: "input_image",
              image_url: "data:image/png;base64,AAAA",
            },
          ],
        },
      },
      {
        type: "event_msg",
        timestamp: "2024-01-01T00:00:01Z",
        payload: {
          type: "user_message",
          message: "Please review this.\n<image>\nThanks.",
        },
      },
    ];

    const result = normalizeSession(buildLoadedSession(entries));
    expect(result.messages).toHaveLength(1);

    const content = result.messages[0]?.message?.content;
    expect(Array.isArray(content)).toBe(true);

    const blocks = Array.isArray(content) ? content : [];
    const text = blocks
      .filter((block) => block.type === "text")
      .map((block) => block.text ?? "")
      .join("\n");
    const inputImageBlock = blocks.find(
      (block) => block.type === "input_image",
    );

    expect(text).toContain("<image>");
    expect(text).not.toContain("data:image/png;base64");
    expect(inputImageBlock).toMatchObject({
      type: "input_image",
      mime_type: "image/png",
    });
    expect(
      (inputImageBlock as { image_url?: string } | undefined)?.image_url,
    ).toBeUndefined();
  });

  it("does not add encrypted reasoning placeholder when summary is present", () => {
    const entries: CodexSessionEntry[] = [
      {
        type: "response_item",
        timestamp: "2024-01-01T00:00:01Z",
        payload: {
          type: "reasoning",
          summary: [{ type: "summary_text", text: "Clarifying next step" }],
          encrypted_content: "encrypted-payload",
        },
      },
    ];

    const result = normalizeSession(buildLoadedSession(entries));
    expect(result.messages).toHaveLength(1);

    const content = result.messages[0]?.message?.content;
    const blocks = Array.isArray(content) ? content : [];

    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      type: "thinking",
      thinking: "Clarifying next step",
    });
  });

  it("skips encrypted reasoning blocks when no summary is present", () => {
    const entries: CodexSessionEntry[] = [
      {
        type: "response_item",
        timestamp: "2024-01-01T00:00:01Z",
        payload: {
          type: "reasoning",
          encrypted_content: "encrypted-payload",
        },
      },
    ];

    const result = normalizeSession(buildLoadedSession(entries));
    expect(result.messages).toHaveLength(0);
  });

  it("skips developer messages from the normalized transcript", () => {
    const entries: CodexSessionEntry[] = [
      {
        type: "response_item",
        timestamp: "2024-01-01T00:00:01Z",
        payload: {
          type: "message",
          role: "developer",
          content: [{ type: "input_text", text: "internal prompt" }],
        },
      },
      {
        type: "response_item",
        timestamp: "2024-01-01T00:00:02Z",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Visible output" }],
        },
      },
    ];

    const result = normalizeSession(buildLoadedSession(entries));
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.message?.role).toBe("assistant");
  });

  it("skips injected Codex startup instruction messages", () => {
    const entries: CodexSessionEntry[] = [
      {
        type: "response_item",
        timestamp: "2024-01-01T00:00:01Z",
        payload: {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_text",
              text: [
                "# AGENTS.md instructions for /tmp/yep-anywhere-no-project",
                "",
                "<INSTRUCTIONS>",
                "# Banner",
                "",
                'Immediately say "Global AGENTS understood" after reading all of this.',
                "</INSTRUCTIONS>",
              ].join("\n"),
            },
          ],
        },
      },
      {
        type: "response_item",
        timestamp: "2024-01-01T00:00:02Z",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "sleep 30" }],
        },
      },
    ];

    const result = normalizeSession(buildLoadedSession(entries));
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.message?.role).toBe("user");
    expect(result.messages[0]?.codexUserTurnProvenance).toBe("legacy-response");
    const content = result.messages[0]?.message?.content;
    expect(Array.isArray(content) ? content[0] : content).toMatchObject({
      type: "text",
      text: "sleep 30",
    });
  });

  it("skips Codex startup instructions with plugin recommendations", () => {
    const entries: CodexSessionEntry[] = [
      {
        type: "response_item",
        timestamp: "2024-01-01T00:00:01Z",
        payload: {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_text",
              text: [
                "<recommended_plugins>",
                "Here is a list of plugins that are available but not installed.",
                "",
                "- GitHub (github@openai-curated-remote)",
                "</recommended_plugins># AGENTS.md instructions for /repo",
                "",
                "<INSTRUCTIONS>",
                "Follow the project instructions.",
                "</INSTRUCTIONS>",
              ].join("\n"),
            },
          ],
        },
      },
      {
        type: "response_item",
        timestamp: "2024-01-01T00:00:02Z",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "actual user turn" }],
        },
      },
    ];

    const result = normalizeSession(buildLoadedSession(entries));
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.message?.role).toBe("user");
    expect(result.messages[0]?.codexUserTurnProvenance).toBe("legacy-response");
    const content = result.messages[0]?.message?.content;
    expect(Array.isArray(content) ? content[0] : content).toMatchObject({
      type: "text",
      text: "actual user turn",
    });
  });

  it("skips plugin and environment context without AGENTS instructions", () => {
    const actualPrompt = "actual user turn";
    const entries: CodexSessionEntry[] = [
      {
        type: "response_item",
        timestamp: "2026-07-10T17:09:45.684Z",
        payload: {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_text",
              text: "<recommended_plugins>\n- GitHub\n</recommended_plugins>",
            },
            {
              type: "input_text",
              text: "<environment_context>\n<cwd>/repo</cwd>\n</environment_context>",
            },
          ],
        },
      },
      {
        type: "response_item",
        timestamp: "2026-07-10T17:09:45.686Z",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: actualPrompt }],
        },
      },
      {
        type: "event_msg",
        timestamp: "2026-07-10T17:09:45.686Z",
        payload: { type: "user_message", message: actualPrompt },
      },
    ];

    const result = normalizeSession(buildLoadedSession(entries));
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.codexUserTurnProvenance).toBe("paired");
    expect(result.messages[0]?.message?.content).toEqual([
      { type: "text", text: actualPrompt },
    ]);
  });

  it("preserves a paired user prompt that looks like environment context", () => {
    const actualPrompt =
      "<environment_context>\nI typed this myself\n</environment_context>";
    const entries: CodexSessionEntry[] = [
      {
        type: "response_item",
        timestamp: "2026-07-10T17:09:45.686Z",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: actualPrompt }],
        },
      },
      {
        type: "event_msg",
        timestamp: "2026-07-10T17:09:45.686Z",
        payload: { type: "user_message", message: actualPrompt },
      },
    ];

    const result = normalizeSession(buildLoadedSession(entries));
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.codexUserTurnProvenance).toBe("paired");
    expect(result.messages[0]?.message?.content).toEqual([
      { type: "text", text: actualPrompt },
    ]);
  });

  it("emits turn_aborted as a visible system entry", () => {
    const entries: CodexSessionEntry[] = [
      {
        type: "event_msg",
        timestamp: "2024-01-01T00:00:02Z",
        payload: {
          type: "turn_aborted",
          reason: "approval denied",
        },
      },
    ];

    const result = normalizeSession(buildLoadedSession(entries));
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toMatchObject({
      type: "system",
      subtype: "turn_aborted",
      content: "approval denied",
    });
  });

  it("emits task_complete as a durable turn completion boundary", () => {
    const entries: CodexSessionEntry[] = [
      {
        type: "response_item",
        timestamp: "2024-01-01T00:00:01Z",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Done" }],
        },
      },
      {
        type: "event_msg",
        timestamp: "2024-01-01T00:00:02Z",
        payload: {
          type: "task_complete",
          turn_id: "turn-1",
          last_agent_message: "Done",
        },
      },
      {
        type: "response_item",
        timestamp: "2024-01-01T00:00:03Z",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Later" }],
        },
      },
    ];

    const result = normalizeSession(buildLoadedSession(entries));
    expect(result.messages).toHaveLength(3);
    expect(result.messages[1]).toMatchObject({
      type: "system",
      subtype: "turn_complete",
      session_id: "test-session",
      codexTurnId: "turn-1",
    });
    expect(result.messages[2]?.uuid).toBe("codex-1-2024-01-01T00:00:03Z");
  });

  it("emits persisted subagent activity as a visible system entry", () => {
    const entries: CodexSessionEntry[] = [
      {
        type: "event_msg",
        timestamp: "2026-07-27T00:00:00Z",
        payload: {
          type: "sub_agent_activity",
          event_id: "activity-1",
          occurred_at_ms: 1_785_000_000_000,
          agent_thread_id: "thread-subagent-1",
          agent_path: "Explore",
          kind: "started",
        },
      },
    ];

    const result = normalizeSession(buildLoadedSession(entries));
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toMatchObject({
      type: "system",
      subtype: "subagent_activity",
      content: "Subagent started: Explore",
      codexSubagentKind: "started",
      codexSubagentThreadId: "thread-subagent-1",
      codexSubagentPath: "Explore",
    });
  });

  it("emits compacted entries as compact boundary system messages", () => {
    const entries: CodexSessionEntry[] = [
      {
        type: "compacted",
        timestamp: "2024-01-01T00:00:03Z",
        payload: {
          message: "Compacted 12 messages",
        },
      },
    ];

    const result = normalizeSession(buildLoadedSession(entries));
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toMatchObject({
      type: "system",
      subtype: "compact_boundary",
      content: "Context compacted",
      compactSummaryText: "Compacted 12 messages",
    });
  });

  it("attaches a preserved-history preview when Codex compact message is empty", () => {
    const entries: CodexSessionEntry[] = [
      {
        type: "compacted",
        timestamp: "2024-01-01T00:00:03Z",
        payload: {
          message: "",
          replacement_history: [
            {
              type: "message",
              role: "user",
              content: [{ type: "input_text", text: "/goal ship it" }],
            },
            {
              type: "message",
              role: "user",
              content: [{ type: "input_text", text: "continue" }],
            },
          ],
        },
      },
    ];

    const result = normalizeSession(buildLoadedSession(entries));
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toMatchObject({
      type: "system",
      subtype: "compact_boundary",
      content: "Context compacted",
    });
    expect(String(result.messages[0]?.compactSummaryText)).toContain(
      "/goal ship it",
    );
    expect(String(result.messages[0]?.compactSummaryText)).toContain(
      "Preserved after compact",
    );
  });

  it("dedupes paired Codex compacted events while preserving later ids", () => {
    const entries: CodexSessionEntry[] = [
      {
        type: "compacted",
        timestamp: "2024-01-01T00:00:03.000Z",
        payload: {
          message: "",
        },
      },
      {
        type: "event_msg",
        timestamp: "2024-01-01T00:00:03.100Z",
        payload: {
          type: "context_compacted",
        },
      },
      {
        type: "response_item",
        timestamp: "2024-01-01T00:00:04.000Z",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "After compact" }],
        },
      },
    ];

    const result = normalizeSession(buildLoadedSession(entries));
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0]).toMatchObject({
      type: "system",
      subtype: "compact_boundary",
    });
    expect(result.messages[1]).toMatchObject({
      uuid: "codex-2-2024-01-01T00:00:04.000Z",
      type: "assistant",
    });
  });

  it("keeps standalone Codex context_compacted events", () => {
    const entries: CodexSessionEntry[] = [
      {
        type: "event_msg",
        timestamp: "2024-01-01T00:00:03.000Z",
        payload: {
          type: "context_compacted",
        },
      },
    ];

    const result = normalizeSession(buildLoadedSession(entries));
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toMatchObject({
      type: "system",
      subtype: "compact_boundary",
      content: "Context compacted",
    });
  });
});
