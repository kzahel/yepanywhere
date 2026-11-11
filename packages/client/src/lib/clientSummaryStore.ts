import type {
  ProjectQueueChangedEvent,
  ProjectQueueItemSummary,
  SessionMetadataPayload,
} from "@yep-anywhere/shared";
import { useEffect, useMemo } from "react";
import { useStore } from "zustand";
import { useShallow } from "zustand/react/shallow";
import { createStore, type StoreApi } from "zustand/vanilla";
import {
  activityBus,
  type ActivityEventMap,
  type ActivityEventType,
  type ProcessStateEvent,
  type ProviderRuntimeStatusChangedEvent,
  type SessionCreatedEvent,
  type SessionIdRemappedEvent,
  type SessionMetadataChangedEvent,
  type SessionSeenEvent,
  type SessionStatusEvent,
  type SessionUpdatedEvent,
} from "./activityBus";
import {
  applyDraftSessionIdsSnapshot,
  applyGlobalSessionsCollectionSnapshot,
  applyInboxCollectionSnapshot,
  applyProjectCollectionSnapshot,
  applyProviderRuntimeStatusChanged,
  applyProviderRuntimeStatusFromSessionSnapshot,
  applyProjectsCollectionSnapshot,
  applyProjectQueueCollectionChanged,
  applyProjectQueueCollectionSnapshot,
  applyProjectQueueGlobalCollectionSnapshot,
  applySessionCollectionCreated,
  applySessionCollectionIdRemapped,
  applySessionCollectionMetadataChanged,
  applySessionCollectionProcessStateChanged,
  applySessionCollectionSeen,
  applySessionCollectionStatusChanged,
  applySessionCollectionTitleSnapshot,
  applySessionCollectionUpdated,
  createEmptyClientSummaryState,
} from "./clientSummaryState";
import {
  createGlobalSessionsQueryKey,
  selectActiveAgentCount,
  selectActiveProjectSessionIds,
  selectDraftSessionIds,
  selectHasActiveAgents,
  selectInboxCounts,
  selectInboxCountsByProject,
  selectInboxResponse,
  selectProjectCollectionRecord,
  selectProjectCollectionRecords,
  selectProviderRuntimeStatusForSession,
  selectProjectQueuedSessionIds,
  selectProjectQueueDispatchState,
  selectProjectQueueGlobalItems,
  selectProjectQueueSidebarCount,
  selectProjectQueueItemsByProject,
  selectProjectQueueProjectStatusesByProject,
  selectProjectQueueRecoveredSessionQueues,
  selectOlderSessionRecords,
  selectRecentSessionRecords,
  selectSessionCollectionQueryRecords,
  selectSessionCollectionQueryState,
  selectSessionCollectionRecord,
  selectCategorizedSessionRecords,
  selectStarredSessionRecords,
} from "./clientSummaryQueries";
import type {
  ClientSummaryState,
  GlobalSessionsCollectionSnapshot,
  InboxCollectionSnapshot,
  InboxCounts,
  ProjectCollectionRecord,
  ProjectCollectionSnapshot,
  ProjectQueueCollectionSnapshot,
  ProjectQueueCountSource,
  ProjectQueueGlobalCollectionSnapshot,
  ProjectsCollectionSnapshot,
  ProviderRuntimeStatusSnapshot,
  SessionCollectionQueryDescriptor,
  SessionCollectionQueryState,
  SessionCollectionRecord,
} from "./clientSummaryCollections";
import { ALL_PROJECTS_QUERY_KEY } from "./clientSummaryCollections";
import {
  type DraftPresenceChange,
  subscribeDraftPresenceChanges,
} from "./draftPresenceEvents";
import {
  isSessionDraftStorageKey,
  scanSessionDraftIds,
} from "./sessionDraftStorage";
import { useSourceRuntimeContextValue } from "./sourceRuntimeReact";
import type { SourceTransport } from "./transport";
import {
  type ClientSummarySourceKey,
  getCurrentClientSummarySourceKey,
  subscribeClientSummarySourceKey,
  useClientSummarySourceKey,
  resetClientSummarySourceKeyForTests,
} from "./clientSummarySourceKey";
export {
  type ClientSummarySourceKey,
  asClientSummarySourceKey,
  createClientSummaryHostSourceKey,
  createClientSummaryDirectSourceKey,
  LOCAL_CLIENT_SUMMARY_SOURCE_KEY,
  REMOTE_NONE_CLIENT_SUMMARY_SOURCE_KEY,
  getCurrentClientSummarySourceKey,
  subscribeClientSummarySourceKey,
  useClientSummarySourceKey,
  setCurrentClientSummarySourceKey,
} from "./clientSummarySourceKey";

