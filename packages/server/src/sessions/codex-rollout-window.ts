import {
  readObservedTranscriptRange,
  type TranscriptAppendFence,
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

export interface CodexRolloutStats {
  size: number | bigint;
  mtimeMs: number | bigint;
  ctimeMs: number | bigint;
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

    const startByte = await this.findCompactWindowStart(
      filePath,
      fileSize,
      compactBoundaries,
    );
    if (startByte === null || startByte <= 0) {
      return null;
    }

    return startByte;
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
    let position = endByte;
    let rightPartial = Buffer.alloc(0);
    let found = 0;

    while (position > 0) {
      const start = Math.max(0, position - READ_CHUNK_BYTES);
      const block = await this.readExactRange(
        filePath,
        start,
        position - start,
      );
      const combined =
        rightPartial.length > 0 ? Buffer.concat([block, rightPartial]) : block;
      const firstNewline = combined.indexOf(0x0a);
      if (start > 0 && firstNewline < 0) {
        rightPartial = Buffer.from(combined);
        position = start;
        continue;
      }

      const completeStart = start === 0 ? 0 : firstNewline + 1;
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
              found += 1;
              if (found === compactBoundaries) {
                return start + lineStart;
              }
            }
          } catch {
            // A provisional or malformed line is not a usable boundary.
          }
        }
        lineEnd = previousNewline >= completeStart ? previousNewline : 0;
      }

      rightPartial =
        start > 0
          ? Buffer.from(combined.subarray(0, firstNewline))
          : Buffer.alloc(0);
      position = start;
    }

    return null;
  }
}
