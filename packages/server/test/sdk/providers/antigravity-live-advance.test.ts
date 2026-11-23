import {
  appendFile,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AntigravitySplitSampler,
  antigravitySplitCheck,
  spanKnown,
} from "../../../src/sdk/providers/antigravity-live-advance.js";
import {
  ANTIGRAVITY_LIVE_CUT_NOTICE,
  AntigravityLiveProjection,
  type AntigravitySplitCandidate,
  EMPTY_ANTIGRAVITY_LOG,
  setAntigravityLiveLimitsForTests,
} from "../../../src/sdk/providers/antigravity-live-projection.js";
import type { AntigravityLogBoundary } from "../../../src/sdk/providers/antigravity-owners.js";
import { AntigravityTranscript } from "../../../src/sdk/providers/antigravity-transcript.js";
import type { SDKMessage } from "../../../src/sdk/types.js";
import { LogSource } from "../../../src/sessions/antigravity-log-source.js";
import { agyClippedContent } from "../../utils/antigravity-clipped-prompt.js";

const ID = "c0ffee00-0000-4000-8000-000000000206";
const at = "2026-11-23T08:00:00Z";
const record = (step: number, type: string, fields: object = {}) =>
  `${JSON.stringify({
    step_index: step,
    source:
      type === "USER_INPUT"
        ? "USER_EXPLICIT"
        : type === "SYSTEM_MESSAGE" || type === "ERROR_MESSAGE"
          ? "SYSTEM"
          : "MODEL",
    type,
    status: "DONE",
    created_at: at,
    ...fields,
  })}\n`;
const input = (step: number, text: string) =>
  record(step, "USER_INPUT", {
    content: `<USER_REQUEST>\n${text}\n</USER_REQUEST>`,
  });
const system = (step: number, text: string) =>
  record(step, "SYSTEM_MESSAGE", {
    content: `The following is a <SYSTEM_MESSAGE> not actually sent by the user. It is provided by the system as important information to pay attention to.\n\n<SYSTEM_MESSAGE>\n${text}\n</SYSTEM_MESSAGE>`,
  });
const reply = (step: number, text: string) =>
  record(step, "PLANNER_RESPONSE", { content: text });
const row = (uuid: string, text: string, type = "assistant"): SDKMessage => ({
  type: type as "assistant",
  uuid,
  message: { role: type, content: text },
});

let root: string;
let scope: string;
let log: string;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "ya-agy-advance-")));
  scope = join(root, "conversations");
  const logs = join(root, "brain", ID, ".system_generated", "logs");
  await mkdir(logs, { recursive: true });
  await mkdir(scope);
  log = join(logs, "transcript_full.jsonl");
});
afterEach(async () => {
  setAntigravityLiveLimitsForTests();
  await rm(root, { recursive: true, force: true });
});

/** A candidate as the owner takes one: its path resolved, then one stat. */
async function candidate(): Promise<AntigravitySplitCandidate> {
  const sampler = new AntigravitySplitSampler(scope, ID);
  sampler.prepare();
  await vi.waitFor(() => expect(sampler.sample(1)).toBeDefined());
  return sampler.sample(1) as AntigravitySplitCandidate;
}
const check = (
  taken: AntigravitySplitCandidate,
  boundary: AntigravityLogBoundary = EMPTY_ANTIGRAVITY_LOG,
) => antigravitySplitCheck(scope, ID)(taken, boundary, () => true);

