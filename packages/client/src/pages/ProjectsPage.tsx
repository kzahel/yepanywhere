import { Link } from "react-router-dom";
import { PageHeader } from "../components/PageHeader";
import { ActiveCountBadge } from "../components/StatusBadge";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { useProjects } from "../hooks/useProjects";

export function ProjectsPage() {
  const { projects, loading, error } = useProjects();

  // Desktop layout hook
  const isWideScreen = useMediaQuery("(min-width: 1100px)");

  if (loading) return <div className="loading">Loading projects...</div>;
  if (error) return <div className="error">Error: {error.message}</div>;

  return (
    <div className="session-page">
      {/* Main content wrapper for desktop centering */}
      <div className={isWideScreen ? "main-content-wrapper" : undefined}>
        <div className={isWideScreen ? "main-content-constrained" : undefined}>
          <PageHeader title="Projects" />

          <main className="sessions-page-content">
            {projects.length === 0 ? (
              <p>No projects found in ~/.claude/projects</p>
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
