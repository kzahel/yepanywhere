import {
  type AppSessionSummary,
  NATIVE_SESSION_FAMILIES,
  isYaSessionId,
} from "@yep-anywhere/shared";
import { useSyncExternalStore } from "react";

/** Legacy native viewer form: `/sessions/<native>?yaSessionId=<ya>`. */
const YA_ID_PARAM = "yaSessionId";

/**
 * A session viewer address, `/projects/P/sessions/<ya id>` or the native form
 * `/projects/P/sessions/<family>/<native id>`, under any base path.
 */
const SESSION_PATH =
  /^(.*\/projects\/([^/]+)\/sessions\/)([^/]+)(?:\/([^/]+))?(\/?)$/;

const nativeViewerSessions = new Map<string, string>();
const nativeViewerKey = (projectId: string, family: string, id: string) =>
  JSON.stringify([projectId, family, id]);
let nativeViewerVersion = 0;
const nativeViewerListeners = new Set<() => void>();

/** Changes when a native path resolves, so memoized route reads recompute. */
export function useNativeViewerVersion(): number {
  return useSyncExternalStore(
    (listener) => {
      nativeViewerListeners.add(listener);
      return () => nativeViewerListeners.delete(listener);
    },
    () => nativeViewerVersion,
  );
}

/**
 * Record which YA session a native viewer path names, so replacing the URL
 * keeps the mounted session and later reads need no server round trip.
 */
export function rememberNativeViewerSession(
  projectId: string,
  family: string,
  nativeId: string,
  yaId: string,
): void {
  const key = nativeViewerKey(projectId, family, nativeId);
  if (nativeViewerSessions.get(key) === yaId) return;
  nativeViewerSessions.set(key, yaId);
  nativeViewerVersion++;
  for (const listener of nativeViewerListeners) listener();
}

export interface SessionViewerPath {
  projectId: string;
  /** The YA resource id; undefined while a native path is unresolved. */
  sessionId: string | undefined;
  native?: { family: string; id: string };
  /** The same address by YA id, without the legacy query; set when resolved. */
  resourcePathname?: string;
}

function isNativeFamily(value: string): boolean {
  return (NATIVE_SESSION_FAMILIES as readonly string[]).includes(value);
}

export function readSessionViewerPath(
  pathname: string,
  search: string,
): SessionViewerPath | null {
  const match = pathname.match(SESSION_PATH);
  if (!match) return null;
  const [, prefix, rawProject, first, second, slash] = match as unknown as [
    string,
    string,
    string,
    string,
    string | undefined,
    string,
  ];
  const projectId = decodeURIComponent(rawProject);
  const resource = (sessionId: string | undefined) =>
    sessionId === undefined
      ? undefined
      : `${prefix}${encodeURIComponent(sessionId)}${slash}`;
  if (second === undefined) {
    const sessionId = viewerYaSessionId(decodeURIComponent(first), search);
    return { projectId, sessionId, resourcePathname: resource(sessionId) };
  }
  if (!isNativeFamily(first)) return null;
  const native = { family: first, id: decodeURIComponent(second) };
  const sessionId = nativeViewerSessions.get(
    nativeViewerKey(projectId, native.family, native.id),
  );
  return {
    projectId,
    sessionId,
    native,
    resourcePathname: resource(sessionId),
  };
}

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

/** Compare the resource being viewed across native-label history replacement. */
export function sessionViewerResourceHref(href: string): string {
  const url = new URL(href);
  const viewer = readSessionViewerPath(url.pathname, url.search);
  if (!viewer?.resourcePathname) return url.href;
  url.pathname = viewer.resourcePathname;
  url.search = sessionViewerSearch(url.search);
  return url.href;
}

/**
 * The native-facing address for the session at `pathname`, or undefined when
 * it is already shown or the path is another session's. With a family (servers
 * that resolve native paths) it is `/sessions/<family>/<native id>`; without,
 * the legacy query form that keeps the YA id.
 */
export function nativeSessionViewerUrl(
  pathname: string,
  search: string,
  hash: string,
  yaId: string,
  nativeId: string,
  family?: string,
): string | undefined {
  if (nativeId === yaId) return;
  const viewer = readSessionViewerPath(pathname, search);
  const match = pathname.match(SESSION_PATH);
  if (!viewer || !match || viewer.sessionId !== yaId) return;
  const prefix = match[1]!;
  const slash = match[5]!;
  const rest = sessionViewerSearch(search);
  let target: string;
  if (family && isNativeFamily(family)) {
    rememberNativeViewerSession(viewer.projectId, family, nativeId, yaId);
    target = `${prefix}${family}/${encodeURIComponent(nativeId)}${slash}${rest}${hash}`;
  } else {
    target = `${prefix}${encodeURIComponent(nativeId)}${slash}${rest}${rest ? "&" : "?"}${YA_ID_PARAM}=${encodeURIComponent(yaId)}${hash}`;
  }
  return target === `${pathname}${search}${hash}` ? undefined : target;
}

type NativeViewerFields = Pick<
  AppSessionSummary,
  "nativeSessionId" | "nativeSessionFamily"
>;

/** The viewer fields `source` carries, or none when it names no native id. */
export function pickNativeViewerFields(
  source: NativeViewerFields,
): NativeViewerFields {
  return source.nativeSessionId === undefined
    ? {}
    : {
        nativeSessionId: source.nativeSessionId,
        nativeSessionFamily: source.nativeSessionFamily,
      };
}
