import codeStyles from "../CodeOutput.module.css";
import expandStyles from "../ExpandOutput.module.css";
import globStyles from "./GlobRenderer.module.css";
import { toolDisplayContracts } from "./toolDisplayContracts";
import { defineTool } from "./defineTool";
import {
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ZodError } from "zod";
import { useSchemaValidationContext } from "../../../contexts/SchemaValidationContext";
import { useOutputToolPreviewLineCount } from "../../../hooks/useOutputAppearance";
import { useQuoteableTextSource } from "../../../hooks/useQuoteableTextSource";
import { getPathBasename, makeDisplayPath } from "../../../lib/text";
import { validateToolResult } from "../../../lib/validateToolResult";
import { ActivityDetailModal } from "../../ActivityDetailModal";
import { SchemaWarning } from "../../SchemaWarning";
import { SessionFilePathLink } from "../../SessionFilePathLink";
import { Badge } from "../../ui/Badge";
import { Button, ButtonBase } from "../../ui/Button";
import styles from "./GrepRenderer.module.css";
import type { GrepInput, GrepMatch, GrepResult } from "./types";

const MAX_FILES_COLLAPSED = 20;
const MAX_LINES_COLLAPSED = 30;
const GREP_PATTERN_ELLIPSIS = "...";
const GREP_SUMMARY_SCOPE_GAP_PX = 12;

function countGrepMatches(content: string | undefined): number {
  if (!content) {
    return 0;
  }
  return content.split("\n").filter((line) => /(^|:)\d+:/.test(line)).length;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function getHighlightRegex(pattern: string | undefined): RegExp | null {
  if (!pattern) {
    return null;
  }
  try {
    const regex = new RegExp(pattern, "g");
    return regex.source === "(?:)" ? null : regex;
  } catch {
    const escaped = escapeRegExp(pattern);
    return escaped ? new RegExp(escaped, "gi") : null;
  }
}

function renderHighlightedRanges(text: string, ranges: GrepMatch["ranges"]) {
  if (!ranges || ranges.length === 0) {
    return null;
  }
  const nodes: ReactNode[] = [];
  let lastIndex = 0;
  for (const [key, range] of ranges.entries()) {
    const start = Math.max(0, Math.min(text.length, range.start));
    const end = Math.max(start, Math.min(text.length, range.end));
    if (start > lastIndex) {
      nodes.push(text.slice(lastIndex, start));
    }
    if (end > start) {
      nodes.push(
        <mark className={styles.matchHighlight} key={`match-${key}`}>
          {text.slice(start, end)}
        </mark>,
      );
    }
    lastIndex = end;
    if (key >= 50) {
      break;
    }
  }
  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex));
  }
  return nodes.length > 0 ? nodes : null;
}

function renderHighlightedText(
  text: string,
  ranges: GrepMatch["ranges"],
  pattern: string | undefined,
) {
  const rangeNodes = renderHighlightedRanges(text, ranges);
  if (rangeNodes) {
    return rangeNodes;
  }
  const regex = getHighlightRegex(pattern);
  if (!regex) {
    return text;
  }

  const nodes: ReactNode[] = [];
  let lastIndex = 0;
  let key = 0;
  for (const match of text.matchAll(regex)) {
    const matchText = match[0];
    const index = match.index ?? 0;
    if (!matchText) {
      break;
    }
    if (index > lastIndex) {
      nodes.push(text.slice(lastIndex, index));
    }
    nodes.push(
      <mark className={styles.matchHighlight} key={`match-${key}`}>
        {matchText}
      </mark>,
    );
    key += 1;
    lastIndex = index + matchText.length;
    if (key >= 50) {
      break;
    }
  }
  if (nodes.length === 0) {
    return text;
  }
  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex));
  }
  return nodes;
}

