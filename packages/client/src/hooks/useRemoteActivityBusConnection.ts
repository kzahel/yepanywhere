import { useEffect, useRef } from "react";
import { activityBus } from "../lib/activityBus";

/**
 * Manages the activityBus connection for remote mode.
 *
 * Unlike useActivityBusConnection, this doesn't check auth state
 * because remote mode is already authenticated via SRP when
 * this hook runs (the connection gate ensures this).
 *
 * Includes visibility change handling to force reconnection when
 * the page becomes visible again (e.g., mobile phone waking from sleep).
 */
export function useRemoteActivityBusConnection(): void {
  const lastVisibleTime = useRef<number>(Date.now());

  useEffect(() => {
    activityBus.connect();

    // Handle visibility changes to reconnect when page becomes visible
    // This is critical for mobile where the WebSocket may go stale during sleep
    const handleVisibilityChange = () => {
      console.log(
        `[RemoteActivityBus] Visibility changed: ${document.visibilityState}`,
      );
      if (document.visibilityState === "visible") {
        const hiddenDuration = Date.now() - lastVisibleTime.current;
        console.log(
          `[RemoteActivityBus] Was hidden for ${Math.round(hiddenDuration / 1000)}s, connected=${activityBus.connected}, lastEvent=${activityBus.lastEventTime ? `${Math.round((Date.now() - activityBus.lastEventTime) / 1000)}s ago` : "never"}`,
        );
        // If hidden for more than 5 seconds, force reconnect to ensure fresh data
        // WebSocket connections often go stale on mobile when backgrounded
        if (hiddenDuration > 5000) {
          console.log(
            `[RemoteActivityBus] Triggering force reconnect after ${Math.round(hiddenDuration / 1000)}s hidden`,
          );
          activityBus.forceReconnect();
        }
      } else {
        console.log("[RemoteActivityBus] Page hidden, recording timestamp");
        lastVisibleTime.current = Date.now();
      }
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);

    // Disconnect on unmount
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      activityBus.disconnect();
    };
  }, []);
}
