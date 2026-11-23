import { createHash } from "node:crypto";
import {
  AntigravityLogTail,
  type AntigravityLogTailRecord,
} from "../../sessions/antigravity-log-tail.js";
import type { AntigravityLiveProjection } from "./antigravity-live-projection.js";
import type { AntigravityLogBoundary } from "./antigravity-owners.js";

/**
 * Finds the split points a live owner's projection may move its boundary
 * to (plan 195 step 6). A split point is a turn's first prompt P whose
 * `USER_INPUT` U is proven to separate the two sides:
 *
 * (a) a pass over the log reached its end E while the owner was idle (no
 *     turn or command in progress);
 * (b) no ACP update of any kind arrived between that pass's start and P's
 *     dispatch;
 * (c) a later pass finds U (P's text) as the first record after E.
 *
 * Then every row received before P's dispatch belongs to a record at or
 * before E, or to a step the log never records (its record would have to
 * land between E and U, which (c) rules out, since steps only increase).
 * Every later row belongs to U or after it, with one narrow exception the
 * log cannot rule out: a reply's last chunk can arrive a few milliseconds
 * after its record (step 2 saw 2 ms), so a chunk arriving after P whose
 * record E already held would stay live beside it; that needs the record,
 * the idle read reaching it and P's dispatch all inside those
 * milliseconds. A wake or detached task whose output overlaps a prompt
 * fails (c) (its records land between E and U), and (b) refuses any
 * prompt after activity at all, so that prompt is not a split point. Every `USER_INPUT` must match what YA sent, in order (each
 * prompt, steer and `/compact` leaves one, observed on 1.5.13 and 1.5.14,
 * topics/antigravity-native-storage.md#live-memory--plan-195-step-6);
 * one that does not (another writer), or a log that cannot be followed,
 * stops this owner's moves for good, and the cap alone bounds it.
 *
 * Passes run at each turn's and command's result, once passive activity
 * (a detached wake) has been quiet for {@link QUIET_MS} (on one owned timer
 * that teardown clears), and, while the projection is over its soft budget,
 * right before a turn's first prompt is sent, so a prompt queued behind a
 * turn can still be a split point.
 */

const QUIET_MS = 1_000;
/** Prompts awaiting their records; more means the log is not following. */
const EXPECTATIONS = 256;

const normalized = (text: string) => text.trim().replace(/\s+/g, " ");
const digest = (text: string) =>
  createHash("sha256").update(normalized(text)).digest("hex");

interface Expectation {
  kind: "prompt" | "compact";
  /** Bounded evidence of the text sent: its normalized form's hash and length. */
  hash: string;
  length: number;
  seq: number;
  dispatchedAt: number;
  /** For a turn's first prompt sent right after an idle pass: that pass's end. */
  candidate?: AntigravityLogBoundary;
}

