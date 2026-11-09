#!/usr/bin/env tsx
/**
 * Removes stale cached external-provider session rows from YA indexes and
 * metadata. This never deletes provider-native session data; it only edits YA
 * cache files and session metadata in the SQLite database under the configured
 * data directory. Stop the server first: a running server keeps its own copy of
 * session metadata and would write it back.
 *
 * Usage:
 *   pnpm tsx scripts/prune-stale-index-entries.ts --dry-run
 *   pnpm tsx scripts/prune-stale-index-entries.ts
 *   YEP_DATA_DIR=~/.yep-anywhere-dev pnpm tsx scripts/prune-stale-index-entries.ts --dry-run
 *   pnpm tsx scripts/prune-stale-index-entries.ts --providers=grok,codex --dry-run
 *   pnpm tsx scripts/prune-stale-index-entries.ts --archive-pattern="resume last-session" --dry-run
 */

import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import { homedir } from "node:os";
import * as path from "node:path";
import {
  encodeMetadata,
  readStoredMetadata,
  SessionMetadataRows as StoredMetadataRows,
} from "../packages/server/src/metadata/session-metadata-rows.js";
import {
  loadSqliteDriver,
  type SqliteDatabase,
} from "../packages/server/src/storage/sqlite.js";

const DEFAULT_DATA_DIR = path.join(homedir(), ".yep-anywhere");
const EXTERNAL_PROVIDERS = ["grok", "codex", "gemini"] as const;
const USAGE = `Usage:
  pnpm tsx scripts/prune-stale-index-entries.ts --dry-run
  pnpm tsx scripts/prune-stale-index-entries.ts
  pnpm tsx scripts/prune-stale-index-entries.ts --providers=grok,codex --dry-run
  pnpm tsx scripts/prune-stale-index-entries.ts --data-dir=/path/to/ya-data --dry-run
  pnpm tsx scripts/prune-stale-index-entries.ts --archive-pattern="resume last-session" --dry-run`;

type ExternalProvider = (typeof EXTERNAL_PROVIDERS)[number];

interface CleanupOptions {
  dryRun: boolean;
  dataDir: string;
  providers: Set<ExternalProvider> | "all";
}

interface CachedSessionRow {
  provider?: unknown;
  title?: unknown;
  fullTitle?: unknown;
  initialPrompt?: unknown;
  [key: string]: unknown;
}

interface SessionIndexFile {
  sessions?: Record<string, CachedSessionRow>;
  [key: string]: unknown;
}

type SessionMetadataRow = Record<string, unknown>;

/**
 * Session metadata rows as the server last wrote them. This edits rows
 * directly rather than through the server's startup path, so a dry run never
 * migrates, imports or rewrites anything.
 */
class SessionMetadataRows {
  readonly rows = new Map<string, SessionMetadataRow>();

  private constructor(private readonly database: SqliteDatabase) {
    for (const [sessionId, metadata] of readStoredMetadata(database))
      this.rows.set(sessionId, metadata as SessionMetadataRow);
  }

  static open(dataDir: string): SessionMetadataRows | null {
    const file = path.join(dataDir, "discovery.sqlite");
    if (!existsSync(file)) return null;
    const driver = loadSqliteDriver();
    if (!driver) throw new Error("This runtime has no built-in SQLite");
    const database = driver.open(file);
    try {
      database.exec("PRAGMA busy_timeout = 250");
      const imported = database
        .prepare(
          "SELECT 1 AS imported FROM sqlite_schema WHERE name = 'session_metadata_import'",
        )
        .get();
      if (
        !imported ||
        !database.prepare("SELECT 1 FROM session_metadata_import").get() ||
        !database
          .prepare(
            "SELECT 1 FROM pragma_table_info('session_metadata') WHERE name = 'extra'",
          )
          .get()
      ) {
        throw new Error(
          "Session metadata has not been imported into or migrated in discovery.sqlite yet. Start the upgraded server once, stop it, and rerun.",
        );
      }
      return new SessionMetadataRows(database);
    } catch (error) {
      database.close();
      throw error;
    }
  }

