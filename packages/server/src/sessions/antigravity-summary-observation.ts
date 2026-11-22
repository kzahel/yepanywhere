import type { EventBus } from "../watcher/EventBus.js";
import { antigravitySummariesPath } from "../sdk/providers/antigravity-runtime.js";

interface Observation {
  listeners: Map<string, Set<() => void>>;
  dispose: () => void;
}

const observations = new WeakMap<EventBus, Observation>();

/** Fan out the existing provider-root DB/WAL observations to active owners. */
export function observeAntigravitySummaries(
  eventBus: EventBus | undefined,
  scope: string,
  listener: () => void,
): (() => void) | undefined {
  if (!eventBus) return undefined;
  let observation = observations.get(eventBus);
  if (!observation) {
    const listeners = new Map<string, Set<() => void>>();
    const dispose = eventBus.subscribe((event) => {
      if (event.type !== "file-change" || event.provider !== "antigravity")
        return;
      const path = event.path.endsWith("-wal")
        ? event.path.slice(0, -4)
        : event.path;
      for (const notify of listeners.get(path) ?? []) notify();
    });
    observation = { listeners, dispose };
    observations.set(eventBus, observation);
  }
  const path = antigravitySummariesPath(scope);
  let listeners = observation.listeners.get(path);
  if (!listeners) {
    listeners = new Set();
    observation.listeners.set(path, listeners);
  }
  listeners.add(listener);
  const { listeners: byPath, dispose } = observation;
  return () => {
    if (!listeners.delete(listener)) return;
    if (listeners.size !== 0) return;
    byPath.delete(path);
    if (byPath.size !== 0) return;
    dispose();
    observations.delete(eventBus);
  };
}
