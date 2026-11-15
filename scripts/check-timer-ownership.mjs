#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const ledgerRelativePath = "scripts/timer-ownership.json";
const ledgerPath = path.join(repoRoot, ledgerRelativePath);

// Same production-source scope as scripts/check-source-file-budgets.mjs.
const SOURCE_PATHSPEC = ":(glob)packages/*/src/**";
const SOURCE_EXTENSION = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const EXCLUDED_SOURCE =
  /(?:\/__tests__\/|\/test\/|\/tests\/|\/generated\/|\.test\.|\.spec\.|\.test-support\.|\.d\.ts$)/;
const MIN_NOTE_LENGTH = 20;

const TIMER_CALL = /setTimeout|setInterval|requestAnimationFrame|setImmediate/;
// `window.setTimeout`, `rootWindow.setTimeout`, `doc.defaultView.setTimeout`.
// A call on any other object (`deps.setTimeout`, `this.timers.setTimeout`) is
// an injected clock; its real timer is the default implementation's call.
const GLOBAL_RECEIVER =
  /^(?:window|globalThis|self|global|win|view)$|[wW]indow$|(?:^|\.)(?:defaultView|contentWindow)$/;
// Callbacks whose return value the caller drops, so a timer returned from one
// is as unreachable as a bare statement.
const RESULT_DROPPING_CALLS = new Set(["forEach", "then", "catch", "finally"]);

/**
 * The ledger's three sections, keyed by the site class each one bounds. Every
 * other class is reported by `--list` and not enforced.
 */
export const ENFORCED = {
  recurring: {
    section: "recurring",
    note: "stops",
    advice:
      "A repeating timer needs a named owner and a stop path (topics/architecture-mandates.md#timer-ownership). Join an existing owner such as lib/processIdleSweep.ts or hooks/useRelativeNow.ts before adding another interval, and never create one per session, project, cache or client.",
  },
  yield: {
    section: "yields",
    note: "reason",
    advice:
      "A zero-delay timer waits for something it does not name. Act on the event, promise or layout pass that makes the work ready instead of a later task.",
  },
  detached: {
    section: "detached",
    note: "reason",
    advice:
      "A timer whose handle is dropped cannot be cancelled when its owner goes away. Keep the handle and clear it on teardown.",
  },
};
export const RECURRING_KINDS = [
  "clock",
  "flush",
  "heartbeat",
  "poll",
  "repeat",
  "sampler",
  "sweep",
];

function unwrap(node) {
  let current = node;
  while (
    ts.isParenthesizedExpression(current.parent) ||
    ts.isAsExpression(current.parent) ||
    ts.isNonNullExpression(current.parent) ||
    ts.isSatisfiesExpression(current.parent)
  ) {
    current = current.parent;
  }
  return current;
}

function isPromiseExecutor(fn) {
  const parent = fn.parent;
  return (
    ts.isNewExpression(parent) &&
    parent.expression.getText() === "Promise" &&
    parent.arguments?.[0] === fn
  );
}

function enclosingFunction(node) {
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isFunctionLike(current)) return current;
  }
  return undefined;
}

/** Whether anything can still reach the handle a timer call returned. */
function handleFate(call) {
  let current = unwrap(call);
  for (;;) {
    const parent = current.parent;
    // `timer.unref()` returns the timer on Node.
    if (
      ts.isPropertyAccessExpression(parent) &&
      parent.expression === current &&
      parent.name.text === "unref" &&
      ts.isCallExpression(parent.parent) &&
      parent.parent.expression === parent
    ) {
      current = unwrap(parent.parent);
      continue;
    }
    if (ts.isArrowFunction(parent) && parent.body === current) {
      if (isPromiseExecutor(parent)) return "sleep";
      const user = parent.parent;
      if (ts.isCallExpression(user) && user.arguments.includes(parent)) {
        const callee = user.expression;
        if (
          ts.isPropertyAccessExpression(callee) &&
          RESULT_DROPPING_CALLS.has(callee.name.text)
        ) {
          return "detached";
        }
        // `runOutsideRequestContext(() => setTimeout(...))`, `delays.map(...)`.
        current = unwrap(user);
        continue;
      }
      return "owned";
    }
    if (ts.isExpressionStatement(parent) || ts.isVoidExpression(parent)) {
      const fn = enclosingFunction(parent);
      return fn && isPromiseExecutor(fn) ? "sleep" : "detached";
    }
    return "owned";
  }
}

