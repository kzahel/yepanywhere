#!/usr/bin/env npx tsx
/**
 * Summarize legacy CSS ownership for React owners in the current diff.
 *
 * This is an advisory trigger for bounded, opportunistic extraction. It
 * composes the existing inventory instead of choosing a slice or maintaining
 * a migration queue.
 */

import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildInventory,
  type InventoryResult,
  type OwnerInventory,
} from "./css-inventory.ts";

import { isPurposeStylesheet } from "./find-unused-css.ts";

interface Options {
  base?: string;
  json: boolean;
  cssDir: string;
  srcDir: string;
  ownerDir: string;
}

export type TouchedDisposition = "opportunity" | "defer";

export interface TouchedOwner {
  owner: OwnerInventory;
  disposition: TouchedDisposition;
  reasons: string[];
}

export interface TouchedCssReport {
  comparison: string;
  changedFiles: string[];
  changedLegacyStylesheets: string[];
  owners: TouchedOwner[];
}

const USAGE = `
Surface legacy CSS ownership for changed React components.

Usage:
  pnpm css:touched -- [options]

Options:
  --base <ref>       Compare the merge base of <ref> and HEAD through the
                     current working tree (default: compare HEAD to the
                     current working tree)
  --json             Print machine-readable JSON
  --css-dir <dir>    CSS tree (default: packages/client/src)
  --src-dir <dir>    Source tree, including generated producers (default: packages)
  --owner-dir <dir>  React owner tree (default: packages/client/src)
  --help             Show this help
`;

function optionValue(argv: string[], index: number, option: string): string {
  const value = argv[index + 1];
  if (!value || value === "--" || value.startsWith("--")) {
    throw new Error(`${option} requires a value`);
  }
  return value;
}

