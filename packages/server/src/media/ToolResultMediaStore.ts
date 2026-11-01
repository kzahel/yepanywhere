import type {
  ProviderName,
  ToolResultMedia,
  ToolResultMediaRejectionReason,
  UrlProjectId,
} from "@yep-anywhere/shared";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { registerIdleSweep } from "../lib/processIdleSweep.js";
import type { ProjectStoragePolicy } from "../projects/projectStoragePolicy.js";
import type { ToolResultMediaCandidate } from "./inlineImageData.js";
import { ToolResultMediaMessageMaterializer } from "./ToolResultMediaMessageMaterializer.js";

const STORE_VERSION = 1;
const DEFAULT_MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const DEFAULT_MAX_VIDEO_BYTES = 64 * 1024 * 1024;
const DEFAULT_TRANSIENT_MEDIA_MAX_BYTES = 64 * 1024 * 1024;
const DEFAULT_TRANSIENT_MEDIA_TTL_MS = 30 * 60 * 1000;
const SAFE_SEGMENT_RE = /^[A-Za-z0-9._-]+$/;
const MEDIA_ID_RE = /^[A-Za-z0-9_-]{43}$/;
const CONTENT_HASH_RE = /^[a-f0-9]{64}$/;

interface ValidatedMedia {
  bytes: Buffer;
  contentHash: string;
  extension: "gif" | "jpg" | "mp4" | "png" | "webp";
  mimeType:
    | "image/gif"
    | "image/jpeg"
    | "image/png"
    | "image/webp"
    | "video/mp4";
  width?: number;
  height?: number;
}

interface ToolResultMediaCatalogEntry {
  version: typeof STORE_VERSION;
  id: string;
  provider: ProviderName;
  projectId: UrlProjectId;
  sessionId: string;
  toolCallId: string;
  mediaIndex: number;
  mimeType: ValidatedMedia["mimeType"];
  byteLength: number;
  width?: number;
  height?: number;
  filename?: string;
  originalPath?: string;
  claimedMimeType?: string;
  contentHash: string;
}

export interface ToolResultMediaContext {
  provider: ProviderName;
  projectId: UrlProjectId;
  projectPath: string;
  getSessionId: () => string;
}

export interface ToolResultMediaFile {
  path?: string;
  bytes?: Buffer;
  mimeType: string;
  byteLength: number;
  persistent: boolean;
}

export interface ToolResultMediaStoreOptions {
  dataDir?: string;
  maxImageBytes?: number;
  maxVideoBytes?: number;
  resolveSourcePath?: (absolutePath: string) => Promise<string | null>;
  providerSourceRoots?: (
    context: ToolResultMediaProviderSourceContext,
  ) => readonly string[] | Promise<readonly string[]>;
  storagePolicy?: ProjectStoragePolicy;
  shouldPreserveLiveMedia?: () => boolean;
  transientMediaMaxBytes?: number;
  transientMediaTtlMs?: number;
}

export interface ToolResultMediaProviderSourceContext {
  provider: ProviderName;
  projectPath: string;
  sessionId: string;
}

export class ToolResultMediaStore {
  private readonly dataDir: string | undefined;
  private readonly maxImageBytes: number;
  private readonly maxVideoBytes: number;
  private readonly resolveSourcePath:
    | ((absolutePath: string) => Promise<string | null>)
    | undefined;
  private readonly providerSourceRoots: ToolResultMediaStoreOptions["providerSourceRoots"];
  private readonly storagePolicy: ProjectStoragePolicy | undefined;
  private readonly shouldPreserveLiveMediaValue: () => boolean;
  private readonly transientMediaMaxBytes: number;
  private readonly transientMediaTtlMs: number;
  private readonly transientMedia = new Map<
    string,
    ToolResultMediaCatalogEntry & { bytes: Buffer; lastAccessedAt: number }
  >();
  private transientMediaBytes = 0;
  /** Expires transient media while no insert or read arrives to prune it. */
  private unregisterTransientSweep: (() => void) | null = null;

