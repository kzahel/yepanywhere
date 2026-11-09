import {
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  type ImagePreparationProfile,
  SERVER_CAPABILITIES,
  serverHasCapability,
} from "@yep-anywhere/shared";
import type { UploadProgress } from "../components/MessageInput";
import type { useCurrentSourceRuntime } from "../contexts/SourceRuntimeContext";
import { useOptionalToastContext } from "../contexts/ToastContext";
import { useI18n } from "../i18n";
import { makeAttachmentFileNamesUnique } from "../lib/attachmentFileNames";
import {
  hasAttachmentNavigationRisk,
  useAttachmentNavigationGuard,
} from "../lib/attachmentNavigationGuard";
import { storeUploadedAttachmentPreview } from "../lib/attachmentPreviewCache";
import {
  type ComposerUploadOrigin,
  rememberComposerUpload,
} from "../lib/composerHistory";
import {
  deleteDraftAttachmentRef,
  isInterruptedDraftAttachmentValidation,
  validateDraftAttachmentRefs,
} from "../lib/draftAttachmentStaging";
import { DRAFT_STORAGE_EVENT } from "../lib/draftSyncStorage";
import {
  type ComposerAttachment,
  type ComposerStagedAttachment,
  isComposerStagedAttachment,
  revokeAttachmentPreviewUrls,
  toPersistedStagedAttachmentRef,
} from "../lib/sessionComposerAttachments";
import {
  createComposerDraftAttachmentState,
  uploadStagedComposerAttachment,
} from "../lib/sessionComposerSubmission";
import { generateUUID } from "../lib/uuid";
import type { DraftControls } from "./useDraftPersistence";
import type { useVersion } from "./useVersion";

/** An upload in flight, with the type a typed chip draws. */
export type ComposerUploadProgress = UploadProgress & { mimeType: string };

/** What one upload call needs from the screen that starts it. */
export interface ComposerUploadSettings {
  imageProfile: ImagePreparationProfile;
  /** Where composer history records the picked file; null records nothing. */
  history: { scope: string; origin: ComposerUploadOrigin } | null;
}

export type SetComposerAttachments = (
  updater:
    | readonly ComposerAttachment[]
    | ((
        previous: readonly ComposerAttachment[],
      ) => readonly ComposerAttachment[]),
  options?: {
    persistDraft?: boolean;
    revokeRemovedPreviewUrls?: boolean;
  },
) => void;

const ownsEveryStagedAttachment = () => true;
const ignoreToast = () => {};

/**
 * One composer's attachments, shared by the session page, New Session and
 * the Project Queue editor (docs/tactical/188-shared-composer-draft-attachments.md):
 * the finished attachments and the uploads in flight, the staging batch,
 * writing the staged refs into the saved draft and filling them back from
 * it (also when a sibling tab changes it), uploading, cancelling and
 * removing, revoking previews, and the navigation guard.
 *
 * A screen without a saved draft (the Project Queue editor) passes a null
 * `draftKey` and a ref holding null; its own staged files are those
 * `ownsStagedAttachment` accepts, and only those are deleted on remove.
 */
