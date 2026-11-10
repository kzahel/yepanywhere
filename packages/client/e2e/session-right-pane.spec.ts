import { join } from "node:path";
import { e2ePaths, expect, test } from "./fixtures.js";
import { recordUiCapture } from "./support/ui-capture.js";
import {
  encodeVersionedServerCapabilities,
  SERVER_CAPABILITIES,
  serverHasCapability,
} from "@yep-anywhere/shared";

const projectId = Buffer.from(join(e2ePaths.tempDir, "mockproject")).toString(
  "base64url",
);
const sessionId = "mock-session-001";
test.use({
  serviceWorkers: "block",
  // Chromium headless otherwise hides native scrollbars from captures.
  launchOptions: {
    chromiumSandbox: true,
    ignoreDefaultArgs: ["--hide-scrollbars"],
  },
});

test("right pane discovers tool apps, resizes, parks and preserves typing", async ({
  page,
  baseURL,
}) => {
  test.setTimeout(90_000);
  const timestamp = new Date().toISOString();
  const messages = Array.from({ length: 240 }, (_, index) => ({
    uuid: `history-${index}`,
    type: index % 2 ? "assistant" : "user",
    timestamp,
    content: `Review item ${index}: preserve the conversation and the reader's place.`,
  }));
  const result = {
    uuid: "app-result",
    type: "user",
    timestamp,
    content: [
      {
        type: "tool_result",
        tool_use_id: "app-tool",
        content: "Plannotator running at http://localhost:19432/review",
      },
    ],
  };
  await page.addInitScript(() => {
    localStorage.setItem("yep-anywhere-session-right-pane-enabled", "true");
  });
  await page.route("**/api/version*", async (route) => {
    const response = await route.fetch();
    const metadata = await response.json();
    await route.fulfill({
      json: {
        ...metadata,
        ...encodeVersionedServerCapabilities(
          [
            ...Object.values(SERVER_CAPABILITIES)
              .filter((capability) =>
                serverHasCapability(metadata, capability.name),
              )
              .map((capability) => capability.name),
            SERVER_CAPABILITIES.vhostAppControl.name,
            SERVER_CAPABILITIES.artifactViewer.name,
            SERVER_CAPABILITIES.vhostBearerAccess.name,
          ],
          "0.8.2",
        ),
        artifactViewer: {
          port: 4402,
          available: true,
          locked: false,
          defaultLocalOrigin: baseURL,
          localOrigin: baseURL,
          vhosts: [{ name: "plan", port: 19432 }],
        },
      },
    });
  });
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
            provider: "claude",
            title: "Review implementation",
            createdAt: timestamp,
            updatedAt: timestamp,
            ownership: { owner: "self" },
            messageCount: 242,
          },
          ownership: { owner: "self" },
          processState: "idle",
          slashCommands: ["plannotator-last", "plannotator-review"].map(
            (name) => ({
              name,
              description: "Review",
              invocation: {
                kind: "skill",
                prefix: "$",
                inventoryState: "current",
              },
            }),
          ),
          messages: [
            ...messages,
            {
              uuid: "app-call",
              type: "assistant",
              timestamp,
              content: [
                {
                  type: "tool_use",
                  id: "app-tool",
                  name: "Bash",
                  input: { command: "plannotator last" },
                },
              ],
            },
            result,
          ],
        },
      }),
  );
  let emit: ((data: object) => void) | undefined;
  await page.routeWebSocket("**/api/ws", (socket) => {
    const upstream = socket.connectToServer();
    socket.onMessage((wire) => {
      const frame =
        typeof wire === "string"
          ? JSON.parse(wire)
          : wire[0] === 1
            ? JSON.parse(wire.subarray(1).toString())
            : null;
      if (frame?.type === "subscribe" && frame.channel === "session") {
        let eventId = 0;
        emit = (data) =>
          socket.send(
            JSON.stringify({
              type: "event",
              subscriptionId: frame.subscriptionId,
              eventId: String(eventId++),
              eventType: "message",
              data,
            }),
          );
        socket.send(
          JSON.stringify({
            type: "event",
            subscriptionId: frame.subscriptionId,
            eventId: String(eventId++),
            eventType: "connected",
            data: { sessionId, processId: "pane-process", state: "idle" },
          }),
        );
      } else upstream.send(wire);
    });
  });
  let frameLoads = 0;
  const connectionError =
    "Server is offline. Make sure your server is running and connected to the relay.";
  let rejectLinks = true;
  await page.route("**/api/artifacts/vhosts/links", (route) =>
    rejectLinks
      ? route.fulfill({ status: 503, json: { error: connectionError } })
      : route.fulfill({ json: { tokens: { plan: "test-app-bearer" } } }),
  );
  let stopRequests = 0;
  let rejectStop = false;
  let finishStop: (() => void) | undefined;
  let appAlive = true;
  await page.route("**/api/artifacts/vhosts/plan/listener", (route) =>
    route.fulfill({ json: { token: appAlive ? "observed-listener" : null } }),
  );
  await page.route("**/api/artifacts/vhosts/plan/stop", async (route) => {
    expect(route.request().postDataJSON()).toEqual({
      token: "observed-listener",
    });
    stopRequests++;
    if (rejectStop)
      return route.fulfill({
        status: 409,
        json: { error: "App listener changed before it could be stopped" },
      });
    await new Promise<void>((resolve) => {
      finishStop = resolve;
    });
    return route.fulfill({ json: { stopped: true } });
  });
  await page.route("http://plan.localhost:*/**", (route) => {
    expect(new URL(route.request().url()).searchParams.get("ya_access")).toBe(
      "test-app-bearer",
    );
    frameLoads++;
    return route.fulfill({
      contentType: "text/html",
      body: '<html><body style="font:16px system-ui;padding:20px;background:#f8fafc;color:#172033"><h1>Plan review</h1><p>Review the implementation alongside your session.</p><label>Review note <input aria-label="Review note"></label><p>Use Done to return feedback to the agent.</p><button>Done</button><div style="height:1200px"></div></body></html>',
    });
  });
  await page.setViewportSize({ width: 1200, height: 600 });
  const failedLinks = page.waitForResponse("**/api/artifacts/vhosts/links");
  await page.goto(`${baseURL}/projects/${projectId}/sessions/${sessionId}`);
  const skip = page.getByRole("button", { name: "Skip all" });
  if (await skip.isVisible()) await skip.click();
  const pane = page.getByRole("complementary", { name: "Session pane" });
  const appAction = page.getByRole("button", { name: "App", exact: true });
  const sessionHeader = page.locator("[data-session-header]");
  const title = sessionHeader.locator("[data-session-title-text]");
  await (await failedLinks).finished();
  await expect(title).toHaveText("Review implementation");
  // The links request runs even when no app can be resolved. Its transport
  // failure must not occupy the header's App slot or displace session identity.
  await expect(sessionHeader.getByRole("alert")).toHaveCount(0);
  await expect(sessionHeader).not.toContainText(connectionError);
  await expect(appAction).toHaveCount(0);
  for (const size of [
    { width: 1000, height: 600 },
    { width: 375, height: 812 },
  ]) {
    await page.setViewportSize(size);
    await expect(title).toBeVisible();
    await recordUiCapture(page, `app-links-failure-${size.width}`);
  }
  rejectLinks = false;
  await page.setViewportSize({ width: 1200, height: 600 });
  await page.reload();
  await expect(appAction).toBeVisible({ timeout: 30_000 });
  await expect(pane).toHaveCount(0);
  const appLink = page.getByRole("link", {
    name: "plan/review ↗",
    exact: true,
  });
  await expect(appLink).toBeVisible();
  await recordUiCapture(page, "app-link-desktop");
  await page.setViewportSize({ width: 375, height: 812 });
  await recordUiCapture(page, "app-link-phone");
  await page.setViewportSize({ width: 1200, height: 600 });
  await appLink.click();
  await expect(pane).toBeVisible();
  await appAction.click();
  await expect(pane).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: /Restore.*plan\/review/ }),
  ).toHaveCount(0);
  await page.reload();
  await expect(appAction).toBeVisible();
  await expect(pane).toHaveCount(0);
  await appAction.click();
  await expect(pane).toBeVisible({ timeout: 30_000 });
  await expect(page.locator("[data-message-list]")).not.toHaveAttribute(
    "aria-busy",
    "true",
  );
  await expect(page.locator("[data-sidebar-desktop]")).toHaveClass(
    /sidebar-collapsed/,
  );
  const frame = pane.locator("iframe").contentFrame();
  await frame.getByLabel("Review note").fill("Keep this note");
  await expect(pane.locator("iframe")).toHaveAttribute("title", "");
  await expect(pane.locator("iframe")).not.toHaveAttribute("data-tooltip");
  const initialLoads = frameLoads;
  const separator = page.getByRole("separator", {
    name: "Resize session pane",
  });
  const before = await pane.boundingBox();
  const header = (await page.locator("[data-session-header]").boundingBox())!;
  expect(header.x + header.width).toBeLessThanOrEqual(before!.x + 1);
  expect(Math.abs(header.y - before!.y)).toBeLessThan(2);
  const transcript = page.locator("[data-session-messages]");
  await expect
    .poll(() =>
      transcript.evaluate(
        (element) => element.scrollHeight > element.clientHeight,
      ),
    )
    .toBe(true);
  await expect
    .poll(() =>
      pane.evaluate(
        (element) =>
          [
            ...element.getAnimations(),
            ...element.parentElement!.getAnimations(),
          ].filter((animation) => animation.playState === "running").length,
      ),
    )
    .toBe(0);
  const transcriptBox = (await transcript.boundingBox())!;
  const dividerBox = (await separator.boundingBox())!;
  expect(transcriptBox.x + transcriptBox.width).toBeLessThanOrEqual(
    dividerBox.x,
  );
  const transcriptScroll = await transcript.evaluate(
    (element) => element.scrollTop,
  );
  await frame.locator("body").evaluate(() => window.scrollTo(0, 200));
  expect(await frame.locator("body").evaluate(() => window.scrollY)).toBe(200);
  expect(await transcript.evaluate((element) => element.scrollTop)).toBe(
    transcriptScroll,
  );
  await transcript.hover();
  await page.mouse.wheel(0, -250);
  await expect
    .poll(() => transcript.evaluate((element) => element.scrollTop))
    .toBeLessThan(transcriptScroll);
  expect(await frame.locator("body").evaluate(() => window.scrollY)).toBe(200);
  await frame.locator("body").evaluate(() => window.scrollTo(0, 0));
  await separator.focus();
  await page.keyboard.press("ArrowLeft");
  await expect
    .poll(async () => (await pane.boundingBox())!.width)
    .toBeGreaterThan(before!.width);
  const bar = (await separator.boundingBox())!;
  await page.mouse.move(bar.x + bar.width / 2, bar.y + 100);
  await page.mouse.down();
  await page.mouse.move(bar.x - 50, bar.y + 100, { steps: 5 });
  await page.mouse.up();
  await frame.getByLabel("Review note").focus();
  await page.mouse.move(10, 590);
  await recordUiCapture(page, "right-pane-desktop-1200");
  await separator.focus();
  await page.keyboard.press("End");
  const widest = (await pane.boundingBox())!.width;
  await page.keyboard.press("ArrowRight");
  await expect
    .poll(async () => (await pane.boundingBox())!.width)
    .toBeLessThan(widest - 10);
  await pane.getByRole("button", { name: "Minimize session pane" }).click();
  await expect(pane).toBeHidden();
  await expect(page.locator("[data-sidebar-desktop]")).not.toHaveClass(
    /sidebar-collapsed/,
  );
  const restore = page.getByRole("button", { name: /Restore.*plan\/review/ });
  await expect(restore).toBeVisible();
  const input = page.locator("[data-composer-input]").first();
  await input.click();
  const typed = "Review without losing a single keystroke.";
  await input.evaluate((element) => {
    const samples: number[] = [];
    (window as unknown as { paneTypingSamples: number[] }).paneTypingSamples =
      samples;
    let start = 0;
    element.addEventListener("keydown", () => {
      start = performance.now();
    });
    element.addEventListener("input", () => {
      requestAnimationFrame(() => samples.push(performance.now() - start));
    });
  });
  for (const [index, char] of [...typed].entries()) {
    emit?.({
      uuid: `live-${index}`,
      type: "assistant",
      timestamp,
      content: `Concurrent update ${index}`,
    });
    await page.keyboard.type(char);
  }
  await expect(input).toHaveValue(typed);
  const delays = await page.evaluate(
    () =>
      (window as unknown as { paneTypingSamples: number[] }).paneTypingSamples,
  );
  expect(delays.length).toBeGreaterThan(0);
  expect(Math.max(...delays)).toBeLessThan(100);
  await restore.click();
  await expect(frame.getByLabel("Review note")).toHaveValue("Keep this note");
  expect(frameLoads).toBe(initialLoads);
  for (const size of [
    { width: 1000, height: 600 },
    { width: 375, height: 812 },
  ]) {
    await page.setViewportSize(size);
    await expect(pane).toBeVisible();
    await expect(separator).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: /Minimize.*plan\/review/ }),
    ).toBeHidden();
    const headerBackground = await pane.evaluate(
      (element) => getComputedStyle(element).backgroundColor,
    );
    expect(headerBackground).not.toBe("rgba(0, 0, 0, 0)");
    await expect
      .poll(() =>
        pane.locator("iframe").evaluate((element) => {
          const box = element.getBoundingClientRect();
          return (
            document.elementFromPoint(box.right - 35, box.bottom - 25) ===
            element
          );
        }),
      )
      .toBe(true);
    await recordUiCapture(page, `right-pane-${size.width}`);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  }
  await pane.getByRole("button", { name: "Minimize session pane" }).click();
  await expect(restore).toBeVisible();
  await recordUiCapture(page, "right-pane-phone-parked");
  await restore.click();
  await expect(frame.getByLabel("Review note")).toHaveValue("Keep this note");
  await page.setViewportSize({ width: 1200, height: 600 });
  await appAction.click();
  emit?.(result);
  await expect(pane).toHaveCount(0);
  await page.getByRole("button", { name: "App", exact: true }).click();
  await expect(pane).toBeVisible();
  await expect.poll(() => frameLoads).toBe(initialLoads + 1);
  await pane.getByRole("button", { name: "Reload app" }).click();
  await expect.poll(() => frameLoads).toBe(initialLoads + 2);
  const link = pane.getByRole("button", { name: "Copy viewer link" });
  for (const gesture of [
    { modifiers: ["Shift" as const] },
    { button: "middle" as const },
  ]) {
    const opened = page.context().waitForEvent("page");
    await link.click(gesture);
    const tab = await opened;
    await expect(pane).toBeVisible();
    await tab.close();
  }
  const moved = page.context().waitForEvent("page");
  await pane.getByRole("link", { name: "Move viewer to new tab" }).click();
  const tab = await moved;
  await expect(pane).toHaveCount(0);
  await tab.close();
  await appAction.click();
  await pane.getByRole("button", { name: "Kill app and close" }).click();
  await expect(appAction).toHaveCount(0);
  await expect(pane).toHaveCount(0);
  expect(stopRequests).toBe(1);
  const stopped = page.waitForResponse("**/api/artifacts/vhosts/plan/stop");
  finishStop?.();
  expect((await stopped).ok()).toBe(true);
  await page.reload();
  await expect(page.locator("[data-session-header]")).toBeVisible();
  await expect(appAction).toHaveCount(0);
  await expect(appLink).toBeVisible();
  emit?.({ ...result, uuid: "new-launch" });
  await expect(pane).toBeVisible();
  await expect(frame.getByLabel("Review note")).toBeVisible();
  await frame.getByLabel("Review note").fill("Previous launch");
  emit?.({ ...result, uuid: "another-launch" });
  await expect(frame.getByLabel("Review note")).toHaveValue("");
  rejectStop = true;
  await pane.getByRole("button", { name: "Kill app and close" }).click();
  await expect(pane).toHaveCount(0);
  await expect(page.getByRole("alert")).toContainText(
    "App listener changed before it could be stopped",
  );
  await expect(sessionHeader.getByRole("alert")).toHaveCount(0);
  await expect(title).toHaveText("Review implementation");
  emit?.({ ...result, uuid: "launch-after-refused-stop" });
  await expect(pane).toBeVisible();
  appAlive = false;
  await expect(pane).toHaveCount(0, { timeout: 10_000 });
  await expect(restore).toHaveCount(0);
  await appAction.click();
  await expect(pane.getByRole("alert")).toContainText("App is not running");
  await expect(pane.locator("iframe")).toHaveCount(0);
  for (const size of [
    { width: 1200, height: 600 },
    { width: 375, height: 812 },
  ]) {
    await page.setViewportSize(size);
    await recordUiCapture(page, `right-pane-unavailable-${size.width}`);
  }
  await page.setViewportSize({ width: 1200, height: 600 });
  await appAction.click();
  await input.fill("");
  for (const [index, char] of [..."$pla"].entries()) {
    emit?.({
      uuid: `completion-update-${index}`,
      type: "assistant",
      timestamp,
      content: `Update ${index}`,
    });
    await input.pressSequentially(char);
    await expect(input).toHaveValue("$pla".slice(0, index + 1), {
      timeout: 100,
    });
  }
  await input.press("Tab");
  await expect(input).toHaveValue("$plannotator-");
  await input.press("Tab");
  await expect(input).toHaveValue("$plannotator-");
  for (const size of [
    { width: 1200, height: 600 },
    { width: 375, height: 812 },
  ]) {
    await page.setViewportSize(size);
    await recordUiCapture(page, `skill-common-prefix-${size.width}`);
  }
  await input.press("ArrowDown");
  await input.press("Shift+Space");
  await expect(input).toHaveValue("$plannotator-last ");
});

