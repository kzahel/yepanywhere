import { expect, test } from "@playwright/test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { UI_KEYS } from "../src/lib/storageKeys";
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

// A real-browser boundary: fixture imports must never acquire live settings or
// providers, and saved toolbar preferences must not change the fixed scenes.
for (const phone of [false, true]) {
  test(`composer scenes stay isolated on ${phone ? "phone" : "desktop"}`, async ({
    page,
  }) => {
    await page.setViewportSize(
      phone ? { width: 375, height: 812 } : { width: 1000, height: 600 },
    );
    const keys = [
      UI_KEYS.sessionToolbarPresence,
      UI_KEYS.waveformButtonBackgroundOpacityPercent,
    ];
    const saved = [
      JSON.stringify({
        modeSelector: "hidden",
        attachments: "hidden",
        waveform: "off",
      }),
      "0",
    ];
    await page.addInitScript(
      ({ keys, saved }) => {
        keys.forEach((key, index) => {
          localStorage.setItem(key, saved[index]!);
        });
      },
      { keys, saved },
    );
    const errors: string[] = [];
    const apiRequests: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error" || message.type() === "warning")
        errors.push(message.text());
    });
    page.on("request", (request) => {
      if (new URL(request.url()).pathname.startsWith("/api/"))
        apiRequests.push(request.url());
    });
    for (const theme of ["verydark", "dark", "light"]) {
      await page.goto(`${base}design.html#/scenes-composer?theme=${theme}`);
      await expect(page.locator("[data-design-ready]")).toBeVisible();
      await expect(
        page.getByRole("heading", { name: "Scenes/Composer", exact: true }),
      ).toBeVisible();
      const toolbars = page.locator("[data-message-input-toolbar]");
      await expect(toolbars).toHaveCount(2);
      for (const toolbar of await toolbars.all()) {
        await expect(toolbar).not.toHaveAttribute(
          "data-waveform-button-background-opacity",
          /.+/,
        );
        await expect(
          toolbar.locator('[data-session-toolbar-control="attachments"]'),
        ).toHaveCount(1);
        await expect(toolbar.locator("xpath=..")).toHaveAttribute("inert", "");
      }
      await expect(page.locator("[data-composer-speech-waveform]")).toHaveCount(
        0,
      );
      // The context ring is retained, while its hidden interactive editor and
      // service subscriptions are absent from these inert reference scenes.
      await expect(page.locator("[data-context-usage-indicator]")).toHaveCount(
        2,
      );
      await expect(page.locator('[aria-haspopup="dialog"]')).toHaveCount(0);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      expect(
        await page.evaluate(
          (keys) => keys.map((key) => localStorage.getItem(key)),
          keys,
        ),
      ).toEqual(saved);
      await recordUiCapture(
        page,
        `composer-${theme}-${phone ? "phone" : "desktop"}`,
      );
    }
    expect(apiRequests).toEqual([]);
    expect(errors).toEqual([]);
  });
}
