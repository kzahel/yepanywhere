// @vitest-environment node

import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const blameViewStylesheetUrl = new URL(
  "../../pages/BlameView.module.css",
  import.meta.url,
);

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Match a selector by its tokens, so an assertion survives reformatting of the
 * stylesheet it reads and fails only when the selector itself changes.
 */
function selectorPattern(selector: string): string {
  return selector.trim().split(/\s+/).map(escapeRegExp).join("\\s+");
}

function getLastRuleDeclarations(css: string, selector: string): string {
  const matches = [
    ...css.matchAll(
      new RegExp(`${selectorPattern(selector)}\\s*\\{([^}]*)\\}`, "g"),
    ),
  ];
  expect(matches.length, `${selector} should have a CSS rule`).toBeGreaterThan(
    0,
  );
  return matches.at(-1)?.[1] ?? "";
}

describe("Source Control layout boundaries", () => {
  it("uses compact blame columns and one scrollbar per provenance run", async () => {
    // Provenance runs own horizontal scrolling; individual code cells do not.
    const css = await readFile(blameViewStylesheetUrl, "utf8");
    const row = getLastRuleDeclarations(css, ".row");
    const lineNumber = getLastRuleDeclarations(css, ".lineNumber");
    const code = getLastRuleDeclarations(css, ".code");
    const scrollRun = getLastRuleDeclarations(css, ".run.scrollable");

    expect(row).toContain("var(--blame-hash-column-width)");
    expect(row).toContain("var(--blame-line-number-column-width)");
    expect(row).toMatch(/minmax\(max-content,\s*1fr\)/);
    expect(row).not.toContain("44px");
    expect(lineNumber).toMatch(/text-align:\s*right\s*;/);
    expect(scrollRun).toMatch(/overflow-x:\s*auto\s*;/);
    expect(code).not.toMatch(/overflow-x:\s*auto\s*;/);
  });
});
