import { expect, test } from "./fixtures.js";
import { recordUiCapture } from "./support/ui-capture.js";

test("session preview links suppress context menus and preserve link gestures", async ({
  page,
  baseURL,
}) => {
  await page.addInitScript(() => {
    if (!localStorage.getItem("yep-anywhere-tooltip-mode")) {
      localStorage.setItem("yep-anywhere-tooltip-mode", "themed");
    }
    localStorage.setItem("yep-anywhere-tooltip-delay-ms", "0");
    document.addEventListener("contextmenu", (event) => {
      if (event.target instanceof Element) {
        event.target
          .closest("a")
          ?.setAttribute(
            "data-context-menu-prevented",
            String(event.defaultPrevented),
          );
      }
    });
  });
  await page.setViewportSize({ width: 1200, height: 600 });
  await page.goto(`${baseURL}/settings/appearance`);
  await page
    .getByRole("button", { name: "Expand sidebar", exact: true })
    .click();

  const link = page
    .locator("[data-sidebar] [data-session-list-item__link]")
    .first();
  const href = await link.getAttribute("href");
  expect(href).toBeTruthy();
  await link.hover();
  const card = page.locator("[data-session-hovercard-id]");
  await expect(card).toBeVisible();
  await link.click({ button: "right" });
  await expect(link).toHaveAttribute("data-context-menu-prevented", "true");
  await expect(card).toBeVisible();
  await recordUiCapture(page, "session-context-menu-desktop");

  for (const options of [
    { button: "middle" as const },
    { modifiers: ["Shift" as const] },
    // Native Control-click is a context-menu gesture on macOS, not a click.
    { modifiers: ["ControlOrMeta" as const] },
  ]) {
    const popupPromise = page.context().waitForEvent("page");
    await link.click(options);
    const popup = await popupPromise;
    await popup.waitForURL(new URL(href!, baseURL).href);
    expect(new URL(page.url()).pathname).toBe("/settings/appearance");
    await popup.close();
  }

  if (process.platform === "darwin") {
    await link.evaluate((element) =>
      element.removeAttribute("data-context-menu-prevented"),
    );
    await link.click({ modifiers: ["Control"] });
    await expect(link).toHaveAttribute("data-context-menu-prevented", "true");
    expect(page.context().pages()).toHaveLength(1);
  }

  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto(`${baseURL}/inbox`);
  await page.getByRole("button", { name: "Open sidebar", exact: true }).click();
  await link.hover();
  await expect(card).toBeVisible();
  await link.click({ button: "right" });
  await expect(link).toHaveAttribute("data-context-menu-prevented", "true");
  await expect(card).toBeVisible();
  await recordUiCapture(page, "session-context-menu-phone");

  await link.click();
  await expect(page).toHaveURL(new URL(href!, baseURL).href);

  await page.evaluate(() => {
    localStorage.setItem("yep-anywhere-tooltip-mode", "native");
  });
  await page.reload();
  await page.getByRole("button", { name: "Open sidebar", exact: true }).click();
  await link.hover();
  await link.click({ button: "right" });
  await expect(link).toHaveAttribute("data-context-menu-prevented", "false");
  await expect(card).toHaveCount(0);
});
