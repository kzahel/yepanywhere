import {
  type LruMap,
  createLruMap,
  refreshLruMap,
} from "../lib/lruCollections.js";
import { getLogger } from "../logging/logger.js";

/**
 * Process-wide retention budget for parsed Codex transcripts.
 *
 * Each `CodexSessionReader` keeps its own sessionId -> parsed-entry cache, and
 * the server creates many readers (per project, per request, per provider
 * resolution). Without a shared bound, a sweep over every session (for
 * example a full-history export) left every parsed rollout and its normalized
 * copy reachable for the reader's lifetime: one audit of 165 Codex sessions
 * retained 1.16 GB of source JSONL as roughly 2.4 GB of live heap.
 *
 * Readers admit entries here, measured in source bytes. The budget evicts the
 * least recently used entries across all readers and calls the owning
 * reader's release callback, which drops its map reference so the parsed
 * entries and their normalization WeakMap entry become collectable. An entry
 * larger than the whole budget is never admitted; its read is served
 * uncached.
 */

const DEFAULT_BUDGET_MB = 256;

export interface CodexEntryCacheBudgetOptions {
  /** Budget for retained transcripts, measured in source bytes. */
  maxSourceBytes?: number;
}

export interface CodexEntryCacheBudgetStats {
  budgetBytes: number;
  retainedEntries: number;
  retainedSourceBytes: number;
}

interface RetainedEntry {
  sourceBytes: number;
  release: () => void;
}

export class CodexEntryCacheBudget {
  private readonly retained: LruMap<object, RetainedEntry> = createLruMap();
  private readonly maxSourceBytes: number;
  private retainedSourceBytes = 0;

  constructor(options: CodexEntryCacheBudgetOptions = {}) {
    this.maxSourceBytes =
      options.maxSourceBytes ??
      resolveBudgetFromEnv() ??
      DEFAULT_BUDGET_MB * 1024 * 1024;
  }

  /**
   * Admit or resize an entry and mark it most recently used. Returns false,
   * without retaining it, when the entry alone exceeds the budget; the caller
   * must then drop its own reference. Admission may evict other entries,
   * calling their release callbacks synchronously.
   */
  admit(key: object, sourceBytes: number, release: () => void): boolean {
    this.release(key);
    if (sourceBytes > this.maxSourceBytes) {
      return false;
    }
    this.retained.set(key, { sourceBytes, release });
    this.retainedSourceBytes += sourceBytes;
    this.enforce(key);
    return true;
  }

  /** Refresh LRU recency after a cache hit. */
  touch(key: object): void {
    const entry = this.retained.get(key);
    if (entry) {
      refreshLruMap(this.retained, key, entry);
    }
  }

  /** Stop accounting for an entry the owner dropped itself. */
  release(key: object): void {
    const entry = this.retained.get(key);
    if (!entry) return;
    this.retained.delete(key);
    this.retainedSourceBytes -= entry.sourceBytes;
  }

  /** Fixed-cost process diagnostics without exposing retained identities. */
  getStats(): CodexEntryCacheBudgetStats {
    return {
      budgetBytes: this.maxSourceBytes,
      retainedEntries: this.retained.size,
      retainedSourceBytes: this.retainedSourceBytes,
    };
  }

  private enforce(justUsed: object): void {
    for (const [key, entry] of this.retained) {
      if (
        this.retainedSourceBytes <= this.maxSourceBytes &&
        this.retained.size <= 128
      )
        break;
      if (key === justUsed) continue;
      this.retained.delete(key);
      this.retainedSourceBytes -= entry.sourceBytes;
      entry.release();
      getLogger().debug(
        {
          event: "codex_entry_cache_evict",
          sourceBytes: entry.sourceBytes,
          retainedSourceBytes: this.retainedSourceBytes,
          retainedEntries: this.retained.size,
        },
        "CODEX_READER: entry cache evict",
      );
    }
  }
}

function resolveBudgetFromEnv(): number | null {
  const raw = process.env.YEP_CODEX_PARSE_CACHE_MB;
  if (!raw) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed * 1024 * 1024 : null;
}

/** Process-wide singleton shared by every CodexSessionReader instance. */
export const codexEntryCacheBudget = new CodexEntryCacheBudget();
