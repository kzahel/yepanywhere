import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures.js";

test.use({ serviceWorkers: "block" });

async function dismissOnboardingIfVisible(page: Page) {
  const dialog = page.getByText("Welcome to yepanywhere");
  await page.waitForTimeout(250);
  if (!(await dialog.isVisible().catch(() => false))) return;
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

async function readNavigationMetrics(page: Page) {
  return page
    .locator(".sidebar-nav-item")
    .filter({ hasText: "Inbox" })
    .first()
    .evaluate((item) => {
      const style = getComputedStyle(item);
      return {
        fontSize: style.fontSize,
        gap: Number.parseFloat(style.columnGap),
        paddingInlineStart: Number.parseFloat(style.paddingInlineStart),
      };
    });
}

async function expectRestoredNewSessionAction(page: Page) {
  const action = page.getByRole("link", { name: "New Session" }).first();
  await expect(action).toBeVisible();
  await expect(action.locator(".sidebar-new-session-icon")).toHaveAttribute(
    "width",
    "16",
  );
  await expect(action.locator(".sidebar-new-session-icon")).toHaveAttribute(
    "height",
    "16",
  );
  await expect(action.locator(".sidebar-new-session-icon circle")).toHaveCount(
    1,
  );
  await expect(action.locator(".sidebar-new-session-icon line")).toHaveCount(2);
}

test("keeps sidebar density spatial and the create action recognizable", async ({
  page,
  baseURL,
}) => {
  await page.addInitScript(() => {
    window.localStorage.setItem("yep-anywhere-sidebar-spacing", "comfortable");
  });
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto(`${baseURL}/settings/appearance`);
  await dismissOnboardingIfVisible(page);

  // Settings deliberately starts collapsed; density is measured expanded.
  await page
    .getByRole("button", { name: "Expand sidebar", exact: true })
    .click();

  const densityRow = page.locator('[data-settings-item="sidebar-density"]');
  await expect(densityRow).toBeVisible();
  await expect(densityRow).toContainText(
    "Choose comfortable or compact spacing for sidebar rows and sections.",
  );
  await expect(
    densityRow.locator("xpath=ancestor::*[@data-output-appearance]"),
  ).toHaveCount(0);

  await expect(page.locator(".sidebar-brand")).toBeVisible();
  await expectRestoredNewSessionAction(page);

  const comfortableMetrics = await readNavigationMetrics(page);
  expect(comfortableMetrics.paddingInlineStart).toBeCloseTo(
    comfortableMetrics.gap,
    4,
  );

  await densityRow.getByRole("radio", { name: "Compact" }).click();
  await expect(page.locator("html")).toHaveAttribute(
    "data-sidebar-spacing",
    "compact",
  );
  await expect(page.locator(".sidebar-brand")).toBeVisible();
  await expectRestoredNewSessionAction(page);

  const compactMetrics = await readNavigationMetrics(page);
  expect(compactMetrics.paddingInlineStart).toBeCloseTo(compactMetrics.gap, 4);
  expect(compactMetrics.paddingInlineStart).toBeLessThan(
    comfortableMetrics.paddingInlineStart,
  );
  expect(compactMetrics.fontSize).toBe(comfortableMetrics.fontSize);

  await densityRow.getByRole("radio", { name: "Comfortable" }).click();
  await expect(page.locator("html")).toHaveAttribute(
    "data-sidebar-spacing",
    "comfortable",
  );
  await densityRow.scrollIntoViewIfNeeded();
  await capture(page, "sidebar-density-desktop-1920x1080.png");

  await page.setViewportSize({ width: 375, height: 812 });
  await expect(async () => {
    await page
      .locator('[data-settings-item="sidebar-density"]')
      .scrollIntoViewIfNeeded();
  }).toPass();
  await capture(page, "sidebar-density-mobile-375x812.png");

  await page.goto(`${baseURL}/inbox`);
  await page.getByRole("button", { name: "Open sidebar" }).click();
  await expect(page.locator(".sidebar-brand")).toBeVisible();
  await expectRestoredNewSessionAction(page);
  await expect
    .poll(async () => (await page.locator(".sidebar").boundingBox())?.x)
    .toBe(0);

  const mobileMetrics = await readNavigationMetrics(page);
  expect(mobileMetrics.paddingInlineStart).toBeCloseTo(mobileMetrics.gap, 4);
  await capture(page, "sidebar-open-mobile-375x812.png");
});

test("opens New Session from the header sidebar launcher middle click", async ({
  page,
  baseURL,
}) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto(`${baseURL}/inbox`);
  await dismissOnboardingIfVisible(page);

  const opener = page.getByRole("button", { name: "Open sidebar" });
  await expect(opener).toHaveAttribute(
    "data-tooltip",
    "Open sidebar / [Shift] New Session",
  );
  await opener.hover();
  await expect(page.getByRole("tooltip")).toHaveText(
    "Open sidebar / [Shift] New Session",
  );
  await capture(page, "sidebar-launcher-tooltip-mobile-375x812.png");

  const popupPromise = page.context().waitForEvent("page");
  await opener.click({ button: "middle" });
  const popup = await popupPromise;
  await popup.waitForURL((url) => url.pathname === "/new-session");

  const popupUrl = new URL(popup.url());
  expect(popupUrl.pathname).toBe("/new-session");
  expect(popupUrl.searchParams.get("sidebar")).toBe("expanded");
  expect(new URL(page.url()).pathname).toBe("/inbox");
});
