#!/usr/bin/env node

import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  scanCustomProperties,
  undefinedCustomProperties,
} from "./lib/css-custom-properties.mjs";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const clientSrcDir = path.join(repoRoot, "packages", "client", "src");
const baselinePath = path.join(
  repoRoot,
  "scripts",
  "css-architecture-baseline.json",
);

function usage() {
  console.log(`Usage: node scripts/check-css-architecture.mjs [options]

Options:
  --record     Lower legacy global CSS limits and undefined custom-property
               counts to the current values.
  -h, --help   Show help.

The check rejects:
  - growth above a legacy global stylesheet's recorded line limit; and
  - a new non-module client stylesheet without a reviewed baseline entry;
  - a var(--name) read of a custom property that no client source defines,
    beyond the recorded count for that name.

Read topics/css-architecture.md before changing the baseline.
`);
}

function parseArgs(argv) {
  const options = { record: false };
  for (const arg of argv) {
    if (arg === "-h" || arg === "--help") {
      usage();
      process.exit(0);
    }
    if (arg === "--record") {
      options.record = true;
      continue;
    }
    console.error(`Unknown argument: ${arg}`);
    usage();
    process.exit(2);
  }
  return options;
}

async function collectFiles(directory, accept) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(entryPath, accept)));
    } else if (entry.isFile() && accept(entry.name, entryPath)) {
      files.push(entryPath);
    }
  }
  return files;
}

function collectCssFiles(directory) {
  return collectFiles(directory, (name) => name.endsWith(".css"));
}

/** Production client sources that can define or read a custom property. */
function collectCustomPropertySources(directory) {
  return collectFiles(
    directory,
    (name, filePath) =>
      /\.(css|tsx?)$/.test(name) &&
      !/\.test\.tsx?$/.test(name) &&
      !filePath.split(path.sep).includes("__tests__"),
  );
}

function relativePath(filePath) {
  return path.relative(repoRoot, filePath).split(path.sep).join("/");
}

function lineCount(text) {
  if (text.length === 0) return 0;
  const newlines = text.match(/\n/g)?.length ?? 0;
  return newlines + (text.endsWith("\n") ? 0 : 1);
}

const options = parseArgs(process.argv.slice(2));
const baseline = JSON.parse(await readFile(baselinePath, "utf8"));
const legacyGlobalStyles = baseline.legacyGlobalStyles ?? {};
const cssFiles = await collectCssFiles(clientSrcDir);
const moduleFiles = cssFiles.filter((file) => file.endsWith(".module.css"));
const globalFiles = cssFiles.filter((file) => !file.endsWith(".module.css"));
const currentGlobalPaths = new Set(globalFiles.map(relativePath));
const configuredGlobalPaths = new Set(Object.keys(legacyGlobalStyles));
const errors = [];
const belowBaseline = [];
const currentCounts = new Map();

for (const file of globalFiles) {
  const filePath = relativePath(file);
  if (!configuredGlobalPaths.has(filePath)) {
    errors.push(
      `${filePath}: new non-module stylesheet; use a co-located *.module.css or add a reviewed global exception with a reason`,
    );
  }
}

for (const filePath of configuredGlobalPaths) {
  if (!currentGlobalPaths.has(filePath)) {
    errors.push(
      `${filePath}: baseline entry has no matching file; remove the stale reviewed exception`,
    );
    continue;
  }

  const text = await readFile(path.join(repoRoot, filePath), "utf8");
  const actual = lineCount(text);
  const limit = legacyGlobalStyles[filePath].maxLines;
  currentCounts.set(filePath, actual);

  if (!Number.isInteger(limit) || limit < 0) {
    errors.push(`${filePath}: maxLines must be a non-negative integer`);
  } else if (actual > limit) {
    errors.push(
      `${filePath}: ${actual} lines exceeds the frozen limit of ${limit}`,
    );
  } else if (actual < limit) {
    belowBaseline.push({ filePath, actual, limit });
  }
}

