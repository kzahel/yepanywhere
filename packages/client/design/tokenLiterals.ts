/** Type/radius ownership: parse declarations and TSX style values, not source lines. */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import postcss from "postcss";
import ts from "typescript";

export interface TokenLiteral {
  file: string;
  line: number;
  property: string;
  value: string;
}
export interface TokenAllowance {
  count: number;
  reason: string;
}
export type TokenAllowlist = Record<string, TokenAllowance>;

const radius =
  /^border-(?:radius|(?:top|bottom)-(?:left|right)-radius|(?:start|end)-(?:start|end)-radius)$/;
const cssProperty = /^(?:font-size|font)$/;
const inlineProperty =
  /^(?:fontSize|font|borderRadius|border(?:Top|Bottom)(?:Left|Right)Radius|border(?:Start|End)(?:Start|End)Radius)$/;

/** Balanced function/string tokens preserve var fallbacks and shorthand line-height. */
function parts(value: string): string[] {
  const result: string[] = [];
  let depth = 0;
  let quote = "";
  let start = 0;
  for (let i = 0; i <= value.length; i++) {
    const ch = value[i] ?? " ";
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = "";
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (depth === 0 && /[\s/,]/.test(ch)) {
      if (i > start) result.push(value.slice(start, i));
      if (ch === "/" || ch === ",") result.push(ch);
      start = i + 1;
    }
  }
  return result;
}

