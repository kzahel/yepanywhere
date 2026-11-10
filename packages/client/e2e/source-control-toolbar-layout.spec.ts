import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { e2ePaths, expect, test } from "./fixtures.js";
import { recordUiCapture } from "./support/ui-capture.js";

const projectPath = join(e2ePaths.tempDir, "source-control-toolbar-project");
const fileName =
  "claude-gateway-process-start-and-output-collector-with-an-intentionally-long-layout-name-that-wraps-at-medium-width.ts";
const relativePath = `src/${fileName}`;
const filePath = join(projectPath, relativePath);
const projectId = Buffer.from(projectPath).toString("base64url");

test.use({ serviceWorkers: "block" });

// Global setup creates and registers the committed project before the server
// assembles its inventory. This idempotent write supplies the dirty projection.
test.beforeAll(({ workerServer }) => {
  void workerServer;
  writeFileSync(filePath, "export const toolbarLayoutFixture = true;\n");
});

async function dismissOnboardingIfVisible(page: Page) {
  const skip = page.getByRole("button", { name: "Skip all" });
  const appeared = await skip
    .waitFor({ state: "visible", timeout: 2_000 })
    .then(() => true)
    .catch(() => false);
  if (appeared) await skip.click({ force: true });
}

async function capture(page: Page, name: string) {
  await recordUiCapture(page, name);
}

async function narrowDetailPane(toolbar: Locator, splitter: Locator) {
  for (let step = 0; step < 30; step += 1) {
    const box = await toolbar.boundingBox();
    if (box && box.width < 500) return;
    await splitter.press("ArrowRight");
  }
  expect((await toolbar.boundingBox())?.width).toBeLessThan(500);
}

test("narrow diff panes keep wrapping identity and controls separate", async ({
  page,
  baseURL,
}) => {
  await page.setViewportSize({ width: 1200, height: 600 });
  await page.goto(
    `${baseURL}/git-status?projectId=${projectId}&worktreeFile=${encodeURIComponent(relativePath)}`,
  );
  await dismissOnboardingIfVisible(page);

  const toolbar = page.locator("[data-source-diff-toolbar]");
  const identity = toolbar.locator("[data-source-diff-identity]");
  const title = identity.locator("[data-source-preview-title]");
  const splitter = page
    .locator("[data-source-splitter=files] [data-source-splitter-edge=top]")
    .first();
  await expect(toolbar).toBeVisible();
  await expect(title).toHaveText(fileName);
  await expect(splitter).toBeVisible();
  await narrowDetailPane(toolbar, splitter);

  const identityBox = await identity.boundingBox();
  const controlBoxes = await toolbar
    .locator("[data-diff-context-buttons], [data-source-preview-actions]")
    .evaluateAll((groups) =>
      groups.map((group) => {
        const box = group.getBoundingClientRect();
        return {
          bottom: box.bottom,
          top: box.top,
          left: box.left,
          right: box.right,
        };
      }),
    );
  expect(identityBox).not.toBeNull();
  expect(controlBoxes.length).toBeGreaterThan(0);
  const toolbarBox = await toolbar.boundingBox();
  if (!identityBox || !toolbarBox) throw new Error("Missing viewer header");
  // The shared viewer header places identity first and greedily wraps actions.
  // Controls may sit beside it or below it, but never overlap or escape it.
  for (const box of controlBoxes) {
    expect(
      box.left >= identityBox.x + identityBox.width - 0.5 ||
        box.top >= identityBox.y + identityBox.height - 0.5,
    ).toBe(true);
    expect(box.left).toBeGreaterThanOrEqual(toolbarBox.x - 0.5);
    expect(box.right).toBeLessThanOrEqual(
      toolbarBox.x + toolbarBox.width + 0.5,
    );
  }
  await expect
    .poll(() =>
      title.evaluate((element) => ({
        height: element.getBoundingClientRect().height,
        overflowWrap: getComputedStyle(element).overflowWrap,
        whiteSpace: getComputedStyle(element).whiteSpace,
      })),
    )
    .toMatchObject({ overflowWrap: "anywhere", whiteSpace: "normal" });
  expect((await title.boundingBox())?.height).toBeGreaterThan(20);
  await capture(page, "source-control-toolbar-desktop-1200x600");

  await page.setViewportSize({ width: 375, height: 812 });
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByRole("dialog")).toContainText(fileName);
  await expect(
    page.getByRole("dialog").locator("[data-diff-line]").first(),
  ).toBeVisible();
  await capture(page, "source-control-toolbar-mobile-375x812");
});
