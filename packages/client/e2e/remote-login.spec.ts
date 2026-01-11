/**
 * E2E tests for Remote Login Flow (Phase 3.6).
 *
 * Tests the full user experience of loading the remote client,
 * entering credentials, and using the app through an encrypted
 * WebSocket connection.
 */

import {
  configureRemoteAccess,
  disableRemoteAccess,
  expect,
  test,
} from "./fixtures.js";

// Test credentials
const TEST_USERNAME = "e2e-test-user";
const TEST_PASSWORD = "test-password-123";

test.describe("Remote Login Flow", () => {
  test.beforeEach(async ({ baseURL, page }) => {
    // Configure remote access with test credentials
    await configureRemoteAccess(baseURL, {
      username: TEST_USERNAME,
      password: TEST_PASSWORD,
    });
    // Clear localStorage for fresh state
    await page.addInitScript(() => {
      localStorage.clear();
      sessionStorage.clear();
    });
  });

  test.afterEach(async ({ baseURL }) => {
    await disableRemoteAccess(baseURL);
  });

  test("login page renders correctly", async ({ page, remoteClientURL }) => {
    await page.goto(remoteClientURL);

    // Verify login form is visible
    await expect(page.locator('[data-testid="login-form"]')).toBeVisible();
    await expect(page.locator('[data-testid="ws-url-input"]')).toBeVisible();
    await expect(page.locator('[data-testid="username-input"]')).toBeVisible();
    await expect(page.locator('[data-testid="password-input"]')).toBeVisible();
    await expect(page.locator('[data-testid="login-button"]')).toBeVisible();
  });

  test("successful login renders main app", async ({
    page,
    remoteClientURL,
    wsURL,
  }) => {
    await page.goto(remoteClientURL);

    // Fill in login form
    await page.fill('[data-testid="ws-url-input"]', wsURL);
    await page.fill('[data-testid="username-input"]', TEST_USERNAME);
    await page.fill('[data-testid="password-input"]', TEST_PASSWORD);

    // Submit form
    await page.click('[data-testid="login-button"]');

    // Wait for login form to disappear (indicates successful login)
    await expect(page.locator('[data-testid="login-form"]')).not.toBeVisible({
      timeout: 10000,
    });

    // Verify we're no longer on the login page
    // The main app should be visible (look for sidebar which is always present)
    await expect(page.locator(".sidebar")).toBeVisible({
      timeout: 5000,
    });
  });

  test("wrong password shows error", async ({
    page,
    remoteClientURL,
    wsURL,
  }) => {
    await page.goto(remoteClientURL);

    // Fill in login form with wrong password
    await page.fill('[data-testid="ws-url-input"]', wsURL);
    await page.fill('[data-testid="username-input"]', TEST_USERNAME);
    await page.fill('[data-testid="password-input"]', "wrong-password");

    // Submit form
    await page.click('[data-testid="login-button"]');

    // Verify error message appears
    await expect(page.locator('[data-testid="login-error"]')).toBeVisible({
      timeout: 10000,
    });

    // Verify we're still on login page
    await expect(page.locator('[data-testid="login-form"]')).toBeVisible();
  });

  test("unknown username shows error", async ({
    page,
    remoteClientURL,
    wsURL,
  }) => {
    await page.goto(remoteClientURL);

    // Fill in login form with unknown username
    await page.fill('[data-testid="ws-url-input"]', wsURL);
    await page.fill('[data-testid="username-input"]', "unknown-user");
    await page.fill('[data-testid="password-input"]', TEST_PASSWORD);

    // Submit form
    await page.click('[data-testid="login-button"]');

    // Verify error message appears
    await expect(page.locator('[data-testid="login-error"]')).toBeVisible({
      timeout: 10000,
    });

    // Verify we're still on login page
    await expect(page.locator('[data-testid="login-form"]')).toBeVisible();
  });

  test("server unreachable shows connection error", async ({
    page,
    remoteClientURL,
  }) => {
    await page.goto(remoteClientURL);

    // Fill in login form with unreachable server
    await page.fill(
      '[data-testid="ws-url-input"]',
      "ws://localhost:9999/api/ws",
    );
    await page.fill('[data-testid="username-input"]', TEST_USERNAME);
    await page.fill('[data-testid="password-input"]', TEST_PASSWORD);

    // Submit form
    await page.click('[data-testid="login-button"]');

    // Verify error message appears
    await expect(page.locator('[data-testid="login-error"]')).toBeVisible({
      timeout: 10000,
    });

    // Verify we're still on login page
    await expect(page.locator('[data-testid="login-form"]')).toBeVisible();
  });

  test("empty fields show validation error", async ({
    page,
    remoteClientURL,
  }) => {
    await page.goto(remoteClientURL);

    // Clear the server URL field (it has a default value)
    await page.fill('[data-testid="ws-url-input"]', "");

    // Submit form with empty fields
    await page.click('[data-testid="login-button"]');

    // Verify error message appears (client-side validation)
    await expect(page.locator('[data-testid="login-error"]')).toBeVisible();
    await expect(page.locator('[data-testid="login-error"]')).toContainText(
      /required/i,
    );
  });
});

