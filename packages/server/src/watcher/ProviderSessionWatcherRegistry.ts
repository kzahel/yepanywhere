import { existsSync } from "node:fs";
import { basename, dirname } from "node:path";
import { getCodexSessionRoots } from "../utils/codexRolloutFiles.js";
import type { ProviderCatalogFamily } from "../sessions/provider-catalog-family.js";
import { FileWatcher, type FileWatcherOptions } from "./FileWatcher.js";

type ManagedFileWatcher = Pick<FileWatcher, "start" | "stop"> &
  Partial<Pick<FileWatcher, "getObservationDiagnostics">>;

export interface ProviderSessionWatcherSpec
  extends Omit<FileWatcherOptions, "eventBus"> {
  family: ProviderCatalogFamily;
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
    ManagedFileWatcher
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

  requestActivation(families: Iterable<ProviderCatalogFamily>): void {
    this.activationQueueRequests += 1;
    for (const family of families) {
      if (!this.watchers.has(family) && this.specs.has(family)) {
        this.pendingFamilies.add(family);
      }
    }
    this.scheduleNextActivation(this.activationDelayMs);
  }

  activateFamily(family: ProviderCatalogFamily): void {
    this.activationRequests += 1;
    if (this.watchers.has(family)) return;
    const spec = this.specs.get(family);
    if (!spec) return;

    const roots =
      family === "codex"
        ? getCodexSessionRoots(spec.watchDir)
        : [spec.watchDir];
    const watchDir = roots.length > 1 ? dirname(spec.watchDir) : spec.watchDir;
    this.directoryProbes += 1;
    if (!this.directoryExists(watchDir)) {
      this.missingDirectories += 1;
      return;
    }

    const { family: _family, ...watcherOptions } = spec;
    const watcher = this.createWatcher({
      ...watcherOptions,
      watchDir,
      ...(roots.length > 1
        ? { watchSubdirectories: roots.map((root) => basename(root)) }
        : {}),
      eventBus: this.eventBus,
    });
    watcher.start();
    this.watchers.set(family, watcher);
    this.watchersStarted += 1;
  }

  stop(): void {
    if (this.activationTimer) {
      clearTimeout(this.activationTimer);
      this.activationTimer = null;
    }
    this.pendingFamilies.clear();
    for (const watcher of this.watchers.values()) watcher.stop();
    this.watchers.clear();
  }

  getMetrics(): ProviderSessionWatcherRegistryMetrics {
    return {
      activationQueueRequests: this.activationQueueRequests,
      activationRequests: this.activationRequests,
      directoryProbes: this.directoryProbes,
      watchersStarted: this.watchersStarted,
      missingDirectories: this.missingDirectories,
      activeWatchers: this.watchers.size,
      pendingActivations: this.pendingFamilies.size,
    };
  }

  /** Fixed-cost observation state; reading it never activates or probes stores. */
  getDiagnostics() {
    return {
      ...this.getMetrics(),
      families: [...this.specs.keys()].map((family) => ({
        family,
        pending: this.pendingFamilies.has(family),
        ...(this.watchers.get(family)?.getObservationDiagnostics?.() ?? {
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
