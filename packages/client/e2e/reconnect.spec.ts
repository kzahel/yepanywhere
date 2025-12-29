import { expect, test } from "@playwright/test";

test.describe("SSE Streaming", () => {
  test("receives streamed messages and transitions to idle", async ({
    page,
  }) => {
    await page.goto("/projects");
    await page.waitForSelector(".project-list a");
    await page.locator(".project-list a").first().click();

    await page.fill(".new-session-form input", "Test");
    await page.click(".new-session-form button");

    // Wait for assistant message to appear (session streaming works)
    await expect(page.locator(".message-assistant")).toBeVisible({
      timeout: 10000,
    });

    // Session should eventually go idle
    await expect(page.locator(".status-text")).toHaveText("Idle", {
      timeout: 5000,
    });

    // Verify we received a complete response
    await expect(
      page.locator(".message-assistant .message-content"),
    ).not.toBeEmpty();
  });
});
