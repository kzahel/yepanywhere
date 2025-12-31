import { useState } from "react";
import type { GrepInput, GrepResult, ToolRenderer } from "./types";

const MAX_FILES_COLLAPSED = 20;
const MAX_LINES_COLLAPSED = 30;

/**
 * Extract filename from path
 */
function getFileName(filePath: string): string {
  return filePath.split("/").pop() || filePath;
}

/**
 * Grep tool use - shows search pattern
 */
function GrepToolUse({ input }: { input: GrepInput }) {
  return (
    <div className="grep-tool-use">
      <span className="grep-pattern">{input.pattern}</span>
      {input.glob && <span className="grep-glob">({input.glob})</span>}
      {input.path && <span className="grep-path">in {input.path}</span>}
    </div>
  );
}

/**
 * File list view (for files_with_matches mode)
 */
function FileListView({
  filenames,
  isExpanded,
  setIsExpanded,
}: {
  filenames: string[];
  isExpanded: boolean;
  setIsExpanded: (expanded: boolean) => void;
}) {
  const needsCollapse = filenames.length > MAX_FILES_COLLAPSED;
  const displayFiles =
    needsCollapse && !isExpanded
      ? filenames.slice(0, MAX_FILES_COLLAPSED)
      : filenames;

  return (
    <>
      <div className="file-list">
        {displayFiles.map((file) => (
          <div key={file} className="file-list-item">
            <span className="file-path">{getFileName(file)}</span>
            <span className="file-dir">{file}</span>
          </div>
        ))}
        {needsCollapse && !isExpanded && (
          <div className="file-list-more">
            ... and {filenames.length - MAX_FILES_COLLAPSED} more
          </div>
        )}
      </div>
      {needsCollapse && (
        <button
          type="button"
          className="expand-button"
          onClick={() => setIsExpanded(!isExpanded)}
        >
          {isExpanded ? "Show less" : `Show all ${filenames.length} files`}
        </button>
      )}
    </>
  );
}

/**
 * Content view (for content mode)
 */
function ContentView({
  content,
  isExpanded,
  setIsExpanded,
}: {
  content: string;
  isExpanded: boolean;
  setIsExpanded: (expanded: boolean) => void;
}) {
  const lines = content.split("\n");
  const needsCollapse = lines.length > MAX_LINES_COLLAPSED;
  const displayLines =
    needsCollapse && !isExpanded ? lines.slice(0, MAX_LINES_COLLAPSED) : lines;

  return (
    <>
      <pre className="grep-content code-block">
        <code>{displayLines.join("\n")}</code>
      </pre>
      {needsCollapse && (
        <button
          type="button"
          className="expand-button"
          onClick={() => setIsExpanded(!isExpanded)}
        >
          {isExpanded ? "Show less" : `Show all ${lines.length} lines`}
        </button>
      )}
    </>
  );
}

/**
 * Grep tool result - shows search results based on mode
 */
function GrepToolResult({
  result,
  isError,
}: {
  result: GrepResult;
  isError: boolean;
}) {
  const [isExpanded, setIsExpanded] = useState(false);

  if (isError) {
    const errorResult = result as unknown as { content?: unknown } | undefined;
    return (
      <div className="grep-error">
        {typeof result === "object" && errorResult?.content
          ? String(errorResult.content)
          : "Search failed"}
      </div>
    );
  }

  if (!result) {
    return <div className="grep-empty">No results</div>;
  }

  const { mode, filenames, numFiles, content, appliedLimit } = result;

  // Count mode - just show summary
  if (mode === "count") {
    return (
      <div className="grep-result">
        <div className="grep-count-summary">
          {numFiles} {numFiles === 1 ? "file" : "files"} matched
        </div>
      </div>
    );
  }

  // Content mode - show search results
  if (mode === "content" && content) {
    // Count actual match lines (lines with : after the line number indicate matches)
    const lines = content.split("\n");
    const matchCount = lines.filter((line) => /^\d+:/.test(line)).length;

    return (
      <div className="grep-result">
        <div className="grep-header">
          <span className="grep-count">
            {matchCount} {matchCount === 1 ? "match" : "matches"}
          </span>
          {appliedLimit && (
            <span className="badge badge-info">limit: {appliedLimit}</span>
          )}
        </div>
        <ContentView
          content={content}
          isExpanded={isExpanded}
          setIsExpanded={setIsExpanded}
        />
      </div>
    );
  }

  // files_with_matches mode (default) - show file list
  if (!filenames || filenames.length === 0) {
    return <div className="grep-empty">No matches found</div>;
  }

  return (
    <div className="grep-result">
      <div className="grep-header">
        <span className="grep-count">{numFiles} files</span>
      </div>
      <FileListView
        filenames={filenames}
        isExpanded={isExpanded}
        setIsExpanded={setIsExpanded}
      />
    </div>
  );
}

export const grepRenderer: ToolRenderer<GrepInput, GrepResult> = {
  tool: "Grep",

  renderToolUse(input, _context) {
    return <GrepToolUse input={input as GrepInput} />;
  },

  renderToolResult(result, isError, _context) {
    return <GrepToolResult result={result as GrepResult} isError={isError} />;
  },

  getUseSummary(input) {
    return (input as GrepInput).pattern;
  },

  getResultSummary(result, isError) {
    if (isError) return "Error";
    const r = result as GrepResult;
    if (!r) return "Results";

    // For content mode, count actual matches
    if (r.mode === "content" && r.content) {
      const matchCount = r.content
        .split("\n")
        .filter((line) => /^\d+:/.test(line)).length;
      return `${matchCount} ${matchCount === 1 ? "match" : "matches"}`;
    }

    return r.numFiles !== undefined ? `${r.numFiles} files` : "Results";
  },
};
