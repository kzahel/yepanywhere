import type { PermissionMode } from "@yep-anywhere/shared";
import {
  type Dispatch,
  type RefObject,
  type SetStateAction,
  useCallback,
} from "react";
import { api } from "../api/client";
import { useToastContext } from "../contexts/ToastContext";
import { useI18n } from "../i18n";
import {
  getRecallSubmissionAfterQueuedCancel,
  type LastComposerSubmission,
  type SentComposerSubmission,
} from "../lib/composerRecall";
import { embeddedFrameHoldsFocus } from "../lib/programmaticFocus";
import type { ComposerAttachment } from "../lib/sessionComposerAttachments";
import { appendComposerTransferDraft } from "../lib/sessionComposerSubmission";
import type { DraftControls } from "./useDraftPersistence";
import type { useProjectQueues } from "./useProjectQueues";
import type { useSession } from "./useSession";

type SessionState = ReturnType<typeof useSession>;
type ProjectQueuesState = ReturnType<typeof useProjectQueues>;

function isMissingDeferredQueueEntryError(error: unknown): boolean {
  if ((error as { status?: number } | null)?.status === 404) {
    return true;
  }
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("No active process") ||
    message.includes("Deferred message not found")
  );
}

/**
 * One session page's actions on queued messages: the session's own deferred
 * messages (cancel, edit, steer, send without compacting), recovered queued
 * messages after a restart (delete, resume, steer), the Project Queue items
 * shown in this session (cancel, edit, steer), resuming Project Queue
 * dispatch, and cancelling an unconfirmed steer. Edit returns a message to
 * the composer. Moved verbatim from `SessionPage.tsx`
 * (docs/tactical/181-session-page-feature-hooks.md slice 2).
 */
