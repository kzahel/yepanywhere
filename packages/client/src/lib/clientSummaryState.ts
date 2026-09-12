import type {
  AgentActivity,
  PendingInputType,
  ProviderChildSessionSummary,
  ProviderName,
  ProviderRuntimeStatus,
  ProjectQueueChangedEvent,
  ProjectQueueDispatchState,
  ProjectQueueItemSummary,
  ProjectQueueProjectStatus,
  ProjectQueueRecoveredSessionQueueSummary,
  SessionMetadataPayload,
  UrlProjectId,
} from "@yep-anywhere/shared";
import type { GlobalSessionItem, InboxItem } from "../api/client";
import type { Project, SessionStatus } from "../types";
import type {
  ProcessStateEvent,
  ProviderRuntimeStatusChangedEvent,
  SessionCreatedEvent,
  SessionIdRemappedEvent,
  SessionMetadataChangedEvent,
  SessionSeenEvent,
  SessionStatusEvent,
  SessionUpdatedEvent,
} from "./activityBus";
import {
  ALL_PROJECTS_QUERY_KEY,
  EMPTY_PROJECT_QUEUE_ITEMS,
  EMPTY_RECOVERED_SESSION_QUEUES,
  RUNNING_PROJECT_QUEUE_DISPATCH_STATE,
  type ClientSummaryState,
  type GlobalSessionsCollectionSnapshot,
  type InboxCollectionSnapshot,
  type ProjectCollectionRecord,
  type ProjectCollectionSnapshot,
  type ProjectQueueCollectionRecord,
  type ProjectQueueCollectionSnapshot,
  type ProjectQueueGlobalCollectionSnapshot,
  type ProjectQueueProjectStatusRecord,
  type ProjectsCollectionSnapshot,
  type ProviderRuntimeStatusSnapshot,
  type SessionCollectionObservationKind,
  type SessionCollectionObservationSource,
  type SessionCollectionQueryDescriptor,
  type SessionCollectionRecord,
  resolveSessionCollectionId,
} from "./clientSummaryCollections";
import {
  createGlobalSessionsQueryKey,
  isActiveActivity,
} from "./clientSummaryQueries";
import {
  createEmptyInboxTierRecord,
  INBOX_TIERS,
  type InboxTier,
} from "./inboxTiers";

const NO_OBSERVATION = Number.NEGATIVE_INFINITY;
const CREATED_SESSION_QUERY_MEMBERSHIP_TTL_MS = 60_000;
const MAX_SESSION_ID_ALIASES = 256;

// Each session reducer entry point names whether it is applying a fuller row
// snapshot or a partial observation. The merge rules currently resolve
// conflicts by field-group freshness and allow older observations to backfill
// empty fields; the explicit source/kind keeps that distinction auditable.
interface SessionCollectionObservation {
  observedAt: number;
  kind: SessionCollectionObservationKind;
  source: SessionCollectionObservationSource;
}

export function createEmptyClientSummaryState(): ClientSummaryState {
  return {
    sessions: {
      entities: new Map(),
      queries: new Map(),
      aliases: new Map(),
    },
    projects: {
      entities: new Map(),
      queries: new Map(),
    },
    projectQueues: {
      byProject: new Map(),
      globalItems: EMPTY_PROJECT_QUEUE_ITEMS,
      dispatchState: RUNNING_PROJECT_QUEUE_DISPATCH_STATE,
      recoveredSessionQueues: EMPTY_RECOVERED_SESSION_QUEUES,
      projectStatusesByProject: new Map(),
    },
    inbox: {
      tiers: createEmptyInboxTierRecord(() => []),
    },
    localDecorations: {
      draftSessionIds: new Set(),
    },
    providerRuntime: {
      bySessionId: new Map(),
    },
  };
}

function getRecord(
  state: ClientSummaryState,
  sessionId: string,
): SessionCollectionRecord {
  const resolvedSessionId = resolveSessionCollectionId(state, sessionId);
  return (
    state.sessions.entities.get(resolvedSessionId) ?? {
      id: resolvedSessionId,
      observedAt: NO_OBSERVATION,
    }
  );
}

function putRecord(
  state: ClientSummaryState,
  record: SessionCollectionRecord,
): ClientSummaryState {
  const id = resolveSessionCollectionId(state, record.id);
  const parentSessionId = record.parentSessionId
    ? resolveSessionCollectionId(state, record.parentSessionId)
    : record.parentSessionId;
  const forkedFromSessionId = record.forkedFromSessionId
    ? resolveSessionCollectionId(state, record.forkedFromSessionId)
    : record.forkedFromSessionId;
  const normalizedRecord =
    id === record.id &&
    parentSessionId === record.parentSessionId &&
    forkedFromSessionId === record.forkedFromSessionId
      ? record
      : { ...record, id, parentSessionId, forkedFromSessionId };
  const entities = new Map(state.sessions.entities);
  entities.set(id, normalizedRecord);
  return {
    ...state,
    sessions: {
      ...state.sessions,
      entities,
    },
  };
}

function uniqueResolvedSessionIds(
  state: ClientSummaryState,
  sessionIds: readonly string[],
): string[] {
  const seen = new Set<string>();
  const resolvedIds: string[] = [];
  for (const sessionId of sessionIds) {
    const resolved = resolveSessionCollectionId(state, sessionId);
    if (!seen.has(resolved)) {
      seen.add(resolved);
      resolvedIds.push(resolved);
    }
  }
  return resolvedIds;
}

// Field-group assignment for the remap merge below: every group's fields win
// or lose together on the group's observation timestamp.
const REMAP_MERGE_GROUPS = {
  contentObservedAt: [
    "title",
    "fullTitle",
    "createdAt",
    "updatedAt",
    "messageCount",
    "provider",
    "model",
    "initialPrompt",
    "lastAgentText",
    "asyncQuestions",
    "providerChildren",
  ],
  metadataObservedAt: [
    "customTitle",
    "isArchived",
    "isStarred",
    "autoResumeDisabled",
    "parentSessionId",
    "parentSessionKind",
    "forkedFromSessionId",
    "executor",
  ],
  projectObservedAt: ["projectId", "projectName"],
  lifecycleObservedAt: [
    "ownership",
    "activity",
    "activityInferredFromInboxTier",
    "pendingInputType",
    "activeStartedAt",
  ],
  unreadObservedAt: ["hasUnread"],
} as const satisfies Record<string, readonly (keyof SessionCollectionRecord)[]>;

// Compile-time exhaustiveness: every SessionCollectionRecord field must be in
// a merge group above or merged individually below; a new field fails this
// assignment instead of silently dropping during remap merges.
type RemapMergedField =
  | keyof typeof REMAP_MERGE_GROUPS
  | (typeof REMAP_MERGE_GROUPS)[keyof typeof REMAP_MERGE_GROUPS][number]
  | "id"
  | "observedAt"
  | "snapshotObservedAt"
  | "eventCreatedAt";
type RemapUnmergedField = Exclude<
  keyof SessionCollectionRecord,
  RemapMergedField
>;
const _remapMergeCoversAllRecordFields: [RemapUnmergedField] extends [never]
  ? true
  : { missingFromRemapMergeGroups: RemapUnmergedField } = true;
void _remapMergeCoversAllRecordFields;

