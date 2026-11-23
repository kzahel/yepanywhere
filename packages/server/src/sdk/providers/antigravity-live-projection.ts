import { PROCESS_REPLAY_RETENTION_MS } from "../../supervisor/replay-window.js";
import type { SDKMessage } from "../types.js";
import type { AntigravityLogBoundary } from "./antigravity-owners.js";

/**
 * A live Antigravity owner's in-memory rows (plan 195 step 6): a bounded
 * recent window. Readers join `agy`'s brain log through {@link boundary}
 * with these rows, as in step 5. While the rows stay under a soft budget
 * nothing moves. Over it, the boundary moves to the newest split candidate
 * (a turn's first prompt; see `antigravity-live-advance.ts`) that is old
 * enough for Process's replay buffer to have let go of every row before it
 * and that the log then proves, and those rows leave memory: a move is a
 * replacement event for connected clients. A hard cap evicts the oldest row
 * instead of failing, and the view is then incomplete until a move covers
 * what it evicted.
 */

const MiB = 1024 * 1024;
const limits = {
  /** Nothing moves below these. */
  softBytes: 2 * MiB,
  softRows: 2_000,
  /**
   * The most the rows may hold. One row is stored cut to this size (the
   * stream and the log keep it whole), and this many retired IDs are
   * remembered.
   */
  capBytes: 8 * MiB,
  capRows: 10_000,
  /**
   * How long after its prompt was sent a candidate may be used: Process's
   * replay buckets rotate on a timer, so every row before it has left them
   * by then unless the event loop stalled that long.
   */
  splitAgeMs: PROCESS_REPLAY_RETENTION_MS + 5_000,
};
const DEFAULT_LIMITS = { ...limits };

/** Tests only: lower the limits to reach moves quickly; restore with no argument. */
export function setAntigravityLiveLimitsForTests(
  override?: Partial<typeof limits>,
): void {
  Object.assign(limits, DEFAULT_LIMITS, override ?? {});
}

/** How much of the first prompt is kept for the title. */
const FIRST_PROMPT_CHARS = 4096;
/** Split candidates kept, thinned by time. */
const CANDIDATES = 8;

/** The boundary of a log that holds nothing yet. */
export const EMPTY_ANTIGRAVITY_LOG: AntigravityLogBoundary = {
  step: -1,
  end: 0,
};

/** A turn's first prompt, and the log as it stood when it was sent. */
export interface AntigravitySplitCandidate {
  /** The prompt row's sequence: rows before it arrived before it was sent. */
  seq: number;
  /** The log's size and identity then (size 0 and no identity: no log). */
  size: number;
  dev?: number;
  ino?: number;
  /** When it was sent, on the monotonic clock. */
  at: number;
}

/**
 * The boundary a candidate proves under the current one; none when it
 * fails; "pending" when the log has nothing after its size yet.
 */
export type AntigravitySplitCheck = (
  candidate: AntigravitySplitCandidate,
  boundary: AntigravityLogBoundary,
) => Promise<AntigravityLogBoundary | "pending" | undefined>;

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

/**
 * A copy of a row no larger than `cap` serialized bytes: its longest
 * strings are cut, each ending in a notice. The full text stays in the
 * stream and the log, which replaces it at the next move or once the owner
 * stops.
 */
function storedCopy(message: SDKMessage, bytes: number, cap: number) {
  const copy = structuredClone(message);
  for (let excess = bytes - cap; excess > 0; excess = sizeOf(copy) - cap) {
    let longest: { holder: Record<string, unknown>; key: string } | undefined;
    let length = 0;
    const visit = (value: unknown) => {
      if (!value || typeof value !== "object") return;
      const holder = value as Record<string, unknown>;
      for (const key of Object.keys(holder)) {
        const field = holder[key];
        if (typeof field === "string" && field.length > length) {
          longest = { holder, key };
          length = field.length;
        } else visit(field);
      }
    };
    visit(copy);
    if (!longest || length < 2) break;
    const notice = `\n\n[${excess} more bytes are in the log; this live view keeps the first part]`;
    // Each character cut removes at least one serialized byte.
    const keep = Math.max(0, length - excess - notice.length * 3);
    longest.holder[longest.key] =
      `${(longest.holder[longest.key] as string).slice(0, keep)}${notice}`;
  }
  return copy;
}

