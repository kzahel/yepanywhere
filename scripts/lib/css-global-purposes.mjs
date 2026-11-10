import postcss from "postcss";
import selectorParser from "postcss-selector-parser";

export const permittedGlobalStyles = {
  "packages/client/src/styles/tokens.css": "tokens",
  "packages/client/src/styles/base.css": "base",
  "packages/client/src/styles/generated.css": "generated",
};

/** Purpose findings are counted individually; wrapper interop is reviewed debt. */
export function globalPurposeFindings(text, purpose, families = []) {
  const findings = [];
  const generated = families
    .filter((family) => family.generated === true)
    .map((family) => ({
      pattern: new RegExp(family.pattern),
      reactAuthored: family.reactAuthored ?? [],
    }));
  const add = (key, node) =>
    findings.push({ key: `${purpose}:${key}`, line: node.source?.start.line });
  const root = postcss.parse(text);
  root.walkAtRules((rule) => {
    const allowed =
      purpose === "tokens"
        ? ["media", "supports", "font-face", "property"]
        : ["media", "supports"];
    if (!allowed.includes(rule.name)) add(`at-rule:${rule.name}`, rule);
  });
  root.walkDecls((decl) => {
    if (
      purpose === "tokens" &&
      !decl.prop.startsWith("--") &&
      !["font-face", "property"].includes(decl.parent.name)
    ) {
      add(`declaration:${decl.prop}`, decl);
    }
  });
  root.walkRules((rule) => {
    selectorParser((selectors) => {
      selectors.each((selector) => {
        const classes = [];
        selector.walkClasses((node) => classes.push(node));
        if (purpose === "tokens") {
          // Theme/root selectors are global; component-local variables stay owned.
          selector.walk((node) => {
            if (
              node.type !== "selector" &&
              node.type !== "comment" &&
              !(node.type === "pseudo" && node.value === ":root") &&
              !(node.type === "attribute" && node.attribute === "data-theme")
            ) {
              add(`selector:${node.type}`, rule);
            }
          });
        } else if (purpose === "base") {
          if (
            classes.length &&
            !selector.nodes.some(
              (node) =>
                node.type === "class" &&
                [
                  "source-pane-resizing",
                  "session-transcript-selection-active",
                ].includes(node.value),
            )
          )
            add("authored-subject", rule);
          for (const node of classes) add(`class:${node.value}`, rule);
        } else {
          const subject = selector.nodes.slice(
            selector.nodes.findLastIndex((node) => node.type === "combinator") +
              1,
          );
          const generatedClass = (name) =>
            generated.some(({ pattern }) => pattern.test(name));
          const pureGeneratedClass = (name) =>
            generated.some(
              ({ pattern, reactAuthored }) =>
                pattern.test(name) && !reactAuthored.includes(name),
            );
          const emittedSubject =
            subject.some(
              (node) => node.type === "class" && pureGeneratedClass(node.value),
            ) ||
            (subject.some(
              (node) => node.type === "class" && generatedClass(node.value),
            ) &&
              selector.nodes.some(
                (node) =>
                  node.type === "class" && pureGeneratedClass(node.value),
              ));
          // A React shell is only an anchor, never the styled subject. Tags
          // beneath a shell describe emitted markdown/HTML, not the shell.
          if (
            !classes.length ||
            (!emittedSubject && !subject.some((node) => node.type === "tag"))
          ) {
            add("authored-subject", rule);
          }
          for (const node of classes) {
            if (!generatedClass(node.value)) add(`context:${node.value}`, rule);
          }
        }
      });
    }).processSync(rule.selector);
  });
  return findings;
}

/** Validate first, then return a lower-only record; never partially accept growth. */
export function ratchetPurposeExceptions(findings, recorded) {
  const counts = {};
  for (const { key } of findings) counts[key] = (counts[key] ?? 0) + 1;
  const errors = [];
  for (const [key, entry] of Object.entries(recorded)) {
    if (
      !Number.isInteger(entry.count) ||
      entry.count < 1 ||
      typeof entry.reason !== "string" ||
      !entry.reason.trim()
    ) {
      errors.push(
        `${key}: purpose exception needs a positive count and reason`,
      );
    }
  }
  for (const [key, count] of Object.entries(counts)) {
    if (count > (recorded[key]?.count ?? 0)) {
      errors.push(
        `${key}: ${count} purpose findings exceed ${recorded[key]?.count ?? 0}`,
      );
    }
  }
  const lowered = Object.fromEntries(
    Object.entries(recorded)
      .filter(([key]) => counts[key])
      .map(([key, entry]) => [key, { ...entry, count: counts[key] }]),
  );
  const stale = Object.entries(recorded)
    .filter(([key, entry]) => (counts[key] ?? 0) < entry.count)
    .map(([key]) => key);
  return { errors, lowered: errors.length ? recorded : lowered, stale };
}
