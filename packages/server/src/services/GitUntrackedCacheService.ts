import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  opendir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import type { GitUntrackedFileListResult } from "@yep-anywhere/shared";
import { runGit } from "../git/gitExec.js";
import { createLruMap, refreshLruMap } from "../lib/lruCollections.js";
import { getLogger } from "../logging/logger.js";
import { repositoryRelativePath } from "../review/repositoryPath.js";

const CACHE_VERSION = 2;
const FULL_REFRESH_INTERVAL_MS = 60 * 60 * 1000;
const FILE_RECHECK_INTERVAL_MS = 60 * 60 * 1000;
const CACHE_FILE_LIMIT = 50_000;
const RESPONSE_LIMIT = 500;
/** Projects whose snapshots stay in memory; others reload from disk. */
const RETAINED_PROJECT_LIMIT = 16;
const GIT_LIST_MAX_BUFFER = 64 * 1024 * 1024;

interface GitTreeState {
  headSha: string | null;
  /** SHA-256 of `git ls-files -z --cached`. */
  indexDigest: string;
  indexPaths: string[];
}

interface UntrackedSnapshot {
  projectPath: string;
  headSha: string | null;
  indexDigest: string;
  /**
   * The index paths this snapshot was reconciled against, kept in memory
   * only. Null after a reload from disk: the persisted digest then tells
   * whether the index changed, and a changed index forces a full refresh
   * because a removed path could have become untracked.
   */
  indexPaths: string[] | null;
  files: string[];
  checkedAt: Record<string, number>;
  refreshedAt: number;
  truncated: boolean;
}

/** The tracked tree is not persisted; Git recomputes it on refresh. */
type PersistedUntrackedSnapshot = Omit<UntrackedSnapshot, "indexPaths"> & {
  version: typeof CACHE_VERSION;
};

interface ProjectCacheState {
  snapshot: UntrackedSnapshot | null;
  loadPromise: Promise<void> | null;
  refreshPromise: Promise<UntrackedSnapshot> | null;
  persistPromise: Promise<void>;
  /** Queries in progress; a busy state is never evicted. */
  activeQueries: number;
}

export interface GitUntrackedCacheServiceOptions {
  dataDir: string;
  now?: () => number;
  fullRefreshIntervalMs?: number;
  fileRecheckIntervalMs?: number;
  cacheFileLimit?: number;
  responseLimit?: number;
  retainedProjectLimit?: number;
}

export interface GitUntrackedCacheQuery {
  path?: string;
  q?: string;
}

/**
 * Project-keyed, data-directory-backed untracked inventory. Git supplies the
 * authoritative exclude set; directory expansion and search read this cache
 * instead of launching another untracked enumeration.
 */
export class GitUntrackedCacheService {
  /**
   * Least recently used first, bounded by `retainedProjectLimit` idle
   * entries. An evicted project reloads its persisted snapshot on next use.
   */
  private readonly states = createLruMap<string, ProjectCacheState>();
  private readonly now: () => number;
  private readonly fullRefreshIntervalMs: number;
  private readonly fileRecheckIntervalMs: number;
  private readonly cacheFileLimit: number;
  private readonly responseLimit: number;
  private readonly retainedProjectLimit: number;
  private readonly cacheDir: string;

  constructor(options: GitUntrackedCacheServiceOptions) {
    this.now = options.now ?? Date.now;
    this.fullRefreshIntervalMs =
      options.fullRefreshIntervalMs ?? FULL_REFRESH_INTERVAL_MS;
    this.fileRecheckIntervalMs =
      options.fileRecheckIntervalMs ?? FILE_RECHECK_INTERVAL_MS;
    this.cacheFileLimit = options.cacheFileLimit ?? CACHE_FILE_LIMIT;
    this.responseLimit = options.responseLimit ?? RESPONSE_LIMIT;
    this.retainedProjectLimit =
      options.retainedProjectLimit ?? RETAINED_PROJECT_LIMIT;
    this.cacheDir = join(options.dataDir, "indexes", "git-untracked");
  }

