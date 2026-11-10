import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { e2ePaths, expect, test } from "./fixtures.js";
import { recordUiCapture } from "./support/ui-capture.js";

const mockProjectPath = join(e2ePaths.tempDir, "mockproject");
const projectId = Buffer.from(mockProjectPath).toString("base64url");
const fileBrowserProjectPath = join(e2ePaths.tempDir, "file-browser-project");
const fileBrowserProjectId = Buffer.from(fileBrowserProjectPath).toString(
  "base64url",
);
const sessionId = "file-viewer-absolute-001";

test.use({ draftSessionIds: [sessionId] });

async function dismissOnboardingIfVisible(page: Page) {
  const skip = page.getByRole("button", { name: "Skip all", exact: true });
  if (
    await skip
      .waitFor({ state: "visible", timeout: 750 })
      .then(() => true)
      .catch(() => false)
  ) {
    await skip.click();
  }
}

async function openRenderedMarkdown(page: Page) {
  await page.goto(`/projects/${projectId}/sessions/${sessionId}`);
  await dismissOnboardingIfVisible(page);
  const sourceLink = page.locator(
    'a[data-ya-private-project-file-link="true"]',
  );
  await expect(sourceLink).toBeVisible();
  await dismissOnboardingIfVisible(page);
  await page.waitForTimeout(750);
  await sourceLink.click();
  const preview = page.locator(".file-viewer-modal .markdown-preview");
  await expect(preview).toBeVisible();
  return preview;
}

async function textPoint(
  locator: Locator,
  horizontal: "start" | "middle" | "end",
) {
  return locator.evaluate((element, edge) => {
    const text = document
      .createTreeWalker(element, NodeFilter.SHOW_TEXT)
      .nextNode() as Text | null;
    if (!text) throw new Error("Expected rendered Markdown text");
    const range = document.createRange();
    const offset =
      edge === "start"
        ? 0
        : edge === "middle"
          ? Math.floor(text.data.length / 2)
          : text.data.length;
    range.setStart(text, offset);
    range.setEnd(text, offset);
    const rect = range.getBoundingClientRect();
    return { x: rect.left, y: rect.top + rect.height / 2 };
  }, horizontal);
}

async function quoteButtonForBlock(buttons: Locator, block: Locator) {
  const blockBox = await block.boundingBox();
  if (!blockBox) throw new Error("Expected rendered Markdown block");
  const blockBottom = blockBox.y + blockBox.height;
  let nearest: { distance: number; locator: Locator } | undefined;
  for (let index = 0; index < (await buttons.count()); index += 1) {
    const locator = buttons.nth(index);
    const box = await locator.boundingBox();
    if (!box) continue;
    const distance = Math.abs(box.y + box.height / 2 - blockBottom);
    if (!nearest || distance < nearest.distance) {
      nearest = { distance, locator };
    }
  }
  if (!nearest) throw new Error("Expected a visible paragraph quote button");
  return nearest.locator;
}

async function capture(page: Page, name: string) {
  await page.mouse.move(1, 1);
  await recordUiCapture(page, name);
}

