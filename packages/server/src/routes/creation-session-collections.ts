import type { ProjectCardGroup } from "../services/project-card-counts.js";
import { fromUrlProjectId, assertUrlProjectId } from "@yep-anywhere/shared";
import type { SessionMetadataService } from "../metadata/SessionMetadataService.js";
import {
  getProjectName,
  isDetachedProjectPath,
  type ProjectDisplayNameResolver,
} from "../projects/paths.js";
import {
  creationCollectionRows,
  creationSessionSummary,
} from "../sessions/session-creation-view.js";
import type { GlobalSessionItem } from "./global-sessions.js";
import {
  getActiveSessionIndexOptions,
  isSessionAutoArchived,
} from "./session-list-options.js";

/** Merge YA control rows after native projection, never into the physical catalog. */
export function mergeCreationGlobalItems(
  native: GlobalSessionItem[],
  metadata: SessionMetadataService | undefined,
  options: {
    signal?: AbortSignal;
    projectDisplayName?: ProjectDisplayNameResolver;
    sessionAutoArchiveDays?: number;
    controlRows?: ReturnType<typeof creationCollectionRows>;
    metadataReader?: Pick<SessionMetadataService, "getMetadata">;
  } = {},
): GlobalSessionItem[] {
  if (options.signal?.aborted) return [];
  if (!metadata) return native;
  const rows =
      options.controlRows ?? creationCollectionRows(metadata, options.signal),
    byId = new Map(rows.map((row) => [String(row.sessionId), row]));
  const result = native.flatMap((item) => {
    const row = byId.get(item.id);
    return row?.deleted || (row && !row.nativeBound)
      ? []
      : [{ ...item, ...(row ? { creation: row.creation } : {}) }];
  });
  const projectName = options.projectDisplayName ?? getProjectName,
    cutoff = getActiveSessionIndexOptions(
      options.sessionAutoArchiveDays,
    )?.activeAfterMs;
  const seen = new Set(result.map((item) => item.id));
  for (const row of rows) {
    if (seen.has(row.sessionId)) continue;
    const reader = options.metadataReader ?? metadata;
    const summary = creationSessionSummary(row, reader);
    if (!summary) continue;
    const stored = reader.getMetadata(row.sessionId);
    result.push({
      ...summary,
      projectName: projectName(fromUrlProjectId(summary.projectId)),
      initialPrompt: stored?.initialPrompt,
      createdByUser: stored?.createdByUser,
      apiClient: stored?.apiClient,
      sidebarCategory: stored?.sidebarCategory,
      isArchived: stored?.isArchived ?? isSessionAutoArchived(summary, cutoff),
    });
  }
  return result;
}

interface ProjectCard {
  id: string;
  path: string;
  name: string;
  provider: import("@yep-anywhere/shared").ProviderName;
  sessionCount: number;
  sessionCountsByProvider?: Partial<
    Record<import("@yep-anywhere/shared").ProviderName, number>
  >;
  activeOwnedCount: number;
  activeExternalCount: number;
  lastActivity: string | null;
  ownerUsername?: string;
}

/** Public cards only: a saved project is not a provider discovery input. */
export function mergeCreationProjectCards<T extends ProjectCard>(
  native: T[],
  groups: Map<string, ProjectCardGroup>,
  options: {
    projectMetadata?: import("../metadata/ProjectMetadataService.js").ProjectMetadataService;
    runtimeCounts: (projectId: import("@yep-anywhere/shared").UrlProjectId) => {
      activeOwnedCount: number;
      activeExternalCount: number;
      projectQueueBlockingCount: number;
    };
  },
): Array<T | ProjectCard> {
  for (const id of groups.keys()) {
    assertUrlProjectId(id);
    const path = fromUrlProjectId(id);
    if (
      isDetachedProjectPath(path) ||
      options.projectMetadata?.isHiddenProjectPath(path)
    )
      groups.delete(id);
  }
  const result: Array<T | ProjectCard> = native.map((project) => {
    const group = groups.get(project.id);
    if (!group) return project;
    groups.delete(project.id);
    return {
      ...project,
      sessionCountsByProvider: group.sessionCountsByProvider,
      sessionCount: group.sessionCount,
      lastActivity:
        group.updatedAt &&
        (!project.lastActivity ||
          Date.parse(group.updatedAt) > Date.parse(project.lastActivity))
          ? group.updatedAt
          : project.lastActivity,
    };
  });
  for (const [id, group] of groups) {
    if (group.sessionCount === 0) continue;
    assertUrlProjectId(id);
    const path = fromUrlProjectId(id),
      registration = options.projectMetadata?.getMetadata(id);
    result.push({
      id,
      path,
      name:
        options.projectMetadata?.getProjectDisplayName(path) ??
        getProjectName(path),
      provider: group.provider,
      sessionCount: group.sessionCount,
      sessionCountsByProvider: group.sessionCountsByProvider,
      ...options.runtimeCounts(id),
      lastActivity: group.updatedAt ?? "",
      ...(registration?.ownerUsername
        ? { ownerUsername: registration.ownerUsername }
        : {}),
    });
  }
  return result;
}
