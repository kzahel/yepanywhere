import {
  type ProjectQueueDispatchState,
  type ProjectQueueItemSummary,
  type ProjectQueueProjectStatus,
  type ProjectQueuePromoteNowResult,
  type ProjectQueueRecoveredSessionQueueSummary,
  type UpdateProjectQueueItemRequest,
  retagEditedQueuedMessage,
} from "@yep-anywhere/shared";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api/client";
import { useOptionalRemoteConnection } from "../contexts/RemoteConnectionContext";
import { useCurrentSourceRuntime } from "../contexts/SourceRuntimeContext";
import {
  createClientQueryKey,
  invalidateClientQuery,
} from "../lib/clientQueryController";
import { isRemoteClient } from "../lib/connection";

import {
  type ClientSummarySourceKey,
  useProjectQueueDispatchState,
  useProjectQueueGlobalItems,
  useProjectQueueItemsByProject,
  useProjectQueueProjectStatusesByProject,
  useProjectQueueRecoveredSessionQueues,
} from "../lib/clientSummaryStore";
import {
  type RetainedClientQuerySettlement,
  useRetainedClientQuery,
} from "./useRetainedClientQuery";

export interface UseProjectQueuesResult {
  queuesByProject: Record<string, readonly ProjectQueueItemSummary[]>;
  items: readonly ProjectQueueItemSummary[];
  projectStatusesByProject: Record<string, ProjectQueueProjectStatus>;
  recoveredSessionQueues: ProjectQueueRecoveredSessionQueueSummary[];
  loading: boolean;
  error: Error | null;
  mutatingItemId: string | null;
  mutatingRecoveredQueueId: string | null;
  mutatingDispatchState: boolean;
  mutatingPromoteItemId: string | null;
  dispatchState: ProjectQueueDispatchState;
  refetch: () => Promise<void>;
  pauseDispatch: () => Promise<void>;
  resumeDispatch: () => Promise<void>;
  promoteNow: (
    projectId: string,
    itemId: string,
    options?: { force?: boolean; deliveryIntent?: "steer" },
  ) => Promise<ProjectQueuePromoteNowResult>;
  updateItem: (
    projectId: string,
    itemId: string,
    request: UpdateProjectQueueItemRequest,
  ) => Promise<void>;
  deleteItem: (projectId: string, itemId: string) => Promise<void>;
  resumeRecoveredItem: (sessionId: string, queueId: string) => Promise<void>;
  deleteRecoveredItem: (sessionId: string, queueId: string) => Promise<void>;
  retryItem: (projectId: string, itemId: string) => Promise<void>;
  moveItemToTop: (projectId: string, itemId: string) => Promise<void>;
}

function uniqueProjectIds(projectIds: readonly string[]): string[] {
  return [...new Set(projectIds.filter(Boolean))];
}

function flattenQueues(
  queuesByProject: Record<string, readonly ProjectQueueItemSummary[]>,
): readonly ProjectQueueItemSummary[] {
  return Object.values(queuesByProject).flat();
}

const PROJECT_QUEUE_QUERY_KEY = createClientQueryKey({
  endpoint: "project-queue",
});
const PROJECT_QUEUE_REVALIDATE_EVENTS = [
  "refresh",
  "reconnect",
  "project-queue-changed",
  "session-catalog-updated",
  "session-metadata-changed",
  "session-queue-persistence-changed",
] as const;

/**
 * How long to wait before re-reading a project the server is actively working
 * (`ready` or `dispatching`) but has given no deadline for. This is the
 * missed-event guard the removed per-consumer interval used to be, kept at its
 * previous length so no situation recovers more slowly than before — the change
 * is that one source arms it once, rather than every mounted consumer arming
 * its own.
 */
const PROJECT_QUEUE_ACTIVE_FALLBACK_MS = 5000;
/** Never spin: a deadline already past still waits this long before firing. */
const PROJECT_QUEUE_MIN_DELAY_MS = 250;
const PROJECT_QUEUE_RETRY_INITIAL_MS = 500;
const PROJECT_QUEUE_RETRY_MAX_MS = 5000;

