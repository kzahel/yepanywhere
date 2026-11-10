import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import {
  decodeJsonFrame,
  type RemoteClientMessage,
} from "@yep-anywhere/shared";
import {
  startYaServerProcess,
  disposeYaServerProcess,
} from "./support/ya-server-process";
import { recordUiCapture } from "./support/ui-capture";

test.use({ serviceWorkers: "block" });

test("read toggles stay synchronized across sidebar, session menu and inbox", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const clientPath = dirname(dirname(fileURLToPath(import.meta.url)));
  const projectId = Buffer.from(clientPath).toString("base64url");
  const sessionId = "read-state-session";
  const updatedAt = new Date(Date.now() - 60_000).toISOString();
  const backend = await startYaServerProcess({
    label: "session read state",
    serveBuiltClient: true,
    mockClaudeSession: {
      projectPath: clientPath,
      sessionId,
      content: "Completed session",
      timestamp: updatedAt,
    },
  });
  let hasUnread = false;
  let otherHasUnread = true;
  const readWrites: string[] = [];
  const row = () => ({
    id: sessionId,
    title: "Completed session",
    fullTitle: "Completed session",
    projectId,
    projectName: "Read state",
    provider: "claude",
    ownership: { owner: "none" },
    createdAt: updatedAt,
    updatedAt,
    messageCount: 240,
    hasUnread,
    lastSeenAt: new Date().toISOString(),
  });
  const listeners: Array<(type: string, data: object) => void> = [];
  const setReadState = (unread: boolean) => {
    hasUnread = unread;
    for (const emit of listeners)
      emit("session-seen", {
        type: "session-seen",
        sessionId,
        timestamp: unread ? "" : new Date().toISOString(),
      });
  };
  await page.routeWebSocket("**/api/ws", (socket) => {
    const upstream = socket.connectToServer();
    socket.onMessage((message) => {
      const data =
        typeof message === "string"
          ? (JSON.parse(message) as RemoteClientMessage)
          : decodeJsonFrame<RemoteClientMessage>(message);
      if (data.type === "subscribe" && data.channel === "activity") {
        listeners.push((eventType, payload) =>
          socket.send(
            JSON.stringify({
              type: "event",
              subscriptionId: data.subscriptionId,
              eventType,
              eventId: `read-${Date.now()}-${Math.random()}`,
              data: payload,
            }),
          ),
        );
      }
      upstream.send(message);
    });
  });
  await page.route(/\/api\/sessions(?:\?|$)/, (route) =>
    route.fulfill({
      json: {
        sessions: ["starred", "categorized"].some(
          (key) =>
            new URL(route.request().url()).searchParams.get(key) === "true",
        )
          ? []
          : [
              row(),
              {
                ...row(),
                id: "read-state-other",
                title: "Other session",
                fullTitle: "Other session",
                hasUnread: otherHasUnread,
              },
            ],
        hasMore: false,
      },
    }),
  );
  await page.route(/\/api\/inbox(?:\?|$)/, (route) =>
    route.fulfill({
      json: {
        needsAttention: [],
        active: [],
        unread8h: [],
        unread24h: [],
        recentActivity: [
          {
            sessionId,
            projectId,
            projectName: "Read state",
            sessionTitle: "Completed session",
            updatedAt,
            hasUnread,
          },
        ],
      },
    }),
  );
  await page.route(
    /\/api\/projects\/[^/]+\/sessions\/read-state-session(?:\/metadata)?(?:\?|$)/,
    (route) =>
      route.fulfill({
        json: {
          session: row(),
          ownership: { owner: "none" },
          messages: Array.from({ length: 240 }, (_, i) => ({
            uuid: `read-history-${i}`,
            type: i % 2 ? "assistant" : "user",
            content:
              i % 2
                ? `Investigation ${i} is complete.`
                : `Check requirement ${i}.`,
            timestamp: updatedAt,
          })),
        },
      }),
  );
  await page.route("**/api/sessions/read-state-session/process", (route) =>
    route.fulfill({ json: { process: null } }),
  );
  await page.route("**/api/sessions/read-state-session/mark-seen", (route) => {
    readWrites.push(route.request().method());
    setReadState(route.request().method() === "DELETE");
    return route.fulfill({ json: { marked: !hasUnread } });
  });
  await page.route("**/api/sessions/read-state-other/mark-seen", (route) => {
    otherHasUnread = route.request().method() === "DELETE";
    for (const emit of listeners)
      emit("session-seen", {
        type: "session-seen",
        sessionId: "read-state-other",
        timestamp: otherHasUnread ? "" : new Date().toISOString(),
      });
    return route.fulfill({ json: { marked: !otherHasUnread } });
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    const origin = backend.baseUrl;
    for (const viewport of [
      { name: "desktop", width: 1000, height: 600 },
      { name: "phone", width: 375, height: 812 },
    ]) {
      hasUnread = false;
      otherHasUnread = true;
      listeners.length = 0;
      await page.setViewportSize(viewport);
      await page.goto(`${origin}/projects/${projectId}/sessions/${sessionId}`);
      await expect(page.locator("[data-composer-input]")).toBeVisible({
        timeout: 30_000,
      });
      await expect.poll(() => listeners.length).toBeGreaterThan(0);
      const transcript = page.locator("main[data-session-messages]");
      await transcript.focus();
      await page.keyboard.press("u");
      await expect.poll(() => hasUnread).toBe(true);
      // Explicit actions are idempotent; pressing U again must not toggle read.
      const writesBeforeRepeat = readWrites.length;
      await page.keyboard.press("u");
      await expect.poll(() => readWrites.length).toBe(writesBeforeRepeat + 1);
      await expect.poll(() => readWrites.at(-1)).toBe("DELETE");
      const writesBeforeTyping = readWrites.length;
      const composer = page.locator("[data-composer-input]");
      await composer.focus();
      await composer.evaluate((node) => {
        const samples: Array<{
          expected: string;
          actual: string;
          latency: number;
        }> = [];
        Object.assign(window, { readStateTypingSamples: samples });
        let expected = "";
        let started = 0;
        node.addEventListener("keydown", (event) => {
          const key = (event as KeyboardEvent).key;
          if (key.length !== 1) return;
          expected += key;
          started = performance.now();
        });
        node.addEventListener("input", () => {
          samples.push({
            expected,
            actual: (node as HTMLTextAreaElement).value,
            latency: performance.now() - started,
          });
        });
      });
      let typed = "";
      for (const character of "review unread runs") {
        // Shared activity keeps updating while real sequential keys arrive in
        // a conversation with 240 messages. R/U must remain ordinary text here.
        setReadState(true);
        await composer.pressSequentially(character);
        typed += character;
        await expect(composer).toHaveValue(typed, { timeout: 100 });
      }
      // Browser event timing excludes driver/trace transport and assertion
      // round trips, which exceeded 100 ms on CI despite prompt DOM input.
      const samples = await page.evaluate(
        () =>
          (
            window as unknown as {
              readStateTypingSamples: Array<{
                expected: string;
                actual: string;
                latency: number;
              }>;
            }
          ).readStateTypingSamples,
      );
      expect(samples).toHaveLength(typed.length);
      for (const sample of samples) expect(sample.actual).toBe(sample.expected);
      const acknowledgementMs = samples.map((sample) => sample.latency);
      expect(Math.max(...acknowledgementMs)).toBeLessThan(100);
      console.log(
        `[read-state ${viewport.name}] ${typed.length} keys, maximum acknowledgement ${Math.max(...acknowledgementMs).toFixed(1)} ms`,
      );
      expect(readWrites).toHaveLength(writesBeforeTyping);
      await composer.fill("");
      await transcript.focus();
      // The hook regression controls the debounce clock; this checks real
      // focus, typing and shared updates without another fixed timer wait.
      expect(hasUnread).toBe(true);
      expect(readWrites).toHaveLength(writesBeforeTyping);
      await page.keyboard.press("r");
      await expect.poll(() => hasUnread).toBe(false);
      await page
        .getByRole("button", { name: "Open sidebar", exact: true })
        .click();
      const sidebarRow = page
        .locator("[data-sidebar]:visible [data-session-list-item]")
        .filter({ hasText: "Completed session" })
        .first();
      await expect(sidebarRow).toBeVisible();
      await expect(sidebarRow).not.toHaveAttribute("data-session-unread");
      setReadState(true);
      await expect(sidebarRow).toHaveAttribute("data-session-unread");
      // Focus on another row must target that session without changing the
      // open conversation's read state, route or keyboard focus.
      const otherRow = page
        .locator("[data-sidebar]:visible [data-session-list-item]")
        .filter({ hasText: "Other session" })
        .first();
      const otherLink = otherRow.locator("a").first();
      await otherLink.focus();
      await page.keyboard.press("r");
      await expect(otherRow).not.toHaveAttribute("data-session-unread");
      await expect(otherLink).toBeFocused();
      expect(hasUnread).toBe(true);
      await expect(page).toHaveURL(
        `${origin}/projects/${projectId}/sessions/${sessionId}`,
      );
      await sidebarRow.locator("a").first().focus();
      await page.keyboard.press("r");
      await expect(sidebarRow).not.toHaveAttribute("data-session-unread");
      await page.keyboard.press("u");
      await expect(sidebarRow).toHaveAttribute("data-session-unread");
      await sidebarRow.locator(".session-menu-trigger").click();
      await page
        .getByRole("menuitem", { name: "Mark as read", exact: true })
        .click();
      await expect(sidebarRow).not.toHaveAttribute("data-session-unread");
      // A later event must supersede the prior manual toggle.
      setReadState(true);
      await expect(sidebarRow).toHaveAttribute("data-session-unread");
      await page
        .getByRole("complementary")
        .getByRole("button", { name: "Close sidebar", exact: true })
        .click();
      const menu = page.locator("[data-session-header] .session-menu-trigger");
      await menu.click();
      await page
        .getByRole("menuitem", { name: "Mark as read", exact: true })
        .click();
      await expect.poll(() => hasUnread).toBe(false);
      setReadState(true);
      await menu.click();
      const writesBeforeMenuKey = readWrites.length;
      await page.keyboard.press("r");
      expect(readWrites).toHaveLength(writesBeforeMenuKey);
      await expect(
        page.getByRole("menuitem", { name: "Mark as read", exact: true }),
      ).toBeVisible();
      await recordUiCapture(
        page,
        `session-read-state-${viewport.name}`,
        viewport,
      );
      await page
        .getByRole("menuitem", { name: "Mark as read", exact: true })
        .click();
      await page.goto(`${origin}/inbox`);
      const inboxRow = page
        .locator("[data-session-list-item]")
        .filter({ hasText: "Completed session" })
        .last();
      await expect(inboxRow).toBeVisible();
      await expect(inboxRow).not.toHaveAttribute("data-session-unread");
      setReadState(true);
      await expect(inboxRow).toHaveAttribute("data-session-unread");
      setReadState(false);
      await expect(inboxRow).not.toHaveAttribute("data-session-unread");
    }
    expect(errors).toEqual([]);
  } finally {
    await page.goto("about:blank");
    await disposeYaServerProcess(backend);
  }
});
