/**
 * Static inventory of CSS custom properties: which names some source defines,
 * and where each name is read through `var()`.
 *
 * Shared by `scripts/check-css-architecture.mjs` (the undefined-property
 * ratchet) and the design playground's token page, so both report the same
 * names. It is a text scan, not a cascade model: a name counts as defined when
 * any scanned source declares it, wherever that declaration applies.
 *
 * Definitions are CSS declarations (`--name:`), `@property --name`, and the
 * TypeScript forms that set one at runtime: `"--name":` in a style object,
 * `["--name" as …]`, `setProperty("--name", …)` and `--name:` inside a string.
 */

/** @typedef {{ path: string, text: string }} SourceText */
/** @typedef {{ path: string, line: number, fallback: boolean }} CustomPropertySite */
/**
 * @typedef {{
 *   defined: Set<string>,
 *   uses: Map<string, CustomPropertySite[]>,
 * }} CustomPropertyScan
 */

const NAME = "--[A-Za-z0-9_-]+";
const CSS_DEFINITION = new RegExp(String.raw`(?<![\w-])(${NAME})\s*:`, "g");
const AT_PROPERTY = new RegExp(String.raw`@property\s+(${NAME})`, "g");
const SCRIPT_DEFINITION = new RegExp(
  String.raw`["'\x60](${NAME})["'\x60]\s*(?:as\s+[\w.<>"' |]+?)?\s*[:\]]|setProperty\(\s*["'\x60](${NAME})`,
  "g",
);
const USE = new RegExp(String.raw`var\(\s*(${NAME})\s*(,)?`, "g");

/** Blank out comments while keeping offsets, so line numbers stay true. */
function blankComments(text, script) {
  const blank = (match) => match.replace(/[^\n]/g, " ");
  const withoutBlocks = text.replace(/\/\*[\s\S]*?\*\//g, blank);
  return script
    ? withoutBlocks.replace(/^[ \t]*\/\/.*$/gm, blank)
    : withoutBlocks;
}

function lineStarts(text) {
  const starts = [0];
  for (let index = text.indexOf("\n"); index !== -1; ) {
    starts.push(index + 1);
    index = text.indexOf("\n", index + 1);
  }
  return starts;
}

function lineAt(starts, offset) {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (starts[middle] <= offset) low = middle;
    else high = middle - 1;
  }
  return low + 1;
}

/**
 * @param {readonly SourceText[]} sources
 * @returns {CustomPropertyScan}
 */
export function scanCustomProperties(sources) {
  const defined = new Set();
  /** @type {Map<string, CustomPropertySite[]>} */
  const uses = new Map();
  for (const source of sources) {
    const script = !source.path.endsWith(".css");
    const text = blankComments(source.text, script);
    for (const match of text.matchAll(CSS_DEFINITION)) defined.add(match[1]);
    for (const match of text.matchAll(AT_PROPERTY)) defined.add(match[1]);
    if (script) {
      for (const match of text.matchAll(SCRIPT_DEFINITION))
        defined.add(match[1] ?? match[2]);
    }
    const starts = lineStarts(text);
    for (const match of text.matchAll(USE)) {
      const sites = uses.get(match[1]) ?? [];
      sites.push({
        path: source.path,
        line: lineAt(starts, match.index ?? 0),
        fallback: match[2] === ",",
      });
      uses.set(match[1], sites);
    }
  }
  return { defined, uses };
}

/**
 * Names read through `var()` that no scanned source defines, most-used first.
 *
 * @param {CustomPropertyScan} scan
 */
export function undefinedCustomProperties(scan) {
  return [...scan.uses]
    .filter(([name]) => !scan.defined.has(name))
    .map(([name, sites]) => ({
      name,
      uses: sites.length,
      withoutFallback: sites.filter((site) => !site.fallback).length,
      sites,
    }))
    .sort((a, b) => b.uses - a.uses || a.name.localeCompare(b.name));
}
