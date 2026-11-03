import type {
  ProviderDescriptor,
  ProviderInfo,
  ProviderName,
  ProviderSubscriptionUsage,
} from "@yep-anywhere/shared";
import { providerSupportsBoundedTurnSearch } from "@yep-anywhere/shared";
import type { Context } from "hono";
import { Hono } from "hono";
import { detectDesktopProviderApplication } from "../desktop/providerDetection.js";
import { SourceVersionedSingleFlight } from "../lib/sourceVersionedSingleFlight.js";
import { getAllProviders } from "../sdk/providers/index.js";
import type {
  AgentProvider,
  ProviderLoginLaunch,
} from "../sdk/providers/types.js";
import type { ModelInfoService } from "../services/ModelInfoService.js";
import { getProviderImageSizing } from "../services/image-preparation.mjs";
import {
  ProviderLoginError,
  ProviderLoginService,
} from "../services/ProviderLoginService.js";

const PROVIDER_USAGE_CACHE_TTL_MS = 60_000;

interface ProviderRouteDeps {
  modelInfoService?: Pick<ModelInfoService, "ingestModels">;
  /** If non-empty, only these provider names are exposed. */
  enabledProviders?: string[];
  /** Provider instances, injectable for route tests. */
  providers?: AgentProvider[];
  /** Provider subscription usage cache TTL in ms. */
  usageCacheTtlMs?: number;
  /** Whether this route belongs to the bundled desktop runtime. */
  desktopRuntime?: boolean;
  /** Injectable coarse application detector for desktop route tests. */
  applicationDetector?: (provider: ProviderName) => boolean;
  /** Provider sign-in runner, injectable for route tests. */
  loginService?: ProviderLoginService;
}

interface ProviderInfoCacheValue {
  catalogCacheKey?: string;
  info: ProviderInfo;
}

interface ProviderInfoGeneration {
  nextGeneration: number;
  current?: {
    sourceVersion: string;
    catalogCacheKey?: string;
    forced: boolean;
    inFlight: boolean;
  };
}

/**
 * Creates provider-related API routes.
 *
 * GET /api/providers - Get all providers with their auth status
 * GET /api/providers/:name - Get specific provider status
 */
