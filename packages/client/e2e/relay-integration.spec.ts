/**
 * E2E tests for Full Relay Integration.
 *
 * Tests the complete flow: yepanywhere server -> relay server -> remote client.
 * This verifies that all components work together end-to-end.
 *
 * Test scenarios:
 * 1. Connect via relay, authenticate, verify app loads
 * 2. Refresh page, verify session persists (auto-resume)
 * 3. Verify projects load via relay connection
 */

import { mkdir, rm, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import {
  BinaryFormat,
  PUBLIC_SHARE_SESSION_CHUNK_MAX_BYTES,
  PUBLIC_SHARE_SESSION_COMPRESSED_MAX_BYTES,
  TRANSPORT_CHUNK_HEADER_SIZE,
  TRANSPORT_CHUNK_PAYLOAD_MAX_BYTES,
  isPublicSessionSharePublicMetadata,
} from "@yep-anywhere/shared";
import {
  configureRelay,
  configureRemoteAccess,
  disableRelay,
  disableRemoteAccess,
  e2ePaths,
  expect,
  test,
  waitForRelayStatus,
} from "./fixtures.js";

// Test credentials
// Relay username is also used as SRP identity
const TEST_RELAY_USERNAME = "e2e-relay-test";
const TEST_SRP_PASSWORD = "relay-test-password-123";
const LEGACY_PREAUTH_RELAY_MAX_BYTES = 8 * 1024 * 1024;
const LARGE_ASSISTANT_NOISE_BYTES = 2304 * 1024;
const LARGE_SHARE_NOISE_BYTES = 10 * 1024 * 1024;

function relayAppPath(path = "projects"): string {
  return `/-/relay/${TEST_RELAY_USERNAME}/${path}`;
}

function remoteRelayUrl(remoteClientURL: string, path = "projects"): string {
  return `${remoteClientURL}${relayAppPath(path)}`;
}

function deterministicNoise(byteLength: number): Buffer {
  const bytes = Buffer.allocUnsafe(byteLength);
  let state = 0x6d2b_79f5;
  for (let offset = 0; offset < byteLength; ) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    for (
      let byteIndex = 0;
      byteIndex < 4 && offset < byteLength;
      byteIndex += 1
    ) {
      bytes[offset] = (state >>> (byteIndex * 8)) & 0xff;
      offset += 1;
    }
  }
  return bytes;
}

/**
 * Helper to navigate to the Relay Login page from the mode selection page.
 */
async function goToRelayLogin(page: import("@playwright/test").Page) {
  await page.click('[data-testid="relay-mode-button"]');
  await expect(page.locator('[data-testid="relay-login-form"]')).toBeVisible();
}

async function loginViaRelay(
  page: import("@playwright/test").Page,
  remoteClientURL: string,
  relayWsURL: string,
): Promise<void> {
  await page.goto(remoteClientURL);
  await goToRelayLogin(page);
  await page.fill('[data-testid="relay-username-input"]', TEST_RELAY_USERNAME);
  await page.fill('[data-testid="srp-password-input"]', TEST_SRP_PASSWORD);
  await page.click("text=Show Advanced Options");
  await page.fill('[data-testid="custom-relay-url-input"]', relayWsURL);
  await page.click('[data-testid="login-button"]');
  await expect(
    page.locator('[data-testid="relay-login-form"]'),
  ).not.toBeVisible({ timeout: 15_000 });
}

async function putSettings(baseURL: string, body: unknown): Promise<void> {
  const response = await fetch(`${baseURL}/api/settings`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      "X-Yep-Anywhere": "true",
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`Failed to configure settings: ${await response.text()}`);
  }
}

async function setBangHistoryVisibility(
  baseURL: string,
  enabled: boolean,
): Promise<void> {
  const response = await fetch(`${baseURL}/api/settings`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      "X-Yep-Anywhere": "true",
    },
    body: JSON.stringify({
      clientDefaults: { bangCommandsEnabled: enabled },
    }),
  });
  if (!response.ok) {
    throw new Error(
      `Failed to configure bang history: ${await response.text()}`,
    );
  }
}

