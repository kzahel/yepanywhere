import { useCallback, useMemo, useState } from "react";
import { Modal } from "../../ui/Modal";
import type { RenderContext } from "../types";
import type { EditInput, EditResult, PatchHunk, ToolRenderer } from "./types";

const MAX_VISIBLE_LINES = 12;

/**
 * Extract filename from path
 */
function getFileName(filePath: string): string {
  return filePath.split("/").pop() || filePath;
}

/**
 * Check if this is a Claude plan file
 */
function isPlanFile(filePath: string): boolean {
  return filePath.includes(".claude/plans/");
}

/**
 * Create diff lines from old/new strings (for pending state preview)
 */
function createDiffLines(oldStr: string, newStr: string): string[] {
  const oldLines = oldStr ? oldStr.split("\n") : [];
  const newLines = newStr ? newStr.split("\n") : [];
  const lines: string[] = [];

  for (const line of oldLines) {
    lines.push(`-${line}`);
  }
  for (const line of newLines) {
    lines.push(`+${line}`);
  }

  return lines;
}

/**
 * Compute change summary from old/new strings
 */
function computeChangeSummaryFromStrings(
  oldStr: string,
  newStr: string,
): string | null {
  const oldLineCount = oldStr ? oldStr.split("\n").length : 0;
  const newLineCount = newStr ? newStr.split("\n").length : 0;

  if (oldLineCount === 0 && newLineCount > 0) {
    return `Adding ${newLineCount} line${newLineCount !== 1 ? "s" : ""}`;
  }
  if (newLineCount === 0 && oldLineCount > 0) {
    return `Removing ${oldLineCount} line${oldLineCount !== 1 ? "s" : ""}`;
  }
  if (oldLineCount > 0 && newLineCount > 0) {
    return `Replacing ${oldLineCount} line${oldLineCount !== 1 ? "s" : ""}`;
  }
  return null;
}

/**
 * Render diff lines (shared between pending preview and result fallback)
 */
function DiffLines({ lines }: { lines: string[] }) {
  return (
    <div className="diff-hunk">
      <pre className="diff-content">
        {lines.map((line, i) => {
          const prefix = line[0];
          const className =
            prefix === "-"
              ? "diff-removed"
              : prefix === "+"
                ? "diff-added"
                : "diff-context";
          // Use line content hash for stable keys
          const key = `${i}-${line.slice(0, 50)}`;
          return (
            <div key={key} className={className}>
              {line}
            </div>
          );
        })}
      </pre>
    </div>
  );
}

/**
 * Render a single diff hunk (without @@ header for cleaner display)
 */
function DiffHunk({ hunk }: { hunk: PatchHunk }) {
  return (
    <div className="diff-hunk">
      <pre className="diff-content">
        {hunk.lines.map((line, i) => {
          const prefix = line[0];
          const className =
            prefix === "-"
              ? "diff-removed"
              : prefix === "+"
                ? "diff-added"
                : "diff-context";
          return (
            <div key={`${hunk.oldStart}-${i}`} className={className}>
              {line}
            </div>
          );
        })}
      </pre>
    </div>
  );
}

/**
 * Edit tool use - shows file path and diff preview
 */
function EditToolUse({ input }: { input: EditInput }) {
  const fileName = getFileName(input.file_path);
  const isPlan = isPlanFile(input.file_path);

  const diffLines = useMemo(
    () => createDiffLines(input.old_string, input.new_string),
    [input.old_string, input.new_string],
  );

  const changeSummary = useMemo(
    () => computeChangeSummaryFromStrings(input.old_string, input.new_string),
    [input.old_string, input.new_string],
  );

  const isTruncated = diffLines.length > MAX_VISIBLE_LINES;

  return (
    <div className="edit-result">
      <div className="edit-header">
        <span className="file-path">{fileName}</span>
        {isPlan && <span className="badge badge-muted">Plan</span>}
      </div>
      {changeSummary && (
        <div className="edit-change-summary">{changeSummary}</div>
      )}
      <div className={`diff-view-container ${isTruncated ? "truncated" : ""}`}>
        <div className="diff-view">
          <DiffLines lines={diffLines} />
        </div>
        {isTruncated && <div className="diff-fade-overlay" />}
      </div>
    </div>
  );
}

/**
 * Modal content for viewing complete diff (from result with structuredPatch)
 */
function DiffModalContent({ result }: { result: EditResult }) {
  return (
    <div className="diff-view">
      {result.structuredPatch.map((hunk, i) => (
        <DiffHunk key={`modal-hunk-${hunk.oldStart}-${i}`} hunk={hunk} />
      ))}
    </div>
  );
}

