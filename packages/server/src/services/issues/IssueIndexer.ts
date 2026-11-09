import { setImmediate as yieldTurn } from "node:timers/promises";
import { getLogger } from "../../logging/logger.js";
import type { SessionCatalogRow } from "../../sessions/catalog-types.js";
import type {
  IssueReadOptions,
  IssueTextBatch,
} from "../../sessions/issue-text-reader.js";
import type { VisibleMessageText } from "../../sessions/message-text.js";
import type { Message } from "../../supervisor/types.js";
import { visibleMessageTextWithSourceId } from "../../sessions/normalization.js";
import type { AdmittedJob, IssueStore, IssueSource } from "./IssueStore.js";
import { codeFences } from "./extract.js";

import type { IssueSettings } from "@yep-anywhere/shared";
export type { IssueSettings } from "@yep-anywhere/shared";
/** Identifies one published catalog generation, so a sweep can skip a repeat. */
export interface CatalogMark {
  catalogEpoch: string;
  catalogGeneration: number;
}

/** A catalog row as the indexer sees it: public identity, and its own key. */
export interface IssueCatalogRow extends SessionCatalogRow {
  /** `sessionCatalogRowKey` of the native row. */
  catalogKey: string;
}

/** What changed in the catalog since a sweep's mark, projected to public rows. */
export interface IssueCatalogChanges {
  /** The generation these changes bring a sweep to. */
  mark: CatalogMark;
  /** Every row, rather than only those changed since the mark. */
  full: boolean;
  rows: readonly Readonly<IssueCatalogRow>[];
  /** Keys of rows removed from the catalog since the mark. */
  removed: readonly string[];
  /**
   * Keys of changed or retried rows the identity projection left out (their
   * family still has pending allocations, or adoption refused them). Their
   * rows may not change again, so the next sweep offers them once more.
   */
  excluded: readonly string[];
}

/** Bytes of one capture chunk; a message longer than this is captured in several. */
const CAPTURE_CHUNK = 32 * 1024;
/**
 * Bytes each chunk reads beyond its own range, so a reference crossing a chunk
 * boundary is still read whole. Ownership stays with the chunk the reference
 * starts in, so the overlap adds context without a second sighting.
 */
const CAPTURE_OVERLAP = 4096;
/**
 * Queue rank a catalog sweep admits at. A window the user is looking at is
 * recorded by `IssueStore` at a higher rank, so background sweeping never gets
 * in front of it.
 */
const SWEEP_PRIORITY = 0;

export interface IssueIndexerDeps {
  settings: () => IssueSettings;
  /**
   * Rows changed since `since`, or every row when `since` is absent or the
   * catalog cannot say, with `retry` keys offered again.
   */
  changes: (
    since: CatalogMark | undefined,
    retry: ReadonlySet<string>,
  ) => Promise<IssueCatalogChanges>;
  /** The current row under a catalog key, or nothing when it is gone or unprojectable. */
  row: (catalogKey: string) => Promise<Readonly<IssueCatalogRow> | undefined>;
  read: (
    row: IssueCatalogRow,
    options: IssueReadOptions,
  ) => Promise<IssueTextBatch | null>;
  projectForSession?: (sessionId: string) => string | undefined;
  /** Called after captures land, so freshly seen references can be asked about. */
  confirm?: () => void;
}

