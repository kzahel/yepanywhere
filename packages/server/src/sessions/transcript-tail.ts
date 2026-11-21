/**
 * Bounded latest-state point reads over append-only JSONL transcripts: the
 * shared primitive behind questions whose answer sits near the end of a
 * session, such as the hover card's latest agent excerpt. A read walks lines
 * backward from a fixed end byte and stops at a byte budget, so its cost
 * follows the answer's distance from the end rather than the session's length.
 * Running out of budget is an answer of its own ("unknown"), never a cue to
 * read the whole file. See topics/provider-history-facts.md.
 */
import { type FileHandle, open, stat } from "node:fs/promises";
import { SourceVersionedSingleFlight } from "../lib/sourceVersionedSingleFlight.js";

/** Bytes one latest-state point read may acquire before answering unknown. */
export const TRANSCRIPT_TAIL_POINT_BYTE_BUDGET = 4 * 1024 * 1024;
const FIRST_CHUNK_BYTES = 64 * 1024;
const MAX_CHUNK_BYTES = 1024 * 1024;

export interface BackwardLineBatch {
  /** Complete lines newly covered by this read, oldest first. */
  lines: string[];
  /** Byte offset of the oldest line in `lines`. */
  startByte: number;
  /** True when the batch begins at byte zero, so no older line exists. */
  reachedStart: boolean;
  /** Bytes read so far, including any carried partial line. */
  bytesRead: number;
}

/**
 * Yield complete lines before `endByte` newest batch first, reading at most
 * `maxBytes`. Chunks start small and double, so an answer in the last few
 * records costs a few kilobytes. A line straddling a chunk boundary is carried
 * until its start is read; a line longer than the remaining budget ends the
 * walk. A trailing line without a newline is yielded as-is: callers parse
 * leniently, so a record still being written simply fails to parse.
 */
export async function* readLinesBackwardFromHandle(
  handle: FileHandle,
  options: { endByte: number; maxBytes: number; label?: string },
): AsyncGenerator<BackwardLineBatch> {
  let position = options.endByte;
  let carried = Buffer.alloc(0);
  let bytesRead = 0;
  let chunkBytes = FIRST_CHUNK_BYTES;
  while (position > 0) {
    const length = Math.min(chunkBytes, position, options.maxBytes - bytesRead);
    if (length <= 0) return;
    chunkBytes = Math.min(chunkBytes * 2, MAX_CHUNK_BYTES);
    const start = position - length;
    const block = Buffer.alloc(length);
    let filled = 0;
    while (filled < length) {
      const { bytesRead: read } = await handle.read(
        block,
        filled,
        length - filled,
        start + filled,
      );
      if (read === 0) {
        throw new Error(
          `Transcript shrank during a backward read: ${options.label ?? "<handle>"}`,
        );
      }
      filled += read;
    }
    bytesRead += length;
    position = start;
    const combined =
      carried.length > 0 ? Buffer.concat([block, carried]) : block;
    // A chunk that starts mid-file opens mid-line; that fragment belongs to
    // the next (older) read.
    const firstNewline = start === 0 ? -1 : combined.indexOf(0x0a);
    if (start > 0 && firstNewline < 0) {
      carried = combined;
      continue;
    }
    const completeStart = firstNewline + 1;
    carried =
      start > 0
        ? Buffer.from(combined.subarray(0, firstNewline))
        : Buffer.alloc(0);
    const lines = combined
      .subarray(completeStart)
      .toString("utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0);
    // Match the forward readers, which drop a UTF-8 byte-order mark: left
    // on the first record it hides that record from the JSON parser.
    if (start === 0 && lines[0]?.startsWith("\uFEFF"))
      lines[0] = lines[0].slice(1);
    yield {
      lines,
      startByte: start + completeStart,
      reachedStart: start === 0,
      bytesRead,
    };
  }
}

export async function* readLinesBackward(
  filePath: string,
  options: { endByte: number; maxBytes: number },
): AsyncGenerator<BackwardLineBatch> {
  const handle = await open(filePath, "r");
  try {
    yield* readLinesBackwardFromHandle(handle, {
      ...options,
      label: filePath,
    });
  } finally {
    await handle.close();
  }
}

export interface TailPointQueryOptions<Value> {
  /** Distinguishes queries sharing one file; part of the single-flight key. */
  name: string;
  maxRetainedBytes: number;
  estimateBytes(value: Value): number;
  compute(filePath: string, size: number): Promise<Value>;
}

/**
 * One latest-state query per file version: concurrent callers observing the
 * same version share one read, and the accepted answer, including "unknown",
 * is retained until the file changes. Repeated hovers over a session whose
 * answer lies beyond the budget therefore do not rescan it.
 *
 * A file that changes while the read runs answers unknown. A fixed end byte
 * keeps an append consistent, but nothing here proves the change was an
 * append rather than a rewrite, whose chunks would mix two versions into an
 * answer neither of them gives.
 */
export function createTailPointQuery<Value>(
  options: TailPointQueryOptions<Value>,
): (filePath: string) => Promise<Value | undefined> {
  const flights = new SourceVersionedSingleFlight<string, Value>({
    maxRetainedBytes: options.maxRetainedBytes,
    estimateBytes: options.estimateBytes,
  });
  // Identity is part of the version: a replacement file at the same path
  // must not pass for the one the read started on.
  const version = (stats: Awaited<ReturnType<typeof stat>>) =>
    `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeMs}:${stats.ctimeMs}`;
  return async (filePath) => {
    const stats = await stat(filePath);
    const result = await flights.run({
      key: `${options.name}:${stats.dev}:${stats.ino}`,
      sourceVersion: version(stats),
      isCurrent: async (observed) => version(await stat(filePath)) === observed,
      compute: () => options.compute(filePath, Number(stats.size)),
    });
    return result.status === "stale" ? undefined : result.value;
  };
}
