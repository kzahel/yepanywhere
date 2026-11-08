import { toolDisplayContracts } from "./toolDisplayContracts";
import { defineTool } from "./defineTool";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ZodError } from "zod";
import { useOptionalSessionMetadata } from "../../../contexts/SessionMetadataContext";
import { useSchemaValidationContext } from "../../../contexts/SchemaValidationContext";
import { useVisibilityAwareTextTooltip } from "../../../hooks/useTooltipAppearance";
import { isMarkdownLikeFile } from "../../../lib/markdownFiles";
import { getPathBasename, makeDisplayPath } from "../../../lib/text";
import { validateToolResult } from "../../../lib/validateToolResult";
import { ActivityDetailModal } from "../../ActivityDetailModal";
import {
  FILE_MARKDOWN_PREVIEW_BASE_DENSITY,
  MarkdownPreview,
} from "../../MarkdownPreview";
import { SchemaWarning } from "../../SchemaWarning";
import { ShikiHtml } from "../../ShikiHtml";
import { SessionFilePathLink } from "../../SessionFilePathLink";
import { Button, ButtonBase } from "../../ui/Button";
import { FilePathDisplay } from "../../ui/FilePathDisplay";
import { getOutputTailTooltip } from "./outputPreview";
import type { WriteInput, WriteResult } from "./types";

const MAX_LINES_COLLAPSED = 30;
const PREVIEW_LINES = 3;

/** Extended input type with embedded augment data from server */
type WriteInputWithAugment = WriteInput;

/**
 * Extract filename from path
 */
function getFileName(filePath: string): string {
  return getPathBasename(filePath);
}

/**
 * Truncate highlighted HTML to a specified number of lines.
 * Shiki output wraps each line in <span class="line">.
 */
function truncateHighlightedHtml(html: string, maxLines: number): string {
  const lines = html.split('<span class="line">');
  if (lines.length <= maxLines + 1) return html;

  // Rebuild with only maxLines worth of lines
  const truncated = lines.slice(0, maxLines + 1).join('<span class="line">');
  // Close any open tags
  return `${truncated}</code></pre>`;
}

/**
 * Write tool use - shows file path being written
 */
function WriteToolUse({ input }: { input: WriteInput }) {
  const meta = useOptionalSessionMetadata();
  const displayPath = makeDisplayPath(input.file_path, meta?.projectPath);
  const lineCount = input.content.split("\n").length;
  return (
    <div className="write-tool-use">
      <span className="file-path">
        <SessionFilePathLink
          displayPath={displayPath}
          filePath={input.file_path}
        />
      </span>
      <span className="write-info">{lineCount} lines</span>
    </div>
  );
}

/**
 * Modal content for viewing full file contents
 */
function WriteModalContent({
  file,
  input,
}: {
  file: NonNullable<WriteResult["file"]>;
  input?: WriteInputWithAugment;
}) {
  const [showPreview, setShowPreview] = useState(false);
  const lines = file.content.split("\n");

  const isMarkdown = isMarkdownLikeFile(file.filePath);
  const hasMarkdownPreview = isMarkdown && !!input?._renderedMarkdownHtml;

  // Toggle button for markdown files
  const toggleButton = hasMarkdownPreview && (
    <div className="markdown-view-toggle">
      <button
        type="button"
        className={`toggle-btn ${!showPreview ? "active" : ""}`}
        onClick={() => setShowPreview(false)}
      >
        Source
      </button>
      <button
        type="button"
        className={`toggle-btn ${showPreview ? "active" : ""}`}
        onClick={() => setShowPreview(true)}
      >
        Preview
      </button>
    </div>
  );

  // Show rendered markdown preview
  if (showPreview && input?._renderedMarkdownHtml) {
    return (
      <div className="file-content-modal">
        {toggleButton}
        <MarkdownPreview
          html={input._renderedMarkdownHtml}
          sourcePath={file.filePath}
          density={FILE_MARKDOWN_PREVIEW_BASE_DENSITY}
        />
      </div>
    );
  }

  // Use highlighted HTML if available from input augment
  if (input?._highlightedContentHtml) {
    return (
      <div className="file-content-modal">
        {toggleButton}
        <div className="file-viewer-code file-viewer-code-highlighted">
          <ShikiHtml html={input._highlightedContentHtml} />
          {input._highlightedTruncated && (
            <div className="file-viewer-truncated">
              Content truncated for highlighting (showing first 2000 lines)
            </div>
          )}
        </div>
      </div>
    );
  }

  // Fallback: plain text with line numbers
  return (
    <div className="file-content-modal">
      {toggleButton}
      <div className="file-content-with-lines">
        <div className="line-numbers">
          {lines.map((_, i) => (
            <div key={`ln-${i + 1}`}>{file.startLine + i}</div>
          ))}
        </div>
        <pre className="line-content">
          <code>{file.content}</code>
        </pre>
      </div>
    </div>
  );
}

