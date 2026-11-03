import { prepareClaudeInput } from "../src/sdk/providers/claude-delivery.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getLogger } from "../src/logging/logger.js";
import {
  CONCAT_SEPARATOR,
  MessageQueue,
  Process,
  createControllableIterator,
  createMockIterator,
  waitFor,
  withSessionQueuePersistence,
} from "./process.test-support.js";
import type { ProcessEvent, UrlProjectId } from "./process.test-support.js";

describe("Process", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("effort boundary", () => {
    it("queues modifiers through an active turn and preserves them through interrupt", async () => {
      const controller = createControllableIterator();
      const queue = new MessageQueue();
      const steer = vi.fn(async () => true);
      const process = new Process(controller.iterator, {
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "turn-effort",
        provider: "claude",
        queue,
        steerFn: steer,
        interruptFn: async () => true,
        effort: "high",
        idleTimeoutMs: 10_000,
      });
      controller.push({
        type: "system",
        subtype: "init",
        session_id: "turn-effort",
      });
      await waitFor(() => expect(process.state.type).toBe("in-turn"));
      expect(
        process.queueMessage({
          text: "careful",
          metadata: { turnEffort: "slow" },
        }).success,
      ).toBe(true);
      process.deferMessage({ text: "ordinary" });
      expect(steer).not.toHaveBeenCalled();
      expect(queue.depth).toBe(0);
      expect(process.effort).toBe("high");
      await process.interrupt();
      controller.push({ type: "result", session_id: "turn-effort" });
      await waitFor(() => expect(queue.depth).toBe(1));
      const delivered = queue.drain();
      expect(delivered[0]?.metadata?.turnEffort).toBe("slow");
      expect(delivered[0]?.text).toContain("careful");
      expect(delivered[0]?.text).not.toContain("ordinary");
      controller.push({ type: "result", session_id: "turn-effort" });
      await waitFor(() => expect(queue.depth).toBe(1));
      expect(queue.drain()[0]).toMatchObject({ text: "ordinary" });
      controller.finish();
    });

    it("publishes effort immediately when the provider supports active turns", async () => {
      const controller = createControllableIterator();
      const setEffort = vi.fn(async () => {});
      const process = new Process(controller.iterator, {
        queue: new MessageQueue(),
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "active-effort-session",
        provider: "codex",
        setEffortFn: setEffort,
        effortUpdatesActiveTurn: true,
        idleTimeoutMs: 10_000,
      });
      controller.push({
        type: "system",
        subtype: "init",
        session_id: "active-effort-session",
      });
      await waitFor(() => expect(process.state.type).toBe("in-turn"));

      await expect(process.setEffort("high")).resolves.toBe(true);

      expect(setEffort).toHaveBeenCalledWith("high");
      expect(process.appliedEffort).toBe("high");
      controller.finish();
    });

    it.each(["high", undefined] as const)(
      "acknowledges retained effort %s after live failures and applies it before queued work",
      async (effort) => {
        const controller = createControllableIterator();
        const providerQueue = new MessageQueue();
        const push = vi.spyOn(providerQueue, "push");
        let releaseBoundary = () => {};
        const boundary = new Promise<void>((resolve) => {
          releaseBoundary = resolve;
        });
        const setEffort = vi
          .fn<(_effort?: string) => Promise<void>>()
          .mockRejectedValueOnce(new Error("live update rejected"))
          .mockRejectedValueOnce(new Error("live update rejected"))
          .mockImplementation(() => boundary);
        const process = new Process(controller.iterator, {
          projectPath: "/test",
          projectId: "proj-1" as UrlProjectId,
          sessionId: "retained-effort-session",
          provider: "codex",
          queue: providerQueue,
          effort: "low",
          setEffortFn: setEffort,
          effortUpdatesActiveTurn: true,
          idleTimeoutMs: 10_000,
        });
        controller.push({
          type: "system",
          subtype: "init",
          session_id: "retained-effort-session",
        });
        await waitFor(() => expect(process.state.type).toBe("in-turn"));

        await expect(process.setEffort("max")).resolves.toBe(true);
        await expect(process.setEffort(effort)).resolves.toBe(true);
        expect(process.effort).toBe(effort);
        expect(process.appliedEffort).toBe("low");
        process.deferMessage({ text: "after effort" });
        controller.push({
          type: "result",
          session_id: "retained-effort-session",
        });
        await waitFor(() => expect(setEffort).toHaveBeenCalledTimes(3));
        expect(setEffort).toHaveBeenLastCalledWith(effort);
        expect(push).not.toHaveBeenCalled();

        releaseBoundary();
        await waitFor(() => expect(push).toHaveBeenCalledOnce());
        expect(process.appliedEffort).toBe(effort);
        controller.finish();
      },
    );

    it("retains a failed effort selection and blocks deferred delivery", async () => {
      const errorLog = vi
        .spyOn(getLogger(), "error")
        .mockImplementation(() => undefined);
      const warnLog = vi
        .spyOn(getLogger(), "warn")
        .mockImplementation(() => undefined);
      const controller = createControllableIterator();
      const providerQueue = new MessageQueue();
      const push = vi.spyOn(providerQueue, "push");
      const setEffort = vi
        .fn<(_effort?: "high" | "max") => Promise<void>>()
        .mockRejectedValueOnce(new Error("provider rejected effort"))
        .mockResolvedValue(undefined);
      const process = new Process(controller.iterator, {
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "effort-failure-session",
        provider: "claude",
        queue: providerQueue,
        setEffortFn: setEffort,
        idleTimeoutMs: 10_000,
      });
      const configurationErrors: ProcessEvent[] = [];
      const unsubscribe = process.subscribe((event) => {
        if (event.type === "configuration-error") {
          configurationErrors.push(event);
        }
      });
      controller.push({
        type: "system",
        subtype: "init",
        session_id: "effort-failure-session",
      });
      await waitFor(() => expect(process.state.type).toBe("in-turn"));

      await process.setEffort("high");
      process.deferMessage({
        text: "after effort",
        metadata: { deliveryIntent: "deferred" },
      });
      controller.push({
        type: "result",
        session_id: "effort-failure-session",
      });
      await waitFor(() => expect(setEffort).toHaveBeenCalledWith("high"));
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(process.effort).toBe("high");
      expect(push).not.toHaveBeenCalled();
      expect(configurationErrors).toEqual([
        expect.objectContaining({
          type: "configuration-error",
          setting: "effort",
          requestedValue: "high",
        }),
      ]);
      expect(errorLog).toHaveBeenCalledWith(
        expect.objectContaining({
          event: "effort_change_boundary_failed",
          requestedEffort: "high",
        }),
        "Failed to apply effort before queued work",
      );

      await process.setEffort("max");
      expect(process.effort).toBe("max");
      expect(push).toHaveBeenCalledTimes(1);
      controller.push({
        type: "result",
        session_id: "effort-failure-session",
      });
      await waitFor(() => expect(process.state.type).toBe("idle"));
      unsubscribe();
      process.terminate("test complete");
      expect(warnLog).toHaveBeenCalledWith(
        expect.objectContaining({
          event: "process_terminated",
          reason: "test complete",
        }),
        expect.any(String),
      );
      controller.finish();
    });
  });

  describe("deferred queue", () => {
    it("holds provider delivery behind a separate queued YA command", async () => {
      const warnLog = vi
        .spyOn(getLogger(), "warn")
        .mockImplementation(() => undefined);
      const controller = createControllableIterator();
      const providerQueue = new MessageQueue();
      const push = vi.spyOn(providerQueue, "push");
      const process = new Process(controller.iterator, {
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "ya-command-session",
        provider: "claude",
        queue: providerQueue,
        idleTimeoutMs: 10_000,
      });
      const queueEvents: ProcessEvent[] = [];
      const unsubscribe = process.subscribe((event) => {
        if (event.type === "deferred-queue") {
          queueEvents.push(event);
        }
      });

      process.deferMessage({
        text: "ordinary queued work",
        tempId: "temp-ordinary",
      });
      const pending = process.queueYaCommand("done", {
        tempId: "ya-done-queued",
        timestamp: "2026-08-16T10:00:00.000Z",
      });
      expect(process.getDeferredQueueSummary()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            tempId: pending.tempId,
            content: "/done",
            kind: "ya-command",
            yaCommand: "done",
            status: "queued",
          }),
        ]),
      );
      const archive = process.queueYaCommand("done", { content: "/archive" });
      expect(archive).toBe(pending);
      expect(process.getDeferredQueueSummary()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            tempId: pending.tempId,
            content: "/archive",
            kind: "ya-command",
            yaCommand: "done",
            status: "queued",
          }),
        ]),
      );

      controller.push({
        type: "result",
        session_id: "ya-command-session",
      });
      await waitFor(() => expect(process.state.type).toBe("idle"));
      expect(push).not.toHaveBeenCalled();

      expect(process.beginPendingYaCommandCompletion("done")).toBe(pending);
      expect(process.completePendingYaCommand(pending.tempId)).toBe(true);
      await waitFor(() => expect(push).toHaveBeenCalledOnce());
      expect(push.mock.calls[0]?.[0]).toMatchObject({
        text: "ordinary queued work",
      });
      expect(
        push.mock.calls.some(
          ([message]) =>
            message.text === "/done" || message.text === "/archive",
        ),
      ).toBe(false);
      expect(queueEvents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "deferred-queue",
            reason: "queued",
            tempId: pending.tempId,
            yaCommand: "done",
          }),
          expect.objectContaining({
            type: "deferred-queue",
            reason: "promoted",
            tempId: pending.tempId,
            yaCommand: "done",
          }),
        ]),
      );

      unsubscribe();
      process.terminate("test complete");
      expect(warnLog).toHaveBeenCalledWith(
        expect.objectContaining({
          event: "process_terminated",
          reason: "test complete",
        }),
        expect.any(String),
      );
      controller.finish();
    });

    it("includes attachment count in deferred queue summaries", async () => {
      const iterator = createMockIterator([
        { type: "system", session_id: "sess-1" },
      ]);

      const process = new Process(iterator, {
        queue: new MessageQueue(),
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude",
        idleTimeoutMs: 100,
      });

      process.deferMessage({
        text: "see attached",
        tempId: "temp-1",
        attachments: [
          {
            id: "file-1",
            originalName: "screenshot.png",
            name: "screenshot.png",
            size: 1024,
            mimeType: "image/png",
            path: "/uploads/screenshot.png",
          },
        ],
      });

      expect(process.getDeferredQueueSummary()).toEqual([
        {
          tempId: "temp-1",
          content: "see attached",
          timestamp: expect.any(String),
          attachmentCount: 1,
          attachments: [
            {
              id: "file-1",
              originalName: "screenshot.png",
              name: "screenshot.png",
              size: 1024,
              mimeType: "image/png",
              path: "/uploads/screenshot.png",
            },
          ],
        },
      ]);
    });

    it("includes user message metadata in deferred queue summaries", async () => {
      const iterator = createMockIterator([
        { type: "system", session_id: "sess-1" },
      ]);

      const process = new Process(iterator, {
        queue: new MessageQueue(),
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude",
        idleTimeoutMs: 100,
      });
      const metadata = {
        deliveryIntent: "deferred" as const,
        composition: {
          typingStartedAt: "2026-04-25T00:00:10.000Z",
          typingEndedAt: "2026-04-25T00:00:20.000Z",
          lastEditedAt: "2026-04-25T00:00:19.000Z",
          submittedAt: "2026-04-25T00:00:20.000Z",
        },
        clientTimestamp: 1770000000123,
        serverReceivedAt: "2026-04-25T00:00:20.250Z",
      };

      process.deferMessage({
        text: "later",
        tempId: "temp-meta",
        metadata,
      });

      expect(process.getDeferredQueueSummary()).toEqual([
        {
          tempId: "temp-meta",
          content: "later",
          timestamp: expect.any(String),
          metadata,
        },
      ]);
    });

    it("persists only patient queue entries and deletes them on cancel", async () => {
      await withSessionQueuePersistence(async ({ service, projectId }) => {
        const controller = createControllableIterator();

        const process = new Process(controller.iterator, {
          queue: new MessageQueue(),
          projectPath: "/tmp/process-session-queue",
          projectId,
          sessionId: "sess-1",
          provider: "claude",
          idleTimeoutMs: 100,
          sessionQueuePersistenceService: service,
        });

        try {
          process.deferMessage({
            text: "short deferred",
            tempId: "temp-deferred",
            metadata: { deliveryIntent: "deferred" },
          });
          process.deferMessage({
            text: "patient follow-up",
            tempId: "temp-patient",
            metadata: {
              deliveryIntent: "patient",
              serverReceivedAt: "2026-06-30T10:00:00.000Z",
            },
          });
          await process.waitForPatientQueuePersistenceIdle();

          expect(service.list()).toMatchObject([
            {
              sessionId: "sess-1",
              projectId,
              kind: "patient",
              status: "queued",
              message: {
                text: "patient follow-up",
                tempId: "temp-patient",
                metadata: {
                  deliveryIntent: "patient",
                  serverReceivedAt: "2026-06-30T10:00:00.000Z",
                },
              },
              source: { tempId: "temp-patient" },
              createdAt: "2026-06-30T10:00:00.000Z",
            },
          ]);
          expect(process.getDeferredQueueSummary()).toMatchObject([
            { tempId: "temp-deferred", content: "short deferred" },
            {
              id: service.list()[0]?.id,
              tempId: "temp-patient",
              content: "patient follow-up",
              kind: "patient",
              status: "queued",
            },
          ]);

          expect(process.cancelDeferredMessage("temp-patient")).toBe(true);
          await process.waitForPatientQueuePersistenceIdle();

          expect(service.list()).toEqual([]);
        } finally {
          controller.finish();
          await process.abort();
        }
      });
    });

    it("persists Codex patient entries until turn-end promotion", async () => {
      await withSessionQueuePersistence(async ({ service, projectId }) => {
        const controller = createControllableIterator();
        const queue = new MessageQueue();
        const process = new Process(controller.iterator, {
          projectPath: "/tmp/process-session-queue",
          projectId,
          sessionId: "sess-1",
          provider: "codex",
          idleTimeoutMs: 100,
          queue,
          sessionQueuePersistenceService: service,
        });

        process.deferMessage(
          {
            text: "patient follow-up",
            tempId: "temp-patient-codex",
            metadata: { deliveryIntent: "patient" },
          },
          { promoteIfReady: true },
        );
        await process.waitForPatientQueuePersistenceIdle();

        expect(service.list()).toMatchObject([
          {
            sessionId: "sess-1",
            provider: "codex",
            kind: "patient",
            status: "queued",
            message: {
              text: "patient follow-up",
              tempId: "temp-patient-codex",
              metadata: { deliveryIntent: "patient" },
            },
          },
        ]);

        controller.push({ type: "result", session_id: "sess-1" });
        await waitFor(() => expect(queue.depth).toBe(1));
        await process.waitForPatientQueuePersistenceIdle();
        expect(service.list()).toEqual([]);

        controller.finish();
        await process.abort();
      });
    });

    it("deletes persisted patient entries when they promote", async () => {
      await withSessionQueuePersistence(async ({ service, projectId }) => {
        const controller = createControllableIterator();
        const queue = new MessageQueue();
        const process = new Process(controller.iterator, {
          projectPath: "/tmp/process-session-queue",
          projectId,
          sessionId: "sess-1",
          provider: "claude",
          idleTimeoutMs: 100,
          queue,
          sessionQueuePersistenceService: service,
        });

        process.deferMessage(
          {
            text: "patient follow-up",
            tempId: "temp-patient",
            metadata: { deliveryIntent: "patient" },
          },
          { promoteIfReady: true },
        );
        await process.waitForPatientQueuePersistenceIdle();
        expect(service.list()).toHaveLength(1);

        controller.push({ type: "result", session_id: "sess-1" });
        await waitFor(() => expect(process.state.type).toBe("idle"));

        expect(
          process.promoteEligiblePatientDeferredMessages({
            quietSinceMs: Date.now() - 30_000,
          }),
        ).toMatchObject({ promoted: true });
        await process.waitForPatientQueuePersistenceIdle();

        expect(service.list()).toEqual([]);

        controller.finish();
        await process.abort();
      });
    });

    it("deletes the persisted row when a resumed entry promotes straight through", async () => {
      await withSessionQueuePersistence(async ({ service, projectId }) => {
        const controller = createControllableIterator();
        const queue = new MessageQueue();
        // Outside the Claude patient lane a patient-tagged deferMessage with
        // promoteIfReady sends immediately on an idle process; the durable
        // row must still be released even though no queue entry ever exists.
        const process = new Process(controller.iterator, {
          projectPath: "/tmp/process-session-queue",
          projectId,
          sessionId: "sess-1",
          provider: "codex",
          // Keep the recovered process alive while the durable fixture is
          // written; loaded CI can take longer than the production-irrelevant
          // 100 ms timeout used by neighboring transition tests.
          idleTimeoutMs: 60_000,
          queue,
          sessionQueuePersistenceService: service,
        });

        controller.push({ type: "result", session_id: "sess-1" });
        await waitFor(() => expect(process.state.type).toBe("idle"));

        await service.upsertItem({
          id: "row-1",
          sessionId: "sess-1",
          projectId,
          projectPath: "/tmp/process-session-queue",
          provider: "codex",
          kind: "patient",
          message: {
            text: "resume me",
            tempId: "temp-recovered",
            metadata: { deliveryIntent: "patient" },
          },
          createdAt: "2026-06-30T09:00:00.000Z",
          updatedAt: "2026-06-30T09:00:00.000Z",
          queuedAt: "2026-06-30T09:00:00.000Z",
          status: "paused-after-restart",
        });

        const result = process.deferMessage(
          {
            text: "resume me",
            tempId: "temp-recovered",
            metadata: { deliveryIntent: "patient" },
          },
          {
            promoteIfReady: true,
            persistedQueueId: "row-1",
            timestamp: "2026-06-30T09:00:00.000Z",
          },
        );
        expect(result).toMatchObject({ success: true, promoted: true });
        await process.waitForPatientQueuePersistenceIdle();

        expect(service.list()).toEqual([]);

        controller.finish();
        await process.abort();
      });
    });

    it("preserves patient queue entries as paused restart work", async () => {
      await withSessionQueuePersistence(async ({ service, projectId }) => {
        const iterator = createMockIterator([
          { type: "system", session_id: "sess-1" },
        ]);
        const process = new Process(iterator, {
          queue: new MessageQueue(),
          projectPath: "/tmp/process-session-queue",
          projectId,
          sessionId: "sess-1",
          provider: "claude",
          idleTimeoutMs: 100,
          sessionQueuePersistenceService: service,
        });

        process.deferMessage({
          text: "patient follow-up",
          tempId: "temp-patient",
          metadata: {
            deliveryIntent: "patient",
            serverReceivedAt: "2026-06-30T10:00:00.000Z",
          },
        });
        await process.waitForPatientQueuePersistenceIdle();

        const preserved =
          await process.preservePatientDeferredMessagesForRestart();
        await process.waitForPatientQueuePersistenceIdle();

        expect(preserved).toBe(1);
        expect(process.getDeferredQueueSummary()).toEqual([]);
        expect(service.list()).toMatchObject([
          {
            sessionId: "sess-1",
            projectId,
            kind: "patient",
            status: "paused-after-restart",
            message: {
              text: "patient follow-up",
              tempId: "temp-patient",
              metadata: {
                deliveryIntent: "patient",
                serverReceivedAt: "2026-06-30T10:00:00.000Z",
              },
            },
            source: { tempId: "temp-patient" },
            createdAt: "2026-06-30T10:00:00.000Z",
          },
        ]);
      });
    });

    it("drains deferred messages for replacement process recovery", async () => {
      const iterator = createMockIterator([
        { type: "system", session_id: "sess-1" },
      ]);

      const process = new Process(iterator, {
        queue: new MessageQueue(),
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude",
        idleTimeoutMs: 100,
      });
      const deferredEvents: ProcessEvent[] = [];
      process.subscribe((event) => {
        if (event.type === "deferred-queue") {
          deferredEvents.push(event);
        }
      });

      process.deferMessage({ text: "first", tempId: "temp-1" });
      process.deferMessage({ text: "second", tempId: "temp-2" });

      const drained = process.drainDeferredMessages("promoted");

      expect(drained).toMatchObject([
        { text: "first", tempId: "temp-1" },
        { text: "second", tempId: "temp-2" },
      ]);
      expect(process.getDeferredQueueSummary()).toEqual([]);
      expect(deferredEvents[deferredEvents.length - 1]).toEqual({
        type: "deferred-queue",
        reason: "promoted",
        tempId: "temp-1",
      });
    });

    it("keeps steerable active-turn deferred messages editable", async () => {
      const controller = createControllableIterator();
      const queue = new MessageQueue();
      const steerFn = vi.fn(async () => true);
      const process = new Process(controller.iterator, {
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude",
        idleTimeoutMs: 100,
        queue,
        steerFn,
      });
      const deferredEvents: ProcessEvent[] = [];
      process.subscribe((event) => {
        if (event.type === "deferred-queue") {
          deferredEvents.push(event);
        }
      });

      const result = process.deferMessage(
        { text: "keep queued", tempId: "temp-queued" },
        { promoteIfReady: true },
      );

      expect(result).toMatchObject({
        success: true,
        deferred: true,
      });
      expect(steerFn).not.toHaveBeenCalled();
      expect(process.getDeferredQueueSummary()).toMatchObject([
        {
          tempId: "temp-queued",
          content: "keep queued",
        },
      ]);
      expect(deferredEvents[deferredEvents.length - 1]).toMatchObject({
        type: "deferred-queue",
        reason: "queued",
        tempId: "temp-queued",
      });

      controller.finish();
      await waitFor(() =>
        expect(process.getDeferredQueueSummary()).toEqual([]),
      );
      await process.abort();
    });

    it("emits a stitched user message when deferred turns promote after a non-steering turn", async () => {
      const controller = createControllableIterator();
      const queue = new MessageQueue();
      const process = new Process(controller.iterator, {
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude",
        idleTimeoutMs: 100,
        queue,
        // Stitched flush is the opt-in path (YEP_DEFERRED_JOIN_WINDOW_S).
        deferredDelivery: { joinWindowSeconds: 3600, composeAnchors: false },
      });
      const events: ProcessEvent[] = [];
      process.subscribe((event) => {
        events.push(event);
      });

      process.deferMessage({ text: "first queued", tempId: "temp-1" });
      process.deferMessage({ text: "second queued", tempId: "temp-2" });

      controller.push({
        type: "result",
        session_id: "sess-1",
      });

      await waitFor(() =>
        expect(process.getDeferredQueueSummary()).toEqual([]),
      );

      const userMessages = events.flatMap((event) =>
        event.type === "message" && event.message.type === "user"
          ? [event.message]
          : [],
      );
      expect(userMessages).toMatchObject([
        {
          tempId: "temp-1",
          message: {
            role: "user",
            content: `first queued\n\n${CONCAT_SEPARATOR}\n\nsecond queued`,
          },
        },
      ]);
      expect(queue.depth).toBe(1);
      const queuedProviderTurn = await queue[Symbol.asyncIterator]().next();
      expect(queuedProviderTurn.value?.message.content).toBe(
        `first queued\n\n${CONCAT_SEPARATOR}\n\nsecond queued`,
      );
      expect(process.state.type).toBe("in-turn");
      expect(events[events.length - 1]).toMatchObject({
        type: "state-change",
        state: { type: "in-turn" },
      });

      controller.finish();
      await process.abort();
    });

    it("lets regular deferred messages pass patient messages at turn end", async () => {
      const controller = createControllableIterator();
      const queue = new MessageQueue();
      const process = new Process(controller.iterator, {
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude",
        idleTimeoutMs: 100,
        queue,
      });

      process.deferMessage({
        text: "patient queued",
        tempId: "temp-patient",
        metadata: { deliveryIntent: "patient" },
      });
      process.deferMessage({
        text: "regular queued",
        tempId: "temp-regular",
        metadata: { deliveryIntent: "deferred" },
      });

      controller.push({
        type: "result",
        session_id: "sess-1",
      });

      await waitFor(() =>
        expect(process.getDeferredQueueSummary()).toMatchObject([
          {
            tempId: "temp-patient",
            content: "patient queued",
            metadata: { deliveryIntent: "patient" },
          },
        ]),
      );
      expect(queue.depth).toBe(1);
      const queuedProviderTurn = await queue[Symbol.asyncIterator]().next();
      expect(queuedProviderTurn.value?.message.content).toBe("regular queued");

      controller.finish();
      await process.abort();
    });

    it("steers a patient entry and earlier patient entries as separate steers by default", async () => {
      const controller = createControllableIterator();
      const queue = new MessageQueue();
      const process = new Process(controller.iterator, {
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude",
        idleTimeoutMs: 100,
        queue,
      });

      process.deferMessage({
        text: "when done, patient one",
        tempId: "temp-patient-1",
        metadata: { deliveryIntent: "patient" },
      });
      process.deferMessage({
        text: "regular queued",
        tempId: "temp-regular",
        metadata: { deliveryIntent: "deferred" },
      });
      process.deferMessage({
        text: "patient two",
        tempId: "temp-patient-2",
        metadata: { deliveryIntent: "patient" },
      });

      // Only patient entries accept the steer-through action.
      expect(
        process.steerPatientDeferredMessagesThrough("temp-regular"),
      ).toMatchObject({ success: false });

      expect(
        process.steerPatientDeferredMessagesThrough("temp-patient-2"),
      ).toEqual({ success: true, steered: 2 });

      // The regular deferred entry keeps its queue position.
      expect(process.getDeferredQueueSummary()).toMatchObject([
        { tempId: "temp-regular" },
      ]);

      // Each patient message steers separately, prefix stripped, steer lane.
      expect(queue.drain()).toMatchObject([
        {
          text: "patient one",
          tempId: "temp-patient-1",
          metadata: { deliveryIntent: "steer" },
        },
        {
          text: "patient two",
          tempId: "temp-patient-2",
          metadata: { deliveryIntent: "steer" },
        },
      ]);

      controller.finish();
      await process.abort();
    });

    it("steers patient entries as one combined turn when send batching is enabled", async () => {
      const controller = createControllableIterator();
      const queue = new MessageQueue();
      const process = new Process(controller.iterator, {
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude",
        idleTimeoutMs: 100,
        queue,
        deferredDelivery: { joinWindowSeconds: 3600, composeAnchors: false },
      });

      process.deferMessage({
        text: "when done, patient one",
        tempId: "temp-patient-1",
        metadata: { deliveryIntent: "patient" },
      });
      process.deferMessage({
        text: "patient two",
        tempId: "temp-patient-2",
        metadata: { deliveryIntent: "patient" },
      });

      expect(
        process.steerPatientDeferredMessagesThrough("temp-patient-2"),
      ).toEqual({ success: true, steered: 2 });

      expect(process.getDeferredQueueSummary()).toEqual([]);
      expect(queue.drain()).toMatchObject([
        {
          text: `patient one\n\n${CONCAT_SEPARATOR}\n\npatient two`,
          tempIds: ["temp-patient-1", "temp-patient-2"],
        },
      ]);

      controller.finish();
      await process.abort();
    });

    it("marks Claude queued delivery with later priority after turn end", async () => {
      const controller = createControllableIterator();
      const queue = new MessageQueue(prepareClaudeInput);
      const process = new Process(controller.iterator, {
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude",
        idleTimeoutMs: 100,
        queue,
      });

      process.deferMessage({
        text: "claude queued",
        tempId: "temp-claude-queued",
        metadata: { deliveryIntent: "deferred" },
      });

      controller.push({
        type: "result",
        session_id: "sess-1",
      });

      await waitFor(() => expect(queue.depth).toBe(1));
      const queuedProviderTurn = await queue[Symbol.asyncIterator]().next();
      expect(queuedProviderTurn.value).toMatchObject({
        priority: "later",
        message: {
          content: "claude queued",
        },
      });

      controller.finish();
      await process.abort();
    });

    it("keeps deferred messages queued at completed tool-result boundaries", async () => {
      const controller = createControllableIterator();
      const queue = new MessageQueue();
      const steerFn = vi.fn(async () => true);
      const process = new Process(controller.iterator, {
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude",
        idleTimeoutMs: 100,
        queue,
        steerFn,
      });

      process.deferMessage({
        text: "patient queued",
        tempId: "temp-patient",
        metadata: { deliveryIntent: "patient" },
      });
      process.deferMessage({
        text: "regular queued",
        tempId: "temp-regular",
        metadata: { deliveryIntent: "deferred" },
      });

      controller.push({
        type: "user",
        session_id: "sess-1",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "tool-1" }],
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(steerFn).not.toHaveBeenCalled();
      expect(queue.depth).toBe(0);
      expect(process.getDeferredQueueSummary()).toMatchObject([
        {
          tempId: "temp-patient",
          content: "patient queued",
          metadata: { deliveryIntent: "patient" },
        },
        {
          tempId: "temp-regular",
          content: "regular queued",
          metadata: { deliveryIntent: "deferred" },
        },
      ]);

      controller.finish();
      await process.abort();
    });

    it("promotes patient deferred messages only through the patient promotion path", async () => {
      const controller = createControllableIterator();
      const queue = new MessageQueue();
      const process = new Process(controller.iterator, {
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude",
        idleTimeoutMs: 100,
        queue,
      });

      const immediate = process.deferMessage(
        {
          text: "patient queued",
          tempId: "temp-patient",
          metadata: { deliveryIntent: "patient" },
        },
        { promoteIfReady: true },
      );

      expect(immediate).toMatchObject({ success: true, deferred: true });
      controller.push({
        type: "result",
        session_id: "sess-1",
      });

      await waitFor(() => expect(process.state.type).toBe("idle"));
      expect(process.getDeferredQueueSummary()).toMatchObject([
        {
          tempId: "temp-patient",
          content: "patient queued",
          metadata: { deliveryIntent: "patient" },
        },
      ]);

      expect(
        process.promoteEligiblePatientDeferredMessages({
          quietSinceMs: Date.now() - 30_000,
        }),
      ).toMatchObject({ promoted: true });
      expect(process.getDeferredQueueSummary()).toEqual([]);
      expect(process.state.type).toBe("in-turn");
      const queuedProviderTurn = await queue[Symbol.asyncIterator]().next();
      expect(queuedProviderTurn.value?.message.content).toBe("patient queued");

      controller.finish();
      await process.abort();
    });

    it("promotes patient deferred messages one per boundary, not all at once", async () => {
      const controller = createControllableIterator();
      const queue = new MessageQueue();
      const process = new Process(controller.iterator, {
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude",
        idleTimeoutMs: 100,
        queue,
      });

      process.deferMessage(
        {
          text: "first patient",
          tempId: "temp-1",
          metadata: { deliveryIntent: "patient" },
        },
        { promoteIfReady: true },
      );
      process.deferMessage(
        {
          text: "second patient",
          tempId: "temp-2",
          metadata: { deliveryIntent: "patient" },
        },
        { promoteIfReady: true },
      );

      // Move to a verified-idle boundary so the patient path can run.
      controller.push({ type: "result", session_id: "sess-1" });
      await waitFor(() => expect(process.state.type).toBe("idle"));
      expect(process.getDeferredQueueSummary()).toHaveLength(2);

      // First boundary: exactly one message is promoted, delivered verbatim
      // (no `--------` join), with the second still deferred.
      expect(
        process.promoteEligiblePatientDeferredMessages({
          quietSinceMs: Date.now() - 30_000,
        }),
      ).toMatchObject({ promoted: true });
      expect(process.state.type).toBe("in-turn");
      expect(process.getDeferredQueueSummary()).toMatchObject([
        { tempId: "temp-2", content: "second patient" },
      ]);
      const firstTurn = await queue[Symbol.asyncIterator]().next();
      expect(firstTurn.value?.message.content).toBe("first patient");

      // That turn completes -> idle again -> the second promotes on its own
      // boundary, again verbatim.
      controller.push({ type: "result", session_id: "sess-1" });
      await waitFor(() => expect(process.state.type).toBe("idle"));
      expect(
        process.promoteEligiblePatientDeferredMessages({
          quietSinceMs: Date.now() - 30_000,
        }),
      ).toMatchObject({ promoted: true });
      expect(process.getDeferredQueueSummary()).toEqual([]);
      const secondTurn = await queue[Symbol.asyncIterator]().next();
      expect(secondTurn.value?.message.content).toBe("second patient");

      controller.finish();
      await process.abort();
    });

    it("promotes one verbatim deferred turn per delivery boundary", async () => {
      const controller = createControllableIterator();
      const queue = new MessageQueue();
      const process = new Process(controller.iterator, {
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude",
        idleTimeoutMs: 100,
        queue,
      });
      const events: ProcessEvent[] = [];
      process.subscribe((event) => {
        events.push(event);
      });

      process.deferMessage({
        text: "first queued",
        tempId: "temp-1",
        metadata: {
          deliveryIntent: "deferred",
        },
      });
      process.deferMessage({
        text: "second queued",
        tempId: "temp-2",
        metadata: {
          deliveryIntent: "deferred",
        },
      });

      controller.push({
        type: "result",
        session_id: "sess-1",
      });

      // Default (vanilla) delivery: exactly one turn leaves the deferred
      // queue per completed-turn boundary, with the user's text untouched.
      await waitFor(() =>
        expect(process.getDeferredQueueSummary()).toHaveLength(1),
      );
      const firstContents = events.flatMap((event) =>
        event.type === "message" && event.message.type === "user"
          ? [event.message.message?.content as string]
          : [],
      );
      expect(firstContents).toEqual(["first queued"]);

      controller.push({
        type: "result",
        session_id: "sess-1",
      });

      await waitFor(() =>
        expect(process.getDeferredQueueSummary()).toEqual([]),
      );
      const allContents = events.flatMap((event) =>
        event.type === "message" && event.message.type === "user"
          ? [event.message.message?.content as string]
          : [],
      );
      expect(allContents).toEqual(["first queued", "second queued"]);

      controller.finish();
      await process.abort();
    });

    it("flushes deferred turns as one separator-joined turn when sends fall within the join window", async () => {
      const controller = createControllableIterator();
      const queue = new MessageQueue();
      const process = new Process(controller.iterator, {
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude",
        idleTimeoutMs: 100,
        queue,
        deferredDelivery: { joinWindowSeconds: 3600, composeAnchors: false },
      });
      const events: ProcessEvent[] = [];
      process.subscribe((event) => {
        events.push(event);
      });

      process.deferMessage({
        text: "first queued",
        tempId: "temp-1",
        metadata: {
          deliveryIntent: "deferred",
        },
      });
      process.deferMessage({
        text: "second queued",
        tempId: "temp-2",
        metadata: {
          deliveryIntent: "deferred",
        },
      });

      controller.push({
        type: "result",
        session_id: "sess-1",
      });

      await waitFor(() =>
        expect(process.getDeferredQueueSummary()).toEqual([]),
      );

      const userContents = events.flatMap((event) =>
        event.type === "message" && event.message.type === "user"
          ? [event.message.message?.content as string]
          : [],
      );
      expect(userContents).toHaveLength(1);
      expect(userContents[0]).toBe(
        `first queued\n\n${CONCAT_SEPARATOR}\n\nsecond queued`,
      );

      const queuedProviderTurn = await queue[Symbol.asyncIterator]().next();
      expect(queuedProviderTurn.value?.message.content).toBe(userContents[0]);

      controller.finish();
      await process.abort();
    });

    it("splits queued turns at compose-time gaps wider than the join window", async () => {
      const controller = createControllableIterator();
      const queue = new MessageQueue();
      const process = new Process(controller.iterator, {
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude",
        idleTimeoutMs: 100,
        queue,
        deferredDelivery: { joinWindowSeconds: 60, composeAnchors: false },
      });
      const events: ProcessEvent[] = [];
      process.subscribe((event) => {
        events.push(event);
      });

      // Sliding window: each send within 60s of the previous send extends
      // the group. first→second gap is 30s (joins); second→third is 68s
      // (splits), so the third delivers at the next boundary on its own.
      const now = Date.now();
      process.deferMessage({
        text: "first queued",
        tempId: "temp-1",
        metadata: {
          deliveryIntent: "deferred",
          serverReceivedAt: new Date(now - 100_000).toISOString(),
        },
      });
      process.deferMessage({
        text: "second queued",
        tempId: "temp-2",
        metadata: {
          deliveryIntent: "deferred",
          serverReceivedAt: new Date(now - 70_000).toISOString(),
        },
      });
      process.deferMessage({
        text: "third queued",
        tempId: "temp-3",
        metadata: {
          deliveryIntent: "deferred",
          serverReceivedAt: new Date(now - 2_000).toISOString(),
        },
      });

      controller.push({
        type: "result",
        session_id: "sess-1",
      });

      await waitFor(() =>
        expect(process.getDeferredQueueSummary()).toHaveLength(1),
      );
      const firstContents = events.flatMap((event) =>
        event.type === "message" && event.message.type === "user"
          ? [event.message.message?.content as string]
          : [],
      );
      expect(firstContents).toEqual([
        `first queued\n\n${CONCAT_SEPARATOR}\n\nsecond queued`,
      ]);

      controller.push({
        type: "result",
        session_id: "sess-1",
      });

      await waitFor(() =>
        expect(process.getDeferredQueueSummary()).toEqual([]),
      );
      const allContents = events.flatMap((event) =>
        event.type === "message" && event.message.type === "user"
          ? [event.message.message?.content as string]
          : [],
      );
      expect(allContents[allContents.length - 1]).toBe("third queued");

      controller.finish();
      await process.abort();
    });

    it("prefixes promoted deferred turns with compose-time anchors when opted in", async () => {
      const controller = createControllableIterator();
      const queue = new MessageQueue();
      const process = new Process(controller.iterator, {
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude",
        idleTimeoutMs: 100,
        queue,
        deferredDelivery: { joinWindowSeconds: 3600, composeAnchors: true },
      });
      const events: ProcessEvent[] = [];
      process.subscribe((event) => {
        events.push(event);
      });

      // Anchor on metadata.serverReceivedAt so age is computed against real
      // now() at promotion without fake timers: first composed 45s ago, second
      // 15s ago (a 30s gap between the two).
      const now = Date.now();
      process.deferMessage({
        text: "first queued",
        tempId: "temp-1",
        metadata: {
          deliveryIntent: "deferred",
          serverReceivedAt: new Date(now - 45_000).toISOString(),
        },
      });
      process.deferMessage({
        text: "second queued",
        tempId: "temp-2",
        metadata: {
          deliveryIntent: "deferred",
          serverReceivedAt: new Date(now - 15_000).toISOString(),
        },
      });

      controller.push({
        type: "result",
        session_id: "sess-1",
      });

      await waitFor(() =>
        expect(process.getDeferredQueueSummary()).toEqual([]),
      );

      const userContents = events.flatMap((event) =>
        event.type === "message" && event.message.type === "user"
          ? [event.message.message?.content as string]
          : [],
      );
      // First chunk anchors against delivery time (~45s ago); second against
      // the first chunk's compose time (exactly 30s later). The live echo is
      // the same stitched turn that the provider receives.
      expect(userContents).toHaveLength(1);
      expect(userContents[0]).toMatch(
        new RegExp(
          `^\\(\\d+s ago\\)\\n\\nfirst queued\\n\\n${CONCAT_SEPARATOR}\\n\\n\\(30s later\\)\\n\\nsecond queued$`,
        ),
      );

      const queuedProviderTurn = await queue[Symbol.asyncIterator]().next();
      expect(queuedProviderTurn.value?.message.content).toBe(userContents[0]);

      controller.finish();
      await process.abort();
    });

    it("quotes the last-seen assistant text in the first compose anchor", async () => {
      const controller = createControllableIterator();
      const queue = new MessageQueue();
      const process = new Process(controller.iterator, {
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude",
        idleTimeoutMs: 100,
        queue,
        deferredDelivery: { joinWindowSeconds: 3600, composeAnchors: true },
      });
      const events: ProcessEvent[] = [];
      process.subscribe((event) => {
        events.push(event);
      });

      // The composer was watching this stream mid-turn when they queued.
      process.accumulateStreamingText("m1", "Working on the fix now");
      process.deferMessage({
        text: "queued reply",
        tempId: "temp-1",
        metadata: {
          deliveryIntent: "deferred",
          serverReceivedAt: new Date(Date.now() - 45_000).toISOString(),
        },
      });

      controller.push({
        type: "result",
        session_id: "sess-1",
      });

      await waitFor(() =>
        expect(process.getDeferredQueueSummary()).toEqual([]),
      );

      const userContents = events.flatMap((event) =>
        event.type === "message" && event.message.type === "user"
          ? [event.message.message?.content as string]
          : [],
      );
      expect(userContents).toHaveLength(1);
      expect(userContents[0]).toMatch(
        /^\(\d+s ago, had seen: "Working on the fix now"\)\n\nqueued reply$/,
      );

      controller.finish();
      await process.abort();
    });

    it("replaces elapsed anchors with needle-only form when stamps are on", async () => {
      const controller = createControllableIterator();
      const queue = new MessageQueue();
      const process = new Process(controller.iterator, {
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude",
        idleTimeoutMs: 100,
        queue,
        deferredDelivery: {
          joinWindowSeconds: 3600,
          composeAnchors: true,
          turnTimestamps: "before",
        },
      });
      const events: ProcessEvent[] = [];
      process.subscribe((event) => {
        events.push(event);
      });

      process.accumulateStreamingText("m1", "Working on the fix now");
      const composedAt = new Date(Date.now() - 45_000).toISOString();
      process.deferMessage({
        text: "queued reply",
        tempId: "temp-1",
        metadata: {
          deliveryIntent: "deferred",
          serverReceivedAt: composedAt,
        },
      });

      controller.push({
        type: "result",
        session_id: "sess-1",
      });

      await waitFor(() =>
        expect(process.getDeferredQueueSummary()).toEqual([]),
      );

      const userContents = events.flatMap((event) =>
        event.type === "message" && event.message.type === "user"
          ? [event.message.message?.content as string]
          : [],
      );
      expect(userContents).toHaveLength(1);
      // Every chunk carries its own [sent …], so relative "(Ns ago" is
      // redundant; only the content needle remains, outermost.
      expect(userContents[0]).toBe(
        `(had seen: "Working on the fix now")\n\n[sent ${composedAt}]\n\nqueued reply`,
      );

      controller.finish();
      await process.abort();
    });

    it("stamps provider-bound turns with [sent …] when opted in", async () => {
      const controller = createControllableIterator();
      const queue = new MessageQueue();
      const process = new Process(controller.iterator, {
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude",
        idleTimeoutMs: 100,
        queue,
        deferredDelivery: {
          joinWindowSeconds: 3600,
          composeAnchors: false,
          turnTimestamps: "before",
        },
      });
      const events: ProcessEvent[] = [];
      process.subscribe((event) => {
        events.push(event);
      });

      const composedAt = new Date(Date.now() - 45_000).toISOString();
      process.deferMessage({
        text: "stamped queued",
        tempId: "temp-1",
        metadata: {
          deliveryIntent: "deferred",
          serverReceivedAt: composedAt,
        },
      });

      controller.push({
        type: "result",
        session_id: "sess-1",
      });

      await waitFor(() =>
        expect(process.getDeferredQueueSummary()).toEqual([]),
      );

      const userContents = events.flatMap((event) =>
        event.type === "message" && event.message.type === "user"
          ? [event.message.message?.content as string]
          : [],
      );
      expect(userContents).toHaveLength(1);
      // "before" placement leads the text with the absolute compose time in
      // the same ISO format as provider session jsonl.
      expect(userContents[0]).toBe(`[sent ${composedAt}]\n\nstamped queued`);

      controller.finish();
      await process.abort();
    });

    it("appends [sent …] with after placement", async () => {
      const controller = createControllableIterator();
      const queue = new MessageQueue();
      const process = new Process(controller.iterator, {
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude",
        idleTimeoutMs: 100,
        queue,
        deferredDelivery: {
          joinWindowSeconds: 3600,
          composeAnchors: false,
          turnTimestamps: "after",
        },
      });
      const events: ProcessEvent[] = [];
      process.subscribe((event) => {
        events.push(event);
      });

      const composedAt = new Date(Date.now() - 45_000).toISOString();
      process.deferMessage({
        text: "stamped queued",
        tempId: "temp-1",
        metadata: {
          deliveryIntent: "deferred",
          serverReceivedAt: composedAt,
        },
      });

      controller.push({
        type: "result",
        session_id: "sess-1",
      });

      await waitFor(() =>
        expect(process.getDeferredQueueSummary()).toEqual([]),
      );

      const userContents = events.flatMap((event) =>
        event.type === "message" && event.message.type === "user"
          ? [event.message.message?.content as string]
          : [],
      );
      expect(userContents).toHaveLength(1);
      expect(userContents[0]).toBe(`stamped queued\n\n[sent ${composedAt}]`);

      controller.finish();
      await process.abort();
    });

    it("promotes deferred messages after turn completion, not completed tool results", async () => {
      const controller = createControllableIterator();
      const queue = new MessageQueue();
      const steerFn = vi.fn(async () => true);
      const process = new Process(controller.iterator, {
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude",
        idleTimeoutMs: 100,
        queue,
        steerFn,
      });
      const deferredEvents: ProcessEvent[] = [];
      process.subscribe((event) => {
        if (event.type === "deferred-queue") {
          deferredEvents.push(event);
        }
      });

      process.deferMessage(
        { text: "send after bash", tempId: "temp-tool-boundary" },
        { promoteIfReady: true },
      );

      controller.push({
        type: "user",
        session_id: "sess-1",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-1",
              content: "done",
            },
          ],
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(steerFn).not.toHaveBeenCalled();
      expect(queue.depth).toBe(0);
      expect(process.getDeferredQueueSummary()).toMatchObject([
        {
          tempId: "temp-tool-boundary",
          content: "send after bash",
        },
      ]);

      controller.push({
        type: "result",
        session_id: "sess-1",
      });

      await waitFor(() => expect(queue.depth).toBe(1));
      const queuedProviderTurn = await queue[Symbol.asyncIterator]().next();
      expect(queuedProviderTurn.value?.message).toMatchObject({
        content: "send after bash",
      });
      expect(process.getDeferredQueueSummary()).toEqual([]);
      expect(deferredEvents[deferredEvents.length - 1]).toMatchObject({
        type: "deferred-queue",
        reason: "promoted",
      });
      expect(deferredEvents[deferredEvents.length - 1]).not.toHaveProperty(
        "messages",
      );

      controller.finish();
      await process.abort();
    });

    it("promotes deferred messages immediately when the process is already idle", async () => {
      const iterator = createMockIterator([
        { type: "system", subtype: "init", session_id: "sess-1" },
        { type: "result", session_id: "sess-1" },
      ]);
      const queue = new MessageQueue();
      const process = new Process(iterator, {
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude",
        idleTimeoutMs: 100,
        queue,
      });

      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(process.state.type).toBe("idle");

      const result = process.deferMessage(
        { text: "idle race", tempId: "temp-idle" },
        { promoteIfReady: true },
      );

      expect(result).toMatchObject({
        success: true,
        deferred: false,
        promoted: true,
        position: 1,
      });
      expect(process.getDeferredQueueSummary()).toEqual([]);
      expect(process.queueDepth).toBe(1);
    });
  });
});