describe("proving an Antigravity split candidate", () => {
  it("proves the record ending at the size taken at dispatch when a user input starts there", async () => {
    const first = input(0, "First") + reply(1, "Reply one");
    await writeFile(log, first);
    const taken = await candidate();
    expect(taken).toMatchObject({ size: first.length, seq: 1 });
    await appendFile(log, input(2, "Second") + reply(3, "Two"));
    expect(await check(taken)).toMatchObject({
      step: 1,
      end: first.length,
      start: input(0, "First").length,
    });
    // An error ends a turn too.
    await writeFile(
      log,
      input(0, "First") + record(1, "ERROR_MESSAGE", { error: "quota" }),
    );
    const afterError = await candidate();
    await appendFile(log, input(2, "Again"));
    expect(await check(afterError)).toMatchObject({ step: 1 });
  });

  it("takes no candidate before the log exists, and proves an empty log when the first input starts the file", async () => {
    await rm(log, { force: true });
    const sampler = new AntigravitySplitSampler(scope, ID);
    sampler.prepare();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sampler.sample(1)).toBeUndefined();
    const taken = { seq: 1, size: 0, at: 0 };
    await writeFile(log, input(0, "First"));
    expect(await check(taken)).toEqual(EMPTY_ANTIGRAVITY_LOG);
  });

  // Plan 195 step 7: the proof assumes one writer.
  it("reports another writer when the log grew after the owner's idle point, later than the settle after its last frame and with nothing of its own running", async () => {
    await writeFile(log, input(0, "First") + reply(1, "One"));
    const sampler = new AntigravitySplitSampler(scope, ID);
    sampler.prepare();
    await vi.waitFor(() => expect(sampler.sample(1)).toBeDefined());
    let step = 2;
    const append = () =>
      appendFile(log, input(step, "Outside") + reply(step + 1, "Done")).then(
        () => {
          step += 2;
        },
      );
    const idle = async () => {
      sampler.settle();
      await new Promise((resolve) => setTimeout(resolve, 20));
    };
    const quietLongAgo = () => Date.now() - 10_000;
    await idle();
    expect(sampler.sample(2, quietLongAgo())).toMatchObject({ seq: 2 });
    await idle();
    await append();
    expect(sampler.sample(3, quietLongAgo())).toBe("foreign");
    // Not another writer: a record its agy wrote just after its last frame,
    await idle();
    await append();
    expect(sampler.sample(4, Date.now())).toMatchObject({ seq: 4 });
    // its own work running (no quiet time),
    await idle();
    await append();
    expect(sampler.sample(5)).toMatchObject({ seq: 5 });
    // or a wake since the idle point.
    await idle();
    sampler.unsettle();
    await append();
    expect(sampler.sample(6, quietLongAgo())).toMatchObject({ seq: 6 });
  });

  // Each of these moved rows on the scanner, or is new with the stat proof.
  it.each([
    [
      "the last record is a wake's task-end message",
      async () => {
        await writeFile(
          log,
          input(0, "First") + reply(1, "Reply") + system(2, "task done"),
        );
        const taken = await candidate();
        await appendFile(log, input(3, "Second"));
        return taken;
      },
    ],
    [
      "the last record is a planner with calls",
      async () => {
        await writeFile(
          log,
          input(0, "First") +
            record(1, "PLANNER_RESPONSE", {
              content: "",
              tool_calls: [{ name: "run_command", args: {} }],
            }),
        );
        const taken = await candidate();
        await appendFile(log, input(2, "Second"));
        return taken;
      },
    ],
    [
      "a wake record lands between the size and the prompt's input",
      async () => {
        await writeFile(log, input(0, "First") + reply(1, "Reply"));
        const taken = await candidate();
        await appendFile(log, system(2, "task done") + input(3, "Second"));
        return taken;
      },
    ],
    [
      "the file was replaced",
      async () => {
        const text = input(0, "First") + reply(1, "Reply");
        await writeFile(log, text);
        const taken = await candidate();
        await rm(log);
        await writeFile(log, text + input(2, "Second"));
        return taken;
      },
    ],
    [
      "the file was truncated",
      async () => {
        await writeFile(log, input(0, "First") + reply(1, "Reply"));
        const taken = await candidate();
        await truncate(log, 10);
        return taken;
      },
    ],
    [
      "the record ending there is malformed",
      async () => {
        await writeFile(
          log,
          `${input(0, "First")}{"step_index":1,"source":"MODEL","type":"PLANNER_RESPONSE","status":"DONE","created_at":"${at}","content":!}\n`,
        );
        const taken = await candidate();
        await appendFile(log, input(2, "Second"));
        return taken;
      },
    ],
    [
      "the record ending there is too large to read",
      async () => {
        await writeFile(log, input(0, "First"));
        await appendFile(log, reply(1, "y".repeat(17 * 1024 * 1024)));
        const taken = await candidate();
        await appendFile(log, input(2, "Second"));
        return taken;
      },
    ],
    [
      "no newline precedes the size (a record being written)",
      async () => {
        const partial = reply(1, "Reply");
        await writeFile(log, input(0, "First") + partial.slice(0, 20));
        const taken = await candidate();
        await appendFile(log, partial.slice(20));
        await appendFile(log, input(2, "Second"));
        return taken;
      },
    ],
  ])("proves nothing when %s", async (_shape, arrange) => {
    expect(await check(await arrange())).toBeUndefined();
  });

  // Review round 3 finding 1: a valid split retired the only copy of rows
  // the log could not show.
  it("proves nothing when the span it would retire holds a record no reader can show, and proves one with a prompt agy clipped", async () => {
    const unknown = record(2, "USER_INPUT", { content: "no wrapper" });
    const clipped = record(2, "USER_INPUT", {
      content: agyClippedContent(
        `<USER_REQUEST>\n${"x".repeat(262_144)}\n</USER_REQUEST>`,
      ),
    });
    for (const [middle, proven] of [
      [unknown, false],
      [clipped, true],
    ] as const) {
      await writeFile(
        log,
        input(0, "First") + reply(1, "One") + middle + reply(3, "Two"),
      );
      const taken = await candidate();
      await appendFile(log, input(4, "Third"));
      expect(Boolean(await check(taken)), String(proven)).toBe(proven);
    }
  });

  // Review round 3 item 6: the record ending at Z was found, then read again.
  it("reads the record ending at the size once", async () => {
    await writeFile(log, input(0, "First"));
    await appendFile(log, reply(1, "y".repeat(3 * 1024 * 1024)));
    const taken = await candidate();
    await appendFile(log, input(2, "Second"));
    let own: LogSource | undefined;
    let bytes = 0;
    const read = LogSource.prototype.read;
    const spy = vi
      .spyOn(LogSource.prototype, "read")
      .mockImplementation(function (this: LogSource, start, length) {
        own ??= this;
        if (this === own) bytes += length;
        return read.call(this, start, length);
      });
    try {
      expect(await check(taken)).toMatchObject({ step: 1 });
    } finally {
      spy.mockRestore();
    }
    expect(bytes).toBeLessThanOrEqual(taken.size + 512);
  });

  // Review round 4 finding 5: the last backward read could take a record
  // past the limit, which was then accepted.
  it("refuses a record ending at the size of 16 MiB plus one chunk", async () => {
    await writeFile(log, input(0, "First"));
    await appendFile(log, reply(1, "y".repeat(16 * 1024 * 1024 + 64 * 1024)));
    const taken = await candidate();
    await appendFile(log, input(2, "Second"));
    expect(await check(taken)).toBeUndefined();
  });

  // Review round 4 finding 2: a closed owner kept paging the span, and a
  // cursor that did not resolve ended the span check as a success.
  it("opens no page of the span once the owner closed, and fails on a cursor miss", async () => {
    let alive = true;
    let release = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    const pages: string[] = [];
    const page = (step: number) => ({
      status: "known" as const,
      messages: [{ type: "user", uuid: `${ID}:step-${step}` }] as never,
      omittedPrefix: true,
      bytesRead: 0,
      heldPeak: 0,
    });
    const checking = spanKnown(
      scope,
      ID,
      { step: 1, end: 10 },
      { step: 40, end: 1000 },
      () => alive,
      async (options) => {
        pages.push(options.request.kind);
        if (pages.length === 1) await held;
        return page(30);
      },
    );
    await vi.waitFor(() => expect(pages).toHaveLength(1));
    alive = false;
    release();
    expect(await checking).toBe(false);
    expect(pages).toEqual(["latest"]);
    // A `before` page whose cursor missed is known and whole: no proof.
    const missed = await spanKnown(
      scope,
      ID,
      { step: 1, end: 10 },
      { step: 40, end: 1000 },
      () => true,
      async (options) =>
        options.request.kind === "latest"
          ? page(30)
          : { ...page(20), omittedPrefix: false, anchor: "missed" as const },
    );
    expect(missed).toBe(false);
  });

  it("leaves a candidate pending until the prompt's input is logged", async () => {
    await writeFile(log, input(0, "First") + reply(1, "Reply"));
    const taken = await candidate();
    expect(await check(taken)).toBe("pending");
    await rm(log);
    expect(await check({ seq: 1, size: 0, at: 0 })).toBe("pending");
  });

  it("proves nothing before the current boundary or in a file it does not pin", async () => {
    const first = input(0, "First") + reply(1, "Reply");
    await writeFile(log, first + input(2, "Second") + reply(3, "Two"));
    const taken = { ...(await candidate()), size: first.length };
    await appendFile(log, input(4, "Third"));
    const later = { step: 3, end: (await check(taken))!.end + 100 };
    expect(await check(taken, later)).toBeUndefined();
    expect(
      await check(taken, { step: 1, end: first.length, dev: 1, ino: 1 }),
    ).toBeUndefined();
  });
});

