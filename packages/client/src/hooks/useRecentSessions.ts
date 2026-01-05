import { useCallback, useSyncExternalStore } from "react";

const STORAGE_KEY = "recent-sessions";
const MAX_RECENT_SESSIONS = 20;

export interface RecentSessionEntry {
  sessionId: string;
  projectId: string;
  visitedAt: number;
}

// In-memory cache for SSR safety and performance
let cache: RecentSessionEntry[] | null = null;

function getRecentSessionsFromStorage(): RecentSessionEntry[] {
  if (cache !== null) return cache;
  if (typeof window === "undefined") return [];

  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      cache = JSON.parse(stored);
      return cache as RecentSessionEntry[];
    }
  } catch (e) {
    console.error("Failed to parse recent sessions:", e);
  }
  cache = [];
  return cache;
}

function setRecentSessionsToStorage(entries: RecentSessionEntry[]): void {
  cache = entries;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch (e) {
    console.error("Failed to save recent sessions:", e);
  }
  // Notify subscribers
  listeners.forEach((listener) => listener());
}

// External store pattern for useSyncExternalStore
type Listener = () => void;
const listeners = new Set<Listener>();

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): RecentSessionEntry[] {
  return getRecentSessionsFromStorage();
}

/**
 * Record a session visit. Updates the recent sessions list:
 * - If session exists, move to front with updated timestamp
 * - If new, add to front
 * - Trim to MAX_RECENT_SESSIONS
 *
 * This function can be called from outside React (e.g., in useEffect).
 */
export function recordSessionVisit(sessionId: string, projectId: string): void {
  const entries = getRecentSessionsFromStorage();

  // Remove existing entry if present
  const filtered = entries.filter((e) => e.sessionId !== sessionId);

  // Add to front with current timestamp
  const updated: RecentSessionEntry[] = [
    { sessionId, projectId, visitedAt: Date.now() },
    ...filtered,
  ].slice(0, MAX_RECENT_SESSIONS);

  setRecentSessionsToStorage(updated);
}

/**
 * Hook to access recent sessions list.
 * Updates reactively when sessions are visited.
 */
export function useRecentSessions(): {
  recentSessions: RecentSessionEntry[];
  recordVisit: (sessionId: string, projectId: string) => void;
  clearRecents: () => void;
} {
  const recentSessions = useSyncExternalStore(subscribe, getSnapshot);

  const recordVisit = useCallback((sessionId: string, projectId: string) => {
    recordSessionVisit(sessionId, projectId);
  }, []);

  const clearRecents = useCallback(() => {
    setRecentSessionsToStorage([]);
  }, []);

  return { recentSessions, recordVisit, clearRecents };
}
