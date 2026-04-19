/**
 * GeminiSessionScanner - Scans Gemini sessions and groups them by project.
 *
 * Gemini stores sessions at ~/.gemini/tmp/<dirName>/chats/session-*.json
 * where dirName is either a human-readable slug (Gemini CLI ≥ v0.29) or a
 * SHA-256 hash of the working directory (older versions).
 *
 * The real projectHash (SHA-256) is inside each session JSON file and is used
 * to resolve the original CWD via GeminiProjectMap.
 */

import { readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import {
  type GeminiSessionFile,
  parseGeminiSessionFile,
} from "@yep-anywhere/shared";
import type { Project } from "../supervisor/types.js";
import {
  GEMINI_DIR,
  GEMINI_TMP_DIR,
  geminiProjectMap,
  hashProjectPath,
} from "./gemini-project-map.js";
import { encodeProjectId } from "./paths.js";

// Re-export constants for compatibility
export { GEMINI_DIR, GEMINI_TMP_DIR, hashProjectPath };

interface GeminiSessionInfo {
  id: string;
  /** SHA-256 hash from inside the session JSON (used for project-map lookups) */
  projectHash: string;
  /** Actual directory name on disk (may be a slug or a hash) */
  dirName: string;
  filePath: string;
  startTime: string;
  mtime: number;
}

export interface GeminiScannerOptions {
  sessionsDir?: string; // override for testing (~/.gemini/tmp)
}

/** How long to cache scan results (ms) */
const SCAN_CACHE_TTL = 5_000;

export class GeminiSessionScanner {
  private sessionsDir: string;
  private cachedScan: {
    result: GeminiSessionInfo[];
    timestamp: number;
  } | null = null;

  constructor(options: GeminiScannerOptions = {}) {
    this.sessionsDir = options.sessionsDir ?? GEMINI_TMP_DIR;
  }

  invalidateCache(): void {
    this.cachedScan = null;
  }

  /**
   * Register known project paths for hash resolution.
   * Call this with paths from Claude/Codex projects to enable cwd lookup.
   */
  async registerKnownPaths(paths: string[]): Promise<void> {
    for (const path of paths) {
      await geminiProjectMap.register(path);
    }
  }

  /**
   * Get the hash-to-cwd mapping for use by readers.
   * Note: This is now async as it loads from disk.
   */
  async getHashToCwd(): Promise<Map<string, string>> {
    return geminiProjectMap.getAll();
  }

  /**
   * Scan all Gemini sessions and group them by project (cwd or hash).
   * Returns projects sorted by last activity (most recent first).
   */
  async listProjects(): Promise<Project[]> {
    const sessions = await this.scanAllSessions();
    await geminiProjectMap.load();

    // Group sessions by cwd (if known) or projectHash
    const projectMap = new Map<
      string,
      {
        sessions: GeminiSessionInfo[];
        lastActivity: number;
        cwd: string | null;
        projectHash: string;
        dirName: string;
      }
    >();

    for (const session of sessions) {
      const cwd = await geminiProjectMap.get(session.projectHash);
      const key = cwd ?? session.projectHash;

      const existing = projectMap.get(key);
      if (existing) {
        existing.sessions.push(session);
        if (session.mtime > existing.lastActivity) {
          existing.lastActivity = session.mtime;
        }
      } else {
        projectMap.set(key, {
          sessions: [session],
          lastActivity: session.mtime,
          cwd: cwd ?? null,
          projectHash: session.projectHash,
          dirName: session.dirName,
        });
      }
    }

    // Convert to Project[]
    const projects: Project[] = [];
    for (const [key, data] of projectMap) {
      const path = data.cwd ?? `gemini:${data.projectHash.slice(0, 8)}`;
      const name = data.cwd
        ? basename(data.cwd)
        : `Gemini ${data.projectHash.slice(0, 8)}`;

      projects.push({
        id: encodeProjectId(path),
        path,
        name,
        sessionCount: data.sessions.length,
        sessionDir: join(this.sessionsDir, data.dirName, "chats"),
        activeOwnedCount: 0,
        activeExternalCount: 0,
        lastActivity: new Date(data.lastActivity).toISOString(),
        provider: "gemini",
      });
    }

    // Sort by last activity descending
    projects.sort((a, b) => {
      if (!a.lastActivity) return 1;
      if (!b.lastActivity) return -1;
      return (
        new Date(b.lastActivity).getTime() - new Date(a.lastActivity).getTime()
      );
    });

    return projects;
  }

  /**
   * Get sessions for a specific project (by cwd or projectHash).
   */
  async getSessionsForProject(
    projectPath: string,
  ): Promise<GeminiSessionInfo[]> {
    const sessions = await this.scanAllSessions();
    await geminiProjectMap.load();

    // Check if projectPath is a hash prefix (gemini:xxxxxxxx format)
    if (projectPath.startsWith("gemini:")) {
      const hashPrefix = projectPath.slice(7);
      return sessions
        .filter((s) => s.projectHash.startsWith(hashPrefix))
        .sort((a, b) => b.mtime - a.mtime);
    }

    // Otherwise, hash the path and look for matching sessions
    const targetHash = hashProjectPath(projectPath);

    // Ensure we have this path registered
    await geminiProjectMap.set(targetHash, projectPath);

    return sessions
      .filter((s) => s.projectHash === targetHash)
      .sort((a, b) => b.mtime - a.mtime);
  }

  /**
   * Scan all session files and extract metadata.
   * Results are cached for SCAN_CACHE_TTL to avoid redundant filesystem work.
   */
  private async scanAllSessions(): Promise<GeminiSessionInfo[]> {
    if (
      this.cachedScan &&
      Date.now() - this.cachedScan.timestamp < SCAN_CACHE_TTL
    ) {
      return this.cachedScan.result;
    }

    const sessions: GeminiSessionInfo[] = [];

    try {
      await stat(this.sessionsDir);
    } catch {
      this.cachedScan = { result: [], timestamp: Date.now() };
      return [];
    }

    // Find all project directories (may be slugs or hashes)
    let projectDirNames: string[];
    try {
      const entries = await readdir(this.sessionsDir, { withFileTypes: true });
      projectDirNames = entries
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
    } catch {
      this.cachedScan = { result: [], timestamp: Date.now() };
      return [];
    }

    // Scan each project directory in parallel
    const BATCH_SIZE = 20;
    for (let i = 0; i < projectDirNames.length; i += BATCH_SIZE) {
      const batch = projectDirNames.slice(i, i + BATCH_SIZE);
      const results = await Promise.all(
        batch.map((dirName) => this.scanProjectDir(dirName)),
      );
      for (const result of results) {
        sessions.push(...result);
      }
    }

    this.cachedScan = { result: sessions, timestamp: Date.now() };
    return sessions;
  }

  /**
   * Scan sessions for a project directory (slug or hash name on disk).
   */
  private async scanProjectDir(dirName: string): Promise<GeminiSessionInfo[]> {
    const sessions: GeminiSessionInfo[] = [];
    const chatsDir = join(this.sessionsDir, dirName, "chats");

    try {
      await stat(chatsDir);
    } catch {
      return [];
    }

    let files: string[];
    try {
      const entries = await readdir(chatsDir, { withFileTypes: true });
      files = entries
        .filter(
          (e) =>
            e.isFile() &&
            e.name.startsWith("session-") &&
            e.name.endsWith(".json"),
        )
        .map((e) => e.name);
    } catch {
      return [];
    }

    // Read session files in parallel
    const results = await Promise.all(
      files.map((f) => this.readSessionMeta(join(chatsDir, f), dirName)),
    );

    for (const result of results) {
      if (result) {
        sessions.push(result);
      }
    }

    return sessions;
  }

  /**
   * Read session metadata from a JSON file.
   */
  private async readSessionMeta(
    filePath: string,
    dirName: string,
  ): Promise<GeminiSessionInfo | null> {
    try {
      const stats = await stat(filePath);
      const content = await readFile(filePath, "utf-8");
      const session = parseGeminiSessionFile(content);

      if (!session) return null;

      return {
        id: session.sessionId,
        projectHash: session.projectHash,
        dirName,
        filePath,
        startTime: session.startTime,
        mtime: stats.mtimeMs,
      };
    } catch {
      return null;
    }
  }
}

// Singleton for convenience
export const geminiSessionScanner = new GeminiSessionScanner();