function mergeRemappedSessionRecords(
  provisional: SessionCollectionRecord | undefined,
  canonical: SessionCollectionRecord | undefined,
  canonicalId: string,
): SessionCollectionRecord | undefined {
  if (!provisional && !canonical) return undefined;
  if (!provisional) return canonical;
  if (!canonical) return { ...provisional, id: canonicalId };

  const pickGroup = (
    observedField: keyof typeof REMAP_MERGE_GROUPS,
    fields: readonly (keyof SessionCollectionRecord)[],
  ): Partial<SessionCollectionRecord> => {
    const provisionalObservedAt = provisional[observedField] ?? NO_OBSERVATION;
    const canonicalObservedAt = canonical[observedField] ?? NO_OBSERVATION;
    const [primary, secondary] =
      canonicalObservedAt >= provisionalObservedAt
        ? [canonical, provisional]
        : [provisional, canonical];
    const entries: Array<[keyof SessionCollectionRecord, unknown]> = [];
    for (const field of fields) {
      const value =
        primary[field] !== undefined ? primary[field] : secondary[field];
      if (value !== undefined) {
        entries.push([field, value]);
      }
    }
    const groupObservedAt = Math.max(
      provisionalObservedAt,
      canonicalObservedAt,
    );
    if (groupObservedAt !== NO_OBSERVATION) {
      entries.push([observedField, groupObservedAt]);
    }
    return Object.fromEntries(entries) as Partial<SessionCollectionRecord>;
  };

  const merged: SessionCollectionRecord = {
    id: canonicalId,
    observedAt: Math.max(provisional.observedAt, canonical.observedAt),
  };
  // Drive the merge off the group table itself, so a group added to
  // REMAP_MERGE_GROUPS is picked up here automatically. The exhaustiveness
  // assertion above only proves every field is assigned to some group; this
  // loop is what guarantees each group is actually merged.
  for (const observedField of Object.keys(REMAP_MERGE_GROUPS) as Array<
    keyof typeof REMAP_MERGE_GROUPS
  >) {
    Object.assign(
      merged,
      pickGroup(observedField, REMAP_MERGE_GROUPS[observedField]),
    );
  }
  if (
    provisional.snapshotObservedAt !== undefined ||
    canonical.snapshotObservedAt !== undefined
  ) {
    merged.snapshotObservedAt = Math.max(
      provisional.snapshotObservedAt ?? NO_OBSERVATION,
      canonical.snapshotObservedAt ?? NO_OBSERVATION,
    );
  }
  if (
    provisional.eventCreatedAt !== undefined ||
    canonical.eventCreatedAt !== undefined
  ) {
    merged.eventCreatedAt = Math.min(
      provisional.eventCreatedAt ?? Number.POSITIVE_INFINITY,
      canonical.eventCreatedAt ?? Number.POSITIVE_INFINITY,
    );
  }
  return merged;
}

function remapProjectQueueItemSessionIds(
  state: ClientSummaryState,
  item: ProjectQueueItemSummary,
): ProjectQueueItemSummary {
  let target = item.target;
  if (item.target.type === "existing-session") {
    const sessionId = resolveSessionCollectionId(state, item.target.sessionId);
    if (sessionId !== item.target.sessionId) {
      target = { ...item.target, sessionId };
    }
  }
  const createdFromSessionId = item.createdFrom?.sessionId
    ? resolveSessionCollectionId(state, item.createdFrom.sessionId)
    : item.createdFrom?.sessionId;
  const createdFrom =
    item.createdFrom && createdFromSessionId !== item.createdFrom.sessionId
      ? { ...item.createdFrom, sessionId: createdFromSessionId }
      : item.createdFrom;
  return target === item.target && createdFrom === item.createdFrom
    ? item
    : { ...item, target, createdFrom };
}

function remapProjectQueueItems(
  state: ClientSummaryState,
  items: readonly ProjectQueueItemSummary[],
): readonly ProjectQueueItemSummary[] {
  let changed = false;
  const remapped = items.map((item) => {
    const next = remapProjectQueueItemSessionIds(state, item);
    changed ||= next !== item;
    return next;
  });
  return changed ? remapped : items;
}

function remapRecoveredSessionQueues(
  state: ClientSummaryState,
  queues: readonly ProjectQueueRecoveredSessionQueueSummary[],
): readonly ProjectQueueRecoveredSessionQueueSummary[] {
  let changed = false;
  const remapped = queues.map((queue) => {
    const sessionId = resolveSessionCollectionId(state, queue.sessionId);
    if (sessionId === queue.sessionId) return queue;
    changed = true;
    return { ...queue, sessionId };
  });
  return changed ? remapped : queues;
}

function providerCountsEqual(
  a: Project["sessionCountsByProvider"],
  b: Project["sessionCountsByProvider"],
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((key) => {
    const provider = key as ProviderName;
    return a[provider] === b[provider];
  });
}

function projectFieldsEqual(
  record: ProjectCollectionRecord,
  project: Project,
): boolean {
  return (
    record.id === project.id &&
    record.path === project.path &&
    record.name === project.name &&
    record.sessionCount === project.sessionCount &&
    providerCountsEqual(
      record.sessionCountsByProvider,
      project.sessionCountsByProvider,
    ) &&
    record.activeOwnedCount === project.activeOwnedCount &&
    record.activeExternalCount === project.activeExternalCount &&
    record.projectQueueBlockingCount === project.projectQueueBlockingCount &&
    record.lastActivity === project.lastActivity
  );
}

function putProjectRecord(
  state: ClientSummaryState,
  project: Project,
  observedAt: number,
): ClientSummaryState {
  const existing = state.projects.entities.get(project.id);
  if (existing) {
    if (observedAt < (existing.snapshotObservedAt ?? NO_OBSERVATION)) {
      return state;
    }
    if (projectFieldsEqual(existing, project)) {
      if (observedAt === existing.snapshotObservedAt) {
        return state;
      }
      const entities = new Map(state.projects.entities);
      entities.set(project.id, {
        ...existing,
        observedAt: Math.max(existing.observedAt, observedAt),
        snapshotObservedAt: observedAt,
      });
      return {
        ...state,
        projects: {
          ...state.projects,
          entities,
        },
      };
    }
  }

  const entities = new Map(state.projects.entities);
  entities.set(project.id, {
    ...project,
    observedAt: Math.max(existing?.observedAt ?? NO_OBSERVATION, observedAt),
    snapshotObservedAt: observedAt,
  });

  return {
    ...state,
    projects: {
      ...state.projects,
      entities,
    },
  };
}

function putProjectsQuery(
  state: ClientSummaryState,
  projects: readonly Project[],
  requestStartedAt: number,
): ClientSummaryState {
  const existing = state.projects.queries.get(ALL_PROJECTS_QUERY_KEY);
  if (existing && requestStartedAt < existing.requestStartedAt) {
    return state;
  }

  const ids = projects.map((project) => project.id);
  if (
    existing &&
    existing.ids.length === ids.length &&
    existing.ids.every((id, index) => id === ids[index])
  ) {
    if (requestStartedAt === existing.requestStartedAt) {
      return state;
    }
    const queries = new Map(state.projects.queries);
    queries.set(ALL_PROJECTS_QUERY_KEY, {
      ...existing,
      requestStartedAt,
      fetchedAt: Date.now(),
    });
    return {
      ...state,
      projects: {
        ...state.projects,
        queries,
      },
    };
  }

  const queries = new Map(state.projects.queries);
  queries.set(ALL_PROJECTS_QUERY_KEY, {
    key: ALL_PROJECTS_QUERY_KEY,
    ids,
    requestStartedAt,
    fetchedAt: Date.now(),
  });

  return {
    ...state,
    projects: {
      ...state.projects,
      queries,
    },
  };
}

function normalizedJsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  return JSON.stringify(a) === JSON.stringify(b);
}

function projectQueueItemsEqual(
  a: readonly ProjectQueueItemSummary[],
  b: readonly ProjectQueueItemSummary[],
): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  return a.every((item, index) => {
    const other = b[index];
    if (!other) return false;
    return (
      item.id === other.id &&
      item.projectId === other.projectId &&
      normalizedJsonEqual(item.target, other.target) &&
      item.targetTitle === other.targetTitle &&
      item.targetFullTitle === other.targetFullTitle &&
      item.messagePreview === other.messagePreview &&
      normalizedJsonEqual(item.message, other.message) &&
      item.createdAt === other.createdAt &&
      item.updatedAt === other.updatedAt &&
      normalizedJsonEqual(item.createdFrom, other.createdFrom) &&
      item.status === other.status &&
      item.attachmentCount === other.attachmentCount &&
      item.lastError === other.lastError &&
      item.lastAttemptAt === other.lastAttemptAt
    );
  });
}

