import { describe, expect, it } from "vitest";
import type { RenderItem } from "@yep-anywhere/shared/transcript/items";
import {
  collectAsyncQuestions,
  getQuestionElapsedMs,
  getQuestionReminderStage,
  QUESTION_REMINDER_MAX_AGE_MS,
} from "./asyncQuestions";

describe("async question reminders", () => {
  it("counts questions separately and ages them by subsequent user prompts", () => {
    const items: RenderItem[] = [
      {
        type: "text",
        sourceBlockIndex: 0,
        id: "question-text",
        text: "Choose a color",
        sourceMessages: [
          {
            type: "assistant",
            uuid: "question-message",
            timestamp: "2026-11-10T08:00:00.000Z",
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
        sourceBlockIndex: 0,
        id: "ordinary",
        text: "Another update",
        sourceMessages: [],
      },
    ];
    const questions = collectAsyncQuestions(items);
    const askedAtMs = Date.parse("2026-11-10T08:00:00.000Z");
    expect(
      questions.map(({ title, age, renderId, askedAtMs }) => ({
        title,
        age,
        renderId,
        askedAtMs,
      })),
    ).toEqual([
      { title: "Choose a color", age: 1, renderId: "question-text", askedAtMs },
      { title: "Anything else?", age: 1, renderId: "question-text", askedAtMs },
    ]);
    expect(collectAsyncQuestions([items[0]!, ...items])).toHaveLength(2);
  });

  it("recovers a sent quote reply without saved browser records", () => {
    const question: RenderItem = {
      type: "text",
      sourceBlockIndex: 0,
      id: "question",
      text: "First line\nSecond line?",
      sourceMessages: [
        {
          type: "assistant",
          uuid: "source",
          codexAgentMessageDelivery: "async",
          codexAsyncQuestions: [
            { title: "First line\nSecond line?", options: null },
          ],
        },
      ],
    };
    const reply: RenderItem = {
      type: "user_prompt",
      id: "reply",
      content: "> First line\n> Second line?\n\nUse the new defaults.",
      sourceMessages: [],
    };
    expect(collectAsyncQuestions([question, reply])[0]).toMatchObject({
      answer: "Use the new defaults.",
    });
    expect(
      collectAsyncQuestions([
        question,
        {
          ...reply,
          content: [{ type: "text", text: reply.content as string }],
        },
      ])[0],
    ).toMatchObject({ answer: "Use the new defaults." });
    expect(collectAsyncQuestions([reply, question])[0]).not.toHaveProperty(
      "answer",
    );
    for (const content of [
      "Continue",
      "> First line\n\nYes",
      "> First line\n> Second line?",
    ])
      expect(
        collectAsyncQuestions([question, { ...reply, content }])[0],
      ).not.toHaveProperty("answer");
    const repeated = {
      ...question,
      id: "repeated",
      sourceMessages: [
        {
          ...question.sourceMessages[0]!,
          uuid: "repeated-source",
        },
      ],
    };
    expect(
      collectAsyncQuestions([question, repeated, reply]).map((q) => q.answer),
    ).toEqual([undefined, "Use the new defaults."]);
    const later = Array.from(
      { length: 32 },
      (_, index): RenderItem => ({
        type: "user_prompt",
        id: `later-${index}`,
        content: "Continue",
        sourceMessages: [],
      }),
    );
    expect(
      collectAsyncQuestions([question, reply, ...later])[0],
    ).not.toHaveProperty("answer");
  });

  it("ages visibility in two stages without treating typing as an answer", () => {
    expect(getQuestionReminderStage(0, 0)).toBe("recent");
    expect(getQuestionReminderStage(3, 0)).toBe("quiet");
    expect(getQuestionReminderStage(0, 160)).toBe("quiet");
    expect(getQuestionReminderStage(8, 0)).toBe("retired");
    expect(getQuestionReminderStage(0, 600)).toBe("retired");
  });

  it("retires a question by its age when no turns follow it", () => {
    const now = Date.parse("2026-11-13T08:00:00.000Z");
    const day = 24 * 60 * 60 * 1000;
    const stale = now - QUESTION_REMINDER_MAX_AGE_MS;
    expect(
      getQuestionReminderStage(0, 0, 3, getQuestionElapsedMs({}, now)),
    ).toBe("recent");
    expect(
      getQuestionReminderStage(
        0,
        0,
        3,
        getQuestionElapsedMs({ askedAtMs: now - day }, now),
      ),
    ).toBe("recent");
    expect(
      getQuestionReminderStage(
        0,
        0,
        3,
        getQuestionElapsedMs({ askedAtMs: stale }, now),
      ),
    ).toBe("retired");
    // Without its own time, a preview is at least as old as the session's
    // last activity; its own time wins when present.
    expect(
      getQuestionElapsedMs({ sessionActivityMs: stale }, now),
    ).toBe(QUESTION_REMINDER_MAX_AGE_MS);
    expect(
      getQuestionElapsedMs({ askedAtMs: now - day, sessionActivityMs: now }, now),
    ).toBe(day);
  });
});
