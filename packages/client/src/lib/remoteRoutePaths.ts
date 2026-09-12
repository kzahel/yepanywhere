import { isValidRelayUsername } from "@yep-anywhere/shared";

import {
  isDirectAppRouteSegment,
  isReservedRemoteRouteSegment,
} from "./remoteRouteSegments";

export {
  isDirectAppRouteSegment,
  isReservedRemoteRouteSegment,
} from "./remoteRouteSegments";

export interface RemoteRouteLocationParts {
  pathname: string;
  search?: string;
  hash?: string;
}

export const RELAY_ROUTE_PREFIX = "/-/relay";

function isDirectAppRoutePath(pathname: string): boolean {
  if (pathname === "/") return true;
  const firstSegment = pathname.split("/")[1];
  return firstSegment ? isDirectAppRouteSegment(firstSegment) : false;
}

export function getRelayBasePath(relayUsername: string): string {
  return `${RELAY_ROUTE_PREFIX}/${encodeURIComponent(relayUsername)}`;
}

function formatRouteTarget(location: RemoteRouteLocationParts): string {
  return `${location.pathname}${location.search ?? ""}${location.hash ?? ""}`;
}

function parseSafeRouteTarget(
  target: string | null | undefined,
): RemoteRouteLocationParts | null {
  if (
    !target?.startsWith("/") ||
    target.startsWith("//") ||
    target.includes("\\")
  ) {
    return null;
  }

  try {
    const base = new URL("https://yep.invalid/");
    if (new URL(target, base).origin !== base.origin) return null;
  } catch {
    return null;
  }

  const hashIndex = target.indexOf("#");
  const beforeHash = hashIndex === -1 ? target : target.slice(0, hashIndex);
  const hash = hashIndex === -1 ? "" : target.slice(hashIndex);
  const searchIndex = beforeHash.indexOf("?");
  const pathname =
    searchIndex === -1 ? beforeHash : beforeHash.slice(0, searchIndex);
  const search = searchIndex === -1 ? "" : beforeHash.slice(searchIndex);

  return { pathname: pathname || "/", search, hash };
}

function getRelayRouteTarget(
  location: RemoteRouteLocationParts,
  relayUsername: string,
): string {
  const pathname = location.pathname === "/" ? "/projects" : location.pathname;
  return `${getRelayBasePath(relayUsername)}${pathname}${location.search ?? ""}${location.hash ?? ""}`;
}

function decodeRelayUsernameSegment(
  encodedSegment: string | undefined,
): string | null {
  if (!encodedSegment) return null;

  try {
    const relayUsername = decodeURIComponent(encodedSegment);
    return isValidRelayUsername(relayUsername) ? relayUsername : null;
  } catch {
    return null;
  }
}

function getLegacyRelayUsername(pathname: string): string | null {
  const relayUsername = decodeRelayUsernameSegment(pathname.split("/")[1]);
  return relayUsername && !isReservedRemoteRouteSegment(relayUsername)
    ? relayUsername
    : null;
}

export function getRelayUsernameFromRoute(pathname: string): string | null {
  const segments = pathname.split("/");
  if (segments[1] === "-" && segments[2] === "relay") {
    return decodeRelayUsernameSegment(segments[3]);
  }
  return getLegacyRelayUsername(pathname);
}

export function getLegacyRelayRedirectTarget(
  location: RemoteRouteLocationParts,
): string | null {
  const relayUsername = getLegacyRelayUsername(location.pathname);
  if (!relayUsername) return null;

  const suffixIndex = location.pathname.indexOf("/", 1);
  const suffix =
    suffixIndex === -1 || location.pathname.slice(suffixIndex) === "/"
      ? "/projects"
      : location.pathname.slice(suffixIndex);
  return getRelayRouteTarget({ ...location, pathname: suffix }, relayUsername);
}

export function getRelayCanonicalRedirectTarget(
  location: RemoteRouteLocationParts,
  relayUsername: string | null | undefined,
): string | null {
  if (!relayUsername) return null;

  const relayBasePath = getRelayBasePath(relayUsername);
  if (
    location.pathname === relayBasePath ||
    location.pathname.startsWith(`${relayBasePath}/`)
  ) {
    return null;
  }

  if (isDirectAppRoutePath(location.pathname)) {
    return getRelayRouteTarget(location, relayUsername);
  }

  const legacyTarget = getLegacyRelayRedirectTarget(location);
  return getLegacyRelayUsername(location.pathname) === relayUsername
    ? legacyTarget
    : null;
}

export function getSafeRemoteReturnTarget(
  returnTo: string | null | undefined,
  relayUsername: string | null | undefined,
): string | null {
  const target = parseSafeRouteTarget(returnTo);
  if (!target) return null;

  if (target.pathname === "/login" || target.pathname.startsWith("/login/")) {
    return null;
  }

  if (!relayUsername) {
    return isDirectAppRoutePath(target.pathname)
      ? formatRouteTarget(target)
      : null;
  }

  const canonicalTarget = getRelayCanonicalRedirectTarget(
    target,
    relayUsername,
  );
  if (canonicalTarget) return canonicalTarget;

  const relayBasePath = getRelayBasePath(relayUsername);
  const isActiveRelayTarget =
    target.pathname === relayBasePath ||
    target.pathname.startsWith(`${relayBasePath}/`);
  return isActiveRelayTarget ? formatRouteTarget(target) : null;
}

/** An explicit relay sign-in/handoff must not land in another active source. */
export function matchesRelayLoginTarget(
  location: RemoteRouteLocationParts,
  currentRelayUsername: string | null,
  currentUrl: string | null,
): boolean {
  if (location.pathname !== "/login/relay") return true;
  const params = new URLSearchParams(location.search);
  const username = params.get("u");
  const relayUrl = params.get("r");
  return (
    (!username || username === currentRelayUsername) &&
    (!relayUrl || relayUrl === currentUrl)
  );
}
