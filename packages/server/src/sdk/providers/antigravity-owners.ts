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
 * (`step: -1, end: 0`) for a new session, and only moves forward: plan 195
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
 * What an owner's own `agy` is doing, for telling its writes from another
 * writer's (plan 195 step 7).
 */
export interface AntigravityWriterState {
  /**
   * A prompt or command awaits its answer, the runtime is closing, or
   * detached work (a background task, a child, a wake) is retained: `agy`
   * may write at any moment.
   */
  busy(): boolean;
  /** When a frame last crossed the owner's ACP pipe (`Date.now()`). */
  lastActivityMs(): number;
}

/**
 * How long after an idle owner's last ACP frame a write is still its own.
 * `agy` writes a turn's records before its result and a wake's last record
 * within about 20 ms of its last update (measured on 1.5.13 and 1.5.14).
 */
export const OWN_WRITE_SETTLE_MS = 2_000;
/**
 * How long a released owner is remembered: writes made before it let go
 * reach YA's watcher a debounce later. The tracker's abort grace.
 */
const RELEASED_MEMORY_MS = 30_000;

// One entry per live preview owner; removed when its iterator closes. The preview
// stays in-process so readers never replay a database held by another owner.
interface NativeSessionOwner {
  /** A bounded history read, which a live session may wait out. */
  historyRead: boolean;
  released: Promise<void>;
  writer?: AntigravityWriterState;
  /**
   * Set once the owner's session is open. Without a boundary its live
   * projection is the whole history (a session resumed through the ACP
   * replay fallback).
   */
  open?: AntigravityLiveProjection;
}
const ownedNativeSessions = new Map<string, NativeSessionOwner>();
/** Sessions whose owner has started but not yet taken its lease. */
const startingSessions = new Map<string, number>();
/** Readers waiting for a starting owner to open or go. */
const settleWaiters = new Map<string, Set<() => void>>();
/**
 * When each recently released owner (live or a fallback history read) let
 * go, `Date.now()`; entries older than RELEASED_MEMORY_MS are dropped on the
 * next release or attribution, so it holds only owners released that recently.
 */
const releasedAt = new Map<string, number>();

function forgetOldReleases(now: number): void {
  for (const [key, at] of releasedAt) {
    if (now - at < RELEASED_MEMORY_MS) break;
    releasedAt.delete(key);
  }
}

const keyOf = (scope: string, id: string) => `${scope}\0${id}`;

function settle(key: string): void {
  const waiters = settleWaiters.get(key);
  if (!waiters) return;
  settleWaiters.delete(key);
  for (const resolve of waiters) resolve();
}

/** What a reader may serve for a conversation an owner holds. */
export type AntigravityOwnerView =
  /** An owner is starting: the log holds everything so far. */
  | { state: "starting" }
  | {
      state: "open";
      /** Identifies this owner across a read. */
      owner: object;
      /** Changes whenever the boundary moves or rows leave memory. */
      generation: number;
      boundary?: AntigravityLogBoundary;
      /** Whether the live projection holds this message ID. */
      has(messageId: string): boolean;
      /** Whether a row this owner recorded left memory (moved or evicted). */
      retired(messageId: string): boolean;
      /** Rows the cap evicted that the log does not serve yet. */
      incomplete: boolean;
      /** The boundary the owner opened at: log rows after it were once live. */
      opened?: AntigravityLogBoundary;
      /** The first prompt, when the log cannot title the conversation. */
      firstPrompt?: string;
      /** A copy of the live projection, taken when called. */
      history(): SDKMessage[];
    };

/**
 * The reader's view of a conversation's owner, if it has one other than a
 * history read. Call `history()` before the next await: it copies the
 * projection as it is then.
 */
export function antigravityOwnerView(
  scope: string,
  id: string,
): AntigravityOwnerView | undefined {
  const key = keyOf(scope, id);
  const owner = ownedNativeSessions.get(key);
  const live = owner && !owner.historyRead ? owner.open : undefined;
  if (owner && live)
    return {
      state: "open",
      owner,
      generation: live.generation,
      boundary: live.boundary,
      has: (messageId) => live.has(messageId),
      retired: (messageId) => live.retired(messageId),
      incomplete: live.incomplete,
      opened: live.opened,
      firstPrompt: live.firstPrompt,
      history: () => live.history(),
    };
  if ((owner && !owner.historyRead) || startingSessions.has(key))
    return { state: "starting" };
  return undefined;
}

/** Resolves once a starting owner has opened its session or gone. */
export function antigravityOwnerSettled(
  scope: string,
  id: string,
): Promise<void> {
  if (antigravityOwnerView(scope, id)?.state !== "starting")
    return Promise.resolve();
  const key = keyOf(scope, id);
  return new Promise<void>((resolve) => {
    const waiters = settleWaiters.get(key) ?? new Set<() => void>();
    settleWaiters.set(key, waiters);
    waiters.add(resolve);
  });
}

