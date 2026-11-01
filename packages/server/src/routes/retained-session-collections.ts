import { truncateSessionTitle } from "@yep-anywhere/shared";
import { projectCatalogIdentities } from "../sessions/catalog-identity.js";
import { nonHumanUserTurnField } from "../metadata/SessionMetadataService.js";
import { getProjectName } from "../projects/paths.js";
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

export async function readRetainedSessionItems(
  service: RetainedSessionCollections,
  deps: Pick<
    GlobalSessionsDeps,
    | "sessionMetadataService"
    | "supervisor"
    | "externalTracker"
    | "notificationService"
    | "sessionAutoArchiveDays"
    | "projectDisplayName"
  >,
) {
  const { rows: nativeRows, catalog } = await service.read();
  const rows = projectCatalogIdentities(
    nativeRows,
    deps.sessionMetadataService,
  );
  // Named now, not from the row: a stored `projectName` is only as current as
  // the file's last read, and renaming a project rereads nothing.
  const projectDisplayName = deps.projectDisplayName ?? getProjectName;
  const projects = new Map(
    rows.map((row) => [
      row.projectId,
      { id: row.projectId, name: projectDisplayName(row.projectPath) },
    ]),
  );
  const cutoff = getActiveSessionIndexOptions(
    deps.sessionAutoArchiveDays,
  )?.activeAfterMs;
  const sessions: GlobalSessionItem[] = [];
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
    const item: GlobalSessionItem = {
      id: row.sessionId,
      ...(row.title !== undefined
        ? {
            title: row.title === null ? null : truncateSessionTitle(row.title),
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
    sessions.push(item);
    if (item.isStarred) stats.starredCount += 1;
    if (isArchived) {
      stats.archivedCount += 1;
      continue;
    }
    stats.totalCount += 1;
    if (hasUnread) stats.unreadCount += 1;
    stats.providerCounts[provider] = (stats.providerCounts[provider] ?? 0) + 1;
    const executor = item.executor ?? "local";
    stats.executorCounts[executor] = (stats.executorCounts[executor] ?? 0) + 1;
  }
  sessions.sort(
    (a, b) =>
      Date.parse(b.updatedAt) - Date.parse(a.updatedAt) ||
      a.id.localeCompare(b.id),
  );
  return {
    sessions,
    stats,
    projects: [...projects.values()].sort((a, b) =>
      a.name.localeCompare(b.name),
    ),
    catalog,
  };
}
