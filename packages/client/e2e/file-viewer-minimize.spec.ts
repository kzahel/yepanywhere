import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { e2ePaths, expect, test } from "./fixtures.js";
import { recordUiCapture } from "./support/ui-capture.js";

const mockProjectPath = join(e2ePaths.tempDir, "mockproject");
const projectId = Buffer.from(mockProjectPath).toString("base64url");
const sessionId = "file-viewer-absolute-001";

test.use({ draftSessionIds: [sessionId] });
const externalReadmePath = join(
  e2ePaths.tempDir,
  "file-browser-project",
  "README.md",
);

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

async function capture(page: Page, name: string) {
  const artifactDir = process.env.YEP_UI_CAPTURE_DIR;
  if (!artifactDir) return;
  mkdirSync(artifactDir, { recursive: true });
  await page.mouse.move(1, 1);
  await page.waitForTimeout(300);
  await page.screenshot({
    animations: "disabled",
    path: join(artifactDir, `${name}.png`),
  });
}

test("recalls the last file after Close and reload only where the margin fits", async ({
  page,
  baseURL,
}) => {
  test.setTimeout(30000);
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.goto(`${baseURL}/projects/${projectId}/sessions/${sessionId}`);
  await dismissOnboardingIfVisible(page);
  await page.locator('a[data-ya-private-project-file-link="true"]').click();
  const viewer = page.locator("[data-file-viewer]");
  await expect(viewer).toBeVisible();
  await viewer.getByRole("button", { name: "Close", exact: true }).click();
  const reopen = page.getByRole("button", { name: /Restore file viewer:/ });
  await expect(reopen).toBeVisible();
  const sessionUrl = page.url();
  await page.reload();
  await expect(viewer).toBeHidden();
  await expect(reopen).toBeVisible();
  await page.mouse.move(1, 1);
  await recordUiCapture(page, "last-file-desktop-1600");
  await reopen.hover();
  await expect(page.getByRole("tooltip")).toContainText(externalReadmePath);
  await recordUiCapture(page, "last-file-hover-1600");
  await reopen.click();
  await expect(viewer.getByText("Test Project", { exact: true })).toBeVisible();
  expect(page.url()).toBe(sessionUrl);
  await viewer
    .getByRole("button", { name: "Minimize file viewer", exact: true })
    .click();
  await expect(reopen).toHaveCount(1); // Existing toolbar restore, without a second margin action.
  await page.getByRole("button", { name: /Close file viewer:/ }).click();
  await expect(reopen).toBeVisible();
  await page.mouse.move(1, 1);
  await page.setViewportSize({ width: 1200, height: 600 });
  await expect(reopen).toBeHidden();
  await recordUiCapture(page, "last-file-desktop-1200");
  // Below the desktop-sidebar breakpoint, its released width leaves a margin.
  await page.setViewportSize({ width: 1000, height: 600 });
  await expect(reopen).toBeVisible();
  await recordUiCapture(page, "last-file-desktop-1000");
  await page.setViewportSize({ width: 375, height: 812 });
  await expect(reopen).toBeHidden();
  await recordUiCapture(page, "last-file-phone-375");
  await page.setViewportSize({ width: 1600, height: 900 });
  await expect(reopen).toBeVisible();
  const composer = page.locator("[data-composer-input]");
  const transcriptFile = join(
    e2ePaths.claudeSessionsDir,
    hostname(),
    mockProjectPath.replace(/\//g, "-"),
    `${sessionId}.jsonl`,
  );
  const originalTranscript = readFileSync(transcriptFile, "utf8");
  const assistantRow = (index: number) =>
    JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        content: `Concurrent transcript update ${index}`,
      },
      timestamp: new Date().toISOString(),
      uuid: `recall-update-${index}`,
      parentUuid:
        index === 0 ? "viewer-assistant-1" : `recall-update-${index - 1}`,
    });
  try {
    appendFileSync(
      transcriptFile,
      `\n${Array.from({ length: 100 }, (_, index) => assistantRow(index)).join("\n")}\n`,
    );
    let typed = "";
    let update = 100;
    for (const character of "last file recalled") {
      appendFileSync(transcriptFile, `${assistantRow(update++)}\n`);
      typed += character;
      await composer.press(character === " " ? "Space" : character);
      await expect(composer).toHaveValue(typed, { timeout: 100 });
    }
    await expect(
      page.getByText(`Concurrent transcript update ${update - 1}`, {
        exact: true,
      }),
    ).toBeVisible();
  } finally {
    writeFileSync(transcriptFile, originalTranscript);
  }
});

