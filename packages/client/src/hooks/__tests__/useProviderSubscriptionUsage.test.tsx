// @vitest-environment jsdom

import { RoutedSessionContext } from "../../contexts/RoutedSessionContext";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  acquireClientQueryBootstrapSlot,
  resetClientQueryBootstrapForTests,
} from "../../lib/clientQueryBootstrap";
import type { ClientSummarySourceKey } from "../../lib/clientSummaryStore";
import { useProviderSubscriptionUsage } from "../useProviderSubscriptionUsage";

const { mockGetUsage, mockOverview, mockRefresh, state } = vi.hoisted(() => ({
  mockGetUsage: vi.fn(),
  mockOverview: vi.fn(),
  mockRefresh: vi.fn(),
  state: {
    capabilities: [] as string[],
    sourceKey: "usage-source-1",
  },
}));

vi.mock("../../api/client", () => ({
  api: {
    getProviderSubscriptionUsage: mockGetUsage,
    routerOverview: mockOverview,
    routerRefreshOverview: mockRefresh,
  },
}));

vi.mock("../useVersion", () => ({
  useVersion: () => ({
    version: { capabilities: state.capabilities },
  }),
}));

vi.mock("../../lib/clientSummaryStore", () => ({
  useClientSummarySourceKey: () => state.sourceKey,
}));

describe("useProviderSubscriptionUsage", () => {
  beforeEach(() => {
    resetClientQueryBootstrapForTests();
    state.capabilities = [];
    state.sourceKey = `usage-source-${Math.random()}`;
    mockGetUsage.mockReset();
    mockGetUsage.mockResolvedValue({ usage: null });
  });

  it("never reads or refreshes the direct account from a routed session", async () => {
    state.capabilities = ["provider-subscription-usage"];
    const { result } = renderHook(() => useProviderSubscriptionUsage("codex"), {
      wrapper: ({ children }) => (
        <RoutedSessionContext value={{ accountId: "pinned" }}>
          {children}
        </RoutedSessionContext>
      ),
    });
    await act(async () => {
      await result.current.refresh();
    });
    expect(mockGetUsage).not.toHaveBeenCalled();
    expect(result.current.usage).toBeNull();
  });

  it("makes no request until the server advertises the capability", async () => {
    const { result } = renderHook(() => useProviderSubscriptionUsage("claude"));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(mockGetUsage).not.toHaveBeenCalled();
  });

  it("reads the pinned router account, preserves allowance units and refreshes only that account", async () => {
    state.capabilities = ["agent-auth-router-pools"];
    const account = (id: string, remaining: number) => ({
      id,
      provider: "codex",
      displayName: id,
      quota: { observedAt: "2026-11-05T00:00:00Z", ordinaryUsageAllowed: true },
      windows: [
        {
          bucket: "codex:primary",
          usedPercent: 50,
          remainingPercent: 50,
          remainingCapacityUnits: remaining,
          windowMinutes: 10080,
          scope: "all",
        },
      ],
      models: [],
    });
    mockOverview.mockResolvedValue({
      accounts: [account("other", 0.5), account("pinned", 0.25)],
    });
    mockRefresh.mockResolvedValue({ accounts: [account("pinned", 0.2)] });
    const { result } = renderHook(() => useProviderSubscriptionUsage("codex"), {
      wrapper: ({ children }) => (
        <RoutedSessionContext value={{ accountId: "pinned" }}>
          {children}
        </RoutedSessionContext>
      ),
    });
    await waitFor(() =>
      expect(result.current.usage?.windows[0]?.remainingCapacityUnits).toBe(
        0.25,
      ),
    );
    await act(async () => {
      await result.current.refresh();
    });
    expect(mockRefresh).toHaveBeenCalledWith({ accountId: "pinned" });
    expect(result.current.usage?.windows[0]?.remainingCapacityUnits).toBe(0.2);
    expect(mockGetUsage).not.toHaveBeenCalled();
  });

  it("defers supplementary acquisition but never delays explicit refresh", async () => {
    state.capabilities = ["provider-subscription-usage"];
    const routeSlot = acquireClientQueryBootstrapSlot(
      state.sourceKey as ClientSummarySourceKey,
      "route",
    );
    const { result } = renderHook(() =>
      useProviderSubscriptionUsage("claude", {
        bootstrapTier: "supplementary",
      }),
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(mockGetUsage).not.toHaveBeenCalled();

    await act(async () => {
      await result.current.refresh();
    });
    expect(mockGetUsage).toHaveBeenCalledTimes(1);
    expect(mockGetUsage).toHaveBeenCalledWith("claude", { refresh: true });

    routeSlot.settle();
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(mockGetUsage).toHaveBeenCalledTimes(1);
  });

  it("loads and explicitly refreshes source-keyed usage", async () => {
    state.capabilities = ["provider-subscription-usage"];
    mockGetUsage.mockResolvedValue({
      usage: {
        provider: "claude",
        fetchedAt: "2026-07-29T00:00:00.000Z",
        windows: [
          {
            id: "weekly",
            usedPercent: 72,
            scope: { type: "provider" },
          },
        ],
      },
    });

    const { result } = renderHook(() => useProviderSubscriptionUsage("claude"));
    await waitFor(() =>
      expect(result.current.usage?.windows[0]?.usedPercent).toBe(72),
    );
    expect(mockGetUsage).toHaveBeenCalledWith("claude", { refresh: false });

    await act(async () => {
      await result.current.refresh();
    });
    expect(mockGetUsage).toHaveBeenLastCalledWith("claude", {
      refresh: true,
    });
  });
});
