import { useSyncExternalStore } from "react";
import { createLocalStorageBoolean } from "../lib/localStorageValue";
import { UI_KEYS } from "../lib/storageKeys";

const store = createLocalStorageBoolean(UI_KEYS.streamingEnabled, false);

export const subscribeStreamingEnabled = store.subscribe;

/**
 * Hook to manage streaming preference.
 * When enabled, assistant responses stream in token-by-token.
 * When disabled, responses appear all at once when complete.
 */
export function useStreamingEnabled() {
  const streamingEnabled = useSyncExternalStore(
    store.subscribe,
    store.read,
    store.read,
  );
  return { streamingEnabled, setStreamingEnabled: store.set };
}

/**
 * Get streaming preference without React state (for non-component code).
 */
export const getStreamingEnabled = store.read;
