import { describe, expect, it, vi } from "vitest";
import {
  Process,
  createControllableIterator,
  waitFor,
} from "./process.test-support.js";
import type { ProcessEvent, UrlProjectId } from "./process.test-support.js";
import { MessageQueue } from "../src/sdk/messageQueue.js";

/**
 * A session reports the model the provider serves, not the alias it was
 * selected as: resolved through the provider's catalog at launch and on each
 * switch, and kept current by each main-thread reply.
 */

const CATALOG: Record<string, string> = {
  opus: "claude-opus-5-5",
  sonnet: "claude-sonnet-5",
};
const resolve = (model: string | undefined) =>
  model ? CATALOG[model] : undefined;

function processFor(model: string) {
  const controller = createControllableIterator();
  const process = new Process(controller.iterator, {
    queue: new MessageQueue(),
    projectPath: "/test",
    projectId: "proj-1" as UrlProjectId,
    sessionId: "sess-1",
    provider: "claude",
    idleTimeoutMs: 100,
    model,
    setModelFn: vi.fn(async () => {}),
  });
  const events: ProcessEvent[] = [];
  process.subscribe((event) => {
    events.push(event);
  });
  return { controller, process, events };
}

function assistant(model: string, parentToolUseId?: string) {
  return {
    type: "assistant" as const,
    session_id: "sess-1",
    ...(parentToolUseId ? { parent_tool_use_id: parentToolUseId } : {}),
    message: { role: "assistant", model, content: [] },
  };
}

describe("Process model resolution", () => {
  it("reports the served model from launch, before any reply", () => {
    const { controller, process, events } = processFor("opus");
    expect(process.resolvedModel).toBe("opus");

    process.useModelResolver(resolve);

    expect(process.resolvedModel).toBe("claude-opus-5-5");
    expect(events).toContainEqual({
      type: "model-resolved",
      model: "claude-opus-5-5",
    });
    controller.finish();
  });

  it("learns the model from the first reply when the catalog cannot say", async () => {
    const { controller, process, events } = processFor("opus");
    process.useModelResolver(() => undefined);

    controller.push(assistant("claude-opus-5-5"));

    await waitFor(() => {
      expect(process.resolvedModel).toBe("claude-opus-5-5");
    });
    expect(events).toContainEqual({
      type: "model-resolved",
      model: "claude-opus-5-5",
    });
    controller.finish();
  });

  it("ignores a subagent's reply on another model", async () => {
    const { controller, process } = processFor("opus");
    process.useModelResolver(resolve);

    controller.push(assistant("claude-haiku-4-5", "tool-1"));
    controller.push(assistant("claude-opus-5-5"));

    await waitFor(() => {
      expect(process.getMessageHistory().length).toBeGreaterThanOrEqual(2);
    });
    expect(process.resolvedModel).toBe("claude-opus-5-5");
    controller.finish();
  });

  it("resolves a switch, then lets later replies correct it", async () => {
    const { controller, process } = processFor("opus");
    process.useModelResolver(resolve);
    controller.push(assistant("claude-opus-5-5"));
    await waitFor(() => {
      expect(process.resolvedModel).toBe("claude-opus-5-5");
    });

    await process.setModel("sonnet");
    expect(process.resolvedModel).toBe("claude-sonnet-5");

    // An alias the catalog does not know stands only until a reply names it;
    // before, the first-reply-only capture pinned it for the session's life.
    await process.setModel("mystery");
    expect(process.resolvedModel).toBe("mystery");
    controller.push(assistant("claude-mystery-1"));
    await waitFor(() => {
      expect(process.resolvedModel).toBe("claude-mystery-1");
    });
    controller.finish();
  });
});
