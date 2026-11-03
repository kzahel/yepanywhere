#!/usr/bin/env node

// Playwright launches Chromium with --no-sandbox unless chromiumSandbox is
// true, so a renderer exploit in a page under test would run with the
// developer's full privileges. This check keeps every launch sandboxed.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

function usage() {
  console.log(`Usage: node scripts/check-chromium-sandbox.mjs

The check rejects, in tracked JavaScript and TypeScript files:
  - a Chromium launch call (chromium.launch, launchPersistentContext,
    launchServer) whose arguments omit \`chromiumSandbox: true\`;
  - a \`launchOptions: { ... }\` object in a Playwright config or e2e spec
    that omits it, since \`test.use({ launchOptions })\` replaces the
    config's options rather than merging with them; and
  - a packages/client/playwright*.config.ts that neither sets it nor
    imports another Playwright config it inherits from.
`);
}

const SANDBOX = /\bchromiumSandbox\s*:\s*true\b/;
const LAUNCH_CALL =
  /(?:\bchromium|\))\s*\.\s*(?:launch|launchPersistentContext|launchServer)\s*\(/g;
const LAUNCH_OPTIONS = /\blaunchOptions\s*:\s*\{/g;
const PLAYWRIGHT_CONFIG = /^packages\/client\/playwright[^/]*\.config\.ts$/;
const CONFIG_IMPORT = /^import\s+\w+\s+from\s+"\.\/playwright[^"]*\.config"/m;

// Returns the text between the opening bracket at `open` and its match.
// Brackets inside strings are not special-cased; launch arguments here do
// not contain unbalanced ones.
function balanced(text, open) {
  const pairs = { "(": ")", "{": "}" };
  const close = pairs[text[open]];
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === text[open]) depth++;
    else if (text[i] === close && --depth === 0) return text.slice(open, i + 1);
  }
  return text.slice(open);
}

function lineOf(text, index) {
  return text.slice(0, index).split("\n").length;
}

if (process.argv.slice(2).some((arg) => arg === "-h" || arg === "--help")) {
  usage();
  process.exit(0);
}
if (process.argv.length > 2) {
  console.error(`Unknown argument: ${process.argv[2]}`);
  usage();
  process.exit(2);
}

const files = execFileSync(
  "git",
  ["ls-files", "--", "*.ts", "*.tsx", "*.mjs", "*.js", "*.cjs"],
  { cwd: repoRoot, encoding: "utf8" },
)
  .split("\n")
  .filter(
    (file) =>
      file &&
      !file.includes("node_modules/") &&
      file !== "scripts/check-chromium-sandbox.mjs",
  );

const problems = [];
for (const file of files) {
  let text;
  try {
    text = readFileSync(path.join(repoRoot, file), "utf8");
  } catch (error) {
    // A tracked file deleted in the working tree has nothing to check.
    if (error.code === "ENOENT") continue;
    throw error;
  }
  const isConfig = PLAYWRIGHT_CONFIG.test(file);
  if (text.includes("launch")) {
    for (const match of text.matchAll(LAUNCH_CALL)) {
      const open = match.index + match[0].length - 1;
      if (!SANDBOX.test(balanced(text, open)))
        problems.push(
          `${file}:${lineOf(text, match.index)}: Chromium launch without chromiumSandbox: true`,
        );
    }
  }
  if (isConfig || file.startsWith("packages/client/e2e/")) {
    for (const match of text.matchAll(LAUNCH_OPTIONS)) {
      const open = match.index + match[0].length - 1;
      if (!SANDBOX.test(balanced(text, open)))
        problems.push(
          `${file}:${lineOf(text, match.index)}: launchOptions without chromiumSandbox: true`,
        );
    }
  }
  if (isConfig && !SANDBOX.test(text) && !CONFIG_IMPORT.test(text))
    problems.push(
      `${file}: Playwright config neither sets launchOptions.chromiumSandbox nor inherits a config that does`,
    );
}

if (problems.length) {
  for (const problem of problems) console.error(`chromium-sandbox: ${problem}`);
  console.error(
    "Pass chromiumSandbox: true to every Chromium launch; Playwright otherwise disables the sandbox.",
  );
  process.exit(1);
}
console.log(`chromium-sandbox: ${files.length} files checked, all sandboxed.`);