for (const viewport of [
  { name: "wide", width: 1200, height: 600 },
  { name: "desktop", width: 1000, height: 600 },
  { name: "mobile", width: 375, height: 812 },
] as const) {
  test(`keeps rendered clicks native and quotes from circles at ${viewport.name} width`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    const preview = await openRenderedMarkdown(page);
    const viewerBody = page.locator(".file-viewer-modal .file-viewer-body");
    const paragraph = preview.getByText(
      "Viewer context remains available while reviewing this file.",
      { exact: true },
    );
    await paragraph.click();

    const composer = page.locator("[data-composer-input]");
    await expect(composer).toHaveValue("");
    await expect(viewerBody).toBeFocused();

    const keyboardScrollStart = await viewerBody.evaluate(
      (element) => element.scrollTop,
    );
    const keyboardScrollEnd = viewerBody.evaluate(
      (element) =>
        new Promise<void>((resolve) => {
          element.addEventListener("scrollend", () => resolve(), {
            once: true,
          });
        }),
    );
    await page.keyboard.press("PageDown");
    await keyboardScrollEnd;
    await expect
      .poll(() => viewerBody.evaluate((element) => element.scrollTop))
      .toBeGreaterThan(keyboardScrollStart);
    // Scroll back upward: PageDown may already have reached the bottom.
    const wheelScrollStart = await viewerBody.evaluate(
      (element) => element.scrollTop,
    );
    const viewerBox = await viewerBody.boundingBox();
    if (!viewerBox) throw new Error("Expected file viewer scroll owner");
    await page.mouse.move(
      viewerBox.x + viewerBox.width / 2,
      viewerBox.y + viewerBox.height / 2,
    );
    await page.mouse.wheel(0, -300);
    await expect
      .poll(() => viewerBody.evaluate((element) => element.scrollTop))
      .toBeLessThan(wheelScrollStart);
    await viewerBody.evaluate((element) => {
      element.scrollTop = 0;
    });

    await paragraph.hover();
    const quoteButtons = page.getByRole("button", {
      name: /Quote this paragraph/,
    });
    const quoteButton = await quoteButtonForBlock(quoteButtons, paragraph);
    await expect(quoteButton).toBeVisible();
    await quoteButton.click();
    await expect(composer).toHaveValue(
      `re: ${join(fileBrowserProjectPath, "README.md")}:5\n> Viewer context remains available while reviewing this file.\n`,
    );
    await expect(composer).toBeFocused();
    await expect(page.locator(".file-viewer-modal")).toBeVisible();

    const [modalBox, composerBox] = await Promise.all([
      page.locator(".file-viewer-modal").boundingBox(),
      page.locator(".session-input").boundingBox(),
    ]);
    if (!modalBox || !composerBox) {
      throw new Error("Expected viewer and composer layout boxes");
    }
    expect(Math.abs(modalBox.y + modalBox.height - composerBox.y)).toBeLessThan(
      1.1,
    );
    await capture(page, `${viewport.name}-markdown-quote`);
  });

  test(`opens an inline selection comment without consuming the composer at ${viewport.name} width`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await page.addInitScript(() => {
      localStorage.setItem(
        "yep-anywhere-selection-text-copy-action-enabled",
        "true",
      );
    });
    const sentMessages: string[] = [];
    await page.route("**/resume", async (route) => {
      const request = route.request().postDataJSON() as { message?: string };
      if (request.message) sentMessages.push(request.message);
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          processId: "file-comment-e2e",
          permissionMode: "default",
          modeVersion: 1,
          serverTimestamp: Date.now(),
        }),
      });
    });
    const preview = await openRenderedMarkdown(page);
    const composer = page.locator("[data-composer-input]");
    await composer.fill("Main composer draft stays put.");
    const viewer = page.locator(".file-viewer-modal");
    const commentToggle = viewer.getByRole("button", {
      name: "Comment",
      exact: true,
    });
    await expect(commentToggle).toHaveAttribute("aria-pressed", "false");
    await commentToggle.click();
    await expect(commentToggle).toHaveAttribute("aria-pressed", "true");

    const paragraph = preview.getByText(
      "Viewer context remains available while reviewing this file.",
      { exact: true },
    );
    await paragraph.evaluate((element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      const selection = document.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
    });

    const editor = viewer.getByPlaceholder("Comment or ask a question…");
    await expect(editor).toBeVisible();
    await expect(page.getByRole("button", { name: "Copy text" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Quote reply" })).toHaveCount(
      0,
    );
    await expect(
      viewer.getByRole("button", { name: /Quote this paragraph/ }),
    ).toHaveCount(0);
    await editor.focus();
    await expect(editor).toBeVisible();
    await editor.fill("Question on this passage?");
    await expect(editor).toBeVisible();
    await editor.press("Shift+Enter");
    await editor.pressSequentially("Please check it.");
    await expect(editor).toHaveValue(
      "Question on this passage?\nPlease check it.",
    );
    await capture(page, `${viewport.name}-markdown-comment`);

    await editor.press("Enter");
    await expect.poll(() => sentMessages.length).toBe(1);
    expect(sentMessages[0]).toContain("README.md:5");
    expect(sentMessages[0]).toContain(
      "> Viewer context remains available while reviewing this file.",
    );
    expect(sentMessages[0]).toContain(
      "Question on this passage?\nPlease check it.",
    );
    await expect(composer).toHaveValue("Main composer draft stays put.");
  });
}

