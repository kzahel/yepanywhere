import assert from "node:assert/strict";
import { describe, expect, it } from "vitest";
import {
  ClaudeSessionEntrySchema,
  getLogicalParentUuid,
  isInjectedContinuationPrompt,
  isLocalCommandEchoTurn,
  isSyntheticNoResponseTurn,
} from "../src/claude-sdk-schema/index.js";
import { AskUserQuestionResultSchema } from "../src/claude-sdk-schema/tool/ToolResultSchemas.js";

describe("Claude SDK schema", () => {
  it("parses session_state_changed system entries", () => {
    const result = ClaudeSessionEntrySchema.safeParse({
      type: "system",
      subtype: "session_state_changed",
      state: "idle",
      session_id: "sess-1",
      isSidechain: false,
      userType: "external",
      cwd: "/repo",
      sessionId: "sess-1",
      version: "1.0.0",
      uuid: "11111111-1111-4111-8111-111111111111",
      timestamp: "2026-06-05T00:00:00.000Z",
      parentUuid: null,
    });

    expect(result.success).toBe(true);
  });

  it.each([
    {
      type: "permission-mode",
      permissionMode: "default",
      sessionId: "11111111-1111-4111-8111-111111111111",
    },
    {
      type: "last-prompt",
      leafUuid: "11111111-1111-4111-8111-111111111112",
      sessionId: "11111111-1111-4111-8111-111111111111",
    },
    {
      type: "queue-operation",
      operation: "popAll",
      content: "queued prompt",
      sessionId: "11111111-1111-4111-8111-111111111111",
      timestamp: "2026-07-19T00:00:00.000Z",
    },
    {
      type: "atis-latch",
      atis: "",
      sessionId: "11111111-1111-4111-8111-111111111111",
    },
    {
      type: "cost-state",
      sessionId: "11111111-1111-4111-8111-111111111111",
      totalCostUSD: 0.1,
      totalAPIDuration: 100,
      totalAPIDurationWithoutRetries: 90,
      totalToolDuration: 10,
      totalLinesAdded: 2,
      totalLinesRemoved: 1,
      totalDuration: 200,
      startTime: 1_790_102_688_745,
      modelUsage: {
        "claude-opus-5-5": {
          inputTokens: 2,
          outputTokens: 16,
          thinkingTokens: 0,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 20_763,
          webSearchRequests: 0,
          costUSD: 0.1,
        },
      },
      hasUnknownModelCost: false,
    },
  ])("parses current Claude metadata entry %#", (entry) => {
    expect(ClaudeSessionEntrySchema.safeParse(entry).success).toBe(true);
  });

  it.each([
    {
      type: "attachment",
      attachment: { type: "deferred_tools_delta", addedNames: ["Read"] },
    },
    {
      type: "system",
      subtype: "turn_duration",
      durationMs: 1234,
      messageCount: 3,
    },
    {
      type: "system",
      subtype: "away_summary",
      content: "Work continued while the client was away.",
    },
    {
      type: "system",
      subtype: "scheduled_task_fire",
      content: "Scheduled task resumed.",
    },
    {
      type: "system",
      subtype: "local_command",
      content: "<command-name>/model</command-name>",
      level: "info",
    },
    {
      type: "system",
      subtype: "informational",
      content: "Provider status warning.",
      level: "warning",
    },
    {
      type: "system",
      subtype: "model_refusal_fallback",
      direction: "retry",
      content: "Retrying with the fallback model.",
      level: "warning",
      trigger: "refusal",
      originalModel: "claude-fable-5",
      fallbackModel: "claude-opus-4-8",
      requestId: "req-1",
      apiRefusalCategory: null,
      apiRefusalExplanation: null,
      retractedMessageUuids: ["11111111-1111-4111-8111-111111111114"],
      refusedUserMessageUuid: "11111111-1111-4111-8111-111111111115",
    },
  ])("parses current Claude conversation entry %#", (entry) => {
    const result = ClaudeSessionEntrySchema.safeParse({
      ...entry,
      isSidechain: false,
      userType: "external",
      cwd: "/repo",
      sessionId: "11111111-1111-4111-8111-111111111111",
      version: "2.1.215",
      uuid: "11111111-1111-4111-8111-111111111113",
      timestamp: "2026-07-19T00:00:00.000Z",
      parentUuid: null,
    });

    expect(result.success).toBe(true);
  });

  it("parses assistant model fallback content", () => {
    const result = ClaudeSessionEntrySchema.safeParse({
      type: "assistant",
      message: {
        id: "msg-1",
        type: "message",
        role: "assistant",
        model: "claude-opus-4-8",
        content: [
          {
            type: "fallback",
            from: { model: "claude-fable-5" },
            to: { model: "claude-opus-4-8" },
          },
        ],
        stop_reason: "tool_use",
        stop_sequence: null,
        usage: {
          input_tokens: 1,
          output_tokens: 1,
        },
      },
      requestId: "req-1",
      isSidechain: false,
      userType: "external",
      cwd: "/repo",
      sessionId: "11111111-1111-4111-8111-111111111111",
      version: "2.1.199",
      uuid: "11111111-1111-4111-8111-111111111113",
      timestamp: "2026-07-03T00:00:00.000Z",
      parentUuid: null,
    });

    expect(result.success).toBe(true);
  });

  it("parses AskUserQuestion results with multi-select answers", () => {
    const result = AskUserQuestionResultSchema.safeParse({
      questions: [
        {
          question: "Which checks?",
          header: "Checks",
          options: [
            { label: "Unit", description: "Run unit tests" },
            { label: "Types", description: "Run typecheck" },
          ],
          multiSelect: true,
        },
      ],
      answers: {
        "Which checks?": ["Unit", "Types"],
      },
    });

    expect(result.success).toBe(true);
  });

  it("uses compactMetadata preserved tail as the logical parent", () => {
    const result = ClaudeSessionEntrySchema.safeParse({
      type: "system",
      subtype: "compact_boundary",
      content: "Conversation compacted",
      level: "info",
      compactMetadata: {
        trigger: "manual",
        preTokens: 345417,
        preservedSegment: { tailUuid: "tail" },
      },
      isSidechain: false,
      userType: "external",
      cwd: "/repo",
      sessionId: "sess-1",
      version: "1.0.0",
      uuid: "11111111-1111-4111-8111-111111111112",
      timestamp: "2026-06-05T00:00:00.000Z",
      parentUuid: null,
    });

    assert(result.success, "expected a parsed compact boundary");
    expect(result.data).toMatchObject({
      compactMetadata: { preservedSegment: { tailUuid: "tail" } },
    });
    expect(getLogicalParentUuid(result.data)).toBe("tail");
  });

  describe("harness session-continuation entries", () => {
    it("recognizes the injected continuation prompt", () => {
      expect(
        isInjectedContinuationPrompt({
          type: "user",
          isMeta: true,
          message: {
            role: "user",
            content: [
              { type: "text", text: "Continue from where you left off." },
            ],
          },
        }),
      ).toBe(true);
    });

    it("does not treat a user-typed continuation as injected", () => {
      // Only the harness stamps isMeta; without it a user typed the words.
      expect(
        isInjectedContinuationPrompt({
          type: "user",
          message: {
            role: "user",
            content: "Continue from where you left off.",
          },
        }),
      ).toBe(false);
    });

    it("recognizes the synthetic no-response placeholder", () => {
      expect(
        isSyntheticNoResponseTurn({
          type: "assistant",
          message: {
            role: "assistant",
            model: "<synthetic>",
            content: [{ type: "text", text: "No response requested." }],
          },
        }),
      ).toBe(true);
    });

    it("requires the synthetic model, not just the wording", () => {
      expect(
        isSyntheticNoResponseTurn({
          type: "assistant",
          message: {
            role: "assistant",
            model: "claude-opus-4-5",
            content: [{ type: "text", text: "No response requested." }],
          },
        }),
      ).toBe(false);
    });

    it("leaves other synthetic assistant entries alone", () => {
      expect(
        isSyntheticNoResponseTurn({
          type: "assistant",
          message: {
            role: "assistant",
            model: "<synthetic>",
            content: [{ type: "text", text: "Turn aborted by user." }],
          },
        }),
      ).toBe(false);
    });

    it("ignores null and non-object input", () => {
      expect(isInjectedContinuationPrompt(null)).toBe(false);
      expect(isSyntheticNoResponseTurn(undefined)).toBe(false);
    });
  });

  describe("isLocalCommandEchoTurn", () => {
    it("recognizes a slash command's own output", () => {
      expect(
        isLocalCommandEchoTurn({
          type: "assistant",
          message: {
            role: "assistant",
            model: "<synthetic>",
            content: [{ type: "text", text: "Error: No messages to compact" }],
          },
          local_command_source:
            "<local-command-stderr>Error: No messages to compact</local-command-stderr>",
        }),
      ).toBe(true);
    });

    it("requires the command output carrier, not just the synthetic model", () => {
      expect(
        isLocalCommandEchoTurn({
          type: "assistant",
          message: {
            role: "assistant",
            model: "<synthetic>",
            content: [{ type: "text", text: "Turn aborted by user." }],
          },
        }),
      ).toBe(false);
    });

    it("leaves a real assistant turn alone", () => {
      expect(
        isLocalCommandEchoTurn({
          type: "assistant",
          message: {
            role: "assistant",
            model: "claude-opus-5",
            content: [{ type: "text", text: "Compacted " }],
          },
          local_command_source:
            "<local-command-stdout>Compacted </local-command-stdout>",
        }),
      ).toBe(false);
    });

    it("ignores null and non-object input", () => {
      expect(isLocalCommandEchoTurn(null)).toBe(false);
      expect(isLocalCommandEchoTurn(undefined)).toBe(false);
    });
  });
});
