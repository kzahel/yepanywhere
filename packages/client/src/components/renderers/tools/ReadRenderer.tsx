import { toolDisplayContracts } from "./toolDisplayContracts";
import { defineTool } from "./defineTool";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import type { ZodError } from "zod";
import { useSchemaValidationContext } from "../../../contexts/SchemaValidationContext";
import { useOptionalSessionMetadata } from "../../../contexts/SessionMetadataContext";
import { useCurrentSourceRuntime } from "../../../contexts/SourceRuntimeContext";
import { useI18n } from "../../../i18n";
import { useInlineMedia } from "../../../hooks/useInlineMedia";
import { useQuoteableTextSource } from "../../../hooks/useQuoteableTextSource";
import { useRemoteImage } from "../../../hooks/useRemoteImage";
import { isMarkdownLikeFile } from "../../../lib/markdownFiles";
import { useScrollPreservingToggle } from "../../../lib/scrollAnchor";
import { getPathBasename, makeDisplayPath } from "../../../lib/text";
import { validateToolResult } from "../../../lib/validateToolResult";
import {
  FILE_MARKDOWN_PREVIEW_BASE_DENSITY,
  MarkdownPreview,
} from "../../MarkdownPreview";
import { useImageResourceActions } from "../../ImageResourceActions";
import {
  fetchLocalMediaBlob,
  LocalMediaModal,
  type LocalMediaSource,
  useLocalFileScope,
} from "../../LocalMediaModal";
import { SchemaWarning } from "../../SchemaWarning";
import { ShikiHtml } from "../../ShikiHtml";
import { SessionFilePathLink } from "../../SessionFilePathLink";
import {
  FixedFontMathToggle,
  renderFixedFontMath,
  renderFixedFontRichContent,
} from "../../ui/FixedFontMathToggle";
import { InnerHtml } from "../../ui/InnerHtml";
import { ButtonBase, IconButton } from "../../ui/Button";
import { RenderModeGlyph } from "../../ui/RenderModeGlyph";
import type {
  ImageFile,
  PdfFile,
  ReadInput,
  ReadResult,
  TextFile,
} from "./types";
import styles from "./ReadRenderer.module.css";

/** Extended result type with server-rendered syntax highlighting */
type ReadResultWithAugment = ReadResult;

/**
 * Extract filename from path
 */
function getFileName(filePath: string): string {
  return getPathBasename(filePath);
}

/** Narrow the checked union without parsing the record again. */
function isCompleteTextFile(file: ReadResult["file"]): file is TextFile {
  return "content" in file && typeof file.content === "string";
}
function getResultFilePath(file: ReadResult["file"]): string {
  return "filePath" in file ? (file.filePath ?? "") : "";
}

/**
 * Read-dedup result: a non-error Read whose `file` omits content/lines because
 * the file was unchanged since the last Read. Render the link plus an
 * "unchanged" marker rather than implying an empty file.
 */
function ReadUnchangedResult({ filePath }: { filePath: string }) {
  const meta = useOptionalSessionMetadata();
  const displayPath = makeDisplayPath(filePath, meta?.projectPath);
  return (
    <div className="read-text-result read-text-inline">
      <ReadFilePathSummary displayPath={displayPath} filePath={filePath}>
        <span className="file-line-count-inline">unchanged</span>
      </ReadFilePathSummary>
    </div>
  );
}

function getReadLineRange(file: TextFile): {
  lineEnd?: number;
  lineNumber?: number;
} {
  if (file.numLines <= 0) {
    return {};
  }
  const hasRange = file.startLine > 1 || file.numLines < file.totalLines;
  if (!hasRange) {
    return {};
  }
  const lineEnd = file.startLine + Math.max(1, file.numLines) - 1;
  return {
    lineEnd: lineEnd > file.startLine ? lineEnd : undefined,
    lineNumber: file.startLine,
  };
}