test("opens the viewer toolbar link with a native middle click", async ({
  context,
  page,
}) => {
  await page.setViewportSize({ width: 1000, height: 600 });
  await openRenderedMarkdown(page);
  const openLink = page
    .locator(".file-viewer-modal")
    .getByRole("button", { name: "Copy viewer link" });
  await expect(openLink).toHaveAttribute("target", "_blank");

  const [openedPage] = await Promise.all([
    context.waitForEvent("page"),
    openLink.click({ button: "middle" }),
  ]);
  await expect(openedPage).toHaveURL(/\/file\?path=/);
  await openedPage.close();
  await expect(page.locator(".file-viewer-modal")).toBeVisible();
});

for (const viewport of [
  { name: "desktop", width: 1000, height: 600 },
  { name: "mobile", width: 375, height: 812 },
] as const) {
  test(`opens and dismisses the standalone viewer sidebar at ${viewport.name} width`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await page.goto(`/projects/${fileBrowserProjectId}/file?path=README.md`);
    await dismissOnboardingIfVisible(page);

    const viewer = page.locator("[data-file-page]");
    const sidebar = page.locator("[data-sidebar]");
    const opener = page.getByRole("button", { name: "Open sidebar" });
    await expect(viewer).toBeVisible();
    await expect(opener).toBeVisible();
    await expect(sidebar).toHaveCount(0);
    await capture(
      page,
      `${viewport.name}-standalone-file-sidebar-closed-${viewport.width}x${viewport.height}`,
    );

    await opener.click();

    await expect(sidebar).toBeVisible();
    await expect(viewer).toBeVisible();
    await capture(
      page,
      `${viewport.name}-standalone-file-sidebar-open-${viewport.width}x${viewport.height}`,
    );

    await sidebar.getByRole("button", { name: "Close sidebar" }).click();

    await expect(sidebar).toHaveCount(0);
    await expect(viewer).toBeVisible();
  });
}

test("keeps selection actions out of an upward pointer drag", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1000, height: 600 });
  const preview = await openRenderedMarkdown(page);
  const start = await textPoint(
    preview.getByRole("heading", { name: "Scroll clearance specimen" }),
    "end",
  );
  const end = await textPoint(
    preview.getByText(
      "Viewer context remains available while reviewing this file.",
      { exact: true },
    ),
    "start",
  );

  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 12 });
  await expect
    .poll(() => page.evaluate(() => document.getSelection()?.isCollapsed))
    .toBe(false);
  await expect(
    page.getByRole("button", { name: "Quote reply" }),
  ).not.toBeVisible();

  await page.mouse.up();
  await expect(page.getByRole("button", { name: "Quote reply" })).toBeVisible();
  await expect(page.locator("[data-composer-input]")).toHaveValue("");
});

test("starts a new selection when dragging inside selected viewer text", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1000, height: 600 });
  const preview = await openRenderedMarkdown(page);
  const paragraph = preview.getByText(
    "Viewer context remains available while reviewing this file.",
    { exact: true },
  );
  const heading = preview.getByRole("heading", {
    name: "Scroll clearance specimen",
  });
  await paragraph.evaluate((element) => {
    const selection = document.getSelection();
    const range = document.createRange();
    range.selectNodeContents(element);
    selection?.removeAllRanges();
    selection?.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
  });
  await expect(page.getByRole("button", { name: "Quote reply" })).toBeVisible();
  const start = await textPoint(paragraph, "middle");
  const end = await textPoint(heading, "end");
  await page.evaluate(() => {
    document.documentElement.dataset.selectionDragStarts = "0";
    document.documentElement.dataset.selectionPointerCancels = "0";
    document.addEventListener(
      "dragstart",
      () => {
        document.documentElement.dataset.selectionDragStarts = "1";
      },
      { once: true },
    );
    document.addEventListener(
      "pointercancel",
      () => {
        document.documentElement.dataset.selectionPointerCancels = "1";
      },
      { once: true },
    );
  });

  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 12 });
  await page.mouse.up();

  const outcome = await page.evaluate(() => ({
    dragStarts: Number(document.documentElement.dataset.selectionDragStarts),
    pointerCancels: Number(
      document.documentElement.dataset.selectionPointerCancels,
    ),
    selection: document.getSelection()?.toString() ?? "",
  }));
  expect(outcome.dragStarts).toBe(0);
  expect(outcome.pointerCancels).toBe(0);
  expect(outcome.selection).toContain("Scroll clearance specimen");
  expect(outcome.selection).not.toBe(
    "Viewer context remains available while reviewing this file.",
  );
});
