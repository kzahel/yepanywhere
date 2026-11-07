import type {
  StagedAttachmentRef,
  ImagePreparationProfile,
  ThinkingOption,
  TurnEffort,
  UploadedFile,
} from "@yep-anywhere/shared";
import type { DraftControls } from "../hooks/useDraftPersistence";
import {
  imageDimensionOptions,
  prepareComposerAttachmentUpload,
} from "./composerAttachmentUpload";
import { materializeDraftAttachmentsForSession } from "./draftAttachmentStaging";
import type { DraftAttachmentState } from "./draftEnvelope";
import {
  type ComposerAttachment,
  type ComposerStagedAttachment,
  type ComposerUploadedAttachment,
  isComposerStagedAttachment,
  toPersistedStagedAttachmentRef,
} from "./sessionComposerAttachments";
import type { SourceTransport } from "./transport";
import { getPersistedAttachmentUploadUrl } from "./attachmentUploadUrl";
import { toSourceTransportApiPath } from "./sourceTransportPaths";
import { generateUUID } from "./uuid";

export interface PreparedComposerSubmission {
  outgoingText: string;
  /** Queued provider control must never fall back to a fresh resume turn. */
  queuedCompact?: true;
  thinking?: ThinkingOption;
  slashCommand?: TurnEffort | "run";
  turnEffort?: TurnEffort;
}

export interface ComposerTransferReplacement {
  start: number;
  end: number;
  replacement: string;
  nextDraft: string;
}

export function hasComposerDraftContent(
  text: string,
  attachmentCount = 0,
): boolean {
  return text.trim().length > 0 || attachmentCount > 0;
}

export function getComposerTransferReplacement(
  currentDraft: string,
  text: string,
): ComposerTransferReplacement {
  const current = currentDraft.trimEnd();
  const addition = text.trim();
  if (!current) {
    return {
      start: 0,
      end: currentDraft.length,
      replacement: addition,
      nextDraft: addition,
    };
  }
  if (!addition) {
    return {
      start: current.length,
      end: currentDraft.length,
      replacement: "",
      nextDraft: current,
    };
  }
  const replacement = `\n\n${addition}`;
  return {
    start: current.length,
    end: currentDraft.length,
    replacement,
    nextDraft: `${current}${replacement}`,
  };
}

export function appendComposerTransferDraft(
  currentDraft: string,
  text: string,
): string {
  return getComposerTransferReplacement(currentDraft, text).nextDraft;
}

/** The draft operations {@link insertComposerTransferText} writes through. */
export type ComposerTransferDraftControls = Pick<
  DraftControls,
  "getDraft" | "setDraft" | "replaceDraftRangeUndoably"
>;

/**
 * Insert text into the composer draft without discarding what the user typed:
 * an empty draft becomes the text, a nonempty one keeps its text and gains the
 * insertion after a blank line. The textarea's undo stack records the edit
 * when the composer is mounted. `suffix` follows the inserted text verbatim.
 * Returns the resulting draft.
 */
export function insertComposerTransferText(
  controls: ComposerTransferDraftControls,
  text: string,
  suffix = "",
): string {
  const currentDraft = controls.getDraft();
  const transfer = getComposerTransferReplacement(currentDraft, text);
  const replacement = `${transfer.replacement}${suffix}`;
  const nextDraft = `${currentDraft.slice(0, transfer.start)}${replacement}${currentDraft.slice(transfer.end)}`;
  const undoableDraft = controls.replaceDraftRangeUndoably?.(
    transfer.start,
    transfer.end,
    replacement,
  );
  if (undoableDraft == null) {
    controls.setDraft(nextDraft);
    return nextDraft;
  }
  return undoableDraft;
}

export function appendSlashCommandDraft(
  currentDraft: string,
  command: string,
): string {
  const normalizedCommand =
    command.startsWith("/") || command.startsWith("$")
      ? command
      : `/${command}`;
  const current = currentDraft.trimEnd();
  if (/^[/\\$][^\s/\\$]*$/.test(current)) {
    return `${normalizedCommand} `;
  }
  return current ? `${current} ${normalizedCommand} ` : `${normalizedCommand} `;
}

