import type { Page } from "@playwright/test";
import { join } from "node:path";
import { e2ePaths, expect, test } from "./fixtures.js";
import { recordUiCapture } from "./support/ui-capture.js";

/**
 * Grouped image reads show the images, not just their filenames.
 *
 * Once YA materializes tool-result media the stored result keeps its metadata
 * and drops the provider's bytes, so the strip reads each file back through the
 * session's media route.
 */

const mockProjectPath = join(e2ePaths.tempDir, "mockproject");
const projectId = Buffer.from(mockProjectPath).toString("base64url");
const sessionId = "explored-images-001";

async function openExploredGroup(page: Page, baseURL: string) {
  await page.goto(`${baseURL}/projects/${projectId}/sessions/${sessionId}`);
  const skip = page.getByRole("button", { name: "Skip all", exact: true });
  if (
    await skip
      .waitFor({ state: "visible", timeout: 750 })
      .then(() => true)
      .catch(() => false)
  ) {
    await skip.click();
  }
  const summary = page.locator(".conversation-activity-summary");
  if (await summary.count()) await summary.first().click();
  await expect(page.locator(".explored-entry")).toHaveCount(2, {
    timeout: 15000,
  });
}

test("grouped image reads show thumbnails that open the viewer", async ({
  page,
  baseURL,
}) => {
  await page.setViewportSize({ width: 1000, height: 600 });
  await openExploredGroup(page, baseURL);

  const toggle = page.getByRole("button", { name: "2 images" });
  await expect(toggle).toBeVisible();
  await toggle.click();

  const thumbnails = page.locator("[data-explored-images] img");
  await expect(thumbnails).toHaveCount(2, { timeout: 15000 });
  for (const thumbnail of await thumbnails.all()) {
    await expect
      .poll(
        async () =>
          await thumbnail.evaluate(
            (image) => (image as HTMLImageElement).naturalWidth,
          ),
        { timeout: 15000 },
      )
      .toBeGreaterThan(0);
  }
  await recordUiCapture(page, "explored-image-strip-desktop");

  await thumbnails.first().click();
  await expect(page.locator(".modal--image-viewer")).toHaveCount(1, {
    timeout: 10000,
  });
  await page.keyboard.press("Escape");

  await page.setViewportSize({ width: 375, height: 812 });
  await expect(thumbnails).toHaveCount(2);
  await recordUiCapture(page, "explored-image-strip-phone");
});
