import type { SessionMetadataService } from "../metadata/SessionMetadataService.js";
import {
  catalogNativeSessionId,
  type RetainedSessionCollections,
} from "../services/RetainedSessionCollections.js";
import { projectCatalogIdentities } from "./catalog-identity.js";

/** Unscoped legacy rows may still project under the public spelling. */
export async function readPublicSessionRows(
  catalog: Pick<RetainedSessionCollections, "readNativeRows">,
  sessionId: string,
  metadata?: SessionMetadataService,
  signal?: AbortSignal,
) {
  const bound = catalogNativeSessionId(metadata?.identities)(sessionId);
  const rows = await catalog.readNativeRows(
    bound && bound !== sessionId ? [bound, sessionId] : [sessionId],
  );
  return (await projectCatalogIdentities(rows, metadata, signal)).filter(
    (row) => row.sessionId === sessionId,
  );
}
