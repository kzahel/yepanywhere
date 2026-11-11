import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  emittedAttributes,
  attributeHookFindings,
  ratchetAttributeHooks,
} from "./lib/css-attribute-hooks.mjs";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sources = new Map(),
  styles = new Map();
async function walk(dir) {
  for (const entry of await readdir(path.join(root, dir), {
    withFileTypes: true,
  })) {
    const file = `${dir}/${entry.name}`;
    if (
      entry.isDirectory() &&
      !["__tests__", "tests", "test"].includes(entry.name)
    )
      await walk(file);
    else if (entry.isFile() && !/\.(test|spec)\./.test(file)) {
      if (/\.(tsx?|mjs)$/.test(file))
        sources.set(file, await readFile(path.join(root, file), "utf8"));
      if (
        file.startsWith("packages/client/src/") &&
        (file.endsWith(".module.css") || /\/(base|generated)\.css$/.test(file))
      )
        styles.set(file, await readFile(path.join(root, file), "utf8"));
    }
  }
}
for (const dir of [
  "packages/client/src",
  "packages/server/src",
  "packages/shared/src",
])
  await walk(dir);
const args = process.argv.slice(2);
if (args.some((arg) => !["--record", "--json"].includes(arg)))
  throw new Error("Usage: pnpm css:hooks [--record] [--json]");
const listPath = path.join(root, "scripts/css-attribute-hook-allowlist.json");
const familyPath = path.join(root, "scripts/css-attribute-families.json");
const families = JSON.parse(await readFile(familyPath, "utf8"));
for (const family of families) {
  if (
    !family.reason?.trim() ||
    !family.attribute?.startsWith("^") ||
    !family.attribute.endsWith("$") ||
    !family.value?.startsWith("^") ||
    !family.value.endsWith("$") ||
    !sources.has(family.source)
  )
    throw new Error(
      "Attribute families need anchored patterns, an emitter and reason",
    );
  if (
    ![...styles.values()].some((text) =>
      text
        .match(/\[(data-[\w-]+)/g)
        ?.some((name) => new RegExp(family.attribute).test(name.slice(1))),
    )
  )
    throw new Error(`Stale attribute family: ${family.attribute}`);
}
const findings = attributeHookFindings(
  styles,
  emittedAttributes(sources),
  families,
);
const state = ratchetAttributeHooks(
  findings,
  JSON.parse(await readFile(listPath, "utf8")),
);
if (args.includes("--record") && !state.errors.length)
  await writeFile(listPath, `${JSON.stringify(state.next, null, 2)}\n`);
if (args.includes("--json"))
  console.log(JSON.stringify({ findings, ...state }, null, 2));
else {
  console.log(
    `CSS attribute hooks: ${findings.length} unemitted selector exceptions; ${families.length} declared generated/runtime families.`,
  );
  for (const error of state.errors) console.error(error);
  if (!args.includes("--record"))
    for (const key of state.stale)
      console.error(`${key}: stale count; run pnpm css:hooks --record`);
}
if (state.errors.length || (!args.includes("--record") && state.stale.length))
  process.exitCode = 1;
