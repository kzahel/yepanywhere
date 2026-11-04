import { describe, expect, it } from "vitest";
import type { PaginationInfo } from "../../../api/client";
import type { Message, SessionMetadata } from "../../../types";
import type { SessionRouteSnapshot } from "../../sessionRouteSnapshots";
import {
  createInitialSessionDetailState,
  reduceSessionDetailActions,
  reduceSessionDetailState,
} from "../transcriptReducer";

function sessionMetadata(provider = "claude"): SessionMetadata {
  return {
    id: "session-1",
    projectId: "project-1",
    provider,
    title: "Session 1",
    updatedAt: "2026-07-01T12:00:00.000Z",
    createdAt: "2026-07-01T12:00:00.000Z",
    messageCount: 0,
    ownership: { owner: "none" },
  } as SessionMetadata;
}

it("keeps a live delivery confirmation through stale metadata and transcript replies, but admits a newer attempt", () => {
  const confirmed = {
    ...sessionMetadata(),
    creation: {
      state: "bound" as const,
      delivery: "consumed" as const,
      attemptId: "first",
      updatedAt: "2026-11-04T00:00:00.000Z",
      revision: 10,
    },
  };
  const stale = {
    ...confirmed,
    creation: {
      ...confirmed.creation,
      delivery: "not-admitted" as const,
      revision: 9,
    },
  };
  let state = reduceSessionDetailState(createInitialSessionDetailState(), {
    type: "setSessionMetadata",
    session: confirmed,
  });
  state = reduceSessionDetailState(state, {
    type: "setSessionMetadata",
    session: stale,
  });
  expect(state.session?.creation).toEqual(confirmed.creation);
  state = reduceSessionDetailState(state, {
    type: "replaceTailWindow",
    session: stale,
    messages: [],
    pagination: pagination(),
  });
  expect(state.session?.creation).toEqual(confirmed.creation);
  const retry = {
    ...confirmed,
    creation: {
      ...confirmed.creation,
      state: "saved" as const,
      delivery: "not-admitted" as const,
      attemptId: "second",
      revision: 11,
    },
  };
  state = reduceSessionDetailState(state, {
    type: "setSessionMetadata",
    session: retry,
  });
  expect(state.session?.creation).toEqual(retry.creation);
});

function pagination(overrides: Partial<PaginationInfo> = {}): PaginationInfo {
  return {
    hasOlderMessages: false,
    totalMessageCount: 2,
    returnedMessageCount: 2,
    totalCompactions: 0,
    ...overrides,
  };
}

function userMessage(
  uuid: string,
  content: string,
  timestamp: string,
): Message {
  return {
    type: "user",
    uuid,
    timestamp,
    message: { role: "user", content },
  };
}

function assistantMessage(
  uuid: string,
  content: string,
  timestamp: string,
): Message {
  return {
    type: "assistant",
    uuid,
    timestamp,
    message: { role: "assistant", content },
  };
}

function durableRecapMessage(uuid: string, timestamp: string): Message {
  return {
    type: "assistant",
    uuid,
    timestamp,
    yaRecapSource: "provider",
    message: {
      role: "assistant",
      content: "Session recap",
    },
  };
}

function comparableMessages(messages: readonly Message[]) {
  return messages.map((message) => ({
    uuid: message.uuid,
    type: message.type,
    content: message.message?.content,
  }));
}

