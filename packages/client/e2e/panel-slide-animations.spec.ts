import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { e2ePaths, expect, test } from "./fixtures.js";
import { recordUiCapture } from "./support/ui-capture.js";

test("Appearance slide animations apply immediately and persist for App toggles", async ({
  page,
  baseURL,
}) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1200, height: 600 });
  await page.goto("/settings/appearance");
  const animationToggle = page.getByRole("switch", {
    name: "Slide animations",
    exact: true,
  });
  const sidebar = page.locator("[data-sidebar-desktop]");
  await expect(animationToggle).toBeChecked();
  await expect(sidebar).toHaveCSS("transition-duration", "0.2s");
  await animationToggle.locator("..").click();
  await expect(sidebar).toHaveCSS("transition-duration", "0s");
  await animationToggle.locator("..").scrollIntoViewIfNeeded();
  await recordUiCapture(page, "slide-animations-desktop");
  await page.reload();
  await expect(animationToggle).not.toBeChecked();
  await expect(sidebar).toHaveCSS("transition-duration", "0s");

  await page.setViewportSize({ width: 375, height: 812 });
  await page.reload();
  await expect(animationToggle).not.toBeChecked();
  await animationToggle.locator("..").scrollIntoViewIfNeeded();
  await recordUiCapture(page, "slide-animations-phone");
  await page.goto("/sessions");
  await page.getByRole("button", { name: "Open sidebar", exact: true }).click();
  await expect(page.locator("[data-sidebar]")).toHaveCSS(
    "animation-duration",
    "0s",
  );
  await expect(page.locator("[data-sidebar-overlay]")).toHaveCSS(
    "animation-duration",
    "0s",
  );

  await page.setViewportSize({ width: 1200, height: 600 });
  await page.addInitScript(() => {
    localStorage.setItem("yep-anywhere-session-right-pane-enabled", "true");
    localStorage.setItem("yep-anywhere-sidebar-expanded", "true");
  });
  await page.route("**/api/version*", async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      json: {
        ...(await response.json()),
        artifactViewer: {
          port: 4402,
          available: true,
          locked: false,
          defaultLocalOrigin: baseURL,
          localOrigin: baseURL,
          vhosts: [{ name: "plan", port: 19432 }],
        },
      },
    });
  });
  await page.route("**/api/artifacts/vhosts/links", (route) =>
    route.fulfill({ json: { tokens: { plan: "test-token" } } }),
  );
  await page.route("**/api/artifacts/vhosts/plan/listener", (route) =>
    route.fulfill({ json: { token: "listener" } }),
  );
  await page.route("http://plan.localhost:*/**", (route) =>
    route.fulfill({ contentType: "text/html", body: "<p>App preview</p>" }),
  );
  const projectId = Buffer.from(join(e2ePaths.tempDir, "mockproject")).toString(
    "base64url",
  );
  const sessionId = "mock-session-001";
  await page.route(
    new RegExp(
      `/api/projects/[^/]+/sessions/${sessionId}(?:/metadata)?(?:\\?|$)`,
    ),
    async (route) => {
      const response = await route.fetch();
      const data = await response.json();
      await route.fulfill({
        json: {
          ...data,
          messages: [
            ...(data.messages ?? []),
            {
              uuid: "slide-app-result",
              type: "user",
              timestamp: new Date().toISOString(),
              content: [
                {
                  type: "tool_result",
                  tool_use_id: "slide-app",
                  content: "App at http://localhost:19432/review",
                },
              ],
            },
          ],
        },
      });
    },
  );
  await page.goto(`/projects/${projectId}/sessions/${sessionId}`);
  const app = page.getByRole("button", { name: "App", exact: true });
  const pane = page.getByRole("complementary", { name: "Session pane" });
  await expect(app).toBeVisible();
  await expect(sidebar).not.toHaveAttribute("data-sidebar-collapsed", "true");
  await app.click();
  await expect(pane).toBeVisible();
  await expect(pane).toHaveCSS("transition-duration", "0s, 0s");
  await expect(sidebar).toHaveAttribute("data-sidebar-collapsed", "true");
  await expect(sidebar).toHaveCSS("transition-duration", "0s");
  await app.click();
  await expect(pane).toHaveCount(0);
  await expect(sidebar).not.toHaveAttribute("data-sidebar-collapsed", "true");
  await expect(sidebar).toHaveCSS("transition-duration", "0s");

  await page.goto("/settings/appearance");
  await animationToggle.locator("..").click();
  await expect(sidebar).toHaveCSS("transition-duration", "0.2s");
});

