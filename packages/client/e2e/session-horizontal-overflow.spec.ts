import type { Page, TestInfo } from "@playwright/test";
import { join } from "node:path";
import { e2ePaths, expect, test } from "./fixtures.js";
import {
  openSessionPage,
  twoTurns,
  streamResponses,
  liveUpdate,
  typeEachKeyWithin100ms,
} from "./support/session-page-harness.js";
import { recordUiCapture } from "./support/ui-capture.js";

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

async function installWideTable(page: Page) {
  const list = page.locator("[data-session-messages] [data-message-list]");
  await expect(list).not.toHaveAttribute("aria-busy", "true", {
    timeout: 10000,
  });
  const content = list
    .locator(
      '[data-render-id="specimen-assistant-2"] [data-text-block-content]',
    )
    .first();
  await expect(content).toBeVisible({ timeout: 10000 });
  await content.evaluate((element) => {
    element.insertAdjacentHTML(
      "beforeend",
      `<section data-horizontal-overflow-fixture="true">
        <h2>Wide comparison</h2>
        <table style="min-width: 1100px">
          <thead>
            <tr>
              <th>Bank</th>
              <th>Likely availability to you</th>
              <th>Practical annual cost</th>
              <th>Salary discount</th>
              <th>Account opening</th>
              <th>Additional notes</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>PostFinance Smart</td>
              <td>Supports Swiss-resident U.S. persons</td>
              <td>CHF 60</td>
              <td>No salary discount</td>
              <td>Online or in branch</td>
              <td>Generic transcript fallback specimen</td>
            </tr>
            <tr>
              <td>Raiffeisen Zürich</td>
              <td>Confirm acceptance first</td>
              <td>About CHF 48 after first year</td>
              <td>Available</td>
              <td>Branch appointment</td>
              <td>Cooperative share may be required</td>
            </tr>
          </tbody>
        </table>
      </section>`,
    );
  });
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
  await page.evaluate(async () => {
    await document.fonts.ready;
    const transcript = document.querySelector<HTMLElement>(
      "[data-session-messages]",
    );
    const fixture = document.querySelector<HTMLElement>(
      "[data-horizontal-overflow-fixture]",
    );
    if (!transcript || !fixture) throw new Error("Wide table fixture missing");
    const transcriptRect = transcript.getBoundingClientRect();
    const fixtureRect = fixture.getBoundingClientRect();
    transcript.scrollTop =
      transcript.scrollTop + fixtureRect.top - transcriptRect.top - 24;
    transcript.scrollLeft = 0;
  });
}

async function attachScreenshot(page: Page, testInfo: TestInfo, name: string) {
  const path = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ animations: "disabled", path });
  await testInfo.attach(name, { contentType: "image/png", path });
}

async function shellGeometry(page: Page) {
  return page.evaluate(() => {
    const rectangle = (selector: string) => {
      const element = document.querySelector<HTMLElement>(selector);
      if (!element) throw new Error(`Shell element missing: ${selector}`);
      const rect = element.getBoundingClientRect();
      return { left: rect.left, right: rect.right, width: rect.width };
    };
    return {
      windowScrollX: window.scrollX,
      header: rectangle("[data-session-header]"),
      headerInner: rectangle("[data-session-header-inner]"),
      projectBreadcrumb: rectangle("[data-project-breadcrumb]"),
      title: rectangle("[data-session-title-row]"),
      composer: rectangle("[data-session-input]"),
    };
  });
}