function isZeroDelay(delay) {
  return (
    delay === undefined ||
    (ts.isNumericLiteral(delay) && Number(delay.text) === 0)
  );
}

function scopeName(node) {
  for (let current = node.parent; current; current = current.parent) {
    if (
      (ts.isFunctionDeclaration(current) ||
        ts.isMethodDeclaration(current) ||
        ts.isClassDeclaration(current)) &&
      current.name
    ) {
      return current.name.getText();
    }
    if (
      (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) &&
      (ts.isVariableDeclaration(current.parent) ||
        ts.isPropertyAssignment(current.parent) ||
        ts.isPropertyDeclaration(current.parent))
    ) {
      return current.parent.name.getText();
    }
  }
  return "";
}

/**
 * One record per timer call in `source`:
 *
 * - `recurring`: `setInterval`.
 * - `yield`: `setTimeout` with no delay or a literal `0`.
 * - `sleep`: a promise that settles on a timer nobody holds.
 * - `detached`: any other `setTimeout` whose handle is dropped.
 * - `owned`: a `setTimeout` whose handle is kept, returned or passed on.
 * - `frame`, `immediate`: `requestAnimationFrame`, `setImmediate`.
 */
export function findTimerSites(file, source) {
  if (!TIMER_CALL.test(source)) return [];
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    /\.[jt]sx$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  // `import { setTimeout as sleep } from "node:timers/promises"`.
  const awaitable = new Set();
  for (const statement of sourceFile.statements) {
    if (
      ts.isImportDeclaration(statement) &&
      /timers\/promises["']$/.test(statement.moduleSpecifier.getText())
    ) {
      const bindings = statement.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          if ((element.propertyName ?? element.name).text === "setTimeout") {
            awaitable.add(element.name.text);
          }
        }
      }
    }
  }

  const sites = [];
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      let name;
      if (ts.isIdentifier(callee)) {
        name = awaitable.has(callee.text) ? "sleep" : callee.text;
      } else if (
        ts.isPropertyAccessExpression(callee) &&
        GLOBAL_RECEIVER.test(callee.expression.getText().replace(/[?!]/g, ""))
      ) {
        name = callee.name.text;
      }
      let siteClass;
      if (name === "sleep") {
        siteClass = isZeroDelay(node.arguments[0]) ? "yield" : "sleep";
      } else if (name === "setInterval") {
        siteClass = "recurring";
      } else if (name === "requestAnimationFrame") {
        siteClass = "frame";
      } else if (name === "setImmediate") {
        siteClass = "immediate";
      } else if (name === "setTimeout") {
        siteClass = isZeroDelay(node.arguments[1]) ? "yield" : handleFate(node);
      }
      if (siteClass) {
        const delay = name === "sleep" ? node.arguments[0] : node.arguments[1];
        sites.push({
          file,
          line:
            sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1,
          class: siteClass,
          delay:
            siteClass === "frame" || siteClass === "immediate"
              ? ""
              : (delay?.getText().replace(/\s+/g, " ") ?? ""),
          scope: scopeName(node),
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return sites;
}

/**
 * Compare each file's site counts with the ledger. Returns the errors and the
 * entries `--record` may lower or retire.
 */
export function checkLedger(ledger, sites) {
  const errors = [];
  const lowerable = [];
  for (const [siteClass, rule] of Object.entries(ENFORCED)) {
    const counts = new Map();
    for (const site of sites) {
      if (site.class === siteClass) {
        counts.set(site.file, (counts.get(site.file) ?? 0) + 1);
      }
    }
    const entries = ledger[rule.section] ?? {};
    for (const [file, count] of counts) {
      const entry = entries[file];
      if (!entry) {
        errors.push(
          `${file}: ${count} ${siteClass} timer${count === 1 ? "" : "s"} with no ${rule.section} entry. ${rule.advice}`,
        );
      } else if (count > entry.count) {
        errors.push(
          `${file}: ${count} ${siteClass} timers exceeds its recorded ${entry.count}. ${rule.advice}`,
        );
      }
    }
    for (const [file, entry] of Object.entries(entries)) {
      const count = counts.get(file) ?? 0;
      if (!Number.isInteger(entry?.count) || entry.count < 1) {
        errors.push(
          `${file}: ${rule.section} count must be a positive integer`,
        );
        continue;
      }
      const note = entry[rule.note];
      if (typeof note !== "string" || note.trim().length < MIN_NOTE_LENGTH) {
        errors.push(
          `${file}: ${rule.section} entry needs "${rule.note}" stating ${rule.note === "stops" ? "what owns the timer and what stops it" : "why the timer stands"}`,
        );
      }
      if (siteClass === "recurring" && !RECURRING_KINDS.includes(entry.kind)) {
        errors.push(
          `${file}: recurring "kind" must be one of ${RECURRING_KINDS.join(", ")}`,
        );
      }
      if (count < entry.count) {
        lowerable.push({
          section: rule.section,
          file,
          count,
          recorded: entry.count,
        });
      }
    }
  }
  return { errors, lowerable };
}

function usage() {
  console.log(`Usage: node scripts/check-timer-ownership.mjs [options]

Options:
  --record        Lower recorded counts to the current counts and retire
                  entries for files with no such timer left. Never adds or
                  raises.
  --list [class]  Print every timer site, or only one class: recurring, yield,
                  detached, sleep, owned, frame or immediate.
  -h, --help      Show help.

The check rejects a production source file with more repeating timers
(setInterval), zero-delay timers, or dropped-handle timers than
${ledgerRelativePath} records for it.

Read topics/architecture-mandates.md#timer-ownership before editing the
ledger.
`);
}

function parseArgs(argv) {
  const options = { record: false, list: false, listClass: undefined };
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
      const next = argv[index + 1];
      if (next && !next.startsWith("-")) {
        options.listClass = next;
        index += 1;
      }
      continue;
    }
    console.error(`Unknown argument: ${arg}`);
    usage();
    process.exit(2);
  }
  return options;
}

