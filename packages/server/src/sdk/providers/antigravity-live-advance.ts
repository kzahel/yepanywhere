import {
  ANTIGRAVITY_LOG_HEAD_BYTES,
  ANTIGRAVITY_LOG_RECORD_BYTES,
  parseAntigravityLogHead,
} from "../../sessions/antigravity-log-projection.js";
import { LogSource } from "../../sessions/antigravity-log-source.js";
import {
  openPhysicalBrainTranscript,
  readAntigravityTranscriptPositionSync,
} from "../../sessions/antigravity-subagent-links.js";
import type {
  AntigravitySplitCandidate,
  AntigravitySplitCheck,
} from "./antigravity-live-projection.js";

/**
 * Where a live owner's window may move its boundary (plan 195 step 6),
 * proven with no scan of the log.
 *
 * A turn's first prompt P is sent only while the owner is idle (no turn
 * and no compaction in progress). Right before sending it, the owner takes
 * one synchronous stat of the log: its size Z and identity
 * ({@link antigravitySplitCandidate}). When the window is over its soft
 * budget and P is old enough, two bounded reads at fixed offsets decide
 * whether Z divides the conversation ({@link checkAntigravitySplit}):
 *
 * 1. the file still has that identity and is longer than Z, and the byte
 *    before Z is a newline (or Z is 0);
 * 2. the record ending at Z parses completely, as the window reads it, and
 *    ends a turn: a planner with no calls, or an `ERROR_MESSAGE` (an
 *    oversized or placeholder record is no boundary);
 * 3. the record starting at Z is a `USER_INPUT`.
 *
 * Then every row received before P was sent belongs to a record at or
 * before Z, or to a step the log never records, and every later row to a
 * record after Z. P follows the previous turn's result on the ordered ACP
 * stream, so that turn's output has all arrived. On `agy` 1.5.13 and
 * 1.5.14 every wake (a background command's, a detached subagent's report)
 * logs a non-terminal record (a task-end or inbox `SYSTEM_MESSAGE`, or a
 * tool result) before its first ACP output, so a wake in flight at
 * dispatch fails (2), and a wake or late record that lands between Z and
 * P's input fails (3). What this cannot see is output for a record at or
 * before Z that arrives after P was sent: `agy` sends no echo or other
 * marker for a prompt to order it by (topics/antigravity.md, "Live
 * memory").
 *
 * A failed check caches nothing: a truncated, replaced or unreadable log
 * proves no split, and a later candidate is checked afresh. A log not yet
 * past Z (P's input not written yet) leaves the candidate pending.
 */

/** The candidate for a turn's first prompt, taken right before it is sent. */
export function antigravitySplitCandidate(
  scope: string,
  conversationId: string,
  seq: number,
): AntigravitySplitCandidate | undefined {
  const at = performance.now();
  const position = readAntigravityTranscriptPositionSync(
    scope,
    conversationId,
    "transcript_full.jsonl",
  );
  return (
    position && {
      seq,
      size: position.byte,
      dev: position.dev,
      ino: position.ino,
      at,
    }
  );
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
      const next = parseAntigravityLogHead(
        (
          await source.read(
            z,
            Math.min(ANTIGRAVITY_LOG_HEAD_BYTES, opened.size - z),
          )
        ).toString("latin1"),
      );
      if (next?.type !== "USER_INPUT") return undefined;
      if (z === 0) return { step: -1, end: 0 };
      if ((await source.read(z - 1, 1))[0] !== 10) return undefined;
      const line = await source.lineBefore(z, ANTIGRAVITY_LOG_RECORD_BYTES);
      if (!line) return undefined;
      const record = await source.record(line);
      const terminal =
        (record.type === "PLANNER_RESPONSE" &&
          !record.opaque &&
          !record.calls.length) ||
        record.type === "ERROR_MESSAGE";
      if (
        !terminal ||
        record.oversized ||
        record.step < boundary.step ||
        next.step <= record.step
      )
        return undefined;
      return {
        step: record.step,
        start: line.start,
        end: z,
        witness: await source.witness(line),
        dev: opened.dev,
        ino: opened.ino,
      };
    } catch {
      // A changed, malformed or unreadable log proves nothing.
      return undefined;
    } finally {
      await opened.handle.close().catch(() => {});
    }
  };
}
