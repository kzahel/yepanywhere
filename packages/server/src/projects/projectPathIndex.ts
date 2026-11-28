import type { Dirent, FSWatcher } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { createLruMap, refreshLruMap } from "../lib/lruCollections.js";
import { getLogger } from "../logging/logger.js";
import { notifyProjectFileChange } from "./projectFileChanges.js";
import {
  type DirectoryListing,
  type MutablePathIndexStats,
  type NodeState,
  type ParsedCandidate,
  type PathIndexIo,
  type PathIndexOptions,
  type PathNode,
  type ProjectPathCacheStats,
  type ProjectPathIndexStats,
  type WatchObservation,
  canClearStaleDirectoryState,
  createNode,
  createPathIndexStats,
  directoryIdentityChanged,
  findContradictedDirectoryChildren,
  forEachConcurrent,
  formatDirectoryIdentity,
  hasRetainedFacts,
  isUnavailablePathError,
  nodeBytes,
  parseRelativeComponents,
  provesAbsence,
  readDirectoryIdentitySync,
  subtreeContains,
} from "./projectPathTrieModel.js";

export type { PathIndexIo, ProjectPathCacheStats, ProjectPathIndexStats };
import {
  getDirectoryWatchIdentity,
  getDirectoryWatchStallGeneration,
  isDirectoryWatchPending,
  isDirectoryWatchStalled,
  waitForDirectoryWatchReady,
  wasDirectoryWatchAttached,
  watchSharedDirectory,
} from "../watcher/SharedDirectoryWatcher.js";

/**
 * Demand-driven project path cache.
 *
 * Consumers ask whether a handful of explicitly displayed paths are files in
 * one project. The cache therefore hydrates only the directory components those
 * candidates use: a project holding 50,000 unrelated run artifacts pays nothing
 * because one displayed turn mentions `src/server.ts`.
 *
 * Cached facts are trusted only while their directory carries a live watcher,
 * so a hit costs no `stat`. Losing or never obtaining that watcher does not
 * make an answer wrong; it only makes it re-probe.
 */

/** One listing is cheaper than this many exact probes in the same directory. */
const DIRECTORY_LISTING_THRESHOLD = 4;
/** A wider listing answers its batch but is never retained whole. */
const MAX_RETAINED_DIRECTORY_ENTRIES = 20_000;
const PROBE_CONCURRENCY = 8;
/** Per-project ceiling before the least recently used subtrees are dropped. */
const MAX_INDEX_BYTES = 4 * 1024 * 1024;
/** Per-project watcher ceiling, including while the project is actively claimed. */
const MAX_INDEX_WATCHERS = 1_024;
/** Process-wide byte ceiling before inactive projects are dropped. */
const MAX_PROCESS_BYTES = 32 * 1024 * 1024;
/** Process-wide project-count ceiling before inactive projects are dropped. */
const MAX_PROCESS_PROJECTS = 128;
/** Process-wide watcher ceiling before inactive projects are dropped. */
const MAX_PROCESS_WATCHERS = 1_024;
/** Fraction of a ceiling that eviction returns below, so it runs in batches. */
const EVICTION_LOW_WATERMARK = 0.75;
const RECONCILE_DELAY_MS = 100;
/** Cap async off-thread watch readiness so blocked closes degrade to direct I/O. */
const WATCH_READY_TIMEOUT_MS = 250;
/** Allow initial worker-thread startup on macOS before degrading to direct I/O. */
const WATCH_BOOT_READY_TIMEOUT_MS = 2_000;

const DEFAULT_IO: PathIndexIo = {
  lstat: (path) => lstat(path),
  readdir: (path) => readdir(path, { withFileTypes: true }),
  watch: (path, listener) =>
    watchSharedDirectory(
      path,
      { asyncReady: true, persistent: false },
      (event, filename) => listener(event, filename),
    ),
};

let membershipRevisionClock = 0;

function nextMembershipRevision(): number {
  membershipRevisionClock += 1;
  return membershipRevisionClock;
}

class SparseProjectPathIndex implements ProjectPathIndex {
  private readonly io: PathIndexIo;
  private readonly maxIndexBytes: number;
  private readonly maxIndexWatchers: number;
  private readonly maxRetainedEntries: number;
  private readonly onRetentionChanged: (() => void) | undefined;
  private readonly root = createNode("", "directory", true);
  /** Watched directory nodes, in least-recently-used order. */
  private readonly hydrated = createLruMap<PathNode, string>();
  private readonly listings = new Map<
    string,
    Promise<DirectoryListing | null>
  >();
  private readonly probes = new Map<string, Promise<NodeState>>();
  private readonly reconciling = new Map<PathNode, NodeJS.Timeout>();
  private readonly stats: MutablePathIndexStats = createPathIndexStats();
  private activeBatches = 0;
  private completeDirectories = 0;
  private disposed = false;
  private lastObservedStallGeneration = 0;
  private membershipRevision = nextMembershipRevision();
  /** Whether the registry currently has at least one owning claim. */
  private registryActive = true;
  /** Fences reconciliation that was already reading when the last claim left. */
  private registryActivityGeneration = 0;
  private retainedBytes = 0;
  private retentionChanged = false;
  private retentionMutationDepth = 0;
  private watchers = 0;

  constructor(
    private readonly projectPath: string,
    options: PathIndexOptions = {},
  ) {
    this.io = options.io ?? DEFAULT_IO;
    this.maxIndexBytes = options.maxIndexBytes ?? MAX_INDEX_BYTES;
    this.maxIndexWatchers = options.maxIndexWatchers ?? MAX_INDEX_WATCHERS;
    this.maxRetainedEntries =
      options.maxRetainedEntries ?? MAX_RETAINED_DIRECTORY_ENTRIES;
    this.onRetentionChanged = options.onRetentionChanged;
  }

  get bytes(): number {
    return this.retainedBytes;
  }

