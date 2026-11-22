import { stat } from "node:fs/promises";
import type { Message } from "../supervisor/types.js";
import {
  AntigravityLogProjection,
  type AntigravityLogLine,
  type AntigravityLogRecord,
  antigravityLogLines,
  decodeAntigravityLogLine,
  parseAntigravityLogRecord,
} from "./antigravity-log-projection.js";
import { openPhysicalBrainTranscript } from "./antigravity-subagent-links.js";
import {
  captureTranscriptFence,
  isTranscriptPrefix,
  type TranscriptRangeRead,
} from "./transcript-ingestion.js";

/**
 * Pages of `agy`'s brain log (`transcript_full.jsonl`), read from the file's
 * end or from a message's record without reading the rest of the file. A page
 * holds whole records, starts at a record that is not a tool result, and is
 * projected with the context the tool-group rule needs
 * (topics/antigravity-native-storage.md#windows). Reads never write, never
 * start `agy`, and stop at a byte budget; a spent budget is an unknown log,
 * never the end of the log.
 */

/** A page's own records; one record or tool group may extend past it. */
export const ANTIGRAVITY_LOG_PAGE_BYTES = 4 * 1024 * 1024;
/** Everything one paged read may acquire: page, context, search and probes. */
export const ANTIGRAVITY_LOG_READ_BUDGET = 32 * 1024 * 1024;
const ATTEMPTS = 3;
const FIRST_CHUNK_BYTES = 64 * 1024;
const MAX_CHUNK_BYTES = 1024 * 1024;
/** Below this span the search for a step reads forward instead of halving. */
const SEARCH_LINEAR_BYTES = 256 * 1024;
const STEP_PREFIX = /^\{"step_index":(\d+),/;
const STEP_PREFIX_BYTES = 40;
/** Records looked at from the file's start for the conversation's first prompt. */
const TITLE_RECORDS = 4;

export type AntigravityLogWindowRequest =
  /** The newest records: back to the `compactions`-th checkpoint, within the page budget. */
  | { kind: "latest"; compactions: number }
  /** The page before a message, chosen the same way. */
  | { kind: "before"; messageId: string; compactions: number }
  /** From a message to the end, when that fits a page; else the latest page. */
  | { kind: "after"; messageId: string; compactions: number }
  /** The whole log, unbudgeted: a deliberate complete read. */
  | { kind: "complete" };

export type AntigravityLogWindow =
  | {
      status: "known";
      messages: Message[];
      /** Records before the page exist. */
      omittedPrefix: boolean;
      /** For `before` and `after`: whether the message was found. */
      anchor?: "found" | "missed";
      /** The conversation's first prompt, when it was read. */
      firstPrompt?: string;
      bytesRead: number;
    }
  /** No log, or no complete record in it. */
  | { status: "missing"; bytesRead: number }
  | { status: "unknown"; reason: string; error?: unknown; bytesRead: number };

export interface AntigravityLogWindowOptions {
  /** The store's physical `conversations` directory. */
  scope: string;
  conversationId: string;
  /** A tool group the log ends inside is still running. */
  ownerLive: boolean;
  request: AntigravityLogWindowRequest;
  pageBytes?: number;
  readBudget?: number;
  /** Tests: runs after an attempt's reads, before its source check. */
  afterRead?: (attempt: number) => Promise<void> | void;
}

class BudgetSpent extends Error {}
class SourceChanged extends Error {}
class UnknownLog extends Error {}

interface Located {
  start: number;
  /** Offset of the record's newline. */
  end: number;
  record: AntigravityLogRecord;
}

/** A message ID's record: `:result` names step P+1+i of planner P's call i. */
export function antigravityMessageStep(
  conversationId: string,
  messageId: string,
): number | undefined {
  const prefix = `${conversationId}:step-`;
  if (!messageId.startsWith(prefix)) return undefined;
  const match =
    /^(\d+)(?::(?:thinking|text|error)|:tool-(\d+):(call|result))?$/.exec(
      messageId.slice(prefix.length),
    );
  if (!match) return undefined;
  const step = Number(match[1]);
  const call = match[2] === undefined ? 0 : Number(match[2]);
  if (!Number.isSafeInteger(step) || !Number.isSafeInteger(call))
    return undefined;
  return match[3] === "result" ? step + 1 + call : step;
}

class LogSource {
  bytesRead = 0;
  constructor(
    private readonly handle: import("node:fs/promises").FileHandle,
    readonly size: number,
    private readonly budget: number,
  ) {}

  get remaining(): number {
    return this.budget - this.bytesRead;
  }

  async read(start: number, length: number): Promise<Buffer> {
    if (length > this.remaining) throw new BudgetSpent();
    return this.fill(start, length);
  }

  /** Source checks: counted, outside the budget. */
  readonly probe: TranscriptRangeRead = (_path, start, length) =>
    this.fill(start, length);

  private async fill(start: number, length: number): Promise<Buffer> {
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
    }
    this.bytesRead += length;
    return buffer;
  }

  /** Chunks of `[start, limit)`, small first so a short read stays short. */
  async *chunks(start: number, limit: number): AsyncGenerator<Buffer> {
    let size = FIRST_CHUNK_BYTES;
    for (let position = start; position < limit; ) {
      const length = Math.min(size, limit - position, this.remaining);
      if (length <= 0) throw new BudgetSpent();
      size = Math.min(size * 2, MAX_CHUNK_BYTES);
      yield await this.read(position, length);
      position += length;
    }
  }

  /** Complete lines ending before `end` (a line start), newest first. */
  async *linesBefore(
    end: number,
  ): AsyncGenerator<{ start: number; end: number; bytes: Buffer }> {
    let bufferStart = end;
    let buffer = Buffer.alloc(0);
    let size = FIRST_CHUNK_BYTES;
    // The newline that ends the next line to yield.
    let lineEnd = end - 1;
    while (lineEnd >= 0) {
      let newline = -1;
      for (;;) {
        const last = lineEnd - 1 - bufferStart;
        newline = last >= 0 ? buffer.lastIndexOf(10, last) : -1;
        if (newline >= 0 || bufferStart === 0) break;
        const length = Math.min(size, bufferStart, this.remaining);
        if (length <= 0) throw new BudgetSpent();
        size = Math.min(size * 2, MAX_CHUNK_BYTES);
        const block = await this.read(bufferStart - length, length);
        const keep = Math.max(
          0,
          Math.min(lineEnd - bufferStart, buffer.length),
        );
        buffer = Buffer.concat([block, buffer.subarray(0, keep)]);
        bufferStart -= length;
      }
      const lineStart = newline >= 0 ? bufferStart + newline + 1 : 0;
      yield {
        start: lineStart,
        end: lineEnd,
        bytes: buffer.subarray(lineStart - bufferStart, lineEnd - bufferStart),
      };
      lineEnd = lineStart - 1;
    }
  }

  /** Complete lines from `start` (a line start) up to `limit` (a line start). */
  async *linesFrom(start: number, limit: number): AsyncGenerator<Located> {
    for await (const line of antigravityLogLines(
      this.chunks(start, limit),
      start,
    ))
      yield { start: line.start, end: line.end, record: recordOf(line) };
  }

  /** The offset after the last newline: an unterminated tail is no record. */
  async completeEnd(): Promise<number> {
    let position = this.size;
    let size = FIRST_CHUNK_BYTES;
    while (position > 0) {
      const length = Math.min(size, position, this.remaining);
      if (length <= 0) throw new BudgetSpent();
      size = Math.min(size * 2, MAX_CHUNK_BYTES);
      const block = await this.read(position - length, length);
      position -= length;
      const newline = block.lastIndexOf(10);
      if (newline >= 0) return position + newline + 1;
    }
    return 0;
  }

  /** The first line starting in `[from, before)`, with its step, if any. */
  private async stepAtOrAfter(
    from: number,
    before: number,
  ): Promise<{ start: number; step: number } | undefined> {
    let position = from - 1;
    let size = FIRST_CHUNK_BYTES;
    let start: number | undefined;
    while (start === undefined && position < before - 1) {
      const length = Math.min(size, before - 1 - position, this.remaining);
      if (length <= 0) throw new BudgetSpent();
      size = Math.min(size * 2, MAX_CHUNK_BYTES);
      const newline = (await this.read(position, length)).indexOf(10);
      if (newline >= 0) start = position + newline + 1;
      position += length;
    }
    if (start === undefined || start >= before) return undefined;
    const prefix = await this.read(
      start,
      Math.min(STEP_PREFIX_BYTES, this.size - start),
    );
    const step = STEP_PREFIX.exec(prefix.toString("latin1"))?.[1];
    // Every observed record begins with its step_index; a search needs it.
    if (step === undefined)
      throw new UnknownLog("a record does not begin with its step_index");
    return { start, step: Number(step) };
  }

  /** The first record whose step is at least `step`, searching by halves. */
  async findStep(step: number, limit: number): Promise<Located | undefined> {
    let low = 0;
    let high = limit;
    while (high - low > SEARCH_LINEAR_BYTES) {
      const middle = low + Math.floor((high - low) / 2);
      const probe = await this.stepAtOrAfter(middle, high);
      if (!probe) high = middle;
      else if (probe.step < step) low = probe.start;
      else high = probe.start;
    }
    for await (const line of this.linesFrom(low, limit))
      if (line.record.step >= step) return line;
    return undefined;
  }
}

