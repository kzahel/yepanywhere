import type {
  ProjectQueueItemSummary,
  ProjectQueueProjectStatus,
  ProjectQueueRecoveredSessionQueueSummary,
  ProviderRuntimeStatus,
  UrlProjectId,
} from "@yep-anywhere/shared";
import { describe, expect, it } from "vitest";
import type { GlobalSessionItem, InboxItem } from "../../api/client";
import type { Project as GlobalProject } from "../../types";
import type {
  SessionCreatedEvent,
  SessionIdRemappedEvent,
} from "../activityBus";
import {
  applyDraftSessionIdsSnapshot,
  applyGlobalSessionsCollectionSnapshot,
  applyInboxCollectionSnapshot,
  applyProjectCollectionSnapshot,
  applyProjectsCollectionSnapshot,
  applyProjectQueueCollectionChanged,
  applyProjectQueueCollectionSnapshot,
  applyProjectQueueGlobalCollectionSnapshot,
  applyProviderRuntimeStatusChanged,
  applyProviderRuntimeStatusFromSessionSnapshot,
  applySessionCollectionCreated,
  applySessionCollectionIdRemapped,
  applySessionCollectionMetadataChanged,
  applySessionCollectionProcessStateChanged,
  applySessionCollectionSeen,
  applySessionCollectionUpdated,
  createEmptyClientSummaryState,
} from "../clientSummaryState";
import {
  createGlobalSessionsQueryKey,
  selectActiveAgentCount,
  selectActiveProjectSessionIds,
  selectDraftSessionIds,
  selectHasActiveAgents,
  selectInboxCounts,
  selectInboxCountsByProject,
  selectInboxResponse,
  selectRecentSessionRecords,
  selectRecentSessionRecordsFromRecords,
  selectProjectCollectionRecord,
  selectProjectCollectionRecords,
  selectProjectQueuedSessionIds,
  selectProjectQueueDispatchState,
  selectProjectQueueItems,
  selectProjectQueueProjectStatusesByProject,
  selectProjectQueueRecoveredSessionQueues,
  selectProjectQueueSidebarCount,
  selectProviderRuntimeStatusForSession,
  selectSessionCollectionQueryRecords,
  selectSessionCollectionQueryState,
  selectSessionCollectionRecord,
  selectStarredSessionRecords,
  selectStarredSessionRecordsFromRecords,
} from "../clientSummaryQueries";
import { sessionCollectionRecordToGlobalSessionItem } from "../sessionCollectionRecords";

const PROJECT_ID = "project-1" as UrlProjectId;
const NOW = Date.parse("2026-06-27T12:00:00.000Z");
const RECENT = "2026-06-27T11:00:00.000Z";

it("shares both mark-read and mark-unread events and accepts later server state", () => {
  let state = applySessionCollectionSeen(
    createEmptyClientSummaryState(),
    {
      type: "session-seen",
      sessionId: "session-1",
      timestamp: RECENT,
    },
    NOW,
  );
  expect(selectSessionCollectionRecord(state, "session-1")?.hasUnread).toBe(
    false,
  );
  state = applySessionCollectionSeen(
    state,
    {
      type: "session-seen",
      sessionId: "session-1",
      timestamp: "",
    },
    NOW + 1,
  );
  expect(selectSessionCollectionRecord(state, "session-1")?.hasUnread).toBe(
    true,
  );
  state = applySessionCollectionSeen(
    state,
    {
      type: "session-seen",
      sessionId: "session-1",
      timestamp: RECENT,
    },
    NOW + 2,
  );
  expect(selectSessionCollectionRecord(state, "session-1")?.hasUnread).toBe(
    false,
  );
});
const RUNTIME_STATUS: Exclude<ProviderRuntimeStatus, null> = {
  kind: "retrying",
  provider: "claude",
  reason: "rate_limit",
  httpStatus: 429,
  startedAt: "2026-06-27T11:00:00.000Z",
  lastSeenAt: "2026-06-27T11:00:00.000Z",
  retryAt: "2026-06-27T12:00:00.000Z",
  retryDelayMs: 3_600_000,
  eventCount: 1,
  source: "claude.system.api_retry",
};

function globalSession(
  id: string,
  overrides: Partial<GlobalSessionItem> = {},
): GlobalSessionItem {
  return {
    id,
    title: `Session ${id}`,
    fullTitle: `Session ${id}`,
    createdAt: RECENT,
    updatedAt: RECENT,
    messageCount: 1,
    provider: "claude",
    projectId: PROJECT_ID,
    projectName: "Project",
    ownership: { owner: "none" },
    isArchived: false,
    isStarred: false,
    ...overrides,
  };
}

function inboxItem(id: string, overrides: Partial<InboxItem> = {}): InboxItem {
  return {
    sessionId: id,
    projectId: PROJECT_ID,
    projectName: "Project",
    sessionTitle: `Session ${id}`,
    updatedAt: RECENT,
    hasUnread: false,
    ...overrides,
  };
}

function createdEvent(
  id: string,
  overrides: Partial<SessionCreatedEvent["session"]> = {},
): SessionCreatedEvent {
  return {
    type: "session-created",
    session: {
      id,
      projectId: PROJECT_ID,
      title: `Session ${id}`,
      fullTitle: `Session ${id}`,
      createdAt: RECENT,
      updatedAt: RECENT,
      messageCount: 1,
      ownership: { owner: "self", processId: "process-1" },
      provider: "claude",
      activity: "in-turn",
      ...overrides,
    },
    timestamp: RECENT,
  };
}

function project(
  id: string,
  overrides: Partial<GlobalProject> = {},
): GlobalProject {
  return {
    id,
    path: `/tmp/${id}`,
    name: `Project ${id}`,
    sessionCount: 1,
    activeOwnedCount: 0,
    activeExternalCount: 0,
    projectQueueBlockingCount: 0,
    lastActivity: RECENT,
    ...overrides,
  };
}

function queueItem(
  id: string,
  overrides: Partial<ProjectQueueItemSummary> = {},
): ProjectQueueItemSummary {
  return {
    id,
    projectId: PROJECT_ID,
    target: { type: "existing-session", sessionId: `session-${id}` },
    messagePreview: `Message ${id}`,
    message: { text: `Message ${id}` },
    createdAt: `2026-06-27T11:00:0${id}.000Z`,
    updatedAt: `2026-06-27T11:00:0${id}.000Z`,
    status: "queued",
    attachmentCount: 0,
    ...overrides,
  };
}

function recoveredSessionQueue(
  id: string,
  overrides: Partial<ProjectQueueRecoveredSessionQueueSummary> = {},
): ProjectQueueRecoveredSessionQueueSummary {
  return {
    id,
    tempId: `temp-${id}`,
    sessionId: `session-${id}`,
    projectId: PROJECT_ID,
    content: `Recovered ${id}`,
    timestamp: `2026-06-27T11:00:0${id}.000Z`,
    queuedAt: `2026-06-27T11:00:0${id}.000Z`,
    createdAt: `2026-06-27T11:00:0${id}.000Z`,
    updatedAt: `2026-06-27T11:00:0${id}.000Z`,
    kind: "patient",
    status: "paused-after-restart",
    ...overrides,
  };
}

function projectQueueStatus(
  state: ProjectQueueProjectStatus["state"],
  overrides: Partial<ProjectQueueProjectStatus> = {},
): ProjectQueueProjectStatus {
  return {
    projectId: PROJECT_ID,
    state,
    idle: state !== "blocked",
    blockers: state === "blocked" ? ["session-1:in-turn"] : [],
    dispatchPaused: state === "paused",
    inFlight: state === "dispatching",
    quietWindowMs: 30_000,
    itemCount: state === "empty" ? 0 : 1,
    nextItemId: state === "empty" ? undefined : "1",
    ...overrides,
  };
}

