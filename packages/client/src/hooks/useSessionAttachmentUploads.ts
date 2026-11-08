import {
  type Dispatch,
  type RefObject,
  type SetStateAction,
  useCallback,
} from "react";
import type { UploadProgress } from "../components/MessageInput";
import type { useCurrentSourceRuntime } from "../contexts/SourceRuntimeContext";
import { useToastContext } from "../contexts/ToastContext";
import { useI18n } from "../i18n";
import { storeUploadedAttachmentPreview } from "../lib/attachmentPreviewCache";
import { rememberComposerUpload } from "../lib/composerHistory";
import { deleteDraftAttachmentRef } from "../lib/draftAttachmentStaging";
import {
  type ComposerAttachment,
  isComposerStagedAttachment,
} from "../lib/sessionComposerAttachments";
import { uploadComposerAttachmentFile } from "../lib/sessionComposerSubmission";
import type { resolveSessionModelConfig } from "../lib/sessionModelConfig";
import { generateUUID } from "../lib/uuid";
import {
  getAttachmentUploadProfile,
  type useAttachmentUploadQuality,
} from "./useAttachmentUploadQuality";
import { useIncomingShareFiles } from "./useIncomingShareFiles";
import type { useProject } from "./useProjects";
import type { useSession } from "./useSession";

/**
 * One session page's attachment uploads: uploading picked, pasted, dropped
 * or shared files in parallel (progress, the composer-history record, the
 * preview cache, the failure toast), and removing an attachment, which
 * deletes a staged one. The attachment state itself stays in the page.
 * Moved verbatim from `SessionPage.tsx`
 * (docs/tactical/181-session-page-feature-hooks.md slice 4).
 */