for (const viewport of [
  { name: "desktop", width: 1000, height: 600 },
  { name: "phone", width: 375, height: 812 },
] as const) {
  test.describe(`composer layout on ${viewport.name}`, () => {
    test.use({
      hasTouch: viewport.name === "phone",
      isMobile: viewport.name === "phone",
    });
    test(`keeps sent markers and Follow clear of the editor at ${viewport.name} width`, async ({
      page,
      baseURL,
    }) => {
      await page.setViewportSize(viewport);
      await streamResponses(page);
      await page.addInitScript(() =>
        localStorage.setItem("yep-anywhere-theme", "dark"),
      );
      const session = await openSessionPage(page, baseURL, {
        owner: "self",
        processState: "in-turn",
        messages: twoTurns,
        ready: "The lexer splits words.",
      });
      const text =
        "Please review the message layout on a phone. Ordinary paragraphs should wrap within the transcript and keep their delivery status visible.\n\nKeep the draft readable while live work continues.";
      for (const [index, content] of [
        text,
        [{ type: "text", text }],
      ].entries()) {
        session.emit("message", {
          type: "user",
          uuid: `layout-echo-${index}`,
          timestamp: new Date().toISOString(),
          tempId: `layout-send-${index}`,
          messageMetadata: { deliveryIntent: "steer" },
          message: { role: "user", content },
        });
      }
      const markers = page.locator("[data-user-prompt-delivery-marker]");
      await expect(markers).toHaveCount(2);
      for (const marker of await markers.all()) {
        const geometry = await marker.evaluate((element) => {
          const bubble = element.closest("[data-message-user-prompt]")!;
          return {
            markerLeft: element.getBoundingClientRect().left,
            markerRight: element.getBoundingClientRect().right,
            bubbleRight: bubble.getBoundingClientRect().right,
            transcriptRight: document
              .querySelector("[data-session-messages]")!
              .getBoundingClientRect().right,
          };
        });
        expect(
          geometry.markerLeft - geometry.bubbleRight,
        ).toBeGreaterThanOrEqual(0);
        expect(geometry.markerLeft - geometry.bubbleRight).toBeLessThan(10);
        expect(geometry.markerRight).toBeLessThanOrEqual(
          geometry.transcriptRight,
        );
      }
      const transcript = page.locator("[data-session-messages]");
      expect(
        await transcript.evaluate((el) => el.scrollWidth - el.clientWidth),
      ).toBeLessThanOrEqual(1);
      expect(
        await page.evaluate(
          () =>
            document.documentElement.scrollWidth -
            document.documentElement.clientWidth,
        ),
      ).toBeLessThanOrEqual(1);
      await recordUiCapture(page, `sent-markers-${viewport.name}`);

      await transcript.hover();
      await page.mouse.wheel(0, -250);
      const follow = page.locator("[data-message-follow-toggle]");
      await expect(follow).toBeVisible();
      const draft =
        "Keep this first line completely readable. Continue reviewing the layout while new output arrives. This longer draft should wrap naturally over several lines, with every word visible and the Follow button above the editor.";
      await session.composer.focus();
      await typeEachKeyWithin100ms(session.composer, draft, (typed) => {
        session.emit("message", liveUpdate(typed.length));
      });
      await expect(session.composer).toBeFocused();
      await expect(follow).toBeVisible();
      const followBox = await follow.boundingBox();
      const editorBox = await session.composer.boundingBox();
      expect(followBox!.y + followBox!.height).toBeLessThanOrEqual(
        editorBox!.y,
      );
      await recordUiCapture(page, `follow-draft-${viewport.name}`);
      await follow.click();
      await expect(follow).not.toBeVisible();
      await expect(session.composer).toHaveValue(draft);
    });
  });

  test(`keeps wide session content reachable at ${viewport.name} width`, async ({
    page,
    baseURL,
  }, testInfo) => {
    await page.setViewportSize(viewport);
    await page.goto(`${baseURL}/projects/${projectId}/sessions/${sessionId}`);
    await dismissOnboardingIfVisible(page);
    await installWideTable(page);

    const geometry = await page.evaluate(() => {
      const documentElement = document.documentElement;
      const transcript = document.querySelector<HTMLElement>(
        "[data-session-messages]",
      );
      if (!transcript) throw new Error("Transcript missing");
      return {
        documentClientWidth: documentElement.clientWidth,
        documentScrollWidth: documentElement.scrollWidth,
        transcriptClientWidth: transcript.clientWidth,
        transcriptScrollWidth: transcript.scrollWidth,
        transcriptOverflowX: getComputedStyle(transcript).overflowX,
      };
    });
    expect(geometry.documentScrollWidth).toBeLessThanOrEqual(
      geometry.documentClientWidth + 1,
    );
    expect(geometry.transcriptScrollWidth).toBeGreaterThan(
      geometry.transcriptClientWidth + 100,
    );
    expect(geometry.transcriptOverflowX).toBe("auto");
    const shellBeforeScroll = await shellGeometry(page);
    await attachScreenshot(page, testInfo, `${viewport.name}-left-edge`);

    const horizontalPosition = await page
      .locator("[data-session-messages]")
      .evaluate((transcript) => {
        transcript.scrollLeft = Math.min(
          360,
          transcript.scrollWidth - transcript.clientWidth,
        );
        return transcript.scrollLeft;
      });
    expect(horizontalPosition).toBeGreaterThan(0);
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        }),
    );
    expect(await shellGeometry(page)).toEqual(shellBeforeScroll);
    await attachScreenshot(page, testInfo, `${viewport.name}-scrolled-right`);
  });
}
