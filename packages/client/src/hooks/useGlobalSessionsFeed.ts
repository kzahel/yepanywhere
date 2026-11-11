import { sidebarSessionCursor } from "@yep-anywhere/shared/sidebar-snapshot";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  PROGRESSIVE_SESSION_CATALOG_CAPABILITY,
  SERVER_CAPABILITIES,
  serverHasCapability,
} from "@yep-anywhere/shared";
import {
  api,
  isUnchangedGlobalSessionsResponse,
  type GlobalSessionItem,
  type GlobalSessionsRequest,
  type GlobalSessionsResponse,
  type GlobalSessionsUnchangedResponse,
  type GlobalSessionStats,
  type ProjectOption,
} from "../api/client";
import { useOptionalRemoteConnection } from "../contexts/RemoteConnectionContext";
import { useCurrentSourceRuntime } from "../contexts/SourceRuntimeContext";
import { isRemoteClient } from "../lib/connection";
import { acquireClientQueryBootstrapSlot } from "../lib/clientQueryBootstrap";
import {
  createClientQueryKey,
  ensureClientQuery,
  getClientQueryState,
  invalidateClientQuery,
  retainClientQuery,
} from "../lib/clientQueryController";
import {
  type QueryRevalidationHandle,
  retainQueryRevalidation,
} from "../lib/clientQueryRevalidation";
import {
  type ClientSummarySourceKey,
  useSessionCollectionQueryRecords,
  useSessionCollectionQueryState,
} from "../lib/clientSummaryStore";
import {
  catalogLoadState,
  type SessionCollectionQueryDescriptor,
} from "../lib/clientSummaryCollections";
import { resolveCollectionRequestMode } from "../lib/collectionRequestMode";
import { createGlobalSessionsCollectionQueryDescriptor } from "../lib/clientSummaryQueries";
import {
  type ProcessStateEvent,
  type SessionCreatedEvent,
  type SessionMetadataChangedEvent,
  useFileActivity,
} from "./useFileActivity";
import { useRetainedVersionInfo } from "./useVersion";
import { useCollectionUpdates } from "./useCollectionUpdates";
import {
  collectionQueryIsLive,
  collectionQueryCoverage,
  expandCollectionUpdates,
  pauseCollectionUpdates,
} from "../lib/collectionUpdates";
import { selectSessionCollectionQueryState } from "../lib/clientSummaryQueries";

const REFETCH_DEBOUNCE_MS = 500;
/**
 * Reconnect and visibility restoration can both follow a window in which this
 * client missed session events. The rest arrive through `useFileActivity`
 * because this feed patches its collection from the event before deciding
 * whether a refetch is even needed, and that patch is per-query bookkeeping
 * rather than a revalidation. Adding, removing, or renaming a project changes
 * rows' project names and the project filter without touching any session.
 */
const GLOBAL_SESSIONS_REVALIDATE_EVENTS = [
  "reconnect",
  "refresh",
  "session-catalog-updated",
  "projects-changed",
] as const;
const GLOBAL_SESSIONS_DEFAULT_LIMIT = 100;
const GLOBAL_SESSIONS_STALE_TIME_MS = 30_000;
const GLOBAL_SESSION_STATS_STALE_TIME_MS = 30_000;
const GLOBAL_SESSION_STATS_QUERY_KEY = createClientQueryKey({
  endpoint: "global-session-stats",
});

export interface UseGlobalSessionsOptions {
  enabled?: boolean;
  projectId?: string | null;
  searchQuery?: string;
  limit?: number;
  includeArchived?: boolean;
  starred?: boolean;
  /** Only sessions filed under a sidebar category. */
  categorized?: boolean;
  includeStats?: boolean;
}

export interface UseGlobalSessionsFeedResult {
  query: SessionCollectionQueryDescriptor;
  ready: boolean;
  loading: boolean;
  error: Error | null;
  hasMore: boolean;
  loadMore: () => Promise<void>;
  refetch: () => Promise<void>;
  stats: GlobalSessionStats;
  projects: ProjectOption[];
}

/** Default stats when no data loaded */
export const DEFAULT_GLOBAL_SESSION_STATS: GlobalSessionStats = {
  totalCount: 0,
  unreadCount: 0,
  starredCount: 0,
  archivedCount: 0,
  providerCounts: {},
  executorCounts: {},
};

