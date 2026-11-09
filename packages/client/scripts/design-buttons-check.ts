/**
 * The button ban (plan 182, family 1, step 5). Rejects, in the client's
 * production sources:
 *
 * 1. a banned legacy button class in TS/TSX or a CSS Module: every class
 *    from design/census/mapping.ts that no global stylesheet styles, plus
 *    the classes recorded in the allowlist's `bannedClasses`, so restoring
 *    a deleted rule does not lift the ban;
 * 2. a raw `<button>` outside src/components/ui/Button.tsx and the shared
 *    selection, menu and tab controls, unless it sits in a composer file
 *    or its file is in the allowlist with
 *    at least that many. Option pickers, switches, menu items and listbox
 *    options are swept (families 2 and 3): their raw buttons count;
 * 3. an element with `role="button"` beyond the allowlist: a real button
 *    (ButtonBase) gets keyboard and focus behavior for free;
 * 4. a CSS rule, in a CSS Module or a global stylesheet, whose selector
 *    reaches a bare `button` element (`.panel button`, not `button.own`)
 *    and sets look or size properties (background, border, color, padding,
 *    font, radius, width, height, outline, shadow). Such a rule outranks
 *    ButtonBase's zero-specificity reset and ties with Button's variants,
 *    so a shared control under it loses its look, size or focus ring.
 *    Button.module.css and the composer's modules are exempt;
 * 5. a `role="switch"`, `role="radio"` or `role="radiogroup"` outside
 *    src/components/ui/Switch.tsx and SegmentedControl.tsx: on/off
 *    settings use Switch and one-of-many pickers SegmentedControl (family
 *    3). Their legacy classes (`toggle-switch`, `font-size-option`, …)
 *    are banned under 1 once their global rules are gone;
 * 6. a menu role (`menu`, `menuitem`, `menuitemradio`, `menuitemcheckbox`,
 *    `menubar`) outside src/components/ui/Menu.tsx, and a press or focus
 *    listener (`mousedown`, `pointerdown`, `touchstart`, `click`, `focusin`)
 *    on the document, its body or the window (hand-rolled outside
 *    dismissal) outside
 *    src/components/ui/Popover.tsx: menus use Menu and floating panels
 *    Popover (family 2). Menu buttons are swept, so their raw buttons count
 *    under 2;
 * 7. a raw `<input>` (a text field, checkbox or radio; not range, file,
 *    hidden or color), `<select>` or `<textarea>` outside the shared field
 *    controls (src/components/ui/Field.tsx, Checkbox.tsx, Switch.tsx), and
 *    a CSS rule, module or global, whose selector reaches a bare `input`,
 *    `select` or `textarea` element and sets look or size properties
 *    (`.form input { border: … }`): fields use Field, TextInput, Textarea,
 *    Select, Checkbox and Radio (family 4). Their legacy classes
 *    (`settings-input`, `settings-select`, …, LEGACY_FIELDS) are banned
 *    under 1 once their global rules are gone;
 * 8. a tab role (`tab`, `tablist`, `tabpanel`) outside
 *    src/components/ui/Tabs.tsx, and a rotating keyframe set (`@keyframes`
 *    whose frames `rotate`) outside src/components/ui/Spinner.module.css:
 *    tab strips use Tabs and busy indicators Spinner (family 5). Tab
 *    buttons are swept, so their raw buttons count under 2. The legacy
 *    banner, badge, spinner and tab classes (LEGACY_STATUS) are banned
 *    under 1 once their global rules are gone.
 *
 * The allowlist (design/census/button-allowlist.json) gives each entry a
 * count and a reason; a later family inherits the entries that name it.
 * A count may only fall: `--record` lowers counts to what the scan finds,
 * drops entries that reach zero and adds newly rule-less legacy classes to
 * `bannedClasses`; it never raises a count or adds a file. Counts are per
 * file, so a file may trade one allowed button for another.
 *
 * Family 3's classes come from LEGACY_SWITCHES in the same mapping file.
 *
 *   pnpm -s buttons:check            check
 *   pnpm -s buttons:check --record   lower the allowlist after a swap
 */
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { parseArgs } from "node:util";
import { scanButtonElements } from "../design/buttonElements";
import { scanFieldElements } from "../design/fieldElements";
import {
  COMPOSER_FILE,
  type RawButtonFamily,
  rawButtonFamily,
} from "../design/buttonFamilies";
import {
  LEGACY_BUTTONS,
  LEGACY_FIELDS,
  LEGACY_STATUS,
  LEGACY_SWITCHES,
} from "../design/census/mapping";
import { collectDesignData } from "../design/vite-plugin-design-data";
import { clientRoot } from "./design-index";