type StoreListener = () => void;
type BusUnsubscribe = () => void;
type ReleaseSubscription = () => void;

const clientSummaryStoresBySource = new Map<
  ClientSummarySourceKey,
  StoreApi<ClientSummaryState>
>();
const activityBusSubscriptionsBySource = new Map<
  ClientSummarySourceKey,
  {
    retainCount: number;
    unsubscribers: BusUnsubscribe[];
  }
>();
const draftDecorationSubscriptionsBySource = new Map<
  ClientSummarySourceKey,
  {
    retainCount: number;
    release: ReleaseSubscription;
  }
>();

function createClientSummaryStore(): StoreApi<ClientSummaryState> {
  return createStore<ClientSummaryState>(() => createEmptyClientSummaryState());
}

export function getClientSummaryStoreForSource(
  key: ClientSummarySourceKey,
): StoreApi<ClientSummaryState> {
  let store = clientSummaryStoresBySource.get(key);
  if (!store) {
    store = createClientSummaryStore();
    clientSummaryStoresBySource.set(key, store);
  }
  return store;
}

function getCurrentClientSummaryStore(): StoreApi<ClientSummaryState> {
  return getClientSummaryStoreForSource(getCurrentClientSummarySourceKey());
}

function useCurrentClientSummaryStore(): StoreApi<ClientSummaryState> {
  const runtime = useSourceRuntimeContextValue();
  const sourceKey = useClientSummarySourceKey();
  return useMemo(
    () =>
      runtime?.summary.getStore() ?? getClientSummaryStoreForSource(sourceKey),
    [runtime, sourceKey],
  );
}

export function clearClientSummarySource(key: ClientSummarySourceKey): void {
  const store = clientSummaryStoresBySource.get(key);
  store?.setState(createEmptyClientSummaryState(), true);
}

function updateStoreSnapshot(
  store: StoreApi<ClientSummaryState>,
  update: (current: ClientSummaryState) => ClientSummaryState,
): void {
  const current = store.getState();
  const next = update(current);
  if (next !== current) {
    store.setState(next, true);
  }
}

function updateSourceSnapshot(
  sourceKey: ClientSummarySourceKey,
  update: (current: ClientSummaryState) => ClientSummaryState,
): void {
  updateStoreSnapshot(getClientSummaryStoreForSource(sourceKey), update);
}

function reduceProcessStateChanged(
  sourceKey: ClientSummarySourceKey,
  event: ProcessStateEvent,
): void {
  updateSourceSnapshot(sourceKey, (current) =>
    applySessionCollectionProcessStateChanged(current, event),
  );
}

function reduceSessionStatusChanged(
  sourceKey: ClientSummarySourceKey,
  event: SessionStatusEvent,
): void {
  updateSourceSnapshot(sourceKey, (current) =>
    applySessionCollectionStatusChanged(current, event),
  );
}

function reduceSessionSeen(
  sourceKey: ClientSummarySourceKey,
  event: SessionSeenEvent,
): void {
  updateSourceSnapshot(sourceKey, (current) =>
    applySessionCollectionSeen(current, event),
  );
}

function reduceSessionUpdated(
  sourceKey: ClientSummarySourceKey,
  event: SessionUpdatedEvent,
): void {
  updateSourceSnapshot(sourceKey, (current) =>
    applySessionCollectionUpdated(current, event),
  );
}

function reduceSessionMetadataChanged(
  sourceKey: ClientSummarySourceKey,
  event: SessionMetadataChangedEvent,
): void {
  updateSourceSnapshot(sourceKey, (current) =>
    applySessionCollectionMetadataChanged(current, event),
  );
}

