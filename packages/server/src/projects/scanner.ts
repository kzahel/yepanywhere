import { access, readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import type { Project } from "../supervisor/types.js";
import {
  CLAUDE_PROJECTS_DIR,
  encodeProjectId,
  readCwdFromSessionFile,
} from "./paths.js";

export interface ScannerOptions {
  projectsDir?: string; // override for testing
}

export class ProjectScanner {
  private projectsDir: string;

  constructor(options: ScannerOptions = {}) {
    this.projectsDir = options.projectsDir ?? CLAUDE_PROJECTS_DIR;
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
          projects.push({
            id: encodeProjectId(projectPath),
            path: projectPath,
            name: basename(projectPath),
            sessionCount,
            sessionDir: dirPath,
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

        projects.push({
          id: encodeProjectId(projectPath),
          path: projectPath,
          name: basename(projectPath),
          sessionCount,
          sessionDir: projectDirPath,
        });
      }
    }

    return projects;
  }

  async getProject(projectId: string): Promise<Project | null> {
    const projects = await this.listProjects();
    return projects.find((p) => p.id === projectId) ?? null;
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
}

// Singleton for convenience
export const projectScanner = new ProjectScanner();
