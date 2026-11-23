import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it } from "vitest";
import { setAntigravityLiveLimitsForTests } from "../../src/sdk/providers/antigravity-live-projection.js";
import {
  antigravityLiveHistory,
  antigravityOwnerView,
} from "../../src/sdk/providers/antigravity-owners.js";
import { nativeFixture } from "./fixture.js";
import { providers } from "./selection.js";

/**
 * Plan 195 step 2: what a live owner retains in YA's memory over a long run,
 * for Codex (the bar step 6 had to meet) and for Antigravity. Opt-in
 * measurement with real executables and a scripted model:
 *
 *   YEP_NATIVE_RETENTION_MEASURE=1 YEP_NATIVE_TEST_PROVIDERS=codex,antigravity \
 *     pnpm --filter @yep-anywhere/server test \
 *     test/native-provider/native-live-retention.test.ts --maxWorkers=1
 *
 * Every turn is the same scripted work: a short prompt and a 4 KiB reply.
 * Heap is sampled after a full GC, with the Process replay window
 * (time-bounded and shared by every provider), the fixture's event log and
 * the scripted model's request log emptied first, and before Antigravity's
 * projection is copied for counting, so the copy is not charged. Growth is
 * taken from the first sample after warm-up (one interval) to the final
 * turn, which is always sampled. Heap samples on one host are diagnostic.
 * Since plan 195 step 6 an Antigravity owner keeps a bounded recent window:
 * past a soft budget it moves its boundary to a proven split point. Here the
 * budget is lowered to {@link SOFT_BYTES} and split points may be used at
 * once (Process's replay window is not in play), so many moves happen. The
 * projection's count and bytes are asserted after every turn against the
 * budget plus two turns, and the heap is also sampled right after each move,
 * a comparable point of each sawtooth cycle.
 */
const turns = Number(process.env.YEP_NATIVE_RETENTION_TURNS ?? 200);
const reply = "R".repeat(4096);
/** The lowered soft budget: a move about every 28 turns by bytes... */
const SOFT_BYTES = 128 * 1024;
/** ...or about every 20 by rows, whichever comes first. */
const SOFT_ROWS = 40;

setFlagsFromString("--expose-gc");
const gc = runInNewContext("gc") as () => void;

let fixture: Awaited<ReturnType<typeof nativeFixture>> | undefined;
afterEach(async () => {
  setAntigravityLiveLimitsForTests();
  await fixture?.close();
  fixture = undefined;
});

