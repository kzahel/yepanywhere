import { randomUUID } from "node:crypto";
import { scanAgentExcerpt } from "../../sessions/agent-excerpt.js";
import type { Message } from "../../supervisor/types.js";
import type { SDKMessage } from "../types.js";
import {
  AntigravityLiveProjection,
  type AntigravityDeliveryClock,
  type AntigravitySplitCheck,
} from "./antigravity-live-projection.js";
import type { HostedNativeOwnerLink, NativeOwnerHost } from "./types.js";

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
/**
 * How long a hosted owner this server expected but could not attach to is
 * still taken to hold its conversation: the Provider Host reaps a worker
 * no server attaches to within its replacement deadline (31 s).
 */
const UNATTACHED_HOLD_MS = 31_000;
/** Retired IDs a backend's copy remembers, as the owner's own ring does. */
const RETIRED_MEMORY = 10_000;

/**
 * A conversation held by a live owner, in this process (`local`) or in a
 * Provider Host worker (`hosted`, plan 195 step 9). An owner holds the
 * conversation from before its `agy` starts until that `agy` has exited.
 */
interface NativeSessionOwner {
  /** Set once a local owner's session is open. */
  open?: AntigravityLiveProjection;
  /** History before a local owner's resume point that cannot be shown. */
  earlier?: AntigravityHistoryGap;
  /** Set when the owner runs in a Provider Host worker. */
  hosted?: HostedOwner;
}

/**
 * This backend's copy of what a hosted owner publishes: that it holds the
 * conversation, and the IDs it retired. Its window, candidates and checks
 * stay in the worker; reads ask the worker for a view
 * ({@link takeAntigravityOwnerView}).
 */
