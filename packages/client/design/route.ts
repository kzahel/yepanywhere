import { useSyncExternalStore } from "react";
import { DESIGN_THEMES, type DesignTheme } from "./specimen";

/**
 * Playground location, kept in the hash so the dev server's one HTML entry
 * serves every page:
 *
 *   #/                                  index
 *   #/<specimen-id>                     every state across themes
 *   #/<state-id>                        one state across themes
 *   #/<state-id>?iso&theme=light        chromeless, for capture
 *
 * `theme=<name>` limits a grid to one theme; `phone` renders grid cells in
 * 375 px frames so media queries respond as they would on a phone.
 */
export interface DesignRoute {
  target: string;
  iso: boolean;
  phone: boolean;
  theme: DesignTheme | undefined;
}

function parse(hash: string): DesignRoute {
  const [path = "", query = ""] = hash.replace(/^#\/?/, "").split("?");
  const params = new URLSearchParams(query);
  const theme = params.get("theme");
  return {
    target: decodeURIComponent(path),
    iso: params.has("iso"),
    phone: params.has("phone"),
    theme: DESIGN_THEMES.find((candidate) => candidate === theme),
  };
}

export function routeHref(
  target: string,
  options: { iso?: boolean; phone?: boolean; theme?: DesignTheme } = {},
): string {
  const params = new URLSearchParams();
  if (options.iso) params.set("iso", "");
  if (options.phone) params.set("phone", "");
  if (options.theme) params.set("theme", options.theme);
  const query = params.toString().replace(/=(?=&|$)/g, "");
  return `#/${target}${query ? `?${query}` : ""}`;
}

/**
 * A link that keeps the page's view settings (theme filter and width), so
 * the choice made once in the sidebar holds while navigating.
 */
export function viewHref(target: string, route: DesignRoute): string {
  return routeHref(target, { theme: route.theme, phone: route.phone });
}

function subscribe(onChange: () => void) {
  window.addEventListener("hashchange", onChange);
  return () => window.removeEventListener("hashchange", onChange);
}

const getHash = () => window.location.hash;

export function useDesignRoute(): DesignRoute {
  return parse(useSyncExternalStore(subscribe, getHash));
}