function mergeProjectQueueItemDisplayMetadata(
  existingItems: readonly ProjectQueueItemSummary[] | undefined,
  snapshotItems: readonly ProjectQueueItemSummary[],
): readonly ProjectQueueItemSummary[] {
  if (!existingItems?.length) return snapshotItems;
  const existingById = new Map(existingItems.map((item) => [item.id, item]));
  let changed = false;
  const merged = snapshotItems.map((item) => {
    if (item.targetTitle !== undefined && item.targetFullTitle !== undefined) {
      return item;
    }
    const existing = existingById.get(item.id);
    if (!existing) return item;
    if (!normalizedJsonEqual(item.target, existing.target)) return item;
    const targetTitle =
      item.targetTitle !== undefined ? item.targetTitle : existing.targetTitle;
    const targetFullTitle =
      item.targetFullTitle !== undefined
        ? item.targetFullTitle
        : existing.targetFullTitle;
    if (
      targetTitle === item.targetTitle &&
      targetFullTitle === item.targetFullTitle
    ) {
      return item;
    }
    changed = true;
    return {
      ...item,
      ...(targetTitle !== undefined ? { targetTitle } : {}),
      ...(targetFullTitle !== undefined ? { targetFullTitle } : {}),
    };
  });
  return changed ? merged : snapshotItems;
}

function sameIdsIgnoringOrder(
  a: readonly ProjectQueueItemSummary[],
  b: readonly ProjectQueueItemSummary[],
): boolean {
  if (a.length !== b.length) return false;
  const ids = new Set(a.map((item) => item.id));
  return b.every((item) => ids.has(item.id));
}

function mergeProjectQueueSnapshotIntoGlobalItems(
  globalItems: readonly ProjectQueueItemSummary[],
  projectId: UrlProjectId,
  snapshotItems: readonly ProjectQueueItemSummary[],
): readonly ProjectQueueItemSummary[] {
  if (globalItems.length === 0) return snapshotItems;

  const existingProjectItems = globalItems.filter(
    (item) => item.projectId === projectId,
  );
  if (existingProjectItems.length === 0) {
    return snapshotItems.length > 0
      ? [...globalItems, ...snapshotItems]
      : globalItems;
  }

  if (sameIdsIgnoringOrder(existingProjectItems, snapshotItems)) {
    let snapshotIndex = 0;
    return globalItems.map((item) =>
      item.projectId === projectId ? snapshotItems[snapshotIndex++]! : item,
    );
  }

  const snapshotById = new Map(snapshotItems.map((item) => [item.id, item]));
  const placedIds = new Set<string>();
  const merged: ProjectQueueItemSummary[] = [];
  for (const item of globalItems) {
    if (item.projectId !== projectId) {
      merged.push(item);
      continue;
    }
    const replacement = snapshotById.get(item.id);
    if (!replacement) {
      continue;
    }
    merged.push(replacement);
    placedIds.add(replacement.id);
  }
  for (const item of snapshotItems) {
    if (!placedIds.has(item.id)) {
      merged.push(item);
    }
  }
  return merged;
}

function inboxTierIdsEqual(
  a: Record<InboxTier, readonly string[]>,
  b: Record<InboxTier, readonly string[]>,
): boolean {
  return INBOX_TIERS.every((tier) => {
    const aIds = a[tier];
    const bIds = b[tier];
    return (
      aIds.length === bIds.length &&
      aIds.every((id, index) => id === bIds[index])
    );
  });
}

function stringSetsEqual(
  a: ReadonlySet<string>,
  b: ReadonlySet<string>,
): boolean {
  if (a === b) return true;
  if (a.size !== b.size) return false;
  for (const value of a) {
    if (!b.has(value)) {
      return false;
    }
  }
  return true;
}

function projectQueueDispatchStatesEqual(
  a: ProjectQueueDispatchState,
  b: ProjectQueueDispatchState,
): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function recoveredSessionQueuesEqual(
  a: readonly ProjectQueueRecoveredSessionQueueSummary[],
  b: readonly ProjectQueueRecoveredSessionQueueSummary[],
): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function providerRuntimeStatusEqual(
  a: ProviderRuntimeStatus,
  b: ProviderRuntimeStatus,
): boolean {
  if (a === b) return true;
  return JSON.stringify(a) === JSON.stringify(b);
}

function projectQueueProjectStatusesEqual(
  a: ProjectQueueProjectStatus,
  b: ProjectQueueProjectStatus,
): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function putProviderRuntimeStatus(
  state: ClientSummaryState,
  sessionId: string,
  projectId: string | undefined,
  status: ProviderRuntimeStatus,
  observedAt: number,
): ClientSummaryState {
  const resolvedSessionId = resolveSessionCollectionId(state, sessionId);
  const existing = state.providerRuntime.bySessionId.get(resolvedSessionId);
  if (existing && observedAt < existing.observedAt) {
    return state;
  }

  if (status === null) {
    if (!existing) {
      return state;
    }
    const bySessionId = new Map(state.providerRuntime.bySessionId);
    bySessionId.delete(resolvedSessionId);
    return {
      ...state,
      providerRuntime: {
        ...state.providerRuntime,
        bySessionId,
      },
    };
  }

  if (
    existing &&
    observedAt === existing.observedAt &&
    existing.projectId === projectId &&
    providerRuntimeStatusEqual(existing.status, status)
  ) {
    return state;
  }

  const bySessionId = new Map(state.providerRuntime.bySessionId);
  bySessionId.set(resolvedSessionId, {
    sessionId: resolvedSessionId,
    projectId,
    status,
    observedAt,
  });

  return {
    ...state,
    providerRuntime: {
      ...state.providerRuntime,
      bySessionId,
    },
  };
}

function putProjectQueueDispatchState(
  state: ClientSummaryState,
  dispatchState: ProjectQueueDispatchState | undefined,
  observedAt: number,
): ClientSummaryState {
  if (!dispatchState) return state;
  if (
    observedAt < (state.projectQueues.dispatchStateObservedAt ?? NO_OBSERVATION)
  ) {
    return state;
  }
  if (
    projectQueueDispatchStatesEqual(
      state.projectQueues.dispatchState,
      dispatchState,
    ) &&
    observedAt === state.projectQueues.dispatchStateObservedAt
  ) {
    return state;
  }
  return {
    ...state,
    projectQueues: {
      ...state.projectQueues,
      dispatchState,
      dispatchStateObservedAt: observedAt,
    },
  };
}

function putProjectQueueProjectStatuses(
  state: ClientSummaryState,
  projectStatuses: Record<string, ProjectQueueProjectStatus> | undefined,
  observedAt: number,
  mode: "merge" | "replace",
): ClientSummaryState {
  if (!projectStatuses) return state;

  let byProject: Map<string, ProjectQueueProjectStatusRecord> | null = null;
  const nextProjectIds = new Set(Object.keys(projectStatuses));

  for (const [projectId, status] of Object.entries(projectStatuses)) {
    const existing =
      state.projectQueues.projectStatusesByProject.get(projectId);
    if (existing && existing.observedAt > observedAt) {
      continue;
    }
    if (
      existing &&
      existing.observedAt === observedAt &&
      projectQueueProjectStatusesEqual(existing.status, status)
    ) {
      continue;
    }
    if (!byProject) {
      byProject = new Map(state.projectQueues.projectStatusesByProject);
    }
    byProject.set(projectId, {
      projectId,
      status,
      observedAt,
    });
  }

  if (mode === "replace") {
    for (const [projectId, existing] of state.projectQueues
      .projectStatusesByProject) {
      if (nextProjectIds.has(projectId) || existing.observedAt > observedAt) {
        continue;
      }
      if (!byProject) {
        byProject = new Map(state.projectQueues.projectStatusesByProject);
      }
      byProject.delete(projectId);
    }
  }

  if (!byProject) {
    return state;
  }

  return {
    ...state,
    projectQueues: {
      ...state.projectQueues,
      projectStatusesByProject: byProject,
    },
  };
}

