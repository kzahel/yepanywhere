import { type KeyboardEvent, type RefObject, useState } from "react";
import {
  type ComposerTurnRecallEntry,
  filterComposerTurnRecall,
} from "../lib/composerTurnRecall";

/** What the recall drawer reads from the composer's `turnRecall` prop. */
export interface ComposerTurnRecallSource {
  entries: ComposerTurnRecallEntry[];
  onGoToTurn?: (id: string) => void;
}

/**
 * One composer's recall drawer (always-on Ctrl+↑ prior-user-turn recall):
 * its open state, opening, cancel, accept and go-to, and the keys it claims
 * while open. It reaches the composer only through the draft text, its
 * setter, the edit-timing note and the textarea ref. The composer keeps the
 * opener button and the blur cancel. See topics/composer-recall-drawer.md.
 */
export function useComposerRecallDrawer({
  text,
  setText,
  noteComposerEdit,
  textareaRef,
  hasNonTextComposerContent,
  turnRecall,
}: {
  text: string;
  setText: (value: string) => void;
  noteComposerEdit: (nextText: string) => void;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  hasNonTextComposerContent: boolean;
  turnRecall: ComposerTurnRecallSource | undefined;
}) {
  // Composer recall drawer (always-on Ctrl+↑ prior-user-turn recall). Open
  // while non-null; matches are frozen at open time (any editing keystroke
  // closes it), so the draft stays constant while it is shown.
  const [recallDrawer, setRecallDrawer] = useState<{
    matches: ComposerTurnRecallEntry[];
    index: number;
    originalDraft: string;
  } | null>(null);

  // Open the recall drawer over the prior user turns that prefix-match the
  // current draft (empty draft → all). No-op with nothing to show. Shared by
  // Ctrl+↑ and the mobile open button. Returns whether it opened.
  const openRecallDrawer = (): boolean => {
    if (
      hasNonTextComposerContent ||
      !turnRecall ||
      turnRecall.entries.length === 0
    ) {
      return false;
    }
    const matches = filterComposerTurnRecall(turnRecall.entries, text);
    if (matches.length === 0) {
      return false;
    }
    setRecallDrawer({ matches, index: 0, originalDraft: text });
    return true;
  };
  // Cancel the recall drawer, restoring the pre-open draft (Esc / click-away).
  const cancelRecallDrawer = () => {
    if (recallDrawer) {
      setText(recallDrawer.originalDraft);
      setRecallDrawer(null);
    }
  };
  // Accept a recall entry: draft its full text and close the drawer.
  const acceptRecallEntry = (entry: ComposerTurnRecallEntry) => {
    noteComposerEdit(entry.text);
    setText(entry.text);
    setRecallDrawer(null);
    textareaRef.current?.focus();
  };
  // Go to a recalled turn: scroll the transcript to it and close the drawer.
  // Navigation, not recall — the composer text is left untouched and the Esc
  // draft-restore is deliberately skipped (nothing was drafted to restore).
  const goToRecallTurn = (entry: ComposerTurnRecallEntry) => {
    turnRecall?.onGoToTurn?.(entry.id);
    setRecallDrawer(null);
  };
  // Hovering a row (or its go-to control) makes it the active row.
  const highlightRecallEntry = (index: number) =>
    setRecallDrawer((current) => (current ? { ...current, index } : current));

  // The drawer's keys while open, then the Ctrl+↑ opener. Returns true when
  // the drawer claimed the key and the composer must stop handling it. The
  // composer calls it after its bang Ctrl+↑ history block; see the call site.
  const handleRecallDrawerKeyDown = (e: KeyboardEvent): boolean => {
    if (recallDrawer) {
      if (
        (e.key === "ArrowUp" || e.key === "ArrowDown") &&
        !e.metaKey &&
        !e.altKey
      ) {
        e.preventDefault();
        const delta = e.key === "ArrowDown" ? 1 : -1;
        setRecallDrawer((current) =>
          current
            ? {
                ...current,
                index:
                  (current.index + delta + current.matches.length) %
                  current.matches.length,
              }
            : current,
        );
        return true;
      }
      if (
        e.key === "Enter" &&
        !e.ctrlKey &&
        !e.metaKey &&
        !e.shiftKey &&
        !e.altKey
      ) {
        e.preventDefault();
        const entry = recallDrawer.matches[recallDrawer.index];
        if (entry) {
          acceptRecallEntry(entry);
        } else {
          setRecallDrawer(null);
        }
        return true;
      }
      if (
        e.key === "Escape" &&
        !e.ctrlKey &&
        !e.metaKey &&
        !e.shiftKey &&
        !e.altKey
      ) {
        e.preventDefault();
        cancelRecallDrawer();
        return true;
      }
      // Any other key dismisses the drawer and types normally (no
      // preventDefault, falls through to the composer).
      setRecallDrawer(null);
    }

    // Ctrl+↑ opens the recall drawer over prior user turns prefix-matched by
    // the current draft. Only reached when no bang shell-recall claimed it.
    if (
      e.key === "ArrowUp" &&
      e.ctrlKey &&
      !e.metaKey &&
      !e.shiftKey &&
      !e.altKey &&
      !recallDrawer
    ) {
      if (openRecallDrawer()) {
        e.preventDefault();
        return true;
      }
    }
    return false;
  };

  return {
    recallDrawer,
    openRecallDrawer,
    cancelRecallDrawer,
    acceptRecallEntry,
    goToRecallTurn,
    highlightRecallEntry,
    handleRecallDrawerKeyDown,
  };
}
