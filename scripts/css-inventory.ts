#!/usr/bin/env npx tsx
/**
 * Rank legacy CSS by statically inferred React ownership.
 *
 * This is an advisory migration-planning report, not an enforcement baseline.
 * It deliberately treats generated vocabulary, unresolved selectors, and
 * cross-owner selectors as friction instead of guessing that they are safe to
 * move.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import postcss from "postcss";
import {
  buildClassProducerUsageIndex,
  buildSourceUsageIndex,
  extractSelectorClassNames,
  findDynamicUsage,
  findFiles,
  findSourceFiles,
  isPurposeStylesheet,
  type SourceUsageIndex,
} from "./find-unused-css.ts";

interface Options {
  cssDir: string;
  srcDir: string;
  ownerDir: string;
  owner?: string;
  json: boolean;
  limit: number;
}

type RuleKind = "owned" | "coupled" | "generated" | "unresolved";

interface ClassUsage {
  owners: Set<string>;
  lowConfidenceOwners: Set<string>;
  tests: Set<string>;
  support: Set<string>;
  external: Set<string>;
  dynamicOwners: Set<string>;
}

interface RuleRecord {
  file: string;
  start: number;
  end: number;
  lines: number;
  selector: string;
  classes: string[];
  kind: RuleKind;
  owner?: string;
  involvedOwners: Set<string>;
  anchorOwners: Set<string>;
  dynamicClasses: Set<string>;
  unresolvedClasses: Set<string>;
  externalClasses: Set<string>;
  testFiles: Set<string>;
  lowConfidenceOwners: Set<string>;
  lowConfidenceClasses: Set<string>;
}

export interface OwnerInventory {
  owner: string;
  ownedLines: number;
  spanLines: number;
  coverage: number;
  stylesheets: string[];
  ownedRules: RuleRecord[];
  coupledRules: RuleRecord[];
  unresolvedRules: RuleRecord[];
  /** Broad string matches that did not occur in class-producing syntax. */
  lowConfidenceRules: RuleRecord[];
  classes: string[];
  dynamicClasses: string[];
  testFiles: string[];
}

export interface InventoryResult {
  legacyStylesheets: number;
  legacyLines: number;
  sourceFiles: number;
  ruleCounts: Record<RuleKind, number>;
  lowConfidenceRules: number;
  owners: OwnerInventory[];
}

const USAGE = `
Rank legacy CSS by statically inferred React ownership.

Usage:
  pnpm css:inventory -- [options]

Options:
  --owner <text>     Show rule-level detail for matching owner paths
  --limit <count>    Maximum rows per summary table (default: 20)
  --json             Print machine-readable JSON
  --css-dir <dir>    CSS tree (default: packages/client/src)
  --src-dir <dir>    Source tree, including generated producers (default: packages)
  --owner-dir <dir>  React owner tree (default: packages/client/src)
  --help             Show this help
`;

function parseArgs(argv: string[] = process.argv.slice(2)): Options {
  const options: Options = {
    cssDir: "packages/client/src",
    srcDir: "packages",
    ownerDir: "packages/client/src",
    json: false,
    limit: 20,
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
    if (arg === "--owner") {
      options.owner = argv[++index];
      continue;
    }
    if (arg === "--limit") {
      options.limit = Number(argv[++index]);
      continue;
    }
    if (arg === "--css-dir") {
      options.cssDir = argv[++index];
      continue;
    }
    if (arg === "--src-dir") {
      options.srcDir = argv[++index];
      continue;
    }
    if (arg === "--owner-dir") {
      options.ownerDir = argv[++index];
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!Number.isInteger(options.limit) || options.limit < 1) {
    throw new Error("--limit must be a positive integer");
  }
  return options;
}

function normalize(file: string): string {
  return path
    .relative(process.cwd(), path.resolve(file))
    .split(path.sep)
    .join("/");
}

function isWithin(file: string, directory: string): boolean {
  const relative = path.relative(path.resolve(directory), path.resolve(file));
  return (
    relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)
  );
}

function isTestFile(file: string): boolean {
  const normalized = file.split(path.sep).join("/");
  return (
    /(^|\/)(__tests__|tests?|e2e)(\/|\.|$)/.test(normalized) ||
    /(^|\/)packages\/[^/]+\/scripts\//.test(normalized) ||
    /\.(test|spec)\.[cm]?[jt]sx?$/.test(normalized)
  );
}

