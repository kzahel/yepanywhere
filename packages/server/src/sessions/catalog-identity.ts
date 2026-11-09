import { realpath } from "node:fs/promises";
import {
  isYaSessionId,
  nativeSessionFamily,
  nativeSessionRef,
  parseNativeSessionId,
  fromUrlProjectId,
  type NativeSessionRef,
} from "@yep-anywhere/shared";
import { getProjectIdentityKey } from "../projects/paths.js";
import type { SessionMetadataService } from "../metadata/SessionMetadataService.js";
import type {
  DiscoveredSessionIdentity,
  SessionIdentity,
} from "./SessionIdentityStore.js";
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
  if (
    !bound &&
    (native
      ? !metadata.identities.canDiscoverNative(native)
      : metadata.identities.hasPendingNativeFamily(row.catalogFamily))
  )
    return undefined;
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

export type ProjectedCatalogRow = Readonly<
  SessionCatalogRow & { nativeSessionId: string }
>;

/**
 * Rows already bound to a consistent identity, per identity store and per
 * published row object. A binding is never changed or removed once written,
 * and the catalog reuses a row's object while the row is unchanged, so such a
 * row projects the same way for as long as its object lives. Rows without a
 * native scope, unbound rows (adopted ones are kept from their next read),
 * rows whose binding conflicts and OpenCode-overridden rows are projected on
 * every read.
 */
const boundProjections = new WeakMap<
  object,
  WeakMap<Readonly<SessionCatalogRow>, ProjectedCatalogRow>
>();

/** Physical catalogue facts remain native; every public consumer projects here. */
export async function projectCatalogIdentities(
  nativeRows: readonly Readonly<SessionCatalogRow>[],
  metadata?: SessionMetadataService,
  signal?: AbortSignal,
): Promise<ProjectedCatalogRow[]> {
  if (signal?.aborted) return [];
  const excluded = new Set<number>();
  const identities = metadata?.identities;
  let cached = identities && boundProjections.get(identities);
  if (identities && !cached) {
    cached = new WeakMap();
    boundProjections.set(identities, cached);
  }
  const rows = nativeRows.map(
    (row): ProjectedCatalogRow =>
      cached?.get(row) ?? { ...row, nativeSessionId: row.sessionId },
  );
  if (identities && cached) {
    // Retained catalogue rows and physical locations stay native. This is the
    // public projection boundary: one indexed read per provider store finds
    // existing bindings, and only rows without one enter the publication's
    // single adoption transaction.
    const physicalProjects = new Map<string, Promise<string>>();
    const pendingFamilies = new Map<string, boolean>();
    const scoped: Array<{ position: number; native: NativeSessionRef }> = [];
    for (const [position, row] of nativeRows.entries()) {
      if (cached.has(row)) continue;
      if (row.nativeStorageScope) {
        scoped.push({
          position,
          native: nativeSessionRef(
            row.catalogFamily,
            row.nativeStorageScope,
            parseNativeSessionId(row.sessionId),
          ),
        });
        continue;
      }
      let pending = pendingFamilies.get(row.catalogFamily);
      if (pending === undefined) {
        pending = identities.hasPendingNativeFamily(row.catalogFamily);
        pendingFamilies.set(row.catalogFamily, pending);
      }
      if (pending) excluded.add(position);
    }
    const boundIdentities = identities.lookupNativeBatch(
      scoped.map(({ native }) => native),
    );
    const project = (position: number, identity: SessionIdentity) => {
      const projectPath = fromUrlProjectId(identity.projectId);
      const projected = {
        ...rows[position]!,
        sessionId: identity.sessionId,
        provider: identity.provider,
        projectId: identity.projectId,
        projectPath,
        projectIdentityKey: getProjectIdentityKey(projectPath),
      };
      rows[position] = projected;
      return projected;
    };
    const candidates: DiscoveredSessionIdentity[] = [];
    const positions: number[] = [];
    // After an await, a binding may have landed since the batch read; later
    // rows read their own, as each row did before batching.
    let yielded = false;
    for (const [index, { position, native }] of scoped.entries()) {
      if (signal?.aborted) return [];
      const row = nativeRows[position]!;
      const bound = yielded
        ? identities.lookupNative(native)
        : boundIdentities[index];
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
          yielded = true;
          matches = getProjectIdentityKey(await physical) === directoryKey;
          if (signal?.aborted) return [];
        }
        if (matches) projectId = bound.projectId;
      }
      const provider = row.provider ?? row.catalogFamily;
      // Bindings are permanent, so a consistent one needs no adoption. A
      // conflicting one still goes through adoption, which rejects it.
      if (
        bound &&
        bound.projectId === projectId &&
        nativeSessionFamily(provider) === native.family
      ) {
        const projected = project(position, bound);
        // An OpenCode override depends on the filesystem; it is not kept.
        if (projectId === row.projectId)
          cached.set(row, Object.freeze(projected));
        continue;
      }
      candidates.push({
        native,
        provider,
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
      if (identity) project(position, identity);
      else excluded.add(position);
    }
  }
  return rows.filter((_, index) => !excluded.has(index));
}
