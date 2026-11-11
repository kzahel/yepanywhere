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
}

export interface StyleTotals {
  authoredStylesheets: number;
  authoredLines: number;
  globalStylesheets: number;
  globalLines: number;
  moduleStylesheets: number;
  moduleLines: number;
}

export interface CssHealth {
  styles: StyleTotals;
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
    if (arg === "--css-dir" || arg === "--src-dir") {
      const value = optionValue(argv, index, arg);
      index++;
      if (arg === "--css-dir") options.cssDir = value;
      if (arg === "--src-dir") options.srcDir = value;
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

export function collectStyles(cssDir: string): StyleTotals {
  const cssFiles = findFiles(cssDir, [".css"]);
  const moduleFiles = cssFiles.filter(isModuleStylesheet);
  const globalFiles = cssFiles.filter((file) => !isModuleStylesheet(file));
  const globalCounts = new Map(
    globalFiles.map((file) => [normalize(file), lineCount(file)]),
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
  };
}

export function composeCssHealth(
  styles: StyleTotals,
  analysis: AnalysisResult,
): CssHealth {
  const moduleIssues = moduleContractIssues(analysis);
  const globalUses = analysis.modules.flatMap((report) => report.globalUses);
  return {
    styles,
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
  const { styles } = health;
  console.log("CSS health (on demand; no composite score)");
  console.log(
    `  ${styles.authoredStylesheets} authored stylesheets / ${styles.authoredLines} lines`,
  );
  console.log(
    `  globals: ${styles.globalStylesheets} files / ${styles.globalLines} lines (${percent(styles.globalLines, styles.authoredLines)})`,
  );
  console.log(
    `  modules: ${styles.moduleStylesheets} files / ${styles.moduleLines} lines`,
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
    const styles = collectStyles(options.cssDir);
    const { result } = analyze(options);
    const health = composeCssHealth(styles, result);
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
