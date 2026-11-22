import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { opendir } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";
import {
  antigravitySessionsDir,
  antigravitySummariesPath,
} from "../../sdk/providers/antigravity-runtime.js";
import {
  ANTIGRAVITY_METADATA_LIMIT,
  ANTIGRAVITY_SESSION_ID,
  readAntigravityMetadata,
} from "../antigravity-metadata.js";
import {
  SESSION_CATALOG_TITLE_MAX_LENGTH,
  type NativeSessionCatalogAdapter,
  type SessionCatalogScanContext,
  type SessionCatalogRow,
} from "../catalog-types.js";
import { buildCatalogRow, isWithinScanMode } from "./row.js";

function storeOwnsCandidate(root: string, candidate: string): boolean {
  const summaries = antigravitySummariesPath(root);
  if (candidate === summaries || candidate === `${summaries}-wal`) return true;
  const child = relative(root, candidate);
  return child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

/** A single bounded native inventory, shared by project and session consumers. */
export class AntigravitySessionCatalogAdapter
  implements NativeSessionCatalogAdapter
{
  readonly catalogFamily = "antigravity" as const;
  readonly storeKey: string;

  constructor(options: { sessionsDir?: string } = {}) {
    this.storeKey = options.sessionsDir ?? antigravitySessionsDir();
  }

  ownsPath(path: string): boolean {
    if (storeOwnsCandidate(this.storeKey, path)) return true;
    try {
      const physicalRoot = realpathSync(this.storeKey);
      if (storeOwnsCandidate(physicalRoot, path)) return true;
      try {
        const physicalPath = realpathSync(path);
        return (
          storeOwnsCandidate(this.storeKey, physicalPath) ||
          storeOwnsCandidate(physicalRoot, physicalPath)
        );
      } catch {
        return false;
      }
    } catch {
      return false;
    }
  }

  async scan(context: SessionCatalogScanContext) {
    const files: string[] = [];
    try {
      for await (const entry of await opendir(this.storeKey)) {
        context.signal.throwIfAborted();
        if (
          !entry.name.endsWith(".db") ||
          !ANTIGRAVITY_SESSION_ID.test(entry.name.slice(0, -3))
        )
          continue;
        if (files.length >= ANTIGRAVITY_METADATA_LIMIT)
          throw new Error(
            "Antigravity native store exceeds the experimental session limit",
          );
        files.push(entry.name);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return { sourceVersion: "absent", rows: [] };
    }
    files.sort();
    const rows: SessionCatalogRow[] = [];
    const version = createHash("sha256");
    for (let offset = 0; offset < files.length; offset += 8) {
      context.signal.throwIfAborted();
      const batch = await Promise.allSettled(
        files.slice(offset, offset + 8).map(async (file) => {
          const id = file.slice(0, -3);
          const metadata = await readAntigravityMetadata(this.storeKey, id);
          if (
            !metadata ||
            metadata.isChild ||
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
              // agy keeps a native title in its summaries index.
              ...(metadata.title
                ? {
                    title: metadata.title.slice(
                      0,
                      SESSION_CATALOG_TITLE_MAX_LENGTH,
                    ),
                  }
                : {}),
              fidelity: metadata.title ? "head" : "identity",
              sourceVersion: metadata.sourceVersion,
              location: { kind: "file", path: metadata.path },
            }),
            nativeStorageScope: metadata.scope,
          };
        }),
      );
      context.signal.throwIfAborted();
      for (const result of batch) {
        if (result.status === "rejected") throw result.reason;
        const row = result.value;
        if (row) {
          rows.push(row);
          version.update(JSON.stringify([row.sessionId, row.sourceVersion]));
        }
      }
    }
    return {
      sourceVersion: version.digest("hex"),
      rows,
      metrics: { metadataFiles: files.length, rows: rows.length },
    };
  }
}
