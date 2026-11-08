import { join } from "node:path";
import type { Page } from "@playwright/test";
import { e2ePaths, expect, test } from "./fixtures.js";
import { recordUiCapture } from "./support/ui-capture.js";

// The dirty Quarto fixture has only short paths, so a fitted file list sits
// well inside the old fixed 380px default.
const projectPath = join(e2ePaths.tempDir, "source-control-qmd-project");
const projectId = Buffer.from(projectPath).toString("base64url");

test.use({ serviceWorkers: "block" });

async function dismissOnboardingIfVisible(page: Page) {
  const skip = page.getByRole("button", { name: "Skip all" });
  const appeared = await skip
    .waitFor({ state: "visible", timeout: 2_000 })
    .then(() => true)
    .catch(() => false);
  if (appeared) await skip.click({ force: true });
}

test("the uncommitted file list fits its rows instead of a fixed width", async ({
  page,
  baseURL,
}) => {
  await page.setViewportSize({ width: 1200, height: 600 });
  await page.goto(`${baseURL}/git-status?projectId=${projectId}`);
  await dismissOnboardingIfVisible(page);
  const column = page.locator(".working-tree-files-column");
  await expect(column.locator("[data-source-file-item]").first()).toBeVisible();

  const measureFit = async () =>
    column.evaluate((element) => {
      const range = document.createRange();
      const paths = [
        ...element.querySelectorAll<HTMLElement>(
          "[data-source-list-item] [data-source-path]",
        ),
      ];
      return {
        width: element.getBoundingClientRect().width,
        clipped: paths.filter((path) => {
          range.selectNodeContents(path);
          return range.getBoundingClientRect().width > path.clientWidth + 0.5;
        }).length,
        paths: paths.length,
      };
    });
  await expect.poll(async () => (await measureFit()).width).toBeLessThan(340);
  const fitted = await measureFit();
  expect(fitted.paths).toBeGreaterThan(0);
  expect(fitted.clipped).toBe(0);
  await recordUiCapture(page, "source-control-file-list-fit-1200");
});
