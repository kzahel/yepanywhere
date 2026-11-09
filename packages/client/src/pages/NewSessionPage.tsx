import type {
  PermissionMode,
  ProviderName,
  ThinkingOption,
} from "@yep-anywhere/shared";
import {
  ALL_PERMISSION_MODES,
  SERVER_CAPABILITIES,
  serverHasCapability,
} from "@yep-anywhere/shared";
import { lazy, Suspense, useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { NewSessionForm } from "../components/NewSessionForm";
import { PageHeader } from "../components/PageHeader";
import { Button } from "../components/ui/Button";
import { useDocumentTitle } from "../hooks/useDocumentTitle";
import { useVersion } from "../hooks/useVersion";
import { useIncomingShareFiles } from "../hooks/useIncomingShareFiles";
import { useProject, useProjects } from "../hooks/useProjects";
import {
  getRecentProjectId,
  resolvePreferredProjectId,
  setRecentProjectId,
} from "../hooks/useRecentProject";
import { useRecentSessions } from "../hooks/useRecentSessions";
import { useNewSessionProjectSnapshot } from "../hooks/useNewSessionProjectSnapshot";
import { useI18n } from "../i18n";
import { MainContent, useNavigationLayout } from "../layouts";
import { useToastContext } from "../contexts/ToastContext";
import { useProjectAppComposing } from "../hooks/useProjectAppComposing";
import type { ProjectAppTarget } from "../api/projectApp";
import type { VoiceInputButtonRef } from "../components/VoiceInputButton";
import styles from "./NewSessionPage.module.css";

const ProjectAppViewer = lazy(() =>
  import("../components/ProjectAppViewer").then((module) => ({
    default: module.ProjectAppViewer,
  })),
);

const RECENT_PROJECT_SESSION_LIMIT = 30;
const DETACHED_PROJECT_PARAM = "detached";

function parsePreferredThinking(
  value: string | null,
): ThinkingOption | undefined {
  if (!value) return undefined;
  if (value === "off" || value === "auto" || value.startsWith("on:")) {
    return value as ThinkingOption;
  }
  return undefined;
}

function parsePreferredPermissionMode(
  value: string | null,
): PermissionMode | undefined {
  if (!value) return undefined;
  return ALL_PERMISSION_MODES.includes(value as PermissionMode)
    ? (value as PermissionMode)
    : undefined;
}

export function NewSessionPage() {
  const { t } = useI18n();
  const { showToast } = useToastContext();
  const [incomingShareFiles, setIncomingShareFiles] = useState<readonly File[]>(
    [],
  );
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedProjectId = searchParams.get("projectId") ?? undefined;
  const preferredProvider = searchParams.get("provider") ?? undefined;
  const preferredModel = searchParams.get("model") ?? undefined;
  const preferredThinking = parsePreferredThinking(
    searchParams.get("thinking"),
  );
  const preferredPermissionMode = parsePreferredPermissionMode(
    searchParams.get("permissionMode"),
  );
  const preferredExecutor = searchParams.get("executor") ?? undefined;
  const requestedDetached =
    !requestedProjectId && searchParams.get(DETACHED_PROJECT_PARAM) === "1";
  const { isWideScreen } = useNavigationLayout();
  const { projectAppComposingEnabled } = useProjectAppComposing();
  const [appWorkspace, setAppWorkspace] = useState<{
    projectId: string;
    open: boolean;
  } | null>(null);
  const [appTarget, setAppTarget] = useState<ProjectAppTarget>();
  const [voice, setVoice] = useState<VoiceInputButtonRef | null>(null);

  useIncomingShareFiles(setIncomingShareFiles, {
    onError: () => showToast(t("incomingShareAttachmentUnavailable"), "error"),
  });

  const {
    projects: liveProjects,
    loading: projectsLoading,
    complete: projectsComplete,
    error: projectsError,
  } = useProjects({
    bootstrapTier: "route",
  });
  const projectCollectionConfirmed = projectsComplete && !projectsError;
  const { version } = useVersion();

  const {
    recentProjectIds: liveRecentProjectIds,
    isLoadingVisits: recentSessionsLoading,
  } = useRecentSessions({
    limit: RECENT_PROJECT_SESSION_LIMIT,
  });
  const { projects, cachedProjects, recentProjectIds, unconfirmedProjectIds } =
    useNewSessionProjectSnapshot({
      projects: liveProjects,
      complete: projectCollectionConfirmed,
      recentProjectIds: liveRecentProjectIds,
      visitsLoading: recentSessionsLoading,
      projectId: requestedProjectId,
    });
  // The initial selection is already determined by these facts. Rendering it
  // must not wait for the router to commit the URL normalization below.
  let projectId = requestedProjectId;
  if (!projectId && !requestedDetached && projects.length > 0) {
    const storedRecentProjectId = getRecentProjectId();
    const hasValidStoredRecentProject = projects.some(
      (candidate) => candidate.id === storedRecentProjectId,
    );
    if (
      !recentSessionsLoading ||
      hasValidStoredRecentProject ||
      recentProjectIds.length > 0
    ) {
      projectId =
        resolvePreferredProjectId(
          projects,
          recentProjectIds[0],
          projectCollectionConfirmed,
        ) ?? undefined;
    }
  }
  const collectionProject = liveProjects.find(
    (candidate) => candidate.id === projectId,
  );
  // A missing row is meaningful only after discovery finishes. Detail reads
  // then support existing directories that have never hosted a session.
  const needsProjectDetail =
    !collectionProject && (projectCollectionConfirmed || !!projectsError);
  const {
    project,
    loading: detailLoading,
    error,
  } = useProject(needsProjectDetail ? projectId : undefined);
  const confirmedSelectedProject = collectionProject ?? project;
  const projectLoading =
    Boolean(projectId) &&
    !confirmedSelectedProject &&
    (!needsProjectDetail || detailLoading);
  const selectedProject =
    confirmedSelectedProject ??
    (projectId
      ? projects.find((candidate) => candidate.id === projectId)
      : null) ??
    (projectLoading
      ? cachedProjects.find((candidate) => candidate.id === projectId)
      : null);

  const appEnabled =
    projectAppComposingEnabled &&
    serverHasCapability(version, SERVER_CAPABILITIES.projectService.name);
  const appMounted =
    appEnabled && !!appWorkspace && appWorkspace.projectId === projectId;
  const appOpen = appMounted && appWorkspace.open;
  const closeApp = () =>
    setAppWorkspace((workspace) => workspace && { ...workspace, open: false });
  const projectAppButton =
    appEnabled && projectId ? (
      <Button
        variant="ghost"
        title={t("projectAppWhileComposing")}
        aria-pressed={appOpen}
        onClick={() => {
          if (appWorkspace?.projectId !== projectId) setAppTarget(undefined);
          setAppWorkspace({ projectId, open: !appOpen });
        }}
      >
        {t("projectAppLabel")}
      </Button>
    ) : undefined;

  // Update browser tab title (must be called unconditionally before any early returns)
  useDocumentTitle(
    selectedProject?.name,
    selectedProject?.codeName,
    t("newSessionTitle"),
  );

  useEffect(() => {
    if (!projectId || !confirmedSelectedProject) return;
    setRecentProjectId(projectId);
  }, [projectId, confirmedSelectedProject]);

  useEffect(() => {
    if (requestedProjectId || requestedDetached || !projectId) {
      return;
    }

    const nextParams = new URLSearchParams(searchParams);
    nextParams.set("projectId", projectId);
    nextParams.delete(DETACHED_PROJECT_PARAM);
    setSearchParams(nextParams, { replace: true });
  }, [
    projectId,
    requestedProjectId,
    requestedDetached,
    searchParams,
    setSearchParams,
  ]);

  // Callback to update projectId in URL without navigation
  const handleProjectChange = (newProjectId: string | null) => {
    const nextParams = new URLSearchParams(searchParams);
    if (newProjectId) {
      nextParams.set("projectId", newProjectId);
      nextParams.delete(DETACHED_PROJECT_PARAM);
      setRecentProjectId(newProjectId);
    } else {
      nextParams.delete("projectId");
      nextParams.set(DETACHED_PROJECT_PARAM, "1");
    }
    setSearchParams(nextParams, { replace: true });
  };

  // The composer does not wait for the selected project's record: a tab opened
  // here is for typing, and the form holds the start until the project arrives.
  const renderError = preferredExecutor?.trim()
    ? new Error(t("sshExecutorsRemoved"))
    : !confirmedSelectedProject && !projectLoading
      ? error
      : null;

  if (renderError) {
    return (
      <MainContent isWideScreen={isWideScreen}>
        <PageHeader title={t("newSessionTitle")} />
        <main className="page-scroll-container">
          <div className="page-content-inner">
            <div className="error">
              {t("newSessionErrorPrefix")} {renderError.message}
            </div>
          </div>
        </main>
      </MainContent>
    );
  }

  return (
    <MainContent isWideScreen={isWideScreen}>
      <PageHeader title={t("newSessionTitle")} actions={projectAppButton} />

      <main className={`page-scroll-container ${styles.workspace}`}>
        <div
          className={`page-content-inner new-session-page-shell ${styles.formColumn}`}
          hidden={appOpen && !isWideScreen}
        >
          <NewSessionForm
            fixedProject={appOpen}
            projectApp={appOpen ? appTarget : undefined}
            onVoiceControl={setVoice}
            incomingShareFiles={incomingShareFiles}
            prefillToken={searchParams.get("prefillToken")}
            projectId={projectId}
            selectedProject={selectedProject}
            projects={projects}
            recentProjectIds={recentProjectIds}
            projectsLoading={projectsLoading && projects.length === 0}
            unconfirmedProjectIds={unconfirmedProjectIds.filter(
              (id) => id !== confirmedSelectedProject?.id,
            )}
            onProjectChange={handleProjectChange}
            preferredProvider={preferredProvider as ProviderName | undefined}
            preferredModel={preferredModel}
            preferredThinking={preferredThinking}
            preferredPermissionMode={preferredPermissionMode}
          />
        </div>
        {appMounted && projectId && (
          <div className={styles.appColumn} hidden={!appOpen}>
            <Suspense fallback={null}>
              <ProjectAppViewer
                key={projectId}
                projectId={projectId}
                projectName={confirmedSelectedProject?.name}
                onTarget={setAppTarget}
                voice={voice}
                onBack={closeApp}
                onSession={closeApp}
                onVoice={closeApp}
              />
            </Suspense>
          </div>
        )}
      </main>
    </MainContent>
  );
}
