import { join } from "node:path";
import {
  decodeJsonFrame,
  type RemoteClientMessage,
} from "@yep-anywhere/shared";
import { e2ePaths, expect, test } from "./fixtures.js";
import { recordUiCapture } from "./support/ui-capture.js";

test.use({ serviceWorkers: "block" });

for (const viewport of [
  { name: "desktop", width: 1000, height: 600, streaming: true },
  { name: "phone", width: 375, height: 812, streaming: true },
  { name: "streaming-disabled", width: 1200, height: 600, streaming: false },
]) {
  test(`Codex first-turn snapshots stay one row at ${viewport.name} width`, async ({
    page,
    baseURL,
  }) => {
    const projectId = Buffer.from(
      join(e2ePaths.tempDir, "mockproject"),
    ).toString("base64url");
    const sessionId = "mock-session-001";
    const timestamp = new Date().toISOString();
    const text =
      "I’ll open a Clair sketch, check its Git coordination mechanism, and map how it could fit YA’s shared-worktree and branch workflows.";
    const ownership = { owner: "self", processId: "snapshot-process" };
    const snapshots = ["I’ll", "I’ll open", "I’ll open a Clair", text].map(
      (content) => ({
        id: "commentary",
        uuid: "commentary",
        type: "assistant",
        _isStreaming: true,
        timestamp,
        message: { role: "assistant", content },
      }),
    );
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (/same key|unique.*key/.test(message.text()))
        errors.push(message.text());
    });
    await page.addInitScript(
      (enabled) =>
        localStorage.setItem("yep-anywhere-streaming-enabled", String(enabled)),
      viewport.streaming,
    );
    let durable = false;
    await page.route(
      new RegExp(
        `/api/projects/[^/]+/sessions/${sessionId}(?:/metadata)?(?:\\?|$)`,
      ),
      (route) =>
        route.fulfill({
          json: {
            session: {
              id: sessionId,
              projectId,
              provider: "codex",
              model: "gpt-6.1-sol",
              effectiveModelSettings: {
                requestedModel: "gpt-6.1-sol",
                thinking: { type: "enabled" },
                effort: "high",
              },
              title: "Codex streaming snapshots",
              createdAt: timestamp,
              updatedAt: timestamp,
              ownership,
              messageCount: 2,
            },
            ownership,
            processState: "in-turn",
            messages: [
              {
                id: "prompt",
                uuid: "prompt",
                type: "user",
                content: "Check Clair’s Git coordination.",
                timestamp,
              },
              ...(durable
                ? [
                    {
                      id: "commentary",
                      uuid: "commentary",
                      type: "assistant",
                      timestamp,
                      message: {
                        role: "assistant",
                        content: [{ type: "text", text }],
                      },
                    },
                  ]
                : snapshots),
            ],
          },
        }),
    );
    let emit: ((data: object) => void) | undefined;
    await page.routeWebSocket("**/api/ws", (socket) => {
      const upstream = socket.connectToServer();
      socket.onMessage((wire) => {
        const request =
          typeof wire === "string"
            ? (JSON.parse(wire) as RemoteClientMessage)
            : decodeJsonFrame<RemoteClientMessage>(wire);
        if (request.type === "subscribe" && request.channel === "session") {
          let sequence = 0;
          emit = (data) =>
            socket.send(
              JSON.stringify({
                type: "event",
                subscriptionId: request.subscriptionId,
                eventType: "message",
                eventId: String(++sequence),
                data,
              }),
            );
          socket.send(
            JSON.stringify({
              type: "event",
              subscriptionId: request.subscriptionId,
              eventType: "connected",
              eventId: "0",
              data: {
                sessionId,
                processId: "snapshot-process",
                state: "in-turn",
                provider: "codex",
              },
            }),
          );
          return;
        }
        upstream.send(wire);
      });
    });
    await page.setViewportSize(viewport);
    await page.goto(`${baseURL}/projects/${projectId}/sessions/${sessionId}`);
    const list = page.locator("[data-message-list]");
    const badge = page.locator(
      "[data-provider-badge-button] [data-provider-badge]",
    );
    await expect(badge).toHaveAttribute(
      "aria-label",
      "gpt-6.1-sol · Effort: High",
    );
    await expect(badge).toHaveText(
      viewport.name === "phone" ? "So 6.1H" : "Cd So 6.1High",
    );
    await expect(list.getByText(text, { exact: true })).toHaveCount(1);
    await expect(list.locator('[data-render-type="text"]')).toHaveCount(1);
    await expect.poll(() => Boolean(emit)).toBe(true);
    await expect(page.locator(".session-header-thinking")).toHaveCount(0);
    const composer = page.locator("[data-composer-input]");
    await composer.click();
    let typed = "";
    for (const character of "Continue carefully") {
      emit?.({ ...snapshots[3], timestamp: new Date().toISOString() });
      await composer.pressSequentially(character);
      typed += character;
      await expect(composer).toHaveValue(typed, { timeout: 100 });
    }
    await expect(composer).toHaveValue("Continue carefully");
    durable = true;
    emit?.({
      uuid: "commentary",
      type: "assistant",
      timestamp,
      message: { role: "assistant", content: [{ type: "text", text }] },
    });
    await expect(list.locator('[data-render-type="text"]')).toHaveCount(1);
    await expect(list.getByText(text, { exact: true })).toHaveCount(1);
    await recordUiCapture(page, `codex-snapshots-${viewport.name}`, viewport);
    expect(errors).toEqual([]);
  });
}
