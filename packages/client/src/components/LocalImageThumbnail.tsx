import type { SyntheticEvent } from "react";
import { useRemoteImage } from "../hooks/useRemoteImage";
import { useI18n } from "../i18n";
import { useImageResourceActions } from "./ImageResourceActions";
import { ButtonBase } from "./ui/Button";

interface LocalImageThumbnailProps {
  /** Alternative text for the loaded image. */
  alt: string;
  /** Accessible name for the clickable thumbnail. */
  ariaLabel: string;
  buttonClassName: string | undefined;
  /** Name offered by the context menu's download and copy actions. */
  fileName: string;
  filePath: string;
  /** Reads the image bytes; also used by the context menu's actions. */
  loadBlob: () => Promise<Blob>;
  onImageLoad?: (event: SyntheticEvent<HTMLImageElement>) => void;
  onOpen: () => void;
  placeholderClassName: string | undefined;
  title?: string;
}

/**
 * A clickable thumbnail for an image YA reads back from the session's media
 * route, with the loading and unavailable placeholders every such thumbnail
 * shows. Callers own the surrounding layout and pass their own class names;
 * the object-URL lifetime belongs to `useRemoteImage`.
 */
export function LocalImageThumbnail({
  alt,
  ariaLabel,
  buttonClassName,
  fileName,
  filePath,
  loadBlob,
  onImageLoad,
  onOpen,
  placeholderClassName,
  title,
}: LocalImageThumbnailProps) {
  const { t } = useI18n();
  const { url, error } = useRemoteImage(filePath, true, loadBlob);
  const imageActions = useImageResourceActions({
    fileName,
    filePath,
    loadBlob,
    onOpen,
  });

  return (
    <>
      <ButtonBase
        className={buttonClassName}
        aria-label={ariaLabel}
        title={title}
        onClick={onOpen}
        onContextMenu={imageActions.handleContextMenu}
      >
        {url ? (
          <img src={url} alt={alt} draggable={false} onLoad={onImageLoad} />
        ) : (
          <span className={placeholderClassName}>
            {error ? t("inlineImageUnavailable") : t("inlineImageLoading")}
          </span>
        )}
      </ButtonBase>
      {imageActions.contextMenuElement}
    </>
  );
}