  get watcherCount(): number {
    return this.watchers;
  }

  sourceRevision(): number {
    const stallGeneration = this.currentStallGeneration();
    if (stallGeneration !== this.lastObservedStallGeneration) {
      this.lastObservedStallGeneration = stallGeneration;
      this.membershipRevision = nextMembershipRevision();
    }
    return this.membershipRevision;
  }

  private currentStallGeneration(): number {
    let max = 0;
    for (const node of this.hydrated.keys()) {
      if (!node.watcher) continue;
      const generation = getDirectoryWatchStallGeneration(node.watcher);
      if (generation > max) max = generation;
    }
    return max;
  }

  rootChildCountForTest(): number {
    return this.root.children?.size ?? 0;
  }

  async has(path: string): Promise<boolean> {
    return (await this.findExisting([path])).has(path);
  }

  knownFile(path: string): boolean | undefined {
    const components = parseRelativeComponents(path);
    // A path that is not project-relative at all is proven not to be a file
    // here, so a caller needs no filesystem call to rule it out.
    if (!components) return false;

    let node = this.root;
    for (const component of components.slice(0, -1)) {
      const state = this.cachedChildState(node, component);
      if (state === undefined) return undefined;
      if (state !== "directory") return false;
      const child = node.children?.get(component);
      if (!child) return undefined;
      node = child;
    }
    const name = components.at(-1);
    if (!name) return false;
    const state = this.cachedChildState(node, name);
    return state === undefined ? undefined : state === "file";
  }

  async findExisting(
    paths: readonly string[],
    kind: "file" | "directory" = "file",
  ): Promise<ReadonlySet<string>> {
    const candidates: ParsedCandidate[] = [];
    for (const path of paths) {
      const components = parseRelativeComponents(path);
      if (components) candidates.push({ components, original: path });
    }
    if (candidates.length === 0) return new Set();

    this.stats.lookupBatches += 1;
    this.stats.lookupCandidates += candidates.length;
    const groups = new Map<string, ParsedCandidate[]>();
    for (const candidate of candidates) {
      const parentKey = candidate.components.slice(0, -1).join("\0");
      const group = groups.get(parentKey);
      if (group) group.push(candidate);
      else groups.set(parentKey, [candidate]);
    }

    const found = new Set<string>();
    const registryActivityGeneration = this.registryActivityGeneration;
    this.activeBatches += 1;
    try {
      await forEachConcurrent(
        Array.from(groups.values()),
        PROBE_CONCURRENCY,
        async (group) => {
          const first = group[0];
          if (!first) return;
          const parent = await this.resolveDirectory(
            first.components.slice(0, -1),
            registryActivityGeneration,
          );
          if (!parent) return;
          const names = group.flatMap((candidate) => {
            const name = candidate.components.at(-1);
            return name ? [name] : [];
          });
          const states = await this.resolveChildren(
            parent.node,
            parent.absolutePath,
            names,
            registryActivityGeneration,
          );
          for (const candidate of group) {
            const name = candidate.components.at(-1);
            if (name && states.get(name) === kind)
              found.add(candidate.original);
          }
        },
      );
    } finally {
      this.activeBatches -= 1;
      // Only evict between batches, so a probe in flight keeps its ancestors.
      if (this.activeBatches === 0) this.enforceIndexBudget();
    }
    return found;
  }

  release(): void {
    this.dispose();
  }

  diagnostics(): ProjectPathIndexStats {
    return {
      ...this.stats,
      completeDirectories: this.completeDirectories,
      hydratedDirectories: this.hydrated.size,
      retainedBytes: this.retainedBytes,
      watchers: this.watchers,
    };
  }

