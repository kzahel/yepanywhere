import { readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { getLogger } from "../logging/logger.js";
import { runGit } from "./gitExec.js";

/**
 * HEAD's commit id read from the repository's own files instead of a `git`
 * process. Cache validators (blame, author palette, file projections) ask
 * for HEAD on every poll, and a process per ask was a measurable share of
 * server CPU. Reading HEAD costs a few small file reads.
 *
 * Covered: a `.git` directory or a `gitdir:` file (linked worktrees,
 * submodules), `commondir`, symbolic or detached HEAD, loose or packed refs.
 * Anything else, notably reftable storage or a nested symbolic ref, defers
 * to `git rev-parse` and logs that it did. Returns null when HEAD names no
 * commit (an unborn branch) or the path is not inside a repository.
 */
export async function readHeadSha(cwd: string): Promise<string | null> {
  const repo = await findGitDirs(cwd);
  if (!repo) return null;
  if (await exists(join(repo.commonDir, "reftable")))
    return revParseHead(cwd, "reftable ref storage");
  const head = (await readFile(join(repo.gitDir, "HEAD"), "utf8")).trim();
  if (OBJECT_ID.test(head)) return head;
  const ref = /^ref: (refs\/\S+)$/.exec(head)?.[1];
  if (!ref) return revParseHead(cwd, "unrecognized HEAD");
  // Per-worktree refs live beside HEAD; shared branch refs in the common dir.
  for (const dir of new Set([repo.gitDir, repo.commonDir])) {
    const loose = await readFile(join(dir, ref), "utf8").catch(ignoreMissing);
    if (loose === null) continue;
    const value = loose.trim();
    if (OBJECT_ID.test(value)) return value;
    return revParseHead(cwd, "symbolic branch ref");
  }
  return (await readPackedRefs(repo.commonDir)).get(ref) ?? null;
}

const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

interface GitDirs {
  gitDir: string;
  commonDir: string;
}

async function findGitDirs(cwd: string): Promise<GitDirs | null> {
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    const dotGit = join(dir, ".git");
    const entry = await stat(dotGit).catch(ignoreMissing);
    // Like git's discovery, skip a `.git` directory that is no repository.
    if (
      entry &&
      (!entry.isDirectory() || (await exists(join(dotGit, "HEAD"))))
    ) {
      const gitDir = entry.isDirectory()
        ? dotGit
        : await readGitDirFile(dotGit, dir);
      const common = await readFile(join(gitDir, "commondir"), "utf8").catch(
        ignoreMissing,
      );
      return {
        gitDir,
        commonDir: common ? resolveFrom(gitDir, common.trim()) : gitDir,
      };
    }
    if (dirname(dir) === dir) return null;
  }
}

async function readGitDirFile(dotGit: string, dir: string): Promise<string> {
  const content = (await readFile(dotGit, "utf8")).trim();
  const target = /^gitdir: (.+)$/.exec(content)?.[1];
  if (!target) throw new Error(`Unrecognized .git file at ${dotGit}`);
  return resolveFrom(dir, target);
}

function resolveFrom(base: string, path: string): string {
  return isAbsolute(path) ? path : resolve(base, path);
}

interface PackedRefsCacheEntry {
  validator: string;
  refs: Map<string, string>;
}

/** Packed refs can be large; parse once per file version. */
const packedRefsCache = new Map<string, PackedRefsCacheEntry>();

async function readPackedRefs(commonDir: string): Promise<Map<string, string>> {
  const file = join(commonDir, "packed-refs");
  const info = await stat(file).catch(ignoreMissing);
  if (!info) return new Map();
  const validator = `${info.ino}:${info.mtimeMs}:${info.size}`;
  const cached = packedRefsCache.get(file);
  if (cached?.validator === validator) return cached.refs;
  const refs = new Map<string, string>();
  for (const line of (await readFile(file, "utf8")).split("\n")) {
    const match = /^([0-9a-f]{40}|[0-9a-f]{64}) (refs\/\S+)$/.exec(line);
    if (match?.[1] && match[2]) refs.set(match[2], match[1]);
  }
  packedRefsCache.set(file, { validator, refs });
  return refs;
}

const deferredLayouts = new Set<string>();

async function revParseHead(
  cwd: string,
  reason: string,
): Promise<string | null> {
  if (!deferredLayouts.has(`${cwd}\0${reason}`)) {
    deferredLayouts.add(`${cwd}\0${reason}`);
    getLogger().debug(
      { event: "git_head_read_deferred", cwd, reason },
      "GIT_HEAD: reading HEAD through git",
    );
  }
  try {
    const { stdout } = await runGit(cwd, ["rev-parse", "--verify", "HEAD"]);
    const sha = stdout.trim();
    return OBJECT_ID.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

async function exists(path: string): Promise<boolean> {
  return (await stat(path).catch(ignoreMissing)) !== null;
}

function ignoreMissing(error: NodeJS.ErrnoException): null {
  if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
  throw error;
}
