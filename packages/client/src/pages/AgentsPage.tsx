import type { HostAgentProcessObservation } from "@yep-anywhere/shared";
import {
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Link } from "react-router-dom";
import { ProviderChildNavTarget } from "../components/ProviderChildNavTarget";
import { api } from "../api/client";
import { ClearloopRemainingBadge } from "../components/ClearloopRemainingBadge";
import { ContextUsageIndicator } from "../components/ContextUsageIndicator";
import { PageHeader } from "../components/PageHeader";
import { ThinkingIndicator } from "../components/ThinkingIndicator";
import { Badge, type BadgeTone } from "../components/ui/Badge";
import { Banner } from "../components/ui/Banner";
import { Button, ButtonBase } from "../components/ui/Button";
import { Popover } from "../components/ui/Popover";
import { useHostAgentProcesses } from "../hooks/useHostAgentProcesses";
import { type ProcessInfo, useProcesses } from "../hooks/useProcesses";
import { useRemoteBasePath } from "../hooks/useRemoteBasePath";
import { useI18n } from "../i18n";
import { MainContent, useNavigationLayout } from "../layouts";
import {
  providerChildSessionHref,
  providerChildTitle,
} from "../lib/providerChildSessions";
import styles from "./AgentsPage.module.css";

function cx(...classNames: (string | false | undefined)[]): string {
  return classNames.filter(Boolean).join(" ");
}

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

function formatMemory(bytes: number): string {
  const mebibytes = bytes / (1024 * 1024);
  if (mebibytes < 1024) {
    return `${Math.round(mebibytes)} MiB`;
  }
  const gibibytes = mebibytes / 1024;
  return `${gibibytes < 10 ? gibibytes.toFixed(1) : Math.round(gibibytes)} GiB`;
}

function formatCpu(percent: number): string {
  return `${percent < 10 ? percent.toFixed(1) : Math.round(percent)}%`;
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

/** Badge tone for a process state. */
function getStateBadgeTone(state: string): BadgeTone {
  // "running" never reaches a badge: an in-turn card renders ThinkingIndicator.
  return state === "waiting-input" ? "warning" : "neutral";
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
    case "claude-gateway":
      return "Claude Gateway";
    case "claude-ollama":
      return "Claude + Ollama";
    case "codex":
      return "Codex";
    case "gemini":
    case "gemini-acp":
      return "Gemini";
    case "grok":
      return "Grok";
    case "opencode":
      return "OpenCode";
    case "pi":
      return "Pi";
    case "local":
      return t("agentsProviderLocal" as never);
    default:
      return provider ?? "Claude";
  }
}

/** Brand color class for a provider badge; `local` stays neutral. */
function getProviderBadgeClass(
  provider: string | undefined,
): string | undefined {
  switch (provider) {
    case "codex":
      return styles.codex;
    case "gemini":
    case "gemini-acp":
      return styles.gemini;
    case "grok":
      return styles.grok;
    case "opencode":
      return styles.opencode;
    case "pi":
      return styles.pi;
    case "local":
      return undefined;
    default:
      return styles.claude;
  }
}

interface ProcessCardProps {
  process: ProcessInfo;
  observation?: HostAgentProcessObservation;
  basePath?: string;
  isTerminated?: boolean;
  onKill?: (process: ProcessInfo) => void;
  killing?: boolean;
}

interface KillFeedback {
  tone: "success" | "error";
  message: string;
}

interface ProcessMetricsProps {
  observation: HostAgentProcessObservation;
  sessionId?: string;
  touchSurfaceRef?: RefObject<HTMLElement | null>;
}