interface ProjectQueueDeadline {
  /** Earliest instant the server said something could happen, if it said one. */
  deadlineAtMs: number | null;
  /** A project the server is acting on now, so a missed event is possible. */
  hasActiveProject: boolean;
}

const NO_PROJECT_QUEUE_DEADLINE: ProjectQueueDeadline = {
  deadlineAtMs: null,
  hasActiveProject: false,
};

/**
 * The exact instants the server reported, plus whether anything is in flight.
 * `nextAttemptAt` and `quietEligibleAt` are the queue's own scheduling
 * decisions, so honouring them is strictly better than sampling on a timer:
 * a project waiting out a 30-second quiet window is read once, at the end of
 * it, instead of six times during it.
 */
function readProjectQueueDeadline(
  statusesByProject: Record<string, ProjectQueueProjectStatus>,
  projectIds: readonly string[],
): ProjectQueueDeadline {
  let deadlineAtMs: number | null = null;
  let hasActiveProject = false;

  for (const projectId of projectIds) {
    const status = statusesByProject[projectId];
    if (!status) continue;
    for (const iso of [status.nextAttemptAt, status.quietEligibleAt]) {
      if (!iso) continue;
      const atMs = Date.parse(iso);
      if (!Number.isFinite(atMs)) continue;
      deadlineAtMs =
        deadlineAtMs === null ? atMs : Math.min(deadlineAtMs, atMs);
    }
    if (status.state === "ready" || status.state === "dispatching") {
      hasActiveProject = true;
    }
  }

  return { deadlineAtMs, hasActiveProject };
}

interface ProjectQueueBackstopContribution {
  deadlineAtMs: number | null;
  attemptedDeadlineAtMs: number | null;
  hasActiveProject: boolean;
  activeFallbackAtMs: number | null;
  refetch: () => Promise<RetainedClientQuerySettlement>;
}

interface ProjectQueueRetry {
  firesAtMs: number;
  delayMs: number;
  generation: number;
}

interface ProjectQueueAttempt {
  generation: number;
}

interface ProjectQueueBackstopEntry {
  contributions: Map<number, ProjectQueueBackstopContribution>;
  attempt: ProjectQueueAttempt | null;
  retry: ProjectQueueRetry | null;
  retryGeneration: number;
  timer: ReturnType<typeof setTimeout> | null;
  firesAtMs: number | null;
  timerGeneration: number;
}

interface ProjectQueueBackstopHandle {
  update(
    deadline: ProjectQueueDeadline,
    refetch: () => Promise<RetainedClientQuerySettlement>,
  ): void;
  release(): void;
}

const projectQueueBackstopsBySource = new Map<
  ClientSummarySourceKey,
  ProjectQueueBackstopEntry
>();
let nextProjectQueueBackstopId = 1;

function clearProjectQueueTimer(entry: ProjectQueueBackstopEntry): void {
  if (entry.timer) {
    clearTimeout(entry.timer);
    entry.timer = null;
  }
  entry.firesAtMs = null;
  entry.timerGeneration += 1;
}

function contributionFireTime(
  contribution: ProjectQueueBackstopContribution,
): number | null {
  const deadlineAtMs =
    contribution.deadlineAtMs === contribution.attemptedDeadlineAtMs
      ? null
      : contribution.deadlineAtMs;
  if (deadlineAtMs === null) {
    return contribution.activeFallbackAtMs;
  }
  if (contribution.activeFallbackAtMs === null) {
    return deadlineAtMs;
  }
  return Math.min(deadlineAtMs, contribution.activeFallbackAtMs);
}

interface ProjectQueueWake {
  contributionId: number;
  contribution: ProjectQueueBackstopContribution;
  firesAtMs: number;
  retryDelayMs: number | null;
}

