import { join } from "node:path";
import type { Page } from "@playwright/test";
import { e2ePaths, expect, test } from "./fixtures.js";

const mockProjectPath = join(e2ePaths.tempDir, "mockproject");
const projectId = Buffer.from(mockProjectPath).toString("base64url");
const pathA = `/projects/${projectId}/sessions/switch-scroll-a`;
const pathB = `/projects/${projectId}/sessions/switch-scroll-b`;

test.use({ serviceWorkers: "block" });

async function dismissOnboardingIfVisible(page: Page) {
  const skip = page.getByRole("button", { name: "Skip all", exact: true });
  if (await skip.isVisible().catch(() => false)) await skip.click();
}

function activeViewport(page: Page) {
  return page.locator(
    "[data-session-dom-linger-layer][data-is-active] [data-message-list]",
  );
}

async function scrollTop(page: Page) {
  return activeViewport(page).evaluate(
    (list) => list.parentElement?.scrollTop ?? -1,
  );
}

async function scrollAwayFromTail(page: Page) {
  await activeViewport(page).evaluate((list) => {
    const viewport = list.parentElement;
    if (!viewport) throw new Error("Message list has no scroll viewport");
    viewport.dispatchEvent(
      new WheelEvent("wheel", { bubbles: true, deltaY: -120 }),
    );
    viewport.scrollTop = Math.max(
      0,
      viewport.scrollHeight - viewport.clientHeight - 600,
    );
    viewport.dispatchEvent(new Event("scroll"));
  });
  await expect(
    page.getByRole("button", { name: "Follow latest session output" }),
  ).toBeVisible();
}

async function clickSidebarSession(page: Page, sessionPath: string) {
  const sidebar = page.locator("[data-sidebar]");
  if (!(await sidebar.isVisible().catch(() => false))) {
    await page.getByRole("button", { name: "Open sidebar" }).click();
    await expect(sidebar).toBeVisible();
  }
  const sessionLink = sidebar.locator(`a[href="${sessionPath}"]`).first();
  await expect(sessionLink).toBeVisible();
  await sessionLink.click();
}

// A retained session layer keeps its DOM while another session is shown.
// Swapping which layer is active must not move either layer's DOM node:
// a moved node loses its scroll position, returning the reader to the top.
test("direct session switching keeps each scrolled-away reading position", async ({
  page,
  baseURL,
}) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1200, height: 700 });
  await page.addInitScript(() => {
    localStorage.setItem("yep-anywhere-session-dom-linger-enabled", "true");
  });
  await page.goto(`${baseURL}${pathA}`);
  await dismissOnboardingIfVisible(page);
  await expect(
    page.getByRole("main").getByText("Switch a reply 90.").first(),
  ).toBeVisible({ timeout: 15_000 });

  await scrollAwayFromTail(page);
  const topA = await scrollTop(page);
  expect(topA).toBeGreaterThan(200);

  await clickSidebarSession(page, pathB);
  await expect(page).toHaveURL(`${baseURL}${pathB}`);
  await expect(
    page.getByRole("main").getByText("Switch b reply 90.").first(),
  ).toBeVisible();
  await expect(page.locator("[data-session-dom-linger-layer]")).toHaveCount(2);
  await scrollAwayFromTail(page);
  const topB = await scrollTop(page);

  for (let round = 0; round < 2; round += 1) {
    await clickSidebarSession(page, pathA);
    await expect(page).toHaveURL(`${baseURL}${pathA}`);
    await expect.poll(() => scrollTop(page)).toBe(topA);

    await clickSidebarSession(page, pathB);
    await expect(page).toHaveURL(`${baseURL}${pathB}`);
    await expect.poll(() => scrollTop(page)).toBe(topB);
  }
});