export function createProvidersRoutes(deps: ProviderRouteDeps = {}): Hono {
  const routes = new Hono();
  const loginService = deps.loginService ?? new ProviderLoginService();
  const providerInfoOwner = new SourceVersionedSingleFlight<
    ProviderName,
    ProviderInfoCacheValue
  >({
    // One accepted catalog per registered provider, replaced on explicit refresh
    // or configuration change. A large catalog must not make every new tab
    // repeat discovery merely because it exceeded a shared byte budget.
    maxRetainedBytes: Number.POSITIVE_INFINITY,
    estimateBytes: (value) => Buffer.byteLength(JSON.stringify(value)),
  });
  const providerInfoGenerations = new Map<
    ProviderName,
    ProviderInfoGeneration
  >();
  const usageCache = new Map<
    ProviderName,
    {
      expiresAt: number;
      value: ProviderSubscriptionUsage | null;
    }
  >();
  const usageRequests = new Map<
    ProviderName,
    Promise<ProviderSubscriptionUsage | null>
  >();
  const usageCacheTtlMs = deps.usageCacheTtlMs ?? PROVIDER_USAGE_CACHE_TTL_MS;
  const getExposedProviders = (): AgentProvider[] => {
    const providers = deps.providers ?? getAllProviders();
    if (!deps.enabledProviders || deps.enabledProviders.length === 0) {
      return providers;
    }
    const enabled = new Set(deps.enabledProviders);
    return providers.filter((provider) => enabled.has(provider.name));
  };
  const getExposedProvider = (name: string): AgentProvider | undefined =>
    getExposedProviders().find((provider) => provider.name === name);

  const readProviderInfo = async (
    provider: AgentProvider,
    providerName: ProviderName,
    forceRefresh: boolean,
  ): Promise<ProviderInfoCacheValue> => {
    const [authStatus, models] = await Promise.all([
      provider.getAuthStatus(),
      forceRefresh
        ? provider.getAvailableModels({ forceRefresh: true })
        : provider.getAvailableModels(),
    ]);
    return {
      catalogCacheKey: provider.getModelCatalogCacheKey?.(),
      info: {
        name: provider.name,
        displayName: provider.displayName,
        installed: authStatus.installed,
        ...(deps.desktopRuntime &&
        (providerName === "claude" || providerName === "codex")
          ? {
              applicationDetected: (
                deps.applicationDetector ?? detectDesktopProviderApplication
              )(providerName),
            }
          : {}),
        authenticated: authStatus.authenticated,
        enabled: authStatus.enabled,
        expiresAt: authStatus.expiresAt?.toISOString(),
        user: authStatus.user,
        loginCommand: authStatus.loginCommand,
        ...(provider.getLoginLaunch
          ? {
              supportsInAppLogin: true,
              supportsHostTerminalLogin: loginService.supportsHostTerminal(),
            }
          : {}),
        models: models.map((model) => ({
          ...model,
          imageSizing: getProviderImageSizing(
            providerName,
            model.resolvedModel ?? model.id,
          ),
        })),
        modelCatalog: provider.getModelCatalogStatus?.(),
        additionalModelOptions: provider.getAdditionalModelOptions?.(),
        imageSizing: getProviderImageSizing(provider.name),
        supportsPermissionMode: provider.supportsPermissionMode,
        supportsThinkingToggle: provider.supportsThinkingToggle,
        supportsSlashCommands: provider.supportsSlashCommands,
        supportsSteering: provider.supportsSteering,
        supportsSteerNow: provider.supportsSteerNow,
        steering: provider.steering,
        supportsRecaps: provider.supportsRecaps,
        supportsNativeRecaps: provider.supportsNativeRecaps,
        supportsNativePromptSuggestions:
          provider.supportsNativePromptSuggestions,
        supportsNativeCompactThreshold: provider.supportsNativeCompactThreshold,
        supportsLaunchCompactPercentOverride:
          provider.supportsLaunchCompactPercentOverride,
        promptCacheKeepalive: provider.promptCacheKeepalive,
        supportsForkSession: typeof provider.forkSession === "function",
        supportsBoundedTurnSearch: providerSupportsBoundedTurnSearch(
          provider.name,
        ),
      } satisfies ProviderInfo,
    };
  };

  const getProviderInfo = async (
    provider: AgentProvider,
    forceRefresh: boolean,
  ): Promise<ProviderInfo> => {
    const providerName = provider.name as ProviderName;
    const admission = providerInfoGenerations.get(providerName) ?? {
      nextGeneration: 0,
    };
    providerInfoGenerations.set(providerName, admission);
    let requireForce = forceRefresh;

    for (;;) {
      const catalogCacheKey = provider.getModelCatalogCacheKey?.();
      let generation = admission.current;
      const canJoinCurrent =
        generation?.inFlight === true &&
        generation.catalogCacheKey === catalogCacheKey &&
        (!requireForce || generation.forced);

      if (!canJoinCurrent) {
        if (!requireForce) {
          const accepted = providerInfoOwner.getAccepted(providerName);
          if (accepted && accepted.value.catalogCacheKey === catalogCacheKey) {
            return accepted.value.info;
          }
        }

        if (requireForce) {
          providerInfoOwner.invalidate(providerName);
        }
        const generationNumber = ++admission.nextGeneration;
        generation = {
          sourceVersion: `${generationNumber}\0${catalogCacheKey ?? ""}`,
          catalogCacheKey,
          forced: requireForce,
          inFlight: true,
        };
        admission.current = generation;
      }
      if (!generation) {
        throw new Error(
          `Failed to admit provider info work for ${providerName}`,
        );
      }

      const sourceVersion = generation.sourceVersion;
      try {
        const result = await providerInfoOwner.run({
          key: providerName,
          sourceVersion,
          compute: () =>
            readProviderInfo(provider, providerName, generation.forced),
          isCurrent: (candidate) =>
            admission.current?.sourceVersion === candidate &&
            provider.getModelCatalogCacheKey?.() === generation.catalogCacheKey,
        });
        if (admission.current?.sourceVersion === sourceVersion) {
          admission.current.inFlight = false;
        }
        if (result.status !== "stale") {
          if (result.status === "computed") {
            deps.modelInfoService?.ingestModels(
              providerName,
              result.value.info.models ?? [],
            );
          }
          return result.value.info;
        }
      } catch (error) {
        if (admission.current?.sourceVersion === sourceVersion) {
          admission.current.inFlight = false;
          throw error;
        }
      }

      // Newer forced work superseded this request. Follow that generation so a
      // legacy complete-response caller never publishes or receives old facts.
      requireForce = false;
    }
  };

  const isRefreshRequest = (c: Context) =>
    c.req.query("refresh") === "true" ||
    c.req.query("refresh") === "1" ||
    c.req.header("cache-control")?.toLowerCase().includes("no-cache") === true;

  const getSubscriptionUsage = async (
    provider: AgentProvider,
    forceRefresh: boolean,
  ): Promise<ProviderSubscriptionUsage | null> => {
    const readSubscriptionUsage = provider.getSubscriptionUsage;
    if (!readSubscriptionUsage) return null;
    const providerName = provider.name as ProviderName;
    const cached = usageCache.get(providerName);
    if (!forceRefresh && cached && cached.expiresAt > Date.now()) {
      return cached.value;
    }
    const pending = usageRequests.get(providerName);
    if (!forceRefresh && pending) return pending;

    const request = (async () => {
      const providerInfo = await getProviderInfo(provider, false);
      if (!providerInfo.authenticated) return null;
      try {
        return await readSubscriptionUsage.call(
          provider,
          providerInfo.models ?? [],
        );
      } catch {
        return null;
      }
    })();
    usageRequests.set(providerName, request);
    try {
      const value = await request;
      if (usageRequests.get(providerName) === request) {
        usageCache.set(providerName, {
          value,
          expiresAt: Date.now() + usageCacheTtlMs,
        });
      }
      return value;
    } finally {
      if (usageRequests.get(providerName) === request) {
        usageRequests.delete(providerName);
      }
    }
  };

  // GET /api/providers - Get all available providers with auth status and models
  routes.get("/", async (c) => {
    const forceRefresh = isRefreshRequest(c);
    const providerInfos: ProviderInfo[] = await Promise.all(
      getExposedProviders().map((provider) =>
        getProviderInfo(provider, forceRefresh),
      ),
    );

    return c.json({ providers: providerInfos });
  });

  // Enumeration must not wait for any provider's runtime or account probes.
  routes.get("/descriptors", (c) => {
    const providers: ProviderDescriptor[] = getExposedProviders().map(
      ({ name, displayName }) => ({ name, displayName }),
    );
    return c.json({ providers });
  });

  // GET /api/providers/:name/subscription-usage - normalized account limits
  routes.get("/:name/subscription-usage", async (c) => {
    const forceRefresh = isRefreshRequest(c);
    const name = c.req.param("name");
    const provider = getExposedProvider(name);

    if (!provider) {
      return c.json({ error: "Provider not found" }, 404);
    }

    const usage = await getSubscriptionUsage(provider, forceRefresh);
    return c.json({ usage });
  });

  // GET /api/providers/:name - Get specific provider status with models
  routes.get("/:name", async (c) => {
    const forceRefresh = isRefreshRequest(c);
    const name = c.req.param("name");
    const provider = getExposedProvider(name);

    if (!provider) {
      return c.json({ error: "Provider not found" }, 404);
    }

    const providerInfo = await getProviderInfo(provider, forceRefresh);
    return c.json({ provider: providerInfo });
  });

  const resolveLoginLaunch = async (
    c: Context,
  ): Promise<
    | { provider: AgentProvider; launch: ProviderLoginLaunch }
    | { response: Response }
  > => {
    const provider = getExposedProvider(c.req.param("name") ?? "");
    if (!provider?.getLoginLaunch) {
      return {
        response: c.json({ error: "Provider has no sign-in" }, 404),
      };
    }
    const launch = await provider.getLoginLaunch();
    if (!launch) {
      return {
        response: c.json({ error: "Provider CLI is not installed" }, 409),
      };
    }
    return { provider, launch };
  };

  const loginErrorResponse = (c: Context, error: unknown) => {
    if (error instanceof ProviderLoginError) {
      return c.json({ error: error.message }, error.status);
    }
    throw error;
  };

  // GET /api/providers/:name/login - current or recently finished sign-in
  routes.get("/:name/login", (c) => {
    const name = c.req.param("name") as ProviderName;
    return c.json({ flow: loginService.get(name) });
  });

  // POST /api/providers/:name/login - start a sign-in relayed through YA
  routes.post("/:name/login", async (c) => {
    const resolved = await resolveLoginLaunch(c);
    if ("response" in resolved) return resolved.response;
    const name = resolved.provider.name as ProviderName;
    return c.json({ flow: loginService.start(name, resolved.launch) });
  });

  // POST /api/providers/:name/login/code - paste back an authorization code
  routes.post("/:name/login/code", async (c) => {
    const name = c.req.param("name") as ProviderName;
    const body = (await c.req.json().catch(() => null)) as {
      flowId?: unknown;
      code?: unknown;
    } | null;
    if (typeof body?.flowId !== "string" || typeof body.code !== "string") {
      return c.json({ error: "flowId and code are required" }, 400);
    }
    try {
      return c.json({
        flow: loginService.submitCode(name, body.flowId, body.code),
      });
    } catch (error) {
      return loginErrorResponse(c, error);
    }
  });

  // DELETE /api/providers/:name/login?flowId= - stop a running sign-in
  routes.delete("/:name/login", (c) => {
    const name = c.req.param("name") as ProviderName;
    const flowId = c.req.query("flowId");
    return c.json({ flow: loginService.cancel(name, flowId) });
  });

  // POST /api/providers/:name/login/terminal - sign in on the host's desktop
  routes.post("/:name/login/terminal", async (c) => {
    const resolved = await resolveLoginLaunch(c);
    if ("response" in resolved) return resolved.response;
    try {
      loginService.openHostTerminal(resolved.launch);
      return c.json({ ok: true });
    } catch (error) {
      return loginErrorResponse(c, error);
    }
  });

  return routes;
}