describe("transcriptReducer", () => {
  it("restores retained route snapshots without retagging message provenance", () => {
    const snapshot: SessionRouteSnapshot = {
      messages: [
        {
          ...userMessage("sdk-user-1", "cached", "2026-07-01T12:00:00.000Z"),
          _source: "sdk",
        },
        {
          ...assistantMessage(
            "jsonl-assistant-1",
            "persisted",
            "2026-07-01T12:00:01.000Z",
          ),
          _source: "jsonl",
        },
      ],
      session: sessionMetadata(),
      agentContent: {},
      markdownAugments: {
        "jsonl-assistant-1": { html: "<p>persisted</p>" },
      },
      toolUseToAgentEntries: [],
      lastMessageId: "jsonl-assistant-1",
      maxPersistedTimestampMs: Date.parse("2026-07-01T12:00:01.000Z"),
    };
    const state = reduceSessionDetailState(createInitialSessionDetailState(), {
      type: "restoreRouteSnapshot",
      snapshot,
    });

    expect(state.messages.map((message) => message._source)).toEqual([
      "sdk",
      "jsonl",
    ]);
    expect(state.lastMessageId).toBe("jsonl-assistant-1");
    expect(state.markdownAugments).toEqual({
      "jsonl-assistant-1": { html: "<p>persisted</p>" },
    });
    expect(state.maxPersistedTimestampMs).toBe(
      Date.parse("2026-07-01T12:00:01.000Z"),
    );
  });

  it("loads persisted transcript messages as canonical JSONL rows", () => {
    const messages = [
      userMessage("user-1", "hello", "2026-07-01T12:00:00.000Z"),
      assistantMessage("assistant-1", "hi", "2026-07-01T12:00:01.000Z"),
    ];
    const state = reduceSessionDetailState(createInitialSessionDetailState(), {
      type: "loadPersistedTranscript",
      session: sessionMetadata(),
      messages,
      pagination: pagination(),
    });

    expect(state.messages.map((message) => message._source)).toEqual([
      "jsonl",
      "jsonl",
    ]);
    expect(state.lastMessageId).toBe("assistant-1");
    expect(state.maxPersistedTimestampMs).toBe(
      Date.parse("2026-07-01T12:00:01.000Z"),
    );
    expect(state.pagination?.totalMessageCount).toBe(2);
  });

  it("treats persisted loads as the returned transcript window", () => {
    const loadedFullHistory = reduceSessionDetailState(
      createInitialSessionDetailState(),
      {
        type: "loadPersistedTranscript",
        session: sessionMetadata("codex"),
        messages: [
          userMessage("user-1", "old", "2026-07-01T12:00:00.000Z"),
          assistantMessage("assistant-1", "old", "2026-07-01T12:00:01.000Z"),
          userMessage("user-2", "current", "2026-07-01T12:10:00.000Z"),
        ],
        pagination: pagination({
          hasOlderMessages: false,
          totalMessageCount: 3,
          returnedMessageCount: 3,
          totalCompactions: 1,
        }),
      },
    );

    const tailWindow = reduceSessionDetailState(loadedFullHistory, {
      type: "loadPersistedTranscript",
      session: sessionMetadata("codex"),
      messages: [
        assistantMessage("assistant-1", "old", "2026-07-01T12:00:01.000Z"),
        userMessage("user-2", "current", "2026-07-01T12:10:00.000Z"),
      ],
      pagination: pagination({
        hasOlderMessages: true,
        truncatedBeforeMessageId: "assistant-1",
        totalMessageCount: 3,
        returnedMessageCount: 2,
        totalCompactions: 1,
      }),
    });

    expect(tailWindow.messages.map((message) => message.uuid)).toEqual([
      "assistant-1",
      "user-2",
    ]);
    expect(tailWindow.pagination).toMatchObject({
      hasOlderMessages: true,
      totalMessageCount: 3,
      returnedMessageCount: 2,
    });
    expect(tailWindow.lastMessageId).toBe("user-2");
  });

  it("preserves loaded-window boundaries during catch-up", () => {
    const loadedFullHistory = reduceSessionDetailState(
      createInitialSessionDetailState(),
      {
        type: "loadPersistedTranscript",
        session: sessionMetadata(),
        messages: [
          userMessage("user-1", "old", "2026-07-01T12:00:00.000Z"),
          assistantMessage("assistant-1", "old", "2026-07-01T12:00:01.000Z"),
          userMessage("user-2", "current", "2026-07-01T12:10:00.000Z"),
        ],
        pagination: pagination({
          hasOlderMessages: false,
          totalMessageCount: 3,
          returnedMessageCount: 3,
        }),
      },
    );

    const state = reduceSessionDetailState(loadedFullHistory, {
      type: "applyCatchupMessages",
      session: sessionMetadata(),
      messages: [
        assistantMessage(
          "assistant-2",
          "current reply",
          "2026-07-01T12:10:01.000Z",
        ),
      ],
      pagination: pagination({
        hasOlderMessages: true,
        truncatedBeforeMessageId: "assistant-2",
        truncatedBy: "compact_boundary",
        totalMessageCount: 5,
        returnedMessageCount: 1,
      }),
    });

    expect(state.messages.map((message) => message.uuid)).toEqual([
      "user-1",
      "assistant-1",
      "user-2",
      "assistant-2",
    ]);
    expect(state.pagination).toMatchObject({
      hasOlderMessages: false,
      totalMessageCount: 5,
      returnedMessageCount: 4,
    });
    expect(state.pagination?.truncatedBeforeMessageId).toBeUndefined();
    expect(state.pagination?.truncatedBy).toBeUndefined();
  });

  it("replaces the loaded tail window for explicit anchor-miss fallback", () => {
    const loadedFullHistory = reduceSessionDetailState(
      createInitialSessionDetailState(),
      {
        type: "loadPersistedTranscript",
        session: sessionMetadata(),
        messages: [
          userMessage("user-1", "old", "2026-07-01T12:00:00.000Z"),
          assistantMessage("assistant-1", "old", "2026-07-01T12:00:01.000Z"),
          userMessage("user-2", "current", "2026-07-01T12:10:00.000Z"),
        ],
        pagination: pagination({
          hasOlderMessages: false,
          totalMessageCount: 3,
          returnedMessageCount: 3,
        }),
      },
    );

    const state = reduceSessionDetailState(loadedFullHistory, {
      type: "replaceTailWindow",
      session: sessionMetadata(),
      messages: [
        userMessage("user-2", "current", "2026-07-01T12:10:00.000Z"),
        assistantMessage(
          "assistant-2",
          "current reply",
          "2026-07-01T12:10:01.000Z",
        ),
      ],
      pagination: pagination({
        hasOlderMessages: true,
        truncatedBeforeMessageId: "user-2",
        truncatedBy: "compact_boundary",
        totalMessageCount: 5,
        returnedMessageCount: 2,
      }),
    });

    expect(state.messages.map((message) => message.uuid)).toEqual([
      "user-2",
      "assistant-2",
    ]);
    expect(state.pagination).toMatchObject({
      hasOlderMessages: true,
      totalMessageCount: 5,
      returnedMessageCount: 2,
      truncatedBeforeMessageId: "user-2",
      truncatedBy: "compact_boundary",
    });
    expect(state.lastMessageId).toBe("assistant-2");
  });

  it("sets session metadata without changing transcript rows", () => {
    const messages = [
      userMessage("user-1", "hello", "2026-07-01T12:00:00.000Z"),
    ];
    const loaded = reduceSessionDetailState(createInitialSessionDetailState(), {
      type: "loadPersistedTranscript",
      session: sessionMetadata(),
      messages,
      pagination: pagination({ totalMessageCount: 1, returnedMessageCount: 1 }),
    });
    const session = {
      ...sessionMetadata(),
      title: "Updated title",
      model: "gpt-5.4",
    };

    const state = reduceSessionDetailState(loaded, {
      type: "setSessionMetadata",
      session,
    });

    expect(state.session).toBe(session);
    expect(state.messages).toBe(loaded.messages);
  });

  it("gives equivalent message shape for persisted and streamed basic turns", () => {
    const messages = [
      userMessage("user-1", "hello", "2026-07-01T12:00:00.000Z"),
      assistantMessage("assistant-1", "hi", "2026-07-01T12:00:01.000Z"),
    ];
    const persistedState = reduceSessionDetailState(
      createInitialSessionDetailState(),
      {
        type: "loadPersistedTranscript",
        session: sessionMetadata(),
        messages,
      },
    );
    const streamedState = reduceSessionDetailActions(
      messages.map((message) => ({
        type: "applyStreamMessage" as const,
        message,
      })),
      {
        ...createInitialSessionDetailState(),
        session: sessionMetadata(),
      },
    );

    expect(comparableMessages(streamedState.messages)).toEqual(
      comparableMessages(persistedState.messages),
    );
  });

  it("merges catch-up persisted rows over streamed rows with the same ids", () => {
    const streamedMessages = [
      userMessage("user-1", "hello", "2026-07-01T12:00:00.000Z"),
      assistantMessage("assistant-1", "hi", "2026-07-01T12:00:01.000Z"),
    ];
    const state = reduceSessionDetailActions(
      [
        ...streamedMessages.map((message) => ({
          type: "applyStreamMessage" as const,
          message,
        })),
        {
          type: "applyCatchupMessages" as const,
          messages: streamedMessages,
          pagination: pagination(),
        },
      ],
      {
        ...createInitialSessionDetailState(),
        session: sessionMetadata(),
      },
    );

    expect(state.messages).toHaveLength(2);
    expect(state.messages.map((message) => message._source)).toEqual([
      "jsonl",
      "jsonl",
    ]);
    expect(state.lastMessageId).toBe("assistant-1");
  });

  it("reconciles a streamed user prompt by provider identity", () => {
    const state = reduceSessionDetailActions(
      [
        {
          type: "applyStreamMessage",
          message: userMessage(
            "provider-user-1",
            "start the task",
            "2026-07-01T12:00:00.000Z",
          ),
        },
        {
          type: "applyCatchupMessages",
          messages: [
            userMessage(
              "provider-user-1",
              "start the task",
              "2026-07-01T12:00:01.000Z",
            ),
          ],
        },
      ],
      {
        ...createInitialSessionDetailState(),
        session: sessionMetadata("codex"),
      },
    );

    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]?._source).toBe("jsonl");
    expect(state.messages[0]?.uuid).toBe("provider-user-1");
  });

  it("reconciles a streamed assistant response by provider identity", () => {
    const state = reduceSessionDetailActions(
      [
        {
          type: "applyStreamMessage",
          message: assistantMessage(
            "provider-assistant-1",
            "The task is complete.",
            "2026-07-01T12:00:00.000Z",
          ),
        },
        {
          type: "applyCatchupMessages",
          messages: [
            assistantMessage(
              "provider-assistant-1",
              "The task is complete.",
              "2026-07-01T12:00:00.900Z",
            ),
          ],
        },
      ],
      {
        ...createInitialSessionDetailState(),
        session: sessionMetadata("codex"),
      },
    );

    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]?._source).toBe("jsonl");
    expect(state.messages[0]?.uuid).toBe("provider-assistant-1");
  });

  it("keeps equal Codex assistant rows distinct for an aligned server", () => {
    const state = reduceSessionDetailActions(
      [
        {
          type: "applyStreamMessage",

          message: assistantMessage(
            "first-provider-assistant-id",
            "Still waiting.",
            "2026-07-01T12:00:00.000Z",
          ),
        },
        {
          type: "applyCatchupMessages",

          messages: [
            assistantMessage(
              "second-provider-assistant-id",
              "Still waiting.",
              "2026-07-01T12:00:00.000Z",
            ),
          ],
        },
      ],
      {
        ...createInitialSessionDetailState(),
        session: sessionMetadata("codex"),
      },
    );

    expect(state.messages.map((message) => message.uuid)).toEqual([
      "first-provider-assistant-id",
      "second-provider-assistant-id",
    ]);
  });

  it("drops transient streaming placeholders when streaming is disabled", () => {
    const streamingMessage: Message = {
      ...assistantMessage(
        "assistant-streaming",
        "partial",
        "2026-07-01T12:00:00.000Z",
      ),
      _isStreaming: true,
    };
    const state = reduceSessionDetailActions(
      [
        {
          type: "applyStreamMessage",
          message: streamingMessage,
        },
        {
          type: "applyStreamMessage",
          message: streamingMessage,
          streamingEnabled: false,
        },
      ],
      {
        ...createInitialSessionDetailState(),
        session: sessionMetadata(),
      },
    );

    expect(state.messages).toEqual([]);
  });

  it("upserts main streaming placeholders by message id", () => {
    const first: Message = {
      ...assistantMessage(
        "assistant-streaming",
        "partial",
        "2026-07-01T12:00:00.000Z",
      ),
      _isStreaming: true,
    };
    const updated: Message = {
      ...assistantMessage(
        "assistant-streaming",
        "partial complete",
        "2026-07-01T12:00:01.000Z",
      ),
      _isStreaming: true,
    };
    const state = reduceSessionDetailActions([
      {
        type: "upsertStreamingPlaceholder",
        message: first,
      },
      {
        type: "upsertStreamingPlaceholder",
        message: updated,
      },
    ]);

    expect(state.messages).toEqual([updated]);
  });

  it("clears main streaming placeholders without replacing durable rows", () => {
    const durableMessage = assistantMessage(
      "assistant-durable",
      "done",
      "2026-07-01T12:00:00.000Z",
    );
    const streamingMessage: Message = {
      ...assistantMessage(
        "assistant-streaming",
        "partial",
        "2026-07-01T12:00:01.000Z",
      ),
      _isStreaming: true,
    };
    const state = reduceSessionDetailActions([
      {
        type: "upsertStreamingPlaceholder",
        message: durableMessage,
      },
      {
        type: "upsertStreamingPlaceholder",
        message: streamingMessage,
      },
      {
        type: "clearStreamingPlaceholders",
      },
    ]);

    expect(state.messages).toEqual([durableMessage]);
  });

  it("removes a cancelled unconfirmed self-send by temp id", () => {
    const unconfirmed: Message = {
      ...userMessage("steer-echo", "steer text", "2026-07-01T12:00:00.000Z"),
      tempId: "temp-steer",
      _source: "sdk",
      messageMetadata: { deliveryIntent: "steer" },
    };
    const durableSameTempId: Message = {
      ...userMessage(
        "durable-user",
        "durable text",
        "2026-07-01T12:00:01.000Z",
      ),
      tempId: "temp-steer",
      _source: "jsonl",
    };
    const assistant = assistantMessage(
      "assistant-1",
      "kept",
      "2026-07-01T12:00:02.000Z",
    );

    const state = reduceSessionDetailState(
      {
        ...createInitialSessionDetailState(),
        messages: [unconfirmed, durableSameTempId, assistant],
      },
      { type: "removeUnconfirmedSelfSend", tempId: "temp-steer" },
    );

    expect(state.messages.map((message) => message.uuid)).toEqual([
      "durable-user",
      "assistant-1",
    ]);
  });

  it("keeps byte-identical Codex rows with distinct provider ids", () => {
    const timestamp = "2026-07-01T12:00:00.000Z";
    const state = reduceSessionDetailState(createInitialSessionDetailState(), {
      type: "loadPersistedTranscript",

      session: sessionMetadata("codex"),
      messages: [
        userMessage("user-1", "wait 10 minutes", timestamp),
        userMessage("user-2", "wait 10 minutes", timestamp),
        assistantMessage("assistant-1", "Still waiting.", timestamp),
        assistantMessage("assistant-2", "Still waiting.", timestamp),
      ],
    });

    expect(state.messages.map((message) => message.uuid)).toEqual([
      "user-1",
      "user-2",
      "assistant-1",
      "assistant-2",
    ]);
  });

  it("suppresses replay events already covered by persisted rows", () => {
    const persisted = userMessage(
      "jsonl-user-1",
      "already loaded",
      "2026-07-01T12:00:00.000Z",
    );
    const state = reduceSessionDetailActions([
      {
        type: "loadPersistedTranscript",
        session: sessionMetadata("codex"),
        messages: [persisted],
      },
      {
        type: "applyStreamMessage",
        message: {
          ...userMessage(
            "jsonl-user-1",
            "already loaded",
            "2026-07-01T12:00:00.000Z",
          ),
          isReplay: true,
        },
      },
    ]);

    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]?.uuid).toBe("jsonl-user-1");
  });

  it("keeps a Codex replay row with a new provider id", () => {
    const timestamp = "2026-07-01T12:00:00.000Z";
    const state = reduceSessionDetailActions([
      {
        type: "loadPersistedTranscript",
        session: sessionMetadata("codex"),
        messages: [userMessage("provider-user-1", "again", timestamp)],
      },
      {
        type: "applyStreamMessage",

        message: {
          ...userMessage("provider-user-2", "again", timestamp),
          isReplay: true,
        },
      },
    ]);

    expect(state.messages.map((message) => message.uuid)).toEqual([
      "provider-user-1",
      "provider-user-2",
    ]);
  });

  it("skips durable recap overlays when computing persisted cursors", () => {
    const state = reduceSessionDetailState(createInitialSessionDetailState(), {
      type: "loadPersistedTranscript",
      session: sessionMetadata(),
      messages: [
        userMessage("user-1", "before recap", "2026-07-01T12:00:00.000Z"),
        assistantMessage(
          "assistant-1",
          "before recap reply",
          "2026-07-01T12:00:01.000Z",
        ),
        durableRecapMessage("recap-1", "2026-07-01T12:05:00.000Z"),
      ],
    });

    expect(state.lastMessageId).toBe("assistant-1");
    expect(state.maxPersistedTimestampMs).toBe(
      Date.parse("2026-07-01T12:00:01.000Z"),
    );
  });

  it("prepends older persisted messages and updates pagination", () => {
    const initial = reduceSessionDetailState(
      createInitialSessionDetailState(),
      {
        type: "loadPersistedTranscript",
        session: sessionMetadata(),
        messages: [
          userMessage("user-2", "current", "2026-07-01T12:10:00.000Z"),
          assistantMessage(
            "assistant-2",
            "current reply",
            "2026-07-01T12:10:01.000Z",
          ),
        ],
        pagination: pagination({
          hasOlderMessages: true,
          truncatedBeforeMessageId: "user-2",
          totalMessageCount: 4,
        }),
      },
    );
    const state = reduceSessionDetailState(initial, {
      type: "prependOlderMessages",
      messages: [
        userMessage("user-1", "older", "2026-07-01T12:00:00.000Z"),
        assistantMessage(
          "assistant-1",
          "older reply",
          "2026-07-01T12:00:01.000Z",
        ),
      ],
      pagination: pagination({
        hasOlderMessages: false,
        totalMessageCount: 4,
        returnedMessageCount: 4,
      }),
    });

    expect(state.messages.map((message) => message.uuid)).toEqual([
      "user-1",
      "assistant-1",
      "user-2",
      "assistant-2",
    ]);
    expect(state.messages.every((message) => message._source === "jsonl")).toBe(
      true,
    );
    expect(state.pagination?.hasOlderMessages).toBe(false);
    expect(state.lastMessageId).toBe("assistant-2");
  });

  it("preserves subagent content as broad provenance shape", () => {
    const agentMessage = assistantMessage(
      "agent-assistant-1",
      "Subagent summary",
      "2026-07-01T12:00:02.000Z",
    );
    const state = reduceSessionDetailState(createInitialSessionDetailState(), {
      type: "loadPersistedTranscript",
      session: sessionMetadata(),
      messages: [userMessage("user-1", "delegate", "2026-07-01T12:00:00.000Z")],
      agentContent: {
        "agent-a": {
          messages: [agentMessage],
          status: "completed",
          contextUsage: {
            inputTokens: 1234,
            percentage: 12,
          },
        },
      },
      toolUseToAgentEntries: [["toolu_1", "agent-a"]],
    });

    expect(state.agentContent["agent-a"]).toEqual({
      messages: [agentMessage],
      status: "completed",
      contextUsage: {
        inputTokens: 1234,
        percentage: 12,
      },
    });
    expect(state.toolUseToAgentEntries).toEqual([["toolu_1", "agent-a"]]);
  });

  it("applies subagent stream messages and tool mappings as thin state", () => {
    const first = assistantMessage(
      "agent-assistant-1",
      "running",
      "2026-07-01T12:00:02.000Z",
    );
    const duplicate = assistantMessage(
      "agent-assistant-1",
      "running duplicate",
      "2026-07-01T12:00:03.000Z",
    );
    const state = reduceSessionDetailActions([
      {
        type: "registerToolUseAgent",
        toolUseId: "toolu_1",
        agentId: "agent-a",
      },
      {
        type: "registerToolUseAgent",
        toolUseId: "toolu_1",
        agentId: "agent-b",
      },
      {
        type: "applyStreamSubagentMessage",
        agentId: "agent-a",
        message: first,
      },
      {
        type: "applyStreamSubagentMessage",
        agentId: "agent-a",
        message: duplicate,
      },
    ]);

    expect(state.toolUseToAgentEntries).toEqual([["toolu_1", "agent-a"]]);
    expect(state.agentContent["agent-a"]?.messages).toEqual([first]);
    expect(state.agentContent["agent-a"]?.status).toBe("running");
  });

  it("upserts subagent streaming placeholders by message id", () => {
    const first: Message = {
      ...assistantMessage(
        "agent-streaming",
        "partial",
        "2026-07-01T12:00:02.000Z",
      ),
      _isStreaming: true,
    };
    const updated: Message = {
      ...assistantMessage(
        "agent-streaming",
        "partial complete",
        "2026-07-01T12:00:03.000Z",
      ),
      _isStreaming: true,
    };
    const state = reduceSessionDetailActions([
      {
        type: "upsertStreamingPlaceholder",
        agentId: "agent-a",
        message: first,
      },
      {
        type: "upsertStreamingPlaceholder",
        agentId: "agent-a",
        message: updated,
      },
    ]);

    expect(state.agentContent["agent-a"]).toEqual({
      messages: [updated],
      status: "running",
    });
  });

  it("merges loaded agent content with loaded rows as canonical", () => {
    const liveMessage = assistantMessage(
      "agent-assistant-1",
      "live",
      "2026-07-01T12:00:02.000Z",
    );
    const loadedCanonicalMessage = assistantMessage(
      "agent-assistant-1",
      "loaded canonical",
      "2026-07-01T12:00:02.000Z",
    );
    const loadedMessage = assistantMessage(
      "agent-assistant-2",
      "loaded",
      "2026-07-01T12:00:03.000Z",
    );
    const liveOnlyMessage = assistantMessage(
      "agent-assistant-3",
      "live only",
      "2026-07-01T12:00:04.000Z",
    );
    const state = reduceSessionDetailActions([
      {
        type: "applyStreamSubagentMessage",
        agentId: "agent-a",
        message: liveMessage,
      },
      {
        type: "applyStreamSubagentMessage",
        agentId: "agent-a",
        message: liveOnlyMessage,
      },
      {
        type: "mergeLoadedAgentContent",
        agentId: "agent-a",
        content: {
          messages: [loadedCanonicalMessage, loadedMessage],
          status: "completed",
        },
      },
    ]);

    expect(state.agentContent["agent-a"]?.messages).toEqual([
      loadedCanonicalMessage,
      loadedMessage,
      liveOnlyMessage,
    ]);
    expect(state.agentContent["agent-a"]?.status).toBe("running");
  });

  it("updates agent context usage without replacing existing messages", () => {
    const liveMessage = assistantMessage(
      "agent-assistant-1",
      "live",
      "2026-07-01T12:00:02.000Z",
    );
    const contextUsage = { inputTokens: 1200, percentage: 24 };
    const state = reduceSessionDetailActions([
      {
        type: "applyStreamSubagentMessage",
        agentId: "agent-a",
        message: liveMessage,
      },
      {
        type: "updateAgentContextUsage",
        agentId: "agent-a",
        contextUsage,
      },
    ]);

    expect(state.agentContent["agent-a"]).toEqual({
      messages: [liveMessage],
      status: "running",
      contextUsage,
    });
  });

  it("creates a running agent entry for context usage received first", () => {
    const contextUsage = { inputTokens: 800, percentage: 16 };
    const state = reduceSessionDetailActions([
      {
        type: "updateAgentContextUsage",
        agentId: "agent-a",
        contextUsage,
      },
    ]);

    expect(state.agentContent["agent-a"]).toEqual({
      messages: [],
      status: "running",
      contextUsage,
    });
  });

  it("clears subagent streaming placeholders without replacing durable rows", () => {
    const durableMessage = assistantMessage(
      "agent-assistant-1",
      "durable",
      "2026-07-01T12:00:02.000Z",
    );
    const streamingMessage: Message = {
      ...assistantMessage(
        "agent-streaming",
        "partial",
        "2026-07-01T12:00:03.000Z",
      ),
      _isStreaming: true,
    };
    const state = reduceSessionDetailActions([
      {
        type: "mergeLoadedAgentContent",
        agentId: "agent-a",
        content: {
          messages: [durableMessage, streamingMessage],
          status: "running",
        },
      },
      {
        type: "clearAgentStreamingPlaceholders",
        agentId: "agent-a",
      },
    ]);

    expect(state.agentContent["agent-a"]).toEqual({
      messages: [durableMessage],
      status: "running",
    });
  });

  it("keeps an empty agent entry when clearing only streaming placeholders", () => {
    const streamingMessage: Message = {
      ...assistantMessage(
        "agent-streaming",
        "partial",
        "2026-07-01T12:00:02.000Z",
      ),
      _isStreaming: true,
    };
    const state = reduceSessionDetailActions([
      {
        type: "mergeLoadedAgentContent",
        agentId: "agent-a",
        content: {
          messages: [streamingMessage],
          status: "running",
          contextUsage: { inputTokens: 400, percentage: 8 },
        },
      },
      {
        type: "clearAgentStreamingPlaceholders",
        agentId: "agent-a",
      },
    ]);

    expect(state.agentContent["agent-a"]).toEqual({
      messages: [],
      status: "running",
      contextUsage: { inputTokens: 400, percentage: 8 },
    });
  });

  it("drops transient subagent streaming placeholders when streaming is disabled", () => {
    const streamingMessage: Message = {
      ...assistantMessage(
        "agent-streaming",
        "partial",
        "2026-07-01T12:00:02.000Z",
      ),
      _isStreaming: true,
    };
    const state = reduceSessionDetailActions([
      {
        type: "applyStreamSubagentMessage",
        agentId: "agent-a",
        message: streamingMessage,
      },
      {
        type: "applyStreamSubagentMessage",
        agentId: "agent-a",
        message: streamingMessage,
        streamingEnabled: false,
      },
    ]);

    expect(state.agentContent).toEqual({});
  });

  it("leaves retained scroll snapshots outside reducer state", () => {
    const scrollSnapshot = {
      atBottom: false,
      scrollTop: 240,
      scrollHeight: 1000,
      clientHeight: 600,
      anchor: {
        id: "assistant-1",
        topOffset: 42,
      },
      updatedAtMs: 1782910000000,
    };
    const loaded = reduceSessionDetailState(createInitialSessionDetailState(), {
      type: "loadPersistedTranscript",
      session: sessionMetadata(),
      messages: [
        assistantMessage("assistant-1", "loaded", "2026-07-01T12:00:00.000Z"),
      ],
      scrollSnapshot,
    });

    expect(loaded.messages).toHaveLength(1);
    expect(
      (loaded as { scrollSnapshot?: typeof scrollSnapshot }).scrollSnapshot,
    ).toBeUndefined();
  });
});

