import {
  ALL_PROVIDERS,
  type ModelInfo,
  type ProviderInfo,
  type ProviderName,
} from "@yep-anywhere/shared";
import type { ClientSummarySourceKey } from "./clientSourceIdentity";

const PROVIDER_CACHE_TTL_MS = 5 * 60_000;
/**
 * A snapshot is never a probe result: it renders the standing choice while the
 * real request runs, and every consumer still sees `loading` until that request
 * answers. A changed server catalog corrects the restored display in place;
 * explicit refresh asks the server to rediscover installation and login state.
 */
const PROVIDER_SNAPSHOT_PREFIX = "ya:providers:";
const PROVIDER_SNAPSHOT_VERSION = 1;

interface ProviderSnapshot {
  version: typeof PROVIDER_SNAPSHOT_VERSION;
  savedAt: number;
  providers: ProviderInfo[];
}

function snapshotModel(model: ModelInfo): ModelInfo {
  return {
    id: model.id,
    resolvedModel: model.resolvedModel,
    name: model.name,
    description: model.description,
    size: model.size,
    contextWindow: model.contextWindow,
    parameterSize: model.parameterSize,
    parentModel: model.parentModel,
    quantizationLevel: model.quantizationLevel,
    isDefault: model.isDefault,
    defaultReasoningEffort: model.defaultReasoningEffort,
    supportedReasoningEfforts: model.supportedReasoningEfforts?.map(
      (effort) => ({
        reasoningEffort: effort.reasoningEffort,
        description: effort.description,
      }),
    ),
    supportsEffort: model.supportsEffort,
    supportedEffortLevels: model.supportedEffortLevels
      ? [...model.supportedEffortLevels]
      : undefined,
    defaultEffortLevel: model.defaultEffortLevel,
    supportsAdaptiveThinking: model.supportsAdaptiveThinking,
    supportsFastMode: model.supportsFastMode,
    supportsAutoMode: model.supportsAutoMode,
    inputModalities: model.inputModalities
      ? [...model.inputModalities]
      : undefined,
    supportsPersonality: model.supportsPersonality,
    serviceTiers: model.serviceTiers?.map((tier) => ({
      id: tier.id,
      name: tier.name,
      description: tier.description,
    })),
    catalogGroup: model.catalogGroup,
  };
}

/** Keep only fields used to paint provider/model controls between visits. */
function snapshotProvider(provider: ProviderInfo): ProviderInfo {
  return {
    name: provider.name,
    displayName: provider.displayName,
    installed: provider.installed,
    applicationDetected: provider.applicationDetected,
    authenticated: provider.authenticated,
    enabled: provider.enabled,
    models: provider.models?.map(snapshotModel),
    modelCatalog: provider.modelCatalog
      ? {
          source: provider.modelCatalog.source,
          fetchedAt: provider.modelCatalog.fetchedAt,
          error: provider.modelCatalog.error,
        }
      : undefined,
    additionalModelOptions: provider.additionalModelOptions?.map(snapshotModel),
    imageSizing: provider.imageSizing
      ? {
          defaultLongEdgePx: provider.imageSizing.defaultLongEdgePx,
          maxUsefulLongEdgePx: provider.imageSizing.maxUsefulLongEdgePx,
          note: provider.imageSizing.note,
        }
      : undefined,
    supportsPermissionMode: provider.supportsPermissionMode,
    supportsThinkingToggle: provider.supportsThinkingToggle,
    supportsSlashCommands: provider.supportsSlashCommands,
    supportsSteering: provider.supportsSteering,
    supportsSteerNow: provider.supportsSteerNow,
    supportsRecaps: provider.supportsRecaps,
    supportsNativeRecaps: provider.supportsNativeRecaps,
    supportsNativePromptSuggestions: provider.supportsNativePromptSuggestions,
    supportsNativeCompactThreshold: provider.supportsNativeCompactThreshold,
    supportsLaunchCompactPercentOverride:
      provider.supportsLaunchCompactPercentOverride,
    promptCacheKeepalive: provider.promptCacheKeepalive
      ? {
          supportsNoContextPollutionNudge:
            provider.promptCacheKeepalive.supportsNoContextPollutionNudge,
          defaultMode: provider.promptCacheKeepalive.defaultMode,
          defaultInactivityMinutes:
            provider.promptCacheKeepalive.defaultInactivityMinutes,
        }
      : undefined,
    supportsForkSession: provider.supportsForkSession,
    supportsBoundedTurnSearch: provider.supportsBoundedTurnSearch,
  };
}