  resetDiagnostics(): void {
    for (const key of Object.keys(this.stats) as Array<
      keyof MutablePathIndexStats
    >) {
      this.stats[key] = 0;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.markMembershipChanged();
    this.cancelAllReconciliations();
    for (const node of Array.from(this.hydrated.keys())) {
      if (this.hydrated.has(node)) this.evict(node);
    }
    this.hydrated.clear();
  }

  setRegistryActive(active: boolean): void {
    if (this.registryActive === active) return;
    this.registryActive = active;
    this.registryActivityGeneration += 1;
    if (!active) this.cancelAllReconciliations();
  }

  /** Walk to the directory node named by `components`, hydrating on demand. */
  private async resolveDirectory(
    components: readonly string[],
    registryActivityGeneration: number,
  ): Promise<{ absolutePath: string; node: PathNode } | null> {
    let absolutePath = this.projectPath;
    let node = this.root;
    for (const component of components) {
      const states = await this.resolveChildren(
        node,
        absolutePath,
        [component],
        registryActivityGeneration,
      );
      if (states.get(component) !== "directory") return null;
      absolutePath = join(absolutePath, component);
      node =
        this.reachableDirectoryNode(absolutePath) ??
        createNode(component, "directory");
    }
    return { absolutePath, node };
  }

  /**
   * Resolve several names in one directory. A cached fact costs nothing; a
   * sparse set of unknowns is probed exactly; a wide set is worth one listing,
   * which also answers every later name in that directory.
   */
  private async resolveChildren(
    parent: PathNode,
    parentAbsolutePath: string,
    names: readonly string[],
    registryActivityGeneration: number,
  ): Promise<Map<string, NodeState>> {
    const parentAttachmentGeneration = parent.attachmentGeneration;
    const states = new Map<string, NodeState>();
    const unresolved: string[] = [];
    for (const name of new Set(names)) {
      const cached = this.cachedChildState(parent, name);
      if (cached) {
        this.stats.cachedAnswers += 1;
        states.set(name, cached);
      } else {
        unresolved.push(name);
      }
    }
    if (unresolved.length === 0) return states;

    if (
      unresolved.length + parent.probedNames >= DIRECTORY_LISTING_THRESHOLD &&
      !parent.complete &&
      !parent.wide
    ) {
      const listing = await this.listDirectory(
        parentAbsolutePath,
        unresolved,
        registryActivityGeneration,
      );
      if (
        listing?.observation &&
        (listing.observation.registryActivityGeneration !==
          registryActivityGeneration ||
          !this.observationIsCurrent(parent, listing.observation))
      ) {
        // The directory changed while the listing was pending, or before this
        // waiter consumed a coalesced result. Resolve the requested names under
        // the current generation (including any earlier batch cache hits whose
        // edges were just invalidated) rather than answering from that snapshot.
        const unresolvedSet = new Set(unresolved);
        const toReprobe: string[] = [];
        for (const name of new Set(names)) {
          if (unresolvedSet.has(name)) {
            toReprobe.push(name);
          } else {
            const current = this.cachedChildState(parent, name);
            if (current === undefined) toReprobe.push(name);
            else states.set(name, current);
          }
        }
        await forEachConcurrent(toReprobe, PROBE_CONCURRENCY, async (name) => {
          states.set(
            name,
            await this.probeChild(
              parentAbsolutePath,
              name,
              registryActivityGeneration,
            ),
          );
        });
        this.recordProbes(
          parent,
          parentAbsolutePath,
          parentAttachmentGeneration,
          registryActivityGeneration,
          toReprobe.length,
        );
        return states;
      }

      // A listing too wide to retain whole still proved these exact names. The
      // operation publishes its own requested names before releasing its claim;
      // a coalesced waiter publishes any additional names only while that same
      // watcher generation remains current.
      const keepQueried = listing?.observation != null && parent.wide;
      for (const name of unresolved) {
        const state = listing?.kinds.get(name) ?? "absent";
        states.set(name, state);
        if (keepQueried) this.setChildState(parent, name, state);
      }
      return states;
    }

    await forEachConcurrent(unresolved, PROBE_CONCURRENCY, async (name) => {
      states.set(
        name,
        await this.probeChild(
          parentAbsolutePath,
          name,
          registryActivityGeneration,
        ),
      );
    });
    this.recordProbes(
      parent,
      parentAbsolutePath,
      parentAttachmentGeneration,
      registryActivityGeneration,
      unresolved.length,
    );
    return states;
  }

  private recordProbes(
    node: PathNode,
    absolutePath: string,
    attachmentGeneration: number,
    registryActivityGeneration: number,
    count: number,
  ): void {
    if (
      this.registryActivityIsCurrent(registryActivityGeneration) &&
      this.nodeAttachmentIsCurrent(node, absolutePath, attachmentGeneration)
    ) {
      node.probedNames += count;
    }
  }

  private cachedChildState(
    parent: PathNode,
    name: string,
  ): NodeState | undefined {
    // Without a live, unstalled watcher nothing keeps these facts true.
    if (
      !parent.watcher ||
      isDirectoryWatchPending(parent.watcher) ||
      isDirectoryWatchStalled(parent.watcher)
    )
      return undefined;
    const child = parent.children?.get(name);
    if (child) {
      if (child.stateStale) return undefined;
      this.touch(parent);
      return child.state;
    }
    if (!child && parent.complete) {
      this.touch(parent);
      return "absent";
    }
    return undefined;
  }

  private probeChild(
    parentAbsolutePath: string,
    name: string,
    registryActivityGeneration: number,
  ): Promise<NodeState> {
    const absolutePath = join(parentAbsolutePath, name);
    const probeKey = `${registryActivityGeneration}\0${absolutePath}`;
    const inFlight = this.probes.get(probeKey);
    if (inFlight) return inFlight;
    const pending = this.runProbe(
      parentAbsolutePath,
      absolutePath,
      name,
      registryActivityGeneration,
    ).finally(() => {
      if (this.probes.get(probeKey) === pending) {
        this.probes.delete(probeKey);
      }
    });
    this.probes.set(probeKey, pending);
    return pending;
  }

  private async runProbe(
    parentAbsolutePath: string,
    absolutePath: string,
    name: string,
    registryActivityGeneration: number,
  ): Promise<NodeState> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (!this.registryActivityIsCurrent(registryActivityGeneration)) {
        return (await this.readChildState(absolutePath)).state;
      }
      // The caller's node may have been detached while an earlier read yielded.
      // Reacquire the canonical parent from the root before every observation or
      // retry; a missing current node degrades this attempt to an uncached read.
      const currentParent = this.reachableDirectoryNode(parentAbsolutePath);
      const observation = currentParent
        ? this.observe(
            currentParent,
            parentAbsolutePath,
            registryActivityGeneration,
          )
        : null;
      try {
        const ready =
          observation &&
          currentParent &&
          isDirectoryWatchPending(observation.watcher)
            ? await this.awaitObservationReady(currentParent, observation)
            : observation;
        const result = await this.readChildState(absolutePath);
        if (!result.proven || !ready || !currentParent) return result.state;
        if (this.observationIsCurrent(currentParent, ready)) {
          this.setChildState(
            currentParent,
            name,
            result.state,
            result.inodeIdentity,
          );
          return result.state;
        }
        // A watcher or attachment change may be worth one retry. A claim release
        // or later reclaim invalidates the operation itself, so its completion is
        // an uncached answer and must not attach another watcher generation.
        if (!this.registryActivityIsCurrent(ready.registryActivityGeneration)) {
          return result.state;
        }
      } finally {
        if (observation && currentParent) {
          this.releaseObservation(currentParent, observation);
        }
      }
    }

