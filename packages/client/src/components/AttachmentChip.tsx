import promptStyles from "./blocks/UserPromptBlock.module.css";
import { planThumbnail } from "@yep-anywhere/shared";
import { getPersistedAttachmentUploadUrl } from "../lib/attachmentUploadUrl";
export { getPersistedAttachmentUploadUrl } from "../lib/attachmentUploadUrl";
import {
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { usePublicShareContext } from "../contexts/PublicShareContext";
import { useOptionalSessionMetadata } from "../contexts/SessionMetadataContext";
import { useI18n } from "../i18n";
import { useRemoteImage } from "../hooks/useRemoteImage";
import { buildPublicShareRawFileApiPath } from "../lib/publicShareFiles";
import { fetchPublicShareBlobViaRelay } from "../lib/publicShareRelay";
import { loadCachedAttachmentPreview } from "../lib/attachmentPreviewCache";
import {
  type AttachmentHoverBox,
  placeAttachmentHoverPreview,
} from "../lib/attachmentHoverPreview";
import { ButtonBase, IconButton } from "./ui/Button";
import { Modal } from "./ui/Modal";
import styles from "./AttachmentChip.module.css";

// Brief linger before a hover surfaces the full-size preview, so passing the
// cursor over a chip on the way elsewhere does not flash the overlay.
export const HOVER_PREVIEW_LINGER_MS = 450;

const ATTACHMENT_FILENAME_ID = /^([0-9a-f-]{36})_/i;

export interface AttachmentChipProps {
  attachmentId?: string;
  originalName: string;
  path?: string;
  mimeType: string;
  sizeLabel: string;
  imageWidth?: number;
  imageHeight?: number;
  previewUrl?: string;
  /** Logical project id for attachments outside session context. The URL's
   * session segment always comes from the file path's physical directory. */
  projectId?: string;
  onRemove?: () => void;
}

function isImageMimeType(mimeType: string): boolean {
  return mimeType.startsWith("image/");
}

const ATTACHMENT_NAME_SOFT_LIMIT = 24;
const ATTACHMENT_NAME_SEPARATOR_WINDOW = 8;

function isNameSeparator(char: string | undefined): boolean {
  return char === "-" || char === "_" || char === " ";
}

export function formatAttachmentName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length <= ATTACHMENT_NAME_SOFT_LIMIT) {
    return trimmed;
  }

  const overshootLimit =
    ATTACHMENT_NAME_SOFT_LIMIT + ATTACHMENT_NAME_SEPARATOR_WINDOW;

  for (
    let index = ATTACHMENT_NAME_SOFT_LIMIT;
    index < trimmed.length;
    index += 1
  ) {
    if (isNameSeparator(trimmed[index])) {
      if (index <= overshootLimit) {
        return `${trimmed.slice(0, index).replace(/[ -_]+$/u, "")}...`;
      }
      break;
    }
  }

  for (let index = ATTACHMENT_NAME_SOFT_LIMIT - 1; index >= 0; index -= 1) {
    if (isNameSeparator(trimmed[index])) {
      return `${trimmed.slice(0, index).replace(/[ -_]+$/u, "")}...`;
    }
  }

  return `${trimmed.slice(0, ATTACHMENT_NAME_SOFT_LIMIT).replace(/[ -_]+$/u, "")}...`;
}

export function getAttachmentIdFromPersistedPath(
  filePath: string | undefined,
): string | null {
  if (!filePath) return null;
  const filename = filePath.split(/[\\/]/).pop() ?? "";
  const match = ATTACHMENT_FILENAME_ID.exec(filename);
  return match?.[1] ?? null;
}

