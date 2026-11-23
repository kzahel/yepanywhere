import {
  appendFile,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AntigravityLiveAdvancer } from "../../../src/sdk/providers/antigravity-live-advance.js";
import {
  AntigravityLiveProjection,
  EMPTY_ANTIGRAVITY_LOG,
  setAntigravityLiveLimitsForTests,
} from "../../../src/sdk/providers/antigravity-live-projection.js";
import { AntigravityLogTail } from "../../../src/sessions/antigravity-log-tail.js";
import type { SDKMessage } from "../../../src/sdk/types.js";

const ID = "c0ffee00-0000-4000-8000-000000000206";
const at = "2026-11-23T08:00:00Z";
const record = (step: number, type: string, fields: object = {}) =>
  `${JSON.stringify({
    step_index: step,
    source:
      type === "USER_INPUT"
        ? "USER_EXPLICIT"
        : type === "SYSTEM_MESSAGE"
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

/** A new session's owner with its advancer and an update counter. */
function owner() {
  setAntigravityLiveLimitsForTests({ softRows: 2, splitAgeMs: 0 });
  const live = new AntigravityLiveProjection(EMPTY_ANTIGRAVITY_LOG);
  const state = { idle: true, updates: 0, passes: 0 };
  const advancer = new AntigravityLiveAdvancer({
    scope,
    conversationId: ID,
    projection: live,
    signal: new AbortController().signal,
    idle: () => state.idle,
    updates: () => state.updates,
    onPass: () => state.passes++,
  });
  /** Ends a turn and waits for its pass. */
  const ended = async () => {
    const before = state.passes;
    advancer.ended();
    while (state.passes === before)
      await new Promise((resolve) => setImmediate(resolve));
  };
  return { live, state, advancer, ended };
}

describe("where a live Antigravity owner may move its boundary", () => {
  it("splits at a prompt sent after an idle pass reached the log's end, once its input follows that end", async () => {
    const { live, advancer, ended } = owner();
    live.record(row("p1", "First", "user"));
    advancer.prompt("p1", "First", true);
    live.record(row("r1", "Reply one"));
    await writeFile(log, input(0, "First") + reply(1, "Reply one"));
    await ended();
    // Nothing arrived since that pass started: the next prompt is a split.
    live.record(row("p2", "Second", "user"));
    advancer.prompt("p2", "Second", true);
    await appendFile(log, input(2, "Second"));
    live.record(row("r2", "Reply two"));
    await appendFile(log, reply(3, "Reply two"));
    await ended();
    // Over the soft budget of two rows: the turn before the split left.
    expect(live.history().map((m) => m.uuid)).toEqual(["p2", "r2"]);
    expect(live.boundary).toMatchObject({ step: 1 });
    expect(live.retired("r1")).toBe(true);
    expect(advancer.stoppedReason).toBeUndefined();
  });

  it("is no split when any update arrived after that pass started, or a record lies between it and the prompt", async () => {
    for (const shape of ["a wake chunk before the prompt", "a record first"]) {
      const { live, state, advancer, ended } = owner();
      live.record(row("p1", "First", "user"));
      advancer.prompt("p1", "First", true);
      live.record(row("r1", "Reply one"));
      await writeFile(log, input(0, "First") + reply(1, "Reply one"));
      await ended();
      let next = 2;
      if (shape === "a wake chunk before the prompt") {
        // A detached wake streams, then the prompt goes out.
        state.updates++;
        live.record(row("w", "Wake reply"));
      } else {
        // A wake's task-end message lands before the prompt's input.
        await appendFile(
          log,
          record(next++, "SYSTEM_MESSAGE", { content: "task done" }),
        );
      }
      live.record(row("p2", "Second", "user"));
      advancer.prompt("p2", "Second", true);
      if (shape === "a wake chunk before the prompt")
        await appendFile(log, reply(next++, "Wake reply"));
      await appendFile(log, input(next, "Second") + reply(next + 1, "Two"));
      live.record(row("r2", "Two"));
      await ended();
      expect(live.history().length, shape).toBeGreaterThan(2);
      expect(live.boundary, shape).toEqual(EMPTY_ANTIGRAVITY_LOG);
      expect(advancer.stoppedReason, shape).toBeUndefined();
      await rm(log);
    }
  });

  it("stops for good at a user input YA did not send, holding only bounded evidence of what it sent", async () => {
    const { live, advancer, ended } = owner();
    live.record(row("p1", "Mine", "user"));
    advancer.prompt("p1", "x".repeat(1024 * 1024), true);
    await writeFile(log, input(0, "Someone else"));
    await ended();
    expect(advancer.stoppedReason).toBe("a user input YA did not send");
    // A blank foreign input with nothing expected stops the same way.
    const second = owner();
    await writeFile(log, input(0, " "));
    await second.ended();
    expect(second.advancer.stoppedReason).toBe("a user input YA did not send");
  });
});

describe("an Antigravity log tail", () => {
  it("crosses a 96 MiB record and many small records a pass at a time, reading each byte about once", async () => {
    const first = input(0, "Ask");
    const big = record(1, "PLANNER_RESPONSE", {
      content: "y".repeat(96 * 1024 * 1024),
    });
    const small = Array.from({ length: 2000 }, (_, i) =>
      reply(2 + i, "z".repeat(4096)),
    ).join("");
    await writeFile(log, first);
    await appendFile(log, big);
    await appendFile(log, small + input(2002, "Next"));
    const total = first.length + big.length + small.length;
    const tail = new AntigravityLogTail(scope, ID, EMPTY_ANTIGRAVITY_LOG);
    const signal = new AbortController().signal;
    const records: string[] = [];
    let passes = 0;
    for (;;) {
      const pass = await tail.pass(signal, 8 * 1024 * 1024);
      if (pass.status !== "read") throw Error(pass.status);
      passes++;
      for (const entry of pass.records)
        records.push(`${entry.step}:${entry.type}`);
      if (pass.reachedEnd) break;
    }
    expect(records.at(-1)).toBe("2002:USER_INPUT");
    expect(records).toHaveLength(2003);
    expect(passes).toBeGreaterThanOrEqual(13);
    expect(tail.bytesRead).toBeLessThan(total * 1.05);
    // A pass with nothing new reads nothing.
    const before = tail.bytesRead;
    expect(await tail.pass(signal)).toMatchObject({ reachedEnd: true });
    expect(tail.bytesRead).toBe(before);
  }, 30_000);
});

describe("a live Antigravity projection", () => {
  it("caps the rows, evicting another row when an update grows the oldest, never recreating an evicted row, keeping the title", () => {
    const live = new AntigravityLiveProjection(EMPTY_ANTIGRAVITY_LOG);
    const mib = (n: number) => "x".repeat(n * 1024 * 1024);
    live.record(row("first", "Hello", "user"));
    live.record(row("a", mib(2)));
    live.record(row("b", mib(4)));
    // The oldest row grows past the cap: another row goes.
    live.record(row("a", mib(5)));
    expect(live.retainedBytes).toBeLessThanOrEqual(8 * 1024 * 1024 + 1024);
    expect(live.has("a")).toBe(true);
    expect(live.incomplete).toBe(true);
    // An update for an evicted row adds nothing back.
    live.record(row("first", "late"));
    expect(live.has("first")).toBe(false);
    // The title survives its row's eviction.
    expect(live.firstPrompt).toBe("Hello");
  });
});
