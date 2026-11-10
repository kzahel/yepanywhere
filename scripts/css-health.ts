#!/usr/bin/env npx tsx
/**
 * Compose the existing CSS analyzers into one on-demand architecture summary.
 *
 * This report is observational: the ratchet and module contract keep their
 * own blocking commands, while this command makes their relationship visible
 * without a dashboard or composite score.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildInventory, type InventoryResult } from "./css-inventory.ts";
import {
  analyze,
  findFiles,
  isModuleStylesheet,
  moduleContractIssues,
  type AnalysisResult,
} from "./find-unused-css.ts";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

interface Options {
  json: boolean;
  cssDir: string;
  srcDir: string;
  ownerDir: string;
  baseline: string;
}

interface LimitState {
  file: string;
  lines: number;
  limit: number;
}

export interface ContainmentHealth {
  authoredStylesheets: number;
  authoredLines: number;
  globalStylesheets: number;
  globalLines: number;
  moduleStylesheets: number;
  moduleLines: number;
  ratchet: {
    reviewed: number;
    atLimit: LimitState[];
    belowLimit: LimitState[];
    aboveLimit: LimitState[];
    invalidLimits: string[];
    unreviewed: string[];
    stale: string[];
  };
}

export interface CssHealth {
  containment: ContainmentHealth;
  ownership: {
    owners: number;
    inferredOwnedLines: number;
    rules: InventoryResult["ruleCounts"];
    lowConfidenceRules: number;
  };
  modules: {
    files: number;
    selectors: number;
    contractIssues: number;
    unknownFiles: number;
    productionUnusedSelectors: number;
    testOnlySelectors: number;
  };
  escapeHatches: {
    globalInteropReferences: number;
    selectorReferences: number;
    globalComposes: number;
    filesUsingGlobalInterop: number;
    invalidReferences: number;
  };
  deadCode: {
    globalClassSelectors: number;
    usedGlobalClassSelectors: number;
    unusedGlobalClassSelectors: number;
  };
}

const USAGE = `
Summarize CSS architecture health without a composite score.

Usage:
  pnpm css:health -- [options]

Options:
  --json             Print machine-readable JSON
  --css-dir <dir>    CSS tree (default: packages/client/src)
  --src-dir <dir>    Source tree, including generated producers (default: packages)
  --owner-dir <dir>  React owner tree (default: packages/client/src)
  --baseline <file>  Containment baseline (default: scripts/css-architecture-baseline.json)
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
    baseline: "scripts/css-architecture-baseline.json",
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
    if (
      arg === "--css-dir" ||
      arg === "--src-dir" ||
      arg === "--owner-dir" ||
      arg === "--baseline"
    ) {
      const value = optionValue(argv, index, arg);
      index++;
      if (arg === "--css-dir") options.cssDir = value;
      if (arg === "--src-dir") options.srcDir = value;
      if (arg === "--owner-dir") options.ownerDir = value;
      if (arg === "--baseline") options.baseline = value;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function normalize(file: string): string {
  return path.relative(repoRoot, path.resolve(file)).split(path.sep).join("/");
}

function lineCount(file: string): number {
  const text = fs.readFileSync(file, "utf8");
  if (text.length === 0) return 0;
  const newlines = text.match(/\n/g)?.length ?? 0;
  return newlines + (text.endsWith("\n") ? 0 : 1);
}

export function collectContainment(
  cssDir: string,
  baselinePath: string,
): ContainmentHealth {
  const cssFiles = findFiles(cssDir, [".css"]);
  const moduleFiles = cssFiles.filter(isModuleStylesheet);
  const globalFiles = cssFiles.filter((file) => !isModuleStylesheet(file));
  const globalCounts = new Map(
    globalFiles.map((file) => [normalize(file), lineCount(file)]),
  );
  const baseline = JSON.parse(fs.readFileSync(baselinePath, "utf8")) as {
    legacyGlobalStyles?: Record<string, { maxLines?: unknown }>;
  };
  const configured = baseline.legacyGlobalStyles ?? {};
  const atLimit: LimitState[] = [];
  const belowLimit: LimitState[] = [];
  const aboveLimit: LimitState[] = [];
  const invalidLimits: string[] = [];
  const stale: string[] = [];

  for (const [file, entry] of Object.entries(configured)) {
    const lines = globalCounts.get(file);
    if (lines === undefined) {
      stale.push(file);
      continue;
    }
    if (!Number.isInteger(entry.maxLines) || Number(entry.maxLines) < 0) {
      invalidLimits.push(file);
      continue;
    }
    const state = { file, lines, limit: Number(entry.maxLines) };
    if (state.lines > state.limit) aboveLimit.push(state);
    else if (state.lines < state.limit) belowLimit.push(state);
    else atLimit.push(state);
  }

  const configuredPaths = new Set(Object.keys(configured));
  const unreviewed = Array.from(globalCounts.keys()).filter(
    (file) => !configuredPaths.has(file),
  );
  const globalLines = Array.from(globalCounts.values()).reduce(
    (total, lines) => total + lines,
    0,
  );
  const moduleLines = moduleFiles.reduce(
    (total, file) => total + lineCount(file),
    0,
  );

  return {
    authoredStylesheets: cssFiles.length,
    authoredLines: globalLines + moduleLines,
    globalStylesheets: globalFiles.length,
    globalLines,
    moduleStylesheets: moduleFiles.length,
    moduleLines,
    ratchet: {
      reviewed: Object.keys(configured).length,
      atLimit: atLimit.sort((a, b) => a.file.localeCompare(b.file)),
      belowLimit: belowLimit.sort((a, b) => a.file.localeCompare(b.file)),
      aboveLimit: aboveLimit.sort((a, b) => a.file.localeCompare(b.file)),
      invalidLimits: invalidLimits.sort(),
      unreviewed: unreviewed.sort(),
      stale: stale.sort(),
    },
  };
}

export function composeCssHealth(
  containment: ContainmentHealth,
  inventory: InventoryResult,
  analysis: AnalysisResult,
): CssHealth {
  const moduleIssues = moduleContractIssues(analysis);
  const globalUses = analysis.modules.flatMap((report) => report.globalUses);
  return {
    containment,
    ownership: {
      owners: inventory.owners.length,
      inferredOwnedLines: inventory.owners.reduce(
        (total, owner) => total + owner.ownedLines,
        0,
      ),
      rules: inventory.ruleCounts,
      lowConfidenceRules: inventory.lowConfidenceRules,
    },
    modules: {
      files: analysis.moduleFileCount,
      selectors: analysis.modules.reduce(
        (total, report) => total + report.selectors.length,
        0,
      ),
      contractIssues: moduleIssues.length,
      unknownFiles: analysis.modules.filter(
        (report) => report.unknownReasons.length > 0,
      ).length,
      productionUnusedSelectors: analysis.moduleProductionUnused.length,
      testOnlySelectors: analysis.modules.reduce(
        (total, report) => total + report.testOnly.length,
        0,
      ),
    },
    escapeHatches: {
      globalInteropReferences: globalUses.length,
      selectorReferences: globalUses.filter((use) => use.kind === "selector")
        .length,
      globalComposes: globalUses.filter((use) => use.kind === "composes")
        .length,
      filesUsingGlobalInterop: analysis.modules.filter(
        (report) => report.globalUses.length > 0,
      ).length,
      invalidReferences: analysis.modules.reduce(
        (total, report) => total + report.globalIssues.length,
        0,
      ),
    },
    deadCode: {
      globalClassSelectors: analysis.globalClasses.length,
      usedGlobalClassSelectors: analysis.globalUsed.length,
      unusedGlobalClassSelectors: analysis.globalUnused.length,
    },
  };
}

function percent(part: number, whole: number): string {
  return whole === 0 ? "0%" : `${Math.round((part / whole) * 100)}%`;
}

function printHealth(health: CssHealth): void {
  const { containment } = health;
  const ratchetProblems =
    containment.ratchet.aboveLimit.length +
    containment.ratchet.invalidLimits.length +
    containment.ratchet.unreviewed.length +
    containment.ratchet.stale.length;
  console.log("CSS health (on demand; no composite score)");
  console.log("Containment");
  console.log(
    `  ${containment.authoredStylesheets} authored stylesheets / ${containment.authoredLines} lines total`,
  );
  console.log(
    `  global: ${containment.globalStylesheets} files / ${containment.globalLines} lines (${percent(containment.globalLines, containment.authoredLines)})`,
  );
  console.log(
    `  modules: ${containment.moduleStylesheets} files / ${containment.moduleLines} lines (${percent(containment.moduleLines, containment.authoredLines)})`,
  );
  console.log(
    `  ratchet: ${ratchetProblems === 0 ? "contained" : `${ratchetProblems} problem(s)`}; ${containment.ratchet.atLimit.length} at limit, ${containment.ratchet.belowLimit.length} ready to record`,
  );

  console.log("Ownership evidence");
  console.log(
    `  ${health.ownership.owners} React owners / ${health.ownership.inferredOwnedLines} inferred owned rule lines`,
  );
  console.log(
    `  rules: ${health.ownership.rules.owned} owned, ${health.ownership.rules.coupled} coupled, ${health.ownership.rules.generated} generated, ${health.ownership.rules.unresolved} unresolved`,
  );
  console.log(
    `  ${health.ownership.lowConfidenceRules} rule(s) include broad-string evidence outside class-producing syntax`,
  );

  console.log("Module contracts and escape hatches");
  console.log(
    `  ${health.modules.files} modules / ${health.modules.selectors} selectors / ${health.modules.contractIssues} contract issue(s)`,
  );
  console.log(
    `  ${health.modules.productionUnusedSelectors} production-unused, ${health.modules.testOnlySelectors} test-only, ${health.modules.unknownFiles} statically unknown module(s)`,
  );
  console.log(
    `  global interop: ${health.escapeHatches.globalInteropReferences} references in ${health.escapeHatches.filesUsingGlobalInterop} files (${health.escapeHatches.selectorReferences} selectors, ${health.escapeHatches.globalComposes} composes), ${health.escapeHatches.invalidReferences} invalid`,
  );

  console.log("Unused global CSS (whole tokens and reviewed families)");
  console.log(
    `  ${health.deadCode.unusedGlobalClassSelectors}/${health.deadCode.globalClassSelectors} unique global class selectors are unused (${percent(health.deadCode.unusedGlobalClassSelectors, health.deadCode.globalClassSelectors)})`,
  );
  console.log(
    "Observational only: use css:check, lint, and css:unused for their documented exit behavior.",
  );
}

function main(): void {
  try {
    const options = parseArgs();
    const containment = collectContainment(options.cssDir, options.baseline);
    const inventory = buildInventory(options);
    const { result } = analyze(options);
    const health = composeCssHealth(containment, inventory, result);
    if (options.json) {
      console.log(JSON.stringify(health, null, 2));
      return;
    }
    printHealth(health);
  } catch (error) {
    console.error((error as Error).message);
    console.error(USAGE);
    process.exitCode = 2;
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) main();
