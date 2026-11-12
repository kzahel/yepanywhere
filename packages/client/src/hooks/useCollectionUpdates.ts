import { useEffect, useRef, useState } from "react";
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
  capability?: string;
  applySnapshot(data: T, context: ClientQueryRequestContext): void;
  fallback(): void;
}) {
  const [status, setStatus] = useState<{
    runtime: YaSourceRuntime;
    key: string;
    path: string;
    live: boolean;
  }>();
  const latest = useRef(options);
  latest.current = options;
  const version = useRetainedVersionInfo(options.runtime.sourceKey);
  // COLLECTION_METADATA_FIELDS_FALLBACK: old servers retain complete metadata frames.
  const metadataFields = serverHasCapability(
    version,
    SERVER_CAPABILITIES.collectionMetadataFields,
  );
  const supported =
    options.runtime.transport.capabilities.streamedResponses === true &&
    serverHasCapability(
      version,
      options.capability ?? SERVER_CAPABILITIES.collectionQueryUpdates.name,
    );
  const { runtime, key, path, rows = 0, enabled } = options;
  useEffect(() => {
    if (!supported || !enabled) return;
    return retainCollectionUpdates(runtime, key, {
      path,
      rows,
      metadataFields,
      onLiveChange: (live) => {
        if (
          latest.current.runtime === runtime &&
          latest.current.key === key &&
          latest.current.path === path
        )
          setStatus({ runtime, key, path, live });
      },
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
  }, [runtime, key, path, rows, enabled, supported, metadataFields]);
  return (
    supported &&
    enabled &&
    status?.runtime === runtime &&
    status.key === key &&
    status.path === path &&
    status.live
  );
}
