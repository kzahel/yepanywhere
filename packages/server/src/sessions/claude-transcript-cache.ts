import {
  ClaudeDurableIndexStore,
  DurableClaudeSourceIndex,
} from "./claude-durable-index.js";
import {
  ClaudeSourceIndex,
  ClaudeProjectionChangedError,
} from "./claude-source-index.js";
import {
  TranscriptAppendMismatchError,
  readTranscriptFile,
  type TranscriptAppendFence,
  type TranscriptRange,
} from "./transcript-ingestion.js";
import type { Stats } from "node:fs";
import { stat } from "node:fs/promises";
import type {
  ClaudeSessionEntry,
  SessionRewindRecord,
} from "@yep-anywhere/shared";
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
  sourceIndex?: ClaudeSourceIndex;
  sourceGeneration?: number;
  appendFence?: TranscriptAppendFence;
}

type LoadOutcome = "hit" | "incremental" | "full" | "uncached";

interface CacheEntry {
  retainedCharge?: number;
  sourceIndex?: ClaudeSourceIndex;
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
  durableStore?: ClaudeDurableIndexStore;
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
    {
      token: { invalidated: boolean };
      promise: Promise<CacheEntry | null>;
      indexed: boolean;
    }
  >();
  private readonly maxSourceBytes: number;
  private retainedSourceBytes = 0;
  private readonly durableStore?: ClaudeDurableIndexStore;
  private closed = false;

  constructor(options: ClaudeTranscriptCacheOptions = {}) {
    this.durableStore = options.durableStore;
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
    return this.loadInternal(filePath, {
      populate: false,
      indexed:
        !!this.entriesByPath.get(filePath)?.sourceIndex ||
        !!this.inFlight.get(filePath)?.indexed,
    });
  }

  /** Build/extend compact source metadata without retaining historical payload. */
  async loadIndexed(
    filePath: string,
    rewindRecords: readonly SessionRewindRecord[] = [],
  ): Promise<ClaudeTranscriptSnapshot | null> {
    if (this.maxSourceBytes <= 0) return null;
    return this.loadInternal(filePath, {
      populate: true,
      indexed: true,
      rewindRecords,
    });
  }
  budgetBytes(): number {
    return this.maxSourceBytes;
  }
  invalidateIndexed(filePath: string, index: ClaudeSourceIndex): void {
    if (this.entriesByPath.get(filePath)?.sourceIndex === index)
      this.invalidate(filePath);
  }
  async accountIndexedWindow(
    filePath: string,
    index: ClaudeSourceIndex,
  ): Promise<void> {
    const entry = this.entriesByPath.get(filePath);
    if (!entry || entry.sourceIndex !== index) return;
    const charge = retainedBytes(entry);
    this.retainedSourceBytes += charge - (entry.retainedCharge ?? 0);
    entry.retainedCharge = charge;
    if (charge > this.maxSourceBytes) this.forget(filePath);
    this.enforceBudget(filePath);
  }