test("keeps the viewer open while transcript rich text settles", async ({
  page,
  baseURL,
}) => {
  await page.setViewportSize({ width: 1000, height: 600 });
  await page.goto(`${baseURL}/projects/${projectId}/sessions/${sessionId}`);
  await dismissOnboardingIfVisible(page);

  const absoluteLink = page.locator(
    'a[data-ya-private-project-file-link="true"]',
  );
  await expect(absoluteLink).toBeVisible({ timeout: 10000 });
  await absoluteLink.click();

  const viewer = page.locator("[data-file-viewer]");
  await expect(viewer).toBeVisible();
  await page.waitForTimeout(750);
  await expect(viewer).toBeVisible();
  await capture(page, "desktop-1000-rich-text-replacement");
});

test("keeps the viewer open and responsive across session width changes", async ({
  page,
  baseURL,
}) => {
  test.setTimeout(30000);
  const originalReadme = readFileSync(externalReadmePath, "utf8");
  writeFileSync(
    externalReadmePath,
    [
      "# Large viewer resize specimen",
      "",
      ...Array.from(
        { length: 3000 },
        (_, index) =>
          `Paragraph ${index + 1} keeps enough wrapping text in the expanded viewer to exercise responsive layout.`,
      ),
    ].join("\n\n"),
  );

  try {
    await page.setViewportSize({ width: 1000, height: 600 });
    await page.goto(`${baseURL}/projects/${projectId}/sessions/${sessionId}`);
    await dismissOnboardingIfVisible(page);

    const absoluteLink = page.locator(
      'a[data-ya-private-project-file-link="true"]',
    );
    await expect(absoluteLink).toBeVisible({ timeout: 10000 });
    await page.waitForTimeout(750);
    await absoluteLink.click();

    const viewer = page.locator("[data-file-viewer]");
    const viewerBody = viewer.locator("[data-file-viewer-body]");
    const quoteButtons = viewer.locator("[data-text-block-quote-paragraph]");
    const lastParagraph = viewer.getByText(
      "Paragraph 3000 keeps enough wrapping text in the expanded viewer to exercise responsive layout.",
      { exact: true },
    );
    await expect(viewer).toBeVisible();
    await expect(
      viewer.getByText("Large viewer resize specimen", { exact: true }),
    ).toBeVisible();
    await expect(lastParagraph).toBeAttached();
    await expect.poll(() => quoteButtons.count()).toBeGreaterThan(0);
    expect(await quoteButtons.count()).toBeLessThan(100);

    const widerWidths = Array.from(
      { length: 21 },
      (_, index) => 1000 + index * 10,
    );
    const narrowerWidths = widerWidths.slice(0, -1).reverse();
    for (const width of [...widerWidths.slice(1), ...narrowerWidths]) {
      const startedAt = performance.now();
      await page.setViewportSize({ width, height: 600 });
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            window.requestAnimationFrame(() => resolve()),
          ),
      );
      expect(performance.now() - startedAt).toBeLessThan(3000);
    }

    await expect(viewer).toBeVisible();
    await expect.poll(() => quoteButtons.count()).toBeGreaterThan(0);
    expect(await quoteButtons.count()).toBeLessThan(100);

    await viewerBody.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await expect(lastParagraph).toBeVisible();
    await expect.poll(() => quoteButtons.count()).toBeGreaterThan(0);
    expect(await quoteButtons.count()).toBeLessThan(100);
    await lastParagraph.hover();
    await expect(quoteButtons.last()).toBeVisible();
    await quoteButtons.last().click();
    await expect(page.locator("[data-composer-input]")).toHaveValue(
      `re: ${externalReadmePath}:6003\n> Paragraph 3000 keeps enough wrapping text in the expanded viewer to exercise responsive layout.\n`,
    );
    await expect(viewer).toBeVisible();
    await capture(page, "desktop-1000-large-resize");
  } finally {
    writeFileSync(externalReadmePath, originalReadme);
  }
});

