// @vitest-environment node

import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const stylesheetUrl = new URL(
  "../../components/ConversationActivity.module.css",
  import.meta.url,
);
const renderItemModuleUrl = new URL(
  "../../components/RenderItemComponent.module.css",
  import.meta.url,
);

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function readStylesheet(): Promise<string> {
  return readFile(stylesheetUrl, "utf8");
}

function getRuleDeclarations(css: string, selector: string): string {
  const match = new RegExp(
    `${selector.trim().split(/\s+/).map(escapeRegExp).join("\\s+")}\\s*\\{([^}]*)\\}`,
  ).exec(css);
  expect(
    match,
    `${selector} should have a dedicated rule in ConversationActivity.module.css.`,
  ).not.toBeNull();
  return match?.[1] ?? "";
}

describe("conversation preview height contract", () => {
  it("caps the current thinking preview to a viewport fraction and scrolls past it", async () => {
    const css = await readStylesheet();
    const declarations = getRuleDeclarations(
      css,
      ".conversationThinkingPreviewContent",
    );
    // Viewport-relative cap (contains vh, not a fixed pixel budget) so the
    // preceding non-thinking turn keeps space; overflow scrolls internally.
    // This is the measurement source, so it must NOT depend on the published
    // height — see topics/responsive-layout-gaps.md.
    expect(
      declarations,
      "current thinking preview must cap its height relative to the viewport, not a fixed px",
    ).toMatch(/max-height:[^;]*vh[^;]*;/);
    expect(declarations).toMatch(/overflow:\s*auto\s*;/);
  });

  it("caps the recent-activity list to the published thinking height and clips overflow", async () => {
    const css = await readStylesheet();
    const declarations = getRuleDeclarations(
      css,
      ".conversationRecentActivities",
    );
    // Never exceed the space the current thinking block requests: bound to the
    // measured --conversation-thinking-height, with a viewport-relative fallback
    // before the first measurement. Clips the oldest rows rather than showing a
    // fixed count.
    expect(
      declarations,
      "recent-activity list must cap to the published thinking height",
    ).toMatch(/max-height:\s*var\(\s*--conversation-thinking-height/);
    expect(declarations).toMatch(/overflow:\s*hidden\s*;/);
  });

  it("fades the activity list's clipped bottom edge instead of a hard cut", async () => {
    const css = await readStylesheet();
    const declarations = getRuleDeclarations(
      css,
      ".conversationRecentActivities[data-is-clipped]",
    );
    // A bottom mask gradient fades the oldest (clipped) rows; applied only under
    // .is-clipped so a fully-fitting list is not faded.
    expect(
      declarations,
      "clipped activity list must fade its bottom edge via a mask gradient",
    ).toMatch(/mask-image:\s*linear-gradient\([^;]*transparent[^;]*\)\s*;/);
  });

  it("caps the previous preview to the current height: min(current, previous)", async () => {
    const css = await readStylesheet();
    const match =
      /\.conversationThinkingPreview\[data-preview-slot="previous"\]\s*\.conversationThinkingPreviewContent\s*\{([^}]*)\}/.exec(
        css,
      );
    expect(
      match,
      "previous preview content should have a dedicated cap rule in ConversationActivity.module.css",
    ).not.toBeNull();
    const declarations = match?.[1] ?? "";
    // height(previous) = min(natural, current): capping to the current height
    // keeps the current block owning the row height, so the previous preview
    // disappearing at turn end causes no shrink (no autofollow flicker).
    expect(
      declarations,
      "previous preview must cap to the published current thinking height",
    ).toMatch(/max-height:\s*var\(\s*--conversation-thinking-height/);
  });

  it("bounds a wrapped previous preview by the measured room left in the viewport", async () => {
    const css = await readFile(renderItemModuleUrl, "utf8");
    const match =
      /\.activityHeightReserve\[data-previous-thinking="stacked"\][^{]*\{([^}]*)\}/.exec(
        css,
      );
    expect(
      match,
      "a wrapped previous preview should have its own cap rule in RenderItemComponent.module.css",
    ).not.toBeNull();
    const declarations = match?.[1] ?? "";
    // Wrapped, the previous card's height adds to the row instead of fitting
    // inside the current card's, so it takes the smaller of the current height
    // and the measured remaining budget.
    expect(declarations).toMatch(/var\(\s*--conversation-thinking-height/);
    expect(declarations).toMatch(
      /var\(\s*--conversation-previous-thinking-budget/,
    );
    expect(declarations).toMatch(/max-height:\s*min\(/);
  });

  it("collapses a dropped previous preview without removing it from the layout", async () => {
    const css = await readFile(renderItemModuleUrl, "utf8");
    const match =
      /\.activityHeightReserve\[data-previous-thinking="dropped"\][^{]*\{([^}]*)\}/.exec(
        css,
      );
    expect(
      match,
      "a dropped previous preview should have its own rule in RenderItemComponent.module.css",
    ).not.toBeNull();
    const declarations = match?.[1] ?? "";
    // Zero height rather than `display: none`: removing the flex item would
    // change the wrap the budget was measured from and the drop would flap.
    expect(declarations).toMatch(/height:\s*0\s*;/);
    expect(declarations).toMatch(/visibility:\s*hidden\s*;/);
    expect(declarations).not.toMatch(/display:\s*none/);
  });

  it("uses leftover width for activities while keeping the summary pill intrinsic", async () => {
    const css = await readStylesheet();
    const rowDeclarations = getRuleDeclarations(
      css,
      ".conversationActivityRow.is-wide-activity-previews",
    );
    expect(rowDeclarations).toMatch(/justify-content:\s*flex-end\s*;/);

    const columnDeclarations = getRuleDeclarations(
      css,
      ".conversationActivityRow.is-wide-activity-previews\n  > .conversationActivityColumn",
    );
    expect(columnDeclarations).toMatch(/max-width:\s*100%\s*;/);
    expect(columnDeclarations).toMatch(/flex:\s*1 1 12rem\s*;/);

    const activityDeclarations = getRuleDeclarations(
      css,
      ".conversationActivityRow.is-wide-activity-previews\n  .conversationRecentActivities",
    );
    expect(activityDeclarations).toMatch(/width:\s*100%\s*;/);
    expect(activityDeclarations).toMatch(/min-width:\s*0\s*;/);

    const summaryDeclarations = getRuleDeclarations(
      css,
      ".conversationActivitySummary",
    );
    expect(summaryDeclarations).toMatch(/display:\s*inline-flex\s*;/);
    expect(summaryDeclarations).not.toMatch(/(?:^|\n)\s*width:\s*100%\s*;/);
  });
});
