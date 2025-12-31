import { useCallback, useEffect, useRef } from "react";
import { api } from "../api/client";

/**
 * Tracks user engagement with a session to determine when to mark it as "seen".
 *
 * We don't want to mark a session as seen just because the page is open:
 * - User might have left their laptop open
 * - Auto-scrolling content doesn't mean user is reading
 *
 * We mark as seen when:
 * 1. Tab is focused (document.hasFocus())
 * 2. User has interacted recently (within last 30 seconds)
 * 3. Session has new content (updatedAt > lastSeenAt)
 *
 * Debounces API calls to avoid excessive writes.
 */

const INTERACTION_TIMEOUT_MS = 30_000; // 30 seconds
const DEBOUNCE_MS = 2_000; // 2 seconds

interface UseEngagementTrackingOptions {
  /** Session ID to track */
  sessionId: string;
  /** ISO timestamp of when session was last updated */
  updatedAt: string | null;
  /** ISO timestamp of when user last viewed this session */
  lastSeenAt?: string;
  /** Whether engagement tracking is enabled (e.g., false for external sessions) */
  enabled?: boolean;
}

export function useEngagementTracking(options: UseEngagementTrackingOptions) {
  const { sessionId, updatedAt, lastSeenAt, enabled = true } = options;

  // Track last user interaction time
  const lastInteractionRef = useRef<number>(Date.now());
  // Track if we've already marked this content as seen
  const markedSeenRef = useRef<string | null>(null);
  // Debounce timer
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Track if component is mounted
  const mountedRef = useRef(true);

  // Check if there's new content to mark as seen
  const hasNewContent = useCallback(() => {
    if (!updatedAt) return false;
    if (!lastSeenAt) return true; // Never seen before
    return updatedAt > lastSeenAt;
  }, [updatedAt, lastSeenAt]);

  // Check if user is actively engaged
  const isEngaged = useCallback(() => {
    const isFocused = document.hasFocus();
    const hasRecentInteraction =
      Date.now() - lastInteractionRef.current < INTERACTION_TIMEOUT_MS;
    return isFocused && hasRecentInteraction;
  }, []);

  // Mark session as seen (debounced)
  const markSeen = useCallback(() => {
    if (!enabled || !mountedRef.current) return;
    if (!updatedAt) return;

    // Don't re-mark if we've already marked this content
    if (markedSeenRef.current === updatedAt) return;

    // Clear any pending debounce
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
    }

    // Debounce the API call
    debounceTimerRef.current = setTimeout(async () => {
      if (!mountedRef.current) return;
      if (!isEngaged()) return;
      if (!hasNewContent()) return;

      try {
        await api.markSessionSeen(sessionId, updatedAt);
        markedSeenRef.current = updatedAt;
      } catch (error) {
        console.warn(
          "[useEngagementTracking] Failed to mark session as seen:",
          error,
        );
      }
    }, DEBOUNCE_MS);
  }, [enabled, sessionId, updatedAt, isEngaged, hasNewContent]);

  // Track user interactions
  useEffect(() => {
    if (!enabled) return;

    const handleInteraction = () => {
      lastInteractionRef.current = Date.now();

      // If engaged and there's new content, schedule mark-seen
      if (hasNewContent() && isEngaged()) {
        markSeen();
      }
    };

    // Track various interaction types
    const events = ["mousemove", "keydown", "scroll", "click", "touchstart"];
    for (const event of events) {
      window.addEventListener(event, handleInteraction, { passive: true });
    }

    return () => {
      for (const event of events) {
        window.removeEventListener(event, handleInteraction);
      }
    };
  }, [enabled, hasNewContent, isEngaged, markSeen]);

  // Track focus changes
  useEffect(() => {
    if (!enabled) return;

    const handleVisibilityChange = () => {
      if (
        document.visibilityState === "visible" &&
        hasNewContent() &&
        isEngaged()
      ) {
        markSeen();
      }
    };

    const handleFocus = () => {
      // Record interaction when focusing
      lastInteractionRef.current = Date.now();
      if (hasNewContent() && isEngaged()) {
        markSeen();
      }
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("focus", handleFocus);

    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("focus", handleFocus);
    };
  }, [enabled, hasNewContent, isEngaged, markSeen]);

  // Check for new content when it changes
  useEffect(() => {
    if (!enabled) return;
    if (!updatedAt) return;

    // If content is new and user is engaged, mark as seen
    if (hasNewContent() && isEngaged()) {
      markSeen();
    }
  }, [enabled, updatedAt, hasNewContent, isEngaged, markSeen]);

  // Cleanup
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
    };
  }, []);

  // Force mark as seen (for explicit user action, bypasses engagement check)
  const forceMarkSeen = useCallback(async () => {
    if (!enabled || !updatedAt) return;

    try {
      await api.markSessionSeen(sessionId, updatedAt);
      markedSeenRef.current = updatedAt;
    } catch (error) {
      console.warn(
        "[useEngagementTracking] Failed to force mark session as seen:",
        error,
      );
    }
  }, [enabled, sessionId, updatedAt]);

  return {
    /** Manually mark the session as seen (bypasses engagement check) */
    forceMarkSeen,
    /** Check if user is currently engaged */
    isEngaged,
  };
}