  constructor(options: ToolResultMediaStoreOptions = {}) {
    this.dataDir = options.dataDir;
    this.maxImageBytes = options.maxImageBytes ?? DEFAULT_MAX_IMAGE_BYTES;
    this.maxVideoBytes = options.maxVideoBytes ?? DEFAULT_MAX_VIDEO_BYTES;
    this.resolveSourcePath = options.resolveSourcePath;
    this.providerSourceRoots = options.providerSourceRoots;
    this.storagePolicy = options.storagePolicy;
    this.shouldPreserveLiveMediaValue =
      options.shouldPreserveLiveMedia ?? (() => false);
    this.transientMediaMaxBytes =
      options.transientMediaMaxBytes ?? DEFAULT_TRANSIENT_MEDIA_MAX_BYTES;
    this.transientMediaTtlMs =
      options.transientMediaTtlMs ?? DEFAULT_TRANSIENT_MEDIA_TTL_MS;
  }

  createMaterializer(
    context: ToolResultMediaContext,
    options: { live?: boolean } = {},
  ): ToolResultMediaMessageMaterializer {
    return new ToolResultMediaMessageMaterializer(
      this,
      context,
      options.live === true,
    );
  }

  shouldPreserveLiveMedia(): boolean {
    return this.shouldPreserveLiveMediaValue();
  }

  async capture(
    candidate: ToolResultMediaCandidate,
    context: ToolResultMediaContext,
    toolCallId: string,
    mediaIndex: number,
    options: { preserve: boolean } = { preserve: false },
  ): Promise<ToolResultMedia> {
    const sessionId = context.getSessionId();
    const filename =
      safeDisplayFilename(candidate.filename) ??
      safeDisplayFilename(candidate.originalPath);
    const claimedMimeType = safeClaimedMimeType(candidate.claimedMimeType);
    const rejected = (
      reason: ToolResultMediaRejectionReason,
    ): ToolResultMedia => ({
      state: "rejected",
      toolCallId,
      reason,
      ...(filename ? { filename } : {}),
      ...(claimedMimeType ? { claimedMimeType } : {}),
    });

    if (!isSafeSegment(sessionId) || !toolCallId) {
      return rejected("storage-unavailable");
    }

    let bytes: Buffer;
    let originalPath = candidate.originalPath;
    if (candidate.dataUrl) {
      const decoded = decodeImageDataUrl(candidate.dataUrl, this.maxImageBytes);
      if ("reason" in decoded) return rejected(decoded.reason);
      bytes = decoded.bytes;
    } else if (originalPath) {
      const sourcePath = await this.resolvePermittedSourcePath(originalPath, {
        provider: context.provider,
        projectPath: context.projectPath,
        sessionId,
      });
      if (!sourcePath) return rejected("source-unavailable");
      originalPath = sourcePath;
      const sourceStats = await stat(sourcePath).catch(() => null);
      if (!sourceStats?.isFile()) return rejected("source-unavailable");
      const maxBytes = looksLikeVideoPath(sourcePath, filename)
        ? this.maxVideoBytes
        : this.maxImageBytes;
      if (sourceStats.size > maxBytes) return rejected("too-large");
      bytes = await readFile(sourcePath).catch(() => Buffer.alloc(0));
      if (bytes.length === 0) return rejected("source-unavailable");
    } else {
      return rejected("invalid-image-data");
    }

    const validated = validateMedia(bytes);
    if (!validated) return rejected("unsupported-media");

    const id = mediaIdFor({
      provider: context.provider,
      projectId: context.projectId,
      sessionId,
      toolCallId,
      mediaIndex,
      contentHash: validated.contentHash,
    });
    const storedFilename =
      filename ?? `tool-result-${mediaIndex + 1}.${validated.extension}`;
    const entry: ToolResultMediaCatalogEntry = {
      version: STORE_VERSION,
      id,
      provider: context.provider,
      projectId: context.projectId,
      sessionId,
      toolCallId,
      mediaIndex,
      mimeType: validated.mimeType,
      byteLength: validated.bytes.length,
      ...(validated.width !== undefined ? { width: validated.width } : {}),
      ...(validated.height !== undefined ? { height: validated.height } : {}),
      filename: storedFilename,
      ...(originalPath ? { originalPath } : {}),
      ...(claimedMimeType ? { claimedMimeType } : {}),
      contentHash: validated.contentHash,
    };

    this.rememberTransient(entry, validated.bytes);

    if (options.preserve) {
      try {
        const root = await this.getWriteRoot(context.projectPath, sessionId);
        await atomicWriteIfAbsent(
          join(
            root,
            "blobs",
            `${validated.contentHash}.${validated.extension}`,
          ),
          validated.bytes,
          validated.contentHash,
        );
        await atomicWrite(
          join(root, "records", `${id}.json`),
          Buffer.from(`${JSON.stringify(entry)}\n`),
        );
        this.forgetTransient(id);
      } catch {
        // The transient handle remains usable even when preservation fails.
      }
    }

    return {
      state: "stored",
      toolCallId,
      id,
      mimeType: validated.mimeType,
      byteLength: validated.bytes.length,
      ...(validated.width !== undefined ? { width: validated.width } : {}),
      ...(validated.height !== undefined ? { height: validated.height } : {}),
      filename: storedFilename,
    };
  }

