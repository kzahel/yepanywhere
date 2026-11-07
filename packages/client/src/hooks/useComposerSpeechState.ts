import { useCallback, useRef, useState } from "react";
import type { SpeechPendingKind } from "../components/VoiceInputButton";
import {
  hasNonWhitespaceEdit,
  type PendingSpeechRetarget,
  type PendingTextareaSelectionRestore,
} from "../lib/speechDraftTransaction";
import type { SpeechTranscriptionResultMetadata } from "../lib/speechProviders/SpeechProvider";
import {
  clearSpeechInsertionRangeReplacement,
  mapSpeechInsertionRangeThroughEdit,
  mapSpeechInsertionRangeThroughReplacement,
  type SpeechInsertionRange,
} from "../lib/speechRecognition";

/** A recognizer final held briefly so a caret move can retarget it. */
export interface PendingSpeechFinal {
  timer: ReturnType<typeof setTimeout>;
  transcript: string;
  metadata?: SpeechTranscriptionResultMetadata;
}

/**
 * One composer's dictation state: where dictated text lands (the active
 * insertion target and every target still awaiting a result), the interim
 * text, the voice button's pending kind, and the bookkeeping a textarea edit
 * or replacement applies to them. Shared by the new-session and in-session
 * message boxes (docs/tactical/178-shared-composer-dictation.md). Each box
 * keeps its own effects and calls the returned functions from them.
 */
export function useComposerSpeechState() {
  const [interimTranscript, setInterimTranscript] = useState("");
  const interimTranscriptRef = useRef(interimTranscript);
  interimTranscriptRef.current = interimTranscript;
  const [speechPending, setSpeechPending] = useState<SpeechPendingKind | null>(
    null,
  );
  const speechPendingRef = useRef<SpeechPendingKind | null>(null);
  const speechTransactionHasTextRef = useRef(false);
  const [, setSpeechPreviewRevision] = useState(0);
  const speechTurnIdRef = useRef<string | null>(null);
  const speechInsertionRangeRef = useRef<SpeechInsertionRange | null>(null);
  const activeSpeechTargetIdRef = useRef<string | null>(null);
  const speechInsertionRangesRef = useRef<Map<string, SpeechInsertionRange>>(
    new Map(),
  );
  const pendingSpeechRetargetRef = useRef<PendingSpeechRetarget | null>(null);
  const pendingSpeechFinalRef = useRef<PendingSpeechFinal | null>(null);
  // True once the user manually edits (non-whitespace) during the active mic
  // transaction; holds an automatic Smart Turn endpoint send. Speech-inserted
  // finals go through setDraft (not onChange) and never set this.
  const composerEditedDuringSpeechRef = useRef(false);
  const pendingTextareaSelectionRef =
    useRef<PendingTextareaSelectionRestore | null>(null);

  const clearPendingSpeechFinal = useCallback(() => {
    const pending = pendingSpeechFinalRef.current;
    if (pending === null) return;
    clearTimeout(pending.timer);
    pendingSpeechFinalRef.current = null;
  }, []);

  // Point the active target at its range in a new range map.
  const setSpeechInsertionRanges = useCallback(
    (nextRanges: Map<string, SpeechInsertionRange>) => {
      speechInsertionRangesRef.current = nextRanges;
      speechInsertionRangeRef.current =
        activeSpeechTargetIdRef.current !== null
          ? (nextRanges.get(activeSpeechTargetIdRef.current) ?? null)
          : null;
    },
    [],
  );

  const noteManualEditDuringSpeech = useCallback(
    (previousText: string, nextText: string) => {
      if (
        activeSpeechTargetIdRef.current !== null &&
        hasNonWhitespaceEdit(previousText, nextText)
      ) {
        composerEditedDuringSpeechRef.current = true;
      }
    },
    [],
  );

  // A user edit in the textarea (its onChange): drop a held final, carry
  // every insertion target through the edit, and note a manual edit during
  // speech. Runs on every keystroke.
  const noteSpeechDraftEdit = useCallback(
    (previousText: string, nextText: string) => {
      clearPendingSpeechFinal();
      if (speechInsertionRangesRef.current.size > 0) {
        const nextRanges = new Map<string, SpeechInsertionRange>();
        for (const [targetId, range] of speechInsertionRangesRef.current) {
          nextRanges.set(
            targetId,
            clearSpeechInsertionRangeReplacement(
              mapSpeechInsertionRangeThroughEdit(previousText, nextText, range),
            ),
          );
        }
        setSpeechInsertionRanges(nextRanges);
      }
      noteManualEditDuringSpeech(previousText, nextText);
    },
    [
      clearPendingSpeechFinal,
      noteManualEditDuringSpeech,
      setSpeechInsertionRanges,
    ],
  );

  // The same for a programmatic range replacement through
  // replaceDraftRangeUndoably (a completion or transferred-text insert).
  const noteSpeechDraftReplacement = useCallback(
    (
      previousText: string,
      nextText: string,
      replacementStart: number,
      replacementEnd: number,
      replacementLength: number,
    ) => {
      clearPendingSpeechFinal();
      if (speechInsertionRangesRef.current.size > 0) {
        const nextRanges = new Map<string, SpeechInsertionRange>();
        for (const [targetId, range] of speechInsertionRangesRef.current) {
          nextRanges.set(
            targetId,
            clearSpeechInsertionRangeReplacement(
              mapSpeechInsertionRangeThroughReplacement(
                range,
                replacementStart,
                replacementEnd,
                replacementLength,
              ),
            ),
          );
        }
        setSpeechInsertionRanges(nextRanges);
      }
      noteManualEditDuringSpeech(previousText, nextText);
    },
    [
      clearPendingSpeechFinal,
      noteManualEditDuringSpeech,
      setSpeechInsertionRanges,
    ],
  );

  // Restore a selection saved across a programmatic draft change once the
  // textarea shows that draft. Each box calls it from its layout effect.
  const restorePendingTextareaSelection = useCallback(
    (text: string, textarea: HTMLTextAreaElement | null) => {
      const pending = pendingTextareaSelectionRef.current;
      if (
        !pending ||
        !textarea ||
        text !== pending.value ||
        textarea.value !== pending.value
      ) {
        return;
      }
      pendingTextareaSelectionRef.current = null;
      pending.restore(textarea);
    },
    [],
  );

  return {
    interimTranscript,
    setInterimTranscript,
    interimTranscriptRef,
    speechPending,
    setSpeechPending,
    speechPendingRef,
    speechTransactionHasTextRef,
    setSpeechPreviewRevision,
    speechTurnIdRef,
    speechInsertionRangeRef,
    activeSpeechTargetIdRef,
    speechInsertionRangesRef,
    pendingSpeechRetargetRef,
    pendingSpeechFinalRef,
    composerEditedDuringSpeechRef,
    pendingTextareaSelectionRef,
    clearPendingSpeechFinal,
    noteSpeechDraftEdit,
    noteSpeechDraftReplacement,
    restorePendingTextareaSelection,
  };
}
