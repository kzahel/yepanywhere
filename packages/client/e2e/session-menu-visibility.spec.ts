import { expect, test } from "@playwright/test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createTestViteServer } from "./support/vite-server";
import { recordUiCapture, presentUiCaptures } from "./support/ui-capture";

let server: Awaited<ReturnType<typeof createTestViteServer>>;
let base: string;
test.beforeAll(async ({ browserName }) => {
  const captures = process.env.YEP_E2E_UI_CAPTURE_DIR;
  if (captures)
    process.env.YEP_E2E_UI_CAPTURE_DIR = resolve(captures, browserName);
  server = await createTestViteServer({
    root: resolve(dirname(fileURLToPath(import.meta.url)), ".."),
    server: { host: "127.0.0.1" },
  });
  await server.listen();
  base = server.resolvedUrls!.local[0]!;
});
test.afterAll(async () => {
  await server?.close();
  await presentUiCaptures();
});

for (const touch of [false, true]) {
  test(`session menus reveal only the active row on ${touch ? "touch" : "desktop"}`, async ({
    browser,
  }, testInfo) => {
    const context = await browser.newContext({
      viewport: { width: touch ? 375 : 1000, height: touch ? 812 : 600 },
      isMobile: touch,
      hasTouch: touch,
    });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/api/version**", (route) =>
      route.fulfill({ json: { version: "0.9.3", capabilities: [] } }),
    );
    try {
      await page.goto(`${base}e2e/fixtures/session-menu.html`);
      const rows = page.locator("[data-session-list-item]");
      const menus = page.locator("[data-session-menu]");
      await expect(rows).toHaveCount(17);
      await expect
        .poll(() =>
          menus.evaluateAll((elements) =>
            elements.every(
              (element) => getComputedStyle(element).opacity === "0",
            ),
          ),
        )
        .toBe(true);
      await recordUiCapture(
        page,
        `session-menu-${testInfo.project.name}-${touch ? "phone" : "desktop"}`,
      );

      const first = rows.first();
      const firstMenu = first.locator("[data-session-menu]");
      const secondMenu = rows.nth(1).locator("[data-session-menu]");
      if (touch) {
        // Exercise touch focus without relying on emulated mouse hover.
        await first.locator("[data-session-list-item__link]").focus();
      } else {
        await first.hover();
      }
      await expect(firstMenu).toHaveCSS("opacity", "1");
      await expect(secondMenu).toHaveCSS("opacity", "0");
      await first.getByRole("button", { name: "Session options" }).click();
      await expect(firstMenu).toHaveClass(/is-open/);
      await expect(firstMenu).toHaveCSS("opacity", "1");
      await page.mouse.click(350, 10);
      await page.evaluate(() =>
        (document.activeElement as HTMLElement)?.blur(),
      );
      await page.mouse.move(350, 10);
      await expect(firstMenu).toHaveCSS("opacity", "0");

      const target = rows.nth(1).locator("[data-session-list-item__link]");
      if (touch) await target.tap({ position: { x: 40, y: 20 } });
      else await target.click({ position: { x: 40, y: 20 } });
      await expect(page.getByLabel("Opened session")).toHaveText(
        "/projects/project/sessions/session-1",
      );
      const cardLink = rows.last().locator("[data-session-list-item__link]");
      // Establish keyboard modality after the pointer navigation above.
      // WebKit's default Tab traversal skips links; focus the same link in both engines.
      if (!touch) await page.keyboard.press("Tab");
      await cardLink.focus();
      await expect(cardLink).toBeFocused();
      await expect(rows.last().locator("[data-session-menu]")).toHaveCSS(
        "opacity",
        "1",
      );
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  });
}
