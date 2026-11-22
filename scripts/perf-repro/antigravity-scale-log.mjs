// Plan 195 scale target: a synthetic agy conversation of ~500 MB / 100,000
// steps, built from real record shapes. Run by hand from packages/server:
//   pnpm exec tsx --conditions source ../../scripts/perf-repro/antigravity-scale-log.mjs \
//     --out <empty dir> [--steps 100000] [--bytes 500000000] [--id <uuid>]
//     [--cwd <project>] [--checkpoint-every 2000] [--skip-every 25000]
//     [--interrupted-group-every <steps>] [--interior-gap-group-every <steps>]
//     [--verify]
// Writes <out>/antigravity-cli/{brain,conversations,conversation_summaries.db}
// so YA's readers can open it with --gemini-dir <out>. Real agy cannot load
// it (no protobuf payloads); use antigravity-native-probe.mjs resume-large
// for a real conversation. Keep the output out of git.
import assert from "node:assert/strict";
import { createReadStream, existsSync, readdirSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const repo = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const { writeAntigravityScaleConversation } = await import(
  join(repo, "packages/server/test/utils/antigravity-scale-log.ts")
);
const argv = process.argv.slice(2);
const option = (name, fallback) => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : fallback;
};
const out = option("out");
assert(out, "Pass --out <empty directory>");
assert(
  !existsSync(out) || readdirSync(out).length === 0,
  "--out must be empty or absent",
);
const store = join(resolve(out), "antigravity-cli");
const cwd = resolve(option("cwd", join(resolve(out), "project")));
await mkdir(cwd, { recursive: true });
const started = performance.now();
const result = await writeAntigravityScaleConversation({
  store,
  id: option("id", "19500000-0000-4000-8000-000000000195"),
  cwd,
  steps: Number(option("steps", 100_000)),
  targetBytes: Number(option("bytes", 500_000_000)),
  checkpointEvery: Number(option("checkpoint-every", 2000)),
  skipEvery: Number(option("skip-every", 25_000)),
  interruptedGroupEvery: Number(option("interrupted-group-every", 0)),
  interiorGapGroupEvery: Number(option("interior-gap-group-every", 0)),
});
const report = {
  ...result,
  writeSeconds: Math.round((performance.now() - started) / 100) / 10,
};

if (argv.includes("--verify")) {
  // The invariants a log reader may rely on, by step index: step_index
  // strictly increases, and a planner record at step P with k calls owns
  // steps P+1..P+k, with call i's result at P+1+i. Every group must be
  // complete except the requested ones, whose missing steps must be exactly
  // the omitted calls' and whose next record must be USER_INPUT (suffix) or
  // another group's planner record (interior). Nothing may end the file
  // inside a group.
  const verifyStarted = performance.now();
  const requested = new Map(
    result.interruptedGroups.map((group) => [group.planner, group]),
  );
  let previous = -1;
  let open;
  let lines = 0;
  let shortGroups = 0;
  const close = (next) => {
    const missing = [];
    for (let i = 0; i < open.calls; i++)
      if (!open.present.has(i)) missing.push(i);
    if (missing.length) {
      const expected = requested.get(open.planner);
      assert(expected, `planner ${open.planner} lacks results ${missing}`);
      assert.deepEqual(missing, expected.omitted, `planner ${open.planner}`);
      assert(next, `planner ${open.planner} ends the file inside its group`);
      assert(
        expected.shape === "suffix"
          ? next.type === "USER_INPUT"
          : next.type === "PLANNER_RESPONSE" && next.tool_calls?.length,
        `planner ${open.planner} (${expected.shape}) is followed by ${next.type}`,
      );
      shortGroups++;
    }
    open = undefined;
  };
  for await (const line of createInterface({
    input: createReadStream(result.fullPath),
    crlfDelay: Number.POSITIVE_INFINITY,
  })) {
    const record = JSON.parse(line);
    const step = record.step_index;
    assert(step > previous, `step ${step} not increasing`);
    previous = step;
    lines++;
    if (open && step > open.planner + open.calls) close(record);
    if (record.type === "GENERIC") {
      assert(open, `step ${step} is a result outside every group's steps`);
      open.present.add(step - open.planner - 1);
      if (open.present.size === open.calls) open = undefined;
      continue;
    }
    assert(
      !open,
      `step ${step} (${record.type}) is inside planner ${open?.planner}'s steps`,
    );
    if (record.type === "PLANNER_RESPONSE" && record.tool_calls?.length)
      open = {
        planner: step,
        calls: record.tool_calls.length,
        present: new Set(),
      };
  }
  if (open) close(undefined);
  assert.equal(lines, result.records);
  assert.equal(shortGroups, result.interruptedGroups.length);
  report.verifiedShortGroups = shortGroups;
  report.verifySeconds =
    Math.round((performance.now() - verifyStarted) / 100) / 10;
}
console.log(JSON.stringify(report, null, 2));
