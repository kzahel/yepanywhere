import { expect, it } from "vitest";
import { createSessionSubscription } from "../src/subscriptions.js";
import {
  Process,
  createControllableIterator,
  waitFor,
  type SDKMessage,
  type UrlProjectId,
} from "./process.test-support.js";
import { MessageQueue } from "../src/sdk/messageQueue.js";

it("keeps one current snapshot for late subscribers and clears it on completion", async () => {
  const controller = createControllableIterator();
  const process = new Process(controller.iterator, {
    queue: new MessageQueue(),
    projectPath: "/test",
    projectId: "proj-1" as UrlProjectId,
    sessionId: "sess-1",
    provider: "codex",
    idleTimeoutMs: 100,
  });
  const subscriptions = [
    createSessionSubscription(process, () => {}),
    createSessionSubscription(process, () => {}),
  ];
  try {
    for (const content of ["I’ll", "I’ll open", "I’ll open a Clair sketch."]) {
      controller.push({
        type: "assistant",
        uuid: "commentary",
        _isStreaming: true,
        message: { role: "assistant", content },
      } as SDKMessage);
      await waitFor(() =>
        expect(process.getStreamingContent()).toEqual({
          messageId: "commentary",
          text: content,
        }),
      );
    }
    controller.push({
      type: "assistant",
      uuid: "commentary",
      message: { role: "assistant", content: "I’ll open a Clair sketch." },
    } as SDKMessage);
    await waitFor(() => expect(process.getStreamingContent()).toBeNull());
  } finally {
    for (const subscription of subscriptions) subscription.cleanup();
    controller.finish();
    await process.abort();
  }
});

it("publishes and keeps a burst's latest snapshot, not every delta", async () => {
  const controller = createControllableIterator();
  const process = new Process(controller.iterator, {
    queue: new MessageQueue(),
    projectPath: "/test",
    projectId: "proj-1" as UrlProjectId,
    sessionId: "sess-1",
    provider: "opencode",
    idleTimeoutMs: 100,
  });
  const published: SDKMessage[] = [];
  const unsubscribe = process.subscribe((event) => {
    if (event.type === "message") published.push(event.message);
  });
  try {
    let text = "";
    for (let delta = 0; delta < 200; delta += 1) {
      text += "word ";
      controller.push({
        type: "assistant",
        uuid: "reply",
        _isStreaming: true,
        message: { role: "assistant", content: text },
      } as SDKMessage);
    }
    controller.push({
      type: "assistant",
      uuid: "reply",
      message: { role: "assistant", content: text },
    } as SDKMessage);
    const replies = (messages: SDKMessage[]) =>
      messages.filter((message) => message.uuid === "reply");
    await waitFor(() =>
      expect(replies(published).some((message) => !message._isStreaming)).toBe(
        true,
      ),
    );
    expect(replies(published).at(-1)?.message?.content).toBe(text);
    expect(replies(published).length).toBeLessThanOrEqual(3);
    expect(replies(process.getMessageHistory()).length).toBeLessThanOrEqual(3);
  } finally {
    unsubscribe();
    controller.finish();
    await process.abort();
  }
});
