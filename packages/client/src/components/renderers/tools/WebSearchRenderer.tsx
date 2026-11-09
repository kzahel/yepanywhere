import { toolDisplayContracts } from "./toolDisplayContracts";
import { defineTool } from "./defineTool";
import { useEffect, useState } from "react";
import type { ZodError } from "zod";
import { useSchemaValidationContext } from "../../../contexts/SchemaValidationContext";
import { validateToolResult } from "../../../lib/validateToolResult";
import { SchemaWarning } from "../../SchemaWarning";
import { Badge } from "../../ui/Badge";
import type { WebSearchInput, WebSearchResult } from "./types";

/**
 * WebSearch tool use - shows search query
 */
function WebSearchToolUse({ input }: { input: WebSearchInput }) {
  return (
    <div className="websearch-tool-use">
      <span className="websearch-query">{input.query}</span>
    </div>
  );
}

/**
 * WebSearch tool result - shows search results as links
 */
function WebSearchToolResult({ result }: { result: WebSearchResult }) {
  const { enabled, reportValidationError, isToolIgnored } =
    useSchemaValidationContext();
  const [validationErrors, setValidationErrors] = useState<ZodError | null>(
    null,
  );

  useEffect(() => {
    if (enabled && result) {
      const validation = validateToolResult("WebSearch", result);
      if (!validation.valid && validation.errors) {
        setValidationErrors(validation.errors);
        reportValidationError("WebSearch", validation.errors);
      } else {
        setValidationErrors(null);
      }
    }
  }, [enabled, result, reportValidationError]);

  const showValidationWarning =
    enabled && validationErrors && !isToolIgnored("WebSearch");

  if (!result) {
    return <div className="websearch-empty">No results</div>;
  }

  // Flatten results from potentially nested structure
  const allResults =
    result.results
      ?.flatMap((r) => (typeof r === "string" ? [] : r.content))
      .filter(Boolean) || [];

  return (
    <div className="websearch-result">
      <div className="websearch-header">
        <span className="websearch-query-display">"{result.query}"</span>
        {result.durationSeconds !== undefined && (
          <Badge size="small">{result.durationSeconds.toFixed(2)}s</Badge>
        )}
        {showValidationWarning && validationErrors && (
          <SchemaWarning toolName="WebSearch" errors={validationErrors} />
        )}
      </div>
      {allResults.length > 0 ? (
        <ul className="websearch-links">
          {allResults.map((item, i) => (
            <li key={`${item.url}-${i}`} className="websearch-link-item">
              <a
                href={item.url}
                target="_blank"
                rel="noopener noreferrer"
                className="websearch-link"
              >
                {item.title}
              </a>
              <span className="websearch-url">{item.url}</span>
            </li>
          ))}
        </ul>
      ) : (
        <div className="websearch-empty">No results found</div>
      )}
    </div>
  );
}

export const webSearchRenderer = defineTool(toolDisplayContracts.WebSearch, {
  tool: "WebSearch",

  renderToolUse(input, _context) {
    return <WebSearchToolUse input={input} />;
  },

  renderToolResult(result, _isError, _context) {
    return <WebSearchToolResult result={result} />;
  },

  renderFailure(failure) {
    return (
      <div className="websearch-error">
        {failure.content || "Search failed"}
      </div>
    );
  },

  getFailureSummary() {
    return "Error";
  },

  getUseSummary(input) {
    return input.query;
  },

  getResultSummary(result) {
    const r = result;
    const count =
      r?.results?.flatMap((res) => (typeof res === "string" ? [] : res.content))
        .length || 0;
    return `${count} results`;
  },
});
