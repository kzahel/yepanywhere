import type {
  AgentActivity,
  ProjectQueueDispatchState,
  ProjectQueueItemSummary,
  ProjectQueueProjectStatus,
  ProjectQueueRecoveredSessionQueueSummary,
  ProviderRuntimeStatus,
  UrlProjectId,
} from "@yep-anywhere/shared";
import type { InboxItem, InboxResponse } from "../api/client";
import {
  ALL_PROJECTS_QUERY_KEY,
  EMPTY_PROJECT_QUEUE_ITEMS,
  type ClientSummaryState,
  type InboxCounts,
  type ProjectCollectionRecord,
  type ProjectQueueCountSource,
  type SessionCollectionQueryDescriptor,
  type SessionCollectionQueryState,
  type SessionCollectionRecord,
  resolveSessionCollectionId,
} from "./clientSummaryCollections";
import { INBOX_TIERS, type InboxTier } from "./inboxTiers";

const ACTIVE_INBOX_TIERS: readonly InboxTier[] = ["needsAttention", "active"];

export function createGlobalSessionsCollectionQueryDescriptor(options: {
  projectId?: string | null;
  searchQuery?: string;
  limit?: number;
  includeArchived?: boolean;
  starred?: boolean;
  categorized?: boolean;
}): SessionCollectionQueryDescriptor {
  return {
    scope: "global-sessions",
    projectId: options.projectId ?? null,
    searchQuery: options.searchQuery || undefined,
    limit: options.limit,
    includeArchived: options.includeArchived,
    starred: options.starred,
    ...(options.categorized ? { categorized: true } : {}),
  };
}

export function createGlobalSessionsQueryKey(
  descriptor: SessionCollectionQueryDescriptor,
): string {
  const normalized = {
    scope: descriptor.scope,
    projectId: descriptor.projectId ?? null,
    searchQuery: descriptor.searchQuery?.trim() || null,
    limit: descriptor.limit ?? null,
    includeArchived: descriptor.includeArchived === true,
    starred: descriptor.starred === true,
    // Only present when set, so every pre-existing query keeps its key.
    ...(descriptor.categorized ? { categorized: true } : {}),
  };
  return JSON.stringify(normalized);
}

export function isActiveActivity(activity: AgentActivity | undefined): boolean {
  return activity === "in-turn" || activity === "waiting-input";
}

export function selectSessionCollectionRecord(
  state: ClientSummaryState,
  sessionId: string | null | undefined,
): SessionCollectionRecord | undefined {
  return sessionId
    ? state.sessions.entities.get(resolveSessionCollectionId(state, sessionId))
    : undefined;
}

export function selectProviderRuntimeStatusForSession(
  state: ClientSummaryState,
  sessionId: string | null | undefined,
): ProviderRuntimeStatus {
  if (!sessionId) {
    return null;
  }
  const resolvedSessionId = resolveSessionCollectionId(state, sessionId);
  return (
    state.providerRuntime.bySessionId.get(resolvedSessionId)?.status ?? null
  );
}

export function selectSessionCollectionQueryState(
  state: ClientSummaryState,
  query: SessionCollectionQueryDescriptor,
): SessionCollectionQueryState | undefined {
  return state.sessions.queries.get(createGlobalSessionsQueryKey(query));
}

export function selectProjectCollectionRecord(
  state: ClientSummaryState,
  projectId: string | null | undefined,
): ProjectCollectionRecord | undefined {
  return projectId ? state.projects.entities.get(projectId) : undefined;
}

export function selectProjectCollectionRecords(
  state: Pick<ClientSummaryState, "projects">,
): ProjectCollectionRecord[] {
  const queryState = state.projects.queries.get(ALL_PROJECTS_QUERY_KEY);
  if (!queryState) {
    return [];
  }

  return queryState.ids.flatMap((id) => {
    const record = state.projects.entities.get(id);
    return record ? [record] : [];
  });
}