describe
  .skipIf(!process.env.YEP_NATIVE_RETENTION_MEASURE)
  .each(
    providers.filter((provider) => ["codex", "antigravity"].includes(provider)),
  )("native live retention: %s", (provider) => {
  it(`retained memory across ${turns} turns`, async () => {
    if (provider === "antigravity")
      setAntigravityLiveLimitsForTests({
        softBytes: SOFT_BYTES,
        softRows: SOFT_ROWS,
        splitAgeMs: 0,
      });
    const f = await nativeFixture(provider);
    fixture = f;
    // Known once the first turn has reported the native identity.
    let scope: string | undefined;
    const projection = () => {
      const view = scope
        ? antigravityOwnerView(scope, f.nativeId())
        : undefined;
      return view?.state === "open" ? view : undefined;
    };
    const heap = () => {
      const proc = f.proc as unknown as {
        currentBucket: unknown[];
        previousBucket: unknown[];
      };
      proc.currentBucket = [];
      proc.previousBucket = [];
      f.events.length = 0;
      // The scripted model keeps every request body, each the whole history.
      f.model.requests.length = 0;
      for (let pass = 0; pass < 3; pass++) gc();
      return process.memoryUsage().heapUsed;
    };
    const sample = async (turn: number) => {
      const heapUsed = heap();
      // Copied only after the heap was read; the copy is then released.
      const history = scope
        ? antigravityLiveHistory(scope, f.nativeId())
        : undefined;
      return {
        turn,
        heapUsed,
        projectionMessages: history?.length,
        projectionJsonBytes: history
          ? Buffer.byteLength(JSON.stringify(history))
          : undefined,
      };
    };
    const interval = Math.max(1, Math.floor(turns / 4));
    const samples = [];
    const moves: Array<{ turn: number; heapUsed: number }> = [];
    let largestTurn = 0;
    let longestTurn = 0;
    let boundary: number | undefined;
    let peak = { messages: 0, bytes: 0 };
    const started = performance.now();
    for (let turn = 1; turn <= turns; turn++) {
      if (turn > 1)
        expect(
          f.proc.queueMessage({ text: `RETENTION_TURN_${turn}` }).success,
        ).toBe(true);
      (await f.model.next()).finish(`${reply} ${turn}`);
      await f.output(`${reply} ${turn}`);
      await f.idle();
      if (provider === "antigravity") {
        scope ??= await realpath(
          join(f.environment.GEMINI_HOME!, "antigravity-cli", "conversations"),
        );
        // Let the prompt's candidate check finish (it may move the boundary).
        await new Promise((resolve) => setTimeout(resolve, 20));
        const history = antigravityLiveHistory(scope, f.nativeId())!;
        const bytes = Buffer.byteLength(JSON.stringify(history));
        // This turn: its prompt's row and what followed.
        let start = history.length - 1;
        while (start > 0 && history[start]!.type !== "user") start--;
        const turnRows = history.slice(Math.max(0, start));
        const turnBytes = Buffer.byteLength(JSON.stringify(turnRows));
        largestTurn = Math.max(largestTurn, turnBytes);
        longestTurn = Math.max(longestTurn, turnRows.length);
        peak = {
          messages: Math.max(peak.messages, history.length),
          bytes: Math.max(peak.bytes, bytes),
        };
        // The bound, whatever the turn count: the budget and two turns, in
        // bytes and in rows.
        expect(bytes).toBeLessThanOrEqual(SOFT_BYTES + 2 * largestTurn);
        expect(history.length).toBeLessThanOrEqual(SOFT_ROWS + 2 * longestTurn);
        const end = projection()?.boundary?.end;
        if (boundary !== undefined && end !== boundary)
          moves.push({ turn, heapUsed: heap() });
        boundary = end;
      }
      if (turn === 1 || turn % interval === 0 || turn === turns)
        samples.push(await sample(turn));
    }
    const warm = samples.find((entry) => entry.turn >= interval)!;
    const last = samples.at(-1)!;
    // Comparable points of the sawtooth: right after each move from turn 150.
    const cycles = moves.filter((move) => move.turn >= interval);
    console.info(
      JSON.stringify({
        measurement: "native-live-retention",
        provider,
        version: f.version,
        node: process.version,
        turns,
        replyBytes: reply.length,
        seconds: Math.round((performance.now() - started) / 100) / 10,
        samples,
        warmTurn: warm.turn,
        heapGrowthFromWarm: last.heapUsed - warm.heapUsed,
        heapGrowthPerTurn: Math.round(
          (last.heapUsed - warm.heapUsed) / Math.max(1, last.turn - warm.turn),
        ),
        ...(provider === "antigravity"
          ? {
              softBytes: SOFT_BYTES,
              largestTurnBytes: largestTurn,
              peak,
              moves: moves.length,
              cycleHeap: cycles.map((move) => [move.turn, move.heapUsed]),
              cycleGrowth:
                cycles.length >= 2
                  ? cycles.at(-1)!.heapUsed - cycles[0]!.heapUsed
                  : undefined,
              maxConsecutiveCycleGrowth: Math.max(
                ...cycles
                  .slice(1)
                  .map(
                    (move, index) => move.heapUsed - cycles[index]!.heapUsed,
                  ),
              ),
            }
          : {}),
      }),
    );
    if (provider === "antigravity")
      expect(moves.length).toBeGreaterThanOrEqual(2);
    expect(f.model.failures).toEqual([]);
    expect(f.errors).toEqual([]);
  }, 600_000);
});
