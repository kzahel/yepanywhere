import { Link } from "react-router-dom";
import { ContextUsageIndicator } from "../components/ContextUsageIndicator";
import { PageHeader } from "../components/PageHeader";
import { ThinkingIndicator } from "../components/ThinkingIndicator";
import { type ProcessInfo, useProcesses } from "../hooks/useProcesses";
import { useI18n } from "../i18n";
import { useNavigationLayout } from "../layouts";

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
function getStateLabel(state: string, t: (key: never) => string): string {
  switch (state) {
    case "running":
      return t("agentsRunning" as never);
    case "waiting-input":
      return t("agentsNeedsInput" as never);
    case "idle":
      return t("agentsIdle" as never);
    case "terminated":
      return t("agentsStopped" as never);
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
function getProviderLabel(
  provider: string | undefined,
  t: (key: never) => string,
): string {
  switch (provider) {
    case "claude":
      return "Claude";
    case "codex":
      return "Codex";
    case "gemini":
      return "Gemini";
    case "local":
      return t("agentsProviderLocal" as never);
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
  const { t } = useI18n();
  return (
    <Link
      to={`/projects/${process.projectId}/sessions/${process.sessionId}`}
      state={{
        initialStatus: {
          owner: "self" as const,
          processId: process.id,
        },
        initialTitle: process.sessionTitle ?? null,
        initialModel: process.model,
        initialProvider: process.provider,
      }}
      className={`agent-card ${isTerminated ? "agent-card-terminated" : ""}`}
    >
      <div className="agent-card-header">
        <div className="agent-card-title">
          <span className="agent-card-session-title">
            {process.sessionTitle || t("agentsUntitled" as never)}
          </span>
          <span
            className={`agent-provider-badge ${getProviderBadgeClass(process.provider)}`}
          >
            {getProviderLabel(process.provider, t)}
          </span>
          {process.state === "in-turn" ? (
            <ThinkingIndicator
              variant="pill"
              label={t("agentsRunning" as never)}
            />
          ) : (
            <span
              className={`agent-state-badge ${getStateBadgeClass(process.state)}`}
            >
              {getStateLabel(process.state, t)}
            </span>
          )}
        </div>
        <div className="agent-card-meta">
          <span className="agent-card-project">{process.projectName}</span>
          {!isTerminated && (
            <span className="agent-card-uptime">
              {formatUptime(process.startedAt)}
            </span>
          )}
          {process.contextUsage && (
            <ContextUsageIndicator usage={process.contextUsage} />
          )}
        </div>
      </div>

      {(process.permissionMode ||
        process.queueDepth > 0 ||
        process.terminationReason) && (
        <div className="agent-card-details">
          {process.permissionMode && (
            <div className="agent-detail-row">
              <span className="agent-detail-label">
                {t("agentsPermissionMode" as never)}
              </span>
              <span className="agent-detail-value">
                {process.permissionMode}
              </span>
            </div>
          )}
          {process.queueDepth > 0 && (
            <div className="agent-detail-row">
              <span className="agent-detail-label">
                {t("agentsMessagesQueued" as never)}
              </span>
              <span className="agent-detail-value">{process.queueDepth}</span>
            </div>
          )}
          {process.terminationReason && (
            <div className="agent-detail-row">
              <span className="agent-detail-label">
                {t("agentsStopReason" as never)}
              </span>
              <span className="agent-detail-value">
                {process.terminationReason}
              </span>
            </div>
          )}
        </div>
      )}
    </Link>
  );
}

export function AgentsPage() {
  const { t } = useI18n();
  const { processes, terminatedProcesses, loading, error } = useProcesses();

  const { openSidebar, isWideScreen } = useNavigationLayout();

  // Split processes into active (in-turn/waiting-input) and idle
  const activeProcesses = processes.filter(
    (p) => p.state === "in-turn" || p.state === "waiting-input",
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
        <PageHeader
          title={t("agentsTitle" as never)}
          onOpenSidebar={openSidebar}
        />

        <main className="page-scroll-container">
          <div className="page-content-inner">
            {loading && (
              <p className="loading">{t("agentsLoading" as never)}</p>
            )}

            {error && (
              <p className="error">
                {t("agentsError" as never, { message: error.message })}
              </p>
            )}

            {!loading && !error && (
              <>
                <section className="agents-section">
                  <h2>{t("agentsSectionActive" as never)}</h2>
                  {activeProcesses.length === 0 ? (
                    <p className="agents-empty">
                      {t("agentsEmptyActive" as never)}
                    </p>
                  ) : (
                    <div className="agents-list">
                      {activeProcesses.map((process) => (
                        <ProcessCard key={process.id} process={process} />
                      ))}
                    </div>
                  )}
                </section>

                <section className="agents-section">
                  <h2>{t("agentsSectionIdle" as never)}</h2>
                  {idleProcesses.length === 0 ? (
                    <p className="agents-empty">
                      {t("agentsEmptyIdle" as never)}
                    </p>
                  ) : (
                    <div className="agents-list">
                      {idleProcesses.map((process) => (
                        <ProcessCard key={process.id} process={process} />
                      ))}
                    </div>
                  )}
                </section>

                <section className="agents-section">
                  <h2>{t("agentsSectionStopped" as never)}</h2>
                  {terminatedProcesses.length === 0 ? (
                    <p className="agents-empty">
                      {t("agentsEmptyStopped" as never)}
                    </p>
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