function getReadInputLineRange(input: ReadInput): {
  lineEnd?: number;
  lineNumber?: number;
} {
  if (input.offset === undefined) {
    return {};
  }
  const lineEnd =
    input.limit !== undefined
      ? input.offset + Math.max(1, input.limit) - 1
      : undefined;
  return {
    lineEnd:
      lineEnd !== undefined && lineEnd > input.offset ? lineEnd : undefined,
    lineNumber: input.offset,
  };
}

function renderReadMathPanel(html: string) {
  return (
    <div className="file-viewer-code fixed-font-rendered-panel">
      {/* KaTeX output is trusted HTML from local rendering. */}
      <InnerHtml className="fixed-font-rendered__content" trustedHtml={html} />
    </div>
  );
}

function ReadFilePathSummary({
  children,
  displayPath,
  filePath,
  lineEnd,
  lineNumber,
}: {
  children?: ReactNode;
  displayPath: string;
  filePath: string;
  lineEnd?: number;
  lineNumber?: number;
}) {
  return (
    <span className="file-link-inline">
      <SessionFilePathLink
        displayPath={displayPath}
        filePath={filePath}
        lineEnd={lineEnd}
        lineNumber={lineNumber}
      />
      {children && <> {children}</>}
    </span>
  );
}

function ReadRangeLink({
  filePath,
  lineEnd,
  lineNumber,
  text,
}: {
  filePath: string;
  lineEnd?: number;
  lineNumber?: number;
  text: string;
}) {
  return (
    <SessionFilePathLink
      displayPath={text}
      filePath={filePath}
      lineEnd={lineEnd}
      lineNumber={lineNumber}
      showLineSuffix={false}
      viewMode="range"
      showCopyButton={false}
      showVersionControlLinks={false}
    />
  );
}

/**
 * Read tool use - shows file path being read
 */