function reduceSessionCreated(
  sourceKey: ClientSummarySourceKey,
  event: SessionCreatedEvent,
): void {
  updateSourceSnapshot(sourceKey, (current) =>
    applySessionCollectionCreated(current, event),
  );
}

function reduceSessionIdRemapped(
  sourceKey: ClientSummarySourceKey,
  event: SessionIdRemappedEvent,
): void {
  updateSourceSnapshot(sourceKey, (current) =>
    applySessionCollectionIdRemapped(current, event),
  );
}

function reduceProjectQueueChanged(
  sourceKey: ClientSummarySourceKey,
  event: ProjectQueueChangedEvent,
): void {
  updateSourceSnapshot(sourceKey, (current) =>
    applyProjectQueueCollectionChanged(current, event),
  );
}

function reduceProviderRuntimeStatusChanged(
  sourceKey: ClientSummarySourceKey,
  event: ProviderRuntimeStatusChangedEvent,
): void {
  updateSourceSnapshot(sourceKey, (current) =>
    applyProviderRuntimeStatusChanged(current, event),
  );
}

function onActivityBusSource<K extends ActivityEventType>(
  sourceKey: ClientSummarySourceKey,
  eventType: K,
  callback: (event: ActivityEventMap[K]) => void,
): BusUnsubscribe {
  return activityBus.onSource(sourceKey, eventType, callback);
}

function retainActivityBusSourceStream(
  sourceKey: ClientSummarySourceKey,
  transport: SourceTransport,
): ReleaseSubscription {
  return activityBus.retainSourceStream(sourceKey, transport);
}

function startActivityBusSubscription(
  sourceKey: ClientSummarySourceKey,
): BusUnsubscribe[] {
  return [
    onActivityBusSource(sourceKey, "process-state-changed", (event) =>
      reduceProcessStateChanged(sourceKey, event),
    ),
    onActivityBusSource(sourceKey, "provider-runtime-status-changed", (event) =>
      reduceProviderRuntimeStatusChanged(sourceKey, event),
    ),
    onActivityBusSource(sourceKey, "session-status-changed", (event) =>
      reduceSessionStatusChanged(sourceKey, event),
    ),
    onActivityBusSource(sourceKey, "session-seen", (event) =>
      reduceSessionSeen(sourceKey, event),
    ),
    onActivityBusSource(sourceKey, "session-updated", (event) =>
      reduceSessionUpdated(sourceKey, event),
    ),
    onActivityBusSource(sourceKey, "session-metadata-changed", (event) =>
      reduceSessionMetadataChanged(sourceKey, event),
    ),
    onActivityBusSource(sourceKey, "session-created", (event) =>
      reduceSessionCreated(sourceKey, event),
    ),
    onActivityBusSource(sourceKey, "session-id-remapped", (event) =>
      reduceSessionIdRemapped(sourceKey, event),
    ),
    onActivityBusSource(sourceKey, "project-queue-changed", (event) =>
      reduceProjectQueueChanged(sourceKey, event),
    ),
  ];
}

function retainActivityBusSubscription(
  sourceKey: ClientSummarySourceKey,
  transport?: SourceTransport,
): () => void {
  let record = activityBusSubscriptionsBySource.get(sourceKey);
  if (!record) {
    record = {
      retainCount: 0,
      unsubscribers: startActivityBusSubscription(sourceKey),
    };
    activityBusSubscriptionsBySource.set(sourceKey, record);
  }
  record.retainCount += 1;

  const releaseStream = transport
    ? retainActivityBusSourceStream(sourceKey, transport)
    : () => {};

  let released = false;
  return () => {
    if (released) return;
    released = true;
    releaseStream();
    const current = activityBusSubscriptionsBySource.get(sourceKey);
    if (!current) {
      return;
    }
    current.retainCount = Math.max(0, current.retainCount - 1);
    if (current.retainCount === 0) {
      for (const unsubscribe of current.unsubscribers) {
        unsubscribe();
      }
      activityBusSubscriptionsBySource.delete(sourceKey);
    }
  };
}