export function useComposerDraftAttachments({
  draftControlsRef,
  draftKey,
  hydrationEnabled,
  initialAttachments,
  ownsStagedAttachment = ownsEveryStagedAttachment,
  sourceTransport,
  versionInfo,
  versionFailed,
  onUploadError,
  onDeleteError,
}: {
  draftControlsRef: RefObject<DraftControls | null>;
  draftKey: string | null;
  hydrationEnabled: boolean;
  initialAttachments?: readonly ComposerAttachment[];
  ownsStagedAttachment?: (attachment: ComposerStagedAttachment) => boolean;
  sourceTransport: ReturnType<typeof useCurrentSourceRuntime>["transport"];
  versionInfo: ReturnType<typeof useVersion>["version"];
  /** The version failed to load; hydration then uses the draft-sync rule. */
  versionFailed: boolean;
  /** Reports a failed upload; the default is the upload failure toast. */
  onUploadError?: (file: File, error: unknown) => void;
  /** Reports a failed staging delete; the default logs it. */
  onDeleteError?: (error: unknown) => void;
}) {
  const { t } = useI18n();
  // The Project Queue editor reports its own errors and may render outside
  // a toast provider.
  const showToast = useOptionalToastContext()?.showToast ?? ignoreToast;

  const [attachments, setAttachmentsState] = useState<ComposerAttachment[]>(
    () => [...(initialAttachments ?? [])],
  );
  const attachmentsRef = useRef<ComposerAttachment[]>(attachments);
  const draftAttachmentBatchIdRef = useRef<string | null>(
    initialAttachments?.find(isComposerStagedAttachment)?.batchId ?? null,
  );
  const draftAttachmentHydrationRef = useRef(0);
  const [uploadProgress, setUploadProgress] = useState<
    ComposerUploadProgress[]
  >([]);
  const uploadProgressRef = useRef<ComposerUploadProgress[]>([]);
  // Each in-flight upload's promise, so a send can wait for it.
  const pendingUploadsRef = useRef<
    Map<string, Promise<ComposerAttachment | null>>
  >(new Map());
  const cancelledUploadIdsRef = useRef(new Set<string>());
  const mountedRef = useRef(true);

  // Read by callbacks that must not be rebuilt when these change.
  const latest = useRef({
    draftKey,
    hydrationEnabled,
    ownsStagedAttachment,
    sourceTransport,
    onUploadError,
    onDeleteError,
    showToast,
    t,
  });
  latest.current = {
    draftKey,
    hydrationEnabled,
    ownsStagedAttachment,
    sourceTransport,
    onUploadError,
    onDeleteError,
    showToast,
    t,
  };
  // Which rule hydration follows. The check waits for the version: the
  // local rule drops a missing file quietly, which is wrong under draft
  // sync. A version that failed to load gets the draft-sync rule, which
  // never does.
  const hydrationRule: "unknown" | "draft-sync" | "local" = versionInfo
    ? serverHasCapability(versionInfo, SERVER_CAPABILITIES.draftSync.name)
      ? "draft-sync"
      : "local"
    : versionFailed
      ? "draft-sync"
      : "unknown";
  const hydrationRuleRef = useRef(hydrationRule);
  hydrationRuleRef.current = hydrationRule;

  const setUploads = useCallback(
    (
      update: (previous: ComposerUploadProgress[]) => ComposerUploadProgress[],
    ) => {
      uploadProgressRef.current = update(uploadProgressRef.current);
      setUploadProgress(uploadProgressRef.current);
    },
    [],
  );

  const writeDraftAttachmentState = useCallback(
    (nextAttachments: readonly ComposerAttachment[]) => {
      const draftState = createComposerDraftAttachmentState(nextAttachments);
      if (!draftState) {
        // Uploads in flight keep the batch, so they and later ones share it.
        if (pendingUploadsRef.current.size === 0)
          draftAttachmentBatchIdRef.current = null;
        draftControlsRef.current?.setAttachmentState(null);
        return;
      }

      draftAttachmentBatchIdRef.current = draftState.batchId;
      draftControlsRef.current?.setAttachmentState(draftState);
    },
    [draftControlsRef],
  );

  const setComposerAttachments = useCallback<SetComposerAttachments>(
    (updater, options) => {
      const previous = attachmentsRef.current;
      const nextValue =
        typeof updater === "function" ? updater(previous) : updater;
      if (nextValue === previous) return;
      const next = [...nextValue];

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
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      revokeAttachmentPreviewUrls(attachmentsRef.current);
    };
  }, []);

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

  const deleteStagedAttachment = useCallback(
    (attachment: ComposerStagedAttachment) => {
      deleteDraftAttachmentRef(
        latest.current.sourceTransport,
        attachment.batchId,
        attachment.id,
      ).catch((err) => {
        const report = latest.current.onDeleteError;
        if (report && mountedRef.current) report(err);
        else
          console.warn("[composer] Failed to delete staged attachment:", err);
      });
    },
    [],
  );

  const uploadFiles = useCallback(
    (
      files: readonly File[],
      { imageProfile, history }: ComposerUploadSettings,
    ): Promise<(ComposerAttachment | null)[]> => {
      // A screen without a saved draft cannot keep what finishes after it
      // closed, so that is deleted; a saved draft outlives the screen.
      const keepsLateUploads = () =>
        mountedRef.current || latest.current.draftKey !== null;
      const uniqueFiles = makeAttachmentFileNamesUnique(files, [
        ...attachmentsRef.current.map((attachment) => attachment.originalName),
        ...uploadProgressRef.current.map((upload) => upload.fileName),
      ]);
      if (uniqueFiles.length === 0) return Promise.resolve([]);
      const batchId = ensureDraftAttachmentBatchId();
      return Promise.all(
        uniqueFiles.map((file) => {
          const uploadId = generateUUID();
          setUploads((previous) => [
            ...previous,
            {
              fileId: uploadId,
              fileName: file.name,
              mimeType: file.type || "application/octet-stream",
              bytesUploaded: 0,
              totalBytes: file.size,
              percent: 0,
            },
          ]);
          const upload = uploadStagedComposerAttachment({
            file,
            sourceTransport: latest.current.sourceTransport,
            imageProfile,
            batchId,
            onProgress: (bytesUploaded, uploadFile) => {
              const percent =
                uploadFile.size > 0
                  ? Math.round((bytesUploaded / uploadFile.size) * 100)
                  : 100;
              setUploads((previous) =>
                previous.map((progress) =>
                  progress.fileId === uploadId
                    ? { ...progress, bytesUploaded, percent }
                    : progress,
                ),
              );
            },
          })
            .then(
              ({ attachment, uploadFile }) => {
                if (
                  cancelledUploadIdsRef.current.delete(uploadId) ||
                  !keepsLateUploads()
                ) {
                  revokeAttachmentPreviewUrls([attachment]);
                  deleteStagedAttachment(attachment);
                  return null;
                }
                const { showToast, t } = latest.current;
                if (history)
                  void rememberComposerUpload(
                    history.scope,
                    file,
                    history.origin,
                  ).catch((cause) =>
                    showToast(
                      t("composerHistorySaveError", { error: String(cause) }),
                      "error",
                    ),
                  );
                if (attachment.mimeType.startsWith("image/")) {
                  void storeUploadedAttachmentPreview(
                    {
                      id: attachment.id,
                      originalName: attachment.originalName,
                      name: attachment.name,
                      path: attachment.id,
                      size: attachment.size,
                      mimeType: attachment.mimeType,
                      ...(attachment.width !== undefined
                        ? { width: attachment.width }
                        : {}),
                      ...(attachment.height !== undefined
                        ? { height: attachment.height }
                        : {}),
                    },
                    uploadFile,
                  ).catch((err) => {
                    console.warn(
                      "[composer] Failed to cache attachment preview:",
                      err,
                    );
                  });
                }
                // After the screen closed, nothing will revoke a preview.
                let kept: ComposerStagedAttachment = attachment;
                if (!mountedRef.current) {
                  revokeAttachmentPreviewUrls([attachment]);
                  const { previewUrl: _previewUrl, ...ref } = attachment;
                  kept = ref;
                }
                setComposerAttachments((previous) => [...previous, kept]);
                return kept;
              },
              (err) => {
                if (
                  cancelledUploadIdsRef.current.delete(uploadId) ||
                  !keepsLateUploads()
                )
                  return null;
                console.error("Upload failed:", err);
                const report = latest.current.onUploadError;
                if (report) report(file, err);
                else {
                  const { showToast, t } = latest.current;
                  showToast(
                    t("sessionUploadFailed", {
                      file: file.name,
                      message:
                        err instanceof Error
                          ? err.message
                          : t("sessionShareFailed"),
                    }),
                    "error",
                  );
                }
                return null;
              },
            )
            .finally(() => {
              setUploads((previous) =>
                previous.filter((progress) => progress.fileId !== uploadId),
              );
              pendingUploadsRef.current.delete(uploadId);
            });
          pendingUploadsRef.current.set(uploadId, upload);
          return upload;
        }),
      );
    },
    [
      deleteStagedAttachment,
      ensureDraftAttachmentBatchId,
      setComposerAttachments,
      setUploads,
    ],
  );

  /** Drop an upload in flight; its result is deleted when it arrives. */
  const cancelUpload = useCallback(
    (uploadId: string) => {
      cancelledUploadIdsRef.current.add(uploadId);
      pendingUploadsRef.current.delete(uploadId);
      setUploads((previous) =>
        previous.filter((progress) => progress.fileId !== uploadId),
      );
    },
    [setUploads],
  );

  const removeAttachment = useCallback(
    (id: string) => {
      const removed = attachmentsRef.current.find(
        (attachment) => attachment.id === id,
      );
      setComposerAttachments(
        (previous) => previous.filter((attachment) => attachment.id !== id),
        { revokeRemovedPreviewUrls: true },
      );
      if (
        removed &&
        isComposerStagedAttachment(removed) &&
        latest.current.ownsStagedAttachment(removed)
      )
        deleteStagedAttachment(removed);
    },
    [deleteStagedAttachment, setComposerAttachments],
  );

  const ownedStagedRefs = attachments
    .filter(isComposerStagedAttachment)
    .filter((attachment) => ownsStagedAttachment(attachment))
    .map(toPersistedStagedAttachmentRef);
  useAttachmentNavigationGuard(
    hasAttachmentNavigationRisk({
      pendingUploadCount: uploadProgress.length,
      stagedRefs: ownedStagedRefs,
      draftState: draftControlsRef.current?.getAttachmentState() ?? null,
    }),
  );

  const hydrateDraftAttachments = useCallback(
    async (controls = draftControlsRef.current) => {
      if (!latest.current.hydrationEnabled || !controls) return;

      // The saved draft holds only staged files, so only staged chips are
      // replaced; a shown chip keeps its preview.
      const showStaged = (refs: readonly ComposerStagedAttachment[]) =>
        setComposerAttachments(
          (previous) => {
            if (refs.length === 0 && !previous.some(isComposerStagedAttachment))
              return previous;
            const shown = new Map(
              previous.map((attachment) => [attachment.id, attachment]),
            );
            return [
              ...previous.filter(
                (attachment) => !isComposerStagedAttachment(attachment),
              ),
              ...refs.map((ref) => {
                const previewUrl = shown.get(ref.id)?.previewUrl;
                return previewUrl ? { ...ref, previewUrl } : ref;
              }),
            ];
          },
          { persistDraft: false, revokeRemovedPreviewUrls: true },
        );

      const state = controls.getAttachmentState();
      if (!state) {
        showStaged([]);
        return;
      }
      // Until the rule is known, show the saved files unchecked, so a
      // write in the meantime keeps them in the saved draft; the check
      // runs once the rule is known.
      const rule = hydrationRuleRef.current;
      if (rule === "unknown") {
        showStaged(state.refs);
        return;
      }

      const syncRule = rule === "draft-sync";
      if (syncRule) showStaged(state.refs);
      const hydrationId = draftAttachmentHydrationRef.current + 1;
      draftAttachmentHydrationRef.current = hydrationId;
      const superseded = () =>
        draftAttachmentHydrationRef.current !== hydrationId ||
        JSON.stringify(controls.getAttachmentState()?.refs) !==
          JSON.stringify(state.refs);
      const { showToast, t } = latest.current;

      try {
        const refs = await validateDraftAttachmentRefs(
          latest.current.sourceTransport,
          state,
        );
        if (superseded()) return;
        if (syncRule && refs.length !== state.refs.length) {
          showToast(t("sessionDraftAttachmentsUnavailable"), "info");
          return;
        }
        const nextState = createComposerDraftAttachmentState(refs);
        if (nextState) draftAttachmentBatchIdRef.current = nextState.batchId;
        else if (pendingUploadsRef.current.size === 0)
          draftAttachmentBatchIdRef.current = null;
        controls.setAttachmentState(nextState);
        showStaged(refs);
      } catch (err) {
        if (superseded()) return;
        // An interrupted validation says nothing about whether the file
        // exists. Keep its chip too; sending still requires server
        // materialization.
        showStaged(state.refs);
        if (!isInterruptedDraftAttachmentValidation(err))
          showToast(t("sessionDraftAttachmentsValidationFailed"), "info");
      }
    },
    [draftControlsRef, setComposerAttachments],
  );

  // Uploads started for one draft must not land in another.
  const uploadDraftKeyRef = useRef(draftKey);
  useEffect(() => {
    if (uploadDraftKeyRef.current === draftKey) return;
    uploadDraftKeyRef.current = draftKey;
    for (const uploadId of [...pendingUploadsRef.current.keys()])
      cancelUpload(uploadId);
  }, [draftKey, cancelUpload]);
  // Hydrate when the draft or its rule changes, not when a callback that
  // reads them is rebuilt; draft controls that arrive later hydrate through
  // the caller.
  useEffect(() => {
    void draftKey;
    void hydrationRule;
    void hydrationEnabled;
    void hydrateDraftAttachments();
  }, [draftKey, hydrationRule, hydrationEnabled, hydrateDraftAttachments]);
  useEffect(() => {
    if (draftKey === null) return;
    const changed = (event: Event) => {
      if ((event as CustomEvent<{ key: string }>).detail.key !== draftKey)
        return;
      const current =
        draftControlsRef.current?.getAttachmentState()?.refs ?? [];
      const shown = attachmentsRef.current
        .filter(isComposerStagedAttachment)
        .map(toPersistedStagedAttachmentRef);
      if (JSON.stringify(current) === JSON.stringify(shown)) return;
      void hydrateDraftAttachments();
    };
    window.addEventListener(DRAFT_STORAGE_EVENT, changed);
    return () => window.removeEventListener(DRAFT_STORAGE_EVENT, changed);
  }, [draftKey, draftControlsRef, hydrateDraftAttachments]);

  return {
    attachments,
    attachmentsRef,
    uploadProgress,
    pendingUploadsRef,
    setComposerAttachments,
    ensureDraftAttachmentBatchId,
    uploadFiles,
    cancelUpload,
    removeAttachment,
    hydrateDraftAttachments,
  };
}
