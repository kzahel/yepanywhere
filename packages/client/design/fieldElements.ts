/**
 * Element-based field census (plan 182, family 4).
 *
 * Parses every production TSX file under src/ with the TypeScript compiler
 * and reports each raw `<input>`, `<select>` and `<textarea>`, with its
 * type as written. Inputs that are not text fields or choices (range,
 * file, hidden, color, and the button-like types) are reported with
 * `field: false`; the field ban (`pnpm buttons:check`, rule 7) counts the
 * rest outside the shared field controls.
 */
import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import ts from "typescript";

export interface FieldElement {
  /** Path relative to src/, with forward slashes. */
  file: string;
  line: number;
  tag: "input" | "select" | "textarea";
  /** The type attribute as written: a literal, or the expression's text. */
  type?: string;
  /** False for inputs that are not fields (range, file, hidden, …). */
  field: boolean;
}

const NOT_FIELD_TYPES = new Set([
  "range",
  "file",
  "hidden",
  "color",
  "submit",
  "button",
  "reset",
  "image",
]);

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

export function scanFieldSource(file: string, text: string): FieldElement[] {
  const source = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const found: FieldElement[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = node.tagName.getText(source);
      if (tag === "input" || tag === "select" || tag === "textarea") {
        let type: string | undefined;
        let literal = false;
        for (const property of node.attributes.properties) {
          if (
            !ts.isJsxAttribute(property) ||
            property.name.getText(source) !== "type"
          )
            continue;
          const initializer = property.initializer;
          if (initializer && ts.isStringLiteral(initializer)) {
            type = initializer.text;
            literal = true;
          } else if (
            initializer &&
            ts.isJsxExpression(initializer) &&
            initializer.expression
          ) {
            type = initializer.expression.getText(source);
            literal = ts.isStringLiteral(initializer.expression);
            if (literal)
              type = (initializer.expression as ts.StringLiteral).text;
          }
        }
        found.push({
          file,
          line:
            source.getLineAndCharacterOfPosition(node.getStart(source)).line +
            1,
          tag,
          ...(type === undefined ? {} : { type }),
          field: !(tag === "input" && literal && NOT_FIELD_TYPES.has(type!)),
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/** Every raw input, select and textarea in the client's production TSX. */
export async function scanFieldElements(
  srcDir: string,
): Promise<FieldElement[]> {
  const rows: FieldElement[] = [];
  for (const path of (await productionSources(srcDir)).sort()) {
    const file = relative(srcDir, path).split(sep).join("/");
    rows.push(...scanFieldSource(file, await readFile(path, "utf8")));
  }
  return rows;
}