/** Latches true once the element comes within a screen of the viewport. */
function useNearViewport(
  ref: RefObject<HTMLElement | null>,
  enabled: boolean,
): boolean {
  const [near, setNear] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (!enabled || near || !element) return;
    if (typeof IntersectionObserver === "undefined") {
      setNear(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setNear(true);
      },
      { rootMargin: "100% 0px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [enabled, near, ref]);
  return near;
}

function useCachedAttachmentImage(
  attachmentId: string,
  path: string | undefined,
  remotePreviewEnabled: boolean,
  originalEnabled: boolean,
  previewUrl?: string,
  projectId?: string,
): {
  previewUrl: string | null;
  fullUrl: string | null;
  previewWidth: number | null;
  previewHeight: number | null;
  loading: boolean;
  error: string | null;
} {
  const [cachePreviewUrl, setCachePreviewUrl] = useState<string | null>(null);
  const [cacheFullUrl, setCacheFullUrl] = useState<string | null>(null);
  const [cachePreviewWidth, setCachePreviewWidth] = useState<number | null>(
    null,
  );
  const [cachePreviewHeight, setCachePreviewHeight] = useState<number | null>(
    null,
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [remoteEnabled, setRemoteEnabled] = useState(false);
  const previewUrlRef = useRef<string | null>(null);
  const fullUrlRef = useRef<string | null>(null);
  const publicShare = usePublicShareContext();

  const remotePath = useMemo(
    () =>
      publicShare
        ? path
          ? buildPublicShareRawFileApiPath(publicShare, path)
          : null
        : getPersistedAttachmentUploadUrl(path, projectId),
    [path, projectId, publicShare],
  );
  const fetchSharedBlob = useMemo(
    () =>
      publicShare
        ? (apiPath: string) =>
            fetchPublicShareBlobViaRelay({
              path: apiPath,
              relayUrl: publicShare.relayUrl,
              relayUsername: publicShare.relayUsername,
            })
        : undefined,
    [publicShare],
  );

  useEffect(() => {
    let cancelled = false;
    setError(null);
    setCachePreviewUrl(null);
    setCacheFullUrl(null);
    setCachePreviewWidth(null);
    setCachePreviewHeight(null);

    if (publicShare) {
      setLoading(false);
      setRemoteEnabled(true);
      return;
    }

    if (previewUrl) {
      setLoading(false);
      setRemoteEnabled(false);
      return () => {
        if (previewUrlRef.current) {
          URL.revokeObjectURL(previewUrlRef.current);
          previewUrlRef.current = null;
        }
        if (fullUrlRef.current) {
          URL.revokeObjectURL(fullUrlRef.current);
          fullUrlRef.current = null;
        }
      };
    }

    if (!path && !attachmentId) {
      setLoading(false);
      setRemoteEnabled(false);
      return () => {
        if (previewUrlRef.current) {
          URL.revokeObjectURL(previewUrlRef.current);
          previewUrlRef.current = null;
        }
        if (fullUrlRef.current) {
          URL.revokeObjectURL(fullUrlRef.current);
          fullUrlRef.current = null;
        }
      };
    }

    setLoading(true);
    setRemoteEnabled(false);
    loadCachedAttachmentPreview(attachmentId, path)
      .then((entry) => {
        if (cancelled) return;
        if (!entry) {
          setLoading(false);
          setRemoteEnabled(true);
          return;
        }

        const thumbBlob = entry.thumbnailBlob ?? entry.fullBlob;
        const previewObjectUrl = URL.createObjectURL(thumbBlob);
        const fullObjectUrl = URL.createObjectURL(entry.fullBlob);
        previewUrlRef.current = previewObjectUrl;
        fullUrlRef.current = fullObjectUrl;
        setCachePreviewUrl(previewObjectUrl);
        setCacheFullUrl(fullObjectUrl);
        setCachePreviewWidth(entry.thumbnailWidth ?? null);
        setCachePreviewHeight(entry.thumbnailHeight ?? null);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        if (remotePath) {
          setError(null);
          setRemoteEnabled(true);
        } else {
          setError(
            err instanceof Error
              ? err.message
              : "Failed to load attachment preview",
          );
        }
        setLoading(false);
      });

    return () => {
      cancelled = true;
      if (previewUrlRef.current) {
        URL.revokeObjectURL(previewUrlRef.current);
        previewUrlRef.current = null;
      }
      if (fullUrlRef.current) {
        URL.revokeObjectURL(fullUrlRef.current);
        fullUrlRef.current = null;
      }
    };
  }, [attachmentId, path, previewUrl, remotePath, publicShare]);

  const remote = useRemoteImage(
    remotePath,
    remotePreviewEnabled && remoteEnabled && !previewUrl,
    fetchSharedBlob,
  );
  const original = useRemoteImage(
    !publicShare &&
      remotePath?.startsWith("/api/local-image?") &&
      path?.replaceAll("\\", "/").includes("/.rendez/delivered/")
      ? `${remotePath}&rendezOriginal=1`
      : null,
    originalEnabled,
  );

  return {
    previewUrl: previewUrl ?? cachePreviewUrl ?? remote.url,
    fullUrl: previewUrl ?? cacheFullUrl ?? original.url ?? remote.url,
    previewWidth: cachePreviewWidth,
    previewHeight: cachePreviewHeight,
    loading: loading || remote.loading,
    error: error ?? remote.error,
  };
}

function NonImageAttachmentChip({
  originalName,
  path,
  mimeType,
  sizeLabel,
  onRemove,
}: AttachmentChipProps) {
  const { t } = useI18n();
  return (
    <span className={styles.chip} title={`${mimeType}, ${sizeLabel}`}>
      <span className={styles.previewFallback} aria-hidden="true">
        📎
      </span>
      <span className={styles.name} title={path ?? originalName}>
        {formatAttachmentName(originalName)}
      </span>
      <span className={styles.size}>{sizeLabel}</span>
      {onRemove && (
        <IconButton
          size="small"
          label={t("attachmentRemove", { name: originalName })}
          className={styles.remove}
          onClick={onRemove}
        >
          x
        </IconButton>
      )}
    </span>
  );
}

function ImageAttachmentChip({
  attachmentId,
  originalName,
  path,
  mimeType,
  sizeLabel,
  imageWidth,
  imageHeight,
  previewUrl,
  projectId,
  onRemove,
}: AttachmentChipProps) {
  const { t } = useI18n();
  const sessionMetadata = useOptionalSessionMetadata();
  const routeProjectId = projectId ?? sessionMetadata?.projectId;
  const [showModal, setShowModal] = useState(false);
  const [showHoverPreview, setShowHoverPreview] = useState(false);
  const [hoverBox, setHoverBox] = useState<AttachmentHoverBox | null>(null);
  const hoverTimerRef = useRef<number | null>(null);
  const chipButtonRef = useRef<HTMLButtonElement>(null);
  const hoverImageRef = useRef<HTMLImageElement>(null);
  const derivedAttachmentId = getAttachmentIdFromPersistedPath(path);
  const cacheKey = attachmentId ?? derivedAttachmentId ?? path ?? originalName;
  // External uploads and public viewers have no uploader-cached thumbnail.
  const publicShare = usePublicShareContext();
  const externalAttachment = getPersistedAttachmentUploadUrl(
    path,
    routeProjectId,
  )?.startsWith("/api/local-image?");
  const nearViewport = useNearViewport(
    chipButtonRef,
    Boolean(publicShare || externalAttachment),
  );
  const {
    previewUrl: imagePreviewUrl,
    fullUrl,
    previewWidth,
    previewHeight,
    loading,
    error,
  } = useCachedAttachmentImage(
    cacheKey,
    path,
    showModal || showHoverPreview || nearViewport,
    showModal,
    previewUrl,
    routeProjectId,
  );

  const clearHoverTimer = useCallback(() => {
    if (hoverTimerRef.current !== null) {
      window.clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
  }, []);

  // Cancel a pending linger timer if the chip unmounts mid-hover.
  useEffect(() => clearHoverTimer, [clearHoverTimer]);

  const handleHoverStart = () => {
    clearHoverTimer();
    hoverTimerRef.current = window.setTimeout(() => {
      setShowHoverPreview(true);
    }, HOVER_PREVIEW_LINGER_MS);
  };

  const handleHoverEnd = () => {
    clearHoverTimer();
    setShowHoverPreview(false);
    setHoverBox(null);
  };

  const updateHoverPlacement = useCallback(() => {
    const anchor = chipButtonRef.current?.getBoundingClientRect();
    if (!anchor) return;
    const hoverImage = hoverImageRef.current;
    const width =
      imageWidth ??
      (hoverImage && hoverImage.naturalWidth > 0
        ? hoverImage.naturalWidth
        : null);
    const height =
      imageHeight ??
      (hoverImage && hoverImage.naturalHeight > 0
        ? hoverImage.naturalHeight
        : null);
    if (!width || !height) return;
    setHoverBox(
      placeAttachmentHoverPreview({
        anchor: {
          top: anchor.top,
          left: anchor.left,
          width: anchor.width,
          height: anchor.height,
        },
        imageWidth: width,
        imageHeight: height,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
      }),
    );
  }, [imageHeight, imageWidth]);

  useLayoutEffect(() => {
    if (!showHoverPreview || !fullUrl) return;
    updateHoverPlacement();
    window.addEventListener("resize", updateHoverPlacement);
    // A wheel with the pointer resting on a chip moves the thumbnail without
    // any pointer event, and the preview is fixed to the viewport, so it must
    // follow every scrolling ancestor to stay anchored.
    window.addEventListener("scroll", updateHoverPlacement, true);
    return () => {
      window.removeEventListener("resize", updateHoverPlacement);
      window.removeEventListener("scroll", updateHoverPlacement, true);
    };
  }, [fullUrl, showHoverPreview, updateHoverPlacement]);

  const previewPlan =
    previewWidth && previewHeight
      ? { width: previewWidth, height: previewHeight }
      : imageWidth && imageHeight
        ? planThumbnail(imageWidth, imageHeight)
        : null;
  const previewStyle = previewPlan
    ? {
        width: `${previewPlan.width}px`,
        height: `${previewPlan.height}px`,
      }
    : undefined;

  return (
    <>
      <div className={`${styles.chip} ${styles.imageChip}`}>
        <ButtonBase
          ref={chipButtonRef}
          className={styles.main}
          onClick={() => {
            handleHoverEnd();
            setShowModal(true);
          }}
          onMouseEnter={handleHoverStart}
          onMouseLeave={handleHoverEnd}
          onBlur={handleHoverEnd}
          aria-label={`Open ${originalName}`}
          title={`${mimeType}, ${sizeLabel}`}
        >
          <span
            className={styles.preview}
            aria-hidden="true"
            style={previewStyle}
          >
            {imagePreviewUrl ? (
              <img src={imagePreviewUrl} alt="" />
            ) : (
              <span className={styles.previewFallback}>📎</span>
            )}
          </span>
          <span className={styles.name} title={path ?? originalName}>
            {formatAttachmentName(originalName)}
          </span>
          <span className={styles.size}>{sizeLabel}</span>
        </ButtonBase>
        {onRemove && (
          <IconButton
            size="small"
            label={t("attachmentRemove", { name: originalName })}
            className={styles.remove}
            onClick={onRemove}
          >
            x
          </IconButton>
        )}
      </div>
      {showHoverPreview &&
        !showModal &&
        fullUrl &&
        createPortal(
          <div
            className={styles.hoverPreview}
            data-testid="attachment-hover-preview"
            aria-hidden="true"
            style={
              hoverBox
                ? {
                    top: hoverBox.top,
                    left: hoverBox.left,
                    width: hoverBox.width,
                    height: hoverBox.height,
                  }
                : { visibility: "hidden" }
            }
          >
            <img
              ref={hoverImageRef}
              src={fullUrl}
              alt=""
              onLoad={updateHoverPlacement}
            />
          </div>,
          document.body,
        )}
      {showModal && (
        <Modal title={originalName} onClose={() => setShowModal(false)}>
          <div
            className={promptStyles.uploadedImageModal}
            data-uploaded-image-modal
          >
            {loading && <div>Loading...</div>}
            {error && <div>Failed to load image</div>}
            {fullUrl && <img src={fullUrl} alt={originalName} />}
          </div>
        </Modal>
      )}
    </>
  );
}

export function AttachmentChip(props: AttachmentChipProps) {
  if (!isImageMimeType(props.mimeType)) {
    return <NonImageAttachmentChip {...props} />;
  }

  return <ImageAttachmentChip {...props} />;
}
