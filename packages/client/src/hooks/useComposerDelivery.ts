import type { UserMessageDeliveryIntent } from "@yep-anywhere/shared";
import { useCallback, useMemo, useRef } from "react";
import type { ChosenNewSessionQueueTarget } from "../components/NewSessionQueueOptions";
import type { VoiceInputButtonRef } from "../components/VoiceInputButton";
import {
  type ComposerActionKind,
  type ComposerDeliveryRoute,
  canDeliverOnRoute,
  planComposerDelivery,
  resolvePrimaryDeliveryRoute,
  routeTriesQuestionAside,
} from "../lib/composerDelivery";
import { hasCoarsePointer } from "../lib/deviceDetection";
import { programmaticFocus } from "../lib/programmaticFocus";
import type {
  PendingSpeechRetarget,
  PendingTextareaSelectionRestore,
} from "../lib/speechDraftTransaction";
import {
  prependSpeechMessagePrefix,
  resolveDeliverySpeechPrefix,
} from "../lib/speechMessagePrefix";
import type { SpeechInsertionRange } from "../lib/speechRecognition";
import type { MessageSubmissionMetadata } from "../types/messageSubmission";
import type { useComposerSpeechState } from "./useComposerSpeechState";
import type { DraftControls } from "./useDraftPersistence";

export interface SubmissionCompositionSnapshot {
  typingStartedAt: string | null;
  lastEditedAt: string | null;
  speechTurnId: string | null;
  speechTranscriptionIds: string[];
}

export interface PendingSpeechDelivery {
  route: ComposerDeliveryRoute;
  focusAfterSubmit: boolean;
  draft: string;
  composition: SubmissionCompositionSnapshot;
  speechInsertionRangeRef: { current: SpeechInsertionRange | null };
  activeSpeechTargetIdRef: { current: string | null };
  speechInsertionRangesRef: {
    current: Map<string, SpeechInsertionRange>;
  };
  pendingTextareaSelectionRef: {
    current: PendingTextareaSelectionRestore | null;
  };
  pendingSpeechRetargetRef: {
    current: PendingSpeechRetarget | null;
  };
}

type SpeechState = ReturnType<typeof useComposerSpeechState>;
type SubmitMessage = (
  text: string,
  metadata?: MessageSubmissionMetadata,
) => void;

/** What the message box passes in; each is the box's value of that name. */
export interface ComposerDeliveryInputs {
  activeSpeechTargetIdRef: SpeechState["activeSpeechTargetIdRef"];
  attachments: readonly unknown[];
  bangSupport: { onRun: (command: string) => Promise<void> } | undefined;
  buildSubmissionMetadata: (
    deliveryIntent: UserMessageDeliveryIntent,
    snapshot?: SubmissionCompositionSnapshot,
  ) => MessageSubmissionMetadata;
  canSaveQuestionAside: boolean;
  consumeSpeechAttribution: () => void;
  controls: DraftControls;
  disabled: boolean | undefined;
  effectivePrimaryActionKind: ComposerActionKind;
  forkSummaryMode:
    | {
        submitting?: boolean;
        onSubmit: (instructions: string) => void;
        onSubmitWithoutSummary?: (text: string) => void;
      }
    | undefined;
  interimTranscriptRef: SpeechState["interimTranscriptRef"];
  isComposing: boolean;
  isRecentSpeechAttribution: () => boolean;
  keepMobileKeyboardOpenAfterDelivery: boolean;
  lastEditedAtRef: { current: string | null };
  onDone: (() => void) | undefined;
  onProjectQueue: SubmitMessage | undefined;
  onProjectQueueNewSession:
    | ((
        text: string,
        metadata?: MessageSubmissionMetadata,
        target?: ChosenNewSessionQueueTarget,
      ) => void)
    | undefined;
  onQueue: SubmitMessage | undefined;
  onSend: SubmitMessage;
  patientQueueCompactPercent: number | undefined;
  patientQueueEnabled: boolean;
  pendingSpeechFinalRef: SpeechState["pendingSpeechFinalRef"];
  pendingSpeechRetargetRef: SpeechState["pendingSpeechRetargetRef"];
  questionAside:
    | {
        onAsk: (rawText: string) => boolean;
        onSave?: () => void;
        onDismiss?: () => void;
      }
    | undefined;
  questionAsideEligible: boolean;
  resetCompositionMetadata: () => void;
  setInterimTranscript: SpeechState["setInterimTranscript"];
  setNewSessionOptionsMode: (mode: "now" | "patient" | null) => void;
  setTextareaImeGeneration: (update: (generation: number) => number) => void;
  speechInsertionRangeRef: SpeechState["speechInsertionRangeRef"];
  speechInsertionRangesRef: SpeechState["speechInsertionRangesRef"];
  speechMessagePrefix: string | null;
  speechPendingRef: SpeechState["speechPendingRef"];
  speechTranscriptionIdsRef: { current: string[] };
  speechTurnIdRef: SpeechState["speechTurnIdRef"];
  textareaRef: { current: HTMLTextAreaElement | null };
  topicShiftCompactPercent: number | undefined;
  topicShiftSupported: boolean;
  typingStartedAtRef: { current: string | null };
  uploadProgress: readonly unknown[];
  voiceButtonRef: { current: VoiceInputButtonRef | null };
}

