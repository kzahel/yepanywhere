import type { SessionMetadataService } from "../../metadata/SessionMetadataService.js";
import { projectCatalogIdentities } from "../../sessions/catalog-identity.js";
import {
  type SessionCatalogRow,
  sessionCatalogRowKey,
} from "../../sessions/catalog-types.js";
import type { RetainedSessionCollections } from "../RetainedSessionCollections.js";
import type { IssueCatalogRow, IssueIndexerDeps } from "./IssueIndexer.js";

/**
 * The issue indexer's view of the catalog (plan 189 step 4): the rows
 * changed since its last sweep, projected to public identities, and point
 * lookups for the worker, which keeps a catalog key per job rather than a
 * copy of the row.
 */
export function issueCatalogSource(
  catalog: Pick<RetainedSessionCollections, "readChanges" | "readRow">,
  metadata?: SessionMetadataService,
  signal?: AbortSignal,
): Pick<IssueIndexerDeps, "changes" | "row"> {
  return {
    async changes(since, retry) {
      const changes = await catalog.readChanges(since);
      const native: Readonly<SessionCatalogRow>[] = [...changes.rows];
      if (!changes.full && retry.size) {
        const changed = new Set(native.map(sessionCatalogRowKey));
        for (const key of retry) {
          const row = changed.has(key) ? undefined : await catalog.readRow(key);
          if (row) native.push(row);
        }
      }
      const rows = (
        await projectCatalogIdentities(native, metadata, signal)
      ).map(keyed);
      const projected = new Set(rows.map((row) => row.catalogKey));
      return {
        mark: {
          catalogEpoch: changes.catalogEpoch,
          catalogGeneration: changes.catalogGeneration,
        },
        full: changes.full,
        rows,
        removed: changes.removed.map(sessionCatalogRowKey),
        excluded: native
          .map(sessionCatalogRowKey)
          .filter((key) => !projected.has(key)),
      };
    },
    async row(key) {
      const row = await catalog.readRow(key);
      if (!row) return undefined;
      const [projected] = await projectCatalogIdentities(
        [row],
        metadata,
        signal,
      );
      return projected && keyed(projected);
    },
  };
}

function keyed(
  row: SessionCatalogRow & { nativeSessionId: string },
): IssueCatalogRow {
  const { nativeSessionId, ...rest } = row;
  return {
    ...rest,
    catalogKey: sessionCatalogRowKey({ ...row, sessionId: nativeSessionId }),
  };
}
