import type { Dispatch, RefObject, SetStateAction } from "react";
import type { NavigateFunction } from "react-router-dom";
import type { SessionCreationReceipt } from "@yep-anywhere/shared";
import {
  createLegacySession,
  supportsSessionCreation,
} from "./legacySessionCreation";
import {
  acceptSessionCreation,
  settleSessionCreation,
} from "./sessionCreation";
import type { useComposerSpeechState } from "../hooks/useComposerSpeechState";
import type { ProjectAppTarget } from "../api/projectApp";
import { rememberComposerPrompt } from "./composerHistory";
import { SERVER_CAPABILITIES, serverHasCapability } from "@yep-anywhere/shared";
import { type SessionOptions, type UploadedFile, api } from "../api/client";
import type { useCurrentSourceRuntime } from "../contexts/SourceRuntimeContext";
import type { useToastContext } from "../contexts/ToastContext";
import type { useDraftPersistence } from "../hooks/useDraftPersistence";
import { getShowThinkingSetting } from "../hooks/useModelSettings";
import type { useNewSessionOptions } from "../hooks/useNewSessionOptions";
import {
  buildNewSessionStartOptions,
  buildProjectQueueNewSessionTarget,
  newSessionStartErrorMessage,
  planNewSessionProjectQueue,
  planNewSessionStart,
  projectQueueRefusalBeforeDefer,
} from "./newSessionStartDecisions";
import type { useI18n } from "../i18n";
import { getUiCreationProvenance } from "./sessionCreationProvenance";
import type { LaunchLock } from "./limitedLaunchLock";
import type { SetComposerAttachments } from "../hooks/useComposerDraftAttachments";
import {
  type ComposerAttachment,
  isComposerStagedAttachment,
  sameAttachmentIds,
  toPersistedStagedAttachmentRef,
} from "./sessionComposerAttachments";
import {
  resolvePromptSuggestionMode,
  resolveRecapMode,
  toThinkingOption,
} from "./newSessionOptions";
import { normalizeProjectInput } from "./newSessionProjects";
import { logSessionUiTrace } from "./diagnostics/uiTrace";
import {
  getEstimatedServerOffsetMs,
  getServerClockTimestamp,
} from "./serverClock";
import { createSessionNavigationState } from "./sessionNavigationState";
import { resolveDeliverySpeechPrefix } from "./speechMessagePrefix";
import type { useVersion } from "../hooks/useVersion";
import type { useSpeechCaptureSettings } from "../hooks/useSpeechCaptureSettings";
import type { useRecentSpeechAttribution } from "../hooks/useRecentSpeechAttribution";

export type PendingNewSessionSpeechDeliveryIntent =
  | "start"
  | "background"
  | "project-queue";

/** A launch (fork, handoff) the New Session form performs instead of a start. */
export interface NewSessionLaunch {
  draftKey: string;
  initialMessage: string;
  fixedProject?: boolean;
  allowAttachments?: boolean;
  allowProjectQueue?: boolean;
  /**
   * How the seeded message is offered. `editable` is an ordinary draft.
   * `muted` shows it dimmed, compact, and read-only: the launch composes
   * its own first turn — a fork copies the real transcript — so the draft
   * is context for the choice rather than something being sent.
   */
  composer?: "editable" | "muted";
  /** Start-control wording, for a launch whose verb is not "start session". */
  startLabel?: string;
  startingLabel?: string;
  /**
   * Withhold the provider and model pickers. A fork continues an existing
   * provider transcript, so changing either would not be a fork; offering
   * the choice would only invite a request the server refuses.
   */
  fixedProviderModel?: boolean;
  submit: (request: {
    message: string;
    options: SessionOptions;
    clientTimestamp: number;
  }) => Promise<void>;
}

/** A creation the server accepted while the form showed something newer. */
export type NewSessionAcceptedCreation = SessionCreationReceipt & {
  sourceKey: string;
  accountKey: string | null;
  background: boolean;
};

type NewSessionOptions = ReturnType<typeof useNewSessionOptions>;

/** The form's attachments as a start or a queue reads them. */
interface NewSessionAttachmentDeps {
  attachmentsRef: { readonly current: ComposerAttachment[] };
  pendingUploadsRef: {
    readonly current: Map<string, Promise<ComposerAttachment | null>>;
  };
  setComposerAttachments: SetComposerAttachments;
}
type RecentSpeechAttribution = ReturnType<typeof useRecentSpeechAttribution>;

