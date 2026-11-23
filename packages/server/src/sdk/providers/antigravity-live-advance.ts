import { statSync } from "node:fs";
import {
  ANTIGRAVITY_LOG_HEAD_BYTES,
  ANTIGRAVITY_LOG_RECORD_BYTES,
  decodeAntigravityLogLine,
  parseAntigravityLogHead,
  parseAntigravityLogRecord,
} from "../../sessions/antigravity-log-projection.js";
import { LogSource } from "../../sessions/antigravity-log-source.js";
import {
  type AntigravityLogWindowRequest,
  antigravityMessageStep,
  readAntigravityLogWindow,
} from "../../sessions/antigravity-log-window.js";
import { openPhysicalBrainTranscript } from "../../sessions/antigravity-subagent-links.js";
import type {
  AntigravitySplitCandidate,
  AntigravitySplitCheck,
} from "./antigravity-live-projection.js";
import type { AntigravityLogBoundary } from "./antigravity-owners.js";

/**
 * Where a live owner's window may move its boundary (plan 195 step 6),
 * proven with no scan of the log.
 *
 * A turn's first prompt P is sent only while the owner is idle (no turn
 * and no compaction in progress). Right before sending it, the owner takes
 * one synchronous stat of the log, whose path it resolved earlier: its
 * size Z and identity ({@link AntigravitySplitSampler}). When the window is
 * over its soft budget and P is old enough, bounded reads decide whether Z
 * divides the conversation ({@link antigravitySplitCheck}):
 *
 * 1. the file still has that identity and is longer than Z, and the byte
 *    before Z is a newline (or Z is 0);
 * 2. the record ending at Z, read once and no longer than the window's
 *    record limit, parses completely, as the window reads it, and ends a
 *    turn: a planner with no calls, or an `ERROR_MESSAGE`;
 * 3. the record starting at Z is a `USER_INPUT`;
 * 4. the log from the current boundary to Z reads as known, page by page,
 *    as a reader would be served it after the move.
 *
 * Then every row received before P was sent belongs to a record at or
 * before Z, or to a step the log never records, and every later row to a
 * record after Z. P follows the previous turn's result on the ordered ACP
 * stream, so that turn's output has all arrived. On `agy` 1.5.13 and
 * 1.5.14 every wake (a background command's, a detached subagent's report)
 * logs a non-terminal record (a task-end or inbox `SYSTEM_MESSAGE`, or a
 * tool result) before its first ACP output, so a wake in flight at
 * dispatch fails (2), and a wake or late record that lands between Z and
 * P's input fails (3). (3) checks the record type, not that the input is
 * P's. What this cannot see is output for a record at or before Z that
 * arrives after P was sent: `agy` sends no echo or other marker for a
 * prompt to order it by (topics/antigravity.md, "Live memory").
 *
 * A failed check caches nothing: a truncated, replaced or unreadable log
 * proves no split, and a later candidate is checked afresh. A log not yet
 * past Z (P's input not written yet) leaves the candidate pending.
 */

/** The first and largest chunks read back from Z for the record ending there. */
const FIRST_CHUNK = 64 * 1024;
const MAX_CHUNK = 1024 * 1024;
/** Pages of the span read with no checkpoint cut. */
const ALL_COMPACTIONS = Number.MAX_SAFE_INTEGER;

/**
 * Takes a candidate as a turn's first prompt is sent. The log's physical
 * path is resolved once, asynchronously ({@link prepare}); until it is, a
 * prompt records no candidate. Sending then costs one `statSync` on the
 * server's event loop.
 */
export class AntigravitySplitSampler {
  private path?: string;
  private resolving = false;

  constructor(
    private readonly scope: string,
    private readonly conversationId: string,
  ) {}

  /** Resolves the log's path, if not done or under way. Never throws. */
  prepare(): void {
    if (this.path || this.resolving) return;
    this.resolving = true;
    void openPhysicalBrainTranscript(
      this.scope,
      this.conversationId,
      "transcript_full.jsonl",
    )
      .then(async (opened) => {
        if (opened.status !== "ok") return;
        this.path = opened.path;
        await opened.handle.close().catch(() => {});
      })
      .finally(() => {
        this.resolving = false;
      });
  }

  /** The candidate for the prompt whose row has sequence `seq`. */
  sample(seq: number): AntigravitySplitCandidate | undefined {
    if (!this.path) {
      this.prepare();
      return undefined;
    }
    try {
      const info = statSync(this.path);
      // Dated after the stat returns, so a slow stat eats no margin.
      const at = performance.now();
      return info.isFile()
        ? { seq, size: info.size, dev: info.dev, ino: info.ino, at }
        : undefined;
    } catch {
      return undefined;
    }
  }
}

