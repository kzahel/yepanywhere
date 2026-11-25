import { join } from "node:path";
import { expect, test as base, type Route } from "@playwright/test";
import { createTestViteServer } from "./support/vite-server.js";
import { recordUiCapture } from "./support/ui-capture.js";

const test = base.extend({
  // biome-ignore lint/correctness/noEmptyPattern: Playwright requires fixture destructuring.
  baseURL: async ({}, use) => {
    const source = await createTestViteServer({
      configFile: join(import.meta.dirname, "..", "vite.config.ts"),
      define: { __VITE_DEV_PORT__: "-1" },
      server: { host: "127.0.0.1" },
    });
    try {
      await source.listen();
      const address = source.httpServer?.address();
      if (!address || typeof address === "string")
        throw new Error("Missing Vite port");
      await use(`http://127.0.0.1:${address.port}`);
    } finally {
      await source.close();
    }
  },
});

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
  const provider = {
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
  };
  // The scenario controls the readiness reply while keeping the real New
  // Session page on a local, empty source.
  const responses = new Map<string, unknown>([
    ["/api/auth/status", { enabled: false, authenticated: true }],
    ["/api/settings", { settings: {} }],
    [
      "/api/version",
      {
        current: "0.9.4",
        capabilities: ["installed-machine-control"],
        serverRuntime: { kind: "node", version: process.versions.node },
      },
    ],
    ["/api/projects", { projects: [] }],
    ["/api/recents", { sessions: [] }],
    ["/api/providers", { providers: [provider] }],
    ["/api/providers/claude", { provider }],
    [
      "/api/providers/descriptors",
      {
        providers: [{ name: provider.name, displayName: provider.displayName }],
      },
    ],
    ["/api/providers/claude/subscription-usage", { usage: null }],
    ["/api/onboarding", { complete: true }],
    ["/api/project-templates/choices", { enabled: false, templates: [] }],
    ["/api/public-shares/status", { enabled: false, configured: false }],
    ["/api/processes", { processes: [], terminatedProcesses: [] }],
    ["/api/dev/status", null],
    [
      "/api/inbox",
      {
        needsAttention: [],
        active: [],
        recentActivity: [],
        unread8h: [],
        unread24h: [],
      },
    ],
  ]);
  await page.route(
    (url) => url.pathname.startsWith("/api/"),
    (route) => {
      const path = new URL(route.request().url()).pathname;
      return responses.has(path)
        ? route.fulfill({ json: responses.get(path) })
        : route.fulfill({ status: 404 });
    },
  );
  let resolveReadiness!: (route: Route) => void;
  const readiness = new Promise<Route>((resolve) => {
    resolveReadiness = resolve;
  });
  await page.route("**/api/machine-control", resolveReadiness);
  await page.routeWebSocket("**/api/ws", () => {});
  await page.goto(`${baseURL}/new-session`);
  const composer = page.locator("textarea[data-new-session-form-textarea]");
  // Windows CI 37098979286 exhausted 5s while the cold Vite graph and
  // initial API reads loaded; its failure snapshot then showed the composer.
  // Allow 3x that observed bound without changing the typing latency checks.
  await expect(composer).toBeVisible({ timeout: 15_000 });
  const request = await readiness;
  await composer.focus();
  const input = await composer.elementHandle();
  const message = "inspect the fixture with Machine Control";
  for (const [index, character] of [...message].entries()) {
    if (index === 12)
      await request.fulfill({ json: { available: true, version: "0.5.3" } });
    await page.keyboard.type(character);
    await expect(composer).toHaveValue(message.slice(0, index + 1));
  }
  expect(await input?.evaluate((node) => document.activeElement === node)).toBe(
    true,
  );
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
