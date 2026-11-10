import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { UI_KEYS } from "../src/lib/storageKeys.js";
import { e2ePaths, expect, test } from "./fixtures.js";
import { recordUiCapture } from "./support/ui-capture.js";

const mockProjectPath = join(e2ePaths.tempDir, "mockproject");
const projectId = Buffer.from(mockProjectPath).toString("base64url");
const sessionId = "code-fence-mermaid-001";

test.use({
  serviceWorkers: "block",
  draftSessionIds: [sessionId, "file-viewer-absolute-001"],
});

test.beforeEach(async ({ page }) => {
  await page.addInitScript((key) => {
    localStorage.setItem(key, "paragraph-always");
  }, UI_KEYS.quoteReplyButtonMode);
});

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

/**
 * Frames the block under test at the viewport the name records, rather than a
 * full-page capture that would scroll a 600px-tall viewport past the diagram.
 */
async function capture(page: Page, name: string) {
  if (!process.env.YEP_E2E_UI_CAPTURE_DIR) return;
  await page
    .locator("[data-ya-code-block]")
    .first()
    .scrollIntoViewIfNeeded()
    .catch(() => {});
  await page.mouse.move(1, 1);
  await page.waitForTimeout(300);
  await recordUiCapture(page, name);
}

async function openTranscript(page: Page, baseURL: string) {
  await page.goto(`${baseURL}/projects/${projectId}/sessions/${sessionId}`);
  await dismissOnboardingIfVisible(page);
  await expect(page.locator("[data-ya-code-rendered] svg")).toBeVisible({
    timeout: 20000,
  });
}

async function expectProseQuoteTargets(page: Page) {
  const circles = page.locator(".text-block-quote-paragraph");
  await expect.poll(() => circles.count()).toBeGreaterThan(0);
  // The rail virtualizes its targets. Every mounted circle must align with
  // ordinary prose/code, regardless of which targets are in the scrollport.
  await expect
    .poll(() =>
      circles.evaluateAll((buttons) =>
        buttons.every((button) => {
          const surface = button.closest(".text-block");
          const bottom = button.getBoundingClientRect().bottom;
          return Array.from(
            surface?.querySelectorAll(
              ".text-block-content p, .text-block-content pre",
            ) ?? [],
          ).some(
            (block) =>
              !block.closest("[data-ya-code-block]") &&
              Math.abs(block.getBoundingClientRect().bottom - bottom) < 2,
          );
        }),
      ),
    )
    .toBe(true);
}

test("renders a mermaid fence as a diagram and labels other fences", async ({
  page,
  baseURL,
}) => {
  await page.setViewportSize({ width: 1000, height: 600 });
  await openTranscript(page, baseURL);

  // The mermaid block shows the diagram; its source is retained behind the
  // source/render toggle.
  const block = page.locator("[data-ya-code-block]").first();
  await expect(block).toHaveAttribute("data-ya-code-view", "rendered");
  await expect(block.locator("pre")).toBeHidden();

  // Every other fence keeps its highlighted source and gains a language label.
  await expect(
    page.locator('pre[data-ya-code-language="typescript"]'),
  ).toBeVisible();
  await expectProseQuoteTargets(page);

  await capture(page, "code-fence-mermaid-desktop-1000x600");

  // The toggle fades in on hover like the other Σ affordances, and its label
  // names the diagram so it cannot be confused with the message's own
  // source/rendered toggle.
  const toggle = block.locator("[data-ya-code-toggle]");
  await block.hover();
  await expect(toggle).toHaveAccessibleName("Show diagram source");
  await toggle.click();
  await expect(block).toHaveAttribute("data-ya-code-view", "source");
  await expect(block.locator("pre")).toBeVisible();
  await expectProseQuoteTargets(page);
  await capture(page, "code-fence-mermaid-source-desktop-1000x600");

  await block.hover();
  await expect(toggle).toHaveAccessibleName("Show diagram");
  await toggle.click();
  await expect(block).toHaveAttribute("data-ya-code-view", "rendered");

  await block.locator("[data-ya-code-expand]").click();
  const viewer = page.getByRole("dialog", { name: "Diagram", exact: true });
  await expect(viewer.getByRole("img")).toBeVisible();
  await expect
    .poll(() =>
      viewer
        .getByRole("img")
        .evaluate((img: HTMLImageElement) => img.naturalWidth),
    )
    .toBeGreaterThan(0);
  await recordUiCapture(page, "mermaid-viewer-desktop-1000x600");
  await page.keyboard.press("Escape");
  await expect(viewer).toBeHidden();

  const composer = page.locator("[data-composer-input]");
  let typed = "";
  for (const character of "Review this diagram") {
    // Keep changing the diagram view while real keystrokes reach the composer.
    await toggle.evaluate((element: HTMLButtonElement) => element.click());
    typed += character;
    await composer.pressSequentially(character);
    await expect(composer).toHaveValue(typed, { timeout: 100 });
  }
});