function earliestProjectQueueWake(
  entry: ProjectQueueBackstopEntry,
): ProjectQueueWake | null {
  let earliest: ProjectQueueWake | null = null;
  for (const [contributionId, contribution] of entry.contributions) {
    const firesAtMs = contributionFireTime(contribution);
    if (firesAtMs === null) continue;
    if (earliest === null || firesAtMs < earliest.firesAtMs) {
      earliest = {
        contributionId,
        contribution,
        firesAtMs,
        retryDelayMs: null,
      };
    }
  }

  const retry = entry.retry;
  const retryContributionId = attemptedProjectQueueContribution(entry);
  if (
    retry?.generation === entry.retryGeneration &&
    retryContributionId !== null
  ) {
    const contribution = entry.contributions.get(retryContributionId);
    if (
      contribution &&
      (earliest === null || retry.firesAtMs < earliest.firesAtMs)
    ) {
      return {
        contributionId: retryContributionId,
        contribution,
        firesAtMs: retry.firesAtMs,
        retryDelayMs: retry.delayMs,
      };
    }
  }
  return earliest;
}

function installProjectQueueRetry(
  entry: ProjectQueueBackstopEntry,
  delayMs: number,
): void {
  const generation = entry.retryGeneration + 1;
  entry.retryGeneration = generation;
  entry.retry = {
    firesAtMs: Date.now() + delayMs,
    delayMs,
    generation,
  };
}

function attemptedProjectQueueContribution(
  entry: ProjectQueueBackstopEntry,
): number | null {
  for (const [contributionId, contribution] of entry.contributions) {
    if (contributionFireTime(contribution) !== null) continue;
    if (
      contribution.attemptedDeadlineAtMs !== null ||
      (contribution.hasActiveProject &&
        contribution.activeFallbackAtMs === null)
    ) {
      return contributionId;
    }
  }
  return null;
}

function reconcileProjectQueueBackstop(
  sourceKey: ClientSummarySourceKey,
  entry: ProjectQueueBackstopEntry,
  retryDelayMs = PROJECT_QUEUE_RETRY_INITIAL_MS,
): void {
  if (entry.retry?.generation !== entry.retryGeneration) {
    entry.retry = null;
  }
  if (!entry.retry && attemptedProjectQueueContribution(entry) !== null) {
    installProjectQueueRetry(entry, retryDelayMs);
  }
  syncProjectQueueBackstop(sourceKey);
}