function putRecoveredSessionQueues(
  state: ClientSummaryState,
  recoveredSessionQueues:
    | readonly ProjectQueueRecoveredSessionQueueSummary[]
    | undefined,
  observedAt: number,
): ClientSummaryState {
  if (!recoveredSessionQueues) return state;
  const resolvedQueues = remapRecoveredSessionQueues(
    state,
    recoveredSessionQueues,
  );
  if (
    observedAt <
    (state.projectQueues.recoveredSessionQueuesObservedAt ?? NO_OBSERVATION)
  ) {
    return state;
  }
  if (
    recoveredSessionQueuesEqual(
      state.projectQueues.recoveredSessionQueues,
      resolvedQueues,
    ) &&
    observedAt === state.projectQueues.recoveredSessionQueuesObservedAt
  ) {
    return state;
  }
  return {
    ...state,
    projectQueues: {
      ...state.projectQueues,
      recoveredSessionQueues: resolvedQueues,
      recoveredSessionQueuesObservedAt: observedAt,
    },
  };
}

function putProjectQueueSnapshot(
  state: ClientSummaryState,
  snapshot: ProjectQueueCollectionSnapshot,
  observedAt: number,
): ClientSummaryState {
  let next = putProjectQueueDispatchState(
    state,
    snapshot.dispatchState,
    observedAt,
  );
  next = putProjectQueueProjectStatuses(
    next,
    snapshot.projectStatuses,
    observedAt,
    "merge",
  );
  const existing = next.projectQueues.byProject.get(snapshot.projectId);
  const resolvedItems = remapProjectQueueItems(next, snapshot.items);
  const snapshotItems = mergeProjectQueueItemDisplayMetadata(
    existing?.items,
    resolvedItems,
  );
  if (existing) {
    if (observedAt < (existing.snapshotObservedAt ?? NO_OBSERVATION)) {
      return next;
    }

    if (projectQueueItemsEqual(existing.items, snapshotItems)) {
      const byProject = new Map(next.projectQueues.byProject);
      byProject.set(snapshot.projectId, {
        ...existing,
        observedAt: Math.max(existing.observedAt, observedAt),
        snapshotObservedAt: observedAt,
      });
      next = {
        ...next,
        projectQueues: {
          ...next.projectQueues,
          byProject,
        },
      };
      if (
        next.projectQueues.globalItemsObservedAt !== undefined &&
        observedAt >= next.projectQueues.globalItemsObservedAt
      ) {
        return putProjectQueueGlobalItemsForProject(
          next,
          snapshot.projectId,
          snapshotItems,
          observedAt,
        );
      }
      return next;
    }
  }

  const byProject = new Map(next.projectQueues.byProject);
  byProject.set(snapshot.projectId, {
    projectId: snapshot.projectId,
    items: snapshotItems,
    observedAt: Math.max(existing?.observedAt ?? NO_OBSERVATION, observedAt),
    snapshotObservedAt: observedAt,
  });

  next = {
    ...next,
    projectQueues: {
      ...next.projectQueues,
      byProject,
    },
  };
  if (
    next.projectQueues.globalItemsObservedAt !== undefined &&
    observedAt >= next.projectQueues.globalItemsObservedAt
  ) {
    return putProjectQueueGlobalItemsForProject(
      next,
      snapshot.projectId,
      snapshotItems,
      observedAt,
    );
  }
  return next;
}

function putProjectQueueGlobalItemsForProject(
  state: ClientSummaryState,
  projectId: UrlProjectId,
  snapshotItems: readonly ProjectQueueItemSummary[],
  observedAt: number,
): ClientSummaryState {
  const globalItems = mergeProjectQueueSnapshotIntoGlobalItems(
    state.projectQueues.globalItems,
    projectId,
    snapshotItems,
  );
  if (
    projectQueueItemsEqual(state.projectQueues.globalItems, globalItems) &&
    observedAt === state.projectQueues.globalItemsObservedAt
  ) {
    return state;
  }
  return {
    ...state,
    projectQueues: {
      ...state.projectQueues,
      globalItems,
      globalItemsObservedAt: observedAt,
    },
  };
}

function putProjectQueueGlobalSnapshot(
  state: ClientSummaryState,
  snapshot: ProjectQueueGlobalCollectionSnapshot,
  observedAt: number,
): ClientSummaryState {
  if (
    observedAt < (state.projectQueues.globalItemsObservedAt ?? NO_OBSERVATION)
  ) {
    return state;
  }
  const bySnapshotProject = new Map<UrlProjectId, ProjectQueueItemSummary[]>();
  const snapshotItems = mergeProjectQueueItemDisplayMetadata(
    state.projectQueues.globalItems,
    remapProjectQueueItems(state, snapshot.items),
  );
  for (const item of snapshotItems) {
    const items = bySnapshotProject.get(item.projectId);
    if (items) {
      items.push(item);
    } else {
      bySnapshotProject.set(item.projectId, [item]);
    }
  }

  let next = state;
  for (const [projectId, items] of bySnapshotProject) {
    next = putProjectQueueSnapshot(next, { projectId, items }, observedAt);
  }

  let byProject: Map<string, ProjectQueueCollectionRecord> | null = null;
  for (const [projectId, existing] of next.projectQueues.byProject) {
    if (bySnapshotProject.has(projectId as UrlProjectId)) {
      continue;
    }
    if ((existing.snapshotObservedAt ?? NO_OBSERVATION) > observedAt) {
      continue;
    }
    if (!byProject) {
      byProject = new Map(next.projectQueues.byProject);
    }
    byProject.delete(projectId);
  }

  if (byProject) {
    next = {
      ...next,
      projectQueues: {
        ...next.projectQueues,
        byProject,
      },
    };
  }

  if (
    !projectQueueItemsEqual(next.projectQueues.globalItems, snapshotItems) ||
    observedAt !== next.projectQueues.globalItemsObservedAt
  ) {
    next = {
      ...next,
      projectQueues: {
        ...next.projectQueues,
        globalItems: snapshotItems,
        globalItemsObservedAt: observedAt,
      },
    };
  }

  next = putProjectQueueDispatchState(next, snapshot.dispatchState, observedAt);
  next = putProjectQueueProjectStatuses(
    next,
    snapshot.projectStatuses,
    observedAt,
    "replace",
  );
  return putRecoveredSessionQueues(
    next,
    snapshot.recoveredSessionQueues,
    observedAt,
  );
}

function upsertInboxItemRecord(
  state: ClientSummaryState,
  item: InboxItem,
  observation: SessionCollectionObservation,
): ClientSummaryState {
  let record = getRecord(state, item.sessionId);

  record = withContentFields(
    record,
    {
      title: item.sessionTitle,
      asyncQuestions: item.asyncQuestions,
      updatedAt: item.updatedAt,
    },
    observation,
  );

  record = withProjectFields(
    record,
    {
      projectId: item.projectId,
      projectName: item.projectName,
    },
    observation,
  );

  record = withMetadataFields(
    record,
    {
      customTitle: item.customTitle,
      isStarred: item.isStarred,
    },
    observation,
  );

  const inferredActivity =
    item.activity ?? (item.pendingInputType ? "waiting-input" : null);
  record = withLifecycleFields(
    record,
    {
      activity: inferredActivity,
      activityInferredFromInboxTier: false,
      pendingInputType: item.pendingInputType,
    },
    observation,
  );

  record = withUnreadField(record, item.hasUnread, observation);

  return putRecord(state, record);
}

