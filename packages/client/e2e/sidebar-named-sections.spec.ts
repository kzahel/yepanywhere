import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { readCollectionsOverRest } from "./support/managed-routes";
import { recordUiCapture } from "./support/ui-capture";
import { createTestViteServer } from "./support/vite-server";
import {
  disposeYaServerProcess,
  startYaServerProcess,
} from "./support/ya-server-process";

test.use({ serviceWorkers: "block" });

// Named sections list their sessions however old: a limited user's session
// beyond the recent page arrives through the categorized feed, and sessions an
// API client created file under that client's section, closed by default.
test("sidebar lists limited-user and API-client sections past the recent page", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const projectPath = dirname(dirname(fileURLToPath(import.meta.url)));
  const backend = await startYaServerProcess({ label: "sidebar sections" });
  const source = await createTestViteServer({
    configFile: join(projectPath, "vite.config.ts"),
    define: { __VITE_DEV_PORT__: "-1" },
    server: {
      port: 0,
      strictPort: false,
      host: "127.0.0.1",
      proxy: { "/api": { target: backend.baseUrl, ws: true } },
    },
  });
  const projectId = Buffer.from(projectPath).toString("base64url");
  const now = Date.now();
  const row = (
    id: string,
    title: string,
    ageMs: number,
    fields: { createdByUser?: string; apiClient?: string } = {},
  ) => ({
    id,
    title,
    fullTitle: title,
    projectId,
    projectName: "Sidebar test",
    provider: "claude",
    activity: "idle",
    ownership: { owner: "none" },
    createdAt: new Date(now - ageMs).toISOString(),
    updatedAt: new Date(now - ageMs).toISOString(),
    isStarred: false,
    messageCount: 1,
    ...fields,
  });
  const recent = [
    row("named-a", "Hand-started work", 60_000),
    row("named-harness-1", "Harness trial 1", 120_000, {
      apiClient: "learn-harness",
    }),
    row("named-harness-2", "Harness trial 2", 180_000, {
      apiClient: "learn-harness",
    }),
  ];
  // Forty days old: off the recent page, reachable only by its section's feed.
  const limitedOld = row("named-carol", "Carol's old session", 40 * 86400000, {
    createdByUser: "carol",
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await readCollectionsOverRest(page);
  await page.route("**/api/version*", async (route) => {
    const payload = await (await route.fetch()).json();
    for (const key of Object.keys(payload))
      if (key.toLowerCase().includes("capabilit")) delete payload[key];
    return route.fulfill({
      json: {
        ...payload,
        current: "0.11.0",
        latest: null,
        updateAvailable: false,
        capabilities: [
          "sidebar-session-snapshot",
          "sidebar-session-categories",
          "progressive-session-catalog",
        ],
      },
    });
  });
  await page.route(/\/api\/sessions(?:\?|$)/, (route) => {
    const query = new URL(route.request().url()).searchParams;
    const sessions =
      query.get("starred") === "true"
        ? []
        : query.get("categorized") === "true"
          ? [...recent, limitedOld].filter(
              (session) => "apiClient" in session || "createdByUser" in session,
            )
          : recent;
    return route.fulfill({
      json: {
        sessions,
        hasMore: false,
        total: sessions.length,
        catalog: {
          complete: true,
          refreshing: false,
          catalogEpoch: "test",
          catalogGeneration: 1,
        },
      },
    });
  });
  await page.route(/\/api\/sessions\/sidebar(?:\?|$)/, () => {
    throw Error("Unqualified snapshot cutover");
  });
  await page.route(/\/api\/projects\/[^/]+\/sessions\/named-a(?:\?|$)/, (r) =>
    r.fulfill({
      json: {
        session: recent[0],
        messages: [{ uuid: "opening", type: "user", content: "Hello." }],
        ownership: { owner: "none" },
      },
    }),
  );
  await page.route(/\/api\/sessions\/named-a\/process$/, (route) =>
    route.fulfill({ json: { process: null } }),
  );
  try {
    await source.listen();
    const address = source.httpServer?.address();
    if (!address || typeof address === "string")
      throw new Error("Missing Vite port");
    const origin = `http://127.0.0.1:${address.port}`;
    for (const viewport of [
      { name: "desktop", width: 1000, height: 600 },
      { name: "phone", width: 375, height: 812 },
    ]) {
      await page.setViewportSize(viewport);
      await page.goto(`${origin}/projects/${projectId}/sessions/named-a`);
      await page.evaluate(() =>
        localStorage.removeItem("yep-anywhere-sidebar-section-expansion"),
      );
      await page.reload();
      await expect(page.locator("[data-composer-input]")).toBeVisible({
        timeout: 30_000,
      });
      await page
        .getByRole("button", { name: "Open sidebar", exact: true })
        .click();
      const sidebar = page.locator("[data-sidebar]:visible");
      const link = (id: string) =>
        sidebar.locator(
          `a[data-session-list-item__link][href*="/sessions/${id}"]`,
        );
      await expect(link("named-a")).toHaveCount(1);
      await expect(link("named-carol")).toHaveCount(1);
      const harness = sidebar.locator(
        'button[aria-controls="sidebar-group-api%3Alearn-harness"]',
      );
      await expect(harness).toHaveAttribute("aria-expanded", "false");
      await expect(link("named-harness-1")).toHaveCount(0);
      await recordUiCapture(
        page,
        `sidebar-sections-${viewport.name}`,
        viewport,
      );
      await harness.click();
      await expect(harness).toHaveAttribute("aria-expanded", "true");
      await expect(link("named-harness-1")).toHaveCount(1);
      await expect(link("named-harness-2")).toHaveCount(1);
      await expect(
        sidebar.locator(
          '#sidebar-last-24-hours-list a[href*="/sessions/named-harness-1"]',
        ),
      ).toHaveCount(0);
    }
    expect(errors).toEqual([]);
  } finally {
    await source.close();
    await disposeYaServerProcess(backend);
  }
});