/** Arm exactly one timer per source for its retainers' earliest contribution. */
function syncProjectQueueBackstop(sourceKey: ClientSummarySourceKey): void {
  const entry = projectQueueBackstopsBySource.get(sourceKey);
  if (!entry) return;

  // One global queue request serves every contribution for this source. Never
  // arm another deadline while that source-owned acquisition is pending.
  if (entry.attempt) {
    clearProjectQueueTimer(entry);
    return;
  }
  if (
    entry.retry &&
    (entry.retry.generation !== entry.retryGeneration ||
      attemptedProjectQueueContribution(entry) === null)
  ) {
    entry.retry = null;
  }

  const earliest = earliestProjectQueueWake(entry);
  const firesAtMs = earliest?.firesAtMs ?? null;
  if (firesAtMs === null) {
    clearProjectQueueTimer(entry);
    return;
  }
  if (entry.timer && entry.firesAtMs === firesAtMs) {
    return;
  }

  clearProjectQueueTimer(entry);
  const nowMs = Date.now();
  const timerGeneration = entry.timerGeneration;
  entry.firesAtMs = firesAtMs;
  entry.timer = setTimeout(
    () => {
      if (
        projectQueueBackstopsBySource.get(sourceKey) !== entry ||
        entry.timerGeneration !== timerGeneration
      ) {
        return;
      }
      entry.timer = null;
      entry.firesAtMs = null;

      const due = earliestProjectQueueWake(entry);
      if (due === null) {
        return;
      }
      if (due.firesAtMs > Date.now()) {
        syncProjectQueueBackstop(sourceKey);
        return;
      }

      const attemptAtMs = Date.now();
      if (due.retryDelayMs !== null) {
        // The retry wake is single-use. Removing it before refetch prevents
        // rerenders from rearming its now-past timestamp while this request is
        // still pending.
        entry.retry = null;
      } else {
        if (
          due.contribution.deadlineAtMs !== null &&
          due.contribution.deadlineAtMs <= attemptAtMs
        ) {
          due.contribution.attemptedDeadlineAtMs =
            due.contribution.deadlineAtMs;
        }
        if (
          due.contribution.activeFallbackAtMs !== null &&
          due.contribution.activeFallbackAtMs <= attemptAtMs
        ) {
          due.contribution.activeFallbackAtMs = null;
        }
      }

      // Every attempt takes exact source-level ownership. A later retainer can
      // supersede it, and only the attempt whose token is still current may
      // publish success or install the next retry.
      const attemptGeneration = entry.retryGeneration + 1;
      const nextRetryDelayMs =
        due.retryDelayMs === null
          ? PROJECT_QUEUE_RETRY_INITIAL_MS
          : Math.min(due.retryDelayMs * 2, PROJECT_QUEUE_RETRY_MAX_MS);
      entry.retryGeneration = attemptGeneration;
      entry.retry = null;
      entry.attempt = { generation: attemptGeneration };
      syncProjectQueueBackstop(sourceKey);

      // A request admitted before this server deadline cannot answer the
      // transition the deadline represents. Advance the query generation before
      // forcing the canonical source-level revalidation.
      invalidateClientQuery(sourceKey, PROJECT_QUEUE_QUERY_KEY);
      void due.contribution.refetch().then((settlement) => {
        if (
          projectQueueBackstopsBySource.get(sourceKey) !== entry ||
          entry.retryGeneration !== attemptGeneration ||
          entry.attempt?.generation !== attemptGeneration
        ) {
          return;
        }

        entry.attempt = null;
        if (settlement.status === "failed") {
          reconcileProjectQueueBackstop(sourceKey, entry, nextRetryDelayMs);
          return;
        }
        if (
          settlement.status === "accepted" ||
          settlement.status === "covered"
        ) {
          entry.retry = null;
          for (const contribution of entry.contributions.values()) {
            if (
              contribution.hasActiveProject &&
              contribution.activeFallbackAtMs === null
            ) {
              contribution.activeFallbackAtMs =
                Date.now() + PROJECT_QUEUE_ACTIVE_FALLBACK_MS;
            }
          }
          syncProjectQueueBackstop(sourceKey);
          return;
        }
        reconcileProjectQueueBackstop(sourceKey, entry, nextRetryDelayMs);
      });
    },
    Math.max(PROJECT_QUEUE_MIN_DELAY_MS, firesAtMs - nowMs),
  );
}

function getOrCreateProjectQueueBackstopEntry(
  sourceKey: ClientSummarySourceKey,
): ProjectQueueBackstopEntry {
  const existing = projectQueueBackstopsBySource.get(sourceKey);
  if (existing) return existing;

  const created: ProjectQueueBackstopEntry = {
    contributions: new Map(),
    attempt: null,
    retry: null,
    retryGeneration: 0,
    timer: null,
    firesAtMs: null,
    timerGeneration: 0,
  };
  projectQueueBackstopsBySource.set(sourceKey, created);
  return created;
}

