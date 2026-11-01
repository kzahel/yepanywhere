import { realpath } from "node:fs/promises";
import {
  isYaSessionId,
  nativeSessionRef,
  parseNativeSessionId,
  fromUrlProjectId,
} from "@yep-anywhere/shared";
import { getProjectIdentityKey } from "../projects/paths.js";
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
export async function projectCatalogIdentities(
  nativeRows: readonly Readonly<SessionCatalogRow>[],
  metadata?: SessionMetadataService,
  signal?: AbortSignal,
): Promise<Array<SessionCatalogRow & { nativeSessionId: string }>> {
  if (signal?.aborted) return [];
  const rows = nativeRows.map((row) => ({
    ...row,
    nativeSessionId: row.sessionId,
  }));
  const identities = metadata?.identities;
  if (identities) {
    // Retained catalogue rows and physical locations stay native. This is the
    // public projection boundary, using one transaction for the publication.
    const physicalProjects = new Map<string, Promise<string>>();
    const candidates: DiscoveredSessionIdentity[] = [];
    const positions: number[] = [];
    for (const [position, row] of nativeRows.entries()) {
      if (signal?.aborted) return [];
      if (
        !["claude", "codex", "opencode"].includes(row.catalogFamily) ||
        !row.nativeStorageScope
      )
        continue;
      const native = nativeSessionRef(
        row.catalogFamily,
        row.nativeStorageScope,
        parseNativeSessionId(row.sessionId),
      );
      const bound = identities.lookupNative(native);
      let projectId = row.projectId;
      if (
        row.catalogFamily === "opencode" &&
        bound &&
        bound.projectId !== row.projectId &&
        row.nativeDirectoryProjectId
      ) {
        const original = fromUrlProjectId(bound.projectId);
        const directoryKey = getProjectIdentityKey(
          fromUrlProjectId(row.nativeDirectoryProjectId),
        );
        let matches = getProjectIdentityKey(original) === directoryKey;
        if (!matches) {
          let physical = physicalProjects.get(original);
          if (!physical) {
            physical = realpath(original).catch(() => original);
            physicalProjects.set(original, physical);
          }
          matches = getProjectIdentityKey(await physical) === directoryKey;
          if (signal?.aborted) return [];
        }
        if (matches) projectId = bound.projectId;
      }
      candidates.push({
        native,
        provider: row.provider ?? row.catalogFamily,
        legacyProvider: metadata?.getMetadata(row.sessionId)?.provider,
        projectId,
        createdAt: row.createdAt ?? row.updatedAt,
      });
      positions.push(position);
    }
    if (signal?.aborted) return [];
    for (const [index, identity] of identities
      .adoptDiscoveredBatch(candidates)
      .entries()) {
      const position = positions[index]!;
      rows[position] = {
        ...rows[position]!,
        sessionId: identity.sessionId,
        provider: identity.provider,
        projectId: identity.projectId,
        projectPath: fromUrlProjectId(identity.projectId),
        projectIdentityKey: getProjectIdentityKey(
          fromUrlProjectId(identity.projectId),
        ),
      };
    }
  }
  return rows;
}
