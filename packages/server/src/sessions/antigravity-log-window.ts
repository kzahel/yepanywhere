import { stat } from "node:fs/promises";
import type { Message } from "../supervisor/types.js";
import {
  AntigravityLogProjection,
  type AntigravityLogRecord,
} from "./antigravity-log-projection.js";
import {
  ANTIGRAVITY_LOG_RECORD_BYTES,
  isOversized,
  type LineHead,
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
 * Pages of `agy`'s brain log (`transcript_full.jsonl`), read from the file's
 * end or from a message's record without reading the rest of the file. A page
 * holds whole records, starts at a record that is not a tool result, and is
 * projected with the context the tool-group rule needs
 * (topics/antigravity-native-storage.md#serving-cold-history--plan-195-step-4).
 * Reads never write and never start `agy`. A record or tool group too large
 * to show is a placeholder, never a reason to fall back; only malformed
 * content and a file that keeps changing make the log unknown.
 */

/** A page's own records; one record or tool group may extend past it. */
export const ANTIGRAVITY_LOG_PAGE_BYTES = 4 * 1024 * 1024;
const ATTEMPTS = 3;
/** Records looked at from the file's start for the conversation's first prompt. */
const TITLE_RECORDS = 4;

export type AntigravityLogWindowRequest =
  /** The newest records: back to the `compactions`-th checkpoint, within the page budget. */
  | { kind: "latest"; compactions: number }
  /** The page before a message, chosen the same way. */
  | { kind: "before"; messageId: string; compactions: number }
  /** From a message to the end, when that fits a page; else the latest page. */
  | { kind: "after"; messageId: string; compactions: number }
  /** The whole log: a deliberate complete read. */
  | { kind: "complete" };

/** Why a page omitted earlier records. */
export type AntigravityLogCut = "compactions" | "bytes";

export type AntigravityLogWindow =
  | {
      status: "known";
      messages: Message[];
      /** Records before the page exist. */
      omittedPrefix: boolean;
      /** What ended the page, when it omitted earlier records. */
      cut?: AntigravityLogCut;
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
  /** Tests: runs after an attempt's reads, before its source check. */
  afterRead?: (attempt: number) => Promise<void> | void;
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

interface Page {
  /** Oldest first: observed, from the last record that is not a result. */
  context: LogLine[];
  /** Oldest first: projected. */
  lines: LogLine[];
  start: number;
  cut?: AntigravityLogCut;
}

type Known = Extract<AntigravityLogWindow, { status: "known" }>;
type Read =
  | Omit<Known, "bytesRead">
  | { status: "missing" }
  | { status: "unknown"; reason: string; error?: unknown };

/** One line's part in a projection. */
interface Entry {
  line: LogLine;
  project: boolean;
}

const observe = (line: LogLine): Entry => ({ line, project: false });
const show = (line: LogLine): Entry => ({ line, project: true });
const length = (line: LogLine) => line.end - line.start;
/** A placeholder is small whatever its record's size. */
const weight = (line: LogLine) => (isOversized(line) ? 0 : length(line));

/** Enough of a record to observe it: observed records project nothing. */
function stub(head: LineHead): AntigravityLogRecord {
  const base = { step: head.step, createdAt: head.createdAt };
  switch (head.type) {
    case "USER_INPUT":
      return { ...base, type: "USER_INPUT", text: "" };
    case "GENERIC":
      return {
        ...base,
        type: "GENERIC",
        status:
          head.status === "ERROR" || head.status === "RUNNING"
            ? head.status
            : "DONE",
        content: "",
      };
    case "SYSTEM_MESSAGE":
      return { ...base, type: "SYSTEM_MESSAGE", content: "" };
    case "CHECKPOINT":
      return { ...base, type: "CHECKPOINT", content: "" };
    case "ERROR_MESSAGE":
      return { ...base, type: "ERROR_MESSAGE", error: "" };
    default:
      throw new UnknownLog(`record type ${head.type} at step ${head.step}`);
  }
}

/** Lines read backward, some of which can be put back to be read again. */
class Backward {
  /** Newest first. */
  private readonly returned: LogLine[] = [];
  constructor(private readonly lines: AsyncGenerator<LogLine>) {}

  async next(): Promise<LogLine | undefined> {
    const returned = this.returned.shift();
    if (returned) return returned;
    const next = await this.lines.next();
    return next.done ? undefined : next.value;
  }

  /** Puts lines back, newest first, ahead of any not yet read. */
  unread(lines: LogLine[]): void {
    this.returned.unshift(...lines);
  }
}

class WindowRead {
  private end = 0;

  constructor(
    private readonly source: LogSource,
    private readonly conversationId: string,
    private readonly ownerLive: boolean,
    private readonly pageBytes: number,
  ) {}

  async run(request: AntigravityLogWindowRequest): Promise<Read> {
    this.end = await this.source.completeEnd();
    if (this.end === 0) return { status: "missing" };
    switch (request.kind) {
      case "complete":
        return this.complete();
      case "latest":
        return this.pageBefore(this.end, request.compactions, []);
      case "before":
        return this.before(request.messageId, request.compactions);
      case "after":
        return this.after(request.messageId, request.compactions);
    }
  }

  private head(line: LogLine): Promise<LineHead> {
    return this.source.head(line);
  }

  /**
   * Feeds entries to a projection in order. A result is shown in full when
   * its group's results together fit the record limit, else as a
   * placeholder. Observed records need only their step and type, and a
   * planner's calls.
   */
  private async projectInto(
    projection: AntigravityLogProjection,
    entries: Entry[],
  ): Promise<void> {
    const heads: LineHead[] = [];
    for (const entry of entries) heads.push(await this.head(entry.line));
    const group: number[] = [];
    for (let index = 0; index < entries.length; ) {
      if (heads[index]!.type !== "GENERIC") {
        index++;
        continue;
      }
      let last = index;
      let total = 0;
      while (last < entries.length && heads[last]!.type === "GENERIC")
        total += length(entries[last++]!.line);
      for (; index < last; index++) group[index] = total;
    }
    for (const [index, { line, project }] of entries.entries()) {
      const head = heads[index]!;
      let record: AntigravityLogRecord;
      if (!project && head.type !== "PLANNER_RESPONSE") record = stub(head);
      else if (
        head.type === "GENERIC" &&
        group[index]! > ANTIGRAVITY_LOG_RECORD_BYTES
      )
        record = await this.source.groupPlaceholder(line, group[index]!);
      else record = await this.source.record(line);
      if (!(project ? projection.add(record) : projection.observe(record)))
        return;
    }
  }

  private finish(
    projection: AntigravityLogProjection,
    shape: Omit<Known, "status" | "messages" | "bytesRead">,
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

  /** Holds one tool group's lines at a time, without bytes once too large. */
  private async complete(): Promise<Read> {
    const projection = new AntigravityLogProjection(this.conversationId);
    let group: LogLine[] = [];
    let results = 0;
    for await (const line of this.source.linesFrom(0, this.end)) {
      if ((await this.head(line)).type === "GENERIC") {
        results += length(line);
        if (results > ANTIGRAVITY_LOG_RECORD_BYTES)
          for (const held of group.slice(1)) delete held.bytes;
      } else {
        await this.projectInto(projection, group.map(show));
        if (projection.unknown) break;
        group = [];
        results = 0;
      }
      if (results > ANTIGRAVITY_LOG_RECORD_BYTES) delete line.bytes;
      group.push(line);
    }
    if (!projection.unknown)
      await this.projectInto(projection, group.map(show));
    return this.finish(projection, { omittedPrefix: false });
  }

  /**
   * The page before `end`, extended past pages that show nothing (only
   * reminders, say): the next page's cursor is a page's first message.
   */
  private async pageBefore(
    end: number,
    compactions: number,
    after: Entry[],
    cutAt?: string,
  ): Promise<Read> {
    const cursor = new Backward(this.source.linesBefore(end));
    let page = await this.selectPage(cursor, compactions);
    let next = after;
    const anchor = cutAt ? { anchor: "found" as const } : {};
    for (;;) {
      const projection = new AntigravityLogProjection(this.conversationId);
      await this.projectInto(projection, [
        ...page.context.map(observe),
        ...page.lines.map(show),
        ...next,
      ]);
      const at = cutAt;
      const read = this.finish(
        projection,
        {
          omittedPrefix: page.start > 0,
          ...(page.start > 0 && page.cut ? { cut: page.cut } : {}),
          ...anchor,
        },
        at
          ? (messages) => {
              const index = messages.findIndex((m) => m.uuid === at);
              return index < 0 ? undefined : messages.slice(0, index);
            }
          : undefined,
      );
      if (
        read.status !== "known" ||
        read.anchor === "missed" ||
        read.messages.length ||
        !page.start
      )
        return read;
      next = [observe(page.lines[0]!)];
      cutAt = undefined;
      page = await this.selectPage(cursor, compactions);
    }
  }

  /**
   * Lines before the cursor: back to the `compactions`-th checkpoint, the
   * file's start, or the page budget, backed off to the oldest line read
   * that is not a tool result. Then back to the last line that is not a
   * result, as context; those lines are returned to the cursor, so the page
   * before this one starts from them without reading them again. Results
   * held beyond the record limit keep only their bounds.
   */
  private async selectPage(
    cursor: Backward,
    compactions: number,
  ): Promise<Page> {
    const newest: LogLine[] = [];
    let candidate = -1;
    let checkpoints = 0;
    let total = 0;
    let results: LogLine[] = [];
    let resultBytes = 0;
    let stop: number | undefined;
    let cut: AntigravityLogCut | undefined;
    for (let line = await cursor.next(); line; line = await cursor.next()) {
      const head = await this.head(line);
      if (total + weight(line) > this.pageBytes && candidate >= 0) {
        cursor.unread([line]);
        stop = candidate;
        cut = "bytes";
        break;
      }
      total += weight(line);
      newest.push(line);
      if (head.type === "GENERIC") {
        results.push(line);
        resultBytes += length(line);
        if (resultBytes > ANTIGRAVITY_LOG_RECORD_BYTES)
          for (const held of results) delete held.bytes;
        continue;
      }
      results = [];
      resultBytes = 0;
      candidate = newest.length - 1;
      if (head.type === "CHECKPOINT" && ++checkpoints === compactions) {
        stop = candidate;
        cut = "compactions";
        break;
      }
    }
    if (stop === undefined)
      return { context: [], lines: newest.reverse(), start: 0 };
    // Newest first, as read.
    const context = newest.splice(stop + 1);
    cursor.unread(context);
    const owner: LogLine[] = [];
    for (let line = await cursor.next(); line; line = await cursor.next()) {
      owner.push(line);
      if ((await this.head(line)).type !== "GENERIC") break;
    }
    cursor.unread(owner);
    const page = newest.reverse();
    return {
      context: owner.reverse(),
      lines: page,
      start: page[0]!.start,
      cut,
    };
  }

  private async locate(messageId: string): Promise<LogLine | undefined> {
    const step = antigravityMessageStep(this.conversationId, messageId);
    if (step === undefined) return undefined;
    const found = await this.source.findStep(step, this.end);
    return found && (await this.head(found)).step === step ? found : undefined;
  }

  /** Lines after `line` while they are results, then the one that is not. */
  private async ahead(line: LogLine): Promise<Entry[]> {
    const entries: Entry[] = [];
    for await (const next of this.source.linesFrom(line.end + 1, this.end)) {
      delete next.bytes;
      entries.push(observe(next));
      if ((await this.head(next)).type !== "GENERIC") break;
    }
    return entries;
  }

  /**
   * Records before the message's own record, then that record, cut before
   * the message: an ID inside a planner record or a tool group still ends
   * the page exactly there.
   */
  private async before(messageId: string, compactions: number): Promise<Read> {
    const anchor = await this.locate(messageId);
    if (!anchor) return this.missed();
    const type = (await this.head(anchor)).type;
    const after: Entry[] = [
      show(anchor),
      // A planner's calls and error, and a result's group, resolve after it.
      ...(type === "GENERIC" || type === "PLANNER_RESPONSE"
        ? await this.ahead(anchor)
        : []),
    ];
    return this.pageBefore(anchor.start, compactions, after, messageId);
  }

  /** From the message's record to the end, if that fits one page. */
  private async after(messageId: string, compactions: number): Promise<Read> {
    const missed = async (): Promise<Read> => {
      const read = await this.pageBefore(this.end, compactions, []);
      return read.status === "known" ? { ...read, anchor: "missed" } : read;
    };
    const anchor = await this.locate(messageId);
    if (!anchor) return missed();
    // A result starts the page at the record that owns it.
    const owner =
      (await this.head(anchor)).type === "GENERIC"
        ? await this.contextBefore(anchor.start)
        : [];
    const start = owner[0]?.start ?? anchor.start;
    const lines: LogLine[] = [];
    let total = 0;
    for await (const line of this.source.linesFrom(start, this.end)) {
      total += weight(line);
      if (total > this.pageBytes) return missed();
      lines.push(line);
    }
    const context = start > 0 ? await this.contextBefore(start) : [];
    const projection = new AntigravityLogProjection(this.conversationId);
    await this.projectInto(projection, [
      ...context.map(observe),
      ...lines.map(show),
    ]);
    const read = this.finish(projection, {
      omittedPrefix: start > 0,
      anchor: "found",
    });
    if (
      read.status === "known" &&
      !read.messages.some((message) => message.uuid === messageId)
    )
      return missed();
    return read;
  }

  /** Lines before `start`, oldest first, from the last that is not a result. */
  private async contextBefore(start: number): Promise<LogLine[]> {
    const context: LogLine[] = [];
    for await (const line of this.source.linesBefore(start)) {
      context.push(line);
      if ((await this.head(line)).type !== "GENERIC") break;
      delete line.bytes;
    }
    return context.reverse();
  }

  /** The first prompt, from the file's first few records. */
  async firstPrompt(): Promise<string | undefined> {
    let seen = 0;
    for await (const line of this.source.linesFrom(0, this.end)) {
      if ((await this.head(line)).type === "USER_INPUT") {
        if (isOversized(line)) return undefined;
        const record = await this.source.record(line);
        return record.type === "USER_INPUT" ? record.text : undefined;
      }
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
 * Reads one window of a conversation's log. Opening the file, taking its
 * source fence and reading are one attempt: a file replaced or truncated
 * during an attempt (the append-only check of identity, head and end the
 * Claude and Codex readers use) is read again from scratch, at most three
 * times; then the log is unknown. `bytesRead` counts every attempt.
 */
export async function readAntigravityLogWindow(
  options: AntigravityLogWindowOptions,
): Promise<AntigravityLogWindow> {
  let bytesRead = 0;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    let source: LogSource | undefined;
    let close: (() => Promise<void>) | undefined;
    try {
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
      close = () => opened.handle.close().catch(() => {});
      source = new LogSource(opened.handle, opened.size);
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
      let read: Read;
      try {
        read = await window.run(options.request);
        if (read.status === "known")
          read.firstPrompt = read.omittedPrefix
            ? await window.firstPrompt()
            : firstUserText(read.messages);
      } catch (error) {
        if (!(error instanceof UnknownLog)) throw error;
        read = { status: "unknown", reason: error.message };
      }
      await options.afterRead?.(attempt);
      const after = await stat(opened.path);
      if (await isTranscriptPrefix(source.probe, opened.path, fence, after)) {
        bytesRead += source.bytesRead;
        source = undefined;
        return { ...read, bytesRead };
      }
    } catch (error) {
      // A file that shrank, vanished or was replaced mid-attempt is read again.
      const code = (error as NodeJS.ErrnoException)?.code;
      if (!(error instanceof SourceChanged) && code !== "ENOENT") throw error;
    } finally {
      bytesRead += source?.bytesRead ?? 0;
      await close?.();
    }
  }
  return {
    status: "unknown",
    reason: "the log was replaced or truncated during every read",
    bytesRead,
  };
}
