// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  collector: {
    start: vi.fn(() => Promise.resolve()),
    stop: vi.fn(),
  },
  developerModeListeners: new Set<() => void>(),
  getRemoteLogCollectionEnabled: vi.fn(() => false),
  setRemoteLogCollectionEnabledValue: vi.fn(),
}));

vi.mock("../../../hooks/useDeveloperMode", () => ({
  getRemoteLogCollectionEnabled: mocks.getRemoteLogCollectionEnabled,
  setRemoteLogCollectionEnabledValue: mocks.setRemoteLogCollectionEnabledValue,
  subscribeDeveloperMode: vi.fn((listener: () => void) => {
    mocks.developerModeListeners.add(listener);
    return () => mocks.developerModeListeners.delete(listener);
  }),
}));

vi.mock("../ClientLogCollector", () => ({
  // A function implementation, not an arrow: the module constructs it with new.
  // biome-ignore lint/complexity/useArrowFunction: this mock is called with new.
  ClientLogCollector: vi.fn(function () {
    return mocks.collector;
  }),
}));

async function flushPromises() {
  await Promise.resolve();
  await Promise.resolve();
}

describe("initClientLogCollection", () => {
  let cleanup: (() => void) | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetModules();
    sessionStorage.clear();
    cleanup = null;
    mocks.collector.start.mockClear();
    mocks.collector.stop.mockClear();
    mocks.developerModeListeners.clear();
    mocks.getRemoteLogCollectionEnabled.mockReturnValue(false);
    mocks.setRemoteLogCollectionEnabledValue.mockClear();
  });

  afterEach(() => {
    cleanup?.();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("starts collection when the browser developer setting requests it", async () => {
    mocks.getRemoteLogCollectionEnabled.mockReturnValue(true);

    const diagnostics = await import("../index");
    cleanup = diagnostics.initClientLogCollection();

    expect(mocks.collector.start).toHaveBeenCalledTimes(1);
  });

  it("does not start collection without local browser opt-in", async () => {
    const diagnostics = await import("../index");
    cleanup = diagnostics.initClientLogCollection();
    await flushPromises();

    expect(mocks.collector.start).not.toHaveBeenCalled();
  });

  it("lets the user stop collection from the badge", async () => {
    mocks.getRemoteLogCollectionEnabled.mockReturnValue(true);

    const diagnostics = await import("../index");
    cleanup = diagnostics.initClientLogCollection();

    expect(mocks.collector.start).toHaveBeenCalledTimes(1);

    diagnostics.disableClientLogCollection();

    expect(mocks.setRemoteLogCollectionEnabledValue).toHaveBeenCalledWith(
      false,
    );
  });
});
