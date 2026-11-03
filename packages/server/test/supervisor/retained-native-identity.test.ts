import { expect, it, vi } from "vitest";
import { MessageQueue } from "../../src/sdk/messageQueue.js";
import {
  Process,
  createControllableIterator,
  getLogger,
  waitFor,
} from "../process.test-support.js";
import type { UrlProjectId } from "../process.test-support.js";

it.each([
  ["init", false],
  ["init", true],
  ["assistant", false],
  ["assistant", true],
] as const)(
  "closes retained input before listeners and fences a conflicting %s through teardown (failure=%s)",
  async (frame, abortFails) => {
    const errors = vi
      .spyOn(getLogger(), "error")
      .mockImplementation(() => undefined);
    const control = createControllableIterator();
    let alive = true,
      refuseAbort = abortFails;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const abort = vi.fn(async () => {
      await gate;
      if (refuseAbort) throw new Error("controlled retained teardown failure");
      alive = false;
      control.finish();
    });
    const queue = new MessageQueue();
    const runtime = new Process(control.iterator, {
      projectPath: "/owned-retained",
      projectId: "L293bmVkLXJldGFpbmVk" as UrlProjectId,
      sessionId: "public-retained",
      provider: "claude",
      queue,
      idleTimeoutMs: -1,
      isProcessAlive: () => alive,
      abortFn: abort,
    });
    let listenerInput: unknown, listenerFenced: boolean | undefined;
    runtime.subscribe((event) => {
      if (event.type !== "error") return;
      listenerFenced = runtime.hasUnverifiedProviderOwnership;
      listenerInput = runtime.queueMessage({
        text: "must refuse synchronous error input",
      });
    });
    try {
      control.push({ type: "system", subtype: "init", session_id: "native-a" });
      expect(await runtime.waitForProviderSessionId()).toBe("native-a");
      control.push(
        frame === "init"
          ? { type: "system", subtype: "init", session_id: "native-b" }
          : {
              type: "assistant",
              session_id: "native-b",
              message: { role: "assistant", content: "wrong native owner" },
            },
      );
      await waitFor(() => expect(abort).toHaveBeenCalledOnce());
      expect(listenerInput).toMatchObject({ success: false });
      expect(listenerFenced).toBe(true);
      expect(
        runtime.queueMessage({ text: "must refuse later input" }),
      ).toMatchObject({ success: false });
      expect(queue.depth).toBe(0);
      expect(runtime.sessionId).toBe("public-retained");
      expect(runtime.hasUnverifiedProviderOwnership).toBe(true);
      const teardown = runtime.abort();
      release();
      if (abortFails) {
        await expect(teardown).rejects.toThrow(
          "controlled retained teardown failure",
        );
        expect(runtime.hasUnverifiedProviderOwnership).toBe(true);
        expect(
          runtime.queueMessage({ text: "must refuse after failed teardown" }),
        ).toMatchObject({ success: false });
      } else {
        expect((await teardown).verifiedStopped).toBe(true);
        expect(runtime.hasUnverifiedProviderOwnership).toBe(false);
      }
      expect(runtime.state.type).toBe("terminated");
    } finally {
      refuseAbort = false;
      release();
      await runtime.abort();
      errors.mockRestore();
    }
  },
);
