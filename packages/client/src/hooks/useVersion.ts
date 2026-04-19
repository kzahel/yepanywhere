import { useCallback, useEffect, useState } from "react";
import { type VersionInfo, api } from "../api/client";

interface UseVersionOptions {
  /** Request a fresh update check on initial mount. */
  freshOnMount?: boolean;
}

interface VersionStoreState {
  version: VersionInfo | null;
  loading: boolean;
  error: Error | null;
}

const versionStoreListeners = new Set<() => void>();
let versionStoreState: VersionStoreState = {
  version: null,
  loading: false,
  error: null,
};
let versionRequestInFlight: Promise<VersionInfo> | null = null;

function emitVersionStore(): void {
  for (const listener of versionStoreListeners) {
    listener();
  }
}

function subscribeVersionStore(listener: () => void): () => void {
  versionStoreListeners.add(listener);
  return () => {
    versionStoreListeners.delete(listener);
  };
}

function getVersionStoreSnapshot(): VersionStoreState {
  return versionStoreState;
}

async function fetchSharedVersion(fresh = false): Promise<VersionInfo> {
  if (!fresh && versionStoreState.version) {
    return versionStoreState.version;
  }

  if (versionRequestInFlight && (!fresh || !versionStoreState.version)) {
    return versionRequestInFlight;
  }

  versionStoreState = {
    ...versionStoreState,
    loading: true,
    error: null,
  };
  emitVersionStore();

  const request = api.getVersion({ fresh });
  versionRequestInFlight = request;

  try {
    const data = await request;
    versionStoreState = {
      version: data,
      loading: false,
      error: null,
    };
    emitVersionStore();
    return data;
  } catch (err) {
    versionStoreState = {
      ...versionStoreState,
      loading: false,
      error: err instanceof Error ? err : new Error(String(err)),
    };
    emitVersionStore();
    throw err;
  } finally {
    if (versionRequestInFlight === request) {
      versionRequestInFlight = null;
    }
  }
}

/**
 * Hook to fetch and cache server version info.
 *
 * Returns:
 * - version: Version info (current, latest, updateAvailable, optional capabilities)
 * - loading: Whether the fetch is in progress
 * - error: Any error that occurred during fetch
 * - refetch: Function to manually refresh version info
 */
export function useVersion(options?: UseVersionOptions) {
  const [state, setState] = useState<VersionStoreState>(() =>
    getVersionStoreSnapshot(),
  );

  useEffect(() => {
    return subscribeVersionStore(() => {
      setState(getVersionStoreSnapshot());
    });
  }, []);

  useEffect(() => {
    if (options?.freshOnMount) {
      void fetchSharedVersion(true);
      return;
    }

    if (!versionStoreState.version && !versionStoreState.loading) {
      void fetchSharedVersion(false);
    }
  }, [options?.freshOnMount]);

  const refetch = useCallback(() => fetchSharedVersion(false), []);
  const refetchFresh = useCallback(() => fetchSharedVersion(true), []);

  return {
    version: state.version,
    loading: state.loading,
    error: state.error,
    refetch,
    refetchFresh,
  };
}
