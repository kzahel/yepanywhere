import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, expect, it, vi } from "vitest";
import {
  toUrlProjectId,
  type SessionCreationProvenance,
  type ProjectQueueStagedAttachments,
} from "@yep-anywhere/shared";
import {
  createGlobalProjectQueueRoutes,
  createProjectQueueRoutes,
} from "../../src/routes/project-queue.js";
import { ProjectQueueService } from "../../src/services/ProjectQueueService.js";
import { ProjectQueueScheduler } from "../../src/services/ProjectQueueScheduler.js";
import { Supervisor } from "../../src/supervisor/Supervisor.js";
import { ProjectStoragePolicy } from "../../src/projects/projectStoragePolicy.js";
import { AttachmentStagingService } from "../../src/uploads/AttachmentStagingService.js";
import type { AgentProvider } from "../../src/sdk/providers/types.js";
import type { ProjectScanner } from "../../src/projects/scanner.js";
import { EventBus } from "../../src/watcher/EventBus.js";
import { CreationAttachments } from "../../src/sessions/creation-attachments.js";
import { MessageQueue } from "../../src/sdk/messageQueue.js";
import {
  createControllableIterator,
  waitFor,
} from "../process.test-support.js";
import {
  closeTestDiscoveryDatabases,
  createTestSessionMetadataService,
} from "../utils/session-metadata-database.js";

const disposals: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of disposals.splice(0).reverse()) await dispose();
  vi.restoreAllMocks();
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "ya-queue-provenance-"));
  disposals.push(async () => {
    closeTestDiscoveryDatabases();
    await rm(root, { recursive: true, force: true });
  });
  const projectPath = join(root, "project"),
    dataDir = join(root, "data");
  await mkdir(projectPath);
  const projectId = toUrlProjectId(projectPath);
  const metadata = createTestSessionMetadataService(dataDir);
  await metadata.initialize();
  const eventBus = new EventBus();
  const staging = new AttachmentStagingService({
    stagingRoot: join(root, "staging"),
    storagePolicy: new ProjectStoragePolicy({
      dataDir,
      getMode: () => "app-data",
    }),
  });
  let service = new ProjectQueueService({
    dataDir,
    attachmentStagingService: staging,
  });
  await service.initialize();
  const starts: Array<{
    initialId: string;
    nativeId: string;
    provenance: SessionCreationProvenance | undefined;
  }> = [];
  const provider: AgentProvider = {
    name: "claude",
    acceptsChosenSessionId: true,
    getNewSessionNamespace: async () => ({
      family: "claude",
      storageScope: join(root, "sessions"),
    }),
    displayName: "Controlled Claude",
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
    startSession: async (options) => {
      const initialId = options.newSessionId!;
      const nativeId = options.resumeSessionId ?? options.newSessionId!;
      // A separate SQLite connection observes the committed source before native start.
      const disk = createTestSessionMetadataService(dataDir);
      await disk.initialize();
      const provenance = disk.getMetadata(initialId)?.creationProvenance;
      starts.push({ initialId, nativeId, provenance });
      const source = createControllableIterator();
      source.push({ type: "system", subtype: "init", session_id: nativeId });
      const queue = new MessageQueue();
      const input = queue.generator();
      void input.next().then(async (turn) => {
        if (!turn.done) {
          source.push({
            type: "assistant",
            session_id: nativeId,
            user_message_uuid: turn.value.uuid,
            message: { role: "assistant", content: "accepted" },
          });
          source.push({
            type: "result",
            subtype: "success",
            session_id: nativeId,
          });
        }
        await input.return();
      });
      return {
        iterator: source.iterator,
        queue,
        abort: async () => {
          source.finish();
          await input.return();
        },
      };
    },
  };
  const supervisor = new Supervisor({
    provider,
    sessionMetadataService: metadata,
    creationAttachments: new CreationAttachments(
      join(dataDir, "creation-files"),
      staging,
      new ProjectStoragePolicy({ dataDir, getMode: () => "app-data" }),
      metadata.creations,
    ),
    maxWorkers: 1,
    idlePreemptThresholdMs: Infinity,
    eventBus,
  });
  disposals.push(async () => {
    for (const p of supervisor.getAllProcesses()) await p.abort();
    await supervisor.stopBackgroundTasks();
  });
  const scanner = {
    getOrCreateProject: async () => ({
      id: projectId,
      path: projectPath,
      name: "project",
      sessionDir: join(root, "sessions"),
      sessionCount: 0,
      activeOwnedCount: 0,
      activeExternalCount: 0,
      lastActivity: null,
      provider: "claude",
    }),
  } as unknown as ProjectScanner;
  const routes = () =>
    createProjectQueueRoutes({ scanner, projectQueueService: service });
  return {
    root,
    dataDir,
    projectPath,
    projectId,
    metadata,
    eventBus,
    staging,
    starts,
    provider,
    supervisor,
    routes,
    get service() {
      return service;
    },
    async reopen() {
      service = new ProjectQueueService({
        dataDir,
        attachmentStagingService: staging,
      });
      await service.initialize();
    },
  };
}

