import {
  PROJECT_QUEUE_NAMED_BLOCKER_COUNT,
  type ProjectQueueDispatchState,
  type ProjectQueueItemSummary,
  type ProjectQueueListResponse,
  type ProjectQueueProjectStatus,
  type ProjectQueueRecoveredSessionQueueSummary,
  type ProjectQueueResponse,
  getSessionDisplayTitle,
  truncateSessionTitle,
  isUrlProjectId,
  parseProjectQueueBlocker,
} from "@yep-anywhere/shared";
import type { UserUsageService } from "../auth/UserUsageService.js";
import type { SessionMetadataService } from "../metadata/index.js";
import type { ProjectScanner } from "../projects/scanner.js";
import type { ProjectQueueService } from "../services/ProjectQueueService.js";
import type { ProjectQueueScheduler } from "../services/ProjectQueueScheduler.js";
import type {
  PersistedSessionQueuedMessage,
  SessionQueuePersistenceService,
} from "../services/SessionQueuePersistenceService.js";
import type { RetainedSessionCollections } from "../services/RetainedSessionCollections.js";
import { createCatalogSessionLookup } from "../sessions/catalog-session-lookup.js";
import type { Project } from "../supervisor/types.js";

interface ProjectQueueTitleDeps {
  sessionMetadataService?: SessionMetadataService;
  retainedCollections?: Pick<
    RetainedSessionCollections,
    "readPublishedProjectRows"
  >;
}

type TitleLookup = ReturnType<typeof createCatalogSessionLookup>;

export interface ProjectQueueRoutesDeps extends ProjectQueueTitleDeps {
  scanner: ProjectScanner;
  projectQueueService: ProjectQueueService;
  projectQueueScheduler?: Pick<ProjectQueueScheduler, "getProjectStatus">;
  userUsageService?: Pick<UserUsageService, "recordSession" | "recordTurn">;
}

export type GlobalProjectQueueRoutesDeps = ProjectQueueTitleDeps & {
  projectQueueService: ProjectQueueService;
  projectQueueScheduler?: Pick<
    ProjectQueueScheduler,
    "getProjectStatus" | "promoteNow"
  >;
  sessionQueuePersistenceService?: SessionQueuePersistenceService;
};

function isRecoveredPatientQueueItem(
  item: PersistedSessionQueuedMessage,
): boolean {
  return item.kind === "patient" && item.status === "paused-after-restart";
}

function summarizeRecoveredSessionQueue(
  item: PersistedSessionQueuedMessage,
  sessionMetadataService: SessionMetadataService | undefined,
): ProjectQueueRecoveredSessionQueueSummary {
  const attachmentCount =
    (item.message.attachments?.length ?? 0) +
    (item.message.images?.length ?? 0) +
    (item.message.documents?.length ?? 0);
  const tempId = item.message.tempId ?? item.source?.tempId;
  const sessionTitle = sessionMetadataService?.getMetadata(
    item.sessionId,
  )?.customTitle;

  return {
    id: item.id,
    ...(tempId ? { tempId } : {}),
    content: item.message.text,
    timestamp: item.queuedAt,
    ...(item.message.attachments?.length
      ? { attachments: item.message.attachments }
      : {}),
    ...(attachmentCount > 0 ? { attachmentCount } : {}),
    ...(item.message.metadata ? { metadata: item.message.metadata } : {}),
    kind: "patient",
    status: "paused-after-restart",
    sessionId: item.sessionId,
    projectId: item.projectId,
    queuedAt: item.queuedAt,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    ...(sessionTitle ? { sessionTitle } : {}),
  };
}

function listRecoveredSessionQueues(
  deps: GlobalProjectQueueRoutesDeps,
): ProjectQueueRecoveredSessionQueueSummary[] {
  return (deps.sessionQueuePersistenceService?.list() ?? [])
    .filter(isRecoveredPatientQueueItem)
    .sort((left, right) => {
      const project = left.projectId.localeCompare(right.projectId);
      if (project !== 0) return project;
      const session = left.sessionId.localeCompare(right.sessionId);
      if (session !== 0) return session;
      const queued = left.queuedAt.localeCompare(right.queuedAt);
      return queued !== 0 ? queued : left.id.localeCompare(right.id);
    })
    .map((item) =>
      summarizeRecoveredSessionQueue(item, deps.sessionMetadataService),
    );
}

function resolveTargetTitles(
  sessionId: string,
  summary: { title?: string | null; fullTitle?: string | null } | null,
  deps: ProjectQueueTitleDeps,
): Pick<ProjectQueueItemSummary, "targetTitle" | "targetFullTitle"> {
  const customTitle =
    deps.sessionMetadataService?.getMetadata(sessionId)?.customTitle;
  const title = summary?.title ?? null;
  return {
    targetTitle:
      customTitle !== undefined || title !== null
        ? getSessionDisplayTitle({ customTitle, title })
        : null,
    targetFullTitle: customTitle ?? summary?.fullTitle ?? null,
  };
}

