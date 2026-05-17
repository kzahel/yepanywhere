import { memo, useState } from "react";
import { getUploadUrl, isImageMimeType } from "../../api/upload";
import { useRemoteImage } from "../../hooks/useRemoteImage";
import {
  type UploadedFileInfo,
  getFilename,
  parseUserPrompt,
} from "../../lib/parseUserPrompt";
import type { ContentBlock } from "../../types";
import { Modal } from "../ui/Modal";

const MAX_LINES = 12;
const MAX_CHARS = MAX_LINES * 100;

interface Props {
  content: string | ContentBlock[];
}

interface InputImageBlock extends ContentBlock {
  type: "input_image";
  file_path?: string;
  image_url?: string;
  mime_type?: string;
}

/**
 * Renders file metadata (opened files) below the user prompt
 */
function OpenedFilesMetadata({ files }: { files: string[] }) {
  if (files.length === 0) return null;

  return (
    <div className="user-prompt-metadata">
      {files.map((filePath) => (
        <span
          key={filePath}
          className="opened-file"
          title={`file was opened in editor: ${filePath}`}
        >
          {getFilename(filePath)}
        </span>
      ))}
    </div>
  );
}

function isInputImageBlock(block: ContentBlock): block is InputImageBlock {
  return block.type === "input_image";
}

