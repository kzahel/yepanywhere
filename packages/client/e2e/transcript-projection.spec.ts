import type { Page, TestInfo } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { e2ePaths, expect, test } from "./fixtures.js";

const mockProjectPath = join(e2ePaths.tempDir, "mockproject");
const projectId = Buffer.from(mockProjectPath).toString("base64url");
const sessionId = "transcript-specimen-001";

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

async function waitForCompletedTranscript(page: Page) {
  const list = page.locator(".session-messages [data-message-list]");
  await expect(list).toBeVisible({ timeout: 10000 });
  await expect(list).not.toHaveAttribute("aria-busy", "true", {
    timeout: 10000,
  });
  await expect(
    list.locator('[data-render-id="specimen-assistant-2"]'),
  ).toBeVisible({ timeout: 10000 });
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
  return list;
}

async function topLevelRenderRows(page: Page) {
  return page.locator("[data-message-list]").evaluate((list) =>
    Array.from(
      list.querySelectorAll<HTMLElement>("[data-render-id][data-render-type]"),
    )
      .filter(
        (row) =>
          !row.parentElement?.closest("[data-render-id][data-render-type]"),
      )
      .map((row) => ({
        id: row.dataset.renderId,
        type: row.dataset.renderType,
      })),
  );
}

async function attachTranscriptScreenshots(
  page: Page,
  testInfo: TestInfo,
  viewportName: string,
) {
  await page.addStyleTag({
    content: `
      *, *::before, *::after {
        animation-duration: 0s !important;
        caret-color: transparent !important;
        transition-duration: 0s !important;
      }
      [data-message-age], [data-turn-rail] { visibility: hidden !important; }
    `,
  });
  const transcript = page.locator(".session-messages");
  for (const position of ["top", "tail"] as const) {
    await transcript.evaluate((element, wanted) => {
      element.scrollTop = wanted === "top" ? 0 : element.scrollHeight;
    }, position);
    await page.waitForTimeout(100);
    await testInfo.attach(`${viewportName}-${position}`, {
      body: await transcript.screenshot({ animations: "disabled" }),
      contentType: "image/png",
    });
    const captureDir = process.env.YEP_E2E_UI_CAPTURE_DIR;
    if (captureDir) {
      mkdirSync(captureDir, { recursive: true });
      await page.screenshot({
        animations: "disabled",
        path: join(captureDir, `${viewportName}-${position}.png`),
      });
    }
  }
}

for (const specimen of [
  { name: "desktop", width: 1000, height: 600 },
  { name: "mobile", width: 375, height: 812 },
] as const) {
  test(`renders the deterministic transcript projection at ${specimen.name} width`, async ({
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
      width: specimen.width,
      height: specimen.height,
    });
    await page.goto(`${baseURL}/projects/${projectId}/sessions/${sessionId}`);
    await dismissOnboardingIfVisible(page);
    const list = await waitForCompletedTranscript(page);

    const rows = await topLevelRenderRows(page);
    expect(rows).toEqual([
      { id: "specimen-user-1", type: "user_prompt" },
      { id: "specimen-assistant-1-1", type: "text" },
      { id: "specimen-tool-output-1", type: "system" },
      { id: "specimen-compact-1", type: "system" },
      { id: "specimen-assistant-2", type: "text" },
      {
        id: "conversation-activity-specimen-assistant-1-0",
        type: "conversation_activity",
      },
    ]);
    expect(new Set(rows.map((row) => row.id)).size).toBe(rows.length);

    const toolOutput = list.locator(
      '[data-render-id="specimen-tool-output-1"]',
    );
    await expect(toolOutput).toContainText(
      "Tool output from slack.notifications",
    );
    await toolOutput.locator("summary").click();
    await expect(toolOutput).toContainText(
      "new message from the release channel",
    );

    const widths = await page.evaluate(() => {
      const transcript =
        document.querySelector<HTMLElement>(".session-messages");
      return {
        documentClient: document.documentElement.clientWidth,
        documentScroll: document.documentElement.scrollWidth,
        transcriptClient: transcript?.clientWidth ?? 0,
        transcriptScroll: transcript?.scrollWidth ?? 0,
      };
    });
    expect(widths.documentScroll).toBeLessThanOrEqual(
      widths.documentClient + 1,
    );
    expect(widths.transcriptScroll).toBeLessThanOrEqual(
      widths.transcriptClient + 1,
    );
    expect(consoleFailures).toEqual([]);
    expect(pageErrors).toEqual([]);
    await attachTranscriptScreenshots(page, testInfo, specimen.name);
  });
}
