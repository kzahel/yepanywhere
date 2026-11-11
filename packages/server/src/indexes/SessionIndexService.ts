/**
 * SessionIndexService caches session summaries to avoid re-parsing session files.
 * Uses mtime/size for cache invalidation - only re-parses when files change.
 *
 * Summaries live in SQLite. Legacy `indexes/*.json` scopes are deleted, not
 * imported: they are rebuildable from provider transcripts.
 *
 * Supports any provider whose reader implements ISessionReader. For providers
 * where session IDs can't be derived from filenames (e.g., Gemini), the reader
 * must implement the optional `listSessionFiles()` method.
 */

import type { Dirent, Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  DEFAULT_PROVIDER,
  type ProviderName,
  type UrlProjectId,
} from "@yep-anywhere/shared";
import { createLruMap, refreshLruMap } from "../lib/lruCollections.js";
import { getLogger } from "../logging/logger.js";
import { getProjectIdentityKey } from "../projects/paths.js";
import {
  type CodexRolloutDiscoveryMetadata,
  readCodexRolloutMetadata,
} from "../sessions/codex-discovery.js";
import type { ISessionReader } from "../sessions/types.js";
import type { SessionSummary } from "../supervisor/types.js";
import {
  getCodexRolloutDiscoveryIdentity,
  getCodexRolloutSessionId,
} from "../utils/codexRolloutFiles.js";
import type { EventBus, FileChangeEvent } from "../watcher/index.js";
import {
  SessionDiscoveryIndexRegistry,
  type SessionDiscoveryIndex,
} from "./SessionDiscoveryIndex.js";
import type { ISessionIndexService, SessionIndexListOptions } from "./types.js";
import type { SqliteDatabase } from "../storage/sqlite.js";
import { SqliteSessionSummaryIndex } from "./SqliteSessionSummaryIndex.js";
import { agentApiSummaryTitle } from "../sessions/agent-api-title.js";

const LOG_CACHE_PERF = process.env.SESSION_INDEX_LOG_PERF === "true";
const DEFAULT_SUMMARY_PARSE_CONCURRENCY = 1;
const DEFAULT_WARMUP_PROGRESS_LOG_INTERVAL_MS = 5000;

export interface CachedSessionSummary {
  title: string | null;
  fullTitle: string | null;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  contextUsage?: { inputTokens: number; percentage: number };
  /** File size in bytes at time of indexing */
  indexedBytes: number;
  /** File mtime in milliseconds since epoch at time of indexing */
  fileMtime: number;
  /** True if session has no user/assistant messages (metadata-only file) */
  isEmpty?: boolean;
  /** AI provider for this session */
  provider: ProviderName;
  /** Model used for this session (e.g. "gemini-2.5-pro") */
  model?: string;
  /** Interactive Mother session for a YA-owned `/btw` aside. */
  parentSessionId?: string;
  parentSessionKind?: "btw-aside";
  /** Source session whose provider transcript was cloned or forked. */
  forkedFromSessionId?: string;
  /** Capped excerpt of the most recent visible agent turn or provider recap. */
  lastAgentText?: string;
  asyncQuestions?: SessionSummary["asyncQuestions"];
}

export interface SessionIndexState {
  version: 5;
  projectId: string;
  sessions: Record<string, CachedSessionSummary>;
}

// This version gates every provider's persisted summary index, and also dates
// the entries an index holds so a one-shot repair can name the readers it
// corrects. Bump it for an incompatible on-disk shape, or to end such a
// repair; do not bump it for provider-specific interpretation changes that
// can correct gradually as sessions are modified.
const CURRENT_VERSION = 5;
// Predecessors with the same on-disk shape, accepted so an install that wrote
// one keeps its index: 3 shipped, 4 was an unshipped semantic cachebuster, and
// 5 only records that `isEmpty` entries were written by a reader that means
// them. A rollback to a build predating 5 pays one rebuild.
const STRUCTURALLY_COMPATIBLE_VERSIONS: ReadonlySet<number> = new Set([
  3,
  4,
  CURRENT_VERSION,
]);
// Indexes written before this version may hold `isEmpty: true` for a
// setup-only Claude session that current readers summarize.
const CLAUDE_EMPTY_SUMMARY_REPAIR_VERSION = 5;
const CLAUDE_LOCAL_COMMAND_CAVEAT_TITLE_PREFIX = "<local-command-caveat>";

function needsClaudeSummaryRefresh(
  summary: CachedSessionSummary,
  persistedVersion: number,
): boolean {
  if (
    summary.provider !== DEFAULT_PROVIDER &&
    summary.provider !== "claude-gateway" &&
    summary.provider !== "claude-ollama"
  ) {
    return false;
  }
  // Older readers treated setup-only Claude sessions as absent. Reparse those
  // negative cache entries so existing sessions can open without a file change.
  // Current writers still record genuine emptiness, so the repair is keyed on
  // the version that wrote the entry: keyed on the field, it would delete and
  // reparse every unreadable Claude transcript on every load, forever.
  if (
    summary.isEmpty &&
    persistedVersion < CLAUDE_EMPTY_SUMMARY_REPAIR_VERSION
  ) {
    return true;
  }
  const fullTitle = summary.fullTitle ?? summary.title;
  return (
    fullTitle
      ?.trimStart()
      .startsWith(CLAUDE_LOCAL_COMMAND_CAVEAT_TITLE_PREFIX) ?? false
  );
}

function migrateCachedForkLineage(summary: CachedSessionSummary): boolean {
  if (!summary.parentSessionId || summary.parentSessionKind) {
    return false;
  }
  // Provider summaries never owned the interactive `/btw` Mother link. Before
  // the lineage split, Codex `forked_from_id` was cached in parentSessionId.
  // Returns whether the summary changed.
  summary.forkedFromSessionId ??= summary.parentSessionId;
  delete summary.parentSessionId;
  return true;
}

const PROJECT_SCANNER_CACHE_FILE = "project-scanner-cache.json";

/** A top-level `indexes/` name the pre-SQLite JSON writer could have used. */
function isLegacyScopeFileName(name: string): boolean {
  return name.endsWith(".json") && name !== PROJECT_SCANNER_CACHE_FILE;
}

/** `<scope>.json.tmp-<pid>-<time>-<random>` left by an interrupted write. */
function isLegacyScopeTempFileName(name: string): boolean {
  const marker = name.lastIndexOf(".json.tmp-");
  return (
    marker > 0 && isLegacyScopeFileName(name.slice(0, marker + ".json".length))
  );
}

/** `<scope>.json.lock` directory left by a crashed writer. */
function isLegacyScopeLockName(name: string): boolean {
  return (
    name.endsWith(".json.lock") &&
    isLegacyScopeFileName(name.slice(0, -".lock".length))
  );
}

function isLegacySummaryScope(content: Buffer): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content.toString("utf-8"));
  } catch {
    return false;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    return false;
  const scope = parsed as Record<string, unknown>;
  return (
    typeof scope.version === "number" &&
    typeof scope.projectId === "string" &&
    typeof scope.sessions === "object" &&
    scope.sessions !== null &&
    !Array.isArray(scope.sessions)
  );
}

interface SessionIndexLargestCacheMiss {
  sessionId: string;
  filePath: string;
  size: number;
  mtime: number;
}

interface SessionIndexPerfDetails {
  scopeKey?: string;
  validationKey?: string;
  indexedSessions?: number;
  dirtySessions?: number;
  totalFiles?: number;
  cacheHits?: number;
  cacheMisses?: number;
  cacheMissBytes?: number;
  largestCacheMisses?: SessionIndexLargestCacheMiss[];
  /** Response served from the existing index while a background walk runs. */
  staleWhileRevalidate?: boolean;
  /** Full validation ran in the background, not on a request. */
  background?: boolean;
}

type SessionIndexWarmupJobStatus = "running" | "completed" | "failed";

export interface SessionIndexWarmupJobSnapshot {
  key: string;
  status: SessionIndexWarmupJobStatus;
  scopeKey: string;
  validationKey: string;
  sessionDir: string;
  projectId: UrlProjectId;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  elapsedMs: number;
  totalFiles: number;
  completedFiles: number;
  cacheHits: number;
  cacheMisses: number;
  cacheMissBytes: number;
  parsedBytes: number;
  parseCalls: number;
  activeParses: number;
  queuedParses: number;
  coalescedParses: number;
  lastSessionId?: string;
  lastFilePath?: string;
  error?: string;
}

export interface SessionIndexWarmupStatusSnapshot {
  summaryParseConcurrency: number;
  activeParses: number;
  queuedParses: number;
  activeJobs: SessionIndexWarmupJobSnapshot[];
  recentJobs: SessionIndexWarmupJobSnapshot[];
}

interface SessionIndexWarmupJobState {
  key: string;
  status: SessionIndexWarmupJobStatus;
  scopeKey: string;
  validationKey: string;
  sessionDir: string;
  projectId: UrlProjectId;
  startedAtMs: number;
  updatedAtMs: number;
  completedAtMs?: number;
  lastLoggedAtMs: number;
  totalFiles: number;
  completedFiles: number;
  cacheHits: number;
  cacheMisses: number;
  cacheMissBytes: number;
  parsedBytes: number;
  parseCalls: number;
  activeParses: number;
  queuedParses: number;
  coalescedParses: number;
  lastSessionId?: string;
  lastFilePath?: string;
  error?: string;
}

