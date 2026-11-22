import type { FileHandle } from "node:fs/promises";
import {
  type AntigravityLogRecord,
  decodeAntigravityLogLine,
  parseAntigravityLogRecord,
} from "./antigravity-log-projection.js";
import { OversizedRecordScanner } from "./antigravity-log-oversized.js";
import type { TranscriptRangeRead } from "./transcript-ingestion.js";

/**
 * Reading `agy`'s brain log by byte ranges for the log window: lines found
 * backward or forward without holding a line larger than the record limit,
 * a memo of where newlines are so no byte range is scanned twice, and the
 * records those lines hold. A record larger than the limit, and a tool
 * group whose results together exceed it, is shown as a placeholder built
 * from a fixed-memory scan; the rule depends only on the file's layout, so
 * every window gives the same answer.
 */

/** A record, or a tool group's results together, shown in full up to this. */
export const ANTIGRAVITY_LOG_RECORD_BYTES = 16 * 1024 * 1024;
const FIRST_CHUNK_BYTES = 64 * 1024;
const MAX_CHUNK_BYTES = 1024 * 1024;
const HEAD_BYTES = 512;
const STEP_PREFIX = /^\{"step_index":(\d+),/;
const HEAD =
  /^\{"step_index":(\d+),"source":"([A-Z_]+)","type":"([A-Z_]+)","status":"([A-Z_]+)","created_at":"([^"\\]*)"/;

export class SourceChanged extends Error {}
export class UnknownLog extends Error {}

export interface LogLine {
  start: number;
  /** Offset of the line's newline. */
  end: number;
  /** The line's bytes, when it is within the record limit. */
  bytes?: Buffer;
}

export interface LineHead {
  step: number;
  type: string;
  status: string;
  createdAt: string;
}

const lengthOf = (line: LogLine) => line.end - line.start;
export const isOversized = (line: LogLine) =>
  lengthOf(line) > ANTIGRAVITY_LOG_RECORD_BYTES;

const megabytes = (bytes: number) => (bytes / 1024 / 1024).toFixed(1);

function parsed(text: string, invalidUtf8?: boolean): AntigravityLogRecord {
  if (invalidUtf8) throw new UnknownLog("a line is not valid UTF-8");
  if (!text) throw new UnknownLog("the log has an empty line");
  const record = parseAntigravityLogRecord(text);
  if ("unknown" in record) throw new UnknownLog(record.unknown);
  return record;
}

const USER_OPEN = "<USER_REQUEST>\n";
const SYSTEM_OPEN =
  "The following is a <SYSTEM_MESSAGE> not actually sent by the user. It is provided by the system as important information to pay attention to.\n\n<SYSTEM_MESSAGE>\n";
const SYSTEM_CLOSE = "\n</SYSTEM_MESSAGE>";

export class LogSource {
  /** Every byte that arrived, counted as it arrives. */
  bytesRead = 0;
  /** No newline in `[from, to)`; `to` is a newline when `newline` is set. */
  private readonly clear: Array<{
    from: number;
    to: number;
    newline: boolean;
  }> = [];
  private readonly heads = new Map<number, LineHead>();

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

  /** Long lines only: rereading a short one costs less than looking it up. */
  private remember(line: LogLine): void {
    if (lengthOf(line) > FIRST_CHUNK_BYTES)
      this.clear.push({ from: line.start, to: line.end, newline: true });
  }

  /** What is known about the bytes from `position` on. */
  private covering(position: number) {
    for (const range of this.clear)
      if (
        range.from <= position &&
        (position < range.to || (range.newline && position === range.to))
      )
        return range;
    return undefined;
  }

  /** The nearest known range starting after `position`, to stop a read there. */
  private nextKnown(position: number): number {
    let next = Number.POSITIVE_INFINITY;
    for (const range of this.clear)
      if (range.from > position && range.from < next) next = range.from;
    return next;
  }

  /** A line already crossed, ending at the newline `end`. */
  private knownLineEnding(end: number) {
    return this.clear.find((range) => range.newline && range.to === end);
  }

  /** The offset after the last newline: an unterminated tail is no record. */
  async completeEnd(): Promise<number> {
    let position = this.size;
    let chunk = FIRST_CHUNK_BYTES;
    while (position > 0) {
      const length = Math.min(chunk, position);
      chunk = Math.min(chunk * 2, MAX_CHUNK_BYTES);
      const block = await this.read(position - length, length);
      position -= length;
      const newline = block.lastIndexOf(10);
      if (newline >= 0) return position + newline + 1;
    }
    return 0;
  }

