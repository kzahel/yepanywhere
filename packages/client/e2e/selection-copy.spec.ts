import { expect, test } from "@playwright/test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createTestViteServer } from "./support/vite-server";
import { recordUiCapture, presentUiCaptures } from "./support/ui-capture";
import { toUrlProjectId } from "@yep-anywhere/shared";

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
for (const mobile of [false, true]) {
  test(`visible native copy and explicit Markdown ${mobile ? "touch" : "mouse"}`, async ({
    browser,
  }) => {
    const context = await browser.newContext({
      viewport: { width: mobile ? 375 : 1200, height: mobile ? 812 : 600 },
      isMobile: mobile,
      hasTouch: mobile,
      permissions: ["clipboard-read", "clipboard-write"],
    });
    const page = await context.newPage();
    const errors: string[] = [];
    const appProject = toUrlProjectId("/work/project");
    let metadataReads = 0;
    let starts = 0;
    let createdShares = 0;
    let releaseStart: () => void = () => {};
    const startGate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    await page.route("**/api/projects/*/app", async (route) => {
      metadataReads++;
      const serves = route
        .request()
        .url()
        .includes(encodeURIComponent(appProject));
      await route.fulfill({
        json: {
          projectId: appProject,
          state: "stopped",
          canStart: true,
          canExecute: true,
          declaration: serves ? { where: { kind: "process" } } : null,
          ...(serves
            ? {
                fileLinks: {
                  pathTemplate: "/{path}",
                  baseUrl: "https://project.example/",
                },
              }
            : {}),
        },
      });
    });
    await page.route("**/api/projects/*/app/start", async (route) => {
      starts++;
      await startGate;
      await route.fulfill({ json: { started: true } });
    });
    await page.route("**/api/settings", (route) =>
      route.fulfill({ json: { settings: { limitedUsersEnabled: false } } }),
    );
    await page.route("**/api/public-file-shares?*", (route) =>
      route.fulfill({ json: { items: [] } }),
    );
    await page.route("**/api/public-file-shares", async (route) => {
      createdShares++;
      expect(route.request().postDataJSON()).toEqual({
        projectId: toUrlProjectId("/work/other"),
        path: "private.md",
      });
      await route.fulfill({
        json: { url: "https://ya.example/share/file-secret" },
      });
    });
    page.on("pageerror", (error) => errors.push(error.message));
    try {
      await page.goto(`${base}e2e/fixtures/selection-copy.html`);
      await expect(page.getByText("Earlier response 249.")).toHaveCount(1);
      await page
        .locator('[data-testid="copy-source"] blockquote')
        .evaluate((element) => {
          const range = document.createRange();
          range.selectNodeContents(element);
          const selection = document.getSelection()!;
          selection.removeAllRanges();
          selection.addRange(range);
          document.dispatchEvent(new Event("selectionchange"));
        });
      const copy = page.getByRole("button", {
        name: "Copy Markdown",
        exact: true,
      });
      await expect(copy).toBeVisible();
      await page.keyboard.press("ControlOrMeta+c");
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
        "Continue the Android preview in /Users/project.\n\nKeep test data disposable.",
      );
      if (mobile) {
        const quote = page.getByRole("button", {
          name: "Quote reply",
          exact: true,
        });
        const copyBox = (await copy.boundingBox())!;
        const quoteBox = (await quote.boundingBox())!;
        expect(copyBox.width).toBeGreaterThanOrEqual(44);
        expect(copyBox.height).toBeGreaterThanOrEqual(44);
        expect(copyBox.y + copyBox.height).toBeLessThanOrEqual(quoteBox.y);
      }
      await recordUiCapture(
        page,
        `selection-copy-${mobile ? "phone" : "desktop"}`,
      );
      // The stored selection must survive native highlight loss during a press.
      await copy.evaluate((button) =>
        button.addEventListener(
          "pointerdown",
          () => document.getSelection()?.removeAllRanges(),
          { once: true },
        ),
      );
      if (mobile) await copy.tap();
      else await copy.click();
      await expect
        .poll(() => page.evaluate(() => navigator.clipboard.readText()))
        .toBe(
          "> Continue the **Android preview** in `/Users/project`.\n>\n> Keep test data disposable.",
        );
      for (const [testId, word] of [
        ["plain-selection", "assistant"],
        ["user-selection", "command"],
        ["raw-selection", "source"],
      ]) {
        await page.getByTestId(testId!).evaluate((element, selectedWord) => {
          const walker = document.createTreeWalker(
            element,
            NodeFilter.SHOW_TEXT,
          );
          for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            const text = node as Text;
            const start = text.data.indexOf(selectedWord!);
            if (start < 0) continue;
            const range = document.createRange();
            range.setStart(text, start);
            range.setEnd(text, start + selectedWord!.length);
            const selection = document.getSelection()!;
            selection.removeAllRanges();
            selection.addRange(range);
            document.dispatchEvent(new Event("selectionchange"));
            return;
          }
          throw new Error("Selected word not found");
        }, word);
        await expect(copy).not.toBeVisible();
        await expect(
          page.getByRole("button", { name: "Quote reply", exact: true }),
        ).toBeVisible();
        await page.keyboard.press("ControlOrMeta+c");
        expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
          word,
        );
      }
      await page.getByTestId("public-copy-source").evaluate((element) => {
        const range = document.createRange();
        range.selectNodeContents(element);
        document.getSelection()!.removeAllRanges();
        document.getSelection()!.addRange(range);
        document.dispatchEvent(new Event("selectionchange"));
      });
      await expect(copy).toBeVisible();
      await expect.poll(() => metadataReads).toBe(2);
      expect(starts).toBe(0);
      if (mobile) {
        const box = (await copy.boundingBox())!;
        const cdp = await context.newCDPSession(page);
        await cdp.send("Input.dispatchTouchEvent", {
          type: "touchStart",
          touchPoints: [
            { x: box.x + box.width / 2, y: box.y + box.height / 2 },
          ],
        });
        await page.waitForTimeout(600);
        await cdp.send("Input.dispatchTouchEvent", {
          type: "touchEnd",
          touchPoints: [],
        });
        await cdp.detach();
      } else await copy.click({ button: "right" });
      await page
        .getByRole("menuitem", { name: "Copy Markdown with public links" })
        .click();
      const partial =
        "Read [the report](<https://project.example/docs/report.md#L12>) and `~/other/private.md`.";
      await expect
        .poll(() => page.evaluate(() => navigator.clipboard.readText()))
        .toBe(partial);
      await expect.poll(() => starts).toBe(1);
      expect(createdShares).toBe(0);
      await expect(page.getByRole("alert")).toContainText(
        "local paths remaining: 1",
      );
      // Capture disables animations, which otherwise completes the toast fade.
      if (process.env.YEP_E2E_UI_CAPTURE_DIR)
        await page.getByRole("alert").evaluate((element) => {
          element.style.animation = "none";
        });
      await recordUiCapture(
        page,
        `public-copy-${mobile ? "phone" : "desktop"}`,
      );
      await page
        .getByRole("alert")
        .getByText(/Copied;/)
        .click();
      await expect(page.getByRole("alert")).toHaveCount(0);
      expect(createdShares).toBe(0);
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
        partial,
      );
      // Reopen through the keyboard gesture; startup remains pending throughout.
      await page.getByTestId("public-copy-source").evaluate((element) => {
        const range = document.createRange();
        range.selectNodeContents(element);
        document.getSelection()!.removeAllRanges();
        document.getSelection()!.addRange(range);
        document.dispatchEvent(new Event("selectionchange"));
      });
      await expect(copy).toBeVisible();
      await copy.focus();
      await copy.press("Shift+F10");
      await page
        .getByRole("menuitem", { name: "Copy Markdown with public links" })
        .click();
      await page
        .getByRole("button", { name: "Create public file links…" })
        .click();
      await expect(page.getByRole("dialog")).toContainText(
        "/work/other/private.md",
      );
      await recordUiCapture(
        page,
        `public-copy-share-${mobile ? "phone" : "desktop"}`,
      );
      expect(createdShares).toBe(0);
      await page
        .getByRole("button", { name: "Create links and copy Markdown" })
        .click();
      await expect
        .poll(() => page.evaluate(() => navigator.clipboard.readText()))
        .toBe(
          "Read [the report](<https://project.example/docs/report.md#L12>) and [`~/other/private.md`](<https://ya.example/share/file-secret>).",
        );
      expect(createdShares).toBe(1);
      releaseStart();
      const input = page.getByRole("textbox", { name: "Message" });
      // Time each keystroke in the page, from keydown to the frame after its
      // input. Timing the test's own round trips counted CI scheduling: run
      // 37270062285 failed this touch case at 101ms and then 146ms.
      await input.evaluate((element) => {
        const samples: number[] = [];
        let keyAt = 0;
        element.addEventListener("keydown", () => {
          keyAt = performance.now();
        });
        element.addEventListener("input", () => {
          const pressed = keyAt;
          requestAnimationFrame(() =>
            samples.push(performance.now() - pressed),
          );
        });
        Object.assign(window, { keystrokeSamples: samples });
      });
      await input.focus();
      const message = "Continue the preview.";
      let expected = "";
      for (const character of message) {
        expected += character;
        await page.keyboard.type(character);
        expect(await input.inputValue()).toBe(expected);
      }
      const samples = await page.evaluate(async () => {
        await new Promise(requestAnimationFrame);
        return (window as unknown as { keystrokeSamples: number[] })
          .keystrokeSamples;
      });
      expect(samples).toHaveLength(message.length);
      expect(Math.max(...samples)).toBeLessThan(100);
      expect(errors).toEqual([]);
    } finally {
      releaseStart();
      await context.close();
    }
  });
}