interface ProviderCacheEntry {
  providers: ProviderInfo[];
  expiresAt: number;
  requestSequence: number;
  /** Rows from a previous visit; they never satisfy a request on their own. */
  stale?: boolean;
}

let providerRequestSequence = 0;
const providerCaches = new Map<ClientSummarySourceKey, ProviderCacheEntry>();
const providerFetchPromises = new Map<
  ClientSummarySourceKey,
  Promise<ProviderInfo[]>
>();
const hydratedSnapshotSources = new Set<ClientSummarySourceKey>();
export type ProviderCatalogListener = (entry: ProviderCacheEntry) => void;
const providerCatalogListeners = new Map<
  ClientSummarySourceKey,
  Set<ProviderCatalogListener>
>();
export type ProviderRowListener = (
  row: ProviderInfo | null,
  requestSequence: number,
) => void;
const providerRowListeners = new Map<
  ClientSummarySourceKey,
  Map<ProviderName, Set<ProviderRowListener>>
>();

function notifyProviderCatalogListeners(
  sourceKey: ClientSummarySourceKey,
  entry: ProviderCacheEntry,
): void {
  const listeners = providerCatalogListeners.get(sourceKey);
  if (!listeners) return;
  for (const listener of listeners) listener(entry);
}

function notifyProviderRowListeners(
  sourceKey: ClientSummarySourceKey,
  providers: readonly ProviderInfo[],
  requestSequence: number,
): void {
  const sourceListeners = providerRowListeners.get(sourceKey);
  if (!sourceListeners) return;
  for (const [providerName, listeners] of sourceListeners) {
    const row =
      providers.find((provider) => provider.name === providerName) ?? null;
    for (const listener of listeners) listener(row, requestSequence);
  }
}

function snapshotStorage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/** Seed the in-memory cache from the last successful probe for this source. */
function hydrateProviderSnapshot(sourceKey: ClientSummarySourceKey): void {
  if (hydratedSnapshotSources.has(sourceKey)) return;
  hydratedSnapshotSources.add(sourceKey);
  if (providerCaches.has(sourceKey)) return;
  const storage = snapshotStorage();
  if (!storage) return;
  try {
    const raw = storage.getItem(`${PROVIDER_SNAPSHOT_PREFIX}${sourceKey}`);
    if (!raw) return;
    const parsed = JSON.parse(raw) as Partial<ProviderSnapshot>;
    if (
      parsed.version !== PROVIDER_SNAPSHOT_VERSION ||
      !Array.isArray(parsed.providers) ||
      parsed.providers.length === 0
    ) {
      storage.removeItem(`${PROVIDER_SNAPSHOT_PREFIX}${sourceKey}`);
      return;
    }
    if (
      typeof parsed.savedAt !== "number" ||
      !Number.isFinite(parsed.savedAt)
    ) {
      storage.removeItem(`${PROVIDER_SNAPSHOT_PREFIX}${sourceKey}`);
      return;
    }
    providerCaches.set(sourceKey, {
      providers: parsed.providers,
      // A browser snapshot predates every request in this module lifetime.
      requestSequence: 0,
      // Expired on arrival: a snapshot is an opening guess, never an answer.
      expiresAt: 0,
      stale: true,
    });
  } catch {
    // A malformed or unreadable snapshot just means no opening guess.
  }
}

