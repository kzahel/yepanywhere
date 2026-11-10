import { randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import { setImmediate } from "node:timers/promises";
import type { ClaudeSessionEntry } from "@yep-anywhere/shared";
import type {
  SqliteDatabase,
  SqliteStatement,
  SqliteValue,
} from "../storage/sqlite.js";
import {
  ClaudeSourceIndex,
  ClaudeProjectionChangedError,
  type ClaudeDurableState,
  type ClaudeStoredRecord,
  type ClaudeVisibleRef,
} from "./claude-source-index.js";
import { projectedClaudeSummary } from "./claude-index-summary.js";
import { createParseState } from "./claude-summary.js";
import {
  readTranscriptFile,
  type TranscriptAppendFence,
} from "./transcript-ingestion.js";

// Bump when skeleton, selector, converter, summary or task semantics change.
const FORMAT = 1;
const BUILD_LEASE_MS = 60_000;
interface SourceVersion {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}
interface Header {
  format: number;
  stats: SourceVersion;
  parsedBytes: number;
  committedEntries: number;
  malformedLines: number;
  fence: Omit<TranscriptAppendFence, "head" | "boundary"> & {
    head: string;
    boundary: string;
  };
  state: ClaudeDurableState;
}
interface Accepted {
  generation: string;
  revision: number;
  header: Header;
}
interface HeaderRow {
  generation: string;
  revision: number;
  header: string;
}
interface VisibleRow {
  position: number;
  compact_ordinal: number | null;
  record: string;
}
interface Publication {
  generation: string;
  revision: number;
  records: number;
  compactions: number;
  projection: number;
}
export interface ClaudeDurableSourceInput {
  stats: Stats;
  parsedBytes: number;
  committedEntries: number;
  malformedLines: number;
  appendFence?: TranscriptAppendFence;
  hasProvisionalTail: boolean;
}

/** Profile-owned rebuildable facts. No process-lifetime corpus or payload mirror. */
export class ClaudeDurableIndexStore {
  // One native statement at a time; batch loops reuse it. No extra connection
  // or raised global ceiling is needed alongside the profile's other owners.
  private prepared?: { query: string; statement: SqliteStatement };
  private publications = new WeakMap<ClaudeSourceIndex, Publication>();
  private closed = false;
  private readonly owner = randomUUID();
  constructor(private readonly database: SqliteDatabase) {}
  private prepare(query: string) {
    if (this.closed) throw new Error("Claude transcript store is closed");
    if (this.prepared?.query !== query) {
      this.prepared?.statement.finalize();
      this.prepared = undefined;
      this.prepared = { query, statement: this.database.prepare(query) };
    }
    return this.prepared.statement;
  }
  private sql(query: string): SqliteStatement {
    return {
      get: <Row>(...parameters: SqliteValue[]) =>
        this.prepare(query).get<Row>(...parameters),
      all: <Row>(...parameters: SqliteValue[]) =>
        this.prepare(query).all<Row>(...parameters),
      run: (...parameters: SqliteValue[]) =>
        this.prepare(query).run(...parameters),
      finalize: () => {
        if (this.prepared?.query === query) {
          this.prepared.statement.finalize();
          this.prepared = undefined;
        }
      },
    };
  }
  private release() {
    this.prepared?.statement.finalize();
    this.prepared = undefined;
  }
  close() {
    this.closed = true;
    this.release();
  }
  private accepted(path: string): Accepted | undefined {
    try {
      const row = this.sql(
        "SELECT generation,revision,header FROM claude_transcript_sources WHERE path=?",
      ).get<HeaderRow>(path);
      this.release();
      if (!row) return;
      const header = JSON.parse(row.header) as Header;
      if (header.format !== FORMAT) return;
      return { ...row, header };
    } finally {
      this.release();
    }
  }
  async load(
    path: string,
    stats: Stats,
  ): Promise<DurableClaudeSourceIndex | undefined> {
    try {
      await this.recoverAbandoned(path);
      const accepted = this.accepted(path);
      if (!accepted) return;
      const old = accepted.header.stats;
      if (
        old.dev !== stats.dev ||
        old.ino !== stats.ino ||
        old.size > stats.size ||
        (old.size === stats.size &&
          (old.mtimeMs !== stats.mtimeMs || old.ctimeMs !== stats.ctimeMs))
      )
        return;
      // Even unchanged metadata must validate persisted byte evidence after restart.
      await readTranscriptFile(
        path,
        old.size,
        0,
        () => null,
        decodeFence(accepted.header),
      );
      return new DurableClaudeSourceIndex(this, path, accepted);
    } finally {
      this.release();
    }
  }
  current(path: string, accepted: Accepted): boolean {
    try {
      const row = this.sql(
        "SELECT generation,revision,header FROM claude_transcript_sources WHERE path=?",
      ).get<HeaderRow>(path);
      this.release();
      return (
        row?.generation === accepted.generation &&
        row.revision === accepted.revision
      );
    } finally {
      this.release();
    }
  }
  async materialize(
    source: DurableClaudeSourceIndex,
  ): Promise<ClaudeSourceIndex> {
    try {
      const { accepted } = source;
      const rows: ClaudeStoredRecord[] = [];
      let from = 0;
      while (from < accepted.header.committedEntries) {
        const page = this.sql(
          "SELECT record FROM claude_transcript_records WHERE generation=? AND ordinal>=? ORDER BY ordinal LIMIT 256",
        ).all<{ record: string }>(accepted.generation, from);
        this.release();
        if (!page.length) {
          if (!this.current(source.path, accepted))
            throw new ClaudeProjectionChangedError(
              "Claude SQL source retired during materialization",
            );
          throw new Error("Incomplete Claude source checkpoint");
        }
        for (const row of page)
          rows.push(JSON.parse(row.record) as ClaudeStoredRecord);
        from += page.length;
        await setImmediate();
      }
      if (!this.current(source.path, accepted))
        throw new ClaudeProjectionChangedError(
          "Claude SQL generation changed during materialization",
        );
      const index = ClaudeSourceIndex.restore(accepted.header.state, rows);
      index.acknowledgePublication();
      this.publications.set(index, {
        generation: accepted.generation,
        revision: accepted.revision,
        records: rows.length,
        compactions: accepted.header.state.compactionCount,
        projection: index.projectionVersion,
      });
      return index;
    } finally {
      this.release();
    }
  }
  async publish(
    path: string,
    index: ClaudeSourceIndex,
    input: ClaudeDurableSourceInput,
    isCurrent: () => boolean = () => true,
  ): Promise<void> {
    try {
      if (
        !input.appendFence ||
        input.hasProvisionalTail ||
        input.parsedBytes !== input.stats.size
      )
        return;
      const state = structuredClone(index.durableState());
      const sourceGeneration = index.generation,
        projectionVersion = index.projectionVersion;
      if (state.requiresCompleteProjection) return;
      const previous = this.publications.get(index);
      const accepted = this.accepted(path);
      if (
        previous &&
        (accepted?.generation !== previous.generation ||
          accepted.revision !== previous.revision)
      )
        throw new ClaudeProjectionChangedError(
          "Claude SQL writer lost its generation",
        );
      const rebuild = !previous || index.projectionRebuilt;
      const generation = rebuild ? randomUUID() : previous.generation;
      if (
        previous &&
        previous.projection === index.projectionVersion &&
        previous.records === index.rows.length &&
        accepted?.header.stats.size === input.stats.size &&
        accepted.header.stats.mtimeMs === input.stats.mtimeMs &&
        accepted.header.stats.ctimeMs === input.stats.ctimeMs
      )
        return;
      const revision = (accepted?.revision ?? 0) + 1;
      const header: Header = {
        format: FORMAT,
        stats: {
          dev: input.stats.dev,
          ino: input.stats.ino,
          size: input.stats.size,
          mtimeMs: input.stats.mtimeMs,
          ctimeMs: input.stats.ctimeMs,
        },
        parsedBytes: input.parsedBytes,
        committedEntries: input.committedEntries,
        malformedLines: input.malformedLines,
        fence: {
          ...input.appendFence,
          head: input.appendFence.head.toString("base64"),
          boundary: input.appendFence.boundary.toString("base64"),
        },
        state,
      };
      const writeRecord = this.sql(
        "INSERT OR REPLACE INTO claude_transcript_records(generation,ordinal,record) VALUES(?,?,?)",
      );
      const writeVisible = this.sql(
        "INSERT OR REPLACE INTO claude_transcript_visible(generation,position,message_id,compact_ordinal,group_id,delivered_ms,record) VALUES(?,?,?,?,?,?,?)",
      );
      const writeOrphan = this.sql(
        "INSERT OR IGNORE INTO claude_transcript_orphans(generation,tool_id) VALUES(?,?)",
      );
      const deleteOrphan = this.sql(
        "DELETE FROM claude_transcript_orphans WHERE generation=? AND tool_id=?",
      );
      const sourceRows = index.sourceRecords(rebuild ? 0 : previous.records);
      let compactOrdinal = rebuild ? 0 : previous.compactions;
      const visible = rebuild
        ? index.visibleRecords()
        : index.changedVisible.values();
      const writeProjection = (ref: ClaudeVisibleRef) => {
        const raw = ref.raw as unknown as Record<string, unknown>;
        const compact =
          raw.type === "system" && raw.subtype === "compact_boundary";
        writeVisible.run(
          generation,
          ref.position,
          typeof raw.uuid === "string"
            ? JSON.stringify(raw.uuid)
            : raw.type === "queue-operation"
              ? JSON.stringify(
                  `queue-operation-${ref.position}-${raw.timestamp ?? ""}`,
                )
              : null,
          compact ? ++compactOrdinal : null,
          typeof raw.rewoundGroupId === "string"
            ? JSON.stringify(raw.rewoundGroupId)
            : null,
          typeof raw.queueDeliveredAt === "string" &&
            Number.isFinite(Date.parse(raw.queueDeliveredAt))
            ? Date.parse(raw.queueDeliveredAt)
            : null,
          JSON.stringify(ref),
        );
      };
      const orphans = index.orphanTools()[Symbol.iterator]();
      const writeBatch = (limit: number): boolean => {
        let done = true;
        const execute = () => {
          if (
            rebuild &&
            this.sql(
              "UPDATE claude_transcript_generations SET lease_until=? WHERE generation=? AND owner=? AND lease_until>?",
            ).run(
              Date.now() + BUILD_LEASE_MS,
              generation,
              this.owner,
              Date.now(),
            ).changes !== 1
          )
            throw new ClaudeProjectionChangedError(
              "Claude SQL staging lease expired",
            );
          for (let n = 0; n < limit; n++) {
            const row = sourceRows.next();
            if (row.done) break;
            done = false;
            writeRecord.run(
              generation,
              row.value.ordinal,
              JSON.stringify(row.value),
            );
          }
          for (let n = 0; n < limit; n++) {
            const row = visible.next();
            if (row.done) break;
            done = false;
            writeProjection(row.value);
          }
          if (rebuild)
            for (let n = 0; n < limit; n++) {
              const row = orphans.next();
              if (row.done) break;
              done = false;
              writeOrphan.run(generation, JSON.stringify(row.value));
            }
        };
        if (rebuild) this.database.transaction(execute);
        else execute();
        this.release();
        return done;
      };
      if (rebuild)
        this.sql(
          "INSERT INTO claude_transcript_generations(generation,path,owner,lease_until) VALUES(?,?,?,?)",
        ).run(generation, path, this.owner, Date.now() + BUILD_LEASE_MS);
      let published = false;
      try {
        if (rebuild) {
          // Staging generations are invisible until the header swaps atomically.
          while (!writeBatch(256)) await setImmediate();
        }
        this.database.transaction(() => {
          if (
            !isCurrent() ||
            sourceGeneration !== index.generation ||
            projectionVersion !== index.projectionVersion
          )
            throw new ClaudeProjectionChangedError(
              "Claude metadata changed during SQL publication",
            );
          const now = this.accepted(path);
          if (
            now?.generation !== accepted?.generation ||
            now?.revision !== accepted?.revision
          )
            throw new ClaudeProjectionChangedError(
              "Claude SQL source changed before publication",
            );
          if (
            rebuild &&
            this.sql(
              "UPDATE claude_transcript_generations SET lease_until=0 WHERE generation=? AND owner=? AND lease_until>?",
            ).run(generation, this.owner, Date.now()).changes !== 1
          )
            throw new ClaudeProjectionChangedError(
              "Claude SQL staging lease lost before publication",
            );
          if (!rebuild) writeBatch(Number.MAX_SAFE_INTEGER);
          if (!rebuild)
            for (const tool of index.changedTools) {
              if (index.isOrphanTool(tool))
                writeOrphan.run(generation, JSON.stringify(tool));
              else deleteOrphan.run(generation, JSON.stringify(tool));
            }
          this.sql(
            "INSERT INTO claude_transcript_sources(path,generation,revision,header) VALUES(?,?,?,?) ON CONFLICT(path) DO UPDATE SET generation=excluded.generation,revision=excluded.revision,header=excluded.header",
          ).run(path, generation, revision, JSON.stringify(header));
        });
        this.release();
        published = true;
        this.publications.set(index, {
          generation,
          revision,
          records: index.rows.length,
          compactions: state.compactionCount,
          projection: index.projectionVersion,
        });
        index.acknowledgePublication();
        if (accepted && accepted.generation !== generation)
          await this.retire(accepted.generation);
      } finally {
        if (rebuild && !published) await this.retire(generation);
      }
    } finally {
      this.release();
    }
  }

  /** A claim is checked with the accepted header in every deletion transaction. */
  private retireBatch(generation: string): boolean {
    const done = this.database.transaction(() => {
      const accepted = this.sql(
        "SELECT path FROM claude_transcript_sources WHERE generation=? LIMIT 1",
      ).get(generation);
      const stage = this.sql(
        "SELECT owner,lease_until FROM claude_transcript_generations WHERE generation=?",
      ).get<{ owner: string; lease_until: number }>(generation);
      if (
        accepted ||
        !stage ||
        (stage.owner !== this.owner && stage.lease_until > Date.now())
      )
        return true;
      for (const [table, column] of [
        ["claude_transcript_records", "ordinal"],
        ["claude_transcript_visible", "position"],
        ["claude_transcript_orphans", "tool_id"],
      ]) {
        const changes = this.sql(
          `DELETE FROM ${table} WHERE generation=? AND ${column} IN (SELECT ${column} FROM ${table} WHERE generation=? LIMIT 256)`,
        ).run(generation, generation).changes;
        if (changes) return false;
      }
      this.sql(
        "DELETE FROM claude_transcript_generations WHERE generation=?",
      ).run(generation);
      return true;
    });
    this.release();
    return done;
  }
  private async retire(generation: string) {
    while (!this.retireBatch(generation)) await setImmediate();
  }
  /** One bounded recovery batch per acquisition; never reclaim a live lease. */
  private async recoverAbandoned(path: string) {
    const stage = this.sql(
      "SELECT generation FROM claude_transcript_generations WHERE path=? AND lease_until<=? AND generation NOT IN (SELECT generation FROM claude_transcript_sources WHERE path=?) ORDER BY lease_until LIMIT 1",
    ).get<{ generation: string }>(path, Date.now(), path);
    this.release();
    if (stage) this.retireBatch(stage.generation);
  }
  history(source: DurableClaudeSourceIndex) {
    const { accepted, path } = source;
    return {
      isCurrent: () => !this.closed && this.current(path, accepted),
      length: accepted.header.committedEntries,
      get: (ordinal: number): ClaudeSessionEntry | undefined => {
        if (this.closed || !this.current(path, accepted)) return;
        const row = this.sql(
          "SELECT record FROM claude_transcript_records WHERE generation=? AND ordinal=?",
        ).get<{ record: string }>(accepted.generation, ordinal);
        this.release();
        return row
          ? (JSON.parse(row.record) as ClaudeStoredRecord).record.raw
          : undefined;
      },
    };
  }
  async window(
    source: DurableClaudeSourceIndex,
    request: Parameters<ClaudeSourceIndex["window"]>[1],
  ) {
    try {
      const { accepted, path } = source,
        { state } = accepted.header,
        generation = accepted.generation;
      if (
        request.generation !== source.generation ||
        !this.current(path, accepted)
      )
        throw new ClaudeProjectionChangedError("Stale Claude SQL selection");
      if (
        JSON.stringify(request.rewindRecords ?? []) !==
        JSON.stringify(state.rewindRecords)
      )
        return null;
      const lookup = (id: string) =>
        this.sql(
          "SELECT position,compact_ordinal,record FROM claude_transcript_visible WHERE generation=? AND message_id=? ORDER BY position DESC LIMIT 1",
        ).get<VisibleRow>(generation, JSON.stringify(id));
      const anchor = request.afterMessageId
        ? lookup(request.afterMessageId)
        : undefined;
      const before = request.beforeMessageId
        ? lookup(request.beforeMessageId)
        : undefined;
      const end = request.beforeMessageId
        ? (before?.position ?? 0)
        : state.visibleCount;
      const boundary = this.sql(
        "SELECT position,compact_ordinal,record FROM claude_transcript_visible WHERE generation=? AND compact_ordinal IS NOT NULL AND position<? ORDER BY position DESC LIMIT 1",
      ).get<VisibleRow>(generation, end);
      const boundaryEnd = boundary?.compact_ordinal ?? 0;
      const startBoundary = this.sql(
        "SELECT position,compact_ordinal,record FROM claude_transcript_visible WHERE generation=? AND compact_ordinal=?",
      ).get<VisibleRow>(generation, boundaryEnd - request.compactions + 1);
      let start = startBoundary?.position ?? 0,
        omitted = !!startBoundary;
      if (request.afterMessageId) {
        start = anchor?.position ?? 0;
        omitted = start > 0;
      } else {
        const seen = new Set<string>();
        let row = this.sql(
          "SELECT record FROM claude_transcript_visible WHERE generation=? AND position=?",
        ).get<{ record: string }>(generation, start);
        while (row) {
          const ref = JSON.parse(row.record) as ClaudeVisibleRef;
          const group = (ref.raw as { rewoundGroupId?: string }).rewoundGroupId;
          if (!group || seen.has(group)) break;
          seen.add(group);
          const first = this.sql(
            "SELECT position,compact_ordinal,record FROM claude_transcript_visible WHERE generation=? AND group_id=? ORDER BY position LIMIT 1",
          ).get<VisibleRow>(generation, JSON.stringify(group));
          if (!first) break;
          start = Math.min(start, first.position);
          row = first;
          const parent = (JSON.parse(first.record) as ClaudeVisibleRef).raw as {
            rewoundParentGroupId?: string;
          };
          if (!parent.rewoundParentGroupId) break;
          row = this.sql(
            "SELECT position,compact_ordinal,record FROM claude_transcript_visible WHERE generation=? AND group_id=? ORDER BY position LIMIT 1",
          ).get<VisibleRow>(
            generation,
            JSON.stringify(parent.rewoundParentGroupId),
          );
          if (row) start = Math.min(start, (row as VisibleRow).position);
        }
      }
      const maxBytes = request.maxBytes ?? 192 * 1024 ** 2;
      const selected: ClaudeVisibleRef[] = [];
      let charge = source.retainedBytes;
      const collect = (rows: { record: string }[]) => {
        for (const row of rows) {
          const ref = JSON.parse(row.record) as ClaudeVisibleRef;
          charge += Buffer.byteLength(row.record) + (ref.record?.length ?? 0);
          if (charge > maxBytes) return false;
          selected.push(ref);
        }
        return true;
      };
      if (anchor) {
        const timestamp = (JSON.parse(anchor.record) as ClaudeVisibleRef)
          .raw as {
          timestamp?: string;
        };
        const at = Date.parse(timestamp.timestamp ?? "");
        if (Number.isFinite(at)) {
          // Late queues are normally few; bound hydration before constructing a reply.
          let from = -1;
          while (true) {
            const rows = this.sql(
              "SELECT position,record FROM claude_transcript_visible INDEXED BY claude_transcript_visible_delivery WHERE generation=? AND delivered_ms>? AND position>? AND position<? ORDER BY position LIMIT 256",
            ).all<{ position: number; record: string }>(
              generation,
              at,
              from,
              anchor.position,
            );
            if (!collect(rows)) return null;
            if (rows.length < 256) break;
            from = rows[rows.length - 1]!.position;
          }
        }
      }
      let from = start;
      while (from < end) {
        const rows = this.sql(
          "SELECT position,record FROM claude_transcript_visible WHERE generation=? AND position>=? AND position<? ORDER BY position LIMIT 256",
        ).all<{ position: number; record: string }>(generation, from, end);
        if (!rows.length) {
          if (!this.current(path, accepted))
            throw new ClaudeProjectionChangedError(
              "Claude SQL generation retired during selection",
            );
          throw new Error("Incomplete Claude visible checkpoint");
        }
        if (!collect(rows)) return null;
        from = rows[rows.length - 1]!.position + 1;
      }
      const orphaned: string[] = [];
      const orphan = this.sql(
        "SELECT tool_id FROM claude_transcript_orphans WHERE generation=? AND tool_id=?",
      );
      for (const ref of selected) {
        const blocks =
          (ref.raw as { message?: { content?: unknown[] } }).message?.content ??
          [];
        for (const block of blocks)
          if (
            block &&
            typeof block === "object" &&
            (block as { type?: string }).type === "tool_use"
          ) {
            const id = (block as { id?: string }).id;
            if (id && orphan.get(generation, JSON.stringify(id)))
              orphaned.push(id);
          }
      }
      this.release();
      const hydration = new ClaudeSourceIndex();
      hydration.setOrphanTools(orphaned);
      const result = await hydration.hydrateSelection(
        path,
        selected,
        {
          messages: state.visibleCount,
          compactions: boundaryEnd,
          userTurns: state.userTurns,
        },
        { omitted, end, boundaryEnd, maxBytes, fence: request.fence },
      );
      if (!this.current(path, accepted))
        throw new ClaudeProjectionChangedError(
          "Claude SQL generation changed during hydration",
        );
      return result;
    } finally {
      this.release();
    }
  }
}
export class DurableClaudeSourceIndex extends ClaudeSourceIndex {
  private coldSummary?: ReturnType<ClaudeSourceIndex["summary"]>;
  readonly historyEvidence: ReturnType<ClaudeDurableIndexStore["history"]>;
  constructor(
    readonly store: ClaudeDurableIndexStore,
    readonly path: string,
    readonly accepted: Accepted,
  ) {
    super();
    this.historyEvidence = store.history(this);
  }
  override get generation() {
    return this.accepted.header.committedEntries;
  }
  override get retainedBytes() {
    return Buffer.byteLength(JSON.stringify(this.accepted.header));
  }
  override view() {
    return this;
  }
  override summary() {
    if (this.coldSummary) return this.coldSummary;
    const { state } = this.accepted.header;
    const source = createParseState();
    Object.assign(source, {
      firstTimestamp: state.firstTimestamp,
      firstUserTitleContent: state.firstUserTitleContent,
      firstUserTitleCaptured: state.firstUserTitleCaptured,
      metrics: state.metrics,
    });
    this.coldSummary = projectedClaudeSummary(
      source,
      state.witnesses,
      state.branchCount,
    );
    return this.coldSummary;
  }
  override window(
    _path: string,
    request: Parameters<ClaudeSourceIndex["window"]>[1],
  ) {
    return this.store.window(this, request);
  }
  get sourceHeader() {
    return this.accepted.header;
  }
  get fence() {
    return decodeFence(this.accepted.header);
  }
}
function decodeFence(header: Header): TranscriptAppendFence {
  return {
    ...header.fence,
    head: Buffer.from(header.fence.head, "base64"),
    boundary: Buffer.from(header.fence.boundary, "base64"),
  };
}