const help = `Usage: pnpm -s buttons:check [--record]

Reject banned legacy button, switch and option classes, raw <button>s
outside src/components/ui/Button.tsx and the later families, role="button"
elements, CSS rules that style a bare button element's look, and switch or
radio roles outside the shared Switch and SegmentedControl. Exceptions
live in packages/client/design/census/button-allowlist.json with a count
and a reason; --record lowers those counts to the current scan. Also
reject menu roles outside the shared Menu and document or window pointer
listeners (hand-rolled outside-press dismissal) outside the shared Popover,
raw fields outside the shared field controls, tab roles outside the shared
Tabs and rotating keyframes outside the shared Spinner.`;

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
type AllowSection =
  | "rawButtons"
  | "roleButtons"
  | "buttonLookRules"
  | "selectionRoles"
  | "menuRoles"
  | "outsidePressListeners"
  | "rawFields"
  | "fieldLookRules"
  | "tabRoles"
  | "spinKeyframes";
interface Allowlist extends Record<AllowSection, Record<string, AllowEntry>> {
  bannedClasses: string[];
}

const GLOBAL_STYLESHEETS = [
  "styles/index.css",
  "styles/renderers.css",
  "styles/tool-rows.css",
];

const LOOK_PROPERTY =
  /^(?:background(?:-color|-image)?|border(?:-[a-z-]+)?|color|padding(?:-[a-z-]+)?|font(?:-[a-z-]+)?|(?:min-|max-)?(?:height|width)|outline(?:-[a-z-]+)?|box-shadow|appearance)$/;
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
    ...[
      ...LEGACY_BUTTONS.flatMap((row) => row.classes.split(/\s+/)),
      ...LEGACY_SWITCHES.flatMap((row) => row.classes?.split(/\s+/) ?? []),
      ...LEGACY_FIELDS.flatMap((row) => row.classes?.split(/\s+/) ?? []),
      ...LEGACY_STATUS.flatMap((row) => row.classes?.split(/\s+/) ?? []),
    ].filter((name) => !declared[name]),
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
        `${srcPath(path)}:${lineAt(text, index)}: legacy class "${match[0]}" is banned; use the shared control (components/ui: Button, Switch, SegmentedControl, TextInput, Select, Textarea, Checkbox, Banner, Badge, Spinner, Tabs)`,
      );
    }
  }
}

// 2 and 3. Raw buttons and role="button" elements. The shared selection
// controls draw their own buttons.
const SELECTION_CONTROLS = new Set([
  "components/ui/Switch.tsx",
  "components/ui/SegmentedControl.tsx",
  "components/ui/Menu.tsx",
  "components/ui/Tabs.tsx",
]);
const UNSWEPT_FAMILIES = new Set<RawButtonFamily>(["composer"]);
const rawCounts = new Map<string, number>();
const roleCounts = new Map<string, number>();
for (const row of await scanButtonElements(srcDir)) {
  if (row.kind === "role-button") {
    roleCounts.set(row.file, (roleCounts.get(row.file) ?? 0) + 1);
    continue;
  }
  if (
    row.kind !== "raw" ||
    row.file === "components/ui/Button.tsx" ||
    SELECTION_CONTROLS.has(row.file)
  )
    continue;
  const family = rawButtonFamily(row);
  if (family && UNSWEPT_FAMILIES.has(family)) continue;
  if (COMPOSER_FILE.test(row.file)) continue;
  rawCounts.set(row.file, (rawCounts.get(row.file) ?? 0) + 1);
}

