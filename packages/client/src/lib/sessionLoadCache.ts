import { api, type PaginationInfo } from "../api/client";
import type { Message, Session, SessionStatus } from "../types";

export interface SessionLoadCacheEntry {
  session: Session;
  messages: Message[];
  ownership: SessionStatus;
  pendingInputRequest?: unknown;
  slashCommands?: Array<{
    name: string;
    description: string;
    argumentHint?: string;
  }> | null;
  pagination?: PaginationInfo;
}

const sessionLoadCache = new Map<string, SessionLoadCacheEntry>();
const sessionLoadInflight = new Map<string, Promise<SessionLoadCacheEntry>>();
const SESSION_LOAD_STORAGE_PREFIX = "yep-anywhere-session-load-";
const SESSION_LOAD_STORAGE_INDEX = `${SESSION_LOAD_STORAGE_PREFIX}keys`;
const MAX_PERSISTED_SESSION_LOADS = 8;
const MAX_PERSISTED_SESSION_LOAD_SIZE = 400_000;

function getSessionLoadCacheKey(projectId: string, sessionId: string): string {
  return `${projectId}::${sessionId}`;
}

function cloneEntry(entry: SessionLoadCacheEntry): SessionLoadCacheEntry {
  return structuredClone(entry);
}

function getStorageKey(cacheKey: string): string {
  return `${SESSION_LOAD_STORAGE_PREFIX}${cacheKey}`;
}

function persistSessionLoad(cacheKey: string, entry: SessionLoadCacheEntry): void {
  if (typeof window === "undefined" || typeof localStorage?.setItem !== "function") {
    return;
  }

  try {
    const serialized = JSON.stringify(entry);
    if (serialized.length > MAX_PERSISTED_SESSION_LOAD_SIZE) {
      return;
    }

    localStorage.setItem(getStorageKey(cacheKey), serialized);

    const rawIndex = localStorage.getItem(SESSION_LOAD_STORAGE_INDEX);
    const existingIndex = rawIndex ? (JSON.parse(rawIndex) as string[]) : [];
    const nextIndex = [cacheKey, ...existingIndex.filter((key) => key !== cacheKey)].slice(
      0,
      MAX_PERSISTED_SESSION_LOADS,
    );
    localStorage.setItem(SESSION_LOAD_STORAGE_INDEX, JSON.stringify(nextIndex));

    for (const staleKey of existingIndex.slice(MAX_PERSISTED_SESSION_LOADS - 1)) {
      if (!nextIndex.includes(staleKey)) {
        localStorage.removeItem(getStorageKey(staleKey));
      }
    }
  } catch {
    // Ignore storage failures.
  }
}

function readPersistedSessionLoad(cacheKey: string): SessionLoadCacheEntry | null {
  if (typeof window === "undefined" || typeof localStorage?.getItem !== "function") {
    return null;
  }

  try {
    const raw = localStorage.getItem(getStorageKey(cacheKey));
    if (!raw) {
      return null;
    }
    return JSON.parse(raw) as SessionLoadCacheEntry;
  } catch {
    return null;
  }
}

export function getCachedSessionLoad(
  projectId: string,
  sessionId: string,
): SessionLoadCacheEntry | null {
  const cacheKey = getSessionLoadCacheKey(projectId, sessionId);
  const cached = sessionLoadCache.get(cacheKey);
  if (cached) {
    return cloneEntry(cached);
  }

  const persisted = readPersistedSessionLoad(cacheKey);
  if (persisted) {
    sessionLoadCache.set(cacheKey, persisted);
    return cloneEntry(persisted);
  }

  return null;
}

export function getInflightSessionLoad(
  projectId: string,
  sessionId: string,
): Promise<SessionLoadCacheEntry> | null {
  return (
    sessionLoadInflight.get(getSessionLoadCacheKey(projectId, sessionId)) ??
    null
  );
}

export function primeSessionLoadCache(
  projectId: string,
  sessionId: string,
  entry: SessionLoadCacheEntry,
): void {
  const cacheKey = getSessionLoadCacheKey(projectId, sessionId);
  sessionLoadCache.set(cacheKey, entry);
  persistSessionLoad(cacheKey, entry);
}

export async function prefetchSessionLoad(
  projectId: string,
  sessionId: string,
): Promise<SessionLoadCacheEntry> {
  const cached = getCachedSessionLoad(projectId, sessionId);
  if (cached) {
    return cached;
  }

  const cacheKey = getSessionLoadCacheKey(projectId, sessionId);
  const inflight = sessionLoadInflight.get(cacheKey);
  if (inflight) {
    return cloneEntry(await inflight);
  }

  const request = api
    .getSession(projectId, sessionId, undefined, {
      tailCompactions: 1,
      maxMessages: 300,
    })
    .then((result) => {
      const entry: SessionLoadCacheEntry = {
        session: result.session,
        messages: result.messages,
        ownership: result.ownership,
        pendingInputRequest: result.pendingInputRequest,
        slashCommands: result.slashCommands,
        pagination: result.pagination,
      };
      primeSessionLoadCache(projectId, sessionId, entry);
      return entry;
    })
    .finally(() => {
      if (sessionLoadInflight.get(cacheKey) === request) {
        sessionLoadInflight.delete(cacheKey);
      }
    });

  sessionLoadInflight.set(cacheKey, request);
  return cloneEntry(await request);
}
