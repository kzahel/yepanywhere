/** Dev/build-only data for the remaining composer and runtime exceptions. */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import postcss from "postcss";
import selectorParser from "postcss-selector-parser";
import families from "../../../scripts/css-runtime-families.json";
import { scanButtonElements } from "./buttonElements";
import { COMPOSER_FILE } from "./composerFiles";
import allowlist from "./census/button-allowlist.json";
import controlDebt from "./census/control-override-allowlist.json";
import tokenDebt from "./census/token-literal-allowlist.json";
import { scanFieldElements } from "./fieldElements";

export interface CensusEntry {
  element: string;
  where: string;
  reason: string;
  close: string;
}

const composerReason =
  "Composer controls are excluded until plan 182's composer pass.";
const composerClose =
  "Review in plan 182's composer pass, adopt shared controls, then delete the old rules and add retired classes to bannedClasses.";

/** Selector identity is parser-decoded; module :global references are not local classes. */
function cssClasses(text: string, file: string, module = false) {
  const classes = new Map<
    string,
    { name: string; cssFile: string; line: number }
  >();
  postcss.parse(text, { from: file }).walkRules((rule) => {
    selectorParser((selectors) =>
      selectors.walkClasses((node) => {
        if (module) {
          for (let parent = node.parent; parent; parent = parent.parent) {
            if (parent.type === "pseudo" && parent.value === ":global") return;
          }
        }
        if (!classes.has(node.value))
          classes.set(node.value, {
            name: node.value,
            cssFile: file,
            line: rule.source?.start?.line ?? 1,
          });
      }),
    ).processSync(rule.selector);
  });
  return [...classes.values()];
}

export async function collectOpenCensus(srcDir: string) {
  const globals = (
    await Promise.all(
      ["tokens", "generated", "renderers", "tool-rows", "base", "index"].map(
        async (name) => {
          const file = `styles/${name}.css`;
          return cssClasses(await readFile(join(srcDir, file), "utf8"), file);
        },
      ),
    )
  ).flat();
  const names = [...new Set(globals.map((row) => row.name))];
  const composer: CensusEntry[] = [];
  const [buttons, fields] = await Promise.all([
    scanButtonElements(srcDir),
    scanFieldElements(srcDir),
  ]);
  const composerAllowance = (
    section: Record<string, { reason: string }>,
    file: string,
  ) => /composer/i.test(section[file]?.reason ?? "");
  for (const row of buttons) {
    if (
      row.kind !== "raw" ||
      !(
        COMPOSER_FILE.test(row.file) ||
        composerAllowance(allowlist.rawButtons, row.file)
      )
    )
      continue;
    composer.push({
      element: `<${row.tag}${row.role ? ` role="${row.role}"` : ""}>${row.className ? ` · ${row.className}` : ""}`,
      where: `${row.file}:${row.line}`,
      reason: composerReason,
      close: composerClose,
    });
  }
  for (const row of fields) {
    if (
      !row.field ||
      !(
        COMPOSER_FILE.test(row.file) ||
        composerAllowance(allowlist.rawFields, row.file)
      )
    )
      continue;
    composer.push({
      element: `<${row.tag}${row.type ? ` type="${row.type}"` : ""}>`,
      where: `${row.file}:${row.line}`,
      reason: composerReason,
      close: composerClose,
    });
  }
  for (const [file, entry] of Object.entries(tokenDebt)) {
    if (!COMPOSER_FILE.test(file) && !/plan 182/i.test(entry.reason)) continue;
    composer.push({
      element: `${entry.count} type/radius exceptions`,
      where: file,
      reason: entry.reason,
      close:
        "Adopt matching tokens or approved control geometry during plan 182's composer control pass.",
    });
  }
  for (const section of Object.values(controlDebt)) {
    if (typeof section !== "object" || !section) continue;
    for (const [file, entry] of Object.entries(section)) {
      if (
        !entry ||
        typeof entry !== "object" ||
        !("reason" in entry) ||
        !/composer|plan 182/i.test(String(entry.reason))
      )
        continue;
      composer.push({
        element: `${"count" in entry ? entry.count : ""} control overrides`,
        where: file,
        reason: String(entry.reason),
        close:
          "Replace composer controls with the shared family in plan 182's composer pass.",
      });
    }
  }
  const runtime = families.map((family) => ({
    element: family.pattern,
    where: `${family.source} · ${names.filter((name) => new RegExp(family.pattern, "u").test(name)).length} / ${names.length} global classes`,
    reason: family.reason,
    close:
      "generated" in family && family.generated === true
        ? "Keep the documented generated-markup boundary; remove this family only when the emitter and its global rules disappear."
        : "Move the authored owner and its runtime states into a CSS Module during plan 191's ownership pass; remove the family when no global matches remain.",
  }));
  return { composer, runtime, globalClasses: names.length };
}
