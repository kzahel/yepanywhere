import type { ContextUsage, ProviderName } from "@yep-anywhere/shared";
import { useEffect, useState } from "react";
import { api } from "../api/client";
import type { ProcessState } from "../hooks/useSession";
import type { SessionStatus } from "../types";
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
  holdSince?: string;
  terminationReason?: string;
  terminatedAt?: string;
  provider: string;
  maxThinkingTokens?: number;
  model?: string;
}

interface ProcessInfoModalProps {
  sessionId: string;
  provider: ProviderName;
  model?: string;
  status: SessionStatus;
  processState: ProcessState;
  contextUsage?: ContextUsage;
  onClose: () => void;
}

function formatThinkingBudget(tokens: number | undefined): string {
  if (!tokens) return "Disabled";
  if (tokens >= 1000) {
    return `${Math.round(tokens / 1000)}K tokens`;
  }
  return `${tokens} tokens`;
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
    <div className="process-info-row">
      <span className="process-info-label">{label}</span>
      <span className={`process-info-value ${mono ? "mono" : ""}`}>
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
    <div className="process-info-section">
      <h3 className="process-info-section-title">{title}</h3>
      {children}
    </div>
  );
}

export function ProcessInfoModal({
  sessionId,
  provider,
  model,
  status,
  processState,
  contextUsage,
  onClose,
}: ProcessInfoModalProps) {
  const [processInfo, setProcessInfo] = useState<ProcessInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fetch process info when modal opens (if session is owned)
  useEffect(() => {
    if (status.state !== "owned") return;

    setLoading(true);
    setError(null);

    api
      .getProcessInfo(sessionId)
      .then((res) => {
        setProcessInfo(res.process);
      })
      .catch((err) => {
        setError(err.message || "Failed to fetch process info");
      })
      .finally(() => {
        setLoading(false);
      });
  }, [sessionId, status.state]);

  const getStateDisplay = () => {
    if (status.state === "owned") {
      switch (processState) {
        case "running":
          return "Running";
        case "idle":
          return "Idle";
        case "waiting-input":
          return "Waiting for input";
        case "hold":
          return "On hold";
        default:
          return processState;
      }
    }
    if (status.state === "external") return "External (other process)";
    return "Idle (no process)";
  };

  const getProviderDisplay = (p: string) => {
    switch (p) {
      case "claude":
        return "Claude (Anthropic)";
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
    <Modal title="Session Info" onClose={onClose}>
      <div className="process-info-content">
        {/* Session Info - always available */}
        <Section title="Session">
          <InfoRow label="Session ID" value={sessionId} mono />
          <InfoRow label="Provider" value={getProviderDisplay(provider)} />
          <InfoRow label="Model" value={model || "Default"} mono />
          <InfoRow label="Status" value={getStateDisplay()} />
        </Section>

        {/* Context Usage - if available */}
        {contextUsage && (
          <Section title="Token Usage">
            <InfoRow
              label="Input tokens"
              value={contextUsage.inputTokens.toLocaleString()}
            />
            {contextUsage.outputTokens !== undefined && (
              <InfoRow
                label="Output tokens"
                value={contextUsage.outputTokens.toLocaleString()}
              />
            )}
            <InfoRow
              label="Context used"
              value={`${contextUsage.percentage.toFixed(1)}%`}
            />
            {contextUsage.cacheReadTokens !== undefined && (
              <InfoRow
                label="Cache read"
                value={contextUsage.cacheReadTokens.toLocaleString()}
              />
            )}
            {contextUsage.cacheCreationTokens !== undefined && (
              <InfoRow
                label="Cache created"
                value={contextUsage.cacheCreationTokens.toLocaleString()}
              />
            )}
          </Section>
        )}

        {/* Process Info - always show, with state-dependent content */}
        <Section title="Process">
          {status.state === "owned" ? (
            <>
              {loading && (
                <div className="process-info-loading">Loading...</div>
              )}
              {error && <div className="process-info-error">{error}</div>}
              {processInfo && (
                <>
                  <InfoRow label="Process ID" value={processInfo.id} mono />
                  <InfoRow
                    label="Started"
                    value={formatTime(processInfo.startedAt)}
                  />
                  <InfoRow
                    label="Uptime"
                    value={formatDuration(processInfo.startedAt)}
                  />
                  <InfoRow label="Queue depth" value={processInfo.queueDepth} />
                  <InfoRow
                    label="Extended thinking"
                    value={formatThinkingBudget(processInfo.maxThinkingTokens)}
                  />
                  {processInfo.idleSince && (
                    <InfoRow
                      label="Idle since"
                      value={formatTime(processInfo.idleSince)}
                    />
                  )}
                  {processInfo.holdSince && (
                    <InfoRow
                      label="Hold since"
                      value={formatTime(processInfo.holdSince)}
                    />
                  )}
                </>
              )}
              {!loading && !processInfo && !error && (
                <div className="process-info-loading">No process data</div>
              )}
            </>
          ) : status.state === "external" ? (
            <div className="process-info-muted">
              Session controlled by external process (VS Code, CLI)
            </div>
          ) : (
            <div className="process-info-muted">No active process</div>
          )}
        </Section>

        {/* Project Info - from process if available */}
        {processInfo && (
          <Section title="Project">
            <InfoRow label="Name" value={processInfo.projectName} />
            <InfoRow label="Path" value={processInfo.projectPath} mono />
          </Section>
        )}
      </div>
    </Modal>
  );
}
