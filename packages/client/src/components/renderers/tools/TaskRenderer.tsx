import { toolDisplayContracts } from "./toolDisplayContracts";
import { defineTool } from "./defineTool";
import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useRemoteBasePath } from "../../../hooks/useRemoteBasePath";
import { useI18n } from "../../../i18n";
import { providerChildSessionHref } from "../../../lib/providerChildSessions";
import styles from "./TaskRenderer.module.css";
import type { ZodError } from "zod";
import { AgentContentContext } from "../../../contexts/AgentContentContext";
import { useSchemaValidationContext } from "../../../contexts/SchemaValidationContext";
import {
  useOptionalSessionMetadata,
  useSessionMetadata,
} from "../../../contexts/SessionMetadataContext";
import { classifyToolError } from "../../../lib/classifyToolError";
import { validateToolResult } from "../../../lib/validateToolResult";
import type { ToolCallItem } from "@yep-anywhere/shared/transcript/items";
import { SchemaWarning } from "../../SchemaWarning";
import { ContentBlockRenderer } from "../ContentBlockRenderer";
import { Spinner, TaskNestedContent } from "./TaskNestedContent";
import type { TaskInput, TaskResult } from "./types";

const MAX_PROMPT_LENGTH = 200;
const MAX_ERROR_SUMMARY_LENGTH = 80;

/**
 * Extract error message from tool result.
 * Handles both structured errors and raw string errors.
 */
function extractErrorMessage(
  result: unknown,
): { raw: string; summary: string; label: string } | null {
  if (!result) return null;

  let rawMessage = "";

  // Handle different result shapes
  if (typeof result === "string") {
    rawMessage = result;
  } else if (typeof result === "object" && result !== null) {
    // Check for content field (tool_result format)
    if ("content" in result) {
      const content = result.content;
      if (typeof content === "string") {
        rawMessage = content;
      } else if (Array.isArray(content)) {
        // Content blocks array - find text content
        for (const block of content) {
          if (
            typeof block === "object" &&
            block !== null &&
            "type" in block &&
            block.type === "text" &&
            "text" in block
          ) {
            rawMessage = String(block.text);
            break;
          }
        }
      }
    }
  }

  if (!rawMessage) return null;

  // Classify the error
  const classified = classifyToolError(rawMessage);

  // Create summary (truncated cleaned message)
  const summary =
    classified.cleanedMessage.length > MAX_ERROR_SUMMARY_LENGTH
      ? `${classified.cleanedMessage.slice(0, MAX_ERROR_SUMMARY_LENGTH)}...`
      : classified.cleanedMessage;

  return {
    raw: rawMessage,
    summary,
    label: classified.label,
  };
}

/**
 * Format duration in ms to human readable
 */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}

/**
 * Task tool use - shows description and subagent type
 */
