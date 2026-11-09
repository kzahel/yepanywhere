import { expect, test } from "./fixtures.js";
import { recordUiCapture } from "./support/ui-capture.js";

test.use({ draftSessionIds: [], serviceWorkers: "block" });

test("provider selector is usable before aggregate discovery finishes", async ({
  page,
}) => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let aggregateStarted = false;
  await page.route(/\/api\/providers(?:\?.*)?$/, async (route) => {
    aggregateStarted = true;
    await held;
    await route.continue();
  });
  try {
    await page.goto("/new-session");
    const selector = page.locator(".new-session-provider-section button");
    await expect(selector).toContainText("Claude");
    expect(aggregateStarted).toBe(true);
    await selector.click();
    await expect(
      page.getByRole("menu").getByRole("menuitemradio", { name: /^pi\b/i }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    const field = page.locator(".new-session-form textarea");
    // Worker-owned services retain earlier cases' server drafts. This case
    // measures discovery/input independence, not draft recovery.
    await field.fill("");
    await field.click();
    let typed = "";
    for (const character of "provider discovery is pending") {
      typed += character;
      await field.pressSequentially(character);
      await expect(field).toHaveValue(typed, { timeout: 100 });
    }
    for (const viewport of [
      { width: 1000, height: 600 },
      { width: 375, height: 812 },
    ]) {
      await page.setViewportSize(viewport);
      await recordUiCapture(page, `provider-descriptors-${viewport.width}`);
    }
  } finally {
    release();
  }
});