test("Apps settings explains wildcard hosting without a domain default", async ({
  page,
  baseURL,
}) => {
  let locked = false;
  await page.route("**/api/artifacts/vhosts/links", (route) =>
    route.fulfill({ json: { tokens: { plan: "test-app-bearer" } } }),
  );
  await page.route("**/api/version*", async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      json: {
        ...(await response.json()),
        artifactViewer: {
          port: 4402,
          available: true,
          locked,
          defaultLocalOrigin: "http://artifacts.localhost:3400",
          localOrigin: "http://artifacts.localhost:3400",
          vhosts: [{ name: "plan", port: 19432 }],
          expiryDays: 7,
        },
      },
    });
  });
  await page.goto(`${baseURL}/settings/apps`);
  const field = page.getByRole("textbox", {
    name: "Public vhost root (optional)",
    exact: true,
  });
  await expect(field).toHaveValue("");
  await expect(field).not.toHaveAttribute("placeholder");
  await expect(page.getByText(/public-tunnel \*\.example.com/)).toBeVisible();
  await page
    .getByRole("button", { name: "plan .localhost", exact: true })
    .click();
  await expect(
    page.getByRole("checkbox", { name: "Public — no link required" }),
  ).not.toBeChecked();
  await expect(
    page.getByRole("button", { name: "Copy app link" }),
  ).toBeEnabled();
  for (const size of [
    { width: 1200, height: 600 },
    { width: 375, height: 812 },
  ]) {
    await page.setViewportSize(size);
    await expect(async () => {
      await field.scrollIntoViewIfNeeded();
    }).toPass();
    await recordUiCapture(page, `apps-settings-${size.width}`);
    if (size.width === 375) {
      await page
        .getByRole("button", { name: "plan .localhost", exact: true })
        .click();
    }
    await page
      .getByRole("checkbox", { name: "Public — no link required" })
      .scrollIntoViewIfNeeded();
    await recordUiCapture(page, `apps-access-${size.width}`);
  }
  locked = true;
  await page.reload();
  await page
    .getByRole("button", { name: "plan .localhost", exact: true })
    .click();
  await expect(
    page.getByRole("textbox", { name: "Name", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Add vhost", exact: true }),
  ).toBeDisabled();
  await page
    .getByRole("button", { name: "Minimize details", exact: true })
    .click();
  await expect(page.getByRole("table", { name: "Hosted apps" })).toBeVisible();
});

