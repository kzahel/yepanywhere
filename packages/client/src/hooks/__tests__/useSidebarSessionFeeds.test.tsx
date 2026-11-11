import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { SIDEBAR_SESSION_CATEGORIES_CAPABILITY } from "@yep-anywhere/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadMore: vi.fn(),
  useGlobalSessionsFeed: vi.fn(),
  version: undefined as { capabilities?: string[] } | undefined,
}));

vi.mock("../useGlobalSessionsFeed", () => ({
  useGlobalSessionsFeed: mocks.useGlobalSessionsFeed,
}));

vi.mock("../useVersion", () => ({
  useVersion: () => ({ version: mocks.version }),
}));

import {
  SIDEBAR_SESSION_FEED_LIMIT,
  SidebarSessionFeedsProvider,
  useSidebarSessionFeeds,
} from "../useSidebarSessionFeeds";

function withProvider({ children }: { children: ReactNode }) {
  return <SidebarSessionFeedsProvider>{children}</SidebarSessionFeedsProvider>;
}

beforeEach(() => {
  mocks.version = undefined;
  mocks.loadMore.mockReset();
  mocks.useGlobalSessionsFeed.mockReset();
  mocks.useGlobalSessionsFeed.mockReturnValue({
    query: { scope: "global-sessions" },
    loading: false,
    hasMore: false,
    loadMore: mocks.loadMore,
  });
});

describe("SidebarSessionFeedsProvider", () => {
  it("retains global and starred sidebar coverage", () => {
    renderHook(() => useSidebarSessionFeeds(), { wrapper: withProvider });

    expect(mocks.useGlobalSessionsFeed).toHaveBeenCalledTimes(3);
    expect(mocks.useGlobalSessionsFeed).toHaveBeenNthCalledWith(1, {
      enabled: true,
      limit: SIDEBAR_SESSION_FEED_LIMIT,
      includeStats: false,
    });
    expect(mocks.useGlobalSessionsFeed).toHaveBeenNthCalledWith(2, {
      enabled: true,
      starred: true,
      limit: SIDEBAR_SESSION_FEED_LIMIT,
      includeStats: false,
    });
  });

  it("requests categorized sessions only from a server that stores them", () => {
    // An older server ignores `categorized` and would return every session.
    const { result, rerender } = renderHook(() => useSidebarSessionFeeds(), {
      wrapper: withProvider,
    });
    expect(mocks.useGlobalSessionsFeed).toHaveBeenNthCalledWith(3, {
      enabled: false,
      categorized: true,
      limit: SIDEBAR_SESSION_FEED_LIMIT,
      includeStats: false,
    });
    expect(result.current.sidebarCategoriesSupported).toBe(false);

    mocks.version = { capabilities: [SIDEBAR_SESSION_CATEGORIES_CAPABILITY] };
    mocks.useGlobalSessionsFeed.mockClear();
    rerender();
    expect(mocks.useGlobalSessionsFeed).toHaveBeenNthCalledWith(3, {
      enabled: true,
      categorized: true,
      limit: SIDEBAR_SESSION_FEED_LIMIT,
      includeStats: false,
    });
    expect(result.current.sidebarCategoriesSupported).toBe(true);
  });

  it("releases all feed acquisition while the document is hidden", () => {
    mocks.version = { capabilities: [SIDEBAR_SESSION_CATEGORIES_CAPABILITY] };
    renderHook(() => useSidebarSessionFeeds(), { wrapper: withProvider });
    act(() => window.dispatchEvent(new Event("pagehide")));
    expect(
      mocks.useGlobalSessionsFeed.mock.calls
        .slice(-3)
        .every(([options]) => !options.enabled),
    ).toBe(true);
    act(() => window.dispatchEvent(new Event("pageshow")));
    expect(
      mocks.useGlobalSessionsFeed.mock.calls
        .slice(-3)
        .every(([options]) => options.enabled),
    ).toBe(true);
  });

  it("suspends both feed owners while its sidebar surface is hidden", () => {
    const wrapper = ({ children }: { children: ReactNode }) => (
      <SidebarSessionFeedsProvider enabled={false}>
        {children}
      </SidebarSessionFeedsProvider>
    );

    renderHook(() => useSidebarSessionFeeds(), { wrapper });

    expect(mocks.useGlobalSessionsFeed).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ enabled: false }),
    );
    expect(mocks.useGlobalSessionsFeed).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ enabled: false }),
    );
  });

  it("mounts one feed pair however many consumers read it", () => {
    renderHook(
      () => {
        useSidebarSessionFeeds();
        useSidebarSessionFeeds();
        useSidebarSessionFeeds();
      },
      { wrapper: withProvider },
    );

    expect(mocks.useGlobalSessionsFeed).toHaveBeenCalledTimes(3);
  });
});

describe("useSidebarSessionFeeds", () => {
  it("keeps the visible Sidebar load-more controls wired to the same coverage", () => {
    const globalLoadMore = vi.fn();
    const starredLoadMore = vi.fn();
    mocks.useGlobalSessionsFeed
      .mockReturnValueOnce({
        query: { scope: "global-sessions" },
        loading: false,
        hasMore: true,
        loadMore: globalLoadMore,
      })
      .mockReturnValueOnce({
        query: { scope: "global-sessions", starred: true },
        loading: true,
        hasMore: false,
        loadMore: starredLoadMore,
      });

    const { result } = renderHook(() => useSidebarSessionFeeds(), {
      wrapper: withProvider,
    });

    expect(mocks.useGlobalSessionsFeed).toHaveBeenCalledTimes(3);
    expect(result.current.globalQuery).toEqual({ scope: "global-sessions" });
    expect(result.current.starredQuery).toEqual({
      scope: "global-sessions",
      starred: true,
    });
    expect(result.current.loading).toBe(true);
    expect(result.current.hasMoreGlobalSessions).toBe(true);
    expect(result.current.loadMoreGlobalSessions).toBe(globalLoadMore);
    expect(result.current.hasMoreStarredSessions).toBe(false);
    expect(result.current.loadMoreStarredSessions).toBe(starredLoadMore);
  });

  it("refuses to mount its own feeds when the provider is missing", () => {
    // A fallback that mounted feeds here would silently restore the duplicate
    // pair the provider exists to remove, so the absence has to be loud.
    expect(() => renderHook(() => useSidebarSessionFeeds())).toThrow(
      /SidebarSessionFeedsProvider/,
    );
    expect(mocks.useGlobalSessionsFeed).not.toHaveBeenCalled();
  });
});
