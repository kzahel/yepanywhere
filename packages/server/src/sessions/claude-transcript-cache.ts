import type { Stats } from "node:fs";
import { open, stat } from "node:fs/promises";
import type { ClaudeSessionEntry } from "@yep-anywhere/shared";
import { type LruMap, createLruMap } from "../lib/lruCollections.js";
import { getLogger } from "../logging/logger.js";
import {
  type ClaudeSummaryParseState,
  addEntryToState,
  cloneParseState,
  createParseState,
} from "./claude-summary.js";

/**
 * Process-wide cache of parsed Claude session transcripts.
 *
 * Session-detail requests previously re-read and re-parsed the entire jsonl
 * on every GET (twice: once for the summary, once for the messages), which
 * measured ~3.3s per request for a 94 MB live session. This cache retains
 * parsed entries per file, revalidates by file identity+ctime+mtime+size, and
 * parses only the appended byte range when the same file strictly grows,
 * verifying the append-only assumption with a boundary probe of the bytes just
 * before the previously parsed offset.
 *
 * Heap discipline (see topics/server-performance-observability.md):
 * - retained bytes are bounded by an LRU budget measured in source bytes;
 * - a file larger than the whole budget is parsed per-request, never retained;
 * - concurrent loads of one file share a single in-flight parse;
 * - the compact summary parse state is maintained incrementally alongside the
 *   entries so summary revalidation of a warm file needs no full re-parse.
 *
 * The `entries` array keeps its identity across incremental appends (new
 * entries are pushed in place). Downstream normalization caches key off that
 * identity (see `claudeMessageCache` in normalization.ts), so eviction here
 * releases the normalized copy too via WeakMap semantics.
 */

const NEWLINE = 0x0a;
const BOUNDARY_PROBE_BYTES = 1024;
const DEFAULT_BUDGET_MB = 192;

export interface ClaudeTranscriptSnapshot {
  /** Parsed entries in file order. Do not mutate; identity is cache-stable. */
  entries: ClaudeSessionEntry[];
  /** Parsed rows ending at a newline; a provisional tail is excluded. */
  committedEntries: number;
  /** Compact summary fold over the committed entries (plus provisional tail). */
  summaryState: ClaudeSummaryParseState;
  stats: Stats;
  malformedLines: number;
}

type LoadOutcome = "hit" | "incremental" | "full" | "uncached";

interface CacheEntry {
  filePath: string;
  entries: ClaudeSessionEntry[];
  summaryState: ClaudeSummaryParseState;
  stats: Stats;
  malformedLines: number;
  /** Byte offset just past the last newline-terminated line we consumed. */
  parsedBytes: number;
  /** Count of entries parsed from newline-terminated lines. */
  committedEntries: number;
  /** Whether entries currently ends with a provisional unterminated line. */
  hasProvisionalTail: boolean;
  /** Raw bytes immediately before parsedBytes, to verify append-only growth. */
  boundaryProbe: Buffer | null;
}

export interface ClaudeTranscriptCacheOptions {
  /** LRU budget for retained transcripts, measured in source bytes. */
  maxSourceBytes?: number;
}

export interface ClaudeTranscriptCacheStats {
  budgetBytes: number;
  inFlightLoads: number;
  retainedFiles: number;
  retainedSourceBytes: number;
}

interface ParseAccumulator {
  entries: ClaudeSessionEntry[];
  summaryState: ClaudeSummaryParseState;
  malformedLines: number;
}

function parseLineInto(acc: ParseAccumulator, line: string): void {
  const trimmed = line.trim();
  if (!trimmed) return;
  try {
    const entry = JSON.parse(trimmed) as ClaudeSessionEntry;
    addEntryToState(
      acc.summaryState,
      entry,
      acc.summaryState.metrics.parsedEntries,
    );
    acc.entries.push(entry);
  } catch {
    acc.malformedLines += 1;
  }
}

/**
 * Parse newline-terminated lines from `buffer`, appending into `acc`.
 * Returns the byte offset just past the last consumed newline (relative to
 * the start of `buffer`) and the provisional unterminated tail, if any.
 */
