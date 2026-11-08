import { toolDisplayContracts } from "./toolDisplayContracts";
import { defineTool } from "./defineTool";
import { useEffect, useState } from "react";
import type { ZodError } from "zod";
import { useSchemaValidationContext } from "../../../contexts/SchemaValidationContext";
import { validateToolResult } from "../../../lib/validateToolResult";
import { SchemaWarning } from "../../SchemaWarning";
import { Button } from "../../ui/Button";
import type { TaskOutputInput, TaskOutputResult } from "./types";

const MAX_LINES_COLLAPSED = 20;

/**
 * Status indicator component
 */
function StatusIndicator({ status }: { status: string }) {
  const statusConfig = {
    running: { icon: "⟳", className: "status-running" },
    completed: { icon: "✓", className: "status-completed" },
    failed: { icon: "✗", className: "status-failed" },
    timeout: { icon: "⏱", className: "status-timeout" },
  };

  const config = statusConfig[status as keyof typeof statusConfig] || {
    icon: "?",
    className: "",
  };

  return (
    <span className={`taskoutput-status ${config.className}`}>
      {config.icon} {status}
    </span>
  );
}

/**
 * TaskOutput tool use - shows task_id being polled
 */
function TaskOutputToolUse({ input }: { input: TaskOutputInput }) {
  return (
    <div className="taskoutput-tool-use">
      <span className="taskoutput-label">Polling task</span>
      <code className="taskoutput-id">{input.task_id}</code>
      {input.block !== undefined && (
        <span className="badge">
          {input.block ? "blocking" : "non-blocking"}
        </span>
      )}
      {input.timeout !== undefined && (
        <span className="badge">timeout: {input.timeout}ms</span>
      )}
    </div>
  );
}

/**
 * TaskOutput tool result - shows async task result
 */
function TaskOutputToolResult({ result }: { result: TaskOutputResult }) {
  const [isExpanded, setIsExpanded] = useState(false);
  const { enabled, reportValidationError, isToolIgnored } =
    useSchemaValidationContext();
  const [validationErrors, setValidationErrors] = useState<ZodError | null>(
    null,
  );

  useEffect(() => {
    if (enabled && result) {
      const validation = validateToolResult("TaskOutput", result);
      if (!validation.valid && validation.errors) {
        setValidationErrors(validation.errors);
        reportValidationError("TaskOutput", validation.errors);
      } else {
        setValidationErrors(null);
      }
    }
  }, [enabled, result, reportValidationError]);

  const showValidationWarning =
    enabled && validationErrors && !isToolIgnored("TaskOutput");

  if (!result) {
    return <div className="taskoutput-empty">No output</div>;
  }

  const task = result.task;
  const outputLines = task?.output?.split("\n") || [];
  const needsCollapse = outputLines.length > MAX_LINES_COLLAPSED;
  const displayLines =
    needsCollapse && !isExpanded
      ? outputLines.slice(0, MAX_LINES_COLLAPSED)
      : outputLines;

  return (
    <div className="taskoutput-result">
      <div className="taskoutput-header">
        <StatusIndicator status={result.retrieval_status} />
        {task?.task_type && (
          <span className="badge badge-info">{task.task_type}</span>
        )}
        {task?.description && (
          <span className="taskoutput-desc">{task.description}</span>
        )}
        {showValidationWarning && validationErrors && (
          <SchemaWarning toolName="TaskOutput" errors={validationErrors} />
        )}
      </div>
      {task && (
        <div className="taskoutput-task">
          <div className="taskoutput-task-status">
            {task.status && <StatusIndicator status={task.status} />}
            {task.exitCode != null && (
              <span
                className={`badge ${task.exitCode === 0 ? "badge-success" : "badge-error"}`}
              >
                exit {task.exitCode}
              </span>
            )}
          </div>
          {task.output && (
            <>
              <pre className="taskoutput-content code-block">
                <code>{displayLines.join("\n")}</code>
              </pre>
              {needsCollapse && (
                <Button
                  variant="ghost"
                  size="small"
                  className="expand-button"
                  onClick={() => setIsExpanded(!isExpanded)}
                >
                  {isExpanded
                    ? "Show less"
                    : `Show all ${outputLines.length} lines`}
                </Button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

export const taskOutputRenderer = defineTool(toolDisplayContracts.TaskOutput, {
  tool: "TaskOutput",

  renderToolUse(input, _context) {
    return <TaskOutputToolUse input={input} />;
  },

  renderToolResult(result, _isError, _context) {
    return <TaskOutputToolResult result={result} />;
  },

  renderFailure(failure) {
    return (
      <div className="taskoutput-error">
        {failure.content || "Failed to get task output"}
      </div>
    );
  },

  getFailureSummary() {
    return "Error";
  },

  getUseSummary(input) {
    return input.task_id;
  },

  getResultSummary(result) {
    const r = result;
    if (!r) return "Pending";
    return r.retrieval_status;
  },
});
