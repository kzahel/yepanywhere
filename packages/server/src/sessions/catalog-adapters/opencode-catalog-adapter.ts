import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  NativeSessionCatalogAdapter,
  SessionCatalogAdapterScan,
  SessionCatalogRow,
  SessionCatalogScanContext,
} from "../catalog-types.js";
import { OpenCodeDbReader } from "../opencode-db-reader.js";
import { OPENCODE_DB_PATH, OPENCODE_STORAGE_DIR } from "../opencode-reader.js";
import {
  catalogProjectIdentity,
  buildCatalogRow,
  fileSourceVersion,
  isWithinScanMode,
} from "./row.js";

/**
 * OpenCode hides project membership behind an opaque project id, so a
 * per-project caller has to read every `project/*.json` (or query the DB) just
 * to learn its own id before it can list anything. This adapter reads the
 * worktree map once and enumerates both stores in one pass.
 *
 * Both stores are read because they hold different eras: 1.16+ writes the
 * SQLite database, and the frozen JSON file tree still holds pre-1.16 history.
 * The database wins on conflict — it is the authoritative store where both
 * describe the same session. The `opencode` CLI is deliberately not consulted:
 * a catalog pass must not spawn a subprocess per generation.
 */
export interface OpenCodeCatalogAdapterOptions {
  storageDir?: string;
  databasePath?: string;
}

interface OpenCodeProjectJson {
  id?: unknown;
  worktree?: unknown;
}

