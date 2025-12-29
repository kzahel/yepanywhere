import { expect, test } from "@playwright/test";

test.describe("Session Flow", () => {
  test("can start a new session", async ({ page }) => {
    await page.goto("/projects");
    await page.waitForSelector(".project-list a");
    await page.locator(".project-list a").first().click();

    // Type a message
    await page.fill(".new-session-form input", "Hello Claude");
    await page.click(".new-session-form button");

    // Should navigate to chat page
    await expect(page).toHaveURL(/\/sessions\//);

    // Should see the chat interface
    await expect(page.locator(".chat-messages")).toBeVisible();
  });

  test("receives streamed response", async ({ page }) => {
    await page.goto("/projects");
    await page.waitForSelector(".project-list a");
    await page.locator(".project-list a").first().click();

    await page.fill(".new-session-form input", "Test message");
    await page.click(".new-session-form button");

    // Wait for assistant message to appear
    await expect(page.locator(".message-assistant")).toBeVisible({
      timeout: 10000,
    });

    // Should contain some response text (scenarios cycle, content varies)
    await expect(
      page.locator(".message-assistant .message-content"),
    ).not.toBeEmpty();
  });

  test("shows status indicator", async ({ page }) => {
    await page.goto("/projects");
    await page.waitForSelector(".project-list a");
    await page.locator(".project-list a").first().click();

    await page.fill(".new-session-form input", "Test");
    await page.click(".new-session-form button");

    // Should show running status initially, then idle
    await expect(page.locator(".status-indicator")).toBeVisible();

    // Eventually should show idle
    await expect(page.locator(".status-text")).toHaveText("Idle", {
      timeout: 10000,
    });
  });

  test("can send follow-up message", async ({ page }) => {
    await page.goto("/projects");
    await page.waitForSelector(".project-list a");
    await page.locator(".project-list a").first().click();

    // Start session
    await page.fill(".new-session-form input", "First message");
    await page.click(".new-session-form button");

    // Wait for response and idle status
    await expect(page.locator(".message-assistant")).toBeVisible({
      timeout: 10000,
    });
    await expect(page.locator(".status-text")).toHaveText("Idle", {
      timeout: 10000,
    });

    // Verify we can use the message input for follow-ups
    const textarea = page.locator(".message-input textarea");
    await expect(textarea).toBeVisible();
    await expect(textarea).toBeEnabled();

    // Input should have follow-up placeholder when idle
    await expect(textarea).toHaveAttribute(
      "placeholder",
      "Send a message to resume...",
    );
  });
});
