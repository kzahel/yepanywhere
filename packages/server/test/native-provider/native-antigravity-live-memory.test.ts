import { createReadStream } from "node:fs";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { toUrlProjectId } from "@yep-anywhere/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setAntigravityLiveLimitsForTests } from "../../src/sdk/providers/antigravity-live-projection.js";
import { antigravityOwnerView } from "../../src/sdk/providers/antigravity-owners.js";
import { prepareQueuedCompaction } from "../../src/routes/session-input-admission.js";
import {
  antigravityLogLines,
  projectAntigravityLog,
} from "../../src/sessions/antigravity-log-projection.js";
import { AntigravityLogTail } from "../../src/sessions/antigravity-log-tail.js";
import { AntigravitySessionReader } from "../../src/sessions/antigravity-reader.js";
import type { Message } from "../../src/supervisor/types.js";
import { nativeFixture } from "./fixture.js";
import { providers } from "./selection.js";

let fixture: Awaited<ReturnType<typeof nativeFixture>> | undefined;
afterEach(async () => {
  setAntigravityLiveLimitsForTests();
  vi.restoreAllMocks();
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

/** A real `agy` session read through the production reader. */
async function session() {
  const f = await nativeFixture("antigravity");
  fixture = f;
  const id = f.nativeId;
  const store = () => join(f.environment.GEMINI_HOME!, "antigravity-cli");
  const viewer = new AntigravitySessionReader({ projectPath: f.project });
  const projectId = toUrlProjectId(f.project);
  const messagesOf = async (
    options?: Parameters<AntigravitySessionReader["getSession"]>[3],
  ) => {
    const loaded = await viewer.getSession(id(), projectId, undefined, options);
    expect(loaded?.transcriptComplete).not.toBe(false);
    const messages = (loaded!.data.session as { messages: Message[] }).messages;
    expect(new Set(messages.map((m) => m.uuid)).size).toBe(messages.length);
    return messages;
  };
  const owner = async () => {
    const view = antigravityOwnerView(
      await realpath(join(store(), "conversations")),
      id(),
    );
    return view?.state === "open" ? view : undefined;
  };
  return {
    f,
    viewer,
    whole: () => messagesOf(),
    latest: () => messagesOf({ tailCompactions: 1 }),
    /** The log's own projection, the cold oracle. */
    logged: async () => {
      const result = await projectAntigravityLog(
        antigravityLogLines(
          createReadStream(
            join(
              store(),
              "brain",
              id(),
              ".system_generated",
              "logs",
              "transcript_full.jsonl",
            ),
          ),
        ),
        { conversationId: id(), ownerLive: false },
      );
      if (result.status !== "known") throw Error(result.reason);
      return result.messages;
    },
    owner,
    /** A new conversation is listed once agy has written its summary row. */
    async listed() {
      await vi.waitFor(
        async () =>
          expect(
            await viewer.getSession(id(), projectId, undefined, {}),
          ).not.toBeNull(),
        { timeout: 5_000 },
      );
    },
    async turn(text: string, reply: string) {
      expect(f.proc.queueMessage({ text }).success).toBe(true);
      (await f.model.next()).finish(reply);
      await f.output(reply);
      await f.idle();
    },
  };
}

describe.skipIf(!providers.includes("antigravity"))(
  "native Antigravity live memory",
  () => {
    it("shows the same rows in order during a turn, after it ends, across moves to the log, and once stopped", async () => {
      // Past four rows the owner moves to a proven split point at once.
      setAntigravityLiveLimitsForTests({ softRows: 4, splitAgeMs: 0 });
      const s = await session();
      const { f } = s;
      try {
        // A tool-heavy turn.
        let request = await f.model.next();
        request.partial("ONE_PART ");
        await f.output("ONE_PART");
        request.geminiParts(
          [call("read_file", { Path: join(f.project, "notes.txt") })],
          true,
        );
        (await f.model.next()).finish("ONE_DONE");
        await f.output("ONE_DONE");
        await f.idle();
        await s.listed();
        const turnOne = ["INITIAL_NATIVE_INPUT", "ONE_PART", "ONE_DONE"];
        expect(prose(await s.whole())).toEqual(turnOne);

        // A steered turn, read while its reply streams.
        expect(f.proc.queueMessage({ text: "STEER_FIRST" }).success).toBe(true);
        request = await f.model.next();
        request.partial("STEER_PART ");
        await f.output("STEER_PART");
        expect(prose(await s.whole())).toEqual([
          ...turnOne,
          "STEER_FIRST",
          "STEER_PART",
        ]);
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
        // Live, the steer splits the first reply where it was sent; once the
        // turn has moved to the log, the steer follows the whole reply.
        const joined = (rows: string[]) => rows.join(" ").replace(/\s+/g, " ");
        expect([
          "STEER_FIRST STEER_PART STEER_SECOND STEER_FIRST_DONE STEER_SECOND_DONE",
          "STEER_FIRST STEER_PART STEER_FIRST_DONE STEER_SECOND STEER_SECOND_DONE",
        ]).toContain(joined(prose(await s.whole()).slice(turnOne.length)));

        // A queued compaction verified by its checkpoint, a turn stopped
        // while its reply streams, then two more turns.
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
        // One boundary for the compaction, live or from the log.
        expect(
          (await s.whole()).filter((m) => m.subtype === "compact_boundary"),
        ).toHaveLength(1);

        expect(f.proc.queueMessage({ text: "STOP_TURN" }).success).toBe(true);
        request = await f.model.next();
        request.partial("STOP_PART ");
        await f.output("STOP_PART");
        expect(prose(await s.latest()).slice(-2)).toEqual([
          "STOP_TURN",
          "STOP_PART",
        ]);
        await f.proc.interrupt();
        await request.cancelled;
        await f.idle();
        const before = (await s.owner())?.boundary?.end;
        await s.turn("NEXT_TURN", "NEXT_DONE");
        await s.turn("LAST_TURN", "LAST_DONE");
        // The owner has moved: the conversation through its boundary is the
        // log's own projection, and its rows follow.
        await vi.waitFor(async () =>
          expect((await s.owner())?.boundary?.end).not.toBe(before),
        );
        const view = (await s.owner())!;
        expect(view.history().length).toBeLessThanOrEqual(4 + 2);
        const live = await s.whole();
        const throughBoundary = (await s.logged()).filter(
          (message) =>
            Number(/:step-(\d+)/.exec(String(message.uuid))?.[1]) <=
            view.boundary!.step,
        );
        expect(
          live.slice(0, throughBoundary.length).map((m) => m.uuid),
        ).toEqual(throughBoundary.map((m) => m.uuid));
        expect(prose(live).slice(-3)).toEqual([
          "NEXT_DONE",
          "LAST_TURN",
          "LAST_DONE",
        ]);
        expect(prose(live)).toContain("STEER_PART STEER_FIRST_DONE");
        const liveProse = prose(live);

        // Stopped, a cold view is the same prose in the same order.
        await f.stop();
        expect(prose(await s.whole())).toEqual(liveProse);
      } finally {
        await s.viewer.close();
      }
      expect(f.errors).toEqual([]);
      expect(f.model.failures).toEqual([]);
    }, 90_000);

    // Review finding 1 on real agy: a detached wake overlapping the turn's
    // end or the next prompt is never split from its own rows.
    it.each([
      "the result's log pass held until the wake is logged",
      "a prompt sent after the wake's first chunk",
    ])(
      "shows a detached wake once across moves, with %s",
      async (shape) => {
        setAntigravityLiveLimitsForTests({ softRows: 4, splitAgeMs: 0 });
        const s = await session();
        const { f } = s;
        let release = () => {};
        const hold = {
          promise: new Promise<void>((resolve) => {
            release = resolve;
          }),
          resolve: () => release(),
        };
        try {
          (await f.model.next()).finish("FIRST_DONE");
          await f.output("FIRST_DONE");
          await f.idle();
          await s.listed();
          if (shape === "the result's log pass held until the wake is logged") {
            const original = AntigravityLogTail.prototype.pass;
            vi.spyOn(
              AntigravityLogTail.prototype,
              "pass",
            ).mockImplementationOnce(async function (
              this: AntigravityLogTail,
              ...args
            ) {
              await hold.promise;
              return original.apply(this, args);
            });
          }
          expect(f.proc.queueMessage({ text: "WAKE_TURN" }).success).toBe(true);
          (await f.model.next()).tool("run_command", {
            CommandLine: "sleep 1; echo WAKE_BG_DONE",
            WaitMsBeforeAsync: 100,
            toolSummary: "background",
          });
          (await f.model.next()).finish("WAKE_TURN_DONE");
          await f.output("WAKE_TURN_DONE");
          await f.idle();
          const wake = await f.model.next();
          wake.partial("WAKE_HEAD ");
          await f.output("WAKE_HEAD");
          if (shape === "a prompt sent after the wake's first chunk") {
            expect(f.proc.queueMessage({ text: "DURING_WAKE" }).success).toBe(
              true,
            );
            await vi.waitFor(() =>
              expect(JSON.stringify(f.proc.getMessageHistory())).toContain(
                '"DURING_WAKE"',
              ),
            );
            wake.finish("WAKE_TAIL");
            (await f.model.next()).finish("DURING_WAKE_DONE");
            await f.output("DURING_WAKE_DONE");
            await f.idle();
          } else {
            wake.finish("WAKE_TAIL");
            await vi.waitFor(async () =>
              expect(JSON.stringify(await s.logged())).toContain("WAKE_TAIL"),
            );
            hold.resolve();
            await s.turn("DURING_WAKE", "DURING_WAKE_DONE");
          }
          const once = async () => {
            for (const rows of [await s.whole(), await s.latest()]) {
              const text = JSON.stringify(prose(rows));
              expect(text.match(/WAKE_HEAD/g) ?? []).toHaveLength(1);
              expect(text.match(/WAKE_TAIL/g) ?? []).toHaveLength(1);
            }
          };
          await once();
          const before = (await s.owner())?.boundary?.end;
          for (const turn of ["AFTER_ONE", "AFTER_TWO", "AFTER_THREE"]) {
            await s.turn(turn, `${turn}_DONE`);
            await once();
          }
          await vi.waitFor(async () =>
            expect((await s.owner())?.boundary?.end).not.toBe(before),
          );
          await once();
          await f.stop();
          await once();
        } finally {
          hold.resolve();
          await s.viewer.close();
        }
        expect(f.errors).toEqual([]);
        expect(f.model.failures).toEqual([]);
      },
      90_000,
    );
  },
);