  async close(): Promise<void> {
    this.closed = true;
    const pending = [...this.inFlight.values()].map((owner) => owner.promise);
    this.invalidate();
    await Promise.allSettled(pending);
    this.durableStore?.close();
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
      this.retainedSourceBytes -=
        existing.retainedCharge ?? retainedBytes(existing);
      this.entriesByPath.delete(filePath);
    }
  }

  private async loadInternal(
    filePath: string,
    options: {
      populate: boolean;
      indexed?: boolean;
      rewindRecords?: readonly SessionRewindRecord[];
    },
  ): Promise<ClaudeTranscriptSnapshot | null> {
    if (this.closed) return null;
    const pending = this.inFlight.get(filePath);
    if (pending) {
      const snapshot = await this.finishLoad(filePath, options, pending);
      if (snapshot && !!snapshot.sourceIndex !== !!options.indexed)
        return this.loadInternal(filePath, options);
      return snapshot;
    }
    const token = { invalidated: false };
    const work = this.refresh(filePath, options, token)
      .then(async (entry) => {
        if (
          entry?.sourceIndex &&
          !(entry.sourceIndex instanceof DurableClaudeSourceIndex)
        )
          entry.sourceIndex.prepare(options.rewindRecords);
        if (
          entry?.sourceIndex &&
          !(entry.sourceIndex instanceof DurableClaudeSourceIndex) &&
          !token.invalidated
        ) {
          const rewindContext = JSON.stringify(
            entry.sourceIndex.durableState().rewindRecords,
          );
          await this.durableStore?.publish(
            filePath,
            entry.sourceIndex,
            entry,
            () => !token.invalidated && !this.closed,
          );
          if (
            this.durableStore &&
            !token.invalidated &&
            !entry.hasProvisionalTail &&
            !entry.sourceIndex.durableUnsupported()
          ) {
            const durable = await this.durableStore.load(filePath, entry.stats);
            if (
              durable &&
              !token.invalidated &&
              durable.sourceHeader.stats.size === entry.stats.size &&
              JSON.stringify(durable.sourceHeader.state.rewindRecords) ===
                rewindContext
            )
              this.installDurable(entry, durable);
          }
        }
        return entry;
      })
      .finally(() => {
        if (this.inFlight.get(filePath)?.token === token)
          this.inFlight.delete(filePath);
      });
    const owner = { token, promise: work, indexed: !!options.indexed };
    this.inFlight.set(filePath, owner);
    return this.finishLoad(filePath, options, owner);
  }
  private async finishLoad(
    filePath: string,
    options: {
      populate: boolean;
      indexed?: boolean;
      rewindRecords?: readonly SessionRewindRecord[];
    },
    owner: {
      token: { invalidated: boolean };
      promise: Promise<CacheEntry | null>;
    },
  ): Promise<ClaudeTranscriptSnapshot | null> {
    try {
      const entry = await owner.promise;
      if (owner.token.invalidated) return this.loadInternal(filePath, options);
      if (!entry) return null;
      const snapshot = toSnapshot(entry);
      if (entry.sourceIndex)
        await this.accountIndexedWindow(filePath, entry.sourceIndex);
      return snapshot;
    } catch (error) {
      if (
        error instanceof ClaudeProjectionChangedError ||
        error instanceof TranscriptAppendMismatchError
      ) {
        if (!owner.token.invalidated && !this.inFlight.has(filePath))
          this.forget(filePath);
        return this.loadInternal(filePath, options);
      }
      if (owner.token.invalidated) return this.loadInternal(filePath, options);
      throw error;
    }
  }

  private async refresh(
    filePath: string,
    options: {
      populate: boolean;
      indexed?: boolean;
      rewindRecords?: readonly SessionRewindRecord[];
    },
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

    let cached = this.entriesByPath.get(filePath);
    if (cached && !!cached.sourceIndex !== !!options.indexed) {
      this.forget(filePath);
      cached = undefined;
    }
    if (!cached && options.indexed && this.durableStore) {
      const durable = await this.durableStore
        .load(filePath, stats)
        .catch((error) => {
          if (error instanceof TranscriptAppendMismatchError) return undefined;
          throw error;
        });
      if (durable && !token.invalidated) {
        const header = durable.sourceHeader;
        const observed = Object.assign(
          Object.create(Object.getPrototypeOf(stats)),
          stats,
          header.stats,
          {
            mtime: new Date(header.stats.mtimeMs),
            ctime: new Date(header.stats.ctimeMs),
          },
        ) as Stats;
        cached = {
          filePath,
          sourceIndex: durable,
          entries: [],
          summaryState: durable.summary(),
          stats: observed,
          malformedLines: header.malformedLines,
          parsedBytes: header.parsedBytes,
          committedEntries: header.committedEntries,
          hasProvisionalTail: false,
          appendFence: durable.fence,
        };
        this.entriesByPath.set(filePath, cached);
        cached.retainedCharge = retainedBytes(cached);
        this.retainedSourceBytes += cached.retainedCharge;
        this.enforceBudget(filePath);
      }
    }
    if (
      cached?.sourceIndex instanceof DurableClaudeSourceIndex &&
      !cached.sourceIndex.store.current(filePath, cached.sourceIndex.accepted)
    ) {
      if (this.entriesByPath.get(filePath) === cached) this.forget(filePath);
      return this.refresh(filePath, options, token);
    }
    if (
      cached?.sourceIndex instanceof DurableClaudeSourceIndex &&
      options.rewindRecords !== undefined &&
      JSON.stringify(cached.sourceIndex.sourceHeader.state.rewindRecords) !==
        JSON.stringify(options.rewindRecords)
    )
      await this.materialize(cached, token);
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
      options.indexed,
    );
  }

  private installDurable(entry: CacheEntry, source: DurableClaudeSourceIndex) {
    const before = entry.retainedCharge ?? retainedBytes(entry);
    entry.sourceIndex = source;
    entry.entries = [];
    entry.summaryState = source.summary();
    entry.retainedCharge = retainedBytes(entry);
    if (this.entriesByPath.get(entry.filePath) === entry)
      this.retainedSourceBytes += entry.retainedCharge - before;
  }

  private async materialize(
    cached: CacheEntry,
    token: { invalidated: boolean },
  ): Promise<void> {
    if (cached.sourceIndex instanceof DurableClaudeSourceIndex) {
      const before = cached.retainedCharge ?? retainedBytes(cached);
      const source = cached.sourceIndex;
      const restored = await source.store.materialize(source);
      if (
        token.invalidated ||
        this.entriesByPath.get(cached.filePath) !== cached ||
        cached.sourceIndex !== source
      )
        throw new ClaudeProjectionChangedError(
          "Claude materialization owner retired",
        );
      cached.sourceIndex = restored;
      cached.entries = cached.sourceIndex.rows.slice();
      if (cached.sourceIndex.provisionalEntry)
        cached.entries.push(cached.sourceIndex.provisionalEntry);
      cached.summaryState = cached.sourceIndex.summaryState;
      cached.retainedCharge = retainedBytes(cached);
      this.retainedSourceBytes += cached.retainedCharge - before;
    }
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
        (line, offset, info) => {
          const raw = JSON.parse(line) as ClaudeSessionEntry;
          if (raw === null) return null;
          if (cached.sourceIndex)
            Object.defineProperty(raw, INDEX_RANGE, {
              value: { offset, info },
            });
          return raw;
        },
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
    const fromSql = cached.sourceIndex instanceof DurableClaudeSourceIndex;
    if (cached.sourceIndex instanceof DurableClaudeSourceIndex) {
      const source = cached.sourceIndex;
      const owned = () =>
        !token.invalidated &&
        this.entriesByPath.get(cached.filePath) === cached;
      const candidates = parsed.entries.map((raw) => ({
        raw,
        ...(raw as IndexedRangeRow)[INDEX_RANGE]!,
      }));
      const input = {
        stats,
        parsedBytes: stats.size - parsed.partialLine.length,
        committedEntries: cached.committedEntries + parsed.committedEntries,
        malformedLines: cached.malformedLines + parsed.malformedLines,
        appendFence: fence,
        hasProvisionalTail: !!parsed.partialLine.length,
      };
      let durable: DurableClaudeSourceIndex | null = null;
      let committed = source;
      if (parsed.partialLine.length) {
        // Preflight all new rows without publishing a provisional record.
        const preview = await source.store.appendRows(
          source,
          candidates,
          input,
          owned,
        );
        if (preview) {
          if (input.parsedBytes > source.accepted.header.parsedBytes) {
            let prefix: TranscriptRange<null>;
            try {
              prefix = await readTranscriptFile(
                cached.filePath,
                input.parsedBytes,
                0,
                () => null,
                fence,
              );
            } catch (error) {
              if (error instanceof TranscriptAppendMismatchError) return null;
              throw error;
            }
            const prefixStats = Object.assign(
              Object.create(Object.getPrototypeOf(stats)),
              stats,
              { size: input.parsedBytes },
            ) as Stats;
            const published = await source.store.appendRows(
              source,
              candidates.slice(0, parsed.committedEntries),
              {
                ...input,
                stats: prefixStats,
                appendFence: prefix.appendFence,
                hasProvisionalTail: false,
              },
              owned,
            );
            if (published) committed = published;
            else committed = source;
          }
          if (
            committed !== source ||
            input.parsedBytes === source.accepted.header.parsedBytes
          ) {
            durable = await source.store.appendRows(
              committed,
              candidates.slice(parsed.committedEntries),
              input,
              owned,
            );
            if (!durable && committed !== source) {
              if (!owned()) return null;
              this.installDurable(cached, committed);
              cached.stats = Object.assign(
                Object.create(Object.getPrototypeOf(stats)),
                stats,
                { size: input.parsedBytes },
              );
              cached.parsedBytes = input.parsedBytes;
              cached.committedEntries = committed.sourceHeader.committedEntries;
              cached.malformedLines = committed.sourceHeader.malformedLines;
              cached.hasProvisionalTail = false;
              cached.appendFence = committed.fence;
              parsed = {
                ...parsed,
                entries: parsed.entries.slice(parsed.committedEntries),
                committedEntries: 0,
                malformedLines: 0,
              };
            }
          }
        }
      } else
        durable = await source.store.appendRows(
          source,
          candidates,
          { ...input, hasProvisionalTail: false },
          owned,
        );
      if (durable) {
        if (!owned()) return null;
        this.installDurable(cached, durable);
        cached.stats = stats;
        cached.parsedBytes = input.parsedBytes;
        cached.committedEntries = durable.accepted.header.committedEntries;
        cached.malformedLines = durable.sourceHeader.malformedLines;
        cached.hasProvisionalTail =
          parsed.entries.length > parsed.committedEntries;
        cached.appendFence = fence;
        this.touch(cached);
        this.enforceBudget(cached.filePath);
        return cached;
      }
    }
    await this.materialize(cached, token);
    if (fromSql) cached.sourceIndex?.rebuildProjection();
    const previousBytes = cached.retainedCharge ?? retainedBytes(cached);
    cached.sourceIndex?.clearProvisional();
    if (cached.hasProvisionalTail)
      cached.entries.length = cached.committedEntries;
    for (const candidate of parsed.entries.slice(0, parsed.committedEntries)) {
      if (cached.sourceIndex) {
        const { offset, info } = (candidate as IndexedRangeRow)[INDEX_RANGE]!;
        cached.entries.push(
          cached.sourceIndex.capture(candidate, offset, info),
        );
      } else {
        addEntryToState(
          cached.summaryState,
          candidate,
          cached.summaryState.metrics.parsedEntries,
        );
        cached.entries.push(candidate);
      }
    }
    cached.provisionalSummaryState = undefined;
    cached.malformedLines += parsed.malformedLines;
    cached.parsedBytes = stats.size - parsed.partialLine.length;
    cached.committedEntries = cached.entries.length;
    cached.hasProvisionalTail = parsed.entries.length > parsed.committedEntries;
    if (cached.hasProvisionalTail) {
      const row = parsed.entries[parsed.committedEntries]!;
      const range = (row as IndexedRangeRow)[INDEX_RANGE];
      cached.entries.push(
        cached.sourceIndex && range
          ? cached.sourceIndex.capture(row, range.offset, range.info)
          : row,
      );
    }
    if (cached.sourceIndex && !parsed.partialLine.length)
      cached.sourceIndex.clearProvisional();
    cached.appendFence = fence;
    cached.stats = stats;
    cached.retainedCharge = retainedBytes(cached);
    this.retainedSourceBytes += cached.retainedCharge - previousBytes;
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
    indexed = false,
  ): Promise<CacheEntry | null> {
    const startedAt = performance.now();
    const sourceIndex = indexed ? new ClaudeSourceIndex() : undefined;
    const parsed = await readTranscriptFile(
      filePath,
      0,
      stats.size,
      (line, offset, info) => {
        const raw = JSON.parse(line) as ClaudeSessionEntry;
        if (raw === null) return null;
        return sourceIndex ? sourceIndex.capture(raw, offset, info) : raw;
      },
    );
    const summaryState = sourceIndex?.summaryState ?? createParseState();
    if (!sourceIndex)
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
      sourceIndex,
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
      populate &&
      !token.invalidated &&
      retainedBytes(entry) <= this.maxSourceBytes;
    if (retain) {
      this.entriesByPath.set(filePath, entry);
      entry.retainedCharge = retainedBytes(entry);
      this.retainedSourceBytes += entry.retainedCharge;
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
      this.retainedSourceBytes -= entry.retainedCharge ?? retainedBytes(entry);
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
  if (entry.sourceIndex) {
    const sourceIndex = entry.sourceIndex.view();
    return {
      entries: entry.entries,
      committedEntries: entry.committedEntries,
      summaryState: sourceIndex.summary(),
      stats: entry.stats,
      malformedLines: entry.malformedLines,
      sourceIndex,
      sourceGeneration: sourceIndex.generation,
      appendFence: entry.appendFence,
    };
  }
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

const INDEX_RANGE = Symbol("claudeIndexRange");
type IndexedRangeRow = ClaudeSessionEntry & {
  [INDEX_RANGE]?: {
    offset: number;
    info: import("./transcript-ingestion.js").TranscriptLineInfo;
  };
};
function retainedBytes(entry: CacheEntry) {
  return entry.sourceIndex
    ? entry.sourceIndex.retainedBytes + entry.sourceIndex.decodedBytes
    : entry.stats.size;
}

function resolveBudgetFromEnv(): number | null {
  const raw = process.env.YEP_CLAUDE_PARSE_CACHE_MB;
  if (!raw) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed * 1024 * 1024 : null;
}

/** Process-wide singleton: reader instances are created per project/request. */
export const claudeTranscriptCache = new ClaudeTranscriptCache();

/** One cache and durable writer for the lifetime of a YA profile. */
export function createClaudeTranscriptCache(
  database: import("../storage/sqlite.js").SqliteDatabase,
) {
  return new ClaudeTranscriptCache({
    durableStore: new ClaudeDurableIndexStore(database),
  });
}
