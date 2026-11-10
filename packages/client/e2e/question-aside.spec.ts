import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  decodeJsonFrame,
  type RemoteClientMessage,
} from "@yep-anywhere/shared";
import { createTestViteServer as createServer } from "./support/vite-server";
import { e2ePaths, expect, test } from "./fixtures.js";
import { recordUiCapture } from "./support/ui-capture.js";

test.use({ serviceWorkers: "block" });

test("question cards use existing forks, keep main typing, and save on empty", async ({
  page,
  baseURL,
}) => {
  test.setTimeout(120000);
  const projectId = Buffer.from(join(e2ePaths.tempDir, "mockproject")).toString(
    "base64url",
  );
  const sessionId = "mock-session-001";
  const parentPath = `/api/projects/${projectId}/sessions/${sessionId}`;
  const childId = "question-aside-child";
  const childPath = `/api/projects/${projectId}/sessions/${childId}`;
  let questionPrompt = "";
  let followupPrompt = "";
  let childResumes = 0;
  let childParentId: string | undefined;
  let native = true;
  let busy = true;
  let forks = 0;
  let nativeSaves = 0;
  let ordinarySaves = 0;
  let archived = false;
  let failStartup = false;
  const steers: Record<string, unknown>[] = [];
  let publishState: (() => void) | undefined;
  const deferredMessages = [
    {
      id: "queued-main-message",
      content: "Then summarize the results.",
      timestamp: new Date().toISOString(),
      kind: "deferred",
    },
  ];

  await page.addInitScript(() =>
    localStorage.setItem("yep-anywhere-question-asides", "true"),
  );
  await page.route(
    (url) => url.pathname === "/api/version",
    async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      await route.fulfill({
        response,
        json: {
          ...body,
          ...(native
            ? {}
            : { current: "0.8.1", deniedCapabilityBits: [[1, 2 ** 25]] }),
        },
      });
    },
  );
  await page.route(
    (url) => url.pathname.startsWith(parentPath),
    async (route) => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname.endsWith("/clone")) {
        forks += 1;
        followupPrompt = "";
        childParentId = undefined;
        return route.fulfill({
          json: {
            sessionId: childId,
            messageCount: 1,
            clonedFrom: sessionId,
            provider: "codex",
          },
        });
      }
      if (pathname.endsWith("/conversation-context")) {
        nativeSaves += 1;
        expect(route.request().postDataJSON().turns).toEqual(
          expect.arrayContaining([
            { role: "user", text: "Why is this still running?" },
            {
              role: "assistant",
              text: "The main agent is still running its checks. Saving this answer keeps that context available.",
            },
          ]),
        );
        return route.fulfill({ json: { delivery: "native-history" } });
      }
      if (pathname.endsWith("/reactivate") || pathname.endsWith("/resume")) {
        if (pathname.endsWith("/resume")) ordinarySaves += 1;
        return route.fulfill({
          json: {
            processId: "aside-parent-process",
            permissionMode: "default",
            modeVersion: 1,
            serverTimestamp: Date.now(),
          },
        });
      }
      const response = await route.fetch();
      const body = await response.json();
      return route.fulfill({
        response,
        json: {
          ...body,
          session: { ...body.session, provider: "codex", model: "gpt-6-astra" },
          messages: Array.from({ length: 12 }, (_, index) => ({
            id: `main-${index}`,
            uuid: `main-${index}`,
            type: index % 2 ? "assistant" : "user",
            content:
              index === 11
                ? "Latest live activity: checking the remaining changes."
                : `Check ${index + 1}: review the changes and report progress.`,
          })),
          ownership: { owner: "self", processId: "aside-parent-process" },
          processState: busy ? "in-turn" : "idle",
          deferredMessages,
        },
      });
    },
  );
  await page.route(
    (url) => url.pathname.startsWith(childPath),
    async (route) => {
      if (route.request().method() === "POST") {
        childResumes += 1;
        const prompt = route.request().postDataJSON().message as string;
        if (prompt.startsWith("[YA question aside ")) questionPrompt = prompt;
        else followupPrompt = prompt;
        if (failStartup)
          return route.fulfill({
            status: 503,
            json: {
              error:
                "Provider session startup did not settle: Provider session completed before reporting a session id",
            },
          });
        return route.fulfill({
          json: {
            processId: "aside-child-process",
            permissionMode: "default",
            modeVersion: 1,
            serverTimestamp: Date.now(),
          },
        });
      }
      return route.fulfill({
        json: {
          session: {
            id: childId,
            projectId,
            provider: "codex",
            title: childParentId
              ? "/btw Why is this still running?"
              : "Quick answer",
            isArchived: archived,
            parentSessionId: childParentId,
          },
          ownership: { owner: "none" },
          messages: [
            {
              id: "question",
              uuid: "question",
              type: "user",
              content: questionPrompt,
            },
            {
              id: "answer",
              uuid: "answer",
              type: "assistant",
              content:
                "The main agent is still running its checks. Saving this answer keeps that context available.",
            },
            ...(followupPrompt
              ? [
                  { id: "followup", type: "user", content: followupPrompt },
                  {
                    id: "followup-answer",
                    type: "assistant",
                    content:
                      "The same side session can answer another question.",
                  },
                ]
              : []),
          ],
        },
      });
    },
  );
  await page.route(`**/api/sessions/${sessionId}/messages`, async (route) => {
    steers.push(route.request().postDataJSON());
    await route.fulfill({
      json: { queued: true, serverTimestamp: Date.now() },
    });
  });
  await page.route(`**/api/sessions/${childId}/metadata`, async (route) => {
    const body = route.request().postDataJSON();
    archived = body.archived === true;
    childParentId = body.parentSessionId;
    await route.fulfill({ json: { updated: true } });
  });
  await page.route(`**/api/sessions/${childId}/process`, async (route) => {
    await route.fulfill({ json: { process: null } });
  });
  await page.route("**/api/onboarding", (route) =>
    route.fulfill({ json: { complete: true } }),
  );
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
        const sendState = (eventType: string) =>
          socket.send(
            JSON.stringify({
              type: "event",
              subscriptionId: payload.subscriptionId,
              eventType,
              eventId: `question-${busy}`,
              data: {
                sessionId,
                state: busy ? "in-turn" : "idle",
                permissionMode: "default",
                modeVersion: 1,
                deferredMessages,
              },
            }),
          );
        publishState = () => sendState("status");
        sendState("connected");
        return;
      }
      upstream.send(message);
    });
  });

  const server = await createServer({
    configFile: join(
      dirname(fileURLToPath(import.meta.url)),
      "../vite.config.ts",
    ),
    define: { __VITE_DEV_PORT__: "-1" },
    server: {
      port: 0,
      host: "127.0.0.1",
      proxy: { "/api": { target: baseURL, ws: true } },
    },
  });
  try {
    await server.listen();
    const address = server.httpServer?.address();
    if (!address || typeof address === "string")
      throw new Error("Missing Vite port");
    const device = await page.context().newCDPSession(page);
    for (const viewport of [
      { name: "desktop", width: 1000, height: 600 },
      { name: "phone", width: 375, height: 812 },
    ]) {
      native = viewport.name === "desktop";
      busy = true;
      await device.send("Emulation.setTouchEmulationEnabled", {
        enabled: !native,
      });
      await page.setViewportSize(viewport);
      await page.goto(
        `http://127.0.0.1:${address.port}/projects/${projectId}/sessions/${sessionId}`,
      );
      const composer = page.locator("[data-composer-input]");
      await expect(composer).toBeVisible({ timeout: 30000 });
      await expect(
        page.getByText(
          "Latest live activity: checking the remaining changes.",
          { exact: true },
        ),
      ).toBeVisible({ timeout: 30000 });
      await composer.fill("Why is this still running?");
      const hint = page.getByText(
        `${native ? "Enter" : "Send"}: quick answer · Space: keep typing`,
      );
      await expect(hint).toBeVisible();
      await recordUiCapture(page, `aside-${viewport.name}-hint`);
      await composer.fill("Why is this still running? ");
      await expect(hint).toHaveCount(0);
      await composer.fill("Why is this still running?");
      // Establish the contract's already-following reader before resizing the
      // transcript with a question card.
      await page.locator("main[data-session-messages]").hover();
      await page.mouse.wheel(0, 10000);
      await expect(
        page.getByText("Then summarize the results.", { exact: true }),
      ).toBeInViewport();
      if (native) await composer.press("Enter");
      else
        await page
          .locator(".message-input-wrapper")
          .getByRole("button", { name: "Quick answer", exact: true })
          .click();
      const card = page.getByRole("region", { name: "Quick answer" });
      await expect(card.getByRole("button", { name: "Save Q+A" })).toBeEnabled({
        timeout: 15000,
      });
      expect(archived).toBe(true);
      await expect(composer).toHaveValue("");
      await composer.fill("My next main message");
      await expect(card).toBeVisible();
      await composer.fill("");
      await expect(card.getByRole("heading")).toHaveCount(0);
      const queue = page.getByText("Then summarize the results.", {
        exact: true,
      });
      await expect(queue).toBeVisible();
      await expect(queue).toBeInViewport();
      const queueBox = await queue.boundingBox();
      const cardBox = await card.boundingBox();
      const composerBox = await composer.boundingBox();
      expect(queueBox!.y + queueBox!.height).toBeLessThanOrEqual(cardBox!.y);
      expect(cardBox!.y + cardBox!.height).toBeLessThan(composerBox!.y);
      await expect(queue).toBeInViewport();
      await expect
        .poll(() =>
          page
            .locator("main[data-session-messages]")
            .evaluate(
              (element) =>
                element.scrollHeight - element.scrollTop - element.clientHeight,
            ),
        )
        .toBeLessThan(3);
      await recordUiCapture(page, `aside-${viewport.name}-answer`);
      const help = card.getByRole("button", {
        name: "Quick answer",
        exact: true,
      });
      await help.click();
      // The help is a Popover, portalled out of the card.
      await expect(
        page.locator(`[id="${await help.getAttribute("aria-controls")}"]`),
      ).toBeVisible();
      await card
        .getByRole("button", { name: "Quick answer", exact: true })
        .click();
      if (native) await composer.press("Enter");
      else
        await page
          .locator(".message-input-wrapper")
          .getByRole("button", { name: "Save Q+A", exact: true })
          .click();
      await expect(card).toHaveCount(0);
      failStartup = true;
      const question = "  Why did the question fail?";
      await composer.fill(question);
      if (native) await composer.press("Enter");
      else
        await page
          .locator(".message-input-wrapper")
          .getByRole("button", { name: "Quick answer", exact: true })
          .click();
      await expect(card.getByRole("alert")).toContainText(
        "Provider session startup did not settle",
      );
      await expect(card.getByRole("button", { name: "Save Q+A" })).toHaveCount(
        0,
      );
      const steer = card.getByRole("button", { name: "Steer", exact: true });
      await expect(steer).toBeEnabled();
      await composer.fill("Keep my separate main draft");
      await recordUiCapture(page, `aside-${viewport.name}-failed`);
      await steer.click();
      await expect(card).toHaveCount(0);
      await expect(composer).toHaveValue("Keep my separate main draft");
      expect(steers.at(-1)?.message).toBe(question);
      expect(steers.at(-1)?.attachments).toBeUndefined();
      expect(steers.at(-1)?.deferred).toBeUndefined();
      await composer.fill("");
      failStartup = false;
      await composer.fill("Why is this still running?");
      if (native) await composer.press("Enter");
      else
        await page
          .locator(".message-input-wrapper")
          .getByRole("button", { name: "Quick answer", exact: true })
          .click();
      await expect(
        card.getByRole("button", { name: "Continue /btw" }),
      ).toBeEnabled({ timeout: 15000 });
      const motherDraft = "Preserve this separate parent draft";
      await composer.fill(motherDraft);
      const forksBeforeMove = forks;
      const resumesBeforeMove = childResumes;
      await card.getByRole("button", { name: "Continue /btw" }).click();
      await expect(card).toHaveCount(0);
      await expect(page).toHaveURL(new RegExp(`btw=${childId}`));
      await expect(
        page
          .getByText(
            "The main agent is still running its checks. Saving this answer keeps that context available.",
            { exact: true },
          )
          .last(),
      ).toBeVisible();
      expect(archived).toBe(false);
      expect(childParentId).toBe(sessionId);
      expect(forks).toBe(forksBeforeMove);
      expect(childResumes).toBe(resumesBeforeMove);
      await composer.fill("Can I ask another question?");
      if (native) await composer.press("Enter");
      else
        await page
          .locator(".message-input-wrapper")
          .getByRole("button", { name: "Send", exact: true })
          .click();
      await expect
        .poll(() => followupPrompt)
        .toContain("[Side request]\nCan I ask another question?");
      await expect(
        page
          .getByText("The same side session can answer another question.", {
            exact: true,
          })
          .last(),
      ).toBeVisible({ timeout: 15000 });
      expect(forks).toBe(forksBeforeMove);
      expect(childResumes).toBe(resumesBeforeMove + 1);
      expect(followupPrompt).toContain(
        "one-question-only limit no longer applies",
      );
      await recordUiCapture(page, `aside-${viewport.name}-continued`);
      await expect(composer).toHaveAttribute("placeholder", "/btw follow-up");
      const resumesBeforeClose = childResumes;
      const promptBeforeClose = followupPrompt;
      await composer.fill("/done summary");
      if (native) await composer.press("Enter");
      else
        await page
          .locator(".message-input-wrapper")
          .getByRole("button", { name: "Send", exact: true })
          .click();
      await expect(composer).not.toHaveAttribute(
        "placeholder",
        "/btw follow-up",
      );
      await expect(composer).toHaveValue(motherDraft);
      await expect(page.getByText(/Report-back drafting/)).toHaveCount(0);
      expect(childResumes).toBe(resumesBeforeClose);
      expect(followupPrompt).toBe(promptBeforeClose);
      await recordUiCapture(page, `aside-${viewport.name}-closed`);
    }
    expect(forks).toBe(6);
    expect(steers).toHaveLength(2);
    expect(nativeSaves).toBe(1);
    expect(ordinarySaves).toBe(1);
    busy = false;
    publishState?.();
    await page.locator("[data-composer-input]").fill("Idle question?");
    await expect(
      page.getByText("Send: quick answer · Space: keep typing"),
    ).toHaveCount(0);
    for (const viewport of [
      { name: "desktop", width: 1000, height: 600 },
      { name: "phone", width: 375, height: 812 },
    ]) {
      await page.setViewportSize(viewport);
      await page.goto(
        `http://127.0.0.1:${address.port}/settings/message-delivery`,
      );
      const warning = page.getByText(
        /100% of measured Codex quick-answer forks/,
      );
      await expect(warning).toBeVisible();
      await warning.scrollIntoViewIfNeeded();
      await recordUiCapture(page, `aside-${viewport.name}-setting`);
    }
  } finally {
    await page.close();
    await server.close();
  }
});
