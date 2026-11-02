import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { toUrlProjectId, parseYaSessionId } from "@yep-anywhere/shared";
import { Supervisor } from "../../src/supervisor/Supervisor.js";
import { ProjectQueueService } from "../../src/services/ProjectQueueService.js";
import { ProjectQueueScheduler } from "../../src/services/ProjectQueueScheduler.js";
import { EventBus } from "../../src/watcher/EventBus.js";
import { MessageQueue } from "../../src/sdk/messageQueue.js";
import type { AgentProvider } from "../../src/sdk/providers/types.js";
import { getLogger } from "../../src/logging/logger.js";
import {
  createControllableIterator,
  waitFor,
} from "../process.test-support.js";
import {
  createTestSessionMetadataService,
  closeTestDiscoveryDatabases,
} from "../utils/session-metadata-database.js";

const cleanup: Array<() => Promise<void>> = [];
const warnings = vi.spyOn(getLogger(), "warn").mockImplementation(() => {});

afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
  closeTestDiscoveryDatabases();
  for (const call of warnings.mock.calls)
    expect(String(call[1])).toMatch(
      /Project queue dispatch failed|Process terminated/,
    );
  warnings.mockClear();
});
async function fixture(providerName: "claude" | "codex") {
  const root = await realpath(
      await mkdtemp(join(tmpdir(), "ya-queue-creation-")),
    ),
    project = join(root, "project"),
    data = join(root, "data"),
    scope = join(root, "native");
  await mkdir(project);
  await mkdir(scope);
  cleanup.push(async () => {
    closeTestDiscoveryDatabases();
    await rm(root, { recursive: true, force: true });
  });
  const projectId = toUrlProjectId(project),
    metadata = createTestSessionMetadataService(data);
  await metadata.initialize();
  let service = new ProjectQueueService({ dataDir: data });
  await service.initialize();
  const bus = new EventBus();
  const starts: Array<{
    publicId: string;
    nativeId: string;
    inputId: string;
    source: string | undefined;
  }> = [];
  let available = true,
    fail = false;
  const provider: AgentProvider = {
    name: providerName,
    displayName: "Owned native",
    supportsPermissionMode: true,
    supportsThinkingToggle: false,
    supportsSlashCommands: false,
    supportsSteering: false,
    isInstalled: async () => available,
    isAuthenticated: async () => true,
    getAuthStatus: async () => ({
      installed: available,
      authenticated: true,
      enabled: true,
    }),
    getAvailableModels: async () => [],
    getNewSessionNamespace: async () => ({
      family: providerName,
      storageScope: scope,
    }),
    startSession: async (options) => {
      const publicId = options.publicSessionId!,
        nativeId = providerName === "claude" ? publicId : randomUUID();
      const disk = createTestSessionMetadataService(data);
      await disk.initialize();
      expect(
        disk.creations.getForSession(parseYaSessionId(publicId))?.request
          ?.message,
      ).toBe("QUEUE_INPUT");
      if (
        starts.length === 0 &&
        disk.creations.getForSession(parseYaSessionId(publicId))?.request?.input
          ?.automaticSource === "project-queue"
      )
        expect(
          JSON.parse(
            await readFile(join(data, "project-queues.json"), "utf8"),
          ).items.some(
            (i: { creationSessionId?: string }) =>
              i.creationSessionId === publicId,
          ),
        ).toBe(true);
      starts.push({
        publicId,
        nativeId,
        inputId: "",
        source: metadata.getMetadata(publicId)?.creationProvenance?.surface,
      });
      if (fail) throw Error("native launch lost");
      const source = createControllableIterator();
      source.push({ type: "system", subtype: "init", session_id: nativeId });
      const queue = new MessageQueue(),
        push = queue.push.bind(queue);
      queue.push = (message) => {
        starts.at(-1)!.inputId = message.uuid!;
        options.onNativeInputConsumed?.(nativeId, message.uuid!);
        return push(message);
      };
      return { iterator: source.iterator, queue, abort: source.finish };
    },
  };
  const supervisor = new Supervisor({
    provider,
    sessionMetadataService: metadata,
    eventBus: bus,
    maxWorkers: 1,
    idlePreemptThresholdMs: Infinity,
  });
  cleanup.push(async () => {
    for (const p of supervisor.getAllProcesses()) await p.abort();
    await supervisor.stopBackgroundTasks();
  });
  const scheduler = () => {
    const s = new ProjectQueueScheduler({
      projectQueueService: service,
      creations: metadata.creations,
      supervisor,
      eventBus: bus,
      idleGraceMs: 60000,
    });
    cleanup.push(() => s.dispose());
    return s;
  };
  return {
    root,
    project,
    data,
    projectId,
    metadata,
    supervisor,
    starts,
    provider,
    scheduler,
    get service() {
      return service;
    },
    set available(v: boolean) {
      available = v;
    },
    set fail(v: boolean) {
      fail = v;
    },
    async reopen() {
      service = new ProjectQueueService({ dataDir: data });
      await service.initialize();
    },
    async item() {
      return service.createItem({
        projectId,
        projectPath: project,
        creationProvenance: { surface: "web" },
        request: {
          target: { type: "new-session", provider: providerName },
          message: { text: "QUEUE_INPUT" },
        },
      });
    },
  };
}

