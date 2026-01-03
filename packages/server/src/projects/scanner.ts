import { access, readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import type { ProviderName, UrlProjectId } from "@claude-anywhere/shared";
import type { Project } from "../supervisor/types.js";
import {
  CodexSessionScanner,
  CODEX_SESSIONS_DIR,
} from "./codex-scanner.js";
import {
  CLAUDE_PROJECTS_DIR,
  decodeProjectId,
  encodeProjectId,
  readCwdFromSessionFile,
} from "./paths.js";

export interface ScannerOptions {
  projectsDir?: string; // override for testing
  codexSessionsDir?: string; // override for testing
  enableCodex?: boolean; // whether to include Codex projects (default: true)
}

export class ProjectScanner {
  private projectsDir: string;
  private codexScanner: CodexSessionScanner | null;
  private enableCodex: boolean;

  constructor(options: ScannerOptions = {}) {
    this.projectsDir = options.projectsDir ?? CLAUDE_PROJECTS_DIR;
    this.enableCodex = options.enableCodex ?? true;
    this.codexScanner = this.enableCodex
      ? new CodexSessionScanner({
          sessionsDir: options.codexSessionsDir ?? CODEX_SESSIONS_DIR,
        })
      : null;
  }

  async listProjects(): Promise<Project[]> {
    const projects: Project[] = [];
    const seenPaths = new Set<string>();

    try {
      await access(this.projectsDir);
    } catch {
      // Directory doesn't exist - return empty list
      return [];
    }

    // ~/.claude/projects/ can have two structures:
    // 1. Projects directly as -home-user-project/
    // 2. Projects under hostname/ as hostname/-home-user-project/
    let dirs: string[];
    try {
      const entries = await readdir(this.projectsDir, { withFileTypes: true });
      dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
    } catch {
      return [];
    }

    for (const dir of dirs) {
      const dirPath = join(this.projectsDir, dir);

      // Check if this is a project directory (starts with -)
      if (dir.startsWith("-")) {
        const projectPath = await this.getProjectPathFromSessions(dirPath);
        if (projectPath && !seenPaths.has(projectPath)) {
          seenPaths.add(projectPath);
          const sessionCount = await this.countSessions(dirPath);
          const lastActivity = await this.getLastActivity(dirPath);
          projects.push({
            id: encodeProjectId(projectPath),
            path: projectPath,
            name: basename(projectPath),
            sessionCount,
            sessionDir: dirPath,
            activeOwnedCount: 0, // populated by route
            activeExternalCount: 0, // populated by route
            lastActivity,
            provider: "claude",
          });
        }
        continue;
      }

      // Otherwise, treat as hostname directory
      // Format: ~/.claude/projects/hostname/-project-path/
      let projectDirs: string[];
      try {
        const subEntries = await readdir(dirPath, { withFileTypes: true });
        projectDirs = subEntries
          .filter((e) => e.isDirectory())
          .map((e) => e.name);
      } catch {
        continue;
      }

      for (const projectDir of projectDirs) {
        const projectDirPath = join(dirPath, projectDir);
        const projectPath =
          await this.getProjectPathFromSessions(projectDirPath);

        if (!projectPath || seenPaths.has(projectPath)) continue;
        seenPaths.add(projectPath);

        const sessionCount = await this.countSessions(projectDirPath);
        const lastActivity = await this.getLastActivity(projectDirPath);

        projects.push({
          id: encodeProjectId(projectPath),
          path: projectPath,
          name: basename(projectPath),
          sessionCount,
          sessionDir: projectDirPath,
          activeOwnedCount: 0, // populated by route
          activeExternalCount: 0, // populated by route
          lastActivity,
          provider: "claude",
        });
      }
    }

    // Merge Codex projects if enabled
    if (this.codexScanner) {
      const codexProjects = await this.codexScanner.listProjects();
      for (const codexProject of codexProjects) {
        // Skip if we've already seen this path from Claude
        if (seenPaths.has(codexProject.path)) continue;
        seenPaths.add(codexProject.path);
        projects.push(codexProject);
      }
    }

    return projects;
  }

  async getProject(projectId: string): Promise<Project | null> {
    const projects = await this.listProjects();
    return projects.find((p) => p.id === projectId) ?? null;
  }

  /**
   * Get a project by ID, or create a virtual project entry if the path exists on disk
   * but hasn't been used with Claude yet.
   *
   * This allows starting sessions in new directories without requiring prior Claude usage.
   */
  async getOrCreateProject(
    projectId: string,
    preferredProvider?: "claude" | "codex" | "gemini",
  ): Promise<Project | null> {
    // First check if project already exists
    const existing = await this.getProject(projectId);
    if (existing) return existing;

    // Decode the projectId to get the path
    let projectPath: string;
    try {
      projectPath = decodeProjectId(projectId as UrlProjectId);
    } catch {
      return null;
    }

    // Validate path is absolute
    if (!projectPath.startsWith("/")) {
      return null;
    }

    // Check if the directory exists on disk
    try {
      const stats = await stat(projectPath);
      if (!stats.isDirectory()) {
        return null;
      }
    } catch {
      return null;
    }

    // Determine provider: use preferred if specified, otherwise check for Codex sessions
    let provider: "claude" | "codex" | "gemini" = preferredProvider ?? "claude";
    if (!preferredProvider && this.codexScanner) {
      // Check if Codex sessions exist for this path
      const codexSessions =
        await this.codexScanner.getSessionsForProject(projectPath);
      if (codexSessions.length > 0) {
        provider = "codex";
      }
    }

    // Create a virtual project entry
    // The session directory will be created by the SDK when the first session starts
    const encodedPath = projectPath.replace(/\//g, "-");
    return {
      id: projectId as UrlProjectId,
      path: projectPath,
      name: basename(projectPath),
      sessionCount: 0,
      sessionDir:
        provider === "codex" && this.codexScanner
          ? CODEX_SESSIONS_DIR
          : join(this.projectsDir, encodedPath),
      activeOwnedCount: 0,
      activeExternalCount: 0,
      lastActivity: null,
      provider,
    };
  }

  /**
   * Find a project by matching the session directory suffix.
   *
   * This is used by ExternalSessionTracker which extracts the directory-based
   * project identifier from file paths (e.g., "-home-user-project" or
   * "hostname/-home-user-project") rather than the base64url-encoded projectId.
   */
  async getProjectBySessionDirSuffix(
    dirSuffix: string,
  ): Promise<Project | null> {
    const projects = await this.listProjects();
    // Match projects where sessionDir ends with the suffix pattern
    // e.g., suffix "-home-user-project" matches "~/.claude/projects/-home-user-project"
    // e.g., suffix "hostname/-home-user-project" matches "~/.claude/projects/hostname/-home-user-project"
    return projects.find((p) => p.sessionDir.endsWith(`/${dirSuffix}`)) ?? null;
  }

  /**
   * Get the actual project path by reading the cwd from a session file.
   *
   * NOTE: This is necessary because the directory names use a lossy
   * slash-to-hyphen encoding that cannot be reversed reliably.
   * See packages/server/src/projects/paths.ts for full documentation.
   */
  private async getProjectPathFromSessions(
    projectDirPath: string,
  ): Promise<string | null> {
    try {
      const files = await readdir(projectDirPath);
      const jsonlFiles = files.filter((f) => f.endsWith(".jsonl"));

      if (jsonlFiles.length === 0) {
        return null;
      }

      // Try to read cwd from the first available session file
      for (const file of jsonlFiles) {
        const filePath = join(projectDirPath, file);
        const cwd = await readCwdFromSessionFile(filePath);
        if (cwd) {
          return cwd;
        }
      }

      return null;
    } catch {
      return null;
    }
  }

  private async countSessions(projectDirPath: string): Promise<number> {
    try {
      const files = await readdir(projectDirPath);
      // Count .jsonl files, excluding agent-* (internal subagent warmup sessions)
      return files.filter(
        (f) => f.endsWith(".jsonl") && !f.startsWith("agent-"),
      ).length;
    } catch {
      return 0;
    }
  }

  private async getLastActivity(
    projectDirPath: string,
  ): Promise<string | null> {
    try {
      const files = await readdir(projectDirPath);
      const jsonlFiles = files.filter(
        (f) => f.endsWith(".jsonl") && !f.startsWith("agent-"),
      );

      if (jsonlFiles.length === 0) return null;

      let latestMtime = 0;
      for (const file of jsonlFiles) {
        const stats = await stat(join(projectDirPath, file));
        if (stats.mtimeMs > latestMtime) {
          latestMtime = stats.mtimeMs;
        }
      }

      return latestMtime > 0 ? new Date(latestMtime).toISOString() : null;
    } catch {
      return null;
    }
  }
}

// Singleton for convenience
export const projectScanner = new ProjectScanner();