function stripCodexImageMarkers(text: string): string {
  return text
    .split("\n")
    .filter((line) => line.trim() !== "<image>")
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function parseInlineImageData(imageUrl: string): {
  mimeType?: string;
  bytes?: number;
} {
  const match = /^data:([^;,]+)?(;base64)?,(.*)$/i.exec(imageUrl);
  if (!match) return {};

  const rawMime = match[1]?.trim();
  const mimeType = rawMime || undefined;
  const isBase64 = Boolean(match[2]);
  const payload = (match[3] ?? "").trim();
  if (!payload) return { mimeType };

  if (!isBase64) {
    const decoded = decodeURIComponent(payload);
    return { mimeType, bytes: decoded.length };
  }

  const sanitized = payload.replace(/\s+/g, "");
  const padding = sanitized.endsWith("==")
    ? 2
    : sanitized.endsWith("=")
      ? 1
      : 0;
  const bytes = Math.max(0, Math.floor((sanitized.length * 3) / 4) - padding);
  return { mimeType, bytes };
}

function formatFileSize(bytes?: number): string {
  if (!bytes || bytes < 0) return "unknown size";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function getMimeTypeFromPath(path: string): string | undefined {
  const lowerPath = path.toLowerCase();
  if (lowerPath.endsWith(".png")) return "image/png";
  if (lowerPath.endsWith(".jpg") || lowerPath.endsWith(".jpeg"))
    return "image/jpeg";
  if (lowerPath.endsWith(".gif")) return "image/gif";
  if (lowerPath.endsWith(".webp")) return "image/webp";
  if (lowerPath.endsWith(".bmp")) return "image/bmp";
  if (lowerPath.endsWith(".svg")) return "image/svg+xml";
  return undefined;
}

function extensionForMimeType(mimeType: string): string {
  const normalized = mimeType.toLowerCase();
  if (normalized === "image/jpeg") return "jpg";
  if (normalized === "image/svg+xml") return "svg";
  const slashIndex = normalized.indexOf("/");
  if (slashIndex === -1) return "png";
  const ext = normalized.slice(slashIndex + 1);
  return ext || "png";
}

function filenameFromUrl(imageUrl: string): string | null {
  if (imageUrl.startsWith("data:")) return null;

  try {
    const parsed = new URL(imageUrl, "https://codex.local");
    const pathname = parsed.pathname || "";
    const segment = pathname.split("/").filter(Boolean).pop();
    return segment ? decodeURIComponent(segment) : null;
  } catch {
    return null;
  }
}

function extractCodexImageFiles(content: ContentBlock[]): UploadedFileInfo[] {
  const files: UploadedFileInfo[] = [];
  let imageIndex = 0;

  for (const block of content) {
    if (!isInputImageBlock(block)) continue;
    imageIndex += 1;

    const filePath =
      typeof block.file_path === "string" ? block.file_path.trim() : "";
    const imageUrl =
      typeof block.image_url === "string" ? block.image_url.trim() : "";
    const inlineData = imageUrl ? parseInlineImageData(imageUrl) : {};

    const mimeType =
      (typeof block.mime_type === "string" && block.mime_type.trim()) ||
      inlineData.mimeType ||
      (filePath ? getMimeTypeFromPath(filePath) : undefined) ||
      (imageUrl ? getMimeTypeFromPath(imageUrl) : undefined) ||
      "image/*";

    const fileName =
      (filePath && getFilename(filePath)) ||
      (imageUrl && filenameFromUrl(imageUrl)) ||
      `pasted-image-${imageIndex}.${extensionForMimeType(mimeType)}`;

    const path =
      filePath ||
      (imageUrl && !imageUrl.startsWith("data:") ? imageUrl : "") ||
      `codex-inline://image/${imageIndex}`;

    files.push({
      originalName: fileName,
      size: formatFileSize(inlineData.bytes),
      mimeType,
      path,
      previewUrl: imageUrl || undefined,
    });
  }

  return files;
}

function mergeUploadedFiles(
  primary: UploadedFileInfo[],
  secondary: UploadedFileInfo[],
): UploadedFileInfo[] {
  const seen = new Set<string>();
  const merged: UploadedFileInfo[] = [];

  for (const file of [...primary, ...secondary]) {
    if (seen.has(file.path)) continue;
    seen.add(file.path);
    merged.push(file);
  }

  return merged;
}

/**
 * Single uploaded file attachment - clickable for images
 */
function UploadedFileItem({ file }: { file: UploadedFileInfo }) {
  const [showModal, setShowModal] = useState(false);
  const isImage = isImageMimeType(file.mimeType);
  const apiPath = isImage ? getUploadUrl(file.path) : null;
  const directPreviewUrl = isImage ? (file.previewUrl ?? null) : null;

  // Use the remote image hook to handle fetching via relay when needed
  const { url: remoteImageUrl, loading, error } = useRemoteImage(apiPath);
  const imageUrl = directPreviewUrl ?? remoteImageUrl;

  if (isImage && (apiPath || directPreviewUrl)) {
    return (
      <>
        <button
          type="button"
          className="uploaded-file uploaded-file-clickable uploaded-file-image"
          title={`${file.mimeType}, ${file.size}`}
          onClick={() => setShowModal(true)}
        >
          {imageUrl ? (
            <img
              src={imageUrl}
              alt={file.originalName}
              className="uploaded-file-image-preview"
            />
          ) : (
            <span className="uploaded-file-image-placeholder">Img</span>
          )}
          <span className="uploaded-file-image-meta">
            <span className="uploaded-file-image-name">
              {file.originalName}
            </span>
            <span className="uploaded-file-image-size">{file.size}</span>
          </span>
        </button>
        {showModal && (
          <Modal title={file.originalName} onClose={() => setShowModal(false)}>
            <div className="uploaded-image-modal">
              {apiPath && loading && (
                <div className="image-loading">Loading...</div>
              )}
              {apiPath && error && (
                <div className="image-error">Failed to load image</div>
              )}
              {imageUrl && <img src={imageUrl} alt={file.originalName} />}
            </div>
          </Modal>
        )}
      </>
    );
  }

  return (
    <span className="uploaded-file" title={`${file.mimeType}, ${file.size}`}>
      📎 {file.originalName}
    </span>
  );
}

/**
 * Renders uploaded file attachments below the user prompt
 */
function UploadedFilesMetadata({ files }: { files: UploadedFileInfo[] }) {
  if (files.length === 0) return null;

  return (
    <div className="user-prompt-metadata uploaded-files-metadata">
      {files.map((file) => (
        <UploadedFileItem key={file.path} file={file} />
      ))}
    </div>
  );
}

/**
 * Renders text content with optional truncation and "Show more" button
 */
function CollapsibleText({ text }: { text: string }) {
  const [isExpanded, setIsExpanded] = useState(false);
  const lines = text.split("\n");
  const exceedsLines = lines.length > MAX_LINES;
  const exceedsChars = text.length > MAX_CHARS;
  const needsTruncation = exceedsLines || exceedsChars;

  if (!needsTruncation || isExpanded) {
    return (
      <div className="text-block">
        {text}
        {isExpanded && needsTruncation && (
          <button
            type="button"
            className="show-more-btn"
            onClick={() => setIsExpanded(false)}
          >
            Show less
          </button>
        )}
      </div>
    );
  }

  // Truncate by lines first, then by characters if still too long
  let truncatedText = exceedsLines
    ? lines.slice(0, MAX_LINES).join("\n")
    : text;
  if (truncatedText.length > MAX_CHARS) {
    truncatedText = truncatedText.slice(0, MAX_CHARS);
  }

  return (
    <div className="text-block collapsible-text">
      <div className="truncated-content">
        {truncatedText}
        <div className="fade-overlay" />
      </div>
      <button
        type="button"
        className="show-more-btn"
        onClick={() => setIsExpanded(true)}
      >
        Show more
      </button>
    </div>
  );
}

export const UserPromptBlock = memo(function UserPromptBlock({
  content,
}: Props) {
  if (typeof content === "string") {
    const { text, openedFiles, uploadedFiles } = parseUserPrompt(content);

    // Don't render if there's no actual text content
    if (!text) {
      const hasMetadata = openedFiles.length > 0 || uploadedFiles.length > 0;
      return hasMetadata ? (
        <div className="user-prompt-container">
          <UploadedFilesMetadata files={uploadedFiles} />
          <OpenedFilesMetadata files={openedFiles} />
        </div>
      ) : null;
    }

    return (
      <div className="user-prompt-container">
        <div className="message message-user-prompt">
          <div className="message-content">
            <CollapsibleText text={text} />
            <UploadedFilesMetadata files={uploadedFiles} />
          </div>
        </div>
        <OpenedFilesMetadata files={openedFiles} />
      </div>
    );
  }

  // Array content - extract text blocks for display
  const textContent = content
    .filter((block) => block.type === "text" && block.text)
    .map((block) => block.text)
    .join("\n");
  const codexImageFiles = extractCodexImageFiles(content);
  const textForParsing =
    codexImageFiles.length > 0
      ? stripCodexImageMarkers(textContent)
      : textContent;

  // Parse the combined text content for metadata
  const { text, openedFiles, uploadedFiles } = parseUserPrompt(textForParsing);
  const allUploadedFiles = mergeUploadedFiles(uploadedFiles, codexImageFiles);

  if (!text) {
    const hasMetadata = openedFiles.length > 0 || allUploadedFiles.length > 0;
    return hasMetadata ? (
      <div className="user-prompt-container">
        <UploadedFilesMetadata files={allUploadedFiles} />
        <OpenedFilesMetadata files={openedFiles} />
      </div>
    ) : (
      <div className="message message-user-prompt">
        <div className="message-content">
          <div className="text-block">[Complex content]</div>
        </div>
      </div>
    );
  }

  return (
    <div className="user-prompt-container">
      <div className="message message-user-prompt">
        <div className="message-content">
          <CollapsibleText text={text} />
          <UploadedFilesMetadata files={allUploadedFiles} />
        </div>
      </div>
      <OpenedFilesMetadata files={openedFiles} />
    </div>
  );
});
