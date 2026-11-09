import type { ProviderName } from "@yep-anywhere/shared";
import {
  type SessionCatalogRow,
  sessionCatalogRowKey,
} from "../sessions/catalog-types.js";
import type {
  SessionCatalogChanges,
  SessionCatalogProviderSourceSnapshot,
} from "../services/SessionCatalogService.js";

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
  return new CatalogProjectsProjection().apply(
    { full: true, rows, removed: [] },
    sources,
    eligible,
  );
}

type ProjectMember = Pick<
  SessionCatalogRow,
  "catalogFamily" | "projectPath" | "updatedAt"
>;

/**
 * The project view kept up to date from catalog changes (plan 189 step 4):
 * a publication touches the projects of the rows it changed or removed, and
 * only those are folded again. The result equals `catalogProjects` over the
 * same rows, except that a project whose rows spell its path differently
 * takes the spelling of the row it first held rather than the row first in
 * the catalog.
 */
export class CatalogProjectsProjection {
  /** Row key to its project key, for every eligible row. */
  private readonly rowProject = new Map<string, string>();
  /** Project key to its eligible rows, in the order they arrived. */
  private readonly members = new Map<string, Map<string, ProjectMember>>();
  private readonly folded = new Map<string, CatalogProject>();
  private storesKey?: string;

  /**
   * Apply one change read. `full` starts over from its rows; otherwise the
   * changed rows replace their keys and the removed keys leave. A change of
   * `eligible` stores also starts over, so its caller must pass a full read.
   */
  apply(
    changes: Pick<SessionCatalogChanges, "full" | "rows" | "removed">,
    sources: readonly CatalogProjectStore[],
    eligible: readonly CatalogProjectStore[],
  ): CatalogProjectsView {
    const stores = new Set(eligible.map(catalogStoreKey));
    const storesKey = [...stores].sort().join("\n");
    const touched = new Set<string>();
    if (changes.full || storesKey !== this.storesKey) {
      this.rowProject.clear();
      this.members.clear();
      this.folded.clear();
      this.storesKey = storesKey;
    }
    const leave = (key: string) => {
      const project = this.rowProject.get(key);
      if (project === undefined) return;
      this.rowProject.delete(key);
      this.members.get(project)?.delete(key);
      touched.add(project);
    };
    for (const removed of changes.removed) leave(sessionCatalogRowKey(removed));
    for (const row of changes.rows) {
      const key = sessionCatalogRowKey(row);
      const project = row.projectIdentityKey;
      if (this.rowProject.get(key) !== project) leave(key);
      if (!stores.has(catalogStoreKey(row))) continue;
      this.rowProject.set(key, project);
      const members = this.members.get(project) ?? new Map();
      this.members.set(project, members);
      members.set(key, {
        catalogFamily: row.catalogFamily,
        projectPath: row.projectPath,
        updatedAt: row.updatedAt,
      });
      touched.add(project);
    }
    for (const project of touched) {
      const members = this.members.get(project);
      const folded = members?.size ? foldProject(members.values()) : undefined;
      if (folded) this.folded.set(project, folded);
      else {
        this.folded.delete(project);
        this.members.delete(project);
      }
    }
    const accepted = new Set(sources.map(catalogStoreKey));
    const complete = [...stores].every((key) => accepted.has(key));
    const ordered = [...this.folded.values()].sort((a, b) =>
      a.path.localeCompare(b.path),
    );
    return {
      projects: ordered,
      complete,
      version: JSON.stringify([complete, ordered]),
    };
  }
}

function foldProject(
  rows: Iterable<ProjectMember>,
): CatalogProject | undefined {
  let project: CatalogProject | undefined;
  for (const row of rows) {
    if (!project) {
      project = {
        path: row.projectPath,
        provider: row.catalogFamily,
        counts: {},
        lastActivity: row.updatedAt,
      };
    }
    if (row.catalogFamily < project.provider)
      project.provider = row.catalogFamily;
    project.counts[row.catalogFamily] =
      (project.counts[row.catalogFamily] ?? 0) + 1;
    if (row.updatedAt > project.lastActivity)
      project.lastActivity = row.updatedAt;
  }
  if (project)
    project.counts = Object.fromEntries(
      Object.entries(project.counts).sort(([a], [b]) => a.localeCompare(b)),
    );
  return project;
}

/**
 * The projects that differ from the last `projects-changed`: added, removed,
 * or with any field changed (plan 189 step 4). Both of the scanner's
 * announcements (a catalog publication, a retained refresh settling) name only
 * these, so a mounted project page refetches when its own project moved
 * rather than whenever any session advances. `previous` is the facts last
 * announced or, before the first, the projects then listed, which all count
 * as changed. `version` is the catalog view the announcement reflects.
 */
export function changedProjects(
  view: Pick<AnnouncedProjects, "version" | "complete">,
  previous: AnnouncedProjects | readonly { id: string }[],
  next: readonly { id: string }[],
): AnnouncedProjects {
  const before =
    "projects" in previous
      ? previous.projects
      : new Map(previous.map((p) => [p.id, ""]));
  const projects = new Map(next.map((p) => [p.id, JSON.stringify(p)]));
  const ids = [...before.keys()].filter((id) => !projects.has(id));
  for (const [id, facts] of projects)
    if (before.get(id) !== facts) ids.push(id);
  // A view that only became complete changes no project, yet a client
  // holding an incomplete empty list must hear of it.
  const completed =
    !("projects" in previous) || previous.complete !== view.complete;
  return { ...view, ids, projects, announce: ids.length > 0 || completed };
}

/** What the scanner last announced in `projects-changed`. */
export interface AnnouncedProjects {
  /** The catalog project view's version and completeness it reflects. */
  version?: string;
  complete?: boolean;
  /** Projects named: those whose facts changed. */
  ids: string[];
  /** Each project's facts, by id. */
  projects: Map<string, string>;
  /** Whether a catalog publication should announce at all. */
  announce: boolean;
}
