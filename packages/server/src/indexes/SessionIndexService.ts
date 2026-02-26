/**
 * SessionIndexService caches session summaries to avoid re-parsing JSONL files.
 * Uses mtime/size for cache invalidation - only re-parses when files change.
 *
 * State is persisted to JSON files for durability across server restarts.
 * Each project's session directory gets its own index file.
 */

import type { Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  DEFAULT_PROVIDER,
  type ProviderName,
  type UrlProjectId,
} from "@yep-anywhere/shared";
import { getLogger } from "../logging/logger.js";
import type { ISessionReader } from "../sessions/types.js";
import type { Project, SessionSummary } from "../supervisor/types.js";
import type { EventBus, FileChangeEvent } from "../watcher/index.js";
import type { ISessionIndexService } from "./types.js";

const logger = getLogger();
const LOG_CACHE_PERF = process.env.SESSION_INDEX_LOG_PERF === "true";

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
}

export interface SessionIndexState {
  version: 1;
  projectId: string;
  sessions: Record<string, CachedSessionSummary>;
}

const CURRENT_VERSION = 1;

export interface SessionIndexServiceOptions {
  /** Directory to store index files (defaults to ~/.yep-anywhere/indexes) */
  dataDir?: string;
  /** Claude projects directory (defaults to ~/.claude/projects) */
  projectsDir?: string;
  /** Max number of projects to keep in memory cache (default: 100) */
  maxCacheSize?: number;
  /**
   * Interval in ms between full directory validations.
   * 0 disables fast-path and validates every request.
   */
  fullValidationIntervalMs?: number;
  /** Optional event bus for watcher-driven invalidation. */
  eventBus?: EventBus;
  /** Max time to wait for cross-process write lock (ms). */
  writeLockTimeoutMs?: number;
  /** Age at which lock directories are treated as stale and removed (ms). */
  writeLockStaleMs?: number;
}

/**
 * Claude-specific session index service.
 *
 * Caches session summaries for Claude Code JSONL files to avoid
 * re-parsing on every request. Currently works with Claude's
 * ~/.claude/projects/ directory structure.
 */
export class SessionIndexService implements ISessionIndexService {
  private dataDir: string;
  private projectsDir: string;
  private indexCache: Map<string, SessionIndexState> = new Map();
  private savePromises: Map<string, Promise<void>> = new Map();
  private pendingSaves: Set<string> = new Set();
  private maxCacheSize: number;
  private fullValidationIntervalMs: number;
  private writeLockTimeoutMs: number;
  private writeLockStaleMs: number;
  private lastFullValidationAt: Map<string, number> = new Map();
  private dirtyDirs: Set<string> = new Set();
  private dirtySessionsByDir: Map<string, Set<string>> = new Map();
  private inFlightSessionLoads: Map<string, Promise<SessionSummary[]>> =
    new Map();
  private inFlightTitleLoads: Map<string, Promise<string | null>> = new Map();
  private backgroundValidations: Map<string, Promise<void>> = new Map();
  private cacheStats = {
    requests: 0,
    fastHits: 0,
    staleHits: 0,
    incrementalRuns: 0,
    fullScans: 0,
    statCalls: 0,
    parseCalls: 0,
    totalDurationMs: 0,
  };
  private unsubscribeEventBus: (() => void) | null = null;

  constructor(options: SessionIndexServiceOptions = {}) {
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
    this.writeLockTimeoutMs = Math.max(0, options.writeLockTimeoutMs ?? 2000);
    this.writeLockStaleMs = Math.max(1000, options.writeLockStaleMs ?? 10000);

    if (options.eventBus) {
      this.unsubscribeEventBus = options.eventBus.subscribe((event) => {
        if (event.type !== "file-change") return;
        this.handleFileChange(event);
      });
    }
  }

  /**
   * Evict oldest entries if cache exceeds max size.
   * Simple FIFO eviction since Map maintains insertion order.
   */
  private evictIfNeeded(): void {
    while (this.indexCache.size > this.maxCacheSize) {
      const firstKey = this.indexCache.keys().next().value;
      if (firstKey) {
        this.indexCache.delete(firstKey);
        logger.debug(
          `[SessionIndexService] Evicted cache entry for ${firstKey} (cache size: ${this.indexCache.size})`,
        );
      } else {
        break;
      }
    }
  }