async function enrichProjectQueueItem(
  item: ProjectQueueItemSummary,
  deps: ProjectQueueTitleDeps,
  lookup: TitleLookup,
): Promise<ProjectQueueItemSummary> {
  if (item.target.type !== "existing-session") return item;
  return {
    ...item,
    ...(await catalogTargetTitles(
      item.projectId,
      item.target.sessionId,
      deps,
      lookup,
      item.target.provider,
    )),
  };
}

async function catalogTargetTitles(
  projectId: Project["id"],
  sessionId: string,
  deps: ProjectQueueTitleDeps,
  lookup: TitleLookup,
  provider?: Parameters<TitleLookup>[2],
) {
  try {
    const row = await lookup(projectId, sessionId, provider);
    return resolveTargetTitles(
      sessionId,
      row
        ? {
            title: row.title == null ? null : truncateSessionTitle(row.title),
            fullTitle: row.title,
          }
        : null,
      deps,
    );
  } catch {
    // Unreadable or cold catalog facts never trigger a provider reader.
    return resolveTargetTitles(sessionId, null, deps);
  }
}

async function projectStatusesForIds(
  projectIds: Iterable<string>,
  deps: GlobalProjectQueueRoutesDeps | ProjectQueueRoutesDeps,
  lookup: TitleLookup,
): Promise<Record<string, ProjectQueueProjectStatus> | undefined> {
  const scheduler = deps.projectQueueScheduler;
  if (!scheduler) return undefined;
  const resolved = await Promise.all(
    [...new Set(projectIds)].filter(isUrlProjectId).map(async (projectId) => {
      const status = await scheduler.getProjectStatus(projectId);
      await addBlockerSessionTitles(status, deps, lookup);
      return status;
    }),
  );
  return Object.fromEntries(
    resolved.map((status) => [status.projectId, status]),
  );
}

/** Sessions the queue UI names among a project's blockers. */
function namedBlockerSessionIds(blockers: readonly string[]): Set<string> {
  const sessionIds = new Set<string>();
  for (const blocker of blockers.slice(0, PROJECT_QUEUE_NAMED_BLOCKER_COUNT)) {
    const parsed = parseProjectQueueBlocker(blocker);
    if (parsed.kind === "session" || parsed.kind === "session-liveness") {
      sessionIds.add(parsed.sessionId);
    }
  }
  return sessionIds;
}

async function addBlockerSessionTitles(
  status: ProjectQueueProjectStatus,
  deps: GlobalProjectQueueRoutesDeps | ProjectQueueRoutesDeps,
  lookup: TitleLookup,
): Promise<void> {
  const sessionIds = namedBlockerSessionIds(status.blockers);
  if (sessionIds.size === 0) return;
  const blockerSessionTitles: Record<string, string> = {};
  await Promise.all(
    [...sessionIds].map(async (sessionId) => {
      const title = (
        await catalogTargetTitles(status.projectId, sessionId, deps, lookup)
      ).targetTitle;
      if (title) {
        blockerSessionTitles[sessionId] = title;
      }
    }),
  );
  if (Object.keys(blockerSessionTitles).length > 0) {
    status.blockerSessionTitles = blockerSessionTitles;
  }
}

export async function projectQueueResponse(
  project: Project,
  deps: ProjectQueueRoutesDeps,
): Promise<ProjectQueueResponse> {
  const queue = deps.projectQueueService.listProject(project.id);
  const lookup = createCatalogSessionLookup(
    deps.retainedCollections,
    deps.sessionMetadataService,
  );
  const projectStatuses = await projectStatusesForIds(
    [project.id],
    deps,
    lookup,
  );
  return {
    ...queue,
    items: await Promise.all(
      queue.items.map((item) => enrichProjectQueueItem(item, deps, lookup)),
    ),
    projectStatuses,
  };
}

export interface GlobalQueueResponseOptions {
  dispatchState?: ProjectQueueDispatchState;
  /**
   * Which projects the caller may see; absent means every project. Applied
   * before titles are resolved, so another project's items, recovered
   * queues, statuses, and blocker session titles are never read for them.
   */
  isProjectVisible?: (projectId: string) => boolean;
}

export async function globalQueueResponse(
  deps: GlobalProjectQueueRoutesDeps,
  options: GlobalQueueResponseOptions = {},
): Promise<ProjectQueueListResponse> {
  const dispatchState =
    options.dispatchState ?? deps.projectQueueService.getDispatchState();
  const isVisible = options.isProjectVisible ?? (() => true);
  const items = deps.projectQueueService
    .listAll()
    .filter((item) => isVisible(item.projectId));
  const recoveredSessionQueues = listRecoveredSessionQueues(deps).filter(
    (item) => isVisible(item.projectId),
  );
  const lookup = createCatalogSessionLookup(
    deps.retainedCollections,
    deps.sessionMetadataService,
  );
  const projectStatuses = await projectStatusesForIds(
    [
      ...items.map((item) => item.projectId),
      ...recoveredSessionQueues.map((item) => item.projectId),
    ],
    deps,
    lookup,
  );
  return {
    items: await Promise.all(
      items.map((item) => enrichProjectQueueItem(item, deps, lookup)),
    ),
    dispatchState,
    recoveredSessionQueues,
    projectStatuses,
  };
}