function retainProjectQueueBackstop(
  sourceKey: ClientSummarySourceKey,
): ProjectQueueBackstopHandle {
  const boundEntry = getOrCreateProjectQueueBackstopEntry(sourceKey);
  const contributionId = nextProjectQueueBackstopId++;
  boundEntry.contributions.set(contributionId, {
    deadlineAtMs: null,
    attemptedDeadlineAtMs: null,
    hasActiveProject: false,
    activeFallbackAtMs: null,
    refetch: async () => ({ status: "skipped" }),
  });

  let released = false;
  return {
    update(deadline, refetch) {
      if (released) return;
      const contribution = boundEntry.contributions.get(contributionId);
      if (!contribution) return;

      const deadlineChanged =
        contribution.deadlineAtMs !== deadline.deadlineAtMs;
      const activeChanged =
        contribution.hasActiveProject !== deadline.hasActiveProject;
      contribution.deadlineAtMs = deadline.deadlineAtMs;
      contribution.hasActiveProject = deadline.hasActiveProject;
      contribution.refetch = refetch;
      if (deadlineChanged) {
        contribution.attemptedDeadlineAtMs = null;
      }
      if (activeChanged) {
        contribution.activeFallbackAtMs = deadline.hasActiveProject
          ? Date.now() + PROJECT_QUEUE_ACTIVE_FALLBACK_MS
          : null;
      }
      syncProjectQueueBackstop(sourceKey);
    },
    release() {
      if (released) return;
      released = true;
      boundEntry.contributions.delete(contributionId);

      if (boundEntry.contributions.size === 0) {
        clearProjectQueueTimer(boundEntry);
        if (projectQueueBackstopsBySource.get(sourceKey) === boundEntry) {
          projectQueueBackstopsBySource.delete(sourceKey);
        }
        return;
      }
      syncProjectQueueBackstop(sourceKey);
    },
  };
}

export function resetProjectQueueBackstopsForTests(): void {
  for (const entry of projectQueueBackstopsBySource.values()) {
    clearProjectQueueTimer(entry);
  }
  projectQueueBackstopsBySource.clear();
  nextProjectQueueBackstopId = 1;
}

