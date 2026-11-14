import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import {
  captureTranscriptFence,
  digestTranscriptFence,
  isTranscriptPrefixOfDigest,
  readTranscriptRange,
  type TranscriptFenceDigest,
  type TranscriptRange,
  type TranscriptRangeRead,
} from "./transcript-ingestion.js";

/**
 * The source adapter for append-only JSONL transcripts (plan 192): bounded
 * batches of decoded records after an opaque cursor, read forward once. It
 * owns framing, the record still being written, segments, skipped-record
 * diagnostics and noticing that the source was replaced, truncated or
 * rewritten. It does not normalize: what a record means is its consumer's.
 */

/** One file of a source. A fork's ancestors end at `end`; the leaf has none. */
export interface AppendSourceSegment {
  path: string;
  end?: number;
}
export interface AppendSourceRecord<T> {
  /** Index into the segments the batch was read from. */
  segment: number;
  /** Byte offset of the record's line in its segment. */
  offset: number;
  byteLength: number;
  entry: T;
}
/** A record that was skipped: malformed, refused by `decode`, or too long. */
export interface AppendSourceDiagnostic {
  segment: number;
  offset: number;
  reason: string;
  /** How many records the batch had accepted when this one was skipped. */
  recordIndex: number;
}
export interface AppendSourceBudget {
  /**
   * Source bytes examined per batch, not counting the probes that check the
   * cursor. Never less than twice `recordBytes`, so that a batch starting at
   * a record always reaches its end or the point where it is skipped.
   */
  bytes?: number;
  /** Newline-terminated lines, counting skipped ones. */
  records?: number;
  /** Longer records are skipped without being buffered or parsed. */
  recordBytes?: number;
  /** Checked between segments; one segment's read is bounded by `bytes`. */
  deadlineMs?: number;
}
export interface AppendSourceOptions<T> {
  cursor?: string;
  signal: AbortSignal;
  budget?: AppendSourceBudget;
  /**
   * The provider's record for one parsed line. `undefined` leaves the line
   * out without comment; throwing reports it as skipped.
   */
  decode(value: unknown): T | undefined;
  /**
   * A record that cannot be interpreted without its successor. When a batch
   * stops short of the source's end on such a record, the record is left for
   * the next batch.
   */
  holdBack?(entry: T): boolean;
}
export interface AppendSourceBatch<T> {
  records: AppendSourceRecord<T>[];
  /** Where the next batch starts. Opaque; valid only for the same segments. */
  cursor: string;
  /** Earlier batches are void: the cursor no longer described the source. */
  reset: boolean;
  /** Nothing complete is left to read. */
  done: boolean;
  /** The source ends in a record that is still being written. */
  incomplete: boolean;
  /** A record has been skipped since the last reset, in this batch or before. */
  recordErrors: boolean;
  bytesRead: number;
  diagnostics: AppendSourceDiagnostic[];
}

const CURSOR_VERSION = 2;
const BATCH_BYTES = 8 * 1024 * 1024;
const BATCH_RECORDS = 2000;
const BATCH_DEADLINE_MS = 30_000;
const READ_BYTES = 64 * 1024;
const RECORD_BYTES = 1024 * 1024;

interface Cursor {
  v: typeof CURSOR_VERSION;
  /** Digest of the segment list the cursor was issued for. */
  layout: string;
  segment: number;
  offset: number;
  /** `offset` is inside a record that is being skipped as too long. */
  dropping: boolean;
  /** A record has been skipped since the last reset. */
  errors: boolean;
  /** Probes over the segment's first `offset` bytes. */
  fence?: TranscriptFenceDigest;
  /** With `fence`: an unchanged size with a changed mtime is a rewrite. */
  fileSize?: number;
  mtime?: number;
}

function layoutOf(segments: readonly AppendSourceSegment[]): string {
  return createHash("sha256")
    .update(
      JSON.stringify(segments.map(({ path, end }) => [path, end ?? null])),
    )
    .digest("base64");
}

