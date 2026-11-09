#!/usr/bin/env node
/**
 * Assign client E2E spec files to CI shards by measured time.
 *
 * Playwright's `--shard` cuts the ordered file list into contiguous runs of
 * equal case counts, and `PWTEST_SHARD_WEIGHTS` still counts cases. Our cases
 * range from 0.1s to 40s, so equal counts left one shard with more than twice
 * the other's work. This plans shards from per-file seconds instead and writes
 * a Playwright `--test-list` file for one shard.
 *
 *   plan --shard <i>/<n> --out <file>
 *       Longest-processing-time-first assignment of every spec file under
 *       packages/client/e2e. A file absent from the durations record gets the
 *       record's median, so a new spec still runs in exactly one shard.
 *   record <report.json>...
 *       Replace the durations record from Playwright JSON reports, one per
 *       shard of the same run. A file's time is the sum of its cases' final
 *       attempts, which includes its hooks and first-use worker fixtures.
 *
 * The plan depends only on the checked-out tree and the record, so every shard
 * of one CI run computes the same partition. Stale durations cost balance, not
 * coverage.
 */

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const testDir = join(repoRoot, "packages", "client", "e2e");
const recordPath = join(testDir, "shard-durations.json");
// Playwright's default testMatch.
const specPattern = /\.(spec|test)\.(c|m)?[jt]sx?$/;

function usage(message) {
  if (message) console.error(message);
  console.error(
    "usage: e2e-shard-plan.mjs plan --shard <i>/<n> --out <file>\n" +
      "       e2e-shard-plan.mjs record <report.json>...",
  );
  process.exit(2);
}

function listSpecFiles(dir = testDir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...listSpecFiles(path));
    else if (specPattern.test(entry.name))
      files.push(relative(testDir, path).split(sep).join("/"));
  }
  return files.sort();
}

function readRecord() {
  try {
    return JSON.parse(readFileSync(recordPath, "utf8")).seconds ?? {};
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
}

export function planShards(files, seconds, total) {
  const known = Object.values(seconds).sort((a, b) => a - b);
  const fallback = known.length ? known[Math.floor(known.length / 2)] : 1;
  const weighted = files.map((file) => ({
    file,
    weight: seconds[file] ?? fallback,
  }));
  // Heaviest first; the file name breaks ties so every shard agrees.
  weighted.sort((a, b) => b.weight - a.weight || a.file.localeCompare(b.file));
  const shards = Array.from({ length: total }, () => ({ load: 0, files: [] }));
  for (const item of weighted) {
    let target = shards[0];
    for (const shard of shards) if (shard.load < target.load) target = shard;
    target.load += item.weight;
    target.files.push(item.file);
  }
  return shards;
}

function plan(args) {
  let shardArg;
  let out;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--shard") shardArg = args[++i];
    else if (args[i] === "--out") out = args[++i];
    else usage(`unknown argument: ${args[i]}`);
  }
  const match = /^(\d+)\/(\d+)$/.exec(shardArg ?? "");
  if (!match || !out) usage("plan needs --shard <i>/<n> and --out <file>");
  const current = Number(match[1]);
  const total = Number(match[2]);
  if (current < 1 || current > total) usage(`invalid shard ${shardArg}`);

  const files = listSpecFiles();
  const shards = planShards(files, readRecord(), total);
  const mine = shards[current - 1];
  writeFileSync(out, `${mine.files.sort().join("\n")}\n`);
  const loads = shards.map((s) => `${Math.round(s.load)}s`).join(" / ");
  console.log(
    `E2E shard ${current}/${total}: ${mine.files.length} of ${files.length} files; planned loads ${loads}`,
  );
}

function record(reports) {
  if (!reports.length)
    usage("record needs at least one Playwright JSON report");
  const seconds = {};
  const visit = (suite, file) => {
    const owner = suite.file ?? file;
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests) {
        const final = test.results.at(-1);
        if (!final) continue;
        seconds[owner] = (seconds[owner] ?? 0) + final.duration / 1000;
      }
    }
    for (const child of suite.suites ?? []) visit(child, owner);
  };
  for (const path of reports) {
    for (const suite of JSON.parse(readFileSync(path, "utf8")).suites)
      visit(suite);
  }
  const sorted = Object.fromEntries(
    Object.entries(seconds)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([file, value]) => [file, Math.round(value * 10) / 10]),
  );
  writeFileSync(
    recordPath,
    `${JSON.stringify({ seconds: sorted }, null, 2)}\n`,
  );
  console.log(`Recorded ${Object.keys(sorted).length} spec files`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [command, ...rest] = process.argv.slice(2);
  if (command === "plan") plan(rest);
  else if (command === "record") record(rest);
  else usage();
}
