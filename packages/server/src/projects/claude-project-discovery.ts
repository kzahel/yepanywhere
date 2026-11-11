import { readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { claudeCwdProjectDirectory } from "./claude-project-directory.js";
import { readCwdFromSessionFile } from "./paths.js";

const CWD_SCAN_BATCH_SIZE = 8;

export interface ClaudeProjectDirectory {
  projectPath: string;
  sessionCount: number;
  lastActivity: string | null;
}

export async function readClaudeProjectDirectory(
  projectDirPath: string,
): Promise<ClaudeProjectDirectory | null> {
  try {
    const entries = await readdir(projectDirPath, { withFileTypes: true });
    const jsonlFiles = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
      .map((entry) => entry.name);

    if (jsonlFiles.length === 0) return null;

    // Count non-agent sessions
    const sessionCount = jsonlFiles.filter(
      (f) => !f.startsWith("agent-"),
    ).length;

    // Use directory mtime as lastActivity (updated when files are added/removed)
    const dirStat = await stat(projectDirPath);
    const lastActivity = new Date(dirStat.mtimeMs).toISOString();

    // A launch folder can also hold --worktree transcripts. Prefer its
    // native key over whichever transcript enumeration happens to return first.
    const nativeDirectory = basename(projectDirPath);
    let firstCwd: string | null = null;
    const regularSessionFiles = jsonlFiles.filter(
      (f) => !f.startsWith("agent-"),
    );
    const orderedFiles =
      regularSessionFiles.length > 0
        ? [
            ...regularSessionFiles,
            ...jsonlFiles.filter((f) => f.startsWith("agent-")),
          ]
        : jsonlFiles;

    for (let i = 0; i < orderedFiles.length; i += CWD_SCAN_BATCH_SIZE) {
      const batch = orderedFiles.slice(i, i + CWD_SCAN_BATCH_SIZE);
      const batchCwds = await Promise.all(
        batch.map((file) => readCwdFromSessionFile(join(projectDirPath, file))),
      );

      for (const cwd of batchCwds) {
        if (cwd && claudeCwdProjectDirectory(cwd) === nativeDirectory) {
          return { projectPath: cwd, sessionCount, lastActivity };
        }
        firstCwd ??= cwd || null;
      }
    }

    return firstCwd
      ? { projectPath: firstCwd, sessionCount, lastActivity }
      : null;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw error;
  }
}
