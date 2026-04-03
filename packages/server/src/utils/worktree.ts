import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { getLogger } from "../logging/logger.js";

const execFileAsync = promisify(execFile);

export interface WorktreeConfig {
  /** Base directory for worktrees (default: {projectDir}-worktrees/) */
  basePath?: string;
  /** Files/dirs to symlink from original project into worktree */
  symlinks?: string[];
  /** Command to run after worktree creation (e.g., "pnpm install") */
  postCreateCommand?: string;
}

export interface WorktreeInfo {
  /** Absolute path to the worktree directory */
  worktreePath: string;
  /** Branch name created for this worktree */
  branchName: string;
  /** Original project path */
  originalPath: string;
}

/**
 * Check if a directory is a git repository.
 */
async function isGitRepo(dir: string): Promise<boolean> {
  try {
    await execFileAsync("git", ["rev-parse", "--git-dir"], { cwd: dir });
    return true;
  } catch {
    return false;
  }
}

/**
 * Create a git worktree for a session.
 *
 * Creates a new branch and worktree directory, optionally symlinks
 * specified files, and runs a post-create command.
 */
export async function createWorktree(
  projectPath: string,
  config: WorktreeConfig,
): Promise<WorktreeInfo> {
  const log = getLogger();
  const shortId = randomUUID().slice(0, 8);
  const branchName = `yep-wt-${shortId}`;

  // Verify it's a git repo
  if (!(await isGitRepo(projectPath))) {
    throw new Error(
      `Cannot create worktree: ${projectPath} is not a git repository`,
    );
  }

  // Determine worktree path
  const basePath =
    config.basePath || `${projectPath}-worktrees`;
  const worktreePath = path.join(basePath, branchName);

  log.info(
    {
      event: "worktree_create",
      projectPath,
      worktreePath,
      branchName,
    },
    `Creating worktree at ${worktreePath}`,
  );

  // Ensure base directory exists
  await fs.mkdir(basePath, { recursive: true });

  // Create the worktree with a new branch
  try {
    await execFileAsync(
      "git",
      ["worktree", "add", "-b", branchName, worktreePath],
      { cwd: projectPath },
    );
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to create git worktree: ${msg}`);
  }

  // Create symlinks for specified files
  if (config.symlinks && config.symlinks.length > 0) {
    for (const relativePath of config.symlinks) {
      const sourcePath = path.join(projectPath, relativePath);
      const targetPath = path.join(worktreePath, relativePath);

      try {
        // Check if source exists
        await fs.access(sourcePath);

        // Ensure target directory exists
        const targetDir = path.dirname(targetPath);
        await fs.mkdir(targetDir, { recursive: true });

        // Remove existing file/dir at target if present (worktree may have tracked version)
        try {
          const stat = await fs.lstat(targetPath);
          if (stat.isDirectory()) {
            await fs.rm(targetPath, { recursive: true });
          } else {
            await fs.unlink(targetPath);
          }
        } catch {
          // Target doesn't exist, that's fine
        }

        // Create symlink
        await fs.symlink(sourcePath, targetPath);
        log.debug(
          { event: "worktree_symlink", source: sourcePath, target: targetPath },
          `Symlinked ${relativePath}`,
        );
      } catch (error) {
        // Don't fail the whole worktree creation if a symlink fails
        log.warn(
          {
            event: "worktree_symlink_error",
            relativePath,
            error: error instanceof Error ? error.message : String(error),
          },
          `Failed to symlink ${relativePath}`,
        );
      }
    }
  }

  // Run post-create command
  if (config.postCreateCommand) {
    log.info(
      {
        event: "worktree_post_create",
        command: config.postCreateCommand,
        cwd: worktreePath,
      },
      `Running post-create command: ${config.postCreateCommand}`,
    );

    try {
      const shell = process.platform === "win32" ? "cmd" : "/bin/sh";
      const shellArgs =
        process.platform === "win32"
          ? ["/c", config.postCreateCommand]
          : ["-c", config.postCreateCommand];

      await execFileAsync(shell, shellArgs, {
        cwd: worktreePath,
        timeout: 120000, // 2 minute timeout
      });
    } catch (error) {
      log.warn(
        {
          event: "worktree_post_create_error",
          command: config.postCreateCommand,
          error: error instanceof Error ? error.message : String(error),
        },
        "Post-create command failed (continuing anyway)",
      );
    }
  }

  return {
    worktreePath,
    branchName,
    originalPath: projectPath,
  };
}

/**
 * Remove a git worktree and its branch.
 */
export async function removeWorktree(
  info: WorktreeInfo,
): Promise<void> {
  const log = getLogger();

  log.info(
    {
      event: "worktree_remove",
      worktreePath: info.worktreePath,
      branchName: info.branchName,
    },
    `Removing worktree at ${info.worktreePath}`,
  );

  try {
    // Remove the worktree
    await execFileAsync(
      "git",
      ["worktree", "remove", info.worktreePath, "--force"],
      { cwd: info.originalPath },
    );
  } catch (error) {
    log.warn(
      {
        event: "worktree_remove_error",
        error: error instanceof Error ? error.message : String(error),
      },
      "Failed to remove worktree (may already be gone)",
    );
  }

  try {
    // Delete the branch
    await execFileAsync(
      "git",
      ["branch", "-D", info.branchName],
      { cwd: info.originalPath },
    );
  } catch (error) {
    log.warn(
      {
        event: "worktree_branch_delete_error",
        error: error instanceof Error ? error.message : String(error),
      },
      "Failed to delete worktree branch (may already be gone)",
    );
  }
}

/**
 * List all worktrees for a project.
 */
export async function listWorktrees(
  projectPath: string,
): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["worktree", "list", "--porcelain"],
      { cwd: projectPath },
    );

    return stdout
      .split("\n")
      .filter((line) => line.startsWith("worktree "))
      .map((line) => line.replace("worktree ", ""));
  } catch {
    return [];
  }
}
