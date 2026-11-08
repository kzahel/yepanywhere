import { isLegacyCodexSetupText } from "@yep-anywhere/shared/transcript/codexLegacySetup";
import type {
  PermissionMode,
  ThinkingOption,
  TranscriptDisplayObject,
} from "@yep-anywhere/shared";
import {
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import type { NavigateFunction } from "react-router-dom";
import { api } from "../api/client";
import type { useStartNewSessionWithPrefillAction } from "../components/FileResourceActions";
import type { UploadProgress } from "../components/MessageInput";
import { useToastContext } from "../contexts/ToastContext";
import { useI18n } from "../i18n";
import type { ComposerAttachment } from "../lib/sessionComposerAttachments";
import { getUiCreationProvenance } from "../lib/sessionCreationProvenance";
import { buildConversationHandoffPrefill } from "../lib/sessionDetail/conversationHandoff";
import { turnContentText } from "../lib/sessionMessageText";
import type { resolveSessionModelConfig } from "../lib/sessionModelConfig";
import type { getCachedWebTranscriptProjection } from "../lib/webTranscriptProjection";
import type { Message } from "../types";
import type { DraftControls } from "./useDraftPersistence";
import { getForkSummaryAutoOpen } from "./useForkSummaryAutoOpen";
import type { useProject } from "./useProjects";
import type { useSession } from "./useSession";
import type { useVersion } from "./useVersion";

function messageKey(message: Message | undefined): string | undefined {
  return message?.uuid ?? message?.id;
}

/**
 * One session page's fork, clone, handoff and copy actions: forking before
 * or after a user turn, forking after a turn with a generated summary (its
 * composer draft, cancel, auto-open and follow), cloning the latest complete
 * turn, handing off from a turn into a new session, and copying a turn's
 * text. Moved verbatim from `SessionPage.tsx`
 * (docs/tactical/181-session-page-feature-hooks.md slice 1).
 */
export function useSessionForkActions({
  projectId,
  actualSessionId,
  session,
  messages,
  activityRenderItems,
  permissionMode,
  versionInfo,
  basePath,
  navigate,
  draftControlsRef,
  attachments,
  uploadProgress,
  forkAfterDisabled,
  updateTranscriptDisplayObjectsForSession,
  effectiveProvider,
  effectiveModel,
  effectiveModelConfig,
  currentGoal,
  project,
  getImplicitComposerThinking,
  startNewSessionWithPrefill,
}: {
  projectId: string;
  actualSessionId: string;
  session: ReturnType<typeof useSession>["session"];
  messages: Message[];
  activityRenderItems: ReturnType<typeof getCachedWebTranscriptProjection>;
  permissionMode: PermissionMode;
  versionInfo: ReturnType<typeof useVersion>["version"];
  basePath: string;
  navigate: NavigateFunction;
  draftControlsRef: RefObject<DraftControls | null>;
  attachments: readonly ComposerAttachment[];
  uploadProgress: readonly UploadProgress[];
  forkAfterDisabled: boolean;
  updateTranscriptDisplayObjectsForSession: (
    targetSessionId: string,
    updater: (objects: TranscriptDisplayObject[]) => TranscriptDisplayObject[],
  ) => void;
  effectiveProvider:
    | Parameters<typeof buildConversationHandoffPrefill>[0]["provider"]
    | undefined;
  effectiveModel: string | undefined;
  effectiveModelConfig: ReturnType<typeof resolveSessionModelConfig>;
  currentGoal: string | null | undefined;
  project: ReturnType<typeof useProject>["project"];
  getImplicitComposerThinking: () => ThinkingOption | undefined;
  startNewSessionWithPrefill: ReturnType<
    typeof useStartNewSessionWithPrefillAction
  >;
}) {
  const { t } = useI18n();
  const { showToast } = useToastContext();
  const [forkSummaryDraft, setForkSummaryDraft] = useState<{
    sourceMessageId: string;
  } | null>(null);
  const forkSummaryStartPendingRef = useRef<Set<string>>(new Set());
  const initiatedForkSummaryAutoOpenRef = useRef<Map<string, boolean>>(
    new Map(),
  );
  const attemptedForkSummaryAutoOpenRef = useRef<Set<string>>(new Set());

  const submitForkAfterSummary = useCallback(
    async (sourceMessageId: string, instructions: string) => {
      const requestSessionId = actualSessionId;
      if (
        forkSummaryStartPendingRef.current.has(requestSessionId) ||
        session?.transcriptDisplayObjects?.some(
          (object) => object.status === "generating",
        )
      ) {
        return;
      }
      forkSummaryStartPendingRef.current.add(requestSessionId);
      const autoOpenDefault = getForkSummaryAutoOpen();
      draftControlsRef.current?.clearDraft();
      setForkSummaryDraft(null);
      showToast(t("forkSummaryStarted"), "info");
      try {
        const result = await api.forkSessionWithSummary(
          projectId,
          requestSessionId,
          {
            sourceMessageId,
            instructions,
            mode: permissionMode,
            autoOpenWhenReady: autoOpenDefault,
          },
        );
        initiatedForkSummaryAutoOpenRef.current.set(
          result.displayObject.id,
          autoOpenDefault,
        );
        updateTranscriptDisplayObjectsForSession(requestSessionId, (objects) =>
          objects.some((object) => object.id === result.displayObject.id)
            ? [...objects]
            : [...objects, result.displayObject],
        );
      } catch (err) {
        showToast(
          err instanceof Error ? err.message : t("forkSummaryFailed"),
          "error",
        );
      } finally {
        forkSummaryStartPendingRef.current.delete(requestSessionId);
      }
    },
    [
      draftControlsRef,
      actualSessionId,
      permissionMode,
      projectId,
      session?.transcriptDisplayObjects,
      showToast,
      t,
      updateTranscriptDisplayObjectsForSession,
    ],
  );
  const submitForkAfterWithoutSummary = useCallback(
    async (sourceMessageId: string, nextTurnText: string) => {
      if (attachments.length > 0 || uploadProgress.length > 0) {
        showToast(t("forkSummaryAttachmentsUnsupported"), "error");
        return;
      }
      if (forkAfterDisabled) {
        showToast(t("forkAfterTurnPending"), "error");
        return;
      }

      draftControlsRef.current?.clearDraft();
      setForkSummaryDraft(null);
      try {
        const result = await api.forkSession(projectId, actualSessionId, {
          forkKind: "after-user-turn",
          sourceMessageId,
          creationProvenance: getUiCreationProvenance(versionInfo),
        });
        if (nextTurnText.trim()) {
          await api.queueMessage(
            result.sessionId,
            nextTurnText,
            permissionMode,
          );
        }
        showToast(t("forkFromTurnStarted"), "success");
        navigate(
          `${basePath}/projects/${projectId}/sessions/${result.sessionId}`,
        );
      } catch (error) {
        showToast(
          error instanceof Error ? error.message : t("sessionRestartFailed"),
          "error",
        );
      }
    },
    [
      draftControlsRef,
      actualSessionId,
      attachments.length,
      basePath,
      navigate,
      permissionMode,
      projectId,
      forkAfterDisabled,
      showToast,
      t,
      uploadProgress.length,
      versionInfo,
    ],
  );
  const createDirectTurnFork = useCallback(
    async (
      sourceMessageId: string,
      forkKind: "before-user-turn" | "after-user-turn",
    ) => {
      if (forkKind === "after-user-turn" && forkAfterDisabled) {
        showToast(t("forkAfterTurnPending"), "error");
        return;
      }
      try {
        const result = await api.forkSession(projectId, actualSessionId, {
          forkKind,
          sourceMessageId,
          creationProvenance: getUiCreationProvenance(versionInfo),
        });
        showToast(t("forkFromTurnStarted"), "success");
        navigate(
          `${basePath}/projects/${projectId}/sessions/${result.sessionId}`,
        );
      } catch (error) {
        showToast(
          error instanceof Error ? error.message : t("sessionRestartFailed"),
          "error",
        );
      }
    },
    [
      actualSessionId,
      basePath,
      forkAfterDisabled,
      navigate,
      projectId,
      showToast,
      t,
      versionInfo,
    ],
  );
  const cloneSession = useCallback(async () => {
    if (forkAfterDisabled) {
      showToast(t("sessionMenuCloneDisabled"), "error");
      return;
    }
    try {
      const result = await api.forkSession(projectId, actualSessionId, {
        forkKind: "clone-latest-complete",
        creationProvenance: getUiCreationProvenance(versionInfo),
      });
      showToast(t("sessionCloneCreated"), "success");
      navigate(
        `${basePath}/projects/${projectId}/sessions/${result.sessionId}`,
      );
    } catch (error) {
      showToast(
        error instanceof Error ? error.message : t("sessionCloneFailed"),
        "error",
      );
    }
  }, [
    actualSessionId,
    basePath,
    forkAfterDisabled,
    navigate,
    projectId,
    showToast,
    t,
    versionInfo,
  ]);
  const cancelForkSummaryJob = useCallback(
    async (objectId: string) => {
      const requestSessionId = actualSessionId;
      try {
        const result = await api.cancelForkSessionWithSummary(
          projectId,
          requestSessionId,
          objectId,
        );
        initiatedForkSummaryAutoOpenRef.current.delete(objectId);
        updateTranscriptDisplayObjectsForSession(
          requestSessionId,
          () => result.transcriptDisplayObjects,
        );
      } catch (error) {
        showToast(
          error instanceof Error ? error.message : t("forkSummaryFailed"),
          "error",
        );
      }
    },
    [
      actualSessionId,
      projectId,
      showToast,
      t,
      updateTranscriptDisplayObjectsForSession,
    ],
  );
  const setForkSummaryAutoOpen = useCallback(
    async (objectId: string, next: boolean) => {
      const requestSessionId = actualSessionId;
      initiatedForkSummaryAutoOpenRef.current.set(objectId, next);
      updateTranscriptDisplayObjectsForSession(requestSessionId, (objects) =>
        objects.map((object) =>
          object.id === objectId
            ? { ...object, autoOpenWhenReady: next || undefined }
            : object,
        ),
      );
      try {
        const result = await api.updateForkSummaryDisplayObject(
          projectId,
          requestSessionId,
          objectId,
          { autoOpenWhenReady: next },
        );
        updateTranscriptDisplayObjectsForSession(
          requestSessionId,
          () => result.transcriptDisplayObjects,
        );
      } catch (error) {
        showToast(
          error instanceof Error ? error.message : t("forkSummaryFailed"),
          "error",
        );
      }
    },
    [
      actualSessionId,
      projectId,
      showToast,
      t,
      updateTranscriptDisplayObjectsForSession,
    ],
  );
  const followForkSummary = useCallback(
    (objectId: string) => {
      const requestSessionId = actualSessionId;
      void api
        .updateForkSummaryDisplayObject(projectId, requestSessionId, objectId, {
          action: "clicked",
        })
        .then((result) => {
          updateTranscriptDisplayObjectsForSession(
            requestSessionId,
            () => result.transcriptDisplayObjects,
          );
        })
        .catch(() => {});
    },
    [actualSessionId, projectId, updateTranscriptDisplayObjectsForSession],
  );
  const getForkSummaryTargetHref = useCallback(
    (targetSessionId: string) =>
      `${window.location.origin}${basePath}/projects/${projectId}/sessions/${targetSessionId}`,
    [basePath, projectId],
  );
  // Stable identities for props passed into the memoized MessageList. Inline
  // arrows here re-render the whole (un-virtualized) transcript on every
  // per-second SessionPage tick; see topics/transcript-virtualization.md.
  const handleCancelForkSummary = useCallback(
    (objectId: string) => {
      void cancelForkSummaryJob(objectId);
    },
    [cancelForkSummaryJob],
  );
  const handleToggleForkSummaryAutoOpen = useCallback(
    (objectId: string, value: boolean) => {
      void setForkSummaryAutoOpen(objectId, value);
    },
    [setForkSummaryAutoOpen],
  );
  useEffect(() => {
    for (const object of session?.transcriptDisplayObjects ?? []) {
      if (
        object.status !== "ready" ||
        !object.targetSessionId ||
        object.openedAt ||
        attemptedForkSummaryAutoOpenRef.current.has(object.id) ||
        initiatedForkSummaryAutoOpenRef.current.get(object.id) !== true ||
        object.autoOpenWhenReady !== true
      ) {
        continue;
      }
      attemptedForkSummaryAutoOpenRef.current.add(object.id);
      try {
        const opened = window.open(
          getForkSummaryTargetHref(object.targetSessionId),
          "_blank",
        );
        if (!opened) {
          continue;
        }
        opened.opener = null;
        void api
          .updateForkSummaryDisplayObject(
            projectId,
            actualSessionId,
            object.id,
            { action: "opened" },
          )
          .then((result) => {
            updateTranscriptDisplayObjectsForSession(
              actualSessionId,
              () => result.transcriptDisplayObjects,
            );
          })
          .catch(() => {});
      } catch {
        // Popup blocking leaves the durable follow link available.
      }
    }
  }, [
    actualSessionId,
    getForkSummaryTargetHref,
    projectId,
    session?.transcriptDisplayObjects,
    updateTranscriptDisplayObjectsForSession,
  ]);
  const beginForkAfterSummary = useCallback(
    (messageId: string) => {
      if (attachments.length > 0 || uploadProgress.length > 0) {
        showToast(t("forkSummaryAttachmentsUnsupported"), "error");
        return false;
      }
      if (forkAfterDisabled) {
        showToast(t("forkAfterTurnPending"), "error");
        return false;
      }
      setForkSummaryDraft({
        sourceMessageId: messageId,
      });
      draftControlsRef.current?.focus?.();
      return true;
    },
    [
      draftControlsRef,
      attachments.length,
      forkAfterDisabled,
      showToast,
      t,
      uploadProgress.length,
    ],
  );
  const beginForkAfterInitialTurn = useCallback(
    (instructions: string) => {
      if (attachments.length > 0 || uploadProgress.length > 0) {
        showToast(t("forkSummaryAttachmentsUnsupported"), "error");
        return false;
      }
      const firstUser = messages.find((message) => {
        if (message.type !== "user") return false;
        const text = turnContentText(message.message?.content);
        return !isLegacyCodexSetupText(text, [message]);
      });
      const firstUserId = messageKey(firstUser);
      if (!firstUserId) {
        showToast(t("forkAfterTurnNoAnchor"), "error");
        return false;
      }
      if (forkAfterDisabled) {
        showToast(t("forkAfterTurnPending"), "error");
        return false;
      }
      if (instructions.trim()) {
        void submitForkAfterSummary(firstUserId, instructions.trim());
        return true;
      }
      setForkSummaryDraft({
        sourceMessageId: firstUserId,
      });
      draftControlsRef.current?.focus?.();
      return true;
    },
    [
      draftControlsRef,
      attachments.length,
      forkAfterDisabled,
      messages,
      showToast,
      submitForkAfterSummary,
      t,
      uploadProgress.length,
    ],
  );
  const forkBeforeUserMessage = useCallback(
    (messageId: string) => createDirectTurnFork(messageId, "before-user-turn"),
    [createDirectTurnFork],
  );
  const forkAfterUserMessage = useCallback(
    (messageId: string) => createDirectTurnFork(messageId, "after-user-turn"),
    [createDirectTurnFork],
  );
  const copyUserMessage = useCallback(
    (messageId: string) => {
      const msg = messages.find((m) => (m.uuid ?? m.id) === messageId);
      const text = turnContentText(msg?.message?.content).trim();
      if (!text) return;
      void navigator.clipboard?.writeText(text).catch((err) => {
        console.error("Failed to copy turn:", err);
      });
    },
    [messages],
  );

  const handoffFromUserMessage = useCallback(
    (messageId: string, options: { newTab: boolean }) => {
      if (!effectiveProvider || !actualSessionId) return;
      const prefill = buildConversationHandoffPrefill({
        items: activityRenderItems,
        fromUserTurnId: messageId,
        provider: effectiveProvider,
        sessionId: actualSessionId,
        goal: currentGoal,
        projectPath: project?.path,
      });
      if (!prefill) return;
      startNewSessionWithPrefill(projectId, prefill, {
        caret: "start",
        executor: session?.executor,
        model: effectiveModelConfig?.model ?? effectiveModel,
        newTab: options.newTab,
        permissionMode,
        provider: effectiveProvider,
        thinking: getImplicitComposerThinking(),
      });
    },
    [
      activityRenderItems,
      actualSessionId,
      currentGoal,
      effectiveModel,
      effectiveModelConfig?.model,
      effectiveProvider,
      getImplicitComposerThinking,
      permissionMode,
      project?.path,
      projectId,
      session?.executor,
      startNewSessionWithPrefill,
    ],
  );

  return {
    forkSummaryDraft,
    setForkSummaryDraft,
    submitForkAfterSummary,
    submitForkAfterWithoutSummary,
    createDirectTurnFork,
    cloneSession,
    followForkSummary,
    getForkSummaryTargetHref,
    handleCancelForkSummary,
    handleToggleForkSummaryAutoOpen,
    beginForkAfterSummary,
    beginForkAfterInitialTurn,
    forkBeforeUserMessage,
    forkAfterUserMessage,
    copyUserMessage,
    handoffFromUserMessage,
  };
}
