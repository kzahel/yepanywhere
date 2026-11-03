import type { NativeSessionCatalogAdapter } from "../catalog-types.js";
import type { ProviderCatalogFamily } from "../provider-catalog-family.js";
import { AntigravitySessionCatalogAdapter } from "./antigravity-catalog-adapter.js";
import { GrokSessionCatalogAdapter } from "./grok-catalog-adapter.js";
import { OpenCodeSessionCatalogAdapter } from "./opencode-catalog-adapter.js";
import { PiSessionCatalogAdapter } from "./pi-catalog-adapter.js";

export interface NativeCatalogOptions {
  grokSessionsDir?: string;
  piSessionsDir?: string;
  antigravitySessionsDir?: string;
}

const factories = {
  grok: (options: NativeCatalogOptions) =>
    new GrokSessionCatalogAdapter({ sessionsDir: options.grokSessionsDir }),
  pi: (options: NativeCatalogOptions) =>
    new PiSessionCatalogAdapter({ sessionsDir: options.piSessionsDir }),
  opencode: () => new OpenCodeSessionCatalogAdapter(),
  antigravity: (options: NativeCatalogOptions) =>
    new AntigravitySessionCatalogAdapter({
      sessionsDir: options.antigravitySessionsDir,
    }),
};

/** Register native discovery once; execution, auth and history remain provider-owned. */
export function nativeCatalogAdapters(
  families: readonly ProviderCatalogFamily[],
  options: NativeCatalogOptions = {},
): NativeSessionCatalogAdapter[] {
  return Object.entries(factories).flatMap(([family, create]) =>
    families.includes(family as ProviderCatalogFamily) ? [create(options)] : [],
  );
}
