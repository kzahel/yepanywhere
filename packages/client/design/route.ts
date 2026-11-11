import { useSyncExternalStore } from "react";
import { DESIGN_THEMES, type DesignTheme } from "./specimen";
import {
  AUDIT_SECTIONS,
  legacyAuditSection,
  type AuditSection,
} from "./audit/routes";

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
  section?: AuditSection;
}

function parse(hash: string): DesignRoute {
  const [path = "", query = ""] = hash.replace(/^#\/?/, "").split("?");
  const params = new URLSearchParams(query);
  const theme = params.get("theme");
  const target = decodeURIComponent(path);
  const legacy = legacyAuditSection(target);
  const section = AUDIT_SECTIONS.find(
    (section) => section === params.get("section"),
  );
  return {
    target: legacy ? "audit" : target,
    iso: target === "audit" || legacy ? false : params.has("iso"),
    phone: params.has("phone"),
    theme: DESIGN_THEMES.find((candidate) => candidate === theme),
    section: legacy ?? section,
  };
}

export function routeHref(
  target: string,
  options: {
    iso?: boolean;
    phone?: boolean;
    theme?: DesignTheme;
    section?: AuditSection;
  } = {},
): string {
  const params = new URLSearchParams();
  if (options.iso) params.set("iso", "");
  if (options.phone) params.set("phone", "");
  if (options.theme) params.set("theme", options.theme);
  if (options.section) params.set("section", options.section);
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
