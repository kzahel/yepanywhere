import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { decodeSnapshot } from "../../shared/src/experimental/simple-client.generated.js";
import {
  loadCapture,
  replayLive,
  replayNative,
} from "./utils/captured-provider-replay.js";

import {
  prepareConversation,
  selectConversation,
  serializeConversationSnapshot,
} from "../src/experimental/conversation-projection.js";
import {
  getMessageId,
  type Message,
} from "@yep-anywhere/shared/transcript/message";

// Locked output fixtures are also consumed by the TypeScript/Kotlin decoders.
// Independent recording facts below guard against blessing a lossy projection.
describe("simple-client examples against production captured-provider replay", () => {
  it.each(["claude", "codex"])(
    "%s retains prose, activity counts and visible failure",
    async (provider) => {
      const capture = await loadCapture(`${provider}-basic-2026-09-12`);
      const { renderItems, messages } = await replayNative(capture);
      const snapshot = decodeSnapshot(
        await readFile(
          new URL(
            `../../shared/test/fixtures/simple-client/${provider}-conversation.json`,
            import.meta.url,
          ),
          "utf8",
        ),
      );
      if (snapshot.view.kind !== "conversation")
        throw new Error("Expected conversation example");
      const prepared = prepareConversation({
        sessionId: capture.manifest.sessionId,
        messages,
        activity: "idle",
        pendingRequests: [],
        sourceCoverage: { earlierOutsideScope: "no", complete: true },
      });
      const projected = selectConversation(
        prepared,
        {
          sessionId: capture.manifest.sessionId,
          maxMessages: 20,
          anchorMessageId: null,
        },
        { subscriptionId: "fixture-subscription", sequence: 0 },
      );
      expect(JSON.parse(serializeConversationSnapshot(projected))).toEqual(
        snapshot,
      );
      if (provider === "claude") {
        const tail = selectConversation(
          prepared,
          {
            sessionId: capture.manifest.sessionId,
            maxMessages: 2,
            anchorMessageId: null,
          },
          { subscriptionId: "fixture-tail", sequence: 0 },
        );
        expect(JSON.parse(serializeConversationSnapshot(tail))).toEqual(
          JSON.parse(
            await readFile(
              new URL(
                "../../shared/test/fixtures/simple-client/claude-tail.json",
                import.meta.url,
              ),
              "utf8",
            ),
          ),
        );
      }
      const view = snapshot.view;
      expect(view.sessionId).toBe(capture.manifest.sessionId);
      const users = renderItems.filter((item) => item.type === "user_prompt");
      expect(
        view.messages
          .filter((message) => message.role === "user")
          .map((message) => message.id),
      ).toEqual(users.map((user) => user.id));
      expect(
        view.messages
          .filter((message) => message.role === "user")
          .flatMap((message) =>
            message.content.filter((c) => c.kind === "text").map((c) => c.text),
          ),
      ).toEqual(capture.manifest.requests.map((request) => request.message));
      const agents = view.messages.filter(
        (message) => message.role === "agent",
      );
      expect(agents.map((message) => message.id)).toEqual(
        users.map((user) => `agent:${user.id}`),
      );
      expect(
        agents.flatMap((message) =>
          message.content.filter((c) => c.kind === "text").map((c) => c.text),
        ),
      ).toEqual(
        renderItems
          .filter((item) => item.type === "text")
          .map((item) => item.text),
      );
      const activities = agents.flatMap((message) =>
        message.content.filter((c) => c.kind === "activity"),
      );
      const tools = renderItems.filter((item) => item.type === "tool_call");
      expect(activities.map((activity) => activity.toolCount)).toEqual([4, 1]);
      expect(
        activities.reduce((count, activity) => count + activity.toolCount, 0),
      ).toBe(tools.length);
      const failures = agents.flatMap((message) =>
        message.content.filter((c) => c.kind === "failure"),
      );
      const failed = tools.filter((item) => item.status === "error");
      expect(failures).toHaveLength(failed.length);
      for (const [index, failure] of failures.entries()) {
        expect(failure.toolName).toBe(failed[index]?.toolName);
        expect(failed[index]?.toolResult?.content).toContain(failure.message);
        expect(failure.exitCode).toBe(7);
        expect(failed[index]?.toolResult?.structured).toMatchObject({
          exitCode: failure.exitCode,
        });
      }
    },
  );
});

describe("captured adapter snapshots with declared user submissions", () => {
  it.each(["claude", "codex"])(
    "%s keeps grouped identities and conversation facts across native/adapter paths",
    async (provider) => {
      const capture = await loadCapture(`${provider}-basic-2026-09-12`);
      const native = await replayNative(capture);
      const live = await replayLive(capture);
      const users = native.renderItems
        .filter((row) => row.type === "user_prompt")
        .map((row) => row.sourceMessages[0]!);
      // Provider adapter logs omit the YA input queue. Supply the recorded native
      // user identities at these two declared request boundaries. This is fixture
      // assembly, not evidence for a live service's input-queue reconciliation.
      const split =
        provider === "claude"
          ? live.messages.findIndex(
              (m, index) =>
                index > 0 && m.type === "system" && m.subtype === "init",
            )
          : live.messages.findIndex(
              (m) => m.type === "system" && m.subtype === "turn_complete",
            ) + 1;
      expect(split).toBeGreaterThan(0);
      const snapshots = [
        users[0]!,
        ...live.messages.slice(0, split),
        users[1]!,
        ...live.messages.slice(split),
      ];
      // Adapter notifications contain repeated authoritative snapshots. The input
      // contract expects one current normalized record per ID, in original order.
      const current = new Map<string, Message>();
      for (const message of snapshots)
        current.set(getMessageId(message), message);
      const project = (messages: Message[]) =>
        selectConversation(
          prepareConversation({
            sessionId: capture.manifest.sessionId,
            messages,
            activity: "idle",
            pendingRequests: [],
            sourceCoverage: { earlierOutsideScope: "no", complete: true },
          }),
          {
            sessionId: capture.manifest.sessionId,
            maxMessages: 20,
            anchorMessageId: null,
          },
          { subscriptionId: "captured", sequence: 0 },
        );
      const a = project(native.messages).view;
      const encoded = serializeConversationSnapshot(
        project([...current.values()]),
      );
      const b = decodeSnapshot(encoded).view;
      if (a.kind !== "conversation" || b.kind !== "conversation")
        throw new Error(JSON.stringify({ a, b }));
      expect(b.messages.map((m) => m.id)).toEqual(a.messages.map((m) => m.id));
      const prose = (messages: typeof a.messages) =>
        messages.flatMap((m) =>
          m.content.filter((c) => c.kind === "text").map((c) => c.text),
        );
      expect(prose(b.messages)).toEqual(prose(a.messages));
      expect(b.messages.map((m) => m.state)).toEqual(
        a.messages.map((m) => m.state),
      );
      const activities = b.messages.flatMap((m) =>
        m.content.filter((c) => c.kind === "activity"),
      );
      expect(activities.map((c) => c.toolCount)).toEqual([4, 1]);
      const failures = b.messages.flatMap((m) =>
        m.content.filter((c) => c.kind === "failure"),
      );
      expect(failures).toHaveLength(1);
      expect(failures[0]!.message).toContain("FIXTURE_FAILURE");
      expect(failures[0]!.exitCode).toBe(7);
    },
  );
});