  async getMediaFile(
    projectPath: string,
    projectId: UrlProjectId,
    sessionId: string,
    mediaId: string,
  ): Promise<ToolResultMediaFile | null> {
    if (!isSafeSegment(sessionId) || !MEDIA_ID_RE.test(mediaId)) return null;

    this.pruneTransient();
    const transient = this.transientMedia.get(mediaId);
    if (
      transient?.projectId === projectId &&
      transient.sessionId === sessionId
    ) {
      transient.lastAccessedAt = Date.now();
      this.transientMedia.delete(mediaId);
      this.transientMedia.set(mediaId, transient);
      return {
        bytes: transient.bytes,
        mimeType: transient.mimeType,
        byteLength: transient.byteLength,
        persistent: false,
      };
    }

    for (const root of await this.getReadRoots(projectPath, sessionId)) {
      const entry = await readCatalogEntry(
        join(root, "records", `${mediaId}.json`),
      );
      if (
        !entry ||
        entry.id !== mediaId ||
        entry.projectId !== projectId ||
        entry.sessionId !== sessionId
      ) {
        continue;
      }
      const extension = extensionForMimeType(entry.mimeType);
      if (!extension) continue;
      const blobPath = join(root, "blobs", `${entry.contentHash}.${extension}`);
      const blobStats = await lstat(blobPath).catch(() => null);
      if (
        !blobStats?.isFile() ||
        blobStats.size !== entry.byteLength ||
        !(await fileMatchesContentHash(blobPath, entry.contentHash))
      ) {
        continue;
      }
      return {
        path: blobPath,
        mimeType: entry.mimeType,
        byteLength: entry.byteLength,
        persistent: true,
      };
    }
    return null;
  }

  private async resolvePermittedSourcePath(
    sourcePath: string,
    context: ToolResultMediaProviderSourceContext,
  ): Promise<string | null> {
    const absolutePath = isAbsolute(sourcePath)
      ? sourcePath
      : resolve(context.projectPath, sourcePath);
    if (this.resolveSourcePath) {
      const generallyAllowed = await this.resolveSourcePath(absolutePath).catch(
        () => null,
      );
      if (generallyAllowed) return generallyAllowed;
    }

    const resolvedSource = await realpath(absolutePath).catch(() => null);
    if (!resolvedSource) return null;

    const providerRoots = (await this.providerSourceRoots?.(context)) ?? [];
    for (const root of providerRoots) {
      const resolvedRoot = await realpath(root).catch(() => null);
      if (resolvedRoot && isWithin(resolvedSource, resolvedRoot)) {
        return resolvedSource;
      }
    }

    if (this.resolveSourcePath) return null;
    const resolvedProject = await realpath(context.projectPath).catch(
      () => null,
    );
    return resolvedProject && isWithin(resolvedSource, resolvedProject)
      ? resolvedSource
      : null;
  }