  /**
   * Complete lines ending before `end` (a line start), newest first. A line's
   * bytes are kept only up to the record limit, and joined once.
   */
  async *linesBefore(end: number): AsyncGenerator<LogLine> {
    let lineEnd = end - 1;
    let block: Buffer = Buffer.alloc(0);
    let blockStart = lineEnd;
    let chunk = FIRST_CHUNK_BYTES;
    while (lineEnd >= 0) {
      const known = this.knownLineEnding(lineEnd);
      if (known && known.to - known.from > ANTIGRAVITY_LOG_RECORD_BYTES) {
        // A line already crossed: not read again.
        yield { start: known.from, end: lineEnd };
        lineEnd = known.from - 1;
        block = Buffer.alloc(0);
        blockStart = lineEnd;
        continue;
      }
      const pieces: Buffer[] = [];
      let kept = 0;
      let cursor = lineEnd;
      let start: number | undefined;
      while (start === undefined) {
        if (cursor < blockStart || cursor > blockStart + block.length) {
          block = Buffer.alloc(0);
          blockStart = cursor;
        }
        const before = cursor - blockStart;
        const newline = before > 0 ? block.lastIndexOf(10, before - 1) : -1;
        const from = newline >= 0 ? newline + 1 : 0;
        if (kept <= ANTIGRAVITY_LOG_RECORD_BYTES) {
          pieces.push(block.subarray(from, before));
          kept += before - from;
          // Too large to hold: only its bounds are kept.
          if (kept > ANTIGRAVITY_LOG_RECORD_BYTES) pieces.length = 0;
        }
        if (newline >= 0) start = blockStart + newline + 1;
        else if (blockStart === 0) start = 0;
        else {
          cursor = blockStart;
          const length = Math.min(chunk, blockStart);
          chunk = Math.min(chunk * 2, MAX_CHUNK_BYTES);
          block = await this.read(blockStart - length, length);
          blockStart -= length;
        }
      }
      const line: LogLine = { start, end: lineEnd };
      if (lineEnd - start <= ANTIGRAVITY_LOG_RECORD_BYTES)
        line.bytes =
          pieces.length === 1
            ? pieces[0]!
            : Buffer.concat(pieces.reverse(), lineEnd - start);
      this.remember(line);
      yield line;
      lineEnd = start - 1;
    }
  }

  /**
   * Complete lines from `start` up to `limit`, both line starts. With `keep`
   * false no bytes are kept, and lines already crossed are not read again.
   */
  async *linesFrom(
    start: number,
    limit: number,
    keep = true,
  ): AsyncGenerator<LogLine> {
    let lineStart = start;
    let position = start;
    let pieces: Buffer[] = [];
    let kept = 0;
    let chunk = FIRST_CHUNK_BYTES;
    const finish = (end: number): LogLine => {
      const line: LogLine = { start: lineStart, end };
      if (keep && lengthOf(line) <= ANTIGRAVITY_LOG_RECORD_BYTES)
        line.bytes =
          pieces.length === 1
            ? pieces[0]!
            : Buffer.concat(pieces, lengthOf(line));
      pieces = [];
      kept = 0;
      lineStart = position = end + 1;
      this.remember(line);
      return line;
    };
    while (lineStart < limit) {
      // Bytes not wanted: what is known about them is not read again.
      if (!keep || kept > ANTIGRAVITY_LOG_RECORD_BYTES) {
        const known = this.covering(position);
        if (known?.newline) {
          yield finish(known.to);
          continue;
        }
        if (known) {
          position = known.to;
          continue;
        }
      }
      const length = Math.min(
        chunk,
        limit - position,
        this.nextKnown(position) - position,
      );
      chunk = Math.min(chunk * 2, MAX_CHUNK_BYTES);
      const block = await this.read(position, length);
      const blockStart = position;
      let from = 0;
      for (
        let newline = block.indexOf(10);
        newline >= 0;
        newline = block.indexOf(10, from)
      ) {
        if (keep && kept <= ANTIGRAVITY_LOG_RECORD_BYTES)
          pieces.push(block.subarray(from, newline));
        from = newline + 1;
        yield finish(blockStart + newline);
      }
      if (from < block.length) {
        if (keep && kept <= ANTIGRAVITY_LOG_RECORD_BYTES)
          pieces.push(block.subarray(from));
        kept += block.length - from;
        if (kept > ANTIGRAVITY_LOG_RECORD_BYTES) pieces = [];
        position = blockStart + block.length;
      }
    }
  }

  /** Step, type, status and time, from the line's first bytes. */
  async head(line: LogLine): Promise<LineHead> {
    const known = this.heads.get(line.start);
    if (known) return known;
    const prefix =
      line.bytes ??
      (await this.read(line.start, Math.min(HEAD_BYTES, lengthOf(line))));
    const match = HEAD.exec(prefix.subarray(0, HEAD_BYTES).toString("latin1"));
    let head: LineHead;
    if (match)
      head = {
        step: Number(match[1]),
        type: match[3]!,
        status: match[4]!,
        createdAt: match[5]!,
      };
    else {
      // Not in the observed key order: the whole record decides.
      const record = await this.record(line);
      head = {
        step: record.step,
        type: record.type,
        status: record.type === "GENERIC" ? record.status : "DONE",
        createdAt: record.createdAt,
      };
    }
    this.heads.set(line.start, head);
    return head;
  }