function isReactOwner(file: string, ownerDir: string): boolean {
  return (
    isWithin(file, ownerDir) &&
    !isTestFile(file) &&
    (file.endsWith(".tsx") || file.endsWith(".jsx"))
  );
}

function classNames(selector: string): string[] {
  return extractSelectorClassNames(selector);
}

function intersect(sets: Set<string>[]): Set<string> {
  if (sets.length === 0) return new Set();
  const [first, ...rest] = sets;
  return new Set(
    Array.from(first).filter((value) => rest.every((set) => set.has(value))),
  );
}

function classUsage(
  className: string,
  sourceIndex: SourceUsageIndex,
  classProducerIndex: SourceUsageIndex,
  ownerDir: string,
): ClassUsage {
  const exact = sourceIndex.exact.get(className) ?? new Set<string>();
  const dynamic =
    exact.size === 0
      ? new Set(findDynamicUsage(className, sourceIndex))
      : new Set<string>();
  const allFiles = new Set([...exact, ...dynamic]);
  const producerExact =
    classProducerIndex.exact.get(className) ?? new Set<string>();
  const producerDynamic =
    producerExact.size === 0
      ? new Set(findDynamicUsage(className, classProducerIndex))
      : new Set<string>();
  const producerFiles = new Set([...producerExact, ...producerDynamic]);
  const owners = new Set<string>();
  const lowConfidenceOwners = new Set<string>();
  const tests = new Set<string>();
  const support = new Set<string>();
  const external = new Set<string>();
  const dynamicOwners = new Set<string>();

  for (const file of allFiles) {
    if (isTestFile(file)) {
      tests.add(normalize(file));
    } else if (isReactOwner(file, ownerDir)) {
      const owner = normalize(file);
      if (producerFiles.has(file)) {
        owners.add(owner);
        if (producerDynamic.has(file)) dynamicOwners.add(owner);
      } else {
        lowConfidenceOwners.add(owner);
      }
    } else if (isWithin(file, ownerDir)) {
      support.add(normalize(file));
    } else {
      external.add(normalize(file));
    }
  }

  return {
    owners,
    lowConfidenceOwners,
    tests,
    support,
    external,
    dynamicOwners,
  };
}

function classifyRule(
  file: string,
  selectorBranches: string[],
  start: number,
  end: number,
  usageFor: (className: string) => ClassUsage,
): RuleRecord {
  const classes = classNames(selectorBranches.join(","));
  const involvedOwners = new Set<string>();
  const anchorOwners = new Set<string>();
  const dynamicClasses = new Set<string>();
  const unresolvedClasses = new Set<string>();
  const externalClasses = new Set<string>();
  const testFiles = new Set<string>();
  const lowConfidenceOwners = new Set<string>();
  const lowConfidenceClasses = new Set<string>();
  const branchOwners: string[] = [];
  let coupled = false;

  for (const branch of selectorBranches) {
    const branchClasses = classNames(branch);
    if (branchClasses.length === 0) {
      unresolvedClasses.add("<non-class selector>");
      continue;
    }
    const ownerSets: Set<string>[] = [];
    const branchUsages: Array<{ className: string; usage: ClassUsage }> = [];
    for (const className of branchClasses) {
      const usage = usageFor(className);
      branchUsages.push({ className, usage });
      for (const owner of usage.owners) involvedOwners.add(owner);
      for (const owner of usage.lowConfidenceOwners) {
        lowConfidenceOwners.add(owner);
        lowConfidenceClasses.add(className);
      }
      if (usage.owners.size === 1) {
        anchorOwners.add(Array.from(usage.owners)[0]);
        for (const test of usage.tests) testFiles.add(test);
      }
      if (usage.dynamicOwners.size > 0) dynamicClasses.add(className);
      if (
        usage.owners.size === 0 &&
        usage.support.size === 0 &&
        usage.external.size === 0 &&
        usage.tests.size === 0
      ) {
        unresolvedClasses.add(className);
      }
      if (usage.owners.size > 0) ownerSets.push(usage.owners);
    }

    const candidates = intersect(ownerSets);
    if (candidates.size === 1) {
      const candidate = Array.from(candidates)[0];
      branchOwners.push(candidate);
      for (const { className, usage } of branchUsages) {
        if (
          (usage.external.size > 0 || usage.support.size > 0) &&
          !usage.owners.has(candidate)
        ) {
          externalClasses.add(className);
        }
      }
    } else if (ownerSets.length > 0) {
      coupled = true;
      for (const { className, usage } of branchUsages) {
        if (usage.external.size > 0 || usage.support.size > 0) {
          externalClasses.add(className);
        }
      }
    } else {
      for (const { className, usage } of branchUsages) {
        if (usage.external.size > 0 || usage.support.size > 0) {
          externalClasses.add(className);
        }
      }
    }
  }

  const uniqueBranchOwners = new Set(branchOwners);
  let kind: RuleKind;
  let owner: string | undefined;
  if (
    !coupled &&
    uniqueBranchOwners.size === 1 &&
    unresolvedClasses.size === 0 &&
    externalClasses.size === 0
  ) {
    kind = "owned";
    owner = Array.from(uniqueBranchOwners)[0];
  } else if (involvedOwners.size > 0 && (coupled || involvedOwners.size > 1)) {
    kind = "coupled";
  } else if (externalClasses.size > 0 && involvedOwners.size === 0) {
    kind = "generated";
  } else {
    kind = "unresolved";
  }

  return {
    file,
    start,
    end,
    lines: end - start + 1,
    selector: selectorBranches.join(", "),
    classes,
    kind,
    owner,
    involvedOwners,
    anchorOwners,
    dynamicClasses,
    unresolvedClasses,
    externalClasses,
    testFiles,
    lowConfidenceOwners,
    lowConfidenceClasses,
  };
}