function listProductionSources() {
  // Tracked plus untracked-but-not-ignored, so a new file fails before commit.
  const output = execFileSync(
    "git",
    [
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "-z",
      "--",
      SOURCE_PATHSPEC,
    ],
    { cwd: repoRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  return [...new Set(output.split("\0"))]
    .filter((file) => SOURCE_EXTENSION.test(file))
    .filter((file) => !EXCLUDED_SOURCE.test(`/${file}`))
    .sort();
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const ledger = JSON.parse(await readFile(ledgerPath, "utf8"));
  const sites = [];
  for (const file of listProductionSources()) {
    let source;
    try {
      source = await readFile(path.join(repoRoot, file), "utf8");
    } catch (error) {
      // A deleted-but-still-indexed file is not a source file any more.
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    sites.push(...findTimerSites(file, source));
  }

  const totals = {};
  for (const site of sites) {
    totals[site.class] = (totals[site.class] ?? 0) + 1;
  }
  console.log(
    `Timer ownership: ${sites.length} timer sites (${Object.entries(totals)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([siteClass, count]) => `${count} ${siteClass}`)
      .join(", ")}).`,
  );

  if (options.list) {
    for (const site of sites) {
      if (options.listClass && site.class !== options.listClass) continue;
      console.log(
        `  ${site.class.padEnd(9)} ${site.file}:${site.line}  ${site.scope}${site.delay ? `  (${site.delay})` : ""}`,
      );
    }
  }

  const { errors, lowerable } = checkLedger(ledger, sites);
  if (errors.length > 0) {
    for (const error of errors) {
      console.error(`timer-ownership: ${error}`);
    }
    console.error(
      `Recorded counts only shrink. A new ${ledgerRelativePath} entry, or a higher count, needs maintainer approval.`,
    );
    process.exit(1);
  }

  if (options.record) {
    for (const { section, file, count } of lowerable) {
      if (count === 0) delete ledger[section][file];
      else ledger[section][file].count = count;
    }
    if (lowerable.length > 0) {
      ledger.updated = new Date().toISOString().slice(0, 10);
      await writeFile(
        ledgerPath,
        `${JSON.stringify(ledger, null, 2)}\n`,
        "utf8",
      );
    }
    console.log(
      lowerable.length > 0
        ? `timer-ownership: lowered or retired ${lowerable.length} entries.`
        : "timer-ownership: all recorded counts already match.",
    );
  } else if (lowerable.length > 0) {
    console.log(
      `timer-ownership: below the recorded count; run pnpm timers:check --record to ratchet ${lowerable
        .map(({ file, count, recorded }) => `${file} ${recorded}->${count}`)
        .join(", ")}.`,
    );
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await main();
}
