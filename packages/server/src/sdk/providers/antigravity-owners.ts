import type { SDKMessage } from "../types.js";

/**
 * Where a resumed session's history divides between `agy`'s brain log and
 * its owner's memory: the log's last complete record when the owner
 * resumed (its step and the byte offset after its newline). Records through
 * it are served from the log; everything the owner produced since, from its
 * live projection, even once the log also records it. A boundary only
 * moves forward (plan 195 step 6 advances it as the log catches up).
 */
export interface AntigravityLogBoundary {
  step: number;
  end: number;
  /**
   * The log file's identity when the boundary was taken: a replaced file is
   * not the history it bounds. An in-place edit of earlier records that
   * keeps the boundary record's step and offset is not detected (plan 195
   * step 7 owns external writes).
   */
  dev?: number;
  ino?: number;
}

// One entry per live preview owner; removed when its iterator closes. The preview
// stays in-process so readers never replay a database held by another owner.
interface NativeSessionOwner {
  history?: Map<string, SDKMessage>;
  bytes: number;
  /** A bounded history read, which a live session may wait out. */
  historyRead: boolean;
  released: Promise<void>;
  /**
   * Set once the owner's session is open. Without a boundary its live
   * projection is the whole history (a new session, or one resumed through
   * the ACP replay fallback).
   */
  open?: { boundary?: AntigravityLogBoundary };
}
const ownedNativeSessions = new Map<string, NativeSessionOwner>();
/** Sessions whose owner has started but not yet taken its lease. */
const startingSessions = new Map<string, number>();
/** Readers waiting for a starting owner to open or go. */
const settleWaiters = new Map<string, Set<() => void>>();

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
      boundary?: AntigravityLogBoundary;
      /** Whether the live projection holds this message ID. */
      has(messageId: string): boolean;
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
  if (owner && !owner.historyRead && owner.open)
    return {
      state: "open",
      owner,
      boundary: owner.open.boundary,
      has: (messageId) => owner.history?.has(messageId) ?? false,
      history: () => structuredClone([...(owner.history?.values() ?? [])]),
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
 * The live projection of an open owner. For a resumed session it is only
 * what the owner produced; the history before its boundary is in the log.
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
    bytes: 0,
    historyRead: options.historyRead === true,
    released: new Promise<void>((resolve) => {
      release = resolve;
    }),
  };
  ownedNativeSessions.set(key, owner);
  return {
    release: () => {
      if (ownedNativeSessions.get(key) !== owner) return;
      ownedNativeSessions.delete(key);
      release();
      settle(key);
    },
    /**
     * The session is open: readers now serve the log through `boundary`
     * (when the session resumed from its log) and then this projection.
     */
    open(boundary?: AntigravityLogBoundary) {
      owner.open = boundary ? { boundary: { ...boundary } } : {};
      settle(key);
    },
    /** Retained bytes of the live projection, as JSON. */
    get retainedBytes() {
      return owner.bytes;
    },
    record(message: SDKMessage) {
      if (!message.uuid)
        throw new Error("Antigravity projection requires a message ID");
      owner.history ??= new Map();
      const previous = owner.history.get(message.uuid);
      const bytes =
        owner.bytes +
        Buffer.byteLength(JSON.stringify(message), "utf8") -
        (previous ? Buffer.byteLength(JSON.stringify(previous), "utf8") : 0);
      if (
        bytes > 8 * 1024 * 1024 ||
        (!previous && owner.history.size >= 10_000)
      )
        throw new Error(
          "Antigravity live history exceeds the experimental history limit",
        );
      owner.bytes = bytes;
      owner.history.set(message.uuid, structuredClone(message));
    },
  };
}
