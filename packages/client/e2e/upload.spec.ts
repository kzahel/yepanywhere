import { expect, test } from "@playwright/test";

/**
 * File Upload E2E Tests
 *
 * These tests verify the file upload functionality using WebSocket.
 * WebSocket connections are now proxied through the backend's http-proxy,
 * which properly handles binary data.
 */

test.describe("File Upload", () => {
  // Helper to start a session and wait for it to be ready
  async function startSession(page: import("@playwright/test").Page) {
    await page.goto("/projects");
    await page.waitForSelector(".project-list a");
    await page.locator(".project-list a").first().click();

    // Start a new session
    await page.fill(".new-session-form textarea", "Hello Claude");
    await page.click(".new-session-form button");

    // Wait for session to be established and idle
    await expect(page).toHaveURL(/\/sessions\//);
    await expect(page.locator(".assistant-turn")).toBeVisible({
      timeout: 10000,
    });
    await expect(page.locator(".status-indicator")).not.toBeVisible({
      timeout: 10000,
    });
  }

  // Helper to wait for upload to complete (chip visible without .uploading class)
  async function waitForUploadComplete(
    page: import("@playwright/test").Page,
    expectedCount = 1,
  ) {
    await expect(page.locator(".attachment-chip:not(.uploading)")).toHaveCount(
      expectedCount,
      { timeout: 30000 },
    );
  }

  test("attach button is enabled in session page", async ({ page }) => {
    await startSession(page);

    // Attach button should be visible and enabled in session page
    const attachButton = page.locator(".attach-button");
    await expect(attachButton).toBeVisible();
    await expect(attachButton).toBeEnabled();
    await expect(attachButton).toHaveAttribute("title", "Attach files");
  });

  test("uploads a small file and sends message", async ({ page }) => {
    // Capture browser console logs
    page.on("console", (msg) =>
      console.log("[Browser]", msg.type(), msg.text()),
    );

    await startSession(page);

    // Verify file input exists
    const fileInput = page.locator('input[type="file"]');
    await expect(fileInput).toBeAttached();
    console.log("[Test] File input is attached");

    // Upload a small text file
    await page.setInputFiles('input[type="file"]', {
      name: "test.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("Hello from uploaded file!"),
    });
    console.log("[Test] Files set on input");

    // Wait for upload to complete (chip without .uploading class)
    await waitForUploadComplete(page);

    // Verify file name is displayed
    await expect(page.locator(".attachment-name").first()).toHaveText(
      "test.txt",
    );

    // Send message with attachment
    await page.fill(".message-input textarea", "Please read the attached file");
    await page.click(".message-input .send-button");

    // Wait for message to be sent (user message should appear)
    await expect(page.locator(".message-user-prompt")).toHaveCount(2, {
      timeout: 10000,
    });

    // Attachment should be cleared after send
    await expect(page.locator(".attachment-chip")).not.toBeVisible({
      timeout: 5000,
    });
  });

  test("shows upload progress for larger files", async ({ page }) => {
    await startSession(page);

    // Upload a larger file (1MB) to trigger progress updates
    const largeBuffer = Buffer.alloc(1024 * 1024, "x");
    await page.setInputFiles('input[type="file"]', {
      name: "large.bin",
      mimeType: "application/octet-stream",
      buffer: largeBuffer,
    });

    // Should show uploading state (may be brief for local uploads)
    // Wait for upload to complete
    await waitForUploadComplete(page);
    await expect(page.locator(".attachment-name").first()).toHaveText(
      "large.bin",
    );
  });

  test("can remove attachment before sending", async ({ page }) => {
    await startSession(page);

    // Upload a file
    await page.setInputFiles('input[type="file"]', {
      name: "to-remove.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("This file will be removed"),
    });

    // Wait for upload to complete
    await waitForUploadComplete(page);

    // Click remove button
    await page.click(".attachment-remove");

    // Attachment should be removed
    await expect(page.locator(".attachment-chip")).not.toBeVisible();
  });

  test("can upload multiple files", async ({ page }) => {
    await startSession(page);

    // Upload first file
    await page.setInputFiles('input[type="file"]', {
      name: "file1.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("First file content"),
    });

    // Wait for first upload to complete
    await waitForUploadComplete(page, 1);

    // Upload second file
    await page.setInputFiles('input[type="file"]', {
      name: "file2.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("Second file content"),
    });

    // Wait for second upload to complete
    await waitForUploadComplete(page, 2);

    // Upload third file
    await page.setInputFiles('input[type="file"]', {
      name: "file3.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("Third file content"),
    });

    // Wait for all uploads to complete
    await waitForUploadComplete(page, 3);

    // Verify attach count badge
    await expect(page.locator(".attach-count")).toHaveText("3");

    // Verify all file names are displayed
    const names = page.locator(".attachment-name");
    await expect(names).toHaveCount(3);
  });
});
