#!/usr/bin/env node

// Advisory scan for client console chattiness: console.log/info/debug/trace
// call sites in production paths (not dev-gated, not logging infrastructure)
// are warnings; console.warn/error sites are inventory shown with
// --include-info. Static companion to the runtime volume report
// (report-client-log-volume.mjs over ClientLogCollector jsonl).

import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const clientSrcDir = path.join(repoRoot, "packages", "client", "src");

const chattyMethods = new Set(["log", "info", "debug", "trace"]);
const signalMethods = new Set(["warn", "error"]);

const skippedDirectories = new Set(["__tests__", "node_modules"]);

// Logging/diagnostics infrastructure is allowed to talk to the console;
// everything else earns a warning unless dev-gated.
const allowedFilePrefixes = ["lib/diagnostics/"];

// A call is dev-gated when an enclosing if/ternary/&& condition (or the
// enclosing function name) references one of these.
const devGatePattern =
  /\b(import\.meta\.env\.(DEV|MODE)|isDev\w*|devMode|developerMode|isDeveloperMode|debugEnabled|debugLog\w*|DEBUG|verbose|shadowDiagnostics|diagnosticsEnabled)\b/i;

function usage() {
  console.log(`Usage: node scripts/find-console-chatter.mjs [options]

Options:
  --include-info       Also list console.warn/error call sites (inventory).
  --json               JSON report.
  --limit <m>=<n>      Override the baseline limit for metric m (repeatable).
  --max-warnings <n>   Shorthand for --limit warnings=<n>.
  --record             Rewrite the baseline's "observed" numbers from this run.
  -h, --help           Show help.

scripts/console-chatter-baseline.json carries two things: "limits", the
enforced ceilings (exit 1 when any bounded metric exceeds its limit;
keys name reported metrics: warnings, info, total, method.log, ...),
and "observed", the last recorded numbers — not necessarily equal to
the limits — so a run reports exactly what grew or shrank since the
last recording. Re-record with --record when your change moves them.
`);
}

function parseLimitOverride(raw, options) {
  const eq = raw.indexOf("=");
  const metric = eq >= 0 ? raw.slice(0, eq) : "";
  const value = Number(raw.slice(eq + 1));
  if (!metric || !Number.isInteger(value) || value < 0) {
    console.error(`--limit requires <metric>=<non-negative integer>: ${raw}`);
    process.exit(2);
  }
  options.limitOverrides[metric] = value;
}

function parseArgs(argv) {
  const options = {
    includeInfo: false,
    json: false,
    record: false,
    limitOverrides: {},
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      usage();
      process.exit(0);
    } else if (arg === "--include-info") {
      options.includeInfo = true;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--record") {
      options.record = true;
    } else if (arg === "--limit") {
      i += 1;
      parseLimitOverride(argv[i] ?? "", options);
    } else if (arg?.startsWith("--limit=")) {
      parseLimitOverride(arg.slice("--limit=".length), options);
    } else if (arg === "--max-warnings") {
      i += 1;
      parseLimitOverride(`warnings=${argv[i]}`, options);
    } else if (arg?.startsWith("--max-warnings=")) {
      parseLimitOverride(
        `warnings=${arg.slice("--max-warnings=".length)}`,
        options,
      );
    } else {
      console.error(`Unknown argument: ${arg}`);
      usage();
      process.exit(2);
    }
  }
  return options;
}

async function collectSourceFiles(dir) {
  const files = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (skippedDirectories.has(entry.name)) continue;
      files.push(...(await collectSourceFiles(path.join(dir, entry.name))));
      continue;
    }
    if (!/\.(ts|tsx)$/.test(entry.name)) continue;
    if (/\.(test|spec)\.(ts|tsx)$/.test(entry.name)) continue;
    if (entry.name.endsWith(".d.ts")) continue;
    files.push(path.join(dir, entry.name));
  }
  return files;
}

function consoleMethodOf(node) {
  if (!ts.isCallExpression(node)) return null;
  const callee = node.expression;
  if (!ts.isPropertyAccessExpression(callee)) return null;
  if (!ts.isIdentifier(callee.expression)) return null;
  if (callee.expression.text !== "console") return null;
  const method = callee.name.text;
  if (!chattyMethods.has(method) && !signalMethods.has(method)) return null;
  return method;
}