function putInboxSnapshot(
  state: ClientSummaryState,
  snapshot: InboxCollectionSnapshot,
  requestStartedAt: number,
): ClientSummaryState {
  if (
    state.inbox.requestStartedAt !== undefined &&
    requestStartedAt < state.inbox.requestStartedAt
  ) {
    return state;
  }

  const observation = createSessionCollectionObservation(
    requestStartedAt,
    "partial-snapshot",
    "inbox",
  );
  let next = state;
  const tiers = createEmptyInboxTierRecord<string[]>(() => []);
  const seenSessionIds = new Set<string>();
  for (const tier of INBOX_TIERS) {
    for (const item of snapshot[tier]) {
      const sessionId = resolveSessionCollectionId(next, item.sessionId);
      if (!seenSessionIds.has(sessionId)) {
        seenSessionIds.add(sessionId);
        tiers[tier].push(sessionId);
      }
      next = upsertInboxItemRecord(next, item, observation);
    }
  }

  const stableTiers = inboxTierIdsEqual(next.inbox.tiers, tiers)
    ? next.inbox.tiers
    : tiers;

  return {
    ...next,
    inbox: {
      ...next.inbox,
      tiers:
        snapshot.catalog?.complete === false ? next.inbox.tiers : stableTiers,
      catalog: snapshot.catalog,
      requestStartedAt,
      fetchedAt: Date.now(),
    },
  };
}

function normalizeActivity(
  activity: AgentActivity | null | undefined,
): AgentActivity | undefined {
  return activity === "in-turn" || activity === "waiting-input"
    ? activity
    : undefined;
}

function createSessionCollectionObservation(
  observedAt: number,
  kind: SessionCollectionObservationKind,
  source: SessionCollectionObservationSource,
): SessionCollectionObservation {
  return { observedAt, kind, source };
}

function isFreshObservation(
  observation: SessionCollectionObservation,
  recordObservedAt: number | undefined,
): boolean {
  return observation.observedAt >= (recordObservedAt ?? NO_OBSERVATION);
}

function canApplyObservedField<T>(
  currentValue: T | undefined,
  nextValue: T | undefined,
  isFresh: boolean,
): nextValue is T {
  return nextValue !== undefined && (isFresh || currentValue === undefined);
}

function withContentFields(
  record: SessionCollectionRecord,
  fields: {
    title?: string | null;
    fullTitle?: string | null;
    createdAt?: string;
    updatedAt?: string;
    messageCount?: number;
    provider?: ProviderName;
    model?: string;
    initialPrompt?: string;
    lastAgentText?: string;
    asyncQuestions?: GlobalSessionItem["asyncQuestions"];
    providerChildren?: ProviderChildSessionSummary[];
  },
  observation: SessionCollectionObservation,
): SessionCollectionRecord {
  if (Object.values(fields).every((value) => value === undefined)) {
    return record;
  }
  const isFresh = isFreshObservation(observation, record.contentObservedAt);

  return {
    ...record,
    ...(canApplyObservedField(record.title, fields.title, isFresh)
      ? { title: fields.title }
      : {}),
    ...(canApplyObservedField(record.fullTitle, fields.fullTitle, isFresh)
      ? { fullTitle: fields.fullTitle }
      : {}),
    ...(canApplyObservedField(record.createdAt, fields.createdAt, isFresh)
      ? { createdAt: fields.createdAt }
      : {}),
    ...(canApplyObservedField(record.updatedAt, fields.updatedAt, isFresh)
      ? { updatedAt: fields.updatedAt }
      : {}),
    ...(canApplyObservedField(record.messageCount, fields.messageCount, isFresh)
      ? { messageCount: fields.messageCount }
      : {}),
    ...(canApplyObservedField(record.provider, fields.provider, isFresh)
      ? { provider: fields.provider }
      : {}),
    ...(canApplyObservedField(record.model, fields.model, isFresh)
      ? { model: fields.model }
      : {}),
    ...(canApplyObservedField(
      record.initialPrompt,
      fields.initialPrompt,
      isFresh,
    )
      ? { initialPrompt: fields.initialPrompt }
      : {}),
    ...(canApplyObservedField(
      record.lastAgentText,
      fields.lastAgentText,
      isFresh,
    )
      ? { lastAgentText: fields.lastAgentText }
      : {}),
    ...(canApplyObservedField(
      record.providerChildren,
      fields.providerChildren,
      isFresh,
    )
      ? { providerChildren: fields.providerChildren }
      : {}),
    ...(canApplyObservedField(
      record.asyncQuestions,
      fields.asyncQuestions,
      isFresh,
    )
      ? { asyncQuestions: fields.asyncQuestions }
      : {}),
    ...(isFresh ? { contentObservedAt: observation.observedAt } : {}),
    observedAt: Math.max(record.observedAt, observation.observedAt),
  };
}

function withMetadataFields(
  record: SessionCollectionRecord,
  fields: {
    customTitle?: string;
    isArchived?: boolean;
    isStarred?: boolean;
    autoResumeDisabled?: boolean;
    parentSessionId?: string | null;
    parentSessionKind?: "btw-aside" | null;
    forkedFromSessionId?: string | null;
    executor?: string;
  },
  observation: SessionCollectionObservation,
): SessionCollectionRecord {
  if (Object.values(fields).every((value) => value === undefined)) {
    return record;
  }
  const isFresh = isFreshObservation(observation, record.metadataObservedAt);

  return {
    ...record,
    ...(canApplyObservedField(record.customTitle, fields.customTitle, isFresh)
      ? { customTitle: fields.customTitle }
      : {}),
    ...(canApplyObservedField(record.isArchived, fields.isArchived, isFresh)
      ? { isArchived: fields.isArchived }
      : {}),
    ...(canApplyObservedField(record.isStarred, fields.isStarred, isFresh)
      ? { isStarred: fields.isStarred }
      : {}),
    ...(canApplyObservedField(
      record.autoResumeDisabled,
      fields.autoResumeDisabled,
      isFresh,
    )
      ? { autoResumeDisabled: fields.autoResumeDisabled }
      : {}),
    ...(fields.parentSessionId === null
      ? isFresh
        ? { parentSessionId: undefined }
        : {}
      : canApplyObservedField(
            record.parentSessionId,
            fields.parentSessionId,
            isFresh,
          )
        ? { parentSessionId: fields.parentSessionId }
        : {}),
    ...(fields.parentSessionKind === null
      ? isFresh
        ? { parentSessionKind: undefined }
        : {}
      : canApplyObservedField(
            record.parentSessionKind,
            fields.parentSessionKind,
            isFresh,
          )
        ? { parentSessionKind: fields.parentSessionKind }
        : {}),
    ...(fields.forkedFromSessionId === null
      ? isFresh
        ? { forkedFromSessionId: undefined }
        : {}
      : canApplyObservedField(
            record.forkedFromSessionId,
            fields.forkedFromSessionId,
            isFresh,
          )
        ? { forkedFromSessionId: fields.forkedFromSessionId }
        : {}),
    ...(canApplyObservedField(record.executor, fields.executor, isFresh)
      ? { executor: fields.executor }
      : {}),
    ...(isFresh ? { metadataObservedAt: observation.observedAt } : {}),
    observedAt: Math.max(record.observedAt, observation.observedAt),
  };
}

