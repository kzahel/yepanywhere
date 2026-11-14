import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import { open, stat } from "node:fs/promises";

const CHUNK_BYTES = 1024 * 1024;
const PROBE_BYTES = 1024;
export type TranscriptRangeRead = (
  path: string,
  start: number,
  length: number,
) => Promise<Buffer>;
export interface TranscriptAppendFence {
  dev: number;
  ino: number;
  size: number;
  head: Buffer;
  boundary: Buffer;
}
export interface TranscriptLineInfo {
  committed: boolean;
  byteLength: number;
}
export interface TranscriptRange<T> {
  entries: T[];
  /** Entries from newline-terminated records; the last entry may be provisional. */
  committedEntries: number;
  /** Always retained for replay, including when it is already valid JSON. */
  partialLine: Buffer;
  sourceBytes: number;
  lineCount: number;
  malformedLines: number;
  maxLineLength: number;
  readLinesMs: number;
  parseMs: number;
  /** The range ended inside a line that `maxLineBytes` is dropping. */
  dropping: boolean;
  appendFence?: TranscriptAppendFence;
}
/** Bounds for a reader that takes a source in batches rather than whole. */
export interface TranscriptRangeLimits {
  /** Bytes per read; the default suits a range read to its end. */
  chunkBytes?: number;
  /**
   * Stop after this many newline-terminated lines, parsed or dropped.
   * `sourceBytes` then ends after the last of them and no partial line is
   * returned.
   */
  maxLines?: number;
  /** A longer line is dropped without being buffered or parsed. */
  maxLineBytes?: number;
  /** The range starts inside a line an earlier range began dropping. */
  dropping?: boolean;
  /** Called once per dropped line, with the byte offset the line starts at. */
  dropped?(sourceByteOffset: number): void;
}

/** Shared byte/newline framing; provider schemas and projections stay in adapters.
 * Reads one chunk at a time plus the current line, never a whole-file buffer.
 * Offsets are UTF-8 source bytes, including BOM/CRLF, independent of decoding.
 */
export async function readTranscriptRange<T>(
  read: TranscriptRangeRead,
  filePath: string,
  start: number,
  length: number,
  parse: (
    line: string,
    sourceByteOffset: number,
    info: TranscriptLineInfo,
  ) => T | null,
  initialPartialLine: Buffer = Buffer.alloc(0),
  readStartedAt = Date.now(),
  limits: TranscriptRangeLimits = {},
): Promise<TranscriptRange<T>> {
  const chunkBytes = limits.chunkBytes ?? CHUNK_BYTES;
  const maxLineBytes = limits.maxLineBytes ?? Number.POSITIVE_INFINITY;
  const maxLines = limits.maxLines ?? Number.POSITIVE_INFINITY;
  let dropping = limits.dropping ?? false;
  const entries: T[] = [];
  let fragments: Buffer[] = initialPartialLine.length
    ? [initialPartialLine]
    : [];
  let fragmentBytes = initialPartialLine.length;
  let lineOffset = start - fragmentBytes;
  let lineCount = 0,
    maxLineLength = 0,
    malformedLines = 0,
    parseMs = 0;
  const consume = (bytes: Buffer, committed = true) => {
    const began = Date.now();
    const line = bytes.toString("utf8");
    lineCount++;
    maxLineLength = Math.max(maxLineLength, line.length);
    if (line.trim()) {
      try {
        const entry = parse(line.trim(), lineOffset, {
          committed,
          byteLength: bytes.length,
        });
        if (entry !== null) entries.push(entry);
        else if (committed) malformedLines++;
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        if (committed) malformedLines++;
      }
    }
    parseMs += Date.now() - began;
  };
  let consumed = 0;
  // `fragmentBytes` counts the open line's bytes whether or not they are
  // buffered, so a dropped line still advances `lineOffset` by its length.
  chunks: while (consumed < length) {
    const amount = Math.min(chunkBytes, length - consumed);
    const block = await read(filePath, start + consumed, amount);
    if (block.length !== amount)
      throw new Error("Transcript changed during range read");
    consumed += block.length;
    let from = 0;
    for (;;) {
      const newline = block.indexOf(0x0a, from);
      if (newline < 0) break;
      const segment = block.subarray(from, newline);
      const lineBytes = fragmentBytes + segment.length;
      if (dropping) {
        dropping = false;
        lineCount++;
      } else if (lineBytes > maxLineBytes) {
        limits.dropped?.(lineOffset);
        lineCount++;
      } else
        consume(
          fragments.length
            ? Buffer.concat([...fragments, segment], lineBytes)
            : segment,
        );
      lineOffset += lineBytes + 1;
      fragments = [];
      fragmentBytes = 0;
      from = newline + 1;
      if (lineCount >= maxLines) {
        consumed = lineOffset - start;
        break chunks;
      }
    }
    if (from < block.length) {
      const rest = block.length - from;
      if (!dropping && fragmentBytes + rest > maxLineBytes) {
        limits.dropped?.(lineOffset);
        dropping = true;
        fragments = [];
      }
      if (!dropping) fragments.push(Buffer.from(block.subarray(from)));
      fragmentBytes += rest;
    }
  }
  const partialLine = fragments.length
    ? Buffer.concat(fragments, fragmentBytes)
    : Buffer.alloc(0);
  const committedEntries = entries.length;
  if (partialLine.length) consume(partialLine, false);
  return {
    entries,
    committedEntries,
    partialLine,
    sourceBytes: consumed,
    lineCount,
    malformedLines,
    maxLineLength,
    parseMs,
    readLinesMs: Math.max(0, Date.now() - readStartedAt - parseMs),
    dropping,
  };
}