// Undefined custom properties: a var() read of a name no client source
// defines silently takes its fallback, or drops the declaration when it has
// none. Each recorded name may only lose uses; new names are rejected.
const recordedUndefined = baseline.undefinedCustomProperties ?? {};
const propertySources = await Promise.all(
  (await collectCustomPropertySources(clientSrcDir)).map(async (file) => ({
    path: relativePath(file),
    text: await readFile(file, "utf8"),
  })),
);
const currentUndefined = new Map(
  undefinedCustomProperties(scanCustomProperties(propertySources)).map(
    (entry) => [entry.name, entry],
  ),
);
const undefinedBelow = [];
for (const [name, entry] of currentUndefined) {
  const limit = recordedUndefined[name];
  if (limit === undefined) {
    const site = entry.sites[0];
    errors.push(
      `var(${name}) is read ${entry.uses} time${entry.uses === 1 ? "" : "s"} (first at ${site.path}:${site.line}) but no client source defines it; use a theme token from packages/client/src/styles/index.css, define the property, or set it where its owner renders`,
    );
  } else if (!Number.isInteger(limit) || limit < 1) {
    errors.push(`${name}: recorded undefined uses must be a positive integer`);
  } else if (entry.uses > limit) {
    errors.push(
      `var(${name}) is read ${entry.uses} times without a definition; the recorded limit is ${limit}`,
    );
  } else if (entry.uses < limit) {
    undefinedBelow.push({ name, actual: entry.uses, limit });
  }
}
for (const [name, limit] of Object.entries(recordedUndefined)) {
  if (!currentUndefined.has(name)) {
    undefinedBelow.push({ name, actual: 0, limit });
  }
}
const undefinedUses = [...currentUndefined.values()].reduce(
  (total, entry) => total + entry.uses,
  0,
);

console.log(
  `CSS architecture: ${globalFiles.length} authored global stylesheets, ${moduleFiles.length} CSS Modules.`,
);
for (const filePath of [...configuredGlobalPaths].sort()) {
  const actual = currentCounts.get(filePath);
  const limit = legacyGlobalStyles[filePath].maxLines;
  if (actual !== undefined) {
    console.log(`  ${actual}/${limit} lines  ${filePath}`);
  }
}
console.log(
  `  ${currentUndefined.size} undefined custom properties read ${undefinedUses} times`,
);

if (errors.length > 0) {
  for (const error of errors) {
    console.error(`css-architecture: ${error}`);
  }
  console.error(
    "Legacy global CSS and undefined custom properties are frozen. Extract component-owned rules into CSS Modules and read defined tokens; do not raise a limit without explicit architectural justification.",
  );
  process.exit(1);
}

const pending = [
  ...belowBaseline.map(
    ({ filePath, actual, limit }) => `${filePath} ${limit}->${actual}`,
  ),
  ...undefinedBelow.map(
    ({ name, actual, limit }) => `${name} ${limit}->${actual}`,
  ),
];

if (options.record) {
  for (const { filePath, actual } of belowBaseline) {
    legacyGlobalStyles[filePath].maxLines = actual;
  }
  for (const { name, actual } of undefinedBelow) {
    if (actual === 0) delete recordedUndefined[name];
    else recordedUndefined[name] = actual;
  }
  if (pending.length > 0) {
    baseline.undefinedCustomProperties = Object.fromEntries(
      Object.entries(recordedUndefined).sort(([a], [b]) => a.localeCompare(b)),
    );
    baseline.updated = new Date().toISOString().slice(0, 10);
    await writeFile(
      baselinePath,
      `${JSON.stringify(baseline, null, 2)}\n`,
      "utf8",
    );
    console.log(
      `css-architecture: ratcheted ${pending.length} limit${pending.length === 1 ? "" : "s"} downward.`,
    );
  } else {
    console.log("css-architecture: all limits already match current counts.");
  }
} else if (pending.length > 0) {
  console.log(
    `css-architecture: below baseline; run pnpm css:check --record to ratchet ${pending.join(", ")}.`,
  );
}
