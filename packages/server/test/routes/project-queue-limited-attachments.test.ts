import {
  type LimitedUserGrants,
  type ProjectQueueItemSummary,
  type StagedAttachmentRef,
  toUrlProjectId,
  type UrlProjectId,
} from "@yep-anywhere/shared";
import { Hono } from "hono";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PRINCIPAL_VARIABLE,
  type Principal,
} from "../../src/auth/principal.js";
import type { ProjectScanner } from "../../src/projects/scanner.js";
import { createProjectQueueRoutes } from "../../src/routes/project-queue.js";
import { CreationAttachments } from "../../src/sessions/creation-attachments.js";
import { ProjectStoragePolicy } from "../../src/projects/projectStoragePolicy.js";
import { snapshotCreationLaunch } from "../../src/sessions/session-creation-launch.js";
import type { SessionCreationStore } from "../../src/sessions/SessionCreationStore.js";
import type {
  ModelSettings,
  SessionLaunchOptions,
} from "../../src/supervisor/Supervisor.js";
import {
  closeTestDiscoveryDatabases,
  createTestSessionMetadataService,
} from "../utils/session-metadata-database.js";
import type { UserMessage } from "../../src/sdk/types.js";
import {
  type ProjectQueueDispatchResult,
  type ProjectQueueProcessSnapshot,
  ProjectQueueScheduler,
  type ProjectQueueSupervisor,
} from "../../src/services/ProjectQueueScheduler.js";
import { ProjectQueueService } from "../../src/services/ProjectQueueService.js";
import type { Project } from "../../src/supervisor/types.js";
import { AttachmentStagingService } from "../../src/uploads/index.js";
import { EventBus } from "../../src/watcher/EventBus.js";

/**
 * Project Queue attachments of limited users, end to end through the queue
 * route, the persisted queue and staging index, and the scheduler: every
 * draft is looked up only in the acting account's own store
 * (topics/project-queue.md § Attachments).
 */

const SUPERUSER: Principal = { kind: "superuser" };

function limitedUser(username: string, projectId: UrlProjectId): Principal {
  return {
    kind: "limited",
    username,
    grants: grantsFor(projectId),
    switched: false,
    locked: true,
    via: "direct",
  };
}

function grantsFor(projectId: UrlProjectId): LimitedUserGrants {
  return {
    newSessionProjects: [projectId],
    joinProjects: [],
    viewProjects: [],
    joinStaleOffsetMinutes: 0,
    lock: {},
  };
}

async function stageDraft(
  store: AttachmentStagingService,
  batchId: string,
  name: string,
  content: string,
): Promise<StagedAttachmentRef> {
  const body = Buffer.from(content);
  const started = await store.startDraftUpload({
    batchId,
    originalName: name,
    size: body.length,
    mimeType: "text/plain",
  });
  await store.writeChunk(started.uploadId, body);
  return store.completeUpload(started.uploadId);
}

function stagedMessage(
  text: string,
  batchId: string,
  refs: StagedAttachmentRef[],
) {
  return {
    text,
    stagedAttachments: {
      batchId,
      refs,
      updatedAt: "2026-09-28T00:00:00.000Z",
    },
  };
}

class RecordingSupervisor implements ProjectQueueSupervisor {
  processes: ProjectQueueProcessSnapshot[] = [];
  acceptedInputs: { sessionId: string; message: UserMessage }[] = [];

  constructor(
    private projectId: UrlProjectId,
    private creations: SessionCreationStore,
    private files: CreationAttachments,
  ) {}

  getAllProcesses(): ProjectQueueProcessSnapshot[] {
    return this.processes;
  }

  getQueueInfo(): { projectId: UrlProjectId }[] {
    return [];
  }

