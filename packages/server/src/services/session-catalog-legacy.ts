/**
 * The catalog files that versions before plan 189 step 3's third commit kept
 * below `session-catalog/`: a manifest naming one generation directory of
 * JSONL shards. `SessionCatalogService` imports that generation into SQLite
 * once, keeping its epoch and generation, and then deletes the folder.
 */
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { SessionCatalogRow } from "../sessions/catalog-types.js";
import type { SessionCatalogSqliteSource } from "./session-catalog-sqlite.js";
import {
  normalizeRow,
  requireNonEmpty,
  requireTimestamp,
} from "./session-catalog-rows.js";

export interface LegacyCatalogManifest {
  epoch: string;
  generation: number;
  completedAt: string;
  /** Null for an empty generation. */
  generationDirectory: string | null;
  shardFiles: string[];
  sources: SessionCatalogSqliteSource[];
  rowCount: number;
}

/** The folder's content is unreadable or not a catalog this code wrote. */
export class LegacyCatalogCorruptionError extends Error {}

const GENERATION_DIRECTORY = /^gen-\d+-[0-9a-f-]+$/;
const SHARD_FILE = /^bucket-\d{3}\.jsonl$/;

/** The manifest, or undefined when there is none. */
export async function readLegacyCatalogManifest(
  catalogDir: string,
): Promise<LegacyCatalogManifest | undefined> {
  let text: string;
  try {
    text = await readFile(join(catalogDir, "manifest.json"), "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  try {
    const value = JSON.parse(text) as Record<string, unknown> | null;
    if (!value || typeof value !== "object" || value.schemaVersion !== 1)
      throw new Error("unsupported manifest schema");
    const epoch = value.catalogEpoch;
    requireNonEmpty(epoch, "catalogEpoch");
    const generation = value.catalogGeneration;
    if (
      typeof generation !== "number" ||
      !Number.isSafeInteger(generation) ||
      generation < 0
    )
      throw new Error("invalid catalogGeneration");
    const completedAt = value.completedAt;
    requireTimestamp(completedAt, "completedAt");
    const directory = value.generationDirectory;
    if (
      directory !== null &&
      (typeof directory !== "string" || !GENERATION_DIRECTORY.test(directory))
    )
      throw new Error("invalid generationDirectory");
    if (!Array.isArray(value.shards) || !Array.isArray(value.providerSources))
      throw new Error("invalid shards or providerSources");
    const shardFiles = value.shards.map((shard: { file?: unknown }) => {
      if (typeof shard?.file !== "string" || !SHARD_FILE.test(shard.file))
        throw new Error("invalid shard file");
      return shard.file;
    });
    const sources = value.providerSources.map(
      (source: Partial<SessionCatalogSqliteSource> | null) => {
        const { catalogFamily, storeKey } = source ?? {};
        requireNonEmpty(catalogFamily, "source catalogFamily");
        requireNonEmpty(storeKey, "source storeKey");
        return { catalogFamily, storeKey };
      },
    );
    const rowCount = value.rowCount;
    if (
      typeof rowCount !== "number" ||
      !Number.isSafeInteger(rowCount) ||
      rowCount < 0
    )
      throw new Error("invalid rowCount");
    return {
      rowCount,
      epoch,
      generation,
      completedAt,
      generationDirectory: directory,
      shardFiles,
      sources,
    };
  } catch (error) {
    throw new LegacyCatalogCorruptionError(
      `Invalid session catalog manifest: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Every row of the manifest's generation, validated and normalized as a
 * publication would. A missing shard or an invalid row throws
 * {@link LegacyCatalogCorruptionError}.
 */
export async function readLegacyCatalogRows(
  catalogDir: string,
  manifest: LegacyCatalogManifest,
): Promise<SessionCatalogRow[]> {
  const rows: SessionCatalogRow[] = [];
  if (!manifest.generationDirectory) return rows;
  for (const file of manifest.shardFiles) {
    const path = join(
      catalogDir,
      "generations",
      manifest.generationDirectory,
      file,
    );
    const input = createReadStream(path, { encoding: "utf-8" });
    const lines = createInterface({
      input,
      crlfDelay: Number.POSITIVE_INFINITY,
    });
    let lineNumber = 0;
    try {
      for await (const line of lines) {
        lineNumber += 1;
        if (!line) continue;
        const row = JSON.parse(line) as SessionCatalogRow;
        rows.push(normalizeRow(row, row));
      }
    } catch (error) {
      // A missing shard or a bad line is damage; any other I/O error is not
      // proof of it, and the caller keeps the folder.
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== undefined && code !== "ENOENT") throw error;
      throw new LegacyCatalogCorruptionError(
        `Unreadable session catalog shard ${path}:${lineNumber}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    } finally {
      lines.close();
      input.destroy();
    }
  }
  // A shard cut short at a line boundary parses cleanly.
  if (rows.length !== manifest.rowCount)
    throw new LegacyCatalogCorruptionError(
      `Session catalog files hold ${rows.length} rows, the manifest ${manifest.rowCount}`,
    );
  return rows;
}
