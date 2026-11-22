import type { FileHandle } from "node:fs/promises";
import {
  ANTIGRAVITY_LOG_HEAD_BYTES,
  ANTIGRAVITY_LOG_RECORD_BYTES,
  type AntigravityLogHead,
  type AntigravityLogRecord,
  antigravityHeadIsReminder,
  antigravityPlaceholderRecord,
  decodeAntigravityLogLine,
  parseAntigravityLogHead,
  parseAntigravityLogRecord,
} from "./antigravity-log-projection.js";
import type { TranscriptRangeRead } from "./transcript-ingestion.js";

/**
 * `agy`'s brain log by byte ranges, for the log window. Lines are found by
 * searching for newlines backward or forward; finding one keeps only its
 * offsets and, for a short line, its bytes. A longer body is read when a
 * page has decided to show it, and released once decoded. A record over the
 * record limit is never held: it is shown from its head
 * (`antigravityPlaceholderRecord`). The only scans are newline searches and
 * fixed-size heads, so no work grows faster than a line's length.
 */

/** Lines up to this keep their bytes while they are found. */
const KEEP_BYTES = 64 * 1024;
/** In a tool group over the record limit, results larger than this are placeholders. */
export const ANTIGRAVITY_LOG_GROUP_RESULT_BYTES = 64 * 1024;
const FIRST_CHUNK_BYTES = 64 * 1024;
const MAX_CHUNK_BYTES = 1024 * 1024;
const STEP_PREFIX = /^\{"step_index":(\d+),/;
/** Bytes read from the file's start for its first prompt. */
const TITLE_BYTES = 256 * 1024;

export class SourceChanged extends Error {}
export class UnknownLog extends Error {}

export interface LogLine {
  start: number;
  /** Offset of the line's newline. */
  end: number;
  /** The line's bytes, when held. */
  body?: Buffer;
}

export const lineLength = (line: LogLine) => line.end - line.start;
export const isOversized = (line: LogLine) =>
  lineLength(line) > ANTIGRAVITY_LOG_RECORD_BYTES;

function parsed(record: AntigravityLogRecord | { unknown: string }) {
  if ("unknown" in record) throw new UnknownLog(record.unknown);
  return record;
}

/**
 * The first prompt among the first complete lines of a file's start, if
 * one is there: a title never reads past this bounded start.
 */
export function firstPromptIn(start: Buffer): string | undefined {
  let from = 0;
  for (let seen = 0; seen < 4; seen++) {
    const newline = start.indexOf(10, from);
    if (newline < 0) return undefined;
    const record = parseAntigravityLogRecord(
      start.subarray(from, newline).toString("utf8"),
    );
    if ("unknown" in record) return undefined;
    if (record.type === "USER_INPUT") return record.text;
    from = newline + 1;
  }
  return undefined;
}

export class LogSource {
  /** Every byte that arrived, counted as it arrives. */
  bytesRead = 0;
  /** Line bytes held now, and the most held at once. */
  held = 0;
  heldPeak = 0;
  /** The last block read, reused by the next search. */
  private block: { start: number; bytes: Buffer } = {
    start: 0,
    bytes: Buffer.alloc(0),
  };
  private chunk = FIRST_CHUNK_BYTES;
  /** Whole lines found: start to newline, and newline to start. */
  private readonly lineEnd = new Map<number, number>();
  private readonly lineStart = new Map<number, number>();
  /** Ranges `[from, to)` known to hold no newline; not known to be lines. */
  private readonly clear: Array<[number, number]> = [];
  private readonly heads = new Map<number, AntigravityLogHead>();
  private readonly prefixes = new Map<number, string>();

  constructor(
    private readonly handle: FileHandle,
    readonly size: number,
  ) {}

  /** Exactly `length` bytes, or the file changed under the read. */
  async read(start: number, length: number): Promise<Buffer> {
    const buffer = Buffer.allocUnsafe(length);
    let filled = 0;
    while (filled < length) {
      const { bytesRead } = await this.handle.read(
        buffer,
        filled,
        length - filled,
        start + filled,
      );
      if (!bytesRead) throw new SourceChanged();
      filled += bytesRead;
      this.bytesRead += bytesRead;
    }
    return buffer;
  }

  readonly probe: TranscriptRangeRead = (_path, start, length) =>
    this.read(start, length);

  private hold(line: LogLine, body: Buffer): void {
    line.body = body;
    this.held += body.length;
    this.heldPeak = Math.max(this.heldPeak, this.held);
  }

  /** Lets go of a line's bytes. */
  release(line: LogLine): void {
    if (!line.body) return;
    this.held -= line.body.length;
    line.body = undefined;
  }

  private nextChunk(): number {
    const size = this.chunk;
    this.chunk = Math.min(this.chunk * 2, MAX_CHUNK_BYTES);
    return size;
  }

  private remember(line: LogLine): void {
    this.lineEnd.set(line.start, line.end);
    this.lineStart.set(line.end, line.start);
  }

  /** The offset after the last newline: an unterminated tail is no record. */
  async completeEnd(): Promise<number> {
    let position = this.size;
    while (position > 0) {
      const length = Math.min(this.nextChunk(), position);
      const bytes = await this.read(position - length, length);
      this.block = { start: position - length, bytes };
      position -= length;
      const newline = bytes.lastIndexOf(10);
      if (newline >= 0) return position + newline + 1;
    }
    return 0;
  }

  /**
   * The line ending just before `end` (a line start). When its start lies
   * more than `within` bytes back, nothing is returned; the range searched
   * is remembered as holding no newline.
   */
  async lineBefore(
    end: number,
    within = Number.POSITIVE_INFINITY,
  ): Promise<LogLine | undefined> {
    if (end <= 0) return undefined;
    const newline = end - 1;
    const known = this.lineStart.get(newline);
    if (known !== undefined)
      return newline - known > within
        ? undefined
        : { start: known, end: newline };
    const pieces: Buffer[] = [];
    let kept = 0;
    let cursor = newline;
    let start: number | undefined;
    while (start === undefined) {
      if (newline - cursor > within) {
        this.clear.push([cursor, newline]);
        return undefined;
      }
      if (kept > KEEP_BYTES) {
        // Bytes not kept: a range already searched is not read again.
        const skip = this.clear.find(
          ([from, to]) => from < cursor && cursor <= to,
        );
        if (skip) {
          cursor = skip[0];
          if (cursor === 0) start = 0;
          continue;
        }
      }
      // A newline at offset 0 ends an empty first line.
      if (cursor === 0) {
        start = 0;
        continue;
      }
      const { start: blockStart, bytes } = this.block;
      if (cursor <= blockStart || cursor > blockStart + bytes.length) {
        const length = Math.min(this.nextChunk(), cursor);
        this.block = {
          start: cursor - length,
          bytes: await this.read(cursor - length, length),
        };
        continue;
      }
      const before = cursor - blockStart;
      const found = bytes.lastIndexOf(10, before - 1);
      const from = found >= 0 ? found + 1 : 0;
      if (kept <= KEEP_BYTES) {
        pieces.push(bytes.subarray(from, before));
        kept += before - from;
        if (kept > KEEP_BYTES) pieces.length = 0;
      }
      if (found >= 0) start = blockStart + found + 1;
      else if (blockStart === 0) start = 0;
      else cursor = blockStart;
    }
    const line: LogLine = { start, end: newline };
    this.remember(line);
    if (lineLength(line) <= KEEP_BYTES)
      this.hold(
        line,
        pieces.length === 1
          ? pieces[0]!
          : Buffer.concat(pieces.reverse(), lineLength(line)),
      );
    return line;
  }

  /** The line starting at `start` (a line start) and ending before `limit`. */
  async lineFrom(start: number, limit: number): Promise<LogLine> {
    const known = this.lineEnd.get(start);
    if (known !== undefined) return { start, end: known };
    const pieces: Buffer[] = [];
    let kept = 0;
    let cursor = start;
    for (;;) {
      if (cursor >= limit) throw new SourceChanged();
      if (kept > KEEP_BYTES) {
        const skip = this.clear.find(
          ([from, to]) => from <= cursor && cursor < to,
        );
        if (skip) {
          cursor = skip[1];
          continue;
        }
      }
      const { start: blockStart, bytes } = this.block;
      if (cursor < blockStart || cursor >= blockStart + bytes.length) {
        const length = Math.min(this.nextChunk(), limit - cursor);
        this.block = { start: cursor, bytes: await this.read(cursor, length) };
        continue;
      }
      const from = cursor - blockStart;
      const found = bytes.indexOf(10, from);
      const to = found >= 0 ? found : bytes.length;
      if (kept <= KEEP_BYTES) {
        pieces.push(bytes.subarray(from, to));
        kept += to - from;
        if (kept > KEEP_BYTES) pieces.length = 0;
      }
      if (found >= 0) {
        const line: LogLine = { start, end: blockStart + found };
        this.remember(line);
        if (lineLength(line) <= KEEP_BYTES)
          this.hold(
            line,
            pieces.length === 1
              ? pieces[0]!
              : Buffer.concat(pieces, lineLength(line)),
          );
        return line;
      }
      cursor = blockStart + bytes.length;
    }
  }

  /** A record's leading fields, from its first bytes. */
  async head(line: LogLine): Promise<AntigravityLogHead> {
    const known = this.heads.get(line.start);
    if (known) return known;
    const prefix =
      line.body ??
      (await this.read(
        line.start,
        Math.min(ANTIGRAVITY_LOG_HEAD_BYTES, lineLength(line)),
      ));
    const text = prefix
      .subarray(0, ANTIGRAVITY_LOG_HEAD_BYTES)
      .toString("latin1");
    this.prefixes.set(line.start, text);
    let head = parseAntigravityLogHead(text);
    if (!head?.createdAt && !isOversized(line)) {
      // Not in the observed key order, or a long error before the time: the
      // whole record decides.
      const body = line.body;
      const record = await this.record(line);
      if (body) this.hold(line, body);
      head = {
        step: record.step,
        source: "",
        type: record.type,
        status: record.type === "GENERIC" ? record.status : "DONE",
        createdAt: record.createdAt,
      };
    }
    if (!head)
      throw new UnknownLog(
        "a record too large to read does not begin as observed",
      );
    this.heads.set(line.start, head);
    return head;
  }

  /**
   * Whether the line is a system message whose head already shows it is a
   * reminder, which is never shown: its body need not be read.
   */
  async isReminder(line: LogLine): Promise<boolean> {
    if ((await this.head(line)).type !== "SYSTEM_MESSAGE") return false;
    return antigravityHeadIsReminder(this.prefixes.get(line.start) ?? "");
  }

  /**
   * The line's record: decoded, or a placeholder from its validated head
   * when it is over the record limit or `group` (its tool group's result
   * bytes) is given. Bytes read for it are released once decoded.
   */
  async record(line: LogLine, group?: number): Promise<AntigravityLogRecord> {
    if (isOversized(line) || group !== undefined) {
      const head = await this.head(line);
      this.release(line);
      return antigravityPlaceholderRecord(
        head,
        this.prefixes.get(line.start) ?? "",
        lineLength(line),
        group,
      );
    }
    if (!line.body)
      this.hold(line, await this.read(line.start, lineLength(line)));
    const decoded = decodeAntigravityLogLine(line.body!);
    this.release(line);
    if (decoded.invalidUtf8) throw new UnknownLog("a line is not valid UTF-8");
    if (!decoded.text) throw new UnknownLog("the log has an empty line");
    return parsed(parseAntigravityLogRecord(decoded.text));
  }

  /** The first prompt, from a bounded read of the file's start. */
  async firstPrompt(limit: number): Promise<string | undefined> {
    return firstPromptIn(await this.read(0, Math.min(TITLE_BYTES, limit)));
  }

  /** The first line starting in `[from, before)`, with its step. */
  private async stepAtOrAfter(
    from: number,
    before: number,
  ): Promise<{ start: number; step: number } | undefined> {
    let position = from - 1;
    let newline: number | undefined;
    // Small first: a probe usually lands a few kilobytes before a newline.
    let chunk = 4096;
    while (newline === undefined && position < before - 1) {
      let inLine: number | undefined;
      for (const [start, end] of this.lineEnd)
        if (start <= position && position <= end) inLine = end;
      if (inLine !== undefined) {
        newline = inLine;
        break;
      }
      const skip = this.clear.find(
        ([start, end]) => start <= position && position < end,
      );
      if (skip) {
        position = skip[1];
        continue;
      }
      const length = Math.min(chunk, before - 1 - position);
      chunk = Math.min(chunk * 2, MAX_CHUNK_BYTES);
      const found = (await this.read(position, length)).indexOf(10);
      if (found >= 0) newline = position + found;
      if (found !== 0)
        this.clear.push([
          position,
          found >= 0 ? position + found : position + length,
        ]);
      position += length;
    }
    const start = newline === undefined ? undefined : newline + 1;
    if (start === undefined || start >= before) return undefined;
    const prefix = await this.read(start, Math.min(40, this.size - start));
    const step = STEP_PREFIX.exec(prefix.toString("latin1"))?.[1];
    // Every observed record begins with its step_index; a search needs it.
    if (step === undefined)
      throw new UnknownLog("a record does not begin with its step_index");
    return { start, step: Number(step) };
  }

  /** The first line whose step is at least `step`, searching by halves. */
  async findStep(step: number, limit: number): Promise<LogLine | undefined> {
    let low = 0;
    let high = limit;
    while (high - low > 256 * 1024) {
      const middle = low + Math.floor((high - low) / 2);
      const probe = await this.stepAtOrAfter(middle, high);
      if (!probe) high = middle;
      else if (probe.step < step) low = probe.start;
      else high = probe.start;
    }
    for (let start = low; start < limit; ) {
      const line = await this.lineFrom(start, limit);
      if ((await this.head(line)).step >= step) return line;
      this.release(line);
      start = line.end + 1;
    }
    return undefined;
  }
}
