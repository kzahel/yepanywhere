import { useEffect, useState } from "react";
import { activityBus } from "../lib/activityBus";

interface ActivityBusState {
  connected: boolean;
  /** Timestamp of last received event (including heartbeats), null if never received */
  lastEventTime: number | null;
  /** Timestamp of last reconnect attempt, null if never attempted */
  lastReconnectTime: number | null;
}

/**
 * Hook to get the current activity bus connection state.
 * Updates when connection status changes (reconnect events) or periodically.
 */
export function useActivityBusState(): ActivityBusState {
  const [state, setState] = useState<ActivityBusState>({
    connected: activityBus.connected,
    lastEventTime: activityBus.lastEventTime,
    lastReconnectTime: activityBus.lastReconnectTime,
  });

  useEffect(() => {
    // Update on reconnect event
    const unsubReconnect = activityBus.on("reconnect", () => {
      setState({
        connected: true,
        lastEventTime: activityBus.lastEventTime,
        lastReconnectTime: activityBus.lastReconnectTime,
      });
    });

    // Check periodically since we don't have a disconnect event
    const interval = setInterval(() => {
      setState({
        connected: activityBus.connected,
        lastEventTime: activityBus.lastEventTime,
        lastReconnectTime: activityBus.lastReconnectTime,
      });
    }, 1000);

    return () => {
      unsubReconnect();
      clearInterval(interval);
    };
  }, []);

  return state;
}
