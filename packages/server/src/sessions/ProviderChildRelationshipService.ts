import { getCodexRolloutSessionId } from "../utils/codexRolloutFiles.js";
import { canonicalCodexChange } from "./codex-rollout-tree-observation.js";
import type { FileChangeEvent } from "../watcher/EventBus.js";
import {
  nativeSessionRef,
  parseNativeSessionId,
  truncateSessionTitle,
  type NativeSessionRef,
  type ProviderChildSessionSummary,
} from "@yep-anywhere/shared";
import { runOutsideRequestContext } from "../lib/outsideRequestContext.js";
import type { SqliteDatabase } from "../storage/sqlite.js";
import {
  SessionRelationshipStore,
  relationshipResourceKey,
  type RelationshipFact,
  type RelationshipResource,
} from "./SessionRelationshipStore.js";

/** Native addresses are internal. Public projections retain the parent's YA id. */
export interface ObservedProviderChild {
  native: NativeSessionRef;
  summary: ProviderChildSessionSummary;
}
export interface ProviderChildObservation {
  version: string;
  state: "partial" | "complete";
  children: readonly ObservedProviderChild[];
}
export interface ProviderChildSource {
  /** Must distinguish failure/unavailable from an accepted empty observation. */
  observe(signal: AbortSignal): Promise<ProviderChildObservation>;
  /** Close the native source-version race before publishing profile facts. */
  isCurrent(version: string): Promise<boolean>;
  /** Cheap current activity overlay; never acquires provider storage. */
  overlayActivity?(
    children: ProviderChildSessionSummary[],
  ): ProviderChildSessionSummary[];
  isRetired?(): boolean;
  onRetire?(listener: () => void): () => void;
  ownsFileChange?(event: FileChangeEvent): boolean;
  /** One shared catalog refresh per scope/change batch, not per viewed parent. */
  parentsForChanges?(
    ids: readonly string[],
    signal: AbortSignal,
  ): Promise<readonly string[]>;
}
export interface ProviderChildOwner {
  sessionId: string;
}
interface Work {
  native: NativeSessionRef;
  owner: ProviderChildOwner;
  source: ProviderChildSource;
  generation: number;
  queued: boolean;
  running: boolean;
  dirty: boolean;
  staleRetries: number;
  release?: () => void;
}

const SNAPSHOT_PRODUCER = "provider-child-snapshot-v1";
const MAX_SOURCES = 128;
const MAX_CONCURRENT = 2;
const COMMIT_BATCH = 100;

/**
 * Profile-owned SQL reads plus finite, coalesced native acquisition. A request
 * never waits for source observation. No per-session timer, recurring scan or
 * request ALS context is retained. The source LRU/queue has at most 128 entries.
 */
export class ProviderChildRelationshipService {
  private store: SessionRelationshipStore | undefined;
  private readonly sources = new Map<string, Work>();
  private readonly inFlight = new Set<Promise<void>>(); // at most MAX_CONCURRENT
  private readonly changes = new Map<
    string,
    { source: ProviderChildSource; ids: Set<string>; overflow: boolean }
  >();
  private wake: NodeJS.Immediate | undefined;
  private retired = false;
  private readonly lifetime = new AbortController();

  constructor(
    private readonly database: SqliteDatabase,
    private readonly serverId: string,
    private readonly onCommitted: (owner: ProviderChildOwner) => void,
    private readonly onError: (error: unknown) => void = () => {},
    private readonly sharedIndex?: () => SessionRelationshipStore,
  ) {}

  private get index(): SessionRelationshipStore {
    this.store ??=
      this.sharedIndex?.() ?? new SessionRelationshipStore(this.database);
    return this.store;
  }
  private resource(native: NativeSessionRef): RelationshipResource {
    return { kind: "native", serverId: this.serverId, native };
  }
  private key(native: NativeSessionRef): string {
    return relationshipResourceKey(this.resource(native));
  }

