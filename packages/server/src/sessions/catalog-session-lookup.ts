import {
  fromUrlProjectId,
  isYaSessionId,
  type ProviderName,
  type UrlProjectId,
} from "@yep-anywhere/shared";
import type { SessionMetadataService } from "../metadata/SessionMetadataService.js";
import type { RetainedSessionCollections } from "../services/RetainedSessionCollections.js";
import { getProjectIdentityKey } from "../projects/paths.js";
import { nativeCatalogSessionRef } from "./catalog-identity.js";
import { providerCatalogFamily } from "./provider-catalog-family.js";
import type { SessionCatalogRow } from "./catalog-types.js";

/** One request's exact lookups share accepted project rows; no native acquisition. */
export function createCatalogSessionLookup(
  catalog:
    | Pick<RetainedSessionCollections, "readPublishedProjectRows">
    | undefined,
  metadata?: SessionMetadataService,
) {
  // Request-scoped, released with its response. Persistent row caching belongs
  // to SessionCatalogService's bounded, source-versioned project read owner.
  const projects = new Map<
    UrlProjectId,
    Promise<ReadonlyMap<string, readonly Readonly<SessionCatalogRow>[]>>
  >();
  return async (
    projectId: UrlProjectId,
    sessionId: string,
    provider?: ProviderName,
  ): Promise<Readonly<SessionCatalogRow> | undefined> => {
    if (!catalog) return;
    const identities = metadata?.identities;
    const identity = isYaSessionId(sessionId)
      ? identities?.resolveYa(sessionId)
      : undefined;
    if (identity) {
      if (!identity.native) return;
      const working =
        metadata?.getMetadata(sessionId)?.workingProjectId ??
        identity.projectId;
      if (
        getProjectIdentityKey(fromUrlProjectId(working)) !==
        getProjectIdentityKey(fromUrlProjectId(projectId))
      )
        return;
    }
    const sourceProject = identity?.projectId ?? projectId;
    let rows = projects.get(sourceProject);
    if (!rows) {
      rows = catalog
        .readPublishedProjectRows(sourceProject)
        .then((accepted) => {
          const byId = new Map<string, Readonly<SessionCatalogRow>[]>();
          for (const row of accepted) {
            const matches = byId.get(row.sessionId);
            if (matches) matches.push(row);
            else byId.set(row.sessionId, [row]);
          }
          return byId;
        });
      projects.set(sourceProject, rows);
    }
    const recorded =
      provider ?? identity?.provider ?? metadata?.getProvider?.(sessionId);
    const family = recorded && providerCatalogFamily(recorded);
    const candidates = (
      (await rows).get(identity?.native?.id ?? sessionId) ?? []
    ).filter((row) => {
      if (family && family !== row.catalogFamily) return false;
      if (identity?.native)
        return (
          row.catalogFamily === identity.native.family &&
          row.nativeStorageScope === identity.native.storageScope &&
          row.sessionId === identity.native.id
        );
      if (row.sessionId !== sessionId) return false;
      const native = nativeCatalogSessionRef(row);
      if (!native)
        return !identities?.hasPendingNativeFamily(row.catalogFamily);
      const bound = identities?.lookupNative(native);
      if (bound) return bound.sessionId === sessionId;
      return !identities || identities.canDiscoverNative(native);
    });
    // Missing/ambiguous membership is unknown, never authority for a fallback
    // reader, native adoption, or a same-string session in another store.
    return candidates.length === 1 ? candidates[0] : undefined;
  };
}
