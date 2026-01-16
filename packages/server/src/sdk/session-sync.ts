/**
 * Session sync implementation for remote executors.
 *
 * Uses rsync to synchronize session files between local and remote machines.
 */

import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { getLogger } from "../logging/logger.js";

/**
 * Options for session sync operations.
 */
export interface SyncOptions {
  /** SSH host alias */
  host: string;
  /** Project directory name (e.g., "home-user-project") */
  projectDir: string;
  /** Sync direction */
  direction: "from-remote" | "to-remote";
  /** Base session directory (defaults to ~/.claude/projects/) */
  sessionsDir?: string;
  /** Remote sessions directory override (for testing) */
  remoteSessionsDir?: string;
}

/**
 * Result of a sync operation.
 */
export interface SyncResult {
  success: boolean;
  /** Files transferred */
  filesTransferred?: number;
  /** Error message if failed */
  error?: string;
  /** Sync duration in ms */
  durationMs?: number;
}

/**
 * Convert a working directory path to SDK's project directory name.
 *
 * The SDK stores sessions in ~/.claude/projects/{encoded-path}/
 * where encoded-path is the path with all / replaced by -.
 *
 * For example: /home/kgraehl/code/project → -home-kgraehl-code-project
 */
export function getProjectDirFromCwd(cwd: string): string {
  // Replace all slashes with dashes (leading slash becomes leading dash)
  return cwd.replace(/\//g, "-");
}

/**
 * Get the full path to a project's session directory.
 */
export function getSessionsPath(projectDir: string, baseDir?: string): string {
  const sessionsDir = baseDir ?? join(homedir(), ".claude", "projects");
  // Session files are stored directly under projects dir (no hostname subdirectory)
  return join(sessionsDir, projectDir);
}

/**
 * Sync session files between local and remote.
 *
 * Uses rsync with archive mode (-a) and compression (-z).
 * Does not delete files on the destination (--delete is not used).
 */
export async function syncSessions(options: SyncOptions): Promise<SyncResult> {
  const log = getLogger();
  const startTime = Date.now();

  const { host, projectDir, direction, sessionsDir, remoteSessionsDir } =
    options;

  const localPath = getSessionsPath(projectDir, sessionsDir);
  // Remote path has same structure (no hostname subdirectory)
  const remotePath = remoteSessionsDir
    ? join(remoteSessionsDir, projectDir)
    : `~/.claude/projects/${projectDir}`;

  // Build rsync command
  // -a: archive mode (preserves permissions, timestamps, etc.)
  // -z: compress during transfer
  // -v: verbose (for logging)
  // --mkpath: create destination directories if needed (rsync 3.2.3+)
  let source: string;
  let dest: string;

  if (direction === "from-remote") {
    source = `${host}:${remotePath}/`;
    dest = `${localPath}/`;
  } else {
    source = `${localPath}/`;
    dest = `${host}:${remotePath}/`;
  }

  log.info(
    {
      event: "session_sync_start",
      direction,
      host,
      projectDir,
      source,
      dest,
    },
    `Starting session sync ${direction}: ${projectDir}`,
  );

  return new Promise((resolve) => {
    const rsyncProcess = spawn(
      "rsync",
      ["-az", "--mkpath", "-e", "ssh -o BatchMode=yes", source, dest],
      { stdio: ["ignore", "pipe", "pipe"] },
    );

    let stdout = "";
    let stderr = "";

    rsyncProcess.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
    });

    rsyncProcess.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    rsyncProcess.on("exit", (code) => {
      const durationMs = Date.now() - startTime;

      if (code === 0) {
        // Count files from verbose output (lines that don't start with special chars)
        const fileLines = stdout
          .trim()
          .split("\n")
          .filter((line) => {
            return (
              line && !line.startsWith("sent") && !line.startsWith("total")
            );
          });
        const filesTransferred = fileLines.length;

        log.info(
          {
            event: "session_sync_success",
            direction,
            host,
            projectDir,
            filesTransferred,
            durationMs,
          },
          `Session sync complete: ${filesTransferred} files in ${durationMs}ms`,
        );

        resolve({
          success: true,
          filesTransferred,
          durationMs,
        });
      } else {
        const error = stderr.trim() || `rsync exited with code ${code}`;

        log.warn(
          {
            event: "session_sync_failed",
            direction,
            host,
            projectDir,
            error,
            durationMs,
          },
          `Session sync failed: ${error}`,
        );

        resolve({
          success: false,
          error,
          durationMs,
        });
      }
    });

    rsyncProcess.on("error", (error) => {
      const durationMs = Date.now() - startTime;

      log.warn(
        {
          event: "session_sync_error",
          direction,
          host,
          projectDir,
          error: error.message,
          durationMs,
        },
        `Session sync error: ${error.message}`,
      );

      resolve({
        success: false,
        error: error.message,
        durationMs,
      });
    });
  });
}

/**
 * Sync a specific session file from remote.
 *
 * Used for quick sync of a single session after a turn completes.
 */
export async function syncSessionFile(
  host: string,
  projectDir: string,
  sessionId: string,
  sessionsDir?: string,
  remoteSessionsDir?: string,
): Promise<SyncResult> {
  const log = getLogger();
  const startTime = Date.now();

  const localPath = getSessionsPath(projectDir, sessionsDir);
  // Remote path has same structure (no hostname subdirectory)
  const remotePath = remoteSessionsDir
    ? join(remoteSessionsDir, projectDir)
    : `~/.claude/projects/${projectDir}`;

  const source = `${host}:${remotePath}/${sessionId}.jsonl`;
  const dest = `${localPath}/`;

  log.debug(
    {
      event: "session_file_sync_start",
      host,
      projectDir,
      sessionId,
      source,
      dest,
    },
    `Syncing session file: ${sessionId}`,
  );

  return new Promise((resolve) => {
    const rsyncProcess = spawn(
      "rsync",
      ["-az", "--mkpath", "-e", "ssh -o BatchMode=yes", source, dest],
      { stdio: ["ignore", "pipe", "pipe"] },
    );

    let stderr = "";

    rsyncProcess.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    rsyncProcess.on("exit", (code) => {
      const durationMs = Date.now() - startTime;

      if (code === 0) {
        log.debug(
          {
            event: "session_file_sync_success",
            host,
            projectDir,
            sessionId,
            durationMs,
          },
          `Session file sync complete: ${sessionId} in ${durationMs}ms`,
        );

        resolve({
          success: true,
          filesTransferred: 1,
          durationMs,
        });
      } else {
        const error = stderr.trim() || `rsync exited with code ${code}`;

        log.warn(
          {
            event: "session_file_sync_failed",
            host,
            projectDir,
            sessionId,
            error,
            durationMs,
          },
          `Session file sync failed: ${error}`,
        );

        resolve({
          success: false,
          error,
          durationMs,
        });
      }
    });

    rsyncProcess.on("error", (error) => {
      const durationMs = Date.now() - startTime;
      resolve({
        success: false,
        error: error.message,
        durationMs,
      });
    });
  });
}