export function useSessionAttachmentUploads({
  projectId,
  sessionId,
  session,
  project,
  sourceTransport,
  attachmentQuality,
  currentProviderInfo,
  effectiveModel,
  effectiveModelConfig,
  historyScope,
  isDomLingerParked,
  ensureDraftAttachmentBatchId,
  setUploadProgress,
  setComposerAttachments,
  attachmentsRef,
  pendingUploadsRef,
}: {
  projectId: string;
  sessionId: string;
  session: ReturnType<typeof useSession>["session"];
  project: ReturnType<typeof useProject>["project"];
  sourceTransport: ReturnType<typeof useCurrentSourceRuntime>["transport"];
  attachmentQuality: ReturnType<typeof useAttachmentUploadQuality>[0];
  currentProviderInfo: Parameters<typeof getAttachmentUploadProfile>[1];
  effectiveModel: string | undefined;
  effectiveModelConfig: ReturnType<typeof resolveSessionModelConfig>;
  historyScope: string | null;
  isDomLingerParked: boolean;
  ensureDraftAttachmentBatchId: () => string;
  setUploadProgress: Dispatch<SetStateAction<UploadProgress[]>>;
  setComposerAttachments: (
    updater:
      | ComposerAttachment[]
      | ((previous: readonly ComposerAttachment[]) => ComposerAttachment[]),
    options?: {
      persistDraft?: boolean;
      revokeRemovedPreviewUrls?: boolean;
    },
  ) => void;
  attachmentsRef: RefObject<ComposerAttachment[]>;
  pendingUploadsRef: RefObject<Map<string, Promise<ComposerAttachment | null>>>;
}) {
  const { t } = useI18n();
  const { showToast } = useToastContext();

  // Handle file attachment uploads
  // Each file uploads independently (parallel) and its promise is tracked
  // so handleSend can wait for in-flight uploads before sending
  const uploadAttachedFiles = useCallback(
    (files: File[]) => {
      const uploads: Promise<ComposerAttachment | null>[] = [];
      const draftBatchId = ensureDraftAttachmentBatchId();
      for (const file of files) {
        const tempId = generateUUID();

        // Add to progress tracking
        setUploadProgress((prev) => [
          ...prev,
          {
            fileId: tempId,
            fileName: file.name,
            bytesUploaded: 0,
            totalBytes: file.size,
            percent: 0,
          },
        ]);

        // Start upload and track promise for handleSend to await
        const uploadPromise = uploadComposerAttachmentFile({
          file,
          sourceTransport,
          projectId,
          sessionId,
          imageProfile: getAttachmentUploadProfile(
            attachmentQuality,
            currentProviderInfo,
            effectiveModelConfig?.model ?? effectiveModel,
          ),
          stagedBatchId: draftBatchId ? draftBatchId : null,
          onProgress: (bytesUploaded, uploadFile) => {
            setUploadProgress((prev) =>
              prev.map((p) =>
                p.fileId === tempId
                  ? {
                      ...p,
                      bytesUploaded,
                      percent: Math.round(
                        (bytesUploaded / uploadFile.size) * 100,
                      ),
                    }
                  : p,
              ),
            );
          },
        })
          .then(
            (uploaded) => {
              if (historyScope)
                void rememberComposerUpload(historyScope, file, {
                  projectId,
                  projectName: project?.name,
                  sessionId,
                  sessionTitle: session?.title ?? undefined,
                }).catch((cause) =>
                  showToast(
                    t("composerHistorySaveError", { error: String(cause) }),
                    "error",
                  ),
                );
              if (uploaded.mimeType.startsWith("image/")) {
                const cachedFile = isComposerStagedAttachment(uploaded)
                  ? {
                      id: uploaded.id,
                      originalName: uploaded.originalName,
                      name: uploaded.name,
                      path: uploaded.id,
                      size: uploaded.size,
                      mimeType: uploaded.mimeType,
                      ...(uploaded.width !== undefined
                        ? { width: uploaded.width }
                        : {}),
                      ...(uploaded.height !== undefined
                        ? { height: uploaded.height }
                        : {}),
                    }
                  : uploaded;
                void storeUploadedAttachmentPreview(cachedFile, file).catch(
                  (err) => {
                    console.warn(
                      "[SessionPage] Failed to cache attachment preview:",
                      err,
                    );
                  },
                );
              }
              setComposerAttachments((prev) => [...prev, uploaded]);
              return uploaded;
            },
            (err) => {
              console.error("Upload failed:", err);
              const errorMsg =
                err instanceof Error ? err.message : t("sessionShareFailed");
              showToast(
                t("sessionUploadFailed", {
                  file: file.name,
                  message: errorMsg,
                }),
                "error",
              );
              return null as ComposerAttachment | null;
            },
          )
          .finally(() => {
            setUploadProgress((prev) =>
              prev.filter((p) => p.fileId !== tempId),
            );
            pendingUploadsRef.current.delete(tempId);
          });

        pendingUploadsRef.current.set(tempId, uploadPromise);
        uploads.push(uploadPromise);
      }
      return Promise.all(uploads);
    },
    [
      pendingUploadsRef,
      setUploadProgress,
      attachmentQuality,
      currentProviderInfo,
      effectiveModelConfig?.model,
      effectiveModel,
      sourceTransport,
      ensureDraftAttachmentBatchId,
      projectId,
      sessionId,
      setComposerAttachments,
      showToast,
      historyScope,
      project?.name,
      session?.title,
      t,
    ],
  );

  const handleAttach = useCallback(
    async (files: File[]) => {
      await uploadAttachedFiles(files);
    },
    [uploadAttachedFiles],
  );

  useIncomingShareFiles(handleAttach, {
    enabled: !isDomLingerParked,
    onError: () => showToast(t("incomingShareAttachmentUnavailable"), "error"),
  });

  const handleRemoveAttachment = useCallback(
    (id: string) => {
      const removed = attachmentsRef.current.find(
        (attachment) => attachment.id === id,
      );
      setComposerAttachments(
        (prev) => prev.filter((attachment) => attachment.id !== id),
        { revokeRemovedPreviewUrls: true },
      );

      if (removed && isComposerStagedAttachment(removed)) {
        deleteDraftAttachmentRef(
          sourceTransport,
          removed.batchId,
          removed.id,
        ).catch((err) => {
          console.warn(
            "[SessionPage] Failed to delete staged attachment:",
            err,
          );
        });
      }
    },
    [attachmentsRef, sourceTransport, setComposerAttachments],
  );

  return { uploadAttachedFiles, handleAttach, handleRemoveAttachment };
}
