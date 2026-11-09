import { toolDisplayContracts } from "./toolDisplayContracts";
import { defineTool } from "./defineTool";
import { useEffect, useState } from "react";
import type { ZodError } from "zod";
import { useSchemaValidationContext } from "../../../contexts/SchemaValidationContext";
import { validateToolResult } from "../../../lib/validateToolResult";
import { SchemaWarning } from "../../SchemaWarning";
import { Badge } from "../../ui/Badge";
import { Button } from "../../ui/Button";
import type { WebFetchInput, WebFetchResult } from "./types";

const MAX_CONTENT_LINES = 30;

/**
 * Format bytes to human readable
 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}\u202fb`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}\u202fkb`;
  return `${Math.round((bytes / (1024 * 1024)) * 10) / 10}\u202fmb`;
}

/**
 * WebFetch tool use - shows URL and prompt
 */
function WebFetchToolUse({ input }: { input: WebFetchInput }) {
  return (
    <div className="webfetch-tool-use">
      <a
        href={input.url}
        target="_blank"
        rel="noopener noreferrer"
        className="webfetch-url"
      >
        {input.url}
      </a>
      {input.prompt && <div className="webfetch-prompt">{input.prompt}</div>}
    </div>
  );
}

/**
 * WebFetch tool result - shows fetched content
 */
function WebFetchToolResult({ result }: { result: WebFetchResult }) {
  const [isExpanded, setIsExpanded] = useState(false);
  const { enabled, reportValidationError, isToolIgnored } =
    useSchemaValidationContext();
  const [validationErrors, setValidationErrors] = useState<ZodError | null>(
    null,
  );

  useEffect(() => {
    if (enabled && result) {
      const validation = validateToolResult("WebFetch", result);
      if (!validation.valid && validation.errors) {
        setValidationErrors(validation.errors);
        reportValidationError("WebFetch", validation.errors);
      } else {
        setValidationErrors(null);
      }
    }
  }, [enabled, result, reportValidationError]);

  const showValidationWarning =
    enabled && validationErrors && !isToolIgnored("WebFetch");

  if (!result) {
    return <div className="webfetch-empty">No content</div>;
  }

  const lines = result.result?.split("\n") || [];
  const needsCollapse = lines.length > MAX_CONTENT_LINES;
  const displayLines =
    needsCollapse && !isExpanded ? lines.slice(0, MAX_CONTENT_LINES) : lines;

  const statusTone =
    result.code >= 200 && result.code < 300
      ? "success"
      : result.code >= 400
        ? "danger"
        : "warning";

  return (
    <div className="webfetch-result">
      <div className="webfetch-header">
        <a
          href={result.url}
          target="_blank"
          rel="noopener noreferrer"
          className="webfetch-url"
        >
          {result.url}
        </a>
        <Badge tone={statusTone} size="small">
          {result.code} {result.codeText}
        </Badge>
        <span className="webfetch-meta">
          {formatBytes(result.bytes)} &middot; {result.durationMs}ms
        </span>
        {showValidationWarning && validationErrors && (
          <SchemaWarning toolName="WebFetch" errors={validationErrors} />
        )}
      </div>
      {result.result && (
        <>
          <pre className="webfetch-content code-block">
            <code>{displayLines.join("\n")}</code>
          </pre>
          {needsCollapse && (
            <Button
              variant="ghost"
              size="small"
              className="expand-button"
              onClick={() => setIsExpanded(!isExpanded)}
            >
              {isExpanded ? "Show less" : `Show all ${lines.length} lines`}
            </Button>
          )}
        </>
      )}
    </div>
  );
}

export const webFetchRenderer = defineTool(toolDisplayContracts.WebFetch, {
  tool: "WebFetch",

  renderToolUse(input, _context) {
    return <WebFetchToolUse input={input} />;
  },

  renderToolResult(result, _isError, _context) {
    return <WebFetchToolResult result={result} />;
  },

  renderFailure(failure) {
    return (
      <div className="webfetch-error">{failure.content || "Fetch failed"}</div>
    );
  },

  getFailureSummary() {
    return "Error";
  },

  getUseSummary(input) {
    const url = input.url;
    try {
      return new URL(url).hostname;
    } catch {
      return url;
    }
  },

  getResultSummary(result) {
    const r = result;
    return r?.code ? `${r.code} ${r.codeText}` : "Fetched";
  },
});