/**
 * Whether the pages a reader would be served for the log after `from`,
 * through `to`, are all known: read back from `to` a page at a time, as
 * "Load older" reads them, stopping at the first unknown page.
 */
async function spanKnown(
  scope: string,
  conversationId: string,
  from: AntigravityLogBoundary,
  to: AntigravityLogBoundary,
): Promise<boolean> {
  let request: AntigravityLogWindowRequest = {
    kind: "latest",
    compactions: ALL_COMPACTIONS,
  };
  let previous = Number.POSITIVE_INFINITY;
  for (;;) {
    const page = await readAntigravityLogWindow({
      scope,
      conversationId,
      ownerLive: true,
      request,
      boundary: to,
    });
    if (page.status !== "known") return false;
    if (!page.omittedPrefix) return true;
    const first = page.messages[0];
    const step =
      first && antigravityMessageStep(conversationId, String(first.uuid));
    if (step === undefined || step >= previous) return false;
    if (step <= from.step + 1) return true;
    previous = step;
    request = {
      kind: "before",
      messageId: String(first!.uuid),
      compactions: ALL_COMPACTIONS,
    };
  }
}

/** Checks candidates against one conversation's log. */
export function antigravitySplitCheck(
  scope: string,
  conversationId: string,
): AntigravitySplitCheck {
  return async (candidate, boundary) => {
    const opened = await openPhysicalBrainTranscript(
      scope,
      conversationId,
      "transcript_full.jsonl",
    );
    if (opened.status === "missing" && candidate.size === 0) return "pending";
    if (opened.status !== "ok") return undefined;
    let next: AntigravityLogBoundary;
    try {
      const z = candidate.size;
      const same = (pin: { dev?: number; ino?: number }) =>
        pin.ino === undefined ||
        (pin.dev === opened.dev && pin.ino === opened.ino);
      if (!same(candidate) || !same(boundary)) return undefined;
      if (z < boundary.end || opened.size < z) return undefined;
      // The prompt's input is not logged yet: checked again later.
      if (opened.size === z) return "pending";
      const source = new LogSource(opened.handle, opened.size);
      const head = parseAntigravityLogHead(
        (
          await source.read(
            z,
            Math.min(ANTIGRAVITY_LOG_HEAD_BYTES, opened.size - z),
          )
        ).toString("latin1"),
      );
      if (head?.type !== "USER_INPUT") return undefined;
      if (z === 0) return { step: -1, end: 0 };
      // The record ending at Z, each byte read once: chunks back from Z,
      // kept, until the newline before it (or the file's start).
      const pieces: Buffer[] = [];
      let from = z;
      let start: number | undefined;
      for (let chunk = FIRST_CHUNK; start === undefined; ) {
        if (z - from > ANTIGRAVITY_LOG_RECORD_BYTES) return undefined;
        const length = Math.min(chunk, from);
        const piece = await source.read(from - length, length);
        if (!pieces.length && piece[length - 1] !== 10) return undefined;
        pieces.unshift(piece);
        from -= length;
        const newline = piece.lastIndexOf(
          10,
          length - 1 - (pieces.length === 1 ? 1 : 0),
        );
        if (newline >= 0) start = from + newline + 1;
        else if (from === 0) start = 0;
        chunk = Math.min(chunk * 2, MAX_CHUNK);
      }
      const bytes = Buffer.concat(pieces).subarray(start - from, z - from - 1);
      const decoded = decodeAntigravityLogLine(bytes);
      if (decoded.invalidUtf8 || !decoded.text) return undefined;
      const record = parseAntigravityLogRecord(decoded.text);
      const terminal =
        "type" in record &&
        ((record.type === "PLANNER_RESPONSE" && !record.calls.length) ||
          record.type === "ERROR_MESSAGE");
      if (!terminal || record.step < boundary.step || head.step <= record.step)
        return undefined;
      next = {
        step: record.step,
        start,
        end: z,
        witness: await source.witness({ start, end: z - 1, body: bytes }),
        dev: opened.dev,
        ino: opened.ino,
      };
    } catch {
      // A changed, malformed or unreadable log proves nothing.
      return undefined;
    } finally {
      await opened.handle.close().catch(() => {});
    }
    // Rows leave memory only for a span a reader can show.
    try {
      return (await spanKnown(scope, conversationId, boundary, next))
        ? next
        : undefined;
    } catch {
      return undefined;
    }
  };
}
