import { expect, test } from "@playwright/test";

test.describe("Permission Mode", () => {
  test("shows mode button in message input", async ({ page }) => {
    await page.goto("/projects");
    await page.waitForSelector(".project-list a");
    await page.locator(".project-list a").first().click();

    // Start a session first
    await page.fill(".new-session-form input", "Test message");
    await page.click(".new-session-form button");

    // Wait for session page to load
    await expect(page.locator(".session-messages")).toBeVisible();

    // Should show mode button with default label
    const modeButton = page.locator(".mode-button");
    await expect(modeButton).toBeVisible();
    await expect(modeButton).toContainText("Ask before edits");
  });

  test("cycles through permission modes on click", async ({ page }) => {
    await page.goto("/projects");
    await page.waitForSelector(".project-list a");
    await page.locator(".project-list a").first().click();

    // Start a session
    await page.fill(".new-session-form input", "Test message");
    await page.click(".new-session-form button");

    await expect(page.locator(".session-messages")).toBeVisible();

    const modeButton = page.locator(".mode-button");

    // Initial state: Ask before edits
    await expect(modeButton).toContainText("Ask before edits");

    // Click to cycle to: Edit automatically
    await modeButton.click();
    await expect(modeButton).toContainText("Edit automatically");

    // Click to cycle to: Plan mode
    await modeButton.click();
    await expect(modeButton).toContainText("Plan mode");

    // Click to cycle to: Bypass permissions
    await modeButton.click();
    await expect(modeButton).toContainText("Bypass permissions");

    // Click to cycle back to: Ask before edits
    await modeButton.click();
    await expect(modeButton).toContainText("Ask before edits");
  });

  test("mode dot color changes with mode", async ({ page }) => {
    await page.goto("/projects");
    await page.waitForSelector(".project-list a");
    await page.locator(".project-list a").first().click();

    await page.fill(".new-session-form input", "Test message");
    await page.click(".new-session-form button");

    await expect(page.locator(".session-messages")).toBeVisible();

    const modeButton = page.locator(".mode-button");
    const modeDot = page.locator(".mode-dot");

    // Initial state should have default class
    await expect(modeDot).toHaveClass(/mode-default/);

    // Cycle to acceptEdits
    await modeButton.click();
    await expect(modeDot).toHaveClass(/mode-acceptEdits/);

    // Cycle to plan
    await modeButton.click();
    await expect(modeDot).toHaveClass(/mode-plan/);

    // Cycle to bypassPermissions
    await modeButton.click();
    await expect(modeDot).toHaveClass(/mode-bypassPermissions/);
  });
});