export function selectProjectQueueItems(
  state: ClientSummaryState,
  projectId: string | null | undefined,
): readonly ProjectQueueItemSummary[] {
  return projectId
    ? (state.projectQueues.byProject.get(projectId)?.items ??
        EMPTY_PROJECT_QUEUE_ITEMS)
    : EMPTY_PROJECT_QUEUE_ITEMS;
}

export function selectProjectQueueItemsByProject(
  state: ClientSummaryState,
  projectIds: readonly string[],
): Record<string, readonly ProjectQueueItemSummary[]> {
  const result: Record<string, readonly ProjectQueueItemSummary[]> = {};
  for (const projectId of projectIds) {
    const record = state.projectQueues.byProject.get(projectId);
    if (record) {
      result[projectId] = record.items;
    }
  }
  return result;
}

export function selectProjectQueueGlobalItems(
  state: ClientSummaryState,
  projectIds: readonly string[],
): readonly ProjectQueueItemSummary[] {
  const selectedProjectIds = new Set(projectIds);
  const source =
    state.projectQueues.globalItemsObservedAt !== undefined
      ? state.projectQueues.globalItems
      : [...state.projectQueues.byProject.values()].flatMap(
          (record) => record.items,
        );
  return source.filter((item) => selectedProjectIds.has(item.projectId));
}

export function selectProjectQueueDispatchState(
  state: ClientSummaryState,
): ProjectQueueDispatchState {
  return state.projectQueues.dispatchState;
}

export function selectProjectQueueRecoveredSessionQueues(
  state: ClientSummaryState,
): readonly ProjectQueueRecoveredSessionQueueSummary[] {
  return state.projectQueues.recoveredSessionQueues;
}

export function selectProjectQueueProjectStatusesByProject(
  state: ClientSummaryState,
): Record<string, ProjectQueueProjectStatus> {
  const result: Record<string, ProjectQueueProjectStatus> = {};
  for (const [projectId, record] of state.projectQueues
    .projectStatusesByProject) {
    result[projectId] = record.status;
  }
  return result;
}

function countVisibleProjectQueueItems(
  items: readonly ProjectQueueItemSummary[],
): number {
  return items.filter(
    (item) => item.status === "queued" || item.status === "failed",
  ).length;
}

export function selectProjectQueueSidebarCount(
  state: ClientSummaryState,
  projects: readonly ProjectQueueCountSource[],
): number {
  const projectIds = new Set<string>();
  let total = 0;

  for (const project of projects) {
    projectIds.add(project.id);
    const queueRecord = state.projectQueues.byProject.get(project.id);
    const projectObservedAt =
      project.snapshotObservedAt ?? Number.NEGATIVE_INFINITY;

    if (queueRecord && queueRecord.observedAt >= projectObservedAt) {
      total += countVisibleProjectQueueItems(queueRecord.items);
    } else {
      total += project.projectQueueCount ?? 0;
    }
  }

  for (const [projectId, queueRecord] of state.projectQueues.byProject) {
    if (!projectIds.has(projectId)) {
      total += countVisibleProjectQueueItems(queueRecord.items);
    }
  }

  return total;
}

export function selectProjectQueuedSessionIds(
  state: ClientSummaryState,
  projectIds: readonly string[],
): ReadonlySet<string> {
  const sessionIds = new Set<string>();
  for (const projectId of projectIds) {
    const items = selectProjectQueueItems(state, projectId);
    for (const item of items) {
      if (item.target.type === "existing-session") {
        sessionIds.add(item.target.sessionId);
      }
    }
  }
  return sessionIds;
}

export function selectDraftSessionIds(
  state: ClientSummaryState,
): ReadonlySet<string> {
  return state.localDecorations.draftSessionIds;
}