  remove(sessionIds: string[]): void {
    const statement = this.database.prepare(
      "DELETE FROM session_metadata WHERE session_id = ?",
    );
    this.database.transaction(() => {
      for (const sessionId of sessionIds) statement.run(sessionId);
    });
  }

  archive(sessionIds: Iterable<string>): void {
    const rows = new StoredMetadataRows(this.database);
    try {
      this.database.transaction(() => {
        for (const sessionId of sessionIds) {
          const row = { ...this.rows.get(sessionId), isArchived: true };
          rows.write(sessionId, encodeMetadata(row));
        }
      });
    } finally {
      rows.dispose();
    }
  }

  close(): void {
    this.database.close();
  }
}

interface RemovedRow {
  id: string;
  title: string;
}

const grokSessionsDir =
  process.env.GROK_SESSIONS_DIR ?? path.join(homedir(), ".grok", "sessions");
const codexSessionsDir =
  process.env.CODEX_SESSIONS_DIR ?? path.join(homedir(), ".codex", "sessions");
const geminiSessionsDir =
  process.env.GEMINI_SESSIONS_DIR ?? path.join(homedir(), ".gemini", "tmp");

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function providerFrom(value: unknown): ExternalProvider | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.toLowerCase();
  return (
    EXTERNAL_PROVIDERS.find((provider) => normalized.includes(provider)) ?? null
  );
}

function exactProviderFrom(value: string): ExternalProvider | null {
  const normalized = value.toLowerCase();
  return EXTERNAL_PROVIDERS.find((provider) => provider === normalized) ?? null;
}

function providerWanted(
  provider: ExternalProvider | null,
  wanted: CleanupOptions["providers"],
): provider is ExternalProvider {
  if (!provider) {
    return false;
  }
  return wanted === "all" || wanted.has(provider);
}

function rowProviderAllowed(
  row: { provider?: unknown },
  wanted: CleanupOptions["providers"],
): boolean {
  return wanted === "all" || providerWanted(providerFrom(row.provider), wanted);
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const stats = await fs.stat(filePath);
    return stats.isFile();
  } catch {
    return false;
  }
}

async function directoryExists(filePath: string): Promise<boolean> {
  try {
    const stats = await fs.stat(filePath);
    return stats.isDirectory();
  } catch {
    return false;
  }
}

async function findInTree(
  root: string,
  predicate: (entryPath: string, entryName: string) => Promise<boolean>,
  maxDepth: number,
): Promise<boolean> {
  if (maxDepth < 0 || !(await directoryExists(root))) {
    return false;
  }

  let entries: string[];
  try {
    entries = await fs.readdir(root);
  } catch {
    return false;
  }

  for (const entry of entries) {
    const entryPath = path.join(root, entry);
    if (await predicate(entryPath, entry)) {
      return true;
    }
    if (maxDepth > 0 && (await directoryExists(entryPath))) {
      if (await findInTree(entryPath, predicate, maxDepth - 1)) {
        return true;
      }
    }
  }
  return false;
}

async function grokSessionExists(sessionId: string): Promise<boolean> {
  return findInTree(
    grokSessionsDir,
    async (entryPath, entryName) =>
      entryName === sessionId &&
      (await fileExists(path.join(entryPath, "summary.json"))),
    2,
  );
}

async function codexSessionExists(sessionId: string): Promise<boolean> {
  return findInTree(
    codexSessionsDir,
    async (entryPath, entryName) => {
      if (entryName === `${sessionId}.jsonl`) {
        return fileExists(entryPath);
      }
      if (entryName === sessionId) {
        return fileExists(path.join(entryPath, "session.jsonl"));
      }
      return false;
    },
    5,
  );
}

async function geminiSessionExists(sessionId: string): Promise<boolean> {
  return findInTree(
    geminiSessionsDir,
    async (entryPath, entryName) => {
      if (entryName === `${sessionId}.json`) {
        return fileExists(entryPath);
      }
      if (entryName === sessionId) {
        return directoryExists(entryPath) || fileExists(entryPath);
      }
      return false;
    },
    4,
  );
}

async function externalSessionExists(
  sessionId: string,
  provider: ExternalProvider,
): Promise<boolean> {
  switch (provider) {
    case "grok":
      return grokSessionExists(sessionId);
    case "codex":
      return codexSessionExists(sessionId);
    case "gemini":
      return geminiSessionExists(sessionId);
  }
}

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf-8")) as T;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

