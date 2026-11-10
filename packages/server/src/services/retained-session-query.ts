import {
  pendingNonHumanUserTurn,
  type SessionMetadata,
} from "../metadata/SessionMetadataService.js";
import { isYaSessionId, type NativeSessionRef } from "@yep-anywhere/shared";
import { getProjectName } from "../projects/paths.js";
import {
  projectCatalogIdentities,
  nativeCatalogSessionRef,
} from "../sessions/catalog-identity.js";
import {
  sessionCatalogRowKey,
  type SessionCatalogRow,
} from "../sessions/catalog-types.js";
import { mergeCreationGlobalItems } from "../routes/creation-session-collections.js";
import {
  compareProjectOptions,
  retainedNativeItem,
} from "../routes/retained-session-item.js";
import type { RetainedItemsDeps } from "../routes/retained-session-collections.js";
import { getActiveSessionIndexOptions } from "../routes/session-list-options.js";
import type { GlobalSessionItem } from "../routes/global-sessions.js";
import type { SessionCatalogToken } from "./SessionCatalogService.js";
import type { RetainedSessionCollections } from "./RetainedSessionCollections.js";
import {
  SessionCollectionSql,
  type CollectionPageQuery,
  type CollectionStoredRow,
} from "./session-collection-sql.js";
import { sessionOwnershipFromProcess } from "../sessions/session-runtime-overlay.js";

/** A single weakly owned query projection per retained collection, never per tab.
 * Different dependency owners replace the projection, rather than sharing facts.
 */
const owners = new WeakMap<
  RetainedSessionCollections,
  { deps: RetainedItemsDeps; index: RetainedSessionQuery }
>();
const INPUTS = [
  "signal",
  "sessionMetadataService",
  "supervisor",
  "notificationService",
  "externalTracker",
  "sessionAutoArchiveDays",
  "projectDisplayName",
] as const;
export function retainedSessionQuery(
  service: RetainedSessionCollections,
  deps: RetainedItemsDeps,
): RetainedSessionQuery {
  const known = owners.get(service);
  if (known && INPUTS.every((key) => known.deps[key] === deps[key]))
    return known.index;
  owners.delete(service);
  known?.index.dispose();
  const index = new RetainedSessionQuery(service, deps);
  owners.set(service, { deps, index });
  return index;
}

