import { toolDisplayContracts } from "./toolDisplayContracts";
import { defineTool } from "./defineTool";
import { useContext, useState } from "react";
import { Link } from "react-router-dom";
import { AgentContentContext } from "../../../contexts/AgentContentContext";
import { useSessionMetadata } from "../../../contexts/SessionMetadataContext";
import { useRemoteBasePath } from "../../../hooks/useRemoteBasePath";
import { useI18n } from "../../../i18n";
import { providerChildSessionHref } from "../../../lib/providerChildSessions";
import type { ToolCallItem } from "@yep-anywhere/shared/transcript/items";
import { Badge, type BadgeTone } from "../../ui/Badge";
import { ButtonBase, buttonClassName } from "../../ui/Button";
import { Spinner } from "../../ui/Spinner";
import { TaskNestedContent } from "./TaskNestedContent";
import styles from "./TaskRenderer.module.css";

type SpawnAgentInput = import("zod").z.output<
  typeof toolDisplayContracts.spawn_agent.input
>;
type SpawnAgentResult = Exclude<
  import("zod").z.output<typeof toolDisplayContracts.spawn_agent.result>,
  string
>;
function normalizeSpawnAgentResult(
  result: SpawnAgentResult | string | undefined,
): SpawnAgentResult | null {
  return typeof result === "object" ? result : null;
}

function compactText(value: string | undefined, fallback: string): string {
  const text = value?.replace(/\s+/g, " ").trim();
  if (!text) {
    return fallback;
  }
  return text.length > 140 ? `${text.slice(0, 137)}...` : text;
}

function spawnAgentTitle(
  input: SpawnAgentInput,
  result: SpawnAgentResult | null,
): string {
  return compactText(
    result?.nickname ??
      input.description ??
      input.task ??
      input.objective ??
      input.message ??
      input.prompt,
    "Codex subagent",
  );
}

function spawnAgentType(input: SpawnAgentInput): string {
  return (
    input.agent_type ??
    input.subagent_type ??
    input.agent_role ??
    input.role ??
    "agent"
  );
}

function statusBadge({
  isError,
  status,
  childStatus,
  hasAgentId,
}: {
  isError: boolean;
  status: ToolCallItem["status"];
  childStatus?: string;
  hasAgentId: boolean;
}): { tone: BadgeTone; text: string; isRunning: boolean } {
  if (isError || (status !== "pending" && !hasAgentId)) {
    return { tone: "danger", text: "failed", isRunning: false };
  }
  if (status === "aborted") {
    return { tone: "warning", text: "interrupted", isRunning: false };
  }
  if (status === "incomplete") {
    return { tone: "warning", text: "result unavailable", isRunning: false };
  }
  if (childStatus === "failed") {
    return { tone: "danger", text: "failed", isRunning: false };
  }
  if (childStatus === "running" || (!hasAgentId && status === "pending")) {
    return { tone: "info", text: "running", isRunning: true };
  }
  if (childStatus === "completed") {
    return { tone: "success", text: "completed", isRunning: false };
  }
  if (hasAgentId) {
    return { tone: "success", text: "spawned", isRunning: false };
  }
  return { tone: "neutral", text: "pending", isRunning: false };
}

function rawResultText(result: unknown): string {
  if (typeof result === "string") {
    return result;
  }
  if (result === undefined) {
    return "";
  }
  try {
    return JSON.stringify(result, null, 2);
  } catch {
    return String(result);
  }
}