/**
 * Helper function to perform login through the remote client UI.
 */
async function loginViaRemoteClient(
  page: import("@playwright/test").Page,
  remoteClientURL: string,
  wsURL: string,
  username: string,
  password: string,
) {
  await page.goto(remoteClientURL);
  await page.fill('[data-testid="ws-url-input"]', wsURL);
  await page.fill('[data-testid="username-input"]', username);
  await page.fill('[data-testid="password-input"]', password);
  await page.click('[data-testid="login-button"]');

  // Wait for login form to disappear
  await expect(page.locator('[data-testid="login-form"]')).not.toBeVisible({
    timeout: 10000,
  });

  // Verify sidebar is visible (main app loaded)
  await expect(page.locator(".sidebar")).toBeVisible({ timeout: 5000 });
}

test.describe("Session Resumption", () => {
  test.beforeEach(async ({ baseURL, page }) => {
    // Configure remote access with test credentials
    await configureRemoteAccess(baseURL, {
      username: TEST_USERNAME,
      password: TEST_PASSWORD,
    });
    // Clear localStorage for fresh state
    await page.addInitScript(() => {
      localStorage.clear();
      sessionStorage.clear();
    });
  });

  test.afterEach(async ({ baseURL }) => {
    await disableRemoteAccess(baseURL);
  });

  test("login with remember me, refresh page, still authenticated", async ({
    page,
    remoteClientURL,
    wsURL,
  }) => {
    await page.goto(remoteClientURL);

    // Fill in login form with "Remember me" checked
    await page.fill('[data-testid="ws-url-input"]', wsURL);
    await page.fill('[data-testid="username-input"]', TEST_USERNAME);
    await page.fill('[data-testid="password-input"]', TEST_PASSWORD);

    // Ensure "Remember me" is checked
    const rememberMeCheckbox = page.locator(
      '[data-testid="remember-me-checkbox"]',
    );
    await rememberMeCheckbox.check();

    // Submit form
    await page.click('[data-testid="login-button"]');

    // Wait for successful login (sidebar visible)
    await expect(page.locator(".sidebar")).toBeVisible({ timeout: 10000 });

    // Verify credentials are stored (for debugging)
    const storedCreds = await page.evaluate(() => {
      return localStorage.getItem("yep-anywhere-remote-credentials");
    });
    expect(storedCreds).not.toBeNull();
    // biome-ignore lint/style/noNonNullAssertion: We just asserted it's not null
    const parsed = JSON.parse(storedCreds!);
    expect(parsed.session).toBeDefined();
    expect(parsed.session.sessionId).toBeDefined();
    expect(parsed.session.sessionKey).toBeDefined();

    // Refresh the page
    await page.reload();

    // Should show auto-resume loading briefly, then main app
    // Wait for sidebar to be visible (auto-resume succeeded)
    await expect(page.locator(".sidebar")).toBeVisible({ timeout: 10000 });

    // Verify login form is NOT visible (we're authenticated)
    await expect(page.locator('[data-testid="login-form"]')).not.toBeVisible();
  });

  test("login without remember me, refresh page, shows login form", async ({
    page,
    remoteClientURL,
    wsURL,
  }) => {
    await page.goto(remoteClientURL);

    // Fill in login form with "Remember me" unchecked
    await page.fill('[data-testid="ws-url-input"]', wsURL);
    await page.fill('[data-testid="username-input"]', TEST_USERNAME);
    await page.fill('[data-testid="password-input"]', TEST_PASSWORD);

    // Uncheck "Remember me"
    const rememberMeCheckbox = page.locator(
      '[data-testid="remember-me-checkbox"]',
    );
    await rememberMeCheckbox.uncheck();

    // Submit form
    await page.click('[data-testid="login-button"]');

    // Wait for successful login
    await expect(page.locator(".sidebar")).toBeVisible({ timeout: 10000 });

    // Verify session is NOT stored
    const storedCreds = await page.evaluate(() => {
      return localStorage.getItem("yep-anywhere-remote-credentials");
    });
    if (storedCreds) {
      const parsed = JSON.parse(storedCreds);
      expect(parsed.session).toBeUndefined();
    }

    // Refresh the page
    await page.reload();

    // Should show login form again (no stored session)
    await expect(page.locator('[data-testid="login-form"]')).toBeVisible({
      timeout: 10000,
    });
  });

  test("password change invalidates stored session", async ({
    page,
    baseURL,
    remoteClientURL,
    wsURL,
  }) => {
    await page.goto(remoteClientURL);

    // Login with "Remember me" checked
    await page.fill('[data-testid="ws-url-input"]', wsURL);
    await page.fill('[data-testid="username-input"]', TEST_USERNAME);
    await page.fill('[data-testid="password-input"]', TEST_PASSWORD);
    await page.locator('[data-testid="remember-me-checkbox"]').check();
    await page.click('[data-testid="login-button"]');

    // Wait for successful login
    await expect(page.locator(".sidebar")).toBeVisible({ timeout: 10000 });

    // Change password via API (this should invalidate all sessions)
    const NEW_PASSWORD = "new-password-456";
    await configureRemoteAccess(baseURL, {
      username: TEST_USERNAME,
      password: NEW_PASSWORD,
    });

    // Refresh the page - stored session should now be invalid
    await page.reload();

    // Should show login form (session was invalidated)
    await expect(page.locator('[data-testid="login-form"]')).toBeVisible({
      timeout: 10000,
    });

    // The old password should NOT work
    await page.fill('[data-testid="password-input"]', TEST_PASSWORD);
    await page.click('[data-testid="login-button"]');
    await expect(page.locator('[data-testid="login-error"]')).toBeVisible({
      timeout: 10000,
    });

    // But the new password should work
    await page.fill('[data-testid="password-input"]', NEW_PASSWORD);
    await page.click('[data-testid="login-button"]');
    await expect(page.locator(".sidebar")).toBeVisible({ timeout: 10000 });
  });

  test("session auto-resumes after brief disconnect", async ({
    page,
    remoteClientURL,
    wsURL,
  }) => {
    await page.goto(remoteClientURL);

    // Login with "Remember me" checked
    await page.fill('[data-testid="ws-url-input"]', wsURL);
    await page.fill('[data-testid="username-input"]', TEST_USERNAME);
    await page.fill('[data-testid="password-input"]', TEST_PASSWORD);
    await page.locator('[data-testid="remember-me-checkbox"]').check();
    await page.click('[data-testid="login-button"]');

    // Wait for successful login
    await expect(page.locator(".sidebar")).toBeVisible({ timeout: 10000 });

    // Navigate away and back (simulates closing and reopening tab)
    await page.goto("about:blank");
    await page.goto(remoteClientURL);

    // Should auto-resume and show main app
    await expect(page.locator(".sidebar")).toBeVisible({ timeout: 10000 });
    await expect(page.locator('[data-testid="login-form"]')).not.toBeVisible();
  });
});

