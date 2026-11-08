import { isAbsolute, join, relative, resolve, sep } from "node:path";
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

export interface CodexSharedScanCacheEntry {
  /** Absent for exact point evidence before any complete enumeration. */
  timestamp?: number;
  /** Watcher epoch the enumeration began under; see tree observation. */
  epoch?: number | null;
  sessions: Map<string, CodexSessionFile>;
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
