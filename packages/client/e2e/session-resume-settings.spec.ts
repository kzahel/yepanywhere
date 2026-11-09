import { join } from "node:path";
import { e2ePaths, expect, test } from "./fixtures.js";
import { recordUiCapture } from "./support/ui-capture.js";

test.use({ serviceWorkers: "block" });

// The browser boundary verifies that the visible stopped-session selection is
// the one submitted, and that real typing survives concurrent history refresh.
// State/precedence variants belong to the hook and request-mapping unit tests.
test("clones saved settings, preserves explicit edits, and degrades on older servers", async ({
  page,
  baseURL,
}) => {
  const projectId = Buffer.from(join(e2ePaths.tempDir, "mockproject")).toString(
    "base64url",
  );
  const sourceId = "mock-session-001";
  const sessionId = "clone-settings-child";
  let currentSessionId = sourceId;
  const timestamp = new Date().toISOString();
  let hasSnapshot = true;
  const savedSettings = {
    schemaVersion: 1,
    revision: 2,
    permissionMode: "bypassPermissions",
    requestedModel: "sonnet",
    serviceTier: "fast",
    thinking: { type: "adaptive", display: "summarized" },
    effort: "high",
  };
  await page.addInitScript(() => {
    localStorage.setItem("yep-anywhere-thinking-mode", "off");
  });
  const messages = Array.from({ length: 900 }, (_, i) => ({
    uuid: `history-${i}`,
    type: i % 2 ? "assistant" : "user",
    timestamp,
    content: `Prior session message ${i}.`,
  }));
  await page.route(
    new RegExp(
      `/api/projects/[^/]+/sessions/(?:${sourceId}|${sessionId})(?:/metadata)?(?:\\?|$)`,
    ),
    (route) =>
      route.fulfill({
        json: {
          session: {
            id: currentSessionId,
            projectId,
            provider: "claude",
            model: "sonnet",
            title: "Resume saved settings",
            createdAt: timestamp,
            updatedAt: timestamp,
            messageCount: messages.length,
            effectiveLaunchSettings: hasSnapshot ? savedSettings : undefined,
            effectiveModelSettings: {
              requestedModel: "sonnet",
              thinking: { type: "adaptive", display: "summarized" },
              effort: "high",
            },
          },
          ownership: { owner: "none" },
          processState: null,
          messages,
        },
      }),
  );
  await page.route(
    /\/api\/sessions\/(?:mock-session-001|clone-settings-child)\/process$/,
    (route) => route.fulfill({ json: { process: null } }),
  );
  let notifyChange: (() => void) | undefined;
  await page.routeWebSocket("**/api/ws", (socket) => {
    const upstream = socket.connectToServer();
    socket.onMessage((wire) => {
      const frame =
        typeof wire === "string"
          ? JSON.parse(wire)
          : wire[0] === 1
            ? JSON.parse(wire.subarray(1).toString())
            : null;
      if (frame?.type === "subscribe" && frame.channel === "session-watch") {
        let sequence = 0;
        notifyChange = () =>
          socket.send(
            JSON.stringify({
              type: "event",
              subscriptionId: frame.subscriptionId,
              eventType: "session-watch-change",
              eventId: String(++sequence),
              data: {
                sessionId: currentSessionId,
                projectId,
                changeVersion: sequence,
                timestamp: new Date().toISOString(),
              },
            }),
          );
      } else upstream.send(wire);
    });
  });
  const forks: Array<Record<string, unknown>> = [];
  await page.route(
    `**/api/projects/${projectId}/sessions/${sourceId}/fork`,
    (route) => {
      forks.push(route.request().postDataJSON());
      currentSessionId = sessionId;
      return route.fulfill({
        json: {
          sessionId,
          provider: "claude",
          projectId,
          forkedFrom: sourceId,
          forkKind: "clone-latest-complete",
        },
      });
    },
  );
  const submissions: Array<Record<string, unknown>> = [];
  await page.route(
    `**/api/projects/${projectId}/sessions/${sessionId}/resume`,
    (route) => {
      submissions.push(route.request().postDataJSON());
      return route.fulfill({
        json: {
          sessionId,
          processId: "resumed-process",
          permissionMode: submissions.at(-1)?.mode ?? "bypassPermissions",
          modeVersion: 0,
        },
      });
    },
  );
  await page.setViewportSize({ width: 1000, height: 600 });
  await page.goto(`${baseURL}/projects/${projectId}/sessions/${sourceId}`);
  const input = page.locator("[data-composer-input]").first();
  const thinking = page.getByRole("button", { name: /^Thinking:/ }).first();
  await expect(thinking).toHaveAccessibleName(/high/i);
  await expect(input).toBeVisible();
  await expect(
    page.getByText("Prior session message 899.", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Bypass", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Session options", exact: true })
    .last()
    .click();
  await page.getByRole("menuitem", { name: "Clone", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/sessions/${sessionId}$`));
  expect(forks).toEqual([
    expect.objectContaining({ forkKind: "clone-latest-complete" }),
  ]);
  expect(forks[0]).not.toHaveProperty("thinking");
  await expect(input).toHaveValue("");
  await expect(
    page.getByText("Prior session message 899.", { exact: true }),
  ).toBeVisible();
  await expect(thinking).toHaveAccessibleName(/high/i);
  await expect(
    page.getByRole("button", { name: "Bypass", exact: true }),
  ).toBeVisible();
  await recordUiCapture(page, "resume-settings-desktop");
  await page.setViewportSize({ width: 375, height: 812 });
  await expect(thinking).toHaveAccessibleName(/high/i);
  await recordUiCapture(page, "resume-settings-phone");
  await expect.poll(() => Boolean(notifyChange)).toBe(true);
  await input.evaluate((element) => {
    const input = element as HTMLTextAreaElement;
    const samples: Array<{ ms: number; present: boolean }> = [];
    let started = 0;
    input.addEventListener("keydown", () => {
      started = performance.now();
    });
    input.addEventListener("input", () => {
      const expected = input.value;
      const keyStarted = started;
      requestAnimationFrame(() => {
        samples.push({
          ms: performance.now() - keyStarted,
          present: input.value.startsWith(expected),
        });
        input.dataset.typingSamples = JSON.stringify(samples);
      });
    });
  });
  const text = "Continue with the saved settings.";
  const timer = setInterval(() => notifyChange?.(), 50);
  try {
    await input.pressSequentially(text, { delay: 20 });
  } finally {
    clearInterval(timer);
  }
  await expect(input).toHaveValue(text);
  await expect
    .poll(
      async () =>
        JSON.parse((await input.getAttribute("data-typing-samples")) ?? "[]")
          .length,
    )
    .toBe(text.length);
  const samples = JSON.parse(
    (await input.getAttribute("data-typing-samples")) ?? "[]",
  ) as Array<{ ms: number; present: boolean }>;
  expect(samples.every((sample) => sample.present && sample.ms < 100)).toBe(
    true,
  );
  await expect(thinking).toHaveAccessibleName(/high/i);
  await page.setViewportSize({ width: 1000, height: 600 });
  await input.press("Enter");
  await expect.poll(() => submissions.length).toBe(1);
  for (const field of ["mode", "model", "thinking", "serviceTier"])
    expect(submissions[0]).not.toHaveProperty(field);
  await page.reload();
  await expect(thinking).toHaveAccessibleName(/high/i);
  await page.getByRole("button", { name: "Bypass", exact: true }).click();
  await page
    .getByRole("dialog", { name: "Select mode" })
    .getByRole("button", { name: /^Ask/ })
    .click();
  await thinking.click();
  await page
    .getByTestId("thinking-toolbar-menu")
    .getByRole("menuitemradio", { name: "Off", exact: true })
    .first()
    .click();
  await expect(thinking).toHaveAccessibleName(/off/i);
  expect(
    await page.evaluate(() =>
      localStorage.getItem("yep-anywhere-thinking-mode"),
    ),
  ).toBe("off");
  // Enter submits on the desktop; phone keyboards retain their newline action.
  await page.setViewportSize({ width: 1000, height: 600 });
  await input.fill("Resume with my explicit choices.");
  await input.press("Enter");
  await expect.poll(() => submissions.length).toBe(2);
  expect(submissions[1]).toMatchObject({ mode: "default", thinking: "off" });
  expect(submissions[1]).not.toHaveProperty("model");
  // The old-server response omits the snapshot. Existing request fields and
  // browser fallback remain usable without any new endpoint or handshake.
  hasSnapshot = false;
  await page.reload();
  await expect(thinking).toHaveAccessibleName(/high/i);
  await input.fill("Resume on an older server.");
  await input.press("Enter");
  await expect.poll(() => submissions.length).toBe(3);
  expect(submissions[2]).toMatchObject({
    mode: "default",
    model: "sonnet",
    thinking: "on:high",
  });
});
