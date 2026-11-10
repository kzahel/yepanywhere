import { refreshLruMap, type LruMap } from "../lib/lruCollections.js";
import type { ISessionReader } from "./types.js";

/** Reader LRU admission; retirement remains owned by the application. */
export function createSessionReaderAdmission(
  readerCache: LruMap<string, ISessionReader>,
  maxReaderCacheSize: number,
  closeReader: (key: string, reader: ISessionReader) => Promise<void>,
) {
  return <T extends ISessionReader>(key: string, factory: () => T): T => {
    const cached = readerCache.get(key);
    if (cached) {
      refreshLruMap(readerCache, key, cached);
      return cached as T;
    }

    const reader = factory();
    readerCache.set(key, reader);

    while (readerCache.size > maxReaderCacheSize) {
      const oldestKey = readerCache.keys().next().value;
      if (!oldestKey) break;
      const oldestReader = readerCache.get(oldestKey);
      readerCache.delete(oldestKey);
      if (oldestReader) void closeReader(oldestKey, oldestReader);
    }

    return reader;
  };
}