/**
 * Modal content for viewing diff from input (pending state)
 */
function DiffInputModalContent({ input }: { input: EditInput }) {
  const diffLines = createDiffLines(input.old_string, input.new_string);

  return (
    <div className="diff-view">
      <DiffLines lines={diffLines} />
    </div>
  );
}

/**
 * Collapsed preview showing diff with expand button
 * Clicking opens a modal with the full diff
 */
function EditCollapsedPreview({
  input,
  result,
  isError,
}: {
  input: EditInput;
  result: EditResult | undefined;
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
  const filePath = result?.filePath ?? input.file_path;
  const fileName = getFileName(filePath);
  const isPlan = isPlanFile(filePath);

  // Get diff lines - prefer structuredPatch from result, fall back to input
  const diffLines = useMemo(() => {
    if (result?.structuredPatch && result.structuredPatch.length > 0) {
      return result.structuredPatch.flatMap((hunk) => hunk.lines);
    }
    return createDiffLines(
      result?.oldString ?? input.old_string,
      result?.newString ?? input.new_string,
    );
  }, [result, input]);

  const isTruncated = diffLines.length > MAX_VISIBLE_LINES;
  const displayLines = isTruncated
    ? diffLines.slice(0, MAX_VISIBLE_LINES)
    : diffLines;

  const changeSummary = useMemo(() => {
    if (result?.structuredPatch && result.structuredPatch.length > 0) {
      const additions = result.structuredPatch
        .flatMap((h) => h.lines)
        .filter((l) => l.startsWith("+")).length;
      const deletions = result.structuredPatch
        .flatMap((h) => h.lines)
        .filter((l) => l.startsWith("-")).length;

      if (additions > 0 && deletions > 0) {
        return `Modified ${additions + deletions} lines`;
      }
      if (additions > 0) {
        return `Added ${additions} line${additions !== 1 ? "s" : ""}`;
      }
      if (deletions > 0) {
        return `Removed ${deletions} line${deletions !== 1 ? "s" : ""}`;
      }
      return null;
    }
    return computeChangeSummaryFromStrings(
      result?.oldString ?? input.old_string,
      result?.newString ?? input.new_string,
    );
  }, [result, input]);

  if (isError) {
    // Extract error message - can be a string or object with content
    let errorMessage: string | null = null;
    if (typeof result === "string") {
      errorMessage = result;
    } else if (typeof result === "object" && result !== null) {
      const errorResult = result as { content?: unknown };
      if (errorResult.content) {
        errorMessage = String(errorResult.content);
      }
    }
    return (
      <div className="edit-collapsed-preview edit-collapsed-error">
        <span className="badge badge-error">Edit failed</span>
        {errorMessage && (
          <span className="edit-error-message">{errorMessage}</span>
        )}
      </div>
    );
  }

  return (
    <>
      <div className="edit-collapsed-preview">
        <div className="edit-header">
          <span className="file-path">{fileName}</span>
          {isPlan && <span className="badge badge-muted">Plan</span>}
          {result?.userModified && (
            <span className="badge badge-info">User modified</span>
          )}
        </div>
        {changeSummary && (
          <div className="edit-change-summary">{changeSummary}</div>
        )}
        <div
          className={`diff-view-container ${isTruncated ? "truncated" : ""}`}
        >
          <div className="diff-view">
            <DiffLines lines={displayLines} />
          </div>
          {isTruncated && <div className="diff-fade-overlay" />}
        </div>
        <button
          type="button"
          className="diff-expand-button"
          onClick={handleClick}
        >
          Show full diff
        </button>
      </div>
      {isModalOpen && (
        <Modal
          title={<span className="file-path">{fileName}</span>}
          onClose={handleClose}
        >
          {result?.structuredPatch && result.structuredPatch.length > 0 ? (
            <DiffModalContent result={result} />
          ) : (
            <DiffInputModalContent input={input} />
          )}
        </Modal>
      )}
    </>
  );
}

/**
 * Edit tool result - shows diff view with truncation and modal expand
 */
function EditToolResult({
  result,
  input,
  isError,
}: {
  result: EditResult;
  input?: EditInput;
  isError: boolean;
}) {
  const [showModal, setShowModal] = useState(false);

  // Count total lines in all hunks
  const totalLines = useMemo(() => {
    if (!result?.structuredPatch) return 0;
    return result.structuredPatch.reduce(
      (sum, hunk) => sum + hunk.lines.length + 1, // +1 for hunk header
      0,
    );
  }, [result?.structuredPatch]);

  const isTruncated = totalLines > MAX_VISIBLE_LINES;

  // Compute change summary
  const changeSummary = useMemo(() => {
    if (!result?.structuredPatch) return null;
    const additions = result.structuredPatch
      .flatMap((h) => h.lines)
      .filter((l) => l.startsWith("+")).length;
    const deletions = result.structuredPatch
      .flatMap((h) => h.lines)
      .filter((l) => l.startsWith("-")).length;

    if (additions > 0 && deletions > 0) {
      return `Modified ${additions + deletions} lines`;
    }
    if (additions > 0) {
      return `Added ${additions} line${additions !== 1 ? "s" : ""}`;
    }
    if (deletions > 0) {
      return `Removed ${deletions} line${deletions !== 1 ? "s" : ""}`;
    }
    return null;
  }, [result?.structuredPatch]);

  if (isError) {
    // Extract error message - can be a string or object with content
    let errorMessage: string | null = null;
    if (typeof result === "string") {
      errorMessage = result;
    } else if (typeof result === "object" && result !== null) {
      const errorResult = result as { content?: unknown };
      if (errorResult.content) {
        errorMessage = String(errorResult.content);
      }
    }
    return (
      <div className="edit-result edit-result-error">
        <span className="badge badge-error">Edit failed</span>
        {errorMessage && (
          <div className="edit-error-message">{errorMessage}</div>
        )}
      </div>
    );
  }

  // Handle case where result doesn't have structuredPatch
  // Use input data as fallback when result data is missing
  if (!result?.structuredPatch || result.structuredPatch.length === 0) {
    const filePath = result?.filePath || input?.file_path;
    const oldString = result?.oldString || input?.old_string || "";
    const newString = result?.newString || input?.new_string || "";
    const isPlan = filePath ? isPlanFile(filePath) : false;

    return (
      <div className="edit-result">
        <div className="edit-header">
          <span className="file-path">
            {filePath ? getFileName(filePath) : "File"}
          </span>
          {isPlan && <span className="badge badge-muted">Plan</span>}
          {result?.userModified && (
            <span className="badge badge-info">User modified</span>
          )}
        </div>
        <div className="edit-simple">
          <div className="edit-old">
            <div className="edit-label">Removed:</div>
            <pre className="code-block">
              <code>{oldString || "(empty)"}</code>
            </pre>
          </div>
          <div className="edit-new">
            <div className="edit-label">Added:</div>
            <pre className="code-block">
              <code>{newString || "(empty)"}</code>
            </pre>
          </div>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="edit-result">
        {changeSummary && (
          <div className="edit-change-summary">{changeSummary}</div>
        )}
        {result.userModified && (
          <span className="badge badge-info">User modified</span>
        )}
        <div
          className={`diff-view-container ${isTruncated ? "truncated" : ""}`}
        >
          <div className="diff-view">
            {result.structuredPatch.map((hunk, i) => (
              <DiffHunk key={`hunk-${hunk.oldStart}-${i}`} hunk={hunk} />
            ))}
          </div>
          {isTruncated && (
            <>
              <div className="diff-fade-overlay" />
              <button
                type="button"
                className="diff-expand-button"
                onClick={(e) => {
                  e.stopPropagation();
                  setShowModal(true);
                }}
              >
                Click to expand
              </button>
            </>
          )}
        </div>
      </div>
      {showModal && (
        <Modal
          title={
            <span className="file-path">{getFileName(result.filePath)}</span>
          }
          onClose={() => setShowModal(false)}
        >
          <DiffModalContent result={result} />
        </Modal>
      )}
    </>
  );
}

export const editRenderer: ToolRenderer<EditInput, EditResult> = {
  tool: "Edit",

  renderToolUse(input, _context) {
    return <EditToolUse input={input as EditInput} />;
  },

  renderToolResult(result, isError, _context, input) {
    return (
      <EditToolResult
        result={result as EditResult}
        input={input as EditInput | undefined}
        isError={isError}
      />
    );
  },

  getUseSummary(input) {
    return getFileName((input as EditInput).file_path);
  },

  getResultSummary(result, isError) {
    if (isError) return "Failed";
    const r = result as EditResult;
    return r?.filePath ? getFileName(r.filePath) : "file";
  },

  renderCollapsedPreview(input, result, isError, _context) {
    return (
      <EditCollapsedPreview
        input={input as EditInput}
        result={result as EditResult | undefined}
        isError={isError}
      />
    );
  },
};
