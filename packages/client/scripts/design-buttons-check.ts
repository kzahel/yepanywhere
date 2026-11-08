/**
 * The button ban (plan 182, family 1, step 5). Rejects, in the client's
 * production sources:
 *
 * 1. a banned legacy button class in TS/TSX or a CSS Module: every class
 *    from design/census/mapping.ts that no global stylesheet styles, plus
 *    the classes recorded in the allowlist's `bannedClasses`, so restoring
 *    a deleted rule does not lift the ban;
 * 2. a raw `<button>` outside src/components/ui/Button.tsx, unless it
 *    belongs to a later family (a menu, tab, option or radio role, a named
 *    option-picker or switch class, the composer's files) or its file is
 *    in the allowlist with at least that many;
 * 3. an element with `role="button"` beyond the allowlist: a real button
 *    (ButtonBase) gets keyboard and focus behavior for free;
 * 4. a CSS rule, in a CSS Module or a global stylesheet, whose selector
 *    reaches a bare `button` element (`.panel button`, not `button.own`)
 *    and sets look or size properties (background, border, color, padding,
 *    font, radius, width, height, outline, shadow). Such a rule outranks
 *    ButtonBase's zero-specificity reset and ties with Button's variants,
 *    so a shared control under it loses its look, size or focus ring.
 *    Button.module.css and the composer's modules are exempt.
 *
 * The allowlist (design/census/button-allowlist.json) gives each entry a
 * count and a reason; a later family inherits the entries that name it.
 * A count may only fall: `--record` lowers counts to what the scan finds,
 * drops entries that reach zero and adds newly rule-less legacy classes to
 * `bannedClasses`; it never raises a count or adds a file. Counts are per
 * file, so a file may trade one allowed button for another.
 *
 *   pnpm -s buttons:check            check
 *   pnpm -s buttons:check --record   lower the allowlist after a swap
 */
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { parseArgs } from "node:util";
import { scanButtonElements } from "../design/buttonElements";
import { COMPOSER_FILE, rawButtonFamily } from "../design/buttonFamilies";
import { LEGACY_BUTTONS } from "../design/census/mapping";
import { collectDesignData } from "../design/vite-plugin-design-data";
import { clientRoot } from "./design-index";

const help = `Usage: pnpm -s buttons:check [--record]

Reject banned legacy button classes, raw <button>s outside
src/components/ui/Button.tsx and the later families, role="button"
elements, and CSS rules that style a bare button element's look. Exceptions
live in packages/client/design/census/button-allowlist.json with a count
and a reason; --record lowers those counts to the current scan.`;

const { values } = parseArgs({
  options: {
    record: { type: "boolean" },
    help: { type: "boolean", short: "h" },
  },
});
if (values.help) {
  console.log(help);
  process.exit(0);
}

const srcDir = join(clientRoot, "src");
const allowlistPath = join(clientRoot, "design/census/button-allowlist.json");

interface AllowEntry {
  count: number;
  reason: string;
}
type AllowSection = "rawButtons" | "roleButtons" | "buttonLookRules";
interface Allowlist extends Record<AllowSection, Record<string, AllowEntry>> {
  bannedClasses: string[];
}

const GLOBAL_STYLESHEETS = [
  "styles/index.css",
  "styles/renderers.css",
  "styles/tool-rows.css",
];

const LOOK_PROPERTY =
  /^(?:background(?:-color|-image)?|border(?:-[a-z-]+)?|color|padding(?:-[a-z-]+)?|font(?:-[a-z-]+)?|(?:min-)?(?:height|width)|outline(?:-[a-z-]+)?|box-shadow|appearance)$/;
/**
 * A bare `button` type selector (`.panel button`, `button:hover`), not a
 * class or id that contains the word. `button.own` is the owner styling its
 * own element, which ButtonBase owners do.
 */
const BUTTON_ELEMENT = /(?:^|[\s>+~(,])button(?![\w.#-])/;

async function walk(directory: string, accept: (name: string) => boolean) {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "__tests__") files.push(...(await walk(path, accept)));
    } else if (accept(entry.name)) files.push(path);
  }
  return files;
}

function srcPath(path: string) {
  return relative(srcDir, path).split(sep).join("/");
}

function lineAt(text: string, index: number) {
  return text.slice(0, index).split("\n").length;
}

const problems: string[] = [];

const allowlist = JSON.parse(
  await readFile(allowlistPath, "utf8"),
) as Allowlist;

