// Plan 195 scale target: a synthetic agy conversation of ~500 MB / 100,000
// steps, built from real record shapes. Run by hand from packages/server:
//   pnpm exec tsx --conditions source ../../scripts/perf-repro/antigravity-scale-log.mjs \
//     --out <empty dir> [--steps 100000] [--bytes 500000000] [--id <uuid>]
//     [--cwd <project>] [--checkpoint-every 2000] [--skip-every 25000]
//     [--interrupted-group-every <steps>] [--verify]
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
});
const report = {
  ...result,
  writeSeconds: Math.round((performance.now() - started) / 100) / 10,
};

if (argv.includes("--verify")) {
  // The invariants a log reader may rely on: strictly increasing
  // step_index, and k results after a planner record with k tool calls. A
  // group with fewer results is accepted only where the generator was asked
  // for an interrupted group, and only when another record type (or the
  // end of the file) follows it.
  const verifyStarted = performance.now();
  const interrupted = new Map(
    result.interruptedGroups.map((group) => [group.planner, group]),
  );
  let previous = -1;
  let open;
  let lines = 0;
  let shortGroups = 0;
  const closeShort = (where) => {
    const expected = interrupted.get(open.planner);
    assert(
      expected && expected.logged === open.results,
      `planner ${open.planner} has ${open.results} of ${open.calls} results before ${where}`,
    );
    shortGroups++;
    open = undefined;
  };
  for await (const line of createInterface({
    input: createReadStream(result.fullPath),
    crlfDelay: Number.POSITIVE_INFINITY,
  })) {
    const record = JSON.parse(line);
    assert(
      record.step_index > previous,
      `step ${record.step_index} not increasing`,
    );
    previous = record.step_index;
    lines++;
    if (record.type === "GENERIC") {
      assert(open, `step ${record.step_index} is a result with no open group`);
      if (++open.results === open.calls) open = undefined;
      continue;
    }
    if (open) closeShort(`step ${record.step_index}`);
    if (record.type === "PLANNER_RESPONSE" && record.tool_calls?.length)
      open = {
        planner: record.step_index,
        calls: record.tool_calls.length,
        results: 0,
      };
  }
  if (open) closeShort("the end of the file");
  assert.equal(lines, result.records);
  assert.equal(shortGroups, result.interruptedGroups.length);
  report.verifiedInterruptedGroups = shortGroups;
  report.verifySeconds =
    Math.round((performance.now() - verifyStarted) / 100) / 10;
}
console.log(JSON.stringify(report, null, 2));
