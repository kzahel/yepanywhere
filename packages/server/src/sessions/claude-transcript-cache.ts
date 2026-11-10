import {
  TranscriptAppendMismatchError,
  readTranscriptFile,
  type TranscriptAppendFence,
  type TranscriptRange,
} from "./transcript-ingestion.js";
import type { Stats } from "node:fs";
import { stat } from "node:fs/promises";
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
 * - retained bytes are bounded by a source-byte LRU and 128-file ceiling;
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
  appendFence?: TranscriptAppendFence;
  provisionalSummaryState?: ClaudeSummaryParseState;
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

export class ClaudeTranscriptCache {
  private readonly entriesByPath: LruMap<string, CacheEntry> = createLruMap();
  private readonly inFlight = new Map<
    string,
    { token: { invalidated: boolean }; promise: Promise<CacheEntry | null> }
  >();
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
      for (const owner of this.inFlight.values())
        owner.token.invalidated = true;
      this.inFlight.clear();
    } else {
      const owner = this.inFlight.get(filePath);
      if (owner) owner.token.invalidated = true;
      this.inFlight.delete(filePath);
    }
    this.forget(filePath);
  }

  private forget(filePath?: string): void {
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
    if (pending) return this.finishLoad(filePath, options, pending);
    const token = { invalidated: false };
    const work = this.refresh(filePath, options, token).finally(() => {
      if (this.inFlight.get(filePath)?.token === token)
        this.inFlight.delete(filePath);
    });
    const owner = { token, promise: work };
    this.inFlight.set(filePath, owner);
    return this.finishLoad(filePath, options, owner);
  }
  private async finishLoad(
    filePath: string,
    options: { populate: boolean },
    owner: {
      token: { invalidated: boolean };
      promise: Promise<CacheEntry | null>;
    },
  ): Promise<ClaudeTranscriptSnapshot | null> {
    try {
      const entry = await owner.promise;
      if (owner.token.invalidated) return this.loadInternal(filePath, options);
      return entry ? toSnapshot(entry) : null;
    } catch (error) {
      if (owner.token.invalidated) return this.loadInternal(filePath, options);
      throw error;
    }
  }

  private async refresh(
    filePath: string,
    options: { populate: boolean },
    token: { invalidated: boolean },
  ): Promise<CacheEntry | null> {
    let stats: Stats;
    try {
      stats = await stat(filePath);
    } catch {
      this.forget(filePath);
      return null;
    }
    if (!stats.isFile()) {
      this.forget(filePath);
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
        const incremental = await this.tryIncremental(cached, stats, token);
        if (incremental) return incremental;
        if (token.invalidated) return null;
      }
      // Shrunk or rewritten: fall through to a full re-parse.
      this.forget(filePath);
    }

    return this.fullParse(
      filePath,
      cached ? await stat(filePath) : stats,
      options.populate,
      token,
    );
  }

  private async tryIncremental(
    cached: CacheEntry,
    stats: Stats,
    token: { invalidated: boolean },
  ): Promise<CacheEntry | null> {
    const startedAt = performance.now();
    let parsed: TranscriptRange<ClaudeSessionEntry>;
    try {
      parsed = await readTranscriptFile(
        cached.filePath,
        cached.parsedBytes,
        stats.size - cached.parsedBytes,
        (line) => JSON.parse(line) as ClaudeSessionEntry,
        cached.appendFence,
      );
    } catch (error) {
      if (error instanceof TranscriptAppendMismatchError) return null;
      throw error;
    }
    const fence = parsed.appendFence;
    // The source identity and accepted prefix must still describe this read.
    const after = await stat(cached.filePath);
    if (!sameFileIdentity(stats, after) || after.size < stats.size) return null;
    if (token.invalidated || this.entriesByPath.get(cached.filePath) !== cached)
      return null;
    if (cached.hasProvisionalTail)
      cached.entries.length = cached.committedEntries;
    for (const candidate of parsed.entries.slice(0, parsed.committedEntries)) {
      addEntryToState(
        cached.summaryState,
        candidate,
        cached.summaryState.metrics.parsedEntries,
      );
      cached.entries.push(candidate);
    }
    cached.provisionalSummaryState = undefined;
    cached.malformedLines += parsed.malformedLines;
    cached.parsedBytes = stats.size - parsed.partialLine.length;
    cached.committedEntries = cached.entries.length;
    cached.hasProvisionalTail = parsed.entries.length > parsed.committedEntries;
    if (cached.hasProvisionalTail)
      cached.entries.push(parsed.entries[parsed.committedEntries]!);
    cached.appendFence = fence;
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
    token: { invalidated: boolean },
  ): Promise<CacheEntry | null> {
    const startedAt = performance.now();
    const parsed = await readTranscriptFile(
      filePath,
      0,
      stats.size,
      (line) => JSON.parse(line) as ClaudeSessionEntry,
    );
    const summaryState = createParseState();
    for (const candidate of parsed.entries.slice(0, parsed.committedEntries))
      addEntryToState(
        summaryState,
        candidate,
        summaryState.metrics.parsedEntries,
      );
    const appendFence = parsed.appendFence;
    const after = await stat(filePath);
    if (!sameFileIdentity(stats, after) || after.size < stats.size) return null;
    const entry: CacheEntry = {
      filePath,
      entries: parsed.entries,
      summaryState,
      stats,
      malformedLines: parsed.malformedLines,
      parsedBytes: stats.size - parsed.partialLine.length,
      committedEntries: parsed.committedEntries,
      hasProvisionalTail: parsed.entries.length > parsed.committedEntries,
      appendFence,
    };

    const retain =
      populate && !token.invalidated && stats.size <= this.maxSourceBytes;
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
      if (
        this.retainedSourceBytes <= this.maxSourceBytes &&
        this.entriesByPath.size <= 128
      )
        break;
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
  const state =
    entry.provisionalSummaryState ?? cloneParseState(entry.summaryState);
  const provisional = entry.entries[entry.entries.length - 1];
  if (provisional && !entry.provisionalSummaryState) {
    addEntryToState(state, provisional, state.metrics.parsedEntries);
  }
  entry.provisionalSummaryState = state;
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
