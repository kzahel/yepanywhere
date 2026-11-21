import { describe, expect, it } from "vitest";
import { toUrlProjectId } from "@yep-anywhere/shared";
import { compileTranscriptProjection } from "@yep-anywhere/shared/transcript/compiler";
import type { Message, SessionMetadata } from "../../../types";
import { projectConversationView } from "../conversationView";
import { groupRenderItemsIntoTurns } from "../renderItems";
import { buildVisibleTimelineEntries } from "../timeline";
import { reduceSessionDetailActions } from "../transcriptReducer";
import type { SessionDetailAction, SessionDetailState } from "../types";

const time = "2026-09-15T05:00:00.000Z";
const earlier = "2026-09-15T04:00:00.000Z";
const later = "2026-09-15T06:00:00.000Z";

function message(uuid: string, role: "user" | "assistant"): Message {
  return {
    uuid,
    type: role,
    timestamp: time,
    message: { role, content: role === "user" ? "Repeat this prompt" : uuid },
  };
}

function stream(
  message: Message,
  fromBufferedReplay?: boolean,
): SessionDetailAction {
  return { type: "applyStreamMessage", message, fromBufferedReplay };
}

function runTranscript(
  provider: SessionMetadata["provider"],
  messages: Message[],
  ...actions: SessionDetailAction[]
): SessionDetailState {
  return reduceSessionDetailActions([
    {
      type: "loadPersistedTranscript",
      session: {
        id: "session-1",
        projectId: toUrlProjectId("/project-1"),
        provider,
        title: "Catch-up order",
        fullTitle: "Catch-up order",
        ownership: { owner: "none" },
        createdAt: time,
        updatedAt: time,
        messageCount: messages.length,
      },
      messages,
    },
    ...actions,
  ]);
}

function expectTranscriptOrder(state: SessionDetailState, ids: string[]) {
  expect(state.messages.map((entry) => entry.uuid)).toEqual(ids);
  const projected = projectConversationView(
    compileTranscriptProjection(state.messages),
    { active: true, nowMs: Date.parse(time) },
  );
  const timeline = buildVisibleTimelineEntries({
    turnGroups: groupRenderItemsIntoTurns(projected),
  });
  expect(
    timeline.flatMap((entry) =>
      entry.kind === "turn"
        ? entry.group.items.map((item) => item.sourceMessages[0]?.uuid)
        : [],
    ),
  ).toEqual(ids);
}

describe.each(["codex", "antigravity", "grok"] as const)(
  "%s durable transcript order",
  (provider) => {
    it.each(["equal", "split", "untimed", "mixed"])(
      "places missed prompts before a streamed reply with %s catch-up",
      (delivery) => {
        const prefix = message("prefix", "user");
        const first = message("user-1", "user");
        const second = message("user-2", "user");
        const reply = message("reply", "assistant");
        const liveTail = message("live-tail", "assistant");
        if (delivery === "split") {
          first.timestamp = "2026-09-15T05:00:01.000Z";
          second.timestamp = "2026-09-15T05:00:02.000Z";
          reply.timestamp = "2026-09-15T05:00:03.000Z";
          liveTail.timestamp = "2026-09-15T05:00:04.000Z";
        }
        if (delivery === "untimed") {
          for (const row of [prefix, first, second, reply, liveTail]) {
            row.timestamp = undefined;
          }
        }
        if (delivery === "mixed") {
          prefix.timestamp = undefined;
          first.timestamp = later;
          reply.timestamp = earlier;
        }
        const durable = [first, second, reply];
        const batches =
          delivery === "split" ? durable.map((row) => [row]) : [durable];
        const state = runTranscript(
          provider,
          [prefix],
          stream(reply),
          stream(liveTail),
          ...batches.map(
            (messages): SessionDetailAction => ({
              type: "applyCatchupMessages",
              messages,
            }),
          ),
        );
        expectTranscriptOrder(state, [
          "prefix",
          "user-1",
          "user-2",
          "reply",
          "live-tail",
        ]);
        expect(state.lastMessageId).toBe("reply");
        expect(state.messages.at(-1)).toMatchObject({ _source: "sdk" });
        const restored = runTranscript(provider, [prefix, ...durable]);
        expect(state.messages.filter((row) => row._source === "jsonl")).toEqual(
          restored.messages,
        );
      },
    );

    it("preserves intervening durable rows during an overlapping refresh", () => {
      const messages = [
        message("prefix", "user"),
        message("first", "assistant"),
        message("between", "user"),
        message("last", "assistant"),
      ];
      const state = runTranscript(provider, messages, {
        type: "applyCatchupMessages",
        messages: [messages[1]!, messages[3]!],
      });
      expectTranscriptOrder(state, ["prefix", "first", "between", "last"]);
    });

    it("keeps undated older pages ahead of the dated live tail", () => {
      const prompt = message("prompt", "user");
      const reply = message("reply", "assistant");
      const state = runTranscript(provider, [prompt], stream(reply), {
        type: "prependOlderMessages",
        messages: [
          { ...message("old-prompt", "user"), timestamp: undefined },
          { ...message("old-reply", "assistant"), timestamp: undefined },
          prompt,
        ],
      });
      expectTranscriptOrder(state, [
        "old-prompt",
        "old-reply",
        "prompt",
        "reply",
      ]);
      expect(state.lastMessageId).toBe("prompt");
    });
  },
);

