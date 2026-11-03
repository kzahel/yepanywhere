// @vitest-environment node

import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { chromium, type Browser, type Page } from "@playwright/test";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const selectionTransferUrl = new URL(
  "../editSelectionTransfer.ts",
  import.meta.url,
);

let browser: Browser;
let page: Page;
let server: Server;

describe("Edit preview selection transfer", () => {
  beforeAll(async () => {
    const selectionTransferJs = transpileModule(
      await readFile(selectionTransferUrl, "utf8"),
      {
        compilerOptions: {
          module: ModuleKind.ES2022,
          target: ScriptTarget.ES2022,
        },
      },
    ).outputText;
    server = createServer((request, response) => {
      if (request.url === "/edit-selection-transfer.js") {
        response.setHeader("Content-Type", "text/javascript; charset=utf-8");
        response.end(selectionTransferJs);
        return;
      }
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end(`<!doctype html>
        <div id="preview">
          <div class="fixed-font-render-toggle" data-render-mode="rendered">
            <div>-old text</div>
            <div>+<strong id="selection-start">selected</strong><span id="selection-end"> replacement text</span></div>
            <span>+5</span>
          </div>
        </div>
        <div id="modal" hidden>
          <button>Close</button>
          <div class="fixed-font-render-toggle" data-render-mode="rendered">
            <div>-old text</div>
            <div>+<strong>selected</strong><span> replacement text</span></div>
            <div>+later expanded line</div>
          </div>
        </div>
        <script type="module">
          import { captureDiffSelection, restoreDiffSelection } from "/edit-selection-transfer.js";
          const preview = document.querySelector("#preview");
          const modal = document.querySelector("#modal");
          preview.addEventListener("click", () => {
            const snapshot = captureDiffSelection(preview);
            if (!snapshot) return;
            modal.hidden = false;
            requestAnimationFrame(() => {
              window.transferSucceeded = restoreDiffSelection(modal, snapshot);
            });
          });
          window.selectionTransferReady = true;
        </script>`);
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const { port } = server.address() as AddressInfo;
    browser = await chromium.launch({ chromiumSandbox: true });
    page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${port}`);
    await page.waitForFunction(() =>
      Boolean(
        (window as typeof window & { selectionTransferReady?: boolean })
          .selectionTransferReady,
      ),
    );
  }, 30_000);

  afterAll(async () => {
    await browser?.close();
    await new Promise<void>((resolve, reject) => {
      server?.close((error) => (error ? reject(error) : resolve()));
    });
  });

  it("recreates the selected range in the expanded DOM", async () => {
    await page.evaluate(() => {
      const start = document.querySelector("#selection-start")?.firstChild;
      const end = document.querySelector("#selection-end")?.firstChild;
      const preview = document.querySelector<HTMLElement>("#preview");
      if (!start || !end || !preview) throw new Error("Fixture is incomplete");

      const range = document.createRange();
      range.setStart(start, 0);
      range.setEnd(end, " replacement".length);
      const selection = document.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      preview.click();
    });

    await page.waitForFunction(
      () =>
        (window as typeof window & { transferSucceeded?: boolean })
          .transferSucceeded === true,
    );
    const restored = await page.evaluate(() => {
      const modal = document.querySelector("#modal");
      const selection = document.getSelection();
      return {
        insideModal: Boolean(
          modal &&
            selection?.anchorNode &&
            modal.contains(selection.anchorNode),
        ),
        text: selection?.toString(),
      };
    });

    expect(restored).toEqual({
      insideModal: true,
      text: "selected replacement",
    });
  });
});
