import { describe, expect, it } from "vitest";
import type { RenderItem } from "@yep-anywhere/shared/transcript/items";
import {
  collectAsyncQuestions,
  getQuestionReminderStage,
} from "./asyncQuestions";

describe("async question reminders", () => {
  it("counts questions separately and ages them by subsequent user prompts", () => {
    const items: RenderItem[] = [
      {
        type: "text",
        id: "question-text",
        text: "Choose a color",
        sourceMessages: [
          {
            type: "assistant",
            uuid: "question-message",
            codexAgentMessageDelivery: "async",
            codexAsyncQuestions: [
              { title: "Choose a color", options: ["Blue", "Green"] },
              { title: "Anything else?", options: null },
            ],
          },
        ],
      },
      {
        type: "user_prompt",
        id: "reply",
        content: "Continue the work",
        sourceMessages: [],
      },
      {
        type: "text",
        id: "ordinary",
        text: "Another update",
        sourceMessages: [],
      },
    ];
    const questions = collectAsyncQuestions(items);
    expect(
      questions.map(({ title, age, renderId }) => ({ title, age, renderId })),
    ).toEqual([
      { title: "Choose a color", age: 1, renderId: "question-text" },
      { title: "Anything else?", age: 1, renderId: "question-text" },
    ]);
    expect(collectAsyncQuestions([items[0]!, ...items])).toHaveLength(2);
  });

  it("ages visibility in two stages without treating typing as an answer", () => {
    expect(getQuestionReminderStage(0, 0)).toBe("recent");
    expect(getQuestionReminderStage(3, 0)).toBe("quiet");
    expect(getQuestionReminderStage(0, 160)).toBe("quiet");
    expect(getQuestionReminderStage(8, 0)).toBe("retired");
    expect(getQuestionReminderStage(0, 600)).toBe("retired");
  });
});