export function retainClientSummaryActivitySubscription(
  sourceKey: ClientSummarySourceKey,
  transport?: SourceTransport,
): ReleaseSubscription {
  return retainActivityBusSubscription(sourceKey, transport);
}

function useClientSummaryActivitySubscription(enabled = true): void {
  const runtime = useSourceRuntimeContextValue();
  const sourceKey = useClientSummarySourceKey();
  useEffect(
    () =>
      !enabled
        ? undefined
        : runtime
          ? runtime.summary.retainActivitySubscription()
          : retainClientSummaryActivitySubscription(sourceKey),
    [enabled, runtime, sourceKey],
  );
}

export function reportDraftSessionIdsSnapshot(
  sourceKey: ClientSummarySourceKey,
  draftSessionIds: ReadonlySet<string>,
  observedAt = Date.now(),
): void {
  updateSourceSnapshot(sourceKey, (current) =>
    applyDraftSessionIdsSnapshot(current, draftSessionIds, observedAt),
  );
}

export function reportProviderRuntimeStatusSnapshot(
  sourceKey: ClientSummarySourceKey,
  input: ProviderRuntimeStatusSnapshot,
  observedAt = Date.now(),
): void {
  updateSourceSnapshot(sourceKey, (current) =>
    applyProviderRuntimeStatusFromSessionSnapshot(current, input, observedAt),
  );
}

function scanDraftSessionIdsIntoStore(sourceKey: ClientSummarySourceKey): void {
  reportDraftSessionIdsSnapshot(sourceKey, scanSessionDraftIds(sourceKey));
}

function applyDraftPresenceChangeIntoStore(change: DraftPresenceChange): void {
  const sessionDraft = change.sessionDraft;
  if (!sessionDraft) {
    return;
  }
  updateSourceSnapshot(sessionDraft.sourceKey, (current) => {
    const previous = current.localDecorations.draftSessionIds;
    if (previous.has(sessionDraft.sessionId) === change.hasContent) {
      return current;
    }
    const next = new Set(previous);
    if (change.hasContent) {
      next.add(sessionDraft.sessionId);
    } else {
      next.delete(sessionDraft.sessionId);
    }
    return applyDraftSessionIdsSnapshot(current, next, Date.now());
  });
}

function startDraftDecorationSubscription(
  sourceKey: ClientSummarySourceKey,
): ReleaseSubscription {
  scanDraftSessionIdsIntoStore(sourceKey);

  if (typeof window === "undefined") {
    return () => {};
  }

  const handleStorage = (event: StorageEvent) => {
    if (isSessionDraftStorageKey(event.key)) {
      scanDraftSessionIdsIntoStore(sourceKey);
    }
  };

  window.addEventListener("storage", handleStorage);
  const unsubscribePresence = subscribeDraftPresenceChanges((change) => {
    if (change.sessionDraft?.sourceKey === sourceKey) {
      applyDraftPresenceChangeIntoStore(change);
    }
  });

  return () => {
    window.removeEventListener("storage", handleStorage);
    unsubscribePresence();
  };
}

function retainDraftDecorationSubscription(
  sourceKey: ClientSummarySourceKey,
): () => void {
  let record = draftDecorationSubscriptionsBySource.get(sourceKey);
  if (!record) {
    record = {
      retainCount: 0,
      release: startDraftDecorationSubscription(sourceKey),
    };
    draftDecorationSubscriptionsBySource.set(sourceKey, record);
  }
  record.retainCount += 1;

  let released = false;
  return () => {
    if (released) return;
    released = true;
    const current = draftDecorationSubscriptionsBySource.get(sourceKey);
    if (!current) {
      return;
    }
    current.retainCount = Math.max(0, current.retainCount - 1);
    if (current.retainCount === 0) {
      current.release();
      draftDecorationSubscriptionsBySource.delete(sourceKey);
    }
  };
}

export function retainClientSummaryDraftDecorations(
  sourceKey: ClientSummarySourceKey,
): ReleaseSubscription {
  return retainDraftDecorationSubscription(sourceKey);
}

