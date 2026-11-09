import { join } from "node:path";
import { e2ePaths, expect, test } from "./fixtures.js";
import { recordUiCapture } from "./support/ui-capture.js";

const projectId = Buffer.from(join(e2ePaths.tempDir, "mockproject")).toString(
  "base64url",
);
const sessionId = "mock-session-001";
const fullTitle =
  "Make session titles readable on mobile: show the complete title in recent sessions and Session Info, with easy access from the header menu, while preserving the draft and live conversation.";

test.use({ serviceWorkers: "block", hasTouch: true });

// The browser boundary matters here: wrapping, viewport clipping, text
// selection, clipboard access, and modal/draft behavior cannot be proved by
// checking the rendered string in jsdom.
test("reads the full session title on phone and desktop without losing the draft", async ({
  page,
  context,
  baseURL,
}) => {
  const timestamp = new Date().toISOString();
  let live = true;
  const messages = Array.from({ length: 240 }, (_, index) => ({
    uuid: `history-${index}`,
    type: index % 2 ? "assistant" : "user",
    timestamp,
    content: `Review item ${index}: preserve the conversation and reader's place.`,
  }));
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.route(
    new RegExp(
      `/api/projects/[^/]+/sessions/${sessionId}(?:/metadata)?(?:\\?|$)`,
    ),
    (route) => {
      const ownership = live
        ? { owner: "self", processId: "title-process" }
        : { owner: "none" };
      return route.fulfill({
        json: {
          session: {
            id: sessionId,
            projectId,
            provider: "claude",
            title: "Make session titles readable…",
            fullTitle,
            createdAt: timestamp,
            updatedAt: timestamp,
            ownership,
            messageCount: messages.length,
          },
          ownership,
          processState: "idle",
          messages,
        },
      });
    },
  );
  let emit: ((data: object) => void) | undefined;
  await page.routeWebSocket("**/api/ws", (socket) => {
    const upstream = socket.connectToServer();
    socket.onMessage((wire) => {
      const frame =
        typeof wire === "string"
          ? JSON.parse(wire)
          : wire[0] === 1
            ? JSON.parse(wire.subarray(1).toString())
            : null;
      if (frame?.type === "subscribe" && frame.channel === "session") {
        let eventId = 0;
        emit = (data) =>
          socket.send(
            JSON.stringify({
              type: "event",
              subscriptionId: frame.subscriptionId,
              eventId: String(eventId++),
              eventType: "message",
              data,
            }),
          );
        socket.send(
          JSON.stringify({
            type: "event",
            subscriptionId: frame.subscriptionId,
            eventId: String(eventId++),
            eventType: "connected",
            data: { sessionId, processId: "title-process", state: "idle" },
          }),
        );
      } else upstream.send(wire);
    });
  });
  await page.setViewportSize({ width: 1000, height: 600 });
  await page.goto(`${baseURL}/projects/${projectId}/sessions/${sessionId}`);
  const input = page.locator("[data-composer-input]").first();
  await expect(input).toBeVisible();
  await expect.poll(() => Boolean(emit)).toBe(true);
  const header = page.locator(".session-header");
  const footerInfo = page.locator(".session-input").getByRole("button", {
    name: "Session info",
    exact: true,
  });

  for (const size of [
    { width: 1000, height: 600 },
    { width: 375, height: 812 },
  ]) {
    await page.setViewportSize(size);
    // The title stays on one line and is selectable; selecting it never follows a
    // current-session link or closes the dropdown.
    await header.locator(".session-title-recent-trigger").click();
    const current = page.getByRole("region", { name: "Current session" });
    const currentTitle = current.getByText(fullTitle, { exact: true });
    await expect(currentTitle).toBeVisible();
    await currentTitle.tap();
    await currentTitle.evaluate((element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    });
    expect(await page.evaluate(() => window.getSelection()?.toString())).toBe(
      fullTitle,
    );
    const geometry = await currentTitle.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return {
        height: rect.height,
        lineHeight: Number.parseFloat(style.lineHeight),
        width: element.clientWidth,
        scrollWidth: element.scrollWidth,
        whiteSpace: style.whiteSpace,
        userSelect: style.userSelect,
      };
    });
    expect(geometry.height).toBeLessThanOrEqual(geometry.lineHeight + 1);
    expect(geometry.scrollWidth).toBeGreaterThan(geometry.width);
    expect(geometry.whiteSpace).toBe("nowrap");
    expect(geometry.userSelect).toBe("text");
    await expect(
      current.getByRole("button", { name: "Copy title" }),
    ).toHaveCount(0);
    await recordUiCapture(page, `recent-session-title-${size.width}`);
    await page.keyboard.press("Escape");

    // Type each key with a concurrent stream update in a full conversation.
    await input.click();
    await input.evaluate((element) => {
      const samples: number[] = [];
      (
        window as unknown as { titleTypingSamples: number[] }
      ).titleTypingSamples = samples;
      let start = 0;
      element.addEventListener("keydown", () => {
        start = performance.now();
      });
      element.addEventListener("input", () => {
        requestAnimationFrame(() => samples.push(performance.now() - start));
      });
    });
    let draft = await input.inputValue();
    for (const [index, character] of [..." Keep my draft."].entries()) {
      emit?.({
        uuid: `live-${size.width}-${index}`,
        type: "assistant",
        timestamp,
        content: `Concurrent update ${size.width}/${index}`,
      });
      draft += character;
      await input.pressSequentially(character);
      await expect(input).toHaveValue(draft, { timeout: 100 });
    }
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as unknown as { titleTypingSamples: number[] })
              .titleTypingSamples.length,
        ),
      )
      .toBe(" Keep my draft.".length);
    const delays = await page.evaluate(
      () =>
        (window as unknown as { titleTypingSamples: number[] })
          .titleTypingSamples,
    );
    expect(Math.max(...delays)).toBeLessThan(100);
    await expect(footerInfo).toHaveCount(0);
    await header.getByRole("button", { name: "Session options" }).click();
    await page
      .getByRole("menuitem", { name: "Session info", exact: true })
      .click();
    const info = page.getByRole("dialog");
    await expect(info.locator(".modal-title")).toHaveText("Session Info");
    await expect(
      info.getByRole("tab", { name: "Session Info" }),
    ).toHaveAttribute("aria-selected", "true");
    const titleSection = info.getByRole("region", { name: "Session title" });
    await expect(
      titleSection.getByText(fullTitle, { exact: true }),
    ).toBeVisible();
    await titleSection.getByRole("button", { name: "Copy title" }).click();
    await expect(titleSection.getByRole("status")).toHaveText("Title copied");
    await recordUiCapture(page, `session-info-title-${size.width}`);
    await page.keyboard.press("Escape");
    await expect(info).toHaveCount(0);
    await expect(input).toHaveValue(draft);
  }

  // A stopped session has no process stream to supply its identity.
  live = false;
  await page.reload();
  await header.getByRole("button", { name: "Session options" }).click();
  await page
    .getByRole("menuitem", { name: "Session info", exact: true })
    .click();
  await expect(
    page.getByRole("region", { name: "Session title" }).getByText(fullTitle),
  ).toBeVisible();
});
