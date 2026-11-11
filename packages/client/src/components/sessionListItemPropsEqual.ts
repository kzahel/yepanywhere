import type { SessionListItemProps } from "./SessionListItem";

// These props are server/browser DTOs. React nodes and callbacks deliberately
// retain reference equality, so new handlers and rendered content stay live.
const VALUE_PROPS = new Set([
  "status",
  "contextUsage",
  "providerChildren",
  "customBadge",
  "clearloop",
  "sidebarCategoryNames",
]);
function equalValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b) && a.length !== b.length)
    return false;
  if (
    !Array.isArray(a) &&
    (Object.getPrototypeOf(a) !== Object.prototype ||
      Object.getPrototypeOf(b) !== Object.prototype)
  )
    return false;
  const left = a as Record<string, unknown>,
    right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every(
      (key) => Object.hasOwn(right, key) && equalValue(left[key], right[key]),
    )
  );
}
export function sessionListItemPropsEqual(
  a: SessionListItemProps,
  b: SessionListItemProps,
): boolean {
  // Detailed cards derive visible ages at render; retain their existing refresh.
  // Compact rows recalculate hover ages when the hover controller opens.
  if (a.mode !== "compact" || b.mode !== "compact") return false;
  const keys = Object.keys(a) as (keyof SessionListItemProps)[];
  return (
    keys.length === Object.keys(b).length &&
    keys.every(
      (key) =>
        Object.hasOwn(b, key) &&
        (Object.is(a[key], b[key]) ||
          (VALUE_PROPS.has(key) && equalValue(a[key], b[key]))),
    )
  );
}
