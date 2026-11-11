/**
 * One revalidation owner per `(sourceKey, queryKey)`.
 *
 * Retaining a query already shares its *result*; it did not share the machinery
 * that decides when to refetch. Every mounted consumer installed its own
 * `activityBus` listeners and its own debounce timer, so an app shell with four
 * hooks behind two query keys ran four listener sets and four timers, and one
 * `reconnect` could cost more than one round trip whenever the first
 * revalidation completed before the second timer fired.
 *
 * This module holds that machinery once per query. Subscribers declare which
 * events they care about and how to run a revalidation; the owner unions the
 * events, keeps a single debounce timer, and performs one revalidation that
 * satisfies every subscriber.
 */
import type { SessionCatalogUpdatedEvent } from "@yep-anywhere/shared";
import { activityBus, type ActivityEventType } from "./activityBus";
import {
  type ClientQueryCoverage,
  type ClientQueryKey,
  coverageSatisfies,
  createClientQueryKey,
  invalidateClientQuery,
} from "./clientQueryController";
import type { ClientSummarySourceKey } from "./clientSummaryStore";

export interface QueryRevalidationEvent {
  eventType: ActivityEventType;
  data: unknown;
}

export interface QueryRevalidationSubscriber {
  /**
   * What this subscriber needs covered. The owner revalidates with the widest
   * coverage among subscribers, so a 50-row consumer is satisfied by the
   * 100-row consumer's refetch rather than issuing its own.
   */
  coverage?: ClientQueryCoverage;
  events: readonly ActivityEventType[];
  shouldRevalidateEvent?: (event: QueryRevalidationEvent) => boolean;
  debounceMs: number;
  /** A run that settles `{ status: "failed" }` or rejects counts as failed. */
  run: () => unknown;
}

export interface QueryRevalidationHandle {
  /** Re-register this subscriber's current closures and coverage. */
  update(subscriber: QueryRevalidationSubscriber): void;
  /** Ask the owner to schedule its single debounced revalidation. */
  schedule(): void;
  release(): void;
}

interface RevalidationOwner {
  ownerKey: string;
  subscribers: Map<number, QueryRevalidationSubscriber>;
  unsubscribeByEvent: Map<ActivityEventType, () => void>;
  sourceKey: ClientSummarySourceKey;
  queryKey: ClientQueryKey;
  timer: ReturnType<typeof setTimeout> | null;
  /** The pending run answers a catalog announcement. */
  catalogRun: boolean;
  /** The `refreshing: true` announcement whose end-of-refresh twin to skip. */
  twin?: { key: string; skipped: boolean };
}

const owners = new Map<string, RevalidationOwner>();
let nextSubscriberId = 1;

function ownerKeyFor(
  sourceKey: ClientSummarySourceKey,
  key: ClientQueryKey,
): string {
  return `${sourceKey}\0${key}`;
}

function clearOwnerTimer(owner: RevalidationOwner): void {
  if (owner.timer) {
    clearTimeout(owner.timer);
    owner.timer = null;
  }
}

/**
 * The subscribers whose coverage nothing else exceeds. Coverage is a partial
 * order, not a total one, so this can legitimately return more than one — two
 * consumers of the same key differing on an unrelated dimension each need their
 * own refetch. It returns one entry in every case YA has today.
 */
function widestSubscribers(
  owner: RevalidationOwner,
): QueryRevalidationSubscriber[] {
  const subscribers = [...owner.subscribers.values()];
  if (subscribers.length <= 1) return subscribers;

  const widest = subscribers.filter((candidate) =>
    subscribers.every((other) =>
      coverageSatisfies(candidate.coverage ?? {}, other.coverage ?? {}),
    ),
  );
  // Nothing dominates: fall back to running each, which is what the
  // per-consumer shape did anyway.
  if (widest.length === 0) return subscribers;
  // Several are mutually satisfying (identical coverage) — one refetch serves.
  return [widest[0] as QueryRevalidationSubscriber];
}

