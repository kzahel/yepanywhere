import type { Stats } from "node:fs";
import { stat } from "node:fs/promises";
import {
  captureTranscriptFence,
  digestTranscriptFence,
  isTranscriptPrefix,
  isTranscriptPrefixOfDigest,
  readObservedTranscriptRange,
  type TranscriptAppendFence,
  type TranscriptFenceDigest,
} from "./transcript-ingestion.js";
import type { CodexSessionEntry } from "@yep-anywhere/shared";
import { parseCodexSessionEntry } from "@yep-anywhere/shared";
import {
  getCodexRolloutActivityTimeMs,
  isCompressedCodexRolloutPath,
} from "../utils/codexRolloutFiles.js";
import {
  parseCodexSourceByteCursor,
  tagCodexEntrySourceByteOffset,
} from "./normalization.js";

const READ_CHUNK_BYTES = 1024 * 1024;
const ESTIMATED_BYTES_PER_COMPACT_BOUNDARY = 2 * 1024 * 1024;
const MAX_REMEMBERED_ROLLOUTS = 256;
const MAX_REMEMBERED_BOUNDARIES = 64;

export interface CodexRolloutStats {
  size: number | bigint;
  mtimeMs: number | bigint;
  ctimeMs: number | bigint;
  /** Without file identity the boundary memo is not used. */
  dev?: number | bigint;
  ino?: number | bigint;
}

/**
 * Every `compacted` record start in a rollout's settled prefix, remembered so a
 * later request scans only what was appended. The fence and stat version are
 * the append cache's evidence that the file has only grown.
 */
interface CompactBoundaryMemo {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  fence: TranscriptFenceDigest;
  /** End of the last newline-terminated line scanned; earlier lines are final. */
  settledEnd: number;
  /** Record starts below `settledEnd`, newest first. */
  settled: number[];
  /** A valid unterminated final record counted at `size`, if any. */
  provisional: number[];
}

interface CompactBoundaryScan {
  /** Record starts, newest first, at most the requested limit. */
  starts: number[];
  reachedFloor: boolean;
  settledEnd: number;
}

export interface CodexParsedEntrySnapshot {
  entries: CodexSessionEntry[];
  partialLine: Buffer;
  readLinesMs: number;
  parseMs: number;
  lineCount: number;
  maxLineLength: number;
  /** Decoded JSONL bytes the entries were parsed from. */
  sourceBytes: number;
  nextLeafOrdinal?: number;
  leafStartOrdinal?: number;
  committedEntries?: number;
  appendFence?: TranscriptAppendFence;
}

interface CodexEntrySnapshot {
  entries: CodexSessionEntry[];
  transcriptSnapshotUpdatedAt: string;
}

export interface CodexCompactTailSnapshot extends CodexEntrySnapshot {
  kind: "compact-tail";
  omittedPrefix: true;
  startByte: number;
  compactBoundaries: number;
}

export interface CodexCompactPageSnapshot extends CodexEntrySnapshot {
  kind: "compact-page";
  omittedPrefix: boolean;
  startByte: number;
  endByte: number;
  compactBoundaries: number;
}

export type CodexCompactWindowSnapshot =
  | CodexCompactTailSnapshot
  | CodexCompactPageSnapshot;

export type ReadExactCodexRolloutRange = (
  filePath: string,
  start: number,
  length: number,
) => Promise<Buffer>;

export class CodexRolloutWindowReader {
  /** Insertion order is recency: a hit moves its rollout to the end. */
  private readonly boundaryMemos = new Map<string, CompactBoundaryMemo>();

  constructor(private readonly readExactRange: ReadExactCodexRolloutRange) {}

  async readEntryRange(
    filePath: string,
    start: number,
    length: number,
    readStartedAt = Date.now(),
    initialPartialLine: Buffer = Buffer.alloc(0),
    previous?: TranscriptAppendFence,
  ): Promise<CodexParsedEntrySnapshot> {
    return readObservedTranscriptRange(
      this.readExactRange,
      filePath,
      start,
      length,
      (line, offset) => {
        const entry = parseCodexSessionEntry(line);
        return entry ? tagCodexEntrySourceByteOffset(entry, offset) : null;
      },
      initialPartialLine,
      readStartedAt,
      previous,
    );
  }