interface GlobalSessionsAuxiliaryState {
  stats: GlobalSessionStats;
  projects: ProjectOption[];
}

const DEFAULT_GLOBAL_SESSIONS_AUXILIARY: GlobalSessionsAuxiliaryState = {
  stats: DEFAULT_GLOBAL_SESSION_STATS,
  projects: [],
};

const globalSessionsAuxiliaryBySource = new Map<
  ClientSummarySourceKey,
  GlobalSessionsAuxiliaryState
>();
const globalSessionsAuxiliaryListeners = new Set<() => void>();

function subscribeGlobalSessionsAuxiliary(listener: () => void): () => void {
  globalSessionsAuxiliaryListeners.add(listener);
  return () => {
    globalSessionsAuxiliaryListeners.delete(listener);
  };
}

function getGlobalSessionsAuxiliary(
  sourceKey: ClientSummarySourceKey,
): GlobalSessionsAuxiliaryState {
  return (
    globalSessionsAuxiliaryBySource.get(sourceKey) ??
    DEFAULT_GLOBAL_SESSIONS_AUXILIARY
  );
}

function updateGlobalSessionsAuxiliary(
  sourceKey: ClientSummarySourceKey,
  update: Partial<GlobalSessionsAuxiliaryState>,
): void {
  const current = getGlobalSessionsAuxiliary(sourceKey);
  const next = {
    stats: update.stats ?? current.stats,
    projects: update.projects ?? current.projects,
  };
  if (next.stats === current.stats && next.projects === current.projects) {
    return;
  }

  globalSessionsAuxiliaryBySource.set(sourceKey, next);
  for (const listener of Array.from(globalSessionsAuxiliaryListeners)) {
    listener();
  }
}

function useGlobalSessionsAuxiliary(
  sourceKey: ClientSummarySourceKey,
): GlobalSessionsAuxiliaryState {
  return useSyncExternalStore(
    subscribeGlobalSessionsAuxiliary,
    () => getGlobalSessionsAuxiliary(sourceKey),
    () => DEFAULT_GLOBAL_SESSIONS_AUXILIARY,
  );
}

/**
 * The newest collection generation this client accepted rows for, per
 * `(source, query)`.
 *
 * Module level, not a ref, for the same reason the auxiliary state above is:
 * `applySnapshot` runs in whichever consumer owns the request, and every
 * consumer of a query must end up holding the same accepted generation as the
 * rows they share.
 *
 * Replaying the token claims "I still hold the rows of that generation", so it
 * is only ever sent together with a check that the retained collection still
 * covers the request — see `knownGenerationForRequest`. What makes local event
 * patching safe alongside it is that every event this feed patches from also
 * advances the server's generation, so a patched client is told `changed` on
 * its next conditional read and re-reads the rows it guessed at.
 */
const acceptedGenerations = new Map<string, number>();

function acceptedGenerationKey(
  sourceKey: ClientSummarySourceKey,
  queryKey: string,
): string {
  return `${sourceKey}\0${queryKey}`;
}

export interface ConditionalReadInputs {
  /** Whether the connected server advertises `progressive-session-catalog`. */
  supported: boolean;
  /** The generation this client last accepted rows for on this query. */
  accepted?: number;
  /** False when no retained collection state exists for the query at all. */
  retained: boolean;
  /** Rows currently retained for the query. */
  retainedRows: number;
  /** Rows this consumer is asking for. */
  requestedRows: number;
  /** Whether the collection is known to continue past the retained rows. */
  hasMore: boolean;
}

/**
 * The generation to offer with a read, or `undefined` to ask for rows.
 *
 * Three things must hold, and the middle one is the easy one to forget: an
 * `unchanged` answer says the collection did not change, not that this client
 * holds as much of it as it is now asking for. A consumer that widened its
 * window past the retained rows needs those rows, and the server cannot tell
 * that from the token.
 */
export function knownGenerationToSend(
  inputs: ConditionalReadInputs,
): number | undefined {
  if (!inputs.supported || inputs.accepted === undefined || !inputs.retained) {
    return undefined;
  }
  if (inputs.retainedRows < inputs.requestedRows && inputs.hasMore) {
    return undefined;
  }
  return inputs.accepted;
}

