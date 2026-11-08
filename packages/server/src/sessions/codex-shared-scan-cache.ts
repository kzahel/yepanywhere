import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { getProjectIdentityKey } from "../projects/paths.js";
import {
  getCodexRolloutFileIdentity,
  isCodexRolloutFileName,
  plainCodexRolloutPath,
} from "../utils/codexRolloutFiles.js";
import type { EventBus } from "../watcher/EventBus.js";
import {
  type CodexRolloutTreeEpoch,
  canonicalCodexChange,
  observedCodexRoot,
  registerCodexRolloutTreeObserver,
} from "./codex-rollout-tree-observation.js";

export interface CodexSessionFile {
  id: string;
  filePath: string;
  cwd: string;
  timestamp: string;
  mtime: number;
  size: number;
  isSubagent: boolean;
  parentThreadId?: string | null;
  agentNickname?: string;
  agentRole?: string;
  spawnDepth?: number;
}

export function isNewerCodexSessionFile(
  candidate: CodexSessionFile,
  current: CodexSessionFile,
): boolean {
  const candidateIdentity = getCodexRolloutFileIdentity(candidate.filePath);
  const currentIdentity = getCodexRolloutFileIdentity(current.filePath);
  if (
    candidateIdentity?.timestamp &&
    currentIdentity?.timestamp &&
    candidateIdentity.timestamp !== currentIdentity.timestamp
  ) {
    return candidateIdentity.timestamp > currentIdentity.timestamp;
  }
  if (
    candidateIdentity?.timestamp === currentIdentity?.timestamp &&
    candidateIdentity?.rolloutId !== currentIdentity?.rolloutId
  ) {
    return (
      (candidateIdentity?.rolloutId ?? "") > (currentIdentity?.rolloutId ?? "")
    );
  }
  if (candidate.mtime !== current.mtime) {
    return candidate.mtime > current.mtime;
  }
  return candidate.filePath > current.filePath;
}

export interface CodexScanOptions {
  activeAfterMs?: number;
}

/** Mutations a reader may replay instead of re-merging a whole enumeration. */
const CHANGE_LOG_LIMIT = 1024;

/**
 * One enumeration's sessions. `version` advances on every mutation, so every
 * reader of the tree can share views derived from an unchanged enumeration
 * instead of copying the whole tree on each cache hit, and a bounded log of
 * changed ids lets a reader that is a few versions behind apply only those.
 */
export class CodexSessionMap extends Map<string, CodexSessionFile> {
  version = 0;
  /** `changed[i]` is the id written by version `changedBase + i + 1`. */
  private changed: string[] = [];
  private changedBase = 0;

  override set(id: string, session: CodexSessionFile): this {
    this.record(id);
    return super.set(id, session);
  }

  override delete(id: string): boolean {
    const deleted = super.delete(id);
    if (deleted) this.record(id);
    return deleted;
  }

  override clear(): void {
    this.version += 1;
    // Nothing earlier can be replayed across a clear.
    this.changed = [];
    this.changedBase = this.version;
    super.clear();
  }

  /**
   * Sessions written since `version`, or undefined when the log no longer
   * reaches back that far. Removals are omitted: readers keep their own
   * newest-wins history, as a full re-merge would.
   */
  changesSince(version: number): CodexSessionFile[] | undefined {
    if (version < this.changedBase || version > this.version) return undefined;
    const sessions: CodexSessionFile[] = [];
    for (const id of new Set(this.changed.slice(version - this.changedBase))) {
      const session = this.get(id);
      if (session) sessions.push(session);
    }
    return sessions;
  }

  private record(id: string): void {
    this.version += 1;
    this.changed.push(id);
    if (this.changed.length > CHANGE_LOG_LIMIT) {
      const drop = this.changed.length - CHANGE_LOG_LIMIT;
      this.changed.splice(0, drop);
      this.changedBase += drop;
    }
  }
}

export interface CodexVisibleSessions {
  /** Shared by every caller of one version; callers must not mutate it. */
  sessions: readonly CodexSessionFile[];
  subagents: number;
}

const visibleViews = new WeakMap<
  CodexSessionMap,
  CodexVisibleSessions & { version: number }
>();

/** Ordinary lists exclude subagent threads; provider children surface them. */
export function visibleCodexSessions(
  sessions: CodexSessionMap | readonly CodexSessionFile[],
): CodexVisibleSessions {
  const cached =
    sessions instanceof CodexSessionMap
      ? visibleViews.get(sessions)
      : undefined;
  if (
    sessions instanceof CodexSessionMap &&
    cached?.version === sessions.version
  )
    return cached;
  const visible: CodexSessionFile[] = [];
  let subagents = 0;
  for (const session of sessions.values()) {
    if (session.isSubagent) subagents += 1;
    else visible.push(session);
  }
  const view = { sessions: visible, subagents };
  if (sessions instanceof CodexSessionMap)
    visibleViews.set(sessions, { ...view, version: sessions.version });
  return view;
}

