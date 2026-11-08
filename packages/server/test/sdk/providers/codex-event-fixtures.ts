import type { CodexLiveToolOutput } from "../../../src/sdk/providers/codex-live-event-conversion.js";

type CodexNotificationFixture = {
  method: string;
  params?: unknown;
};

type CodexExpectedSdkMessage = Record<string, unknown>;

export function createLiveEventState() {
  return {
    streamingTextByItemKey: new Map<string, string>(),
    streamingReasoningSummaryByItemKey: new Map<string, string[]>(),
    streamingToolOutputByItemKey: new Map<string, CodexLiveToolOutput>(),
    toolCallContexts: new Map<string, unknown>(),
    resultBackedToolItemsByTurnId: new Map<string, Set<string>>(),
    planUpdateCountByTurnId: new Map<string, number>(),
  };
}

export const codexAgentMessageDeltaFixtures = {
  firstNotification: {
    method: "item/agentMessage/delta",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "item-1",
      delta: "Hello",
    },
  },
  secondNotification: {
    method: "item/agentMessage/delta",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "item-1",
      delta: " world",
    },
  },
  expectedFirstMessage: {
    type: "assistant",
    session_id: "session-1",
    uuid: "item-1",
    _isStreaming: true,
    message: {
      role: "assistant",
      content: "Hello",
    },
  },
  expectedSecondMessage: {
    type: "assistant",
    session_id: "session-1",
    uuid: "item-1",
    _isStreaming: true,
    message: {
      role: "assistant",
      content: "Hello world",
    },
  },
} satisfies {
  firstNotification: CodexNotificationFixture;
  secondNotification: CodexNotificationFixture;
  expectedFirstMessage: CodexExpectedSdkMessage;
  expectedSecondMessage: CodexExpectedSdkMessage;
};

export const codexContextCompactionFixtures = {
  startedNotification: {
    method: "item/started",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      item: {
        id: "compact-1",
        type: "contextCompaction",
      },
    },
  },
  completedNotification: {
    method: "item/completed",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      item: {
        id: "compact-1",
        type: "contextCompaction",
      },
    },
  },
  expectedStartedMessage: {
    type: "system",
    subtype: "status",
    session_id: "session-1",
    uuid: "compact-1-turn-1",
    status: "compacting",
  },
  expectedCompletedMessage: {
    type: "system",
    subtype: "compact_boundary",
    session_id: "session-1",
    uuid: "compact-1-turn-1",
    content: "Context compacted",
  },
  rawResponseCompletedNotification: {
    method: "rawResponseItem/completed",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      item: {
        type: "compaction",
        encrypted_content: "opaque",
      },
    },
  },
  expectedRawResponseCompletedMessage: {
    type: "system",
    subtype: "compact_boundary",
    session_id: "session-1",
    uuid: "codex-compaction-turn-1",
    content: "Context compacted",
  },
} satisfies {
  startedNotification: CodexNotificationFixture;
  completedNotification: CodexNotificationFixture;
  expectedStartedMessage: CodexExpectedSdkMessage;
  expectedCompletedMessage: CodexExpectedSdkMessage;
  rawResponseCompletedNotification: CodexNotificationFixture;
  expectedRawResponseCompletedMessage: CodexExpectedSdkMessage;
};

export const codexInterruptedTurnFixtures = {
  notification: {
    method: "turn/completed",
    params: {
      threadId: "thread-1",
      turn: {
        id: "turn-1",
        items: [],
        status: "interrupted",
        error: null,
        startedAt: null,
        completedAt: 1_700_000_000,
        durationMs: null,
      },
    },
  },
  expectedMessage: {
    type: "system",
    subtype: "turn_aborted",
    session_id: "session-1",
    uuid: "codex-turn-interrupted-turn-1",
    content: "Conversation interrupted",
    reason: "interrupted",
    sourceEvent: "turn/completed",
    codexThreadId: "thread-1",
    codexTurnId: "turn-1",
    codexTurnStatus: "interrupted",
    timestamp: "2023-11-14T22:13:20.000Z",
  },
  expectedRenderMessage: {
    type: "system",
    subtype: "turn_aborted",
    content: "Conversation interrupted",
  },
} satisfies {
  notification: CodexNotificationFixture;
  expectedMessage: CodexExpectedSdkMessage;
  expectedRenderMessage: CodexExpectedSdkMessage;
};

export const codexRawFunctionCallFixtures = {
  toolUseNotification: {
    method: "rawResponseItem/completed",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      item: {
        type: "function_call",
        name: "exec_command",
        call_id: "call-1",
        arguments: '{"command":"pnpm lint"}',
      },
    },
  },
  toolResultNotification: {
    method: "rawResponseItem/completed",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      item: {
        type: "function_call_output",
        call_id: "call-1",
        output: "Process exited with code 0",
      },
    },
  },
  expectedToolUseMessage: {
    type: "assistant",
    session_id: "session-1",
    uuid: "call-1",
    message: {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "call-1",
          name: "Bash",
          input: {
            command: "pnpm lint",
          },
        },
      ],
    },
  },
  expectedToolResultMessage: {
    type: "user",
    session_id: "session-1",
    uuid: "call-1-result",
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "call-1",
          content: "Process exited with code 0",
        },
      ],
    },
  },
} satisfies {
  toolUseNotification: CodexNotificationFixture;
  toolResultNotification: CodexNotificationFixture;
  expectedToolUseMessage: CodexExpectedSdkMessage;
  expectedToolResultMessage: CodexExpectedSdkMessage;
};