function ProcessMetrics({
  observation,
  sessionId,
  touchSurfaceRef,
}: ProcessMetricsProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLSpanElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const provider = getProviderLabel(observation.provider, t);
  const age = formatUptime(observation.startedAt);
  const cpu = observation.cpu
    ? t("agentsMetricsCpuValue" as never, {
        percent: formatCpu(observation.cpu.treePercent),
      })
    : t("agentsMetricsCpuSampling" as never);
  const detail = [
    t(
      (observation.supervision === "ya"
        ? "agentsMetricsManagedYa"
        : "agentsMetricsManagedExternal") as never,
    ),
    ...(sessionId
      ? [t("agentsMetricsSession" as never, { id: sessionId })]
      : []),
    t("agentsMetricsProvider" as never, { provider }),
    t("agentsPid" as never, { pid: observation.pid }),
    t("agentsMetricsStarted" as never, {
      value: new Date(observation.startedAt).toLocaleString(),
    }),
    t("agentsMetricsAge" as never, { value: age }),
    observation.cpu
      ? t("agentsMetricsRecentCpu" as never, {
          percent: formatCpu(observation.cpu.rootPercent),
          treePercent: formatCpu(observation.cpu.treePercent),
          seconds: (observation.cpu.windowMs / 1000).toFixed(1),
        })
      : t("agentsMetricsCpuSampling" as never),
    t("agentsMetricsRootRss" as never, {
      value: formatMemory(observation.memory.rootRssBytes),
    }),
    t("agentsMetricsTreeRss" as never, {
      value: formatMemory(observation.memory.treeRssBytes),
    }),
    t("agentsMetricsDescendants" as never, {
      count: observation.memory.descendantCount,
    }),
    t("agentsMetricsSampled" as never, {
      value: new Date(observation.sampledAt).toLocaleTimeString(),
    }),
  ].join("\n");

  useEffect(() => {
    const touchSurface = touchSurfaceRef?.current;
    if (!touchSurface) return;
    const handlePointerUp = (event: PointerEvent) => {
      if (
        event.pointerType !== "touch" ||
        !(event.target instanceof Node) ||
        wrapperRef.current?.contains(event.target)
      ) {
        return;
      }
      const interactiveTarget =
        event.target instanceof Element
          ? event.target.closest(
              "a, button, input, select, textarea, [role='button'], [role='link']",
            )
          : null;
      if (!interactiveTarget) setOpen((value) => !value);
    };
    touchSurface.addEventListener("pointerup", handlePointerUp);
    return () => {
      touchSurface.removeEventListener("pointerup", handlePointerUp);
    };
  }, [touchSurfaceRef]);

  return (
    <span
      // `agent-metrics-wrap` stays for the global ContextUsageIndicator
      // sibling rule in styles/index.css.
      className={cx("agent-metrics-wrap", styles.metricsWrap)}
      ref={wrapperRef}
    >
      <ButtonBase
        ref={triggerRef}
        className={styles.metrics}
        title={detail}
        aria-label={detail}
        aria-expanded={open}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setOpen((value) => !value);
        }}
      >
        <span>{formatMemory(observation.memory.rootRssBytes)} RSS</span>
        <span aria-hidden>·</span>
        <span>{cpu}</span>
      </ButtonBase>
      <Popover
        open={open}
        onClose={() => setOpen(false)}
        anchorRef={triggerRef}
        // A touch tap on the card toggles the popover, so presses there
        // are not outside it.
        insideRefs={touchSurfaceRef ? [touchSurfaceRef] : undefined}
        placement="bottom-end"
        role="status"
        // The process card is a Link; a click in the portaled popover still
        // bubbles to it through the React tree.
        onClick={(event) => event.stopPropagation()}
      >
        <span className={styles.metricsPopover}>{detail}</span>
      </Popover>
    </span>
  );
}