const projectPartitions = new WeakMap<
  readonly CodexSessionFile[],
  Map<string, CodexSessionFile[]>
>();

/**
 * One project's share of an enumeration. A shared visible list is partitioned
 * once per version, so listing every project costs one pass, not one per
 * project.
 */
export function codexSessionsInProject(
  sessions: readonly CodexSessionFile[],
  projectIdentityKey: string | undefined,
): readonly CodexSessionFile[] {
  if (!projectIdentityKey) return sessions;
  let partition = projectPartitions.get(sessions);
  if (!partition) {
    partition = new Map();
    for (const session of sessions) {
      const key = getProjectIdentityKey(session.cwd);
      const members = partition.get(key);
      if (members) members.push(session);
      else partition.set(key, [session]);
    }
    projectPartitions.set(sessions, partition);
  }
  return partition.get(projectIdentityKey) ?? [];
}

export interface CodexSharedScanCacheEntry {
  /** Absent for exact point evidence before any complete enumeration. */
  timestamp?: number;
  /** Watcher epoch the enumeration began under; see tree observation. */
  epoch?: number | null;
  sessions: CodexSessionMap;
  activeAfterMs?: number;
  inFlight?: Promise<CodexSessionFile[]>;
  /** Plain rollout paths the watcher reported since the enumeration began. */
  changedPaths: Set<string>;
  applyingChanges?: Promise<void>;
  /** A reported deletion left this enumeration unable to stand in for a walk. */
  needsEnumeration?: boolean;
  /** A cache hit cannot upgrade an incomplete enumeration to known empty. */
  incomplete?: boolean;
  failedPaths?: Set<string>;
  directoryReadErrors?: boolean;
}

/**
 * Keyed by sessions directory and active-after cutoff. Bounded per sessions
 * directory to the unfiltered scan plus the latest settled cutoff and any
 * in-flight scans; see `retainLatestCutoff`.
 */
export const codexSharedScanCache = new Map<
  string,
  Map<string, CodexSharedScanCacheEntry>
>();

/**
 * While `epoch` reports a live watcher over `sessionsDir`, cached
 * enumerations of it stay current between that watcher's reports instead of
 * re-walking cold history on a timer. Returns the teardown.
 */
export function observeCodexRolloutTree(options: {
  sessionsDir: string;
  eventBus: Pick<EventBus, "subscribe">;
  epoch: CodexRolloutTreeEpoch;
}): () => void {
  let retired = false;
  const unregister = registerCodexRolloutTreeObserver(
    options.sessionsDir,
    options.epoch,
  );
  const unsubscribe = options.eventBus.subscribe((event) => {
    if (event.type !== "file-change" || event.provider !== "codex") return;
    // Preserve synchronous invalidation of the configured root. Canonical
    // aliases are folded in asynchronously without delaying the raw event.
    let touched: ReadonlySet<string> | undefined;
    if (
      !event.nativeStorageScope ||
      resolve(event.nativeStorageScope) === resolve(options.sessionsDir)
    )
      touched = noteCodexRolloutChanged(options.sessionsDir, event.path);
    if (!event.nativeStorageScope) {
      return;
    }
    void canonicalCodexChange(event, options.sessionsDir)
      .then((change) => {
        if (change && !retired)
          noteCodexRolloutChanged(change.scope, change.path, touched);
      })
      .catch(() => {
        /* Source unavailable; retain accepted observations. */
      });
  });
  return () => {
    retired = true;
    unsubscribe();
    unregister();
  };
}

/**
 * Record a watcher-reported rollout change so cached enumerations of that
 * tree re-read just this file instead of re-walking the whole tree.
 */
function noteCodexRolloutChanged(
  sessionsDir: string,
  filePath: string,
  except?: ReadonlySet<string>,
): Set<string> {
  const touched = new Set<string>();
  if (!isCodexRolloutFileName(filePath)) return touched;
  const plainPath = plainCodexRolloutPath(filePath);
  const root = observedCodexRoot(sessionsDir);
  const outside = (suffix: string) =>
    !suffix ||
    suffix === ".." ||
    suffix.startsWith(`..${sep}`) ||
    isAbsolute(suffix);
  let suffix = relative(sessionsDir, plainPath);
  if (outside(suffix)) suffix = relative(root, plainPath);
  if (outside(suffix)) return touched;
  for (const [dir, rootCache] of codexSharedScanCache) {
    if (except?.has(dir) || observedCodexRoot(dir) !== root) continue;
    touched.add(dir);
    const scopedPath = join(dir, suffix);
    for (const entry of rootCache.values()) entry.changedPaths.add(scopedPath);
  }
  return touched;
}
