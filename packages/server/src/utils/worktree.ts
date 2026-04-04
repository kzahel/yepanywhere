import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";
import { getLogger } from "../logging/logger.js";

const execFileAsync = promisify(execFile);

export interface WorktreeConfig {
  /** Files to copy from original project (e.g., .env, secrets) */
  copyFiles?: string[];
  /** Directories to symlink from original project (e.g., node_modules, .venv) */
  symlinkDirectories?: string[];
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
  /** HEAD commit of original branch at time of creation */
  originalHeadCommit: string;
}

/**
 * Validate a relative path is safe (no traversal or absolute paths).
 */
function isValidRelativePath(relativePath: string): boolean {
  if (path.isAbsolute(relativePath)) return false;
  const normalized = path.normalize(relativePath);
  if (normalized.startsWith("..")) return false;
  if (normalized.includes(`..${path.sep}`)) return false;
  return true;
}

/**
 * Per-project worktree configuration parsed from .worktreeinclude.
 */
interface WorktreeIncludeConfig {
  /** Files to copy (plain lines, not directives) */
  copyFiles: string[];
  /** Directories to symlink (from "# symlink: dir" directives) */
  symlinkDirectories: string[];
  /** Post-create command (from "# postCreate: cmd" directive, last one wins) */
  postCreateCommand?: string;
}

/**
 * Parse a .worktreeinclude file for per-project worktree configuration.
 *
 * Plain lines are files to copy into the worktree (gitignore-like syntax).
 * Directives (special comments) configure additional behavior:
 *   # symlink: node_modules     — symlink a directory instead of copying
 *   # postCreate: pnpm install  — run a command after worktree creation
 *
 * Regular comments (# without a directive) and empty lines are ignored.
 */
async function parseWorktreeInclude(
  projectPath: string,
): Promise<WorktreeIncludeConfig> {
  const filePath = path.join(projectPath, ".worktreeinclude");
  const result: WorktreeIncludeConfig = {
    copyFiles: [],
    symlinkDirectories: [],
  };

  try {
    const content = await fs.readFile(filePath, "utf-8");
    for (const rawLine of content.split("\n")) {
      const line = rawLine.trim();
      if (!line) continue;

      // Check for directives: "# symlink: path" or "# postCreate: command"
      if (line.startsWith("#")) {
        const directiveMatch = line.match(
          /^#\s*(symlink|postCreate)\s*:\s*(.+)/,
        );
        if (directiveMatch?.[1] && directiveMatch[2]) {
          const directive = directiveMatch[1];
          const value = directiveMatch[2];
          if (directive === "symlink") {
            result.symlinkDirectories.push(value.trim());
          } else if (directive === "postCreate") {
            result.postCreateCommand = value.trim();
          }
        }
        // Regular comments are ignored
        continue;
      }

      // Plain lines are files to copy
      result.copyFiles.push(line);
    }
  } catch {
    // File doesn't exist — return empty config
  }

  return result;
}

/**
 * Ensure .claude/worktrees/ is excluded from git status in the parent repo.
 * Uses .git/info/exclude (local-only, doesn't modify tracked files).
 */
async function ensureWorktreeExcluded(projectPath: string): Promise<void> {
  const excludePattern = ".claude/worktrees/";
  try {
    const excludePath = path.join(projectPath, ".git", "info", "exclude");
    let content = "";
    try {
      content = await fs.readFile(excludePath, "utf-8");
    } catch {
      // File may not exist yet
    }
    if (!content.includes(excludePattern)) {
      const separator = content.length > 0 && !content.endsWith("\n") ? "\n" : "";
      await fs.mkdir(path.dirname(excludePath), { recursive: true });
      await fs.appendFile(excludePath, `${separator}${excludePattern}\n`);
    }
  } catch {
    // Non-critical — worktree still works, just shows as untracked
  }
}

async function isGitRepo(dir: string): Promise<boolean> {
  try {
    await execFileAsync("git", ["rev-parse", "--git-dir"], { cwd: dir });
    return true;
  } catch {
    return false;
  }
}

