import { stat } from "node:fs/promises";
import type { AntigravityLogBoundary } from "../sdk/providers/antigravity-owners.js";
import type { Message } from "../supervisor/types.js";
import {
  ANTIGRAVITY_LOG_RECORD_BYTES,
  type AntigravityLogHead,
  AntigravityLogProjection,
  type AntigravityLogRecord,
} from "./antigravity-log-projection.js";
import {
  ANTIGRAVITY_LOG_GROUP_RESULT_BYTES,
  isOversized,
  type LogLine,
  LogSource,
  lineLength,
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
 * end or from a message's record without reading the rest of the file
 * (topics/antigravity-native-storage.md#serving-cold-history--plan-195-step-4).
 * A page holds whole records and starts at a record that is not a tool
 * result. Lines are first found by their offsets; bodies are read once a
 * page has decided to show them. Reads never write and never start `agy`.
 * A record or tool group too large to hold is shown as a placeholder; only
 * malformed content and a file that keeps changing make the log unknown.
 */

/** A page's own bytes; the first record or tool group may extend past it. */
export const ANTIGRAVITY_LOG_PAGE_BYTES = 4 * 1024 * 1024;
const ATTEMPTS = 3;

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
      /** For a latest page: the last record it read to. */
      last?: AntigravityLogBoundary;
      bytesRead: number;
      /** The most line bytes the read held at once. */
      heldPeak: number;
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
  /**
   * Read the log as if it ended after this record: a resumed owner's
   * boundary. A log whose record there is not that step is unknown.
   */
  boundary?: AntigravityLogBoundary;
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
  /** Oldest first. */
  lines: LogLine[];
  start: number;
  cut?: AntigravityLogCut;
}

type Known = Extract<AntigravityLogWindow, { status: "known" }>;
type Read =
  | Omit<Known, "bytesRead" | "heldPeak">
  | { status: "missing" }
  | { status: "unknown"; reason: string; error?: unknown };

/** One line's part in a projection: shown, or only observed. */
interface Entry {
  line: LogLine;
  show: boolean;
}
const observe = (line: LogLine): Entry => ({ line, show: false });
const show = (line: LogLine): Entry => ({ line, show: true });

/** Enough of a record to observe it: observed records show nothing. */
function stub(head: AntigravityLogHead): AntigravityLogRecord {
  const base = { step: head.step, createdAt: head.createdAt ?? "" };
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
    default:
      throw new UnknownLog(`record type ${head.type} at step ${head.step}`);
  }
}

class WindowRead {
  private end = 0;

  constructor(
    private readonly source: LogSource,
    private readonly conversationId: string,
    private readonly ownerLive: boolean,
    private readonly pageBytes: number,
    private readonly boundary?: AntigravityLogBoundary,
  ) {}