function withProjectFields(
  record: SessionCollectionRecord,
  fields: {
    projectId?: string;
    projectName?: string;
  },
  observation: SessionCollectionObservation,
): SessionCollectionRecord {
  if (Object.values(fields).every((value) => value === undefined)) {
    return record;
  }
  const isFresh = isFreshObservation(observation, record.projectObservedAt);

  return {
    ...record,
    ...(canApplyObservedField(record.projectId, fields.projectId, isFresh)
      ? { projectId: fields.projectId }
      : {}),
    ...(canApplyObservedField(record.projectName, fields.projectName, isFresh)
      ? { projectName: fields.projectName }
      : {}),
    ...(isFresh ? { projectObservedAt: observation.observedAt } : {}),
    observedAt: Math.max(record.observedAt, observation.observedAt),
  };
}

function withProjectHint(
  record: SessionCollectionRecord,
  fields: {
    projectId?: string;
    projectName?: string;
  },
  observation: SessionCollectionObservation,
): SessionCollectionRecord {
  const projectMatches =
    record.projectId === undefined ||
    fields.projectId === undefined ||
    record.projectId === fields.projectId;
  return withProjectFields(
    record,
    {
      projectId: record.projectId === undefined ? fields.projectId : undefined,
      projectName:
        projectMatches && record.projectName === undefined
          ? fields.projectName
          : undefined,
    },
    observation,
  );
}

function withLifecycleFields(
  record: SessionCollectionRecord,
  fields: {
    ownership?: SessionStatus;
    activity?: AgentActivity | null;
    activityInferredFromInboxTier?: boolean;
    pendingInputType?: PendingInputType;
  },
  observation: SessionCollectionObservation,
): SessionCollectionRecord {
  if (
    fields.ownership === undefined &&
    fields.activity === undefined &&
    fields.activityInferredFromInboxTier === undefined &&
    fields.pendingInputType === undefined
  ) {
    return record;
  }

  const isFresh = isFreshObservation(observation, record.lifecycleObservedAt);
  const normalizedActivity = normalizeActivity(fields.activity);
  const wasActive = isActiveActivity(record.activity);
  const nextActivity = isFresh ? normalizedActivity : record.activity;
  const isActive = isActiveActivity(nextActivity);
  const nextPendingInputType = (() => {
    if (isFresh) {
      return nextActivity === "waiting-input"
        ? fields.pendingInputType
        : undefined;
    }
    if (
      nextActivity === "waiting-input" &&
      canApplyObservedField(
        record.pendingInputType,
        fields.pendingInputType,
        isFresh,
      )
    ) {
      return fields.pendingInputType;
    }
    return record.pendingInputType;
  })();

  return {
    ...record,
    ...(canApplyObservedField(record.ownership, fields.ownership, isFresh)
      ? { ownership: fields.ownership }
      : {}),
    activity: nextActivity,
    activityInferredFromInboxTier:
      isFresh && nextActivity
        ? fields.activityInferredFromInboxTier === true
        : isFresh
          ? undefined
          : record.activityInferredFromInboxTier,
    activeStartedAt: isFresh
      ? isActive
        ? wasActive
          ? record.activeStartedAt
          : observation.observedAt
        : undefined
      : record.activeStartedAt,
    pendingInputType: nextPendingInputType,
    ...(isFresh ? { lifecycleObservedAt: observation.observedAt } : {}),
    observedAt: Math.max(record.observedAt, observation.observedAt),
  };
}

function withUnreadField(
  record: SessionCollectionRecord,
  hasUnread: boolean | undefined,
  observation: SessionCollectionObservation,
): SessionCollectionRecord {
  if (hasUnread === undefined) {
    return record;
  }

  const isFresh = isFreshObservation(observation, record.unreadObservedAt);
  if (!isFresh && record.hasUnread !== undefined) {
    return record;
  }

  return {
    ...record,
    hasUnread,
    ...(isFresh ? { unreadObservedAt: observation.observedAt } : {}),
    observedAt: Math.max(record.observedAt, observation.observedAt),
  };
}

function upsertSnapshotRecord(
  state: ClientSummaryState,
  row: GlobalSessionItem,
  observation: SessionCollectionObservation,
): ClientSummaryState {
  let record = getRecord(state, row.id);

  record = withContentFields(
    record,
    {
      title: row.title,
      fullTitle: row.fullTitle,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      messageCount: row.messageCount,
      provider: row.provider,
      model: row.model,
      initialPrompt: row.initialPrompt,
      lastAgentText: row.lastAgentText,
      asyncQuestions: row.asyncQuestions,
      providerChildren: row.providerChildren,
    },
    observation,
  );

  record = withMetadataFields(
    record,
    {
      customTitle: row.customTitle,
      isArchived: row.isArchived,
      isStarred: row.isStarred,
      autoResumeDisabled: row.autoResumeDisabled,
      parentSessionId: row.parentSessionId,
      parentSessionKind: row.parentSessionKind,
      forkedFromSessionId: row.forkedFromSessionId,
      executor: row.executor,
    },
    observation,
  );

  record = withProjectFields(
    record,
    {
      projectId: row.projectId,
      projectName: row.projectName,
    },
    observation,
  );

  record = withLifecycleFields(
    record,
    {
      ownership: row.ownership,
      activity: row.activity,
      pendingInputType: row.pendingInputType,
    },
    observation,
  );

  record = withUnreadField(record, row.hasUnread, observation);

  record = {
    ...record,
    snapshotObservedAt: Math.max(
      record.snapshotObservedAt ?? NO_OBSERVATION,
      observation.observedAt,
    ),
    observedAt: Math.max(record.observedAt, observation.observedAt),
  };

  return putRecord(state, record);
}

function upsertQuery(
  state: ClientSummaryState,
  snapshot: GlobalSessionsCollectionSnapshot,
  requestStartedAt: number,
): ClientSummaryState {
  const key = createGlobalSessionsQueryKey(snapshot.query);
  const existing = state.sessions.queries.get(key);
  if (existing && requestStartedAt < existing.requestStartedAt) {
    return state;
  }

  const incomingIds = uniqueResolvedSessionIds(
    state,
    snapshot.sessions.map((session) => session.id),
  );
  let ids = incomingIds;
  if (
    (snapshot.mode === "append" || snapshot.catalog?.complete === false) &&
    existing
  ) {
    ids = [
      ...existing.ids,
      ...incomingIds.filter((id) => !existing.ids.includes(id)),
    ];
  } else if (snapshot.mode === "prepend" && existing) {
    const incomingIdSet = new Set(incomingIds);
    ids = [
      ...incomingIds,
      ...existing.ids.filter((id) => !incomingIdSet.has(id)),
    ];
  } else if (existing) {
    ids = preserveRecentEventCreatedQueryIds(
      state,
      snapshot.query,
      existing.ids,
      incomingIds,
      requestStartedAt,
    );
  }

  const queries = new Map(state.sessions.queries);
  queries.set(key, {
    key,
    descriptor: snapshot.query,
    catalog: snapshot.catalog,
    ids,
    hasMore: snapshot.hasMore,
    requestStartedAt,
    fetchedAt: Date.now(),
  });

  return {
    ...state,
    sessions: {
      ...state.sessions,
      queries,
    },
  };
}

function preserveRecentEventCreatedQueryIds(
  state: ClientSummaryState,
  query: SessionCollectionQueryDescriptor,
  existingIds: readonly string[],
  incomingIds: readonly string[],
  observedAt: number,
): string[] {
  const incomingIdSet = new Set(incomingIds);
  const preservedIds = existingIds.filter((id) => {
    if (incomingIdSet.has(id)) {
      return false;
    }
    const record = state.sessions.entities.get(id);
    return (
      !!record &&
      isRecentlyEventCreatedRecord(record, observedAt) &&
      recordMatchesQuery(record, query)
    );
  });

  return preservedIds.length > 0
    ? [...preservedIds, ...incomingIds]
    : [...incomingIds];
}

