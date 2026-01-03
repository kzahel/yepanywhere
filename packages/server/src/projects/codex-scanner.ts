/**
 * CodexSessionScanner - Scans Codex sessions and groups them by project (cwd).
 *
 * Unlike Claude which organizes sessions by project directory, Codex stores
 * sessions by date: ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
 *
 * Each session file has session_meta as the first line containing the cwd.
 * We scan all sessions and group them by cwd to create virtual "projects".
 *
 * No caching - we scan on every request. This is fine for reasonable session counts.
 */

import { readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { UrlProjectId } from "@claude-anywhere/shared";
import type { Project } from "../supervisor/types.js";
import { encodeProjectId } from "./paths.js";

export const CODEX_DIR = join(homedir(), ".codex");
export const CODEX_SESSIONS_DIR = join(CODEX_DIR, "sessions");

interface CodexSessionMeta {
  id: string;
  cwd: string;
  timestamp: string;
  cli_version?: string;
  model_provider?: string;
}

interface CodexSessionInfo {
  id: string;
  cwd: string;
  filePath: string;
  timestamp: string;
  mtime: number;
}

export interface CodexScannerOptions {
  sessionsDir?: string; // override for testing
}

export class CodexSessionScanner {
  private sessionsDir: string;

  constructor(options: CodexScannerOptions = {}) {
    this.sessionsDir = options.sessionsDir ?? CODEX_SESSIONS_DIR;
  }

  /**
   * Scan all Codex sessions and group them by project (cwd).
   * Returns projects sorted by last activity (most recent first).
   */
  async listProjects(): Promise<Project[]> {
    const sessions = await this.scanAllSessions();

    // Group sessions by cwd
    const projectMap = new Map<
      string,
      { sessions: CodexSessionInfo[]; lastActivity: number }
    >();

    for (const session of sessions) {
      const existing = projectMap.get(session.cwd);
      if (existing) {
        existing.sessions.push(session);
        if (session.mtime > existing.lastActivity) {
          existing.lastActivity = session.mtime;
        }
      } else {
        projectMap.set(session.cwd, {
          sessions: [session],
          lastActivity: session.mtime,
        });
      }
    }

    // Convert to Project[]
    const projects: Project[] = [];
    for (const [cwd, data] of projectMap) {
      projects.push({
        id: encodeProjectId(cwd),
        path: cwd,
        name: basename(cwd),
        sessionCount: data.sessions.length,
        sessionDir: this.sessionsDir, // All sessions are in the same tree
        activeOwnedCount: 0,
        activeExternalCount: 0,
        lastActivity: new Date(data.lastActivity).toISOString(),
        provider: "codex",
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
   * Get sessions for a specific project (cwd).
   */
  async getSessionsForProject(
    projectPath: string,
  ): Promise<CodexSessionInfo[]> {
    const sessions = await this.scanAllSessions();
    return sessions
      .filter((s) => s.cwd === projectPath)
      .sort((a, b) => b.mtime - a.mtime);
  }

  /**
   * Scan all session files and extract metadata from the first line.
   */
  private async scanAllSessions(): Promise<CodexSessionInfo[]> {
    const sessions: CodexSessionInfo[] = [];

    try {
      await stat(this.sessionsDir);
    } catch {
      // Sessions directory doesn't exist
      return [];
    }

    // Recursively find all .jsonl files
    const files = await this.findJsonlFiles(this.sessionsDir);

    // Read first line of each file in parallel (with concurrency limit)
    const BATCH_SIZE = 50;
    for (let i = 0; i < files.length; i += BATCH_SIZE) {
      const batch = files.slice(i, i + BATCH_SIZE);
      const results = await Promise.all(
        batch.map((f) => this.readSessionMeta(f)),
      );
      for (const result of results) {
        if (result) {
          sessions.push(result);
        }
      }
    }

    return sessions;
  }

  /**
   * Recursively find all .jsonl files in a directory.
   */
  private async findJsonlFiles(dir: string): Promise<string[]> {
    const files: string[] = [];

    try {
      const entries = await readdir(dir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
          const subFiles = await this.findJsonlFiles(fullPath);
          files.push(...subFiles);
        } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
          files.push(fullPath);
        }
      }
    } catch {
      // Ignore errors (permission denied, etc.)
    }

    return files;
  }

  /**
   * Read just the first line of a session file to extract metadata.
   */
  private async readSessionMeta(
    filePath: string,
  ): Promise<CodexSessionInfo | null> {
    try {
      const stats = await stat(filePath);

      // Read first line only (session_meta is always first)
      const content = await readFile(filePath, { encoding: "utf-8" });
      const firstNewline = content.indexOf("\n");
      const firstLine =
        firstNewline > 0 ? content.slice(0, firstNewline) : content;

      if (!firstLine.trim()) {
        return null;
      }

      const parsed = JSON.parse(firstLine);

      // Validate it's a session_meta entry
      if (parsed.type !== "session_meta" || !parsed.payload) {
        return null;
      }

      const meta = parsed.payload as CodexSessionMeta;
      if (!meta.id || !meta.cwd) {
        return null;
      }

      return {
        id: meta.id,
        cwd: meta.cwd,
        filePath,
        timestamp: meta.timestamp,
        mtime: stats.mtimeMs,
      };
    } catch {
      return null;
    }
  }
}

// Singleton for convenience
export const codexSessionScanner = new CodexSessionScanner();
