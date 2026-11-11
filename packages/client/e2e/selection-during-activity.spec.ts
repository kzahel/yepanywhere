import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import {
  decodeJsonFrame,
  type RemoteClientMessage,
} from "@yep-anywhere/shared";
import { readCollectionsOverRest } from "./support/managed-routes";
import { createTestViteServer } from "./support/vite-server";
import {
  disposeYaServerProcess,
  startYaServerProcess,
} from "./support/ya-server-process";

test.use({ serviceWorkers: "block" });

// A transcript drag selection must survive live agent activity: the view holds
// still under a held button, and a drag keeps its press point even when the
// browser loses its own record of it (observed live: the browser restarted
// the selection at the pointer on every move, so it collapsed before copy).
// Contract: topics/selection-comment-ui.md § Drag selection during live
// activity.

const ROWS = 24;

function transcript() {
  const messages: object[] = [];
  for (let i = 0; i < ROWS; i++) {
    messages.push({
      uuid: `u-${i}`,
      type: "user",
      content: `User message ${i}: please explain the next step.`,
    });
    messages.push({
      uuid: `a-${i}`,
      type: "assistant",
      content: [
        {
          type: "text",
          text: `Reply ${i} opens here. Reply ${i} middle words keep going for a while so the row wraps. Reply ${i} closes here.`,
        },
      ],
    });
  }
  return messages;
}

async function textPoint(page: Page, marker: string) {
  return page.locator("[data-message-list]").evaluate((list, text) => {
    const walker = document.createTreeWalker(list, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const textNode = node as Text;
      const index = textNode.data.indexOf(text);
      if (index < 0) continue;
      const range = document.createRange();
      range.setStart(textNode, index);
      range.setEnd(textNode, index + 1);
      const rect = range.getBoundingClientRect();
      return { x: rect.left + 1, y: rect.top + rect.height / 2 };
    }
    throw new Error(`Marker not found: ${text}`);
  }, marker);
}