interface SummaryParseTask {
  key: string;
  jobKey: string;
  sessionId: string;
  filePath: string;
  size: number;
  run: () => Promise<SessionSummary | null>;
  resolve: (summary: SessionSummary | null) => void;
  reject: (error: unknown) => void;
}

export interface SessionIndexServiceOptions {
  /** Shared server database that holds the summary index. */
  database: SqliteDatabase;
  /**
   * Index state directory (defaults to ~/.yep-anywhere/indexes). Holds the
   * discovery shards; legacy JSON summary scopes found here are deleted.
   */
  dataDir?: string;
  /** Claude projects directory (defaults to ~/.claude/projects) */
  projectsDir?: string;
  /** Max number of project scopes to keep in memory (default: 10,000) */
  maxCacheSize?: number;
  /**
   * Interval in ms between full directory validations.
   * 0 disables fast-path and validates every request.
   */
  fullValidationIntervalMs?: number;
  /** Optional event bus for watcher-driven invalidation. */
  eventBus?: EventBus;
  /** Max concurrent summary parses across all session-index scopes. */
  summaryParseConcurrency?: number;
  /** Interval for active cold-index progress logs. */
  warmupProgressLogIntervalMs?: number;
  /** Shared process owner for provider discovery shards. */
  sessionDiscoveryIndexRegistry?: SessionDiscoveryIndexRegistry;
}

/** Provider summary validation, durable selected-row reads, and bounded hot scopes. */
export class SessionIndexService implements ISessionIndexService {
  private readonly summaryStore: SqliteSessionSummaryIndex;
  private dataDir: string;
  private projectsDir: string;
  /** Least recently used first; bounded by `maxCacheSize` scopes. */
  private indexCache = createLruMap<string, SessionIndexState>();
  private indexLoadPromises: Map<string, Promise<SessionIndexState>> =
    new Map();
  private savePromises: Map<string, Promise<void>> = new Map();
  private pendingSaves: Set<string> = new Set();
  private maxCacheSize: number;
  private fullValidationIntervalMs: number;
  private summaryParseConcurrency: number;
  private warmupProgressLogIntervalMs: number;
  private lastFullValidationAt: Map<string, number> = new Map();
  private dirtyDirs: Set<string> = new Set();
  private dirtySessionsByDir: Map<string, Set<string>> = new Map();
  /**
   * Per-scope dirty revisions, drawn from one process-wide counter so a
   * revision never repeats after a scope's entry is deleted on eviction.
   */
  private dirtyRevisions: Map<string, number> = new Map();
  private lastDirtyRevision = 0;
  /** Scopes with a persisted SQL index (loaded or written this run). */
  private persistedIndexScopes: Set<string> = new Set();
  /** In-flight background full validations, keyed by validation key. */
  private backgroundValidations: Map<string, Promise<void>> = new Map();
  /** Serializes background validations to bound concurrent I/O. */
  private backgroundValidationChain: Promise<void> = Promise.resolve();
  private inFlightSessionLoads: Map<string, Promise<SessionSummary[]>> =
    new Map();
  private inFlightSessionSummaryLoads: Map<
    string,
    Promise<SessionSummary | null>
  > = new Map();
  private inFlightTitleLoads: Map<string, Promise<string | null>> = new Map();
  private inFlightSummaryParses: Map<string, Promise<SessionSummary | null>> =
    new Map();
  private sessionDiscoveryIndexRegistry: SessionDiscoveryIndexRegistry;
  private summaryParseQueue: SummaryParseTask[] = [];
  private activeSummaryParses = 0;
  private warmupJobs: Map<string, SessionIndexWarmupJobState> = new Map();
  private recentWarmupJobs: SessionIndexWarmupJobSnapshot[] = [];
  private warmupProgressTimer: ReturnType<typeof setInterval> | null = null;
  private cacheStats = {
    requests: 0,
    fastHits: 0,
    incrementalRuns: 0,
    fullScans: 0,
    statCalls: 0,
    parseCalls: 0,
    totalDurationMs: 0,
  };
  private unsubscribeEventBus: (() => void) | null = null;
  private eventBus: EventBus | null = null;
  /** One-time removal of legacy JSON summary scopes, started by initialize(). */
  private legacyCleanup: Promise<void> | null = null;

  constructor(options: SessionIndexServiceOptions) {
    this.summaryStore = new SqliteSessionSummaryIndex(options.database);
    const home = process.env.HOME ?? process.env.USERPROFILE ?? ".";
    this.dataDir =
      options.dataDir ?? path.join(home, ".yep-anywhere", "indexes");
    this.projectsDir =
      options.projectsDir ?? path.join(home, ".claude", "projects");
    this.maxCacheSize = options.maxCacheSize ?? 10000;
    this.fullValidationIntervalMs = Math.max(
      0,
      options.fullValidationIntervalMs ?? 0,
    );
    this.summaryParseConcurrency = Math.max(
      1,
      Math.floor(
        options.summaryParseConcurrency ?? DEFAULT_SUMMARY_PARSE_CONCURRENCY,
      ),
    );
    this.warmupProgressLogIntervalMs = Math.max(
      1000,
      options.warmupProgressLogIntervalMs ??
        DEFAULT_WARMUP_PROGRESS_LOG_INTERVAL_MS,
    );
    this.sessionDiscoveryIndexRegistry =
      options.sessionDiscoveryIndexRegistry ??
      new SessionDiscoveryIndexRegistry();

    if (options.eventBus) {
      this.eventBus = options.eventBus;
      this.unsubscribeEventBus = options.eventBus.subscribe((event) => {
        if (event.type !== "file-change") return;
        this.handleFileChange(event);
      });
    }
  }

  private getScopeKey(sessionDir: string, reader?: ISessionReader): string {
    return reader?.getIndexScopeKey?.(sessionDir) ?? sessionDir;
  }

  /** Return a cached index and mark it most recently used. */
  private getCachedIndex(scopeKey: string): SessionIndexState | undefined {
    const cached = this.indexCache.get(scopeKey);
    if (cached) refreshLruMap(this.indexCache, scopeKey, cached);
    return cached;
  }

  /**
   * Evict least recently used entries if cache exceeds max size, with the
   * scope's per-scope bookkeeping. Dirty state is kept: it is semantic and
   * is cleared by the next validation.
   */
  private evictIfNeeded(): void {
    while (this.indexCache.size > this.maxCacheSize) {
      const firstKey = this.indexCache.keys().next().value;
      if (firstKey) {
        this.indexCache.delete(firstKey);
        this.persistedIndexScopes.delete(firstKey);
        for (const key of this.lastFullValidationAt.keys()) {
          if (this.getScopeKeyFromKnownKey(key) === firstKey)
            this.lastFullValidationAt.delete(key);
        }
        if (
          !this.dirtyDirs.has(firstKey) &&
          !this.dirtySessionsByDir.has(firstKey)
        ) {
          this.dirtyRevisions.delete(firstKey);
        }
        getLogger().debug(
          `[SessionIndexService] Evicted cache entry for ${firstKey} (cache size: ${this.indexCache.size})`,
        );
      } else {
        break;
      }
    }
  }

  /**
   * Initialize the service by ensuring the data directory exists. Legacy
   * JSON summary cleanup runs in the background and never blocks startup.
   */
  async initialize(): Promise<void> {
    await fs.mkdir(this.dataDir, { recursive: true });
    this.legacyCleanup ??= this.removeLegacySummaryFiles().catch((error) => {
      getLogger().warn(
        { err: error },
        "[SessionIndexService] Failed to remove legacy JSON summary files",
      );
    });
  }

  /**
   * Delete the JSON summary scopes and writer leftovers that predate SQLite.
   *
   * No import marker is needed: summaries are a cache rebuildable from
   * provider transcripts, and the database is now required, so this JSON is
   * never read again. The directory also holds live non-summary state (the
   * project scanner cache, `git-untracked/`, `session-discovery/`, the file
   * completion repository), so only top-level entries that are recognizably
   * legacy summary scopes are removed.
   */
  private async removeLegacySummaryFiles(): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await fs.readdir(this.dataDir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    let removedCount = 0;
    let removedBytes = 0;
    for (const entry of entries) {
      const entryPath = path.join(this.dataDir, entry.name);
      if (entry.isFile() && isLegacyScopeFileName(entry.name)) {
        // One file at a time: some scopes are several megabytes.
        let content: Buffer;
        try {
          content = await fs.readFile(entryPath);
        } catch {
          continue;
        }
        if (!isLegacySummaryScope(content)) continue;
        await fs.rm(entryPath, { force: true });
        removedCount += 1;
        removedBytes += content.byteLength;
      } else if (entry.isFile() && isLegacyScopeTempFileName(entry.name)) {
        const size = await fs
          .stat(entryPath)
          .then((stats) => stats.size)
          .catch(() => 0);
        await fs.rm(entryPath, { force: true });
        removedCount += 1;
        removedBytes += size;
      } else if (entry.isDirectory() && isLegacyScopeLockName(entry.name)) {
        await fs.rm(entryPath, { recursive: true, force: true });
        removedCount += 1;
      }
    }
    if (removedCount > 0) {
      getLogger().info(
        `[SessionIndexService] Removed ${removedCount} legacy JSON summary entries (${removedBytes} bytes) from ${this.dataDir}`,
      );
    }
  }