/** A file read owns one descriptor and releases it on success, failure or parse error. */
export async function readTranscriptFile<T>(
  filePath: string,
  start: number,
  length: number,
  parse: (
    line: string,
    sourceByteOffset: number,
    info: TranscriptLineInfo,
  ) => T | null,
  previous?: TranscriptAppendFence,
): Promise<TranscriptRange<T>> {
  try {
    const handle = await open(filePath, "r");
    try {
      const identity = await handle.stat();
      const result = await readObservedTranscriptRange(
        async (_path, offset, amount) => {
          const buffer = Buffer.allocUnsafe(amount);
          let filled = 0;
          while (filled < amount) {
            const { bytesRead } = await handle.read(
              buffer,
              filled,
              amount - filled,
              offset + filled,
            );
            if (!bytesRead) break;
            filled += bytesRead;
          }
          return buffer.subarray(0, filled);
        },
        filePath,
        start,
        length,
        parse,
        Buffer.alloc(0),
        Date.now(),
        previous,
      );
      const after = await stat(filePath);
      if (identity.dev !== after.dev || identity.ino !== after.ino)
        throw previous
          ? new TranscriptAppendMismatchError(
              "Transcript changed during append read",
            )
          : new Error("Transcript changed during range read");
      return result;
    } finally {
      await handle.close();
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (previous && (code === "ENOENT" || code === "ENOTDIR")) {
      throw new TranscriptAppendMismatchError(
        "Transcript disappeared during append read",
        { cause: error },
      );
    }
    throw error;
  }
}

/** Fixed-size source evidence; no descriptor, timer, provider row or filename retained. */
export async function captureTranscriptFence(
  read: TranscriptRangeRead,
  filePath: string,
  stats: Pick<Stats, "dev" | "ino" | "size">,
): Promise<TranscriptAppendFence> {
  return {
    dev: stats.dev,
    ino: stats.ino,
    size: stats.size,
    head: await read(filePath, 0, Math.min(PROBE_BYTES, stats.size)),
    boundary: await read(
      filePath,
      Math.max(0, stats.size - PROBE_BYTES),
      Math.min(PROBE_BYTES, stats.size),
    ),
  };
}
/** A fence small enough to persist or round-trip: probe digests, not probe bytes. */
export interface TranscriptFenceDigest {
  dev: number;
  ino: number;
  size: number;
  head: string;
  boundary: string;
}
export function digestTranscriptFence(
  fence: TranscriptAppendFence,
): TranscriptFenceDigest {
  const digest = (probe: Buffer) =>
    createHash("sha256").update(probe).digest("base64");
  return {
    dev: fence.dev,
    ino: fence.ino,
    size: fence.size,
    head: digest(fence.head),
    boundary: digest(fence.boundary),
  };
}
/** `isTranscriptPrefix` for a digest: the same probes, compared by hash. */
export async function isTranscriptPrefixOfDigest(
  read: TranscriptRangeRead,
  filePath: string,
  previous: TranscriptFenceDigest,
  next: Pick<Stats, "dev" | "ino" | "size">,
): Promise<boolean> {
  if (
    previous.dev !== next.dev ||
    previous.ino !== next.ino ||
    next.size < previous.size
  )
    return false;
  const current = digestTranscriptFence(
    await captureTranscriptFence(read, filePath, {
      dev: next.dev,
      ino: next.ino,
      size: previous.size,
    }),
  );
  return (
    current.head === previous.head && current.boundary === previous.boundary
  );
}
export async function readObservedTranscriptRange<T>(
  read: TranscriptRangeRead,
  filePath: string,
  start: number,
  length: number,
  parse: (line: string, offset: number, info: TranscriptLineInfo) => T | null,
  initialPartialLine: Buffer = Buffer.alloc(0),
  readStartedAt = Date.now(),
  previous?: TranscriptAppendFence,
): Promise<TranscriptRange<T>> {
  const end = start + length;
  try {
    const before = await stat(filePath);
    if (
      previous &&
      !(await isTranscriptPrefix(read, filePath, previous, before))
    )
      throw new TranscriptAppendMismatchError(
        "Transcript prefix changed before append read",
      );
    if (before.size < end)
      throw new Error("Transcript changed during range read");
    const fence = await captureTranscriptFence(read, filePath, {
      ...before,
      size: end,
    });
    const parsed = await readTranscriptRange(
      read,
      filePath,
      start,
      length,
      parse,
      initialPartialLine,
      readStartedAt,
    );
    const after = await stat(filePath);
    if (
      previous &&
      !(await isTranscriptPrefix(read, filePath, previous, after))
    )
      throw new TranscriptAppendMismatchError(
        "Transcript prefix changed during append read",
      );
    if (!(await isTranscriptPrefix(read, filePath, fence, after)))
      throw previous
        ? new TranscriptAppendMismatchError(
            "Transcript changed during append read",
          )
        : new Error("Transcript changed during range read");
    return { ...parsed, appendFence: fence };
  } catch (error) {
    if (previous && !(error instanceof TranscriptAppendMismatchError)) {
      const current = await stat(filePath).catch(() => null);
      if (
        !current ||
        current.size < end ||
        !(await isTranscriptPrefix(read, filePath, previous, current).catch(
          () => false,
        ))
      )
        throw new TranscriptAppendMismatchError(
          "Transcript changed during append acquisition",
          { cause: error },
        );
    }
    throw error;
  }
}

export async function isTranscriptPrefix(
  read: TranscriptRangeRead,
  filePath: string,
  previous: TranscriptAppendFence,
  next: Pick<Stats, "dev" | "ino" | "size">,
): Promise<boolean> {
  if (
    previous.dev !== next.dev ||
    previous.ino !== next.ino ||
    next.size < previous.size
  )
    return false;
  const head = await read(filePath, 0, previous.head.length);
  const boundary = await read(
    filePath,
    previous.size - previous.boundary.length,
    previous.boundary.length,
  );
  return head.equals(previous.head) && boundary.equals(previous.boundary);
}
export async function isTranscriptAppend(
  read: TranscriptRangeRead,
  filePath: string,
  previous: TranscriptAppendFence,
  next: Pick<Stats, "dev" | "ino" | "size">,
): Promise<boolean> {
  if (
    previous.dev !== next.dev ||
    previous.ino !== next.ino ||
    next.size <= previous.size
  )
    return false;
  return isTranscriptPrefix(read, filePath, previous, next);
}

/** The caller's accepted prefix is no longer a prefix of this source. */
export class TranscriptAppendMismatchError extends Error {}