function writeProviderSnapshot(
  sourceKey: ClientSummarySourceKey,
  providers: ProviderInfo[],
  storageKey = `${PROVIDER_SNAPSHOT_PREFIX}${sourceKey}`,
): void {
  const storage = snapshotStorage();
  if (!storage || providers.length === 0) return;
  try {
    storage.setItem(
      storageKey,
      JSON.stringify({
        version: PROVIDER_SNAPSHOT_VERSION,
        savedAt: Date.now(),
        providers: providers.map(snapshotProvider),
      } satisfies ProviderSnapshot),
    );
  } catch {
    // Storage pressure only costs the next visit its opening guess.
  }
}

export async function acquireProviders(
  sourceKey: ClientSummarySourceKey,
  fetcher: (options: {
    refresh: boolean;
  }) => Promise<{ providers: ProviderInfo[] }>,
  forceRefresh: boolean,
  bypassClientCache = false,
): Promise<ProviderInfo[]> {
  const now = Date.now();
  hydrateProviderSnapshot(sourceKey);
  const providerCache = providerCaches.get(sourceKey);
  if (
    !forceRefresh &&
    !bypassClientCache &&
    providerCache &&
    providerCache.expiresAt > now
  ) {
    return providerCache.providers;
  }
  const providerFetchPromise = providerFetchPromises.get(sourceKey);
  if (!forceRefresh && !bypassClientCache && providerFetchPromise) {
    return providerFetchPromise;
  }

  const requestSequence = ++providerRequestSequence;
  const request = fetcher({ refresh: forceRefresh }).then(
    (data) => data.providers,
  );
  providerFetchPromises.set(sourceKey, request);

  try {
    const providers = await request;
    if (providerFetchPromises.get(sourceKey) === request) {
      const entry = {
        providers,
        expiresAt: Date.now() + PROVIDER_CACHE_TTL_MS,
        requestSequence,
      };
      providerCaches.set(sourceKey, entry);
      writeProviderSnapshot(sourceKey, providers);
      for (const providerName of ALL_PROVIDERS) {
        const key = providerRowKey(sourceKey, providerName);
        if (
          (providerRowCaches.get(key)?.requestSequence ?? 0) > requestSequence
        ) {
          continue;
        }
        // The complete response supersedes older persisted named displays,
        // including providers that have since been disabled or removed.
        providerRowDisplays.set(key, null);
        try {
          snapshotStorage()?.removeItem(
            providerRowStorageKey(sourceKey, providerName),
          );
        } catch {
          // Unavailable storage cannot prevent publication of current rows.
        }
      }
      notifyProviderCatalogListeners(sourceKey, entry);
      notifyProviderRowListeners(sourceKey, providers, requestSequence);
      return providers;
    }
    const current = providerCaches.get(sourceKey);
    return current && current.requestSequence > requestSequence
      ? current.providers
      : providers;
  } catch (error) {
    const current = providerCaches.get(sourceKey);
    if (current && current.requestSequence > requestSequence) {
      return current.providers;
    }
    throw error;
  } finally {
    if (providerFetchPromises.get(sourceKey) === request) {
      providerFetchPromises.delete(sourceKey);
    }
  }
}

export interface ProviderHookState {
  sourceKey: ClientSummarySourceKey;
  providers: ProviderInfo[];
  loading: boolean;
  /** The rows on hand predate this visit's probe and may be wrong. */
  stale: boolean;
  error: Error | null;
}

export function getInitialProviderState(
  sourceKey: ClientSummarySourceKey,
): ProviderHookState {
  hydrateProviderSnapshot(sourceKey);
  const providerCache = providerCaches.get(sourceKey);
  return {
    sourceKey,
    providers: providerCache?.providers ?? [],
    loading: !providerCache || providerCache.stale === true,
    stale: providerCache?.stale === true,
    error: null,
  };
}

export interface ProviderRowCacheEntry {
  row: ProviderInfo;
  expiresAt: number;
  requestSequence: number;
}