function parseCompleteLines(
  acc: ParseAccumulator,
  buffer: Buffer,
  startOffset: number,
): { consumedBytes: number; tail: string | null } {
  let lineStart = startOffset;
  let consumed = startOffset;
  for (let i = startOffset; i < buffer.length; i++) {
    if (buffer[i] !== NEWLINE) continue;
    parseLineInto(acc, buffer.toString("utf-8", lineStart, i));
    lineStart = i + 1;
    consumed = lineStart;
  }
  const tail =
    lineStart < buffer.length ? buffer.toString("utf-8", lineStart) : null;
  return { consumedBytes: consumed, tail };
}

function hasUtf8Bom(buffer: Buffer): boolean {
  return (
    buffer.length >= 3 &&
    buffer[0] === 0xef &&
    buffer[1] === 0xbb &&
    buffer[2] === 0xbf
  );
}

function probeFor(buffer: Buffer, parsedBytes: number): Buffer | null {
  if (parsedBytes <= 0) return null;
  const start = Math.max(0, parsedBytes - BOUNDARY_PROBE_BYTES);
  // Copy so the probe does not retain the full file buffer.
  return Buffer.from(buffer.subarray(start, parsedBytes));
}

function sameFileIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameFileSnapshot(left: Stats, right: Stats): boolean {
  return (
    sameFileIdentity(left, right) &&
    left.ctimeMs === right.ctimeMs &&
    left.mtimeMs === right.mtimeMs &&
    left.size === right.size
  );
}

async function readByteRange(
  filePath: string,
  start: number,
  end: number,
): Promise<Buffer | null> {
  if (end <= start) return Buffer.alloc(0);
  const handle = await open(filePath, "r");
  try {
    const buffer = Buffer.alloc(end - start);
    let filled = 0;
    while (filled < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        filled,
        buffer.length - filled,
        start + filled,
      );
      if (bytesRead === 0) return null; // File shrank under us.
      filled += bytesRead;
    }
    return buffer;
  } finally {
    await handle.close();
  }
}

export class ClaudeTranscriptCache {
  private readonly entriesByPath: LruMap<string, CacheEntry> = createLruMap();
  private readonly inFlight = new Map<string, Promise<CacheEntry | null>>();
  private readonly maxSourceBytes: number;
  private retainedSourceBytes = 0;

  constructor(options: ClaudeTranscriptCacheOptions = {}) {
    this.maxSourceBytes =
      options.maxSourceBytes ??
      resolveBudgetFromEnv() ??
      DEFAULT_BUDGET_MB * 1024 * 1024;
  }

  /**
   * Load the parsed transcript for a session file, using the cache when the
   * file is unchanged and incremental append parsing when it grew.
   */
  async load(filePath: string): Promise<ClaudeTranscriptSnapshot | null> {
    return this.loadInternal(filePath, { populate: true });
  }

  /**
   * Like `load`, but never populates the cache for a cold file: summary-only
   * callers (project scans, index revalidation) must not force full parsed
   * transcripts into memory. Returns null when the file is not already warm.
   */
  async peek(filePath: string): Promise<ClaudeTranscriptSnapshot | null> {
    if (!this.entriesByPath.has(filePath) && !this.inFlight.has(filePath)) {
      return null;
    }
    return this.loadInternal(filePath, { populate: false });
  }

  /** Fixed-cost process diagnostics without exposing retained file identities. */
  getStats(): ClaudeTranscriptCacheStats {
    return {
      budgetBytes: this.maxSourceBytes,
      inFlightLoads: this.inFlight.size,
      retainedFiles: this.entriesByPath.size,
      retainedSourceBytes: this.retainedSourceBytes,
    };
  }

  /** Drop one file, or everything. Exposed for tests and invalidation. */
  invalidate(filePath?: string): void {
    if (filePath === undefined) {
      this.entriesByPath.clear();
      this.retainedSourceBytes = 0;
      return;
    }
    const existing = this.entriesByPath.get(filePath);
    if (existing) {
      this.retainedSourceBytes -= existing.stats.size;
      this.entriesByPath.delete(filePath);
    }
  }