function scheduleOwner(owner: RevalidationOwner): void {
  if (owner.subscribers.size === 0) return;

  // The most eager subscriber sets the cadence, matching the previous shape
  // where whichever hook's timer fired first started the refetch.
  let debounceMs = Number.POSITIVE_INFINITY;
  for (const subscriber of owner.subscribers.values()) {
    debounceMs = Math.min(debounceMs, subscriber.debounceMs);
  }
  if (!Number.isFinite(debounceMs)) return;

  clearOwnerTimer(owner);
  owner.timer = setTimeout(() => {
    owner.timer = null;
    const { twin } = owner;
    // A catalog refetch must not join a request that began before the
    // announcement, since its twin will not come to repair it.
    if (owner.catalogRun)
      invalidateClientQuery(owner.sourceKey, owner.queryKey);
    owner.catalogRun = false;
    const failed = () => {
      if (!twin || owner.twin !== twin) return;
      owner.twin = undefined;
      if (twin.skipped && owners.get(owner.ownerKey) === owner) {
        owner.catalogRun = true;
        scheduleOwner(owner);
      }
    };
    for (const subscriber of widestSubscribers(owner)) {
      const result = subscriber.run();
      if (result instanceof Promise)
        result.then((settled) => {
          if (
            (settled as { status?: unknown } | undefined)?.status === "failed"
          )
            failed();
        }, failed);
    }
  }, debounceMs);
}

/**
 * The server announces one catalog refresh twice: once when its rows are
 * published (`refreshing: true`) and again when the refresh ends. Unless a
 * later pass published another generation, or the refresh failed, the second
 * announcement carries the same rows, so a query that refetched for the first
 * gains nothing from refetching for it. Only that exact twin is skipped, and
 * only when every subscriber wanted the first. A consumer that renders
 * `refreshing` ignores `refreshing: true` (`isCatalogRefreshingEvent`), so its
 * refetch follows the end of the refresh and it never skips one.
 */
function catalogStateKey(data: unknown): string | undefined {
  const catalog = (data as SessionCatalogUpdatedEvent | undefined)?.catalog;
  if (!catalog) return undefined;
  return JSON.stringify([
    catalog.catalogEpoch,
    catalog.catalogGeneration,
    catalog.complete,
    catalog.refreshError ?? null,
  ]);
}

export function isCatalogRefreshingEvent(event: {
  eventType: string;
  data: unknown;
}): boolean {
  return (
    event.eventType === "session-catalog-updated" &&
    (event.data as SessionCatalogUpdatedEvent | undefined)?.catalog
      ?.refreshing === true
  );
}

function handleOwnerEvent(
  owner: RevalidationOwner,
  eventType: ActivityEventType,
  data: unknown,
): void {
  const catalogKey =
    eventType === "session-catalog-updated" ? catalogStateKey(data) : undefined;
  const refreshing = isCatalogRefreshingEvent({ eventType, data });
  if (eventType === "reconnect" || eventType === "refresh")
    owner.twin = undefined;
  if (
    catalogKey !== undefined &&
    !refreshing &&
    owner.twin?.key === catalogKey &&
    !owner.twin.skipped
  ) {
    owner.twin.skipped = true;
    return;
  }
  // Only subscribers that asked for this event get a say, and any one of them
  // wanting a revalidation is enough — the query entry is shared, so a refetch
  // one consumer needs is a refetch they all receive.
  let wanted = false;
  let everyoneWanted = true;
  for (const subscriber of owner.subscribers.values()) {
    if (!subscriber.events.includes(eventType)) continue;
    if (subscriber.shouldRevalidateEvent?.({ eventType, data }) === false) {
      everyoneWanted = false;
      continue;
    }
    wanted = true;
  }
  if (catalogKey !== undefined)
    owner.twin =
      refreshing && wanted && everyoneWanted
        ? { key: catalogKey, skipped: false }
        : undefined;
  if (!wanted) return;
  if (catalogKey !== undefined) owner.catalogRun = true;
  scheduleOwner(owner);
}

