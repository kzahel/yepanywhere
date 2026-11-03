import { describe, expect, it } from "vitest";
import { toUrlProjectId } from "@yep-anywhere/shared";
import { compileTranscriptProjection } from "@yep-anywhere/shared/transcript/compiler";
import type { Message, SessionMetadata } from "../../../types";
import { projectConversationView } from "../conversationView";
import {
  createInitialSessionDetailState,
  reduceSessionDetailState,
} from "../transcriptReducer";

const session: SessionMetadata = {
  id: "session-1",
  projectId: toUrlProjectId("/project-1"),
  provider: "codex",
  title: "Catch-up order",
  fullTitle: "Catch-up order",
  ownership: { owner: "none" },
  createdAt: "2026-09-15T05:00:00.000Z",
  updatedAt: "2026-09-15T05:00:00.000Z",
  messageCount: 0,
};

function message(uuid: string, role: "user" | "assistant"): Message {
  return {
    uuid,
    type: role,
    timestamp: "2026-09-15T05:00:00.000Z",
    message: { role, content: role === "user" ? "Repeat this prompt" : uuid },
  };
}

describe("Codex durable catch-up order", () => {
  it("keeps native Antigravity history before a live tail that arrived first", () => {
    const initial = message("native-user", "user");
    const reply = message("native-reply", "assistant");
    const next = message("next-turn", "user");
    for (const entry of [initial, reply, next]) entry.timestamp = undefined;
    let state = reduceSessionDetailState(createInitialSessionDetailState(), {
      type: "loadPersistedTranscript",
      session: { ...session, provider: "antigravity" },
      messages: [],
    });
    state = reduceSessionDetailState(state, {
      type: "applyStreamMessage",
      message: next,
    });
    state = reduceSessionDetailState(state, {
      type: "applyCatchupMessages",
      messages: [initial, reply, next],
    });
    expect(state.messages.map((entry) => entry.uuid)).toEqual([
      "native-user",
      "native-reply",
      "next-turn",
    ]);
  });
  it("preserves durable rows omitted from an overlapping refresh", () => {
    const messages = [
      message("prefix", "user"),
      message("first", "assistant"),
      message("between", "user"),
      message("last", "assistant"),
    ];
    const loaded = reduceSessionDetailState(createInitialSessionDetailState(), {
      type: "loadPersistedTranscript",
      session,
      messages,
    });
    const refreshed = reduceSessionDetailState(loaded, {
      type: "applyCatchupMessages",
      messages: [messages[1]!, messages[3]!],
    });
    expect(refreshed.messages).toEqual(loaded.messages);
  });

  it.each(["batch", "split", "untimed"])(
    "places missed user turns before the streamed reply with %s catch-up",
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
      const durable = [first, second, reply];
      let state = reduceSessionDetailState(createInitialSessionDetailState(), {
        type: "loadPersistedTranscript",
        session,
        messages: [prefix],
      });
      for (const incoming of [reply, liveTail]) {
        state = reduceSessionDetailState(state, {
          type: "applyStreamMessage",
          message: incoming,
        });
      }
      const batches =
        delivery === "split" ? durable.map((m) => [m]) : [durable];
      for (const batch of batches) {
        state = reduceSessionDetailState(state, {
          type: "applyCatchupMessages",
          messages: batch,
        });
      }
      expect(state.messages.map((m) => m.uuid)).toEqual([
        "prefix",
        "user-1",
        "user-2",
        "reply",
        "live-tail",
      ]);
      expect(state.lastMessageId).toBe("reply");
      expect(state.messages.at(-1)).toMatchObject({ _source: "sdk" });
      const projected = projectConversationView(
        compileTranscriptProjection(state.messages),
        { active: true, nowMs: Date.parse(session.updatedAt) },
      );
      expect(
        projected
          .filter((item) => item.type === "user_prompt")
          .map((item) => item.sourceMessages[0]?.uuid),
      ).toEqual(["prefix", "user-1", "user-2"]);
      const restored = reduceSessionDetailState(
        createInitialSessionDetailState(),
        {
          type: "loadPersistedTranscript",
          session,
          messages: [prefix, ...durable],
        },
      );
      expect(state.messages.filter((m) => m._source === "jsonl")).toEqual(
        restored.messages,
      );
    },
  );
});
