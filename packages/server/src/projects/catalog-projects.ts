import type { ProviderName } from "@yep-anywhere/shared";
import type { SessionCatalogRow } from "../sessions/catalog-types.js";
import type { SessionCatalogProviderSourceSnapshot } from "../services/SessionCatalogService.js";

export interface CatalogProject {
  path: string;
  provider: ProviderName;
  counts: Partial<Record<ProviderName, number>>;
  lastActivity: string;
}
export interface CatalogProjectsView {
  projects: readonly CatalogProject[];
  complete: boolean;
  /** Only project facts change this version; title-only updates do not. */
  version: string;
  refreshing?: boolean;
  refreshError?: string;
}
export interface CatalogProjectSource {
  read(refresh?: boolean): Promise<CatalogProjectsView>;
  peek(): CatalogProjectsView;
}
export type CatalogProjectStore = Pick<
  SessionCatalogProviderSourceSnapshot,
  "catalogFamily" | "storeKey"
>;

export function catalogStoreKey(store: CatalogProjectStore): string {
  return JSON.stringify([store.catalogFamily, store.storeKey]);
}

/** Pure compact projection of accepted, eligible native stores. */
export function catalogProjects(
  rows: readonly Readonly<SessionCatalogRow>[],
  sources: readonly CatalogProjectStore[],
  eligible: readonly CatalogProjectStore[],
): CatalogProjectsView {
  const stores = new Set(eligible.map(catalogStoreKey));
  const accepted = new Set(sources.map(catalogStoreKey));
  const complete = [...stores].every((key) => accepted.has(key));
  const projects = new Map<string, CatalogProject>();
  for (const row of rows) {
    if (!stores.has(catalogStoreKey(row))) continue;
    let project = projects.get(row.projectIdentityKey);
    if (!project) {
      project = {
        path: row.projectPath,
        provider: row.catalogFamily,
        counts: {},
        lastActivity: row.updatedAt,
      };
      projects.set(row.projectIdentityKey, project);
    }
    if (row.catalogFamily < project.provider)
      project.provider = row.catalogFamily;
    project.counts[row.catalogFamily] =
      (project.counts[row.catalogFamily] ?? 0) + 1;
    if (row.updatedAt > project.lastActivity)
      project.lastActivity = row.updatedAt;
  }
  const ordered = [...projects.values()].sort((a, b) =>
    a.path.localeCompare(b.path),
  );
  for (const project of ordered)
    project.counts = Object.fromEntries(
      Object.entries(project.counts).sort(([a], [b]) => a.localeCompare(b)),
    );
  return {
    projects: ordered,
    complete,
    version: JSON.stringify([complete, ordered]),
  };
}
