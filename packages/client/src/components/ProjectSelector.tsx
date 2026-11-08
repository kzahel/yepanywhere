import { projectDisplayName } from "@yep-anywhere/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import { useProjects } from "../hooks/useProjects";
import { useRemoteBasePath } from "../hooks/useRemoteBasePath";
import { useI18n } from "../i18n";
import type { Project } from "../types";
import styles from "./ProjectSelector.module.css";
import { ButtonBase } from "./ui/Button";

const DESKTOP_BREAKPOINT = 769;

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
 * Shows as a clickable title that opens a dropdown (desktop) or bottom sheet (mobile).
 */
export function ProjectSelector({
  currentProjectId,
  currentProjectName,
  onProjectChange,
}: ProjectSelectorProps) {
  const { t } = useI18n();
  const [isOpen, setIsOpen] = useState(false);
  const [isDesktop, setIsDesktop] = useState(
    () => window.innerWidth >= DESKTOP_BREAKPOINT,
  );
  const buttonRef = useRef<HTMLButtonElement>(null);
  const sheetRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const basePath = useRemoteBasePath();

  const { projects, loading } = useProjects();

  // Find current project name
  const currentProject = projects.find((p) => p.id === currentProjectId);
  const displayName = currentProject
    ? projectDisplayName(currentProject)
    : (currentProjectName ?? t("projectSelectorFallback"));

  const handleButtonClick = () => {
    buttonRef.current?.blur();
    setIsOpen(true);
  };

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
    setIsOpen(false);
  };

  const handleClose = useCallback(() => {
    setIsOpen(false);
  }, []);

  // Track desktop vs mobile
  useEffect(() => {
    const handleResize = () => {
      setIsDesktop(window.innerWidth >= DESKTOP_BREAKPOINT);
    };
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  // Close on Escape
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        handleClose();
      }
    };
    document.addEventListener("keydown", handleKeyDown, true);
    return () => document.removeEventListener("keydown", handleKeyDown, true);
  }, [isOpen, handleClose]);

  // Close on click outside (desktop)
  useEffect(() => {
    if (!isOpen || !isDesktop) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (
        sheetRef.current &&
        !sheetRef.current.contains(e.target as Node) &&
        buttonRef.current &&
        !buttonRef.current.contains(e.target as Node)
      ) {
        handleClose();
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isOpen, isDesktop, handleClose]);

  // Lock body scroll on mobile when open
  useEffect(() => {
    if (isOpen && !isDesktop) {
      document.body.style.overflow = "hidden";
      return () => {
        document.body.style.overflow = "";
      };
    }
  }, [isOpen, isDesktop]);

  // Focus sheet when opened
  useEffect(() => {
    if (isOpen) {
      sheetRef.current?.focus();
    }
  }, [isOpen]);

  const handleOverlayClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      e.preventDefault();
      e.stopPropagation();
      handleClose();
    }
  };

  // Don't show selector if only one project
  if (!loading && projects.length <= 1) {
    return <span className="session-title">{displayName}</span>;
  }

  const optionsContent = (
    <div className={styles.options}>
      {projects.map((project) => {
        const isSelected = project.id === currentProjectId;
        return (
          <button
            key={project.id}
            type="button"
            className={`${styles.option} ${isSelected ? styles.selected : ""}`}
            onClick={() => handleProjectSelect(project)}
          >
            <span className={styles.name}>{projectDisplayName(project)}</span>
            <span className={styles.meta}>
              {t("projectSelectorSessionsCount", {
                count: project.sessionCount,
              })}
            </span>
          </button>
        );
      })}
    </div>
  );

  const mobileSheet =
    isOpen && !isDesktop
      ? createPortal(
          // biome-ignore lint/a11y/noStaticElementInteractions: backdrop click closes the sheet; Escape is handled globally
          // biome-ignore lint/a11y/useKeyWithClickEvents: Escape key handled globally
          <div
            className={styles.overlay}
            onClick={handleOverlayClick}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div
              ref={sheetRef}
              className={styles.sheet}
              role="dialog"
              tabIndex={-1}
              aria-label={t("projectSelectorSelectProject")}
            >
              <div className={styles.header}>
                <span className={styles.title}>
                  {t("projectSelectorSelectProject")}
                </span>
              </div>
              {optionsContent}
            </div>
          </div>,
          document.body,
        )
      : null;

  const desktopDropdown =
    isOpen && isDesktop ? (
      <div
        ref={sheetRef}
        className={styles.dropdown}
        role="dialog"
        tabIndex={-1}
        aria-label={t("projectSelectorSelectProject")}
      >
        {optionsContent}
      </div>
    ) : null;

  return (
    // `project-selector-container`, `project-selector-button`, and
    // `project-selector-text` stay literal: the `.source-header-identity`
    // rules in styles/index.css reach in by those names to constrain and
    // truncate the identity row, and a focused style test asserts them.
    <div className={`project-selector-container ${styles.container}`}>
      <ButtonBase
        ref={buttonRef}
        className={`project-selector-button ${styles.button}`}
        onClick={handleButtonClick}
        title={t("projectSelectorChangeProject")}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
      >
        <span className={`project-selector-text ${styles.text}`}>
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
      {desktopDropdown}
      {mobileSheet}
    </div>
  );
}
