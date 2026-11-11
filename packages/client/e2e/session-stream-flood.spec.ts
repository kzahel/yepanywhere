import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import {
  decodeJsonFrame,
  type RemoteClientMessage,
} from "@yep-anywhere/shared";
import { readCollectionsOverRest } from "./support/managed-routes";
import { createTestViteServer } from "./support/vite-server";
import {
  startYaServerProcess,
  disposeYaServerProcess,
} from "./support/ya-server-process";

test.use({ serviceWorkers: "block" });

// A live session stream that delivers events faster than the page commits used
// to trip React's nested-update limit ("Maximum update depth exceeded"): the tab
// froze for the run-up and, when the throw landed inside a commit, went blank.
// Contract: topics/client-stream-dispatch-coalescing.md. Delta-only floods were
// already throttled; full non-delta messages were the crash path, so the flood
// mixes both. Tunables: FLOOD_ROWS, FLOOD_GAP_MS, FLOOD_MS, FLOOD_MODE
// (mixed | deltas | system).
test("a sustained stream flood does not trip React's update-depth limit", async ({
  page,
}) => {
  test.setTimeout(240_000);
  const projectPath = dirname(dirname(fileURLToPath(import.meta.url)));
  const backend = await startYaServerProcess({ label: "flood repro" });
  const source = await createTestViteServer({
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
  const rowCount = Number(process.env.FLOOD_ROWS ?? 60);
  const gapMs = Number(process.env.FLOOD_GAP_MS ?? 4);
  const floodMs = Number(process.env.FLOOD_MS ?? 6000);
  const mode = process.env.FLOOD_MODE ?? "mixed";
  const rows = [
    {
      id: "flood-a",
      title: "Flood A",
      fullTitle: "Flood A",
      projectId,
      projectName: "Flood test",
      provider: "claude",
      activity: "in-turn",
      ownership: { owner: "none" },
      createdAt: new Date(now - 60_000).toISOString(),
      updatedAt: new Date(now - 60_000).toISOString(),
      messageCount: rowCount * 2,
    },
  ];
  const errors: string[] = [];
  const consoleErrors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message.slice(0, 200)));
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text().slice(0, 200));
  });
  await readCollectionsOverRest(page);
  await page.route(/\/api\/sessions(?:\?|$)/, (route) =>
    route.fulfill({
      json: {
        sessions:
          new URL(route.request().url()).searchParams.get("starred") === "true"
            ? []
            : rows,
        hasMore: false,
        total: rows.length,
      },
    }),
  );
  await page.route(
    /\/api\/projects\/[^/]+\/sessions\/flood-a(?:\?|$)/,
    (route) => {
      const messages: object[] = [];
      for (let i = 0; i < rowCount; i++) {
        messages.push({
          uuid: `u-${i}`,
          type: "user",
          content: `User message ${i}: please look at the code and explain it carefully.`,
        });
        messages.push({
          uuid: `a-${i}`,
          type: "assistant",
          content: [
            {
              type: "text",
              text: `Assistant reply ${i}.\n\nSome **markdown** with a list:\n\n- one\n- two\n- three\n\n\`\`\`ts\nconst x = ${i};\nfunction f(y: number) { return y + x; }\n\`\`\`\n\nMore text after the code block to make the row taller.`,
            },
          ],
        });
      }
      return route.fulfill({
        json: {
          session: rows[0],
          messages,
          ownership: { owner: "self", processId: "proc-flood-a" },
        },
      });
    },
  );
  await page.route(/\/api\/sessions\/flood-a\/process$/, (route) =>
    route.fulfill({
      json: {
        process: {
          sessionId: "flood-a",
          state: "in-turn",
          activity: "in-turn",
        },
      },
    }),
  );
  const sessionEmitters: Array<(event: object) => void> = [];
  await page.routeWebSocket("**/api/ws", (socket) => {
    const upstream = socket.connectToServer();
    socket.onMessage((message) => {
      const data =
        typeof message === "string"
          ? (JSON.parse(message) as RemoteClientMessage)
          : decodeJsonFrame<RemoteClientMessage>(message);
      if (data.type === "subscribe") {
        console.log(
          `[flood] subscribe channel=${data.channel} sessionId=${(data as { sessionId?: string }).sessionId ?? ""}`,
        );
      }
      if (
        data.type === "subscribe" &&
        data.channel === "session" &&
        (data as { sessionId?: string }).sessionId === "flood-a"
      ) {
        let eventSeq = 0;
        sessionEmitters.push((payload) =>
          socket.send(
            JSON.stringify({
              type: "event",
              subscriptionId: data.subscriptionId,
              eventType: "message",
              eventId: String(++eventSeq),
              data: payload,
            }),
          ),
        );
        return;
      }
      upstream.send(message);
    });
  });
  const responsive = async (label: string) => {
    const t0 = Date.now();
    const ok = await Promise.race([
      page.evaluate(
        () =>
          new Promise<boolean>((resolve) =>
            requestAnimationFrame(() => setTimeout(() => resolve(true), 0)),
          ),
      ),
      new Promise<boolean>((r) => setTimeout(() => r(false), 10_000)),
    ]);
    console.log(`[flood] ${label}: responsive=${ok} in ${Date.now() - t0}ms`);
    return ok;
  };
  try {
    await source.listen();
    const address = source.httpServer?.address();
    if (!address || typeof address === "string")
      throw new Error("Missing Vite port");
    const origin = `http://127.0.0.1:${address.port}`;
    await page.setViewportSize({ width: 1200, height: 700 });
    await page.addInitScript(() => {
      localStorage.setItem("yep-anywhere-session-dom-linger-enabled", "true");
      localStorage.setItem(
        "yep-anywhere-session-transcript-cache-budget-mb",
        "256",
      );
    });
    await page.goto(`${origin}/projects/${projectId}/sessions/flood-a`);
    const composer = page.locator("[data-composer-input]");
    await expect(composer).toBeVisible({ timeout: 30_000 });
    await expect
      .poll(() => sessionEmitters.length, { timeout: 15_000 })
      .toBeGreaterThan(0);
    await page.waitForTimeout(1500);
    await responsive("before flood");
    const emit = sessionEmitters[0]!;
    let sent = 0;
    const start = Date.now();
    let textAccum = "";
    const timer = setInterval(() => {
      if (Date.now() - start > floodMs) {
        clearInterval(timer);
        return;
      }
      sent++;
      if (mode === "system" || (mode === "mixed" && sent % 3 === 0)) {
        emit({
          type: "system",
          subtype: "thinking_tokens",
          uuid: `sys-${sent}`,
          session_id: "flood-a",
          thinking_tokens: sent,
          timestamp: new Date().toISOString(),
        });
      } else {
        textAccum += `token${sent} `;
        emit({
          type: "stream_event",
          uuid: `se-${sent}`,
          session_id: "flood-a",
          parent_tool_use_id: null,
          event: {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: `token${sent} ` },
          },
          timestamp: new Date().toISOString(),
        });
      }
    }, gapMs);
    const probes: string[] = [];
    while (Date.now() - start < floodMs + 500) {
      const t0 = Date.now();
      const ok = await Promise.race([
        page.evaluate(
          () =>
            new Promise<boolean>((resolve) =>
              requestAnimationFrame(() => resolve(true)),
            ),
        ),
        new Promise<boolean>((r) => setTimeout(() => r(false), 5000)),
      ]);
      probes.push(`${ok ? "ok" : "STALL"}:${Date.now() - t0}ms`);
      await new Promise((r) => setTimeout(r, 250));
    }
    clearInterval(timer);
    console.log(
      `[flood] mode=${mode} sent=${sent} rows=${rowCount} gap=${gapMs}ms textLen=${textAccum.length}`,
    );
    console.log(`[flood] frame probes during flood: ${probes.join(" ")}`);
    await page.waitForTimeout(1000);
    await responsive("after flood");
    console.log(`[flood] pageerrors: ${JSON.stringify(errors.slice(0, 10))}`);
    console.log(
      `[flood] console errors: ${JSON.stringify(consoleErrors.slice(0, 10))}`,
    );
    const depth = [...errors, ...consoleErrors].filter((e) =>
      /Maximum update depth|#185/.test(e),
    );
    console.log(`[flood] max-update-depth hits: ${depth.length}`);
    expect(depth).toEqual([]);
    expect(errors).toEqual([]);
    expect(await responsive("final")).toBe(true);
    await expect(composer).toBeVisible();
  } finally {
    await source.close();
    await disposeYaServerProcess(backend);
  }
});
