// @vitest-environment node

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "@playwright/test";
import ts from "typescript";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createStaticRoutes } from "../../../../server/src/frontend/static";
import { cspPlugin } from "../../../vite-plugin-csp";

const evaluatorUrl = new URL("../browserDebugEval.ts", import.meta.url);

let browser: Browser;
let page: Page;
let server: Server;
let distPath: string;

describe("browser debug evaluation under the served-page CSP", () => {
  beforeAll(async () => {
    const source = await readFile(evaluatorUrl, "utf8");
    const compiled = ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
    }).outputText;
    const handler = (
      cspPlugin().transformIndexHtml as {
        handler: (html: string, context: { path: string }) => string;
      }
    ).handler;
    distPath = await mkdtemp(join(tmpdir(), "ya-debug-csp-"));
    await writeFile(
      join(distPath, "index.html"),
      handler(
        `<!doctype html>
        <html><head><title>diagnostic target</title></head>
        <body><main id="target"></main></body>
        <script>window.exports = {};${compiled}</script>
        <script>
          try {
            globalThis.eval("6 * 7");
            document.body.dataset.evalFailure = "none";
          } catch (error) {
            document.body.dataset.evalFailure =
              error instanceof Error ? error.name : String(error);
          }
        </script></html>`,
        { path: "/index.html" },
      ),
    );
    const app = createStaticRoutes({ distPath });
    server = createServer(async (request, response) => {
      const result = await app.request(request.url ?? "/");
      response.writeHead(result.status, Object.fromEntries(result.headers));
      response.end(Buffer.from(await result.arrayBuffer()));
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address() as AddressInfo;
    browser = await chromium.launch({ chromiumSandbox: true });
    page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${address.port}/`);
  });

  afterAll(async () => {
    await browser?.close();
    await new Promise<void>((resolve, reject) => {
      server?.close((error) => (error ? reject(error) : resolve()));
    });
    if (distPath) await rm(distPath, { recursive: true });
  });

  async function evaluate(code: string, timeoutMs?: number): Promise<unknown> {
    return page.evaluate(
      async ({ source, timeout }) => {
        const exported = (
          window as unknown as {
            exports: {
              executeBrowserDebugCode: (
                value: string,
                deadline?: number,
              ) => Promise<unknown>;
            };
          }
        ).exports;
        return exported.executeBrowserDebugCode(source, timeout);
      },
      { source: code, timeout: timeoutMs },
    );
  }

  it("executes expressions and promises while runtime compilation is denied", async () => {
    const evalFailure = await page
      .locator("body")
      .getAttribute("data-eval-failure");

    expect(evalFailure).toBe("EvalError");
    await page.evaluate(() => {
      const script = document.createElement("script");
      script.textContent = 'document.body.dataset.inlineRan = "yes"';
      document.head.append(script);
      script.remove();
    });
    expect(
      await page.locator("body").getAttribute("data-inline-ran"),
    ).toBeNull();
    await expect(evaluate("document.title")).resolves.toBe("diagnostic target");
    await expect(
      evaluate("Promise.resolve({ answer: 6 * 7 })"),
    ).resolves.toEqual({ answer: 42 });
  });

  it("falls back to statements and propagates mutations and errors", async () => {
    await expect(
      evaluate('document.body.dataset.diagnostic = "active";'),
    ).resolves.toBeUndefined();
    await expect(
      page.locator("body").getAttribute("data-diagnostic"),
    ).resolves.toBe("active");
    await expect(
      evaluate('throw new Error("diagnostic failure")'),
    ).rejects.toThrow("diagnostic failure");
  });

  it("deadlines a never-settling promise and removes its bridge", async () => {
    await expect(evaluate("new Promise(() => {})", 25)).rejects.toThrow(
      "exceeded its 25 ms local deadline",
    );
    await expect(evaluate("6 * 7", 100)).resolves.toBe(42);

    const retainedBridges = await page.evaluate(
      () =>
        Object.keys(globalThis).filter((key) =>
          key.startsWith("__YA_BROWSER_DEBUG_EVAL__"),
        ).length,
    );
    expect(retainedBridges).toBe(0);
    expect(
      await page.locator("script[data-ya-browser-debug-eval]").count(),
    ).toBe(0);
  });

  it("reports malformed code and blocked script loading distinctly", async () => {
    await expect(evaluate("const = ;")).rejects.toThrow("SyntaxError");
    await page.evaluate(() => {
      const meta = document.createElement("meta");
      meta.httpEquiv = "Content-Security-Policy";
      meta.content = "script-src 'self'";
      document.head.append(meta);
    });
    await expect(evaluate("1+1")).rejects.toThrow(
      "Content Security Policy must allow blob:",
    );
    expect(
      await page.locator("script[data-ya-browser-debug-eval]").count(),
    ).toBe(0);
  });
});
