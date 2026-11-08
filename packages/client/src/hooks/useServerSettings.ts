import {
  type ServerSettingsSnapshot,
  type ServerSettingsResponse,
  EMPTY_SERVER_SETTINGS_SNAPSHOT,
  SERVER_SETTINGS_QUERY_KEY,
  subscribeServerSettingsSnapshots,
  getServerSettingsSnapshot,
  acceptServerSettingsSnapshot,
  nextMutationObservedAt,
  applySettingsQuerySnapshot,
} from "../lib/serverSettingsQuery";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import type { ServerSettings } from "../api/client";
import {
  connectionImpactOf,
  withImpactConfirmation,
} from "../api/connectionImpact";
import type { NewSessionDefaults } from "@yep-anywhere/shared";
import { useOptionalRemoteConnection } from "../contexts/RemoteConnectionContext";
import {
  ensureClientQuery,
  type ClientQueryRequestContext,
} from "../lib/clientQueryController";
import {
  type ClientSummarySourceKey,
  LOCAL_CLIENT_SUMMARY_SOURCE_KEY,
  REMOTE_NONE_CLIENT_SUMMARY_SOURCE_KEY,
  useClientSummarySourceKey,
} from "../lib/clientSummaryStore";
import { isRemoteClient } from "../lib/connection";
import { isConnectionReconnectingError } from "../lib/connection/types";
import { getSourceRuntimeRegistry } from "../lib/sourceRuntime";
import { useRetainedClientQuery } from "./useRetainedClientQuery";

interface UseServerSettingsResult {
  settings: ServerSettings | null;
  displayDefaults: NewSessionDefaults | undefined;
  isLoading: boolean;
  error: string | null;
  /**
   * Resolves with the settings the server accepted, once they are applied.
   * `confirmedConnectionImpact` repeats a write the server refused as
   * disconnecting this client (topics/connection-safe-settings.md).
   */
  updateSettings: (
    updates: Partial<ServerSettings>,
    options?: { confirmedConnectionImpact?: boolean },
  ) => Promise<ServerSettings>;
  updateSetting: <K extends keyof ServerSettings>(
    key: K,
    value: ServerSettings[K],
  ) => Promise<void>;
  refetch: () => Promise<void>;
}

const SERVER_SETTINGS_REVALIDATE_EVENTS = ["refresh", "reconnect"] as const;

function getSourceTransport(sourceKey: ClientSummarySourceKey) {
  return getSourceRuntimeRegistry().getOrCreateSourceRuntime(sourceKey)
    .transport;
}

function fetchServerSettingsForSource(
  sourceKey: ClientSummarySourceKey,
): Promise<ServerSettingsResponse> {
  return getSourceTransport(sourceKey).fetch<ServerSettingsResponse>(
    "/settings",
  );
}

async function fetchSettingsQuery(context: ClientQueryRequestContext) {
  try {
    return await fetchServerSettingsForSource(context.sourceKey);
  } catch (err) {
    if (!isConnectionReconnectingError(err)) {
      console.error("[useServerSettings] Failed to fetch settings:", err);
    }
    throw err;
  }
}

/** Local entrypoint hint; mounted consumers join the same source-owned read. */
export async function primeLocalServerSettings() {
  await ensureClientQuery({
    sourceKey: LOCAL_CLIENT_SUMMARY_SOURCE_KEY,
    key: SERVER_SETTINGS_QUERY_KEY,
    fetcher: fetchSettingsQuery,
    applySnapshot: applySettingsQuerySnapshot,
  });
  return getServerSettingsSnapshot(LOCAL_CLIENT_SUMMARY_SOURCE_KEY).settings;
}

function updateServerSettingsForSource(
  sourceKey: ClientSummarySourceKey,
  updates: Partial<ServerSettings>,
  confirmedConnectionImpact: boolean,
): Promise<ServerSettingsResponse> {
  return getSourceTransport(sourceKey).fetch<ServerSettingsResponse>(
    withImpactConfirmation("/settings", confirmedConnectionImpact),
    {
      method: "PUT",
      body: JSON.stringify(updates, (_key, value) =>
        value === undefined ? null : value,
      ),
    },
  );
}

function useServerSettingsSnapshot(
  sourceKey: ClientSummarySourceKey,
): ServerSettingsSnapshot {
  return useSyncExternalStore(
    subscribeServerSettingsSnapshots,
    () => getServerSettingsSnapshot(sourceKey),
    () => EMPTY_SERVER_SETTINGS_SNAPSHOT,
  );
}

export { resetServerSettingsForTests } from "../lib/serverSettingsQuery";

/**
 * Hook for managing server-wide settings.
 * Fetches settings through the retained query controller and provides update
 * functionality.
 */
export function useServerSettings(): UseServerSettingsResult {
  const sourceKey = useClientSummarySourceKey();
  const remoteConnection = useOptionalRemoteConnection();
  const hasResolvedRemoteSource =
    sourceKey !== LOCAL_CLIENT_SUMMARY_SOURCE_KEY &&
    sourceKey !== REMOTE_NONE_CLIENT_SUMMARY_SOURCE_KEY;
  const ready =
    !isRemoteClient() ||
    (remoteConnection !== null &&
      remoteConnection.connection !== null &&
      hasResolvedRemoteSource);
  const snapshot = useServerSettingsSnapshot(sourceKey);
  const [mutationError, setMutationError] = useState<string | null>(null);

  const {
    loading,
    error: queryError,
    refetch,
  } = useRetainedClientQuery({
    sourceKey,
    key: SERVER_SETTINGS_QUERY_KEY,
    bootstrapTier: "route",
    ready,
    hasData: snapshot.observedAt !== undefined,
    revalidateOn: SERVER_SETTINGS_REVALIDATE_EVENTS,
    fetcher: fetchSettingsQuery,
    applySnapshot: applySettingsQuerySnapshot,
  });

  useEffect(() => {
    if (snapshot.observedAt !== undefined) {
      setMutationError(null);
    }
  }, [snapshot.observedAt]);

  const updateSettings = useCallback(
    async (
      updates: Partial<ServerSettings>,
      options?: { confirmedConnectionImpact?: boolean },
    ): Promise<ServerSettings> => {
      const requestSourceKey = sourceKey;
      try {
        setMutationError(null);
        const response = await updateServerSettingsForSource(
          requestSourceKey,
          updates,
          options?.confirmedConnectionImpact === true,
        );
        acceptServerSettingsSnapshot(
          requestSourceKey,
          response.settings,
          nextMutationObservedAt(requestSourceKey),
        );
        return response.settings;
      } catch (err) {
        // A disconnect refusal awaits the user's confirmation, not an error.
        if (connectionImpactOf(err)) throw err;
        console.error("[useServerSettings] Failed to update settings:", err);
        setMutationError(
          err instanceof Error ? err.message : "Failed to update settings",
        );
        throw err;
      }
    },
    [sourceKey],
  );

  const updateSetting = useCallback(
    async <K extends keyof ServerSettings>(
      key: K,
      value: ServerSettings[K],
    ): Promise<void> => {
      await updateSettings({ [key]: value });
    },
    [updateSettings],
  );

  const queryErrorMessage = queryError?.message ?? null;

  return {
    settings: snapshot.settings,
    displayDefaults: snapshot.displayDefaults,
    isLoading: loading,
    error:
      mutationError ??
      (isConnectionReconnectingError(queryError) ? null : queryErrorMessage),
    updateSettings,
    updateSetting,
    refetch: async () => {
      await refetch();
    },
  };
}