export function useSessionQueuedMessageActions({
  projectId,
  sessionId,
  projectQueues,
  projectQueueItemsForProject,
  deferredMessages,
  setDeferredMessages,
  setStatus,
  setProcessState,
  setPermissionMode,
  removeUnconfirmedSelfSend,
  draftControlsRef,
  attachmentsRef,
  pendingUploadsRef,
  lastComposerSubmissionRef,
  lastSentComposerSubmissionRef,
  setComposerAttachments,
  setCorrectionDraft,
}: {
  projectId: string;
  sessionId: string;
  projectQueues: ProjectQueuesState;
  projectQueueItemsForProject: ProjectQueuesState["queuesByProject"][string];
  deferredMessages: SessionState["deferredMessages"];
  setDeferredMessages: SessionState["setDeferredMessages"];
  setStatus: SessionState["setStatus"];
  setProcessState: SessionState["setProcessState"];
  setPermissionMode: SessionState["setPermissionMode"];
  removeUnconfirmedSelfSend: SessionState["removeUnconfirmedSelfSend"];
  draftControlsRef: RefObject<DraftControls | null>;
  attachmentsRef: RefObject<ComposerAttachment[]>;
  pendingUploadsRef: RefObject<Map<string, Promise<ComposerAttachment | null>>>;
  lastComposerSubmissionRef: RefObject<LastComposerSubmission | null>;
  lastSentComposerSubmissionRef: RefObject<SentComposerSubmission | null>;
  setComposerAttachments: (
    updater:
      | ComposerAttachment[]
      | ((previous: readonly ComposerAttachment[]) => ComposerAttachment[]),
    options?: {
      persistDraft?: boolean;
      revokeRemovedPreviewUrls?: boolean;
    },
  ) => void;
  setCorrectionDraft: Dispatch<
    SetStateAction<{
      messageId: string;
      originalText: string;
      recalled?: boolean;
    } | null>
  >;
}) {
  const { t } = useI18n();
  const { showToast } = useToastContext();

  const handleResumeProjectQueueDispatch = useCallback(async () => {
    try {
      await projectQueues.resumeDispatch();
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      showToast(t("projectQueueResumeFailed", { message: errorMsg }), "error");
    }
  }, [projectQueues.resumeDispatch, showToast, t]);

  const handleCancelProjectQueueItem = useCallback(
    async (itemId: string) => {
      try {
        await projectQueues.deleteItem(projectId, itemId);
      } catch (err) {
        console.error("Failed to cancel Project Queue item:", err);
        const errorMsg = err instanceof Error ? err.message : String(err);
        showToast(
          t("projectQueueInlineCancelFailed", { message: errorMsg }),
          "error",
        );
      }
    },
    [projectId, projectQueues.deleteItem, showToast, t],
  );

  const restoreQueuedMessageToComposer = useCallback(
    (
      content: string,
      queuedAttachments: readonly ComposerAttachment[] = [],
      mode?: PermissionMode,
    ) => {
      const controls = draftControlsRef.current;
      if (!controls) {
        return;
      }
      const currentDraft = controls.getDraft();
      controls.setDraft(
        currentDraft.trim()
          ? appendComposerTransferDraft(currentDraft, content)
          : content,
      );
      if (queuedAttachments.length > 0) {
        setComposerAttachments((current) => [...current, ...queuedAttachments]);
      }
      if (mode) {
        setPermissionMode(mode);
      }
      setCorrectionDraft(null);
      // Restoring follows an awaited cancel, so the user may be in the app.
      requestAnimationFrame(() => {
        if (!embeddedFrameHoldsFocus()) controls.focus?.();
      });
    },
    [
      draftControlsRef,
      setCorrectionDraft,
      setComposerAttachments,
      setPermissionMode,
    ],
  );

  const handleEditProjectQueueItem = useCallback(
    async (itemId: string) => {
      const controls = draftControlsRef.current;
      const item = projectQueueItemsForProject.find(
        (candidate) => candidate.id === itemId,
      );
      if (
        !controls ||
        controls.getDraft().trim() ||
        attachmentsRef.current.length > 0 ||
        pendingUploadsRef.current.size > 0 ||
        !item ||
        item.message.stagedAttachments
      ) {
        return;
      }

      try {
        await projectQueues.deleteItem(projectId, itemId);
        restoreQueuedMessageToComposer(
          item.message.text,
          item.message.attachments,
          item.message.mode ?? item.target.mode,
        );
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        showToast(
          t("projectQueueInlineEditFailed", { message: errorMsg }),
          "error",
        );
      }
    },
    [
      draftControlsRef,
      attachmentsRef,
      pendingUploadsRef,
      projectId,
      projectQueueItemsForProject,
      projectQueues.deleteItem,
      restoreQueuedMessageToComposer,
      showToast,
      t,
    ],
  );

  const handleSteerProjectQueueItem = useCallback(
    async (itemId: string) => {
      try {
        const result = await projectQueues.promoteNow(projectId, itemId, {
          force: true,
          deliveryIntent: "steer",
        });
        if (!result.promoted) {
          throw new Error(result.error ?? result.reason);
        }
        showToast(t("projectQueueInlineSteered"), "success");
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        showToast(
          t("projectQueueInlineSteerFailed", { message: errorMsg }),
          "error",
        );
      }
    },
    [projectId, projectQueues.promoteNow, showToast, t],
  );

  const handleCancelDeferred = useCallback(
    async (tempId: string) => {
      // No optimistic removal: the chip disappears when the server's next
      // deferred-queue state (which omits this tempId) is mirrored.
      const previousLastSubmission = lastComposerSubmissionRef.current;
      lastComposerSubmissionRef.current = getRecallSubmissionAfterQueuedCancel(
        lastComposerSubmissionRef.current,
        lastSentComposerSubmissionRef.current,
        deferredMessages,
        tempId,
      );
      try {
        await api.cancelDeferredMessage(sessionId, tempId);
      } catch (err) {
        if (isMissingDeferredQueueEntryError(err)) {
          return;
        }
        lastComposerSubmissionRef.current = previousLastSubmission;
        console.error("Failed to cancel deferred message:", err);
        const errorMsg = err instanceof Error ? err.message : String(err);
        showToast(
          t("sessionDeferredCancelFailed", { message: errorMsg }),
          "error",
        );
      }
    },
    [
      lastComposerSubmissionRef,
      lastSentComposerSubmissionRef,
      deferredMessages,
      sessionId,
      showToast,
      t,
    ],
  );

  const handleEditDeferred = useCallback(
    async (tempId: string) => {
      const controls = draftControlsRef.current;
      const message = deferredMessages.find(
        (candidate) => candidate.tempId === tempId,
      );
      if (
        !controls ||
        controls.getDraft().trim() ||
        attachmentsRef.current.length > 0 ||
        pendingUploadsRef.current.size > 0 ||
        !message
      ) {
        return;
      }

      try {
        await api.cancelDeferredMessage(sessionId, tempId);
        lastComposerSubmissionRef.current =
          getRecallSubmissionAfterQueuedCancel(
            lastComposerSubmissionRef.current,
            lastSentComposerSubmissionRef.current,
            deferredMessages,
            tempId,
          );
        restoreQueuedMessageToComposer(
          message.metadata?.turnEffort
            ? `/${message.metadata.turnEffort} ${message.content}`
            : message.content,
          message.attachments,
        );
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        showToast(
          t("sessionDeferredEditFailed", { message: errorMsg }),
          "error",
        );
      }
    },
    [
      draftControlsRef,
      attachmentsRef,
      pendingUploadsRef,
      lastComposerSubmissionRef,
      lastSentComposerSubmissionRef,
      deferredMessages,
      restoreQueuedMessageToComposer,
      sessionId,
      showToast,
      t,
    ],
  );

  const handleCancelUnconfirmedUserMessage = useCallback(
    async (tempId: string) => {
      try {
        await api.cancelUnconfirmedSteerMessage(sessionId, tempId);
        removeUnconfirmedSelfSend(tempId);
        if (
          lastComposerSubmissionRef.current?.kind === "sent" &&
          lastComposerSubmissionRef.current.id === tempId
        ) {
          lastComposerSubmissionRef.current = null;
        }
        if (lastSentComposerSubmissionRef.current?.id === tempId) {
          lastSentComposerSubmissionRef.current = null;
        }
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        showToast(
          t("sessionUnconfirmedSteerCancelFailed", { message: errorMsg }),
          "error",
        );
      }
    },
    [
      lastComposerSubmissionRef,
      lastSentComposerSubmissionRef,
      removeUnconfirmedSelfSend,
      sessionId,
      showToast,
      t,
    ],
  );

  const handleSteerDeferred = useCallback(
    async (tempId: string) => {
      // No optimistic removal: the chips clear when the server's next
      // deferred-queue state (without the steered entries) is mirrored.
      try {
        await api.steerDeferredMessagesThrough(sessionId, tempId);
      } catch (err) {
        console.error("Failed to steer deferred message:", err);
        const errorMsg = err instanceof Error ? err.message : String(err);
        showToast(
          t("sessionDeferredSteerFailed", { message: errorMsg }),
          "error",
        );
      }
    },
    [sessionId, showToast, t],
  );

  const handleDeliverDeferredWithoutCompaction = useCallback(
    async (tempId: string) => {
      try {
        const result = await api.deliverDeferredWithoutCompaction(
          sessionId,
          tempId,
        );
        setDeferredMessages(result.deferredMessages ?? []);
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        showToast(
          t("sessionQueuedSendWithoutCompactingFailed", { message: errorMsg }),
          "error",
        );
      }
    },
    [sessionId, setDeferredMessages, showToast, t],
  );

  // A recovered chip can outlive its server entry: a session with no live
  // process has no queue stream, so another client's delete or resume goes
  // unseen here. When the server reports the entry missing, read its queue
  // again so the chip does not stay and fail a second time.
  const dropMissingRecoveredEntry = useCallback(
    async (err: unknown): Promise<boolean> => {
      if ((err as { status?: number } | null)?.status !== 404) {
        return false;
      }
      try {
        const data = await api.getSessionMetadata(projectId, sessionId);
        setDeferredMessages(data.deferredMessages ?? []);
        return true;
      } catch {
        return false;
      }
    },
    [projectId, sessionId, setDeferredMessages],
  );

  const handleDeleteRecoveredDeferred = useCallback(
    async (queueId: string) => {
      try {
        const result = await api.deleteRecoveredQueuedMessage(
          sessionId,
          queueId,
        );
        setDeferredMessages(result.deferredMessages ?? []);
      } catch (err) {
        // Already gone is what the delete asked for.
        if (await dropMissingRecoveredEntry(err)) {
          return;
        }
        console.error("Failed to delete recovered queued message:", err);
        const errorMsg = err instanceof Error ? err.message : String(err);
        showToast(
          t("sessionRecoveredQueuedDeleteFailed", { message: errorMsg }),
          "error",
        );
      }
    },
    [dropMissingRecoveredEntry, sessionId, setDeferredMessages, showToast, t],
  );

  const handleResumeRecoveredDeferred = useCallback(
    async (queueId: string) => {
      try {
        const result = await api.resumeRecoveredQueuedMessage(
          sessionId,
          queueId,
        );
        setStatus({
          owner: "self",
          processId: result.processId,
          permissionMode: result.permissionMode,
          appliedPermissionMode: result.appliedPermissionMode,
          modeVersion: result.modeVersion,
          recapAfterSeconds: result.recapAfterSeconds,
        });
        setProcessState(result.processState ?? "idle");
        setDeferredMessages(result.deferredMessages ?? []);
      } catch (err) {
        void dropMissingRecoveredEntry(err);
        console.error("Failed to resume recovered queued message:", err);
        const errorMsg = err instanceof Error ? err.message : String(err);
        showToast(
          t("sessionRecoveredQueuedResumeFailed", { message: errorMsg }),
          "error",
        );
      }
    },
    [
      dropMissingRecoveredEntry,
      sessionId,
      setDeferredMessages,
      setProcessState,
      setStatus,
      showToast,
      t,
    ],
  );

  const handleSteerRecoveredDeferred = useCallback(
    async (queueId: string) => {
      try {
        const result = await api.steerRecoveredQueuedMessage(
          sessionId,
          queueId,
        );
        setStatus({
          owner: "self",
          processId: result.processId,
          permissionMode: result.permissionMode,
          appliedPermissionMode: result.appliedPermissionMode,
          modeVersion: result.modeVersion,
          recapAfterSeconds: result.recapAfterSeconds,
        });
        setProcessState(result.processState ?? "idle");
        setDeferredMessages(result.deferredMessages ?? []);
      } catch (err) {
        void dropMissingRecoveredEntry(err);
        console.error("Failed to steer recovered queued message:", err);
        const errorMsg = err instanceof Error ? err.message : String(err);
        showToast(
          t("sessionDeferredSteerFailed", { message: errorMsg }),
          "error",
        );
      }
    },
    [
      dropMissingRecoveredEntry,
      sessionId,
      setDeferredMessages,
      setProcessState,
      setStatus,
      showToast,
      t,
    ],
  );

  const handleCancelLatestDeferred = useCallback(() => {
    const latest = [...deferredMessages]
      .reverse()
      .find(
        (message) =>
          message.tempId && message.status !== "paused-after-restart",
      );
    if (!latest?.tempId) {
      return false;
    }
    void handleCancelDeferred(latest.tempId);
    return true;
  }, [deferredMessages, handleCancelDeferred]);

  return {
    handleResumeProjectQueueDispatch,
    handleCancelProjectQueueItem,
    handleEditProjectQueueItem,
    handleSteerProjectQueueItem,
    handleCancelDeferred,
    handleEditDeferred,
    handleCancelUnconfirmedUserMessage,
    handleSteerDeferred,
    handleDeliverDeferredWithoutCompaction,
    handleDeleteRecoveredDeferred,
    handleResumeRecoveredDeferred,
    handleSteerRecoveredDeferred,
    handleCancelLatestDeferred,
  };
}
