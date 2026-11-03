import { describe, expect, it, vi } from "vitest";
import {
  MessageQueue,
  Process,
  createControllableIterator,
  createMockIterator,
} from "./process.test-support.js";
import type { SDKMessage, UrlProjectId } from "./process.test-support.js";

describe("Process", () => {
  describe("provider session identity", () => {
    it("settles provider identity from a reattached runtime's reported id", async () => {
      const controller = createControllableIterator();
      const process = new Process(controller.iterator, {
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "retained-public",
        provider: "codex",
        initialState: "idle",
        idleTimeoutMs: 20,
        abortFn: () => controller.finish(),
        initializedSessionId: "sess-1",
      });

      await expect(process.waitForProviderSessionId(50)).resolves.toBe(
        "sess-1",
      );
      expect(process.sessionId).toBe("retained-public");
      await process.abort();
    });

    it("keeps waiting for init when no owner reported provider identity", async () => {
      const controller = createControllableIterator();
      const process = new Process(controller.iterator, {
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "codex",
        initialState: "idle",
        idleTimeoutMs: 20,
        abortFn: () => controller.finish(),
      });

      await expect(process.waitForProviderSessionId(20)).rejects.toThrow(
        "Timed out waiting 20ms for provider session id",
      );
      await process.abort();
    });
  });

  describe("idle lifecycle", () => {
    it("reaps a verified-idle process after the configured grace", async () => {
      vi.useFakeTimers();
      try {
        const controller = createControllableIterator();
        const abortFn = vi.fn(() => {
          controller.finish();
        });
        const events: string[] = [];
        const process = new Process(controller.iterator, {
          projectPath: "/test",
          projectId: "proj-1" as UrlProjectId,
          sessionId: "sess-1",
          provider: "claude",
          initialState: "idle",
          idleTimeoutMs: 20,
          abortFn,
        });
        process.subscribe((event) => {
          events.push(event.type);
        });

        await vi.advanceTimersByTimeAsync(19);
        expect(abortFn).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(1);
        expect(abortFn).toHaveBeenCalledOnce();
        expect(events).toEqual(["idle-reap", "complete"]);
      } finally {
        vi.useRealTimers();
      }
    });

    it("chunks deadlines above Node's maximum timer delay", async () => {
      vi.useFakeTimers();
      // The Process bucket-swap interval is unrelated to idle reaping. Do not
      // iterate it tens of thousands of times while crossing a multi-day
      // synthetic deadline.
      const setIntervalSpy = vi
        .spyOn(globalThis, "setInterval")
        .mockReturnValue({} as ReturnType<typeof setInterval>);
      const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
      try {
        const maxTimerDelayMs = 2_147_483_647;
        const idleTimeoutMs = maxTimerDelayMs * 2 + 1_000;
        const controller = createControllableIterator();
        const abortFn = vi.fn(() => {
          controller.finish();
        });
        new Process(controller.iterator, {
          projectPath: "/test",
          projectId: "proj-1" as UrlProjectId,
          sessionId: "sess-1",
          provider: "claude",
          initialState: "idle",
          idleTimeoutMs,
          abortFn,
        });

        expect(setTimeoutSpy.mock.calls.at(-1)?.[1]).toBe(maxTimerDelayMs);
        await vi.advanceTimersByTimeAsync(maxTimerDelayMs);
        expect(abortFn).not.toHaveBeenCalled();
        expect(setTimeoutSpy.mock.calls.at(-1)?.[1]).toBe(maxTimerDelayMs);

        await vi.advanceTimersByTimeAsync(maxTimerDelayMs);
        expect(abortFn).not.toHaveBeenCalled();
        expect(setTimeoutSpy.mock.calls.at(-1)?.[1]).toBe(1_000);

        await vi.advanceTimersByTimeAsync(999);
        expect(abortFn).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(abortFn).toHaveBeenCalledOnce();
      } finally {
        setTimeoutSpy.mockRestore();
        setIntervalSpy.mockRestore();
        vi.useRealTimers();
      }
    }, 10_000);

    it("recalculates live timeout changes from the current idle period", async () => {
      vi.useFakeTimers();
      try {
        const controller = createControllableIterator();
        const abortFn = vi.fn(() => {
          controller.finish();
        });
        const process = new Process(controller.iterator, {
          projectPath: "/test",
          projectId: "proj-1" as UrlProjectId,
          sessionId: "sess-1",
          provider: "claude",
          initialState: "idle",
          idleTimeoutMs: 100,
          abortFn,
        });

        await vi.advanceTimersByTimeAsync(40);
        process.updateIdleTimeoutMs(200);
        await vi.advanceTimersByTimeAsync(110);
        expect(abortFn).not.toHaveBeenCalled();

        process.updateIdleTimeoutMs(160);
        await vi.advanceTimersByTimeAsync(9);
        expect(abortFn).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(abortFn).toHaveBeenCalledOnce();
      } finally {
        vi.useRealTimers();
      }
    });

    it("retains ownership and fences input while idle abort is pending", async () => {
      vi.useFakeTimers();
      try {
        let resolveAbort: (() => void) | undefined;
        const abortGate = new Promise<void>((resolve) => {
          resolveAbort = resolve;
        });
        const controller = createControllableIterator();
        const abortFn = vi.fn(() => abortGate);
        const events: string[] = [];
        const process = new Process(controller.iterator, {
          projectPath: "/test",
          projectId: "proj-1" as UrlProjectId,
          sessionId: "sess-1",
          provider: "claude",
          initialState: "idle",
          idleTimeoutMs: 20,
          abortFn,
        });
        process.subscribe((event) => {
          events.push(event.type);
        });

        await vi.advanceTimersByTimeAsync(20);

        expect(process.hasUnverifiedProviderOwnership).toBe(true);
        expect(events).toEqual(["idle-reap"]);
        expect(process.queueMessage({ text: "too late" })).toMatchObject({
          success: false,
          error: "Process provider teardown is in progress or unverified",
        });
        expect(
          process.deferMessage({ text: "also too late", tempId: "late" }),
        ).toMatchObject({
          success: false,
          deferred: false,
          error: "Process provider teardown is in progress or unverified",
        });

        const joinedAbort = process.abort();
        expect(abortFn).toHaveBeenCalledOnce();
        controller.finish();
        resolveAbort?.();
        await joinedAbort;

        expect(process.hasUnverifiedProviderOwnership).toBe(false);
        expect(events).toEqual(["idle-reap", "complete"]);
      } finally {
        vi.useRealTimers();
      }
    });

    it("retains a failed idle teardown until an explicit retry verifies exit", async () => {
      vi.useFakeTimers();
      try {
        const controller = createControllableIterator();
        const abortFn = vi
          .fn<() => Promise<void>>()
          .mockRejectedValueOnce(new Error("shutdown failed"))
          .mockImplementationOnce(async () => {
            controller.finish();
          });
        const events: string[] = [];
        const process = new Process(controller.iterator, {
          projectPath: "/test",
          projectId: "proj-1" as UrlProjectId,
          sessionId: "sess-1",
          provider: "claude",
          initialState: "idle",
          idleTimeoutMs: 20,
          abortFn,
        });
        process.subscribe((event) => {
          events.push(event.type);
        });

        await vi.advanceTimersByTimeAsync(20);
        await vi.advanceTimersByTimeAsync(0);

        expect(process.hasUnverifiedProviderOwnership).toBe(true);
        expect(process.state).toMatchObject({
          type: "terminated",
          reason: "idle reap provider teardown failed",
        });
        expect(events.filter((type) => type === "complete")).toEqual([]);
        expect(abortFn).toHaveBeenCalledOnce();

        await expect(process.abort()).resolves.toMatchObject({
          verifiedStopped: true,
          verification: "iterator",
        });

        expect(abortFn).toHaveBeenCalledTimes(2);
        expect(process.hasUnverifiedProviderOwnership).toBe(false);
        expect(events.filter((type) => type === "complete")).toEqual([
          "complete",
        ]);
      } finally {
        vi.useRealTimers();
      }
    });

    it("restarts the full grace when viewers return and leave", async () => {
      vi.useFakeTimers();
      try {
        const controller = createControllableIterator();
        const abortFn = vi.fn();
        const setRuntimeViewerPresenceFn = vi.fn(async () => {});
        const process = new Process(controller.iterator, {
          projectPath: "/test",
          projectId: "proj-1" as UrlProjectId,
          sessionId: "sess-1",
          provider: "claude",
          initialState: "idle",
          idleTimeoutMs: 20,
          abortFn,
          setRuntimeViewerPresenceFn,
        });

        const releaseFirstViewer = process.registerViewer();
        await vi.advanceTimersByTimeAsync(100);
        expect(abortFn).not.toHaveBeenCalled();

        releaseFirstViewer();
        await vi.advanceTimersByTimeAsync(19);
        const releaseReturningViewer = process.registerViewer();
        await vi.advanceTimersByTimeAsync(100);
        expect(abortFn).not.toHaveBeenCalled();

        releaseReturningViewer();
        await vi.advanceTimersByTimeAsync(20);
        expect(abortFn).toHaveBeenCalledOnce();
        expect(setRuntimeViewerPresenceFn.mock.calls).toEqual([
          [true],
          [false],
          [true],
          [false],
        ]);
      } finally {
        vi.useRealTimers();
      }
    });

    it("retries a failed runtime viewer publication until acknowledged", async () => {
      vi.useFakeTimers();
      try {
        const controller = createControllableIterator();
        const setRuntimeViewerPresenceFn = vi
          .fn<(hasViewers: boolean) => Promise<void>>()
          .mockRejectedValueOnce(new Error("host unavailable"))
          .mockResolvedValue(undefined);
        const process = new Process(controller.iterator, {
          projectPath: "/test",
          projectId: "proj-1" as UrlProjectId,
          sessionId: "sess-1",
          provider: "codex",
          setRuntimeViewerPresenceFn,
        });

        const releaseViewer = process.registerViewer();
        await vi.advanceTimersByTimeAsync(0);
        expect(setRuntimeViewerPresenceFn.mock.calls).toEqual([[true]]);

        await vi.advanceTimersByTimeAsync(99);
        expect(setRuntimeViewerPresenceFn).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(setRuntimeViewerPresenceFn.mock.calls).toEqual([[true], [true]]);

        controller.finish();
        await process.abort();
        releaseViewer();
      } finally {
        vi.useRealTimers();
      }
    });

    it("supersedes a pending retry with the latest viewer state", async () => {
      vi.useFakeTimers();
      try {
        const controller = createControllableIterator();
        const setRuntimeViewerPresenceFn = vi
          .fn<(hasViewers: boolean) => Promise<void>>()
          .mockRejectedValueOnce(new Error("host unavailable"))
          .mockResolvedValue(undefined);
        const process = new Process(controller.iterator, {
          projectPath: "/test",
          projectId: "proj-1" as UrlProjectId,
          sessionId: "sess-1",
          provider: "codex",
          setRuntimeViewerPresenceFn,
        });

        const releaseViewer = process.registerViewer();
        await vi.advanceTimersByTimeAsync(0);
        expect(setRuntimeViewerPresenceFn.mock.calls).toEqual([[true]]);

        releaseViewer();
        await vi.advanceTimersByTimeAsync(0);
        expect(setRuntimeViewerPresenceFn.mock.calls).toEqual([
          [true],
          [false],
        ]);

        await vi.advanceTimersByTimeAsync(1_000);
        expect(setRuntimeViewerPresenceFn).toHaveBeenCalledTimes(2);

        controller.finish();
        await process.abort();
      } finally {
        vi.useRealTimers();
      }
    });

    it("publishes newer viewer state after a stale publication succeeds", async () => {
      vi.useFakeTimers();
      try {
        let resolveFirst: (() => void) | undefined;
        const firstPublication = new Promise<void>((resolve) => {
          resolveFirst = resolve;
        });
        const controller = createControllableIterator();
        const setRuntimeViewerPresenceFn = vi
          .fn<(hasViewers: boolean) => Promise<void>>()
          .mockImplementationOnce(() => firstPublication)
          .mockResolvedValue(undefined);
        const process = new Process(controller.iterator, {
          projectPath: "/test",
          projectId: "proj-1" as UrlProjectId,
          sessionId: "sess-1",
          provider: "codex",
          setRuntimeViewerPresenceFn,
        });

        const releaseViewer = process.registerViewer();
        await vi.advanceTimersByTimeAsync(0);
        releaseViewer();
        resolveFirst?.();
        await vi.advanceTimersByTimeAsync(0);

        expect(setRuntimeViewerPresenceFn.mock.calls).toEqual([
          [true],
          [false],
        ]);

        controller.finish();
        await process.abort();
      } finally {
        vi.useRealTimers();
      }
    });

    it("does not retry a late viewer publication failure after teardown", async () => {
      vi.useFakeTimers();
      try {
        let rejectPublication: ((error: Error) => void) | undefined;
        const publication = new Promise<void>((_resolve, reject) => {
          rejectPublication = reject;
        });
        const controller = createControllableIterator();
        const setRuntimeViewerPresenceFn = vi
          .fn<(hasViewers: boolean) => Promise<void>>()
          .mockImplementation(() => publication);
        const process = new Process(controller.iterator, {
          projectPath: "/test",
          projectId: "proj-1" as UrlProjectId,
          sessionId: "sess-1",
          provider: "codex",
          setRuntimeViewerPresenceFn,
        });

        process.registerViewer();
        await vi.advanceTimersByTimeAsync(0);
        controller.finish();
        const abort = process.abort();
        rejectPublication?.(new Error("late host failure"));
        await vi.advanceTimersByTimeAsync(10_000);
        await abort;

        expect(setRuntimeViewerPresenceFn.mock.calls).toEqual([[true]]);
      } finally {
        vi.useRealTimers();
      }
    });

    it("a viewer suspends only that session's idle reap", async () => {
      vi.useFakeTimers();
      try {
        const viewedController = createControllableIterator();
        const unviewedController = createControllableIterator();
        const viewedAbort = vi.fn(() => {
          viewedController.finish();
        });
        const unviewedAbort = vi.fn(() => {
          unviewedController.finish();
        });
        const viewedProcess = new Process(viewedController.iterator, {
          projectPath: "/test",
          projectId: "proj-1" as UrlProjectId,
          sessionId: "viewed-session",
          provider: "claude",
          initialState: "idle",
          idleTimeoutMs: 20,
          abortFn: viewedAbort,
        });
        new Process(unviewedController.iterator, {
          projectPath: "/test",
          projectId: "proj-1" as UrlProjectId,
          sessionId: "unviewed-session",
          provider: "claude",
          initialState: "idle",
          idleTimeoutMs: 20,
          abortFn: unviewedAbort,
        });

        const releaseViewer = viewedProcess.registerViewer();
        await vi.advanceTimersByTimeAsync(19);
        expect(viewedAbort).not.toHaveBeenCalled();
        expect(unviewedAbort).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(1);
        expect(unviewedAbort).toHaveBeenCalledOnce();
        expect(viewedAbort).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(100);
        expect(viewedAbort).not.toHaveBeenCalled();
        releaseViewer();
        await vi.advanceTimersByTimeAsync(19);
        expect(viewedAbort).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(viewedAbort).toHaveBeenCalledOnce();
      } finally {
        vi.useRealTimers();
      }
    });

    it("never reaps waiting-input sessions for viewer absence", async () => {
      vi.useFakeTimers();
      try {
        const controller = createControllableIterator();
        const abortFn = vi.fn();
        const process = new Process(controller.iterator, {
          projectPath: "/test",
          projectId: "proj-1" as UrlProjectId,
          sessionId: "sess-1",
          provider: "claude",
          idleTimeoutMs: 20,
          abortFn,
        });

        controller.push({
          type: "system",
          subtype: "input_request",
          input_request: {
            id: "req-1",
            type: "tool-approval",
            prompt: "Continue?",
          },
        });
        await vi.advanceTimersByTimeAsync(0);
        expect(process.state.type).toBe("waiting-input");

        await vi.advanceTimersByTimeAsync(10_000);
        expect(abortFn).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it("never reaps active sessions for viewer absence", async () => {
      vi.useFakeTimers();
      try {
        const controller = createControllableIterator();
        const abortFn = vi.fn();
        const process = new Process(controller.iterator, {
          projectPath: "/test",
          projectId: "proj-1" as UrlProjectId,
          sessionId: "sess-1",
          provider: "claude",
          idleTimeoutMs: 20,
          abortFn,
        });
        expect(process.state.type).toBe("in-turn");

        await vi.advanceTimersByTimeAsync(10_000);
        expect(abortFn).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it("starts a full grace when provider retention ends", async () => {
      vi.useFakeTimers();
      try {
        const controller = createControllableIterator();
        const abortFn = vi.fn();
        let retained = true;
        const process = new Process(controller.iterator, {
          projectPath: "/test",
          projectId: "proj-1" as UrlProjectId,
          sessionId: "sess-1",
          provider: "claude",
          initialState: "idle",
          idleTimeoutMs: 20,
          abortFn,
          getProviderRetentionFn: () => ({
            retained,
            reasons: retained ? ["background-task"] : [],
          }),
        });

        await vi.advanceTimersByTimeAsync(100);
        expect(abortFn).not.toHaveBeenCalled();

        retained = false;
        process.handleProviderRetentionChanged();
        await vi.advanceTimersByTimeAsync(19);
        expect(abortFn).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(abortFn).toHaveBeenCalledOnce();
      } finally {
        vi.useRealTimers();
      }
    });

    it("periodically rechecks feature retention without a change callback", async () => {
      vi.useFakeTimers();
      try {
        const controller = createControllableIterator();
        const abortFn = vi.fn();
        let retained = true;
        new Process(controller.iterator, {
          projectPath: "/test",
          projectId: "proj-1" as UrlProjectId,
          sessionId: "sess-1",
          provider: "claude",
          initialState: "idle",
          idleTimeoutMs: 0,
          abortFn,
          shouldRetainIdleProcess: () => retained,
        });

        await vi.advanceTimersByTimeAsync(0);
        expect(abortFn).not.toHaveBeenCalled();

        retained = false;
        await vi.advanceTimersByTimeAsync(59_999);
        expect(abortFn).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(abortFn).toHaveBeenCalledOnce();
      } finally {
        vi.useRealTimers();
      }
    });

    it("keeps idle sessions indefinitely when idle reaping is disabled", async () => {
      vi.useFakeTimers();
      try {
        const controller = createControllableIterator();
        const abortFn = vi.fn();
        const process = new Process(controller.iterator, {
          projectPath: "/test",
          projectId: "proj-1" as UrlProjectId,
          sessionId: "sess-1",
          provider: "claude",
          initialState: "idle",
          idleTimeoutMs: -1,
          abortFn,
        });

        await vi.advanceTimersByTimeAsync(10_000);
        expect(abortFn).not.toHaveBeenCalled();

        process.updateIdleTimeoutMs(20);
        await vi.advanceTimersByTimeAsync(20);
        expect(abortFn).toHaveBeenCalledOnce();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("getInfo", () => {
    it("returns process info", async () => {
      const iterator = createMockIterator([]);
      const process = new Process(iterator, {
        projectPath: "/test/path",
        projectId: "proj-123" as UrlProjectId,
        sessionId: "sess-456",
        provider: "claude",
        idleTimeoutMs: 100,
        promptSuggestionMode: "native",
      });

      const info = process.getInfo();

      expect(info.id).toBe(process.id);
      expect(info.sessionId).toBe("sess-456");
      expect(info.projectId).toBe("proj-123");
      expect(info.projectPath).toBe("/test/path");
      expect(info.startedAt).toBeDefined();
      expect(info.promptSuggestionMode).toBe("native");
    });
  });

  describe("abort", () => {
    it("emits complete event on abort", async () => {
      const iterator = createMockIterator([]);
      const process = new Process(iterator, {
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude",
        idleTimeoutMs: 100,
      });

      let completed = false;
      process.subscribe((event) => {
        if (event.type === "complete") {
          completed = true;
        }
      });

      await process.abort();

      expect(completed).toBe(true);
    });

    it("clears listeners after abort", async () => {
      const iterator = createMockIterator([]);
      const process = new Process(iterator, {
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude",
        idleTimeoutMs: 100,
      });

      let completeCount = 0;
      process.subscribe((event) => {
        if (event.type === "complete") {
          completeCount++;
        }
      });

      await process.abort();

      // Listener should have been called once for complete event
      expect(completeCount).toBe(1);
    });
  });

  describe("interrupt", () => {
    it("propagates provider soft-interrupt failure", async () => {
      const controller = createControllableIterator();
      const interruptFn = vi.fn(async () => false);
      const process = new Process(controller.iterator, {
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude",
        idleTimeoutMs: 100,
        interruptFn,
      });

      await expect(process.interrupt()).resolves.toBe(false);
      expect(interruptFn).toHaveBeenCalledTimes(1);

      controller.finish();
      await process.abort();
    });

    it("drains all queued messages into a single packet after successful interrupt", async () => {
      const controller = createControllableIterator();
      const queue = new MessageQueue();
      const interruptFn = vi.fn(async () => true);

      const process = new Process(controller.iterator, {
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude",
        idleTimeoutMs: 100,
        queue,
        interruptFn,
      });

      // Queue two messages while agent is "working"
      queue.push({ text: "first" });
      queue.push({ text: "second" });

      expect(process.queueDepth).toBe(2);

      // Interrupt should drain both into one combined message
      const result = await process.interrupt();
      expect(result).toBe(true);

      // The two messages should have been drained and re-queued as a single packet
      // The depth should be 1 (the combined message), not 2
      expect(process.queueDepth).toBe(1);

      controller.finish();
      await process.abort();
    });

    it("drains deferred messages into interrupt packet alongside direct queue", async () => {
      const controller = createControllableIterator();
      const queue = new MessageQueue();
      const interruptFn = vi.fn(async () => true);

      const process = new Process(controller.iterator, {
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude",
        idleTimeoutMs: 100,
        queue,
        interruptFn,
      });

      // One direct queued message and one deferred
      queue.push({ text: "direct" });
      process.deferMessage({ text: "deferred", tempId: "temp-d" });

      expect(process.queueDepth).toBe(1);
      expect(process.getDeferredQueueSummary()).toHaveLength(1);

      await process.interrupt();

      // Deferred queue should be empty (drained into the interrupt packet)
      expect(process.getDeferredQueueSummary()).toHaveLength(0);
      // Direct queue should have exactly one combined message
      expect(process.queueDepth).toBe(1);

      controller.finish();
      await process.abort();
    });

    it("does not re-queue when interrupt drains an empty queue", async () => {
      const controller = createControllableIterator();
      const queue = new MessageQueue();
      const interruptFn = vi.fn(async () => true);

      const process = new Process(controller.iterator, {
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude",
        idleTimeoutMs: 100,
        queue,
        interruptFn,
      });

      // No messages queued
      expect(process.queueDepth).toBe(0);
      await process.interrupt();

      // Still empty — no phantom empty message was enqueued
      expect(process.queueDepth).toBe(0);

      controller.finish();
      await process.abort();
    });
  });

  describe("input request handling", () => {
    it("transitions to waiting-input on input_request message", async () => {
      const messages: SDKMessage[] = [
        { type: "system", subtype: "init", session_id: "sess-1" },
        {
          type: "system",
          subtype: "input_request",
          input_request: {
            id: "req-123",
            type: "tool-approval",
            prompt: "Allow file write?",
          },
        },
      ];

      const iterator = createMockIterator(messages);
      const process = new Process(iterator, {
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude",
        idleTimeoutMs: 100,
      });

      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(process.state.type).toBe("waiting-input");
      if (process.state.type === "waiting-input") {
        expect(process.state.request.id).toBe("req-123");
        expect(process.state.request.type).toBe("tool-approval");
        expect(process.state.request.prompt).toBe("Allow file write?");
      }
    });

    it("applies pending Edit and Bypass modes to mock harness requests", async () => {
      const controller = createControllableIterator();
      const process = new Process(controller.iterator, {
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude",
        idleTimeoutMs: 100,
      });

      controller.push({
        type: "system",
        subtype: "input_request",
        input_request: {
          id: "req-edit",
          type: "tool-approval",
          prompt: "Allow Edit?",
          toolName: "Edit",
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(process.state.type).toBe("waiting-input");

      process.setPermissionMode("acceptEdits");
      expect(process.state.type).toBe("in-turn");

      controller.push({
        type: "system",
        subtype: "input_request",
        input_request: {
          id: "req-next-edit",
          type: "tool-approval",
          prompt: "Allow another Edit?",
          toolName: "Edit",
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(process.state.type).toBe("in-turn");

      controller.push({
        type: "system",
        subtype: "input_request",
        input_request: {
          id: "req-command",
          type: "tool-approval",
          prompt: "Allow Bash?",
          toolName: "Bash",
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(process.state.type).toBe("waiting-input");

      process.setPermissionMode("bypassPermissions");
      expect(process.state.type).toBe("in-turn");

      controller.push({
        type: "system",
        subtype: "input_request",
        input_request: {
          id: "req-next-command",
          type: "tool-approval",
          prompt: "Allow another Bash?",
          toolName: "Bash",
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(process.state.type).toBe("in-turn");

      controller.push({
        type: "system",
        subtype: "input_request",
        input_request: {
          id: "req-question",
          type: "question",
          prompt: "Which option?",
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(process.getPendingInputRequest()?.id).toBe("req-question");
      process.respondToInput("req-question", "approve");

      controller.finish();
      await process.abort();
    });
  });
});
