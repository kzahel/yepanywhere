import { UI_KEYS } from "../src/lib/storageKeys";
import { expect, test } from "./fixtures.js";

test.use({ serviceWorkers: "block", viewport: { width: 1280, height: 800 } });

test("a fresh Settings window starts collapsed without changing the saved preference", async ({
  page,
  baseURL,
}) => {
  await page.addInitScript(
    (key) => localStorage.setItem(key, "true"),
    UI_KEYS.sidebarExpanded,
  );
  await page.goto(`${baseURL}/settings`);
  await expect(
    page.getByRole("searchbox", { name: "Search settings" }),
  ).toBeVisible();
  await expect(page.locator("[data-sidebar-desktop]")).toHaveClass(
    /sidebar-collapsed/,
  );
  expect(
    await page.evaluate(
      (key) => localStorage.getItem(key),
      UI_KEYS.sidebarExpanded,
    ),
  ).toBe("true");

  await page.goto(`${baseURL}/settings?sidebar=expanded`);
  await expect(page.locator("[data-sidebar-desktop]")).not.toHaveClass(
    /sidebar-collapsed/,
  );
});

test("Settings controls do not wait for sidebar sessions", async ({
  page,
  baseURL,
}) => {
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  let sessionsRequested = false;
  await page.route(/\/api\/sessions(?:\?|$)/, async (route) => {
    sessionsRequested = true;
    await blocked;
    await route.continue();
  });
  try {
    await page.goto(`${baseURL}/settings/appearance`, {
      waitUntil: "domcontentloaded",
    });
    await expect.poll(() => sessionsRequested).toBe(true);
    await expect(
      page.getByRole("searchbox", { name: "Search settings" }),
    ).toBeVisible();
    const light = page
      .locator("[data-settings-content-panel]")
      .getByRole("radio", { name: "Light", exact: true });
    await light.click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  } finally {
    release();
    await page.unrouteAll({ behavior: "wait" });
  }
});

test("search loads inactive panes without blocking existing editable results", async ({
  page,
  baseURL,
}) => {
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  let speechRequested = false;
  await page.route("**/*SpeechSettings*", async (route) => {
    speechRequested = true;
    await blocked;
    await route.continue();
  });
  try {
    await page.goto(`${baseURL}/settings/appearance`, {
      waitUntil: "domcontentloaded",
    });
    const search = page.getByRole("searchbox", { name: "Search settings" });
    await expect(search).toBeVisible();
    expect(speechRequested).toBe(false);
    await search.fill("theme");
    await expect.poll(() => speechRequested).toBe(true);
    const results = page.locator("[data-settings-search-results]");
    await expect(results).toHaveAttribute("aria-busy", "true");
    await results.getByRole("radio", { name: "Light", exact: true }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await search.fill("zzzz-no-such-setting");
    await expect(page.locator("[data-settings-search-empty]")).toHaveCount(0);
    release();
    await expect(results).toHaveAttribute("aria-busy", "false", {
      timeout: 15000,
    });
    await expect(page.locator("[data-settings-search-empty]")).toBeVisible();
    await search.fill("speech");
    await expect(
      results.locator('[data-category="speech"] [data-settings-item]').first(),
    ).toBeVisible();
  } finally {
    release();
    await page.unrouteAll({ behavior: "wait" });
  }
});
