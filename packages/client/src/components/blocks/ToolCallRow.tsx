import { memo, useMemo, useState } from "react";
import type { ToolResultData } from "../../types/renderItems";
import { toolRegistry } from "../renderers/tools";
import type { RenderContext } from "../renderers/types";
import { getToolSummary } from "../tools/summaries";

interface Props {
  id: string;
  toolName: string;
  toolInput: unknown;
  toolResult?: ToolResultData;
  status: "pending" | "complete" | "error" | "aborted";
}

export const ToolCallRow = memo(function ToolCallRow({
  id,
  toolName,
  toolInput,
  toolResult,
  status,
}: Props) {
  // Edit and TodoWrite tools are expanded by default
  const [expanded, setExpanded] = useState(
    toolName === "Edit" || toolName === "TodoWrite",
  );

  const summary = useMemo(() => {
    return getToolSummary(toolName, toolInput, toolResult, status);
  }, [toolName, toolInput, toolResult, status]);

  const handleToggle = () => {
    setExpanded(!expanded);
  };

  // Create a minimal render context for tool renderers
  const renderContext: RenderContext = useMemo(
    () => ({
      isStreaming: status === "pending",
      theme: "dark",
    }),
    [status],
  );

  return (
    <div
      className={`tool-row timeline-item ${expanded ? "expanded" : "collapsed"} status-${status}`}
    >
      <button type="button" className="tool-row-header" onClick={handleToggle}>
        {status === "pending" && (
          <span className="tool-spinner" aria-label="Running">
            <Spinner />
          </span>
        )}
        {status === "aborted" && (
          <span className="tool-aborted-icon" aria-label="Interrupted">
            ⨯
          </span>
        )}

        <span className="tool-name">{toolName}</span>
        <span className="tool-summary">
          {summary}
          {status === "aborted" && (
            <span className="tool-aborted-label"> (interrupted)</span>
          )}
        </span>

        <span className="expand-chevron" aria-hidden="true">
          {expanded ? "▾" : "▸"}
        </span>
      </button>

      {expanded && (
        <div className="tool-row-content">
          {status === "pending" || status === "aborted" ? (
            <ToolUseExpanded
              toolName={toolName}
              toolInput={toolInput}
              context={renderContext}
            />
          ) : (
            <ToolResultExpanded
              toolName={toolName}
              toolResult={toolResult}
              context={renderContext}
            />
          )}
        </div>
      )}
    </div>
  );
});

function ToolUseExpanded({
  toolName,
  toolInput,
  context,
}: {
  toolName: string;
  toolInput: unknown;
  context: RenderContext;
}) {
  return (
    <div className="tool-use-expanded">
      {toolRegistry.renderToolUse(toolName, toolInput, context)}
    </div>
  );
}

function ToolResultExpanded({
  toolName,
  toolResult,
  context,
}: {
  toolName: string;
  toolResult: ToolResultData | undefined;
  context: RenderContext;
}) {
  if (!toolResult) {
    return <div className="tool-no-result">No result data</div>;
  }

  // Use structured result if available, otherwise fall back to content
  const result = toolResult.structured ?? toolResult.content;

  return (
    <div className="tool-result-expanded">
      {toolRegistry.renderToolResult(
        toolName,
        result,
        toolResult.isError,
        context,
      )}
    </div>
  );
}

function Spinner() {
  return (
    <svg
      className="spinner"
      viewBox="0 0 16 16"
      width="12"
      height="12"
      aria-hidden="true"
    >
      <circle
        cx="8"
        cy="8"
        r="6"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeDasharray="24"
        strokeDashoffset="8"
      />
    </svg>
  );
}
