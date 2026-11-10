import styles from "./WebSearchRenderer.module.css";
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
    <div className={styles.websearchToolUse} data-websearch-tool-use>
      <span className={styles.websearchQuery} data-websearch-query>
        {input.query}
      </span>
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
    return (
      <div className={styles.websearchEmpty} data-websearch-empty>
        No results
      </div>
    );
  }

  // Flatten results from potentially nested structure
  const allResults =
    result.results
      ?.flatMap((r) => (typeof r === "string" ? [] : r.content))
      .filter(Boolean) || [];

  return (
    <div className={styles.websearchResult} data-websearch-result>
      <div className={styles.websearchHeader} data-websearch-header>
        <span
          className={styles.websearchQueryDisplay}
          data-websearch-query-display
        >
          "{result.query}"
        </span>
        {result.durationSeconds !== undefined && (
          <Badge size="small">{result.durationSeconds.toFixed(2)}s</Badge>
        )}
        {showValidationWarning && validationErrors && (
          <SchemaWarning toolName="WebSearch" errors={validationErrors} />
        )}
      </div>
      {allResults.length > 0 ? (
        <ul className={styles.websearchLinks} data-websearch-links>
          {allResults.map((item, i) => (
            <li
              key={`${item.url}-${i}`}
              className={styles.websearchLinkItem}
              data-websearch-link-item
            >
              <a
                href={item.url}
                target="_blank"
                rel="noopener noreferrer"
                className={styles.websearchLink}
                data-websearch-link
              >
                {item.title}
              </a>
              <span className={styles.websearchUrl} data-websearch-url>
                {item.url}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <div className={styles.websearchEmpty} data-websearch-empty>
          No results found
        </div>
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
      <div className={styles.websearchError} data-websearch-error>
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