  query(
    projectPath: string,
    query: GitUntrackedCacheQuery = {},
  ): Promise<GitUntrackedFileListResult> {
    return this.withState(projectPath, (state) =>
      this.queryState(state, projectPath, query),
    );
  }

  private async queryState(
    state: ProjectCacheState,
    projectPath: string,
    query: GitUntrackedCacheQuery,
  ): Promise<GitUntrackedFileListResult> {
    await this.load(state, projectPath);
    const snapshot = await this.ensureCurrent(state, projectPath);
    const selected = selectFiles(snapshot.files, query);
    const selectedForRecheck =
      query.path || query.q
        ? selected.slice(0, this.responseLimit)
        : summarizeRoot(selected).files.slice(0, this.responseLimit);
    const checked = await this.recheckSelected(
      state,
      snapshot,
      selectedForRecheck,
    );
    const currentSelection = checked.changed
      ? selectFiles(checked.snapshot.files, query)
      : selected;

    if (query.path || query.q) {
      const truncated =
        checked.snapshot.truncated ||
        currentSelection.length > this.responseLimit;
      const files = currentSelection.slice(0, this.responseLimit);
      return {
        files,
        folders: [],
        total: checked.snapshot.files.length,
        refreshedAt: new Date(checked.snapshot.refreshedAt).toISOString(),
        truncated,
        limit: this.responseLimit,
      };
    }

    const root = summarizeRoot(currentSelection);
    const combined = [
      ...root.files.map((path) => ({ kind: "file" as const, path })),
      ...root.folders.map((folder) => ({ kind: "folder" as const, ...folder })),
    ].sort((a, b) => a.path.localeCompare(b.path));
    const truncated =
      checked.snapshot.truncated || combined.length > this.responseLimit;
    const bounded = combined.slice(0, this.responseLimit);
    return {
      files: bounded
        .filter((entry) => entry.kind === "file")
        .map((entry) => entry.path),
      folders: bounded
        .filter((entry) => entry.kind === "folder")
        .map((entry) => ({ path: entry.path, count: entry.count ?? 0 })),
      total: checked.snapshot.files.length,
      refreshedAt: new Date(checked.snapshot.refreshedAt).toISOString(),
      truncated,
      limit: this.responseLimit,
    };
  }

  all(projectPath: string): Promise<{
    files: string[];
    truncated: boolean;
  }> {
    return this.withState(projectPath, async (state) => {
      await this.load(state, projectPath);
      const snapshot = await this.ensureCurrent(state, projectPath);
      return { files: snapshot.files, truncated: snapshot.truncated };
    });
  }

  private async withState<T>(
    projectPath: string,
    run: (state: ProjectCacheState) => Promise<T>,
  ): Promise<T> {
    const state = this.stateFor(projectPath);
    state.activeQueries += 1;
    try {
      return await run(state);
    } finally {
      state.activeQueries -= 1;
      this.evictIdle();
    }
  }

  private stateFor(projectPath: string): ProjectCacheState {
    let state = this.states.get(projectPath);
    if (state) {
      refreshLruMap(this.states, projectPath, state);
    } else {
      state = {
        snapshot: null,
        loadPromise: null,
        refreshPromise: null,
        persistPromise: Promise.resolve(),
        activeQueries: 0,
      };
      this.states.set(projectPath, state);
    }
    return state;
  }

  /**
   * Drop least recently used idle states past the limit. Every query awaits
   * its own persistence, so an idle state has no write in flight and its
   * replacement reads the latest persisted snapshot.
   */
  private evictIdle(): void {
    let excess = this.states.size - this.retainedProjectLimit;
    for (const [projectPath, state] of this.states) {
      if (excess <= 0) break;
      if (state.activeQueries > 0) continue;
      this.states.delete(projectPath);
      excess -= 1;
    }
  }

  private async load(
    state: ProjectCacheState,
    projectPath: string,
  ): Promise<void> {
    if (state.snapshot) return;
    if (!state.loadPromise) {
      state.loadPromise = this.readPersisted(projectPath)
        .then((snapshot) => {
          state.snapshot = snapshot;
        })
        .finally(() => {
          state.loadPromise = null;
        });
    }
    await state.loadPromise;
  }

