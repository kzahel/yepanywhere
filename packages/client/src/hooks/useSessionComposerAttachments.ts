import {
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  SERVER_CAPABILITIES,
  serverHasCapability,
  type UploadedFile,
} from "@yep-anywhere/shared";
import type { UploadProgress } from "../components/MessageInput";
import type { useCurrentSourceRuntime } from "../contexts/SourceRuntimeContext";
import { useToastContext } from "../contexts/ToastContext";
import { useI18n } from "../i18n";
import {
  isInterruptedDraftAttachmentValidation,
  validateDraftAttachmentRefs,
} from "../lib/draftAttachmentStaging";
import { DRAFT_STORAGE_EVENT } from "../lib/draftSyncStorage";
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
import type { useVersion } from "./useVersion";

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
  projectId,
  sessionId,
  sourceTransport,
}: {
  composerEditAvailabilityStore: ComposerEditAvailabilityStore;
  draftControlsRef: RefObject<DraftControls | null>;
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

/**
 * Fills one session page's composer attachments from its saved draft: when
 * the draft controls are ready, when the draft key changes and when another
 * tab changes the draft. Staged files are checked with the server first.
 * Moved verbatim from `SessionPage.tsx`
 * (docs/tactical/187-session-page-draft-hooks.md slice 3).
 */
export function useDraftAttachmentHydration({
  attachmentsRef,
  draftAttachmentBatchIdRef,
  draftAttachmentHydrationRef,
  draftControlsRef,
  mainComposerForAside,
  sessionDraftKey,
  setComposerAttachments,
  sourceTransport,
  versionInfo,
}: {
  attachmentsRef: RefObject<ComposerAttachment[]>;
  draftAttachmentBatchIdRef: RefObject<string | null>;
  draftAttachmentHydrationRef: RefObject<number>;
  draftControlsRef: RefObject<DraftControls | null>;
  mainComposerForAside: boolean;
  sessionDraftKey: string;
  setComposerAttachments: ReturnType<
    typeof useSessionComposerAttachments
  >["setComposerAttachments"];
  sourceTransport: ReturnType<typeof useCurrentSourceRuntime>["transport"];
  versionInfo: ReturnType<typeof useVersion>["version"];
}) {
  const { t } = useI18n();
  const { showToast } = useToastContext();
  const hydrateDraftAttachments = useCallback(
    async (controls = draftControlsRef.current) => {
      if (mainComposerForAside || !controls) {
        return;
      }

      const state = controls.getAttachmentState();
      if (!state) {
        setComposerAttachments([], {
          persistDraft: false,
          revokeRemovedPreviewUrls: true,
        });
        return;
      }

      const syncEnabled = serverHasCapability(
        versionInfo,
        SERVER_CAPABILITIES.draftSync.name,
      );
      if (syncEnabled)
        setComposerAttachments(state.refs, {
          persistDraft: false,
          revokeRemovedPreviewUrls: true,
        });
      const hydrationId = draftAttachmentHydrationRef.current + 1;
      draftAttachmentHydrationRef.current = hydrationId;

      try {
        const refs = await validateDraftAttachmentRefs(sourceTransport, state);
        if (
          draftAttachmentHydrationRef.current !== hydrationId ||
          JSON.stringify(controls.getAttachmentState()?.refs) !==
            JSON.stringify(state.refs)
        ) {
          return;
        }
        if (syncEnabled && refs.length !== state.refs.length) {
          showToast(t("sessionDraftAttachmentsUnavailable"), "info");
          return;
        }
        const nextState = createComposerDraftAttachmentState(refs);
        draftAttachmentBatchIdRef.current = nextState?.batchId ?? null;
        controls.setAttachmentState(nextState);
        setComposerAttachments(refs, {
          persistDraft: false,
          revokeRemovedPreviewUrls: true,
        });
      } catch (err) {
        if (
          draftAttachmentHydrationRef.current !== hydrationId ||
          JSON.stringify(controls.getAttachmentState()?.refs) !==
            JSON.stringify(state.refs)
        ) {
          return;
        }
        // An interrupted validation says nothing about whether the file exists.
        // Keep its chip too; sending still requires server materialization.
        setComposerAttachments(state.refs, {
          persistDraft: false,
          revokeRemovedPreviewUrls: true,
        });
        if (!isInterruptedDraftAttachmentValidation(err))
          showToast(t("sessionDraftAttachmentsValidationFailed"), "info");
      }
    },
    [
      sourceTransport,
      mainComposerForAside,
      setComposerAttachments,
      showToast,
      versionInfo,
      t,
      draftControlsRef,
      draftAttachmentHydrationRef,
      draftAttachmentBatchIdRef,
    ],
  );

  useEffect(() => {
    void sessionDraftKey;
    void hydrateDraftAttachments();
  }, [hydrateDraftAttachments, sessionDraftKey]);
  useEffect(() => {
    const changed = (event: Event) => {
      if (
        (event as CustomEvent<{ key: string }>).detail.key === sessionDraftKey
      ) {
        const current =
          draftControlsRef.current?.getAttachmentState()?.refs ?? [];
        const shown = attachmentsRef.current
          .filter(isComposerStagedAttachment)
          .map(toPersistedStagedAttachmentRef);
        if (JSON.stringify(current) === JSON.stringify(shown)) return;
        void hydrateDraftAttachments();
      }
    };
    window.addEventListener(DRAFT_STORAGE_EVENT, changed);
    return () => window.removeEventListener(DRAFT_STORAGE_EVENT, changed);
  }, [
    hydrateDraftAttachments,
    sessionDraftKey,
    draftControlsRef,
    attachmentsRef,
  ]);

  return hydrateDraftAttachments;
}
