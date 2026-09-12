import { describe, expect, it, vi } from "vitest";
import type { Message } from "../../types";
import { compileTranscriptProjection } from "@yep-anywhere/shared/transcript/compiler";
import { stripAwaySummaryHintSuffix } from "@yep-anywhere/shared/transcript/messageProjection";

describe("compileTranscriptProjection", () => {
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
            _projectPathLinks: [{ filePath: "test.ts", text: "test.ts" }],
          },
        ],
        timestamp: "2024-01-01T00:00:01Z",
      },
    ];

    const items = compileTranscriptProjection(messages);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      type: "tool_call",
      id: "tool-1",
      toolName: "Read",
      status: "complete",
      toolResult: {
        content: "file contents",
        isError: false,
        projectPathLinks: [{ filePath: "test.ts", text: "test.ts" }],
      },
    });
  });

  it("projects stored tool-result media onto the paired tool call", () => {
    const messages: Message[] = [
      {
        id: "msg-media-use",
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tool-media",
            name: "ViewImage",
            input: { path: "plot.png" },
          },
        ],
      },
      {
        id: "msg-media-result",
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tool-media",
            content: "Viewed image",
          },
        ],
        toolResultMedia: [
          {
            state: "stored",
            toolCallId: "tool-media",
            id: "media-handle",
            mimeType: "image/png",
            byteLength: 42,
            width: 10,
            height: 20,
            filename: "plot.png",
          },
          {
            state: "stored",
            toolCallId: "another-tool",
            id: "another-media-handle",
            mimeType: "image/png",
            byteLength: 12,
          },
        ],
      },
    ];

    expect(compileTranscriptProjection(messages)[0]).toMatchObject({
      type: "tool_call",
      toolResult: {
        media: [
          {
            state: "stored",
            toolCallId: "tool-media",
            id: "media-handle",
          },
        ],
      },
    });
  });

  it("preserves Agent tool summaries for rendering completed tasks", () => {
    const messages: Message[] = [
      {
        id: "msg-1",
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tool-1",
            name: "Agent",
            input: {
              description: "Explore codebase for refactoring",
              prompt: "Find cleanup opportunities",
              subagent_type: "Explore",
            },
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
            content: [
              {
                type: "text",
                text: "## Comprehensive Cleanup and Refactoring Opportunities Report",
              },
              {
                type: "text",
                text: "agentId: summary123\n<usage>total_tokens: 200\ntool_uses: 3\nduration_ms: 1000</usage>",
              },
            ],
          },
        ],
        timestamp: "2024-01-01T00:00:01Z",
      },
    ];

    const items = compileTranscriptProjection(messages);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      type: "tool_call",
      id: "tool-1",
      toolName: "Agent",
      status: "complete",
      toolResult: {
        isError: false,
        structured: {
          agentId: "summary123",
          status: "completed",
          content: [
            {
              type: "text",
              text: "## Comprehensive Cleanup and Refactoring Opportunities Report",
            },
          ],
          totalTokens: 200,
          totalToolUseCount: 3,
          totalDurationMs: 1000,
        },
      },
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

    const items = compileTranscriptProjection(messages);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      type: "tool_call",
      status: "pending",
      toolResult: undefined,
    });
  });

  it("deduplicates repeated tool_use blocks with the same id", () => {
    const messages: Message[] = [
      {
        id: "msg-1",
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "call_1",
            name: "Edit",
            input: { file_path: "a.ts" },
          },
        ],
        timestamp: "2024-01-01T00:00:00Z",
      },
      {
        id: "msg-2",
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "call_1",
            name: "Edit",
            input: { file_path: "a.ts" },
          },
        ],
        timestamp: "2024-01-01T00:00:01Z",
      },
    ];

    const items = compileTranscriptProjection(messages);
    const toolCalls = items.filter((item) => item.type === "tool_call");

    expect(toolCalls).toHaveLength(1);
    const call = toolCalls[0];
    if (call?.type === "tool_call") {
      expect(call.id).toBe("call_1");
      expect(call.status).toBe("pending");
    }
  });

  it("updates a deduplicated pending tool_use snapshot", () => {
    const messages: Message[] = [
      {
        id: "msg-1",
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "call_1",
            name: "Bash",
            input: { command: "npm test" },
          },
        ],
        timestamp: "2024-01-01T00:00:00Z",
      },
      {
        id: "msg-2",
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "call_1",
            name: "Bash",
            input: {
              command: "npm test",
              _previewResult: {
                stdout: "partial\n",
                stderr: "",
                interrupted: false,
                isImage: false,
              },
            },
          },
        ],
        timestamp: "2024-01-01T00:00:01Z",
      },
    ];

    const items = compileTranscriptProjection(messages);
    const call = items.find((item) => item.type === "tool_call");

    expect(call).toMatchObject({
      type: "tool_call",
      id: "call_1",
      status: "pending",
      toolInput: {
        command: "npm test",
        _previewResult: {
          stdout: "partial\n",
          stderr: "",
          interrupted: false,
          isImage: false,
        },
      },
    });
  });

  it("attaches tool_result to deduplicated tool_use", () => {
    const messages: Message[] = [
      {
        id: "msg-1",
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "call_1",
            name: "Edit",
            input: { file_path: "a.ts" },
          },
        ],
        timestamp: "2024-01-01T00:00:00Z",
      },
      {
        id: "msg-2",
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "call_1",
            name: "Edit",
            input: { file_path: "a.ts" },
          },
        ],
        timestamp: "2024-01-01T00:00:01Z",
      },
      {
        id: "msg-3",
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "call_1",
            content: "success",
          },
        ],
        timestamp: "2024-01-01T00:00:02Z",
      },
    ];

    const items = compileTranscriptProjection(messages);
    const toolCalls = items.filter((item) => item.type === "tool_call");

    expect(toolCalls).toHaveLength(1);
    const call = toolCalls[0];
    if (call?.type === "tool_call") {
      expect(call.status).toBe("complete");
      expect(call.toolResult?.content).toBe("success");
    }
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

    const items = compileTranscriptProjection(messages);

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

  it("links write_stdin calls to prior bash command using session id", () => {
    const messages: Message[] = [
      {
        id: "msg-bash-use",
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "bash-1",
            name: "Bash",
            input: { command: "pnpm test" },
          },
        ],
        timestamp: "2024-01-01T00:00:00Z",
      },
      {
        id: "msg-bash-result",
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "bash-1",
            content: "Process running with session ID 29243",
          },
        ],
        timestamp: "2024-01-01T00:00:01Z",
      },
      {
        id: "msg-stdin-use",
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "stdin-1",
            name: "WriteStdin",
            input: { session_id: 29243, chars: "" },
          },
        ],
        timestamp: "2024-01-01T00:00:02Z",
      },
    ];

    const items = compileTranscriptProjection(messages);
    const writeStdinCall = items.find(
      (item) => item.type === "tool_call" && item.id === "stdin-1",
    );

    expect(writeStdinCall?.type).toBe("tool_call");
    if (writeStdinCall?.type === "tool_call") {
      expect(writeStdinCall.toolInput).toMatchObject({
        session_id: 29243,
        linked_command: "pnpm test",
      });
    }
  });

  it("links wait calls to the command whose script detached into a cell", () => {
    const messages: Message[] = [
      {
        id: "msg-bash-use",
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "bash-1",
            name: "Bash",
            input: { command: "./run-job.sh" },
          },
        ],
        timestamp: "2024-01-01T00:00:00Z",
      },
      {
        id: "msg-bash-result",
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "bash-1",
            content:
              "Script running with cell ID 39\nWall time 10.0 seconds\nOutput:\n",
          },
        ],
        timestamp: "2024-01-01T00:00:01Z",
      },
      {
        id: "msg-wait-use",
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "wait-1",
            name: "WriteStdin",
            input: { cell_id: "39", yield_time_ms: 10000 },
          },
        ],
        timestamp: "2024-01-01T00:00:02Z",
      },
    ];

    const items = compileTranscriptProjection(messages);
    const waitCall = items.find(
      (item) => item.type === "tool_call" && item.id === "wait-1",
    );

    expect(waitCall?.type).toBe("tool_call");
    if (waitCall?.type === "tool_call") {
      expect(waitCall.toolInput).toMatchObject({
        cell_id: "39",
        linked_command: "./run-job.sh",
        linked_tool_name: "Bash",
      });
    }
  });

  it("carries command linkage through a poll that detaches into a new cell", () => {
    const messages: Message[] = [
      {
        id: "msg-bash-use",
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "bash-1",
            name: "Bash",
            input: { command: "make bench" },
          },
        ],
        timestamp: "2024-01-01T00:00:00Z",
      },
      {
        id: "msg-bash-result",
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "bash-1",
            content: "Process running with session ID 41132",
          },
        ],
        timestamp: "2024-01-01T00:00:01Z",
      },
      {
        id: "msg-poll-use",
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "poll-1",
            name: "WriteStdin",
            input: { session_id: 41132, chars: "" },
          },
        ],
        timestamp: "2024-01-01T00:00:02Z",
      },
      {
        id: "msg-poll-result",
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "poll-1",
            content:
              "Script running with cell ID 52\nWall time 10.0 seconds\nOutput:\n",
          },
        ],
        timestamp: "2024-01-01T00:00:03Z",
      },
      {
        id: "msg-wait-use",
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "wait-1",
            name: "WriteStdin",
            input: { cell_id: "52" },
          },
        ],
        timestamp: "2024-01-01T00:00:04Z",
      },
    ];

    const items = compileTranscriptProjection(messages);

    // The wait on the detached cell folds into the originating poll row,
    // which keeps the linkage the wait inherited.
    expect(
      items.find((item) => item.type === "tool_call" && item.id === "wait-1"),
    ).toBeUndefined();
    const pollCall = items.find(
      (item) => item.type === "tool_call" && item.id === "poll-1",
    );
    expect(pollCall?.type).toBe("tool_call");
    if (pollCall?.type === "tool_call") {
      expect(pollCall.toolInput).toMatchObject({
        session_id: 41132,
        linked_command: "make bench",
      });
    }
  });

  it("bridges a session id revealed in a wait's output to later polls", () => {
    // Mirrors the observed launch chain: a command's script detaches into a
    // cell; the wait on that cell prints SESSION_ID=N for the shell session
    // the script started; later polls of that session (and cells they
    // detach into) inherit the launch command.
    const messages: Message[] = [
      {
        id: "msg-bash-use",
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "bash-1",
            name: "Bash",
            input: { command: "./agentctl start train-job --watch" },
          },
        ],
        timestamp: "2024-01-01T00:00:00Z",
      },
      {
        id: "msg-bash-result",
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "bash-1",
            content:
              "Script running with cell ID 39\nWall time 10.0 seconds\nOutput:\n",
          },
        ],
        timestamp: "2024-01-01T00:00:01Z",
      },
      {
        id: "msg-wait-39-use",
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "wait-39",
            name: "WriteStdin",
            input: { cell_id: "39" },
          },
        ],
        timestamp: "2024-01-01T00:00:02Z",
      },
      {
        id: "msg-wait-39-result",
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "wait-39",
            content:
              "Script completed\nWall time 17.1 seconds\nOutput:\nstarted train-job pid=123\nSESSION_ID=21394\n[I]: step=100 loss=0.1",
          },
        ],
        timestamp: "2024-01-01T00:00:03Z",
      },
      {
        id: "msg-poll-use",
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "poll-1",
            name: "WriteStdin",
            input: { session_id: 21394, chars: "" },
          },
        ],
        timestamp: "2024-01-01T00:00:04Z",
      },
      {
        id: "msg-poll-result",
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "poll-1",
            content:
              "Script running with cell ID 53\nWall time 30.0 seconds\nOutput:\n",
          },
        ],
        timestamp: "2024-01-01T00:00:05Z",
      },
      {
        id: "msg-wait-53-use",
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "wait-53",
            name: "WriteStdin",
            input: { cell_id: "53" },
          },
        ],
        timestamp: "2024-01-01T00:00:06Z",
      },
    ];

    const items = compileTranscriptProjection(messages);
    const byId = (id: string) =>
      items.find((item) => item.type === "tool_call" && item.id === id);

    const poll = byId("poll-1");
    expect(poll?.type).toBe("tool_call");
    if (poll?.type === "tool_call") {
      expect(poll.toolInput).toMatchObject({
        linked_command: "./agentctl start train-job --watch",
      });
    }

    // The wait on the poll's detached cell folds into the poll row.
    expect(byId("wait-53")).toBeUndefined();
  });

  it("folds a detached poll and the wait that collects it into one row", () => {
    const messages: Message[] = [
      {
        id: "msg-poll-use",
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "poll-1",
            name: "WriteStdin",
            input: { session_id: 21394, chars: "", linked_command: "watch x" },
          },
        ],
        timestamp: "2024-01-01T00:00:00Z",
      },
      {
        id: "msg-poll-result",
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "poll-1",
            content:
              "Script running with cell ID 92\nWall time 10.0 seconds\nOutput:\n",
          },
        ],
        timestamp: "2024-01-01T00:00:01Z",
      },
      {
        id: "msg-wait-use",
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "wait-92",
            name: "WriteStdin",
            input: { cell_id: "92" },
          },
        ],
        timestamp: "2024-01-01T00:00:02Z",
      },
      {
        id: "msg-wait-result",
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "wait-92",
            content:
              "Script completed\nWall time 27.0 seconds\nOutput:\n[I]: step=2700\n",
          },
        ],
        timestamp: "2024-01-01T00:00:03Z",
      },
    ];

    const items = compileTranscriptProjection(messages);
    const tools = items.filter((item) => item.type === "tool_call");
    expect(tools).toHaveLength(1);
    const merged = tools[0];
    if (merged?.type === "tool_call") {
      expect(merged.id).toBe("poll-1");
      expect(merged.status).toBe("complete");
      expect(merged.toolInput).toMatchObject({
        session_id: 21394,
        linked_command: "watch x",
      });
      expect(merged.toolResult?.content).toContain("[I]: step=2700");
    }
  });

  it("keeps an unresolved detached poll as its own still-running row", () => {
    const messages: Message[] = [
      {
        id: "msg-poll-use",
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "poll-1",
            name: "WriteStdin",
            input: { session_id: 21394, chars: "", linked_command: "watch x" },
          },
        ],
        timestamp: "2024-01-01T00:00:00Z",
      },
      {
        id: "msg-poll-result",
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "poll-1",
            content:
              "Script running with cell ID 92\nWall time 10.0 seconds\nOutput:\n",
          },
        ],
        timestamp: "2024-01-01T00:00:01Z",
      },
    ];

    const items = compileTranscriptProjection(messages);
    const poll = items.find(
      (item) => item.type === "tool_call" && item.id === "poll-1",
    );
    expect(poll?.type).toBe("tool_call");
    if (poll?.type === "tool_call") {
      expect(poll.status).toBe("complete");
      expect(poll.toolResult?.content).toContain(
        "Script running with cell ID 92",
      );
    }
  });

  it("hides completed context-free shell polls that produced nothing", () => {
    const messages: Message[] = [
      {
        id: "msg-poll-use",
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "poll-empty",
            name: "WriteStdin",
            input: { session_id: 999, chars: "" },
          },
          {
            type: "tool_use",
            id: "poll-output",
            name: "WriteStdin",
            input: { session_id: 998, chars: "" },
          },
          {
            type: "tool_use",
            id: "poll-exit",
            name: "WriteStdin",
            input: { session_id: 997, chars: "" },
          },
          {
            type: "tool_use",
            id: "poll-pending",
            name: "WriteStdin",
            input: { session_id: 996, chars: "" },
          },
        ],
        timestamp: "2024-01-01T00:00:00Z",
      },
      {
        id: "msg-poll-results",
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "poll-empty",
            content: "Wall time 30.0 seconds\nOutput:\n",
          },
          {
            type: "tool_result",
            tool_use_id: "poll-output",
            content: "Wall time 5.0 seconds\nOutput:\nnew log line",
          },
          {
            type: "tool_result",
            tool_use_id: "poll-exit",
            content: "Exit code: 0\nWall time 5.0 seconds\nOutput:\n",
          },
        ],
        timestamp: "2024-01-01T00:00:01Z",
      },
    ];

    const items = compileTranscriptProjection(messages);
    const ids = items
      .filter((item) => item.type === "tool_call")
      .map((item) => (item.type === "tool_call" ? item.id : ""));

    // Info-free: no chars, no linkage, no output, no exit code.
    expect(ids).not.toContain("poll-empty");
    // Output, an exit code, or a still-pending poll all stay visible.
    expect(ids).toContain("poll-output");
    expect(ids).toContain("poll-exit");
    expect(ids).toContain("poll-pending");
  });

  it("links write_stdin calls to prior exec_command using session id", () => {
    const messages: Message[] = [
      {
        id: "msg-exec-use",
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "exec-1",
            name: "exec_command",
            input: {
              cmd: "sed -n '1,140p' packages/client/src/layouts/NavigationLayout.tsx",
            },
          },
        ],
        timestamp: "2024-01-01T00:00:00Z",
      },
      {
        id: "msg-exec-result",
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "exec-1",
            content: "Process running with session ID 70073",
          },
        ],
        timestamp: "2024-01-01T00:00:01Z",
      },
      {
        id: "msg-stdin-use",
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "stdin-1",
            name: "WriteStdin",
            input: { session_id: 70073, chars: "" },
          },
        ],
        timestamp: "2024-01-01T00:00:02Z",
      },
    ];

    const items = compileTranscriptProjection(messages);
    const writeStdinCall = items.find(
      (item) => item.type === "tool_call" && item.id === "stdin-1",
    );

    expect(writeStdinCall?.type).toBe("tool_call");
    if (writeStdinCall?.type === "tool_call") {
      expect(writeStdinCall.toolInput).toMatchObject({
        session_id: 70073,
        linked_command:
          "sed -n '1,140p' packages/client/src/layouts/NavigationLayout.tsx",
      });
    }
  });

  it("links write_stdin calls to prior Read tool using structured session id", () => {
    const messages: Message[] = [
      {
        id: "msg-read-use",
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "read-1",
            name: "Read",
            input: {
              file_path: "packages/client/src/hooks/useGlobalSessions.ts",
              offset: 1,
              limit: 260,
            },
          },
        ],
        timestamp: "2024-01-01T00:00:00Z",
      },
      {
        id: "msg-read-result",
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "read-1",
            content: "",
          },
        ],
        toolUseResult: {
          type: "text",
          file: {
            filePath: "packages/client/src/hooks/useGlobalSessions.ts",
            content:
              'import { useCallback, useEffect, useRef, useState } from "react";\n',
            numLines: 1,
            startLine: 1,
            totalLines: 1,
          },
          session_id: 37863,
        },
        timestamp: "2024-01-01T00:00:01Z",
      },
      {
        id: "msg-stdin-use",
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "stdin-1",
            name: "WriteStdin",
            input: { session_id: 37863, chars: "" },
          },
        ],
        timestamp: "2024-01-01T00:00:02Z",
      },
    ];

    const items = compileTranscriptProjection(messages);
    const writeStdinCall = items.find(
      (item) => item.type === "tool_call" && item.id === "stdin-1",
    );

    expect(writeStdinCall?.type).toBe("tool_call");
    if (writeStdinCall?.type === "tool_call") {
      expect(writeStdinCall.toolInput).toMatchObject({
        session_id: 37863,
        linked_file_path: "packages/client/src/hooks/useGlobalSessions.ts",
        linked_tool_name: "Read",
      });
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

    const items = compileTranscriptProjection(messages);

    expect(items).toHaveLength(2);
    expect(items[0]?.type).toBe("thinking");
    expect(items[1]?.type).toBe("text");
  });

  it("marks the last text of a steering-aborted assistant message", () => {
    const items = compileTranscriptProjection([
      {
        id: "msg-1",
        role: "assistant",
        content: [
          { type: "text", text: "First paragraph." },
          { type: "text", text: "I will add the flag, have it override the" },
        ],
        timestamp: "2024-01-01T00:00:00Z",
        isAbortedMidStream: true,
      },
    ]);

    expect(items).toHaveLength(2);
    expect(items[0]?.type).toBe("text");
    expect(items[0]).not.toHaveProperty("abortedMidStream");
    expect(items[1]).toMatchObject({ type: "text", abortedMidStream: true });
  });

  it("leaves text unmarked when the assistant message completed normally", () => {
    const items = compileTranscriptProjection([
      {
        id: "msg-1",
        role: "assistant",
        content: [{ type: "text", text: "Done." }],
        timestamp: "2024-01-01T00:00:00Z",
      },
    ]);

    expect(items[0]?.type).toBe("text");
    expect(items[0]).not.toHaveProperty("abortedMidStream");
  });

  it("thinking blocks are 'streaming' when message is streaming, 'complete' otherwise", () => {
    const thinkingContent = [
      { type: "thinking" as const, thinking: "Let me think..." },
      { type: "text" as const, text: "My response." },
    ];

    const streamingItems = compileTranscriptProjection([
      {
        id: "msg-1",
        role: "assistant",
        content: thinkingContent,
        timestamp: "2024-01-01T00:00:00Z",
        _isStreaming: true,
      } as Message,
    ]);
    const completeItems = compileTranscriptProjection([
      {
        id: "msg-1",
        role: "assistant",
        content: thinkingContent,
        timestamp: "2024-01-01T00:00:00Z",
      },
    ]);

    const streamingThinking = streamingItems[0];
    const completeThinking = completeItems[0];
    expect(
      streamingThinking?.type === "thinking" && streamingThinking.status,
    ).toBe("streaming");
    expect(
      completeThinking?.type === "thinking" && completeThinking.status,
    ).toBe("complete");
  });

  it("hides internal reasoning placeholders but keeps real text", () => {
    const messages: Message[] = [
      {
        id: "msg-1",
        role: "assistant",
        content: [
          { type: "thinking", thinking: "Reasoning [internal]" },
          { type: "text", text: "Here is my response." },
        ],
        timestamp: "2024-01-01T00:00:00Z",
      },
    ];

    const items = compileTranscriptProjection(messages);

    expect(items).toHaveLength(1);
    expect(items[0]?.type).toBe("text");
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

    const items = compileTranscriptProjection(messages);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      type: "user_prompt",
      id: "msg-1",
      content: "Hello, please help me",
    });
  });

  it("projects confirmed path links onto a user prompt", () => {
    const messages: Message[] = [
      {
        id: "msg-path-prompt",
        type: "user",
        content: "Please inspect topics/project-path-links.md",
        _projectPathLinks: [
          {
            filePath: "topics/project-path-links.md",
            text: "topics/project-path-links.md",
          },
        ],
      },
    ];

    expect(compileTranscriptProjection(messages)).toMatchObject([
      {
        type: "user_prompt",
        projectPathLinks: [
          {
            filePath: "topics/project-path-links.md",
            text: "topics/project-path-links.md",
          },
        ],
      },
    ]);
  });

  it("renders Claude local slash commands as system markers", () => {
    const messages: Message[] = [
      {
        id: "msg-1",
        role: "user",
        content:
          "<local-command-caveat>Caveat: local command.</local-command-caveat>\n" +
          "<command-name>/clear</command-name>\n" +
          "<command-message>clear</command-message>\n" +
          "<command-args></command-args>\n" +
          "<local-command-caveat>Caveat: local command.</local-command-caveat>",
        timestamp: "2024-01-01T00:00:00Z",
      },
    ];

    const items = compileTranscriptProjection(messages);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      type: "system",
      subtype: "local_command",
      content: "/clear",
    });
  });

  it("renders standalone Codex tool output as an unpaired system row", () => {
    const messages: Message[] = [
      {
        uuid: "function-output-1",
        type: "system",
        subtype: "tool_output",
        content: "new message",
        codexToolName: "notifications",
        codexToolNamespace: "slack",
      },
    ];

    expect(compileTranscriptProjection(messages)).toMatchObject([
      {
        type: "system",
        id: "function-output-1",
        subtype: "tool_output",
        content: "slack.notifications",
        details: ["new message"],
      },
    ]);
  });

  it("renders durable Claude local-command stdout system rows", () => {
    const messages: Message[] = [
      {
        uuid: "local-command-error",
        type: "system",
        subtype: "local_command",
        content:
          "<local-command-stdout>Unknown command: /tend</local-command-stdout>",
        timestamp: "2026-07-09T18:11:26.044Z",
      },
    ];

    const items = compileTranscriptProjection(messages);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      type: "system",
      id: "local-command-error",
      subtype: "local_command",
      content: "Unknown command: /tend",
    });
  });

  it("preserves structured local-command details", () => {
    const messages: Message[] = [
      {
        uuid: "codex-status",
        type: "system",
        subtype: "local_command",
        content: "/status",
        details: ["Model: gpt-5.6\nSession: thread-1", "Limits: 24% used"],
        timestamp: "2026-08-10T00:00:00.000Z",
      },
    ];

    const items = compileTranscriptProjection(messages);

    expect(items).toEqual([
      expect.objectContaining({
        type: "system",
        id: "codex-status",
        subtype: "local_command",
        content: "/status",
        details: ["Model: gpt-5.6\nSession: thread-1", "Limits: 24% used"],
      }),
    ]);
  });

  it("suppresses durable Claude compact local-command stdout rows", () => {
    const messages: Message[] = [
      {
        uuid: "local-command-compact",
        type: "system",
        subtype: "local_command",
        content: "<local-command-stdout>Compacted</local-command-stdout>",
        timestamp: "2026-07-09T18:11:26.044Z",
      },
    ];

    const items = compileTranscriptProjection(messages);

    expect(items).toHaveLength(0);
  });

  it("collapses Claude slash-command skill bodies into command details", () => {
    const skillBody = [
      {
        type: "text",
        text:
          "Base directory for this skill: /home/graehl/.claude/skills/harsh-review\n\n" +
          "# Harsh review\n\nFirst classify each changed artifact.\n\n" +
          "ARGUMENTS: last 10 commits",
      },
    ];
    const messages: Message[] = [
      {
        uuid: "command",
        type: "user",
        promptId: "prompt-1",
        message: {
          role: "user",
          content:
            "<command-message>harsh-review</command-message>\n" +
            "<command-name>/harsh-review</command-name>\n" +
            "<command-args>last 10 commits</command-args>",
        },
        timestamp: "2024-01-01T00:00:00Z",
      },
      {
        uuid: "skill-body",
        type: "user",
        isMeta: true,
        parentUuid: "command",
        promptId: "prompt-1",
        message: {
          role: "user",
          content: skillBody,
        },
        timestamp: "2024-01-01T00:00:00Z",
      },
      {
        uuid: "assistant-1",
        type: "assistant",
        message: { role: "assistant", content: "Reviewed." },
        timestamp: "2024-01-01T00:00:01Z",
      },
    ];

    const items = compileTranscriptProjection(messages);

    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      type: "system",
      id: "command",
      subtype: "local_command",
      content: "/harsh-review last 10 commits",
      sourceMessages: [
        expect.objectContaining({ uuid: "command" }),
        expect.objectContaining({ uuid: "skill-body" }),
      ],
      details: [skillBody],
    });
    expect(items[1]).toMatchObject({ type: "text", text: "Reviewed." });
  });

  it("collapses Claude compact summaries into one compact system item", () => {
    const messages: Message[] = [
      {
        id: "caveat",
        type: "user",
        message: {
          role: "user",
          content:
            "<local-command-caveat>Caveat: The messages below were generated by the user while running local commands.</local-command-caveat>",
        },
        isMeta: true,
        timestamp: "2024-01-01T00:00:00Z",
      },
      {
        id: "command",
        type: "user",
        message: {
          role: "user",
          content:
            "<command-name>/compact</command-name>\n" +
            "<command-message>compact</command-message>\n" +
            "<command-args></command-args>",
        },
        timestamp: "2024-01-01T00:00:01Z",
      },
      {
        id: "boundary",
        type: "system",
        subtype: "compact_boundary",
        content: "Conversation compacted",
        compactMetadata: {
          trigger: "manual",
          preTokens: 345417,
          postTokens: 8366,
        },
        timestamp: "2024-01-01T00:00:02Z",
      },
      {
        id: "summary",
        type: "user",
        message: {
          role: "user",
          content:
            "This session is being continued from a previous conversation that ran out of context.\n\nSummary:\n- prior work",
        },
        isCompactSummary: true,
        isVisibleInTranscriptOnly: true,
        timestamp: "2024-01-01T00:00:03Z",
      },
      {
        id: "stdout",
        type: "user",
        message: {
          role: "user",
          content: "<local-command-stdout>Compacted </local-command-stdout>",
        },
        timestamp: "2024-01-01T00:00:04Z",
      },
    ];

    const items = compileTranscriptProjection(messages);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      type: "system",
      id: "boundary",
      subtype: "compact_boundary",
      content: "Conversation compacted",
      sourceMessages: [
        expect.objectContaining({ id: "boundary" }),
        expect.objectContaining({ id: "summary" }),
      ],
    });
    const compact = items[0];
    // Human summary first, provider metadata second.
    expect(compact?.type === "system" ? compact.details : []).toEqual([
      expect.stringContaining("Summary:\n- prior work"),
      expect.stringContaining("compactMetadata"),
    ]);
  });

  it("renders a summary-only Claude compact row as compact details", () => {
    const messages: Message[] = [
      {
        id: "summary",
        type: "user",
        message: {
          role: "user",
          content:
            "This session is being continued from a previous conversation that ran out of context.\n\nSummary:\n- prior work",
        },
        isCompactSummary: true,
        isVisibleInTranscriptOnly: true,
        timestamp: "2024-01-01T00:00:03Z",
      },
    ];

    const items = compileTranscriptProjection(messages);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      type: "system",
      subtype: "compact_boundary",
      content: "Context compacted",
    });
    const compact = items[0];
    expect(compact?.type === "system" ? compact.details : []).toEqual([
      expect.stringContaining("Summary:\n- prior work"),
    ]);
  });

  it("classifies Claude compact preamble without isCompactSummary as system compact", () => {
    // Live SDK stream can omit the durable flag; body opener is stable.
    const messages: Message[] = [
      {
        id: "live-summary",
        type: "user",
        message: {
          role: "user",
          content:
            "This session is being continued from a previous conversation that ran out of context.\n\nSummary:\n- prior work",
        },
        timestamp: "2024-01-01T00:00:03Z",
      },
    ];

    const items = compileTranscriptProjection(messages);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      type: "system",
      subtype: "compact_boundary",
      content: "Context compacted",
    });
    expect(items.some((item) => item.type === "user_prompt")).toBe(false);
  });

  it("surfaces compactSummaryText and metadata as expandable details", () => {
    const messages: Message[] = [
      {
        id: "boundary",
        type: "system",
        subtype: "compact_boundary",
        content: "Context compacted",
        compactSummaryText: "Kept: prior goal and last user turn",
        compactMetadata: { trigger: "manual", preTokens: 1000 },
        timestamp: "2024-01-01T00:00:02Z",
      },
    ];

    const items = compileTranscriptProjection(messages);
    expect(items).toHaveLength(1);
    const compact = items[0];
    expect(compact?.type).toBe("system");
    if (compact?.type !== "system") return;
    expect(compact.details?.[0]).toEqual("Kept: prior goal and last user turn");
    expect(String(compact.details?.[1] ?? "")).toContain("compactMetadata:");
  });

  it("classifies array-content compact summary as system compact", () => {
    const messages: Message[] = [
      {
        id: "array-summary",
        type: "user",
        isCompactSummary: true,
        message: {
          role: "user",
          content: [
            {
              type: "text",
              text: "This session is being continued from a previous conversation that ran out of context.\n\nSummary:\n- blocks",
            },
          ],
        },
        timestamp: "2024-01-01T00:00:03Z",
      },
    ];

    const items = compileTranscriptProjection(messages);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      type: "system",
      subtype: "compact_boundary",
    });
    expect(items.some((item) => item.type === "user_prompt")).toBe(false);
  });

  it("unwraps non-compact local-command stdout as a system marker", () => {
    const messages: Message[] = [
      {
        id: "stdout",
        type: "user",
        message: {
          role: "user",
          content:
            "<local-command-stdout>Set model to Opus</local-command-stdout>",
        },
        timestamp: "2024-01-01T00:00:00Z",
      },
    ];

    const items = compileTranscriptProjection(messages);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      type: "system",
      subtype: "local_command",
      content: "Set model to Opus",
    });
  });

  it("collapses leading session setup prompts into one item", () => {
    const messages: Message[] = [
      {
        id: "msg-setup-1",
        role: "user",
        content:
          "# AGENTS.md instructions for /repo\n\n<INSTRUCTIONS>\nfoo\n</INSTRUCTIONS>",
        timestamp: "2024-01-01T00:00:00Z",
      },
      {
        id: "msg-setup-2",
        role: "user",
        content:
          "<environment_context>\n  <cwd>/repo</cwd>\n</environment_context>",
        timestamp: "2024-01-01T00:00:01Z",
      },
      {
        id: "msg-user-1",
        role: "user",
        content: "Implement the requested change",
        timestamp: "2024-01-01T00:00:02Z",
      },
    ];

    const items = compileTranscriptProjection(messages);

    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      type: "session_setup",
      title: "Session setup",
      prompts: [
        "# AGENTS.md instructions for /repo\n\n<INSTRUCTIONS>\nfoo\n</INSTRUCTIONS>",
        "<environment_context>\n  <cwd>/repo</cwd>\n</environment_context>",
      ],
    });
    expect(items[1]).toMatchObject({
      type: "user_prompt",
      content: "Implement the requested change",
    });
  });

  it("collapses leading setup prompts with plugin recommendations", () => {
    const setupPrompt = [
      "<recommended_plugins>",
      "Here is a list of plugins that are available but not installed.",
      "",
      "- GitHub (github@openai-curated-remote)",
      "</recommended_plugins># AGENTS.md instructions for /repo",
      "",
      "<INSTRUCTIONS>",
      "Follow the project instructions.",
      "</INSTRUCTIONS>",
    ].join("\n");
    const messages: Message[] = [
      {
        id: "msg-setup-1",
        role: "user",
        content: setupPrompt,
        timestamp: "2024-01-01T00:00:00Z",
      },
      {
        id: "msg-user-1",
        role: "user",
        content: "Implement the requested change",
        timestamp: "2024-01-01T00:00:01Z",
      },
    ];

    const items = compileTranscriptProjection(messages);

    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      type: "session_setup",
      title: "Session setup",
      prompts: [setupPrompt],
    });
    expect(items[1]).toMatchObject({
      type: "user_prompt",
      content: "Implement the requested change",
    });
  });

  it("does not collapse a single setup-like prompt in the middle of a session", () => {
    const messages: Message[] = [
      {
        id: "msg-user-1",
        role: "user",
        content: "normal first prompt",
        timestamp: "2024-01-01T00:00:00Z",
      },
      {
        id: "msg-setup-1",
        role: "user",
        content: "# AGENTS.md instructions for /repo",
        timestamp: "2024-01-01T00:00:01Z",
      },
    ];

    const items = compileTranscriptProjection(messages);

    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      type: "user_prompt",
      content: "normal first prompt",
    });
    expect(items[1]).toMatchObject({
      type: "user_prompt",
      content: "# AGENTS.md instructions for /repo",
    });
  });

  it("suppresses a lone resumed Codex environment context before the user turn", () => {
    const messages: Message[] = [
      {
        id: "msg-user-1",
        role: "user",
        content: "normal first prompt",
        timestamp: "2024-01-01T00:00:00.000Z",
      },
      {
        id: "msg-setup-1",
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "text",
              text:
                "<environment_context>\n" +
                "  <current_date>2026-06-30</current_date>\n" +
                "</environment_context>",
            },
          ],
        },
        timestamp: "2024-01-01T00:01:00.000Z",
      },
      {
        id: "msg-user-2",
        type: "user",
        message: {
          role: "user",
          content: [{ type: "text", text: "actual wake message" }],
        },
        timestamp: "2024-01-01T00:01:00.100Z",
      },
    ];

    const items = compileTranscriptProjection(messages);

    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      type: "user_prompt",
      content: "normal first prompt",
    });
    expect(items[1]).toMatchObject({
      type: "user_prompt",
      content: [{ type: "text", text: "actual wake message" }],
    });
  });

  it("preserves a context-shaped prompt with server user-turn provenance", () => {
    const literalPrompt =
      "<environment_context>\nI typed this myself\n</environment_context>";
    const messages: Message[] = [
      {
        id: "msg-user-1",
        type: "user",
        codexUserTurnProvenance: "paired",
        message: { role: "user", content: literalPrompt },
        timestamp: "2024-01-01T00:00:00.000Z",
      },
    ];

    expect(compileTranscriptProjection(messages)).toMatchObject([
      { type: "user_prompt", content: literalPrompt },
    ]);
  });

  it("collapses repeated setup prompts inserted after resume", () => {
    const messages: Message[] = [
      {
        id: "msg-user-1",
        role: "user",
        content: "normal first prompt",
        timestamp: "2024-01-01T00:00:00Z",
      },
      {
        id: "msg-setup-1",
        role: "user",
        content:
          "# AGENTS.md instructions for /repo\n<INSTRUCTIONS>\nRules\n</INSTRUCTIONS>",
        timestamp: "2024-01-01T00:00:01Z",
      },
      {
        id: "msg-setup-2",
        role: "user",
        content:
          "<environment_context>\n  <cwd>/repo</cwd>\n</environment_context>",
        timestamp: "2024-01-01T00:00:02Z",
      },
      {
        id: "msg-user-2",
        role: "user",
        content: "follow-up after resume",
        timestamp: "2024-01-01T00:00:03Z",
      },
    ];

    const items = compileTranscriptProjection(messages);

    expect(items).toHaveLength(3);
    expect(items[0]).toMatchObject({
      type: "user_prompt",
      content: "normal first prompt",
    });
    expect(items[1]).toMatchObject({
      type: "session_setup",
      title: "Session setup",
      prompts: [
        "# AGENTS.md instructions for /repo\n<INSTRUCTIONS>\nRules\n</INSTRUCTIONS>",
        "<environment_context>\n  <cwd>/repo</cwd>\n</environment_context>",
      ],
    });
    expect(items[2]).toMatchObject({
      type: "user_prompt",
      content: "follow-up after resume",
    });
  });

  it("attaches markdown augment to assistant string content", () => {
    const messages: Message[] = [
      {
        id: "msg-1",
        type: "assistant",
        content: "Hello **world**",
        _html: "<p>Hello <strong>world</strong></p>",
        timestamp: "2024-01-01T00:00:00Z",
      },
    ];

    const items = compileTranscriptProjection(messages);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      type: "text",
      id: "msg-1",
      text: "Hello **world**",
      augmentHtml: "<p>Hello <strong>world</strong></p>",
    });
  });

  it("falls back to markdown augment map for assistant string content", () => {
    const messages: Message[] = [
      {
        id: "msg-1",
        type: "assistant",
        content: "Hello **world**",
        timestamp: "2024-01-01T00:00:00Z",
      },
    ];

    const items = compileTranscriptProjection(messages, {
      markdown: {
        "msg-1": { html: "<p>Hello <strong>world</strong></p>" },
      },
    });

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      type: "text",
      id: "msg-1",
      text: "Hello **world**",
      augmentHtml: "<p>Hello <strong>world</strong></p>",
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

    const items = compileTranscriptProjection(messages);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      type: "tool_call",
      status: "error",
      toolResult: { content: "Command failed", isError: true },
    });
  });

  it("normalizes Claude Bash failure envelopes into command metadata", () => {
    const messages: Message[] = [
      {
        id: "msg-use",
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tool-1",
            name: "Bash",
            input: { command: "node scripts/perf-suite/run.mjs" },
          },
        ],
      },
      {
        id: "msg-result",
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tool-1",
            content: "Exit code 1\namended-working-tree/smoke: repetition 1/1",
            is_error: true,
          },
        ],
        toolUseResult:
          "Error: Exit code 1\namended-working-tree/smoke: repetition 1/1",
      },
    ];

    const items = compileTranscriptProjection(messages);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      type: "tool_call",
      status: "error",
      toolResult: {
        content: "Exit code 1\namended-working-tree/smoke: repetition 1/1",
        isError: true,
        structured: {
          stdout: "amended-working-tree/smoke: repetition 1/1",
          stderr: "",
          exitCode: 1,
        },
      },
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

    const items = compileTranscriptProjection(messages);

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

    const items = compileTranscriptProjection(messages);

    expect(items).toHaveLength(1);
    const item = items[0];
    if (item?.type === "tool_call") {
      expect(item.toolResult?.structured).toEqual({
        lineCount: 42,
        filePath: "/test.ts",
      });
    }
  });

  it("renders turn_aborted system messages", () => {
    const messages: Message[] = [
      {
        id: "msg-1",
        type: "system",
        subtype: "turn_aborted",
        content: "approval denied",
        timestamp: "2024-01-01T00:00:00Z",
      },
    ];

    const items = compileTranscriptProjection(messages);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      type: "system",
      subtype: "turn_aborted",
      content: "approval denied",
    });
  });

  it("renders subagent activity system messages", () => {
    const messages: Message[] = [
      {
        id: "subagent-1",
        type: "system",
        subtype: "subagent_activity",
        content: "Subagent started: Explore",
        timestamp: "2024-01-01T00:00:00Z",
      },
    ];

    const items = compileTranscriptProjection(messages);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      type: "system",
      subtype: "subagent_activity",
      content: "Subagent started: Explore",
    });
  });

  it("renders away summaries without the Claude config hint suffix", () => {
    expect(
      stripAwaySummaryHintSuffix(
        "Finished the route and started tests (disable recaps in /config)  \n",
      ),
    ).toBe("Finished the route and started tests");

    const messages: Message[] = [
      {
        id: "msg-recap-1",
        type: "system",
        subtype: "away_summary",
        content: "Ran typecheck (disable recaps in /config)\n",
        timestamp: "2024-01-01T00:00:00Z",
      },
    ];

    const items = compileTranscriptProjection(messages);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      type: "system",
      subtype: "away_summary",
      content: "Ran typecheck",
    });
  });

  it("only highlights config_ack messages for new mismatches", () => {
    const messages: Message[] = [
      {
        id: "cfg-1",
        type: "system",
        subtype: "config_ack",
        content: "Codex acknowledged config: gpt-5.4 · effort high",
        configModel: "gpt-5.4",
        configThinking: "effort high",
        configMismatch: true,
        timestamp: "2024-01-01T00:00:00Z",
      },
      {
        id: "cfg-2",
        type: "system",
        subtype: "config_ack",
        content: "Codex acknowledged config: gpt-5.4 · effort high",
        configModel: "gpt-5.4",
        configThinking: "effort high",
        configMismatch: true,
        timestamp: "2024-01-01T00:00:01Z",
      },
      {
        id: "cfg-3",
        type: "system",
        subtype: "config_ack",
        content: "Codex acknowledged config: gpt-5.4 · effort xhigh",
        configModel: "gpt-5.4",
        configThinking: "effort xhigh",
        configMismatch: false,
        timestamp: "2024-01-01T00:00:02Z",
      },
    ];

    const items = compileTranscriptProjection(messages);
    expect(items).toHaveLength(3);
    expect(items[0]).toMatchObject({
      type: "system",
      subtype: "config_ack",
      configChanged: true,
    });
    expect(items[1]).toMatchObject({
      type: "system",
      subtype: "config_ack",
      configChanged: false,
    });
    expect(items[2]).toMatchObject({
      type: "system",
      subtype: "config_ack",
      configChanged: false,
    });
  });

  it("keeps errors terminal-looking when an older server omits retry metadata", () => {
    const messages: Message[] = [
      {
        id: "msg-err-1",
        type: "error",
        error: "Your refresh token was already used. Please sign in again.",
        timestamp: "2024-01-01T00:00:00Z",
      },
    ];

    const items = compileTranscriptProjection(messages);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      type: "system",
      subtype: "error",
      content: "Your refresh token was already used. Please sign in again.",
    });
  });

  it("renders retrying Codex errors as warnings", () => {
    const messages: Message[] = [
      {
        id: "codex-error-turn-1",
        type: "error",
        error: "Reconnecting... 2/5",
        codexWillRetry: true,
        timestamp: "2024-01-01T00:00:00Z",
      },
    ];

    const items = compileTranscriptProjection(messages);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      type: "system",
      subtype: "warning",
      content: "Reconnecting... 2/5",
    });
  });

  describe("orphaned tool handling", () => {
    it("marks orphaned tool_use as result unavailable", () => {
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

      const items = compileTranscriptProjection(messages);

      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({
        type: "tool_call",
        id: "tool-1",
        status: "incomplete",
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

      const items = compileTranscriptProjection(messages);

      expect(items).toHaveLength(2);
      const tool1 = items.find(
        (i) => i.type === "tool_call" && i.id === "tool-1",
      );
      const tool2 = items.find(
        (i) => i.type === "tool_call" && i.id === "tool-2",
      );

      expect(tool1?.type === "tool_call" && tool1.status).toBe("complete");
      expect(tool2?.type === "tool_call" && tool2.status).toBe("incomplete");
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

      const items = compileTranscriptProjection(messages);

      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({
        type: "tool_call",
        id: "tool-1",
        status: "pending",
      });
    });

    it("keeps Codex background process handles pending", () => {
      const messages: Message[] = [
        {
          id: "msg-1",
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "tool-1",
              name: "Bash",
              input: { command: "sleep 20" },
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
              content:
                "Chunk ID: abc\nWall time: 1.0 seconds\nProcess running with session ID 123\nOutput:\n",
            },
          ],
          timestamp: "2024-01-01T00:00:01Z",
        },
      ];

      const items = compileTranscriptProjection(messages);

      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({
        type: "tool_call",
        id: "tool-1",
        status: "pending",
      });
    });

    it("keeps Codex background process handles incomplete when orphaned", () => {
      const messages: Message[] = [
        {
          id: "msg-1",
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "tool-1",
              name: "Bash",
              input: { command: "sleep 20" },
            },
          ],
          timestamp: "2024-01-01T00:00:00Z",
          orphanedToolUseIds: ["tool-1"],
        },
        {
          id: "msg-2",
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-1",
              content:
                "Chunk ID: abc\nWall time: 1.0 seconds\nProcess running with session ID 123\nOutput:\n",
            },
          ],
          timestamp: "2024-01-01T00:00:01Z",
        },
      ];

      const items = compileTranscriptProjection(messages);

      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({
        type: "tool_call",
        id: "tool-1",
        status: "incomplete",
      });
    });

    it("lets a later observed result win over an orphan marker", () => {
      const messages: Message[] = [
        {
          id: "msg-1",
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "tool-1",
              name: "Edit",
              input: { file_path: "a.ts" },
            },
          ],
          timestamp: "2024-01-01T00:00:00Z",
          orphanedToolUseIds: ["tool-1"],
        },
        {
          id: "msg-2",
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-1",
              content: "Patch applied",
            },
          ],
          timestamp: "2024-01-01T00:00:01Z",
        },
      ];

      const items = compileTranscriptProjection(messages);

      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({
        type: "tool_call",
        id: "tool-1",
        status: "complete",
        toolResult: expect.objectContaining({ content: "Patch applied" }),
      });
    });

    it("keeps interrupted Bash results attachable for final output", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const messages: Message[] = [
        {
          id: "msg-1",
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "tool-1",
              name: "Bash",
              input: { command: "sleep 20" },
            },
          ],
          timestamp: "2024-01-01T00:00:00Z",
          orphanedToolUseIds: ["tool-1"],
        },
        {
          id: "msg-2",
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-1",
              content: "aborted by user after 2.3s",
            },
          ],
          timestamp: "2024-01-01T00:00:01Z",
        },
        {
          id: "msg-3",
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-1",
              content: "(no output)",
            },
          ],
          timestamp: "2024-01-01T00:00:20Z",
        },
      ];

      const items = compileTranscriptProjection(messages);

      expect(warn).not.toHaveBeenCalled();
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({
        type: "tool_call",
        id: "tool-1",
        status: "aborted",
        toolResult: expect.objectContaining({ content: "(no output)" }),
      });
      warn.mockRestore();
    });
  });

  describe("activeToolApproval handling", () => {
    it("treats all orphaned tools as pending when activeToolApproval is true", () => {
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

      const items = compileTranscriptProjection(messages, {
        activeToolApproval: true,
      });

      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({
        type: "tool_call",
        id: "tool-1",
        status: "pending", // Should be pending, not aborted
      });
    });

    it("still marks orphaned tools incomplete when activeToolApproval is false", () => {
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

      const items = compileTranscriptProjection(messages, {
        activeToolApproval: false,
      });

      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({
        type: "tool_call",
        id: "tool-1",
        status: "incomplete",
      });
    });

    it("treats multiple orphaned tools as pending when activeToolApproval is true", () => {
      // Scenario: batch of tool calls all queued for approval
      const messages: Message[] = [
        {
          id: "msg-1",
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "tool-1",
              name: "Edit",
              input: { file_path: "a.ts" },
            },
            {
              type: "tool_use",
              id: "tool-2",
              name: "Edit",
              input: { file_path: "b.ts" },
            },
            {
              type: "tool_use",
              id: "tool-3",
              name: "Edit",
              input: { file_path: "c.ts" },
            },
          ],
          timestamp: "2024-01-01T00:00:00Z",
          orphanedToolUseIds: ["tool-1", "tool-2", "tool-3"],
        },
      ];

      const items = compileTranscriptProjection(messages, {
        activeToolApproval: true,
      });

      expect(items).toHaveLength(3);
      // All should be pending, not aborted
      for (const item of items) {
        expect(item).toMatchObject({
          type: "tool_call",
          status: "pending",
        });
      }
    });

    it("keeps older orphaned tools incomplete during later active tool work", () => {
      const messages: Message[] = [
        {
          id: "msg-1",
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "old-tool",
              name: "Bash",
              input: { command: "sleep 15" },
            },
          ],
          timestamp: "2024-01-01T00:00:00Z",
          orphanedToolUseIds: ["old-tool"],
        },
        {
          id: "msg-2",
          role: "user",
          content: "next prompt",
          timestamp: "2024-01-01T00:00:01Z",
        },
        {
          id: "msg-3",
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "current-tool",
              name: "Edit",
              input: { file_path: "a.ts" },
            },
          ],
          timestamp: "2024-01-01T00:00:02Z",
          orphanedToolUseIds: ["current-tool"],
        },
      ];

      const items = compileTranscriptProjection(messages, {
        activeToolApproval: true,
      });
      const oldTool = items.find(
        (item) => item.type === "tool_call" && item.id === "old-tool",
      );
      const currentTool = items.find(
        (item) => item.type === "tool_call" && item.id === "current-tool",
      );

      expect(oldTool?.type === "tool_call" && oldTool.status).toBe(
        "incomplete",
      );
      expect(currentTool?.type === "tool_call" && currentTool.status).toBe(
        "pending",
      );
    });

    it("handles activeToolApproval with no orphaned tools (no-op)", () => {
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
          // No orphanedToolUseIds
        },
      ];

      const items = compileTranscriptProjection(messages, {
        activeToolApproval: true,
      });

      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({
        type: "tool_call",
        id: "tool-1",
        status: "pending", // Already pending, stays pending
      });
    });
  });

  describe("background command annotation", () => {
    function backgroundLaunchMessages(): Message[] {
      return [
        {
          id: "msg-bg-use",
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "bash-bg-1",
              name: "Bash",
              input: { command: "sleep 600", run_in_background: true },
            },
          ],
          timestamp: "2024-01-01T00:00:00Z",
        },
        {
          id: "msg-bg-result",
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "bash-bg-1",
              content:
                "Command running in background with ID: bxyz123. Output is being written to: /tmp/tasks/bxyz123.output",
            },
          ],
          timestamp: "2024-01-01T00:00:01Z",
        },
      ];
    }

    function findBashCall(
      items: ReturnType<typeof compileTranscriptProjection>,
    ) {
      return items.find(
        (item) => item.type === "tool_call" && item.id === "bash-bg-1",
      );
    }

    it("marks a backgrounded run as running while no completion evidence exists", () => {
      const items = compileTranscriptProjection(backgroundLaunchMessages());
      const call = findBashCall(items);
      expect(call?.type).toBe("tool_call");
      if (call?.type === "tool_call") {
        expect(call.toolInput).toMatchObject({
          _backgroundTaskStatus: "running",
        });
      }
    });

    it("marks a backgrounded run completed when its task notification arrives", () => {
      const messages: Message[] = [
        ...backgroundLaunchMessages(),
        {
          uuid: "33333333-3333-3333-3333-333333333333",
          type: "user",
          origin: { kind: "task-notification" },
          message: {
            role: "user",
            content: [
              "<task-notification>",
              "<task-id>bxyz123</task-id>",
              "<status>completed</status>",
              "<summary>Background command completed (exit code 0)</summary>",
              "</task-notification>",
            ].join("\n"),
          },
          timestamp: "2024-01-01T00:10:00Z",
        },
      ];

      const call = findBashCall(compileTranscriptProjection(messages));
      expect(call?.type).toBe("tool_call");
      if (call?.type === "tool_call") {
        expect(call.toolInput).toMatchObject({
          _backgroundTaskStatus: "completed",
        });
      }
    });

    it("leaves a Codex session-ID background run on the existing pending presentation", () => {
      // "Process running with session ID N" results intentionally keep the
      // call pending (spinner + present-tense header) until the same call's
      // final output arrives, so the annotation pass must not touch them.
      const messages: Message[] = [
        {
          id: "msg-bg-use",
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "bash-bg-1",
              name: "Bash",
              input: { command: "make bench" },
            },
          ],
          timestamp: "2024-01-01T00:00:00Z",
        },
        {
          id: "msg-bg-result",
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "bash-bg-1",
              content: "Process running with session ID 41132",
            },
          ],
          timestamp: "2024-01-01T00:00:01Z",
        },
      ];

      const call = findBashCall(compileTranscriptProjection(messages));
      expect(call?.type).toBe("tool_call");
      if (call?.type === "tool_call") {
        expect(call.status).toBe("pending");
        expect(
          (call.toolInput as Record<string, unknown>)._backgroundTaskStatus,
        ).toBeUndefined();
      }
    });

    it("keeps a detached code-mode script running until its cell wait exits", () => {
      const detachMessages: Message[] = [
        {
          id: "msg-bg-use",
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "bash-bg-1",
              name: "Bash",
              input: { command: "./run-job.sh" },
            },
          ],
          timestamp: "2024-01-01T00:00:00Z",
        },
        {
          id: "msg-bg-result",
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "bash-bg-1",
              content:
                "Script running with cell ID 52\nWall time 10.0 seconds\nOutput:\n",
            },
          ],
          timestamp: "2024-01-01T00:00:01Z",
        },
      ];

      const runningCall = findBashCall(
        compileTranscriptProjection(detachMessages),
      );
      expect(runningCall?.type).toBe("tool_call");
      if (runningCall?.type === "tool_call") {
        expect(runningCall.toolInput).toMatchObject({
          _backgroundTaskStatus: "running",
        });
      }

      const completedCall = findBashCall(
        compileTranscriptProjection([
          ...detachMessages,
          {
            id: "msg-wait-use",
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "wait-1",
                name: "WriteStdin",
                input: { cell_id: "52" },
              },
            ],
            timestamp: "2024-01-01T00:00:02Z",
          },
          {
            id: "msg-wait-result",
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "wait-1",
                content:
                  "Chunk ID: ff710e\nProcess exited with code 0\nOutput:\nready\n",
              },
            ],
            timestamp: "2024-01-01T00:00:03Z",
          },
        ]),
      );
      expect(completedCall?.type).toBe("tool_call");
      if (completedCall?.type === "tool_call") {
        expect(completedCall.toolInput).toMatchObject({
          _backgroundTaskStatus: "completed",
        });
      }
    });

    it("does not annotate an ordinary foreground command", () => {
      const messages: Message[] = [
        {
          id: "msg-fg-use",
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "bash-fg-1",
              name: "Bash",
              input: { command: "ls" },
            },
          ],
          timestamp: "2024-01-01T00:00:00Z",
        },
        {
          id: "msg-fg-result",
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "bash-fg-1",
              content: "README.md\n",
            },
          ],
          timestamp: "2024-01-01T00:00:01Z",
        },
      ];

      const call = compileTranscriptProjection(messages).find(
        (item) => item.type === "tool_call" && item.id === "bash-fg-1",
      );
      expect(call?.type).toBe("tool_call");
      if (call?.type === "tool_call") {
        expect(
          (call.toolInput as Record<string, unknown>)._backgroundTaskStatus,
        ).toBeUndefined();
      }
    });
  });

  describe("task notifications", () => {
    const TASK_NOTIFICATION_XML = [
      "<task-notification>",
      "<task-id>brltxam79</task-id>",
      "<tool-use-id>toolu_01T15Fx9KFBxXmgAzNYZnEBY</tool-use-id>",
      "<output-file>/tmp/tasks/brltxam79.output</output-file>",
      "<status>completed</status>",
      '<summary>Background command "Deploy fix" completed (exit code 0)</summary>',
      "</task-notification>",
    ].join("\n");

    it("renders an origin.kind task-notification as a parsed chip item", () => {
      const messages: Message[] = [
        {
          uuid: "11111111-1111-1111-1111-111111111111",
          type: "user",
          origin: { kind: "task-notification" },
          message: { role: "user", content: TASK_NOTIFICATION_XML },
          timestamp: "2024-01-01T00:00:00Z",
        },
      ];

      const items = compileTranscriptProjection(messages);

      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({
        type: "task_notification",
        taskId: "brltxam79",
        toolUseId: "toolu_01T15Fx9KFBxXmgAzNYZnEBY",
        outputFile: "/tmp/tasks/brltxam79.output",
        status: "completed",
        summary: 'Background command "Deploy fix" completed (exit code 0)',
      });
    });

    it("classifies a queue-sourced notification with no origin via the structural marker", () => {
      // Monitor events arrive as queue-operation enqueues that the server
      // normalizes into deferred user messages WITHOUT origin.kind. Detection
      // must fall back to the content being a <task-notification> element.
      const progressXml = [
        "<task-notification>",
        "<task-id>bsmbc763d</task-id>",
        '<summary>Monitor event: "Wait for staging deploy to finish"</summary>',
        "<event>verify / attempt 1: 502\nverify / attempt 2: 200\nactive</event>",
        "</task-notification>",
      ].join("\n");
      const messages: Message[] = [
        {
          id: "queue-operation-0-2024",
          type: "user",
          role: "user",
          content: progressXml,
          message: { role: "user", content: progressXml },
          timestamp: "2024-01-01T00:00:00Z",
        },
      ];

      const items = compileTranscriptProjection(messages);

      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({
        type: "task_notification",
        taskId: "bsmbc763d",
        status: undefined,
        event: "verify / attempt 1: 502\nverify / attempt 2: 200\nactive",
      });
    });

    it("does not classify a user prompt that merely quotes the tag", () => {
      const messages: Message[] = [
        {
          uuid: "22222222-2222-2222-2222-222222222222",
          type: "user",
          // No origin.kind, and the tag is embedded in prose — not a whole
          // <task-notification> element — so it stays a normal user prompt.
          message: {
            role: "user",
            content: `how should we render ${TASK_NOTIFICATION_XML}?`,
          },
          timestamp: "2024-01-01T00:00:00Z",
        },
      ];

      const items = compileTranscriptProjection(messages);

      expect(items).toHaveLength(1);
      expect(items[0]?.type).toBe("user_prompt");
    });
  });

  describe("harness session continuation", () => {
    // Claude Code restarts a session whose process is gone by injecting this
    // meta prompt and answering it with a zero-token placeholder. Rendering the
    // pair as a user bubble plus an assistant reply shows an exchange that
    // never happened; both collapse into one system notice instead.
    const continuationPair = (): Message[] => [
      {
        uuid: "aaaaaaaa-0000-0000-0000-000000000001",
        type: "user",
        isMeta: true,
        message: {
          role: "user",
          content: [
            { type: "text", text: "Continue from where you left off." },
          ],
        },
        timestamp: "2024-01-01T00:00:00Z",
      },
      {
        uuid: "aaaaaaaa-0000-0000-0000-000000000002",
        type: "assistant",
        message: {
          role: "assistant",
          model: "<synthetic>",
          content: [{ type: "text", text: "No response requested." }],
        },
        timestamp: "2024-01-01T00:00:01Z",
      },
    ];

    it("collapses the injected prompt and its placeholder into one notice", () => {
      const items = compileTranscriptProjection(continuationPair());

      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({
        type: "system",
        subtype: "no_model_turn",
        content: "Session continued without running a turn",
      });
    });

    it("keeps a real assistant turn that happens to use the same words", () => {
      const messages: Message[] = [
        {
          uuid: "aaaaaaaa-0000-0000-0000-000000000003",
          type: "assistant",
          message: {
            role: "assistant",
            model: "claude-opus-4-5",
            content: [{ type: "text", text: "No response requested." }],
          },
          timestamp: "2024-01-01T00:00:02Z",
        },
      ];

      const items = compileTranscriptProjection(messages);

      expect(items).toHaveLength(1);
      expect(items[0]?.type).toBe("text");
    });

    it("keeps a user-typed message with the continuation wording", () => {
      const messages: Message[] = [
        {
          uuid: "aaaaaaaa-0000-0000-0000-000000000004",
          type: "user",
          // Not isMeta: the user actually typed this.
          message: {
            role: "user",
            content: [
              { type: "text", text: "Continue from where you left off." },
            ],
          },
          timestamp: "2024-01-01T00:00:03Z",
        },
      ];

      const items = compileTranscriptProjection(messages);

      expect(items).toHaveLength(1);
      expect(items[0]?.type).toBe("user_prompt");
    });
  });
});
