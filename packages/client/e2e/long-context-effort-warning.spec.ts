import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { createTestViteServer } from "./support/vite-server";
import { recordUiCapture } from "./support/ui-capture.js";
import {
  startYaServerProcess,
  disposeYaServerProcess,
} from "./support/ya-server-process";

test.use({ serviceWorkers: "block" });

// A mid-session effort change on a long-context session asks first and offers
// a fork at the new effort (topics/mid-session-effort-change.md). The session
// is mocked at the API layer: an owned idle Claude process at effort high
// whose last request was 123,456 tokens, above the default 5,000-token
// threshold that the real backend's default settings carry for Claude.
test("a long-context effort change asks first and can fork at the new effort", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const projectPath = dirname(dirname(fileURLToPath(import.meta.url)));
  const backend = await startYaServerProcess({
    label: "long-context effort warning",
  });
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
  const row = {
    id: "lce-a",
    title: "Long context",
    fullTitle: "Long context",
    projectId,
    projectName: "Effort warning test",
    provider: "claude",
    model: "opus",
    activity: "idle",
    ownership: { owner: "self", processId: "proc-lce" },
    createdAt: new Date(now - 60_000).toISOString(),
    updatedAt: new Date(now - 60_000).toISOString(),
    messageCount: 2,
    contextUsage: {
      inputTokens: 123_456,
      percentage: 62,
      contextWindow: 200_000,
    },
    effectiveModelSettings: {
      requestedModel: "opus",
      thinking: { type: "adaptive" },
      effort: "high",
    },
  };
  const forkRow = {
    ...row,
    id: "lce-fork",
    title: "Fork 1: Long context",
    fullTitle: "Fork 1: Long context",
    ownership: { owner: "none" },
    effectiveModelSettings: {
      requestedModel: "opus",
      thinking: { type: "adaptive" },
      effort: "max",
    },
  };
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message.slice(0, 200)));
  const configBodies: unknown[] = [];
  const forkBodies: unknown[] = [];

  await page.route(/\/api\/sessions(?:\?|$)/, (route) =>
    route.fulfill({
      json: {
        sessions:
          new URL(route.request().url()).searchParams.get("starred") === "true"
            ? []
            : [row],
        hasMore: false,
        total: 1,
      },
    }),
  );
  await page.route(
    /\/api\/projects\/[^/]+\/sessions\/lce-(?:a|fork)(?:\?|$)/,
    (route) => {
      const id = new URL(route.request().url()).pathname.split("/").at(-1);
      const session = id === "lce-fork" ? forkRow : row;
      return route.fulfill({
        json: {
          session,
          messages: [
            {
              uuid: "u-1",
              type: "user",
              content: "Read the whole repository and summarize it.",
            },
            {
              uuid: "a-1",
              type: "assistant",
              content: [{ type: "text", text: "Done. Here is the summary." }],
            },
          ],
          ownership: session.ownership,
        },
      });
    },
  );
  // Runtime reconciliation reads process state from the metadata route; an
  // owned session starts as in-turn until this says idle, and only an idle
  // session offers the fork.
  await page.route(
    /\/api\/projects\/[^/]+\/sessions\/lce-(?:a|fork)\/metadata(?:\?|$)/,
    (route) => {
      const id = new URL(route.request().url()).pathname.split("/").at(-2);
      return route.fulfill({
        json: {
          session: id === "lce-fork" ? forkRow : row,
          ownership:
            id === "lce-fork"
              ? { owner: "none" }
              : { owner: "self", processId: "proc-lce" },
          processState: "idle",
          deferredMessages: [],
        },
      });
    },
  );
  await page.route(/\/api\/sessions\/lce-a\/process$/, (route) =>
    route.fulfill({
      json: {
        process: {
          sessionId: "lce-a",
          provider: "claude",
          model: "opus",
          state: "idle",
          activity: "idle",
          thinking: { type: "adaptive" },
          effort: "high",
        },
      },
    }),
  );
  await page.route(/\/api\/sessions\/lce-fork\/process$/, (route) =>
    route.fulfill({ json: { process: null } }),
  );
  await page.route(/\/api\/processes\/proc-lce\/config$/, async (route) => {
    configBodies.push(route.request().postDataJSON());
    return route.fulfill({
      json: {
        success: true,
        processId: "proc-lce",
        model: "opus",
        thinking: { type: "adaptive" },
        effort: "max",
      },
    });
  });
  await page.route(/\/api\/processes\/proc-lce\/models$/, (route) =>
    route.fulfill({
      json: {
        models: [
          {
            id: "opus",
            name: "Opus",
            supportedEffortLevels: ["low", "medium", "high", "max"],
          },
        ],
      },
    }),
  );
  await page.route(
    /\/api\/projects\/[^/]+\/sessions\/lce-a\/fork$/,
    async (route) => {
      forkBodies.push(route.request().postDataJSON());
      return route.fulfill({
        json: {
          sessionId: "lce-fork",
          projectId,
          provider: "claude",
          forkedFrom: "lce-a",
          forkKind: "clone-latest-complete",
        },
      });
    },
  );

  try {
    await source.listen();
    const address = source.httpServer?.address();
    if (!address || typeof address === "string")
      throw new Error("Missing Vite port");
    const origin = `http://127.0.0.1:${address.port}`;
    // The modal's dialog role carries no accessible name; match its title.
    const dialog = page
      .getByRole("dialog")
      .filter({ hasText: "Change effort on a long context?" });

    // Desktop: the composer's thinking chooser.
    await page.setViewportSize({ width: 1000, height: 600 });
    await page.goto(`${origin}/projects/${projectId}/sessions/lce-a`);
    await expect(page.locator("[data-composer-input]")).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByText("Done. Here is the summary.")).toBeVisible({
      timeout: 30_000,
    });
    const thinkingToggle = page.locator(".thinking-toggle-button:visible");
    await expect(thinkingToggle).toBeVisible({ timeout: 15_000 });
    await thinkingToggle.click();
    await page.getByRole("menuitemradio", { name: "Max" }).click();
    await expect(dialog).toBeVisible({ timeout: 15_000 });
    await expect(dialog).toContainText("123,456 tokens");
    await expect(dialog).toContainText("from High to Max");
    await recordUiCapture(page, "desktop-thinking-chooser");

    // Cancel applies nothing.
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toBeHidden();
    expect(configBodies).toEqual([]);

    // Phone: the provider badge's model panel reaches the same guard.
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto(`${origin}/projects/${projectId}/sessions/lce-a`);
    await expect(page.locator("[data-composer-input]")).toBeVisible({
      timeout: 30_000,
    });
    await page.locator("[data-provider-badge-button]").click();
    const panel = page.getByRole("dialog").filter({ hasText: "Switch Model" });
    await expect(panel).toBeVisible({ timeout: 15_000 });
    await panel
      .getByRole("radiogroup", { name: "Effort Level" })
      .getByRole("radio", { name: "Max" })
      .click();
    await panel
      .getByRole("button", { name: /Save all/ })
      .first()
      .click();
    await expect(dialog).toBeVisible({ timeout: 15_000 });
    await recordUiCapture(page, "phone-model-panel");

    // Fork at the new effort sends the thinking option and navigates.
    await dialog.getByRole("button", { name: "Fork at Max" }).click();
    await expect.poll(() => forkBodies.length, { timeout: 15_000 }).toBe(1);
    expect(forkBodies[0]).toMatchObject({
      forkKind: "clone-latest-complete",
      thinking: "on:max",
    });
    await expect(page).toHaveURL(/\/sessions\/lce-fork/, { timeout: 15_000 });
    expect(configBodies).toEqual([]);
    expect(errors).toEqual([]);
  } finally {
    await source.close();
    await disposeYaServerProcess(backend);
  }
});
