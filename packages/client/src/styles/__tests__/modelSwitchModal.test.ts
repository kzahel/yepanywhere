// @vitest-environment node

import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const stylesheetUrl = new URL(
  "../../components/ModelSwitchModal.module.css",
  import.meta.url,
);

describe("model switch modal CSS contract", () => {
  it("keeps one modal scroller with sticky tabs", async () => {
    const css = await readFile(stylesheetUrl, "utf8");
    const tabs = /\.modelSwitchTabs\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";

    expect(tabs).toMatch(/position:\s*sticky\s*;/);
    expect(tabs).toMatch(/top:\s*0\s*;/);
    expect(tabs).toMatch(/background:\s*var\(--bg-surface\)\s*;/);
  });
});
