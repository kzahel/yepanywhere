import type { ProjectScanner } from "../../projects/scanner.js";
import { stat } from "node:fs/promises";
import { catalogFileVersion } from "../../sessions/catalog-adapters/row.js";
import type { RetainedSessionCollections } from "../RetainedSessionCollections.js";
import {
  getSessionSourceForProvider,
  type ProviderResolutionDeps,
} from "../../sessions/provider-resolution.js";
import {
  getCodexMessageSourceByteCursor,
  normalizeSession,
} from "../../sessions/normalization.js";
import { sessionCatalogRowKey } from "../../sessions/catalog-types.js";
import { nativeCatalogSessionRef } from "../../sessions/catalog-identity.js";
import type { VocabularySession } from "./VocabularyLearning.js";

export async function* vocabularySessions(
  catalog: Pick<RetainedSessionCollections, "read" | "invalidate">,
  scanner: Pick<ProjectScanner, "getProject">,
  deps: ProviderResolutionDeps,
  cutoff: number,
): AsyncIterable<VocabularySession> {
  const snapshot = await catalog.read();
  for (const row of snapshot.rows) {
    if (Date.parse(row.updatedAt) < cutoff) continue;
    const native = nativeCatalogSessionRef(row);
    // Old compact rows need the next scoped catalogue publication. Skipping
    // leaves their checkpoint untouched and does not fail unrelated learning.
    if (
      !native &&
      (row.catalogFamily === "claude" || row.catalogFamily === "codex")
    )
      continue;
    yield {
      key: sessionCatalogRowKey(row),
      version: row.sourceVersion,
      updatedAt: Date.parse(row.updatedAt),
      messages: async function* () {
        const sourcePath =
          row.location.kind === "file" ? row.location.path : undefined;
        const before = sourcePath
          ? catalogFileVersion(await stat(sourcePath))
          : undefined;
        const project = await scanner.getProject(row.projectId);
        if (!project)
          throw new Error(
            `Speech learning cannot resolve project for ${row.sessionId}`,
          );
        const reader = native
          ? deps.readerFactory(
              { ...project, provider: row.provider ?? row.catalogFamily },
              native,
            )
          : getSessionSourceForProvider(
              project,
              deps,
              row.provider ?? row.catalogFamily,
            )?.reader;
        if (!reader)
          throw new Error(
            `Speech learning cannot resolve provider for ${row.sessionId}`,
          );
        const summaryHint = await reader.getSessionSummary(
          row.sessionId,
          project.id,
          { readMode: "head" },
        );
        let beforeMessageId: string | undefined;
        do {
          const loaded = await reader.getSession(
            row.sessionId,
            project.id,
            undefined,
            {
              includeOrphans: false,
              tailCompactions: 1,
              beforeMessageId,
              summaryHint: summaryHint ?? undefined,
            },
          );
          if (!loaded)
            throw new Error(`Speech learning cannot read ${row.sessionId}`);
          const messages = normalizeSession(loaded).messages;
          yield messages;
          if (!loaded.readWindow?.omittedPrefix) break;
          const first = messages[0];
          const cursor =
            first &&
            (getCodexMessageSourceByteCursor(first) ??
              first.uuid ??
              (typeof first.id === "string" ? first.id : undefined));
          if (!cursor || cursor === beforeMessageId)
            throw new Error("Speech learning history cursor did not advance");
          beforeMessageId = cursor;
        } while (true);
        if (
          sourcePath &&
          catalogFileVersion(await stat(sourcePath)) !== before
        ) {
          catalog.invalidate(sourcePath);
          throw new Error(
            "Speech source changed during the scan; waiting for a stable snapshot",
          );
        }
      },
    };
  }
}
