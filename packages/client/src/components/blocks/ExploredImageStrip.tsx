import mediaStyles from "../LocalMediaLink.module.css";
import type { ToolResultMedia } from "@yep-anywhere/shared";
import { useCallback, useMemo, useState } from "react";
import { useOptionalSessionMetadata } from "../../contexts/SessionMetadataContext";
import { useCurrentSourceRuntime } from "../../contexts/SourceRuntimeContext";
import { useInlineMedia } from "../../hooks/useInlineMedia";
import { useI18n } from "../../i18n";
import type { ExplorationParent } from "../../lib/sessionDetail/explorationProjection";
import { getPathBasename } from "../../lib/text";
import { LocalImageThumbnail } from "../LocalImageThumbnail";
import {
  fetchLocalMediaBlob,
  LocalMediaModal,
  type LocalMediaSource,
  useLocalFileScope,
} from "../LocalMediaModal";
import { IconButton } from "../ui/Button";
import styles from "./ExploredImageStrip.module.css";

export interface ExploredImage {
  id: string;
  name: string;
  path: string;
  /** The session's stored copy of the bytes the read returned, when kept. */
  mediaId?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function storedImageMediaId(
  media: readonly ToolResultMedia[] | undefined,
): string | undefined {
  for (const entry of media ?? []) {
    if (entry.state === "stored" && entry.mimeType.startsWith("image/")) {
      return entry.id;
    }
  }
  return undefined;
}

/**
 * Where an image's bytes come from. The stored copy is served by the session's
 * own media route, which anyone who may read the session may use, and it is
 * the image the model saw even when the file has since changed, moved, or only
 * ever existed in a sandbox's private scratch space. The host-path read is the
 * fallback for a read the server kept no copy of.
 */
function useExploredImageSource(
  image: ExploredImage | null,
): LocalMediaSource | undefined {
  const session = useOptionalSessionMetadata();
  const projectId = session?.projectId;
  const sessionId = session?.sessionId;
  const mediaId = image?.mediaId;
  return useMemo(() => {
    if (!mediaId || !projectId || !sessionId) return undefined;
    const apiPath = `/api/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}/media/${encodeURIComponent(mediaId)}`;
    return { buildApiPath: () => apiPath };
  }, [mediaId, projectId, sessionId]);
}

function imagePathForTool(input: unknown, structured: unknown): string | null {
  for (const key of ["file_path", "path", "filePath"]) {
    const value = isRecord(input) ? input[key] : undefined;
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  const file = isRecord(structured) ? structured.file : undefined;
  const resultPath = isRecord(file) ? file.filePath : undefined;
  return typeof resultPath === "string" && resultPath.trim()
    ? resultPath.trim()
    : null;
}

/**
 * A grouped exploration hides each image read behind a one-line filename. The
 * strip shows what the model actually looked at, reading each file back through
 * the session's media route rather than depending on provider bytes that the
 * transcript no longer carries.
 */
export function collectExploredImages(
  parents: readonly ExplorationParent[],
): ExploredImage[] {
  const images: ExploredImage[] = [];
  const byPath = new Map<string, ExploredImage>();
  for (const parent of parents) {
    const structured = parent.item.toolResult?.structured;
    const isImageResult = isRecord(structured) && structured.type === "image";
    if (!isImageResult) continue;
    const path = imagePathForTool(parent.item.toolInput, structured);
    if (!path) continue;
    const mediaId = storedImageMediaId(parent.item.toolResult?.media);
    const seen = byPath.get(path);
    if (seen) {
      // One entry per path, showing the latest bytes read from it.
      if (mediaId) seen.mediaId = mediaId;
      continue;
    }
    const image: ExploredImage = {
      id: parent.item.id,
      name: getPathBasename(path),
      path,
      ...(mediaId ? { mediaId } : {}),
    };
    byPath.set(path, image);
    images.push(image);
  }
  return images;
}

function ExploredImageThumbnail({
  image,
  onOpen,
}: {
  image: ExploredImage;
  onOpen: () => void;
}) {
  const transport = useCurrentSourceRuntime().transport;
  const fileScope = useLocalFileScope();
  const source = useExploredImageSource(image);
  const loadBlob = useCallback(
    () =>
      fetchLocalMediaBlob(image.path, source, "inline", transport, fileScope),
    [image.path, source, transport, fileScope],
  );

  return (
    <div className={styles.item}>
      <LocalImageThumbnail
        alt={image.name}
        ariaLabel={image.name}
        buttonClassName={styles.thumbnail}
        fileName={image.name}
        filePath={image.path}
        loadBlob={loadBlob}
        onOpen={onOpen}
        placeholderClassName={styles.placeholder}
        title={image.name}
      />
      <span className={styles.caption}>{image.name}</span>
    </div>
  );
}

export function ExploredImageStrip({
  images,
}: {
  images: readonly ExploredImage[];
}) {
  const { t } = useI18n();
  const { inlineMediaExpandedByDefault } = useInlineMedia();
  const [override, setOverride] = useState<boolean | null>(null);
  const expanded = override ?? inlineMediaExpandedByDefault;
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const open = openIndex === null ? null : (images[openIndex] ?? null);
  const openSource = useExploredImageSource(open);
  const label = t(
    images.length === 1 ? "exploredImagesOne" : "exploredImagesMany",
    { count: images.length },
  );

  return (
    <div className={styles.strip} data-explored-images={images.length}>
      <div className={mediaStyles.group}>
        <IconButton
          variant="outline"
          size="dense"
          aria-expanded={expanded}
          label={expanded ? t("explorationCollapse") : label}
          onClick={() => setOverride(!expanded)}
        >
          {expanded ? "-" : "+"}
        </IconButton>
        <span className={mediaStyles.type}>{label}</span>
      </div>
      {expanded && (
        <div className={styles.row}>
          {images.map((image, index) => (
            <ExploredImageThumbnail
              key={`${image.id}:${image.path}`}
              image={image}
              onOpen={() => setOpenIndex(index)}
            />
          ))}
        </div>
      )}
      {open ? (
        <LocalMediaModal
          path={open.path}
          mediaType="image"
          mediaSource={openSource}
          imageNavigation={
            images.length > 1 && openIndex !== null
              ? {
                  count: images.length,
                  current: openIndex + 1,
                  onNext: () =>
                    setOpenIndex((index) =>
                      index === null ? null : (index + 1) % images.length,
                    ),
                  onPrevious: () =>
                    setOpenIndex((index) =>
                      index === null
                        ? null
                        : (index - 1 + images.length) % images.length,
                    ),
                }
              : undefined
          }
          onClose={() => setOpenIndex(null)}
        />
      ) : null}
    </div>
  );
}
