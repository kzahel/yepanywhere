import type { Stats } from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { CodexSessionMetaEntry } from "@yep-anywhere/shared";
import {
  SessionDiscoveryIndex,
  type SessionDiscoveryIndexRegistry,
  type SessionDiscoveryRecord,
  type SessionDiscoverySourceFingerprint,
} from "../indexes/SessionDiscoveryIndex.js";
import {
  type CodexRolloutDiscoveryIdentity,
  getCodexRolloutActivityTimeMs,
  getCodexRolloutDiscoveryIdentity,
} from "../utils/codexRolloutFiles.js";
import { isZstdJsonlSupported, readFirstLine } from "../utils/jsonl.js";

export const CODEX_META_READ_MAX_BYTES = 1024 * 1024;

export interface CodexRolloutDiscoveryMetadata {
  id: string;
  cwd: string;
  timestamp: string;
  isSubagent: boolean;
}

export interface CodexDiscoveredSession {
  id: string;
  cwd: string;
  filePath: string;
  timestamp: string;
  mtime: number;
  size: number;
  isSubagent: boolean;
}

export interface CodexRolloutDiscoveryStats {
  statCalls: number;
  activeWindowSkips: number;
  discoveryIndexDisabled: number;
  discoveryIndexHits: number;
  discoveryIndexMisses: number;
  discoveryIndexSuspect: number;
  discoveryIndexRefreshes: number;
  representationTransitions: number;
  cacheBackedCompressedReads: number;
  firstLineReadsPlain: number;
  firstLineReadsZstd: number;
  zstdUnsupported: number;
  metadataReadFailures: number;
}

export interface ReadCodexRolloutMetadataOptions {
  sessionsDir: string;
  filePath: string;
  discoveryIndex?: SessionDiscoveryIndex;
  activeAfterMs?: number;
  maxBytes?: number;
  metrics?: CodexRolloutDiscoveryStats;
}

export function createCodexSessionDiscoveryIndex(
  dataDir: string | undefined,
  sessionsDir: string,
  registry?: SessionDiscoveryIndexRegistry,
): SessionDiscoveryIndex | undefined {
  if (!dataDir) return undefined;
  const options = {
    baseDir: join(dataDir, "indexes", "session-discovery"),
    provider: "codex",
    sourceRoot: sessionsDir,
  };
  return registry
    ? registry.getOrCreate(options)
    : new SessionDiscoveryIndex(options);
}

export function createCodexRolloutDiscoveryStats(): CodexRolloutDiscoveryStats {
  return {
    statCalls: 0,
    activeWindowSkips: 0,
    discoveryIndexDisabled: 0,
    discoveryIndexHits: 0,
    discoveryIndexMisses: 0,
    discoveryIndexSuspect: 0,
    discoveryIndexRefreshes: 0,
    representationTransitions: 0,
    cacheBackedCompressedReads: 0,
    firstLineReadsPlain: 0,
    firstLineReadsZstd: 0,
    zstdUnsupported: 0,
    metadataReadFailures: 0,
  };
}

