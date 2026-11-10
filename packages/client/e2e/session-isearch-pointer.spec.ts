import { join } from "node:path";
import type { Page } from "@playwright/test";
import { e2ePaths, expect, test } from "./fixtures.js";

const mockProjectPath = join(e2ePaths.tempDir, "mockproject");
const projectId = Buffer.from(mockProjectPath).toString("base64url");
const sessionId = "transcript-specimen-001";

async function dismissOnboardingIfVisible(page: Page) {
  const skip = page.getByRole("button", { name: "Skip all", exact: true });
  if (
    await skip
      .waitFor({ state: "visible", timeout: 750 })
      .then(() => true)
      .catch(() => false)
  ) {
    await skip.click();
  }
}

test.use({
  serviceWorkers: "block",
  viewport: { width: 900, height: 520 },
});

test("search result and transcript clicks keep their own actions", async ({
  page,
  baseURL,
}) => {
  await page.goto(`${baseURL}/projects/${projectId}/sessions/${sessionId}`);
  await dismissOnboardingIfVisible(page);

  const transcript = page.locator("[data-session-messages]");
  const list = transcript.locator("[data-message-list]");
  await expect(
    list.locator('[data-render-id="specimen-assistant-2"]'),
  ).toBeVisible({
    timeout: 10000,
  });
  await expect(list).not.toHaveAttribute("aria-busy", "true", {
    timeout: 10000,
  });
  await page.addStyleTag({
    content: "[data-message-list] > [data-render-id] { min-height: 360px; }",
  });

  await page.keyboard.press("Control+s");
  const allTurnInput = page.getByRole("textbox", {
    name: "Reverse search all turns",
  });
  await allTurnInput.fill("specimen");

  const result = page
    .getByRole("navigation", { name: "Turn navigation" })
    .getByRole("button", { name: "The specimen is ready.", exact: true });
  await result.hover();
  await transcript.evaluate((element) => {
    element.scrollTop = 0;
  });
  await result.click();

  await expect
    .poll(() =>
      page.evaluate(() => {
        const scrollport = document.querySelector<HTMLElement>(
          "[data-session-messages]",
        );
        const row = document.querySelector<HTMLElement>(
          '[data-render-id="specimen-assistant-2"]',
        );
        if (!scrollport || !row) return Number.POSITIVE_INFINITY;
        const scrollRect = scrollport.getBoundingClientRect();
        const rowRect = row.getBoundingClientRect();
        const desiredScrollTop =
          scrollport.scrollTop +
          rowRect.top +
          rowRect.height / 2 -
          (scrollRect.top + scrollRect.height / 2);
        const expectedScrollTop = Math.min(
          Math.max(0, desiredScrollTop),
          scrollport.scrollHeight - scrollport.clientHeight,
        );
        return Math.abs(scrollport.scrollTop - expectedScrollTop);
      }),
    )
    .toBeLessThan(2);
  await expect(allTurnInput).toBeFocused();
  await expect(result).toBeHidden();

  const marker = page.getByRole("button", {
    name: "Jump to turn: The specimen is ready.",
    exact: true,
  });
  await marker.hover({ position: { x: 2, y: 2 } });
  await expect(result).toBeVisible();
  await result.click();
  await expect(result).toBeHidden();

  await page.keyboard.press("Escape");
  await page.keyboard.press("Control+Alt+s");
  const fullSessionInput = page.getByRole("textbox", {
    name: "Reverse search full session",
  });
  await fullSessionInput.fill("fixture");

  const activityToggle = page.getByRole("button", {
    name: /activities hidden/,
  });
  await expect(activityToggle).toHaveAttribute("aria-expanded", "false");
  await activityToggle.click();
  // Expanded, the summary drops "hidden": the rows it counts are on screen.
  const expandedToggle = page.getByRole("button", {
    name: /\d+ activities$/,
  });
  await expect(expandedToggle).toHaveAttribute("aria-expanded", "true");
  await expect(fullSessionInput).toBeVisible();
});
