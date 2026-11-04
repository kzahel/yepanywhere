import type {
  ContextUsage,
  ModelServiceTier,
  ProviderName,
  ProviderRuntimeStatus,
  ProviderWorkItem,
  SessionLivenessSnapshot,
  SessionSandboxPolicy,
} from "@yep-anywhere/shared";
import { useEffect, useState } from "react";
import { api } from "../api/client";
import { useActivityBusState } from "../hooks/useActivityBusState";
import type { ProcessState } from "../hooks/useSession";
import { useI18n } from "../i18n";
import { getProviderRuntimeReasonLabel } from "../lib/providerRuntimeStatus";
import { isStandardServiceTier, serviceTierLabel } from "../lib/serviceTiers";
import type { SessionStatus } from "../types";
import styles from "./ProcessInfoModal.module.css";
import { SessionTitleDetails } from "./SessionTitleDetails";
import type { RouterBinding } from "./RouterPoolSelector";
import { Modal } from "./ui/Modal";

interface ProcessInfo {
  id: string;
  sessionId: string;
  projectId: string;
  projectPath: string;
  projectName: string;
  sessionTitle: string | null;
  state: string;
  startedAt: string;
  queueDepth: number;
  idleSince?: string;
  terminationReason?: string;
  terminatedAt?: string;
  provider: string;
  thinking?: { type: string };
  effort?: string;
  model?: string;
  serviceTier?: string;
  executor?: string;
  liveness?: SessionLivenessSnapshot;
  providerRuntimeStatus?: ProviderRuntimeStatus;
}

interface ProcessInfoBodyProps {
  sessionId: string;
  sessionTitle: string;
  provider: ProviderName;
  model?: string;
  /** Last persisted launch tier; null is Standard, undefined is unknown. */
  savedServiceTier?: string | null;
  /** Catalog tiers for the session's model, used for display names. */
  serviceTiers?: readonly ModelServiceTier[];
  status: SessionStatus;
  processState: ProcessState;
  sessionLiveness?: SessionLivenessSnapshot | null;
  providerRuntimeStatus?: ProviderRuntimeStatus;
  contextUsage?: ContextUsage;
  originator?: string;
  cliVersion?: string;
  sessionSource?: string;
  approvalPolicy?: string;
  sandboxPolicy?: SessionSandboxPolicy;
  createdAt?: string;
  routerBinding?: RouterBinding;
  /** Whether the session-specific SSE stream is connected */
  sessionStreamConnected: boolean;
  /** Timestamp of last SSE activity for this session */
  lastSessionEventAt?: string | null;
}

interface ProcessInfoModalProps extends ProcessInfoBodyProps {
  onClose: () => void;
}

function formatThinkingConfig(
  thinking?: { type: string },
  effort?: string,
  t?: (key: string) => string,
): string {
  if (!thinking || thinking.type === "disabled") {
    return t ? t("processInfoThinkingDisabled") : "Disabled";
  }
  const mode =
    thinking.type === "adaptive"
      ? t
        ? t("processInfoThinkingAdaptive")
        : "Adaptive"
      : t
        ? t("processInfoThinkingEnabled")
        : "Enabled";
  return effort ? `${mode} (${effort})` : mode;
}

