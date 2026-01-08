import { useSearchParams } from "react-router-dom";
import { NewSessionForm } from "../components/NewSessionForm";
import { PageHeader } from "../components/PageHeader";
import { ProjectSelector } from "../components/ProjectSelector";
import { useDocumentTitle } from "../hooks/useDocumentTitle";
import { useProject, useProjects } from "../hooks/useProjects";
import { useNavigationLayout } from "../layouts";

export function NewSessionPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const projectId = searchParams.get("projectId");
  const { openSidebar, isWideScreen, toggleSidebar, isSidebarCollapsed } =
    useNavigationLayout();

  // Get all projects to find default if no projectId specified
  const { projects } = useProjects();

  // Use the provided projectId, or default to first project
  const effectiveProjectId = projectId || projects[0]?.id;

  const { project, loading, error } = useProject(effectiveProjectId);

  // Callback to update projectId in URL without navigation
  const handleProjectChange = (newProjectId: string) => {
    setSearchParams({ projectId: newProjectId }, { replace: true });
  };

  // Guard against missing projectId (no projects available)
  if (!effectiveProjectId && !loading && projects.length === 0) {
    return <div className="error">No projects available</div>;
  }

  // Update browser tab title
  useDocumentTitle(project?.name, "New Session");

  // Render loading/error states
  if (loading || error) {
    return (
      <div
        className={
          isWideScreen ? "main-content-wrapper" : "main-content-mobile"
        }
      >
        <div
          className={
            isWideScreen
              ? "main-content-constrained"
              : "main-content-mobile-inner"
          }
        >
          <PageHeader
            title="New Session"
            onOpenSidebar={openSidebar}
            onToggleSidebar={toggleSidebar}
            isWideScreen={isWideScreen}
            isSidebarCollapsed={isSidebarCollapsed}
          />
          <main className="page-scroll-container">
            <div className="page-content-inner">
              {loading ? (
                <div className="loading">Loading...</div>
              ) : (
                <div className="error">Error: {error?.message}</div>
              )}
            </div>
          </main>
        </div>
      </div>
    );
  }

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
          title={project?.name ?? "New Session"}
          titleElement={
            effectiveProjectId ? (
              <ProjectSelector
                currentProjectId={effectiveProjectId}
                currentProjectName={project?.name}
                onProjectChange={(p) => handleProjectChange(p.id)}
              />
            ) : undefined
          }
          onOpenSidebar={openSidebar}
          onToggleSidebar={toggleSidebar}
          isWideScreen={isWideScreen}
          isSidebarCollapsed={isSidebarCollapsed}
        />

        <main className="page-scroll-container">
          <div className="page-content-inner">
            {effectiveProjectId && (
              <NewSessionForm projectId={effectiveProjectId} />
            )}
          </div>
        </main>
      </div>
    </div>
  );
}
