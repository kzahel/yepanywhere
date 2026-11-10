import chromeSessionHeaderStyles from "./SessionHeader.module.css";
import { projectDisplayName } from "@yep-anywhere/shared";
import { useNavigate } from "react-router-dom";
import { useProjects } from "../hooks/useProjects";
import { useRemoteBasePath } from "../hooks/useRemoteBasePath";
import { useI18n } from "../i18n";
import type { Project } from "../types";
import styles from "./ProjectSelector.module.css";
import { ButtonBase } from "./ui/Button";
import { Menu, MenuItem, useMenuTrigger } from "./ui/Menu";

interface ProjectSelectorProps {
  /** Currently selected project ID */
  currentProjectId: string;
  /** Current project name (for display before projects load) */
  currentProjectName?: string;
  /** Called when a new project is selected */
  onProjectChange?: (project: Project) => void;
}

/**
 * A dropdown selector for choosing which project to create a session in.
 * Shows as a clickable title that opens a menu (desktop) or bottom sheet (phone).
 */
export function ProjectSelector({
  currentProjectId,
  currentProjectName,
  onProjectChange,
}: ProjectSelectorProps) {
  const { t } = useI18n();
  const menu = useMenuTrigger();
  const navigate = useNavigate();
  const basePath = useRemoteBasePath();

  const { projects, loading } = useProjects();

  // Find current project name
  const currentProject = projects.find((p) => p.id === currentProjectId);
  const displayName = currentProject
    ? projectDisplayName(currentProject)
    : (currentProjectName ?? t("projectSelectorFallback"));

  const handleProjectSelect = (project: Project) => {
    if (project.id !== currentProjectId) {
      // If a callback is provided, use it (allows parent to handle URL updates)
      // Otherwise navigate to the new project's new-session page
      if (onProjectChange) {
        onProjectChange(project);
      } else {
        navigate(
          `${basePath}/new-session?projectId=${encodeURIComponent(project.id)}`,
        );
      }
    }
  };

  // Don't show selector if only one project
  if (!loading && projects.length <= 1) {
    return (
      <span
        className={`${chromeSessionHeaderStyles["session-title"]}`}
        data-session-title
      >
        {displayName}
      </span>
    );
  }

  return (
    <div className={styles.container} data-project-selector>
      <ButtonBase
        {...menu.triggerProps}
        className={styles.button}
        data-project-selector-button
        title={t("projectSelectorChangeProject")}
      >
        <span className={styles.text} data-project-selector-text>
          {displayName}
        </span>
        <svg
          className={styles.chevron}
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </ButtonBase>
      <Menu
        open={menu.open}
        onClose={menu.close}
        anchorRef={menu.anchorRef}
        placement="bottom-start"
        phoneSheet
        aria-label={t("projectSelectorSelectProject")}
        className={styles.menu}
      >
        {projects.map((project) => (
          <MenuItem
            key={project.id}
            kind="radio"
            checked={project.id === currentProjectId}
            description={t("projectSelectorSessionsCount", {
              count: project.sessionCount,
            })}
            onSelect={() => handleProjectSelect(project)}
          >
            {projectDisplayName(project)}
          </MenuItem>
        ))}
      </Menu>
    </div>
  );
}