  async startSession(
    projectPath: string,
    message: UserMessage,
    _mode?: import("@yep-anywhere/shared").PermissionMode,
    settings?: ModelSettings,
    options?: SessionLaunchOptions,
  ): Promise<ProjectQueueDispatchResult> {
    const creation = options!.creation!;
    const attachments = await this.files.seal(
      creation.context.owner,
      creation.requestId!,
      creation.attachments,
    );
    const saved = this.creations.admit({
      requestId: creation.requestId!,
      context: creation.context,
      request: {
        provider: "claude",
        projectId: this.projectId,
        projectPath,
        message: message.text,
        attachments,
        launch: snapshotCreationLaunch(settings ?? {}),
        settings: {
          permissionMode: "default",
          requestedModel: settings?.model ?? null,
          serviceTier: null,
          thinking: null,
          effort: null,
        },
      },
    });
    await creation.authorize(saved);
    await creation.onAccepted?.(saved);
    this.acceptedInputs.push({
      sessionId: saved.sessionId,
      message: {
        ...message,
        attachments: await this.files.materialize(
          attachments,
          projectPath,
          saved.sessionId,
        ),
      },
    });
    return this.process(saved.sessionId);
  }

  async createSession(): Promise<ProjectQueueDispatchResult> {
    return this.process("created-session-1");
  }

  async resumeSession(
    sessionId: string,
    _projectPath: string,
    message: UserMessage,
  ): Promise<ProjectQueueDispatchResult> {
    void message;
    return this.process(sessionId);
  }

  private process(sessionId: string): ProjectQueueProcessSnapshot {
    const process: ProjectQueueProcessSnapshot = {
      id: `process-${sessionId}`,
      sessionId,
      projectId: this.projectId,
      projectPath: "/unused",
      state: { type: "idle" },
      queueDepth: 0,
      provider: "claude",
      promptSuggestionMode: "native",
      recapAfterSeconds: 300,
      isRetainingProviderWork: () => false,
      getPendingInputRequest: () => null,
      getDeferredQueueSummary: () => [],
      hasPendingYaCommand: () => false,
      getLivenessSnapshot: () => ({ derivedStatus: "verified-idle" }),
    };
    this.processes.push(process);
    return process;
  }
}

