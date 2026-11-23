import { PROCESS_REPLAY_RETENTION_MS } from "../../supervisor/replay-window.js";
import type { SDKMessage } from "../types.js";
import type { AntigravityLogBoundary } from "./antigravity-owners.js";

/**
 * A live Antigravity owner's in-memory rows (plan 195 step 6): a bounded
 * recent window. Readers join `agy`'s brain log through {@link boundary}
 * with these rows, as in step 5. While the rows stay under a soft budget
 * nothing moves, so no row a client streamed ever changes its ID. Over it,
 * the boundary moves to the newest proven split point (a turn's first
 * prompt; see `antigravity-live-advance.ts`) old enough that Process's
 * replay buffer no longer holds any row before it, and those rows leave
 * memory: a move is a replacement event for connected clients. A hard cap
 * evicts the oldest row instead of failing, and the view is then
 * incomplete until a move covers what it evicted.
 */

const MiB = 1024 * 1024;
const limits = {
  /** Nothing moves below these. */
  softBytes: 2 * MiB,
  softRows: 2_000,
  /** The most the rows may hold; one row larger than this is still kept. */
  capBytes: 8 * MiB,
  capRows: 10_000,
  /**
   * How long after its prompt was sent a split point may be used: every row
   * before it has left Process's replay buffer by then (with margin for the
   * provider-to-Process hop).
   */
  splitAgeMs: PROCESS_REPLAY_RETENTION_MS + 5_000,
};
const DEFAULT_LIMITS = { ...limits };

/** The current limits. */
export function antigravityLiveLimits(): Readonly<typeof limits> {
  return limits;
}

/** Tests only: lower the limits to reach moves quickly; restore with no argument. */
export function setAntigravityLiveLimitsForTests(
  override?: Partial<typeof limits>,
): void {
  Object.assign(limits, DEFAULT_LIMITS, override ?? {});
}

/** Cap-evicted IDs remembered so a late update does not recreate them. */
const DROPPED_IDS = 256;
/** How much of the first prompt is kept for the title. */
const FIRST_PROMPT_CHARS = 4096;
/** Proven split points kept, newest last. */
const SPLITS = 64;

/** The boundary of a log that holds nothing yet. */
export const EMPTY_ANTIGRAVITY_LOG: AntigravityLogBoundary = {
  step: -1,
  end: 0,
};

/**
 * A turn's first prompt whose `USER_INPUT` is proven to follow `boundary`
 * directly, with every row sent before it belonging to records at or before
 * `boundary` (or to steps the log never records).
 */
export interface AntigravitySplit {
  /** The prompt row's sequence: rows before it precede the split. */
  seq: number;
  boundary: AntigravityLogBoundary;
  /** When the prompt was sent. */
  dispatchedAt: number;
}

interface Row {
  message: SDKMessage;
  bytes: number;
  seq: number;
}

const sizeOf = (message: SDKMessage) =>
  Buffer.byteLength(JSON.stringify(message), "utf8");

function userText(message: SDKMessage): string | undefined {
  return message.type === "user" && typeof message.message?.content === "string"
    ? message.message.content
    : undefined;
}

export class AntigravityLiveProjection {
  private readonly rows = new Map<string, Row>();
  private bytes = 0;
  private nextSeq = 0;
  /** The highest sequence the cap evicted without the log serving it. */
  private droppedSeq = -1;
  /** IDs the last move evicted, and the latest IDs the cap evicted. */
  private moved = new Set<string>();
  private readonly dropped = new Set<string>();
  private splits: AntigravitySplit[] = [];
  /**
   * When the prompt the last move split at was sent: a row this owner no
   * longer holds that arrived no later had left by a move, since rows leave
   * in arrival order.
   */
  movedThrough?: number;
  /** The conversation's first prompt, when this owner recorded it (bounded). */
  firstPrompt?: string;
  /** Bumped by every move and every eviction: readers compare it across a read. */
  generation = 0;
  /** The boundary the owner opened at: log rows after it were once live. */
  readonly opened?: AntigravityLogBoundary;

  constructor(
    public boundary?: AntigravityLogBoundary,
    private readonly now: () => number = Date.now,
  ) {
    this.opened = boundary ? { ...boundary } : undefined;
  }