test("older servers expose no app-link management requests", async ({
  page,
  baseURL,
}) => {
  let requests = 0;
  await page.route("**/api/artifacts/vhosts/**", (route) => {
    requests++;
    return route.fulfill({ status: 404 });
  });
  await page.route("**/api/version*", (route) =>
    route.fulfill({
      json: {
        version: "0.8.1",
        capabilities: [],
        artifactViewer: {
          port: 4402,
          available: true,
          locked: false,
          defaultLocalOrigin: "http://artifacts.localhost:3400",
          vhosts: [{ name: "plan", port: 19432 }],
          expiryDays: 7,
        },
      },
    }),
  );
  await page.goto(`${baseURL}/settings/apps`);
  await expect(
    page.getByText(/does not support app-link protection/),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Copy app link" })).toHaveCount(
    0,
  );
  await expect(
    page.getByRole("checkbox", { name: "Public — no link required" }),
  ).toHaveCount(0);
  expect(requests).toBe(0);
});

test("Apps saves on defocus without losing typing during a pending save", async ({
  page,
  baseURL,
}) => {
  let config = {
    port: 4402,
    available: true,
    locked: false,
    defaultLocalOrigin: "http://artifacts.localhost:3400",
    localOrigin: "http://artifacts.localhost:3400",
    expiryDays: 7,
    vhostPublicRoot: "",
    vhosts: [
      { name: "plan", port: 19432 },
      ...Array.from({ length: 38 }, (_, index) => ({
        name: `service-${index + 1}`,
        port: 19500 + index,
      })),
    ],
    vhostSites: [
      {
        name: "reports",
        path: "~/research/reports/index.html",
        public: true,
        passwordProtected: true,
      },
    ],
  };
  await page.route("**/api/version*", async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      json: { ...(await response.json()), artifactViewer: config },
    });
  });
  await page.route("**/api/artifacts/vhosts/links", (route) =>
    route.fulfill({ json: { tokens: { plan: "token" } } }),
  );
  let release: () => void = () => {};
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const writes: object[] = [];
  await page.route("**/api/artifacts/config", async (route) => {
    const payload = route.request().postDataJSON();
    writes.push(payload);
    if (writes.length === 1) await blocked;
    config = { ...config, ...payload };
    await route.fulfill({ json: { success: true } });
  });
  await page.goto(`${baseURL}/settings/apps`);
  const root = page.getByRole("textbox", {
    name: "Public vhost root (optional)",
  });
  await root.pressSequentially("example.com");
  expect(writes).toHaveLength(0);
  await root.press("Tab");
  await expect.poll(() => writes.length).toBe(1);
  await page
    .getByRole("button", { name: "plan .example.com", exact: true })
    .click();
  const name = page.getByRole("textbox", { name: "Name", exact: true });
  await name.focus();
  await name.press("End");
  let expected = "plan";
  for (const char of "-review") {
    expected += char;
    await page.keyboard.type(char);
    await expect(name).toHaveValue(expected, { timeout: 100 });
  }
  release();
  const saved = page
    .getByRole("status")
    .filter({ hasText: "Artifact settings saved" });
  await expect(saved).toBeVisible();
  await expect(name).toHaveValue("plan-review");
  await name.press("Tab");
  await expect.poll(() => writes.length).toBe(2);
  await expect(saved).toBeVisible();
  await page.reload();
  await expect(root).toHaveValue("example.com");
  await page
    .getByRole("button", { name: "plan-review .example.com", exact: true })
    .click();
  await expect(name).toHaveValue("plan-review");
  await expect(
    page.getByRole("button", { name: /Save.*settings/ }),
  ).toHaveCount(0);
  const table = page.getByRole("table", { name: "Hosted apps" });
  const back = page.getByRole("button", {
    name: "Minimize details",
    exact: true,
  });
  for (const size of [
    { width: 1200, height: 600 },
    { width: 1000, height: 600 },
    { width: 375, height: 812 },
  ]) {
    await back.click();
    await page.setViewportSize(size);
    await expect(table.getByRole("row")).toHaveCount(41);
    await table.evaluate((element) =>
      element.scrollIntoView({ block: "start" }),
    );
    await recordUiCapture(page, `apps-table-${size.width}`);
    await table
      .getByRole("button", { name: "service-2 .example.com", exact: true })
      .click();
    await expect(name).toHaveCount(1);
    await expect(name).toHaveValue("service-2");
    if (size.width !== 375) {
      await table
        .getByRole("button", { name: "service-3 .example.com", exact: true })
        .click();
      await expect(name).toHaveValue("service-3");
      await expect(table).toBeVisible();
      expect(
        (await table.getByRole("row").nth(1).boundingBox())!.height,
      ).toBeLessThan(72);
    }
    if (size.width === 375) await expect(table).not.toBeVisible();
    await back
      .locator("../..")
      .evaluate((element) => element.scrollIntoView({ block: "start" }));
    await recordUiCapture(page, `apps-detail-${size.width}`);
  }
  await back.click();
  await expect(
    table.getByRole("button", { name: "service-2 .example.com", exact: true }),
  ).toBeFocused();
  await page.getByRole("button", { name: "Add vhost", exact: true }).click();
  await expect(name).toHaveValue("");
  await name.pressSequentially("new-app");
  await page.getByRole("button", { name: "Remove", exact: true }).click();
  await expect(table).toBeVisible();
  await expect(table.getByRole("row")).toHaveCount(41);
  await table
    .getByRole("button", { name: "service-2 .example.com", exact: true })
    .click();
  await expect(name).toHaveValue("service-2");
});

