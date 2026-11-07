import {
  type PermissionMode,
  type ProjectQueueStagedAttachments,
  type ProviderName,
  SERVER_CAPABILITIES,
  type SlashCommandGoalDetails,
  serverHasCapability,
  type ThinkingOption,
  type UploadedFile,
} from "@yep-anywhere/shared";
import type { Dispatch, RefObject, SetStateAction } from "react";
import type { NavigateFunction } from "react-router-dom";
import { api, type VersionInfo } from "../api/client";
import type { ChosenNewSessionQueueTarget } from "../components/NewSessionQueueOptions";
import type { useToastContext } from "../contexts/ToastContext";
import type { useComposerBeacon } from "../hooks/useComposerBeacon";
import type { DraftControls } from "../hooks/useDraftPersistence";
import {
  getModelSetting,
  getShowThinkingSetting,
} from "../hooks/useModelSettings";
import type { useSession } from "../hooks/useSession";
import type { TranslationFn } from "../i18n";
import type { MessageSubmissionMetadata } from "../types/messageSubmission";
import type { LastComposerSubmission } from "./composerRecall";
import { logSessionUiTrace } from "./diagnostics/uiTrace";
import { createLegacySession } from "./legacySessionCreation";
import {
  getEstimatedServerOffsetMs,
  getServerClockTimestamp,
  measureServerLatencyMs,
  recordServerClockSample,
} from "./serverClock";
import {
  type ComposerAttachment,
  isComposerStagedAttachment,
  revokeAttachmentPreviewUrls,
  toPersistedStagedAttachmentRef,
} from "./sessionComposerAttachments";
import {
  buildResumeOptions,
  type ComposerSubmissionFallback,
  finalFailureNotice,
  firstSendFailureStep,
  planProjectQueue,
  planQueue,
  planSend,
  projectQueueQueuedMessage,
  resolveComposerSubmission,
  resolveProjectQueueCommand,
  shouldRetryWithResume,
} from "./sessionComposerSendDecisions";
import {
  ComposerAttachmentUploadError,
  materializeComposerAttachmentsForSubmission,
  type PreparedComposerSubmission,
  splitComposerAttachmentsForSubmission,
  stageComposerAttachmentsForNewSession,
} from "./sessionComposerSubmission";
import {
  acceptSessionCreation,
  pendingSessionCreation,
  settleSessionCreation,
} from "./sessionCreation";
import { recordSessionInteraction } from "./sessionInteractionOrder";
import { createSessionNavigationState } from "./sessionNavigationState";
import type { sessionResumeOverrides } from "./sessionResumeSettings";
import type { SourceSummaryRuntime, YaSourceRuntime } from "./sourceRuntime";
import type { SourceTransport } from "./transport/types";

type SessionState = ReturnType<typeof useSession>;

/** What `captureCreationView` records and `ownsCreationView` compares. */
interface SessionCreationView {
  key: string;
  href: string;
  historyIndex: unknown;
  activation: number | undefined;
}

interface SessionCorrectionDraft {
  messageId: string;
  originalText: string;
  recalled?: boolean;
}

/**
 * The session page values the send paths read. The page passes this render's
 * values; refs are read through `.current` when a path runs.
 */
export interface SessionComposerSendDeps {
  projectId: string;
  sessionId: string;
  t: TranslationFn;
  showToast: ReturnType<typeof useToastContext>["showToast"];
  basePath: string;
  sourceRuntime: YaSourceRuntime;
  sourceSummary: SourceSummaryRuntime;
  sourceTransport: SourceTransport;
  versionInfo: VersionInfo | null;
  creationPrincipalResolved: boolean;
  creationKey: string;
  captureCreationView: () => SessionCreationView;
  ownsCreationView: (token: SessionCreationView) => boolean;
  setCreationRecovery: Dispatch<
    SetStateAction<{
      key: string;
      requestId: string;
      accepted?: boolean;
    } | null>
  >;
  syntheticDoneEnabled: boolean;
  supportsSyntheticDone: boolean;
  supportsSyntheticArchive: boolean;
  supportsSyntheticTerminate: boolean;
  navigate: NavigateFunction;
  session: SessionState["session"];
  status: SessionState["status"];
  processState: SessionState["processState"];
  setIsCompacting: SessionState["setIsCompacting"];
  actualSessionId: SessionState["actualSessionId"];
  setStatus: SessionState["setStatus"];
  setProcessState: SessionState["setProcessState"];
  addPendingMessage: SessionState["addPendingMessage"];
  removePendingMessage: SessionState["removePendingMessage"];
  isMessageDelivered: SessionState["isMessageDelivered"];
  updatePendingMessage: SessionState["updatePendingMessage"];
  setDeferredMessages: SessionState["setDeferredMessages"];
  reconnectStream: SessionState["reconnectStream"];
  permissionMode: PermissionMode;
  goalDetails: SlashCommandGoalDetails | undefined;
  effectiveProvider: ProviderName | undefined;
  setScrollTrigger: Dispatch<SetStateAction<number>>;
  draftControlsRef: RefObject<DraftControls | null>;
  lastComposerSubmissionRef: RefObject<LastComposerSubmission | null>;
  routedSession: boolean;
  supportsBtwAsides: boolean;
  beginBeaconSubmission: ReturnType<typeof useComposerBeacon>;
  correctionDraft: SessionCorrectionDraft | null;
  setCorrectionDraft: Dispatch<SetStateAction<SessionCorrectionDraft | null>>;
  attachments: ComposerAttachment[];
  attachmentsRef: RefObject<ComposerAttachment[]>;
  pendingUploadsRef: RefObject<Map<string, Promise<ComposerAttachment | null>>>;
  rememberSentSubmission: (text: string, id: string) => void;
  setComposerAttachments: (
    updater:
      | ComposerAttachment[]
      | ((previous: readonly ComposerAttachment[]) => ComposerAttachment[]),
    options?: {
      persistDraft?: boolean;
      revokeRemovedPreviewUrls?: boolean;
    },
  ) => void;
  materializeComposerAttachments: (
    composerAttachments: readonly ComposerAttachment[],
  ) => Promise<UploadedFile[]>;
  supportsManualCompact: boolean;
  supportsTurnEffort: boolean;
  supportsRewind: boolean;
  supportsFileViewCommand: boolean;
  getImplicitComposerThinking: () => ThinkingOption | undefined;
  getResumeSettings: (
    explicitThinking?: ThinkingOption,
  ) => ReturnType<typeof sessionResumeOverrides>;
  setShowHandoffModal: Dispatch<SetStateAction<boolean>>;
  collectComposerAttachmentsForSubmission: (options?: {
    pendingMessageId?: string;
    detach?: boolean;
  }) => Promise<ComposerAttachment[]>;
  handleSyntheticSessionBoundary: (
    command: "done" | "archive" | "terminate",
  ) => Promise<void>;
  // Declared later in the page, so it passes wrappers that call this render's
  // callbacks when a send runs.
  clearQuoteAnchors: () => void;
  handleCustomCommand: (command: string, argument?: string) => boolean;
  handleFileViewCommand: (argument: string) => Promise<void>;
  handleLocalTitleCommand: (title: string | null) => Promise<void>;
}

