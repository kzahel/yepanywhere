import { useCallback, useState } from "react";
import { Modal } from "../../ui/Modal";
import type { ToolRenderer, WriteInput, WriteResult } from "./types";

const MAX_LINES_COLLAPSED = 30;
const PREVIEW_LINES = 3;

/**
 * Extract filename from path
 */
function getFileName(filePath: string): string {
  return filePath.split("/").pop() || filePath;
}

/**
 * Write tool use - shows file path being written
 */
function WriteToolUse({ input }: { input: WriteInput }) {
  const fileName = getFileName(input.file_path);
  const lineCount = input.content.split("\n").length;
  return (
    <div className="write-tool-use">
      <span className="file-path">{fileName}</span>
      <span className="write-info">{lineCount} lines</span>
    </div>
  );
}

/**
 * Modal content for viewing full file contents
 */
function WriteModalContent({
  file,
}: {
  file: WriteResult["file"];
}) {
  const lines = file.content.split("\n");

  return (
    <div className="file-content-with-lines">
      <div className="line-numbers">
        {lines.map((_, i) => {
          const lineNum = file.startLine + i;
          return <div key={`line-${lineNum}`}>{lineNum}</div>;
        })}
      </div>
      <pre className="line-content">
        <code>{file.content}</code>
      </pre>
    </div>
  );
}

/**
 * Write tool result - shows written content with line numbers
 */
function WriteToolResult({
  result,
  isError,
}: {
  result: WriteResult;
  isError: boolean;
}) {
  const [isExpanded, setIsExpanded] = useState(false);

  if (isError || !result?.file) {
    // Extract error message - can be a string or object with content
    let errorMessage = "Failed to write file";
    if (typeof result === "string") {
      errorMessage = result;
    } else if (typeof result === "object" && result !== null) {
      const errorResult = result as { content?: unknown };
      if (errorResult.content) {
        errorMessage = String(errorResult.content);
      }
    }
    return <div className="write-error">{errorMessage}</div>;
  }

  const { file } = result;
  const lines = file.content.split("\n");
  const needsCollapse = lines.length > MAX_LINES_COLLAPSED;
  const displayLines =
    needsCollapse && !isExpanded ? lines.slice(0, MAX_LINES_COLLAPSED) : lines;

  const fileName = getFileName(file.filePath);

  return (
    <div className="write-result">
      <div className="file-header">
        <span className="file-path">{fileName}</span>
        <span className="file-range">{file.numLines} lines written</span>
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
        <button
          type="button"
          className="expand-button"
          onClick={() => setIsExpanded(!isExpanded)}
        >
          {isExpanded ? "Show less" : `Show all ${lines.length} lines`}
        </button>
      )}
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
  input: WriteInput;
  result: WriteResult | undefined;
  isError: boolean;
}) {
  const [isModalOpen, setIsModalOpen] = useState(false);

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

  // Use result data if available, otherwise fall back to input
  const content = result?.file?.content ?? input.content;
  const filePath = result?.file?.filePath ?? input.file_path;
  const fileName = getFileName(filePath);
  const lines = content.split("\n");
  const lineCount = result?.file?.numLines ?? lines.length;
  const previewLines = lines.slice(0, PREVIEW_LINES);
  const isTruncated = lines.length > PREVIEW_LINES;

  if (isError) {
    // Extract error message from result - can be a string or object with content
    let errorMessage = "Failed to write file";
    if (typeof result === "string") {
      errorMessage = result;
    } else if (typeof result === "object" && result !== null) {
      const errorResult = result as { content?: unknown };
      if (errorResult.content) {
        errorMessage = String(errorResult.content);
      }
    }
    return (
      <div className="write-collapsed-preview write-collapsed-error">
        <span className="write-preview-error">{errorMessage}</span>
      </div>
    );
  }

  return (
    <>
      <button
        type="button"
        className="write-collapsed-preview"
        onClick={handleClick}
      >
        <div className="write-preview-lines">{lineCount} lines</div>
        <div
          className={`write-preview-content ${isTruncated ? "write-preview-truncated" : ""}`}
        >
          <pre>
            <code>{previewLines.join("\n")}</code>
          </pre>
          {isTruncated && <div className="write-preview-fade" />}
        </div>
      </button>
      {isModalOpen && (
        <Modal
          title={<span className="file-path">{fileName}</span>}
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
          />
        </Modal>
      )}
    </>
  );
}

export const writeRenderer: ToolRenderer<WriteInput, WriteResult> = {
  tool: "Write",

  renderToolUse(input, _context) {
    return <WriteToolUse input={input as WriteInput} />;
  },

  renderToolResult(result, isError, _context) {
    return <WriteToolResult result={result as WriteResult} isError={isError} />;
  },

  getUseSummary(input) {
    return getFileName((input as WriteInput).file_path);
  },

  getResultSummary(result, isError, input?) {
    if (isError) return "Error";
    const r = result as WriteResult;
    if (r?.file) {
      return getFileName(r.file.filePath);
    }
    // Fall back to input if result not ready
    if (input) {
      return getFileName((input as WriteInput).file_path);
    }
    return "Writing...";
  },

  renderCollapsedPreview(input, result, isError, _context) {
    return (
      <WriteCollapsedPreview
        input={input as WriteInput}
        result={result as WriteResult | undefined}
        isError={isError}
      />
    );
  },
};
