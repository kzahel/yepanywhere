import { describe, expect, it, vi } from "vitest";
import { EventBus } from "../../src/watcher/EventBus.js";
import { ProviderSessionWatcherRegistry } from "../../src/watcher/ProviderSessionWatcherRegistry.js";

describe("ProviderSessionWatcherRegistry", () => {
  it("reports observation readiness without activation or storage probes", () => {
    const directoryExists = vi.fn(() => true);
    let baselineState = "scheduled" as "scheduled" | "complete" | "failed";
    let watching = true;
    let error: string | null = null;
    let onBaseline: (() => void) | undefined;
    const registry = new ProviderSessionWatcherRegistry({
      eventBus: new EventBus(),
      specs: [{ family: "claude", provider: "claude", watchDir: "/claude" }],
      directoryExists,
      createWatcher: (options) => {
        onBaseline = options.onInitialBaseline;
        return {
          start: vi.fn(),
          stop: vi.fn(),
          getObservationDiagnostics: () => ({ watching, baselineState, error }),
          getObservationEpoch: () =>
            watching && baselineState === "complete" ? 1 : null,
        };
      },
    });
    expect(registry.getDiagnostics().families).toEqual([
      {
        family: "claude",
        pending: false,
        watching: false,
        baselineState: "idle",
        error: null,
      },
    ]);
    expect(directoryExists).not.toHaveBeenCalled();
    const source = registry.sourceObservationCallbacks();
    expect(source.getProviderObservationEpoch!("claude", "/claude")).toBeNull();
    registry.activate(["claude"]);
    expect(registry.getDiagnostics().families[0]).toMatchObject({
      watching: true,
      baselineState: "scheduled",
    });
    baselineState = "complete";
    onBaseline!();
    expect(source.getProviderObservationEpoch!("claude", "/claude")).toBe(1);
    expect(
      source.getProviderObservationEpoch!("claude", "/other-root"),
    ).toBeNull();
    const ready = vi.fn();
    const release = registry.subscribeReady(ready);
    expect(ready).toHaveBeenCalledExactlyOnceWith("claude");
    expect(registry.getDiagnostics().families[0]).toMatchObject({
      watching: true,
      baselineState: "complete",
    });
    watching = false;
    error = "Observation failed";
    expect(registry.getDiagnostics().families[0]).toMatchObject({
      watching: false,
      error,
    });
    expect(source.getProviderObservationEpoch!("claude", "/claude")).toBeNull();
    baselineState = "failed";
    expect(registry.getDiagnostics().families[0]?.baselineState).toBe("failed");
    expect(directoryExists).toHaveBeenCalledTimes(1);
    registry.stop();
    onBaseline!();
    expect(ready).toHaveBeenCalledTimes(1);
    release();
  });
  it("does not probe storage for ineligible families", () => {
    const directoryExists = vi.fn(() => true);
    const createWatcher = vi.fn(() => ({
      start: vi.fn(),
      stop: vi.fn(),
    }));
    const registry = new ProviderSessionWatcherRegistry({
      eventBus: new EventBus(),
      specs: [
        { family: "claude", provider: "claude", watchDir: "/claude" },
        { family: "codex", provider: "codex", watchDir: "/codex" },
      ],
      directoryExists,
      createWatcher,
    });

    registry.activate([]);

    expect(directoryExists).not.toHaveBeenCalled();
    expect(createWatcher).not.toHaveBeenCalled();
    expect(registry.getMetrics()).toEqual({
      activationQueueRequests: 0,
      activationRequests: 0,
      directoryProbes: 0,
      watchersStarted: 0,
      missingDirectories: 0,
      activeWatchers: 0,
      pendingActivations: 0,
    });
  });

  it("queues and staggers activation outside the requesting action", async () => {
    vi.useFakeTimers();
    const starts: string[] = [];
    const registry = new ProviderSessionWatcherRegistry({
      eventBus: new EventBus(),
      specs: [
        { family: "claude", provider: "claude", watchDir: "/claude" },
        { family: "codex", provider: "codex", watchDir: "/codex" },
      ],
      activationDelayMs: 1_000,
      activationYieldMs: 100,
      directoryExists: () => true,
      createWatcher: (options) => ({
        start: () => starts.push(options.provider),
        stop: vi.fn(),
      }),
    });

    try {
      registry.requestActivation(["claude", "codex"]);
      expect(starts).toEqual([]);
      expect(registry.getMetrics()).toMatchObject({
        activationQueueRequests: 1,
        activationRequests: 0,
        pendingActivations: 2,
      });

      await vi.advanceTimersByTimeAsync(1_000);
      expect(starts).toEqual(["claude"]);
      await vi.advanceTimersByTimeAsync(100);
      expect(starts).toEqual(["claude", "codex"]);
      expect(registry.getMetrics()).toMatchObject({
        activationRequests: 2,
        watchersStarted: 2,
        pendingActivations: 0,
      });
    } finally {
      registry.stop();
      vi.useRealTimers();
    }
  });

  it("starts and stops at most one watcher per eligible family", () => {
    const watcher = { start: vi.fn(), stop: vi.fn() };
    const directoryExists = vi.fn(() => true);
    const createWatcher = vi.fn(() => watcher);
    const registry = new ProviderSessionWatcherRegistry({
      eventBus: new EventBus(),
      specs: [
        {
          family: "codex",
          provider: "codex",
          watchDir: "/codex",
          periodicRescanMs: 30_000,
        },
      ],
      directoryExists,
      createWatcher,
    });

    registry.activate(["codex", "codex"]);
    registry.activateFamily("codex");

    expect(directoryExists).toHaveBeenCalledTimes(1);
    expect(createWatcher).toHaveBeenCalledWith({
      provider: "codex",
      watchDir: "/codex",
      periodicRescanMs: 30_000,
      onInitialBaseline: expect.any(Function),
      eventBus: expect.any(EventBus),
    });
    expect(watcher.start).toHaveBeenCalledTimes(1);
    expect(registry.getMetrics()).toMatchObject({
      activationRequests: 2,
      directoryProbes: 1,
      watchersStarted: 1,
      activeWatchers: 1,
    });

    registry.stop();
    expect(watcher.stop).toHaveBeenCalledTimes(1);
    expect(registry.getMetrics().activeWatchers).toBe(0);
  });

  it("does not probe families without a native file watcher", () => {
    const directoryExists = vi.fn(() => true);
    const registry = new ProviderSessionWatcherRegistry({
      eventBus: new EventBus(),
      specs: [],
      directoryExists,
    });

    registry.activate(["grok", "opencode"]);

    expect(directoryExists).not.toHaveBeenCalled();
    expect(registry.getMetrics()).toMatchObject({
      activationRequests: 2,
      directoryProbes: 0,
      watchersStarted: 0,
    });
  });
});
