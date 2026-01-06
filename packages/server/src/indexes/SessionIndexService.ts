/**
 * SessionIndexService caches session summaries to avoid re-parsing JSONL files.
 * Uses mtime/size for cache invalidation - only re-parses when files change.
 *
 * State is persisted to JSON files for durability across server restarts.
 * Each project's session directory gets its own index file.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  DEFAULT_PROVIDER,
  type ProviderName,
  type UrlProjectId,
} from "@yep-anywhere/shared";
import { getLogger } from "../logging/logger.js";
import type { ISessionReader } from "../sessions/types.js";
import type { SessionSummary } from "../supervisor/types.js";
import type { ISessionIndexService } from "./types.js";

const logger = getLogger();

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

  constructor(options: SessionIndexServiceOptions = {}) {
    const home = process.env.HOME ?? process.env.USERPROFILE ?? ".";
    this.dataDir =
      options.dataDir ?? path.join(home, ".yep-anywhere", "indexes");
    this.projectsDir =
      options.projectsDir ?? path.join(home, ".claude", "projects");
    this.maxCacheSize = options.maxCacheSize ?? 10000;
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
    const encoded = relative.replace(/\//g, "%2F");
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

    try {
      // Ensure directory exists
      await fs.mkdir(path.dirname(indexPath), { recursive: true });
      const content = JSON.stringify(index, null, 2);
      await fs.writeFile(indexPath, content, "utf-8");
    } catch (error) {
      logger.error(
        { err: error },
        `[SessionIndexService] Failed to save index for ${sessionDir}`,
      );
      throw error;
    }
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
    const index = await this.loadIndex(sessionDir, projectId);
    const summaries: SessionSummary[] = [];
    const seenSessionIds = new Set<string>();
    let indexChanged = false;

    try {
      const files = await fs.readdir(sessionDir);
      // Filter out agent-* files (internal subagent warmup sessions)
      const jsonlFiles = files.filter(
        (f) => f.endsWith(".jsonl") && !f.startsWith("agent-"),
      );

      for (const file of jsonlFiles) {
        const sessionId = file.replace(".jsonl", "");
        seenSessionIds.add(sessionId);

        const cached = index.sessions[sessionId];
        const filePath = path.join(sessionDir, file);

        try {
          const stats = await fs.stat(filePath);
          const mtime = stats.mtimeMs;
          const size = stats.size;

          // Check if cache is valid
          if (
            cached &&
            cached.fileMtime === mtime &&
            cached.indexedBytes === size
          ) {
            // Cache hit - skip if empty (no user/assistant messages)
            if (cached.isEmpty) {
              // Empty session - already cached, skip silently
              continue;
            }
            // Cache hit - reconstruct SessionSummary from cache
            /*
            logger.debug(
              `[SessionIndexService] Cache HIT for ${sessionId} (mtime=${mtime}, size=${size})`,
            );
            */
            summaries.push({
              id: sessionId,
              projectId,
              title: cached.title,
              fullTitle: cached.fullTitle,
              createdAt: cached.createdAt,
              updatedAt: cached.updatedAt,
              messageCount: cached.messageCount,
              status: { state: "idle" },
              contextUsage: cached.contextUsage,
              provider: cached.provider ?? DEFAULT_PROVIDER,
            });
          } else {
            // Cache miss - parse the file
            logger.debug(
              `[SessionIndexService] Cache MISS for ${sessionId}: cached=${!!cached}, mtime match=${cached?.fileMtime === mtime}, size match=${cached?.indexedBytes === size}`,
            );
            const summary = await reader.getSessionSummary(
              sessionId,
              projectId,
            );
            if (summary) {
              summaries.push(summary);

              // Update cache
              index.sessions[sessionId] = {
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
              indexChanged = true;
            } else {
              // Empty session (no user/assistant messages) - cache it to avoid re-parsing
              index.sessions[sessionId] = {
                title: null,
                fullTitle: null,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
                messageCount: 0,
                indexedBytes: size,
                fileMtime: mtime,
                isEmpty: true,
                provider: DEFAULT_PROVIDER,
              };
              indexChanged = true;
            }
          }
        } catch {
          // File error - skip this session
        }
      }

      // Remove deleted sessions from cache
      for (const sessionId of Object.keys(index.sessions)) {
        if (!seenSessionIds.has(sessionId)) {
          delete index.sessions[sessionId];
          indexChanged = true;
        }
      }

      // Save index if it changed
      if (indexChanged) {
        await this.saveIndex(sessionDir);
      }
    } catch {
      // Directory doesn't exist or not readable
      return [];
    }

    // Sort by updatedAt descending
    summaries.sort(
      (a, b) =>
        new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
    );

    return summaries;
  }

  /**
   * Invalidate the cache for a specific session.
   * Call this when you know a session file has been modified.
   */
  invalidateSession(sessionDir: string, sessionId: string): void {
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
    const index = await this.loadIndex(sessionDir, projectId);
    const cached = index.sessions[sessionId];
    const filePath = path.join(sessionDir, `${sessionId}.jsonl`);

    try {
      const stats = await fs.stat(filePath);
      const mtime = stats.mtimeMs;
      const size = stats.size;

      // Check if cache is valid
      if (
        cached &&
        cached.fileMtime === mtime &&
        cached.indexedBytes === size
      ) {
        // Return null for empty sessions
        if (cached.isEmpty) {
          return null;
        }
        return cached.title;
      }

      // Cache miss - parse the file
      const summary = await reader.getSessionSummary(sessionId, projectId);
      if (summary) {
        // Update cache
        index.sessions[sessionId] = {
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
        await this.saveIndex(sessionDir);
        return summary.title;
      }
      // Empty session - cache it to avoid re-parsing
      index.sessions[sessionId] = {
        title: null,
        fullTitle: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        messageCount: 0,
        indexedBytes: size,
        fileMtime: mtime,
        isEmpty: true,
        provider: DEFAULT_PROVIDER,
      };
      await this.saveIndex(sessionDir);
    } catch {
      // File error - return null
    }

    return null;
  }
}