  private async getWriteRoot(
    projectPath: string,
    sessionId: string,
  ): Promise<string> {
    const root = this.storagePolicy
      ? await this.storagePolicy.ensureWriteDirectory(
          projectPath,
          "tool-results",
          sessionId,
        )
      : await this.ensureFallbackWriteRoot(projectPath, sessionId);
    const boundary =
      this.storagePolicy?.mode === "project"
        ? projectPath
        : (this.storagePolicy?.dataDir ?? this.dataDir);
    if (!boundary || !(await prepareMediaRoot(root, boundary))) {
      throw new Error("Managed media directory escaped its storage root");
    }
    return root;
  }

  private async getReadRoots(
    projectPath: string,
    sessionId: string,
  ): Promise<string[]> {
    const roots: string[] = [];
    if (this.storagePolicy) {
      for (const root of this.storagePolicy.readPaths(
        projectPath,
        "tool-results",
        sessionId,
      )) {
        const boundary = isWithin(root, this.storagePolicy.dataDir)
          ? this.storagePolicy.dataDir
          : projectPath;
        if (await isSafeMediaRoot(boundary, root)) roots.push(root);
      }
    } else {
      const projectRoot = join(projectPath, ".yep", "tool-results", sessionId);
      if (await isSafeProjectMediaRoot(projectPath, projectRoot)) {
        roots.push(projectRoot);
      }
    }
    if (this.dataDir) {
      const fallbackRoot = this.getFallbackRoot(projectPath, sessionId);
      if (
        !roots.includes(fallbackRoot) &&
        (await isSafeMediaRoot(this.dataDir, fallbackRoot))
      ) {
        roots.push(fallbackRoot);
      }
    }
    return roots;
  }

  private getFallbackRoot(projectPath: string, sessionId: string): string {
    const projectKey = createHash("sha256")
      .update(projectPath)
      .digest("hex")
      .slice(0, 32);
    return join(this.dataDir ?? "", "tool-results", projectKey, sessionId);
  }

  private async ensureFallbackWriteRoot(
    projectPath: string,
    sessionId: string,
  ): Promise<string> {
    if (!this.dataDir) throw new Error("Tool media storage is unavailable");
    const fallback = this.getFallbackRoot(projectPath, sessionId);
    await rejectSymlink(join(this.dataDir, "tool-results"));
    await rejectSymlink(dirname(fallback));
    await rejectSymlink(fallback);
    await rejectSymlink(join(fallback, "blobs"));
    await rejectSymlink(join(fallback, "records"));
    await mkdir(fallback, { recursive: true });
    return fallback;
  }

  private rememberTransient(
    entry: ToolResultMediaCatalogEntry,
    bytes: Buffer,
  ): void {
    if (bytes.length > this.transientMediaMaxBytes) return;
    const existing = this.transientMedia.get(entry.id);
    if (existing) this.transientMediaBytes -= existing.bytes.length;
    this.transientMedia.set(entry.id, {
      ...entry,
      bytes,
      lastAccessedAt: Date.now(),
    });
    this.transientMediaBytes += bytes.length;
    this.unregisterTransientSweep ??= registerIdleSweep(() =>
      this.pruneTransient(),
    );
    this.pruneTransient();
  }

  private forgetTransient(id: string): void {
    const existing = this.transientMedia.get(id);
    if (!existing) return;
    this.transientMedia.delete(id);
    this.transientMediaBytes -= existing.bytes.length;
  }

