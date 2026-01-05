import {
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

/**
 * Markdown augment data for a text block.
 * Contains pre-rendered HTML with syntax highlighting from server.
 */
export interface MarkdownAugment {
  /** Pre-rendered HTML with shiki syntax highlighting */
  html: string;
}

/**
 * Context value for markdown augments.
 * Stores pre-rendered markdown HTML keyed by text block ID.
 */
interface MarkdownAugmentContextValue {
  /**
   * Get a markdown augment by text block ID.
   * ID format: `${messageId}-${blockIndex}`
   */
  getAugment: (blockId: string) => MarkdownAugment | undefined;

  /**
   * Set a single markdown augment.
   * Called when streaming augments arrive with messageId.
   */
  setAugment: (blockId: string, augment: MarkdownAugment) => void;

  /**
   * Set multiple markdown augments at once (replaces all existing).
   * Called when loading session via REST (markdownAugments in response).
   */
  setAugments: (augments: Record<string, MarkdownAugment>) => void;

  /**
   * Merge multiple markdown augments (preserves existing).
   * Called when batching streaming augments on stream end.
   */
  mergeAugments: (augments: Record<string, MarkdownAugment>) => void;

  /**
   * Clear all augments.
   * Called when switching sessions.
   */
  clearAugments: () => void;

  /**
   * Version counter that increments on each mutation.
   * Used by useMarkdownAugment to subscribe to changes.
   */
  version: number;

  /**
   * Subscribe to changes for a specific block ID.
   * Returns unsubscribe function.
   */
  subscribe: (blockId: string, callback: () => void) => () => void;
}

const MarkdownAugmentContext =
  createContext<MarkdownAugmentContextValue | null>(null);

interface MarkdownAugmentProviderProps {
  children: ReactNode;
}

/**
 * Provider for markdown augments.
 *
 * This context stores pre-rendered markdown HTML for text blocks.
 * When loading historical messages, the server renders markdown with
 * shiki syntax highlighting so code blocks look identical to streaming.
 */
export function MarkdownAugmentProvider({
  children,
}: MarkdownAugmentProviderProps) {
  const [augments, setAugmentsState] = useState<Map<string, MarkdownAugment>>(
    () => new Map(),
  );
  // Version counter to trigger re-renders in useMarkdownAugment consumers
  const [version, setVersion] = useState(0);

  // Use a ref to track current augments for the getter
  // This keeps getAugment stable (no dependency on augments state)
  const augmentsRef = useRef<Map<string, MarkdownAugment>>(augments);
  augmentsRef.current = augments;

  // Per-key subscribers for fine-grained updates
  const subscribersRef = useRef<Map<string, Set<() => void>>>(new Map());

  // Notify subscribers for specific keys
  const notifySubscribers = useCallback((blockIds: string[]) => {
    for (const blockId of blockIds) {
      const callbacks = subscribersRef.current.get(blockId);
      if (callbacks) {
        for (const callback of callbacks) {
          callback();
        }
      }
    }
  }, []);

  // Notify all subscribers (for bulk operations like setAugments, clearAugments)
  const notifyAllSubscribers = useCallback(() => {
    for (const callbacks of subscribersRef.current.values()) {
      for (const callback of callbacks) {
        callback();
      }
    }
  }, []);

  const getAugment = useCallback(
    (blockId: string): MarkdownAugment | undefined => {
      return augmentsRef.current.get(blockId);
    },
    [],
  );

  const subscribe = useCallback(
    (blockId: string, callback: () => void): (() => void) => {
      let callbacks = subscribersRef.current.get(blockId);
      if (!callbacks) {
        callbacks = new Set();
        subscribersRef.current.set(blockId, callbacks);
      }
      callbacks.add(callback);

      return () => {
        callbacks?.delete(callback);
        if (callbacks?.size === 0) {
          subscribersRef.current.delete(blockId);
        }
      };
    },
    [],
  );

  const setAugment = useCallback(
    (blockId: string, augment: MarkdownAugment): void => {
      setAugmentsState((prev) => {
        const next = new Map(prev);
        next.set(blockId, augment);
        return next;
      });
      setVersion((v) => v + 1);
      // Only notify this specific block's subscribers
      notifySubscribers([blockId]);
    },
    [notifySubscribers],
  );

  const setAugments = useCallback(
    (newAugments: Record<string, MarkdownAugment>): void => {
      setAugmentsState(() => {
        const next = new Map<string, MarkdownAugment>();
        for (const [blockId, augment] of Object.entries(newAugments)) {
          next.set(blockId, augment);
        }
        return next;
      });
      setVersion((v) => v + 1);
      // Notify all subscribers since this replaces everything
      notifyAllSubscribers();
    },
    [notifyAllSubscribers],
  );

  const mergeAugments = useCallback(
    (newAugments: Record<string, MarkdownAugment>): void => {
      setAugmentsState((prev) => {
        const next = new Map(prev);
        for (const [blockId, augment] of Object.entries(newAugments)) {
          next.set(blockId, augment);
        }
        return next;
      });
      setVersion((v) => v + 1);
      // Only notify subscribers for the merged keys
      notifySubscribers(Object.keys(newAugments));
    },
    [notifySubscribers],
  );

  const clearAugments = useCallback((): void => {
    setAugmentsState(new Map());
    setVersion((v) => v + 1);
    // Notify all subscribers since everything is cleared
    notifyAllSubscribers();
  }, [notifyAllSubscribers]);

  // Memoize the context value - only changes when version changes
  const value = useMemo<MarkdownAugmentContextValue>(
    () => ({
      getAugment,
      setAugment,
      setAugments,
      mergeAugments,
      clearAugments,
      version,
      subscribe,
    }),
    [
      getAugment,
      setAugment,
      setAugments,
      mergeAugments,
      clearAugments,
      version,
      subscribe,
    ],
  );

  return (
    <MarkdownAugmentContext.Provider value={value}>
      {children}
    </MarkdownAugmentContext.Provider>
  );
}

/**
 * Hook to access the markdown augment context.
 * Returns null if not within a provider (for graceful degradation).
 */
export function useMarkdownAugmentContext(): MarkdownAugmentContextValue | null {
  return useContext(MarkdownAugmentContext);
}

/**
 * Hook to get a markdown augment by text block ID.
 * Convenience wrapper that handles the null context case.
 *
 * Uses useSyncExternalStore with per-key subscriptions for fine-grained updates.
 * Only re-renders when THIS specific augment changes, not when any augment changes.
 * This prevents unnecessary re-renders that would reset scroll position and
 * clear text selection in markdown blocks.
 */
export function useMarkdownAugment(
  blockId: string | undefined,
): MarkdownAugment | undefined {
  const context = useMarkdownAugmentContext();

  // Create stable subscribe function for useSyncExternalStore
  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      if (!context || !blockId) {
        return () => {};
      }
      return context.subscribe(blockId, onStoreChange);
    },
    [context, blockId],
  );

  // Snapshot getter - returns the current augment for this blockId
  const getSnapshot = useCallback(() => {
    if (!context || !blockId) return undefined;
    return context.getAugment(blockId);
  }, [context, blockId]);

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
