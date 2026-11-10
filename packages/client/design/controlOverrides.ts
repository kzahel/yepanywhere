/** Parser-backed caller-class ownership scan. This is dev tooling, never app code. */
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import postcss, {
  type AtRule,
  type Document,
  type Root,
  type Rule,
} from "postcss";
import selectorParser from "postcss-selector-parser";
import ts from "typescript";

const CONTROLS = new Set([
  "SelectableCard",
  "Button",
  "IconButton",
  "buttonClassName",
  "Switch",
  "SegmentedControl",
  "Field",
  "TextInput",
  "Textarea",
  "Select",
  "Checkbox",
  "Radio",
  "Badge",
  "Banner",
  "Tabs",
  "MenuItem",
  "MenuLinkItem",
  "Dialog",
]);
export const BUTTON_CONTROLS = new Set([
  "Button",
  "IconButton",
  "buttonClassName",
]);
export const CONTROL_LOOK_PROPERTY =
  /^(?:color|background(?:-.*)?|border(?:-.*)?|box-shadow|transform|filter|text-shadow|fill|stroke|outline(?:-.*)?|font(?:-.*)?|line-height|letter-spacing|text-(?:transform|decoration(?:-.*)?)|padding(?:-.*)?|(?:min-|max-)?height|opacity)$/;