function formatDuration(startedAt: string): string {
  const start = new Date(startedAt);
  const now = new Date();
  const diffMs = now.getTime() - start.getTime();

  const seconds = Math.floor(diffMs / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

function formatTime(isoString: string): string {
  const date = new Date(isoString);
  return date.toLocaleString();
}

function formatMsDuration(ms: number): string {
  if (ms >= 60_000) {
    const minutes = Math.round(ms / 60_000);
    return `${minutes}m`;
  }
  return `${Math.round(ms / 1000)}s`;
}

function formatTimeAgo(
  timestamp: number | null,
  t: (key: string, vars?: Record<string, string | number>) => string,
): string {
  if (!timestamp) return t("processInfoNever");
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 5) return t("processInfoJustNow");
  if (seconds < 60) return t("processInfoSecondsAgo", { seconds });
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return t("processInfoMinutesAgo", { minutes });
  const hours = Math.floor(minutes / 60);
  return t("processInfoHoursAgo", { hours, minutes: minutes % 60 });
}

function formatSandboxPolicy(
  policy: SessionSandboxPolicy | undefined,
  t: (key: string) => string,
): string | null {
  if (!policy) return null;

  const details: string[] = [];
  if (policy.networkAccess !== undefined) {
    details.push(
      policy.networkAccess
        ? t("processInfoNetworkOn")
        : t("processInfoNetworkOff"),
    );
  }
  if (policy.excludeTmpdirEnvVar !== undefined) {
    details.push(
      policy.excludeTmpdirEnvVar
        ? t("processInfoTmpdirExcluded")
        : t("processInfoTmpdirIncluded"),
    );
  }
  if (policy.excludeSlashTmp !== undefined) {
    details.push(
      policy.excludeSlashTmp
        ? t("processInfoTmpExcluded")
        : t("processInfoTmpIncluded"),
    );
  }

  if (details.length === 0) return policy.type;
  return `${policy.type} (${details.join(", ")})`;
}

function formatProviderRetention(
  retention: SessionLivenessSnapshot["providerRetention"] | undefined,
): string | null {
  if (!retention?.retained) return null;

  const counts = [
    `bg=${retention.backgroundTaskCount ?? 0}`,
    `crons=${retention.sessionCronCount ?? 0}`,
    `tasks=${retention.liveTaskCount ?? 0}`,
  ].join(" ");
  const reasons = retention.reasons.join(", ");
  return reasons ? `${counts}; ${reasons}` : counts;
}

const PROVIDER_WORK_ROWS = 8;

function formatProviderWorkItem(
  item: ProviderWorkItem,
  t: (key: string, vars?: Record<string, string | number>) => string,
): string {
  const parts = [item.kind, item.label];
  if (item.command && item.command !== item.label) parts.push(item.command);
  if (item.schedule) {
    parts.push(
      item.recurring
        ? t("processInfoWorkRecurring", { schedule: item.schedule })
        : item.schedule,
    );
  }
  if (item.until) {
    parts.push(
      t("processInfoWorkUntil", {
        time: new Date(item.until).toLocaleTimeString(),
      }),
    );
  } else if (item.startedAt) {
    parts.push(formatTimeAgo(new Date(item.startedAt).getTime(), t));
  }
  return parts.join(" · ");
}

function ProviderWorkRows({
  label,
  items,
  t,
}: {
  label: string;
  items: ProviderWorkItem[] | undefined;
  t: (key: string, vars?: Record<string, string | number>) => string;
}) {
  if (!items?.length) return null;
  const shown = items.slice(0, PROVIDER_WORK_ROWS);
  return (
    <>
      {shown.map((item) => (
        <InfoRow
          key={item.id}
          label={label}
          value={formatProviderWorkItem(item, t)}
          mono
        />
      ))}
      {items.length > shown.length && (
        <InfoRow
          label={label}
          value={t("processInfoWorkMore", {
            count: items.length - shown.length,
          })}
        />
      )}
    </>
  );
}

function InfoRow({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string | number | undefined | null;
  mono?: boolean;
}) {
  if (value === undefined || value === null) return null;
  return (
    <div className={styles.row}>
      <span className={styles.label}>{label}</span>
      <span className={`${styles.value} ${mono ? styles.mono : ""}`}>
        {value}
      </span>
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className={styles.section}>
      <h3 className={styles.sectionTitle}>{title}</h3>
      {children}
    </div>
  );
}

export function ProcessInfoBody({
  sessionId,
  sessionTitle,
  provider,
  model,
  savedServiceTier,
  serviceTiers,
  status,
  processState,
  sessionLiveness,
  providerRuntimeStatus: liveProviderRuntimeStatus,
  contextUsage,
  originator,
  cliVersion,
  sessionSource,
  approvalPolicy,
  sandboxPolicy,
  createdAt,
  routerBinding,
  sessionStreamConnected,
  lastSessionEventAt,
}: ProcessInfoBodyProps) {
  const { t } = useI18n();
  const tr = (key: string, vars?: Record<string, string | number>): string =>
    t(key as never, vars);
  const [processInfo, setProcessInfo] = useState<ProcessInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { connected: streamConnected, connectionState } = useActivityBusState();
  // The session stream refreshes liveness on every provider change; the
  // process fetch only covers sessions without a live stream.
  const liveness = sessionLiveness ?? processInfo?.liveness ?? null;
  const providerRuntimeStatus = processInfo
    ? (processInfo.providerRuntimeStatus ?? null)
    : (liveProviderRuntimeStatus ?? null);

  // Fetch process info when modal opens (if session is owned)
  useEffect(() => {
    if (status.owner !== "self") return;

    setLoading(true);
    setError(null);

    api
      .getProcessInfo(sessionId)
      .then((res) => {
        setProcessInfo(res.process);
      })
      .catch((err) => {
        setError(err.message || t("processInfoError"));
      })
      .finally(() => {
        setLoading(false);
      });
  }, [sessionId, status.owner, t]);

  // Format kebab-case to Title Case (e.g., "in-turn" -> "In Turn")
  const formatKebab = (s: string) =>
    s
      .split("-")
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(" ");

  const activityValue =
    liveness?.derivedStatus === "verified-waiting-provider"
      ? t("toolbarLivenessWaitingOnProvider")
      : formatKebab(processState);
  const retentionValue = formatProviderRetention(liveness?.providerRetention);
  const wake = liveness?.lastWakeReason;
  const wakeValue = wake
    ? `${formatKebab(wake.reason)} (${formatTimeAgo(new Date(wake.at).getTime(), tr)})`
    : null;
  const wakeMessageValue = wake?.messageType
    ? wake.messageSubtype
      ? `${wake.messageType}/${wake.messageSubtype}`
      : wake.messageType
    : null;

  // A live process reports its tier directly (absent means Standard); a
  // stopped session falls back to its persisted launch settings.
  const knownServiceTier: string | null | undefined = processInfo
    ? (processInfo.serviceTier ?? null)
    : savedServiceTier;
  const showServiceTier =
    knownServiceTier !== undefined &&
    (provider === "codex" ||
      provider === "codex-oss" ||
      !isStandardServiceTier(knownServiceTier));
  const serviceTierValue = !showServiceTier
    ? null
    : isStandardServiceTier(knownServiceTier)
      ? serviceTierLabel(knownServiceTier, serviceTiers, t)
      : `${serviceTierLabel(knownServiceTier, serviceTiers, t)} (${knownServiceTier})`;

  const getProviderDisplay = (p: string) => {
    switch (p) {
      case "claude":
        return "Claude (Anthropic)";
      case "claude-gateway":
        return "Claude Gateway";
      case "claude-ollama":
        return "Claude + Ollama (Local)";
      case "codex":
        return "Codex (OpenAI)";
      case "codex-oss":
        return "Codex OSS (Local)";
      case "gemini":
        return "Gemini (Google)";
      case "opencode":
        return "OpenCode";
      default:
        return p;
    }
  };

  return (
    <div className={styles.content}>
      <SessionTitleDetails title={sessionTitle} label={t("sessionFullTitle")} />
      {/* Session Info - always available */}
      <Section title={t("processInfoSectionSession")}>
        <InfoRow
          label={t("processInfoLabelSessionId")}
          value={sessionId}
          mono
        />
        {createdAt && (
          <InfoRow
            label={t("processInfoLabelCreated")}
            value={formatTime(createdAt)}
          />
        )}
        <InfoRow
          label={t("processInfoLabelProvider")}
          value={getProviderDisplay(provider)}
        />
        <InfoRow
          label={t("processInfoLabelModel")}
          value={model || t("processInfoDefaultModel")}
          mono
        />
        <InfoRow
          label={t("processInfoLabelServiceTier")}
          value={serviceTierValue}
        />
        <InfoRow
          label={t("processInfoLabelOwnership")}
          value={formatKebab(status.owner)}
        />
        <InfoRow label={t("processInfoLabelActivity")} value={activityValue} />
        <InfoRow
          label={t("processInfoLabelLiveness")}
          value={liveness ? formatKebab(liveness.derivedStatus) : null}
        />
        <InfoRow
          label={t("processInfoLabelProviderRetention")}
          value={retentionValue}
          mono
        />
        <ProviderWorkRows
          label={t("processInfoLabelForegroundWait")}
          items={liveness?.providerRetention?.foregroundWaits}
          t={tr}
        />
        <ProviderWorkRows
          label={t("processInfoLabelBackgroundWork")}
          items={liveness?.providerRetention?.backgroundWork}
          t={tr}
        />
        <InfoRow label={t("processInfoLabelLastWake")} value={wakeValue} />
        <InfoRow
          label={t("processInfoLabelWakeMessage")}
          value={wakeMessageValue}
          mono
        />
        <InfoRow label={t("processInfoLabelOriginator")} value={originator} />
        <InfoRow
          label={t("processInfoLabelCliVersion")}
          value={cliVersion}
          mono
        />
        <InfoRow
          label={t("processInfoLabelSessionSource")}
          value={sessionSource}
        />
        <InfoRow
          label={t("processInfoLabelApprovalPolicy")}
          value={approvalPolicy}
          mono
        />
        <InfoRow
          label={t("processInfoLabelSandboxPolicy")}
          value={formatSandboxPolicy(sandboxPolicy, tr)}
          mono
        />
      </Section>

      {routerBinding && (
        <Section title={t("processInfoSectionRouter")}>
          <InfoRow
            label={t("processInfoLabelRouterPool")}
            value={routerBinding.poolName}
          />
          <InfoRow
            label={t("processInfoLabelRouterPoolId")}
            value={routerBinding.poolId}
            mono
          />
          <InfoRow
            label={t("processInfoLabelRouterAccount")}
            value={routerBinding.accountDisplayName}
          />
          <InfoRow
            label={t("processInfoLabelRouterAccountId")}
            value={routerBinding.accountId}
            mono
          />
          <InfoRow
            label={t("processInfoLabelRouterClaudeAiConnectors")}
            value={
              routerBinding.claudeAiConnectors
                ? t("processInfoRouterClaudeAiConnectorsOn")
                : undefined
            }
          />
          <InfoRow
            label={t("processInfoLabelRouterPolicy")}
            value={routerBinding.policyLabel ?? routerBinding.policy}
          />
          <InfoRow
            label={t("processInfoLabelRouterReason")}
            value={routerBinding.reason}
          />
          <InfoRow
            label={t("processInfoLabelRouterObserved")}
            value={
              routerBinding.observedAt && formatTime(routerBinding.observedAt)
            }
          />
          <InfoRow
            label={t("processInfoLabelRouterBindingId")}
            value={routerBinding.id}
            mono
          />
          <InfoRow
            label={t("processInfoLabelRouterId")}
            value={routerBinding.routerId}
            mono
          />
        </Section>
      )}

      {providerRuntimeStatus && (
        <Section title={t("processInfoSectionProviderRuntime")}>
          <InfoRow
            label={t("processInfoLabelRuntimeStatus")}
            value={
              providerRuntimeStatus.kind === "terminal"
                ? providerRuntimeStatus.scope === "provider_process"
                  ? t("processInfoRuntimeProcessTerminal")
                  : t("processInfoRuntimeTerminal")
                : t("processInfoRuntimeRetrying")
            }
          />
          <InfoRow
            label={t("processInfoLabelRuntimeReason")}
            value={getProviderRuntimeReasonLabel(providerRuntimeStatus, t)}
          />
          <InfoRow
            label={t("processInfoLabelRuntimeHttpStatus")}
            value={
              providerRuntimeStatus.kind === "retrying"
                ? providerRuntimeStatus.httpStatus
                : null
            }
          />
          <InfoRow
            label={t("processInfoLabelRuntimeRetryAt")}
            value={
              providerRuntimeStatus.kind === "retrying" &&
              providerRuntimeStatus.retryAt
                ? formatTime(providerRuntimeStatus.retryAt)
                : null
            }
          />
          <InfoRow
            label={t("processInfoLabelRuntimeRetryDelay")}
            value={
              providerRuntimeStatus.kind === "retrying" &&
              providerRuntimeStatus.retryDelayMs !== undefined
                ? formatMsDuration(providerRuntimeStatus.retryDelayMs)
                : null
            }
          />
          <InfoRow
            label={t("processInfoLabelRuntimeStarted")}
            value={
              providerRuntimeStatus.kind === "retrying"
                ? formatTime(providerRuntimeStatus.startedAt)
                : null
            }
          />
          <InfoRow
            label={t("processInfoLabelRuntimeLastSeen")}
            value={
              providerRuntimeStatus.kind === "retrying"
                ? formatTime(providerRuntimeStatus.lastSeenAt)
                : null
            }
          />
          <InfoRow
            label={t("processInfoLabelRuntimeOccurred")}
            value={
              providerRuntimeStatus.kind === "terminal"
                ? formatTime(providerRuntimeStatus.occurredAt)
                : null
            }
          />
          <InfoRow
            label={t("processInfoLabelRuntimeMessage")}
            value={providerRuntimeStatus.message ?? null}
          />
          <InfoRow
            label={t("processInfoLabelRuntimeDetails")}
            value={providerRuntimeStatus.details ?? null}
          />
          <InfoRow
            label={t("processInfoLabelRuntimeAttempt")}
            value={
              providerRuntimeStatus.kind === "retrying"
                ? providerRuntimeStatus.attempt
                : null
            }
          />
          <InfoRow
            label={t("processInfoLabelRuntimeMaxRetries")}
            value={
              providerRuntimeStatus.kind === "retrying" &&
              providerRuntimeStatus.maxRetries === "unbounded"
                ? t("processInfoRuntimeUnbounded")
                : providerRuntimeStatus.kind === "retrying"
                  ? providerRuntimeStatus.maxRetries
                  : null
            }
          />
          <InfoRow
            label={t("processInfoLabelRuntimeEventCount")}
            value={
              providerRuntimeStatus.kind === "retrying"
                ? providerRuntimeStatus.eventCount
                : null
            }
          />
          <InfoRow
            label={t("processInfoLabelRuntimeSource")}
            value={providerRuntimeStatus.source}
            mono
          />
        </Section>
      )}

      {/* Connection Info */}
      <Section title={t("processInfoSectionConnection")}>
        <InfoRow
          label={t("processInfoLabelActivityStream")}
          value={
            streamConnected
              ? t("processInfoConnected")
              : t("processInfoDisconnected")
          }
        />
        <InfoRow
          label={t("processInfoLabelConnectionState")}
          value={connectionState}
        />
        <InfoRow
          label={
            status.owner === "external"
              ? t("processInfoLabelSessionWatch")
              : t("processInfoLabelSessionStream")
          }
          value={
            status.owner === "none"
              ? t("processInfoNotSubscribed")
              : sessionStreamConnected
                ? t("processInfoConnected")
                : t("processInfoDisconnected")
          }
        />
        {status.owner === "self" && lastSessionEventAt && (
          <InfoRow
            label={t("processInfoLabelLastSessionEvent")}
            value={formatTimeAgo(new Date(lastSessionEventAt).getTime(), tr)}
          />
        )}
        {status.owner === "external" && (
          <InfoRow
            label={t("processInfoLabelSubscriptionMode")}
            value={t("processInfoFocusedWatch")}
          />
        )}
      </Section>

      {/* Context Usage - if available */}
      {contextUsage && (
        <Section title={t("processInfoSectionTokenUsage")}>
          <InfoRow
            label={t("processInfoLabelInputTokens")}
            value={contextUsage.inputTokens.toLocaleString()}
          />
          {contextUsage.outputTokens !== undefined && (
            <InfoRow
              label={t("processInfoLabelOutputTokens")}
              value={contextUsage.outputTokens.toLocaleString()}
            />
          )}
          <InfoRow
            label={t("processInfoLabelContextUsed")}
            value={`${contextUsage.percentage.toFixed(1)}%`}
          />
          {contextUsage.cacheReadTokens !== undefined && (
            <InfoRow
              label={t("processInfoLabelCacheRead")}
              value={contextUsage.cacheReadTokens.toLocaleString()}
            />
          )}
          {contextUsage.cacheCreationTokens !== undefined && (
            <InfoRow
              label={t("processInfoLabelCacheCreated")}
              value={contextUsage.cacheCreationTokens.toLocaleString()}
            />
          )}
        </Section>
      )}

      {/* Process Info - always show, with state-dependent content */}
      <Section title={t("processInfoSectionProcess")}>
        {status.owner === "self" ? (
          <>
            {loading && (
              <div className={styles.loading}>{t("newSessionLoading")}</div>
            )}
            {error && <div className={styles.error}>{error}</div>}
            {processInfo && (
              <>
                <InfoRow
                  label={t("processInfoLabelProcessId")}
                  value={processInfo.id}
                  mono
                />
                <InfoRow
                  label={t("processInfoLabelStarted")}
                  value={formatTime(processInfo.startedAt)}
                />
                <InfoRow
                  label={t("processInfoLabelUptime")}
                  value={formatDuration(processInfo.startedAt)}
                />
                <InfoRow
                  label={t("processInfoLabelQueueDepth")}
                  value={processInfo.queueDepth}
                />
                <InfoRow
                  label={t("processInfoLabelExtendedThinking")}
                  value={formatThinkingConfig(
                    processInfo.thinking,
                    processInfo.effort,
                    tr,
                  )}
                />
                {processInfo.idleSince && (
                  <InfoRow
                    label={t("processInfoLabelIdleSince")}
                    value={formatTime(processInfo.idleSince)}
                  />
                )}
              </>
            )}
            {!loading && !processInfo && !error && (
              <div className={styles.loading}>
                {t("processInfoNoProcessData")}
              </div>
            )}
          </>
        ) : status.owner === "external" ? (
          <div className={styles.muted}>{t("processInfoExternalProcess")}</div>
        ) : (
          <div className={styles.muted}>{t("processInfoNoActiveProcess")}</div>
        )}
      </Section>

      {/* Project Info - from process if available */}
      {processInfo && (
        <Section title={t("processInfoSectionProject")}>
          <InfoRow
            label={t("processInfoLabelProjectName")}
            value={processInfo.projectName}
          />
          <InfoRow
            label={t("processInfoLabelProjectPath")}
            value={processInfo.projectPath}
            mono
          />
          <InfoRow
            label={t("processInfoLabelRemoteHost")}
            value={processInfo.executor}
            mono
          />
        </Section>
      )}
    </div>
  );
}

export function ProcessInfoModal({ onClose, ...rest }: ProcessInfoModalProps) {
  const { t } = useI18n();
  return (
    <Modal title={t("processInfoTitle")} onClose={onClose}>
      <ProcessInfoBody {...rest} />
    </Modal>
  );
}
