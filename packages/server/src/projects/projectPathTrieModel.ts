import { type Dirent, type FSWatcher, statSync } from "node:fs";
import { lstat } from "node:fs/promises";
import { isAbsolute, normalize, sep } from "node:path";

/** Estimated retained bytes per cached path component. */
export const NODE_BASE_BYTES = 96;

/** What one directory-component edge is known to be. */
export type NodeState = "absent" | "directory" | "file";

export interface PathNode {
  /** Whether this exact node is still reachable from the index root. */
  attached: boolean;
  /** Changes whenever this node's path identity or subtree is invalidated. */
  attachmentGeneration: number;
  children: Map<string, PathNode> | undefined;
  /** Whether `children` names every entry, so an unlisted name is absent. */
  complete: boolean;
  /** Observed `dev:ino` directory identity used to detect same-name replacement. */
  inodeIdentity: string | undefined;
  name: string;
  /**
   * Names probed here since this generation began, across all batches.
   *
   * One wide batch is not the only way a directory earns a listing. Turn-text
   * annotation asks about two or three names per rendered body, so a directory
   * the reader keeps referring to would pay an `lstat` per name forever on the
   * per-batch test alone.
   */
  probedNames: number;
  state: NodeState;
  /** True when a worker stall may have delayed events for this preserved child. */
  stateStale: boolean;
  watcher: FSWatcher | undefined;
  /** Exact in-flight observations, scoped to watcher identity and generation. */
  watcherClaims: Set<WatchObservation>;
  /** Changes whenever the current watcher observes or loses filesystem truth. */
  watcherGeneration: number;
  /** Whether one listing proved this directory too wide to retain whole. */
  wide: boolean;
}

export interface MutablePathIndexStats {
  /** Candidates answered from cache with no filesystem call. */
  cachedAnswers: number;
  directoryListings: number;
  /** Subtrees dropped to stay within the per-project byte ceiling. */
  evictedDirectories: number;
  exactProbes: number;
  lookupBatches: number;
  lookupCandidates: number;
  /** Listings too wide to retain, used for their batch only. */
  oversizedListings: number;
  /** Watch errors that discarded a directory's cached generation. */
  uncertainGenerations: number;
  /** Cached edges invalidated by a filesystem event. */
  watcherInvalidations: number;
}

export interface ParsedCandidate {
  components: string[];
  original: string;
}

export type WatchListener = (
  event: string,
  filename: string | Buffer | null,
) => void;

export interface WatchObservation {
  absolutePath: string;
  attachmentGeneration: number;
  generation: number;
  registryActivityGeneration: number;
  released: boolean;
  stallGeneration: number;
  watcher: FSWatcher;
}

export interface DirectoryListing {
  kinds: Map<string, NodeState>;
  observation: WatchObservation | null;
}

export interface ProjectPathIndexStats extends MutablePathIndexStats {
  completeDirectories: number;
  hydratedDirectories: number;
  retainedBytes: number;
  watchers: number;
}

export interface ProjectPathCacheStats {
  evictedProjects: number;
  projects: number;
  retainedBytes: number;
  watchers: number;
}

/** Filesystem access, injectable so tests can count and fault-inject I/O. */
export interface PathIndexIo {
  lstat(path: string): Promise<{
    isDirectory(): boolean;
    dev?: number | bigint;
    ino?: number | bigint;
  }>;
  readdir(path: string): Promise<Dirent[]>;
  watch(path: string, listener: WatchListener): FSWatcher;
}

export interface PathIndexOptions {
  io?: PathIndexIo;
  maxIndexBytes?: number;
  maxIndexWatchers?: number;
  maxRetainedEntries?: number;
  /** Registry hook; called only after a retention mutation is self-consistent. */
  onRetentionChanged?: () => void;
}

export function canClearStaleDirectoryState(
  existing: PathNode,
  inodeIdentity?: string,
): boolean {
  return (
    !existing.stateStale ||
    existing.state !== "directory" ||
    existing.inodeIdentity === undefined ||
    inodeIdentity !== undefined
  );
}

export function createPathIndexStats(): MutablePathIndexStats {
  return {
    cachedAnswers: 0,
    directoryListings: 0,
    evictedDirectories: 0,
    exactProbes: 0,
    lookupBatches: 0,
    lookupCandidates: 0,
    oversizedListings: 0,
    uncertainGenerations: 0,
    watcherInvalidations: 0,
  };
}

