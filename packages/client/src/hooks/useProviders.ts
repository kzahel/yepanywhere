import {
  acquireProviders,
  acquireProviderRow,
  getProviderCache,
  getProviderRequestSequence,
  subscribeProviderCatalog,
  subscribeProviderRow,
  getInitialProviderState,
  getInitialProviderRowState,
  readCachedProviderRowEntry,
  type ProviderHookState,
  type ProviderRowHookState,
  type ProviderCatalogListener,
  type ProviderRowListener,
} from "../lib/providerQuery";
import {
  ALL_PROVIDERS,
  DEFAULT_PROVIDER,
  type ProviderInfo,
  type ProviderName,
} from "@yep-anywhere/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api/client";
import { acquireClientQueryBootstrapSlot } from "../lib/clientQueryBootstrap";
import {
  getCurrentClientSummarySourceKey,
  LOCAL_CLIENT_SUMMARY_SOURCE_KEY,
  type ClientSummarySourceKey,
  useClientSummarySourceKey,
} from "../lib/clientSummaryStore";
import { primeLocalServerSettings } from "./useServerSettings";

function loadProviders(
  sourceKey: ClientSummarySourceKey,
  forceRefresh: boolean,
  bypassClientCache = false,
) {
  return acquireProviders(
    sourceKey,
    (options) => api.getProviders(options),
    forceRefresh,
    bypassClientCache,
  );
}

function loadProviderRow(
  sourceKey: ClientSummarySourceKey,
  providerName: ProviderName,
  forceRefresh: boolean,
  supersedeBeforeSequence = 0,
) {
  return acquireProviderRow(
    sourceKey,
    providerName,
    (options) => api.getProvider(providerName, options),
    forceRefresh,
    supersedeBeforeSequence,
  );
}

/**
 * Populate the shared provider/model cache before a consumer needs it.
 *
 * This uses the same request and in-flight deduplication as `useProviders`, so
 * a new-session form mounted during the primer joins the request rather than
 * starting another provider probe.
 */
export function primeProviderCache(
  sourceKey = getCurrentClientSummarySourceKey(),
): Promise<ProviderInfo[]> {
  return loadProviders(sourceKey, false);
}

/** Start the standing local choice while page code loads, using current settings. */
export async function primeLocalNewSessionProvider(
  preferredProvider: string | null,
) {
  const settings = await primeLocalServerSettings();
  if (!settings) return;
  const provider =
    ALL_PROVIDERS.find((name) => name === preferredProvider) ??
    settings.newSessionDefaults?.provider ??
    DEFAULT_PROVIDER;
  return loadProviderRow(LOCAL_CLIENT_SUMMARY_SOURCE_KEY, provider, false);
}

/**
 * Hook to fetch and cache available AI providers with their auth status.
 *
 * Returns:
 * - providers: Array of provider info objects
 * - loading: Whether the initial fetch is in progress
 * - error: Any error that occurred during fetch
 * - refetch: Function to manually refresh provider status
 */
