import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import {
  decodeJsonFrame,
  type RemoteClientMessage,
} from "@yep-anywhere/shared";
import { readCollectionsOverRest } from "./support/managed-routes";
import { recordUiCapture } from "./support/ui-capture";
import { createTestViteServer } from "./support/vite-server";
import {
  startYaServerProcess,
  disposeYaServerProcess,
} from "./support/ya-server-process";

test.use({ serviceWorkers: "block" });

test("sidebar follows user sends while visits and background work stay put", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const projectPath = dirname(dirname(fileURLToPath(import.meta.url)));
  const backend = await startYaServerProcess({ label: "sidebar order test" });
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
  const rows = ["a", "b", "c"].map((id, index) => ({
    id: `sidebar-${id}`,
    title: `Session ${id.toUpperCase()}`,
    fullTitle: `Session ${id.toUpperCase()}`,
    projectId,
    projectName: "Sidebar test",
    provider: "claude",
    activity: "idle",
    ownership: { owner: "none" },
    createdAt: new Date(now - (index + 1) * 60_000).toISOString(),
    updatedAt: new Date(now - (index + 1) * 60_000).toISOString(),
    isStarred: false,
    sidebarCategory: undefined as string | undefined,
    messageCount: 1,
  }));
  const oldStar = {
    ...rows[0]!,
    id: "sidebar-old",
    title: "Old star",
    fullTitle: "Old star",
    isStarred: true,
    createdAt: new Date(now - 7 * 86400000).toISOString(),
  };
  rows.push(oldStar);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await readCollectionsOverRest(page);
  // Exercise fresh collection replacement on the compatible three-feed path.
  // Default snapshot acquisition was rejected by the scale comparison.
  await page.route("**/api/version*", async (route) => {
    const payload = await (await route.fetch()).json();
    for (const key of Object.keys(payload))
      if (key.toLowerCase().includes("capabilit")) delete payload[key];
    return route.fulfill({
      json: {
        ...payload,
        current: "0.11.0",
        latest: null,
        updateAvailable: false,
        capabilities: [
          "sidebar-session-snapshot",
          "sidebar-session-categories",
          "progressive-session-catalog",
        ],
      },
    });
  });
  let snapshots = 0;
  await page.route(/\/api\/sessions(?:\?|$)/, (route) => {
    snapshots++;
    const query = new URL(route.request().url()).searchParams;
    const sessions =
      query.get("starred") === "true"
        ? rows.filter((row) => row.isStarred)
        : query.get("categorized") === "true"
          ? rows.filter((row) => row.sidebarCategory)
          : rows.filter((row) => row.id !== oldStar.id);
    return route.fulfill({
      json: {
        sessions,
        hasMore: false,
        total: sessions.length,
        catalog: {
          complete: true,
          refreshing: false,
          catalogEpoch: "test",
          catalogGeneration: 1,
        },
      },
    });
  });
  await page.route(/\/api\/sessions\/sidebar(?:\?|$)/, () => {
    throw Error("Unqualified snapshot cutover");
  });
  await page.route(
    /\/api\/projects\/[^/]+\/sessions\/sidebar-[abc](?:\?|$)/,
    (route) => {
      const id = new URL(route.request().url()).pathname.split("/").at(-1);
      return route.fulfill({
        json: {
          session: rows.find((row) => row.id === id),
          messages: [
            {
              uuid: "opening",
              type: "user",
              content: "Keep this session easy to select.",
            },
          ],
          ownership: { owner: "none" },
        },
      });
    },
  );
  await page.route(/\/api\/sessions\/sidebar-[abc]\/process$/, (route) =>
    route.fulfill({ json: { process: null } }),
  );
  let sendCount = 0;
  await page.route(
    /\/api\/projects\/[^/]+\/sessions\/sidebar-[abc]\/resume$/,
    (route) => {
      sendCount++;
      return route.fulfill({
        status: 503,
        json: {
          error: "Inert browser test; submission intentionally unavailable",
        },
      });
    },
  );
  const activityListeners: Array<(type: string, data: object) => void> = [];
  await page.routeWebSocket("**/api/ws", (socket) => {
    const upstream = socket.connectToServer();
    socket.onMessage((message) => {
      const data =
        typeof message === "string"
          ? (JSON.parse(message) as RemoteClientMessage)
          : decodeJsonFrame<RemoteClientMessage>(message);
      if (data.type === "subscribe" && data.channel === "activity") {
        activityListeners.push((eventType, payload) =>
          socket.send(
            JSON.stringify({
              type: "event",
              subscriptionId: data.subscriptionId,
              eventType,
              eventId: `sidebar-${Date.now()}-${Math.random()}`,
              data: payload,
            }),
          ),
        );
      }
      upstream.send(message);
    });
  });
  try {
    await source.listen();
    const address = source.httpServer?.address();
    if (!address || typeof address === "string")
      throw new Error("Missing Vite port");
    const origin = `http://127.0.0.1:${address.port}`;
    for (const viewport of [
      { name: "desktop", width: 1000, height: 600 },
      { name: "phone", width: 375, height: 812 },
    ]) {
      const resetRow = rows.find((row) => row.id === "sidebar-c");
      if (!resetRow) throw new Error("Missing sidebar-c fixture row");
      oldStar.isStarred = true;
      resetRow.isStarred = false;
      resetRow.sidebarCategory = undefined;
      resetRow.title = "Session C";
      resetRow.fullTitle = "Session C";
      await page.setViewportSize(viewport);
      activityListeners.length = 0;
      await page.goto(`${origin}/projects/${projectId}/sessions/sidebar-a`);
      const composer = page.locator("[data-composer-input]");
      await expect(composer).toBeVisible({ timeout: 30_000 });
      // Sends from the previous viewport persist; start each from the
      // creation-time order the assertions below expect.
      await page.evaluate(() =>
        localStorage.removeItem("yep-sidebar-submissions:local"),
      );
      await page.reload();
      await expect(composer).toBeVisible({ timeout: 30_000 });
      await page
        .getByRole("button", { name: "Open sidebar", exact: true })
        .click();
      const list = page.locator(
        "[data-sidebar]:visible #sidebar-last-24-hours-list",
      );
      // A compact row links to its session twice: the title link and the
      // trailing project-name link. Match only the title link, so an index is
      // a row, and assert the count so a third link per row fails loudly here
      // instead of silently shifting what nth(1) clicks.
      const links = list.locator(
        'a[data-session-list-item__link][href*="/sessions/sidebar-"]',
      );
      const titles = links.locator("[data-session-list-item__title-text]");
      await expect(links).toHaveCount(3);
      await expect(titles).toHaveText(["Session A", "Session B", "Session C"]);
      const target = links.nth(1);
      await target.hover();
      const before = await target.boundingBox();
      const visitsBeforeActivity = await page.evaluate(() =>
        localStorage.getItem("yep-sidebar-submissions:local"),
      );
      await expect.poll(() => activityListeners.length).toBeGreaterThan(0);
      const updatedRow = rows.find((row) => row.id === "sidebar-c");
      if (!updatedRow) throw new Error("Missing sidebar-c fixture row");
      updatedRow.title = "Session C updated";
      updatedRow.fullTitle = "Session C updated";
      for (const emit of activityListeners) {
        emit("process-state-changed", {
          type: "process-state-changed",
          projectId,
          sessionId: "sidebar-c",
          activity: "in-turn",
          timestamp: new Date().toISOString(),
        });
        emit("session-updated", {
          type: "session-updated",
          projectId,
          sessionId: "sidebar-c",
          updatedAt: new Date().toISOString(),
          title: "Session C updated",
          timestamp: new Date().toISOString(),
        });
      }
      await expect(titles).toHaveText([
        "Session A",
        "Session B",
        "Session C updated",
      ]);
      expect(await target.boundingBox()).toEqual(before);
      expect(
        await page.evaluate(() =>
          localStorage.getItem("yep-sidebar-submissions:local"),
        ),
      ).toBe(visitsBeforeActivity);
      // Opening a session is reading, not activity: the row stays where it
      // was and nothing is recorded for it.
      await target.click();
      await expect(page).toHaveURL(/\/sessions\/sidebar-b$/);
      await expect(composer).toBeVisible();
      await composer.focus();
      await page.mouse.move(viewport.width - 1, viewport.height - 1);
      await page
        .getByRole("button", { name: "Open sidebar", exact: true })
        .click();
      await expect(titles).toHaveText([
        "Session A",
        "Session B",
        "Session C updated",
      ]);
      expect(
        await page.evaluate(() =>
          localStorage.getItem("yep-sidebar-submissions:local"),
        ),
      ).toBe(visitsBeforeActivity);
      await expect(
        page.getByText("Server changed", { exact: false }),
      ).toHaveCount(0);
      // Fresh snapshots move membership while both pointer and keyboard focus
      // remain inside. The old interaction hold kept this row in its old section.
      await target.hover();
      await target.focus();
      const beforeSnapshot = snapshots;
      updatedRow.isStarred = true;
      updatedRow.sidebarCategory = "Review";
      const notifyMetadata = () => {
        for (const emit of activityListeners)
          emit("session-metadata-changed", {
            type: "session-metadata-changed",
            projectId,
            sessionId: updatedRow.id,
            starred: updatedRow.isStarred,
            sidebarCategory: updatedRow.sidebarCategory ?? null,
            timestamp: new Date().toISOString(),
          });
        for (const emit of activityListeners) emit("refresh", {});
      };
      notifyMetadata();
      await expect.poll(() => snapshots).toBeGreaterThan(beforeSnapshot);
      await expect(links).toHaveCount(2);
      updatedRow.isStarred = false;
      updatedRow.sidebarCategory = undefined;
      notifyMetadata();
      await expect(links).toHaveCount(3);
      await expect(titles).toHaveText([
        "Session A",
        "Session B",
        "Session C updated",
      ]);
      // Simulate an edit missed while disconnected: the old row is outside
      // every replacement window, so cached entity flags must not resurrect it.
      const oldLink = page.locator(
        '[data-sidebar]:visible a[data-session-list-item__link][href*="/sessions/sidebar-old"]',
      );
      await expect(oldLink).toHaveCount(1);
      oldStar.isStarred = false;
      for (const emit of activityListeners) emit("refresh", {});
      await expect(oldLink).toHaveCount(0);
      await recordUiCapture(page, `sidebar-order-${viewport.name}`, viewport);
      // An earlier send elsewhere in this browser must not hide a subsequent
      // send's user activity. No provider is invoked: the test endpoint
      // rejects it.
      await page.keyboard.press("Escape");
      const activityModule = "/src/lib/sessionInteractionOrder.ts";
      await page.evaluate(async (modulePath) => {
        const module = await import(modulePath);
        module.recordSessionInteraction("local", "sidebar-a");
      }, activityModule);
      await composer.fill("User submission raises B again");
      const previousSendCount = sendCount;
      await composer.press("Enter");
      await expect.poll(() => sendCount).toBeGreaterThan(previousSendCount);
      await expect
        .poll(() =>
          page.evaluate(() => {
            const value = localStorage.getItem("yep-sidebar-submissions:local");
            return value ? JSON.parse(value)[0][0] : null;
          }),
        )
        .toBe("sidebar-b");
      await page.reload();
      // A reload reboots the dev client with the browser cache off (routes
      // are installed); a slow runner can spend over 5 s refetching modules.
      await expect(composer).toBeVisible({ timeout: 30_000 });
      await page
        .getByRole("button", { name: "Open sidebar", exact: true })
        .click();
      await expect(titles).toHaveText([
        "Session B",
        "Session A",
        "Session C updated",
      ]);
    }
    expect(errors).toEqual([]);
  } finally {
    await source.close();
    await disposeYaServerProcess(backend);
  }
});
