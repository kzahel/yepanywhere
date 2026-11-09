import { expect, test } from "./fixtures.js";
import { recordUiCapture } from "./support/ui-capture.js";

test.use({ serviceWorkers: "block" });

test("rendez search exposes a persisted toggle without replacing project overrides", async ({
  page,
  baseURL,
}) => {
  const readSettings = async () => {
    const response = await page.request.get(`${baseURL}/api/settings`);
    expect(response.ok()).toBe(true);
    return (await response.json()).settings;
  };
  const original = (await readSettings()).rendez ?? {
    enabled: false,
    projects: {},
  };
  const seeded = {
    enabled: false,
    projects: { "/rendez-settings-test": false },
    windowMs: 1234,
    maxPerWindow: 7,
    delivery: "auto",
  };
  try {
    const response = await page.request.put(`${baseURL}/api/settings`, {
      headers: { "X-Yep-Anywhere": "true" },
      data: { rendez: seeded },
    });
    expect(response.ok()).toBe(true);
    await page.setViewportSize({ width: 1200, height: 600 });
    await page.goto(`${baseURL}/settings`);
    const search = page.getByRole("searchbox", { name: "Search settings" });
    let value = "";
    for (const character of "rendez") {
      value += character;
      await search.pressSequentially(character);
      await expect(search).toHaveValue(value, { timeout: 100 });
    }
    const toggle = page.getByRole("switch", {
      name: "Watch .rendez uploads by default",
    });
    await expect(toggle).not.toBeChecked();
    await toggle.check();
    await expect
      .poll(async () => (await readSettings()).rendez)
      .toEqual({
        ...seeded,
        enabled: true,
      });
    await expect(toggle).toBeChecked();
    await recordUiCapture(page, "rendez-desktop");
    await page.setViewportSize({ width: 375, height: 812 });
    await recordUiCapture(page, "rendez-phone");
    await search.fill("Wait for Claude");
    await expect(page.getByText(/Steer sends are unaffected/)).toBeVisible();
    await recordUiCapture(page, "patient-queue-phone");
    await page.setViewportSize({ width: 1200, height: 600 });
    await recordUiCapture(page, "patient-queue-desktop");
  } finally {
    const response = await page.request.put(`${baseURL}/api/settings`, {
      headers: { "X-Yep-Anywhere": "true" },
      data: { rendez: original },
    });
    expect(response.ok()).toBe(true);
  }
});
