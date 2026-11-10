import {
  Children,
  memo,
  type ReactNode,
  type RefObject,
  useRef,
  useState,
} from "react";
import type { ProjectPathLinkTarget } from "@yep-anywhere/shared";
import { useI18n } from "../../i18n";
import { useQuoteableTextSource } from "../../hooks/useQuoteableTextSource";
import type { UserPromptDeliveryState } from "../../lib/deliveryState";
import {
  type UploadedFileInfo,
  getFilename,
  parseUserPrompt,
} from "../../lib/parseUserPrompt";
import type { ContentBlock } from "../../types";
import { AttachmentChip } from "../AttachmentChip";
import { Button, ButtonBase, IconButton } from "../ui/Button";
import { CopyTextButton } from "../ui/CopyTextButton";
import { Popover } from "../ui/Popover";
import { ForkTurnMenu } from "./ForkTurnMenu";
import { useUserPromptActionPacking } from "./useUserPromptActionPacking";
import { UserPromptLinkedText } from "./UserPromptLinkedText";

const MAX_LINES = 12;
const MAX_CHARS = MAX_LINES * 100;

interface Props {
  content: string | ContentBlock[];
  /** Render id of this turn, for the turn index and same-session Clear entries. */
  messageId?: string;
  projectPathLinks?: readonly ProjectPathLinkTarget[];
  onCorrect?: () => void;
  onCancelUnconfirmed?: () => void;
  onTrimBefore?: () => void;
  /** Fork the session from just before this turn (real prefix fork only). */
  onForkBefore?: () => void;
  /** Fork the session through this completed turn. */
  onForkAfter?: () => void;
  /** Enter the explicit fork-after-with-summary workflow. */
  onForkAfterSummary?: () => void;
  /** The selected turn is still active and cannot be retained yet. */
  forkAfterDisabled?: boolean;
  /** Why the otherwise-supported Fork action needs a server update. */
  forkUnavailableMessage?: string;
  extraActions?: ReactNode;
  /**
   * "sent" while the turn exists only as the optimistic echo (not yet proven
   * in the durable transcript); rendered fainter with a small "sent" tag in
   * the bubble's right margin. Absent or "confirmed" renders the normal
   * bubble. See lib/deliveryState.ts.
   */
  deliveryState?: UserPromptDeliveryState;
}

interface InputImageBlock extends ContentBlock {
  type: "input_image";
  file_path?: string;
  image_url?: string;
  mime_type?: string;
}

interface CorrectionDisplay {
  correctedText: string;
  change?: string;
}

const CORRECTION_PREFIX = "Correction to previous message:\n";
const CORRECTION_CHANGE_SEPARATOR = "\n\nChange: ";

function parseCorrectionDisplay(text: string): CorrectionDisplay | null {
  if (!text.startsWith(CORRECTION_PREFIX)) {
    return null;
  }

  const body = text.slice(CORRECTION_PREFIX.length);
  const changeIndex = body.indexOf(CORRECTION_CHANGE_SEPARATOR);
  const correctedText = changeIndex === -1 ? body : body.slice(0, changeIndex);
  const change =
    changeIndex === -1
      ? undefined
      : body.slice(changeIndex + CORRECTION_CHANGE_SEPARATOR.length).trim();

  if (!correctedText.trim()) {
    return null;
  }

  return {
    correctedText,
    ...(change ? { change } : {}),
  };
}

