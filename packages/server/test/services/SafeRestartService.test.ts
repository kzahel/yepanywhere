import type { SafeRestartState } from "@yep-anywhere/shared";
import { describe, expect, it, vi } from "vitest";
import { SafeRestartService } from "../../src/services/SafeRestartService.js";
import { EventBus } from "../../src/watcher/EventBus.js";

describe("SafeRestartService", () => {
  it("waits for active sessions and queued messages before restarting", async () => {
    const eventBus = new EventBus();
    let activity = {
      activeWorkers: 2,
      interruptibleSessionCount: 2,
      queueLength: 1,
      hasActiveWork: true,
    };
    const restart = vi.fn();
    const pauseProjectQueueDispatch = vi.fn(async () => true);
    const states: string[] = [];

    eventBus.subscribe((event) => {
      if (event.type === "safe-restart-changed") {
        states.push(event.state.status);
      }
    });

    const service = new SafeRestartService({
      eventBus,
      getWorkerActivity: () => activity,
      restart,
      pauseProjectQueueDispatch,
    });

    const scheduled = await service.schedule();

    expect(pauseProjectQueueDispatch).toHaveBeenCalledTimes(1);
    expect(scheduled.status).toBe("scheduled");
    expect(scheduled.blockers).toEqual([
      { type: "active-sessions", count: 2 },
      { type: "session-queue", count: 1 },
    ]);
    expect(restart).not.toHaveBeenCalled();

    activity = {
      activeWorkers: 0,
      interruptibleSessionCount: 0,
      queueLength: 0,
      hasActiveWork: false,
    };
    eventBus.emit({
      type: "worker-activity-changed",
      ...activity,
      timestamp: new Date().toISOString(),
    });
    await Promise.resolve();

    expect(restart).toHaveBeenCalledTimes(1);
    expect(service.getState().status).toBe("restarting");
    expect(states).toContain("scheduled");
    expect(states).toContain("restarting");
  });

  it("restarts immediately when there are no drain blockers", async () => {
    const eventBus = new EventBus();
    const restart = vi.fn();
    const service = new SafeRestartService({
      eventBus,
      getWorkerActivity: () => ({
        activeWorkers: 0,
        interruptibleSessionCount: 0,
        queueLength: 0,
        hasActiveWork: false,
      }),
      restart,
      pauseProjectQueueDispatch: async () => false,
    });

    const state = await service.schedule();

    expect(state.status).toBe("restarting");
    expect(state.blockers).toEqual([]);
    expect(restart).toHaveBeenCalledTimes(1);
  });

  it("backs out when work enters during the handoff and retries after it settles", async () => {
    const eventBus = new EventBus();
    const ready = Promise.withResolvers<void>();
    const handoff = Promise.withResolvers<void>();
    const committed = Promise.withResolvers<void>();
    let activeWorkers = 0;
    const activity = () => ({
      activeWorkers,
      interruptibleSessionCount: activeWorkers,
      queueLength: 0,
      hasActiveWork: activeWorkers > 0,
    });
    const report = () =>
      eventBus.emit({
        type: "worker-activity-changed",
        ...activity(),
        timestamp: new Date().toISOString(),
      });
    const restart = vi.fn(async (canCommit: () => boolean) => {
      ready.resolve();
      await handoff.promise;
      const safe = canCommit();
      if (safe) committed.resolve();
      return safe;
    });
    const service = new SafeRestartService({
      eventBus,
      getWorkerActivity: activity,
      restart,
    });

    const initial = service.schedule();
    await ready.promise;
    activeWorkers = 1;
    report();
    handoff.resolve();
    expect(await initial).toMatchObject({
      status: "scheduled",
      blockers: [{ type: "active-sessions", count: 1 }],
    });
    expect(restart).toHaveBeenCalledTimes(1);

    activeWorkers = 0;
    report();
    await committed.promise;
    expect(service.getState().status).toBe("restarting");
    expect(restart).toHaveBeenCalledTimes(2);
    service.dispose();
  });

  it("retries a declined handoff without a worker event and stops on cancellation", async () => {
    vi.useFakeTimers();
    const restart = vi.fn(async () => false);
    const service = new SafeRestartService({
      eventBus: new EventBus(),
      getWorkerActivity: () => ({
        activeWorkers: 0,
        queueLength: 0,
        hasActiveWork: false,
      }),
      restart,
    });
    try {
      expect((await service.schedule()).status).toBe("scheduled");
      await vi.advanceTimersByTimeAsync(999);
      expect(restart).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(restart).toHaveBeenCalledTimes(2);
      expect((await service.cancel()).status).toBe("idle");
      await vi.advanceTimersByTimeAsync(60_000);
      expect(restart).toHaveBeenCalledTimes(2);
    } finally {
      service.dispose();
      vi.useRealTimers();
    }
  });

  it("reports preserved recovered queue entries without blocking restart", async () => {
    const eventBus = new EventBus();
    const restart = vi.fn();
    const service = new SafeRestartService({
      eventBus,
      getWorkerActivity: () => ({
        activeWorkers: 0,
        interruptibleSessionCount: 0,
        queueLength: 0,
        hasActiveWork: false,
      }),
      getPreservedWork: () => [{ type: "recovered-session-queue", count: 2 }],
      restart,
    });

    const state = await service.schedule();

    expect(state.status).toBe("restarting");
    expect(state.blockers).toEqual([]);
    expect(state.preserved).toEqual([
      { type: "recovered-session-queue", count: 2 },
    ]);
    expect(state.canRestartNow).toBe(true);
    expect(restart).toHaveBeenCalledTimes(1);
  });

  it("prepares preserved work before evaluating queued blockers", async () => {
    const eventBus = new EventBus();
    const restart = vi.fn();
    let queuedSessionMessageCount = 2;
    let preservedCount = 0;
    const preparePreservedWork = vi.fn(async () => {
      queuedSessionMessageCount = 0;
      preservedCount = 2;
    });
    const service = new SafeRestartService({
      eventBus,
      getWorkerActivity: () => ({
        activeWorkers: 1,
        interruptibleSessionCount: 0,
        queueLength: 0,
        queuedSessionMessageCount,
        hasActiveWork: false,
      }),
      getPreservedWork: () =>
        preservedCount > 0
          ? [{ type: "recovered-session-queue", count: preservedCount }]
          : [],
      preparePreservedWork,
      restart,
    });

    const state = await service.schedule();

    expect(preparePreservedWork).toHaveBeenCalledTimes(1);
    expect(state.status).toBe("restarting");
    expect(state.blockers).toEqual([]);
    expect(state.preserved).toEqual([
      { type: "recovered-session-queue", count: 2 },
    ]);
    expect(restart).toHaveBeenCalledTimes(1);
  });

  it("updates scheduled state when preserved queue count changes", async () => {
    const eventBus = new EventBus();
    let preservedCount = 1;
    const states: SafeRestartState[] = [];

    eventBus.subscribe((event) => {
      if (event.type === "safe-restart-changed") {
        states.push(event.state);
      }
    });

    const service = new SafeRestartService({
      eventBus,
      getWorkerActivity: () => ({
        activeWorkers: 1,
        interruptibleSessionCount: 1,
        queueLength: 0,
        hasActiveWork: true,
      }),
      getPreservedWork: () => [
        { type: "recovered-session-queue", count: preservedCount },
      ],
      restart: vi.fn(),
    });

    await service.schedule();
    preservedCount = 3;
    eventBus.emit({
      type: "session-queue-persistence-changed",
      timestamp: new Date().toISOString(),
    });
    await Promise.resolve();

    expect(states.at(-1)?.preserved).toEqual([
      { type: "recovered-session-queue", count: 3 },
    ]);
  });

  it("counts per-session queued messages separately from worker queue length", async () => {
    const eventBus = new EventBus();
    const restart = vi.fn();
    const service = new SafeRestartService({
      eventBus,
      getWorkerActivity: () => ({
        activeWorkers: 1,
        interruptibleSessionCount: 0,
        queueLength: 0,
        queuedSessionMessageCount: 3,
        hasActiveWork: false,
      }),
      restart,
    });

    const state = await service.schedule();

    expect(state.status).toBe("scheduled");
    expect(state.blockers).toEqual([{ type: "session-queue", count: 3 }]);
    expect(restart).not.toHaveBeenCalled();
  });

  it("resumes only Project Queue dispatch that it paused", async () => {
    const eventBus = new EventBus();
    const resumeProjectQueueDispatch = vi.fn();
    const service = new SafeRestartService({
      eventBus,
      getWorkerActivity: () => ({
        activeWorkers: 1,
        interruptibleSessionCount: 1,
        queueLength: 0,
        hasActiveWork: true,
      }),
      restart: vi.fn(),
      pauseProjectQueueDispatch: async () => true,
      resumeProjectQueueDispatch,
    });

    await service.schedule();
    const cancelled = await service.cancel();

    expect(cancelled.status).toBe("idle");
    expect(resumeProjectQueueDispatch).toHaveBeenCalledTimes(1);
  });
});