export class AntigravityLiveAdvancer {
  private readonly tail: AntigravityLogTail;
  private readonly expectations: Expectation[] = [];
  /** The last idle pass that reached the end: its end and the updates seen at its start. */
  private settled?: { end: AntigravityLogBoundary; updates: number };
  private running?: Promise<void>;
  private again = false;
  private stopped?: string;
  private quiet?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly options: {
      scope: string;
      conversationId: string;
      projection: AntigravityLiveProjection;
      signal: AbortSignal;
      /** No turn or command in progress. */
      idle: () => boolean;
      /** ACP updates received so far. */
      updates: () => number;
      now?: () => number;
      quietMs?: number;
      /** Tests: after each pass. */
      onPass?: () => void;
    },
  ) {
    this.tail = new AntigravityLogTail(
      options.scope,
      options.conversationId,
      options.projection.boundary!,
    );
    options.signal.addEventListener("abort", () => this.close(), {
      once: true,
    });
  }

  /** Why this owner stopped looking for split points, if it did. */
  get stoppedReason(): string | undefined {
    return this.stopped;
  }

  private expect(expectation: Expectation): void {
    if (this.stopped) return;
    this.expectations.push(expectation);
    if (this.expectations.length > EXPECTATIONS)
      this.stop("the log is not recording what was sent");
  }

  /** A prompt or steer is being sent, after its row was recorded. */
  prompt(rowId: string, text: string, turnStart: boolean): void {
    const seq = this.options.projection.seqOf(rowId);
    if (seq === undefined) return;
    const settled = this.settled;
    this.expect({
      kind: "prompt",
      hash: digest(text),
      length: normalized(text).length,
      seq,
      dispatchedAt: (this.options.now ?? Date.now)(),
      // (a) and (b): an idle pass reached the end, nothing arrived since it
      // started, and nothing has been read past that end.
      ...(turnStart &&
      settled &&
      settled.updates === this.options.updates() &&
      this.tail.position.end === settled.end.end
        ? { candidate: settled.end }
        : {}),
    });
  }

  /** `/compact` is about to be sent. */
  compact(text: string): void {
    this.expect({
      kind: "compact",
      hash: digest(text),
      length: normalized(text).length,
      seq: this.options.projection.seq,
      dispatchedAt: (this.options.now ?? Date.now)(),
    });
  }

  /** A turn or command has ended: look now. */
  ended(): void {
    this.request();
  }

  /**
   * Before a turn's first prompt is sent: when a move is wanted, finish one
   * pass first (bounded by the pass budget), so the prompt can be a split
   * point even right behind the previous turn.
   */
  async beforePrompt(): Promise<void> {
    if (!this.options.projection.overSoftBudget()) return;
    this.request();
    await this.running;
  }

  /** Passive output arrived: look once it has been quiet. */
  passive(): void {
    if (this.stopped || this.options.signal.aborted) return;
    if (this.quiet) clearTimeout(this.quiet);
    this.quiet = setTimeout(() => {
      this.quiet = undefined;
      if (this.options.idle()) this.request();
    }, this.options.quietMs ?? QUIET_MS);
  }

  close(): void {
    if (this.quiet) clearTimeout(this.quiet);
    this.quiet = undefined;
  }

  private stop(reason: string): void {
    this.stopped ??= reason;
    this.expectations.length = 0;
    this.close();
  }

  private request(): void {
    if (this.stopped || this.options.signal.aborted) return;
    this.again = true;
    this.running ??= this.drain();
  }

  private async drain(): Promise<void> {
    try {
      while (this.again && !this.stopped && !this.options.signal.aborted) {
        this.again = false;
        await this.pass().catch((error: unknown) =>
          this.stop(error instanceof Error ? error.message : String(error)),
        );
        this.options.onPass?.();
      }
    } finally {
      this.running = undefined;
    }
  }

  private async pass(): Promise<void> {
    const idle = this.options.idle();
    const updates = this.options.updates();
    const result = await this.tail.pass(this.options.signal);
    if (result.status === "stopped") return this.stop(result.reason);
    if (result.status === "again") return;
    for (const record of result.records) {
      if (record.type === "USER_INPUT" && !this.match(record)) return;
    }
    if (result.reachedEnd) {
      // (a): only a pass that started idle and saw nothing arrive meanwhile.
      this.settled =
        idle && this.options.idle() && updates === this.options.updates()
          ? { end: result.cursor, updates }
          : undefined;
    } else {
      // Paused by its budget: carry on once nothing else is happening.
      this.settled = undefined;
      this.passive();
    }
    this.options.projection.revisit();
  }

  /** Accounts one user input; false (and stopped) if YA did not send it. */
  private match(record: AntigravityLogTailRecord): boolean {
    if (record.text === undefined) {
      this.stop("a user input without readable text");
      return false;
    }
    const hash = digest(record.text);
    const length = normalized(record.text).length;
    const same = (expectation: Expectation | undefined) =>
      expectation?.hash === hash && expectation.length === length;
    // A command agy refused may leave no record; a prompt always does.
    while (
      this.expectations[0]?.kind === "compact" &&
      !same(this.expectations[0])
    )
      this.expectations.shift();
    const expectation = this.expectations.shift();
    if (!expectation || !same(expectation)) {
      this.stop("a user input YA did not send");
      return false;
    }
    // (c): the prompt's input is the first record after the idle pass's end.
    if (expectation.candidate && record.start === expectation.candidate.end)
      this.options.projection.addSplit({
        seq: expectation.seq,
        boundary: expectation.candidate,
        dispatchedAt: expectation.dispatchedAt,
      });
    return true;
  }
}