/**
 * The message box's delivery: one route-driven `deliver`, setting a
 * dictated draft aside until speech settles and replaying or restoring it,
 * the question aside submission, the touch delivery handlers and voice
 * auto-send (docs/tactical/184-message-box-send-routes.md). Called where
 * the box's delivery stood, before `useComposerSpeechHandlers`, which
 * takes its replay, restore and auto-send functions.
 */
export function useComposerDelivery({
  activeSpeechTargetIdRef,
  attachments,
  bangSupport,
  buildSubmissionMetadata,
  canSaveQuestionAside,
  consumeSpeechAttribution,
  controls,
  disabled,
  effectivePrimaryActionKind,
  forkSummaryMode,
  interimTranscriptRef,
  isComposing,
  isRecentSpeechAttribution,
  keepMobileKeyboardOpenAfterDelivery,
  lastEditedAtRef,
  onDone,
  onProjectQueue,
  onProjectQueueNewSession,
  onQueue,
  onSend,
  patientQueueCompactPercent,
  patientQueueEnabled,
  pendingSpeechFinalRef,
  pendingSpeechRetargetRef,
  questionAside,
  questionAsideEligible,
  resetCompositionMetadata,
  setInterimTranscript,
  setNewSessionOptionsMode,
  setTextareaImeGeneration,
  speechInsertionRangeRef,
  speechInsertionRangesRef,
  speechMessagePrefix,
  speechPendingRef,
  speechTranscriptionIdsRef,
  speechTurnIdRef,
  textareaRef,
  topicShiftCompactPercent,
  topicShiftSupported,
  typingStartedAtRef,
  uploadProgress,
  voiceButtonRef,
}: ComposerDeliveryInputs) {
  const mobilePointerDeliveryPendingRef = useRef(false);
  const pendingSpeechDeliveryRef = useRef<PendingSpeechDelivery | null>(null);
  const pendingSpeechDeliverySettledRef = useRef(false);
  const runPendingSpeechDeliveryRef = useRef<() => void>(() => {});
  const smartTurnSendRef = useRef<(text: string) => boolean>(() => false);

  const deferSpeechDelivery = useCallback(
    (route: ComposerDeliveryRoute, focusAfterSubmit: boolean) => {
      const voice = voiceButtonRef.current;
      if (pendingSpeechDeliveryRef.current) {
        if (voice?.isListening) voice.stopAndFinalize();
        return true;
      }
      const speechWorkPending =
        voice?.isListening === true ||
        speechPendingRef.current !== null ||
        pendingSpeechFinalRef.current !== null;
      if (!speechWorkPending) {
        pendingSpeechDeliveryRef.current = null;
        pendingSpeechDeliverySettledRef.current = false;
        return false;
      }
      // The delivery press owns the current draft and speech target. Detach
      // both from the live composer so speech can settle without consuming
      // text the user starts typing for the next turn. Delivery during capture
      // is unreviewed: final ASR revisions update this detached draft before
      // successful settlement authorizes sending it with the speech prefix.
      const draft = controls.getDraft();
      pendingSpeechDeliveryRef.current = {
        route,
        focusAfterSubmit,
        draft,
        composition: {
          typingStartedAt: typingStartedAtRef.current,
          lastEditedAt: lastEditedAtRef.current,
          speechTurnId: speechTurnIdRef.current,
          speechTranscriptionIds: [...speechTranscriptionIdsRef.current],
        },
        speechInsertionRangeRef: {
          current: speechInsertionRangeRef.current,
        },
        activeSpeechTargetIdRef: {
          current: activeSpeechTargetIdRef.current,
        },
        speechInsertionRangesRef: {
          current: new Map(speechInsertionRangesRef.current),
        },
        pendingTextareaSelectionRef: { current: null },
        pendingSpeechRetargetRef: {
          current: pendingSpeechRetargetRef.current,
        },
      };
      pendingSpeechDeliverySettledRef.current = false;
      speechInsertionRangeRef.current = null;
      activeSpeechTargetIdRef.current = null;
      speechInsertionRangesRef.current = new Map();
      pendingSpeechRetargetRef.current = null;
      controls.clearInput();
      resetCompositionMetadata();
      interimTranscriptRef.current = "";
      setInterimTranscript("");
      if (voice?.isListening) voice.stopAndFinalize();
      return true;
    },
    [
      controls,
      resetCompositionMetadata,
      activeSpeechTargetIdRef,
      interimTranscriptRef,
      lastEditedAtRef,
      pendingSpeechFinalRef,
      pendingSpeechRetargetRef,
      setInterimTranscript,
      speechInsertionRangeRef,
      speechInsertionRangesRef,
      speechPendingRef,
      speechTranscriptionIdsRef,
      speechTurnIdRef,
      typingStartedAtRef,
      voiceButtonRef,
    ],
  );

  const handleQuestionAsideSubmission = useCallback(
    (rawText: string) => {
      if (disabled || isComposing) return false;
      if (rawText === "" && canSaveQuestionAside) {
        questionAside?.onSave?.();
        return true;
      }
      if (
        questionAsideEligible &&
        rawText.endsWith("?") &&
        !rawText.trimStart().startsWith("/") &&
        !rawText.trimStart().startsWith("!!") &&
        questionAside?.onAsk(rawText)
      ) {
        controls.clearInput();
        resetCompositionMetadata();
        setInterimTranscript("");
        return true;
      }
      return false;
    },
    [
      disabled,
      isComposing,
      canSaveQuestionAside,
      questionAsideEligible,
      questionAside,
      controls,
      resetCompositionMetadata,
      setInterimTranscript,
    ],
  );

  const queueHandler =
    onQueue ?? (effectivePrimaryActionKind === "queue" ? onSend : undefined);
  const forkMode = !!forkSummaryMode;
  const primaryRoute = useMemo(
    () =>
      resolvePrimaryDeliveryRoute({
        forkMode,
        primaryActionKind: effectivePrimaryActionKind,
      }),
    [effectivePrimaryActionKind, forkMode],
  );

  // Every press of the message box delivers through this one function
  // (docs/tactical/184-message-box-send-routes.md). `text` is given only
  // when the draft does not come from the box: voice auto-send, the file
  // viewer, and a dictated draft set aside until speech settled
  // (`setAside`), which must leave the box, holding the user's next
  // message, untouched. Returns whether the press was taken.
  const deliver = useCallback(
    (
      route: ComposerDeliveryRoute,
      {
        text: override,
        snapshot,
        focusAfterSubmit = true,
        speechTriggered = false,
        setAside = false,
      }: {
        text?: string;
        snapshot?: SubmissionCompositionSnapshot;
        focusAfterSubmit?: boolean;
        speechTriggered?: boolean;
        setAside?: boolean;
      } = {},
    ): boolean => {
      if (
        !canDeliverOnRoute(route, {
          disabled: !!disabled,
          forkMode: !!forkSummaryMode,
          forkSubmitting: !!forkSummaryMode?.submitting,
          forkWithoutSummary: !!forkSummaryMode?.onSubmitWithoutSummary,
          nonTextContentCount: attachments.length + uploadProgress.length,
          canQueue: !!queueHandler,
          canProjectQueue: !!onProjectQueue,
          canProjectQueueNewSession: !!onProjectQueueNewSession,
        })
      ) {
        return false;
      }
      if (
        override === undefined &&
        deferSpeechDelivery(route, focusAfterSubmit)
      ) {
        return true;
      }

      const rawText = override ?? controls.getDraft();
      // Saving an answer takes an empty box, not an empty voice auto-send.
      if (
        !setAside &&
        routeTriesQuestionAside(route) &&
        (override === undefined || rawText !== "") &&
        handleQuestionAsideSubmission(rawText)
      ) {
        return true;
      }
      const plan = planComposerDelivery(route, rawText, {
        attachmentCount: attachments.length,
        uploadCount: uploadProgress.length,
        doneAvailable: !!onDone,
        bangAvailable: !!bangSupport,
        primaryActionKind: effectivePrimaryActionKind,
        patientQueueEnabled,
        topicShiftSupported,
        topicShiftCompactPercent,
        patientQueueCompactPercent,
      });
      if (plan.kind === "ignore") return false;

      // A set-aside draft owns its own text; the box may already hold the
      // next turn and must remain untouched.
      const clearComposer = () => {
        if (setAside) return;
        controls.clearInput();
        resetCompositionMetadata();
        setInterimTranscript("");
      };
      // Refocus the box so the user can keep typing, unless a settled
      // speech delivery finds the user in an embedded app.
      const settleFocus = () => {
        if (focusAfterSubmit) {
          programmaticFocus(textareaRef.current);
        } else {
          textareaRef.current?.blur();
        }
      };

      if (plan.kind === "done") {
        clearComposer();
        onDone?.();
        settleFocus();
        return true;
      }
      if (plan.kind === "bang") {
        // Empty the composer before the request, as Send does, so keys typed
        // while the command starts begin the next draft instead of being
        // cleared with the command. Storage keeps the command until the
        // outcome is known.
        clearComposer();
        const run = async () => {
          try {
            await bangSupport?.onRun(plan.command);
            if (!setAside) controls.confirmInputClear();
          } catch {
            // The owner surfaces the run failure. Bring the command back for
            // retry unless a newer draft has taken its place.
            if (!setAside) controls.restoreFromStorage();
          }
          // The command ran across an await; the user may be in the app now.
          settleFocus();
        };
        void run();
        return true;
      }

      const deliverySpeechPrefix = resolveDeliverySpeechPrefix({
        configuredPrefix: speechMessagePrefix,
        speechTriggered,
        recentSpeech: isRecentSpeechAttribution(),
      });
      const message =
        deliverySpeechPrefix && plan.text.trim()
          ? prependSpeechMessagePrefix(plan.text, deliverySpeechPrefix)
          : plan.text;
      let metadata: MessageSubmissionMetadata | undefined;
      if (plan.intent) {
        metadata = buildSubmissionMetadata(plan.intent, snapshot);
        if (plan.patientSource) metadata.patientSource = plan.patientSource;
        if (plan.compactAboveContextPercent !== undefined) {
          metadata.compactAboveContextPercent = plan.compactAboveContextPercent;
        }
      }
      clearComposer();
      questionAside?.onDismiss?.();
      switch (route.kind) {
        case "send":
          onSend(message, metadata);
          break;
        case "queue":
          queueHandler?.(message, metadata);
          break;
        case "project-queue":
          if (!route.newSession) onProjectQueue?.(message, metadata);
          else if (route.newSessionTarget)
            onProjectQueueNewSession?.(
              message,
              metadata,
              route.newSessionTarget,
            );
          else onProjectQueueNewSession?.(message, metadata);
          break;
        case "fork-summary":
          forkSummaryMode?.onSubmit(message);
          break;
        case "fork-without-summary":
          forkSummaryMode?.onSubmitWithoutSummary?.(message);
          break;
      }
      consumeSpeechAttribution();
      settleFocus();
      return true;
    },
    [
      attachments.length,
      bangSupport,
      buildSubmissionMetadata,
      consumeSpeechAttribution,
      controls,
      deferSpeechDelivery,
      disabled,
      effectivePrimaryActionKind,
      forkSummaryMode,
      handleQuestionAsideSubmission,
      isRecentSpeechAttribution,
      onDone,
      onProjectQueue,
      onProjectQueueNewSession,
      onSend,
      patientQueueCompactPercent,
      patientQueueEnabled,
      queueHandler,
      questionAside,
      resetCompositionMetadata,
      speechMessagePrefix,
      topicShiftCompactPercent,
      topicShiftSupported,
      uploadProgress.length,
      setInterimTranscript,
      textareaRef,
    ],
  );

  // A set-aside draft goes back in front of whatever the user typed since.
  const restoreSetAsideDraft = useCallback(
    (pending: PendingSpeechDelivery) => {
      const liveDraft = controls.getDraft();
      if (pending.draft.trim()) {
        controls.setDraft(
          liveDraft ? `${pending.draft}\n\n${liveDraft}` : pending.draft,
        );
      }
    },
    [controls],
  );

  const restorePendingSpeechDeliveryDraft = useCallback(() => {
    const pending = pendingSpeechDeliveryRef.current;
    if (!pending) return false;
    pendingSpeechDeliveryRef.current = null;
    pendingSpeechDeliverySettledRef.current = false;
    restoreSetAsideDraft(pending);
    return true;
  }, [restoreSetAsideDraft]);

  const runPendingSpeechDelivery = useCallback(() => {
    if (
      speechPendingRef.current !== null ||
      pendingSpeechFinalRef.current !== null
    ) {
      return;
    }
    if (!pendingSpeechDeliverySettledRef.current) return;
    const pending = pendingSpeechDeliveryRef.current;
    if (!pending) return;
    // Release the set-aside draft before delivering it, so a settlement
    // reported again during delivery cannot send it twice.
    pendingSpeechDeliveryRef.current = null;
    pendingSpeechDeliverySettledRef.current = false;
    let delivered = false;
    try {
      delivered = deliver(pending.route, {
        text: pending.draft,
        snapshot: pending.composition,
        focusAfterSubmit: pending.focusAfterSubmit,
        speechTriggered: true,
        setAside: true,
      });
    } finally {
      if (!delivered) restoreSetAsideDraft(pending);
    }
  }, [deliver, restoreSetAsideDraft, pendingSpeechFinalRef, speechPendingRef]);
  runPendingSpeechDeliveryRef.current = runPendingSpeechDelivery;

  const maybeRunPendingSpeechDelivery = useCallback(() => {
    runPendingSpeechDeliveryRef.current();
  }, []);

  const runComposerPointerDelivery = useCallback(
    (deliver: (focusAfterSubmit: boolean) => void) => {
      if (!hasCoarsePointer()) {
        deliver(true);
        return;
      }
      if (mobilePointerDeliveryPendingRef.current) return;

      mobilePointerDeliveryPendingRef.current = true;
      const refocus = keepMobileKeyboardOpenAfterDelivery;
      // A controlled clear does not retire Android's composing region. Blur
      // and replace the editing host so late Gboard events stay attached to
      // the old DOM node instead of becoming the next persisted draft.
      textareaRef.current?.blur();
      setTextareaImeGeneration((generation) => generation + 1);

      const finishBoundary = () => {
        mobilePointerDeliveryPendingRef.current = false;
        if (!refocus) return;
        const textarea = textareaRef.current;
        if (textarea && !textarea.disabled) textarea.focus();
      };
      try {
        deliver(false);
      } finally {
        // React commits discrete-event updates before the next frame, so an
        // opt-in refocus targets only the replacement editing host.
        if (typeof window.requestAnimationFrame === "function") {
          window.requestAnimationFrame(finishBoundary);
        } else {
          window.setTimeout(finishBoundary, 0);
        }
      }
    },
    [
      keepMobileKeyboardOpenAfterDelivery,
      setTextareaImeGeneration,
      textareaRef,
    ],
  );
  const deliverFromPointer = useCallback(
    (route: ComposerDeliveryRoute) =>
      runComposerPointerDelivery((focusAfterSubmit) => {
        deliver(route, { focusAfterSubmit });
      }),
    [deliver, runComposerPointerDelivery],
  );
  const handlePrimaryPointerDelivery = useCallback(
    () => deliverFromPointer(primaryRoute),
    [deliverFromPointer, primaryRoute],
  );
  const handleQueuePointerDelivery = useCallback(
    () => deliverFromPointer({ kind: "queue" }),
    [deliverFromPointer],
  );
  const handleSteerPointerDelivery = useCallback(
    () => deliverFromPointer({ kind: "send", action: "steer" }),
    [deliverFromPointer],
  );
  const handleTopicShiftPointerDelivery = useCallback(
    () => deliverFromPointer({ kind: "queue", topicShift: true }),
    [deliverFromPointer],
  );
  const handleProjectQueuePointerDelivery = useCallback(
    () => deliverFromPointer({ kind: "project-queue", newSession: false }),
    [deliverFromPointer],
  );
  const handleProjectQueueNewSessionPointerDelivery = useCallback(
    () => deliverFromPointer({ kind: "project-queue", newSession: true }),
    [deliverFromPointer],
  );
  const queueNewSessionAtChosenTarget = useCallback(
    (target: ChosenNewSessionQueueTarget) => {
      setNewSessionOptionsMode(null);
      deliverFromPointer({
        kind: "project-queue",
        newSession: true,
        newSessionTarget: target,
      });
    },
    [deliverFromPointer, setNewSessionOptionsMode],
  );
  const handleForkWithoutSummaryPointerDelivery = useCallback(
    () => deliverFromPointer({ kind: "fork-without-summary" }),
    [deliverFromPointer],
  );
  // Read through a ref, like the set-aside replay, so the voice button's
  // callbacks keep their identity while the delivery state changes.
  smartTurnSendRef.current = (text: string) => {
    if (
      !deliver(primaryRoute, {
        text,
        focusAfterSubmit: !hasCoarsePointer(),
        speechTriggered: true,
      })
    ) {
      return false;
    }
    voiceButtonRef.current?.continueAfterSpeechSend();
    return true;
  };
  const handleSmartTurnSend = useCallback(
    (text: string) => smartTurnSendRef.current(text),
    [],
  );

  return {
    deliver,
    primaryRoute,
    handleQuestionAsideSubmission,
    restorePendingSpeechDeliveryDraft,
    maybeRunPendingSpeechDelivery,
    handlePrimaryPointerDelivery,
    handleQueuePointerDelivery,
    handleSteerPointerDelivery,
    handleTopicShiftPointerDelivery,
    handleProjectQueuePointerDelivery,
    handleProjectQueueNewSessionPointerDelivery,
    queueNewSessionAtChosenTarget,
    handleForkWithoutSummaryPointerDelivery,
    handleSmartTurnSend,
    pendingSpeechDeliveryRef,
    pendingSpeechDeliverySettledRef,
  };
}
