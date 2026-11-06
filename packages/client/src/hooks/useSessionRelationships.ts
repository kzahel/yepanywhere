import type {
  SessionRelationshipPage,
  SessionCatalogUpdatedEvent,
} from "@yep-anywhere/shared";
import { useCallback, useMemo, useSyncExternalStore } from "react";
import { createSessionRelationshipsApi } from "../api/sessionRelationshipsClient";
import { useCurrentSourceRuntime } from "../contexts/SourceRuntimeContext";
import { useOptionalRemoteConnection } from "../contexts/RemoteConnectionContext";
import {
  createClientQueryKey,
  invalidateClientQuery,
} from "../lib/clientQueryController";
import { isRemoteClient } from "../lib/connection";
import { useRetainedClientQuery } from "./useRetainedClientQuery";

interface Entry {
  page: SessionRelationshipPage | null;
  listeners: Set<() => void>;
  lifetime: AbortController;
}

// Only mounted query consumers retain page data. The last release invalidates
// controller coverage too, so a later consumer cannot accept a missing snapshot.
const entries = new Map<string, Entry>();
const EVENTS = [
  "refresh",
  "reconnect",
  "session-metadata-changed",
  "session-catalog-updated",
] as const;
const NO_EVENTS = [] as const;

/** One bounded page, acquired only while its relationship viewer is mounted. */
export function useSessionRelationships(
  projectId: string,
  sessionId: string,
  cursor?: string,
) {
  const runtime = useCurrentSourceRuntime();
  const { sourceKey } = runtime;
  const remote = useOptionalRemoteConnection();
  const ready = !isRemoteClient() || Boolean(remote?.connection);
  const api = useMemo(
    () =>
      createSessionRelationshipsApi(
        runtime.transport.fetch.bind(runtime.transport),
      ),
    [runtime],
  );
  const key = useMemo(
    () =>
      createClientQueryKey({
        endpoint: "session-relationships",
        projectId,
        sessionId,
        cursor: cursor ?? null,
      }),
    [projectId, sessionId, cursor],
  );
  const entryKey = JSON.stringify([sourceKey, key]);
  const subscribe = useCallback(
    (listener: () => void) => {
      let entry = entries.get(entryKey);
      if (!entry) {
        entry = {
          page: null,
          listeners: new Set(),
          lifetime: new AbortController(),
        };
        entries.set(entryKey, entry);
      }
      entry.listeners.add(listener);
      return () => {
        entry.listeners.delete(listener);
        if (entry.listeners.size || entries.get(entryKey) !== entry) return;
        entries.delete(entryKey);
        invalidateClientQuery(sourceKey, key);
        entry.lifetime.abort();
      };
    },
    [entryKey, key, sourceKey],
  );
  const snapshot = useCallback(
    () => entries.get(entryKey)?.page ?? null,
    [entryKey],
  );
  const page = useSyncExternalStore(subscribe, snapshot, () => null);
  const query = useRetainedClientQuery({
    sourceKey,
    key,
    ready,
    hasData: page !== null,
    // Page one follows accepted-fact notifications. Later pages deliberately
    // remain a keyset view until the user refreshes from the beginning.
    revalidateOn: cursor ? NO_EVENTS : EVENTS,
    shouldRevalidateEvent: (event) =>
      event.eventType !== "session-catalog-updated" ||
      (event.data as SessionCatalogUpdatedEvent | undefined)?.catalog
        ?.refreshing !== true,
    fetcher: async () => {
      const entry = entries.get(entryKey);
      if (!entry) throw new Error("Relationship viewer was released");
      return {
        page: await api.read(
          projectId,
          sessionId,
          cursor,
          entry.lifetime.signal,
        ),
        entry,
      };
    },
    applySnapshot: ({ page, entry }) => {
      if (entries.get(entryKey) !== entry) return;
      entry.page = page;
      for (const listener of entry.listeners) listener();
    },
  });
  return { page, ...query };
}