  /**
   * Load index from disk or create a new one.
   */
  private async loadIndex(
    sessionDir: string,
    projectId: UrlProjectId,
    reader?: ISessionReader,
  ): Promise<SessionIndexState> {
    const scopeKey = this.getScopeKey(sessionDir, reader);
    const cached = this.getCachedIndex(scopeKey);
    if (cached) return cached;

    const existing = this.indexLoadPromises.get(scopeKey);
    if (existing) return existing;

    const loadPromise = this.loadPersistedIndex(sessionDir, projectId, reader);
    const trackedPromise = loadPromise.finally(() => {
      if (this.indexLoadPromises.get(scopeKey) === trackedPromise) {
        this.indexLoadPromises.delete(scopeKey);
      }
    });
    this.indexLoadPromises.set(scopeKey, trackedPromise);
    return trackedPromise;
  }

  /**
   * Read a scope, storing it again only when it was repaired, upgraded or
   * started fresh: rewriting an unchanged scope rereads and reserializes
   * every row (gap item 4).
   */
  private async loadPersistedIndex(
    sessionDir: string,
    projectId: UrlProjectId,
    reader?: ISessionReader,
  ): Promise<SessionIndexState> {
    const scopeKey = this.getScopeKey(sessionDir, reader);
    const cached = this.indexCache.get(scopeKey);
    if (cached) return cached;

    let loaded: { index: SessionIndexState; stored: boolean } | undefined;
    try {
      const parsed = this.summaryStore.read(scopeKey);

      // A missing scope starts fresh: it is rebuilt from provider files.
      if (
        parsed &&
        STRUCTURALLY_COMPATIBLE_VERSIONS.has(parsed.version) &&
        parsed.projectId === projectId
      ) {
        const index: SessionIndexState = {
          ...parsed,
          version: CURRENT_VERSION,
        };
        loaded = { index, stored: parsed.version === CURRENT_VERSION };
        // Repair only the provider summaries known to violate the current
        // summary contract instead of rebuilding every provider's shared index.
        for (const [sessionId, summary] of Object.entries(index.sessions)) {
          if (migrateCachedForkLineage(summary)) loaded.stored = false;
          if (needsClaudeSummaryRefresh(summary, parsed.version)) {
            delete index.sessions[sessionId];
            this.markSessionDirtyByScopeKey(scopeKey, sessionId);
            loaded.stored = false;
          }
        }
      }
    } catch (error) {
      loaded = undefined;
      getLogger().warn(
        { err: error },
        `[SessionIndexService] Failed to load index for ${scopeKey}, starting fresh`,
      );
    }
    if (loaded) {
      this.indexCache.set(scopeKey, loaded.index);
      this.persistedIndexScopes.add(scopeKey);
      this.evictIfNeeded();
      if (!loaded.stored) this.summaryStore.save(scopeKey, loaded.index);
      return loaded.index;
    }

    // Missing, invalid, version mismatch or different project - start fresh
    const fresh: SessionIndexState = {
      version: CURRENT_VERSION,
      projectId,
      sessions: {},
    };
    this.indexCache.set(scopeKey, fresh);
    this.evictIfNeeded();
    this.summaryStore.save(scopeKey, fresh);
    return fresh;
  }

  /**
   * Save index to disk with debouncing to prevent excessive writes.
   */
  private async saveIndex(
    sessionDir: string,
    reader?: ISessionReader,
    sessionId?: string,
  ): Promise<void> {
    const cacheKey = this.getScopeKey(sessionDir, reader);

    // If a save is in progress, mark that we need another save
    if (this.savePromises.has(cacheKey)) {
      this.pendingSaves.add(cacheKey);
      return;
    }

    const promise = this.doSaveIndex(sessionDir, reader, sessionId);
    this.savePromises.set(cacheKey, promise);

    try {
      await promise;
    } finally {
      this.savePromises.delete(cacheKey);
    }

    // If another save was requested while we were saving, do it now
    if (this.pendingSaves.has(cacheKey)) {
      this.pendingSaves.delete(cacheKey);
      await this.saveIndex(sessionDir, reader);
    }
  }

  private async doSaveIndex(
    sessionDir: string,
    reader?: ISessionReader,
    sessionId?: string,
  ): Promise<void> {
    const scopeKey = this.getScopeKey(sessionDir, reader);
    const index = this.indexCache.get(scopeKey);
    if (!index) return;

    try {
      if (sessionId !== undefined)
        this.summaryStore.saveSummary(scopeKey, index, sessionId);
      else this.summaryStore.save(scopeKey, index);
      this.persistedIndexScopes.add(scopeKey);
    } catch (error) {
      getLogger().error(
        { err: error },
        `[SessionIndexService] Failed to save SQL index for ${scopeKey}`,
      );
      throw error;
    }
  }

  private getScopedLoadKey(
    sessionDir: string,
    projectId: UrlProjectId,
    reader?: ISessionReader,
    options?: SessionIndexListOptions,
  ): string {
    return `${this.getScopeKey(sessionDir, reader)}::${projectId}::activeAfter=${options?.activeAfterMs ?? "all"}`;
  }

  private getValidationKey(
    sessionDir: string,
    reader?: ISessionReader,
    options?: SessionIndexListOptions,
  ): string {
    return `${this.getScopeKey(sessionDir, reader)}::activeAfter=${options?.activeAfterMs ?? "all"}`;
  }

  private getScopeKeyFromKnownKey(key: string): string {
    const marker = "::activeAfter=";
    const markerIndex = key.lastIndexOf(marker);
    return markerIndex === -1 ? key : key.slice(0, markerIndex);
  }

  private getTitleLoadKey(
    sessionDir: string,
    projectId: UrlProjectId,
    sessionId: string,
    reader?: ISessionReader,
  ): string {
    return `${this.getScopeKey(sessionDir, reader)}::${projectId}::${sessionId}`;
  }

  private markSessionDirty(
    sessionDir: string,
    sessionId: string,
    reader?: ISessionReader,
  ): void {
    this.markSessionDirtyByScopeKey(
      this.getScopeKey(sessionDir, reader),
      sessionId,
    );
  }

  private markSessionDirtyByScopeKey(
    scopeKey: string,
    sessionId: string,
  ): void {
    const current = this.dirtySessionsByDir.get(scopeKey) ?? new Set();
    current.add(sessionId);
    this.dirtySessionsByDir.set(scopeKey, current);
    this.advanceDirtyRevision(scopeKey);
  }

  private getDirtyRevision(scopeKey: string): number {
    return this.dirtyRevisions.get(scopeKey) ?? 0;
  }

  private advanceDirtyRevision(scopeKey: string): void {
    this.dirtyRevisions.set(scopeKey, ++this.lastDirtyRevision);
  }

  private clearSessionDirty(
    sessionDir: string,
    sessionId: string,
    reader?: ISessionReader,
    observedRevision?: number,
  ): void {
    const scopeKey = this.getScopeKey(sessionDir, reader);
    if (
      observedRevision !== undefined &&
      this.getDirtyRevision(scopeKey) !== observedRevision
    ) {
      return;
    }
    const dirty = this.dirtySessionsByDir.get(scopeKey);
    if (!dirty) return;
    dirty.delete(sessionId);
    if (dirty.size === 0) {
      this.dirtySessionsByDir.delete(scopeKey);
    }
  }

  private markDirDirty(sessionDir: string, reader?: ISessionReader): void {
    this.markDirDirtyByScopeKey(this.getScopeKey(sessionDir, reader));
  }

  private markDirDirtyByScopeKey(scopeKey: string): void {
    this.dirtyDirs.add(scopeKey);
    this.advanceDirtyRevision(scopeKey);
  }

  private clearDirDirtyState(
    sessionDir: string,
    reader?: ISessionReader,
    observedRevision?: number,
  ): void {
    const scopeKey = this.getScopeKey(sessionDir, reader);
    if (
      observedRevision !== undefined &&
      this.getDirtyRevision(scopeKey) !== observedRevision
    ) {
      return;
    }
    this.dirtyDirs.delete(scopeKey);
    this.dirtySessionsByDir.delete(scopeKey);
  }

  private markMatchingScopesDirty(prefix: string): void {
    const knownScopeKeys = new Set<string>([
      ...this.indexCache.keys(),
      ...this.lastFullValidationAt.keys(),
      ...this.dirtyDirs.values(),
      ...this.dirtySessionsByDir.keys(),
    ]);

    for (const knownKey of knownScopeKeys) {
      if (knownKey.startsWith(prefix)) {
        this.markDirDirtyByScopeKey(this.getScopeKeyFromKnownKey(knownKey));
      }
    }
  }

  private markLoadedCodexSessionDirty(
    sessionId: string,
    changeType: FileChangeEvent["changeType"],
  ): boolean {
    // Only loaded indexes can prove membership, so scopes known solely from
    // validation timestamps or dirty marks can never match here.
    let marked = false;
    for (const [scopeKey, index] of this.indexCache) {
      if (!scopeKey.startsWith("codex::")) continue;
      if (!index.sessions[sessionId]) continue;
      this.markCodexScopeDirty(scopeKey, sessionId, changeType);
      marked = true;
    }

    return marked;
  }

  private markCodexScopeDirty(
    scopeKey: string,
    sessionId: string,
    changeType: FileChangeEvent["changeType"],
  ): void {
    if (changeType === "create" || changeType === "delete") {
      this.markDirDirtyByScopeKey(scopeKey);
      return;
    }

    this.markSessionDirtyByScopeKey(scopeKey, sessionId);
  }