interface ProviderRowRequest {
  forced: boolean;
  requestSequence: number;
  promise: Promise<ProviderRowCacheEntry>;
  supersededBy?: Promise<ProviderRowCacheEntry>;
}

const providerRowCaches = new Map<string, ProviderRowCacheEntry>();
const providerRowRequests = new Map<string, ProviderRowRequest>();
const providerRowDisplays = new Map<string, ProviderInfo | null>();

function providerRowStorageKey(
  sourceKey: ClientSummarySourceKey,
  providerName: ProviderName,
): string {
  return `ya:provider-row:${JSON.stringify([sourceKey, providerName])}`;
}

/** Display only: never insert persisted rows into the current probe cache. */
function readProviderRowDisplay(
  sourceKey: ClientSummarySourceKey,
  providerName: ProviderName,
): ProviderInfo | null {
  const key = providerRowKey(sourceKey, providerName);
  if (!providerRowDisplays.has(key)) {
    providerRowDisplays.set(key, null);
    try {
      const storage = snapshotStorage();
      const storageKey = providerRowStorageKey(sourceKey, providerName);
      const raw = storage?.getItem(storageKey);
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<ProviderSnapshot>;
        if (
          parsed.version === PROVIDER_SNAPSHOT_VERSION &&
          typeof parsed.savedAt === "number" &&
          Number.isFinite(parsed.savedAt) &&
          Array.isArray(parsed.providers) &&
          parsed.providers.length === 1 &&
          parsed.providers[0]?.name === providerName
        ) {
          providerRowDisplays.set(key, snapshotProvider(parsed.providers[0]));
        } else {
          storage?.removeItem(storageKey);
        }
      }
    } catch {
      // Malformed or unavailable storage leaves normal acquisition intact.
    }
  }
  hydrateProviderSnapshot(sourceKey);
  return (
    providerRowDisplays.get(key) ??
    providerCaches
      .get(sourceKey)
      ?.providers.find((row) => row.name === providerName) ??
    null
  );
}

function providerRowKey(
  sourceKey: ClientSummarySourceKey,
  providerName: ProviderName,
): string {
  return `${sourceKey}\0${providerName}`;
}

/** A current row good enough to skip an ordinary single-provider request. */
export function readCachedProviderRowEntry(
  sourceKey: ClientSummarySourceKey,
  providerName: ProviderName,
): ProviderRowCacheEntry | null {
  const now = Date.now();
  const cachedRow = providerRowCaches.get(
    providerRowKey(sourceKey, providerName),
  );
  const rowEntry =
    cachedRow && cachedRow.expiresAt > now ? cachedRow : undefined;
  const cachedProviders = providerCaches.get(sourceKey);
  const providerCache =
    cachedProviders && !cachedProviders.stale && cachedProviders.expiresAt > now
      ? cachedProviders
      : undefined;
  if (
    rowEntry &&
    (!providerCache ||
      rowEntry.requestSequence >= providerCache.requestSequence)
  ) {
    return rowEntry;
  }
  const aggregateRow = providerCache?.providers.find(
    (provider) => provider.name === providerName,
  );
  return aggregateRow && providerCache
    ? {
        row: aggregateRow,
        expiresAt: providerCache.expiresAt,
        requestSequence: providerCache.requestSequence,
      }
    : null;
}

function readCachedProviderRow(
  sourceKey: ClientSummarySourceKey,
  providerName: ProviderName,
): ProviderInfo | null {
  return readCachedProviderRowEntry(sourceKey, providerName)?.row ?? null;
}