    // Two consecutive watcher generations changed around their reads. One final
    // direct probe returns filesystem truth without publishing another fact that
    // could immediately outlive its observation.
    return (await this.readChildState(absolutePath)).state;
  }

  private async readChildState(absolutePath: string): Promise<{
    proven: boolean;
    state: NodeState;
    inodeIdentity?: string;
  }> {
    this.stats.exactProbes += 1;
    try {
      // `lstat`, not `stat`: a symlink is a leaf here, so a link cannot make
      // the walk leave the project.
      const entry = await this.io.lstat(absolutePath);
      const inodeIdentity = formatDirectoryIdentity(entry);
      return {
        proven: true,
        state: entry.isDirectory() ? "directory" : "file",
        ...(inodeIdentity ? { inodeIdentity } : {}),
      };
    } catch (error) {
      if (!isUnavailablePathError(error)) throw error;
      // A permission error answers this lookup but proves nothing to cache.
      return { proven: provesAbsence(error), state: "absent" };
    }
  }

  private reachableDirectoryNode(absolutePath: string): PathNode | null {
    const projectRelativePath = relative(this.projectPath, absolutePath);
    if (
      isAbsolute(projectRelativePath) ||
      projectRelativePath === ".." ||
      projectRelativePath.startsWith(`..${sep}`)
    ) {
      return null;
    }

    let node = this.root;
    if (!node.attached) return null;
    if (projectRelativePath === "") return node;
    for (const component of projectRelativePath.split(sep).filter(Boolean)) {
      const child = node.children?.get(component);
      if (!child?.attached || child.state !== "directory" || child.stateStale)
        return null;
      node = child;
    }
    return node;
  }

  private nodeAttachmentIsCurrent(
    node: PathNode,
    absolutePath: string,
    attachmentGeneration: number,
  ): boolean {
    return (
      node.attached &&
      node.attachmentGeneration === attachmentGeneration &&
      this.reachableDirectoryNode(absolutePath) === node
    );
  }

  private observe(
    node: PathNode,
    absolutePath: string,
    registryActivityGeneration: number,
  ): WatchObservation | null {
    if (
      !this.registryActivityIsCurrent(registryActivityGeneration) ||
      !this.nodeAttachmentIsCurrent(
        node,
        absolutePath,
        node.attachmentGeneration,
      ) ||
      !this.hydrate(node, absolutePath) ||
      !node.watcher
    ) {
      return null;
    }
    if (isDirectoryWatchStalled(node.watcher)) {
      this.withRetentionMutation(() => {
        this.releaseFactlessWatcher(node);
      });
      return null;
    }
    const observation: WatchObservation = {
      absolutePath,
      attachmentGeneration: node.attachmentGeneration,
      generation: node.watcherGeneration,
      registryActivityGeneration,
      released: false,
      stallGeneration: getDirectoryWatchStallGeneration(node.watcher),
      watcher: node.watcher,
    };
    node.watcherClaims.add(observation);
    return observation;
  }

  private async awaitObservationReady(
    node: PathNode,
    observation: WatchObservation,
  ): Promise<WatchObservation | null> {
    const attached = await waitForDirectoryWatchReady(
      observation.watcher,
      WATCH_READY_TIMEOUT_MS,
      WATCH_BOOT_READY_TIMEOUT_MS,
    );
    if (!attached || !this.observationIsCurrent(node, observation)) {
      this.releaseObservation(node, observation);
      return null;
    }
    return observation;
  }

  private releaseObservation(
    node: PathNode,
    observation: WatchObservation,
  ): void {
    this.withRetentionMutation(() => {
      if (observation.released) return;
      observation.released = true;
      node.watcherClaims.delete(observation);
      if (node.watcher === observation.watcher) {
        this.releaseFactlessWatcher(node);
      }
    });
  }

  private releaseFactlessWatcher(node: PathNode): void {
    if (!this.currentWatcherIsClaimed(node) && !hasRetainedFacts(node)) {
      this.evict(node);
    }
  }

  private currentWatcherIsClaimed(node: PathNode): boolean {
    for (const claim of node.watcherClaims) {
      if (this.observationIsCurrent(node, claim)) return true;
    }
    return false;
  }

  private observationIsCurrent(
    node: PathNode,
    observation: WatchObservation,
  ): boolean {
    return (
      this.registryActivityIsCurrent(observation.registryActivityGeneration) &&
      this.nodeAttachmentIsCurrent(
        node,
        observation.absolutePath,
        observation.attachmentGeneration,
      ) &&
      node.watcher === observation.watcher &&
      node.watcherGeneration === observation.generation &&
      !isDirectoryWatchStalled(observation.watcher) &&
      getDirectoryWatchStallGeneration(observation.watcher) ===
        observation.stallGeneration
    );
  }

  private setChildState(
    parent: PathNode,
    name: string,
    state: NodeState,
    inodeIdentity?: string,
  ): void {
    this.withRetentionMutation(() => {
      const existing = parent.children?.get(name);
      if (existing) {
        if (
          existing.state !== state ||
          directoryIdentityChanged(existing, state, inodeIdentity)
        ) {
          this.markMembershipChanged();
          this.invalidateSubtree(existing, false);
          existing.state = state;
          existing.stateStale = false;
        } else if (canClearStaleDirectoryState(existing, inodeIdentity)) {
          existing.stateStale = false;
        }
        return;
      }
      this.addChild(parent, name, state);
    });
  }

  /** Insert one new child edge, allocating the child map on first use. */
  private addChild(parent: PathNode, name: string, state: NodeState): void {
    if (!parent.children) parent.children = new Map();
    parent.children.set(name, createNode(name, state, true));
    this.addBytes(nodeBytes(name));
  }

  /** Read one directory completely, coalescing concurrent requests. */
  private listDirectory(
    absolutePath: string,
    queriedNames: readonly string[],
    registryActivityGeneration: number,
  ): Promise<DirectoryListing | null> {
    const listingKey = `${registryActivityGeneration}\0${absolutePath}`;
    const inFlight = this.listings.get(listingKey);
    if (inFlight) return inFlight;
    const pending = this.runListing(
      absolutePath,
      queriedNames,
      registryActivityGeneration,
    ).finally(() => {
      if (this.listings.get(listingKey) === pending) {
        this.listings.delete(listingKey);
      }
    });
    this.listings.set(listingKey, pending);
    return pending;
  }

  private async runListing(
    absolutePath: string,
    queriedNames: readonly string[],
    registryActivityGeneration: number,
  ): Promise<DirectoryListing | null> {
    this.stats.directoryListings += 1;
    // Reacquire the canonical node instead of trusting the caller's object: an
    // ancestor invalidation may have detached it while earlier traversal yielded.
    const node = this.reachableDirectoryNode(absolutePath);
    // Claim the watcher before reading. The claim prevents an unrelated exact
    // probe from closing this otherwise-factless generation while `readdir` is
    // pending, and the captured generation fences all publication below.
    const observation = node
      ? this.observe(node, absolutePath, registryActivityGeneration)
      : null;
    try {
      const ready =
        node && observation && isDirectoryWatchPending(observation.watcher)
          ? await this.awaitObservationReady(node, observation)
          : observation;
      let entries: Dirent[];
      try {
        entries = await this.io.readdir(absolutePath);
      } catch (error) {
        if (!isUnavailablePathError(error)) throw error;
        if (
          node &&
          ready &&
          this.registryActivityIsCurrent(registryActivityGeneration) &&
          this.observationIsCurrent(node, ready)
        ) {
          this.evict(node);
        }
        return null;
      }

      const kinds = new Map<string, NodeState>();
      for (const entry of entries) {
        kinds.set(entry.name, entry.isDirectory() ? "directory" : "file");
      }
      if (entries.length > this.maxRetainedEntries) {
        this.stats.oversizedListings += 1;
        if (
          node &&
          ready &&
          this.registryActivityIsCurrent(registryActivityGeneration) &&
          this.observationIsCurrent(node, ready)
        ) {
          // Retaining every name here would spend a large share of the project's
          // whole budget on one directory. Recording the width instead keeps later
          // batches on exact probes rather than re-reading it every time.
          node.wide = true;
          for (const name of queriedNames) {
            this.setChildState(node, name, kinds.get(name) ?? "absent");
          }
        }
      } else if (
        node &&
        ready &&
        this.registryActivityIsCurrent(registryActivityGeneration) &&
        this.observationIsCurrent(node, ready)
      ) {
        const contradicted = await findContradictedDirectoryChildren(
          node,
          absolutePath,
          kinds,
          PROBE_CONCURRENCY,
          join,
        );
        if (
          this.registryActivityIsCurrent(registryActivityGeneration) &&
          this.observationIsCurrent(node, ready)
        ) {
          if (contradicted.length > 0) {
            this.withRetentionMutation(() => {
              this.markMembershipChanged();
              node.watcherGeneration += 1;
              for (const [name, child] of contradicted) {
                if (node.children?.get(name) === child) {
                  this.removeChild(node, name, child);
                }
              }
            });
            // Advancing watcherGeneration marks `ready` stale so callers and
            // coalesced waiters fall back to exact probes instead of this listing.
            return { kinds, observation: ready };
          }
          this.replaceChildren(node, kinds);
        }
      }
      return { kinds, observation: ready };
    } finally {
      if (node && observation) this.releaseObservation(node, observation);
    }
  }

  private registryActivityIsCurrent(
    registryActivityGeneration: number,
  ): boolean {
    return (
      this.registryActive &&
      this.registryActivityGeneration === registryActivityGeneration
    );
  }

  private replaceChildren(node: PathNode, kinds: Map<string, NodeState>): void {
    this.withRetentionMutation(() => {
      // Preserve unchanged child directories and their hydrated subtrees so
      // re-listing a parent after an unrelated sibling edit does not tear down
      // and rebuild descendant directory watchers.
      this.cancelReconcile(node);
      const children = new Map<string, PathNode>();
      let bytesDelta = 0;
      let membershipChanged = false;
      for (const [name, child] of node.children ?? []) {
        const nextState = kinds.get(name);
        if (nextState !== undefined && child.state === nextState) {
          child.stateStale = false;
          children.set(name, child);
          continue;
        }
        if (nextState !== undefined || child.state !== "absent") {
          membershipChanged = true;
        }
        this.invalidateSubtree(child, true);
        bytesDelta -= nodeBytes(name);
      }
      for (const [name, state] of kinds) {
        if (children.has(name)) continue;
        children.set(name, createNode(name, state, true));
        bytesDelta += nodeBytes(name);
      }
      this.resetNodeFacts(node);
      node.children = children;
      node.complete = true;
      this.completeDirectories += 1;
      if (membershipChanged) this.markMembershipChanged();
      this.addBytes(bytesDelta);
    });
  }

  /**
   * Attach this directory's watcher, which is what makes its cached facts
   * trustworthy. Facts gathered before the watch existed are not covered by it,
   * so a first attachment starts a clean generation.
   */
  private hydrate(node: PathNode, absolutePath: string): boolean {
    return this.withRetentionMutation(() => {
      if (node.watcher) {
        this.touch(node);
        return true;
      }
      if (
        this.disposed ||
        !this.registryActive ||
        !this.reserveWatcherSlot(node) ||
        !this.nodeAttachmentIsCurrent(
          node,
          absolutePath,
          node.attachmentGeneration,
        )
      ) {
        return false;
      }
      let watcher: FSWatcher;
      try {
        watcher = this.io.watch(absolutePath, (_event, filename) => {
          this.onWatchEvent(node, absolutePath, watcher, filename);
        });
      } catch (error) {
        getLogger().debug(
          { err: error, path: absolutePath },
          "PROJECT_PATH_INDEX: directory watch unavailable; answers stay uncached",
        );
        return false;
      }
      watcher.on("error", (error) => {
        this.onWatchFailure(node, absolutePath, watcher, error);
      });
      watcher.on("stall-recovered", () => {
        this.onWatchStallRecovered(node, watcher);
      });
      this.detachChildren(node);
      this.resetNodeFacts(node);
      node.watcher = watcher;
      node.inodeIdentity =
        getDirectoryWatchIdentity(watcher) ??
        readDirectoryIdentitySync(absolutePath);
      node.watcherGeneration += 1;
      this.changeWatcherCount(1);
      this.hydrated.set(node, absolutePath);
      return true;
    });
  }

  /** Make room for one watcher without evicting the active traversal or claims. */
  private reserveWatcherSlot(protectedNode: PathNode): boolean {
    if (this.watchers < this.maxIndexWatchers) return true;
    for (const node of Array.from(this.hydrated.keys())) {
      if (this.watchers < this.maxIndexWatchers) return true;
      if (
        !this.hydrated.has(node) ||
        subtreeContains(node, protectedNode) ||
        this.subtreeHasClaimedWatcher(node)
      ) {
        continue;
      }
      this.evict(node);
      this.stats.evictedDirectories += 1;
    }
    return this.watchers < this.maxIndexWatchers;
  }

  private subtreeHasClaimedWatcher(node: PathNode): boolean {
    if (this.currentWatcherIsClaimed(node)) return true;
    for (const child of node.children?.values() ?? []) {
      if (this.subtreeHasClaimedWatcher(child)) return true;
    }
    return false;
  }

  private onWatchEvent(
    node: PathNode,
    absolutePath: string,
    watcher: FSWatcher,
    filename: string | Buffer | null,
  ): void {
    this.withRetentionMutation(() => {
      if (node.watcher !== watcher) return;
      if (!filename) {
        // An event that does not name its entry cannot invalidate one edge.
        this.onWatchFailure(node, absolutePath, watcher, undefined);
        return;
      }
      const name =
        typeof filename === "string" ? filename : filename.toString("utf8");
      this.markMembershipChanged();
      node.watcherGeneration += 1;
      this.stats.watcherInvalidations += 1;
      const child = node.children?.get(name);
      if (child) this.removeChild(node, name, child);
      if (node.complete) {
        // Without an unknown edge, this generation can no longer infer that any
        // unlisted name is absent.
        node.complete = false;
        this.completeDirectories -= 1;
      }
      this.releaseFactlessWatcher(node);
    });
  }

  /**
   * A watch error or overflow leaves this directory's generation uncertain.
   * Every cached fact under it is discarded rather than trusted, and one
   * bounded listing re-establishes the truth.
   */
  private onWatchFailure(
    node: PathNode,
    absolutePath: string,
    watcher: FSWatcher,
    error: unknown,
  ): void {
    this.withRetentionMutation(() => {
      if (node.watcher !== watcher) return;
      node.watcherGeneration += 1;
      if (!wasDirectoryWatchAttached(watcher)) {
        // Off-thread open failure matches a synchronous watch() throw: drop the
        // unattached watch without advancing sourceRevision or looping.
        getLogger().debug(
          { err: error, path: absolutePath },
          "PROJECT_PATH_INDEX: directory watch unavailable; answers stay uncached",
        );
        this.evict(node);
        return;
      }
      this.markMembershipChanged();
      this.stats.uncertainGenerations += 1;
      getLogger().debug(
        { err: error, path: absolutePath },
        "PROJECT_PATH_INDEX: watch generation uncertain; reconciling",
      );
      this.evict(node);
      this.scheduleReconcile(node, absolutePath);
    });
  }

  /**
   * Discard cached facts after a worker close stall without closing healthy
   * watchers, so delayed or missed invalidations cannot leak back into cache.
   */
  private onWatchStallRecovered(node: PathNode, watcher: FSWatcher): void {
    this.withRetentionMutation(() => {
      if (node.watcher !== watcher) return;
      this.markMembershipChanged();
      node.watcherGeneration += 1;
      this.resetNodeFacts(node);
      if (node.children) {
        for (const [name, child] of Array.from(node.children.entries())) {
          if (
            child.state === "directory" &&
            (child.watcher || child.children)
          ) {
            child.stateStale = true;
          } else {
            this.removeChild(node, name, child);
          }
        }
      }
    });
  }

  private scheduleReconcile(node: PathNode, absolutePath: string): void {
    if (this.disposed || !this.registryActive || this.reconciling.has(node)) {
      return;
    }
    const attachmentGeneration = node.attachmentGeneration;
    const registryActivityGeneration = this.registryActivityGeneration;
    if (
      !this.nodeAttachmentIsCurrent(node, absolutePath, attachmentGeneration)
    ) {
      return;
    }
    const timer = setTimeout(() => {
      this.reconciling.delete(node);
      if (
        this.disposed ||
        !this.registryActivityIsCurrent(registryActivityGeneration) ||
        !this.nodeAttachmentIsCurrent(node, absolutePath, attachmentGeneration)
      ) {
        return;
      }
      void this.listDirectory(absolutePath, [], registryActivityGeneration)
        .then(() => {
          // Reconciliation runs outside a lookup batch, so it owns the same
          // budget check that batch-finally normally supplies.
          if (this.activeBatches === 0) this.enforceIndexBudget();
        })
        .catch(() => undefined);
    }, RECONCILE_DELAY_MS);
    timer.unref?.();
    this.reconciling.set(node, timer);
  }

  private touch(node: PathNode): void {
    const absolutePath = this.hydrated.get(node);
    if (absolutePath === undefined) return;
    refreshLruMap(this.hydrated, node, absolutePath);
  }

  private withRetentionMutation<T>(mutate: () => T): T {
    this.retentionMutationDepth += 1;
    try {
      return mutate();
    } finally {
      this.retentionMutationDepth -= 1;
      this.publishRetentionChangeIfSettled();
    }
  }

  private addBytes(bytes: number): void {
    if (bytes === 0) return;
    this.retainedBytes += bytes;
    this.retentionChanged = true;
    this.publishRetentionChangeIfSettled();
  }

  private changeWatcherCount(delta: number): void {
    if (delta === 0) return;
    this.watchers += delta;
    this.retentionChanged = true;
    this.publishRetentionChangeIfSettled();
  }

  private publishRetentionChangeIfSettled(): void {
    if (this.retentionMutationDepth !== 0 || !this.retentionChanged) return;
    this.retentionChanged = false;
    this.onRetentionChanged?.();
  }

  private cancelReconcile(node: PathNode): void {
    const timer = this.reconciling.get(node);
    if (!timer) return;
    clearTimeout(timer);
    this.reconciling.delete(node);
  }

  private cancelAllReconciliations(): void {
    for (const timer of this.reconciling.values()) clearTimeout(timer);
    this.reconciling.clear();
  }

  private removeChild(parent: PathNode, name: string, child: PathNode): void {
    this.invalidateSubtree(child, true);
    parent.children?.delete(name);
    this.addBytes(-nodeBytes(name));
    if (parent.children?.size === 0) parent.children = undefined;
  }

  private detachChildren(node: PathNode): void {
    const children = node.children;
    if (!children) return;
    for (const child of children.values()) {
      this.invalidateSubtree(child, true);
      this.addBytes(-nodeBytes(child.name));
    }
    node.children = undefined;
  }

  private resetNodeFacts(node: PathNode): void {
    if (node.complete) {
      node.complete = false;
      this.completeDirectories -= 1;
    }
    // A new generation re-learns the width along with everything else, so a
    // directory that has since shrunk is listed again rather than probed
    // forever.
    node.wide = false;
    // The probes that earned a listing proved facts this generation no longer
    // holds, so the count starts over with them.
    node.probedNames = 0;
  }

  /**
   * Invalidate one node identity and everything it owns.
   *
   * `detached` means its parent edge is being removed; otherwise the edge stays
   * reachable but names a new filesystem identity. Either form fences async work
   * and releases this node's own timer/watcher as well as every descendant.
   */
  private invalidateSubtree(node: PathNode, detached: boolean): void {
    this.withRetentionMutation(() => {
      const hadRetainedFacts = hasRetainedFacts(node);
      node.attachmentGeneration += 1;
      if (detached) node.attached = false;
      this.cancelReconcile(node);
      this.detachChildren(node);
      this.resetNodeFacts(node);
      this.closeWatcher(node, hadRetainedFacts);
      node.inodeIdentity = undefined;
      this.hydrated.delete(node);
    });
  }

  private closeWatcher(node: PathNode, invalidatesMembership: boolean): void {
    if (!node.watcher) return;
    // Retained rendered output may depend on facts this watcher made current.
    // Losing the observer fences that output even when no named event preceded
    // the eviction.
    if (invalidatesMembership) this.markMembershipChanged();
    const watcher = node.watcher;
    node.watcher = undefined;
    this.changeWatcherCount(-1);
    try {
      watcher.close();
    } catch {
      // A watcher already closed by the platform needs nothing here.
    }
  }

  private evict(node: PathNode): void {
    this.invalidateSubtree(node, false);
  }

  private markMembershipChanged(): void {
    this.membershipRevision = nextMembershipRevision();
    notifyProjectFileChange(this.projectPath);
  }

  /** Drop least-recently-used subtrees until this project fits its ceiling. */
  private enforceIndexBudget(): void {
    if (this.retainedBytes <= this.maxIndexBytes) return;
    const target = this.maxIndexBytes * EVICTION_LOW_WATERMARK;
    for (const node of Array.from(this.hydrated.keys())) {
      if (this.retainedBytes <= target) break;
      if (!this.hydrated.has(node)) continue;
      this.evict(node);
      this.stats.evictedDirectories += 1;
    }
  }
}