describe("claude queue-operation echo dedup", () => {
  const STEER = "please also update the docs";

  function steerEcho(uuid: string, timestamp: string): Message {
    return {
      type: "user",
      uuid,
      tempId: "temp-steer-1",
      timestamp,
      message: { role: "user", content: STEER },
    } as Message;
  }

  function queueOperationRow(id: string, timestamp: string): Message {
    return {
      id,
      type: "user",
      role: "user",
      content: STEER,
      timestamp,
      deferred: true,
      deferredSource: "queue-operation",
      message: { role: "user", content: STEER },
    } as Message;
  }

  it("collapses a busy-send echo with its durable queue-operation row", () => {
    const state = reduceSessionDetailActions(
      [
        {
          type: "applyStreamMessage",
          message: steerEcho("ya-queue-uuid", "2026-07-01T12:00:00.500Z"),
        },
        {
          type: "applyCatchupMessages",
          messages: [
            queueOperationRow(
              "queue-operation-10-2026-07-01T12:00:00.635Z",
              "2026-07-01T12:00:00.635Z",
            ),
          ],
        },
      ],
      {
        ...createInitialSessionDetailState(),
        session: sessionMetadata("claude"),
      },
    );

    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]?._source).toBe("jsonl");

    // A later fetch delivering the same durable row again must not
    // resurrect the duplicate: the merged copy keys on the row id.
    const refetched = reduceSessionDetailState(state, {
      type: "applyCatchupMessages",
      messages: [
        queueOperationRow(
          "queue-operation-10-2026-07-01T12:00:00.635Z",
          "2026-07-01T12:00:00.635Z",
        ),
      ],
    });
    expect(refetched.messages).toHaveLength(1);
  });

  it("collapses the replayed echo into an already-loaded durable row", () => {
    const state = reduceSessionDetailActions(
      [
        {
          type: "loadPersistedTranscript",
          session: sessionMetadata("claude"),
          messages: [
            queueOperationRow(
              "queue-operation-10-2026-07-01T12:00:00.635Z",
              "2026-07-01T12:00:00.635Z",
            ),
          ],
        },
        {
          type: "applyStreamMessage",
          message: {
            ...steerEcho("ya-queue-uuid", "2026-07-01T12:00:00.500Z"),
            isReplay: true,
          },
        },
      ],
      createInitialSessionDetailState(),
    );

    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]?._source).toBe("jsonl");
  });
});

