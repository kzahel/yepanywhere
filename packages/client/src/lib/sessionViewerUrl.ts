import { isYaSessionId } from "@yep-anywhere/shared";

const YA_ID_PARAM = "yaSessionId";

/** Native IDs label viewer URLs; the retained YA ID addresses all resources. */
export function viewerYaSessionId(pathId: string, search: string): string {
  const id = new URLSearchParams(search).get(YA_ID_PARAM);
  return isYaSessionId(id) ? id : pathId;
}

export function sessionViewerSearch(search: string): string {
  const value = search
    .replace(/^\?/, "")
    .split("&")
    .filter((part) => !new URLSearchParams(part).has(YA_ID_PARAM))
    .join("&");
  return value ? `?${value}` : "";
}

export function nativeSessionViewerUrl(
  pathname: string,
  search: string,
  hash: string,
  yaId: string,
  nativeId: string,
): string | undefined {
  if (nativeId === yaId) return;
  const match = pathname.match(/^(.*\/sessions\/)([^/]+)(\/?)$/);
  if (
    !match ||
    viewerYaSessionId(decodeURIComponent(match[2]!), search) !== yaId
  )
    return;
  const rest = sessionViewerSearch(search);
  return `${match[1]}${encodeURIComponent(nativeId)}${match[3]}${rest}${rest ? "&" : "?"}${YA_ID_PARAM}=${encodeURIComponent(yaId)}${hash}`;
}