test.describe("Full Relay Integration", () => {
  test.beforeEach(async ({ baseURL, relayWsURL }) => {
    // Configure remote access with test credentials
    // This configures relay (with username as SRP identity) and sets the password
    await configureRemoteAccess(baseURL, {
      username: TEST_RELAY_USERNAME,
      password: TEST_SRP_PASSWORD,
      relayUrl: relayWsURL,
    });

    // Wait for relay client to connect and register
    await waitForRelayStatus(baseURL, "waiting", 15000);
  });

  test.afterEach(async ({ baseURL }) => {
    await disableRelay(baseURL);
    await disableRemoteAccess(baseURL);
  });

  test("connect via relay, login, and verify app loads", async ({
    page,
    remoteClientURL,
    relayWsURL,
  }) => {
    await page.goto(remoteClientURL);
    await goToRelayLogin(page);

    // Fill in relay login form (username is both relay ID and SRP identity)
    await page.fill(
      '[data-testid="relay-username-input"]',
      TEST_RELAY_USERNAME,
    );
    await page.fill('[data-testid="srp-password-input"]', TEST_SRP_PASSWORD);

    // Show advanced options to set custom relay URL (local test relay)
    await page.click("text=Show Advanced Options");
    await page.fill('[data-testid="custom-relay-url-input"]', relayWsURL);

    // Submit form
    await page.click('[data-testid="login-button"]');

    // Wait for login form to disappear (indicates successful login)
    await expect(
      page.locator('[data-testid="relay-login-form"]'),
    ).not.toBeVisible({
      timeout: 15000,
    });

    // Verify we're in the main app (sidebar visible)
    await expect(page.locator(".sidebar")).toBeVisible({
      timeout: 10000,
    });

    // Verify navigation items are present (proves API requests work through relay)
    // In relay mode, URLs are prefixed with the relay username
    await expect(page.locator(`a[href="${relayAppPath()}"]`)).toBeVisible();
    await expect(
      page.locator(`a[href="${relayAppPath("settings")}"]`),
    ).toBeVisible();
  });

  test("explicit relay handoff preserves its source without remembered credentials", async ({
    page,
    remoteClientURL,
    relayWsURL,
  }) => {
    const target = (username: string, relayUrl: string) =>
      `/login/relay?${new URLSearchParams({
        u: username,
        r: relayUrl,
        returnTo: relayAppPath("settings"),
      })}`;
    for (const [otherUsername, otherRelay] of [
      ["another-machine", relayWsURL],
      [TEST_RELAY_USERNAME, "wss://different-relay.invalid/ws"],
    ] as const) {
      await page.goto(
        `${remoteClientURL}${target(TEST_RELAY_USERNAME, relayWsURL)}`,
      );
      await page.fill('[data-testid="srp-password-input"]', TEST_SRP_PASSWORD);
      await page.locator('[data-testid="remember-me-checkbox"]').uncheck();
      await page.click('[data-testid="login-button"]');
      await expect(page).toHaveURL(
        `${remoteClientURL}${relayAppPath("settings")}`,
      );
      await expect(page.locator(".sidebar")).toBeVisible();

      // A client-side handoff initially encounters the existing connection.
      // Leaving its route may then release that source's demand.
      await page.evaluate(
        (next) => {
          history.pushState(null, "", next);
          window.dispatchEvent(new PopStateEvent("popstate"));
        },
        target(otherUsername, otherRelay),
      );
      await expect(
        page.locator('[data-testid="relay-login-form"]'),
      ).toBeVisible();
      await expect(
        page.locator('[data-testid="relay-username-input"]'),
      ).toHaveValue(otherUsername);
      await expect(
        page.locator('[data-testid="custom-relay-url-input"]'),
      ).toHaveValue(otherRelay);
    }
  });

  test("development settings links to the configured relay monitor", async ({
    page,
    remoteClientURL,
    relayWsURL,
  }) => {
    await loginViaRelay(page, remoteClientURL, relayWsURL);
    await page.goto(remoteRelayUrl(remoteClientURL, "settings/development"));

    const relayUrl = new URL(relayWsURL);
    relayUrl.protocol = relayUrl.protocol === "wss:" ? "https:" : "http:";
    relayUrl.pathname = relayUrl.pathname.replace(/\/ws$/, "/stats");
    await expect(
      page.getByRole("link", { name: "Open Relay Monitor" }),
    ).toHaveAttribute("href", relayUrl.toString());
  });

  test("large assistant content stays viewable directly and uses bounded relay chunks", async ({
    page,
    baseURL,
    remoteClientURL,
    relayWsURL,
  }) => {
    test.setTimeout(45_000);
    const projectPath = join(e2ePaths.tempDir, "large-assistant-project");
    const projectId = Buffer.from(projectPath).toString("base64url");
    const sessionId = "large-assistant-session";
    const sessionDirectory = join(
      e2ePaths.claudeSessionsDir,
      hostname(),
      projectPath.replace(/\//g, "-"),
    );
    const sessionFile = join(sessionDirectory, `${sessionId}.jsonl`);
    const timestamp = new Date().toISOString();
    const transcript = [
      {
        type: "user",
        cwd: projectPath,
        message: { role: "user", content: "show generated content" },
        timestamp,
        uuid: "large-assistant-user",
      },
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            {
              type: "text",
              text: deterministicNoise(LARGE_ASSISTANT_NOISE_BYTES).toString(
                "base64",
              ),
            },
            { type: "text", text: "large assistant trailing marker" },
          ],
        },
        timestamp,
        uuid: "large-assistant-response",
        parentUuid: "large-assistant-user",
      },
    ];
    const relayTransportChunkSizes: number[] = [];
    let observeRelayChunks = false;
    page.on("websocket", (socket) => {
      socket.on("framereceived", ({ payload }) => {
        if (!observeRelayChunks || typeof payload === "string") return;
        const bytes = Buffer.from(payload);
        if (bytes[0] === BinaryFormat.TRANSPORT_CHUNK) {
          relayTransportChunkSizes.push(bytes.byteLength);
        }
      });
    });

    await mkdir(projectPath, { recursive: true });
    await mkdir(sessionDirectory, { recursive: true });
    await writeFile(
      sessionFile,
      transcript.map((message) => JSON.stringify(message)).join("\n"),
    );

    try {
      await expect
        .poll(
          async () =>
            (
              await fetch(
                `${baseURL}/api/projects/${projectId}/sessions/${sessionId}?fullHistory=1`,
                { headers: { "X-Yep-Anywhere": "true" } },
              )
            ).status,
          { timeout: 10_000 },
        )
        .toBe(200);
      await page.goto(`${baseURL}/projects/${projectId}/sessions/${sessionId}`);
      await expect(
        page.getByText("large assistant trailing marker", { exact: true }),
      ).toBeVisible({ timeout: 20_000 });

      observeRelayChunks = true;
      await loginViaRelay(page, remoteClientURL, relayWsURL);
      await page.goto(
        remoteRelayUrl(
          remoteClientURL,
          `projects/${projectId}/sessions/${sessionId}`,
        ),
      );
      await expect(
        page.getByText("large assistant trailing marker", { exact: true }),
      ).toBeVisible({ timeout: 20_000 });
      expect(relayTransportChunkSizes.length).toBeGreaterThan(1);
      expect(
        relayTransportChunkSizes.every(
          (size) =>
            size <=
            1 + TRANSPORT_CHUNK_HEADER_SIZE + TRANSPORT_CHUNK_PAYLOAD_MAX_BYTES,
        ),
      ).toBe(true);
    } finally {
      await rm(sessionFile);
    }
  });

  test("large user upload crosses relay in bounded upload chunks", async ({
    page,
    baseURL,
    remoteClientURL,
    relayWsURL,
  }) => {
    test.setTimeout(45_000);
    const projectPath = join(e2ePaths.tempDir, "large-upload-project");
    const projectId = Buffer.from(projectPath).toString("base64url");
    const sessionId = "large-upload-session";
    const sessionDirectory = join(
      e2ePaths.claudeSessionsDir,
      hostname(),
      projectPath.replace(/\//g, "-"),
    );
    const sessionFile = join(sessionDirectory, `${sessionId}.jsonl`);
    const timestamp = new Date().toISOString();
    const uploadBytes = deterministicNoise(LARGE_ASSISTANT_NOISE_BYTES);
    const sentFrameSizes: number[] = [];
    let observeUploadFrames = false;
    page.on("websocket", (socket) => {
      socket.on("framesent", ({ payload }) => {
        if (!observeUploadFrames || typeof payload === "string") return;
        sentFrameSizes.push(Buffer.from(payload).byteLength);
      });
    });

    await mkdir(projectPath, { recursive: true });
    await mkdir(sessionDirectory, { recursive: true });
    await writeFile(
      sessionFile,
      JSON.stringify({
        type: "user",
        cwd: projectPath,
        message: { role: "user", content: "attach generated content" },
        timestamp,
        uuid: "large-upload-user",
      }),
    );

    try {
      await expect
        .poll(
          async () =>
            (
              await fetch(
                `${baseURL}/api/projects/${projectId}/sessions/${sessionId}?fullHistory=1`,
                { headers: { "X-Yep-Anywhere": "true" } },
              )
            ).status,
          { timeout: 10_000 },
        )
        .toBe(200);
      await loginViaRelay(page, remoteClientURL, relayWsURL);
      await page.goto(
        remoteRelayUrl(
          remoteClientURL,
          `projects/${projectId}/sessions/${sessionId}`,
        ),
      );
      await expect(page.locator('input[type="file"]')).toHaveCount(1);

      observeUploadFrames = true;
      await page.locator('input[type="file"]').setInputFiles({
        name: "large-generated-upload.bin",
        mimeType: "application/octet-stream",
        buffer: uploadBytes,
      });
      await expect(
        page.getByRole("button", {
          name: "Remove large-generated-upload.bin",
          exact: true,
        }),
      ).toBeVisible({ timeout: 20_000 });
      observeUploadFrames = false;

      expect(sentFrameSizes.every((size) => size <= 1024 * 1024)).toBe(true);
      expect(
        sentFrameSizes.filter((size) => size > 60 * 1024).length,
      ).toBeGreaterThan(20);
    } finally {
      await rm(sessionFile);
    }
  });

  test("large frozen public share uses bounded relay chunks", async ({
    page,
    baseURL,
    remoteClientURL,
  }) => {
    test.setTimeout(45_000);
    const projectPath = join(e2ePaths.tempDir, "bounded-share-project");
    const projectId = Buffer.from(projectPath).toString("base64url");
    const sessionId = "bounded-public-share-session";
    const sessionDirectory = join(
      e2ePaths.claudeSessionsDir,
      hostname(),
      projectPath.replace(/\//g, "-"),
    );
    const sessionFile = join(sessionDirectory, `${sessionId}.jsonl`);
    const timestamp = new Date().toISOString();
    const transcript = [
      {
        type: "user",
        cwd: projectPath,
        message: { role: "user", content: "bounded relay marker" },
        timestamp,
        uuid: "bounded-user-1",
      },
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: deterministicNoise(LARGE_SHARE_NOISE_BYTES).toString(
            "base64",
          ),
        },
        timestamp,
        uuid: "bounded-assistant-1",
        parentUuid: "bounded-user-1",
      },
      {
        type: "user",
        cwd: projectPath,
        message: {
          role: "user",
          content: "chunk transfer trailing transcript marker",
        },
        timestamp,
        uuid: "bounded-user-2",
        parentUuid: "bounded-assistant-1",
      },
      // A newly written transcript is externally active. Frozen capture
      // excludes its last user turn, so put the marker in a completed turn
      // before an explicit active suffix.
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: "The final fixture turn is complete.",
        },
        timestamp,
        uuid: "bounded-assistant-2",
        parentUuid: "bounded-user-2",
      },
      {
        type: "user",
        cwd: projectPath,
        message: { role: "user", content: "Pending fixture turn" },
        timestamp,
        uuid: "bounded-user-3",
        parentUuid: "bounded-assistant-2",
      },
    ];

    await mkdir(projectPath, { recursive: true });
    await mkdir(sessionDirectory, { recursive: true });
    await writeFile(
      sessionFile,
      transcript.map((message) => JSON.stringify(message)).join("\n"),
    );
    await putSettings(baseURL, { publicSharesEnabled: true });

    try {
      await expect
        .poll(
          async () =>
            (
              await fetch(
                `${baseURL}/api/projects/${projectId}/sessions/${sessionId}?fullHistory=1`,
                { headers: { "X-Yep-Anywhere": "true" } },
              )
            ).status,
          { timeout: 10_000 },
        )
        .toBe(200);
      const createResponse = await fetch(`${baseURL}/api/public-shares`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Yep-Anywhere": "true",
        },
        body: JSON.stringify({ projectId, sessionId, mode: "frozen" }),
      });
      expect(createResponse.ok).toBe(true);
      const created = (await createResponse.json()) as { url: string };
      const shareUrl = new URL(created.url);
      const secret = shareUrl.pathname.split("/").at(-1);
      expect(secret).toBeTruthy();
      const metadataResponse = await fetch(
        `${baseURL}/public-api/shares/${secret}/metadata`,
      );
      expect(metadataResponse.ok).toBe(true);
      const metadata: unknown = await metadataResponse.json();
      expect(isPublicSessionSharePublicMetadata(metadata)).toBe(true);
      if (
        !isPublicSessionSharePublicMetadata(metadata) ||
        !metadata.sessionChunks
      ) {
        throw new Error("Frozen public share did not advertise chunk metadata");
      }
      expect(metadata.sessionChunks.compressedBytes).toBeGreaterThan(
        LEGACY_PREAUTH_RELAY_MAX_BYTES,
      );
      expect(metadata.sessionChunks.compressedBytes).toBeLessThanOrEqual(
        PUBLIC_SHARE_SESSION_COMPRESSED_MAX_BYTES,
      );
      expect(metadata.sessionChunks.maxChunkBytes).toBe(
        PUBLIC_SHARE_SESSION_CHUNK_MAX_BYTES,
      );

      const viewerUrl = new URL(
        `${shareUrl.pathname}${shareUrl.search}${shareUrl.hash}`,
        remoteClientURL,
      );
      const chunkSizes: number[] = [];
      page.on("websocket", (socket) => {
        socket.on("framereceived", ({ payload }) => {
          if (typeof payload !== "string") return;
          let message: unknown;
          try {
            message = JSON.parse(payload);
          } catch {
            return;
          }
          const body = (message as { body?: unknown }).body;
          if (
            body &&
            typeof body === "object" &&
            (body as { _binary?: unknown })._binary === true &&
            typeof (body as { data?: unknown }).data === "string"
          ) {
            chunkSizes.push(
              Buffer.from((body as { data: string }).data, "base64").byteLength,
            );
          }
        });
      });

      await page.goto(viewerUrl.toString());
      await expect(
        page.getByText("chunk transfer trailing transcript marker", {
          exact: true,
        }),
      ).toBeVisible({ timeout: 20_000 });
      expect(chunkSizes.length).toBeGreaterThan(1);
      expect(
        chunkSizes.every(
          (size) => size <= PUBLIC_SHARE_SESSION_CHUNK_MAX_BYTES,
        ),
      ).toBe(true);
    } finally {
      await putSettings(baseURL, { publicSharesEnabled: false });
      await rm(sessionFile);
    }
  });

  test("!! Commands sidebar category stays on its relay route", async ({
    page,
    baseURL,
    remoteClientURL,
    relayWsURL,
  }) => {
    await setBangHistoryVisibility(baseURL, true);
    try {
      await page.setViewportSize({ width: 375, height: 812 });
      await page.goto(remoteClientURL);
      await goToRelayLogin(page);
      await page.fill(
        '[data-testid="relay-username-input"]',
        TEST_RELAY_USERNAME,
      );
      await page.fill('[data-testid="srp-password-input"]', TEST_SRP_PASSWORD);
      await page.click("text=Show Advanced Options");
      await page.fill('[data-testid="custom-relay-url-input"]', relayWsURL);
      await page.click('[data-testid="login-button"]');
      await expect(
        page.locator('[data-testid="relay-login-form"]'),
      ).not.toBeVisible({ timeout: 15000 });
      const openSidebar = page.getByRole("button", { name: "Open sidebar" });
      await expect(openSidebar).toBeVisible();
      await openSidebar.click();

      const bangHistoryLink = page.locator(
        `a[href="${relayAppPath("bang-commands")}"]`,
      );
      await expect(bangHistoryLink).toBeVisible();
      await bangHistoryLink.click();

      await expect(page).toHaveURL(
        new RegExp(`${relayAppPath("bang-commands")}$`),
      );
      await expect(
        page.getByText("No local commands have been run yet."),
      ).toBeVisible({ timeout: 10_000 });
      await openSidebar.click();
      await expect(bangHistoryLink).toHaveClass(/\bactive\b/);
    } finally {
      await setBangHistoryVisibility(baseURL, false);
    }
  });

  // This test verifies that sessions persist across page refresh via relay.
  test("session persists after page refresh (auto-resume)", async ({
    page,
    remoteClientURL,
    relayWsURL,
  }) => {
    // First login via relay
    await page.goto(remoteClientURL);
    await page.evaluate(() => {
      localStorage.clear();
      sessionStorage.clear();
    });
    await page.reload();
    await goToRelayLogin(page);

    // Fill in relay login form with "Remember me" checked
    await page.fill(
      '[data-testid="relay-username-input"]',
      TEST_RELAY_USERNAME,
    );
    await page.fill('[data-testid="srp-password-input"]', TEST_SRP_PASSWORD);

    // Ensure "Remember me" is checked
    const rememberMeCheckbox = page.locator(
      '[data-testid="remember-me-checkbox"]',
    );
    await rememberMeCheckbox.check();

    // Show advanced options to set custom relay URL
    await page.click("text=Show Advanced Options");
    await page.fill('[data-testid="custom-relay-url-input"]', relayWsURL);

    // Submit form
    await page.click('[data-testid="login-button"]');

    // Wait for successful login
    await expect(page.locator(".sidebar")).toBeVisible({ timeout: 15000 });

    // Verify credentials are stored
    const storedCreds = await page.evaluate(() => {
      return localStorage.getItem("yep-anywhere-remote-credentials");
    });
    expect(storedCreds).not.toBeNull();

    // Parse and verify the stored credentials have all needed fields
    const parsedCreds = JSON.parse(storedCreds as string);
    console.log(
      "[Test] Stored credentials:",
      JSON.stringify(parsedCreds, null, 2),
    );
    expect(parsedCreds.wsUrl).toBeDefined();
    expect(parsedCreds.mode).toBe("relay");
    expect(parsedCreds.relayUsername).toBe(TEST_RELAY_USERNAME);
    expect(parsedCreds.session).toBeDefined();

    // Refresh the page
    await page.reload();

    // Wait for auto-resume to complete - it should either:
    // 1. Show the sidebar (success)
    // 2. Show the mode selection page (isAutoResuming=false, failed)
    // 3. Show relay login form (failed)
    // We want #1.
    //
    // Note: auto-resume loading indicator might not be visible if React
    // renders too fast or if auto-resume fails immediately.

    // First, give the app a moment to start auto-resume
    await page.waitForTimeout(500);

    // Now wait for the sidebar OR detect failure states
    try {
      await expect(page.locator(".sidebar")).toBeVisible({ timeout: 20000 });
    } catch {
      // If sidebar isn't visible, check if we're on a failure state and fail with better message
      const modePageVisible = await page
        .locator('[data-testid="relay-mode-button"]')
        .isVisible();
      const loginFormVisible = await page
        .locator('[data-testid="relay-login-form"]')
        .isVisible();

      if (modePageVisible) {
        throw new Error(
          "Auto-resume failed: mode selection page is shown instead of main app. Auto-resume may not have attempted.",
        );
      }
      if (loginFormVisible) {
        throw new Error(
          "Auto-resume failed: login form is shown instead of main app. Auto-resume attempted but failed.",
        );
      }
      throw new Error(
        "Auto-resume failed: neither sidebar, mode page, nor login form visible.",
      );
    }

    await expect(
      page.locator('[data-testid="relay-login-form"]'),
    ).not.toBeVisible();

    // Verify projects are still accessible after refresh
    // In relay mode, URLs are prefixed with the relay username
    await expect(page.locator(`a[href="${relayAppPath()}"]`)).toBeVisible();
  });

  test("old relay resume session falls back to fresh login", async ({
    page,
    remoteClientURL,
    relayWsURL,
  }) => {
    await page.addInitScript(
      (params: { relayUrl: string; relayUsername: string }) => {
        const { relayUrl, relayUsername } = params;
        localStorage.clear();
        sessionStorage.clear();
        const staleSession = {
          wsUrl: relayUrl,
          username: relayUsername,
          sessionId: "stale-session",
          sessionKey: btoa("stale session key material"),
          resumeProtocolVersion: 2,
        };
        localStorage.setItem(
          "yep-anywhere-remote-credentials",
          JSON.stringify({
            wsUrl: relayUrl,
            username: relayUsername,
            mode: "relay",
            relayUsername,
            session: staleSession,
          }),
        );
        localStorage.setItem(
          "yep-anywhere-saved-hosts",
          JSON.stringify({
            version: 1,
            hosts: [
              {
                id: "stale-relay-host",
                displayName: relayUsername,
                mode: "relay",
                relayUrl,
                relayUsername,
                srpUsername: relayUsername,
                session: staleSession,
                createdAt: new Date().toISOString(),
              },
            ],
          }),
        );
      },
      { relayUrl: relayWsURL, relayUsername: TEST_RELAY_USERNAME },
    );

    await page.goto(`${remoteClientURL}/${TEST_RELAY_USERNAME}/projects`);

    await expect(page.locator('[data-testid="relay-login-form"]')).toBeVisible({
      timeout: 10000,
    });
    expect(new URL(page.url()).searchParams.get("returnTo")).toBe(
      relayAppPath(),
    );
    await expect(
      page.locator('[data-testid="relay-username-input"]'),
    ).toHaveValue(TEST_RELAY_USERNAME);
    await expect(
      page.locator('[data-testid="custom-relay-url-input"]'),
    ).toHaveValue(relayWsURL);

    const stored = await page.evaluate(() => ({
      credentials: localStorage.getItem("yep-anywhere-remote-credentials"),
      hosts: localStorage.getItem("yep-anywhere-saved-hosts"),
    }));
    expect(JSON.parse(stored.credentials ?? "{}").session).toBeUndefined();
    const savedHosts = JSON.parse(stored.hosts ?? '{"hosts":[]}') as {
      hosts: Array<{ session?: unknown }>;
    };
    expect(savedHosts.hosts[0]?.session).toBeUndefined();
  });

  test("fresh relay login updates stale saved host relay URL", async ({
    page,
    remoteClientURL,
    relayWsURL,
  }) => {
    await page.addInitScript((relayUsername: string) => {
      localStorage.clear();
      sessionStorage.clear();
      localStorage.setItem(
        "yep-anywhere-saved-hosts",
        JSON.stringify({
          version: 1,
          hosts: [
            {
              id: "stale-relay-host",
              displayName: relayUsername,
              mode: "relay",
              relayUrl: "wss://relay.yepanywhere.com/ws",
              relayUsername,
              srpUsername: relayUsername,
              createdAt: new Date().toISOString(),
            },
          ],
        }),
      );
    }, TEST_RELAY_USERNAME);

    const params = new URLSearchParams({
      u: TEST_RELAY_USERNAME,
      r: relayWsURL,
    });
    await page.goto(`${remoteClientURL}/login/relay?${params.toString()}`);

    await page.fill('[data-testid="srp-password-input"]', TEST_SRP_PASSWORD);
    await page.click('[data-testid="login-button"]');

    await expect(page.locator(".sidebar")).toBeVisible({ timeout: 15000 });

    const savedHosts = await page.evaluate(() =>
      JSON.parse(localStorage.getItem("yep-anywhere-saved-hosts") ?? "{}"),
    );
    expect(savedHosts.hosts[0]?.relayUrl).toBe(relayWsURL);
    expect(savedHosts.hosts[0]?.session).toBeDefined();
  });

  test("mock project visible through relay connection", async ({
    page,
    remoteClientURL,
    relayWsURL,
  }) => {
    await page.goto(remoteClientURL);
    await goToRelayLogin(page);

    // Fill in relay login form (username is both relay ID and SRP identity)
    await page.fill(
      '[data-testid="relay-username-input"]',
      TEST_RELAY_USERNAME,
    );
    await page.fill('[data-testid="srp-password-input"]', TEST_SRP_PASSWORD);

    // Show advanced options to set custom relay URL
    await page.click("text=Show Advanced Options");
    await page.fill('[data-testid="custom-relay-url-input"]', relayWsURL);

    // Submit form
    await page.click('[data-testid="login-button"]');

    // Wait for successful login
    await expect(page.locator(".sidebar")).toBeVisible({ timeout: 15000 });

    // The mock project session should be visible in the sidebar
    // This proves session data is loaded via encrypted WebSocket through relay
    await expect(page.getByText("mockproject").first()).toBeVisible({
      timeout: 10000,
    });
  });

  test("wrong password shows error through relay", async ({
    page,
    remoteClientURL,
    relayWsURL,
  }) => {
    await page.goto(remoteClientURL);
    await goToRelayLogin(page);

    // Fill in relay login form with wrong password
    await page.fill(
      '[data-testid="relay-username-input"]',
      TEST_RELAY_USERNAME,
    );
    await page.fill('[data-testid="srp-password-input"]', "wrong-password");

    // Show advanced options to set custom relay URL
    await page.click("text=Show Advanced Options");
    await page.fill('[data-testid="custom-relay-url-input"]', relayWsURL);

    // Submit form
    await page.click('[data-testid="login-button"]');

    // Verify error message appears
    await expect(page.locator('[data-testid="login-error"]')).toBeVisible({
      timeout: 15000,
    });

    // Verify we're still on login page
    await expect(
      page.locator('[data-testid="relay-login-form"]'),
    ).toBeVisible();
  });

  test("server offline error when relay username not registered", async ({
    page,
    remoteClientURL,
    relayWsURL,
    baseURL,
  }) => {
    // First disable relay on the server so username isn't registered
    await disableRelay(baseURL);

    // Wait a moment for relay to disconnect
    await page.waitForTimeout(500);

    await page.goto(remoteClientURL);
    await goToRelayLogin(page);

    // Try to connect to unregistered username
    await page.fill('[data-testid="relay-username-input"]', "nonexistent-user");
    await page.fill('[data-testid="srp-password-input"]', TEST_SRP_PASSWORD);

    // Show advanced options to set custom relay URL
    await page.click("text=Show Advanced Options");
    await page.fill('[data-testid="custom-relay-url-input"]', relayWsURL);

    // Submit form
    await page.click('[data-testid="login-button"]');

    // Verify error message appears (server offline or unknown username)
    await expect(page.locator('[data-testid="login-error"]')).toBeVisible({
      timeout: 15000,
    });

    // Re-enable relay for cleanup
    await configureRelay(baseURL, {
      url: relayWsURL,
      username: TEST_RELAY_USERNAME,
    });
  });
});
