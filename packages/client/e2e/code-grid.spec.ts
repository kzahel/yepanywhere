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

test("code grids preserve symbol advances, copying and typing during streaming", async ({
  page,
  context,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto(`${base}e2e/fixtures/code-grid.html`);
  const sourceWidths = await page.evaluate(async () => {
    await document.fonts.load('16px "YA Iosevka"', "0◎●○◯∞∑→");
    const canvas = document.createElement("canvas").getContext("2d")!;
    canvas.font = '16px "YA Iosevka"';
    return Object.fromEntries(
      [..."◎●○◯∞∑→"].map((glyph) => [
        glyph,
        canvas.measureText(glyph).width / canvas.measureText("0").width,
      ]),
    );
  });
  console.log("[font-metrics] original Iosevka cell advances", sourceWidths);
  expect(sourceWidths["◯"]).toBeGreaterThan(1.5);
  const board = page.locator("#board");
  await expect(board).toHaveAttribute("data-ya-code-grid", "");
  await expect(board.locator("code")).toHaveCSS(
    "font-family",
    '"YA Fira Mono", "YA Iosevka", monospace',
  );
  await expect(page.locator("#single")).toHaveAttribute(
    "data-ya-code-grid",
    "",
  );
  await expect(page.locator("#ascii")).toHaveAttribute("data-ya-code-grid", "");
  await expect(page.locator("#ordinary")).not.toHaveAttribute(
    "data-ya-code-grid",
  );
  await expect
    .poll(() =>
      board.evaluate((pre) => {
        const code = pre.querySelector("code")!;
        const range = document.createRange();
        const walker = document.createTreeWalker(code, NodeFilter.SHOW_TEXT);
        const ends: number[] = [];
        const source = code.textContent!;
        let offset = 0;
        while (walker.nextNode()) {
          const node = walker.currentNode as Text;
          for (let index = 0; index < node.length; index++) {
            if (node.data[index] !== "│" || source[offset + index + 1] !== "\n")
              continue;
            range.setStart(node, index);
            range.setEnd(node, index + 1);
            ends.push(range.getBoundingClientRect().left);
          }
          offset += node.length;
        }
        return ends.length >= 2
          ? Math.max(...ends) - Math.min(...ends)
          : Infinity;
      }),
    )
    .toBeLessThan(0.1);
  const original = await board.locator("code").textContent();
  await board.hover();
  await board.getByRole("button", { name: "Copy code" }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    original,
  );
  // Repeated preference refreshes must unwrap/rebuild without nesting cells.
  await page.evaluate(() => {
    window.dispatchEvent(new Event("yep-output-appearance-change"));
  });
  await expect(board.locator("[data-ya-code-cell]").first()).toBeVisible();
  expect(await board.locator("code").textContent()).toBe(original);
  // Background issue metadata changes the React-owned source text structure.
  // Font normalization must not have replaced the text React will remove.
  await page.getByRole("button", { name: "Refresh issue links" }).click();
  expect(errors).toEqual([]);
  await expect(page.locator("#react-source a")).toHaveText("#42");
  await expect(page.locator("#react-source code")).toHaveText(
    "before ◯ #42 after",
  );
  await page.getByRole("button", { name: "Refresh issue links" }).click();
  await expect(page.locator("#react-source a")).toHaveCount(0);
  await expect(page.locator("#react-source code")).toHaveText(
    "before ◯ #42 after",
  );
  await expect(
    board.locator("[data-ya-code-cell] [data-ya-code-cell]"),
  ).toHaveCount(0);
  await page.locator("#single code").evaluate((code) => {
    code.textContent = "中文 👩‍💻 e\u0301";
  });
  await expect(page.locator("#single")).not.toHaveAttribute(
    "data-ya-code-grid",
  );
  await expect(page.locator("#single [data-ya-code-cell]")).toHaveCount(0);

  for (const viewport of [
    { width: 1000, height: 600 },
    { width: 375, height: 812 },
  ]) {
    await page.setViewportSize(viewport);
    await recordUiCapture(page, `code-grid-${viewport.width}`);
  }
  await page.evaluate(() => {
    const history = document.getElementById("history")!;
    for (let index = 0; index < 100; index++) {
      const block = document.createElement("pre");
      const code = document.createElement("code");
      code.textContent = "┌───┐\n│◎●█│\n└───┘";
      block.append(code);
      history.append(block);
    }
  });
  const composer = page.getByRole("textbox", { name: "Message" });
  await composer.scrollIntoViewIfNeeded();
  await composer.evaluate((element) => {
    element.addEventListener("input", (event) => {
      requestAnimationFrame(() => {
        const samples = JSON.parse(
          element.getAttribute("data-latencies") ?? "[]",
        ) as number[];
        samples.push(performance.now() - event.timeStamp);
        element.setAttribute("data-latencies", JSON.stringify(samples));
      });
    });
  });
  let typed = "";
  for (const character of "Keep these grid columns aligned") {
    typed += character;
    await composer.pressSequentially(character);
    await expect(composer).toHaveValue(typed, { timeout: 100 });
  }
  await expect
    .poll(
      async () =>
        JSON.parse((await composer.getAttribute("data-latencies")) ?? "[]")
          .length,
    )
    .toBe(typed.length);
  const latencies = JSON.parse(
    (await composer.getAttribute("data-latencies")) ?? "[]",
  ) as number[];
  expect(Math.max(...latencies)).toBeLessThan(100);
  await expect(page.locator("#react-source code")).toHaveText(
    "before ◯ #42 after",
  );
  console.log(
    "[typing] key count and maximum input-to-frame milliseconds",
    latencies.length,
    Math.max(...latencies),
  );
  expect(errors).toEqual([]);
});

test("code headers never cover source and comments remain readable", async ({
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
    try {
      const page = await context.newPage();
      await page.goto(`${base}e2e/fixtures/code-grid.html`);
      const android = page.locator("#android");
      await expect(
        android.getByRole("button", { name: "Copy code" }),
      ).toBeAttached();
      await page.evaluate(() => document.fonts.ready);
      // Both a labeled, wrapped block and a bare grid need a separate header.
      for (const id of ["android", "board"]) {
        const block = page.locator(`#${id}`);
        const before = await block.boundingBox();
        if (touch) await block.tap();
        else await block.hover();
        const geometry = await block.evaluate((pre) => {
          const button = pre.querySelector("button")!;
          const code = pre.querySelector("code")!;
          const range = document.createRange();
          range.selectNodeContents(code);
          const source = range.getBoundingClientRect();
          const control = button.getBoundingClientRect();
          const style = getComputedStyle(pre);
          return {
            controlBottom: control.bottom,
            sourceTop: source.top,
            codeWidth: code.getBoundingClientRect().width,
            availableWidth:
              pre.clientWidth -
              parseFloat(style.paddingLeft) -
              parseFloat(style.paddingRight),
            targetWidth: control.width,
            targetHeight: control.height,
            headerOverhead:
              pre.getBoundingClientRect().height -
              code.getBoundingClientRect().height,
          };
        });
        expect(geometry.controlBottom).toBeLessThanOrEqual(geometry.sourceTop);
        expect(geometry.codeWidth).toBeCloseTo(geometry.availableWidth, 0);
        expect(geometry.headerOverhead).toBeLessThanOrEqual(touch ? 56 : 36);
        expect((await block.boundingBox())!.height).toBe(before!.height);
        if (touch) {
          expect(geometry.targetWidth).toBeGreaterThanOrEqual(44);
          expect(geometry.targetHeight).toBeGreaterThanOrEqual(44);
        }
      }
      for (const [theme, scheme] of [
        ["dark", "dark"],
        ["verydark", "dark"],
        ["light", "light"],
        ["auto", "dark"],
        ["auto", "light"],
      ] as const) {
        await page.emulateMedia({ colorScheme: scheme });
        await page.evaluate((theme) => {
          document.documentElement.dataset.theme = theme;
        }, theme);
        const contrast = await android.evaluate((pre) => {
          const luminance = (color: string) => {
            const [r, g, b] = color
              .match(/[\d.]+/g)!
              .slice(0, 3)
              .map(Number)
              .map((value) => {
                const channel = value / 255;
                return channel <= 0.04045
                  ? channel / 12.92
                  : ((channel + 0.055) / 1.055) ** 2.4;
              });
            return r! * 0.2126 + g! * 0.7152 + b! * 0.0722;
          };
          const foreground = luminance(
            getComputedStyle(pre.querySelector("code > span")!).color,
          );
          const background = luminance(getComputedStyle(pre).backgroundColor);
          return (
            (Math.max(foreground, background) + 0.05) /
            (Math.min(foreground, background) + 0.05)
          );
        });
        expect(
          contrast,
          `${theme}/${scheme} comment contrast`,
        ).toBeGreaterThanOrEqual(4.5);
      }
      await page.evaluate(() => {
        document.documentElement.dataset.theme = "dark";
      });
      await android.scrollIntoViewIfNeeded();
      if (touch) await android.tap();
      else await android.hover();
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBeLessThanOrEqual(touch ? 375 : 1000);
      await recordUiCapture(page, `code-header-${touch ? "phone" : "desktop"}`);
    } finally {
      await context.close();
    }
  }
});