export class AntigravityLiveProjection {
  private readonly rows = new Map<string, Row>();
  private bytes = 0;
  private nextSeq = 0;
  /** The highest sequence the cap evicted without the log serving it. */
  private droppedSeq = -1;
  /** IDs of rows that left memory (moved or evicted), oldest first. */
  private readonly retiredIds = new Set<string>();
  private candidates: AntigravitySplitCandidate[] = [];
  private checking = false;
  /** A pending check waits for the next new row before checking again. */
  private pendingAt = -1;
  private closed = false;
  /** The conversation's first prompt, when this owner recorded it (bounded). */
  firstPrompt?: string;
  /** Bumped by every move and every eviction: readers compare it across a read. */
  generation = 0;
  /** The boundary the owner opened at: log rows after it were once live. */
  readonly opened?: AntigravityLogBoundary;

  constructor(
    public boundary?: AntigravityLogBoundary,
    private readonly check?: AntigravitySplitCheck,
    private readonly now: () => number = () => performance.now(),
  ) {
    this.opened = boundary ? { ...boundary } : undefined;
  }

  /** Whether the cap evicted rows the log does not serve yet. */
  get incomplete(): boolean {
    return this.droppedSeq >= 0;
  }
  /** The sequence the next new row will get. */
  get seq(): number {
    return this.nextSeq;
  }

  has(id: string): boolean {
    return this.rows.has(id);
  }
  /**
   * Whether a row left memory, by a move or the cap. The last
   * `capRows` retired IDs are remembered.
   */
  retired(id: string): boolean {
    return this.retiredIds.has(id);
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
    const full = sizeOf(message);
    const stored = storedCopy(message, full, limits.capBytes);
    const bytes = full > limits.capBytes ? sizeOf(stored) : full;
    const previous = this.rows.get(id);
    this.bytes += bytes - (previous?.bytes ?? 0);
    this.rows.set(id, {
      message: stored,
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
    this.trim(id);
    this.moveIfOver();
  }

  /**
   * A candidate taken as a turn's first prompt was sent. The oldest is
   * always kept, so one old enough survives any burst of prompts; the
   * others are thinned where they lie closest together.
   */
  addCandidate(candidate: AntigravitySplitCandidate): void {
    if (this.closed || !this.check || !this.boundary) return;
    const last = this.candidates.at(-1);
    if (last && last.seq >= candidate.seq) return;
    this.candidates.push(candidate);
    while (this.candidates.length > CANDIDATES) {
      let drop = 1;
      for (let i = 2; i < this.candidates.length - 1; i++)
        if (
          this.candidates[i + 1]!.at - this.candidates[i - 1]!.at <
          this.candidates[drop + 1]!.at - this.candidates[drop - 1]!.at
        )
          drop = i;
      this.candidates.splice(drop, 1);
    }
    this.moveIfOver();
  }

  /** No check or move from now on. */
  close(): void {
    this.closed = true;
    this.candidates = [];
  }

  /**
   * Over the soft budget, checks the newest candidate old enough for
   * Process's replay buffer to have let go of every row before it; a
   * proven one moves the boundary, a failed one is discarded and the next
   * older one is tried.
   */
  private moveIfOver(): void {
    if (this.checking || this.closed || !this.check || !this.boundary) return;
    if (this.bytes <= limits.softBytes && this.rows.size <= limits.softRows)
      return;
    if (this.pendingAt === this.nextSeq) return;
    const ready = this.now() - limits.splitAgeMs;
    let candidate: AntigravitySplitCandidate | undefined;
    for (const entry of this.candidates)
      if (entry.at <= ready) candidate = entry;
    if (!candidate) return;
    this.checking = true;
    void this.check(candidate, this.boundary)
      .catch(() => undefined)
      .then((boundary) => {
        this.checking = false;
        if (this.closed) return;
        if (boundary === "pending") this.pendingAt = this.nextSeq;
        else if (boundary) this.move(candidate, boundary);
        else this.candidates = this.candidates.filter((c) => c !== candidate);
        this.moveIfOver();
      });
  }

  /** Rows before the candidate leave memory, even if the cap took them all. */
  private move(
    candidate: AntigravitySplitCandidate,
    boundary: AntigravityLogBoundary,
  ): void {
    for (const [id, row] of this.rows) {
      if (row.seq >= candidate.seq) break;
      this.bytes -= row.bytes;
      this.rows.delete(id);
      this.retire(id);
    }
    this.candidates = this.candidates.filter((c) => c.seq > candidate.seq);
    if (this.droppedSeq < candidate.seq) this.droppedSeq = -1;
    this.boundary = { ...boundary };
    this.generation++;
  }

  private retire(id: string): void {
    this.retiredIds.add(id);
    if (this.retiredIds.size > limits.capRows)
      this.retiredIds.delete(this.retiredIds.values().next().value!);
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
      this.retire(victim);
      this.generation++;
    }
  }
}
