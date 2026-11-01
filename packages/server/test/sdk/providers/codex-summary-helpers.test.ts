import { parseNativeSessionId } from "@yep-anywhere/shared";
import { HELPER_SIDE_MODEL_CHEAPEST } from "@yep-anywhere/shared";
import { describe, expect, it, vi } from "vitest";
import {
  captureCodexSummaryTextFromNotification,
  captureCodexSummaryTextFromTurnItems,
  cleanCodexRecapText,
  cleanCodexSummaryText,
  createCodexForkSummaryPrompt,
  createCodexForkSummaryThreadResumeParams,
  createCodexRecapPrompt,
  extractCodexRawResponseMessageText,
  joinCodexSummaryText,
  resolveCodexRecapHelperModel,
  selectCodexRecapHelperModel,
  type CodexSummaryItemNormalizer,
} from "../../../src/sdk/providers/codex-summary-helpers.js";

const normalizeThreadItem: CodexSummaryItemNormalizer = (item) => {
  const record = item as Record<string, unknown>;
  const id = typeof record.id === "string" ? record.id : "";
  const type = typeof record.type === "string" ? record.type : "";
  const text = typeof record.text === "string" ? record.text : undefined;
  return id && type ? { id, type, text } : null;
};

describe("Codex summary helpers", () => {
  it("builds bounded side-session recap prompts", () => {
    expect(() => createCodexRecapPrompt([" ", "\n"])).toThrow(
      "No recent assistant text to summarize",
    );

    const prompt = createCodexRecapPrompt([" first turn ", "second turn"]);
    expect(prompt).toContain("Recap in under 40 words");
    expect(prompt).toContain("--- Assistant turn 1 ---\nfirst turn");
    expect(prompt).toContain("--- Assistant turn 2 ---\nsecond turn");

    const oversized = "x".repeat(6001);
    const capped = createCodexRecapPrompt(["old turn", oversized]);
    expect(capped).not.toContain("old turn");
    expect(capped.split("--- Assistant turn 1 ---\n")[1]).toHaveLength(6000);
  });

  it("builds fork summary prompts for recaps, retitles, and handoffs", () => {
    expect(
      createCodexForkSummaryPrompt({
        purpose: "recap",
        strategy: "fork",
        generatorSessionId: parseNativeSessionId("thread-1"),
        cwd: "/tmp/project",
        model: "gpt-5.6-sol",
      }),
    ).toContain("Recap the current session state in under 40 words");

    const retitle = createCodexForkSummaryPrompt({
      purpose: "session-retitle",
      strategy: "fork",
      generatorSessionId: parseNativeSessionId("thread-1"),
      cwd: "/tmp/project",
      model: "gpt-5.6-sol",
      currentTitle: "  Old title  ",
      lengthTarget: 72,
    });
    expect(retitle).toContain("Target length: under 72 characters.");
    expect(retitle).toContain("Current title: Old title");

    const handoff = createCodexForkSummaryPrompt({
      purpose: "fork-after-summary",
      strategy: "fork",
      generatorSessionId: parseNativeSessionId("thread-1"),
      cwd: "/tmp/project",
      model: "gpt-5.6-sol",
      afterTurnMessageId: "turn-2",
      afterTurnContext: "  tests passed  ",
      instructions: "  keep it terse  ",
    });
    expect(handoff).toContain("Title: <title>");
    expect(handoff).toContain("completed-turn message id turn-2");
    expect(handoff).toContain("tests passed");
    expect(handoff).toContain("Additional user instructions:\nkeep it terse");
  });

  it("builds fork helper resume params with provider-visible instructions", () => {
    const retitle = createCodexForkSummaryThreadResumeParams(
      {
        purpose: "session-retitle",
        strategy: "fork",
        generatorSessionId: parseNativeSessionId("thread-title"),
        cwd: "/tmp/project",
        model: "gpt-5.6-sol",
      },
      true,
    );
    expect(retitle).toMatchObject({
      threadId: "thread-title",
      model: "gpt-5.6-sol",
      cwd: "/tmp/project",
      approvalPolicy: "untrusted",
      sandbox: "read-only",
      excludeTurns: true,
    });
    expect(retitle.developerInstructions).toContain("title helper");

    const handoff = createCodexForkSummaryThreadResumeParams({
      purpose: "fork-after-summary",
      strategy: "fork",
      generatorSessionId: parseNativeSessionId("thread-summary"),
      cwd: "/tmp/project",
      model: "gpt-5.6-sol",
      afterTurnMessageId: "turn-2",
    });
    expect(handoff.excludeTurns).toBeUndefined();
    expect(handoff.developerInstructions).toContain("handoff summary helper");
  });

  it("selects and resolves recap helper models lazily", async () => {
    expect(selectCodexRecapHelperModel(undefined, [])).toBeNull();
    expect(selectCodexRecapHelperModel("gpt-5", [])).toBe("gpt-5");
    expect(
      selectCodexRecapHelperModel(HELPER_SIDE_MODEL_CHEAPEST, [
        { id: "other-mini" },
        { id: "gpt-5.1-codex-mini" },
      ]),
    ).toBe("gpt-5.1-codex-mini");
    expect(
      selectCodexRecapHelperModel(HELPER_SIDE_MODEL_CHEAPEST, [
        { id: "other-mini" },
      ]),
    ).toBe("other-mini");
    expect(
      selectCodexRecapHelperModel(HELPER_SIDE_MODEL_CHEAPEST, [
        { id: "full-size" },
      ]),
    ).toBeNull();

    const loadModels = vi.fn(async () => [{ id: "gpt-5.4-mini" }]);
    await expect(
      resolveCodexRecapHelperModel(undefined, loadModels),
    ).resolves.toBe(null);
    await expect(
      resolveCodexRecapHelperModel("gpt-5", loadModels),
    ).resolves.toBe("gpt-5");
    expect(loadModels).not.toHaveBeenCalled();
    await expect(
      resolveCodexRecapHelperModel(HELPER_SIDE_MODEL_CHEAPEST, loadModels),
    ).resolves.toBe("gpt-5.4-mini");
    expect(loadModels).toHaveBeenCalledTimes(1);
  });

  it("cleans and joins generated summary text", () => {
    const textByItemId = new Map([
      ["a", "First"],
      ["b", "Second"],
    ]);

    expect(joinCodexSummaryText(textByItemId)).toBe("First\nSecond");
    expect(cleanCodexSummaryText("  Summary  ")).toBe("Summary");
    expect(cleanCodexRecapText("Done. (disable recaps in /config) ")).toBe(
      "Done.",
    );
  });

  it("captures summary text from turn items and notifications", () => {
    const textByItemId = new Map<string, string>();

    captureCodexSummaryTextFromTurnItems(
      [
        { id: "skip", type: "reasoning", text: "hidden" },
        { id: "assistant-1", type: "agent_message", text: "Hello" },
      ] as never,
      textByItemId,
      normalizeThreadItem,
    );
    expect(textByItemId.get("assistant-1")).toBe("Hello");
    expect(textByItemId.has("skip")).toBe(false);

    captureCodexSummaryTextFromNotification(
      {
        method: "item/agentMessage/delta",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "assistant-2",
          delta: "part ",
        },
      },
      textByItemId,
      normalizeThreadItem,
    );
    captureCodexSummaryTextFromNotification(
      {
        method: "item/agentMessage/delta",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "assistant-2",
          delta: "two",
        },
      },
      textByItemId,
      normalizeThreadItem,
    );
    expect(textByItemId.get("assistant-2")).toBe("part two");

    captureCodexSummaryTextFromNotification(
      {
        method: "item/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            id: "assistant-2",
            type: "agent_message",
            text: "should not replace streamed text",
          },
        },
      },
      textByItemId,
      normalizeThreadItem,
    );
    expect(textByItemId.get("assistant-2")).toBe("part two");

    captureCodexSummaryTextFromNotification(
      {
        method: "rawResponseItem/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            type: "message",
            role: "assistant",
            content: [
              { type: "output_text", text: "raw one" },
              { type: "output_text", text: "raw two" },
            ],
          },
        },
      },
      textByItemId,
      normalizeThreadItem,
    );
    expect(textByItemId.get("raw-turn-1-2")).toBe("raw one\nraw two");
  });

  it("extracts raw assistant response item text only from output_text parts", () => {
    expect(
      extractCodexRawResponseMessageText({
        type: "message",
        role: "assistant",
        content: [
          { type: "reasoning_text", text: "skip" },
          { type: "output_text", text: "keep" },
          { type: "output_text", text: 123 },
        ],
      }),
    ).toBe("keep");

    expect(
      extractCodexRawResponseMessageText({
        type: "message",
        role: "user",
        content: [{ type: "output_text", text: "skip" }],
      }),
    ).toBeNull();
  });
});