function recordOf(line: Pick<AntigravityLogLine, "text" | "invalidUtf8">) {
  if (line.invalidUtf8) throw new UnknownLog("a line is not valid UTF-8");
  if (!line.text) throw new UnknownLog("the log has an empty line");
  const record = parseAntigravityLogRecord(line.text);
  if ("unknown" in record) throw new UnknownLog(record.unknown);
  return record;
}

interface Page {
  /** Oldest first. */
  context: Located[];
  records: Located[];
  start: number;
}

/**
 * The records before `end`: back to the `compactions`-th checkpoint or the
 * file's start, or, once `pageBytes` is passed, to the oldest record read that
 * is not a tool result. Then the context: back to a record that is not a tool
 * result, the only kind that can own results at the page's start.
 */
async function pageBefore(
  source: LogSource,
  end: number,
  compactions: number,
  pageBytes: number,
): Promise<Page> {
  const lines = source.linesBefore(end);
  const newest: Located[] = [];
  let candidate = -1;
  let checkpoints = 0;
  let stop: number | undefined;
  let next = await lines.next();
  for (; !next.done; next = await lines.next()) {
    const line = next.value;
    if (end - line.start > pageBytes && candidate >= 0) {
      stop = candidate;
      break;
    }
    const record = recordOf(decodeAntigravityLogLine(line.bytes));
    newest.push({ start: line.start, end: line.end, record });
    if (record.type !== "GENERIC") candidate = newest.length - 1;
    if (record.type === "CHECKPOINT" && ++checkpoints === compactions) {
      stop = newest.length - 1;
      next = await lines.next();
      break;
    }
  }
  if (stop === undefined)
    return { context: [], records: newest.reverse(), start: 0 };
  const context = newest.splice(stop + 1);
  while (!context.some((line) => line.record.type !== "GENERIC")) {
    if (next.done) break;
    const line = next.value;
    context.push({
      start: line.start,
      end: line.end,
      record: recordOf(decodeAntigravityLogLine(line.bytes)),
    });
    next = await lines.next();
  }
  await lines.return(undefined);
  const records = newest.reverse();
  return { context: context.reverse(), records, start: records[0]!.start };
}

