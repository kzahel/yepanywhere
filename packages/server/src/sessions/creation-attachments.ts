import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import type { StagedAttachmentRef, UploadedFile } from "@yep-anywhere/shared";
import type { AttachmentStagingService } from "../uploads/AttachmentStagingService.js";
import {
  getProjectAttachmentUploadDir,
  isSafeUploadPathSegment,
} from "../uploads/manager.js";
import type { ProjectStoragePolicy } from "../projects/projectStoragePolicy.js";
import type {
  CreationOwner,
  SessionCreationStore,
} from "./SessionCreationStore.js";

export type CreationAttachmentSource = {
  owner: { type: "draft" } | { type: "project-queue"; queueItemId: string };
  refs: readonly StagedAttachmentRef[];
};
type SavedFile = Omit<UploadedFile, "path"> & { sha256: string };
export interface CreationAttachmentSnapshot {
  groupId: string;
  files: SavedFile[];
}
const hashPattern = /^[a-f0-9]{64}$/;
export function snapshotCreationAttachments(
  value: CreationAttachmentSnapshot,
): CreationAttachmentSnapshot {
  if (
    !value ||
    !hashPattern.test(value.groupId) ||
    !Array.isArray(value.files) ||
    value.files.length < 1 ||
    value.files.length > 64
  )
    throw new Error("Invalid saved creation attachments");
  const names = new Set<string>();
  const files = value.files.map((f) => {
    if (
      !f ||
      !isSafeUploadPathSegment(f.id) ||
      !isSafeUploadPathSegment(f.name) ||
      names.has(f.name) ||
      typeof f.originalName !== "string" ||
      typeof f.mimeType !== "string" ||
      !Number.isSafeInteger(f.size) ||
      f.size < 0 ||
      !hashPattern.test(f.sha256)
    )
      throw new Error("Invalid saved creation attachment");
    names.add(f.name);
    for (const d of [f.width, f.height])
      if (d !== undefined && (!Number.isSafeInteger(d) || d <= 0))
        throw new Error("Invalid attachment dimension");
    return {
      id: f.id,
      originalName: f.originalName,
      name: f.name,
      size: f.size,
      mimeType: f.mimeType,
      sha256: f.sha256,
      ...(f.width !== undefined ? { width: f.width } : {}),
      ...(f.height !== undefined ? { height: f.height } : {}),
    };
  });
  return { groupId: value.groupId, files };
}
async function digest(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
async function verify(path: string, file: SavedFile): Promise<void> {
  const s = await lstat(path);
  if (
    !s.isFile() ||
    s.size !== file.size ||
    (await digest(path)) !== file.sha256
  )
    throw new Error("Saved creation attachment is missing or changed");
}

/** Filesystem preparation precedes the SQLite claim. Unclaimed bundles expire;
 * accepted bundles belong to the operation, independently of draft/Queue TTL. */
export class CreationAttachments {
  private cleanupPromise?: Promise<void>;
  constructor(
    private readonly root: string,
    private readonly staging: AttachmentStagingService,
    private readonly policy: ProjectStoragePolicy,
    private readonly store: SessionCreationStore,
  ) {}

  async seal(
    owner: CreationOwner,
    requestId: string,
    source: CreationAttachmentSource,
  ): Promise<CreationAttachmentSnapshot> {
    this.cleanupPromise ??= this.cleanup();
    await this.cleanupPromise;
    if (
      !source ||
      !Array.isArray(source.refs) ||
      !source.refs.length ||
      source.refs.length > 64
    )
      throw new Error("Invalid creation attachment references");
    const staging = this.staging.forUser(
      owner.kind === "limited" ? owner.username : null,
    );
    const refs =
      source.owner.type === "draft"
        ? (
            await Promise.all(
              source.refs.map((ref) =>
                staging.validateDraftRefs(ref.batchId, [ref]),
              ),
            )
          ).flat()
        : await staging.validateQueueRefs(
            source.owner.queueItemId,
            source.refs,
          );
    this.store.assertAttachmentCapacity(
      refs.reduce((sum, ref) => sum + ref.size, 0),
    );
    const temp = join(this.root, `${randomUUID()}.partial`);
    await mkdir(temp, { recursive: true });
    try {
      const files: SavedFile[] = [];
      for (const ref of refs) {
        const record = staging.getRecord(ref.id);
        if (!record) throw new Error("Staged attachment is unavailable");
        const path = join(temp, record.name);
        await copyFile(record.path, path);
        const f: SavedFile = {
          id: record.id,
          name: record.name,
          originalName: record.originalName,
          mimeType: record.mimeType,
          size: record.size,
          sha256: await digest(path),
          ...(record.width !== undefined ? { width: record.width } : {}),
          ...(record.height !== undefined ? { height: record.height } : {}),
        };
        await verify(path, f);
        files.push(f);
      }
      const groupId = createHash("sha256")
        .update(JSON.stringify({ owner, requestId, files }))
        .digest("hex");
      const snapshot = snapshotCreationAttachments({ groupId, files });
      await writeFile(
        join(temp, "manifest.json"),
        JSON.stringify({ owner, requestId, createdAt: Date.now(), snapshot }),
      );
      const target = join(this.root, groupId);
      try {
        await rename(temp, target);
      } catch (error) {
        if (
          !["EEXIST", "ENOTEMPTY"].includes(
            (error as NodeJS.ErrnoException).code ?? "",
          )
        )
          throw error;
        for (const f of files) await verify(join(target, f.name), f);
      }
      return snapshot;
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  }

  async materialize(
    value: CreationAttachmentSnapshot,
    projectPath: string,
    sessionId: string,
  ): Promise<UploadedFile[]> {
    const snapshot = snapshotCreationAttachments(value);
    const dir = await getProjectAttachmentUploadDir(
      projectPath,
      sessionId,
      this.policy,
    );
    const result: UploadedFile[] = [];
    for (const file of snapshot.files) {
      const source = join(this.root, snapshot.groupId, file.name);
      await verify(source, file);
      const target = join(dir, file.name);
      try {
        await verify(target, file);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        const temp = join(dir, `${randomUUID()}.partial`);
        try {
          await copyFile(source, temp);
          await verify(temp, file);
          await rename(temp, target);
        } finally {
          await rm(temp, { force: true });
        }
      }
      const { sha256: _, ...metadata } = file;
      result.push({ ...metadata, path: target });
    }
    return result;
  }

  /** One bounded-by-storage scan on first use, no per-session timers. */
  private async cleanup(): Promise<void> {
    await mkdir(this.root, { recursive: true });
    const entries = await readdir(this.root, { withFileTypes: true });
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const path = join(this.root, entry.name);
      if (entry.name.endsWith(".partial")) {
        if ((await lstat(path)).mtimeMs < cutoff)
          await rm(path, { recursive: true, force: true });
        continue;
      }
      if (!hashPattern.test(entry.name)) continue;
      const manifest = JSON.parse(
        await readFile(join(path, "manifest.json"), "utf8"),
      );
      if (manifest.createdAt >= cutoff) continue;
      if (
        this.store.getAttachmentGroupId(manifest.owner, manifest.requestId) !==
        entry.name
      )
        await rm(path, { recursive: true, force: true });
    }
  }
}
