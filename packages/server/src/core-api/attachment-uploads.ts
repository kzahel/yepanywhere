import { createHash, type Hash } from "node:crypto";
import { open, readdir, rm, rmdir } from "node:fs/promises";
import { join } from "node:path";
import type { z } from "zod";
import { getLogger } from "../logging/logger.js";
import { registerIdleSweep } from "../lib/processIdleSweep.js";
import {
  AttachmentStagingService,
  type StagedAttachmentRecord,
} from "../uploads/AttachmentStagingService.js";
import {
  API_ATTACHMENT_TTL_MS,
  MAX_API_ATTACHMENT_BYTES,
  MAX_API_ATTACHMENT_CHUNK_BYTES,
  MAX_CALLER_ATTACHMENT_BYTES,
  type attachmentUploadBody,
  type attachmentUploadProgress,
} from "./attachment-contracts.js";
import type { ApiCreator } from "./command-contracts.js";
import { CoreApiError } from "./errors.js";

const PARTIAL_TTL_MS = 15 * 60 * 1000;
const MAX_STAGED_BYTES = 512 * 1024 * 1024;
const MAX_STAGED_FILES = 512;
const MAX_ACTIVE_UPLOADS = 8;
const MAX_CALLER_STAGED_FILES = 64;
const MAX_CALLER_ACTIVE_UPLOADS = 2;

type UploadBody = z.infer<typeof attachmentUploadBody>;
type Progress = z.infer<typeof attachmentUploadProgress>;
export type ApiAttachment = StagedAttachmentRecord & { sha256: string };

type PartialUpload = {
  id?: string;
  metadata: Omit<UploadBody, "data">;
  hash: Hash;
  offset: number;
  previous?: { offset: number; digest: string };
  expires: number;
};

const hash = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");

function batchPrefix(creator: ApiCreator, projectId: string) {
  const caller = hash(
    JSON.stringify([
      creator.serverId,
      creator.principal.kind,
      creator.principal.kind === "peer"
        ? creator.authentication?.credentialId
        : creator.sessionId,
    ]),
  ).slice(0, 32);
  const destination = hash(
    JSON.stringify([creator.sessionId, projectId]),
  ).slice(0, 32);
  return { caller: `${caller}-`, project: `${caller}-${destination}-` };
}

function unavailable() {
  return new CoreApiError(
    "attachment_not_found",
    "Attachment is unavailable in this caller's target project",
    404,
  );
}

function conflict() {
  return new CoreApiError(
    "request_id_conflict",
    "Upload key already names different attachment metadata or bytes",
    409,
  );
}

function wrongOffset(offset: number) {
  return new CoreApiError(
    "attachment_offset",
    `Expected upload offset ${offset}`,
    409,
  );
}

export class ApiAttachmentUploads {
  private readonly staging: AttachmentStagingService;
  private ready?: Promise<void>;
  private closed = false;
  private unsweep?: () => void;
  // Active uploads are capped at eight and expire after 15 minutes of inactivity.
  private readonly partial = new Map<string, PartialUpload>();
  // Completed IDs and their retry index share the 512-file / 512 MiB cap.
  private readonly completed = new Map<string, ApiAttachment>();
  private readonly completedByBatch = new Map<string, ApiAttachment>();
  // Active writes, duplicate checks and deletions are mutually exclusive per batch.
  private readonly busy = new Set<string>();
  // Settle active storage writes before replacing the controller.
  private readonly writes = new Set<Promise<Progress>>();
  private maintenance?: Promise<void>;

  constructor(
    dataDir: string,
    maxUploadSizeBytes?: number,
    private readonly now: () => number = Date.now,
  ) {
    this.maxUploadBytes = maxUploadSizeBytes
      ? Math.min(maxUploadSizeBytes, MAX_API_ATTACHMENT_BYTES)
      : MAX_API_ATTACHMENT_BYTES;
    this.staging = new AttachmentStagingService({
      dataDir,
      stagingRoot: join(dataDir, "uploads", "v0-staging"),
      maxUploadSizeBytes: this.maxUploadBytes,
      draftTtlMs: API_ATTACHMENT_TTL_MS,
      now,
    });
  }
  private readonly maxUploadBytes: number;

  private remember(file: ApiAttachment) {
    this.completed.set(file.id, file);
    this.completedByBatch.set(file.batchId, file);
  }