async function waitFor(assertion: () => void | Promise<void>): Promise<void> {
  const started = Date.now();
  for (;;) {
    try {
      await assertion();
      return;
    } catch (error) {
      if (Date.now() - started > 2000) throw error;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
}

describe("Project Queue attachments of limited users", () => {
  let testDir: string;
  let projectId: UrlProjectId;
  let project: Project;
  let stagingRoot: string;
  let staging: AttachmentStagingService;
  let queue: ProjectQueueService;
  let principal: Principal;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "project-queue-limited-attachments-"),
    );
    const projectPath = path.join(testDir, "project");
    await fs.mkdir(projectPath, { recursive: true });
    projectId = toUrlProjectId(projectPath);
    project = {
      id: projectId,
      path: projectPath,
      name: "project",
      sessionCount: 0,
      sessionDir: path.join(projectPath, ".sessions"),
      activeOwnedCount: 0,
      activeExternalCount: 0,
      lastActivity: null,
      provider: "claude",
    };
    stagingRoot = path.join(testDir, "staging");
    ({ staging, queue } = await startServer());
    principal = SUPERUSER;
  });

  afterEach(async () => {
    closeTestDiscoveryDatabases();
    await fs.rm(testDir, { recursive: true, force: true });
  });

  /** What a server (re)start builds: fresh services over the same data. */
  async function startServer() {
    const nextStaging = new AttachmentStagingService({ stagingRoot });
    await nextStaging.initialize();
    const nextQueue = new ProjectQueueService({
      dataDir: path.join(testDir, "data"),
      attachmentStagingService: nextStaging,
    });
    await nextQueue.initialize();
    return { staging: nextStaging, queue: nextQueue };
  }

  function routes() {
    const app = new Hono<{
      Variables: Record<typeof PRINCIPAL_VARIABLE, Principal>;
    }>();
    app.use("*", async (c, next) => {
      c.set(PRINCIPAL_VARIABLE, principal);
      await next();
    });
    app.route(
      "/",
      createProjectQueueRoutes({
        scanner: {
          getOrCreateProject: vi.fn(async (id) =>
            id === projectId ? project : null,
          ),
        } as unknown as ProjectScanner,
        projectQueueService: queue,
      }),
    );
    return (method: string, url: string, body?: unknown) =>
      app.request(url, {
        method,
        ...(body === undefined
          ? {}
          : {
              body: JSON.stringify(body),
              headers: { "Content-Type": "application/json" },
            }),
      });
  }

  it.each(["batch-a", "batch-b"])(
    "queues and dispatches a limited user's files with second batch %s after restart",
    async (secondBatch) => {
      // As with an initialized draft-sync store, allow per-ref batch validation.
      staging.setDraftProtection(() => false);
      const alice = staging.forUser("alice");
      const ref = await stageDraft(alice, "batch-a", "notes.txt", "from alice");
      const second = await stageDraft(
        alice,
        secondBatch,
        "more.txt",
        "more from alice",
      );
      principal = limitedUser("alice", projectId);

      const created = await routes()("POST", `/${projectId}/queue`, {
        target: { type: "new-session", provider: "claude" },
        message: stagedMessage("read my notes", "batch-a", [ref, second]),
      });
      expect(created.status).toBe(201);
      const { item } = (await created.json()) as {
        item: ProjectQueueItemSummary;
      };
      expect(item.createdByUser).toBe("alice");
      // The draft became the item's, inside alice's own store.
      expect(alice.getRecord(ref.id)?.owner).toEqual({
        type: "project-queue",
        queueItemId: item.id,
      });
      await expect(alice.listDraftAttachments("batch-a")).resolves.toEqual([]);
      expect(staging.getRecord(ref.id)).toBeNull();

      // A restart loads the persisted queue and each account's staging index.
      ({ staging, queue } = await startServer());
      expect(queue.listProject(projectId).items).toMatchObject([
        { id: item.id, createdByUser: "alice", status: "queued" },
      ]);

      const dataDir = path.join(testDir, "data");
      const metadata = createTestSessionMetadataService(dataDir);
      await metadata.initialize();
      const files = new CreationAttachments(
        path.join(dataDir, "creation-files"),
        staging,
        new ProjectStoragePolicy({ dataDir, getMode: () => "app-data" }),
        metadata.creations,
      );
      const supervisor = new RecordingSupervisor(
        projectId,
        metadata.creations,
        files,
      );
      const scheduler = new ProjectQueueScheduler({
        projectQueueService: queue,
        supervisor,
        creations: metadata.creations,
        eventBus: new EventBus(),
        attachmentStagingService: staging,
        getLimitedUserGrants: (username) =>
          username === "alice" ? grantsFor(projectId) : null,
        isSessionFreshForLimitedTurn: async () => true,
        idleGraceMs: 1,
      });
      try {
        // The restart paused dispatch; Start now on the item resumes it.
        expect(queue.isDispatchPaused()).toBe(true);
        const promoted = await scheduler.promoteNow(projectId, { force: true });
        expect(promoted).toMatchObject({ promoted: true });
        expect(supervisor.acceptedInputs).toHaveLength(1);
        const [attachment] = supervisor.acceptedInputs[0]!.message.attachments!;
        expect(attachment).toMatchObject({ id: ref.id, name: ref.name });
        await expect(fs.readFile(attachment!.path, "utf-8")).resolves.toBe(
          "from alice",
        );
        const attachments = supervisor.acceptedInputs[0]!.message.attachments!;
        expect(attachments.map((file) => file.id)).toEqual([ref.id, second.id]);
        expect(
          await Promise.all(
            attachments.map((file) => fs.readFile(file.path, "utf-8")),
          ),
        ).toEqual(["from alice", "more from alice"]);
        expect(supervisor.acceptedInputs[0]!.message.metadata).toMatchObject({
          sentByUser: "alice",
        });
        expect(
          metadata.creations.getForSession(
            supervisor.acceptedInputs[0]!
              .sessionId as import("@yep-anywhere/shared").YaSessionId,
          )?.request?.attachments?.files,
        ).toHaveLength(2);
        // Settling the item removes its staged copy from alice's store.
        await waitFor(async () => {
          expect(queue.listProject(projectId).items).toEqual([]);
          await expect(
            staging.forUser("alice").listQueueAttachments(item.id),
          ).resolves.toEqual([]);
        });
      } finally {
        await scheduler.dispose();
      }
    },
  );

  it("refuses a reference staged by another account, leaving that draft alone", async () => {
    const alice = staging.forUser("alice");
    const aliceRef = await stageDraft(alice, "batch-a", "secret.txt", "a");
    const request = {
      target: { type: "new-session", provider: "claude" },
      message: stagedMessage("take alice's file", "batch-a", [aliceRef]),
    };

    principal = limitedUser("bob", projectId);
    const byBob = await routes()("POST", `/${projectId}/queue`, request);
    expect(byBob.status).toBe(400);
    // Neither is the superuser's root store searched on alice's behalf.
    principal = SUPERUSER;
    const bySuperuser = await routes()("POST", `/${projectId}/queue`, request);
    expect(bySuperuser.status).toBe(400);

    expect(queue.listProject(projectId).items).toEqual([]);
    await expect(alice.listDraftAttachments("batch-a")).resolves.toEqual([
      aliceRef,
    ]);
  });

  it("keeps a limited user's item in their store when the superuser edits it", async () => {
    const alice = staging.forUser("alice");
    const kept = await stageDraft(alice, "batch-a", "kept.txt", "kept");
    const dropped = await stageDraft(alice, "batch-a", "dropped.txt", "gone");
    const otherDraft = await stageDraft(alice, "batch-b", "other.txt", "b");
    principal = limitedUser("alice", projectId);
    const created = await routes()("POST", `/${projectId}/queue`, {
      target: { type: "new-session", provider: "claude" },
      message: stagedMessage("two files", "batch-a", [kept, dropped]),
    });
    expect(created.status).toBe(201);
    const { item } = (await created.json()) as {
      item: ProjectQueueItemSummary;
    };
    const queuedRefs = item.message.stagedAttachments!.refs;

    principal = SUPERUSER;
    const send = routes();
    // The editor's own new draft cannot join another account's item...
    const superDraft = await stageDraft(staging, "batch-s", "mine.txt", "s");
    const added = await send("PATCH", `/${projectId}/queue/${item.id}`, {
      message: stagedMessage("two files", "batch-a", [
        ...queuedRefs,
        superDraft,
      ]),
    });
    expect(added.status).toBe(400);
    // ...nor can the edit reach alice's other drafts.
    const reached = await send("PATCH", `/${projectId}/queue/${item.id}`, {
      message: stagedMessage("two files", "batch-a", [
        ...queuedRefs,
        otherDraft,
      ]),
    });
    expect(reached.status).toBe(400);
    await expect(alice.listDraftAttachments("batch-b")).resolves.toEqual([
      otherDraft,
    ]);
    await expect(staging.listDraftAttachments("batch-s")).resolves.toEqual([
      superDraft,
    ]);

    // Retaining and removing the item's own attachments still works, and
    // the removed one is cleaned up from alice's store.
    const edited = await send("PATCH", `/${projectId}/queue/${item.id}`, {
      message: stagedMessage("one file", "batch-a", [
        queuedRefs.find((ref) => ref.id === kept.id)!,
      ]),
    });
    expect(edited.status).toBe(200);
    const { item: editedItem } = (await edited.json()) as {
      item: ProjectQueueItemSummary;
    };
    expect(editedItem.createdByUser).toBe("alice");
    expect(alice.getRecord(kept.id)?.owner).toEqual({
      type: "project-queue",
      queueItemId: item.id,
    });
    expect(alice.getRecord(dropped.id)).toBeNull();

    // Deleting the item removes what remains of it from alice's store.
    const deleted = await send("DELETE", `/${projectId}/queue/${item.id}`);
    expect(deleted.status).toBe(200);
    await expect(alice.listQueueAttachments(item.id)).resolves.toEqual([]);
    expect(alice.getRecord(kept.id)).toBeNull();
  });
});
