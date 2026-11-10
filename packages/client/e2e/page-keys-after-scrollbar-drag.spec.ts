import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { e2ePaths, expect, test } from "./fixtures.js";

const mockProjectPath = join(e2ePaths.tempDir, "mockproject");
const projectId = Buffer.from(mockProjectPath).toString("base64url");
const sessionId = "transcript-specimen-001";
const paginationSessionId = "page-key-pagination-001";

test.use({ serviceWorkers: "block" });

async function dismissOnboardingIfVisible(page: Page) {
  const skip = page.getByRole("button", { name: "Skip all" });
  const appeared = await skip
    .waitFor({ state: "visible", timeout: 2_000 })
    .then(() => true)
    .catch(() => false);
  if (appeared) await skip.click({ force: true });
}

async function waitForTranscript(page: Page) {
  const transcript = page.locator(".session-messages");
  await expect(transcript.locator("[data-message-list]")).not.toHaveAttribute(
    "aria-busy",
    "true",
    { timeout: 10_000 },
  );
  await page.addStyleTag({
    content:
      "body.page-key-scroll-test [data-message-list]::after { content: ''; display: block; height: 3000px; }",
  });
  await page.evaluate(() =>
    document.body.classList.add("page-key-scroll-test"),
  );
  await expect
    .poll(() => transcript.evaluate((element) => element.scrollHeight))
    .toBeGreaterThan(2_000);
  return transcript;
}

async function capture(page: Page, name: string) {
  const directory = process.env.YEP_E2E_UI_CAPTURE_DIR;
  if (!directory) return;
  mkdirSync(directory, { recursive: true });
  await page.screenshot({
    animations: "disabled",
    path: join(directory, name),
  });
}

async function dragNativeScrollbarToMiddle(page: Page, transcript: Locator) {
  const metrics = await transcript.evaluate((element) => {
    if (!(element instanceof HTMLElement))
      throw new Error("Expected an HTML scroll container");
    const rect = element.getBoundingClientRect();
    return {
      clientHeight: element.clientHeight,
      clientWidth: element.clientWidth,
      left: rect.left,
      maxScroll: element.scrollHeight - element.clientHeight,
      offsetWidth: element.offsetWidth,
      top: rect.top,
    };
  });
  test.skip(
    metrics.offsetWidth - metrics.clientWidth <= 0,
    "Browser uses overlay scrollbars, so no native gutter is available to drag",
  );

  const trackHeight = metrics.clientHeight;
  const thumbHeight = Math.max(
    20,
    (metrics.clientHeight / (metrics.clientHeight + metrics.maxScroll)) *
      trackHeight,
  );
  const x = metrics.left + metrics.offsetWidth - 4;
  const startY = metrics.top + thumbHeight / 2;
  const endY = metrics.top + (trackHeight - thumbHeight) / 2 + thumbHeight / 2;
  await page.mouse.move(x, startY);
  await page.mouse.down();
  await page.mouse.move(x, endY, { steps: 8 });
  await page.mouse.up();
  await expect
    .poll(() => transcript.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(metrics.clientHeight);
}

test("PageUp and PageDown keep scrolling after a native scrollbar drag", async ({
  page,
  baseURL,
}) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto(`${baseURL}/projects/${projectId}/sessions/${sessionId}`);
  await dismissOnboardingIfVisible(page);
  const transcript = await waitForTranscript(page);

  const composer = page.getByRole("textbox", { name: /message/i });
  await composer.focus();
  await dragNativeScrollbarToMiddle(page, transcript);
  await expect
    .poll(() =>
      transcript.evaluate((element) => document.activeElement === element),
    )
    .toBe(true);

  const draggedTop = await transcript.evaluate((element) => element.scrollTop);
  await page.keyboard.press("PageUp");
  await expect
    .poll(() => transcript.evaluate((element) => element.scrollTop))
    .toBeLessThan(draggedTop - 10);

  const pageUpTop = await transcript.evaluate((element) => element.scrollTop);
  await page.keyboard.press("PageDown");
  await expect
    .poll(() => transcript.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(pageUpTop + 10);

  await page.evaluate(() =>
    document.body.classList.remove("page-key-scroll-test"),
  );
  await transcript.evaluate((element) => {
    element.scrollTop = 0;
  });
  await capture(page, "page-keys-scrollbar-focus-desktop-1920x1080.png");
  await page.setViewportSize({ width: 375, height: 812 });
  await capture(page, "page-keys-scrollbar-focus-mobile-375x812.png");
});

for (const key of ["PageUp", "Home"] as const) {
  test(`${key} loads older history at the loaded boundary`, async ({
    page,
    baseURL,
  }) => {
    await page.addInitScript(() => {
      localStorage.setItem("yep-anywhere-conversation-view-enabled", "true");
      localStorage.setItem("yep-anywhere-conversation-view-turn-limit", "10");
      Object.defineProperty(window, "IntersectionObserver", {
        configurable: true,
        value: undefined,
      });
    });
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.goto(
      `${baseURL}/projects/${projectId}/sessions/${paginationSessionId}`,
    );
    await dismissOnboardingIfVisible(page);
    const transcript = await waitForTranscript(page);
    await expect(
      page.getByRole("button", {
        name: /^Load (older messages|\d+ earlier user turns)$/,
      }),
    ).toBeAttached();
    const oldestRequest = transcript.getByText("Oldest keyboard request");
    await expect(oldestRequest).toHaveCount(0);

    await transcript.focus();
    // CI 36985655035 raced a bare scrollTop write against initial follow
    // restoration. Establish reader intent through the actual scroll gesture,
    // then acknowledge the boundary before testing the keyboard demand.
    await transcript.hover();
    await page.mouse.wheel(0, -10_000);
    await expect
      .poll(() => transcript.evaluate((element) => element.scrollTop))
      .toBe(0);
    await expect(oldestRequest).toHaveCount(0);
    await page.keyboard.press(key);

    await expect(oldestRequest).toBeAttached();
  });
}
