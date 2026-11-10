import { join } from "node:path";
import { e2ePaths, expect, test } from "./fixtures.js";
import { recordUiCapture } from "./support/ui-capture.js";

for (const degraded of [false, true]) {
  test(`mobile shell stays anchored with safe-area spacing (degraded host: ${degraded})`, async ({
    page,
  }) => {
    test.setTimeout(45_000);
    await page.setViewportSize({ width: 375, height: 812 });
    await page.route("**/api/version", async (route) => {
      const response = await route.fetch();
      await route.fulfill({
        response,
        json: { ...(await response.json()), providerHostDegraded: degraded },
      });
    });
    const projectId = Buffer.from(
      join(e2ePaths.tempDir, "mockproject"),
    ).toString("base64url");
    for (const path of [
      `/projects/${projectId}/sessions/mock-session-001`,
      "/inbox",
    ]) {
      await page.goto(path);
      const header = page
        .locator("[data-session-header]")
        .filter({ visible: true });
      await expect(header).toBeVisible();
      if (path !== "/inbox") {
        await expect(
          page.getByRole("main").getByText("Previous message", { exact: true }),
        ).toBeVisible();
      }
      const banner = page.locator('[data-provider-host-degraded="true"]');
      if (degraded) await expect(banner).toBeVisible();

      // Desktop Chromium has zero native safe-area insets. Supply the same
      // resolved body/frame padding as an edge-to-edge Android browser; do
      // not change positioning, overflow, or the app's height calculation.
      await page.addStyleTag({
        content: "body, [data-session-page] { padding-bottom: 24px; }",
      });
      for (const height of [812, 480, 812]) {
        await page.setViewportSize({ width: 375, height });
        await page.evaluate(() => window.scrollTo(0, 100));
        await expect
          .poll(() =>
            page.evaluate(() => ({
              scroll: window.scrollY,
              overflow:
                (document.scrollingElement?.scrollHeight ?? 0) -
                window.innerHeight,
            })),
          )
          .toEqual({ scroll: 0, overflow: 0 });
        const headerBox = await header.boundingBox();
        expect(headerBox!.y).toBeGreaterThanOrEqual(0);
        if (degraded) {
          const bannerBox = await banner.boundingBox();
          expect(headerBox!.y).toBeGreaterThanOrEqual(
            bannerBox!.y + bannerBox!.height,
          );
        }
        if (path !== "/inbox") {
          const composer = page.locator("footer[data-session-input]");
          await expect(composer).toBeVisible();
          await expect
            .poll(async () => {
              const box = await composer.boundingBox();
              return box ? Math.round(box.y + box.height) : null;
            })
            .toBe(height - 24);
        }
      }
      await recordUiCapture(
        page,
        `mobile-viewport-${path === "/inbox" ? "inbox" : "session"}-${degraded ? "degraded" : "healthy"}`,
      );
    }
  });
}