  async readCompactTailSnapshot(
    filePath: string,
    stats: CodexRolloutStats,
    compactBoundaries: number,
  ): Promise<CodexCompactTailSnapshot | null> {
    const startByte = await this.findCompactTailStart(
      filePath,
      stats,
      compactBoundaries,
    );
    if (startByte === null) return null;
    const parsed = await this.readEntryRange(
      filePath,
      startByte,
      Number(stats.size) - startByte,
    );
    if (parsed.entries[0]?.type !== "compacted") return null;

    return {
      entries: parsed.entries,
      transcriptSnapshotUpdatedAt: new Date(
        getCodexRolloutActivityTimeMs(filePath, stats),
      ).toISOString(),
      kind: "compact-tail",
      omittedPrefix: true,
      startByte,
      compactBoundaries,
    };
  }

  async findCompactTailStart(
    filePath: string,
    stats: CodexRolloutStats,
    compactBoundaries: number,
  ): Promise<number | null> {
    const fileSize = Number(stats.size);
    if (
      isCompressedCodexRolloutPath(filePath) ||
      fileSize <= ESTIMATED_BYTES_PER_COMPACT_BOUNDARY * compactBoundaries
    ) {
      return null;
    }

    const starts = await this.findCompactStarts(
      filePath,
      stats,
      compactBoundaries,
    );
    const startByte = starts[compactBoundaries - 1];
    return startByte === undefined || startByte <= 0 ? null : startByte;
  }

  /**
   * Newest-first record starts: at least `limit` when the file has them, else
   * all of them. Equal to a full backward scan; a remembered settled prefix
   * replaces rescanning it while the file has only been appended to.
   */
  private async findCompactStarts(
    filePath: string,
    stats: CodexRolloutStats,
    limit: number,
  ): Promise<number[]> {
    const size = Number(stats.size);
    const version =
      stats.dev === undefined || stats.ino === undefined
        ? null
        : {
            dev: Number(stats.dev),
            ino: Number(stats.ino),
            size,
            mtimeMs: Number(stats.mtimeMs),
            ctimeMs: Number(stats.ctimeMs),
          };
    let memo = version ? this.boundaryMemos.get(filePath) : undefined;
    this.boundaryMemos.delete(filePath);
    if (memo && version && sameRolloutVersion(memo, version)) {
      this.rememberBoundaries(filePath, memo);
      return [...memo.provisional, ...memo.settled];
    }
    if (
      memo &&
      !(
        version &&
        size > memo.size &&
        (await isTranscriptPrefixOfDigest(
          this.readExactRange,
          filePath,
          memo.fence,
          version,
        ))
      )
    ) {
      memo = undefined;
    }

    const fence = version
      ? await captureTranscriptFence(this.readExactRange, filePath, version)
      : null;
    const floor = memo?.settledEnd ?? 0;
    const scan = await this.scanCompactStarts(filePath, floor, size, limit);
    // The append cache's standard, around the read: both fences still describe
    // prefixes of the file. A remembered prefix that changed under the scan
    // voids the merged answer, which is then a fresh full scan's.
    const after = version ? await stat(filePath).catch(() => null) : null;
    const holds = (check: (next: Stats) => Promise<boolean>) =>
      after ? check(after).catch(() => false) : Promise.resolve(false);
    const read = this.readExactRange;
    if (
      memo &&
      !(await holds((next) =>
        isTranscriptPrefixOfDigest(read, filePath, memo.fence, next),
      ))
    ) {
      return (await this.scanCompactStarts(filePath, 0, size, limit)).starts;
    }
    const starts = [...scan.starts, ...(memo?.settled ?? [])];
    if (
      !version ||
      !fence ||
      !scan.reachedFloor ||
      !(await holds((next) => isTranscriptPrefix(read, filePath, fence, next)))
    ) {
      // An early answer leaves the validated memo as good as it was.
      if (memo) this.rememberBoundaries(filePath, memo);
      return starts;
    }
    const settled = [
      ...scan.starts.filter((start) => start < scan.settledEnd),
      ...(memo?.settled ?? []),
    ];
    if (settled.length <= MAX_REMEMBERED_BOUNDARIES)
      this.rememberBoundaries(filePath, {
        ...version,
        fence: digestTranscriptFence(fence),
        settledEnd: scan.settledEnd,
        settled,
        provisional: scan.starts.filter((start) => start >= scan.settledEnd),
      });
    return starts;
  }

  private rememberBoundaries(filePath: string, memo: CompactBoundaryMemo) {
    this.boundaryMemos.set(filePath, memo);
    if (this.boundaryMemos.size > MAX_REMEMBERED_ROLLOUTS) {
      const oldest = this.boundaryMemos.keys().next().value;
      if (oldest !== undefined) this.boundaryMemos.delete(oldest);
    }
  }