async function writeJsonFile(
  filePath: string,
  value: unknown,
  dryRun: boolean,
): Promise<void> {
  if (dryRun) {
    return;
  }
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function rowTitle(row: CachedSessionRow): string {
  return String(
    row.title ?? row.fullTitle ?? row.initialPrompt ?? "(no title)",
  );
}

async function pruneIndexFile(
  filePath: string,
  options: CleanupOptions,
): Promise<number> {
  const data = await readJsonFile<SessionIndexFile>(filePath);
  if (!data || !isRecord(data.sessions)) {
    return 0;
  }

  const removed: RemovedRow[] = [];
  for (const [sessionId, row] of Object.entries(data.sessions)) {
    const provider = providerFrom(row.provider);
    if (!providerWanted(provider, options.providers)) {
      continue;
    }
    if (await externalSessionExists(sessionId, provider)) {
      continue;
    }

    removed.push({ id: sessionId, title: rowTitle(row) });
    delete data.sessions[sessionId];
  }

  if (removed.length === 0) {
    return 0;
  }

  console.log(
    `${path.basename(filePath)}: ${removed.length} stale entr${removed.length === 1 ? "y" : "ies"}`,
  );
  for (const row of removed.slice(0, 3)) {
    console.log(`  - ${row.id}  ${row.title.slice(0, 60)}`);
  }
  if (removed.length > 3) {
    console.log(`  ... +${removed.length - 3} more`);
  }

  await writeJsonFile(filePath, data, options.dryRun);
  return removed.length;
}

async function pruneMetadata(
  options: CleanupOptions,
  metadata: SessionMetadataRows,
): Promise<number> {
  const removed: string[] = [];
  for (const [sessionId, row] of metadata.rows) {
    const provider = providerFrom(row.provider);
    if (!providerWanted(provider, options.providers)) {
      continue;
    }
    if (await externalSessionExists(sessionId, provider)) {
      continue;
    }
    removed.push(sessionId);
  }

  if (removed.length === 0) {
    return 0;
  }

  console.log(
    `\nsession metadata: ${removed.length} dead external session record(s)`,
  );
  for (const id of removed.slice(0, 3)) {
    console.log(`  - ${id}`);
  }
  if (removed.length > 3) {
    console.log(`  ... +${removed.length - 3} more`);
  }

  if (!options.dryRun) {
    metadata.remove(removed);
  }
  return removed.length;
}

function textMatchesPattern(value: unknown, pattern: RegExp): boolean {
  return typeof value === "string" && pattern.test(value);
}

async function archiveByPattern(
  indexesDir: string,
  options: CleanupOptions,
  patternText: string,
  metadata: SessionMetadataRows | null,
): Promise<number> {
  let pattern: RegExp;
  try {
    pattern = new RegExp(patternText, "i");
  } catch (error) {
    console.error("Bad --archive-pattern regex:", patternText, error);
    process.exit(1);
  }

  console.log(
    `\n[prune-stale] --archive-pattern=${patternText} : scanning for matches to archive...`,
  );

  const toArchive = new Set<string>();
  try {
    const entries = await fs.readdir(indexesDir);
    for (const entry of entries) {
      if (!entry.endsWith(".json")) {
        continue;
      }
      const data = await readJsonFile<SessionIndexFile>(
        path.join(indexesDir, entry),
      );
      if (!data || !isRecord(data.sessions)) {
        continue;
      }
      for (const [sessionId, row] of Object.entries(data.sessions)) {
        if (!rowProviderAllowed(row, options.providers)) {
          continue;
        }
        if (
          textMatchesPattern(row.title, pattern) ||
          textMatchesPattern(row.fullTitle, pattern) ||
          textMatchesPattern(row.initialPrompt, pattern)
        ) {
          toArchive.add(sessionId);
        }
      }
    }
  } catch (error) {
    if (!(isNodeError(error) && error.code === "ENOENT")) {
      throw error;
    }
    // Missing indexes are handled by the main prune pass; no archive matches here.
  }

  for (const [sessionId, row] of metadata?.rows ?? []) {
    if (!rowProviderAllowed(row, options.providers)) {
      continue;
    }
    if (
      textMatchesPattern(row.customTitle, pattern) ||
      textMatchesPattern(row.initialPrompt, pattern)
    ) {
      toArchive.add(sessionId);
    }
  }

  if (toArchive.size === 0) {
    console.log(
      "  No matches found for the archive pattern in current indexes/metadata.",
    );
    return 0;
  }

  console.log(
    `  ${toArchive.size} session(s) match the pattern and will be archived.`,
  );
  for (const id of Array.from(toArchive).slice(0, 5)) {
    console.log(`  - ${id}`);
  }
  if (toArchive.size > 5) {
    console.log(`  ... +${toArchive.size - 5} more`);
  }

  if (!options.dryRun) {
    if (!metadata) {
      console.log(
        "  No discovery.sqlite in this data directory; nothing archived. Start the server once first.",
      );
      return 0;
    }
    metadata.archive(toArchive);
    console.log("  Archived the matching sessions in session metadata.");
  }
  return toArchive.size;
}

function parseProviderSet(
  value: string | undefined,
): Set<ExternalProvider> | "all" {
  if (!value) {
    return "all";
  }
  const providers = new Set<ExternalProvider>();
  for (const raw of value.split(",")) {
    const token = raw.trim();
    const provider = exactProviderFrom(token);
    if (!provider) {
      throw new Error(
        'Unsupported provider "' +
          token +
          '". Expected one of: ' +
          EXTERNAL_PROVIDERS.join(", "),
      );
    }
    providers.add(provider);
  }
  return providers.size > 0 ? providers : "all";
}

function argValue(arg: string | undefined): string | undefined {
  if (!arg) {
    return undefined;
  }
  const separator = arg.indexOf("=");
  return separator === -1 ? undefined : arg.slice(separator + 1);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log(USAGE);
    return;
  }
  const dryRun = args.includes("--dry-run") || args.includes("-n");
  const dataDirArg = args.find((arg) => arg.startsWith("--data-dir="));
  const providerArg = args.find((arg) => arg.startsWith("--providers="));
  const archiveArg = args.find(
    (arg) =>
      arg.startsWith("--archive-pattern=") ||
      arg.startsWith("--archive-if-title="),
  );
  const dataDir =
    argValue(dataDirArg) ?? process.env.YEP_DATA_DIR ?? DEFAULT_DATA_DIR;
  const indexesDir = path.join(dataDir, "indexes");
  const providers = parseProviderSet(argValue(providerArg));
  const providerLabel =
    providers === "all" ? "all" : Array.from(providers).join(",") || "all";

  console.log(`[prune-stale] dataDir=${dataDir}`);
  console.log(`[prune-stale] indexes=${indexesDir}`);
  console.log(`[prune-stale] providers=${providerLabel}`);
  console.log(`[prune-stale] dryRun=${dryRun}\n`);

  let total = 0;
  if (await pathExists(indexesDir)) {
    const entries = await fs.readdir(indexesDir);
    for (const entry of entries) {
      if (!entry.endsWith(".json")) {
        continue;
      }
      try {
        total += await pruneIndexFile(path.join(indexesDir, entry), {
          dryRun,
          dataDir,
          providers,
        });
      } catch (error) {
        console.warn(`  skip ${entry}:`, error);
      }
    }
  } else {
    console.log("No indexes directory; nothing to do.");
  }

  const metadata = SessionMetadataRows.open(dataDir);
  try {
    if (metadata) {
      total += await pruneMetadata({ dryRun, dataDir, providers }, metadata);
    } else {
      console.log(
        "No discovery.sqlite; start the upgraded server once to migrate session metadata.",
      );
    }

    const archivePattern = argValue(archiveArg);
    if (archivePattern) {
      total += await archiveByPattern(
        indexesDir,
        { dryRun, dataDir, providers },
        archivePattern,
        metadata,
      );
    }
  } finally {
    metadata?.close();
  }

  console.log(
    `\n[prune-stale] ${dryRun ? "Would clean" : "Cleaned"} ${total} total record${total === 1 ? "" : "s"}.`,
  );
  if (dryRun && total > 0) {
    console.log("Re-run without --dry-run to apply.");
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
