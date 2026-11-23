import { resolve } from "node:path";
import { existsSync } from "node:fs";
import type { ProviderCatalogFamily } from "../sessions/provider-catalog-family.js";
import { FileWatcher, type FileWatcherOptions } from "./FileWatcher.js";
import { EventBus, type FileChangeEvent } from "./EventBus.js";

/** Consumer handover stays tied to the exact native root and uninterrupted epoch. */
export interface ProviderObservationCallbacks {
  getProviderObservationEpoch?: (
    family: ProviderCatalogFamily,
    root: string,
  ) => number | null;
  subscribeProviderObservationReady?: (
    listener: (family: ProviderCatalogFamily) => void,
  ) => () => void;
  subscribeNativeProviderFileChanges?: (
    listener: (event: FileChangeEvent) => void,
  ) => () => void;
}

type ManagedFileWatcher = Pick<FileWatcher, "start" | "stop"> &
  Partial<
    Pick<FileWatcher, "getObservationDiagnostics" | "getObservationEpoch">
  >;

export interface ProviderSessionWatcherSpec
  extends Omit<FileWatcherOptions, "eventBus" | "onInitialBaseline"> {
  family: ProviderCatalogFamily;
  /** New native acquisition sources need not extend the client activity wire. */
  internalOnly?: boolean;
  /** Additional roots belonging to the same provider family (e.g. routed stores). */
  additionalWatchers?: readonly Omit<
    FileWatcherOptions,
    "eventBus" | "onInitialBaseline"
  >[];
}

export interface ProviderSessionWatcherRegistryMetrics {
  activationQueueRequests: number;
  activationRequests: number;
  directoryProbes: number;
  watchersStarted: number;
  missingDirectories: number;
  activeWatchers: number;
  pendingActivations: number;
}

export interface ProviderSessionWatcherRegistryOptions {
  eventBus: FileWatcherOptions["eventBus"];
  specs: readonly ProviderSessionWatcherSpec[];
  directoryExists?: (directory: string) => boolean;
  createWatcher?: (options: FileWatcherOptions) => ManagedFileWatcher;
  activationDelayMs?: number;
  activationYieldMs?: number;
}

/**
 * Owns one provider storage watcher per eligible native catalog family.
 * Ineligible families are not even probed for directory existence.
 */
export class ProviderSessionWatcherRegistry {
  private readonly eventBus: FileWatcherOptions["eventBus"];
  private readonly nativeEvents = new EventBus();
  private readonly specs = new Map<
    ProviderCatalogFamily,
    ProviderSessionWatcherSpec
  >();
  private readonly directoryExists: (directory: string) => boolean;
  private readonly createWatcher: (
    options: FileWatcherOptions,
  ) => ManagedFileWatcher;
  private readonly watchers = new Map<
    ProviderCatalogFamily,
    { watchDir: string; watcher: ManagedFileWatcher }[]
  >();
  private activationRequests = 0;
  private directoryProbes = 0;
  private watchersStarted = 0;
  private missingDirectories = 0;
  private activationQueueRequests = 0;
  private readonly activationDelayMs: number;
  private readonly activationYieldMs: number;
  private readonly pendingFamilies = new Set<ProviderCatalogFamily>();
  private activationTimer: NodeJS.Timeout | null = null;
  private generation = 0;
  private readonly ready = new Set<ProviderCatalogFamily>();
  private readonly readySubscribers = new Set<
    (family: ProviderCatalogFamily) => void
  >();

  constructor(options: ProviderSessionWatcherRegistryOptions) {
    this.eventBus = options.eventBus;
    this.directoryExists = options.directoryExists ?? existsSync;
    this.createWatcher =
      options.createWatcher ??
      ((watcherOptions) => new FileWatcher(watcherOptions));
    this.activationDelayMs = Math.max(0, options.activationDelayMs ?? 0);
    this.activationYieldMs = Math.max(0, options.activationYieldMs ?? 0);
    for (const spec of options.specs) {
      if (this.specs.has(spec.family)) {
        throw new Error(`Duplicate watcher spec for ${spec.family}`);
      }
      this.specs.set(spec.family, spec);
    }
  }

  activate(families: Iterable<ProviderCatalogFamily>): void {
    for (const family of new Set(families)) this.activateFamily(family);
  }

  /** Internal startup handover, replayed for a late application subscriber. */
  subscribeReady(
    listener: (family: ProviderCatalogFamily) => void,
  ): () => void {
    this.readySubscribers.add(listener);
    for (const family of this.ready) listener(family);
    return () => {
      this.readySubscribers.delete(listener);
    };
  }

  subscribeNativeChanges(
    listener: (event: FileChangeEvent) => void,
  ): () => void {
    return this.nativeEvents.subscribe((event) => {
      if (event.type === "file-change") listener(event);
    });
  }