function ProcessCard({
  process,
  observation,
  basePath = "",
  isTerminated = false,
  onKill,
  killing = false,
}: ProcessCardProps) {
  const { t } = useI18n();
  const providerChildren = process.providerChildren ?? [];
  return (
    <Link
      to={`${basePath}/projects/${process.projectId}/sessions/${process.sessionId}`}
      className={cx(styles.card, isTerminated && styles.cardTerminated)}
    >
      <div className={styles.cardHeader}>
        <div className={styles.cardTitle}>
          <span
            className={styles.cardSessionTitle}
            title={t("agentsSessionTooltip" as never, {
              id: process.sessionId,
            })}
          >
            {process.sessionTitle || t("agentsUntitled" as never)}
          </span>
          {process.clearloop !== undefined && (
            <ClearloopRemainingBadge badge={process.clearloop} />
          )}
          <Badge
            size="small"
            className={cx(
              styles.provider,
              getProviderBadgeClass(process.provider),
            )}
          >
            {getProviderLabel(process.provider, t)}
          </Badge>
          {process.state === "in-turn" ? (
            <ThinkingIndicator
              variant="pill"
              label={t("agentsRunning" as never)}
            />
          ) : (
            <Badge size="small" tone={getStateBadgeTone(process.state)}>
              {getStateLabel(process.state, t)}
            </Badge>
          )}
          {!isTerminated && onKill && (
            <Button
              variant="danger-outline"
              size="small"
              className={styles.killButton}
              disabled={killing}
              onClick={(e) => {
                // The whole card is a Link; keep a kill tap from navigating.
                e.preventDefault();
                e.stopPropagation();
                onKill(process);
              }}
              title={t("agentsKillTitle" as never)}
            >
              {killing ? t("agentsKilling" as never) : t("agentsKill" as never)}
            </Button>
          )}
        </div>
        {/* `agent-card-meta` stays for the global ContextUsageIndicator
            descendant rule in styles/index.css. */}
        <div className={cx("agent-card-meta", styles.cardMeta)}>
          <span className={styles.cardProject}>{process.projectName}</span>
          {process.pid !== undefined && (
            <span className={styles.cardPid}>
              {t("agentsPid" as never, { pid: process.pid })}
            </span>
          )}
          {!isTerminated && (
            // A hosted provider process outlives YA restarts, so the OS
            // process age is the age; YA's attach time is secondary.
            <span
              className={styles.cardUptime}
              title={
                observation
                  ? t("agentsAgeTooltip" as never, {
                      started: new Date(observation.startedAt).toLocaleString(),
                      attached: new Date(process.startedAt).toLocaleString(),
                    })
                  : undefined
              }
            >
              {formatUptime(observation?.startedAt ?? process.startedAt)}
            </span>
          )}
          {!isTerminated && observation && (
            <ProcessMetrics
              observation={observation}
              sessionId={process.sessionId}
            />
          )}
          {process.contextUsage && (
            <ContextUsageIndicator usage={process.contextUsage} />
          )}
        </div>
      </div>

      {(process.permissionMode ||
        process.queueDepth > 0 ||
        process.terminationReason) && (
        <div className={styles.cardDetails}>
          {process.permissionMode && (
            <div className={styles.detailRow}>
              <span className={styles.detailLabel}>
                {t("agentsPermissionMode" as never)}
              </span>
              <span className={styles.detailValue}>
                {process.permissionMode}
              </span>
            </div>
          )}
          {process.queueDepth > 0 && (
            <div className={styles.detailRow}>
              <span className={styles.detailLabel}>
                {t("agentsMessagesQueued" as never)}
              </span>
              <span className={styles.detailValue}>{process.queueDepth}</span>
            </div>
          )}
          {process.terminationReason && (
            <div className={styles.detailRow}>
              <span className={styles.detailLabel}>
                {t("agentsStopReason" as never)}
              </span>
              <span className={styles.detailValue}>
                {process.terminationReason}
              </span>
            </div>
          )}
        </div>
      )}

      {providerChildren.length > 0 && (
        <div
          className={styles.providerChildren}
          role="list"
          aria-label={t(
            (providerChildren.length === 1
              ? "providerChildrenCountOne"
              : "providerChildrenCountMany") as never,
            { count: providerChildren.length },
          )}
        >
          {providerChildren.map((child) => {
            const childTitle = providerChildTitle(
              child,
              t("providerChildFallback" as never),
            );
            return (
              <span key={child.id} role="listitem">
                <ProviderChildNavTarget
                  className={styles.providerChild}
                  href={providerChildSessionHref(
                    basePath,
                    process.projectId,
                    process.sessionId,
                    child.id,
                  )}
                >
                  <span className={styles.providerChildBranch} aria-hidden>
                    ↳
                  </span>
                  <span className={styles.providerChildTitle}>
                    {childTitle}
                  </span>
                  {child.agentType && child.agentType !== childTitle && (
                    <span className={styles.providerChildType}>
                      {child.agentType}
                    </span>
                  )}
                </ProviderChildNavTarget>
              </span>
            );
          })}
        </div>
      )}
    </Link>
  );
}