  /** SQL only. Undefined is unpublished/partial-empty; [] is accepted empty. */
  accepted(
    native: NativeSessionRef,
    publicParentId: string,
  ): ProviderChildSessionSummary[] | undefined {
    if (this.retired) return undefined;
    const resource = this.resource(native);
    const children: ProviderChildSessionSummary[] = [];
    let filtered = false;
    let after: string | undefined;
    do {
      const page = this.index.list({
        resource,
        direction: "outgoing",
        type: "provider_child",
        after,
        limit: 200,
      });
      for (const edge of page.edges) {
        if (edge.target.kind !== "native") {
          filtered = true;
          continue;
        }
        // Conflicting structural observations do not silently acquire parenting.
        const parents = this.index.list({
          resource: edge.target,
          direction: "incoming",
          type: "provider_child",
          limit: 2,
        });
        if (parents.edges.length !== 1 || parents.next) {
          filtered = true;
          continue;
        }
        const evidence = this.index
          .evidence(edge.id, { limit: 20 })
          .filter((e) => e.trust === "provider-observed")
          .sort((a, b) => b.observedAt.localeCompare(a.observedAt))[0];
        if (!evidence) {
          filtered = true;
          continue;
        }
        const m = evidence.metadata;
        children.push({
          id: edge.target.native.id,
          parentSessionId: publicParentId,
          ...(m.title ? { title: m.title } : {}),
          ...(m.agentType ? { agentType: m.agentType } : {}),
          ...(m.toolUseId ? { toolUseId: m.toolUseId } : {}),
          ...(m.spawnDepth !== undefined ? { spawnDepth: m.spawnDepth } : {}),
          updatedAt: m.nativeUpdatedAt ?? evidence.observedAt,
        });
      }
      after = page.next ?? undefined;
    } while (after);
    children.sort(
      (a, b) =>
        b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id),
    );
    if (children.length) return children;
    if (filtered) return undefined;
    const checkpoint = this.index.checkpoint(
      SNAPSHOT_PRODUCER,
      this.key(native),
    );
    return checkpoint &&
      (checkpoint.state === "complete" || hadComplete(checkpoint.cursor))
      ? []
      : undefined;
  }

  /** A retained source can receive native events without another list read. */
  hasSource(native: NativeSessionRef): boolean {
    const work = this.sources.get(this.key(native));
    return !this.retired && !!work && !work.source.isRetired?.();
  }

  private forget(key: string, source?: ProviderChildSource): void {
    const work = this.sources.get(key);
    if (!work || (source && work.source !== source)) return;
    work.release?.();
    this.sources.delete(key);
  }

  /** Register explicit demand; native acquisition begins outside the request. */
  demand(
    native: NativeSessionRef,
    owner: ProviderChildOwner,
    source: ProviderChildSource,
    priority: "foreground" | "background" = "foreground",
  ): boolean {
    if (this.retired || source.isRetired?.()) return false;
    const key = this.key(native);
    const existing = this.sources.get(key);
    if (existing) {
      existing.owner = owner;
      existing.release?.();
      existing.source = source;
      existing.release = source.onRetire?.(() => this.forget(key, source));
      existing.staleRetries = 0;
      if (existing.running) existing.dirty = true;
      else existing.queued = true;
      this.sources.delete(key);
      this.sources.set(key, existing);
    } else {
      if (this.sources.size >= MAX_SOURCES) {
        // Broad lists must converge and cannot evict a viewed parent's live
        // registration just because more published rows do not fit in RAM.
        if (priority === "background") return false;
        const evict = [...this.sources].find(
          ([, work]) => !work.running && !work.queued,
        )?.[0];
        if (!evict) return false;
        this.forget(evict);
      }
      this.sources.set(key, {
        native,
        owner,
        source,
        generation: 0,
        queued: true,
        running: false,
        dirty: false,
        staleRetries: 0,
      });
      const work = this.sources.get(key)!;
      work.release = source.onRetire?.(() => this.forget(key, source));
    }
    this.schedule();
    return true;
  }

  /** Native observations, never the service's own metadata publication. */
  invalidate(native: NativeSessionRef): void {
    const work = this.sources.get(this.key(native));
    if (!work || this.retired) return;
    work.generation++;
    work.staleRetries = 0;
    if (work.running) work.dirty = true;
    else work.queued = true;
    this.schedule();
  }

  notifyNativeFileChange(event: FileChangeEvent): void {
    if (this.retired || event.provider !== "codex" || !this.sources.size)
      return;
    if (event.nativeStorageScope) {
      runOutsideRequestContext(() => {
        void canonicalCodexChange(event)
          .then((change) => {
            if (change && !this.retired)
              this.enqueueNativeChange({
                ...event,
                path: change.path,
                nativeStorageScope: change.scope,
              });
          })
          .catch((error) => {
            if (!this.retired) this.onError(error);
          });
      });
      return;
    }
    this.enqueueNativeChange(event);
  }

  private enqueueNativeChange(event: FileChangeEvent): void {
    const id = getCodexRolloutSessionId(event.path);
    if (!id) return;
    const scopes = new Set<string>();
    for (const work of this.sources.values()) {
      if (work.native.family !== "codex") continue;
      const scope = work.native.storageScope;
      if (
        scopes.has(scope) ||
        work.source.isRetired?.() ||
        !work.source.parentsForChanges ||
        !work.source.ownsFileChange?.(event)
      )
        continue;
      scopes.add(scope);
      let change = this.changes.get(scope);
      if (!change) {
        change = { source: work.source, ids: new Set(), overflow: false };
        this.changes.set(scope, change);
      }
      if (change.ids.size < MAX_SOURCES) change.ids.add(id);
      else change.overflow = true;
    }
    this.schedule();
  }

  private async applyChanges(
    scope: string,
    change: {
      source: ProviderChildSource;
      ids: Set<string>;
      overflow: boolean;
    },
  ): Promise<void> {
    const ids = [...change.ids];
    const parents = new Set(
      await change.source.parentsForChanges!(ids, this.lifetime.signal),
    );
    if (this.retired) return;
    // One indexed lookup per changed child/scope, independent of source count.
    // Previous parents also need a refresh when native proof explicitly moves.
    for (const id of ids) {
      const target = this.resource(
        nativeSessionRef("codex", scope, parseNativeSessionId(id)),
      );
      for (const edge of this.index.list({
        resource: target,
        direction: "incoming",
        type: "provider_child",
        limit: 2,
      }).edges) {
        if (edge.source.kind === "native") parents.add(edge.source.native.id);
      }
    }
    for (const work of this.sources.values()) {
      if (
        work.native.family === "codex" &&
        work.native.storageScope === scope &&
        (change.overflow || parents.has(work.native.id))
      )
        this.invalidate(work.native);
    }
  }

  private schedule(): void {
    if (this.retired || this.wake || this.inFlight.size >= MAX_CONCURRENT)
      return;
    this.wake = runOutsideRequestContext(() =>
      setImmediate(() => {
        this.wake = undefined;
        for (const [scope, change] of this.changes) {
          if (this.inFlight.size >= MAX_CONCURRENT) break;
          this.changes.delete(scope);
          const promise = this.applyChanges(scope, change)
            .catch((error) => {
              if (!this.retired) {
                this.onError(error);
                // A retired source or transient scan error must not consume
                // the sole native notification. Each live owner retries once
                // through its own source; the scope is bounded at 128.
                for (const work of this.sources.values())
                  if (work.native.storageScope === scope)
                    this.invalidate(work.native);
              }
            })
            .finally(() => {
              this.inFlight.delete(promise);
              this.schedule();
            });
          this.inFlight.add(promise);
        }
        for (const [key, work] of this.sources) {
          if (this.inFlight.size >= MAX_CONCURRENT) break;
          if (work.source.isRetired?.()) {
            this.forget(key);
            continue;
          }
          if (!work.queued || work.running) continue;
          work.queued = false;
          work.running = true;
          const promise = this.acquire(key, work)
            .catch((error) => {
              if (!this.retired) this.onError(error);
            })
            .finally(() => {
              work.running = false;
              if (work.dirty) {
                work.dirty = false;
                work.queued = true;
              }
              this.inFlight.delete(promise);
              if (
                this.changes.size ||
                [...this.sources.values()].some((entry) => entry.queued)
              )
                this.schedule();
            });
          this.inFlight.add(promise);
        }
      }),
    );
  }

  private async acquire(key: string, work: Work): Promise<void> {
    const generation = work.generation;
    const source = work.source;
    const previous = this.index.checkpoint(SNAPSHOT_PRODUCER, key);
    const observation = await source.observe(this.lifetime.signal);
    if (this.retired || generation !== work.generation) return;
    if (!(await source.isCurrent(observation.version))) {
      // A different reader may have consumed the catalog's pending invalidation.
      // One finite retry catches up without turning a broken source into a loop.
      if (!this.retired && work.staleRetries++ === 0) work.dirty = true;
      return;
    }
    if (
      previous?.sourceVersion === observation.version &&
      previous.state === observation.state &&
      readThrough(previous.cursor) >= observation.children.length
    )
      return;
    let changed = false;
    const owners = new Map([[work.owner.sessionId, work.owner]]);
    let expectedRevision = previous?.revision ?? null;
    const now = new Date().toISOString();
    // Each commit is bounded; an interrupted backfill retains prior accepted facts.
    try {
      for (
        let start =
          previous?.sourceVersion === observation.version &&
          previous.state === observation.state
            ? readThrough(previous.cursor)
            : 0;
        start < Math.max(1, observation.children.length);
        start += COMMIT_BATCH
      ) {
        if (this.retired || generation !== work.generation) return;
        const batch = observation.children.slice(start, start + COMMIT_BATCH);
        const previousParents: string[] = [];
        const state =
          start + COMMIT_BATCH >= observation.children.length
            ? observation.state
            : "partial";
        const committed = this.database.transaction(() => {
          const accepted = this.index.publishWithinTransaction({
            observation: {
              producer: SNAPSHOT_PRODUCER,
              sourceKey: key,
              sourceVersion: observation.version,
              extractorVersion: 1,
              observedAt: now,
            },
            expectedRevision,
            facts: [],
            progress: {
              state,
              cursor: JSON.stringify({
                through: start + batch.length,
                hasComplete:
                  previous?.state === "complete" ||
                  hadComplete(previous?.cursor) ||
                  state === "complete",
              }),
            },
          });
          if (!accepted) return false;
          for (const child of batch)
            previousParents.push(
              ...this.recordChild(work.native, child, observation.version, now),
            );
          return true;
        });
        if (!committed) return;
        for (const parentKey of previousParents) {
          const owner = this.sources.get(parentKey)?.owner;
          if (owner) owners.set(owner.sessionId, owner);
        }
        changed = true;
        expectedRevision = (expectedRevision ?? 0) + 1;
        if (start + COMMIT_BATCH < observation.children.length)
          await runOutsideRequestContext(
            () => new Promise<void>((resolve) => setImmediate(resolve)),
          );
      }
    } finally {
      if (changed && !this.retired)
        for (const owner of owners.values()) this.onCommitted(owner);
    }
  }

  private recordChild(
    parent: NativeSessionRef,
    child: ObservedProviderChild,
    version: string,
    now: string,
  ): string[] {
    const s = child.summary;
    if (
      s.parentSessionId !== parent.id ||
      s.id !== child.native.id ||
      child.native.family !== parent.family ||
      !Number.isFinite(Date.parse(s.updatedAt))
    )
      throw new Error("Invalid provider-child observation");
    const target = nativeSessionRef(
      child.native.family,
      child.native.storageScope,
      parseNativeSessionId(child.native.id),
    );
    const producer = `provider-child/${parent.family}`;
    const sourceKey = this.key(target);
    const previousParents = this.index
      .list({
        resource: this.resource(target),
        direction: "incoming",
        type: "provider_child",
        limit: 2,
      })
      .edges.filter(
        (edge) => relationshipResourceKey(edge.source) !== this.key(parent),
      )
      .map((edge) => relationshipResourceKey(edge.source));
    const previous = this.index.checkpoint(producer, sourceKey);
    const fact: RelationshipFact = {
      type: "provider_child",
      source: this.resource(parent),
      target: this.resource(target),
      recordKey: "native-parent",
      trust: "provider-observed",
      metadata: {
        ...(s.title ? { title: truncateSessionTitle(s.title) } : {}),
        ...(s.agentType ? { agentType: s.agentType.slice(0, 256) } : {}),
        ...(s.toolUseId ? { toolUseId: s.toolUseId } : {}),
        ...(s.spawnDepth !== undefined ? { spawnDepth: s.spawnDepth } : {}),
        nativeUpdatedAt: s.updatedAt,
      },
    };
    this.index.publishWithinTransaction({
      observation: {
        producer,
        sourceKey,
        sourceVersion: version,
        extractorVersion: 1,
        observedAt: now,
      },
      expectedRevision: previous?.revision ?? null,
      facts: [fact],
      progress: { state: "complete", cursor: "{}" },
      replaceSource: true,
    });
    return previousParents;
  }

  async close(): Promise<void> {
    if (this.retired) return;
    this.retired = true;
    this.lifetime.abort();
    if (this.wake) clearImmediate(this.wake);
    this.wake = undefined;
    for (const key of this.sources.keys()) this.forget(key);
    this.changes.clear();
    // Every continuation checks retirement before touching SQL. Do not make
    // shutdown wait for a filesystem operation that cannot honor cancellation.
    if (!this.sharedIndex) this.store?.dispose();
  }
}

function hadComplete(cursor: string | undefined): boolean {
  if (!cursor) return false;
  try {
    return (
      (JSON.parse(cursor) as { hasComplete?: boolean }).hasComplete === true
    );
  } catch {
    return false;
  }
}

function readThrough(cursor: string): number {
  try {
    const value = (JSON.parse(cursor) as { through?: number }).through;
    return typeof value === "number" &&
      Number.isSafeInteger(value) &&
      value >= 0
      ? value
      : 0;
  } catch {
    return 0;
  }
}