/** The context before a record: back to one that is not a tool result. */
async function contextBefore(
  source: LogSource,
  start: number,
): Promise<Located[]> {
  const context: Located[] = [];
  for await (const line of source.linesBefore(start)) {
    const record = recordOf(decodeAntigravityLogLine(line.bytes));
    context.push({ start: line.start, end: line.end, record });
    if (record.type !== "GENERIC") break;
  }
  return context.reverse();
}

type Read =
  | {
      status: "known";
      messages: Message[];
      omittedPrefix: boolean;
      anchor?: "found" | "missed";
      firstPrompt?: string;
    }
  | { status: "missing" }
  | { status: "unknown"; reason: string; error?: unknown };

class WindowRead {
  private end = 0;

  constructor(
    private readonly source: LogSource,
    private readonly conversationId: string,
    private readonly ownerLive: boolean,
    private readonly pageBytes: number,
  ) {}

  async run(request: AntigravityLogWindowRequest): Promise<Read> {
    const end = await this.source.completeEnd();
    this.end = end;
    if (end === 0) return { status: "missing" };
    switch (request.kind) {
      case "complete": {
        const projection = new AntigravityLogProjection(this.conversationId);
        for await (const line of this.source.linesFrom(0, end))
          projection.add(line.record);
        return this.finish(projection, { omittedPrefix: false });
      }
      case "latest":
        return this.latest(end, request.compactions);
      case "before":
        return this.before(end, request.messageId, request.compactions);
      case "after":
        return this.after(end, request.messageId, request.compactions);
    }
  }

