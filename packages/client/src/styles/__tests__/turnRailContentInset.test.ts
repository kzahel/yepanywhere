// @vitest-environment node

import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import { readClientStyles } from "./read-client-styles";

const renderersStylesheetUrl = new URL("../renderers.css", import.meta.url);
const turnRailStylesheetUrl = new URL(
  "../../components/UserTurnNavigator.module.css",
  import.meta.url,
);

describe("turn rail horizontal clearance CSS contract", () => {
  it("grows linearly to measured separation at 1600px without a sidebar step", async () => {
    const [css, renderersCss, turnRailCss] = await Promise.all([
      readClientStyles("tokens", "index"),
      readFile(renderersStylesheetUrl, "utf8"),
      readFile(turnRailStylesheetUrl, "utf8"),
    ]);

    expect(css).toMatch(
      /--turn-rail-content-padding-inline-end:\s*clamp\(\s*12px,\s*calc\(1vw \+ 6px\),\s*22px\s*\)\s*;/,
    );
    expect(css).toMatch(
      /--turn-rail-float-inset-inline-end:\s*max\(\s*2px,\s*calc\(24px - var\(--turn-rail-content-padding-inline-end\)\)\s*\)\s*;/,
    );
    expect(css).toMatch(
      /\.session-messages\s*\{[^}]*padding-inline-end:\s*var\(--turn-rail-content-padding-inline-end\)\s*;/s,
    );
    expect(css).toMatch(
      /\.session-header-inner\s*\{[^}]*padding:\s*calc\(0\.5rem - 1px\) 1rem calc\(0\.5rem - 1px\) 0\.25rem;/s,
    );
    expect(css).toMatch(
      /--composer-window-padding-inline:\s*clamp\(\s*2px,\s*calc\(0\.6vw - 1\.6px\),\s*8px\s*\)\s*;/,
    );
    expect(css).toMatch(
      /\.session-input\s*\{[^}]*padding:\s*calc\(0\.75rem - 1px\) var\(--composer-window-padding-inline\);/s,
    );
    expect(css).toContain(
      ".session-messages {\n    padding: 0.5rem 0.375rem;\n    padding-inline-end: var(--turn-rail-content-padding-inline-end);",
    );
    expect(css).toMatch(
      /\.user-prompt-actions\s*\{[^}]*inset-inline-end:\s*var\(--turn-rail-float-inset-inline-end\)\s*;/s,
    );
    expect(css).toMatch(
      /\.user-prompt-container\s*\{[^}]*--user-prompt-actions-space:\s*calc\([^}]*--user-prompt-action-columns[^}]*min-height:\s*calc\([^}]*--user-prompt-action-rows/s,
    );
    expect(css).toMatch(
      /\.user-prompt-actions\s*\{[^}]*grid-template-columns:\s*repeat\(\s*var\(--user-prompt-action-columns\)/s,
    );
    const userPromptActionsRule = css.match(
      /\.user-prompt-actions\s*\{[^}]*\}/s,
    );
    expect(userPromptActionsRule?.[0]).not.toContain("pointer-events: none");
    expect(css).toMatch(
      /\.session-messages\s*\{[^}]*scrollbar-gutter:\s*auto;[^}]*scrollbar-width:\s*none;/s,
    );
    expect(css).toMatch(
      /\.session-input\s*\{\s*padding:\s*0\.5rem 0\.375rem;\s*padding-bottom:\s*calc\(0\.5rem - 1px\);/s,
    );
    expect(turnRailCss).toMatch(/\.trimMarker\s*\{[^}]*right:\s*1px;/s);
    expect(turnRailCss).toMatch(/\.trimDot\s*\{[^}]*right:\s*1px;/s);
    expect(renderersCss).toMatch(
      /\.assistant-turn \.text-block-actions\s*\{[^}]*margin-inline-end:\s*var\(--turn-rail-float-inset-inline-end\)\s*;/s,
    );
    expect(css).not.toContain("padding-right: calc(1rem + min(30px, 2vw));");
  });
});