interface OpenCodeSessionJson {
  id?: unknown;
  title?: unknown;
  parentID?: unknown;
  time?: { created?: unknown; updated?: unknown };
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asEpochMs(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

export class OpenCodeSessionCatalogAdapter
  implements NativeSessionCatalogAdapter
{
  readonly catalogFamily = "opencode" as const;
  readonly storeKey: string;
  private readonly storageDir: string;
  private readonly databasePath: string;

  constructor(options: OpenCodeCatalogAdapterOptions = {}) {
    this.storageDir = options.storageDir ?? OPENCODE_STORAGE_DIR;
    this.databasePath = options.databasePath ?? OPENCODE_DB_PATH;
    this.storeKey = this.storageDir;
  }

  async scan(
    context: SessionCatalogScanContext,
  ): Promise<SessionCatalogAdapterScan> {
    const rows = new Map<string, SessionCatalogRow>();
    let skippedByMode = 0;
    let newestMs = 0;

    const dbScope = await realpath(dirname(this.databasePath)).catch(
      () => undefined,
    );
    const jsonScope = await realpath(dirname(this.storageDir)).catch(
      () => undefined,
    );
    const directories = new Map<string, Promise<string>>();
    const physicalDirectory = (path: string) => {
      let value = directories.get(path);
      if (!value) {
        value = realpath(path).catch(() => path);
        directories.set(path, value);
      }
      return value;
    };
    const dbReader = new OpenCodeDbReader(this.databasePath);
    let childIds: Set<string>;
    let dbRows: Awaited<ReturnType<OpenCodeDbReader["listAllSessionRows"]>>;
    try {
      childIds = new Set(await dbReader.listChildSessionIds());
      dbRows = await dbReader.listAllSessionRows();
    } finally {
      // Catalogue adapters are finite publications, not native handle owners.
      dbReader.close();
    }
    for (const row of dbRows) {
      context.signal.throwIfAborted();
      const updatedAtMs = row.timeUpdated ?? row.timeCreated;
      if (updatedAtMs === null || updatedAtMs === undefined) continue;
      if (childIds.has(row.id)) continue;
      if (!isWithinScanMode(context.mode, updatedAtMs)) {
        skippedByMode += 1;
        continue;
      }
      newestMs = Math.max(newestMs, updatedAtMs);
      rows.set(row.id, {
        ...buildCatalogRow({
          catalogFamily: this.catalogFamily,
          storeKey: this.storeKey,
          sessionId: row.id,
          projectPath: row.worktree,
          updatedAtMs,
          createdAtMs: row.timeCreated ?? undefined,
          title: row.title,
          fidelity: "head",
          // time_updated moves on every message, so it is the exact identity
          // a retained projection of this session stays valid for.
          sourceVersion: `db:${updatedAtMs}`,
          location: {
            kind: "database",
            path: this.databasePath,
            recordId: row.id,
          },
        }),
        ...(dbScope ? { nativeStorageScope: dbScope } : {}),
        nativeDirectoryProjectId: catalogProjectIdentity(
          await physicalDirectory(row.directory),
        ).projectId,
      });
    }

    const worktrees = await this.readProjectWorktrees(context);
    let fileSessionsSeen = 0;
    for (const [openCodeProjectId, worktree] of worktrees) {
      context.signal.throwIfAborted();
      const sessionDir = join(this.storageDir, "session", openCodeProjectId);
      let files: string[];
      try {
        files = await readdir(sessionDir);
      } catch {
        continue;
      }
      for (const file of files) {
        context.signal.throwIfAborted();
        if (!file.endsWith(".json")) continue;
        fileSessionsSeen += 1;
        const path = join(sessionDir, file);
        let mtimeMs: number;
        let size: number;
        try {
          const stats = await stat(path);
          mtimeMs = stats.mtimeMs;
          size = stats.size;
        } catch {
          continue;
        }
        if (!isWithinScanMode(context.mode, mtimeMs)) {
          skippedByMode += 1;
          continue;
        }

        let session: OpenCodeSessionJson;
        try {
          session = JSON.parse(await readFile(path, "utf-8"));
        } catch {
          continue;
        }
        const sessionId = asString(session.id) ?? file.replace(/\.json$/, "");
        if (rows.has(sessionId) || asString(session.parentID)) continue;

        const updatedAtMs =
          asEpochMs(session.time?.updated) ??
          asEpochMs(session.time?.created) ??
          mtimeMs;
        if (!isWithinScanMode(context.mode, updatedAtMs)) {
          skippedByMode += 1;
          continue;
        }
        newestMs = Math.max(newestMs, updatedAtMs);

        rows.set(sessionId, {
          ...buildCatalogRow({
            catalogFamily: this.catalogFamily,
            storeKey: this.storeKey,
            sessionId,
            projectPath: worktree,
            updatedAtMs,
            createdAtMs: asEpochMs(session.time?.created),
            title: asString(session.title) ?? null,
            fidelity: "head",
            sourceVersion: fileSourceVersion(mtimeMs, size),
            location: { kind: "file", path },
          }),
          ...(jsonScope ? { nativeStorageScope: jsonScope } : {}),
        });
      }
    }

    return {
      sourceVersion: `${worktrees.size}:${rows.size}:${Math.trunc(newestMs)}`,
      rows: [...rows.values()],
      metrics: {
        projectsRead: worktrees.size,
        databaseRows: dbRows.length,
        fileSessionsSeen,
        skippedByMode,
        rows: rows.size,
      },
    };
  }

  /** The opaque-project-id to worktree map, read once for the whole install. */
  private async readProjectWorktrees(
    context: SessionCatalogScanContext,
  ): Promise<Map<string, string>> {
    const worktrees = new Map<string, string>();
    const projectDir = join(this.storageDir, "project");
    let files: string[];
    try {
      files = await readdir(projectDir);
    } catch {
      return worktrees;
    }
    for (const file of files) {
      context.signal.throwIfAborted();
      if (!file.endsWith(".json") || file === "global.json") continue;
      try {
        const project: OpenCodeProjectJson = JSON.parse(
          await readFile(join(projectDir, file), "utf-8"),
        );
        const id = asString(project.id) ?? file.replace(/\.json$/, "");
        const worktree = asString(project.worktree);
        if (worktree) worktrees.set(id, worktree);
      } catch {
        // Skip unreadable project descriptors rather than failing the pass.
      }
    }
    return worktrees;
  }
}
