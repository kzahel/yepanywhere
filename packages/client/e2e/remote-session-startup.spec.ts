import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import {
  configureRemoteAccess,
  disableRelay,
  disableRemoteAccess,
  e2ePaths,
  expect,
  test,
  waitForRelayStatus,
} from "./fixtures.js";

test.use({ serviceWorkers: "block" });

const RELAY_USERNAME = "e2e-startup-test";
const SRP_PASSWORD = "startup-test-password-123";
const SCRIPT_DELAY_MS = 180;

interface StartupProbe {
  backgrounds: Array<{ body: string; html: string }>;
  composerLostAfterVisible: boolean;
  genericPageShellSeen: boolean;
  headerLostAfterVisible: boolean;
  minimumRootHeight: number | null;
  moduleFallbackReturnedAfterFrame: boolean;
  sessionShellSeen: boolean;
  stop: boolean;
}

async function loginViaRelay(
  page: Page,
  remotePreviewURL: string,
  relayWsURL: string,
) {
  await page.goto(remotePreviewURL);
  await page.click('[data-testid="relay-mode-button"]');
  await page.fill('[data-testid="relay-username-input"]', RELAY_USERNAME);
  await page.fill('[data-testid="srp-password-input"]', SRP_PASSWORD);
  await page.click("text=Show Advanced Options");
  await page.fill('[data-testid="custom-relay-url-input"]', relayWsURL);
  await page.click('[data-testid="login-button"]');
  await expect(
    page.locator('[data-testid="relay-login-form"]'),
  ).not.toBeVisible({ timeout: 15_000 });
}

