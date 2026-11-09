import { toolDisplayContracts } from "./toolDisplayContracts";
import { defineTool } from "./defineTool";
import { useEffect, useState } from "react";
import type { ZodError } from "zod";
import { useSchemaValidationContext } from "../../../contexts/SchemaValidationContext";
import { getPathBasename, makeDisplayPath } from "../../../lib/text";
import { validateToolResult } from "../../../lib/validateToolResult";
import { SchemaWarning } from "../../SchemaWarning";
import { Badge } from "../../ui/Badge";
import { Button } from "../../ui/Button";
import styles from "./GlobRenderer.module.css";
import type { GlobInput, GlobResult } from "./types";

const MAX_FILES_COLLAPSED = 20;

/**
 * Extract filename from path
 */
function getFileName(filePath: string): string {
  return getPathBasename(filePath);
}

/**
 * Glob tool use - shows pattern being searched
 */
function GlobToolUse({
  input,
  projectPath,
}: {
  input: GlobInput;
  projectPath?: string | null;
}) {
  return (
    <div className={styles.toolUse}>
      <span className={styles.pattern}>{input.pattern}</span>
      {input.path && (
        <span className={styles.path}>
          in {makeDisplayPath(input.path, projectPath)}
        </span>
      )}
    </div>
  );
}

/**
 * Glob tool result - shows list of matching files
 */
function GlobToolResult({
  result,
  projectPath,
}: {
  result: GlobResult;
  projectPath?: string | null;
}) {
  const [isExpanded, setIsExpanded] = useState(false);
  const { enabled, reportValidationError, isToolIgnored } =
    useSchemaValidationContext();
  const [validationErrors, setValidationErrors] = useState<ZodError | null>(
    null,
  );

  useEffect(() => {
    if (enabled && result) {
      const validation = validateToolResult("Glob", result);
      if (!validation.valid && validation.errors) {
        setValidationErrors(validation.errors);
        reportValidationError("Glob", validation.errors);
      } else {
        setValidationErrors(null);
      }
    }
  }, [enabled, result, reportValidationError]);

  const showValidationWarning =
    enabled && validationErrors && !isToolIgnored("Glob");

  if (!result?.filenames || result.filenames.length === 0) {
    return (
      <div className={styles.empty}>
        {showValidationWarning && validationErrors && (
          <SchemaWarning toolName="Glob" errors={validationErrors} />
        )}
        No files found
      </div>
    );
  }

  const { filenames, numFiles, truncated } = result;
  const needsCollapse = filenames.length > MAX_FILES_COLLAPSED;
  const displayFiles =
    needsCollapse && !isExpanded
      ? filenames.slice(0, MAX_FILES_COLLAPSED)
      : filenames;

  return (
    <div className={styles.result}>
      <div className={styles.header}>
        <span className={styles.count}>{numFiles} files</span>
        {truncated && (
          <Badge tone="warning" size="small">
            truncated
          </Badge>
        )}
        {showValidationWarning && validationErrors && (
          <SchemaWarning toolName="Glob" errors={validationErrors} />
        )}
      </div>
      <div className="file-list">
        {displayFiles.map((file) => (
          <div key={file} className="file-list-item">
            <span className="file-path">
              {getFileName(makeDisplayPath(file, projectPath))}
            </span>
            <span className="file-dir">
              {makeDisplayPath(file, projectPath)}
            </span>
          </div>
        ))}
        {needsCollapse && !isExpanded && (
          <div className="file-list-more">
            ... and {filenames.length - MAX_FILES_COLLAPSED} more
          </div>
        )}
      </div>
      {needsCollapse && (
        <Button
          variant="ghost"
          size="small"
          className="expand-button"
          onClick={() => setIsExpanded(!isExpanded)}
        >
          {isExpanded ? "Show less" : `Show all ${filenames.length} files`}
        </Button>
      )}
    </div>
  );
}

export const globRenderer = defineTool(toolDisplayContracts.Glob, {
  tool: "Glob",
  displayName: "List",

  renderToolUse(input, context) {
    return <GlobToolUse input={input} projectPath={context.projectPath} />;
  },

  renderToolResult(result, _isError, context) {
    return <GlobToolResult result={result} projectPath={context.projectPath} />;
  },

  renderFailure(failure) {
    return (
      <div className={styles.error}>
        {failure.content || "Glob search failed"}
      </div>
    );
  },

  getFailureSummary() {
    return "Error";
  },

  getUseSummary(input, context) {
    const globInput = input;
    const pattern = `pattern: "${globInput.pattern}"`;
    return globInput.path
      ? `${pattern} in ${makeDisplayPath(globInput.path, context?.projectPath)}`
      : pattern;
  },

  getResultSummary(result) {
    const r = result;
    if (r?.numFiles === undefined) return "Searching...";
    if (r.numFiles === 0) return "No files found";
    return `Found ${r.numFiles} files`;
  },
});