function getUserPromptCopyText(text: string): string {
  const correction = parseCorrectionDisplay(text);
  if (!correction) {
    return text;
  }

  return correction.change
    ? `${correction.correctedText}\n\nChange: ${correction.change}`
    : correction.correctedText;
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
  if (bytes < 1024) return `${bytes}\u202fb`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}\u202fkb`;
  return `${Math.round((bytes / (1024 * 1024)) * 10) / 10}\u202fmb`;
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
 * Renders uploaded file attachments below the user prompt
 */
function UploadedFilesMetadata({ files }: { files: UploadedFileInfo[] }) {
  if (files.length === 0) return null;

  return (
    <div className="user-prompt-metadata">
      {files.map((file) => (
        <AttachmentChip
          key={file.path}
          originalName={file.originalName}
          path={file.path}
          mimeType={file.mimeType}
          sizeLabel={file.size}
          imageWidth={file.width}
          imageHeight={file.height}
          previewUrl={file.previewUrl}
        />
      ))}
    </div>
  );
}

/**
 * Renders text content with optional truncation and "Show more" button
 */
function CollapsibleText({
  projectPathLinks,
  text,
}: {
  projectPathLinks?: readonly ProjectPathLinkTarget[];
  text: string;
}) {
  const [isExpanded, setIsExpanded] = useState(false);
  const lines = text.split("\n");
  const exceedsLines = lines.length > MAX_LINES;
  const exceedsChars = text.length > MAX_CHARS;
  const needsTruncation = exceedsLines || exceedsChars;
  const fullTextRef = useQuoteableTextSource<HTMLDivElement>(
    text,
    undefined,
    "literal",
  );

  // Truncate by lines first, then by characters if still too long
  let truncatedText = exceedsLines
    ? lines.slice(0, MAX_LINES).join("\n")
    : text;
  if (truncatedText.length > MAX_CHARS) {
    truncatedText = truncatedText.slice(0, MAX_CHARS);
  }
  const truncatedRef = useQuoteableTextSource<HTMLDivElement>(
    truncatedText,
    undefined,
    "literal",
  );

  if (!needsTruncation || isExpanded) {
    return (
      <div className="text-block">
        <div ref={fullTextRef}>
          <UserPromptLinkedText
            text={text}
            projectPathLinks={projectPathLinks}
          />
        </div>
        {isExpanded && needsTruncation && (
          <Button
            variant="ghost"
            size="small"
            className="show-more-btn"
            onClick={() => setIsExpanded(false)}
          >
            Show less
          </Button>
        )}
      </div>
    );
  }

  return (
    <div className="text-block collapsible-text">
      <div ref={truncatedRef} className="truncated-content">
        {/* A char-level cut can land mid-URL; don't link a truncated target. */}
        <UserPromptLinkedText
          text={truncatedText}
          projectPathLinks={projectPathLinks}
          suppressTrailingUrl={true}
        />
        <div className="fade-overlay" />
      </div>
      <Button
        variant="ghost"
        size="small"
        className="show-more-btn"
        onClick={() => setIsExpanded(true)}
      >
        Show more
      </Button>
    </div>
  );
}

function UserPromptActionButtons({
  actionsRef,
  messageId,
  onCorrect,
  onCancelUnconfirmed,
  onTrimBefore,
  onForkBefore,
  onForkAfter,
  onForkAfterSummary,
  forkAfterDisabled,
  forkUnavailableMessage,
  copyText,
  extraActions,
}: {
  actionsRef: RefObject<HTMLDivElement | null>;
  messageId?: string;
  onCorrect?: () => void;
  onCancelUnconfirmed?: () => void;
  onTrimBefore?: () => void;
  onForkBefore?: () => void;
  onForkAfter?: () => void;
  onForkAfterSummary?: () => void;
  forkAfterDisabled?: boolean;
  forkUnavailableMessage?: string;
  copyText?: string;
  extraActions?: ReactNode;
}) {
  const { t } = useI18n();

  if (
    !onCorrect &&
    !onCancelUnconfirmed &&
    !onTrimBefore &&
    !onForkAfter &&
    !forkUnavailableMessage &&
    !copyText &&
    !extraActions
  )
    return null;

  return (
    <div ref={actionsRef} className="user-prompt-actions">
      {copyText && (
        <CopyTextButton
          text={copyText}
          label={t("userPromptCopyAction")}
          className="user-prompt-action user-prompt-action-copy"
        />
      )}
      {onCorrect && (
        <IconButton
          variant="secondary"
          size="small"
          className="user-prompt-action user-prompt-action-edit"
          onClick={onCorrect}
          label={t("userPromptEditAction")}
          title={t("userPromptEditAction")}
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M12 20h9" />
            <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
          </svg>
        </IconButton>
      )}
      {onCancelUnconfirmed && (
        <IconButton
          variant="danger-outline"
          size="small"
          className="user-prompt-action user-prompt-action-cancel-sent"
          onClick={onCancelUnconfirmed}
          label={t("userPromptCancelUnconfirmedAction")}
          title={t("userPromptCancelUnconfirmedAction")}
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M18 6 6 18" />
            <path d="m6 6 12 12" />
          </svg>
        </IconButton>
      )}
      {(onForkAfter || forkUnavailableMessage) && (
        <ForkTurnMenu
          messageId={messageId}
          onForkBefore={onForkBefore}
          onForkAfter={onForkAfter}
          onForkAfterSummary={onForkAfterSummary}
          afterDisabled={forkAfterDisabled}
          unavailableMessage={forkUnavailableMessage}
        />
      )}
      {onTrimBefore && (
        <IconButton
          variant="secondary"
          size="small"
          className="user-prompt-action user-prompt-action-show-starting"
          onClick={onTrimBefore}
          label={t("userPromptShowStartingHere")}
          title={t("userPromptShowStartingHere")}
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M4 7h16" />
            <path d="M4 12h10" />
            <path d="M4 17h6" />
            <path d="m15 16 3 3 3-3" />
            <path d="M18 5v14" />
          </svg>
        </IconButton>
      )}
      {extraActions}
    </div>
  );
}

/**
 * Small "sent" tag in the bubble's right margin while the turn is
 * server-accepted but not yet proven in the durable transcript; disappears
 * entirely on confirmation so the steady state stays unadorned. Hover shows
 * the short explanation (title); click/tap toggles a popover with the full
 * one, since touch devices never see the title. The tag sits in the right
 * margin, so the popover extends leftward from it.
 */
function DeliveryStateMarker({
  deliveryState,
}: {
  deliveryState?: UserPromptDeliveryState;
}) {
  const { t } = useI18n();
  const [showDetail, setShowDetail] = useState(false);
  const markerRef = useRef<HTMLButtonElement>(null);
  if (deliveryState !== "sent") return null;
  return (
    <>
      <ButtonBase
        ref={markerRef}
        className="user-prompt-delivery-marker"
        title={t("userPromptDeliverySent")}
        aria-label={t("userPromptDeliverySent")}
        aria-expanded={showDetail}
        onClick={() => setShowDetail((open) => !open)}
        onBlur={() => setShowDetail(false)}
      >
        {t("userPromptDeliverySentLabel")}
      </ButtonBase>
      <Popover
        open={showDetail}
        onClose={() => setShowDetail(false)}
        anchorRef={markerRef}
        placement="bottom-end"
        role="status"
        surface="card"
        style={{ maxWidth: "min(340px, 85dvw)" }}
      >
        {t("userPromptDeliverySentDetail")}
      </Popover>
    </>
  );
}

function UserPromptText({
  projectPathLinks,
  text,
}: {
  projectPathLinks?: readonly ProjectPathLinkTarget[];
  text: string;
}) {
  const correction = parseCorrectionDisplay(text);
  if (!correction) {
    return <CollapsibleText text={text} projectPathLinks={projectPathLinks} />;
  }

  return (
    <div className="user-prompt-correction">
      <div className="user-prompt-correction-label">Correction</div>
      <CollapsibleText
        text={correction.correctedText}
        projectPathLinks={projectPathLinks}
      />
      {correction.change && (
        <div className="user-prompt-correction-change">
          Change:{" "}
          <UserPromptLinkedText
            text={correction.change}
            projectPathLinks={projectPathLinks}
          />
        </div>
      )}
    </div>
  );
}

export const UserPromptBlock = memo(function UserPromptBlock({
  content,
  messageId,
  projectPathLinks,
  onCorrect,
  onCancelUnconfirmed,
  onTrimBefore,
  onForkBefore,
  onForkAfter,
  onForkAfterSummary,
  forkAfterDisabled,
  forkUnavailableMessage,
  extraActions,
  deliveryState,
}: Props) {
  const unconfirmedClass =
    deliveryState === "sent" ? " user-prompt-unconfirmed" : "";
  const actionCount =
    Number(Boolean(content)) +
    Number(Boolean(onCorrect)) +
    Number(Boolean(onCancelUnconfirmed)) +
    Number(Boolean(onForkAfter || forkUnavailableMessage)) +
    Number(Boolean(onTrimBefore)) +
    Children.count(extraActions);
  const measurementKey =
    typeof content === "string"
      ? content
      : content
          .map((block) =>
            block.type === "text" && typeof block.text === "string"
              ? block.text
              : block.type,
          )
          .join("\0");
  const actionPacking = useUserPromptActionPacking(actionCount, measurementKey);
  if (typeof content === "string") {
    const { text, openedFiles, uploadedFiles } = parseUserPrompt(content);

    // Don't render if there's no actual text content
    if (!text) {
      const hasMetadata = openedFiles.length > 0 || uploadedFiles.length > 0;
      return hasMetadata ? (
        <>
          <UploadedFilesMetadata files={uploadedFiles} />
          <OpenedFilesMetadata files={openedFiles} />
        </>
      ) : null;
    }

    return (
      <div
        ref={actionPacking.containerRef}
        className="user-prompt-container"
        style={actionPacking.style}
      >
        <div
          ref={actionPacking.bubbleRef}
          className={`message message-user-prompt ${onCorrect ? "user-prompt-correctable" : ""}${unconfirmedClass}`}
        >
          <div className="message-content">
            <UserPromptText text={text} projectPathLinks={projectPathLinks} />
            <DeliveryStateMarker deliveryState={deliveryState} />
            <UploadedFilesMetadata files={uploadedFiles} />
          </div>
        </div>
        <UserPromptActionButtons
          actionsRef={actionPacking.actionsRef}
          messageId={messageId}
          onCorrect={onCorrect}
          onCancelUnconfirmed={onCancelUnconfirmed}
          onTrimBefore={onTrimBefore}
          onForkBefore={onForkBefore}
          onForkAfter={onForkAfter}
          onForkAfterSummary={onForkAfterSummary}
          forkAfterDisabled={forkAfterDisabled}
          forkUnavailableMessage={forkUnavailableMessage}
          copyText={getUserPromptCopyText(text)}
          extraActions={extraActions}
        />
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
      <>
        <UploadedFilesMetadata files={allUploadedFiles} />
        <OpenedFilesMetadata files={openedFiles} />
      </>
    ) : (
      <div className="message message-user-prompt">
        <div className="message-content">
          <div className="text-block">[Complex content]</div>
        </div>
      </div>
    );
  }

  return (
    <div
      ref={actionPacking.containerRef}
      className="user-prompt-container"
      style={actionPacking.style}
    >
      <div
        ref={actionPacking.bubbleRef}
        className={`message message-user-prompt ${onCorrect ? "user-prompt-correctable" : ""}${unconfirmedClass}`}
      >
        <div className="message-content">
          <UserPromptText text={text} projectPathLinks={projectPathLinks} />
          <DeliveryStateMarker deliveryState={deliveryState} />
          <UploadedFilesMetadata files={allUploadedFiles} />
        </div>
      </div>
      <UserPromptActionButtons
        actionsRef={actionPacking.actionsRef}
        messageId={messageId}
        onCorrect={onCorrect}
        onCancelUnconfirmed={onCancelUnconfirmed}
        onTrimBefore={onTrimBefore}
        onForkBefore={onForkBefore}
        onForkAfter={onForkAfter}
        onForkAfterSummary={onForkAfterSummary}
        forkAfterDisabled={forkAfterDisabled}
        forkUnavailableMessage={forkUnavailableMessage}
        copyText={getUserPromptCopyText(text)}
        extraActions={extraActions}
      />
      <OpenedFilesMetadata files={openedFiles} />
    </div>
  );
});
