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
  } = {},
): GlobalSessionItem[] {
  if (options.signal?.aborted) return [];
  if (!metadata) return native;
  const rows = creationCollectionRows(metadata, options.signal),
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
    const summary = creationSessionSummary(row, metadata);
    if (!summary) continue;
    const stored = metadata.getMetadata(row.sessionId);
    result.push({
      ...summary,
      projectName: projectName(fromUrlProjectId(summary.projectId)),
      initialPrompt: stored?.initialPrompt,
      createdByUser: stored?.createdByUser,
      sidebarCategory: stored?.sidebarCategory,
      isArchived: stored?.isArchived ?? isSessionAutoArchived(summary, cutoff),
    });
  }
  return result;
}

export interface CreationNativeInventoryItem {
  id: string;
  projectId: string;
  provider: import("@yep-anywhere/shared").ProviderName;
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
  metadata: SessionMetadataService | undefined,
  options: {
    signal?: AbortSignal;
    nativeInventory?: readonly CreationNativeInventoryItem[];
    projectMetadata?: import("../metadata/ProjectMetadataService.js").ProjectMetadataService;
    runtimeCounts: (projectId: import("@yep-anywhere/shared").UrlProjectId) => {
      activeOwnedCount: number;
      activeExternalCount: number;
      projectQueueBlockingCount: number;
    };
  },
): Array<T | ProjectCard> {
  if (options.signal?.aborted) return [];
  if (!metadata) return native;
  const groups = new Map<
    string,
    {
      provider: ProjectCard["provider"];
      updatedAt: string;
      sessions: Map<string, ProjectCard["provider"]>;
    }
  >();
  const rows = creationCollectionRows(metadata, options.signal);
  const control = new Map(rows.map((row) => [String(row.sessionId), row]));
  for (const row of rows) {
    const projectId =
      metadata.getMetadata(row.sessionId)?.workingProjectId ?? row.projectId;
    const path = fromUrlProjectId(projectId);
    if (
      isDetachedProjectPath(path) ||
      options.projectMetadata?.isHiddenProjectPath(path)
    )
      continue;
    const group = groups.get(projectId) ?? {
      provider: row.provider,
      updatedAt: row.deleted ? "" : row.updatedAt,
      sessions: new Map(),
    };
    if (!row.deleted) group.sessions.set(row.sessionId, row.provider);
    if (
      !row.deleted &&
      (!group.updatedAt ||
        Date.parse(row.updatedAt) > Date.parse(group.updatedAt))
    )
      group.updatedAt = row.updatedAt;
    groups.set(projectId, group);
  }
  // One compact publication supplies both native count and overlap. Aggregate
  // scanner counts cannot reveal whether a bound creation is represented yet.
  for (const item of options.nativeInventory ?? []) {
    const creation = control.get(item.id);
    if (creation?.deleted || (creation && !creation.nativeBound)) continue;
    groups.get(item.projectId)?.sessions.set(item.id, item.provider);
  }
  const countsFor = (sessions: Map<string, ProjectCard["provider"]>) => {
    const counts: NonNullable<ProjectCard["sessionCountsByProvider"]> = {};
    for (const provider of sessions.values())
      counts[provider] = (counts[provider] ?? 0) + 1;
    return counts;
  };
  const result: Array<T | ProjectCard> = native.map((project) => {
    const group = groups.get(project.id);
    if (!group) return project;
    groups.delete(project.id);
    return {
      ...project,
      sessionCountsByProvider: countsFor(group.sessions),
      sessionCount: group.sessions.size,
      lastActivity:
        group.updatedAt &&
        (!project.lastActivity ||
          Date.parse(group.updatedAt) > Date.parse(project.lastActivity))
          ? group.updatedAt
          : project.lastActivity,
    };
  });
  for (const [id, group] of groups) {
    if (group.sessions.size === 0) continue;
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
      sessionCount: group.sessions.size,
      sessionCountsByProvider: countsFor(group.sessions),
      ...options.runtimeCounts(id),
      lastActivity: group.updatedAt,
      ...(registration?.ownerUsername
        ? { ownerUsername: registration.ownerUsername }
        : {}),
    });
  }
  return result;
}