function isRecentlyEventCreatedRecord(
  record: SessionCollectionRecord,
  observedAt: number,
): boolean {
  if (record.eventCreatedAt === undefined) {
    return false;
  }
  const ageMs = observedAt - record.eventCreatedAt;
  return ageMs >= 0 && ageMs <= CREATED_SESSION_QUERY_MEMBERSHIP_TTL_MS;
}

function recordMatchesQuery(
  record: SessionCollectionRecord,
  query: SessionCollectionQueryDescriptor,
): boolean {
  if (query.searchQuery?.trim()) {
    return false;
  }
  if (query.projectId && record.projectId !== query.projectId) {
    return false;
  }
  if (query.includeArchived !== true && record.isArchived === true) {
    return false;
  }
  if (query.starred === true && record.isStarred !== true) {
    return false;
  }
  return true;
}

export function applySessionCollectionTitleSnapshot(
  state: ClientSummaryState,
  session: SessionMetadataPayload,
  observedAt = Date.now(),
): ClientSummaryState {
  const observation = createSessionCollectionObservation(
    observedAt,
    "partial-snapshot",
    "session-metadata",
  );
  let record = getRecord(state, session.id);
  record = withContentFields(
    record,
    {
      title: session.title,
      fullTitle: session.fullTitle,
    },
    observation,
  );
  record = withMetadataFields(
    record,
    { customTitle: session.customTitle },
    observation,
  );
  record = withProjectFields(
    record,
    { projectId: session.projectId },
    observation,
  );
  return putRecord(state, record);
}

export function applyGlobalSessionsCollectionSnapshot(
  state: ClientSummaryState,
  snapshot: GlobalSessionsCollectionSnapshot,
  requestStartedAt = Date.now(),
): ClientSummaryState {
  const observation = createSessionCollectionObservation(
    requestStartedAt,
    snapshot.catalog ? "partial-snapshot" : "full-snapshot",
    "global-sessions",
  );
  let next = state;
  for (const row of snapshot.sessions) {
    next = upsertSnapshotRecord(next, row, observation);
  }
  return upsertQuery(next, snapshot, requestStartedAt);
}

export function applyProjectsCollectionSnapshot(
  state: ClientSummaryState,
  snapshot: ProjectsCollectionSnapshot,
  requestStartedAt = Date.now(),
): ClientSummaryState {
  let next = state;
  for (const project of snapshot.projects) {
    next = putProjectRecord(next, project, requestStartedAt);
  }
  return putProjectsQuery(next, snapshot.projects, requestStartedAt);
}

export function applyProjectCollectionSnapshot(
  state: ClientSummaryState,
  snapshot: ProjectCollectionSnapshot,
  requestStartedAt = Date.now(),
): ClientSummaryState {
  return putProjectRecord(state, snapshot.project, requestStartedAt);
}

export function applyProjectQueueCollectionSnapshot(
  state: ClientSummaryState,
  snapshot: ProjectQueueCollectionSnapshot,
  requestStartedAt = Date.now(),
): ClientSummaryState {
  return putProjectQueueSnapshot(state, snapshot, requestStartedAt);
}

export function applyProjectQueueGlobalCollectionSnapshot(
  state: ClientSummaryState,
  snapshot: ProjectQueueGlobalCollectionSnapshot,
  requestStartedAt = Date.now(),
): ClientSummaryState {
  return putProjectQueueGlobalSnapshot(state, snapshot, requestStartedAt);
}

export function applyProjectQueueCollectionChanged(
  state: ClientSummaryState,
  event: ProjectQueueChangedEvent,
  observedAt = Date.now(),
): ClientSummaryState {
  return putProjectQueueSnapshot(
    state,
    {
      projectId: event.projectId,
      items: event.items,
      dispatchState: event.dispatchState,
    },
    observedAt,
  );
}

export function applyInboxCollectionSnapshot(
  state: ClientSummaryState,
  snapshot: InboxCollectionSnapshot,
  requestStartedAt = Date.now(),
): ClientSummaryState {
  return putInboxSnapshot(state, snapshot, requestStartedAt);
}

export function applySessionCollectionIdRemapped(
  state: ClientSummaryState,
  event: SessionIdRemappedEvent,
): ClientSummaryState {
  const oldSessionId = resolveSessionCollectionId(state, event.oldSessionId);
  const newSessionId = resolveSessionCollectionId(state, event.newSessionId);
  if (oldSessionId === newSessionId) {
    return state;
  }

  const aliases = new Map(state.sessions.aliases);
  aliases.delete(newSessionId);
  for (const [alias, target] of aliases) {
    if (resolveSessionCollectionId(state, target) === oldSessionId) {
      aliases.set(alias, newSessionId);
    }
  }
  aliases.delete(event.oldSessionId);
  aliases.set(event.oldSessionId, newSessionId);
  if (oldSessionId !== event.oldSessionId) {
    aliases.delete(oldSessionId);
    aliases.set(oldSessionId, newSessionId);
  }
  while (aliases.size > MAX_SESSION_ID_ALIASES) {
    const oldestAlias = aliases.keys().next().value;
    if (oldestAlias === undefined) break;
    aliases.delete(oldestAlias);
  }

  let next: ClientSummaryState = {
    ...state,
    sessions: {
      ...state.sessions,
      aliases,
    },
  };

  const entities = new Map(next.sessions.entities);
  let provisionalRecord: SessionCollectionRecord | undefined;
  for (const [sessionId, record] of entities) {
    if (
      sessionId !== newSessionId &&
      resolveSessionCollectionId(next, sessionId) === newSessionId
    ) {
      provisionalRecord = mergeRemappedSessionRecords(
        provisionalRecord,
        record,
        newSessionId,
      );
      entities.delete(sessionId);
    }
  }
  const mergedRecord = mergeRemappedSessionRecords(
    provisionalRecord,
    entities.get(newSessionId),
    newSessionId,
  );
  if (mergedRecord) {
    entities.set(newSessionId, mergedRecord);
  }
  for (const [sessionId, record] of entities) {
    const parentSessionId = record.parentSessionId
      ? resolveSessionCollectionId(next, record.parentSessionId)
      : undefined;
    const forkedFromSessionId = record.forkedFromSessionId
      ? resolveSessionCollectionId(next, record.forkedFromSessionId)
      : undefined;
    if (
      parentSessionId !== record.parentSessionId ||
      forkedFromSessionId !== record.forkedFromSessionId
    ) {
      entities.set(sessionId, {
        ...record,
        parentSessionId,
        forkedFromSessionId,
      });
    }
  }

  const queries = new Map(next.sessions.queries);
  for (const [key, query] of queries) {
    const ids = uniqueResolvedSessionIds(next, query.ids);
    if (
      ids.length !== query.ids.length ||
      ids.some((id, index) => id !== query.ids[index])
    ) {
      queries.set(key, { ...query, ids });
    }
  }
  next = {
    ...next,
    sessions: {
      ...next.sessions,
      entities,
      queries,
    },
  };

  const tiers = createEmptyInboxTierRecord<string[]>(() => []);
  const seenInboxSessionIds = new Set<string>();
  for (const tier of INBOX_TIERS) {
    for (const sessionId of uniqueResolvedSessionIds(
      next,
      next.inbox.tiers[tier],
    )) {
      if (!seenInboxSessionIds.has(sessionId)) {
        seenInboxSessionIds.add(sessionId);
        tiers[tier].push(sessionId);
      }
    }
  }

  const byProject = new Map(next.projectQueues.byProject);
  for (const [projectId, record] of byProject) {
    const items = remapProjectQueueItems(next, record.items);
    if (items !== record.items) {
      byProject.set(projectId, { ...record, items });
    }
  }
  const globalItems = remapProjectQueueItems(
    next,
    next.projectQueues.globalItems,
  );
  const recoveredSessionQueues = remapRecoveredSessionQueues(
    next,
    next.projectQueues.recoveredSessionQueues,
  );

  const bySessionId = new Map(next.providerRuntime.bySessionId);
  let remappedRuntime = bySessionId.get(newSessionId);
  for (const [sessionId, runtime] of bySessionId) {
    if (
      sessionId === newSessionId ||
      resolveSessionCollectionId(next, sessionId) !== newSessionId
    ) {
      continue;
    }
    if (!remappedRuntime || runtime.observedAt > remappedRuntime.observedAt) {
      remappedRuntime = {
        ...runtime,
        sessionId: newSessionId,
      };
    }
    bySessionId.delete(sessionId);
  }
  if (remappedRuntime) {
    bySessionId.set(newSessionId, {
      ...remappedRuntime,
      sessionId: newSessionId,
    });
  }

  return {
    ...next,
    projectQueues: {
      ...next.projectQueues,
      byProject,
      globalItems,
      recoveredSessionQueues,
    },
    inbox: {
      ...next.inbox,
      tiers,
    },
    localDecorations: {
      ...next.localDecorations,
      draftSessionIds: new Set(
        uniqueResolvedSessionIds(next, [
          ...next.localDecorations.draftSessionIds,
        ]),
      ),
    },
    providerRuntime: {
      ...next.providerRuntime,
      bySessionId,
    },
  };
}