// 4 and 7. CSS rules that style a bare button, or a bare field element.
/**
 * A bare `input`, `select` or `textarea` type selector. A range, file or
 * color input (`input[type="range"]`) and the range's pseudo-elements are
 * not fields.
 */
const FIELD_ELEMENT = /^(?:input|select|textarea)(?![\w-])/;
/**
 * The compounds a selector styles: its last compound, with :has() and
 * :not() dropped (they filter, they do not change the subject) and each
 * alternative of an :is()/:where() subject expanded.
 */
function subjectsOf(selector: string): string[] {
  let flat = selector;
  for (let previous = ""; previous !== flat; ) {
    previous = flat;
    flat = flat.replace(/:(?:has|not)\([^()]*\)/g, "");
  }
  // The last compound: split on combinators outside parentheses.
  let depth = 0;
  let start = 0;
  const trimmed = flat.trim();
  for (let index = 0; index < trimmed.length; index++) {
    const character = trimmed[index] ?? "";
    if (character === "(" || character === "[") depth++;
    else if (character === ")" || character === "]") depth--;
    else if (depth === 0 && /[\s>+~]/.test(character)) start = index + 1;
  }
  const subject = trimmed.slice(start);
  const nested = /:(?:is|where)\(([^()]*)\)/.exec(subject);
  if (!nested) return [subject];
  const rest = subject.replace(nested[0], "");
  return (nested[1] ?? "").split(",").map((part) => part.trim() + rest);
}

/** A selector list's members, split on commas outside parentheses. */
function splitSelectorList(selector: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const character of selector) {
    if (character === "(" || character === "[") depth++;
    else if (character === ")" || character === "]") depth--;
    if (character === "," && depth === 0) {
      parts.push(current);
      current = "";
    } else current += character;
  }
  return [...parts, current];
}
const NOT_FIELD_SELECTOR =
  /\[type=["']?(?:range|file|color|hidden)["']?\]|::-(?:webkit-slider|moz-range|webkit-file|webkit-color)/;
const FIELD_CONTROL_STYLES = new Set([
  "components/ui/Field.module.css",
  "components/ui/Checkbox.module.css",
  "components/ui/Switch.module.css",
]);
const lookCounts = new Map<string, number>();
const lookSites = new Map<string, string[]>();
const fieldLookCounts = new Map<string, number>();
const fieldLookSites = new Map<string, string[]>();
const stylesheets = [
  ...GLOBAL_STYLESHEETS.map((file) => join(srcDir, file)),
  ...sources.filter((file) => file.endsWith(".module.css")),
];
function tally(
  counts: Map<string, number>,
  sites: Map<string, string[]>,
  file: string,
  site: string,
) {
  counts.set(file, (counts.get(file) ?? 0) + 1);
  sites.set(file, [...(sites.get(file) ?? []), site]);
}
for (const path of stylesheets) {
  const file = srcPath(path);
  if (COMPOSER_FILE.test(file.replace(/\.module\.css$/, ".tsx"))) continue;
  // Comments and statement at-rules (`@import …;`, `@layer a, b;`) are
  // blanked, keeping line numbers, so the next rule's selector is clean.
  const text = (await readFile(path, "utf8"))
    .replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, " "))
    .replace(/@[a-z-]+[^{};]*;/g, (c) => c.replace(/[^\n]/g, " "));
  for (const rule of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = (rule[1] ?? "").trim();
    if (selector.startsWith("@")) continue;
    // `:not(button)` excludes buttons rather than reaching them.
    const reaching = selector.replace(/:not\([^()]*\)/g, "");
    const looks = (rule[2] ?? "")
      .split(";")
      .map((declaration) => declaration.split(":")[0]?.trim() ?? "")
      .filter((property) => LOOK_PROPERTY.test(property));
    if (!looks.length) continue;
    const site = `${file}:${lineAt(text, (rule.index ?? 0) + (rule[0].length - rule[0].trimStart().length))}: "${selector.replace(/\s+/g, " ")}" sets ${looks.join(", ")}`;
    if (
      file !== "components/ui/Button.module.css" &&
      BUTTON_ELEMENT.test(reaching)
    )
      tally(lookCounts, lookSites, file, site);
    if (
      !FIELD_CONTROL_STYLES.has(file) &&
      splitSelectorList(selector).some((part) =>
        subjectsOf(part).some(
          (subject) =>
            FIELD_ELEMENT.test(subject) && !NOT_FIELD_SELECTOR.test(subject),
        ),
      )
    )
      tally(fieldLookCounts, fieldLookSites, file, site);
  }
}