/** The form values a start reads, under the names it reads them by. */
export interface NewSessionStartDeps extends NewSessionAttachmentDeps {
  basePath: string;
  canCreateDetached: boolean;
  canCreateInBackground: boolean;
  clientSummarySourceKey: string;
  composerMuted: boolean;
  consumeSpeechAttribution: RecentSpeechAttribution["consume"];
  creatingTemplateProject: boolean;
  creationViewOwner: {
    readonly current: {
      active: boolean;
      sourceKey: string;
      accountKey: string | null;
    };
  };
  deferSpeechDelivery: (
    intent: PendingNewSessionSpeechDeliveryIntent,
  ) => boolean;
  displayDefaultsPending: NewSessionOptions["displayDefaultsPending"];
  draftControls: ReturnType<typeof useDraftPersistence>[2];
  effectiveEffortLevel: NewSessionOptions["effectiveEffortLevel"];
  effectivePermissionMode: NewSessionOptions["effectivePermissionMode"];
  effectiveSandboxLevel: NewSessionOptions["effectiveSandboxLevel"];
  effectiveSandboxNetworkFirewall: NewSessionOptions["effectiveSandboxNetworkFirewall"];
  effectiveServiceTier: NewSessionOptions["effectiveServiceTier"];
  effectiveThinkingMode: NewSessionOptions["effectiveThinkingMode"];
  hasSelectedProviderModel: NewSessionOptions["hasSelectedProviderModel"];
  helperSideModel: NewSessionOptions["helperSideModel"];
  historyScope: string | null;
  isRecentSpeechAttribution: RecentSpeechAttribution["isRecent"];
  isStarting: boolean;
  launch: NewSessionLaunch | undefined;
  launchLock: LaunchLock;
  machineControlEligible: NewSessionOptions["machineControlEligible"];
  machineControlSelected: NewSessionOptions["machineControlSelected"];
  navigate: NavigateFunction;
  newSessionDraftKey: string;
  principal: { username: string | null };
  principalResolved: boolean;
  projectApp: ProjectAppTarget | undefined;
  projectInput: string;
  projectPending: boolean;
  recapAfterSeconds: NewSessionOptions["recapAfterSeconds"];
  resolvePendingAttachmentsForSession: (
    activeProjectId: string,
    sessionId: string,
  ) => Promise<UploadedFile[]>;
  resolveProjectIdForSubmission: (
    trimmedProjectInput: string,
    ownsSubmission?: () => boolean,
  ) => Promise<string | null>;
  routedModel: NewSessionOptions["routedModel"];
  routerAccountId: NewSessionOptions["routerAccountId"];
  routerClaudeAiConnectors: NewSessionOptions["routerClaudeAiConnectors"];
  routerPolicy: NewSessionOptions["routerPolicy"];
  routerSelection: NewSessionOptions["routerSelection"];
  routerThinking: NewSessionOptions["routerThinking"];
  selectedModel: NewSessionOptions["selectedModel"];
  selectedPromptSuggestionMode: NewSessionOptions["selectedPromptSuggestionMode"];
  selectedProvider: NewSessionOptions["selectedProvider"];
  selectedProviderInfo: NewSessionOptions["selectedProviderInfo"];
  selectedRecapMode: NewSessionOptions["selectedRecapMode"];
  serverCapabilitiesPending: boolean;
  setAcceptedCreation: Dispatch<
    SetStateAction<NewSessionAcceptedCreation | null>
  >;
  setAcceptingText: Dispatch<SetStateAction<boolean>>;
  setInterimTranscript: ReturnType<
    typeof useComposerSpeechState
  >["setInterimTranscript"];
  setIsStarting: Dispatch<SetStateAction<boolean>>;
  showToast: ReturnType<typeof useToastContext>["showToast"];
  sourceTransport: ReturnType<typeof useCurrentSourceRuntime>["transport"];
  speechMessagePrefix: ReturnType<
    typeof useSpeechCaptureSettings
  >["speechMessagePrefix"];
  supportsInstalledMachineControl: NewSessionOptions["supportsInstalledMachineControl"];
  supportsSessionSandboxing: NewSessionOptions["supportsSessionSandboxing"];
  t: ReturnType<typeof useI18n>["t"];
  templateProjectBusy: boolean;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  versionInfo: ReturnType<typeof useVersion>["version"];
}

