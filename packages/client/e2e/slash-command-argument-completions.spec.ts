import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";
import {
  decodeJsonFrame,
  type RemoteClientMessage,
} from "@yep-anywhere/shared";
import { createServer, type ViteDevServer } from "vite";
import { e2ePaths, expect, test } from "./fixtures.js";

const mockProjectPath = join(e2ePaths.tempDir, "mockproject");
const projectId = Buffer.from(mockProjectPath).toString("base64url");
const sessionId = "mock-session-001";
const objective = "Keep goal changes visible during work and after reload";

test.use({ serviceWorkers: "block" });

let devServer: ViteDevServer;
let devUrl: string;
test.beforeEach(async ({ baseURL }) => {
  devServer = await createServer({
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
  await devServer.listen();
  const address = devServer.httpServer?.address();
  if (!address || typeof address === "string")
    throw new Error("Missing dev-server port");
  devUrl = `http://127.0.0.1:${address.port}`;
});
test.afterEach(async ({ page }) => {
  await page.close();
  await devServer?.close();
});

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

async function capture(page: Page, name: string) {
  const directory = process.env.YEP_E2E_UI_CAPTURE_DIR;
  if (!directory) return;
  mkdirSync(directory, { recursive: true });
  await page.waitForTimeout(1_000);
  await page.screenshot({ path: join(directory, name) });
}

async function captureMenu(page: Page, name: string) {
  const directory = process.env.YEP_E2E_UI_CAPTURE_DIR;
  if (!directory) return;
  mkdirSync(directory, { recursive: true });
  await page.getByRole("menu").screenshot({ path: join(directory, name) });
}

test("shows provider-owned slash hints and argument completions", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.route(
    (url) =>
      url.pathname === `/api/projects/${projectId}/sessions/${sessionId}`,
    async (route) => {
      const response = await route.fetch();
      const body = (await response.json()) as Record<string, unknown>;
      await route.fulfill({
        response,
        json: {
          ...body,
          messages: [
            ...(body.messages as Record<string, unknown>[]),
            {
              id: "saved-goal",
              uuid: "saved-goal",
              type: "system",
              subtype: "local_command",
              content: "/goal",
              details: [objective, "Goal set"],
              timestamp: new Date().toISOString(),
              isSynthetic: true,
            },
          ],
          slashCommands: [
            {
              name: "goal",
              description:
                "Keep working toward a verifiable end state until it is met",
              argumentHint: "<verifiable end state>",
              providerDetails: { codex: { goalObjective: objective } },
              argumentCompletions: [
                { value: objective, description: "Current goal" },
                { value: "clear", description: "Remove the current goal" },
                { value: "pause", description: "Pause the current goal" },
                { value: "resume", description: "Resume the current goal" },
              ],
              invocation: { kind: "native", prefix: "/" },
            },
          ],
        },
      });
    },
  );

  await page.setViewportSize({ width: 1000, height: 600 });
  await page.goto(`${devUrl}/projects/${projectId}/sessions/${sessionId}`);
  await dismissOnboardingIfVisible(page);

  const composer = page.locator("[data-composer-input]");
  await expect(composer).toBeVisible({ timeout: 10_000 });
  await expect(
    page.getByText("Previous message", { exact: true }).last(),
  ).toBeVisible();
  await expect(page.getByText(objective, { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: `Current goal: ${objective}` }),
  ).toBeVisible();
  await capture(page, "goal-marker-desktop-1000x600.png");
  const flag = page.getByRole("button", { name: `Current goal: ${objective}` });
  await expect(flag).not.toHaveAttribute("data-goal-status");
  await flag.click();
  await expect(composer).toHaveValue("");
  await composer.hover();
  await composer.fill("   ");
  await page.waitForTimeout(150); // Let the typing tooltip suppression expire.
  await flag.hover();
  await expect(page.getByRole("tooltip")).toBeVisible();
  await flag.click({ button: "right" });
  await expect(composer).toHaveValue(`/goal ${objective}`);
  await expect(composer).toBeFocused();
  await expect(page.getByRole("tooltip")).toBeVisible();
  await composer.fill("Keep this draft");
  await flag.click({ button: "right" });
  await expect(composer).toHaveValue("Keep this draft");
  await composer.fill("/goal");
  await expect(
    page.getByRole("menuitem", { name: `/goal ${objective}`, exact: true }),
  ).toBeVisible();
  await capture(page, "goal-current-desktop-1000x600.png");
  await composer.press("Tab");
  await expect(composer).toHaveValue(`/goal ${objective} `);
  await composer.fill("/go");
  const goalCommand = page.getByRole("menuitem", { name: "/goal" });
  await expect(goalCommand).toContainText("<verifiable end state>");
  await expect(goalCommand).toContainText(
    "Keep working toward a verifiable end state until it is met",
  );
  await capture(page, "goal-hint-desktop-1000x600.png");

  await page.reload();
  await dismissOnboardingIfVisible(page);
  await expect(composer).toBeVisible({ timeout: 10_000 });
  await expect(
    page.getByText("Previous message", { exact: true }).last(),
  ).toBeVisible();
  await composer.fill("/goal ");
  await expect(
    page.getByRole("menuitem", { name: "/goal clear" }),
  ).toBeVisible();
  await expect(page.getByText("Remove the current goal")).toBeVisible();
  await captureMenu(page, "goal-verbs-desktop-1000x600.png");

  await page.setViewportSize({ width: 375, height: 812 });
  await page.reload();
  await dismissOnboardingIfVisible(page);
  await expect(composer).toBeVisible({ timeout: 10_000 });
  await expect(
    page.getByText("Previous message", { exact: true }).last(),
  ).toBeVisible();
  await composer.fill("");
  await expect(page.getByText(objective, { exact: true })).toBeVisible();
  await capture(page, "goal-marker-mobile-375x812.png");
  await composer.fill("/goal");
  await capture(page, "goal-current-mobile-375x812.png");
  await page
    .getByRole("button", { name: "Clear composer", exact: true })
    .click();
  await expect(composer).toHaveValue("");
  await expect(composer).toBeFocused();
  await composer.fill("/go");
  await expect(goalCommand).toContainText("<verifiable end state>");
  await capture(page, "goal-hint-mobile-375x812.png");

  await page.reload();
  await dismissOnboardingIfVisible(page);
  await expect(composer).toBeVisible({ timeout: 10_000 });
  await expect(
    page.getByText("Previous message", { exact: true }).last(),
  ).toBeVisible();
  await composer.fill("/goal ");
  await expect(
    page.getByRole("menuitem", { name: "/goal resume" }),
  ).toBeVisible();
  await captureMenu(page, "goal-verbs-mobile-375x812.png");

  await composer.fill("/go");
  await composer.press("Enter");
  await expect(composer).toHaveValue("/goal ");
});

test("restarts the provider only after verified stop and reloads saved turns", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const requests: string[] = [];
  let refuseStop = true;
  let restarted = false;
  let reads = 0;
  await page.route(
    (url) =>
      url.pathname === `/api/projects/${projectId}/sessions/${sessionId}`,
    async (route) => {
      reads += 1;
      const response = await route.fetch();
      const body = await response.json();
      await route.fulfill({
        response,
        json: {
          ...body,
          ownership: {
            owner: "self",
            processId: restarted ? "new-worker" : "old-worker",
          },
          processState: "idle",
          messages: [
            ...body.messages,
            ...(restarted
              ? [
                  {
                    id: "tui-turn",
                    uuid: "tui-turn",
                    type: "user",
                    message: { role: "user", content: "Turn saved by the TUI" },
                    timestamp: new Date().toISOString(),
                  },
                ]
              : []),
          ],
        },
      });
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
        socket.send(
          JSON.stringify({
            type: "event",
            subscriptionId: payload.subscriptionId,
            eventType: "connected",
            data: {
              sessionId,
              state: "idle",
              permissionMode: "default",
              modeVersion: 0,
            },
          }),
        );
      } else upstream.send(message);
    });
  });
  await page.route("**/api/processes/old-worker/abort", async (route) => {
    requests.push("stop");
    expect(route.request().postDataJSON()).toBeNull();
    await route.fulfill(
      refuseStop
        ? { status: 409, json: { error: "Could not verify process stopped" } }
        : { json: { aborted: true, verifiedStopped: true } },
    );
  });
  await page.route(
    `**/api/projects/${projectId}/sessions/${sessionId}/reactivate`,
    async (route) => {
      requests.push("activate");
      expect(route.request().postDataJSON()).toEqual({});
      restarted = true;
      await route.fulfill({
        json: {
          processId: "new-worker",
          permissionMode: "default",
          modeVersion: 0,
        },
      });
    },
  );
  await page.setViewportSize({ width: 1000, height: 600 });
  await page.goto(`${devUrl}/projects/${projectId}/sessions/${sessionId}`);
  const composer = page.locator("[data-composer-input]");
  await expect(composer).toBeVisible({ timeout: 30_000 });
  await composer.fill("Preserve my draft");
  const menu = page
    .locator(".session-header")
    .getByRole("button", { name: "Session options" });
  await menu.click();
  await capture(page, "restart-provider-desktop-1000x600.png");
  await page
    .getByRole("button", { name: "Restart provider", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText(
    "Could not verify process stopped",
  );
  expect(requests).toEqual(["stop"]);
  refuseStop = false;
  const before = reads;
  await page.setViewportSize({ width: 375, height: 812 });
  await menu.click();
  await capture(page, "restart-provider-mobile-375x812.png");
  await page
    .getByRole("button", { name: "Restart provider", exact: true })
    .click();
  await expect(
    page.getByText("Turn saved by the TUI", { exact: true }),
  ).toBeVisible();
  await expect(composer).toHaveValue("Preserve my draft");
  expect(reads).toBeGreaterThan(before);
  expect(requests).toEqual(["stop", "stop", "activate"]);
});

