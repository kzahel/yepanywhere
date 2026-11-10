// @vitest-environment node

import { describe, expect, it } from "vitest";

import { readClientStyles } from "./read-client-styles";

const MINIMUM_SYNTAX_CONTRAST = 3.5;
const TOKEN_NAMES = [
  "foreground",
  "token-constant",
  "token-string",
  "token-comment",
  "token-keyword",
  "token-parameter",
  "token-function",
  "token-string-expression",
  "token-punctuation",
  "token-link",
  "token-deleted",
  "token-inserted",
] as const;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function getLastRuleDeclarations(css: string, selector: string): string {
  const matches = [
    ...css.matchAll(
      new RegExp(`${escapeRegExp(selector)}\\s*\\{([^}]*)\\}`, "g"),
    ),
  ];
  expect(matches.length, `${selector} should have a CSS rule`).toBeGreaterThan(
    0,
  );
  return matches.at(-1)?.[1] ?? "";
}

function readHexVariable(declarations: string, name: string): string {
  const match = declarations.match(
    new RegExp(`${escapeRegExp(name)}:\\s*(#[0-9a-fA-F]{6})\\s*;`),
  );
  expect(match, `${name} should be an opaque six-digit hex color`).toBeTruthy();
  return match?.[1] ?? "#000000";
}

function relativeLuminance(hex: string): number {
  const channels = [1, 3, 5].map((offset) => {
    const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return (
    0.2126 * (channels[0] ?? 0) +
    0.7152 * (channels[1] ?? 0) +
    0.0722 * (channels[2] ?? 0)
  );
}

function contrastRatio(left: string, right: string): number {
  const leftLuminance = relativeLuminance(left);
  const rightLuminance = relativeLuminance(right);
  return (
    (Math.max(leftLuminance, rightLuminance) + 0.05) /
    (Math.min(leftLuminance, rightLuminance) + 0.05)
  );
}

describe("diff syntax contrast", () => {
  it.each([
    ["very dark", '[data-theme="verydark"]'],
    ["dark and auto-dark", '[data-theme="dark"],\n[data-theme="auto"]'],
    ["light", '[data-theme="light"]'],
    ["auto-light", '[data-theme="auto"]'],
  ])(
    "keeps every %s token readable on added and removed lines",
    async (_theme, selector) => {
      const css = await readClientStyles("tokens");
      const declarations = getLastRuleDeclarations(css, selector);
      const backgrounds = [
        readHexVariable(declarations, "--bg-diff-added"),
        readHexVariable(declarations, "--bg-diff-removed"),
      ];

      for (const tokenName of TOKEN_NAMES) {
        const token = readHexVariable(
          declarations,
          `--diff-shiki-${tokenName}`,
        );
        for (const background of backgrounds) {
          expect(
            contrastRatio(token, background),
            `${tokenName} ${token} on ${background}`,
          ).toBeGreaterThanOrEqual(MINIMUM_SYNTAX_CONTRAST);
        }
      }

      expect(
        contrastRatio(
          readHexVariable(declarations, "--diff-gutter-added-foreground"),
          readHexVariable(declarations, "--bg-diff-gutter-added"),
        ),
        "added gutter glyph",
      ).toBeGreaterThanOrEqual(MINIMUM_SYNTAX_CONTRAST);
      expect(
        contrastRatio(
          readHexVariable(declarations, "--diff-gutter-removed-foreground"),
          readHexVariable(declarations, "--bg-diff-gutter-removed"),
        ),
        "removed gutter glyph",
      ).toBeGreaterThanOrEqual(MINIMUM_SYNTAX_CONTRAST);
    },
  );
});