/** The form values Project Queue reads, under the names it reads them by. */
export interface NewSessionQueueDeps extends NewSessionAttachmentDeps {
  clientSummarySourceKey: string;
  consumeSpeechAttribution: RecentSpeechAttribution["consume"];
  creatingTemplateProject: boolean;
  creationViewOwner: {
    readonly current: {
      active: boolean;
      sourceKey: string;
      accountKey: string | null;
    };
  };
  deferSpeechDelivery: (
    intent: PendingNewSessionSpeechDeliveryIntent,
  ) => boolean;
  displayDefaultsPending: NewSessionOptions["displayDefaultsPending"];
  draftControls: ReturnType<typeof useDraftPersistence>[2];
  effectivePermissionMode: NewSessionOptions["effectivePermissionMode"];
  effectiveSandboxLevel: NewSessionOptions["effectiveSandboxLevel"];
  effectiveSandboxNetworkFirewall: NewSessionOptions["effectiveSandboxNetworkFirewall"];
  hasSelectedProviderModel: NewSessionOptions["hasSelectedProviderModel"];
  isRecentSpeechAttribution: RecentSpeechAttribution["isRecent"];
  isStarting: boolean;
  launchLock: LaunchLock;
  machineControlQueueBlocked: NewSessionOptions["machineControlQueueBlocked"];
  principal: { username: string | null };
  projectInput: string;
  projectPending: boolean;
  resolveProjectIdForSubmission: (
    trimmedProjectInput: string,
    ownsSubmission?: () => boolean,
  ) => Promise<string | null>;
  effectiveServiceTier: NewSessionOptions["effectiveServiceTier"];
  routedModel: NewSessionOptions["routedModel"];
  routerAccountId: NewSessionOptions["routerAccountId"];
  routerClaudeAiConnectors: NewSessionOptions["routerClaudeAiConnectors"];
  routerPolicy: NewSessionOptions["routerPolicy"];
  routerSelection: NewSessionOptions["routerSelection"];
  routerThinking: NewSessionOptions["routerThinking"];
  selectedEffortLevel: NewSessionOptions["selectedEffortLevel"];
  selectedModel: NewSessionOptions["selectedModel"];
  selectedProvider: NewSessionOptions["selectedProvider"];
  selectedProviderInfo: NewSessionOptions["selectedProviderInfo"];
  selectedServiceTier: NewSessionOptions["selectedServiceTier"];
  selectedThinkingMode: NewSessionOptions["selectedThinkingMode"];
  setAcceptingText: Dispatch<SetStateAction<boolean>>;
  setInterimTranscript: ReturnType<
    typeof useComposerSpeechState
  >["setInterimTranscript"];
  setIsStarting: Dispatch<SetStateAction<boolean>>;
  showToast: ReturnType<typeof useToastContext>["showToast"];
  sourceSummary: ReturnType<typeof useCurrentSourceRuntime>["summary"];
  speechMessagePrefix: ReturnType<
    typeof useSpeechCaptureSettings
  >["speechMessagePrefix"];
  supportsSessionSandboxing: NewSessionOptions["supportsSessionSandboxing"];
  t: ReturnType<typeof useI18n>["t"];
  templateProjectBusy: boolean;
  versionInfo: ReturnType<typeof useVersion>["version"];
}

/**
 * Starts a session from the New Session form: the body of the form's
 * `handleStartSession`, moved unchanged (plan 180 slice 5). Returns true when
 * a session was created or accepted, as the audio memo path expects.
 */