it.each(["claude", "codex"] as const)(
  "admits %s Queue intent once and recovers an interrupted completion without another native launch",
  async (name) => {
    const f = await fixture(name),
      item = await f.item();
    const scheduler = f.scheduler();
    const originalComplete = f.service.completeDispatch.bind(f.service);
    f.service.completeDispatch = async () => {
      throw Error("owned completion write lost");
    };
    const first = await scheduler.promoteNow(f.projectId, {
      itemId: item.id,
      force: true,
    });
    expect(first.promoted).toBe(false);
    expect(f.starts, JSON.stringify(first)).toHaveLength(1);
    const saved = f.metadata.creations.get(
      { kind: "superuser" },
      `project-queue-${item.id}`,
    )!;
    expect(saved.attempt.delivery).toBe("consumed");
    expect(saved.sessionId).toBe(f.starts[0]!.publicId);
    expect(f.starts[0]!.source).toBe("web");
    if (name === "codex")
      expect(f.starts[0]!.nativeId).not.toBe(saved.sessionId);
    await f.service.retryItem(f.projectId, item.id);
    f.service.completeDispatch = originalComplete;
    const second = await scheduler.promoteNow(f.projectId, {
      itemId: item.id,
      force: true,
    });
    expect(second).toMatchObject({
      promoted: true,
      sessionId: saved.sessionId,
    });
    expect(f.starts).toHaveLength(1);
    expect(f.service.listProject(f.projectId).items).toHaveLength(0);
  },
);

it("retries a proved pre-effect failure under the same public ID and freezes its accepted input", async () => {
  const f = await fixture("codex"),
    item = await f.item(),
    scheduler = f.scheduler();
  f.available = false;
  expect(
    (await scheduler.promoteNow(f.projectId, { itemId: item.id, force: true }))
      .promoted,
  ).toBe(false);
  const saved = f.metadata.creations.get(
    { kind: "superuser" },
    `project-queue-${item.id}`,
  )!;
  expect(saved.attempt).toMatchObject({
    state: "failed",
    delivery: "not-admitted",
  });
  expect(f.starts).toHaveLength(0);
  await expect(
    f.service.updateItem(f.projectId, item.id, {
      message: { text: "changed" },
    }),
  ).rejects.toThrow("admitted session");
  f.available = true;
  await f.service.retryItem(f.projectId, item.id);
  const next = await scheduler.promoteNow(f.projectId, {
    itemId: item.id,
    force: true,
  });
  expect(next, JSON.stringify(next)).toMatchObject({
    promoted: true,
    sessionId: saved.sessionId,
  });
  expect(f.starts).toHaveLength(1);
  expect(
    f.metadata.creations.getForSession(saved.sessionId)?.attempt.attemptId,
  ).not.toBe(saved.attempt.attemptId);
});