/**
 * The session page's send paths: prepare, send, deferred queue and Project
 * Queue. Plain functions, rebuilt on every render from that render's values.
 */
export function createSessionComposerSend(deps: SessionComposerSendDeps) {
  const {
    projectId,
    sessionId,
    t,
    showToast,
    basePath,
    sourceRuntime,
    sourceSummary,
    sourceTransport,
    versionInfo,
    creationPrincipalResolved,
    creationKey,
    captureCreationView,
    ownsCreationView,
    setCreationRecovery,
    syntheticDoneEnabled,
    supportsSyntheticDone,
    supportsSyntheticArchive,
    supportsSyntheticTerminate,
    navigate,
    session,
    status,
    processState,
    setIsCompacting,
    actualSessionId,
    setStatus,
    setProcessState,
    addPendingMessage,
    removePendingMessage,
    isMessageDelivered,
    updatePendingMessage,
    setDeferredMessages,
    reconnectStream,
    permissionMode,
    goalDetails,
    effectiveProvider,
    setScrollTrigger,
    draftControlsRef,
    lastComposerSubmissionRef,
    routedSession,
    supportsBtwAsides,
    beginBeaconSubmission,
    correctionDraft,
    setCorrectionDraft,
    attachments,
    attachmentsRef,
    pendingUploadsRef,
    rememberSentSubmission,
    setComposerAttachments,
    materializeComposerAttachments,
    supportsManualCompact,
    supportsTurnEffort,
    supportsRewind,
    supportsFileViewCommand,
    getImplicitComposerThinking,
    getResumeSettings,
    setShowHandoffModal,
    collectComposerAttachmentsForSubmission,
    handleSyntheticSessionBoundary,
    clearQuoteAnchors,
    handleCustomCommand,
    handleFileViewCommand,
    handleLocalTitleCommand,
  } = deps;

  const prepareComposerSubmission = (
    text: string,
    queueIntent = false,
  ): PreparedComposerSubmission | null => {
    const decision = resolveComposerSubmission(text, queueIntent, {
      correctionOriginalText: correctionDraft?.originalText ?? null,
      rewindSupported: supportsRewind,
      manualCompactSupported: supportsManualCompact,
      queuedCompactionSupported: serverHasCapability(
        versionInfo,
        SERVER_CAPABILITIES.queuedSessionCompaction,
      ),
      syntheticDoneEnabled,
      syntheticDoneSupported: supportsSyntheticDone,
      syntheticArchiveSupported: supportsSyntheticArchive,
      syntheticTerminateSupported: supportsSyntheticTerminate,
      fileViewCommandSupported: supportsFileViewCommand,
      btwAsidesSupported: supportsBtwAsides,
      turnEffortSupported: supportsTurnEffort,
      attachmentCount: attachmentsRef.current.length,
      pendingUploadCount: pendingUploadsRef.current.size,
      t,
    });
    const applyOutcome = (
      outcome: ComposerSubmissionFallback,
    ): PreparedComposerSubmission | null => {
      if (outcome.kind === "refuse") {
        draftControlsRef.current?.setDraft(outcome.restoreText);
        showToast(outcome.message, outcome.severity);
        return null;
      }
      return outcome.kind === "submit" ? outcome.prepared : null;
    };
    if (decision.kind === "local") {
      if (decision.endCorrectionFirst) setCorrectionDraft(null);
      const operation = decision.operation;
      if (operation.kind === "session-boundary") {
        void handleSyntheticSessionBoundary(operation.command);
      } else if (operation.kind === "title") {
        void handleLocalTitleCommand(operation.title);
      } else {
        void handleFileViewCommand(operation.argument);
      }
      return null;
    }
    if (decision.kind === "custom") {
      if (handleCustomCommand(decision.command, decision.argument)) {
        if (decision.endCorrectionIfHandled) setCorrectionDraft(null);
        return null;
      }
      return applyOutcome(decision.fallback);
    }
    return applyOutcome(decision);
  };

  const handleSend = async (
    text: string,
    metadata?: MessageSubmissionMetadata,
    options: {
      preserveComposer?: boolean;
      preserveScroll?: boolean;
      localControl?: boolean;
    } = {},
  ): Promise<boolean> => {
    const prepared: PreparedComposerSubmission | null =
      options.localControl || options.preserveComposer
        ? { outgoingText: text }
        : prepareComposerSubmission(text);
    if (!prepared) {
      return false;
    }
    const preserveComposer = options.preserveComposer === true;
    const plan = planSend({
      prepared,
      metadata,
      processState,
      goalActive: goalDetails?.goalStatus !== undefined,
      preserveComposer,
      localControlRequested: options.localControl === true,
      version: versionInfo,
      attachmentCount: attachmentsRef.current.length,
    });
    if (plan.kind === "queue-instead") {
      return handleQueue(text, metadata);
    }
    if (plan.kind === "refuse-attachment-only") {
      showToast(t("attachmentOnlyRequiresServerUpdate"), "error");
      return false;
    }
    metadata = plan.metadata;
    const { outgoingText, slashCommand } = prepared;
    const localControl = plan.localControl;
    const thinking = prepared.thinking ?? getImplicitComposerThinking();
    // Display preference for thinking rows; sent for compatibility while the
    // server requests provider summaries independently.
    const showThinking = getShowThinkingSetting();
    const actionAtMs = Date.now();
    const clientTimestamp = getServerClockTimestamp(actionAtMs);
    const clientTimestampIso = new Date(clientTimestamp).toISOString();

    recordSessionInteraction(
      sourceRuntime.sourceKey,
      actualSessionId,
      actionAtMs,
    );

    // Add to pending queue and get tempId to pass to server
    const { tempId } = addPendingMessage(
      outgoingText,
      undefined,
      clientTimestampIso,
    );
    const completeBeaconSubmission = !preserveComposer
      ? beginBeaconSubmission({
          tempId,
          content: outgoingText,
          timestamp: clientTimestampIso,
        })
      : undefined;
    if (!localControl) {
      setProcessState("in-turn"); // Optimistic: show processing indicator immediately
      if (!options.preserveScroll) setScrollTrigger((prev) => prev + 1);
    }
    logSessionUiTrace("composer-send-start", {
      sessionId,
      projectId,
      tempId,
      owner: status.owner,
      processId: status.owner === "self" ? status.processId : null,
      permissionMode,
      thinking,
      slashCommand: slashCommand ?? null,
      textLength: outgoingText.length,
      attachmentCount: preserveComposer ? 0 : attachments.length,
      hasCorrectionDraft: preserveComposer ? false : !!correctionDraft,
      clientTimestamp,
      serverOffsetMs: getEstimatedServerOffsetMs(),
    });

    let currentAttachments = preserveComposer
      ? []
      : [...attachmentsRef.current];
    let uploadedAttachments: UploadedFile[] = [];

    const confirmSubmission = () => {
      completeBeaconSubmission?.("delivered");
      if (!preserveComposer) {
        rememberSentSubmission(text, tempId);
        draftControlsRef.current?.confirmInputClear();
        revokeAttachmentPreviewUrls(currentAttachments);
        setCorrectionDraft(null);
        clearQuoteAnchors();
      }
      return true;
    };

    try {
      if (!preserveComposer) {
        currentAttachments = await collectComposerAttachmentsForSubmission({
          pendingMessageId: tempId,
        });
        uploadedAttachments =
          await materializeComposerAttachments(currentAttachments);
      }
      if (uploadedAttachments.length > 0) {
        updatePendingMessage(tempId, { attachments: uploadedAttachments });
      }

      const requestSentAtMs = Date.now();
      if (status.owner === "none") {
        // Saved settings stay server-owned; only deliberate edits override them.
        // Use effectiveProvider to ensure correct provider even if session data hasn't loaded
        // effectiveProvider = session?.provider ?? initialProvider (from navigation state)
        const result = await api.resumeSession(
          projectId,
          sessionId,
          outgoingText,
          buildResumeOptions(getResumeSettings(prepared.thinking), {
            showThinking,
            provider: effectiveProvider,
            executor: session?.executor,
          }),
          uploadedAttachments.length > 0 ? uploadedAttachments : undefined,
          tempId,
          clientTimestamp,
          metadata,
        );
        const responseReceivedAtMs = Date.now();
        const timing = recordServerClockSample({
          clientRequestStartMs: requestSentAtMs,
          clientResponseEndMs: responseReceivedAtMs,
          serverTimestamp: result.serverTimestamp,
        });
        // Update status to trigger SSE connection
        logSessionUiTrace("composer-send-resume-success", {
          sessionId,
          tempId,
          processId: result.processId,
          clientTimestamp,
          serverTimestamp: result.serverTimestamp,
          uploadWaitMs: requestSentAtMs - actionAtMs,
          requestRttMs: timing?.roundTripMs ?? null,
          estimatedServerOffsetMs: timing?.serverOffsetMs ?? null,
          clientToServerLatencyMs: measureServerLatencyMs(
            clientTimestamp,
            result.serverTimestamp,
          ),
        });
        setStatus({
          owner: "self",
          processId: result.processId,
          permissionMode: result.permissionMode,
          appliedPermissionMode: result.appliedPermissionMode,
          modeVersion: result.modeVersion,
          recapAfterSeconds: result.recapAfterSeconds,
        });
      } else {
        // Queue to existing process with current permission mode and thinking setting
        const result = await api.queueMessage(
          sessionId,
          outgoingText,
          permissionMode,
          uploadedAttachments.length > 0 ? uploadedAttachments : undefined,
          tempId,
          thinking,
          undefined, // deferred
          clientTimestamp,
          metadata,
          undefined, // serviceTier
          showThinking,
        );
        const responseReceivedAtMs = Date.now();
        const timing = recordServerClockSample({
          clientRequestStartMs: requestSentAtMs,
          clientResponseEndMs: responseReceivedAtMs,
          serverTimestamp: result.serverTimestamp,
        });
        logSessionUiTrace("composer-send-queue-success", {
          sessionId,
          tempId,
          restarted: !!result.restarted,
          processId: result.processId ?? null,
          clientTimestamp,
          serverTimestamp: result.serverTimestamp,
          uploadWaitMs: requestSentAtMs - actionAtMs,
          requestRttMs: timing?.roundTripMs ?? null,
          estimatedServerOffsetMs: timing?.serverOffsetMs ?? null,
          clientToServerLatencyMs: measureServerLatencyMs(
            clientTimestamp,
            result.serverTimestamp,
          ),
        });
        if (result.compactQueued) {
          setIsCompacting(true);
        }
        // If process was restarted due to thinking mode change, reconnect stream
        const restartedProcessId = result.restarted ? result.processId : null;
        if (restartedProcessId) {
          setStatus((prev) =>
            prev.owner === "self"
              ? { ...prev, processId: restartedProcessId }
              : { owner: "self", processId: restartedProcessId },
          );
          reconnectStream();
        }
        // A send the server deferred (behind a queued compaction) shows in
        // the queue, as a queued message does.
        if (result.deferredMessages) {
          setDeferredMessages(result.deferredMessages);
        }
      }
      return confirmSubmission();
    } catch (err) {
      // An aborted HTTP response does not undo delivery already observed on
      // the session stream or in durable history. Never restore or retry it.
      const firstStep = firstSendFailureStep(
        err,
        isMessageDelivered({
          tempId,
          content: outgoingText,
          timestamp: clientTimestampIso,
        }),
      );
      if (firstStep === "delivered") {
        return confirmSubmission();
      }
      console.error("Failed to send:", err);
      let finalError: unknown = err;
      if (err instanceof ComposerAttachmentUploadError)
        currentAttachments = err.attachments;
      logSessionUiTrace("composer-send-error", {
        sessionId,
        tempId,
        message: err instanceof Error ? err.message : String(err),
      });

      // The session went cold under the limited-user freshness cutoff: the
      // server refused the turn and says it belongs in a new session seeded
      // with a handoff of this one (topics/limited-users.md § Freshness).
      if (firstStep === "stale-redirect") {
        try {
          const started = await api.staleHandoffSession(
            projectId,
            sessionId,
            outgoingText,
            {
              mode: permissionMode,
              tempId,
              clientTimestamp,
              messageMetadata: metadata,
            },
            uploadedAttachments.length > 0 ? uploadedAttachments : undefined,
          );
          removePendingMessage(tempId);
          if (!localControl) setProcessState("idle");
          confirmSubmission();
          if (!started.sessionId) {
            // Accepted but waiting for a free worker; it appears in the
            // session list when it starts.
            showToast(t("sessionStaleHandoffQueued"), "success");
            return true;
          }
          showToast(t("sessionStaleHandoffStarted"), "success");
          navigate(
            `${basePath}/projects/${started.projectId}/sessions/${started.sessionId}`,
            {
              state: createSessionNavigationState({
                initialStatus: {
                  owner: "self",
                  processId: started.processId,
                  permissionMode: started.permissionMode,
                  appliedPermissionMode: started.appliedPermissionMode,
                  modeVersion: started.modeVersion,
                  recapAfterSeconds: started.recapAfterSeconds,
                },
                initialTitle: started.title,
                initialModel: started.model,
                initialProvider: started.provider ?? effectiveProvider,
              }),
            },
          );
          return true;
        } catch (redirectErr) {
          // Reported by the toast below, like any other send failure.
          finalError = redirectErr;
        }
      }

      // Check if process is dead (404) - auto-retry with resumeSession
      if (shouldRetryWithResume(err)) {
        try {
          const retryRequestSentAtMs = Date.now();
          const result = await api.resumeSession(
            projectId,
            sessionId,
            outgoingText,
            buildResumeOptions(getResumeSettings(prepared.thinking), {
              showThinking,
              provider: effectiveProvider,
              executor: session?.executor,
            }),
            uploadedAttachments.length > 0 ? uploadedAttachments : undefined,
            tempId,
            clientTimestamp,
            metadata,
          );
          const retryResponseReceivedAtMs = Date.now();
          const retryTiming = recordServerClockSample({
            clientRequestStartMs: retryRequestSentAtMs,
            clientResponseEndMs: retryResponseReceivedAtMs,
            serverTimestamp: result.serverTimestamp,
          });
          logSessionUiTrace("composer-send-retry-resume-success", {
            sessionId,
            tempId,
            processId: result.processId,
            clientTimestamp,
            serverTimestamp: result.serverTimestamp,
            uploadWaitMs: retryRequestSentAtMs - actionAtMs,
            requestRttMs: retryTiming?.roundTripMs ?? null,
            estimatedServerOffsetMs: retryTiming?.serverOffsetMs ?? null,
            clientToServerLatencyMs: measureServerLatencyMs(
              clientTimestamp,
              result.serverTimestamp,
            ),
          });
          setStatus({
            owner: "self",
            processId: result.processId,
            permissionMode: result.permissionMode,
            appliedPermissionMode: result.appliedPermissionMode,
            modeVersion: result.modeVersion,
            recapAfterSeconds: result.recapAfterSeconds,
          });
          return confirmSubmission();
        } catch (retryErr) {
          console.error("Failed to resume session:", retryErr);
          finalError = retryErr;
          logSessionUiTrace("composer-send-retry-resume-error", {
            sessionId,
            tempId,
            message:
              retryErr instanceof Error ? retryErr.message : String(retryErr),
          });
          // Fall through to error handling below
        }
      }

      // Remove from pending queue and restore draft on error
      completeBeaconSubmission?.("error");
      removePendingMessage(tempId);
      if (!preserveComposer) {
        draftControlsRef.current?.restoreFromStorage();
        setComposerAttachments(currentAttachments, { persistDraft: false });
      }
      if (!localControl) setProcessState("idle");
      // A routed session cannot hand off yet, so offer no handoff modal.
      const notice = finalFailureNotice({
        finalError,
        provider: effectiveProvider,
        routedSession,
        path: "send",
        t,
      });
      if (notice.openHandoffDialog) setShowHandoffModal(true);
      showToast(notice.message, "error");
      return false;
    }
  };

  const handleQueue = async (
    text: string,
    metadata?: MessageSubmissionMetadata,
  ): Promise<boolean> => {
    const prepared = prepareComposerSubmission(text, true);
    if (!prepared) {
      return false;
    }
    const plan = planQueue({
      prepared,
      metadata,
      version: versionInfo,
      attachmentCount: attachmentsRef.current.length,
    });
    if (plan.kind === "refuse-attachment-only") {
      showToast(t("attachmentOnlyRequiresServerUpdate"), "error");
      return false;
    }
    metadata = plan.metadata;
    const { outgoingText, slashCommand } = prepared;
    const thinking = prepared.thinking ?? getImplicitComposerThinking();
    // Display preference for thinking rows; sent for compatibility while the
    // server requests provider summaries independently.
    const showThinking = getShowThinkingSetting();
    const actionAtMs = Date.now();
    const clientTimestamp = getServerClockTimestamp(actionAtMs);

    recordSessionInteraction(
      sourceRuntime.sourceKey,
      actualSessionId,
      actionAtMs,
    );

    // The queue path is not optimistic: no "Sending..." pending chip. The
    // composer disables for the round-trip and the queued chip renders from the
    // server's deferred-queue state (SSE event + this POST response). We still
    // mint a tempId so the server can echo this message back by identity.
    const tempId = `temp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const completeBeaconSubmission = beginBeaconSubmission({
      tempId,
      content: outgoingText,
      timestamp: new Date(clientTimestamp).toISOString(),
    });
    setScrollTrigger((prev) => prev + 1);
    logSessionUiTrace("composer-deferred-start", {
      sessionId,
      tempId,
      owner: status.owner,
      processId: status.owner === "self" ? status.processId : null,
      permissionMode,
      thinking,
      slashCommand: slashCommand ?? null,
      textLength: outgoingText.length,
      attachmentCount: attachments.length,
      clientTimestamp,
      serverOffsetMs: getEstimatedServerOffsetMs(),
    });

    let currentAttachments = [...attachmentsRef.current];
    let uploadedAttachments: UploadedFile[] = [];

    try {
      currentAttachments = await collectComposerAttachmentsForSubmission();
      uploadedAttachments =
        await materializeComposerAttachments(currentAttachments);
      const requestSentAtMs = Date.now();
      const result = await api.queueMessage(
        sessionId,
        outgoingText,
        permissionMode,
        uploadedAttachments.length > 0 ? uploadedAttachments : undefined,
        tempId,
        thinking,
        true, // deferred
        clientTimestamp,
        metadata,
        undefined, // serviceTier
        showThinking,
      );
      const responseReceivedAtMs = Date.now();
      const timing = recordServerClockSample({
        clientRequestStartMs: requestSentAtMs,
        clientResponseEndMs: responseReceivedAtMs,
        serverTimestamp: result.serverTimestamp,
      });
      logSessionUiTrace("composer-deferred-result", {
        sessionId,
        tempId,
        deferred: result.deferred ?? null,
        promoted: result.promoted ?? null,
        position: result.position ?? null,
        deferredCount: result.deferredMessages?.length ?? null,
        clientTimestamp,
        serverTimestamp: result.serverTimestamp,
        uploadWaitMs: requestSentAtMs - actionAtMs,
        requestRttMs: timing?.roundTripMs ?? null,
        estimatedServerOffsetMs: timing?.serverOffsetMs ?? null,
        clientToServerLatencyMs: measureServerLatencyMs(
          clientTimestamp,
          result.serverTimestamp,
        ),
      });
      // Mirror the server's authoritative queue from the response. The
      // deferred-queue SSE event reports the same thing; whichever lands last
      // wins, and both are server truth, so there is nothing to reconcile.
      setDeferredMessages(result.deferredMessages ?? []);
      if (result.deferred === false || result.promoted) {
        // Promoted straight into the active turn — treat it like a sent message
        // for composer recall.
        rememberSentSubmission(text, tempId);
      } else if (text.trim()) {
        lastComposerSubmissionRef.current = {
          kind: "queued",
          text: text.trim(),
          tempId,
        };
      }
      draftControlsRef.current?.confirmInputClear();
      revokeAttachmentPreviewUrls(currentAttachments);
      setCorrectionDraft(null);
      clearQuoteAnchors();
      completeBeaconSubmission(
        result.deferred === false || result.promoted ? "delivered" : "queued",
      );
      return true;
    } catch (err) {
      // As in send: a message the stream already shows as delivered is not
      // undone by a failed response. Look only when the request may have
      // reached the server (no HTTP refusal, no upload failure), since a
      // match can also be an identical earlier message.
      if (
        !(err instanceof ComposerAttachmentUploadError) &&
        (err as { status?: number } | null)?.status === undefined &&
        isMessageDelivered({
          tempId,
          content: outgoingText,
          timestamp: new Date(clientTimestamp).toISOString(),
        })
      ) {
        rememberSentSubmission(text, tempId);
        draftControlsRef.current?.confirmInputClear();
        revokeAttachmentPreviewUrls(currentAttachments);
        setCorrectionDraft(null);
        clearQuoteAnchors();
        completeBeaconSubmission("delivered");
        return true;
      }
      console.error("Failed to queue deferred message:", err);
      let finalError: unknown = err;
      if (err instanceof ComposerAttachmentUploadError)
        currentAttachments = err.attachments;
      logSessionUiTrace("composer-deferred-error", {
        sessionId,
        tempId,
        message: err instanceof Error ? err.message : String(err),
      });

      if (shouldRetryWithResume(err, prepared.queuedCompact === true)) {
        try {
          const result = await api.resumeSession(
            projectId,
            sessionId,
            outgoingText,
            buildResumeOptions(getResumeSettings(prepared.thinking), {
              showThinking,
              provider: effectiveProvider,
              executor: session?.executor,
            }),
            uploadedAttachments.length > 0 ? uploadedAttachments : undefined,
            tempId,
            clientTimestamp,
            metadata,
          );
          logSessionUiTrace("composer-deferred-retry-resume-success", {
            sessionId,
            tempId,
            processId: result.processId,
          });
          setStatus({
            owner: "self",
            processId: result.processId,
            permissionMode: result.permissionMode,
            appliedPermissionMode: result.appliedPermissionMode,
            modeVersion: result.modeVersion,
            recapAfterSeconds: result.recapAfterSeconds,
          });
          rememberSentSubmission(text, tempId);
          draftControlsRef.current?.confirmInputClear();
          revokeAttachmentPreviewUrls(currentAttachments);
          setCorrectionDraft(null);
          clearQuoteAnchors();
          completeBeaconSubmission("delivered");
          return true;
        } catch (retryErr) {
          console.error("Failed to resume session:", retryErr);
          finalError = retryErr;
          logSessionUiTrace("composer-deferred-retry-resume-error", {
            sessionId,
            tempId,
            message:
              retryErr instanceof Error ? retryErr.message : String(retryErr),
          });
        }
      }

      draftControlsRef.current?.restoreFromStorage();
      setComposerAttachments(currentAttachments, { persistDraft: false });
      completeBeaconSubmission("error");
      // A routed session cannot hand off yet, so offer no handoff modal.
      const notice = finalFailureNotice({
        finalError,
        provider: effectiveProvider,
        routedSession,
        path: "queue",
        t,
      });
      if (notice.openHandoffDialog) setShowHandoffModal(true);
      showToast(notice.message, "error");
      return false;
    }
  };

  const queueComposerForProject = async (
    text: string,
    targetType: "existing-session" | "new-session",
    metadata?: MessageSubmissionMetadata,
    newSessionTarget?: ChosenNewSessionQueueTarget,
  ) => {
    const command = resolveProjectQueueCommand({
      text,
      targetType,
      rewindSupported: supportsRewind,
      fileViewSupported: supportsFileViewCommand,
      attachmentCount: attachmentsRef.current.length,
      pendingUploadCount: pendingUploadsRef.current.size,
      t,
    });
    if (command.kind === "refuse") {
      draftControlsRef.current?.setDraft(text);
      showToast(command.message, "error");
      return;
    }
    const yaCommand =
      command.kind === "queueable" ? command.yaCommand : undefined;
    const prepared: PreparedComposerSubmission | null =
      command.kind === "queueable"
        ? command.prepared
        : prepareComposerSubmission(text);
    if (!prepared) {
      return;
    }
    const plan = planProjectQueue({
      prepared,
      metadata,
      targetType,
      newSessionTarget,
      projectId,
      provider: effectiveProvider,
      sessionModel: session?.model,
      defaultModel: getModelSetting,
      version: versionInfo,
      attachmentCount: attachmentsRef.current.length,
    });
    if (plan.refuseAttachmentOnly) {
      showToast(t("attachmentOnlyRequiresServerUpdate"), "error");
      return;
    }
    metadata = plan.metadata;
    const { outgoingText, slashCommand } = prepared;
    const thinking = prepared.thinking ?? getImplicitComposerThinking();
    const showThinking = getShowThinkingSetting();
    const actionAtMs = Date.now();
    const clientTimestamp = getServerClockTimestamp(actionAtMs);
    // Queuing to this session orders the sidebar like sending to it.
    if (targetType === "existing-session") {
      recordSessionInteraction(
        sourceRuntime.sourceKey,
        actualSessionId,
        actionAtMs,
      );
    }
    const {
      queueProjectId,
      newSessionProvider,
      keepsProvider,
      newSessionModel,
      canonicalCreation,
    } = plan;
    if (canonicalCreation && !creationPrincipalResolved) {
      draftControlsRef.current?.restoreFromStorage();
      return;
    }
    const creationView = captureCreationView();
    let acceptedInput = canonicalCreation
      ? draftControlsRef.current?.captureSubmission?.()
      : undefined;
    const originalAttachments = [...attachmentsRef.current];
    let currentAttachments = [...originalAttachments];
    let submittedFileIds = originalAttachments.map((file) => file.id);
    let submittedAttachmentState = JSON.stringify(
      draftControlsRef.current?.getAttachmentState()?.refs ?? [],
    );
    let uploadedAttachments: UploadedFile[] = [];
    let stagedAttachments: ProjectQueueStagedAttachments | undefined;

    try {
      currentAttachments = await collectComposerAttachmentsForSubmission({
        detach: !canonicalCreation,
      });
      if (canonicalCreation && !ownsCreationView(creationView)) return;
      if (targetType === "new-session") {
        const selected = currentAttachments;
        currentAttachments = await stageComposerAttachmentsForNewSession({
          attachments: currentAttachments,
          sourceTransport,
          sourceProjectId: projectId,
        });
        if (canonicalCreation) {
          if (!ownsCreationView(creationView)) return;
          const replacements = new Map(
            selected.map((file, index) => [
              file.id,
              currentAttachments[index]!,
            ]),
          );
          setComposerAttachments((current) =>
            current.map((file) => replacements.get(file.id) ?? file),
          );
          submittedFileIds = currentAttachments.map((file) => file.id);
          submittedAttachmentState = JSON.stringify(
            draftControlsRef.current?.getAttachmentState()?.refs ?? [],
          );
          if (
            !pendingUploadsRef.current.size &&
            draftControlsRef.current?.getDraft() === acceptedInput?.text &&
            attachmentsRef.current.map((file) => file.id).join("\0") ===
              submittedFileIds.join("\0")
          )
            acceptedInput = draftControlsRef.current?.captureSubmission?.();
        }
      }
      if (plan.startsNow) {
        const options = {
          mode: permissionMode,
          model: newSessionModel,
          thinking: keepsProvider ? thinking : prepared.thinking,
          showThinking,
          provider: newSessionProvider,
          executor: keepsProvider ? session?.executor : undefined,
        };
        const messageMetadata = {
          ...metadata,
          deliveryIntent: "direct" as const,
        };
        if (canonicalCreation && !ownsCreationView(creationView)) return;
        const started = canonicalCreation
          ? await acceptSessionCreation(
              sourceTransport,
              creationKey,
              queueProjectId,
              outgoingText,
              options,
              clientTimestamp,
              { ...messageMetadata, deliveryIntent: "direct" },
              acceptedInput?.draftText ?? text,
              currentAttachments.length
                ? currentAttachments.map((file) => {
                    if (!isComposerStagedAttachment(file))
                      throw new Error(
                        "New session files must be staged before admission",
                      );
                    return toPersistedStagedAttachmentRef(file);
                  })
                : undefined,
              submittedAttachmentState,
              submittedFileIds,
            )
          : await createLegacySession({
              version: versionInfo,
              api,
              projectId: queueProjectId,
              message: outgoingText,
              options,
              clientTimestamp,
              metadata: { ...messageMetadata, deliveryIntent: "direct" },
              materialize: currentAttachments.length
                ? (projectId, sessionId) =>
                    materializeComposerAttachmentsForSubmission({
                      attachments: currentAttachments,
                      sourceTransport,
                      projectId,
                      sessionId,
                    })
                : undefined,
            });
        if (canonicalCreation) {
          if (!ownsCreationView(creationView)) return;
          const unchangedAttachments =
            !pendingUploadsRef.current.size &&
            attachmentsRef.current.map((file) => file.id).join("\0") ===
              submittedFileIds.join("\0");
          const cleared =
            unchangedAttachments && (acceptedInput?.confirm() ?? false);
          if ("requestId" in started) {
            if (cleared) {
              settleSessionCreation(creationKey, started.requestId);
              setComposerAttachments([], { persistDraft: false });
            }
            if (!cleared) {
              setCreationRecovery({
                key: creationKey,
                requestId: started.requestId,
                accepted: true,
              });
              return;
            }
          }
        } else draftControlsRef.current?.confirmInputClear();
        revokeAttachmentPreviewUrls(currentAttachments);
        setCorrectionDraft(null);
        clearQuoteAnchors();
        navigate(
          `${basePath}/projects/${started.projectId}/sessions/${started.sessionId}`,
          {
            state: createSessionNavigationState({
              initialStatus:
                "processId" in started
                  ? {
                      owner: "self",
                      processId: started.processId,
                      permissionMode: started.permissionMode,
                      appliedPermissionMode: started.appliedPermissionMode,
                      modeVersion: started.modeVersion,
                      recapAfterSeconds: started.recapAfterSeconds,
                    }
                  : undefined,
              initialTitle: outgoingText,
              initialModel: newSessionModel,
              initialProvider: newSessionProvider,
            }),
          },
        );
        return;
      }
      if (targetType === "new-session") {
        const splitAttachments =
          splitComposerAttachmentsForSubmission(currentAttachments);
        uploadedAttachments = splitAttachments.uploadedFiles;
        stagedAttachments = splitAttachments.draftState ?? undefined;
      } else {
        uploadedAttachments =
          await materializeComposerAttachments(currentAttachments);
      }
      logSessionUiTrace("composer-project-queue-start", {
        sessionId,
        projectId: queueProjectId,
        targetType,
        permissionMode,
        thinking,
        slashCommand: slashCommand ?? null,
        textLength: outgoingText.length,
        attachmentCount: currentAttachments.length,
        clientTimestamp,
        serverOffsetMs: getEstimatedServerOffsetMs(),
      });
      const requestSentAtMs = Date.now();
      const response = await api.createProjectQueueItem(queueProjectId, {
        target:
          targetType === "new-session"
            ? {
                type: "new-session",
                mode: permissionMode,
                model: newSessionModel,
                thinking: keepsProvider ? thinking : prepared.thinking,
                showThinking,
                provider: newSessionProvider,
                executor: keepsProvider ? session?.executor : undefined,
                title: outgoingText,
              }
            : {
                type: "existing-session",
                sessionId,
                ...getResumeSettings(prepared.thinking),
                showThinking,
                provider: effectiveProvider,
                executor: session?.executor,
              },
        message: {
          text: outgoingText,
          mode:
            targetType === "new-session"
              ? permissionMode
              : getResumeSettings(prepared.thinking).mode,
          ...(yaCommand ? { yaCommand } : {}),
          ...(uploadedAttachments.length > 0
            ? { attachments: uploadedAttachments }
            : {}),
          ...(stagedAttachments ? { stagedAttachments } : {}),
          metadata: {
            ...metadata,
            deliveryIntent: "deferred",
            clientTimestamp,
          },
        },
        createdFrom: {
          sessionId,
          client: "toolbar",
        },
      });
      sourceSummary.reportProjectQueueCollectionSnapshot(response.queue);
      logSessionUiTrace("composer-project-queue-result", {
        sessionId,
        projectId: queueProjectId,
        targetType,
        uploadWaitMs: requestSentAtMs - actionAtMs,
      });
      draftControlsRef.current?.confirmInputClear();
      revokeAttachmentPreviewUrls(currentAttachments);
      setCorrectionDraft(null);
      clearQuoteAnchors();
      showToast(
        projectQueueQueuedMessage({
          targetType,
          queueProjectId,
          projectId,
          projectName: newSessionTarget?.projectName,
          t,
        }),
        "success",
      );
    } catch (err) {
      console.error("Failed to queue Project Queue message:", err);
      if (err instanceof ComposerAttachmentUploadError)
        currentAttachments = err.attachments;
      logSessionUiTrace("composer-project-queue-error", {
        sessionId,
        projectId,
        targetType,
        message: err instanceof Error ? err.message : String(err),
      });
      if (canonicalCreation) {
        if (!ownsCreationView(creationView)) return;
        const pending = pendingSessionCreation(creationKey);
        if (pending)
          setCreationRecovery({
            key: creationKey,
            requestId: pending.requestId,
          });
        if (!draftControlsRef.current?.getDraft())
          draftControlsRef.current?.restoreFromStorage();
      } else {
        draftControlsRef.current?.restoreFromStorage();
        setComposerAttachments(currentAttachments, { persistDraft: false });
      }
      const errorMsg = err instanceof Error ? err.message : String(err);
      showToast(
        newSessionTarget?.delivery === "now"
          ? `${t("newSessionStartError")}: ${errorMsg}`
          : t("projectQueueSubmitFailed", { message: errorMsg }),
        "error",
      );
    }
  };

  return {
    handleSend,
    handleQueue,
    queueComposerForProject,
  };
}