function useDraftDecorationSubscription(): void {
  const runtime = useSourceRuntimeContextValue();
  const sourceKey = useClientSummarySourceKey();
  useEffect(
    () =>
      runtime
        ? runtime.summary.retainDraftDecorations()
        : retainClientSummaryDraftDecorations(sourceKey),
    [runtime, sourceKey],
  );
}

export function subscribeClientSummary(listener: StoreListener): () => void {
  let releaseActivityBus = retainActivityBusSubscription(
    getCurrentClientSummarySourceKey(),
  );
  let currentStore = getCurrentClientSummaryStore();
  let unsubscribeStore = currentStore.subscribe(() => listener());
  const unsubscribeSourceKey = subscribeClientSummarySourceKey(() => {
    releaseActivityBus();
    releaseActivityBus = retainActivityBusSubscription(
      getCurrentClientSummarySourceKey(),
    );
    unsubscribeStore();
    currentStore = getCurrentClientSummaryStore();
    unsubscribeStore = currentStore.subscribe(() => listener());
    listener();
  });

  return () => {
    unsubscribeSourceKey();
    unsubscribeStore();
    releaseActivityBus();
  };
}

export function getClientSummarySnapshotForSource(
  sourceKey: ClientSummarySourceKey,
): ClientSummaryState {
  return getClientSummaryStoreForSource(sourceKey).getState();
}

export function reportGlobalSessionsCollectionSnapshot(
  sourceKey: ClientSummarySourceKey,
  input: GlobalSessionsCollectionSnapshot,
  requestStartedAt = Date.now(),
): void {
  updateStoreSnapshot(getClientSummaryStoreForSource(sourceKey), (current) =>
    applyGlobalSessionsCollectionSnapshot(current, input, requestStartedAt),
  );
}

export function reportInboxCollectionSnapshot(
  sourceKey: ClientSummarySourceKey,
  input: InboxCollectionSnapshot,
  requestStartedAt = Date.now(),
): void {
  updateStoreSnapshot(getClientSummaryStoreForSource(sourceKey), (current) =>
    applyInboxCollectionSnapshot(current, input, requestStartedAt),
  );
}

export function reportProjectsCollectionSnapshot(
  sourceKey: ClientSummarySourceKey,
  input: ProjectsCollectionSnapshot,
  requestStartedAt = Date.now(),
): void {
  updateStoreSnapshot(getClientSummaryStoreForSource(sourceKey), (current) =>
    applyProjectsCollectionSnapshot(current, input, requestStartedAt),
  );
}

export function reportProjectCollectionSnapshot(
  sourceKey: ClientSummarySourceKey,
  input: ProjectCollectionSnapshot,
  requestStartedAt = Date.now(),
): void {
  updateStoreSnapshot(getClientSummaryStoreForSource(sourceKey), (current) =>
    applyProjectCollectionSnapshot(current, input, requestStartedAt),
  );
}

export function reportProjectQueueCollectionSnapshot(
  sourceKey: ClientSummarySourceKey,
  input: ProjectQueueCollectionSnapshot,
  requestStartedAt = Date.now(),
): void {
  updateStoreSnapshot(getClientSummaryStoreForSource(sourceKey), (current) =>
    applyProjectQueueCollectionSnapshot(current, input, requestStartedAt),
  );
}

export function reportProjectQueueGlobalCollectionSnapshot(
  sourceKey: ClientSummarySourceKey,
  input: ProjectQueueGlobalCollectionSnapshot,
  requestStartedAt = Date.now(),
): void {
  updateStoreSnapshot(getClientSummaryStoreForSource(sourceKey), (current) =>
    applyProjectQueueGlobalCollectionSnapshot(current, input, requestStartedAt),
  );
}

export function reportSessionCollectionTitleSnapshot(
  sourceKey: ClientSummarySourceKey,
  session: SessionMetadataPayload,
  observedAt = Date.now(),
): void {
  updateSourceSnapshot(sourceKey, (current) =>
    applySessionCollectionTitleSnapshot(current, session, observedAt),
  );
}

export function reportSessionCollectionCreated(
  sourceKey: ClientSummarySourceKey,
  event: SessionCreatedEvent,
  observedAt = Date.now(),
): void {
  updateSourceSnapshot(sourceKey, (current) =>
    applySessionCollectionCreated(current, event, observedAt),
  );
}

