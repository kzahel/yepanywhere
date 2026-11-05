import {
  CODEX_TOOL_CORRELATION_FIELD,
  createCodexToolCorrelation,
  type ToolDisplayAction,
} from "@yep-anywhere/shared";
import { describe, expect, it } from "vitest";
import observedBash from "./fixtures/codex-bash-native.json";
import type { Message, SessionMetadata } from "../../types";
import { reconcileCodexToolMessages } from "../codexToolReconciliation";
import {
  createInitialSessionDetailState,
  reduceSessionDetailActions,
  reduceSessionDetailState,
} from "../sessionDetail/transcriptReducer";

const TURN_ID = "turn-sanitized-code-mode";
const COMMAND =
  "sed -n '1,20p' docs/one.md && " +
  "sed -n '21,40p' docs/one.md && " +
  "sed -n '1,30p' docs/two.md";
const DISPLAY_ACTIONS: ToolDisplayAction[] = [
  {
    kind: "read",
    path: "docs/one.md",
    absolutePath: "/workspace/docs/one.md",
    name: "one.md",
    startLine: 1,
    endLine: 20,
  },
  {
    kind: "read",
    path: "docs/one.md",
    absolutePath: "/workspace/docs/one.md",
    name: "one.md",
    startLine: 21,
    endLine: 40,
  },
  {
    kind: "read",
    path: "docs/two.md",
    absolutePath: "/workspace/docs/two.md",
    name: "two.md",
    startLine: 1,
    endLine: 30,
  },
];

const session = {
  id: "codex-code-mode-correlation",
  projectId: "project-sanitized",
  provider: "codex",
  title: "Sanitized code-mode correlation",
  fullTitle: "Sanitized code-mode correlation",
  createdAt: "2026-07-10T07:52:00.000Z",
  updatedAt: "2026-07-10T07:52:05.000Z",
  messageCount: 2,
  ownership: { owner: "none" },
} as SessionMetadata;

function toolUseMessage(options: {
  id: string;
  origin: "command_execution" | "custom_tool_call";
  timestamp: string;
  turnId?: string;
  command?: string;
  startedAt?: string;
}): Message {
  const content = [
    {
      type: "tool_use" as const,
      id: options.id,
      name: "Bash",
      input: {
        command: options.command ?? COMMAND,
        cwd: "/workspace",
      },
      _displayActions: DISPLAY_ACTIONS,
    },
  ];
  return {
    uuid: options.id,
    type: "assistant",
    timestamp: options.timestamp,
    message: { role: "assistant", content },
    [CODEX_TOOL_CORRELATION_FIELD]: createCodexToolCorrelation(
      options.origin,
      options.turnId ?? TURN_ID,
      options.id,
      options.startedAt,
    ),
  } as Message;
}

function toolResultMessage(options: {
  id: string;
  origin: "command_execution" | "custom_tool_call";
  timestamp: string;
  content: string;
  startedAt?: string;
}): Message {
  const content = [
    {
      type: "tool_result" as const,
      tool_use_id: options.id,
      content: options.content,
    },
  ];
  return {
    uuid: `${options.id}-result`,
    type: "user",
    timestamp: options.timestamp,
    message: { role: "user", content },
    [CODEX_TOOL_CORRELATION_FIELD]: createCodexToolCorrelation(
      options.origin,
      TURN_ID,
      options.id,
      options.startedAt,
    ),
  } as Message;
}

function planMessage(options: {
  id: string;
  kind: "use" | "result";
  origin: "plan_update" | "custom_tool_call" | "function_call";
  source: "sdk" | "jsonl";
  timestamp: string;
}): Message {
  const block =
    options.kind === "use"
      ? {
          type: "tool_use" as const,
          id: options.id,
          name: "UpdatePlan",
          input: {
            plan: [
              { step: "Read the contracts", status: "in_progress" },
              { step: "Implement the fix", status: "pending" },
            ],
          },
        }
      : {
          type: "tool_result" as const,
          tool_use_id: options.id,
          content: "Plan updated",
        };
  return {
    uuid: options.kind === "use" ? options.id : `${options.id}-result`,
    type: options.kind === "use" ? "assistant" : "user",
    timestamp: options.timestamp,
    message: {
      role: options.kind === "use" ? "assistant" : "user",
      content: [block],
    },
    _source: options.source,
    [CODEX_TOOL_CORRELATION_FIELD]: createCodexToolCorrelation(
      options.origin,
      TURN_ID,
      options.id,
    ),
  } as Message;
}

function firstContentBlock(message: Message | undefined) {
  const content = message?.message?.content;
  return Array.isArray(content) ? content[0] : undefined;
}

