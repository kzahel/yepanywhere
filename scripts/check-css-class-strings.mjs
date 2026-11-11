import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import postcss from "postcss";
import selectorParser from "postcss-selector-parser";
import { fileURLToPath } from "node:url";
import {
  classStringFindings,
  ratchetClassStrings,
} from "./lib/css-class-strings.mjs";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sources = new Map();
async function walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (
      entry.isDirectory() &&
      !["__tests__", "test", "tests"].includes(entry.name)
    )
      await walk(file);
    else if (
      entry.isFile() &&
      /\.tsx?$/.test(file) &&
      !/\.(test|spec)\./.test(file)
    )
      sources.set(file, await readFile(file, "utf8"));
  }
}
const args = process.argv.slice(2);
if (args.some((arg) => !["--record", "--json"].includes(arg)))
  throw new Error("Usage: pnpm css:classes [--record] [--json]");
await walk(path.join(root, "packages/client/src"));
const families = JSON.parse(
  await readFile(path.join(root, "scripts/css-runtime-families.json"), "utf8"),
);
const globals = [];
for (const file of ["tokens", "base", "generated"]) {
  postcss
    .parse(
      await readFile(
        path.join(root, `packages/client/src/styles/${file}.css`),
        "utf8",
      ),
    )
    .walkRules((rule) =>
      selectorParser((selectors) =>
        selectors.walkClasses((node) => globals.push(node.value)),
      ).processSync(rule.selector),
    );
}
const findings = classStringFindings(sources, families, globals).map((row) => ({
  ...row,
  file: path.relative(root, row.file).split(path.sep).join("/"),
}));
const allowPath = path.join(root, "scripts/css-class-string-allowlist.json");
const state = ratchetClassStrings(
  findings,
  JSON.parse(await readFile(allowPath, "utf8")),
);
if (args.includes("--record") && !state.errors.length)
  await writeFile(allowPath, `${JSON.stringify(state.next, null, 2)}\n`);
if (args.includes("--json"))
  console.log(JSON.stringify({ findings, ...state }, null, 2));
else {
  console.log(
    `CSS class strings: ${findings.length} exceptions in ${new Set(findings.map((row) => row.file)).size} files.`,
  );
  for (const error of state.errors) console.error(error);
  if (!args.includes("--record"))
    for (const key of state.stale)
      console.error(`${key}: stale entry; run pnpm css:classes --record`);
}
if (state.errors.length || (!args.includes("--record") && state.stale.length))
  process.exitCode = 1;
