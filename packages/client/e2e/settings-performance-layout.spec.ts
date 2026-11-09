import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures.js";

test.use({ serviceWorkers: "block" });

async function dismissOnboardingIfVisible(page: Page) {
  const dialog = page.getByText("Welcome to yepanywhere");
  const appeared = await dialog
    .waitFor({ state: "visible", timeout: 2_000 })
    .then(() => true)
    .catch(() => false);
  if (!appeared) return;
  await page.getByRole("button", { name: "Skip all" }).click({ force: true });
  await expect(dialog).not.toBeVisible();
}

async function capture(page: Page, name: string) {
  const directory = process.env.YEP_E2E_UI_CAPTURE_DIR;
  if (!directory) return;
  mkdirSync(directory, { recursive: true });
  await page.screenshot({
    animations: "disabled",
    path: join(directory, name),
  });
}

for (const viewport of [
  { name: "desktop", width: 1000, height: 600 },
  { name: "phone", width: 375, height: 812 },
] as const) {
  test(`lays out the reverse-search limit on ${viewport.name}`, async ({
    page,
    baseURL,
  }) => {
    await page.setViewportSize(viewport);
    await page.goto(`${baseURL}/settings/performance`);
    await dismissOnboardingIfVisible(page);

    const row = page.locator(
      '[data-settings-item="reverse-search-pages-per-attempt"]',
    );
    const title = row.getByText("Reverse-search pages per attempt", {
      exact: true,
    });
    const description = row.getByText(
      "Maximum older-history pages one active search shortcut or Up action may load while looking for the next match. A page is one bounded server response, normally covering at most two compaction boundaries.",
    );
    const control = row.getByRole("spinbutton", {
      name: "Reverse-search pages per attempt",
    });

    await expect(row).toBeVisible({ timeout: 10_000 });
    await expect(description).toBeVisible();
    await row.scrollIntoViewIfNeeded();

    if (viewport.name === "phone") {
      const rowBox = await row.boundingBox();
      const titleBox = await title.boundingBox();
      const descriptionBox = await description.boundingBox();
      const controlBox = await control.boundingBox();
      if (!rowBox || !titleBox || !descriptionBox || !controlBox) {
        throw new Error("Reverse-search setting has no layout box");
      }

      expect(Math.abs(titleBox.y - controlBox.y)).toBeLessThanOrEqual(4);
      expect(descriptionBox.y).toBeGreaterThanOrEqual(
        Math.max(
          titleBox.y + titleBox.height,
          controlBox.y + controlBox.height,
        ),
      );
      expect(descriptionBox.width).toBeGreaterThanOrEqual(rowBox.width - 32);
    }

    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await expect(
      page.getByText("Server changed", { exact: false }),
    ).toHaveCount(0);

    await capture(
      page,
      `reverse-search-limit-${viewport.name}-${viewport.width}x${viewport.height}.png`,
    );
  });
}
