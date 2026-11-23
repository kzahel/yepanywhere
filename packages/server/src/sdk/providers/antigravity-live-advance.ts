import {
  type AntigravityLogTailRecord,
  readAntigravityLogTail,
} from "../../sessions/antigravity-log-tail.js";
import type {
  AntigravityAdvancePlan,
  AntigravityCursorAlias,
  AntigravityExpectation,
  AntigravityLiveProjection,
} from "./antigravity-live-projection.js";
import type { AntigravityLogBoundary } from "./antigravity-owners.js";

/**
 * When a live owner's rows leave memory (plan 195 step 6). Real `agy`
 * 1.5.13 and 1.5.14 wrote every record of a foreground turn, including a
 * steered, stopped, tool-heavy or compacting one, 0-8 ms before the
 * prompt's result, and logged one `USER_INPUT` per prompt, steer and
 * `/compact`, in the order sent
 * (topics/antigravity-native-storage.md#live-memory--plan-195-step-6).
 *
 * The evidence is the log itself, read after the boundary:
 *
 * - **At a quiet point** (a turn's or a command's result): every prompt
 *   sent since the boundary has its `USER_INPUT`, matched in order by text,
 *   and the log ends, after the last of them, with a record that ends a
 *   turn (a planner response without calls, or an error). The boundary
 *   moves to that record and every row sent before the quiet point leaves.
 * - **Otherwise, a later turn's first prompt**: once its `USER_INPUT` is
 *   in the log, every earlier step that will ever be logged is (steps only
 *   increase), so the boundary moves to the record before it and every row
 *   sent before that prompt leaves, including rows for steps the log never
 *   records (they leave the view as they would leave a cold one).
 *
 * Neither waits for a record that may never come, and neither can drop a
 * row the log does not hold yet. A log that is missing, replaced or
 * malformed never advances; the cap bounds memory then.
 */

const normalized = (text: string) => text.trim().replace(/\s+/g, " ");
const sameText = (sent: string, logged: string | undefined) =>
  logged !== undefined && normalized(sent) === normalized(logged);
const endsTurn = (record: AntigravityLogTailRecord) =>
  (record.type === "PLANNER_RESPONSE" && record.calls === 0) ||
  record.type === "ERROR_MESSAGE";

interface Match {
  expectation: number;
  record: number;
  /** A compaction's checkpoint after its command. */
  checkpoint?: number;
}

/** Expectations matched, in order, to the log's user inputs. */
function match(
  records: readonly AntigravityLogTailRecord[],
  expectations: readonly AntigravityExpectation[],
): Match[] | undefined {
  const matches: Match[] = [];
  let next = 0;
  for (const [index, record] of records.entries()) {
    if (record.type === "CHECKPOINT") {
      const last = matches.at(-1);
      if (
        last &&
        last.checkpoint === undefined &&
        expectations[last.expectation]!.kind === "compact"
      )
        last.checkpoint = record.step;
      continue;
    }
    if (record.type !== "USER_INPUT") continue;
    // A command `agy` refused may leave no record; a prompt always does.
    while (
      expectations[next]?.kind === "compact" &&
      !sameText(expectations[next]!.text, record.text)
    )
      next++;
    // A user input YA did not send (another program), or out of order.
    if (!sameText(expectations[next]?.text ?? "", record.text))
      return undefined;
    matches.push({ expectation: next++, record: index });
  }
  return matches;
}

function boundaryAt(
  record: AntigravityLogTailRecord,
  source: { dev: number; ino: number } | undefined,
): AntigravityLogBoundary {
  return {
    step: record.step,
    start: record.start,
    end: record.end,
    witness: record.witness,
    ...(source ? { dev: source.dev, ino: source.ino } : {}),
  };
}

function aliasesOf(
  matches: readonly Match[],
  expectations: readonly AntigravityExpectation[],
  records: readonly AntigravityLogTailRecord[],
): Array<[string, AntigravityCursorAlias]> {
  const aliases: Array<[string, AntigravityCursorAlias]> = [];
  for (const { expectation, record, checkpoint } of matches) {
    const { kind, rowId } = expectations[expectation]!;
    if (!rowId) continue;
    const step = kind === "compact" ? checkpoint : records[record]!.step;
    if (step !== undefined)
      aliases.push([rowId, { after: step, before: step }]);
  }
  return aliases;
}