  private buildSummariesFromIndex(
    index: SessionIndexState,
    projectId: UrlProjectId,
    options?: SessionIndexListOptions,
  ): SessionSummary[] {
    const summaries: SessionSummary[] = [];
    const activeAfterMs = options?.activeAfterMs;

    for (const [sessionId, cached] of Object.entries(index.sessions)) {
      if (cached.isEmpty) continue;
      if (
        activeAfterMs !== undefined &&
        Date.parse(cached.updatedAt) < activeAfterMs
      ) {
        continue;
      }
      summaries.push(this.toSessionSummary(sessionId, cached, projectId));
    }

    summaries.sort(
      (a, b) =>
        new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
    );

    return summaries;
  }

  private toSessionSummary(
    sessionId: string,
    cached: CachedSessionSummary,
    projectId: UrlProjectId,
  ): SessionSummary {
    return {
      id: sessionId,
      projectId,
      ...agentApiSummaryTitle(cached),
      createdAt: cached.createdAt,
      updatedAt: cached.updatedAt,
      messageCount: cached.messageCount,
      ownership: { owner: "none" },
      contextUsage: cached.contextUsage,
      provider: cached.provider ?? DEFAULT_PROVIDER,
      model: cached.model,
      parentSessionId: cached.parentSessionId,
      parentSessionKind: cached.parentSessionKind,
      forkedFromSessionId: cached.forkedFromSessionId,
      lastAgentText: cached.lastAgentText,
      asyncQuestions: cached.asyncQuestions,
    };
  }

  private toCachedSummary(
    summary: SessionSummary,
    mtime: number,
    size: number,
  ): CachedSessionSummary {
    return {
      title: summary.title,
      fullTitle: summary.fullTitle,
      createdAt: summary.createdAt,
      updatedAt: summary.updatedAt,
      messageCount: summary.messageCount,
      contextUsage: summary.contextUsage,
      indexedBytes: size,
      fileMtime: mtime,
      provider: summary.provider,
      model: summary.model,
      parentSessionId: summary.parentSessionId,
      parentSessionKind: summary.parentSessionKind,
      forkedFromSessionId: summary.forkedFromSessionId,
      lastAgentText: summary.lastAgentText,
      asyncQuestions: summary.asyncQuestions,
    };
  }

  private toEmptyCachedSummary(
    mtime: number,
    size: number,
  ): CachedSessionSummary {
    const now = new Date().toISOString();
    return {
      title: null,
      fullTitle: null,
      createdAt: now,
      updatedAt: now,
      messageCount: 0,
      indexedBytes: size,
      fileMtime: mtime,
      isEmpty: true,
      provider: DEFAULT_PROVIDER,
    };
  }

  private recordCallStats(
    mode: "fast" | "incremental" | "full",
    durationMs: number,
    statCalls: number,
    parseCalls: number,
    sessionDir: string,
    details: SessionIndexPerfDetails = {},
  ): void {
    this.cacheStats.requests += 1;
    this.cacheStats.statCalls += statCalls;
    this.cacheStats.parseCalls += parseCalls;
    this.cacheStats.totalDurationMs += durationMs;

    if (mode === "fast") this.cacheStats.fastHits += 1;
    if (mode === "incremental") this.cacheStats.incrementalRuns += 1;
    if (mode === "full") this.cacheStats.fullScans += 1;

    if (LOG_CACHE_PERF || durationMs >= 250) {
      getLogger().info(
        {
          event: "session_index_perf",
          mode,
          sessionDir,
          durationMs,
          statCalls,
          parseCalls,
          ...details,
        },
        "SESSION_INDEX: performance",
      );
    }
  }

  private snapshotWarmupJob(
    job: SessionIndexWarmupJobState,
    now = Date.now(),
  ): SessionIndexWarmupJobSnapshot {
    return {
      key: job.key,
      status: job.status,
      scopeKey: job.scopeKey,
      validationKey: job.validationKey,
      sessionDir: job.sessionDir,
      projectId: job.projectId,
      startedAt: new Date(job.startedAtMs).toISOString(),
      updatedAt: new Date(job.updatedAtMs).toISOString(),
      ...(job.completedAtMs
        ? { completedAt: new Date(job.completedAtMs).toISOString() }
        : {}),
      elapsedMs: now - job.startedAtMs,
      totalFiles: job.totalFiles,
      completedFiles: job.completedFiles,
      cacheHits: job.cacheHits,
      cacheMisses: job.cacheMisses,
      cacheMissBytes: job.cacheMissBytes,
      parsedBytes: job.parsedBytes,
      parseCalls: job.parseCalls,
      activeParses: job.activeParses,
      queuedParses: job.queuedParses,
      coalescedParses: job.coalescedParses,
      ...(job.lastSessionId ? { lastSessionId: job.lastSessionId } : {}),
      ...(job.lastFilePath ? { lastFilePath: job.lastFilePath } : {}),
      ...(job.error ? { error: job.error } : {}),
    };
  }

  private startWarmupJob(args: {
    scopeKey: string;
    validationKey: string;
    sessionDir: string;
    projectId: UrlProjectId;
  }): SessionIndexWarmupJobState {
    const now = Date.now();
    const existing = this.warmupJobs.get(args.validationKey);
    if (existing && existing.status === "running") {
      existing.updatedAtMs = now;
      return existing;
    }

    const job: SessionIndexWarmupJobState = {
      key: args.validationKey,
      status: "running",
      scopeKey: args.scopeKey,
      validationKey: args.validationKey,
      sessionDir: args.sessionDir,
      projectId: args.projectId,
      startedAtMs: now,
      updatedAtMs: now,
      lastLoggedAtMs: 0,
      totalFiles: 0,
      completedFiles: 0,
      cacheHits: 0,
      cacheMisses: 0,
      cacheMissBytes: 0,
      parsedBytes: 0,
      parseCalls: 0,
      activeParses: 0,
      queuedParses: 0,
      coalescedParses: 0,
    };
    this.warmupJobs.set(job.key, job);
    this.ensureWarmupProgressTimer();
    this.logWarmupProgress(job, "start", true);
    return job;
  }

  private updateWarmupJob(
    jobKey: string,
    update: (job: SessionIndexWarmupJobState, now: number) => void,
  ): void {
    const job = this.warmupJobs.get(jobKey);
    if (job?.status !== "running") return;
    const now = Date.now();
    update(job, now);
    job.updatedAtMs = now;
  }

  private completeWarmupJob(jobKey: string): void {
    const job = this.warmupJobs.get(jobKey);
    if (job?.status !== "running") return;
    const now = Date.now();
    job.status = "completed";
    job.completedAtMs = now;
    job.updatedAtMs = now;
    this.logWarmupProgress(job, "complete", true);
    this.rememberCompletedWarmupJob(job, now);
  }

  private failWarmupJob(jobKey: string, error: unknown): void {
    const job = this.warmupJobs.get(jobKey);
    if (job?.status !== "running") return;
    const now = Date.now();
    job.status = "failed";
    job.error = error instanceof Error ? error.message : String(error);
    job.completedAtMs = now;
    job.updatedAtMs = now;
    this.logWarmupProgress(job, "failed", true);
    this.rememberCompletedWarmupJob(job, now);
  }

  private rememberCompletedWarmupJob(
    job: SessionIndexWarmupJobState,
    now: number,
  ): void {
    this.warmupJobs.delete(job.key);
    this.recentWarmupJobs.unshift(this.snapshotWarmupJob(job, now));
    this.recentWarmupJobs = this.recentWarmupJobs.slice(0, 20);
    if (this.warmupJobs.size === 0) {
      this.stopWarmupProgressTimer();
    }
  }

  private ensureWarmupProgressTimer(): void {
    if (this.warmupProgressTimer) return;
    this.warmupProgressTimer = setInterval(() => {
      const now = Date.now();
      for (const job of this.warmupJobs.values()) {
        this.logWarmupProgress(job, "progress", false, now);
      }
      if (this.warmupJobs.size === 0) {
        this.stopWarmupProgressTimer();
      }
    }, this.warmupProgressLogIntervalMs);
    this.warmupProgressTimer.unref?.();
  }

  private stopWarmupProgressTimer(): void {
    if (!this.warmupProgressTimer) return;
    clearInterval(this.warmupProgressTimer);
    this.warmupProgressTimer = null;
  }

  private logWarmupProgress(
    job: SessionIndexWarmupJobState,
    phase: "start" | "progress" | "complete" | "failed",
    force: boolean,
    now = Date.now(),
  ): void {
    if (!force && now - job.lastLoggedAtMs < this.warmupProgressLogIntervalMs) {
      return;
    }
    job.lastLoggedAtMs = now;
    getLogger().info(
      {
        event: "session_index_warmup_progress",
        phase,
        summaryParseConcurrency: this.summaryParseConcurrency,
        globalActiveParses: this.activeSummaryParses,
        globalQueuedParses: this.summaryParseQueue.length,
        ...this.snapshotWarmupJob(job, now),
      },
      "SESSION_INDEX: warmup progress",
    );
  }

