import type { ClipboardEvent, KeyboardEvent } from "react";
import type { SpeechPendingKind } from "../components/VoiceInputButton";
import { ENTER_SENDS_MESSAGE } from "../constants";
import { hasCoarsePointer } from "./deviceDetection";

/**
 * Key and paste rules both message boxes apply the same way
 * (docs/tactical/178-shared-composer-dictation.md slice 3). Each box keeps
 * its own key order and the guards that run before these (plan 178 D8, D11).
 */

const hasModifier = (e: KeyboardEvent) =>
  e.ctrlKey || e.metaKey || e.shiftKey || e.altKey;

/**
 * Escape while dictating: cancel a transcription still pending after
 * capture, else stop listening (which keeps the result). Returns true when
 * it took the key.
 */
export function handleSpeechEscapeKey(
  e: KeyboardEvent,
  {
    speechPending,
    voice,
    cancelTranscription,
  }: {
    speechPending: SpeechPendingKind | null;
    voice: { isListening: boolean; toggle: () => void } | null | undefined;
    cancelTranscription: () => void;
  },
): boolean {
  if (e.key !== "Escape" || hasModifier(e)) return false;
  // Escape cancels a pending post-capture wait, dropping the uncommitted
  // result while keeping any already-committed text. Active listening still
  // finalizes on Escape below.
  if (speechPending === "transcribing" || speechPending === "finalizing") {
    e.preventDefault();
    e.stopPropagation();
    cancelTranscription();
    return true;
  }
  if (voice?.isListening) {
    e.preventDefault();
    e.stopPropagation();
    voice.toggle();
    return true;
  }
  return false;
}

/**
 * Whether a plain Enter (already past IME composition and the box's own
 * shortcuts) sends. On touch devices Enter adds a newline and the send
 * button sends. On desktop, with Enter-sends on, Enter sends and
 * Shift/Ctrl+Enter add a newline; with it off, Shift/Ctrl+Enter send.
 */
export function isComposerEnterSend(e: KeyboardEvent): boolean {
  if (hasCoarsePointer()) return false;
  const modified = e.ctrlKey || e.shiftKey;
  return ENTER_SENDS_MESSAGE ? !modified : modified;
}

/** The files in a paste; text-only pastes have none. */
export function getClipboardFiles(e: ClipboardEvent): File[] {
  const items = e.clipboardData?.items;
  if (!items) return [];
  const files: File[] = [];
  for (const item of items) {
    if (item.kind === "file") {
      const file = item.getAsFile();
      if (file) {
        files.push(file);
      }
    }
  }
  return files;
}