  private async loadInternal(
    filePath: string,
    options: { populate: boolean },
  ): Promise<ClaudeTranscriptSnapshot | null> {
    const pending = this.inFlight.get(filePath);
    if (pending) {
      const entry = await pending;
      return entry ? toSnapshot(entry) : null;
    }

    const work = this.refresh(filePath, options).finally(() => {
      this.inFlight.delete(filePath);
    });
    this.inFlight.set(filePath, work);
    const entry = await work;
    return entry ? toSnapshot(entry) : null;
  }

  private async refresh(
    filePath: string,
    options: { populate: boolean },
  ): Promise<CacheEntry | null> {
    let stats: Stats;
    try {
      stats = await stat(filePath);
    } catch {
      this.invalidate(filePath);
      return null;
    }
    if (!stats.isFile()) {
      this.invalidate(filePath);
      return null;
    }

    const cached = this.entriesByPath.get(filePath);
    if (cached) {
      if (sameFileSnapshot(cached.stats, stats)) {
        this.touch(cached);
        this.logOutcome("hit", filePath, stats, 0);
        return cached;
      }
      if (
        sameFileIdentity(cached.stats, stats) &&
        stats.size > cached.stats.size
      ) {
        const incremental = await this.tryIncremental(cached, stats);
        if (incremental) return incremental;
      }
      // Shrunk or rewritten: fall through to a full re-parse.
      this.invalidate(filePath);
    }

    return this.fullParse(filePath, stats, options.populate);
  }

  private async tryIncremental(
    cached: CacheEntry,
    stats: Stats,
  ): Promise<CacheEntry | null> {
    const startedAt = performance.now();
    const probeStart = cached.boundaryProbe
      ? cached.parsedBytes - cached.boundaryProbe.length
      : cached.parsedBytes;
    const region = await readByteRange(cached.filePath, probeStart, stats.size);
    if (!region) return null;
    if (
      cached.boundaryProbe &&
      !region
        .subarray(0, cached.boundaryProbe.length)
        .equals(cached.boundaryProbe)
    ) {
      // The bytes before our parse offset changed: not append-only.
      return null;
    }

    // Discard any provisional tail entry; the appended region re-covers it.
    if (cached.hasProvisionalTail) {
      cached.entries.length = cached.committedEntries;
    }

    const appendedStart = cached.boundaryProbe
      ? cached.boundaryProbe.length
      : 0;
    const acc: ParseAccumulator = {
      entries: cached.entries,
      summaryState: cached.summaryState,
      malformedLines: cached.malformedLines,
    };
    const { consumedBytes, tail } = parseCompleteLines(
      acc,
      region,
      appendedStart,
    );
    cached.malformedLines = acc.malformedLines;
    cached.parsedBytes = probeStart + consumedBytes;
    cached.committedEntries = cached.entries.length;
    cached.hasProvisionalTail = false;
    if (tail !== null) {
      appendProvisionalTail(cached, tail);
    }
    cached.boundaryProbe = probeFor(region, consumedBytes);
    this.retainedSourceBytes += stats.size - cached.stats.size;
    cached.stats = stats;
    this.touch(cached);
    this.enforceBudget(cached.filePath);
    this.logOutcome(
      "incremental",
      cached.filePath,
      stats,
      performance.now() - startedAt,
    );
    return cached;
  }

