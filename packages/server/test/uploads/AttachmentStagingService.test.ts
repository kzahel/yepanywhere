import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AttachmentStagingService } from "../../src/uploads/index.js";
import { ProjectStoragePolicy } from "../../src/projects/projectStoragePolicy.js";

function projectModeService(stagingRoot: string): AttachmentStagingService {
  return new AttachmentStagingService({
    stagingRoot,
    storagePolicy: new ProjectStoragePolicy({
      dataDir: join(stagingRoot, "app-data"),
      getMode: () => "project",
    }),
  });
}

async function completeDraftUpload(
  service: AttachmentStagingService,
  content: Buffer,
  options: {
    batchId?: string;
    originalName?: string;
    mimeType?: string;
    declaredSize?: number;
  } = {},
) {
  const started = await service.startDraftUpload({
    batchId: options.batchId,
    originalName: options.originalName ?? "screenshot.png",
    size: options.declaredSize ?? content.length,
    mimeType: options.mimeType ?? "image/png",
  });
  if (content.length > 0) {
    await service.writeChunk(started.uploadId, content);
  }
  const ref = await service.completeUpload(started.uploadId);
  return { ...started, ref };
}

describe("AttachmentStagingService", () => {
  let stagingRoot: string;

  beforeEach(async () => {
    stagingRoot = join(tmpdir(), `attachment-staging-${randomUUID()}`);
  });

  afterEach(async () => {
    await rm(stagingRoot, { recursive: true, force: true }).catch(() => {});
  });

  it("completes draft uploads as path-free staged refs", async () => {
    const service = new AttachmentStagingService({ stagingRoot });
    const { batchId, ref } = await completeDraftUpload(
      service,
      Buffer.from("image bytes"),
    );

    expect(ref.batchId).toBe(batchId);
    expect(ref.originalName).toBe("screenshot.png");
    expect(ref.name).toContain("screenshot.png");
    expect(ref.size).toBe("image bytes".length);
    expect("path" in ref).toBe(false);

    const stored = service.getRecord(ref.id);
    expect(stored?.path).toContain(stagingRoot);
    expect(await readFile(stored?.path ?? "", "utf-8")).toBe("image bytes");
  });

  it("keeps synced originals through removal and multi-batch queue transfer", async () => {
    const service = new AttachmentStagingService({ stagingRoot });
    const a = await completeDraftUpload(service, Buffer.from("first"));
    const b = await completeDraftUpload(service, Buffer.from("second"));
    const protectedIds = new Set([a.ref.id, b.ref.id]);
    service.setDraftProtection((_owner, id) => protectedIds.has(id));
    expect(await service.deleteDraftAttachment(a.batchId, a.ref.id)).toBe(
      false,
    );
    expect(await service.deleteAttachment(b.ref.id)).toBe(false);
    const transfer = await service.prepareDraftAttachmentsForQueue({
      batchId: a.batchId,
      queueItemId: "shared-queue",
      refs: [a.ref, b.ref],
    });
    expect(transfer.refs).toHaveLength(2);
    expect(transfer.refs.every((ref) => !protectedIds.has(ref.id))).toBe(true);
    expect(await service.validateDraftRefs(a.batchId, [a.ref])).toEqual([
      a.ref,
    ]);
    expect(await service.validateDraftRefs(b.batchId, [b.ref])).toEqual([
      b.ref,
    ]);
    await transfer.rollback();
    expect(await service.validateDraftRefs(a.batchId, [a.ref])).toEqual([
      a.ref,
    ]);
    protectedIds.clear();
    expect(await service.deleteAttachment(a.ref.id)).toBe(true);
  });

  it("rejects unsafe draft batch ids", async () => {
    const service = new AttachmentStagingService({ stagingRoot });

    await expect(
      service.startDraftUpload({
        batchId: "../escape",
        originalName: "file.txt",
        size: 1,
        mimeType: "text/plain",
      }),
    ).rejects.toThrow("Invalid staging batch id");
  });

  it("keeps not-yet-published sync drafts valid after queue ownership and cancellation", async () => {
    const service = new AttachmentStagingService({ stagingRoot });
    service.setDraftProtection(() => false);
    const { batchId, ref } = await completeDraftUpload(
      service,
      Buffer.from("pending draft publication"),
    );
    const queued = await service.transferDraftAttachmentsToQueue({
      batchId,
      queueItemId: "fast-enqueue",
      refs: [ref],
    });
    expect(queued[0]?.id).not.toBe(ref.id);
    // The delayed draft write still presents the original reference.
    expect(await service.validateDraftRefs(batchId, [ref])).toEqual([ref]);
    const queueRecord = service.getRecord(queued[0]!.id);
    expect(await readFile(queueRecord!.path, "utf8")).toBe(
      "pending draft publication",
    );
    await service.deleteQueueAttachments("fast-enqueue");
    const reopened = new AttachmentStagingService({ stagingRoot });
    expect(await reopened.validateDraftRefs(batchId, [ref])).toEqual([ref]);
    expect(await readFile(reopened.getRecord(ref.id)!.path, "utf8")).toBe(
      "pending draft publication",
    );
  });

  it("isolates account drafts across validation, deletion, materialization and restart", async () => {
    const service = new AttachmentStagingService({ stagingRoot });
    const archer = service.forUser("archer");
    const other = service.forUser("other");
    const { batchId, ref } = await completeDraftUpload(
      archer,
      Buffer.from("private image"),
    );
    await expect(other.validateDraftRefs(batchId, [ref])).rejects.toThrow();
    await expect(service.validateDraftRefs(batchId, [ref])).rejects.toThrow();
    expect(await other.deleteDraftAttachment(batchId, ref.id)).toBe(false);
    const reopened = new AttachmentStagingService({ stagingRoot }).forUser(
      "archer",
    );
    expect(await reopened.validateDraftRefs(batchId, [ref])).toEqual([ref]);
    const projectPath = join(stagingRoot, "project");
    await mkdir(projectPath, { recursive: true });
    await expect(
      other.materializeDraftAttachmentsForSession({
        batchId,
        refs: [ref],
        projectPath,
        sessionId: "session",
      }),
    ).rejects.toThrow();
    const files = await reopened.materializeDraftAttachmentsForSession({
      batchId,
      refs: [ref],
      projectPath,
      sessionId: "session",
    });
    expect(await readFile(files[0]!.path, "utf8")).toBe("private image");
  });

  it("enforces max upload size before writing", async () => {
    const service = new AttachmentStagingService({
      stagingRoot,
      maxUploadSizeBytes: 4,
    });

    await expect(
      service.startDraftUpload({
        originalName: "file.txt",
        size: 5,
        mimeType: "text/plain",
      }),
    ).rejects.toThrow("File size exceeds maximum allowed size");
  });

  it("fails exact-size mismatches and removes partial files", async () => {
    const service = new AttachmentStagingService({ stagingRoot });
    const started = await service.startDraftUpload({
      originalName: "file.txt",
      size: 100,
      mimeType: "text/plain",
    });
    await service.writeChunk(started.uploadId, Buffer.from("short"));

    await expect(service.completeUpload(started.uploadId)).rejects.toThrow(
      "Upload size mismatch",
    );
    expect(service.getRecord(started.uploadId)).toBeNull();
    await expect(stat(stagingRoot)).resolves.toBeTruthy();
    const refs = await service.listDraftAttachments(started.batchId);
    expect(refs).toEqual([]);
  });

  it("cancels uploads and deletes partial files", async () => {
    const service = new AttachmentStagingService({ stagingRoot });
    const started = await service.startDraftUpload({
      originalName: "file.txt",
      size: 5,
      mimeType: "text/plain",
    });
    await service.writeChunk(started.uploadId, Buffer.from("hello"));

    await service.cancelUpload(started.uploadId);

    expect(service.getRecord(started.uploadId)).toBeNull();
    await expect(service.completeUpload(started.uploadId)).rejects.toThrow(
      "Staged upload not found",
    );
  });

  it("loads completed staged records after service restart", async () => {
    const service = new AttachmentStagingService({ stagingRoot });
    const { batchId, ref } = await completeDraftUpload(
      service,
      Buffer.from("persisted"),
    );

    const reloaded = new AttachmentStagingService({ stagingRoot });
    const refs = await reloaded.listDraftAttachments(batchId);

    expect(refs).toEqual([ref]);
  });

  it("validates refs against ownership and on-disk files", async () => {
    const service = new AttachmentStagingService({ stagingRoot });
    const { batchId, ref } = await completeDraftUpload(
      service,
      Buffer.from("valid"),
    );

    await expect(service.validateDraftRefs(batchId, [ref])).resolves.toEqual([
      ref,
    ]);
    await expect(
      service.validateDraftRefs("other-batch", [ref]),
    ).rejects.toThrow("Staged attachment not found");

    const record = service.getRecord(ref.id);
    await rm(record?.path ?? "", { force: true });
    await expect(service.validateDraftRefs(batchId, [ref])).rejects.toThrow(
      "Staged attachment is missing or invalid",
    );
  });

  it("deletes individual staged attachments", async () => {
    const service = new AttachmentStagingService({ stagingRoot });
    const { batchId, ref } = await completeDraftUpload(
      service,
      Buffer.from("delete me"),
    );
    const record = service.getRecord(ref.id);

    await expect(service.deleteAttachment(ref.id)).resolves.toBe(true);

    await expect(stat(record?.path ?? "")).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(service.listDraftAttachments(batchId)).resolves.toEqual([]);
  });

  it("deletes only draft-owned staged attachments by draft batch", async () => {
    const service = new AttachmentStagingService({ stagingRoot });
    const { batchId, ref } = await completeDraftUpload(
      service,
      Buffer.from("delete draft"),
    );
    await service.transferDraftAttachmentsToQueue({
      batchId,
      queueItemId: "queue-item-a",
      refs: [ref],
    });

    await expect(service.deleteDraftAttachment(batchId, ref.id)).resolves.toBe(
      false,
    );
    await expect(service.listQueueAttachments("queue-item-a")).resolves.toEqual(
      [expect.objectContaining({ id: ref.id })],
    );
  });

  it("transfers draft attachments to queue ownership", async () => {
    const service = new AttachmentStagingService({ stagingRoot });
    const { batchId, ref } = await completeDraftUpload(
      service,
      Buffer.from("queue me"),
    );

    const queueRefs = await service.transferDraftAttachmentsToQueue({
      batchId,
      queueItemId: "queue-item-a",
      refs: [ref],
    });

    expect(queueRefs).toEqual([{ ...ref, updatedAt: queueRefs[0]?.updatedAt }]);
    await expect(service.listDraftAttachments(batchId)).resolves.toEqual([]);
    await expect(service.listQueueAttachments("queue-item-a")).resolves.toEqual(
      queueRefs,
    );
    const record = service.getRecord(ref.id);
    expect(record?.owner).toEqual({
      type: "project-queue",
      queueItemId: "queue-item-a",
    });
    expect(record?.path).toContain(join("queue", "queue-item-a"));
  });

  it("materializes draft attachments into final session attachments", async () => {
    const service = projectModeService(stagingRoot);
    const { batchId, ref } = await completeDraftUpload(
      service,
      Buffer.from("session attachment"),
    );
    const projectPath = join(stagingRoot, "project");
    await mkdir(projectPath, { recursive: true });

    const files = await service.materializeDraftAttachmentsForSession({
      batchId,
      refs: [ref],
      projectPath,
      sessionId: "session-a",
    });

    expect(files).toEqual([
      {
        id: ref.id,
        originalName: ref.originalName,
        name: ref.name,
        path: join(projectPath, ".yep", "attachments", "session-a", ref.name),
        size: ref.size,
        mimeType: ref.mimeType,
      },
    ]);
    await expect(readFile(files[0]?.path ?? "", "utf-8")).resolves.toBe(
      "session attachment",
    );
    await expect(service.listDraftAttachments(batchId)).resolves.toEqual([ref]);

    await expect(
      service.materializeDraftAttachmentsForSession({
        batchId,
        refs: [ref],
        projectPath,
        sessionId: "session-a",
      }),
    ).resolves.toEqual(files);
  });

  it("fails materialization when the staged file is missing", async () => {
    const service = new AttachmentStagingService({ stagingRoot });
    const { batchId, ref } = await completeDraftUpload(
      service,
      Buffer.from("gone"),
    );
    const record = service.getRecord(ref.id);
    await rm(record?.path ?? "", { force: true });

    await expect(
      service.materializeDraftAttachmentsForSession({
        batchId,
        refs: [ref],
        projectPath: join(stagingRoot, "project"),
        sessionId: "session-a",
      }),
    ).rejects.toThrow("Staged attachment is missing or invalid");
  });

  it("fails materialization when a final attachment has the wrong size", async () => {
    const service = projectModeService(stagingRoot);
    const { batchId, ref } = await completeDraftUpload(
      service,
      Buffer.from("expected"),
    );
    const projectPath = join(stagingRoot, "project");
    const finalDir = join(projectPath, ".yep", "attachments", "session-a");
    await mkdir(finalDir, { recursive: true });
    await writeFile(join(finalDir, ref.name), "wrong size");

    await expect(
      service.materializeDraftAttachmentsForSession({
        batchId,
        refs: [ref],
        projectPath,
        sessionId: "session-a",
      }),
    ).rejects.toThrow("Final attachment path has unexpected size");
  });

  it("deletes queue-owned attachments by queue item", async () => {
    const service = new AttachmentStagingService({ stagingRoot });
    const { batchId, ref } = await completeDraftUpload(
      service,
      Buffer.from("queued"),
    );
    await service.transferDraftAttachmentsToQueue({
      batchId,
      queueItemId: "queue-item-a",
      refs: [ref],
    });

    await expect(service.deleteQueueAttachments("queue-item-a")).resolves.toBe(
      1,
    );
    await expect(service.listQueueAttachments("queue-item-a")).resolves.toEqual(
      [],
    );
  });

  it("materializes queue-owned attachments for a session", async () => {
    const service = projectModeService(stagingRoot);
    const { batchId, ref } = await completeDraftUpload(
      service,
      Buffer.from("queued session attachment"),
    );
    const queueRefs = await service.transferDraftAttachmentsToQueue({
      batchId,
      queueItemId: "queue-item-a",
      refs: [ref],
    });
    const projectPath = join(stagingRoot, "project");
    await mkdir(projectPath, { recursive: true });

    const files = await service.materializeQueueAttachmentsForSession({
      queueItemId: "queue-item-a",
      refs: queueRefs,
      projectPath,
      sessionId: "session-a",
    });

    expect(files).toEqual([
      {
        id: ref.id,
        originalName: ref.originalName,
        name: ref.name,
        path: join(projectPath, ".yep", "attachments", "session-a", ref.name),
        size: ref.size,
        mimeType: ref.mimeType,
      },
    ]);
    await expect(readFile(files[0]?.path ?? "", "utf-8")).resolves.toBe(
      "queued session attachment",
    );
    await expect(service.listQueueAttachments("queue-item-a")).resolves.toEqual(
      queueRefs,
    );
  });

  it("cleans stale draft-owned records but keeps queue-owned records", async () => {
    let now = Date.parse("2026-06-28T00:00:00.000Z");
    const service = new AttachmentStagingService({
      stagingRoot,
      draftTtlMs: 1000,
      now: () => now,
    });
    const stale = await completeDraftUpload(service, Buffer.from("stale"));
    const queued = await completeDraftUpload(service, Buffer.from("queued"));
    await service.transferDraftAttachmentsToQueue({
      batchId: queued.batchId,
      queueItemId: "queue-item-a",
      refs: [queued.ref],
    });

    now += 1001;
    const reloaded = new AttachmentStagingService({
      stagingRoot,
      draftTtlMs: 1000,
      now: () => now,
    });

    await expect(reloaded.listDraftAttachments(stale.batchId)).resolves.toEqual(
      [],
    );
    await expect(
      reloaded.listQueueAttachments("queue-item-a"),
    ).resolves.toEqual([expect.objectContaining({ id: queued.ref.id })]);
  });

  it("removes missing index records on startup", async () => {
    const service = new AttachmentStagingService({ stagingRoot });
    const { batchId, ref } = await completeDraftUpload(
      service,
      Buffer.from("gone"),
    );
    const record = service.getRecord(ref.id);
    await rm(record?.path ?? "", { force: true });

    const reloaded = new AttachmentStagingService({ stagingRoot });

    await expect(reloaded.listDraftAttachments(batchId)).resolves.toEqual([]);
  });

  it("removes partial files on startup", async () => {
    const partialDir = join(stagingRoot, "drafts", "batch-a");
    await mkdir(partialDir, { recursive: true });
    const partialPath = join(partialDir, "file.txt.partial");
    await writeFile(partialPath, "partial");

    const service = new AttachmentStagingService({ stagingRoot });
    await service.initialize();

    await expect(stat(partialPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
