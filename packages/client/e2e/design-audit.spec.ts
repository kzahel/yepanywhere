import { expect, test } from "@playwright/test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createTestViteServer } from "./support/vite-server";
import { recordUiCapture, presentUiCaptures } from "./support/ui-capture";

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

for (const phone of [false, true]) {
  test(`audit navigation and disclosures on ${phone ? "phone" : "desktop"}`, async ({
    page,
  }) => {
    await page.setViewportSize(
      phone ? { width: 375, height: 812 } : { width: 1000, height: 600 },
    );
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${base}design.html#/audit`);
    await expect(page.locator("[data-design-ready]")).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Design audit", exact: true }),
    ).toHaveCount(1);
    await expect(page.getByRole("group", { name: "Themes shown" })).toHaveCount(
      0,
    );
    await expect(page.getByText("Remaining", { exact: true })).toHaveCount(0);
    await expect(page.locator("details[open]")).toHaveCount(0);
    await recordUiCapture(page, `audit-${phone ? "phone" : "desktop"}`);
    await page
      .getByRole("navigation", { name: "Audit sections" })
      .getByRole("link", { name: /Reviewed exceptions/ })
      .click();
    await expect(page).toHaveURL(/section=exceptions/);
    const summary = page
      .locator("summary")
      .filter({ hasText: "Control appearance overrides" });
    await summary.focus();
    await page.keyboard.press("Enter");
    await expect(summary.locator("..")).toHaveAttribute("open", "");
    await expect(
      summary.locator("..").getByRole("heading", { name: /Button family/ }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await summary.scrollIntoViewIfNeeded();
    await recordUiCapture(
      page,
      `audit-exceptions-${phone ? "phone" : "desktop"}`,
    );
    // Existing bookmarks and capture URLs must reach the report, not a missing
    // specimen or six copies of an isolated Remaining state.
    for (const [legacy, section] of [
      ["composer", "migrations"],
      ["control-overrides", "exceptions"],
      ["button-base-exceptions", "exceptions"],
      ["element-exceptions", "exceptions"],
      ["token-literals", "exceptions"],
      ["runtime-class-families", "generated"],
    ]) {
      await page.evaluate((hash) => {
        location.hash = hash;
      }, `#/census-${legacy}--remaining?iso&theme=light`);
      const heading = page.locator(`#audit-${section} h2`);
      await expect(heading).toBeInViewport();
      await expect(
        page.getByRole("heading", { name: "Design audit", exact: true }),
      ).toHaveCount(1);
    }
    if (phone)
      await page.getByRole("button", { name: "Pages", exact: true }).click();
    await page
      .getByRole("navigation", { name: "Playground pages" })
      .getByRole("link", { name: "Controls/Button", exact: true })
      .click();
    await expect(
      page.getByRole("group", { name: "Themes shown" }),
    ).toBeAttached();
    await expect(
      page.getByRole("heading", { name: "Controls/Button", exact: true }),
    ).toBeVisible();
    expect(errors).toEqual([]);
  });
}
