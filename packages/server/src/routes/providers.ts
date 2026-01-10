import type { ProviderInfo } from "@yep-anywhere/shared";
import { Hono } from "hono";
import { getAllProviders } from "../sdk/providers/index.js";

/**
 * Creates provider-related API routes.
 *
 * GET /api/providers - Get all providers with their auth status
 * GET /api/providers/:name - Get specific provider status
 */
export function createProvidersRoutes(): Hono {
  const routes = new Hono();

  // GET /api/providers - Get all available providers with auth status and models
  routes.get("/", async (c) => {
    const providers = getAllProviders();
    const providerInfos: ProviderInfo[] = [];

    for (const provider of providers) {
      const [authStatus, models] = await Promise.all([
        provider.getAuthStatus(),
        provider.getAvailableModels(),
      ]);
      providerInfos.push({
        name: provider.name,
        displayName: provider.displayName,
        installed: authStatus.installed,
        authenticated: authStatus.authenticated,
        enabled: authStatus.enabled,
        expiresAt: authStatus.expiresAt?.toISOString(),
        user: authStatus.user,
        models,
        supportsPermissionMode: provider.supportsPermissionMode,
        supportsThinkingToggle: provider.supportsThinkingToggle,
        supportsSlashCommands: provider.supportsSlashCommands,
      });
    }

    return c.json({ providers: providerInfos });
  });

  // GET /api/providers/:name - Get specific provider status with models
  routes.get("/:name", async (c) => {
    const name = c.req.param("name");
    const providers = getAllProviders();
    const provider = providers.find((p) => p.name === name);

    if (!provider) {
      return c.json({ error: "Provider not found" }, 404);
    }

    const [authStatus, models] = await Promise.all([
      provider.getAuthStatus(),
      provider.getAvailableModels(),
    ]);
    const providerInfo: ProviderInfo = {
      name: provider.name,
      displayName: provider.displayName,
      installed: authStatus.installed,
      authenticated: authStatus.authenticated,
      enabled: authStatus.enabled,
      expiresAt: authStatus.expiresAt?.toISOString(),
      user: authStatus.user,
      models,
      supportsPermissionMode: provider.supportsPermissionMode,
      supportsThinkingToggle: provider.supportsThinkingToggle,
      supportsSlashCommands: provider.supportsSlashCommands,
    };

    return c.json({ provider: providerInfo });
  });

  return routes;
}
