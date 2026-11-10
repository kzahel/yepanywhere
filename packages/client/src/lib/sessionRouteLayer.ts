const ROUTE_LAYER_SELECTOR = "[data-navigation-route-layer]";

/**
 * Find a session-scoped element such as the composer. With session DOM linger,
 * a parked session's layer stays mounted beside the active one, and layer DOM
 * order is stable rather than active-first, so a document-wide first match can
 * belong to the hidden session. Scope the lookup to `owner`'s route layer when
 * given, else to the active layer; fall back to the document when the session
 * is not rendered inside a route layer.
 */
export function querySessionRouteLayerElement<T extends HTMLElement>(
  selector: string,
  owner?: Element | null,
): T | null {
  if (typeof document === "undefined") {
    return null;
  }
  const layer = owner
    ? owner.closest(ROUTE_LAYER_SELECTOR)
    : document.querySelector(`${ROUTE_LAYER_SELECTOR}[data-navigation-active]`);
  return (layer ?? document).querySelector<T>(selector);
}