  private enqueueSummaryParse(args: {
    sessionDir: string;
    projectId: UrlProjectId;
    reader: ISessionReader;
    scopeKey: string;
    validationKey: string;
    sessionId: string;
    filePath: string;
    size: number;
    mtime: number;
  }): Promise<SessionSummary | null> {
    const parseKey = `${args.scopeKey}::${args.sessionId}::${args.mtime}::${args.size}`;
    const existing = this.inFlightSummaryParses.get(parseKey);
    if (existing) {
      this.updateWarmupJob(args.validationKey, (job) => {
        job.coalescedParses += 1;
        job.lastSessionId = args.sessionId;
        job.lastFilePath = args.filePath;
      });
      return existing.then((summary) => {
        this.updateWarmupJob(args.validationKey, (job) => {
          job.completedFiles += 1;
          job.parsedBytes += args.size;
          job.lastSessionId = args.sessionId;
          job.lastFilePath = args.filePath;
        });
        return summary;
      });
    }

    const promise = new Promise<SessionSummary | null>((resolve, reject) => {
      const task: SummaryParseTask = {
        key: parseKey,
        jobKey: args.validationKey,
        sessionId: args.sessionId,
        filePath: args.filePath,
        size: args.size,
        run: () =>
          args.reader.getSessionSummary(args.sessionId, args.projectId),
        resolve,
        reject,
      };
      this.summaryParseQueue.push(task);
      this.updateWarmupJob(args.validationKey, (job) => {
        job.queuedParses += 1;
        job.lastSessionId = args.sessionId;
        job.lastFilePath = args.filePath;
      });
      this.drainSummaryParseQueue();
    });
    this.inFlightSummaryParses.set(parseKey, promise);
    promise.then(
      () => {
        if (this.inFlightSummaryParses.get(parseKey) === promise) {
          this.inFlightSummaryParses.delete(parseKey);
        }
      },
      () => {
        if (this.inFlightSummaryParses.get(parseKey) === promise) {
          this.inFlightSummaryParses.delete(parseKey);
        }
      },
    );
    return promise;
  }

  private drainSummaryParseQueue(): void {
    while (
      this.activeSummaryParses < this.summaryParseConcurrency &&
      this.summaryParseQueue.length > 0
    ) {
      const task = this.summaryParseQueue.shift();
      if (!task) return;
      this.activeSummaryParses += 1;
      this.updateWarmupJob(task.jobKey, (job) => {
        job.queuedParses = Math.max(0, job.queuedParses - 1);
        job.activeParses += 1;
        job.parseCalls += 1;
        job.lastSessionId = task.sessionId;
        job.lastFilePath = task.filePath;
      });

      void (async () => {
        try {
          const summary = await task.run();
          this.updateWarmupJob(task.jobKey, (job) => {
            job.completedFiles += 1;
            job.parsedBytes += task.size;
            job.lastSessionId = task.sessionId;
            job.lastFilePath = task.filePath;
          });
          task.resolve(summary);
        } catch (error) {
          this.failWarmupJob(task.jobKey, error);
          task.reject(error);
        } finally {
          this.activeSummaryParses = Math.max(0, this.activeSummaryParses - 1);
          this.updateWarmupJob(task.jobKey, (job) => {
            job.activeParses = Math.max(0, job.activeParses - 1);
          });
          this.drainSummaryParseQueue();
        }
      })();
    }
  }

  /**
   * Handle watcher events so requests can avoid unnecessary full rescans while
   * still invalidating provider-specific indexes correctly.
   */
  private handleFileChange(event: FileChangeEvent): void {
    if (event.fileType !== "session") {
      return;
    }

    if (event.provider === "claude") {
      const fileName = path.basename(event.relativePath);
      if (!fileName.endsWith(".jsonl")) return;
      const sessionId = fileName.slice(0, -6);
      const relativeDir = path.dirname(event.relativePath);
      const sessionDir =
        relativeDir === "."
          ? this.projectsDir
          : path.join(this.projectsDir, relativeDir);

      this.markSessionDirty(sessionDir, sessionId);

      // Directory creates/deletes require full readdir reconciliation.
      if (event.changeType === "create" || event.changeType === "delete") {
        this.markDirDirty(sessionDir);
      }
      return;
    }

    if (event.provider === "codex") {
      this.handleCodexFileChange(event);
      return;
    }

    if (event.provider === "gemini") {
      // Gemini uses the same shared-tree + project-scoped index pattern.
      this.markMatchingScopesDirty("gemini::");
    }
  }

  private handleCodexFileChange(event: FileChangeEvent): void {
    const sessionId = getCodexRolloutSessionId(event.relativePath);
    if (!sessionId) {
      this.markMatchingScopesDirty("codex::");
      return;
    }

    if (this.markLoadedCodexSessionDirty(sessionId, event.changeType)) {
      return;
    }

    void this.resolveAndMarkCodexFileChange(event, sessionId);
  }

  private async resolveAndMarkCodexFileChange(
    event: FileChangeEvent,
    sessionId: string,
  ): Promise<void> {
    try {
      const resolved = await this.resolveCodexFileChange(event);
      if (resolved && !resolved.isSubagent) {
        this.markCodexScopeDirty(
          resolved.scopeKey,
          resolved.sessionId,
          event.changeType,
        );
        return;
      }
    } catch (error) {
      getLogger().debug(
        { err: error, filePath: event.path },
        "[SessionIndexService] Failed to resolve Codex file change",
      );
    }

    if (!this.markLoadedCodexSessionDirty(sessionId, event.changeType)) {
      this.markMatchingScopesDirty("codex::");
    }
  }

  private async resolveCodexFileChange(event: FileChangeEvent): Promise<{
    sessionId: string;
    scopeKey: string;
    isSubagent: boolean;
  } | null> {
    const sessionsDir = this.getCodexSessionsDirForEvent(event);
    const discoveryIndex = this.getCodexDiscoveryIndex(sessionsDir);
    const identity = getCodexRolloutDiscoveryIdentity(sessionsDir, event.path);

    if (event.changeType === "delete") {
      const record =
        await discoveryIndex.getRecord<CodexRolloutDiscoveryMetadata>(
          identity.shardKey,
          identity.key,
        );
      if (!record) return null;
      await discoveryIndex.removeRecord(identity.shardKey, identity.key);
      void discoveryIndex.flush();
      return this.codexMetadataToDirtyScope(sessionsDir, record.metadata);
    }

    const metadata = await readCodexRolloutMetadata({
      sessionsDir,
      filePath: event.path,
      discoveryIndex,
    });
    void discoveryIndex.flush();
    if (!metadata) return null;
    return this.codexMetadataToDirtyScope(sessionsDir, metadata);
  }

  private codexMetadataToDirtyScope(
    sessionsDir: string,
    metadata: CodexRolloutDiscoveryMetadata,
  ): { sessionId: string; scopeKey: string; isSubagent: boolean } {
    return {
      sessionId: metadata.id,
      scopeKey: `codex::${sessionsDir}::${getProjectIdentityKey(metadata.cwd)}`,
      isSubagent: metadata.isSubagent,
    };
  }

  private getCodexDiscoveryIndex(sessionsDir: string): SessionDiscoveryIndex {
    const resolvedSessionsDir = path.resolve(sessionsDir);
    return this.sessionDiscoveryIndexRegistry.getOrCreate({
      baseDir: path.join(this.dataDir, "session-discovery"),
      provider: "codex",
      sourceRoot: resolvedSessionsDir,
    });
  }

  private getCodexSessionsDirForEvent(event: FileChangeEvent): string {
    const relativeDir = path.dirname(event.relativePath.replace(/\\/g, "/"));
    let current = path.resolve(path.dirname(event.path));
    if (relativeDir === ".") return current;

    for (const _segment of relativeDir.split("/")) {
      current = path.dirname(current);
    }
    return current;
  }

  private async applyIncrementalDirtyUpdates(
    sessionDir: string,
    projectId: UrlProjectId,
    reader: ISessionReader,
    index: SessionIndexState,
  ): Promise<{ indexChanged: boolean; statCalls: number; parseCalls: number }> {
    const scopeKey = this.getScopeKey(sessionDir, reader);
    const dirty = this.dirtySessionsByDir.get(scopeKey);
    if (!dirty || dirty.size === 0) {
      return { indexChanged: false, statCalls: 0, parseCalls: 0 };
    }
    const observedDirtyRevision = this.getDirtyRevision(scopeKey);

    let indexChanged = false;
    let statCalls = 0;
    let parseCalls = 0;
    let warmupJobKey: string | null = null;
    let warmupJobCacheMissBytes = 0;
    const incrementalValidationKey = `${scopeKey}::incremental`;

    try {
      for (const sessionId of Array.from(dirty)) {
        const cached = index.sessions[sessionId];

        if (cached) {
          statCalls += 1;
          const changed = await reader.getSessionSummaryIfChanged(
            sessionId,
            projectId,
            cached.fileMtime,
            cached.indexedBytes,
          );
          if (!changed) continue;
          parseCalls += 1;
          index.sessions[sessionId] = this.toCachedSummary(
            changed.summary,
            changed.mtime,
            changed.size,
          );
          indexChanged = true;
          continue;
        }

        const filePath =
          (await reader.getSessionFilePath?.(sessionId)) ??
          path.join(sessionDir, `${sessionId}.jsonl`);
        let stats: Stats;
        try {
          stats = await fs.stat(filePath);
          statCalls += 1;
        } catch {
          if (index.sessions[sessionId]) {
            delete index.sessions[sessionId];
            indexChanged = true;
          }
          continue;
        }

        parseCalls += 1;
        warmupJobCacheMissBytes += stats.size;
        if (!warmupJobKey) {
          const job = this.startWarmupJob({
            scopeKey,
            validationKey: incrementalValidationKey,
            sessionDir,
            projectId,
          });
          warmupJobKey = job.key;
          this.updateWarmupJob(job.key, (current) => {
            current.totalFiles = dirty.size;
          });
        }
        this.updateWarmupJob(warmupJobKey, (current) => {
          current.cacheMisses += 1;
          current.cacheMissBytes = warmupJobCacheMissBytes;
        });

        const summary = await this.enqueueSummaryParse({
          sessionDir,
          projectId,
          reader,
          scopeKey,
          validationKey: warmupJobKey,
          sessionId,
          filePath,
          size: stats.size,
          mtime: stats.mtimeMs,
        });

        if (summary) {
          index.sessions[sessionId] = this.toCachedSummary(
            summary,
            stats.mtimeMs,
            stats.size,
          );
          indexChanged = true;
          continue;
        }

        index.sessions[sessionId] = this.toEmptyCachedSummary(
          stats.mtimeMs,
          stats.size,
        );
        indexChanged = true;
      }
    } catch (error) {
      if (warmupJobKey) {
        this.failWarmupJob(warmupJobKey, error);
      }
      throw error;
    }

    if (warmupJobKey) {
      this.completeWarmupJob(warmupJobKey);
    }
    if (this.getDirtyRevision(scopeKey) === observedDirtyRevision) {
      this.dirtySessionsByDir.delete(scopeKey);
    }
    return { indexChanged, statCalls, parseCalls };
  }