function sessionRecordToInboxItem(
  record: SessionCollectionRecord,
): InboxItem | null {
  if (!record.projectId || !record.updatedAt) {
    return null;
  }
  return {
    sessionId: record.id,
    projectId: record.projectId,
    projectName: record.projectName ?? "",
    sessionTitle: record.title ?? null,
    creationProvenance: record.creationProvenance,
    updatedAt: record.updatedAt,
    customTitle: record.customTitle,
    isStarred: record.isStarred,
    pendingInputType: record.pendingInputType,
    activity: record.activity,
    activityInferredFromInboxTier: record.activityInferredFromInboxTier,
    hasUnread: record.hasUnread,
    asyncQuestions: record.asyncQuestions,
    nonHumanUserTurn: record.nonHumanUserTurn,
  };
}

export function selectInboxTierItems(
  state: ClientSummaryState,
  tier: InboxTier,
): InboxItem[] {
  return state.inbox.tiers[tier].flatMap((sessionId) => {
    const record = state.sessions.entities.get(sessionId);
    if (!record) {
      return [];
    }
    const item = sessionRecordToInboxItem(record);
    const details = state.inbox.rowDetails?.get(sessionId);
    return item
      ? [
          {
            ...item,
            providerPhase: details?.providerPhase,
            modelConfig: details?.modelConfig,
          },
        ]
      : [];
  });
}

export function selectInboxResponse(state: ClientSummaryState): InboxResponse {
  return {
    ...(state.inbox.catalog ? { catalog: state.inbox.catalog } : {}),
    needsAttention: selectInboxTierItems(state, "needsAttention"),
    active: selectInboxTierItems(state, "active"),
    recentActivity: selectInboxTierItems(state, "recentActivity"),
    unread8h: selectInboxTierItems(state, "unread8h"),
    unread24h: selectInboxTierItems(state, "unread24h"),
  };
}

export function selectInboxCounts(state: ClientSummaryState): InboxCounts {
  return {
    needsAttention: state.inbox.tiers.needsAttention.length,
    active: state.inbox.tiers.active.length,
    total: INBOX_TIERS.reduce(
      (total, tier) => total + state.inbox.tiers[tier].length,
      0,
    ),
  };
}

function incrementInboxProjectCount(
  countsByProject: Map<string, InboxCounts>,
  projectId: string,
  tier: InboxTier,
): void {
  const current =
    countsByProject.get(projectId) ??
    ({
      needsAttention: 0,
      active: 0,
      total: 0,
    } satisfies InboxCounts);

  countsByProject.set(projectId, {
    needsAttention:
      current.needsAttention + (tier === "needsAttention" ? 1 : 0),
    active: current.active + (tier === "active" ? 1 : 0),
    total: current.total + 1,
  });
}

export function selectInboxCountsByProject(
  state: ClientSummaryState,
): ReadonlyMap<string, InboxCounts> {
  const countsByProject = new Map<string, InboxCounts>();
  for (const tier of INBOX_TIERS) {
    for (const sessionId of state.inbox.tiers[tier]) {
      const projectId = state.sessions.entities.get(sessionId)?.projectId;
      if (projectId) {
        incrementInboxProjectCount(countsByProject, projectId, tier);
      }
    }
  }
  return countsByProject;
}

export function selectActiveProjectSessionIds(
  state: ClientSummaryState,
  projectId: string | null | undefined,
): string[] {
  if (!projectId) {
    return [];
  }

  const sessionIds: string[] = [];
  for (const tier of ACTIVE_INBOX_TIERS) {
    for (const sessionId of state.inbox.tiers[tier]) {
      const record = state.sessions.entities.get(sessionId);
      if (record?.projectId === projectId) {
        sessionIds.push(sessionId);
      }
    }
  }
  return sessionIds;
}

export function selectActiveAgentCount(state: ClientSummaryState): number {
  return state.inbox.tiers.active.length;
}

export function selectHasActiveAgents(state: ClientSummaryState): boolean {
  return selectActiveAgentCount(state) > 0;
}

