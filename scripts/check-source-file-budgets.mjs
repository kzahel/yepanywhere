#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const budgetRelativePath = "scripts/source-file-budgets.json";
const budgetPath = path.join(repoRoot, budgetRelativePath);

// Fixed here rather than in the budget file, so raising it is a reviewed code
// change instead of a one-number JSON edit that would disable the ceiling.
const THRESHOLD_LINES = 1500;
// `:(glob)` keeps `*` from crossing `/`, so only direct package source roots
// (`packages/<name>/src/**`) are in scope, not nested trees such as
// `packages/android/app/src` or a vendored `.../library/src`.
const SOURCE_PATHSPEC = ":(glob)packages/*/src/**";
const SOURCE_EXTENSION = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const EXCLUDED_SOURCE =
  /(?:\/__tests__\/|\/test\/|\/tests\/|\/generated\/|\.test\.|\.spec\.|\.test-support\.|\.d\.ts$)/;
const MIN_REASON_LENGTH = 20;

function usage() {
  console.log(`Usage: node scripts/check-source-file-budgets.mjs [options]

Options:
  --record       Lower budgets to current line counts and retire entries for
                 files now at or under ${THRESHOLD_LINES} lines. Never raises.
  --list         Print every budgeted file with its current count and budget.
  --base <rev>   Compare budget raises against <rev> instead of HEAD. CI passes
                 the pull request base or the pre-push commit. Also read from
                 SOURCE_BUDGET_BASE. An unavailable base fails the check.
  -h, --help     Show help.

The check rejects:
  - growth of a budgeted production source file above its maxLines;
  - a production source file over ${THRESHOLD_LINES} lines with no budget entry;
  - a budget raised above, or added since, the base revision without a
    matching "raise" record;
  - a stale or malformed budget entry.

Read topics/typescript-module-boundary-refactor.md#growth-guard before
editing ${budgetRelativePath}.
`);
}

function parseArgs(argv) {
  const options = { record: false, list: false, base: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "-h" || arg === "--help") {
      usage();
      process.exit(0);
    }
    if (arg === "--record") {
      options.record = true;
      continue;
    }
    if (arg === "--list") {
      options.list = true;
      continue;
    }
    if (arg === "--base" && index + 1 < argv.length) {
      options.base = argv[++index];
      continue;
    }
    console.error(`Unknown argument: ${arg}`);
    usage();
    process.exit(2);
  }
  const envBase = process.env.SOURCE_BUDGET_BASE?.trim();
  if (options.base === undefined && envBase && !/^0+$/.test(envBase)) {
    options.base = envBase;
  }
  return options;
}