  /**
   * Initialize the service by ensuring the data directory exists.
   */
  async initialize(): Promise<void> {
    await fs.mkdir(this.dataDir, { recursive: true });
  }

  /**
   * Get the index file path for a session directory.
   * Encodes the relative path from projectsDir with %2F for slashes.
   */
  getIndexPath(sessionDir: string): string {
    const relative = path.relative(this.projectsDir, sessionDir);
    const encoded = relative.replace(/[/\\]/g, "%2F");
    return path.join(this.dataDir, `${encoded}.json`);
  }

  /**
   * Load index from disk or create a new one.
   */
  private async loadIndex(
    sessionDir: string,
    projectId: UrlProjectId,
  ): Promise<SessionIndexState> {
    const indexPath = this.getIndexPath(sessionDir);
    const cacheKey = sessionDir;

    // Check memory cache first
    const cached = this.indexCache.get(cacheKey);
    if (cached) {
      /*
      logger.debug(
        `[SessionIndexService] Memory cache hit for project (${Object.keys(cached.sessions).length} sessions)`,
      );
      */
      return cached;
    }
    /*
    logger.debug(
      `[SessionIndexService] Memory cache miss, loading from disk: ${indexPath}`,
    );
    */

    try {
      const content = await fs.readFile(indexPath, "utf-8");
      const parsed = JSON.parse(content) as SessionIndexState;

      // Validate version and projectId
      if (
        parsed.version === CURRENT_VERSION &&
        parsed.projectId === projectId
      ) {
        this.indexCache.set(cacheKey, parsed);
        this.evictIfNeeded();
        return parsed;
      }

      // Version mismatch or different project - start fresh
      const fresh: SessionIndexState = {
        version: CURRENT_VERSION,
        projectId,
        sessions: {},
      };
      this.indexCache.set(cacheKey, fresh);
      this.evictIfNeeded();
      return fresh;
    } catch (error) {
      // File doesn't exist or is invalid - start fresh
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        logger.warn(
          { err: error },
          `[SessionIndexService] Failed to load index for ${sessionDir}, starting fresh`,
        );
      }
      const fresh: SessionIndexState = {
        version: CURRENT_VERSION,
        projectId,
        sessions: {},
      };
      this.indexCache.set(cacheKey, fresh);
      this.evictIfNeeded();
      return fresh;
    }
  }

  /**
   * Save index to disk with debouncing to prevent excessive writes.
   */
  private async saveIndex(sessionDir: string): Promise<void> {
    const cacheKey = sessionDir;

    // If a save is in progress, mark that we need another save
    if (this.savePromises.has(cacheKey)) {
      this.pendingSaves.add(cacheKey);
      return;
    }

    const promise = this.doSaveIndex(sessionDir);
    this.savePromises.set(cacheKey, promise);

    try {
      await promise;
    } finally {
      this.savePromises.delete(cacheKey);
    }

    // If another save was requested while we were saving, do it now
    if (this.pendingSaves.has(cacheKey)) {
      this.pendingSaves.delete(cacheKey);
      await this.saveIndex(sessionDir);
    }
  }

  private async doSaveIndex(sessionDir: string): Promise<void> {
    const index = this.indexCache.get(sessionDir);
    if (!index) return;

    const indexPath = this.getIndexPath(sessionDir);
    const lockPath = `${indexPath}.lock`;
    const tempPath = `${indexPath}.tmp-${process.pid}-${Date.now()}-${Math.random()
      .toString(16)
      .slice(2)}`;

    try {
      // Ensure directory exists
      await fs.mkdir(path.dirname(indexPath), { recursive: true });
      await this.withWriteLock(lockPath, async () => {
        const content = JSON.stringify(index, null, 2);
        await fs.writeFile(tempPath, content, "utf-8");
        await fs.rename(tempPath, indexPath);
      });
    } catch (error) {
      await fs.unlink(tempPath).catch(() => {
        // Best-effort cleanup for failed atomic writes.
      });
      logger.error(
        { err: error },
        `[SessionIndexService] Failed to save index for ${sessionDir}`,
      );
      throw error;
    }
  }

  private async withWriteLock<T>(
    lockPath: string,
    callback: () => Promise<T>,
  ): Promise<T> {
    await this.acquireWriteLock(lockPath);
    try {
      return await callback();
    } finally {
      await fs.rm(lockPath, { recursive: true, force: true }).catch(() => {
        // Best-effort lock cleanup.
      });
    }
  }

  private async acquireWriteLock(lockPath: string): Promise<void> {
    const start = Date.now();
    while (true) {
      try {
        await fs.mkdir(lockPath);
        return;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "EEXIST") {
          throw error;
        }

        const stale = await this.isLockStale(lockPath);
        if (stale) {
          await fs.rm(lockPath, { recursive: true, force: true }).catch(() => {
            // Best-effort stale lock cleanup.
          });
          continue;
        }

        if (Date.now() - start >= this.writeLockTimeoutMs) {
          throw new Error(
            `Timed out acquiring session index write lock: ${lockPath}`,
          );
        }

        await this.sleep(25);
      }
    }
  }

  private async isLockStale(lockPath: string): Promise<boolean> {
    try {
      const stats = await fs.stat(lockPath);
      return Date.now() - stats.mtimeMs > this.writeLockStaleMs;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        return false;
      }
      throw error;
    }
  }

  private async sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Yield the event loop so HTTP handlers can process between chunks of heavy work.
   * Uses setImmediate which fires after I/O callbacks but before setTimeout(0).
   */
  private yieldEventLoop(): Promise<void> {
    return new Promise((resolve) => setImmediate(resolve));
  }

  private getLoadKey(sessionDir: string, projectId: UrlProjectId): string {
    return `${sessionDir}::${projectId}`;
  }

  private getTitleLoadKey(
    sessionDir: string,
    projectId: UrlProjectId,
    sessionId: string,
  ): string {
    return `${sessionDir}::${projectId}::${sessionId}`;
  }

  private markSessionDirty(sessionDir: string, sessionId: string): void {
    const current = this.dirtySessionsByDir.get(sessionDir) ?? new Set();
    current.add(sessionId);
    this.dirtySessionsByDir.set(sessionDir, current);
  }

  private markDirDirty(sessionDir: string): void {
    this.dirtyDirs.add(sessionDir);
  }

  private clearDirDirtyState(sessionDir: string): void {
    this.dirtyDirs.delete(sessionDir);
    this.dirtySessionsByDir.delete(sessionDir);
  }

  private buildSummariesFromIndex(
    index: SessionIndexState,
    projectId: UrlProjectId,
  ): SessionSummary[] {
    const summaries: SessionSummary[] = [];

    for (const [sessionId, cached] of Object.entries(index.sessions)) {
      if (cached.isEmpty) continue;
      summaries.push({
        id: sessionId,
        projectId,
        title: cached.title,
        fullTitle: cached.fullTitle,
        createdAt: cached.createdAt,
        updatedAt: cached.updatedAt,
        messageCount: cached.messageCount,
        ownership: { owner: "none" },
        contextUsage: cached.contextUsage,
        provider: cached.provider ?? DEFAULT_PROVIDER,
      });
    }

    summaries.sort(
      (a, b) =>
        new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
    );

    return summaries;
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
    mode: "fast" | "stale" | "incremental" | "full",
    durationMs: number,
    statCalls: number,
    parseCalls: number,
    sessionDir: string,
  ): void {
    this.cacheStats.requests += 1;
    this.cacheStats.statCalls += statCalls;
    this.cacheStats.parseCalls += parseCalls;
    this.cacheStats.totalDurationMs += durationMs;

    if (mode === "fast") this.cacheStats.fastHits += 1;
    if (mode === "stale") this.cacheStats.staleHits += 1;
    if (mode === "incremental") this.cacheStats.incrementalRuns += 1;
    if (mode === "full") this.cacheStats.fullScans += 1;

    if (LOG_CACHE_PERF || durationMs >= 250) {
      logger.info(
        `[SessionIndexService] mode=${mode} dir=${sessionDir} durationMs=${durationMs} statCalls=${statCalls} parseCalls=${parseCalls}`,
      );
    }
  }

  /**
   * Handle watcher events for claude session files so requests can avoid full rescans.
   */
  private handleFileChange(event: FileChangeEvent): void {
    if (event.provider !== "claude" || event.fileType !== "session") {
      return;
    }

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
  }

  private async applyIncrementalDirtyUpdates(
    sessionDir: string,
    projectId: UrlProjectId,
    reader: ISessionReader,
    index: SessionIndexState,
  ): Promise<{ indexChanged: boolean; statCalls: number; parseCalls: number }> {
    const dirty = this.dirtySessionsByDir.get(sessionDir);
    if (!dirty || dirty.size === 0) {
      return { indexChanged: false, statCalls: 0, parseCalls: 0 };
    }

    let indexChanged = false;
    let statCalls = 0;
    let parseCalls = 0;
    let iterCount = 0;

    for (const sessionId of Array.from(dirty)) {
      if (++iterCount % 5 === 0) {
        await this.yieldEventLoop();
      }
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

      parseCalls += 1;
      const summary = await reader.getSessionSummary(sessionId, projectId);
      const filePath = path.join(sessionDir, `${sessionId}.jsonl`);

      if (summary) {
        try {
          const stats = await fs.stat(filePath);
          statCalls += 1;
          index.sessions[sessionId] = this.toCachedSummary(
            summary,
            stats.mtimeMs,
            stats.size,
          );
          indexChanged = true;
        } catch {
          // Ignore race where file disappeared after read.
        }
        continue;
      }

      try {
        const stats = await fs.stat(filePath);
        statCalls += 1;
        index.sessions[sessionId] = this.toEmptyCachedSummary(
          stats.mtimeMs,
          stats.size,
        );
        indexChanged = true;
      } catch {
        if (index.sessions[sessionId]) {
          delete index.sessions[sessionId];
          indexChanged = true;
        }
      }
    }

    this.dirtySessionsByDir.delete(sessionDir);
    return { indexChanged, statCalls, parseCalls };
  }

  private async runFullValidation(
    sessionDir: string,
    projectId: UrlProjectId,
    reader: ISessionReader,
    index: SessionIndexState,
  ): Promise<{
    summaries: SessionSummary[];
    statCalls: number;
    parseCalls: number;
  }> {
    const summaries: SessionSummary[] = [];
    const seenSessionIds = new Set<string>();
    let indexChanged = false;
    let statCalls = 0;
    let parseCalls = 0;

    try {
      const files = await fs.readdir(sessionDir);
      const jsonlFiles = files.filter(
        (f) => f.endsWith(".jsonl") && !f.startsWith("agent-"),
      );

      const STAT_BATCH = 100;
      const allStats: (Stats | null)[] = new Array(jsonlFiles.length);
      for (let b = 0; b < jsonlFiles.length; b += STAT_BATCH) {
        const end = Math.min(b + STAT_BATCH, jsonlFiles.length);
        const batch = await Promise.all(
          jsonlFiles
            .slice(b, end)
            .map((f) => fs.stat(path.join(sessionDir, f)).catch(() => null)),
        );
        statCalls += batch.length;
        for (let j = 0; j < batch.length; j++) {
          allStats[b + j] = batch[j] ?? null;
        }
        await this.yieldEventLoop();
      }

      const cacheMisses: {
        sessionId: string;
        mtime: number;
        size: number;
      }[] = [];

      for (let i = 0; i < jsonlFiles.length; i++) {
        const file = jsonlFiles[i];
        if (!file) continue;
        const sessionId = file.replace(".jsonl", "");
        seenSessionIds.add(sessionId);

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
          if (cached.isEmpty) continue;
          summaries.push({
            id: sessionId,
            projectId,
            title: cached.title,
            fullTitle: cached.fullTitle,
            createdAt: cached.createdAt,
            updatedAt: cached.updatedAt,
            messageCount: cached.messageCount,
            ownership: { owner: "none" },
            contextUsage: cached.contextUsage,
            provider: cached.provider ?? DEFAULT_PROVIDER,
          });
        } else {
          cacheMisses.push({ sessionId, mtime, size });
        }
      }

      for (let mi = 0; mi < cacheMisses.length; mi++) {
        const miss = cacheMisses[mi];
        if (!miss) continue;
        const { sessionId, mtime, size } = miss;
        if (mi > 0 && mi % 5 === 0) {
          await this.yieldEventLoop();
        }
        parseCalls += 1;
        const summary = await reader.getSessionSummary(sessionId, projectId);
        if (summary) {
          summaries.push(summary);
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

      for (const sessionId of Object.keys(index.sessions)) {
        if (!seenSessionIds.has(sessionId)) {
          delete index.sessions[sessionId];
          indexChanged = true;
        }
      }

      if (indexChanged) {
        await this.saveIndex(sessionDir);
      }

      summaries.sort(
        (a, b) =>
          new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
      );
      this.lastFullValidationAt.set(sessionDir, Date.now());
      this.clearDirDirtyState(sessionDir);

      return { summaries, statCalls, parseCalls };
    } catch {
      return { summaries: [], statCalls, parseCalls };
    }
  }

  getDebugStats(): {
    requests: number;
    fastHits: number;
    staleHits: number;
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

  /**
   * Trigger a background full validation for a directory, deduped by sessionDir.
   * Fire-and-forget: errors are logged but never thrown to the caller.
   */
  private triggerBackgroundValidation(
    sessionDir: string,
    projectId: UrlProjectId,
    reader: ISessionReader,
    index: SessionIndexState,
  ): void {
    if (this.backgroundValidations.has(sessionDir)) return;

    const promise = this.runFullValidation(sessionDir, projectId, reader, index)
      .then(({ statCalls, parseCalls }) => {
        if (LOG_CACHE_PERF) {
          logger.info(
            `[SessionIndexService] background validation complete dir=${sessionDir} statCalls=${statCalls} parseCalls=${parseCalls}`,
          );
        }
      })
      .catch((err) => {
        logger.warn(
          { err },
          `[SessionIndexService] Background validation failed for ${sessionDir}`,
        );
      })
      .finally(() => {
        this.backgroundValidations.delete(sessionDir);
      });

    this.backgroundValidations.set(sessionDir, promise);
  }

  /**
   * Get sessions using the cache, only re-parsing files that have changed.
   * This is the main entry point for listing sessions with caching.
   */
  async getSessionsWithCache(
    sessionDir: string,
    projectId: UrlProjectId,
    reader: ISessionReader,
  ): Promise<SessionSummary[]> {
    const loadKey = this.getLoadKey(sessionDir, projectId);
    const inFlight = this.inFlightSessionLoads.get(loadKey);
    if (inFlight) {
      return inFlight;
    }

    const promise = this.getSessionsWithCacheInternal(
      sessionDir,
      projectId,
      reader,
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
  ): Promise<SessionSummary[]> {
    const start = Date.now();
    const index = await this.loadIndex(sessionDir, projectId);
    const now = Date.now();
    const lastFullValidation = this.lastFullValidationAt.get(sessionDir) ?? 0;
    const hasDirDirty = this.dirtyDirs.has(sessionDir);
    const dirtySessions = this.dirtySessionsByDir.get(sessionDir);
    const hasDirtySessions = Boolean(dirtySessions && dirtySessions.size > 0);

    const fullValidationDue =
      this.fullValidationIntervalMs <= 0 ||
      lastFullValidation === 0 ||
      now - lastFullValidation >= this.fullValidationIntervalMs;

    // Fast path: no dirty signals and recent full validation.
    if (!fullValidationDue && !hasDirDirty && !hasDirtySessions) {
      const summaries = this.buildSummariesFromIndex(index, projectId);
      this.recordCallStats("fast", Date.now() - start, 0, 0, sessionDir);
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
        await this.saveIndex(sessionDir);
      }
      const summaries = this.buildSummariesFromIndex(index, projectId);
      this.recordCallStats(
        "incremental",
        Date.now() - start,
        incremental.statCalls,
        incremental.parseCalls,
        sessionDir,
      );
      return summaries;
    }

    // Stale-while-revalidate: when a positive validation interval is configured
    // and has elapsed, return cached data immediately and refresh in the background.
    // This avoids blocking HTTP requests during heavy scans.
    // Does NOT apply when fullValidationIntervalMs <= 0 (always-validate mode).
    const hasCachedData = Object.keys(index.sessions).length > 0;
    if (
      fullValidationDue &&
      hasCachedData &&
      this.fullValidationIntervalMs > 0
    ) {
      const summaries = this.buildSummariesFromIndex(index, projectId);
      this.triggerBackgroundValidation(sessionDir, projectId, reader, index);
      this.recordCallStats("stale", Date.now() - start, 0, 0, sessionDir);
      return summaries;
    }

    // Full validation path: either always-validate mode or no cached data.
    const full = await this.runFullValidation(
      sessionDir,
      projectId,
      reader,
      index,
    );
    this.recordCallStats(
      "full",
      Date.now() - start,
      full.statCalls,
      full.parseCalls,
      sessionDir,
    );
    return full.summaries;
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
    this.clearDirDirtyState(sessionDir);
    this.lastFullValidationAt.delete(sessionDir);
  }

  /**
   * Get the data directory for testing purposes.
   */
  getDataDir(): string {
    return this.dataDir;
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
    const loadKey = this.getTitleLoadKey(sessionDir, projectId, sessionId);
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
    const index = await this.loadIndex(sessionDir, projectId);
    const cached = index.sessions[sessionId];
    const filePath = path.join(sessionDir, `${sessionId}.jsonl`);

    try {
      const stats = await fs.stat(filePath);
      const mtime = stats.mtimeMs;
      const size = stats.size;

      if (
        cached &&
        cached.fileMtime === mtime &&
        cached.indexedBytes === size
      ) {
        if (cached.isEmpty) return null;
        return cached.title;
      }

      const summary = await reader.getSessionSummary(sessionId, projectId);
      if (summary) {
        index.sessions[sessionId] = this.toCachedSummary(summary, mtime, size);
        await this.saveIndex(sessionDir);
        return summary.title;
      }

      index.sessions[sessionId] = this.toEmptyCachedSummary(mtime, size);
      await this.saveIndex(sessionDir);
    } catch {
      // File error - return null
    }

    return null;
  }

  /**
   * Pre-warm the cache for all Claude projects.
   * Call fire-and-forget after the server starts listening so the cache
   * is warm before clients connect. With stale-while-revalidate, clients
   * connecting during pre-warm get cached data (if persisted index exists)
   * instantly.
   */
  async prewarm(
    scanner: { listProjects(): Promise<Project[]> },
    readerFactory: (project: Project) => ISessionReader,
  ): Promise<void> {
    try {
      const projects = await scanner.listProjects();
      const claudeProjects = projects.filter((p) => p.provider === "claude");
      if (claudeProjects.length === 0) return;

      logger.info(
        `[SessionIndexService] Pre-warming cache for ${claudeProjects.length} Claude projects`,
      );

      for (const project of claudeProjects) {
        try {
          const reader = readerFactory(project);
          await this.getSessionsWithCache(
            project.sessionDir,
            project.id,
            reader,
          );
        } catch (err) {
          logger.warn(
            { err },
            `[SessionIndexService] Pre-warm failed for ${project.name}`,
          );
        }
        await this.yieldEventLoop();
      }

      logger.info("[SessionIndexService] Pre-warm complete");

      // Pre-warm Gemini shared scan cache - one reader scan populates the
      // shared cache used by all Gemini readers, avoiding 314MB+ cold reads
      // on first client request.
      const geminiProjects = projects.filter((p) => p.provider === "gemini");
      const firstGemini = projects.find((p) => p.provider === "gemini");
      if (firstGemini) {
        logger.info(
          `[SessionIndexService] Pre-warming Gemini scan cache (${geminiProjects.length} projects)`,
        );
        try {
          const reader = readerFactory(firstGemini);
          await reader.listSessions(firstGemini.id);
          logger.info("[SessionIndexService] Gemini pre-warm complete");
        } catch (err) {
          logger.warn(
            { err },
            "[SessionIndexService] Gemini pre-warm failed",
          );
        }
      }
    } catch (err) {
      logger.warn(
        { err },
        "[SessionIndexService] Pre-warm failed to list projects",
      );
    }
  }

  dispose(): void {
    this.unsubscribeEventBus?.();
    this.unsubscribeEventBus = null;
  }
}