export function reportSessionCollectionMetadataChanged(
  sourceKey: ClientSummarySourceKey,
  event: SessionMetadataChangedEvent,
  observedAt = Date.now(),
): void {
  updateSourceSnapshot(sourceKey, (current) =>
    applySessionCollectionMetadataChanged(current, event, observedAt),
  );
}

export function useClientSummaryState(
  retainActivity = true,
): ClientSummaryState {
  useClientSummaryActivitySubscription(retainActivity);
  const store = useCurrentClientSummaryStore();
  return useStore(store);
}

export function useSessionCollectionRecord(
  sessionId: string | null | undefined,
): SessionCollectionRecord | undefined {
  useClientSummaryActivitySubscription();
  const store = useCurrentClientSummaryStore();
  return useStore(store, (state) =>
    selectSessionCollectionRecord(state, sessionId),
  );
}

/** Observe the row decoration, independently of collection freshness clocks. */
export function useSessionNonHumanUserTurn(sessionId: string) {
  useClientSummaryActivitySubscription();
  const store = useCurrentClientSummaryStore();
  return useStore(
    store,
    useShallow(
      (state: ClientSummaryState) =>
        selectSessionCollectionRecord(state, sessionId)?.nonHumanUserTurn,
    ),
  );
}

export function useProviderRuntimeStatusForSession(
  sessionId: string | null | undefined,
) {
  useClientSummaryActivitySubscription();
  const store = useCurrentClientSummaryStore();
  return useStore(store, (state) =>
    selectProviderRuntimeStatusForSession(state, sessionId),
  );
}

export function useProjectCollectionRecord(
  projectId: string | null | undefined,
): ProjectCollectionRecord | undefined {
  useClientSummaryActivitySubscription();
  const store = useCurrentClientSummaryStore();
  return useStore(store, (state) =>
    selectProjectCollectionRecord(state, projectId),
  );
}

export function useProjectCollectionRecords(): ProjectCollectionRecord[] {
  useClientSummaryActivitySubscription();
  const store = useCurrentClientSummaryStore();
  const projects = useStore(store, (state) => state.projects);
  return useMemo(
    () => selectProjectCollectionRecords({ projects }),
    [projects],
  );
}

export function useProjectCollectionCatalog() {
  const store = useCurrentClientSummaryStore();
  return useStore(
    store,
    (state) => state.projects.queries.get(ALL_PROJECTS_QUERY_KEY)?.catalog,
  );
}

export function useProjectQueueItemsByProject(
  projectIds: readonly string[],
): Record<string, readonly ProjectQueueItemSummary[]> {
  useClientSummaryActivitySubscription();
  const store = useCurrentClientSummaryStore();
  const byProject = useStore(store, (state) => state.projectQueues.byProject);
  const projectIdsKey = projectIds.join("\0");
  const selectedProjectIds = useMemo(
    () => (projectIdsKey ? projectIdsKey.split("\0") : []),
    [projectIdsKey],
  );
  return useMemo(() => {
    const state = store.getState();
    return selectProjectQueueItemsByProject(
      {
        ...state,
        projectQueues: { ...state.projectQueues, byProject },
      },
      selectedProjectIds,
    );
  }, [store, byProject, selectedProjectIds]);
}

export function useProjectQueueGlobalItems(
  projectIds: readonly string[],
): readonly ProjectQueueItemSummary[] {
  useClientSummaryActivitySubscription();
  const store = useCurrentClientSummaryStore();
  const projectQueues = useStore(store, (state) => state.projectQueues);
  const projectIdsKey = projectIds.join("\0");
  const selectedProjectIds = useMemo(
    () => (projectIdsKey ? projectIdsKey.split("\0") : []),
    [projectIdsKey],
  );
  return useMemo(
    () =>
      selectProjectQueueGlobalItems(
        {
          ...store.getState(),
          projectQueues,
        },
        selectedProjectIds,
      ),
    [store, projectQueues, selectedProjectIds],
  );
}

export function useProjectQueueDispatchState() {
  useClientSummaryActivitySubscription();
  const store = useCurrentClientSummaryStore();
  return useStore(store, selectProjectQueueDispatchState);
}