function ReadToolUse({ input }: { input: ReadInput }) {
  const meta = useOptionalSessionMetadata();
  const displayPath = makeDisplayPath(input.file_path, meta?.projectPath);
  const lineRange = getReadInputLineRange(input);
  return (
    <div className="read-tool-use">
      <span className="file-path">
        <SessionFilePathLink
          displayPath={displayPath}
          filePath={input.file_path}
          lineEnd={lineRange.lineEnd}
          lineNumber={lineRange.lineNumber}
        />
      </span>
      {(input.offset !== undefined || input.limit !== undefined) && (
        <span
          className="read-range"
          title={`offset ${input.offset ?? 0}, limit ${input.limit ?? "∞"}`}
        >
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
  const isMarkdown = isMarkdownLikeFile(file.filePath);
  const clientMarkdownPreview = useMemo(() => {
    if (!isMarkdown || renderedMarkdownHtml) {
      return null;
    }
    const rendered = renderFixedFontRichContent(file.content, {
      baseFilePath: file.filePath,
    });
    return rendered.changed ? rendered.html : null;
  }, [file.content, file.filePath, isMarkdown, renderedMarkdownHtml]);
  const markdownHtml = isMarkdown
    ? (renderedMarkdownHtml ?? clientMarkdownPreview)
    : null;
  const hasMarkdownPreview = !!markdownHtml;
  const [showPreview, setShowPreview] = useState(false);
  const quoteSourceRef = useQuoteableTextSource<HTMLDivElement>(
    highlightedHtml || (showPreview && markdownHtml) ? file.content : null,
  );

  // For Shiki-highlighted code files: offer KaTeX-only math rendering (default off).
  // Uses renderFixedFontMath (not renderFixedFontRichContent) so markdown structural
  // transforms (headings, lists, tables) are never applied to source code.
  const mathRendered = useMemo(
    () => (highlightedHtml ? renderFixedFontMath(file.content) : null),
    [highlightedHtml, file.content],
  );
  const hasMathToggle = !!mathRendered?.changed;
  const [showMath, setShowMath] = useState(false);
  const { btnRef: mathBtnRef, handleClick: handleMathToggle } =
    useScrollPreservingToggle(showMath, () => setShowMath((v) => !v));

  const lines = file.content.length > 0 ? file.content.split("\n") : [];

  const sourceView =
    file.content.length === 0 ? (
      <div className="file-viewer-empty-content">No content read</div>
    ) : highlightedHtml ? (
      <div className="file-viewer-code file-viewer-code-highlighted">
        <ShikiHtml html={highlightedHtml} />
        {highlightedTruncated && (
          <div className="file-viewer-truncated">
            Content truncated for highlighting (showing first 2000 lines)
          </div>
        )}
      </div>
    ) : (
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
    );

  const content =
    showPreview && markdownHtml ? (
      <MarkdownPreview
        html={markdownHtml}
        sourcePath={file.filePath}
        density={FILE_MARKDOWN_PREVIEW_BASE_DENSITY}
      />
    ) : highlightedHtml ? (
      // Code file: show math-rendered plain text when toggled on, Shiki otherwise.
      // Math mode loses syntax colouring intentionally — you asked for the formula.
      showMath && mathRendered ? (
        renderReadMathPanel(mathRendered.html)
      ) : (
        sourceView
      )
    ) : (
      // Filename-affiliated non-Markdown files use math-only rendering to avoid
      // treating source-code backticks, arrays, or operators as Markdown.
      <FixedFontMathToggle
        sourceText={file.content}
        renderMode={isMarkdown ? "rich" : "math"}
        sourceView={sourceView}
        renderRenderedView={(html) => renderReadMathPanel(html)}
      />
    );

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
  const showSigma = !hasMarkdownPreview && hasMathToggle;

  return (
    <div className="file-content-modal" ref={quoteSourceRef}>
      {toggleButton}
      {showSigma ? (
        <div className="fixed-font-render-toggle">
          {content}
          <IconButton
            ref={mathBtnRef}
            variant="outline"
            size="small"
            className={`fixed-font-render-toggle__button ${showMath ? "is-rendered" : ""}`}
            onClick={handleMathToggle}
            label={showMath ? "Show source" : "Render math (LaTeX)"}
            aria-pressed={showMath}
          >
            <RenderModeGlyph />
          </IconButton>
        </div>
      ) : (
        content
      )}
    </div>
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
  const meta = useOptionalSessionMetadata();
  const displayPath = makeDisplayPath(file.filePath, meta?.projectPath);
  const hasReadLines = file.numLines > 0;
  const showRange =
    hasReadLines && (file.startLine > 1 || file.numLines < file.totalLines);
  const lineRange = getReadLineRange(file);

  return (
    <div className="read-text-result read-text-inline">
      <div className="file-range-inline">
        <SessionFilePathLink
          displayPath={displayPath}
          filePath={file.filePath}
          lineEnd={lineRange.lineEnd}
          lineNumber={lineRange.lineNumber}
        />
      </div>
      {showRange && (
        <div className="file-range-inline">
          <ReadRangeLink
            filePath={file.filePath}
            lineEnd={lineRange.lineEnd}
            lineNumber={lineRange.lineNumber}
            text={`lines ${file.startLine}–${file.startLine + file.numLines - 1}`}
          />{" "}
          of {file.totalLines}
        </div>
      )}
      {!hasReadLines && (
        <div className="file-range-inline">
          <span className="file-line-count-inline">0 lines</span>
          {file.totalLines > 0 && <> of {file.totalLines}</>}
        </div>
      )}
      <FileModalContent
        file={file}
        highlightedHtml={highlightedHtml}
        highlightedTruncated={highlightedTruncated}
        renderedMarkdownHtml={renderedMarkdownHtml}
      />
    </div>
  );
}

function blobFromBase64(base64: string, type: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new Blob([bytes], { type });
}

/**
 * Image file result - renders as img tag
 */
function ImageFileResult({
  file,
  filePath,
}: {
  file: ImageFile;
  filePath?: string;
}) {
  const { t } = useI18n();
  const sizeKB = file.originalSize ? Math.round(file.originalSize / 1024) : 0;
  const { dimensions } = file;
  const meta = useOptionalSessionMetadata();
  const displayPath = filePath
    ? makeDisplayPath(filePath, meta?.projectPath)
    : null;
  const hasDimensions =
    dimensions?.originalWidth != null && dimensions?.originalHeight != null;

  // Respect the "Expand Inline Media by Default" appearance setting. Like the
  // markdown/transcript media previews, start collapsed unless the user opts in,
  // and let the setting drive expansion until the user toggles this preview.
  const { inlineMediaExpandedByDefault } = useInlineMedia();
  const [override, setOverride] = useState<boolean | null>(null);
  const expanded = override ?? inlineMediaExpandedByDefault;
  const [modalOpen, setModalOpen] = useState(false);
  const transport = useCurrentSourceRuntime().transport;
  const fileScope = useLocalFileScope();
  // Provider bytes survive only until YA materializes tool-result media, after
  // which the result carries metadata and a path. Read the file back for those
  // rows rather than showing a broken preview.
  const inlineBase64 = file.base64;
  const loadBlob = useCallback(async () => {
    if (inlineBase64) return blobFromBase64(inlineBase64, file.type);
    if (filePath) {
      return fetchLocalMediaBlob(
        filePath,
        undefined,
        "inline",
        transport,
        fileScope,
      );
    }
    throw new Error("Read image result carries neither bytes nor a file path");
  }, [file.type, filePath, inlineBase64, transport, fileScope]);
  const mediaSource = useMemo<LocalMediaSource | undefined>(
    () =>
      inlineBase64
        ? { buildApiPath: () => "inline-read-image", fetchBlob: loadBlob }
        : undefined,
    [inlineBase64, loadBlob],
  );
  // Bytes already in hand render without a fetch; a materialized result reads
  // its file back through the shared image loader.
  const inlineDataUrl = inlineBase64
    ? `data:${file.type};base64,${inlineBase64}`
    : null;
  const { url: fetchedPreviewUrl, error: previewError } = useRemoteImage(
    filePath ?? null,
    expanded && !inlineBase64,
    loadBlob,
  );
  const previewUrl = inlineDataUrl ?? fetchedPreviewUrl;
  const openViewer = useCallback(() => setModalOpen(true), []);
  const fileName = filePath ? getFileName(filePath) : "image";
  const imageActions = useImageResourceActions({
    fileName,
    filePath,
    loadBlob,
    onOpen: openViewer,
  });

  return (
    <div className="read-image-result">
      <div className="local-media-link-group">
        <ButtonBase
          className="local-media-inline-toggle"
          aria-expanded={expanded}
          aria-label={expanded ? "Collapse image" : "Expand image"}
          title={expanded ? "Collapse inline preview" : "Expand inline preview"}
          onClick={() => setOverride(!expanded)}
        >
          {expanded ? "-" : "+"}
        </ButtonBase>
        {filePath && displayPath ? (
          <span className="file-range-inline">
            <SessionFilePathLink
              displayPath={displayPath}
              filePath={filePath}
            />
          </span>
        ) : (
          <span className="local-media-type">image</span>
        )}
      </div>
      {(hasDimensions || sizeKB > 0) && (
        <div className="image-info">
          {hasDimensions && (
            <>
              {dimensions.originalWidth}x{dimensions.originalHeight}
            </>
          )}
          {hasDimensions && sizeKB > 0 && " "}
          {sizeKB > 0 && (
            <>
              ({sizeKB}
              {"\u202f"}kb)
            </>
          )}
        </div>
      )}
      {expanded &&
        (previewUrl ? (
          <ButtonBase
            className={styles.imagePreviewButton}
            aria-label={`Open ${fileName}`}
            onClick={openViewer}
            onContextMenu={imageActions.handleContextMenu}
          >
            <img
              className="read-image"
              src={previewUrl}
              alt="File content"
              width={dimensions?.displayWidth}
              height={dimensions?.displayHeight}
            />
          </ButtonBase>
        ) : (
          <span className="file-line-count-inline">
            {previewError
              ? t("inlineImageUnavailable")
              : t("inlineImageLoading")}
          </span>
        ))}
      {modalOpen ? (
        <LocalMediaModal
          path={inlineBase64 ? fileName : (filePath ?? fileName)}
          filePath={filePath ?? null}
          mediaType="image"
          mediaSource={mediaSource}
          onClose={() => setModalOpen(false)}
        />
      ) : null}
      {imageActions.contextMenuElement}
    </div>
  );
}

const PDF_TAB_OBJECT_URL_LIFETIME_MS = 60_000;

/**
 * Open base64 PDF data in a new browser tab
 */
function openPdfInNewTab(base64Data: string) {
  const byteChars = atob(base64Data);
  const byteArray = new Uint8Array(byteChars.length);
  for (let i = 0; i < byteChars.length; i++) {
    byteArray[i] = byteChars.charCodeAt(i);
  }
  const blob = new Blob([byteArray], { type: "application/pdf" });
  const url = URL.createObjectURL(blob);
  window.open(url, "_blank");
  // The new tab resolves the URL asynchronously, so revoking at once could
  // leave it nothing to load; a loaded document keeps its own reference.
  setTimeout(() => URL.revokeObjectURL(url), PDF_TAB_OBJECT_URL_LIFETIME_MS);
}

/**
 * PDF file result - button to open in new tab
 */
function PdfFileResult({
  file,
  filePath,
}: {
  file: PdfFile;
  filePath?: string;
}) {
  const sizeKB = file.originalSize ? Math.round(file.originalSize / 1024) : 0;
  const fileName = filePath ? getFileName(filePath) : "document.pdf";
  const meta = useOptionalSessionMetadata();
  const displayPath = filePath
    ? makeDisplayPath(filePath, meta?.projectPath)
    : null;

  if (filePath && displayPath) {
    return (
      <div className="read-pdf-result">
        <ReadFilePathSummary displayPath={displayPath} filePath={filePath}>
          {sizeKB > 0 && (
            <span className="file-line-count-inline">
              ({sizeKB}
              {"\u202f"}kb)
            </span>
          )}
          <span className="file-line-count-inline">PDF</span>
        </ReadFilePathSummary>
      </div>
    );
  }

  const base64 = file.base64;
  if (!base64) {
    return (
      <div className="read-pdf-result">
        <span className="file-line-count-inline">PDF</span>
      </div>
    );
  }

  return (
    <div className="read-pdf-result">
      <ButtonBase
        className="file-link-button"
        onClick={() => openPdfInNewTab(base64)}
      >
        {fileName}
        {sizeKB > 0 && (
          <span className="file-line-count">
            ({sizeKB}
            {"\u202f"}kb)
          </span>
        )}
        <span className="file-line-count">Open PDF</span>
      </ButtonBase>
    </div>
  );
}

/**
 * Read tool result - dispatches to text or image handler
 */
function ReadToolResult({
  input,
  result,
}: {
  input?: ReadInput;
  result: ReadResultWithAugment;
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

  if (!result?.file) {
    return (
      <div className="read-error">
        {showValidationWarning && validationErrors && (
          <SchemaWarning toolName="Read" errors={validationErrors} />
        )}
        Failed to read file
      </div>
    );
  }

  if (result.type === "pdf") {
    return (
      <>
        {showValidationWarning && validationErrors && (
          <SchemaWarning toolName="Read" errors={validationErrors} />
        )}
        <PdfFileResult
          file={result.file}
          filePath={input?.file_path ?? result.file.filePath}
        />
      </>
    );
  }

  if (result.type === "image") {
    return (
      <>
        {showValidationWarning && validationErrors && (
          <SchemaWarning toolName="Read" errors={validationErrors} />
        )}
        <ImageFileResult
          file={result.file}
          filePath={input?.file_path ?? result.file.filePath}
        />
      </>
    );
  }

  if (!isCompleteTextFile(result.file)) {
    return (
      <>
        {showValidationWarning && validationErrors && (
          <SchemaWarning toolName="Read" errors={validationErrors} />
        )}
        <ReadUnchangedResult
          filePath={getResultFilePath(result.file) || (input?.file_path ?? "")}
        />
      </>
    );
  }

  return (
    <>
      {showValidationWarning && validationErrors && (
        <SchemaWarning toolName="Read" errors={validationErrors} />
      )}
      <TextFileResult
        file={result.file}
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

  const meta = useOptionalSessionMetadata();
  const displayPath = makeDisplayPath(input.file_path, meta?.projectPath);

  if (isError) {
    return (
      <span>
        <SessionFilePathLink
          displayPath={displayPath}
          filePath={input.file_path}
        />
        {showValidationWarning && validationErrors && (
          <SchemaWarning toolName="Read" errors={validationErrors} />
        )}
      </span>
    );
  }

  if (!result?.file) {
    return (
      <span>
        <SessionFilePathLink
          displayPath={displayPath}
          filePath={input.file_path}
        />
      </span>
    );
  }

  if (result.type === "pdf") {
    return (
      <ReadFilePathSummary displayPath={displayPath} filePath={input.file_path}>
        <span className="file-line-count-inline">(PDF)</span>
        {showValidationWarning && validationErrors && (
          <SchemaWarning toolName="Read" errors={validationErrors} />
        )}
      </ReadFilePathSummary>
    );
  }

  if (result.type === "image") {
    return (
      <ReadFilePathSummary displayPath={displayPath} filePath={input.file_path}>
        <span className="file-line-count-inline">(image)</span>
        {showValidationWarning && validationErrors && (
          <SchemaWarning toolName="Read" errors={validationErrors} />
        )}
      </ReadFilePathSummary>
    );
  }

  if (!isCompleteTextFile(result.file)) {
    return (
      <ReadFilePathSummary displayPath={displayPath} filePath={input.file_path}>
        <span className="file-line-count-inline">unchanged</span>
        {showValidationWarning && validationErrors && (
          <SchemaWarning toolName="Read" errors={validationErrors} />
        )}
      </ReadFilePathSummary>
    );
  }

  const file = result.file;

  if (file.numLines <= 0) {
    return (
      <ReadFilePathSummary displayPath={displayPath} filePath={file.filePath}>
        <span className="file-line-count-inline">0 lines</span>
        {showValidationWarning && validationErrors && (
          <SchemaWarning toolName="Read" errors={validationErrors} />
        )}
      </ReadFilePathSummary>
    );
  }

  return (
    <ReadFilePathSummary
      displayPath={displayPath}
      filePath={file.filePath}
      {...getReadLineRange(file)}
    >
      <span className="file-line-count-inline">
        <ReadRangeLink
          filePath={file.filePath}
          text={`${file.numLines} lines`}
          {...getReadLineRange(file)}
        />
      </span>
      {showValidationWarning && validationErrors && (
        <SchemaWarning toolName="Read" errors={validationErrors} />
      )}
    </ReadFilePathSummary>
  );
}

export const readRenderer = defineTool(toolDisplayContracts.Read, {
  tool: "Read",

  renderToolUse(input, _context) {
    return <ReadToolUse input={input} />;
  },

  renderToolResult(result, _isError, _context, input) {
    return <ReadToolResult input={input} result={result} />;
  },

  renderFailure(failure) {
    return (
      <div className="read-error">
        {failure.content || "Failed to read file"}
      </div>
    );
  },

  getFailureSummary(_failure, input) {
    return input ? getFileName(input.file_path) : "Error";
  },

  getUseSummary(input) {
    return getFileName(input.file_path);
  },

  getResultSummary(result) {
    const r = result;
    if (!r?.file) return "Reading...";
    if (r.type === "pdf") return "PDF";
    if (r.type === "image") return "Image";
    if (!isCompleteTextFile(r.file)) return "unchanged";
    return r.file.numLines <= 0 ? "0 lines" : getFileName(r.file.filePath);
  },

  renderInteractiveSummary(input, result, isError, _context) {
    return (
      <ReadInteractiveSummary input={input} result={result} isError={isError} />
    );
  },
});
