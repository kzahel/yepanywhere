import { randomUUID } from "node:crypto";
import { type WriteStream, createWriteStream } from "node:fs";
import {
  copyFile,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { StagedAttachmentRef, UploadedFile } from "@yep-anywhere/shared";
import { getDataDir } from "../config.js";
import { ProjectStoragePolicy } from "../projects/projectStoragePolicy.js";
import {
  getProjectAttachmentUploadDir,
  isSafeUploadPathSegment,
  sanitizeFilename,
} from "./manager.js";

export const DEFAULT_DRAFT_STAGING_TTL_MS = 7 * 24 * 60 * 60 * 1000;

interface StagingIndexFile {
  version: 1;
  records: StagedAttachmentRecord[];
}

export type StagedAttachmentOwner =
  | { type: "draft"; batchId: string }
  | { type: "project-queue"; queueItemId: string };

export interface StagedAttachmentRecord extends StagedAttachmentRef {
  owner: StagedAttachmentOwner;
  path: string;
}

interface ActiveStagedUpload {
  uploadId: string;
  batchId: string;
  originalName: string;
  name: string;
  finalPath: string;
  tempPath: string;
  expectedSize: number;
  bytesReceived: number;
  mimeType: string;
  width?: number;
  height?: number;
  writeStream: WriteStream | null;
  writeError: Error | null;
}

export interface AttachmentStagingServiceOptions {
  /** Server data dir. Defaults to YA's data dir. */
  dataDir?: string;
  /** Override full staging root, primarily for tests. */
  stagingRoot?: string;
  /** Maximum upload file size in bytes. 0 = unlimited. */
  maxUploadSizeBytes?: number;
  /** Draft-owned staging TTL in milliseconds. */
  draftTtlMs?: number;
  /** Clock hook for tests. */
  now?: () => number;
  storagePolicy?: ProjectStoragePolicy;
}

export interface StartDraftStagedUploadParams {
  batchId?: string;
  originalName: string;
  size: number;
  mimeType: string;
  width?: number;
  height?: number;
}

export interface StartedDraftStagedUpload {
  uploadId: string;
  batchId: string;
}

export interface PreparedQueueAttachmentTransfer {
  refs: StagedAttachmentRef[];
  commit: () => void;
  rollback: () => Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function optionalFiniteDimension(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const normalized = Math.floor(value);
  return normalized > 0 ? normalized : undefined;
}

function normalizeMimeType(value: string): string {
  const trimmed = value.trim();
  return trimmed || "application/octet-stream";
}

function isSafeContainedPath(root: string, candidate: string): boolean {
  const relativePath = relative(root, resolve(candidate));
  return (
    relativePath !== "" &&
    !relativePath.startsWith("..") &&
    !isAbsolute(relativePath)
  );
}

function toRef(record: StagedAttachmentRecord): StagedAttachmentRef {
  return {
    id: record.id,
    batchId: record.batchId,
    originalName: record.originalName,
    name: record.name,
    size: record.size,
    mimeType: record.mimeType,
    ...(record.width !== undefined ? { width: record.width } : {}),
    ...(record.height !== undefined ? { height: record.height } : {}),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function normalizeOwner(value: unknown): StagedAttachmentOwner | null {
  if (!isRecord(value)) return null;
  if (value.type === "draft" && typeof value.batchId === "string") {
    return isSafeUploadPathSegment(value.batchId)
      ? { type: "draft", batchId: value.batchId }
      : null;
  }
  if (value.type === "project-queue" && typeof value.queueItemId === "string") {
    return isSafeUploadPathSegment(value.queueItemId)
      ? { type: "project-queue", queueItemId: value.queueItemId }
      : null;
  }
  return null;
}

function toWriteError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function normalizeRecord(
  value: unknown,
  stagingRoot: string,
): StagedAttachmentRecord | null {
  if (!isRecord(value)) return null;

  const owner = normalizeOwner(value.owner);
  const width = optionalFiniteDimension(value.width);
  const height = optionalFiniteDimension(value.height);

  if (
    !owner ||
    typeof value.id !== "string" ||
    !isSafeUploadPathSegment(value.id) ||
    typeof value.batchId !== "string" ||
    !isSafeUploadPathSegment(value.batchId) ||
    typeof value.originalName !== "string" ||
    typeof value.name !== "string" ||
    !isSafeUploadPathSegment(value.name) ||
    typeof value.path !== "string" ||
    !isSafeContainedPath(stagingRoot, value.path) ||
    typeof value.size !== "number" ||
    !Number.isFinite(value.size) ||
    value.size < 0 ||
    typeof value.mimeType !== "string" ||
    typeof value.createdAt !== "string" ||
    typeof value.updatedAt !== "string"
  ) {
    return null;
  }

  return {
    id: value.id,
    batchId: value.batchId,
    originalName: value.originalName,
    name: value.name,
    path: resolve(value.path),
    size: value.size,
    mimeType: normalizeMimeType(value.mimeType),
    ...(width !== undefined ? { width } : {}),
    ...(height !== undefined ? { height } : {}),
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    owner,
  };
}

export class AttachmentStagingService {
  private readonly stagingRoot: string;
  private readonly indexPath: string;
  private readonly maxUploadSizeBytes: number;
  private readonly draftTtlMs: number;
  private readonly now: () => number;
  private readonly storagePolicy: ProjectStoragePolicy;
  private readonly activeUploads = new Map<string, ActiveStagedUpload>();
  private readonly records = new Map<string, StagedAttachmentRecord>();
  private initialized = false;
  private mutationQueue: Promise<void> = Promise.resolve();
  private draftProtection?: (username: string | null, id: string) => boolean;
  private draftUsername: string | null = null;
  setDraftProtection(
    check: (username: string | null, id: string) => boolean,
  ): void {
    this.draftProtection = check;
    for (const store of this.userStores.values())
      store.setDraftProtection(check);
  }
  private protectedDraft(id: string): boolean {
    return this.draftProtection?.(this.draftUsername, id) ?? false;
  }
  private readonly userStores = new Map<string, AttachmentStagingService>();

  /** Drafts belong to the acting account before they belong to a project. */
  forUser(username: string | null): AttachmentStagingService {
    if (username === null) return this;
    let store = this.userStores.get(username);
    if (!store) {
      store = new AttachmentStagingService({
        stagingRoot: join(
          this.stagingRoot,
          "users",
          Buffer.from(username).toString("hex"),
        ),
        storagePolicy: this.storagePolicy,
        maxUploadSizeBytes: this.maxUploadSizeBytes,
        draftTtlMs: this.draftTtlMs,
        now: this.now,
      });
      store.draftUsername = username;
      if (this.draftProtection) store.setDraftProtection(this.draftProtection);
      this.userStores.set(username, store);
    }
    return store;
  }

  constructor(options: AttachmentStagingServiceOptions = {}) {
    const dataDir =
      options.dataDir ??
      (options.stagingRoot
        ? join(resolve(options.stagingRoot), "app-data")
        : getDataDir());
    this.stagingRoot = resolve(
      options.stagingRoot ?? join(dataDir, "uploads", "staging"),
    );
    this.indexPath = join(this.stagingRoot, "staging-index.json");
    this.maxUploadSizeBytes = options.maxUploadSizeBytes ?? 0;
    this.draftTtlMs = options.draftTtlMs ?? DEFAULT_DRAFT_STAGING_TTL_MS;
    this.now = options.now ?? Date.now;
    this.storagePolicy =
      options.storagePolicy ??
      new ProjectStoragePolicy({
        dataDir,
        getMode: () => "app-data",
      });
  }

  createBatchId(): string {
    return randomUUID();
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    await mkdir(this.stagingRoot, { recursive: true });
    await this.loadIndex();
    this.initialized = true;
    await this.removePartialFiles();
    await this.pruneInvalidRecords();
    await this.cleanupStaleDraftAttachments();
  }

  async startDraftUpload(
    params: StartDraftStagedUploadParams,
  ): Promise<StartedDraftStagedUpload> {
    await this.ensureInitialized();

    const batchId = params.batchId ?? this.createBatchId();
    if (!isSafeUploadPathSegment(batchId)) {
      throw new Error("Invalid staging batch id");
    }
    if (
      !Number.isFinite(params.size) ||
      params.size < 0 ||
      !Number.isInteger(params.size)
    ) {
      throw new Error("Invalid upload size");
    }
    if (this.maxUploadSizeBytes > 0 && params.size > this.maxUploadSizeBytes) {
      const maxMB = Math.round(this.maxUploadSizeBytes / (1024 * 1024));
      throw new Error(`File size exceeds maximum allowed size of ${maxMB}MB`);
    }

    const { id, sanitized } = sanitizeFilename(params.originalName);
    const uploadDir = this.ownerDir({ type: "draft", batchId });
    await mkdir(uploadDir, { recursive: true });

    const finalPath = join(uploadDir, sanitized);
    const tempPath = join(uploadDir, `${sanitized}.partial`);
    const width = optionalFiniteDimension(params.width);
    const height = optionalFiniteDimension(params.height);
    this.activeUploads.set(id, {
      uploadId: id,
      batchId,
      originalName: params.originalName,
      name: sanitized,
      finalPath,
      tempPath,
      expectedSize: params.size,
      bytesReceived: 0,
      mimeType: normalizeMimeType(params.mimeType),
      ...(width !== undefined ? { width } : {}),
      ...(height !== undefined ? { height } : {}),
      writeStream: null,
      writeError: null,
    });

    return { uploadId: id, batchId };
  }

  async writeChunk(uploadId: string, chunk: Buffer): Promise<number> {
    await this.ensureInitialized();
    const state = this.activeUploads.get(uploadId);
    if (!state) {
      throw new Error(`Staged upload not found: ${uploadId}`);
    }

    if (this.maxUploadSizeBytes > 0) {
      const newTotal = state.bytesReceived + chunk.length;
      if (newTotal > this.maxUploadSizeBytes) {
        const maxMB = Math.round(this.maxUploadSizeBytes / (1024 * 1024));
        throw new Error(`Upload exceeds maximum allowed size of ${maxMB}MB`);
      }
    }

    const writeStream = this.ensureWriteStream(state);

    return new Promise((resolvePromise, reject) => {
      let settled = false;
      const rejectOnce = (error: unknown) => {
        if (settled) return;
        settled = true;
        writeStream.off("error", rejectOnce);
        const normalized = toWriteError(error);
        state.writeError = normalized;
        reject(normalized);
      };
      writeStream.once("error", rejectOnce);
      writeStream.write(chunk, (error) => {
        if (error) {
          rejectOnce(error);
          return;
        }
        if (state.writeError) {
          rejectOnce(state.writeError);
          return;
        }
        if (settled) return;
        settled = true;
        writeStream.off("error", rejectOnce);
        state.bytesReceived += chunk.length;
        resolvePromise(state.bytesReceived);
      });
    });
  }

  async completeUpload(uploadId: string): Promise<StagedAttachmentRef> {
    await this.ensureInitialized();
    const state = this.activeUploads.get(uploadId);
    if (!state) {
      throw new Error(`Staged upload not found: ${uploadId}`);
    }

    let movedToFinal = false;
    let completedRecord: StagedAttachmentRecord | null = null;

    try {
      if (state.writeStream) {
        await new Promise<void>((resolvePromise, reject) => {
          const writeStream = state.writeStream;
          if (!writeStream) {
            resolvePromise();
            return;
          }
          if (state.writeError) {
            reject(state.writeError);
            return;
          }
          let settled = false;
          const rejectOnce = (error: unknown) => {
            if (settled) return;
            settled = true;
            writeStream.off("error", rejectOnce);
            const normalized = toWriteError(error);
            state.writeError = normalized;
            reject(normalized);
          };
          writeStream.once("error", rejectOnce);
          writeStream.end((error: Error | null | undefined) => {
            if (error) {
              rejectOnce(error);
              return;
            }
            if (state.writeError) {
              rejectOnce(state.writeError);
              return;
            }
            if (settled) return;
            settled = true;
            writeStream.off("error", rejectOnce);
            resolvePromise();
          });
        });
      } else {
        await writeFile(state.tempPath, Buffer.alloc(0));
      }

      const stats = await stat(state.tempPath);
      if (
        state.bytesReceived !== state.expectedSize ||
        stats.size !== state.expectedSize
      ) {
        throw new Error(
          `Upload size mismatch: expected ${state.expectedSize} bytes, received ${stats.size} bytes`,
        );
      }

      await rename(state.tempPath, state.finalPath);
      movedToFinal = true;
      const now = new Date(this.now()).toISOString();
      completedRecord = {
        id: state.uploadId,
        batchId: state.batchId,
        originalName: state.originalName,
        name: state.name,
        path: state.finalPath,
        size: stats.size,
        mimeType: state.mimeType,
        ...(state.width !== undefined ? { width: state.width } : {}),
        ...(state.height !== undefined ? { height: state.height } : {}),
        createdAt: now,
        updatedAt: now,
        owner: { type: "draft", batchId: state.batchId },
      };

      await this.withMutation(async () => {
        if (!completedRecord) return;
        this.records.set(completedRecord.id, completedRecord);
        try {
          await this.saveIndex();
        } catch (error) {
          this.records.delete(completedRecord.id);
          throw error;
        }
      });

      this.activeUploads.delete(uploadId);
      return toRef(completedRecord);
    } catch (error) {
      state.writeStream?.destroy();
      await rm(state.tempPath, { force: true }).catch(() => {});
      if (movedToFinal) {
        await rm(state.finalPath, { force: true }).catch(() => {});
      }
      if (completedRecord) {
        this.records.delete(completedRecord.id);
      }
      this.activeUploads.delete(uploadId);
      throw error;
    }
  }

  private ensureWriteStream(state: ActiveStagedUpload): WriteStream {
    if (state.writeError) {
      throw state.writeError;
    }
    if (state.writeStream) {
      return state.writeStream;
    }

    const writeStream = createWriteStream(state.tempPath);
    writeStream.on("error", (error) => {
      state.writeError = toWriteError(error);
    });
    state.writeStream = writeStream;
    return writeStream;
  }

  async cancelUpload(uploadId: string): Promise<void> {
    await this.ensureInitialized();
    const state = this.activeUploads.get(uploadId);
    if (!state) return;
    state.writeStream?.destroy();
    await rm(state.tempPath, { force: true }).catch(() => {});
    this.activeUploads.delete(uploadId);
  }

  async listDraftAttachments(batchId: string): Promise<StagedAttachmentRef[]> {
    await this.ensureInitialized();
    if (!isSafeUploadPathSegment(batchId)) {
      throw new Error("Invalid staging batch id");
    }
    return [...this.records.values()]
      .filter(
        (record) =>
          record.owner.type === "draft" && record.owner.batchId === batchId,
      )
      .map(toRef);
  }

  async listQueueAttachments(
    queueItemId: string,
  ): Promise<StagedAttachmentRef[]> {
    await this.ensureInitialized();
    if (!isSafeUploadPathSegment(queueItemId)) {
      throw new Error("Invalid queue item id");
    }
    return [...this.records.values()]
      .filter(
        (record) =>
          record.owner.type === "project-queue" &&
          record.owner.queueItemId === queueItemId,
      )
      .map(toRef);
  }

  async validateDraftRefs(
    batchId: string,
    refs: readonly StagedAttachmentRef[],
  ): Promise<StagedAttachmentRef[]> {
    await this.ensureInitialized();
    if (!isSafeUploadPathSegment(batchId)) {
      throw new Error("Invalid staging batch id");
    }
    return this.validateRefs(refs, (record) => {
      return record.owner.type === "draft" && record.owner.batchId === batchId;
    });
  }

  async validateQueueRefs(
    queueItemId: string,
    refs: readonly StagedAttachmentRef[],
  ): Promise<StagedAttachmentRef[]> {
    await this.ensureInitialized();
    if (!isSafeUploadPathSegment(queueItemId)) {
      throw new Error("Invalid queue item id");
    }
    return this.validateRefs(refs, (record) => {
      return (
        record.owner.type === "project-queue" &&
        record.owner.queueItemId === queueItemId
      );
    });
  }

  async deleteAttachment(id: string): Promise<boolean> {
    await this.ensureInitialized();
    if (this.protectedDraft(id)) return false;
    const record = this.records.get(id);
    if (!record) return false;
    await rm(record.path, { force: true }).catch(() => {});
    await this.withMutation(async () => {
      this.records.delete(id);
      await this.saveIndex();
    });
    return true;
  }

  async deleteDraftAttachment(batchId: string, id: string): Promise<boolean> {
    await this.ensureInitialized();
    if (this.protectedDraft(id)) return false;
    if (!isSafeUploadPathSegment(batchId)) {
      throw new Error("Invalid staging batch id");
    }
    if (!isSafeUploadPathSegment(id)) {
      throw new Error("Invalid staged attachment id");
    }

    const record = this.records.get(id);
    if (!record) {
      return false;
    }
    if (record.owner.type !== "draft" || record.owner.batchId !== batchId) {
      return false;
    }

    await rm(record.path, { force: true }).catch(() => {});
    await this.withMutation(async () => {
      this.records.delete(id);
      await this.saveIndex();
    });
    return true;
  }

  /** Delete one attachment only while it is still owned by this queue item. */
  async deleteQueueAttachment(
    queueItemId: string,
    id: string,
  ): Promise<boolean> {
    await this.ensureInitialized();
    if (!isSafeUploadPathSegment(queueItemId)) {
      throw new Error("Invalid queue item id");
    }
    const record = this.records.get(id);
    if (
      record?.owner.type !== "project-queue" ||
      record.owner.queueItemId !== queueItemId
    ) {
      return false;
    }
    await rm(record.path, { force: true }).catch(() => {});
    await this.withMutation(async () => {
      this.records.delete(id);
      await this.saveIndex();
    });
    return true;
  }

  async deleteQueueAttachments(queueItemId: string): Promise<number> {
    await this.ensureInitialized();
    if (!isSafeUploadPathSegment(queueItemId)) {
      throw new Error("Invalid queue item id");
    }

    const records = [...this.records.values()].filter(
      (record) =>
        record.owner.type === "project-queue" &&
        record.owner.queueItemId === queueItemId,
    );
    for (const record of records) {
      await rm(record.path, { force: true }).catch(() => {});
    }
    await this.withMutation(async () => {
      for (const record of records) {
        this.records.delete(record.id);
      }
      await this.saveIndex();
    });
    return records.length;
  }

  async transferDraftAttachmentsToQueue(params: {
    batchId: string;
    queueItemId: string;
    refs: readonly StagedAttachmentRef[];
  }): Promise<StagedAttachmentRef[]> {
    const prepared = await this.prepareDraftAttachmentsForQueue(params);
    prepared.commit();
    return prepared.refs;
  }

  async prepareDraftAttachmentsForQueue(params: {
    batchId: string;
    queueItemId: string;
    refs: readonly StagedAttachmentRef[];
  }): Promise<PreparedQueueAttachmentTransfer> {
    await this.ensureInitialized();
    if (!isSafeUploadPathSegment(params.batchId)) {
      throw new Error("Invalid staging batch id");
    }
    if (!isSafeUploadPathSegment(params.queueItemId)) {
      throw new Error("Invalid queue item id");
    }

    const { originalRecords, movedRecords } = await this.withMutation(
      async () => {
        const records = await this.getValidatedRecords(
          params.refs,
          (record) => {
            return (
              record.owner.type === "draft" &&
              (record.owner.batchId === params.batchId ||
                (!!this.draftProtection &&
                  params.refs.some(
                    (ref) =>
                      ref.id === record.id && ref.batchId === record.batchId,
                  )))
            );
          },
        );
        const transferable: StagedAttachmentRecord[] = [];
        for (const record of records) {
          // Draft publication can still be in flight when enqueue arrives.
          // A sync-enabled store must preserve even not-yet-protected refs;
          // otherwise that write loses its source file before it can save.
          if (!this.draftProtection) {
            transferable.push(record);
            continue;
          }
          const id = randomUUID();
          const name = `${id}_${record.originalName.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
          const clone = {
            ...record,
            id,
            name,
            path: join(dirname(record.path), name),
          };
          await copyFile(record.path, clone.path);
          this.records.set(id, clone);
          transferable.push(clone);
        }
        // Persist clones first: interruption leaves ordinary TTL-owned staging,
        // while the original draft references remain valid.
        await this.saveIndex();
        const originals: StagedAttachmentRecord[] = transferable.map(
          (record) => ({
            ...record,
            owner: { ...record.owner },
          }),
        );
        const queueDir = this.ownerDir({
          type: "project-queue",
          queueItemId: params.queueItemId,
        });
        const now = new Date(this.now()).toISOString();
        const moved: StagedAttachmentRecord[] = originals.map((record) => ({
          ...record,
          path: join(queueDir, record.name),
          updatedAt: now,
          owner: {
            type: "project-queue",
            queueItemId: params.queueItemId,
          },
        }));

        await this.moveRecords(originals, moved);
        return { originalRecords: originals, movedRecords: moved };
      },
    );

    let pending = true;
    return {
      refs: movedRecords.map(toRef),
      commit: () => {
        pending = false;
      },
      rollback: async () => {
        if (!pending) return;
        pending = false;
        await this.withMutation(() =>
          this.moveRecords(movedRecords, originalRecords),
        );
      },
    };
  }

  async materializeDraftAttachmentsForSession(params: {
    batchId: string;
    refs: readonly StagedAttachmentRef[];
    projectPath: string;
    sessionId: string;
  }): Promise<UploadedFile[]> {
    await this.ensureInitialized();
    if (!isSafeUploadPathSegment(params.batchId)) {
      throw new Error("Invalid staging batch id");
    }
    if (!isSafeUploadPathSegment(params.sessionId)) {
      throw new Error("Invalid session id");
    }

    const records = await this.getValidatedRecords(params.refs, (record) => {
      return (
        record.owner.type === "draft" && record.owner.batchId === params.batchId
      );
    });
    return this.materializeRecordsForSession(records, {
      projectPath: params.projectPath,
      sessionId: params.sessionId,
    });
  }

  async materializeQueueAttachmentsForSession(params: {
    queueItemId: string;
    refs: readonly StagedAttachmentRef[];
    projectPath: string;
    sessionId: string;
  }): Promise<UploadedFile[]> {
    await this.ensureInitialized();
    if (!isSafeUploadPathSegment(params.queueItemId)) {
      throw new Error("Invalid queue item id");
    }
    if (!isSafeUploadPathSegment(params.sessionId)) {
      throw new Error("Invalid session id");
    }

    const records = await this.getValidatedRecords(params.refs, (record) => {
      return (
        record.owner.type === "project-queue" &&
        record.owner.queueItemId === params.queueItemId
      );
    });
    return this.materializeRecordsForSession(records, {
      projectPath: params.projectPath,
      sessionId: params.sessionId,
    });
  }

  async cleanupStaleDraftAttachments(nowMs = this.now()): Promise<number> {
    await this.ensureInitialized();
    const cutoff = nowMs - this.draftTtlMs;
    const stale = [...this.records.values()].filter((record) => {
      if (record.owner.type !== "draft" || this.protectedDraft(record.id))
        return false;
      const updatedAt = Date.parse(record.updatedAt);
      return !Number.isFinite(updatedAt) || updatedAt < cutoff;
    });

    for (const record of stale) {
      await rm(record.path, { force: true }).catch(() => {});
    }

    await this.withMutation(async () => {
      for (const record of stale) {
        this.records.delete(record.id);
      }
      if (stale.length > 0) {
        await this.saveIndex();
      }
    });

    return stale.length;
  }

  getRecord(id: string): StagedAttachmentRecord | null {
    const record = this.records.get(id);
    return record ? { ...record, owner: { ...record.owner } } : null;
  }

  getStagingRoot(): string {
    return this.stagingRoot;
  }

  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) {
      await this.initialize();
    }
  }

  private ownerDir(owner: StagedAttachmentOwner): string {
    if (owner.type === "draft") {
      if (!isSafeUploadPathSegment(owner.batchId)) {
        throw new Error("Invalid staging batch id");
      }
      return join(this.stagingRoot, "drafts", owner.batchId);
    }
    if (!isSafeUploadPathSegment(owner.queueItemId)) {
      throw new Error("Invalid queue item id");
    }
    return join(this.stagingRoot, "queue", owner.queueItemId);
  }

  private async loadIndex(): Promise<void> {
    this.records.clear();
    try {
      const content = await readFile(this.indexPath, "utf-8");
      const parsed = JSON.parse(content) as Partial<StagingIndexFile>;
      if (parsed.version !== 1 || !Array.isArray(parsed.records)) {
        return;
      }
      for (const rawRecord of parsed.records) {
        const record = normalizeRecord(rawRecord, this.stagingRoot);
        if (record) {
          this.records.set(record.id, record);
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn(
          "[AttachmentStagingService] Failed to load staging index:",
          error,
        );
      }
    }
  }

  private async saveIndex(): Promise<void> {
    await mkdir(this.stagingRoot, { recursive: true });
    const tmpPath = `${this.indexPath}.${randomUUID()}.tmp`;
    const body: StagingIndexFile = {
      version: 1,
      records: [...this.records.values()].sort((a, b) =>
        a.id.localeCompare(b.id),
      ),
    };
    await writeFile(tmpPath, JSON.stringify(body, null, 2));
    await rename(tmpPath, this.indexPath);
  }

  private async validateRefs(
    refs: readonly StagedAttachmentRef[],
    ownerMatches: (record: StagedAttachmentRecord) => boolean,
  ): Promise<StagedAttachmentRef[]> {
    const records = await this.getValidatedRecords(refs, ownerMatches);
    return records.map(toRef);
  }

  private async getValidatedRecords(
    refs: readonly StagedAttachmentRef[],
    ownerMatches: (record: StagedAttachmentRecord) => boolean,
  ): Promise<StagedAttachmentRecord[]> {
    const records: StagedAttachmentRecord[] = [];
    for (const ref of refs) {
      const record = this.records.get(ref.id);
      if (!record || record.batchId !== ref.batchId || !ownerMatches(record)) {
        throw new Error(`Staged attachment not found: ${ref.id}`);
      }
      const stats = await stat(record.path).catch((error) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      });
      if (!stats?.isFile() || stats.size !== record.size) {
        throw new Error(`Staged attachment is missing or invalid: ${ref.id}`);
      }
      records.push(record);
    }
    return records;
  }

  private async materializeRecordsForSession(
    records: readonly StagedAttachmentRecord[],
    params: { projectPath: string; sessionId: string },
  ): Promise<UploadedFile[]> {
    const targetDir = await getProjectAttachmentUploadDir(
      params.projectPath,
      params.sessionId,
      this.storagePolicy,
    );
    const files: UploadedFile[] = [];

    for (const record of records) {
      const targetPath = join(targetDir, record.name);
      let finalStats = await stat(targetPath).catch((error) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      });
      if (!finalStats) {
        await copyFile(record.path, targetPath);
        finalStats = await stat(targetPath);
      }

      if (!finalStats.isFile() || finalStats.size !== record.size) {
        throw new Error(
          `Final attachment path has unexpected size: ${record.name}`,
        );
      }

      files.push({
        id: record.id,
        originalName: record.originalName,
        name: record.name,
        path: targetPath,
        size: record.size,
        mimeType: record.mimeType,
        ...(record.width !== undefined ? { width: record.width } : {}),
        ...(record.height !== undefined ? { height: record.height } : {}),
      });
    }

    return files;
  }

  private async moveRecords(
    currentRecords: readonly StagedAttachmentRecord[],
    nextRecords: readonly StagedAttachmentRecord[],
  ): Promise<void> {
    if (currentRecords.length !== nextRecords.length) {
      throw new Error("Staged attachment move is incomplete");
    }

    const sameOwner = (
      left: StagedAttachmentOwner,
      right: StagedAttachmentOwner,
    ): boolean => {
      if (left.type === "draft") {
        return right.type === "draft" && left.batchId === right.batchId;
      }
      return (
        right.type === "project-queue" && left.queueItemId === right.queueItemId
      );
    };
    for (const expected of currentRecords) {
      const current = this.records.get(expected.id);
      if (
        !current ||
        current.path !== expected.path ||
        !sameOwner(current.owner, expected.owner)
      ) {
        throw new Error(
          `Staged attachment ownership changed before move: ${expected.id}`,
        );
      }
    }

    const completed: number[] = [];
    try {
      for (let index = 0; index < currentRecords.length; index += 1) {
        const current = currentRecords[index]!;
        const next = nextRecords[index]!;
        await mkdir(dirname(next.path), { recursive: true });
        if (current.path !== next.path) {
          await rename(current.path, next.path);
        }
        completed.push(index);
      }
      for (const record of nextRecords) {
        this.records.set(record.id, record);
      }
      await this.saveIndex();
    } catch (error) {
      const recoveryErrors: unknown[] = [];
      for (let offset = completed.length - 1; offset >= 0; offset -= 1) {
        const index = completed[offset]!;
        const current = currentRecords[index]!;
        const next = nextRecords[index]!;
        if (current.path !== next.path) {
          await rename(next.path, current.path).catch((recoveryError) =>
            recoveryErrors.push(recoveryError),
          );
        }
      }
      for (const record of currentRecords) {
        this.records.set(record.id, record);
      }
      if (recoveryErrors.length > 0) {
        throw new AggregateError(
          [error, ...recoveryErrors],
          "Staged attachment move failed and its prior ownership could not be restored",
        );
      }
      throw error;
    }
  }

  private async pruneInvalidRecords(): Promise<void> {
    const invalid: StagedAttachmentRecord[] = [];
    for (const record of this.records.values()) {
      const stats = await stat(record.path).catch((error) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      });
      if (!stats?.isFile() || stats.size !== record.size) {
        invalid.push(record);
      }
    }

    for (const record of invalid) {
      await rm(record.path, { force: true }).catch(() => {});
      this.records.delete(record.id);
    }
    if (invalid.length > 0) {
      await this.saveIndex();
    }
  }

  private async removePartialFiles(): Promise<void> {
    const removeInDir = async (dir: string): Promise<void> => {
      const entries = await readdir(dir, { withFileTypes: true }).catch(
        (error) => {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
          throw error;
        },
      );
      await Promise.all(
        entries.map(async (entry) => {
          const entryPath = join(dir, entry.name);
          if (entry.isDirectory()) {
            await removeInDir(entryPath);
            return;
          }
          if (entry.isFile() && entry.name.endsWith(".partial")) {
            await rm(entryPath, { force: true }).catch(() => {});
          }
        }),
      );
    };

    await removeInDir(this.stagingRoot);
  }

  private async withMutation<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.mutationQueue.then(fn, fn);
    this.mutationQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}
