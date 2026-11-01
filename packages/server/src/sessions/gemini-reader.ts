/**
 * GeminiSessionReader - Reads Gemini sessions from disk.
 *
 * Gemini stores sessions at ~/.gemini/tmp/<projectHash>/chats/session-*.json
 * with a different format than Claude or Codex:
 * - JSON files (not JSONL)
 * - sessionId, projectHash, startTime, lastUpdated
 * - messages[] array with user and gemini message types
 *
 * Unlike Claude's DAG structure, Gemini sessions are linear.
 */

import { readFile, readdir, stat } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import {
  type GeminiAssistantMessage,
  type GeminiSessionMessage,
  type GeminiUserMessage,
  type UrlProjectId,
  type NativeSessionId,
  getGeminiUserMessageText,
  getModelContextWindow,
  parseGeminiSessionFile,
  truncateSessionTitle,
} from "@yep-anywhere/shared";
import { resolveNativeSessionRef } from "./SessionIdentityStore.js";
import { hashProjectPath } from "../projects/gemini-project-map.js";
import type {
  ContextUsage,
  Message,
  SessionSummary,
} from "../supervisor/types.js";
import type {
  GetSessionOptions,
  ISessionReader,
  LoadedSession,
} from "./types.js";
import {
  canonicalizeProjectPath,
  getProjectIdentityKey,
} from "../projects/paths.js";

export interface GeminiSessionReaderOptions {
  /**
   * Base directory for Gemini sessions (~/.gemini/tmp).
   * Sessions are stored in <projectHash>/chats/session-*.json structure.
   */
  sessionsDir: string;
  /**
   * The project path (cwd) to filter sessions by.
   * Only sessions with this cwd will be listed.
   */
  projectPath?: string;
  /**
   * Optional map of projectHash -> cwd for filtering.
   * If not provided, all sessions will be listed.
   * Can be a Map or a Promise that resolves to a Map.
   */
  hashToCwd?: Map<string, string> | Promise<Map<string, string>>;
}

interface GeminiSessionCacheEntry {
  id: string;
  filePath: string;
  projectHash: string;
  startTime: string;
  mtime: number;
  size: number;
}

/**
 * Gemini-specific session reader for Gemini CLI JSON files.
 *
 * Handles Gemini's linear conversation structure with user and gemini messages.
 */
export class GeminiSessionReader implements ISessionReader {
  private closed = false;
  private sessionsDir: string;
  private projectPath?: string;
  private projectIdentityKey?: string;
  private hashToCwd?: Map<string, string> | Promise<Map<string, string>>;

  // Cache of session ID -> file info for quick lookups. Small metadata,
  // bounded by the Gemini session files on disk.
  private sessionFileCache: Map<string, GeminiSessionCacheEntry> = new Map();
  private cacheTimestamp = 0;
  private readonly CACHE_TTL_MS = 5000; // 5 second cache

  constructor(options: GeminiSessionReaderOptions) {
    this.sessionsDir = options.sessionsDir;
    this.projectPath = options.projectPath
      ? canonicalizeProjectPath(options.projectPath)
      : undefined;
    this.projectIdentityKey = this.projectPath
      ? getProjectIdentityKey(this.projectPath)
      : undefined;
    this.hashToCwd = options.hashToCwd;
  }

  private async belongsToProject(projectHash: string): Promise<boolean> {
    if (this.closed || typeof projectHash !== "string") return false;
    if (!this.projectPath) return true;
    // Native discovery retains unknown projects under this existing coordinate.
    if (/^gemini:[a-f0-9]{8}$/.test(this.projectPath))
      return projectHash.startsWith(this.projectPath.slice(7));
    if (projectHash === hashProjectPath(this.projectPath)) return true;
    const map = await this.hashToCwd;
    const cwd = map?.get(projectHash);
    return (
      !this.closed &&
      !!cwd &&
      getProjectIdentityKey(cwd) === this.projectIdentityKey
    );
  }