  private async fullParse(
    filePath: string,
    stats: Stats,
    populate: boolean,
  ): Promise<CacheEntry | null> {
    const startedAt = performance.now();
    const buffer = await readByteRange(filePath, 0, stats.size);
    if (!buffer) return null;

    const acc: ParseAccumulator = {
      entries: [],
      summaryState: createParseState(),
      malformedLines: 0,
    };
    const startOffset = hasUtf8Bom(buffer) ? 3 : 0;
    const { consumedBytes, tail } = parseCompleteLines(
      acc,
      buffer,
      startOffset,
    );

    const entry: CacheEntry = {
      filePath,
      entries: acc.entries,
      summaryState: acc.summaryState,
      stats,
      malformedLines: acc.malformedLines,
      parsedBytes: consumedBytes,
      committedEntries: acc.entries.length,
      hasProvisionalTail: false,
      boundaryProbe: probeFor(buffer, consumedBytes),
    };
    if (tail !== null) {
      appendProvisionalTail(entry, tail);
    }

    const retain = populate && stats.size <= this.maxSourceBytes;
    if (retain) {
      this.entriesByPath.set(filePath, entry);
      this.retainedSourceBytes += stats.size;
      this.enforceBudget(filePath);
    }
    this.logOutcome(
      retain ? "full" : "uncached",
      filePath,
      stats,
      performance.now() - startedAt,
    );
    return entry;
  }

  /** Refresh LRU recency by delete-and-reinsert (see lruCollections). */
  private touch(entry: CacheEntry): void {
    this.entriesByPath.delete(entry.filePath);
    this.entriesByPath.set(entry.filePath, entry);
  }

  private enforceBudget(justUsedPath: string): void {
    for (const [path, entry] of this.entriesByPath) {
      if (this.retainedSourceBytes <= this.maxSourceBytes) break;
      if (path === justUsedPath) continue;
      this.entriesByPath.delete(path);
      this.retainedSourceBytes -= entry.stats.size;
      getLogger().debug(
        {
          event: "claude_transcript_cache_evict",
          filePath: path,
          fileSize: entry.stats.size,
          retainedSourceBytes: this.retainedSourceBytes,
        },
        "CLAUDE_READER: transcript cache evict",
      );
    }
  }

  private logOutcome(
    outcome: LoadOutcome,
    filePath: string,
    stats: Stats,
    durationMs: number,
  ): void {
    if (outcome === "hit") return;
    getLogger().debug(
      {
        event: `claude_transcript_cache_${outcome}`,
        filePath,
        fileSize: stats.size,
        durationMs: Math.round(durationMs * 10) / 10,
        retainedSourceBytes: this.retainedSourceBytes,
        retainedFiles: this.entriesByPath.size,
      },
      `CLAUDE_READER: transcript cache ${outcome}`,
    );
  }
}

/**
 * A final line without a trailing newline is served (matching the previous
 * whole-file split behavior) but held out of the committed incremental state
 * so the next refresh can re-read it once the writer finishes the line.
 */
function appendProvisionalTail(entry: CacheEntry, tail: string): void {
  const trimmed = tail.trim();
  if (!trimmed) return;
  try {
    entry.entries.push(JSON.parse(trimmed) as ClaudeSessionEntry);
    entry.hasProvisionalTail = true;
  } catch {
    // Torn mid-write line; ignore like any malformed line.
  }
}

function toSnapshot(entry: CacheEntry): ClaudeTranscriptSnapshot {
  if (!entry.hasProvisionalTail) {
    return {
      entries: entry.entries,
      committedEntries: entry.committedEntries,
      summaryState: entry.summaryState,
      stats: entry.stats,
      malformedLines: entry.malformedLines,
    };
  }
  // Fold the provisional entry into a cloned state so the retained
  // incremental state stays committed-lines-only.
  const state = cloneParseState(entry.summaryState);
  const provisional = entry.entries[entry.entries.length - 1];
  if (provisional) {
    addEntryToState(state, provisional, state.metrics.parsedEntries);
  }
  return {
    entries: entry.entries,
    committedEntries: entry.committedEntries,
    summaryState: state,
    stats: entry.stats,
    malformedLines: entry.malformedLines,
  };
}

function resolveBudgetFromEnv(): number | null {
  const raw = process.env.YEP_CLAUDE_PARSE_CACHE_MB;
  if (!raw) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed * 1024 * 1024 : null;
}

/** Process-wide singleton: reader instances are created per project/request. */
export const claudeTranscriptCache = new ClaudeTranscriptCache();
