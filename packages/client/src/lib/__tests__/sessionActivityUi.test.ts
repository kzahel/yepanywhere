import { describe, expect, it } from "vitest";
import type { SessionLivenessSnapshot } from "@yep-anywhere/shared";
import type { Message } from "../../types";
import type { RenderItem } from "@yep-anywhere/shared/transcript/items";
import { getSessionActivityUiState } from "../sessionActivityUi";

const sourceMessages: Message[] = [];

function user(
  id: string,
  promptSourceMessages: Message[] = sourceMessages,
): RenderItem {
  return {
    type: "user_prompt",
    id,
    content: "go",
    sourceMessages: promptSourceMessages,
  };
}

function text(id: string, isStreaming = false): RenderItem {
  return {
    type: "text",
    id,
    text: "done",
    sourceMessages,
    ...(isStreaming ? { isStreaming } : {}),
  };
}

function tool(id: string, status: "pending" | "complete"): RenderItem {
  return {
    type: "tool_call",
    id,
    toolName: "Bash",
    toolInput: { command: "npm test" },
    sourceMessages,
    status,
  };
}

const waitingProviderLiveness: SessionLivenessSnapshot = {
  checkedAt: "2026-06-13T00:00:00.000Z",
  derivedStatus: "verified-waiting-provider",
  activeWorkKind: "agent-turn",
  state: "idle",
  evidence: ["provider-retained"],
  lastProviderMessageAt: "2026-06-13T00:00:00.000Z",
  lastRawProviderEventAt: null,
  lastRawProviderEventSource: null,
  lastStateChangeAt: "2026-06-13T00:00:00.000Z",
  lastVerifiedProgressAt: "2026-06-13T00:00:00.000Z",
  lastVerifiedIdleAt: null,
  lastLivenessProbeAt: null,
  lastLivenessProbeStatus: null,
  lastLivenessProbeSource: null,
  silenceMs: 0,
  longSilenceThresholdMs: 300_000,
  providerRetention: {
    retained: true,
    reasons: ["stop-hook-background-tasks:1"],
    backgroundTaskCount: 1,
  },
  queueDepth: 0,
  deferredQueueDepth: 0,
};