  get size(): number {
    return this.rows.size;
  }
  get retainedBytes(): number {
    return this.bytes;
  }
  /** The sequence the next new row will get. */
  get seq(): number {
    return this.nextSeq;
  }
  /** Whether the cap evicted rows the log does not serve yet. */
  get incomplete(): boolean {
    return this.droppedSeq >= 0;
  }

  seqOf(id: string): number | undefined {
    return this.rows.get(id)?.seq;
  }
  has(id: string): boolean {
    return this.rows.has(id);
  }
  /** Whether a row left memory (by the last move, or recently by the cap). */
  retired(id: string): boolean {
    return this.moved.has(id) || this.dropped.has(id);
  }
  /** A copy of the rows, oldest first. */
  history(): SDKMessage[] {
    return structuredClone([...this.rows.values()].map((row) => row.message));
  }

  record(message: SDKMessage): void {
    const id = message.uuid;
    if (!id) throw new Error("Antigravity projection requires a message ID");
    // An update for a row that left memory adds nothing back.
    if (this.retired(id)) return;
    const bytes = sizeOf(message);
    const previous = this.rows.get(id);
    this.bytes += bytes - (previous?.bytes ?? 0);
    this.rows.set(id, {
      message: structuredClone(message),
      bytes,
      seq: previous?.seq ?? this.nextSeq++,
    });
    // Without a log to take the title from (a new session's empty log, or a
    // fallback owner's whole history), the first prompt this owner recorded
    // stays the title even after the cap evicts its row.
    if (
      this.firstPrompt === undefined &&
      (!this.opened || this.opened.end === 0)
    ) {
      const text = userText(message);
      if (text !== undefined)
        this.firstPrompt = text.slice(0, FIRST_PROMPT_CHARS);
    }
    this.moveIfOver();
    this.trim(id);
  }

  /** A split point the log proved; a move may use it once it is old enough. */
  addSplit(split: AntigravitySplit): void {
    const last = this.splits.at(-1);
    if (last && last.seq >= split.seq) return;
    this.splits.push(split);
    if (this.splits.length > SPLITS) this.splits.shift();
    this.moveIfOver();
  }

  /** Checks the soft budget again, as time makes split points usable. */
  revisit(): void {
    this.moveIfOver();
  }

  /** Whether the rows are past the soft budget, where a move is wanted. */
  overSoftBudget(): boolean {
    return this.bytes > limits.softBytes || this.rows.size > limits.softRows;
  }

  /**
   * Over the soft budget, moves the boundary to the newest split point old
   * enough for Process's replay buffer to have let go of every row before
   * it, and evicts those rows.
   */
  private moveIfOver(): void {
    if (!this.boundary || !this.overSoftBudget()) return;
    const oldest = this.rows.values().next().value?.seq ?? this.nextSeq;
    const ready = this.now() - limits.splitAgeMs;
    let chosen: AntigravitySplit | undefined;
    for (const split of this.splits)
      if (split.dispatchedAt <= ready && split.seq > oldest) chosen = split;
    if (!chosen) return;
    const evicted = new Set<string>();
    for (const [id, row] of this.rows) {
      if (row.seq >= chosen.seq) break;
      evicted.add(id);
      this.bytes -= row.bytes;
      this.rows.delete(id);
    }
    this.moved = evicted;
    this.movedThrough = chosen.dispatchedAt;
    const at = chosen.seq;
    this.splits = this.splits.filter((split) => split.seq > at);
    if (this.droppedSeq < at) this.droppedSeq = -1;
    this.boundary = { ...chosen.boundary };
    this.generation++;
  }

  /** Within the cap: the oldest rows go, never the row just recorded. */
  private trim(keep: string): void {
    const over = () =>
      this.bytes > limits.capBytes || this.rows.size > limits.capRows;
    while (this.rows.size > 1 && over()) {
      let victim: string | undefined;
      for (const id of this.rows.keys())
        if (id !== keep) {
          victim = id;
          break;
        }
      if (victim === undefined) return;
      const row = this.rows.get(victim)!;
      this.rows.delete(victim);
      this.bytes -= row.bytes;
      this.droppedSeq = Math.max(this.droppedSeq, row.seq);
      this.dropped.add(victim);
      if (this.dropped.size > DROPPED_IDS)
        this.dropped.delete(this.dropped.values().next().value!);
      this.generation++;
    }
  }
}
