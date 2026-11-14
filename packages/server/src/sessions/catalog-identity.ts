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
import { SessionIdentityConflict } from "./SessionIdentityStore.js";
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

/**
 * The public id each published row object is bound to, per identity store.
 * Bindings never change once written, so a bound row needs no second lookup.
 */
const boundSessionIds = new WeakMap<
  object,
  WeakMap<Readonly<SessionCatalogRow>, string>
>();

/** Metadata belongs to the public resource, never an unrelated native spelling. */
export function metadataForNativeCatalogRow(
  row: Readonly<SessionCatalogRow>,
  metadata?: SessionMetadataService,
) {
  if (!metadata) return undefined;
  let known = boundSessionIds.get(metadata.identities);
  if (!known) {
    known = new WeakMap();
    boundSessionIds.set(metadata.identities, known);
  }
  const boundId = known.get(row);
  if (boundId !== undefined) return metadata.getMetadata(boundId);
  const native = nativeCatalogSessionRef(row);
  const bound = native && metadata.identities.lookupNative(native);
  if (bound) known.set(row, bound.sessionId);
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
 * rows whose binding conflicts and rows reconciled through filesystem paths
 * are projected on every read.
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
  return (await projectCatalogIdentityResult(nativeRows, metadata, signal))
    .rows;
}

export interface CatalogIdentityProjection {
  rows: ProjectedCatalogRow[];
  /** Request-owned native evidence, never exposed as public session metadata. */
  conflicts: Readonly<SessionCatalogRow>[];
}

export const CATALOG_IDENTITY_CONFLICT_MESSAGE =
  "Some sessions could not be matched to their saved project folders. Other sessions are still available.";

/** Existing catalogue uncertainty/error fields also describe withheld rows. */
export function catalogWithIdentityConflicts<T extends { complete: boolean }>(
  catalog: T,
  hasConflicts: boolean,
): T & { refreshError?: string } {
  return hasConflicts
    ? {
        ...catalog,
        complete: false,
        refreshError: CATALOG_IDENTITY_CONFLICT_MESSAGE,
      }
    : catalog;
}

export async function projectCatalogIdentityResult(
  nativeRows: readonly Readonly<SessionCatalogRow>[],
  metadata?: SessionMetadataService,
  signal?: AbortSignal,
): Promise<CatalogIdentityProjection> {
  const conflicts: Readonly<SessionCatalogRow>[] = [];
  if (signal?.aborted) return { rows: [], conflicts };
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
    const physicalProjects = new Map<string, Promise<string | undefined>>();
    const physicalProject = (path: string) => {
      let physical = physicalProjects.get(path);
      if (!physical) {
        physical = realpath(path).catch(() => undefined);
        physicalProjects.set(path, physical);
      }
      return physical;
    };
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
      if (signal?.aborted) return { rows: [], conflicts };
      const row = nativeRows[position]!;
      const bound = yielded
        ? identities.lookupNative(native)
        : boundIdentities[index];
      let projectId = row.projectId;
      // Claude records the folder its process ran in, which is not the saved
      // project when that was selected through a link (or /tmp on macOS).
      // The binding names this exact transcript directory and id, so the row
      // is the saved session whatever the link names today: a retargeted or
      // missing link is not a second claim on it. The observed folder never
      // re-homes the session; only the saved project is published.
      const savedClaudeProject =
        row.catalogFamily === "claude" &&
        bound !== undefined &&
        bound.projectId !== row.projectId;
      if (savedClaudeProject) projectId = bound.projectId;
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
          yielded = true;
          matches =
            getProjectIdentityKey(
              (await physicalProject(original)) ?? original,
            ) === directoryKey;
          if (signal?.aborted) return { rows: [], conflicts };
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
        // OpenCode overrides depend on the filesystem; they are not kept.
        if (projectId === row.projectId || savedClaudeProject)
          cached.set(row, Object.freeze(projected));
        continue;
      }
      candidates.push({
        native,
        provider,
        projectId,
        createdAt: row.createdAt ?? row.updatedAt,
      });
      positions.push(position);
    }
    // Only adoption candidates need legacy metadata. Bound identities never
    // acquire cold metadata merely to repeat their existing projection.
    for (let offset = 0; offset < candidates.length; offset += 256) {
      if (signal?.aborted) return { rows: [], conflicts };
      const chunk = candidates.slice(offset, offset + 256);
      const batch = metadata?.getMetadataBatch?.(
        chunk.map((candidate) => String(candidate.native.id)),
      );
      for (const candidate of chunk) {
        const id = String(candidate.native.id);
        candidate.legacyProvider = batch?.has(id)
          ? batch.get(id)?.provider
          : metadata?.getMetadata(id)?.provider;
      }
      if (offset + 256 < candidates.length)
        await new Promise<void>((resolve) => setImmediate(resolve));
    }
    if (signal?.aborted) return { rows: [], conflicts };
    for (const [index, identity] of identities
      .observeDiscoveredBatch(candidates)
      .entries()) {
      const position = positions[index]!;
      if (identity instanceof SessionIdentityConflict) {
        conflicts.push(nativeRows[position]!);
        excluded.add(position);
      } else if (identity) project(position, identity);
      else excluded.add(position);
    }
  }
  return { rows: rows.filter((_, index) => !excluded.has(index)), conflicts };
}
