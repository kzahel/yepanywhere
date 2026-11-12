/**
 * InboxContext - Fetch lifecycle and compatibility context for inbox data.
 *
 * Consolidates inbox fetching, reports accepted snapshots into the client
 * summary store, and exposes store-selected rows to existing consumers.
 * Supports an `enabled` option to pause fetching when inbox UI is not visible.
 */

import {
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { type InboxItem, type InboxResponse, api } from "../api/client";
import {
  type RetainedClientQueryEvent,
  useRetainedClientQuery,
} from "../hooks/useRetainedClientQuery";
import { isBrowserAppRoutePath } from "../lib/appHref";
import { authEvents } from "../lib/authEvents";
import {
  createClientQueryKey,
  type ClientQueryRequestContext,
} from "../lib/clientQueryController";
import { isRemoteClient } from "../lib/connection";
import { catalogLoadState } from "../lib/clientSummaryCollections";
import { resolveCollectionRequestMode } from "../lib/collectionRequestMode";
import { useInboxResponseSnapshot } from "../lib/clientSummaryStore";
import { INBOX_TIERS, type InboxTier } from "../lib/inboxTiers";
import { useOptionalRemoteConnection } from "./RemoteConnectionContext";
import { useCurrentSourceRuntime } from "./SourceRuntimeContext";
import { useCollectionUpdates } from "../hooks/useCollectionUpdates";
import {
  collectionQueryIsLive,
  pauseCollectionUpdates,
} from "../lib/collectionUpdates";

// Re-export types for consumers
export type { InboxItem, InboxResponse } from "../api/client";
export { INBOX_TIERS, type InboxTier } from "../lib/inboxTiers";

const INBOX_QUERY_KEY = createClientQueryKey({
  endpoint: "inbox",
});
const INBOX_REVALIDATE_EVENTS = [
  "refresh",
  "reconnect",
  "process-state-changed",
  "session-provider-phase-changed",
  "session-status-changed",
  "session-seen",
  "session-created",
  "session-metadata-changed",
  "session-updated",
  "session-catalog-updated",
  "project-queue-changed",
] as const;
const INBOX_STALE_TIME_MS = 0;

/**
 * Tracks the stable order of session IDs within each tier.
 * Used to prevent reordering during background revalidation while still allowing
 * items to move between tiers.
 */
type TierOrder = Record<InboxTier, string[]>;

/**
 * Merges new inbox data with existing tier order for UI stability.
 *
 * Rules:
 * - Existing items stay in their current position within a tier
 * - New items are appended at the end of their tier
 * - Items that are no longer in a tier are removed
 * - Items CAN move between tiers (that's meaningful state change)
 */
function mergeWithStableOrder(
  newData: InboxResponse,
  currentOrder: TierOrder,
): InboxResponse {
  const result: InboxResponse = {
    ...(newData.catalog ? { catalog: newData.catalog } : {}),
    needsAttention: [],
    active: [],
    recentActivity: [],
    unread8h: [],
    unread24h: [],
  };

  for (const tier of INBOX_TIERS) {
    const newItems = newData[tier];
    const existingOrder = currentOrder[tier];

    // Build lookup map for quick access
    const newItemsMap = new Map(newItems.map((item) => [item.sessionId, item]));

    // First, add existing items that are still in this tier (preserving order)
    const orderedItems: InboxItem[] = [];
    for (const sessionId of existingOrder) {
      const item = newItemsMap.get(sessionId);
      if (item) {
        orderedItems.push(item);
      }
    }

    // Then, append new items that weren't in the existing order
    const existingSet = new Set(existingOrder);
    for (const item of newItems) {
      if (!existingSet.has(item.sessionId)) {
        orderedItems.push(item);
      }
    }

    result[tier] = orderedItems;
  }

  return result;
}

/**
 * Extracts the session ID order from inbox data.
 */
function extractTierOrder(data: InboxResponse): TierOrder {
  return {
    needsAttention: data.needsAttention.map((item) => item.sessionId),
    active: data.active.map((item) => item.sessionId),
    recentActivity: data.recentActivity.map((item) => item.sessionId),
    unread8h: data.unread8h.map((item) => item.sessionId),
    unread24h: data.unread24h.map((item) => item.sessionId),
  };
}

/**
 * Creates an empty tier order structure.
 */
function createEmptyTierOrder(): TierOrder {
  return {
    needsAttention: [],
    active: [],
    recentActivity: [],
    unread8h: [],
    unread24h: [],
  };
}

function getLocallyPatchableSessionUpdatedIds(
  inbox: InboxResponse,
): ReadonlySet<string> {
  const sessionIds = new Set<string>();
  for (const tier of ["needsAttention", "active", "recentActivity"] as const) {
    for (const item of inbox[tier]) {
      // A content event cannot make an already-unread row more unread, so its
      // content fields are safe to patch locally. A read row must revalidate:
      // only the server can compare its new updatedAt with the durable
      // last-seen marker and recompute inbox tier membership.
      if (item.hasUnread) {
        sessionIds.add(item.sessionId);
      }
    }
  }
  return sessionIds;
}

function getEventSessionId(data: unknown): string | null {
  if (
    typeof data !== "object" ||
    data === null ||
    !("sessionId" in data) ||
    typeof data.sessionId !== "string"
  ) {
    return null;
  }
  return data.sessionId;
}

interface InboxContextValue {
  /** Sessions requiring immediate user input (tool approval or question) */
  needsAttention: InboxItem[];
  /** Sessions with running processes (no pending input) */
  active: InboxItem[];
  /** Sessions updated in the last 30 minutes */
  recentActivity: InboxItem[];
  /** Unread sessions from the last 8 hours */
  unread8h: InboxItem[];
  /** Unread sessions from the last 24 hours */
  unread24h: InboxItem[];
  /** Full inbox response (all tiers) */
  inbox: InboxResponse;
  /** True while loading initial data */
  loading: boolean;
  /** Error from the last fetch attempt, if any */
  error: Error | null;
  /** Force a full refresh with server sort order */
  refresh: () => Promise<void>;
  /** Refetch data (maintains stable ordering) */
  refetch: (forceFullSort?: boolean) => Promise<void>;
  /** Count of sessions needing attention */
  totalNeedsAttention: number;
  /** Count of active sessions */
  totalActive: number;
  /** Total count of all inbox items */
  totalItems: number;
  /** Whether fetching is enabled */
  enabled: boolean;
  /** Enable or disable fetching */
  setEnabled: (enabled: boolean) => void;
}

const InboxContext = createContext<InboxContextValue | null>(null);

interface InboxProviderProps {
  children: ReactNode;
  /** Initial enabled state (default: true) */
  initialEnabled?: boolean;
}

export function InboxProvider({
  children,
  initialEnabled = true,
}: InboxProviderProps) {
  const remoteConnection = useOptionalRemoteConnection();
  const runtime = useCurrentSourceRuntime();
  const sourceKey = runtime.sourceKey;
  const sourceSummary = runtime.summary;
  const sourceKeyRef = useRef(sourceKey);
  sourceKeyRef.current = sourceKey;
  const inbox = useInboxResponseSnapshot();
  const locallyPatchableSessionUpdatedIdsRef = useRef<ReadonlySet<string>>(
    new Set(),
  );
  locallyPatchableSessionUpdatedIdsRef.current =
    getLocallyPatchableSessionUpdatedIds(inbox);
  const [enabled, setEnabled] = useState(initialEnabled);
  const isRemoteConnectionReady =
    !isRemoteClient() ||
    (remoteConnection !== null && remoteConnection.connection !== null);
  const queryEnabled =
    enabled &&
    !isBrowserAppRoutePath(window.location.pathname, "/login") &&
    !authEvents.loginRequired;

  // Track the order of session IDs per tier for stable rendering
  const tierOrderRef = useRef<TierOrder>(createEmptyTierOrder());
  // Track if we've done the initial load (determines whether to use stable ordering)
  const hasInitialLoadRef = useRef(false);
  const [hasInitialLoad, setHasInitialLoad] = useState(false);
  // Track accepted responses so an older overlapping request cannot perturb the
  // stable tier order after a newer request already won.
  const latestAcceptedRequestStartedAtRef = useRef(0);

  useEffect(() => {
    void sourceKey;
    tierOrderRef.current = createEmptyTierOrder();
    hasInitialLoadRef.current = false;
    setHasInitialLoad(false);
    latestAcceptedRequestStartedAtRef.current = 0;
  }, [sourceKey]);

  /**
   * Applies inbox data and preserves stable tier ordering unless a foreground
   * refresh explicitly asks for server sort order.
   */
  const applyInboxSnapshot = useCallback(
    (data: InboxResponse, context: ClientQueryRequestContext) => {
      const requestSourceKey = context.sourceKey;
      const requestStartedAt = context.requestStartedAt;
      const forceFullSort =
        typeof context.meta === "object" &&
        context.meta !== null &&
        "forceFullSort" in context.meta &&
        context.meta.forceFullSort === true;

      if (sourceKeyRef.current !== requestSourceKey) {
        sourceSummary.reportInboxCollectionSnapshot(data, requestStartedAt);
        return;
      }

      const nextInbox =
        !hasInitialLoadRef.current || forceFullSort
          ? data
          : mergeWithStableOrder(data, tierOrderRef.current);

      if (requestStartedAt < latestAcceptedRequestStartedAtRef.current) {
        return;
      }

      sourceSummary.reportInboxCollectionSnapshot(nextInbox, requestStartedAt);
      tierOrderRef.current = extractTierOrder(nextInbox);
      latestAcceptedRequestStartedAtRef.current = requestStartedAt;
      hasInitialLoadRef.current = true;
      setHasInitialLoad(true);
    },
    [sourceSummary],
  );

  const shouldRevalidateInboxEvent = useCallback(
    (event: RetainedClientQueryEvent) => {
      if (collectionQueryIsLive(runtime, INBOX_QUERY_KEY)) return false;
      if (event.eventType !== "session-updated") {
        return true;
      }

      const sessionId = getEventSessionId(event.data);
      return (
        sessionId === null ||
        !locallyPatchableSessionUpdatedIdsRef.current.has(sessionId)
      );
    },
    [runtime],
  );

  const {
    loading,
    error,
    refetch: refetchInboxQuery,
  } = useRetainedClientQuery<InboxResponse>({
    sourceKey,
    key: INBOX_QUERY_KEY,
    bootstrapTier: "navigation",
    enabled: queryEnabled,
    ready: isRemoteConnectionReady,
    hasData: hasInitialLoad,
    staleTimeMs: INBOX_STALE_TIME_MS,
    revalidateOn: INBOX_REVALIDATE_EVENTS,
    shouldRevalidateEvent: shouldRevalidateInboxEvent,
    fetcher: async () => {
      const mode = await resolveCollectionRequestMode(sourceKey, {
        currentSourceKey: () => sourceKeyRef.current,
      });
      return mode === "retained"
        ? api.getInbox(undefined, "retained")
        : api.getInbox();
    },
    applySnapshot: applyInboxSnapshot,
  });

  useCollectionUpdates<InboxResponse>({
    runtime,
    key: INBOX_QUERY_KEY,
    path: "/inbox?summaryMode=retained",
    catalogPresentation: "loading",
    enabled: queryEnabled && isRemoteConnectionReady,
    applySnapshot: applyInboxSnapshot,
    fallback: () => {
      void refetchInboxQuery({ background: true });
    },
  });

  /**
   * Force a full refresh with server-provided sort order.
   */
  const refresh = useCallback(async () => {
    const resume = pauseCollectionUpdates(runtime, INBOX_QUERY_KEY);
    try {
      await refetchInboxQuery({ meta: { forceFullSort: true } });
    } finally {
      resume();
    }
  }, [refetchInboxQuery, runtime]);

  const refetch = useCallback(
    async (forceFullSort = false) => {
      const resume = pauseCollectionUpdates(runtime, INBOX_QUERY_KEY);
      try {
        await refetchInboxQuery(
          forceFullSort ? { meta: { forceFullSort: true } } : undefined,
        );
      } finally {
        resume();
      }
    },
    [refetchInboxQuery, runtime],
  );

  // Computed totals
  const totalNeedsAttention = inbox.needsAttention.length;
  const totalActive = inbox.active.length;
  const totalItems =
    inbox.needsAttention.length +
    inbox.active.length +
    inbox.recentActivity.length +
    inbox.unread8h.length +
    inbox.unread24h.length;
  const catalogState = catalogLoadState(inbox.catalog, totalItems);

  return (
    <InboxContext.Provider
      value={{
        needsAttention: inbox.needsAttention,
        active: inbox.active,
        recentActivity: inbox.recentActivity,
        unread8h: inbox.unread8h,
        unread24h: inbox.unread24h,
        inbox,
        loading: loading || (queryEnabled && catalogState.awaitingFirstRows),
        error: error ?? catalogState.refreshError,
        refresh,
        refetch,
        totalNeedsAttention,
        totalActive,
        totalItems,
        enabled,
        setEnabled,
      }}
    >
      {children}
    </InboxContext.Provider>
  );
}

/**
 * Hook to access inbox data from the global context.
 * Must be used within an InboxProvider.
 */
export function useInboxContext() {
  const context = useContext(InboxContext);
  if (!context) {
    throw new Error("useInboxContext must be used within an InboxProvider");
  }
  return context;
}
