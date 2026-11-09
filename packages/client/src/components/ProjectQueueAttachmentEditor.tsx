import type {
  ProjectQueueItemSummary,
  ProjectQueueMessage,
  StagedAttachmentRef,
  UploadedFile,
} from "@yep-anywhere/shared";
import {
  type ClipboardEvent,
  type FormEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { useCurrentSourceRuntime } from "../contexts/SourceRuntimeContext";
import {
  getAttachmentUploadProfile,
  useAttachmentUploadQuality,
} from "../hooks/useAttachmentUploadQuality";
import { useI18n } from "../i18n";
import { useProviderRow } from "../hooks/useProviders";
import { makeAttachmentFileNamesUnique } from "../lib/attachmentFileNames";
import { useAttachmentNavigationGuard } from "../lib/attachmentNavigationGuard";
import { deleteDraftAttachmentRef } from "../lib/draftAttachmentStaging";
import { formatFileSize } from "../lib/formatFileSize";
import {
  type ComposerAttachment,
  isComposerStagedAttachment,
  revokeAttachmentPreviewUrls,
  toPersistedStagedAttachmentRef,
} from "../lib/sessionComposerAttachments";
import { uploadComposerAttachmentFile } from "../lib/sessionComposerSubmission";
import { generateUUID } from "../lib/uuid";
import { AttachmentChip } from "./AttachmentChip";
import styles from "./ProjectQueueSection.module.css";
import { Button } from "./ui/Button";
import { Textarea } from "./ui/Field";

interface UploadingAttachment {
  id: string;
  originalName: string;
  mimeType: string;
  size: number;
  percent: number;
}

interface ProjectQueueAttachmentEditorProps {
  item: ProjectQueueItemSummary;
  disabled: boolean;
  onSave: (message: ProjectQueueMessage) => Promise<void> | void;
  onDiscard: () => void;
}

function toPersistedUploadedFile(attachment: ComposerAttachment): UploadedFile {
  if (isComposerStagedAttachment(attachment)) {
    throw new Error("Expected a materialized attachment");
  }
  const { previewUrl: _previewUrl, ...uploadedFile } = attachment;
  return uploadedFile;
}

export function ProjectQueueAttachmentEditor({
  item,
  disabled,
  onSave,
  onDiscard,
}: ProjectQueueAttachmentEditorProps) {
  const { t } = useI18n();
  const sourceTransport = useCurrentSourceRuntime().transport;
  const [attachmentQuality] = useAttachmentUploadQuality();
  const { row: providerInfo } = useProviderRow(item.target.provider);
  const [text, setText] = useState(item.message.text);
  const [attachments, setAttachments] = useState<ComposerAttachment[]>(() => [
    ...(item.message.attachments ?? []),
    ...(item.message.stagedAttachments?.refs ?? []),
  ]);
  const [uploading, setUploading] = useState<UploadingAttachment[]>([]);
  const [editError, setEditError] = useState<string | null>(null);
  const attachmentsRef = useRef(attachments);
  const batchIdRef = useRef(item.message.stagedAttachments?.batchId ?? null);
  const addedStagedRefIds = useRef(new Set<string>());
  const removedUploadIds = useRef(new Set<string>());
  const mountedRef = useRef(true);
  const savedRef = useRef(false);
  const sourceTransportRef = useRef(sourceTransport);

  useEffect(() => {
    attachmentsRef.current = attachments;
  }, [attachments]);

  useEffect(() => {
    sourceTransportRef.current = sourceTransport;
  }, [sourceTransport]);

  const deleteNewDraftRef = useCallback(
    (ref: StagedAttachmentRef) => {
      void deleteDraftAttachmentRef(sourceTransport, ref.batchId, ref.id).catch(
        (error) => {
          if (mountedRef.current) {
            setEditError(
              t("projectQueueInlineEditFailed", {
                message: error instanceof Error ? error.message : String(error),
              }),
            );
          }
        },
      );
    },
    [sourceTransport, t],
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (!savedRef.current) {
        for (const attachment of attachmentsRef.current) {
          if (
            isComposerStagedAttachment(attachment) &&
            addedStagedRefIds.current.has(attachment.id)
          ) {
            void deleteDraftAttachmentRef(
              sourceTransportRef.current,
              attachment.batchId,
              attachment.id,
            ).catch(() => undefined);
          }
        }
      }
      revokeAttachmentPreviewUrls(attachmentsRef.current);
    };
  }, []);

  const hasUnsavedAttachments =
    uploading.length > 0 ||
    attachments.some((attachment) =>
      addedStagedRefIds.current.has(attachment.id),
    );
  useAttachmentNavigationGuard(hasUnsavedAttachments);

  const addFiles = useCallback(
    (files: readonly File[]) => {
      const uniqueFiles = makeAttachmentFileNamesUnique(files, [
        ...attachmentsRef.current.map((attachment) => attachment.originalName),
        ...uploading.map((attachment) => attachment.originalName),
      ]);
      if (uniqueFiles.length === 0) return;

      const batchId = batchIdRef.current ?? generateUUID();
      batchIdRef.current = batchId;
      setEditError(null);

      for (const file of uniqueFiles) {
        const tempId = `project-queue-upload-${generateUUID()}`;
        setUploading((current) => [
          ...current,
          {
            id: tempId,
            originalName: file.name,
            mimeType: file.type || "application/octet-stream",
            size: file.size,
            percent: 0,
          },
        ]);

        void uploadComposerAttachmentFile({
          file,
          sourceTransport,
          projectId: item.projectId,
          sessionId: item.id,
          imageProfile: getAttachmentUploadProfile(
            attachmentQuality,
            providerInfo,
            item.target.model,
          ),
          stagedBatchId: batchId,
          onProgress: (bytesUploaded, uploadFile) => {
            const percent =
              uploadFile.size > 0
                ? Math.round((bytesUploaded / uploadFile.size) * 100)
                : 100;
            setUploading((current) =>
              current.map((attachment) =>
                attachment.id === tempId
                  ? { ...attachment, percent }
                  : attachment,
              ),
            );
          },
        })
          .then((uploaded) => {
            if (!isComposerStagedAttachment(uploaded)) {
              throw new Error("Project Queue uploads must remain staged");
            }
            const stagedAttachment = {
              ...uploaded,
              originalName: file.name,
            };
            const wasRemoved =
              removedUploadIds.current.delete(tempId) || !mountedRef.current;
            if (wasRemoved) {
              deleteNewDraftRef(stagedAttachment);
              revokeAttachmentPreviewUrls([stagedAttachment]);
              return;
            }
            addedStagedRefIds.current.add(stagedAttachment.id);
            setAttachments((current) => [...current, stagedAttachment]);
          })
          .catch((error) => {
            const wasRemoved = removedUploadIds.current.delete(tempId);
            if (!wasRemoved && mountedRef.current) {
              setEditError(
                t("projectQueueInlineEditFailed", {
                  message:
                    error instanceof Error ? error.message : String(error),
                }),
              );
            }
          })
          .finally(() => {
            if (mountedRef.current) {
              setUploading((current) =>
                current.filter((attachment) => attachment.id !== tempId),
              );
            }
          });
      }
    },
    [
      attachmentQuality,
      providerInfo,
      deleteNewDraftRef,
      item,
      sourceTransport,
      t,
      uploading,
    ],
  );

  const handlePaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(event.clipboardData?.items ?? [])
      .filter((item) => item.kind === "file")
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null);
    if (files.length === 0) return;
    event.preventDefault();
    addFiles(files);
  };

  const handleRemoveAttachment = (attachmentId: string) => {
    const removed = attachmentsRef.current.find(
      (attachment) => attachment.id === attachmentId,
    );
    setAttachments((current) =>
      current.filter((attachment) => attachment.id !== attachmentId),
    );
    if (
      removed &&
      isComposerStagedAttachment(removed) &&
      addedStagedRefIds.current.delete(removed.id)
    ) {
      deleteNewDraftRef(removed);
    }
    if (removed) revokeAttachmentPreviewUrls([removed]);
  };

  const handleRemoveUpload = (uploadId: string) => {
    removedUploadIds.current.add(uploadId);
    setUploading((current) =>
      current.filter((attachment) => attachment.id !== uploadId),
    );
  };

  const canSave =
    !disabled &&
    uploading.length === 0 &&
    (text.trim().length > 0 || attachments.length > 0);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canSave) return;
    const uploadedFiles = attachments
      .filter((attachment) => !isComposerStagedAttachment(attachment))
      .map(toPersistedUploadedFile);
    const stagedRefs = attachments
      .filter(isComposerStagedAttachment)
      .map(toPersistedStagedAttachmentRef);
    const stagedBatchId = stagedRefs[0]?.batchId;
    if (stagedRefs.some((ref) => ref.batchId !== stagedBatchId)) {
      setEditError(
        t("projectQueueInlineEditFailed", {
          message: t("projectQueueAttachmentBatchMismatch"),
        }),
      );
      return;
    }

    setEditError(null);
    try {
      await onSave({
        ...item.message,
        text,
        attachments: uploadedFiles.length > 0 ? uploadedFiles : undefined,
        stagedAttachments:
          stagedRefs.length > 0 && stagedBatchId
            ? {
                batchId: stagedBatchId,
                refs: stagedRefs,
                updatedAt: new Date().toISOString(),
              }
            : undefined,
      });
      savedRef.current = true;
      onDiscard();
    } catch (error) {
      setEditError(
        t("projectQueueInlineEditFailed", {
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  };

  return (
    <form className={styles.itemEdit} onSubmit={handleSubmit}>
      <Textarea
        value={text}
        onChange={(event) => setText(event.target.value)}
        onPaste={handlePaste}
        aria-label={t("projectQueueEditMessageLabel")}
        disabled={disabled}
        rows={3}
      />
      {(attachments.length > 0 || uploading.length > 0) && (
        <div className={styles.itemEditAttachments}>
          {attachments.map((attachment) => (
            <AttachmentChip
              key={attachment.id}
              attachmentId={attachment.id}
              originalName={attachment.originalName}
              path={
                isComposerStagedAttachment(attachment)
                  ? undefined
                  : attachment.path
              }
              mimeType={attachment.mimeType}
              sizeLabel={formatFileSize(attachment.size)}
              imageWidth={attachment.width}
              imageHeight={attachment.height}
              previewUrl={attachment.previewUrl}
              projectId={item.projectId}
              onRemove={
                disabled
                  ? undefined
                  : () => handleRemoveAttachment(attachment.id)
              }
            />
          ))}
          {uploading.map((attachment) => (
            <AttachmentChip
              key={attachment.id}
              originalName={attachment.originalName}
              mimeType={attachment.mimeType}
              sizeLabel={`${attachment.percent}%`}
              onRemove={() => handleRemoveUpload(attachment.id)}
            />
          ))}
        </div>
      )}
      {editError && <div className={styles.itemError}>{editError}</div>}
      <div className={styles.itemEditActions}>
        <Button
          variant="primary"
          size="small"
          type="submit"
          disabled={!canSave}
        >
          {t("projectQueueSave")}
        </Button>
        <Button size="small" disabled={disabled} onClick={onDiscard}>
          {t("projectQueueDiscard")}
        </Button>
      </div>
    </form>
  );
}