it("retains uncertain native launch identity across queue restart and refuses initial-input replay", async () => {
  const f = await fixture("codex"),
    item = await f.item(),
    scheduler = f.scheduler();
  f.fail = true;
  const first = await scheduler.promoteNow(f.projectId, {
    itemId: item.id,
    force: true,
  });
  expect(first.promoted).toBe(false);
  const saved = f.metadata.creations.get(
    { kind: "superuser" },
    `project-queue-${item.id}`,
  )!;
  expect(saved.attempt).toMatchObject({
    state: "uncertain",
    delivery: "uncertain",
  });
  expect(f.starts, JSON.stringify(first)).toHaveLength(1);
  await scheduler.dispose();
  await f.reopen();
  await f.service.retryItem(f.projectId, item.id);
  f.fail = false;
  const recovered = await f
    .scheduler()
    .promoteNow(f.projectId, { itemId: item.id, force: true });
  expect(recovered.promoted).toBe(false);
  expect(f.starts).toHaveLength(1);
  expect(f.service.listProject(f.projectId).items[0]).toMatchObject({
    status: "failed",
    creationSessionId: saved.sessionId,
  });
});

it("hands worker-deferred Queue creation to the common owner once", async () => {
  const f = await fixture("codex");
  const blocker = await f.supervisor.startSession(
    f.project,
    { text: "QUEUE_INPUT" },
    undefined,
    { providerName: "codex" },
    {
      creation: {
        requestId: "owned-worker-blocker",
        context: {
          owner: { kind: "superuser" },
          source: { kind: "request", provenance: { surface: "api" } },
        },
        authorize: async () => {},
      },
    },
  );
  if (!("id" in blocker)) throw Error("Missing owned blocker");
  const item = await f.item(),
    scheduler = f.scheduler();
  const result = await scheduler.promoteNow(f.projectId, {
    itemId: item.id,
    force: true,
  });
  expect(result.promoted).toBe(true);
  const saved = f.metadata.creations.get(
    { kind: "superuser" },
    `project-queue-${item.id}`,
  )!;
  expect(result).toMatchObject({ sessionId: saved.sessionId });
  expect(saved.attempt.state).toBe("queued");
  expect(f.service.listProject(f.projectId).items).toHaveLength(0);
  expect(f.starts).toHaveLength(1);
  await blocker.abort();
  await waitFor(() => expect(f.starts).toHaveLength(2));
  expect(f.starts[1]!.publicId).toBe(saved.sessionId);
  expect(f.starts[1]!.inputId).toBe(saved.initialInputId);
  expect(
    f.metadata.creations.getForSession(saved.sessionId)?.attempt.delivery,
  ).toBe("consumed");
});

it("repairs the admission/association crash gap before edit or retarget and retries original input under the same ID", async () => {
  const f = await fixture("codex"),
    item = await f.item();
  const oldScheduler = f.scheduler();
  await f.service.claimNextDispatchableItem(f.projectId);
  await expect(
    f.supervisor.startSession(
      f.project,
      { text: "QUEUE_INPUT", automaticSource: "project-queue" },
      undefined,
      { providerName: "codex" },
      {
        creation: {
          requestId: `project-queue-${item.id}`,
          context: {
            owner: { kind: "superuser" },
            source: { kind: "request", provenance: { surface: "web" } },
          },
          authorize: async () => {},
          onAccepted: async () => {
            throw Error("owned crash before association");
          },
        },
      },
    ),
  ).rejects.toThrow("owned crash before association");
  const saved = f.metadata.creations.get(
    { kind: "superuser" },
    `project-queue-${item.id}`,
  )!;
  expect(
    JSON.parse(await readFile(join(f.data, "project-queues.json"), "utf8"))
      .items[0].creationSessionId,
  ).toBeUndefined();
  await oldScheduler.dispose();
  await f.reopen();
  const scheduler = f.scheduler();
  await expect(
    f.service.updateItem(f.projectId, item.id, {
      message: { text: "changed input" },
    }),
  ).rejects.toThrow("admitted session");
  await expect(
    f.service.updateItem(f.projectId, item.id, {
      target: { type: "existing-session", sessionId: "other-session" },
    }),
  ).rejects.toThrow("admitted session");
  expect(f.service.listProject(f.projectId).items[0]?.creationSessionId).toBe(
    saved.sessionId,
  );
  await f.service.retryItem(f.projectId, item.id);
  expect(
    await scheduler.promoteNow(f.projectId, { itemId: item.id, force: true }),
  ).toMatchObject({ promoted: true, sessionId: saved.sessionId });
  expect(f.starts).toHaveLength(1);
});