function createGlobalSessionsControllerQueryKey(
  descriptor: SessionCollectionQueryDescriptor,
): string {
  return createClientQueryKey({
    endpoint: "global-sessions",
    projectId: descriptor.projectId ?? null,
    searchQuery: descriptor.searchQuery?.trim() || null,
    includeArchived: descriptor.includeArchived === true,
    starred: descriptor.starred === true,
    ...(descriptor.categorized ? { categorized: true } : {}),
  });
}

export function resetGlobalSessionsFeedForTests(): void {
  globalSessionsAuxiliaryBySource.clear();
  globalSessionsAuxiliaryListeners.clear();
  acceptedGenerations.clear();
}

function shouldRefetchGlobalSessionsAfterProcessState(
  event: ProcessStateEvent,
  matched: boolean,
): boolean {
  return !matched || event.activity !== "in-turn";
}

function sessionCreatedEventToGlobalSessionItem(
  event: SessionCreatedEvent,
  projects: readonly ProjectOption[],
): GlobalSessionItem {
  const project = projects.find((p) => p.id === event.session.projectId);
  const projectName = event.session.projectName ?? project?.name ?? "";

  return {
    id: event.session.id,
    title: event.session.title,
    fullTitle: event.session.fullTitle,
    createdAt: event.session.createdAt,
    updatedAt: event.session.updatedAt,
    messageCount: event.session.messageCount,
    provider: event.session.provider,
    model: event.session.model,
    projectId: event.session.projectId,
    projectName,
    ownership: event.session.ownership,
    pendingInputType: event.session.pendingInputType,
    activity: event.session.activity,
    hasUnread: event.session.hasUnread,
    customTitle: event.session.customTitle,
    isArchived: event.session.isArchived,
    isStarred: event.session.isStarred,
    parentSessionId: event.session.parentSessionId,
    parentSessionKind: event.session.parentSessionKind,
    forkedFromSessionId: event.session.forkedFromSessionId,
    initialPrompt: event.session.initialPrompt,
    executor: event.session.executor,
    lastAgentText: event.session.lastAgentText,
    lastHumanTurnAt: event.session.lastHumanTurnAt,
    providerChildren: event.session.providerChildren,
  };
}

