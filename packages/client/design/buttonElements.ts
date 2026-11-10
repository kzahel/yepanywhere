/** Parser-backed raw-button and role=button scan used by buttons:check and Composer. */
import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import ts from "typescript";
export interface ButtonElement {
  file: string;
  line: number;
  tag: string;
  kind: "raw" | "role-button";
  className?: string;
  role?: string;
}

async function productionSources(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "__tests__")
        files.push(...(await productionSources(path)));
    } else if (
      entry.name.endsWith(".tsx") &&
      !/\.(?:test|specimen)\.tsx$/.test(entry.name)
    ) {
      files.push(path);
    }
  }
  return files;
}

function attribute(
  attributes: ts.JsxAttributes,
  name: string,
): ts.JsxAttribute | undefined {
  for (const property of attributes.properties) {
    if (
      ts.isJsxAttribute(property) &&
      ts.isIdentifier(property.name) &&
      property.name.text === name
    )
      return property;
  }
  return undefined;
}

function sourceText(
  node: ts.JsxAttribute | undefined,
  file: ts.SourceFile,
): string | undefined {
  const initializer = node?.initializer;
  if (!initializer) return undefined;
  if (ts.isStringLiteral(initializer)) return initializer.text;
  if (ts.isJsxExpression(initializer) && initializer.expression)
    return initializer.expression.getText(file).replace(/\s+/g, " ");
  return undefined;
}

export function scanButtonSource(file: string, text: string): ButtonElement[] {
  const source = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const found: ButtonElement[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = node.tagName.getText(source);
      const className = sourceText(
        attribute(node.attributes, "className"),
        source,
      );
      const roleAttribute = attribute(node.attributes, "role")?.initializer;
      const role =
        roleAttribute && ts.isStringLiteral(roleAttribute)
          ? roleAttribute.text
          : undefined;
      const shared =
        ["Button", "IconButton", "ButtonBase"].includes(tag) ||
        (["a", "Link", "NavLink"].includes(tag) &&
          className?.includes("buttonClassName("));
      const kind =
        tag === "button"
          ? "raw"
          : !shared && role === "button"
            ? "role-button"
            : undefined;
      if (kind) {
        found.push({
          file,
          line:
            source.getLineAndCharacterOfPosition(node.getStart(source)).line +
            1,
          tag,
          kind,
          ...(className === undefined ? {} : { className }),
          ...(role === undefined ? {} : { role }),
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/** Every raw button and role=button element in production TSX. */
export async function scanButtonElements(
  srcDir: string,
): Promise<ButtonElement[]> {
  const rows: ButtonElement[] = [];
  for (const path of (await productionSources(srcDir)).sort()) {
    const file = relative(srcDir, path).split(sep).join("/");
    rows.push(...scanButtonSource(file, await readFile(path, "utf8")));
  }
  return rows;
}