test("toggles the observed goal during work without consuming the draft", async ({
  page,
}) => {
  test.setTimeout(120_000);
  let goalStatus = "active";
  const sent: string[] = [];
  let publish:
    | ((eventType: string, data: Record<string, unknown>) => void)
    | undefined;
  const commands = () => [
    {
      name: "goal",
      description: "Keep working toward a verifiable end state until it is met",
      providerDetails: { codex: { goalObjective: objective, goalStatus } },
      invocation: { kind: "native", prefix: "/" },
    },
  ];
  await page.route(
    (url) =>
      url.pathname === `/api/projects/${projectId}/sessions/${sessionId}`,
    async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      await route.fulfill({
        response,
        json: {
          ...body,
          ownership: { owner: "self", processId: "goal-worker" },
          processState: "in-turn",
          slashCommands: commands(),
        },
      });
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
        publish = (eventType, data) =>
          socket.send(
            JSON.stringify({
              type: "event",
              subscriptionId: payload.subscriptionId,
              eventType,
              data,
            }),
          );
        publish("connected", {
          sessionId,
          state: "in-turn",
          permissionMode: "default",
          modeVersion: 0,
        });
      } else upstream.send(message);
    });
  });
  await page.route(`**/api/sessions/${sessionId}/messages`, async (route) => {
    const body = route.request().postDataJSON();
    sent.push(body.message);
    expect(body.attachments ?? []).toEqual([]);
    if (body.message === "/goal pause") goalStatus = "paused";
    if (body.message === "/goal resume") goalStatus = "active";
    expect(publish).toBeDefined();
    publish?.("message", {
      type: "system",
      subtype: "commands_changed",
      uuid: `status-${sent.length}`,
      slash_command_inventory: commands(),
    });
    publish?.("message", {
      type: "system",
      subtype: "local_command",
      uuid: `receipt-${sent.length}`,
      content: "/goal",
      details: [objective, `Goal ${goalStatus}`],
      tempId: body.tempId,
    });
    await route.fulfill({ json: { queued: true } });
  });
  await page.setViewportSize({ width: 1000, height: 600 });
  await page.goto(`${devUrl}/projects/${projectId}/sessions/${sessionId}`);
  const composer = page.locator("[data-composer-input]");
  const flag = page.getByRole("button", { name: `Current goal: ${objective}` });
  await expect(flag).toHaveAttribute("data-goal-status", "active");
  await expect.poll(() => !!publish).toBe(true);
  await composer.fill("Keep this draft while the agent works");
  await page.waitForTimeout(150);
  await flag.hover();
  await expect(page.getByRole("tooltip")).toContainText("Goal: Active");
  await capture(page, "goal-active-desktop-1000x600.png");
  await flag.click();
  await expect(flag).toHaveAttribute("data-goal-status", "paused");
  await expect(composer).toHaveValue("Keep this draft while the agent works");
  expect(sent).toEqual(["/goal pause"]);
  await page.reload();
  await expect(flag).toHaveAttribute("data-goal-status", "paused");
  await page.setViewportSize({ width: 375, height: 812 });
  await flag.hover();
  await expect(page.getByRole("tooltip")).toContainText("Goal: Paused");
  await capture(page, "goal-paused-mobile-375x812.png");
  await flag.click();
  await expect(flag).toHaveAttribute("data-goal-status", "active");
  await expect(composer).toHaveValue("Keep this draft while the agent works");
  expect(sent).toEqual(["/goal pause", "/goal resume"]);
  publish?.("status", { state: "idle" });
  await composer.fill("");
  await expect(
    page.getByRole("button", { name: "Stop", exact: true }),
  ).not.toBeVisible();
  await composer.fill(`/goal ${objective}`);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => sent.length).toBe(3);
  expect(sent[2]).toBe(`/goal ${objective}`);
  await expect(composer).toHaveValue("");
  await expect(
    page.getByRole("button", { name: "Stop", exact: true }),
  ).not.toBeVisible();
});
