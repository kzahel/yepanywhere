import { type ComponentProps, lazy, Suspense } from "react";
import { loadMessageInputModule } from "../lib/sessionRouteModules";
import { SessionRouteModuleFallback } from "./SessionRouteModuleFallback";
import { useToastContext } from "../contexts/ToastContext";
import { useI18n } from "../i18n";
import {
  getSessionCreation,
  pendingSessionCreation,
  settleSessionCreation,
} from "../lib/sessionCreation";
import styles from "../pages/SessionPage.module.css";
import { BtwAsideStickyCards } from "./BtwAsideStickyCards";
import { MessageInputToolbar } from "./MessageInputToolbar";
import { QuestionAnswerPanel } from "./QuestionAnswerPanel";
import { QuestionAsideCard } from "./QuestionAsideCard";
import { ToolApprovalPanel } from "./ToolApprovalPanel";
import { Button } from "./ui/Button";
import { isSessionCreationPending } from "@yep-anywhere/shared";
import type { useBtwAsides } from "../hooks/useBtwAsides";
import type { DraftControls } from "../hooks/useDraftPersistence";
import type { useProject } from "../hooks/useProjects";
import type { useQuestionAside } from "../hooks/useQuestionAside";
import type { useQuestionAsideSetting } from "../hooks/useQuestionAsideSetting";
import type { useRemoteBasePath } from "../hooks/useRemoteBasePath";
import type { useSession } from "../hooks/useSession";
import type { useSessionAttachmentUploads } from "../hooks/useSessionAttachmentUploads";
import type { useSessionBangCommands } from "../hooks/useSessionBangCommands";
import type { useSessionForkActions } from "../hooks/useSessionForkActions";
import type { useSessionQueuedMessageActions } from "../hooks/useSessionQueuedMessageActions";
import type { useSessionSpeechVocabulary } from "../hooks/useSessionSpeechVocabulary";
import type { useSessionThinkingSelection } from "../hooks/useSessionThinkingSelection";
import type { useSessionTranscriptJumps } from "../hooks/useSessionTranscriptJumps";
import type { ClientSummarySourceKey } from "../lib/clientSourceIdentity";
import type { useProviderRuntimeStatusForSession } from "../lib/clientSummaryStore";
import type { DraftTextChangeMetadata } from "../lib/commentAnchors";
import type { ComposerAttachment } from "../lib/sessionComposerAttachments";
import type { SessionConnectionBarStatus } from "../lib/sessionConnectionBar";
import type { SessionModelConfig } from "../lib/sessionModelConfig";
import type { TranscriptPositionStore } from "../lib/transcriptPositionStore";
import type { SourceTransport } from "../lib/transport/types";
import type { MessageSubmissionMetadata } from "../types/messageSubmission";
import type { FullPaneComposerControls, UploadProgress } from "./MessageInput";
import type {
  ChosenNewSessionQueueTarget,
  NewSessionQueueTarget,
} from "./NewSessionQueueOptions";
import type { VoiceInputButtonRef } from "./VoiceInputButton";
import type {
  EffortLevel,
  FileViewLineTarget,
  PermissionMode,
  ProviderName,
  SlashCommand,
  ThinkingMode,
  UserQuestionAnswers,
} from "@yep-anywhere/shared";
import type { RenderItem } from "@yep-anywhere/shared/transcript/items";
import type { Dispatch, RefObject, SetStateAction } from "react";
import type { useNavigate } from "react-router-dom";

const LazyMessageInput = lazy(() =>
  loadMessageInputModule().then(({ MessageInput }) => ({
    default: MessageInput,
  })),
);

function MessageInput(props: ComponentProps<typeof LazyMessageInput>) {
  return (
    <Suspense fallback={<SessionRouteModuleFallback label="loading" />}>
      <LazyMessageInput {...props} />
    </Suspense>
  );
}

