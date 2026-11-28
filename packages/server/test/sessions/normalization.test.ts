import {
  type ClaudeSessionEntry,
  type CodexSessionContent,
  toUrlProjectId,
  isAppMessage,
} from "@yep-anywhere/shared";
import { assert, describe, expect, it } from "vitest";
import { normalizeSession } from "../../src/sessions/normalization.js";
import type { LoadedSession } from "../../src/sessions/types.js";

const fixtureTimestamp = "2026-03-28T12:12:00.000Z";
const claudeEntry = {
  isSidechain: false,
  userType: "external",
  cwd: "/test-project",
  sessionId: "test-session",
  version: "2.1.0",
  timestamp: fixtureTimestamp,
} as const;
const assistantMessage = {
  type: "message",
  model: "claude-sonnet-4-5",
  usage: { input_tokens: 1, output_tokens: 1 },
} as const;

describe("normalizeSession", () => {
  it("includes sibling tool_results for parallel Tasks with same parentUuid", () => {
    // This simulates 3 parallel Task tool_uses where each produces a tool_result
    // with the same parentUuid (all are children of the assistant message)
    const rawMessages: ClaudeSessionEntry[] = [
      {
        ...claudeEntry,
        type: "assistant",
        uuid: "msg-1",
        parentUuid: null,
        message: {
          ...assistantMessage,
          id: "msg-1",
          role: "assistant",
          content: [
            { type: "tool_use", id: "task-1", name: "Task", input: {} },
            { type: "tool_use", id: "task-2", name: "Task", input: {} },
            { type: "tool_use", id: "task-3", name: "Task", input: {} },
          ],
        },
      },
      // All 3 results have the same parentUuid - they are siblings
      {
        ...claudeEntry,
        type: "user",
        uuid: "result-1",
        parentUuid: "msg-1",
        message: {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "task-1", content: "Result 1" },
          ],
        },
      },
      {
        ...claudeEntry,
        type: "user",
        uuid: "result-2",
        parentUuid: "msg-1",
        message: {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "task-2", content: "Result 2" },
          ],
        },
      },
      {
        ...claudeEntry,
        type: "user",
        uuid: "result-3",
        parentUuid: "msg-1",
        message: {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "task-3", content: "Result 3" },
          ],
        },
      },
    ];

    const mockSession: LoadedSession = {
      transcriptSnapshotUpdatedAt: fixtureTimestamp,
      summary: {
        id: "test-session",
        projectId: toUrlProjectId("/test-project"),
        title: "Test Session",
        fullTitle: "Test Session",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        messageCount: 4,
        ownership: { owner: "none" },
        provider: "claude",
      },
      data: {
        provider: "claude",
        session: {
          messages: rawMessages,
        },
      },
    };

    const normalized = normalizeSession(mockSession);

    // Should have 4 messages: assistant + 3 tool results (2 siblings + 1 active)
    expect(normalized.messages).toHaveLength(4);

    // First message should be the assistant with 3 tool_use blocks
    expect(normalized.messages[0]?.type).toBe("assistant");
    const assistantContent = normalized.messages[0]?.message?.content;
    assert(Array.isArray(assistantContent));
    expect(assistantContent).toHaveLength(3);

    // Collect all tool_use_ids from the remaining messages (tool_results)
    const toolResultIds: string[] = [];
    for (const msg of normalized.messages.slice(1)) {
      const content = msg.message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === "tool_result" && block.tool_use_id) {
            toolResultIds.push(block.tool_use_id);
          }
        }
      }
    }

    // All 3 task results should be present
    expect(toolResultIds).toContain("task-1");
    expect(toolResultIds).toContain("task-2");
    expect(toolResultIds).toContain("task-3");
  });

  it("re-projects an unchanged Claude transcript when its rewind records change", () => {
    const rawMessages: ClaudeSessionEntry[] = [
      {
        ...claudeEntry,
        type: "user",
        uuid: "u1",
        parentUuid: null,
        message: { role: "user", content: "First" },
      },
      {
        ...claudeEntry,
        type: "assistant",
        uuid: "a1",
        parentUuid: "u1",
        message: {
          ...assistantMessage,
          id: "a1",
          role: "assistant",
          content: [{ type: "text", text: "First reply" }],
        },
      },
      {
        ...claudeEntry,
        type: "user",
        uuid: "u2",
        parentUuid: "a1",
        message: { role: "user", content: "Second" },
      },
      {
        ...claudeEntry,
        type: "assistant",
        uuid: "a2",
        parentUuid: "u2",
        message: {
          ...assistantMessage,
          id: "a2",
          role: "assistant",
          content: [{ type: "text", text: "Second reply" }],
        },
      },
    ];
    const loaded: LoadedSession = {
      transcriptSnapshotUpdatedAt: fixtureTimestamp,
      summary: {
        id: "rewound-session",
        projectId: toUrlProjectId("/test-project"),
        title: "Rewound",
        fullTitle: "Rewound",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        messageCount: 4,
        ownership: { owner: "none" },
        provider: "claude",
      },
      data: {
        provider: "claude",
        session: { messages: rawMessages },
      },
    };
    const record = {
      id: "rw-1",
      at: "2026-09-19T00:00:00.000Z",
      cutMessageId: "a1",
      cutTurnIndex: 1,
      droppedTurnCount: 1,
      reason: "clear" as const,
    };

    const plain = normalizeSession(loaded);
    expect(plain.messages.map((m) => m.uuid)).toEqual(["u1", "a1", "u2", "a2"]);
    // Same array identity, same file: the cache answers.
    expect(normalizeSession(loaded).messages).toBe(plain.messages);

    const rewound = normalizeSession(loaded, { rewindRecords: [record] });
    expect(rewound.messages).not.toBe(plain.messages);
    expect(rewound.messages.map((m) => m.uuid)).toEqual([
      "u1",
      "a1",
      "rewound-group-rw-1",
      "u2",
      "a2",
    ]);
    expect(normalizeSession(loaded, { rewindRecords: [record] }).messages).toBe(
      rewound.messages,
    );

    // Deleting the record (a refused rewind) re-projects again.
    expect(normalizeSession(loaded).messages).not.toBe(rewound.messages);
    expect(normalizeSession(loaded).messages.map((m) => m.uuid)).toEqual([
      "u1",
      "a1",
      "u2",
      "a2",
    ]);
  });

  it("replays a Codex MCP call with the view its tool declared", () => {
    const timestamp = new Date().toISOString();
    const loaded: LoadedSession = {
      transcriptSnapshotUpdatedAt: fixtureTimestamp,
      summary: {
        id: "mcp-app-session",
        projectId: toUrlProjectId("/test-project"),
        title: "MCP App",
        fullTitle: "MCP App",
        createdAt: timestamp,
        updatedAt: timestamp,
        messageCount: 1,
        ownership: { owner: "none" },
        provider: "codex",
      },
      data: {
        provider: "codex",
        session: {
          entries: [
            {
              type: "response_item",
              timestamp,
              payload: {
                type: "function_call",
                name: "forecast",
                namespace: "mcp__weather",
                arguments: '{"city":"Oslo"}',
                call_id: "call-mcp-1",
              },
            },
            {
              type: "event_msg",
              timestamp,
              payload: {
                type: "mcp_tool_call_end",
                call_id: "call-mcp-1",
                invocation: { server: "weather", tool: "forecast" },
                mcp_app_ui: {
                  resourceUri: "ui://weather/forecast",
                  preferredModelDisplayMode: "inline",
                },
                result: { Ok: { content: [] } },
              },
            },
            {
              type: "response_item",
              timestamp,
              payload: {
                type: "function_call_output",
                call_id: "call-mcp-1",
                output: "sunny",
              },
            },
          ],
        } as CodexSessionContent,
      },
    };

    const toolUse = normalizeSession(loaded)
      .messages.flatMap((message) =>
        Array.isArray(message.message?.content) ? message.message.content : [],
      )
      .find((block) => block.type === "tool_use");
    expect(toolUse?._mcpApp).toEqual({
      server: "weather",
      tool: "forecast",
      resourceUri: "ui://weather/forecast",
      displayMode: "inline",
    });
  });

  it("normalizes codex-oss sessions correctly", () => {
    const mockSession: LoadedSession = {
      transcriptSnapshotUpdatedAt: fixtureTimestamp,
      summary: {
        id: "oss-test-session",
        projectId: toUrlProjectId("/test-project"),
        title: "Test Session",
        fullTitle: "Test Session",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        messageCount: 1,
        ownership: { owner: "none" },
        provider: "codex-oss",
      },
      data: {
        provider: "codex-oss",
        session: {
          entries: [
            {
              type: "session_meta",
              timestamp: new Date().toISOString(),
              payload: {
                id: "oss-test-session",
                cwd: "/test/path",
                timestamp: new Date().toISOString(),
                model_provider: "ollama",
              },
            },
            {
              type: "event_msg",
              timestamp: new Date().toISOString(),
              payload: {
                type: "user_message",
                message: "Hello OSS",
              },
            },
          ],
        } as CodexSessionContent,
      },
    };

    const normalized = normalizeSession(mockSession);

    expect(normalized).toBeDefined();
    expect(normalized.id).toBe("oss-test-session");
    // Should have 1 message (user message)
    // The session_meta entry is not converted to a message
    expect(normalized.messages).toHaveLength(1);
    expect(normalized.messages[0]?.message?.content).toEqual("Hello OSS");
  });

  it("includes chained parallel Tasks on sibling branches", () => {
    // This simulates the real-world scenario where Claude spawns 3 parallel Tasks
    // as CHAINED messages (each task in separate assistant message that chains from previous)
    // When results come back, conversation continues from the FIRST result,
    // leaving other tasks on "dead" branches
    const rawMessages: ClaudeSessionEntry[] = [
      {
        ...claudeEntry,
        type: "assistant",
        uuid: "text-msg",
        parentUuid: null,
        message: {
          ...assistantMessage,
          id: "text-msg",
          role: "assistant",
          content: [{ type: "text", text: "Let me explore..." }],
        },
      },
      {
        ...claudeEntry,
        type: "assistant",
        uuid: "task-1-msg",
        parentUuid: "text-msg",
        message: {
          ...assistantMessage,
          id: "task-1-msg",
          role: "assistant",
          content: [
            { type: "tool_use", id: "task-1-id", name: "Task", input: {} },
          ],
        },
      },
      {
        ...claudeEntry,
        type: "assistant",
        uuid: "task-2-msg",
        parentUuid: "task-1-msg",
        message: {
          ...assistantMessage,
          id: "task-2-msg",
          role: "assistant",
          content: [
            { type: "tool_use", id: "task-2-id", name: "Task", input: {} },
          ],
        },
      },
      {
        ...claudeEntry,
        type: "assistant",
        uuid: "task-3-msg",
        parentUuid: "task-2-msg",
        message: {
          ...assistantMessage,
          id: "task-3-msg",
          role: "assistant",
          content: [
            { type: "tool_use", id: "task-3-id", name: "Task", input: {} },
          ],
        },
      },
      // Results
      {
        ...claudeEntry,
        type: "user",
        uuid: "result-3",
        parentUuid: "task-3-msg",
        message: {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "task-3-id", content: "R3" },
          ],
        },
      },
      {
        ...claudeEntry,
        type: "user",
        uuid: "result-2",
        parentUuid: "task-2-msg",
        message: {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "task-2-id", content: "R2" },
          ],
        },
      },
      {
        ...claudeEntry,
        type: "user",
        uuid: "result-1",
        parentUuid: "task-1-msg",
        message: {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "task-1-id", content: "R1" },
          ],
        },
      },
      // Conversation continues from result-1, making task-2 and task-3 on dead branches
      {
        ...claudeEntry,
        type: "assistant",
        uuid: "cont-1",
        parentUuid: "result-1",
        message: {
          ...assistantMessage,
          id: "cont-1",
          role: "assistant",
          content: [{ type: "text", text: "Excellent..." }],
        },
      },
      {
        ...claudeEntry,
        type: "user",
        uuid: "cont-2",
        parentUuid: "cont-1",
        message: { role: "user", content: "Continue" },
      },
      {
        ...claudeEntry,
        type: "assistant",
        uuid: "cont-3",
        parentUuid: "cont-2",
        message: {
          ...assistantMessage,
          id: "cont-3",
          role: "assistant",
          content: [{ type: "text", text: "Sure..." }],
        },
      },
      {
        ...claudeEntry,
        type: "user",
        uuid: "cont-4",
        parentUuid: "cont-3",
        message: { role: "user", content: "More" },
      },
    ];

    const mockSession: LoadedSession = {
      transcriptSnapshotUpdatedAt: fixtureTimestamp,
      summary: {
        id: "test-session",
        projectId: toUrlProjectId("/test-project"),
        title: "Test Session",
        fullTitle: "Test Session",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        messageCount: 11,
        ownership: { owner: "none" },
        provider: "claude",
      },
      data: {
        provider: "claude",
        session: {
          messages: rawMessages,
        },
      },
    };

    const normalized = normalizeSession(mockSession);

    // Collect all tool_use IDs and tool_result IDs from normalized messages
    const toolUseIds: string[] = [];
    const toolResultIds: string[] = [];
    for (const msg of normalized.messages) {
      const content = msg.message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === "tool_use" && block.id) {
            toolUseIds.push(block.id);
          }
          if (block.type === "tool_result" && block.tool_use_id) {
            toolResultIds.push(block.tool_use_id);
          }
        }
      }
    }

    // All 3 Task tool_uses should be present
    expect(toolUseIds).toContain("task-1-id");
    expect(toolUseIds).toContain("task-2-id");
    expect(toolUseIds).toContain("task-3-id");

    // All 3 Task results should be present
    expect(toolResultIds).toContain("task-1-id");
    expect(toolResultIds).toContain("task-2-id");
    expect(toolResultIds).toContain("task-3-id");
  });

  it("reconstructs removed queued prompts as persisted user messages", () => {
    const rawMessages: ClaudeSessionEntry[] = [
      {
        type: "queue-operation",
        operation: "enqueue",
        timestamp: "2026-03-28T12:12:01.573Z",
        sessionId: "queue-history-session",
        content:
          "i want to test a session where i speak out of turn (while you're busy doing stuff). to that end please run a sleep 20 command (so you sleep for 20 seconds).",
      },
      {
        type: "queue-operation",
        operation: "dequeue",
        timestamp: "2026-03-28T12:12:01.575Z",
        sessionId: "queue-history-session",
      },
      {
        ...claudeEntry,
        type: "user",
        uuid: "user-1",
        timestamp: "2026-03-28T12:12:01.576Z",
        sessionId: "queue-history-session",
        parentUuid: null,
        message: {
          role: "user",
          content:
            "i want to test a session where i speak out of turn (while you're busy doing stuff). to that end please run a sleep 20 command (so you sleep for 20 seconds).",
        },
      },
      {
        ...claudeEntry,
        type: "assistant",
        uuid: "assistant-1",
        timestamp: "2026-03-28T12:12:01.600Z",
        sessionId: "queue-history-session",
        parentUuid: "user-1",
        message: {
          ...assistantMessage,
          id: "assistant-1",
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "bash-sleep",
              name: "Bash",
              input: { command: "sleep 20" },
            },
          ],
        },
      },
      {
        type: "queue-operation",
        operation: "enqueue",
        timestamp: "2026-03-28T12:12:10.002Z",
        sessionId: "queue-history-session",
        content: "i'm talking out of turn!",
      },
      {
        type: "queue-operation",
        operation: "enqueue",
        timestamp: "2026-03-28T12:12:14.115Z",
        sessionId: "queue-history-session",
        content: "saying a second thing out of turn",
      },
      {
        type: "queue-operation",
        operation: "enqueue",
        timestamp: "2026-03-28T12:12:17.757Z",
        sessionId: "queue-history-session",
        content: "saying a third thing out of turn",
      },
      {
        ...claudeEntry,
        type: "user",
        uuid: "tool-result-1",
        timestamp: "2026-03-28T12:12:27.771Z",
        sessionId: "queue-history-session",
        parentUuid: "assistant-1",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "bash-sleep",
              content: "(Bash completed with no output)",
            },
          ],
        },
      },
      {
        type: "queue-operation",
        operation: "remove",
        timestamp: "2026-03-28T12:12:27.772Z",
        sessionId: "queue-history-session",
      },
      {
        type: "queue-operation",
        operation: "remove",
        timestamp: "2026-03-28T12:12:27.773Z",
        sessionId: "queue-history-session",
      },
      {
        type: "queue-operation",
        operation: "remove",
        timestamp: "2026-03-28T12:12:27.774Z",
        sessionId: "queue-history-session",
      },
      {
        ...claudeEntry,
        type: "assistant",
        uuid: "assistant-2",
        timestamp: "2026-03-28T12:12:28.000Z",
        sessionId: "queue-history-session",
        parentUuid: "tool-result-1",
        message: {
          ...assistantMessage,
          id: "assistant-2",
          role: "assistant",
          content: [
            {
              type: "text",
              text: "Done sleeping. I saw the queued messages.",
            },
          ],
        },
      },
    ];

    const mockSession: LoadedSession = {
      transcriptSnapshotUpdatedAt: fixtureTimestamp,
      summary: {
        id: "queue-history-session",
        projectId: toUrlProjectId("/test-project"),
        title: "Queue history session",
        fullTitle: "Queue history session",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        messageCount: rawMessages.length,
        ownership: { owner: "none" },
        provider: "claude",
      },
      data: {
        provider: "claude",
        session: {
          messages: rawMessages,
        },
      },
    };

    const normalized = normalizeSession(mockSession);
    const visibleUserMessages = normalized.messages
      .filter((message) => message.type === "user")
      .map((message) => message.message?.content);

    expect(visibleUserMessages).toEqual([
      "i want to test a session where i speak out of turn (while you're busy doing stuff). to that end please run a sleep 20 command (so you sleep for 20 seconds).",
      "i'm talking out of turn!",
      "saying a second thing out of turn",
      "saying a third thing out of turn",
      [
        {
          type: "tool_result",
          tool_use_id: "bash-sleep",
          content: "(Bash completed with no output)",
        },
      ],
    ]);

    expect(
      normalized.messages
        .filter((message) => message.deferred === true)
        .map((message) => message.message?.content),
    ).toEqual([
      "i'm talking out of turn!",
      "saying a second thing out of turn",
      "saying a third thing out of turn",
    ]);
  });

  it("normalizes Gemini tool results into valid app messages", () => {
    const timestamp = "2026-08-06T00:00:00.000Z";
    const mockSession: LoadedSession = {
      transcriptSnapshotUpdatedAt: fixtureTimestamp,
      summary: {
        id: "gemini-session",
        projectId: toUrlProjectId("/test-project"),
        title: "Gemini session",
        fullTitle: "Gemini session",
        createdAt: timestamp,
        updatedAt: timestamp,
        messageCount: 2,
        ownership: { owner: "none" },
        provider: "gemini",
      },
      data: {
        provider: "gemini",
        session: {
          sessionId: "gemini-session",
          projectHash: "project-hash",
          startTime: timestamp,
          lastUpdated: timestamp,
          messages: [
            {
              id: "assistant-1",
              timestamp,
              type: "gemini",
              content: "I read the file.",
              toolCalls: [
                {
                  id: "call-1",
                  name: "read_file",
                  args: { path: "README.md" },
                  result: [
                    {
                      functionResponse: {
                        id: "call-1",
                        name: "read_file",
                        response: { output: "contents" },
                      },
                    },
                  ],
                },
              ],
            },
          ],
        },
      },
    };

    const normalized = normalizeSession(mockSession);

    expect(normalized.messages[1]).toMatchObject({
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "call-1",
            content: "contents",
          },
        ],
      },
    });
    expect(normalized.messages.every(isAppMessage)).toBe(true);
  });
});