  async readCompactPageSnapshot(
    filePath: string,
    stats: CodexRolloutStats,
    compactBoundaries: number,
    beforeMessageId: string,
  ): Promise<CodexCompactPageSnapshot | null> {
    const fileSize = Number(stats.size);
    const endByte = parseCodexSourceByteCursor(beforeMessageId);
    if (
      isCompressedCodexRolloutPath(filePath) ||
      endByte === null ||
      endByte <= 0 ||
      endByte > fileSize
    ) {
      return null;
    }

    const locatedStartByte = await this.findCompactWindowStart(
      filePath,
      endByte,
      compactBoundaries,
    );
    const startByte = locatedStartByte ?? 0;
    const parsed = await this.readEntryRange(
      filePath,
      startByte,
      endByte - startByte,
    );
    if (locatedStartByte !== null && parsed.entries[0]?.type !== "compacted") {
      return null;
    }

    return {
      entries: parsed.entries,
      transcriptSnapshotUpdatedAt: new Date(
        getCodexRolloutActivityTimeMs(filePath, stats),
      ).toISOString(),
      kind: "compact-page",
      omittedPrefix: startByte > 0,
      startByte,
      endByte,
      compactBoundaries,
    };
  }

  private async findCompactWindowStart(
    filePath: string,
    endByte: number,
    compactBoundaries: number,
  ): Promise<number | null> {
    const scan = await this.scanCompactStarts(
      filePath,
      0,
      endByte,
      compactBoundaries,
    );
    return scan.starts[compactBoundaries - 1] ?? null;
  }

  /** Scan `[floor, endByte)` backward in blocks; `floor` starts a line. */
  private async scanCompactStarts(
    filePath: string,
    floor: number,
    endByte: number,
    limit: number,
  ): Promise<CompactBoundaryScan> {
    let position = endByte;
    let rightPartial = Buffer.alloc(0);
    let settledEnd: number | null = null;
    const starts: number[] = [];

    while (position > floor) {
      const start = Math.max(floor, position - READ_CHUNK_BYTES);
      const block = await this.readExactRange(
        filePath,
        start,
        position - start,
      );
      const combined =
        rightPartial.length > 0 ? Buffer.concat([block, rightPartial]) : block;
      const lastNewline = combined.lastIndexOf(0x0a);
      if (settledEnd === null && lastNewline >= 0)
        settledEnd = start + lastNewline + 1;
      const firstNewline = combined.indexOf(0x0a);
      if (start > floor && firstNewline < 0) {
        rightPartial = Buffer.from(combined);
        position = start;
        continue;
      }

      const completeStart = start === floor ? 0 : firstNewline + 1;
      let lineEnd = combined.length;
      while (lineEnd > completeStart) {
        if (combined[lineEnd - 1] === 0x0a) {
          lineEnd -= 1;
          continue;
        }
        const previousNewline = combined.lastIndexOf(0x0a, lineEnd - 1);
        const lineStart = Math.max(completeStart, previousNewline + 1);
        const line = combined.subarray(lineStart, lineEnd);
        if (line.includes('"compacted"')) {
          try {
            const candidate = JSON.parse(line.toString("utf8")) as {
              type?: unknown;
            };
            if (candidate.type === "compacted") {
              starts.push(start + lineStart);
              if (starts.length === limit) {
                return {
                  starts,
                  reachedFloor: false,
                  settledEnd: settledEnd ?? floor,
                };
              }
            }
          } catch {
            // A provisional or malformed line is not a usable boundary.
          }
        }
        lineEnd = previousNewline >= completeStart ? previousNewline : 0;
      }

      rightPartial =
        start > floor
          ? Buffer.from(combined.subarray(0, firstNewline))
          : Buffer.alloc(0);
      position = start;
    }

    return { starts, reachedFloor: true, settledEnd: settledEnd ?? floor };
  }
}

function sameRolloutVersion(
  memo: CompactBoundaryMemo,
  version: Omit<
    CompactBoundaryMemo,
    "fence" | "settledEnd" | "settled" | "provisional"
  >,
): boolean {
  return (
    memo.dev === version.dev &&
    memo.ino === version.ino &&
    memo.size === version.size &&
    memo.mtimeMs === version.mtimeMs &&
    memo.ctimeMs === version.ctimeMs
  );
}
