/**
 * Static index of the design playground's example files.
 *
 * Parses each *.specimen.tsx with the TypeScript compiler rather than
 * importing it, so listing needs no browser, bundler or CSS loader. The ids
 * use the same rules as the playground (design/specimen.ts), so every `href`
 * here opens the matching page on any dev server.
 *
 *   pnpm -s design:index            JSON: titles, layers, states and URLs
 */
import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import {
  DESIGN_LAYERS,
  type DesignLayer,
  stateId,
  stateName,
  toId,
} from "../design/specimen";

export const clientRoot = fileURLToPath(new URL("..", import.meta.url));

export interface IndexedState {
  id: string;
  name: string;
  export: string;
  href: string;
}

export interface IndexedSpecimen {
  id: string;
  title: string;
  layer: DesignLayer;
  file: string;
  href: string;
  states: IndexedState[];
}

async function specimenFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await specimenFiles(path)));
    else if (entry.name.endsWith(".specimen.tsx")) files.push(path);
  }
  return files;
}

function unwrap(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isSatisfiesExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isParenthesizedExpression(current)
  )
    current = current.expression;
  return current;
}

function property(
  object: ts.ObjectLiteralExpression,
  name: string,
): ts.Expression | undefined {
  for (const member of object.properties) {
    if (
      ts.isPropertyAssignment(member) &&
      (ts.isIdentifier(member.name) || ts.isStringLiteral(member.name)) &&
      member.name.text === name
    )
      return unwrap(member.initializer);
  }
  return undefined;
}

function isExported(node: ts.Node): boolean {
  return (
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node) ?? []).some(
      (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
    )
  );
}

export function parseSpecimen(
  file: string,
  text: string,
): Omit<IndexedSpecimen, "file"> {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  let title: string | undefined;
  let layer: string | undefined;
  const exports: string[] = [];
  const storyNames = new Map<string, string>();
  for (const statement of source.statements) {
    if (ts.isExportAssignment(statement) && !statement.isExportEquals) {
      const meta = unwrap(statement.expression);
      if (!ts.isObjectLiteralExpression(meta)) continue;
      const titleNode = property(meta, "title");
      if (titleNode && ts.isStringLiteralLike(titleNode))
        title = titleNode.text;
      const parameters = property(meta, "parameters");
      if (parameters && ts.isObjectLiteralExpression(parameters)) {
        const layerNode = property(parameters, "layer");
        if (layerNode && ts.isStringLiteralLike(layerNode))
          layer = layerNode.text;
      }
    } else if (
      ts.isFunctionDeclaration(statement) &&
      statement.name &&
      isExported(statement)
    ) {
      exports.push(statement.name.text);
    } else if (ts.isVariableStatement(statement) && isExported(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        const initializer =
          declaration.initializer && unwrap(declaration.initializer);
        if (
          ts.isIdentifier(declaration.name) &&
          initializer &&
          (ts.isArrowFunction(initializer) ||
            ts.isFunctionExpression(initializer))
        )
          exports.push(declaration.name.text);
      }
    } else if (
      ts.isExpressionStatement(statement) &&
      ts.isBinaryExpression(statement.expression) &&
      statement.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken
    ) {
      const { left, right } = statement.expression;
      if (
        ts.isPropertyAccessExpression(left) &&
        ts.isIdentifier(left.expression) &&
        left.name.text === "storyName" &&
        ts.isStringLiteralLike(right)
      )
        storyNames.set(left.expression.text, right.text);
    }
  }
  if (!title || !DESIGN_LAYERS.includes(layer as DesignLayer))
    throw new Error(
      `${file}: a specimen's default export needs a literal title and parameters.layer`,
    );
  const id = toId(title);
  return {
    id,
    title,
    layer: layer as DesignLayer,
    href: `design.html#/${id}`,
    states: exports.map((exportName) => {
      const state = stateId(id, exportName);
      return {
        id: state,
        name: storyNames.get(exportName) ?? stateName(exportName),
        export: exportName,
        href: `design.html#/${state}?iso`,
      };
    }),
  };
}

export async function loadDesignIndex(root = clientRoot) {
  const files = [
    ...(await specimenFiles(join(root, "src"))),
    ...(await specimenFiles(join(root, "design"))),
  ];
  const specimens: IndexedSpecimen[] = [];
  for (const path of files) {
    const file = relative(root, path).split(sep).join("/");
    specimens.push({
      ...parseSpecimen(file, await readFile(path, "utf8")),
      file,
    });
  }
  specimens.sort(
    (a, b) =>
      DESIGN_LAYERS.indexOf(a.layer) - DESIGN_LAYERS.indexOf(b.layer) ||
      a.title.localeCompare(b.title),
  );
  return { format: "ya-design-index", version: 1, specimens };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("-h") || process.argv.includes("--help")) {
    process.stdout.write(
      "Usage: pnpm -s design:index\n\nPrint the design playground's specimens, states and their design.html URLs as JSON.\n",
    );
  } else {
    process.stdout.write(
      `${JSON.stringify(await loadDesignIndex(), null, 2)}\n`,
    );
  }
}
