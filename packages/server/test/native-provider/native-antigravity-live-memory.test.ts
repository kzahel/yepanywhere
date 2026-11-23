import { createReadStream } from "node:fs";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { toUrlProjectId } from "@yep-anywhere/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { antigravityLiveHistory } from "../../src/sdk/providers/antigravity-owners.js";
import { prepareQueuedCompaction } from "../../src/routes/session-input-admission.js";
import {
  antigravityLogLines,
  projectAntigravityLog,
} from "../../src/sessions/antigravity-log-projection.js";
import { AntigravitySessionReader } from "../../src/sessions/antigravity-reader.js";
import type { Message } from "../../src/supervisor/types.js";
import { nativeFixture } from "./fixture.js";
import { providers } from "./selection.js";

let fixture: Awaited<ReturnType<typeof nativeFixture>> | undefined;
afterEach(async () => {
  await fixture?.close();
  fixture = undefined;
});

const call = (name: string, args: Record<string, unknown>) => ({
  functionCall: { name, args },
});

/**
 * The user and assistant prose a view shows, in order. Tool rows and
 * thinking are left out: the live view shows ACP's tool titles and output
 * where the log shows `agy`'s names and rendered results, a stated
 * difference (topics/antigravity.md#live-memory).
 */
function prose(messages: readonly Message[]): string[] {
  return messages.flatMap((message) => {
    if (message.type !== "user" && message.type !== "assistant") return [];
    const content = message.message?.content;
    if (typeof content === "string")
      return content.trim() ? [content.trim()] : [];
    return (content ?? []).flatMap((block) => {
      const text = block.type === "text" ? (block.text ?? "").trim() : "";
      return text ? [text] : [];
    });
  });
}

