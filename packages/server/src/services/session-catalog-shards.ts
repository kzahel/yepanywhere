/**
 * The retained catalog's on-disk generation format: one JSONL shard per
 * project bucket, written with a running digest, and the readers that parse
 * shards back into rows. `SessionCatalogService` owns publication, retention
 * and recovery; this module owns only bytes and rows.
 */
import { type Hash, createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { type FileHandle, open } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import {
  type SessionCatalogRow,
  sessionCatalogRowKey,
} from "../sessions/catalog-types.js";
import type { SessionCatalogShardSnapshot } from "./SessionCatalogService.js";

const SHARD_WRITE_FLUSH_BYTES = 256 * 1024;

export interface ProjectRowsValue {
  rows: ReadonlyArray<Readonly<SessionCatalogRow>>;
  bytes: number;
}

/**
 * One generation's complete rows in shard order, with each row's serialized
 * size so a project slice can be charged to the hot budget without
 * re-serializing it.
 */
export interface CatalogRowsValue {
  rows: ReadonlyArray<Readonly<SessionCatalogRow>>;
  rowBytes: readonly number[];
}

interface MutableShardStats {
  rowCount: number;
  bytes: number;
  digest: Hash;
  pending: Buffer[];
  pendingBytes: number;
  rows: Readonly<SessionCatalogRow>[];
  rowBytes: number[];
}

/**
 * Appends rows to their project's shard, buffering whole lines so one row is
 * not one write syscall, and digesting each shard so a later generation can
 * prove a bucket unchanged without reading it back.
 */
export class GenerationWriter {
  private readonly handles = new Map<number, FileHandle>();
  private readonly shardStats = new Map<number, MutableShardStats>();

  constructor(
    private readonly directory: string,
    private readonly bucketCount: number,
    private readonly maxRowBytes: number,
  ) {}

  async write(row: SessionCatalogRow): Promise<number> {
    const bucket = projectBucket(row.projectIdentityKey, this.bucketCount);
    const line = Buffer.from(`${JSON.stringify(row)}\n`);
    if (line.byteLength > this.maxRowBytes) {
      throw new Error(
        `Session catalog row exceeds ${this.maxRowBytes} bytes: ${sessionCatalogRowKey(row)}`,
      );
    }
    let stats = this.shardStats.get(bucket);
    if (!stats) {
      stats = {
        rowCount: 0,
        bytes: 0,
        digest: createHash("sha256"),
        pending: [],
        pendingBytes: 0,
        rows: [],
        rowBytes: [],
      };
      this.shardStats.set(bucket, stats);
    }
    stats.rowCount += 1;
    stats.bytes += line.byteLength;
    stats.rows.push(Object.freeze(row));
    stats.rowBytes.push(line.byteLength);
    stats.digest.update(line);
    stats.pending.push(line);
    stats.pendingBytes += line.byteLength;
    if (stats.pendingBytes >= SHARD_WRITE_FLUSH_BYTES) {
      await this.flush(bucket, stats);
    }
    return line.byteLength;
  }

  async close(): Promise<void> {
    for (const [bucket, stats] of this.shardStats) {
      if (stats.pendingBytes > 0) await this.flush(bucket, stats);
    }
    const handles = [...this.handles.values()];
    this.handles.clear();
    await Promise.all(handles.map((handle) => handle.close()));
  }

  /** Shard facts for the manifest; the caller assigns each one a generation. */
  snapshots(): Array<Omit<SessionCatalogShardSnapshot, "generation">> {
    return [...this.shardStats.entries()]
      .sort(([left], [right]) => left - right)
      .map(([bucket, value]) => ({
        bucket,
        file: shardFileName(bucket),
        rowCount: value.rowCount,
        bytes: value.bytes,
        contentHash: value.digest.copy().digest("hex"),
      }));
  }

  /**
   * Every written row in the order a whole-generation read returns them
   * (ascending bucket, then write order), so publication can retain the
   * generation without reading it back.
   */
  writtenRows(): CatalogRowsValue {
    const rows: Readonly<SessionCatalogRow>[] = [];
    const rowBytes: number[] = [];
    for (const [, stats] of [...this.shardStats.entries()].sort(
      ([left], [right]) => left - right,
    )) {
      for (let index = 0; index < stats.rows.length; index += 1) {
        rows.push(stats.rows[index]!);
        rowBytes.push(stats.rowBytes[index]!);
      }
    }
    return { rows: Object.freeze(rows), rowBytes: Object.freeze(rowBytes) };
  }

  private async flush(bucket: number, stats: MutableShardStats): Promise<void> {
    let handle = this.handles.get(bucket);
    if (!handle) {
      handle = await open(join(this.directory, shardFileName(bucket)), "a");
      this.handles.set(bucket, handle);
    }
    const payload = Buffer.concat(stats.pending);
    stats.pending.length = 0;
    stats.pendingBytes = 0;
    await handle.write(payload);
  }
}

/**
 * Row plus the exact serialized line that produced it. Comparing lines is what
 * lets a delta detect a changed row without re-serializing either side.
 */
export interface ShardLine {
  row: SessionCatalogRow;
  line: string;
}

export async function readShardLines(
  filePath: string,
): Promise<Map<string, ShardLine>> {
  const entries = new Map<string, ShardLine>();
  for await (const entry of readShardRows(filePath)) {
    entries.set(sessionCatalogRowKey(entry.row), entry);
  }
  return entries;
}

export async function readProjectRowsFromShard(
  filePath: string,
  projectIdentityKey: string,
): Promise<ProjectRowsValue> {
  const rows: SessionCatalogRow[] = [];
  let bytes = 0;
  for await (const { row, line } of readShardRows(filePath)) {
    if (row.projectIdentityKey !== projectIdentityKey) continue;
    rows.push(row);
    bytes += Buffer.byteLength(line) + 1;
  }
  rows.sort(
    (left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt),
  );
  return {
    rows: Object.freeze(rows.map((row) => Object.freeze(row))),
    bytes,
  };
}

/** Projects one project's rows from a retained generation, newest first. */
export function projectSlice(
  catalog: CatalogRowsValue,
  projectIdentityKey: string,
): ProjectRowsValue {
  const rows: Readonly<SessionCatalogRow>[] = [];
  let bytes = 0;
  for (let index = 0; index < catalog.rows.length; index += 1) {
    const row = catalog.rows[index]!;
    if (row.projectIdentityKey !== projectIdentityKey) continue;
    rows.push(row);
    bytes += catalog.rowBytes[index] ?? 0;
  }
  rows.sort(
    (left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt),
  );
  return { rows: Object.freeze(rows), bytes };
}

export class SessionCatalogCorruptionError extends Error {}

export async function* readShardRows(
  filePath: string,
): AsyncGenerator<ShardLine> {
  const input = createReadStream(filePath, { encoding: "utf-8" });
  const lines = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });
  let lineNumber = 0;
  try {
    for await (const line of lines) {
      lineNumber += 1;
      if (!line) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch (error) {
        throw new SessionCatalogCorruptionError(
          `Invalid session catalog row at ${filePath}:${lineNumber}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      yield { row: parsed as SessionCatalogRow, line };
    }
  } finally {
    lines.close();
    input.destroy();
  }
}

export function projectBucket(
  projectIdentityKey: string,
  bucketCount: number,
): number {
  const digest = createHash("sha256").update(projectIdentityKey).digest();
  return digest.readUInt32BE(0) % bucketCount;
}

export function isMissingFile(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

export function shardFileName(bucket: number): string {
  return `bucket-${String(bucket).padStart(3, "0")}.jsonl`;
}
