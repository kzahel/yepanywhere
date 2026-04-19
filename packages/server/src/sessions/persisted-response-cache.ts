import type { UrlProjectId } from "@yep-anywhere/shared";
import type { Session } from "../supervisor/types.js";
import type { PaginationInfo } from "./pagination.js";

export interface PersistedSessionResponsePayload {
  session: Session;
  messages: Session["messages"];
  pagination?: PaginationInfo;
}

export interface PersistedSessionResponseCacheKeyParams {
  projectId: UrlProjectId;
  sessionId: string;
  provider: string | undefined;
  updatedAt: string;
  messageCount: number;
  tailCompactions?: number;
  beforeMessageId?: string;
  maxMessages?: number;
}

const MAX_CACHE_ENTRIES = 100;
const responseCache = new Map<string, PersistedSessionResponsePayload>();
const inFlightCache = new Map<
  string,
  Promise<PersistedSessionResponsePayload>
>();

function trimCache(): void {
  while (responseCache.size > MAX_CACHE_ENTRIES) {
    const oldestKey = responseCache.keys().next().value;
    if (!oldestKey) break;
    responseCache.delete(oldestKey);
  }
}

function clonePayload(
  payload: PersistedSessionResponsePayload,
): PersistedSessionResponsePayload {
  return structuredClone(payload);
}

export function buildPersistedSessionResponseCacheKey(
  params: PersistedSessionResponseCacheKeyParams,
): string {
  return [
    params.projectId,
    params.sessionId,
    params.provider ?? "unknown",
    params.updatedAt,
    String(params.messageCount),
    String(params.tailCompactions ?? ""),
    params.beforeMessageId ?? "",
    String(params.maxMessages ?? ""),
  ].join("::");
}

export function getPersistedSessionResponse(
  cacheKey: string,
): PersistedSessionResponsePayload | null {
  const cached = responseCache.get(cacheKey);
  return cached ? clonePayload(cached) : null;
}

export function primePersistedSessionResponse(
  cacheKey: string,
  payload: PersistedSessionResponsePayload,
): void {
  responseCache.set(cacheKey, clonePayload(payload));
  trimCache();
}

export async function getOrLoadPersistedSessionResponse(
  cacheKey: string,
  loader: () => Promise<PersistedSessionResponsePayload>,
): Promise<PersistedSessionResponsePayload> {
  const cached = responseCache.get(cacheKey);
  if (cached) {
    return clonePayload(cached);
  }

  const inFlight = inFlightCache.get(cacheKey);
  if (inFlight) {
    return clonePayload(await inFlight);
  }

  const loadPromise = (async () => {
    const payload = await loader();
    responseCache.set(cacheKey, clonePayload(payload));
    trimCache();
    return payload;
  })();

  inFlightCache.set(cacheKey, loadPromise);
  try {
    return clonePayload(await loadPromise);
  } finally {
    if (inFlightCache.get(cacheKey) === loadPromise) {
      inFlightCache.delete(cacheKey);
    }
  }
}