export interface ProjectPathIndex {
  /** Existing files (or directories) from one content-resolution batch. */
  findExisting(
    paths: readonly string[],
    kind?: "file" | "directory",
  ): Promise<ReadonlySet<string>>;
  /** Whether this exact project-relative path is a file in the project. */
  has(path: string): Promise<boolean>;
  /**
   * Whether this path is a file, answered from already-cached facts alone.
   *
   * Performs no filesystem call and starts no probe, so a caller may ask about
   * a token it would never spend I/O on. `undefined` means nothing cached
   * proves it either way — which includes every directory on the way that
   * carries no live watcher, so an unproven answer degrades to "ask properly"
   * rather than to a wrong one.
   */
  knownFile(path: string): boolean | undefined;
  /** Monotonic source identity fencing retained render output. */
  sourceRevision(): number;
  /** Give up this caller's claim on the project's cache. */
  release(): void;
}

interface RegistryEntry {
  index: SparseProjectPathIndex;
  lastAccess: number;
  refs: number;
}

interface ProcessRetentionLimits {
  maxBytes: number;
  maxProjects: number;
  maxWatchers: number;
}

const registry = new Map<string, RegistryEntry>();
let accessClock = 0;
let evictedProjects = 0;

function touchRegistryEntry(entry: RegistryEntry): void {
  accessClock += 1;
  entry.lastAccess = accessClock;
}

