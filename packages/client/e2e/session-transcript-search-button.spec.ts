import { join } from "node:path";
import type { Page } from "@playwright/test";
import { e2ePaths, expect, test } from "./fixtures.js";
import { recordUiCapture } from "./support/ui-capture.js";

const mockProjectPath = join(e2ePaths.tempDir, "mockproject");
const projectId = Buffer.from(mockProjectPath).toString("base64url");
const sessionId = "transcript-specimen-001";

async function openSpecimen(page: Page, baseURL: string | undefined) {
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
  await expect(
    page.locator('.message-list [data-render-id="specimen-assistant-2"]'),
  ).toBeVisible({ timeout: 10000 });
}

test.use({ serviceWorkers: "block" });

for (const viewport of [
  { name: "desktop", width: 1200, height: 600 },
  { name: "tablet", width: 820, height: 1180 },
  { name: "phone", width: 375, height: 812 },
]) {
  test(`toolbar search button opens transcript search (${viewport.name})`, async ({
    page,
    baseURL,
  }) => {
    await page.setViewportSize(viewport);
    await openSpecimen(page, baseURL);

    // Default-visible at the lowest tier: inline where the row has room,
    // otherwise one tap away behind the overflow control.
    const button = page
      .getByRole("button", { name: "Search transcript" })
      .or(page.getByRole("menuitem", { name: "Search transcript" }));
    if (!(await button.first().isVisible())) {
      await page.getByRole("button", { name: "More toolbar controls" }).click();
    }
    await expect(button.first()).toBeVisible();
    await recordUiCapture(page, `${viewport.name}-toolbar`, viewport);

    await button.first().click();
    const input = page.getByRole("textbox", {
      name: "Reverse search user turns",
    });
    await expect(input).toBeFocused();

    await page
      .getByRole("combobox", { name: "Search scope" })
      .selectOption("all");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("search")).toHaveCount(0);

    // Reopening keeps the scope chosen last.
    if (!(await button.first().isVisible())) {
      await page.getByRole("button", { name: "More toolbar controls" }).click();
    }
    await button.first().click();
    await expect(
      page.getByRole("textbox", { name: "Reverse search all turns" }),
    ).toBeFocused();
    await recordUiCapture(page, `${viewport.name}-open`, viewport);
  });
}