export function useGlobalSessionsFeed(
  options: UseGlobalSessionsOptions = {},
): UseGlobalSessionsFeedResult {
  const {
    enabled = true,
    projectId,
    searchQuery,
    limit,
    includeArchived,
    starred,
    categorized,
    includeStats = false,
  } = options;
  const remoteConnection = useOptionalRemoteConnection();
  const ready =
    enabled &&
    (!isRemoteClient() ||
      (remoteConnection !== null && remoteConnection.connection !== null));
  const query = useMemo(
    () =>
      createGlobalSessionsCollectionQueryDescriptor({
        projectId,
        searchQuery,
        includeArchived,
        starred,
        categorized,
      }),
    [projectId, searchQuery, includeArchived, starred, categorized],
  );
  const queryKey = useMemo(
    () => createGlobalSessionsControllerQueryKey(query),
    [query],
  );
  const requestedRows = limit ?? GLOBAL_SESSIONS_DEFAULT_LIMIT;
  const runtime = useCurrentSourceRuntime();
  const sourceKey = runtime.sourceKey;
  const sourceSummary = runtime.summary;
  const sourceKeyRef = useRef(sourceKey);
  sourceKeyRef.current = sourceKey;
  const auxiliary = useGlobalSessionsAuxiliary(sourceKey);
  const queryState = useSessionCollectionQueryState(query, ready);
  const queryRecords = useSessionCollectionQueryRecords(query, ready);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const queryStateRef = useRef(queryState);
  queryStateRef.current = queryState;
  const queryRecordsRef = useRef(queryRecords);
  queryRecordsRef.current = queryRecords;
  const readyRef = useRef(ready);
  readyRef.current = ready;
  const projectsRef = useRef<ProjectOption[]>([]);
  projectsRef.current = auxiliary.projects;
  const requestSequenceRef = useRef(0);
  // A ref, not a dependency: the capability resolves once, and letting it
  // change `fetch`'s identity would re-run the mount effect and buy a second
  // acquisition of the thing this gate exists to avoid acquiring twice.
  const conditionalReadsRef = useRef(false);
  const retainedVersion = useRetainedVersionInfo(sourceKey);
  // SIDEBAR_SESSION_CURSOR_FALLBACK: old servers accept timestamps only.
  const tieCursorsRef = useRef(false);
  tieCursorsRef.current = serverHasCapability(
    retainedVersion,
    SERVER_CAPABILITIES.sidebarSessionSnapshot,
  );
  conditionalReadsRef.current = serverHasCapability(
    retainedVersion,
    PROGRESSIVE_SESSION_CATALOG_CAPABILITY,
  );

  useEffect(() => {
    void sourceKey;
    void queryKey;
    requestSequenceRef.current += 1;
    // A pending debounce belongs to the shared owner, and releasing this
    // subscriber on a source/query change already drops it when nobody else
    // wants it.
    setError(null);
    setLoading(enabled && !queryStateRef.current);
  }, [enabled, sourceKey, queryKey]);

  useEffect(() => {
    if (!enabled) return undefined;
    return retainClientQuery({
      sourceKey,
      key: queryKey,
    });
  }, [enabled, sourceKey, queryKey]);

  useEffect(() => {
    if (!enabled || !includeStats || projectId) {
      return undefined;
    }
    return retainClientQuery({
      sourceKey,
      key: GLOBAL_SESSION_STATS_QUERY_KEY,
    });
  }, [enabled, includeStats, projectId, sourceKey]);

  const knownGenerationForRequest = useCallback((): number | undefined => {
    const state = queryStateRef.current;
    return knownGenerationToSend({
      supported: conditionalReadsRef.current,
      accepted: acceptedGenerations.get(
        acceptedGenerationKey(sourceKeyRef.current, queryKey),
      ),
      retained: state !== undefined,
      retainedRows: queryRecordsRef.current.length,
      requestedRows,
      hasMore: state?.hasMore ?? false,
    });
  }, [queryKey, requestedRows]);

  const fetch = useCallback(
    async (fetchOptions: { force?: boolean; conditional?: boolean } = {}) => {
      if (!readyRef.current) {
        if (!queryStateRef.current) {
          setLoading(true);
        }
        return;
      }

      if (!queryStateRef.current || fetchOptions.force) {
        setLoading(true);
      }
      setError(null);

      const requestId = ++requestSequenceRef.current;
      const queryForRequest = query;
      const requestSourceKey = sourceKey;

      const resumeUpdates = pauseCollectionUpdates(runtime, queryKey);
      try {
        if (fetchOptions.force) {
          invalidateClientQuery(requestSourceKey, queryKey);
          if (includeStats && !projectId) {
            invalidateClientQuery(
              requestSourceKey,
              GLOBAL_SESSION_STATS_QUERY_KEY,
            );
          }
        }

        const refreshRows = Math.max(
          requestedRows,
          queryRecordsRef.current.length,
          collectionQueryCoverage(runtime, queryKey),
        );
        const sessionsPromise = ensureClientQuery<
          GlobalSessionsResponse | GlobalSessionsUnchangedResponse
        >({
          sourceKey: requestSourceKey,
          key: queryKey,
          coverage: { minRows: refreshRows },
          staleTimeMs: GLOBAL_SESSIONS_STALE_TIME_MS,
          force: fetchOptions.force,
          fetcher: async () => {
            const retained =
              (await resolveCollectionRequestMode(requestSourceKey, {
                searchQuery,
                currentSourceKey: () => sourceKeyRef.current,
              })) === "retained";
            const request: GlobalSessionsRequest = {
              ...(retained ? { summaryMode: "retained" as const } : {}),
              project: projectId ?? undefined,
              q: searchQuery || undefined,
              limit:
                refreshRows > requestedRows
                  ? Math.min(refreshRows, 500)
                  : limit,
              includeArchived,
              starred,
              categorized,
              includeStats: false,
            };
            const knownGeneration =
              retained || fetchOptions.conditional === false
                ? undefined
                : knownGenerationForRequest();
            const response = await (knownGeneration === undefined
              ? api.getGlobalSessions(request)
              : api.getGlobalSessions({ ...request, knownGeneration }));
            if (isUnchangedGlobalSessionsResponse(response)) return response;
            let result = response;
            while (result.hasMore && result.sessions.length < refreshRows) {
              const after = sidebarSessionCursor(
                result.sessions.at(-1),
                retained && tieCursorsRef.current,
              );
              if (!after) throw new Error("Session pagination did not advance");
              const page = await api.getGlobalSessions({
                ...request,
                after,
                limit: Math.min(refreshRows - result.sessions.length, 500),
              });
              if (
                page.hasMore &&
                (!page.sessions.length ||
                  sidebarSessionCursor(
                    page.sessions.at(-1),
                    retained && tieCursorsRef.current,
                  ) === after)
              ) {
                throw new Error("Session pagination did not advance");
              }
              result = {
                ...page,
                sessions: [...result.sessions, ...page.sessions],
              };
            }
            return result;
          },
          applySnapshot: (data, context) => {
            const generationKey = acceptedGenerationKey(
              context.sourceKey,
              queryKey,
            );
            if (isUnchangedGlobalSessionsResponse(data)) {
              // There is nothing to apply: the retained rows are the answer.
              // The freshness this refresh buys is the retained query entry's,
              // which the controller stamps on any settled request.
              acceptedGenerations.set(generationKey, data.generation);
              return;
            }

            sourceSummary.reportGlobalSessionsCollectionSnapshot(
              {
                query: queryForRequest,
                sessions: data.sessions,
                hasMore: data.hasMore,
                mode: "replace",
                catalog: data.catalog,
              },
              context.requestStartedAt,
            );
            updateGlobalSessionsAuxiliary(context.sourceKey, {
              projects: data.projects,
              ...(data.catalog ? { stats: data.stats } : {}),
            });
            if (data.generation === undefined) {
              // An ungated server, or one that stopped reporting: forget the
              // token rather than replay one these rows did not come with.
              acceptedGenerations.delete(generationKey);
            } else {
              acceptedGenerations.set(generationKey, data.generation);
            }
          },
        });
        // Retained rows carry their own stats, so only a complete read needs
        // the separate stats request. Its mode is chained, not awaited here:
        // a source change rejects both reads, and awaiting this one first
        // would leave the sessions read's rejection unobserved.
        const statsPromise =
          includeStats && !projectId
            ? resolveCollectionRequestMode(requestSourceKey, {
                searchQuery,
                currentSourceKey: () => sourceKeyRef.current,
              }).then((statsMode) =>
                statsMode === "complete"
                  ? ensureClientQuery<{ stats: GlobalSessionStats }>({
                      sourceKey: requestSourceKey,
                      key: GLOBAL_SESSION_STATS_QUERY_KEY,
                      coverage: { includeStats: true },
                      staleTimeMs: GLOBAL_SESSION_STATS_STALE_TIME_MS,
                      force: fetchOptions.force,
                      fetcher: () => api.getGlobalSessionStats(),
                      applySnapshot: (data, context) => {
                        updateGlobalSessionsAuxiliary(context.sourceKey, {
                          stats: data.stats,
                        });
                      },
                    })
                  : undefined,
              )
            : Promise.resolve();

        await Promise.all([sessionsPromise, statsPromise]);
      } catch (err) {
        if (requestId === requestSequenceRef.current) {
          setError(err instanceof Error ? err : new Error(String(err)));
        }
      } finally {
        resumeUpdates(
          selectSessionCollectionQueryState(sourceSummary.getSnapshot(), query)
            ?.ids.length,
        );
        if (requestId === requestSequenceRef.current) {
          setLoading(false);
        }
      }
    },
    [
      query,
      queryKey,
      projectId,
      searchQuery,
      limit,
      includeArchived,
      starred,
      categorized,
      includeStats,
      requestedRows,
      sourceKey,
      sourceSummary,
      runtime,
      knownGenerationForRequest,
    ],
  );

  const loadMore = useCallback(async () => {
    if (!readyRef.current || !queryStateRef.current?.hasMore) {
      return;
    }

    const records = queryRecordsRef.current;
    const lastRecord = records[records.length - 1];
    if (!lastRecord) {
      return;
    }
    if (!lastRecord.updatedAt) {
      // Asking for a page we do not have: an `unchanged` answer would be true
      // and useless, so this one always reads rows.
      await fetch({ force: true, conditional: false });
      return;
    }

    if (
      records.length < 500 &&
      expandCollectionUpdates(
        runtime,
        queryKey,
        Math.min(500, records.length + requestedRows),
      )
    )
      return;

    const requestSourceKey = sourceKey;
    const resumeUpdates = pauseCollectionUpdates(runtime, queryKey);
    try {
      setError(null);
      const requestStartedAt = Date.now();
      const mode = await resolveCollectionRequestMode(requestSourceKey, {
        searchQuery,
        currentSourceKey: () => sourceKeyRef.current,
      });
      const data = await api.getGlobalSessions({
        ...(mode === "retained" ? { summaryMode: "retained" as const } : {}),
        project: projectId ?? undefined,
        q: searchQuery || undefined,
        limit,
        after: sidebarSessionCursor(
          lastRecord as { id: string; updatedAt?: string },
          mode === "retained" && tieCursorsRef.current,
        ),
        includeArchived,
        starred,
        categorized,
        includeStats: false,
      });

      sourceSummary.reportGlobalSessionsCollectionSnapshot(
        {
          query,
          sessions: data.sessions,
          hasMore: data.hasMore,
          mode: "append",
          catalog: data.catalog,
        },
        requestStartedAt,
      );
      updateGlobalSessionsAuxiliary(requestSourceKey, {
        projects: data.projects,
      });
    } catch (err) {
      if (sourceKeyRef.current === requestSourceKey) {
        setError(err instanceof Error ? err : new Error(String(err)));
      }
    } finally {
      resumeUpdates(
        selectSessionCollectionQueryState(sourceSummary.getSnapshot(), query)
          ?.ids.length,
      );
    }
  }, [
    fetch,
    requestedRows,
    query,
    projectId,
    searchQuery,
    limit,
    includeArchived,
    starred,
    categorized,
    sourceKey,
    sourceSummary,
    runtime,
    queryKey,
  ]);

  // The debounce timer and the reconnect listener belong to the shared
  // `(sourceKey, queryKey)` owner. This feed's key is mounted from the sidebar,
  // the Global Sessions page, and the recent-sessions dropdown at once, so
  // per-hook timers meant one activity event scheduled one refetch per mount.
  const revalidationRef = useRef<QueryRevalidationHandle | null>(null);
  const fetchRef = useRef(fetch);
  fetchRef.current = fetch;

  const updateParams = new URLSearchParams({
    summaryMode: "retained",
    limit: String(requestedRows),
    includeStats: "false",
  });
  if (projectId) updateParams.set("project", projectId);
  if (includeArchived) updateParams.set("includeArchived", "true");
  if (starred) updateParams.set("starred", "true");
  if (categorized) updateParams.set("categorized", "true");
  useCollectionUpdates<GlobalSessionsResponse>({
    runtime,
    key: queryKey,
    path: "/sessions?" + updateParams,
    rows: Math.max(requestedRows, queryRecords.length),
    enabled:
      ready &&
      !searchQuery &&
      requestedRows <= 500 &&
      queryRecords.length <= 500,
    applySnapshot: (data, context) => {
      sourceSummary.reportGlobalSessionsCollectionSnapshot(
        {
          query,
          sessions: data.sessions,
          hasMore: data.hasMore,
          mode: "replace",
          catalog: data.catalog,
        },
        context.requestStartedAt,
      );
      updateGlobalSessionsAuxiliary(sourceKey, {
        projects: data.projects,
        stats: data.stats,
      });
      setLoading(false);
      setError(null);
    },
    fallback: () => revalidationRef.current?.schedule(),
  });

  const revalidationSubscriber = useCallback(
    () => ({
      coverage: { minRows: requestedRows },
      events: GLOBAL_SESSIONS_REVALIDATE_EVENTS,
      debounceMs: REFETCH_DEBOUNCE_MS,
      shouldRevalidateEvent: () => !collectionQueryIsLive(runtime, queryKey),
      run: () => {
        if (collectionQueryIsLive(runtime, queryKey)) return;
        void fetchRef.current({ force: true });
      },
    }),
    [requestedRows, runtime, queryKey],
  );

  useEffect(() => {
    if (!enabled) return undefined;
    const handle = retainQueryRevalidation({
      sourceKey,
      key: queryKey,
      subscriber: revalidationSubscriber(),
    });
    revalidationRef.current = handle;
    return () => {
      revalidationRef.current = null;
      handle.release();
    };
  }, [enabled, sourceKey, queryKey, revalidationSubscriber]);

  // Coverage and closures change between renders; the owner needs the current
  // ones without the retention itself churning.
  useEffect(() => {
    revalidationRef.current?.update(revalidationSubscriber());
  });

  const debouncedRefetch = useCallback(() => {
    if (!readyRef.current || collectionQueryIsLive(runtime, queryKey)) return;
    revalidationRef.current?.schedule();
  }, [runtime, queryKey]);

  const handleProcessStateChange = useCallback(
    (event: ProcessStateEvent) => {
      const currentlyMatched = queryRecordsRef.current.some(
        (record) => record.id === event.sessionId,
      );
      if (
        shouldRefetchGlobalSessionsAfterProcessState(event, currentlyMatched)
      ) {
        debouncedRefetch();
      }
    },
    [debouncedRefetch],
  );

  const handleSessionCreated = useCallback(
    (event: SessionCreatedEvent) => {
      if (collectionQueryIsLive(runtime, queryKey)) return;
      const observedAt = Date.now();
      sourceSummary.reportSessionCollectionCreated(event, observedAt);

      if (projectId && event.session.projectId !== projectId) return;
      if (starred && !event.session.isStarred) return;
      // A session is created without a category.
      if (categorized) return;
      if (includeArchived !== true && event.session.isArchived) return;

      if (searchQuery) {
        debouncedRefetch();
        return;
      }

      sourceSummary.reportGlobalSessionsCollectionSnapshot(
        {
          query,
          sessions: [
            sessionCreatedEventToGlobalSessionItem(event, projectsRef.current),
          ],
          hasMore: queryStateRef.current?.hasMore ?? false,
          mode: "prepend",
        },
        observedAt,
      );
    },
    [
      projectId,
      starred,
      categorized,
      includeArchived,
      searchQuery,
      debouncedRefetch,
      query,
      sourceSummary,
      runtime,
      queryKey,
    ],
  );

  const handleSessionMetadataChange = useCallback(
    (event: SessionMetadataChangedEvent) => {
      sourceSummary.reportSessionCollectionMetadataChanged(event);

      if (
        searchQuery ||
        (projectId &&
          event.projectId !== undefined &&
          event.projectId !== projectId)
      ) {
        debouncedRefetch();
      }
    },
    [debouncedRefetch, projectId, searchQuery, sourceSummary],
  );

  useFileActivity({
    enabled,
    maxEvents: 0,
    onSessionCreated: handleSessionCreated,
    onProcessStateChange: handleProcessStateChange,
    onSessionMetadataChange: handleSessionMetadataChange,
  });

  // This feed owns its acquisition rather than going through
  // `useRetainedClientQuery`, so it joins the startup ordering here. Only the
  // first fetch waits; `debouncedRefetch` and `refetch` never do.
  useEffect(() => {
    if (!ready) {
      return undefined;
    }

    let cancelled = false;
    const slot = acquireClientQueryBootstrapSlot(sourceKey, "navigation");
    void slot.ready().then(() => {
      if (cancelled) {
        slot.settle();
        return;
      }
      // A query with no other retainer may have been inactive while another
      // device created sessions. Its time-based freshness only describes the
      // last local request, not whether events were observed while inactive,
      // so validate against the server's collection generation on activation.
      // Later consumers of an already-retained query reuse its live coverage.
      const firstRetainer =
        getClientQueryState(sourceKey, queryKey)?.retainedCount === 1;
      void fetch(firstRetainer ? { force: true } : undefined).finally(() =>
        slot.settle(),
      );
    });
    return () => {
      cancelled = true;
      slot.settle();
    };
  }, [fetch, queryKey, ready, sourceKey]);

  const catalogState = catalogLoadState(
    queryState?.catalog,
    queryState?.ids.length ?? 0,
  );

  return {
    query,
    ready,
    loading:
      enabled &&
      (loading || (!ready && !queryState) || catalogState.awaitingFirstRows),
    error: error ?? catalogState.refreshError,
    hasMore: queryState?.hasMore ?? false,
    loadMore,
    // An explicit refresh is a fidelity request, not a freshness one: a user
    // who presses refresh is entitled to rows, not to being told the server
    // agrees with what they are already looking at.
    refetch: () => fetch({ force: true, conditional: false }),
    stats:
      includeStats && !projectId
        ? auxiliary.stats
        : DEFAULT_GLOBAL_SESSION_STATS,
    projects: auxiliary.projects,
  };
}