/** The advance the log now proves, if any. */
export function planAntigravityAdvance(input: {
  boundary: AntigravityLogBoundary;
  records: readonly AntigravityLogTailRecord[];
  source?: { dev: number; ino: number };
  expectations: readonly AntigravityExpectation[];
  /** At a quiet point: rows sent before this sequence belong to ended work. */
  quietSeq?: number;
}): AntigravityAdvancePlan | undefined {
  const { records, expectations, source } = input;
  const matches = match(records, expectations);
  if (!matches) return undefined;
  const last = records.at(-1);
  const lastMatch = matches.at(-1);
  const quietSeq = input.quietSeq;
  if (
    quietSeq !== undefined &&
    last &&
    lastMatch &&
    lastMatch.record < records.length - 1 &&
    endsTurn(last) &&
    // Everything sent since the boundary belongs to the ended work, and the
    // log holds every prompt of it.
    expectations.every(
      (expectation, index) =>
        expectation.seq < quietSeq &&
        (expectation.kind === "compact" ||
          matches.some((found) => found.expectation === index)),
    )
  )
    return {
      boundary: boundaryAt(last, source),
      evictBefore: quietSeq,
      consumed: expectations.length,
      aliases: aliasesOf(matches, expectations, records),
    };
  // The newest turn whose first prompt the log holds.
  const turn = [...matches]
    .reverse()
    .find((found) => expectations[found.expectation]!.turnStart);
  if (!turn) return undefined;
  const before = records[turn.record - 1];
  return {
    boundary: before ? boundaryAt(before, source) : input.boundary,
    evictBefore: expectations[turn.expectation]!.seq,
    consumed: turn.expectation,
    aliases: aliasesOf(
      matches.filter((found) => found.expectation < turn.expectation),
      expectations,
      records,
    ),
  };
}

/**
 * Runs advances for one owner, one log read at a time: a trigger that
 * arrives during a read runs once it ends, with the newest quiet point.
 */
export class AntigravityLiveAdvancer {
  private running = false;
  private pending: { quietSeq?: number } | undefined;

  constructor(
    private readonly options: {
      scope: string;
      conversationId: string;
      projection: AntigravityLiveProjection;
      signal: AbortSignal;
      /** Tests: when a run settles. */
      onSettled?: () => void;
    },
  ) {}

  private get projection() {
    return this.options.projection;
  }

  /** A prompt or steer was sent, after its row was recorded. */
  prompt(rowId: string, text: string, turnStart: boolean): void {
    const seq = this.projection.seqOf(rowId);
    if (seq === undefined) return;
    this.projection.expect({ kind: "prompt", text, seq, rowId, turnStart });
  }

  /** `/compact` is about to be sent. */
  compact(text: string): void {
    this.projection.expect({
      kind: "compact",
      text,
      seq: this.projection.seq,
      turnStart: false,
    });
  }

  /** The verified compaction's boundary row, which a client may anchor on. */
  compacted(rowId: string): void {
    const expectation = [...this.projection.expectations]
      .reverse()
      .find((entry) => entry.kind === "compact");
    if (expectation && !expectation.rowId) expectation.rowId = rowId;
  }

  /** A turn has started streaming: its first prompt is logged by now. */
  progress(): void {
    this.request({});
  }

  /** A turn or command has ended; rows before `seq` belong to it or earlier. */
  quiet(seq: number): void {
    this.request({ quietSeq: seq });
  }

  private request(trigger: { quietSeq?: number }): void {
    if (!this.projection.boundary || this.options.signal.aborted) return;
    this.pending = {
      quietSeq: Math.max(trigger.quietSeq ?? -1, this.pending?.quietSeq ?? -1),
    };
    if (this.pending.quietSeq! < 0) delete this.pending.quietSeq;
    if (!this.running) void this.drain();
  }

  private async drain(): Promise<void> {
    this.running = true;
    try {
      while (this.pending && !this.options.signal.aborted) {
        const trigger = this.pending;
        this.pending = undefined;
        await this.run(trigger).catch(() => {});
      }
    } finally {
      this.running = false;
      this.options.onSettled?.();
    }
  }

  private async run(trigger: { quietSeq?: number }): Promise<void> {
    const { projection } = this;
    const boundary = projection.boundary;
    if (!boundary || !projection.expectations.length) return;
    const readAt = projection.boundaryVersion;
    const tail = await readAntigravityLogTail(
      this.options.scope,
      this.options.conversationId,
      boundary,
    );
    if (tail.status !== "known" || this.options.signal.aborted) return;
    const plan = planAntigravityAdvance({
      boundary,
      records: tail.records,
      source: tail.source,
      expectations: projection.expectations,
      quietSeq: trigger.quietSeq,
    });
    if (plan) projection.advance(plan, readAt);
  }
}
