// @vitest-environment node

import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const stylesheetUrl = new URL(
  "../../layouts/NavigationLayout.module.css",
  import.meta.url,
);

function declarationsFor(css: string, selector: string): string {
  const declarations = new RegExp(
    `${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`,
  ).exec(css)?.[1];
  expect(
    declarations,
    `${selector} should have a dedicated CSS rule.`,
  ).toBeDefined();
  return declarations ?? "";
}

describe("minimized desktop sidebar CSS contract", () => {
  it("keeps the restore toggle out of layout flow", async () => {
    const css = await readFile(stylesheetUrl, "utf8");
    const restoreDeclarations = declarationsFor(css, ".sidebarFloatingRestore");

    // Fixed positioning is the contract: minimized mode reserves no layout
    // width (topics/ui-architecture.md § Desktop Sidebar Display Modes).
    // Exact insets and control sizes are styling, deliberately unasserted.
    expect(restoreDeclarations).toMatch(/position:\s*fixed\s*;/);
  });
});
