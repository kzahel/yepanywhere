import { stat } from "node:fs/promises";
import type { AntigravityLogBoundary } from "../sdk/providers/antigravity-owners.js";
import {
  ANTIGRAVITY_LOG_RECORD_BYTES,
  type AntigravityLogRecord,
} from "./antigravity-log-projection.js";
import {
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
 * A live owner's incremental read of `agy`'s brain log after its boundary
 * (plan 195 step 6). It keeps a verified cursor (the last complete record
 * it read: offset, step, raw witness) and, between passes, how far it has
 * searched an unterminated or very long line, so each pass reads only new
 * bytes: record heads, and a user input's body. A pass reads at most
 * {@link ANTIGRAVITY_LOG_TAIL_PASS_BYTES} and then pauses; the next pass
 * resumes there. A file that is missing (after the owner's log existed),
 * replaced, truncated, changed at the cursor or malformed stops the reader
 * for good; one that changed during a pass is read again next time.
 */

export const ANTIGRAVITY_LOG_TAIL_PASS_BYTES = 8 * 1024 * 1024;
const CHUNK_BYTES = 1024 * 1024;

export interface AntigravityLogTailRecord {
  step: number;
  type: AntigravityLogRecord["type"];
  /** The line's start, and the offset after its newline. */
  start: number;
  end: number;
  /** A user input's request text. */
  text?: string;
}

export type AntigravityLogTailPass =
  | {
      status: "read";
      records: AntigravityLogTailRecord[];
      /** Whether the pass reached the log's last complete record. */
      reachedEnd: boolean;
      /** The last complete record read so far (the boundary, before any). */
      cursor: AntigravityLogBoundary;
      bytesRead: number;
    }
  /** Nothing new could be read now (changed during the pass, or aborted). */
  | { status: "again"; bytesRead: number }
  /** The log cannot be followed any further by this owner. */
  | { status: "stopped"; reason: string; bytesRead: number };

export class AntigravityLogTail {
  private cursor: AntigravityLogBoundary;
  /** A line found to start here, searched for its newline up to `searched`. */
  private pending?: { start: number; searched: number };
  /** The size at which the last pass reached the end. */
  private settledSize?: number;
  /** Every byte read, across passes. */
  bytesRead = 0;

  constructor(
    private readonly scope: string,
    private readonly conversationId: string,
    boundary: AntigravityLogBoundary,
  ) {
    this.cursor = { ...boundary };
  }

  /** The last complete record read (the boundary, before any). */
  get position(): AntigravityLogBoundary {
    return this.cursor;
  }

  async pass(
    signal: AbortSignal,
    budget = ANTIGRAVITY_LOG_TAIL_PASS_BYTES,
  ): Promise<AntigravityLogTailPass> {
    let bytesRead = 0;
    let close: (() => Promise<void>) | undefined;
    const done = <T extends AntigravityLogTailPass>(result: T): T => {
      this.bytesRead += result.bytesRead;
      return result;
    };
    try {
      const opened = await openPhysicalBrainTranscript(
        this.scope,
        this.conversationId,
        "transcript_full.jsonl",
      );
      if (opened.status === "missing")
        return done(
          this.cursor.end === 0
            ? {
                status: "read",
                records: [],
                reachedEnd: true,
                cursor: this.cursor,
                bytesRead,
              }
            : { status: "stopped", reason: "the log is missing", bytesRead },
        );
      if (opened.status === "changed")
        return done({ status: "again", bytesRead });
      if (opened.status === "invalid")
        return done({
          status: "stopped",
          reason: "the log is not a regular file inside the store",
          bytesRead,
        });
      close = () => opened.handle.close().catch(() => {});
      const pinned = this.cursor;
      if (
        pinned.ino !== undefined &&
        (pinned.dev !== opened.dev || pinned.ino !== opened.ino)
      )
        return done({
          status: "stopped",
          reason: "the log was replaced",
          bytesRead,
        });
      if (opened.size < pinned.end)
        return done({
          status: "stopped",
          reason: "the log was truncated",
          bytesRead,
        });
      // Nothing was appended since a pass reached the end: no read at all.
      if (opened.size === this.settledSize && !this.pending)
        return done({
          status: "read",
          records: [],
          reachedEnd: true,
          cursor: this.cursor,
          bytesRead,
        });
      const source = new LogSource(opened.handle, opened.size);
      try {
        const fence = await captureTranscriptFence(source.probe, opened.path, {
          dev: opened.dev,
          ino: opened.ino,
          size: opened.size,
        });
        const read = await this.read(source, opened, signal, budget);
        bytesRead = source.bytesRead;
        if (!read) return done({ status: "again", bytesRead });
        if (
          !(await isTranscriptPrefix(
            source.probe,
            opened.path,
            fence,
            await stat(opened.path),
          ))
        )
          return done({ status: "again", bytesRead: source.bytesRead });
        // Only a pass whose source held still moves the cursor.
        this.cursor = read.cursor;
        this.pending = read.pending;
        this.settledSize = read.reachedEnd ? opened.size : undefined;
        return done({
          status: "read",
          records: read.records,
          reachedEnd: read.reachedEnd,
          cursor: read.cursor,
          bytesRead: source.bytesRead,
        });
      } catch (error) {
        bytesRead = source.bytesRead;
        if (error instanceof UnknownLog)
          return done({ status: "stopped", reason: error.message, bytesRead });
        throw error;
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (error instanceof SourceChanged || code === "ENOENT")
        return done({ status: "again", bytesRead });
      throw error;
    } finally {
      await close?.();
    }
  }

  /** The records after the cursor, within the budget; undefined if aborted. */
  private async read(
    source: LogSource,
    opened: { dev: number; ino: number; size: number },
    signal: AbortSignal,
    budget: number,
  ): Promise<
    | {
        records: AntigravityLogTailRecord[];
        cursor: AntigravityLogBoundary;
        pending?: { start: number; searched: number };
        reachedEnd: boolean;
      }
    | undefined
  > {
    const { step, start, end, witness } = this.cursor;
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
        throw new UnknownLog("the log changed at the cursor");
      source.release(line);
    }
    const records: AntigravityLogTailRecord[] = [];
    let cursor = this.cursor;
    let at = this.pending?.start ?? end;
    let searched = this.pending?.searched ?? at;
    // The bytes last read: consecutive short lines are found in one block.
    let block: { start: number; bytes: Buffer } = {
      start: searched,
      bytes: Buffer.alloc(0),
    };
    const paused = () => (searched > at ? { start: at, searched } : undefined);
    for (;;) {
      if (signal.aborted) return undefined;
      if (searched >= opened.size)
        // An unterminated record being written is no record yet.
        return { records, cursor, pending: paused(), reachedEnd: true };
      const offset = searched - block.start;
      const newline =
        offset < block.bytes.length ? block.bytes.indexOf(10, offset) : -1;
      if (newline < 0) {
        searched = block.start + block.bytes.length;
        if (searched >= opened.size) continue;
        if (source.bytesRead >= budget)
          return { records, cursor, pending: paused(), reachedEnd: false };
        const length = Math.min(
          CHUNK_BYTES,
          opened.size - searched,
          Math.max(1, budget - source.bytesRead),
        );
        block = { start: searched, bytes: await source.read(searched, length) };
        continue;
      }
      const line: LogLine = { start: at, end: block.start + newline };
      if (line.start >= block.start)
        line.body = block.bytes.subarray(line.start - block.start, newline);
      const head = await source.head(line);
      if (head.step <= cursor.step)
        throw new UnknownLog(`step ${head.step} does not increase`);
      const record: AntigravityLogTailRecord = {
        step: head.step,
        type: head.type as AntigravityLogRecord["type"],
        start: line.start,
        end: line.end + 1,
      };
      if (head.type === "USER_INPUT") {
        if (line.end - line.start > ANTIGRAVITY_LOG_RECORD_BYTES)
          throw new UnknownLog("a user input too large to compare");
        const body = line.body;
        const parsed = await source.record(line);
        line.body = body;
        if (parsed.type === "USER_INPUT") record.text = parsed.text;
      }
      cursor = {
        step: head.step,
        start: line.start,
        end: line.end + 1,
        witness: await source.witness(line),
        dev: opened.dev,
        ino: opened.ino,
      };
      line.body = undefined;
      records.push(record);
      at = searched = line.end + 1;
    }
  }
}
