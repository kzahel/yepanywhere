import {
  type Dispatch,
  type MouseEvent as ReactMouseEvent,
  type SetStateAction,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { NavigateFunction } from "react-router-dom";
import { api } from "../api/client";
import { useToastContext } from "../contexts/ToastContext";
import { useI18n } from "../i18n";
import { activityBus } from "../lib/activityBus";
import type { Project } from "../types";
import type { useProjects } from "./useProjects";

/**
 * The session page's project move menu: the breadcrumb's context menu
 * listing the other projects (a shared `Menu` anchored to the breadcrumb,
 * which owns dismissal and focus), moving the session to the chosen project.
 * Moved verbatim from `SessionPage.tsx`
 * (docs/tactical/182-session-page-header-and-footer.md slice 2).
 */
export function useProjectReclassifyMenu({
  projectId,
  actualSessionId,
  projects,
  basePath,
  location,
  navigate,
  isDomLingerParked,
  setShowRecentSessions,
}: {
  projectId: string;
  actualSessionId: string;
  projects: ReturnType<typeof useProjects>["projects"];
  basePath: string;
  location: { search: string; state: unknown };
  navigate: NavigateFunction;
  isDomLingerParked: boolean;
  setShowRecentSessions: Dispatch<SetStateAction<boolean>>;
}) {
  const { t } = useI18n();
  const { showToast } = useToastContext();
  const [showProjectReclassifyMenu, setShowProjectReclassifyMenu] =
    useState(false);
  const [isReclassifyingProject, setIsReclassifyingProject] = useState(false);
  const projectBreadcrumbRef = useRef<HTMLAnchorElement>(null);

  const projectReclassifyOptions = useMemo(
    () =>
      projects
        .filter((candidate) => candidate.id !== projectId)
        .sort((a, b) => a.name.localeCompare(b.name)),
    [projectId, projects],
  );

  // The menu portals to the body, so a parked (hidden) page must not keep it.
  useEffect(() => {
    if (isDomLingerParked) setShowProjectReclassifyMenu(false);
  }, [isDomLingerParked]);

  const closeProjectReclassifyMenu = useCallback(
    () => setShowProjectReclassifyMenu(false),
    [],
  );

  const handleProjectBreadcrumbContextMenu = useCallback(
    (event: ReactMouseEvent<HTMLAnchorElement>) => {
      event.preventDefault();
      event.stopPropagation();
      if (projectReclassifyOptions.length === 0) {
        return;
      }
      setShowRecentSessions(false);
      setShowProjectReclassifyMenu(true);
    },
    [projectReclassifyOptions.length, setShowRecentSessions],
  );

  const handleReclassifySessionProject = useCallback(
    async (targetProject: Project) => {
      if (targetProject.id === projectId || isReclassifyingProject) {
        return;
      }

      setIsReclassifyingProject(true);
      try {
        const result = await api.reclassifySessionProject(
          projectId,
          actualSessionId,
          targetProject.id,
        );
        activityBus.emitLocal("session-metadata-changed", {
          type: "session-metadata-changed",
          sessionId: actualSessionId,
          projectId: result.projectId,
          transcriptProjectId: result.transcriptProjectId,
          timestamp: new Date().toISOString(),
        });
        setShowProjectReclassifyMenu(false);
        showToast(
          t("sessionReclassifiedProject", { project: targetProject.name }),
          "success",
        );
        navigate(
          `${basePath}/projects/${result.projectId}/sessions/${actualSessionId}${location.search}`,
          {
            replace: true,
            state: location.state,
          },
        );
      } catch (err) {
        console.error("Failed to move session to project:", err);
        showToast(t("sessionReclassifyProjectFailed"), "error");
      } finally {
        setIsReclassifyingProject(false);
      }
    },
    [
      actualSessionId,
      basePath,
      isReclassifyingProject,
      location.search,
      location.state,
      navigate,
      projectId,
      showToast,
      t,
    ],
  );

  return {
    showProjectReclassifyMenu,
    isReclassifyingProject,
    projectBreadcrumbRef,
    projectReclassifyOptions,
    closeProjectReclassifyMenu,
    handleProjectBreadcrumbContextMenu,
    handleReclassifySessionProject,
  };
}