function parseArgs(argv: string[] = process.argv.slice(2)): Options {
  const options: Options = {
    json: false,
    cssDir: "packages/client/src",
    srcDir: "packages",
    ownerDir: "packages/client/src",
  };

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--") continue;
    if (arg === "--help") {
      console.log(USAGE);
      process.exit(0);
    }
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (arg === "--base") {
      options.base = optionValue(argv, index, arg);
      index++;
      continue;
    }
    if (arg === "--css-dir") {
      options.cssDir = optionValue(argv, index, arg);
      index++;
      continue;
    }
    if (arg === "--src-dir") {
      options.srcDir = optionValue(argv, index, arg);
      index++;
      continue;
    }
    if (arg === "--owner-dir") {
      options.ownerDir = optionValue(argv, index, arg);
      index++;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function normalize(file: string): string {
  return path
    .relative(process.cwd(), path.resolve(file))
    .split(path.sep)
    .join("/");
}

function git(args: string[]): string {
  const result = spawnSync("git", args, {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim();
    throw new Error(
      `git ${args.join(" ")} failed${detail ? `: ${detail}` : ""}`,
    );
  }
  return result.stdout.trim();
}

function lines(output: string): string[] {
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

export function changedFiles(base?: string): {
  comparison: string;
  files: string[];
} {
  let comparison = "HEAD..working tree";
  let tree = "HEAD";
  if (base) {
    tree = git(["merge-base", base, "HEAD"]);
    comparison = `${base} merge-base ${tree.slice(0, 12)}..working tree`;
  }

  const tracked = lines(
    git(["diff", "--name-only", "--diff-filter=ACMR", tree, "--"]),
  );
  const untracked = lines(
    git(["ls-files", "--others", "--exclude-standard", "--"]),
  );
  return {
    comparison,
    files: Array.from(new Set([...tracked, ...untracked])).sort(),
  };
}

export function assessOwner(owner: OwnerInventory): TouchedOwner {
  const reasons: string[] = [];
  if (owner.ownedLines === 0) {
    reasons.push("no independently owned rule slice");
  }
  if (owner.coverage < 0.65) {
    reasons.push(
      `owned rules cover ${Math.round(owner.coverage * 100)}% of their stylesheet span`,
    );
  }
  if (owner.stylesheets.length > 2) {
    reasons.push(
      `ownership is scattered across ${owner.stylesheets.length} stylesheets`,
    );
  }
  if (owner.coupledRules.length > 0) {
    reasons.push(`${owner.coupledRules.length} coupled rule(s)`);
  }
  if (owner.unresolvedRules.length > 0) {
    const generated = new Set(
      owner.unresolvedRules.flatMap((rule) => Array.from(rule.externalClasses)),
    );
    reasons.push(
      generated.size > 0
        ? `${owner.unresolvedRules.length} unresolved rule(s) involving generated/shared vocabulary`
        : `${owner.unresolvedRules.length} unresolved rule(s)`,
    );
  }
  if (owner.dynamicClasses.length > 0) {
    reasons.push(
      `${owner.dynamicClasses.length} dynamically produced class(es)`,
    );
  }

  return {
    owner,
    disposition: reasons.length === 0 ? "opportunity" : "defer",
    reasons,
  };
}

export function buildTouchedReport(
  changed: string[],
  inventory: InventoryResult,
  comparison = "explicit file set",
  scope: { cssDir?: string } = {},
): TouchedCssReport {
  const normalized = Array.from(new Set(changed.map(normalize))).sort();
  const ownerByFile = new Map(
    inventory.owners.map((owner) => [owner.owner, owner]),
  );
  const owners = normalized
    .filter((file) => file.endsWith(".tsx") || file.endsWith(".jsx"))
    .map((file) => ownerByFile.get(file))
    .filter((owner): owner is OwnerInventory => owner !== undefined)
    .map(assessOwner);
  const changedLegacyStylesheets = normalized.filter(
    (file) =>
      file.endsWith(".css") &&
      !file.endsWith(".module.css") &&
      !isPurposeStylesheet(file) &&
      (!scope.cssDir ||
        file.startsWith(`${normalize(scope.cssDir).replace(/\/$/, "")}/`)),
  );

  return {
    comparison,
    changedFiles: normalized,
    changedLegacyStylesheets,
    owners,
  };
}

function ownerJson(entry: TouchedOwner): unknown {
  const { owner } = entry;
  return {
    owner: owner.owner,
    disposition: entry.disposition,
    reasons: entry.reasons,
    ownedLines: owner.ownedLines,
    spanLines: owner.spanLines,
    coverage: Number(owner.coverage.toFixed(3)),
    stylesheets: owner.stylesheets,
    edges: owner.coupledRules.length + owner.unresolvedRules.length,
    coupledRules: owner.coupledRules.length,
    unresolvedRules: owner.unresolvedRules.length,
    lowConfidenceRules: owner.lowConfidenceRules.length,
    dynamicClasses: owner.dynamicClasses,
    tests: owner.testFiles,
  };
}

function printOwner(entry: TouchedOwner): void {
  const { owner } = entry;
  const label = entry.disposition === "opportunity" ? "OPPORTUNITY" : "DEFER";
  const edges = owner.coupledRules.length + owner.unresolvedRules.length;
  console.log(`${label}  ${owner.owner}`);
  console.log(
    `  ${owner.ownedLines} owned lines / ${owner.spanLines}-line span (${Math.round(owner.coverage * 100)}%); ${owner.stylesheets.length} stylesheet(s); ${edges} edge(s); ${owner.lowConfidenceRules.length} weak match(es); ${owner.dynamicClasses.length} dynamic class(es); ${owner.testFiles.length} test file(s)`,
  );
  if (owner.stylesheets.length > 0) {
    console.log(`  stylesheets: ${owner.stylesheets.join(", ")}`);
  }
  if (owner.testFiles.length > 0) {
    console.log(`  tests: ${owner.testFiles.join(", ")}`);
  }
  if (entry.reasons.length > 0) {
    console.log(`  defer because: ${entry.reasons.join("; ")}`);
  }
  console.log(
    `  inspect: pnpm css:inventory -- --owner ${path.basename(owner.owner, path.extname(owner.owner))}`,
  );
}

function printReport(report: TouchedCssReport): void {
  if (
    report.owners.length === 0 &&
    report.changedLegacyStylesheets.length === 0
  ) {
    console.log(
      "CSS touched ownership: no changed React owners with legacy ownership evidence.",
    );
    return;
  }

  console.log(`CSS touched ownership (${report.comparison})`);
  for (const entry of report.owners) printOwner(entry);
  for (const stylesheet of report.changedLegacyStylesheets) {
    console.log(`LEGACY STYLESHEET  ${stylesheet}`);
    console.log(
      "  Confirm the affected owner with pnpm css:inventory -- --owner <component>.",
    );
  }
  console.log(
    "Advisory only: inspect bounded opportunities; deferral does not fail the change.",
  );
}

function main(): void {
  try {
    const options = parseArgs();
    const changed = changedFiles(options.base);
    const inventory = buildInventory(options);
    const report = buildTouchedReport(
      changed.files,
      inventory,
      changed.comparison,
      { cssDir: options.cssDir },
    );
    if (options.json) {
      console.log(
        JSON.stringify(
          {
            comparison: report.comparison,
            changedFiles: report.changedFiles,
            changedLegacyStylesheets: report.changedLegacyStylesheets,
            owners: report.owners.map(ownerJson),
          },
          null,
          2,
        ),
      );
      return;
    }
    printReport(report);
  } catch (error) {
    console.error((error as Error).message);
    console.error(USAGE);
    process.exitCode = 2;
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) main();