describe.skipIf(!providers.includes("antigravity"))(
  "native Antigravity live memory",
  () => {
    it("shows the same rows in order during a turn, after it ends, after it moves to the log, and once stopped", async () => {
      const f = await nativeFixture("antigravity");
      fixture = f;
      const id = f.nativeId;
      // Known once agy has created the conversation.
      let scope = "";
      const logPath = () =>
        join(
          f.environment.GEMINI_HOME!,
          "antigravity-cli",
          "brain",
          id(),
          ".system_generated",
          "logs",
          "transcript_full.jsonl",
        );
      const viewer = new AntigravitySessionReader({ projectPath: f.project });
      const projectId = toUrlProjectId(f.project);
      const messagesOf = async (
        options?: Parameters<AntigravitySessionReader["getSession"]>[3],
      ) => {
        const loaded = await viewer.getSession(
          id(),
          projectId,
          undefined,
          options,
        );
        expect(loaded?.transcriptComplete).not.toBe(false);
        return (loaded!.data.session as { messages: Message[] }).messages;
      };
      const whole = () => messagesOf();
      const latest = () => messagesOf({ tailCompactions: 1 });
      const logged = async () => {
        const result = await projectAntigravityLog(
          antigravityLogLines(createReadStream(logPath())),
          { conversationId: id(), ownerLive: false },
        );
        if (result.status !== "known") throw Error(result.reason);
        return result.messages;
      };
      const moved = () =>
        vi.waitFor(
          () => expect(antigravityLiveHistory(scope, id())).toEqual([]),
          { timeout: 5_000 },
        );
      const unique = (messages: readonly Message[]) =>
        expect(new Set(messages.map((m) => m.uuid)).size).toBe(messages.length);
      try {
        // A tool-heavy turn, read while its reply streams.
        let request = await f.model.next();
        scope = await realpath(
          join(f.environment.GEMINI_HOME!, "antigravity-cli", "conversations"),
        );
        request.partial("ONE_PART ");
        await f.output("ONE_PART");
        request.geminiParts(
          [call("read_file", { Path: join(f.project, "notes.txt") })],
          true,
        );
        (await f.model.next()).finish("ONE_DONE");
        await f.output("ONE_DONE");
        await f.idle();
        // A new conversation is listed once agy has written its summary row.
        await vi.waitFor(
          async () =>
            expect(
              await viewer.getSession(id(), projectId, undefined, {}),
            ).not.toBeNull(),
          { timeout: 5_000 },
        );
        const ended = await whole();
        const turnOne = ["INITIAL_NATIVE_INPUT", "ONE_PART", "ONE_DONE"];
        expect(prose(ended)).toEqual(turnOne);
        unique(ended);
        // The turn moves to the log: the same prose in the same order,
        // now under the log's step IDs, exactly the log's projection.
        await moved();
        const afterMove = await whole();
        expect(prose(afterMove)).toEqual(turnOne);
        expect(afterMove.map((m) => m.uuid)).toEqual(
          (await logged()).map((m) => m.uuid),
        );

        // A steered turn.
        expect(f.proc.queueMessage({ text: "STEER_FIRST" }).success).toBe(true);
        request = await f.model.next();
        request.partial("STEER_PART ");
        await f.output("STEER_PART");
        // Read while the reply streams: the log's turn, then the live rows.
        const during = await whole();
        expect(prose(during)).toEqual([
          ...turnOne,
          "STEER_FIRST",
          "STEER_PART",
        ]);
        unique(during);
        expect(
          await f.session.steer!({
            text: "STEER_SECOND",
            uuid: "c0ffee00-0000-4000-8000-0000000000a1",
            metadata: { deliveryIntent: "steer" },
          }),
        ).toBe(true);
        request.finish("STEER_FIRST_DONE");
        (await f.model.next()).finish("STEER_SECOND_DONE");
        await f.output("STEER_SECOND_DONE");
        await f.idle();
        // Right after it ends the turn is still live, or already moved:
        // live, the first reply is split where the steer was sent; in the
        // log, the steer follows the whole first reply.
        const liveSteer = [
          "STEER_FIRST",
          "STEER_PART",
          "STEER_SECOND",
          "STEER_FIRST_DONE",
          "STEER_SECOND_DONE",
        ];
        const loggedSteer = [
          "STEER_FIRST",
          "STEER_PART STEER_FIRST_DONE",
          "STEER_SECOND",
          "STEER_SECOND_DONE",
        ];
        const steered = await whole();
        unique(steered);
        expect([liveSteer, loggedSteer]).toContainEqual(
          prose(steered).slice(turnOne.length),
        );
        await moved();
        const steeredMoved = await whole();
        expect(prose(steeredMoved).slice(turnOne.length)).toEqual(loggedSteer);
        expect(steeredMoved.map((m) => m.uuid)).toEqual(
          (await logged()).map((m) => m.uuid),
        );

        // A queued compaction, verified by its checkpoint, then a turn
        // stopped while its reply streams, then one more turn.
        expect(f.proc.queueMessage({ text: "BEFORE_COMPACT" }).success).toBe(
          true,
        );
        request = await f.model.next();
        const compact = {
          text: "/compact keep markers",
          tempId: "compact",
          queuedCompact: {
            command: "compact" as const,
            argument: "keep markers",
          },
        };
        expect(
          await prepareQueuedCompaction(f.proc, compact, "keep markers"),
        ).toBeUndefined();
        expect(f.proc.deferMessage(compact).success).toBe(true);
        request.finish("BEFORE_COMPACT_DONE");
        (await f.model.next()).finish(
          "<analysis>a</analysis><summary>LIVE_MEMORY_SUMMARY</summary>",
        );
        (await f.model.next()).finish("COMPACT_CONTINUE");
        expect(await f.commandResult).toMatchObject({
          completion: "completed",
        });
        await f.idle();
        await moved();
        const compacted = await latest();
        expect(compacted[0]?.subtype).toBe("compact_boundary");
        unique(compacted);

        expect(f.proc.queueMessage({ text: "STOP_TURN" }).success).toBe(true);
        request = await f.model.next();
        request.partial("STOP_PART ");
        await f.output("STOP_PART");
        const stopping = await latest();
        expect(prose(stopping).slice(-2)).toEqual(["STOP_TURN", "STOP_PART"]);
        await f.proc.interrupt();
        await request.cancelled;
        await f.idle();
        const stopped = await latest();
        unique(stopped);
        expect(prose(stopped).slice(-2)).toEqual(["STOP_TURN", "STOP_PART"]);

        expect(f.proc.queueMessage({ text: "LAST_TURN" }).success).toBe(true);
        (await f.model.next()).finish("LAST_DONE");
        await f.output("LAST_DONE");
        await f.idle();
        await moved();
        const live = await whole();
        unique(live);
        expect(live.map((m) => m.uuid)).toEqual(
          (await logged()).map((m) => m.uuid),
        );
        expect(prose(live).slice(-3)).toEqual([
          "STOP_PART",
          "LAST_TURN",
          "LAST_DONE",
        ]);
        const liveLatest = await latest();

        // Stopped, a cold view is the same rows in the same order.
        await f.stop();
        expect((await whole()).map((m) => m.uuid)).toEqual(
          live.map((m) => m.uuid),
        );
        expect((await latest()).map((m) => m.uuid)).toEqual(
          liveLatest.map((m) => m.uuid),
        );
      } finally {
        await viewer.close();
      }
      expect(f.errors).toEqual([]);
      expect(f.model.failures).toEqual([]);
    }, 90_000);
  },
);
