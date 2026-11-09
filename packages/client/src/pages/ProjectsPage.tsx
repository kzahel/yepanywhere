import {
  projectDisplayName,
  PROJECT_CAPTIONS_CAPABILITY,
  PROJECT_NAMES_CAPABILITY,
  PROJECT_QUEUE_ATTACHMENT_EDITING_CAPABILITY,
  type ProjectQueueMessage,
  serverHasCapability,
  SERVER_CAPABILITIES,
} from "@yep-anywhere/shared";
import { useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { api } from "../api/client";
import { projectAccessApi } from "../api/projectAccess";
import { TemplateProjectForm } from "../components/TemplateProjectForm";
import { useProjectTemplateChoices } from "../hooks/useProjectTemplateChoices";
import {
  AddProjectForm,
  type AddProjectRequest,
} from "../components/AddProjectForm";
import formStyles from "../components/AddProjectForm.module.css";
import { PageHeader } from "../components/PageHeader";
import { ProjectCard } from "../components/ProjectCard";
import { ProjectQueueSection } from "../components/ProjectQueueSection";
import { ProjectSessionDefaultsModal } from "../components/ProjectSessionDefaultsModal";
import { Button } from "../components/ui/Button";
import { useActingPrincipal } from "../hooks/useActingPrincipal";
import { useProjectCodeNamePreferences } from "../hooks/useProjectCodeNamePreferences";
import { useProjectQueues } from "../hooks/useProjectQueues";
import { useProjects } from "../hooks/useProjects";
import { useRemoteBasePath } from "../hooks/useRemoteBasePath";
import { useVersion } from "../hooks/useVersion";
import { useI18n } from "../i18n";
import { MainContent, useNavigationLayout } from "../layouts";
import { useInboxCountsByProject } from "../lib/clientSummaryStore";
import { newProjectBaseFor } from "../lib/newProjectPath";

import type { Project } from "../types";
import styles from "./ProjectsPage.module.css";

export function ProjectsPage() {
  const { t } = useI18n();
  const { projects, loading, error, refetch } = useProjects();
  const { version } = useVersion();

  const supportsProjectQueueAttachmentEditing = serverHasCapability(
    version,
    PROJECT_QUEUE_ATTACHMENT_EDITING_CAPABILITY,
  );
  const supportsProjectSettings =
    serverHasCapability(version, SERVER_CAPABILITIES.projectService) ||
    serverHasCapability(version, SERVER_CAPABILITIES.projectAccessSharing);

  const supportsProjectCaptions = serverHasCapability(
    version,
    PROJECT_CAPTIONS_CAPABILITY,
  );
  const supportsProjectNames = serverHasCapability(
    version,
    PROJECT_NAMES_CAPABILITY,
  );
  const { projectCodeNamesEnabled } = useProjectCodeNamePreferences();
  const { principal } = useActingPrincipal();
  const personalRemoval =
    principal.username !== null &&
    serverHasCapability(
      version,
      SERVER_CAPABILITIES.personalProjectHiding.name,
    );
  const newProjectBase = newProjectBaseFor(principal);
  const inboxCountsByProject = useInboxCountsByProject();
  const [showAddForm, setShowAddForm] = useState(false);
  const {
    choices: templateChoices,
    error: templateError,
    emptyMessageKey,
  } = useProjectTemplateChoices(showAddForm);
  const [addProjectTyped, setAddProjectTyped] = useState(false);
  const [templateProjectBusy, setTemplateProjectBusy] = useState(false);
  const limitedTemplateOnly =
    !!templateChoices?.enabled && principal.username !== null;
  const [addError, setAddError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [settingsProject, setSettingsProject] = useState<Project | null>(null);
  const [deletingProjectId, setDeletingProjectId] = useState<string | null>(
    null,
  );
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const basePath = useRemoteBasePath();
  const highlightedQueueItemId = searchParams.get("queueItem");

  const { isWideScreen } = useNavigationLayout();

  const projectIds = useMemo(
    () => projects.map((project) => project.id),
    [projects],
  );
  const projectQueueProjectIds = projectIds;
  const projectQueues = useProjectQueues(projectQueueProjectIds);
  const queueStateByProject = useMemo(() => {
    const queueState = new Map<string, { count: number; hasFailed: boolean }>();
    for (const [projectId, items] of Object.entries(
      projectQueues.queuesByProject,
    )) {
      const visibleCount = items.filter(
        (item) => item.status === "queued" || item.status === "failed",
      ).length;
      if (visibleCount > 0) {
        queueState.set(projectId, {
          count: visibleCount,
          hasFailed: items.some((item) => item.status === "failed"),
        });
      }
    }
    return queueState;
  }, [projectQueues.queuesByProject]);

  // Sort projects: those needing attention first, then by recency
  const sortedProjects = useMemo(() => {
    return [...projects].sort((a, b) => {
      const aNeeds = inboxCountsByProject.get(a.id)?.needsAttention ?? 0;
      const bNeeds = inboxCountsByProject.get(b.id)?.needsAttention ?? 0;

      // Projects needing attention come first
      if (aNeeds > 0 && bNeeds === 0) return -1;
      if (bNeeds > 0 && aNeeds === 0) return 1;

      // Then sort by last activity (most recent first)
      const aTime = a.lastActivity ? new Date(a.lastActivity).getTime() : 0;
      const bTime = b.lastActivity ? new Date(b.lastActivity).getTime() : 0;
      return bTime - aTime;
    });
  }, [projects, inboxCountsByProject]);

  const handleAddProject = async ({
    path,
    name,
    codeName,
  }: AddProjectRequest) => {
    setAdding(true);
    setAddError(null);

    const finish = (project: Project) => {
      void refetch();
      setShowAddForm(false);
      // A just-added project has no sessions to list, so confirming the
      // form goes straight to starting its first session.
      navigate(
        `${basePath}/new-session?projectId=${encodeURIComponent(project.id)}`,
      );
    };

    try {
      const { project } = await api.addProject(path, { name, codeName });
      finish(project);
    } catch (err) {
      // A path that does not exist yet is offered rather than refused: YA
      // creates the directory as a Git repository with one empty commit,
      // but only after the user says so.
      if ((err as { status?: number }).status === 404) {
        if (confirm(t("projectsCreateConfirm", { path }))) {
          try {
            const { project } = await api.addProject(path, {
              create: true,
              name,
              codeName,
            });
            finish(project);
            return;
          } catch (createErr) {
            setAddError(
              createErr instanceof Error
                ? createErr.message
                : t("projectsAddFailed"),
            );
            return;
          } finally {
            setAdding(false);
          }
        }
      }
      setAddError(err instanceof Error ? err.message : t("projectsAddFailed"));
    } finally {
      setAdding(false);
    }
  };

  // A limited user copies into their own project directory, so only
  // projects not already theirs; the superuser copies a limited user's.
  const supportsProjectCopy = serverHasCapability(
    version,
    SERVER_CAPABILITIES.projectCopy.name,
  );
  const mayCopy = (project: Project) =>
    supportsProjectCopy &&
    (principal.username === null
      ? !!project.ownerUsername
      : !!principal.grants?.projectRoot &&
        project.ownerUsername !== principal.username);

  const handleCopyProject = async (project: Project) => {
    const name = prompt(t("projectCopyPrompt"), `${project.name}-copy`);
    if (!name?.trim()) return;
    setDeleteError(null);
    try {
      const { path } = await projectAccessApi.copy(project.id, name.trim());
      const { project: copy } = await api.addProject(path);
      await refetch();
      navigate(
        `${basePath}/new-session?projectId=${encodeURIComponent(copy.id)}`,
      );
    } catch (err) {
      setDeleteError(
        err instanceof Error ? err.message : t("projectCopyFailed"),
      );
    }
  };

  const handleDeleteProject = async (project: Project) => {
    if (
      !confirm(
        t(
          personalRemoval
            ? "projectsRemoveFromMyProjectsConfirm"
            : "projectsDeleteConfirm",
          { name: projectDisplayName(project) },
        ),
      )
    ) {
      return;
    }

    setDeletingProjectId(project.id);
    setDeleteError(null);

    try {
      await api.deleteProject(project.id);
      await refetch();
    } catch (err) {
      setDeleteError(
        err instanceof Error ? err.message : t("projectsDeleteFailed"),
      );
    } finally {
      setDeletingProjectId(null);
    }
  };

  const handleUpdateProjectCodeName = async (
    project: Project,
    codeName: string,
  ) => {
    await api.updateProjectCodeName(project.id, codeName);
    await refetch();
  };

  const handleUpdateProjectCaption = async (
    project: Project,
    caption: string | null,
  ) => {
    await api.updateProjectCaption(project.id, caption);
    await refetch();
  };

  const handleDeleteQueueItem = async (projectId: string, itemId: string) => {
    try {
      await projectQueues.deleteItem(projectId, itemId);
    } catch {
      // The hook exposes the error in the queue section.
    }
  };

  const handleResumeRecoveredQueueItem = async (
    sessionId: string,
    queueId: string,
  ) => {
    try {
      await projectQueues.resumeRecoveredItem(sessionId, queueId);
    } catch {
      // The hook exposes the error in the queue section.
    }
  };

  const handleDeleteRecoveredQueueItem = async (
    sessionId: string,
    queueId: string,
  ) => {
    try {
      await projectQueues.deleteRecoveredItem(sessionId, queueId);
    } catch {
      // The hook exposes the error in the queue section.
    }
  };

  const handlePauseProjectQueue = async () => {
    try {
      await projectQueues.pauseDispatch();
    } catch {
      // The hook exposes the error in the queue section.
    }
  };

  const handleResumeProjectQueue = async () => {
    try {
      await projectQueues.resumeDispatch();
    } catch {
      // The hook exposes the error in the queue section.
    }
  };

  const handlePromoteProjectQueueItem = async (
    projectId: string,
    itemId: string,
    options?: { force?: boolean },
  ) => {
    try {
      await projectQueues.promoteNow(projectId, itemId, options);
    } catch {
      // The hook exposes the error in the queue section.
    }
  };

  const handleRetryQueueItem = async (projectId: string, itemId: string) => {
    try {
      await projectQueues.retryItem(projectId, itemId);
    } catch {
      // The hook exposes the error in the queue section.
    }
  };

  const handleMoveQueueItemToTop = async (
    projectId: string,
    itemId: string,
  ) => {
    try {
      await projectQueues.moveItemToTop(projectId, itemId);
    } catch {
      // The hook exposes the error in the queue section.
    }
  };

  const handleUpdateQueueItem = async (
    projectId: string,
    itemId: string,
    message: ProjectQueueMessage,
  ) => {
    await projectQueues.updateItem(projectId, itemId, { message });
  };

  const isEmpty = projects.length === 0;

  return (
    <MainContent isWideScreen={isWideScreen}>
      <PageHeader title={t("pageTitleProjects")} />

      <main className="page-scroll-container">
        <div className="page-content-inner">
          {loading && projects.length === 0 && (
            <div role="status">{t("projectsLoading")}</div>
          )}
          {error && (
            <div className={styles.loadError} role="status">
              <span>
                {t("projectsErrorPrefix")} {error.message}
              </span>
              <Button
                variant="ghost"
                size="small"
                onClick={() => void refetch()}
              >
                {t("hostOfflineRetry")}
              </Button>
            </div>
          )}
          {/* Toolbar with Add Project button */}
          <div className="inbox-toolbar">
            {!showAddForm ? (
              <Button onClick={() => setShowAddForm(true)}>
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
              </Button>
            ) : (
              <div
                className={
                  templateChoices?.enabled ? formStyles.form : undefined
                }
              >
                {/* The superuser enters a path or name first; the template
                    chooser below it leaves once anything is typed there.
                    Limited users can only create from a template. */}
                {!limitedTemplateOnly && (
                  <AddProjectForm
                    projects={projects}
                    pathBase={newProjectBase}
                    chooseName={supportsProjectNames}
                    chooseCodeName={
                      supportsProjectNames && projectCodeNamesEnabled
                    }
                    adding={adding || templateProjectBusy}
                    error={addError}
                    onSubmit={(request) => void handleAddProject(request)}
                    onCancel={() => {
                      setShowAddForm(false);
                      setAddError(null);
                    }}
                    onTypedChange={setAddProjectTyped}
                  />
                )}
                {templateError && !addProjectTyped && (
                  <p role="alert">{templateError}</p>
                )}
                {templateChoices?.enabled && (
                  <div hidden={addProjectTyped && !templateProjectBusy}>
                    {!limitedTemplateOnly && (
                      <p className={formStyles.label}>{t("templateOrStart")}</p>
                    )}
                    <TemplateProjectForm
                      templates={templateChoices.templates}
                      emptyMessage={templateError ?? t(emptyMessageKey)}
                      projects={projects}
                      pathBase={newProjectBase}
                      onBusyChange={setTemplateProjectBusy}
                      onStarted={(projectId, sessionId) => {
                        void refetch();
                        navigate(
                          `${basePath}/projects/${projectId}/sessions/${sessionId}`,
                        );
                      }}
                    />
                  </div>
                )}
                {limitedTemplateOnly && (
                  <div className={formStyles.actions}>
                    <Button
                      disabled={templateProjectBusy}
                      onClick={() => setShowAddForm(false)}
                    >
                      {t("projectsCancel")}
                    </Button>
                  </div>
                )}
              </div>
            )}
          </div>
          {deleteError && <div className={formStyles.error}>{deleteError}</div>}

          {
            <ProjectQueueSection
              projects={projects}
              items={projectQueues.items}
              recoveredSessionQueues={projectQueues.recoveredSessionQueues}
              loading={projectQueues.loading}
              error={projectQueues.error}
              mutatingItemId={projectQueues.mutatingItemId}
              mutatingRecoveredQueueId={projectQueues.mutatingRecoveredQueueId}
              mutatingDispatchState={projectQueues.mutatingDispatchState}
              mutatingPromoteItemId={projectQueues.mutatingPromoteItemId}
              dispatchState={projectQueues.dispatchState}
              projectStatusesByProject={projectQueues.projectStatusesByProject}
              highlightedItemId={highlightedQueueItemId}
              basePath={basePath}
              attachmentEditingEnabled={supportsProjectQueueAttachmentEditing}
              onPauseDispatch={handlePauseProjectQueue}
              onResumeDispatch={handleResumeProjectQueue}
              onPromoteNow={handlePromoteProjectQueueItem}
              onDeleteItem={handleDeleteQueueItem}
              onResumeRecoveredItem={handleResumeRecoveredQueueItem}
              onDeleteRecoveredItem={handleDeleteRecoveredQueueItem}
              onRetryItem={handleRetryQueueItem}
              onMoveItemToTop={handleMoveQueueItemToTop}
              onUpdateItem={handleUpdateQueueItem}
            />
          }

          {isEmpty ? (
            !loading &&
            !error && (
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
            )
          ) : (
            <ul className="project-list-cards">
              {sortedProjects.map((project) => (
                <ProjectCard
                  appEnabled={serverHasCapability(
                    version,
                    SERVER_CAPABILITIES.projectService.name,
                  )}
                  key={project.id}
                  project={project}
                  needsAttentionCount={
                    inboxCountsByProject.get(project.id)?.needsAttention ?? 0
                  }
                  thinkingCount={
                    inboxCountsByProject.get(project.id)?.active ?? 0
                  }
                  queueCount={queueStateByProject.get(project.id)?.count ?? 0}
                  hasQueueWarning={
                    queueStateByProject.get(project.id)?.hasFailed ?? false
                  }
                  basePath={basePath}
                  onDeleteProject={handleDeleteProject}
                  deleteLabel={
                    personalRemoval
                      ? t("projectsRemoveFromMyProjects")
                      : undefined
                  }
                  onOpenSettings={
                    supportsProjectSettings ? setSettingsProject : undefined
                  }
                  onCopy={
                    mayCopy(project)
                      ? (copied) => void handleCopyProject(copied)
                      : undefined
                  }
                  onUpdateCodeName={
                    projectCodeNamesEnabled
                      ? handleUpdateProjectCodeName
                      : undefined
                  }
                  onUpdateCaption={
                    supportsProjectCaptions
                      ? handleUpdateProjectCaption
                      : undefined
                  }
                  isDeleting={deletingProjectId === project.id}
                />
              ))}
            </ul>
          )}
        </div>
      </main>
      {settingsProject && (
        <ProjectSessionDefaultsModal
          projectId={settingsProject.id}
          projectName={settingsProject.name}
          ownerUsername={settingsProject.ownerUsername}
          onClose={() => setSettingsProject(null)}
        />
      )}
    </MainContent>
  );
}
