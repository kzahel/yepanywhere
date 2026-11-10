import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import {
  decodeJsonFrame,
  type RemoteClientMessage,
} from "@yep-anywhere/shared";
import { e2ePaths, expect, test } from "./fixtures.js";
import { recordUiCapture } from "./support/ui-capture.js";

const mockProjectPath = join(e2ePaths.tempDir, "mockproject");
const projectId = Buffer.from(mockProjectPath).toString("base64url");
const sessionId = "mock-session-001";
const objective = "Keep goal changes visible during work and after reload";

test.use({ serviceWorkers: "block" });

// Provider controls use the invocation's built client. Cold Vite imports in
// CI 40760723114 consumed 9.6 s before session acquisition even began.
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
  baseURL,
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
  await page.goto(`${baseURL}/projects/${projectId}/sessions/${sessionId}`);
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
  await expect(
    page.getByRole("dialog", { name: "Current goal", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(flag).toBeFocused();
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
  baseURL,
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
      const after = new URL(route.request().url()).searchParams.get(
        "afterMessageId",
      );
      // The real server cannot resolve the synthetic turn cursor. Fetch its
      // actual snapshot, then provide a coherent fixture-owned incremental read.
      const response = await route.fetch({
        url:
          after === "tui-turn"
            ? route.request().url().split("?")[0]
            : route.request().url(),
      });
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
          messages:
            after === "tui-turn"
              ? []
              : [
                  ...body.messages,
                  ...(restarted
                    ? [
                        {
                          id: "tui-turn",
                          uuid: "tui-turn",
                          parentUuid: "1",
                          type: "user",
                          message: {
                            role: "user",
                            content: "Turn saved by the TUI",
                          },
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
  await page.goto(`${baseURL}/projects/${projectId}/sessions/${sessionId}`);
  const composer = page.locator("[data-composer-input]");
  await expect(composer).toBeVisible({ timeout: 30_000 });
  await composer.fill("Preserve my draft");
  const menu = page
    .locator("[data-session-header]")
    .getByRole("button", { name: "Session options" });
  await menu.click();
  await capture(page, "restart-provider-desktop-1000x600.png");
  await page
    .getByRole("menuitem", { name: "Restart provider", exact: true })
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
  await Promise.all([
    page.waitForEvent("load", { timeout: 30_000 }),
    page
      .getByRole("menuitem", { name: "Restart provider", exact: true })
      .click(),
  ]);
  // Restart reloads this routed dev app, just like the initial cold navigation.
  await expect(composer).toBeVisible({ timeout: 30_000 });
  await expect(
    page.getByText("Turn saved by the TUI", { exact: true }),
  ).toBeVisible();
  await expect(composer).toHaveValue("Preserve my draft");
  expect(reads).toBeGreaterThan(before);
  expect(requests).toEqual(["stop", "stop", "activate"]);
});

test("inspects and explicitly changes the goal without consuming the draft", async ({
  page,
  baseURL,
}) => {
  test.setTimeout(120_000);
  let objective =
    "Implement and qualify durable provider-neutral session relationships. " +
    "Coordinate existing identity and admission owners, remove blocking child " +
    "discovery from transcript delivery, and use native inference-free tests " +
    "where possible. Review substantial changes, address findings, and preserve " +
    "responsive typing during concurrent updates before committing.";
  const receipts: Record<string, unknown>[] = [];
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  let goalStatus = "active";
  let cleared = false;
  const sent: string[] = [];
  let publish:
    | ((eventType: string, data: Record<string, unknown>) => void)
    | undefined;
  const commands = () => [
    {
      name: "goal",
      description: "Keep working toward a verifiable end state until it is met",
      providerDetails: {
        codex: {
          goalObjective: cleared ? null : objective,
          goalStatus: cleared ? null : goalStatus,
        },
      },
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
          messages: [
            ...Array.from({ length: 120 }, (_, index) => ({
              id: `goal-history-${index}`,
              uuid: `goal-history-${index}`,
              type: index % 2 ? "assistant" : "user",
              content:
                `Session relationship review ${index}: ` +
                "Retain durable history and keep input responsive. ".repeat(8),
              timestamp: new Date(
                Date.now() - (120 - index) * 1000,
              ).toISOString(),
            })),
            ...(body.messages as Record<string, unknown>[]),
            ...receipts,
          ],
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
    const argument = body.message.slice("/goal ".length);
    if (argument === "pause") goalStatus = "paused";
    else if (argument === "resume") goalStatus = "active";
    else if (argument === "clear") cleared = true;
    else objective = argument;
    expect(publish).toBeDefined();
    publish?.("message", {
      type: "system",
      subtype: "commands_changed",
      uuid: `status-${sent.length}`,
      slash_command_inventory: commands(),
    });
    const receipt = {
      type: "system",
      subtype: "local_command",
      uuid: `receipt-${sent.length}`,
      content: "/goal",
      details: [
        argument === "clear" ? "Goal cleared" : objective,
        argument === "pause"
          ? "Goal paused"
          : argument === "resume"
            ? "Goal resumed"
            : "Goal set",
      ],
      timestamp: new Date().toISOString(),
      isSynthetic: true,
      tempId: body.tempId,
    };
    receipts.push(receipt);
    publish?.("message", receipt);
    await route.fulfill({ json: { queued: true } });
  });
  await page.setViewportSize({ width: 1000, height: 600 });
  await page.goto(`${baseURL}/projects/${projectId}/sessions/${sessionId}`);
  const composer = page.locator("[data-composer-input]");
  const flag = page.getByRole("button", { name: /^Current goal:/ });
  await expect(composer).toBeVisible({ timeout: 30_000 });
  await expect(flag).toHaveAttribute("data-goal-status", "active");
  await expect.poll(() => !!publish).toBe(true);
  await composer.fill("Keep this draft while the agent works");
  await page.waitForTimeout(150);
  await flag.hover();
  await expect(page.getByRole("tooltip")).toContainText("Goal: Active");
  await flag.click();
  const panel = page.getByRole("dialog", { name: "Current goal", exact: true });
  await expect(panel).toBeVisible();
  await expect(panel).toContainText(objective);
  expect(sent).toEqual([]);
  await recordUiCapture(page, "goal-panel-desktop");
  await page.keyboard.press("Escape");
  await expect(panel).not.toBeVisible();
  await expect(flag).toBeFocused();
  await flag.press("Enter");
  expect(sent).toEqual([]);
  await panel.getByRole("button", { name: "Pause goal", exact: true }).click();
  await expect(flag).toHaveAttribute("data-goal-status", "paused");
  // The paused inventory can arrive over the socket before the send settles,
  // while the panel still announces "Updating goal status…".
  await expect(panel).toHaveAttribute("aria-busy", "false");
  await expect(panel.getByRole("status")).toHaveText("Paused");
  await expect(composer).toHaveValue("Keep this draft while the agent works");
  expect(sent).toEqual(["/goal pause"]);
  await page.keyboard.press("Escape");
  await expect(page.getByText("Goal paused", { exact: true })).toBeVisible();
  await composer.focus();
  await composer.hover();
  await expect(page.getByRole("tooltip")).not.toBeVisible();
  await recordUiCapture(page, "goal-receipt-desktop");
  await page.reload();
  await expect(flag).toHaveAttribute("data-goal-status", "paused");
  await expect(page.getByText("Goal paused", { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 375, height: 812 });
  await flag.click();
  await expect(panel).toBeVisible();
  await expect(panel).toContainText(objective);
  await recordUiCapture(page, "goal-panel-phone");
  expect(sent).toEqual(["/goal pause"]);
  await panel.getByRole("button", { name: "Resume goal", exact: true }).click();
  await expect(flag).toHaveAttribute("data-goal-status", "active");
  await expect(composer).toHaveValue("Keep this draft while the agent works");
  expect(sent).toEqual(["/goal pause", "/goal resume"]);
  await panel.getByRole("button", { name: "Close", exact: true }).click();
  await expect(page.getByText("Goal resumed", { exact: true })).toBeVisible();
  await recordUiCapture(page, "goal-receipt-phone");

  // The editor receives real sequential keys alongside live transcript traffic.
  await flag.click();
  await panel.getByRole("button", { name: "Edit goal", exact: true }).click();
  const editor = panel.getByRole("textbox", { name: "Objective" });
  await expect(editor).toHaveValue(objective);
  await editor.evaluate((element) => {
    const field = element as HTMLTextAreaElement;
    field.setSelectionRange(field.value.length, field.value.length);
  });
  await editor.evaluate((element) => {
    const field = element as HTMLTextAreaElement & {
      acks: { value: string; latency: number }[];
    };
    field.acks = [];
    field.addEventListener("keydown", (event) =>
      requestAnimationFrame(() =>
        requestAnimationFrame(() =>
          field.acks.push({
            value: field.value,
            latency: performance.now() - event.timeStamp,
          }),
        ),
      ),
    );
  });
  let edited = objective;
  for (const char of " Keep every keystroke.") {
    publish?.("message", {
      type: "assistant",
      uuid: `concurrent-${edited.length}`,
      message: {
        role: "assistant",
        content: [{ type: "text", text: `Review progress ${edited.length}` }],
      },
    });
    await page.keyboard.type(char);
    edited += char;
    await expect
      .poll(() =>
        editor.evaluate(
          (element) =>
            (
              element as HTMLTextAreaElement & { acks: { value: string }[] }
            ).acks.at(-1)?.value,
        ),
      )
      .toBe(edited);
  }
  const acks = await editor.evaluate(
    (element) =>
      (
        element as HTMLTextAreaElement & {
          acks: { value: string; latency: number }[];
        }
      ).acks,
  );
  expect(acks).toHaveLength(" Keep every keystroke.".length);
  const maxTypingLatency = Math.max(...acks.map((ack) => ack.latency));
  expect(maxTypingLatency).toBeLessThan(100);
  console.log(`Goal editor typing: ${maxTypingLatency.toFixed(1)} ms maximum`);
  await panel.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(panel).toContainText(objective);
  expect(sent).toHaveLength(2);
  await panel.getByRole("button", { name: "Edit goal", exact: true }).click();
  await editor.fill(edited);
  await panel.getByRole("button", { name: "Save goal", exact: true }).click();
  await expect(panel).toContainText(edited);
  await expect(composer).toHaveValue("Keep this draft while the agent works");
  expect(sent[2]).toBe(`/goal ${edited}`);
  await page.keyboard.press("Escape");
  publish?.("status", { state: "idle" });
  await composer.fill("");
  await expect(
    page.getByRole("button", { name: "Stop", exact: true }),
  ).not.toBeVisible();
  await composer.fill(`/goal ${objective}`);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => sent.length).toBe(4);
  expect(sent[3]).toBe(`/goal ${objective}`);
  await expect(composer).toHaveValue("");
  await expect(
    page.getByRole("button", { name: "Stop", exact: true }),
  ).not.toBeVisible();
  await flag.click();
  await panel.getByRole("button", { name: "Clear goal", exact: true }).click();
  await expect(panel).not.toBeVisible();
  await expect(flag).not.toBeVisible();
  expect(sent[4]).toBe("/goal clear");
  expect(errors).toEqual([]);
});
