/**
 * Element-based button census (plan 182, family 1).
 *
 * The class census finds buttons by class name, so a button styled by a
 * class such as `.close` or by no class at all is invisible to it. This scan
 * parses every production TSX file under src/ with the TypeScript compiler
 * and reports each element that is or looks like a button:
 *
 * - every `<button>`, and every shared `Button`, `IconButton` or
 *   `ButtonBase`;
 * - every `<a>`, `<Link>` or `<label>` whose className names a button
 *   (`button`, `btn`) or calls `buttonClassName()`;
 * - every element with `role="button"`.
 *
 * Each row carries the file, line, the className expression as written and
 * the role, so a reader can tell a raw button from an option picker. The
 * playground's census page and the button ban (`pnpm buttons:check`) both
 * read this scan.
 */
import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import ts from "typescript";
import type { ButtonElement, ButtonElementKind } from "./buttonFamilies";

export type { ButtonElement, ButtonElementKind } from "./buttonFamilies";

const SHARED_TAGS = new Set(["Button", "IconButton", "ButtonBase"]);
const LINK_TAGS = new Set(["a", "Link", "NavLink"]);
const BUTTONISH = /button|btn/i;

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

function classify(
  tag: string,
  className: string | undefined,
  role: string | undefined,
): ButtonElementKind | undefined {
  if (tag === "button") return "raw";
  if (SHARED_TAGS.has(tag)) return "shared";
  if (role === "button") return "role-button";
  if (!className) return undefined;
  if (className.includes("buttonClassName(") && LINK_TAGS.has(tag))
    return "shared";
  if (!BUTTONISH.test(className)) return undefined;
  if (LINK_TAGS.has(tag)) return "link";
  if (tag === "label") return "label";
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
      const kind = classify(tag, className, role);
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

/** Every button-like element in the client's production TSX. */
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