export function createComposerDraftAttachmentState(
  composerAttachments: readonly ComposerAttachment[],
  updatedAt = new Date().toISOString(),
): DraftAttachmentState | null {
  const stagedRefs = composerAttachments
    .filter(isComposerStagedAttachment)
    .map(toPersistedStagedAttachmentRef);
  if (stagedRefs.length === 0) {
    return null;
  }

  const batchId = stagedRefs[0]?.batchId;
  if (!batchId) {
    return null;
  }

  return {
    batchId,
    refs: stagedRefs,
    updatedAt,
  };
}

export function splitComposerAttachmentsForSubmission(
  composerAttachments: readonly ComposerAttachment[],
): {
  uploadedFiles: ComposerUploadedAttachment[];
  draftState: DraftAttachmentState | null;
} {
  const uploadedFiles = composerAttachments.filter(
    (attachment): attachment is ComposerUploadedAttachment =>
      !isComposerStagedAttachment(attachment),
  );
  const draftState = createComposerDraftAttachmentState(composerAttachments);
  if (!draftState) {
    return { uploadedFiles, draftState: null };
  }
  return { uploadedFiles, draftState };
}

/** Copy source-session uploads into account staging before choosing a new session destination. */
export async function stageComposerAttachmentsForNewSession({
  attachments,
  sourceTransport,
  sourceProjectId,
}: {
  attachments: readonly ComposerAttachment[];
  sourceTransport: Pick<
    SourceTransport,
    "fetchBlob" | "uploadStagedAttachment"
  >;
  sourceProjectId: string;
}): Promise<ComposerStagedAttachment[]> {
  const batchId =
    attachments.find(isComposerStagedAttachment)?.batchId ?? generateUUID();
  const staged: ComposerStagedAttachment[] = [];
  for (const attachment of attachments) {
    if (isComposerStagedAttachment(attachment)) {
      staged.push(attachment);
      continue;
    }
    const url = getPersistedAttachmentUploadUrl(
      attachment.path,
      sourceProjectId,
    );
    if (!url)
      throw new Error(
        `Cannot locate attachment for new session: ${attachment.originalName}`,
      );
    const blob = await sourceTransport.fetchBlob(toSourceTransportApiPath(url));
    const file = new File([blob], attachment.originalName, {
      type: attachment.mimeType,
    });
    const ref = await sourceTransport.uploadStagedAttachment(file, {
      batchId,
      ...imageDimensionOptions(attachment.width, attachment.height),
    });
    staged.push({ ...ref, previewUrl: attachment.previewUrl });
  }
  return staged;
}

export async function materializeComposerAttachmentsForSubmission({
  attachments,
  sourceTransport,
  projectId,
  sessionId,
}: {
  attachments: readonly ComposerAttachment[];
  sourceTransport: Pick<SourceTransport, "fetch">;
  projectId: string;
  sessionId: string;
}): Promise<UploadedFile[]> {
  const { uploadedFiles, draftState } =
    splitComposerAttachmentsForSubmission(attachments);
  if (!draftState) {
    return uploadedFiles;
  }

  const materializedFiles = await materializeDraftAttachmentsForSession(
    sourceTransport,
    projectId,
    sessionId,
    draftState,
  );
  return [...uploadedFiles, ...materializedFiles];
}

/** Keeps successful uploads available when a submission must stop for a failed file. */
export class ComposerAttachmentUploadError extends Error {
  constructor(
    readonly attachments: ComposerAttachment[],
    message: string,
  ) {
    super(message);
    this.name = "ComposerAttachmentUploadError";
  }
}

