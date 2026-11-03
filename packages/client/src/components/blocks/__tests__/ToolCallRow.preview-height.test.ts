// @vitest-environment node

import { readFile } from "node:fs/promises";
import { chromium, type Browser, type Page } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { estimateDeferredPreviewHeightPx } from "../ToolCallRow";

let browser: Browser;
let page: Page;
let rendererCss = "";
let toolRowsCss = "";

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function copyButton(label: string): string {
  return `<button type="button" class="bash-section-copy" aria-label="${label}">
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
      <rect x="5" y="5" width="8" height="8" rx="1.5"></rect>
    </svg>
  </button>`;
}

async function measureHydratedPreviewHeightPx({
  output,
  rowWidthPx,
}: {
  output: string;
  rowWidthPx: number;
}): Promise<number> {
  await page.setViewportSize({
    width: Math.max(480, rowWidthPx + 80),
    height: 600,
  });
  await page.setContent(`
    <style>
      :root {
        --font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        --font-size-xs: 10px;
        --font-size-sm: 12px;
        --font-size-base: 13px;
        --tab-size: 2;
      }
      [data-theme="verydark"] {
        --app-yep-green: #059669;
        --bg-code: #1f1f1f;
        --bg-surface: #181818;
        --bg-hover: #2a2d2e;
        --border-color: #3a3a3a;
        --border-subtle: #2f2f2f;
        --border-input: #555;
        --border-strong: #555;
        --focus-border: #007acc;
        --text-primary: #e6e6e6;
        --text-secondary: #bcbcbc;
        --text-muted: #9a9a9a;
        --error-color: #f14c4c;
        color: var(--text-primary);
      }
      * {
        box-sizing: border-box;
      }
      body {
        margin: 0;
        font-family: var(--font-sans);
      }
      ${rendererCss}
      ${toolRowsCss}
    </style>
    <div data-theme="verydark">
      <div class="tool-row timeline-item status-complete" style="width: ${rowWidthPx}px">
        <div class="tool-row-collapsed-preview">
          <div class="bash-collapsed-preview" role="button" tabindex="0">
            ${
              output
                ? `<div class="bash-preview-row bash-preview-output-row">
                    <div class="bash-preview-output">
                      <div class="fixed-font-render-toggle">
                        <pre>${escapeHtml(output)}</pre>
                      </div>
                    </div>
                    ${copyButton("Copy output")}
                  </div>`
                : `<div class="bash-preview-row">
                    <span class="bash-preview-empty">No output</span>
                  </div>`
            }
          </div>
        </div>
      </div>
    </div>
  `);

  return page.locator(".tool-row-collapsed-preview").evaluate((element) => {
    return element.getBoundingClientRect().height;
  });
}

describe("deferred Bash preview height estimator", () => {
  beforeAll(async () => {
    [rendererCss, toolRowsCss] = await Promise.all([
      readFile(
        new URL("../../../styles/renderers.css", import.meta.url),
        "utf8",
      ),
      readFile(
        new URL("../../../styles/tool-rows.css", import.meta.url),
        "utf8",
      ),
    ]);
    browser = await chromium.launch({ chromiumSandbox: true });
    page = await browser.newPage();
  });

  afterAll(async () => {
    await page?.close();
    await browser?.close();
  });

  it("stays within empirical bounds of hydrated CSS preview height", async () => {
    const fixtures = [
      {
        name: "empty output",
        command: "true",
        output: "",
        rowWidthPx: 760,
      },
      {
        name: "single line",
        command: "echo ok",
        output: "ok",
        rowWidthPx: 760,
      },
      {
        name: "wrapped narrow output",
        command: "printf long",
        output: "x".repeat(180),
        rowWidthPx: 280,
      },
      {
        name: "wrapped wide output",
        command: "printf long",
        output: "x".repeat(180),
        rowWidthPx: 1000,
      },
      {
        name: "max-height capped output",
        command: "cat big.log",
        output: Array.from({ length: 40 }, (_, index) => `line ${index}`).join(
          "\n",
        ),
        rowWidthPx: 760,
      },
    ];

    const errors = [];
    for (const fixture of fixtures) {
      const estimate = estimateDeferredPreviewHeightPx({
        toolName: "Bash",
        toolInput: { command: fixture.command },
        result: { stdout: fixture.output, stderr: "" },
        status: "complete",
        rowWidthPx: fixture.rowWidthPx,
      });
      expect(estimate, fixture.name).not.toBeNull();

      const actual = await measureHydratedPreviewHeightPx(fixture);
      errors.push({
        name: fixture.name,
        estimate: estimate as number,
        actual,
        underBy: actual - (estimate as number),
        overBy: (estimate as number) - actual,
      });
    }

    const maxUnderPx = Math.max(...errors.map((error) => error.underBy));
    const maxOverPx = Math.max(...errors.map((error) => error.overBy));
    const meanAbsoluteErrorPx =
      errors.reduce(
        (total, error) => total + Math.abs(error.estimate - error.actual),
        0,
      ) / errors.length;
    const errorDetails = JSON.stringify(errors, null, 2);

    expect(maxUnderPx, errorDetails).toBeLessThanOrEqual(4);
    expect(maxOverPx, errorDetails).toBeLessThanOrEqual(4);
    expect(meanAbsoluteErrorPx, errorDetails).toBeLessThanOrEqual(2);
  }, 30_000);
});
