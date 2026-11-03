import type { StagedAttachmentRef } from "@yep-anywhere/shared";
import { AttachmentStagingService } from "../../server/src/uploads/AttachmentStagingService";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
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
const otherProjectPath = join(e2ePaths.tempDir, "otherproject");
const otherProjectId = Buffer.from(otherProjectPath).toString("base64url");

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

test("right-click queues the draft as a new session in another project", async ({
  page,
  baseURL,
}) => {
  await page.addInitScript(() => {
    localStorage.setItem(
      "yep-anywhere-session-toolbar-presence",
      JSON.stringify({ projectQueueNewSessionShortcut: "pin" }),
    );
  });
  // Exercise the chooser with a realistic large project/model catalog.
  await page.route(
    (url) => url.pathname === "/api/projects",
    async (route) => {
      if (route.request().method() !== "GET") return route.continue();
      const response = await route.fetch();
      const body = (await response.json()) as {
        projects: Record<string, unknown>[];
      };
      const template = body.projects[0] ?? {};
      body.projects.push({
        ...template,
        id: otherProjectId,
        name: "otherproject",
        path: otherProjectPath,
        lastActivity: null,
      });
      body.projects.push(
        ...Array.from({ length: 200 }, (_, index) => ({
          ...template,
          id: `extra-project-${index}`,
          name: `Project ${index}`,
          path: `/work/project-${index}`,
          lastActivity: null,
        })),
      );
      await route.fulfill({ response, json: body });
    },
  );
  // The fixture reports no launchable provider (and answers slowly); offer
  // Claude with two models.
  await page.route(
    (url) => url.pathname.endsWith("/api/providers"),
    (route) =>
      route.fulfill({
        json: {
          providers: [
            {
              name: "claude",
              displayName: "Claude",
              installed: true,
              authenticated: true,
              enabled: true,
              models: [
                { id: "opus", name: "Opus" },
                { id: "sonnet", name: "Sonnet" },
                ...Array.from({ length: 200 }, (_, index) => ({
                  id: `model-${index}`,
                  name: `Model ${index}`,
                })),
              ],
            },
            {
              name: "codex",
              displayName: "Codex",
              installed: true,
              authenticated: true,
              enabled: true,
              models: [{ id: "gpt-test", name: "GPT Test" }],
            },
          ],
        },
      }),
  );
  let queued: Record<string, unknown> | undefined;
  let emitUpdate: (() => void) | undefined;
  await page.route(
    new RegExp(
      `/api/projects/[^/]+/sessions/${sessionId}(?:/metadata)?(?:\\?|$)`,
    ),
    async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      const ownership = { owner: "self", processId: "typing-process" };
      await route.fulfill({
        response,
        json: {
          ...body,
          session: { ...body.session, ownership },
          ownership,
          processState: "idle",
        },
      });
    },
  );
  await page.routeWebSocket("**/api/ws", (socket) => {
    const upstream = socket.connectToServer();
    socket.onMessage((message) => {
      const request =
        typeof message === "string"
          ? (JSON.parse(message) as RemoteClientMessage)
          : decodeJsonFrame<RemoteClientMessage>(message);
      if (
        request.type === "subscribe" &&
        request.channel === "session" &&
        request.sessionId === sessionId
      ) {
        let sequence = 0;
        socket.send(
          JSON.stringify({
            type: "event",
            subscriptionId: request.subscriptionId,
            eventType: "connected",
            eventId: "typing-connected",
            data: { sessionId, processId: "typing-process", state: "idle" },
          }),
        );
        emitUpdate = () =>
          socket.send(
            JSON.stringify({
              type: "event",
              subscriptionId: request.subscriptionId,
              eventType: "message",
              eventId: `typing-${++sequence}`,
              data: {
                type: "system",
                subtype: "thinking_tokens",
                uuid: `typing-${sequence}`,
                session_id: sessionId,
                thinking_tokens: sequence,
                timestamp: new Date().toISOString(),
              },
            }),
          );
        return;
      }
      upstream.send(message);
    });
  });
  await page.route(`**/api/projects/${otherProjectId}/queue`, (route) => {
    queued = route.request().postDataJSON() as Record<string, unknown>;
    return route.fulfill({
      json: { item: {}, queue: { projectId: otherProjectId, items: [] } },
    });
  });

  await page.setViewportSize({ width: 1000, height: 600 });
  await page.goto(`${baseURL}/projects/${projectId}/sessions/${sessionId}`);
  await dismissOnboardingIfVisible(page);
  const composer = page.locator("[data-composer-input]");
  await composer.fill("Start this over in the other project");

  await page
    .getByRole("button", { name: "Queue as new session for Project Queue" })
    .click({ button: "right" });
  const dialog = page.getByRole("form", { name: "Queue as new session" });
  await expect(dialog).toBeVisible();
  await dialog
    .getByRole("combobox", { name: "Project" })
    .selectOption(otherProjectId);
  await dialog
    .getByRole("button", { name: "Choose a model from this provider" })
    .click();
  await expect(
    dialog.getByRole("option", { name: "GPT Test (Codex)" }),
  ).toHaveCount(0);
  await dialog.getByRole("option", { name: "Sonnet (Claude)" }).click();
  await composer.press("Control+End");
  await expect.poll(() => !!emitUpdate).toBe(true);
  const inputDelay = await composer.evaluateHandle((element) => {
    const input = element as HTMLTextAreaElement;
    const samples: number[] = [];
    input.addEventListener("input", () => {
      const at = performance.now();
      requestAnimationFrame(() => samples.push(performance.now() - at));
    });
    return samples;
  });
  // Updates continue while real sequential keystrokes reach the editor.
  const updates = setInterval(() => emitUpdate?.(), 25);
  try {
    await composer.pressSequentially(" Keep all details.", { delay: 20 });
    await expect(composer).toHaveValue(
      "Start this over in the other project Keep all details.",
    );
    for (let index = 0; index < " Keep all details.".length; index++) {
      await composer.press("Backspace");
    }
    await composer.pressSequentially(".", { delay: 20 });
  } finally {
    clearInterval(updates);
  }
  const delays = await inputDelay.evaluate(
    (samples) =>
      new Promise<number[]>((resolve) =>
        requestAnimationFrame(() => resolve([...samples])),
      ),
  );
  await inputDelay.dispose();
  expect(delays.length).toBeGreaterThanOrEqual(18);
  expect(Math.max(...delays)).toBeLessThan(100);
  await expect(composer).toHaveValue("Start this over in the other project.");
  await recordUiCapture(page, "desktop", { width: 1000, height: 600 });
  await page.setViewportSize({ width: 375, height: 812 });
  await recordUiCapture(page, "phone", { width: 375, height: 812 });
  await page.setViewportSize({ width: 1000, height: 600 });
  await dialog.getByRole("button", { name: "Queue new session" }).click();

  await expect(dialog).toBeHidden();
  await expect(
    page.getByText("Queued new session in otherproject for Project Queue."),
  ).toBeVisible();
  expect(queued).toMatchObject({
    target: {
      type: "new-session",
      provider: "claude",
      model: "sonnet",
      title: "Start this over in the other project.",
    },
    message: { text: "Start this over in the other project." },
  });
  await expect(composer).toHaveValue("");

  // The ordinary Send button enters the same dock with direct delivery.
  const addedProject = await page.request.post(`${baseURL}/api/projects`, {
    headers: { "X-Yep-Anywhere": "true" },
    data: { path: otherProjectPath, create: true },
  });
  expect(addedProject.ok(), await addedProject.text()).toBe(true);
  await page.locator('input[type="file"]').setInputFiles({
    name: "destination-note.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("Bytes for the destination first turn"),
  });
  await expect(
    page.getByText("destination-note.txt", { exact: true }).first(),
  ).toBeVisible();
  await composer.fill("Start immediately");
  await page.locator(".send-button-with-help").click({ button: "right" });
  await expect(dialog).toBeVisible();
  await dialog
    .getByRole("button", { name: "Exit new session mode (Esc)" })
    .click();
  await expect(dialog).toBeHidden();
  await expect(composer).toHaveValue("Start immediately");
  await page.locator(".send-button-with-help").click({ button: "right" });
  await composer.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(composer).toHaveValue("Start immediately");
  await page.locator(".send-button-with-help").click({ button: "right" });
  await dialog
    .getByRole("combobox", { name: "Project" })
    .selectOption(otherProjectId);
  const model = dialog.getByRole("combobox", { name: "Model" });
  await model.fill("");
  await model.pressSequentially("gpt", { delay: 20 });
  await dialog.getByRole("option", { name: "GPT Test (Codex)" }).click();
  await expect(dialog.getByRole("combobox", { name: "Provider" })).toHaveValue(
    "codex",
  );
  await recordUiCapture(page, "green-desktop", { width: 1000, height: 600 });
  await page.setViewportSize({ width: 375, height: 812 });
  await recordUiCapture(page, "green-phone", { width: 375, height: 812 });
  await page.setViewportSize({ width: 1000, height: 600 });
  let started:
    | {
        provider: string;
        model: string;
        message: string;
        stagedAttachments: StagedAttachmentRef[];
      }
    | undefined;
  await page.route(
    `**/api/projects/${otherProjectId}/session-creations`,
    (route) => {
      const body = route.request().postDataJSON();
      started = body;
      return route.fulfill({
        status: 202,
        json: {
          requestId: body.requestId,
          sessionId: "019a0000-bbbb-7bbb-8bbb-bbbbbbbbbbbb",
          projectId: otherProjectId,
          provider: "codex",
          creation: {
            state: "saved",
            attemptId: "queue-attempt",
            delivery: "not-admitted",
            updatedAt: new Date().toISOString(),
          },
          serverTimestamp: Date.now(),
        },
      });
    },
  );
  queued = undefined;
  await composer.press("Enter");
  await expect
    .poll(() => started)
    .toMatchObject({
      provider: "codex",
      model: "gpt-test",
    });
  expect(queued).toBeUndefined();
  expect(started!.message).toBe("Start immediately");
  expect(started!.stagedAttachments).toHaveLength(1);
  const staging = new AttachmentStagingService({ dataDir: e2ePaths.dataDir });
  await staging.initialize();
  const staged = staging.getRecord(started!.stagedAttachments[0]!.id);
  expect(staged).not.toBeNull();
  expect(await readFile(staged!.path, "utf8")).toBe(
    "Bytes for the destination first turn",
  );
});
