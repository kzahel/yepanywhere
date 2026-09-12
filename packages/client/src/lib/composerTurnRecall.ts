import type { ContentBlock, Message } from "../types";
import { isPlainUserTurn } from "./linearMessageDedup";
import { getMessageId } from "@yep-anywhere/shared/transcript/message";
import { getMessageContent } from "./mergeMessages";
import {
  getPromptTextForCorrection,
  getSearchPreviewFallback,
} from "./sessionDetail/search";

/**
 * One recallable prior user turn for the composer recall drawer.
 * See topics/composer-recall-drawer.md.
 */
export interface ComposerTurnRecallEntry {
  /**
   * Render id of the source user-turn message (`getMessageId` = uuid ?? id).
   * This is exactly the `data-render-id` of the transcript row and the `id`
   * that `getUserTurnNavAnchors` / `scrollToRenderId` / `findRenderRow` use,
   * so the go-to-turn control can scroll to this turn. See
   * topics/composer-recall-drawer.md.
   */
  id: string;
  /** Full prompt text, drafted verbatim into the composer on Enter. */
  text: string;
  /** Single-line, whitespace-collapsed, ~180-char preview for the menu row. */
  preview: string;
}

function extractUserTurnText(message: Message): string {
  const content = getMessageContent(message);
  if (typeof content !== "string" && !Array.isArray(content)) {
    return "";
  }
  return getPromptTextForCorrection(content as string | ContentBlock[]);
}

/**
 * One plain user turn as extracted from the messages array — the *undeduped*
 * incremental state. Dedup keeps only the newest occurrence of a text, so a
 * deduped list could not survive removals (replacing the tail that held the
 * newest "git status" must resurrect the older one); keeping every occurrence
 * makes truncate-and-rescan exact.
 */
interface RecallUserTurn {
  /** Position in the last processed messages array. */
  index: number;
  id: string;
  text: string;
  preview: string;
}

function buildEntries(
  userTurns: readonly RecallUserTurn[],
): ComposerTurnRecallEntry[] {
  const entries: ComposerTurnRecallEntry[] = [];
  const seen = new Set<string>();
  for (let index = userTurns.length - 1; index >= 0; index -= 1) {
    const turn = userTurns[index] as RecallUserTurn;
    if (seen.has(turn.text)) {
      continue;
    }
    seen.add(turn.text);
    // Newest-first + dedup-by-text means the retained entry is the most recent
    // occurrence, so its id points at the latest rendered row for that text.
    entries.push({ id: turn.id, text: turn.text, preview: turn.preview });
  }
  return entries;
}

function entriesEqual(
  a: readonly ComposerTurnRecallEntry[],
  b: readonly ComposerTurnRecallEntry[],
): boolean {
  if (a.length !== b.length) return false;
  return a.every(
    (entry, index) =>
      entry.id === b[index]?.id && entry.text === b[index]?.text,
  );
}

export interface ComposerTurnRecallCache {
  /** Entries for `messages`, reusing work from the previously derived array. */
  derive(messages: readonly Message[]): ComposerTurnRecallEntry[];
}

/**
 * Incremental derivation of recall entries: user turns only, full prompt text
 * extracted, empties dropped, deduplicated by text, newest-first.
 *
 * Each derive diffs the new array against the previous one by reference
 * equality, truncates the cached user-turn list at the first divergent
 * position, and rescans only the changed suffix; the first derive is the same
 * increment against an empty previous array. This assumes message objects are
 * immutable snapshots (the session-detail layer replaces an object when its
 * content changes — the same assumption the render path's memoization makes):
 * reference-equal means content-equal. Correct for arbitrary input sequences
 * — an append, a replaced tail (streaming ticks, pending→confirmed turns,
 * steer-echo release), or a prepend (older-history load) merely move the
 * divergence point; efficiency is best when changes stay near the tail. The
 * deduped entry list is rebuilt from the cached user turns only when one of
 * them changed, and keeps its array identity when the result is equal, so a
 * streaming tick costs a pointer-compare walk and returns the same array.
 */
export function createComposerTurnRecallCache(): ComposerTurnRecallCache {
  let previous: readonly Message[] = [];
  const userTurns: RecallUserTurn[] = [];
  let entries: ComposerTurnRecallEntry[] = [];
  return {
    derive(messages) {
      if (messages === previous) {
        return entries;
      }
      const shared = Math.min(previous.length, messages.length);
      let prefix = 0;
      while (prefix < shared && previous[prefix] === messages[prefix]) {
        prefix += 1;
      }
      let changed = false;
      while (
        userTurns.length > 0 &&
        (userTurns[userTurns.length - 1] as RecallUserTurn).index >= prefix
      ) {
        userTurns.pop();
        changed = true;
      }
      for (let index = prefix; index < messages.length; index += 1) {
        const message = messages[index];
        if (!message || !isPlainUserTurn(message)) {
          continue;
        }
        const text = extractUserTurnText(message);
        if (!text.trim()) {
          continue;
        }
        userTurns.push({
          index,
          id: getMessageId(message),
          text,
          preview: getSearchPreviewFallback(text),
        });
        changed = true;
      }
      previous = messages;
      if (changed) {
        const rebuilt = buildEntries(userTurns);
        if (!entriesEqual(rebuilt, entries)) {
          entries = rebuilt;
        }
      }
      return entries;
    },
  };
}

/**
 * Prior user-turn recall entries derived from the live session messages —
 * the one-shot form of {@link createComposerTurnRecallCache}: a single
 * increment against an empty previous array. Pure. See
 * topics/composer-recall-drawer.md.
 */
export function getComposerTurnRecallEntries(
  messages: readonly Message[],
): ComposerTurnRecallEntry[] {
  return createComposerTurnRecallCache().derive(messages);
}

/**
 * Entries whose text prefix-matches the current draft (case-insensitive,
 * trimmed). Empty draft returns every entry. Newest-first order is preserved.
 */
export function filterComposerTurnRecall(
  entries: readonly ComposerTurnRecallEntry[],
  draft: string,
): ComposerTurnRecallEntry[] {
  const needle = draft.trim().toLowerCase();
  if (!needle) {
    return entries.slice();
  }
  return entries.filter((entry) =>
    entry.text.trim().toLowerCase().startsWith(needle),
  );
}
