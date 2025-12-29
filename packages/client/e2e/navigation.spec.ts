import { expect, test } from "@playwright/test";

test.describe("Navigation", () => {
  test("loads projects page", async ({ page }) => {
    await page.goto("/projects");
    await expect(page.locator("h1")).toHaveText("Projects");
  });

  test("can navigate to project", async ({ page }) => {
    await page.goto("/projects");

    // Wait for projects to load
    await page.waitForSelector(".project-list a");

    // Click first project
    await page.locator(".project-list a").first().click();

    // Should be on sessions page
    await expect(page.locator("h2")).toHaveText("Sessions");
  });

  test("URL is stable on refresh", async ({ page }) => {
    await page.goto("/projects");
    await page.waitForSelector(".project-list a");
    await page.locator(".project-list a").first().click();

    const url = page.url();

    // Refresh
    await page.reload();

    // Should be same URL
    expect(page.url()).toBe(url);
    await expect(page.locator("h2")).toHaveText("Sessions");
  });
});