export async function acquireProviderRow(
  sourceKey: ClientSummarySourceKey,
  providerName: ProviderName,
  fetcher: (options: {
    refresh: boolean;
  }) => Promise<{ provider: ProviderInfo }>,
  forceRefresh: boolean,
  supersedeBeforeSequence = 0,
): Promise<ProviderRowCacheEntry> {
  const key = providerRowKey(sourceKey, providerName);
  if (!forceRefresh) {
    const cached = readCachedProviderRowEntry(sourceKey, providerName);
    // "Not installed" is never trusted from cache: the named read is what
    // makes the server recheck a CLI installed outside YA.
    if (cached?.row.installed) return cached;
  }

  const pending = providerRowRequests.get(key);
  if (
    pending &&
    (!forceRefresh ||
      (pending.forced && pending.requestSequence > supersedeBeforeSequence))
  ) {
    return pending.promise;
  }

  const requestSequence = ++providerRequestSequence;
  const rawRequest = fetcher({ refresh: forceRefresh }).then(
    (data) => data.provider,
  );
  let request!: ProviderRowRequest;
  const promise = rawRequest
    .then(
      (row) => {
        if (request.supersededBy) return request.supersededBy;
        const entry = {
          row,
          expiresAt: Date.now() + PROVIDER_CACHE_TTL_MS,
          requestSequence,
        };
        const newerCached = readCachedProviderRowEntry(sourceKey, providerName);
        if (
          newerCached &&
          newerCached.requestSequence > entry.requestSequence
        ) {
          return newerCached;
        }
        if (providerRowRequests.get(key) === request) {
          providerRowCaches.set(key, entry);
          providerRowDisplays.set(key, row);
          writeProviderSnapshot(
            sourceKey,
            [row],
            providerRowStorageKey(sourceKey, providerName),
          );
        }
        return entry;
      },
      (error: unknown) => {
        if (request.supersededBy) return request.supersededBy;
        throw error;
      },
    )
    .finally(() => {
      if (providerRowRequests.get(key) === request) {
        providerRowRequests.delete(key);
      }
    });
  request = { forced: forceRefresh, requestSequence, promise };
  if (pending) pending.supersededBy = promise;
  providerRowRequests.set(key, request);
  return promise;
}

export interface ProviderRowHookState {
  sourceKey: ClientSummarySourceKey;
  providerName: ProviderName | null;
  row: ProviderInfo | null;
  refreshing: boolean;
  fresh: boolean;
  error: Error | null;
}

export function getInitialProviderRowState(
  sourceKey: ClientSummarySourceKey,
  providerName: ProviderName | null,
  forceRefreshOnMount: boolean,
): ProviderRowHookState {
  const currentRow = providerName
    ? readCachedProviderRow(sourceKey, providerName)
    : null;
  const row =
    currentRow ??
    (providerName ? readProviderRowDisplay(sourceKey, providerName) : null);
  const fresh = currentRow?.installed === true && !forceRefreshOnMount;
  return {
    sourceKey,
    providerName,
    row,
    refreshing: providerName !== null && !fresh,
    fresh,
    error: null,
  };
}

export function getProviderRequestSequence(): number {
  return providerRequestSequence;
}

export function getProviderCache(sourceKey: ClientSummarySourceKey) {
  return providerCaches.get(sourceKey);
}

export function subscribeProviderCatalog(
  sourceKey: ClientSummarySourceKey,
  listener: ProviderCatalogListener,
): () => void {
  const listeners =
    providerCatalogListeners.get(sourceKey) ??
    new Set<ProviderCatalogListener>();
  listeners.add(listener);
  providerCatalogListeners.set(sourceKey, listeners);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) providerCatalogListeners.delete(sourceKey);
  };
}

export function subscribeProviderRow(
  sourceKey: ClientSummarySourceKey,
  providerName: ProviderName,
  listener: ProviderRowListener,
): () => void {
  const sourceListeners =
    providerRowListeners.get(sourceKey) ??
    new Map<ProviderName, Set<ProviderRowListener>>();
  const listeners =
    sourceListeners.get(providerName) ?? new Set<ProviderRowListener>();
  listeners.add(listener);
  sourceListeners.set(providerName, listeners);
  providerRowListeners.set(sourceKey, sourceListeners);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) sourceListeners.delete(providerName);
    if (sourceListeners.size === 0) providerRowListeners.delete(sourceKey);
  };
}