export async function startNewSession(
  deps: NewSessionStartDeps,
  messageOverride?: unknown,
  speechTriggered = false,
  propagateFailure = false,
  background = false,
) {
  const {
    attachmentsRef,
    basePath,
    canCreateDetached,
    canCreateInBackground,
    clientSummarySourceKey,
    composerMuted,
    consumeSpeechAttribution,
    creatingTemplateProject,
    creationViewOwner,
    deferSpeechDelivery,
    displayDefaultsPending,
    draftControls,
    effectiveEffortLevel,
    effectivePermissionMode,
    effectiveSandboxLevel,
    effectiveSandboxNetworkFirewall,
    effectiveServiceTier,
    effectiveThinkingMode,
    hasSelectedProviderModel,
    helperSideModel,
    historyScope,
    isRecentSpeechAttribution,
    isStarting,
    launch,
    launchLock,
    machineControlEligible,
    machineControlSelected,
    navigate,
    newSessionDraftKey,
    pendingUploadsRef,
    principal,
    principalResolved,
    projectApp,
    projectInput,
    projectPending,
    recapAfterSeconds,
    resolvePendingAttachmentsForSession,
    resolveProjectIdForSubmission,
    routedModel,
    routerAccountId,
    routerClaudeAiConnectors,
    routerPolicy,
    routerSelection,
    routerThinking,
    selectedModel,
    selectedPromptSuggestionMode,
    selectedProvider,
    selectedProviderInfo,
    selectedRecapMode,
    serverCapabilitiesPending,
    setAcceptedCreation,
    setAcceptingText,
    setInterimTranscript,
    setComposerAttachments,
    setIsStarting,
    showToast,
    sourceTransport,
    speechMessagePrefix,
    supportsInstalledMachineControl,
    supportsSessionSandboxing,
    t,
    templateProjectBusy,
    textareaRef,
    versionInfo,
  } = deps;
  const override =
    typeof messageOverride === "string" ? messageOverride : undefined;
  if (background && !canCreateInBackground) return;
  if (
    override === undefined &&
    deferSpeechDelivery(background ? "background" : "start")
  ) {
    return;
  }

  const finalMessage = (override ?? draftControls.getDraft()).trimEnd();

  // Files still uploading count as files, so a start picks the path that
  // waits for them (docs/tactical/188, item 24).
  let submissionFiles = attachmentsRef.current;
  const submissionUploads = [...pendingUploadsRef.current.values()];
  const submissionFileCount = submissionFiles.length + submissionUploads.length;
  const ownsForm = () =>
    creationViewOwner.current.active &&
    creationViewOwner.current.sourceKey === clientSummarySourceKey &&
    creationViewOwner.current.accountKey === principal.username;
  const unchangedSince = (files: readonly ComposerAttachment[]) =>
    pendingUploadsRef.current.size === 0 &&
    sameAttachmentIds(attachmentsRef.current, files);
  const plan = planNewSessionStart({
    finalMessage,
    submissionFileCount,
    // Read now, not from the render that built this start: the audio memo
    // uploads and then starts (docs/tactical/188, item 23).
    pendingFileCount: submissionFileCount,
    speechPrefix: resolveDeliverySpeechPrefix({
      configuredPrefix: speechMessagePrefix,
      speechTriggered,
      recentSpeech: isRecentSpeechAttribution(),
    }),
    propagateFailure,
    routedSourceKey: routerSelection ? routerSelection.sourceKey : null,
    sourceKey: clientSummarySourceKey,
    routerCapable: serverHasCapability(
      versionInfo,
      SERVER_CAPABILITIES.agentAuthRouter.name,
    ),
    launchLimited: launchLock.limited,
    effectiveSandboxLevel,
    hasLaunch: Boolean(launch),
    composerMuted,
    creatingTemplateProject,
    templateProjectBusy,
    isStarting,
    displayDefaultsPending,
    hasSelectedProviderModel,
    projectPending,
    serverCapabilitiesPending,
    selectedProvider,
    version: versionInfo,
  });
  if (plan.kind === "refuse") {
    showToast(t(plan.toastKey), "error");
    return;
  }
  if (plan.kind === "silent") {
    if (plan.throwCannotStart) {
      throw new Error(t("composerMemoCannotStart"));
    }
    return;
  }
  const trimmedMessage = plan.text;
  const messageMetadata = plan.metadata;
  const trimmedProjectInput = normalizeProjectInput(projectInput);
  const actionAtMs = Date.now();
  const clientTimestamp = getServerClockTimestamp(actionAtMs);

  const fullAdmission = serverHasCapability(
    versionInfo,
    SERVER_CAPABILITIES.sessionCreationAdmission.name,
  );
  let stagedCreationRefs = submissionFiles
    .filter(isComposerStagedAttachment)
    .map(toPersistedStagedAttachmentRef);
  const durableText =
    !launch &&
    principalResolved &&
    supportsSessionCreation(versionInfo, {
      provider: selectedProvider,
      limited: launchLock.limited,
      sandbox: effectiveSandboxLevel,
      machineControl: machineControlSelected,
      command: plan.hasCommand,
      fileCount: submissionFileCount,
      stagedCount: stagedCreationRefs.length,
    }) &&
    (Boolean(trimmedMessage.trim()) || submissionFileCount > 0);
  let capturedAttachmentState = JSON.stringify(
    draftControls.getAttachmentState(),
  );
  let capturedSubmission = durableText
    ? draftControls.captureSubmission?.()
    : undefined;
  setAcceptingText(durableText);
  setInterimTranscript("");
  consumeSpeechAttribution();
  setIsStarting(true);
  if (historyScope)
    void rememberComposerPrompt(historyScope, finalMessage).catch((cause) =>
      showToast(
        t("composerHistorySaveError", { error: String(cause) }),
        "error",
      ),
    );

  try {
    let resolvedProjectId =
      await resolveProjectIdForSubmission(trimmedProjectInput);
    if (!resolvedProjectId && !canCreateDetached) {
      throw new Error("Choose a project to start a session.");
    }

    const sessionMode = effectivePermissionMode;

    // Get model and thinking settings
    const thinking = toThinkingOption(
      effectiveThinkingMode,
      effectiveEffortLevel,
    );
    const effectiveRecapMode = resolveRecapMode(
      selectedProviderInfo,
      selectedRecapMode,
    );
    const effectivePromptSuggestionMode = resolvePromptSuggestionMode(
      selectedProviderInfo,
      selectedPromptSuggestionMode,
    );
    // Display preference for thinking rows; sent for compatibility while the
    // server requests provider summaries independently.
    const showThinking = getShowThinkingSetting();
    const creationProvenance = getUiCreationProvenance(versionInfo);
    const sessionOptions = buildNewSessionStartOptions({
      creationProvenance,
      supportsInstalledMachineControl,
      machineControlSelected,
      machineControlEligible,
      mode: sessionMode,
      routed: routerSelection,
      routedModel,
      selectedModel,
      routerCapable: serverHasCapability(
        versionInfo,
        SERVER_CAPABILITIES.agentAuthRouter.name,
      ),
      routerAccountId,
      routerPolicy,
      routerClaudeAiConnectors,
      routerThinking,
      thinking,
      showThinking,
      effectiveServiceTier,
      selectedProvider,
      supportsSessionSandboxing,
      effectiveSandboxLevel,
      effectiveSandboxNetworkFirewall,
      recapMode: effectiveRecapMode,
      recapAfterSeconds,
      promptSuggestionMode: effectivePromptSuggestionMode,
      helperSideModel,
      launchLock,
    });
    logSessionUiTrace("new-session-submit", {
      projectId: resolvedProjectId ?? null,
      detached: !resolvedProjectId,
      mode: sessionMode,
      model: selectedModel ?? null,
      thinking,
      provider: selectedProvider ?? null,
      sandboxLevel: supportsSessionSandboxing ? effectiveSandboxLevel : null,
      sandboxNetworkFirewall: supportsSessionSandboxing
        ? effectiveSandboxNetworkFirewall
        : null,
      recapMode: effectiveRecapMode,
      recapAfterSeconds,
      promptSuggestionMode: effectivePromptSuggestionMode,
      helperSideModel,
      textLength: trimmedMessage.length,
      pendingFileCount: submissionFileCount,
      clientTimestamp,
      serverOffsetMs: getEstimatedServerOffsetMs(),
    });

    if (launch) {
      if (submissionFileCount > 0) {
        throw new Error("This session launch does not accept attachments");
      }
      await launch.submit({
        message: trimmedMessage,
        options: sessionOptions,
        clientTimestamp,
      });
      draftControls.clearDraft();
      setIsStarting(false);
      return;
    }

    if (durableText) {
      if (fullAdmission && submissionUploads.length > 0) {
        const uploaded = await Promise.all(submissionUploads);
        if (uploaded.some((file) => !file)) {
          // A source change cancels the form's uploads; that start stops
          // quietly, as at the ownership check below.
          if (!ownsForm()) return;
          throw new Error(t("sessionDraftAttachmentsUnavailable"));
        }
        submissionFiles = [
          ...submissionFiles,
          ...(uploaded as ComposerAttachment[]),
        ];
        stagedCreationRefs = submissionFiles
          .filter(isComposerStagedAttachment)
          .map(toPersistedStagedAttachmentRef);
        if (
          draftControls.getDraft() === capturedSubmission?.text &&
          unchangedSince(submissionFiles)
        ) {
          capturedSubmission = draftControls.captureSubmission?.();
          capturedAttachmentState = JSON.stringify(
            draftControls.getAttachmentState(),
          );
        }
      }
      if (
        !creationViewOwner.current.active ||
        creationViewOwner.current.sourceKey !== clientSummarySourceKey ||
        creationViewOwner.current.accountKey !== principal.username
      )
        return;
      const receipt = await acceptSessionCreation(
        sourceTransport,
        `ya-text-creation:${clientSummarySourceKey}:${principal.username}:${newSessionDraftKey}`,
        resolvedProjectId ?? undefined,
        trimmedMessage,
        sessionOptions,
        clientTimestamp,
        messageMetadata,
        capturedSubmission?.text,
        stagedCreationRefs.length ? stagedCreationRefs : undefined,
        capturedAttachmentState,
        submissionFiles.map((file) => file.id),
      );
      if (
        !creationViewOwner.current.active ||
        creationViewOwner.current.sourceKey !== clientSummarySourceKey ||
        creationViewOwner.current.accountKey !== principal.username
      )
        return true;
      const unchangedFiles = unchangedSince(submissionFiles);
      const cleared = unchangedFiles
        ? (capturedSubmission?.confirm() ?? false)
        : false;
      if (cleared)
        setComposerAttachments([], {
          persistDraft: false,
          revokeRemovedPreviewUrls: true,
        });
      if (
        cleared ||
        !unchangedFiles ||
        (capturedSubmission &&
          (draftControls.getDraft() !== capturedSubmission.text ||
            JSON.stringify(draftControls.getAttachmentState()) !==
              capturedAttachmentState))
      )
        settleSessionCreation(
          `ya-text-creation:${clientSummarySourceKey}:${principal.username}:${newSessionDraftKey}`,
          receipt.requestId,
        );
      setIsStarting(false);
      setAcceptingText(false);
      if (background || !cleared) {
        setAcceptedCreation({
          ...receipt,
          sourceKey: clientSummarySourceKey,
          accountKey: principal.username,
          background,
        });
        if (background) textareaRef.current?.focus();
        return true;
      }
      navigate(
        `${basePath}/projects/${receipt.projectId}/sessions/${receipt.sessionId}`,
        {
          state: createSessionNavigationState({
            projectApp,
            initialTitle: trimmedMessage,
            initialProvider: selectedProvider ?? undefined,
          }),
        },
      );
      return true;
    }

    const started = await createLegacySession({
      version: versionInfo,
      api,
      projectId: resolvedProjectId ?? undefined,
      message: trimmedMessage,
      options: sessionOptions,
      clientTimestamp,
      metadata: messageMetadata,
      materialize: submissionFileCount
        ? resolvePendingAttachmentsForSession
        : undefined,
    });
    const {
      sessionId,
      processId,
      permissionMode: initialPermissionMode,
      appliedPermissionMode: initialAppliedPermissionMode,
      modeVersion: initialModeVersion,
    } = started;
    resolvedProjectId = started.projectId;

    if (!resolvedProjectId) {
      throw new Error("Missing project ID for new session");
    }

    // Clean up preview URLs
    setComposerAttachments([], {
      persistDraft: false,
      revokeRemovedPreviewUrls: true,
    });

    draftControls.clearDraft();
    // Pass initial status so SessionPage can connect SSE immediately
    // without waiting for getSession to complete
    // Also pass initial message as optimistic title (session name = first message)
    // Pass model/provider so ProviderBadge can render immediately
    navigate(
      `${basePath}/projects/${resolvedProjectId}/sessions/${sessionId}`,
      {
        state: createSessionNavigationState({
          projectApp,
          initialStatus: {
            owner: "self",
            processId,
            permissionMode: initialPermissionMode,
            appliedPermissionMode: initialAppliedPermissionMode,
            modeVersion: initialModeVersion,
            recapAfterSeconds,
          },
          initialTitle: trimmedMessage,
          initialModel: routerSelection
            ? routedModel
            : selectedModel || undefined,
          initialProvider: selectedProvider ?? undefined,
        }),
      },
    );
    return true;
  } catch (err) {
    console.error("Failed to start session:", err);
    if (capturedSubmission) capturedSubmission.cancel();
    else draftControls.restoreFromStorage();
    setIsStarting(false);
    setAcceptingText(false);

    // Show user-visible error message
    const errorMessage = newSessionStartErrorMessage(
      err,
      selectedProvider,
      selectedProviderInfo?.displayName,
      t,
    );
    showToast(errorMessage, "error");
    if (propagateFailure) throw err;
  }
}

