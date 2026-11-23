import type { SDKMessage } from "../types.js";
import {
  AntigravityLiveProjection,
  type AntigravitySplitCheck,
} from "./antigravity-live-projection.js";

/**
 * Where a live session's history divides between `agy`'s brain log and its
 * owner's memory: a complete record of the log (its step and the byte
 * offset after its newline). Records through it are served from the log;
 * what the owner produced since, from its live projection. It starts at
 * the log's last record when the owner resumed, or at an empty log
 * (`step: -1, end: 0`) for a new session or a resume with no log, and
 * only moves forward: plan 195
 * step 6 moves it to a proven split point once the owner's rows pass a
 * soft budget ({@link AntigravityLiveProjection}).
 */
export interface AntigravityLogBoundary {
  step: number;
  end: number;
  /**
   * Where that record's line starts, so a read checks the boundary from a
   * bounded witness at fixed offsets, whatever the record's size.
   */
  start?: number;
  /**
   * The line's first bytes (at most 40) when the boundary was taken,
   * compared byte for byte by every bounded read, so a record in any
   * parseable encoding is checked the same way it was accepted.
   */
  witness?: string;
  /**
   * The log file's identity when the boundary was taken: a replaced file is
   * not the history it bounds. An in-place edit of earlier records that
   * keeps the boundary record's witness and offset is not detected (plan
   * 195 step 7 owns external writes).
   */
  dev?: number;
  ino?: number;
}

/**
 * Why history before an owner's resume point cannot be shown: the
 * conversation had no log when it resumed (and was prompted before), or a
 * log YA cannot read. Plan 195 step 8 removed the ACP replay that used to
 * stand in for it; `agy` keeps the conversation's context in its database.
 */
export type AntigravityHistoryGap = "missing" | "unknown";

/**
 * How long a released owner is remembered: writes made before it let go
 * reach YA's watcher a debounce later. The tracker's abort grace.
 */
const RELEASED_MEMORY_MS = 30_000;

// One entry per live owner; removed when its iterator closes. The owner
// stays in-process: readers join its rows with the log (plan 195 step 9
// moves it into the Provider Host).
interface NativeSessionOwner {
  /** Set once the owner's session is open. */
  open?: AntigravityLiveProjection;
  /** History before the resume point that cannot be shown. */
  earlier?: AntigravityHistoryGap;
}
const ownedNativeSessions = new Map<string, NativeSessionOwner>();
/**
 * When each recently released owner let go, `Date.now()`; entries older
 * than RELEASED_MEMORY_MS are dropped on the next release or attribution,
 * so it holds only owners released that recently.
 */
const releasedAt = new Map<string, number>();

function forgetOldReleases(now: number): void {
  for (const [key, at] of releasedAt) {
    if (now - at < RELEASED_MEMORY_MS) break;
    releasedAt.delete(key);
  }
}

const keyOf = (scope: string, id: string) => `${scope}\0${id}`;

/** What a reader may serve for a conversation an open owner holds. */
export interface AntigravityOwnerView {
  /** Identifies this owner across a read. */
  owner: object;
  /** Changes whenever the boundary moves or rows leave memory. */
  generation: number;
  boundary: AntigravityLogBoundary;
  /** History before the resume point that cannot be shown. */
  earlier?: AntigravityHistoryGap;
  /** Whether the live projection holds this message ID. */
  has(messageId: string): boolean;
  /** Whether a row this owner recorded left memory (moved or evicted). */
  retired(messageId: string): boolean;
  /** Rows the cap evicted that the log does not serve yet. */
  incomplete: boolean;
  /** The boundary the owner opened at: log rows after it were once live. */
  opened: AntigravityLogBoundary;
  /** The first prompt, when the log cannot title the conversation. */
  firstPrompt?: string;
  /** A copy of the live projection, taken when called. */
  history(): SDKMessage[];
}

/**
 * The reader's view of a conversation's open owner. An owner that is still
 * starting has written nothing past the log, so a reader reads the log as
 * for a stopped conversation. Call `history()` before the next await: it
 * copies the projection as it is then.
 */
export function antigravityOwnerView(
  scope: string,
  id: string,
): AntigravityOwnerView | undefined {
  const owner = ownedNativeSessions.get(keyOf(scope, id));
  const live = owner?.open;
  if (!owner || !live) return undefined;
  return {
    owner,
    generation: live.generation,
    boundary: live.boundary,
    ...(owner.earlier ? { earlier: owner.earlier } : {}),
    has: (messageId) => live.has(messageId),
    retired: (messageId) => live.retired(messageId),
    incomplete: live.incomplete,
    opened: live.opened,
    firstPrompt: live.firstPrompt,
    history: () => live.history(),
  };
}

/**
 * The live projection of an open owner: its rows after its boundary; the
 * history through the boundary is in the log.
 */
export function antigravityLiveHistory(
  scope: string,
  id: string,
): SDKMessage[] | undefined {
  return antigravityOwnerView(scope, id)?.history();
}

export function antigravitySessionOwned(scope: string, id: string): boolean {
  return ownedNativeSessions.has(keyOf(scope, id));
}

/**
 * Whether YA's own `agy` may have made a write to a conversation's
 * database, WAL or log at `mtimeMs` (the file's modification time; plan
 * 195 step 7): an owner holds the conversation, or let go of it after the
 * write. An owner is registered before its `agy` starts and holds the
 * conversation until that `agy` has exited, and an idle `agy` checkpoints
 * its database about 30 s after its last write, so every file change
 * while an owner holds the conversation is taken as its own; another
 * writer beside a live owner is the owner's own check to find
 * (`AntigravitySplitSampler`), from the log alone.
 */
export function antigravityWriteIsOwn(
  scope: string,
  id: string,
  mtimeMs: number,
  now = Date.now(),
): boolean {
  const key = keyOf(scope, id);
  if (ownedNativeSessions.has(key)) return true;
  forgetOldReleases(now);
  const released = releasedAt.get(key);
  return released !== undefined && mtimeMs <= released;
}

/** Owns a native session for a live run; another live owner refuses. */
export function ownAntigravitySession(scope: string, id: string) {
  const key = keyOf(scope, id);
  if (ownedNativeSessions.has(key))
    throw new Error("Antigravity session already has a local owner");
  const owner: NativeSessionOwner = {};
  ownedNativeSessions.set(key, owner);
  return {
    release: () => {
      if (ownedNativeSessions.get(key) !== owner) return;
      owner.open?.close();
      ownedNativeSessions.delete(key);
      const now = Date.now();
      forgetOldReleases(now);
      releasedAt.delete(key);
      releasedAt.set(key, now);
    },
    /**
     * The session is open: readers now serve the log through `boundary`
     * and then this projection. `earlier` says why history before the
     * resume point cannot be shown, if it cannot.
     */
    open(
      boundary: AntigravityLogBoundary,
      check?: AntigravitySplitCheck,
      earlier?: AntigravityHistoryGap,
    ): AntigravityLiveProjection {
      owner.earlier = earlier;
      owner.open = new AntigravityLiveProjection({ ...boundary }, check);
      return owner.open;
    },
    /** Records a row in the open owner's projection. */
    record(message: SDKMessage): void {
      if (!owner.open) throw new Error("Antigravity owner is not open");
      owner.open.record(message);
    },
  };
}