export function applyDraftSessionIdsSnapshot(
  state: ClientSummaryState,
  draftSessionIds: ReadonlySet<string>,
  observedAt = Date.now(),
): ClientSummaryState {
  const resolvedDraftSessionIds = new Set(
    [...draftSessionIds].map((sessionId) =>
      resolveSessionCollectionId(state, sessionId),
    ),
  );
  if (
    stringSetsEqual(
      state.localDecorations.draftSessionIds,
      resolvedDraftSessionIds,
    )
  ) {
    return state;
  }

  return {
    ...state,
    localDecorations: {
      ...state.localDecorations,
      draftSessionIds: resolvedDraftSessionIds,
      draftObservedAt: observedAt,
    },
  };
}

export function applyProviderRuntimeStatusChanged(
  state: ClientSummaryState,
  event: ProviderRuntimeStatusChangedEvent,
  observedAt = Date.now(),
): ClientSummaryState {
  return putProviderRuntimeStatus(
    state,
    event.sessionId,
    event.projectId,
    event.providerRuntimeStatus,
    observedAt,
  );
}

export function applyProviderRuntimeStatusFromSessionSnapshot(
  state: ClientSummaryState,
  snapshot: ProviderRuntimeStatusSnapshot,
  observedAt = Date.now(),
): ClientSummaryState {
  if (snapshot.providerRuntimeStatus === undefined) {
    return state;
  }
  return putProviderRuntimeStatus(
    state,
    snapshot.sessionId,
    snapshot.projectId,
    snapshot.providerRuntimeStatus,
    observedAt,
  );
}

export function applySessionCollectionCreated(
  state: ClientSummaryState,
  event: SessionCreatedEvent,
  observedAt = Date.now(),
): ClientSummaryState {
  const observation = createSessionCollectionObservation(
    observedAt,
    "partial-event",
    "session-created",
  );
  const session = event.session;
  let record = getRecord(state, session.id);

  record = withContentFields(
    record,
    {
      title: session.title,
      fullTitle: session.fullTitle,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      messageCount: session.messageCount,
      provider: session.provider,
      model: session.model,
      initialPrompt: session.initialPrompt,
      lastAgentText: session.lastAgentText,
      asyncQuestions: session.asyncQuestions,
      providerChildren: session.providerChildren,
    },
    observation,
  );

  record = withMetadataFields(
    record,
    {
      customTitle: session.customTitle,
      isArchived: session.isArchived,
      isStarred: session.isStarred,
      parentSessionId: session.parentSessionId,
      parentSessionKind: session.parentSessionKind,
      forkedFromSessionId: session.forkedFromSessionId,
    },
    observation,
  );

  record = withProjectHint(
    record,
    {
      projectId: session.projectId,
      projectName: session.projectName ?? record.projectName,
    },
    observation,
  );

  record = withLifecycleFields(
    record,
    {
      ownership: session.ownership,
      activity: session.activity,
      pendingInputType: session.pendingInputType,
    },
    observation,
  );

  record = withUnreadField(record, session.hasUnread, observation);

  return putRecord(state, {
    ...record,
    eventCreatedAt: observedAt,
    observedAt: Math.max(record.observedAt, observedAt),
  });
}

export function applySessionCollectionUpdated(
  state: ClientSummaryState,
  event: SessionUpdatedEvent,
  observedAt = Date.now(),
): ClientSummaryState {
  const observation = createSessionCollectionObservation(
    observedAt,
    "partial-event",
    "session-updated",
  );
  const record = withContentFields(
    getRecord(state, event.sessionId),
    {
      title: event.title,
      updatedAt: event.updatedAt,
      messageCount: event.messageCount,
      model: event.model,
      lastAgentText: event.lastAgentText,
      asyncQuestions: event.asyncQuestions,
    },
    observation,
  );
  return putRecord(state, record);
}

export function applySessionCollectionMetadataChanged(
  state: ClientSummaryState,
  event: SessionMetadataChangedEvent,
  observedAt = Date.now(),
): ClientSummaryState {
  const observation = createSessionCollectionObservation(
    observedAt,
    "partial-event",
    "metadata-changed",
  );
  const record = withMetadataFields(
    getRecord(state, event.sessionId),
    {
      customTitle: event.title,
      isArchived: event.archived,
      isStarred: event.starred,
      parentSessionId: event.parentSessionId,
      parentSessionKind: event.parentSessionKind,
      forkedFromSessionId: event.forkedFromSessionId,
    },
    observation,
  );
  const projectRecord =
    event.projectId !== undefined &&
    record.projectId !== undefined &&
    event.projectId !== record.projectId
      ? { ...record, projectName: undefined }
      : record;
  const withProject = withProjectFields(
    projectRecord,
    { projectId: event.projectId },
    observation,
  );
  return putRecord(state, withProject);
}

export function applySessionCollectionStatusChanged(
  state: ClientSummaryState,
  event: SessionStatusEvent,
  observedAt = Date.now(),
): ClientSummaryState {
  const observation = createSessionCollectionObservation(
    observedAt,
    "partial-event",
    "session-status",
  );
  let record = getRecord(state, event.sessionId);
  record = withProjectHint(record, { projectId: event.projectId }, observation);
  record = withLifecycleFields(
    record,
    {
      ownership: event.ownership,
      activity: event.ownership.owner === "none" ? "idle" : record.activity,
      pendingInputType: record.pendingInputType,
    },
    observation,
  );
  return putRecord(state, record);
}

export function applySessionCollectionProcessStateChanged(
  state: ClientSummaryState,
  event: ProcessStateEvent,
  observedAt = Date.now(),
): ClientSummaryState {
  const observation = createSessionCollectionObservation(
    observedAt,
    "partial-event",
    "process-state",
  );
  let record = getRecord(state, event.sessionId);
  record = withProjectHint(record, { projectId: event.projectId }, observation);
  record = withLifecycleFields(
    record,
    {
      activity: event.activity,
      pendingInputType: event.pendingInputType,
    },
    observation,
  );
  return putRecord(state, record);
}

export function applySessionCollectionSeen(
  state: ClientSummaryState,
  event: SessionSeenEvent,
  observedAt = Date.now(),
): ClientSummaryState {
  const observation = createSessionCollectionObservation(
    observedAt,
    "partial-event",
    "session-seen",
  );
  const record = withUnreadField(
    getRecord(state, event.sessionId),
    event.timestamp === "",
    observation,
  );
  return putRecord(state, record);
}