function ExternalProcessCard({
  observation,
  basePath = "",
}: {
  observation: HostAgentProcessObservation;
  basePath?: string;
}) {
  const { t } = useI18n();
  const provider = getProviderLabel(observation.provider, t);
  const touchSurfaceRef = useRef<HTMLElement>(null);
  const { sessionId, projectId } = observation;
  // Only an exact provider record names the session; without one the row
  // stays a plain process and never guesses a title or link.
  const title =
    observation.sessionTitle ??
    (sessionId
      ? t("agentsExternalSessionTitle" as never, {
          provider,
          id: sessionId.slice(0, 8),
        })
      : t("agentsExternalProcessTitle" as never, { provider }));
  const tooltip = sessionId
    ? t("agentsSessionTooltip" as never, { id: sessionId })
    : undefined;
  return (
    <article
      className={cx(styles.card, styles.cardExternal)}
      ref={touchSurfaceRef}
    >
      <div className={styles.cardHeader}>
        <div className={styles.cardTitle}>
          {sessionId && projectId ? (
            <Link
              to={`${basePath}/projects/${projectId}/sessions/${sessionId}`}
              className={cx(styles.cardSessionTitle, styles.cardSessionLink)}
              title={tooltip}
            >
              {title}
            </Link>
          ) : (
            <span className={styles.cardSessionTitle} title={tooltip}>
              {title}
            </span>
          )}
          <Badge
            size="small"
            className={cx(
              styles.provider,
              getProviderBadgeClass(observation.provider),
            )}
          >
            {provider}
          </Badge>
          <Badge size="small">{t("agentsOutsideYa" as never)}</Badge>
        </div>
        {/* `agent-card-meta` stays for the global ContextUsageIndicator
            descendant rule in styles/index.css. */}
        <div className={cx("agent-card-meta", styles.cardMeta)}>
          <span className={styles.cardPid}>
            {t("agentsPid" as never, { pid: observation.pid })}
          </span>
          <span className={styles.cardUptime}>
            {formatUptime(observation.startedAt)}
          </span>
          <ProcessMetrics
            observation={observation}
            sessionId={sessionId}
            touchSurfaceRef={touchSurfaceRef}
          />
        </div>
      </div>
    </article>
  );
}