  private ensureCurrent(
    state: ProjectCacheState,
    projectPath: string,
  ): Promise<UntrackedSnapshot> {
    if (!state.refreshPromise) {
      state.refreshPromise = this.updateCurrent(state, projectPath).finally(
        () => {
          state.refreshPromise = null;
        },
      );
    }
    return state.refreshPromise;
  }

  private async updateCurrent(
    state: ProjectCacheState,
    projectPath: string,
  ): Promise<UntrackedSnapshot> {
    const snapshot = state.snapshot;
    const tree = await readTreeState(projectPath);
    const currentIndexPaths = new Set(tree.indexPaths);
    const headMoved = snapshot?.headSha !== tree.headSha;
    const indexChanged = snapshot?.indexDigest !== tree.indexDigest;
    const indexRemovedPath =
      !snapshot ||
      (indexChanged &&
        (!snapshot.indexPaths ||
          snapshot.indexPaths.some((path) => !currentIndexPaths.has(path))));
    const stale =
      !snapshot ||
      this.now() - snapshot.refreshedAt >= this.fullRefreshIntervalMs;

    if (!snapshot || headMoved || indexRemovedPath || stale) {
      const next = await this.refresh(projectPath, tree);
      state.snapshot = next;
      await this.persist(state, next);
      return next;
    }

    const files = snapshot.files.filter((path) => !currentIndexPaths.has(path));
    let current = snapshot;
    if (files.length !== snapshot.files.length) {
      const checkedAt = Object.fromEntries(
        files.map((path) => [path, snapshot.checkedAt[path] ?? 0]),
      );
      current = { ...snapshot, ...tree, files, checkedAt };
    } else if (indexChanged) {
      current = { ...snapshot, ...tree };
    }
    if (current !== snapshot) {
      state.snapshot = current;
      await this.persist(state, current);
    } else if (!snapshot.indexPaths) {
      current = { ...snapshot, indexPaths: tree.indexPaths };
      state.snapshot = current;
    }

    return current;
  }

  private async refresh(
    projectPath: string,
    tree: GitTreeState,
  ): Promise<UntrackedSnapshot> {
    const [ignored, headPaths] = await Promise.all([
      readIgnoredPaths(projectPath),
      readHeadPaths(projectPath, tree.headSha),
    ]);
    const trackedPaths = new Set([...headPaths, ...tree.indexPaths]);
    const walked = await walkCandidateFiles(
      projectPath,
      ignored,
      trackedPaths,
      this.cacheFileLimit,
    );
    const refreshedAt = this.now();
    const files = walked.files.sort((a, b) => a.localeCompare(b));
    return {
      projectPath,
      ...tree,
      files,
      checkedAt: Object.fromEntries(files.map((path) => [path, refreshedAt])),
      refreshedAt,
      truncated: walked.truncated,
    };
  }

  private async recheckSelected(
    state: ProjectCacheState,
    snapshot: UntrackedSnapshot,
    selected: readonly string[],
  ): Promise<{ snapshot: UntrackedSnapshot; changed: boolean }> {
    const now = this.now();
    const due = selected.filter(
      (path) =>
        now - (snapshot.checkedAt[path] ?? 0) >= this.fileRecheckIntervalMs,
    );
    if (due.length === 0) return { snapshot, changed: false };

    const missing = new Set<string>();
    await Promise.all(
      due.map(async (path) => {
        try {
          await lstat(join(snapshot.projectPath, ...path.split("/")));
        } catch (error) {
          if (isMissingPathError(error)) {
            missing.add(path);
          } else {
            getLogger().warn(
              { error, projectPath: snapshot.projectPath, path },
              "GIT_UNTRACKED_CACHE: stale-path check failed",
            );
          }
        }
      }),
    );

    const files =
      missing.size === 0
        ? snapshot.files
        : snapshot.files.filter((path) => !missing.has(path));
    const checkedAt = { ...snapshot.checkedAt };
    for (const path of due) checkedAt[path] = now;
    for (const path of missing) delete checkedAt[path];
    const next = { ...snapshot, files, checkedAt };
    state.snapshot = next;
    await this.persist(state, next);
    return { snapshot: next, changed: missing.size > 0 };
  }

