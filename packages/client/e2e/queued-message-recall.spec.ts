import { join } from "node:path";
import type { Page } from "@playwright/test";
import {
  decodeJsonFrame,
  type RemoteClientMessage,
} from "@yep-anywhere/shared";
import { e2ePaths, expect, test } from "./fixtures.js";
import { recordUiCapture } from "./support/ui-capture.js";

const projectId = Buffer.from(join(e2ePaths.tempDir, "mockproject")).toString(
  "base64url",
);
const sessionId = "mock-session-001";

test.use({ serviceWorkers: "block" });

async function dismissOnboardingIfVisible(page: Page) {
  const dialog = page.getByText("Welcome to yepanywhere");
  const appeared = await dialog
    .waitFor({ state: "visible", timeout: 2_000 })
    .then(() => true)
    .catch(() => false);
  if (!appeared) return;
  await page.getByRole("button", { name: "Skip all" }).click({ force: true });
  await expect(dialog).not.toBeVisible();
}

// Queuing leaves focus in the emptied composer, so ↑ is easily pressed to
// scroll. It must not take a still-queued message back out of the queue
// (topics/queued-messages.md).
test("↑ in the emptied composer leaves a queued message queued", async ({
  page,
  baseURL,
}) => {
  const queuedText = "Run the remaining checks after this turn.";
  const deferredMessages: Record<string, unknown>[] = [];
  const cancels: string[] = [];
  let promote = false;
  await page.addInitScript(() => {
    localStorage.setItem("yep-anywhere-session-dom-linger-enabled", "true");
  });

  await page.route(
    (url) =>
      url.pathname === `/api/projects/${projectId}/sessions/${sessionId}`,
    async (route) => {
      if (route.request().method() !== "GET") return route.fallback();
      // This fixture read hit ECONNRESET before the UI actions in CI 45682088384.
      const response = await route.fetch({ maxRetries: 1 });
      const body = await response.json();
      await route.fulfill({
        response,
        json: {
          ...body,
          ownership: { owner: "self", processId: "recall-process" },
          processState: "in-turn",
        },
      });
    },
  );
  await page.route(`**/api/sessions/${sessionId}/messages`, async (route) => {
    const body = route.request().postDataJSON();
    expect(body.deferred).toBe(true);
    deferredMessages.push({
      tempId: body.tempId,
      content: body.message,
      timestamp: new Date().toISOString(),
      kind: "deferred",
    });
    await route.fulfill({
      json: {
        queued: true,
        deferred: !promote,
        deferredMessages,
        serverTimestamp: Date.now(),
      },
    });
  });
  await page.route(`**/api/sessions/${sessionId}/deferred/**`, (route) => {
    cancels.push(route.request().url());
    return route.fulfill({ json: { cancelled: true } });
  });
  await page.routeWebSocket("**/api/ws", (socket) => {
    const upstream = socket.connectToServer();
    socket.onMessage((message) => {
      const payload =
        typeof message === "string"
          ? (JSON.parse(message) as RemoteClientMessage)
          : decodeJsonFrame<RemoteClientMessage>(message);
      if (
        payload.type === "subscribe" &&
        payload.channel === "session" &&
        payload.sessionId === sessionId
      ) {
        socket.send(
          JSON.stringify({
            type: "event",
            subscriptionId: payload.subscriptionId,
            eventType: "connected",
            eventId: "recall-connected",
            data: {
              sessionId,
              state: "in-turn",
              permissionMode: "default",
              modeVersion: 1,
              deferredMessages,
            },
          }),
        );
        return;
      }
      upstream.send(message);
    });
  });

  await page.goto(`${baseURL}/projects/${projectId}/sessions/${sessionId}`);
  await dismissOnboardingIfVisible(page);
  const composer = page.locator("[data-composer-input]");
  await expect(composer).toBeVisible({ timeout: 30_000 });
  await composer.fill(queuedText);
  await composer.press("Control+Enter");

  const chip = page.getByText(queuedText, { exact: true });
  await expect(chip).toBeVisible();
  await expect(composer).toHaveValue("");
  await expect(composer).toBeFocused();

  await composer.press("ArrowUp");
  await composer.press("Control+p");

  await expect(composer).toHaveValue("");
  await expect(chip).toBeVisible();
  expect(cancels).toEqual([]);

  // Once delivered, recall is a reversible edit, including over a new draft.
  promote = true;
  await composer.fill("A delivered message");
  await Promise.all([
    page.waitForResponse((response) =>
      response.url().endsWith(`/api/sessions/${sessionId}/messages`),
    ),
    composer.press("Control+Enter"),
  ]);
  await expect(composer).toHaveValue("");
  // The composer clears at submit, and Playwright can see the response before
  // the app has recorded the delivery. Until then the last submission is the
  // queued message, which ↑ leaves alone (checked above), so pressing again
  // is what a user would do.
  await expect(async () => {
    await composer.press("ArrowUp");
    await expect(composer).toHaveValue("A delivered message", {
      timeout: 500,
    });
  }).toPass();
  const back = page.getByRole("button", { name: "Cancel correction" });
  await expect(back).toHaveText("Back to new message ↓");
  for (const viewport of [
    { width: 1200, height: 600 },
    { width: 375, height: 812 },
  ]) {
    await page.setViewportSize(viewport);
    await recordUiCapture(page, `correction-${viewport.width}`, viewport);
  }
  await composer.press("ArrowDown");
  await expect(composer).toHaveValue("");
  await expect(back).not.toBeVisible();

  await composer.pressSequentially("Keep this new draft", { delay: 20 });
  await composer.press("Control+p");
  await expect(composer).toHaveValue("A delivered message");
  await back.click();
  await expect(composer).toHaveValue("Keep this new draft");

  await composer.fill("");
  await composer.press("ArrowUp");
  await composer.press("ArrowLeft");
  await composer.press("End");
  await composer.press("ArrowDown");
  await expect(composer).toHaveValue("A delivered message");
  await composer.press("Escape");
  await expect(composer).toHaveValue("");

  // A cached session must not bring an untouched keyboard recall back.
  await composer.press("ArrowUp");
  await expect(back).toBeVisible();
  await page.getByRole("link", { name: "mockproject", exact: true }).click();
  await expect(composer).toHaveValue("");
  await page.goBack();
  await expect(composer).toHaveValue("");
  await expect(back).not.toBeVisible();

  await composer.press("ArrowUp");
  await composer.pressSequentially(" with a correction", { delay: 20 });
  await Promise.all([
    page.waitForResponse((response) =>
      response.url().endsWith(`/api/sessions/${sessionId}/messages`),
    ),
    composer.press("Control+Enter"),
  ]);
  await expect(composer).toHaveValue("");
  await expect(back).not.toBeVisible();
});
