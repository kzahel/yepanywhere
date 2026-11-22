import type { Stats } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { antigravitySummariesPath } from "../sdk/providers/antigravity-runtime.js";
import { isAbsolutePath } from "../projects/paths.js";
import {
  AntigravitySummariesReader,
  antigravitySummariesVersion,
  type AntigravitySummaryRow,
} from "./antigravity-summaries.js";
import { catalogFileVersion } from "./catalog-adapters/row.js";

export const ANTIGRAVITY_SESSION_ID =
  /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
export const ANTIGRAVITY_METADATA_LIMIT = 2_000;
const MAX_SUMMARY_CACHE_PATHS = 16;

// Bounded by MAX_SUMMARY_CACHE_PATHS (16); one parsed summary snapshot per
// summaries database version, shared across catalog scans in the same process.
const summaryCache = new Map<
  string,
  {
    version: string;
    rows: Map<string, AntigravitySummaryRow>;
    complete: boolean;
  }
>();

/** `agy` records each conversation's workspace and lineage in its
 * summaries index. Takes the validated physical
 * conversations scope so symlinked conversation roots cannot pair with a
 * foreign summaries database. On a capped bulk-cache miss, falls back to a
 * targeted point read so children past the cap cannot be promoted to roots. */
async function cliSummary(
  scope: string,
  id: string,
  bulkLimit = ANTIGRAVITY_METADATA_LIMIT * 5,
): Promise<AntigravitySummaryRow | undefined> {
  const path = antigravitySummariesPath(scope);
  const version = await antigravitySummariesVersion(path);
  if (!version) return undefined;
  let cached = summaryCache.get(path);
  if (cached?.version !== version) {
    const reader = new AntigravitySummariesReader(path);
    let snapshot: ReturnType<AntigravitySummariesReader["readAllRows"]>;
    try {
      snapshot = reader.readAllRows(bulkLimit);
    } finally {
      reader.close();
    }
    cached = { version, rows: snapshot.rows, complete: snapshot.complete };
    summaryCache.delete(path);
    summaryCache.set(path, cached);
    if (summaryCache.size > MAX_SUMMARY_CACHE_PATHS) {
      const oldest = summaryCache.keys().next().value;
      if (oldest !== undefined) summaryCache.delete(oldest);
    }
  }
  const hit = cached.rows.get(id);
  if (hit || cached.complete) return hit;
  // Strict point read: an unreadable/poisoned DB on a cache miss must throw
  // so callers preserve prior catalog state instead of promoting a child.
  const reader = new AntigravitySummariesReader(path);
  try {
    return reader.readRowStrict(id);
  } finally {
    reader.close();
  }
}

/** Native identity only. No conversation decoding, agent process or authentication. */
export async function readAntigravityMetadata(
  directory: string,
  id: string,
  options: { summaryBulkLimit?: number } = {},
) {
  if (!ANTIGRAVITY_SESSION_ID.test(id)) return null;
  const base = join(directory, id);
  try {
    const [scope, dbPath] = await Promise.all([
      realpath(directory),
      realpath(`${base}.db`),
    ]);
    if (dirname(dbPath) !== scope || basename(dbPath) !== `${id}.db`)
      throw new Error("Antigravity session escapes its native store");
    const info = await stat(dbPath);
    if (!info.isFile()) throw new Error("Invalid Antigravity database");
    const summary = await cliSummary(scope, id, options.summaryBulkLimit);
    if (!summary?.cwd) return null;
    const {
      cwd,
      title,
      isChild,
      parentConversationId,
      agentName,
      nestingDepth,
      status,
    } = summary;
    if (!isAbsolutePath(cwd))
      throw new Error("Antigravity session has no absolute project path");
    // SQLite may append to the WAL without touching the database itself.
    const walPath = `${base}.db-wal`;
    let walInfo: Stats | undefined;
    try {
      const physical = await realpath(walPath);
      if (dirname(physical) !== scope || basename(physical) !== `${id}.db-wal`)
        throw new Error("Antigravity WAL escapes its native store");
      walInfo = await stat(physical);
      if (!walInfo.isFile()) throw new Error("Invalid Antigravity WAL");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return {
      scope,
      cwd,
      title,
      parentConversationId,
      isChild,
      agentName,
      nestingDepth,
      status,
      path: dbPath,
      info,
      updatedAtMs: Math.max(
        info.mtimeMs,
        walInfo?.mtimeMs ?? 0,
        summary.lastModifiedMs ?? 0,
      ),
      sourceVersion: [info, ...(walInfo ? [walInfo] : [])]
        .map(catalogFileVersion)
        .concat(title ? [title] : [])
        .concat(isChild ? [`child:${parentConversationId ?? "opaque"}`] : [])
        .join("|"),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