  private finish(
    projection: AntigravityLogProjection,
    shape: { omittedPrefix: boolean; anchor?: "found" | "missed" },
    cut?: (messages: Message[]) => Message[] | undefined,
  ): Read {
    const result = projection.finish({ ownerLive: this.ownerLive });
    if (result.status === "unknown") return result;
    const messages = cut ? cut(result.messages) : result.messages;
    if (!messages) return this.missed();
    return { status: "known", messages, ...shape };
  }

  private missed(): Read {
    return {
      status: "known",
      messages: [],
      omittedPrefix: false,
      anchor: "missed",
    };
  }

  private project(page: Page): AntigravityLogProjection {
    const projection = new AntigravityLogProjection(this.conversationId);
    for (const line of page.context) projection.observe(line.record);
    for (const line of page.records) projection.add(line.record);
    return projection;
  }

  private async latest(end: number, compactions: number): Promise<Read> {
    let page = await pageBefore(this.source, end, compactions, this.pageBytes);
    for (;;) {
      const read = this.finish(this.project(page), {
        omittedPrefix: page.start > 0,
      });
      if (read.status !== "known" || read.messages.length || !page.start)
        return read;
      page = await this.extend(page, compactions);
    }
  }

  /**
   * Adds the page before a page that shows nothing, such as one holding only
   * reminders: the next page's cursor is its first message.
   */
  private async extend(page: Page, compactions: number): Promise<Page> {
    const older = await pageBefore(
      this.source,
      page.start,
      compactions,
      this.pageBytes,
    );
    return {
      context: older.context,
      records: [...older.records, ...page.records],
      start: older.start,
    };
  }

  private async locate(
    end: number,
    messageId: string,
  ): Promise<Located | undefined> {
    const step = antigravityMessageStep(this.conversationId, messageId);
    if (step === undefined) return undefined;
    const found = await this.source.findStep(step, end);
    return found?.record.step === step ? found : undefined;
  }

  /**
   * Records before the message's own record, then that record, cut before the
   * message: an ID inside a planner record or a tool group still ends the
   * page exactly there.
   */
  private async before(
    end: number,
    messageId: string,
    compactions: number,
  ): Promise<Read> {
    const anchor = await this.locate(end, messageId);
    if (!anchor) return this.missed();
    let page = await pageBefore(
      this.source,
      anchor.start,
      compactions,
      this.pageBytes,
    );
    // Records after the anchor that resolve a group the page left open.
    const ahead: Located[] = [];
    let resolved = false;
    for (;;) {
      const projection = this.project(page);
      projection.add(anchor.record);
      for (const line of ahead) projection.observe(line.record);
      if (projection.awaitingGroup && !resolved) {
        for await (const line of this.source.linesFrom(
          (ahead.at(-1) ?? anchor).end + 1,
          end,
        )) {
          ahead.push(line);
          projection.observe(line.record);
          if (!projection.awaitingGroup) break;
        }
        resolved = true;
      }
      const read = this.finish(
        projection,
        { omittedPrefix: page.start > 0, anchor: "found" },
        (messages) => {
          const index = messages.findIndex(
            (message) => message.uuid === messageId,
          );
          return index < 0 ? undefined : messages.slice(0, index);
        },
      );
      if (
        read.status !== "known" ||
        read.anchor === "missed" ||
        read.messages.length ||
        !page.start
      )
        return read;
      page = await this.extend(page, compactions);
    }
  }

