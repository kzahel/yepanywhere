import { join } from "node:path";
import type { Locator } from "@playwright/test";
import {
  decodeJsonFrame,
  type IssueCoverage,
  type RemoteClientMessage,
} from "@yep-anywhere/shared";
import { e2ePaths, expect, test } from "./fixtures.js";
import {
  readCollectionsOverRest,
  routeWithDrain,
} from "./support/managed-routes.js";
import { recordUiCapture } from "./support/ui-capture.js";

test.use({ serviceWorkers: "block", hasTouch: true });

async function expectHeaderSizing(header: Locator, controlSize: number) {
  await expect.poll(async () => (await header.boundingBox())?.height).toBe(44);
  const controls = header.locator(
    "[data-sidebar-toggle], [data-provider-badge-button], [data-session-menu-trigger]",
  );
  const row = (await header.boundingBox())!;
  for (const control of await controls.all()) {
    const box = (await control.boundingBox())!;
    expect(box.height).toBe(controlSize);
    expect(box.width).toBeGreaterThanOrEqual(controlSize);
    expect(box.y + box.height / 2).toBe(row.y + row.height / 2);
  }
}

// Real header geometry, caret/focus, and sequential typing during streamed
// transcript updates require the integrated SessionPage in a browser.
test("header preserves identity, overflow actions and rename typing during live updates", async ({
  page,
  baseURL,
  browser,
}) => {
  const projectId = Buffer.from(join(e2ePaths.tempDir, "mockproject")).toString(
    "base64url",
  );
  const sessionId = "mock-session-001";
  const timestamp = new Date().toISOString();
  let title = "Investigate Android workspaces";
  const desktopTitle =
    "Keep project identity visible during long conversations";
  const saves: string[] = [];
  let refuseSave = false;
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    localStorage.setItem("yep-anywhere-project-code-names-enabled", "true");
  });
  await readCollectionsOverRest(page);
  await routeWithDrain(page, /\/api\/projects(?:\?|$)/, async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({
      json: {
        ...body,
        projects: body.projects.map((project: { id: string }) =>
          project.id === projectId
            ? { ...project, name: "tomfit-content-service", codeName: "tfc" }
            : project,
        ),
      },
    });
  });
  await routeWithDrain(
    page,
    /\/api\/projects\/[^/?]+(?:\?|$)/,
    async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      await route.fulfill({
        json: {
          ...body,
          project: {
            ...body.project,
            name: "tomfit-content-service",
            codeName: "tfc",
          },
        },
      });
    },
  );
  await routeWithDrain(page, "**/api/settings", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({
      json: {
        ...body,
        settings: {
          ...body.settings,
          hostIdentity: { icon: "🍏" },
          publicSharesEnabled: true,
          issueAssociations: { enabled: true, scope: "viewed", recentDays: 7 },
        },
      },
    });
  });
  await page.route("**/api/public-shares/status", (route) =>
    route.fulfill({
      json: {
        storageState: "ready",
        canCreate: true,
        configured: true,
        enabled: true,
      },
    }),
  );
  await page.route("**/api/public-shares/sessions/**", (route) =>
    route.fulfill({
      json: {
        storageState: "ready",
        activeCount: 2,
        liveCount: 1,
        frozenCount: 1,
        activeViewerCount: 1,
        viewers: [],
      },
    }),
  );
  await page.route("**/api/issues?*", (route) =>
    route.fulfill({
      json: {
        items: [
          {
            id: "github:example/workspaces:52",
            key: "example/workspaces#52",
            kind: "pr",
            provider: "github",
            title: "Review workspace storage",
            sessionCount: 1,
          },
        ],
        nextOffset: null,
        coverage: {
          settings: { enabled: true, scope: "viewed", recentDays: 7 },
          active: false,
          error: null,
          counts: [],
        } satisfies IssueCoverage,
      },
    }),
  );
  const ownership = { owner: "self", processId: "header-process" };
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
            title,
            effectiveModelSettings: {
              requestedModel: "gpt-6.1-sol",
              thinking: { type: "enabled" },
              effort: "high",
            },
            createdAt: timestamp,
            updatedAt: timestamp,
            ownership,
            messageCount: 240,
          },
          ownership,
          processState: "in-turn",
          messages: Array.from({ length: 240 }, (_, i) => ({
            uuid: `header-history-${i}`,
            type: i % 2 ? "assistant" : "user",
            timestamp,
            content:
              i % 2
                ? `Review ${i}: preserve durable workspace access and verify writes after restart.`
                : `Check workspace requirement ${i}.`,
          })),
        },
      }),
  );
  await page.route(`**/api/sessions/${sessionId}/metadata`, (route) => {
    const nextTitle = route.request().postDataJSON().title;
    saves.push(nextTitle);
    if (refuseSave)
      return route.fulfill({ status: 409, json: { error: "Try again" } });
    title = nextTitle;
    return route.fulfill({ json: { updated: true } });
  });
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
              processId: "header-process",
              state: "in-turn",
              provider: "codex",
            },
          }),
        );
      } else upstream.send(wire);
    });
  });
  await page.setViewportSize({ width: 1000, height: 600 });
  await page.goto(`${baseURL}/projects/${projectId}/sessions/${sessionId}`);
  const header = page.locator("header[data-session-header]");
  const menu = header.getByRole("button", {
    name: "Session options",
    exact: true,
  });
  await expect(header).toHaveAttribute("data-header-layout", "full");
  await expect(header.locator("[data-project-breadcrumb]")).toHaveText("tfc");
  await expect(header.locator("[data-session-title-text]")).toHaveText(title);
  await expect(
    header.getByRole("button", {
      name: "1 issue or pull request associated with this session",
    }),
  ).toBeVisible();
  await expect.poll(() => Boolean(emit)).toBe(true);
  await expectHeaderSizing(header, 44);
  await recordUiCapture(page, "session-header-desktop");

  await menu.click();
  await page.getByRole("menuitem", { name: "Rename...", exact: true }).click();
  const input = page.getByRole("textbox", {
    name: "Session title",
    exact: true,
  });
  await expect(input).toBeFocused();
  await expect(
    page.getByRole("dialog", { name: "Rename session" }),
  ).toHaveCount(0);
  await page.setViewportSize({ width: 375, height: 812 });
  await expect(input).toBeFocused();
  expect((await input.boundingBox())!.width).toBeGreaterThan(180);
  await page.setViewportSize({ width: 1000, height: 600 });
  await input.pressSequentially(desktopTitle);
  await input.press("Enter");
  await expect(header.locator("[data-session-title-text]")).toHaveText(
    desktopTitle,
  );

  // The same tier returns on widening; overflow never competes with the title.
  const projectLink = header.getByRole("link", {
    name: "tomfit-content-service",
    exact: true,
  });
  await page.setViewportSize({ width: 375, height: 812 });
  await expect(projectLink).toBeInViewport();
  await expect(projectLink).toHaveText("tfc");
  await recordUiCapture(page, "session-header-code-phone");
  // Simulate the preference change broadcast by another tab. The ordinary
  // name must remain legible even when a long title competes for the row.
  await page.evaluate(() => {
    const key = "yep-anywhere-project-code-names-enabled";
    localStorage.setItem(key, "false");
    window.dispatchEvent(
      new StorageEvent("storage", { key, newValue: "false" }),
    );
  });
  await expect(projectLink).toHaveText("tomfit-content-service");
  const titleFontSize = await header
    .locator("[data-session-title]")
    .evaluate((element) => getComputedStyle(element).fontSize);
  for (const width of [320, 375, 599, 600, 601, 650, 720, 1000, 650, 375]) {
    await page.setViewportSize({ width, height: 812 });
    await expect(header).toHaveAttribute(
      "data-header-layout",
      width >= 720 ? "full" : width >= 600 ? "compact" : "narrow",
    );
    await expect(menu).toBeInViewport();
    expect(
      await header
        .locator("[data-session-title]")
        .evaluate((element) => getComputedStyle(element).fontSize),
    ).toBe(titleFontSize);
    await expect(projectLink).toBeInViewport();
    const projectBox = (await projectLink.boundingBox())!;
    const titleBox = (await header
      .locator("[data-session-title-row]")
      .boundingBox())!;
    expect(projectBox.width).toBeGreaterThanOrEqual(50);
    expect(projectBox.x + projectBox.width).toBeLessThanOrEqual(titleBox.x);
    await expectHeaderSizing(header, 44);
  }
  await expect(projectLink).toHaveAttribute(
    "href",
    `/sessions?project=${projectId}`,
  );
  expect(
    await projectLink.evaluate(
      (element) => element.scrollWidth > element.clientWidth,
    ),
  ).toBe(true);
  await expect(header.locator("[data-provider-badge]")).toHaveText("So 6.1H");
  await expect(header.locator("[data-session-title-text]")).toBeVisible();
  await expect(
    header.getByRole("button", {
      name: "1 issue or pull request associated with this session",
    }),
  ).toHaveCount(0);
  const geometry = await header.evaluate((element) => {
    const title = element
      .querySelector("[data-session-title-text]")!
      .getBoundingClientRect();
    const menu = element
      .querySelector("[data-session-menu-trigger]")!
      .getBoundingClientRect();
    return {
      titleWidth: title.width,
      menuRight: menu.right,
      width: innerWidth,
      scroll: document.documentElement.scrollWidth,
    };
  });
  expect(geometry.titleWidth).toBeGreaterThan(50);
  expect(geometry.menuRight).toBeLessThanOrEqual(geometry.width);
  expect(geometry.scroll).toBeLessThanOrEqual(geometry.width);
  await recordUiCapture(page, "session-header-phone");
  await menu.click();
  await expect(
    page.getByRole("menuitem", {
      name: "1 issue or pull request associated with this session",
    }),
  ).toHaveAttribute(
    "href",
    `/issues?sessionId=${sessionId}&projectId=${projectId}`,
  );
  await expect(
    page.getByRole("menuitem", { name: /Share.*1 viewers.*2 links/ }),
  ).toBeVisible();
  await page.getByRole("menuitem", { name: "Rename...", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Rename session" });
  await expect(dialog).toBeVisible();
  await expect(input).toBeFocused();
  expect((await dialog.boundingBox())!.height).toBeLessThan(300);
  expect((await input.boundingBox())!.width).toBeGreaterThan(250);
  await input.evaluate((element) => {
    element.addEventListener("keydown", () => performance.mark("rename-key"));
    element.addEventListener("input", () => {
      requestAnimationFrame(() =>
        performance.measure("rename-ack", "rename-key"),
      );
    });
  });
  let typed = "";
  for (const character of "yahost saf") {
    emit?.({
      uuid: "header-live",
      id: "header-live",
      type: "assistant",
      _isStreaming: true,
      timestamp,
      message: {
        role: "assistant",
        content: `Checking workspace storage ${typed.length}.`,
      },
    });
    await input.pressSequentially(character);
    typed += character;
    await expect(input).toHaveValue(typed, { timeout: 100 });
    expect(
      await input.evaluate(
        (element) => (element as HTMLInputElement).selectionStart,
      ),
    ).toBe(typed.length);
  }
  await expect(
    page.getByText("Checking workspace storage 9.", { exact: true }),
  ).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() => performance.getEntriesByName("rename-ack").length),
    )
    .toBe(10);
  const acknowledgementMs = await page.evaluate(() =>
    performance.getEntriesByName("rename-ack").map((entry) => entry.duration),
  );
  expect(Math.max(...acknowledgementMs)).toBeLessThan(100);
  await recordUiCapture(page, "session-rename-phone");
  // Keyboard dismissal/blur does not save. Rotation keeps the original field.
  await dialog.getByText("Rename session", { exact: true }).click();
  expect(saves).toEqual([desktopTitle]);
  await page.setViewportSize({ width: 1000, height: 450 });
  await expect(dialog).toBeVisible();
  await expect(input).toHaveValue("yahost saf");
  // An IME Enter must not submit the form.
  await input.dispatchEvent("keydown", {
    key: "Enter",
    code: "Enter",
    isComposing: true,
    keyCode: 229,
  });
  expect(saves).toHaveLength(1);
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(saves).toHaveLength(1);

  await page.setViewportSize({ width: 375, height: 812 });
  await menu.click();
  await page.getByRole("menuitem", { name: "Rename...", exact: true }).click();
  await input.pressSequentially("Retry title");
  refuseSave = true;
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog.getByRole("alert")).toHaveText(
    "Failed to rename session",
  );
  await expect(input).toHaveValue("Retry title");
  refuseSave = false;
  await input.press("Enter");
  await expect(dialog).toHaveCount(0);
  await expect(header.locator("[data-session-title-text]")).toHaveText(
    "Retry title",
  );
  // The shared dialog history entry lets Android Back cancel without a save.
  await menu.click();
  await page.getByRole("menuitem", { name: "Rename...", exact: true }).click();
  await input.pressSequentially("Unsaved");
  await page.goBack();
  await expect(dialog).toHaveCount(0);
  expect(saves).toEqual([desktopTitle, "Retry title", "Retry title"]);
  await menu.click();
  await page
    .getByRole("menuitem", {
      name: "1 issue or pull request associated with this session",
    })
    .click();
  await expect(page).toHaveURL(/\/issues\?/);
  await expect(
    page.getByRole("region", { name: "Issue search results" }),
  ).toBeVisible();
  await expectHeaderSizing(page.locator("header[data-session-header]"), 44);
  await expect(
    page.getByRole("menuitem", { name: "Rename...", exact: true }),
  ).toHaveCount(0);
  expect(errors).toEqual([]);

  // A mouse pointer keeps the same row height with smaller, equal targets.
  const mousePage = await browser.newPage({
    hasTouch: false,
    viewport: { width: 1000, height: 600 },
    serviceWorkers: "block",
  });
  try {
    await mousePage.goto(
      `${baseURL}/projects/${projectId}/sessions/${sessionId}`,
    );
    const mouseHeader = mousePage.locator("header[data-session-header]");
    await expect(
      mouseHeader.locator("[data-session-menu-trigger]"),
    ).toBeVisible();
    await expectHeaderSizing(mouseHeader, 36);
    await recordUiCapture(mousePage, "session-header-mouse-desktop");
    await mousePage.goto(`${baseURL}/projects`);
    await expectHeaderSizing(
      mousePage.locator("header[data-session-header]"),
      36,
    );
  } finally {
    await mousePage.close();
  }
});
