#!/usr/bin/env node
/**
 * Count browser cases that needed a retry across recent CI runs.
 *
 * A case that fails its first attempt and passes Playwright's in-shard retry
 * leaves its shard job green, so job results and run conclusions hide it. Each
 * shard uploads a Playwright JSON report (`e2e-report-shard-<i>-<attempt>`)
 * that records every attempt; this downloads those reports with gh and counts,
 * per case, how many runs were flaky (passed on retry) or failed every attempt.
 *
 *   e2e-flake-report.mjs [--since YYYY-MM-DD] [--branch main] [--min 1]
 *                        [--case <substring>] [--cache <dir>]
 *
 * --since defaults to seven days ago; artifacts are retained for 14 days.
 * --case prints each failing attempt of matching cases with its error, worker
 * and duration. Reports are cached by run, so a repeat invocation only
 * downloads new runs. See topics/e2e-testing.md#measuring-value-time-and-instability.
 */

import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify, stripVTControlCharacters } from "node:util";

const run = promisify(execFile);
const options = {
  since: new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10),
  branch: "main",
  min: 1,
  case: undefined,
  cache: join(tmpdir(), "yep-e2e-flake-reports"),
};
const argv = process.argv.slice(2);
for (let index = 0; index < argv.length; index += 2) {
  const key = argv[index]?.replace(/^--/, "");
  if (!key || !(key in options) || argv[index + 1] === undefined) {
    console.error(
      "usage: e2e-flake-report.mjs [--since YYYY-MM-DD] [--branch main] [--min 1] [--case <substring>] [--cache <dir>]",
    );
    process.exit(2);
  }
  options[key] = key === "min" ? Number(argv[index + 1]) : argv[index + 1];
}

async function gh(args) {
  return (await run("gh", args, { maxBuffer: 64 * 1024 * 1024 })).stdout;
}

const runs = JSON.parse(
  await gh([
    "run",
    "list",
    "--workflow",
    "CI",
    "--branch",
    options.branch,
    "--created",
    `>=${options.since}`,
    "--limit",
    "500",
    "--json",
    "databaseId,headSha,createdAt,status",
  ]),
).filter((entry) => entry.status === "completed");

mkdirSync(options.cache, { recursive: true });
const pending = runs.filter(
  (entry) => !existsSync(join(options.cache, String(entry.databaseId))),
);
async function download(entry) {
  const dir = join(options.cache, String(entry.databaseId));
  try {
    await gh([
      "run",
      "download",
      String(entry.databaseId),
      "--pattern",
      "e2e-report-shard-*",
      "--dir",
      dir,
    ]);
  } catch {
    // Expired, cancelled before upload, or no browser shards: record nothing.
    mkdirSync(dir, { recursive: true });
  }
}
for (let index = 0; index < pending.length; index += 6)
  await Promise.all(pending.slice(index, index + 6).map(download));

const cases = new Map();
function visit(suite, file, context) {
  for (const child of suite.suites ?? [])
    visit(child, child.file ?? file, context);
  for (const spec of suite.specs ?? []) {
    for (const test of spec.tests ?? []) {
      const key = `${spec.file ?? file} :: ${spec.title}`;
      let entry = cases.get(key);
      if (!entry) {
        entry = { executions: 0, flaky: [], failed: [], errors: new Map() };
        cases.set(key, entry);
      }
      entry.executions++;
      if (test.status !== "flaky" && test.status !== "unexpected") continue;
      (test.status === "flaky" ? entry.flaky : entry.failed).push(context);
      for (const result of test.results) {
        if (result.status === "passed" || result.status === "skipped") continue;
        const message = stripVTControlCharacters(
          result.error?.message ?? result.status,
        )
          .split("\n")
          .filter((line) => line.trim())
          .slice(0, 3)
          .join(" | ")
          .slice(0, 200);
        entry.errors.set(message, (entry.errors.get(message) ?? 0) + 1);
        if (options.case && key.includes(options.case)) {
          console.log(
            `${context.createdAt} run ${context.run} ${context.sha} ${spec.file}:${spec.line} ` +
              `retry ${result.retry} ${result.status} ${result.duration}ms ` +
              `worker ${result.workerIndex}/${result.parallelIndex}\n  ${message}`,
          );
        }
      }
    }
  }
}
function reports(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? reports(join(dir, entry.name))
      : entry.name.endsWith(".json")
        ? [join(dir, entry.name)]
        : [],
  );
}
let reported = 0;
for (const entry of runs) {
  const paths = reports(join(options.cache, String(entry.databaseId)));
  if (paths.length) reported++;
  for (const path of paths) {
    const context = {
      run: entry.databaseId,
      sha: entry.headSha.slice(0, 9),
      createdAt: entry.createdAt,
    };
    for (const suite of JSON.parse(readFileSync(path, "utf8")).suites ?? [])
      visit(suite, suite.file, context);
  }
}

console.log(
  `${reported} CI runs with browser reports on ${options.branch} since ${options.since}`,
);
const rows = [...cases]
  .filter(
    ([, entry]) => entry.flaky.length + entry.failed.length >= options.min,
  )
  .sort(
    ([, a], [, b]) =>
      b.flaky.length + b.failed.length - (a.flaky.length + a.failed.length),
  );
for (const [key, entry] of rows) {
  const last = [...entry.flaky, ...entry.failed]
    .map((context) => context.createdAt)
    .sort()
    .at(-1);
  console.log(
    `\n${entry.flaky.length} flaky, ${entry.failed.length} failed of ${entry.executions}, last ${last}  ${key}`,
  );
  for (const [message, count] of [...entry.errors]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2))
    console.log(`  ${count}× ${message}`);
}