async function openLiveSession(page: Page) {
  const projectPath = dirname(dirname(fileURLToPath(import.meta.url)));
  const backend = await startYaServerProcess({ label: "selection activity" });
  let source: Awaited<ReturnType<typeof createTestViteServer>> | undefined;
  const close = async () => {
    const results = await Promise.allSettled([
      source?.close(),
      disposeYaServerProcess(backend),
    ]);
    const errors = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (errors.length)
      throw new AggregateError(errors, "Selection fixture cleanup failed");
  };
  try {
    source = await createTestViteServer({
      configFile: join(projectPath, "vite.config.ts"),
      define: { __VITE_DEV_PORT__: "-1" },
      server: {
        port: 0,
        strictPort: false,
        host: "127.0.0.1",
        proxy: { "/api": { target: backend.baseUrl, ws: true } },
      },
    });
    const projectId = Buffer.from(projectPath).toString("base64url");
    const now = Date.now();
    const row = {
      id: "sel-a",
      title: "Selection A",
      fullTitle: "Selection A",
      projectId,
      projectName: "Selection test",
      provider: "claude",
      activity: "in-turn",
      ownership: { owner: "none" },
      createdAt: new Date(now - 60_000).toISOString(),
      updatedAt: new Date(now - 60_000).toISOString(),
      messageCount: ROWS * 2,
    };
    await readCollectionsOverRest(page);
    await page.route(/\/api\/sessions(?:\?|$)/, (route) =>
      route.fulfill({
        json: {
          sessions:
            new URL(route.request().url()).searchParams.get("starred") ===
            "true"
              ? []
              : [row],
          hasMore: false,
          total: 1,
        },
      }),
    );
    await page.route(
      /\/api\/projects\/[^/]+\/sessions\/sel-a(?:\?|$)/,
      (route) =>
        route.fulfill({
          json: {
            session: row,
            messages: transcript(),
            ownership: { owner: "self", processId: "proc-sel-a" },
          },
        }),
    );
    await page.route(/\/api\/sessions\/sel-a\/process$/, (route) =>
      route.fulfill({
        json: {
          process: {
            sessionId: "sel-a",
            state: "in-turn",
            activity: "in-turn",
          },
        },
      }),
    );
    const emitters: Array<(event: object) => void> = [];
    await page.routeWebSocket("**/api/ws", (socket) => {
      const upstream = socket.connectToServer();
      socket.onMessage((message) => {
        const data =
          typeof message === "string"
            ? (JSON.parse(message) as RemoteClientMessage)
            : decodeJsonFrame<RemoteClientMessage>(message);
        if (
          data.type === "subscribe" &&
          data.channel === "session" &&
          (data as { sessionId?: string }).sessionId === "sel-a"
        ) {
          let seq = 0;
          emitters.push((payload) =>
            socket.send(
              JSON.stringify({
                type: "event",
                subscriptionId: data.subscriptionId,
                eventType: "message",
                eventId: String(++seq),
                data: payload,
              }),
            ),
          );
          return;
        }
        upstream.send(message);
      });
    });
    await source.listen();
    const address = source.httpServer?.address();
    if (!address || typeof address === "string") {
      throw new Error("Missing Vite port");
    }
    await page.setViewportSize({ width: 1200, height: 700 });
    await page.goto(
      `http://127.0.0.1:${address.port}/projects/${projectId}/sessions/sel-a`,
    );
    await expect(page.locator("[data-composer-input]")).toBeVisible({
      timeout: 30_000,
    });
    await expect
      .poll(() => emitters.length, { timeout: 15_000 })
      .toBeGreaterThan(0);
    await page.waitForTimeout(1000);

    const emit = emitters[0]!;
    let messages = 0;
    const startActivity = ({ deltasOnly = false } = {}) => {
      let sent = 0;
      if (deltasOnly) {
        for (const event of [
          { type: "message_start", message: { id: "msg-live-tail" } },
          {
            type: "content_block_start",
            index: 0,
            content_block: { type: "text", text: "" },
          },
        ]) {
          emit({
            type: "stream_event",
            uuid: `se-${event.type}`,
            session_id: "sel-a",
            parent_tool_use_id: null,
            event,
            timestamp: new Date().toISOString(),
          });
        }
      }
      const timer = setInterval(() => {
        sent += 1;
        if (deltasOnly) {
          emit({
            type: "stream_event",
            uuid: `se-${sent}`,
            session_id: "sel-a",
            parent_tool_use_id: null,
            event: {
              type: "content_block_delta",
              index: 0,
              delta: {
                type: "text_delta",
                text: `Streamed paragraph ${sent} grows the live tail.\n\n`,
              },
            },
            timestamp: new Date().toISOString(),
          });
        } else if (sent % 10 === 0) {
          messages += 1;
          emit({
            type: "assistant",
            uuid: `live-${messages}`,
            parentUuid:
              messages === 1 ? `a-${ROWS - 1}` : `live-${messages - 1}`,
            session_id: "sel-a",
            message: {
              role: "assistant",
              content: [
                { type: "text", text: `Live message ${messages} arrives.` },
              ],
            },
            timestamp: new Date().toISOString(),
          });
        } else {
          emit({
            type: "stream_event",
            uuid: `se-${messages}-${sent}`,
            session_id: "sel-a",
            parent_tool_use_id: null,
            event: {
              type: "content_block_delta",
              index: 0,
              delta: { type: "text_delta", text: `token${sent} ` },
            },
            timestamp: new Date().toISOString(),
          });
        }
      }, 40);
      return {
        stop: () => clearInterval(timer),
        messages: () => messages,
      };
    };
    return {
      startActivity,
      close,
    };
  } catch (error) {
    try {
      await close();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Selection fixture setup and cleanup failed",
      );
    }
    throw error;
  }
}

test("a drag keeps its press point when the browser loses it mid-drag", async ({
  context,
  page,
}) => {
  test.setTimeout(180_000);
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const session = await openLiveSession(page);
  const activity = session.startActivity();
  try {
    await page
      .locator("[data-message-list]")
      .getByText("Reply 20 opens here")
      .scrollIntoViewIfNeeded();
    await page.mouse.wheel(0, -200);
    await page.waitForTimeout(400);
    const start = await textPoint(page, "Reply 20 middle");
    const end = await textPoint(page, "Reply 21 middle");
    const anchor = () =>
      page.evaluate(() => {
        const s = document.getSelection();
        return {
          text: s?.anchorNode?.textContent ?? "",
          offset: s?.anchorOffset ?? -1,
        };
      });
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.waitForTimeout(50);
    const pressed = await anchor();
    expect(pressed.text).toContain("Reply ");
    for (let step = 1; step <= 6; step++) {
      await page.mouse.move(
        start.x + ((end.x - start.x) * step) / 12,
        start.y + ((end.y - start.y) * step) / 12,
      );
      await page.waitForTimeout(80);
    }
    // What live activity was observed to cause: the browser restarts the
    // selection where the pointer is instead of extending from the press.
    const lost = await textPoint(page, "Reply 21 opens");
    await page.evaluate(
      ({ x, y }) => {
        const range = document.caretRangeFromPoint(x, y);
        if (range) {
          document
            .getSelection()
            ?.collapse(range.startContainer, range.startOffset);
        }
      },
      { x: lost.x + 20, y: lost.y },
    );
    for (let step = 7; step <= 12; step++) {
      await page.mouse.move(
        start.x + ((end.x - start.x) * step) / 12,
        start.y + ((end.y - start.y) * step) / 12,
      );
      await page.waitForTimeout(80);
    }
    await page.mouse.up();
    await page.waitForTimeout(600);

    // Snapshot at the native copy event: live rows can arrive between an
    // earlier evaluate and the shortcut (CI 36977077788 inserted message 7).
    await page.evaluate(() => {
      document.addEventListener(
        "copy",
        () => {
          document.documentElement.dataset.testCopySelection =
            document.getSelection()?.toString() ?? "";
        },
        { capture: true, once: true },
      );
    });
    await page.evaluate(() => navigator.clipboard.writeText(""));
    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+c" : "Control+c",
    );
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    const selected = await page.evaluate(
      () => document.documentElement.dataset.testCopySelection ?? "",
    );
    expect(activity.messages()).toBeGreaterThan(0);
    expect(await anchor()).toEqual(pressed);
    expect(selected.length).toBeGreaterThan(60);
    // This fixture has no authored > text; native copy omits quote-button
    // glyphs that raw Selection.toString includes.
    expect(copied.replace(/\s+/g, " ")).toContain(
      selected
        .replace(/(^|\s)>(?=\s|$)/g, "$1")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 40),
    );
  } finally {
    activity.stop();
    await session.close();
  }
});

