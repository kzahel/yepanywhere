import {
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import type { UploadedFile } from "@yep-anywhere/shared";
import type { UploadProgress } from "../components/MessageInput";
import type { useCurrentSourceRuntime } from "../contexts/SourceRuntimeContext";
import {
  hasAttachmentNavigationRisk,
  useAttachmentNavigationGuard,
} from "../lib/attachmentNavigationGuard";
import type { ComposerEditAvailabilityStore } from "../lib/composerDraftSignal";
import {
  type ComposerAttachment,
  isComposerStagedAttachment,
  revokeAttachmentPreviewUrls,
  toPersistedStagedAttachmentRef,
} from "../lib/sessionComposerAttachments";
import {
  createComposerDraftAttachmentState,
  materializeComposerAttachmentsForSubmission,
} from "../lib/sessionComposerSubmission";
import { generateUUID } from "../lib/uuid";
import type { DraftControls } from "./useDraftPersistence";

/**
 * One session page's composer attachments: the attachment list and its
 * ref, upload progress, the in-flight uploads, the staged-draft batch id,
 * the edit blocker and navigation guard they raise, writing the list into
 * the saved draft, and materializing it for a send. Moved verbatim from
 * `SessionPage.tsx` (docs/tactical/187-session-page-draft-hooks.md
 * slice 1).
 */
export function useSessionComposerAttachments({
  composerEditAvailabilityStore,
  draftControlsRef,
  preCorrectionDraftRef,
  projectId,
  sessionId,
  sourceTransport,
}: {
  composerEditAvailabilityStore: ComposerEditAvailabilityStore;
  draftControlsRef: RefObject<DraftControls | null>;
  preCorrectionDraftRef: RefObject<{
    text: string;
    attachments: ComposerAttachment[];
  } | null>;
  projectId: string;
  sessionId: string;
  sourceTransport: ReturnType<typeof useCurrentSourceRuntime>["transport"];
}) {
  // File attachment state
  const [attachments, setAttachmentsState] = useState<ComposerAttachment[]>([]);
  const attachmentsRef = useRef<ComposerAttachment[]>([]);
  const draftAttachmentBatchIdRef = useRef<string | null>(null);
  const draftAttachmentHydrationRef = useRef(0);
  const [uploadProgress, setUploadProgress] = useState<UploadProgress[]>([]);
  useEffect(() => {
    composerEditAvailabilityStore.setExternalBlockers(
      attachments.length > 0,
      uploadProgress.length > 0,
    );
  }, [
    attachments.length,
    composerEditAvailabilityStore,
    uploadProgress.length,
  ]);
  // Track in-flight upload promises so handleSend can wait for them
  const pendingUploadsRef = useRef<
    Map<string, Promise<ComposerAttachment | null>>
  >(new Map());

  const stagedComposerAttachmentRefs = attachments
    .filter(isComposerStagedAttachment)
    .map(toPersistedStagedAttachmentRef);
  const attachmentNavigationGuardActive = hasAttachmentNavigationRisk({
    pendingUploadCount: uploadProgress.length,
    transientAttachmentCount: 0,
    stagedRefs: stagedComposerAttachmentRefs,
    draftState: draftControlsRef.current?.getAttachmentState() ?? null,
  });
  useAttachmentNavigationGuard(attachmentNavigationGuardActive);

  const writeDraftAttachmentState = useCallback(
    (nextAttachments: readonly ComposerAttachment[]) => {
      const draftState = createComposerDraftAttachmentState(nextAttachments);
      if (!draftState) {
        draftAttachmentBatchIdRef.current = null;
        draftControlsRef.current?.setAttachmentState(null);
        return;
      }

      draftAttachmentBatchIdRef.current = draftState.batchId;
      draftControlsRef.current?.setAttachmentState(draftState);
    },
    [draftControlsRef],
  );

  const setComposerAttachments = useCallback(
    (
      updater:
        | ComposerAttachment[]
        | ((previous: readonly ComposerAttachment[]) => ComposerAttachment[]),
      options?: {
        persistDraft?: boolean;
        revokeRemovedPreviewUrls?: boolean;
      },
    ) => {
      const previous = attachmentsRef.current;
      const next = typeof updater === "function" ? updater(previous) : updater;

      if (options?.revokeRemovedPreviewUrls) {
        const nextIds = new Set(next.map((attachment) => attachment.id));
        revokeAttachmentPreviewUrls(
          previous.filter((attachment) => !nextIds.has(attachment.id)),
        );
      }

      attachmentsRef.current = next;
      setAttachmentsState(next);
      if (options?.persistDraft !== false) {
        writeDraftAttachmentState(next);
      }
    },
    [writeDraftAttachmentState],
  );

  useEffect(() => {
    return () => {
      revokeAttachmentPreviewUrls(attachmentsRef.current);
      revokeAttachmentPreviewUrls(
        preCorrectionDraftRef.current?.attachments ?? [],
      );
    };
  }, [preCorrectionDraftRef]);

  const ensureDraftAttachmentBatchId = useCallback(() => {
    const existing =
      draftControlsRef.current?.getAttachmentState()?.batchId ??
      draftAttachmentBatchIdRef.current;
    if (existing) {
      draftAttachmentBatchIdRef.current = existing;
      return existing;
    }
    const batchId = generateUUID();
    draftAttachmentBatchIdRef.current = batchId;
    return batchId;
  }, [draftControlsRef]);

  const materializeComposerAttachments = useCallback(
    async (
      composerAttachments: readonly ComposerAttachment[],
    ): Promise<UploadedFile[]> => {
      return materializeComposerAttachmentsForSubmission({
        attachments: composerAttachments,
        sourceTransport,
        projectId,
        sessionId,
      });
    },
    [sourceTransport, projectId, sessionId],
  );

  return {
    attachments,
    attachmentsRef,
    draftAttachmentBatchIdRef,
    draftAttachmentHydrationRef,
    uploadProgress,
    setUploadProgress,
    pendingUploadsRef,
    setComposerAttachments,
    ensureDraftAttachmentBatchId,
    materializeComposerAttachments,
  };
}
