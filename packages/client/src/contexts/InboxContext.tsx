/**
 * InboxContext - Single source of truth for inbox data.
 *
 * Consolidates inbox fetching to avoid multiple hooks making duplicate requests.
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
import { useFileActivity } from "../hooks/useFileActivity";
import { authEvents } from "../lib/authEvents";

// Re-export types for consumers
export type { InboxItem, InboxResponse } from "../api/client";

// Debounce interval for refetch on SSE events (prevents rapid refetches)
const REFETCH_DEBOUNCE_MS = 500;

/** The five tier keys in priority order */
export const INBOX_TIERS = [
  "needsAttention",
  "active",
  "recentActivity",
  "unread8h",
  "unread24h",
] as const;

export type InboxTier = (typeof INBOX_TIERS)[number];

/**
 * Tracks the stable order of session IDs within each tier.
 * Used to prevent reordering during polling while still allowing
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

const EMPTY_INBOX: InboxResponse = {
  needsAttention: [],
  active: [],
  recentActivity: [],
  unread8h: [],
  unread24h: [],
};

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
  const [inbox, setInbox] = useState<InboxResponse>(EMPTY_INBOX);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [enabled, setEnabled] = useState(initialEnabled);

  // Track the order of session IDs per tier for stable rendering
  const tierOrderRef = useRef<TierOrder>(createEmptyTierOrder());
  // Track if we've done the initial load (determines whether to use stable ordering)
  const hasInitialLoadRef = useRef(false);
  // Debounce timer for SSE-triggered refetches
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Track enabled state in ref for callbacks
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  /**
   * Fetches inbox data and applies stable ordering.
   * @param forceFullSort - If true, uses server sort order instead of stable merge
   */
  const fetchInbox = useCallback(async (forceFullSort = false) => {
    // Skip if disabled, on login page, or login is required (prevents 401s)
    if (
      !enabledRef.current ||
      window.location.pathname === "/login" ||
      authEvents.loginRequired
    ) {
      return;
    }

    try {
      const data = await api.getInbox();

      if (!hasInitialLoadRef.current || forceFullSort) {
        // Initial load or explicit refresh: use server's sort order
        setInbox(data);
        tierOrderRef.current = extractTierOrder(data);
        hasInitialLoadRef.current = true;
      } else {
        // Subsequent fetches: merge with stable ordering
        const mergedData = mergeWithStableOrder(data, tierOrderRef.current);
        setInbox(mergedData);
        // Update tier order to include any new items
        tierOrderRef.current = extractTierOrder(mergedData);
      }

      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setLoading(false);
    }
  }, []);

  /**
   * Force a full refresh with server-provided sort order.
   */
  const refresh = useCallback(() => {
    return fetchInbox(true);
  }, [fetchInbox]);

  /**
   * Debounced refetch - prevents rapid refetches from multiple SSE events
   */
  const debouncedRefetch = useCallback(() => {
    // Skip if disabled, on login page, or login is required
    if (
      !enabledRef.current ||
      window.location.pathname === "/login" ||
      authEvents.loginRequired
    ) {
      return;
    }

    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
    }
    debounceTimerRef.current = setTimeout(() => {
      fetchInbox();
    }, REFETCH_DEBOUNCE_MS);
  }, [fetchInbox]);

  // Subscribe to SSE events for real-time updates
  // NOTE: We no longer refetch on file-change events. The inbox API primarily categorizes
  // sessions by processState and pendingInputType, which are now available via SSE events:
  // - process-state-changed: processState, pendingInputType (for needsAttention/active tiers)
  // - session-status-changed: when session becomes owned/external/idle
  // - session-created: new session
  // - session-seen: hasUnread status changes (less critical for inbox tiers)
  //
  // File changes mostly affect hasUnread, which is secondary to inbox tier categorization.
  useFileActivity({
    onProcessStateChange: debouncedRefetch,
    onSessionStatusChange: debouncedRefetch,
    onSessionSeen: debouncedRefetch,
    onSessionCreated: debouncedRefetch,
  });

  // Initial fetch when enabled (and not on login page or requiring login)
  useEffect(() => {
    if (
      enabled &&
      window.location.pathname !== "/login" &&
      !authEvents.loginRequired
    ) {
      fetchInbox();
    }
  }, [enabled, fetchInbox]);

  // Cleanup debounce timer
  useEffect(() => {
    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
    };
  }, []);

  // Computed totals
  const totalNeedsAttention = inbox.needsAttention.length;
  const totalActive = inbox.active.length;
  const totalItems =
    inbox.needsAttention.length +
    inbox.active.length +
    inbox.recentActivity.length +
    inbox.unread8h.length +
    inbox.unread24h.length;

  return (
    <InboxContext.Provider
      value={{
        needsAttention: inbox.needsAttention,
        active: inbox.active,
        recentActivity: inbox.recentActivity,
        unread8h: inbox.unread8h,
        unread24h: inbox.unread24h,
        inbox,
        loading,
        error,
        refresh,
        refetch: fetchInbox,
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
