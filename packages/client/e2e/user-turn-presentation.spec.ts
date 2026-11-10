import type { Locator, Page, TestInfo } from "@playwright/test";
import { join } from "node:path";
import { e2ePaths, expect, test } from "./fixtures.js";
import { recordUiCapture } from "./support/ui-capture.js";

const mockProjectPath = join(e2ePaths.tempDir, "mockproject");
const projectId = Buffer.from(mockProjectPath).toString("base64url");
const sessionId = "user-turn-presentation-001";

async function dismissOnboardingIfVisible(page: Page) {
  const skip = page.getByRole("button", { name: "Skip all", exact: true });
  if (await skip.isVisible().catch(() => false)) await skip.click();
}

async function waitForMeasuredLayout(
  prompt: Locator,
  expected: { actions: number; columns: number; rows: number },
) {
  await expect
    .poll(() =>
      prompt.evaluate((element) => {
        const style = (element as HTMLElement).style;
        return {
          actions: Number(style.getPropertyValue("--user-prompt-action-count")),
          columns: Number(
            style.getPropertyValue("--user-prompt-action-columns"),
          ),
          rows: Number(style.getPropertyValue("--user-prompt-action-rows")),
        };
      }),
    )
    .toEqual(expected);
}

async function expectActionsContained(prompt: Locator) {
  const geometry = await prompt.evaluate((element) => {
    const container = (element as HTMLElement).getBoundingClientRect();
    const actions = element
      .querySelector<HTMLElement>("[data-user-prompt-actions]")
      ?.getBoundingClientRect();
    return {
      actionsBottom: actions?.bottom ?? 0,
      actionsRight: actions?.right ?? 0,
      containerBottom: container.bottom,
      containerRight: container.right,
    };
  });
  expect(geometry.actionsBottom).toBeLessThanOrEqual(
    geometry.containerBottom + 0.5,
  );
  expect(geometry.actionsRight).toBeLessThanOrEqual(
    geometry.containerRight + 0.5,
  );
}

async function capture(
  page: Page,
  testInfo: TestInfo,
  name: string,
  locator: Locator,
) {
  await page.addStyleTag({
    content: `
      *, *::before, *::after {
        animation-duration: 0s !important;
        caret-color: transparent !important;
        transition-duration: 0s !important;
      }
      [data-user-prompt-actions] { opacity: 1 !important; }
      [data-message-age], [data-turn-rail] { visibility: hidden !important; }
    `,
  });
  const path = testInfo.outputPath(`${name}.png`);
  await locator.screenshot({ animations: "disabled", path });
  await testInfo.attach(name, { contentType: "image/png", path });
}

for (const viewport of [
  {
    name: "desktop",
    width: 1000,
    height: 600,
    firstLayout: { actions: 3, columns: 3, rows: 1 },
  },
  {
    name: "mobile",
    width: 375,
    height: 812,
    firstLayout: { actions: 3, columns: 1, rows: 3 },
  },
] as const) {
  test(`measures user-turn presentation at ${viewport.name} width`, async ({
    page,
    baseURL,
  }, testInfo) => {
    const consoleFailures: string[] = [];
    const pageErrors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "warning" || message.type() === "error") {
        consoleFailures.push(`${message.type()}: ${message.text()}`);
      }
    });
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.setViewportSize({
      width: viewport.width,
      height: viewport.height,
    });
    await page.addInitScript(() => {
      localStorage.setItem("yep-anywhere-glossary-hints-enabled", "true");
      localStorage.setItem("yep-anywhere-user-turn-font-size-offset", "4");
    });
    await page.goto(`${baseURL}/projects/${projectId}/sessions/${sessionId}`);
    await dismissOnboardingIfVisible(page);

    const prompts = page.locator("[data-user-prompt-container]");
    await expect(prompts).toHaveCount(2, { timeout: 10000 });
    const first = prompts.nth(0);
    const second = prompts.nth(1);
    await waitForMeasuredLayout(first, viewport.firstLayout);
    await waitForMeasuredLayout(second, {
      actions: 4,
      columns: 1,
      rows: 4,
    });
    await expectActionsContained(first);
    await expectActionsContained(second);

    const fileLink = first.locator("a[data-file-path-link]", {
      hasText: "turn-target.md",
    });
    await expect(fileLink).toBeVisible();
    await expect(fileLink.locator("[data-glossary-term]")).toHaveCount(0);
    await expect(
      first.locator('[data-glossary-term]:has-text("Viewer context")'),
    ).toBeVisible({ timeout: 10000 });
    await fileLink.click({ button: "right" });
    await expect(
      page.getByRole("menuitem", { name: "Download" }),
    ).toBeVisible();
    await recordUiCapture(page, `${viewport.name}-file-link-download-menu`, {
      width: viewport.width,
      height: viewport.height,
    });
    await page.keyboard.press("Escape");

    const textSize = await first
      .locator("[data-text-block]")
      .evaluate((element) =>
        Number.parseFloat(getComputedStyle(element).fontSize),
      );
    const bubbleSize = await first
      .locator("[data-message-user-prompt]")
      .evaluate((element) =>
        Number.parseFloat(getComputedStyle(element).fontSize),
      );
    expect(textSize - bubbleSize).toBeCloseTo(4, 5);

    await first.scrollIntoViewIfNeeded();
    await capture(
      page,
      testInfo,
      `${viewport.name}-session`,
      page.locator("[data-session-messages]"),
    );
    if (viewport.name === "mobile") {
      await second.scrollIntoViewIfNeeded();
      await capture(
        page,
        testInfo,
        "mobile-session-tall",
        page.locator("[data-session-messages]"),
      );
    }

    await page.goto(`${baseURL}/settings/appearance`);
    const sizeInput = page.getByRole("spinbutton", {
      name: "User turn size offset",
    });
    await expect(sizeInput).toHaveValue("4");
    await sizeInput.scrollIntoViewIfNeeded();
    await expect(
      page.getByText("User turn: paths and terms stay readable."),
    ).toBeVisible();
    await capture(
      page,
      testInfo,
      `${viewport.name}-appearance`,
      page.locator("[data-page-scroll-container]"),
    );

    expect(consoleFailures).toEqual([]);
    expect(pageErrors).toEqual([]);
  });
}
