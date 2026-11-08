import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toUrlProjectId } from "@yep-anywhere/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getLogger } from "../../src/logging/logger.js";
import { MessageQueue } from "../../src/sdk/messageQueue.js";
import type {
  AgentProvider,
  StartSessionOptions,
} from "../../src/sdk/providers/types.js";
import { ProjectQueueScheduler } from "../../src/services/ProjectQueueScheduler.js";
import { ProjectQueueService } from "../../src/services/ProjectQueueService.js";
import { Supervisor } from "../../src/supervisor/Supervisor.js";
import { EventBus } from "../../src/watcher/EventBus.js";
import { createControllableIterator } from "../process.test-support.js";
import { routerFixtureFor } from "../utils/agent-auth-router-fixture.js";
import {
  closeTestDiscoveryDatabases,
  createTestSessionMetadataService,
} from "../utils/session-metadata-database.js";

const cleanups: (() => Promise<void>)[] = [];
const routerFixture = routerFixtureFor(cleanups);
vi.spyOn(getLogger(), "warn").mockImplementation(() => {});
vi.spyOn(getLogger(), "info").mockImplementation(() => {});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  closeTestDiscoveryDatabases();
});

const POOL = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ya-queue-aar-")));
  const project = join(root, "project"),
    data = join(root, "data"),
    scope = join(root, "native");
  await mkdir(project);
  await mkdir(scope);
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const metadata = createTestSessionMetadataService(data);
  await metadata.initialize();
  const router = await routerFixture(true, false, false, false, metadata);
  await router.connector.connect(router.socketPath);
  const starts: StartSessionOptions[] = [];
  const provider: AgentProvider = {
    name: "codex",
    supportsInlineImages: true,
    acceptsChosenSessionId: false,
    displayName: "Codex",
    supportsPermissionMode: true,
    supportsThinkingToggle: false,
    supportsSlashCommands: false,
    supportsSteering: false,
    isInstalled: async () => true,
    isAuthenticated: async () => true,
    getAuthStatus: async () => ({
      installed: true,
      authenticated: true,
      enabled: true,
    }),
    getAvailableModels: async () => [],
    getNewSessionNamespace: async () => ({
      family: "codex",
      storageScope: scope,
    }),
    startSession: async (options) => {
      starts.push(options);
      const nativeId = randomUUID();
      const source = createControllableIterator();
      source.push({ type: "system", subtype: "init", session_id: nativeId });
      const queue = new MessageQueue(),
        push = queue.push.bind(queue);
      queue.push = (message) => {
        options.onNativeInputConsumed?.(nativeId, message.uuid!);
        return push(message);
      };
      return { iterator: source.iterator, queue, abort: source.finish };
    },
  };
  const supervisor = new Supervisor({
    provider,
    sessionMetadataService: metadata,
    agentAuthRouter: router.connector,
    eventBus: new EventBus(),
    maxWorkers: 4,
    idlePreemptThresholdMs: Infinity,
  });
  cleanups.push(async () => {
    for (const p of supervisor.getAllProcesses()) await p.abort();
    await supervisor.stopBackgroundTasks();
  });
  const service = new ProjectQueueService({ dataDir: data });
  await service.initialize();
  const scheduler = new ProjectQueueScheduler({
    projectQueueService: service,
    creations: metadata.creations,
    supervisor,
    eventBus: new EventBus(),
    idleGraceMs: 60000,
  });
  cleanups.push(async () => scheduler.dispose());
  const projectId = toUrlProjectId(project);
  return {
    router,
    metadata,
    service,
    scheduler,
    starts,
    projectId,
    item: () =>
      service.createItem({
        projectId,
        projectPath: project,
        creationProvenance: { surface: "web" },
        request: {
          target: {
            type: "new-session",
            provider: "codex",
            model: "fixture-model",
            routerPoolId: POOL,
            routerPolicy: "round-robin",
          },
          message: { text: "QUEUE_INPUT" },
        },
      }),
    promote: (itemId: string) =>
      scheduler.promoteNow(projectId, { itemId, force: true }),
  };
}

describe.skipIf(process.platform === "win32")(
  "Project Queue router selection",
  () => {
    it("dispatches a pool item on a pin allocated at dispatch", async () => {
      const f = await fixture();
      const item = await f.item();
      expect(
        f.router.requests.some((r) => r.path === "/v1/pools/prepare"),
      ).toBe(false);
      const result = await f.promote(item.id);
      expect(result, JSON.stringify(result)).toMatchObject({
        promoted: true,
      });
      expect(f.starts).toHaveLength(1);
      expect(f.starts[0]?.routerLaunch?.accountId).toBe("account");
      expect(
        f.metadata.getMetadata(result.sessionId!)?.routerBinding,
      ).toMatchObject({ accountId: "account", poolId: POOL });
      expect(
        f.router.requests.find((r) => r.path === "/v1/pools/prepare")?.body,
      ).toMatchObject({ poolId: POOL, policy: "round-robin" });
    });

    it("retries a refused pool item under its selection, then pauses it, never launching direct", async () => {
      const f = await fixture();
      const item = await f.item();
      f.router.rejectPoolPrepare();
      const first = await f.promote(item.id);
      expect(first.promoted).toBe(false);
      expect(f.starts).toHaveLength(0);
      expect(f.service.listProject(f.projectId).items[0]).toMatchObject({
        status: "queued",
        lastError: expect.stringContaining("no eligible pool account"),
      });

      // Quota frees up: the automatic retry allocates afresh on the same
      // admitted session rather than staying refused.
      f.router.acceptPoolPrepare();
      const second = await f.promote(item.id);
      expect(second, JSON.stringify(second)).toMatchObject({
        promoted: true,
      });
      expect(f.starts).toHaveLength(1);
      expect(f.starts[0]?.routerLaunch?.accountId).toBe("account");
      expect(
        f.metadata.getMetadata(second.sessionId!)?.routerBinding,
      ).toMatchObject({ accountId: "account", poolId: POOL });

      const other = await f.item();
      f.router.rejectPoolPrepare();
      for (let attempt = 0; attempt < 3; attempt++) await f.promote(other.id);
      expect(f.service.listProject(f.projectId).items[0]).toMatchObject({
        status: "failed",
        lastError: expect.stringContaining("no eligible pool account"),
      });
      expect(f.starts).toHaveLength(1);
    });

    it("refuses malformed or out-of-place router selections at enqueue", async () => {
      const f = await fixture();
      const create = (target: Record<string, unknown>) =>
        f.service.createItem({
          projectId: f.projectId,
          projectPath: "/unused",
          creationProvenance: { surface: "web" },
          request: {
            target: target as never,
            message: { text: "x" },
          },
        });
      await expect(
        create({ type: "new-session", routerPolicy: "round-robin" }),
      ).rejects.toThrow("target.routerPolicy is invalid");
      await expect(
        create({
          type: "new-session",
          routerPoolId: POOL,
          sandboxLevel: "project-write",
        }),
      ).rejects.toThrow("local unsandboxed owner launch");
      await expect(
        create({
          type: "new-session",
          provider: "codex",
          routerAccountId: "account",
          routerClaudeAiConnectors: true,
        }),
      ).rejects.toThrow("routerClaudeAiConnectors is invalid");
      await expect(
        create({
          type: "existing-session",
          sessionId: "s",
          routerPoolId: POOL,
        }),
      ).rejects.toThrow("existing session keeps its pin");
    });
  },
);
