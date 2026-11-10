// @vitest-environment node

import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
} from "@playwright/test";
import katex from "katex";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { readClientStyles } from "./read-client-styles";

const semanticClipboardUrl = new URL(
  "../../lib/semanticHtmlClipboard.ts",
  import.meta.url,
);
const clipboardModifier = process.platform === "darwin" ? "Meta" : "Control";

let browser: Browser;
let context: BrowserContext;
let page: Page;
let server: Server;

describe("Markdown preview rich-text copy", () => {
  beforeAll(async () => {
    const css = await readClientStyles(
      "generated",
      "renderers",
      "../components/MarkdownPreview.module",
      "../components/renderers/CodeOutput.module",
    ).then((css) => css.replace(/:global\(([^()]*)\)/g, "$1"));
    const semanticClipboardJs = transpileModule(
      await readFile(semanticClipboardUrl, "utf8"),
      {
        compilerOptions: {
          module: ModuleKind.ES2022,
          target: ScriptTarget.ES2022,
        },
      },
    ).outputText;
    const mathHtml = katex.renderToString("x^2", {
      output: "htmlAndMathml",
      throwOnError: false,
    });
    server = createServer((request, response) => {
      if (request.url === "/semantic-html-clipboard.js") {
        response.setHeader("Content-Type", "text/javascript; charset=utf-8");
        response.end(semanticClipboardJs);
        return;
      }
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end(`<!doctype html>
        <style>
          :root {
            --bg-code: #181818;
            --bg-secondary: #202020;
            --border-color: #555;
            --markdown-preview-font-size-offset: 0px;
            --markdown-preview-vspace-offset: 0px;
            --output-prose-font-family: sans-serif;
            --output-prose-font-optical-sizing: auto;
            --output-prose-font-size: 14px;
            --output-prose-font-variation-settings: normal;
            --output-prose-line-height-offset: 0px;
            --output-prose-vspace-offset: 0px;
            --text-primary: #eeeeee;
          }
          ${css}
        </style>
        <div class="markdownPreview" data-markdown-preview>
          <div class="markdownRendered" data-markdown-rendered>
            <table><thead><tr><th>model</th><th>n</th></tr></thead></table>
            <p>Inline <code>code</code></p>
            <p class="math-preview">Value ${mathHtml}</p>
            <pre><code>block code</code></pre>
          </div>
        </div>
        <div class="fixedFontRenderToggle" data-fixed-font-render-toggle>
          <div class="fixedFontRenderedContent" data-fixed-font-rendered__content>
            <table class="fixed-font-markdown-table">
              <thead><tr class="fixed-font-diff-added"><th class="fixed-font-diff-gutter-cell">+</th><th>name</th><th>value</th></tr></thead>
              <tbody><tr class="fixed-font-diff-added"><td class="fixed-font-diff-gutter-cell">+</td><td>new</td><td>2</td></tr></tbody>
            </table>
          </div>
        </div>
        <div id="paste-target" contenteditable="true"></div>
        <script type="module">
          import { copySemanticHtmlSelectionToClipboard } from "/semantic-html-clipboard.js";
          const preview = document.querySelector("[data-markdown-preview]");
          const renderedDiff = document.querySelector("[data-fixed-font-render-toggle]");
          preview.addEventListener("copy", (event) => {
            copySemanticHtmlSelectionToClipboard(event, preview);
          });
          renderedDiff.addEventListener("copy", (event) => {
            copySemanticHtmlSelectionToClipboard(event, renderedDiff);
          });
          window.semanticCopyReady = true;
        </script>`);
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const { port } = server.address() as AddressInfo;

    browser = await chromium.launch({ chromiumSandbox: true });
    context = await browser.newContext({
      permissions: ["clipboard-read", "clipboard-write"],
    });
    page = await context.newPage();
    await page.goto(`http://127.0.0.1:${port}`);
    await page.waitForFunction(() =>
      Boolean(
        (window as typeof window & { semanticCopyReady?: boolean })
          .semanticCopyReady,
      ),
    );
  }, 30_000);

  afterAll(async () => {
    await context?.close();
    await browser?.close();
    await new Promise<void>((resolve, reject) => {
      server?.close((error) => (error ? reject(error) : resolve()));
    });
  });

  it("copies semantic HTML without changing the displayed dark theme", async () => {
    const displayedHeader = await page
      .locator("th")
      .first()
      .evaluate((node) => {
        const style = getComputedStyle(node);
        return { background: style.backgroundColor, color: style.color };
      });
    expect(displayedHeader).toEqual({
      background: "rgb(32, 32, 32)",
      color: "rgb(238, 238, 238)",
    });

    await page.locator("[data-markdown-rendered]").selectText();
    await page.keyboard.press(`${clipboardModifier}+c`);
    const copied = await page.evaluate(async () => {
      const item = (await navigator.clipboard.read())[0];
      if (!item) {
        throw new Error("Browser clipboard did not contain an item");
      }
      return {
        html: await (await item.getType("text/html")).text(),
        text: await (await item.getType("text/plain")).text(),
      };
    });

    expect(copied.html).toContain("<table>");
    expect(copied.html).toContain("<th>model</th>");
    expect(copied.html).not.toMatch(
      /\s(?:background|bgcolor|class|color|fill|style|stroke)=/i,
    );
    expect(copied.text).toContain("model");

    await page.locator("#paste-target").click();
    await page.keyboard.press(`${clipboardModifier}+v`);
    const pastedHtml = await page.locator("#paste-target").innerHTML();
    expect(pastedHtml).toContain("<table>");
    expect(pastedHtml).not.toMatch(
      /\s(?:background|bgcolor|class|color|fill|style|stroke)=/i,
    );

    const restoredHeader = await page
      .locator("th")
      .first()
      .evaluate((node) => {
        const style = getComputedStyle(node);
        return { background: style.backgroundColor, color: style.color };
      });
    expect(restoredHeader).toEqual(displayedHeader);
  });

  it("removes diff row and cell presentation from rendered table copies", async () => {
    await page.locator("#paste-target").evaluate((node) => {
      node.replaceChildren();
    });
    await page.locator(".fixed-font-markdown-table").selectText();
    await page.keyboard.press(`${clipboardModifier}+c`);
    const html = await page.evaluate(async () => {
      const item = (await navigator.clipboard.read())[0];
      if (!item) {
        throw new Error("Browser clipboard did not contain an item");
      }
      return (await item.getType("text/html")).text();
    });

    expect(html).toContain("<table>");
    expect(html).toContain("<th>name</th>");
    expect(html).toContain("<td>new</td>");
    expect(html).not.toMatch(
      /\s(?:background|bgcolor|class|color|fill|style|stroke)=/i,
    );

    await page.locator("#paste-target").click();
    await page.keyboard.press(`${clipboardModifier}+v`);
    const pastedHtml = await page.locator("#paste-target").innerHTML();
    expect(pastedHtml).toContain("<table>");
    expect(pastedHtml).not.toMatch(
      /\s(?:background|bgcolor|class|color|fill|style|stroke)=/i,
    );
  });

  it("copies KaTeX as one portable MathML branch", async () => {
    await page.locator(".math-preview").selectText();
    await page.keyboard.press(`${clipboardModifier}+c`);
    const html = await page.evaluate(async () => {
      const item = (await navigator.clipboard.read())[0];
      if (!item) {
        throw new Error("Browser clipboard did not contain an item");
      }
      return (await item.getType("text/html")).text();
    });

    expect(html).toContain("<math");
    expect(html).not.toContain("aria-hidden");
    expect(html).not.toContain("katex-html");
  });
});
