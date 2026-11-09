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
  realpath,
} from "node:fs/promises";
import { isAbsolute, join } from "node:path";
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
type SavedFile = Omit<UploadedFile, "path"> & {
  sha256: string;
  inlineImage?: true;
};
export interface CreationLegacyFiles {
  files?: readonly UploadedFile[];
  images?: readonly string[];
}
export interface CreationAttachmentSnapshot {
  groupId: string;
  files: SavedFile[];
}
const hashPattern = /^[a-f0-9]{64}$/;
/**
 * Each operation copies its files into a sealed bundle, so its bytes are
 * bounded per operation. There is no profile-wide total (plan 189 step 1).
 */
export const MAX_OPERATION_ATTACHMENT_BYTES = 2 * 1024 ** 3;
function exceedsOperationBytes(files: readonly { size: number }[]): boolean {
  return (
    files.reduce((sum, file) => sum + file.size, 0) >
    MAX_OPERATION_ATTACHMENT_BYTES
  );
}
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
      (f.inlineImage !== undefined && f.inlineImage !== true) ||
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
      ...(f.inlineImage ? { inlineImage: true as const } : {}),
      ...(f.width !== undefined ? { width: f.width } : {}),
      ...(f.height !== undefined ? { height: f.height } : {}),
    };
  });
  if (exceedsOperationBytes(files))
    throw new Error("Saved creation attachments exceed the operation bound");
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
    source: CreationAttachmentSource | undefined,
    legacy?: CreationLegacyFiles,
  ): Promise<CreationAttachmentSnapshot> {
    this.cleanupPromise ??= this.cleanup();
    await this.cleanupPromise;
    const count =
      (source?.refs.length ?? 0) +
      (legacy?.files?.length ?? 0) +
      (legacy?.images?.length ?? 0);
    if (!count || count > 64)
      throw new Error("Invalid creation attachment references");
    const staging = this.staging.forUser(
      owner.kind === "limited" ? owner.username : null,
    );
    const refs = source
      ? source.owner.type === "draft"
        ? (
            await Promise.all(
              source.refs.map((ref) =>
                staging.validateDraftRefs(ref.batchId, [ref]),
              ),
            )
          ).flat()
        : await staging.validateQueueRefs(source.owner.queueItemId, source.refs)
      : [];
    const records: UploadedFile[] = refs.map((ref) => {
      const record = staging.getRecord(ref.id);
      if (!record) throw new Error("Staged attachment is unavailable");
      return record;
    });
    for (const submitted of legacy?.files ?? []) {
      if (
        !submitted ||
        typeof submitted.path !== "string" ||
        !isAbsolute(submitted.path)
      )
        throw new Error("Invalid initial uploaded file");
      let file = submitted;
      if (owner.kind === "limited") {
        const record = staging.getRecord(submitted.id);
        if (!record || record.path !== submitted.path)
          throw new Error(
            "Initial files require this user's staged attachment",
          );
        if (record.owner.type !== "draft")
          throw new Error("Initial files require this user's draft staging");
        await staging.validateDraftRefs(record.owner.batchId, [record]);
        file = record;
      }
      const path = await realpath(file.path),
        stat = await lstat(path);
      if (
        !stat.isFile() ||
        stat.size !== file.size ||
        stat.size > 64 * 1024 * 1024
      )
        throw new Error("Initial uploaded file is missing or changed");
      records.push({ ...file, path });
    }
    // Refuse before copying; the snapshot repeats this with inline images.
    if (exceedsOperationBytes(records))
      throw new Error("Creation attachments exceed the operation bound");
    const temp = join(this.root, `${randomUUID()}.partial`);
    await mkdir(temp, { recursive: true });
    try {
      const files: SavedFile[] = [];
      for (const record of records) {
        if (
          !isSafeUploadPathSegment(record.name) ||
          !isSafeUploadPathSegment(record.id)
        )
          throw new Error("Invalid initial upload name");
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
      let inlineImageBytes = 0;
      for (const [index, image] of (legacy?.images ?? []).entries()) {
        if (typeof image !== "string" || image.length > 48 * 1024 * 1024)
          throw new Error("Invalid initial image size");
        const raw = image.replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, "");
        if (!/^[A-Za-z0-9+/]+={0,2}$/.test(raw))
          throw new Error(
            "Initial images require base64 bytes; use uploads for file paths",
          );
        const bytes = Buffer.from(raw, "base64"),
          sha256 = createHash("sha256").update(bytes).digest("hex");
        inlineImageBytes += bytes.length;
        if (!bytes.length || inlineImageBytes > 32 * 1024 * 1024)
          throw new Error("Invalid initial image size");
        const ext = bytes.subarray(0, 4).equals(Buffer.from([137, 80, 78, 71]))
          ? "png"
          : bytes[0] === 255 && bytes[1] === 216
            ? "jpeg"
            : bytes.subarray(0, 3).toString() === "GIF"
              ? "gif"
              : bytes.subarray(0, 4).toString() === "RIFF" &&
                  bytes.subarray(8, 12).toString() === "WEBP"
                ? "webp"
                : undefined;
        if (!ext) throw new Error("Unsupported initial image bytes");
        const id = `image-${index}-${sha256.slice(0, 32)}`,
          name = `${id}.${ext}`;
        const file: SavedFile = {
          id,
          name,
          originalName: name,
          mimeType: `image/${ext}`,
          size: bytes.length,
          sha256,
          inlineImage: true,
        };
        await writeFile(join(temp, name), bytes);
        files.push(file);
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
  ): Promise<Array<UploadedFile & { inlineImage?: true }>> {
    const snapshot = snapshotCreationAttachments(value);
    const dir = await getProjectAttachmentUploadDir(
      projectPath,
      sessionId,
      this.policy,
    );
    const result: Array<UploadedFile & { inlineImage?: true }> = [];
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