  private pruneTransient(): void {
    const expiresBefore = Date.now() - this.transientMediaTtlMs;
    for (const [id, entry] of this.transientMedia) {
      if (
        entry.lastAccessedAt >= expiresBefore &&
        this.transientMediaBytes <= this.transientMediaMaxBytes
      ) {
        break;
      }
      this.transientMedia.delete(id);
      this.transientMediaBytes -= entry.bytes.length;
    }
    if (this.transientMedia.size === 0) {
      this.unregisterTransientSweep?.();
      this.unregisterTransientSweep = null;
    }
  }
}

function decodeImageDataUrl(
  dataUrl: string,
  maxBytes: number,
): { bytes: Buffer } | { reason: ToolResultMediaRejectionReason } {
  const commaIndex = dataUrl.indexOf(",");
  if (commaIndex <= 5) return { reason: "invalid-image-data" };
  const header = dataUrl.slice(5, commaIndex);
  const parts = header.split(";");
  const mimeType = parts[0]?.trim().toLowerCase();
  if (
    !mimeType?.startsWith("image/") ||
    !parts.some((part) => part.trim().toLowerCase() === "base64")
  ) {
    return { reason: "invalid-image-data" };
  }

  const payload = dataUrl.slice(commaIndex + 1).replace(/\s+/g, "");
  if (
    payload.length === 0 ||
    payload.length % 4 === 1 ||
    !/^[A-Za-z0-9+/_-]*={0,2}$/.test(payload)
  ) {
    return { reason: "invalid-image-data" };
  }
  const estimatedBytes = Math.floor((payload.length * 3) / 4);
  if (estimatedBytes > maxBytes + 2) return { reason: "too-large" };

  const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
  const bytes = Buffer.from(normalized, "base64");
  if (bytes.length > maxBytes) return { reason: "too-large" };
  if (bytes.length === 0) return { reason: "invalid-image-data" };
  return { bytes };
}

function looksLikeVideoPath(
  sourcePath: string | undefined,
  filename: string | undefined,
): boolean {
  const name = (filename ?? sourcePath ?? "").toLowerCase();
  return name.endsWith(".mp4") || name.endsWith(".m4v");
}

function validateMedia(bytes: Buffer): ValidatedMedia | null {
  const detected = detectImage(bytes) ?? detectMp4(bytes);
  if (!detected) return null;
  return {
    bytes,
    contentHash: createHash("sha256").update(bytes).digest("hex"),
    ...detected,
  };
}

function detectMp4(
  bytes: Buffer,
): Omit<ValidatedMedia, "bytes" | "contentHash"> | null {
  if (bytes.length < 8 || bytes.subarray(4, 8).toString("ascii") !== "ftyp") {
    return null;
  }
  return { extension: "mp4", mimeType: "video/mp4" };
}

function detectImage(
  bytes: Buffer,
): Omit<ValidatedMedia, "bytes" | "contentHash"> | null {
  if (
    bytes.length >= 24 &&
    bytes
      .subarray(0, 8)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) &&
    bytes.subarray(12, 16).toString("ascii") === "IHDR"
  ) {
    const width = bytes.readUInt32BE(16);
    const height = bytes.readUInt32BE(20);
    if (width === 0 || height === 0) return null;
    return { extension: "png", mimeType: "image/png", width, height };
  }

  if (
    bytes.length >= 10 &&
    (bytes.subarray(0, 6).toString("ascii") === "GIF87a" ||
      bytes.subarray(0, 6).toString("ascii") === "GIF89a")
  ) {
    const width = bytes.readUInt16LE(6);
    const height = bytes.readUInt16LE(8);
    if (width === 0 || height === 0) return null;
    return { extension: "gif", mimeType: "image/gif", width, height };
  }

  const jpegDimensions = readJpegDimensions(bytes);
  if (jpegDimensions) {
    return {
      extension: "jpg",
      mimeType: "image/jpeg",
      ...jpegDimensions,
    };
  }

  const webpDimensions = readWebpDimensions(bytes);
  if (webpDimensions !== null) {
    return {
      extension: "webp",
      mimeType: "image/webp",
      ...webpDimensions,
    };
  }

  return null;
}