async function getHeadCommit(dir: string): Promise<string> {
  const { stdout } = await execFileAsync(
    "git",
    ["rev-parse", "HEAD"],
    { cwd: dir },
  );
  return stdout.trim();
}

/**
 * Create a git worktree for a session.
 *
 * Worktrees are created inside the repo at .claude/worktrees/<name>,
 * following Claude Code's convention. Files listed in .worktreeinclude
 * are copied; directories in symlinkDirectories are symlinked.
 */
export async function createWorktree(
  projectPath: string,
  config: WorktreeConfig,
): Promise<WorktreeInfo> {
  const log = getLogger();
  const shortId = randomUUID().slice(0, 8);
  const branchName = `yep-wt-${shortId}`;

  if (!(await isGitRepo(projectPath))) {
    throw new Error(
      `Cannot create worktree: ${projectPath} is not a git repository`,
    );
  }

  const originalHeadCommit = await getHeadCommit(projectPath);

  // Worktrees go inside the repo at .claude/worktrees/
  const worktreeBase = path.join(projectPath, ".claude", "worktrees");
  const worktreePath = path.join(worktreeBase, branchName);

  log.info(
    { event: "worktree_create", projectPath, worktreePath, branchName },
    `Creating worktree at ${worktreePath}`,
  );

  // Ensure .claude/worktrees/ doesn't dirty the parent repo's git status
  await ensureWorktreeExcluded(projectPath);
  await fs.mkdir(worktreeBase, { recursive: true });

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

  // Merge per-project config (.worktreeinclude) with global config
  const projectConfig = await parseWorktreeInclude(projectPath);
  const filesToCopy = [...projectConfig.copyFiles, ...(config.copyFiles ?? [])];
  const dirsToSymlink = [
    ...projectConfig.symlinkDirectories,
    ...(config.symlinkDirectories ?? []),
  ];
  // Per-project postCreate takes precedence over global
  const effectivePostCreateCommand =
    projectConfig.postCreateCommand ?? config.postCreateCommand;

  for (const relativePath of filesToCopy) {
    if (!isValidRelativePath(relativePath)) {
      log.warn(
        { event: "worktree_copy_skip", relativePath },
        `Skipping invalid path: ${relativePath}`,
      );
      continue;
    }
    await copyFileToWorktree(projectPath, worktreePath, relativePath, log);
  }

  // Symlink directories
  for (const relativePath of dirsToSymlink) {
    if (!isValidRelativePath(relativePath)) {
      log.warn(
        { event: "worktree_symlink_skip", relativePath },
        `Skipping invalid path: ${relativePath}`,
      );
      continue;
    }
    await symlinkToWorktree(projectPath, worktreePath, relativePath, log);
  }

  // Run post-create command
  if (effectivePostCreateCommand) {
    log.info(
      { event: "worktree_post_create", command: effectivePostCreateCommand },
      `Running post-create command: ${effectivePostCreateCommand}`,
    );
    try {
      const shell = process.platform === "win32" ? "cmd" : "/bin/sh";
      const shellArgs =
        process.platform === "win32"
          ? ["/c", effectivePostCreateCommand]
          : ["-c", effectivePostCreateCommand];
      await execFileAsync(shell, shellArgs, {
        cwd: worktreePath,
        timeout: 120000,
      });
    } catch (error) {
      log.warn(
        {
          event: "worktree_post_create_error",
          error: error instanceof Error ? error.message : String(error),
        },
        "Post-create command failed (continuing anyway)",
      );
    }
  }

  return { worktreePath, branchName, originalPath: projectPath, originalHeadCommit };
}

/**
 * Check if a worktree has uncommitted changes or new commits.
 */
