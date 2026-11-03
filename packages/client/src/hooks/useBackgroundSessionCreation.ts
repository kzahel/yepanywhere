import { useSyncExternalStore } from "react";
import { createLocalStorageBoolean } from "../lib/localStorageValue";
import { UI_KEYS } from "../lib/storageKeys";

const store = createLocalStorageBoolean(
  UI_KEYS.backgroundSessionCreation,
  false,
);

export function useBackgroundSessionCreation() {
  const backgroundSessionCreation = useSyncExternalStore(
    store.subscribe,
    store.read,
    store.read,
  );
  return { backgroundSessionCreation, setBackgroundSessionCreation: store.set };
}
