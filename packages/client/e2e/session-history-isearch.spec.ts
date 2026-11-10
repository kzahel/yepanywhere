import { join } from "node:path";
import { e2ePaths, expect, test } from "./fixtures.js";
import { recordUiCapture } from "./support/ui-capture.js";

const mockProjectPath = join(e2ePaths.tempDir, "mockproject");
const projectId = Buffer.from(mockProjectPath).toString("base64url");
const sessionId = "history-search-001";

for (const viewport of [
  { name: "desktop", width: 1200, height: 600 },
  { name: "mobile", width: 375, height: 812 },
] as const) {
  test(`continues isearch through bounded history at ${viewport.name} width`, async ({
    page,
    baseURL,
  }) => {
    const consoleFailures: string[] = [];
    const pageErrors: string[] = [];
    const olderPageRequests: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "warning" || message.type() === "error") {
        consoleFailures.push(`${message.type()}: ${message.text()}`);
      }
    });
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (url.searchParams.has("beforeMessageId")) {
        olderPageRequests.push(url.searchParams.get("beforeMessageId") ?? "");
      }
    });

    await page.setViewportSize({
      width: viewport.width,
      height: viewport.height,
    });
    await page.emulateMedia({ colorScheme: "dark" });
    await page.goto(`${baseURL}/projects/${projectId}/sessions/${sessionId}`);
    const list = page.locator(".session-messages [data-message-list]");
    await expect(list.locator('[data-render-id="history-user-9"]')).toBeVisible(
      {
        timeout: 10000,
      },
    );
    await expect(list).not.toHaveAttribute("aria-busy", "true", {
      timeout: 10000,
    });
    await page.addStyleTag({
      content: "[data-message-list] [data-render-id] { min-height: 120px; }",
    });

    await page.keyboard.press("Control+r");
    const input = page.getByRole("textbox", {
      name: "Reverse search user turns",
    });
    let typed = "";
    for (const character of "horizon needle") {
      typed += character;
      await input.pressSequentially(character);
      await expect(input).toHaveValue(typed, { timeout: 100 });
    }
    const coverage = page.getByLabel("Percentage of session messages checked");
    await expect(coverage).toHaveText(/\d+%/);
    expect(Number((await coverage.innerText()).replace("%", ""))).toBeLessThan(
      100,
    );
    await expect(list.locator('[data-render-id="history-user-0"]')).toHaveCount(
      0,
    );

    await page.getByRole("button", { name: "Search older" }).click();
    const moreButton = page.getByRole("button", { name: "More" });
    const startReached = page.getByText("Start of session reached", {
      exact: true,
    });
    const olderResult = page.getByText("Older result", { exact: true });
    await expect(moreButton).toBeVisible();
    const moreButtonBeforeClick = await moreButton.boundingBox();
    await moreButton.click();
    await expect(
      page.getByText("2 older history page(s) searched"),
    ).toBeVisible();
    const moreButtonAfterClick = await moreButton.boundingBox();
    expect(moreButtonAfterClick).toEqual(moreButtonBeforeClick);

    const requestsBeforeKeyboardExtension = olderPageRequests.length;
    await page.keyboard.press("Control+r");
    await expect(startReached).toBeVisible();
    await expect(olderResult).toBeVisible();
    await expect(
      page
        .getByRole("search")
        .getByText("The archived horizon needle is in the oldest page."),
    ).toBeVisible();
    await expect(list.locator('[data-render-id="history-user-0"]')).toHaveCount(
      0,
    );
    expect(olderPageRequests.length).toBeGreaterThan(
      requestsBeforeKeyboardExtension,
    );
    expect(olderPageRequests).toContain("history-compact-4");
    expect(olderPageRequests).toContain("history-compact-2");
    const requestsBeforeHydration = olderPageRequests.length;
    await expect(coverage).toHaveText("100%");
    await recordUiCapture(page, `${viewport.name}-search`);

    await page
      .getByRole("search")
      .getByRole("button", { name: /Older result/ })
      .click();
    const highlighted = list.locator('[data-search-match="true"]');
    await expect(highlighted).toContainText("archived horizon needle");
    await expect(input).toBeVisible();
    await recordUiCapture(page, `${viewport.name}-highlight`);

    await page.addStyleTag({
      content:
        '[data-render-id="history-user-0"] [data-text-block] { padding-top: 700px; }',
    });

    if (viewport.name === "mobile")
      await page.getByRole("button", { name: "Go to selected match" }).click();
    else await page.keyboard.press("Enter");
    const historicalTarget = list.locator('[data-render-id="history-user-0"]');
    await expect(historicalTarget).toBeVisible();
    await expect(input).toHaveCount(0);
    await expect(list).toContainText(
      "Unloaded history omitted · recent transcript continues below",
    );
    await expect(list.locator('[data-render-id="history-user-9"]')).toHaveCount(
      1,
    );
    await expect
      .poll(() => olderPageRequests.length)
      .toBe(requestsBeforeHydration + 1);
    const targetOffset = async () => {
      return page.evaluate(() => {
        const range = CSS.highlights.get("session-isearch")?.values().next()
          .value as Range | undefined;
        const port = document
          .querySelector(".session-messages")
          ?.getBoundingClientRect();
        if (!range || !port) return null;
        const rect = range.getBoundingClientRect();
        return rect.top >= port.top && rect.bottom <= port.bottom
          ? rect.top - port.top
          : null;
      });
    };
    await expect.poll(targetOffset).not.toBeNull();
    const settledTargetOffset = await targetOffset();
    await page.waitForTimeout(100);
    expect(await targetOffset()).toBeCloseTo(settledTargetOffset ?? 0, 0);
    await recordUiCapture(page, `${viewport.name}-long-match`);

    await page.keyboard.press("Control+End");
    await expect(historicalTarget).toHaveCount(0);
    await expect(list).not.toContainText("Unloaded history omitted");
    expect(consoleFailures).toEqual([]);
    expect(pageErrors).toEqual([]);
  });
}