/**
 * Queues the form's draft as a new session in the project's queue: the body
 * of the form's `handleQueueProjectSession`, moved unchanged.
 */
export async function queueNewSessionForProject(
  deps: NewSessionQueueDeps,
  messageOverride?: unknown,
) {
  const {
    clientSummarySourceKey,
    consumeSpeechAttribution,
    creatingTemplateProject,
    creationViewOwner,
    deferSpeechDelivery,
    displayDefaultsPending,
    draftControls,
    effectivePermissionMode,
    effectiveSandboxLevel,
    effectiveSandboxNetworkFirewall,
    effectiveServiceTier,
    hasSelectedProviderModel,
    isRecentSpeechAttribution,
    isStarting,
    launchLock,
    machineControlQueueBlocked,
    attachmentsRef,
    pendingUploadsRef,
    principal,
    projectInput,
    projectPending,
    resolveProjectIdForSubmission,
    routedModel,
    routerAccountId,
    routerClaudeAiConnectors,
    routerPolicy,
    routerSelection,
    routerThinking,
    selectedEffortLevel,
    selectedModel,
    selectedProvider,
    selectedProviderInfo,
    selectedServiceTier,
    selectedThinkingMode,
    setAcceptingText,
    setInterimTranscript,
    setIsStarting,
    setComposerAttachments,
    showToast,
    sourceSummary,
    speechMessagePrefix,
    supportsSessionSandboxing,
    t,
    templateProjectBusy,
    versionInfo,
  } = deps;
  const refusal = projectQueueRefusalBeforeDefer({
    routedSourceKey: routerSelection ? routerSelection.sourceKey : null,
    sourceKey: clientSummarySourceKey,
    routerCapable: serverHasCapability(
      versionInfo,
      SERVER_CAPABILITIES.agentAuthRouter.name,
    ),
    queueRouterCapable: serverHasCapability(
      versionInfo,
      SERVER_CAPABILITIES.projectQueueRouterSelection.name,
    ),
    launchLimited: launchLock.limited,
    effectiveSandboxLevel,
    machineControlQueueBlocked,
    creatingTemplateProject,
    templateProjectBusy,
  });
  if (refusal) {
    if (refusal.kind === "refuse") showToast(t(refusal.toastKey), "error");
    return;
  }
  const override =
    typeof messageOverride === "string" ? messageOverride : undefined;
  if (override === undefined && deferSpeechDelivery("project-queue")) {
    return;
  }

  const finalMessage = (override ?? draftControls.getDraft()).trimEnd();
  const trimmedProjectInput = normalizeProjectInput(projectInput);
  const submissionFiles = attachmentsRef.current;
  const stagedRefs = submissionFiles
    .filter(isComposerStagedAttachment)
    .map(toPersistedStagedAttachmentRef);
  const planned = planNewSessionProjectQueue({
    finalMessage,
    speechPrefix: resolveDeliverySpeechPrefix({
      configuredPrefix: speechMessagePrefix,
      speechTriggered: false,
      recentSpeech: isRecentSpeechAttribution(),
    }),
    submissionFileCount:
      submissionFiles.length + pendingUploadsRef.current.size,
    stagedFileCount: stagedRefs.length,
    isStarting,
    displayDefaultsPending,
    projectPending,
    hasSelectedProviderModel,
  });
  if (!planned) return;
  const trimmedMessage = planned.text;

  // Final speech can differ from the visible snapshot selected by the manual
  // Queue action. That newer draft was not submitted and must stay intact.
  const capturedSubmission =
    draftControls.getDraft().trimEnd() === finalMessage
      ? draftControls.captureSubmission?.()
      : undefined;
  const submittedFileIds = new Set(submissionFiles.map((file) => file.id));
  const stillOwnsForm = () =>
    creationViewOwner.current.active &&
    creationViewOwner.current.sourceKey === clientSummarySourceKey &&
    creationViewOwner.current.accountKey === principal.username;
  consumeSpeechAttribution();

  const actionAtMs = Date.now();
  const clientTimestamp = getServerClockTimestamp(actionAtMs);
  const submittedAt = new Date(clientTimestamp).toISOString();
  const firstStagedRef = stagedRefs[0];
  const stagedAttachments = firstStagedRef
    ? {
        batchId: firstStagedRef.batchId,
        refs: stagedRefs,
        updatedAt: new Date().toISOString(),
      }
    : undefined;

  setInterimTranscript("");
  setAcceptingText(true);
  setIsStarting(true);

  try {
    const resolvedProjectId = await resolveProjectIdForSubmission(
      trimmedProjectInput,
      stillOwnsForm,
    );
    if (!resolvedProjectId) {
      throw new Error(t("projectQueueNewSessionNeedsProject"));
    }

    const sessionMode = effectivePermissionMode;
    // A shown pool or account queues with the item; the router allocates
    // when it dispatches (topics/project-queue.md).
    const showThinking = getShowThinkingSetting();
    const { target, thinking } = buildProjectQueueNewSessionTarget({
      providerInfo: selectedProviderInfo,
      selectedProvider,
      selectedModel,
      selectedThinkingMode,
      selectedEffortLevel,
      selectedServiceTier,
      mode: sessionMode,
      showThinking,
      supportsSessionSandboxing,
      effectiveSandboxLevel,
      effectiveSandboxNetworkFirewall,
      launchLock,
      title: trimmedMessage,
      t,
      routed: routerSelection,
      routedModel,
      routerAccountId,
      routerPolicy,
      routerClaudeAiConnectors,
      routerThinking,
      routedServiceTier: effectiveServiceTier,
    });

    if (!stillOwnsForm()) return;
    const response = await api.createProjectQueueItem(resolvedProjectId, {
      target,
      message: {
        text: trimmedMessage,
        mode: sessionMode,
        ...(stagedAttachments ? { stagedAttachments } : {}),
        metadata: {
          deliveryIntent: "deferred",
          clientTimestamp,
          composition: {
            submittedAt,
            typingEndedAt: submittedAt,
          },
        },
      },
      createdFrom: {
        client: "new-session",
      },
    });
    if (!stillOwnsForm()) return;
    sourceSummary.reportProjectQueueCollectionSnapshot(response.queue);

    logSessionUiTrace("new-session-project-queued", {
      projectId: resolvedProjectId,
      mode: sessionMode,
      model: selectedModel ?? null,
      thinking,
      provider: selectedProvider ?? null,
      sandboxLevel: supportsSessionSandboxing ? effectiveSandboxLevel : null,
      sandboxNetworkFirewall: supportsSessionSandboxing
        ? effectiveSandboxNetworkFirewall
        : null,
      textLength: trimmedMessage.length,
      attachmentCount: stagedRefs.length,
      uploadWaitMs: Date.now() - actionAtMs,
    });
    if (capturedSubmission?.confirm())
      setComposerAttachments(
        (current) => current.filter((file) => !submittedFileIds.has(file.id)),
        { persistDraft: false, revokeRemovedPreviewUrls: true },
      );
    showToast(t("projectQueueNewSessionQueuedToast"), "success");
  } catch (err) {
    if (!stillOwnsForm()) return;
    console.error("Failed to queue project session:", err);
    capturedSubmission?.cancel();
    const errorMsg = err instanceof Error ? err.message : String(err);
    showToast(t("projectQueueSubmitFailed", { message: errorMsg }), "error");
  } finally {
    if (creationViewOwner.current.active) {
      setIsStarting(false);
      setAcceptingText(false);
    }
  }
}