export function buildInventory(
  options: Pick<Options, "cssDir" | "srcDir" | "ownerDir">,
): InventoryResult {
  const cssFiles = findFiles(options.cssDir, [".css"]).filter(
    (file) => !file.endsWith(".module.css") && !isPurposeStylesheet(file),
  );
  const sourceFiles = findSourceFiles(options.srcDir, [
    ".tsx",
    ".ts",
    ".jsx",
    ".js",
    ".mjs",
    ".cjs",
  ]);
  const sourceContents = new Map(
    sourceFiles.map((file) => [file, fs.readFileSync(file, "utf8")]),
  );
  const sourceIndex = buildSourceUsageIndex(sourceContents);
  const classProducerIndex = buildClassProducerUsageIndex(sourceContents);
  const usageCache = new Map<string, ClassUsage>();
  const usageFor = (className: string): ClassUsage => {
    let usage = usageCache.get(className);
    if (!usage) {
      usage = classUsage(
        className,
        sourceIndex,
        classProducerIndex,
        options.ownerDir,
      );
      usageCache.set(className, usage);
    }
    return usage;
  };

  const rules: RuleRecord[] = [];
  let legacyLines = 0;
  for (const cssFile of cssFiles) {
    const content = fs.readFileSync(cssFile, "utf8");
    legacyLines +=
      content.split("\n").length - (content.endsWith("\n") ? 1 : 0);
    postcss.parse(content, { from: cssFile }).walkRules((rule) => {
      const selectors = rule.selectors;
      const classes = classNames(selectors.join(","));
      if (classes.length === 0) return;
      const start = rule.source?.start?.line ?? 1;
      const end = rule.source?.end?.line ?? start;
      rules.push(
        classifyRule(normalize(cssFile), selectors, start, end, usageFor),
      );
    });
  }

  const ownerRules = new Map<string, RuleRecord[]>();
  const frictionRules = new Map<string, RuleRecord[]>();
  const lowConfidenceRules = new Map<string, RuleRecord[]>();
  for (const rule of rules) {
    for (const owner of rule.lowConfidenceOwners) {
      const weak = lowConfidenceRules.get(owner) ?? [];
      weak.push(rule);
      lowConfidenceRules.set(owner, weak);
    }
    if (rule.kind === "owned" && rule.owner) {
      const owned = ownerRules.get(rule.owner) ?? [];
      owned.push(rule);
      ownerRules.set(rule.owner, owned);
      continue;
    }
    // A coupled rule can consist entirely of classes shared by several
    // producers, leaving it without a single-owner anchor. Surface that rule
    // under every React owner it touches so an owner drill-down cannot report
    // a falsely clean boundary. Unresolved rules remain tied to their unique
    // anchors; assigning those to every possible producer would turn an
    // ambiguity report into a guessed ownership claim.
    const frictionOwners =
      rule.kind === "coupled" ? rule.involvedOwners : rule.anchorOwners;
    for (const owner of frictionOwners) {
      const friction = frictionRules.get(owner) ?? [];
      friction.push(rule);
      frictionRules.set(owner, friction);
    }
  }

  const owners: OwnerInventory[] = [];
  const reportedOwners = new Set([
    ...ownerRules.keys(),
    ...frictionRules.keys(),
  ]);
  for (const owner of reportedOwners) {
    const ownedRules = ownerRules.get(owner) ?? [];
    const locations = new Map<string, { min: number; max: number }>();
    const classes = new Set<string>();
    const dynamicClasses = new Set<string>();
    const testFiles = new Set<string>();
    for (const rule of ownedRules) {
      const location = locations.get(rule.file) ?? {
        min: rule.start,
        max: rule.end,
      };
      location.min = Math.min(location.min, rule.start);
      location.max = Math.max(location.max, rule.end);
      locations.set(rule.file, location);
      for (const name of rule.classes) classes.add(name);
      for (const name of rule.dynamicClasses) dynamicClasses.add(name);
      for (const file of rule.testFiles) testFiles.add(file);
    }
    const friction = frictionRules.get(owner) ?? [];
    const coupledRules = friction.filter((rule) => rule.kind === "coupled");
    const unresolvedRules = friction.filter(
      (rule) => rule.kind === "unresolved",
    );
    const weakRules = lowConfidenceRules.get(owner) ?? [];
    const ownedLines = ownedRules.reduce(
      (total, rule) => total + rule.lines,
      0,
    );
    const spanLines = Array.from(locations.values()).reduce(
      (total, location) => total + location.max - location.min + 1,
      0,
    );
    owners.push({
      owner,
      ownedLines,
      spanLines,
      coverage: spanLines === 0 ? 0 : ownedLines / spanLines,
      stylesheets: Array.from(locations.keys()).sort(),
      ownedRules: ownedRules.sort(
        (a, b) => a.file.localeCompare(b.file) || a.start - b.start,
      ),
      coupledRules,
      unresolvedRules,
      lowConfidenceRules: weakRules,
      classes: Array.from(classes).sort(),
      dynamicClasses: Array.from(dynamicClasses).sort(),
      testFiles: Array.from(testFiles).sort(),
    });
  }

  owners.sort(
    (a, b) => b.ownedLines - a.ownedLines || a.owner.localeCompare(b.owner),
  );
  const ruleCounts: Record<RuleKind, number> = {
    owned: 0,
    coupled: 0,
    generated: 0,
    unresolved: 0,
  };
  for (const rule of rules) ruleCounts[rule.kind]++;

  return {
    legacyStylesheets: cssFiles.length,
    legacyLines,
    sourceFiles: sourceFiles.length,
    ruleCounts,
    lowConfidenceRules: rules.filter(
      (rule) => rule.lowConfidenceClasses.size > 0,
    ).length,
    owners,
  };
}

