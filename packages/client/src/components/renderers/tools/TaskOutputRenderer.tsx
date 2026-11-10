import statusStyles from "../OutputStatus.module.css";
import codeStyles from "../CodeOutput.module.css";
import expandStyles from "../ExpandOutput.module.css";
import styles from "./TaskOutputRenderer.module.css";
import { toolDisplayContracts } from "./toolDisplayContracts";
import { defineTool } from "./defineTool";
import { useEffect, useState } from "react";
import type { ZodError } from "zod";
import { useSchemaValidationContext } from "../../../contexts/SchemaValidationContext";
import { validateToolResult } from "../../../lib/validateToolResult";
import { SchemaWarning } from "../../SchemaWarning";
import { Badge } from "../../ui/Badge";
import { Button } from "../../ui/Button";
import type { TaskOutputInput, TaskOutputResult } from "./types";

const MAX_LINES_COLLAPSED = 20;

/**
 * Status indicator component
 */
function StatusIndicator({ status }: { status: string }) {
  const statusConfig = {
    running: { icon: "⟳", className: statusStyles.statusRunning },
    completed: { icon: "✓", className: statusStyles.statusCompleted },
    failed: { icon: "✗", className: statusStyles.statusFailed },
    timeout: { icon: "⏱", className: statusStyles.statusTimeout },
  };

  const config = statusConfig[status as keyof typeof statusConfig] || {
    icon: "?",
    className: "",
  };

  return (
    <span
      className={`${styles.taskoutputStatus} ${config.className}`}
      data-taskoutput-status
      data-tool-status={status}
    >
      {config.icon} {status}
    </span>
  );
}

/**
 * TaskOutput tool use - shows task_id being polled
 */
function TaskOutputToolUse({ input }: { input: TaskOutputInput }) {
  return (
    <div className={styles.taskoutputToolUse} data-taskoutput-tool-use>
      <span className={styles.taskoutputLabel} data-taskoutput-label>
        Polling task
      </span>
      <code className={styles.taskoutputId} data-taskoutput-id>
        {input.task_id}
      </code>
      {input.block !== undefined && (
        <Badge size="small">{input.block ? "blocking" : "non-blocking"}</Badge>
      )}
      {input.timeout !== undefined && (
        <Badge size="small">timeout: {input.timeout}ms</Badge>
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
    return (
      <div className={styles.taskoutputEmpty} data-taskoutput-empty>
        No output
      </div>
    );
  }

  const task = result.task;
  const outputLines = task?.output?.split("\n") || [];
  const needsCollapse = outputLines.length > MAX_LINES_COLLAPSED;
  const displayLines =
    needsCollapse && !isExpanded
      ? outputLines.slice(0, MAX_LINES_COLLAPSED)
      : outputLines;

  return (
    <div className={styles.taskoutputResult} data-taskoutput-result>
      <div className={styles.taskoutputHeader} data-taskoutput-header>
        <StatusIndicator status={result.retrieval_status} />
        {task?.task_type && (
          <Badge tone="info" size="small">
            {task.task_type}
          </Badge>
        )}
        {task?.description && (
          <span className={styles.taskoutputDesc} data-taskoutput-desc>
            {task.description}
          </span>
        )}
        {showValidationWarning && validationErrors && (
          <SchemaWarning toolName="TaskOutput" errors={validationErrors} />
        )}
      </div>
      {task && (
        <div className={styles.taskoutputTask} data-taskoutput-task>
          <div
            className={styles.taskoutputTaskStatus}
            data-taskoutput-task-status
          >
            {task.status && <StatusIndicator status={task.status} />}
            {task.exitCode != null && (
              <Badge
                tone={task.exitCode === 0 ? "success" : "danger"}
                size="small"
              >
                exit {task.exitCode}
              </Badge>
            )}
          </div>
          {task.output && (
            <>
              <pre
                className={`${styles.taskoutputContent} ${codeStyles.codeBlock}`}
                data-taskoutput-content
                data-code-block
              >
                <code>{displayLines.join("\n")}</code>
              </pre>
              {needsCollapse && (
                <Button
                  variant="ghost"
                  size="small"
                  className={expandStyles.expandButton}
                  data-expand-button
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
      <div className={styles.taskoutputError} data-taskoutput-error>
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