export function useProjectQueues(
  projectIds: readonly string[],
): UseProjectQueuesResult {
  const runtime = useCurrentSourceRuntime();
  const sourceKey = runtime.sourceKey;
  const sourceSummary = runtime.summary;
  const remoteConnection = useOptionalRemoteConnection();

  const ready =
    !isRemoteClient() ||
    (remoteConnection !== null && remoteConnection.connection !== null);
  const normalizedProjectIds = useMemo(
    () => uniqueProjectIds(projectIds),
    [projectIds],
  );
  const storedQueuesByProject =
    useProjectQueueItemsByProject(normalizedProjectIds);
  const storedGlobalItems = useProjectQueueGlobalItems(normalizedProjectIds);
  const storedDispatchState = useProjectQueueDispatchState();
  const storedRecoveredSessionQueues = useProjectQueueRecoveredSessionQueues();
  const storedProjectStatusesByProject =
    useProjectQueueProjectStatusesByProject();
  const [mutatingItemId, setMutatingItemId] = useState<string | null>(null);
  const [mutatingRecoveredQueueId, setMutatingRecoveredQueueId] = useState<
    string | null
  >(null);
  const mutatingRecoveredQueueIdRef = useRef<string | null>(null);
  const [mutatingDispatchState, setMutatingDispatchState] = useState(false);
  const [mutatingPromoteItemId, setMutatingPromoteItemId] = useState<
    string | null
  >(null);
  const [mutationError, setMutationError] = useState<Error | null>(null);
  const queryEnabled = normalizedProjectIds.length > 0;
  const hasData = Object.keys(storedQueuesByProject).length > 0;
  const {
    loading,
    error: queryError,
    refetch,
  } = useRetainedClientQuery({
    sourceKey,
    key: PROJECT_QUEUE_QUERY_KEY,
    bootstrapTier: "navigation",
    enabled: queryEnabled,
    ready,
    hasData,
    revalidateOn: PROJECT_QUEUE_REVALIDATE_EVENTS,
    fetcher: () => api.getProjectQueueItems(),
    applySnapshot: (data, context) => {
      sourceSummary.reportProjectQueueGlobalCollectionSnapshot(
        data,
        context.requestStartedAt,
      );
    },
  });

  const updateItem = useCallback(
    async (
      projectId: string,
      itemId: string,
      request: UpdateProjectQueueItemRequest,
    ) => {
      setMutatingItemId(itemId);
      setMutationError(null);
      const requestSummary = sourceSummary;
      try {
        // Queue editors spread the old message and replace its text; the
        // command it runs follows that text (topics/project-queue.md).
        const response = await api.updateProjectQueueItem(
          projectId,
          itemId,
          request.message
            ? { ...request, message: retagEditedQueuedMessage(request.message) }
            : request,
        );
        requestSummary.reportProjectQueueCollectionSnapshot(response.queue);
      } catch (err) {
        setMutationError(err instanceof Error ? err : new Error(String(err)));
        throw err;
      } finally {
        setMutatingItemId(null);
      }
    },
    [sourceSummary],
  );

  const deleteItem = useCallback(
    async (projectId: string, itemId: string) => {
      setMutatingItemId(itemId);
      setMutationError(null);
      const requestSummary = sourceSummary;
      try {
        const response = await api.deleteProjectQueueItem(projectId, itemId);
        requestSummary.reportProjectQueueCollectionSnapshot(response.queue);
      } catch (err) {
        setMutationError(err instanceof Error ? err : new Error(String(err)));
        throw err;
      } finally {
        setMutatingItemId(null);
      }
    },
    [sourceSummary],
  );

  const retryItem = useCallback(
    async (projectId: string, itemId: string) => {
      setMutatingItemId(itemId);
      setMutationError(null);
      const requestSummary = sourceSummary;
      try {
        const response = await api.retryProjectQueueItem(projectId, itemId);
        requestSummary.reportProjectQueueCollectionSnapshot(response.queue);
      } catch (err) {
        setMutationError(err instanceof Error ? err : new Error(String(err)));
        throw err;
      } finally {
        setMutatingItemId(null);
      }
    },
    [sourceSummary],
  );

  const moveItemToTop = useCallback(
    async (projectId: string, itemId: string) => {
      setMutatingItemId(itemId);
      setMutationError(null);
      const requestSummary = sourceSummary;
      try {
        const response = await api.moveProjectQueueItemToTop(projectId, itemId);
        requestSummary.reportProjectQueueCollectionSnapshot(response.queue);
      } catch (err) {
        setMutationError(err instanceof Error ? err : new Error(String(err)));
        throw err;
      } finally {
        setMutatingItemId(null);
      }
    },
    [sourceSummary],
  );

  const refetchQueuesWithSettlement = useCallback(() => {
    setMutationError(null);
    return refetch();
  }, [refetch]);
  const refetchQueues = useCallback(async () => {
    await refetchQueuesWithSettlement();
  }, [refetchQueuesWithSettlement]);

  const mutateRecoveredItem = useCallback(
    async (sessionId: string, queueId: string, action: "resume" | "delete") => {
      if (mutatingRecoveredQueueIdRef.current) return;
      mutatingRecoveredQueueIdRef.current = queueId;
      setMutatingRecoveredQueueId(queueId);
      setMutationError(null);
      try {
        if (action === "resume") {
          await api.resumeRecoveredQueuedMessage(sessionId, queueId);
        } else {
          await api.deleteRecoveredQueuedMessage(sessionId, queueId);
        }
        invalidateClientQuery(sourceKey, PROJECT_QUEUE_QUERY_KEY);
        await refetchQueuesWithSettlement();
      } catch (err) {
        setMutationError(err instanceof Error ? err : new Error(String(err)));
        throw err;
      } finally {
        mutatingRecoveredQueueIdRef.current = null;
        setMutatingRecoveredQueueId(null);
      }
    },
    [refetchQueuesWithSettlement, sourceKey],
  );

  const resumeRecoveredItem = useCallback(
    (sessionId: string, queueId: string) =>
      mutateRecoveredItem(sessionId, queueId, "resume"),
    [mutateRecoveredItem],
  );

  const deleteRecoveredItem = useCallback(
    (sessionId: string, queueId: string) =>
      mutateRecoveredItem(sessionId, queueId, "delete"),
    [mutateRecoveredItem],
  );

  const pauseDispatch = useCallback(async () => {
    setMutatingDispatchState(true);
    setMutationError(null);
    const requestSummary = sourceSummary;
    try {
      const response = await api.pauseProjectQueueDispatch();
      requestSummary.reportProjectQueueGlobalCollectionSnapshot(response);
    } catch (err) {
      setMutationError(err instanceof Error ? err : new Error(String(err)));
      throw err;
    } finally {
      setMutatingDispatchState(false);
    }
  }, [sourceSummary]);

  const resumeDispatch = useCallback(async () => {
    setMutatingDispatchState(true);
    setMutationError(null);
    const requestSummary = sourceSummary;
    try {
      const response = await api.resumeProjectQueueDispatch();
      requestSummary.reportProjectQueueGlobalCollectionSnapshot(response);
    } catch (err) {
      setMutationError(err instanceof Error ? err : new Error(String(err)));
      throw err;
    } finally {
      setMutatingDispatchState(false);
    }
  }, [sourceSummary]);

  const promoteNow = useCallback(
    async (
      projectId: string,
      itemId: string,
      options: { force?: boolean; deliveryIntent?: "steer" } = {},
    ) => {
      setMutatingPromoteItemId(itemId);
      setMutationError(null);
      const requestSummary = sourceSummary;
      try {
        const response = await api.promoteProjectQueueNow(projectId, {
          itemId,
          ...(options.force ? { force: true } : {}),
          ...(options.deliveryIntent
            ? { deliveryIntent: options.deliveryIntent }
            : {}),
        });
        requestSummary.reportProjectQueueGlobalCollectionSnapshot(response);
        return response.promoteResult;
      } catch (err) {
        setMutationError(err instanceof Error ? err : new Error(String(err)));
        throw err;
      } finally {
        setMutatingPromoteItemId(null);
      }
    },
    [sourceSummary],
  );

  const items = useMemo(
    () =>
      storedGlobalItems.length > 0
        ? storedGlobalItems
        : flattenQueues(storedQueuesByProject),
    [storedGlobalItems, storedQueuesByProject],
  );
  const projectIdSet = useMemo(
    () => new Set(normalizedProjectIds),
    [normalizedProjectIds],
  );
  const recoveredSessionQueues = useMemo(
    () =>
      storedRecoveredSessionQueues.filter((item) =>
        projectIdSet.has(item.projectId),
      ),
    [projectIdSet, storedRecoveredSessionQueues],
  );

  const hasBacklog = items.length > 0 || recoveredSessionQueues.length > 0;
  const deadline = useMemo(
    () =>
      hasBacklog
        ? readProjectQueueDeadline(
            storedProjectStatusesByProject,
            normalizedProjectIds,
          )
        : NO_PROJECT_QUEUE_DEADLINE,
    [hasBacklog, normalizedProjectIds, storedProjectStatusesByProject],
  );

  const backstopRef = useRef<ProjectQueueBackstopHandle | null>(null);
  useEffect(() => {
    const handle = retainProjectQueueBackstop(sourceKey);
    backstopRef.current = handle;
    return () => {
      if (backstopRef.current === handle) {
        backstopRef.current = null;
      }
      handle.release();
    };
  }, [sourceKey]);

  useEffect(() => {
    backstopRef.current?.update(deadline, refetchQueuesWithSettlement);
  }, [deadline, refetchQueuesWithSettlement]);

  return {
    queuesByProject: storedQueuesByProject,
    items,
    projectStatusesByProject: storedProjectStatusesByProject,
    recoveredSessionQueues,
    loading,
    error: mutationError ?? queryError,
    mutatingItemId,
    mutatingRecoveredQueueId,
    mutatingDispatchState,
    mutatingPromoteItemId,
    dispatchState: storedDispatchState,
    refetch: refetchQueues,
    pauseDispatch,
    resumeDispatch,
    promoteNow,
    updateItem,
    deleteItem,
    resumeRecoveredItem,
    deleteRecoveredItem,
    retryItem,
    moveItemToTop,
  };
}
