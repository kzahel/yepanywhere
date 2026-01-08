import { useCallback, useEffect, useState } from "react";
import type { ZodError } from "zod";
import { useSchemaValidationContext } from "../../../contexts/SchemaValidationContext";
import { validateToolResult } from "../../../lib/validateToolResult";
import { SchemaWarning } from "../../SchemaWarning";
import { Modal } from "../../ui/Modal";
import type { BashInput, BashResult, ToolRenderer } from "./types";

const MAX_LINES_COLLAPSED = 20;
const PREVIEW_LINES = 4;
const PREVIEW_MAX_CHARS = 400; // 4 * 100 chars

/**
 * Normalize bash result - handles both structured objects and plain strings
 * SDK may return a plain string for errors instead of { stdout, stderr }
 */
function normalizeBashResult(
  result: BashResult | string | undefined,
  isError: boolean,
): BashResult {
  if (!result) {
    return { stdout: "", stderr: "", interrupted: false, isImage: false };
  }
  if (typeof result === "string") {
    // Plain string result - put in stderr if error, stdout otherwise
    return {
      stdout: isError ? "" : result,
      stderr: isError ? result : "",
      interrupted: false,
      isImage: false,
    };
  }
  return result;
}

/**
 * Modal content for viewing full bash input and output
 */
function BashModalContent({
  input,
  result: rawResult,
  isError,
}: {
  input: BashInput;
  result: BashResult | string | undefined;
  isError: boolean;
}) {
  // Normalize result to handle both structured and string formats
  const result = rawResult
    ? normalizeBashResult(rawResult, isError)
    : undefined;
  const stdout = result?.stdout || "";
  const stderr = result?.stderr || "";

  return (
    <div className="bash-modal-sections">
      <div className="bash-modal-section">
        <div className="bash-modal-label">Command</div>
        <div className="bash-modal-code">
          <pre className="code-block">
            <code>{input.command}</code>
          </pre>
        </div>
      </div>
      {stdout && (
        <div className="bash-modal-section">
          <div className="bash-modal-label">Output</div>
          <div className="bash-modal-code">
            <pre className="code-block">
              <code>{stdout}</code>
            </pre>
          </div>
        </div>
      )}
      {stderr && (
        <div className="bash-modal-section">
          <div className="bash-modal-label bash-modal-label-error">
            {isError ? "Error" : "Stderr"}
          </div>
          <div className="bash-modal-code bash-modal-code-error">
            <pre className="code-block code-block-error">
              <code>{stderr}</code>
            </pre>
          </div>
        </div>
      )}
      {!stdout && !stderr && result && !result.interrupted && (
        <div className="bash-modal-section">
          <div className="bash-modal-label">Output</div>
          <div className="bash-modal-empty">No output</div>
        </div>
      )}
      {result?.interrupted && (
        <div className="bash-modal-section">
          <span className="badge badge-warning">Interrupted</span>
        </div>
      )}
      {result?.backgroundTaskId && (
        <div className="bash-modal-section">
          <span className="badge badge-info">
            Background: {result.backgroundTaskId}
          </span>
        </div>
      )}
    </div>
  );
}

/**
 * Bash tool use - shows command in code block
 */
function BashToolUse({ input }: { input: BashInput }) {
  return (
    <div className="bash-tool-use">
      <pre className="code-block">
        <code>{input.command}</code>
      </pre>
    </div>
  );
}

/**
 * Bash tool result - shows stdout/stderr with collapse for long output
 */
function BashToolResult({
  result: rawResult,
  isError,
}: {
  result: BashResult | string;
  isError: boolean;
}) {
  const [isExpanded, setIsExpanded] = useState(false);
  const { enabled, reportValidationError, isToolIgnored } =
    useSchemaValidationContext();
  const [validationErrors, setValidationErrors] = useState<ZodError | null>(
    null,
  );

  // Normalize result to handle both structured and string formats
  const result = normalizeBashResult(rawResult, isError);

  useEffect(() => {
    if (enabled && rawResult && typeof rawResult === "object") {
      const validation = validateToolResult("Bash", rawResult);
      if (!validation.valid && validation.errors) {
        setValidationErrors(validation.errors);
        reportValidationError("Bash", validation.errors);
      } else {
        setValidationErrors(null);
      }
    }
  }, [enabled, rawResult, reportValidationError]);

  const showValidationWarning =
    enabled && validationErrors && !isToolIgnored("Bash");

  const stdout = result.stdout || "";
  const stderr = result.stderr || "";
  const stdoutLines = stdout.split("\n");
  const needsCollapse = stdoutLines.length > MAX_LINES_COLLAPSED;
  const displayStdout =
    needsCollapse && !isExpanded
      ? `${stdoutLines.slice(0, MAX_LINES_COLLAPSED).join("\n")}\n...`
      : stdout;

  return (
    <div className={`bash-result ${isError ? "bash-result-error" : ""}`}>
      {showValidationWarning && validationErrors && (
        <SchemaWarning toolName="Bash" errors={validationErrors} />
      )}
      {result?.interrupted && (
        <span className="badge badge-warning">Interrupted</span>
      )}
      {result?.backgroundTaskId && (
        <span className="badge badge-info">
          Background: {result.backgroundTaskId}
        </span>
      )}
      {stdout && (
        <div className="bash-stdout">
          <pre className="code-block">
            <code>{displayStdout}</code>
          </pre>
          {needsCollapse && (
            <button
              type="button"
              className="expand-button"
              onClick={() => setIsExpanded(!isExpanded)}
            >
              {isExpanded
                ? "Show less"
                : `Show all ${stdoutLines.length} lines`}
            </button>
          )}
        </div>
      )}
      {stderr && (
        <div className="bash-stderr">
          <pre className="code-block code-block-error">
            <code>{stderr}</code>
          </pre>
        </div>
      )}
      {!stdout && !stderr && !result?.interrupted && (
        <div className="bash-empty">No output</div>
      )}
    </div>
  );
}