  private persist(
    state: ProjectCacheState,
    snapshot: UntrackedSnapshot,
  ): Promise<void> {
    state.persistPromise = state.persistPromise
      .then(() => this.writePersisted(snapshot))
      .catch((error) => {
        getLogger().warn(
          { error, projectPath: snapshot.projectPath },
          "GIT_UNTRACKED_CACHE: persistence failed",
        );
      });
    return state.persistPromise;
  }

  private async readPersisted(
    projectPath: string,
  ): Promise<UntrackedSnapshot | null> {
    try {
      const parsed = JSON.parse(
        await readFile(this.cachePath(projectPath), "utf8"),
      ) as unknown;
      return parsePersistedSnapshot(parsed, projectPath);
    } catch (error) {
      if (isMissingPathError(error)) return null;
      getLogger().warn(
        { error, projectPath },
        "GIT_UNTRACKED_CACHE: persisted cache ignored",
      );
      return null;
    }
  }

  private async writePersisted(snapshot: UntrackedSnapshot): Promise<void> {
    await mkdir(this.cacheDir, { recursive: true });
    const target = this.cachePath(snapshot.projectPath);
    const temporary = `${target}.${process.pid}.tmp`;
    const { indexPaths: _, ...persisted } = snapshot;
    const payload: PersistedUntrackedSnapshot = {
      version: CACHE_VERSION,
      ...persisted,
    };
    try {
      await writeFile(temporary, `${JSON.stringify(payload)}\n`, "utf8");
      await rename(temporary, target);
    } catch (error) {
      await rm(temporary).catch(() => undefined);
      throw error;
    }
  }

  private cachePath(projectPath: string): string {
    const key = createHash("sha256").update(projectPath).digest("hex");
    return join(this.cacheDir, `${key}.json`);
  }
}

async function readTreeState(projectPath: string): Promise<GitTreeState> {
  const [headSha, index] = await Promise.all([
    readHeadSha(projectPath),
    runGit(projectPath, ["ls-files", "-z", "--cached"], {
      maxBuffer: GIT_LIST_MAX_BUFFER,
    }),
  ]);
  return {
    headSha,
    indexDigest: createHash("sha256").update(index.stdout).digest("hex"),
    indexPaths: splitNullPaths(index.stdout),
  };
}

/** HEAD paths stay excluded after `git rm --cached`; read only on refresh. */
async function readHeadPaths(
  projectPath: string,
  headSha: string | null,
): Promise<string[]> {
  if (!headSha) return [];
  const result = await runGit(
    projectPath,
    ["ls-tree", "-r", "-z", "--name-only", headSha],
    { maxBuffer: GIT_LIST_MAX_BUFFER },
  );
  return splitNullPaths(result.stdout);
}

async function readHeadSha(projectPath: string): Promise<string | null> {
  try {
    const result = await runGit(projectPath, ["rev-parse", "--verify", "HEAD"]);
    return result.stdout.trim() || null;
  } catch (error) {
    if (isExitCode(error, 1)) return null;
    throw error;
  }
}

async function readIgnoredPaths(projectPath: string): Promise<Set<string>> {
  const result = await runGit(
    projectPath,
    [
      "ls-files",
      "-z",
      "--others",
      "--ignored",
      "--exclude-standard",
      "--directory",
    ],
    { maxBuffer: GIT_LIST_MAX_BUFFER },
  );
  return new Set(splitNullPaths(result.stdout));
}