export async function collectComposerAttachmentsForSubmission({
  currentAttachments,
  pendingUploads,
  setComposerAttachments,
  pendingMessageId,
  updatePendingMessage,
  uploadingStatus,
  uploadFailureMessage = "An attachment failed to upload. Attach it again before sending.",
  collectSyncedAttachments,
  detach = true,
}: {
  detach?: boolean;
  currentAttachments: readonly ComposerAttachment[];
  pendingUploads: readonly Promise<ComposerAttachment | null>[];
  setComposerAttachments: (
    updater:
      | ComposerAttachment[]
      | ((previous: readonly ComposerAttachment[]) => ComposerAttachment[]),
    options?: { persistDraft?: boolean },
  ) => void;
  pendingMessageId?: string;
  updatePendingMessage?: (
    id: string,
    updates: { status?: string | undefined },
  ) => void;
  uploadingStatus?: string;
  uploadFailureMessage?: string;
  collectSyncedAttachments?: () => Promise<StagedAttachmentRef[]>;
}): Promise<ComposerAttachment[]> {
  const collectedAttachments = [...currentAttachments];
  const showUploadStatus =
    !!pendingMessageId && pendingUploads.length > 0 && !!uploadingStatus;

  if (showUploadStatus && pendingMessageId) {
    updatePendingMessage?.(pendingMessageId, { status: uploadingStatus });
  }

  try {
    if (collectSyncedAttachments) {
      const refs = await collectSyncedAttachments();
      const collectedIds = new Set(collectedAttachments.map((a) => a.id));
      for (const ref of refs) {
        if (!collectedIds.has(ref.id)) {
          collectedAttachments.push(ref);
          collectedIds.add(ref.id);
        }
      }
    }
    const removeCollected = () => {
      if (!detach) return;
      const sentIds = new Set(collectedAttachments.map((a) => a.id));
      setComposerAttachments(
        (prev) => prev.filter((attachment) => !sentIds.has(attachment.id)),
        { persistDraft: false },
      );
    };
    removeCollected();
    if (pendingUploads.length > 0) {
      const results = await Promise.all(pendingUploads);
      for (const result of results) {
        if (result) collectedAttachments.push(result);
      }
      if (results.some((result) => result === null)) {
        throw new ComposerAttachmentUploadError(
          collectedAttachments,
          uploadFailureMessage,
        );
      }

      removeCollected();
    }
  } finally {
    if (showUploadStatus && pendingMessageId) {
      updatePendingMessage?.(pendingMessageId, { status: undefined });
    }
  }

  return collectedAttachments;
}

export async function uploadComposerAttachmentFile({
  file,
  sourceTransport,
  projectId,
  sessionId,
  imageProfile,
  stagedBatchId,
  onProgress,
}: {
  file: File;
  sourceTransport: Pick<SourceTransport, "upload" | "uploadStagedAttachment">;
  projectId: string;
  sessionId: string;
  imageProfile: ImagePreparationProfile;
  stagedBatchId?: string | null;
  onProgress?: (bytesUploaded: number, uploadFile: File) => void;
}): Promise<ComposerAttachment> {
  // The progress wrapper is always passed, as before, even with no
  // caller callback.
  const { uploadFile, uploadOptions } = await prepareComposerAttachmentUpload(
    file,
    imageProfile,
    (bytesUploaded, preparedFile) => {
      onProgress?.(bytesUploaded, preparedFile);
    },
  );

  const previewUrl = uploadFile.type.startsWith("image/")
    ? URL.createObjectURL(uploadFile)
    : undefined;

  try {
    if (stagedBatchId) {
      const stagedRef = await sourceTransport.uploadStagedAttachment(
        uploadFile,
        {
          batchId: stagedBatchId,
          ...uploadOptions,
        },
      );
      return {
        ...stagedRef,
        ...(previewUrl ? { previewUrl } : {}),
      } satisfies ComposerStagedAttachment;
    }

    const uploaded = await sourceTransport.upload(
      projectId,
      sessionId,
      uploadFile,
      uploadOptions,
    );
    return {
      ...uploaded,
      ...(previewUrl ? { previewUrl } : {}),
    };
  } catch (err) {
    if (previewUrl) {
      URL.revokeObjectURL(previewUrl);
    }
    throw err;
  }
}
