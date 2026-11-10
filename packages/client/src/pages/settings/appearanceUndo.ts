interface UndoEntry {
  value: unknown;
  restore: (value: unknown) => void;
}

// Pairs a live settings value with its restore path. The cast inside is
// safe because construction guarantees value and setter share one T.
export function undoEntry<T>(
  value: T,
  set: (value: T) => void,
  syncDraft?: (value: T) => void,
): UndoEntry {
  return {
    value,
    restore: (raw) => {
      const restored = raw as T;
      set(restored);
      syncDraft?.(restored);
    },
  };
}