  private async readStoredSession(entry: GeminiSessionCacheEntry) {
    if (this.closed) return null;
    try {
      const stats = await stat(entry.filePath);
      if (this.closed) return null;
      const session = parseGeminiSessionFile(
        await readFile(entry.filePath, "utf8"),
      );
      if (this.closed || !session) return null;
      if (
        session.sessionId !== entry.id ||
        session.projectHash !== entry.projectHash ||
        !Array.isArray(session.messages) ||
        !(await this.belongsToProject(session.projectHash))
      ) {
        this.sessionFileCache.delete(entry.id);
        this.cacheTimestamp = 0;
        return null;
      }
      if (this.closed) return null;
      entry.mtime = stats.mtimeMs;
      entry.size = stats.size;
      return { session, stats };
    } catch {
      return null;
    }
  }

  async listSessions(projectId: UrlProjectId): Promise<SessionSummary[]> {
    const summaries: SessionSummary[] = [];
    const sessions = await this.scanSessions();
    if (this.closed) return [];
    for (const session of sessions) {
      const summary = await this.getSessionSummary(session.id, projectId);
      if (this.closed) return [];
      if (summary) summaries.push(summary);
    }
    summaries.sort(
      (a, b) =>
        new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
    );
    return this.closed ? [] : summaries;
  }

  async getSessionSummary(
    sessionId: string,
    projectId: UrlProjectId,
  ): Promise<SessionSummary | null> {
    const entry = await this.findSessionFile(sessionId);
    if (this.closed || !entry) return null;
    const loaded = await this.readStoredSession(entry);
    if (this.closed || !loaded || loaded.session.messages.length === 0)
      return null;
    const { session, stats } = loaded;
    const { title, fullTitle } = this.extractTitle(session.messages);
    const model = this.extractModel(session.messages);
    return {
      id: sessionId,
      projectId,
      title,
      fullTitle,
      createdAt: session.startTime,
      updatedAt: session.lastUpdated ?? stats.mtime.toISOString(),
      messageCount: session.messages.length,
      ownership: { owner: "none" },
      contextUsage: this.extractContextUsage(session.messages, model),
      provider: "gemini",
      model,
    };
  }

  async getSession(
    sessionId: string,
    projectId: UrlProjectId,
    afterMessageId?: string,
    _options?: GetSessionOptions,
  ): Promise<LoadedSession | null> {
    const summary = await this.getSessionSummary(sessionId, projectId);
    if (this.closed || !summary) return null;
    const entry = await this.findSessionFile(sessionId);
    if (this.closed || !entry) return null;
    const loaded = await this.readStoredSession(entry);
    if (this.closed || !loaded) return null;
    const sessionFile = loaded.session;
    let messages = sessionFile.messages;
    if (afterMessageId) {
      const afterIndex = messages.findIndex((m) => m.id === afterMessageId);
      if (afterIndex !== -1) messages = messages.slice(afterIndex + 1);
    }
    return {
      summary,
      transcriptSnapshotUpdatedAt:
        sessionFile.lastUpdated ?? loaded.stats.mtime.toISOString(),
      data: { provider: "gemini", session: { ...sessionFile, messages } },
    };
  }

  async getSessionSummaryIfChanged(
    sessionId: string,
    projectId: UrlProjectId,
    cachedMtime: number,
    cachedSize: number,
  ): Promise<{ summary: SessionSummary; mtime: number; size: number } | null> {
    const entry = await this.findSessionFile(sessionId);
    if (this.closed || !entry) return null;
    const stats = await stat(entry.filePath).catch(() => null);
    if (
      this.closed ||
      !stats ||
      (stats.mtimeMs === cachedMtime && stats.size === cachedSize)
    )
      return null;
    const summary = await this.getSessionSummary(sessionId, projectId);
    return !this.closed && summary
      ? { summary, mtime: stats.mtimeMs, size: stats.size }
      : null;
  }

  /**
   * Gemini doesn't have subagent sessions like Claude.
   * Returns empty array for compatibility.
   */
  async getAgentMappings(): Promise<{ toolUseId: string; agentId: string }[]> {
    return [];
  }

  /**
   * Gemini doesn't have subagent sessions like Claude.
   * Returns null for compatibility.
   */
  async getAgentSession(
    _agentId: string,
  ): Promise<{ messages: Message[]; status: string } | null> {
    return null;
  }