export interface SessionComposerFooterProps {
  activityAt: string | null;
  activityRenderItems: RenderItem[];
  actualSessionId: ReturnType<typeof useSession>["actualSessionId"];
  allSlashCommands: SlashCommand[];
  approvalCollapsed: boolean;
  attachments: ComposerAttachment[];
  attachmentsRef: RefObject<ComposerAttachment[]>;
  basePath: ReturnType<typeof useRemoteBasePath>;
  beginForkAfterInitialTurn: ReturnType<
    typeof useSessionForkActions
  >["beginForkAfterInitialTurn"];
  btwToolbarMode: ReturnType<typeof useBtwAsides>["btwToolbarMode"];
  canStopOwnedProcess: boolean;
  captureCreationView: () => {
    key: string;
    href: string;
    // biome-ignore lint/suspicious/noExplicitAny: the page infers `any` from `history.state.idx`.
    historyIndex: any;
    activation: number | undefined;
  };
  childSessionParentHref: ReturnType<
    typeof useBtwAsides
  >["childSessionParentHref"];
  codexPermissionModeChangePending: boolean;
  composerBangSupport: ReturnType<
    typeof useSessionBangCommands
  >["composerBangSupport"];
  composerStickyBtwAsides: ReturnType<
    typeof useBtwAsides
  >["composerStickyBtwAsides"];
  composerTurnRecall: ReturnType<
    typeof useSessionTranscriptJumps
  >["composerTurnRecall"];
  correctionDraft: {
    messageId: string;
    originalText: string;
    recalled?: boolean;
  } | null;
  creationKey: string;
  creationRecovery: {
    key: string;
    requestId: string;
    accepted?: boolean;
  } | null;
  dismissPromptSuggestion: ReturnType<
    typeof useSession
  >["dismissPromptSuggestion"];
  draftControlsRef: RefObject<DraftControls | null>;
  effectiveModelConfig: SessionModelConfig | null;
  effectiveProvider: ProviderName | undefined;
  fileViewCommandOptions: {
    open: (path: string, line?: FileViewLineTarget) => void;
  };
  focusedBtwAside: ReturnType<typeof useBtwAsides>["focusedBtwAside"];
  focusedBtwAsideId: ReturnType<typeof useBtwAsides>["focusedBtwAsideId"];
  forkSummaryDraft: ReturnType<
    typeof useSessionForkActions
  >["forkSummaryDraft"];
  generallySupportsSteering: boolean;
  handleAbort: () => Promise<void>;
  handleApprove: () => Promise<void>;
  handleApproveAcceptEdits: () => Promise<void>;
  handleAttach: ReturnType<typeof useSessionAttachmentUploads>["handleAttach"];
  handleBtwShortcut: ReturnType<typeof useBtwAsides>["handleBtwShortcut"];
  handleCancelCorrection: () => void;
  handleCancelLatestDeferred: ReturnType<
    typeof useSessionQueuedMessageActions
  >["handleCancelLatestDeferred"];
  handleComposerDraftTextChange: (
    draft: string,
    metadata: DraftTextChangeMetadata,
  ) => void;
  handleCustomCommand: (command: string, argument?: string) => boolean;
  handleDeny: () => Promise<void>;
  handleDenyWithFeedback: (feedback: string) => Promise<void>;
  handleDoneAction: () => void;
  handleDraftControlsReady: (controls: DraftControls) => void;
  handleFocusedBtwSend: (text: string, source?: "main" | "pane") => void;
  handleFullPaneControlsReady: (
    controls: FullPaneComposerControls | null,
  ) => void;
  handleProjectQueue: (
    text: string,
    metadata?: MessageSubmissionMetadata,
  ) => Promise<void>;
  handleProjectQueueNewSession: (
    text: string,
    metadata?: MessageSubmissionMetadata,
    target?: ChosenNewSessionQueueTarget,
  ) => Promise<void>;
  handleQuestionSubmit: (answers: UserQuestionAnswers) => Promise<void>;
  handleRecallLastSubmission: () => boolean;
  handleRemoveAttachment: ReturnType<
    typeof useSessionAttachmentUploads
  >["handleRemoveAttachment"];
  handleSemanticComposerDefer: (
    text: string,
    metadata?: MessageSubmissionMetadata,
  ) => Promise<void>;
  handleSemanticComposerSend: (
    text: string,
    metadata?: MessageSubmissionMetadata,
  ) => Promise<boolean>;
  handleSetLiveThinkingEffort: (effortLevel: EffortLevel) => void;
  handleSetLiveThinkingMode: (mode: ThinkingMode) => void;
  handleStopBtwAside: ReturnType<typeof useBtwAsides>["handleStopBtwAside"];
  handleToolbarSlashCommand: (command: SlashCommand) => void;
  hideBtwAside: ReturnType<typeof useBtwAsides>["hideBtwAside"];
  isAskUserQuestion: boolean;
  liveBadgeModel: string | undefined;
  liveThinkingSelection: ReturnType<
    typeof useSessionThinkingSelection
  >["selection"];
  mainComposerForAside: ReturnType<typeof useBtwAsides>["mainComposerForAside"];
  navigate: ReturnType<typeof useNavigate>;
  ownsCreationView: (
    token: ReturnType<SessionComposerFooterProps["captureCreationView"]>,
  ) => boolean;
  pendingInputRequest: ReturnType<typeof useSession>["pendingInputRequest"];
  pendingUploadsRef: RefObject<Map<string, Promise<ComposerAttachment | null>>>;
  permissionMode: PermissionMode;
  primaryComposerAction: "steer" | "queue" | "send";
  processState: ReturnType<typeof useSession>["processState"];
  project: ReturnType<typeof useProject>["project"];
  projectId: string;
  projectQueueNewSessionTarget: NewSessionQueueTarget;
  promptSuggestion: ReturnType<typeof useSession>["promptSuggestion"];
  providerRuntimeStatus: ReturnType<typeof useProviderRuntimeStatusForSession>;
  questionAside: ReturnType<typeof useQuestionAside>;
  questionAsidesEnabled: ReturnType<
    typeof useQuestionAsideSetting
  >["questionAsidesEnabled"];
  session: ReturnType<typeof useSession>["session"];
  sessionConnectionStatus: SessionConnectionBarStatus;
  sessionDraftKey: string;
  sessionDraftReference: {
    sourceKey: ClientSummarySourceKey;
    sessionId: string;
  };
  sessionId: string;
  sessionLiveness: ReturnType<typeof useSession>["sessionLiveness"];
  setApprovalCollapsed: Dispatch<SetStateAction<boolean>>;
  setComposerAttachments: (
    updater:
      | ComposerAttachment[]
      | ((previous: readonly ComposerAttachment[]) => ComposerAttachment[]),
    options?: { persistDraft?: boolean; revokeRemovedPreviewUrls?: boolean },
  ) => void;
  setCreationRecovery: Dispatch<
    SetStateAction<{
      key: string;
      requestId: string;
      accepted?: boolean;
    } | null>
  >;
  setFocusedBtwAsideId: ReturnType<typeof useBtwAsides>["setFocusedBtwAsideId"];
  setForkSummaryDraft: ReturnType<
    typeof useSessionForkActions
  >["setForkSummaryDraft"];
  setPermissionMode: ReturnType<typeof useSession>["setPermissionMode"];
  setProjectAppVoice: Dispatch<SetStateAction<VoiceInputButtonRef | null>>;
  shouldDeferMessages: boolean;
  showProjectQueueAction: boolean;
  sourceTransport: SourceTransport;
  speechVocabulary: ReturnType<typeof useSessionSpeechVocabulary>;
  status: ReturnType<typeof useSession>["status"];
  steerNowDefault: boolean;
  stickyBtwAsides: ReturnType<typeof useBtwAsides>["stickyBtwAsides"];
  submitForkAfterSummary: ReturnType<
    typeof useSessionForkActions
  >["submitForkAfterSummary"];
  submitForkAfterWithoutSummary: ReturnType<
    typeof useSessionForkActions
  >["submitForkAfterWithoutSummary"];
  supportsBtwAsides: ReturnType<typeof useBtwAsides>["supportsBtwAsides"];
  supportsFileViewCommand: boolean;
  supportsForkFromTurn: boolean;
  supportsPermissionMode: boolean;
  supportsSteerNow: boolean;
  supportsThinkingToggle: boolean;
  syntheticDoneEnabled: boolean;
  toggleBtwAsideExpanded: ReturnType<
    typeof useBtwAsides
  >["toggleBtwAsideExpanded"];
  transcriptPositionStore: TranscriptPositionStore;
  transferBtwTurnToMotherComposer: (text: string) => void;
  uploadAttachedFiles: ReturnType<
    typeof useSessionAttachmentUploads
  >["uploadAttachedFiles"];
  uploadProgress: UploadProgress[];
}

