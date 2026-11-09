import type {
  ProjectQueueItemSummary,
  ProjectQueueMessage,
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
import { deleteDraftAttachmentRef } from "../lib/draftAttachmentStaging";
import { formatFileSize } from "../lib/formatFileSize";
import { useComposerDraftAttachments } from "../hooks/useComposerDraftAttachments";
import type { DraftControls } from "../hooks/useDraftPersistence";
import {
  type ComposerAttachment,
  type ComposerStagedAttachment,
  isComposerStagedAttachment,
  toPersistedStagedAttachmentRef,
} from "../lib/sessionComposerAttachments";
import { AttachmentChip } from "./AttachmentChip";
import styles from "./ProjectQueueSection.module.css";
import { Banner } from "./ui/Banner";
import { Button } from "./ui/Button";
import { Textarea } from "./ui/Field";

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
  const [editError, setEditError] = useState<string | null>(null);
  const savedRef = useRef(false);
  // The item as it opened: its files belong to the saved queue item, so
  // only files added here are deleted from staging (docs/tactical/188,
  // items 21 and 22). Read once; a refreshed item summary changes nothing.
  const [opened] = useState(() => {
    const initialAttachments: ComposerAttachment[] = [
      ...(item.message.attachments ?? []),
      ...(item.message.stagedAttachments?.refs ?? []),
    ];
    const ids = new Set(initialAttachments.map((attachment) => attachment.id));
    return {
      initialAttachments,
      ownsStagedAttachment: (attachment: ComposerStagedAttachment) =>
        !ids.has(attachment.id),
    };
  });
  const noDraftRef = useRef<DraftControls | null>(null);
  const reportError = useCallback(
    (error: unknown) =>
      setEditError(
        t("projectQueueInlineEditFailed", {
          message: error instanceof Error ? error.message : String(error),
        }),
      ),
    [t],
  );
  const {
    attachments,
    attachmentsRef,
    uploadProgress,
    uploadFiles,
    cancelUpload,
    removeAttachment,
  } = useComposerDraftAttachments({
    draftControlsRef: noDraftRef,
    draftKey: null,
    hydrationEnabled: false,
    initialAttachments: opened.initialAttachments,
    ownsStagedAttachment: opened.ownsStagedAttachment,
    sourceTransport,
    versionInfo: null,
    versionFailed: false,
    onUploadError: (_file, error) => reportError(error),
    onDeleteError: reportError,
  });
  const sourceTransportRef = useRef(sourceTransport);
  sourceTransportRef.current = sourceTransport;

  // Closing without saving deletes the files added here.
  useEffect(
    () => () => {
      if (savedRef.current) return;
      for (const attachment of attachmentsRef.current) {
        if (
          isComposerStagedAttachment(attachment) &&
          opened.ownsStagedAttachment(attachment)
        )
          void deleteDraftAttachmentRef(
            sourceTransportRef.current,
            attachment.batchId,
            attachment.id,
          ).catch(() => undefined);
      }
    },
    [opened],
  );

  const addFiles = (files: readonly File[]) => {
    setEditError(null);
    void uploadFiles(files, {
      imageProfile: getAttachmentUploadProfile(
        attachmentQuality,
        providerInfo,
        item.target.model,
      ),
      history: null,
    });
  };

  const handlePaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(event.clipboardData?.items ?? [])
      .filter((item) => item.kind === "file")
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null);
    if (files.length === 0) return;
    event.preventDefault();
    addFiles(files);
  };

  const canSave =
    !disabled &&
    uploadProgress.length === 0 &&
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
      {(attachments.length > 0 || uploadProgress.length > 0) && (
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
                disabled ? undefined : () => removeAttachment(attachment.id)
              }
            />
          ))}
          {uploadProgress.map((upload) => (
            <AttachmentChip
              key={upload.fileId}
              originalName={upload.fileName}
              mimeType={upload.mimeType}
              sizeLabel={`${upload.percent}%`}
              onRemove={() => cancelUpload(upload.fileId)}
            />
          ))}
        </div>
      )}
      {editError && (
        <Banner tone="error" compact>
          {editError}
        </Banner>
      )}
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