function git(args) {
  return execFileSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function gitSucceeds(args) {
  try {
    git(args);
    return true;
  } catch {
    return false;
  }
}

function listProductionSources() {
  // Tracked plus untracked-but-not-ignored, so a new file fails before commit.
  const output = git([
    "ls-files",
    "--cached",
    "--others",
    "--exclude-standard",
    "-z",
    "--",
    SOURCE_PATHSPEC,
  ]);
  return [...new Set(output.split("\0"))]
    .filter((file) => SOURCE_EXTENSION.test(file))
    .filter((file) => !EXCLUDED_SOURCE.test(`/${file}`))
    .sort();
}

function lineCount(text) {
  if (text.length === 0) return 0;
  const newlines = text.match(/\n/g)?.length ?? 0;
  return newlines + (text.endsWith("\n") ? 0 : 1);
}

async function readCount(file) {
  try {
    return lineCount(await readFile(path.join(repoRoot, file), "utf8"));
  } catch (error) {
    // A deleted-but-still-indexed file is not a source file any more.
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

/**
 * Budgets at the comparison revision. `introduced` means the revision predates
 * the budget file, so the entries being added are the baseline itself.
 */
function readBaseBudgets(baseOption) {
  const rev = baseOption ?? "HEAD";
  if (!gitSucceeds(["rev-parse", "--verify", "--quiet", `${rev}^{commit}`])) {
    if (baseOption !== undefined) {
      throw new Error(
        `base revision ${rev} is not available; fetch it before running the check`,
      );
    }
    // A repository with no commits yet has nothing to compare against.
    return { rev, files: {}, introduced: true };
  }
  if (!gitSucceeds(["cat-file", "-e", `${rev}:${budgetRelativePath}`])) {
    return { rev, files: {}, introduced: true };
  }
  const parsed = JSON.parse(git(["show", `${rev}:${budgetRelativePath}`]));
  return { rev, files: parsed.files ?? {}, introduced: false };
}

function hasRaiseRecord(entry, from) {
  const raise = entry.raise;
  return (
    raise !== null &&
    typeof raise === "object" &&
    raise.from === from &&
    typeof raise.reason === "string" &&
    raise.reason.trim().length >= MIN_REASON_LENGTH
  );
}

const options = parseArgs(process.argv.slice(2));
const budget = JSON.parse(await readFile(budgetPath, "utf8"));
const files = budget.files ?? {};
const errors = [];
const lowerable = [];
const droppable = [];

let base;
try {
  base = readBaseBudgets(options.base);
} catch (error) {
  console.error(`source-file-budgets: ${error.message}`);
  process.exit(1);
}

const counts = new Map();
for (const file of listProductionSources()) {
  const count = await readCount(file);
  if (count !== undefined) counts.set(file, count);
}

for (const [file, count] of counts) {
  if (count > THRESHOLD_LINES && !Object.hasOwn(files, file)) {
    errors.push(
      `${file}: ${count} lines exceeds the ${THRESHOLD_LINES}-line threshold with no budget; split it along a domain seam before landing`,
    );
  }
}

for (const [file, entry] of Object.entries(files)) {
  const limit = entry?.maxLines;
  const count = counts.get(file);
  if (!Number.isInteger(limit) || limit < 0) {
    errors.push(`${file}: maxLines must be a non-negative integer`);
    continue;
  }
  if (count === undefined) {
    errors.push(
      `${file}: budget entry has no matching production source file; remove it`,
    );
    continue;
  }

  const baseLimit = base.files[file]?.maxLines;
  if (Number.isInteger(baseLimit)) {
    if (limit > baseLimit && !hasRaiseRecord(entry, baseLimit)) {
      errors.push(
        `${file}: maxLines raised ${baseLimit}->${limit} since ${base.rev} without "raise": { "from": ${baseLimit}, "reason": "<why no extraction could offset this>" }`,
      );
    }
  } else if (!base.introduced && !hasRaiseRecord(entry, null)) {
    // A new entry is a raise from "no budget"; it must be justified too.
    errors.push(
      `${file}: budget entry added since ${base.rev} needs "raise": { "from": null, "reason": "<why this file cannot start under ${THRESHOLD_LINES} lines>" }`,
    );
  }

  if (count > limit) {
    errors.push(
      `${file}: ${count} lines exceeds its budget of ${limit} (+${count - limit})`,
    );
  } else if (count <= THRESHOLD_LINES) {
    droppable.push({ file, count, limit });
  } else if (count < limit) {
    lowerable.push({ file, count, limit });
  }
}

const budgeted = Object.keys(files).length;
console.log(
  `Source file budgets: ${counts.size} production source files, ${budgeted} over-threshold files budgeted (threshold ${THRESHOLD_LINES} lines, raises compared with ${base.rev}).`,
);

if (options.list) {
  const rows = Object.entries(files)
    .map(([file, entry]) => ({
      file,
      count: counts.get(file),
      limit: entry?.maxLines,
    }))
    .sort((a, b) => (b.count ?? 0) - (a.count ?? 0));
  for (const { file, count, limit } of rows) {
    console.log(`  ${count ?? "missing"}/${limit}  ${file}`);
  }
}

if (errors.length > 0) {
  for (const error of errors) {
    console.error(`source-file-budgets: ${error}`);
  }
  console.error(
    "Oversized files are frozen. Put new behavior in a domain-named module and keep only wiring in the hub, or extract existing code to offset growth. Do not raise a budget without maintainer approval.",
  );
  process.exit(1);
}

if (options.record) {
  for (const { file, count } of lowerable) {
    files[file].maxLines = count;
  }
  for (const { file } of droppable) {
    delete files[file];
  }
  if (lowerable.length + droppable.length > 0) {
    budget.files = Object.fromEntries(
      Object.entries(files).sort(([a], [b]) => a.localeCompare(b)),
    );
    budget.updated = new Date().toISOString().slice(0, 10);
    await writeFile(budgetPath, `${JSON.stringify(budget, null, 2)}\n`, "utf8");
    console.log(
      `source-file-budgets: lowered ${lowerable.length} and retired ${droppable.length} budget entries.`,
    );
  } else {
    console.log(
      "source-file-budgets: all budgets already match current counts.",
    );
  }
} else if (lowerable.length + droppable.length > 0) {
  const hints = [
    ...lowerable.map(({ file, count, limit }) => `${file} ${limit}->${count}`),
    ...droppable.map(({ file }) => `${file} retire`),
  ];
  console.log(
    `source-file-budgets: below budget; run pnpm source:budgets --record to ratchet ${hints.join(", ")}.`,
  );
}
