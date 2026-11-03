import { afterEach, describe, expect, it } from "vitest";
import { createSessionSubscription } from "../src/subscriptions.js";
import {
  Process,
  createControllableIterator,
  waitFor,
  type SDKMessage,
  type UrlProjectId,
} from "./process.test-support.js";
import { MessageQueue } from "../src/sdk/messageQueue.js";

interface Frame {
  eventType: string;
  data: unknown;
  eventId: string;
}

function collectFrames(): {
  frames: Frame[];
  emit: (eventType: string, data: unknown, eventId: string) => void;
} {
  const frames: Frame[] = [];
  return {
    frames,
    emit: (eventType, data, eventId) => {
      frames.push({ eventType, data, eventId });
    },
  };
}

function replayedUuids(frames: Frame[]): unknown[] {
  return frames
    .filter(
      (frame) =>
        frame.eventType === "message" &&
        (frame.data as { isReplay?: boolean }).isReplay === true,
    )
    .map((frame) => (frame.data as { uuid?: unknown }).uuid);
}

function assistant(uuid: string): SDKMessage {
  return {
    type: "assistant",
    uuid,
    message: { role: "assistant", content: `reply ${uuid}` },
  } as SDKMessage;
}

describe("session subscription resume from lastEventId", () => {
  const cleanups: Array<() => void | Promise<void>> = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  function startProcess() {
    const controller = createControllableIterator();
    const process = new Process(controller.iterator, {
      queue: new MessageQueue(),
      projectPath: "/test",
      projectId: "proj-1" as UrlProjectId,
      sessionId: "sess-1",
      provider: "codex",
      idleTimeoutMs: 100,
    });
    cleanups.push(async () => {
      controller.finish();
      await process.abort();
    });
    return { controller, process };
  }

  it("replays only buffered messages the client has not seen", async () => {
    const { controller, process } = startProcess();
    const first = collectFrames();
    const firstSubscription = createSessionSubscription(process, first.emit);
    controller.push(assistant("a"));
    await waitFor(() =>
      expect(
        first.frames.some(
          (frame) =>
            frame.eventType === "message" &&
            (frame.data as { uuid?: unknown }).uuid === "a",
        ),
      ).toBe(true),
    );
    const lastEventId = first.frames.at(-1)?.eventId;
    firstSubscription.cleanup();

    controller.push(assistant("b"));
    await waitFor(() =>
      expect(process.getMessageHistory().map((m) => m.uuid)).toEqual([
        "a",
        "b",
      ]),
    );

    const resumed = collectFrames();
    const resumedSubscription = createSessionSubscription(
      process,
      resumed.emit,
      { lastEventId },
    );
    cleanups.push(() => resumedSubscription.cleanup());
    expect(replayedUuids(resumed.frames)).toEqual(["b"]);

    // The resumed stream's own cursor carries the same guarantee onward.
    const resumedCursor = resumed.frames.at(-1)?.eventId;
    const again = collectFrames();
    const againSubscription = createSessionSubscription(process, again.emit, {
      lastEventId: resumedCursor,
    });
    cleanups.push(() => againSubscription.cleanup());
    expect(replayedUuids(again.frames)).toEqual([]);
  });

  it("replays the whole buffer for a cursor it cannot honor", async () => {
    const { controller, process } = startProcess();
    controller.push(assistant("a"));
    controller.push(assistant("b"));
    await waitFor(() => expect(process.getMessageHistory()).toHaveLength(2));

    // No cursor, an older server's per-subscription counter, and a cursor
    // from another process each mean the client's position is unknown here.
    for (const lastEventId of [undefined, "57", "other-proc.1.3"]) {
      const { frames, emit } = collectFrames();
      const subscription = createSessionSubscription(process, emit, {
        lastEventId,
      });
      cleanups.push(() => subscription.cleanup());
      expect(replayedUuids(frames)).toEqual(["a", "b"]);
    }
  });
});
