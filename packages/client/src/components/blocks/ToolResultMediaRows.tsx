import type {
  StoredToolResultMedia,
  ToolResultMedia,
  ToolResultMediaRejectionReason,
} from "@yep-anywhere/shared";
import {
  type CSSProperties,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { useRememberedDisclosureState } from "../../contexts/RememberedDisclosureStateContext";
import { useSessionMetadata } from "../../contexts/SessionMetadataContext";
import { useCurrentSourceRuntime } from "../../contexts/SourceRuntimeContext";
import { useInlineMedia } from "../../hooks/useInlineMedia";
import { useI18n, type MessageKey } from "../../i18n";
import { toSourceTransportApiPath } from "../../lib/sourceTransportPaths";
import type { ToolCallItem } from "@yep-anywhere/shared/transcript/items";
import { useImageResourceActions } from "../ImageResourceActions";
import { LocalMediaModal, type LocalMediaSource } from "../LocalMediaModal";
import { TimelineDisclosure } from "../TimelineDisclosure";
import styles from "./ToolResultMediaRows.module.css";

interface ToolResultMediaRowsProps {
  displayName: string;
  media: ToolResultMedia[];
  sourcePath?: string;
  status: ToolCallItem["status"];
}

type PreviewState =
  | { state: "idle" }
  | { state: "loading" }
  | { state: "loaded"; objectUrl: string }
  | { state: "error" };

type MediaPreviewStyle = CSSProperties & {
  "--tool-result-media-aspect-ratio": string;
  "--tool-result-media-max-width": string;
};

const REJECTION_KEYS: Record<ToolResultMediaRejectionReason, MessageKey> = {
  "invalid-image-data": "toolResultMediaInvalidImageData",
  "source-unavailable": "toolResultMediaSourceUnavailable",
  "storage-unavailable": "toolResultMediaStorageUnavailable",
  "too-large": "toolResultMediaTooLarge",
  "unsupported-media": "toolResultMediaUnsupportedMedia",
};

export function ToolResultMediaRows({
  displayName,
  media,
  sourcePath,
  status,
}: ToolResultMediaRowsProps) {
  return (
    <div className={styles.root}>
      {media.map((item, index) => (
        <ToolResultMediaRow
          key={item.state === "stored" ? item.id : `${item.reason}-${index}`}
          displayName={displayName}
          index={index}
          media={item}
          sourcePath={sourcePath}
          status={status}
        />
      ))}
    </div>
  );
}

function ToolResultMediaRow({
  displayName,
  index,
  media,
  sourcePath,
  status,
}: {
  displayName: string;
  index: number;
  media: ToolResultMedia;
  sourcePath?: string;
  status: ToolCallItem["status"];
}) {
  const { inlineMediaExpandedByDefault } = useInlineMedia();
  const { t } = useI18n();
  const filename =
    media.filename || t("toolResultMediaUnnamed", { number: index + 1 });

  if (media.state === "rejected") {
    return (
      <div
        className={`tool-row timeline-item status-${status} ${styles.row} ${styles.rejected}`}
      >
        <div
          className={styles.rowHeader}
          title={t(REJECTION_KEYS[media.reason])}
        >
          <span className="tool-name">{displayName}</span>
          <span className={styles.filename}>{filename}</span>
          <span className={styles.suffix}>
            ({t("toolResultMediaUnavailable")})
          </span>
        </div>
      </div>
    );
  }

  return (
    <StoredToolResultMediaRow
      displayName={displayName}
      filename={filename}
      initialExpanded={inlineMediaExpandedByDefault}
      media={media}
      sourcePath={sourcePath}
      status={status}
    />
  );
}

function StoredToolResultMediaRow({
  displayName,
  filename,
  initialExpanded,
  media,
  sourcePath,
  status,
}: {
  displayName: string;
  filename: string;
  initialExpanded: boolean;
  media: StoredToolResultMedia;
  sourcePath?: string;
  status: ToolCallItem["status"];
}) {
  const { projectId, sessionId } = useSessionMetadata();
  const transport = useCurrentSourceRuntime().transport;
  const { t } = useI18n();
  const [expanded, setExpanded] = useRememberedDisclosureState(
    media.toolCallId,
    `media-preview:${media.id}`,
    initialExpanded,
  );
  const [preview, setPreview] = useState<PreviewState>({ state: "idle" });
  const [modalOpen, setModalOpen] = useState(false);
  const apiPath = `/api/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}/media/${encodeURIComponent(media.id)}`;
  const mediaSource = useMemo<LocalMediaSource>(
    () => ({ buildApiPath: () => apiPath }),
    [apiPath],
  );
  const loadBlob = useCallback(
    () => transport.fetchBlob(toSourceTransportApiPath(apiPath)),
    [apiPath, transport],
  );
  const openViewer = useCallback(() => setModalOpen(true), []);
  const imageActions = useImageResourceActions({
    fileName: filename,
    filePath: sourcePath,
    loadBlob,
    onOpen: openViewer,
  });

  useEffect(() => {
    if (!expanded) {
      setPreview({ state: "idle" });
      return;
    }

    let cancelled = false;
    let objectUrl: string | null = null;
    setPreview({ state: "loading" });
    void loadBlob()
      .then((blob) => {
        objectUrl = URL.createObjectURL(blob);
        if (cancelled) {
          URL.revokeObjectURL(objectUrl);
          return;
        }
        setPreview({ state: "loaded", objectUrl });
      })
      .catch(() => {
        if (!cancelled) setPreview({ state: "error" });
      });

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [expanded, loadBlob]);

  const isVideo = media.mimeType.startsWith("video/");
  const dimensions =
    media.width && media.height ? `${media.width}×${media.height}` : null;
  const previewStyle: MediaPreviewStyle = {
    "--tool-result-media-aspect-ratio":
      media.width && media.height
        ? `${media.width} / ${media.height}`
        : "16 / 9",
    "--tool-result-media-max-width": media.width
      ? `${Math.min(media.width, 720)}px`
      : "720px",
  };
  const toggleLabel = expanded
    ? t("toolResultMediaCollapse")
    : t("toolResultMediaExpand");

  return (
    <div className={`tool-row timeline-item status-${status} ${styles.row}`}>
      <TimelineDisclosure
        expanded={expanded}
        label={toggleLabel}
        status={status}
        onClick={() => setExpanded((current) => !current)}
      />
      <div className={styles.rowHeader}>
        <span className="tool-name">{displayName}</span>
        <button
          type="button"
          className={styles.filename}
          onClick={openViewer}
          onContextMenu={imageActions.handleContextMenu}
        >
          {filename}
        </button>
        <span className={styles.suffix}>
          ({t(isVideo ? "toolResultMediaVideo" : "toolResultMediaImage")})
        </span>
        {dimensions && <span className={styles.dimensions}>{dimensions}</span>}
      </div>

      {expanded && (
        <div className={styles.preview} style={previewStyle}>
          {preview.state === "loading" && (
            <span className={styles.loading}>
              {t("toolResultMediaLoading")}
            </span>
          )}
          {preview.state === "error" && (
            <span className={styles.error}>
              {t("toolResultMediaLoadFailed")}
            </span>
          )}
          {preview.state === "loaded" &&
            (isVideo ? (
              // biome-ignore lint/a11y/useMediaCaption: generated tool output has no captions
              <video
                className={styles.imageButton}
                src={preview.objectUrl}
                controls
                playsInline
                preload="metadata"
                aria-label={t("toolResultMediaAlt", { filename })}
              />
            ) : (
              <button
                type="button"
                className={styles.imageButton}
                onClick={openViewer}
                onContextMenu={imageActions.handleContextMenu}
                aria-label={t("toolResultMediaOpen", { filename })}
              >
                <img
                  src={preview.objectUrl}
                  alt={t("toolResultMediaAlt", { filename })}
                  width={media.width}
                  height={media.height}
                />
              </button>
            ))}
        </div>
      )}

      {modalOpen && (
        <LocalMediaModal
          path={filename}
          filePath={sourcePath ?? null}
          mediaType={isVideo ? "video" : "image"}
          mediaSource={mediaSource}
          onClose={() => setModalOpen(false)}
        />
      )}
      {imageActions.contextMenuElement}
    </div>
  );
}

export function getToolResultImageSourcePath(
  toolName: string,
  toolInput: unknown,
  mediaCount: number,
): string | undefined {
  if (mediaCount !== 1 || !toolInput || typeof toolInput !== "object") {
    return undefined;
  }
  const normalizedToolName = toolName.toLowerCase().replaceAll("_", "");
  if (
    normalizedToolName !== "viewimage" &&
    normalizedToolName !== "imageview" &&
    normalizedToolName !== "read"
  ) {
    return undefined;
  }

  const input = toolInput as Record<string, unknown>;
  const paths = [input.path, input.file_path, input.filePath]
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter(Boolean);
  return new Set(paths).size === 1 ? paths[0] : undefined;
}