export async function isWorktreeDirty(
  info: WorktreeInfo,
): Promise<{ dirty: boolean; hasUncommitted: boolean; newCommitCount: number }> {
  let hasUncommitted = false;
  let newCommitCount = 0;

  try {
    const { stdout: status } = await execFileAsync(
      "git",
      ["status", "--porcelain"],
      { cwd: info.worktreePath },
    );
    hasUncommitted = status.trim().length > 0;
  } catch {
    // If we can't check, assume dirty to be safe
    return { dirty: true, hasUncommitted: true, newCommitCount: 0 };
  }

  try {
    const { stdout: revCount } = await execFileAsync(
      "git",
      ["rev-list", "--count", `${info.originalHeadCommit}..HEAD`],
      { cwd: info.worktreePath },
    );
    newCommitCount = parseInt(revCount.trim(), 10) || 0;
  } catch {
    // Can't determine commit count
  }

  return {
    dirty: hasUncommitted || newCommitCount > 0,
    hasUncommitted,
    newCommitCount,
  };
}

/**
 * Remove a git worktree and its branch.
 * Only removes if the worktree is clean (no uncommitted changes, no new commits).
 * Returns whether the worktree was removed.
 */
export async function cleanupWorktree(
  info: WorktreeInfo,
  options: { force?: boolean } = {},
): Promise<{ removed: boolean; reason?: string }> {
  const log = getLogger();

  if (!options.force) {
    const { dirty, hasUncommitted, newCommitCount } =
      await isWorktreeDirty(info);
    if (dirty) {
      const reasons: string[] = [];
      if (hasUncommitted) reasons.push("uncommitted changes");
      if (newCommitCount > 0) reasons.push(`${newCommitCount} new commit(s)`);
      const reason = `Worktree has ${reasons.join(" and ")}`;
      log.info(
        { event: "worktree_keep", worktreePath: info.worktreePath, reason },
        `Keeping worktree: ${reason}`,
      );
      return { removed: false, reason };
    }
  }

  log.info(
    { event: "worktree_remove", worktreePath: info.worktreePath },
    `Removing worktree at ${info.worktreePath}`,
  );

  try {
    await execFileAsync(
      "git",
      ["worktree", "remove", info.worktreePath],
      { cwd: info.originalPath },
    );
  } catch (error) {
    log.warn(
      {
        event: "worktree_remove_error",
        error: error instanceof Error ? error.message : String(error),
      },
      "Failed to remove worktree",
    );
    return { removed: false, reason: "git worktree remove failed" };
  }

  try {
    await execFileAsync(
      "git",
      ["branch", "-D", info.branchName],
      { cwd: info.originalPath },
    );
  } catch {
    // Branch may already be gone
  }

  return { removed: true };
}

async function copyFileToWorktree(
  projectPath: string,
  worktreePath: string,
  relativePath: string,
  log: ReturnType<typeof getLogger>,
): Promise<void> {
  const sourcePath = path.join(projectPath, relativePath);
  const targetPath = path.join(worktreePath, relativePath);

  try {
    await fs.access(sourcePath);
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    // Remove existing target (worktree may have tracked version)
    try {
      await fs.rm(targetPath, { recursive: true });
    } catch {
      // Target doesn't exist
    }
    await fs.cp(sourcePath, targetPath, { recursive: true });
    log.debug(
      { event: "worktree_copy", relativePath },
      `Copied ${relativePath}`,
    );
  } catch (error) {
    log.warn(
      {
        event: "worktree_copy_error",
        relativePath,
        error: error instanceof Error ? error.message : String(error),
      },
      `Failed to copy ${relativePath}`,
    );
  }
}

async function symlinkToWorktree(
  projectPath: string,
  worktreePath: string,
  relativePath: string,
  log: ReturnType<typeof getLogger>,
): Promise<void> {
  const sourcePath = path.join(projectPath, relativePath);
  const targetPath = path.join(worktreePath, relativePath);

  try {
    await fs.access(sourcePath);
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    try {
      await fs.rm(targetPath, { recursive: true });
    } catch {
      // Target doesn't exist
    }
    await fs.symlink(sourcePath, targetPath);
    log.debug(
      { event: "worktree_symlink", relativePath },
      `Symlinked ${relativePath}`,
    );
  } catch (error) {
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