describe.each(["codex", "antigravity"] as const)(
  "%s durable replay identity",
  (provider) => {
    it("reconciles reconnect replay by shared identity despite receipt timestamps", () => {
      const first: Message = {
        ...message("first", "assistant"),
        message: { role: "assistant", content: "Still working" },
      };
      const next = { ...first, uuid: "next" };
      const state = runTranscript(
        provider,
        [first],
        stream({ ...first, timestamp: later, isReplay: true }, true),
        stream({ ...next, isReplay: true }, true),
        stream({ ...next, isReplay: true }, true),
      );
      expectTranscriptOrder(state, ["first", "next"]);
      expect(state.messages[0]).toMatchObject({
        _source: "jsonl",
        timestamp: time,
      });
      expect(state.lastMessageId).toBe("first");
    });
  },
);

it("suppresses a replayed Grok prompt whose native row has a different ID", () => {
  const durablePrompt = message("grok-evt-prompt", "user");
  const reply = { ...message("grok-evt-reply", "assistant"), timestamp: later };
  const state = runTranscript(
    "grok",
    [durablePrompt, reply],
    stream({ ...durablePrompt, uuid: "ya-prompt", isReplay: true }, true),
  );
  expectTranscriptOrder(state, ["grok-evt-prompt", "grok-evt-reply"]);
});

it("places a confirmed Grok self-send before its streamed reply", () => {
  const prompt = message("grok-evt-prompt", "user");
  const reply = message("grok-evt-reply", "assistant");
  const state = runTranscript(
    "grok",
    [],
    stream({ ...prompt, uuid: "ya-prompt", tempId: "temp-prompt" }),
    stream(reply),
    { type: "applyCatchupMessages", messages: [prompt, reply] },
  );
  expectTranscriptOrder(state, ["grok-evt-prompt", "grok-evt-reply"]);
  expect(state.messages[0]).toMatchObject({ tempId: "temp-prompt" });
});

it("uses Claude's parent chain when a child arrives before its parent", () => {
  const prompt = { ...message("prompt", "user"), timestamp: later };
  const reply = {
    ...message("reply", "assistant"),
    parentUuid: "prompt",
    timestamp: earlier,
  };
  const state = runTranscript(
    "claude",
    [],
    stream({
      ...reply,
      parentUuid: undefined,
    }),
    {
      type: "applyCatchupMessages",
      messages: [prompt, reply],
    },
  );
  expectTranscriptOrder(state, ["prompt", "reply"]);
});