describe("getSessionActivityUiState", () => {
  it("treats a self-owned in-turn prompt as active", () => {
    const state = getSessionActivityUiState({
      owner: "self",
      processState: "in-turn",
      items: [user("u1")],
    });

    expect(state.shouldDeferMessages).toBe(true);
    expect(state.canStopOwnedProcess).toBe(true);
    expect(state.showProcessingIndicator).toBe(true);
  });

  it("keeps an owned in-turn process active after an assistant item completes", () => {
    const state = getSessionActivityUiState({
      owner: "self",
      processState: "in-turn",
      items: [user("u1"), text("a1")],
    });

    expect(state.latestTurnSettled).toBe(true);
    expect(state.shouldDeferMessages).toBe(true);
    expect(state.canStopOwnedProcess).toBe(true);
    expect(state.showProcessingIndicator).toBe(true);
    expect(state.shouldSuppressCurrentTurnOrphans).toBe(true);
  });

  it("stops stale activity at a durable completed-turn boundary", () => {
    const prompt: Message = { type: "user", uuid: "u1" };
    const completion: Message = {
      type: "system",
      subtype: "stop_hook_summary",
      preventedContinuation: false,
    };
    const state = getSessionActivityUiState({
      owner: "self",
      processState: "in-turn",
      items: [user("u1", [prompt]), text("a1")],
      messages: [prompt, completion],
    });

    expect(state.latestTurnSettled).toBe(true);
    expect(state.latestTurnCompleted).toBe(true);
    expect(state.shouldDeferMessages).toBe(false);
    expect(state.canStopOwnedProcess).toBe(false);
    expect(state.showProcessingIndicator).toBe(false);
    expect(state.shouldSuppressCurrentTurnOrphans).toBe(false);
  });

  it("keeps provider-retained work active after a completed turn", () => {
    const prompt: Message = { type: "user", uuid: "u1" };
    const completion: Message = {
      type: "system",
      subtype: "stop_hook_summary",
      preventedContinuation: false,
    };
    const state = getSessionActivityUiState({
      owner: "self",
      processState: "in-turn",
      items: [user("u1", [prompt]), text("a1")],
      messages: [prompt, completion],
      sessionLiveness: waitingProviderLiveness,
    });

    expect(state.latestTurnCompleted).toBe(true);
    expect(state.shouldDeferMessages).toBe(true);
    expect(state.canStopOwnedProcess).toBe(true);
    expect(state.showProcessingIndicator).toBe(true);
  });

  it("does not apply an older completion marker to a newer turn", () => {
    const firstPrompt: Message = { type: "user", uuid: "u1" };
    const completion: Message = {
      type: "system",
      subtype: "stop_hook_summary",
      preventedContinuation: false,
    };
    const latestPrompt: Message = { type: "user", uuid: "u2" };
    const state = getSessionActivityUiState({
      owner: "self",
      processState: "in-turn",
      items: [
        user("u1", [firstPrompt]),
        text("a1"),
        user("u2", [latestPrompt]),
      ],
      messages: [firstPrompt, completion, latestPrompt],
    });

    expect(state.latestTurnCompleted).toBe(false);
    expect(state.showProcessingIndicator).toBe(true);
  });

  it("does not settle a newer user message before it reaches rendered items", () => {
    const firstPrompt: Message = { type: "user", uuid: "u1" };
    const completion: Message = {
      type: "system",
      subtype: "stop_hook_summary",
      preventedContinuation: false,
    };
    const latestPrompt: Message = { type: "user", uuid: "u2" };
    const state = getSessionActivityUiState({
      owner: "self",
      processState: "in-turn",
      items: [user("u1", [firstPrompt]), text("a1")],
      messages: [firstPrompt, completion, latestPrompt],
    });

    expect(state.latestTurnCompleted).toBe(false);
    expect(state.showProcessingIndicator).toBe(true);
  });

  it("recognizes a provider turn-complete marker", () => {
    const prompt: Message = { type: "user", uuid: "u1" };
    const completion: Message = {
      type: "system",
      subtype: "turn_complete",
      session_id: "session-a",
    };
    const state = getSessionActivityUiState({
      owner: "self",
      processState: "in-turn",
      items: [user("u1", [prompt]), text("a1")],
      messages: [prompt, completion],
    });

    expect(state.latestTurnCompleted).toBe(true);
    expect(state.showProcessingIndicator).toBe(false);
  });

  it("keeps activity when a stop hook prevents turn completion", () => {
    const prompt: Message = { type: "user", uuid: "u1" };
    const completion: Message = {
      type: "system",
      subtype: "stop_hook_summary",
      preventedContinuation: true,
    };
    const state = getSessionActivityUiState({
      owner: "self",
      processState: "in-turn",
      items: [user("u1", [prompt]), text("a1")],
      messages: [prompt, completion],
    });

    expect(state.latestTurnCompleted).toBe(false);
    expect(state.showProcessingIndicator).toBe(true);
  });

  it("does not let older pending tool rows orphan the bottom spinner after idle", () => {
    const state = getSessionActivityUiState({
      owner: "self",
      processState: "idle",
      items: [user("u1"), tool("t1", "pending"), text("a1")],
    });

    expect(state.hasPendingToolCalls).toBe(true);
    expect(state.latestTurnSettled).toBe(true);
    expect(state.shouldDeferMessages).toBe(false);
    expect(state.canStopOwnedProcess).toBe(false);
    expect(state.showProcessingIndicator).toBe(false);
    expect(state.shouldSuppressCurrentTurnOrphans).toBe(false);
  });

  it("keeps the fallback active for a latest pending tool with stale idle state", () => {
    const state = getSessionActivityUiState({
      owner: "self",
      processState: "idle",
      items: [user("u1"), tool("t1", "pending")],
    });

    expect(state.shouldDeferMessages).toBe(true);
    expect(state.canStopOwnedProcess).toBe(true);
    expect(state.showProcessingIndicator).toBe(true);
  });

  it("treats provider-retained idle as background work", () => {
    const state = getSessionActivityUiState({
      owner: "self",
      processState: "idle",
      items: [user("u1"), text("a1")],
      sessionLiveness: waitingProviderLiveness,
    });

    expect(state.latestTurnSettled).toBe(true);
    expect(state.shouldDeferMessages).toBe(true);
    expect(state.canStopOwnedProcess).toBe(true);
    expect(state.showProcessingIndicator).toBe(true);
    expect(state.shouldSuppressCurrentTurnOrphans).toBe(true);
  });

  it("ignores stale ownership from other sessions", () => {
    const state = getSessionActivityUiState({
      owner: "none",
      processState: "in-turn",
      items: [user("u1"), tool("t1", "pending")],
    });

    expect(state.shouldDeferMessages).toBe(false);
    expect(state.canStopOwnedProcess).toBe(false);
    expect(state.showProcessingIndicator).toBe(false);
  });

  it("exposes the latest-turn pending tool call for the waiting-elsewhere banner", () => {
    const state = getSessionActivityUiState({
      owner: "none",
      processState: "idle",
      items: [user("u1"), tool("t9", "pending")],
    });

    expect(state.pendingToolCallInLatestTurn).toEqual({
      id: "t9",
      toolName: "Bash",
      toolInput: { command: "npm test" },
    });
  });

  it("ignores a pending tool from an earlier turn", () => {
    const state = getSessionActivityUiState({
      owner: "none",
      processState: "idle",
      items: [user("u1"), tool("t1", "pending"), user("u2"), text("a2")],
    });

    // The all-items flag still sees it, but the banner-facing latest-turn
    // accessor must not, so a settled new turn does not re-trigger the warning.
    expect(state.hasPendingToolCalls).toBe(true);
    expect(state.pendingToolCallInLatestTurn).toBeNull();
  });
});
