import { stat } from "node:fs/promises";
import type { AntigravityLogBoundary } from "../sdk/providers/antigravity-owners.js";
import type { AntigravityLogRecord } from "./antigravity-log-projection.js";
import {
  isOversized,
  type LogLine,
  LogSource,
  SourceChanged,
  UnknownLog,
} from "./antigravity-log-source.js";
import { openPhysicalBrainTranscript } from "./antigravity-subagent-links.js";
import {
  captureTranscriptFence,
  isTranscriptPrefix,
} from "./transcript-ingestion.js";

/**
 * What `agy`'s brain log holds after a live owner's boundary (plan 195 step
 * 6): one entry per complete record, with what an owner needs to decide
 * whether the log now holds its turn. Read only by the owner, from its own
 * boundary forward, so the cost is the records it would evict.
 */

/** Past this many bytes after a boundary, the owner does not look now. */
export const ANTIGRAVITY_LOG_TAIL_BYTES = 64 * 1024 * 1024;
const ATTEMPTS = 3;

export interface AntigravityLogTailRecord {
  step: number;
  type: AntigravityLogRecord["type"];
  /** The line's start, and the offset after its newline. */
  start: number;
  end: number;
  /** The line's first bytes, for a boundary set at it. */
  witness: string;
  /** A user input's request text. */
  text?: string;
  /** A planner response's call count; undefined when too large to read. */
  calls?: number;
}

export type AntigravityLogTail =
  | {
      status: "known";
      records: AntigravityLogTailRecord[];
      /** The file read; none when an empty boundary's log does not exist yet. */
      source?: { dev: number; ino: number };
    }
  | { status: "unknown"; reason: string };

async function scan(
  source: LogSource,
  boundary: AntigravityLogBoundary,
): Promise<AntigravityLogTailRecord[]> {
  const { step, start, end, witness } = boundary;
  if (end > source.size)
    throw new UnknownLog("the log is shorter than its boundary");
  if (end > 0) {
    const line =
      start !== undefined
        ? await source.lineAt(start, end, step, witness)
        : (await source.read(end - 1, 1))[0] === 10
          ? await source.lineBefore(end)
          : undefined;
    if (
      !line ||
      (start === undefined && (await source.head(line)).step !== step)
    )
      throw new UnknownLog("the log changed before its boundary");
    source.release(line);
  }
  const records: AntigravityLogTailRecord[] = [];
  let previous = step;
  for (let at = end; at < source.size; ) {
    if (at - end > ANTIGRAVITY_LOG_TAIL_BYTES)
      throw new UnknownLog(
        "the log after the boundary is too large to check now",
      );
    let line: LogLine;
    try {
      line = await source.lineFrom(at, source.size);
    } catch (error) {
      // An unterminated record being written is no record yet.
      if (error instanceof SourceChanged) break;
      throw error;
    }
    const head = await source.head(line);
    if (head.step <= previous)
      throw new UnknownLog(`step ${head.step} does not increase`);
    previous = head.step;
    const entry: AntigravityLogTailRecord = {
      step: head.step,
      type: head.type as AntigravityLogRecord["type"],
      start: line.start,
      end: line.end + 1,
      witness: await source.witness(line),
    };
    if (
      (head.type === "USER_INPUT" || head.type === "PLANNER_RESPONSE") &&
      !isOversized(line)
    ) {
      const record = await source.record(line);
      if (record.type === "USER_INPUT") entry.text = record.text;
      else if (record.type === "PLANNER_RESPONSE" && !record.opaque)
        entry.calls = record.calls.length;
    }
    source.release(line);
    records.push(entry);
    at = line.end + 1;
  }
  return records;
}

/**
 * The complete records after `boundary`, checked as a window checks it: the
 * same file (when pinned), the boundary's line at its offsets, steps that
 * increase, and an append-only source through the read. An empty boundary
 * whose log does not exist yet holds nothing.
 */
export async function readAntigravityLogTail(
  scope: string,
  conversationId: string,
  boundary: AntigravityLogBoundary,
): Promise<AntigravityLogTail> {
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    let close: (() => Promise<void>) | undefined;
    try {
      const opened = await openPhysicalBrainTranscript(
        scope,
        conversationId,
        "transcript_full.jsonl",
      );
      if (opened.status === "missing")
        return boundary.end === 0
          ? { status: "known", records: [] }
          : { status: "unknown", reason: "the log is missing" };
      if (opened.status === "changed") continue;
      if (opened.status === "invalid")
        return {
          status: "unknown",
          reason: "the log is not a regular file inside the store",
        };
      close = () => opened.handle.close().catch(() => {});
      if (
        boundary.ino !== undefined &&
        (boundary.dev !== opened.dev || boundary.ino !== opened.ino)
      )
        return { status: "unknown", reason: "the log was replaced" };
      const source = new LogSource(opened.handle, opened.size);
      const fence = await captureTranscriptFence(source.probe, opened.path, {
        dev: opened.dev,
        ino: opened.ino,
        size: opened.size,
      });
      let records: AntigravityLogTailRecord[];
      try {
        records = await scan(source, boundary);
      } catch (error) {
        if (!(error instanceof UnknownLog)) throw error;
        return { status: "unknown", reason: error.message };
      }
      if (
        await isTranscriptPrefix(
          source.probe,
          opened.path,
          fence,
          await stat(opened.path),
        )
      )
        return {
          status: "known",
          records,
          source: { dev: opened.dev, ino: opened.ino },
        };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (!(error instanceof SourceChanged) && code !== "ENOENT") throw error;
    } finally {
      await close?.();
    }
  }
  return {
    status: "unknown",
    reason: "the log was replaced or truncated during every read",
  };
}
