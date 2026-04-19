import { useMemo } from "react";
import { useProjects } from "./useProjects";

const MAX_RECENT_PROJECTS = 12;

/**
 * Hook to get recently active projects.
 *
 * Uses the `lastActivity` field from the projects API to sort by recency.
 * Returns up to 12 most recently active projects.
 */
export function useRecentProjects(enabled = true) {
  const { projects, loading } = useProjects(enabled);

  const recentProjects = useMemo(() => {
    // Filter to projects with activity, sort by lastActivity descending
    return [...projects]
      .filter((p) => p.lastActivity !== null)
      .sort((a, b) => {
        const aTime = a.lastActivity ? new Date(a.lastActivity).getTime() : 0;
        const bTime = b.lastActivity ? new Date(b.lastActivity).getTime() : 0;
        return bTime - aTime;
      })
      .slice(0, MAX_RECENT_PROJECTS);
  }, [projects]);

  return {
    /** Recently active projects (most recent first) */
    recentProjects,
    /** All projects (for fallback when recentProjects is empty) */
    projects,
    /** True while loading project data */
    loading,
  };
}