export function AgentsPage() {
  const { t } = useI18n();
  const { processes, terminatedProcesses, loading, error, refetch } =
    useProcesses();
  const basePath = useRemoteBasePath();
  const hostProcesses = useHostAgentProcesses();

  const { isWideScreen } = useNavigationLayout();

  const [killingIds, setKillingIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [killFeedback, setKillFeedback] = useState<KillFeedback | null>(null);

  // Forcibly abort a live (hung or otherwise) process. This is the manual
  // escape hatch for orphans the automatic stale sweep can't confirm dead
  // (e.g. a Codex hang with no liveness signal), which otherwise sit on the
  // Active list with no UI recourse.
  const handleKill = useCallback(
    async (process: ProcessInfo) => {
      const label = process.sessionTitle || t("agentsUntitled" as never);
      if (!window.confirm(t("agentsKillConfirm" as never, { title: label }))) {
        return;
      }
      setKillingIds((prev) => new Set(prev).add(process.id));
      setKillFeedback(null);
      try {
        // Explicit Kill also persists a YA-owned auto-resume exemption. The
        // provider transcript remains available for deliberate continuation.
        const result = await api.abortProcess(process.id, {
          blockResume: true,
        });
        const stopped =
          result.pid === undefined
            ? t("agentsKillVerified" as never)
            : t("agentsKillVerifiedPid" as never, { pid: result.pid });
        const exemption = result.resumeExemption;
        if (exemption?.error || exemption?.autoResumeDisabled === false) {
          setKillFeedback({
            tone: "error",
            message: `${stopped} ${t("agentsKillResumeBlockFailed" as never, {
              message:
                exemption.error ?? t("agentsKillResumeBlockUnknown" as never),
            })}`,
          });
        } else {
          const resumeBlocked = exemption?.autoResumeDisabled
            ? ` ${t("agentsKillResumeBlocked" as never)}`
            : "";
          setKillFeedback({
            tone: "success",
            message: `${stopped}${resumeBlocked}`,
          });
        }
      } catch (error) {
        setKillFeedback({
          tone: "error",
          message: t("agentsKillFailed" as never, {
            message: error instanceof Error ? error.message : String(error),
          }),
        });
      } finally {
        await refetch();
        setKillingIds((prev) => {
          const next = new Set(prev);
          next.delete(process.id);
          return next;
        });
      }
    },
    [refetch, t],
  );

  // Split processes into active (in-turn/waiting-input) and idle
  const activeProcesses = processes.filter(
    (p) => p.state === "in-turn" || p.state === "waiting-input",
  );
  const idleProcesses = processes.filter((p) => p.state === "idle");
  const observationsBySupervisorProcessId = useMemo(
    () =>
      new Map(
        hostProcesses.observations
          .filter(
            (
              observation,
            ): observation is HostAgentProcessObservation & {
              supervisorProcessId: string;
            } => observation.supervisorProcessId !== undefined,
          )
          .map((observation) => [observation.supervisorProcessId, observation]),
      ),
    [hostProcesses.observations],
  );
  const externalProcesses = hostProcesses.observations.filter(
    (observation) => observation.supervision === "external",
  );

  return (
    <MainContent isWideScreen={isWideScreen}>
      <PageHeader title={t("agentsTitle" as never)} />

      <main className="page-scroll-container">
        <div className="page-content-inner">
          {loading && <p className="loading">{t("agentsLoading" as never)}</p>}

          {error && (
            <Banner tone="error" className={styles.feedback}>
              {t("agentsError" as never, { message: error.message })}
            </Banner>
          )}

          {killFeedback && (
            <Banner tone={killFeedback.tone} className={styles.feedback}>
              {killFeedback.message}
            </Banner>
          )}

          {!loading && !error && (
            <>
              <section className={styles.section}>
                <h2>{t("agentsSectionActive" as never)}</h2>
                {activeProcesses.length === 0 ? (
                  <p className={styles.empty}>
                    {t("agentsEmptyActive" as never)}
                  </p>
                ) : (
                  <div className={styles.list}>
                    {activeProcesses.map((process) => (
                      <ProcessCard
                        key={process.id}
                        process={process}
                        observation={observationsBySupervisorProcessId.get(
                          process.id,
                        )}
                        basePath={basePath}
                        onKill={handleKill}
                        killing={killingIds.has(process.id)}
                      />
                    ))}
                  </div>
                )}
              </section>

              {hostProcesses.enabled && (
                <section className={styles.section}>
                  <h2>{t("agentsSectionExternal" as never)}</h2>
                  {hostProcesses.loading ? (
                    <p className={styles.empty}>
                      {t("agentsExternalLoading" as never)}
                    </p>
                  ) : hostProcesses.supported === false ? (
                    <p className={styles.empty}>
                      {t("agentsExternalUnsupported" as never)}
                    </p>
                  ) : hostProcesses.error ? (
                    <p className={styles.empty}>
                      {t("agentsExternalUnavailable" as never)}
                    </p>
                  ) : externalProcesses.length === 0 ? (
                    <p className={styles.empty}>
                      {t("agentsEmptyExternal" as never)}
                    </p>
                  ) : (
                    <div className={styles.list}>
                      {externalProcesses.map((observation) => (
                        <ExternalProcessCard
                          key={observation.observationId}
                          observation={observation}
                          basePath={basePath}
                        />
                      ))}
                    </div>
                  )}
                </section>
              )}

              <section className={styles.section}>
                <h2>{t("agentsSectionIdle" as never)}</h2>
                {idleProcesses.length === 0 ? (
                  <p className={styles.empty}>
                    {t("agentsEmptyIdle" as never)}
                  </p>
                ) : (
                  <div className={styles.list}>
                    {idleProcesses.map((process) => (
                      <ProcessCard
                        key={process.id}
                        process={process}
                        observation={observationsBySupervisorProcessId.get(
                          process.id,
                        )}
                        basePath={basePath}
                        onKill={handleKill}
                        killing={killingIds.has(process.id)}
                      />
                    ))}
                  </div>
                )}
              </section>

              <section className={styles.section}>
                <h2>{t("agentsSectionStopped" as never)}</h2>
                {terminatedProcesses.length === 0 ? (
                  <p className={styles.empty}>
                    {t("agentsEmptyStopped" as never)}
                  </p>
                ) : (
                  <div className={styles.list}>
                    {terminatedProcesses.map((process) => (
                      <ProcessCard
                        key={process.id}
                        process={process}
                        basePath={basePath}
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
    </MainContent>
  );
}