export async function readCodexRolloutMetadata(
  options: ReadCodexRolloutMetadataOptions,
): Promise<CodexDiscoveredSession | null> {
  const metrics = options.metrics;
  if (metrics) metrics.statCalls += 1;
  const stats = await stat(options.filePath);
  const activityTimeMs = getCodexRolloutActivityTimeMs(options.filePath, stats);
  if (options.activeAfterMs && activityTimeMs < options.activeAfterMs) {
    if (metrics) metrics.activeWindowSkips += 1;
    return null;
  }

  const identity = getCodexRolloutDiscoveryIdentity(
    options.sessionsDir,
    options.filePath,
  );
  if (identity.representation === "zstd" && !isZstdJsonlSupported()) {
    if (metrics) metrics.zstdUnsupported += 1;
    return null;
  }

  const sourceFingerprint = sourceFingerprintFromStats(stats);
  const cached =
    await options.discoveryIndex?.getRecord<CodexRolloutDiscoveryMetadata>(
      identity.shardKey,
      identity.key,
    );
  if (!options.discoveryIndex) {
    if (metrics) metrics.discoveryIndexDisabled += 1;
  } else if (!cached) {
    if (metrics) metrics.discoveryIndexMisses += 1;
  }
  if (
    cached &&
    isCachedRecordUsable(cached, identity, stats, sourceFingerprint)
  ) {
    if (metrics) metrics.discoveryIndexHits += 1;
    if (shouldRefreshCachedRecord(cached, identity, stats, sourceFingerprint)) {
      if (metrics) metrics.discoveryIndexRefreshes += 1;
      if (cached.representation !== identity.representation) {
        if (metrics) metrics.representationTransitions += 1;
      }
      await options.discoveryIndex?.upsertRecord(identity.shardKey, {
        key: identity.key,
        relativePath: identity.relativePath,
        representation: identity.representation,
        metadata: cached.metadata,
        metadataByteLength: cached.metadataByteLength,
        fileSize: stats.size,
        fileMtimeMs: activityTimeMs,
        sourceFingerprint,
      });
    }
    if (identity.representation === "zstd") {
      if (metrics) metrics.cacheBackedCompressedReads += 1;
    }
    return toDiscoveredSession(cached.metadata, options.filePath, stats);
  }
  if (cached) {
    if (metrics) metrics.discoveryIndexSuspect += 1;
  }

  if (identity.representation === "zstd") {
    if (metrics) metrics.firstLineReadsZstd += 1;
  } else {
    if (metrics) metrics.firstLineReadsPlain += 1;
  }
  let firstLine: string | null;
  try {
    firstLine = await readFirstLine(
      options.filePath,
      options.maxBytes ?? CODEX_META_READ_MAX_BYTES,
    );
  } catch (error) {
    if (metrics) metrics.metadataReadFailures += 1;
    throw error;
  }
  if (!firstLine) {
    if (metrics) metrics.metadataReadFailures += 1;
    return null;
  }

  const metadata = parseCodexSessionMeta(firstLine, stats);
  if (!metadata) {
    if (metrics) metrics.metadataReadFailures += 1;
    return null;
  }

  await options.discoveryIndex?.upsertRecord(identity.shardKey, {
    key: identity.key,
    relativePath: identity.relativePath,
    representation: identity.representation,
    metadata,
    metadataByteLength: Buffer.byteLength(firstLine, "utf-8") + 1,
    fileSize: stats.size,
    fileMtimeMs: activityTimeMs,
    sourceFingerprint,
  });

  return toDiscoveredSession(metadata, options.filePath, stats);
}

function isCachedRecordUsable(
  record: SessionDiscoveryRecord<CodexRolloutDiscoveryMetadata>,
  identity: CodexRolloutDiscoveryIdentity,
  stats: Stats,
  sourceFingerprint: SessionDiscoverySourceFingerprint,
): boolean {
  if (!isCodexRolloutDiscoveryMetadata(record.metadata)) return false;
  const representationChanged =
    record.representation !== identity.representation;
  if (
    !representationChanged &&
    hasSourceFingerprintChanged(record.sourceFingerprint, sourceFingerprint)
  ) {
    return false;
  }
  // Size growth does not prove append-only writes (restore/sync may rewrite
  // the header). Revalidate just the bounded first line on source changes.
  if (
    !representationChanged &&
    (record.fileSize !== stats.size ||
      record.fileMtimeMs !==
        getCodexRolloutActivityTimeMs(identity.relativePath, stats))
  ) {
    return false;
  }

  if (identity.representation === "zstd") {
    if (record.representation === "zstd") {
      return record.fileSize === stats.size;
    }
    return true;
  }

  const minExpectedSize =
    record.representation === identity.representation
      ? Math.max(record.metadataByteLength, record.fileSize)
      : record.metadataByteLength;
  return stats.size >= minExpectedSize;
}

function shouldRefreshCachedRecord(
  record: SessionDiscoveryRecord<CodexRolloutDiscoveryMetadata>,
  identity: CodexRolloutDiscoveryIdentity,
  stats: Stats,
  sourceFingerprint: SessionDiscoverySourceFingerprint,
): boolean {
  if (record.relativePath !== identity.relativePath) return true;
  if (record.representation !== identity.representation) return true;
  if (!record.sourceFingerprint && hasSourceFingerprint(sourceFingerprint)) {
    return true;
  }
  return identity.representation === "zstd" && record.fileSize !== stats.size;
}

