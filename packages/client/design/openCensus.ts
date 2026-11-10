/** Dev/build-only data for the remaining composer and runtime exceptions. */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import postcss from "postcss";
import selectorParser from "postcss-selector-parser";
import families from "../../../scripts/css-runtime-families.json";
import { scanButtonElements } from "./buttonElements";
import { COMPOSER_FILE } from "./composerFiles";
import allowlist from "./census/button-allowlist.json";
import classes from "./census/composer-classes.json";
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
  for (const name of classes.globals) {
    const sites = globals.filter((row) => row.name === name);
    if (sites.length)
      composer.push({
        element: `.${name}`,
        where: sites.map((row) => `${row.cssFile}:${row.line}`).join(", "),
        reason: composerReason,
        close: composerClose,
      });
  }
  for (const { file, name } of classes.modules) {
    const selectors = cssClasses(
      await readFile(join(srcDir, file), "utf8"),
      file,
      true,
    );
    const row = selectors.find((row) => row.name === name);
    if (row)
      composer.push({
        element: `.${name}`,
        where: `${file}:${row.line}`,
        reason: composerReason,
        close: composerClose,
      });
  }
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