describe("Codex tool reconciliation", () => {
  it("adopts the actual native Bash wrapper and rollout input aliases without leaving a pending parent", () => {
    const live = observedBash.live as unknown as Message[];
    const durable = observedBash.durable as unknown as Message[];
    const active = reduceSessionDetailActions(
      live.map((message) => ({ type: "applyStreamMessage" as const, message })),
      { ...createInitialSessionDetailState(), session },
    );
    expect(active.messages).toHaveLength(2);
    const settled = reduceSessionDetailState(active, {
      type: "applyCatchupMessages",
      messages: durable,
    });
    expect(settled.messages.map((message) => message.uuid)).toEqual([
      "call_owned_command",
      "call_owned_command-result",
    ]);
    const late = reduceSessionDetailActions(
      live
        .slice(-2)
        .map((message) => ({ type: "applyStreamMessage" as const, message })),
      settled,
    );
    expect(late.messages).toHaveLength(2);
    expect(late.messages.every((message) => message._source === "jsonl")).toBe(
      true,
    );
    expect(firstContentBlock(late.messages[1])).toMatchObject({
      type: "tool_result",
      tool_use_id: "call_owned_command",
    });
  });

  it.each([
    ["different working directory", { workdir: "/another/project" }],
    ["unobserved execution settings", { env: { MODE: "different" } }],
    ["conflicting command aliases", { cmd: "echo a different command" }],
    ["explicit durable shell invocation", {}],
  ])("does not correlate Bash with %s", (_label, changes) => {
    const live = observedBash.live[0] as unknown as Message;
    const durable = JSON.parse(
      JSON.stringify(observedBash.durable[0]),
    ) as Message;
    const content = durable.message?.content;
    if (!Array.isArray(content) || content[0]?.type !== "tool_use")
      throw Error("Expected the captured native tool parent");
    content[0].input = {
      ...(content[0].input as Record<string, unknown>),
      ...changes,
    };
    if (_label === "explicit durable shell invocation") {
      const native = firstContentBlock(live);
      if (native?.type !== "tool_use") throw Error("Expected native wrapper");
      const command = (native.input as Record<string, unknown>).command;
      content[0].input = {
        ...(content[0].input as Record<string, unknown>),
        cmd: command,
        command,
      };
    }
    expect(reconcileCodexToolMessages([live, durable])).toEqual([
      live,
      durable,
    ]);
  });

  it("adopts one durable parent and result across started, completed, and rollout", () => {
    const liveId = "exec-sanitized-three-reads";
    const durableId = "call_sanitized_three_reads";
    const liveStarted = toolUseMessage({
      id: liveId,
      origin: "command_execution",
      timestamp: "2026-07-10T07:52:03.910Z",
      startedAt: "2026-07-10T07:52:03.910Z",
    });
    const liveCompleted = toolUseMessage({
      id: liveId,
      origin: "command_execution",
      timestamp: "2026-07-10T07:53:04.720Z",
      startedAt: "2026-07-10T07:52:03.910Z",
    });
    const liveResult = toolResultMessage({
      id: liveId,
      origin: "command_execution",
      timestamp: "2026-07-10T07:53:04.720Z",
      content: "combined output\n",
      startedAt: "2026-07-10T07:52:03.910Z",
    });
    const durableParent = toolUseMessage({
      id: durableId,
      origin: "custom_tool_call",
      timestamp: "2026-07-10T07:52:03.749Z",
    });
    const durableResult = toolResultMessage({
      id: durableId,
      origin: "custom_tool_call",
      timestamp: "2026-07-10T07:52:04.739Z",
      content: "combined output\n",
    });

    const liveState = reduceSessionDetailActions(
      [
        { type: "applyStreamMessage", message: liveStarted },
        { type: "applyStreamMessage", message: liveCompleted },
        { type: "applyStreamMessage", message: liveResult },
      ],
      { ...createInitialSessionDetailState(), session },
    );
    expect(liveState.messages).toHaveLength(2);
    expect(liveState.messages.map((message) => message.uuid)).toEqual([
      liveId,
      `${liveId}-result`,
    ]);

    const parentBackfilled = reduceSessionDetailState(liveState, {
      type: "applyCatchupMessages",
      messages: [durableParent],
    });
    expect(parentBackfilled.messages).toHaveLength(2);
    expect(parentBackfilled.messages.map((message) => message.uuid)).toEqual([
      durableId,
      `${durableId}-result`,
    ]);
    expect(parentBackfilled.messages[0]?._source).toBe("jsonl");
    expect(parentBackfilled.messages[1]?._source).toBe("sdk");
    expect(firstContentBlock(parentBackfilled.messages[0])).toMatchObject({
      type: "tool_use",
      id: durableId,
      _displayActions: DISPLAY_ACTIONS,
    });
    expect(firstContentBlock(parentBackfilled.messages[1])).toMatchObject({
      type: "tool_result",
      tool_use_id: durableId,
    });

    const streamedAfterBackfill = reduceSessionDetailState(parentBackfilled, {
      type: "applyStreamMessage",
      message: toolResultMessage({
        id: liveId,
        origin: "command_execution",
        timestamp: "2026-07-10T07:52:04.730Z",
        content: "combined output still streaming\n",
      }),
    });
    expect(streamedAfterBackfill.messages).toHaveLength(2);
    expect(streamedAfterBackfill.messages[1]?.uuid).toBe(`${durableId}-result`);
    expect(firstContentBlock(streamedAfterBackfill.messages[1])).toMatchObject({
      type: "tool_result",
      tool_use_id: durableId,
      content: "combined output still streaming\n",
    });

    const settled = reduceSessionDetailState(streamedAfterBackfill, {
      type: "applyCatchupMessages",
      messages: [durableResult],
    });
    expect(settled.messages).toHaveLength(2);
    expect(
      settled.messages.every((message) => message._source === "jsonl"),
    ).toBe(true);

    const lateLiveCompletion = reduceSessionDetailState(settled, {
      type: "applyStreamMessage",
      message: liveCompleted,
    });
    expect(lateLiveCompletion.messages).toHaveLength(2);
    expect(lateLiveCompletion.messages.map((message) => message.uuid)).toEqual([
      durableId,
      `${durableId}-result`,
    ]);
    expect(
      lateLiveCompletion.messages.every(
        (message) => message._source === "jsonl",
      ),
    ).toBe(true);
  });

  it("pairs repeated identical calls one-to-one by nearest timestamp", () => {
    const messages = reconcileCodexToolMessages([
      {
        ...toolUseMessage({
          id: "exec-first",
          origin: "command_execution",
          timestamp: "2026-07-10T07:52:01.100Z",
        }),
        _source: "sdk",
      },
      {
        ...toolUseMessage({
          id: "exec-second",
          origin: "command_execution",
          timestamp: "2026-07-10T07:52:03.100Z",
        }),
        _source: "sdk",
      },
      {
        ...toolUseMessage({
          id: "call_first",
          origin: "custom_tool_call",
          timestamp: "2026-07-10T07:52:01.000Z",
        }),
        _source: "jsonl",
      },
      {
        ...toolUseMessage({
          id: "call_second",
          origin: "custom_tool_call",
          timestamp: "2026-07-10T07:52:03.000Z",
        }),
        _source: "jsonl",
      },
    ]);

    expect(messages).toHaveLength(2);
    expect(messages.map((message) => message.uuid)).toEqual([
      "call_first",
      "call_second",
    ]);
    expect(messages.every((message) => message._source === "jsonl")).toBe(true);
  });

  it.each(["custom_tool_call", "function_call"] as const)(
    "adopts durable ids when a live plan update is backfilled from %s",
    (durableOrigin) => {
      const liveId = "codex-plan-turn-1-1";
      const durableId = "call_durable_plan";
      const messages = reconcileCodexToolMessages([
        planMessage({
          id: liveId,
          kind: "use",
          origin: "plan_update",
          source: "sdk",
          timestamp: "2026-08-02T21:31:20.960Z",
        }),
        planMessage({
          id: liveId,
          kind: "result",
          origin: "plan_update",
          source: "sdk",
          timestamp: "2026-08-02T21:31:20.960Z",
        }),
        planMessage({
          id: durableId,
          kind: "use",
          origin: durableOrigin,
          source: "jsonl",
          timestamp: "2026-08-02T21:31:20.958Z",
        }),
        planMessage({
          id: durableId,
          kind: "result",
          origin: durableOrigin,
          source: "jsonl",
          timestamp: "2026-08-02T21:31:21.077Z",
        }),
      ]);

      expect(messages).toHaveLength(2);
      expect(messages.map((message) => message.uuid)).toEqual([
        durableId,
        `${durableId}-result`,
      ]);
      expect(messages.every((message) => message._source === "jsonl")).toBe(
        true,
      );
    },
  );

  it("leaves non-equivalent or cross-turn commands untouched", () => {
    const live = {
      ...toolUseMessage({
        id: "exec-unmatched",
        origin: "command_execution",
        timestamp: "2026-07-10T07:52:01.100Z",
      }),
      _source: "sdk" as const,
    };
    const differentTurn = {
      ...toolUseMessage({
        id: "call-other-turn",
        origin: "custom_tool_call",
        timestamp: "2026-07-10T07:52:01.000Z",
        turnId: "turn-other",
      }),
      _source: "jsonl" as const,
    };
    const differentCommand = {
      ...toolUseMessage({
        id: "call-other-command",
        origin: "custom_tool_call",
        timestamp: "2026-07-10T07:52:01.000Z",
        command: "git status --short",
      }),
      _source: "jsonl" as const,
    };

    expect(
      reconcileCodexToolMessages([live, differentTurn, differentCommand]),
    ).toEqual([live, differentTurn, differentCommand]);
  });
});