function SpawnAgentInline({
  input,
  result,
  isError,
  status,
  toolUseId,
}: {
  input: SpawnAgentInput;
  result: SpawnAgentResult | string | undefined;
  isError: boolean;
  status: ToolCallItem["status"];
  toolUseId?: string;
}) {
  const { t } = useI18n();
  const basePath = useRemoteBasePath();
  const { projectId, sessionId } = useSessionMetadata();
  const context = useContext(AgentContentContext);
  const parsedResult = normalizeSpawnAgentResult(result);
  const agentId =
    parsedResult?.agentId ??
    (toolUseId ? context?.toolUseToAgent.get(toolUseId) : undefined);
  const liveContent = agentId ? context?.agentContent[agentId] : undefined;
  const [isExpanded, setIsExpanded] = useState(false);
  const [isLoadingContent, setIsLoadingContent] = useState(false);
  const badge = statusBadge({
    isError,
    status,
    childStatus: liveContent?.status,
    hasAgentId: Boolean(agentId),
  });

  const handleExpand = async () => {
    const hasLiveContent =
      liveContent?.messages && liveContent.messages.length > 0;
    if (!isExpanded && agentId && context && !hasLiveContent) {
      setIsExpanded(true);
      setIsLoadingContent(true);
      try {
        await context.loadAgentContent(projectId, sessionId, agentId);
      } finally {
        setIsLoadingContent(false);
      }
      return;
    }

    setIsExpanded((current) => !current);
  };

  const title = spawnAgentTitle(input, parsedResult);
  const failedWithoutAgent = status !== "pending" && !agentId;

  return (
    <div
      className={`task-inline ${isExpanded ? "expanded" : "collapsed"} status-${badge.text}`}
    >
      <div className={styles.headerRow}>
        {failedWithoutAgent ? (
          <div
            className={`task-inline-header noninteractive ${styles.expandButton}`}
          >
            <span className="task-expand-icon" />
            <Badge tone="info" size="small" className="task-agent-type">
              {spawnAgentType(input)}
            </Badge>
            <span className="task-inline-title">{title}</span>
            {input.model && (
              <Badge size="small" className="task-model">
                {input.model}
              </Badge>
            )}
            <Badge tone={badge.tone} size="small">
              {badge.text}
            </Badge>
          </div>
        ) : (
          <ButtonBase
            className={`task-inline-header ${styles.expandButton}`}
            onClick={handleExpand}
          >
            <span className="task-expand-icon">{isExpanded ? "▼" : "▶"}</span>
            <Badge tone="info" size="small" className="task-agent-type">
              {spawnAgentType(input)}
            </Badge>
            <span className="task-inline-title">{title}</span>
            {input.model && (
              <Badge size="small" className="task-model">
                {input.model}
              </Badge>
            )}
            {badge.isRunning ? (
              <Spinner size="small" label="Running" />
            ) : (
              <Badge tone={badge.tone} size="small">
                {badge.text}
              </Badge>
            )}
          </ButtonBase>
        )}
        {agentId && (
          <Link
            className={buttonClassName({
              variant: "ghost",
              size: "small",
              className: styles.openPage,
            })}
            to={providerChildSessionHref(
              basePath,
              projectId,
              sessionId,
              agentId,
            )}
          >
            {t("providerChildOpen")}
          </Link>
        )}
      </div>

      {failedWithoutAgent && rawResultText(result) && (
        <pre
          className={`tool-fallback tool-fallback-error ${styles.rejection}`}
        >
          <code>{rawResultText(result)}</code>
        </pre>
      )}

      {isLoadingContent && (
        <div className="task-loading">
          <Spinner size="small" /> Loading agent content...
        </div>
      )}

      {isExpanded && (
        <div className="task-inline-content">
          {liveContent?.messages.length ? (
            <TaskNestedContent
              messages={liveContent.messages}
              isStreaming={liveContent.status === "running"}
            />
          ) : agentId ? (
            <div className="task-empty">No content</div>
          ) : (
            <div className="task-empty">No agent session found</div>
          )}
        </div>
      )}
    </div>
  );
}

export const spawnAgentRenderer = defineTool(toolDisplayContracts.spawn_agent, {
  tool: "spawn_agent",
  displayName: "Spawn agent",
  pendingDisplayName: "Spawning agent",

  renderToolUse(input) {
    return <div className="todo-summary">{spawnAgentTitle(input, null)}</div>;
  },

  renderToolResult(result, isError) {
    const parsed = normalizeSpawnAgentResult(result);
    return (
      <div
        className={isError || !parsed?.agentId ? "todo-error" : "todo-summary"}
      >
        {parsed?.agentId
          ? `Agent ${parsed.agentId}`
          : rawResultText(result) || "Failed to spawn agent"}
      </div>
    );
  },

  getUseSummary(input) {
    return spawnAgentTitle(input, null);
  },

  getResultSummary(result, isError) {
    if (isError) {
      return "Error";
    }
    const parsed = normalizeSpawnAgentResult(result);
    return parsed?.agentId ? `Agent ${parsed.agentId}` : "Failed";
  },

  renderInline(input, result, isError, status, context) {
    return (
      <SpawnAgentInline
        input={input}
        result={result}
        isError={isError}
        status={status}
        toolUseId={context.toolUseId}
      />
    );
  },
});