  private async runFullValidation(
    sessionDir: string,
    projectId: UrlProjectId,
    reader: ISessionReader,
    index: SessionIndexState,
    options?: SessionIndexListOptions,
  ): Promise<{
    summaries: SessionSummary[];
    statCalls: number;
    parseCalls: number;
    totalFiles: number;
    cacheHits: number;
    cacheMisses: number;
    cacheMissBytes: number;
    largestCacheMisses: SessionIndexLargestCacheMiss[];
  }> {
    const observedDirtyRevision = this.getDirtyRevision(
      this.getScopeKey(sessionDir, reader),
    );
    const summaries: SessionSummary[] = [];
    const seenSessionIds = new Set<string>();
    let indexChanged = false;
    let statCalls = 0;
    let parseCalls = 0;
    let totalFiles = 0;
    let cacheHits = 0;
    let cacheMissBytes = 0;
    let largestCacheMisses: SessionIndexLargestCacheMiss[] = [];
    let warmupJobKey: string | null = null;

    try {
      // Enumerate session files — delegate to reader if it supports custom
      // enumeration (e.g., Gemini JSON where session ID is inside the file),
      // otherwise use default JSONL filename-based discovery.
      let sessionFiles: {
        sessionId: string;
        filePath: string;
        sharedFilePath?: boolean;
      }[];
      if (reader.listSessionFiles) {
        sessionFiles = await reader.listSessionFiles(sessionDir, options);
      } else {
        const files = await fs.readdir(sessionDir);
        sessionFiles = files
          .filter((f) => f.endsWith(".jsonl") && !f.startsWith("agent-"))
          .map((f) => ({
            sessionId: f.replace(".jsonl", ""),
            filePath: path.join(sessionDir, f),
          }));
      }
      totalFiles = sessionFiles.length;

      const STAT_BATCH = 100;
      const allStats: (Stats | null)[] = Array.from({
        length: sessionFiles.length,
      });
      for (let b = 0; b < sessionFiles.length; b += STAT_BATCH) {
        const end = Math.min(b + STAT_BATCH, sessionFiles.length);
        const batch = await Promise.all(
          sessionFiles.slice(b, end).map((f) => {
            // A shared container file (e.g. a provider database) is not
            // statted: its mtime/size cannot validate individual sessions.
            if (f.sharedFilePath) return Promise.resolve(null);
            statCalls += 1;
            return fs.stat(f.filePath).catch(() => null);
          }),
        );
        for (let j = 0; j < batch.length; j++) {
          allStats[b + j] = batch[j] ?? null;
        }
      }

      const cacheMisses: {
        sessionId: string;
        filePath: string;
        mtime: number;
        size: number;
      }[] = [];

      for (let i = 0; i < sessionFiles.length; i++) {
        const entry = sessionFiles[i];
        if (!entry) continue;
        const sessionId = entry.sessionId;
        seenSessionIds.add(sessionId);

        if (entry.sharedFilePath) {
          // Validate through the reader's own cheap change check (e.g. a DB
          // row's updated-time + message count). Stat-based comparison can
          // never hit for these entries — the container's mtime moves on any
          // write while the cached mtime/size are row-derived — which made
          // every full validation re-summarize every DB session.
          const cachedShared = index.sessions[sessionId];
          const changed = await reader.getSessionSummaryIfChanged(
            sessionId,
            projectId,
            cachedShared?.fileMtime ?? -1,
            cachedShared?.indexedBytes ?? -1,
          );
          if (changed) {
            parseCalls += 1;
            index.sessions[sessionId] = this.toCachedSummary(
              changed.summary,
              changed.mtime,
              changed.size,
            );
            indexChanged = true;
            if (
              options?.activeAfterMs === undefined ||
              Date.parse(changed.summary.updatedAt) >= options.activeAfterMs
            ) {
              summaries.push(changed.summary);
            }
            continue;
          }
          if (cachedShared) {
            cacheHits += 1;
            if (cachedShared.isEmpty) continue;
            if (
              options?.activeAfterMs !== undefined &&
              Date.parse(cachedShared.updatedAt) < options.activeAfterMs
            ) {
              continue;
            }
            summaries.push(
              this.toSessionSummary(sessionId, cachedShared, projectId),
            );
            continue;
          }
          // Unknown session that yields no summary (e.g. still empty): cache
          // the emptiness so later validations stay row-level cheap.
          index.sessions[sessionId] = this.toEmptyCachedSummary(-1, -1);
          indexChanged = true;
          continue;
        }

        const stats = allStats[i];
        if (!stats) continue;

        const cached = index.sessions[sessionId];
        const mtime = stats.mtimeMs;
        const size = stats.size;

        if (
          cached &&
          cached.fileMtime === mtime &&
          cached.indexedBytes === size
        ) {
          cacheHits += 1;
          if (cached.isEmpty) continue;
          if (
            options?.activeAfterMs !== undefined &&
            Date.parse(cached.updatedAt) < options.activeAfterMs
          ) {
            continue;
          }
          summaries.push(this.toSessionSummary(sessionId, cached, projectId));
        } else {
          cacheMissBytes += size;
          cacheMisses.push({
            sessionId,
            filePath: entry.filePath,
            mtime,
            size,
          });
        }
      }

      largestCacheMisses = cacheMisses
        .slice()
        .sort((a, b) => b.size - a.size)
        .slice(0, 5)
        .map(({ sessionId, filePath, mtime, size }) => ({
          sessionId,
          filePath,
          mtime,
          size,
        }));

      if (cacheMisses.length > 0) {
        const scopeKey = this.getScopeKey(sessionDir, reader);
        const validationKey = this.getValidationKey(
          sessionDir,
          reader,
          options,
        );
        const job = this.startWarmupJob({
          scopeKey,
          validationKey,
          sessionDir,
          projectId,
        });
        warmupJobKey = job.key;
        this.updateWarmupJob(job.key, (current) => {
          current.totalFiles = totalFiles;
          current.completedFiles = cacheHits;
          current.cacheHits = cacheHits;
          current.cacheMisses = cacheMisses.length;
          current.cacheMissBytes = cacheMissBytes;
        });
      }

      for (const { sessionId, filePath, mtime, size } of cacheMisses) {
        parseCalls += 1;
        const summary = await this.enqueueSummaryParse({
          sessionDir,
          projectId,
          reader,
          scopeKey: this.getScopeKey(sessionDir, reader),
          validationKey:
            warmupJobKey ?? this.getValidationKey(sessionDir, reader, options),
          sessionId,
          filePath,
          size,
          mtime,
        });
        if (summary) {
          if (
            options?.activeAfterMs === undefined ||
            Date.parse(summary.updatedAt) >= options.activeAfterMs
          ) {
            summaries.push(summary);
          }
          index.sessions[sessionId] = this.toCachedSummary(
            summary,
            mtime,
            size,
          );
          indexChanged = true;
        } else {
          index.sessions[sessionId] = this.toEmptyCachedSummary(mtime, size);
          indexChanged = true;
        }
      }
      if (warmupJobKey) {
        this.completeWarmupJob(warmupJobKey);
      }

      for (const sessionId of Object.keys(index.sessions)) {
        if (!options?.activeAfterMs && !seenSessionIds.has(sessionId)) {
          delete index.sessions[sessionId];
          indexChanged = true;
        }
      }

      // Persist even a no-change (possibly empty) index: a scope with no
      // index file would otherwise block a request in-line again on the
      // first list after every server restart.
      if (
        indexChanged ||
        !this.persistedIndexScopes.has(this.getScopeKey(sessionDir, reader))
      ) {
        await this.saveIndex(sessionDir, reader);
      }

      summaries.sort(
        (a, b) =>
          new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
      );
      this.lastFullValidationAt.set(
        this.getValidationKey(sessionDir, reader, options),
        Date.now(),
      );
      this.clearDirDirtyState(sessionDir, reader, observedDirtyRevision);

      return {
        summaries,
        statCalls,
        parseCalls,
        totalFiles,
        cacheHits,
        cacheMisses: cacheMisses.length,
        cacheMissBytes,
        largestCacheMisses,
      };
    } catch (error) {
      if (warmupJobKey) {
        this.failWarmupJob(warmupJobKey, error);
      }
      return {
        summaries: [],
        statCalls,
        parseCalls,
        totalFiles,
        cacheHits,
        cacheMisses: parseCalls,
        cacheMissBytes,
        largestCacheMisses,
      };
    }
  }