  private hasUnwatchedCandidates(family: ProviderCatalogFamily): boolean {
    const spec = this.specs.get(family);
    if (!spec) return false;
    const totalCandidates = 1 + (spec.additionalWatchers?.length ?? 0);
    return (this.watchers.get(family)?.length ?? 0) < totalCandidates;
  }

  requestActivation(families: Iterable<ProviderCatalogFamily>): void {
    this.activationQueueRequests += 1;
    for (const family of families) {
      if (this.hasUnwatchedCandidates(family)) {
        this.pendingFamilies.add(family);
      }
    }
    this.scheduleNextActivation(this.activationDelayMs);
  }

  activateFamily(family: ProviderCatalogFamily): void {
    this.activationRequests += 1;
    const spec = this.specs.get(family);
    if (!spec) return;

    const {
      family: _family,
      internalOnly,
      additionalWatchers,
      ...primaryOptions
    } = spec;
    const candidates = [primaryOptions, ...(additionalWatchers ?? [])];
    const existing = this.watchers.get(family) ?? [];
    const watchedDirs = new Set(
      existing.map((entry) => resolve(entry.watchDir)),
    );
    if (watchedDirs.size >= candidates.length) return;

    const generation = this.generation;
    const started = [...existing];

    for (const candidate of candidates) {
      if (watchedDirs.has(resolve(candidate.watchDir))) continue;
      this.directoryProbes += 1;
      if (!this.directoryExists(candidate.watchDir)) {
        this.missingDirectories += 1;
        continue;
      }
      const isLead = started.length === 0;
      const watcher = this.createWatcher({
        ...candidate,
        eventBus: internalOnly ? this.nativeEvents : this.eventBus,
        ...(isLead
          ? {
              onInitialBaseline: () => {
                if (
                  generation !== this.generation ||
                  this.watchers.get(family)?.[0]?.watcher !== watcher
                )
                  return;
                this.ready.add(family);
                for (const listener of this.readySubscribers) listener(family);
              },
            }
          : {}),
      });
      watcher.start();
      started.push({ watchDir: candidate.watchDir, watcher });
      watchedDirs.add(resolve(candidate.watchDir));
      this.watchersStarted += 1;
    }

    if (started.length > existing.length) {
      this.watchers.set(family, started);
    }
  }

  stop(): void {
    this.generation++;
    this.ready.clear();
    if (this.activationTimer) {
      clearTimeout(this.activationTimer);
      this.activationTimer = null;
    }
    this.pendingFamilies.clear();
    for (const entries of this.watchers.values()) {
      for (const { watcher } of entries) watcher.stop();
    }
    this.watchers.clear();
  }

  getMetrics(): ProviderSessionWatcherRegistryMetrics {
    let activeWatchers = 0;
    for (const entries of this.watchers.values()) {
      activeWatchers += entries.length;
    }
    return {
      activationQueueRequests: this.activationQueueRequests,
      activationRequests: this.activationRequests,
      directoryProbes: this.directoryProbes,
      watchersStarted: this.watchersStarted,
      missingDirectories: this.missingDirectories,
      activeWatchers,
      pendingActivations: this.pendingFamilies.size,
    };
  }

  /** See `FileWatcher.getObservationEpoch`; null for an unwatched family. */
  getObservationEpoch(family: ProviderCatalogFamily): number | null {
    return (
      this.watchers.get(family)?.[0]?.watcher.getObservationEpoch?.() ?? null
    );
  }

  sourceObservationCallbacks(): ProviderObservationCallbacks {
    return {
      getProviderObservationEpoch: (family, root) => {
        const entries = this.watchers.get(family);
        const target = resolve(root);
        const match = entries?.find(
          (entry) => resolve(entry.watchDir) === target,
        );
        return match?.watcher.getObservationEpoch?.() ?? null;
      },
      subscribeProviderObservationReady: (listener) =>
        this.subscribeReady(listener),
      subscribeNativeProviderFileChanges: (listener) =>
        this.subscribeNativeChanges(listener),
    };
  }

  /** Fixed-cost observation state; reading it never activates or probes stores. */
  getDiagnostics() {
    return {
      ...this.getMetrics(),
      families: [...this.specs.keys()].map((family) => ({
        family,
        pending: this.pendingFamilies.has(family),
        ...(this.watchers
          .get(family)?.[0]
          ?.watcher.getObservationDiagnostics?.() ?? {
          watching: false,
          baselineState: "idle" as const,
          error: null,
        }),
      })),
    };
  }

  private scheduleNextActivation(delayMs: number): void {
    if (this.activationTimer || this.pendingFamilies.size === 0) return;
    this.activationTimer = setTimeout(() => {
      this.activationTimer = null;
      const nextFamily = this.pendingFamilies.values().next();
      if (nextFamily.done) return;
      const family = nextFamily.value;
      this.pendingFamilies.delete(family);
      this.activateFamily(family);
      this.scheduleNextActivation(this.activationYieldMs);
    }, delayMs);
    this.activationTimer.unref();
  }
}