/** One caller's claim on a shared project cache. */
class ProjectPathIndexHandle implements ProjectPathIndex {
  private released = false;

  constructor(private readonly entry: RegistryEntry) {}

  findExisting(
    paths: readonly string[],
    kind: "file" | "directory" = "file",
  ): Promise<ReadonlySet<string>> {
    touchRegistryEntry(this.entry);
    return this.entry.index.findExisting(paths, kind);
  }

  has(path: string): Promise<boolean> {
    touchRegistryEntry(this.entry);
    return this.entry.index.has(path);
  }

  knownFile(path: string): boolean | undefined {
    touchRegistryEntry(this.entry);
    return this.entry.index.knownFile(path);
  }

  sourceRevision(): number {
    return this.entry.index.sourceRevision();
  }

  release(): void {
    if (this.released) return;
    this.released = true;
    this.entry.refs -= 1;
    touchRegistryEntry(this.entry);
    if (this.entry.refs === 0) this.entry.index.setRegistryActive(false);
    enforceProcessLimits();
  }
}

/**
 * Claim the project's path cache. Creating one reads nothing: the first lookup
 * hydrates only the components it needs. Release the claim when the caller is
 * done, so a cold project becomes evictable.
 */
export async function getProjectPathIndex(
  projectPath: string,
): Promise<ProjectPathIndex> {
  return claimProjectPathIndex(projectPath);
}

