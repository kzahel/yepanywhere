import { PROCESS_REPLAY_RETENTION_MS } from "../../supervisor/replay-window.js";
import type { ContextUsage } from "../../supervisor/types.js";
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
  /**
   * Hosted: when the backend had applied every row before it, on the
   * monotonic clock; undefined until then ({@link AntigravityDeliveryClock}).
   */
  delivered?: () => number | undefined;
}

/**
 * Where the rows' consumer is another process (a Provider Host worker's
 * backend, plan 195 step 9): marks what has been yielded so far, and tells
 * when the consumer had applied all of it (Process put it in its replay
 * buffer and acknowledged it), on this process's monotonic clock, or
 * undefined until it has. An owner in the backend's own process needs no
 * clock: Process applies each row before the provider resumes.
 */
export type AntigravityDeliveryClock = () => () => number | undefined;

/**
 * The boundary a candidate proves under the current one; none when it
 * fails; "pending" when the log has nothing after its size yet.
 */
export type AntigravitySplitCheck = (
  candidate: AntigravitySplitCandidate,
  boundary: AntigravityLogBoundary,
  /** False once the owner closed: no further log read starts. */
  alive: () => boolean,
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
 * What a cut live row, or a live block that stopped growing, ends in. The
 * log holds what `agy` recorded, which may itself be cut.
 */
export const ANTIGRAVITY_LIVE_CUT_NOTICE =
  "\n\n[The live view keeps only the beginning of this message; the session's log shows what agy recorded once the message moves there or the session ends.]";

type Block = Record<string, unknown>;

/**
 * A copy of a row of `bytes` serialized bytes, no larger than `cap` where
 * possible, and whether it was cut. In stages, each serialized once: cut
 * the longest text field once; then put an omission in place of every
 * structured tool body; then keep only each block's type, IDs and name.
 * The row's own fields and role stay.
 */
function storedCopy(
  message: SDKMessage,
  bytes: number,
  cap: number,
): { message: SDKMessage; bytes: number; cut: boolean } {
  if (bytes <= cap)
    return { message: structuredClone(message), bytes, cut: false };
  const body: Block = { ...(message.message ?? {}) };
  const blocks = Array.isArray(body.content)
    ? (body.content as Block[]).map((block) => ({ ...block }))
    : undefined;
  if (blocks) body.content = blocks;
  const assemble = () => ({ ...message, message: body }) as SDKMessage;
  const texts: Array<[Block, string]> = [];
  if (typeof body.content === "string") texts.push([body, "content"]);
  for (const block of blocks ?? [])
    for (const key of ["text", "thinking", "content"])
      if (typeof block[key] === "string") texts.push([block, key]);
  const fits = () => {
    const copy = assemble();
    const size = sizeOf(copy);
    return size <= cap ? { copy, size } : undefined;
  };
  const done = (copy: SDKMessage, size: number) => ({
    message: structuredClone(copy),
    bytes: size,
    cut: true,
  });
  // A character cut removes at least one serialized byte.
  const excess = bytes - cap + ANTIGRAVITY_LIVE_CUT_NOTICE.length * 3;
  let longest: [Block, string] | undefined;
  for (const field of texts)
    if (
      !longest ||
      (field[0][field[1]] as string).length >
        (longest[0][longest[1]] as string).length
    )
      longest = field;
  if (longest && (longest[0][longest[1]] as string).length > excess) {
    const text = longest[0][longest[1]] as string;
    longest[0][longest[1]] =
      `${text.slice(0, text.length - excess)}${ANTIGRAVITY_LIVE_CUT_NOTICE}`;
    const fit = fits();
    if (fit) return done(fit.copy, fit.size);
  }
  for (const block of blocks ?? []) {
    if (block.type === "tool_use")
      block.input = { omitted: ANTIGRAVITY_LIVE_CUT_NOTICE };
    if (block.type === "tool_result" && typeof block.content !== "string")
      block.content = ANTIGRAVITY_LIVE_CUT_NOTICE;
  }
  const fit = fits();
  if (fit) return done(fit.copy, fit.size);
  // The skeleton: every block's identity, and the notice.
  body.content = blocks
    ? blocks.map((block) => {
        const kept: Block = { type: block.type };
        for (const key of ["id", "tool_use_id", "name"])
          if (typeof block[key] === "string") kept[key] = block[key];
        if (block.type === "text") kept.text = ANTIGRAVITY_LIVE_CUT_NOTICE;
        if (block.type === "thinking")
          kept.thinking = ANTIGRAVITY_LIVE_CUT_NOTICE;
        if (block.type === "tool_use") kept.input = {};
        if (block.type === "tool_result")
          kept.content = ANTIGRAVITY_LIVE_CUT_NOTICE;
        return kept;
      })
    : ANTIGRAVITY_LIVE_CUT_NOTICE;
  const skeleton: SDKMessage = {
    type: message.type,
    ...(message.uuid ? { uuid: message.uuid } : {}),
    ...(message.session_id ? { session_id: message.session_id } : {}),
    ...(message.timestamp ? { timestamp: message.timestamp } : {}),
    message: body as SDKMessage["message"],
  };
  return done(skeleton, sizeOf(skeleton));
}

/**
 * Set (never serialized) on a live block the transcript stopped at the
 * cap, so the window knows the row is cut whatever its text says.
 */
export const ANTIGRAVITY_LIVE_CUT: unique symbol = Symbol(
  "antigravity live cut",
);

export class AntigravityLiveProjection {
  private readonly rows = new Map<string, Row>();
  private bytes = 0;
  private nextSeq = 0;
  /** The highest sequence the cap evicted without the log serving it. */
  private droppedSeq = -1;
  /** Held rows stored cut: the view is not complete while one is held. */
  private readonly cut = new Set<string>();
  /** IDs of rows that left memory (moved or evicted), oldest first. */
  private readonly retiredIds_ = new Set<string>();
  private candidates: AntigravitySplitCandidate[] = [];
  private checking = false;
  /**
   * A pending candidate's sequence when its check started: it is checked
   * again only once a new row has arrived since.
   */
  private readonly pending = new WeakMap<AntigravitySplitCandidate, number>();
  private closed = false;
  /** Bumped when another writer touched the conversation. */
  private foreignWrites = 0;
  /** The conversation's first prompt, when this owner recorded it (bounded). */
  firstPrompt?: string;
  /** Bumped by every move and every eviction: readers compare it across a read. */
  generation = 0;
  /** The boundary the owner opened at: log rows after it were once live. */
  readonly opened: AntigravityLogBoundary;
  private contextUsage_?: ContextUsage;

  private readonly now: () => number;
  private readonly delivery?: AntigravityDeliveryClock;
  private readonly onRetired?: (ids: string[]) => void;
  private readonly onContextUsage?: (usage: ContextUsage) => void;

  constructor(
    public boundary: AntigravityLogBoundary,
    private readonly check?: AntigravitySplitCheck,
    options: {
      now?: () => number;
      /** The consumer is in another process: see {@link AntigravityDeliveryClock}. */
      delivery?: AntigravityDeliveryClock;
      /** IDs that left memory, in the order they left. */
      onRetired?: (ids: string[]) => void;
      /** Latest live context meter reading, published to the backend. */
      onContextUsage?: (usage: ContextUsage) => void;
    } = {},
  ) {
    this.opened = { ...boundary };
    this.now = options.now ?? (() => performance.now());
    this.delivery = options.delivery;
    this.onRetired = options.onRetired;
    this.onContextUsage = options.onContextUsage;
  }

  /** Latest live context meter reading observed by this owner. */
  get contextUsage(): ContextUsage | undefined {
    return this.contextUsage_ ? { ...this.contextUsage_ } : undefined;
  }

  recordContextUsage(usage: ContextUsage): void {
    this.contextUsage_ = { ...usage };
    this.onContextUsage?.({ ...usage });
  }

  /** Whether the cap evicted rows the log does not serve yet, or a held row is cut. */
  get incomplete(): boolean {
    return this.droppedSeq >= 0 || this.cut.size > 0;
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
    return this.retiredIds_.has(id);
  }
  /**
   * A copy of the rows, oldest first; from `from` on when this holds it.
   */
  history(from?: string): SDKMessage[] {
    const rows: SDKMessage[] = [];
    let taking = from === undefined || !this.rows.has(from);
    for (const [id, row] of this.rows) {
      taking ||= id === from;
      if (taking) rows.push(row.message);
    }
    return structuredClone(rows);
  }
  /** The rows themselves, oldest first, for a read-only scan now. */
  peek(): readonly SDKMessage[] {
    return [...this.rows.values()].map((row) => row.message);
  }
  /** The remembered retired IDs, oldest first. */
  retiredIds(): string[] {
    return [...this.retiredIds_];
  }

  record(message: SDKMessage): void {
    const id = message.uuid;
    if (!id) throw new Error("Antigravity projection requires a message ID");
    // An update for a row that left memory adds nothing back.
    if (this.retired(id)) return;
    const stored = storedCopy(message, sizeOf(message), limits.capBytes);
    const bytes = stored.bytes;
    const previous = this.rows.get(id);
    this.bytes += bytes - (previous?.bytes ?? 0);
    this.rows.set(id, {
      message: stored.message,
      bytes,
      seq: previous?.seq ?? this.nextSeq++,
    });
    if (
      stored.cut ||
      (message as { [ANTIGRAVITY_LIVE_CUT]?: boolean })[ANTIGRAVITY_LIVE_CUT]
    )
      this.cut.add(id);
    else this.cut.delete(id);
    // Without a log to take the title from (an empty log at open), the
    // first prompt this owner recorded stays the title even after the cap
    // evicts its row.
    if (this.firstPrompt === undefined && this.opened.end === 0) {
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
    if (this.closed || !this.check) return;
    const last = this.candidates.at(-1);
    if (last && last.seq >= candidate.seq) return;
    if (this.delivery && !candidate.delivered)
      candidate = { ...candidate, delivered: this.delivery() };
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

  /**
   * Another writer changed the conversation while this owner was quiet
   * (plan 195 step 7). The split proof assumes one writer, so every
   * candidate taken so far is dropped and a check under way moves nothing;
   * a later prompt gives a new one. The cap still bounds the rows.
   */
  foreignWrite(): void {
    this.foreignWrites++;
    this.candidates = [];
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
    if (this.checking || this.closed || !this.check) return;
    if (this.bytes <= limits.softBytes && this.rows.size <= limits.softRows)
      return;
    const ready = this.now() - limits.splitAgeMs;
    // The newest old enough, passing over those pending with no new row.
    // Its age runs from when Process had every row before it: at once in
    // this process; at the backend's acknowledgement for a hosted owner.
    let candidate: AntigravitySplitCandidate | undefined;
    for (const entry of this.candidates) {
      const at = entry.delivered ? entry.delivered() : entry.at;
      if (
        at !== undefined &&
        at <= ready &&
        this.pending.get(entry) !== this.nextSeq
      )
        candidate = entry;
    }
    if (!candidate) return;
    const started = this.nextSeq;
    const foreignWrites = this.foreignWrites;
    this.checking = true;
    void this.check(candidate, this.boundary, () => !this.closed)
      .catch(() => undefined)
      .then((boundary) => {
        this.checking = false;
        if (this.closed) return;
        if (foreignWrites !== this.foreignWrites) {
          // Dropped with the rest when the other writer was seen.
        } else if (boundary === "pending") this.pending.set(candidate, started);
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
    const retired: string[] = [];
    for (const [id, row] of this.rows) {
      if (row.seq >= candidate.seq) break;
      this.bytes -= row.bytes;
      this.rows.delete(id);
      this.retire(id);
      retired.push(id);
    }
    if (retired.length) this.onRetired?.(retired);
    this.candidates = this.candidates.filter((c) => c.seq > candidate.seq);
    if (this.droppedSeq < candidate.seq) this.droppedSeq = -1;
    this.boundary = { ...boundary };
    this.generation++;
  }

  private retire(id: string): void {
    this.cut.delete(id);
    this.retiredIds_.add(id);
    if (this.retiredIds_.size > limits.capRows)
      this.retiredIds_.delete(this.retiredIds_.values().next().value!);
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
      this.onRetired?.([victim]);
      this.generation++;
    }
  }
}
