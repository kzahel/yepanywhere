// Plan 195 scale target: a synthetic agy conversation of ~500 MB / 100,000
// steps, built from real record shapes. Run by hand from packages/server:
//   pnpm exec tsx --conditions source ../../scripts/perf-repro/antigravity-scale-log.mjs \
//     --out <empty dir> [--steps 100000] [--bytes 500000000] [--id <uuid>]
//     [--cwd <project>] [--checkpoint-every 2000] [--skip-every 25000] [--verify]
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
});
const report = {
  ...result,
  writeSeconds: Math.round((performance.now() - started) / 100) / 10,
};

if (argv.includes("--verify")) {
  // The invariants a log reader may rely on: strictly increasing step_index
  // and k results after a planner record with k tool calls.
  const verifyStarted = performance.now();
  let previous = -1;
  let expectedResults = 0;
  let lines = 0;
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
    if (expectedResults > 0) {
      assert.equal(
        record.type,
        "GENERIC",
        `step ${record.step_index} breaks pairing`,
      );
      expectedResults--;
    } else if (record.type === "PLANNER_RESPONSE")
      expectedResults = record.tool_calls?.length ?? 0;
    lines++;
  }
  assert.equal(lines, result.records);
  report.verifySeconds =
    Math.round((performance.now() - verifyStarted) / 100) / 10;
}
console.log(JSON.stringify(report, null, 2));
