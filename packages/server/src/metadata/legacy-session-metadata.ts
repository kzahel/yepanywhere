import * as fs from "node:fs/promises";
import type { SqliteDatabase, SqliteStatement } from "../storage/sqlite.js";
import {
  encodeMetadata,
  type SessionMetadataRows,
} from "./session-metadata-rows.js";

type ImportedMetadata = Parameters<typeof encodeMetadata>[0];

/** Shape of the legacy `session-metadata.json`, read only by the one-time import. */
interface LegacySessionMetadataFile {
  sessions?: Record<string, ImportedMetadata>;
  version?: number;
}

/** Startup-only marker statements never occupy the profile's live query budget. */
export async function initializeLegacyMetadata(
  legacyFilePath: string,
  database: SqliteDatabase,
  rows: SessionMetadataRows,
): Promise<void> {
  const selectImport = database.prepare(
    "SELECT source FROM session_metadata_import WHERE id = 1",
  );
  let insertImport: SqliteStatement | undefined;
  try {
    const marker = selectImport.get<{ source: string }>();
    if (!marker) {
      insertImport = database.prepare(
        "INSERT INTO session_metadata_import (id, imported_at, source) VALUES (1, ?, ?)",
      );
      await importLegacyMetadata(legacyFilePath, database, rows, {
        selectImport,
        insertImport,
      });
    } else if (marker.source === "json") {
      await fs.rm(legacyFilePath, { force: true }).catch(() => undefined);
    }
  } finally {
    selectImport.finalize();
    insertImport?.finalize();
  }
}

export async function importLegacyMetadata(
  legacyFilePath: string,
  database: SqliteDatabase,
  rows: SessionMetadataRows,
  statements: { selectImport: SqliteStatement; insertImport: SqliteStatement },
): Promise<void> {
  const content = await fs.readFile(legacyFilePath, "utf-8").catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(
      `Cannot read ${legacyFilePath} for import into the database`,
      { cause: error },
    );
  });
  let sessions: Record<string, ImportedMetadata> = {};
  if (content !== undefined) {
    let parsed: LegacySessionMetadataFile;
    try {
      parsed = JSON.parse(content) as LegacySessionMetadataFile;
    } catch (error) {
      throw new Error(
        `Cannot import ${legacyFilePath}: it is not valid JSON. Repair or move it aside and restart.`,
        { cause: error },
      );
    }
    sessions = parsed.sessions ?? {};
    if ((parsed.version ?? 0) < 3) {
      for (const metadata of Object.values(sessions)) {
        if (!metadata.parentSessionId) continue;
        if (/^\/btw(?:\s+|$)/i.test(metadata.customTitle?.trimStart() ?? "")) {
          metadata.parentSessionKind = "btw-aside";
        } else {
          metadata.forkedFromSessionId ??= metadata.parentSessionId;
          metadata.parentSessionId = undefined;
          metadata.parentSessionKind = undefined;
        }
      }
    }
  }
  const imported = database.transaction(() => {
    // Another connection may have imported while the file was being read.
    if (statements.selectImport.get()) return false;
    for (const [sessionId, metadata] of Object.entries(sessions)) {
      rows.write(sessionId, encodeMetadata(metadata));
    }
    statements.insertImport.run(
      new Date().toISOString(),
      content === undefined ? "none" : "json",
    );
    return true;
  });
  if (imported && content !== undefined) {
    console.log(
      `[SessionMetadataService] Imported ${Object.keys(sessions).length} sessions from ${legacyFilePath}; the file is no longer read or written`,
    );
  }
}
