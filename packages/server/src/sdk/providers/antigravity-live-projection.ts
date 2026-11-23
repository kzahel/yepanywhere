import { retireReplayMessages } from "../../supervisor/retired-replay-messages.js";
import type { SDKMessage } from "../types.js";
import type { AntigravityLogBoundary } from "./antigravity-owners.js";

/**
 * A live Antigravity owner's in-memory rows: only what `agy`'s brain log
 * does not serve yet (plan 195 step 6). Readers join the log through
 * {@link boundary} with these rows. When the log is seen to hold a turn,
 * {@link advance} moves the boundary past it and drops its rows from what
 * readers serve. A client that streamed those rows holds their live IDs, so
 * the turn moved last stays as {@link moved}, to answer a catch-up from
 * before or inside it under the same IDs; a cursor on an older dropped row
 * resolves through a bounded alias to its log step. A hard cap on both
 * drops the moved copy first, then the oldest row, instead of failing; the
 * view is incomplete until an advance covers a dropped row.
 */

/** The most the rows may hold: one row larger than this is still kept. */
export const ANTIGRAVITY_LIVE_BYTES = 8 * 1024 * 1024;
export const ANTIGRAVITY_LIVE_ROWS = 10_000;
/** The boundary of a log that holds nothing yet. */
export const EMPTY_ANTIGRAVITY_LOG: AntigravityLogBoundary = {
  step: -1,
  end: 0,
};
/**
 * Recently dropped rows with a known log position, for client cursors:
 * about 64 turns of prompts and turn ends.
 */
const ALIASES = 128;
/** Recently dropped row IDs, whose late updates (within a turn or two) are ignored. */
const RETIRED = 256;
/** Prompts and commands awaiting their log records. */
const EXPECTATIONS = 256;

/** Where a dropped row's cursor reads the log: after a step, or before it. */
export interface AntigravityCursorAlias {
  /** `afterMessageId`: the log's messages of records after this step. */
  after: number;
  /** `beforeMessageId`: the log's page before this step's first message. */
  before?: number;
}

/**
 * Something YA sent that `agy` logs as a `USER_INPUT`: a prompt (the first
 * of a turn, or a steer) or `/compact`. Observed on 1.5.13 and 1.5.14: one
 * record each, in the order sent.
 */
export interface AntigravityExpectation {
  kind: "prompt" | "compact";
  text: string;
  /** The row sequence when it was sent: its own row's, for a prompt. */
  seq: number;
  /** The row a client may hold a cursor on: the prompt, or the compaction boundary. */
  rowId?: string;
  /** A turn's first prompt, before which every earlier row is final. */
  turnStart: boolean;
}

/** A move of the boundary, decided from the log after it. */
export interface AntigravityAdvancePlan {
  boundary: AntigravityLogBoundary;
  /** Rows sent before this sequence leave memory. */
  evictBefore: number;
  /** How many expectations the log has now accounted for. */
  consumed: number;
  aliases: Array<[string, AntigravityCursorAlias]>;
}

interface Row {
  message: SDKMessage;
  bytes: number;
  seq: number;
}

/** The turn the last advance moved to the log, as clients streamed it. */
export interface AntigravityMovedTurn {
  /** The boundary before that advance: the log through it precedes the turn. */
  before: AntigravityLogBoundary;
  /** Its rows under their live IDs; undefined once the cap dropped them. */
  rows?: SDKMessage[];
}

const sizeOf = (message: SDKMessage) =>
  Buffer.byteLength(JSON.stringify(message), "utf8");

function remember<K, V>(map: Map<K, V>, key: K, value: V, limit: number) {
  map.delete(key);
  map.set(key, value);
  while (map.size > limit) map.delete(map.keys().next().value as K);
}

export class AntigravityLiveProjection {
  private readonly rows = new Map<string, Row>();
  private bytes = 0;
  private nextSeq = 0;
  /** The highest sequence the cap dropped without the log serving it. */
  private droppedSeq = -1;
  private readonly aliases = new Map<string, AntigravityCursorAlias>();
  private readonly retired = new Map<string, true>();
  readonly expectations: AntigravityExpectation[] = [];
  /** Bumped by every advance and every drop: readers compare it across a read. */
  generation = 0;
  /** Bumped by every advance: a plan is applied only to the boundary it read. */
  boundaryVersion = 0;
  /** The boundary the owner opened at: nothing before it moved from memory. */
  readonly opened?: AntigravityLogBoundary;
  moved?: AntigravityMovedTurn;
  private movedBytes = 0;

  constructor(public boundary?: AntigravityLogBoundary) {
    this.opened = boundary ? { ...boundary } : undefined;
  }