  getDebugStats(): {
    requests: number;
    fastHits: number;
    incrementalRuns: number;
    fullScans: number;
    statCalls: number;
    parseCalls: number;
    avgDurationMs: number;
    dirtyDirCount: number;
    dirtySessionCount: number;
  } {
    const dirtySessionCount = Array.from(
      this.dirtySessionsByDir.values(),
    ).reduce((sum, set) => sum + set.size, 0);

    return {
      ...this.cacheStats,
      avgDurationMs:
        this.cacheStats.requests > 0
          ? this.cacheStats.totalDurationMs / this.cacheStats.requests
          : 0,
      dirtyDirCount: this.dirtyDirs.size,
      dirtySessionCount,
    };
  }

  getWarmupStatus(): SessionIndexWarmupStatusSnapshot {
    const now = Date.now();
    return {
      summaryParseConcurrency: this.summaryParseConcurrency,
      activeParses: this.activeSummaryParses,
      queuedParses: this.summaryParseQueue.length,
      activeJobs: Array.from(this.warmupJobs.values()).map((job) =>
        this.snapshotWarmupJob(job, now),
      ),
      recentJobs: this.recentWarmupJobs,
    };
  }

  /**
   * Get sessions using the cache, only re-parsing files that have changed.
   * This is the main entry point for listing sessions with caching.
   */
  async getSessionsWithCache(
    sessionDir: string,
    projectId: UrlProjectId,
    reader: ISessionReader,
    options?: SessionIndexListOptions,
  ): Promise<SessionSummary[]> {
    const loadKey = this.getScopedLoadKey(
      sessionDir,
      projectId,
      reader,
      options,
    );
    const inFlight = this.inFlightSessionLoads.get(loadKey);
    if (inFlight) {
      return inFlight;
    }

    const promise = this.getSessionsWithCacheInternal(
      sessionDir,
      projectId,
      reader,
      options,
    );
    this.inFlightSessionLoads.set(loadKey, promise);

    try {
      return await promise;
    } finally {
      if (this.inFlightSessionLoads.get(loadKey) === promise) {
        this.inFlightSessionLoads.delete(loadKey);
      }
    }
  }

  private async getSessionsWithCacheInternal(
    sessionDir: string,
    projectId: UrlProjectId,
    reader: ISessionReader,
    options?: SessionIndexListOptions,
  ): Promise<SessionSummary[]> {
    const start = Date.now();
    const scopeKey = this.getScopeKey(sessionDir, reader);
    const validationKey = this.getValidationKey(sessionDir, reader, options);
    const index = await this.loadIndex(sessionDir, projectId, reader);
    const now = Date.now();
    const lastFullValidation =
      this.lastFullValidationAt.get(validationKey) ?? 0;
    const hasDirDirty = this.dirtyDirs.has(scopeKey);
    const dirtySessions = this.dirtySessionsByDir.get(scopeKey);
    const hasDirtySessions = Boolean(dirtySessions && dirtySessions.size > 0);

    const fullValidationDue =
      this.fullValidationIntervalMs <= 0 ||
      lastFullValidation === 0 ||
      now - lastFullValidation >= this.fullValidationIntervalMs;

    // Fast path: no dirty signals and recent full validation.
    if (!fullValidationDue && !hasDirDirty && !hasDirtySessions) {
      const summaries = this.buildSummariesFromIndex(index, projectId, options);
      this.recordCallStats("fast", Date.now() - start, 0, 0, sessionDir, {
        scopeKey,
        validationKey,
        indexedSessions: Object.keys(index.sessions).length,
      });
      return summaries;
    }

    // Incremental path: only specific sessions are dirty.
    if (!fullValidationDue && !hasDirDirty && hasDirtySessions) {
      const incremental = await this.applyIncrementalDirtyUpdates(
        sessionDir,
        projectId,
        reader,
        index,
      );
      if (incremental.indexChanged) {
        await this.saveIndex(sessionDir, reader);
      }
      const summaries = this.buildSummariesFromIndex(index, projectId, options);
      this.recordCallStats(
        "incremental",
        Date.now() - start,
        incremental.statCalls,
        incremental.parseCalls,
        sessionDir,
        {
          scopeKey,
          validationKey,
          dirtySessions: dirtySessions?.size ?? 0,
          indexedSessions: Object.keys(index.sessions).length,
        },
      );
      return summaries;
    }

    // Full validation is due only because the TTL lapsed (no directory-level
    // dirty signal). The TTL walk is a consistency backstop for missed
    // watcher events, so a scope that already has a previously validated
    // (this run) or persisted index serves it immediately and revalidates in
    // the background — a fresh browser window after server idle must not pay
    // the walk in-line. Background-discovered changes reach clients as
    // session-updated/session-created bus events. Directory-dirty scopes
    // (watcher saw a create/delete) still validate in-line, and interval <= 0
    // keeps its validate-every-request contract. First-ever scans (no usable
    // index) also still block: there is nothing to serve.
    const canServeStaleWhileRevalidating =
      this.fullValidationIntervalMs > 0 &&
      !hasDirDirty &&
      (lastFullValidation > 0 || this.persistedIndexScopes.has(scopeKey));
    if (canServeStaleWhileRevalidating) {
      let statCalls = 0;
      let parseCalls = 0;
      if (hasDirtySessions) {
        const incremental = await this.applyIncrementalDirtyUpdates(
          sessionDir,
          projectId,
          reader,
          index,
        );
        statCalls = incremental.statCalls;
        parseCalls = incremental.parseCalls;
        if (incremental.indexChanged) {
          await this.saveIndex(sessionDir, reader);
        }
      }
      this.scheduleBackgroundValidation(sessionDir, projectId, reader, options);
      const summaries = this.buildSummariesFromIndex(index, projectId, options);
      this.recordCallStats(
        "fast",
        Date.now() - start,
        statCalls,
        parseCalls,
        sessionDir,
        {
          scopeKey,
          validationKey,
          staleWhileRevalidate: true,
          indexedSessions: Object.keys(index.sessions).length,
        },
      );
      return summaries;
    }

    const full = await this.runFullValidation(
      sessionDir,
      projectId,
      reader,
      index,
      options,
    );
    this.recordCallStats(
      "full",
      Date.now() - start,
      full.statCalls,
      full.parseCalls,
      sessionDir,
      {
        scopeKey,
        validationKey,
        indexedSessions: Object.keys(index.sessions).length,
        totalFiles: full.totalFiles,
        cacheHits: full.cacheHits,
        cacheMisses: full.cacheMisses,
        cacheMissBytes: full.cacheMissBytes,
        largestCacheMisses: full.largestCacheMisses,
      },
    );
    return full.summaries;
  }

  /**
   * Queue a background full validation for a scope/options variant, deduped
   * while one is pending and serialized across scopes so a burst of
   * stale-served requests (the per-project walk behind /api/sessions) does
   * not stampede the filesystem.
   */
  private scheduleBackgroundValidation(
    sessionDir: string,
    projectId: UrlProjectId,
    reader: ISessionReader,
    options?: SessionIndexListOptions,
  ): void {
    const validationKey = this.getValidationKey(sessionDir, reader, options);
    if (this.backgroundValidations.has(validationKey)) {
      return;
    }
    const run = this.backgroundValidationChain
      .then(() =>
        this.runBackgroundValidation(sessionDir, projectId, reader, options),
      )
      .catch((error) => {
        getLogger().warn(
          { err: error },
          `[SessionIndexService] Background validation failed for ${validationKey}`,
        );
      })
      .finally(() => {
        this.backgroundValidations.delete(validationKey);
      });
    this.backgroundValidations.set(validationKey, run);
    this.backgroundValidationChain = run;
  }

  private async runBackgroundValidation(
    sessionDir: string,
    projectId: UrlProjectId,
    reader: ISessionReader,
    options?: SessionIndexListOptions,
  ): Promise<void> {
    const validationKey = this.getValidationKey(sessionDir, reader, options);
    // A queued validation may have been satisfied while waiting in the chain.
    const lastFullValidation =
      this.lastFullValidationAt.get(validationKey) ?? 0;
    if (
      lastFullValidation > 0 &&
      Date.now() - lastFullValidation < this.fullValidationIntervalMs
    ) {
      return;
    }

    const start = Date.now();
    const scopeKey = this.getScopeKey(sessionDir, reader);
    const index = await this.loadIndex(sessionDir, projectId, reader);
    const before = new Map(Object.entries(index.sessions));
    const full = await this.runFullValidation(
      sessionDir,
      projectId,
      reader,
      index,
      options,
    );
    this.recordCallStats(
      "full",
      Date.now() - start,
      full.statCalls,
      full.parseCalls,
      sessionDir,
      {
        scopeKey,
        validationKey,
        background: true,
        indexedSessions: Object.keys(index.sessions).length,
        totalFiles: full.totalFiles,
        cacheHits: full.cacheHits,
        cacheMisses: full.cacheMisses,
        cacheMissBytes: full.cacheMissBytes,
        largestCacheMisses: full.largestCacheMisses,
      },
    );
    this.emitBackgroundIndexChanges(index, before, projectId);
  }