// 1. Banned legacy classes: rule-less now, or recorded as banned before.
const declared = await collectDesignData(srcDir);
const banned = [
  ...new Set([
    ...allowlist.bannedClasses,
    ...LEGACY_BUTTONS.flatMap((row) => row.classes.split(/\s+/)).filter(
      (name) => !declared[name],
    ),
  ]),
].sort();
const bannedPattern = new RegExp(
  `(?<![\\w-])(?:${banned.map((name) => name.replace(/[-]/g, "\\-")).join("|")})(?![\\w-])`,
  "g",
);
const sources = await walk(
  srcDir,
  (name) =>
    /\.(?:tsx?|module\.css)$/.test(name) &&
    !/\.(?:test|specimen)\.tsx?$/.test(name),
);
if (banned.length) {
  for (const path of sources) {
    const text = await readFile(path, "utf8");
    for (const match of text.matchAll(bannedPattern)) {
      const index = match.index ?? 0;
      const lineStart = text.lastIndexOf("\n", index) + 1;
      const before = text.slice(lineStart, index);
      // Comments and test ids may name a class; only class lists count.
      if (
        /^\s*(?:\/\/|\/?\*|\{\/\*)/.test(before) ||
        /data-testid=["'`]$/.test(before)
      )
        continue;
      problems.push(
        `${srcPath(path)}:${lineAt(text, index)}: legacy button class "${match[0]}" is banned; use the shared Button controls`,
      );
    }
  }
}

// 2 and 3. Raw buttons and role="button" elements.
const rawCounts = new Map<string, number>();
const roleCounts = new Map<string, number>();
for (const row of await scanButtonElements(srcDir)) {
  if (row.kind === "role-button") {
    roleCounts.set(row.file, (roleCounts.get(row.file) ?? 0) + 1);
    continue;
  }
  if (row.kind !== "raw" || row.file === "components/ui/Button.tsx") continue;
  if (rawButtonFamily(row)) continue;
  rawCounts.set(row.file, (rawCounts.get(row.file) ?? 0) + 1);
}

// 4. CSS rules that style a bare button element.
const lookCounts = new Map<string, number>();
const lookSites = new Map<string, string[]>();
const stylesheets = [
  ...GLOBAL_STYLESHEETS.map((file) => join(srcDir, file)),
  ...sources.filter((file) => file.endsWith(".module.css")),
];
for (const path of stylesheets) {
  const file = srcPath(path);
  if (file === "components/ui/Button.module.css") continue;
  if (COMPOSER_FILE.test(file.replace(/\.module\.css$/, ".tsx"))) continue;
  const text = (await readFile(path, "utf8")).replace(
    /\/\*[\s\S]*?\*\//g,
    (c) => c.replace(/[^\n]/g, " "),
  );
  for (const rule of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = (rule[1] ?? "").trim();
    // `:not(button)` excludes buttons rather than reaching them.
    const reaching = selector.replace(/:not\([^()]*\)/g, "");
    if (selector.startsWith("@") || !BUTTON_ELEMENT.test(reaching)) continue;
    const looks = (rule[2] ?? "")
      .split(";")
      .map((declaration) => declaration.split(":")[0]?.trim() ?? "")
      .filter((property) => LOOK_PROPERTY.test(property));
    if (!looks.length) continue;
    lookCounts.set(file, (lookCounts.get(file) ?? 0) + 1);
    lookSites.set(file, [
      ...(lookSites.get(file) ?? []),
      `${file}:${lineAt(text, (rule.index ?? 0) + (rule[0].length - rule[0].trimStart().length))}: "${selector.replace(/\s+/g, " ")}" sets ${looks.join(", ")}`,
    ]);
  }
}

function ratchet(
  kind: AllowSection,
  counts: Map<string, number>,
  describe: (file: string, count: number, allowed: number) => string[],
) {
  const entries = allowlist[kind];
  for (const [file, count] of counts) {
    const allowed = entries[file]?.count ?? 0;
    if (count > allowed) problems.push(...describe(file, count, allowed));
  }
  if (!values.record) {
    for (const [file, entry] of Object.entries(entries)) {
      const count = counts.get(file) ?? 0;
      if (count < entry.count)
        problems.push(
          `design/census/button-allowlist.json: ${kind} "${file}" allows ${entry.count} but ${count} remain; run pnpm -s buttons:check --record`,
        );
    }
    return;
  }
  allowlist[kind] = Object.fromEntries(
    Object.entries(entries)
      .map(([file, entry]): [string, AllowEntry] => [
        file,
        { ...entry, count: Math.min(entry.count, counts.get(file) ?? 0) },
      ])
      .filter(([, entry]) => entry.count > 0)
      .sort(([a], [b]) => a.localeCompare(b)),
  );
}

ratchet("rawButtons", rawCounts, (file, count, allowed) => [
  `${file}: ${count} raw <button>${count === 1 ? "" : "s"}, ${allowed} allowed; use Button, IconButton or ButtonBase from components/ui/Button (list them: the Census/Buttons "Button elements" page)`,
]);
ratchet("roleButtons", roleCounts, (file, count, allowed) => [
  `${file}: ${count} role="button" element${count === 1 ? "" : "s"}, ${allowed} allowed; use ButtonBase, which brings keyboard activation and focus`,
]);
ratchet("buttonLookRules", lookCounts, (file, count, allowed) => [
  ...(lookSites.get(file) ?? []),
  `${file}: ${count} rule${count === 1 ? "" : "s"} styling a button element, ${allowed} allowed; style the element through its own class, or ButtonBase`,
]);

if (values.record) {
  allowlist.bannedClasses = banned;
  await writeFile(allowlistPath, `${JSON.stringify(allowlist, null, 2)}\n`);
}
if (problems.length) {
  for (const problem of problems) console.error(problem);
  process.exit(1);
}
