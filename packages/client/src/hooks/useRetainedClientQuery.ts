import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ActivityEventType } from "../lib/activityBus";
import {
  type ClientQueryBootstrapTier,
  acquireClientQueryBootstrapSlot,
} from "../lib/clientQueryBootstrap";
import {
  createClientQueryKey,
  ensureClientQuery,
  retainClientQuery,
  type ClientQueryCoverage,
  type ClientQueryRequestContext,
  type ClientQuerySettlement,
} from "../lib/clientQueryController";
import {
  retainQueryRevalidation,
  type QueryRevalidationHandle,
} from "../lib/clientQueryRevalidation";
import type { ClientSummarySourceKey } from "../lib/clientSummaryStore";

const DEFAULT_REVALIDATE_DEBOUNCE_MS = 500;

export interface UseRetainedClientQueryOptions<T> {
  sourceKey: ClientSummarySourceKey;
  key: unknown;
  coverage?: ClientQueryCoverage;
  enabled?: boolean;
  ready?: boolean;
  hasData?: boolean;
  staleTimeMs?: number;
  debounceMs?: number;
  /**
   * Which startup tier this query's *first* acquisition belongs to. Omitted
   * means ungated. Revalidations never wait, whatever this says.
   */
  bootstrapTier?: ClientQueryBootstrapTier;
  meta?: unknown;
  revalidateOn?: readonly ActivityEventType[];
  shouldRevalidateEvent?: (event: RetainedClientQueryEvent) => boolean;
  fetcher: (context: ClientQueryRequestContext) => Promise<T>;
  applySnapshot?: (result: T, context: ClientQueryRequestContext) => void;
}

export type RetainedClientQuerySettlement =
  | ClientQuerySettlement
  | { status: "failed"; error: Error }
  | { status: "skipped" };

export interface UseRetainedClientQueryResult {
  loading: boolean;
  error: Error | null;
  refetch: (
    options?: RetainedClientQueryRunOptions,
  ) => Promise<RetainedClientQuerySettlement>;
  scheduleRevalidation: () => void;
}

export interface RetainedClientQueryRunOptions {
  force?: boolean;
  background?: boolean;
  meta?: unknown;
}

export interface RetainedClientQueryEvent {
  eventType: ActivityEventType;
  data: unknown;
}

