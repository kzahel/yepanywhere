import { expect, test } from "./fixtures.js";
import { recordUiCapture } from "./support/ui-capture.js";

test("selecting a settings category clears the search", async ({
  page,
  baseURL,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`${baseURL}/settings`);

  const skipOnboarding = page.locator(".onboarding-skip-all");
  if (await skipOnboarding.isVisible()) {
    await skipOnboarding.click();
  }

  const search = page.getByRole("searchbox", { name: "Search settings" });
  await expect(search).toBeVisible();
  await search.fill("theme");
  await expect(search).toHaveValue("theme");

  await page
    .locator(".settings-category-nav")
    .getByRole("button", { name: /Speech backends/ })
    .click();

  await expect(page).toHaveURL(/\/settings\/speech$/);
  await expect(search).toHaveValue("");
});

for (const viewport of [
  { width: 1000, height: 600 },
  { width: 375, height: 812 },
]) {
  test(`search results save and navigate safely at ${viewport.width}px`, async ({
    page,
    baseURL,
  }) => {
    await page.setViewportSize(viewport);
    await page.goto(`${baseURL}/settings`);
    const search = page.getByRole("searchbox", { name: "Search settings" });
    await search.fill("theme");
    const theme = page.locator('[data-settings-item="theme"]');
    await theme.getByRole("radio", { name: "Dark", exact: true }).click();
    await expect(search).toHaveValue("theme");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await theme.locator("strong").click();
    await expect(page).toHaveURL(/\/settings\/appearance$/);
    await expect(theme).toHaveClass(/settings-item--jump-flash/);

    await page.goto(`${baseURL}/settings`);
    await search.fill("Webhook URL");
    const input = page.getByRole("textbox", {
      name: "Webhook URL",
      exact: true,
    });
    const save = page.getByRole("button", { name: "Save", exact: true });
    await expect(save).toBeVisible();
    const original = await input.inputValue();
    const value = `https://example.test/settings-search-${viewport.width}`;
    try {
      await input.fill(value);
      const saved = page.waitForResponse(
        (response) =>
          response.url().endsWith("/api/settings") &&
          response.request().method() === "PUT",
      );
      await input.press("Enter");
      expect((await saved).ok()).toBe(true);
      await expect(save).toBeDisabled();
      await expect(search).toHaveValue("Webhook URL");
      await input.scrollIntoViewIfNeeded();
      await recordUiCapture(
        page,
        `settings-search-confirmation-${viewport.width}`,
      );
      const row = input.locator("xpath=ancestor::*[@data-settings-item][1]");
      await row.locator("strong").click();
      await expect(page).not.toHaveURL(/\/settings$/);
      await expect(input).toHaveValue(value);
    } finally {
      const restored = await page.request.put(`${baseURL}/api/settings`, {
        headers: { "X-Yep-Anywhere": "true" },
        data: { lifecycleWebhookUrl: original || null },
      });
      expect(restored.ok()).toBe(true);
    }
  });
}