it.each([
  {
    name: "UI enqueue and immediate admission",
    surface: "web" as const,
    variant: "immediate",
  },
  {
    name: "API enqueue and worker deferral",
    surface: "api" as const,
    variant: "deferred",
  },
  {
    name: "desktop enqueue and staged attachments",
    surface: "desktop" as const,
    variant: "staged",
  },
  {
    name: "legacy item without source",
    surface: "web" as const,
    variant: "legacy",
  },
])(
  "preserves original provenance through restart, retry and forced promotion: $name",
  async ({ surface, variant }) => {
    const f = await fixture();
    const source: SessionCreationProvenance =
      surface === "api" ? { surface } : { surface, clientVersion: "0.11.0" };
    const expected = variant === "legacy" ? undefined : source;
    let stagedAttachments: ProjectQueueStagedAttachments | undefined;
    if (variant === "staged") {
      const started = await f.staging.startDraftUpload({
        batchId: "queued-file",
        originalName: "queued.txt",
        size: 4,
        mimeType: "text/plain",
      });
      await f.staging.writeChunk(started.uploadId, Buffer.from("file"));
      stagedAttachments = {
        batchId: started.batchId,
        refs: [await f.staging.completeUpload(started.uploadId)],
        updatedAt: new Date().toISOString(),
      };
    }
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (surface !== "api") {
      headers["X-Yep-Client-Surface"] = surface;
      headers["X-Yep-Client-Version"] = "0.11.0";
    }
    const response = await f.routes().request(`/${f.projectId}/queue`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        target: { type: "new-session", provider: "claude" },
        message: {
          text: "original prompt",
          ...(stagedAttachments ? { stagedAttachments } : {}),
        },
        createdFrom: { client: "new-session" },
      }),
    });
    expect(response.status).toBe(201);
    const { item } = await response.json();
    expect(item.creationProvenance).toEqual(source);
    if (variant === "legacy") {
      const file = join(f.dataDir, "project-queues.json");
      const state = JSON.parse(await readFile(file, "utf8"));
      delete state.items[0].creationProvenance;
      await writeFile(file, JSON.stringify(state));
    }
    await f.reopen();
    expect(
      f.service.listProject(f.projectId).items[0]?.creationProvenance,
    ).toEqual(expected);
    // A later UI edits/retries/forces this work; none of those requests creates it again.
    const edited = await f
      .routes()
      .request(`/${f.projectId}/queue/${item.id}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "X-Yep-Client-Surface": "desktop",
        },
        body: JSON.stringify({
          message: { ...item.message, text: "edited prompt" },
        }),
      });
    expect(edited.status).toBe(200);
    await f.service.resumeDispatch();
    await f.service.claimDispatchableItem(f.projectId, item.id);
    await f.service.failDispatch(
      f.projectId,
      item.id,
      "controlled pre-dispatch failure",
    );
    await f.service.retryItem(f.projectId, item.id);
    expect(
      f.service.listProject(f.projectId).items[0]?.creationProvenance,
    ).toEqual(expected);
    if (variant === "staged")
      expect(
        f.service.listProject(f.projectId).items[0]?.message.stagedAttachments,
      ).toBeDefined();
    let blocker: Awaited<ReturnType<Supervisor["startSession"]>> | undefined;
    if (variant === "deferred")
      blocker = await f.supervisor.startSession(
        f.projectPath,
        {
          text: "occupy worker",
        },
        undefined,
        undefined,
        {
          creation: {
            context: {
              owner: { kind: "superuser" },
              source: { kind: "request", provenance: { surface: "api" } },
            },
            authorize: async () => {},
          },
        },
      );
    const scheduler = new ProjectQueueScheduler({
      projectQueueService: f.service,
      creations: f.metadata.creations,
      supervisor: f.supervisor,
      eventBus: f.eventBus,
      attachmentStagingService: f.staging,
      idleGraceMs: 60000,
    });
    disposals.push(() => scheduler.dispose());
    const app = new Hono();
    app.route(
      "/",
      createGlobalProjectQueueRoutes({
        projectQueueService: f.service,
        projectQueueScheduler: scheduler,
      }),
    );
    const forced = await app.request(`/${f.projectId}/promote-now`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Yep-Client-Surface": "web",
      },
      body: JSON.stringify({ itemId: item.id, force: true }),
    });
    expect(forced.status).toBe(200);
    const { promoteResult } = await forced.json();
    expect(promoteResult.promoted).toBe(true);
    if (blocker && "abort" in blocker) {
      expect(f.starts).toHaveLength(1);
      await blocker.abort();
    }
    await waitFor(() =>
      expect(f.starts.length).toBe(variant === "deferred" ? 2 : 1),
    );
    const last = f.starts.at(-1)!;
    expect(last.provenance).toEqual(expected);
    await waitFor(() =>
      expect(f.service.listProject(f.projectId).items).toHaveLength(0),
    );
    await waitFor(() =>
      expect(f.metadata.getMetadata(last.nativeId)?.creationProvenance).toEqual(
        expected,
      ),
    );
    const disk = createTestSessionMetadataService(f.dataDir);
    await disk.initialize();
    expect(disk.getMetadata(last.nativeId)?.creationProvenance).toEqual(
      expected,
    );
  },
);

it("refuses missing enqueue provenance and failed metadata persistence before any provider effects", async () => {
  const f = await fixture();
  await expect(
    f.service.createItem({
      projectId: f.projectId,
      projectPath: f.projectPath,
      request: {
        target: { type: "new-session" },
        message: { text: "missing source" },
      },
    } as Parameters<ProjectQueueService["createItem"]>[0]),
  ).rejects.toThrow("provenance is required");
  vi.spyOn(f.metadata.creations, "admit").mockRejectedValue(
    new Error("controlled storage refusal"),
  );
  for (const createOnly of [false, true]) {
    const pending = createOnly
      ? f.supervisor.startSession(
          f.projectPath,
          { text: "" },
          undefined,
          undefined,
          {
            creation: {
              intent: "prepare",
              context: {
                owner: { kind: "superuser" },
                source: { kind: "request", provenance: { surface: "api" } },
              },
              authorize: async () => {},
            },
          },
        )
      : f.supervisor.startSession(
          f.projectPath,
          { text: "must not launch" },
          undefined,
          undefined,
          {
            creation: {
              context: {
                owner: { kind: "superuser" },
                source: { kind: "request", provenance: { surface: "api" } },
              },
              authorize: async () => {},
            },
          },
        );
    await expect(pending).rejects.toThrow("controlled storage refusal");
  }
  expect(f.starts).toHaveLength(0);
});

it("does not relabel an existing session when an API-queued follow-up runs", async () => {
  const f = await fixture();
  const original = await f.supervisor.startSession(
    f.projectPath,
    { text: "original UI turn" },
    undefined,
    undefined,
    {
      creation: {
        context: {
          owner: { kind: "superuser" },
          source: { kind: "request", provenance: { surface: "web" } },
        },
        authorize: async () => {},
      },
    },
  );
  expect("sessionId" in original).toBe(true);
  const id = f.starts[0]!.nativeId;
  await waitFor(() =>
    expect(
      f.metadata.creations.getForSession(
        id as import("@yep-anywhere/shared").YaSessionId,
      )?.attempt.delivery,
    ).toBe("consumed"),
  );
  await waitFor(() =>
    expect(f.metadata.getMetadata(id)?.creationProvenance).toEqual({
      surface: "web",
    }),
  );
  const response = await f.routes().request(`/${f.projectId}/queue`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      target: { type: "existing-session", sessionId: id },
      message: { text: "API follow-up" },
    }),
  });
  expect(response.status).toBe(201);
  const { item } = await response.json();
  expect(item.creationProvenance).toEqual({ surface: "api" });
  const scheduler = new ProjectQueueScheduler({
    projectQueueService: f.service,
    creations: f.metadata.creations,
    supervisor: f.supervisor,
    eventBus: f.eventBus,
    idleGraceMs: 60000,
  });
  disposals.push(() => scheduler.dispose());
  expect(
    (await scheduler.promoteNow(f.projectId, { itemId: item.id, force: true }))
      .promoted,
  ).toBe(true);
  expect(f.metadata.getMetadata(id)?.creationProvenance).toEqual({
    surface: "web",
  });
  expect(f.starts).toHaveLength(1);
});