  /** The line's record; a line over the limit becomes a placeholder. */
  async record(line: LogLine): Promise<AntigravityLogRecord> {
    if (isOversized(line)) return this.oversized(line);
    // Bytes let go while a group's size was unknown are read again.
    const decoded = decodeAntigravityLogLine(
      line.bytes ?? (await this.read(line.start, lengthOf(line))),
    );
    return parsed(decoded.text, decoded.invalidUtf8);
  }

  /** A result of a tool group too large to show in full. */
  async groupPlaceholder(
    line: LogLine,
    groupBytes: number,
  ): Promise<AntigravityLogRecord> {
    const head = await this.head(line);
    if (head.type !== "GENERIC") return this.record(line);
    const status = head.status;
    if (status !== "DONE" && status !== "ERROR" && status !== "RUNNING")
      throw new UnknownLog(`GENERIC at step ${head.step} has status ${status}`);
    return {
      type: "GENERIC",
      step: head.step,
      createdAt: head.createdAt,
      status,
      content: `This result is part of a tool step too large to show here (${megabytes(groupBytes)} MB of results).`,
    };
  }

  /** Summarizes a line too large to hold, reading it once in pieces. */
  private async oversized(line: LogLine): Promise<AntigravityLogRecord> {
    const scanner = new OversizedRecordScanner();
    let chunk = FIRST_CHUNK_BYTES;
    for (let position = line.start; position < line.end; ) {
      const length = Math.min(chunk, line.end - position);
      chunk = Math.min(chunk * 2, MAX_CHUNK_BYTES);
      scanner.push(await this.read(position, length));
      position += length;
    }
    const summary = scanner.finish();
    if (summary.malformed) throw new UnknownLog(summary.malformed);
    const notice = `This step is too large to show here (${megabytes(lengthOf(line))} MB).`;
    const text = (key: string) => summary.values.get(key);
    const type = text("type");
    // The record rebuilt with its keys and kinds, text replaced by the
    // notice, so the parser checks it as it checks any record.
    const rebuilt: Record<string, unknown> = {};
    for (const [key, kind] of summary.keys) {
      const value = summary.values.get(key);
      if (kind === "number" || kind === "literal")
        rebuilt[key] = kind === "number" ? value : null;
      else if (kind === "object") rebuilt[key] = {};
      else if (kind === "array")
        rebuilt[key] =
          key === "tool_calls"
            ? summary.calls.map((call) =>
                call.name !== undefined && call.argsObject && call.keys === 2
                  ? { name: call.name, args: {} }
                  : { malformed: true },
              )
            : [];
      else rebuilt[key] = value;
    }
    const content = String(text("content") ?? "");
    if (type === "USER_INPUT") {
      if (!content.startsWith(USER_OPEN))
        throw new UnknownLog(
          `USER_INPUT at step ${text("step_index")} is not a USER_REQUEST in the observed form`,
        );
      rebuilt.content = `${USER_OPEN}${notice}\n</USER_REQUEST>`;
    } else if (type === "SYSTEM_MESSAGE") {
      if (!content.startsWith(SYSTEM_OPEN))
        throw new UnknownLog(
          `SYSTEM_MESSAGE at step ${text("step_index")} is not a SYSTEM_MESSAGE in the observed form`,
        );
      const inbox = content.slice(SYSTEM_OPEN.length).startsWith("[Message] ");
      rebuilt.content = `${SYSTEM_OPEN}${inbox ? "[Message] " : ""}${notice}${SYSTEM_CLOSE}`;
    } else {
      if ("content" in rebuilt) rebuilt.content = notice;
      if ("thinking" in rebuilt) delete rebuilt.thinking;
      if (type === "PLANNER_RESPONSE" && !("content" in rebuilt))
        rebuilt.content = notice;
      for (const key of ["error"])
        if (summary.cut.has(key)) rebuilt[key] = `${String(rebuilt[key])}…`;
    }
    return parsed(JSON.stringify(rebuilt));
  }

  /** The first line starting in `[from, before)`, with its step. */
  private async stepAtOrAfter(
    from: number,
    before: number,
  ): Promise<{ start: number; step: number } | undefined> {
    let position = from - 1;
    let chunk = FIRST_CHUNK_BYTES;
    let newline: number | undefined;
    while (newline === undefined && position < before - 1) {
      const known = this.covering(position);
      if (known) {
        if (known.newline) newline = known.to;
        else position = known.to;
        continue;
      }
      const length = Math.min(
        chunk,
        before - 1 - position,
        this.nextKnown(position) - position,
      );
      chunk = Math.min(chunk * 2, MAX_CHUNK_BYTES);
      const found = (await this.read(position, length)).indexOf(10);
      if (found >= 0) newline = position + found;
      else
        this.clear.push({
          from: position,
          to: position + length,
          newline: false,
        });
      position += length;
    }
    if (newline !== undefined)
      this.clear.push({ from: from - 1, to: newline, newline: true });
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
    for await (const line of this.linesFrom(low, limit, false))
      if ((await this.head(line)).step >= step) return line;
    return undefined;
  }
}