  async getSessionFilePath(sessionId: string): Promise<string | null> {
    const entry = await this.findSessionFile(sessionId);
    if (this.closed || !entry) return null;
    return (await this.readStoredSession(entry)) && !this.closed
      ? entry.filePath
      : null;
  }

  async getNativeSessionRef(sessionId: NativeSessionId) {
    const entry = await this.findSessionFile(sessionId);
    if (this.closed || !entry || !(await this.readStoredSession(entry)))
      return null;
    if (this.closed) return null;
    const native = await resolveNativeSessionRef(
      "gemini",
      this.sessionsDir,
      sessionId,
    ).catch(() => null);
    return this.closed ? null : native;
  }

  getIndexScopeKey(_sessionDir: string): string {
    return `gemini::${JSON.stringify([this.sessionsDir, this.projectIdentityKey ?? "*"])}`;
  }

  close(): void {
    this.closed = true;
    this.sessionFileCache.clear();
  }

  /**
   * Enumerate session files in a directory for SessionIndexService.
   * Reads each file to extract the sessionId (not derivable from filename).
   */
  async listSessionFiles(
    sessionDir: string,
  ): Promise<{ sessionId: string; filePath: string }[]> {
    const results: { sessionId: string; filePath: string }[] = [];
    const directory = relative(this.sessionsDir, sessionDir);
    if (
      this.closed ||
      directory === ".." ||
      directory.startsWith(`..${sep}`) ||
      isAbsolute(directory)
    )
      return [];
    if (directory === "") {
      // The index owner requests enumeration after invalidation or validation;
      // its freshness boundary must not inherit the point-lookup TTL.
      const sessions = await this.scanSessions(true);
      return this.closed
        ? []
        : sessions.map((entry) => ({
            sessionId: entry.id,
            filePath: entry.filePath,
          }));
    }
    try {
      const entries = await readdir(sessionDir, { withFileTypes: true });
      for (const entry of entries) {
        if (this.closed) return [];
        if (
          entry.isFile() &&
          entry.name.startsWith("session-") &&
          entry.name.endsWith(".json")
        ) {
          const filePath = join(sessionDir, entry.name);
          try {
            const content = await readFile(filePath, "utf-8");
            const session = parseGeminiSessionFile(content);
            if (
              session &&
              typeof session.sessionId === "string" &&
              (await this.belongsToProject(session.projectHash))
            ) {
              if (this.closed) return [];
              results.push({ sessionId: session.sessionId, filePath });
            }
          } catch {
            // Skip unreadable files
          }
        }
      }
    } catch {
      // Directory doesn't exist or unreadable
    }
    return this.closed ? [] : results;
  }

  /**
   * Scan the sessions directory and find all session files.
   */
  private async scanSessions(
    force = false,
  ): Promise<GeminiSessionCacheEntry[]> {
    if (this.closed) return [];
    // Check cache
    if (!force && Date.now() - this.cacheTimestamp < this.CACHE_TTL_MS) {
      return Array.from(this.sessionFileCache.values());
    }

    const sessions: GeminiSessionCacheEntry[] = [];
    this.sessionFileCache.clear();

    try {
      await stat(this.sessionsDir);
    } catch {
      // Directory doesn't exist
      return [];
    }

    // Scan ~/.gemini/tmp/{dirName}/chats/*.json
    // dirName may be a slug (v0.29+) or a SHA-256 hash (older CLI)
    const projectDirs = await this.findProjectDirs();

    for (const { dir, dirName } of projectDirs) {
      if (this.closed) return [];
      const chatsDir = join(dir, "chats");
      try {
        await stat(chatsDir);
        const files = await this.findSessionFiles(chatsDir);

        for (const filePath of files) {
          const session = await this.readSessionMeta(filePath, dirName);
          if (this.closed) return [];
          if (session) {
            sessions.push(session);
            this.sessionFileCache.set(session.id, session);
          }
        }
      } catch {
        // Chats directory doesn't exist, skip
      }
    }

    if (this.closed) return [];
    this.cacheTimestamp = Date.now();
    return sessions;
  }

