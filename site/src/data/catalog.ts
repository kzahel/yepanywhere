import { nativeSessionFamily } from "../../../packages/shared/src/session-identity";
import type { ProviderName } from "../../../packages/shared/src/types";
import { distributions } from "./distributions";
import { publishedDocPaths } from "./docs-navigation";
import { featureCategories, features, type PublicFeature } from "./features";
import { ALL_PROVIDERS, providers } from "./providers";
import type { PublicDistribution } from "./distributions";

function requireUniqueIds(label: string, entries: readonly { id: string }[]) {
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.id))
      throw new Error(`Duplicate ${label} id: ${entry.id}`);
    seen.add(entry.id);
  }
}

export function validateCatalog() {
  requireUniqueIds("feature", features);
  requireUniqueIds("feature category", featureCategories);
  requireUniqueIds("provider", providers);
  requireUniqueIds("distribution", distributions);
  const categoryIds = new Set(featureCategories.map((category) => category.id));
  const providerIds = new Set(providers.map((provider) => provider.id));
  const coveredRuntimeProviderIds = new Set<ProviderName>(
    providers.flatMap((provider) => provider.runtimeIds),
  );

  const executableProviderIds = ALL_PROVIDERS.filter(
    (provider) => nativeSessionFamily(provider) !== "gemini",
  );
  for (const runtimeProviderId of executableProviderIds) {
    if (!coveredRuntimeProviderIds.has(runtimeProviderId)) {
      throw new Error(
        `Runtime provider ${runtimeProviderId} is missing from the public provider registry`,
      );
    }
  }
  for (const runtimeProviderId of coveredRuntimeProviderIds) {
    if (!executableProviderIds.includes(runtimeProviderId)) {
      throw new Error(
        `Public provider registry references an unavailable runtime provider ${runtimeProviderId}`,
      );
    }
  }

  for (const feature of features as readonly PublicFeature[]) {
    if (!categoryIds.has(feature.category)) {
      throw new Error(
        `Feature ${feature.id} has unknown category ${feature.category}`,
      );
    }
    if (!publishedDocPaths.has(feature.docsPath)) {
      throw new Error(
        `Feature ${feature.id} has unpublished docs path ${feature.docsPath}`,
      );
    }
    if (feature.featured && !feature.summary) {
      throw new Error(`Featured feature ${feature.id} needs a summary`);
    }
    for (const providerId of feature.providers ?? []) {
      if (!providerIds.has(providerId)) {
        throw new Error(
          `Feature ${feature.id} has unknown provider ${providerId}`,
        );
      }
    }
  }

  for (const distribution of distributions as readonly PublicDistribution[]) {
    if (!publishedDocPaths.has(distribution.docsPath)) {
      throw new Error(
        `Distribution ${distribution.id} has unpublished docs path ${distribution.docsPath}`,
      );
    }
    if (distribution.status === "development" && distribution.downloadUrl) {
      throw new Error(
        `Development distribution ${distribution.id} cannot have a download URL`,
      );
    }
  }
}

validateCatalog();

export { distributions, featureCategories, features, providers };
