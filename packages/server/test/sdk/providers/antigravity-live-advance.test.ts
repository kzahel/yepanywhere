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
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  antigravitySplitCandidate,
  antigravitySplitCheck,
} from "../../../src/sdk/providers/antigravity-live-advance.js";
import {
  AntigravityLiveProjection,
  type AntigravitySplitCandidate,
  EMPTY_ANTIGRAVITY_LOG,
  setAntigravityLiveLimitsForTests,
} from "../../../src/sdk/providers/antigravity-live-projection.js";
import type { AntigravityLogBoundary } from "../../../src/sdk/providers/antigravity-owners.js";
import type { SDKMessage } from "../../../src/sdk/types.js";

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

const candidate = () => antigravitySplitCandidate(scope, ID, 1)!;
const check = (
  taken: AntigravitySplitCandidate,
  boundary: AntigravityLogBoundary = EMPTY_ANTIGRAVITY_LOG,
) => antigravitySplitCheck(scope, ID)(taken, boundary);

describe("proving an Antigravity split candidate", () => {
  it("proves the record ending at the size taken at dispatch when a user input starts there", async () => {
    const first = input(0, "First") + reply(1, "Reply one");
    await writeFile(log, first);
    const taken = candidate();
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
    const afterError = candidate();
    await appendFile(log, input(2, "Again"));
    expect(await check(afterError)).toMatchObject({ step: 1 });
  });

  it("proves an empty log when the conversation's first input starts the file", async () => {
    await rm(log, { force: true });
    const taken = candidate();
    expect(taken).toMatchObject({ size: 0 });
    await writeFile(log, input(0, "First"));
    expect(await check(taken)).toEqual(EMPTY_ANTIGRAVITY_LOG);
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
        const taken = candidate();
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
        const taken = candidate();
        await appendFile(log, input(2, "Second"));
        return taken;
      },
    ],
    [
      "a wake record lands between the size and the prompt's input",
      async () => {
        await writeFile(log, input(0, "First") + reply(1, "Reply"));
        const taken = candidate();
        await appendFile(log, system(2, "task done") + input(3, "Second"));
        return taken;
      },
    ],
    [
      "the file was replaced",
      async () => {
        const text = input(0, "First") + reply(1, "Reply");
        await writeFile(log, text);
        const taken = candidate();
        await rm(log);
        await writeFile(log, text + input(2, "Second"));
        return taken;
      },
    ],
    [
      "the file was truncated",
      async () => {
        await writeFile(log, input(0, "First") + reply(1, "Reply"));
        const taken = candidate();
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
        const taken = candidate();
        await appendFile(log, input(2, "Second"));
        return taken;
      },
    ],
    [
      "the record ending there is too large to read",
      async () => {
        await writeFile(log, input(0, "First"));
        await appendFile(log, reply(1, "y".repeat(17 * 1024 * 1024)));
        const taken = candidate();
        await appendFile(log, input(2, "Second"));
        return taken;
      },
    ],
    [
      "no newline precedes the size (a record being written)",
      async () => {
        const partial = reply(1, "Reply");
        await writeFile(log, input(0, "First") + partial.slice(0, 20));
        const taken = candidate();
        await appendFile(log, partial.slice(20));
        await appendFile(log, input(2, "Second"));
        return taken;
      },
    ],
  ])("proves nothing when %s", async (_shape, arrange) => {
    expect(await check(await arrange())).toBeUndefined();
  });

  it("leaves a candidate pending until the prompt's input is logged", async () => {
    await writeFile(log, input(0, "First") + reply(1, "Reply"));
    const taken = candidate();
    expect(await check(taken)).toBe("pending");
    await rm(log);
    const none = candidate();
    expect(await check(none)).toBe("pending");
  });

  it("proves nothing before the current boundary or in a file it does not pin", async () => {
    const first = input(0, "First") + reply(1, "Reply");
    await writeFile(log, first + input(2, "Second") + reply(3, "Two"));
    const taken = { ...candidate(), size: first.length };
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
    () => clock.now,
  );
  const add = (seq: number, at: number) =>
    live.addCandidate({ seq, size: 100 + seq, at });
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  return { live, clock, checked, results, add, settle };
}

describe("a live Antigravity window", () => {
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

  it("caps the rows, stores one huge row cut to the cap with a notice, never recreates an evicted row, and keeps the title", () => {
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
    // One row of 20 MiB is kept at the cap, ending in a notice.
    live.record(row("huge", mib(20)));
    const [kept] = live.history();
    const stored = JSON.stringify(kept);
    expect(Buffer.byteLength(stored)).toBeLessThanOrEqual(8 * 1024 * 1024);
    expect(String(kept!.message!.content)).toMatch(
      /more bytes are in the log; this live view keeps the first part\]$/,
    );
  });
});
