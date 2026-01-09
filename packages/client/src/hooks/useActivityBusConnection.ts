import { useEffect } from "react";
import { useAuth } from "../contexts/AuthContext";
import { activityBus } from "../lib/activityBus";

/**
 * Manages the activityBus SSE connection based on authentication state.
 *
 * When auth is enabled but user is not authenticated, we don't connect
 * to avoid 401 errors that can trigger the browser's basic auth prompt.
 *
 * When auth is not enabled, or user is authenticated, we connect.
 */
export function useActivityBusConnection(): void {
  const { isAuthenticated, authEnabled, isLoading } = useAuth();

  useEffect(() => {
    // Don't do anything while loading auth state
    if (isLoading) return;

    // Connect if auth is disabled OR user is authenticated
    const shouldConnect = !authEnabled || isAuthenticated;

    if (shouldConnect) {
      activityBus.connect();
    } else {
      activityBus.disconnect();
    }

    // Disconnect on unmount
    return () => {
      activityBus.disconnect();
    };
  }, [isAuthenticated, authEnabled, isLoading]);
}