/**
 * Write tool result - shows written content with line numbers
 * Uses highlighted HTML from input augment when available.
 */
function WriteToolResult({
  result,
  input,
}: {
  result: WriteResult;
  input?: WriteInputWithAugment;
}) {
  const meta = useOptionalSessionMetadata();
  const [isExpanded, setIsExpanded] = useState(false);
  const { enabled, reportValidationError, isToolIgnored } =
    useSchemaValidationContext();
  const [validationErrors, setValidationErrors] = useState<ZodError | null>(
    null,
  );

  useEffect(() => {
    if (enabled && result) {
      const validation = validateToolResult("Write", result);
      if (!validation.valid && validation.errors) {
        setValidationErrors(validation.errors);
        reportValidationError("Write", validation.errors);
      } else {
        setValidationErrors(null);
      }
    }
  }, [enabled, result, reportValidationError]);

  const showValidationWarning =
    enabled && validationErrors && !isToolIgnored("Write");

  // An acknowledgement carries text instead of the written file.
  if (!result?.file) {
    return (
      <div className="write-error">
        {showValidationWarning && validationErrors && (
          <SchemaWarning toolName="Write" errors={validationErrors} />
        )}
        {result?.content || "Failed to write file"}
      </div>
    );
  }

  const { file } = result;
  const lines = file.content.split("\n");
  const needsCollapse = lines.length > MAX_LINES_COLLAPSED;
  const displayPath = makeDisplayPath(file.filePath, meta?.projectPath);

  // Use highlighted HTML if available from input augment
  if (input?._highlightedContentHtml) {
    return (
      <div className="write-result">
        <div className="file-header">
          <span className="file-path">
            <SessionFilePathLink
              displayPath={displayPath}
              filePath={file.filePath}
              lineNumber={file.startLine}
            />
          </span>
          <span className="file-range">{file.numLines} lines written</span>
          {showValidationWarning && validationErrors && (
            <SchemaWarning toolName="Write" errors={validationErrors} />
          )}
        </div>
        <div className="file-viewer-code file-viewer-code-highlighted">
          <ShikiHtml html={input._highlightedContentHtml} />
          {input._highlightedTruncated && (
            <div className="file-viewer-truncated">
              Content truncated for highlighting (showing first 2000 lines)
            </div>
          )}
        </div>
      </div>
    );
  }

  // Fallback: plain text with line numbers and expand/collapse
  const displayLines =
    needsCollapse && !isExpanded ? lines.slice(0, MAX_LINES_COLLAPSED) : lines;

  return (
    <div className="write-result">
      <div className="file-header">
        <span className="file-path">
          <SessionFilePathLink
            displayPath={displayPath}
            filePath={file.filePath}
            lineNumber={file.startLine}
          />
        </span>
        <span className="file-range">{file.numLines} lines written</span>
        {showValidationWarning && validationErrors && (
          <SchemaWarning toolName="Write" errors={validationErrors} />
        )}
      </div>
      <div className="file-content-with-lines">
        <div className="line-numbers">
          {displayLines.map((_, i) => {
            const lineNum = file.startLine + i;
            return <div key={`line-${lineNum}`}>{lineNum}</div>;
          })}
          {needsCollapse && !isExpanded && <div>...</div>}
        </div>
        <pre className="line-content">
          <code>{displayLines.join("\n")}</code>
        </pre>
      </div>
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
    </div>
  );
}

function WriteCollapsedError({ message }: { message: string }) {
  return (
    <div className="write-collapsed-preview write-collapsed-error">
      <span className="write-preview-error">{message}</span>
    </div>
  );
}

/**
 * Collapsed preview showing line count and code preview with fade
 * Clicking opens a modal with the full content
 */
