import type { ProviderCatalogFamily } from "../sessions/provider-catalog-family.js";
import type { EventBus, FileChangeEvent } from "./EventBus.js";
import type { ProviderObservationCallbacks } from "./ProviderSessionWatcherRegistry.js";

export interface ProviderObservationBinding {
  attachRetainedCollections(observer: {
    observationReady(family: ProviderCatalogFamily): void;
  }): void;
  dispose(): void;
}

/**
 * Connects public/internal provider file-change and baseline-readiness hooks
 * to relationship and retained-catalog observers with one disposal handle.
 */
export function wireProviderObservations(
  options: {
    eventBus?: EventBus;
  } & Pick<
    ProviderObservationCallbacks,
    "subscribeProviderObservationReady" | "subscribeNativeProviderFileChanges"
  >,
  providerChildRelationships: {
    notifyNativeFileChange(event: FileChangeEvent): void;
    observationReady(family: ProviderCatalogFamily): void;
  },
  harnessRelationships: {
    notifyFileChange(event: FileChangeEvent): void;
    observationReady(family: ProviderCatalogFamily): void;
  },
): ProviderObservationBinding {
  let retainedCollections:
    | { observationReady(family: ProviderCatalogFamily): void }
    | undefined;
  // Bounded by ProviderCatalogFamily cardinality (<= 7).
  const pendingReady = new Set<ProviderCatalogFamily>();
  const onFileChange = (event: FileChangeEvent) => {
    providerChildRelationships.notifyNativeFileChange(event);
    harnessRelationships.notifyFileChange(event);
  };
  const unsubscribers = [
    options.eventBus?.subscribe((event) => {
      if (event.type === "file-change") onFileChange(event);
    }),
    options.subscribeProviderObservationReady?.((family) => {
      providerChildRelationships.observationReady(family);
      harnessRelationships.observationReady(family);
      if (retainedCollections) retainedCollections.observationReady(family);
      else pendingReady.add(family);
    }),
    options.subscribeNativeProviderFileChanges?.(onFileChange),
  ];
  return {
    attachRetainedCollections(observer) {
      retainedCollections = observer;
      for (const family of pendingReady) observer.observationReady(family);
      pendingReady.clear();
    },
    dispose() {
      pendingReady.clear();
      retainedCollections = undefined;
      for (const unsubscribe of unsubscribers) unsubscribe?.();
    },
  };
}
