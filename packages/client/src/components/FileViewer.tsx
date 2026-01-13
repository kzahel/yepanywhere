import type { FileContentResponse } from "@yep-anywhere/shared";
import { memo, useCallback, useEffect, useState } from "react";
import { api } from "../api/client";

interface FileViewerProps {
  projectId: string;
  filePath: string;
  onClose?: () => void;
  /** If true, renders as standalone page layout instead of modal content */
  standalone?: boolean;
  /** Line number to scroll to and highlight (1-indexed) */
  lineNumber?: number;
  /** End line for range highlighting (1-indexed). If not provided, only lineNumber is highlighted. */
  lineEnd?: number;
}

/**
 * Format file size for display.
 */
function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Get language hint from file extension for potential future syntax highlighting.
 */
function getLanguageFromPath(filePath: string): string {
  const ext = filePath.split(".").pop()?.toLowerCase() || "";
  const langMap: Record<string, string> = {
    ts: "typescript",
    tsx: "typescript",
    js: "javascript",
    jsx: "javascript",
    py: "python",
    rb: "ruby",
    go: "go",
    rs: "rust",
    java: "java",
    kt: "kotlin",
    c: "c",
    cpp: "cpp",
    h: "c",
    hpp: "cpp",
    cs: "csharp",
    swift: "swift",
    php: "php",
    sql: "sql",
    sh: "bash",
    bash: "bash",
    zsh: "bash",
    json: "json",
    yaml: "yaml",
    yml: "yaml",
    toml: "toml",
    xml: "xml",
    html: "html",
    css: "css",
    scss: "scss",
    md: "markdown",
    markdown: "markdown",
  };
  return langMap[ext] || "plaintext";
}

/**
 * Check if file is an image.
 */
function isImageFile(mimeType: string): boolean {
  return mimeType.startsWith("image/");
}

/**
 * Check if file is markdown.
 */
function isMarkdownFile(filePath: string): boolean {
  const ext = filePath.split(".").pop()?.toLowerCase() || "";
  return ext === "md" || ext === "markdown";
}

/**
 * Get filename from path.
 */
function getFileName(filePath: string): string {
  return filePath.split("/").pop() || filePath;
}

/**
 * FileViewer component - displays file content with appropriate formatting.
 */