/** Only the size part of font shorthand belongs to this check, not its line-height/family. */
function fontSize(value: string): string {
  if (/^(?:inherit|initial|unset)$/.test(value)) return value;
  const tokens = parts(value);
  const prefix =
    /^(?:normal|italic|oblique|small-caps|bold|bolder|lighter|[1-9]\d{0,2}(?:\.\d+)?|1000|(?:ultra-|extra-|semi-)?(?:condensed|expanded))$/i;
  for (let i = 0; i < tokens.length; i++) {
    const part = tokens[i] ?? "";
    if (prefix.test(part)) continue;
    if (
      i > 0 &&
      tokens[i - 1] === "oblique" &&
      /^-?[\d.]+(?:deg|grad|rad|turn)$/.test(part)
    )
      continue;
    // A stretch percentage precedes the actual size. A lone percentage is
    // itself a relative font size; never let stretch hide a following px/rem.
    if (/^[\d.]+%$/.test(part)) {
      const following = tokens
        .slice(i + 1)
        .find((token) => !prefix.test(token));
      if (
        following &&
        /^(?:[\d.]+(?:[a-z]+|%)|(?:var|calc|clamp|min|max)\(|(?:xx?-)?(?:small|large)|medium)/i.test(
          following,
        )
      )
        continue;
    }
    return part;
  }
  return value;
}

export function tokenValueAllowed(property: string, input: string): boolean {
  const isRadius = radius.test(property);
  let value = input
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\s*!important\s*$/i, "")
    .trim();
  if (property === "font") value = fontSize(value);
  if (/^(?:inherit|initial|unset|0)$/.test(value)) return true;
  // Percent radii need geometric evidence at the declaration (see scan below).
  if (isRadius && /^(?:50|100)%$/.test(value)) return true;
  const tokenName = isRadius ? /^--radius-[\w-]+$/ : /^--font-size-[\w-]+$/;
  function expression(text: string, math = false): boolean {
    let rest = text.trim();
    let seen = false;
    while (rest) {
      const fn = /^([\w-]+)\(/.exec(rest);
      if (fn) {
        let depth = 1;
        let end = fn[0].length;
        for (; end < rest.length && depth; end++) {
          if (rest[end] === "(") depth++;
          if (rest[end] === ")") depth--;
        }
        if (depth) return false;
        const body = rest.slice(fn[0].length, end - 1);
        if (fn[1] === "var") {
          const comma = body.indexOf(",");
          const name = (comma < 0 ? body : body.slice(0, comma)).trim();
          if (!tokenName.test(name)) return false;
          if (comma >= 0 && !expression(body.slice(comma + 1))) return false;
        } else if (/^(?:calc|clamp|min|max)$/.test(fn[1] ?? "")) {
          if (!expression(body, true)) return false;
        } else return false;
        rest = rest.slice(end).trimStart();
        seen = true;
        continue;
      }
      const number = /^([+-]?(?:\d*\.\d+|\d+)(?:e[+-]?\d+)?)([a-z%]*)/i.exec(
        rest,
      );
      if (number) {
        const [, numeric, unit] = number;
        if (
          unit
            ? isRadius || !/^(?:em|%)$/i.test(unit)
            : Number(numeric) !== 0 && !math
        )
          return false;
        rest = rest.slice(number[0].length).trimStart();
        seen = true;
      } else if (math && /^[+*/(),-]/.test(rest))
        rest = rest.slice(1).trimStart();
      else if (isRadius && rest.startsWith("/"))
        rest = rest.slice(1).trimStart();
      else return false;
    }
    return seen;
  }
  return expression(value);
}

/** A percentage is needed for circles/pills beyond the 999px token.
 * Ordinary circles/pills use --radius-full. Explicit source evidence is required
 * because a checker cannot infer responsive geometry from one declaration.
 */
function percentageGeometry(value: string, evidence: string): boolean {
  return (
    !/^(?:50|100)%$/.test(value.trim()) || /radius-percent:\s*\S/.test(evidence)
  );
}

export function analyzeTokenLiterals(
  file: string,
  text: string,
): TokenLiteral[] {
  const rows: TokenLiteral[] = [];
  if (file.endsWith(".module.css")) {
    postcss.parse(text, { from: file }).walkDecls((decl) => {
      const property = decl.prop.toLowerCase();
      if (!cssProperty.test(property) && !radius.test(property)) return;
      const evidence =
        decl.parent?.nodes
          ?.filter((node) => node.type === "comment")
          .map((node) => node.text)
          .join(" ") ?? "";
      if (
        !tokenValueAllowed(property, decl.value) ||
        !percentageGeometry(decl.value, evidence)
      )
        rows.push({
          file,
          line: decl.source?.start?.line ?? 1,
          property,
          value: decl.value,
        });
    });
  } else if (file.endsWith(".tsx")) {
    const source = ts.createSourceFile(
      file,
      text,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
    function literal(node: ts.Expression, property: string) {
      if (
        ts.isParenthesizedExpression(node) ||
        ts.isAsExpression(node) ||
        ts.isSatisfiesExpression(node)
      )
        literal(node.expression, property);
      else if (ts.isConditionalExpression(node)) {
        literal(node.whenTrue, property);
        literal(node.whenFalse, property);
      } else if (
        ts.isStringLiteralLike(node) ||
        ts.isNumericLiteral(node) ||
        (ts.isPrefixUnaryExpression(node) && ts.isNumericLiteral(node.operand))
      ) {
        const value = ts.isStringLiteralLike(node)
          ? node.text
          : node.getText(source);
        const css = property.replace(/[A-Z]/g, (ch) => `-${ch.toLowerCase()}`);
        const position = node.getStart(source);
        const evidence = text.slice(Math.max(0, position - 200), position);
        if (
          !tokenValueAllowed(
            css,
            value === "0"
              ? value
              : ts.isNumericLiteral(node)
                ? `${value}px`
                : value,
          ) ||
          !percentageGeometry(value, evidence)
        )
          rows.push({
            file,
            line:
              source.getLineAndCharacterOfPosition(node.getStart(source)).line +
              1,
            property,
            value,
          });
      }
    }
    function visit(node: ts.Node) {
      if (ts.isPropertyAssignment(node)) {
        const name =
          ts.isIdentifier(node.name) || ts.isStringLiteralLike(node.name)
            ? node.name.text
            : ts.isComputedPropertyName(node.name) &&
                ts.isStringLiteralLike(node.name.expression)
              ? node.name.expression.text
              : "";
        if (inlineProperty.test(name)) literal(node.initializer, name);
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  return rows;
}

export async function scanTokenLiterals(root: string): Promise<TokenLiteral[]> {
  const rows: TokenLiteral[] = [];
  async function walk(directory: string, prefix = "") {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = `${prefix}${entry.name}`;
      if (entry.isDirectory()) {
        if (!/^(?:__tests__|test|tests|node_modules)$/.test(entry.name))
          await walk(join(directory, entry.name), `${file}/`);
      } else if (
        /\.module\.css$|\.tsx$/.test(file) &&
        !/\.(?:test|spec|specimen)\.tsx$/.test(file)
      )
        rows.push(
          ...analyzeTokenLiterals(
            file,
            await readFile(join(directory, entry.name), "utf8"),
          ),
        );
    }
  }
  await walk(root);
  return rows.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

export function checkTokenAllowlist(
  rows: TokenLiteral[],
  allowlist: TokenAllowlist,
  record = false,
) {
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.file, (counts.get(row.file) ?? 0) + 1);
  const next: TokenAllowlist = {};
  const problems: string[] = [];
  for (const [file, entry] of Object.entries(allowlist)) {
    if (
      !entry ||
      !Number.isInteger(entry.count) ||
      entry.count < 1 ||
      typeof entry.reason !== "string" ||
      !entry.reason.trim()
    ) {
      problems.push(
        `${file}: exception needs a positive count and specific reason`,
      );
      counts.delete(file);
      continue;
    }
    const actual = counts.get(file) ?? 0;
    if (actual > entry.count)
      problems.push(
        `${file}: ${actual} literals exceed ${entry.count} (${entry.reason})`,
      );
    if (actual < entry.count && !record)
      problems.push(
        `${file}: ${actual} literals remain, recorded ${entry.count}; run tokens:check --record`,
      );
    if (actual)
      next[file] = {
        count: Math.min(actual, entry.count),
        reason: entry.reason,
      };
    counts.delete(file);
  }
  for (const [file, count] of counts)
    problems.push(`${file}: ${count} literals without a reviewed exception`);
  return { problems, next };
}
