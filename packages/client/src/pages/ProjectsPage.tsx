import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../api/client";
import { NavigationSidebar } from "../components/NavigationSidebar";
import { PageHeader } from "../components/PageHeader";
import { ActiveCountBadge } from "../components/StatusBadge";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { useProjects } from "../hooks/useProjects";
import { useSidebarPreference } from "../hooks/useSidebarPreference";

export function ProjectsPage() {
  const { projects, loading, error, refetch } = useProjects();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [showAddForm, setShowAddForm] = useState(false);
  const [newProjectPath, setNewProjectPath] = useState("");
  const [addError, setAddError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const navigate = useNavigate();

  // Desktop layout hooks
  const isWideScreen = useMediaQuery("(min-width: 1100px)");
  const { isExpanded, toggleExpanded } = useSidebarPreference();

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
      // Navigate to the new project
      navigate(`/projects/${project.id}`);
    } catch (err) {
      setAddError(err instanceof Error ? err.message : "Failed to add project");
    } finally {
      setAdding(false);
    }
  };

  if (loading) return <div className="loading">Loading projects...</div>;
  if (error) return <div className="error">Error: {error.message}</div>;

  return (
    <div className={`session-page ${isWideScreen ? "desktop-layout" : ""}`}>
      {/* Desktop sidebar - always visible on wide screens */}
      {isWideScreen && (
        <aside
          className={`sidebar-desktop ${!isExpanded ? "sidebar-collapsed" : ""}`}
        >
          <NavigationSidebar
            isOpen={true}
            onClose={() => {}}
            isDesktop={true}
            isCollapsed={!isExpanded}
            onToggleExpanded={toggleExpanded}
          />
        </aside>
      )}

      {/* Mobile sidebar - modal overlay */}
      {!isWideScreen && (
        <NavigationSidebar
          isOpen={sidebarOpen}
          onClose={() => setSidebarOpen(false)}
        />
      )}

      {/* Main content wrapper for desktop centering */}
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
            title="Projects"
            onOpenSidebar={() => setSidebarOpen(true)}
          />

          <main className="sessions-page-content">
            {/* Add Project Button/Form */}
            <div className="add-project-section">
              {!showAddForm ? (
                <button
                  type="button"
                  className="add-project-button"
                  onClick={() => setShowAddForm(true)}
                >
                  + Add Project
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

            {projects.length === 0 ? (
              <p>No projects found. Add a project above to get started.</p>
            ) : (
              <ul className="project-list">
                {projects.map((project) => (
                  <li key={project.id}>
                    <Link to={`/projects/${project.id}`}>
                      <strong>{project.name}</strong>
                      <span className="meta">
                        {project.sessionCount} sessions
                        <ActiveCountBadge
                          variant="owned"
                          count={project.activeOwnedCount}
                        />
                        <ActiveCountBadge
                          variant="external"
                          count={project.activeExternalCount}
                        />
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </main>
        </div>
      </div>
    </div>
  );
}