export function useProjectQueueRecoveredSessionQueues() {
  useClientSummaryActivitySubscription();
  const store = useCurrentClientSummaryStore();
  return useStore(store, selectProjectQueueRecoveredSessionQueues);
}

export function useProjectQueueProjectStatusesByProject() {
  useClientSummaryActivitySubscription();
  const store = useCurrentClientSummaryStore();
  const projectStatusesByProject = useStore(
    store,
    (state) => state.projectQueues.projectStatusesByProject,
  );
  return useMemo(() => {
    const state = store.getState();
    return selectProjectQueueProjectStatusesByProject({
      ...state,
      projectQueues: {
        ...state.projectQueues,
        projectStatusesByProject,
      },
    });
  }, [store, projectStatusesByProject]);
}

export function useProjectQueueSidebarCount(
  projects: readonly ProjectQueueCountSource[],
): number {
  useClientSummaryActivitySubscription();
  const store = useCurrentClientSummaryStore();
  const byProject = useStore(store, (state) => state.projectQueues.byProject);
  const projectsKey = projects
    .map(
      (project) =>
        `${project.id}:${project.projectQueueCount ?? 0}:${
          project.snapshotObservedAt ?? ""
        }`,
    )
    .join("\0");
  const selectedProjects = useMemo(() => {
    void projectsKey;
    return projects.map((project) => ({
      id: project.id,
      projectQueueCount: project.projectQueueCount,
      snapshotObservedAt: project.snapshotObservedAt,
    }));
  }, [projects, projectsKey]);
  return useMemo(() => {
    const state = store.getState();
    return selectProjectQueueSidebarCount(
      {
        ...state,
        projectQueues: { ...state.projectQueues, byProject },
      },
      selectedProjects,
    );
  }, [store, byProject, selectedProjects]);
}

export function useKnownProjectQueueItems(): readonly ProjectQueueItemSummary[] {
  useClientSummaryActivitySubscription();
  const store = useCurrentClientSummaryStore();
  const byProject = useStore(store, (state) => state.projectQueues.byProject);
  return useMemo(
    () =>
      [...byProject.values()]
        .flatMap((record) => record.items)
        .sort((a, b) => {
          const created = a.createdAt.localeCompare(b.createdAt);
          return created !== 0 ? created : a.id.localeCompare(b.id);
        }),
    [byProject],
  );
}

export function useProjectQueuedSessionIds(
  projectIds: readonly string[],
): ReadonlySet<string> {
  useClientSummaryActivitySubscription();
  const store = useCurrentClientSummaryStore();
  const byProject = useStore(store, (state) => state.projectQueues.byProject);
  const projectIdsKey = projectIds.join("\0");
  const selectedProjectIds = useMemo(
    () => (projectIdsKey ? projectIdsKey.split("\0") : []),
    [projectIdsKey],
  );
  return useMemo(() => {
    const state = store.getState();
    return selectProjectQueuedSessionIds(
      {
        ...state,
        projectQueues: { ...state.projectQueues, byProject },
      },
      selectedProjectIds,
    );
  }, [store, byProject, selectedProjectIds]);
}

export function useDraftSessionIds(): ReadonlySet<string> {
  useDraftDecorationSubscription();
  const store = useCurrentClientSummaryStore();
  return useStore(store, selectDraftSessionIds);
}

export function useInboxResponseSnapshot(): InboxCollectionSnapshot {
  const state = useClientSummaryState();
  return useMemo(() => selectInboxResponse(state), [state]);
}

export function useInboxCounts(): InboxCounts {
  useClientSummaryActivitySubscription();
  const store = useCurrentClientSummaryStore();
  const needsAttention = useStore(
    store,
    (state) => state.inbox.tiers.needsAttention.length,
  );
  const active = useStore(store, (state) => state.inbox.tiers.active.length);
  const total = useStore(store, (state) => selectInboxCounts(state).total);
  return useMemo(
    () => ({ needsAttention, active, total }),
    [needsAttention, active, total],
  );
}

