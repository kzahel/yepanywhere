import { join } from "node:path";
import { e2ePaths, expect, test } from "./fixtures.js";
import { recordUiCapture } from "./support/ui-capture.js";

const mockProjectPath = join(e2ePaths.tempDir, "mockproject");
const projectId = Buffer.from(mockProjectPath).toString("base64url");
const sessionId = "mock-session-001";

test.use({ serviceWorkers: "block" });

async function dismissOnboardingIfVisible(
  page: import("@playwright/test").Page,
) {
  const dialog = page.getByText("Welcome to yepanywhere");
  await page.waitForTimeout(250);
  if (!(await dialog.isVisible().catch(() => false))) return;
  await page.getByRole("button", { name: "Skip all" }).click({ force: true });
  await expect(dialog).not.toBeVisible();
}

function decodeClientFrame(payload: string | Buffer): unknown {
  if (typeof payload === "string") {
    return JSON.parse(payload);
  }
  if (payload[0] !== 0x01) {
    return null;
  }
  return JSON.parse(payload.subarray(1).toString("utf8"));
}

test.describe("Session streams", () => {
  test("idle heartbeat clears processing when completion and tool output were missed", async ({
    page,
    baseURL,
  }) => {
    test.setTimeout(60_000);
    const timestamp = new Date().toISOString();
    const ownership = { owner: "self", processId: "heartbeat-process" };
    const messages = [
      { uuid: "u1", type: "user", content: "Check the build.", timestamp },
      {
        uuid: "a1",
        type: "assistant",
        timestamp,
        content: [
          {
            type: "tool_use",
            id: "t1",
            name: "Bash",
            input: { command: "npm test" },
          },
        ],
      },
    ];
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
              title: "Build check",
              createdAt: timestamp,
              updatedAt: timestamp,
              ownership,
              messageCount: messages.length,
            },
            ownership,
            processState: "in-turn",
            messages,
          },
        }),
    );
    const sessionStream: { emit?: (eventType: string, data: object) => void } =
      {};
    const getSessionEmitter = () => sessionStream.emit;
    await page.routeWebSocket("**/api/ws", (socket) => {
      const upstream = socket.connectToServer();
      socket.onMessage((wire) => {
        const message = decodeClientFrame(wire) as {
          type: string;
          channel?: string;
          subscriptionId?: string;
        } | null;
        if (message?.type === "subscribe" && message.channel === "session") {
          let eventId = 0;
          sessionStream.emit = (eventType, data) =>
            socket.send(
              JSON.stringify({
                type: "event",
                subscriptionId: message.subscriptionId,
                eventId: String(eventId++),
                eventType,
                data,
              }),
            );
          sessionStream.emit("connected", {
            sessionId,
            processId: "heartbeat-process",
            state: "in-turn",
          });
          return;
        }
        upstream.send(wire);
      });
    });

    for (const viewport of [
      { name: "desktop", width: 1200, height: 600 },
      { name: "phone", width: 375, height: 812 },
    ]) {
      sessionStream.emit = undefined;
      await page.setViewportSize(viewport);
      await page.goto(`${baseURL}/projects/${projectId}/sessions/${sessionId}`);
      await dismissOnboardingIfVisible(page);
      const indicator = page.locator(
        "[data-processing-indicator]:not([data-processing-indicator--control-only])",
      );
      await expect(indicator).toBeVisible({ timeout: 30_000 });
      await recordUiCapture(
        page,
        `heartbeat-before-${viewport.name}`,
        viewport,
      );
      await expect.poll(() => Boolean(sessionStream.emit)).toBe(true);
      getSessionEmitter()?.("heartbeat", {
        timestamp,
        liveness: {
          checkedAt: timestamp,
          state: "idle",
          derivedStatus: "verified-idle",
          activeWorkKind: "none",
          evidence: [],
          lastProviderMessageAt: timestamp,
          lastRawProviderEventAt: null,
          lastRawProviderEventSource: null,
          lastStateChangeAt: timestamp,
          lastVerifiedProgressAt: timestamp,
          lastVerifiedIdleAt: timestamp,
          lastLivenessProbeAt: null,
          lastLivenessProbeStatus: null,
          lastLivenessProbeSource: null,
          silenceMs: 0,
          longSilenceThresholdMs: 300_000,
          queueDepth: 0,
          deferredQueueDepth: 0,
        },
      });
      await expect(indicator).toHaveCount(0);
      await expect(page.locator("[data-composer-input]")).toBeVisible();
      await recordUiCapture(page, `heartbeat-idle-${viewport.name}`, viewport);
    }
  });

  test("session detail subscribes to focused watch stream over WebSocket", async ({
    page,
    baseURL,
  }) => {
    const sentMessages: unknown[] = [];
    page.on("websocket", (ws) => {
      ws.on("framesent", (frame) => {
        try {
          sentMessages.push(decodeClientFrame(frame.payload));
        } catch {
          // Ignore non-YA frames; the assertion below filters for subscribe.
        }
      });
    });

    await page.goto(`${baseURL}/projects/${projectId}/sessions/${sessionId}`);
    await dismissOnboardingIfVisible(page);

    await expect(
      page.getByRole("main").getByText("Previous message"),
    ).toBeVisible({ timeout: 10000 });

    await expect
      .poll(
        () =>
          sentMessages.find(
            (
              message,
            ): message is {
              type: string;
              channel: string;
              sessionId: string;
              projectId?: string;
            } =>
              Boolean(message) &&
              typeof message === "object" &&
              (message as { type?: unknown }).type === "subscribe" &&
              (message as { channel?: unknown }).channel === "session-watch" &&
              (message as { sessionId?: unknown }).sessionId === sessionId,
          ),
        { timeout: 5000 },
      )
      .toMatchObject({
        type: "subscribe",
        channel: "session-watch",
        sessionId,
        projectId,
      });
  });
});