test.describe("Encrypted Data Flow", () => {
  test.beforeEach(async ({ baseURL, page }) => {
    // Configure remote access with test credentials
    await configureRemoteAccess(baseURL, {
      username: TEST_USERNAME,
      password: TEST_PASSWORD,
    });
    // Clear localStorage for fresh state
    await page.addInitScript(() => {
      localStorage.clear();
      sessionStorage.clear();
    });
  });

  test.afterEach(async ({ baseURL }) => {
    await disableRemoteAccess(baseURL);
  });

  test("sidebar navigation loads via SecureConnection", async ({
    page,
    remoteClientURL,
    wsURL,
  }) => {
    await loginViaRemoteClient(
      page,
      remoteClientURL,
      wsURL,
      TEST_USERNAME,
      TEST_PASSWORD,
    );

    // The sidebar should show navigation items (loaded via encrypted WS)
    // Check for navigation links which proves API requests work
    await expect(page.locator('a[href="/projects"]')).toBeVisible();
    await expect(page.locator('a[href="/settings"]')).toBeVisible();
    await expect(page.locator('a[href="/inbox"]')).toBeVisible();
  });

  test("activity subscription receives events", async ({
    page,
    remoteClientURL,
    wsURL,
  }) => {
    await loginViaRemoteClient(
      page,
      remoteClientURL,
      wsURL,
      TEST_USERNAME,
      TEST_PASSWORD,
    );

    // The sidebar shows recent sessions, which requires activity subscription
    // Check that the "Last 24 Hours" section is visible (populated by activity events)
    // Note: This section only appears if there are sessions, so we check for sidebar-section
    const sidebarSections = page.locator(".sidebar-section");

    // Should have at least one section (Starred or Last 24 Hours)
    // This proves the activity subscription is working
    await expect(sidebarSections.first()).toBeVisible({ timeout: 5000 });
  });

  test("mock project visible in sidebar", async ({
    page,
    remoteClientURL,
    wsURL,
  }) => {
    await loginViaRemoteClient(
      page,
      remoteClientURL,
      wsURL,
      TEST_USERNAME,
      TEST_PASSWORD,
    );

    // The mock project session should be visible in the sidebar
    // This proves session data is loaded via encrypted WebSocket
    await expect(page.getByText("mockproject").first()).toBeVisible({
      timeout: 5000,
    });
  });
});
