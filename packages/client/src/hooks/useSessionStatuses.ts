import { useEffect, useMemo, useRef, useState } from "react";
import { activityBus } from "../lib/activityBus";
import type { ProcessStateType, SessionSummary } from "../types";

export interface SessionStatus {
  processState?: ProcessStateType;
  pendingInputType?: SessionSummary["pendingInputType"];
  hasUnread?: boolean;
}

/**
 * Hook to track real-time status updates for a set of sessions across multiple projects.
 * Subscribes to SSE events and maintains a map of session statuses.
 *
 * @param sessionIds - Array of session IDs to track
 * @param initialSessions - Optional map of initial session data to populate status from
 */
export function useSessionStatuses(
  sessionIds: string[],
  initialSessions?: Map<string, SessionSummary>,
): Map<string, SessionStatus> {
  const [statuses, setStatuses] = useState<Map<string, SessionStatus>>(() => {
    const initial = new Map<string, SessionStatus>();
    if (initialSessions) {
      for (const id of sessionIds) {
        const session = initialSessions.get(id);
        if (session) {
          initial.set(id, {
            processState: session.processState,
            pendingInputType: session.pendingInputType,
            hasUnread: session.hasUnread,
          });
        }
      }
    }
    return initial;
  });

  // Create a stable Set for session IDs that only changes when the actual
  // session IDs change (not on every render). This prevents the effect from
  // re-running and potentially missing events during the brief unsubscribe/
  // resubscribe window (especially with WebSocket transport where events
  // arrive quickly on a single connection).
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentionally using sorted key for stability
  const sessionIdSet = useMemo(
    () => new Set(sessionIds),
    [sessionIds.slice().sort().join(",")],
  );

  // Keep a ref to the current sessionIdSet for use in event handlers
  // This ensures handlers always check against the latest set even if
  // the effect hasn't re-run yet
  const sessionIdSetRef = useRef(sessionIdSet);
  sessionIdSetRef.current = sessionIdSet;

  // Update statuses when initialSessions changes
  useEffect(() => {
    if (!initialSessions) return;

    setStatuses((prev) => {
      const next = new Map(prev);
      for (const id of sessionIds) {
        const session = initialSessions.get(id);
        if (session && !next.has(id)) {
          next.set(id, {
            processState: session.processState,
            pendingInputType: session.pendingInputType,
            hasUnread: session.hasUnread,
          });
        }
      }
      return next;
    });
  }, [initialSessions, sessionIds]);

  // Subscribe to process state changes
  // Using sessionIdSetRef.current in handlers ensures we always check against
  // the latest set of session IDs, even if the effect hasn't re-run yet
  useEffect(() => {
    const unsubscribers: (() => void)[] = [];

    // Process state changes (running/waiting-input/idle)
    unsubscribers.push(
      activityBus.on("process-state-changed", (event) => {
        if (!sessionIdSetRef.current.has(event.sessionId)) return;

        setStatuses((prev) => {
          const next = new Map(prev);
          const current = next.get(event.sessionId) ?? {};

          // When state changes to "running", clear pendingInputType since input was resolved
          const pendingInputType =
            event.processState === "running"
              ? undefined
              : current.pendingInputType;

          next.set(event.sessionId, {
            ...current,
            processState: event.processState,
            pendingInputType,
          });
          return next;
        });
      }),
    );

    // Session status changes (idle/owned/external)
    unsubscribers.push(
      activityBus.on("session-status-changed", (event) => {
        if (!sessionIdSetRef.current.has(event.sessionId)) return;

        setStatuses((prev) => {
          const next = new Map(prev);
          const current = next.get(event.sessionId) ?? {};

          // When session goes idle, clear process state and pendingInputType
          if (event.status.state === "idle") {
            next.set(event.sessionId, {
              ...current,
              processState: undefined,
              pendingInputType: undefined,
            });
          }

          return next;
        });
      }),
    );

    // Session seen events
    unsubscribers.push(
      activityBus.on("session-seen", (event) => {
        if (!sessionIdSetRef.current.has(event.sessionId)) return;

        setStatuses((prev) => {
          const next = new Map(prev);
          const current = next.get(event.sessionId) ?? {};
          next.set(event.sessionId, {
            ...current,
            hasUnread: false,
          });
          return next;
        });
      }),
    );

    return () => {
      for (const unsub of unsubscribers) {
        unsub();
      }
    };
    // Subscribe once on mount. We use sessionIdSetRef.current in handlers
    // so they always check against the latest session IDs without needing
    // to re-subscribe (which could miss events during the transition).
  }, []);

  return statuses;
}