describe("clientSummaryState", () => {
  it("preserves question previews across partial updates and projects known empty results", () => {
    const asyncQuestions = {
      omitted: false,
      questions: [
        { messageId: "question", index: 0, title: "Continue?", age: 1 },
      ],
    };
    let state = applySessionCollectionUpdated(
      createEmptyClientSummaryState(),
      {
        type: "session-updated",
        sessionId: "session",
        projectId: PROJECT_ID,
        timestamp: RECENT,
        updatedAt: RECENT,
        asyncQuestions,
      },
      100,
    );
    state = applySessionCollectionUpdated(
      state,
      {
        type: "session-updated",
        sessionId: "session",
        projectId: PROJECT_ID,
        timestamp: RECENT,
        updatedAt: RECENT,
        title: "New title",
      },
      200,
    );
    expect(
      selectSessionCollectionRecord(state, "session")?.asyncQuestions,
    ).toEqual(asyncQuestions);
    state = applySessionCollectionUpdated(
      state,
      {
        type: "session-updated",
        sessionId: "session",
        projectId: PROJECT_ID,
        timestamp: RECENT,
        updatedAt: RECENT,
        asyncQuestions: { omitted: false, questions: [] },
      },
      300,
    );
    expect(
      selectSessionCollectionRecord(state, "session")?.asyncQuestions
        ?.questions,
    ).toEqual([]);
  });

  it("merges a provisional session ID into every canonical projection", () => {
    const temporaryId = "temporary-session";
    const canonicalId = "canonical-session";
    const remapped: SessionIdRemappedEvent = {
      type: "session-id-remapped",
      oldSessionId: temporaryId,
      newSessionId: canonicalId,
      projectId: PROJECT_ID,
      processId: "process-1",
      provider: "claude",
      timestamp: RECENT,
    };
    let state = applySessionCollectionCreated(
      createEmptyClientSummaryState(),
      createdEvent(temporaryId, { title: "Claude" }),
      200,
    );
    state = applyGlobalSessionsCollectionSnapshot(
      state,
      {
        query: { scope: "global-sessions", limit: 50 },
        sessions: [
          globalSession(canonicalId, {
            title: "Claude Fable",
            model: "claude-fable-5",
            ownership: { owner: "self", processId: "process-1" },
            activity: "in-turn",
          }),
          globalSession("child-session", {
            parentSessionId: temporaryId,
          }),
          globalSession("fork-session", {
            forkedFromSessionId: temporaryId,
          }),
        ],
        hasMore: false,
      },
      250,
    );
    state = applyInboxCollectionSnapshot(
      state,
      {
        needsAttention: [],
        active: [
          inboxItem(temporaryId, {
            sessionTitle: "Claude",
            activity: "in-turn",
          }),
          inboxItem(canonicalId, {
            sessionTitle: "Claude Fable",
            activity: "in-turn",
          }),
        ],
        recentActivity: [],
        unread8h: [],
        unread24h: [],
      },
      260,
    );
    state = applyDraftSessionIdsSnapshot(state, new Set([temporaryId]), 270);
    state = applyProviderRuntimeStatusChanged(
      state,
      {
        type: "provider-runtime-status-changed",
        sessionId: temporaryId,
        projectId: PROJECT_ID,
        providerRuntimeStatus: RUNTIME_STATUS,
        timestamp: RECENT,
      },
      280,
    );
    state = applyProjectQueueGlobalCollectionSnapshot(
      state,
      {
        items: [
          queueItem("1", {
            target: { type: "existing-session", sessionId: temporaryId },
            createdFrom: { sessionId: temporaryId },
          }),
        ],
        recoveredSessionQueues: [
          recoveredSessionQueue("1", { sessionId: temporaryId }),
        ],
      },
      290,
    );

    state = applySessionCollectionIdRemapped(state, remapped);

    expect([...state.sessions.entities.keys()]).not.toContain(temporaryId);
    expect(selectSessionCollectionRecord(state, temporaryId)).toMatchObject({
      id: canonicalId,
      title: "Claude Fable",
      model: "claude-fable-5",
      activity: "in-turn",
    });
    expect(
      selectSessionCollectionQueryRecords(state, {
        scope: "global-sessions",
        limit: 50,
      }).map((record) => record.id),
    ).toEqual([canonicalId, "child-session", "fork-session"]);
    expect(selectInboxResponse(state).needsAttention).toEqual([]);
    expect(selectInboxResponse(state).active[0]?.sessionId).toBe(canonicalId);
    expect([...selectDraftSessionIds(state)]).toEqual([canonicalId]);
    expect(selectProviderRuntimeStatusForSession(state, temporaryId)).toEqual(
      RUNTIME_STATUS,
    );
    expect(selectProjectQueueItems(state, PROJECT_ID)[0]).toMatchObject({
      target: { type: "existing-session", sessionId: canonicalId },
      createdFrom: { sessionId: canonicalId },
    });
    expect(selectProjectQueueRecoveredSessionQueues(state)[0]?.sessionId).toBe(
      canonicalId,
    );
    expect(
      selectSessionCollectionRecord(state, "child-session")?.parentSessionId,
    ).toBe(canonicalId);
    expect(
      selectSessionCollectionRecord(state, "fork-session")?.forkedFromSessionId,
    ).toBe(canonicalId);

    state = applyGlobalSessionsCollectionSnapshot(
      state,
      {
        query: { scope: "global-sessions", limit: 50 },
        sessions: [
          globalSession("late-fork-session", {
            forkedFromSessionId: temporaryId,
          }),
        ],
        hasMore: false,
      },
      295,
    );
    expect(
      selectSessionCollectionRecord(state, "late-fork-session")
        ?.forkedFromSessionId,
    ).toBe(canonicalId);

    state = applySessionCollectionUpdated(
      state,
      {
        type: "session-updated",
        sessionId: temporaryId,
        projectId: PROJECT_ID,
        title: "Late canonical update",
        updatedAt: RECENT,
        timestamp: RECENT,
      },
      300,
    );

    expect([...state.sessions.entities.keys()]).not.toContain(temporaryId);
    expect(selectSessionCollectionRecord(state, canonicalId)?.title).toBe(
      "Late canonical update",
    );
  });

  it("merges remapped field groups by their own observation freshness", () => {
    const temporaryId = "temporary-session";
    const canonicalId = "canonical-session";
    let state = applySessionCollectionProcessStateChanged(
      createEmptyClientSummaryState(),
      {
        type: "process-state-changed",
        sessionId: temporaryId,
        projectId: PROJECT_ID,
        activity: "waiting-input",
        pendingInputType: "tool-approval",
        timestamp: RECENT,
      },
      300,
    );
    state = applyGlobalSessionsCollectionSnapshot(
      state,
      {
        query: { scope: "global-sessions", limit: 50 },
        sessions: [
          globalSession(canonicalId, {
            activity: "in-turn",
            ownership: { owner: "self", processId: "process-1" },
          }),
        ],
        hasMore: false,
      },
      250,
    );

    state = applySessionCollectionIdRemapped(state, {
      type: "session-id-remapped",
      oldSessionId: temporaryId,
      newSessionId: canonicalId,
      projectId: PROJECT_ID,
      processId: "process-1",
      provider: "claude",
      timestamp: RECENT,
    });

    expect(selectSessionCollectionRecord(state, canonicalId)).toMatchObject({
      activity: "waiting-input",
      pendingInputType: "tool-approval",
      lifecycleObservedAt: 300,
    });

    state = applyGlobalSessionsCollectionSnapshot(
      state,
      {
        query: { scope: "global-sessions", limit: 50 },
        sessions: [
          globalSession(canonicalId, {
            activity: "in-turn",
            ownership: { owner: "self", processId: "process-1" },
          }),
        ],
        hasMore: false,
      },
      275,
    );

    expect(selectSessionCollectionRecord(state, canonicalId)).toMatchObject({
      activity: "waiting-input",
      pendingInputType: "tool-approval",
      lifecycleObservedAt: 300,
    });
  });

  it("stores and clears provider runtime status by session", () => {
    let state = createEmptyClientSummaryState();

    state = applyProviderRuntimeStatusFromSessionSnapshot(
      state,
      {
        sessionId: "session-1",
        projectId: PROJECT_ID,
        providerRuntimeStatus: RUNTIME_STATUS,
      },
      100,
    );

    expect(selectProviderRuntimeStatusForSession(state, "session-1")).toEqual(
      RUNTIME_STATUS,
    );

    state = applyProviderRuntimeStatusChanged(
      state,
      {
        type: "provider-runtime-status-changed",
        sessionId: "session-1",
        projectId: PROJECT_ID,
        providerRuntimeStatus: null,
        timestamp: "2026-06-27T11:01:00.000Z",
      },
      200,
    );

    expect(selectProviderRuntimeStatusForSession(state, "session-1")).toBe(
      null,
    );
  });

  it("keeps newer provider runtime events over older snapshots", () => {
    let state = applyProviderRuntimeStatusChanged(
      createEmptyClientSummaryState(),
      {
        type: "provider-runtime-status-changed",
        sessionId: "session-1",
        projectId: PROJECT_ID,
        providerRuntimeStatus: { ...RUNTIME_STATUS, eventCount: 2 },
        timestamp: "2026-06-27T11:02:00.000Z",
      },
      200,
    );

    state = applyProviderRuntimeStatusFromSessionSnapshot(
      state,
      {
        sessionId: "session-1",
        projectId: PROJECT_ID,
        providerRuntimeStatus: RUNTIME_STATUS,
      },
      100,
    );

    const status = selectProviderRuntimeStatusForSession(state, "session-1");
    expect(status?.kind).toBe("retrying");
    expect(status?.kind === "retrying" ? status.eventCount : null).toBe(2);
  });

  it("keeps an event-created entity when an older snapshot omits it", () => {
    let state = applySessionCollectionCreated(
      createEmptyClientSummaryState(),
      createdEvent("new-session"),
      200,
    );

    state = applyGlobalSessionsCollectionSnapshot(
      state,
      {
        query: { scope: "global-sessions", limit: 50 },
        sessions: [],
        hasMore: false,
        mode: "replace",
      },
      100,
    );

    expect(selectSessionCollectionRecord(state, "new-session")).toMatchObject({
      id: "new-session",
      activity: "in-turn",
    });
    expect(selectRecentSessionRecords(state, NOW).map((s) => s.id)).toEqual([
      "new-session",
    ]);
  });

  it("uses project names from session-created events", () => {
    const state = applySessionCollectionCreated(
      createEmptyClientSummaryState(),
      createdEvent("new-session", { projectName: "Readable Project" }),
      200,
    );

    const record = selectSessionCollectionRecord(state, "new-session");
    const item = record
      ? sessionCollectionRecordToGlobalSessionItem(record)
      : null;

    expect(record?.projectName).toBe("Readable Project");
    expect(item?.projectName).toBe("Readable Project");
  });

  it("keeps relocated membership across later launch-project events", () => {
    const relocatedProjectId = "project-2" as UrlProjectId;
    let state = applyGlobalSessionsCollectionSnapshot(
      createEmptyClientSummaryState(),
      {
        query: { scope: "global-sessions", limit: 50 },
        sessions: [globalSession("moved-session")],
        hasMore: false,
      },
      100,
    );

    state = applySessionCollectionMetadataChanged(
      state,
      {
        type: "session-metadata-changed",
        sessionId: "moved-session",
        projectId: relocatedProjectId,
        timestamp: "2026-06-27T11:01:00.000Z",
      },
      200,
    );
    state = applySessionCollectionProcessStateChanged(
      state,
      {
        type: "process-state-changed",
        sessionId: "moved-session",
        projectId: PROJECT_ID,
        activity: "in-turn",
        timestamp: "2026-06-27T11:02:00.000Z",
      },
      300,
    );
    state = applySessionCollectionCreated(
      state,
      createdEvent("moved-session", {
        projectId: PROJECT_ID,
        projectName: "Launch project",
      }),
      400,
    );

    expect(selectSessionCollectionRecord(state, "moved-session")).toMatchObject(
      {
        projectId: relocatedProjectId,
        activity: "in-turn",
      },
    );
    expect(
      selectSessionCollectionRecord(state, "moved-session")?.projectName,
    ).toBeUndefined();
  });

  it("keeps archived helpers out across either live-event ordering", () => {
    const query = { scope: "global-sessions" as const, limit: 50 };
    const helperCreated = createdEvent("recap-helper", {
      ownership: { owner: "none" },
      activity: undefined,
    });
    const helperRow = globalSession("recap-helper", {
      isArchived: undefined,
    });
    const helperArchived = {
      type: "session-metadata-changed" as const,
      sessionId: "recap-helper",
      title: "Recap generator",
      archived: true,
      forkedFromSessionId: "source-session",
      timestamp: RECENT,
    };
    const emptySnapshot = () =>
      applyGlobalSessionsCollectionSnapshot(
        createEmptyClientSummaryState(),
        { query, sessions: [], hasMore: false },
        100,
      );
    const prependHelper = (
      state: ReturnType<typeof createEmptyClientSummaryState>,
      observedAt: number,
    ) =>
      applyGlobalSessionsCollectionSnapshot(
        state,
        {
          query,
          sessions: [helperRow],
          hasMore: false,
          mode: "prepend",
        },
        observedAt,
      );
    const visibleIds = (
      state: ReturnType<typeof createEmptyClientSummaryState>,
    ) =>
      selectRecentSessionRecordsFromRecords(
        selectSessionCollectionQueryRecords(state, query),
        NOW,
      ).map((session) => session.id);

    let metadataFirst = applySessionCollectionMetadataChanged(
      emptySnapshot(),
      helperArchived,
      200,
    );
    metadataFirst = applySessionCollectionCreated(
      metadataFirst,
      helperCreated,
      300,
    );
    metadataFirst = prependHelper(metadataFirst, 300);

    expect(visibleIds(metadataFirst)).toEqual([]);
    expect(
      selectSessionCollectionRecord(metadataFirst, "recap-helper"),
    ).toMatchObject({
      customTitle: "Recap generator",
      isArchived: true,
      forkedFromSessionId: "source-session",
    });

    let creationFirst = applySessionCollectionCreated(
      emptySnapshot(),
      helperCreated,
      200,
    );
    creationFirst = prependHelper(creationFirst, 200);
    expect(visibleIds(creationFirst)).toEqual(["recap-helper"]);

    creationFirst = applySessionCollectionMetadataChanged(
      creationFirst,
      helperArchived,
      300,
    );
    expect(visibleIds(creationFirst)).toEqual([]);
  });

  it("backfills missing fields from older full snapshots after partial live updates", () => {
    let state = applySessionCollectionProcessStateChanged(
      createEmptyClientSummaryState(),
      {
        type: "process-state-changed",
        sessionId: "active-starred",
        projectId: PROJECT_ID,
        activity: "in-turn",
        timestamp: RECENT,
      },
      200,
    );

    state = applySessionCollectionUpdated(
      state,
      {
        type: "session-updated",
        sessionId: "active-starred",
        projectId: PROJECT_ID,
        title: "Live title",
        updatedAt: RECENT,
        messageCount: 2,
        timestamp: RECENT,
      },
      200,
    );

    state = applyGlobalSessionsCollectionSnapshot(
      state,
      {
        query: { scope: "global-sessions", starred: true },
        sessions: [
          globalSession("active-starred", {
            title: "Snapshot title",
            fullTitle: "Snapshot full title",
            messageCount: 10,
            ownership: { owner: "self", processId: "process-1" },
            isStarred: true,
          }),
        ],
        hasMore: false,
      },
      100,
    );

    const [record] = selectStarredSessionRecordsFromRecords(
      selectSessionCollectionQueryRecords(state, {
        scope: "global-sessions",
        starred: true,
      }),
    );
    const item = record
      ? sessionCollectionRecordToGlobalSessionItem(record)
      : null;

    expect(record).toMatchObject({
      id: "active-starred",
      title: "Live title",
      provider: "claude",
      createdAt: RECENT,
      isStarred: true,
      ownership: { owner: "self", processId: "process-1" },
      activity: "in-turn",
    });
    expect(record?.messageCount).toBe(2);
    expect(item?.id).toBe("active-starred");
  });

  it("does not use encoded project ids as created event project names", () => {
    const state = applySessionCollectionCreated(
      createEmptyClientSummaryState(),
      createdEvent("new-session"),
      200,
    );

    const record = selectSessionCollectionRecord(state, "new-session");
    const item = record
      ? sessionCollectionRecordToGlobalSessionItem(record)
      : null;

    expect(record?.projectName).toBeUndefined();
    expect(item?.projectName).toBe("");
  });

  it("moves starred rows between derived projections from one entity", () => {
    let state = applyGlobalSessionsCollectionSnapshot(
      createEmptyClientSummaryState(),
      {
        query: { scope: "global-sessions", limit: 50 },
        sessions: [globalSession("session-1")],
        hasMore: false,
      },
      100,
    );

    expect(selectRecentSessionRecords(state, NOW).map((s) => s.id)).toEqual([
      "session-1",
    ]);
    expect(selectStarredSessionRecords(state)).toEqual([]);

    state = applySessionCollectionMetadataChanged(
      state,
      {
        type: "session-metadata-changed",
        sessionId: "session-1",
        starred: true,
        timestamp: "2026-06-27T12:00:01.000Z",
      },
      200,
    );

    expect(selectRecentSessionRecords(state, NOW)).toEqual([]);
    expect(selectStarredSessionRecords(state).map((s) => s.id)).toEqual([
      "session-1",
    ]);
  });

  it("clears typed lineage from explicit metadata events", () => {
    let state = applyGlobalSessionsCollectionSnapshot(
      createEmptyClientSummaryState(),
      {
        query: { scope: "global-sessions", limit: 50 },
        sessions: [
          globalSession("session-1", {
            parentSessionId: "mother-1",
            parentSessionKind: "btw-aside",
            forkedFromSessionId: "source-1",
          }),
        ],
        hasMore: false,
      },
      100,
    );

    state = applySessionCollectionMetadataChanged(
      state,
      {
        type: "session-metadata-changed",
        sessionId: "session-1",
        parentSessionId: null,
        parentSessionKind: null,
        forkedFromSessionId: null,
        timestamp: "2026-06-27T12:00:01.000Z",
      },
      200,
    );

    expect(selectSessionCollectionRecord(state, "session-1")).toMatchObject({
      parentSessionId: undefined,
      parentSessionKind: undefined,
      forkedFromSessionId: undefined,
    });
  });

  it("projects sidebar sections from explicit query memberships", () => {
    let state = applyGlobalSessionsCollectionSnapshot(
      createEmptyClientSummaryState(),
      {
        query: { scope: "global-sessions" },
        sessions: [
          globalSession("recent-unstarred"),
          globalSession("recent-starred", { isStarred: true }),
        ],
        hasMore: true,
      },
      100,
    );

    state = applyGlobalSessionsCollectionSnapshot(
      state,
      {
        query: { scope: "global-sessions", starred: true },
        sessions: [
          globalSession("recent-starred", { isStarred: true }),
          globalSession("older-starred", {
            isStarred: true,
            updatedAt: "2026-06-20T11:00:00.000Z",
          }),
        ],
        hasMore: false,
      },
      200,
    );

    const globalRecords = selectSessionCollectionQueryRecords(state, {
      scope: "global-sessions",
    });
    const starredRecords = selectSessionCollectionQueryRecords(state, {
      scope: "global-sessions",
      starred: true,
    });

    expect(
      selectRecentSessionRecordsFromRecords(globalRecords, NOW).map(
        (s) => s.id,
      ),
    ).toEqual(["recent-unstarred"]);
    expect(
      selectStarredSessionRecordsFromRecords(starredRecords).map((s) => s.id),
    ).toEqual(["recent-starred", "older-starred"]);
  });

  it("keeps active recent rows stable when updatedAt changes", () => {
    let state = applyGlobalSessionsCollectionSnapshot(
      createEmptyClientSummaryState(),
      {
        query: { scope: "global-sessions", limit: 50 },
        sessions: [
          globalSession("active-a", {
            activity: "in-turn",
            ownership: { owner: "self", processId: "process-a" },
            updatedAt: "2026-06-27T11:00:00.000Z",
          }),
          globalSession("active-b", {
            activity: "in-turn",
            ownership: { owner: "self", processId: "process-b" },
            updatedAt: "2026-06-27T11:05:00.000Z",
          }),
        ],
        hasMore: false,
      },
      100,
    );

    expect(selectRecentSessionRecords(state, NOW).map((s) => s.id)).toEqual([
      "active-a",
      "active-b",
    ]);

    state = applyGlobalSessionsCollectionSnapshot(
      state,
      {
        query: { scope: "global-sessions", limit: 50 },
        sessions: [
          globalSession("active-b", {
            activity: "in-turn",
            ownership: { owner: "self", processId: "process-b" },
            updatedAt: "2026-06-27T11:10:00.000Z",
          }),
          globalSession("active-a", {
            activity: "in-turn",
            ownership: { owner: "self", processId: "process-a" },
            updatedAt: "2026-06-27T11:01:00.000Z",
          }),
        ],
        hasMore: false,
      },
      200,
    );

    expect(selectRecentSessionRecords(state, NOW).map((s) => s.id)).toEqual([
      "active-a",
      "active-b",
    ]);
  });

  it("keeps active starred rows stable when updatedAt changes", () => {
    let state = applyGlobalSessionsCollectionSnapshot(
      createEmptyClientSummaryState(),
      {
        query: { scope: "global-sessions", starred: true, limit: 50 },
        sessions: [
          globalSession("active-a", {
            activity: "in-turn",
            ownership: { owner: "self", processId: "process-a" },
            isStarred: true,
            updatedAt: "2026-06-27T11:00:00.000Z",
          }),
          globalSession("active-b", {
            activity: "in-turn",
            ownership: { owner: "self", processId: "process-b" },
            isStarred: true,
            updatedAt: "2026-06-27T11:05:00.000Z",
          }),
        ],
        hasMore: false,
      },
      100,
    );

    expect(selectStarredSessionRecords(state).map((s) => s.id)).toEqual([
      "active-a",
      "active-b",
    ]);

    state = applyGlobalSessionsCollectionSnapshot(
      state,
      {
        query: { scope: "global-sessions", starred: true, limit: 50 },
        sessions: [
          globalSession("active-b", {
            activity: "in-turn",
            ownership: { owner: "self", processId: "process-b" },
            isStarred: true,
            updatedAt: "2026-06-27T11:10:00.000Z",
          }),
          globalSession("active-a", {
            activity: "in-turn",
            ownership: { owner: "self", processId: "process-a" },
            isStarred: true,
            updatedAt: "2026-06-27T11:01:00.000Z",
          }),
        ],
        hasMore: false,
      },
      200,
    );

    expect(selectStarredSessionRecords(state).map((s) => s.id)).toEqual([
      "active-a",
      "active-b",
    ]);
  });

  it("pins active starred rows above idle starred rows", () => {
    const state = applyGlobalSessionsCollectionSnapshot(
      createEmptyClientSummaryState(),
      {
        query: { scope: "global-sessions", starred: true, limit: 50 },
        sessions: [
          globalSession("idle-new", {
            isStarred: true,
            updatedAt: "2026-06-27T11:30:00.000Z",
          }),
          globalSession("active-old", {
            activity: "in-turn",
            ownership: { owner: "self", processId: "process-old" },
            isStarred: true,
            updatedAt: "2026-06-27T11:00:00.000Z",
          }),
        ],
        hasMore: false,
      },
      100,
    );

    expect(selectStarredSessionRecords(state).map((s) => s.id)).toEqual([
      "active-old",
      "idle-new",
    ]);
  });

  it("moves newly active starred rows to the end of the active block", () => {
    let state = applyGlobalSessionsCollectionSnapshot(
      createEmptyClientSummaryState(),
      {
        query: { scope: "global-sessions", starred: true, limit: 50 },
        sessions: [
          globalSession("active-a", {
            activity: "in-turn",
            ownership: { owner: "self", processId: "process-a" },
            isStarred: true,
            updatedAt: "2026-06-27T11:00:00.000Z",
          }),
          globalSession("idle-b", {
            isStarred: true,
            updatedAt: "2026-06-27T11:30:00.000Z",
          }),
          globalSession("idle-c", {
            isStarred: true,
            updatedAt: "2026-06-27T11:15:00.000Z",
          }),
        ],
        hasMore: false,
      },
      100,
    );

    expect(selectStarredSessionRecords(state).map((s) => s.id)).toEqual([
      "active-a",
      "idle-b",
      "idle-c",
    ]);

    state = applySessionCollectionProcessStateChanged(
      state,
      {
        type: "process-state-changed",
        projectId: PROJECT_ID,
        sessionId: "idle-b",
        activity: "in-turn",
        timestamp: "2026-06-27T11:45:00.000Z",
      },
      200,
    );

    expect(selectStarredSessionRecords(state).map((s) => s.id)).toEqual([
      "active-a",
      "idle-b",
      "idle-c",
    ]);
  });

  it("pins newly active recent rows above idle rows", () => {
    let state = applyGlobalSessionsCollectionSnapshot(
      createEmptyClientSummaryState(),
      {
        query: { scope: "global-sessions", limit: 50 },
        sessions: [
          globalSession("idle-new", {
            updatedAt: "2026-06-27T11:30:00.000Z",
          }),
          globalSession("idle-old", {
            updatedAt: "2026-06-27T11:00:00.000Z",
          }),
        ],
        hasMore: false,
      },
      100,
    );

    state = applySessionCollectionProcessStateChanged(
      state,
      {
        type: "process-state-changed",
        projectId: PROJECT_ID,
        sessionId: "idle-old",
        activity: "in-turn",
        timestamp: "2026-06-27T11:45:00.000Z",
      },
      200,
    );

    expect(selectRecentSessionRecords(state, NOW).map((s) => s.id)).toEqual([
      "idle-old",
      "idle-new",
    ]);
  });

  it("does not let an older snapshot undo newer metadata", () => {
    let state = applyGlobalSessionsCollectionSnapshot(
      createEmptyClientSummaryState(),
      {
        query: { scope: "global-sessions", limit: 50 },
        sessions: [globalSession("session-1", { isStarred: false })],
        hasMore: false,
      },
      100,
    );
    state = applySessionCollectionMetadataChanged(
      state,
      {
        type: "session-metadata-changed",
        sessionId: "session-1",
        starred: true,
        timestamp: "2026-06-27T12:00:01.000Z",
      },
      200,
    );
    state = applyGlobalSessionsCollectionSnapshot(
      state,
      {
        query: { scope: "global-sessions", limit: 50 },
        sessions: [globalSession("session-1", { isStarred: false })],
        hasMore: false,
      },
      150,
    );

    expect(selectSessionCollectionRecord(state, "session-1")?.isStarred).toBe(
      true,
    );
  });

  it("keeps visible rows through a cold catalog and preserves omitted details", () => {
    const query = { scope: "global-sessions" as const, limit: 50 };
    let state = applyGlobalSessionsCollectionSnapshot(
      createEmptyClientSummaryState(),
      {
        query,
        sessions: [globalSession("saved", { messageCount: 42 })],
        hasMore: false,
      },
      100,
    );
    const catalog = {
      catalogEpoch: "restart",
      catalogGeneration: 0,
      complete: false,
      refreshing: true,
    };
    state = applyGlobalSessionsCollectionSnapshot(
      state,
      {
        query,
        sessions: [],
        hasMore: false,
        catalog,
      },
      200,
    );
    expect(selectSessionCollectionQueryState(state, query)?.ids).toEqual([
      "saved",
    ]);
    state = applyGlobalSessionsCollectionSnapshot(
      state,
      {
        query,
        sessions: [
          globalSession("saved", {
            title: undefined,
            fullTitle: undefined,
            createdAt: undefined,
            messageCount: undefined,
          }),
        ],
        hasMore: false,
        catalog: {
          ...catalog,
          catalogGeneration: 1,
          complete: true,
          refreshing: false,
        },
      },
      300,
    );
    expect(selectSessionCollectionRecord(state, "saved")).toMatchObject({
      title: "Session saved",
      fullTitle: "Session saved",
      messageCount: 42,
      createdAt: RECENT,
    });
    state = applyInboxCollectionSnapshot(
      state,
      {
        needsAttention: [],
        active: [],
        recentActivity: [inboxItem("saved")],
        unread8h: [],
        unread24h: [],
      },
      400,
    );
    state = applyInboxCollectionSnapshot(
      state,
      {
        needsAttention: [],
        active: [],
        recentActivity: [],
        unread8h: [],
        unread24h: [],
        catalog,
      },
      500,
    );
    expect(
      selectInboxResponse(state).recentActivity.map((item) => item.sessionId),
    ).toEqual(["saved"]);
  });

  it("stores query ids separately from entity facts", () => {
    const query = {
      scope: "global-sessions" as const,
      starred: true,
      limit: 50,
    };
    const state = applyGlobalSessionsCollectionSnapshot(
      createEmptyClientSummaryState(),
      {
        query,
        sessions: [globalSession("starred", { isStarred: true })],
        hasMore: true,
      },
      100,
    );

    const key = createGlobalSessionsQueryKey(query);
    expect(state.sessions.queries.get(key)).toMatchObject({
      ids: ["starred"],
      hasMore: true,
    });
    expect(selectSessionCollectionRecord(state, "starred")).toMatchObject({
      id: "starred",
      isStarred: true,
    });
  });

  it("prepends optimistic query ids without duplicating existing rows", () => {
    const query = {
      scope: "global-sessions" as const,
      limit: 50,
    };
    let state = applyGlobalSessionsCollectionSnapshot(
      createEmptyClientSummaryState(),
      {
        query,
        sessions: [globalSession("existing")],
        hasMore: true,
      },
      100,
    );

    state = applyGlobalSessionsCollectionSnapshot(
      state,
      {
        query,
        sessions: [
          globalSession("new"),
          globalSession("existing", {
            updatedAt: "2026-06-27T11:30:00.000Z",
          }),
        ],
        hasMore: true,
        mode: "prepend",
      },
      200,
    );

    expect(selectSessionCollectionQueryState(state, query)).toMatchObject({
      ids: ["new", "existing"],
      hasMore: true,
    });
  });

  it("keeps recent event-created query ids through replace snapshots that omit them", () => {
    const query = {
      scope: "global-sessions" as const,
      limit: 50,
    };
    let state = applyGlobalSessionsCollectionSnapshot(
      createEmptyClientSummaryState(),
      {
        query,
        sessions: [globalSession("existing")],
        hasMore: false,
      },
      100,
    );

    state = applySessionCollectionCreated(
      state,
      createdEvent("new-session"),
      200,
    );
    state = applyGlobalSessionsCollectionSnapshot(
      state,
      {
        query,
        sessions: [globalSession("new-session")],
        hasMore: true,
        mode: "prepend",
      },
      200,
    );

    state = applyGlobalSessionsCollectionSnapshot(
      state,
      {
        query,
        sessions: [globalSession("existing")],
        hasMore: false,
        mode: "replace",
      },
      700,
    );

    expect(
      selectSessionCollectionQueryRecords(state, query).map((s) => s.id),
    ).toEqual(["new-session", "existing"]);
  });

  it("expires event-created query id preservation after one minute", () => {
    const query = {
      scope: "global-sessions" as const,
      limit: 50,
    };
    let state = applyGlobalSessionsCollectionSnapshot(
      createEmptyClientSummaryState(),
      {
        query,
        sessions: [globalSession("existing")],
        hasMore: false,
      },
      100,
    );

    state = applySessionCollectionCreated(
      state,
      createdEvent("new-session"),
      200,
    );
    state = applyGlobalSessionsCollectionSnapshot(
      state,
      {
        query,
        sessions: [globalSession("new-session")],
        hasMore: true,
        mode: "prepend",
      },
      200,
    );

    state = applyGlobalSessionsCollectionSnapshot(
      state,
      {
        query,
        sessions: [globalSession("existing")],
        hasMore: false,
        mode: "replace",
      },
      60_201,
    );

    expect(
      selectSessionCollectionQueryRecords(state, query).map((s) => s.id),
    ).toEqual(["existing"]);
  });

  it("does not preserve event-created rows in search query replacements", () => {
    const query = {
      scope: "global-sessions" as const,
      searchQuery: "new",
    };
    let state = applyGlobalSessionsCollectionSnapshot(
      createEmptyClientSummaryState(),
      {
        query,
        sessions: [globalSession("new-session")],
        hasMore: false,
      },
      100,
    );

    state = applySessionCollectionCreated(
      state,
      createdEvent("new-session"),
      200,
    );

    state = applyGlobalSessionsCollectionSnapshot(
      state,
      {
        query,
        sessions: [],
        hasMore: false,
        mode: "replace",
      },
      300,
    );

    expect(selectSessionCollectionQueryRecords(state, query)).toEqual([]);
  });

  it("stores inbox tier ids and upserts partial session facts", () => {
    const state = applyInboxCollectionSnapshot(
      createEmptyClientSummaryState(),
      {
        needsAttention: [
          inboxItem("needs", {
            pendingInputType: "tool-approval",
            hasUnread: true,
          }),
        ],
        active: [
          inboxItem("active", {
            activity: "in-turn",
            updatedAt: "2026-06-27T11:05:00.000Z",
          }),
        ],
        recentActivity: [inboxItem("recent")],
        unread8h: [],
        unread24h: [],
      },
      100,
    );

    const inbox = selectInboxResponse(state);
    expect(inbox.needsAttention.map((item) => item.sessionId)).toEqual([
      "needs",
    ]);
    expect(inbox.active.map((item) => item.sessionId)).toEqual(["active"]);
    expect(inbox.recentActivity.map((item) => item.sessionId)).toEqual([
      "recent",
    ]);
    expect(selectSessionCollectionRecord(state, "needs")).toMatchObject({
      id: "needs",
      title: "Session needs",
      projectId: PROJECT_ID,
      projectName: "Project",
      activity: "waiting-input",
      pendingInputType: "tool-approval",
      hasUnread: true,
    });
    expect(selectInboxResponse(state).needsAttention[0]).toMatchObject({
      sessionId: "needs",
      sessionTitle: "Session needs",
    });
    expect(selectSessionCollectionRecord(state, "active")).toMatchObject({
      id: "active",
      activity: "in-turn",
    });
    expect(selectInboxCounts(state)).toEqual({
      needsAttention: 1,
      active: 1,
      total: 3,
    });
    expect(selectActiveAgentCount(state)).toBe(1);
    expect(selectHasActiveAgents(state)).toBe(true);

    const countsByProject = selectInboxCountsByProject(state);
    expect(countsByProject.get(PROJECT_ID)).toEqual({
      needsAttention: 1,
      active: 1,
      total: 3,
    });
    expect(selectActiveProjectSessionIds(state, PROJECT_ID)).toEqual([
      "needs",
      "active",
    ]);
  });

  it("preserves metadata from inbox snapshots", () => {
    const state = applyInboxCollectionSnapshot(
      createEmptyClientSummaryState(),
      {
        needsAttention: [
          inboxItem("custom", {
            sessionTitle: "Server Display Title",
            customTitle: "Renamed Session",
            isStarred: true,
          }),
        ],
        active: [],
        recentActivity: [],
        unread8h: [],
        unread24h: [],
      },
      100,
    );

    expect(selectSessionCollectionRecord(state, "custom")).toMatchObject({
      title: "Server Display Title",
      customTitle: "Renamed Session",
      isStarred: true,
    });
    expect(selectInboxResponse(state).needsAttention[0]).toMatchObject({
      sessionTitle: "Server Display Title",
      customTitle: "Renamed Session",
      isStarred: true,
    });
  });

  it("does not clear known starred state when inbox snapshots omit it", () => {
    let state = applyGlobalSessionsCollectionSnapshot(
      createEmptyClientSummaryState(),
      {
        query: { scope: "global-sessions", limit: 50 },
        sessions: [globalSession("known-starred", { isStarred: true })],
        hasMore: false,
      },
      100,
    );

    state = applyInboxCollectionSnapshot(
      state,
      {
        needsAttention: [inboxItem("known-starred")],
        active: [],
        recentActivity: [],
        unread8h: [],
        unread24h: [],
      },
      200,
    );

    expect(selectSessionCollectionRecord(state, "known-starred")).toMatchObject(
      {
        isStarred: true,
      },
    );
    expect(selectInboxResponse(state).needsAttention[0]).toMatchObject({
      isStarred: true,
    });
  });

  it("does not downgrade complete content fields with an inbox projection", () => {
    let state = applyGlobalSessionsCollectionSnapshot(
      createEmptyClientSummaryState(),
      {
        query: { scope: "global-sessions" },
        sessions: [
          globalSession("rich-session", {
            fullTitle: "Complete full title",
            messageCount: 442,
            model: "late-model",
            lastAgentText: "Complete tail",
          }),
        ],
        hasMore: false,
      },
      100,
    );

    state = applyInboxCollectionSnapshot(
      state,
      {
        needsAttention: [],
        active: [],
        recentActivity: [
          inboxItem("rich-session", {
            sessionTitle: "Fresh list title",
            updatedAt: "2026-05-02T00:00:00.000Z",
          }),
        ],
        unread8h: [],
        unread24h: [],
      },
      200,
    );

    expect(selectSessionCollectionRecord(state, "rich-session")).toMatchObject({
      title: "Fresh list title",
      updatedAt: "2026-05-02T00:00:00.000Z",
      fullTitle: "Complete full title",
      messageCount: 442,
      model: "late-model",
      lastAgentText: "Complete tail",
    });
  });

  it("does not synthesize activity from active inbox tier placement", () => {
    let state = applyInboxCollectionSnapshot(
      createEmptyClientSummaryState(),
      {
        needsAttention: [],
        active: [inboxItem("queued-active")],
        recentActivity: [],
        unread8h: [],
        unread24h: [],
      },
      100,
    );

    const queueOnlyRecord = selectSessionCollectionRecord(
      state,
      "queued-active",
    );
    expect(queueOnlyRecord?.activity).toBeUndefined();
    expect(queueOnlyRecord?.activityInferredFromInboxTier).toBeUndefined();
    expect(selectInboxResponse(state).active[0]?.activity).toBeUndefined();
    expect(
      selectInboxResponse(state).active[0]?.activityInferredFromInboxTier,
    ).toBeUndefined();

    state = applyGlobalSessionsCollectionSnapshot(
      state,
      {
        query: { scope: "global-sessions", limit: 50 },
        sessions: [globalSession("queued-active", { activity: "in-turn" })],
        hasMore: false,
      },
      200,
    );

    expect(selectSessionCollectionRecord(state, "queued-active")).toMatchObject(
      {
        activity: "in-turn",
        activityInferredFromInboxTier: false,
      },
    );
    expect(selectInboxResponse(state).active[0]).toMatchObject({
      activity: "in-turn",
      activityInferredFromInboxTier: false,
    });
  });

  it("clears older active lifecycle when a newer inbox row is no longer active", () => {
    let state = applyGlobalSessionsCollectionSnapshot(
      createEmptyClientSummaryState(),
      {
        query: { scope: "global-sessions", limit: 50 },
        sessions: [
          globalSession("session-1", {
            activity: "in-turn",
            ownership: { owner: "self", processId: "process-1" },
          }),
        ],
        hasMore: false,
      },
      100,
    );

    state = applyInboxCollectionSnapshot(
      state,
      {
        needsAttention: [],
        active: [],
        recentActivity: [inboxItem("session-1")],
        unread8h: [],
        unread24h: [],
      },
      200,
    );

    expect(selectSessionCollectionRecord(state, "session-1")?.activity).toBe(
      undefined,
    );
    expect(selectInboxResponse(state).recentActivity[0]).toMatchObject({
      sessionId: "session-1",
      activity: undefined,
    });
  });

  it("does not let an older full snapshot resurrect cleared lifecycle activity", () => {
    let state = applyGlobalSessionsCollectionSnapshot(
      createEmptyClientSummaryState(),
      {
        query: { scope: "global-sessions", limit: 50 },
        sessions: [
          globalSession("session-1", {
            activity: "in-turn",
            ownership: { owner: "self", processId: "process-1" },
          }),
        ],
        hasMore: false,
      },
      100,
    );

    state = applyInboxCollectionSnapshot(
      state,
      {
        needsAttention: [],
        active: [],
        recentActivity: [inboxItem("session-1")],
        unread8h: [],
        unread24h: [],
      },
      200,
    );

    state = applyGlobalSessionsCollectionSnapshot(
      state,
      {
        query: { scope: "global-sessions", limit: 50 },
        sessions: [
          globalSession("session-1", {
            activity: "in-turn",
            ownership: { owner: "self", processId: "process-1" },
          }),
        ],
        hasMore: false,
      },
      150,
    );

    expect(selectSessionCollectionRecord(state, "session-1")).toMatchObject({
      ownership: { owner: "self", processId: "process-1" },
      activity: undefined,
    });
  });

  it("does not let an older inbox snapshot reorder newer tier membership", () => {
    let state = applyInboxCollectionSnapshot(
      createEmptyClientSummaryState(),
      {
        needsAttention: [],
        active: [inboxItem("current")],
        recentActivity: [],
        unread8h: [],
        unread24h: [],
      },
      200,
    );

    state = applyInboxCollectionSnapshot(
      state,
      {
        needsAttention: [],
        active: [inboxItem("stale")],
        recentActivity: [],
        unread8h: [],
        unread24h: [],
      },
      100,
    );

    expect(
      selectInboxResponse(state).active.map((item) => item.sessionId),
    ).toEqual(["current"]);
    expect(selectSessionCollectionRecord(state, "stale")).toBeUndefined();
  });

  it("stores project list snapshots as ordered query ids", () => {
    const state = applyProjectsCollectionSnapshot(
      createEmptyClientSummaryState(),
      {
        projects: [
          project("project-b", { lastActivity: "2026-06-27T11:30:00.000Z" }),
          project("project-a", { lastActivity: "2026-06-27T11:00:00.000Z" }),
        ],
      },
      100,
    );

    expect(selectProjectCollectionRecords(state).map((p) => p.id)).toEqual([
      "project-b",
      "project-a",
    ]);
    expect(selectProjectCollectionRecord(state, "project-a")).toMatchObject({
      id: "project-a",
      name: "Project project-a",
    });
  });

  it("stores single project snapshots without replacing project list membership", () => {
    let state = applyProjectsCollectionSnapshot(
      createEmptyClientSummaryState(),
      { projects: [project("project-a")] },
      100,
    );
    state = applyProjectCollectionSnapshot(
      state,
      {
        project: project("project-b", {
          name: "Detached Project",
          sessionCount: 0,
        }),
      },
      200,
    );

    expect(selectProjectCollectionRecord(state, "project-b")).toMatchObject({
      name: "Detached Project",
    });
    expect(selectProjectCollectionRecords(state).map((p) => p.id)).toEqual([
      "project-a",
    ]);
  });

  it("preserves unchanged project record identity on unrelated updates", () => {
    let state = applyProjectsCollectionSnapshot(
      createEmptyClientSummaryState(),
      { projects: [project("project-a"), project("project-b")] },
      100,
    );
    const before = selectProjectCollectionRecord(state, "project-a");

    state = applyProjectCollectionSnapshot(
      state,
      {
        project: project("project-b", {
          activeOwnedCount: 1,
          projectQueueBlockingCount: 1,
        }),
      },
      200,
    );

    expect(selectProjectCollectionRecord(state, "project-a")).toBe(before);
  });

  it("does not let an older single project snapshot undo a newer match", () => {
    let state = applyProjectCollectionSnapshot(
      createEmptyClientSummaryState(),
      { project: project("project-a", { name: "Current Project" }) },
      100,
    );

    state = applyProjectCollectionSnapshot(
      state,
      { project: project("project-a", { name: "Current Project" }) },
      200,
    );
    state = applyProjectCollectionSnapshot(
      state,
      { project: project("project-a", { name: "Stale Project" }) },
      150,
    );

    expect(selectProjectCollectionRecord(state, "project-a")).toMatchObject({
      name: "Current Project",
    });
  });

  it("does not let an older project list snapshot reorder a newer match", () => {
    let state = applyProjectsCollectionSnapshot(
      createEmptyClientSummaryState(),
      { projects: [project("project-a"), project("project-b")] },
      100,
    );

    state = applyProjectsCollectionSnapshot(
      state,
      { projects: [project("project-a"), project("project-b")] },
      200,
    );
    state = applyProjectsCollectionSnapshot(
      state,
      { projects: [project("project-b"), project("project-a")] },
      150,
    );

    expect(selectProjectCollectionRecords(state).map((p) => p.id)).toEqual([
      "project-a",
      "project-b",
    ]);
  });

  it("stores project queue snapshots and selects targeted sessions", () => {
    const state = applyProjectQueueCollectionSnapshot(
      createEmptyClientSummaryState(),
      {
        projectId: PROJECT_ID,
        items: [
          queueItem("1"),
          queueItem("2", {
            target: { type: "new-session", title: "New queued session" },
          }),
        ],
      },
      100,
    );

    expect(
      selectProjectQueueItems(state, PROJECT_ID).map((item) => item.id),
    ).toEqual(["1", "2"]);
    expect([...selectProjectQueuedSessionIds(state, [PROJECT_ID])]).toEqual([
      "session-1",
    ]);
  });

  it("stores dispatch state from project queue snapshots", () => {
    let state = applyProjectQueueCollectionSnapshot(
      createEmptyClientSummaryState(),
      {
        projectId: PROJECT_ID,
        items: [queueItem("1")],
        dispatchState: {
          status: "paused",
          reason: "restart",
          pausedAt: "2026-07-01T07:41:12.926Z",
        },
      },
      100,
    );

    expect(selectProjectQueueDispatchState(state)).toMatchObject({
      status: "paused",
      reason: "restart",
    });

    state = applyProjectQueueCollectionChanged(
      state,
      {
        type: "project-queue-changed",
        projectId: PROJECT_ID,
        items: [queueItem("1")],
        reason: "resumed",
        dispatchState: { status: "running" },
        timestamp: RECENT,
      },
      200,
    );

    expect(selectProjectQueueDispatchState(state)).toEqual({
      status: "running",
    });
  });

  it("stores recovered session queues from global project queue snapshots", () => {
    let state = applyProjectQueueGlobalCollectionSnapshot(
      createEmptyClientSummaryState(),
      {
        items: [queueItem("1")],
        recoveredSessionQueues: [recoveredSessionQueue("1")],
      },
      100,
    );

    expect(selectProjectQueueRecoveredSessionQueues(state)).toMatchObject([
      {
        id: "1",
        sessionId: "session-1",
        projectId: PROJECT_ID,
        status: "paused-after-restart",
      },
    ]);

    state = applyProjectQueueGlobalCollectionSnapshot(
      state,
      { items: [], recoveredSessionQueues: [] },
      200,
    );

    expect(selectProjectQueueRecoveredSessionQueues(state)).toEqual([]);
  });

  it("stores and replaces project queue project statuses from global snapshots", () => {
    let state = applyProjectQueueGlobalCollectionSnapshot(
      createEmptyClientSummaryState(),
      {
        items: [queueItem("1")],
        projectStatuses: {
          [PROJECT_ID]: projectQueueStatus("waiting-quiet"),
        },
      },
      100,
    );

    expect(
      selectProjectQueueProjectStatusesByProject(state)[PROJECT_ID],
    ).toMatchObject({
      state: "waiting-quiet",
      nextItemId: "1",
    });

    state = applyProjectQueueGlobalCollectionSnapshot(
      state,
      { items: [], projectStatuses: {} },
      200,
    );

    expect(
      selectProjectQueueProjectStatusesByProject(state)[PROJECT_ID],
    ).toBeUndefined();
  });

  it("merges project queue project statuses from project snapshots", () => {
    const otherProjectId = "project-2" as UrlProjectId;
    let state = applyProjectQueueGlobalCollectionSnapshot(
      createEmptyClientSummaryState(),
      {
        items: [queueItem("1")],
        projectStatuses: {
          [PROJECT_ID]: projectQueueStatus("waiting-quiet"),
        },
      },
      100,
    );

    state = applyProjectQueueCollectionSnapshot(
      state,
      {
        projectId: otherProjectId,
        items: [queueItem("2", { projectId: otherProjectId })],
        projectStatuses: {
          [otherProjectId]: projectQueueStatus("blocked", {
            projectId: otherProjectId,
          }),
        },
      },
      200,
    );

    expect(selectProjectQueueProjectStatusesByProject(state)).toMatchObject({
      [PROJECT_ID]: { state: "waiting-quiet" },
      [otherProjectId]: { state: "blocked" },
    });
  });

  it("does not let older global snapshots undo newer project queue gate facts", () => {
    let state = applyProjectQueueCollectionChanged(
      createEmptyClientSummaryState(),
      {
        type: "project-queue-changed",
        projectId: PROJECT_ID,
        items: [queueItem("1")],
        reason: "paused",
        dispatchState: {
          status: "paused",
          reason: "manual",
          pausedAt: "2026-07-01T07:45:00.000Z",
        },
        timestamp: RECENT,
      },
      200,
    );

    state = applyProjectQueueGlobalCollectionSnapshot(
      state,
      {
        items: [],
        dispatchState: { status: "running" },
      },
      150,
    );

    expect(selectProjectQueueDispatchState(state)).toMatchObject({
      status: "paused",
      reason: "manual",
    });
  });

  it("does not let older snapshots undo newer recovered queue facts", () => {
    let state = applyProjectQueueGlobalCollectionSnapshot(
      createEmptyClientSummaryState(),
      {
        items: [],
        recoveredSessionQueues: [],
      },
      200,
    );

    state = applyProjectQueueGlobalCollectionSnapshot(
      state,
      {
        items: [],
        recoveredSessionQueues: [recoveredSessionQueue("1")],
      },
      150,
    );

    expect(selectProjectQueueRecoveredSessionQueues(state)).toEqual([]);
  });

  it("does not let older global snapshots undo newer project statuses", () => {
    let state = applyProjectQueueCollectionSnapshot(
      createEmptyClientSummaryState(),
      {
        projectId: PROJECT_ID,
        items: [queueItem("1")],
        projectStatuses: {
          [PROJECT_ID]: projectQueueStatus("blocked"),
        },
      },
      200,
    );

    state = applyProjectQueueGlobalCollectionSnapshot(
      state,
      { items: [], projectStatuses: {} },
      150,
    );

    expect(
      selectProjectQueueProjectStatusesByProject(state)[PROJECT_ID],
    ).toMatchObject({
      state: "blocked",
    });
  });

  it("selects sidebar Project Queue counts from project fallbacks and queue snapshots", () => {
    let state = applyProjectsCollectionSnapshot(
      createEmptyClientSummaryState(),
      {
        projects: [
          project("project-1", { projectQueueCount: 2 }),
          project("project-2", { projectQueueCount: 4 }),
        ],
      },
      200,
    );

    state = applyProjectQueueCollectionSnapshot(
      state,
      {
        projectId: "project-1" as UrlProjectId,
        items: [
          queueItem("1"),
          queueItem("2", { status: "dispatching" }),
          queueItem("3", { status: "failed" }),
        ],
      },
      250,
    );
    state = applyProjectQueueCollectionSnapshot(
      state,
      {
        projectId: "project-3" as UrlProjectId,
        items: [queueItem("4", { projectId: "project-3" as UrlProjectId })],
      },
      260,
    );

    expect(
      selectProjectQueueSidebarCount(
        state,
        selectProjectCollectionRecords(state),
      ),
    ).toBe(7);
  });

  it("lets fresh project fallback counts override stale queue snapshots", () => {
    let state = applyProjectQueueCollectionSnapshot(
      createEmptyClientSummaryState(),
      {
        projectId: PROJECT_ID,
        items: [queueItem("1"), queueItem("2")],
      },
      100,
    );
    state = applyProjectsCollectionSnapshot(
      state,
      {
        projects: [project(PROJECT_ID, { projectQueueCount: 0 })],
      },
      200,
    );

    expect(
      selectProjectQueueSidebarCount(
        state,
        selectProjectCollectionRecords(state),
      ),
    ).toBe(0);
  });

  it("preserves unchanged project queue items after matching updates", () => {
    let state = applyProjectQueueCollectionSnapshot(
      createEmptyClientSummaryState(),
      { projectId: PROJECT_ID, items: [queueItem("1")] },
      100,
    );
    const before = selectProjectQueueItems(state, PROJECT_ID);

    state = applyProjectQueueCollectionChanged(
      state,
      {
        type: "project-queue-changed",
        projectId: PROJECT_ID,
        items: [queueItem("1")],
        reason: "updated",
        timestamp: RECENT,
      },
      200,
    );

    expect(selectProjectQueueItems(state, PROJECT_ID)).toBe(before);
  });

  it("preserves project queue target titles when events omit display metadata", () => {
    let state = applyProjectQueueCollectionSnapshot(
      createEmptyClientSummaryState(),
      {
        projectId: PROJECT_ID,
        items: [
          queueItem("1", {
            targetTitle: "Investigate failing build",
            targetFullTitle: "Investigate failing build in CI",
          }),
        ],
      },
      100,
    );

    state = applyProjectQueueCollectionChanged(
      state,
      {
        type: "project-queue-changed",
        projectId: PROJECT_ID,
        items: [queueItem("1")],
        reason: "updated",
        timestamp: RECENT,
      },
      200,
    );

    expect(selectProjectQueueItems(state, PROJECT_ID)).toMatchObject([
      {
        id: "1",
        targetTitle: "Investigate failing build",
        targetFullTitle: "Investigate failing build in CI",
      },
    ]);
  });

  it("does not preserve project queue target titles after target changes", () => {
    let state = applyProjectQueueCollectionSnapshot(
      createEmptyClientSummaryState(),
      {
        projectId: PROJECT_ID,
        items: [
          queueItem("1", {
            targetTitle: "Original session",
            targetFullTitle: "Original session full title",
          }),
        ],
      },
      100,
    );

    state = applyProjectQueueCollectionChanged(
      state,
      {
        type: "project-queue-changed",
        projectId: PROJECT_ID,
        items: [
          queueItem("1", {
            target: { type: "existing-session", sessionId: "session-other" },
          }),
        ],
        reason: "updated",
        timestamp: RECENT,
      },
      200,
    );

    expect(selectProjectQueueItems(state, PROJECT_ID)).toMatchObject([
      {
        id: "1",
        target: { type: "existing-session", sessionId: "session-other" },
      },
    ]);
    expect(selectProjectQueueItems(state, PROJECT_ID)[0]?.targetTitle).toBe(
      undefined,
    );
  });

  it("does not let older project queue snapshots undo newer queue facts", () => {
    let state = applyProjectQueueCollectionSnapshot(
      createEmptyClientSummaryState(),
      { projectId: PROJECT_ID, items: [queueItem("1")] },
      100,
    );

    state = applyProjectQueueCollectionChanged(
      state,
      {
        type: "project-queue-changed",
        projectId: PROJECT_ID,
        items: [queueItem("2", { status: "failed" })],
        reason: "failed",
        timestamp: RECENT,
      },
      200,
    );
    state = applyProjectQueueCollectionSnapshot(
      state,
      { projectId: PROJECT_ID, items: [queueItem("1")] },
      150,
    );

    expect(selectProjectQueueItems(state, PROJECT_ID)).toMatchObject([
      { id: "2", status: "failed" },
    ]);
  });

  it("replaces project queues from a global queue snapshot", () => {
    const otherProjectId = "project-2" as UrlProjectId;
    let state = applyProjectQueueCollectionSnapshot(
      createEmptyClientSummaryState(),
      {
        projectId: otherProjectId,
        items: [queueItem("2", { projectId: otherProjectId })],
      },
      100,
    );

    state = applyProjectQueueGlobalCollectionSnapshot(
      state,
      { items: [queueItem("1")] },
      200,
    );

    expect(
      selectProjectQueueItems(state, PROJECT_ID).map((item) => item.id),
    ).toEqual(["1"]);
    expect(selectProjectQueueItems(state, otherProjectId)).toEqual([]);
  });

  it("keeps newer project queue facts after an older global snapshot", () => {
    let state = applyProjectQueueCollectionChanged(
      createEmptyClientSummaryState(),
      {
        type: "project-queue-changed",
        projectId: PROJECT_ID,
        items: [queueItem("2", { status: "failed" })],
        reason: "failed",
        timestamp: RECENT,
      },
      200,
    );

    state = applyProjectQueueGlobalCollectionSnapshot(
      state,
      { items: [] },
      150,
    );

    expect(selectProjectQueueItems(state, PROJECT_ID)).toMatchObject([
      { id: "2", status: "failed" },
    ]);
  });

  it("stores local draft session ids as stable decorations", () => {
    let state = applyDraftSessionIdsSnapshot(
      createEmptyClientSummaryState(),
      new Set(["session-a"]),
      100,
    );
    const before = selectDraftSessionIds(state);

    expect([...before]).toEqual(["session-a"]);

    const unchanged = applyDraftSessionIdsSnapshot(
      state,
      new Set(["session-a"]),
      200,
    );

    expect(unchanged).toBe(state);
    expect(selectDraftSessionIds(unchanged)).toBe(before);

    state = applyDraftSessionIdsSnapshot(
      state,
      new Set(["session-a", "session-b"]),
      300,
    );

    expect([...selectDraftSessionIds(state)]).toEqual([
      "session-a",
      "session-b",
    ]);
  });
});