function sourceFingerprintFromStats(
  stats: Stats,
): SessionDiscoverySourceFingerprint {
  const fingerprint: SessionDiscoverySourceFingerprint = {};
  if (Number.isFinite(stats.dev)) fingerprint.dev = stats.dev;
  if (Number.isFinite(stats.ino)) fingerprint.ino = stats.ino;
  if (Number.isFinite(stats.birthtimeMs)) {
    fingerprint.birthtimeMs = stats.birthtimeMs;
  }
  return fingerprint;
}

function hasSourceFingerprint(
  fingerprint: SessionDiscoverySourceFingerprint | undefined,
): boolean {
  return (
    fingerprint !== undefined &&
    (fingerprint.dev !== undefined ||
      fingerprint.ino !== undefined ||
      fingerprint.birthtimeMs !== undefined)
  );
}

function hasSourceFingerprintChanged(
  previous: SessionDiscoverySourceFingerprint | undefined,
  current: SessionDiscoverySourceFingerprint,
): boolean {
  if (!previous) return false;
  return (
    fingerprintFieldChanged(previous.dev, current.dev) ||
    fingerprintFieldChanged(previous.ino, current.ino) ||
    fingerprintFieldChanged(previous.birthtimeMs, current.birthtimeMs)
  );
}

function fingerprintFieldChanged(
  previous: number | undefined,
  current: number | undefined,
): boolean {
  return (
    previous !== undefined && current !== undefined && previous !== current
  );
}

function toDiscoveredSession(
  metadata: CodexRolloutDiscoveryMetadata,
  filePath: string,
  stats: Stats,
): CodexDiscoveredSession {
  return {
    id: metadata.id,
    cwd: metadata.cwd,
    filePath,
    timestamp: metadata.timestamp,
    mtime: getCodexRolloutActivityTimeMs(filePath, stats),
    size: stats.size,
    isSubagent: metadata.isSubagent,
  };
}

function parseCodexSessionMeta(
  firstLine: string,
  stats: Stats,
): CodexRolloutDiscoveryMetadata | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(firstLine) as unknown;
  } catch {
    return null;
  }

  if (!isObjectRecord(parsed)) return null;
  if (parsed.type !== "session_meta") return null;
  if (!isObjectRecord(parsed.payload)) return null;

  const meta = parsed.payload as Partial<CodexSessionMetaEntry["payload"]>;
  if (typeof meta.id !== "string" || typeof meta.cwd !== "string") {
    return null;
  }

  return {
    id: meta.id,
    cwd: meta.cwd,
    timestamp:
      typeof meta.timestamp === "string"
        ? meta.timestamp
        : new Date(stats.mtimeMs).toISOString(),
    isSubagent: isSubagentSessionMeta(meta),
  };
}

export function isSubagentSessionMeta(
  meta: Partial<CodexSessionMetaEntry["payload"]>,
): boolean {
  if (hasNonEmptyString(meta.parent_thread_id)) {
    return true;
  }

  if (isStructuredThreadSpawnSource(meta.source)) {
    return true;
  }

  if (isSubagentSourceString(meta.thread_source)) {
    return true;
  }

  return false;
}

function isStructuredThreadSpawnSource(source: unknown): boolean {
  if (!isObjectRecord(source)) {
    return false;
  }

  const subagent = source.subagent;
  if (!isObjectRecord(subagent)) {
    return false;
  }

  const threadSpawn = subagent.thread_spawn;
  if (!isObjectRecord(threadSpawn)) {
    return false;
  }

  return hasNonEmptyString(threadSpawn.parent_thread_id);
}

function isSubagentSourceString(value: unknown): boolean {
  return (
    typeof value === "string" &&
    /(?:subagent|thread[_-]?spawn)/i.test(value.trim())
  );
}

function hasNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isCodexRolloutDiscoveryMetadata(
  value: unknown,
): value is CodexRolloutDiscoveryMetadata {
  if (!isObjectRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    typeof value.cwd === "string" &&
    typeof value.timestamp === "string" &&
    typeof value.isSubagent === "boolean"
  );
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
