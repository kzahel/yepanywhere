import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api/client";
import { PageHeader } from "../components/PageHeader";
import { ProjectCard } from "../components/ProjectCard";
import { useInboxContext } from "../contexts/InboxContext";
import { useProjects } from "../hooks/useProjects";
import { useNavigationLayout } from "../layouts";

export function ProjectsPage() {
  const { projects, loading, error, refetch } = useProjects();
  const { needsAttention, active } = useInboxContext();
  const [showAddForm, setShowAddForm] = useState(false);
  const [newProjectPath, setNewProjectPath] = useState("");
  const [addError, setAddError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const navigate = useNavigate();

  const { openSidebar, isWideScreen, toggleSidebar, isSidebarCollapsed } =
    useNavigationLayout();

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

    try {
      const { project } = await api.addProject(newProjectPath.trim());
      await refetch();
      setNewProjectPath("");
      setShowAddForm(false);
      // Navigate to sessions filtered by the new project
      navigate(`/sessions?project=${project.id}`);
    } catch (err) {
      setAddError(err instanceof Error ? err.message : "Failed to add project");
    } finally {
      setAdding(false);
    }
  };

  if (loading) return <div className="loading">Loading projects...</div>;
  if (error) return <div className="error">Error: {error.message}</div>;

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
          title="Projects"
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
                  Add Project
                </button>
              ) : (
                <form onSubmit={handleAddProject} className="add-project-form">
                  <input
                    type="text"
                    value={newProjectPath}
                    onChange={(e) => setNewProjectPath(e.target.value)}
                    placeholder="Enter project path (e.g., ~/code/my-project)"
                    disabled={adding}
                  />
                  <div className="add-project-actions">
                    <button
                      type="submit"
                      disabled={adding || !newProjectPath.trim()}
                    >
                      {adding ? "Adding..." : "Add"}
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
                      Cancel
                    </button>
                  </div>
                  {addError && (
                    <div className="add-project-error">{addError}</div>
                  )}
                </form>
              )}
            </div>

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
                <h3>No projects yet</h3>
                <p>
                  Add a project above, or launch Claude in a folder and it will
                  automatically appear here.
                </p>
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
