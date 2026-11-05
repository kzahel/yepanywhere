import { projectDisplayName } from "@yep-anywhere/shared";
import { useId, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useI18n } from "../i18n";
import { shortenPath } from "../lib/text";
import type { Project } from "../types";
import styles from "./ProjectCard.module.css";
import { ProjectCaptionEditor } from "./ProjectCaptionEditor";
import { ProjectCodeNameEditor } from "./ProjectCodeNameEditor";
import { ThinkingIndicator } from "./ThinkingIndicator";

interface ProjectCardProps {
  appEnabled?: boolean;
  project: Project;
  /** Number of sessions needing approval/input in this project */
  needsAttentionCount: number;
  /** Number of sessions actively thinking (running, no pending input) */
  thinkingCount: number;
  /** Number of queued/failed Project Queue items in this project */
  queueCount?: number;
  /** Whether a Project Queue item is paused for explicit retry */
  hasQueueWarning?: boolean;
  /** Base path prefix for relay mode (e.g., "/remote/my-server") */
  basePath?: string;
  /** Called when the user asks to remove the project from YA lists */
  onDeleteProject?: (project: Project) => void;
  deleteLabel?: string;
  /** Called when the user opens this project's defaults */
  onOpenSettings?: (project: Project) => void;
  /** Present when this user may make their own copy of the project. */
  onCopy?: (project: Project) => void;
  /** Persists an inline edit to this project's short code name. */
  onUpdateCodeName?: (project: Project, codeName: string) => Promise<void>;
  /** Persists an inline caption override; `null` restores the derived caption. */
  onUpdateCaption?: (project: Project, caption: string | null) => Promise<void>;
  /** Whether this project is currently being removed */
  isDeleting?: boolean;
}

/**
 * Format relative time for display
 */
function formatRelativeTime(timestamp: string): string {
  const now = Date.now();
  const then = new Date(timestamp).getTime();
  const diffMs = now - then;
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return "just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return new Date(timestamp).toLocaleDateString();
}

/**
 * Card component for displaying a project in the projects list.
 * Matches visual style of SessionListItem card mode.
 */
export function ProjectCard({
  appEnabled = false,
  project,
  needsAttentionCount,
  thinkingCount,
  queueCount = 0,
  hasQueueWarning = false,
  basePath = "",
  onDeleteProject,
  deleteLabel,
  onOpenSettings,
  onCopy,
  onUpdateCodeName,
  onUpdateCaption,
  isDeleting = false,
}: ProjectCardProps) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const [codeNameError, setCodeNameError] = useState<string | null>(null);
  const codeNameErrorId = useId();

  const handleNewSession = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    navigate(`${basePath}/new-session?projectId=${project.id}`);
  };

  const handleDeleteProject = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    onDeleteProject?.(project);
  };

  const handleOpenSettings = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    onOpenSettings?.(project);
  };

  return (
    <li className={`${styles.card} ${appEnabled ? styles.withApp : ""}`}>
      {appEnabled && (
        <Link
          to={`${basePath}/projects/${project.id}/app`}
          className={`${styles.newSession} ${styles.appLink}`}
          aria-label={t("projectAppOpen")}
          title={t("projectAppOpen")}
        >
          {t("projectAppLabel")}
        </Link>
      )}
      <Link
        to={`${basePath}/sessions?project=${project.id}&source=projects`}
        className={styles.link}
        data-project-card-link=""
      >
        <div className={styles.header}>
          {onCopy && (
            <button
              type="button"
              className={styles.newSession}
              aria-label={t("projectCopyTitle")}
              title={t("projectCopyTitle")}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onCopy(project);
              }}
            >
              {t("projectCopyLabel")}
            </button>
          )}
          {onOpenSettings && (
            <button
              type="button"
              className={styles.settingsTrigger}
              onClick={handleOpenSettings}
              title={t("projectCardOpenSettings")}
              aria-label={t("projectCardOpenSettings")}
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
              </svg>
            </button>
          )}
          {onDeleteProject && (
            <button
              type="button"
              className={styles.deleteTrigger}
              onClick={handleDeleteProject}
              disabled={isDeleting}
              title={deleteLabel ?? t("projectsDelete")}
              aria-label={deleteLabel ?? t("projectsDelete")}
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M3 6h18" />
                <path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2" />
                <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                <path d="M10 11v6" />
                <path d="M14 11v6" />
              </svg>
            </button>
          )}
          <div className={styles.identity}>
            <strong className={styles.name}>
              {needsAttentionCount > 0 && (
                <span className={styles.attentionBadge}>
                  {needsAttentionCount}
                </span>
              )}
              {queueCount > 0 && (
                <span
                  className={styles.queueBadge}
                  title={t("projectCardQueueCount", { count: queueCount })}
                >
                  {queueCount}
                </span>
              )}
              {hasQueueWarning && (
                <span
                  className={styles.queueWarningBadge}
                  role="img"
                  title={t("projectCardQueueWarning")}
                  aria-label={t("projectCardQueueWarning")}
                >
                  !
                </span>
              )}
              <span className={styles.nameText}>
                {projectDisplayName(project)}
              </span>
              {onUpdateCodeName && (
                <ProjectCodeNameEditor
                  project={project}
                  onUpdateCodeName={onUpdateCodeName}
                  error={codeNameError}
                  onErrorChange={setCodeNameError}
                  errorId={codeNameErrorId}
                />
              )}
            </strong>
            {onUpdateCodeName && codeNameError && (
              <span
                id={codeNameErrorId}
                className={styles.codeNameError}
                role="alert"
              >
                {codeNameError}
              </span>
            )}
            <ProjectCaptionEditor
              project={project}
              onUpdateCaption={onUpdateCaption}
            />
          </div>
          <button
            type="button"
            className={styles.newSession}
            onClick={handleNewSession}
            title={t("projectCardNewSession")}
            aria-label={t("projectCardNewSession")}
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
          </button>
        </div>
        <div className={styles.meta}>
          <span className={styles.path} title={project.path}>
            <bdi>{shortenPath(project.path)}</bdi>
          </span>
          <span className={styles.stats}>
            <span className={styles.sessions}>
              {project.sessionCount} session
              {project.sessionCount !== 1 ? "s" : ""}
            </span>
            {thinkingCount > 0 && (
              <span className={styles.thinking}>
                <ThinkingIndicator />
                <span>{thinkingCount}</span>
              </span>
            )}
            {project.lastActivity && (
              <>
                <span className={styles.separator}>·</span>
                <span className={styles.time}>
                  {formatRelativeTime(project.lastActivity)}
                </span>
              </>
            )}
          </span>
        </div>
      </Link>
    </li>
  );
}
