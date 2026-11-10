// @vitest-environment node

import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const blameViewStylesheetUrl = new URL(
  "../../pages/BlameView.module.css",
  import.meta.url,
);

const rendererStylesheetUrl = new URL("../renderers.css", import.meta.url);
const sourceModeTabsStylesheetUrl = new URL(
  "../../pages/SourceModeTabs.module.css",
  import.meta.url,
);
const tabsStylesheetUrl = new URL(
  "../../components/ui/Tabs.module.css",
  import.meta.url,
);
const sourceModeTabsSourceUrl = new URL(
  "../../pages/SourceModeTabs.tsx",
  import.meta.url,
);
const gitStatusPageStylesheetUrl = new URL(
  "../../pages/GitStatusPage.module.css",
  import.meta.url,
);
const commitHistoryParentLinkStylesheetUrl = new URL(
  "../../pages/CommitHistoryParentLink.module.css",
  import.meta.url,
);
const sourceContextMenuStylesheetUrl = new URL(
  "../../components/SourceContextMenu.module.css",
  import.meta.url,
);
const sourceFileRowStylesheetUrl = new URL(
  "../../components/SourceFileRow.module.css",
  import.meta.url,
);
const searchMatchTextStylesheetUrl = new URL(
  "../../components/SearchMatchText.module.css",
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

function getRuleDeclarationsContaining(
  css: string,
  selector: string,
  needle: string,
): string {
  const matches = [
    ...css.matchAll(
      new RegExp(`${selectorPattern(selector)}\\s*\\{([^}]*)\\}`, "g"),
    ),
  ].filter((match) => match[1]?.includes(needle));
  expect(
    matches.length,
    `${selector} should have a CSS rule containing ${needle}`,
  ).toBeGreaterThan(0);
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
  it("keeps the authored diff gutter compact", async () => {
    const css = await readFile(rendererStylesheetUrl, "utf8");
    const diff = getRuleDeclarationsContaining(
      css,
      ".diff-gutter-aligned",
      "--diff-gutter-width",
    );

    expect(diff).toMatch(/--diff-gutter-width:\s*1rem\s*;/);
    expect(diff).toMatch(/--diff-line-inline-inset:\s*0\.375rem\s*;/);
    expect(diff).toMatch(/--diff-gutter-content-gap:\s*0\.375rem\s*;/);
  });
  it("places repository actions by measured demand with a full-row fallback", async () => {
    const css = await readFile(gitStatusPageStylesheetUrl, "utf8");
    const header = getLastRuleDeclarations(
      css,
      ".sourceHeader :global(.session-header-inner)",
    );
    const identity = getLastRuleDeclarations(
      css,
      ".sourceHeader :global(.session-header-left)",
    );
    const actions = getLastRuleDeclarations(
      css,
      ".sourceHeader :global(.session-header-actions)",
    );
    const titleActions = getLastRuleDeclarations(
      css,
      ".headerControls.titleRow",
    );
    const tabs = getRuleDeclarationsContaining(css, ".headerTabs", "order: 2");
    const fallbackActions = getLastRuleDeclarations(
      css,
      ".headerControls.fallbackRow",
    );
    const fallbackTabs = getLastRuleDeclarations(
      css,
      ".headerControls.fallbackRow + .headerTabs",
    );

    expect(header).toMatch(/flex-wrap:\s*wrap\s*;/);
    expect(identity).toMatch(/flex:\s*0\s+1\s+auto\s*;/);
    expect(actions).toMatch(/display:\s*contents\s*;/);
    expect(titleActions).toMatch(/order:\s*1\s*;/);
    expect(tabs).toMatch(/order:\s*2\s*;/);
    expect(tabs).toMatch(/margin-left:\s*auto\s*;/);
    expect(fallbackActions).toMatch(/flex:\s*1\s+0\s+100%\s*;/);
    expect(fallbackActions).toMatch(/order:\s*2\s*;/);
    expect(fallbackTabs).toMatch(/order:\s*1\s*;/);
  });
  it("keeps the unified Changes revision control usable at phone width", async () => {
    const [
      sourceModeTabsCss,
      tabsCss,
      sourceModeTabsSource,
      commitHistoryParentLinkCss,
      gitStatusPageCss,
    ] = await Promise.all([
      readFile(sourceModeTabsStylesheetUrl, "utf8"),
      readFile(tabsStylesheetUrl, "utf8"),
      readFile(sourceModeTabsSourceUrl, "utf8"),
      readFile(commitHistoryParentLinkStylesheetUrl, "utf8"),
      readFile(gitStatusPageStylesheetUrl, "utf8"),
    ]);
    // `SourceModeTabs` owns the stacked phone layout: `variant="stacked"`
    // picks the shared Tabs `fill-phone` layout (equal, wrapping columns at
    // phone width only; content-sized tabs on desktop) plus a full-width row.
    const mobileTabs = getLastRuleDeclarations(sourceModeTabsCss, ".stacked");
    const phoneMedia = tabsCss.match(
      /@media\s*\(width\s*<=\s*760px\)\s*\{([\s\S]*?\})\s*\}/,
    )?.[1];
    const phoneTab = getLastRuleDeclarations(
      phoneMedia ?? "",
      ".fillPhone > .fillTab",
    );
    const desktopTabs = tabsCss.replace(phoneMedia ?? "", "");
    const historyParentLink = getLastRuleDeclarations(
      commitHistoryParentLinkCss,
      ".link",
    );
    const actionGroup = getLastRuleDeclarations(
      gitStatusPageCss,
      ".actionGroup",
    );
    const checkRemote = getRuleDeclarationsContaining(
      gitStatusPageCss,
      ".headerControls.fallbackRow .checkRemote .actionLabel",
      "text-overflow",
    );

    expect(sourceModeTabsSource).toMatch(
      /layout=\{variant === "stacked" \? "fill-phone" : "inline"\}/,
    );
    expect(mobileTabs).toMatch(/box-sizing:\s*border-box\s*;/);
    expect(mobileTabs).toMatch(/width:\s*100%\s*;/);
    expect(phoneTab).toMatch(/flex:\s*1 1 0\s*;/);
    expect(phoneTab).toMatch(/min-width:\s*0\s*;/);
    expect(phoneTab).toMatch(/white-space:\s*normal\s*;/);
    expect(desktopTabs).not.toMatch(/\.fillPhone/);
    expect(getLastRuleDeclarations(tabsCss, ".label")).not.toMatch(
      /text-overflow/,
    );
    expect(actionGroup).not.toMatch(/1fr/);
    expect(checkRemote).toMatch(/min-width:\s*0\s*;/);
    expect(checkRemote).toMatch(/text-overflow:\s*ellipsis\s*;/);
    expect(historyParentLink).toMatch(/display:\s*inline-flex\s*;/);
    expect(historyParentLink).not.toMatch(/width:\s*100%\s*;/);
  });
  it("uses the full desktop row width while keeping path matches visible", async () => {
    const [menuCss, pathCss, matchCss] = await Promise.all([
      readFile(sourceContextMenuStylesheetUrl, "utf8"),
      readFile(sourceFileRowStylesheetUrl, "utf8"),
      readFile(searchMatchTextStylesheetUrl, "utf8"),
    ]);
    const rowSurface = getLastRuleDeclarations(menuCss, ".rowSurface");
    const desktopTrigger = getRuleDeclarationsContaining(
      menuCss,
      ".trigger",
      "position: absolute",
    );
    const mobileTrigger = getLastRuleDeclarations(menuCss, ".trigger");
    const path = getRuleDeclarationsContaining(
      pathCss,
      ".path",
      "flex: 1 1 auto",
    );
    const matchedPath = getLastRuleDeclarations(pathCss, ".pathWithMatch");
    const match = getLastRuleDeclarations(matchCss, ".match");

    expect(rowSurface).toMatch(/position:\s*relative\s*;/);
    expect(desktopTrigger).toMatch(/position:\s*absolute\s*;/);
    expect(desktopTrigger).toMatch(/inset-inline-end:\s*0\s*;/);
    expect(mobileTrigger).toMatch(/position:\s*static\s*;/);
    expect(path).toMatch(/flex:\s*1\s+1\s+auto\s*;/);
    expect(matchedPath).toMatch(/display:\s*flex\s*;/);
    expect(match).toMatch(/flex:\s*0\s+0\s+auto\s*;/);
  });
});
