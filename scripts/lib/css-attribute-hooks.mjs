import ts from "typescript";
import postcss from "postcss";
import selectorParser from "postcss-selector-parser";

const booleanAria =
  /^aria-(atomic|busy|disabled|expanded|hidden|modal|multiline|multiselectable|readonly|required|selected)$/;
const standardAriaValues = {
  "aria-checked": ["true", "false", "mixed"],
  "aria-pressed": ["true", "false", "mixed"],
  "aria-current": ["true", "false", "page", "step", "location", "date", "time"],
  "aria-live": ["polite", "assertive", "off"],
  "aria-haspopup": [
    "true",
    "false",
    "menu",
    "listbox",
    "tree",
    "grid",
    "dialog",
  ],
  "aria-autocomplete": ["none", "inline", "list", "both"],
  "aria-orientation": ["horizontal", "vertical"],
  "aria-invalid": ["true", "false", "grammar", "spelling"],
  "aria-sort": ["ascending", "descending", "none", "other"],
};
function standardAriaValue(name, value) {
  return booleanAria.test(name)
    ? ["true", "false"].includes(value)
    : standardAriaValues[name]?.includes(value);
}
const datasetName = (name) =>
  `data-${name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`;

/** Emission evidence is syntax, never a selector or an incidental source token. */
export function emittedAttributes(sources) {
  const emitted = new Map();
  const add = (name, values, file) => {
    if (!/^(data|aria)-/.test(name)) return;
    const entry = emitted.get(name) ?? {
      values: new Set(),
      dynamic: false,
      files: new Set(),
    };
    if (values === null) entry.dynamic = true;
    else for (const value of values) entry.values.add(value);
    entry.files.add(file);
    emitted.set(name, entry);
  };
  for (const [file, text] of sources) {
    const source = ts.createSourceFile(
      file,
      text,
      ts.ScriptTarget.Latest,
      true,
      file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const constants = new Map();
    function index(node) {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer
      )
        constants.set(node.name.text, node.initializer);
      ts.forEachChild(node, index);
    }
    index(source);
    function values(node, seen = new Set()) {
      if (!node) return [""];
      if (seen.has(node)) return null;
      seen = new Set(seen).add(node);
      if (ts.isJsxExpression(node)) return values(node.expression, seen);
      if (ts.isStringLiteralLike(node) || ts.isNumericLiteral(node))
        return [node.text];
      if (node.kind === ts.SyntaxKind.TrueKeyword) return ["true"];
      if (node.kind === ts.SyntaxKind.FalseKeyword) return ["false"];
      if (
        node.kind === ts.SyntaxKind.NullKeyword ||
        (ts.isIdentifier(node) && node.text === "undefined")
      )
        return [];
      if (ts.isIdentifier(node) && constants.has(node.text))
        return values(constants.get(node.text), seen);
      if (ts.isConditionalExpression(node)) {
        const a = values(node.whenTrue, seen),
          b = values(node.whenFalse, seen);
        return a && b ? [...a, ...b] : null;
      }
      if (
        ts.isAsExpression(node) ||
        ts.isParenthesizedExpression(node) ||
        ts.isNonNullExpression(node)
      )
        return values(node.expression, seen);
      return null;
    }
    function visit(node) {
      if (ts.isJsxAttribute(node))
        add(
          node.name.getText(source),
          node.initializer ? values(node.initializer) : ["true"],
          file,
        );
      if (ts.isPropertyAssignment(node)) {
        const name = node.name;
        if (ts.isStringLiteralLike(name))
          add(name.text, values(node.initializer), file);
      }
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isPropertyAccessExpression(node.left)
      ) {
        const target = node.left;
        if (
          ts.isPropertyAccessExpression(target.expression) &&
          target.expression.name.text === "dataset"
        )
          add(datasetName(target.name.text), values(node.right), file);
      }
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isElementAccessExpression(node.left)
      ) {
        const target = node.left;
        if (
          ts.isPropertyAccessExpression(target.expression) &&
          target.expression.name.text === "dataset"
        )
          for (const name of values(target.argumentExpression) ?? [])
            add(datasetName(name), values(node.right), file);
      }
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        ["setAttribute", "toggleAttribute"].includes(node.expression.name.text)
      ) {
        for (const name of values(node.arguments[0]) ?? [])
          add(
            name,
            node.expression.name.text === "toggleAttribute"
              ? [""]
              : values(node.arguments[1]),
            file,
          );
      }
      if (ts.isStringLiteralLike(node) || ts.isTemplateExpression(node)) {
        const text = ts.isTemplateExpression(node)
          ? node.head.text +
            node.templateSpans
              .map((span) => `__DYNAMIC__${span.literal.text}`)
              .join("")
          : node.text;
        if (text.includes("<") || /^\s+(data|aria)-/.test(text)) {
          for (const match of text.matchAll(
            /(?:^|\s)((?:data|aria)-[\w-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)')|(?=\s|\/?>))/g,
          )) {
            const value = match[2] ?? match[3] ?? "";
            add(match[1], value.includes("__DYNAMIC__") ? null : [value], file);
          }
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  return emitted;
}

export function attributeHookFindings(styles, emitted, families = []) {
  const findings = [];
  for (const [file, text] of styles) {
    postcss.parse(text, { from: file }).walkRules((rule) => {
      selectorParser((selectors) =>
        selectors.walkAttributes((node) => {
          const name = node.attribute;
          if (
            !name.startsWith("data-") &&
            !(
              name.startsWith("aria-") &&
              node.value &&
              !standardAriaValue(name, node.value)
            )
          )
            return;
          const entry = emitted.get(name);
          const accepts = (value) =>
            !node.operator ||
            (node.operator === "="
              ? value === node.value
              : node.operator === "~="
                ? value.split(/\s+/).includes(node.value)
                : node.operator === "^="
                  ? value.startsWith(node.value)
                  : node.operator === "$="
                    ? value.endsWith(node.value)
                    : node.operator === "*="
                      ? value.includes(node.value)
                      : value === node.value ||
                        value.startsWith(`${node.value}-`));
          if (entry && (entry.dynamic || [...entry.values].some(accepts)))
            return;
          if (
            families.some(
              (family) =>
                new RegExp(family.attribute).test(name) &&
                (!node.value || new RegExp(family.value).test(node.value)),
            )
          )
            return;
          findings.push({
            file,
            line: rule.source.start.line,
            name,
            value: node.value,
            key: `${file}:${name}${node.operator ? `${node.operator}${node.value}` : ""}`,
          });
        }),
      ).processSync(rule.selector);
    });
  }
  return findings;
}

export function ratchetAttributeHooks(findings, recorded) {
  const counts = {};
  for (const { key } of findings) counts[key] = (counts[key] ?? 0) + 1;
  const errors = [];
  for (const [key, entry] of Object.entries(recorded))
    if (
      !Number.isInteger(entry.count) ||
      entry.count < 1 ||
      !entry.reason?.trim()
    )
      errors.push(`${key}: needs a positive count and reason`);
  for (const [key, count] of Object.entries(counts))
    if (count > (recorded[key]?.count ?? 0))
      errors.push(
        `${key}: ${count} unemitted selectors exceeds ${recorded[key]?.count ?? 0}`,
      );
  const stale = Object.keys(recorded).filter(
    (key) => (counts[key] ?? 0) < recorded[key].count,
  );
  return {
    errors,
    stale,
    next: errors.length
      ? recorded
      : Object.fromEntries(
          Object.entries(recorded)
            .filter(([key]) => counts[key])
            .map(([key, entry]) => [key, { ...entry, count: counts[key] }]),
        ),
  };
}
