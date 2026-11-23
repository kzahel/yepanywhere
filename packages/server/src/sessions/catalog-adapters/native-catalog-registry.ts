import { antigravityAllSessionsDirs } from "../../sdk/providers/antigravity-runtime.js";
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
    antigravityAllSessionsDirs(options.antigravitySessionsDir).map(
      (sessionsDir) => new AntigravitySessionCatalogAdapter({ sessionsDir }),
    ),
};

/** Register native discovery once; execution, auth and history remain provider-owned. */
export function nativeCatalogAdapters(
  families: readonly ProviderCatalogFamily[],
  options: NativeCatalogOptions = {},
): NativeSessionCatalogAdapter[] {
  return Object.entries(factories).flatMap<NativeSessionCatalogAdapter>(
    ([family, create]) => {
      if (!families.includes(family as ProviderCatalogFamily)) return [];
      const created = create(options);
      return Array.isArray(created) ? created : [created];
    },
  );
}