function TaskToolUse({ input }: { input: TaskInput }) {
  const [showPrompt, setShowPrompt] = useState(false);
  const promptTruncated =
    input.prompt.length > MAX_PROMPT_LENGTH
      ? `${input.prompt.slice(0, MAX_PROMPT_LENGTH)}...`
      : input.prompt;

  return (
    <div className="task-tool-use">
      <div className="task-header">
        <span className="task-description">{input.description}</span>
        <span className="badge badge-info">{input.subagent_type}</span>
        {input.model && <span className="badge">{input.model}</span>}
      </div>
      {input.prompt && (
        <div className="task-prompt">
          <button
            type="button"
            className="task-prompt-toggle"
            onClick={() => setShowPrompt(!showPrompt)}
          >
            {showPrompt ? "Hide prompt" : "Show prompt"}
          </button>
          {showPrompt && (
            <pre className="task-prompt-content">
              <code>{showPrompt ? input.prompt : promptTruncated}</code>
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Task inline renderer - shows complete Task UI with nested content
 */
function TaskInline({
  input,
  result,
  isError,
  status,
  toolUseId,
}: {
  input: TaskInput;
  result: TaskResult | undefined;
  isError: boolean;
  status: ToolCallItem["status"];
  toolUseId?: string;
}) {
  const { t } = useI18n();
  const basePath = useRemoteBasePath();
  const { projectId, projectPath, sessionId } = useSessionMetadata();
  const context = useContext(AgentContentContext);
  const {
    reportValidationError,
    enabled: validationEnabled,
    isToolIgnored,
  } = useSchemaValidationContext();

  // Get agentId from result, or look it up from toolUseToAgent mapping during streaming
  // The mapping is built when we receive system/init messages with parent_tool_use_id
  const agentId =
    result?.agentId ??
    (toolUseId ? context?.toolUseToAgent.get(toolUseId) : undefined);

  // Get live content from context if available
  const liveContent = agentId ? context?.agentContent[agentId] : undefined;

  // Determine if task is running
  // The outer `status` prop (from tool_result) is the ground truth:
  // - "pending" = tool_use sent, no result yet (task may be running)
  // - "complete"/"error"/"aborted" = tool_result received, task is done
  // Only check liveContent when status is "pending" (no result yet)
  const hasTerminalResult =
    result?.status === "completed" || result?.status === "failed";
  const isRunning =
    !hasTerminalResult &&
    status === "pending" &&
    (liveContent?.status === "running" || !liveContent?.status);

  // Always start collapsed - users can expand if they want to see details
  const [isExpanded, setIsExpanded] = useState(false);
  const [isLoadingContent, setIsLoadingContent] = useState(false);
  const [thinkingExpanded, setThinkingExpanded] = useState(false);
  const toggleThinkingExpanded = useCallback(() => {
    setThinkingExpanded((prev) => !prev);
  }, []);

  // Autoscroll refs
  const contentRef = useRef<HTMLDivElement>(null);
  const shouldAutoScrollRef = useRef(true);
  const isProgrammaticScrollRef = useRef(false);
  const lastHeightRef = useRef(0);

  // Scroll content container to bottom
  const scrollToBottom = useCallback((container: HTMLElement) => {
    isProgrammaticScrollRef.current = true;
    container.scrollTop = container.scrollHeight - container.clientHeight;
    lastHeightRef.current = container.scrollHeight;

    requestAnimationFrame(() => {
      isProgrammaticScrollRef.current = false;
    });
  }, []);

  // Track scroll position - only user scrolls affect auto-scroll state
  const handleScroll = useCallback(() => {
    if (isProgrammaticScrollRef.current) return;

    const container = contentRef.current;
    if (!container) return;

    const threshold = 100;
    const distanceFromBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight;
    shouldAutoScrollRef.current = distanceFromBottom < threshold;
  }, []);

  // Attach scroll listener to content container
  useEffect(() => {
    const container = contentRef.current;
    if (!container || !isExpanded) return;

    container.addEventListener("scroll", handleScroll);
    return () => {
      container.removeEventListener("scroll", handleScroll);
    };
  }, [handleScroll, isExpanded]);

  // Use ResizeObserver to auto-scroll when content height increases
  useEffect(() => {
    const container = contentRef.current;
    if (!container || !isExpanded || !isRunning) return;

    lastHeightRef.current = container.scrollHeight;

    const resizeObserver = new ResizeObserver(() => {
      const newHeight = container.scrollHeight;
      const heightIncreased = newHeight > lastHeightRef.current;

      if (heightIncreased && shouldAutoScrollRef.current) {
        scrollToBottom(container);
      } else {
        lastHeightRef.current = newHeight;
      }
    });

    // Observe the container's children for size changes
    for (const child of container.children) {
      resizeObserver.observe(child);
    }

    // Also observe container itself
    resizeObserver.observe(container);

    return () => {
      resizeObserver.disconnect();
    };
  }, [isExpanded, isRunning, scrollToBottom]);

  // Reset autoscroll when task starts running or expands
  useEffect(() => {
    if (isExpanded && isRunning) {
      shouldAutoScrollRef.current = true;
      const container = contentRef.current;
      if (container) {
        // Small delay to let content render
        requestAnimationFrame(() => {
          scrollToBottom(container);
        });
      }
    }
  }, [isExpanded, isRunning, scrollToBottom]);

  // Track if we've initiated loading from the effect
  const loadInitiatedRef = useRef(false);

  // Load agent content when expanded (for running tasks that auto-expand on mount)
  // This ensures we load the JSONL content immediately rather than waiting for user click
  useEffect(() => {
    if (!isExpanded || !agentId || !context) return;
    if (loadInitiatedRef.current) return;

    loadInitiatedRef.current = true;

    // Load the agent content from JSONL (will merge with any SSE content)
    const loadContent = async () => {
      setIsLoadingContent(true);
      try {
        await context.loadAgentContent(projectId, sessionId, agentId);
      } finally {
        setIsLoadingContent(false);
      }
    };

    loadContent();
  }, [isExpanded, agentId, context, projectId, sessionId]);

  // Store validation errors for inline warning display
  const [validationErrors, setValidationErrors] = useState<ZodError | null>(
    null,
  );

  // Validate result schema when enabled (debug feature)
  useEffect(() => {
    if (!result || !validationEnabled) {
      setValidationErrors(null);
      return;
    }

    const validation = validateToolResult("Task", result);
    if (!validation.valid && validation.errors) {
      setValidationErrors(validation.errors);
      reportValidationError("Task", validation.errors);
    } else {
      setValidationErrors(null);
    }
  }, [result, validationEnabled, reportValidationError]);

  // Determine if we should show the warning badge
  const showValidationWarning =
    validationEnabled && validationErrors !== null && !isToolIgnored("Task");

  // Handle expand with lazy-loading
  const handleExpand = async () => {
    // Always lazy-load agent content if we have an agentId but no live content
    // Note: result.content is just the summary text, not the full agent interaction
    // The full tool calls (Glob, Read, etc.) are in the agent's JSONL file
    const hasLiveContent =
      liveContent?.messages && liveContent.messages.length > 0;

    if (!isExpanded && agentId && context && !hasLiveContent) {
      // Need to lazy-load content - toggle expand first so user sees loading in expanded area
      setIsExpanded(true);
      setIsLoadingContent(true);
      try {
        await context.loadAgentContent(projectId, sessionId, agentId);
      } finally {
        setIsLoadingContent(false);
      }
    } else {
      setIsExpanded(!isExpanded);
    }
  };

  // Extract error message if this is an error state
  const errorInfo = isError ? extractErrorMessage(result) : null;

  // Determine status badge and styling
  const getStatusBadge = () => {
    if (isError) {
      // Use error label if available, otherwise generic "failed"
      const errorLabel = errorInfo?.label ?? "failed";
      return { class: "badge-error", text: errorLabel };
    }
    if (status === "aborted")
      return { class: "badge-warning", text: "interrupted" };
    if (status === "incomplete")
      return { class: "badge-warning", text: "result unavailable" };
    if (isRunning) return { class: "badge-running", text: "running" };
    if (result?.status === "completed")
      return { class: "badge-success", text: "completed" };
    if (result?.status === "failed")
      return { class: "badge-error", text: "failed" };
    return { class: "badge-pending", text: "pending" };
  };

  const statusBadge = getStatusBadge();

  return (
    <div
      className={`task-inline ${isExpanded ? "expanded" : "collapsed"} status-${statusBadge.text}`}
    >
      {/* Header row */}
      <div className={styles.headerRow}>
        <button
          type="button"
          className={`task-inline-header ${styles.expandButton}`}
          onClick={handleExpand}
        >
          <span className="task-expand-icon">{isExpanded ? "▼" : "▶"}</span>
          <span className="badge badge-info task-agent-type">
            {input.subagent_type}
          </span>
          <span className="task-inline-title">{input.description}</span>
          {input.model && (
            <span className="badge task-model">{input.model}</span>
          )}
          {isRunning && (
            <>
              <span className="task-spinner" role="status" aria-label="Running">
                <Spinner />
              </span>
              {liveContent?.contextUsage && (
                <span className="task-context-usage">
                  {liveContent.contextUsage.percentage.toFixed(0)}% context
                </span>
              )}
            </>
          )}
          {!isRunning && (
            <span className={`badge ${statusBadge.class}`}>
              {statusBadge.text}
            </span>
          )}
          {/* Show error summary in collapsed view */}
          {!isExpanded && errorInfo && (
            <span className="task-error-summary" title={errorInfo.raw}>
              {errorInfo.summary}
            </span>
          )}
          {result && !isError && (
            <span className="task-stats">
              {formatDuration(result.totalDurationMs ?? 0)} ·{" "}
              {(result.totalTokens ?? 0).toLocaleString()} tokens
            </span>
          )}
          {showValidationWarning && validationErrors && (
            <SchemaWarning toolName="Task" errors={validationErrors} />
          )}
        </button>
        {agentId && (
          <Link
            className={styles.openPage}
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

      {/* Loading indicator */}
      {isLoadingContent && (
        <div className="task-loading">
          <Spinner /> Loading agent content...
        </div>
      )}

      {/* Expanded content */}
      {isExpanded && (
        <div className="task-inline-content" ref={contentRef}>
          {/* Show error details if this is an error state */}
          {errorInfo && (
            <div className="task-error-details">
              <pre className="task-error-message">{errorInfo.raw}</pre>
            </div>
          )}
          {/* Show live nested content if available */}
          {!errorInfo && liveContent?.messages.length ? (
            <TaskNestedContent
              messages={liveContent.messages}
              isStreaming={isRunning}
            />
          ) : !errorInfo && result?.content?.length ? (
            // Fall back to result content blocks (original behavior)
            <div className="task-content">
              {result.content.map((block) => (
                <ContentBlockRenderer
                  key={
                    block.id ??
                    `${agentId}-${block.type}-${block.text?.slice(0, 20) ?? ""}`
                  }
                  block={block}
                  context={{
                    isStreaming: false,
                    theme: "dark",
                    projectPath,
                    thinkingExpanded,
                    toggleThinkingExpanded,
                  }}
                />
              ))}
            </div>
          ) : !errorInfo ? (
            <div className="task-empty">
              {isRunning ? "Waiting for agent activity..." : "No content"}
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

function TaskToolResult({
  result,
  isError,
}: {
  result: TaskResult;
  isError: boolean;
}) {
  const projectPath = useOptionalSessionMetadata()?.projectPath ?? null;
  const [isExpanded, setIsExpanded] = useState(true);
  const [thinkingExpanded, setThinkingExpanded] = useState(false);
  const toggleThinkingExpanded = useCallback(() => {
    setThinkingExpanded((prev) => !prev);
  }, []);

  if (isError) {
    return (
      <div className="task-error">
        {typeof result === "object" && "content" in result
          ? String(result.content)
          : "Task failed"}
      </div>
    );
  }

  if (!result) {
    return <div className="task-empty">No result</div>;
  }

  const statusClass =
    result.status === "completed"
      ? "badge-success"
      : result.status === "failed"
        ? "badge-error"
        : "badge-warning";

  return (
    <div className="task-result">
      <div className="task-result-header">
        <span className={`badge ${statusClass}`}>{result.status}</span>
        <span className="task-stats">
          {formatDuration(result.totalDurationMs ?? 0)} &middot;{" "}
          {(result.totalTokens ?? 0).toLocaleString()} tokens &middot;{" "}
          {result.totalToolUseCount ?? 0} tools
        </span>
        <button
          type="button"
          className="expand-button"
          onClick={() => setIsExpanded(!isExpanded)}
        >
          {isExpanded ? "Collapse" : "Expand"}
        </button>
      </div>
      {isExpanded && result.content && result.content.length > 0 && (
        <div className="task-content">
          {result.content.map((block, i) => (
            <ContentBlockRenderer
              key={`${result.agentId}-${i}`}
              block={block}
              context={{
                isStreaming: false,
                theme: "dark",
                projectPath,
                thinkingExpanded,
                toggleThinkingExpanded,
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export const taskRenderer = defineTool(toolDisplayContracts.Task, {
  tool: "Task",

  renderToolUse(input, _context) {
    return <TaskToolUse input={input} />;
  },

  renderToolResult(result, isError, _context) {
    return <TaskToolResult result={result} isError={isError} />;
  },

  getUseSummary(input) {
    return input.description ?? "Agent";
  },

  getResultSummary(result, isError) {
    if (isError) return "Error";
    const r = result;
    return r?.status
      ? `${r.status} (${r.totalToolUseCount} tools)`
      : "Complete";
  },

  // Use inline rendering to bypass standard tool row structure
  // This gives us full control over expand/collapse and nested content display
  renderInline(input, result, isError, status, context) {
    return (
      <TaskInline
        input={input}
        result={result}
        isError={isError}
        status={status}
        toolUseId={context.toolUseId}
      />
    );
  },
});
