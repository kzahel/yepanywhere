import { Link } from "react-router-dom";
import { PageHeader } from "../components/PageHeader";
import { ThinkingIndicator } from "../components/ThinkingIndicator";
import { type ProcessInfo, useProcesses } from "../hooks/useProcesses";
import { useNavigationLayout } from "../layouts";
import { shortenPath } from "../lib/text";

/**
 * Format uptime duration from start time to now.
 */
function formatUptime(startedAt: string): string {
  const start = new Date(startedAt).getTime();
  const now = Date.now();
  const diffMs = now - start;

  const seconds = Math.floor(diffMs / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) {
    return `${days}d ${hours % 24}h`;
  }
  if (hours > 0) {
    return `${hours}h ${minutes % 60}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  }
  return `${seconds}s`;
}

/**
 * Get a display label for the process state.
 */
function getStateLabel(state: string): string {
  switch (state) {
    case "running":
      return "Running";
    case "waiting-input":
      return "Needs Input";
    case "idle":
      return "Idle";
    case "terminated":
      return "Stopped";
    default:
      return state;
  }
}

/**
 * Get CSS class for state badge.
 */
function getStateBadgeClass(state: string): string {
  switch (state) {
    case "running":
      return "agent-state-running";
    case "waiting-input":
      return "agent-state-input";
    case "idle":
      return "agent-state-idle";
    case "terminated":
      return "agent-state-terminated";
    default:
      return "";
  }
}

/**
 * Get display name for provider.
 */
function getProviderLabel(provider: string | undefined): string {
  switch (provider) {
    case "claude":
      return "Claude";
    case "codex":
      return "Codex";
    case "gemini":
      return "Gemini";
    case "local":
      return "Local";
    default:
      return provider ?? "Claude";
  }
}

/**
 * Get CSS class for provider badge.
 */
function getProviderBadgeClass(provider: string | undefined): string {
  switch (provider) {
    case "codex":
      return "agent-provider-codex";
    case "gemini":
      return "agent-provider-gemini";
    case "local":
      return "agent-provider-local";
    default:
      return "agent-provider-claude";
  }
}

interface ProcessCardProps {
  process: ProcessInfo;
  isTerminated?: boolean;
}

function ProcessCard({ process, isTerminated = false }: ProcessCardProps) {
  // Extract project name from path (last directory)
  const projectName =
    process.projectPath.split("/").pop() ?? process.projectPath;

  return (
    <div
      className={`agent-card ${isTerminated ? "agent-card-terminated" : ""}`}
    >
      <div className="agent-card-header">
        <div className="agent-card-title">
          <span className="agent-card-session-title">
            {process.sessionTitle || "Untitled Session"}
          </span>
          <span
            className={`agent-provider-badge ${getProviderBadgeClass(process.provider)}`}
          >
            {getProviderLabel(process.provider)}
          </span>
          {process.state === "running" ? (
            <ThinkingIndicator variant="pill" label="Running" />
          ) : (
            <span
              className={`agent-state-badge ${getStateBadgeClass(process.state)}`}
            >
              {getStateLabel(process.state)}
            </span>
          )}
        </div>
        <div className="agent-card-meta">
          <span className="agent-card-project">{projectName}</span>
          {!isTerminated && (
            <span className="agent-card-uptime">
              {formatUptime(process.startedAt)}
            </span>
          )}
        </div>
      </div>

      <div className="agent-card-details">
        <div className="agent-detail-row">
          <span className="agent-detail-label">Project Path</span>
          <span
            className="agent-detail-value agent-detail-mono"
            title={process.projectPath}
          >
            {shortenPath(process.projectPath)}
          </span>
        </div>
        {process.contextUsage && (
          <div className="agent-detail-row">
            <span className="agent-detail-label">Context</span>
            <span className="agent-detail-value">
              {process.contextUsage.percentage}%
            </span>
          </div>
        )}
        {process.permissionMode && (
          <div className="agent-detail-row">
            <span className="agent-detail-label">Permission Mode</span>
            <span className="agent-detail-value">{process.permissionMode}</span>
          </div>
        )}
        {process.queueDepth > 0 && (
          <div className="agent-detail-row">
            <span className="agent-detail-label">Messages Queued</span>
            <span className="agent-detail-value">{process.queueDepth}</span>
          </div>
        )}
        {process.terminationReason && (
          <div className="agent-detail-row">
            <span className="agent-detail-label">Stop Reason</span>
            <span className="agent-detail-value">
              {process.terminationReason}
            </span>
          </div>
        )}
        <div className="agent-card-actions">
          <Link
            to={`/projects/${process.projectId}/sessions/${process.sessionId}`}
            className="agent-view-session-link"
          >
            {process.sessionTitle || "View Session"} →
          </Link>
        </div>
      </div>
    </div>
  );
}

export function AgentsPage() {
  const { processes, terminatedProcesses, loading, error } = useProcesses();

  const { openSidebar, isWideScreen } = useNavigationLayout();

  // Split processes into active (running/waiting-input) and idle
  const activeProcesses = processes.filter(
    (p) => p.state === "running" || p.state === "waiting-input",
  );
  const idleProcesses = processes.filter((p) => p.state === "idle");

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
        <PageHeader title="Agents" onOpenSidebar={openSidebar} />

        <main className="page-scroll-container">
          <div className="page-content-inner">
            {loading && <p className="loading">Loading agents...</p>}

            {error && (
              <p className="error">Error loading agents: {error.message}</p>
            )}

            {!loading && !error && (
              <>
                <section className="agents-section">
                  <h2>Active</h2>
                  {activeProcesses.length === 0 ? (
                    <p className="agents-empty">No active agents</p>
                  ) : (
                    <div className="agents-list">
                      {activeProcesses.map((process) => (
                        <ProcessCard key={process.id} process={process} />
                      ))}
                    </div>
                  )}
                </section>

                <section className="agents-section">
                  <h2>Idle</h2>
                  {idleProcesses.length === 0 ? (
                    <p className="agents-empty">No idle agents</p>
                  ) : (
                    <div className="agents-list">
                      {idleProcesses.map((process) => (
                        <ProcessCard key={process.id} process={process} />
                      ))}
                    </div>
                  )}
                </section>

                <section className="agents-section">
                  <h2>Stopped</h2>
                  {terminatedProcesses.length === 0 ? (
                    <p className="agents-empty">No stopped agents</p>
                  ) : (
                    <div className="agents-list">
                      {terminatedProcesses.map((process) => (
                        <ProcessCard
                          key={process.id}
                          process={process}
                          isTerminated
                        />
                      ))}
                    </div>
                  )}
                </section>
              </>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}
