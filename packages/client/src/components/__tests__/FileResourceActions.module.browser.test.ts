// @vitest-environment node

import { fileURLToPath } from "node:url";
import { chromium, type Browser } from "@playwright/test";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createTestViteServer } from "../../../e2e/support/vite-server";

let browser: Browser | undefined;
let vite: Awaited<ReturnType<typeof createTestViteServer>> | undefined;
let origin: string;
let html: string;

beforeAll(async () => {
  vite = await createTestViteServer({
    root: fileURLToPath(new URL("../../../", import.meta.url)),
    server: { host: "127.0.0.1", port: 0 },
  });
  await vite.listen();
  const address = vite.httpServer?.address();
  if (!address || typeof address === "string") {
    throw new Error("Missing module-test Vite port");
  }
  origin = `http://127.0.0.1:${address.port}`;
  html = await vite.transformIndexHtml(
    "/module-test.html",
    `<!doctype html><title>Native module loading</title><body></body>
    <script type="module">
      const query = new URLSearchParams(location.search);
      const entries = {
        "/src/api/fileClient.ts": () => import("/src/api/fileClient.ts"),
        "/src/components/ArtifactPreview.tsx": () => import("/src/components/ArtifactPreview.tsx"),
      };
      entries[query.get("entry")]().then(
        (module) => { document.body.dataset.result = typeof module[query.get("export")]; },
        (error) => { document.body.dataset.result = String(error); },
      );
    </script>`,
  );
  browser = await chromium.launch({ chromiumSandbox: true });
  // CI 36665933364 measured a 6.6s cold Vite fixture boot; allow 4x that
  // observed startup without making initialization order a timing assertion.
}, 30_000);

afterAll(async () => {
  const results = await Promise.allSettled([browser?.close(), vite?.close()]);
  for (const result of results) {
    if (result.status === "rejected") throw result.reason;
  }
});

it.each([
  { entry: "/src/api/fileClient.ts", exported: "fileApi", type: "object" },
  {
    entry: "/src/components/ArtifactPreview.tsx",
    exported: "ArtifactPreview",
    type: "function",
  },
])(
  "loads $entry without preloading the app API entry",
  async ({ entry, exported, type }) => {
    const page = await browser!.newPage();
    try {
      await page.route(
        (url) =>
          url.pathname === "/module-test.html" &&
          !url.searchParams.has("html-proxy"),
        (route) => route.fulfill({ contentType: "text/html", body: html }),
      );
      const query = new URLSearchParams({ entry, export: exported });
      await page.goto(`${origin}/module-test.html?${query}`);
      // A native ESM entry exposes temporal-dead-zone errors hidden by Vitest's
      // transformed imports and component mocks. No YA services are required.
      await page.waitForFunction(
        () => document.body.dataset.result !== undefined,
      );
      const result = await page.locator("body").getAttribute("data-result");
      expect(result).toBe(type);
    } finally {
      await page.close();
    }
  },
  // The same cold dependency graph is loaded here; use its measured budget.
  30_000,
);
