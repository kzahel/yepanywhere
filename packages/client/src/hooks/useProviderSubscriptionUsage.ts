import {
  PROVIDER_SUBSCRIPTION_USAGE_CAPABILITY,
  serverHasCapability,
  type ProviderName,
  type ProviderSubscriptionUsage,
  type AgentAuthRouterOverview,
} from "@yep-anywhere/shared";
import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { RoutedSessionContext } from "../contexts/RoutedSessionContext";
import { api } from "../api/client";
import {
  acquireClientQueryBootstrapSlot,
  type ClientQueryBootstrapTier,
} from "../lib/clientQueryBootstrap";
import {
  type ClientSummarySourceKey,
  useClientSummarySourceKey,
} from "../lib/clientSummaryStore";
import { useVersion } from "./useVersion";

const USAGE_CACHE_TTL_MS = 60_000;

/** A routed session reads only its pinned account, never the host's native login. */
function routedUsage(
  overview: AgentAuthRouterOverview,
  accountId: string,
  provider: ProviderName,
): ProviderSubscriptionUsage | null {
  const account = overview.accounts.find(
    (a) => a.id === accountId && a.provider === provider,
  );
  if (!account?.quota) return null;
  return {
    provider,
    fetchedAt: account.quota.observedAt,
    accountLabel: account.displayName,
    ordinaryUsageAllowed: account.quota.ordinaryUsageAllowed,
    windows: account.windows.flatMap((w) => {
      if (w.usedPercent === null || w.scope === "unknown") return [];
      return [
        {
          id: w.bucket,
          usedPercent: w.usedPercent,
          remainingCapacityUnits: w.remainingCapacityUnits,
          windowDurationMinutes: w.windowMinutes ?? undefined,
          resetsAt: w.resetsAt ?? undefined,
          scope:
            w.scope === "all"
              ? { type: "provider" as const }
              : {
                  type: "models" as const,
                  label: w.scope,
                  modelIds: account.models
                    .filter((m) => m.id.includes(w.scope))
                    .map((m) => m.id),
                },
        },
      ];
    }),
  };
}

interface UsageCacheEntry {
  value: ProviderSubscriptionUsage | null;
  expiresAt: number;
}

const usageCaches = new Map<
  ClientSummarySourceKey,
  Map<string, UsageCacheEntry>
>();
const usageRequests = new Map<
  ClientSummarySourceKey,
  Map<string, Promise<ProviderSubscriptionUsage | null>>
>();

function sourceMap<T>(
  stores: Map<ClientSummarySourceKey, Map<string, T>>,
  sourceKey: ClientSummarySourceKey,
): Map<string, T> {
  const existing = stores.get(sourceKey);
  if (existing) return existing;
  const created = new Map<string, T>();
  stores.set(sourceKey, created);
  return created;
}

async function loadUsage(
  sourceKey: ClientSummarySourceKey,
  provider: ProviderName,
  forceRefresh: boolean,
  accountId: string | undefined,
): Promise<ProviderSubscriptionUsage | null> {
  const key = accountId ? `${provider}:router:${accountId}` : provider;
  const cache = sourceMap(usageCaches, sourceKey);
  const cached = cache.get(key);
  if (!forceRefresh && cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  const requests = sourceMap(usageRequests, sourceKey);
  const pending = requests.get(key);
  if (!forceRefresh && pending) return pending;

  const request = accountId
    ? (forceRefresh
        ? api.routerRefreshOverview({ accountId })
        : api.routerOverview()
      ).then((overview) => routedUsage(overview, accountId, provider))
    : api
        .getProviderSubscriptionUsage(provider, { refresh: forceRefresh })
        .then((response) => response.usage);
  requests.set(key, request);
  try {
    const value = await request;
    if (requests.get(key) === request) {
      cache.set(key, {
        value,
        expiresAt: Date.now() + USAGE_CACHE_TTL_MS,
      });
    }
    return value;
  } finally {
    if (requests.get(key) === request) {
      requests.delete(key);
    }
  }
}

interface UsageState {
  sourceKey: ClientSummarySourceKey;
  provider: string | null;
  usage: ProviderSubscriptionUsage | null;
  loading: boolean;
  error: Error | null;
}

export interface UseProviderSubscriptionUsageOptions {
  /** Delay only the first acquisition behind earlier startup tiers. */
  bootstrapTier?: ClientQueryBootstrapTier;
}

export function useProviderSubscriptionUsage(
  provider: ProviderName | null | undefined,
  options: UseProviderSubscriptionUsageOptions = {},
) {
  const sourceKey = useClientSummarySourceKey();
  const { version } = useVersion();
  const routed = useContext(RoutedSessionContext);
  const accountId = routed?.accountId;
  const supported = serverHasCapability(
    version,
    routed ? "agent-auth-router-pools" : PROVIDER_SUBSCRIPTION_USAGE_CAPABILITY,
  );
  const normalizedProvider = provider ?? null;
  const usageKey =
    normalizedProvider && accountId
      ? `${normalizedProvider}:router:${accountId}`
      : normalizedProvider;
  const [state, setState] = useState<UsageState>({
    sourceKey,
    provider: usageKey,
    usage: null,
    loading: false,
    error: null,
  });
  const sequenceRef = useRef(0);

  const fetchUsage = useCallback(
    async (forceRefresh: boolean) => {
      const sequence = ++sequenceRef.current;
      if (!supported || !normalizedProvider) {
        setState({
          sourceKey,
          provider: usageKey,
          usage: null,
          loading: false,
          error: null,
        });
        return null;
      }

      const cached = sourceMap(usageCaches, sourceKey).get(usageKey!);
      setState({
        sourceKey,
        provider: usageKey,
        usage: cached?.value ?? null,
        loading: true,
        error: null,
      });
      try {
        const usage = await loadUsage(
          sourceKey,
          normalizedProvider,
          forceRefresh,
          accountId,
        );
        if (sequence === sequenceRef.current) {
          setState({
            sourceKey,
            provider: usageKey,
            usage,
            loading: false,
            error: null,
          });
        }
        return usage;
      } catch (error) {
        if (sequence === sequenceRef.current) {
          setState({
            sourceKey,
            provider: usageKey,
            usage: null,
            loading: false,
            error: error instanceof Error ? error : new Error(String(error)),
          });
        }
        return null;
      }
    },
    [normalizedProvider, usageKey, accountId, sourceKey, supported],
  );

  useEffect(() => {
    if (!supported || !normalizedProvider || !options.bootstrapTier) {
      void fetchUsage(false);
      return undefined;
    }

    let cancelled = false;
    const slot = acquireClientQueryBootstrapSlot(
      sourceKey,
      options.bootstrapTier,
    );
    void slot.ready().then(() => {
      if (cancelled) {
        slot.settle();
        return;
      }
      void fetchUsage(false).finally(() => slot.settle());
    });
    return () => {
      cancelled = true;
      sequenceRef.current += 1;
      slot.settle();
    };
  }, [
    fetchUsage,
    normalizedProvider,
    options.bootstrapTier,
    sourceKey,
    supported,
  ]);

  const visible =
    state.sourceKey === sourceKey && state.provider === usageKey
      ? state
      : {
          sourceKey,
          provider: normalizedProvider,
          usage: null,
          loading: supported && normalizedProvider !== null,
          error: null,
        };

  return {
    ...visible,
    supported,
    refresh: () => fetchUsage(true),
  };
}
