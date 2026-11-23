import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it } from "vitest";
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
 * Since plan 195 step 6 an Antigravity owner moves an ended turn to the log
 * just after its result, keeping a copy of the turn it moved last for
 * clients that streamed it: each sample also records the projection at
 * idle, then waits (at most two seconds) for that move before sampling,
 * and counts that copy separately.
 */
const turns = Number(process.env.YEP_NATIVE_RETENTION_TURNS ?? 200);
const reply = "R".repeat(4096);

setFlagsFromString("--expose-gc");
const gc = runInNewContext("gc") as () => void;

let fixture: Awaited<ReturnType<typeof nativeFixture>> | undefined;
afterEach(async () => {
  await fixture?.close();
  fixture = undefined;
});

describe
  .skipIf(!process.env.YEP_NATIVE_RETENTION_MEASURE)
  .each(
    providers.filter((provider) => ["codex", "antigravity"].includes(provider)),
  )("native live retention: %s", (provider) => {
  it(`retained memory across ${turns} turns`, async () => {
    const f = await nativeFixture(provider);
    fixture = f;
    // Known once the first turn has reported the native identity.
    let scope: string | undefined;
    const sample = async (turn: number) => {
      if (provider === "antigravity")
        scope ??= await realpath(
          join(f.environment.GEMINI_HOME!, "antigravity-cli", "conversations"),
        );
      const atIdle = scope
        ? antigravityLiveHistory(scope, f.nativeId())?.length
        : undefined;
      for (
        const deadline = Date.now() + 2_000;
        scope &&
        Date.now() < deadline &&
        antigravityLiveHistory(scope, f.nativeId())?.length;
      )
        await new Promise((resolve) => setTimeout(resolve, 10));
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
      const heapUsed = process.memoryUsage().heapUsed;
      // Copied only after the heap was read; the copy is then released.
      const history = scope
        ? antigravityLiveHistory(scope, f.nativeId())
        : undefined;
      const view = scope
        ? antigravityOwnerView(scope, f.nativeId())
        : undefined;
      const moved = view?.state === "open" ? view.movedRows() : undefined;
      return {
        turn,
        heapUsed,
        projectionMessagesAtIdle: atIdle,
        projectionMessages: history?.length,
        projectionJsonBytes: history
          ? Buffer.byteLength(JSON.stringify(history))
          : undefined,
        movedMessages: moved?.length,
        movedJsonBytes: moved
          ? Buffer.byteLength(JSON.stringify(moved))
          : undefined,
      };
    };
    const interval = Math.max(1, Math.floor(turns / 4));
    const samples = [];
    const started = performance.now();
    for (let turn = 1; turn <= turns; turn++) {
      if (turn > 1)
        expect(
          f.proc.queueMessage({ text: `RETENTION_TURN_${turn}` }).success,
        ).toBe(true);
      (await f.model.next()).finish(`${reply} ${turn}`);
      await f.output(`${reply} ${turn}`);
      await f.idle();
      if (turn === 1 || turn % interval === 0 || turn === turns)
        samples.push(await sample(turn));
    }
    const warm = samples.find((entry) => entry.turn >= interval)!;
    const last = samples.at(-1)!;
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
      }),
    );
    expect(f.model.failures).toEqual([]);
    expect(f.errors).toEqual([]);
  }, 600_000);
});