/**
 * Truncate text to a maximum number of lines and characters
 */
function truncateOutput(text: string): { text: string; truncated: boolean } {
  const lines = text.split("\n");
  let result = "";
  let charCount = 0;
  let lineCount = 0;

  for (const line of lines) {
    if (lineCount >= PREVIEW_LINES || charCount >= PREVIEW_MAX_CHARS) {
      return { text: result.trimEnd(), truncated: true };
    }
    const remaining = PREVIEW_MAX_CHARS - charCount;
    if (line.length > remaining) {
      result += `${line.slice(0, remaining)}...`;
      return { text: result.trimEnd(), truncated: true };
    }
    result += `${line}\n`;
    charCount += line.length + 1;
    lineCount++;
  }

  return { text: result.trimEnd(), truncated: false };
}

/**
 * Collapsed preview showing IN (command) and OUT (first few lines)
 * Clicking opens a modal with the full output
 */
function BashCollapsedPreview({
  input,
  result: rawResult,
  isError,
}: {
  input: BashInput;
  result: BashResult | string | undefined;
  isError: boolean;
}) {
  const [isModalOpen, setIsModalOpen] = useState(false);
  const { enabled, reportValidationError, isToolIgnored } =
    useSchemaValidationContext();
  const [validationErrors, setValidationErrors] = useState<ZodError | null>(
    null,
  );

  // Normalize result to handle both structured and string formats
  const result = rawResult
    ? normalizeBashResult(rawResult, isError)
    : undefined;

  useEffect(() => {
    if (enabled && rawResult && typeof rawResult === "object") {
      const validation = validateToolResult("Bash", rawResult);
      if (!validation.valid && validation.errors) {
        setValidationErrors(validation.errors);
        reportValidationError("Bash", validation.errors);
      } else {
        setValidationErrors(null);
      }
    }
  }, [enabled, rawResult, reportValidationError]);

  const showValidationWarning =
    enabled && validationErrors && !isToolIgnored("Bash");

  const output = result?.stdout || result?.stderr || "";
  const { text: previewText, truncated } = truncateOutput(output);
  const hasOutput = previewText.length > 0;

  const handleClick = useCallback(() => {
    setIsModalOpen(true);
  }, []);

  const handleClose = useCallback(() => {
    setIsModalOpen(false);
  }, []);

  return (
    <>
      <button
        type="button"
        className="bash-collapsed-preview"
        onClick={handleClick}
      >
        <div className="bash-preview-row">
          <span className="bash-preview-label">IN</span>
          <code className="bash-preview-command">{input.command}</code>
          {showValidationWarning && validationErrors && (
            <SchemaWarning toolName="Bash" errors={validationErrors} />
          )}
        </div>
        {hasOutput && (
          <div className="bash-preview-row bash-preview-output-row">
            <span className="bash-preview-label">OUT</span>
            <div
              className={`bash-preview-output ${truncated ? "bash-preview-truncated" : ""} ${isError || result?.stderr ? "bash-preview-error" : ""}`}
            >
              <pre>
                <code>{previewText}</code>
              </pre>
              {truncated && <div className="bash-preview-fade" />}
            </div>
          </div>
        )}
        {!hasOutput && result && !result.interrupted && (
          <div className="bash-preview-row">
            <span className="bash-preview-label">OUT</span>
            <span className="bash-preview-empty">No output</span>
          </div>
        )}
        {result?.interrupted && (
          <div className="bash-preview-row">
            <span className="bash-preview-label">OUT</span>
            <span className="bash-preview-interrupted">Interrupted</span>
          </div>
        )}
      </button>
      {isModalOpen && (
        <Modal
          title={input.description || "Bash Command"}
          onClose={handleClose}
        >
          <BashModalContent input={input} result={result} isError={isError} />
        </Modal>
      )}
    </>
  );
}

export const bashRenderer: ToolRenderer<BashInput, BashResult> = {
  tool: "Bash",

  renderToolUse(input, _context) {
    return <BashToolUse input={input as BashInput} />;
  },

  renderToolResult(result, isError, _context) {
    return <BashToolResult result={result as BashResult} isError={isError} />;
  },

  getUseSummary(input) {
    const i = input as BashInput;
    // Show description if available, otherwise truncated command
    if (i.description) {
      return i.description;
    }
    return i.command.length > 60 ? `${i.command.slice(0, 57)}...` : i.command;
  },

  getResultSummary(result, isError) {
    const r = result as BashResult;
    if (r?.interrupted) return "Interrupted";
    if (isError || r?.stderr) return "Error";
    // Return empty string - the preview shows the output
    return "";
  },

  renderCollapsedPreview(input, result, isError, _context) {
    return (
      <BashCollapsedPreview
        input={input as BashInput}
        result={result as BashResult | undefined}
        isError={isError}
      />
    );
  },
};