  get size(): number {
    return this.rows.size;
  }
  /** The rows' JSON bytes and the moved turn's. */
  get retainedBytes(): number {
    return this.bytes + this.movedBytes;
  }
  /** The sequence the next new row will get. */
  get seq(): number {
    return this.nextSeq;
  }
  /** Whether the cap dropped rows the log does not serve yet. */
  get incomplete(): boolean {
    return this.droppedSeq >= 0;
  }

  seqOf(id: string): number | undefined {
    return this.rows.get(id)?.seq;
  }
  has(id: string): boolean {
    return this.rows.has(id);
  }
  alias(id: string): AntigravityCursorAlias | undefined {
    return this.aliases.get(id);
  }
  /** A copy of the rows, oldest first. */
  history(): SDKMessage[] {
    return structuredClone([...this.rows.values()].map((row) => row.message));
  }

  record(message: SDKMessage): void {
    const id = message.uuid;
    if (!id) throw new Error("Antigravity projection requires a message ID");
    // The log serves it now: a late update (an enriched result) adds nothing.
    if (this.retired.has(id)) return;
    const bytes = sizeOf(message);
    const previous = this.rows.get(id);
    this.bytes += bytes - (previous?.bytes ?? 0);
    this.rows.set(id, {
      message: structuredClone(message),
      bytes,
      seq: previous?.seq ?? this.nextSeq++,
    });
    this.trim(id);
  }

  /** Within the cap: the moved copy goes first, then the oldest rows. */
  private trim(keep?: string): void {
    const over = () =>
      this.bytes + this.movedBytes > ANTIGRAVITY_LIVE_BYTES ||
      this.rows.size + (this.moved?.rows?.length ?? 0) > ANTIGRAVITY_LIVE_ROWS;
    if (over() && this.moved?.rows) {
      this.moved = { before: this.moved.before };
      this.movedBytes = 0;
      this.generation++;
    }
    const id = keep;
    while (this.rows.size > 1 && over()) {
      const [oldest, row] = this.rows.entries().next().value as [string, Row];
      if (oldest === id) break;
      this.rows.delete(oldest);
      this.bytes -= row.bytes;
      this.droppedSeq = Math.max(this.droppedSeq, row.seq);
      remember(this.retired, oldest, true, RETIRED);
      this.generation++;
    }
  }

  expect(expectation: AntigravityExpectation): void {
    this.expectations.push(expectation);
    // Never matched (a desynchronised log): the cap bounds memory instead.
    if (this.expectations.length > EXPECTATIONS) this.expectations.shift();
  }

  /**
   * Applies a plan read from the log after the current boundary. Returns
   * false when the boundary moved meanwhile, or nothing would change.
   */
  advance(plan: AntigravityAdvancePlan, readAt: number): boolean {
    if (readAt !== this.boundaryVersion) return false;
    const evicted: string[] = [];
    for (const [id, row] of this.rows) {
      if (row.seq >= plan.evictBefore) break;
      evicted.push(id);
    }
    if (
      !evicted.length &&
      !plan.consumed &&
      plan.boundary.end === this.boundary?.end
    )
      return false;
    const rows: SDKMessage[] = [];
    let movedBytes = 0;
    for (const id of evicted) {
      const row = this.rows.get(id)!;
      this.bytes -= row.bytes;
      movedBytes += row.bytes;
      rows.push(row.message);
      this.rows.delete(id);
      remember(this.retired, id, true, RETIRED);
    }
    // Every advance replaces the moved turn: the log through `before` and
    // these rows are the conversation up to the new boundary.
    this.moved = this.boundary ? { before: this.boundary, rows } : undefined;
    this.movedBytes = this.moved ? movedBytes : 0;
    for (const [id, alias] of plan.aliases)
      remember(this.aliases, id, alias, ALIASES);
    // The newest dropped row is the anchor a streaming client last fetched
    // from: its catch-up continues after the new boundary.
    const last = evicted.at(-1);
    if (last && !plan.aliases.some(([id]) => id === last))
      remember(this.aliases, last, { after: plan.boundary.step }, ALIASES);
    retireReplayMessages(evicted);
    this.expectations.splice(0, plan.consumed);
    if (this.droppedSeq < plan.evictBefore) this.droppedSeq = -1;
    this.boundary = { ...plan.boundary };
    this.boundaryVersion++;
    this.generation++;
    this.trim();
    return true;
  }

  /** The moved turn's rows, a copy, if it still holds them. */
  movedRows(): SDKMessage[] | undefined {
    return this.moved?.rows ? structuredClone(this.moved.rows) : undefined;
  }
  /** The moved turn's index of a row, or -1. */
  movedIndex(id: string): number {
    return this.moved?.rows?.findIndex((message) => message.uuid === id) ?? -1;
  }
}