test("finds within the file viewer after a click in its content", async ({
  page,
  baseURL,
}) => {
  const originalReadme = readFileSync(externalReadmePath, "utf8");
  writeFileSync(
    externalReadmePath,
    "# Find specimen\n\nalpha needle\n\nbeta needle\n\ngamma needle\n",
  );
  try {
    await page.setViewportSize({ width: 1200, height: 600 });
    await page.goto(`${baseURL}/projects/${projectId}/sessions/${sessionId}`);
    await dismissOnboardingIfVisible(page);
    const absoluteLink = page.locator(
      'a[data-ya-private-project-file-link="true"]',
    );
    await expect(absoluteLink).toBeVisible({ timeout: 10000 });
    await absoluteLink.click();
    const viewer = page.locator("[data-file-viewer]");
    await expect(viewer.getByText("beta needle")).toBeVisible();
    await recordUiCapture(page, "file-viewer-find-idle-1200");
    const findBox = page.getByRole("searchbox", { name: "Find in this view" });
    // The dedicated action row has room for the idle field at this width.
    await expect(findBox).toBeVisible();
    await viewer.getByText("beta needle").click();
    await page.keyboard.press("Control+f");
    await expect(findBox).toBeFocused();
    // Every keystroke lands in the field promptly while matches repaint.
    let typed = "";
    for (const character of "needle") {
      typed += character;
      await findBox.press(character);
      await expect(findBox).toHaveValue(typed, { timeout: 100 });
    }
    await expect(page.getByRole("search").getByText("1/3")).toBeVisible();
    await findBox.press("Enter");
    await expect(page.getByRole("search").getByText("2/3")).toBeVisible();
    // The transcript's own "needle" text, if any, is outside this search.
    expect(
      await page.evaluate(() => {
        const highlight = CSS.highlights.get("yep-find-current");
        const range = highlight ? [...highlight][0] : undefined;
        return range?.startContainer.parentElement?.closest(
          "[data-file-viewer]",
        )
          ? range.toString()
          : null;
      }),
    ).toBe("needle");
    await recordUiCapture(page, "file-viewer-find-1200");
    await findBox.press("Escape");
    // Dismissal clears the query and returns focus to the document. The idle
    // field remains visible while its action row has room.
    await expect(findBox).toBeVisible();
    await expect(findBox).toHaveValue("");
    await expect(viewer.locator("[data-file-viewer-body]")).toBeFocused();
  } finally {
    writeFileSync(externalReadmePath, originalReadme);
  }
});

// A cell too wide for the viewer makes the preview scroll sideways only.
const wideTableSpecimen = `# Reload specimen\n\n${Array.from(
  { length: 150 },
  (_, i) => `Filler ${i}.`,
).join(
  "\n\n",
)}\n\n| Arm | Note |\n|---|---|\n| deep needle | ${"x".repeat(600)} |\n`;

