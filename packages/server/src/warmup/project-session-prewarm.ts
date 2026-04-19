import type { ProviderProjectCatalog } from "../routes/provider-catalog.js";
import type { Project } from "../supervisor/types.js";

export interface ProjectSessionPrewarmDeps {
  listProjects: () => Promise<Project[]>;
  buildProviderCatalog: (
    projects: Project[],
  ) => Promise<ProviderProjectCatalog>;
  warmProject: (
    project: Project,
    providerCatalog: ProviderProjectCatalog,
  ) => Promise<void>;
  recentProjectIds?: string[];
  limit?: number;
}

export async function prewarmProjectSessions(
  deps: ProjectSessionPrewarmDeps,
): Promise<void> {
  const projects = await deps.listProjects();
  if (projects.length === 0) return;

  const providerCatalog = await deps.buildProviderCatalog(projects);
  const recentProjectScores = new Map<string, number>();
  const recentProjectIds = deps.recentProjectIds ?? [];
  for (let i = 0; i < recentProjectIds.length; i++) {
    const projectId = recentProjectIds[i];
    if (!projectId) continue;
    const score = recentProjectIds.length - i;
    recentProjectScores.set(
      projectId,
      (recentProjectScores.get(projectId) ?? 0) + score,
    );
  }

  const sortedProjects = [...projects]
    .sort((a, b) => {
      const recentDelta =
        (recentProjectScores.get(b.id) ?? 0) -
        (recentProjectScores.get(a.id) ?? 0);
      if (recentDelta !== 0) {
        return recentDelta;
      }
      if (!a.lastActivity && !b.lastActivity) return 0;
      if (!a.lastActivity) return 1;
      if (!b.lastActivity) return -1;
      return (
        new Date(b.lastActivity).getTime() - new Date(a.lastActivity).getTime()
      );
    })
    .slice(0, Math.max(0, deps.limit ?? 10));

  for (const project of sortedProjects) {
    try {
      await deps.warmProject(project, providerCatalog);
    } catch {
      // Best-effort startup prewarm only; continue with remaining projects.
    }
  }
}
