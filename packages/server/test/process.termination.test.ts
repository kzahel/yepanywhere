import { afterEach, describe, expect, it, vi } from "vitest";
import { getLogger } from "../src/logging/logger.js";
import {
  Process,
  MessageQueue,
  createMockIterator,
  createControllableIterator,
} from "./process.test-support.js";
import type {
  ProcessEvent,
  SDKMessage,
  UrlProjectId,
} from "./process.test-support.js";

describe("Process", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("process termination", () => {
    it("isTerminated returns false for new process", async () => {
      const iterator = createMockIterator([
        { type: "system", subtype: "init", session_id: "sess-1" },
      ]);

      const process = new Process(iterator, {
        queue: new MessageQueue(),
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude",
        idleTimeoutMs: 100,
      });

      expect(process.isTerminated).toBe(false);
      expect(process.terminationReason).toBe(null);
    });

    it("queueMessage returns error when process is terminated", async () => {
      const errorLog = vi
        .spyOn(getLogger(), "error")
        .mockImplementation(() => undefined);
      const warnLog = vi
        .spyOn(getLogger(), "warn")
        .mockImplementation(() => undefined);
      // Create an iterator that throws a process termination error
      const error = new Error("ProcessTransport is not ready for writing");
      async function* failingIterator(): AsyncIterator<SDKMessage> {
        yield { type: "system", subtype: "init", session_id: "sess-1" };
        throw error;
      }

      const process = new Process(failingIterator(), {
        queue: new MessageQueue(),
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude",
        idleTimeoutMs: 100,
      });

      // Wait for the iterator to process and fail
      await vi.waitFor(() => {
        expect(process.isTerminated).toBe(true);
      });

      // Now queueMessage should return an error
      const result = process.queueMessage({ text: "should fail" });

      expect(result.success).toBe(false);
      expect(result.error).toContain("terminated");
      expect(errorLog).toHaveBeenCalledWith(
        expect.objectContaining({
          event: "process_error",
          errorMessage: error.message,
        }),
        expect.stringContaining(error.message),
      );
      expect(warnLog).toHaveBeenCalledWith(
        expect.objectContaining({
          event: "process_terminated",
          errorMessage: error.message,
        }),
        expect.stringContaining("underlying process terminated"),
      );
    });

    it.each([
      new Error(
        "Claude Code native binary not found at the previously installed SDK path",
      ),
      new Error("Claude Code executable not found at the configured path"),
      new Error("spawn native ENOENT"),
      new Error("Provider initialization failed", {
        cause: new Error("spawn native ENOENT"),
      }),
    ])(
      "rejects startup and reentrant input for a wrapped fatal error: %s",
      async (error) => {
        vi.spyOn(getLogger(), "error").mockImplementation(() => undefined);
        vi.spyOn(getLogger(), "warn").mockImplementation(() => undefined);
        const queue = new MessageQueue();
        const iterator: AsyncIterator<SDKMessage> = {
          next: async () => {
            throw error;
          },
        };
        const process = new Process(iterator, {
          projectPath: "/test",
          projectId: "proj-1" as UrlProjectId,
          sessionId: "startup-session",
          provider: "claude",
          queue,
        });
        let reentrant: ReturnType<Process["queueMessage"]> | undefined;
        process.subscribe((event) => {
          if (event.type === "error")
            reentrant = process.queueMessage({
              text: "must not enter the dead provider",
            });
        });
        try {
          await expect(process.waitForProviderSessionId()).rejects.toBe(error);
          await vi.waitFor(() => expect(process.isTerminated).toBe(true));
          expect(reentrant).toMatchObject({
            success: false,
            error: expect.stringContaining("terminated"),
          });
          expect(process.queueMessage({ text: "later input" }).success).toBe(
            false,
          );
          expect(queue.depth).toBe(0);
        } finally {
          await process.abort();
        }
      },
    );

    it("admits lazy first input but rejects input once an established owner is dead", async () => {
      vi.spyOn(getLogger(), "warn").mockImplementation(() => undefined);
      const controlled = createControllableIterator();
      const queue = new MessageQueue();
      const process = new Process(controlled.iterator, {
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "dead-owner",
        provider: "claude",
        queue,
        isProcessAlive: () => false,
        abortFn: () => controlled.finish(),
      });
      try {
        expect(
          process.queueMessage({ text: "first input starts the lazy provider" })
            .success,
        ).toBe(true);
        const queuedBefore = queue.depth;
        controlled.push({
          type: "system",
          subtype: "init",
          session_id: "dead-owner",
        });
        await process.waitForProviderSessionId();
        expect(
          process.queueMessage({ text: "must stay recoverable" }),
        ).toMatchObject({
          success: false,
          error: expect.stringContaining("no longer alive"),
        });
        expect(
          process.deferMessage({ text: "cannot defer into the dead owner" })
            .success,
        ).toBe(false);
        expect(queue.depth).toBe(queuedBefore);
      } finally {
        await process.abort();
      }
    });

    it("rejects provider session id waiters on explicit termination", async () => {
      let releaseIterator: (() => void) | undefined;
      const iteratorBlocked = new Promise<void>((resolve) => {
        releaseIterator = resolve;
      });
      const pendingIterator: AsyncIterator<SDKMessage> = {
        next: async () => {
          await iteratorBlocked;
          return { done: true, value: undefined };
        },
      };
      const abortFn = vi.fn(() => {
        releaseIterator?.();
      });
      const warnLog = vi
        .spyOn(getLogger(), "warn")
        .mockImplementation(() => undefined);
      const process = new Process(pendingIterator, {
        queue: new MessageQueue(),
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "pending-session",
        provider: "claude",
        idleTimeoutMs: 100,
        abortFn,
      });
      const providerSessionId = process.waitForProviderSessionId(10_000);

      process.terminate("explicit test termination");

      await expect(providerSessionId).rejects.toThrow(
        "Process terminated before reporting a provider session id: explicit test termination",
      );
      expect(abortFn).toHaveBeenCalledOnce();
      expect(warnLog).toHaveBeenCalledWith(
        expect.objectContaining({
          event: "process_terminated",
          reason: "explicit test termination",
        }),
        expect.any(String),
      );
    });

    it("rejects new input once reload-safe detach begins", async () => {
      let releaseAbort: (() => void) | undefined;
      const abortPending = new Promise<void>((resolve) => {
        releaseAbort = resolve;
      });
      const process = new Process(
        createMockIterator([
          { type: "system", subtype: "init", session_id: "sess-reload" },
        ]),
        {
          queue: new MessageQueue(),
          projectPath: "/test",
          projectId: "proj-1" as UrlProjectId,
          sessionId: "sess-reload",
          provider: "codex",
          idleTimeoutMs: 100,
          abortFn: () => abortPending,
        },
      );
      await vi.waitFor(() => expect(process.state.type).toBe("idle"));

      const detach = process.detachForServerReload();
      const result = process.queueMessage({ text: "must not be lost" });

      expect(result).toEqual({
        success: false,
        error: "Process is detaching for server reload",
      });
      releaseAbort?.();
      await detach;
    });

    it("does not let viewer telemetry failure block reload-safe detach", async () => {
      vi.useFakeTimers();
      try {
        const warnLog = vi
          .spyOn(getLogger(), "warn")
          .mockImplementation(() => undefined);
        const detachForServerReloadFn = vi.fn(async () => {});
        const setRuntimeViewerPresenceFn = vi.fn(async () => {
          throw new Error("host viewer update unavailable");
        });
        const process = new Process(
          createMockIterator([
            { type: "system", subtype: "init", session_id: "sess-reload" },
          ]),
          {
            queue: new MessageQueue(),
            projectPath: "/test",
            projectId: "proj-1" as UrlProjectId,
            sessionId: "sess-reload",
            provider: "codex",
            idleTimeoutMs: 100,
            detachForServerReloadFn,
            setRuntimeViewerPresenceFn,
          },
        );

        const detach = process.detachForServerReload();
        await vi.advanceTimersByTimeAsync(499);
        expect(detachForServerReloadFn).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        await detach;

        expect(setRuntimeViewerPresenceFn).toHaveBeenCalled();
        expect(detachForServerReloadFn).toHaveBeenCalledOnce();
        expect(warnLog).toHaveBeenCalledWith(
          expect.objectContaining({
            event: "runtime_viewer_presence_update_failed",
            error: "host viewer update unavailable",
          }),
          "Failed to update reload-safe runtime viewer presence",
        );
        expect(warnLog).toHaveBeenCalledWith(
          expect.objectContaining({
            event: "runtime_viewer_presence_detach_unconfirmed",
          }),
          "Proceeding with provider detach without confirmed viewer state",
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it("publishes an attributed notice when the provider dies unrequested", async () => {
      vi.spyOn(getLogger(), "error").mockImplementation(() => undefined);
      vi.spyOn(getLogger(), "warn").mockImplementation(() => undefined);
      const error = new Error(
        "Provider worker process exited: Provider reload replay buffer exceeded its bound",
      );
      async function* failingIterator(): AsyncIterator<SDKMessage> {
        yield { type: "system", subtype: "init", session_id: "sess-1" };
        yield {
          type: "assistant",
          uuid: "assistant-1",
          session_id: "sess-1",
          message: { role: "assistant", content: "working" },
        };
        throw error;
      }

      const process = new Process(failingIterator(), {
        queue: new MessageQueue(),
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "codex",
        idleTimeoutMs: 100,
      });
      const events: ProcessEvent[] = [];
      process.subscribe((event) => {
        events.push(event);
      });

      await vi.waitFor(() => expect(process.isTerminated).toBe(true));

      const notice = events.find(
        (event) =>
          event.type === "message" && event.message.subtype === "local_command",
      );
      expect(notice).toMatchObject({
        message: {
          type: "system",
          subtype: "local_command",
          content: expect.stringContaining("not interrupted by you"),
          details: [error.message],
          detailsOpen: true,
          placementAfterMessageId: "assistant-1",
          isSynthetic: true,
        },
      });
      const terminated = events.find((event) => event.type === "terminated");
      expect(terminated).toMatchObject({
        failureNotice: (notice as { message: unknown }).message,
      });
      expect(events.indexOf(notice as ProcessEvent)).toBeLessThan(
        events.indexOf(terminated as ProcessEvent),
      );
    });

    it("publishes no failure notice when the provider dies between turns", async () => {
      vi.spyOn(getLogger(), "error").mockImplementation(() => undefined);
      vi.spyOn(getLogger(), "warn").mockImplementation(() => undefined);
      const error = new Error("Provider worker process exited: signal 9");
      let failProvider!: () => void;
      const delivered: SDKMessage[] = [
        { type: "system", subtype: "init", session_id: "sess-1" },
        { type: "result", subtype: "success", session_id: "sess-1" },
      ];
      const iterator: AsyncIterator<SDKMessage> = {
        next: () => {
          const value = delivered.shift();
          if (value) return Promise.resolve({ done: false, value });
          return new Promise((_resolve, reject) => {
            failProvider = () => reject(error);
          });
        },
      };
      const process = new Process(iterator, {
        queue: new MessageQueue(),
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "codex",
        idleTimeoutMs: 60_000,
      });
      const events: ProcessEvent[] = [];
      process.subscribe((event) => {
        events.push(event);
      });
      await vi.waitFor(() => expect(failProvider).toBeTypeOf("function"));
      expect(process.state.type).toBe("idle");

      failProvider();
      await vi.waitFor(() => expect(process.isTerminated).toBe(true));

      const terminated = events.find((event) => event.type === "terminated");
      expect(terminated).toBeDefined();
      expect(terminated).not.toHaveProperty("failureNotice");
      expect(
        events.some(
          (event) =>
            event.type === "message" &&
            event.message.subtype === "local_command",
        ),
      ).toBe(false);
    });

    it("publishes a failure notice after a command notice still saving", async () => {
      vi.spyOn(getLogger(), "error").mockImplementation(() => undefined);
      vi.spyOn(getLogger(), "warn").mockImplementation(() => undefined);
      const error = new Error("Provider worker process exited: signal 9");
      let failProvider!: () => void;
      let delivered = false;
      const iterator: AsyncIterator<SDKMessage> = {
        next: () => {
          if (!delivered) {
            delivered = true;
            return Promise.resolve({
              done: false,
              value: { type: "system", subtype: "init", session_id: "sess-1" },
            });
          }
          return new Promise((_resolve, reject) => {
            failProvider = () => reject(error);
          });
        },
      };
      const process = new Process(iterator, {
        queue: new MessageQueue(),
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "codex",
        idleTimeoutMs: 100,
        runProviderCommandFn: async () => ({
          handled: true,
          output: { summary: "/goal", details: ["Keep working"] },
        }),
      });
      const events: ProcessEvent[] = [];
      process.subscribe((event) => {
        events.push(event);
      });
      await vi.waitFor(() => expect(failProvider).toBeTypeOf("function"));

      let finishSave!: () => void;
      const saving = new Promise<void>((resolve) => {
        finishSave = resolve;
      });
      const persistOutput = vi.fn(() => saving);
      const command = process.runProviderCommand("goal", "Keep working", {
        persistOutput,
      });
      await vi.waitFor(() => expect(persistOutput).toHaveBeenCalledOnce());
      failProvider();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(process.isTerminated).toBe(false);

      finishSave();
      await command;
      await vi.waitFor(() => expect(process.isTerminated).toBe(true));

      const published = events.flatMap((event) =>
        event.type === "message" && event.message.subtype === "local_command"
          ? [event.message.content]
          : event.type === "terminated"
            ? ["terminated"]
            : [],
      );
      expect(published).toEqual([
        "/goal",
        expect.stringContaining("not interrupted by you"),
        "terminated",
      ]);
    });

    it("attributes a refused rewind rather than reporting a crash", async () => {
      vi.spyOn(getLogger(), "error").mockImplementation(() => undefined);
      vi.spyOn(getLogger(), "warn").mockImplementation(() => undefined);
      const error = new Error(
        "Provider worker process exited: Claude Code returned an error result: Resume rejected by --resume-drops-turn: range contains absorbed queued content",
      );
      async function* refusingIterator(): AsyncIterator<SDKMessage> {
        yield { type: "system", subtype: "init", session_id: "sess-1" };
        throw error;
      }

      const process = new Process(refusingIterator(), {
        queue: new MessageQueue(),
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude",
        idleTimeoutMs: 100,
      });
      const events: ProcessEvent[] = [];
      process.subscribe((event) => {
        events.push(event);
      });

      await vi.waitFor(() => expect(process.isTerminated).toBe(true));

      const notice = events.find(
        (event) =>
          event.type === "message" && event.message.subtype === "local_command",
      );
      expect(notice).toMatchObject({
        message: {
          content:
            "Claude refused the rewind and exited; the dropped turns were kept",
          details: [error.message],
          detailsOpen: true,
        },
      });
    });

    it("publishes no failure notice for a requested termination", async () => {
      vi.spyOn(getLogger(), "warn").mockImplementation(() => undefined);
      const process = new Process(
        createMockIterator([
          { type: "system", subtype: "init", session_id: "sess-1" },
        ]),
        {
          queue: new MessageQueue(),
          projectPath: "/test",
          projectId: "proj-1" as UrlProjectId,
          sessionId: "sess-1",
          provider: "codex",
          idleTimeoutMs: 100,
        },
      );
      const events: ProcessEvent[] = [];
      process.subscribe((event) => {
        events.push(event);
      });

      process.terminate("user stopped session");

      const terminated = events.find((event) => event.type === "terminated");
      expect(terminated).toBeDefined();
      expect(terminated).not.toHaveProperty("failureNotice");
      expect(
        events.some(
          (event) =>
            event.type === "message" &&
            event.message.subtype === "local_command",
        ),
      ).toBe(false);
    });

    it("emits terminated event when process dies", async () => {
      const errorLog = vi
        .spyOn(getLogger(), "error")
        .mockImplementation(() => undefined);
      const warnLog = vi
        .spyOn(getLogger(), "warn")
        .mockImplementation(() => undefined);
      const error = new Error("ProcessTransport is not ready for writing");
      async function* failingIterator(): AsyncIterator<SDKMessage> {
        yield { type: "system", subtype: "init", session_id: "sess-1" };
        throw error;
      }

      const process = new Process(failingIterator(), {
        queue: new MessageQueue(),
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude",
        idleTimeoutMs: 100,
      });

      let terminatedEvent: { reason: string; error?: Error } | null = null;
      process.subscribe((event) => {
        if (event.type === "terminated") {
          terminatedEvent = { reason: event.reason, error: event.error };
        }
      });

      // Wait for the terminated event
      await vi.waitFor(() => {
        expect(terminatedEvent).not.toBe(null);
      });

      // terminatedEvent is only assigned inside the subscribe callback, so
      // control-flow analysis narrows it back to its `null` initializer here;
      // read through the declared type to access the captured fields.
      const captured = terminatedEvent as {
        reason: string;
        error?: Error;
      } | null;
      expect(captured?.reason).toContain("terminated");
      expect(captured?.error).toBe(error);
      expect(errorLog).toHaveBeenCalledWith(
        expect.objectContaining({ event: "process_error" }),
        expect.any(String),
      );
      expect(warnLog).toHaveBeenCalledWith(
        expect.objectContaining({ event: "process_terminated" }),
        expect.any(String),
      );
    });

    it("getInfo returns terminated state", async () => {
      const errorLog = vi
        .spyOn(getLogger(), "error")
        .mockImplementation(() => undefined);
      const warnLog = vi
        .spyOn(getLogger(), "warn")
        .mockImplementation(() => undefined);
      const error = new Error("process exited");
      async function* failingIterator(): AsyncIterator<SDKMessage> {
        yield { type: "system", subtype: "init", session_id: "sess-1" };
        throw error;
      }

      const process = new Process(failingIterator(), {
        queue: new MessageQueue(),
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude",
        idleTimeoutMs: 100,
      });

      // Wait for termination
      await vi.waitFor(() => {
        expect(process.isTerminated).toBe(true);
      });

      const info = process.getInfo();
      expect(info.state).toBe("terminated");
      expect(errorLog).toHaveBeenCalledWith(
        expect.objectContaining({ event: "process_error" }),
        expect.any(String),
      );
      expect(warnLog).toHaveBeenCalledWith(
        expect.objectContaining({ event: "process_terminated" }),
        expect.any(String),
      );
    });

    it("terminates after emitting a Claude SDK API error message", async () => {
      const warnLog = vi
        .spyOn(getLogger(), "warn")
        .mockImplementation(() => undefined);
      const apiError: SDKMessage = {
        type: "assistant",
        uuid: "25f342b9-efa8-416c-9e9b-e617f61af756",
        message: {
          model: "<synthetic>",
          role: "assistant",
          content: [
            {
              type: "text",
              text: "API Error: 529 Overloaded. This is a server-side issue, usually temporary.",
            },
          ],
        },
        isApiErrorMessage: true,
        apiErrorStatus: 529,
      };
      const abortFn = vi.fn();
      const iterator = createMockIterator([apiError]);
      const process = new Process(iterator, {
        queue: new MessageQueue(),
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude",
        idleTimeoutMs: 100,
        abortFn,
      });
      const providerSessionId = process.waitForProviderSessionId(10_000);
      const providerSessionIdRejection = expect(
        providerSessionId,
      ).rejects.toThrow("API Error: 529 Overloaded");

      const events: ProcessEvent[] = [];
      process.subscribe((event) => {
        events.push(event);
      });

      await vi.waitFor(() => {
        expect(process.isTerminated).toBe(true);
      });

      await providerSessionIdRejection;

      const messageEventIndex = events.findIndex(
        (event) =>
          event.type === "message" &&
          event.message.type === "assistant" &&
          event.message.uuid === apiError.uuid &&
          event.message.isApiErrorMessage === true &&
          event.message.apiErrorStatus === 529,
      );
      const terminatedEventIndex = events.findIndex(
        (event) => event.type === "terminated",
      );

      expect(messageEventIndex).toBeGreaterThanOrEqual(0);
      expect(terminatedEventIndex).toBeGreaterThan(messageEventIndex);
      expect(process.terminationReason).toBe(
        "Claude SDK API error; restart required",
      );
      expect(abortFn).toHaveBeenCalledOnce();
      expect(process.queueMessage({ text: "should fail" }).success).toBe(false);
      expect(warnLog).toHaveBeenCalledWith(
        expect.objectContaining({
          event: "process_terminated",
          reason: "Claude SDK API error; restart required",
        }),
        expect.any(String),
      );
    });

    it("does not terminate non-Claude processes on Claude-shaped API errors", async () => {
      const apiError: SDKMessage = {
        type: "assistant",
        message: {
          model: "<synthetic>",
          role: "assistant",
          content: "API Error: 529 Overloaded.",
        },
        isApiErrorMessage: true,
        apiErrorStatus: 529,
      };
      const iterator = createMockIterator([
        { type: "system", subtype: "init", session_id: "sess-1" },
        apiError,
        { type: "result", session_id: "sess-1" },
      ]);
      const process = new Process(iterator, {
        queue: new MessageQueue(),
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "codex",
        idleTimeoutMs: 100,
      });

      await vi.waitFor(() => {
        expect(process.state.type).toBe("idle");
      });

      expect(process.isTerminated).toBe(false);
    });

    it("awaits provider shutdown and verifies provider liveness", async () => {
      let resolveShutdown: (() => void) | undefined;
      let alive = true;
      const shutdown = new Promise<void>((resolve) => {
        resolveShutdown = () => {
          alive = false;
          resolve();
        };
      });
      const process = new Process(
        createMockIterator([
          { type: "system", subtype: "init", session_id: "sess-verified" },
        ]),
        {
          queue: new MessageQueue(),
          projectPath: "/test",
          projectId: "proj-1" as UrlProjectId,
          sessionId: "sess-verified",
          provider: "codex",
          abortFn: () => shutdown,
          isProcessAlive: () => alive,
        },
      );

      const abortResult = process.abort();
      await Promise.resolve();
      expect(alive).toBe(true);

      resolveShutdown?.();
      await expect(abortResult).resolves.toMatchObject({
        sessionId: "sess-verified",
        verifiedStopped: true,
        verification: "provider",
      });
    });

    it("rejects an abort when the provider still reports a live process", async () => {
      const process = new Process(
        createMockIterator([
          { type: "system", subtype: "init", session_id: "sess-still-live" },
        ]),
        {
          queue: new MessageQueue(),
          projectPath: "/test",
          projectId: "proj-1" as UrlProjectId,
          sessionId: "sess-still-live",
          provider: "codex",
          abortFn: vi.fn(),
          isProcessAlive: () => true,
        },
      );

      await expect(process.abort()).rejects.toThrow(
        "Provider still reports its process as running after abort",
      );
    });
  });
});
