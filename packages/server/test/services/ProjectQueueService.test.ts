import {
  type StagedAttachmentRef,
  toUrlProjectId,
  type UrlProjectId,
} from "@yep-anywhere/shared";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ProjectQueueService,
  ProjectQueueValidationError,
} from "../../src/services/ProjectQueueService.js";
import { AttachmentStagingService } from "../../src/uploads/index.js";
import { EventBus } from "../../src/watcher/EventBus.js";

async function completeDraftUpload(
  service: AttachmentStagingService,
  content: Buffer,
  batchId = "batch-a",
): Promise<{ batchId: string; ref: StagedAttachmentRef }> {
  const started = await service.startDraftUpload({
    batchId,
    originalName: "queued.txt",
    size: content.length,
    mimeType: "text/plain",
  });
  await service.writeChunk(started.uploadId, content);
  const ref = await service.completeUpload(started.uploadId);
  return { batchId: started.batchId, ref };
}

describe("ProjectQueueService", () => {
  let testDir: string;
  let projectId: UrlProjectId;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), "project-queue-test-"));
    projectId = toUrlProjectId("/tmp/project-queue");
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  async function createService(
    eventBus?: EventBus,
    attachmentStagingService?: AttachmentStagingService,
  ): Promise<ProjectQueueService> {
    const service = new ProjectQueueService({
      dataDir: testDir,
      eventBus,
      attachmentStagingService,
    });
    await service.initialize();
    return service;
  }

  it("persists queued items across service re-instantiation", async () => {
    const service = await createService();
    const created = await service.createItem({
      creationProvenance: { surface: "api" },
      projectId,
      projectPath: "/tmp/project-queue",
      request: {
        target: { type: "existing-session", sessionId: "session-1" },
        message: { text: "follow up after the project is idle  " },
        createdFrom: { client: "toolbar", sessionId: "session-1" },
      },
    });

    const reloaded = await createService();
    const queue = reloaded.listProject(projectId);

    expect(queue.items).toHaveLength(1);
    expect(queue.items[0]).toMatchObject({
      id: created.id,
      projectId,
      target: { type: "existing-session", sessionId: "session-1" },
      messagePreview: "follow up after the project is idle",
      message: { text: "follow up after the project is idle  " },
      status: "queued",
      attachmentCount: 0,
      createdFrom: { client: "toolbar", sessionId: "session-1" },
    });
    expect(queue.dispatchState).toMatchObject({
      status: "paused",
      reason: "restart",
    });
  });

  it("preserves a project sandbox network-firewall opt-out", async () => {
    const service = await createService();
    const created = await service.createItem({
      creationProvenance: { surface: "api" },
      projectId,
      projectPath: "/tmp/project-queue",
      request: {
        target: {
          type: "new-session",
          sandboxLevel: "project-write",
          sandboxNetworkFirewall: false,
        },
        message: { text: "start with direct host networking" },
      },
    });

    expect(created.target).toMatchObject({
      type: "new-session",
      sandboxLevel: "project-write",
      sandboxNetworkFirewall: false,
    });
    const reloaded = await createService();
    expect(reloaded.listProject(projectId).items[0]?.target).toMatchObject({
      type: "new-session",
      sandboxLevel: "project-write",
      sandboxNetworkFirewall: false,
    });
  });

  it("rejects a network firewall without project sandboxing", async () => {
    const service = await createService();

    await expect(
      service.createItem({
        creationProvenance: { surface: "api" },
        projectId,
        projectPath: "/tmp/project-queue",
        request: {
          target: {
            type: "new-session",
            sandboxLevel: "none",
            sandboxNetworkFirewall: true,
          },
          message: { text: "invalid boundary" },
        },
      }),
    ).rejects.toThrow(
      "target.sandboxNetworkFirewall requires project-write sandboxing",
    );
  });

  it("persists manual dispatch pause across service re-instantiation", async () => {
    const service = await createService();
    await service.createItem({
      creationProvenance: { surface: "api" },
      projectId,
      projectPath: "/tmp/project-queue",
      request: {
        target: { type: "existing-session", sessionId: "session-1" },
        message: { text: "wait for manual resume" },
      },
    });

    await service.pauseDispatch();
    const reloaded = await createService();

    expect(reloaded.getDispatchState()).toMatchObject({
      status: "paused",
      reason: "manual",
    });
  });

  it("rejects pausing an empty project queue", async () => {
    const service = await createService();

    await expect(service.pauseDispatch()).rejects.toBeInstanceOf(
      ProjectQueueValidationError,
    );
  });

  it("clears dispatch pause when the last item is deleted", async () => {
    const service = await createService();
    const created = await service.createItem({
      creationProvenance: { surface: "api" },
      projectId,
      projectPath: "/tmp/project-queue",
      request: {
        target: { type: "existing-session", sessionId: "session-1" },
        message: { text: "temporary queued work" },
      },
    });

    await service.pauseDispatch();
    await service.deleteItem(projectId, created.id);

    expect(service.getDispatchState()).toEqual({ status: "running" });
  });

  it("resumes dispatch after successful queued-item mutations", async () => {
    const service = await createService();
    const first = await service.createItem({
      creationProvenance: { surface: "api" },
      projectId,
      projectPath: "/tmp/project-queue",
      request: {
        target: { type: "existing-session", sessionId: "session-1" },
        message: { text: "first item" },
      },
    });
    const second = await service.createItem({
      creationProvenance: { surface: "api" },
      projectId,
      projectPath: "/tmp/project-queue",
      request: {
        target: { type: "existing-session", sessionId: "session-2" },
        message: { text: "second item" },
      },
    });

    await service.pauseDispatch("restart");
    await service.updateItem(projectId, first.id, {
      message: { text: "updated first item" },
    });
    expect(service.getDispatchState()).toEqual({ status: "running" });

    await service.pauseDispatch("restart");
    await service.retryItem(projectId, first.id);
    expect(service.getDispatchState()).toEqual({ status: "running" });

    await service.pauseDispatch("restart");
    await service.moveItemToTop(projectId, second.id);
    expect(service.getDispatchState()).toEqual({ status: "running" });

    await service.pauseDispatch("restart");
    await service.deleteItem(projectId, second.id);
    expect(service.getDispatchState()).toEqual({ status: "running" });
  });

  it("updates, retries, and deletes items with project-scoped events", async () => {
    const eventBus = new EventBus();
    const events: string[] = [];
    eventBus.subscribe((event) => {
      if (event.type === "project-queue-changed") {
        events.push(
          `${event.reason}:${event.itemId ?? ""}:${event.items.length}`,
        );
      }
    });
    const service = await createService(eventBus);
    const created = await service.createItem({
      creationProvenance: { surface: "api" },
      projectId,
      projectPath: "/tmp/project-queue",
      request: {
        target: { type: "new-session", provider: "claude" },
        message: { text: "start later" },
        createdFrom: { client: "new-session" },
      },
    });

    const updated = await service.updateItem(projectId, created.id, {
      message: { text: "start later with more context" },
    });
    const retried = await service.retryItem(projectId, created.id);
    const deleted = await service.deleteItem(projectId, created.id);

    expect(updated?.messagePreview).toBe("start later with more context");
    expect(retried?.status).toBe("queued");
    expect(deleted).toBe(true);
    expect(service.listProject(projectId).items).toHaveLength(0);
    expect(events).toEqual([
      `created:${created.id}:1`,
      `updated:${created.id}:1`,
      `retry:${created.id}:1`,
      `deleted:${created.id}:0`,
    ]);
  });

  it("transfers staged draft attachments to queue ownership and deletes them on cancel", async () => {
    const stagingService = new AttachmentStagingService({
      stagingRoot: path.join(testDir, "staging"),
    });
    const { batchId, ref } = await completeDraftUpload(
      stagingService,
      Buffer.from("queued attachment"),
    );
    const service = await createService(undefined, stagingService);

    const created = await service.createItem({
      creationProvenance: { surface: "api" },
      projectId,
      projectPath: "/tmp/project-queue",
      request: {
        target: { type: "new-session", provider: "claude" },
        message: {
          text: "start later with files",
          stagedAttachments: {
            batchId,
            refs: [ref],
            updatedAt: "2026-06-28T00:00:00.000Z",
          },
        },
        createdFrom: { client: "new-session" },
      },
    });

    expect(created.attachmentCount).toBe(1);
    expect(created.message.stagedAttachments?.refs).toMatchObject([
      { id: ref.id, batchId },
    ]);
    expect(stagingService.getRecord(ref.id)?.owner).toEqual({
      type: "project-queue",
      queueItemId: created.id,
    });
    await expect(stagingService.listDraftAttachments(batchId)).resolves.toEqual(
      [],
    );

    await expect(service.deleteItem(projectId, created.id)).resolves.toBe(true);
    expect(stagingService.getRecord(ref.id)).toBeNull();
  });

  it("adds and removes staged attachments while preserving queue ownership", async () => {
    const stagingService = new AttachmentStagingService({
      stagingRoot: path.join(testDir, "staging"),
    });
    const firstUpload = await completeDraftUpload(
      stagingService,
      Buffer.from("first queued attachment"),
    );
    const service = await createService(undefined, stagingService);
    const created = await service.createItem({
      creationProvenance: { surface: "api" },
      projectId,
      projectPath: "/tmp/project-queue",
      request: {
        target: { type: "new-session", provider: "claude" },
        message: {
          text: "edit attachments later",
          stagedAttachments: {
            batchId: firstUpload.batchId,
            refs: [firstUpload.ref],
            updatedAt: "2026-06-28T00:00:00.000Z",
          },
        },
      },
    });
    const secondUpload = await completeDraftUpload(
      stagingService,
      Buffer.from("second queued attachment"),
      firstUpload.batchId,
    );

    const added = await service.updateItem(projectId, created.id, {
      message: {
        text: "edit attachments later",
        stagedAttachments: {
          batchId: firstUpload.batchId,
          refs: [firstUpload.ref, secondUpload.ref],
          updatedAt: "2026-06-28T00:01:00.000Z",
        },
      },
    });

    expect(added?.message.stagedAttachments?.refs.map((ref) => ref.id)).toEqual(
      [firstUpload.ref.id, secondUpload.ref.id],
    );
    expect(stagingService.getRecord(firstUpload.ref.id)?.owner).toEqual({
      type: "project-queue",
      queueItemId: created.id,
    });
    expect(stagingService.getRecord(secondUpload.ref.id)?.owner).toEqual({
      type: "project-queue",
      queueItemId: created.id,
    });

    const removed = await service.updateItem(projectId, created.id, {
      message: {
        text: "keep only the second attachment",
        stagedAttachments: {
          batchId: firstUpload.batchId,
          refs: [secondUpload.ref],
          updatedAt: "2026-06-28T00:02:00.000Z",
        },
      },
    });

    expect(removed?.attachmentCount).toBe(1);
    expect(removed?.message.stagedAttachments?.refs).toMatchObject([
      { id: secondUpload.ref.id, batchId: firstUpload.batchId },
    ]);
    expect(stagingService.getRecord(firstUpload.ref.id)).toBeNull();
    expect(stagingService.getRecord(secondUpload.ref.id)?.owner).toEqual({
      type: "project-queue",
      queueItemId: created.id,
    });
  });

  it.each([
    ["one batch", "batch-a", "batch-a"],
    ["multiple batches", "batch-b", "batch-c"],
  ])(
    "queues synced copies from %s through create, edit and reload",
    async (_label, secondBatch, thirdBatch) => {
      const stagingService = new AttachmentStagingService({
        stagingRoot: path.join(testDir, "staging"),
      });
      const first = await completeDraftUpload(
        stagingService,
        Buffer.from("synced original"),
      );
      const second = await completeDraftUpload(
        stagingService,
        Buffer.from("unsynced attachment"),
        secondBatch,
      );
      const third = await completeDraftUpload(
        stagingService,
        Buffer.from("synced addition"),
        thirdBatch,
      );
      const protectedIds = new Set([first.ref.id, third.ref.id]);
      stagingService.setDraftProtection((_owner, id) => protectedIds.has(id));
      const service = await createService(undefined, stagingService);
      const created = await service.createItem({
        creationProvenance: { surface: "api" },
        projectId,
        projectPath: "/tmp/project-queue",
        request: {
          target: { type: "new-session", provider: "codex" },
          message: {
            text: "start later with synced files",
            stagedAttachments: {
              batchId: first.batchId,
              refs: [first.ref, second.ref],
              updatedAt: first.ref.updatedAt,
            },
          },
        },
      });
      const createdRefs = created.message.stagedAttachments!.refs;
      expect(createdRefs.map((ref) => ref.batchId)).toEqual([
        first.batchId,
        second.batchId,
      ]);
      expect(createdRefs[0]?.id).not.toBe(first.ref.id);
      expect(createdRefs[1]?.id).toBe(second.ref.id);
      const updated = await service.updateItem(projectId, created.id, {
        message: {
          text: created.message.text,
          stagedAttachments: {
            batchId: third.batchId,
            refs: [third.ref, ...createdRefs],
            updatedAt: third.ref.updatedAt,
          },
        },
      });
      const updatedRefs = updated!.message.stagedAttachments!.refs;
      expect(updated!.message.stagedAttachments!.batchId).toBe(third.batchId);
      expect(updatedRefs.map((ref) => ref.batchId)).toEqual([
        third.batchId,
        first.batchId,
        second.batchId,
      ]);
      expect(updatedRefs[0]?.id).not.toBe(third.ref.id);
      expect(updatedRefs.slice(1)).toEqual(createdRefs);
      await expect(
        stagingService.validateQueueRefs(created.id, updatedRefs),
      ).resolves.toEqual(updatedRefs);

      const reloaded = await createService(undefined, stagingService);
      expect(
        reloaded.listProject(projectId).items[0]?.message.stagedAttachments
          ?.refs,
      ).toEqual(updatedRefs);
      const files = await stagingService.materializeQueueAttachmentsForSession({
        queueItemId: created.id,
        refs: updatedRefs,
        projectPath: "/tmp/project-queue",
        sessionId: "queued-session",
      });
      expect(
        await Promise.all(files.map((file) => fs.readFile(file.path, "utf-8"))),
      ).toEqual(["synced addition", "synced original", "unsynced attachment"]);
      await reloaded.deleteItem(projectId, created.id);
      for (const ref of updatedRefs) {
        expect(stagingService.getRecord(ref.id)).toBeNull();
      }
      for (const upload of [first, third]) {
        await expect(
          stagingService.validateDraftRefs(upload.batchId, [upload.ref]),
        ).resolves.toEqual([upload.ref]);
      }
    },
  );

  it.each(["foreign account", "wrong batch"])(
    "rejects a mixed-batch %s reference on create and edit",
    async (invalidKind) => {
      const staging = new AttachmentStagingService({
        stagingRoot: path.join(testDir, "staging"),
      });
      staging.setDraftProtection(() => true);
      const alice = staging.forUser("alice");
      const first = await completeDraftUpload(
        alice,
        Buffer.from("alice's file"),
      );
      const source =
        invalidKind === "foreign account" ? staging.forUser("bob") : alice;
      const second = await completeDraftUpload(
        source,
        Buffer.from("second file"),
        "batch-b",
      );
      const invalidRef =
        invalidKind === "wrong batch"
          ? { ...second.ref, batchId: "batch-c" }
          : second.ref;
      const service = await createService(undefined, staging);
      const message = (refs: StagedAttachmentRef[]) => ({
        text: "queue these files",
        stagedAttachments: {
          batchId: first.batchId,
          refs,
          updatedAt: first.ref.updatedAt,
        },
      });
      const request = {
        target: { type: "new-session" as const },
        message: message([first.ref, invalidRef]),
      };
      await expect(
        service.createItem({
          creationProvenance: { surface: "api" },
          projectId,
          projectPath: testDir,
          createdByUser: "alice",
          request,
        }),
      ).rejects.toThrow(`Staged attachment not found: ${second.ref.id}`);
      expect(service.listProject(projectId).items).toEqual([]);

      const created = await service.createItem({
        creationProvenance: { surface: "api" },
        projectId,
        projectPath: testDir,
        createdByUser: "alice",
        request: { ...request, message: message([first.ref]) },
      });
      const retained = created.message.stagedAttachments!.refs;
      await expect(
        service.updateItem(
          projectId,
          created.id,
          {
            message: message([...retained, invalidRef]),
          },
          { editor: "alice" },
        ),
      ).rejects.toThrow(`Staged attachment not found: ${second.ref.id}`);
      expect(
        service.listProject(projectId).items[0]?.message.stagedAttachments
          ?.refs,
      ).toEqual(retained);
      await expect(
        alice.validateQueueRefs(created.id, retained),
      ).resolves.toEqual(retained);
      await expect(
        alice.validateDraftRefs(first.batchId, [first.ref]),
      ).resolves.toEqual([first.ref]);
      await expect(
        source.validateDraftRefs(second.batchId, [second.ref]),
      ).resolves.toEqual([second.ref]);
    },
  );

  it("preserves synced originals when saving a queued copy fails", async () => {
    const stagingService = new AttachmentStagingService({
      stagingRoot: path.join(testDir, "staging"),
    });
    const { batchId, ref } = await completeDraftUpload(
      stagingService,
      Buffer.from("synced original"),
    );
    stagingService.setDraftProtection((_owner, id) => id === ref.id);
    const service = await createService(undefined, stagingService);
    await fs.mkdir(service.getFilePath());
    await expect(
      service.createItem({
        creationProvenance: { surface: "api" },
        projectId,
        projectPath: "/tmp/project-queue",
        request: {
          target: { type: "new-session" },
          message: {
            text: "queue with a synced attachment",
            stagedAttachments: {
              batchId,
              refs: [ref],
              updatedAt: ref.updatedAt,
            },
          },
        },
      }),
    ).rejects.toMatchObject({ code: expect.stringMatching(/EISDIR|EPERM/) });
    expect(service.listProject(projectId).items).toEqual([]);
    await expect(
      stagingService.validateDraftRefs(batchId, [ref]),
    ).resolves.toEqual([ref]);
  });

  it("restores draft ownership when an attachment update cannot be saved", async () => {
    const stagingService = new AttachmentStagingService({
      stagingRoot: path.join(testDir, "staging"),
    });
    const firstUpload = await completeDraftUpload(
      stagingService,
      Buffer.from("first queued attachment"),
    );
    const service = await createService(undefined, stagingService);
    const created = await service.createItem({
      creationProvenance: { surface: "api" },
      projectId,
      projectPath: "/tmp/project-queue",
      request: {
        target: { type: "new-session", provider: "claude" },
        message: {
          text: "edit attachments atomically",
          stagedAttachments: {
            batchId: firstUpload.batchId,
            refs: [firstUpload.ref],
            updatedAt: "2026-09-04T00:00:00.000Z",
          },
        },
      },
    });
    const secondUpload = await completeDraftUpload(
      stagingService,
      Buffer.from("second queued attachment"),
      firstUpload.batchId,
    );
    await service.pauseDispatch("restart");

    const request = {
      message: {
        text: "edit attachments atomically",
        stagedAttachments: {
          batchId: firstUpload.batchId,
          refs: [firstUpload.ref, secondUpload.ref],
          updatedAt: "2026-09-04T00:01:00.000Z",
        },
      },
    };
    const queueFile = path.join(testDir, "project-queues.json");
    const persistedQueue = await fs.readFile(queueFile);
    await fs.rm(queueFile);
    await fs.mkdir(queueFile);

    await expect(
      service.updateItem(projectId, created.id, request),
    ).rejects.toThrow();

    expect(service.getDispatchState()).toEqual({
      status: "paused",
      reason: "restart",
      pausedAt: expect.any(String),
    });
    expect(
      service.listProject(projectId).items[0]?.message.stagedAttachments?.refs,
    ).toMatchObject([{ id: firstUpload.ref.id }]);
    expect(stagingService.getRecord(secondUpload.ref.id)?.owner).toEqual({
      type: "draft",
      batchId: firstUpload.batchId,
    });

    await fs.rm(queueFile, { recursive: true });
    await fs.writeFile(queueFile, persistedQueue);
    const retried = await service.updateItem(projectId, created.id, request);

    expect(
      retried?.message.stagedAttachments?.refs.map((ref) => ref.id),
    ).toEqual([firstUpload.ref.id, secondUpload.ref.id]);
    expect(stagingService.getRecord(secondUpload.ref.id)?.owner).toEqual({
      type: "project-queue",
      queueItemId: created.id,
    });
  });

  it("rejects empty messages", async () => {
    const service = await createService();

    await expect(
      service.createItem({
        creationProvenance: { surface: "api" },
        projectId,
        projectPath: "/tmp/project-queue",
        request: {
          target: { type: "existing-session", sessionId: "session-1" },
          message: { text: "   " },
        },
      }),
    ).rejects.toBeInstanceOf(ProjectQueueValidationError);

    await expect(
      service.createItem({
        creationProvenance: { surface: "api" },
        projectId,
        projectPath: "/tmp/project-queue",
        request: {
          target: { type: "existing-session", sessionId: "session-1" },
          message: { text: "   ", attachments: [] },
        },
      }),
    ).rejects.toBeInstanceOf(ProjectQueueValidationError);
  });

  it("filters malformed persisted items and resets dispatching items", async () => {
    await fs.writeFile(
      path.join(testDir, "project-queues.json"),
      JSON.stringify({
        version: 1,
        items: [
          { id: "bad", projectId: "not-a-url-project-id" },
          {
            id: "good",
            projectId,
            projectPath: "/tmp/project-queue",
            target: { type: "existing-session", sessionId: "session-1" },
            message: { text: "still queued after restart" },
            createdAt: "2026-06-01T00:00:00.000Z",
            updatedAt: "2026-06-01T00:00:00.000Z",
            status: "dispatching",
          },
        ],
      }),
    );

    const service = await createService();

    expect(service.listProject(projectId).items).toMatchObject([
      {
        id: "good",
        status: "queued",
        messagePreview: "still queued after restart",
      },
    ]);

    const persisted = JSON.parse(
      await fs.readFile(path.join(testDir, "project-queues.json"), "utf-8"),
    );
    expect(persisted.items).toMatchObject([
      {
        id: "good",
        status: "queued",
      },
    ]);
    expect(persisted.dispatchState).toMatchObject({
      status: "paused",
      reason: "restart",
    });
  });

  describe("queued YA commands", () => {
    const sessionTarget = {
      type: "existing-session" as const,
      sessionId: "session-1",
    };

    async function queueClearloop(service: ProjectQueueService) {
      return service.createItem({
        creationProvenance: { surface: "api" },
        projectId,
        projectPath: "/tmp/project-queue",
        request: {
          target: sessionTarget,
          message: {
            text: "/clearloop 3 2: p",
            yaCommand: { name: "clearloop", argument: "3 2: p" },
          },
        },
      });
    }

    it("derives the command from the text, not the tag's argument", async () => {
      const service = await createService();
      const created = await service.createItem({
        creationProvenance: { surface: "api" },
        projectId,
        projectPath: "/tmp/project-queue",
        request: {
          target: sessionTarget,
          message: {
            text: "/clear 4",
            yaCommand: { name: "clear", argument: "9" },
          },
        },
      });
      expect(created.message.yaCommand).toEqual({
        name: "clear",
        argument: "4",
      });
    });

    it("runs an edited command as the queue now shows it", async () => {
      const service = await createService();
      const created = await queueClearloop(service);

      // An editor spreads the old message, stale tag included.
      const updated = await service.updateItem(projectId, created.id, {
        message: { ...created.message, text: "/clearloop 3 5: q" },
      });

      expect(updated?.message).toEqual({
        text: "/clearloop 3 5: q",
        yaCommand: { name: "clearloop", argument: "3 5: q" },
      });
    });

    it("refuses a tagged message whose text no longer spells the command", async () => {
      const service = await createService();
      const created = await queueClearloop(service);

      await expect(
        service.updateItem(projectId, created.id, {
          message: { ...created.message, text: "summarize instead" },
        }),
      ).rejects.toBeInstanceOf(ProjectQueueValidationError);
      await expect(
        service.updateItem(projectId, created.id, {
          message: { ...created.message, text: "/clear 2" },
        }),
      ).rejects.toBeInstanceOf(ProjectQueueValidationError);
      expect(service.listProject(projectId).items[0]?.message.text).toBe(
        "/clearloop 3 2: p",
      );
    });

    it("refuses a malformed command when it is queued or edited, not at dispatch", async () => {
      const service = await createService();
      for (const [text, name, argument, reason] of [
        ["/clear", "clear", "", "needs a turn number"],
        ["/clear 0", "clear", "0", "needs a turn number"],
        ["/clear abc", "clear", "abc", "Cannot read queued /clear abc"],
        [
          "/clearloop 3 go",
          "clearloop",
          "3 go",
          "Cannot read queued /clearloop 3 go",
        ],
      ] as const) {
        await expect(
          service.createItem({
            creationProvenance: { surface: "api" },
            projectId,
            projectPath: "/tmp/project-queue",
            request: {
              target: sessionTarget,
              message: { text, yaCommand: { name, argument } },
            },
          }),
        ).rejects.toThrow(reason);
      }
      expect(service.listProject(projectId).items).toEqual([]);

      const created = await queueClearloop(service);
      await expect(
        service.updateItem(projectId, created.id, {
          message: { ...created.message, text: "/clearloop 0: p" },
        }),
      ).rejects.toBeInstanceOf(ProjectQueueValidationError);
      expect(service.listProject(projectId).items[0]?.message.text).toBe(
        "/clearloop 3 2: p",
      );
    });

    it("refuses a command bound for a new session, queued or retargeted", async () => {
      const service = await createService();
      await expect(
        service.createItem({
          creationProvenance: { surface: "api" },
          projectId,
          projectPath: "/tmp/project-queue",
          request: {
            target: { type: "new-session" },
            message: {
              text: "/clear 1",
              yaCommand: { name: "clear", argument: "1" },
            },
          },
        }),
      ).rejects.toBeInstanceOf(ProjectQueueValidationError);

      const created = await queueClearloop(service);
      await expect(
        service.updateItem(projectId, created.id, {
          target: { type: "new-session" },
        }),
      ).rejects.toBeInstanceOf(ProjectQueueValidationError);
      expect(service.listProject(projectId).items[0]?.target).toMatchObject(
        sessionTarget,
      );
    });

    it("keeps an inconsistent persisted command as a failed item", async () => {
      const stored = (id: string, text: string, target: unknown) => ({
        id,
        projectId,
        projectPath: "/tmp/project-queue",
        target,
        message: {
          text,
          yaCommand: { name: "clearloop", argument: "3 2: p" },
        },
        createdAt: "2026-06-01T00:00:00.000Z",
        updatedAt: "2026-06-01T00:00:00.000Z",
        status: "queued",
      });
      await fs.writeFile(
        path.join(testDir, "project-queues.json"),
        JSON.stringify({
          version: 3,
          items: [
            stored("edited", "/clearloop 3 5: q", sessionTarget),
            stored("prose", "summarize instead", sessionTarget),
            stored("retargeted", "/clearloop 3 2: p", { type: "new-session" }),
            stored("malformed", "/clearloop 3: ", sessionTarget),
          ],
        }),
      );

      const items = (await createService()).listProject(projectId).items;

      expect(items.map((item) => [item.id, item.status])).toEqual([
        ["edited", "queued"],
        ["prose", "failed"],
        ["retargeted", "failed"],
        ["malformed", "failed"],
      ]);
      expect(items[3]?.lastError).toContain("Cannot read queued /clearloop 3:");
      expect(items[0]?.message.yaCommand).toEqual({
        name: "clearloop",
        argument: "3 5: q",
      });
      expect(items[1]?.lastError).toContain("no longer spells /clearloop");
      expect(items[2]?.lastError).toContain("cannot target a new session");
    });
  });

  it("serializes concurrent creates without dropping writes", async () => {
    const service = await createService();

    await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        service.createItem({
          creationProvenance: { surface: "api" },
          projectId,
          projectPath: "/tmp/project-queue",
          request: {
            target: { type: "existing-session", sessionId: `session-${index}` },
            message: { text: `message ${index}` },
          },
        }),
      ),
    );

    expect(
      service.listProject(projectId).items.map((item) => item.message.text),
    ).toEqual([
      "message 0",
      "message 1",
      "message 2",
      "message 3",
      "message 4",
    ]);
  });

  it("moves an item to the top of its project-local queue", async () => {
    const eventBus = new EventBus();
    const events: string[] = [];
    eventBus.subscribe((event) => {
      if (event.type === "project-queue-changed") {
        events.push(`${event.reason}:${event.itemId ?? ""}`);
      }
    });
    const service = await createService(eventBus);
    const otherProjectId = toUrlProjectId("/tmp/project-queue-other");
    const first = await service.createItem({
      creationProvenance: { surface: "api" },
      projectId,
      projectPath: "/tmp/project-queue",
      request: {
        target: { type: "existing-session", sessionId: "session-1" },
        message: { text: "first project item" },
      },
    });
    const other = await service.createItem({
      creationProvenance: { surface: "api" },
      projectId: otherProjectId,
      projectPath: "/tmp/project-queue-other",
      request: {
        target: { type: "existing-session", sessionId: "session-other" },
        message: { text: "other project item" },
      },
    });
    const second = await service.createItem({
      creationProvenance: { surface: "api" },
      projectId,
      projectPath: "/tmp/project-queue",
      request: {
        target: { type: "existing-session", sessionId: "session-2" },
        message: { text: "second project item" },
      },
    });
    const third = await service.createItem({
      creationProvenance: { surface: "api" },
      projectId,
      projectPath: "/tmp/project-queue",
      request: {
        target: { type: "existing-session", sessionId: "session-3" },
        message: { text: "third project item" },
      },
    });

    const moved = await service.moveItemToTop(projectId, second.id);

    expect(moved).toMatchObject({
      id: second.id,
      messagePreview: "second project item",
    });
    expect(service.listProject(projectId).items.map((item) => item.id)).toEqual(
      [second.id, first.id, third.id],
    );
    expect(service.listAll().map((item) => item.id)).toEqual([
      second.id,
      other.id,
      first.id,
      third.id,
    ]);
    expect(events).toContain(`reordered:${second.id}`);

    const reloaded = await createService();
    expect(
      reloaded.listProject(projectId).items.map((item) => item.id),
    ).toEqual([second.id, first.id, third.id]);
  });

  it("guards dispatching items from user-facing mutations", async () => {
    const service = await createService();
    const created = await service.createItem({
      creationProvenance: { surface: "api" },
      projectId,
      projectPath: "/tmp/project-queue",
      request: {
        target: { type: "existing-session", sessionId: "session-1" },
        message: { text: "dispatch me" },
      },
    });

    const claimed = await service.claimNextDispatchableItem(projectId);

    expect(claimed?.id).toBe(created.id);
    expect(service.listProject(projectId).items[0]).toMatchObject({
      id: created.id,
      status: "dispatching",
    });
    await expect(
      service.updateItem(projectId, created.id, {
        message: { text: "changed" },
      }),
    ).rejects.toBeInstanceOf(ProjectQueueValidationError);
    await expect(
      service.deleteItem(projectId, created.id),
    ).rejects.toBeInstanceOf(ProjectQueueValidationError);
    await expect(
      service.retryItem(projectId, created.id),
    ).rejects.toBeInstanceOf(ProjectQueueValidationError);
    await expect(
      service.moveItemToTop(projectId, created.id),
    ).rejects.toBeInstanceOf(ProjectQueueValidationError);

    await service.releaseDispatchingItem(projectId, created.id);
    expect(service.listProject(projectId).items[0]?.status).toBe("queued");
  });

  it("returns transient startup failures to the head and pauses the third", async () => {
    const service = await createService();
    const first = await service.createItem({
      creationProvenance: { surface: "api" },
      projectId,
      projectPath: "/tmp/project-queue",
      request: {
        target: { type: "new-session", provider: "codex" },
        message: { text: "ordinary first item" },
      },
    });
    const retrying = await service.createItem({
      creationProvenance: { surface: "api" },
      projectId,
      projectPath: "/tmp/project-queue",
      request: {
        target: { type: "new-session", provider: "codex" },
        message: { text: "provider startup keeps failing" },
      },
    });

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await service.claimDispatchableItem(projectId, retrying.id);
      const updated = await service.recordRetryableStartupFailure(
        projectId,
        retrying.id,
        `startup failure ${attempt}`,
      );

      expect(
        service.listProject(projectId).items.map((item) => item.id),
      ).toEqual([retrying.id, first.id]);
      expect(updated).toMatchObject({
        status: attempt === 3 ? "failed" : "queued",
        lastError: `startup failure ${attempt}`,
      });
    }

    expect(service.hasDispatchableItem(projectId)).toBe(false);
    const persisted = JSON.parse(
      await fs.readFile(service.getFilePath(), "utf-8"),
    ) as { items: Array<{ id: string; startupFailureCount?: number }> };
    expect(
      persisted.items.find((item) => item.id === retrying.id)
        ?.startupFailureCount,
    ).toBe(3);

    await service.retryItem(projectId, retrying.id);
    expect(service.listProject(projectId).items[0]).toMatchObject({
      id: retrying.id,
      status: "queued",
      lastError: undefined,
    });
  });
});
