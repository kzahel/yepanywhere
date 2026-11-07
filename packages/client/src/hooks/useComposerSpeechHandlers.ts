import { type RefObject, useCallback } from "react";
import type {
  SpeechCycleSettlement,
  SpeechPendingKind,
  VoiceInputButtonRef,
} from "../components/VoiceInputButton";
import { focusComposerForSpeechTransition } from "../lib/speechComposerFocus";
import {
  commitSpeechTranscript,
  type PendingSpeechRetarget,
  type PendingTextareaSelectionRestore,
} from "../lib/speechDraftTransaction";
import type {
  SpeechTranscriptionResultMetadata,
  SpeechTranscriptionSettlement,
} from "../lib/speechProviders/SpeechProvider";
import {
  clearSpeechInsertionRangeReplacement,
  createSpeechInsertionRange,
  getSpeechInterimDisplayTranscript,
  getSpeechSelectionFinalDelayMs,
  retargetSpeechInsertionRange,
  type SpeechInsertionRange,
} from "../lib/speechRecognition";
import { createSpeechTargetId } from "../lib/speechTargets";
import type { ComposerSpeechState } from "./useComposerSpeechState";

/**
 * A delivery pressed during capture that took the draft and its speech
 * target with it (the in-session box only; plan 178 D2). Later results for
 * that target revise this draft instead of the live field.
 */
export interface DetachedSpeechTransaction {
  draft: string;
  composition: { speechTranscriptionIds: string[] };
  speechInsertionRangeRef: { current: SpeechInsertionRange | null };
  activeSpeechTargetIdRef: { current: string | null };
  speechInsertionRangesRef: { current: Map<string, SpeechInsertionRange> };
  pendingTextareaSelectionRef: {
    current: PendingTextareaSelectionRestore | null;
  };
  pendingSpeechRetargetRef: { current: PendingSpeechRetarget | null };
}

/**
 * One composer's dictation handlers: the voice button's callbacks (listening
 * start and stop, finals and interims, pending-state changes, failed
 * transcriptions) and the caret moves and cancel that retarget or drop the
 * speech target. Shared by the new-session and in-session message boxes
 * (docs/tactical/178-shared-composer-dictation.md); what differs between
 * them comes in as options. Each box calls this where its handlers stood,
 * after the send callbacks the options name.
 */