describe("codex steer identity", () => {
  const STEER = "what does heartbeat 300 do?";

  function steerEcho(timestamp: string): Message {
    return {
      type: "user",
      uuid: "ya-steer-uuid",
      tempId: "temp-steer",
      timestamp,
      messageMetadata: { deliveryIntent: "steer" },
      message: { role: "user", content: STEER },
    } as Message;
  }

  function durableRow(timestamp: string): Message {
    return {
      type: "user",
      uuid: "ya-steer-uuid",
      timestamp,
      codexUserTurnProvenance: "paired",
      message: { role: "user", content: STEER },
    } as Message;
  }

  it("confirms a long-lived steer by its persisted client id", () => {
    const state = reduceSessionDetailActions(
      [
        {
          type: "applyStreamMessage",
          message: steerEcho("2026-07-23T03:10:00.000Z"),
        },
        {
          type: "applyCatchupMessages",
          messages: [durableRow("2026-07-23T03:19:08.210Z")],
        },
      ],
      {
        ...createInitialSessionDetailState(),
        session: sessionMetadata("codex"),
      },
    );

    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]?._source).toBe("jsonl");
    expect(state.messages[0]?.uuid).toBe("ya-steer-uuid");
    expect(state.messages[0]?.tempId).toBe("temp-steer");
  });

  it("keeps a sent steer across a stale tail replacement", () => {
    const beforeReplacement = reduceSessionDetailActions(
      [
        {
          type: "loadPersistedTranscript",
          session: sessionMetadata("codex"),
          messages: [
            userMessage("user-1", "start", "2026-07-23T03:09:00.000Z"),
          ],
        },
        {
          type: "applyStreamMessage",
          message: steerEcho("2026-07-23T03:10:00.000Z"),
        },
      ],
      createInitialSessionDetailState(),
    );

    const staleReplacement = reduceSessionDetailState(beforeReplacement, {
      type: "replaceTailWindow",
      session: sessionMetadata("codex"),
      messages: [
        userMessage("user-1", "start", "2026-07-23T03:09:00.000Z"),
        assistantMessage(
          "assistant-1",
          "still working",
          "2026-07-23T03:09:01.000Z",
        ),
      ],
    });

    expect(staleReplacement.messages).toHaveLength(3);
    expect(staleReplacement.messages.at(-1)).toMatchObject({
      uuid: "ya-steer-uuid",
      tempId: "temp-steer",
      _source: "sdk",
    });

    const confirmed = reduceSessionDetailState(staleReplacement, {
      type: "replaceTailWindow",
      session: sessionMetadata("codex"),
      messages: [
        userMessage("user-1", "start", "2026-07-23T03:09:00.000Z"),
        assistantMessage(
          "assistant-1",
          "still working",
          "2026-07-23T03:09:01.000Z",
        ),
        durableRow("2026-07-23T03:19:08.210Z"),
      ],
    });

    expect(confirmed.messages).toHaveLength(3);
    expect(confirmed.messages.at(-1)).toMatchObject({
      uuid: "ya-steer-uuid",
      _source: "jsonl",
    });
  });

  it("keeps an unmatched identical durable steer for an aligned server", () => {
    const state = reduceSessionDetailActions(
      [
        {
          type: "applyStreamMessage",

          message: steerEcho("2026-07-23T03:10:00.000Z"),
        },
        {
          type: "applyCatchupMessages",

          messages: [
            {
              ...durableRow("2026-07-23T03:10:00.000Z"),
              uuid: "distinct-provider-id",
            },
          ],
        },
      ],
      {
        ...createInitialSessionDetailState(),
        session: sessionMetadata("codex"),
      },
    );

    expect(state.messages.map((message) => message.uuid)).toEqual([
      "ya-steer-uuid",
      "distinct-provider-id",
    ]);
  });
});
