import type { RenderItem } from "@yep-anywhere/shared/transcript/items";
import { getMessageId } from "@yep-anywhere/shared/transcript/message";
import {
  collectQuoteReplies,
  quoteReplyKey,
} from "@yep-anywhere/shared/transcript/quoteReplies";
import { contentBlocksText } from "@yep-anywhere/shared/transcript/slashCommandBodies";
import { parseTimestampMs } from "./messageAge";

export interface AsyncQuestion {
  id: string;
  messageId: string;
  renderId: string;
  index: number;
  title: string;
  options: readonly string[];
  age: number;
  /** When the question's message was recorded, when known. */
  askedAtMs?: number;
  /**
   * The session's last activity, for a server preview that lacks the
   * question's own time. The question is at least this old.
   */
  sessionActivityMs?: number;
  answer?: string;
}

/**
 * A question this old stops reminding even when no turns follow it, as in a
 * session left idle; turns alone never age it there.
 */
export const QUESTION_REMINDER_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;

/** Time since the question was asked (or, failing that, last activity). */
export function getQuestionElapsedMs(
  question: Pick<AsyncQuestion, "askedAtMs" | "sessionActivityMs">,
  nowMs: number,
): number | undefined {
  const since = question.askedAtMs ?? question.sessionActivityMs;
  return since === undefined ? undefined : Math.max(0, nowMs - since);
}

export type QuestionReminderStage = "recent" | "quiet" | "retired";

export function getQuestionReminderThresholds(turns: number) {
  return {
    countTurns: turns,
    countEdits: Math.round((turns * 160) / 3),
    overflowTurns: Math.ceil((turns * 8) / 3),
    overflowEdits: turns * 200,
  };
}

export function getQuestionReminderStage(
  turns: number,
  edits: number,
  reminderTurns = 3,
  elapsedMs?: number,
): QuestionReminderStage {
  if (elapsedMs !== undefined && elapsedMs >= QUESTION_REMINDER_MAX_AGE_MS)
    return "retired";
  const limits = getQuestionReminderThresholds(reminderTurns);
  if (turns >= limits.overflowTurns || edits >= limits.overflowEdits)
    return "retired";
  if (turns >= limits.countTurns || edits >= limits.countEdits) return "quiet";
  return "recent";
}

export function collectAsyncQuestions(
  items: readonly RenderItem[],
): AsyncQuestion[] {
  const questions: AsyncQuestion[] = [];
  const seen = new Set<string>();
  const turns = new Set<string>();
  const replies = new Map<string, string>();
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]!;
    if (item.type === "user_prompt") {
      turns.add(item.id);
      if (turns.size < 32)
        for (const [key, answer] of collectQuoteReplies(
          contentBlocksText(item.content),
        ))
          if (!replies.has(key)) replies.set(key, answer);
    }
    if (item.type !== "text") continue;
    for (const message of item.sourceMessages) {
      const messageId = getMessageId(message);
      if (!messageId || message.codexAgentMessageDelivery !== "async") continue;
      const structured = message.codexAsyncQuestions;
      if (!structured) continue;
      for (let index = structured.length - 1; index >= 0; index--) {
        const question = structured[index]!;
        const id = JSON.stringify([messageId, index]);
        if (seen.has(id)) continue;
        seen.add(id);
        const key = quoteReplyKey(question.title);
        const answer = turns.size < 32 ? replies.get(key) : undefined;
        replies.delete(key);
        const askedAtMs = parseTimestampMs(message.timestamp);
        questions.push({
          id,
          messageId,
          renderId: item.id,
          index,
          title: question.title,
          options: question.options ?? [],
          age: turns.size,
          ...(askedAtMs === null ? {} : { askedAtMs }),
          ...(answer === undefined ? {} : { answer }),
        });
      }
    }
  }
  return questions.reverse();
}