export function isLayoutTranslation(value: string): boolean {
  const text = value.replace(/!important\s*$/, "").trim();
  let rest = text;
  let found = false;
  while (rest) {
    const match = /^translate(?:[XYZ]|3d)?\(/i.exec(rest);
    if (!match) return false;
    let depth = 1;
    let i = match[0].length;
    for (; i < rest.length && depth; i++) {
      if (rest[i] === "(") depth++;
      if (rest[i] === ")") depth--;
    }
    if (depth) return false;
    rest = rest.slice(i).trim();
    found = true;
  }
  return found;
}

export interface OverrideRule {
  file: string;
  line: number;
  selector: string;
  properties: string[];
  declarations?: { property: string; value: string }[];
}
export interface ControlOverride {
  file: string;
  line: number;
  control: string;
  classes: string[];
  rules: OverrideRule[];
}
export interface OwnershipSource {
  file: string;
  text: string;
}
interface ClassRule extends OverrideRule {
  name: string;
  module: boolean;
  tags: string[];
  tail: string;
  qualifiers: string[];
}

function expandedSelectors(rule: Rule): string[] {
  const selectors = selectorParser().astSync(rule.selector).nodes;
  let owner: Rule | AtRule | Root | Document | undefined = rule.parent;
  while (owner && owner.type !== "rule") owner = owner.parent;
  if (!owner) return selectors.map(String);
  return expandedSelectors(owner).flatMap((parent) =>
    selectors.map((selector) => {
      const expanded = selector.clone();
      let nested = false;
      expanded.walkNesting((node) => {
        nested = true;
        node.replaceWith(
          ...(selectorParser()
            .astSync(parent)
            .first?.nodes.map((part) => part.clone()) ?? []),
        );
      });
      return nested ? expanded.toString() : `${parent} ${expanded}`;
    }),
  );
}

/** Classes on the subject or an ancestor count; sibling and :has() arguments don't. */
export function controlClassRules(file: string, text: string): ClassRule[] {
  const found: ClassRule[] = [];
  postcss.parse(text, { from: file }).walkRules((rule) => {
    const properties = [
      ...new Set(
        (rule.nodes ?? []).flatMap((node) =>
          node.type === "decl" &&
          !(node.prop === "transform" && isLayoutTranslation(node.value)) &&
          (CONTROL_LOOK_PROPERTY.test(node.prop.toLowerCase()) ||
            node.prop.startsWith("--")) &&
          !(
            node.prop === "opacity" &&
            /^(?:0|1)(?:\.0+)?$/.test(node.value.trim())
          )
            ? [node.prop]
            : [],
        ),
      ),
    ];
    if (!properties.length) return;
    const selectors = selectorParser().astSync(
      expandedSelectors(rule).join(","),
    );
    selectors.each((selector) => {
      selector.walkClasses((node) => {
        // :not(.x) and :has(.x) do not assert .x on the control being styled.
        for (
          let parent = node.parent;
          parent && parent !== selector;
          parent = parent.parent
        ) {
          if (
            parent.type === "pseudo" &&
            [":not", ":has"].includes(parent.value)
          )
            return;
        }
        // An earlier compound before a sibling combinator is not the control
        // or its descendant. Descendants, states, media and pseudo-elements count.
        let compound: selectorParser.Node | selectorParser.Container = node;
        while (compound.parent && compound.parent !== selector)
          compound = compound.parent;
        const index = selector.nodes.indexOf(
          compound as (typeof selector.nodes)[number],
        );
        if (
          selector.nodes
            .slice(index + 1)
            .some(
              (part) =>
                part.type === "combinator" &&
                ["+", "~"].includes(part.value.trim()),
            )
        )
          return;
        let global = !file.endsWith(".module.css");
        for (let parent = node.parent; parent; parent = parent.parent) {
          if (parent.type === "pseudo" && parent.value === ":global")
            global = true;
        }
        const before = selector.nodes
          .slice(0, index)
          .reduce(
            (last, part, i) => (part.type === "combinator" ? i : last),
            -1,
          );
        const after = selector.nodes.findIndex(
          (part, i) => i > index && part.type === "combinator",
        );
        const tags = selector.nodes
          .slice(before + 1, after < 0 ? undefined : after)
          .flatMap((part) => (part.type === "tag" ? [part.value] : []));
        // A type selector inside :global(a.launcher) still restricts the
        // same compound; it cannot style a shared <button>.
        if (node.parent && node.parent !== selector) {
          const siblings = node.parent.nodes;
          const at = siblings.indexOf(node);
          const start = siblings
            .slice(0, at)
            .reduce(
              (last, part, i) => (part.type === "combinator" ? i : last),
              -1,
            );
          const end = siblings.findIndex(
            (part, i) => i > at && part.type === "combinator",
          );
          tags.push(
            ...siblings
              .slice(start + 1, end < 0 ? undefined : end)
              .flatMap((part) => (part.type === "tag" ? [part.value] : [])),
          );
        }
        found.push({
          file,
          line: rule.source?.start?.line ?? 1,
          selector: selector.toString(),
          properties,
          declarations: (rule.nodes ?? []).flatMap((node) =>
            node.type === "decl"
              ? [{ property: node.prop, value: node.value }]
              : [],
          ),
          name: node.value,
          module: !global,
          tags,
          qualifiers: selector.nodes
            .slice(before + 1, after < 0 ? undefined : after)
            .flatMap((part) =>
              part.type === "class"
                ? [part.value]
                : part.type === "pseudo" && part.value === ":global"
                  ? [...part.toString().matchAll(/\.([\w-]+)/g)].map(
                      (match) => match[1] ?? "",
                    )
                  : [],
            ),
          tail:
            after < 0 ? "" : selector.nodes.slice(after).map(String).join(""),
        });
      });
    });
  });
  return found;
}

function attrExpression(attribute: ts.JsxAttribute): ts.Expression | undefined {
  const value = attribute.initializer;
  return value && ts.isJsxExpression(value) ? value.expression : value;
}
function propertyName(node: ts.PropertyName) {
  return ts.isComputedPropertyName(node) ? node.expression : node;
}

/** In-memory entry point keeps the tricky parser/forwarding cases cheap to test. */
export function analyzeControlOverrides(
  root: string,
  inputs: OwnershipSource[],
  mode: "controls" | "bases" = "controls",
) {
  const fileKey = (file: string) => resolve(file).split(sep).join("/");
  const contents = new Map(
    inputs
      .filter(({ file }) => /\.tsx?$/.test(file))
      .map(({ file, text }) => [fileKey(resolve(root, file)), text]),
  );
  const host = ts.createCompilerHost({});
  host.fileExists = (file) => contents.has(fileKey(file));
  host.directoryExists = (directory) =>
    [...contents.keys()].some((file) =>
      file.startsWith(`${fileKey(directory)}/`),
    );
  host.readFile = (file) => contents.get(fileKey(file));
  host.getSourceFile = (file, languageVersion) => {
    const text = contents.get(fileKey(file));
    return text === undefined
      ? undefined
      : ts.createSourceFile(file, text, languageVersion, true);
  };
  // A closed production-source program: no dependencies or lib ASTs are needed.
  const program = ts.createProgram(
    [...contents.keys()],
    {
      noLib: true,
      jsx: ts.JsxEmit.Preserve,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      module: ts.ModuleKind.ESNext,
    },
    host,
  );
  const checker = program.getTypeChecker();
  const sources = program.getSourceFiles();
  const pathOf = (file: string) => relative(root, file).split(sep).join("/");
  const symbolAt = (node: ts.Node) => {
    let symbol = checker.getSymbolAtLocation(node);
    if (symbol && symbol.flags & ts.SymbolFlags.Alias)
      symbol = checker.getAliasedSymbol(symbol);
    return symbol;
  };
  const componentUses = new Map<
    ts.Symbol,
    (ts.JsxOpeningElement | ts.JsxSelfClosingElement)[]
  >();
  for (const source of sources) {
    const visit = (node: ts.Node) => {
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        const symbol = symbolAt(node.tagName);
        if (symbol)
          componentUses.set(symbol, [
            ...(componentUses.get(symbol) ?? []),
            node,
          ]);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  const importedName = (node: ts.Node): string | undefined => {
    const symbol = checker.getSymbolAtLocation(node);
    const declaration = symbol?.declarations?.[0];
    if (declaration && ts.isImportSpecifier(declaration)) {
      const from = declaration.parent.parent.parent;
      if (
        ts.isStringLiteral(from.moduleSpecifier) &&
        /(?:^|\/)ui\//.test(from.moduleSpecifier.text)
      )
        return (declaration.propertyName ?? declaration.name).text;
    }
    const target = symbolAt(node);
    if (
      target?.declarations?.some((decl) =>
        /\/components\/ui\/[^/]+\.tsx$/.test(decl.getSourceFile().fileName),
      )
    )
      return target.name;
    return undefined;
  };
  const moduleImports = new Map<ts.Symbol, string>();
  for (const source of sources)
    for (const statement of source.statements) {
      if (
        !ts.isImportDeclaration(statement) ||
        !ts.isStringLiteral(statement.moduleSpecifier) ||
        !statement.moduleSpecifier.text.endsWith(".module.css")
      )
        continue;
      const binding = statement.importClause?.name;
      const symbol = binding && checker.getSymbolAtLocation(binding);
      if (symbol)
        moduleImports.set(
          symbol,
          pathOf(
            resolve(dirname(source.fileName), statement.moduleSpecifier.text),
          ),
        );
    }
  const refs = new Map<string, { file?: string; name: string }>();
  const moduleToken = (file: string, name: string) => {
    const token = `__module_${refs.size}__`;
    // Reuse a token so template products deduplicate.
    for (const [key, ref] of refs)
      if (ref.file === file && ref.name === name) return key;
    refs.set(token, { file, name });
    return token;
  };
  interface Value {
    text: string;
    origin: ts.Node;
  }
  const product = (a: Value[], b: Value[], glue: string, origin: ts.Node) =>
    a.flatMap((left) =>
      b.map((right) => ({
        text: left.text + glue + right.text,
        origin: left.origin === origin ? right.origin : left.origin,
      })),
    );
  const forwardingScope = new Map<
    ts.Symbol,
    ts.JsxOpeningElement | ts.JsxSelfClosingElement
  >();
  const forwarded = (
    parameter: ts.ParameterDeclaration,
    name: string,
    origin: ts.Node,
    seen: Set<ts.Node>,
  ): Value[] => {
    const fn = parameter.parent;
    let owner: ts.Node = fn;
    while (
      owner.parent &&
      (ts.isCallExpression(owner.parent) ||
        ts.isParenthesizedExpression(owner.parent))
    )
      owner = owner.parent;
    const named = ts.isVariableDeclaration(owner.parent)
      ? owner.parent.name
      : ts.isFunctionDeclaration(fn) || ts.isFunctionExpression(fn)
        ? fn.name
        : undefined;
    const symbol = named && symbolAt(named);
    if (!symbol) return [];
    const scoped = forwardingScope.get(symbol);
    const values = (
      scoped ? [scoped] : (componentUses.get(symbol) ?? [])
    ).flatMap((use) => {
      const attribute = use.attributes.properties.find(
        (prop): prop is ts.JsxAttribute =>
          ts.isJsxAttribute(prop) && prop.name.getText() === name,
      );
      const expr = attribute && attrExpression(attribute);
      if (expr) return evaluate(expr, attribute, new Set(seen));
      return use.attributes.properties.flatMap((prop) =>
        ts.isJsxSpreadAttribute(prop)
          ? classProperty(prop.expression, name, prop, new Set(seen))
          : [],
      );
    });
    return [
      ...values,
      ...(parameter.initializer
        ? evaluate(parameter.initializer, origin, seen)
        : []),
    ];
  };
  const classProperty = (
    node: ts.Node,
    name: string,
    origin: ts.Node,
    seen: Set<ts.Node>,
  ): Value[] => {
    if (seen.has(node)) return [];
    seen = new Set(seen).add(node);
    if (ts.isObjectLiteralExpression(node))
      return node.properties.flatMap((prop) => {
        if (ts.isSpreadAssignment(prop))
          return classProperty(prop.expression, name, origin, seen);
        if (
          ts.isPropertyAssignment(prop) &&
          prop.name.getText().replace(/^["']|["']$/g, "") === name
        )
          return evaluate(prop.initializer, origin, seen);
        if (ts.isShorthandPropertyAssignment(prop) && prop.name.text === name)
          return evaluate(prop.name, origin, seen);
        return [];
      });
    if (ts.isIdentifier(node))
      return (symbolAt(node)?.declarations ?? []).flatMap((decl) => {
        if (ts.isVariableDeclaration(decl) && decl.initializer)
          return classProperty(decl.initializer, name, origin, seen);
        if (ts.isParameter(decl)) return forwarded(decl, name, origin, seen);
        if (
          ts.isBindingElement(decl) &&
          decl.dotDotDotToken &&
          ts.isParameter(decl.parent.parent)
        )
          return forwarded(decl.parent.parent, name, origin, seen);
        return [];
      });
    return [];
  };
  const evaluate = (
    node: ts.Node,
    origin: ts.Node,
    seen: Set<ts.Node>,
  ): Value[] => {
    const value = (text: string) => [{ text, origin }];
    if (seen.has(node)) return value("__unresolved__");
    seen = new Set(seen).add(node);
    if (ts.isStringLiteralLike(node)) return value(node.text);
    if (ts.isIdentifier(node) || ts.isPropertyAccessExpression(node)) {
      const type = checker.getTypeAtLocation(node);
      const parts = type.isUnion() ? type.types : [type];
      if (
        parts.length &&
        parts.every(
          (part) =>
            part.isStringLiteral() ||
            !!(part.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined)),
        )
      )
        return parts.flatMap((part) =>
          part.isStringLiteral() ? value(part.value) : value(""),
        );
    }
    if (
      node.kind === ts.SyntaxKind.NullKeyword ||
      node.kind === ts.SyntaxKind.FalseKeyword ||
      node.kind === ts.SyntaxKind.TrueKeyword ||
      (ts.isIdentifier(node) && node.text === "undefined")
    )
      return value("");
    if (
      ts.isArrowFunction(node) ||
      ts.isFunctionExpression(node) ||
      ts.isFunctionDeclaration(node)
    ) {
      if (!node.body) return value("__unresolved__");
      if (!ts.isBlock(node.body)) return evaluate(node.body, origin, seen);
      const returned: Value[] = [];
      const visitReturn = (child: ts.Node) => {
        if (ts.isReturnStatement(child) && child.expression)
          returned.push(...evaluate(child.expression, origin, new Set(seen)));
        else if (!ts.isFunctionLike(child)) ts.forEachChild(child, visitReturn);
      };
      ts.forEachChild(node.body, visitReturn);
      return returned.length ? returned : value("__unresolved__");
    }
    if (
      ts.isParenthesizedExpression(node) ||
      ts.isAsExpression(node) ||
      ts.isNonNullExpression(node) ||
      ts.isSatisfiesExpression(node)
    )
      return evaluate(node.expression, origin, seen);
    if (ts.isConditionalExpression(node))
      return [
        ...evaluate(node.whenTrue, origin, seen),
        ...evaluate(node.whenFalse, origin, seen),
      ];
    if (ts.isBinaryExpression(node)) {
      if (node.operatorToken.kind === ts.SyntaxKind.PlusToken)
        return product(
          evaluate(node.left, origin, seen),
          evaluate(node.right, origin, seen),
          "",
          origin,
        );
      if (node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken)
        return [...value(""), ...evaluate(node.right, origin, seen)];
      return [
        ...evaluate(node.left, origin, seen),
        ...evaluate(node.right, origin, seen),
      ];
    }
    if (ts.isTemplateExpression(node)) {
      let values = value(node.head.text);
      for (const span of node.templateSpans)
        values = product(
          product(values, evaluate(span.expression, origin, seen), "", origin),
          value(span.literal.text),
          "",
          origin,
        );
      return values;
    }
    if (
      ts.isPropertyAccessExpression(node) ||
      ts.isElementAccessExpression(node)
    ) {
      const symbol = checker.getSymbolAtLocation(node.expression);
      const module = symbol && moduleImports.get(symbol);
      let key = ts.isPropertyAccessExpression(node)
        ? value(node.name.text)
        : evaluate(node.argumentExpression, origin, seen);
      if (
        module &&
        key.every(({ text }) => !text || text.includes("__unresolved__")) &&
        ts.isElementAccessExpression(node)
      ) {
        const type = checker.getTypeAtLocation(node.argumentExpression);
        key = (type.isUnion() ? type.types : [type]).flatMap((part) =>
          part.isStringLiteral() ? value(part.value) : [],
        );
      }
      if (module && !key.length) return value("__unresolved__");
      if (module)
        return key.map(({ text }) => ({
          text: moduleToken(module, text),
          origin,
        }));
      const declaration = symbol?.declarations?.[0];
      if (declaration && ts.isParameter(declaration))
        return key.flatMap(({ text }) =>
          forwarded(declaration, text, origin, seen),
        );
      if (
        declaration &&
        ts.isVariableDeclaration(declaration) &&
        declaration.initializer &&
        ts.isObjectLiteralExpression(declaration.initializer)
      ) {
        const matches = declaration.initializer.properties.flatMap((prop) =>
          ts.isPropertyAssignment(prop) &&
          key.some(
            ({ text }) =>
              prop.name.getText().replace(/^["']|["']$/g, "") === text,
          )
            ? evaluate(prop.initializer, origin, seen)
            : [],
        );
        return matches.length ? matches : value("__unresolved__");
      }
    }
    if (ts.isIdentifier(node)) {
      const symbol = ts.isShorthandPropertyAssignment(node.parent)
        ? checker.getShorthandAssignmentValueSymbol(node.parent)
        : symbolAt(node);
      const declarations = symbol?.declarations ?? [];
      if (!declarations.length) return value("__unresolved__");
      return declarations.flatMap((declaration) => {
        if (ts.isVariableDeclaration(declaration) && declaration.initializer)
          return evaluate(declaration.initializer, origin, seen);
        if (
          ts.isBindingElement(declaration) &&
          ts.isParameter(declaration.parent.parent)
        ) {
          const prop = (declaration.propertyName ?? declaration.name).getText();
          return [
            ...forwarded(declaration.parent.parent, prop, origin, seen),
            ...(declaration.initializer
              ? evaluate(declaration.initializer, origin, seen)
              : []),
          ];
        }
        if (
          ts.isBindingElement(declaration) &&
          ts.isVariableDeclaration(declaration.parent.parent) &&
          declaration.parent.parent.initializer
        ) {
          return classProperty(
            declaration.parent.parent.initializer,
            (declaration.propertyName ?? declaration.name).getText(),
            origin,
            seen,
          );
        }
        if (ts.isParameter(declaration)) {
          const fn = declaration.parent;
          const name =
            ts.isFunctionDeclaration(fn) || ts.isFunctionExpression(fn)
              ? fn.name
              : ts.isVariableDeclaration(fn.parent)
                ? fn.parent.name
                : undefined;
          const target = name && symbolAt(name);
          const values: Value[] = [];
          if (target)
            for (const source of sources) {
              const visitCall = (call: ts.Node) => {
                if (
                  ts.isCallExpression(call) &&
                  symbolAt(call.expression) === target
                ) {
                  const arg =
                    call.arguments[fn.parameters.indexOf(declaration)];
                  if (arg) values.push(...evaluate(arg, origin, new Set(seen)));
                }
                ts.forEachChild(call, visitCall);
              };
              visitCall(source);
            }
          return values.length ? values : value("__unresolved__");
        }
        return value("__unresolved__");
      });
    }
    if (ts.isArrayLiteralExpression(node))
      return node.elements.flatMap((item) => evaluate(item, origin, seen));
    if (ts.isSpreadElement(node))
      return evaluate(node.expression, origin, seen);
    if (ts.isObjectLiteralExpression(node))
      return node.properties.flatMap((prop) =>
        ts.isPropertyAssignment(prop)
          ? ts.isComputedPropertyName(prop.name)
            ? evaluate(propertyName(prop.name), origin, seen)
            : value(prop.name.getText().replace(/^["']|["']$/g, ""))
          : ts.isShorthandPropertyAssignment(prop)
            ? value(prop.name.text)
            : [],
      );
    if (ts.isCallExpression(node)) {
      if (importedName(node.expression) === "buttonClassName") {
        const argument = node.arguments[0];
        return argument
          ? classProperty(argument, "className", origin, seen)
          : [];
      }
      if (
        ts.isPropertyAccessExpression(node.expression) &&
        ["join", "filter", "trim", "trimEnd"].includes(
          node.expression.name.text,
        )
      )
        return evaluate(node.expression.expression, origin, seen);
      const name = ts.isPropertyAccessExpression(node.expression)
        ? node.expression.name.text
        : node.expression.getText();
      if (["clsx", "classNames", "joinClasses", "cx"].includes(name))
        return node.arguments.flatMap((argument) =>
          evaluate(argument, origin, seen),
        );
      if (name === "useMemo" && node.arguments[0])
        return evaluate(node.arguments[0], origin, seen);
      const declarations = symbolAt(node.expression)?.declarations ?? [];
      for (const declaration of declarations) {
        if (ts.isFunctionDeclaration(declaration))
          return evaluate(declaration, origin, seen);
        if (ts.isVariableDeclaration(declaration) && declaration.initializer)
          return evaluate(declaration.initializer, origin, seen);
      }
      return value("__unresolved__");
    }
    return value("__unresolved__");
  };
  const rules = inputs
    .filter(({ file }) => file.endsWith(".css"))
    .flatMap(({ file, text }) => controlClassRules(file, text));
  const byClass = new Map<string, ClassRule[]>();
  for (const rule of rules) {
    const key = `${rule.module ? rule.file : ""}:${rule.name}`;
    byClass.set(key, [...(byClass.get(key) ?? []), rule]);
  }
  const rows = new Map<string, ControlOverride>();
  let uses = 0;
  let buttonUses = 0;
  // Public custom properties are part of the control's look, derived from its
  // module reads rather than a second hand-maintained vocabulary.
  const customReads = (control: string, use: ts.Node) => {
    const modules = new Set<string>();
    const target =
      ts.isJsxOpeningElement(use) || ts.isJsxSelfClosingElement(use)
        ? use.tagName
        : use;
    for (const declaration of symbolAt(target)?.declarations ?? []) {
      const source = declaration.getSourceFile();
      for (const statement of source.statements)
        if (
          ts.isImportDeclaration(statement) &&
          ts.isStringLiteral(statement.moduleSpecifier) &&
          statement.moduleSpecifier.text.endsWith(".module.css")
        )
          modules.add(
            pathOf(
              resolve(dirname(source.fileName), statement.moduleSpecifier.text),
            ),
          );
    }
    // Also supports closed fixtures where only the CSS module is supplied.
    if (!modules.size)
      modules.add(
        `components/ui/${control === "IconButton" || control === "buttonClassName" ? "Button" : control}.module.css`,
      );
    return new Set(
      inputs
        .filter(({ file }) => modules.has(file))
        .flatMap(({ text }) =>
          [...text.matchAll(/var\(\s*(--[\w-]+)/g)].map((match) => match[1]),
        ),
    );
  };
  const addRow = (
    control: string,
    origin: ts.Node,
    className: string,
    matches: OverrideRule[],
  ) => {
    if (!matches.length) return;
    const source = origin.getSourceFile();
    const file = pathOf(source.fileName);
    const line =
      source.getLineAndCharacterOfPosition(origin.getStart()).line + 1;
    const key = `${file}:${origin.pos}:${control}`;
    const row = rows.get(key) ?? {
      file,
      line,
      control,
      classes: [],
      rules: [],
    };
    if (!row.classes.includes(className)) row.classes.push(className);
    for (const rule of matches)
      if (
        !row.rules.some(
          (existing) =>
            existing.file === rule.file &&
            existing.line === rule.line &&
            existing.selector === rule.selector,
        )
      )
        row.rules.push(rule);
    rows.set(key, row);
  };
  const opening = (node: ts.Node) =>
    ts.isJsxElement(node)
      ? node.openingElement
      : ts.isJsxSelfClosingElement(node)
        ? node
        : undefined;
  const childTagCache = new Map<ts.Node, Set<string>>();
  const childTags = (use: ts.Node) => {
    const cached = childTagCache.get(use);
    if (cached) return cached;
    const tags = new Set<string>();
    const seen = new Set<ts.Node>();
    const visit = (node: ts.Node, resolveComponents = true): void => {
      if (seen.has(node)) return;
      seen.add(node);
      const element = opening(node);
      if (element) {
        if (/^[a-z]/.test(element.tagName.getText()))
          tags.add(element.tagName.getText());
        else if (resolveComponents)
          for (const declaration of symbolAt(element.tagName)?.declarations ??
            [])
            visit(declaration, false);
        for (const attr of element.attributes.properties)
          if (ts.isJsxAttribute(attr) && attr.name.getText() === "className") {
            const expr = attrExpression(attr);
            if (expr)
              for (const value of evaluate(expr, attr, new Set()))
                for (const token of value.text.split(/\s+/))
                  tags.add(`.${refs.get(token)?.name ?? token}`);
          }
      }
      ts.forEachChild(node, (child) => visit(child, resolveComponents));
    };
    if (ts.isJsxOpeningElement(use) && ts.isJsxElement(use.parent))
      for (const child of use.parent.children) visit(child);
    if (ts.isJsxOpeningElement(use) || ts.isJsxSelfClosingElement(use))
      for (const attribute of use.attributes.properties)
        if (
          ts.isJsxAttribute(attribute) &&
          !["className", "style", "ref"].includes(attribute.name.getText()) &&
          !attribute.name.getText().startsWith("on")
        )
          visit(attribute);
    childTagCache.set(use, tags);
    return tags;
  };
  // A helper-built class can be handed to an obvious wrapper which appends
  // state classes before reaching ButtonBase (for example copied feedback).
  const helperConsumerClasses = (
    call: ts.CallExpression,
    origin: ts.Node,
  ): Value[] => {
    const base = evaluate(call, origin, new Set())
      .flatMap((value) => value.text.split(/\s+/))
      .filter(Boolean);
    if (!base.length) return [];
    let owner: ts.Node = call;
    while (
      owner.parent &&
      !ts.isVariableDeclaration(owner) &&
      !ts.isJsxAttribute(owner) &&
      !ts.isStatement(owner)
    )
      owner = owner.parent;
    const binding = ts.isVariableDeclaration(owner)
      ? symbolAt(owner.name)
      : undefined;
    const values: Value[] = [];
    for (const uses of componentUses.values())
      for (const use of uses) {
        const attr = use.attributes.properties.find(
          (attribute): attribute is ts.JsxAttribute =>
            ts.isJsxAttribute(attribute) &&
            attribute.name.getText() === "className",
        );
        const expression = attr && attrExpression(attr);
        if (
          !expression ||
          !(
            owner === attr ||
            (binding &&
              ts.isIdentifier(expression) &&
              symbolAt(expression) === binding)
          )
        )
          continue;
        for (const declaration of symbolAt(use.tagName)?.declarations ?? []) {
          const visit = (node: ts.Node) => {
            if (
              ts.isJsxAttribute(node) &&
              node.name.getText() === "className"
            ) {
              const expr = attrExpression(node);
              if (expr)
                for (const value of evaluate(expr, origin, new Set()))
                  if (
                    value.text
                      .split(/\s+/)
                      .some((token) => base.includes(token))
                  )
                    values.push({ ...value, origin });
            }
            ts.forEachChild(node, visit);
          };
          visit(declaration);
        }
      }
    return values;
  };
  const inspect = (
    control: string,
    expression: ts.Expression,
    origin: ts.Node,
    use: ts.Node,
    prop?: string,
    ancestorMatch?: (rule: ClassRule) => boolean,
    extraValues: Value[] = [],
  ) => {
    const values = [
      ...(prop
        ? classProperty(expression, prop, origin, new Set())
        : evaluate(expression, origin, new Set())),
      ...extraValues,
    ];
    const custom = customReads(control, use);
    const names = new Set(
      values.flatMap((value) =>
        value.text.split(/\s+/).map((token) => refs.get(token)?.name ?? token),
      ),
    );
    for (const resolved of values)
      for (const token of resolved.text.split(/\s+/).filter(Boolean)) {
        if (token.includes("__unresolved__")) {
          if (ancestorMatch) continue;
          addRow(control, resolved.origin, "<unresolved className>", [
            {
              file: pathOf(expression.getSourceFile().fileName),
              line:
                expression
                  .getSourceFile()
                  .getLineAndCharacterOfPosition(expression.getStart()).line +
                1,
              selector: expression.getText(),
              properties: ["unresolved className"],
            },
          ]);
          continue;
        }
        const ref = refs.get(token) ?? { name: token };
        const native =
          BUTTON_CONTROLS.has(control) ||
          control === "ButtonBase" ||
          control === "SelectableCard"
            ? "button"
            : undefined;
        const matches = (byClass.get(`${ref.file ?? ""}:${ref.name}`) ?? [])
          .filter((rule) => {
            if (ancestorMatch) return ancestorMatch(rule);
            if (rule.qualifiers.some((name) => !names.has(name))) return false;
            if (native && rule.tags.length && !rule.tags.includes(native))
              return false;
            if (mode === "bases" && rule.tail) return false;
            if (rule.tail) {
              const subject = selectorParser().astSync(
                rule.tail.trim().replace(/^>/, "").trim(),
              ).first;
              const tags: string[] = [];
              const last =
                subject?.nodes.reduce(
                  (index, part, i) => (part.type === "combinator" ? i : index),
                  -1,
                ) ?? -1;
              for (const part of subject?.nodes.slice(last + 1) ?? []) {
                if (part.type === "tag") tags.push(part.value);
                if (part.type === "class") tags.push(`.${part.value}`);
              }
              if (tags.length && tags.every((tag) => childTags(use).has(tag)))
                return false;
            }
            return true;
          })
          .map((rule) => ({
            ...rule,
            properties: rule.properties.filter(
              (property) =>
                mode === "bases" ||
                !property.startsWith("--") ||
                custom.has(property),
            ),
          }))
          .filter((rule) => rule.properties.length);
        addRow(
          control,
          mode === "bases" ? use : ancestorMatch ? origin : resolved.origin,
          `${ref.file ? `${ref.file}:` : ""}.${ref.name}`,
          matches,
        );
      }
  };
  // Match descendant selectors against the actual JSX ancestry in this component.
  // Caller-owned child icons are handled separately from descendants owned by a control.
  const inspectAncestors = (
    control: string,
    use: ts.JsxOpeningElement | ts.JsxSelfClosingElement,
  ) => {
    const path: (ts.JsxOpeningElement | ts.JsxSelfClosingElement)[] = [use];
    let parent: ts.Node | undefined = ts.isJsxOpeningElement(use)
      ? use.parent.parent
      : use.parent;
    while (parent && !ts.isFunctionLike(parent)) {
      if (ts.isJsxElement(parent)) {
        const ancestor = parent.openingElement;
        const attr = ancestor.attributes.properties.find(
          (p): p is ts.JsxAttribute =>
            ts.isJsxAttribute(p) && p.name.getText() === "className",
        );
        const expr = attr && attrExpression(attr);
        if (expr)
          inspect(control, expr, use, use, undefined, (rule) => {
            if (!rule.tail) return false;
            const selector = selectorParser().astSync(`x${rule.tail}`).first;
            if (!selector) return false;
            const compounds: selectorParser.Node[][] = [[]];
            const combinators: string[] = [];
            for (const part of selector.nodes.slice(1)) {
              if (part.type === "combinator") {
                combinators.push(part.value.trim());
                compounds.push([]);
              } else compounds[compounds.length - 1]?.push(part);
            }
            const match = (
              parts: selectorParser.Node[],
              element: typeof use,
            ): boolean =>
              parts.every((part) => {
                if (part.type === "universal") return true;
                if (part.type === "tag")
                  return (
                    part.value ===
                    (element === use &&
                    (BUTTON_CONTROLS.has(control) ||
                      control === "ButtonBase" ||
                      control === "SelectableCard")
                      ? "button"
                      : element.tagName.getText())
                  );
                if (part.type === "attribute") {
                  if (part.attribute === "class") return true;
                  return element.attributes.properties.some(
                    (p) =>
                      ts.isJsxAttribute(p) &&
                      p.name.getText() === part.attribute,
                  );
                }
                if (
                  part.type === "pseudo" &&
                  [":is", ":where", ":global", ":not"].includes(part.value)
                ) {
                  const matches =
                    part.nodes?.some((selector) =>
                      match(selector.nodes, element),
                    ) ?? true;
                  return part.value === ":not" ? !matches : matches;
                }
                if (part.type === "class") {
                  const attribute = element.attributes.properties.find(
                    (p): p is ts.JsxAttribute =>
                      ts.isJsxAttribute(p) && p.name.getText() === "className",
                  );
                  const expression = attribute && attrExpression(attribute);
                  return (
                    !!expression &&
                    evaluate(expression, attribute, new Set()).some((value) =>
                      value.text
                        .split(/\s+/)
                        .some(
                          (token) =>
                            (refs.get(token)?.name ?? token) === part.value,
                        ),
                    )
                  );
                }
                // :not([class]) deliberately excludes shared controls; other states
                // can occur at runtime and therefore cannot exempt a look rule.
                return !(
                  part.type === "pseudo" &&
                  part.value === ":not" &&
                  part.toString().includes("[class]")
                );
              });
            let at = 0;
            for (let i = compounds.length - 1; i > 0; i--) {
              if (
                i === compounds.length - 1 &&
                !match(compounds[i] ?? [], path[at] ?? use)
              )
                return false;
              if (i !== compounds.length - 1) {
                if (combinators[i] === ">") {
                  at++;
                  if (!path[at] || !match(compounds[i] ?? [], path[at]!))
                    return false;
                } else {
                  do {
                    at++;
                  } while (path[at] && !match(compounds[i] ?? [], path[at]!));
                  if (!path[at]) return false;
                }
              }
            }
            return combinators[0] !== ">" || at === path.length - 1;
          });
        path.push(ancestor);
      }
      parent = parent.parent;
    }
  };
  const inspectStyle = (
    control: string,
    expression: ts.Expression,
    origin: ts.Node,
    use: ts.Node,
  ) => {
    const custom = customReads(control, use);
    const visitStyle = (node: ts.Node, seen = new Set<ts.Node>()) => {
      if (seen.has(node)) return;
      seen = new Set(seen).add(node);
      if (ts.isObjectLiteralExpression(node))
        for (const property of node.properties) {
          if (ts.isSpreadAssignment(property))
            visitStyle(property.expression, seen);
          if (!ts.isPropertyAssignment(property)) continue;
          const key = property.name
            .getText()
            .replace(/^["']|["']$/g, "")
            .replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
          if (
            (CONTROL_LOOK_PROPERTY.test(key) || custom.has(key)) &&
            !(
              key === "transform" &&
              isLayoutTranslation(
                property.initializer.getText().replace(/^["'`]|["'`]$/g, ""),
              )
            ) &&
            !(
              key === "opacity" &&
              /^(?:0|1|["'](?:0|1)["'])$/.test(property.initializer.getText())
            )
          )
            addRow(control, origin, "<inline style>", [
              {
                file: pathOf(origin.getSourceFile().fileName),
                line:
                  origin
                    .getSourceFile()
                    .getLineAndCharacterOfPosition(origin.getStart()).line + 1,
                selector: property.getText(),
                properties: [key],
                declarations: [
                  {
                    property: key,
                    value: property.initializer
                      .getText()
                      .replace(/^["']|["']$/g, ""),
                  },
                ],
              },
            ]);
        }
      else if (ts.isIdentifier(node)) {
        const declaration = symbolAt(node)?.valueDeclaration;
        if (
          declaration &&
          ts.isVariableDeclaration(declaration) &&
          declaration.initializer
        )
          visitStyle(declaration.initializer, seen);
        else
          addRow(control, origin, "<unresolved style>", [
            {
              file: pathOf(origin.getSourceFile().fileName),
              line: 1,
              selector: node.getText(),
              properties: ["unresolved style"],
            },
          ]);
      } else if (ts.isConditionalExpression(node)) {
        visitStyle(node.whenTrue, seen);
        visitStyle(node.whenFalse, seen);
      } else if (ts.isAsExpression(node) || ts.isParenthesizedExpression(node))
        visitStyle(node.expression, seen);
    };
    visitStyle(expression);
  };
  for (const source of sources) {
    const visit = (node: ts.Node) => {
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        const control = importedName(node.tagName);
        // A control's own variant classes are its implementation, not caller classes.
        const owns = symbolAt(node.tagName)?.declarations?.some(
          (decl) => decl.getSourceFile() === source,
        );
        if (
          mode === "bases" &&
          /\/components\/ui\/SelectableCard\.tsx$/.test(source.fileName)
        )
          return;
        if (
          control &&
          (mode === "bases"
            ? control === "ButtonBase"
            : CONTROLS.has(control)) &&
          !owns
        ) {
          uses++;
          if (mode === "bases") {
            const file = pathOf(source.fileName);
            rows.set(`${file}:${node.pos}:${control}`, {
              file,
              line:
                source.getLineAndCharacterOfPosition(node.getStart()).line + 1,
              control,
              classes: [],
              rules: [],
            });
          }
          if (BUTTON_CONTROLS.has(control)) buttonUses++;
          const attributes = node.attributes.properties.filter(
            (prop): prop is ts.JsxAttribute =>
              ts.isJsxAttribute(prop) &&
              ["className", "inputClassName", "bodyClassName"].includes(
                prop.name.getText(),
              ),
          );
          for (const attribute of attributes) {
            const expr = attrExpression(attribute);
            if (expr) inspect(control, expr, node, node);
          }
          inspectAncestors(control, node);
          for (const attribute of node.attributes.properties)
            if (
              ts.isJsxAttribute(attribute) &&
              attribute.name.getText() === "style"
            ) {
              const expr = attrExpression(attribute);
              if (expr) inspectStyle(control, expr, node, node);
            }
          for (const spread of node.attributes.properties)
            if (ts.isJsxSpreadAttribute(spread))
              for (const prop of [
                "className",
                "inputClassName",
                "bodyClassName",
              ])
                inspect(control, spread.expression, node, node, prop);
        }
      }
      if (
        mode === "controls" &&
        ts.isCallExpression(node) &&
        importedName(node.expression) === "buttonClassName" &&
        !symbolAt(node.expression)?.declarations?.some(
          (decl) => decl.getSourceFile() === source,
        )
      ) {
        uses++;
        buttonUses++;
        let parent: ts.Node = node;
        while (
          parent.parent &&
          !ts.isJsxAttribute(parent) &&
          !ts.isStatement(parent)
        )
          parent = parent.parent;
        const attribute =
          ts.isJsxAttribute(parent) && parent.name.getText() === "className"
            ? parent
            : undefined;
        const expression = attribute && attrExpression(attribute);
        inspect(
          "buttonClassName",
          expression ?? node,
          attribute ?? node,
          node,
          undefined,
          undefined,
          helperConsumerClasses(node, attribute ?? node),
        );
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return {
    uses,
    buttonUses,
    overrides: [...rows.values()].sort(
      (a, b) => a.file.localeCompare(b.file) || a.line - b.line,
    ),
  };
}

export async function scanControlOverrides(
  root: string,
  mode: "controls" | "bases" = "controls",
) {
  const inputs: OwnershipSource[] = [];
  const walk = async (directory: string) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "__tests__") await walk(path);
      } else if (
        /\.(?:tsx?|css)$/.test(entry.name) &&
        !/\.(?:test|spec|specimen)\.tsx?$/.test(entry.name)
      )
        inputs.push({
          file: relative(root, path).split(sep).join("/"),
          text: await readFile(path, "utf8"),
        });
    }
  };
  await walk(root);
  return analyzeControlOverrides(root, inputs, mode);
}