// 5. Switch and radio roles outside the shared controls.
// An attribute (`role="radio"`, `role={on ? "radio" : …}`) or an object
// prop (`role: "switch"`), not a `[role="radio"]` inside a selector string.
const SELECTION_ROLE =
  /(?<![\w[-])role(?:=(?:\{[^}\n]*?)?|:\s*)["'`](?:switch|radio|radiogroup)["'`]/g;
const selectionCounts = new Map<string, number>();
const selectionSites = new Map<string, string[]>();
for (const path of sources) {
  const file = srcPath(path);
  if (!/\.tsx?$/.test(file) || SELECTION_CONTROLS.has(file)) continue;
  const text = await readFile(path, "utf8");
  for (const match of text.matchAll(SELECTION_ROLE)) {
    selectionCounts.set(file, (selectionCounts.get(file) ?? 0) + 1);
    selectionSites.set(file, [
      ...(selectionSites.get(file) ?? []),
      `${file}:${lineAt(text, match.index ?? 0)}: ${match[0]}`,
    ]);
  }
}

// 6. Menu roles outside the shared Menu, and document or window pointer
// listeners (outside-press dismissal) outside the shared Popover.
// `role="menu"` or `role={x ? "menu" : …}`, not a later attribute's value.
const MENU_ROLE =
  /(?<![\w[-])role(?:=(?:\{[^}\n]*?)?|:\s*)["'`](?:menu|menubar|menuitem|menuitemradio|menuitemcheckbox)["'`]/g;
// A listener on the document, its body or the window (also through an
// ownerDocument or a `doc`/`*Document` variable) for a press or a focus
// move: the shapes a hand-rolled outside dismissal takes.
const OUTSIDE_PRESS =
  /\b(?:document(?:\.body)?|window|globalThis|\w*[dD]ocument|doc)\??\.addEventListener\(\s*["'`](?:mousedown|pointerdown|touchstart|click|focusin)["'`]/g;
function countMatches(
  pattern: RegExp,
  exempt: ReadonlySet<string>,
): Promise<[Map<string, number>, Map<string, string[]>]> {
  return (async () => {
    const counts = new Map<string, number>();
    const sites = new Map<string, string[]>();
    for (const path of sources) {
      const file = srcPath(path);
      if (!/\.tsx?$/.test(file) || exempt.has(file)) continue;
      if (COMPOSER_FILE.test(file)) continue;
      const text = await readFile(path, "utf8");
      for (const match of text.matchAll(pattern)) {
        counts.set(file, (counts.get(file) ?? 0) + 1);
        sites.set(file, [
          ...(sites.get(file) ?? []),
          `${file}:${lineAt(text, match.index ?? 0)}: ${match[0]}`,
        ]);
      }
    }
    return [counts, sites];
  })();
}
const [menuCounts, menuSites] = await countMatches(
  MENU_ROLE,
  new Set(["components/ui/Menu.tsx"]),
);
// Popover owns outside dismissal; Menu tracks whether the latest input
// was a key, to decide where focus goes when a menu opens.
const [pressCounts, pressSites] = await countMatches(
  OUTSIDE_PRESS,
  new Set(["components/ui/Popover.tsx", "components/ui/Menu.tsx"]),
);

// 7. Raw fields outside the shared field controls.
const FIELD_CONTROLS = new Set([
  "components/ui/Field.tsx",
  "components/ui/Checkbox.tsx",
  "components/ui/Switch.tsx",
]);
const fieldCounts = new Map<string, number>();
for (const row of await scanFieldElements(srcDir)) {
  if (!row.field || FIELD_CONTROLS.has(row.file)) continue;
  if (COMPOSER_FILE.test(row.file)) continue;
  fieldCounts.set(row.file, (fieldCounts.get(row.file) ?? 0) + 1);
}

// 8. Tab roles outside the shared Tabs, and rotating keyframes outside the
// shared Spinner.
const TAB_ROLE =
  /(?<![\w[-])role(?:=(?:\{[^}\n]*?)?|:\s*)["'`](?:tab|tablist|tabpanel)["'`]/g;
const [tabCounts, tabSites] = await countMatches(
  TAB_ROLE,
  new Set(["components/ui/Tabs.tsx"]),
);
const spinCounts = new Map<string, number>();
const spinSites = new Map<string, string[]>();
for (const path of stylesheets) {
  const file = srcPath(path);
  if (file === "components/ui/Spinner.module.css") continue;
  if (COMPOSER_FILE.test(file.replace(/\.module\.css$/, ".tsx"))) continue;
  const text = (await readFile(path, "utf8")).replace(
    /\/\*[\s\S]*?\*\//g,
    (c) => c.replace(/[^\n]/g, " "),
  );
  for (const frames of text.matchAll(
    /@keyframes\s+([\w-]+)\s*\{((?:[^{}]*\{[^{}]*\})*[^{}]*)\}/g,
  )) {
    if (!/\brotate(?:Z)?\(|\brotate\s*:/.test(frames[2] ?? "")) continue;
    tally(
      spinCounts,
      spinSites,
      file,
      `${file}:${lineAt(text, frames.index ?? 0)}: @keyframes ${frames[1]}`,
    );
  }
}

function ratchet(
  kind: AllowSection,
  counts: Map<string, number>,
  describe: (file: string, count: number, allowed: number) => string[],
) {
  allowlist[kind] ??= {};
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

ratchet("selectionRoles", selectionCounts, (file, count, allowed) => [
  ...(selectionSites.get(file) ?? []),
  `${file}: ${count} switch or radio role${count === 1 ? "" : "s"}, ${allowed} allowed; use Switch or SegmentedControl from components/ui`,
]);

ratchet("menuRoles", menuCounts, (file, count, allowed) => [
  ...(menuSites.get(file) ?? []),
  `${file}: ${count} menu role${count === 1 ? "" : "s"}, ${allowed} allowed; use Menu and MenuItem from components/ui/Menu`,
]);
ratchet("outsidePressListeners", pressCounts, (file, count, allowed) => [
  ...(pressSites.get(file) ?? []),
  `${file}: ${count} document or window pointer listener${count === 1 ? "" : "s"}, ${allowed} allowed; a floating surface dismissed by an outside press is a Popover (components/ui/Popover)`,
]);

ratchet("rawFields", fieldCounts, (file, count, allowed) => [
  `${file}: ${count} raw <input>, <select> or <textarea>${count === 1 ? "" : "s"}, ${allowed} allowed; use TextInput, Textarea, Select, Checkbox or Radio from components/ui (Field for a label, hint and error)`,
]);
ratchet("fieldLookRules", fieldLookCounts, (file, count, allowed) => [
  ...(fieldLookSites.get(file) ?? []),
  `${file}: ${count} rule${count === 1 ? "" : "s"} styling an input, select or textarea element, ${allowed} allowed; the shared field controls own their look, so style layout through a class passed as className`,
]);

ratchet("tabRoles", tabCounts, (file, count, allowed) => [
  ...(tabSites.get(file) ?? []),
  `${file}: ${count} tab role${count === 1 ? "" : "s"}, ${allowed} allowed; use Tabs and TabPanel from components/ui/Tabs`,
]);
ratchet("spinKeyframes", spinCounts, (file, count, allowed) => [
  ...(spinSites.get(file) ?? []),
  `${file}: ${count} rotating keyframe set${count === 1 ? "" : "s"}, ${allowed} allowed; a busy indicator is Spinner from components/ui/Spinner (or Button's busy)`,
]);

if (values.record) {
  allowlist.bannedClasses = banned;
  await writeFile(allowlistPath, `${JSON.stringify(allowlist, null, 2)}\n`);
}
if (problems.length) {
  for (const problem of problems) console.error(problem);
  process.exit(1);
}