function readJpegDimensions(
  bytes: Buffer,
): { width: number; height: number } | null {
  if (
    bytes.length < 4 ||
    bytes[0] !== 0xff ||
    bytes[1] !== 0xd8 ||
    bytes[2] !== 0xff
  ) {
    return null;
  }

  let offset = 2;
  while (offset + 3 < bytes.length) {
    while (offset < bytes.length && bytes[offset] === 0xff) offset++;
    const marker = bytes[offset];
    offset++;
    if (marker === undefined || marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.length) break;
    const segmentLength = bytes.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > bytes.length) break;
    if (
      ((marker >= 0xc0 && marker <= 0xc3) ||
        (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) ||
        (marker >= 0xcd && marker <= 0xcf)) &&
      segmentLength >= 7
    ) {
      const height = bytes.readUInt16BE(offset + 3);
      const width = bytes.readUInt16BE(offset + 5);
      return width > 0 && height > 0 ? { width, height } : null;
    }
    offset += segmentLength;
  }
  return null;
}

function readWebpDimensions(
  bytes: Buffer,
): { width: number; height: number } | null {
  if (
    bytes.length < 16 ||
    bytes.subarray(0, 4).toString("ascii") !== "RIFF" ||
    bytes.subarray(8, 12).toString("ascii") !== "WEBP"
  ) {
    return null;
  }

  const chunk = bytes.subarray(12, 16).toString("ascii");
  if (chunk === "VP8X" && bytes.length >= 30) {
    return {
      width: 1 + bytes.readUIntLE(24, 3),
      height: 1 + bytes.readUIntLE(27, 3),
    };
  }
  if (chunk === "VP8L" && bytes.length >= 25 && bytes[20] === 0x2f) {
    const bits = bytes.readUInt32LE(21);
    return {
      width: 1 + (bits & 0x3fff),
      height: 1 + ((bits >> 14) & 0x3fff),
    };
  }
  if (chunk === "VP8 " && bytes.length >= 30) {
    const width = bytes.readUInt16LE(26) & 0x3fff;
    const height = bytes.readUInt16LE(28) & 0x3fff;
    return width > 0 && height > 0 ? { width, height } : null;
  }
  return null;
}

function mediaIdFor(input: {
  provider: ProviderName;
  projectId: UrlProjectId;
  sessionId: string;
  toolCallId: string;
  mediaIndex: number;
  contentHash: string;
}): string {
  return createHash("sha256")
    .update(
      [
        input.provider,
        input.projectId,
        input.sessionId,
        input.toolCallId,
        String(input.mediaIndex),
        input.contentHash,
      ].join("\0"),
    )
    .digest("base64url");
}

async function atomicWriteIfAbsent(
  path: string,
  bytes: Buffer,
  contentHash: string,
): Promise<void> {
  const existing = await stat(path).catch(() => null);
  if (
    existing?.isFile() &&
    existing.size === bytes.length &&
    (await fileMatchesContentHash(path, contentHash))
  ) {
    return;
  }
  await atomicWrite(path, bytes);
}

async function fileMatchesContentHash(
  path: string,
  expectedHash: string,
): Promise<boolean> {
  const hash = createHash("sha256");
  try {
    for await (const chunk of createReadStream(path)) {
      hash.update(chunk);
    }
    return hash.digest("hex") === expectedHash;
  } catch {
    return false;
  }
}

async function atomicWrite(path: string, bytes: Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = join(
    dirname(path),
    `.${basename(path)}.${randomUUID()}.tmp`,
  );
  await writeFile(tempPath, bytes, { flag: "wx", mode: 0o600 });
  try {
    await rename(tempPath, path);
  } finally {
    await unlink(tempPath).catch(() => {});
  }
}

