import { memo, useCallback, useEffect, useState } from "react";
import { useSessionMetadata } from "../../contexts/SessionMetadataContext";
import { useStreamingMarkdownContext } from "../../contexts/StreamingMarkdownContext";
import { useStreamingMarkdown } from "../../hooks/useStreamingMarkdown";
import { FileViewer } from "../FileViewer";
import { LocalMediaModal, useLocalMediaClick } from "../LocalMediaModal";
import { Modal } from "../ui/Modal";

interface Props {
  text: string;
  isStreaming?: boolean;
  /** Pre-rendered HTML from server (for completed messages) */
  augmentHtml?: string;
}

function toProjectRelativePath(
  filePath: string,
  projectPath: string | null,
): string {
  const normalizedFilePath = filePath.replaceAll("\\", "/");
  if (!projectPath) {
    return normalizedFilePath.replace(/^\.?\//, "");
  }

  const normalizedProjectPath = projectPath.replaceAll("\\", "/");
  if (normalizedFilePath === normalizedProjectPath) {
    return "";
  }

  const projectPrefix = normalizedProjectPath.endsWith("/")
    ? normalizedProjectPath
    : `${normalizedProjectPath}/`;

  if (normalizedFilePath.startsWith(projectPrefix)) {
    return normalizedFilePath.slice(projectPrefix.length);
  }

  return normalizedFilePath.replace(/^\.?\//, "");
}

export const TextBlock = memo(function TextBlock({
  text,
  isStreaming = false,
  augmentHtml,
}: Props) {
  const { projectId, projectPath } = useSessionMetadata();
  const [copied, setCopied] = useState(false);
  const [fileModal, setFileModal] = useState<{
    path: string;
    lineNumber?: number;
  } | null>(null);

  // Streaming markdown hook for server-rendered content
  const streamingMarkdown = useStreamingMarkdown();
  const streamingContext = useStreamingMarkdownContext();

  // Track whether we're actively using streaming markdown (received at least one augment)
  const [useStreamingContent, setUseStreamingContent] = useState(false);

  // Register with context when streaming and context is available
  useEffect(() => {
    if (!isStreaming || !streamingContext) {
      // Reset streaming state when not streaming
      // (HTML is captured to markdownAugments before component remounts)
      if (!isStreaming) {
        setUseStreamingContent(false);
        streamingMarkdown.reset();
      }
      return;
    }

    // Register handlers with the context
    const unregister = streamingContext.registerStreamingHandler({
      onAugment: (augment) => {
        // Mark that we're using streaming content on first augment
        setUseStreamingContent(true);
        streamingMarkdown.onAugment(augment);
      },
      onPending: streamingMarkdown.onPending,
      onStreamEnd: streamingMarkdown.onStreamEnd,
      captureHtml: streamingMarkdown.captureHtml,
    });

    return unregister;
  }, [isStreaming, streamingContext, streamingMarkdown]);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error("Failed to copy text:", err);
    }
  }, [text]);

  const { modal, handleClick: handleMediaClick, closeModal } =
    useLocalMediaClick();

  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      handleMediaClick(e);
      if (e.defaultPrevented) return;

      const fileTarget = (e.target as HTMLElement).closest?.(
        "a.file-link, a.local-file-link",
      ) as HTMLAnchorElement | null;
      if (!fileTarget) return;

      e.preventDefault();
      e.stopPropagation();

      const path = fileTarget.getAttribute("data-file-path");
      if (!path) return;
      const relativePath = toProjectRelativePath(path, projectPath);
      if (!relativePath) return;

      const lineAttr = fileTarget.getAttribute("data-line");
      const parsedLine =
        lineAttr && /^\d+$/.test(lineAttr)
          ? Number.parseInt(lineAttr, 10)
          : undefined;

      setFileModal({
        path: relativePath,
        lineNumber: parsedLine,
      });
    },
    [handleMediaClick, projectPath],
  );

  const showStreamingContent = isStreaming && useStreamingContent;

  // Always render streaming container when isStreaming so refs are attached
  // before first augment arrives. Hidden until useStreamingContent becomes true.
  const renderStreamingContainer = isStreaming;

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: click handler intercepts local media links only
    <div
      className={`text-block timeline-item${isStreaming ? " streaming" : ""}`}
      onClick={handleClick}
    >
      <button
        type="button"
        className={`text-block-copy ${copied ? "copied" : ""}`}
        onClick={handleCopy}
        title={copied ? "Copied!" : "Copy markdown"}
        aria-label={copied ? "Copied!" : "Copy markdown"}
      >
        {copied ? <CheckIcon /> : <CopyIcon />}
      </button>

      {/* Always render streaming elements when streaming so refs are ready for augments */}
      {renderStreamingContainer && (
        <div style={showStreamingContent ? undefined : { display: "none" }}>
          <div
            ref={streamingMarkdown.containerRef}
            className="streaming-blocks"
          />
          <span
            ref={streamingMarkdown.pendingRef}
            className="streaming-pending"
          />
        </div>
      )}

      {/* Show fallback content when not actively streaming */}
      {!showStreamingContent &&
        (augmentHtml ? (
          // biome-ignore lint/security/noDangerouslySetInnerHtml: server-rendered HTML
          <div dangerouslySetInnerHTML={{ __html: augmentHtml }} />
        ) : (
          // Plain text fallback (no server augment available)
          <p>{text}</p>
        ))}
      {modal && (
        <LocalMediaModal
          path={modal.path}
          mediaType={modal.mediaType}
          onClose={closeModal}
        />
      )}
      {fileModal && (
        <Modal
          title={fileModal.path.split("/").pop() ?? fileModal.path}
          onClose={() => setFileModal(null)}
        >
          <FileViewer
            projectId={projectId}
            filePath={fileModal.path}
            lineNumber={fileModal.lineNumber}
            onClose={() => setFileModal(null)}
          />
        </Modal>
      )}
    </div>
  );
});

function CopyIcon() {
  return (
    <svg
      width="14"
      height="14"
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
      width="14"
      height="14"
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