function claimProjectPathIndex(
  projectPath: string,
  options: PathIndexOptions = {},
): ProjectPathIndex {
  const resolvedPath = resolve(projectPath);
  let entry = registry.get(resolvedPath);
  if (!entry) {
    let index!: SparseProjectPathIndex;
    index = new SparseProjectPathIndex(resolvedPath, {
      ...options,
      onRetentionChanged: () => {
        if (registry.get(resolvedPath)?.index === index) {
          enforceProcessLimits();
        }
      },
    });
    entry = {
      index,
      lastAccess: 0,
      refs: 0,
    };
    registry.set(resolvedPath, entry);
  }
  entry.refs += 1;
  if (entry.refs === 1) entry.index.setRegistryActive(true);
  touchRegistryEntry(entry);
  enforceProcessLimits();
  return new ProjectPathIndexHandle(entry);
}

/**
 * Claim the path cache for a surface where links are a nicety, not the answer.
 *
 * Returns `null` rather than throwing, so a render that merely wanted to link
 * paths still produces its body when the cache is unavailable.
 */
export async function tryClaimProjectPathIndex(
  projectPath: string,
): Promise<ProjectPathIndex | null> {
  try {
    return await getProjectPathIndex(projectPath);
  } catch {
    return null;
  }
}

/** Drop a project's cached paths and watchers; a later lookup rebuilds them. */
export function invalidateProjectPathIndex(projectPath: string): void {
  const resolvedPath = resolve(projectPath);
  const entry = registry.get(resolvedPath);
  if (!entry) return;
  registry.delete(resolvedPath);
  entry.index.dispose();
}