/** A projection over the soft budget with a scripted check and clock. */
function projection(options: { softRows?: number; capRows?: number } = {}) {
  setAntigravityLiveLimitsForTests({
    softRows: options.softRows ?? 2,
    capRows: options.capRows ?? 10_000,
    splitAgeMs: 35_000,
  });
  const clock = { now: 0 };
  const checked: AntigravitySplitCandidate[] = [];
  const results: Array<
    (boundary?: AntigravityLogBoundary | "pending") => void
  > = [];
  const live = new AntigravityLiveProjection(
    EMPTY_ANTIGRAVITY_LOG,
    (taken) => {
      checked.push(taken);
      return new Promise((resolve) => results.push(resolve));
    },
    { now: () => clock.now },
  );
  const add = (seq: number, at: number) =>
    live.addCandidate({ seq, size: 100 + seq, at });
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  return { live, clock, checked, results, add, settle };
}

describe("a live Antigravity window", () => {
  it("dates a hosted owner's candidate from the backend's acknowledgement, not from its prompt", async () => {
    setAntigravityLiveLimitsForTests({ softRows: 1, splitAgeMs: 35_000 });
    const clock = { now: 0 };
    const checked: AntigravitySplitCandidate[] = [];
    // The backend acknowledges what came before the prompt only after a
    // reload's replay: the replacement Process buffered it then.
    const acknowledged: { at?: number } = {};
    const live = new AntigravityLiveProjection(
      EMPTY_ANTIGRAVITY_LOG,
      (taken) => {
        checked.push(taken);
        return new Promise(() => {});
      },
      { now: () => clock.now, delivery: () => () => acknowledged.at },
    );
    live.record(row("p1", "First", "user"));
    live.record(row("r1", "One"));
    live.addCandidate({ seq: 2, size: 100, at: 0 });
    live.record(row("p2", "Second", "user"));
    clock.now = 40_000;
    live.record(row("r2", "Two"));
    expect(checked).toHaveLength(0);
    acknowledged.at = 30_000;
    clock.now = 64_000;
    live.record(row("r3", "Three"));
    expect(checked).toHaveLength(0);
    clock.now = 65_000;
    live.record(row("r4", "Four"));
    expect(checked.map((candidate) => candidate.seq)).toEqual([2]);
  });

  it("keeps a candidate old enough to use through a burst of two prompts a second", async () => {
    const { live, clock, checked, add } = projection({ softRows: 1_000_000 });
    // A 64-entry FIFO held only the last 32 s of these.
    for (let i = 0; i < 200; i++) {
      live.record(row(`p${i}`, "prompt", "user"));
      add(live.seq - 1, i * 500);
    }
    clock.now = 100_000;
    setAntigravityLiveLimitsForTests({ softRows: 1, splitAgeMs: 35_000 });
    live.record(row("next", "more"));
    expect(checked).toHaveLength(1);
    expect(checked[0]!.at).toBeLessThanOrEqual(65_000);
  });

  it("moves at a proven candidate even after the cap evicted every row before it, clearing the incomplete mark", async () => {
    const { live, clock, results, add, settle } = projection({
      softRows: 1,
      capRows: 2,
    });
    live.record(row("p1", "First", "user"));
    live.record(row("r1", "One"));
    live.record(row("p2", "Second", "user"));
    add(2, 0);
    live.record(row("r2", "Two"));
    // The cap took p1 and r1 before the candidate was old enough; the
    // scanner's window ignored a split with no older row left to evict.
    expect(live.history().map((m) => m.uuid)).toEqual(["p2", "r2"]);
    expect(live.incomplete).toBe(true);
    clock.now = 40_000;
    live.record(row("r2", "Two, grown"));
    expect(results).toHaveLength(1);
    results[0]!({ step: 1, end: 500 });
    await settle();
    expect(live.boundary).toEqual({ step: 1, end: 500 });
    expect(live.incomplete).toBe(false);
    expect(live.retired("p1")).toBe(true);
  });

  it("discards a candidate the log does not prove and tries the next older one", async () => {
    const { live, clock, checked, results, add, settle } = projection();
    for (const id of ["p1", "r1", "p2", "r2", "p3", "r3"])
      live.record(row(id, id));
    add(0, 0);
    add(2, 1_000);
    add(4, 2_000);
    clock.now = 40_000;
    live.record(row("r4", "Four"));
    expect(checked.map((c) => c.seq)).toEqual([4]);
    results[0]!(undefined);
    await settle();
    expect(checked.map((c) => c.seq)).toEqual([4, 2]);
    results[1]!({ step: 3, end: 300 });
    await settle();
    expect(live.history().map((m) => m.uuid)).toEqual([
      "p2",
      "r2",
      "p3",
      "r3",
      "r4",
    ]);
    // A row that moved is never recreated by a late update.
    live.record(row("r1", "late"));
    expect(live.has("r1")).toBe(false);
  });

  it("checks a pending candidate again only once a new row arrives", async () => {
    const { live, clock, checked, results, add, settle } = projection();
    for (const id of ["p1", "r1", "p2"]) live.record(row(id, id));
    add(2, 0);
    clock.now = 40_000;
    live.record(row("r2", "Two"));
    results[0]!("pending");
    await settle();
    // Updates to a row already held check nothing.
    live.record(row("r2", "Two, grown"));
    expect(checked).toHaveLength(1);
    live.record(row("r3", "Three"));
    expect(checked).toHaveLength(2);
    results[1]!({ step: 1, end: 100 });
    await settle();
    expect(live.history().map((m) => m.uuid)).toEqual(["p2", "r2", "r3"]);
  });

  // Review round 3 item 5: a row that arrived during a pending check was
  // no trigger, and a pending newest candidate held back older ones.
  it("retries a pending candidate for a row that arrived during its check, and tries an older one meanwhile", async () => {
    const { live, clock, checked, results, add, settle } = projection();
    for (const id of ["p1", "r1", "p2", "r2", "p3"]) live.record(row(id, id));
    add(2, 0);
    add(4, 1_000);
    clock.now = 40_000;
    live.record(row("r3", "Three"));
    expect(checked.map((c) => c.seq)).toEqual([4]);
    // A new row while the check runs.
    live.record(row("r4", "Four"));
    results[0]!("pending");
    await settle();
    // The newest is due again (r4 came after its check started).
    expect(checked.map((c) => c.seq)).toEqual([4, 4]);
    results[1]!("pending");
    await settle();
    // Still pending with no new row: the older one is tried instead.
    expect(checked.map((c) => c.seq)).toEqual([4, 4, 2]);
    results[2]!({ step: 1, end: 100 });
    await settle();
    expect(live.history()[0]!.uuid).toBe("p2");
  });

  it("checks and moves nothing once closed, even when a check was in flight", async () => {
    const { live, clock, checked, results, add, settle } = projection();
    for (const id of ["p1", "r1", "p2", "r2"]) live.record(row(id, id));
    add(2, 0);
    clock.now = 40_000;
    live.record(row("r3", "Three"));
    live.close();
    results[0]!({ step: 1, end: 100 });
    await settle();
    expect(live.boundary).toEqual(EMPTY_ANTIGRAVITY_LOG);
    expect(live.has("p1")).toBe(true);
    add(4, 1_000);
    live.record(row("r4", "Four"));
    expect(checked).toHaveLength(1);
  });

  // Plan 195 step 7: the proof assumes one writer.
  it("drops every candidate when another writer is seen, discards a check under way, and moves at a later prompt", async () => {
    const { live, clock, checked, results, add, settle } = projection();
    for (const id of ["p1", "r1", "p2", "r2"]) live.record(row(id, id));
    add(0, 0);
    add(2, 1_000);
    clock.now = 40_000;
    live.record(row("r3", "Three"));
    expect(checked.map((c) => c.seq)).toEqual([2]);
    live.foreignWrite();
    results[0]!({ step: 1, end: 100 });
    await settle();
    expect(live.boundary).toEqual(EMPTY_ANTIGRAVITY_LOG);
    live.record(row("r4", "Four"));
    expect(checked).toHaveLength(1);
    add(live.seq, 40_000);
    live.record(row("p5", "Five", "user"));
    clock.now = 80_000;
    live.record(row("r5", "Five done"));
    expect(checked.map((c) => c.seq)).toEqual([2, 6]);
    results[1]!({ step: 9, end: 900 });
    await settle();
    expect(live.boundary).toEqual({ step: 9, end: 900 });
    expect(live.history().map((m) => m.uuid)).toEqual(["p5", "r5"]);
  });

  it("caps the rows, never recreates an evicted row, and keeps the title", () => {
    const live = new AntigravityLiveProjection(EMPTY_ANTIGRAVITY_LOG);
    const mib = (n: number) => "x".repeat(n * 1024 * 1024);
    live.record(row("first", "Hello", "user"));
    live.record(row("a", mib(2)));
    live.record(row("b", mib(4)));
    // The oldest row grows past the cap: another row goes.
    live.record(row("a", mib(5)));
    expect(live.has("a")).toBe(true);
    expect(live.incomplete).toBe(true);
    // An update for an evicted row adds nothing back.
    live.record(row("first", "late"));
    expect(live.has("first")).toBe(false);
    // The title survives its row's eviction.
    expect(live.firstPrompt).toBe("Hello");
  });

  // Review round 3 items 2 and 7: the truncator cut one string at a time,
  // serializing the row each time (over four seconds for these), and a
  // cut with no eviction left the view complete.
  it.each([
    ["a 20 MiB text row", () => "x".repeat(20 * 1024 * 1024)],
    [
      "9 MiB of 1,024-character strings in a tool input",
      () => ({
        items: Array.from({ length: 9 * 1024 }, () => "y".repeat(1024)),
      }),
    ],
    [
      "9 MiB of two-character strings in a tool input",
      () => Array.from({ length: (9 * 1024 * 1024) / 5 }, () => "ab"),
    ],
  ])(
    "stores %s cut to the cap in a few serializations, keeping its IDs, and is incomplete until it moves",
    async (_name, make) => {
      const { live, clock, results, add, settle } = projection();
      const payload = make();
      const huge: SDKMessage =
        typeof payload === "string"
          ? row("huge", payload)
          : {
              type: "assistant",
              uuid: "huge",
              message: {
                role: "assistant",
                content: [
                  {
                    type: "tool_use",
                    id: "tool-1",
                    name: "Write",
                    input: payload as Record<string, unknown>,
                  },
                ],
              },
            };
      const stringify = vi.spyOn(JSON, "stringify");
      const started = performance.now();
      live.record(huge);
      const elapsed = performance.now() - started;
      const serializations = stringify.mock.calls.length;
      stringify.mockRestore();
      expect(serializations).toBeLessThanOrEqual(5);
      expect(elapsed).toBeLessThan(2_000);
      const [kept] = live.history();
      expect(Buffer.byteLength(JSON.stringify(kept))).toBeLessThanOrEqual(
        8 * 1024 * 1024,
      );
      expect(kept).toMatchObject({
        uuid: "huge",
        message: { role: "assistant" },
      });
      const text = JSON.stringify(kept!.message!.content);
      expect(text).toContain("The live view keeps only the beginning");
      expect(text).not.toContain("full text is in the log");
      if (typeof payload !== "string")
        expect(kept!.message!.content).toMatchObject([
          { type: "tool_use", id: "tool-1", name: "Write" },
        ]);
      // The view is not complete while the cut row is held; a move ends it.
      expect(live.incomplete).toBe(true);
      live.record(row("p", "Next", "user"));
      add(1, 0);
      clock.now = 40_000;
      live.record(row("r", "Reply"));
      results[0]!({ step: 1, end: 100 });
      await settle();
      expect(live.has("huge")).toBe(false);
      expect(live.incomplete).toBe(false);
    },
  );

  // Review round 4 finding 3: a row quoting the notice was taken for cut.
  it("leaves the view complete for an ordinary row that ends with the notice's text", () => {
    const live = new AntigravityLiveProjection(EMPTY_ANTIGRAVITY_LOG);
    live.record(
      row("quote", `As YA says:${ANTIGRAVITY_LIVE_CUT_NOTICE}`, "user"),
    );
    expect(live.incomplete).toBe(false);
  });

  // Review round 4 finding 6: an overflowing chunk was dropped whole.
  it("keeps the part of an overflowing chunk that fits, then the notice", () => {
    const transcript = new AntigravityTranscript(ID, `${ID}:turn`);
    const [snapshot] = transcript.accept({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "é".repeat((9 * 1024 * 1024) / 2) },
    });
    const content = String(snapshot!.message!.content);
    expect(content.endsWith(ANTIGRAVITY_LIVE_CUT_NOTICE)).toBe(true);
    const kept = content.slice(0, -ANTIGRAVITY_LIVE_CUT_NOTICE.length);
    expect(Buffer.byteLength(kept, "utf8")).toBe(8 * 1024 * 1024);
    expect(kept).toBe("é".repeat((8 * 1024 * 1024) / 2));
  });

  // Review round 3 item 8: the block being assembled grew without bound.
  it("stops a live text block at the cap, with the same notice, and marks the view incomplete", () => {
    const transcript = new AntigravityTranscript(ID, `${ID}:turn`);
    const chunk = "z".repeat(1024 * 1024);
    let last: SDKMessage | undefined;
    for (let i = 0; i < 10; i++)
      for (const out of transcript.accept({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: chunk },
      }))
        last = out;
    const content = String(last!.message!.content);
    expect(content.length).toBeLessThan(8 * 1024 * 1024 + 1024);
    expect(content).toMatch(/The live view keeps only the beginning/);
    const live = new AntigravityLiveProjection(EMPTY_ANTIGRAVITY_LOG);
    live.record(transcript.close()!);
    expect(live.incomplete).toBe(true);
  });
});