  /**
   * Find all project directories in ~/.gemini/tmp/
   * Directory names may be slugs (v0.29+) or SHA-256 hashes (older CLI).
   */
  private async findProjectDirs(): Promise<{ dir: string; dirName: string }[]> {
    const dirs: { dir: string; dirName: string }[] = [];

    try {
      const entries = await readdir(this.sessionsDir, { withFileTypes: true });

      for (const entry of entries) {
        if (entry.isDirectory()) {
          dirs.push({
            dir: join(this.sessionsDir, entry.name),
            dirName: entry.name,
          });
        }
      }
    } catch {
      // Ignore errors
    }

    return dirs;
  }

  /**
   * Find all session JSON files in a chats directory.
   */
  private async findSessionFiles(chatsDir: string): Promise<string[]> {
    const files: string[] = [];

    try {
      const entries = await readdir(chatsDir, { withFileTypes: true });

      for (const entry of entries) {
        if (
          entry.isFile() &&
          entry.name.startsWith("session-") &&
          entry.name.endsWith(".json")
        ) {
          files.push(join(chatsDir, entry.name));
        }
      }
    } catch {
      // Ignore errors
    }

    return files;
  }

  /**
   * Find a session file by ID.
   */
  private async findSessionFile(
    sessionId: string,
  ): Promise<GeminiSessionCacheEntry | null> {
    if (this.closed) return null;
    // Check cache first
    const cached = this.sessionFileCache.get(sessionId);
    if (cached)
      return (await this.belongsToProject(cached.projectHash)) && !this.closed
        ? cached
        : null;

    // Scan if cache miss
    await this.scanSessions();
    return this.closed ? null : (this.sessionFileCache.get(sessionId) ?? null);
  }

  /**
   * Read session metadata from a file.
   */
  private async readSessionMeta(
    filePath: string,
    _dirName: string,
  ): Promise<GeminiSessionCacheEntry | null> {
    try {
      const stats = await stat(filePath);
      const content = await readFile(filePath, "utf-8");
      const session = parseGeminiSessionFile(content);

      if (
        this.closed ||
        !session ||
        typeof session.sessionId !== "string" ||
        !Array.isArray(session.messages) ||
        !(await this.belongsToProject(session.projectHash))
      )
        return null;
      if (this.closed) return null;
      return {
        id: session.sessionId,
        filePath,
        // Use projectHash from file content (SHA-256), not directory name.
        // Gemini CLI ≥ v0.29 uses slug-based directory names instead of hashes.
        projectHash: session.projectHash,
        startTime: session.startTime,
        mtime: stats.mtimeMs,
        size: stats.size,
      };
    } catch {
      return null;
    }
  }

  /**
   * Extract title from messages (first user message).
   */
  private extractTitle(messages: GeminiSessionMessage[]): {
    title: string | null;
    fullTitle: string | null;
  } {
    // Find first user message
    for (const msg of messages) {
      if (msg.type === "user") {
        const userMsg = msg as GeminiUserMessage;
        const fullTitle = getGeminiUserMessageText(userMsg.content).trim();
        const title = truncateSessionTitle(fullTitle) || null;
        return { title, fullTitle };
      }
    }

    return { title: null, fullTitle: null };
  }

  /**
   * Extract context usage from token counts in messages.
   *
   * @param messages - Gemini session messages
   * @param model - Model ID for determining context window size
   */
  private extractContextUsage(
    messages: GeminiSessionMessage[],
    model: string | undefined,
  ): ContextUsage | undefined {
    const contextWindowSize = getModelContextWindow(model);

    // Find last assistant message with token info
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg && msg.type === "gemini") {
        const assistantMsg = msg as GeminiAssistantMessage;
        if (assistantMsg.tokens?.input) {
          const inputTokens =
            assistantMsg.tokens.input + (assistantMsg.tokens.cached ?? 0);
          const percentage = Math.round(
            (inputTokens / contextWindowSize) * 100,
          );

          return { inputTokens, percentage, contextWindow: contextWindowSize };
        }
      }
    }

    return undefined;
  }

  /**
   * Extract the model from the most recent assistant message (a session's
   * model can change mid-transcript).
   */
  private extractModel(messages: GeminiSessionMessage[]): string | undefined {
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg?.type === "gemini") {
        const assistantMsg = msg as GeminiAssistantMessage;
        if (assistantMsg.model) {
          return assistantMsg.model;
        }
      }
    }
    return undefined;
  }
}
