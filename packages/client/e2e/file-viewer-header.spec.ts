import { join } from "node:path";
import { e2ePaths, expect, test } from "./fixtures.js";
import { recordUiCapture } from "./support/ui-capture.js";

test.use({ draftSessionIds: ["file-viewer-absolute-001"] });

test("moves window controls without changing the filename row", async ({
  page,
  baseURL,
}) => {
  const projectId = Buffer.from(join(e2ePaths.tempDir, "mockproject")).toString(
    "base64url",
  );
  await page.setViewportSize({ width: 1200, height: 600 });
  await page.goto(
    `${baseURL}/projects/${projectId}/sessions/file-viewer-absolute-001`,
  );
  await page.locator('a[data-ya-private-project-file-link="true"]').click();
  const viewer = page.locator("[data-file-viewer]");
  const header = viewer.locator("[data-file-viewer-header]");
  const filename = viewer.locator("[data-file-viewer-path]");
  const close = viewer.getByRole("button", { name: "Close", exact: true });
  await expect(header).toHaveAttribute("data-window-actions-top", "true");
  const titleBefore = (await filename.boundingBox())!;
  const closeBefore = (await close.boundingBox())!;
  expect(Math.abs(closeBefore.y - titleBefore.y)).toBeLessThan(3);
  await page.mouse.move(1, 1);
  await recordUiCapture(page, "compact-header-desktop");

  let moved = false;
  const initialWidth = (await viewer.boundingBox())!.width;
  for (let width = initialWidth - 20; width >= 300; width -= 20) {
    await viewer.evaluate((element, size) => {
      element.style.width = `${size}px`;
    }, width);
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    if (!(await header.getAttribute("data-window-actions-top"))) {
      const titleAfter = (await filename.boundingBox())!;
      expect(titleAfter.height).toBe(titleBefore.height);
      expect(titleAfter.y).toBe(titleBefore.y);
      expect((await close.boundingBox())!.y).toBeGreaterThan(
        titleAfter.y + titleAfter.height,
      );
      moved = true;
      break;
    }
  }
  expect(moved).toBe(true);
  await viewer.evaluate((element) => {
    element.style.removeProperty("width");
  });
  await expect(header).toHaveAttribute("data-window-actions-top", "true");

  const zoom = viewer.getByRole("group", { name: "Source zoom" });
  await expect(zoom).toHaveText("−aA+");
  const body = viewer
    .locator("[data-markdown-preview] [data-markdown-rendered]")
    .first();
  const originalSize = await body.evaluate(
    (element) => getComputedStyle(element).fontSize,
  );
  await zoom
    .getByRole("button", { name: "Zoom source and preview in", exact: true })
    .click();
  await expect
    .poll(() => body.evaluate((element) => getComputedStyle(element).fontSize))
    .not.toBe(originalSize);
  await zoom
    .getByRole("button", { name: "Zoom source and preview out", exact: true })
    .click();
  await expect
    .poll(() => body.evaluate((element) => getComputedStyle(element).fontSize))
    .toBe(originalSize);

  await page.keyboard.press("Control+f");
  const find = viewer.getByRole("searchbox", { name: "Find in this view" });
  let typed = "";
  for (const character of "Test Project") {
    typed += character;
    await find.press(character === " " ? "Space" : character);
    await expect(find).toHaveValue(typed, { timeout: 100 });
  }
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 375, height: 812 });
  await expect(header).not.toHaveAttribute("data-window-actions-top", "true");
  await expect(filename).toHaveText(
    join(e2ePaths.tempDir, "file-browser-project", "README.md"),
  );
  expect(
    await viewer.evaluate(
      (element) => element.scrollWidth <= element.clientWidth,
    ),
  ).toBe(true);
  await page.mouse.move(1, 1);
  await recordUiCapture(page, "compact-header-phone");
});
