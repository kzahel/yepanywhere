// @vitest-environment node

import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const stylesheetUrl = new URL(
  "../../layouts/MainContent.module.css",
  import.meta.url,
);

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function readStylesheet(): Promise<string> {
  return (await readFile(stylesheetUrl, "utf8")).replace(
    /:global\(([^)]+)\)/g,
    "$1",
  );
}

function getRuleDeclarations(css: string, selector: string): string {
  const match = new RegExp(
    `${selector.trim().split(/\s+/).map(escapeRegExp).join("\\s+")}\\s*\\{([^}]*)\\}`,
  ).exec(css);
  expect(
    match,
    `${selector} should have a dedicated rule in index.css so the content-width preference is hard to audit.`,
  ).not.toBeNull();
  return match?.[1] ?? "";
}

function expectNormalSessionSelectorUsesContentWidth(
  css: string,
  selector: string,
): void {
  const declarations = getRuleDeclarations(css, selector);
  expect(
    declarations,
    `${selector} must respect --content-max-width; otherwise Appearance > Max Content Width becomes a no-op on main sessions.`,
  ).toMatch(/max-width:\s*var\(--content-max-width\)\s*;/);
  expect(
    declarations,
    `${selector} must not widen normal sessions with max-width: none. Keep any wide exception scoped to .session-split-with-aside.`,
  ).not.toMatch(/max-width:\s*none\s*;/);
}

describe("session content width CSS contract", () => {
  it("keeps normal desktop sessions bound to the content-width preference", async () => {
    const css = await readStylesheet();

    expectNormalSessionSelectorUsesContentWidth(
      css,
      ".mainContentConstrained .session-messages [data-message-list]",
    );
    expectNormalSessionSelectorUsesContentWidth(
      css,
      ".mainContentConstrained .session-input-inner",
    );
  });

  it("keeps the narrow sidebar/mobile shell bound to the content-width preference", async () => {
    const css = await readStylesheet();
    const declarations = getRuleDeclarations(
      css,
      ".mainContentMobileInner .session-input-inner,\n.mainContentMobileInner .session-messages [data-message-list]",
    );

    expect(
      declarations,
      "The <1100px shell is also used when the sidebar leaves desktop mode; main sessions must still honor Appearance > Max Content Width there.",
    ).toMatch(/max-width:\s*var\(--content-max-width\)\s*;/);
    expect(
      declarations,
      "The <1100px shell must not widen normal sessions with max-width: none.",
    ).not.toMatch(/max-width:\s*none\s*;/);
  });

  it("keeps the /btw split-pane full-track exception explicit", async () => {
    const css = await readStylesheet();
    const splitOverride =
      /\.mainContentConstrained\s+\.session-split\.session-split-with-aside\s*>\s*\[data-session-read-scope\]\s+\[data-message-list\],\s*\.mainContentConstrained\s+\.session-split\.session-split-with-aside\s*>\s*\[data-session-input\]\s+\.session-input-inner\s*\{[^}]*max-width:\s*none\s*;/m;

    expect(
      css,
      "If /btw split sessions should stop using the full available track, update this guard with the new intentional contract.",
    ).toMatch(splitOverride);
  });
});