test("renders a mermaid fence at phone width", async ({ page, baseURL }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  // Emulate touch from the start, as on a phone: Chromium keeps
  // `(hover: none)` after emulation ends, and the touch-sized controls it
  // selects would shift the transcript between the Back check's samples.
  const touch = await page.context().newCDPSession(page);
  await touch.send("Emulation.setTouchEmulationEnabled", { enabled: true });
  await openTranscript(page, baseURL);

  const diagram = page.locator("[data-ya-code-rendered] svg").first();
  await expect(diagram).toBeVisible();
  await expectProseQuoteTargets(page);

  // A wide diagram must stay inside the viewport rather than widening it.
  const width = await diagram.evaluate(
    (node) => node.getBoundingClientRect().width,
  );
  expect(width).toBeLessThanOrEqual(375);

  await capture(page, "code-fence-mermaid-mobile-375x812");

  const beforeTop = await diagram.evaluate(
    (node) => node.getBoundingClientRect().top,
  );
  await diagram.click();
  const viewer = page.getByRole("dialog", { name: "Diagram", exact: true });
  const image = viewer.getByRole("img");
  await expect
    .poll(() => image.evaluate((img: HTMLImageElement) => img.naturalWidth))
    .toBeGreaterThan(0);
  const initialWidth = await image.evaluate(
    (img) => img.getBoundingClientRect().width,
  );
  await viewer.getByRole("button", { name: "Zoom in", exact: true }).click();
  await expect
    .poll(() => image.evaluate((img) => img.getBoundingClientRect().width))
    .toBeGreaterThan(initialWidth);

  // Real Chromium touch input exercises pointer capture, pinch and pan routing.
  const stage = image.locator("xpath=../../..");
  const rect = await stage.boundingBox();
  if (!rect) throw new Error("Missing image stage");
  const center = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  const widthBeforePinch = await image.evaluate(
    (img) => img.getBoundingClientRect().width,
  );
  await touch.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [
      { id: 1, x: center.x - 35, y: center.y },
      { id: 2, x: center.x + 35, y: center.y },
    ],
  });
  await touch.send("Input.dispatchTouchEvent", {
    type: "touchMove",
    touchPoints: [
      { id: 1, x: center.x - 100, y: center.y },
      { id: 2, x: center.x + 100, y: center.y },
    ],
  });
  await touch.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });
  await expect
    .poll(() => image.evaluate((img) => img.getBoundingClientRect().width))
    .toBeGreaterThan(widthBeforePinch * 2);
  const beforePan = await stage.evaluate((node) => node.scrollLeft);
  await touch.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ id: 1, ...center }],
  });
  await touch.send("Input.dispatchTouchEvent", {
    type: "touchMove",
    touchPoints: [{ id: 1, x: center.x - 65, y: center.y }],
  });
  await touch.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });
  await expect
    .poll(() => stage.evaluate((node) => node.scrollLeft))
    .toBeGreaterThan(beforePan + 40);
  await recordUiCapture(page, "mermaid-viewer-phone-zoomed-375x812");
  await viewer.getByRole("radio", { name: "Fit", exact: true }).click();
  await recordUiCapture(page, "mermaid-viewer-phone-fit-375x812");
  await page.goBack();
  await expect(viewer).toBeHidden();
  await expect
    .poll(() => diagram.evaluate((node) => node.getBoundingClientRect().top))
    .toBeCloseTo(beforeTop, 0);
});

test("excludes Mermaid labels from the sidebar Markdown quote rail", async ({
  page,
  baseURL,
}) => {
  await page.addInitScript(
    (key) => localStorage.setItem(key, "dark"),
    UI_KEYS.theme,
  );
  const readmePath = join(
    e2ePaths.tempDir,
    "file-browser-project",
    "README.md",
  );
  const original = readFileSync(readmePath, "utf8");
  writeFileSync(
    readmePath,
    '# Turn flow\n\n```mermaid\ngraph LR\nA["Client<br/>Send prompt"] --> B["Server<br/>Own process"] --> C["Agent<br/>Stream output"]\n```\n',
  );
  try {
    await page.setViewportSize({ width: 1000, height: 600 });
    await page.goto(
      `${baseURL}/projects/${projectId}/sessions/file-viewer-absolute-001`,
    );
    await dismissOnboardingIfVisible(page);
    await page.locator('a[data-ya-private-project-file-link="true"]').click();
    const viewer = page.locator(".file-viewer");
    await expect(viewer.locator("[data-ya-code-rendered] svg")).toBeVisible();
    // Real Mermaid HTML node labels must not turn into paragraph targets.
    await expect(viewer.locator("[data-ya-code-rendered] p")).not.toHaveCount(
      0,
    );
    await expect(viewer.locator(".text-block-quote-paragraph")).toHaveCount(1);
    await recordUiCapture(page, "mermaid-sidebar-desktop-1000x600");
    await page.setViewportSize({ width: 375, height: 812 });
    await expect(viewer.locator(".text-block-quote-paragraph")).toHaveCount(1);
    await recordUiCapture(page, "mermaid-sidebar-phone-375x812");
    await viewer.locator("[data-ya-code-rendered]").focus();
    await page.keyboard.press("Enter");
    const diagramViewer = page.getByRole("dialog", {
      name: "Diagram",
      exact: true,
    });
    await expect(diagramViewer.getByRole("img")).toBeVisible();
    await expect
      .poll(() =>
        diagramViewer
          .getByRole("img")
          .evaluate((img: HTMLImageElement) => img.naturalWidth),
      )
      .toBeGreaterThan(0);
    await page.mouse.move(1, 1);
    await expect(page.getByRole("tooltip")).toBeHidden();
    await recordUiCapture(page, "mermaid-html-labels-viewer-phone-375x812");
    await page.keyboard.press("Escape");
    await expect(diagramViewer).toBeHidden();
    await expect(viewer).toBeVisible();
  } finally {
    writeFileSync(readmePath, original);
  }
});
