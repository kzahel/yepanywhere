import { useEffect, useState } from "react";
import type { ZodError } from "zod";
import { useSchemaValidationContext } from "../../../contexts/SchemaValidationContext";
import { validateToolResult } from "../../../lib/validateToolResult";
import { SchemaWarning } from "../../SchemaWarning";
import { Modal } from "../../ui/Modal";
import type {
  ImageFile,
  ReadInput,
  ReadResult,
  TextFile,
  ToolRenderer,
} from "./types";

/** Extended result type with server-rendered syntax highlighting */
interface ReadResultWithAugment extends ReadResult {
  _highlightedContentHtml?: string;
  _highlightedLanguage?: string;
  _highlightedTruncated?: boolean;
  _renderedMarkdownHtml?: string;
}

/**
 * Extract filename from path
 */
function getFileName(filePath: string): string {
  return filePath.split("/").pop() || filePath;
}

/**
 * Read tool use - shows file path being read
 */
function ReadToolUse({ input }: { input: ReadInput }) {
  const fileName = getFileName(input.file_path);
  return (
    <div className="read-tool-use">
      <span className="file-path">{fileName}</span>
      {(input.offset !== undefined || input.limit !== undefined) && (
        <span className="read-range">
          {input.offset !== undefined && ` from line ${input.offset}`}
          {input.limit !== undefined && ` (${input.limit} lines)`}
        </span>
      )}
    </div>
  );
}

/**
 * Modal content for viewing file contents
 */