function jsonResult(result: InventoryResult): unknown {
  return {
    ...result,
    owners: result.owners.map((owner) => ({
      ...owner,
      coverage: Number(owner.coverage.toFixed(3)),
      ownedRules: owner.ownedRules.map(jsonRule),
      coupledRules: owner.coupledRules.map(jsonRule),
      unresolvedRules: owner.unresolvedRules.map(jsonRule),
      lowConfidenceRules: owner.lowConfidenceRules.map(jsonRule),
    })),
  };
}

function jsonRule(rule: RuleRecord): unknown {
  return {
    file: rule.file,
    start: rule.start,
    end: rule.end,
    lines: rule.lines,
    selector: rule.selector,
    classes: rule.classes,
    kind: rule.kind,
    owner: rule.owner,
    involvedOwners: Array.from(rule.involvedOwners).sort(),
    anchorOwners: Array.from(rule.anchorOwners).sort(),
    dynamicClasses: Array.from(rule.dynamicClasses).sort(),
    unresolvedClasses: Array.from(rule.unresolvedClasses).sort(),
    externalClasses: Array.from(rule.externalClasses).sort(),
    testFiles: Array.from(rule.testFiles).sort(),
    lowConfidenceOwners: Array.from(rule.lowConfidenceOwners).sort(),
    lowConfidenceClasses: Array.from(rule.lowConfidenceClasses).sort(),
  };
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function printTable(
  title: string,
  owners: OwnerInventory[],
  limit: number,
): void {
  console.log(title);
  console.log(" owned  span  cover  files  edges  weak  dyn  tests  owner");
  for (const owner of owners.slice(0, limit)) {
    console.log(
      `${String(owner.ownedLines).padStart(6)}  ${String(owner.spanLines).padStart(4)}  ${percent(owner.coverage).padStart(5)}  ${String(owner.stylesheets.length).padStart(5)}  ${String(owner.coupledRules.length + owner.unresolvedRules.length).padStart(5)}  ${String(owner.lowConfidenceRules.length).padStart(4)}  ${String(owner.dynamicClasses.length).padStart(3)}  ${String(owner.testFiles.length).padStart(5)}  ${owner.owner}`,
    );
  }
  console.log();
}

function printOwner(owner: OwnerInventory): void {
  console.log(owner.owner);
  console.log(
    `  ${owner.ownedLines} owned rule lines across a ${owner.spanLines}-line span (${percent(owner.coverage)} coverage)`,
  );
  console.log(
    `  ${owner.stylesheets.length} stylesheet(s), ${owner.coupledRules.length} coupled rule(s), ${owner.unresolvedRules.length} unresolved rule(s), ${owner.lowConfidenceRules.length} low-confidence string match(es), ${owner.dynamicClasses.length} dynamic class(es)`,
  );
  for (const file of owner.stylesheets) {
    const fileRules = owner.ownedRules.filter((rule) => rule.file === file);
    const first = Math.min(...fileRules.map((rule) => rule.start));
    const last = Math.max(...fileRules.map((rule) => rule.end));
    console.log(
      `  owned: ${file}:${first}-${last} (${fileRules.length} rules)`,
    );
  }
  if (owner.dynamicClasses.length > 0) {
    console.log(`  dynamic: ${owner.dynamicClasses.join(", ")}`);
  }
  for (const rule of [...owner.coupledRules, ...owner.unresolvedRules].slice(
    0,
    25,
  )) {
    const details = [
      rule.involvedOwners.size > 0
        ? `owners: ${Array.from(rule.involvedOwners).join(", ")}`
        : "",
      rule.externalClasses.size > 0
        ? `generated: ${Array.from(rule.externalClasses).join(", ")}`
        : "",
      rule.unresolvedClasses.size > 0
        ? `unresolved: ${Array.from(rule.unresolvedClasses).join(", ")}`
        : "",
      rule.lowConfidenceClasses.size > 0
        ? `low confidence: ${Array.from(rule.lowConfidenceClasses).join(", ")}`
        : "",
    ].filter(Boolean);
    console.log(
      `  ${rule.kind}: ${rule.file}:${rule.start} ${rule.selector}${details.length > 0 ? ` (${details.join("; ")})` : ""}`,
    );
  }
  for (const rule of owner.lowConfidenceRules.slice(0, 25)) {
    console.log(
      `  low confidence: ${rule.file}:${rule.start} ${rule.selector} (${Array.from(rule.lowConfidenceClasses).join(", ")})`,
    );
  }
}

function main(): void {
  let options: Options;
  try {
    options = parseArgs();
  } catch (error) {
    console.error((error as Error).message);
    console.error(USAGE);
    process.exit(2);
  }

  const result = buildInventory(options);
  if (options.json) {
    console.log(JSON.stringify(jsonResult(result), null, 2));
    return;
  }

  console.log(
    `CSS migration inventory: ${result.legacyStylesheets} legacy stylesheets, ${result.legacyLines} lines, ${result.sourceFiles} source files`,
  );
  console.log(
    `Rules: ${result.ruleCounts.owned} owned, ${result.ruleCounts.coupled} coupled, ${result.ruleCounts.generated} generated, ${result.ruleCounts.unresolved} unresolved`,
  );
  console.log(
    `Confidence: ${result.lowConfidenceRules} rule(s) have broad-string evidence that is not class-producing syntax`,
  );
  console.log(
    "Advisory only; inspect an owner before defining a migration slice.\n",
  );

  if (options.owner) {
    const needle = options.owner.toLowerCase();
    const matches = result.owners.filter((owner) =>
      owner.owner.toLowerCase().includes(needle),
    );
    if (matches.length === 0) {
      console.log(`No owner matched: ${options.owner}`);
      return;
    }
    for (const owner of matches) printOwner(owner);
    return;
  }

  const approachable = result.owners.filter(
    (owner) =>
      owner.ownedLines >= 80 &&
      owner.coverage >= 0.65 &&
      owner.stylesheets.length <= 2 &&
      owner.coupledRules.length + owner.unresolvedRules.length <= 3,
  );
  printTable(
    "Approachable single-owner candidates",
    approachable,
    options.limit,
  );
  printTable("Largest inferred owners", result.owners, options.limit);
  console.log(
    "Drill into a candidate with: pnpm css:inventory -- --owner <name>",
  );
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) main();
