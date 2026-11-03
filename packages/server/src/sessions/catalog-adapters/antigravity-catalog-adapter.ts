import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import { antigravitySessionsDir } from "../../sdk/providers/antigravity-runtime.js";
import {
  ANTIGRAVITY_METADATA_LIMIT,
  ANTIGRAVITY_SESSION_ID,
  readAntigravityMetadata,
} from "../antigravity-metadata.js";
import type {
  NativeSessionCatalogAdapter,
  SessionCatalogScanContext,
  SessionCatalogRow,
} from "../catalog-types.js";
import { buildCatalogRow, isWithinScanMode } from "./row.js";

/** A single bounded native inventory, shared by project and session consumers. */
export class AntigravitySessionCatalogAdapter
  implements NativeSessionCatalogAdapter
{
  readonly catalogFamily = "antigravity" as const;
  readonly storeKey: string;

  constructor(options: { sessionsDir?: string } = {}) {
    this.storeKey = options.sessionsDir ?? antigravitySessionsDir();
  }

  async scan(context: SessionCatalogScanContext) {
    let files: string[];
    try {
      files = (await readdir(this.storeKey))
        .filter(
          (file) =>
            file.endsWith(".meta") &&
            ANTIGRAVITY_SESSION_ID.test(file.slice(0, -5)),
        )
        .sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return { sourceVersion: "absent", rows: [] };
    }
    if (files.length > ANTIGRAVITY_METADATA_LIMIT)
      throw new Error(
        "Antigravity native store exceeds the experimental session limit",
      );
    const rows: SessionCatalogRow[] = [];
    const version = createHash("sha256");
    for (let offset = 0; offset < files.length; offset += 8) {
      context.signal.throwIfAborted();
      const batch = await Promise.all(
        files.slice(offset, offset + 8).map(async (file) => {
          const id = file.slice(0, -5);
          const metadata = await readAntigravityMetadata(this.storeKey, id);
          if (
            !metadata ||
            !isWithinScanMode(context.mode, metadata.updatedAtMs)
          )
            return;
          return {
            ...buildCatalogRow({
              catalogFamily: this.catalogFamily,
              storeKey: this.storeKey,
              sessionId: id,
              projectPath: metadata.cwd,
              updatedAtMs: metadata.updatedAtMs,
              fidelity: "identity",
              sourceVersion: metadata.sourceVersion,
              location: { kind: "file", path: metadata.path },
            }),
            nativeStorageScope: metadata.scope,
          };
        }),
      );
      context.signal.throwIfAborted();
      for (const row of batch)
        if (row) {
          rows.push(row);
          version.update(JSON.stringify([row.sessionId, row.sourceVersion]));
        }
    }
    return {
      sourceVersion: version.digest("hex"),
      rows,
      metrics: { metadataFiles: files.length, rows: rows.length },
    };
  }
}