test("a held button stops follow scrolling and a click resumes it", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const session = await openLiveSession(page);
  const scroller = page.locator("main[data-session-messages]");
  const metrics = () =>
    scroller.evaluate((node) => ({
      height: node.scrollHeight,
      fromBottom: node.scrollHeight - node.clientHeight - node.scrollTop,
    }));
  const activity = session.startActivity({ deltasOnly: true });
  try {
    // Precondition: the live tail grows and the view follows it.
    await expect
      .poll(() => page.getByText("Streamed paragraph 5").count())
      .toBeGreaterThan(0);
    const followingFrom = await metrics();
    await page.waitForTimeout(800);
    const followingTo = await metrics();
    expect(followingTo.height).toBeGreaterThan(followingFrom.height);
    expect(followingTo.fromBottom).toBeLessThan(4);

    const box = await scroller.boundingBox();
    if (!box) throw new Error("Missing transcript scroller");
    const point = await scroller.evaluate((viewport) => {
      const content = viewport.querySelector("[data-message-list]");
      if (!content) return null;
      const bounds = viewport.getBoundingClientRect();
      const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const text = node as Text;
        if (text.data.trim().length < 8) continue;
        const range = document.createRange();
        range.selectNodeContents(text);
        // A fixed-font streamed block can be one text node spanning many
        // lines. Its first character may be above the viewport.
        for (const rect of range.getClientRects()) {
          if (
            rect.top < bounds.top + 40 ||
            rect.bottom > bounds.bottom - 40 ||
            rect.width < 2
          )
            continue;
          const x = rect.left + Math.min(4, rect.width / 2);
          const y = rect.top + rect.height / 2;
          const hit = document.elementFromPoint(x, y);
          // caretRangeFromPoint can return nearest text while the actual
          // press lands on MAIN padding. Use a rendered, hit-tested line.
          if (
            hit &&
            content.contains(hit) &&
            hit.contains(text) &&
            !hit.closest(
              "button, input, textarea, select, a[href], [contenteditable='true']",
            )
          )
            return { x, y };
        }
      }
      return null;
    });
    if (!point) throw new Error("No transcript text at the press point");
    const under = () =>
      page.evaluate(
        ({ x, y }) => {
          const range = document.caretRangeFromPoint(x, y);
          return range?.startContainer.textContent?.slice(0, 30) ?? "";
        },
        { x: point.x, y: point.y },
      );
    await page.mouse.move(point.x, point.y);
    await page.mouse.down();
    const before = await under();
    const heldFrom = await metrics();
    const seen: string[] = [];
    for (let sample = 0; sample < 12; sample++) {
      await page.waitForTimeout(100);
      seen.push(await under());
    }
    const heldTo = await metrics();
    // Output kept arriving below, and the text under the button never moved.
    expect(heldTo.height).toBeGreaterThan(heldFrom.height);
    expect(heldTo.fromBottom).toBeGreaterThan(heldFrom.fromBottom);
    expect(new Set(seen)).toEqual(new Set([before]));

    // Released without moving: a click, so following resumes.
    await page.mouse.up();
    await expect
      .poll(() =>
        scroller.evaluate(
          (node) => node.scrollHeight - node.clientHeight - node.scrollTop,
        ),
      )
      .toBeLessThan(4);
  } finally {
    activity.stop();
    await session.close();
  }
});
