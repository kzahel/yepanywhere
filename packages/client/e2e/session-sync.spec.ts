import { expect, test } from "@playwright/test";

test.describe("Session Sync", () => {
  test("session history persists after page reload", async ({ page }) => {
    await page.goto("/projects");
    await page.waitForSelector(".project-list a");
    await page.locator(".project-list a").first().click();

    // Start a session
    await page.fill(".new-session-form input", "Hello from reload test");
    await page.click(".new-session-form button");

    // Wait for assistant response
    await expect(page.locator(".assistant-turn")).toBeVisible({
      timeout: 10000,
    });

    // Verify user message is visible
    await expect(page.locator(".message-user-prompt")).toBeVisible();
    const userMessageText = await page
      .locator(".message-user-prompt .text-block")
      .textContent();

    // Get the current URL (session page)
    const sessionUrl = page.url();

    // Reload the page
    await page.reload();

    // Wait for messages to load
    await expect(page.locator(".session-messages")).toBeVisible();

    // User message should still be visible after reload
    await expect(page.locator(".message-user-prompt")).toBeVisible({
      timeout: 5000,
    });
    await expect(page.locator(".message-user-prompt .text-block")).toHaveText(
      userMessageText || "",
    );

    // Assistant message should still be visible after reload
    await expect(page.locator(".assistant-turn")).toBeVisible({
      timeout: 5000,
    });
  });

  test("second tab sees existing session messages", async ({
    page,
    context,
  }) => {
    await page.goto("/projects");
    await page.waitForSelector(".project-list a");
    await page.locator(".project-list a").first().click();

    // Start a session in the first tab
    await page.fill(".new-session-form input", "Hello from first tab");
    await page.click(".new-session-form button");

    // Wait for assistant response
    await expect(page.locator(".assistant-turn")).toBeVisible({
      timeout: 10000,
    });

    // Get the session URL
    const sessionUrl = page.url();

    // Open the same session in a second tab
    const page2 = await context.newPage();
    await page2.goto(sessionUrl);

    // Wait for messages to load in second tab
    await expect(page2.locator(".session-messages")).toBeVisible();

    // Second tab should see both user and assistant messages
    await expect(page2.locator(".message-user-prompt")).toBeVisible({
      timeout: 5000,
    });
    await expect(page2.locator(".assistant-turn")).toBeVisible({
      timeout: 5000,
    });

    // Verify the user message content matches
    const firstTabUserMessage = await page
      .locator(".message-user-prompt .text-block")
      .textContent();
    await expect(page2.locator(".message-user-prompt .text-block")).toHaveText(
      firstTabUserMessage || "",
    );
  });

  test("user message from one tab appears in another tab", async ({
    page,
    context,
  }) => {
    await page.goto("/projects");
    await page.waitForSelector(".project-list a");
    await page.locator(".project-list a").first().click();

    // Start a session in the first tab
    await page.fill(".new-session-form input", "Initial message");
    await page.click(".new-session-form button");

    // Wait for assistant response and idle status (status indicator hidden when idle)
    await expect(page.locator(".assistant-turn")).toBeVisible({
      timeout: 10000,
    });
    await expect(page.locator(".status-indicator")).not.toBeVisible({
      timeout: 10000,
    });

    // Get the session URL
    const sessionUrl = page.url();

    // Open the same session in a second tab
    const page2 = await context.newPage();
    await page2.goto(sessionUrl);

    // Wait for second tab to load and connect
    await expect(page2.locator(".session-messages")).toBeVisible();
    await expect(page2.locator(".message-user-prompt")).toBeVisible({
      timeout: 5000,
    });

    // Count initial messages in second tab
    const initialUserMessageCount = await page2
      .locator(".message-user-prompt")
      .count();

    // Send a follow-up message from the first tab
    const textarea = page.locator(".message-input textarea");
    await textarea.fill("Follow-up from first tab");
    await page.keyboard.press("Enter");

    // The new user message should appear in the second tab
    await expect(page2.locator(".message-user-prompt")).toHaveCount(
      initialUserMessageCount + 1,
      { timeout: 5000 },
    );

    // Verify the content of the new message in second tab
    const lastUserMessage = page2.locator(".message-user-prompt").last();
    await expect(lastUserMessage.locator(".text-block")).toHaveText(
      "Follow-up from first tab",
    );
  });
});