export class RetainedSessionQuery {
  private readonly sql: SessionCollectionSql;
  private token?: SessionCatalogToken;
  private nextOrdinal = 0;
  private nextControlOrdinal = 1_000_000_000;
  private overflow = false;
  /** Pending overlays observed before their eventual commit or cancellation. */
  private pendingIds = new Set<string>();
  /** Project names are response-sized, not one entry per session. */
  private names = new Map<string, string>();
  private chain: Promise<void> = Promise.resolve();
  private disposed = false;
  private readonly unsubscribers: Array<() => void> = [];
  constructor(
    private readonly service: RetainedSessionCollections,
    private readonly deps: RetainedItemsDeps,
  ) {
    this.sql = new SessionCollectionSql(service.queryDatabase);
    try {
      const dirty = (id: string) => {
        try {
          this.sql.markDirty(id);
        } catch {
          this.overflow = true;
        }
      };
      const metadata = deps.sessionMetadataService
        ?.collectionState?.()
        .subscribe(dirty);
      if (metadata) this.unsubscribers.push(metadata);
      const notification = deps.notificationService?.subscribeChanges?.(dirty);
      const creation =
        deps.sessionMetadataService?.creations?.subscribeChanges?.(dirty);
      if (notification) this.unsubscribers.push(notification);
      if (creation) this.unsubscribers.push(creation);
      const dispose = () => this.dispose();
      service.querySignal.addEventListener("abort", dispose, { once: true });
      this.unsubscribers.push(() =>
        service.querySignal.removeEventListener("abort", dispose),
      );
    } catch (error) {
      this.dispose();
      throw error;
    }
  }
  private run<T>(read: () => Promise<T>): Promise<T> {
    const task = this.chain.then(async () => {
      this.service.querySignal.throwIfAborted();
      this.deps.signal?.throwIfAborted();
      if (this.disposed) throw new Error("Collection query owner retired");
      try {
        return await read();
      } catch (error) {
        this.token = undefined;
        throw error;
      }
    });
    this.chain = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }
  private cutoff() {
    const value = getActiveSessionIndexOptions(
      this.deps.sessionAutoArchiveDays,
    )?.activeAfterMs;
    return value !== undefined && Number.isFinite(value) ? value : undefined;
  }
  private async synchronize() {
    const changes = await this.service.readChanges(
      this.overflow ? undefined : this.token,
    );
    this.service.querySignal.throwIfAborted();
    const full = changes.full;
    const affected = new Set<string>();
    this.overflow = false;
    for (const id of this.sql.dirty()) affected.add(id);
    for (const id of this.pendingIds) affected.add(id);
    this.pendingIds = new Set(
      this.deps.sessionMetadataService?.collectionState?.().pending.keys() ??
        [],
    );
    for (const id of this.pendingIds) affected.add(id);
    for (const id of this.sql.liveIds()) affected.add(id);
    for (const process of this.deps.supervisor?.getAllProcesses?.() ?? [])
      affected.add(process.sessionId);
    const sourceProjects = new Set<string>();
    if (full) {
      this.sql.beginReplacement();
      this.names.clear();
      this.nextOrdinal = 0;
      this.nextControlOrdinal = 1_000_000_000;
      for (const row of this.deps.sessionMetadataService?.creations?.listProjections() ??
        [])
        affected.add(row.sessionId);
    }
    for (const key of changes.removed) {
      const k = sessionCatalogRowKey(key);
      const old = this.sql.source(k);
      if (old?.public_id) affected.add(old.public_id);
      if (old?.project_id) sourceProjects.add(old.project_id);
      this.sql.removeSource(k);
    }
    const native = new Map<string, Readonly<SessionCatalogRow>>(
      changes.rows.map((row) => [sessionCatalogRowKey(row), row]),
    );
    for (const { key } of this.sql.unstableSources())
      if (!native.has(key)) {
        const row = await this.service.readRow(key);
        if (row) native.set(key, row);
      }
    const originals = [...native.values()];
    const projected = await projectCatalogIdentities(
      originals,
      this.deps.sessionMetadataService,
      this.service.querySignal,
    );
    const projectedByKey = new Map(
      projected.map((row) => [
        sessionCatalogRowKey({ ...row, sessionId: row.nativeSessionId }),
        row,
      ]),
    );
    for (let offset = 0; offset < originals.length; offset += 256) {
      this.service.querySignal.throwIfAborted();
      this.sql.db.transaction(() => {
        for (const row of originals.slice(offset, offset + 256)) {
          const key = sessionCatalogRowKey(row);
          const previous = this.sql.source(key);
          const publicRow = projectedByKey.get(key);
          if (previous?.public_id) affected.add(previous.public_id);
          if (previous?.project_id) sourceProjects.add(previous.project_id);
          if (publicRow) {
            affected.add(publicRow.sessionId);
            sourceProjects.add(publicRow.projectId);
          }
          this.sql.putSource({
            key,
            public_id: publicRow?.sessionId ?? null,
            project_id: publicRow?.projectId ?? null,
            project_path: publicRow?.projectPath ?? null,
            ordinal: previous?.ordinal ?? ++this.nextOrdinal,
            unstable: Number(
              Boolean(
                this.deps.sessionMetadataService &&
                  (!row.nativeStorageScope ||
                    !publicRow ||
                    (row.catalogFamily === "opencode" &&
                      row.nativeDirectoryProjectId)),
              ),
            ),
          });
        }
      });
      if (offset + 256 < originals.length)
        await new Promise<void>((resolve) => setImmediate(resolve));
    }
    this.sql.db.transaction(() => {
      for (const id of sourceProjects) this.sql.refreshProject(id);
    });
    const names = new Map(
      this.sql
        .sourceProjects()
        .map((row) => [
          row.project_id,
          (this.deps.projectDisplayName ?? getProjectName)(row.project_path),
        ]),
    );
    for (const id of new Set([...this.names.keys(), ...names.keys()]))
      if (this.names.get(id) !== names.get(id))
        for (const sessionId of this.sql.idsForProject(id))
          affected.add(sessionId);
    this.names = names;
    const updates: Array<{
      item?: GlobalSessionItem;
      id: string;
      key: string | null;
      ordinal: number;
      parent: string | null;
      automatic: boolean;
      live: boolean;
      attention: boolean;
    }> = [];
    const metadata = this.deps.sessionMetadataService;
    const cutoff = this.cutoff();
    const affectedIds = [...affected];
    let metadataBatch: ReadonlyMap<string, SessionMetadata | undefined> =
      new Map();
    for (const [position, id] of affectedIds.entries()) {
      if (position % 256 === 0) {
        await new Promise<void>((resolve) => setImmediate(resolve));
        this.service.querySignal.throwIfAborted();
        metadataBatch =
          metadata?.getMetadataBatch?.(
            affectedIds.slice(position, position + 256),
          ) ?? new Map();
      }
      const stored = metadataBatch.has(id)
        ? metadataBatch.get(id)
        : metadata?.getMetadata(id);
      const source = this.sql
        .sourcesFor(id)
        .sort(
          (a, b) =>
            (this.service.rowOrder(a.key) ?? a.ordinal) -
            (this.service.rowOrder(b.key) ?? b.ordinal),
        )[0];
      const control = metadata?.creations?.projectionForSession(id);
      let item: GlobalSessionItem | undefined,
        parent: NativeSessionRef | undefined;
      if (source) {
        const original =
          native.get(source.key) ?? (await this.service.readRow(source.key));
        if (original) {
          const row =
            projectedByKey.get(source.key) ??
            (
              await projectCatalogIdentities(
                [original],
                metadata,
                this.service.querySignal,
              )
            )[0];
          if (row?.sessionId === id) {
            item = retainedNativeItem(
              row,
              this.deps,
              (projectId, path) =>
                names.get(projectId) ??
                (this.deps.projectDisplayName ?? getProjectName)(path),
              cutoff,
              stored,
            );
            parent = nativeCatalogSessionRef({
              ...row,
              sessionId: row.nativeSessionId,
            });
          }
        }
      }
      if (metadata)
        item = mergeCreationGlobalItems(item ? [item] : [], metadata, {
          ...this.deps,
          controlRows: control ? [control] : [],
          metadataReader: {
            getMetadata: (key) =>
              key === id ? stored : metadata.getMetadata(key),
          },
        })[0];
      if (!source && isYaSessionId(id))
        parent = metadata?.identities.resolveYa(id)?.native ?? undefined;
      const old = this.sql.get(id);
      updates.push({
        id,
        item,
        key: source?.key ?? null,
        ordinal: source?.ordinal ?? old?.ordinal ?? ++this.nextControlOrdinal,
        parent: parent ? JSON.stringify(parent) : null,
        automatic: stored?.isArchived == null,
        attention: Boolean(
          item?.pendingInputType || pendingNonHumanUserTurn(stored),
        ),
        live: Boolean(source && this.deps.supervisor?.getProcessForSession(id)),
      });
    }
    this.service.querySignal.throwIfAborted();
    if (this.disposed) throw new Error("Collection query owner retired");
    // Only this owner reads these TEMP tables. Chunk initial replacement so
    // unrelated API input can run; a failed partial build resets before reuse.
    for (let offset = 0; offset < updates.length; offset += 256) {
      this.service.querySignal.throwIfAborted();
      this.sql.db.transaction(() => {
        for (const update of updates.slice(offset, offset + 256)) {
          if (update.item)
            this.sql.put(
              update.item,
              update.key,
              update.ordinal,
              update.automatic,
              update.live,
              cutoff,
              update.parent,
              update.attention,
            );
          else this.sql.remove(update.id);
        }
      });
      if (offset + 256 < updates.length)
        await new Promise<void>((resolve) => setImmediate(resolve));
    }
    if (full) await this.sql.finishReplacement(this.service.querySignal);
    await this.sql.expire(cutoff, this.service.querySignal);
    this.token = {
      catalogEpoch: changes.catalogEpoch,
      catalogGeneration: changes.catalogGeneration,
    };
  }
  private hydrate(
    row: CollectionStoredRow,
    children: RetainedItemsDeps["providerChildRelationships"],
  ): GlobalSessionItem {
    const item = JSON.parse(row.item) as GlobalSessionItem;
    if (row.automatic) item.isArchived = Boolean(row.archived);
    if (row.native_key)
      item.ownership = sessionOwnershipFromProcess(
        this.deps.supervisor?.getProcessForSession(item.id),
        { isExternal: this.deps.externalTracker?.isExternal(item.id) },
      );
    if (children && row.parent_json) {
      const accepted = children?.accepted(
        JSON.parse(row.parent_json) as NativeSessionRef,
        item.id,
      );
      if (accepted !== undefined) item.providerChildren = accepted;
    }
    return item;
  }
  private catalog() {
    const state = this.service.getState();
    return {
      ...state,
      ...this.token,
      complete: !!this.token && this.token.catalogGeneration > 0,
    };
  }
  private pageResult(
    query: CollectionPageQuery,
    relationships?: RetainedItemsDeps["providerChildRelationships"],
  ) {
    const rows = this.sql.select({ ...query, limit: query.limit + 1 });
    const projects = new Map(this.names);
    for (const row of this.sql.itemProjects()) {
      projects.set(row.project_id, JSON.parse(row.name_json) as string);
    }
    return {
      sessions: rows
        .slice(0, query.limit)
        .map((row) => this.hydrate(row, relationships)),
      hasMore: rows.length > query.limit,
      stats: this.sql.stats(query.accessibleProjectIds),
      projects: [...projects]
        .filter(
          ([id]) =>
            !query.accessibleProjectIds ||
            query.accessibleProjectIds.includes(id),
        )
        .map(([id, name]) => ({ id, name }))
        .sort(compareProjectOptions),
      catalog: this.catalog(),
    };
  }
  page(
    query: CollectionPageQuery,
    relationships?: RetainedItemsDeps["providerChildRelationships"],
  ) {
    return this.run(async () => {
      await this.synchronize();
      return this.pageResult(query, relationships);
    });
  }
  /** Explicit complete read for internal consumers; HTTP pages always pass a limit. */
  all(
    selectParents?: (
      items: readonly GlobalSessionItem[],
    ) => readonly GlobalSessionItem[],
  ) {
    return this.run(async () => {
      await this.synchronize();
      const result = this.pageResult({
        limit: Number.MAX_SAFE_INTEGER - 1,
        includeArchived: true,
      });
      const selected = new Set(
        selectParents?.(result.sessions).map((item) => item.id) ?? [],
      );
      result.sessions = result.sessions.map((item) =>
        selected.has(item.id)
          ? this.hydrate(
              this.sql.get(item.id)!,
              this.deps.providerChildRelationships,
            )
          : item,
      );
      return result;
    });
  }
  inbox(options: {
    projectId?: string;
    accessibleProjectIds?: readonly string[];
    queueIds: readonly string[];
    now: number;
  }) {
    return this.run(async () => {
      await this.synchronize();
      const query = {
        filterProjectId: options.projectId,
        accessibleProjectIds: options.accessibleProjectIds,
        limit: 20,
      };
      const queue = JSON.stringify(options.queueIds);
      const none =
        "attention=0 AND active=0 AND id NOT IN (SELECT value FROM json_each(?))";
      const active = new Map<string, CollectionStoredRow>();
      for (const row of [
        ...this.sql.select(query, "attention=0 AND active=1"),
        ...this.sql.select(
          query,
          "attention=0 AND id IN (SELECT value FROM json_each(?))",
          [queue],
        ),
      ])
        active.set(row.id, row);
      const activeRows = [...active.values()]
        .sort((a, b) => b.updated_ms - a.updated_ms || a.id.localeCompare(b.id))
        .slice(0, 20);
      const rows = [
        ...this.sql.select(query, "attention=1"),
        ...activeRows,
        ...this.sql.select(query, `${none} AND updated_ms>=?`, [
          queue,
          options.now - 30 * 60_000,
        ]),
        ...this.sql.select(
          query,
          `${none} AND unread=1 AND updated_ms<? AND updated_ms>=?`,
          [queue, options.now - 30 * 60_000, options.now - 8 * 60 * 60_000],
        ),
        ...this.sql.select(
          query,
          `${none} AND unread=1 AND updated_ms<? AND updated_ms>=?`,
          [
            queue,
            options.now - 8 * 60 * 60_000,
            options.now - 24 * 60 * 60_000,
          ],
        ),
      ];
      return {
        sessions: rows.map((row) => this.hydrate(row, undefined)),
        catalog: this.catalog(),
      };
    });
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    if (owners.get(this.service)?.index === this) owners.delete(this.service);
    for (const unsubscribe of this.unsubscribers) unsubscribe();
    this.sql.dispose();
  }
}
