import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api/client";
import { PageHeader } from "../components/PageHeader";
import { ProjectCard } from "../components/ProjectCard";
import { useInboxContext } from "../contexts/InboxContext";
import { useProjects } from "../hooks/useProjects";
import { useRemoteBasePath } from "../hooks/useRemoteBasePath";
import { useI18n } from "../i18n";
import { useNavigationLayout } from "../layouts";
import { emitProjectsChanged } from "../lib/projectEvents";
import type { HiddenProject, Project } from "../types";

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

export function ProjectsPage() {
  const { t } = useI18n();
  const { projects, loading, error, refetch } = useProjects();
  const { needsAttention, active } = useInboxContext();
  const [showAddForm, setShowAddForm] = useState(false);
  const [newProjectPath, setNewProjectPath] = useState("");
  const [addError, setAddError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [removingProjectId, setRemovingProjectId] = useState<string | null>(
    null,
  );
  const [hiddenProjects, setHiddenProjects] = useState<HiddenProject[]>([]);
  const [loadingHiddenProjects, setLoadingHiddenProjects] = useState(true);
  const [showHiddenProjects, setShowHiddenProjects] = useState(false);
  const [restoringProjectId, setRestoringProjectId] = useState<string | null>(
    null,
  );
  const [removeError, setRemoveError] = useState<string | null>(null);
  const navigate = useNavigate();
  const basePath = useRemoteBasePath();

  const { openSidebar, isWideScreen, toggleSidebar, isSidebarCollapsed } =
    useNavigationLayout();

  const loadHiddenProjects = useCallback(async () => {
    setLoadingHiddenProjects(true);
    try {
      const data = await api.getHiddenProjects();
      setHiddenProjects(data.projects);
    } catch (err) {
      setRemoveError(
        err instanceof Error ? err.message : t("projectsHiddenLoadFailed"),
      );
    } finally {
      setLoadingHiddenProjects(false);
    }
  }, [t]);

  useEffect(() => {
    void loadHiddenProjects();
  }, [loadHiddenProjects]);

  // Count needs-attention items per project (client-side filter - free)
  const attentionByProject = useMemo(() => {
    const counts = new Map<string, number>();
    for (const item of needsAttention) {
      const current = counts.get(item.projectId) ?? 0;
      counts.set(item.projectId, current + 1);
    }
    return counts;
  }, [needsAttention]);

  // Count actively-thinking sessions per project (from inbox "active" tier)
  const thinkingByProject = useMemo(() => {
    const counts = new Map<string, number>();
    for (const item of active) {
      const current = counts.get(item.projectId) ?? 0;
      counts.set(item.projectId, current + 1);
    }
    return counts;
  }, [active]);

  // Sort projects: those needing attention first, then by recency
  const sortedProjects = useMemo(() => {
    return [...projects].sort((a, b) => {
      const aNeeds = attentionByProject.get(a.id) ?? 0;
      const bNeeds = attentionByProject.get(b.id) ?? 0;

      // Projects needing attention come first
      if (aNeeds > 0 && bNeeds === 0) return -1;
      if (bNeeds > 0 && aNeeds === 0) return 1;

      // Then sort by last activity (most recent first)
      const aTime = a.lastActivity ? new Date(a.lastActivity).getTime() : 0;
      const bTime = b.lastActivity ? new Date(b.lastActivity).getTime() : 0;
      return bTime - aTime;
    });
  }, [projects, attentionByProject]);

  const handleAddProject = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newProjectPath.trim()) return;

    setAdding(true);
    setAddError(null);
    setRemoveError(null);

    try {
      const { project } = await api.addProject(newProjectPath.trim());
      await refetch();
      await loadHiddenProjects();
      emitProjectsChanged();
      setNewProjectPath("");
      setShowAddForm(false);
      // Navigate to sessions filtered by the new project
      navigate(`${basePath}/sessions?project=${project.id}`);
    } catch (err) {
      setAddError(err instanceof Error ? err.message : t("projectsAddFailed"));
    } finally {
      setAdding(false);
    }
  };

  const handleRemoveProject = async (project: Project) => {
    const confirmed = confirm(
      t("projectsRemoveConfirm", { name: project.name }),
    );
    if (!confirmed) return;

    setRemovingProjectId(project.id);
    setRemoveError(null);

    try {
      await api.deleteProject(project.id);
      await refetch();
      await loadHiddenProjects();
      emitProjectsChanged();
      setShowHiddenProjects(true);
    } catch (err) {
      setRemoveError(
        err instanceof Error ? err.message : t("projectsRemoveFailed"),
      );
    } finally {
      setRemovingProjectId((current) =>
        current === project.id ? null : current,
      );
    }
  };

  const handleRestoreProject = async (project: HiddenProject) => {
    setRestoringProjectId(project.id);
    setRemoveError(null);

    try {
      const { project: restoredProject } = await api.restoreProject(project.id);
      await refetch();
      await loadHiddenProjects();
      emitProjectsChanged();
      navigate(`${basePath}/sessions?project=${restoredProject.id}`);
    } catch (err) {
      setRemoveError(
        err instanceof Error ? err.message : t("projectsRestoreFailed"),
      );
    } finally {
      setRestoringProjectId((current) =>
        current === project.id ? null : current,
      );
    }
  };

  if (loading) return <div className="loading">{t("projectsLoading")}</div>;
  if (error) {
    return (
      <div className="error">
        {t("projectsErrorPrefix")} {error.message}
      </div>
    );
  }

  const isEmpty = projects.length === 0;

  return (
    <div
      className={isWideScreen ? "main-content-wrapper" : "main-content-mobile"}
    >
      <div
        className={
          isWideScreen
            ? "main-content-constrained"
            : "main-content-mobile-inner"
        }
      >
        <PageHeader
          title={t("pageTitleProjects")}
          onOpenSidebar={openSidebar}
          onToggleSidebar={toggleSidebar}
          isWideScreen={isWideScreen}
          isSidebarCollapsed={isSidebarCollapsed}
        />

        <main className="page-scroll-container">
          <div className="page-content-inner">
            {/* Toolbar with Add Project button */}
            <div className="inbox-toolbar">
              {!showAddForm ? (
                <button
                  type="button"
                  className="inbox-refresh-button"
                  onClick={() => setShowAddForm(true)}
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
                  {t("projectsAdd")}
                </button>
              ) : (
                <form onSubmit={handleAddProject} className="add-project-form">
                  <input
                    type="text"
                    value={newProjectPath}
                    onChange={(e) => setNewProjectPath(e.target.value)}
                    placeholder={t("projectsAddPlaceholder")}
                    disabled={adding}
                  />
                  <div className="add-project-actions">
                    <button
                      type="submit"
                      disabled={adding || !newProjectPath.trim()}
                    >
                      {adding ? t("projectsAdding") : t("projectsAddConfirm")}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setShowAddForm(false);
                        setNewProjectPath("");
                        setAddError(null);
                      }}
                      disabled={adding}
                    >
                      {t("projectsCancel")}
                    </button>
                  </div>
                  {addError && (
                    <div className="add-project-error">{addError}</div>
                  )}
                </form>
              )}
            </div>
            {removeError && (
              <div className="add-project-error">{removeError}</div>
            )}
            <section className="hidden-projects-panel">
              <button
                type="button"
                className="hidden-projects-toggle"
                onClick={() => setShowHiddenProjects((current) => !current)}
                aria-expanded={showHiddenProjects}
              >
                <span>
                  {t("projectsHiddenSectionTitle", {
                    count: hiddenProjects.length,
                  })}
                </span>
                <span className="hidden-projects-toggle__icon">
                  {showHiddenProjects ? "−" : "+"}
                </span>
              </button>
              {showHiddenProjects && (
                <div className="hidden-projects-body">
                  <p className="hidden-projects-description">
                    {t("projectsHiddenSectionDescription")}
                  </p>
                  {loadingHiddenProjects ? (
                    <div className="hidden-projects-loading">
                      {t("projectsHiddenLoading")}
                    </div>
                  ) : hiddenProjects.length === 0 ? (
                    <div className="hidden-projects-loading">
                      {t("projectsHiddenEmpty")}
                    </div>
                  ) : (
                    <ul className="hidden-projects-list">
                      {hiddenProjects.map((project) => (
                        <li key={project.id} className="hidden-projects-item">
                          <div className="hidden-projects-item__content">
                            <strong>{project.name}</strong>
                            <span title={project.path}>{project.path}</span>
                            <span>
                              {t("projectsHiddenAt", {
                                time: formatRelativeTime(project.hiddenAt),
                              })}
                            </span>
                          </div>
                          <button
                            type="button"
                            className="hidden-projects-item__restore"
                            onClick={() => handleRestoreProject(project)}
                            disabled={restoringProjectId === project.id}
                          >
                            {restoringProjectId === project.id
                              ? t("projectsRestoring")
                              : t("projectsRestore")}
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </section>

            {isEmpty ? (
              <div className="inbox-empty">
                <svg
                  width="48"
                  height="48"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                </svg>
                <h3>{t("projectsEmptyTitle")}</h3>
                <p>{t("projectsEmptyDescription")}</p>
              </div>
            ) : (
              <ul className="project-list-cards">
                {sortedProjects.map((project) => (
                  <ProjectCard
                    key={project.id}
                    project={project}
                    needsAttentionCount={
                      attentionByProject.get(project.id) ?? 0
                    }
                    thinkingCount={thinkingByProject.get(project.id) ?? 0}
                    basePath={basePath}
                    onRemove={handleRemoveProject}
                    removing={removingProjectId === project.id}
                  />
                ))}
              </ul>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}