/** Subscribe to the union of the subscribers' events, and nothing more. */
function syncOwnerSubscriptions(owner: RevalidationOwner): void {
  const wanted = new Set<ActivityEventType>();
  for (const subscriber of owner.subscribers.values()) {
    for (const eventType of subscriber.events) wanted.add(eventType);
  }

  for (const [eventType, unsubscribe] of owner.unsubscribeByEvent) {
    if (!wanted.has(eventType)) {
      unsubscribe();
      owner.unsubscribeByEvent.delete(eventType);
    }
  }

  for (const eventType of wanted) {
    if (owner.unsubscribeByEvent.has(eventType)) continue;
    owner.unsubscribeByEvent.set(
      eventType,
      activityBus.on(eventType, (data: unknown) => {
        handleOwnerEvent(owner, eventType, data);
      }),
    );
  }
}

export function retainQueryRevalidation(options: {
  sourceKey: ClientSummarySourceKey;
  key: ClientQueryKey | unknown;
  subscriber: QueryRevalidationSubscriber;
}): QueryRevalidationHandle {
  const ownerKey = ownerKeyFor(
    options.sourceKey,
    createClientQueryKey(options.key),
  );
  let owner = owners.get(ownerKey);
  if (!owner) {
    owner = {
      ownerKey,
      sourceKey: options.sourceKey,
      queryKey: createClientQueryKey(options.key),
      subscribers: new Map(),
      unsubscribeByEvent: new Map(),
      timer: null,
      catalogRun: false,
    };
    owners.set(ownerKey, owner);
  }
  const boundOwner = owner;

  const subscriberId = nextSubscriberId++;
  boundOwner.subscribers.set(subscriberId, options.subscriber);
  syncOwnerSubscriptions(boundOwner);

  let released = false;
  return {
    update(subscriber: QueryRevalidationSubscriber) {
      if (released) return;
      boundOwner.subscribers.set(subscriberId, subscriber);
      syncOwnerSubscriptions(boundOwner);
    },
    schedule() {
      if (released) return;
      scheduleOwner(boundOwner);
    },
    release() {
      if (released) return;
      released = true;
      boundOwner.subscribers.delete(subscriberId);
      if (boundOwner.subscribers.size === 0) {
        clearOwnerTimer(boundOwner);
        for (const unsubscribe of boundOwner.unsubscribeByEvent.values()) {
          unsubscribe();
        }
        boundOwner.unsubscribeByEvent.clear();
        owners.delete(boundOwner.ownerKey);
        return;
      }
      // Others remain: drop only the events nobody asks for now.
      syncOwnerSubscriptions(boundOwner);
    },
  };
}

export interface QueryRevalidationMetrics {
  owners: number;
  subscribers: number;
  eventSubscriptions: number;
  armedTimers: number;
}

export function getQueryRevalidationMetrics(): QueryRevalidationMetrics {
  let subscribers = 0;
  let eventSubscriptions = 0;
  let armedTimers = 0;
  for (const owner of owners.values()) {
    subscribers += owner.subscribers.size;
    eventSubscriptions += owner.unsubscribeByEvent.size;
    if (owner.timer) armedTimers += 1;
  }
  return {
    owners: owners.size,
    subscribers,
    eventSubscriptions,
    armedTimers,
  };
}

export function resetQueryRevalidationForTests(): void {
  for (const owner of owners.values()) {
    clearOwnerTimer(owner);
    for (const unsubscribe of owner.unsubscribeByEvent.values()) {
      unsubscribe();
    }
  }
  owners.clear();
}

/** An authoritative stream frame supersedes a queued whole-query revalidation. */
export function cancelPendingQueryRevalidation(
  sourceKey: ClientSummarySourceKey,
  key: ClientQueryKey,
) {
  const owner = owners.get(ownerKeyFor(sourceKey, key));
  if (!owner) return;
  clearOwnerTimer(owner);
  owner.catalogRun = false;
  owner.twin = undefined;
}