export const FileViewer = memo(function FileViewer({
  projectId,
  filePath,
  onClose,
  standalone = false,
  lineNumber,
  lineEnd,
}: FileViewerProps) {
  const [fileData, setFileData] = useState<FileContentResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const [highlightedLineRef, setHighlightedLineRef] =
    useState<HTMLElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    // Request highlighting for code files
    api
      .getFile(projectId, filePath, true)
      .then((data) => {
        if (!cancelled) {
          setFileData(data);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err.message || "Failed to load file");
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [projectId, filePath]);

  // Handle Escape key to exit fullscreen
  useEffect(() => {
    if (!fullscreen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setFullscreen(false);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [fullscreen]);

  // Scroll to highlighted line when it's rendered
  useEffect(() => {
    if (highlightedLineRef) {
      // Small delay to ensure layout is complete
      requestAnimationFrame(() => {
        highlightedLineRef.scrollIntoView({
          behavior: "smooth",
          block: "center",
        });
      });
    }
  }, [highlightedLineRef]);

  const handleCopy = useCallback(async () => {
    if (!fileData?.content) return;
    try {
      await navigator.clipboard.writeText(fileData.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error("Failed to copy:", err);
    }
  }, [fileData?.content]);

  const handleDownload = useCallback(() => {
    const url = api.getFileRawUrl(projectId, filePath, true);
    window.open(url, "_blank");
  }, [projectId, filePath]);

  const handleOpenInNewTab = useCallback(() => {
    const url = `/projects/${projectId}/file?path=${encodeURIComponent(filePath)}`;
    window.open(url, "_blank");
  }, [projectId, filePath]);

  const fileName = getFileName(filePath);
  const language = getLanguageFromPath(filePath);

  // Render loading state
  if (loading) {
    return (
      <div className="file-viewer">
        <div className="file-viewer-loading">Loading {fileName}...</div>
      </div>
    );
  }

  // Render error state
  if (error || !fileData) {
    return (
      <div className="file-viewer">
        <div className="file-viewer-error">{error || "File not found"}</div>
      </div>
    );
  }

  const { metadata, content, rawUrl } = fileData;
  const isImage = isImageFile(metadata.mimeType);

  // Render content based on file type
  const renderContent = () => {
    // Image files
    if (isImage) {
      return (
        <div className="file-viewer-image">
          <img src={rawUrl} alt={fileName} />
        </div>
      );
    }

    // Text files
    if (content !== undefined) {
      const isMarkdown = isMarkdownFile(filePath);
      const hasMarkdownPreview = isMarkdown && !!fileData.renderedMarkdownHtml;

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
      if (showPreview && fileData.renderedMarkdownHtml) {
        return (
          <>
            {toggleButton}
            <div className="markdown-preview">
              <div
                className="markdown-rendered"
                // biome-ignore lint/security/noDangerouslySetInnerHtml: server-rendered HTML
                dangerouslySetInnerHTML={{
                  __html: fileData.renderedMarkdownHtml,
                }}
              />
            </div>
          </>
        );
      }

      // Server-rendered syntax highlighting (preferred)
      if (fileData.highlightedHtml) {
        return (
          <>
            {toggleButton}
            <div
              className="file-viewer-code file-viewer-code-highlighted"
              data-language={fileData.highlightedLanguage ?? language}
            >
              <div
                className="shiki-container"
                // biome-ignore lint/security/noDangerouslySetInnerHtml: server-rendered HTML
                dangerouslySetInnerHTML={{ __html: fileData.highlightedHtml }}
              />
              {fileData.highlightedTruncated && (
                <div className="file-viewer-truncated">
                  File truncated for highlighting (showing first 2000 lines)
                </div>
              )}
            </div>
          </>
        );
      }

      // Fallback: plain code (no syntax highlighting available)
      const lines = content.split("\n");
      const highlightStart = lineNumber ?? 0;
      const highlightEnd = lineEnd ?? highlightStart;

      return (
        <>
          {toggleButton}
          <div className="file-viewer-code" data-language={language}>
            <div className="code-highlighter-plain">
              <div className="code-line-numbers">
                {lines.map((_, i) => (
                  <div key={`ln-${i + 1}`}>{i + 1}</div>
                ))}
              </div>
              <pre className="code-content">
                <code>
                  {lines.map((line, i) => {
                    const num = i + 1;
                    const isHighlighted =
                      lineNumber &&
                      num >= highlightStart &&
                      num <= highlightEnd;
                    return (
                      <div
                        key={`line-${i + 1}`}
                        ref={
                          lineNumber && num === highlightStart
                            ? (el) => setHighlightedLineRef(el)
                            : undefined
                        }
                        className={
                          isHighlighted ? "highlighted-line" : undefined
                        }
                        style={
                          isHighlighted
                            ? {
                                backgroundColor: "rgba(255, 255, 0, 0.15)",
                                marginLeft: "-0.75rem",
                                marginRight: "-0.75rem",
                                paddingLeft: "0.75rem",
                                paddingRight: "0.75rem",
                              }
                            : undefined
                        }
                      >
                        {line || " "}
                      </div>
                    );
                  })}
                </code>
              </pre>
            </div>
          </div>
        </>
      );
    }

    // Binary files or files too large
    return (
      <div className="file-viewer-binary">
        <p>This file cannot be displayed inline.</p>
        <p>
          <strong>Type:</strong> {metadata.mimeType}
        </p>
        <p>
          <strong>Size:</strong> {formatFileSize(metadata.size)}
        </p>
        <button
          type="button"
          className="file-viewer-download-btn"
          onClick={handleDownload}
        >
          Download File
        </button>
      </div>
    );
  };

  // Header with file info and actions
  const header = (
    <div className="file-viewer-header">
      <div className="file-viewer-info">
        <span className="file-viewer-path" title={filePath}>
          {filePath}
        </span>
        <span className="file-viewer-meta">
          {formatFileSize(metadata.size)}
          {metadata.isText &&
            content &&
            ` \u2022 ${content.split("\n").length} lines`}
        </span>
      </div>
      <div className="file-viewer-actions">
        {content && (
          <button
            type="button"
            className={`file-viewer-action ${copied ? "copied" : ""}`}
            onClick={handleCopy}
            title={copied ? "Copied!" : "Copy content"}
          >
            {copied ? <CheckIcon /> : <CopyIcon />}
          </button>
        )}
        {!standalone && (
          <button
            type="button"
            className="file-viewer-action"
            onClick={handleOpenInNewTab}
            title="Open in new tab"
          >
            <ExternalLinkIcon />
          </button>
        )}
        <button
          type="button"
          className="file-viewer-action"
          onClick={handleDownload}
          title="Download"
        >
          <DownloadIcon />
        </button>
        <button
          type="button"
          className="file-viewer-action"
          onClick={() => setFullscreen(!fullscreen)}
          title={fullscreen ? "Exit fullscreen" : "Fullscreen"}
        >
          {fullscreen ? <ExitFullscreenIcon /> : <FullscreenIcon />}
        </button>
        {onClose && (
          <button
            type="button"
            className="file-viewer-action file-viewer-close"
            onClick={onClose}
            title="Close"
          >
            <CloseIcon />
          </button>
        )}
      </div>
    </div>
  );

  const viewerClass = [
    "file-viewer",
    standalone && "file-viewer-standalone",
    fullscreen && "file-viewer-fullscreen",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={viewerClass}>
      {header}
      <div className="file-viewer-body">{renderContent()}</div>
    </div>
  );
});

// Icons
function CopyIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="5" y="5" width="9" height="9" rx="1.5" />
      <path d="M11 5V3.5A1.5 1.5 0 0 0 9.5 2H3.5A1.5 1.5 0 0 0 2 3.5v6A1.5 1.5 0 0 0 3.5 11H5" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 8.5L6.5 12L13 4" />
    </svg>
  );
}

function DownloadIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M8 2v9M4 8l4 4 4-4M2 14h12" />
    </svg>
  );
}

function ExternalLinkIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 9v4a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h4M9 2h5v5M6 10l8-8" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M4 4l8 8M12 4l-8 8" />
    </svg>
  );
}

function FullscreenIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M2 5V2h3M11 2h3v3M14 11v3h-3M5 14H2v-3" />
    </svg>
  );
}

function ExitFullscreenIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M5 2v3H2M14 5h-3V2M11 14v-3h3M2 11h3v3" />
    </svg>
  );
}