async function walkCandidateFiles(
  projectPath: string,
  ignored: ReadonlySet<string>,
  trackedPaths: ReadonlySet<string>,
  limit: number,
): Promise<{ files: string[]; truncated: boolean }> {
  const files: string[] = [];
  let truncated = false;

  const visit = async (
    absoluteDirectory: string,
    relativeDirectory: string,
  ) => {
    try {
      const directory = await opendir(absoluteDirectory);
      for await (const entry of directory) {
        if (relativeDirectory === "" && entry.name === ".git") continue;
        const relativePath = relativeDirectory
          ? `${relativeDirectory}/${entry.name}`
          : entry.name;
        if (
          ignored.has(relativePath) ||
          ignored.has(`${relativePath}/`) ||
          trackedPaths.has(relativePath)
        ) {
          continue;
        }
        if (entry.isDirectory()) {
          await visit(join(absoluteDirectory, entry.name), relativePath);
          if (truncated) break;
        } else if (entry.isFile() || entry.isSymbolicLink()) {
          if (files.length === limit) {
            truncated = true;
            break;
          }
          files.push(relativePath);
        }
      }
    } catch (error) {
      if (relativeDirectory && isMissingDirectoryError(error)) return;
      throw error;
    }
  };

  await visit(projectPath, "");
  return { files, truncated };
}

function selectFiles(
  files: readonly string[],
  query: GitUntrackedCacheQuery,
): string[] {
  if (query.path) {
    return files.filter((path) => path.startsWith(query.path!));
  }
  const normalizedQuery = query.q?.trim().toLowerCase();
  if (normalizedQuery) {
    return files.filter((path) => path.toLowerCase().includes(normalizedQuery));
  }
  return [...files];
}

function summarizeRoot(files: readonly string[]): {
  files: string[];
  folders: Array<{ path: string; count: number }>;
} {
  const rootFiles: string[] = [];
  const counts = new Map<string, number>();
  for (const path of files) {
    const slash = path.indexOf("/");
    if (slash < 0) {
      rootFiles.push(path);
      continue;
    }
    const folder = `${path.slice(0, slash)}/`;
    counts.set(folder, (counts.get(folder) ?? 0) + 1);
  }
  return {
    files: rootFiles.sort((a, b) => a.localeCompare(b)),
    folders: Array.from(counts, ([path, count]) => ({ path, count })).sort(
      (a, b) => a.path.localeCompare(b.path),
    ),
  };
}

function parsePersistedSnapshot(
  value: unknown,
  projectPath: string,
): UntrackedSnapshot | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<PersistedUntrackedSnapshot>;
  if (
    candidate.version !== CACHE_VERSION ||
    candidate.projectPath !== projectPath ||
    (candidate.headSha !== null && typeof candidate.headSha !== "string") ||
    typeof candidate.indexDigest !== "string" ||
    !isRepositoryRelativePathArray(candidate.files) ||
    !candidate.checkedAt ||
    typeof candidate.checkedAt !== "object" ||
    typeof candidate.refreshedAt !== "number" ||
    typeof candidate.truncated !== "boolean"
  ) {
    return null;
  }
  const checkedAt = Object.fromEntries(
    Object.entries(candidate.checkedAt).filter(
      (entry): entry is [string, number] => typeof entry[1] === "number",
    ),
  );
  return {
    projectPath,
    headSha: candidate.headSha,
    indexDigest: candidate.indexDigest,
    indexPaths: null,
    files: candidate.files,
    checkedAt,
    refreshedAt: candidate.refreshedAt,
    truncated: candidate.truncated,
  };
}

function splitNullPaths(stdout: string): string[] {
  return stdout.split("\0").filter(Boolean);
}

function isRepositoryRelativePathArray(value: unknown): value is string[] {
  if (!Array.isArray(value)) return false;
  return value.every((item) => {
    if (typeof item !== "string") return false;
    try {
      repositoryRelativePath(item);
      return true;
    } catch {
      return false;
    }
  });
}

function isExitCode(error: unknown, code: number): boolean {
  return (
    !!error &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}

function isMissingPathError(error: unknown): boolean {
  return (
    !!error &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

function isMissingDirectoryError(error: unknown): boolean {
  return (
    isMissingPathError(error) ||
    (!!error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: unknown }).code === "ENOTDIR")
  );
}