test("in the right pane, finds past a wide table and keeps its place on reload", async ({
  page,
  baseURL,
}) => {
  const originalReadme = readFileSync(externalReadmePath, "utf8");
  writeFileSync(externalReadmePath, wideTableSpecimen);
  try {
    await page.setViewportSize({ width: 1600, height: 900 });
    await page.goto(`${baseURL}/settings/appearance`);
    const setting = page.getByRole("switch", {
      name: "Session right pane",
      exact: true,
    });
    await setting.locator("..").click();
    await expect(setting).toBeChecked();
    await page.goto(`${baseURL}/projects/${projectId}/sessions/${sessionId}`);
    await dismissOnboardingIfVisible(page);
    await page.locator('a[data-ya-private-project-file-link="true"]').click();
    const pane = page.getByRole("complementary", { name: "Session pane" });
    const body = pane.locator("[data-file-viewer-body]");
    await pane.getByText("Filler 0.", { exact: true }).click();
    await page.keyboard.press("Control+f");
    await page
      .getByRole("searchbox", { name: "Find in this view" })
      .fill("deep needle");
    await expect(page.getByRole("search").getByText("1/1")).toBeVisible();
    await expect(
      pane.getByRole("cell", { name: "deep needle" }),
    ).toBeInViewport();
    // Measure without the find field, which a reload does not bring back.
    await page.keyboard.press("Escape");
    const scrolled = await body.evaluate((element) => element.scrollTop);
    expect(scrolled).toBeGreaterThan(1000);

    await page.reload();
    await expect(pane.getByText("Reload specimen")).toBeAttached();
    await expect
      .poll(() => body.evaluate((element) => element.scrollTop))
      .toBeGreaterThan(scrolled - 4);
    await expect(
      pane.getByRole("cell", { name: "deep needle" }),
    ).toBeInViewport();
  } finally {
    writeFileSync(externalReadmePath, originalReadme);
  }
});

test("finds past a wide table, and a reload keeps the viewer where it was", async ({
  page,
  baseURL,
}) => {
  const originalReadme = readFileSync(externalReadmePath, "utf8");
  writeFileSync(externalReadmePath, wideTableSpecimen);
  try {
    await page.setViewportSize({ width: 1200, height: 600 });
    await page.goto(`${baseURL}/projects/${projectId}/sessions/${sessionId}`);
    await dismissOnboardingIfVisible(page);
    await page.locator('a[data-ya-private-project-file-link="true"]').click();
    const viewer = page.locator("[data-file-viewer]");
    const body = viewer.locator("[data-file-viewer-body]");
    await viewer.getByText("Filler 0.", { exact: true }).click();
    await page.keyboard.press("Control+f");
    await page
      .getByRole("searchbox", { name: "Find in this view" })
      .fill("deep needle");
    await expect(page.getByRole("search").getByText("1/1")).toBeVisible();
    // The match is revealed inside the body, not merely counted.
    await expect(
      viewer.getByRole("cell", { name: "deep needle" }),
    ).toBeInViewport();
    await page.keyboard.press("Escape");
    const scrolled = await body.evaluate((element) => element.scrollTop);
    expect(scrolled).toBeGreaterThan(1000);

    await page.reload();
    await expect(viewer.getByText("Reload specimen")).toBeAttached();
    await expect
      .poll(() => body.evaluate((element) => element.scrollTop))
      .toBeGreaterThan(scrolled - 4);
    await expect(
      viewer.getByRole("cell", { name: "deep needle" }),
    ).toBeInViewport();

    // Minimized stays minimized; Close means a reload opens nothing.
    await viewer
      .getByRole("button", { name: "Minimize file viewer", exact: true })
      .click();
    await page.reload();
    const parked = page.getByRole("button", { name: /Close file viewer:/ });
    await expect(parked).toBeVisible();
    await expect(viewer).toBeHidden();
    await parked.click();
    await page.reload();
    await expect(
      page.locator('a[data-ya-private-project-file-link="true"]'),
    ).toBeVisible();
    expect(
      await page.evaluate(() =>
        Object.keys(sessionStorage).filter((key) =>
          key.startsWith("yep-anywhere-session-open-file:"),
        ),
      ),
    ).toEqual([]);
    await expect(viewer).toBeHidden();
  } finally {
    writeFileSync(externalReadmePath, originalReadme);
  }
});

