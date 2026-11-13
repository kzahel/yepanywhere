import { useEffect, useState, useSyncExternalStore } from "react";

export function useRelativeNow(intervalMs = 30 * 1000): number {
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      setNowMs(Date.now());
    }, intervalMs);
    return () => window.clearInterval(intervalId);
  }, [intervalMs]);

  return nowMs;
}

const MINUTE_MS = 60 * 1000;
const minuteListeners = new Set<() => void>();
let minuteNow = Date.now();
let minuteTimer: number | undefined;

function subscribeMinute(listener: () => void) {
  minuteListeners.add(listener);
  if (minuteTimer === undefined) {
    // The clock stops while nothing listens; resume from the current time.
    minuteNow = Date.now();
    minuteTimer = window.setInterval(() => {
      minuteNow = Date.now();
      for (const notify of minuteListeners) notify();
    }, MINUTE_MS);
  }
  return () => {
    minuteListeners.delete(listener);
    if (minuteListeners.size === 0 && minuteTimer !== undefined) {
      window.clearInterval(minuteTimer);
      minuteTimer = undefined;
    }
  };
}

const getMinuteNow = () => minuteNow;

/**
 * The current time, refreshed each minute by one timer shared by every
 * subscriber, for components mounted many times over (one per list row).
 */
export function useMinuteNow(): number {
  return useSyncExternalStore(subscribeMinute, getMinuteNow);
}