export function useInboxCountsByProject(): ReadonlyMap<string, InboxCounts> {
  useClientSummaryActivitySubscription();
  const store = useCurrentClientSummaryStore();
  const tiers = useStore(store, (state) => state.inbox.tiers);
  const entities = useStore(store, (state) => state.sessions.entities);
  return useMemo(() => {
    const state = store.getState();
    return selectInboxCountsByProject({
      ...state,
      sessions: { ...state.sessions, entities },
      inbox: { ...state.inbox, tiers },
    });
  }, [store, tiers, entities]);
}

export function useActiveProjectSessionIds(
  projectId: string | null | undefined,
): readonly string[] {
  useClientSummaryActivitySubscription();
  const store = useCurrentClientSummaryStore();
  const tiers = useStore(store, (state) => state.inbox.tiers);
  const entities = useStore(store, (state) => state.sessions.entities);
  return useMemo(() => {
    const state = store.getState();
    return selectActiveProjectSessionIds(
      {
        ...state,
        sessions: { ...state.sessions, entities },
        inbox: { ...state.inbox, tiers },
      },
      projectId,
    );
  }, [store, tiers, entities, projectId]);
}

export function useActiveAgentCount(): number {
  useClientSummaryActivitySubscription();
  const store = useCurrentClientSummaryStore();
  return useStore(store, selectActiveAgentCount);
}

export function useHasActiveAgents(): boolean {
  useClientSummaryActivitySubscription();
  const store = useCurrentClientSummaryStore();
  return useStore(store, selectHasActiveAgents);
}

export function useStarredSessionRecords(
  query?: SessionCollectionQueryDescriptor,
): SessionCollectionRecord[] {
  const state = useClientSummaryState();
  return useMemo(
    () =>
      query
        ? selectSessionCollectionQueryRecords(state, query).filter(
            (row) => row.isStarred && !row.isArchived,
          )
        : selectStarredSessionRecords(state),
    [state, query],
  );
}

export function useCategorizedSessionRecords(
  query?: SessionCollectionQueryDescriptor,
): SessionCollectionRecord[] {
  const state = useClientSummaryState();
  return useMemo(
    () =>
      query
        ? selectSessionCollectionQueryRecords(state, query).filter(
            (row) => row.sidebarCategory && !row.isArchived,
          )
        : selectCategorizedSessionRecords(state),
    [state, query],
  );
}

export function useRecentSessionRecords(
  now?: number,
): SessionCollectionRecord[] {
  const state = useClientSummaryState();
  return useMemo(() => selectRecentSessionRecords(state, now), [state, now]);
}

export function useOlderSessionRecords(
  now?: number,
): SessionCollectionRecord[] {
  const state = useClientSummaryState();
  return useMemo(() => selectOlderSessionRecords(state, now), [state, now]);
}

export function useSessionCollectionQueryRecords(
  query: SessionCollectionQueryDescriptor,
  retainActivity = true,
): SessionCollectionRecord[] {
  const state = useClientSummaryState(retainActivity);
  const key = createGlobalSessionsQueryKey(query);
  return useMemo(() => {
    void key;
    return selectSessionCollectionQueryRecords(state, query);
  }, [state, key, query]);
}

export function useSessionCollectionQueryState(
  query: SessionCollectionQueryDescriptor,
  retainActivity = true,
): SessionCollectionQueryState | undefined {
  useClientSummaryActivitySubscription(retainActivity);
  const store = useCurrentClientSummaryStore();
  return useStore(store, (state) =>
    selectSessionCollectionQueryState(state, query),
  );
}

export function resetClientSummaryStoreForTests(): void {
  for (const store of clientSummaryStoresBySource.values()) {
    store.setState(createEmptyClientSummaryState(), true);
  }
  clientSummaryStoresBySource.clear();
  resetClientSummarySourceKeyForTests();
  for (const record of activityBusSubscriptionsBySource.values()) {
    for (const unsubscribe of record.unsubscribers) {
      unsubscribe();
    }
  }
  activityBusSubscriptionsBySource.clear();
  for (const record of draftDecorationSubscriptionsBySource.values()) {
    record.release();
  }
  draftDecorationSubscriptionsBySource.clear();
}