/** A cursor from this version and for these segments, or nothing. */
function parseCursor(text: string, layout: string): Cursor | undefined {
  let cursor: Partial<Cursor>;
  try {
    cursor = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (
    cursor?.v !== CURSOR_VERSION ||
    cursor.layout !== layout ||
    !Number.isSafeInteger(cursor.segment) ||
    !Number.isSafeInteger(cursor.offset) ||
    (cursor.segment as number) < 0 ||
    (cursor.offset as number) < 0
  )
    return undefined;
  return cursor as Cursor;
}

export async function readAppendSourceBatch<T>(
  segments: readonly AppendSourceSegment[],
  options: AppendSourceOptions<T>,
): Promise<AppendSourceBatch<T>> {
  const layout = layoutOf(segments);
  const start = (): Cursor => ({
    v: CURSOR_VERSION,
    layout,
    segment: 0,
    offset: 0,
    dropping: false,
    errors: false,
  });
  const given =
    options.cursor === undefined
      ? undefined
      : parseCursor(options.cursor, layout);
  let cursor = given ?? start();
  // A cursor from another layout or cursor version restarts the source.
  let reset = options.cursor !== undefined && !given;
  const records: AppendSourceRecord<T>[] = [];
  const diagnostics: AppendSourceDiagnostic[] = [];
  const restart = () => {
    reset = true;
    cursor = start();
    records.length = 0;
    diagnostics.length = 0;
  };
  const maxRecordBytes = options.budget?.recordBytes ?? RECORD_BYTES;
  const maxBytes = Math.max(
    options.budget?.bytes ?? BATCH_BYTES,
    2 * maxRecordBytes,
  );
  const maxRecords = options.budget?.records ?? BATCH_RECORDS;
  const deadline =
    Date.now() + (options.budget?.deadlineMs ?? BATCH_DEADLINE_MS);
  let bytesRead = 0;
  let examined = 0;
  let lines = 0;
  let incomplete = false;
  let done = false;
  const batch = (): AppendSourceBatch<T> => ({
    records,
    cursor: JSON.stringify(cursor),
    reset,
    done,
    incomplete,
    recordErrors: cursor.errors,
    bytesRead,
    diagnostics,
  });
  while (
    cursor.segment < segments.length &&
    examined < maxBytes &&
    lines < maxRecords &&
    Date.now() < deadline
  ) {
    options.signal.throwIfAborted();
    const index = cursor.segment;
    const segment = segments[index] as AppendSourceSegment;
    const file = await open(segment.path, "r");
    try {
      const stats = await file.stat();
      const end = Math.min(stats.size, segment.end ?? stats.size);
      let short = false;
      const read: TranscriptRangeRead = async (_path, offset, amount) => {
        options.signal.throwIfAborted();
        const buffer = Buffer.allocUnsafe(amount);
        let filled = 0;
        while (filled < amount) {
          const { bytesRead: count } = await file.read(
            buffer,
            filled,
            amount - filled,
            offset + filled,
          );
          if (!count) break;
          filled += count;
        }
        bytesRead += filled;
        if (filled < amount) short = true;
        return buffer.subarray(0, filled);
      };
      if (
        cursor.offset > end ||
        (cursor.fileSize === stats.size &&
          cursor.mtime !== undefined &&
          cursor.mtime !== stats.mtimeMs) ||
        (cursor.fence &&
          !(await isTranscriptPrefixOfDigest(
            read,
            segment.path,
            cursor.fence,
            stats,
          )))
      ) {
        restart();
        continue;
      }
      const skip = (offset: number, reason: string) => {
        cursor.errors = true;
        diagnostics.push({
          segment: index,
          offset,
          reason,
          recordIndex: records.length,
        });
      };
      const decode = (line: string): T | undefined =>
        options.decode(JSON.parse(line));
      // The range's last line, when no newline follows it yet.
      const tail: { line?: string; offset: number; byteLength: number } = {
        offset: 0,
        byteLength: 0,
      };
      let range: TranscriptRange<null>;
      try {
        range = await readTranscriptRange<null>(
          read,
          segment.path,
          cursor.offset,
          Math.min(end - cursor.offset, maxBytes - examined),
          (line, offset, info) => {
            if (!info.committed) {
              Object.assign(tail, {
                line,
                offset,
                byteLength: info.byteLength,
              });
              return null;
            }
            try {
              const entry = decode(line);
              if (entry !== undefined)
                records.push({
                  segment: index,
                  offset,
                  byteLength: info.byteLength,
                  entry,
                });
            } catch (error) {
              skip(
                offset,
                error instanceof Error ? error.message : String(error),
              );
            }
            return null;
          },
          undefined,
          undefined,
          {
            chunkBytes: READ_BYTES,
            maxLines: maxRecords - lines,
            maxLineBytes: maxRecordBytes,
            dropping: cursor.dropping,
            dropped: (offset) =>
              skip(
                offset,
                `Record exceeds the ${maxRecordBytes}-byte search limit`,
              ),
          },
        );
      } catch (error) {
        // The file ended before the size it was opened at: truncated mid-read.
        if (!short) throw error;
        restart();
        return batch();
      }
      const unterminated = range.partialLine.length;
      // The range counts its unterminated line; the budget counts newlines.
      lines += range.lineCount - (unterminated ? 1 : 0);
      examined += range.sourceBytes;
      let offset = cursor.offset + range.sourceBytes;
      let dropping = range.dropping;
      if (unterminated) {
        // A record without its newline is complete only at the end of the
        // source, and only if it already parses. Otherwise it is read again.
        let accepted = offset >= end;
        if (accepted && tail.line !== undefined)
          try {
            const entry = decode(tail.line);
            if (entry !== undefined)
              records.push({
                segment: index,
                offset: tail.offset,
                byteLength: tail.byteLength,
                entry,
              });
          } catch {
            accepted = false;
            incomplete = true;
          }
        if (!accepted) offset -= unterminated;
      }
      const last = records.at(-1);
      if (
        options.holdBack &&
        last &&
        last.segment === index &&
        !incomplete &&
        offset < end &&
        options.holdBack(last.entry)
      ) {
        records.pop();
        offset = last.offset;
        dropping = false;
      }
      const after = await file.stat();
      // Appends leave the prefix just read intact. A shrink or an in-place
      // rewrite voids it, and the batch with it.
      if (
        after.size < stats.size ||
        (after.size === stats.size && after.mtimeMs !== stats.mtimeMs)
      ) {
        restart();
        return batch();
      }
      const errors = cursor.errors;
      if (offset >= end && index < segments.length - 1)
        cursor = { ...start(), segment: index + 1, errors };
      else {
        cursor = {
          ...start(),
          segment: index,
          offset,
          dropping,
          errors,
          fence: digestTranscriptFence(
            await captureTranscriptFence(read, segment.path, {
              dev: stats.dev,
              ino: stats.ino,
              size: offset,
            }),
          ),
          fileSize: stats.size,
          mtime: stats.mtimeMs,
        };
        done = index === segments.length - 1 && (incomplete || offset >= end);
        break;
      }
    } finally {
      await file.close();
    }
  }
  return batch();
}