  /** From the message's record to the end, if that fits one page. */
  private async after(
    end: number,
    messageId: string,
    compactions: number,
  ): Promise<Read> {
    const anchor = await this.locate(end, messageId);
    let context: Located[] = [];
    let start = anchor?.start;
    if (anchor?.record.type === "GENERIC") {
      // Start at the planner record that owns it.
      context = await contextBefore(this.source, anchor.start);
      start = context[0]?.start ?? 0;
      context = [];
    }
    if (start === undefined || end - start > this.pageBytes)
      return this.latestMissed(end, compactions);
    context = start > 0 ? await contextBefore(this.source, start) : [];
    const records: Located[] = [];
    for await (const line of this.source.linesFrom(start, end))
      records.push(line);
    const read = this.finish(this.project({ context, records, start }), {
      omittedPrefix: start > 0,
      anchor: "found",
    });
    if (
      read.status === "known" &&
      !read.messages.some((message) => message.uuid === messageId)
    )
      return this.latestMissed(end, compactions);
    return read;
  }

  private async latestMissed(end: number, compactions: number) {
    const read = await this.latest(end, compactions);
    return read.status === "known"
      ? { ...read, anchor: "missed" as const }
      : read;
  }

  /** The first prompt, from the file's first few records. */
  async firstPrompt(): Promise<string | undefined> {
    let seen = 0;
    for await (const line of this.source.linesFrom(0, this.end)) {
      if (line.record.type === "USER_INPUT") return line.record.text;
      if (++seen >= TITLE_RECORDS) break;
    }
    return undefined;
  }
}

function firstUserText(messages: readonly Message[]): string | undefined {
  for (const message of messages)
    if (message.type === "user" && typeof message.message?.content === "string")
      return message.message.content;
  return undefined;
}

/**
 * Reads one window of a conversation's log. A file replaced or truncated
 * while it is read (an append-only check of identity, head and end, as the
 * Claude and Codex readers use) is read again from scratch, at most three
 * times; then the log is unknown.
 */
export async function readAntigravityLogWindow(
  options: AntigravityLogWindowOptions,
): Promise<AntigravityLogWindow> {
  const budget =
    options.request.kind === "complete"
      ? Number.POSITIVE_INFINITY
      : (options.readBudget ?? ANTIGRAVITY_LOG_READ_BUDGET);
  let bytesRead = 0;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    const opened = await openPhysicalBrainTranscript(
      options.scope,
      options.conversationId,
      "transcript_full.jsonl",
    );
    if (opened.status === "missing") return { status: "missing", bytesRead };
    if (opened.status === "invalid")
      return {
        status: "unknown",
        reason: "the log is not a regular file inside the store",
        bytesRead,
      };
    const source = new LogSource(opened.handle, opened.size, budget);
    let read: Read | undefined;
    try {
      const fence = await captureTranscriptFence(source.probe, opened.path, {
        dev: opened.dev,
        ino: opened.ino,
        size: opened.size,
      });
      const window = new WindowRead(
        source,
        options.conversationId,
        options.ownerLive,
        options.pageBytes ?? ANTIGRAVITY_LOG_PAGE_BYTES,
      );
      try {
        read = await window.run(options.request);
        if (
          read.status === "known" &&
          options.request.kind !== "complete" &&
          read.anchor !== "missed"
        )
          read.firstPrompt = read.omittedPrefix
            ? await window.firstPrompt()
            : firstUserText(read.messages);
      } catch (error) {
        if (error instanceof UnknownLog)
          read = { status: "unknown", reason: error.message };
        else if (error instanceof BudgetSpent)
          read = {
            status: "unknown",
            reason: "the read budget was spent before the window resolved",
          };
        else if (!(error instanceof SourceChanged)) throw error;
      }
      await options.afterRead?.(attempt);
      const after = await stat(opened.path).catch(() => undefined);
      const unchanged =
        after &&
        (await isTranscriptPrefix(
          source.probe,
          opened.path,
          fence,
          after,
        ).catch(() => false));
      if (unchanged && read)
        return { ...read, bytesRead: bytesRead + source.bytesRead };
    } finally {
      bytesRead += source.bytesRead;
      await opened.handle.close().catch(() => {});
    }
  }
  return {
    status: "unknown",
    reason: "the log was replaced or truncated during every read",
    bytesRead,
  };
}