/** Cache effectiveness and pressure, without walking any cached tree. */
export function projectPathCacheDiagnostics(): ProjectPathCacheStats {
  let retainedBytes = 0;
  let watchers = 0;
  for (const entry of registry.values()) {
    retainedBytes += entry.index.bytes;
    watchers += entry.index.watcherCount;
  }
  return { evictedProjects, projects: registry.size, retainedBytes, watchers };
}

/** Discard least-recently-used unclaimed projects until every process bound fits. */
function enforceProcessLimits(
  limits: Partial<ProcessRetentionLimits> = {},
): void {
  const maxBytes = limits.maxBytes ?? MAX_PROCESS_BYTES;
  const maxProjects = limits.maxProjects ?? MAX_PROCESS_PROJECTS;
  const maxWatchers = limits.maxWatchers ?? MAX_PROCESS_WATCHERS;
  let retainedBytes = 0;
  let watchers = 0;
  for (const entry of registry.values()) {
    retainedBytes += entry.index.bytes;
    watchers += entry.index.watcherCount;
  }

  const overBytes = retainedBytes > maxBytes;
  const overProjects = registry.size > maxProjects;
  const overWatchers = watchers > maxWatchers;
  if (!overBytes && !overProjects && !overWatchers) return;

  const byteTarget = overBytes ? maxBytes * EVICTION_LOW_WATERMARK : maxBytes;
  const projectTarget = overProjects
    ? Math.floor(maxProjects * EVICTION_LOW_WATERMARK)
    : maxProjects;
  const watcherTarget = overWatchers
    ? Math.floor(maxWatchers * EVICTION_LOW_WATERMARK)
    : maxWatchers;
  const byAge = Array.from(registry.entries()).sort(
    ([, left], [, right]) => left.lastAccess - right.lastAccess,
  );
  for (const [path, entry] of byAge) {
    if (
      retainedBytes <= byteTarget &&
      registry.size <= projectTarget &&
      watchers <= watcherTarget
    ) {
      break;
    }
    if (entry.refs > 0) continue;
    retainedBytes -= entry.index.bytes;
    watchers -= entry.index.watcherCount;
    registry.delete(path);
    entry.index.dispose();
    evictedProjects += 1;
  }
}

export const __test__ = {
  DIRECTORY_LISTING_THRESHOLD,
  MAX_INDEX_WATCHERS,
  MAX_PROCESS_BYTES,
  MAX_PROCESS_PROJECTS,
  MAX_PROCESS_WATCHERS,
  MAX_RETAINED_DIRECTORY_ENTRIES,
  RECONCILE_DELAY_MS,
  claimIndex: (projectPath: string, options?: PathIndexOptions) =>
    claimProjectPathIndex(projectPath, options),
  createIndex: (projectPath: string, options?: PathIndexOptions) =>
    new SparseProjectPathIndex(resolve(projectPath), options),
  diagnostics: (index: SparseProjectPathIndex) => index.diagnostics(),
  enforceProcessLimits,
  registryEntry: (projectPath: string) => registry.get(resolve(projectPath)),
  rootChildCount: (index: SparseProjectPathIndex) =>
    index.rootChildCountForTest(),
  reset: () => {
    for (const entry of registry.values()) entry.index.dispose();
    registry.clear();
    accessClock = 0;
    evictedProjects = 0;
    membershipRevisionClock = 0;
  },
  resetDiagnostics: (index: SparseProjectPathIndex) => index.resetDiagnostics(),
};
