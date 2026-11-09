import { expect, test } from "./fixtures.js";
import { recordUiCapture } from "./support/ui-capture.js";

test.use({ serviceWorkers: "block" });

for (const viewport of [
  { width: 1200, height: 600 },
  { width: 967, height: 600 },
  { width: 768, height: 812 },
  { width: 375, height: 812 },
]) {
  test(`speech setup is discoverable and fits at ${viewport.width}px`, async ({
    page,
    baseURL,
  }) => {
    await page.setViewportSize(viewport);
    await page.goto(`${baseURL}/settings/speech`);
    const setup = page.locator('[data-settings-item="speech-backend-setup"]');
    await expect(setup).toBeVisible();
    await expect(
      setup.getByRole("button", { name: "Get / install this model" }),
    ).toHaveCount(5);
    await expect(
      setup.getByRole("switch", { name: "GPU", exact: true }),
    ).toBeVisible();
    await expect(
      setup.getByRole("switch", {
        name: "Enable Qwen3 ASR STT",
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      setup.getByRole("switch", {
        name: "Enable Granite Speech STT",
        exact: true,
      }),
    ).toBeVisible();
    expect(
      await setup.evaluate((node) => node.scrollWidth <= node.clientWidth),
    ).toBe(true);
    // Include the surrounding speech settings: a full-width range input's
    // default margin previously added two pixels to the panel's scroll width.
    expect(
      await page.evaluate(() =>
        [...document.querySelectorAll<HTMLElement>("*")]
          .filter((node) =>
            ["auto", "scroll"].includes(getComputedStyle(node).overflowX),
          )
          .every((node) => node.scrollWidth <= node.clientWidth),
      ),
    ).toBe(true);
    const granite = setup.getByRole("region", {
      name: "Granite Speech STT",
      exact: true,
    });
    await granite.getByRole("button", { name: "Model page / access" }).click();
    await expect(
      setup.getByRole("link", { name: /granite-speech-4.1-2b/ }),
    ).toHaveAttribute(
      "href",
      "https://huggingface.co/ibm-granite/granite-speech-4.1-2b",
    );
    await setup.getByRole("button", { name: "Close model page" }).click();
    await granite.scrollIntoViewIfNeeded();
    await recordUiCapture(page, `speech-setup-${viewport.width}`, viewport);
  });
}
