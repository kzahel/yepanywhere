import { getCodexRolloutSessionId } from "../utils/codexRolloutFiles.js";
import { realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
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
import { projectRelationshipBatch } from "./session-relationship-query.js";
import {
  SessionRelationshipStore,
  relationshipResourceKey,
  type RelationshipFact,
  type RelationshipResource,
  type RelationshipMetadata,
} from "./SessionRelationshipStore.js";

/** Native addresses are internal. Public projections retain the parent's YA id. */
export interface ObservedProviderChild {
  native: NativeSessionRef;
  /** Immediate native parent, when one acquisition includes descendants. */
  parent?: NativeSessionRef;
  /** Compact structural version; activity alone need not rewrite evidence. */
  version?: string;
  summary: ProviderChildSessionSummary;
  /** Missing/unreadable optional enrichment cannot erase last-known anchors. */
  metadataAvailable?: boolean;
}
export interface ProviderChildObservation {
  version: string;
  state: "partial" | "complete";
  children: readonly ObservedProviderChild[];
  /** A partial locator missed already-read anchors; only a handoff may escalate. */
  needsFullMetadata?: boolean;
}
export interface ProviderChildSource {
  /** Stable reader lifecycle, not a cache of native facts. */
  owner?: object;
  /** Scope ownership only; unavailable content is not an authoritative empty. */
  ownsNativeScope?(): Promise<boolean>;
  /** Must distinguish failure/unavailable from an accepted empty observation. */
  observe(
    signal: AbortSignal,
    previousMetadata?: (
      child: NativeSessionRef,
    ) => Readonly<RelationshipMetadata> | undefined,
  ): Promise<ProviderChildObservation>;
  /** Optional bounded metadata reads; must never enumerate a provider corpus. */
  refreshMetadata?(
    ...args: Parameters<ProviderChildSource["observe"]>
  ): Promise<ProviderChildObservation | undefined>;
  /** Close the native source-version race before publishing profile facts. */
  isCurrent(version: string): Promise<boolean>;
  /** Cheap current activity overlay; never acquires provider storage. */
  overlayActivity?(
    children: ProviderChildSessionSummary[],
  ): ProviderChildSessionSummary[];
  isRetired?(): boolean;
  onRetire?(listener: () => void): () => void;
  /** Already-read native metadata can refine facts without another body read. */
  onMetadataAvailable?(listener: () => void): () => void;
  ownsFileChange?(event: FileChangeEvent): boolean;
  /** Paths such as a database and its WAL may form one logical change stream. */
  fileChangeKey?(event: FileChangeEvent): string;
  /** Existing native events may overlay activity without structural SQL work. */
  handleFileChange?(event: FileChangeEvent): boolean | Promise<boolean>;
  /** Release transient source-version proof after a finite acquisition. */
  releaseObservation?(): void;
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
  mode: AcquisitionMode;
  runningMode?: AcquisitionMode;
  lastAttemptAt: number;
  release?: () => void;
}

type AcquisitionMode = "full" | "metadata" | "metadata-or-full";

const SNAPSHOT_PRODUCER = "provider-child-snapshot-v1";
const MAX_SOURCES = 128;
const MAX_CONCURRENT = 2;
const COMMIT_BATCH = 100;
const REQUEST_REFRESH_MS = 30_000;

/**
 * Profile-owned SQL reads plus finite, coalesced native acquisition. A request
 * never waits for source observation. No per-session timer, recurring scan or
 * request ALS context is retained. The source LRU/queue has at most 128 entries.
 */
export class ProviderChildRelationshipService {
  private store: SessionRelationshipStore | undefined;
  private readonly sources = new Map<string, Work>();
  private readonly inFlight = new Set<Promise<void>>(); // at most MAX_CONCURRENT
  private readonly nativeEvents = new Map<
    string,
    { key: string; source: ProviderChildSource; event: FileChangeEvent }
  >();
  private nativeEventsRunning = 0;
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
    private readonly now: () => number = Date.now,
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
  accepted(native: NativeSessionRef, publicParentId: string) {
    return this.acceptedMany([{ native, sessionId: publicParentId }]).get(
      publicParentId,
    );
  }

  /** One bounded projection of selected parents; no provider I/O or retained row cache. */
  acceptedMany(
    parents: readonly { native: NativeSessionRef; sessionId: string }[],
  ) {
    const result = new Map<string, ProviderChildSessionSummary[] | undefined>();
    if (this.retired || !parents.length) return result;
    const reader = this.index.batch();
    // Raw pages are capped at 64 parents × 32 edges. Evidence is read/released per page.
    for (let offset = 0; offset < parents.length; offset += 64) {
      const selected = parents.slice(offset, offset + 64).map((parent) => ({
        ...parent,
        resource: this.resource(parent.native),
        children: [] as ProviderChildSessionSummary[],
        filtered: false,
        after: undefined as string | undefined,
      }));
      let pending = selected;
      while (pending.length) {
        const outgoing = reader.pages(
          pending,
          "outgoing",
          "provider_child",
          32,
        );
        const targets = new Map<string, RelationshipResource>();
        for (const page of outgoing.values())
          for (const edge of page.edges)
            if (edge.target.kind === "native")
              targets.set(relationshipResourceKey(edge.target), edge.target);
        const incoming = reader.pages(
          [...targets.values()].map((resource) => ({ resource })),
          "incoming",
          "provider_child",
          2,
        );
        const next: typeof pending = [];
        for (const parent of pending) {
          const key = relationshipResourceKey(parent.resource);
          const page = outgoing.get(key)!;
          const evidence = reader.evidence(page.edges.map((edge) => edge.id));
          const projected = projectRelationshipBatch(
            {
              list: (input) =>
                input.direction === "outgoing"
                  ? page
                  : incoming.get(relationshipResourceKey(input.resource))!,
              evidence: (id) => evidence.get(id) ?? [],
            },
            {
              resources: [parent.resource],
              direction: "outgoing",
              type: "provider_child",
              after: parent.after,
              limit: 32,
            },
            {
              anchor: (candidate) => relationshipResourceKey(candidate) === key,
              endpoint: (candidate, _edge, position) => {
                if (candidate.kind !== "native") return undefined;
                if (position === "target") {
                  const parents = incoming.get(
                    relationshipResourceKey(candidate),
                  )!;
                  if (parents.edges.length !== 1 || parents.next)
                    return undefined;
                }
                return candidate.native;
              },
              evidence: (entry) =>
                entry.trust === "provider-observed"
                  ? { metadata: entry.metadata, observedAt: entry.observedAt }
                  : undefined,
            },
          )!;
          parent.filtered ||= projected.withheld;
          for (const edge of projected.relationships) {
            const evidence = edge.evidence.sort((a, b) =>
              b.observedAt.localeCompare(a.observedAt),
            )[0]!;
            const m = evidence.metadata;
            parent.children.push({
              id: edge.target.id,
              parentSessionId: parent.sessionId,
              ...(m.title ? { title: m.title } : {}),
              ...(m.agentType ? { agentType: m.agentType } : {}),
              ...(m.toolUseId ? { toolUseId: m.toolUseId } : {}),
              ...(m.spawnDepth !== undefined
                ? { spawnDepth: m.spawnDepth }
                : {}),
              updatedAt: m.nativeUpdatedAt ?? evidence.observedAt,
            });
          }
          parent.after = projected.scanAfter ?? undefined;
          if (parent.after) next.push(parent);
        }
        pending = next;
      }
      const empty = selected.filter(
        (parent) => !parent.children.length && !parent.filtered,
      );
      const checkpoints = reader.checkpoints(
        SNAPSHOT_PRODUCER,
        empty.map((parent) => parent.resource),
      );
      for (const parent of selected) {
        parent.children.sort(
          (a, b) =>
            b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id),
        );
        const checkpoint = checkpoints.get(
          relationshipResourceKey(parent.resource),
        );
        result.set(
          parent.sessionId,
          parent.children.length
            ? (this.sources
                .get(this.key(parent.native))
                ?.source.overlayActivity?.(parent.children) ?? parent.children)
            : !parent.filtered &&
                checkpoint &&
                (checkpoint.state === "complete" ||
                  hadComplete(checkpoint.cursor))
              ? []
              : undefined,
        );
      }
    }
    return result;
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
    work.generation++;
    this.sources.delete(key);
    for (const [eventKey, pending] of this.nativeEvents)
      if (pending.key === key) this.nativeEvents.delete(eventKey);
  }

  private subscribeSource(
    key: string,
    source: ProviderChildSource,
  ): () => void {
    const retire = source.onRetire?.(() => this.forget(key, source));
    const metadata = source.onMetadataAvailable?.(() => {
      const work = this.sources.get(key);
      if (work?.source === source)
        this.invalidate(work.native, "metadata-or-full");
    });
    return () => {
      retire?.();
      metadata?.();
    };
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
      const replace =
        !source.owner ||
        existing.source.isRetired?.() ||
        existing.source.owner !== source.owner;
      if (replace) {
        existing.release?.();
        existing.source = source;
        existing.release = this.subscribeSource(key, source);
      }
      existing.staleRetries = 0;
      existing.mode = "full";
      if (existing.running) {
        if (replace || existing.runningMode !== "full") existing.dirty = true;
      } else existing.queued = true;
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
        mode: "full",
        lastAttemptAt: -Infinity,
      });
      const work = this.sources.get(key)!;
      work.release = this.subscribeSource(key, source);
    }
    this.schedule();
    return true;
  }

  /** A requested row can revalidate cheap metadata without owning an idle poll. */
  requestMetadataRefresh(
    native: NativeSessionRef,
    owner: ProviderChildOwner,
    source: ProviderChildSource,
  ): boolean {
    if (this.retired || source.isRetired?.()) return false;
    if (!this.hasSource(native))
      return this.demand(native, owner, source, "background");
    const work = this.sources.get(this.key(native))!;
    if (
      !work.source.refreshMetadata ||
      work.running ||
      work.queued ||
      this.now() - work.lastAttemptAt < REQUEST_REFRESH_MS
    )
      return false;
    work.owner = owner;
    work.mode = "metadata";
    work.queued = true;
    this.schedule();
    return true;
  }

  /** Native observations, never the service's own metadata publication. */
  invalidate(native: NativeSessionRef, mode: AcquisitionMode = "full"): void {
    const work = this.sources.get(this.key(native));
    if (!work || this.retired) return;
    work.generation++;
    work.staleRetries = 0;
    if (!work.queued || work.mode !== "full") work.mode = mode;
    if (work.running) work.dirty = true;
    else work.queued = true;
    this.schedule();
  }

  /** One finite handover after a native watcher's initial baseline. */
  observationReady(family: string): void {
    for (const work of this.sources.values())
      if (work.native.family === family) this.invalidate(work.native);
  }

  notifyNativeFileChange(event: FileChangeEvent): void {
    if (this.retired || !this.sources.size) return;
    for (const [key, work] of this.sources) {
      const possibleAliasedParent =
        event.provider === "claude" &&
        !!event.nativeStorageScope &&
        work.native.family === "claude" &&
        ((basename(dirname(event.path)) === "subagents" &&
          basename(dirname(dirname(event.path))) === work.native.id) ||
          basename(event.path) === work.native.id ||
          (basename(event.path) === "subagents" &&
            basename(dirname(event.path)) === work.native.id));
      if (
        !work.source.handleFileChange ||
        (!possibleAliasedParent && !work.source.ownsFileChange?.(event))
      )
        continue;
      const eventKey = JSON.stringify([
        key,
        work.source.fileChangeKey?.(event) ?? event.path,
      ]);
      const previous = this.nativeEvents.get(eventKey);
      if (!previous && this.nativeEvents.size >= MAX_SOURCES) {
        // Lost event detail needs a follow-up read, not cancellation of every
        // running read during sustained pressure. The source revalidates proof.
        work.mode = "full";
        if (work.running) work.dirty = true;
        else work.queued = true;
        this.schedule();
        continue;
      }
      this.nativeEvents.set(eventKey, {
        key,
        source: work.source,
        event: {
          ...event,
          changeType:
            event.changeType === "modify"
              ? (previous?.event.changeType ?? event.changeType)
              : event.changeType,
        },
      });
    }
    if (this.nativeEvents.size) this.schedule();
    if (event.provider !== "codex") return;
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
        const acquisitionWaiting = [...this.sources.values()].some(
          (work) => work.queued && !work.running,
        );
        for (const [eventKey, pending] of this.nativeEvents) {
          if (
            this.inFlight.size >= MAX_CONCURRENT ||
            (acquisitionWaiting && this.nativeEventsRunning >= 1)
          )
            break;
          this.nativeEvents.delete(eventKey);
          const work = this.sources.get(pending.key);
          if (
            !work ||
            work.source !== pending.source ||
            pending.source.isRetired?.()
          )
            continue;
          this.nativeEventsRunning++;
          const promise = Promise.resolve()
            .then(async () => {
              let event = pending.event;
              if (
                ["claude", "grok"].includes(event.provider) &&
                event.nativeStorageScope
              ) {
                const suffix = relative(event.nativeStorageScope, event.path);
                if (
                  suffix === ".." ||
                  suffix.startsWith(`..${sep}`) ||
                  isAbsolute(suffix)
                )
                  return false;
                const root = await realpath(event.nativeStorageScope).catch(
                  () => undefined,
                );
                if (
                  !root ||
                  (event.provider === "grok" &&
                    root !== work.native.storageScope) ||
                  this.retired ||
                  this.sources.get(pending.key)?.source !== pending.source
                )
                  return false;
                event = {
                  ...event,
                  path: join(root, suffix),
                  nativeStorageScope: root,
                };
              }
              if (!pending.source.ownsFileChange?.(event)) return false;
              return pending.source.handleFileChange!(event);
            })
            .then((changed) => {
              if (
                changed &&
                !this.retired &&
                this.sources.get(pending.key)?.source === pending.source
              )
                this.invalidate(work.native);
            })
            .catch((error) => {
              if (!this.retired) {
                this.onError(error);
                if (this.sources.get(pending.key)?.source === pending.source)
                  this.invalidate(work.native);
              }
            })
            .finally(() => {
              this.nativeEventsRunning--;
              this.inFlight.delete(promise);
              this.schedule();
            });
          this.inFlight.add(promise);
        }
        // Serve foreground/native fidelity before request-driven aged work.
        const queued = [...this.sources];
        const ordered = [
          ...queued.filter(([, work]) => work.mode !== "metadata"),
          ...queued.filter(([, work]) => work.mode === "metadata"),
        ];
        for (const [key, work] of ordered) {
          if (this.inFlight.size >= MAX_CONCURRENT) break;
          if (work.source.isRetired?.()) {
            this.forget(key);
            continue;
          }
          if (!work.queued || work.running) continue;
          work.queued = false;
          work.running = true;
          const mode = work.mode;
          work.runningMode = mode;
          work.lastAttemptAt = this.now();
          const promise = this.acquire(key, work, mode)
            .catch((error) => {
              if (!this.retired) this.onError(error);
            })
            .finally(() => {
              work.running = false;
              work.runningMode = undefined;
              if (work.dirty) {
                work.dirty = false;
                work.queued = true;
              }
              this.inFlight.delete(promise);
              if (
                this.changes.size ||
                this.nativeEvents.size ||
                [...this.sources.values()].some((entry) => entry.queued)
              )
                this.schedule();
            });
          this.inFlight.add(promise);
        }
      }),
    );
  }

  private async acquire(
    key: string,
    work: Work,
    mode: AcquisitionMode,
  ): Promise<void> {
    const source = work.source;
    try {
      await this.acquireObservation(key, work, source, mode);
    } finally {
      source.releaseObservation?.();
    }
  }

  private async acquireObservation(
    key: string,
    work: Work,
    source: ProviderChildSource,
    mode: AcquisitionMode,
  ): Promise<void> {
    const generation = work.generation;
    let metadataOnly = mode !== "full";
    let producer = metadataOnly
      ? `${SNAPSHOT_PRODUCER}/metadata-v1`
      : SNAPSHOT_PRODUCER;
    let previous = this.index.checkpoint(producer, key);
    const previousMetadata =
      previous ||
      (metadataOnly && this.index.checkpoint(SNAPSHOT_PRODUCER, key))
        ? (child: NativeSessionRef) => {
            if (this.retired) return;
            // Historical enrichment comes from this exact scoped edge. It cannot
            // supply structural proof or collide through flattened child ids.
            const parents = this.index.list({
              resource: this.resource(child),
              direction: "incoming",
              type: "provider_child",
              limit: 2,
            });
            if (
              parents.edges.length !== 1 ||
              parents.next ||
              relationshipResourceKey(parents.edges[0]!.source) !== key
            )
              return;
            return this.index
              .evidence(parents.edges[0]!.id)
              .find(
                (e) =>
                  e.producer === `provider-child/${child.family}` &&
                  e.sourceKey === this.key(child) &&
                  e.trust === "provider-observed",
              )?.metadata;
          }
        : undefined;
    let observation = metadataOnly
      ? await source.refreshMetadata?.(this.lifetime.signal, previousMetadata)
      : await source.observe(this.lifetime.signal, previousMetadata);
    if (
      (!observation || observation.needsFullMetadata) &&
      mode === "metadata-or-full"
    ) {
      source.releaseObservation?.();
      metadataOnly = false;
      producer = SNAPSHOT_PRODUCER;
      previous = this.index.checkpoint(producer, key);
      observation = await source.observe(
        this.lifetime.signal,
        previousMetadata,
      );
    }
    if (!observation) return;
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
    const through =
      previous?.sourceVersion === observation.version
        ? readThrough(previous.cursor)
        : 0;
    // Each commit is bounded; an interrupted backfill retains prior accepted facts.
    try {
      for (
        let start = through;
        start < Math.max(through + 1, observation.children.length);
        start += COMMIT_BATCH
      ) {
        if (
          this.retired ||
          source.isRetired?.() ||
          generation !== work.generation
        )
          return;
        const batch = observation.children.slice(start, start + COMMIT_BATCH);
        const previousParents: string[] = [];
        const state =
          start + COMMIT_BATCH >= observation.children.length
            ? observation.state
            : "partial";
        const committed = this.database.transaction(() => {
          const accepted = this.index.publishWithinTransaction({
            observation: {
              producer,
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
              ...this.recordChild(
                child.parent ?? work.native,
                child,
                child.version ?? observation.version,
                now,
              ),
            );
          return true;
        });
        if (!committed) return;
        for (const parentKey of previousParents) {
          const owner = this.sources.get(parentKey)?.owner;
          if (owner) owners.set(owner.sessionId, owner);
        }
        changed ||= !metadataOnly || previousParents.length > 0;
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
    const parentEdges = this.index.list({
      resource: this.resource(target),
      direction: "incoming",
      type: "provider_child",
      limit: 2,
    }).edges;
    const previousMetadata =
      child.metadataAvailable === false
        ? parentEdges
            .filter(
              (edge) =>
                relationshipResourceKey(edge.source) === this.key(parent),
            )
            .flatMap((edge) => this.index.evidence(edge.id))
            .find(
              (evidence) =>
                evidence.producer === producer &&
                evidence.sourceKey === sourceKey,
            )?.metadata
        : undefined;
    const previousParents = parentEdges
      .filter(
        (edge) => relationshipResourceKey(edge.source) !== this.key(parent),
      )
      .map((edge) => relationshipResourceKey(edge.source));
    const previous = this.index.checkpoint(producer, sourceKey);
    if (
      previous?.state === "complete" &&
      previous.sourceVersion === version &&
      parentEdges.length === 1 &&
      relationshipResourceKey(parentEdges[0]!.source) === this.key(parent)
    )
      return [];
    const fact: RelationshipFact = {
      type: "provider_child",
      source: this.resource(parent),
      target: this.resource(target),
      recordKey: "native-parent",
      trust: "provider-observed",
      metadata: {
        ...previousMetadata,
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
    return [...previousParents, this.key(parent)];
  }

  async close(): Promise<void> {
    if (this.retired) return;
    this.retired = true;
    this.lifetime.abort();
    if (this.wake) clearImmediate(this.wake);
    this.wake = undefined;
    for (const key of this.sources.keys()) this.forget(key);
    this.changes.clear();
    this.nativeEvents.clear();
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