export function useProviders() {
  const sourceKey = useClientSummarySourceKey();
  const [state, setState] = useState<ProviderHookState>(() =>
    getInitialProviderState(sourceKey),
  );
  const lastFetchedSourceRef = useRef<ClientSummarySourceKey | null>(null);
  const fetchSequenceRef = useRef(0);

  const fetch = useCallback(
    async (forceRefresh = false, bypassClientCache = false) => {
      const fetchSequence = ++fetchSequenceRef.current;
      const providerCache = getProviderCache(sourceKey);
      if (
        forceRefresh ||
        bypassClientCache ||
        !providerCache ||
        providerCache.stale
      ) {
        setState((current) => ({
          ...(current.sourceKey === sourceKey
            ? current
            : getInitialProviderState(sourceKey)),
          loading: true,
        }));
      }
      setState((current) => ({
        ...(current.sourceKey === sourceKey
          ? current
          : getInitialProviderState(sourceKey)),
        error: null,
      }));
      try {
        const nextProviders = await loadProviders(
          sourceKey,
          forceRefresh,
          bypassClientCache,
        );
        if (fetchSequence !== fetchSequenceRef.current) return;
        setState({
          sourceKey,
          providers: nextProviders,
          loading: false,
          stale: false,
          error: null,
        });
      } catch (err) {
        if (fetchSequence !== fetchSequenceRef.current) return;
        setState((current) => ({
          ...(current.sourceKey === sourceKey
            ? current
            : getInitialProviderState(sourceKey)),
          error: err instanceof Error ? err : new Error(String(err)),
        }));
      } finally {
        if (fetchSequence === fetchSequenceRef.current) {
          setState((current) =>
            current.sourceKey === sourceKey
              ? { ...current, loading: false }
              : current,
          );
        }
      }
    },
    [sourceKey],
  );

  useEffect(() => {
    const listener: ProviderCatalogListener = (entry) => {
      setState({
        sourceKey,
        providers: entry.providers,
        loading: false,
        stale: false,
        error: null,
      });
    };
    return subscribeProviderCatalog(sourceKey, listener);
  }, [sourceKey]);

  // Fetch once per source transition (the cache handles remounts and expiry).
  useEffect(() => {
    if (lastFetchedSourceRef.current === sourceKey) return;
    lastFetchedSourceRef.current = sourceKey;
    fetch();
  }, [fetch, sourceKey]);

  const refetch = useCallback(() => fetch(true), [fetch]);
  const reload = useCallback(() => fetch(false, true), [fetch]);
  const visibleState =
    state.sourceKey === sourceKey ? state : getInitialProviderState(sourceKey);

  const catalog = getProviderCache(sourceKey);
  const catalogLoaded =
    catalog?.providers === visibleState.providers && !catalog.stale;
  return { ...visibleState, catalogLoaded, refetch, reload };
}

export interface UseProviderRowOptions {
  /** Require a named probe started after this selection became current. */
  forceRefreshOnMount?: boolean;
}

/**
 * Resolve one provider's own status and models, independent of the aggregate.
 *
 * The display row and its authority are separate: a caller may keep showing a
 * retained row while `fresh` is false and a current named probe is running or
 * failed. Initial acquisition participates in the route bootstrap tier; direct
 * retries never wait for that startup gate.
 */
