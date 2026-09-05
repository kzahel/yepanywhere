import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  decodeJsonFrame,
  type RemoteClientMessage,
} from "@yep-anywhere/shared";
import { createServer } from "vite";
import { e2ePaths, expect, test } from "./fixtures.js";

test.use({ serviceWorkers: "block" });

test("warns before compacting an active Codex turn and enables it when idle", async ({
  page,
  baseURL,
}) => {
  test.setTimeout(120_000);
  const projectId = Buffer.from(join(e2ePaths.tempDir, "mockproject")).toString(
    "base64url",
  );
  const sessionId = "mock-session-001";
  const sessionPath = `/api/projects/${projectId}/sessions/${sessionId}`;
  const messagePath = `/api/sessions/${sessionId}/messages`;
  const warning = "Unavailable until this turn finishes, including tool waits.";
  const commands = [
    {
      name: "compact",
      description: "Compact conversation context",
      invocation: { kind: "native", prefix: "/" },
    },
  ];
  let state = "in-turn";
  let compactRequests = 0;
  let publishState: (() => void) | undefined;

  await page.route(
    (url) => url.pathname.startsWith(sessionPath),
    async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      await route.fulfill({
        response,
        json: {
          ...body,
          session: { ...body.session, provider: "codex", model: "gpt-6-astra" },
          ownership: { owner: "self", processId: "compact-ui-process" },
          processState: state,
          slashCommands: commands,
        },
      });
    },
  );
  await page.route(
    (url) => url.pathname === messagePath,
    async (route) => {
      compactRequests += 1;
      await route.fulfill({
        json: { queued: true, serverTimestamp: Date.now() },
      });
    },
  );
  await page.route(
    (url) => url.pathname === "/api/onboarding",
    async (route) => {
      await route.fulfill({ json: { complete: true } });
    },
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
        const sendEvent = (eventType: string) =>
          socket.send(
            JSON.stringify({
              type: "event",
              subscriptionId: payload.subscriptionId,
              eventType,
              eventId: `compact-${state}`,
              data: {
                sessionId,
                state,
                permissionMode: "default",
                modeVersion: 0,
              },
            }),
          );
        publishState = () => sendEvent("status");
        sendEvent("connected");
        return;
      }
      upstream.send(message);
    });
  });

  const devServer = await createServer({
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
    await devServer.listen();
    const address = devServer.httpServer?.address();
    if (!address || typeof address === "string")
      throw new Error("Missing dev-server port");
    const url = `http://127.0.0.1:${address.port}/projects/${projectId}/sessions/${sessionId}`;
    const captureDir = process.env.YEP_E2E_UI_CAPTURE_DIR;
    if (captureDir) mkdirSync(captureDir, { recursive: true });

    for (const viewport of [
      { name: "desktop", width: 1000, height: 600 },
      { name: "phone", width: 375, height: 812 },
    ]) {
      state = "in-turn";
      await page.setViewportSize(viewport);
      await page.goto(url);
      const composer = page.locator("[data-composer-input]");
      await expect(composer).toBeVisible({ timeout: 30_000 });
      await composer.fill("/comp");
      await expect(
        page.getByRole("menuitem", { name: "/compact" }),
      ).toContainText(warning);
      if (captureDir)
        await page.screenshot({
          path: join(captureDir, `${viewport.name}-autocomplete.png`),
        });

      await composer.fill("");
      await page
        .locator(".session-header")
        .getByRole("button", { name: "Session options" })
        .click();
      const compact = page.getByRole("button", {
        name: "Compact (turn active)",
      });
      await expect(compact).toBeDisabled();
      await expect(compact).toHaveAttribute("data-tooltip", warning);
      if (captureDir)
        await page.screenshot({
          path: join(captureDir, `${viewport.name}-menu.png`),
        });
      await page
        .locator(".session-header")
        .getByRole("button", { name: "Session options" })
        .click();
      await composer.fill("/compact");
      await composer.press("Enter");
      await expect(page.getByRole("alert")).toContainText(warning);
      expect(compactRequests).toBe(0);
      await page.getByRole("alert").click();
    }

    state = "idle";
    expect(publishState).toBeDefined();
    publishState?.();
    const composer = page.locator("[data-composer-input]");
    await composer.fill("/comp");
    await expect(
      page.getByRole("menuitem", { name: "/compact" }),
    ).toContainText("Compact conversation context");
    await composer.fill("");
    await page
      .locator(".session-header")
      .getByRole("button", { name: "Session options" })
      .click();
    await page.getByRole("button", { name: "Compact", exact: true }).click();
    await expect.poll(() => compactRequests).toBe(1);
  } finally {
    await page.close();
    await devServer.close();
  }
});