function devGateFor(node) {
  for (
    let child = node, current = node.parent;
    current;
    child = current, current = current.parent
  ) {
    // TypeScript names an if statement's condition `expression`. Only the
    // then-branch runs under the condition; an else-branch is not gated.
    if (
      ts.isIfStatement(current) &&
      current.thenStatement === child &&
      devGatePattern.test(current.expression.getText())
    ) {
      return current.expression.getText();
    }
    if (ts.isConditionalExpression(current)) {
      if (devGatePattern.test(current.condition.getText())) {
        return current.condition.getText();
      }
    }
    if (
      ts.isBinaryExpression(current) &&
      current.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken &&
      devGatePattern.test(current.left.getText())
    ) {
      return current.left.getText();
    }
    if (
      (ts.isFunctionDeclaration(current) ||
        ts.isMethodDeclaration(current) ||
        ts.isFunctionExpression(current)) &&
      current.name &&
      devGatePattern.test(current.name.getText())
    ) {
      return `function ${current.name.getText()}`;
    }
    if (
      ts.isVariableDeclaration(current) &&
      ts.isIdentifier(current.name) &&
      devGatePattern.test(current.name.text)
    ) {
      return `const ${current.name.text}`;
    }
  }
  return null;
}

async function scanFile(filePath) {
  const relativePath = path
    .relative(clientSrcDir, filePath)
    .split(path.sep)
    .join("/");
  const allowed = allowedFilePrefixes.some((prefix) =>
    relativePath.startsWith(prefix),
  );
  const text = await readFile(filePath, "utf8");
  const sourceFile = ts.createSourceFile(
    filePath,
    text,
    ts.ScriptTarget.Latest,
    true,
    filePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const findings = [];
  const visit = (node) => {
    const method = consoleMethodOf(node);
    if (method) {
      const { line } = sourceFile.getLineAndCharacterOfPosition(
        node.getStart(),
      );
      const gate = allowed ? "diagnostics-infrastructure" : devGateFor(node);
      const chatty = chattyMethods.has(method);
      findings.push({
        file: relativePath,
        line: line + 1,
        method,
        severity: chatty && !gate ? "warning" : "info",
        gate: gate ?? undefined,
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return findings;
}

const baselinePath = path.join(
  repoRoot,
  "scripts",
  "console-chatter-baseline.json",
);

async function loadBaseline() {
  try {
    return JSON.parse(await readFile(baselinePath, "utf8"));
  } catch {
    return {};
  }
}

function baselineLimits(baseline) {
  if (typeof baseline.limits !== "object" || baseline.limits === null) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(baseline.limits).filter(
      ([, value]) => Number.isInteger(value) && value >= 0,
    ),
  );
}

const options = parseArgs(process.argv.slice(2));
const baseline = await loadBaseline();
const limits = baselineLimits(baseline);
Object.assign(limits, options.limitOverrides);
const files = await collectSourceFiles(clientSrcDir);
const findings = (await Promise.all(files.map(scanFile))).flat();
const warnings = findings.filter((f) => f.severity === "warning");
const infos = findings.filter((f) => f.severity === "info");

const metrics = {
  warnings: warnings.length,
  info: infos.length,
  total: findings.length,
};
for (const method of [...chattyMethods, ...signalMethods]) {
  metrics[`method.${method}`] = 0;
}
for (const finding of findings) {
  metrics[`method.${finding.method}`] += 1;
}

const summary = {
  warningCount: warnings.length,
  infoCount: infos.length,
  byMethod: {},
  topFiles: {},
};
for (const finding of warnings) {
  summary.byMethod[finding.method] =
    (summary.byMethod[finding.method] ?? 0) + 1;
  summary.topFiles[finding.file] = (summary.topFiles[finding.file] ?? 0) + 1;
}
summary.topFiles = Object.fromEntries(
  Object.entries(summary.topFiles)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12),
);

summary.metrics = metrics;
summary.limits = limits;

const observed =
  typeof baseline.observed === "object" && baseline.observed !== null
    ? baseline.observed
    : null;
const drift = observed
  ? Object.keys({ ...observed, ...metrics })
      .filter((metric) => (observed[metric] ?? 0) !== (metrics[metric] ?? 0))
      .map((metric) => ({
        metric,
        from: observed[metric] ?? 0,
        to: metrics[metric] ?? 0,
      }))
  : [];
summary.observed = observed ?? undefined;
summary.drift = drift;

const unknownMetrics = Object.keys(limits).filter(
  (metric) => metrics[metric] === undefined,
);
if (unknownMetrics.length > 0) {
  console.error(
    `console-chatter: unknown metric(s) in limits: ${unknownMetrics.join(", ")}. Known metrics: ${Object.keys(metrics).join(", ")}`,
  );
  process.exit(2);
}

if (options.record) {
  const next = {
    limits: baseline.limits ?? {},
    observed: metrics,
    updated: new Date().toISOString().slice(0, 10),
    note: baseline.note,
  };
  await writeFile(baselinePath, `${JSON.stringify(next, null, 2)}\n`);
  console.log(
    `console-chatter: recorded observed numbers in ${path.relative(repoRoot, baselinePath)}; commit it with the change that moved them.`,
  );
}

if (options.json) {
  console.log(
    JSON.stringify(
      {
        summary,
        findings: options.includeInfo ? findings : warnings,
      },
      null,
      2,
    ),
  );
} else {
  for (const finding of warnings) {
    console.log(
      `${finding.file}:${finding.line} warning console.${finding.method} (ungated production path)`,
    );
  }
  if (options.includeInfo) {
    for (const finding of infos) {
      const gateNote = finding.gate ? ` [${finding.gate}]` : "";
      console.log(
        `${finding.file}:${finding.line} info console.${finding.method}${gateNote}`,
      );
    }
  }
  console.log(
    `\nWarnings: ${summary.warningCount} ungated chatty call sites; info: ${summary.infoCount} (warn/error and gated sites${options.includeInfo ? "" : "; --include-info to list"}).`,
  );
  const budgetParts = Object.entries(limits).map(([metric, max]) => {
    const delta = metrics[metric] - max;
    return `${metric} ${metrics[metric]}/${max} (${delta >= 0 ? "+" : ""}${delta})`;
  });
  if (budgetParts.length > 0) {
    console.log(`Budgets: ${budgetParts.join(", ")}`);
  }
  if (drift.length > 0 && !options.record) {
    const driftParts = drift.map(({ metric, from, to }) => {
      const delta = to - from;
      return `${metric} ${from}->${to} (${delta >= 0 ? "+" : ""}${delta})`;
    });
    console.log(
      `Drift since last recording${baseline.updated ? ` (${baseline.updated})` : ""}: ${driftParts.join(", ")}.`,
    );
    console.log(
      "If your change caused this, run pnpm console:scan --record and commit the baseline update with it; a change with no suspected console impact need not re-record.",
    );
  }
  const top = Object.entries(summary.topFiles)
    .map(([file, count]) => `  ${count}\t${file}`)
    .join("\n");
  if (top) {
    console.log(`Top files:\n${top}`);
  }
  console.log(
    "\nThis scan is intentionally approximate: gate detection is textual. Gate dev-only output behind import.meta.env.DEV or a developer-mode/debug flag, or route it through lib/diagnostics.",
  );
}

const overLimit = Object.entries(limits).filter(
  ([metric, max]) => metrics[metric] > max,
);
const underLimit = Object.entries(limits).filter(
  ([metric, max]) => metrics[metric] < max,
);
if (underLimit.length > 0) {
  console.log(
    `console-chatter: below baseline — ratchet scripts/console-chatter-baseline.json down to ${underLimit
      .map(([metric]) => `${metric}=${metrics[metric]}`)
      .join(", ")}.`,
  );
}
if (overLimit.length > 0) {
  for (const [metric, max] of overLimit) {
    console.error(
      `console-chatter: ${metric} is ${metrics[metric]}, exceeding the limit of ${max}.`,
    );
  }
  console.error(
    'Every offending site is listed above as file:line — start with files your change touched. To see the messages at runtime, and for remediation preference, read topics/console-chatter.md ("When a limit trips"). If the increase is genuinely justified, raise scripts/console-chatter-baseline.json in the same commit and say why.',
  );
  process.exit(1);
}