interface HostedOwner {
  /** Asks the worker for its view; unset until a controller is attached. */
  read?: (query: AntigravityOwnerQuery) => Promise<unknown>;
  /**
   * The worker may hold rows this backend cannot read (it was attached to
   * another backend, or this one handed it on): until it attaches here, a
   * read is not complete. A worker this backend is launching has written
   * nothing past the log yet.
   */
  unread: boolean;
  /**
   * A worker no backend could attach to: still held, unread, until this
   * `Date.now()` time (the host reaps it by then), then released. Checked
   * when the entry is looked up; no timer.
   */
  heldUntil?: number;
  retired: Set<string>;
  /** Identity per worker-side owner, for a read's split check. */
  identity?: { token: string; object: object };
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

function recordRelease(key: string, at: number): void {
  forgetOldReleases(Date.now());
  releasedAt.delete(key);
  releasedAt.set(key, at);
}

const keyOf = (scope: string, id: string) => `${scope}\0${id}`;

/** The live owner of a conversation, releasing one held past its time. */
function heldOwner(key: string, now = Date.now()) {
  const owner = ownedNativeSessions.get(key);
  const until = owner?.hosted?.heldUntil;
  if (until === undefined || now < until) return owner;
  ownedNativeSessions.delete(key);
  recordRelease(key, until);
  return undefined;
}

/** What a reader may serve for a conversation an open owner holds. */
export interface AntigravityOwnerView {
  /** Identifies this owner across a read. */
  owner: object;
  /** Changes whenever the boundary moves or rows leave memory. */
  generation: number;
  boundary: AntigravityLogBoundary;
  /** History before the resume point that cannot be shown. */
  earlier?: AntigravityHistoryGap;
  /**
   * Whether the live projection holds this message ID. A view taken with
   * {@link takeAntigravityOwnerView} knows this for its query's anchor only.
   */
  has(messageId: string): boolean;
  /** Whether a row this owner recorded left memory (moved or evicted). */
  retired(messageId: string): boolean;
  /** Rows the cap evicted that the log does not serve yet. */
  incomplete: boolean;
  /** The boundary the owner opened at: log rows after it were once live. */
  opened: AntigravityLogBoundary;
  /** The first prompt, when the log cannot title the conversation. */
  firstPrompt?: string;
  /**
   * A copy of the live projection, taken when called; a view taken with
   * {@link takeAntigravityOwnerView} holds the rows its query asked for.
   */
  history(): SDKMessage[];
  /** The model of the newest assistant row the owner holds. */
  model?: string;
  /** The owner's newest agent prose, when the query asked for it. */
  excerpt?: string;
}

/**
 * What a read asks of an open owner: the view (boundary, generation and
 * what goes with them) and, with it, the rows that go with that boundary.
 * Rows and boundary are taken together, at one generation.
 */
export interface AntigravityOwnerQuery {
  /** An `afterMessageId` anchor: whether the owner holds it. */
  anchor?: string;
  /**
   * Rows to take with the view: every row, or the rows from the anchor on
   * (every row when the anchor is not held). None when omitted.
   */
  rows?: "all" | "from-anchor";
  /** The owner's newest agent prose (the hover excerpt). */
  excerpt?: boolean;
}

/** An open owner's answer to a query; cloneable, so it crosses to a backend. */
interface AntigravityOwnerAnswer {
  token: string;
  generation: number;
  boundary: AntigravityLogBoundary;
  opened: AntigravityLogBoundary;
  earlier?: AntigravityHistoryGap;
  incomplete: boolean;
  firstPrompt?: string;
  holds?: boolean;
  rows?: SDKMessage[];
  model?: string;
  excerpt?: string;
}

function lastModel(rows: readonly SDKMessage[]): string | undefined {
  for (let index = rows.length - 1; index >= 0; index--) {
    const model = rows[index]?.message?.model;
    if (rows[index]?.type === "assistant" && typeof model === "string")
      return model;
  }
  return undefined;
}

function answerQuery(
  token: string,
  live: AntigravityLiveProjection,
  earlier: AntigravityHistoryGap | undefined,
  query: AntigravityOwnerQuery,
): AntigravityOwnerAnswer {
  const held = query.rows || query.excerpt ? live.peek() : undefined;
  return {
    token,
    generation: live.generation,
    boundary: { ...live.boundary },
    opened: { ...live.opened },
    ...(earlier ? { earlier } : {}),
    incomplete: live.incomplete,
    ...(live.firstPrompt !== undefined
      ? { firstPrompt: live.firstPrompt }
      : {}),
    ...(query.anchor !== undefined ? { holds: live.has(query.anchor) } : {}),
    ...(query.rows
      ? {
          rows: live.history(
            query.rows === "from-anchor" ? query.anchor : undefined,
          ),
        }
      : {}),
    ...(held ? { model: lastModel(held) } : {}),
    ...(query.excerpt && held
      ? { excerpt: scanAgentExcerpt(held as Message[]).prose }
      : {}),
  };
}

function localView(
  owner: NativeSessionOwner,
  live: AntigravityLiveProjection,
): AntigravityOwnerView {
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
 * The reader's view of a conversation's open local owner. An owner that is
 * still starting has written nothing past the log, so a reader reads the
 * log as for a stopped conversation. Call `history()` before the next
 * await: it copies the projection as it is then. A hosted owner is read
 * with {@link takeAntigravityOwnerView}.
 */
export function antigravityOwnerView(
  scope: string,
  id: string,
): AntigravityOwnerView | undefined {
  const owner = ownedNativeSessions.get(keyOf(scope, id));
  const live = owner?.open;
  if (!owner || !live) return undefined;
  return localView(owner, live);
}

/**
 * A view of a conversation's owner for one read: `undefined` with no open
 * owner (none, or one still starting, which has written nothing past the
 * log); `"unavailable"` for a hosted owner this backend cannot read now (no
 * controller attached yet, or the worker did not answer), whose rows are
 * then not shown and whose log is not the complete conversation. The view
 * is taken at one moment, its rows with it: a hosted owner's in one answer
 * from its worker, a local owner's copied when the view is built, so the
 * boundary, generation, flags and rows are of one generation whenever the
 * caller reads them.
 */
export async function takeAntigravityOwnerView(
  scope: string,
  id: string,
  query: AntigravityOwnerQuery = {},
): Promise<AntigravityOwnerView | "unavailable" | undefined> {
  const owner = heldOwner(keyOf(scope, id));
  if (!owner) return undefined;
  const hosted = owner.hosted;
  if (!hosted) {
    const live = owner.open;
    if (!live) return undefined;
    const view = localView(owner, live);
    if (!query.rows && !query.excerpt) return view;
    // Taken now, with the generation and flags above: the caller reads them
    // after an await.
    const rows = query.rows
      ? live.history(query.rows === "from-anchor" ? query.anchor : undefined)
      : [];
    const held = live.peek();
    return {
      ...view,
      history: () => rows,
      model: lastModel(held),
      ...(query.excerpt
        ? { excerpt: scanAgentExcerpt(held as Message[]).prose }
        : {}),
    };
  }
  if (!hosted.read) return hosted.unread ? "unavailable" : undefined;
  let answer: unknown;
  try {
    answer = await hosted.read(query);
  } catch {
    return "unavailable";
  }
  if (ownedNativeSessions.get(keyOf(scope, id)) !== owner) return undefined;
  if (!answer || typeof answer !== "object" || !("token" in answer))
    return undefined;
  const open = answer as AntigravityOwnerAnswer;
  if (hosted.identity?.token !== open.token)
    hosted.identity = { token: open.token, object: {} };
  const rows = open.rows ?? [];
  return {
    owner: hosted.identity.object,
    generation: open.generation,
    boundary: open.boundary,
    ...(open.earlier ? { earlier: open.earlier } : {}),
    has: (messageId) => messageId === query.anchor && open.holds === true,
    retired: (messageId) => hosted.retired.has(messageId),
    incomplete: open.incomplete,
    opened: open.opened,
    ...(open.firstPrompt !== undefined
      ? { firstPrompt: open.firstPrompt }
      : {}),
    history: () => structuredClone(rows),
    ...(open.model !== undefined ? { model: open.model } : {}),
    ...(open.excerpt !== undefined ? { excerpt: open.excerpt } : {}),
  };
}

/**
 * The live projection of an open local owner: its rows after its
 * boundary; the history through the boundary is in the log.
 */
export function antigravityLiveHistory(
  scope: string,
  id: string,
): SDKMessage[] | undefined {
  return antigravityOwnerView(scope, id)?.history();
}

/** Whether a live owner, local or hosted, holds the conversation. */
export function antigravitySessionOwned(scope: string, id: string): boolean {
  return heldOwner(keyOf(scope, id)) !== undefined;
}

/**
 * Whether the conversation's live owner recorded this row and let it leave
 * its memory (moved or evicted): the log serves it, or will, under another
 * ID. A hosted owner's retired IDs are copied to this backend as it
 * publishes them.
 */
export function antigravityRowRetired(
  scope: string,
  id: string,
  messageId: string,
): boolean {
  const owner = heldOwner(keyOf(scope, id));
  if (owner?.hosted) return owner.hosted.retired.has(messageId);
  return owner?.open?.retired(messageId) ?? false;
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
 * (`AntigravitySplitSampler`), from the log alone. A hosted owner is
 * registered here from before its worker launches (or from this backend's
 * start, for a worker it reattaches) and released with the time its worker
 * published.
 */
export function antigravityWriteIsOwn(
  scope: string,
  id: string,
  mtimeMs: number,
  now = Date.now(),
): boolean {
  const key = keyOf(scope, id);
  if (heldOwner(key, now)) return true;
  forgetOldReleases(now);
  const released = releasedAt.get(key);
  return released !== undefined && mtimeMs <= released;
}

/**
 * What a worker-side owner publishes to its backend (plan 195 step 9). A
 * snapshot is sent on every attach; changes while attached.
 */
type NativeOwnerPublication =
  | {
      kind: "snapshot";
      scope: string;
      id: string;
      retired: string[];
      releasedAt?: number;
    }
  | { kind: "retired"; ids: string[] }
  | { kind: "released"; at: number };

/**
 * Owns a native session for a live run; another live owner refuses. With
 * `host` (a Provider Host worker), the owner also publishes its presence,
 * retirements and release to the attached backend and answers its reads.
 */
export function ownAntigravitySession(
  scope: string,
  id: string,
  host?: NativeOwnerHost,
) {
  const key = keyOf(scope, id);
  if (ownedNativeSessions.has(key))
    throw new Error("Antigravity session already has a local owner");
  const owner: NativeSessionOwner = {};
  ownedNativeSessions.set(key, owner);
  const token = randomUUID();
  let released: number | undefined;
  host?.serve({
    snapshot: (): NativeOwnerPublication => ({
      kind: "snapshot",
      scope,
      id,
      retired: owner.open?.retiredIds() ?? [],
      ...(released !== undefined ? { releasedAt: released } : {}),
    }),
    read: (query) =>
      owner.open
        ? answerQuery(
            token,
            owner.open,
            owner.earlier,
            (query ?? {}) as AntigravityOwnerQuery,
          )
        : null,
  });
  return {
    release: () => {
      if (ownedNativeSessions.get(key) !== owner) return;
      owner.open?.close();
      ownedNativeSessions.delete(key);
      const now = Date.now();
      recordRelease(key, now);
      released = now;
      host?.publish({ kind: "released", at: now });
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
      delivery?: AntigravityDeliveryClock,
    ): AntigravityLiveProjection {
      owner.earlier = earlier;
      owner.open = new AntigravityLiveProjection({ ...boundary }, check, {
        ...(delivery ? { delivery } : {}),
        ...(host
          ? {
              onRetired: (ids: string[]) =>
                host.publish({ kind: "retired", ids }),
            }
          : {}),
      });
      return owner.open;
    },
    /** Records a row in the open owner's projection. */
    record(message: SDKMessage): void {
      if (!owner.open) throw new Error("Antigravity owner is not open");
      owner.open.record(message);
    },
  };
}

/**
 * A backend's side of one hosted session's owner (plan 195 step 9). The
 * proxy for the worker reports what the worker publishes and when its
 * connection ends; the conversation stays held here meanwhile, and after a
 * reload handoff (`detached`) until this backend exits.
 */
export function hostedAntigravityOwnerLink(): HostedNativeOwnerLink {
  let key: string | undefined;
  let entry: NativeSessionOwner | undefined;
  const hold = (scope: string, id: string) => {
    const next = keyOf(scope, id);
    if (key === next && entry) return entry;
    const current = ownedNativeSessions.get(next);
    // A local owner holds it: never two writers' views.
    if (current && !current.hosted) return undefined;
    if (key && entry && ownedNativeSessions.get(key) === entry)
      ownedNativeSessions.delete(key);
    key = next;
    entry = current ?? { hosted: { retired: new Set(), unread: false } };
    delete entry.hosted?.heldUntil;
    ownedNativeSessions.set(next, entry);
    releasedAt.delete(next);
    return entry;
  };
  const release = (at: number) => {
    if (!key || !entry || ownedNativeSessions.get(key) !== entry) return;
    ownedNativeSessions.delete(key);
    recordRelease(key, at);
    entry = undefined;
  };
  return {
    expect(native, retained = false) {
      const held = native && hold(native.storageScope, native.id);
      if (held?.hosted && retained) held.hosted.unread = true;
    },
    update(
      publication,
      read: (query: AntigravityOwnerQuery) => Promise<unknown>,
    ) {
      const value = publication as NativeOwnerPublication | undefined;
      if (!value || typeof value !== "object") return undefined;
      if (value.kind === "snapshot") {
        if (typeof value.scope !== "string" || typeof value.id !== "string")
          return undefined;
        if (value.releasedAt !== undefined) {
          hold(value.scope, value.id);
          release(value.releasedAt);
          return undefined;
        }
        const held = hold(value.scope, value.id);
        if (!held?.hosted) return undefined;
        held.hosted.read = read;
        held.hosted.retired = new Set(
          Array.isArray(value.retired)
            ? value.retired.slice(-RETIRED_MEMORY)
            : [],
        );
        return { scope: value.scope, id: value.id };
      }
      const hosted = entry?.hosted;
      if (!hosted) return undefined;
      if (value.kind === "retired" && Array.isArray(value.ids)) {
        for (const id of value.ids) hosted.retired.add(String(id));
        for (const id of hosted.retired) {
          if (hosted.retired.size <= RETIRED_MEMORY) break;
          hosted.retired.delete(id);
        }
      } else if (value.kind === "released" && typeof value.at === "number")
        release(value.at);
      return undefined;
    },
    end(reason) {
      if (!entry?.hosted) return;
      entry.hosted.read = undefined;
      if (reason === "exited") release(Date.now());
      // Held, unread if it ran under another backend, until the host reaps
      // it; a worker never attached to anywhere wrote nothing past the log.
      else if (reason === "unattached")
        entry.hosted.heldUntil = Date.now() + UNATTACHED_HOLD_MS;
      else entry.hosted.unread = true;
    },
  };
}
