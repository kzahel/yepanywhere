import { mergeCreationGlobalItems } from "./creation-session-collections.js";
import {
  truncateSessionTitle,
  fromUrlProjectId,
  isUrlProjectId,
  isYaSessionId,
} from "@yep-anywhere/shared";
import {
  nativeCatalogSessionRef,
  projectCatalogIdentities,
  type ProjectedCatalogRow,
} from "../sessions/catalog-identity.js";
import { nonHumanUserTurnField } from "../metadata/SessionMetadataService.js";
import { getProjectName, isDetachedProjectPath } from "../projects/paths.js";
import type { RetainedSessionCollections } from "../services/RetainedSessionCollections.js";
import {
  getEffectiveProviderUpdatedAt,
  latestRecapMessage,
} from "../sessions/recap-overlays.js";
import { sessionRowRuntimeOverlay } from "../sessions/session-runtime-overlay.js";
import type {
  GlobalSessionItem,
  GlobalSessionStats,
  GlobalSessionsDeps,
} from "./global-sessions.js";
import {
  getActiveSessionIndexOptions,
  isSessionAutoArchived,
} from "./session-list-options.js";

/**
 * Display titles per kept projection (frozen, and alive while its row is
 * unchanged); rows projected afresh on each read are not worth an entry.
 */
const displayTitles = new WeakMap<object, string>();

function displayTitle(row: ProjectedCatalogRow, fullTitle: string) {
  if (!Object.isFrozen(row)) return truncateSessionTitle(fullTitle);
  let title = displayTitles.get(row);
  if (title === undefined) {
    title = truncateSessionTitle(fullTitle);
    displayTitles.set(row, title);
  }
  return title;
}

