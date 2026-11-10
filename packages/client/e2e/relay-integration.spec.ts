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

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
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

import type {} from "../src/lib/resumeDebugger.js";
import { recordUiCapture } from "./support/ui-capture.js";

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

function remoteRelayUrl(remotePreviewURL: string, path = "projects"): string {
  return `${remotePreviewURL}${relayAppPath(path)}`;
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
  remotePreviewURL: string,
  relayWsURL: string,
): Promise<void> {
  await page.goto(remotePreviewURL);
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
    remotePreviewURL,
    relayWsURL,
  }) => {
    await page.goto(remotePreviewURL);
    await goToRelayLogin(page);

    const computer = page.getByTestId("relay-username-input");
    const password = page.getByTestId("srp-password-input");
    const limitedUser = page.getByTestId("relay-limited-username-input");
    await expect(limitedUser).toHaveCount(0);
    for (const viewport of [
      { width: 1000, height: 600 },
      { width: 375, height: 812 },
    ]) {
      await page.setViewportSize(viewport);
      await recordUiCapture(page, `relay-login-default-${viewport.width}`);
    }

    // Real key events must survive React updates, including the relay preview
    // derived from the computer name. This form has no live session stream.
    const typeAndCheck = async (
      input: import("@playwright/test").Locator,
      value: string,
    ) => {
      await input.evaluate((element) => {
        const field = element as HTMLInputElement;
        const samples: Array<{ ms: number; present: boolean }> = [];
        let started = 0;
        field.addEventListener("keydown", () => {
          started = performance.now();
        });
        field.addEventListener("input", () => {
          const expected = field.value;
          const keyStarted = started;
          requestAnimationFrame(() => {
            samples.push({
              ms: performance.now() - keyStarted,
              present: field.value.startsWith(expected),
            });
            field.dataset.typingSamples = JSON.stringify(samples);
          });
        });
      });
      await input.pressSequentially(value, { delay: 20 });
      await expect(input).toHaveValue(value);
      await expect
        .poll(
          async () =>
            JSON.parse(
              (await input.getAttribute("data-typing-samples")) ?? "[]",
            ).length,
        )
        .toBe(value.length);
      const samples = JSON.parse(
        (await input.getAttribute("data-typing-samples")) ?? "[]",
      ) as Array<{ ms: number; present: boolean }>;
      expect(
        samples.every(({ ms, present }) => present && ms <= 100),
        JSON.stringify(samples),
      ).toBe(true);
    };
    await typeAndCheck(computer, TEST_RELAY_USERNAME);
    await typeAndCheck(password, TEST_SRP_PASSWORD);

    // Advanced adds only an optional identity; the computer's autofill slot
    // remains stable, and clearing the override still signs in as the owner.
    await page.click("text=Show Advanced Options");
    await expect(computer).toHaveAttribute("name", "username");
    await expect(computer).toHaveAttribute("autocomplete", "username");
    await expect(limitedUser).toHaveAttribute("autocomplete", "off");
    await typeAndCheck(limitedUser, "limited-guest");
    await limitedUser.clear();
    await page.fill('[data-testid="custom-relay-url-input"]', relayWsURL);
    for (const viewport of [
      { width: 1000, height: 600 },
      { width: 375, height: 812 },
    ]) {
      await page.setViewportSize(viewport);
      await page.evaluate(() => window.scrollTo(0, 0));
      await recordUiCapture(page, `relay-login-advanced-${viewport.width}`);
    }

    // Restore the suite viewport, above the app's sidebar breakpoint.
    await page.setViewportSize({ width: 1280, height: 720 });

    // Submit form
    await page.click('[data-testid="login-button"]');

    // Wait for login form to disappear (indicates successful login)
    await expect(
      page.locator('[data-testid="relay-login-form"]'),
    ).not.toBeVisible({
      timeout: 15000,
    });

    // Verify we're in the main app (sidebar visible)
    await expect(page.locator("[data-sidebar]")).toBeVisible({
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
    remotePreviewURL,
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
        `${remotePreviewURL}${target(TEST_RELAY_USERNAME, relayWsURL)}`,
      );
      await page.fill('[data-testid="srp-password-input"]', TEST_SRP_PASSWORD);
      await page.locator('[data-testid="remember-me-checkbox"]').uncheck();
      await page.click('[data-testid="login-button"]');
      await expect(page).toHaveURL(
        `${remotePreviewURL}${relayAppPath("settings")}`,
      );
      await expect(page.locator("[data-sidebar]")).toBeVisible();

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

  test("new-session tabs mount ready route modules without loading fallbacks", async ({
    page,
    context,
    remotePreviewURL,
    relayWsURL,
  }) => {
    await loginViaRelay(page, remotePreviewURL, relayWsURL);
    const tab = await context.newPage();
    await tab.addInitScript(() => {
      const typingSamples: Array<{ ms: number; retained: boolean }> = [];
      Object.assign(window, { sawModuleFallback: false, typingSamples });
      let keyStarted = 0;
      document.addEventListener("keydown", (event) => {
        if (event.target instanceof HTMLTextAreaElement)
          keyStarted = performance.now();
      });
      document.addEventListener("input", (event) => {
        if (!(event.target instanceof HTMLTextAreaElement)) return;
        const target = event.target;
        const expected = target.value;
        const started = keyStarted;
        requestAnimationFrame(() => {
          const field =
            document.querySelector<HTMLTextAreaElement>(
              ".new-session-form textarea",
            ) ?? target;
          typingSamples.push({
            ms: performance.now() - started,
            retained: field.value.startsWith(expected),
          });
        });
      });
      new MutationObserver(() => {
        if (document.querySelector('[data-startup-phase="module"]')) {
          Object.assign(window, { sawModuleFallback: true });
        }
      }).observe(document, { childList: true, subtree: true });
    });
    let release!: () => void;
    const ready = new Promise<void>((resolve) => {
      release = resolve;
    });
    let held = false;
    await tab.route("**/assets/NewSessionPage-*.js", async (route) => {
      held = true;
      await ready;
      await route.continue();
    });
    try {
      await tab.goto(remoteRelayUrl(remotePreviewURL, "new-session"), {
        waitUntil: "commit",
      });
      await expect.poll(() => held).toBe(true);
      await expect(tab.locator("#yep-preboot-composer textarea")).toBeVisible();
      const initialText = await tab
        .locator("#yep-preboot-composer textarea")
        .inputValue();
      const text = " across startup";
      const typing = tab.keyboard.type(text, { delay: 25 });
      release();
      await typing;
      await expect(tab.locator(".new-session-form textarea")).toBeVisible();
      await expect(tab.locator(".new-session-form textarea")).toHaveValue(
        initialText + text,
      );
      await expect
        .poll(() =>
          tab.evaluate(
            () =>
              (window as unknown as { typingSamples: unknown[] }).typingSamples
                .length,
          ),
        )
        .toBe(text.length);
      const samples = await tab.evaluate(
        () =>
          (
            window as unknown as {
              typingSamples: Array<{ ms: number; retained: boolean }>;
            }
          ).typingSamples,
      );
      expect(
        samples.every((sample) => sample.retained && sample.ms <= 100),
      ).toBe(true);
      expect(
        await tab.evaluate(
          () =>
            (window as unknown as { sawModuleFallback: boolean })
              .sawModuleFallback,
        ),
      ).toBe(false);
    } finally {
      release();
      await tab.close();
    }
  });

  test("development settings links to the configured relay monitor", async ({
    page,
    remotePreviewURL,
    relayWsURL,
  }) => {
    await loginViaRelay(page, remotePreviewURL, relayWsURL);
    await page.goto(remoteRelayUrl(remotePreviewURL, "settings/development"));

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
    remotePreviewURL,
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
      await loginViaRelay(page, remotePreviewURL, relayWsURL);
      await page.goto(
        remoteRelayUrl(
          remotePreviewURL,
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
    remotePreviewURL,
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
      await loginViaRelay(page, remotePreviewURL, relayWsURL);
      await page.goto(
        remoteRelayUrl(
          remotePreviewURL,
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

  test("a download past the single-message limit streams to disk over the relay", async ({
    page,
    baseURL,
    remotePreviewURL,
    relayWsURL,
  }) => {
    test.setTimeout(120_000);
    const projectPath = join(e2ePaths.tempDir, "streamed-download-project");
    const projectId = Buffer.from(projectPath).toString("base64url");
    const sessionId = "streamed-download-session";
    const sessionDirectory = join(
      e2ePaths.claudeSessionsDir,
      hostname(),
      projectPath.replace(/\//g, "-"),
    );
    const sessionFile = join(sessionDirectory, `${sessionId}.jsonl`);
    const fileName = "streamed-download.bin";
    // Over the 64 MiB a single relayed response may carry.
    const fileBytes = deterministicNoise(66 * 1024 * 1024);
    const receivedFrameSizes: number[] = [];
    page.on("websocket", (socket) => {
      socket.on("framereceived", ({ payload }) => {
        if (typeof payload === "string") return;
        receivedFrameSizes.push(Buffer.from(payload).byteLength);
      });
    });

    await mkdir(projectPath, { recursive: true });
    await mkdir(sessionDirectory, { recursive: true });
    await writeFile(join(projectPath, fileName), fileBytes);
    await writeFile(
      sessionFile,
      JSON.stringify({
        type: "user",
        cwd: projectPath,
        message: { role: "user", content: "download generated content" },
        timestamp: new Date().toISOString(),
        uuid: "streamed-download-user",
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
      await loginViaRelay(page, remotePreviewURL, relayWsURL);
      await page.goto(
        remoteRelayUrl(
          remotePreviewURL,
          `projects/${projectId}/file?path=${encodeURIComponent(fileName)}`,
        ),
      );
      // The streamed path needs the page to be under its service worker.
      await expect
        .poll(() =>
          page.evaluate(() => navigator.serviceWorker?.controller != null),
        )
        .toBe(true);

      const downloadPromise = page.waitForEvent("download", {
        timeout: 60_000,
      });
      await page
        .getByRole("button", { name: "Download File", exact: true })
        .click();
      const download = await downloadPromise;
      expect(download.suggestedFilename()).toBe(fileName);
      expect(download.url()).toContain("/__ya-download/");
      const savedPath = await download.path();
      expect((await readFile(savedPath)).equals(fileBytes)).toBe(true);
      expect(
        receivedFrameSizes.every(
          (size) =>
            size <=
            1 + TRANSPORT_CHUNK_HEADER_SIZE + TRANSPORT_CHUNK_PAYLOAD_MAX_BYTES,
        ),
      ).toBe(true);
    } finally {
      await rm(sessionFile);
      await rm(projectPath, { recursive: true });
    }
  });

  test("large frozen public share uses bounded relay chunks", async ({
    page,
    baseURL,
    remotePreviewURL,
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
        remotePreviewURL,
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
    remotePreviewURL,
    relayWsURL,
  }) => {
    await setBangHistoryVisibility(baseURL, true);
    try {
      await page.setViewportSize({ width: 375, height: 812 });
      await page.goto(remotePreviewURL);
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
        page.getByText("!! Command History", { exact: true }),
      ).toBeVisible({ timeout: 10_000 });
      await openSidebar.click();
      await expect(bangHistoryLink).toHaveAttribute("data-sidebar-active");
    } finally {
      await setBangHistoryVisibility(baseURL, false);
    }
  });

  test("right-click Switch Host lists recent hosts and routes to the pick", async ({
    page,
    remotePreviewURL,
    relayWsURL,
  }) => {
    await page.setViewportSize({ width: 1000, height: 600 });
    await loginViaRelay(page, remotePreviewURL, relayWsURL);
    await page.evaluate((relayUrl: string) => {
      const stored = JSON.parse(
        localStorage.getItem("yep-anywhere-saved-hosts") ?? "{}",
      );
      stored.hosts.push({
        id: "e2e-other-host",
        displayName: "Windows box",
        mode: "relay",
        relayUrl,
        relayUsername: "e2e-other-host",
        srpUsername: "e2e-other-host",
        lastConnected: new Date().toISOString(),
        createdAt: new Date().toISOString(),
      });
      localStorage.setItem("yep-anywhere-saved-hosts", JSON.stringify(stored));
    }, relayWsURL);

    const switchHost = page.getByRole("button", { name: "Switch Host" });
    const otherHost = page.getByRole("menuitem", { name: /Windows box/ });
    for (const viewport of [
      { width: 1000, height: 600 },
      { width: 375, height: 812 },
    ]) {
      await page.setViewportSize(viewport);
      if (!(await switchHost.isVisible())) {
        await page.getByRole("button", { name: "Open sidebar" }).click();
      }
      await switchHost.click({ button: "right" });
      await expect(otherHost).toBeVisible();
      await expect(
        page.getByRole("menuitem", { name: "All hosts…" }),
      ).toBeVisible();
      await recordUiCapture(page, `switch-host-menu-${viewport.width}`);
      if (viewport.width > 375) await page.keyboard.press("Escape");
    }

    await otherHost.click();
    // The other host has no saved session, so its gate asks to sign in.
    await expect(
      page.locator('[data-testid="relay-username-input"]'),
    ).toHaveValue("e2e-other-host", { timeout: 15_000 });
  });

  // This test verifies that sessions persist across page refresh via relay.
  test("session persists after page refresh (auto-resume)", async ({
    page,
    remotePreviewURL,
    relayWsURL,
  }) => {
    // First login via relay
    await page.goto(remotePreviewURL);
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
    await expect(page.locator("[data-sidebar]")).toBeVisible({
      timeout: 15000,
    });

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
      await expect(page.locator("[data-sidebar]")).toBeVisible({
        timeout: 20000,
      });
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

  test("recovers an exhausted relay connection on renewed activity without losing input", async ({
    page,
    remotePreviewURL,
    relayWsURL,
  }) => {
    // Recovery uses an accelerated scheduler. Capture the native frame clock
    // before installing it so typing still measures actual browser frames.
    await page.addInitScript(() => {
      Object.assign(window, {
        relayTypingNow: performance.now.bind(performance),
        relayTypingFrame: requestAnimationFrame.bind(window),
      });
    });
    let blocked = false;
    let failures = 0;
    const sockets: import("@playwright/test").WebSocketRoute[] = [];
    const messages: string[] = [];
    page.on("console", (message) => messages.push(message.text()));
    await page.routeWebSocket(relayWsURL, (socket) => {
      if (blocked) {
        failures++;
        socket.onMessage(() =>
          socket.send(
            JSON.stringify({ type: "client_error", reason: "server_offline" }),
          ),
        );
      } else {
        sockets.push(socket);
        socket.connectToServer();
      }
    });
    await loginViaRelay(page, remotePreviewURL, relayWsURL);
    await page.goto(remoteRelayUrl(remotePreviewURL, "settings"));
    const search = page.getByRole("searchbox", { name: "Search settings" });
    await expect(search).toBeVisible();
    await search.pressSequentially("theme");
    await expect(search).toHaveValue("theme");
    const stored = await page.evaluate(() =>
      localStorage.getItem("yep-anywhere-remote-credentials"),
    );
    // Install and pause against one captured timestamp. A fresh Date after
    // install can already be behind the browser clock on a loaded CI worker.
    const clockStart = Date.now();
    await page.clock.install({ time: clockStart });
    await page.clock.pauseAt(clockStart + 10_000);
    blocked = true;
    await Promise.all(
      sockets.map((socket) =>
        socket.close({ code: 1012, reason: "Test connection interrupted" }),
      ),
    );
    await expect
      .poll(() => messages.some((message) => message.includes("attempt 1/10")))
      .toBe(true);
    for (let attempt = 1; attempt <= 10; attempt++) {
      await page.clock.fastForward(31000);
      await expect.poll(() => failures).toBeGreaterThanOrEqual(attempt);
      await expect
        .poll(
          () =>
            messages.filter((message) =>
              message.startsWith(
                "[ConnectionManager:source-secure] reconnect failed:",
              ),
            ).length,
        )
        .toBe(attempt);
    }
    await expect
      .poll(() =>
        messages.some((message) =>
          message.includes("rapid retry budget exhausted"),
        ),
      )
      .toBe(true);
    // Exhaustion keeps the mounted page; signals coalesce into one new attempt.
    await expect(search).toHaveValue("theme");
    expect(
      await page.evaluate(() =>
        localStorage.getItem("yep-anywhere-remote-credentials"),
      ),
    ).toBe(stored);
    // Advance scheduling without making the authenticated proof timestamp
    // five minutes newer than the real server clock.
    await page.clock.setFixedTime(new Date());
    blocked = false;
    const resumeCount = messages.filter((message) =>
      message.includes("Session resumed successfully"),
    ).length;
    await page.evaluate(() => {
      window.dispatchEvent(new Event("online"));
      window.dispatchEvent(new Event("focus"));
    });
    await expect
      .poll(
        () =>
          messages.filter((message) =>
            message.includes("Session resumed successfully"),
          ).length,
      )
      .toBe(resumeCount + 1);
    const pongCount = messages.filter((message) =>
      message.includes("pong received"),
    ).length;
    await page.evaluate(() =>
      document.dispatchEvent(new Event("visibilitychange")),
    );
    await expect
      .poll(
        () =>
          messages.filter((message) => message.includes("pong received"))
            .length,
      )
      .toBe(pongCount + 1);
    await expect(search).toHaveValue("theme");
    await expect(page).toHaveURL(/\/settings$/);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page.clock.resume();
    await search.evaluate((element) => {
      const input = element as HTMLInputElement;
      const { relayTypingNow: now, relayTypingFrame: frame } =
        window as unknown as {
          relayTypingNow: () => number;
          relayTypingFrame: typeof requestAnimationFrame;
        };
      const samples: Array<{
        ms: number;
        fakeMs: number | null;
        present: boolean;
      }> = [];
      let started = 0;
      let fakeStarted = 0;
      input.addEventListener("keydown", () => {
        started = now();
        fakeStarted = performance.now();
        // Concurrent real socket health traffic while acknowledging typing.
        document.dispatchEvent(new Event("visibilitychange"));
      });
      input.addEventListener("input", () => {
        const expected = input.value;
        const keyStarted = started;
        const keyFakeStarted = fakeStarted;
        const sample = { ms: 0, fakeMs: null as number | null, present: false };
        frame(() => {
          sample.ms = now() - keyStarted;
          sample.present = input.value.startsWith(expected);
          samples.push(sample);
          input.dataset.typingSamples = JSON.stringify(samples);
        });
        requestAnimationFrame(() => {
          sample.fakeMs = performance.now() - keyFakeStarted;
          input.dataset.typingSamples = JSON.stringify(samples);
        });
      });
    });
    await search.pressSequentially(" color", { delay: 20 });
    await expect(search).toHaveValue("theme color");
    await expect
      .poll(
        async () =>
          JSON.parse((await search.getAttribute("data-typing-samples")) ?? "[]")
            .length,
      )
      .toBe(6);
    const samples = JSON.parse(
      (await search.getAttribute("data-typing-samples")) ?? "[]",
    ) as Array<{ ms: number; present: boolean }>;
    expect(
      samples.every((sample) => sample.present && sample.ms <= 100),
      JSON.stringify(samples),
    ).toBe(true);
  });

  test("retained rejected resume can be probed without replacing the live source", async ({
    page,
    remotePreviewURL,
    relayWsURL,
  }) => {
    let rejectOnce = false;
    let resumeAttempts = 0;
    let probeClosed = false;
    const socketStates: { closed: boolean }[] = [];
    const nonces: string[] = [];
    await page.routeWebSocket(relayWsURL, (socket) => {
      const server = socket.connectToServer();
      const state = { closed: false };
      socketStates.push(state);
      let probe = false;
      socket.onMessage((message) => {
        if (typeof message === "string") {
          const msg = JSON.parse(message) as {
            type?: string;
            clientNonce?: string;
          };
          if (msg.type === "srp_resume_init") {
            resumeAttempts++;
            nonces.push(msg.clientNonce ?? "");
            if (rejectOnce) {
              rejectOnce = false;
              socket.send(
                JSON.stringify({
                  type: "srp_invalid",
                  reason: "invalid_proof",
                }),
              );
              return;
            }
            probe = true;
          }
        }
        server.send(message);
      });
      socket.onClose((code, reason) => {
        state.closed = true;
        if (probe) probeClosed = true;
        server.close({ code, reason });
      });
    });
    await loginViaRelay(page, remotePreviewURL, relayWsURL);
    await page.goto(remoteRelayUrl(remotePreviewURL, "settings/development"));
    const toggle = page.getByRole("switch", {
      name: "Retain rejected SRP sessions for debugging",
    });
    await toggle.locator("..").click();
    await expect(toggle).toBeChecked();
    for (const [name, size] of [
      ["desktop", { width: 1000, height: 600 }],
      ["phone", { width: 375, height: 812 }],
    ] as const) {
      await page.setViewportSize(size);
      await page
        .getByText("Retain rejected SRP sessions for debugging", {
          exact: true,
        })
        .evaluate((element) => {
          element
            .closest("[data-settings-item]")
            ?.scrollIntoView({ block: "center", behavior: "instant" });
        });
      await expect
        .poll(() =>
          toggle.evaluate((element) => {
            const row = element.closest("[data-settings-item]");
            if (!row) return false;
            row.scrollIntoView({ block: "center", behavior: "instant" });
            const bounds = row.getBoundingClientRect();
            return bounds.top >= 50 && bounds.bottom <= window.innerHeight;
          }),
        )
        .toBe(true);
      await recordUiCapture(page, `srp-retention-development-${name}`, size);
    }
    rejectOnce = true;
    await page.reload();
    await expect(page.getByTestId("relay-login-form")).toBeVisible();
    const retainedId = await page.evaluate(
      () => window.__YA_RESUME_DEBUG__?.list()[0]?.id,
    );
    expect(retainedId).toBeTruthy();
    const afterRejection = resumeAttempts;
    await page.reload();
    await expect(page.getByTestId("relay-login-form")).toBeVisible();
    expect(resumeAttempts).toBe(afterRejection);
    expect(
      await page.evaluate(() => window.__YA_RESUME_DEBUG__?.list().length),
    ).toBe(1);
    // Restore access with a new password session while keeping the refused copy.
    await page.getByTestId("srp-password-input").fill(TEST_SRP_PASSWORD);
    await page.getByTestId("login-button").click();
    await expect(page.getByTestId("relay-login-form")).not.toBeVisible();
    await page.goto(remoteRelayUrl(remotePreviewURL, "settings"));
    const search = page.getByRole("searchbox", { name: "Search settings" });
    await expect(search).toBeVisible();
    const before = await page.evaluate(() => ({
      url: location.href,
      credentials: localStorage.getItem("yep-anywhere-remote-credentials"),
      hosts: localStorage.getItem("yep-anywhere-saved-hosts"),
    }));
    const count = resumeAttempts;
    const liveSockets = socketStates.filter((socket) => !socket.closed);
    expect(liveSockets.length).toBeGreaterThan(0);
    probeClosed = false;
    const result = await page.evaluate(
      (id) => window.__YA_RESUME_DEBUG__?.probe(id ?? ""),
      retainedId,
    );
    expect(result).toEqual({ outcome: "authenticated" });
    expect(resumeAttempts).toBe(count + 1);
    expect(new Set(nonces).size).toBe(nonces.length);
    await expect.poll(() => probeClosed).toBe(true);
    expect(liveSockets.every((socket) => !socket.closed)).toBe(true);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(
      await page.evaluate(() => ({
        url: location.href,
        credentials: localStorage.getItem("yep-anywhere-remote-credentials"),
        hosts: localStorage.getItem("yep-anywhere-saved-hosts"),
      })),
    ).toEqual(before);
    await expect(search).toBeVisible();
    expect(
      await page.evaluate(() => window.__YA_RESUME_DEBUG__?.list().length),
    ).toBe(1);
    await page.goto(remoteRelayUrl(remotePreviewURL, "settings/development"));
    await page
      .getByRole("switch", {
        name: "Retain rejected SRP sessions for debugging",
      })
      .locator("..")
      .click();
    expect(
      await page.evaluate(() => ({
        helper: typeof window.__YA_RESUME_DEBUG__,
        retained: localStorage.getItem("yep-anywhere-rejected-srp-resume-v1"),
      })),
    ).toEqual({ helper: "undefined", retained: null });
  });

  test("old relay resume rejection explains why fresh login is needed", async ({
    page,
    remotePreviewURL,
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

    await page.goto(`${remotePreviewURL}/${TEST_RELAY_USERNAME}/projects`);

    // No page was loaded yet, so the rejection opens the login form directly
    // with the explanation, rather than a modal the user must click through.
    await expect(
      page.locator('[data-testid="relay-login-form"]'),
    ).toBeVisible();
    await expect(page.locator('[data-testid="login-error"]')).toHaveText(
      "The server rejected the saved session. Sign in again to reconnect.",
    );
    await expect(page.getByRole("button", { name: "Go to Login" })).toHaveCount(
      0,
    );
    for (const [name, size] of [
      ["desktop", { width: 1000, height: 600 }],
      ["phone", { width: 375, height: 812 }],
    ] as const) {
      await page.setViewportSize(size);
      await recordUiCapture(page, `resume-rejected-${name}`, size);
    }
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

  test("choosing a saved host whose session was rejected opens its login form", async ({
    page,
    remotePreviewURL,
    relayWsURL,
  }) => {
    await page.addInitScript(
      (params: { relayUrl: string; relayUsername: string }) => {
        const { relayUrl, relayUsername } = params;
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
                relayUrl,
                relayUsername,
                srpUsername: relayUsername,
                session: {
                  wsUrl: relayUrl,
                  username: relayUsername,
                  sessionId: "stale-session",
                  sessionKey: btoa("stale session key material"),
                  resumeProtocolVersion: 2,
                },
                createdAt: new Date().toISOString(),
              },
            ],
          }),
        );
      },
      { relayUrl: relayWsURL, relayUsername: TEST_RELAY_USERNAME },
    );

    await page.goto(`${remotePreviewURL}/login`);
    await page.getByTestId("host-item-stale-relay-host").click();

    await expect(
      page.locator('[data-testid="relay-login-form"]'),
    ).toBeVisible();
    await expect(page.locator('[data-testid="login-error"]')).toHaveText(
      "The server rejected the saved session. Sign in again to reconnect.",
    );
    await expect(
      page.locator('[data-testid="relay-username-input"]'),
    ).toHaveValue(TEST_RELAY_USERNAME);
    await expect(page.getByTestId("host-picker-error")).toHaveCount(0);
  });

  test("fresh relay login preserves a saved host at a different endpoint", async ({
    page,
    remotePreviewURL,
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
    await page.goto(`${remotePreviewURL}/login/relay?${params.toString()}`);

    await page.fill('[data-testid="srp-password-input"]', TEST_SRP_PASSWORD);
    await page.click('[data-testid="login-button"]');

    await expect(page.locator("[data-sidebar]")).toBeVisible({
      timeout: 15000,
    });

    const savedHosts = await page.evaluate(() =>
      JSON.parse(localStorage.getItem("yep-anywhere-saved-hosts") ?? "{}"),
    );
    expect(savedHosts.hosts[0]?.relayUrl).toBe(
      "wss://relay.yepanywhere.com/ws",
    );
    const authenticated = savedHosts.hosts.find(
      (host: { relayUrl: string }) => host.relayUrl === relayWsURL,
    );
    expect(authenticated?.session).toBeDefined();
  });

  test("mock project visible through relay connection", async ({
    page,
    remotePreviewURL,
    relayWsURL,
  }) => {
    await page.goto(remotePreviewURL);
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
    await expect(page.locator("[data-sidebar]")).toBeVisible({
      timeout: 15000,
    });

    // The mock project session should be visible in the sidebar
    // This proves session data is loaded via encrypted WebSocket through relay
    await expect(page.getByText("mockproject").first()).toBeVisible({
      timeout: 10000,
    });
  });

  test("wrong password shows error through relay", async ({
    page,
    remotePreviewURL,
    relayWsURL,
  }) => {
    await page.goto(remotePreviewURL);
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
    remotePreviewURL,
    relayWsURL,
    baseURL,
  }) => {
    // First disable relay on the server so username isn't registered
    await disableRelay(baseURL);

    // Wait a moment for relay to disconnect
    await page.waitForTimeout(500);

    await page.goto(remotePreviewURL);
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