export function useRetainedClientQuery<T>({
  sourceKey,
  key,
  coverage,
  enabled = true,
  ready = true,
  hasData = false,
  staleTimeMs,
  debounceMs = DEFAULT_REVALIDATE_DEBOUNCE_MS,
  bootstrapTier,
  meta,
  revalidateOn = [],
  shouldRevalidateEvent,
  fetcher,
  applySnapshot,
}: UseRetainedClientQueryOptions<T>): UseRetainedClientQueryResult {
  const queryKey = useMemo(() => createClientQueryKey(key), [key]);
  const coverageKey = useMemo(
    () => createClientQueryKey(coverage ?? {}),
    [coverage],
  );
  const revalidateEventsKey = useMemo(
    () => revalidateOn.join("\0"),
    [revalidateOn],
  );
  const revalidateEvents = useMemo(
    () =>
      revalidateEventsKey
        ? (revalidateEventsKey.split("\0") as ActivityEventType[])
        : [],
    [revalidateEventsKey],
  );

  const [loading, setLoading] = useState(enabled && !hasData);
  const [error, setError] = useState<Error | null>(null);
  const hasSuccessfulFetchRef = useRef(hasData);
  const mountedRef = useRef(true);
  const runSequenceRef = useRef(0);
  const coverageRef = useRef(coverage);
  const metaRef = useRef(meta);
  const shouldRevalidateEventRef = useRef(shouldRevalidateEvent);
  const fetcherRef = useRef(fetcher);
  const applySnapshotRef = useRef(applySnapshot);

  coverageRef.current = coverage;
  metaRef.current = meta;
  shouldRevalidateEventRef.current = shouldRevalidateEvent;
  fetcherRef.current = fetcher;
  applySnapshotRef.current = applySnapshot;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    // `void x` marks an intentional rerun trigger: the key belongs in the
    // dependency array even though the body never reads it.
    void sourceKey;
    void queryKey;
    void coverageKey;
    hasSuccessfulFetchRef.current = hasData;
    setError(null);
    setLoading(enabled && !hasData);
    // A pending debounce is the owner's, and releasing this subscriber on a
    // source/query change already drops it when nobody else wants it.
  }, [enabled, hasData, sourceKey, queryKey, coverageKey]);

  useEffect(() => {
    if (!enabled) {
      return undefined;
    }
    return retainClientQuery({ sourceKey, key: queryKey });
  }, [enabled, sourceKey, queryKey]);

  const run = useCallback(
    async ({
      force = false,
      background = false,
      meta,
    }: RetainedClientQueryRunOptions = {}): Promise<RetainedClientQuerySettlement> => {
      if (!enabled || !ready) {
        return { status: "skipped" };
      }
      void coverageKey;

      const requestId = ++runSequenceRef.current;
      const hasDataAtStart = hasSuccessfulFetchRef.current;
      if (!background || !hasDataAtStart) {
        setLoading(true);
        setError(null);
      }

      try {
        const fetcherAtStart = fetcherRef.current;
        const applySnapshotAtStart = applySnapshotRef.current;
        const settlement = await ensureClientQuery({
          sourceKey,
          key: queryKey,
          coverage: coverageRef.current,
          staleTimeMs,
          force,
          meta: meta ?? metaRef.current,
          fetcher: (context) => fetcherAtStart(context),
          applySnapshot: (result, context) => {
            applySnapshotAtStart?.(result, context);
          },
        });

        if (
          mountedRef.current &&
          requestId === runSequenceRef.current &&
          settlement.status !== "obsolete"
        ) {
          hasSuccessfulFetchRef.current = true;
          setError(null);
        }
        return settlement;
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        if (mountedRef.current && requestId === runSequenceRef.current) {
          if (!background || !hasSuccessfulFetchRef.current) {
            setError(error);
          }
        }
        return { status: "failed", error };
      } finally {
        if (mountedRef.current && requestId === runSequenceRef.current) {
          setLoading(false);
        }
      }
    },
    [enabled, ready, sourceKey, queryKey, coverageKey, staleTimeMs],
  );

  // Event listening and the debounce timer belong to the shared
  // `(sourceKey, queryKey)` owner, not to this hook instance, so twenty mounted
  // consumers of one query install one listener set and arm one timer.
  const revalidationRef = useRef<QueryRevalidationHandle | null>(null);
  const runRef = useRef(run);
  runRef.current = run;

  useEffect(() => {
    if (!enabled) {
      revalidationRef.current = null;
      return undefined;
    }
    const handle = retainQueryRevalidation({
      sourceKey,
      key: queryKey,
      subscriber: {
        coverage: coverageRef.current,
        events: revalidateEvents,
        debounceMs,
        shouldRevalidateEvent: (event) =>
          shouldRevalidateEventRef.current?.(event) !== false,
        run: () => runRef.current({ force: true, background: true }),
      },
    });
    revalidationRef.current = handle;
    return () => {
      revalidationRef.current = null;
      handle.release();
    };
  }, [enabled, sourceKey, queryKey, revalidateEvents, debounceMs]);

  // Closures and coverage change between renders; the owner needs the current
  // ones without the retention itself churning.
  useEffect(() => {
    revalidationRef.current?.update({
      coverage: coverageRef.current,
      events: revalidateEvents,
      debounceMs,
      shouldRevalidateEvent: (event) =>
        shouldRevalidateEventRef.current?.(event) !== false,
      run: () => runRef.current({ force: true, background: true }),
    });
  });

  const scheduleRevalidation = useCallback(() => {
    if (!enabled) {
      return;
    }
    revalidationRef.current?.schedule();
  }, [enabled]);

  // Only this first acquisition waits for its startup tier. The revalidation
  // owner above calls `run` directly, so a reconnect recovers at full speed
  // even while a slow route request still holds the bootstrap gate.
  useEffect(() => {
    if (!enabled || !ready) {
      return undefined;
    }
    if (!bootstrapTier) {
      void run();
      return undefined;
    }

    let cancelled = false;
    const slot = acquireClientQueryBootstrapSlot(sourceKey, bootstrapTier);
    void slot.ready().then(() => {
      if (cancelled) {
        slot.settle();
        return;
      }
      void run().finally(() => slot.settle());
    });
    return () => {
      cancelled = true;
      slot.settle();
    };
  }, [enabled, ready, run, sourceKey, bootstrapTier]);

  return {
    loading,
    error,
    refetch: (options?: RetainedClientQueryRunOptions) =>
      run({ ...options, force: options?.force ?? true }),
    scheduleRevalidation,
  };
}