  /**
   * Emit bus events for sessions a background validation changed, so clients
   * that were served a stale response converge without refetching. Unchanged
   * entries keep their object identity through runFullValidation (only
   * changed rows are reassigned), so reference comparison is exact. Deleted
   * sessions have no removal event; they disappear on the next refetch.
   */
  private emitBackgroundIndexChanges(
    index: SessionIndexState,
    before: Map<string, CachedSessionSummary>,
    projectId: UrlProjectId,
  ): void {
    if (!this.eventBus) {
      return;
    }
    const timestamp = new Date().toISOString();
    for (const [sessionId, cached] of Object.entries(index.sessions)) {
      if (cached.isEmpty) continue;
      const previous = before.get(sessionId);
      if (previous === cached) continue;
      if (!previous || previous.isEmpty) {
        this.eventBus.emit({
          type: "session-created",
          session: this.toSessionSummary(sessionId, cached, projectId),
          timestamp,
        });
        continue;
      }
      this.eventBus.emit({
        type: "session-updated",
        sessionId,
        projectId,
        title: agentApiSummaryTitle(cached).title,
        messageCount: cached.messageCount,
        updatedAt: cached.updatedAt,
        contextUsage: cached.contextUsage,
        model: cached.model,
        lastAgentText: cached.lastAgentText,
        asyncQuestions: cached.asyncQuestions,
        timestamp,
      });
    }
  }

  /**
   * Invalidate the cache for a specific session.
   * Call this when you know a session file has been modified.
   */
  invalidateSession(sessionDir: string, sessionId: string): void {
    this.markSessionDirty(sessionDir, sessionId);
    const index = this.indexCache.get(sessionDir);
    if (index) {
      delete index.sessions[sessionId];
    }
  }

  /**
   * Clear all cached data for a session directory.
   */
  clearCache(sessionDir: string): void {
    this.indexCache.delete(sessionDir);
    this.persistedIndexScopes.delete(sessionDir);
    this.clearDirDirtyState(sessionDir);
    this.dirtyRevisions.delete(sessionDir);
    this.lastFullValidationAt.delete(sessionDir);
  }

  /**
   * Get the data directory for testing purposes.
   */
  getDataDir(): string {
    return this.dataDir;
  }

  /**
   * Get one session summary, using cached metadata when the indexed file stats
   * still match. This is the cache-first single-session companion to
   * getSessionsWithCache.
   */
  async getSessionSummaryWithCache(
    sessionDir: string,
    projectId: UrlProjectId,
    sessionId: string,
    reader: ISessionReader,
  ): Promise<SessionSummary | null> {
    const loadKey = this.getTitleLoadKey(
      sessionDir,
      projectId,
      sessionId,
      reader,
    );
    const inFlight = this.inFlightSessionSummaryLoads.get(loadKey);
    if (inFlight) return inFlight;

    const promise = this.getSessionSummaryWithCacheInternal(
      sessionDir,
      projectId,
      sessionId,
      reader,
    );
    this.inFlightSessionSummaryLoads.set(loadKey, promise);
    try {
      return await promise;
    } finally {
      if (this.inFlightSessionSummaryLoads.get(loadKey) === promise) {
        this.inFlightSessionSummaryLoads.delete(loadKey);
      }
    }
  }

  private async getSessionSummaryWithCacheInternal(
    sessionDir: string,
    projectId: UrlProjectId,
    sessionId: string,
    reader: ISessionReader,
  ): Promise<SessionSummary | null> {
    // A native SQLite WAL can change while its main file's stat is unchanged.
    // Read its bounded metadata through the same source-scoped in-flight owner,
    // rather than certifying a shared row from one file's mtime/size.
    const shared = await reader.getSharedStoreSummary?.(sessionId, projectId);
    if (shared !== undefined) return shared;
    const scopeKey = this.getScopeKey(sessionDir, reader);
    const observedDirtyRevision = this.getDirtyRevision(scopeKey);
    const index = await this.loadIndex(sessionDir, projectId, reader);
    const cached = index.sessions[sessionId];
    const dirtySessions = this.dirtySessionsByDir.get(scopeKey);
    const isDirty = dirtySessions?.has(sessionId) ?? false;
    const filePath =
      (await reader.getSessionFilePath?.(sessionId)) ??
      path.join(sessionDir, `${sessionId}.jsonl`);

    let stats: Stats;
    try {
      stats = await fs.stat(filePath);
    } catch {
      // Some readers can resolve a session across fallback locations even when
      // they do not expose a concrete file path for the index. Preserve that
      // behavior, but skip caching because we have no reliable mtime/size key.
      try {
        const summary = await reader.getSessionSummary(sessionId, projectId);
        if (summary) {
          this.clearSessionDirty(
            sessionDir,
            sessionId,
            reader,
            observedDirtyRevision,
          );
          return summary;
        }
      } catch {
        // Fall through to clear any stale indexed entry below.
      }

      if (cached) {
        delete index.sessions[sessionId];
        await this.saveIndex(sessionDir, reader, sessionId).catch(() => {
          // Save failures are already logged by saveIndex.
        });
      }
      this.clearSessionDirty(
        sessionDir,
        sessionId,
        reader,
        observedDirtyRevision,
      );
      return null;
    }

    const mtime = stats.mtimeMs;
    const size = stats.size;

    if (
      cached &&
      !isDirty &&
      cached.fileMtime === mtime &&
      cached.indexedBytes === size
    ) {
      return cached.isEmpty
        ? null
        : this.toSessionSummary(sessionId, cached, projectId);
    }

    const validationKey = `${scopeKey}::single:${sessionId}`;

    try {
      const summary = await this.enqueueSummaryParse({
        sessionDir,
        projectId,
        reader,
        scopeKey,
        validationKey,
        sessionId,
        filePath,
        size,
        mtime,
      });
      if (summary) {
        index.sessions[sessionId] = this.toCachedSummary(summary, mtime, size);
        this.clearSessionDirty(
          sessionDir,
          sessionId,
          reader,
          observedDirtyRevision,
        );
        await this.saveIndex(sessionDir, reader, sessionId);
        return summary;
      }

      index.sessions[sessionId] = this.toEmptyCachedSummary(mtime, size);
      this.clearSessionDirty(
        sessionDir,
        sessionId,
        reader,
        observedDirtyRevision,
      );
      await this.saveIndex(sessionDir, reader, sessionId);
    } catch {
      // Reader errors should not break callers that only need display metadata.
    }

    return null;
  }

  /**
   * Get one session summary only if the existing index row is fresh.
   *
   * Unlike getSessionSummaryWithCache, this method never parses on a cache miss.
   * It is for lightweight routes that can fall back to provider head metadata
   * without creating full-summary parse churn.
   */
  async getCachedSessionSummary(
    sessionDir: string,
    projectId: UrlProjectId,
    sessionId: string,
    reader: ISessionReader,
    options?: { acceptAppendedFile?: boolean },
  ): Promise<SessionSummary | null> {
    const scopeKey = this.getScopeKey(sessionDir, reader);
    const stored = this.summaryStore.get(
      scopeKey,
      projectId,
      sessionId,
      CURRENT_VERSION,
    );
    const cached =
      stored === undefined
        ? (await this.loadIndex(sessionDir, projectId, reader)).sessions[
            sessionId
          ]
        : stored;
    if (!cached || cached.isEmpty) {
      return null;
    }

    const dirtySessions = this.dirtySessionsByDir.get(scopeKey);
    if (dirtySessions?.has(sessionId) && !options?.acceptAppendedFile) {
      return null;
    }

    const filePath =
      (await reader.getSessionFilePath?.(sessionId)) ??
      path.join(sessionDir, `${sessionId}.jsonl`);

    let stats: Stats;
    try {
      stats = await fs.stat(filePath);
    } catch {
      return null;
    }

    const unchanged =
      cached.fileMtime === stats.mtimeMs && cached.indexedBytes === stats.size;
    // An append-only transcript that has grown still has an accurate indexed
    // prefix. A shrunken file, or one whose size held while its mtime moved,
    // was rewritten rather than appended to, so the index describes different
    // bytes and cannot be trusted at all.
    const appendedOnly =
      options?.acceptAppendedFile === true &&
      stats.size > cached.indexedBytes &&
      stats.mtimeMs >= cached.fileMtime;
    if (!unchanged && !appendedOnly) {
      return null;
    }

    return this.toSessionSummary(sessionId, cached, projectId);
  }

  /**
   * Get just the title for a single session, using cache when possible.
   * More efficient than getSessionsWithCache when you only need one session.
   */
  async getSessionTitle(
    sessionDir: string,
    projectId: UrlProjectId,
    sessionId: string,
    reader: ISessionReader,
  ): Promise<string | null> {
    const loadKey = this.getTitleLoadKey(
      sessionDir,
      projectId,
      sessionId,
      reader,
    );
    const inFlight = this.inFlightTitleLoads.get(loadKey);
    if (inFlight) return inFlight;

    const promise = this.getSessionTitleInternal(
      sessionDir,
      projectId,
      sessionId,
      reader,
    );
    this.inFlightTitleLoads.set(loadKey, promise);
    try {
      return await promise;
    } finally {
      if (this.inFlightTitleLoads.get(loadKey) === promise) {
        this.inFlightTitleLoads.delete(loadKey);
      }
    }
  }

  private async getSessionTitleInternal(
    sessionDir: string,
    projectId: UrlProjectId,
    sessionId: string,
    reader: ISessionReader,
  ): Promise<string | null> {
    const summary = await this.getSessionSummaryWithCache(
      sessionDir,
      projectId,
      sessionId,
      reader,
    );
    return summary?.title ?? null;
  }

  dispose(): void {
    this.stopWarmupProgressTimer();
    this.unsubscribeEventBus?.();
    this.unsubscribeEventBus = null;
    this.summaryStore.dispose();
  }
}