async function installStartupProbe(page: Page) {
  await page.addInitScript(() => {
    const probe: StartupProbe = {
      backgrounds: [],
      composerLostAfterVisible: false,
      genericPageShellSeen: false,
      headerLostAfterVisible: false,
      minimumRootHeight: null,
      moduleFallbackReturnedAfterFrame: false,
      sessionShellSeen: false,
      stop: false,
    };
    (
      window as typeof window & { __yaStartupProbe?: StartupProbe }
    ).__yaStartupProbe = probe;

    let composerSeen = false;
    let headerSeen = false;

    const isVisible = (selector: string) => {
      const element = document.querySelector<HTMLElement>(selector);
      if (!element) return false;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return (
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        rect.width > 0 &&
        rect.height > 0
      );
    };

    const sample = () => {
      if (probe.stop) return;

      const root = document.querySelector<HTMLElement>("#root");
      if (
        document.documentElement.dataset.theme &&
        document.body &&
        root?.childElementCount
      ) {
        probe.backgrounds.push({
          body: getComputedStyle(document.body).backgroundColor,
          html: getComputedStyle(document.documentElement).backgroundColor,
        });
        const rootHeight = root.getBoundingClientRect().height;
        probe.minimumRootHeight =
          probe.minimumRootHeight === null
            ? rootHeight
            : Math.min(probe.minimumRootHeight, rootHeight);
      }

      const startupShell = document.querySelector<HTMLElement>(
        "[data-startup-phase]",
      );
      if (startupShell?.dataset.startupShell === "session") {
        probe.sessionShellSeen = true;
      }
      if (startupShell?.dataset.startupShell === "page") {
        probe.genericPageShellSeen = true;
      }

      const headerVisible = isVisible("[data-session-header]");
      const composerVisible = isVisible(".message-input-wrapper");
      headerSeen ||= headerVisible;
      composerSeen ||= composerVisible;
      if (headerSeen && !headerVisible) probe.headerLostAfterVisible = true;
      if (composerSeen && !composerVisible) {
        probe.composerLostAfterVisible = true;
      }
      if (headerSeen && startupShell?.dataset.startupPhase === "module") {
        probe.moduleFallbackReturnedAfterFrame = true;
      }

      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
}

async function readStartupProbe(page: Page): Promise<StartupProbe> {
  return page.evaluate(() => {
    const probe = (
      window as typeof window & { __yaStartupProbe?: StartupProbe }
    ).__yaStartupProbe;
    if (!probe) throw new Error("Startup probe was not installed");
    probe.stop = true;
    return probe;
  });
}

function expectMonotonicStartup(probe: StartupProbe, viewportHeight: number) {
  expect(probe.backgrounds.length).toBeGreaterThan(0);
  expect(new Set(probe.backgrounds.map(({ html }) => html)).size).toBe(1);
  expect(new Set(probe.backgrounds.map(({ body }) => body)).size).toBe(1);
  expect(probe.backgrounds.every(({ body, html }) => body === html)).toBe(true);
  expect(probe.minimumRootHeight).not.toBeNull();
  expect(probe.minimumRootHeight ?? 0).toBeGreaterThanOrEqual(
    viewportHeight - 1,
  );
  expect(probe.sessionShellSeen).toBe(true);
  expect(probe.genericPageShellSeen).toBe(false);
  expect(probe.headerLostAfterVisible).toBe(false);
  expect(probe.composerLostAfterVisible).toBe(false);
  expect(probe.moduleFallbackReturnedAfterFrame).toBe(false);
}

async function expectSessionReady(page: Page) {
  await expect(page.locator("[data-session-header]")).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.locator(".message-input-wrapper")).toBeVisible({
    timeout: 15_000,
  });
  await expect(
    page.locator("[data-session-messages]").getByText("Previous message"),
  ).toBeVisible({ timeout: 15_000 });
}

async function capture(page: Page, name: string) {
  const directory = process.env.YEP_E2E_UI_CAPTURE_DIR;
  if (!directory) return;
  mkdirSync(directory, { recursive: true });
  await page.screenshot({
    animations: "disabled",
    path: join(directory, name),
  });
}

test.describe("remote selected-session startup", () => {
  test.beforeEach(async ({ baseURL, relayWsURL }) => {
    await configureRemoteAccess(baseURL, {
      username: RELAY_USERNAME,
      password: SRP_PASSWORD,
      relayUrl: relayWsURL,
    });
    await waitForRelayStatus(baseURL, "waiting", 15_000);
  });

  test.afterEach(async ({ baseURL }) => {
    await disableRelay(baseURL);
    await disableRemoteAccess(baseURL);
  });

  test("keeps cold and warm reloads monotonic", async ({
    page,
    remotePreviewURL,
    relayWsURL,
  }) => {
    test.setTimeout(60_000);
    await page.emulateMedia({ colorScheme: "dark" });
    await page.setViewportSize({ width: 375, height: 812 });
    await loginViaRelay(page, remotePreviewURL, relayWsURL);

    const projectPath = join(e2ePaths.tempDir, "mockproject");
    const projectId = Buffer.from(projectPath).toString("base64url");
    const sessionUrl = `${remotePreviewURL}/-/relay/${RELAY_USERNAME}/projects/${projectId}/sessions/mock-session-001`;
    await page.goto(sessionUrl);
    await expectSessionReady(page);

    await installStartupProbe(page);
    const requestStarts = new Map<string, number>();
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (
        url.origin === new URL(remotePreviewURL).origin &&
        url.pathname.startsWith("/assets/") &&
        url.pathname.endsWith(".js")
      ) {
        requestStarts.set(
          url.pathname.split("/").at(-1) ?? url.pathname,
          Date.now(),
        );
      }
    });

    const browserSession = await page.context().newCDPSession(page);
    await browserSession.send("Network.enable");
    await browserSession.send("Network.setCacheDisabled", {
      cacheDisabled: true,
    });
    await page.route("**/assets/*.js", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, SCRIPT_DELAY_MS));
      await route.continue();
    });

    requestStarts.clear();
    await page.reload();
    await expectSessionReady(page);
    const coldProbe = await readStartupProbe(page);
    expectMonotonicStartup(coldProbe, 812);

    const criticalModulePatterns = [
      /^RemoteApp-.*\.js$/,
      /^RelayConnectionGate-.*\.js$/,
      /^SessionPage-.*\.js$/,
      /^MessageList-.*\.js$/,
      /^MessageInput-.*\.js$/,
    ];
    const criticalRequestStarts = criticalModulePatterns.map((pattern) => {
      const entry = [...requestStarts].find(([name]) => pattern.test(name));
      expect(entry, `request matching ${pattern}`).toBeDefined();
      return entry?.[1] ?? 0;
    });
    expect(
      Math.max(...criticalRequestStarts) - Math.min(...criticalRequestStarts),
    ).toBeLessThan(SCRIPT_DELAY_MS);

    await page.unroute("**/assets/*.js");
    await browserSession.send("Network.setCacheDisabled", {
      cacheDisabled: false,
    });
    await page.reload();
    await expectSessionReady(page);
    const warmProbe = await readStartupProbe(page);
    expectMonotonicStartup(warmProbe, 812);

    await capture(page, "remote-session-startup-mobile-375x812.png");
    await page.setViewportSize({ width: 1920, height: 1080 });
    await expectSessionReady(page);
    await capture(page, "remote-session-startup-desktop-1920x1080.png");
  });
});
