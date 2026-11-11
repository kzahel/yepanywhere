import { join } from "node:path";
import { e2ePaths, expect, test } from "./fixtures.js";
import { recordUiCapture } from "./support/ui-capture.js";

const projectId = Buffer.from(join(e2ePaths.tempDir, "mockproject")).toString(
  "base64url",
);
const sessionId = "mock-session-001";
const fullTitle = [
  "Keep session controls readable on desktop and mobile.",
  ...Array.from(
    { length: 16 },
    (_, index) => `Step ${index + 1}: Keep the draft intact.`,
  ),
  "The final requirement stays available through Show more.",
].join("\n");

test.use({ serviceWorkers: "block", hasTouch: true });

// The browser boundary matters here: wrapping, viewport clipping, text
// selection, clipboard access, and modal/draft behavior cannot be proved by
// checking the rendered string in jsdom.
test("reads the full session title on phone and desktop without losing the draft", async ({
  page,
  context,
  baseURL,
}) => {
  const timestamp = new Date().toISOString();
  let live = true;
  let accountId = "work-primary";
  await page.route("**/api/version", async (route) => {
    const response = await route.fetch();
    const version = await response.json();
    await route.fulfill({
      json: {
        ...version,
        capabilities: [
          ...new Set([
            ...(version.capabilities ?? []),
            "agent-auth-router",
            "agent-auth-router-session-switch",
          ]),
        ],
      },
    });
  });
  await page.route("**/api/agent-auth-router/selection", (route) =>
    route.fulfill({
      json: {
        pools: [
          {
            id: "work-pool",
            name: "Work accounts",
            provider: "claude",
            accountIds: ["work-primary", "work-backup"],
          },
        ],
        accounts: [
          {
            id: "work-primary",
            displayName: "Work primary",
            provider: "claude",
            enabled: true,
          },
          {
            id: "work-backup",
            displayName: "Work backup",
            provider: "claude",
            enabled: true,
          },
        ],
      },
    }),
  );
  await page.route(
    `**/api/agent-auth-router/sessions/${sessionId}/switch`,
    async (route) => {
      accountId = route.request().postDataJSON().routerAccountId;
      await route.fulfill({ json: { routerBinding: null } });
    },
  );
  const messages = Array.from({ length: 240 }, (_, index) => ({
    uuid: `history-${index}`,
    type: index % 2 ? "assistant" : "user",
    timestamp,
    content: `Review item ${index}: preserve the conversation and reader's place.`,
  }));
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.route(
    new RegExp(
      `/api/projects/[^/]+/sessions/${sessionId}(?:/metadata)?(?:\\?|$)`,
    ),
    (route) => {
      const ownership = live
        ? { owner: "self", processId: "title-process" }
        : { owner: "none" };
      return route.fulfill({
        json: {
          session: {
            id: sessionId,
            projectId,
            provider: "claude",
            title: "Make session titles readable…",
            fullTitle,
            routerBinding: {
              id: "example-binding",
              routerId: "example-router",
              provider: "claude",
              poolId: "work-pool",
              poolName: "Work accounts",
              accountId,
              accountDisplayName:
                accountId === "work-primary" ? "Work primary" : "Work backup",
            },
            createdAt: timestamp,
            updatedAt: timestamp,
            ownership,
            messageCount: messages.length,
          },
          ownership,
          processState: "idle",
          messages,
        },
      });
    },
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
            data: { sessionId, processId: "title-process", state: "idle" },
          }),
        );
      } else upstream.send(wire);
    });
  });
  await page.setViewportSize({ width: 1000, height: 600 });
  await page.goto(`${baseURL}/projects/${projectId}/sessions/${sessionId}`);
  const input = page.locator("[data-composer-input]").first();
  await expect(input).toBeVisible();
  await expect.poll(() => Boolean(emit)).toBe(true);
  const header = page.locator("[data-session-header]");
  const footerInfo = page.locator("[data-session-input]").getByRole("button", {
    name: "Session info",
    exact: true,
  });

  for (const size of [
    { width: 1000, height: 600 },
    { width: 375, height: 812 },
  ]) {
    await page.setViewportSize(size);
    // The title stays on one line and is selectable; selecting it never follows a
    // current-session link or closes the dropdown.
    await header.locator("[data-session-title-recent-trigger]").click();
    const current = page.getByRole("region", { name: "Current session" });
    const currentTitle = current.getByText(fullTitle, { exact: true });
    await expect(currentTitle).toBeVisible();
    await currentTitle.tap();
    await currentTitle.evaluate((element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    });
    expect(await page.evaluate(() => window.getSelection()?.toString())).toBe(
      fullTitle.replaceAll("\n", " "),
    );
    const geometry = await currentTitle.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return {
        height: rect.height,
        lineHeight: Number.parseFloat(style.lineHeight),
        width: element.clientWidth,
        scrollWidth: element.scrollWidth,
        whiteSpace: style.whiteSpace,
        userSelect: style.userSelect,
      };
    });
    expect(geometry.height).toBeLessThanOrEqual(geometry.lineHeight + 1);
    expect(geometry.scrollWidth).toBeGreaterThan(geometry.width);
    expect(geometry.whiteSpace).toBe("nowrap");
    expect(geometry.userSelect).toBe("text");
    await expect(
      current.getByRole("button", { name: "Copy title" }),
    ).toHaveCount(0);
    await recordUiCapture(page, `recent-session-title-${size.width}`);
    await page.keyboard.press("Escape");

    // Type each key with a concurrent stream update in a full conversation.
    await input.click();
    await input.evaluate((element) => {
      const samples: number[] = [];
      (
        window as unknown as { titleTypingSamples: number[] }
      ).titleTypingSamples = samples;
      let start = 0;
      element.addEventListener("keydown", () => {
        start = performance.now();
      });
      element.addEventListener("input", () => {
        requestAnimationFrame(() => samples.push(performance.now() - start));
      });
    });
    let draft = await input.inputValue();
    for (const [index, character] of [..." Keep my draft."].entries()) {
      emit?.({
        uuid: `live-${size.width}-${index}`,
        type: "assistant",
        timestamp,
        content: `Concurrent update ${size.width}/${index}`,
      });
      draft += character;
      await input.pressSequentially(character);
      await expect(input).toHaveValue(draft, { timeout: 100 });
    }
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as unknown as { titleTypingSamples: number[] })
              .titleTypingSamples.length,
        ),
      )
      .toBe(" Keep my draft.".length);
    const delays = await page.evaluate(
      () =>
        (window as unknown as { titleTypingSamples: number[] })
          .titleTypingSamples,
    );
    expect(Math.max(...delays)).toBeLessThan(100);
    await expect(footerInfo).toHaveCount(0);
    await header.getByRole("button", { name: "Session options" }).click();
    await page
      .getByRole("menuitem", { name: "Session info", exact: true })
      .click();
    const info = page.getByRole("dialog");
    await expect(info.locator("[data-modal-title]")).toHaveText("Session Info");
    await expect(
      info.getByRole("tab", { name: "Session Info" }),
    ).toHaveAttribute("aria-selected", "true");
    const titleSection = info.getByRole("region", { name: "Session title" });
    await expect(
      titleSection.locator("[data-message-user-prompt]"),
    ).toBeVisible();
    await expect(
      titleSection.getByRole("button", { name: "Show more" }),
    ).toBeVisible();
    await titleSection.getByRole("button", { name: "Show more" }).click();
    await expect(
      titleSection.getByText(fullTitle, { exact: true }),
    ).toBeVisible();
    await titleSection.getByRole("button", { name: "Show less" }).click();
    await info
      .locator("[data-modal-content]")
      .evaluate((element) => element.scrollTo({ top: 0 }));
    await recordUiCapture(page, `session-info-title-${size.width}`);
    await titleSection.hover();
    await titleSection
      .getByRole("button", { name: "Copy message text", exact: true })
      .click();
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toBe(fullTitle);
    await page.keyboard.press("Escape");
    await expect(info).toHaveCount(0);
    await expect(input).toHaveValue(draft);

    // The wide shortcut and mobile model pill converge on the same account pane.
    if (size.width === 1000) {
      await header
        .getByRole("button", { name: /Pinned router account/ })
        .click();
    } else {
      await header.locator("[data-provider-badge-button]").click();
      await page.getByRole("tab", { name: "Account", exact: true }).click();
    }
    const accountPane = page.getByRole("tabpanel");
    await expect(
      page.getByRole("tab", { name: "Account", exact: true }),
    ).toHaveAttribute("aria-selected", "true");
    await expect(
      accountPane.getByRole("combobox", { name: "Router account" }),
    ).toBeVisible();
    await expect(page.getByRole("menu")).toHaveCount(0);
    const apply = accountPane.getByRole("button", {
      name: "Apply account change",
    });
    await expect(apply).toBeDisabled();
    await accountPane
      .getByRole("combobox", { name: "Router account" })
      .selectOption("work-backup");
    await expect(apply).toBeEnabled();
    await expect(
      accountPane.getByText("Current account: Work accounts · Work primary"),
    ).toBeVisible();
    await expect(
      accountPane.getByText(/Applying stops the provider immediately/),
    ).toBeVisible();
    await recordUiCapture(page, `session-account-${size.width}`);
    if (size.width === 375) {
      await apply.click();
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await expect(input).toHaveValue(draft);
    } else {
      await page.keyboard.press("Escape");
    }
  }

  // A stopped session has no process stream to supply its identity.
  live = false;
  await page.reload();
  await header.getByRole("button", { name: "Session options" }).click();
  await page
    .getByRole("menuitem", { name: "Session info", exact: true })
    .click();
  await expect(
    page
      .getByRole("region", { name: "Session title" })
      .getByRole("button", { name: "Show more" }),
  ).toBeVisible();
});
