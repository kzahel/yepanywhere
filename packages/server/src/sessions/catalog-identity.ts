import {
  isYaSessionId,
  nativeSessionRef,
  parseNativeSessionId,
} from "@yep-anywhere/shared";
import type { SessionMetadataService } from "../metadata/SessionMetadataService.js";
import type { DiscoveredSessionIdentity } from "./SessionIdentityStore.js";
import type { SessionCatalogRow } from "./catalog-types.js";

/** Compact native rows name their actual store; absent scope is not ambient. */
export function nativeCatalogSessionRef(row: Readonly<SessionCatalogRow>) {
  return row.nativeStorageScope
    ? nativeSessionRef(
        row.catalogFamily,
        row.nativeStorageScope,
        parseNativeSessionId(row.sessionId),
      )
    : undefined;
}

/** Metadata belongs to the public resource, never an unrelated native spelling. */
export function metadataForNativeCatalogRow(
  row: Readonly<SessionCatalogRow>,
  metadata?: SessionMetadataService,
) {
  if (!metadata) return undefined;
  const native = nativeCatalogSessionRef(row);
  const bound = native && metadata.identities.lookupNative(native);
  if (bound) return metadata.getMetadata(bound.sessionId);
  // A public claim without this native binding is a different resource (or
  // an unbound one). Do not import its archive/provider facts into this row.
  if (
    isYaSessionId(row.sessionId) &&
    metadata.identities.resolveYa(row.sessionId)
  )
    return undefined;
  return metadata.getMetadata(row.sessionId);
}

/** Physical catalogue facts remain native; every public consumer projects here. */
export function projectCatalogIdentities(
  nativeRows: readonly Readonly<SessionCatalogRow>[],
  metadata?: SessionMetadataService,
): Array<SessionCatalogRow & { nativeSessionId: string }> {
  const rows = nativeRows.map((row) => ({
    ...row,
    nativeSessionId: row.sessionId,
  }));
  const identities = metadata?.identities;
  if (identities) {
    // Retained catalogue rows and physical locations stay native. This is the
    // public projection boundary, using one transaction for the publication.
    const candidates: DiscoveredSessionIdentity[] = [];
    const positions: number[] = [];
    for (const [position, row] of nativeRows.entries()) {
      if (
        (row.catalogFamily !== "claude" && row.catalogFamily !== "codex") ||
        !row.nativeStorageScope
      )
        continue;
      candidates.push({
        native: nativeSessionRef(
          row.catalogFamily,
          row.nativeStorageScope,
          parseNativeSessionId(row.sessionId),
        ),
        provider: row.provider ?? row.catalogFamily,
        legacyProvider: metadata?.getMetadata(row.sessionId)?.provider,
        projectId: row.projectId,
        createdAt: row.createdAt ?? row.updatedAt,
      });
      positions.push(position);
    }
    for (const [index, identity] of identities
      .adoptDiscoveredBatch(candidates)
      .entries()) {
      const position = positions[index]!;
      rows[position] = {
        ...rows[position]!,
        sessionId: identity.sessionId,
        provider: identity.provider,
      };
    }
  }
  return rows;
}