for (const animations of [false, true]) {
  test(`file viewers use the right pane with animations ${animations ? "on" : "off"}`, async ({
    page,
  }) => {
    test.setTimeout(60_000);
    await page.addInitScript((enabled) => {
      localStorage.setItem("yep-anywhere-session-right-pane-enabled", "true");
      localStorage.setItem(
        "yep-anywhere-panel-slide-animations",
        String(enabled),
      );
    }, animations);
    await page.setViewportSize({ width: 1200, height: 600 });
    const projectId = Buffer.from(
      join(e2ePaths.tempDir, "mockproject"),
    ).toString("base64url");
    await page.goto(`/projects/${projectId}/sessions/file-viewer-absolute-001`);
    const link = page.locator('a[data-ya-private-project-file-link="true"]');
    await expect(link).toBeVisible();
    await link.click();
    const pane = page.getByRole("complementary", { name: "Session pane" });
    const viewer = pane.locator(".file-viewer");
    await expect(
      viewer.getByText("Test Project", { exact: true }),
    ).toBeVisible();
    await expect(page.locator("[data-file-viewer-modal]")).toHaveCount(0);
    await expect(pane).toHaveCSS(
      "transition-duration",
      animations ? "0.2s, 0s" : "0s, 0s",
    );
    const content = await viewer.elementHandle();
    if (!content) throw new Error("Missing file viewer");
    await expect
      .poll(async () => {
        const bounds = await pane.boundingBox();
        return bounds?.width;
      })
      .toBeGreaterThan(280);
    const [workspaceBounds, sessionBounds, paneBounds] = await Promise.all([
      page.locator("[data-main-content-constrained]").boundingBox(),
      page.locator('[class*="sessionColumn"]').boundingBox(),
      pane.boundingBox(),
    ]);
    expect(workspaceBounds).not.toBeNull();
    expect(sessionBounds).not.toBeNull();
    expect(paneBounds).not.toBeNull();
    expect(paneBounds!.width).toBeLessThan(workspaceBounds!.width * 0.61);
    expect(sessionBounds!.width).toBeGreaterThan(workspaceBounds!.width * 0.39);
    expect(sessionBounds!.x + sessionBounds!.width).toBeLessThanOrEqual(
      paneBounds!.x + 1,
    );
    await recordUiCapture(page, `file-pane-desktop-${animations}`);

    const body = viewer.locator(".file-viewer-body");
    await body.evaluate((element) => {
      element.scrollTop = 30;
    });
    const scrollTop = await body.evaluate((element) => element.scrollTop);
    await viewer
      .getByRole("button", { name: "Minimize file viewer", exact: true })
      .click();
    await expect(pane).toHaveCount(0);
    const restore = page.getByRole("button", { name: /^Restore file viewer:/ });
    await restore.click();
    await expect(viewer).toBeVisible();
    expect(await content.evaluate((element) => element.isConnected)).toBe(true);
    expect(await body.evaluate((element) => element.scrollTop)).toBe(scrollTop);

    if (!animations) {
      const immediate = await page.evaluate(async () => {
        const button = document.querySelector<HTMLButtonElement>(
          '.file-viewer button[aria-label="Close"]',
        );
        if (!button) throw new Error("Missing close action");
        let frameRan = false;
        const frame = requestAnimationFrame(() => {
          frameRan = true;
        });
        button.click();
        await Promise.resolve();
        const root = document.querySelector<HTMLElement>(
          'aside[aria-label="Session pane"]',
        );
        if (!root) throw new Error("Missing pane shell");
        const result = {
          frameRan,
          hidden: root.getAttribute("aria-hidden"),
          transitions: root.getAnimations().length,
          viewerPresent: !!root.querySelector(".file-viewer"),
          track: getComputedStyle(root.parentElement!)
            .gridTemplateColumns.split(" ")
            .at(-1),
        };
        cancelAnimationFrame(frame);
        return result;
      });
      expect(immediate).toEqual({
        frameRan: false,
        hidden: "true",
        transitions: 0,
        viewerPresent: false,
        track: "0px",
      });
      await link.click();
      await expect(viewer).toBeVisible();
    }

    await page.setViewportSize({ width: 375, height: 812 });
    await expect(viewer).toBeVisible();
    await expect(pane).toHaveCSS("position", "absolute");
    await recordUiCapture(page, `file-pane-phone-${animations}`);
    const close = viewer.getByRole("button", { name: "Close", exact: true });
    const centering = await close.evaluate((button) => {
      const icon = button.querySelector("svg")!;
      const a = button.getBoundingClientRect();
      const b = icon.getBoundingClientRect();
      return {
        x: Math.abs(a.x + a.width / 2 - b.x - b.width / 2),
        y: Math.abs(a.y + a.height / 2 - b.y - b.height / 2),
      };
    });
    expect(centering.x).toBeLessThan(0.6);
    expect(centering.y).toBeLessThan(0.6);
    await close.click();
    await expect(page.locator(".file-viewer")).toHaveCount(0);
  });
}

test("nested files stay in the right pane and Back preserves the parent", async ({
  page,
}) => {
  const readme = join(e2ePaths.tempDir, "file-browser-project", "README.md");
  const original = readFileSync(readme, "utf8");
  writeFileSync(readme, "# Parent file\n\n[Open child](./test.txt)\n");
  try {
    await page.addInitScript(() => {
      localStorage.setItem("yep-anywhere-session-right-pane-enabled", "true");
      localStorage.setItem("yep-anywhere-panel-slide-animations", "false");
    });
    await page.setViewportSize({ width: 1200, height: 600 });
    const projectId = Buffer.from(
      join(e2ePaths.tempDir, "mockproject"),
    ).toString("base64url");
    await page.goto(`/projects/${projectId}/sessions/file-viewer-absolute-001`);
    await page.locator('a[data-ya-private-project-file-link="true"]').click();
    const pane = page.getByRole("complementary", { name: "Session pane" });
    await expect(
      pane.getByRole("heading", { name: "Parent file" }),
    ).toBeVisible();
    const parent = await pane.locator(".file-viewer").elementHandle();
    await pane.getByRole("link", { name: "Open child" }).click();
    await expect(
      pane.getByText("Hello from test file!", { exact: true }),
    ).toBeVisible();
    await expect(pane.locator(".file-viewer")).toHaveCount(2);
    await expect(page.locator("[data-file-viewer-modal]")).toHaveCount(0);
    await pane
      .getByRole("button", { name: "Back", exact: true })
      .last()
      .click();
    await expect(pane.locator(".file-viewer")).toHaveCount(1);
    expect(await parent?.evaluate((element) => element.isConnected)).toBe(true);
    await expect(
      pane.getByRole("heading", { name: "Parent file" }),
    ).toBeVisible();
    await pane.getByRole("button", { name: "Close", exact: true }).click();
    await expect(pane).toHaveCount(0);
  } finally {
    writeFileSync(readme, original);
  }
});