/**
 * The session page's composer footer: the creation recovery notice, the
 * connection bar, the btw sticky cards, the question and tool approval
 * panels with the approval toolbar, the question aside card, and the
 * composer itself.
 * Moved verbatim from `SessionPage.tsx`
 * (docs/tactical/182-session-page-header-and-footer.md slice 5).
 */
export function SessionComposerFooter({
  activityAt,
  activityRenderItems,
  actualSessionId,
  allSlashCommands,
  approvalCollapsed,
  attachments,
  attachmentsRef,
  basePath,
  beginForkAfterInitialTurn,
  btwToolbarMode,
  canStopOwnedProcess,
  captureCreationView,
  childSessionParentHref,
  codexPermissionModeChangePending,
  composerBangSupport,
  composerStickyBtwAsides,
  composerTurnRecall,
  correctionDraft,
  creationKey,
  creationRecovery,
  dismissPromptSuggestion,
  draftControlsRef,
  effectiveModelConfig,
  effectiveProvider,
  fileViewCommandOptions,
  focusedBtwAside,
  focusedBtwAsideId,
  forkSummaryDraft,
  generallySupportsSteering,
  handleAbort,
  handleApprove,
  handleApproveAcceptEdits,
  handleAttach,
  handleBtwShortcut,
  handleCancelCorrection,
  handleCancelLatestDeferred,
  handleComposerDraftTextChange,
  handleCustomCommand,
  handleDeny,
  handleDenyWithFeedback,
  handleDoneAction,
  handleDraftControlsReady,
  handleFocusedBtwSend,
  handleFullPaneControlsReady,
  handleProjectQueue,
  handleProjectQueueNewSession,
  handleQuestionSubmit,
  handleRecallLastSubmission,
  handleRemoveAttachment,
  handleSemanticComposerDefer,
  handleSemanticComposerSend,
  handleSetLiveThinkingEffort,
  handleSetLiveThinkingMode,
  handleStopBtwAside,
  handleToolbarSlashCommand,
  hideBtwAside,
  isAskUserQuestion,
  liveBadgeModel,
  liveThinkingSelection,
  mainComposerForAside,
  navigate,
  ownsCreationView,
  pendingInputRequest,
  pendingUploadsRef,
  permissionMode,
  primaryComposerAction,
  processState,
  project,
  projectId,
  projectQueueNewSessionTarget,
  promptSuggestion,
  providerRuntimeStatus,
  questionAside,
  questionAsidesEnabled,
  session,
  sessionConnectionStatus,
  sessionDraftKey,
  sessionDraftReference,
  sessionId,
  sessionLiveness,
  setApprovalCollapsed,
  setComposerAttachments,
  setCreationRecovery,
  setFocusedBtwAsideId,
  setForkSummaryDraft,
  setPermissionMode,
  setProjectAppVoice,
  shouldDeferMessages,
  showProjectQueueAction,
  sourceTransport,
  speechVocabulary,
  status,
  steerNowDefault,
  stickyBtwAsides,
  submitForkAfterSummary,
  submitForkAfterWithoutSummary,
  supportsBtwAsides,
  supportsFileViewCommand,
  supportsForkFromTurn,
  supportsPermissionMode,
  supportsSteerNow,
  supportsThinkingToggle,
  syntheticDoneEnabled,
  toggleBtwAsideExpanded,
  transcriptPositionStore,
  transferBtwTurnToMotherComposer,
  uploadAttachedFiles,
  uploadProgress,
}: SessionComposerFooterProps) {
  const { t } = useI18n();
  const { showToast } = useToastContext();
  return (
    <footer className={`${styles.input} session-input`}>
      {creationRecovery?.key === creationKey && (
        <div role="status" className={styles.creationRecovery}>
          <span>
            {t(
              creationRecovery.accepted
                ? "sessionCreationSavedWhileAway"
                : "sessionCreationUnconfirmedRequest",
            )}
          </span>
          <Button
            variant="ghost"
            size="small"
            onClick={async () => {
              const view = captureCreationView();
              const pending = pendingSessionCreation(creationKey);
              if (!pending) return;
              const controls = draftControlsRef.current;
              const filesMatch =
                !pendingUploadsRef.current.size &&
                attachmentsRef.current.map((file) => file.id).join("\0") ===
                  (pending.draftFileIds ?? []).join("\0");
              const draftMatches =
                filesMatch &&
                controls?.getDraft() === pending.draftText &&
                JSON.stringify(controls?.getAttachmentState()?.refs ?? []) ===
                  (pending.draftAttachments ?? "[]");
              const captured = draftMatches
                ? controls?.captureSubmission?.()
                : undefined;
              try {
                const receipt = await getSessionCreation(
                  sourceTransport,
                  creationRecovery.requestId,
                );
                if (!ownsCreationView(view)) return;
                const stillMatches =
                  !pendingUploadsRef.current.size &&
                  attachmentsRef.current.map((file) => file.id).join("\0") ===
                    (pending.draftFileIds ?? []).join("\0") &&
                  controls?.getDraft() === pending.draftText &&
                  JSON.stringify(controls?.getAttachmentState()?.refs ?? []) ===
                    (pending.draftAttachments ?? "[]");
                const cleared = stillMatches && (captured?.confirm() ?? false);
                if (cleared)
                  setComposerAttachments([], {
                    persistDraft: false,
                    revokeRemovedPreviewUrls: true,
                  });
                if (cleared || !stillMatches) {
                  settleSessionCreation(creationKey, receipt.requestId);
                  setCreationRecovery(null);
                }
                navigate(
                  `${basePath}/projects/${receipt.projectId}/sessions/${receipt.sessionId}`,
                );
              } catch (error) {
                showToast(
                  error instanceof Error ? error.message : String(error),
                  "error",
                );
              }
            }}
          >
            {t("sessionCreationOpenSaved")}
          </Button>
        </div>
      )}
      <div
        className={`session-connection-bar session-connection-${sessionConnectionStatus}`}
      />
      <div data-selection-actions-mobile-slot />
      <div className="session-input-inner">
        <BtwAsideStickyCards
          asides={composerStickyBtwAsides}
          focusedAsideId={focusedBtwAsideId}
          onFocusAside={setFocusedBtwAsideId}
          onToggleAsideExpanded={toggleBtwAsideExpanded}
          onDoneAside={hideBtwAside}
          onHideAside={hideBtwAside}
          onStopAside={(asideId) => void handleStopBtwAside(asideId)}
          onTransferToComposer={transferBtwTurnToMotherComposer}
        />

        {/* User question panel */}
        {pendingInputRequest &&
          pendingInputRequest.sessionId === actualSessionId &&
          isAskUserQuestion && (
            <QuestionAnswerPanel
              request={pendingInputRequest}
              sessionId={actualSessionId}
              onSubmit={handleQuestionSubmit}
              onDeny={handleDeny}
            />
          )}

        {/* Tool approval: show panel + always-visible toolbar */}
        {pendingInputRequest &&
          pendingInputRequest.sessionId === actualSessionId &&
          !isAskUserQuestion && (
            <>
              <ToolApprovalPanel
                request={pendingInputRequest}
                sessionId={actualSessionId}
                onApprove={handleApprove}
                onDeny={handleDeny}
                onApproveAcceptEdits={handleApproveAcceptEdits}
                onDenyWithFeedback={handleDenyWithFeedback}
                collapsed={approvalCollapsed}
                onCollapsedChange={setApprovalCollapsed}
                projectPath={project?.path ?? null}
              />
              <MessageInputToolbar
                sessionId={actualSessionId}
                mode={permissionMode}
                onModeChange={setPermissionMode}
                modeChangesApplyNextTurn={
                  effectiveProvider === "codex" && shouldDeferMessages
                }
                modeChangePending={codexPermissionModeChangePending}
                supportsPermissionMode={supportsPermissionMode}
                supportsThinkingToggle={supportsThinkingToggle}
                slashCommands={allSlashCommands}
                onSelectSlashCommand={handleToolbarSlashCommand}
                thinkingProvider={effectiveProvider}
                thinkingModel={liveBadgeModel}
                liveThinkingSelection={
                  liveThinkingSelection
                    ? {
                        mode: liveThinkingSelection.mode,
                        level: liveThinkingSelection.effortLevel,
                        onSetMode: handleSetLiveThinkingMode,
                        onSetEffort: handleSetLiveThinkingEffort,
                      }
                    : undefined
                }
                contextRequestedModel={effectiveModelConfig?.requestedModel}
                contextUsage={session?.contextUsage}
                lastActivityAt={activityAt}
                positionTimestampStore={transcriptPositionStore}
                sessionLiveness={sessionLiveness}
                providerRuntimeStatus={providerRuntimeStatus}
                isRunning={status.owner === "self"}
                isThinking={canStopOwnedProcess}
                onStop={handleAbort}
                onDone={
                  syntheticDoneEnabled || mainComposerForAside
                    ? handleDoneAction
                    : undefined
                }
                doneTitle={
                  mainComposerForAside ? t("btwAsideDoneTitle") : undefined
                }
                pendingApproval={
                  approvalCollapsed
                    ? {
                        type: "tool-approval",
                        onExpand: () => setApprovalCollapsed(false),
                      }
                    : undefined
                }
              />
            </>
          )}

        {questionAside.aside && (
          <QuestionAsideCard
            {...questionAside.aside}
            onSave={() => {
              void questionAside.save();
            }}
            onDiscard={questionAside.discard}
            onSteer={() => {
              void questionAside.steer();
            }}
            onContinueAsBtw={() => {
              void questionAside.continueAsBtw();
            }}
          />
        )}

        {/* No pending approval: show full message input */}
        {!(
          pendingInputRequest &&
          pendingInputRequest.sessionId === actualSessionId &&
          !isAskUserQuestion
        ) && (
          <MessageInput
            onVoiceControl={setProjectAppVoice}
            questionAside={
              !mainComposerForAside && !forkSummaryDraft
                ? {
                    canAsk:
                      questionAsidesEnabled &&
                      supportsBtwAsides &&
                      !questionAside.aside &&
                      (processState === "in-turn" ||
                        processState === "waiting-input"),
                    onAsk: (rawText) =>
                      (processState === "in-turn" ||
                        processState === "waiting-input") &&
                      questionAside.ask(rawText),
                    onSave:
                      questionAside.aside?.status === "complete"
                        ? () => {
                            void questionAside.save();
                          }
                        : undefined,
                    onDismiss: questionAside.aside
                      ? questionAside.discard
                      : undefined,
                  }
                : undefined
            }
            completionRenderItems={activityRenderItems}
            speechVocabulary={speechVocabulary}
            onSend={
              mainComposerForAside
                ? (text) => handleFocusedBtwSend(text, "main")
                : primaryComposerAction === "steer"
                  ? handleSemanticComposerSend
                  : shouldDeferMessages
                    ? handleSemanticComposerDefer
                    : handleSemanticComposerSend
            }
            onQueue={
              !mainComposerForAside && shouldDeferMessages
                ? handleSemanticComposerDefer
                : undefined
            }
            onProjectQueue={
              !mainComposerForAside && showProjectQueueAction
                ? handleProjectQueue
                : undefined
            }
            onProjectQueueNewSession={
              !mainComposerForAside && effectiveProvider
                ? handleProjectQueueNewSession
                : undefined
            }
            projectQueueNewSessionTarget={projectQueueNewSessionTarget}
            primaryActionKind={
              mainComposerForAside ? "send" : primaryComposerAction
            }
            disabled={isSessionCreationPending(session?.creation)}
            placeholder={
              isSessionCreationPending(session?.creation)
                ? t(
                    session?.creation?.state === "failed" ||
                      session?.creation?.state === "uncertain"
                      ? "sessionCreationBlocked"
                      : session?.creation?.state === "queued"
                        ? "sessionCreationQueueProgress"
                        : "sessionCreationProgress",
                  )
                : mainComposerForAside
                  ? "/btw follow-up"
                  : status.owner === "external"
                    ? t("sessionPlaceholderExternal")
                    : processState === "idle"
                      ? shouldDeferMessages
                        ? t("sessionPlaceholderQueue")
                        : t("sessionPlaceholderResume")
                      : t("sessionPlaceholderQueue")
            }
            mode={permissionMode}
            onModeChange={setPermissionMode}
            modeChangesApplyNextTurn={
              effectiveProvider === "codex" && shouldDeferMessages
            }
            modeChangePending={codexPermissionModeChangePending}
            supportsPermissionMode={supportsPermissionMode}
            supportsThinkingToggle={supportsThinkingToggle}
            supportsSteering={generallySupportsSteering}
            supportsSteerNow={supportsSteerNow}
            steerNowDefault={steerNowDefault}
            isRunning={status.owner === "self"}
            isThinking={canStopOwnedProcess}
            onStop={handleAbort}
            onDone={
              syntheticDoneEnabled || mainComposerForAside
                ? handleDoneAction
                : undefined
            }
            doneTitle={
              mainComposerForAside ? t("btwAsideDoneTitle") : undefined
            }
            draftKey={
              mainComposerForAside && focusedBtwAside
                ? `draft-btw-${focusedBtwAside.sessionId ?? focusedBtwAside.id}`
                : sessionDraftKey
            }
            draftIndex={
              mainComposerForAside && focusedBtwAside
                ? undefined
                : sessionDraftReference
            }
            onDraftControlsReady={handleDraftControlsReady}
            onDraftTextChange={handleComposerDraftTextChange}
            bangSupport={mainComposerForAside ? undefined : composerBangSupport}
            turnRecall={composerTurnRecall}
            correctionActive={!mainComposerForAside && correctionDraft !== null}
            onCancelCorrection={
              mainComposerForAside ? undefined : handleCancelCorrection
            }
            onRecallLastSubmission={handleRecallLastSubmission}
            onCancelLatestDeferred={handleCancelLatestDeferred}
            collapsed={
              !!(
                pendingInputRequest &&
                pendingInputRequest.sessionId === actualSessionId
              )
            }
            onFullPaneControlsReady={handleFullPaneControlsReady}
            contextUsage={session?.contextUsage}
            lastActivityAt={activityAt}
            positionTimestampStore={transcriptPositionStore}
            sessionLiveness={sessionLiveness}
            providerRuntimeStatus={providerRuntimeStatus}
            projectId={projectId}
            sessionId={sessionId}
            attachments={mainComposerForAside ? [] : attachments}
            onAttach={mainComposerForAside ? undefined : handleAttach}
            onAttachAudioMemo={
              mainComposerForAside
                ? undefined
                : async (file) => {
                    const uploaded = await uploadAttachedFiles([file]);
                    if (!uploaded[0])
                      throw new Error(t("audioMemoUploadFailed"));
                  }
            }
            onRemoveAttachment={
              mainComposerForAside ? undefined : handleRemoveAttachment
            }
            uploadProgress={mainComposerForAside ? [] : uploadProgress}
            slashCommands={allSlashCommands}
            onCustomCommand={handleCustomCommand}
            fileViewCommand={
              supportsFileViewCommand ? fileViewCommandOptions : undefined
            }
            onBtwShortcut={
              childSessionParentHref || supportsBtwAsides
                ? handleBtwShortcut
                : undefined
            }
            btwActive={!!mainComposerForAside || !!childSessionParentHref}
            btwHasAsides={
              stickyBtwAsides.length > 0 || !!childSessionParentHref
            }
            btwToolbarMode={btwToolbarMode}
            thinkingProvider={effectiveProvider}
            thinkingModel={liveBadgeModel}
            liveThinkingSelection={
              liveThinkingSelection
                ? {
                    mode: liveThinkingSelection.mode,
                    level: liveThinkingSelection.effortLevel,
                    onSetMode: handleSetLiveThinkingMode,
                    onSetEffort: handleSetLiveThinkingEffort,
                  }
                : undefined
            }
            contextRequestedModel={effectiveModelConfig?.requestedModel}
            promptSuggestion={
              mainComposerForAside ? undefined : (promptSuggestion ?? undefined)
            }
            onDismissPromptSuggestion={
              mainComposerForAside ? undefined : dismissPromptSuggestion
            }
            forkSummaryMode={
              !mainComposerForAside && forkSummaryDraft
                ? {
                    title: t("forkSummaryComposerTitle"),
                    description: t("forkSummaryComposerDescription"),
                    placeholder: t("forkSummaryComposerPlaceholder"),
                    submitLabel: t("forkSummarySubmit"),
                    tooltip: t("forkSummaryTooltip"),
                    icon: "⑂",
                    noSummarySubmitLabel: t("forkSummaryNoSummarySubmit"),
                    noSummaryTooltip: t("forkSummaryNoSummaryTooltip"),
                    noSummaryIcon: "↱",
                    // The composer fork mode is dismissed the moment we
                    // submit (generation backgrounds into the indicator),
                    // so it never sits in a submitting state.
                    submitting: false,
                    onCancel: () => setForkSummaryDraft(null),
                    onSubmit: (instructions) => {
                      void submitForkAfterSummary(
                        forkSummaryDraft.sourceMessageId,
                        instructions,
                      );
                    },
                    onSubmitWithoutSummary: (nextTurnText) => {
                      void submitForkAfterWithoutSummary(
                        forkSummaryDraft.sourceMessageId,
                        nextTurnText,
                      );
                    },
                  }
                : undefined
            }
            onForkSummaryShortcut={
              !mainComposerForAside && supportsForkFromTurn
                ? beginForkAfterInitialTurn
                : undefined
            }
          />
        )}
      </div>
    </footer>
  );
}