async function rejectSymlink(path: string): Promise<void> {
  const stats = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (stats?.isSymbolicLink()) {
    throw new Error(`Refusing symlinked media directory: ${path}`);
  }
}

async function isSafeProjectMediaRoot(
  projectPath: string,
  root: string,
): Promise<boolean> {
  try {
    await rejectSymlink(join(projectPath, ".yep"));
    await rejectSymlink(join(projectPath, ".yep", "tool-results"));
    await rejectSymlink(root);
    return await isSafeMediaRoot(projectPath, root);
  } catch {
    return false;
  }
}

async function prepareMediaRoot(
  root: string,
  containingDirectory: string,
): Promise<boolean> {
  await rejectSymlink(root);
  await rejectSymlink(join(root, "blobs"));
  await rejectSymlink(join(root, "records"));
  await mkdir(join(root, "blobs"), { recursive: true });
  await mkdir(join(root, "records"), { recursive: true });
  return isSafeMediaRoot(containingDirectory, root);
}

async function isSafeMediaRoot(
  containingDirectory: string,
  root: string,
): Promise<boolean> {
  try {
    await rejectSymlink(root);
    await rejectSymlink(join(root, "blobs"));
    await rejectSymlink(join(root, "records"));
    const [resolvedContaining, resolvedRoot, resolvedBlobs, resolvedRecords] =
      await Promise.all([
        realpath(containingDirectory),
        realpath(root),
        realpath(join(root, "blobs")),
        realpath(join(root, "records")),
      ]);
    return (
      isWithin(resolvedRoot, resolvedContaining) &&
      isWithin(resolvedBlobs, resolvedRoot) &&
      isWithin(resolvedRecords, resolvedRoot)
    );
  } catch {
    return false;
  }
}

function isWithin(path: string, directory: string): boolean {
  const rel = relative(directory, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`));
}

function isSafeSegment(value: string): boolean {
  return value.length > 0 && SAFE_SEGMENT_RE.test(value);
}

function safeDisplayFilename(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const name = value
    .split(/[\\/]/)
    .at(-1)
    ?.split("")
    .filter((character) => {
      const code = character.charCodeAt(0);
      return code >= 0x20 && code !== 0x7f;
    })
    .join("")
    .trim()
    .slice(0, 255);
  return name || undefined;
}

function safeClaimedMimeType(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized && /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(normalized)
    ? normalized
    : undefined;
}

function extensionForMimeType(
  mimeType: string,
): ValidatedMedia["extension"] | null {
  switch (mimeType) {
    case "image/gif":
      return "gif";
    case "image/jpeg":
      return "jpg";
    case "image/png":
      return "png";
    case "image/webp":
      return "webp";
    case "video/mp4":
      return "mp4";
    default:
      return null;
  }
}

async function readCatalogEntry(
  path: string,
): Promise<ToolResultMediaCatalogEntry | null> {
  try {
    const stats = await lstat(path);
    if (!stats.isFile()) return null;
    const value = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (!isRecord(value)) return null;
    if (
      value.version !== STORE_VERSION ||
      typeof value.id !== "string" ||
      !MEDIA_ID_RE.test(value.id) ||
      typeof value.provider !== "string" ||
      typeof value.projectId !== "string" ||
      typeof value.sessionId !== "string" ||
      typeof value.toolCallId !== "string" ||
      typeof value.mediaIndex !== "number" ||
      typeof value.mimeType !== "string" ||
      typeof value.byteLength !== "number" ||
      typeof value.contentHash !== "string" ||
      !CONTENT_HASH_RE.test(value.contentHash)
    ) {
      return null;
    }
    if (!extensionForMimeType(value.mimeType)) return null;
    return value as unknown as ToolResultMediaCatalogEntry;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