export function directoryIdentityChanged(
  existing: PathNode,
  nextState: NodeState,
  inodeIdentity?: string,
): boolean {
  return (
    existing.state === "directory" &&
    nextState === "directory" &&
    existing.inodeIdentity !== undefined &&
    inodeIdentity !== undefined &&
    existing.inodeIdentity !== inodeIdentity
  );
}

export function createNode(
  name: string,
  state: NodeState,
  attached = false,
): PathNode {
  return {
    attached,
    attachmentGeneration: 0,
    children: undefined,
    complete: false,
    inodeIdentity: undefined,
    name,
    probedNames: 0,
    state,
    stateStale: false,
    watcher: undefined,
    watcherClaims: new Set(),
    watcherGeneration: 0,
    wide: false,
  };
}

export function nodeBytes(name: string): number {
  return NODE_BASE_BYTES + name.length * 2;
}

export function hasRetainedFacts(node: PathNode): boolean {
  return node.complete || node.wide || (node.children?.size ?? 0) > 0;
}

export function subtreeContains(node: PathNode, candidate: PathNode): boolean {
  if (node === candidate) return true;
  for (const child of node.children?.values() ?? []) {
    if (subtreeContains(child, candidate)) return true;
  }
  return false;
}

export function formatDirectoryIdentity(entry: {
  isDirectory(): boolean;
  dev?: number | bigint;
  ino?: number | bigint;
}): string | undefined {
  return entry.isDirectory() &&
    entry.dev !== undefined &&
    entry.ino !== undefined
    ? `${entry.dev}:${entry.ino}`
    : undefined;
}

function isPortableAbsolute(path: string): boolean {
  return (
    isAbsolute(path) || /^[A-Za-z]:[\\/]/.test(path) || /^[/\\]{2}/.test(path)
  );
}

export function parseRelativeComponents(path: string): string[] | null {
  if (!path || path.includes("\0") || isPortableAbsolute(path)) return null;
  const rawComponents = path.split(/[\\/]+/);
  if (rawComponents.includes("..")) return null;

  const normalized = normalize(path);
  if (
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith(`..${sep}`)
  ) {
    return null;
  }
  const components = normalized.split(sep).filter(Boolean);
  return components.length > 0 ? components : null;
}

/** Whether this error proves the queried path is not there. */
export function provesAbsence(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR";
}

export function isUnavailablePathError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return (
    code === "EACCES" ||
    code === "ENOENT" ||
    code === "ENOTDIR" ||
    code === "EPERM"
  );
}

export async function forEachConcurrent<T>(
  values: readonly T[],
  concurrency: number,
  visit: (value: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, values.length) },
    async () => {
      while (cursor < values.length) {
        const index = cursor;
        cursor += 1;
        const value = values[index];
        if (value !== undefined) await visit(value);
      }
    },
  );
  await Promise.all(workers);
}

export function readDirectoryIdentitySync(path: string): string | undefined {
  try {
    const stats = statSync(path);
    return stats.isDirectory() ? `${stats.dev}:${stats.ino}` : undefined;
  } catch {
    return undefined;
  }
}

export async function readDirectoryIdentity(
  path: string,
): Promise<string | null> {
  try {
    const stats = await lstat(path);
    return stats.isDirectory() ? `${stats.dev}:${stats.ino}` : null;
  } catch {
    return null;
  }
}

export async function findContradictedDirectoryChildren(
  node: PathNode,
  absolutePath: string,
  kinds: ReadonlyMap<string, NodeState>,
  concurrency: number,
  joinPath: (parent: string, name: string) => string,
): Promise<Array<[string, PathNode]>> {
  const toVerify: string[] = [];
  for (const [name, child] of node.children ?? []) {
    if (
      child.state === "directory" &&
      kinds.get(name) === "directory" &&
      child.inodeIdentity !== undefined &&
      (child.watcher !== undefined ||
        child.children !== undefined ||
        child.complete ||
        child.wide)
    ) {
      toVerify.push(name);
    }
  }
  if (toVerify.length === 0) return [];
  const verifiedIdentities = new Map<string, string | null>();
  await forEachConcurrent(toVerify, concurrency, async (name) => {
    verifiedIdentities.set(
      name,
      await readDirectoryIdentity(joinPath(absolutePath, name)),
    );
  });
  const contradicted: Array<[string, PathNode]> = [];
  for (const name of toVerify) {
    const child = node.children?.get(name);
    if (!child || child.inodeIdentity === undefined) continue;
    if (verifiedIdentities.get(name) !== child.inodeIdentity) {
      contradicted.push([name, child]);
    }
  }
  return contradicted;
}