test("Apps project inventory uses one options pane", async ({
  page,
  baseURL,
}) => {
  const projects = Array.from({ length: 12 }, (_, index) => ({
    projectId: `demo-${index}`,
    name: `Project ${index + 1}`,
    path: `/workspace/project-${index + 1}`,
    info: {
      projectId: `demo-${index}`,
      state: "ready",
      declaration: null,
      latestArtifact: null,
      canExecute: true,
      canPublish: true,
      canShare: true,
      removedFrom: [],
    },
  }));
  await page.route("**/api/project-apps", (route) =>
    route.fulfill({
      json: {
        projects,
        reservations: projects.map((project, index) => ({
          projectId: project.projectId,
          name: `app-${index + 1}`,
          namespace: "example.com",
          owner: "superuser",
        })),
      },
    }),
  );
  await page.route("**/api/projects/demo-*/app", (route) =>
    route.fulfill({ json: projects[0]!.info }),
  );
  await page.route("**/api/projects/demo-*/app/address", (route) =>
    route.fulfill({
      json: {
        enabled: false,
        namespace: null,
        requiredPrefix: "",
        canReserve: false,
        canPublish: false,
        reservations: [],
      },
    }),
  );
  for (const size of [
    { width: 1200, height: 600 },
    { width: 375, height: 812 },
  ]) {
    await page.setViewportSize(size);
    await page.goto(`${baseURL}/settings/apps`);
    const table = page.getByRole("table", {
      name: "Project apps",
      exact: true,
    });
    await expect(table.getByRole("row")).toHaveCount(13);
    await table.getByRole("button", { name: "Project 1", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Project 1", exact: true }),
    ).toBeVisible();
    const back = page.getByRole("button", {
      name: "Minimize details",
      exact: true,
    });
    await back.click();
    await table.getByRole("button", { name: "Project 2", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Project 1", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("heading", { name: "Project 2", exact: true }),
    ).toBeVisible();
    await back
      .locator("../..")
      .evaluate((element) => element.scrollIntoView({ block: "start" }));
    await recordUiCapture(page, `project-apps-detail-${size.width}`);
  }
});

test("Appearance defaults off and persists its setting", async ({
  page,
  baseURL,
}) => {
  await page.goto(`${baseURL}/settings/appearance`);
  const setting = page.getByRole("switch", {
    name: "Session right pane",
    exact: true,
  });
  await expect(setting).not.toBeChecked();
  await setting.locator("..").click();
  await expect(setting).toBeChecked();
  await page.reload();
  await expect(setting).toBeChecked();
});
