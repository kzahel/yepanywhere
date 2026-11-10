import { join } from "node:path";
import type { Page } from "@playwright/test";
import { e2ePaths, expect, test } from "./fixtures.js";
import { recordUiCapture } from "./support/ui-capture.js";

const mockProjectPath = join(e2ePaths.tempDir, "mockproject");
const projectId = Buffer.from(mockProjectPath).toString("base64url");
const sessionId = "transcript-specimen-001";

async function openSpecimen(page: Page, baseURL: string | undefined) {
  await page.goto(`${baseURL}/projects/${projectId}/sessions/${sessionId}`);
  const skip = page.getByRole("button", { name: "Skip all", exact: true });
  if (
    await skip
      .waitFor({ state: "visible", timeout: 750 })
      .then(() => true)
      .catch(() => false)
  ) {
    await skip.click();
  }
  await expect(
    page.locator('[data-message-list] [data-render-id="specimen-assistant-2"]'),
  ).toBeVisible({ timeout: 10000 });
}

test.use({ serviceWorkers: "block" });

for (const viewport of [
  { name: "desktop", width: 1000, height: 600 },
  { name: "phone", width: 375, height: 812 },
]) {
  test(`scope picker, key help and close at selection (${viewport.name})`, async ({
    page,
    baseURL,
  }) => {
    await page.setViewportSize(viewport);
    await openSpecimen(page, baseURL);

    await page.keyboard.press("Control+Alt+k");
    const scope = page.getByRole("combobox", { name: "Search scope" });
    await expect(scope).toHaveValue("links");
    const input = page.getByRole("textbox", {
      name: "Reverse search link labels",
    });
    await expect(input).toBeFocused();
    await input.fill("specimen");
    const search = page.getByRole("search");
    await expect(search.getByText("0/0")).toBeVisible();

    await scope.selectOption("all");
    const allInput = page.getByRole("textbox", {
      name: "Reverse search all turns",
    });
    await expect(allInput).toBeFocused();
    await expect(allInput).toHaveValue("specimen");
    await expect(search.getByText(/^\d+\/[1-9]\d*$/)).toBeVisible();

    const helpToggle = page.getByRole("button", { name: "Show search keys" });
    if (viewport.name === "phone") {
      await expect(search.getByText(/Esc cancel/)).toBeHidden();
      await helpToggle.click();
      await expect(search.getByText(/Esc cancel/)).toBeVisible();
      await expect(allInput).toBeFocused();
    } else {
      await expect(helpToggle).toBeHidden();
      await expect(search.getByText(/Esc cancel/)).toBeVisible();
    }
    await recordUiCapture(page, viewport.name, viewport);

    await page.getByRole("button", { name: "Close at selected match" }).click();
    await expect(search).toHaveCount(0);
  });
}

test("committed jumps retain the needle through activity then fade after idle", async ({
  page,
  baseURL,
}) => {
  await page.setViewportSize({ width: 1000, height: 600 });
  await openSpecimen(page, baseURL);

  await page.keyboard.press("Control+s");
  await page
    .getByRole("textbox", { name: "Reverse search all turns" })
    .fill("specimen is ready");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("search")).toHaveCount(0);
  const landed = page.locator('[data-search-match="true"]');
  await expect(landed).toHaveCount(1);
  await expect(landed).toHaveClass(/landed/);

  await page.keyboard.press("Shift");
  await expect(landed).toHaveCount(1);
  await expect
    .poll(() =>
      landed.evaluate((row) =>
        Number(
          getComputedStyle(row).getPropertyValue("--search-match-opacity"),
        ),
      ),
    )
    .toBeLessThan(1);
  const fadingOpacity = await landed.evaluate((row) =>
    Number(getComputedStyle(row).getPropertyValue("--search-match-opacity")),
  );
  expect(fadingOpacity).toBeGreaterThan(0);
  await expect(landed).toHaveCount(0);

  await page.keyboard.press("Control+s");
  await page
    .getByRole("textbox", { name: "Reverse search all turns" })
    .fill("specimen is ready");
  await page
    .getByRole("navigation", { name: "Turn navigation" })
    .getByRole("button", { name: "The specimen is ready.", exact: true })
    .click({ button: "right" });
  await expect(page.getByRole("search")).toHaveCount(0);
  await expect(landed).toHaveClass(/landed/);
});

for (const { dismiss, viewport } of [
  { dismiss: "click", viewport: { width: 1200, height: 600 } },
  { dismiss: "Escape", viewport: { width: 375, height: 812 } },
] as const) {
  test(`dismissing a clicked match with ${dismiss} keeps every frame fixed`, async ({
    page,
    baseURL,
  }) => {
    await page.setViewportSize(viewport);
    await openSpecimen(page, baseURL);
    await page.addStyleTag({
      content:
        '[data-render-id="specimen-assistant-2"] { padding-top: 700px; padding-bottom: 700px; }',
    });

    await page.keyboard.press("Control+s");
    await page
      .getByRole("textbox", { name: "Reverse search all turns" })
      .fill("specimen is ready");
    await page
      .getByRole("navigation", { name: "Turn navigation" })
      .getByRole("button", { name: "The specimen is ready.", exact: true })
      .click();
    await expect(page.getByRole("search")).toHaveCount(1);
    const framed = page.locator('[data-search-match="true"]');
    await expect(framed).toHaveCount(1);
    await expect(framed).not.toHaveClass(/landed/);
    await recordUiCapture(page, `selected-${dismiss}`, viewport);
    await page.waitForTimeout(100);
    await page.locator(".session-messages").evaluate((port) => {
      port.scrollTop -= 60;
    });
    const text = framed.getByText("The specimen is ready.", { exact: true });
    const before = await text.boundingBox();
    expect(before).not.toBeNull();
    await page.evaluate((dismiss) => {
      const samples: number[] = [];
      Object.assign(window, { isearchDismissFrames: samples });
      window.addEventListener(
        dismiss === "click" ? "click" : "keydown",
        () => {
          const sample = () => {
            const row = document.querySelector(
              '[data-render-id="specimen-assistant-2"]',
            );
            const text = row?.querySelector("p");
            samples.push(text?.getBoundingClientRect().top ?? -10000);
            if (samples.length < 12) requestAnimationFrame(sample);
          };
          requestAnimationFrame(sample);
        },
        { once: true, capture: true },
      );
    }, dismiss);
    if (dismiss === "click") await text.click();
    else await page.keyboard.press("Escape");
    await expect(page.getByRole("search")).toHaveCount(0);
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as unknown as { isearchDismissFrames: number[] })
              .isearchDismissFrames.length,
        ),
      )
      .toBe(12);
    const frames = await page.evaluate(
      () =>
        (window as unknown as { isearchDismissFrames: number[] })
          .isearchDismissFrames,
    );
    expect(
      frames.every((top) => Math.abs(top - (before?.y ?? 0)) < 2),
      JSON.stringify({ before, frames }),
    ).toBe(true);
    await expect(framed).toHaveClass(/landed/);
    await recordUiCapture(page, `dismissed-${dismiss}`, viewport);
  });
}
