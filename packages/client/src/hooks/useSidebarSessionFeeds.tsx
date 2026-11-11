import { useDocumentVisible } from "./useDocumentVisible";
import {
  SERVER_CAPABILITIES,
  SIDEBAR_SESSION_CATEGORIES_CAPABILITY,
  serverHasCapability,
} from "@yep-anywhere/shared";
import { createContext, type ReactNode, useContext, useMemo } from "react";
import { useGlobalSessionsFeed } from "./useGlobalSessionsFeed";
import { useVersion } from "./useVersion";
import type { SessionCollectionQueryDescriptor } from "../lib/clientSummaryCollections";

export const SIDEBAR_SESSION_FEED_LIMIT = 50;

export interface SidebarSessionFeeds {
  globalQuery: SessionCollectionQueryDescriptor;
  starredQuery: SessionCollectionQueryDescriptor;
  categorizedQuery?: SessionCollectionQueryDescriptor;
  authoritativeWindows?: boolean;
  loading: boolean;
  hasMoreGlobalSessions: boolean;
  loadMoreGlobalSessions: () => Promise<void>;
  hasMoreStarredSessions: boolean;
  loadMoreStarredSessions: () => Promise<void>;
  /** The server stores sidebar categories and reports session creators. */
  sidebarCategoriesSupported: boolean;
  hasMoreCategorizedSessions: boolean;
  loadMoreCategorizedSessions: () => Promise<void>;
}

const SidebarSessionFeedsContext = createContext<SidebarSessionFeeds | null>(
  null,
);

/**
 * Mounts the sidebar's session feeds once for the whole navigation tree.
 *
 * They cannot live in `Sidebar`: it renders in two places (the desktop rail and
 * the mobile overlay) and unmounts with the route, so feeds the component owned
 * would be torn down and refetched on every overlay toggle. The app shell used
 * to solve that by mounting them twice — once in the layout to retain coverage
 * across those unmounts, once in the component to read it — which ran two
 * copies of every activity and store subscription behind one pair of query
 * keys, and re-rendered the entire layout subtree on each feed update.
 *
 * The provider owns the single mount and publishes the value, so a feed update
 * re-renders its context consumers rather than everything the layout renders.
 */
export function SidebarSessionFeedsProvider({
  enabled = true,
  limit = SIDEBAR_SESSION_FEED_LIMIT,
  children,
}: {
  enabled?: boolean;
  limit?: number;
  children: ReactNode;
}) {
  const active = useDocumentVisible() && enabled;
  const globalFeed = useGlobalSessionsFeed({
    enabled: active,
    limit,
    includeStats: false,
  });

  const starredFeed = useGlobalSessionsFeed({
    enabled: active,
    starred: true,
    limit,
    includeStats: false,
  });

  // Categorized sessions keep their section however old they are, so they
  // need their own feed rather than whatever the recent page happens to hold.
  // An older server ignores `categorized` and would answer with every session.
  const { version } = useVersion();
  const sidebarCategoriesSupported = serverHasCapability(
    version,
    SIDEBAR_SESSION_CATEGORIES_CAPABILITY,
  );
  const categorizedFeed = useGlobalSessionsFeed({
    enabled: active && sidebarCategoriesSupported,
    categorized: true,
    limit,
    includeStats: false,
  });

  const value = useMemo<SidebarSessionFeeds>(
    () => ({
      globalQuery: globalFeed.query,
      starredQuery: starredFeed.query,
      categorizedQuery: categorizedFeed.query,
      // SIDEBAR_SESSION_WINDOW_FALLBACK: preserve older servers' selector behavior.
      authoritativeWindows: serverHasCapability(
        version,
        SERVER_CAPABILITIES.sidebarSessionSnapshot,
      ),
      loading: globalFeed.loading || starredFeed.loading,
      hasMoreGlobalSessions: globalFeed.hasMore,
      loadMoreGlobalSessions: globalFeed.loadMore,
      hasMoreStarredSessions: starredFeed.hasMore,
      loadMoreStarredSessions: starredFeed.loadMore,
      sidebarCategoriesSupported,
      hasMoreCategorizedSessions:
        sidebarCategoriesSupported && categorizedFeed.hasMore,
      loadMoreCategorizedSessions: categorizedFeed.loadMore,
    }),
    [
      version,
      sidebarCategoriesSupported,
      categorizedFeed.query,
      categorizedFeed.hasMore,
      categorizedFeed.loadMore,
      globalFeed.query,
      globalFeed.loading,
      globalFeed.hasMore,
      globalFeed.loadMore,
      starredFeed.query,
      starredFeed.loading,
      starredFeed.hasMore,
      starredFeed.loadMore,
    ],
  );

  return (
    <SidebarSessionFeedsContext.Provider value={value}>
      {children}
    </SidebarSessionFeedsContext.Provider>
  );
}

export function useSidebarSessionFeeds(): SidebarSessionFeeds {
  const feeds = useContext(SidebarSessionFeedsContext);
  if (!feeds) {
    throw new Error(
      "useSidebarSessionFeeds must be used under SidebarSessionFeedsProvider",
    );
  }
  return feeds;
}
