import { join } from "node:path";
import type {
  SessionProviderPhase,
  RemoteClientMessage,
} from "@yep-anywhere/shared";
import { decodeJsonFrame } from "@yep-anywhere/shared";
import { e2ePaths, expect, test } from "./fixtures.js";
import { recordUiCapture } from "./support/ui-capture.js";
import type { InboxItem } from "../src/api/inbox.js";

test.use({ serviceWorkers: "block" });

test("Inbox keeps model cards and typing stable through activity and older-server responses", async ({
  page,
}) => {
  test.setTimeout(60_000);
  const projectId = Buffer.from(join(e2ePaths.tempDir, "mockproject")).toString(
    "base64url",
  );
  const updatedAt = new Date(Date.now() - 120_000).toISOString();
  const waiting: SessionProviderPhase = {
    phase: "waiting",
    work: [
      {
        id: "tool",
        kind: "shell",
        label:
          "A very long running tool that must never push the model badge onto another line",
        startedAt: updatedAt,
        source: "tool",
      },
    ],
  };
  let providerPhase: SessionProviderPhase | undefined;
  let omitModels = false;
  let requests = 0;
  const listeners: Array<() => void> = [];
  await page.routeWebSocket("**/api/ws", (socket) => {
    const upstream = socket.connectToServer();
    socket.onMessage((message) => {
      const data =
        typeof message === "string"
          ? (JSON.parse(message) as RemoteClientMessage)
          : decodeJsonFrame<RemoteClientMessage>(message);
      if (data.type === "subscribe" && data.channel === "activity") {
        listeners.push(() =>
          socket.send(
            JSON.stringify({
              type: "event",
              subscriptionId: data.subscriptionId,
              eventType: "session-provider-phase-changed",
              eventId: `inbox-${Date.now()}-${Math.random()}`,
              data: {
                type: "session-provider-phase-changed",
                sessionId: "inbox-model-0",
                projectId,
                providerPhase: providerPhase ?? null,
                timestamp: new Date().toISOString(),
              },
            }),
          ),
        );
      }
      upstream.send(message);
    });
  });
  const item = (index: number): InboxItem => ({
    sessionId: `inbox-model-${index}`,
    projectId,
    projectName: "A long project name for Inbox layout",
    sessionTitle: `Inbox model fixture ${index}`,
    updatedAt,
    hasUnread: true,
    ...(index < 20 ? { activity: "in-turn", providerPhase } : {}),
    ...(!omitModels && index % 4 !== 2
      ? {
          modelConfig: {
            provider: index % 4 === 3 ? "claude" : "codex",
            model: index % 4 === 3 ? "claude-opus-5-5" : "gpt-6.1-sol",
            ...(index % 4 === 1
              ? {}
              : { thinking: { type: "enabled" }, effort: "high" }),
          },
        }
      : {}),
  });
  await page.route(/\/api\/inbox(?:\?|$)/, (route) => {
    requests++;
    return route.fulfill({
      json: {
        active: Array.from({ length: 20 }, (_, i) => item(i)),
        recentActivity: Array.from({ length: 20 }, (_, i) => item(i + 20)),
        unread8h: Array.from({ length: 20 }, (_, i) => item(i + 40)),
        unread24h: Array.from({ length: 20 }, (_, i) => item(i + 60)),
        needsAttention: Array.from({ length: 20 }, (_, i) => item(i + 80)),
      },
    });
  });
  await page.goto("/inbox");
  const main = page.getByRole("main");
  const cards = main.locator("[data-session-list-item--card]");
  const card = (index: number) =>
    cards.filter({
      has: page.getByText(`Inbox model fixture ${index}`, { exact: true }),
    });
  await expect(cards).toHaveCount(100);
  const refresh = async () => {
    const before = requests;
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect.poll(() => requests).toBeGreaterThan(before);
    await expect(
      page.getByRole("button", { name: "Refresh", exact: true }),
    ).toBeEnabled();
  };
  for (const viewport of [
    { width: 1000, height: 600 },
    { width: 375, height: 812 },
  ]) {
    await page.setViewportSize(viewport);
    await card(0).scrollIntoViewIfNeeded();
    await expect(
      card(0).locator("[data-provider-badge]:visible"),
    ).toHaveAccessibleName(/High/);
    await expect(
      card(1).locator("[data-provider-badge]:visible"),
    ).not.toHaveAccessibleName(/Off|Auto|High/);
    await expect(card(2).locator("[data-inbox-model]")).toHaveCount(0);
    await expect(
      card(3).locator("[data-provider-badge]:visible"),
    ).toHaveAccessibleName(/High/);
    const geometry = () =>
      card(0).evaluate((node) => {
        const row = node.getBoundingClientRect();
        const meta = node
          .querySelector("[data-inbox-session-meta]")!
          .getBoundingClientRect();
        const model = node
          .querySelector("[data-inbox-model]")!
          .getBoundingClientRect();
        return {
          rowHeight: row.height,
          metaHeight: meta.height,
          modelRight: model.right,
          modelTop: model.top - row.top,
          overflow: node.scrollWidth > node.clientWidth,
        };
      });
    providerPhase = undefined;
    await refresh();
    const before = await geometry();
    providerPhase = waiting;
    await refresh();
    await expect(card(0).locator("[data-provider-phase-pill]")).toBeVisible();
    expect(await geometry()).toEqual(before);
    expect(before.overflow).toBe(false);
    await card(0).scrollIntoViewIfNeeded();
    await recordUiCapture(page, `inbox-model-${viewport.width}`, viewport);
    providerPhase = undefined;
    await refresh();
    expect(await geometry()).toEqual(before);
  }

  // Keep the full Inbox updating while typing in the ordinary composer.
  // This display adds no Inbox input of its own.
  listeners.length = 0;
  await page.goto(`/projects/${projectId}/sessions/mock-session-001`);
  const input = page.locator("textarea[data-composer-input]");
  await expect(input).toBeVisible();
  await input.focus();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.press("Backspace");
  await input.evaluate((node) => {
    const samples: Array<{
      expected: string;
      actual: string;
      latency: number;
    }> = [];
    Object.assign(window, { inboxTypingSamples: samples });
    let expected = "";
    node.addEventListener("keydown", (event) => {
      if ((event as KeyboardEvent).key.length !== 1) return;
      expected += (event as KeyboardEvent).key;
      const prefix = expected;
      const start = event.timeStamp;
      requestAnimationFrame(() =>
        requestAnimationFrame(() =>
          samples.push({
            expected: prefix,
            actual: (node as HTMLTextAreaElement).value,
            latency: performance.now() - start,
          }),
        ),
      );
    });
  });
  // Leave room for Inbox's 500 ms event debounce to publish each update.
  const timer = setInterval(() => {
    providerPhase = providerPhase ? undefined : waiting;
    for (const emit of listeners) emit();
  }, 650);
  const text = "Keep every typed character";
  const beforeTypingRequests = requests;
  try {
    // A later key must not overwrite the sampled prefix before its 100 ms gate.
    await page.keyboard.type(text, { delay: 110 });
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    await expect(input).toHaveValue(text);
    const samples = await page.evaluate(
      () =>
        (
          window as unknown as {
            inboxTypingSamples: Array<{
              expected: string;
              actual: string;
              latency: number;
            }>;
          }
        ).inboxTypingSamples,
    );
    expect(samples).toHaveLength(text.length);
    for (const sample of samples) {
      expect(sample.actual).toBe(sample.expected);
      expect(sample.latency).toBeLessThan(100);
    }
    expect(requests).toBeGreaterThan(beforeTypingRequests);
  } finally {
    clearInterval(timer);
  }
  await page.goto("/inbox");
  omitModels = true;
  await refresh();
  await expect(main.locator("[data-inbox-model]")).toHaveCount(0);
});
