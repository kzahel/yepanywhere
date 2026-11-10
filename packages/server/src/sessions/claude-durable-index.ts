import {
  extendClaudeLinear,
  type ClaudeAppendRow,
  type ClaudeWriterFacts,
  type ClaudeLinearUpdate,
} from "./claude-linear-writer.js";
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
  type ClaudeTaskCheckpoint,
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
  writerVersion?: number;
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
        "SELECT generation,revision FROM claude_transcript_sources WHERE path=?",
      ).get<Pick<HeaderRow, "generation" | "revision">>(path);
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
      if (source.overlay) {
        const tail = await readTranscriptFile(
          source.path,
          accepted.header.parsedBytes,
          source.sourceHeader.stats.size - accepted.header.parsedBytes,
          (line, offset, info) => {
            const raw = JSON.parse(line) as ClaudeSessionEntry;
            return raw ? { raw, offset, info } : null;
          },
          source.fence,
        );
        if (tail.committedEntries)
          throw new ClaudeProjectionChangedError(
            "Provisional checkpoint contains committed rows",
          );
        for (const row of tail.entries)
          index.capture(row.raw, row.offset, row.info);
        if (!this.current(source.path, accepted))
          throw new ClaudeProjectionChangedError(
            "Claude SQL source changed during provisional restoration",
          );
      }
      this.publications.set(index, {
        generation: accepted.generation,
        revision: accepted.revision,
        records: rows.length,
        projection: index.projectionVersion,
      });
      return index;
    } finally {
      this.release();
    }
  }
  async appendRows(
    source: DurableClaudeSourceIndex,
    rows: ClaudeAppendRow[],
    input: ClaudeDurableSourceInput,
    isCurrent: () => boolean,
  ): Promise<DurableClaudeSourceIndex | null> {
    try {
      const { accepted, path } = source,
        generation = accepted.generation;
      if (
        accepted.header.writerVersion !== 1 ||
        (!input.hasProvisionalTail && input.parsedBytes !== input.stats.size) ||
        !input.appendFence
      )
        return null;
      const readRef = (query: string, ...args: SqliteValue[]) => {
        const row = this.sql(query).get<{ record: string }>(...args);
        return row ? (JSON.parse(row.record) as ClaudeVisibleRef) : undefined;
      };
      const facts: ClaudeWriterFacts = {
        node: (id) => {
          const row = this.sql(
            "SELECT active FROM claude_transcript_nodes WHERE generation=? AND uuid=?",
          ).get<{ active: number }>(generation, JSON.stringify(id));
          return row ? { active: !!row.active } : undefined;
        },
        tool: (id) => {
          const row = this.sql(
            "SELECT owner_uuid,has_result,is_task FROM claude_transcript_tools WHERE generation=? AND tool_id=?",
          ).get<{
            owner_uuid: string | null;
            has_result: number;
            is_task: number;
          }>(generation, JSON.stringify(id));
          return row
            ? {
                tool: id,
                owner:
                  row.owner_uuid === null
                    ? undefined
                    : JSON.parse(row.owner_uuid),
                hasResult: !!row.has_result,
                task: !!row.is_task,
              }
            : undefined;
        },
        tasks: () => {
          const row = this.sql(
            "SELECT CASE WHEN length(state)<=8388608 THEN state END AS state FROM claude_transcript_tasks WHERE generation=?",
          ).get<{ state: string | null }>(generation);
          return row?.state
            ? (JSON.parse(row.state) as ClaudeTaskCheckpoint)
            : undefined;
        },
        byOffset: (offset) =>
          readRef(
            "SELECT v.record FROM claude_transcript_offsets o JOIN claude_transcript_visible v ON v.generation=o.generation AND v.position=o.position WHERE o.generation=? AND o.source_offset=?",
            generation,
            offset,
          ),
        at: (position) =>
          position < 0
            ? undefined
            : readRef(
                "SELECT record FROM claude_transcript_visible WHERE generation=? AND position=?",
                generation,
                position,
              ),
        suffix: (position) =>
          this.sql(
            "SELECT record FROM claude_transcript_visible WHERE generation=? AND position>=? ORDER BY position LIMIT 257",
          )
            .all<{ record: string }>(generation, position)
            .map((r) => JSON.parse(r.record) as ClaudeVisibleRef),
        firstQueue: (after) => {
          const row = this.sql(
            "SELECT position,record FROM claude_transcript_queues WHERE generation=? AND source_offset>? ORDER BY source_offset LIMIT 1",
          ).get<{ position: number | null; record: string }>(generation, after);
          return row
            ? {
                position: row.position ?? undefined,
                record: JSON.parse(row.record),
              }
            : undefined;
        },
      };
      const update = extendClaudeLinear(
        accepted.header.state,
        accepted.header.committedEntries,
        input.hasProvisionalTail
          ? rows.map((row) => ({
              ...row,
              info: { ...row.info, committed: true },
            }))
          : rows,
        facts,
      );
      if (!update) return null;
      const header: Header = {
        ...accepted.header,
        state: update.state,
        stats: {
          dev: input.stats.dev,
          ino: input.stats.ino,
          size: input.stats.size,
          mtimeMs: input.stats.mtimeMs,
          ctimeMs: input.stats.ctimeMs,
        },
        parsedBytes: input.parsedBytes,
        committedEntries:
          accepted.header.committedEntries + update.records.length,
        malformedLines: input.malformedLines,
        fence: {
          ...input.appendFence,
          head: input.appendFence.head.toString("base64"),
          boundary: input.appendFence.boundary.toString("base64"),
        },
      };
      let compact = accepted.header.state.compactionCount;
      const compactOrdinals = new Map<number, number>();
      for (const ref of update.visible)
        if (
          ref.raw.type === "system" &&
          (ref.raw as { subtype?: string }).subtype === "compact_boundary"
        ) {
          const old =
            ref.record &&
            this.sql(
              "SELECT v.compact_ordinal FROM claude_transcript_offsets o JOIN claude_transcript_visible v ON v.generation=o.generation AND v.position=o.position WHERE o.generation=? AND o.source_offset=?",
            ).get<{ compact_ordinal: number }>(generation, ref.record.offset);
          compactOrdinals.set(ref.position, old?.compact_ordinal ?? ++compact);
        }
      if (input.hasProvisionalTail) {
        if (!isCurrent() || !this.current(path, accepted))
          throw new ClaudeProjectionChangedError(
            "Claude provisional SQL owner changed",
          );
        return new DurableClaudeSourceIndex(this, path, accepted, {
          header,
          update,
          compactOrdinals,
        });
      }
      this.database.transaction(() => {
        if (!isCurrent() || !this.current(path, accepted))
          throw new ClaudeProjectionChangedError(
            "Claude SQL append owner changed",
          );
        if (update.replaceFrom !== undefined) {
          this.sql(
            "DELETE FROM claude_transcript_offsets WHERE generation=? AND position>=?",
          ).run(generation, update.replaceFrom);
          this.sql(
            "DELETE FROM claude_transcript_visible WHERE generation=? AND position>=?",
          ).run(generation, update.replaceFrom);
        }
        for (const row of update.records)
          this.sql(
            "INSERT OR REPLACE INTO claude_transcript_records(generation,ordinal,record) VALUES(?,?,?)",
          ).run(generation, row.ordinal, JSON.stringify(row));
        for (const [uuid, active] of update.nodes)
          this.sql(
            "INSERT OR REPLACE INTO claude_transcript_nodes(generation,uuid,active) VALUES(?,?,?)",
          ).run(generation, JSON.stringify(uuid), active ? 1 : 0);
        for (const t of update.tools.values())
          this.sql(
            "INSERT OR REPLACE INTO claude_transcript_tools(generation,tool_id,owner_uuid,has_result,is_task) VALUES(?,?,?,?,?)",
          ).run(
            generation,
            JSON.stringify(t.tool),
            t.owner === undefined ? null : JSON.stringify(t.owner),
            t.hasResult ? 1 : 0,
            t.task ? 1 : 0,
          );
        for (const [tool, orphan] of update.orphans) {
          if (orphan)
            this.sql(
              "INSERT OR IGNORE INTO claude_transcript_orphans(generation,tool_id) VALUES(?,?)",
            ).run(generation, JSON.stringify(tool));
          else
            this.sql(
              "DELETE FROM claude_transcript_orphans WHERE generation=? AND tool_id=?",
            ).run(generation, JSON.stringify(tool));
        }
        if (update.tasks)
          this.sql(
            "INSERT OR REPLACE INTO claude_transcript_tasks(generation,state) VALUES(?,?)",
          ).run(generation, JSON.stringify(update.tasks));
        for (const q of update.queued)
          this.sql(
            "INSERT OR REPLACE INTO claude_transcript_queues(generation,source_offset,position,record) VALUES(?,?,?,?)",
          ).run(
            generation,
            q.record.offset,
            q.position ?? null,
            JSON.stringify(q.record),
          );
        for (const offset of update.dequeued)
          this.sql(
            "DELETE FROM claude_transcript_queues WHERE generation=? AND source_offset=?",
          ).run(generation, offset);
        for (const ref of update.visible) {
          const raw = ref.raw as unknown as Record<string, unknown>;
          this.sql(
            "INSERT OR REPLACE INTO claude_transcript_visible(generation,position,message_id,compact_ordinal,group_id,delivered_ms,record) VALUES(?,?,?,?,?,?,?)",
          ).run(
            generation,
            ref.position,
            typeof raw.uuid === "string"
              ? JSON.stringify(raw.uuid)
              : raw.type === "queue-operation"
                ? JSON.stringify(
                    `queue-operation-${ref.position}-${raw.timestamp ?? ""}`,
                  )
                : null,
            compactOrdinals.get(ref.position) ?? null,
            typeof raw.rewoundGroupId === "string"
              ? JSON.stringify(raw.rewoundGroupId)
              : null,
            typeof raw.queueDeliveredAt === "string" &&
              Number.isFinite(Date.parse(raw.queueDeliveredAt))
              ? Date.parse(raw.queueDeliveredAt)
              : null,
            JSON.stringify(ref),
          );
        }
        for (const ref of update.visible)
          if (ref.record)
            this.sql(
              "INSERT OR REPLACE INTO claude_transcript_offsets(generation,source_offset,position) VALUES(?,?,?)",
            ).run(generation, ref.record.offset, ref.position);
        this.sql(
          "UPDATE claude_transcript_sources SET revision=revision+1,header=? WHERE path=? AND generation=? AND revision=?",
        ).run(JSON.stringify(header), path, generation, accepted.revision);
      });
      return new DurableClaudeSourceIndex(this, path, {
        generation,
        revision: accepted.revision + 1,
        header,
      });
    } finally {
      this.release();
    }
  }
  /** Full selector results replace a complete generation. Only appendRows writes deltas. */
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
      const previous = this.publications.get(index),
        accepted = this.accepted(path);
      if (
        previous &&
        (accepted?.generation !== previous.generation ||
          accepted.revision !== previous.revision)
      )
        throw new ClaudeProjectionChangedError(
          "Claude SQL writer lost its generation",
        );
      if (
        previous &&
        accepted?.header.writerVersion === 1 &&
        previous.projection === index.projectionVersion &&
        previous.records === index.rows.length &&
        accepted.header.stats.size === input.stats.size &&
        accepted.header.stats.mtimeMs === input.stats.mtimeMs &&
        accepted.header.stats.ctimeMs === input.stats.ctimeMs
      )
        return;
      const generation = randomUUID(),
        revision = (accepted?.revision ?? 0) + 1;
      const header: Header = {
        format: FORMAT,
        writerVersion: 1,
        state,
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
      };
      const records = index.sourceRecords(),
        visible = index.visibleRecords(),
        nodes = index.nodeFacts(),
        tools = index.toolFacts(),
        queued = index.queuedFacts(),
        orphans = index.orphanTools()[Symbol.iterator]();
      let compactOrdinal = 0;
      const batch = <T>(iterator: Iterator<T>, write: (value: T) => void) => {
        let work = false;
        for (let n = 0; n < 256; n++) {
          const item = iterator.next();
          if (item.done) break;
          work = true;
          write(item.value);
        }
        return work;
      };
      this.sql(
        "INSERT INTO claude_transcript_generations(generation,path,owner,lease_until) VALUES(?,?,?,?)",
      ).run(generation, path, this.owner, Date.now() + BUILD_LEASE_MS);
      let published = false;
      try {
        for (;;) {
          const work = this.database.transaction(() => {
            if (
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
            let work = false;
            work =
              batch(nodes, (n) =>
                this.sql(
                  "INSERT OR REPLACE INTO claude_transcript_nodes(generation,uuid,active) VALUES(?,?,?)",
                ).run(generation, JSON.stringify(n.uuid), n.active ? 1 : 0),
              ) || work;
            work =
              batch(tools, (t) =>
                this.sql(
                  "INSERT OR REPLACE INTO claude_transcript_tools(generation,tool_id,owner_uuid,has_result,is_task) VALUES(?,?,?,?,?)",
                ).run(
                  generation,
                  JSON.stringify(t.tool),
                  t.owner === undefined ? null : JSON.stringify(t.owner),
                  t.hasResult ? 1 : 0,
                  t.task ? 1 : 0,
                ),
              ) || work;
            work =
              batch(queued, (q) =>
                this.sql(
                  "INSERT OR REPLACE INTO claude_transcript_queues(generation,source_offset,position,record) VALUES(?,?,?,?)",
                ).run(
                  generation,
                  q.record.offset,
                  q.position ?? null,
                  JSON.stringify(q.record),
                ),
              ) || work;
            work =
              batch(records, (r) =>
                this.sql(
                  "INSERT OR REPLACE INTO claude_transcript_records(generation,ordinal,record) VALUES(?,?,?)",
                ).run(generation, r.ordinal, JSON.stringify(r)),
              ) || work;
            const offsets: Array<[number, number]> = [];
            work =
              batch(visible, (ref) => {
                const raw = ref.raw as unknown as Record<string, unknown>;
                this.sql(
                  "INSERT OR REPLACE INTO claude_transcript_visible(generation,position,message_id,compact_ordinal,group_id,delivered_ms,record) VALUES(?,?,?,?,?,?,?)",
                ).run(
                  generation,
                  ref.position,
                  typeof raw.uuid === "string"
                    ? JSON.stringify(raw.uuid)
                    : raw.type === "queue-operation"
                      ? JSON.stringify(
                          `queue-operation-${ref.position}-${raw.timestamp ?? ""}`,
                        )
                      : null,
                  raw.type === "system" && raw.subtype === "compact_boundary"
                    ? ++compactOrdinal
                    : null,
                  typeof raw.rewoundGroupId === "string"
                    ? JSON.stringify(raw.rewoundGroupId)
                    : null,
                  typeof raw.queueDeliveredAt === "string" &&
                    Number.isFinite(Date.parse(raw.queueDeliveredAt))
                    ? Date.parse(raw.queueDeliveredAt)
                    : null,
                  JSON.stringify(ref),
                );
                if (ref.record) offsets.push([ref.record.offset, ref.position]);
              }) || work;
            for (const [offset, position] of offsets)
              this.sql(
                "INSERT OR REPLACE INTO claude_transcript_offsets(generation,source_offset,position) VALUES(?,?,?)",
              ).run(generation, offset, position);
            work =
              batch(orphans, (tool) =>
                this.sql(
                  "INSERT OR IGNORE INTO claude_transcript_orphans(generation,tool_id) VALUES(?,?)",
                ).run(generation, JSON.stringify(tool)),
              ) || work;
            return work;
          });
          this.release();
          if (!work) break;
          await setImmediate();
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
            this.sql(
              "UPDATE claude_transcript_generations SET lease_until=0 WHERE generation=? AND owner=? AND lease_until>?",
            ).run(generation, this.owner, Date.now()).changes !== 1
          )
            throw new ClaudeProjectionChangedError(
              "Claude SQL staging lease lost before publication",
            );
          this.sql(
            "INSERT OR REPLACE INTO claude_transcript_tasks(generation,state) VALUES(?,?)",
          ).run(generation, JSON.stringify(index.durableTasks()));
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
          projection: index.projectionVersion,
        });
        if (accepted && accepted.generation !== generation)
          await this.retire(accepted.generation);
      } finally {
        if (!published) await this.retire(generation);
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
        ["claude_transcript_nodes", "uuid"],
        ["claude_transcript_tools", "tool_id"],
        ["claude_transcript_offsets", "source_offset"],
        ["claude_transcript_tasks", "generation"],
        ["claude_transcript_queues", "source_offset"],
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
        generation = accepted.generation,
        state = source.sourceHeader.state,
        overlay = source.overlay;
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
      const byPosition = new Map(
        overlay?.update.visible.map((ref) => [ref.position, ref]),
      );
      const byOffset = new Map(
        overlay?.update.visible
          .filter((ref) => !!ref.record)
          .map((ref) => [ref.record!.offset, ref]),
      );
      const messageId = (ref: ClaudeVisibleRef) => {
        const row = ref.raw as unknown as {
          uuid?: string;
          type: string;
          timestamp?: string;
        };
        return (
          row.uuid ??
          (row.type === "queue-operation"
            ? `queue-operation-${ref.position}-${row.timestamp ?? ""}`
            : undefined)
        );
      };
      const byId = new Map(
        overlay?.update.visible.map((ref) => [messageId(ref), ref]),
      );
      const actual = (ref: ClaudeVisibleRef) =>
        ref.record
          ? (byOffset.get(ref.record.offset) ?? ref)
          : (byId.get(messageId(ref)) ?? ref);
      const decode = (row: { record: string } | undefined) =>
        row ? actual(JSON.parse(row.record) as ClaudeVisibleRef) : undefined;
      const lookup = (id: string) => {
        const changed = byId.get(id);
        if (changed) return changed;
        const saved = decode(
          this.sql(
            "SELECT position,compact_ordinal,record FROM claude_transcript_visible WHERE generation=? AND message_id=? ORDER BY position DESC LIMIT 1",
          ).get<VisibleRow>(generation, JSON.stringify(id)),
        );
        return saved && messageId(saved) === id ? saved : undefined;
      };
      const at = (position: number) =>
        byPosition.get(position) ??
        decode(
          this.sql(
            "SELECT record FROM claude_transcript_visible WHERE generation=? AND position=?",
          ).get<{ record: string }>(generation, position),
        );
      const anchor = request.afterMessageId
        ? lookup(request.afterMessageId)
        : undefined;
      const before = request.beforeMessageId
        ? lookup(request.beforeMessageId)
        : undefined;
      const end = request.beforeMessageId
        ? (before?.position ?? 0)
        : state.visibleCount;
      // Only a recent suffix can move provisionally. At most256 old compacts
      // can be displaced past an older-page boundary.
      const candidates = this.sql(
        "SELECT position,compact_ordinal,record FROM claude_transcript_visible WHERE generation=? AND compact_ordinal IS NOT NULL AND position<? ORDER BY position DESC LIMIT ?",
      ).all<VisibleRow>(
        generation,
        end,
        1 +
          (overlay?.update.visible.filter(
            (ref) =>
              ref.record &&
              ref.record.offset < accepted.header.parsedBytes &&
              ref.raw.type === "system" &&
              (ref.raw as { subtype?: string }).subtype === "compact_boundary",
          ).length ?? 0),
      );
      let boundaryEnd = 0;
      for (const row of candidates)
        if (decode(row)!.position < end) {
          boundaryEnd = row.compact_ordinal ?? 0;
          break;
        }
      for (const [position, ordinal] of overlay?.compactOrdinals ?? [])
        if (position < end) boundaryEnd = Math.max(boundaryEnd, ordinal);
      const wanted = boundaryEnd - request.compactions + 1;
      let startBoundary: ClaudeVisibleRef | undefined;
      for (const [position, ordinal] of overlay?.compactOrdinals ?? [])
        if (ordinal === wanted) startBoundary = byPosition.get(position);
      startBoundary ??= decode(
        this.sql(
          "SELECT position,compact_ordinal,record FROM claude_transcript_visible INDEXED BY claude_transcript_visible_compact WHERE generation=? AND compact_ordinal=?",
        ).get<VisibleRow>(generation, wanted),
      );
      let start = startBoundary?.position ?? 0,
        omitted = !!startBoundary;
      if (request.afterMessageId) {
        start = anchor?.position ?? 0;
        omitted = start > 0;
      } else {
        let group = (at(start)?.raw as { rewoundGroupId?: string } | undefined)
          ?.rewoundGroupId;
        const seen = new Set<string>();
        while (group && !seen.has(group)) {
          seen.add(group);
          const first = decode(
            this.sql(
              "SELECT position,compact_ordinal,record FROM claude_transcript_visible WHERE generation=? AND group_id=? ORDER BY position LIMIT 1",
            ).get<VisibleRow>(generation, JSON.stringify(group)),
          );
          if (!first) break;
          start = Math.min(start, first.position);
          group = (first.raw as { rewoundParentGroupId?: string })
            .rewoundParentGroupId;
        }
      }
      const maxBytes = request.maxBytes ?? 192 * 1024 ** 2,
        selected: ClaudeVisibleRef[] = [];
      let charge = source.retainedBytes;
      const collect = (ref: ClaudeVisibleRef) => {
        charge +=
          Buffer.byteLength(JSON.stringify(ref)) + (ref.record?.length ?? 0);
        if (charge > maxBytes) return false;
        selected.push(ref);
        return true;
      };
      if (anchor) {
        const stamp = Date.parse(
          (anchor.raw as { timestamp?: string }).timestamp ?? "",
        );
        const late = new Map<number, ClaudeVisibleRef>();
        let lateCharge = 0;
        const stageLate = (ref: ClaudeVisibleRef) => {
          if (!late.has(ref.position))
            lateCharge +=
              Buffer.byteLength(JSON.stringify(ref)) +
              (ref.record?.length ?? 0);
          if (source.retainedBytes + lateCharge > maxBytes) return false;
          late.set(ref.position, ref);
          return true;
        };
        if (Number.isFinite(stamp)) {
          let from = -1;
          while (true) {
            const rows = this.sql(
              "SELECT position,record FROM claude_transcript_visible INDEXED BY claude_transcript_visible_delivery WHERE generation=? AND delivered_ms>? AND position>? AND position<? ORDER BY position LIMIT 256",
            ).all<{ position: number; record: string }>(
              generation,
              stamp,
              from,
              anchor.position,
            );
            for (const row of rows) {
              const ref = decode(row)!;
              if (ref.position < anchor.position && !stageLate(ref))
                return null;
            }
            if (rows.length < 256) break;
            from = rows[rows.length - 1]!.position;
          }
          for (const ref of overlay?.update.visible ?? []) {
            const delivered = Date.parse(
              (ref.raw as { queueDeliveredAt?: string }).queueDeliveredAt ?? "",
            );
            if (
              ref.position < anchor.position &&
              delivered > stamp &&
              !stageLate(ref)
            )
              return null;
          }
          for (const ref of [...late.values()].sort(
            (a, b) => a.position - b.position,
          ))
            if (!collect(ref)) return null;
        }
      }
      for (let from = start; from < end; from += 256) {
        const through = Math.min(end, from + 256);
        const rows = this.sql(
          "SELECT position,record FROM claude_transcript_visible WHERE generation=? AND position>=? AND position<? ORDER BY position LIMIT 256",
        ).all<{ position: number; record: string }>(generation, from, through);
        const page = new Map(
          rows.map((row) => [
            row.position,
            JSON.parse(row.record) as ClaudeVisibleRef,
          ]),
        );
        for (let position = from; position < through; position++) {
          const ref = byPosition.get(position) ?? page.get(position);
          if (!ref) {
            if (!this.current(path, accepted))
              throw new ClaudeProjectionChangedError(
                "Claude SQL generation retired during selection",
              );
            throw new Error("Incomplete Claude visible checkpoint");
          }
          if (!collect(ref)) return null;
        }
      }
      const orphaned: string[] = [];
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
            if (
              id &&
              (overlay?.update.orphans.has(id)
                ? overlay.update.orphans.get(id)
                : !!this.sql(
                    "SELECT tool_id FROM claude_transcript_orphans WHERE generation=? AND tool_id=?",
                  ).get(generation, JSON.stringify(id)))
            )
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
        {
          omitted,
          end,
          boundaryEnd: boundaryEnd,
          maxBytes,
          fence: request.fence,
        },
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
    readonly overlay?: {
      header: Header;
      update: ClaudeLinearUpdate;
      compactOrdinals: Map<number, number>;
    },
  ) {
    super();
    this.historyEvidence = store.history(this);
  }
  override get generation() {
    return this.sourceHeader.committedEntries;
  }
  override get retainedBytes() {
    return (
      Buffer.byteLength(JSON.stringify(this.sourceHeader)) +
      (this.overlay
        ? Buffer.byteLength(JSON.stringify(this.overlay.update)) +
          this.overlay.update.records.reduce((n, r) => n + r.record.length, 0)
        : 0)
    );
  }
  override view() {
    return this;
  }
  override summary() {
    if (this.coldSummary) return this.coldSummary;
    const { state } = this.sourceHeader;
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
    return this.overlay?.header ?? this.accepted.header;
  }
  get fence() {
    return decodeFence(this.sourceHeader);
  }
}
function decodeFence(header: Header): TranscriptAppendFence {
  return {
    ...header.fence,
    head: Buffer.from(header.fence.head, "base64"),
    boundary: Buffer.from(header.fence.boundary, "base64"),
  };
}