function GrepMatchDrilldown({
  label,
  matches,
  pattern,
  projectPath,
}: {
  label: string;
  matches: GrepMatch[];
  pattern?: string;
  projectPath?: string | null;
}) {
  const [showModal, setShowModal] = useState(false);
  const showFileColumn = hasMultipleGrepMatchFiles(matches);

  if (matches.length === 0) {
    return <span className={styles.count}>{label}</span>;
  }

  return (
    <>
      <Button
        variant="link"
        className={styles.matchCountButton}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setShowModal(true);
        }}
      >
        {label}
      </Button>
      {showModal && (
        <ActivityDetailModal
          title={label}
          label={label}
          onClose={() => setShowModal(false)}
        >
          <div className={styles.matchModal}>
            <table className={styles.matchTable}>
              <thead>
                <tr>
                  {showFileColumn && <th>File</th>}
                  <th>Line</th>
                  <th>Text</th>
                </tr>
              </thead>
              <tbody>
                {matches.map((match, index) => (
                  <tr
                    key={`${match.filePath}:${match.lineNumber}:${match.columnNumber ?? ""}:${index}`}
                  >
                    {showFileColumn && (
                      <td className={styles.matchFile}>
                        {makeDisplayPath(match.filePath, projectPath)}
                      </td>
                    )}
                    <td className={styles.matchLine}>
                      {match.columnNumber
                        ? `${match.lineNumber}:${match.columnNumber}`
                        : match.lineNumber}
                    </td>
                    <td className={styles.matchText}>
                      {renderHighlightedText(match.text, match.ranges, pattern)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </ActivityDetailModal>
      )}
    </>
  );
}

/**
 * Extract filename from path
 */
function getFileName(filePath: string): string {
  return getPathBasename(filePath);
}

function hasMultipleGrepMatchFiles(matches: GrepMatch[]): boolean {
  const files = new Set(matches.map((match) => match.filePath));
  return files.size > 1;
}

/**
 * Grep tool use - shows search pattern
 */
function GrepToolUse({
  input,
  projectPath,
}: {
  input: GrepInput;
  projectPath?: string | null;
}) {
  return (
    <div className={styles.toolUse}>
      <span className={styles.pattern}>{input.pattern}</span>
      {input.glob && <span className={styles.glob}>({input.glob})</span>}
      {input.path && (
        <span className={styles.path}>
          in {makeDisplayPath(input.path, projectPath)}
        </span>
      )}
    </div>
  );
}

/**
 * File list view (for files_with_matches mode)
 */
function FileListView({
  filenames,
  isExpanded,
  projectPath,
  setIsExpanded,
}: {
  filenames: string[];
  isExpanded: boolean;
  projectPath?: string | null;
  setIsExpanded: (expanded: boolean) => void;
}) {
  const needsCollapse = filenames.length > MAX_FILES_COLLAPSED;
  const displayFiles =
    needsCollapse && !isExpanded
      ? filenames.slice(0, MAX_FILES_COLLAPSED)
      : filenames;

  return (
    <>
      <div className={globStyles.fileList} data-file-list>
        {displayFiles.map((file) => (
          <div
            key={file}
            className={globStyles.fileListItem}
            data-file-list-item
          >
            <span className={codeStyles.filePath} data-file-path>
              {getFileName(makeDisplayPath(file, projectPath))}
            </span>
            <span className={globStyles.fileDir} data-file-dir>
              {makeDisplayPath(file, projectPath)}
            </span>
          </div>
        ))}
        {needsCollapse && !isExpanded && (
          <div className={globStyles.fileListMore} data-file-list-more>
            ... and {filenames.length - MAX_FILES_COLLAPSED} more
          </div>
        )}
      </div>
      {needsCollapse && (
        <Button
          variant="ghost"
          size="small"
          className={expandStyles.expandButton}
          data-expand-button
          onClick={() => setIsExpanded(!isExpanded)}
        >
          {isExpanded ? "Show less" : `Show all ${filenames.length} files`}
        </Button>
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
  const displayContent = displayLines.join("\n");
  const contentRef = useQuoteableTextSource<HTMLPreElement>(displayContent);

  return (
    <>
      <pre
        ref={contentRef}
        className={`${styles.content} ${codeStyles.codeBlock}`}
        data-code-block
      >
        <code>{displayContent}</code>
      </pre>
      {needsCollapse && (
        <Button
          variant="ghost"
          size="small"
          className={expandStyles.expandButton}
          data-expand-button
          onClick={() => setIsExpanded(!isExpanded)}
        >
          {isExpanded ? "Show less" : `Show all ${lines.length} lines`}
        </Button>
      )}
    </>
  );
}

function GrepCollapsedPreview({
  input,
  result,
  isError,
  projectPath,
}: {
  input?: GrepInput;
  result: GrepResult | undefined;
  isError: boolean;
  projectPath?: string | null;
}) {
  const previewLineCount = useOutputToolPreviewLineCount();
  const matches = useMemo(() => {
    if (isError || result?.mode !== "content") {
      return [];
    }
    return result.matches ?? [];
  }, [isError, result]);
  const visibleMatchCount = Math.max(0, previewLineCount - 1);
  const previewMatches = matches.slice(0, visibleMatchCount);

  if (previewMatches.length === 0) {
    return null;
  }

  const showFileColumn = hasMultipleGrepMatchFiles(matches);
  const hiddenMatchCount = Math.max(0, matches.length - previewMatches.length);

  return (
    <div className={styles.collapsedPreview}>
      {previewMatches.map((match, index) => (
        <div
          className={styles.previewMatch}
          key={`${match.filePath}:${match.lineNumber}:${match.columnNumber ?? ""}:${index}`}
        >
          {showFileColumn && (
            <span
              className={styles.previewFile}
              title={makeDisplayPath(match.filePath, projectPath)}
            >
              {getFileName(makeDisplayPath(match.filePath, projectPath))}
            </span>
          )}
          <span className={styles.previewLine}>
            {match.columnNumber
              ? `${match.lineNumber}:${match.columnNumber}`
              : match.lineNumber}
          </span>
          <GrepPreviewMatchText match={match} pattern={input?.pattern} />
        </div>
      ))}
      {hiddenMatchCount > 0 && (
        <div className={styles.previewMore}>
          +{hiddenMatchCount} {hiddenMatchCount === 1 ? "match" : "matches"}
        </div>
      )}
    </div>
  );
}

function GrepPreviewMatchText({
  match,
  pattern,
}: {
  match: GrepMatch;
  pattern?: string;
}) {
  const ref = useQuoteableTextSource<HTMLSpanElement>(match.text);
  return (
    <span ref={ref} className={styles.previewText}>
      {renderHighlightedText(match.text, match.ranges, pattern)}
    </span>
  );
}

/**
 * Grep tool result - shows search results based on mode
 */
function GrepToolResult({
  input,
  result,
  projectPath,
}: {
  input?: GrepInput;
  result: GrepResult;
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
      const validation = validateToolResult("Grep", result);
      if (!validation.valid && validation.errors) {
        setValidationErrors(validation.errors);
        reportValidationError("Grep", validation.errors);
      } else {
        setValidationErrors(null);
      }
    }
  }, [enabled, result, reportValidationError]);

  const showValidationWarning =
    enabled && validationErrors && !isToolIgnored("Grep");

  if (!result) {
    return <div className={styles.empty}>No results</div>;
  }

  const { mode, filenames, numFiles, content, appliedLimit } = result;

  // Count mode - just show summary
  if (mode === "count") {
    return (
      <div className={styles.result}>
        {showValidationWarning && validationErrors && (
          <SchemaWarning toolName="Grep" errors={validationErrors} />
        )}
        <div className={styles.countSummary}>
          {numFiles} {numFiles === 1 ? "file" : "files"} matched
        </div>
      </div>
    );
  }

  // Content mode - show search results
  if (mode === "content" && content) {
    const matches = result.matches ?? [];
    const matchCount = matches.length || countGrepMatches(content);
    const matchLabel = `${matchCount} ${matchCount === 1 ? "match" : "matches"}`;

    return (
      <div className={styles.result}>
        <div className={styles.header}>
          <GrepMatchDrilldown
            label={matchLabel}
            matches={matches}
            pattern={input?.pattern}
            projectPath={projectPath}
          />
          {appliedLimit && (
            <Badge tone="info" size="small">
              limit: {appliedLimit}
            </Badge>
          )}
          {showValidationWarning && validationErrors && (
            <SchemaWarning toolName="Grep" errors={validationErrors} />
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
    return (
      <div className={styles.empty}>
        {showValidationWarning && validationErrors && (
          <SchemaWarning toolName="Grep" errors={validationErrors} />
        )}
        No matches found
      </div>
    );
  }

  return (
    <div className={styles.result}>
      <div className={styles.header}>
        <span className={styles.count}>{numFiles} files</span>
        {showValidationWarning && validationErrors && (
          <SchemaWarning toolName="Grep" errors={validationErrors} />
        )}
      </div>
      <FileListView
        filenames={filenames}
        isExpanded={isExpanded}
        projectPath={projectPath}
        setIsExpanded={setIsExpanded}
      />
    </div>
  );
}

function getGrepScope(
  input: GrepInput,
  projectPath?: string | null,
):
  | { kind: "path"; value: string; label: string }
  | { kind: "glob"; value: string; label: string }
  | null {
  if (input.path) {
    const displayPath = makeDisplayPath(input.path, projectPath);
    return {
      kind: "path",
      value: input.path,
      label: getFileName(displayPath),
    };
  }
  if (input.glob) {
    return { kind: "glob", value: input.glob, label: input.glob };
  }
  return null;
}

function getGrepUseSummary(
  input: GrepInput,
  projectPath?: string | null,
): string {
  const scope = getGrepScope(input, projectPath);
  if (!scope) {
    return input.pattern;
  }
  const scopeText =
    scope.kind === "path"
      ? makeDisplayPath(scope.value, projectPath)
      : scope.value;
  return `${input.pattern} in ${scopeText}`;
}

export function truncateGrepPatternForWidth(
  pattern: string,
  maxWidthPx: number,
  measureText: (text: string) => number,
): string {
  if (maxWidthPx <= 0) {
    return "";
  }
  if (measureText(pattern) <= maxWidthPx) {
    return pattern;
  }
  if (measureText(GREP_PATTERN_ELLIPSIS) > maxWidthPx) {
    return "";
  }

  let low = 0;
  let high = pattern.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    const candidate = `${pattern.slice(0, mid)}${GREP_PATTERN_ELLIPSIS}`;
    if (measureText(candidate) <= maxWidthPx) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return `${pattern.slice(0, low)}${GREP_PATTERN_ELLIPSIS}`;
}

function GrepSummaryPattern({
  expanded,
  input,
  onToggle,
  projectPath,
}: {
  expanded: boolean;
  input: GrepInput;
  onToggle?: () => void;
  projectPath?: string | null;
}) {
  const summary = getGrepUseSummary(input, projectPath);
  const scope = getGrepScope(input, projectPath);
  const scopeValue = scope?.value ?? "";
  const rowRef = useRef<HTMLSpanElement | null>(null);
  const scopeRef = useRef<HTMLSpanElement | null>(null);
  const measureRef = useRef<HTMLSpanElement | null>(null);
  const [displayPattern, setDisplayPattern] = useState(input.pattern);

  useLayoutEffect(() => {
    void scopeValue;
    const updateDisplayPattern = () => {
      if (expanded) {
        setDisplayPattern(input.pattern);
        return;
      }

      const row = rowRef.current;
      const measure = measureRef.current;
      if (!row || !measure) {
        setDisplayPattern(input.pattern);
        return;
      }

      const rowWidthPx = row.getBoundingClientRect().width;
      if (rowWidthPx <= 0) {
        setDisplayPattern(input.pattern);
        return;
      }
      const scopeWidthPx = scopeRef.current?.getBoundingClientRect().width ?? 0;
      const maxPatternWidthPx = Math.max(
        0,
        rowWidthPx -
          scopeWidthPx -
          (scopeWidthPx > 0 ? GREP_SUMMARY_SCOPE_GAP_PX : 0),
      );
      const measureText = (text: string) => {
        measure.textContent = text;
        return measure.getBoundingClientRect().width;
      };
      setDisplayPattern(
        truncateGrepPatternForWidth(
          input.pattern,
          maxPatternWidthPx,
          measureText,
        ),
      );
    };

    updateDisplayPattern();

    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", updateDisplayPattern);
      return () => window.removeEventListener("resize", updateDisplayPattern);
    }

    const resizeObserver = new ResizeObserver(updateDisplayPattern);
    if (rowRef.current) {
      resizeObserver.observe(rowRef.current);
    }
    if (scopeRef.current) {
      resizeObserver.observe(scopeRef.current);
    }
    return () => resizeObserver.disconnect();
  }, [expanded, input.pattern, scopeValue]);

  const clipClassName = `${styles.summaryPatternClip}${onToggle ? ` ${styles.summaryPatternAction}` : ""}`;
  const clipContent = onToggle ? (
    <ButtonBase
      className={clipClassName}
      title={summary}
      aria-label={expanded ? "Collapse grep pattern" : "Show full grep pattern"}
      aria-expanded={expanded}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onToggle();
      }}
    >
      {displayPattern}
    </ButtonBase>
  ) : (
    <span className={clipClassName} title={summary}>
      {displayPattern}
    </span>
  );

  return (
    <span
      className={styles.summaryPattern}
      data-is-expanded={expanded || undefined}
    >
      <span className={styles.summaryPatternRow} ref={rowRef}>
        {clipContent}
        {scope && (
          <span className={styles.summaryScope} ref={scopeRef}>
            <span className={styles.summaryScopePrefix}>in</span>
            {scope.kind === "path" ? (
              <SessionFilePathLink
                displayPath={scope.label}
                filePath={scope.value}
                showLineSuffix={false}
              />
            ) : (
              <span className={styles.summaryScopeText} title={scope.value}>
                {scope.label}
              </span>
            )}
          </span>
        )}
      </span>
      <span className={styles.summaryPatternMeasure} ref={measureRef} />
      {expanded && <span className={styles.summaryPatternFull}>{summary}</span>}
    </span>
  );
}

function getGrepResultLabel(result: GrepResult): {
  matches: GrepMatch[];
  text: string;
} {
  if (result.mode === "content") {
    const matches = result.matches ?? [];
    const matchCount = matches.length || countGrepMatches(result.content);
    return {
      matches,
      text: `${matchCount} ${matchCount === 1 ? "match" : "matches"}`,
    };
  }

  if (result.numFiles === 0) {
    return { matches: [], text: "0 matches" };
  }

  return {
    matches: [],
    text:
      result.numFiles !== undefined
        ? `${result.numFiles} ${result.numFiles === 1 ? "file" : "files"}`
        : "Results",
  };
}

function GrepInteractiveSummary({
  input,
  result,
  isError,
  projectPath,
  summaryExpanded,
  toggleSummaryExpanded,
}: {
  input: GrepInput;
  result: GrepResult | undefined;
  isError: boolean;
  projectPath?: string | null;
  summaryExpanded?: boolean;
  toggleSummaryExpanded?: () => void;
}) {
  if (isError || !result) {
    return null;
  }
  const resultLabel = getGrepResultLabel(result);
  return (
    <span className={styles.inlineSummary}>
      <GrepSummaryPattern
        expanded={summaryExpanded ?? false}
        input={input}
        onToggle={toggleSummaryExpanded}
        projectPath={projectPath}
      />
      <span className={styles.summaryArrow} aria-hidden="true">
        →
      </span>
      <GrepMatchDrilldown
        label={resultLabel.text}
        matches={resultLabel.matches}
        pattern={input.pattern}
        projectPath={projectPath}
      />
    </span>
  );
}

export const grepRenderer = defineTool(toolDisplayContracts.Grep, {
  tool: "Grep",
  displayName: "Grep",

  renderToolUse(input, context) {
    return <GrepToolUse input={input} projectPath={context.projectPath} />;
  },

  renderToolResult(result, _isError, context, input) {
    return (
      <GrepToolResult
        input={input}
        result={result}
        projectPath={context.projectPath}
      />
    );
  },

  renderFailure(failure) {
    return (
      <div className={styles.error}>{failure.content || "Search failed"}</div>
    );
  },

  getFailureSummary() {
    return "Error";
  },

  getUseSummary(input, context) {
    return getGrepUseSummary(input, context?.projectPath);
  },

  getResultSummary(result) {
    const r = result;
    if (!r) return "Results";
    return getGrepResultLabel(r).text;
  },

  renderInteractiveSummary(input, result, isError, context) {
    return (
      <GrepInteractiveSummary
        input={input}
        result={result}
        isError={isError}
        projectPath={context.projectPath}
        summaryExpanded={context.summaryExpanded}
        toggleSummaryExpanded={context.toggleSummaryExpanded}
      />
    );
  },

  renderCollapsedPreview(input, result, isError, context) {
    return (
      <GrepCollapsedPreview
        input={input}
        result={result}
        isError={isError}
        projectPath={context.projectPath}
      />
    );
  },
});
