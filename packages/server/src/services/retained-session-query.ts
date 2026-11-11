import {
  SIDEBAR_SESSION_FEEDS,
  type SidebarSessionLimits,
  type SidebarSessionSnapshot,
} from "@yep-anywhere/shared/sidebar-snapshot";
import { realpathSync } from "node:fs";
import { SessionMetadataService } from "../metadata/SessionMetadataService.js";
import { NotificationService } from "../notifications/NotificationService.js";
import { SessionQueryCheckpoint } from "./session-query-checkpoint.js";
import type { SessionMetadata } from "../metadata/SessionMetadataService.js";
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
import {
  inboxModelConfig,
  type InboxModelConfig,
} from "../sessions/inbox-model-config.js";
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

/** Private projection data is stripped before ordinary session lists leave. */
type StoredCollectionItem = GlobalSessionItem & {
  inboxModelConfig?: InboxModelConfig;
};

export class RetainedSessionQuery {
  private readonly sql: SessionCollectionSql;
  private checkpoint?: SessionQueryCheckpoint;
  private checkpointSignature = "";
  private needsRestoreIndexes = false;
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
      const metadata = deps.sessionMetadataService,
        seen = deps.notificationService;
      const file = service.queryDatabase.prepare("PRAGMA database_list");
      let databaseFile: string | undefined;
      try {
        databaseFile = file
          .all<{ name: string; file: string }>()
          .find((r) => r.name === "main")?.file;
      } finally {
        file.finalize();
      }
      const sameFile = (path: string) =>
        !!databaseFile && realpathSync(path) === realpathSync(databaseFile);
      if (
        (!metadata ||
          (metadata instanceof SessionMetadataService &&
            sameFile(metadata.getFilePath()))) &&
        (!seen ||
          (seen instanceof NotificationService && sameFile(seen.getFilePath())))
      ) {
        this.checkpointSignature = JSON.stringify([
          Boolean(metadata),
          Boolean(seen),
        ]);
        this.checkpoint = new SessionQueryCheckpoint(
          this.sql.db,
          this.sql.prefix,
        );
        const restored = this.checkpoint.claim(this.checkpointSignature);
        if (restored) {
          this.token = restored.token;
          this.nextOrdinal = restored.nextOrdinal;
          this.nextControlOrdinal = restored.nextControlOrdinal;
          this.names = new Map(restored.names);
          this.needsRestoreIndexes = true;
        }
      }
      const dirty = (id: string) => {
        try {
          this.sql.markDirty(id);
        } catch {
          this.overflow = true;
        }
      };
      const unsubscribeMetadata = deps.sessionMetadataService
        ?.collectionState?.()
        .subscribe(dirty);
      if (unsubscribeMetadata) this.unsubscribers.push(unsubscribeMetadata);
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
  private cutoff(now: number) {
    const value = getActiveSessionIndexOptions(
      this.deps.sessionAutoArchiveDays,
      now,
    )?.activeAfterMs;
    return value !== undefined && Number.isFinite(value) ? value : undefined;
  }
  private async synchronize(now: number) {
    if (this.needsRestoreIndexes) {
      this.needsRestoreIndexes = false;
      await this.sql.finishReplacement(this.service.querySignal);
    }
    const revision = this.checkpoint?.revision();
    const overlayRevision =
      this.deps.sessionMetadataService?.collectionState?.().overlayRevision;
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
      this.checkpoint?.beginReplacement();
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
      item?: StoredCollectionItem;
      id: string;
      key: string | null;
      ordinal: number;
      parent: string | null;
      automatic: boolean;
      live: boolean;
      attention: boolean;
    }> = [];
    const metadata = this.deps.sessionMetadataService;
    const cutoff = this.cutoff(now);
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
        .sort((a, b) => this.service.compareRowOrder(a.key, b.key))[0];
      const control = metadata?.creations?.projectionForSession(id);
      let item: StoredCollectionItem | undefined,
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
      if (item)
        item = {
          ...item,
          inboxModelConfig: inboxModelConfig(
            item.provider,
            this.deps.supervisor?.getProcessForSession(id),
            stored,
          ),
        };
      const old = this.sql.get(id);
      updates.push({
        id,
        item,
        key: source?.key ?? null,
        ordinal: source?.ordinal ?? old?.ordinal ?? ++this.nextControlOrdinal,
        parent: parent ? JSON.stringify(parent) : null,
        automatic: stored?.isArchived == null,
        attention: Boolean(item?.pendingInputType),
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
    if (full) {
      await this.sql.finishReplacement(this.service.querySignal);
      this.checkpoint?.finishReplacement();
    }
    await this.sql.expire(cutoff, this.service.querySignal);
    this.token = {
      catalogEpoch: changes.catalogEpoch,
      catalogGeneration: changes.catalogGeneration,
    };
    if (this.checkpoint && revision !== undefined)
      this.checkpoint.save(
        {
          format: 2,
          signature: this.checkpointSignature,
          revision,
          token: this.token,
          nextOrdinal: this.nextOrdinal,
          nextControlOrdinal: this.nextControlOrdinal,
          names: [...this.names],
        },
        !this.overflow &&
          overlayRevision === metadata?.collectionState?.().overlayRevision &&
          revision === this.checkpoint.revision() &&
          !this.pendingIds.size &&
          !this.sql.hasDirty() &&
          !metadata?.collectionState?.().pending.size,
      );
  }
  private hydrate(
    row: CollectionStoredRow,
    children: RetainedItemsDeps["providerChildRelationships"],
    forInbox = false,
  ): GlobalSessionItem & { modelConfig?: InboxModelConfig } {
    const item = JSON.parse(row.item) as StoredCollectionItem;
    const modelConfig = item.inboxModelConfig;
    delete item.inboxModelConfig;
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
    return forInbox && modelConfig ? { ...item, modelConfig } : item;
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
      nextTransitionAt: this.archiveTransition(query.accessibleProjectIds),
    };
  }
  private deadlineProjects(
    query: Pick<
      CollectionPageQuery,
      "accessibleProjectIds" | "filterProjectId"
    >,
  ) {
    return query.filterProjectId === undefined
      ? query.accessibleProjectIds
      : !query.accessibleProjectIds ||
          query.accessibleProjectIds.includes(query.filterProjectId)
        ? [query.filterProjectId]
        : [];
  }
  private archiveTransition(projects?: readonly string[]) {
    const days = this.deps.sessionAutoArchiveDays;
    if (!days || !Number.isFinite(days) || days <= 0) return undefined;
    const oldest = this.sql.oldestAutomatic(projects);
    // The existing archive cutoff floors (now - days) to UTC midnight and
    // excludes equality. Rolling updatedAt+days would miss that boundary.
    return oldest === undefined
      ? undefined
      : (Math.floor(oldest / 86_400_000) + 1 + days) * 86_400_000;
  }
  page(
    query: CollectionPageQuery,
    relationships?: RetainedItemsDeps["providerChildRelationships"],
  ) {
    return this.run(async () => {
      await this.synchronize(Date.now());
      return this.pageResult(query, relationships);
    });
  }
  /** One fresh SQL read boundary; no per-session membership patches or result cache. */
  sidebar(
    limits: SidebarSessionLimits,
    accessibleProjectIds?: readonly string[],
    relationships?: RetainedItemsDeps["providerChildRelationships"],
  ) {
    return this.run(async () => {
      const start = performance.now();
      await this.synchronize(Date.now());
      const synchronized = performance.now();
      const selected = new Map<string, CollectionStoredRow>();
      const windows =
        {} as SidebarSessionSnapshot<GlobalSessionItem>["windows"];
      for (const feed of SIDEBAR_SESSION_FEEDS) {
        const found = this.sql.select({
          limit: limits[feed] + 1,
          accessibleProjectIds,
          starredOnly: feed === "starred",
          categorizedOnly: feed === "categorized",
        });
        const rows = found.slice(0, limits[feed]);
        windows[feed] = {
          ids: rows.map((row) => row.id),
          hasMore: found.length > limits[feed],
        };
        for (const row of rows) selected.set(row.id, row);
      }
      const selectedAt = performance.now();
      const snapshot: SidebarSessionSnapshot<GlobalSessionItem> = {
        rows: [...selected.values()].map((row) =>
          this.hydrate(row, relationships),
        ),
        windows,
        catalog: this.catalog(),
        nextTransitionAt: this.archiveTransition(accessibleProjectIds),
      };
      return {
        snapshot,
        timings: {
          synchronizeMs: synchronized - start,
          selectMs: selectedAt - synchronized,
          hydrateMs: performance.now() - selectedAt,
        },
      };
    });
  }
  /** Explicit complete read for internal consumers; HTTP pages always pass a limit. */
  all(
    selectParents?: (
      items: readonly GlobalSessionItem[],
    ) => readonly GlobalSessionItem[],
  ) {
    return this.run(async () => {
      await this.synchronize(Date.now());
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
      await this.synchronize(options.now);
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
        sessions: rows.map((row) => this.hydrate(row, undefined, true)),
        catalog: this.catalog(),
        nextTransitionAt: (() => {
          const projects = this.deadlineProjects({
            filterProjectId: options.projectId,
            accessibleProjectIds: options.accessibleProjectIds,
          });
          const tier = this.sql.nextTransition(
            options.now,
            [1_800_000, 28_800_000, 86_400_000],
            projects,
          );
          const archive = this.archiveTransition(projects);
          return tier === undefined
            ? archive
            : archive === undefined
              ? tier
              : Math.min(tier, archive);
        })(),
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
