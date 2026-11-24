import { readdir, realpath } from "node:fs/promises";
import { relative, sep } from "node:path";
import { COPILOT_SESSIONS_DIR } from "../../projects/paths.js";
import type {
  NativeSessionCatalogAdapter,
  SessionCatalogAdapterScan,
  SessionCatalogRow,
  SessionCatalogRowKey,
  SessionCatalogScanContext,
} from "../catalog-types.js";
import {
  COPILOT_SESSION_DIRECTORY,
  locateCopilotTranscript,
  readCopilotTranscriptHead,
} from "../copilot-transcript.js";
import {
  buildCatalogRow,
  catalogFileVersion,
  isWithinScanMode,
} from "./row.js";

export class CopilotSessionCatalogAdapter
  implements NativeSessionCatalogAdapter
{
  readonly catalogFamily = "copilot" as const;

  constructor(
    readonly storeKey = COPILOT_SESSIONS_DIR,
    private readonly changedIds?: ReadonlySet<string>,
  ) {}

  forChangedPaths(paths: ReadonlySet<string>): CopilotSessionCatalogAdapter {
    const ids = new Set<string>();
    for (const path of paths) {
      const relativePath = relative(this.storeKey, path);
      if (!relativePath) return this;
      const [id, file, extra] = relativePath.split(sep);
      if (
        id &&
        !extra &&
        file === "events.jsonl" &&
        COPILOT_SESSION_DIRECTORY.test(id)
      )
        ids.add(id);
    }
    return new CopilotSessionCatalogAdapter(this.storeKey, ids);
  }

  async scan(
    context: SessionCatalogScanContext,
  ): Promise<SessionCatalogAdapterScan> {
    const scope = await realpath(this.storeKey).catch(() => undefined);
    if (!scope) return { sourceVersion: "absent", rows: [], metrics: {} };
    const ids =
      this.changedIds ??
      (await readdir(scope, { withFileTypes: true }))
        .filter((dir) => dir.isDirectory())
        .map((dir) => dir.name);
    const rows: SessionCatalogRow[] = [];
    const removed: SessionCatalogRowKey[] = [];
    for (const id of ids) {
      context.signal.throwIfAborted();
      const transcript = await locateCopilotTranscript(scope, id);
      if (
        transcript &&
        !isWithinScanMode(context.mode, transcript.stats.mtimeMs)
      )
        continue;
      const head =
        transcript && (await readCopilotTranscriptHead(transcript.path, id));
      if (!transcript || !head) {
        if (this.changedIds)
          removed.push({
            catalogFamily: this.catalogFamily,
            storeKey: this.storeKey,
            sessionId: id,
          });
        continue;
      }
      rows.push({
        ...buildCatalogRow({
          catalogFamily: this.catalogFamily,
          storeKey: this.storeKey,
          sessionId: id,
          projectPath: head.cwd,
          createdAtMs: head.createdAtMs,
          updatedAtMs: transcript.stats.mtimeMs,
          title: head.title,
          fidelity: "head",
          sourceVersion: catalogFileVersion(transcript.stats),
          location: { kind: "file", path: transcript.path },
        }),
        nativeStorageScope: scope,
      });
    }
    return {
      sourceVersion: String(context.targetGeneration),
      rows,
      metrics: { rows: rows.length },
      ...(this.changedIds ? { partial: true, removed } : {}),
    };
  }
}