  async run(request: AntigravityLogWindowRequest): Promise<Read> {
    this.end = await this.source.completeEnd();
    if (this.boundary) {
      const { step, end } = this.boundary;
      if (end > this.end)
        throw new UnknownLog("the log is shorter than its resume point");
      const newline = end > 0 ? await this.source.read(end - 1, 1) : undefined;
      const line =
        newline?.[0] === 10 ? await this.source.lineBefore(end) : undefined;
      if (!line || (await this.source.head(line)).step !== step)
        throw new UnknownLog("the log changed before its resume point");
      this.source.release(line);
      this.end = end;
    }
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

  firstPrompt(): Promise<string | undefined> {
    return this.source.firstPrompt(this.end);
  }

  /** The last record the window reads to. */
  async last(): Promise<AntigravityLogBoundary | undefined> {
    const line = await this.source.lineBefore(this.end);
    if (!line) return undefined;
    this.source.release(line);
    return { step: (await this.source.head(line)).step, end: this.end };
  }

  /**
   * Feeds entries to a projection in order, reading each body only now. A
   * result is a placeholder when its own size is over the record limit, or
   * when its group's results together are and it is larger than a small
   * result (so a short subagent result keeps its child link). Results after
   * a planner shown as a placeholder are covered by it. Observed records
   * need their step and type, a planner's calls and an error's text.
   */
  private async project(
    projection: AntigravityLogProjection,
    entries: Entry[],
  ): Promise<void> {
    const heads: AntigravityLogHead[] = [];
    for (const entry of entries) heads.push(await this.source.head(entry.line));
    const groupBytes: number[] = [];
    for (let index = 0; index < entries.length; ) {
      let last = index;
      let total = 0;
      while (last < entries.length && heads[last]!.type === "GENERIC")
        total += lineLength(entries[last++]!.line);
      for (; index < last; index++) groupBytes[index] = total;
      if (last === index) index++;
    }
    let covered = false;
    for (const [index, { line, show }] of entries.entries()) {
      const head = heads[index]!;
      let record: AntigravityLogRecord;
      if (head.type === "GENERIC") {
        const group = groupBytes[index]!;
        record =
          covered || !show
            ? stub(head)
            : group > ANTIGRAVITY_LOG_RECORD_BYTES &&
                lineLength(line) > ANTIGRAVITY_LOG_GROUP_RESULT_BYTES
              ? await this.source.record(line, group)
              : await this.source.record(line);
      } else {
        covered = head.type === "PLANNER_RESPONSE" && isOversized(line);
        record =
          (show && !(await this.source.isReminder(line))) ||
          head.type === "PLANNER_RESPONSE" ||
          head.type === "ERROR_MESSAGE"
            ? await this.source.record(line)
            : stub(head);
      }
      this.source.release(line);
      if (!(show ? projection.add(record) : projection.observe(record))) return;
    }
  }

  private finish(
    projection: AntigravityLogProjection,
    shape: Omit<Known, "status" | "messages" | "bytesRead" | "heldPeak">,
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

  /** Lets go of a found line's bytes when more than a page is held. */
  private bound(line: LogLine): void {
    if (this.source.held > this.pageBytes) this.source.release(line);
  }

  /** One tool group's lines at a time. */
  private async complete(): Promise<Read> {
    const projection = new AntigravityLogProjection(this.conversationId);
    let group: LogLine[] = [];
    for (let start = 0; start < this.end && !projection.unknown; ) {
      const line = await this.source.lineFrom(start, this.end);
      this.bound(line);
      start = line.end + 1;
      if ((await this.source.head(line)).type !== "GENERIC") {
        await this.project(projection, group.map(show));
        group = [];
      }
      group.push(line);
    }
    if (!projection.unknown) await this.project(projection, group.map(show));
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
    let page = await this.selectPage(end, compactions);
    let next = after;
    let at = cutAt;
    const anchor = cutAt ? { anchor: "found" as const } : {};
    for (;;) {
      const projection = new AntigravityLogProjection(this.conversationId);
      await this.project(projection, [...page.lines.map(show), ...next]);
      const cut = at;
      const read = this.finish(
        projection,
        {
          omittedPrefix: page.start > 0,
          ...(page.start > 0 && page.cut ? { cut: page.cut } : {}),
          ...anchor,
        },
        cut
          ? (messages) => {
              const index = messages.findIndex((m) => m.uuid === cut);
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
      at = undefined;
      page = await this.selectPage(page.start, compactions);
    }
  }

  /**
   * Lines before `end`, newest first: back to the `compactions`-th
   * checkpoint, the file's start, or the page budget, where a line that
   * does not fit is not even found. Once a record that is not a result has
   * been found, the page can start there, so nothing older is read for it.
   */
  private async selectPage(end: number, compactions: number): Promise<Page> {
    const newest: LogLine[] = [];
    let total = 0;
    let checkpoints = 0;
    let candidate = -1;
    let cut: AntigravityLogCut | undefined;
    for (let position = end; position > 0; ) {
      const line = await this.source.lineBefore(
        position,
        candidate >= 0 ? this.pageBytes - total : Number.POSITIVE_INFINITY,
      );
      if (!line) {
        cut = "bytes";
        break;
      }
      this.bound(line);
      newest.push(line);
      total += lineLength(line);
      position = line.start;
      const type = (await this.source.head(line)).type;
      if (type !== "GENERIC") candidate = newest.length - 1;
      if (type === "CHECKPOINT" && ++checkpoints === compactions) {
        cut = "compactions";
        break;
      }
    }
    if (cut)
      for (const line of newest.splice(candidate + 1))
        this.source.release(line);
    const lines = newest.reverse();
    return { lines, start: cut ? lines[0]!.start : 0, ...(cut ? { cut } : {}) };
  }

  private async locate(messageId: string): Promise<LogLine | undefined> {
    const step = antigravityMessageStep(this.conversationId, messageId);
    if (step === undefined) return undefined;
    const found = await this.source.findStep(step, this.end);
    if (found && (await this.source.head(found)).step === step) return found;
    if (found) this.source.release(found);
    return undefined;
  }

  /** Lines after `line` while they are results, then the one that is not. */
  private async ahead(line: LogLine): Promise<Entry[]> {
    const entries: Entry[] = [];
    for (let start = line.end + 1; start < this.end; ) {
      const next = await this.source.lineFrom(start, this.end);
      this.source.release(next);
      entries.push(observe(next));
      if ((await this.source.head(next)).type !== "GENERIC") break;
      start = next.end + 1;
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
    const type = (await this.source.head(anchor)).type;
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
    let start = anchor.start;
    let total = 0;
    for (
      let type = (await this.source.head(anchor)).type;
      type === "GENERIC";
    ) {
      const line = await this.source.lineBefore(start, this.pageBytes - total);
      if (!line) return missed();
      this.source.release(line);
      total += lineLength(line);
      start = line.start;
      type = (await this.source.head(line)).type;
    }
    // The page is the owner onward, counted once.
    total = 0;
    const lines: LogLine[] = [];
    for (let at = start; at < this.end; ) {
      const line = await this.source.lineFrom(at, this.end);
      this.bound(line);
      total += lineLength(line);
      if (total > this.pageBytes) return missed();
      lines.push(line);
      at = line.end + 1;
    }
    const projection = new AntigravityLogProjection(this.conversationId);
    await this.project(projection, lines.map(show));
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
}

function firstUserText(messages: readonly Message[]): string | undefined {
  for (const message of messages)
    if (message.type === "user" && typeof message.message?.content === "string")
      return message.message.content;
  return undefined;
}

/**
 * Reads one window of a conversation's log. Opening the file, taking its
 * source fence and reading are one attempt: a file replaced, truncated or
 * swapped during an attempt (the append-only check of identity, head and
 * end the Claude and Codex readers use) is read again from scratch, at most
 * three times; then the log is unknown. `bytesRead` counts every attempt.
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
      if (opened.status === "changed") continue;
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
        options.boundary,
      );
      let read: Read;
      try {
        read = await window.run(options.request);
        if (read.status === "known") {
          read.firstPrompt = read.omittedPrefix
            ? await window.firstPrompt()
            : firstUserText(read.messages);
          if (options.request.kind === "latest")
            read.last = await window.last();
        }
      } catch (error) {
        if (!(error instanceof UnknownLog)) throw error;
        read = { status: "unknown", reason: error.message };
      }
      await options.afterRead?.(attempt);
      const after = await stat(opened.path);
      if (await isTranscriptPrefix(source.probe, opened.path, fence, after)) {
        const total = bytesRead + source.bytesRead;
        const heldPeak = source.heldPeak;
        source = undefined;
        bytesRead = total;
        return read.status === "known"
          ? { ...read, bytesRead: total, heldPeak }
          : { ...read, bytesRead: total };
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

export type AntigravityResumePoint =
  | { status: "known"; boundary: AntigravityLogBoundary }
  | { status: "missing" }
  | { status: "unknown"; reason: string };

/**
 * Where a stopped conversation resumes from its log: its last complete
 * record, provided the latest page (what a viewer is shown first) reads as
 * known. A missing or unknown log has no resume point.
 */
export async function readAntigravityResumePoint(
  scope: string,
  conversationId: string,
): Promise<AntigravityResumePoint> {
  const window = await readAntigravityLogWindow({
    scope,
    conversationId,
    ownerLive: false,
    request: { kind: "latest", compactions: 2 },
  });
  if (window.status === "missing") return window;
  if (window.status === "unknown") return window;
  return window.last
    ? { status: "known", boundary: window.last }
    : { status: "unknown", reason: "the log has no last record" };
}
