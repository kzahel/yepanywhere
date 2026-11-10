import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { createTestViteServer } from "./support/vite-server";
import { presentUiCaptures, recordUiCapture } from "./support/ui-capture";

let server: Awaited<ReturnType<typeof createTestViteServer>>;
let base: string;
test.beforeAll(async () => {
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

async function revealed(button: Locator) {
  await expect(button).toHaveCSS("opacity", "1");
  await expect(button).not.toHaveCSS("pointer-events", "none");
  await button.click({ trial: true });
}
async function tabTo(page: Page, before: Locator, target: Locator) {
  await before.focus();
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press("Tab");
    if (await target.evaluate((element) => element === document.activeElement))
      return;
  }
  throw new Error(`Tab never reached ${await target.getAttribute("class")}`);
}

// CSS opacity and hit testing are the unique browser boundary here. jsdom's
// visibility assertions cannot catch a missing hover/focus selector body.
test("copy and row actions reveal and accept clicks on hover and real Tab focus", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.setViewportSize({ width: 1000, height: 600 });
  await page.goto(`${base}e2e/fixtures/control-reveal.html`);
  const cases = [
    ["tool", ".tool-row-header", ".tool-header-copy"],
    ["bash", ".bash-inline-section-header", ".bash-section-copy"],
    ["text", ".text-block", ".text-block-copy"],
    ["text", ".text-block", ".text-block-toggle"],
    ["quote", ".text-block", ".text-block-quote-paragraph"],
    ["text", ".text-block", ".text-block-quote-fallback"],
    ["edit", ".diff-view-container", ".diff-copy-button"],
    ["app", "[class*=title]", "[class*=copyPath]"],
    ["host", ".host-picker-item", ".host-picker-delete"],
    ["menu", "[class*=rowSurface]", "[class*=trigger]"],
    ["last", "[data-site=last]", "[class*=reopen]"],
  ];
  for (const [siteName, surfaceSelector, buttonSelector] of cases) {
    const site = page.locator(`[data-site=${siteName}]`);
    const button = site.locator(buttonSelector!).first();
    await button.waitFor({ state: "attached" });
    await site.scrollIntoViewIfNeeded();
    const surface =
      siteName === "last" ? site : site.locator(surfaceSelector!).first();
    await surface.hover({ position: { x: 10, y: 10 } });
    // LastSessionFile reveals when the action itself is hovered.
    if (siteName === "last") await button.hover();
    await revealed(button);
    await page.mouse.move(0, 0);
    await tabTo(page, site.locator("[data-before]"), button);
    // Test focus before copying can set the persistent .copied reveal state.
    await expect(button).toHaveCSS("opacity", "1");
    await expect(button).not.toHaveCSS("pointer-events", "none");
    await page.keyboard.press("Enter");
    await revealed(button);
    if (
      ["tool", "bash", "text", "edit"].includes(siteName!) &&
      buttonSelector!.includes("copy")
    ) {
      await expect(button).toHaveClass(/copied/);
      if (siteName === "tool" || siteName === "bash") {
        await site.locator("[data-before]").focus();
        await page.mouse.move(0, 0);
        await expect(button).toHaveCSS("opacity", "1");
      }
    }
    await button.click();
    await revealed(button);
  }
  const bash = page.locator("[data-site=bash] .bash-section-copy");
  await bash.click();
  await page.locator("[data-before=tool]").focus();
  await page.mouse.move(0, 0);
  await expect(bash).toHaveCSS("opacity", "1");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    "bash clipboard witness",
  );
  for (const viewport of [
    { width: 1000, height: 600 },
    { width: 375, height: 812 },
  ]) {
    await page.setViewportSize(viewport);
    await page.locator("[data-site=tool]").hover();
    await recordUiCapture(page, `reveal-${viewport.width}`);
  }
});
