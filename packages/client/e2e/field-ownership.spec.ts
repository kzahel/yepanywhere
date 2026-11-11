import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
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

// Browser layout and native input identity are the boundary: a clear action
// appearing on the first character must not remount the editor or steal focus.
test("field slots retain native typing, focus and touch targets under updates", async ({
  browser,
}) => {
  for (const touch of [false, true]) {
    const context = await browser.newContext({
      viewport: touch
        ? { width: 375, height: 812 }
        : { width: 1000, height: 600 },
      hasTouch: touch,
      isMobile: touch,
    });
    const page = await context.newPage();
    try {
      await page.goto(`${base}e2e/fixtures/field-ownership.html`);
      const search = page.getByRole("searchbox", { name: "Search settings" });
      await expect(search).toBeVisible();
      await page.evaluate(() => document.fonts.ready);
      await search.focus();
      await search.evaluate((element) => {
        const input = element as HTMLInputElement;
        const state = window as unknown as {
          fieldSamples: { value: string; delay: number; retained: boolean }[];
          originalInput: HTMLInputElement;
        };
        state.originalInput = input;
        state.fieldSamples = [];
        let keyStart = 0;
        input.addEventListener("keydown", (event) => {
          keyStart = event.timeStamp;
        });
        input.addEventListener("input", () => {
          const start = keyStart;
          const value = input.value;
          requestAnimationFrame(() =>
            requestAnimationFrame(() => {
              state.fieldSamples.push({
                value,
                delay: performance.now() - start,
                retained: input.isConnected && input.value.startsWith(value),
              });
            }),
          );
        });
      });
      const text = "Setting 123";
      for (const character of text) await page.keyboard.type(character);
      await expect(search).toHaveValue(text);
      await expect(search).toBeFocused();
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              (window as unknown as { fieldSamples: unknown[] }).fieldSamples
                .length,
          ),
        )
        .toBe(text.length);
      const samples = await page.evaluate(
        () =>
          (
            window as unknown as {
              fieldSamples: {
                value: string;
                delay: number;
                retained: boolean;
              }[];
            }
          ).fieldSamples,
      );
      expect(samples.map((sample) => sample.value)).toEqual(
        [...text].map((_, index) => text.slice(0, index + 1)),
      );
      expect(samples.every((sample) => sample.retained)).toBe(true);
      expect(Math.max(...samples.map((sample) => sample.delay))).toBeLessThan(
        100,
      );
      expect(
        await search.evaluate(
          (element) =>
            element ===
            (window as unknown as { originalInput: HTMLElement }).originalInput,
        ),
      ).toBe(true);
      const clear = page.getByRole("button", { name: "Clear search" });
      const inputRect = (await search.boundingBox())!;
      const clearRect = (await clear.boundingBox())!;
      expect(inputRect.x + inputRect.width).toBeLessThanOrEqual(clearRect.x);
      await recordUiCapture(
        page,
        `fields-typed-${touch ? "phone" : "desktop"}`,
      );
      await clear.click();
      await expect(search).toHaveValue("");
      expect(
        await search.evaluate(
          (element) =>
            element ===
            (window as unknown as { originalInput: HTMLElement }).originalInput,
        ),
      ).toBe(true);
      const select = page.getByRole("combobox", { name: "Prefix" });
      await select.focus();
      await select.evaluate((element) => {
        (window as unknown as { originalSelect: Element }).originalSelect =
          element;
      });
      await select.selectOption("icon");
      expect(
        await select.evaluate(
          (element) =>
            element ===
            (window as unknown as { originalSelect: HTMLElement })
              .originalSelect,
        ),
      ).toBe(true);
      await expect(select).toBeFocused();
      const source = page.getByRole("searchbox", { name: "Compact source" });
      await source.focus();
      await expect(source).toHaveAttribute("aria-invalid", "true");
      const errorColor = await source.evaluate((element) => {
        const sample = document.createElement("span");
        sample.style.color = "var(--error-color)";
        element.parentElement!.append(sample);
        const color = getComputedStyle(sample).color;
        sample.remove();
        return color;
      });
      await expect(source.locator("..")).toHaveCSS(
        "border-top-color",
        errorColor,
      );
      await expect(source.locator("..")).toHaveCSS(
        "box-shadow",
        `${errorColor} 0px 0px 0px 1px`,
      );
      await source.fill("abc");
      const sourceRect = (await source.boundingBox())!;
      await source.click({
        position: { x: sourceRect.width - 16, y: sourceRect.height / 2 },
      });
      await expect(source).toHaveValue("");
      const row = page
        .getByText("Touch choice", { exact: true })
        .locator("xpath=ancestor::label");
      if (touch) {
        expect((await row.boundingBox())!.height).toBeGreaterThanOrEqual(44);
        expect(
          (await source.locator("..").boundingBox())!.height,
        ).toBeGreaterThanOrEqual(44);
      }
      await row.click({
        position: { x: 3, y: (await row.boundingBox())!.height - 3 },
      });
      await expect(
        page.getByRole("checkbox", { name: "Touch choice" }),
      ).toBeChecked();
      for (const theme of ["dark", "light"]) {
        await page
          .locator("html")
          .evaluate(
            (element, value) => element.setAttribute("data-theme", value),
            theme,
          );
        await recordUiCapture(
          page,
          `fields-${theme}-${touch ? "phone" : "desktop"}`,
        );
      }
      console.log(
        `Field input ${touch ? "phone" : "desktop"}: ${Math.max(...samples.map((sample) => sample.delay)).toFixed(1)}ms maximum`,
      );
    } finally {
      await context.close();
    }
  }
});
