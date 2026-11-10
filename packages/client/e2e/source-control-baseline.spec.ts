import { join } from "node:path";
import {
  e2ePaths,
  expect,
  setLiveWorktreeMonitoring,
  test,
} from "./fixtures.js";
import { recordUiCapture } from "./support/ui-capture.js";

const projectPath = join(e2ePaths.tempDir, "source-control-project");
const projectId = Buffer.from(projectPath).toString("base64url");
test.use({ serviceWorkers: "block" });
test.afterEach(async ({ baseURL }) => {
  await setLiveWorktreeMonitoring(baseURL, false);
});

for (const width of [1200, 375]) {
  test(`static working-tree inventory keeps sequential filtering responsive through late metadata at ${width}px`, async ({
    page,
    baseURL,
  }) => {
    await setLiveWorktreeMonitoring(baseURL, false);
    let releaseVersion = () => {};
    const versionReady = new Promise<void>((resolve) => {
      releaseVersion = resolve;
    });
    await page.route("**/api/version*", async (route) => {
      const response = await route.fetch();
      await versionReady;
      await route.fulfill({ response });
    });
    const files = Array.from({ length: 650 }, (_, index) => ({
      path: `retirement-fixture/item-${index.toString().padStart(3, "0")}.ts`,
      tracked: false,
      kind: "untracked",
    }));
    await page.route("**/git/working-tree-files*", async (route) => {
      const response = await route.fetch();
      const inventory = await response.json();
      await route.fulfill({
        response,
        json: { ...inventory, files: [...inventory.files, ...files] },
      });
    });
    let contentReads = 0;
    let releaseContent: () => void = () => {};
    const contentReady = new Promise<void>((resolve) => {
      releaseContent = resolve;
    });
    await page.route("**/api/projects/*/files?*", async (route) => {
      const path =
        new URL(route.request().url()).searchParams.get("path") ?? "";
      if (!path.startsWith("retirement-fixture/")) return route.continue();
      contentReads++;
      await contentReady;
      await route.fulfill({
        json: {
          metadata: { path, size: 20, mimeType: "text/plain", isText: true },
          content: "current file contents",
          rawUrl: "/raw/fixture",
        },
      });
    });
    try {
      const inventory = page.waitForResponse((response) =>
        response.url().includes("/git/working-tree-files"),
      );
      await page.setViewportSize({ width, height: width === 375 ? 812 : 600 });
      await page.goto(`${baseURL}/git-status?projectId=${projectId}&tab=files`);
      expect((await inventory).ok()).toBe(true);
      const filter = page.getByRole("searchbox").last();
      await expect(filter).toBeVisible();
      await filter.evaluate((element) => {
        const input = element as HTMLInputElement;
        (window as unknown as { sourceTyping: number[] }).sourceTyping = [];
        input.addEventListener("keydown", () => {
          const start = performance.now();
          input.addEventListener(
            "input",
            () =>
              requestAnimationFrame(() => {
                (
                  window as unknown as { sourceTyping: number[] }
                ).sourceTyping.push(performance.now() - start);
              }),
            { once: true },
          );
        });
      });
      let typed = "";
      for (const character of "item-649") {
        typed += character;
        // Release the selected-file read during typing so detail rendering overlaps it.
        if (typed.length === 4) {
          releaseContent();
          releaseVersion();
        }
        await filter.pressSequentially(character);
        await expect(filter).toHaveValue(typed, { timeout: 100 });
        if (width === 1200 && typed.length === 1) {
          await expect.poll(() => contentReads).toBeGreaterThan(0);
        }
      }
      await expect(page.locator("[data-source-blame-item]")).toHaveCount(1);
      await expect(
        page.locator('[data-source-path="retirement-fixture/item-649.ts"]'),
      ).toBeVisible();
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              (window as unknown as { sourceTyping: number[] }).sourceTyping
                .length,
          ),
        )
        .toBe(8);
      const samples = await page.evaluate(
        () => (window as unknown as { sourceTyping: number[] }).sourceTyping,
      );
      expect(
        Math.max(...samples),
        JSON.stringify({ width, samples }),
      ).toBeLessThanOrEqual(100);
      if (width === 1200) {
        await expect(
          page.getByText("current file contents", { exact: true }),
        ).toBeVisible();
        await page.setViewportSize({ width: 1000, height: 600 });
        if (await page.getByRole("dialog").isVisible())
          await page.keyboard.press("Escape");
      }
      await recordUiCapture(
        page,
        width === 375 ? "files-phone" : "files-desktop",
      );
    } finally {
      releaseVersion();
      releaseContent();
    }
  });
}