/** One fair worker and durable queue, independent of client count or corpus size. */
export class IssueIndexer {
  private controller = new AbortController();
  private work?: Promise<void>;
  private enumeration?: Promise<void>;
  private refreshPending = false;
  /** Catalog generation the last completed sweep reached. */
  private swept?: CatalogMark;
  /**
   * Keys offered again by the next sweep: rows the last sweep could not
   * project, and rows the worker found unprojectable and paused.
   */
  private retry = new Set<string>();
  /** A sweep over every row is owed: settings changed, or a caller asked. */
  private fullPending = false;
  private closed = false;
  private viewTasks = new Set<Promise<void>>();
  private viewBytes = 0;
  constructor(
    readonly store: IssueStore,
    private readonly deps: IssueIndexerDeps,
  ) {
    this.fence();
  }
  settings(): IssueSettings {
    return this.deps.settings();
  }
  /**
   * Abandon in-flight acquisition and return the jobs it was mid-way through
   * to the queue, so what a caller does next cannot land beside writes from
   * the state it just invalidated. Work started after this reads the new
   * signal; work already running sees its own aborted one.
   */
  private fence(): void {
    this.controller.abort();
    this.controller = new AbortController();
    this.store.requeueIndexing();
  }
  configure(): void {
    this.fence();
    this.lastError = null;
    this.store.reconcileJira();
    // Settings decide what a sweep admits, so a change invalidates the mark.
    this.swept = undefined;
    if (!this.settings().enabled || this.closed) return;
    this.refresh();
  }
  /**
   * Sweep the catalog. Pass the publication's catalog mark to make it a no-op
   * when nothing has changed since the last completed sweep, and otherwise to
   * read only the rows changed since (plan 189 step 4): re-walking a whole
   * corpus every few seconds to reach the same conclusions is the cost this
   * avoids. A caller with its own reason to sweep (a settings change, through
   * `configure`) passes nothing and sweeps every row.
   */
  refresh(catalog?: CatalogMark): void {
    if (this.closed || !this.settings().enabled) return;
    if (!catalog) this.fullPending = true;
    else if (
      !this.fullPending &&
      catalog.catalogEpoch === this.swept?.catalogEpoch &&
      catalog.catalogGeneration === this.swept.catalogGeneration
    )
      return;
    this.sweep();
  }
  private sweep(): void {
    if (this.enumeration) {
      this.refreshPending = true;
      return;
    }
    this.refreshPending = false;
    const full = this.fullPending || !this.swept;
    this.fullPending = false;
    const signal = this.controller.signal;
    let reached: IssueCatalogChanges | undefined;
    // Keys the worker adds while this sweep runs are kept for the next.
    const retrying = new Set(this.retry);
    this.enumeration = (async () => {
      const startedAt = performance.now();
      const changes = await this.deps.changes(
        full ? undefined : this.swept,
        full ? new Set() : retrying,
      );
      const cutoff = Date.now() - this.settings().recentDays * 86400_000;
      // Every row of a full sweep would otherwise cost one ownership write
      // transaction per known session — thousands of file locks, none of which
      // can change a row. Only a session that already has a row can move, and
      // a row created later during this sweep carries its own project, so one
      // read up front replaces all of them. A change sweep of a few rows asks
      // per row instead of reading every job.
      const owned = changes.full ? this.store.ownedProjects() : undefined;
      // Read once, and only if something is actually admitted: a sweep in
      // viewed scope admits nothing and must not pay for a queue it will not
      // touch.
      let queue: Map<string, AdmittedJob> | undefined;
      const admitted = (sessionId: string) => {
        if (!changes.full)
          return this.store.admittedJobs(sessionId).get(sessionId);
        queue ??= this.store.admittedJobs();
        return queue.get(sessionId);
      };
      let count = 0;
      for (const row of changes.rows) {
        if (signal.aborted) return;
        const projectId =
          this.deps.projectForSession?.(row.sessionId) ?? row.projectId;
        // Current project ownership updates independently of scan eligibility,
        // and only for a session some stored row still files elsewhere: the
        // update statements are no-ops otherwise, but their transaction is a
        // file lock either way.
        const stored = owned
          ? owned.get(row.sessionId)
          : this.store.ownedProjectsOf(row.sessionId);
        if (stored && [...stored].some((held) => held !== projectId))
          this.store.updateProject(row.sessionId, projectId);
        if (
          this.settings().scope === "recent" &&
          Date.parse(row.updatedAt) >= cutoff
        )
          this.enqueue(row, projectId, admitted(row.sessionId));
        else {
          // A session whose row moved to a new key keeps its job and cursor.
          const job = admitted(row.sessionId);
          if (job?.catalogKey && job.catalogKey !== row.catalogKey)
            this.store.rekeyJob(row.sessionId, row.catalogKey);
        }
        if (++count % 100 === 0) await yieldTurn();
      }
      if (signal.aborted) return;
      // Only a removed catalog row ends a job. A row a recent-scope sweep
      // passes over, or a store whose scan failed, is still in the catalog.
      if (changes.removed.length) this.store.removeJobs(changes.removed);
      reached = changes;
      getLogger().debug(
        {
          full: changes.full,
          rows: changes.rows.length,
          removed: changes.removed.length,
          excluded: changes.excluded.length,
          durationMs: Math.round(performance.now() - startedAt),
          generation: changes.mark.catalogGeneration,
        },
        "ISSUE_INDEX: swept catalog changes",
      );
    })()
      .then(() => {
        // Only a sweep that ran to completion may retire its mark.
        if (signal.aborted || !reached) return;
        this.swept = reached.mark;
        this.retry = new Set([
          ...reached.excluded,
          ...[...this.retry].filter((key) => !retrying.has(key)),
        ]);
      })
      .catch(() => {
        if (!signal.aborted) this.lastError = "Catalog unavailable";
      })
      .finally(() => {
        this.enumeration = undefined;
        if (full && !reached) this.fullPending = true;
        if (
          (signal !== this.controller.signal || this.refreshPending) &&
          this.settings().enabled
        )
          this.sweep();
        this.kick();
      });
  }
  private lastError: string | null = null;
  /**
   * Admit one candidate, writing only when the queue would actually change.
   * The upsert below assigns project, source, version and priority whatever
   * the stored row holds, so a job that already holds all four would be
   * rewritten with its own bytes — thousands of locks a minute in recent
   * scope, where every publication re-admits every recent session. A paused
   * job is the exception: the upsert's `CASE` is what returns it to the queue
   * when a widened recent window admits it again.
   *
   * `queued` is this sweep's opening snapshot, so a job the running worker
   * pauses mid-sweep can be skipped here and stays paused until the next
   * publication reads it as paused and re-queues it. The unconditional write
   * had the same one-publication delay with the outcome reversed: whichever
   * of the pause and the upsert landed second decided the state.
   */
  private enqueue(
    row: Readonly<IssueCatalogRow>,
    projectId: string,
    current: AdmittedJob | undefined,
  ): void {
    if (
      current &&
      current.state !== "paused" &&
      current.priority === SWEEP_PRIORITY &&
      current.projectId === projectId &&
      current.sourceVersion === row.sourceVersion &&
      current.catalogKey === row.catalogKey
    )
      return;
    this.store.admitJob({
      sessionId: row.sessionId,
      projectId,
      sourceVersion: row.sourceVersion,
      catalogKey: row.catalogKey,
      priority: SWEEP_PRIORITY,
    });
  }
  /**
   * Capture one message in chunks, yielding between them so a long message
   * cannot hold the loop. Each chunk reads `CAPTURE_OVERLAP` bytes on either
   * side but owns only its own range, so a reference crossing a boundary is
   * read whole and recorded once, at the offset it holds in the source.
   * Returns early on abort; the caller decides what an unfinished message
   * means at its own seam.
   */
  private async captureChunked(
    source: IssueSource,
    message: VisibleMessageText,
    signal: AbortSignal,
  ): Promise<void> {
    // A chunk cannot tell whether it starts inside a code block, so fences are
    // found once over the whole message and handed to each chunk.
    const fences = codeFences(message.text);
    for (
      let offset = 0;
      offset < message.text.length;
      offset += CAPTURE_CHUNK
    ) {
      if (signal.aborted) return;
      const start = Math.max(0, offset - CAPTURE_OVERLAP);
      const end = offset + CAPTURE_CHUNK + CAPTURE_OVERLAP;
      this.store.capture(
        source,
        { ...message, text: message.text.slice(start, end) },
        start,
        offset,
        offset + CAPTURE_CHUNK,
        fences
          .filter(([a, b]) => a < end && b > start)
          .map(([a, b]) => [
            Math.max(a, start) - start,
            Math.min(b, end) - start,
          ]),
      );
      await yieldTurn();
    }
  }
  /** Only already-authorized persisted windows enter here; public shares never call it. */
  observe(source: IssueSource, messages: readonly Message[]): void {
    if (this.closed || !this.settings().enabled) return;
    const signal = this.controller.signal;
    if (this.viewTasks.size >= 16) {
      // Do not allocate another pending task merely to report saturation.
      try {
        this.store.refuseViewedJob(
          source.sessionId,
          source.projectId,
          "Viewed window queue full",
        );
      } catch {
        this.lastError = "Evidence could not be saved";
      }
      return;
    }
    // Bound retained references even when many tabs return large detail windows.
    const selected: VisibleMessageText[] = [];
    let bytes = 0;
    let partial = false;
    let records = 0;
    for (const message of messages) {
      if (++records > 16_000) {
        partial = true;
        break;
      }
      const text = visibleMessageTextWithSourceId(message);
      if (!text) continue;
      const size = text.text.length * 2 + 512;
      if (bytes + size + this.viewBytes > 8 * 1024 * 1024) {
        partial = true;
        continue;
      }
      selected.push(text);
      bytes += size;
    }
    this.viewBytes += bytes;
    const task = (async () => {
      await yieldTurn();
      for (const text of selected) {
        if (signal.aborted) return;
        await this.captureChunked(source, text, signal);
      }
      if (!signal.aborted)
        this.store.recordViewedJob(
          source.sessionId,
          source.projectId,
          partial ? "partial" : "viewed",
          partial ? "Viewed window exceeded acquisition budget" : null,
        );
    })()
      .catch(() => {
        if (!signal.aborted) this.lastError = "Evidence could not be saved";
      })
      .finally(() => {
        this.viewBytes -= bytes;
        this.viewTasks.delete(task);
        this.deps.confirm?.();
        this.kick();
      });
    this.viewTasks.add(task);
  }
  /** Continue durable resolution after a synchronous operator correction. */
  resumePendingWork(): void {
    this.kick();
  }
  private kick(): void {
    if (this.closed || this.work || !this.settings().enabled) return;
    const signal = this.controller.signal;
    this.work = this.drain()
      .catch(() => {
        this.lastError = "Index storage unavailable";
      })
      .finally(() => {
        this.work = undefined;
        if (signal !== this.controller.signal) this.kick();
      });
  }
  private async drain(): Promise<void> {
    const signal = this.controller.signal;
    while (!signal.aborted && !this.closed) {
      const resolved = this.store.processResolutions();
      const jobs = this.store.nextQueuedJobs(16);
      if (!jobs.length) {
        if (resolved) {
          await yieldTurn();
          continue;
        }
        return;
      }
      let processed = false;
      for (const job of jobs) {
        if (signal.aborted) return;
        if (job.catalogKey === null) {
          this.store.markJob(job.sessionId, "viewed");
          continue;
        }
        const found = await this.deps.row(job.catalogKey);
        if (signal.aborted) return;
        processed = true;
        if (!found) {
          // Gone from the catalog (its removal deletes the job) or not yet
          // projectable: the next sweep offers the row again, and admitting
          // it re-queues the paused job.
          this.store.markJob(job.sessionId, "paused");
          this.retry.add(job.catalogKey);
          continue;
        }
        const row = { ...found, sessionId: job.sessionId };
        const recent =
          this.settings().scope === "recent" &&
          Date.parse(row.updatedAt) >=
            Date.now() - this.settings().recentDays * 86400_000;
        if (!recent) {
          this.store.markJob(row.sessionId, "paused");
          continue;
        }
        this.store.markJob(row.sessionId, "indexing");
        try {
          const batch = await this.deps.read(row, {
            cursor: job.cursor,
            signal,
          });
          if (signal.aborted) return;
          if (!batch) {
            this.store.markJob(
              row.sessionId,
              "unsupported",
              "Background acquisition unavailable",
            );
            continue;
          }
          const source: IssueSource = {
            sessionId: row.sessionId,
            projectId:
              this.deps.projectForSession?.(row.sessionId) ?? row.projectId,
            sourceVersion: job.sourceVersion,
          };
          for (const message of batch.messages) {
            if (signal.aborted) return;
            await this.captureChunked(source, message, signal);
            if (signal.aborted) return;
          }
          this.store.recordJobBatch(row.sessionId, job.sourceVersion, {
            cursor: batch.cursor,
            state: batch.done
              ? batch.partial
                ? "partial"
                : "indexed"
              : "queued",
            error: batch.partial
              ? "Some source records could not be indexed"
              : null,
          });
        } catch {
          if (!signal.aborted)
            this.store.failJob(
              row.sessionId,
              job.sourceVersion,
              "Session source unavailable or changed",
            );
        }
        await yieldTurn();
      }
      this.deps.confirm?.();
      if (!processed) return;
    }
  }
  coverage() {
    return {
      settings: this.settings(),
      knownJiraProjects: this.store.knownJiraProjects(),
      active: Boolean(this.work || this.enumeration || this.viewTasks.size),
      error: this.lastError,
      counts: this.store.jobStateCounts(),
    };
  }
  /** Fence buffered observations before a user delete; old completed checkpoints stay put. */
  delete(id: string): void {
    this.fence();
    this.store.delete(id);
    this.kick();
  }
  async settled(): Promise<void> {
    while (this.enumeration || this.work || this.viewTasks.size) {
      await this.enumeration;
      await this.work;
      await Promise.all(this.viewTasks);
    }
  }
  async close(): Promise<void> {
    this.closed = true;
    this.controller.abort();
    await this.settled();
  }
}
