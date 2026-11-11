#!/usr/bin/env node

import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  scanCustomProperties,
  undefinedCustomProperties,
} from "./lib/css-custom-properties.mjs";

import {
  globalPurposeFindings,
  permittedGlobalStyles,
  ratchetPurposeExceptions,
} from "./lib/css-global-purposes.mjs";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const clientSrcDir = path.join(repoRoot, "packages", "client", "src");
const designDir = path.join(repoRoot, "packages", "client", "design");
const baselinePath = path.join(
  repoRoot,
  "scripts",
  "css-architecture-baseline.json",
);

function usage() {
  console.log(`Usage: node scripts/check-css-architecture.mjs [options]

Options:
  --record     Lower purpose exceptions and undefined custom-property
               counts to the current values.
  -h, --help   Show help.

The check rejects:
  - global rules outside tokens, base or declared generated families;
  - a new non-module client stylesheet outside the three permitted purposes;
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

const options = parseArgs(process.argv.slice(2));
const baseline = JSON.parse(await readFile(baselinePath, "utf8"));
const cssFiles = await collectCssFiles(clientSrcDir);
const moduleFiles = cssFiles.filter((file) => file.endsWith(".module.css"));
const globalFiles = cssFiles.filter((file) => !file.endsWith(".module.css"));
const currentGlobalPaths = new Set(globalFiles.map(relativePath));
const permittedPaths = new Set(Object.keys(permittedGlobalStyles));
const errors = [];

for (const file of globalFiles) {
  const filePath = relativePath(file);
  if (!permittedPaths.has(filePath)) {
    errors.push(
      `${filePath}: new non-module stylesheet; use a co-located *.module.css; tokens.css, base.css and generated.css are the only continuing globals`,
    );
  }
}

const families = JSON.parse(
  await readFile(
    path.join(repoRoot, "scripts/css-runtime-families.json"),
    "utf8",
  ),
);
const purposeFindings = [];
for (const [filePath, purpose] of Object.entries(permittedGlobalStyles)) {
  if (!currentGlobalPaths.has(filePath)) {
    errors.push(`${filePath}: required ${purpose} stylesheet is missing`);
    continue;
  }
  const findings = globalPurposeFindings(
    await readFile(path.join(repoRoot, filePath), "utf8"),
    purpose,
    families,
  );
  purposeFindings.push(...findings);
  console.log(
    `  ${purpose}: ${findings.length} counted purpose exceptions  ${filePath}`,
  );
}
const purposeState = ratchetPurposeExceptions(
  purposeFindings,
  baseline.globalPurposeExceptions ?? {},
);
errors.push(...purposeState.errors);
if (!options.record) {
  errors.push(
    ...purposeState.stale.map(
      (key) => `${key}: stale purpose count; run pnpm css:check --record`,
    ),
  );
}

// Undefined custom properties: a var() read of a name no client source
// defines silently takes its fallback, or drops the declaration when it has
// none. Each recorded name may only lose uses; new names are rejected. The
// design playground's reads are checked too, against production definitions
// plus its own; a playground definition never covers a production read.
const recordedUndefined = baseline.undefinedCustomProperties ?? {};
async function readPropertySources(directory) {
  return Promise.all(
    (await collectCustomPropertySources(directory)).map(async (file) => ({
      path: relativePath(file),
      text: await readFile(file, "utf8"),
    })),
  );
}
const propertySources = await readPropertySources(clientSrcDir);
const designSources = await readPropertySources(designDir);
const currentUndefined = new Map(
  undefinedCustomProperties(scanCustomProperties(propertySources)).map(
    (entry) => [entry.name, entry],
  ),
);
const designPrefix = `${relativePath(designDir)}/`;
for (const entry of undefinedCustomProperties(
  scanCustomProperties([...propertySources, ...designSources]),
)) {
  const sites = entry.sites.filter((site) =>
    site.path.startsWith(designPrefix),
  );
  if (sites.length === 0) continue;
  const known = currentUndefined.get(entry.name);
  const merged = [...(known?.sites ?? []), ...sites];
  currentUndefined.set(entry.name, {
    name: entry.name,
    uses: merged.length,
    withoutFallback: merged.filter((site) => !site.fallback).length,
    sites: merged,
  });
}
const undefinedBelow = [];
for (const [name, entry] of currentUndefined) {
  const limit = recordedUndefined[name];
  if (limit === undefined) {
    const site = entry.sites[0];
    errors.push(
      `var(${name}) is read ${entry.uses} time${entry.uses === 1 ? "" : "s"} (first at ${site.path}:${site.line}) but no client source defines it; use a theme token from packages/client/src/styles/tokens.css, define the property, or set it where its owner renders`,
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
console.log(
  `  ${currentUndefined.size} undefined custom properties read ${undefinedUses} times`,
);

if (errors.length > 0) {
  for (const error of errors) {
    console.error(`css-architecture: ${error}`);
  }
  console.error(
    "Global CSS is limited to tokens, base defaults and generated markup. Use CSS Modules and defined tokens.",
  );
  process.exit(1);
}

const pending = [
  ...purposeState.stale,
  ...undefinedBelow.map(
    ({ name, actual, limit }) => `${name} ${limit}->${actual}`,
  ),
];

if (options.record) {
  baseline.globalPurposeExceptions = purposeState.lowered;
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
