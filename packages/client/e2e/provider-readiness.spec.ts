import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures.js";

test.use({ serviceWorkers: "block" });

interface Gate {
  promise: Promise<void>;
  open: () => void;
}

function gate(): Gate {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

async function dismissOnboardingIfVisible(page: Page) {
  const dialog = page.getByText("Welcome to yepanywhere");
  await page.waitForTimeout(250);
  if (!(await dialog.isVisible().catch(() => false))) return;
  await page.getByRole("button", { name: "Skip all" }).click({ force: true });
  await expect(dialog).not.toBeVisible();
}

async function capture(page: Page, name: string) {
  const directory = process.env.YEP_E2E_UI_CAPTURE_DIR;
  if (!directory) return;
  mkdirSync(directory, { recursive: true });
  await page.screenshot({ path: join(directory, name) });
}

const staleGateway = {
  name: "claude-gateway",
  displayName: "Claude Gateway",
  installed: true,
  authenticated: true,
  enabled: true,
  models: [{ id: "saved-gateway", name: "Saved Gateway" }],
};

const currentGateway = {
  ...staleGateway,
  models: [{ id: "current-gateway", name: "Current Gateway" }],
};

const loggedOutDesktopProviders = [
  {
    name: "claude",
    displayName: "Claude",
    installed: true,
    applicationDetected: true,
    authenticated: false,
    enabled: false,
    loginCommand:
      "'/Applications/Yep Anywhere.app/Contents/Resources/claude' auth login --claudeai",
    models: [{ id: "default", name: "Default" }],
  },
  {
    name: "codex",
    displayName: "Codex",
    installed: true,
    applicationDetected: true,
    authenticated: false,
    enabled: false,
    loginCommand: "'/Applications/ChatGPT.app/Contents/Resources/codex' login",
    models: [{ id: "gpt-5.6", name: "GPT-5.6" }],
  },
];

test.describe("New Session provider readiness", () => {
  test("separates desktop, runtime, and auth while keeping launch available", async ({
    page,
    baseURL,
  }) => {
    await page.route(
      (url) => url.pathname === "/api/providers",
      async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ providers: loggedOutDesktopProviders }),
        });
      },
    );
    await page.route(
      (url) => url.pathname === "/api/providers/codex",
      async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ provider: loggedOutDesktopProviders[1] }),
        });
      },
    );
    await page.route(
      (url) => url.pathname.endsWith("/subscription-usage"),
      async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ usage: null }),
        });
      },
    );

    await page.goto(`${baseURL}/settings/providers`);
    await dismissOnboardingIfVisible(page);
    const codexSettings = page.locator('[data-settings-item="provider-codex"]');
    await expect(codexSettings.getByText("Runtime ready")).toBeVisible();
    await expect(
      codexSettings.getByText("Desktop application: Detected"),
    ).toBeVisible();
    await expect(
      codexSettings.getByText("Authentication: Not authenticated"),
    ).toBeVisible();
    await expect(
      codexSettings.getByText(
        "'/Applications/ChatGPT.app/Contents/Resources/codex' login",
      ),
    ).toBeVisible();

    await page.setViewportSize({ width: 1000, height: 600 });
    await expect(async () => {
      await codexSettings.scrollIntoViewIfNeeded();
    }).toPass();
    await capture(page, "desktop-provider-readiness-1000x600.png");
    await page.setViewportSize({ width: 375, height: 812 });
    await expect(async () => {
      await codexSettings.scrollIntoViewIfNeeded();
    }).toPass();
    await capture(page, "desktop-provider-readiness-375x812.png");

    await page.goto(`${baseURL}/new-session?provider=codex&detached=1`);
    const providerPicker = page.locator(
      '.new-session-provider-section button[aria-haspopup="menu"]',
    );
    await expect(providerPicker).toBeEnabled();
    await expect(providerPicker).toContainText("Codex");
    await expect(providerPicker).toContainText("Authentication needed");
    await providerPicker.click();
    await expect(
      page
        .getByRole("menu")
        .getByRole("menuitemradio", { name: /^Codex OpenAI/ }),
    ).toContainText("Authentication needed");
    await page.keyboard.press("Escape");
    await page
      .getByPlaceholder("Describe what you'd like help with...")
      .fill("Verify provider authentication at launch");
    await expect(page.locator(".new-session-submit-button")).toBeEnabled();

    await page.setViewportSize({ width: 1000, height: 600 });
    await providerPicker.scrollIntoViewIfNeeded();
    await capture(page, "new-session-auth-needed-1000x600.png");
    await page.setViewportSize({ width: 375, height: 812 });
    await providerPicker.scrollIntoViewIfNeeded();
    await capture(page, "new-session-auth-needed-375x812.png");
  });

  test("keeps stale Gateway display blocked until named retry succeeds", async ({
    page,
    baseURL,
  }) => {
    const aggregateGate = gate();
    const firstNamedGate = gate();
    const retryGate = gate();
    // Persisted rows paint immediately but cannot authorize a launch. A
    // current aggregate response, unlike this snapshot, can authorize it.
    await page.addInitScript((provider) => {
      localStorage.setItem(
        "ya:providers:local",
        JSON.stringify({
          version: 1,
          savedAt: Date.now(),
          providers: [provider],
        }),
      );
    }, staleGateway);
    let aggregateRequests = 0;
    let namedRequests = 0;
    let usageRequests = 0;
    const usageRequestedAt: number[] = [];
    // Route work precedes supplementary usage, but a held route tier releases
    // the next after TIER_DEADLINE_MS (2s, lib/clientQueryBootstrap.ts), so a
    // slow runner can legitimately see usage while the gates are still shut.
    // The ordering holds if no usage request came sooner than that after
    // navigation began; the page mounts after this mark, so the bound can
    // only be conservative.
    const tierDeadlineMs = 2_000;
    let navigatedAt = 0;
    const expectNoUsageAheadOfRouteWork = () => {
      for (const at of usageRequestedAt)
        expect(at - navigatedAt).toBeGreaterThanOrEqual(tierDeadlineMs);
    };

    await page.route(
      (url) => url.pathname === "/api/providers",
      async (route) => {
        aggregateRequests += 1;
        await aggregateGate.promise;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ providers: [currentGateway] }),
        });
      },
    );
    await page.route(
      (url) => url.pathname === "/api/providers/claude-gateway",
      async (route) => {
        namedRequests += 1;
        if (namedRequests === 1) {
          await firstNamedGate.promise;
          await route.fulfill({
            status: 503,
            contentType: "application/json",
            body: JSON.stringify({ error: "gateway unavailable" }),
          });
          return;
        }
        await retryGate.promise;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ provider: currentGateway }),
        });
      },
    );
    await page.route(
      (url) =>
        url.pathname === "/api/providers/claude-gateway/subscription-usage",
      async (route) => {
        usageRequests += 1;
        usageRequestedAt.push(Date.now());
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ usage: null }),
        });
      },
    );

    try {
      navigatedAt = Date.now();
      await page.goto(
        `${baseURL}/new-session?provider=claude-gateway&detached=1`,
      );
      await dismissOnboardingIfVisible(page);
      await page
        .getByPlaceholder("Describe what you'd like help with...")
        .fill("Verify Gateway readiness");

      await expect.poll(() => aggregateRequests).toBe(1);
      await expect.poll(() => namedRequests).toBe(1);
      expectNoUsageAheadOfRouteWork();

      await expect(page.getByText("Saved Gateway").first()).toBeVisible();
      await expect(
        page.getByText("Checking the configured gateway for models…"),
      ).toBeVisible();
      await expect(page.locator(".new-session-submit-button")).toBeDisabled();
      expectNoUsageAheadOfRouteWork();

      await page.setViewportSize({ width: 1920, height: 1080 });
      await capture(page, "gateway-checking-desktop-1920x1080.png");
      await page.setViewportSize({ width: 375, height: 812 });
      await capture(page, "gateway-checking-mobile-375x812.png");

      firstNamedGate.open();
      await expect(
        page.getByText(
          "No models are available from the configured gateway. Check that it is running, then retry.",
        ),
      ).toBeVisible();
      await expect(page.getByText("Saved Gateway").first()).toBeVisible();
      await expect(page.locator(".new-session-submit-button")).toBeDisabled();
      await expect.poll(() => usageRequests).toBe(1);

      const aggregateRequestsBeforeRetry = aggregateRequests;
      await page.getByRole("button", { name: "Retry" }).click();
      await expect.poll(() => namedRequests).toBe(2);
      expect(aggregateRequests).toBe(aggregateRequestsBeforeRetry);
      await expect(page.locator(".new-session-submit-button")).toBeDisabled();

      retryGate.open();
      await expect(page.getByText("Current Gateway").first()).toBeVisible();
      await expect(
        page.getByText("Checking the configured gateway for models…"),
      ).toHaveCount(0);
      await expect(page.locator(".new-session-submit-button")).toBeEnabled();

      await page.setViewportSize({ width: 1920, height: 1080 });
      await capture(page, "gateway-ready-desktop-1920x1080.png");
      await page.setViewportSize({ width: 375, height: 812 });
      await capture(page, "gateway-ready-mobile-375x812.png");
    } finally {
      aggregateGate.open();
      firstNamedGate.open();
      retryGate.open();
    }
  });

  test("keeps a fresh empty Gateway catalog blocked", async ({
    page,
    baseURL,
  }) => {
    await page.route(
      (url) => url.pathname === "/api/providers",
      async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            providers: [{ ...currentGateway, models: [] }],
          }),
        });
      },
    );
    await page.route(
      (url) => url.pathname === "/api/providers/claude-gateway",
      async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            provider: { ...currentGateway, models: [] },
          }),
        });
      },
    );

    await page.goto(
      `${baseURL}/new-session?provider=claude-gateway&detached=1`,
    );
    await dismissOnboardingIfVisible(page);
    await page
      .getByPlaceholder("Describe what you'd like help with...")
      .fill("Verify empty Gateway catalog");

    await expect(
      page.getByText(
        "No models are available from the configured gateway. Check that it is running, then retry.",
      ),
    ).toBeVisible();
    await expect(page.locator(".new-session-submit-button")).toBeDisabled();
  });
});