for (const viewport of [
  { name: "desktop", width: 1920, height: 1080 },
  { name: "desktop-1024", width: 1024, height: 768 },
  { name: "tablet-800", width: 800, height: 900 },
  { name: "mobile", width: 375, height: 812 },
] as const) {
  test(`minimizes and restores an external file viewer at ${viewport.name} width`, async ({
    page,
    baseURL,
  }) => {
    const glossaryRequests: URL[] = [];
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (url.pathname.endsWith("/glossary-artifact")) {
        glossaryRequests.push(url);
      }
    });

    await page.setViewportSize(viewport);
    await page.addInitScript(() => {
      localStorage.setItem("yep-anywhere-glossary-hints-enabled", "true");
    });
    await page.goto(`${baseURL}/projects/${projectId}/sessions/${sessionId}`);
    await dismissOnboardingIfVisible(page);

    const absoluteLink = page.locator(
      'a[data-ya-private-project-file-link="true"]',
    );
    await expect(absoluteLink).toBeVisible({ timeout: 10000 });
    await dismissOnboardingIfVisible(page);
    // Let the initial transcript's rich-text replacement settle so this loop
    // isolates viewer presentation; the preceding regression covers
    // replacement while the viewer is already open.
    await page.waitForTimeout(750);
    await absoluteLink.click();

    const viewer = page.locator("[data-file-viewer]");
    await expect(viewer).toBeVisible();
    // The header never trades the filename away for controls: they take their
    // own header row instead of squeezing the path into a one-glyph column.
    const [pathBox, actionsBox] = await Promise.all([
      viewer.locator("[data-file-viewer-path]").boundingBox(),
      viewer.locator("[data-file-viewer-actions]").boundingBox(),
    ]);
    if (!pathBox || !actionsBox) {
      throw new Error("Expected file viewer header layout boxes");
    }
    expect(pathBox.width).toBeGreaterThanOrEqual(140);
    expect(
      actionsBox.x >= pathBox.x + pathBox.width - 1 ||
        actionsBox.y >= pathBox.y + pathBox.height - 1,
    ).toBe(true);
    if (viewport.width <= 800) {
      const [modalBox, composerBox] = await Promise.all([
        page.locator("[data-file-viewer-modal]").boundingBox(),
        page.locator("[data-session-input]").boundingBox(),
      ]);
      expect(modalBox?.x).toBe(0);
      expect(modalBox?.width).toBe(viewport.width);
      if (!modalBox || !composerBox) {
        throw new Error("Expected viewer and composer layout boxes");
      }
      expect(
        Math.abs(modalBox.y + modalBox.height - composerBox.y),
      ).toBeLessThan(1.1);
    }
    await expect(
      viewer.getByText("Test Project", { exact: true }),
    ).toBeVisible();
    await expect(
      viewer.locator('[data-glossary-term="true"]', {
        hasText: "Viewer context",
      }),
    ).toBeVisible();
    await expect.poll(() => glossaryRequests.length).toBeGreaterThan(0);
    expect(glossaryRequests.at(-1)?.searchParams.has("sourcePath")).toBe(false);

    const controller = page.getByRole("group", { name: /File viewer:/ });
    await expect(controller).toBeVisible();
    await expect(controller).toContainText("README.md");
    const [leftControlsBox, controllerBox] = await Promise.all([
      page.locator("[data-message-input-left]").boundingBox(),
      controller.boundingBox(),
    ]);
    if (!leftControlsBox || !controllerBox) {
      throw new Error("Expected toolbar controls to have layout boxes");
    }
    expect(controllerBox.x).toBeGreaterThanOrEqual(
      leftControlsBox.x + leftControlsBox.width,
    );
    await expect(
      controller.getByRole("button", { name: /Minimize file viewer:/ }),
    ).toBeVisible();
    if (viewport.width <= 800) {
      await expect(
        page.locator("[data-message-input-toolbar] [data-voice-input-button]"),
      ).toBeVisible();
      await expect(
        page.locator(
          "[data-message-input-toolbar] [data-send-button-with-help]",
        ),
      ).toBeVisible();
    }

    await capture(page, `${viewport.name}-open`);
    if (viewport.name === "desktop") {
      const modeButton = page.locator(
        "[data-message-input-toolbar] [data-mode-button]",
      );
      await expect(modeButton).toBeVisible();
      const modeButtonBox = await modeButton.boundingBox();
      if (!modeButtonBox) {
        throw new Error("Expected permission mode button to have a layout box");
      }
      const modeButtonIsHitTarget = await page.evaluate(
        ({ x, y }) =>
          document
            .elementFromPoint(x, y)
            ?.closest("[data-message-input-toolbar] [data-mode-button]") !==
          null,
        {
          x: modeButtonBox.x + modeButtonBox.width / 2,
          y: modeButtonBox.y + modeButtonBox.height / 2,
        },
      );
      expect(modeButtonIsHitTarget).toBe(true);
      await page.mouse.click(
        modeButtonBox.x + modeButtonBox.width / 2,
        modeButtonBox.y + modeButtonBox.height / 2,
      );
      await expect(viewer).not.toBeVisible();
      await expect(controller).toBeVisible();
      await expect(page.locator("[data-mode-selector-dropdown]")).toBeVisible();
      await capture(page, "desktop-toolbar-action-parked");
      await page.keyboard.press("Escape");
      await controller
        .getByRole("button", { name: /Restore file viewer:/ })
        .click();
      await expect(viewer).toBeVisible();
    } else {
      const conversationButton = page.locator(
        "[data-message-input-toolbar] [data-conversation-view-toolbar-button]",
      );
      await expect(conversationButton).toBeVisible();
      const conversationButtonBox = await conversationButton.boundingBox();
      if (!conversationButtonBox) {
        throw new Error("Expected conversation button to have a layout box");
      }
      const conversationButtonIsHitTarget = await page.evaluate(
        ({ x, y }) =>
          document
            .elementFromPoint(x, y)
            ?.closest(
              "[data-message-input-toolbar] [data-conversation-view-toolbar-button]",
            ) !== null,
        {
          x: conversationButtonBox.x + conversationButtonBox.width / 2,
          y: conversationButtonBox.y + conversationButtonBox.height / 2,
        },
      );
      expect(conversationButtonIsHitTarget).toBe(true);
      const pressedBefore =
        await conversationButton.getAttribute("aria-pressed");
      await page.mouse.click(
        conversationButtonBox.x + conversationButtonBox.width / 2,
        conversationButtonBox.y + conversationButtonBox.height / 2,
      );
      await expect(viewer).not.toBeVisible();
      await expect(controller).toBeVisible();
      await expect(conversationButton).toHaveAttribute(
        "aria-pressed",
        pressedBefore === "true" ? "false" : "true",
      );
      await controller
        .getByRole("button", { name: /Restore file viewer:/ })
        .click();
      await expect(viewer).toBeVisible();
    }
    if (viewport.width <= 800) {
      const viewerBody = viewer.locator("[data-file-viewer-body]");
      const finalLine = viewer.getByText(
        "End of file viewer clearance specimen.",
        { exact: true },
      );
      await viewerBody.evaluate((element) => {
        element.scrollTop = element.scrollHeight;
      });
      await expect(finalLine).toBeVisible();
      const [finalLineBox, toolbarBox] = await Promise.all([
        finalLine.boundingBox(),
        page.locator("[data-message-input-toolbar]").boundingBox(),
      ]);
      if (!finalLineBox || !toolbarBox) {
        throw new Error("Expected final line and toolbar to have layout boxes");
      }
      expect(finalLineBox.y + finalLineBox.height).toBeLessThanOrEqual(
        toolbarBox.y,
      );
      await capture(page, `${viewport.name}-scrolled-bottom`);
    }
    await viewer.getByRole("button", { name: "Minimize file viewer" }).click();
    await expect(viewer).not.toBeVisible();

    const restore = controller.getByRole("button", {
      name: /Restore file viewer:/,
    });
    await expect(restore).toBeVisible();
    expect((await controller.boundingBox())?.width).toBeGreaterThanOrEqual(
      viewport.name === "mobile" ? 148 : 60,
    );
    expect(
      await controller.evaluate(
        (element) => getComputedStyle(element).animationName,
      ),
    ).toContain("file-viewer-arrive");
    await capture(page, `${viewport.name}-parked`);

    await restore.click();
    await expect(viewer).toBeVisible();
    await expect(
      viewer.getByText("Test Project", { exact: true }),
    ).toBeVisible();

    await controller
      .getByRole("button", { name: /Minimize file viewer:/ })
      .click();
    await expect(viewer).not.toBeVisible();
    await controller
      .getByRole("button", { name: /Close file viewer:/ })
      .click();
    await expect(controller).not.toBeVisible();
  });
}
