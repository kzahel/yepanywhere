import { describe, expect, it } from "vitest";
import { planAntigravityAdvance } from "../../../src/sdk/providers/antigravity-live-advance.js";
import {
  ANTIGRAVITY_LIVE_BYTES,
  AntigravityLiveProjection,
  type AntigravityExpectation,
  EMPTY_ANTIGRAVITY_LOG,
} from "../../../src/sdk/providers/antigravity-live-projection.js";
import type { AntigravityLogTailRecord } from "../../../src/sessions/antigravity-log-tail.js";
import type { SDKMessage } from "../../../src/sdk/types.js";

let offset = 0;
const record = (
  step: number,
  type: AntigravityLogTailRecord["type"],
  extra: Partial<AntigravityLogTailRecord> = {},
): AntigravityLogTailRecord => {
  const start = offset;
  offset += 100;
  return { step, type, start, end: offset, witness: `w${step}`, ...extra };
};
const user = (step: number, text: string) =>
  record(step, "USER_INPUT", { text });
const reply = (step: number, calls = 0) =>
  record(step, "PLANNER_RESPONSE", { calls });
const prompt = (
  seq: number,
  text: string,
  turnStart = true,
): AntigravityExpectation => ({
  kind: "prompt",
  text,
  seq,
  rowId: `row-${seq}`,
  turnStart,
});
const source = { dev: 1, ino: 2 };

describe("when a live Antigravity owner's rows leave memory", () => {
  it("moves to the turn's end at its result once the log holds every prompt and a turn-ending record", () => {
    offset = 0;
    // A steered turn: two prompts, a tool call, the final reply.
    const records = [
      user(0, "First"),
      reply(1, 1),
      record(2, "GENERIC"),
      user(3, "Steer"),
      reply(4),
    ];
    const expectations = [prompt(0, "First"), prompt(3, "Steer", false)];
    const plan = planAntigravityAdvance({
      boundary: EMPTY_ANTIGRAVITY_LOG,
      records,
      source,
      expectations,
      quietSeq: 6,
    });
    expect(plan).toEqual({
      boundary: { step: 4, start: 400, end: 500, witness: "w4", ...source },
      evictBefore: 6,
      consumed: 2,
      aliases: [
        ["row-0", { after: 0, before: 0 }],
        ["row-3", { after: 3, before: 3 }],
      ],
    });
    // The reply not logged yet, a call still open, or a prompt sent after
    // the quiet point: not at this result.
    for (const [tail, sent] of [
      [records.slice(0, 4), expectations],
      [records.slice(0, 2), expectations.slice(0, 1)],
      [records, [...expectations, prompt(7, "Later")]],
    ] as const) {
      const fallback = planAntigravityAdvance({
        boundary: EMPTY_ANTIGRAVITY_LOG,
        records: tail,
        source,
        expectations: sent,
        quietSeq: 6,
      });
      // Only the turn's own first prompt bounds anything then: nothing before it.
      expect(fallback?.evictBefore ?? 0).toBe(0);
    }
  });

  it("moves to the record before a later turn's prompt, dropping rows for steps the log never recorded", () => {
    offset = 0;
    // A stopped turn whose reply was never logged, then the next turn.
    const records = [user(10, "Stopped"), user(11, "Next")];
    const plan = planAntigravityAdvance({
      boundary: { step: 9, end: 0 },
      records,
      source,
      expectations: [prompt(0, "Stopped"), prompt(5, "Next")],
    });
    expect(plan).toMatchObject({
      boundary: { step: 10, start: 0, end: 100 },
      evictBefore: 5,
      consumed: 1,
      aliases: [["row-0", { after: 10, before: 10 }]],
    });
  });

  it("aliases a verified compaction's row to its checkpoint and passes over a command agy did not log", () => {
    offset = 0;
    const compact = (seq: number, rowId?: string): AntigravityExpectation => ({
      kind: "compact",
      text: "/compact keep",
      seq,
      turnStart: false,
      ...(rowId ? { rowId } : {}),
    });
    const logged = planAntigravityAdvance({
      boundary: EMPTY_ANTIGRAVITY_LOG,
      records: [user(0, "/compact keep"), record(1, "CHECKPOINT"), reply(2)],
      source,
      expectations: [compact(0, "boundary-row")],
      quietSeq: 1,
    });
    // A command ends like a turn: its boundary row reads its checkpoint.
    expect(logged).toMatchObject({
      boundary: { step: 2 },
      evictBefore: 1,
      aliases: [["boundary-row", { after: 1, before: 1 }]],
    });
    offset = 0;
    const turn = planAntigravityAdvance({
      boundary: EMPTY_ANTIGRAVITY_LOG,
      records: [
        user(0, "Ask"),
        reply(1),
        user(2, "/compact keep"),
        record(3, "CHECKPOINT"),
        reply(4),
      ],
      source,
      expectations: [prompt(0, "Ask"), compact(2, "boundary-row"), compact(3)],
      quietSeq: 4,
    });
    expect(turn?.boundary.step).toBe(4);
    expect(turn?.aliases).toEqual([
      ["row-0", { after: 0, before: 0 }],
      ["boundary-row", { after: 3, before: 3 }],
    ]);
  });

  it("never advances past a user input YA did not send", () => {
    offset = 0;
    expect(
      planAntigravityAdvance({
        boundary: EMPTY_ANTIGRAVITY_LOG,
        records: [user(0, "Someone else"), reply(1)],
        source,
        expectations: [prompt(0, "Mine")],
        quietSeq: 2,
      }),
    ).toBeUndefined();
  });
});