export function useProviderRow(
  providerName: ProviderName | null | undefined,
  options: UseProviderRowOptions = {},
) {
  const sourceKey = useClientSummarySourceKey();
  const normalizedProvider = providerName ?? null;
  const forceRefreshOnMount = options.forceRefreshOnMount === true;
  const [state, setState] = useState<ProviderRowHookState>(() =>
    getInitialProviderRowState(
      sourceKey,
      normalizedProvider,
      forceRefreshOnMount,
    ),
  );
  const requestSequenceRef = useRef(0);
  const acceptedRequestSequenceRef = useRef(
    normalizedProvider
      ? (readCachedProviderRowEntry(sourceKey, normalizedProvider)
          ?.requestSequence ?? 0)
      : 0,
  );

  const fetch = useCallback(
    async (forceRefresh: boolean, supersedeBeforeSequence = 0) => {
      if (!normalizedProvider) return;
      const requestSequence = ++requestSequenceRef.current;
      setState((current) => {
        const visible =
          current.sourceKey === sourceKey &&
          current.providerName === normalizedProvider
            ? current
            : getInitialProviderRowState(
                sourceKey,
                normalizedProvider,
                forceRefresh,
              );
        return {
          ...visible,
          refreshing: true,
          fresh: forceRefresh ? false : visible.fresh,
          error: null,
        };
      });
      try {
        const entry = await loadProviderRow(
          sourceKey,
          normalizedProvider,
          forceRefresh,
          supersedeBeforeSequence,
        );
        if (requestSequence !== requestSequenceRef.current) return;
        acceptedRequestSequenceRef.current = Math.max(
          acceptedRequestSequenceRef.current,
          entry.requestSequence,
        );
        setState({
          sourceKey,
          providerName: normalizedProvider,
          row: entry.row,
          refreshing: false,
          fresh: true,
          error: null,
        });
      } catch (error) {
        if (requestSequence !== requestSequenceRef.current) return;
        setState((current) => ({
          ...(current.sourceKey === sourceKey &&
          current.providerName === normalizedProvider
            ? current
            : getInitialProviderRowState(
                sourceKey,
                normalizedProvider,
                forceRefresh,
              )),
          refreshing: false,
          fresh: false,
          error: error instanceof Error ? error : new Error(String(error)),
        }));
      }
    },
    [normalizedProvider, sourceKey],
  );

  useEffect(() => {
    if (!normalizedProvider) return undefined;
    const listener: ProviderRowListener = (row, requestSequence) => {
      if (requestSequence <= acceptedRequestSequenceRef.current) return;
      acceptedRequestSequenceRef.current = requestSequence;
      setState({
        sourceKey,
        providerName: normalizedProvider,
        row,
        refreshing: forceRefreshOnMount,
        fresh: !forceRefreshOnMount,
        error: null,
      });
      if (forceRefreshOnMount) {
        void fetch(true, requestSequence);
      }
    };
    return subscribeProviderRow(sourceKey, normalizedProvider, listener);
  }, [fetch, forceRefreshOnMount, normalizedProvider, sourceKey]);

  useEffect(() => {
    requestSequenceRef.current += 1;
    acceptedRequestSequenceRef.current = normalizedProvider
      ? (readCachedProviderRowEntry(sourceKey, normalizedProvider)
          ?.requestSequence ?? 0)
      : 0;
    const initial = getInitialProviderRowState(
      sourceKey,
      normalizedProvider,
      forceRefreshOnMount,
    );
    setState(initial);
    if (!normalizedProvider || initial.fresh) return undefined;

    let cancelled = false;
    const selectionSequence = getProviderRequestSequence();
    const slot = acquireClientQueryBootstrapSlot(sourceKey, "route");
    void slot.ready().then(() => {
      if (cancelled) {
        slot.settle();
        return;
      }
      void fetch(
        forceRefreshOnMount,
        forceRefreshOnMount ? selectionSequence : 0,
      ).finally(() => slot.settle());
    });
    return () => {
      cancelled = true;
      requestSequenceRef.current += 1;
      slot.settle();
    };
  }, [fetch, forceRefreshOnMount, normalizedProvider, sourceKey]);

  const visible =
    state.sourceKey === sourceKey && state.providerName === normalizedProvider
      ? state
      : getInitialProviderRowState(
          sourceKey,
          normalizedProvider,
          forceRefreshOnMount,
        );

  return {
    ...visible,
    loading: visible.refreshing && visible.row === null,
    refresh: () => fetch(true),
  };
}

/**
 * Get the list of providers that are available (installed + authenticated/enabled).
 */
export function getAvailableProviders(
  providers: ProviderInfo[],
): ProviderInfo[] {
  return providers.filter((p) => p.installed && (p.authenticated || p.enabled));
}

/**
 * Providers whose runtime YA can launch. Authentication is intentionally not a
 * gate: some harnesses discover or refresh credentials only after launch, and
 * their startup error is the most accurate remediation surface.
 */
export function getLaunchableProviders(
  providers: ProviderInfo[],
): ProviderInfo[] {
  return providers.filter((provider) => provider.installed);
}

/**
 * Get the default provider from available providers.
 * Prefers Claude if available, otherwise the first available provider.
 */
export function getDefaultProvider(
  providers: ProviderInfo[],
): ProviderInfo | null {
  const available = getAvailableProviders(providers);
  if (available.length === 0) return null;

  // Prefer default provider (Claude)
  const defaultProv = available.find((p) => p.name === DEFAULT_PROVIDER);
  if (defaultProv) return defaultProv;

  // available[0] is guaranteed to exist since we checked length > 0
  return available[0] ?? null;
}

/** Prefer Claude among launchable runtimes, even when auth is not confirmed. */
export function getDefaultLaunchableProvider(
  providers: ProviderInfo[],
): ProviderInfo | null {
  const launchable = getLaunchableProviders(providers);
  if (launchable.length === 0) return null;
  return (
    launchable.find((provider) => provider.name === DEFAULT_PROVIDER) ??
    launchable[0] ??
    null
  );
}