function FileModalContent({
  file,
  highlightedHtml,
  highlightedTruncated,
  renderedMarkdownHtml,
}: {
  file: TextFile;
  highlightedHtml?: string;
  highlightedTruncated?: boolean;
  renderedMarkdownHtml?: string;
}) {
  const [showPreview, setShowPreview] = useState(false);
  const lines = file.content.split("\n");
  const hasMarkdownPreview = !!renderedMarkdownHtml;

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
  if (showPreview && renderedMarkdownHtml) {
    return (
      <div className="file-content-modal">
        {toggleButton}
        <div className="markdown-preview">
          <div
            className="markdown-rendered"
            // biome-ignore lint/security/noDangerouslySetInnerHtml: server-rendered HTML
            dangerouslySetInnerHTML={{ __html: renderedMarkdownHtml }}
          />
        </div>
      </div>
    );
  }

  // Use highlighted HTML if available
  if (highlightedHtml) {
    return (
      <div className="file-content-modal">
        {toggleButton}
        <div className="file-viewer-code file-viewer-code-highlighted">
          <div
            className="shiki-container"
            // biome-ignore lint/security/noDangerouslySetInnerHtml: server-rendered HTML
            dangerouslySetInnerHTML={{ __html: highlightedHtml }}
          />
          {highlightedTruncated && (
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
 * Build modal title for file with optional range info
 */
function FileModalTitle({ file }: { file: TextFile }) {
  const fileName = getFileName(file.filePath);
  const showRange = file.startLine > 1 || file.numLines < file.totalLines;

  return (
    <span className="file-path">
      {fileName}
      {showRange && (
        <span className="file-range">
          {" "}
          (lines {file.startLine}-{file.startLine + file.numLines - 1} of{" "}
          {file.totalLines})
        </span>
      )}
    </span>
  );
}

/**
 * Text file result - clickable filename that opens modal
 */
function TextFileResult({
  file,
  highlightedHtml,
  highlightedTruncated,
  renderedMarkdownHtml,
}: {
  file: TextFile;
  highlightedHtml?: string;
  highlightedTruncated?: boolean;
  renderedMarkdownHtml?: string;
}) {
  const [showModal, setShowModal] = useState(false);
  const fileName = getFileName(file.filePath);
  const showRange = file.startLine > 1 || file.numLines < file.totalLines;

  return (
    <>
      <div className="read-text-result">
        <button
          type="button"
          className="file-link-button"
          onClick={() => setShowModal(true)}
        >
          {fileName}
          {showRange && (
            <span className="file-range">
              {" "}
              (lines {file.startLine}-{file.startLine + file.numLines - 1})
            </span>
          )}
          <span className="file-line-count">{file.numLines} lines</span>
        </button>
      </div>
      {showModal && (
        <Modal
          title={<FileModalTitle file={file} />}
          onClose={() => setShowModal(false)}
        >
          <FileModalContent
            file={file}
            highlightedHtml={highlightedHtml}
            highlightedTruncated={highlightedTruncated}
            renderedMarkdownHtml={renderedMarkdownHtml}
          />
        </Modal>
      )}
    </>
  );
}

/**
 * Image file result - renders as img tag
 */
function ImageFileResult({ file }: { file: ImageFile }) {
  const sizeKB = file.originalSize ? Math.round(file.originalSize / 1024) : 0;
  const { dimensions } = file;
  const hasDimensions =
    dimensions?.originalWidth != null && dimensions?.originalHeight != null;

  return (
    <div className="read-image-result">
      {(hasDimensions || sizeKB > 0) && (
        <div className="image-info">
          {hasDimensions && (
            <>
              {dimensions.originalWidth}x{dimensions.originalHeight}
            </>
          )}
          {hasDimensions && sizeKB > 0 && " "}
          {sizeKB > 0 && <>({sizeKB}KB)</>}
        </div>
      )}
      <img
        className="read-image"
        src={`data:${file.type};base64,${file.base64}`}
        alt="File content"
        width={dimensions?.displayWidth}
        height={dimensions?.displayHeight}
      />
    </div>
  );
}

/**
 * Read tool result - dispatches to text or image handler
 */
function ReadToolResult({
  result,
  isError,
}: {
  result: ReadResultWithAugment;
  isError: boolean;
}) {
  const { enabled, reportValidationError, isToolIgnored } =
    useSchemaValidationContext();
  const [validationErrors, setValidationErrors] = useState<ZodError | null>(
    null,
  );

  useEffect(() => {
    if (enabled && result) {
      const validation = validateToolResult("Read", result);
      if (!validation.valid && validation.errors) {
        setValidationErrors(validation.errors);
        reportValidationError("Read", validation.errors);
      } else {
        setValidationErrors(null);
      }
    }
  }, [enabled, result, reportValidationError]);

  const showValidationWarning =
    enabled && validationErrors && !isToolIgnored("Read");

  if (isError || !result?.file) {
    const errorResult = result as unknown as { content?: unknown } | undefined;
    return (
      <div className="read-error">
        {showValidationWarning && validationErrors && (
          <SchemaWarning toolName="Read" errors={validationErrors} />
        )}
        {typeof result === "object" && errorResult?.content
          ? String(errorResult.content)
          : "Failed to read file"}
      </div>
    );
  }

  if (result.type === "image") {
    return (
      <>
        {showValidationWarning && validationErrors && (
          <SchemaWarning toolName="Read" errors={validationErrors} />
        )}
        <ImageFileResult file={result.file as ImageFile} />
      </>
    );
  }

  return (
    <>
      {showValidationWarning && validationErrors && (
        <SchemaWarning toolName="Read" errors={validationErrors} />
      )}
      <TextFileResult
        file={result.file as TextFile}
        highlightedHtml={result._highlightedContentHtml}
        highlightedTruncated={result._highlightedTruncated}
        renderedMarkdownHtml={result._renderedMarkdownHtml}
      />
    </>
  );
}

/**
 * Interactive summary for Read tool - clickable filename that opens modal
 */
function ReadInteractiveSummary({
  input,
  result,
  isError,
}: {
  input: ReadInput;
  result: ReadResultWithAugment | undefined;
  isError: boolean;
}) {
  const [showModal, setShowModal] = useState(false);
  const { enabled, reportValidationError, isToolIgnored } =
    useSchemaValidationContext();
  const [validationErrors, setValidationErrors] = useState<ZodError | null>(
    null,
  );

  useEffect(() => {
    if (enabled && result) {
      const validation = validateToolResult("Read", result);
      if (!validation.valid && validation.errors) {
        setValidationErrors(validation.errors);
        reportValidationError("Read", validation.errors);
      } else {
        setValidationErrors(null);
      }
    }
  }, [enabled, result, reportValidationError]);

  const showValidationWarning =
    enabled && validationErrors && !isToolIgnored("Read");

  const fileName = getFileName(input.file_path);

  if (isError) {
    return (
      <span>
        {fileName}
        {showValidationWarning && validationErrors && (
          <SchemaWarning toolName="Read" errors={validationErrors} />
        )}
      </span>
    );
  }

  if (!result?.file) {
    return <span>{fileName}</span>;
  }

  if (result.type === "image") {
    const imageFile = result.file as ImageFile;
    return (
      <>
        <button
          type="button"
          className="file-link-inline"
          onClick={(e) => {
            e.stopPropagation();
            setShowModal(true);
          }}
        >
          {fileName}
          <span className="file-line-count-inline">(image)</span>
          {showValidationWarning && validationErrors && (
            <SchemaWarning toolName="Read" errors={validationErrors} />
          )}
        </button>
        {showModal && (
          <Modal title={fileName} onClose={() => setShowModal(false)}>
            <ImageFileResult file={imageFile} />
          </Modal>
        )}
      </>
    );
  }

  const file = result.file as TextFile;

  return (
    <>
      <button
        type="button"
        className="file-link-inline"
        onClick={(e) => {
          e.stopPropagation();
          setShowModal(true);
        }}
      >
        {fileName}
        <span className="file-line-count-inline">{file.numLines} lines</span>
        {showValidationWarning && validationErrors && (
          <SchemaWarning toolName="Read" errors={validationErrors} />
        )}
      </button>
      {showModal && (
        <Modal
          title={<FileModalTitle file={file} />}
          onClose={() => setShowModal(false)}
        >
          <FileModalContent
            file={file}
            highlightedHtml={result._highlightedContentHtml}
            highlightedTruncated={result._highlightedTruncated}
            renderedMarkdownHtml={result._renderedMarkdownHtml}
          />
        </Modal>
      )}
    </>
  );
}

export const readRenderer: ToolRenderer<ReadInput, ReadResult> = {
  tool: "Read",

  renderToolUse(input, _context) {
    return <ReadToolUse input={input as ReadInput} />;
  },

  renderToolResult(result, isError, _context) {
    return (
      <ReadToolResult
        result={result as ReadResultWithAugment}
        isError={isError}
      />
    );
  },

  getUseSummary(input) {
    return getFileName((input as ReadInput).file_path);
  },

  getResultSummary(result, isError, input?) {
    if (isError && input) return getFileName((input as ReadInput).file_path);
    if (isError) return "Error";
    const r = result as ReadResult;
    if (!r?.file) return "Reading...";
    const fileName = getFileName(
      r.type === "image" ? "image" : (r.file as TextFile).filePath,
    );
    if (r.type === "image") return "Image";
    return fileName;
  },

  renderInteractiveSummary(input, result, isError, _context) {
    return (
      <ReadInteractiveSummary
        input={input as ReadInput}
        result={result as ReadResultWithAugment | undefined}
        isError={isError}
      />
    );
  },
};