export function useComposerSpeechHandlers({
  speechState,
  draftControls,
  textareaRef,
  voiceButtonRef,
  pendingSpeechDeliveryRef,
  pendingSpeechDeliverySettledRef,
  noteSpeechAttribution,
  maybeRunPendingSpeechDelivery,
  abandonPendingDelivery,
  onSmartTurnSend,
  getDetachedSpeechTransaction,
  onTranscriptionId,
  onEdit,
  onHeard,
}: {
  speechState: ComposerSpeechState;
  draftControls: {
    getDraft: () => string;
    setDraft: (value: string) => void;
  };
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  voiceButtonRef: RefObject<VoiceInputButtonRef | null>;
  /** Checked and cleared here, never filled; its contents are the box's. */
  pendingSpeechDeliveryRef: { current: unknown };
  pendingSpeechDeliverySettledRef: { current: boolean };
  noteSpeechAttribution: () => void;
  maybeRunPendingSpeechDelivery: () => void;
  /** A failed or cancelled cycle: drop, or restore, the pending delivery. */
  abandonPendingDelivery: () => void;
  onSmartTurnSend: (text: string) => unknown;
  /** The detached delivery transaction, if the box detaches one (D2). */
  getDetachedSpeechTransaction?: () => DetachedSpeechTransaction | null;
  /** Records a transcription id committed into the live draft (D5). */
  onTranscriptionId?: (id: string) => void;
  /** Notes an edit to the live draft (D5). */
  onEdit?: (next: string) => void;
  /** Feeds heard text to a speech vocabulary (D6). */
  onHeard?: (transcript: string) => void;
}) {
  const {
    setInterimTranscript,
    interimTranscriptRef,
    setSpeechPending,
    speechPendingRef,
    speechTransactionHasTextRef,
    setSpeechPreviewRevision,
    speechInsertionRangeRef,
    activeSpeechTargetIdRef,
    speechInsertionRangesRef,
    pendingSpeechRetargetRef,
    pendingSpeechFinalRef,
    composerEditedDuringSpeechRef,
    pendingTextareaSelectionRef,
    clearPendingSpeechFinal,
  } = speechState;

  const handleListeningStart = useCallback(() => {
    speechTransactionHasTextRef.current = false;
    const textarea = textareaRef.current;
    const currentText = draftControls.getDraft();
    const selectionStart = Math.max(
      0,
      Math.min(
        textarea?.selectionStart ?? currentText.length,
        currentText.length,
      ),
    );
    const selectionEnd = Math.max(
      selectionStart,
      Math.min(textarea?.selectionEnd ?? selectionStart, currentText.length),
    );
    const targetId = createSpeechTargetId();
    const range = createSpeechInsertionRange(selectionStart, selectionEnd);
    activeSpeechTargetIdRef.current = targetId;
    speechInsertionRangeRef.current = range;
    speechInsertionRangesRef.current.set(targetId, range);
    pendingTextareaSelectionRef.current = null;
    pendingSpeechRetargetRef.current = null;
    composerEditedDuringSpeechRef.current = false;
    if (textarea) {
      focusComposerForSpeechTransition(textarea);
      textarea.setSelectionRange(selectionStart, selectionEnd);
    }
    interimTranscriptRef.current = "";
    setInterimTranscript("");
  }, [
    draftControls,
    activeSpeechTargetIdRef,
    composerEditedDuringSpeechRef,
    interimTranscriptRef,
    pendingSpeechRetargetRef,
    pendingTextareaSelectionRef,
    setInterimTranscript,
    speechInsertionRangeRef,
    speechInsertionRangesRef,
    speechTransactionHasTextRef,
    textareaRef,
  ]);

  // A caret move. A manual one while an interim shows (or a move is already
  // waiting) waits for the fragment in flight; otherwise the target moves.
  const handleSpeechSelectionTarget = useCallback(
    (manualInteraction = false, draftAtSelection?: string) => {
      const textarea = textareaRef.current;
      const range = speechInsertionRangeRef.current;
      if (!textarea || !range) return;
      const selectionStart = textarea.selectionStart;
      const selectionEnd = textarea.selectionEnd;
      const getNextRange = (
        currentRange: SpeechInsertionRange,
      ): SpeechInsertionRange => {
        if (selectionStart === selectionEnd) {
          return speechPendingRef.current === "listening"
            ? retargetSpeechInsertionRange(
                currentRange,
                selectionStart,
                selectionEnd,
              )
            : clearSpeechInsertionRangeReplacement(currentRange);
        }
        if (
          currentRange.replaceSelectedAtMs === undefined &&
          currentRange.end === selectionStart &&
          currentRange.replaceEnd === selectionEnd
        ) {
          return currentRange;
        }
        return retargetSpeechInsertionRange(
          currentRange,
          selectionStart,
          selectionEnd,
        );
      };

      if (selectionStart === selectionEnd) clearPendingSpeechFinal();
      const hasVisibleInterim = interimTranscriptRef.current.trim().length > 0;
      if (
        manualInteraction &&
        (hasVisibleInterim || pendingSpeechRetargetRef.current !== null)
      ) {
        pendingSpeechRetargetRef.current = {
          draft: draftAtSelection ?? draftControls.getDraft(),
          start: selectionStart,
          end: selectionEnd,
        };
        return;
      }

      const nextRange = getNextRange(range);
      if (speechPendingRef.current === "listening" && nextRange !== range) {
        voiceButtonRef.current?.beginInsertionBoundary();
      }
      speechInsertionRangeRef.current = nextRange;
      if (activeSpeechTargetIdRef.current) {
        speechInsertionRangesRef.current.set(
          activeSpeechTargetIdRef.current,
          nextRange,
        );
      }
      setSpeechPreviewRevision((revision) => revision + 1);
    },
    [
      draftControls,
      activeSpeechTargetIdRef,
      clearPendingSpeechFinal,
      interimTranscriptRef,
      pendingSpeechRetargetRef,
      setSpeechPreviewRevision,
      speechInsertionRangeRef,
      speechInsertionRangesRef,
      speechPendingRef,
      textareaRef,
      voiceButtonRef,
    ],
  );

  const clearSpeechSelectionTarget = useCallback(() => {
    clearPendingSpeechFinal();
    if (!speechInsertionRangeRef.current) return;
    const nextRange = clearSpeechInsertionRangeReplacement(
      speechInsertionRangeRef.current,
    );
    speechInsertionRangeRef.current = nextRange;
    if (activeSpeechTargetIdRef.current) {
      speechInsertionRangesRef.current.set(
        activeSpeechTargetIdRef.current,
        nextRange,
      );
    }
    setSpeechPreviewRevision((revision) => revision + 1);
  }, [
    activeSpeechTargetIdRef,
    clearPendingSpeechFinal,
    setSpeechPreviewRevision,
    speechInsertionRangeRef,
    speechInsertionRangesRef,
  ]);

  const commitVoiceTranscript = useCallback(
    (transcript: string, metadata?: SpeechTranscriptionResultMetadata) => {
      if (transcript.trim() && metadata?.smartTurnCommand !== "cancel") {
        speechTransactionHasTextRef.current = true;
        noteSpeechAttribution();
      }
      pendingSpeechDeliverySettledRef.current = true;
      const pendingDelivery = getDetachedSpeechTransaction?.() ?? null;
      const pendingTargetId = metadata?.speechTargetId;
      const commitsPendingDelivery =
        pendingDelivery !== null &&
        (pendingTargetId
          ? pendingDelivery.speechInsertionRangesRef.current.has(
              pendingTargetId,
            )
          : pendingDelivery.activeSpeechTargetIdRef.current !== null);
      const targetInsertionRangeRef = commitsPendingDelivery
        ? pendingDelivery.speechInsertionRangeRef
        : speechInsertionRangeRef;
      const targetActiveSpeechTargetIdRef = commitsPendingDelivery
        ? pendingDelivery.activeSpeechTargetIdRef
        : activeSpeechTargetIdRef;
      const targetInsertionRangesRef = commitsPendingDelivery
        ? pendingDelivery.speechInsertionRangesRef
        : speechInsertionRangesRef;
      const targetPendingSelectionRef = commitsPendingDelivery
        ? pendingDelivery.pendingTextareaSelectionRef
        : pendingTextareaSelectionRef;
      const targetPendingSpeechRetargetRef = commitsPendingDelivery
        ? pendingDelivery.pendingSpeechRetargetRef
        : pendingSpeechRetargetRef;
      const outcome = commitSpeechTranscript(
        {
          textareaRef: commitsPendingDelivery ? { current: null } : textareaRef,
          getDraft: commitsPendingDelivery
            ? () => pendingDelivery.draft
            : draftControls.getDraft,
          setDraft: commitsPendingDelivery
            ? (next) => {
                pendingDelivery.draft = next;
              }
            : draftControls.setDraft,
          setInterimTranscript: (next) => {
            if (commitsPendingDelivery) return;
            interimTranscriptRef.current = next;
            setInterimTranscript(next);
          },
          speechInsertionRangeRef: targetInsertionRangeRef,
          activeSpeechTargetIdRef: targetActiveSpeechTargetIdRef,
          speechInsertionRangesRef: targetInsertionRangesRef,
          pendingTextareaSelectionRef: targetPendingSelectionRef,
          pendingSpeechRetargetRef: targetPendingSpeechRetargetRef,
          onInsertionBoundary: commitsPendingDelivery
            ? () => {}
            : () => voiceButtonRef.current?.beginInsertionBoundary(),
          onSpeechTargetChanged: commitsPendingDelivery
            ? () => {}
            : () => setSpeechPreviewRevision((revision) => revision + 1),
          onEdit: commitsPendingDelivery ? undefined : onEdit,
          onTranscriptionId: commitsPendingDelivery
            ? (id) => {
                pendingDelivery.composition.speechTranscriptionIds = [
                  ...pendingDelivery.composition.speechTranscriptionIds,
                  id,
                ];
              }
            : onTranscriptionId,
          onSmartTurnSend: commitsPendingDelivery ? undefined : onSmartTurnSend,
          composerEditedDuringSpeech: commitsPendingDelivery
            ? undefined
            : () => composerEditedDuringSpeechRef.current,
        },
        transcript,
        metadata,
      );
      maybeRunPendingSpeechDelivery();
      // An overlapping (non-active) target's batch result has now landed;
      // forget its range. The active target is forgotten on the pending->null
      // transition instead (it may still get more streaming finals).
      const committedTargetId = metadata?.speechTargetId;
      if (
        committedTargetId &&
        committedTargetId !== targetActiveSpeechTargetIdRef.current &&
        targetInsertionRangesRef.current.delete(committedTargetId)
      ) {
        setSpeechPreviewRevision((revision) => revision + 1);
      }
      return outcome;
    },
    [
      draftControls,
      onSmartTurnSend,
      maybeRunPendingSpeechDelivery,
      onEdit,
      noteSpeechAttribution,
      getDetachedSpeechTransaction,
      onTranscriptionId,
      activeSpeechTargetIdRef,
      composerEditedDuringSpeechRef,
      interimTranscriptRef,
      pendingSpeechDeliverySettledRef,
      pendingSpeechRetargetRef,
      pendingTextareaSelectionRef,
      setInterimTranscript,
      setSpeechPreviewRevision,
      speechInsertionRangeRef,
      speechInsertionRangesRef,
      speechTransactionHasTextRef,
      textareaRef,
      voiceButtonRef,
    ],
  );

  const handleVoiceTranscript = useCallback(
    (transcript: string, metadata?: SpeechTranscriptionResultMetadata) => {
      onHeard?.(transcript);
      const pendingDelivery = getDetachedSpeechTransaction?.() ?? null;
      const pendingRange = metadata?.speechTargetId
        ? (pendingDelivery?.speechInsertionRangesRef.current.get(
            metadata.speechTargetId,
          ) ?? null)
        : (pendingDelivery?.speechInsertionRangeRef.current ?? null);
      const speechRange =
        pendingRange ??
        (metadata?.speechTargetId
          ? (speechInsertionRangesRef.current.get(metadata.speechTargetId) ??
            null)
          : speechInsertionRangeRef.current);
      const delayMs = metadata?.smartTurnCommand
        ? 0
        : pendingSpeechRetargetRef.current
          ? 0
          : getSpeechSelectionFinalDelayMs(speechRange);
      if (delayMs > 0) {
        clearPendingSpeechFinal();
        const timer = setTimeout(() => {
          const pending = pendingSpeechFinalRef.current;
          if (!pending || pending.timer !== timer) return;
          pendingSpeechFinalRef.current = null;
          commitVoiceTranscript(pending.transcript, pending.metadata);
        }, delayMs);
        pendingSpeechFinalRef.current = { timer, transcript, metadata };
        return;
      }

      clearPendingSpeechFinal();
      return commitVoiceTranscript(transcript, metadata);
    },
    [
      commitVoiceTranscript,
      onHeard,
      getDetachedSpeechTransaction,
      clearPendingSpeechFinal,
      pendingSpeechFinalRef,
      pendingSpeechRetargetRef,
      speechInsertionRangeRef,
      speechInsertionRangesRef,
    ],
  );

  const flushPendingSpeechFinal = useCallback(() => {
    const pending = pendingSpeechFinalRef.current;
    if (pending === null) return;
    clearTimeout(pending.timer);
    pendingSpeechFinalRef.current = null;
    commitVoiceTranscript(pending.transcript, pending.metadata);
  }, [commitVoiceTranscript, pendingSpeechFinalRef]);

  const handleListeningStop = useCallback(() => {
    const visibleInterim = getSpeechInterimDisplayTranscript(
      draftControls.getDraft(),
      interimTranscriptRef.current,
      speechInsertionRangeRef.current,
    );
    flushPendingSpeechFinal();
    if (visibleInterim) commitVoiceTranscript(visibleInterim);
    pendingSpeechRetargetRef.current = null;
    interimTranscriptRef.current = "";
    setInterimTranscript("");
    focusComposerForSpeechTransition(textareaRef.current);
    return Boolean(visibleInterim);
  }, [
    commitVoiceTranscript,
    draftControls,
    flushPendingSpeechFinal,
    interimTranscriptRef,
    pendingSpeechRetargetRef,
    setInterimTranscript,
    speechInsertionRangeRef,
    textareaRef,
  ]);

  const handleInterimTranscript = useCallback(
    (transcript: string) => {
      interimTranscriptRef.current = transcript;
      setInterimTranscript(transcript);
    },
    [interimTranscriptRef, setInterimTranscript],
  );

  const handlePendingSpeechChange = useCallback(
    (kind: SpeechPendingKind | null, settlement?: SpeechCycleSettlement) => {
      if (settlement === "failed") {
        abandonPendingDelivery();
      } else if (settlement === "completed") {
        if (
          pendingSpeechDeliveryRef.current &&
          speechTransactionHasTextRef.current
        ) {
          noteSpeechAttribution();
        }
        pendingSpeechDeliverySettledRef.current = true;
      }
      speechPendingRef.current = kind;
      if (kind === "listening") handleSpeechSelectionTarget();
      if (kind === null) {
        // The active recording finished (its result has already committed);
        // forget its insertion target so the range map does not accumulate
        // completed targets.
        const targetId = activeSpeechTargetIdRef.current;
        if (targetId) {
          speechInsertionRangesRef.current.delete(targetId);
        }
        speechInsertionRangeRef.current = null;
        activeSpeechTargetIdRef.current = null;
        pendingSpeechRetargetRef.current = null;
      }
      setSpeechPending(kind);
      if (kind === null) maybeRunPendingSpeechDelivery();
    },
    [
      handleSpeechSelectionTarget,
      maybeRunPendingSpeechDelivery,
      noteSpeechAttribution,
      abandonPendingDelivery,
      activeSpeechTargetIdRef,
      pendingSpeechDeliveryRef,
      pendingSpeechDeliverySettledRef,
      pendingSpeechRetargetRef,
      setSpeechPending,
      speechInsertionRangeRef,
      speechInsertionRangesRef,
      speechPendingRef,
      speechTransactionHasTextRef,
    ],
  );

  // A batch transcription that failed or was cancelled (the in-session box
  // wires this; plan 178 D4).
  const handleTranscriptionSettled = useCallback(
    (settlement: SpeechTranscriptionSettlement) => {
      const targetId = settlement.speechTargetId;
      if (!targetId || settlement.status === "completed") return;

      const pendingTargetFailed =
        getDetachedSpeechTransaction?.()?.speechInsertionRangesRef.current.has(
          targetId,
        ) === true;
      if (pendingTargetFailed) {
        abandonPendingDelivery();
        setSpeechPending(null);
        speechPendingRef.current = null;
        setInterimTranscript("");
      }
      const removed = speechInsertionRangesRef.current.delete(targetId);
      const activeTargetFailed = targetId === activeSpeechTargetIdRef.current;
      if (activeTargetFailed) {
        clearPendingSpeechFinal();
        speechInsertionRangeRef.current = null;
        activeSpeechTargetIdRef.current = null;
        pendingSpeechRetargetRef.current = null;
        setSpeechPending(null);
        speechPendingRef.current = null;
        setInterimTranscript("");
        pendingSpeechDeliveryRef.current = null;
        pendingSpeechDeliverySettledRef.current = false;
      }
      if (removed) {
        setSpeechPreviewRevision((revision) => revision + 1);
      }
    },
    [
      abandonPendingDelivery,
      getDetachedSpeechTransaction,
      activeSpeechTargetIdRef,
      clearPendingSpeechFinal,
      pendingSpeechDeliveryRef,
      pendingSpeechDeliverySettledRef,
      pendingSpeechRetargetRef,
      setInterimTranscript,
      setSpeechPending,
      setSpeechPreviewRevision,
      speechInsertionRangeRef,
      speechInsertionRangesRef,
      speechPendingRef,
    ],
  );

  // Cancel a pending transcription/finalization. The provider discards the
  // in-flight result (keeping any committed text); here we drop the pending
  // speech target so the composer forgets the reserved insertion point.
  const handleCancelTranscription = useCallback(() => {
    voiceButtonRef.current?.cancelProcessing();
    abandonPendingDelivery();
    clearPendingSpeechFinal();
    const targetId = activeSpeechTargetIdRef.current;
    if (targetId) {
      speechInsertionRangesRef.current.delete(targetId);
    }
    speechInsertionRangeRef.current = null;
    activeSpeechTargetIdRef.current = null;
    pendingSpeechRetargetRef.current = null;
    setSpeechPending(null);
    speechPendingRef.current = null;
    setInterimTranscript("");
  }, [
    abandonPendingDelivery,
    activeSpeechTargetIdRef,
    clearPendingSpeechFinal,
    pendingSpeechRetargetRef,
    setInterimTranscript,
    setSpeechPending,
    speechInsertionRangeRef,
    speechInsertionRangesRef,
    speechPendingRef,
    voiceButtonRef,
  ]);

  return {
    handleListeningStart,
    handleSpeechSelectionTarget,
    clearSpeechSelectionTarget,
    commitVoiceTranscript,
    handleVoiceTranscript,
    flushPendingSpeechFinal,
    handleListeningStop,
    handleInterimTranscript,
    handlePendingSpeechChange,
    handleTranscriptionSettled,
    handleCancelTranscription,
  };
}
