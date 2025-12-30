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

  test("mode syncs from server after page refresh when session is active", async ({
    page,
  }) => {
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

    // Switch to "Edit automatically"
    await modeButton.click();
    await expect(modeButton).toContainText("Edit automatically");

    // Send a follow-up message to persist the mode change to the server
    await page.fill(
      ".message-input input, .message-input textarea",
      "Follow-up to persist mode",
    );
    await page.keyboard.press("Enter");

    // Wait for the message to be processed
    await page.waitForTimeout(500);

    // Refresh the page
    await page.reload();

    // Wait for session page to load again
    await expect(page.locator(".session-messages")).toBeVisible();

    // Verify the mode is still "Edit automatically" (synced from server)
    await expect(modeButton).toContainText("Edit automatically");
  });

  test("rapid mode toggling settles to final state", async ({ page }) => {
    await page.goto("/projects");
    await page.waitForSelector(".project-list a");
    await page.locator(".project-list a").first().click();

    // Start a session
    await page.fill(".new-session-form input", "Test message");
    await page.click(".new-session-form button");

    await expect(page.locator(".session-messages")).toBeVisible();

    const modeButton = page.locator(".mode-button");

    // Initial state: Ask before edits (default)
    await expect(modeButton).toContainText("Ask before edits");

    // Rapidly click mode button multiple times
    await modeButton.click(); // -> Edit automatically
    await modeButton.click(); // -> Plan mode
    await modeButton.click(); // -> Bypass permissions
    await modeButton.click(); // -> Ask before edits

    // Wait a bit for any async operations to settle
    await page.waitForTimeout(200);

    // Final state should be "Ask before edits" (cycled back)
    await expect(modeButton).toContainText("Ask before edits");

    // Refresh and verify mode persisted
    await page.reload();
    await expect(page.locator(".session-messages")).toBeVisible();
    await expect(modeButton).toContainText("Ask before edits");
  });

  test("mode syncs from server on initial SSE connection", async ({ page }) => {
    await page.goto("/projects");
    await page.waitForSelector(".project-list a");
    await page.locator(".project-list a").first().click();

    // Start a session with a message
    await page.fill(".new-session-form input", "Test message for sync");
    await page.click(".new-session-form button");

    await expect(page.locator(".session-messages")).toBeVisible();

    const modeButton = page.locator(".mode-button");

    // Change mode to "Bypass permissions"
    await modeButton.click(); // -> Edit automatically
    await modeButton.click(); // -> Plan mode
    await modeButton.click(); // -> Bypass permissions
    await expect(modeButton).toContainText("Bypass permissions");

    // Send another message to establish the mode on server
    await page.fill(
      ".message-input input, .message-input textarea",
      "Another message",
    );
    await page.keyboard.press("Enter");

    // Wait for message to be processed
    await page.waitForTimeout(500);

    // Refresh the page - should sync mode from SSE connected event
    await page.reload();
    await expect(page.locator(".session-messages")).toBeVisible();

    // Mode should be synced from server
    await expect(modeButton).toContainText("Bypass permissions");
  });
});
