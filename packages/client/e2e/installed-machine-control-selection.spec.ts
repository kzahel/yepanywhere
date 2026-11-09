import { join } from "node:path";
import { expect, test as base, type Route } from "@playwright/test";
import { createTestViteServer } from "./support/vite-server.js";
import {
  startYaServerProcess,
  disposeYaServerProcess,
} from "./support/ya-server-process.js";
import { recordUiCapture } from "./support/ui-capture.js";

// Own the same portable source server used by the former computer-control
// browser gate. Full-suite global setup is not needed for this one case.
const test = base.extend({
  baseURL: [
    // biome-ignore lint/correctness/noEmptyPattern: Playwright requires fixture destructuring.
    async ({}, use) => {
      const backend = await startYaServerProcess({
        label: "installed MC",
        // GitHub's pwsh module path can shadow Windows PowerShell's Security
        // module, which the server needs for owner-only ACL checks.
        env:
          process.platform === "win32"
            ? {
                PSModulePath: join(
                  process.env.SystemRoot ?? "C:\\Windows",
                  "System32/WindowsPowerShell/v1.0/Modules",
                ),
              }
            : {},
      });
      let source: Awaited<ReturnType<typeof createTestViteServer>> | undefined;
      try {
        source = await createTestViteServer({
          configFile: join(import.meta.dirname, "..", "vite.config.ts"),
          define: { __VITE_DEV_PORT__: "-1" },
          server: {
            port: 0,
            strictPort: false,
            host: "127.0.0.1",
            proxy: { "/api": { target: backend.baseUrl, ws: true } },
          },
        });
        await source.listen();
        const address = source.httpServer?.address();
        if (!address || typeof address === "string")
          throw new Error("Missing Vite port");
        await use(`http://127.0.0.1:${address.port}`);
      } finally {
        try {
          await source?.close();
        } finally {
          await disposeYaServerProcess(backend);
        }
      }
    },
    // Preserve the former cross-platform gate's startup/cleanup allowance.
    { scope: "test", timeout: 180_000 },
  ],
});

// Browser-only offer/typing boundary: no native MC operation or model turn.
test.use({ serviceWorkers: "block" });

test("installed MC readiness preserves typing and its selected affordance at desktop and phone widths", async ({
  page,
  baseURL,
}) => {
  // The composer alone may take 15s on a cold CI start (below), the config's
  // whole-test default. Linux CI 37270062285 reached it after 5.6s, typed
  // the message, then ran out of test time at the next click.
  test.setTimeout(45_000);
  await page.setViewportSize({ width: 1000, height: 600 });
  await page.addInitScript(() => {
    const samples: number[] = [];
    let keyAt = 0;
    document.addEventListener(
      "keydown",
      () => {
        keyAt = performance.now();
      },
      true,
    );
    document.addEventListener(
      "input",
      () => {
        samples.push(performance.now() - keyAt);
      },
      true,
    );
    Object.assign(window, { mcTypingSamples: samples });
  });
  await page.route("**/api/providers", (route) =>
    route.fulfill({
      json: {
        providers: [
          {
            name: "claude",
            displayName: "Claude",
            installed: true,
            authenticated: true,
            enabled: true,
            models: [
              { id: "opus", name: "Opus" },
              ...Array.from({ length: 200 }, (_, index) => ({
                id: `model-${index}`,
                name: `Model ${index}`,
              })),
            ],
          },
        ],
      },
    }),
  );
  let resolveReadiness!: (route: Route) => void;
  const readiness = new Promise<Route>((resolve) => {
    resolveReadiness = resolve;
  });
  await page.route("**/api/machine-control", resolveReadiness);
  await page.goto(`${baseURL}/new-session`);
  const composer = page.locator("textarea.new-session-form-textarea");
  // Windows CI 37098979286 exhausted 5s while the cold Vite graph and
  // initial API reads loaded; its failure snapshot then showed the composer.
  // Allow 3x that observed bound without changing the typing latency checks.
  await expect(composer).toBeVisible({ timeout: 15_000 });
  const request = await readiness;
  await composer.focus();
  const message = "inspect the fixture with Machine Control";
  for (const [index, character] of [...message].entries()) {
    if (index === 12)
      await request.fulfill({ json: { available: true, version: "0.5.3" } });
    await page.keyboard.type(character);
    await expect(composer).toHaveValue(message.slice(0, index + 1));
  }
  const samples = await page.evaluate(
    () => (window as unknown as { mcTypingSamples: number[] }).mcTypingSamples,
  );
  expect(samples).toHaveLength(message.length);
  expect(Math.max(...samples)).toBeLessThan(100);
  await page
    .getByRole("button", { name: "Advanced options", exact: false })
    .click();
  await page.getByRole("button", { name: "Show option explanations" }).click();
  const control = page
    .getByRole("heading", { name: "Machine Control", exact: true })
    .locator("..");
  await expect(control).toContainText("Off");
  await control
    .getByRole("button", { name: "Filter by Machine Control" })
    .click();
  await page.getByRole("menuitemradio", { name: "On", exact: true }).click();
  await expect(control).toContainText("On");
  await expect(control).toContainText(
    "closing this session does not revoke it.",
  );
  await expect(page.getByText("Server changed", { exact: false })).toHaveCount(
    0,
  );
  await control.scrollIntoViewIfNeeded();
  await recordUiCapture(page, "installed-mc-desktop", {
    width: 1000,
    height: 600,
  });
  await page.setViewportSize({ width: 375, height: 812 });
  await control.scrollIntoViewIfNeeded();
  await expect(control).toBeVisible();
  await recordUiCapture(page, "installed-mc-phone", {
    width: 375,
    height: 812,
  });
});