/** Project options by name; equal names by id, so no history decides. */
export function compareProjectOptions(
  a: { id: string; name: string },
  b: { id: string; name: string },
) {
  return (
    a.name.localeCompare(b.name) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

type RetainedItemsDeps = Pick<
  GlobalSessionsDeps,
  | "signal"
  | "sessionMetadataService"
  | "supervisor"
  | "externalTracker"
  | "notificationService"
  | "sessionAutoArchiveDays"
  | "projectDisplayName"
  | "providerChildRelationships"
>;

/** The inputs a walk reads; requests whose inputs are identical share one. */
const WALK_INPUTS = [
  "signal",
  "sessionMetadataService",
  "supervisor",
  "externalTracker",
  "notificationService",
  "sessionAutoArchiveDays",
  "projectDisplayName",
] as const satisfies readonly (keyof RetainedItemsDeps)[];

interface RetainedWalk {
  sessions: readonly GlobalSessionItem[];
  stats: GlobalSessionStats;
  projects: Array<{ id: string; name: string }>;
  catalog: Awaited<ReturnType<RetainedSessionCollections["read"]>>["catalog"];
  nativeRowsById: ReadonlyMap<string, ProjectedCatalogRow>;
  seen: ReadonlySet<string>;
}

/**
 * The walk that has been asked for but has not started, per collection. A
 * tab asks for its three sidebar feeds and Inbox together after every
 * catalog change, but their requests reach this code up to about 20 ms
 * apart (measured: median 9 ms, 90th percentile 23 ms). A walk therefore
 * starts {@link WALK_SHARE_MS} after the first request, and each request that
 * arrives before it starts shares it, so every sharer gets a walk that began
 * after it asked. Measured on a long active session: 181 list reads took 58
 * walks, against 121 when sharing only within one event-loop turn. A lone
 * request waits the same 20 ms.
 */
const WALK_SHARE_MS = 20;
const scheduledWalks = new WeakMap<
  RetainedSessionCollections,
  { deps: RetainedItemsDeps; walk: Promise<RetainedWalk> }
>();

function sharedWalk(
  service: RetainedSessionCollections,
  deps: RetainedItemsDeps,
): Promise<RetainedWalk> {
  const scheduled = scheduledWalks.get(service);
  if (
    scheduled &&
    WALK_INPUTS.every((key) => scheduled.deps[key] === deps[key])
  )
    return scheduled.walk;
  const walk = new Promise<void>((resolve) =>
    setTimeout(resolve, WALK_SHARE_MS),
  ).then(() => {
    if (scheduledWalks.get(service)?.walk === walk)
      scheduledWalks.delete(service);
    return walkRetainedItems(service, deps);
  });
  scheduledWalks.set(service, { deps, walk });
  return walk;
}

export async function readRetainedSessionItems(
  service: RetainedSessionCollections,
  deps: RetainedItemsDeps,
  selectChildParents?: (
    sessions: readonly GlobalSessionItem[],
  ) => readonly GlobalSessionItem[],
) {
  const { sessions, stats, projects, catalog, nativeRowsById, seen } =
    await sharedWalk(service, deps);
  // The route selects its authorized, filtered page before any child queries.
  // Stats and offscreen rows do not need relationship enrichment. Items are
  // shared with other requests, so enriched ones are copies.
  const enriched = new Map<GlobalSessionItem, GlobalSessionItem>();
  for (const item of selectChildParents?.(sessions) ?? []) {
    // Catalog identities are projected to public ids above; structural SQL
    // keys retain the exact native id and scope, including private stores.
    // This read cannot register a source or acquire provider persistence.
    // A managed control row can precede native catalog publication. Its SQL
    // identity is authoritative; an unscoped native catalog row is not.
    const row = nativeRowsById.get(item.id);
    const nativeParent =
      deps.providerChildRelationships &&
      ((row &&
        nativeCatalogSessionRef({ ...row, sessionId: row.nativeSessionId })) ??
        (!seen.has(item.id) && isYaSessionId(item.id)
          ? deps.sessionMetadataService?.identities.resolveYa(item.id)?.native
          : undefined));
    const children = nativeParent
      ? deps.providerChildRelationships?.accepted(nativeParent, item.id)
      : undefined;
    if (children !== undefined)
      enriched.set(item, { ...item, providerChildren: children });
  }
  return {
    sessions: sessions.map((item) => enriched.get(item) ?? item),
    stats: {
      ...stats,
      providerCounts: { ...stats.providerCounts },
      executorCounts: { ...stats.executorCounts },
    },
    projects: [...projects],
    catalog,
  };
}

async function walkRetainedItems(
  service: RetainedSessionCollections,
  deps: RetainedItemsDeps,
): Promise<RetainedWalk> {
  const { rows: nativeRows, catalog } = await service.read();
  const rows = await projectCatalogIdentities(
    nativeRows,
    deps.sessionMetadataService,
    deps.signal,
  );
  // Named now, not from the row: a stored `projectName` is only as current as
  // the file's last read, and renaming a project rereads nothing.
  const projectDisplayName = deps.projectDisplayName ?? getProjectName;
  // Each project is named once, from its last row's path, in first-row order.
  const projectPaths = new Map<string, string>();
  for (const row of rows) projectPaths.set(row.projectId, row.projectPath);
  const projects = new Map<string, { id: string; name: string }>(
    [...projectPaths].map(([id, path]) => [
      id,
      { id, name: projectDisplayName(path) },
    ]),
  );
  const cutoff = getActiveSessionIndexOptions(
    deps.sessionAutoArchiveDays,
  )?.activeAfterMs;
  const nativeItems: GlobalSessionItem[] = [];
  // Rows by public id; a page item's native parent is derived only for the
  // rows the route selects, not for every row.
  const nativeRowsById = new Map<string, ProjectedCatalogRow>();
  const seen = new Set<string>();
  const stats: GlobalSessionStats = {
    totalCount: 0,
    unreadCount: 0,
    starredCount: 0,
    archivedCount: 0,
    providerCounts: {},
    executorCounts: {},
  };
  for (const row of rows) {
    if (seen.has(row.sessionId)) continue;
    seen.add(row.sessionId);
    const metadata = deps.sessionMetadataService?.getMetadata(row.sessionId);
    const process = deps.supervisor?.getProcessForSession(row.sessionId);
    const projectId = metadata?.workingProjectId ?? row.projectId;
    const providerUpdatedAt = getEffectiveProviderUpdatedAt(
      row.updatedAt,
      process,
    );
    const recap = latestRecapMessage(
      deps.sessionMetadataService?.getRecapMessages(row.sessionId) ?? [],
    );
    const updatedAt =
      recap && Date.parse(recap.timestamp) > Date.parse(providerUpdatedAt)
        ? recap.timestamp
        : providerUpdatedAt;
    const isArchived =
      metadata?.isArchived ?? isSessionAutoArchived({ updatedAt }, cutoff);
    const runtime = sessionRowRuntimeOverlay(process, {
      sessionId: row.sessionId,
      providerUpdatedAt,
      notificationService: deps.notificationService,
      externalTracker: deps.externalTracker,
    });
    const hasUnread = runtime.hasUnread;
    const provider = metadata?.provider ?? row.provider ?? row.catalogFamily;
    // All Sessions matches these rows in the browser, so the row carries the
    // session's own words as `fullTitle`/`initialPrompt` and a display-length
    // `title` beside them — the same pair the unretained collection sends.
    // Without it a client-side search can only see the display title, and a
    // match living deeper in the first message is unreachable without a
    // server-side search the client would have to direct.
    const fullTitle = row.title ?? undefined;
    nativeRowsById.set(row.sessionId, row);
    const item: GlobalSessionItem = {
      id: row.sessionId,
      ...(row.title !== undefined
        ? {
            title: row.title === null ? null : displayTitle(row, row.title),
            fullTitle,
          }
        : {}),
      updatedAt,
      ...(row.createdAt ? { createdAt: row.createdAt } : {}),
      // The sidebar files a session by the later of this and its creation
      // time, as it does from the full walk.
      ...(row.lastHumanTurnAt ? { lastHumanTurnAt: row.lastHumanTurnAt } : {}),
      provider,
      projectId,
      projectName:
        projects.get(projectId)?.name ?? projectDisplayName(row.projectPath),
      ownership: runtime.ownership,
      pendingInputType: runtime.pendingInputType,
      activity: runtime.activity,
      hasUnread,
      isArchived,
      isStarred: metadata?.isStarred ?? false,
      sidebarCategory: metadata?.sidebarCategory,
      createdByUser: metadata?.createdByUser,
      customTitle: metadata?.customTitle,
      initialPrompt: metadata?.initialPrompt ?? fullTitle,
      nonHumanUserTurn: nonHumanUserTurnField(
        deps.sessionMetadataService,
        row.sessionId,
      ),
      autoResumeDisabled: metadata?.autoResumeDisabled === true,
      parentSessionId: metadata?.parentSessionId,
      parentSessionKind: metadata?.parentSessionKind,
      forkedFromSessionId: metadata?.forkedFromSessionId,
      creationProvenance: metadata?.creationProvenance,
      executor: metadata?.executor,
      ...(row.asyncQuestions ? { asyncQuestions: row.asyncQuestions } : {}),
    };
    nativeItems.push(item);
  }
  const sessions = mergeCreationGlobalItems(
    nativeItems,
    deps.sessionMetadataService,
    deps,
  );
  for (const item of sessions) {
    if (
      !item.creation ||
      (isUrlProjectId(item.projectId) &&
        !isDetachedProjectPath(fromUrlProjectId(item.projectId)))
    )
      projects.set(item.projectId, {
        id: item.projectId,
        name: item.projectName,
      });
    if (item.isStarred) stats.starredCount += 1;
    if (item.isArchived) {
      stats.archivedCount += 1;
      continue;
    }
    stats.totalCount += 1;
    if (item.hasUnread) stats.unreadCount += 1;
    stats.providerCounts[item.provider] =
      (stats.providerCounts[item.provider] ?? 0) + 1;
    const executor = item.executor ?? "local";
    stats.executorCounts[executor] = (stats.executorCounts[executor] ?? 0) + 1;
  }
  // Newest first, then by id. Each time is parsed once, not per comparison.
  const times = new Map(
    sessions.map((item) => [item, Date.parse(item.updatedAt)]),
  );
  sessions.sort(
    (a, b) => times.get(b)! - times.get(a)! || a.id.localeCompare(b.id),
  );
  return {
    sessions,
    stats,
    projects: [...projects.values()].sort(compareProjectOptions),
    catalog,
    nativeRowsById,
    seen,
  };
}
