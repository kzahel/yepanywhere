import ts from "typescript";
import selectorParser from "postcss-selector-parser";

/** Follow values into class sinks, including local/imported helpers and maps. */
export function classStringFindings(
  sources,
  families = [],
  globalClasses = [],
) {
  const options = {
    jsx: ts.JsxEmit.Preserve,
    noLib: true,
    target: ts.ScriptTarget.Latest,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    module: ts.ModuleKind.ESNext,
  };
  const host = ts.createCompilerHost(options);
  host.fileExists = (file) => sources.has(file);
  host.directoryExists = (directory) =>
    [...sources.keys()].some(
      (file) =>
        file.startsWith(`${directory}/`) || file.startsWith(`${directory}\\`),
    );
  host.getDirectories = () => [];
  host.readFile = (file) => sources.get(file);
  host.getSourceFile = (file) =>
    sources.has(file)
      ? ts.createSourceFile(
          file,
          sources.get(file),
          options.target,
          true,
          file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
        )
      : undefined;
  const program = ts.createProgram([...sources.keys()], options, host);
  const checker = program.getTypeChecker();
  const findings = new Map();
  const ownsEmission = (family, owner) =>
    [family, ...(family.emitters ?? [])].some((emitter) =>
      owner.endsWith(emitter.source),
    );
  const symbol = (node) => {
    let value = checker.getSymbolAtLocation(node);
    if (
      value?.valueDeclaration &&
      ts.isShorthandPropertyAssignment(value.valueDeclaration)
    )
      value =
        checker.getShorthandAssignmentValueSymbol(value.valueDeclaration) ??
        value;
    if (value?.flags & ts.SymbolFlags.Alias)
      value = checker.getAliasedSymbol(value);
    return value;
  };
  function report(node, value, kind) {
    if (!value.trim()) return;
    let names;
    if (kind === "selector") {
      names = [];
      try {
        selectorParser((root) => {
          root.walkClasses((part) => names.push(part.value));
          root.walkAttributes((part) => {
            if (part.attribute === "class" && part.value)
              names.push(...part.value.split(/\s+/));
          });
        }).processSync(value);
      } catch {
        return;
      }
    } else names = value.trim().split(/\s+/);
    for (const name of names) {
      const file = node.getSourceFile().fileName;
      const owner = file.replaceAll("\\", "/");
      if (
        !name ||
        families.some(
          (family) =>
            new RegExp(family.pattern).test(name) &&
            (kind === "selector" ||
              kind === "recognition" ||
              (kind !== "jsx" && ownsEmission(family, owner))),
        )
      )
        continue;
      const line =
        node.getSourceFile().getLineAndCharacterOfPosition(node.getStart())
          .line + 1;
      const findingKind = ["jsx", "recognition"].includes(kind)
        ? "class"
        : kind;
      findings.set(`${file}:${node.pos}:${findingKind}:${name}`, {
        file,
        line,
        kind: findingKind,
        name,
        start: node.getStart(),
        end: node.end,
      });
    }
  }
  function generatedToken(node, token, kind) {
    if (kind === "jsx") return false;
    const escaped = token
      .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      .replace(/__EXPR_\d+__/g, "[^\\s]+");
    const candidates = globalClasses.filter((name) =>
      new RegExp(`^${escaped}$`).test(name),
    );
    const owner = node.getSourceFile().fileName.replaceAll("\\", "/");
    return (
      candidates.length > 0 &&
      families.some(
        (family) =>
          ownsEmission(family, owner) &&
          candidates.every((name) => new RegExp(family.pattern).test(name)),
      )
    );
  }
  function collect(
    node,
    kind = "class",
    bindings = new Map(),
    seen = new Set(),
    helperKeys = false,
  ) {
    if (Array.isArray(node)) {
      for (const part of node) collect(part, kind, bindings, seen, helperKeys);
      return;
    }
    if (!node || seen.has(node)) return;
    seen = new Set(seen).add(node);
    const recurse = (child) => collect(child, kind, bindings, seen, helperKeys);
    if (ts.isStringLiteralLike(node)) return report(node, node.text, kind);
    if (ts.isTaggedTemplateExpression(node)) return recurse(node.template);
    if (ts.isTemplateExpression(node)) {
      const text =
        node.head.text +
        node.templateSpans
          .map((span, index) => `__EXPR_${index}__${span.literal.text}`)
          .join("");
      if (kind === "selector") {
        for (let index = 0; index < node.templateSpans.length; index++) {
          const before =
            index === 0
              ? node.head.text
              : node.templateSpans[index - 1].literal.text;
          collect(
            node.templateSpans[index].expression,
            /\.[\w-]*$/.test(before) ? "class" : "selector",
            bindings,
            seen,
          );
        }
        report(
          node,
          text
            .replace(/\.__EXPR_\d+__/g, "[data-module]")
            .replace(/__EXPR_\d+__/g, "dynamic"),
          kind,
        );
        return;
      }
      for (const token of text.trim().split(/\s+/)) {
        if (!token) continue;
        if (/^(?:__EXPR_\d+__)+$/.test(token)) {
          for (const match of token.matchAll(/__EXPR_(\d+)__/g))
            recurse(node.templateSpans[Number(match[1])].expression);
          continue;
        }
        if (token.includes("__EXPR_")) {
          if (generatedToken(node, token, kind)) continue;
          report(node, token, kind);
        } else report(node, token, kind);
      }
      return;
    }
    if (ts.isIdentifier(node)) {
      const sym = symbol(node);
      if (bindings.has(sym))
        return collect(bindings.get(sym), kind, bindings, seen, helperKeys);
      const declaration = sym?.valueDeclaration;
      if (declaration && ts.isVariableDeclaration(declaration))
        recurse(declaration.initializer);
      if (declaration && ts.isParameter(declaration)) {
        recurse(declaration.initializer);
        const owner = declaration.parent;
        const index = owner.parameters.indexOf(declaration);
        const ownerSymbol = owner.name
          ? symbol(owner.name)
          : ts.isVariableDeclaration(owner.parent)
            ? symbol(owner.parent.name)
            : undefined;
        if (ownerSymbol)
          for (const source of program.getSourceFiles()) {
            function callers(part) {
              if (
                ts.isCallExpression(part) &&
                symbol(part.expression) === ownerSymbol
              )
                collect(
                  part.arguments[index] ?? declaration.initializer,
                  kind,
                  bindings,
                  seen,
                  helperKeys,
                );
              ts.forEachChild(part, callers);
            }
            callers(source);
          }
      }
      return;
    }
    if (ts.isConditionalExpression(node)) {
      recurse(node.whenTrue);
      recurse(node.whenFalse);
      return;
    }
    if (ts.isBinaryExpression(node)) {
      if (
        [
          ts.SyntaxKind.PlusToken,
          ts.SyntaxKind.BarBarToken,
          ts.SyntaxKind.QuestionQuestionToken,
        ].includes(node.operatorToken.kind)
      )
        recurse(node.left);
      if (
        [
          ts.SyntaxKind.PlusToken,
          ts.SyntaxKind.BarBarToken,
          ts.SyntaxKind.QuestionQuestionToken,
          ts.SyntaxKind.AmpersandAmpersandToken,
        ].includes(node.operatorToken.kind)
      )
        recurse(node.right);
      return;
    }
    if (
      ts.isParenthesizedExpression(node) ||
      ts.isAsExpression(node) ||
      ts.isSatisfiesExpression(node) ||
      ts.isNonNullExpression(node) ||
      ts.isTypeAssertionExpression(node) ||
      ts.isAwaitExpression(node) ||
      ts.isSpreadElement(node)
    )
      return recurse(node.expression);
    if (ts.isArrayLiteralExpression(node)) {
      node.elements.forEach(recurse);
      return;
    }
    if (ts.isObjectLiteralExpression(node)) {
      for (const prop of node.properties) {
        if (ts.isSpreadAssignment(prop)) recurse(prop.expression);
        else if (
          helperKeys &&
          (ts.isPropertyAssignment(prop) ||
            ts.isShorthandPropertyAssignment(prop))
        ) {
          if (ts.isComputedPropertyName(prop.name))
            recurse(prop.name.expression);
          else report(prop.name, prop.name.text, kind);
        } else if (ts.isPropertyAssignment(prop)) recurse(prop.initializer);
      }
      return;
    }
    if (
      ts.isPropertyAccessExpression(node) ||
      ts.isElementAccessExpression(node)
    ) {
      // Imported CSS module exports are opaque, and their lookup keys aren't classes.
      const receiver = node.expression;
      const declaration = symbol(receiver)?.declarations?.[0];
      if (
        declaration &&
        ts.isImportClause(declaration) &&
        declaration.parent.moduleSpecifier.text.endsWith(".module.css")
      )
        return;
      const decl = symbol(node)?.valueDeclaration;
      if (decl && ts.isPropertyAssignment(decl))
        return recurse(decl.initializer);
      if (ts.isElementAccessExpression(node))
        for (const value of mapValues(receiver, bindings))
          collect(value, kind, bindings, seen, helperKeys);
      return;
    }
    if (ts.isCallExpression(node)) {
      if (
        ts.isPropertyAccessExpression(node.expression) &&
        ["join", "filter", "trim"].includes(node.expression.name.text)
      )
        return recurse(node.expression.expression);
      if (
        ts.isIdentifier(node.expression) &&
        ["cx", "cn", "clsx", "classNames"].includes(node.expression.text)
      ) {
        for (const arg of node.arguments)
          collect(arg, kind, bindings, seen, true);
        return;
      }
      const decl =
        checker.getResolvedSignature(node)?.declaration ??
        symbol(node.expression)?.valueDeclaration;
      if (!decl?.body) return;
      const next = new Map(bindings);
      decl.parameters.forEach((param, index) => {
        next.set(
          symbol(param.name),
          param.dotDotDotToken
            ? [...node.arguments].slice(index)
            : (node.arguments[index] ?? param.initializer),
        );
      });
      function returns(part) {
        if (ts.isReturnStatement(part))
          collect(part.expression, kind, next, seen, helperKeys);
        else if (part !== decl.body && ts.isFunctionLike(part)) return;
        else ts.forEachChild(part, returns);
      }
      if (ts.isBlock(decl.body)) returns(decl.body);
      else collect(decl.body, kind, next, seen, helperKeys);
    }
  }
  function staticText(node, seen = new Set()) {
    if (!node || seen.has(node)) return undefined;
    if (ts.isStringLiteralLike(node)) return node.text;
    seen = new Set(seen).add(node);
    if (ts.isIdentifier(node)) {
      const decl = symbol(node)?.valueDeclaration;
      if (decl && ts.isVariableDeclaration(decl))
        return staticText(decl.initializer, seen);
    }
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node))
      return staticText(node.expression, seen);
    return undefined;
  }
  // Enumerate selected values, keeping state/map keys separate from class
  // dictionary keys. A helper may receive either strings or dictionaries.
  function mapValues(node, bindings = new Map(), seen = new Set()) {
    if (!node || seen.has(node)) return [];
    seen = new Set(seen).add(node);
    if (ts.isIdentifier(node)) {
      const sym = symbol(node);
      if (bindings.has(sym))
        return mapValues(bindings.get(sym), bindings, seen);
      const decl = sym?.valueDeclaration;
      if (decl && ts.isVariableDeclaration(decl))
        return mapValues(decl.initializer, bindings, seen);
    }
    if (
      ts.isPropertyAccessExpression(node) ||
      ts.isElementAccessExpression(node)
    ) {
      const decl = symbol(node)?.valueDeclaration;
      if (
        decl &&
        (ts.isPropertyAssignment(decl) || ts.isVariableDeclaration(decl))
      )
        return mapValues(decl.initializer, bindings, seen);
    }
    if (
      ts.isParenthesizedExpression(node) ||
      ts.isAsExpression(node) ||
      ts.isSatisfiesExpression(node)
    )
      return mapValues(node.expression, bindings, seen);
    if (ts.isConditionalExpression(node))
      return [
        ...mapValues(node.whenTrue, bindings, seen),
        ...mapValues(node.whenFalse, bindings, seen),
      ];
    if (ts.isObjectLiteralExpression(node))
      return node.properties.flatMap((prop) =>
        ts.isPropertyAssignment(prop)
          ? [prop.initializer]
          : ts.isShorthandPropertyAssignment(prop)
            ? [prop.name]
            : ts.isSpreadAssignment(prop)
              ? mapValues(prop.expression, bindings, seen)
              : [],
      );
    if (ts.isArrayLiteralExpression(node)) return [...node.elements];
    return [];
  }
  function jsxProps(node, seen = new Set()) {
    if (!node || seen.has(node)) return;
    seen = new Set(seen).add(node);
    if (ts.isIdentifier(node)) {
      const decl = symbol(node)?.valueDeclaration;
      if (decl && ts.isVariableDeclaration(decl))
        jsxProps(decl.initializer, seen);
    } else if (
      ts.isParenthesizedExpression(node) ||
      ts.isAsExpression(node) ||
      ts.isSatisfiesExpression(node)
    )
      jsxProps(node.expression, seen);
    else if (ts.isConditionalExpression(node)) {
      jsxProps(node.whenTrue, seen);
      jsxProps(node.whenFalse, seen);
    } else if (ts.isObjectLiteralExpression(node)) {
      for (const prop of node.properties) {
        if (ts.isSpreadAssignment(prop)) jsxProps(prop.expression, seen);
        else if (
          ts.isPropertyAssignment(prop) ||
          ts.isShorthandPropertyAssignment(prop)
        ) {
          const name = ts.isComputedPropertyName(prop.name)
            ? staticText(prop.name.expression)
            : prop.name.text;
          if (/class(?:Name)?$/i.test(name ?? ""))
            collect(
              ts.isPropertyAssignment(prop) ? prop.initializer : prop.name,
              "jsx",
            );
        }
      }
    } else if (
      ts.isPropertyAccessExpression(node) ||
      ts.isElementAccessExpression(node)
    ) {
      const decl = symbol(node)?.valueDeclaration;
      if (
        decl &&
        (ts.isPropertyAssignment(decl) || ts.isVariableDeclaration(decl))
      )
        jsxProps(decl.initializer, seen);
      else if (ts.isElementAccessExpression(node))
        for (const value of mapValues(node.expression)) jsxProps(value, seen);
    }
  }
  function propertyName(node) {
    if (ts.isPropertyAccessExpression(node)) return node.name.text;
    if (ts.isElementAccessExpression(node))
      return staticText(node.argumentExpression);
    return undefined;
  }
  function markup(node, pieces = []) {
    if (ts.isStringLiteralLike(node)) return { text: node.text, pieces };
    if (ts.isTemplateExpression(node)) {
      let text = node.head.text;
      for (const span of node.templateSpans) {
        text += `__EXPR_${pieces.length}__${span.literal.text}`;
        pieces.push(span.expression);
      }
      return { text, pieces };
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.PlusToken
    ) {
      const left = markup(node.left, pieces);
      const right = markup(node.right, pieces);
      return { text: left.text + right.text, pieces };
    }
    const text = `__EXPR_${pieces.length}__`;
    pieces.push(node);
    return { text, pieces };
  }
  for (const file of program.getSourceFiles()) {
    function visit(node) {
      if (ts.isJsxSpreadAttribute(node)) jsxProps(node.expression);
      if (
        ts.isJsxAttribute(node) &&
        /class(?:Name)?$/i.test(node.name.getText()) &&
        node.initializer
      )
        collect(
          ts.isJsxExpression(node.initializer)
            ? node.initializer.expression
            : node.initializer,
          "jsx",
        );
      if (
        ts.isPropertyAssignment(node) &&
        /class(?:Name)?$/i.test(
          ts.isComputedPropertyName(node.name)
            ? (staticText(node.name.expression) ?? "")
            : node.name.getText().replace(/["']/g, ""),
        )
      )
        collect(node.initializer);
      if (
        ts.isBinaryExpression(node) &&
        ["class", "className"].includes(propertyName(node.left))
      )
        collect(node.right);
      if (
        ts.isCallExpression(node) &&
        (ts.isPropertyAccessExpression(node.expression) ||
          ts.isElementAccessExpression(node.expression))
      ) {
        const method = propertyName(node.expression);
        const receiver = node.expression.expression;
        if (
          propertyName(receiver) === "classList" &&
          ["add", "remove", "toggle", "contains", "replace"].includes(method)
        )
          node.arguments
            .slice(0, method === "toggle" ? 1 : undefined)
            .forEach((arg) => {
              collect(arg, method === "contains" ? "recognition" : "class");
            });
        if (
          ["querySelector", "querySelectorAll", "closest", "matches"].includes(
            method,
          )
        )
          collect(node.arguments[0], "selector");
        if (
          method === "setAttribute" &&
          staticText(node.arguments[0]) === "class"
        )
          collect(node.arguments[1]);
      }
      if (
        (ts.isStringLiteralLike(node) ||
          ts.isTemplateExpression(node) ||
          (ts.isBinaryExpression(node) &&
            node.operatorToken.kind === ts.SyntaxKind.PlusToken)) &&
        !(
          ts.isBinaryExpression(node.parent) &&
          node.parent.operatorToken.kind === ts.SyntaxKind.PlusToken
        )
      ) {
        const { text, pieces } = markup(node);
        for (const match of text.matchAll(/\bclass\s*=\s*["']([^"']*)["']/g)) {
          for (const token of match[1].trim().split(/\s+/)) {
            if (/^__EXPR_\d+__$/.test(token))
              collect(pieces[Number(token.match(/\d+/)[0])]);
            else if (token.includes("__EXPR_")) {
              if (!generatedToken(node, token, "html"))
                report(node, token, "html");
            } else report(node, token, "html");
          }
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(file);
  }
  return [...findings.values()];
}

export function ratchetClassStrings(findings, allowlist) {
  const counts = {};
  for (const row of findings) {
    const key = `${row.file}:${row.kind}:${row.name}`;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  const errors = [];
  for (const [key, entry] of Object.entries(allowlist))
    if (
      !Number.isInteger(entry.count) ||
      entry.count < 1 ||
      !entry.reason?.trim()
    )
      errors.push(`${key}: needs a positive count and reason`);
  for (const [key, count] of Object.entries(counts))
    if (count > (allowlist[key]?.count ?? 0))
      errors.push(`${key}: ${count} exceeds ${allowlist[key]?.count ?? 0}`);
  const stale = Object.keys(allowlist).filter(
    (key) => (counts[key] ?? 0) < allowlist[key].count,
  );
  const next = Object.fromEntries(
    Object.entries(allowlist)
      .filter(([key]) => counts[key])
      .map(([key, entry]) => [key, { ...entry, count: counts[key] }]),
  );
  return { errors, stale, next: errors.length ? allowlist : next };
}