describe("a live Antigravity projection", () => {
  const row = (uuid: string, text: string): SDKMessage => ({
    type: "assistant",
    uuid,
    message: { role: "assistant", content: text },
  });

  it("drops the oldest row at the cap, reports itself incomplete until an advance covers it, and ignores late updates", () => {
    const live = new AntigravityLiveProjection(EMPTY_ANTIGRAVITY_LOG);
    const big = "x".repeat(3 * 1024 * 1024);
    for (const id of ["a", "b", "c"]) live.record(row(id, big));
    expect(live.history().map((m) => m.uuid)).toEqual(["b", "c"]);
    expect(live.retainedBytes).toBeLessThanOrEqual(ANTIGRAVITY_LIVE_BYTES);
    expect(live.incomplete).toBe(true);
    live.record(row("a", "late"));
    expect(live.has("a")).toBe(false);
    // An advance past the dropped row makes the view whole again.
    expect(
      live.advance(
        {
          boundary: { step: 3, end: 10 },
          evictBefore: live.seqOf("c")!,
          consumed: 0,
          aliases: [],
        },
        live.boundaryVersion,
      ),
    ).toBe(true);
    expect(live.incomplete).toBe(false);
    expect(live.history().map((m) => m.uuid)).toEqual(["c"]);
    // The newest row it dropped continues after the new boundary, and the
    // turn it moved stays as streamed for clients that hold it.
    expect(live.alias("b")).toEqual({ after: 3 });
    expect(live.movedIndex("b")).toBe(0);
    expect(live.moved?.before).toEqual(EMPTY_ANTIGRAVITY_LOG);
    // Over the cap again, the moved copy goes before any row.
    live.record(row("d", big));
    expect(live.moved).toEqual({ before: EMPTY_ANTIGRAVITY_LOG });
    expect(live.history().map((m) => m.uuid)).toEqual(["c", "d"]);
    expect(live.incomplete).toBe(false);
    // A plan read under an earlier boundary is not applied.
    expect(
      live.advance(
        {
          boundary: { step: 5, end: 20 },
          evictBefore: 99,
          consumed: 0,
          aliases: [],
        },
        0,
      ),
    ).toBe(false);
  });
});