  private initialize() {
    this.ready ??= this.staging.initialize().then(async () => {
      for (const record of this.staging.listRecords()) {
        if (record.sha256 && record.owner.type === "draft")
          this.remember({ ...record, sha256: record.sha256 });
      }
      const root = join(this.staging.getStagingRoot(), "drafts");
      const batches = await readdir(root).catch((error) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      });
      for (const batch of batches) {
        // A crash between byte publication and index save leaves no handle.
        if (!this.completedByBatch.has(batch))
          await rm(join(root, batch), { recursive: true, force: true });
      }
      this.updateSweep();
    });
    return this.ready;
  }

  private updateSweep() {
    if (!this.closed && (this.partial.size || this.completed.size)) {
      this.unsweep ??= registerIdleSweep((now) => {
        if (this.maintenance) return;
        this.maintenance = this.expire(now)
          .catch((error) =>
            getLogger().warn({ error }, "v0 attachment cleanup failed"),
          )
          .finally(() => {
            this.maintenance = undefined;
          });
      });
    } else {
      this.unsweep?.();
      this.unsweep = undefined;
    }
  }

  private async discardPartial(batchId: string) {
    const upload = this.partial.get(batchId);
    if (upload?.id) await this.staging.cancelUpload(upload.id);
    this.partial.delete(batchId);
    await this.removeEmptyBatch(batchId);
  }

  private async removeEmptyBatch(batchId: string) {
    await rmdir(join(this.staging.getStagingRoot(), "drafts", batchId)).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT" && error.code !== "ENOTEMPTY") throw error;
      },
    );
  }

  private async expire(now: number) {
    for (const [batch, item] of this.partial) {
      if (item.expires > now || this.busy.has(batch)) continue;
      this.busy.add(batch);
      try {
        await this.discardPartial(batch);
      } finally {
        this.busy.delete(batch);
      }
    }
    for (const [batch, file] of this.completedByBatch) {
      if (this.expiry(file) > now || this.busy.has(batch)) continue;
      this.busy.add(batch);
      try {
        await this.staging.deleteDraftAttachment(batch, file.id);
        this.completedByBatch.delete(batch);
        this.completed.delete(file.id);
        await this.removeEmptyBatch(batch);
      } finally {
        this.busy.delete(batch);
      }
    }
    this.updateSweep();
  }

  private expiry(file: ApiAttachment) {
    return Date.parse(file.createdAt) + API_ATTACHMENT_TTL_MS;
  }

  async resolve(creator: ApiCreator, projectId: string, ids: string[]) {
    await this.initialize();
    const { project: prefix } = batchPrefix(creator, projectId);
    return ids.map((id) => {
      const file = this.completed.get(id);
      if (
        !file ||
        this.expiry(file) <= this.now() ||
        !file.batchId.startsWith(prefix)
      )
        throw unavailable();
      return file;
    });
  }

  upload(
    creator: ApiCreator,
    projectId: string,
    key: string,
    offset: number,
    chunk: UploadBody,
    authorize: () => void,
    signal?: AbortSignal,
  ): Promise<Progress> {
    if (this.writes.size >= 32)
      throw new CoreApiError(
        "command_capacity",
        "Attachment request capacity reached",
        503,
      );
    const assertActive = () => {
      if (this.closed)
        throw new CoreApiError(
          "controller_unavailable",
          "Attachment owner is closed",
          503,
        );
      authorize();
    };
    assertActive();
    const write = this.write(
      creator,
      projectId,
      key,
      offset,
      chunk,
      assertActive,
      signal,
    );
    this.writes.add(write);
    return write.finally(() => this.writes.delete(write));
  }

  private async write(
    creator: ApiCreator,
    projectId: string,
    key: string,
    offset: number,
    { data, ...metadata }: UploadBody,
    authorize: () => void,
    signal?: AbortSignal,
  ): Promise<Progress> {
    const bytes = Buffer.from(data, "base64");
    if (
      bytes.toString("base64") !== data ||
      bytes.length > MAX_API_ATTACHMENT_CHUNK_BYTES ||
      metadata.size > this.maxUploadBytes ||
      offset + bytes.length > metadata.size ||
      (!bytes.length && metadata.size !== 0)
    )
      throw new CoreApiError(
        "invalid_request",
        "Invalid attachment size or chunk encoding",
        400,
      );
    await this.initialize();
    signal?.throwIfAborted();
    authorize();
    const prefix = batchPrefix(creator, projectId);
    const batch = `${prefix.project}${hash(key).slice(0, 32)}`;
    if (this.busy.has(batch))
      throw new CoreApiError(
        "attachment_busy",
        "Retry this chunk after the current request settles",
        409,
      );
    this.busy.add(batch);
    try {
      const complete = this.completedByBatch.get(batch);
      if (complete) {
        if (this.expiry(complete) <= this.now()) throw unavailable();
        if (
          complete.originalName !== metadata.name ||
          complete.mimeType !== metadata.mimeType ||
          complete.size !== metadata.size ||
          complete.sha256 !== metadata.sha256
        )
          throw conflict();
        const file = await open(complete.path, "r");
        try {
          const saved = Buffer.alloc(bytes.length);
          const { bytesRead } = await file.read(saved, 0, saved.length, offset);
          if (bytesRead !== bytes.length || !saved.equals(bytes))
            throw conflict();
        } finally {
          await file.close();
        }
        authorize();
        return this.completeProgress(complete);
      }
      let upload = this.partial.get(batch);
      if (upload && upload.expires <= this.now()) {
        await this.discardPartial(batch);
        upload = undefined;
      }
      if (!upload) {
        if (offset !== 0) throw wrongOffset(0);
        upload = this.reserve(batch, prefix.caller, metadata);
      }
      const previous = upload.previous;
      const digest = hash(bytes);
      if (JSON.stringify(upload.metadata) !== JSON.stringify(metadata))
        throw conflict();
      if (previous?.offset === offset) {
        if (previous.digest !== digest) throw conflict();
        return this.partialProgress(upload);
      }
      if (offset !== upload.offset) throw wrongOffset(upload.offset);
      try {
        signal?.throwIfAborted();
        authorize();
        upload.id ??= (
          await this.staging.startDraftUpload({
            batchId: batch,
            originalName: metadata.name,
            mimeType: metadata.mimeType,
            size: metadata.size,
          })
        ).uploadId;
        if (bytes.length) await this.staging.writeChunk(upload.id, bytes);
        authorize();
        upload.hash.update(bytes);
        upload.offset += bytes.length;
        upload.previous = { offset, digest };
        upload.expires = this.now() + PARTIAL_TTL_MS;
        if (upload.offset < metadata.size) return this.partialProgress(upload);
        if (upload.hash.digest("hex") !== metadata.sha256)
          throw new CoreApiError(
            "invalid_request",
            "Attachment checksum does not match its bytes",
            400,
          );
        const ref = await this.staging.completeUpload(
          upload.id,
          metadata.sha256,
        );
        try {
          authorize();
        } catch (error) {
          await this.staging.deleteDraftAttachment(batch, ref.id);
          throw error;
        }
        const file = this.staging.getRecord(ref.id)!;
        const completed = { ...file, sha256: metadata.sha256 };
        this.remember(completed);
        this.partial.delete(batch);
        return this.completeProgress(completed);
      } catch (error) {
        await this.discardPartial(batch);
        throw error;
      }
    } finally {
      this.busy.delete(batch);
      this.updateSweep();
    }
  }

  private reserve(
    batch: string,
    caller: string,
    metadata: PartialUpload["metadata"],
  ) {
    const pending = [...this.partial.entries()];
    const completed = [...this.completedByBatch.entries()];
    let totalBytes = metadata.size;
    let callerBytes = metadata.size;
    let callerCount = 1;
    let callerActive = 0;
    for (const [key, upload] of pending) {
      totalBytes += upload.metadata.size;
      if (key.startsWith(caller)) {
        callerBytes += upload.metadata.size;
        callerCount++;
        callerActive++;
      }
    }
    for (const [key, upload] of completed) {
      totalBytes += upload.size;
      if (key.startsWith(caller)) {
        callerBytes += upload.size;
        callerCount++;
      }
    }
    if (
      pending.length >= MAX_ACTIVE_UPLOADS ||
      pending.length + completed.length >= MAX_STAGED_FILES ||
      totalBytes > MAX_STAGED_BYTES ||
      callerActive >= MAX_CALLER_ACTIVE_UPLOADS ||
      callerCount > MAX_CALLER_STAGED_FILES ||
      callerBytes > MAX_CALLER_ATTACHMENT_BYTES
    )
      throw new CoreApiError(
        "command_capacity",
        "Attachment staging capacity reached",
        503,
      );
    const upload = {
      metadata,
      hash: createHash("sha256"),
      offset: 0,
      expires: this.now() + PARTIAL_TTL_MS,
    };
    this.partial.set(batch, upload);
    return upload;
  }

  private partialProgress(upload: PartialUpload): Progress {
    return {
      attachmentId: null,
      nextOffset: upload.offset,
      expiresAt: new Date(upload.expires).toISOString(),
    };
  }

  private completeProgress(file: ApiAttachment): Progress {
    return {
      attachmentId: file.id,
      nextOffset: file.size,
      expiresAt: new Date(this.expiry(file)).toISOString(),
    };
  }

  close() {
    this.closed = true;
    this.updateSweep();
  }

  async idle() {
    await Promise.allSettled(this.writes);
    await this.maintenance;
    for (const batch of this.partial.keys()) {
      await this.discardPartial(batch);
    }
  }
}