function updatedAtMs(record: SessionCollectionRecord): number {
  return record.updatedAt ? Date.parse(record.updatedAt) || 0 : 0;
}

function byUpdatedAtDesc(
  a: SessionCollectionRecord,
  b: SessionCollectionRecord,
): number {
  return updatedAtMs(b) - updatedAtMs(a);
}

function activeStartedAtMs(record: SessionCollectionRecord): number {
  return record.activeStartedAt ?? record.eventCreatedAt ?? record.observedAt;
}

function byActiveStartedAtAsc(
  a: SessionCollectionRecord,
  b: SessionCollectionRecord,
): number {
  return activeStartedAtMs(a) - activeStartedAtMs(b);
}

function orderActiveFirst(records: SessionCollectionRecord[]) {
  const active = records
    .filter((record) => isActiveActivity(record.activity))
    .sort(byActiveStartedAtAsc);
  const idle = records
    .filter((record) => !isActiveActivity(record.activity))
    .sort(byUpdatedAtDesc);

  return [...active, ...idle];
}

export function selectStarredSessionRecords(
  state: ClientSummaryState,
): SessionCollectionRecord[] {
  return selectStarredSessionRecordsFromRecords(
    Array.from(state.sessions.entities.values()),
  );
}

/** Every loaded, unarchived session filed under a sidebar category. */
export function selectCategorizedSessionRecords(
  state: ClientSummaryState,
): SessionCollectionRecord[] {
  return Array.from(state.sessions.entities.values()).filter(
    (record) => Boolean(record.sidebarCategory) && record.isArchived !== true,
  );
}

export function selectStarredSessionRecordsFromRecords(
  records: readonly SessionCollectionRecord[],
): SessionCollectionRecord[] {
  return orderActiveFirst(
    records.filter(
      (record) => record.isStarred === true && record.isArchived !== true,
    ),
  );
}

export function selectRecentSessionRecords(
  state: ClientSummaryState,
  now = Date.now(),
): SessionCollectionRecord[] {
  return selectRecentSessionRecordsFromRecords(
    Array.from(state.sessions.entities.values()),
    now,
  );
}

export function selectRecentSessionRecordsFromRecords(
  records: readonly SessionCollectionRecord[],
  now = Date.now(),
): SessionCollectionRecord[] {
  const oneDayAgo = now - 24 * 60 * 60 * 1000;
  const filtered = records.filter(
    (record) =>
      record.isStarred !== true &&
      record.isArchived !== true &&
      updatedAtMs(record) >= oneDayAgo,
  );

  return orderActiveFirst(filtered);
}

export function selectOlderSessionRecords(
  state: ClientSummaryState,
  now = Date.now(),
): SessionCollectionRecord[] {
  return selectOlderSessionRecordsFromRecords(
    Array.from(state.sessions.entities.values()),
    now,
  );
}

export function selectOlderSessionRecordsFromRecords(
  records: readonly SessionCollectionRecord[],
  now = Date.now(),
): SessionCollectionRecord[] {
  const oneDayAgo = now - 24 * 60 * 60 * 1000;
  return [...records]
    .filter(
      (record) =>
        record.isStarred !== true &&
        record.isArchived !== true &&
        updatedAtMs(record) < oneDayAgo,
    )
    .sort(byUpdatedAtDesc);
}

export function selectSessionCollectionQueryRecords(
  state: ClientSummaryState,
  query: SessionCollectionQueryDescriptor,
): SessionCollectionRecord[] {
  const key = createGlobalSessionsQueryKey(query);
  const queryState = state.sessions.queries.get(key);
  if (!queryState) {
    return [];
  }

  return queryState.ids.flatMap((id) => {
    const record = state.sessions.entities.get(id);
    return record ? [record] : [];
  });
}

export function toProjectId(projectId: string | UrlProjectId): UrlProjectId {
  return projectId as UrlProjectId;
}
