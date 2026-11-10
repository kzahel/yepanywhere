import { truncateSessionTitle } from "@yep-anywhere/shared";
import type { ProjectedCatalogRow } from "../sessions/catalog-identity.js";
import { nonHumanUserTurnField } from "../metadata/SessionMetadataService.js";
import {
  getEffectiveProviderUpdatedAt,
  latestRecapMessage,
} from "../sessions/recap-overlays.js";
import { sessionRowRuntimeOverlay } from "../sessions/session-runtime-overlay.js";
import { isSessionAutoArchived } from "./session-list-options.js";
import type { GlobalSessionItem } from "./global-sessions.js";
import type { RetainedItemsDeps } from "./retained-session-collections.js";

export function retainedNativeItem(
  row: ProjectedCatalogRow,
  deps: RetainedItemsDeps,
  projectName: (id: string, fallbackPath: string) => string,
  cutoff?: number,
): GlobalSessionItem {
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
  return {
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
    projectName: projectName(projectId, row.projectPath),
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
