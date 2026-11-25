export const SIBLING_EDIT_MS = 15_000;

/** Give the typing tab time to save, then let a sibling recover its draft. */
export function deferSiblingDraftSave(
  entry: { siblingEditAt?: number; firstDirty: number },
  schedule: (delay: number) => void,
): boolean {
  const remaining =
    SIBLING_EDIT_MS - (Date.now() - (entry.siblingEditAt ?? -Infinity));
  if (remaining <= 0) return false;
  entry.firstDirty = 0;
  schedule(remaining);
  return true;
}
