import type { RenderItem } from "@yep-anywhere/shared/transcript/items";
import { getMessageId } from "@yep-anywhere/shared/transcript/message";

export interface AsyncQuestion {
  id: string;
  messageId: string;
  renderId: string;
  index: number;
  title: string;
  options: readonly string[];
  age: number;
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
): QuestionReminderStage {
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
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]!;
    if (item.type === "user_prompt") turns.add(item.id);
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
        questions.push({
          id,
          messageId,
          renderId: item.id,
          index,
          title: question.title,
          options: question.options ?? [],
          age: turns.size,
        });
      }
    }
  }
  return questions.reverse();
}
