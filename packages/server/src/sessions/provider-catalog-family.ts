import type { ProviderName } from "@yep-anywhere/shared";

export const PROVIDER_CATALOG_FAMILIES = [
  "claude",
  "codex",
  "gemini",
  "grok",
  "opencode",
  "pi",
  "antigravity",
] as const;

export type ProviderCatalogFamily = (typeof PROVIDER_CATALOG_FAMILIES)[number];

export function providerCatalogFamily(
  provider: ProviderName,
): ProviderCatalogFamily {
  switch (provider) {
    case "claude":
    case "claude-gateway":
    case "claude-ollama":
      return "claude";
    case "codex":
    case "codex-oss":
      return "codex";
    case "gemini":
    case "gemini-acp":
      return "gemini";
    case "grok":
      return "grok";
    case "opencode":
      return "opencode";
    case "antigravity":
      return "antigravity";
    case "pi":
      return "pi";
  }
}

export function isProviderCatalogFamily(
  value: unknown,
): value is ProviderCatalogFamily {
  return (PROVIDER_CATALOG_FAMILIES as readonly unknown[]).includes(value);
}

export function normalizeProviderCatalogFamilies(
  values: Iterable<unknown>,
): ProviderCatalogFamily[] {
  const present = new Set<ProviderCatalogFamily>();
  for (const value of values) {
    if (isProviderCatalogFamily(value)) present.add(value);
  }
  return PROVIDER_CATALOG_FAMILIES.filter((family) => present.has(family));
}
