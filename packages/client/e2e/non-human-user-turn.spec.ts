import { appendFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { SessionMetadataService } from "../../server/src/metadata/SessionMetadataService.js";
import { DiscoverySqliteService } from "../../server/src/storage/discovery-sqlite.js";
import { InstallService } from "../../server/src/services/InstallService.js";
import { e2ePaths, expect, test } from "./fixtures.js";
import { recordUiCapture } from "./support/ui-capture.js";
import { typeEachKeyWithin100ms } from "./support/session-page-harness.js";
import {
  startYaServerProcess,
  disposeYaServerProcess,
} from "./support/ya-server-process.js";

for (const viewport of [
  { width: 1000, height: 600 },
  { width: 375, height: 812 },
]) {
  test(`delivered-turn flag opens older history without Inbox or title escalation at ${viewport.width}px`, async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const projectPath = join(
      e2ePaths.tempDir,
      `delivery-project-${viewport.width}`,
    );
    const projectId = Buffer.from(projectPath).toString("base64url");
    const sessionId = `delivery-${viewport.width}`;
    const messageId = "fixture-user-message";
    const backend = await startYaServerProcess({
      label: "delivered turn navigation",
      mockClaudeSession: {
        projectPath,
        sessionId,
        content:
          "The other session has sent its review. Please check the migration before proceeding.",
      },
      setupProfile: async ({ dataDir, claudeSessionsDir }) => {
        const install = new InstallService({ dataDir });
        await install.initialize();
        await install.recordSuccessfulProviders(["claude"]);
        // Seed before the server starts, then release the database to it.
        const discovery = new DiscoverySqliteService({ dataDir });
        const metadata = new SessionMetadataService({
          dataDir,
          database: discovery.getDatabase(),
        });
        await metadata.initialize();
        await metadata.setTitle(sessionId, "Review from another session");
        await metadata.recordNonHumanUserTurn(sessionId, {
          messageId,
          sourceSessionId: "reviewer",
          timestamp: "2026-01-01T00:00:00.000Z",
        });
        await metadata.flushPendingWrites();
        discovery.close();
        // Put the target outside the initial tail and exercise history loading.
        const start = Date.now() - 70 * 60_000;
        const turns = Array.from({ length: 65 }, (_, index) => [
          {
            type: "user",
            uuid: `later-user-${index}`,
            parentUuid: index === 0 ? messageId : `later-answer-${index - 1}`,
            timestamp: new Date(start + (index + 1) * 60_000).toISOString(),
            message: {
              role: "user",
              content: `Follow-up ${index + 1}: continue the implementation.`,
            },
          },
          {
            type: "assistant",
            uuid: `later-answer-${index}`,
            parentUuid: `later-user-${index}`,
            timestamp: new Date(
              start + (index + 1) * 60_000 + 1000,
            ).toISOString(),
            message: {
              role: "assistant",
              content: [
                {
                  type: "text",
                  text: `Progress ${index + 1}: the checks are complete and the next step is ready.`,
                },
              ],
            },
          },
        ]).flat();
        appendFileSync(
          join(
            claudeSessionsDir,
            hostname(),
            projectPath.replace(/\//g, "-"),
            `${sessionId}.jsonl`,
          ),
          `${turns.map((turn) => JSON.stringify(turn)).join("\n")}\n`,
        );
      },
      env: {
        SERVE_FRONTEND: "true",
        CLIENT_DIST_PATH: e2ePaths.clientDist,
        SESSION_AUTO_ARCHIVE_DAYS: "0",
      },
    });
    try {
      const historyReads: string[] = [];
      page.on("request", (request) => {
        const url = new URL(request.url());
        if (
          url.pathname === `/api/projects/${projectId}/sessions/${sessionId}` &&
          url.searchParams.has("beforeMessageId")
        ) {
          historyReads.push(url.search);
        }
      });
      await page.setViewportSize(viewport);
      if (viewport.width === 1000) {
        await page.route("**/api/version", (route) =>
          route.fulfill({
            json: {
              current: "0.8.1",
              latest: "0.8.1",
              updateAvailable: false,
              capabilities: [],
            },
          }),
        );
        const unsupportedAcknowledgements: string[] = [];
        const observe = (request: import("@playwright/test").Request) => {
          if (
            request.url().endsWith("/mark-seen") &&
            request.postDataJSON()?.nonHumanUserTurnMessageId
          )
            unsupportedAcknowledgements.push(request.url());
        };
        page.on("request", observe);
        await page.goto(
          `${backend.baseUrl}/projects/${projectId}/sessions/${sessionId}?nonHumanTurn=${messageId}`,
        );
        await expect(
          page.getByText(
            "Progress 65: the checks are complete and the next step is ready.",
          ),
        ).toBeVisible();
        await expect(
          page.getByRole("link", { name: "Open message from another session" }),
        ).toHaveCount(0);
        expect(unsupportedAcknowledgements).toEqual([]);
        page.off("request", observe);
        await page.unroute("**/api/version");
      }
      await page.goto(`${backend.baseUrl}/inbox`);
      const flag = page
        .getByRole("link", { name: "Open message from another session" })
        .last();
      await expect(flag).toBeVisible({ timeout: 20_000 });
      await expect(flag).toHaveAttribute(
        "href",
        new RegExp(`nonHumanTurn=${messageId}$`),
      );
      await expect(
        page.getByRole("heading", { name: /^Needs Attention/ }),
      ).toHaveText(/Needs Attention\s*0/);
      await expect(
        page
          .locator("main section")
          .filter({
            has: page.getByRole("heading", { name: /^Recent Activity/ }),
          })
          .getByRole("link", { name: "Open message from another session" }),
      ).toHaveCount(1);
      await page.locator("[data-sidebar-toggle]").first().click();
      await expect(
        page.getByRole("link", { name: "Inbox", exact: true }),
      ).toBeVisible();
      await expect(page.getByTestId("sidebar-nav-badge-default")).toHaveCount(
        0,
      );
      await page
        .getByRole("complementary")
        .getByRole("button", { name: "Close sidebar", exact: true })
        .click();
      await expect(page).not.toHaveTitle(/\(\d+\)/);
      await recordUiCapture(
        page,
        `non-human-user-turn-inbox-${viewport.width}`,
      );
      const acknowledgement = page
        .waitForRequest(
          (request) =>
            request.url().endsWith(`/sessions/${sessionId}/mark-seen`) &&
            request.postDataJSON()?.nonHumanUserTurnMessageId === messageId,
          { timeout: 30_000 },
        )
        .catch((error) => {
          throw new Error(
            `${error}\nHistory reads: ${JSON.stringify(historyReads)}`,
          );
        });
      if (viewport.width === 1000) {
        await page
          .locator("main")
          .getByRole("link", {
            name: /Review from another session/,
          })
          .last()
          .click();
      } else {
        await flag.click();
      }
      await acknowledgement;
      expect(historyReads.length).toBeGreaterThan(0);
      await expect(page).toHaveURL(new RegExp(`nonHumanTurn=${messageId}$`));
      const target = page.locator(`[data-render-id="${messageId}"]`).first();
      await expect(target).toBeInViewport();
      await recordUiCapture(
        page,
        `non-human-user-turn-target-${viewport.width}`,
      );
      const metadata = await page.request.get(
        `${backend.baseUrl}/api/projects/${projectId}/sessions/${sessionId}/metadata`,
      );
      expect((await metadata.json()).session.nonHumanUserTurn).toBeNull();
      await typeEachKeyWithin100ms(
        page.locator("textarea[data-composer-input]"),
        "Inspect the delivered review",
      );
      await page.goto(`${backend.baseUrl}/inbox`);
      await expect(
        page.getByRole("link", { name: "Open message from another session" }),
      ).toHaveCount(0);
    } finally {
      await disposeYaServerProcess(backend);
    }
  });
}
