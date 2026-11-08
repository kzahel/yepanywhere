import { toolDisplayContracts } from "./toolDisplayContracts";
import { defineTool } from "./defineTool";
import { useEffect, useState } from "react";
import type { ZodError } from "zod";
import { useSchemaValidationContext } from "../../../contexts/SchemaValidationContext";
import { validateToolResult } from "../../../lib/validateToolResult";
import { SchemaWarning } from "../../SchemaWarning";
import { AnsiText } from "../../ui/AnsiText";
import { Button } from "../../ui/Button";
import { FixedFontMathToggle } from "../../ui/FixedFontMathToggle";
import { InnerHtml } from "../../ui/InnerHtml";
import type { BashOutputInput, BashOutputResult } from "./types";

const MAX_LINES_COLLAPSED = 20;

/**
 * Format timestamp to relative time
 */
function formatTimestamp(timestamp: string): string {
  try {
    const date = new Date(timestamp);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffSec = Math.floor(diffMs / 1000);

    if (diffSec < 60) return `${diffSec}s ago`;
    if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
    return date.toLocaleTimeString();
  } catch {
    return timestamp;
  }
}

/**
 * Status indicator component
 */
function StatusIndicator({ status }: { status: string }) {
  const statusConfig = {
    running: { icon: "⟳", className: "status-running" },
    completed: { icon: "✓", className: "status-completed" },
    failed: { icon: "✗", className: "status-failed" },
  };

  const config = statusConfig[status as keyof typeof statusConfig] || {
    icon: "?",
    className: "",
  };

  return (
    <span className={`bashoutput-status ${config.className}`}>
      {config.icon} {status}
    </span>
  );
}

function renderFixedFontMathPanel(html: string, className = "code-block") {
  return (
    <div className={`${className} fixed-font-rendered-panel`}>
      {/* KaTeX output is trusted HTML from local rendering. */}
      <InnerHtml className="fixed-font-rendered__content" trustedHtml={html} />
    </div>
  );
}

/**
 * BashOutput tool use - shows bash_id being polled
 */
function BashOutputToolUse({ input }: { input: BashOutputInput }) {
  return (
    <div className="bashoutput-tool-use">
      <span className="bashoutput-label">Polling background shell</span>
      <code className="bashoutput-id">{input.bash_id}</code>
      {input.block !== undefined && (
        <span className="badge">
          {input.block ? "blocking" : "non-blocking"}
        </span>
      )}
    </div>
  );
}

/**
 * BashOutput tool result - shows async bash result
 */
function BashOutputToolResult({ result }: { result: BashOutputResult }) {
  const [isExpanded, setIsExpanded] = useState(false);
  const { enabled, reportValidationError, isToolIgnored } =
    useSchemaValidationContext();
  const [validationErrors, setValidationErrors] = useState<ZodError | null>(
    null,
  );

  useEffect(() => {
    if (enabled && result) {
      const validation = validateToolResult("BashOutput", result);
      if (!validation.valid && validation.errors) {
        setValidationErrors(validation.errors);
        reportValidationError("BashOutput", validation.errors);
      } else {
        setValidationErrors(null);
      }
    }
  }, [enabled, result, reportValidationError]);

  const showValidationWarning =
    enabled && validationErrors && !isToolIgnored("BashOutput");

  if (!result) {
    return <div className="bashoutput-empty">No output</div>;
  }

  const stdoutLines = result.stdout?.split("\n") || [];
  const stderrLines = result.stderr?.split("\n") || [];
  const totalLines = stdoutLines.length + stderrLines.length;
  const needsCollapse = totalLines > MAX_LINES_COLLAPSED;

  const displayStdout =
    needsCollapse && !isExpanded
      ? stdoutLines.slice(0, MAX_LINES_COLLAPSED)
      : stdoutLines;

  return (
    <div className="bashoutput-result">
      <div className="bashoutput-header">
        <StatusIndicator status={result.status} />
        {result.command && (
          <code className="bashoutput-command">{result.command}</code>
        )}
        {result.exitCode !== null && (
          <span
            className={`badge ${result.exitCode === 0 ? "badge-success" : "badge-error"}`}
          >
            exit {result.exitCode}
          </span>
        )}
        {result.timestamp && (
          <span className="bashoutput-timestamp">
            {formatTimestamp(result.timestamp)}
          </span>
        )}
        {showValidationWarning && validationErrors && (
          <SchemaWarning toolName="BashOutput" errors={validationErrors} />
        )}
      </div>
      {(result.stdout || result.stderr) && (
        <>
          {result.stdout && (
            <FixedFontMathToggle
              sourceText={displayStdout.join("\n")}
              sourceView={
                <pre className="bash-stdout code-block">
                  <AnsiText text={displayStdout.join("\n")} />
                </pre>
              }
              renderRenderedView={(html) =>
                renderFixedFontMathPanel(html, "bash-stdout code-block")
              }
            />
          )}
          {result.stderr && (
            <FixedFontMathToggle
              sourceText={result.stderr}
              sourceView={
                <pre className="bash-stderr code-block">
                  <AnsiText text={result.stderr} />
                </pre>
              }
              renderRenderedView={(html) =>
                renderFixedFontMathPanel(html, "bash-stderr code-block")
              }
            />
          )}
          {needsCollapse && (
            <Button
              variant="ghost"
              size="small"
              className="expand-button"
              onClick={() => setIsExpanded(!isExpanded)}
            >
              {isExpanded ? "Show less" : `Show all ${totalLines} lines`}
            </Button>
          )}
        </>
      )}
    </div>
  );
}

export const bashOutputRenderer = defineTool(toolDisplayContracts.BashOutput, {
  tool: "BashOutput",

  renderToolUse(input, _context) {
    return <BashOutputToolUse input={input} />;
  },

  renderToolResult(result, _isError, _context) {
    return <BashOutputToolResult result={result} />;
  },

  renderFailure(failure) {
    return (
      <div className="bashoutput-error">
        {failure.content || "Failed to get bash output"}
      </div>
    );
  },

  getFailureSummary() {
    return "Error";
  },

  getUseSummary(input) {
    return input.bash_id;
  },

  getResultSummary(result) {
    const r = result;
    if (!r) return "Pending";
    if (r.status === "running") return "Running...";
    if (r.exitCode !== null) return `exit ${r.exitCode}`;
    return r.status;
  },
});
