import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  GROK_SESSIONS_DIR,
  getProjectIdentityKey,
} from "../../projects/paths.js";
import type {
  NativeSessionCatalogAdapter,
  SessionCatalogAdapterScan,
  SessionCatalogRow,
  SessionCatalogScanContext,
} from "../catalog-types.js";
import { buildCatalogRow, fileSourceVersion, isWithinScanMode } from "./row.js";

/**
 * Grok's store is `<sessions>/<encodeURIComponent(cwd)>/<uuid>/summary.json`,
 * so the whole install is one two-level walk. `GrokSessionReader` performs that
 * same walk per project and then discards every directory whose cwd does not
 * match, which is the Cartesian shape tactical 093 opens with; this adapter
 * walks once and lets the coordinator group by project.
 */
export interface GrokCatalogAdapterOptions {
  sessionsDir?: string;
}

interface GrokSummaryJson {
  info?: { id?: unknown; cwd?: unknown };
  created_at?: unknown;
  updated_at?: unknown;
  last_active_at?: unknown;
  generated_title?: unknown;
  session_summary?: unknown;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function parseTimestampMs(value: unknown): number | undefined {
  const text = asString(value);
  if (!text) return undefined;
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? ms : undefined;
}

export class GrokSessionCatalogAdapter implements NativeSessionCatalogAdapter {
  readonly catalogFamily = "grok" as const;
  readonly storeKey: string;
  private readonly sessionsDir: string;

  constructor(options: GrokCatalogAdapterOptions = {}) {
    this.sessionsDir = options.sessionsDir ?? GROK_SESSIONS_DIR;
    this.storeKey = this.sessionsDir;
  }

  async scan(
    context: SessionCatalogScanContext,
  ): Promise<SessionCatalogAdapterScan> {
    const rows: SessionCatalogRow[] = [];
    const childIds = new Set<string>();
    let cwdDirsVisited = 0;
    let sessionDirsVisited = 0;
    let summariesRead = 0;
    let skippedByMode = 0;
    let newestMs = 0;

    let cwdEntries: string[];
    try {
      cwdEntries = await readdir(this.sessionsDir);
    } catch {
      // A never-used store is not an error; it simply has no rows.
      return { sourceVersion: "absent", rows: [], metrics: {} };
    }

    const nativeStorageScope = await realpath(this.sessionsDir);
    context.signal.throwIfAborted();
    for (const encoded of cwdEntries) {
      context.signal.throwIfAborted();
      if (encoded === "session_search.sqlite") continue;

      let decodedCwd: string;
      try {
        decodedCwd = decodeURIComponent(encoded);
      } catch {
        continue;
      }

      const cwdDir = join(this.sessionsDir, encoded);
      let sessionDirs: string[];
      try {
        sessionDirs = await readdir(cwdDir);
      } catch {
        continue;
      }
      cwdDirsVisited += 1;

      for (const uuid of sessionDirs) {
        context.signal.throwIfAborted();
        sessionDirsVisited += 1;
        const summaryPath = join(cwdDir, uuid, "summary.json");
        let mtimeMs: number;
        let size: number;
        try {
          const stats = await stat(summaryPath);
          mtimeMs = stats.mtimeMs;
          size = stats.size;
        } catch {
          continue; // not a session directory
        }
        if (!isWithinScanMode(context.mode, mtimeMs)) {
          skippedByMode += 1;
          continue;
        }

        let summary: GrokSummaryJson;
        try {
          summary = JSON.parse(await readFile(summaryPath, "utf-8"));
          summariesRead += 1;
        } catch {
          continue;
        }

        const cwd = asString(summary.info?.cwd) ?? decodedCwd;
        if (getProjectIdentityKey(cwd) !== getProjectIdentityKey(decodedCwd))
          continue;
        const updatedAtMs =
          parseTimestampMs(summary.updated_at) ??
          parseTimestampMs(summary.last_active_at) ??
          mtimeMs;
        if (!isWithinScanMode(context.mode, updatedAtMs)) {
          skippedByMode += 1;
          continue;
        }
        newestMs = Math.max(newestMs, mtimeMs);

        await addGrokChildSessionIds(join(cwdDir, uuid), childIds);
        rows.push({
          ...buildCatalogRow({
            catalogFamily: this.catalogFamily,
            storeKey: this.storeKey,
            // The directory name is the locatable id on disk; summary.json's
            // own id is the ACP-visible one and wins when both exist.
            sessionId: asString(summary.info?.id) ?? uuid,
            projectPath: cwd,
            updatedAtMs,
            createdAtMs: parseTimestampMs(summary.created_at),
            title:
              asString(summary.generated_title) ??
              asString(summary.session_summary) ??
              null,
            // summary.json is the provider's own head projection: a title
            // without opening the transcript.
            fidelity: "head",
            sourceVersion: fileSourceVersion(mtimeMs, size),
            location: { kind: "file", path: summaryPath },
          }),
          nativeStorageScope,
        });
      }
    }

    const visibleRows = rows.filter((row) => !childIds.has(row.sessionId));
    return {
      sourceVersion: `${cwdDirsVisited}:${visibleRows.length}:${Math.trunc(newestMs)}`,
      rows: visibleRows,
      metrics: {
        cwdDirsVisited,
        sessionDirsVisited,
        summariesRead,
        skippedByMode,
        rows: visibleRows.length,
      },
    };
  }
}

async function addGrokChildSessionIds(
  sessionDir: string,
  childIds: Set<string>,
): Promise<void> {
  let names: string[];
  try {
    names = await readdir(join(sessionDir, "subagents"));
  } catch {
    return;
  }
  for (const name of names) {
    childIds.add(name);
  }
}