function WriteCollapsedPreview({
  input,
  result,
  isError,
}: {
  input: WriteInputWithAugment;
  result: WriteResult | undefined;
  isError: boolean;
}) {
  const [isModalOpen, setIsModalOpen] = useState(false);
  const { enabled, reportValidationError, isToolIgnored } =
    useSchemaValidationContext();
  const [validationErrors, setValidationErrors] = useState<ZodError | null>(
    null,
  );

  useEffect(() => {
    if (enabled && result) {
      const validation = validateToolResult("Write", result);
      if (!validation.valid && validation.errors) {
        setValidationErrors(validation.errors);
        reportValidationError("Write", validation.errors);
      } else {
        setValidationErrors(null);
      }
    }
  }, [enabled, result, reportValidationError]);

  const showValidationWarning =
    enabled && validationErrors && !isToolIgnored("Write");

  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      if (!isError) {
        setIsModalOpen(true);
      }
    },
    [isError],
  );

  const handleClose = useCallback(() => {
    setIsModalOpen(false);
  }, []);

  const meta = useOptionalSessionMetadata();

  // Use result data if available, otherwise fall back to input
  const content = result?.file?.content ?? input.content;
  const filePath = result?.file?.filePath ?? input.file_path;
  const displayPath = makeDisplayPath(filePath, meta?.projectPath);
  const lines = content.split("\n");
  const lineCount = result?.file?.numLines ?? lines.length;
  const isTruncated = lines.length > PREVIEW_LINES;
  const tooltipAttributes = useVisibilityAwareTextTooltip<HTMLDivElement>(
    content,
    isTruncated ? getOutputTailTooltip(content, PREVIEW_LINES) : null,
  );

  // Truncate highlighted HTML for preview
  const previewHtml = useMemo(() => {
    if (!input._highlightedContentHtml) return null;
    return truncateHighlightedHtml(
      input._highlightedContentHtml,
      PREVIEW_LINES,
    );
  }, [input._highlightedContentHtml]);

  // A checked rejection goes to `renderCollapsedFailure`; this error has none.
  if (isError) {
    return <WriteCollapsedError message="Failed to write file" />;
  }

  return (
    <>
      <ButtonBase className="write-collapsed-preview" onClick={handleClick}>
        <div className="write-preview-lines">
          <FilePathDisplay displayPath={displayPath} />
          {" · "}
          {lineCount} lines
          {showValidationWarning && validationErrors && (
            <SchemaWarning toolName="Write" errors={validationErrors} />
          )}
        </div>
        <div
          className={`write-preview-content ${isTruncated ? "write-preview-truncated" : ""}`}
          {...tooltipAttributes}
        >
          {previewHtml ? (
            <ShikiHtml html={previewHtml} />
          ) : (
            <pre>
              <code>{lines.slice(0, PREVIEW_LINES).join("\n")}</code>
            </pre>
          )}
          {isTruncated && <div className="write-preview-fade" />}
        </div>
      </ButtonBase>
      {isModalOpen && (
        <ActivityDetailModal
          title={
            <span className="file-path">
              <SessionFilePathLink
                displayPath={displayPath}
                filePath={filePath}
              />
            </span>
          }
          label={displayPath}
          briefLabel={getPathBasename(filePath)}
          onClose={handleClose}
        >
          <WriteModalContent
            file={
              result?.file ?? {
                filePath,
                content,
                numLines: lineCount,
                startLine: 1,
                totalLines: lineCount,
              }
            }
            input={input}
          />
        </ActivityDetailModal>
      )}
    </>
  );
}

export const writeRenderer = defineTool(toolDisplayContracts.Write, {
  tool: "Write",

  renderToolUse(input, _context) {
    return <WriteToolUse input={input} />;
  },

  renderToolResult(result, _isError, _context, input) {
    return <WriteToolResult result={result} input={input} />;
  },

  renderFailure(failure) {
    return (
      <div className="write-error">
        {failure.content || "Failed to write file"}
      </div>
    );
  },

  renderCollapsedFailure(failure) {
    return (
      <WriteCollapsedError
        message={failure.content || "Failed to write file"}
      />
    );
  },

  getFailureSummary() {
    return "Error";
  },

  getUseSummary(input) {
    return getFileName(input.file_path);
  },

  getResultSummary(result, _isError, input?) {
    const r = result;
    if (r?.file) {
      return getFileName(r.file.filePath);
    }
    // Fall back to input if result not ready
    if (input) {
      return getFileName(input.file_path);
    }
    return "Writing...";
  },

  renderCollapsedPreview(input, result, isError, _context) {
    return (
      <WriteCollapsedPreview input={input} result={result} isError={isError} />
    );
  },
});
