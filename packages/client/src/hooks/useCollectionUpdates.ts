import { useEffect, useRef } from "react";
import { SERVER_CAPABILITIES, serverHasCapability } from "@yep-anywhere/shared";
import { useRetainedVersionInfo } from "./useVersion";
import { retainCollectionUpdates } from "../lib/collectionUpdates";
import type { YaSourceRuntime } from "../lib/sourceRuntime";
import {
  ensureClientQuery,
  invalidateClientQuery,
  type ClientQueryRequestContext,
} from "../lib/clientQueryController";

/** COLLECTION_UPDATES_LEGACY_FALLBACK: without support, keep existing REST/events. */
export function useCollectionUpdates<T>(options: {
  runtime: YaSourceRuntime;
  key: string;
  path: string;
  rows?: number;
  enabled: boolean;
  applySnapshot(data: T, context: ClientQueryRequestContext): void;
  fallback(): void;
}) {
  const latest = useRef(options);
  latest.current = options;
  const supported = serverHasCapability(
    useRetainedVersionInfo(options.runtime.sourceKey),
    SERVER_CAPABILITIES.collectionQueryUpdates,
  );
  const { runtime, key, path, rows = 0, enabled } = options;
  useEffect(() => {
    if (!supported || !enabled) return;
    return retainCollectionUpdates(runtime, key, {
      path,
      rows,
      fallback: () => {
        if (
          latest.current.runtime === runtime &&
          latest.current.key === key &&
          latest.current.path === path
        )
          latest.current.fallback();
      },
      publish: async (body) => {
        if (
          latest.current.runtime !== runtime ||
          latest.current.key !== key ||
          latest.current.path !== path
        )
          return;
        const applySnapshot = latest.current.applySnapshot;
        invalidateClientQuery(runtime.sourceKey, key);
        await ensureClientQuery<T>({
          sourceKey: runtime.sourceKey,
          key,
          coverage: { minRows: rows },
          force: true,
          fetcher: async () => body as T,
          applySnapshot,
        });
      },
    });
  }, [runtime, key, path, rows, enabled, supported]);
}