/**
 * The live projection of an open owner: its rows after its boundary; the
 * history through the boundary is in the log.
 */
export function antigravityLiveHistory(
  scope: string,
  id: string,
): SDKMessage[] | undefined {
  const view = antigravityOwnerView(scope, id);
  return view?.state === "open" ? view.history() : undefined;
}

export function antigravitySessionOwned(scope: string, id: string): boolean {
  return ownedNativeSessions.has(keyOf(scope, id));
}

/**
 * Whether no owner is starting for the conversation: the ACP replay
 * fallback may send `session/load` only then, checked right before it does.
 */
export function antigravityStartPending(scope: string, id: string): boolean {
  const owner = ownedNativeSessions.get(keyOf(scope, id));
  return (
    startingSessions.has(keyOf(scope, id)) ||
    (!!owner && !owner.historyRead && !owner.open)
  );
}

/** Whose write a change to a conversation's own files was (plan 195 step 7). */
export type AntigravityWriteSource =
  /** YA's own `agy`: starting, open and busy or just active, or a history
   * read's fallback load, or written before its owner let go. */
  | "own"
  /** Another writer, while YA's owner was quiet: its split candidates are
   * dropped. Ownership stays YA's while its process lives. */
  | "foreign-owned"
  /** No YA owner made it: another program wrote the conversation. */
  | "unowned";

/**
 * Attributes a write to a conversation's database, WAL or log, made at
 * `mtimeMs` (the file's modification time). Only YA's own owners are known
 * here, so a write is YA's while one of them could have made it.
 */
export function attributeAntigravityWrite(
  scope: string,
  id: string,
  mtimeMs: number,
  now = Date.now(),
): AntigravityWriteSource {
  const key = keyOf(scope, id);
  if (startingSessions.has(key)) return "own";
  const owner = ownedNativeSessions.get(key);
  if (owner) {
    const writer = owner.writer;
    if (owner.historyRead || !owner.open || !writer) return "own";
    if (
      writer.busy() ||
      mtimeMs <= writer.lastActivityMs() + OWN_WRITE_SETTLE_MS
    )
      return "own";
    owner.open.foreignWrite();
    return "foreign-owned";
  }
  forgetOldReleases(now);
  const released = releasedAt.get(key);
  return released !== undefined && mtimeMs <= released ? "own" : "unowned";
}

/**
 * Marks an owner as starting from the moment its provider iterator runs,
 * before it is registered or holds its lease, so no history read starts a
 * fallback `session/load` ahead of it. The returned release is idempotent.
 */
export function claimAntigravityStart(scope: string, id: string): () => void {
  const key = keyOf(scope, id);
  startingSessions.set(key, (startingSessions.get(key) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const count = (startingSessions.get(key) ?? 1) - 1;
    if (count > 0) startingSessions.set(key, count);
    else startingSessions.delete(key);
    settle(key);
  };
}

/**
 * Own a native session for a live run, first waiting out any history read:
 * opening a cold session reads it while the user may already be sending.
 * Another live owner still refuses.
 */
export async function ownAntigravitySessionAfterReads(
  scope: string,
  id: string,
  signal: AbortSignal,
) {
  for (;;) {
    const current = ownedNativeSessions.get(keyOf(scope, id));
    if (!current?.historyRead) return ownAntigravitySession(scope, id);
    await new Promise<void>((resolve, reject) => {
      const abort = () =>
        reject(new Error("Antigravity session start aborted"));
      if (signal.aborted) return abort();
      signal.addEventListener("abort", abort, { once: true });
      void current.released.then(() => {
        signal.removeEventListener("abort", abort);
        resolve();
      });
    });
  }
}
export function ownAntigravitySession(
  scope: string,
  id: string,
  options: { historyRead?: boolean } = {},
) {
  const key = keyOf(scope, id);
  if (ownedNativeSessions.has(key))
    throw new Error("Antigravity session already has a local owner");
  let release!: () => void;
  const owner: NativeSessionOwner = {
    historyRead: options.historyRead === true,
    released: new Promise<void>((resolve) => {
      release = resolve;
    }),
  };
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
      release();
      settle(key);
    },
    /** How to tell this owner's writes from another writer's. */
    attributeWrites(writer: AntigravityWriterState): void {
      owner.writer = writer;
    },
    /**
     * The session is open: readers now serve the log through `boundary`
     * and then this projection, or, without a boundary (a fallback resume),
     * this projection as the whole history.
     */
    open(
      boundary?: AntigravityLogBoundary,
      check?: AntigravitySplitCheck,
    ): AntigravityLiveProjection {
      owner.open = new AntigravityLiveProjection(
        boundary ? { ...boundary } : undefined,
        check,
      );
      settle(key);
      return owner.open;
    },
    /** Records a row in the open owner's projection. */
    record(message: SDKMessage): void {
      if (!owner.open) throw new Error("Antigravity owner is not open");
      owner.open.record(message);
    },
  };
}
