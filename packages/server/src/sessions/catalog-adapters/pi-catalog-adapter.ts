import { readdir, realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  PI_SESSIONS_DIR,
  readCwdFromSessionFile,
} from "../../projects/paths.js";
import type {
  NativeSessionCatalogAdapter,
  SessionCatalogAdapterScan,
  SessionCatalogRow,
  SessionCatalogScanContext,
} from "../catalog-types.js";
import { buildCatalogRow, fileSourceVersion, isWithinScanMode } from "./row.js";

/**
 * pi's store is `<sessions>/<flattened cwd>/<ISO-ts>_<uuid>.jsonl`. The
 * directory name is lossy, so project membership comes from the `cwd` in each
 * transcript's header — a bounded prefix read, not a parse of the whole file.
 * `PiSessionReader` pays that header read for every file in the store on every
 * project's list; this adapter pays it once per file per generation, and in
 * recent mode skips the read entirely for files whose mtime is outside the
 * window.
 *
 * pi has no native summary file, so rows stay at `identity` fidelity: a title
 * would mean parsing the transcript, which is explicit per-session work.
 */
export interface PiCatalogAdapterOptions {
  sessionsDir?: string;
}

function sessionIdFromFilename(filename: string): string | null {
  const withTimestamp = filename.match(/_([^_/\\]+)\.jsonl$/);
  if (withTimestamp?.[1]) return withTimestamp[1];
  const bare = filename.match(/([^_/\\]+)\.jsonl$/);
  return bare?.[1] ?? null;
}

/**
 * pi names each transcript with its creation time, colons and the decimal
 * point replaced by dashes (`pi-fork.ts` writes `toISOString().replace(/[:.]/g,
 * "-")`). Undo exactly that substitution; anything else shaped differently
 * yields no creation time rather than a guessed one.
 */
const PI_FILENAME_TIMESTAMP =
  /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z_/;

function createdAtMsFromFilename(filename: string): number | undefined {
  const match = PI_FILENAME_TIMESTAMP.exec(filename);
  if (!match) return undefined;
  const [, date, hour, minute, second, millis] = match;
  const ms = Date.parse(`${date}T${hour}:${minute}:${second}.${millis}Z`);
  return Number.isFinite(ms) ? ms : undefined;
}

export class PiSessionCatalogAdapter implements NativeSessionCatalogAdapter {
  readonly catalogFamily = "pi" as const;
  readonly storeKey: string;
  private readonly sessionsDir: string;

  constructor(options: PiCatalogAdapterOptions = {}) {
    this.sessionsDir = options.sessionsDir ?? PI_SESSIONS_DIR;
    this.storeKey = this.sessionsDir;
  }

  async scan(
    context: SessionCatalogScanContext,
  ): Promise<SessionCatalogAdapterScan> {
    const rows: SessionCatalogRow[] = [];
    let cwdDirsVisited = 0;
    let transcriptsSeen = 0;
    let headersRead = 0;
    let skippedByMode = 0;
    let newestMs = 0;

    let cwdEntries: string[];
    try {
      cwdEntries = await readdir(this.sessionsDir);
    } catch {
      return { sourceVersion: "absent", rows: [], metrics: {} };
    }

    const nativeStorageScope = await realpath(this.sessionsDir);
    context.signal.throwIfAborted();
    for (const encoded of cwdEntries) {
      context.signal.throwIfAborted();
      const cwdDir = join(this.sessionsDir, encoded);
      let files: string[];
      try {
        files = await readdir(cwdDir);
      } catch {
        continue; // a stray file at the store root
      }
      cwdDirsVisited += 1;

      for (const file of files) {
        context.signal.throwIfAborted();
        if (!file.endsWith(".jsonl")) continue;
        const sessionId = sessionIdFromFilename(file);
        if (!sessionId) continue;
        transcriptsSeen += 1;

        const filePath = join(cwdDir, file);
        let mtimeMs: number;
        let size: number;
        try {
          const stats = await stat(filePath);
          mtimeMs = stats.mtimeMs;
          size = stats.size;
        } catch {
          continue; // vanished between readdir and stat
        }
        if (!isWithinScanMode(context.mode, mtimeMs)) {
          skippedByMode += 1;
          continue;
        }

        const cwd = await readCwdFromSessionFile(filePath);
        headersRead += 1;
        if (!cwd) continue;
        newestMs = Math.max(newestMs, mtimeMs);

        rows.push({
          ...buildCatalogRow({
            catalogFamily: this.catalogFamily,
            storeKey: this.storeKey,
            sessionId,
            projectPath: cwd,
            updatedAtMs: mtimeMs,
            createdAtMs: createdAtMsFromFilename(file),
            fidelity: "identity",
            sourceVersion: fileSourceVersion(mtimeMs, size),
            location: { kind: "file", path: filePath },
          }),
          nativeStorageScope,
        });
      }
    }

    return {
      sourceVersion: `${cwdDirsVisited}:${rows.length}:${Math.trunc(newestMs)}`,
      rows,
      metrics: {
        cwdDirsVisited,
        transcriptsSeen,
        headersRead,
        skippedByMode,
        rows: rows.length,
      },
    };
  }
}
