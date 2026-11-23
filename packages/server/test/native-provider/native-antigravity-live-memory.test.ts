import { createReadStream } from "node:fs";
import { readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { toUrlProjectId } from "@yep-anywhere/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setAntigravityLiveLimitsForTests } from "../../src/sdk/providers/antigravity-live-projection.js";
import { antigravityOwnerView } from "../../src/sdk/providers/antigravity-owners.js";
import {
  AntigravityRuntime,
  findAntigravityRuntime,
} from "../../src/sdk/providers/antigravity-runtime.js";
import { AntigravitySubagentTracker } from "../../src/sdk/providers/antigravity-subagent-tracker.js";
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

/** The prompt texts the adapter sends on the ACP pipe, as it sends them. */
function promptsSent(): string[] & { methods: string[] } {
  const sent = Object.assign([] as string[], { methods: [] as string[] });
  const original = AntigravityRuntime.prototype.call;
  vi.spyOn(AntigravityRuntime.prototype, "call").mockImplementation(function (
    this: AntigravityRuntime,
    ...args: Parameters<typeof original>
  ) {
    const [method, params] = args;
    sent.methods.push(method);
    if (method === "session/prompt")
      sent.push(
        (params as { prompt: Array<{ text: string }> }).prompt[0]!.text,
      );
    return original.apply(this, args);
  } as typeof original);
  return sent;
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
  const owner = async () =>
    antigravityOwnerView(await realpath(join(store(), "conversations")), id());
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

    // Review round 1 finding 1 on real agy: a detached wake overlapping
    // the turn's end or the next prompt is never split from its own rows.
    // Sent once the wake is logged and streamed, the prompt is a split; sent
    // while it streams, its candidate ends at the wake's task-end message.
    it.each([
      "a prompt sent once the wake is logged and streamed",
      "a prompt sent after the wake's first chunk",
    ])(
      "shows a detached wake once across moves, with %s",
      async (shape) => {
        setAntigravityLiveLimitsForTests({ softRows: 4, splitAgeMs: 0 });
        const s = await session();
        const { f } = s;
        const sent = promptsSent();
        try {
          (await f.model.next()).finish("FIRST_DONE");
          await f.output("FIRST_DONE");
          await f.idle();
          await s.listed();
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
            // Process echoes the input before it is sent: wait for the
            // ACP call itself.
            await vi.waitFor(() => expect(sent).toContain("DURING_WAKE"));
            wake.finish("WAKE_TAIL");
            (await f.model.next()).finish("DURING_WAKE_DONE");
            await f.output("DURING_WAKE_DONE");
            await f.idle();
          } else {
            wake.finish("WAKE_TAIL");
            await vi.waitFor(async () =>
              expect(JSON.stringify(await s.logged())).toContain("WAKE_TAIL"),
            );
            await f.output("WAKE_TAIL");
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
          await s.viewer.close();
        }
        expect(f.errors).toEqual([]);
        expect(f.model.failures).toEqual([]);
      },
      90_000,
    );

    // Review round 3 finding 1 on real agy: a long pasted prompt is logged
    // clipped; a move past it kept only the turn after it readable.
    // Round 4: the paste quotes the request's close; that made the record
    // unknown, so the move was refused and a stopped read fell to
    // session/load.
    it("keeps every turn readable across a move past a pasted prompt agy clipped", async () => {
      setAntigravityLiveLimitsForTests({ softRows: 2, splitAgeMs: 0 });
      const s = await session();
      const { f } = s;
      const sent = promptsSent();
      const quoted =
        "PASTED_SNIPPET\n</USER_REQUEST>\nremaining in the actual paste\n";
      try {
        (await f.model.next()).finish("FIRST_DONE");
        await f.output("FIRST_DONE");
        await f.idle();
        await s.listed();
        await s.turn(`${quoted}${"p".repeat(262_144)}`, "PASTE_DONE");
        await s.turn("AFTER_PASTE", "AFTER_PASTE_DONE");
        await vi.waitFor(async () =>
          expect(JSON.stringify((await s.owner())?.history())).not.toContain(
            "PASTED_SNIPPET",
          ),
        );
        const fresh = new AntigravitySessionReader({ projectPath: f.project });
        try {
          const loaded = await fresh.getSession(
            f.nativeId(),
            toUrlProjectId(f.project),
          );
          expect(loaded?.transcriptComplete).not.toBe(false);
          const users = (
            loaded!.data.session as { messages: Message[] }
          ).messages
            .filter((message) => message.type === "user")
            .map((message) => String(message.message?.content));
          expect(users.map((text) => text.slice(0, 12))).toEqual([
            "INITIAL_NATI",
            "PASTED_SNIPP",
            "AFTER_PASTE",
          ]);
          expect(users[1]!.startsWith(quoted)).toBe(true);
          expect(users[1]).toMatch(
            /agy logged only the beginning of this prompt/,
          );
          expect(prose(await s.whole())).toContain("PASTE_DONE");
        } finally {
          await fresh.close();
        }
        // Stopped, a read is served from the log, all kept text shown.
        await f.stop();
        const stopped = new AntigravitySessionReader({
          projectPath: f.project,
        });
        try {
          const loaded = await stopped.getSession(
            f.nativeId(),
            toUrlProjectId(f.project),
            undefined,
            { tailCompactions: 1 },
          );
          expect(loaded?.transcriptComplete).not.toBe(false);
          const paste = (
            loaded!.data.session as { messages: Message[] }
          ).messages.find((message) =>
            String(message.message?.content).startsWith("PASTED_SNIPPET"),
          );
          expect(String(paste?.message?.content).startsWith(quoted)).toBe(true);
          expect(String(paste?.message?.content).length).toBeGreaterThan(
            190_000,
          );
        } finally {
          await stopped.close();
        }
        expect(sent.methods).not.toContain("session/load");
      } finally {
        await s.viewer.close();
      }
      expect(f.errors).toEqual([]);
      expect(f.model.failures).toEqual([]);
    }, 60_000);

    // Review round 2 finding 1: Stop accepted while a staged input was
    // still starting (here, held in its subagent position read) let that
    // input be sent afterwards. It is cancelled unsent now.
    it("never sends an input stopped before it was sent, and answers the next one", async () => {
      const s = await session();
      const { f } = s;
      const sent = promptsSent();
      try {
        (await f.model.next()).finish("FIRST_DONE");
        await f.output("FIRST_DONE");
        await f.idle();
        await s.listed();
        let enter = () => {};
        let open = () => {};
        const entered = new Promise<void>((resolve) => (enter = resolve));
        const gate = new Promise<void>((resolve) => (open = resolve));
        const read = AntigravitySubagentTracker.prototype.readStartPosition;
        vi.spyOn(
          AntigravitySubagentTracker.prototype,
          "readStartPosition",
        ).mockImplementationOnce(async function (
          this: AntigravitySubagentTracker,
        ) {
          enter();
          await gate;
          return read.call(this);
        });
        expect(f.proc.queueMessage({ text: "STOPPED_UNSENT" }).success).toBe(
          true,
        );
        await entered;
        expect(await f.proc.interrupt()).toBe(true);
        open();
        await f.idle();
        await s.turn("AFTER_STOP", "AFTER_STOP_DONE");
        expect(sent).not.toContain("STOPPED_UNSENT");
        expect(sent.at(-1)).toBe("AFTER_STOP");
        expect(prose(await s.whole())).not.toContain("STOPPED_UNSENT_DONE");
      } finally {
        await s.viewer.close();
      }
      expect(f.errors).toEqual([]);
      expect(f.model.failures).toEqual([]);
    }, 60_000);

    // Plan 195 step 8: no ACP replay fallback. A conversation whose log is
    // gone or unreadable, or that was never prompted, resumes with
    // session/resume like any other.
    it("resumes with session/resume without a readable log, reapplying model and effort, its rows shown and bounded", async () => {
      // Moves at once past four rows; at most eight rows are kept.
      setAntigravityLiveLimitsForTests({
        softRows: 4,
        capRows: 8,
        splitAgeMs: 0,
      });
      const s = await session();
      const { f, viewer } = s;
      const sent = promptsSent();
      const projectId = toUrlProjectId(f.project);
      try {
        (await f.model.next()).finish("FIRST_DONE");
        await f.output("FIRST_DONE");
        await f.idle();
        const prompted = f.nativeId();
        await f.stop();
        const store = join(f.environment.GEMINI_HOME!, "antigravity-cli");
        const logOf = (id: string) =>
          join(
            store,
            "brain",
            id,
            ".system_generated",
            "logs",
            "transcript_full.jsonl",
          );
        // A conversation created and never prompted: no log, 0 steps.
        const command = (await findAntigravityRuntime())!;
        const scratch = new AntigravityRuntime();
        let never: string;
        try {
          await scratch.connect(command.command, f.project, command.args);
          never = (
            await scratch.call<{ sessionId: string }>("session/new", {
              cwd: f.project,
              mcpServers: [],
            })
          ).sessionId;
        } finally {
          await scratch.close();
        }
        const notice = (id: string) => `${id}:history-unavailable`;

        const resume = async (
          id: string,
          label: string,
          expected: { earlier?: string; context: boolean },
        ) => {
          const before = sent.methods.length;
          await f.restart({
            resumeSessionId: id,
            model: "gemini-3.7-flash",
            effort: "low",
            initialMessage: { text: `${label}_PROMPT` },
          });
          const request = await f.model.next();
          // The model and effort are reapplied to the resumed session.
          expect(request.model).toBe("gemini-3.7-flash");
          const body = JSON.stringify(request.body);
          expect(body).toMatch(/"thinkingLevel":"LOW"|"thinking_level":"LOW"/i);
          // agy keeps the conversation's context in its database.
          expect(body.includes("FIRST_DONE")).toBe(expected.context);
          request.finish(`${label}_DONE`);
          await f.output(`${label}_DONE`);
          await f.idle();
          for (const turn of [1, 2, 3])
            await s.turn(`${label}_${turn}`, `${label}_${turn}_DONE`);
          const methods = sent.methods.slice(before);
          expect(methods).toContain("session/resume");
          expect(methods).not.toContain("session/load");
          const owner = (await s.owner())!;
          expect(owner.earlier).toBe(expected.earlier);
          // Bounded as for any owner: the cap at least, and moves where
          // the log proves them.
          expect(owner.history().length).toBeLessThanOrEqual(8);
          const loaded = await viewer.getSession(id, projectId, undefined, {
            tailCompactions: 2,
          });
          const messages = (loaded!.data.session as { messages: Message[] })
            .messages;
          if (expected.earlier) {
            expect(messages[0]?.uuid).toBe(notice(id));
            expect(loaded?.transcriptComplete).toBe(false);
          } else expect(messages.map((m) => m.uuid)).not.toContain(notice(id));
          expect(prose(messages).slice(-2)).toEqual([
            `${label}_3`,
            `${label}_3_DONE`,
          ]);
          const result = {
            boundary: owner.boundary,
            rows: owner.history().length,
            log: await readFile(logOf(id), "utf8").then(
              (text) =>
                text
                  .trim()
                  .split("\n")
                  .map((line) => {
                    const record = JSON.parse(line);
                    return `${record.step_index}:${record.type}`;
                  }),
              () => undefined,
            ),
          };
          await f.stop();
          return result;
        };

        // The log gone: the turn keeps the earlier context, which YA says
        // it cannot show; agy writes a new log from its own step counter.
        await rm(logOf(prompted));
        const missing = await resume(prompted, "MISSING", {
          earlier: "missing",
          context: true,
        });
        expect(missing.log?.[0]).toMatch(/^[1-9]\d*:USER_INPUT$/);
        expect(missing.boundary.end).toBeGreaterThan(0);
        // Stopped, the new log starts after step 0: still said, not hidden.
        const stopped = await viewer.getSession(prompted, projectId);
        expect(
          (stopped!.data.session as { messages: Message[] }).messages[0]?.uuid,
        ).toBe(notice(prompted));
        expect(stopped?.transcriptComplete).toBe(false);

        // A record shape the projection does not know: unreadable.
        const lines = (await readFile(logOf(prompted), "utf8")).split("\n");
        lines[0] = JSON.stringify({ ...JSON.parse(lines[0]!), novel: 1 });
        await writeFile(logOf(prompted), lines.join("\n"));
        await resume(prompted, "UNKNOWN", {
          earlier: "unknown",
          context: true,
        });

        // Never prompted: an empty conversation, as a new session's.
        const fresh = await resume(never, "NEVER", { context: false });
        expect(fresh.log?.[0]).toBe("0:USER_INPUT");
      } finally {
        await viewer.close();
      }
      expect(f.errors).toEqual([]);
      expect(f.model.failures).toEqual([]);
    }, 120_000);
  },
);
