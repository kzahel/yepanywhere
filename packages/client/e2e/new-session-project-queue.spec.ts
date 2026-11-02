import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { test as base, expect } from "@playwright/test";
import { toUrlProjectId } from "@yep-anywhere/shared";
import { ProjectQueueService } from "../../server/src/services/ProjectQueueService.js";
import { e2ePaths } from "./fixtures.js";
import { recordUiCapture } from "./support/ui-capture.js";
import {
  startYaServerProcess,
  disposeYaServerProcess,
  type YaServerProcess,
} from "./support/ya-server-process.js";

const mockProjectPath = join(e2ePaths.tempDir, "mockproject");
const projectId = toUrlProjectId(mockProjectPath);
let createdItemIds: string[] = [];

const test = base.extend<{ queueServer: YaServerProcess }>({
  // biome-ignore lint/correctness/noEmptyPattern: Playwright fixture signature
  queueServer: async ({}, use) => {
    createdItemIds = [];
    const server = await startYaServerProcess({
      label: "New Session queue layout",
      serveBuiltClient: true,
      mockClaudeSession: {
        sessionId: "queue-layout-history",
        projectPath: mockProjectPath,
        content: "Queue layout project",
      },
      setupProfile: async ({ dataDir }) => {
        mkdirSync(mockProjectPath, { recursive: true });
        // Populate real persisted queue state without a scheduler. The server
        // loads the backlog paused-after-restart, exactly as production does.
        const queue = new ProjectQueueService({ dataDir });
        await queue.initialize();
        for (const title of [
          "Review the responsive queue placement",
          "Verify durable queued-session feedback",
        ]) {
          const item = await queue.createItem({
            creationProvenance: { surface: "web" },
            projectId,
            projectPath: mockProjectPath,
            request: {
              target: {
                type: "new-session",
                provider: "claude",
                model: "claude-opus-4-6",
                title,
              },
              message: { text: title },
              createdFrom: { client: "new-session" },
            },
          });
          createdItemIds.push(item.id);
        }
      },
    });
    try {
      await use(server);
    } finally {
      await disposeYaServerProcess(server);
    }
  },
  baseURL: async ({ queueServer }, use) => {
    await use(queueServer.baseUrl);
  },
});
test.use({ serviceWorkers: "block" });

async function assertQueueFollowsSelector(
  page: import("@playwright/test").Page,
) {
  const selector = page.locator(".new-session-project-chooser");
  const queue = page.locator(
    '.new-session-project-chooser + [data-new-session-project-queue="true"]',
  );
  const provider = page.locator(".new-session-provider-slot");

  await expect(selector).toBeVisible();
  await expect(queue).toBeVisible();
  await expect(queue).toContainText("Project Queue");
  await expect(queue).toContainText("2 queued");
  await expect(queue).toContainText("Review the responsive queue placement");
  await expect(queue).toContainText("Verify durable queued-session feedback");
  await expect(
    queue.getByRole("img", { name: "opus-4-6", exact: true }),
  ).toHaveCount(2);

  const selectorBox = await selector.boundingBox();
  const queueBox = await queue.boundingBox();
  const providerBox = await provider.boundingBox();
  expect(selectorBox).not.toBeNull();
  expect(queueBox).not.toBeNull();
  expect(providerBox).not.toBeNull();
  if (!selectorBox || !queueBox || !providerBox) return;

  expect(Math.abs(queueBox.x - selectorBox.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(queueBox.width - selectorBox.width)).toBeLessThanOrEqual(1);
  expect(queueBox.y).toBeGreaterThan(selectorBox.y + selectorBox.height);

  expect(providerBox.y).toBeGreaterThan(queueBox.y + queueBox.height);
}

async function assertProjectsQueueBadges(
  page: import("@playwright/test").Page,
) {
  const queue = page.getByRole("region", { name: "Project Queue" });
  await expect(queue).toBeVisible();
  await expect(
    queue.getByRole("img", { name: "opus-4-6", exact: true }),
  ).toHaveCount(2);
}

test("keeps the selected project queue beneath the selector", async ({
  page,
  baseURL,
}) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto(`${baseURL}/new-session?projectId=${projectId}`);
  await assertQueueFollowsSelector(page);

  await page.setViewportSize({ width: 1024, height: 768 });
  await assertQueueFollowsSelector(page);

  await page.setViewportSize({ width: 1000, height: 600 });
  await assertQueueFollowsSelector(page);
  await recordUiCapture(page, "project-queue-model-badge-desktop");

  await page.setViewportSize({ width: 375, height: 812 });
  await assertQueueFollowsSelector(page);
  await recordUiCapture(page, "project-queue-model-badge-phone");

  await page.setViewportSize({ width: 1000, height: 600 });
  await page.goto(`${baseURL}/projects?queueItem=${createdItemIds[0]}`);
  await assertProjectsQueueBadges(page);
  await recordUiCapture(page, "projects-queue-model-badge-desktop");

  await page.setViewportSize({ width: 375, height: 812 });
  await assertProjectsQueueBadges(page);
  await recordUiCapture(page, "projects-queue-model-badge-phone");
});
